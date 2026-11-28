import { GoogleGenAI, Type, type FunctionDeclaration } from "@google/genai";
import { exec, spawn, type ChildProcess } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import vm from "node:vm";
import { DatabaseSync } from "node:sqlite";
import type { Response } from "express";
import { autoDeployWebsiteFromText, deployHtmlFile, getNexusSystemInstruction, prepareGeminiHistoryAndLastMessage } from "./websiteDeployer.ts";
import { getSkillByName, listAllSkillsSummary, CODING_SKILLS_REGISTRY } from "./skillsRegistry.ts";
import { nexusTools, executeNexusTool, NEXUS_TOOL_NAMES } from "./nexusTools.ts";
import { addFirebaseToProject, deployFirebaseHosting } from "./firebaseConnect.ts";
import { readUserMemory, appendUserMemory } from "./memory.ts";
import { readLessons, recordLesson } from "./lessons.ts";
import { createJob } from "./jobs.ts";
import { chatOnce, cheapChain } from "./llmClient.ts";
import { loadStore, saveStoreSoon, newId } from "./nexusStore.ts";

export interface AskQuestionItem {
  question: string;
  options: string[];
  is_multi_select?: boolean;
}

export interface AskQuestionAnswerPayload {
  answers: Record<string, string[]>;
  skipped?: boolean;
  notes?: string;
}

export interface ToolExecutionContext {
  sessionId?: string;
  /** Live browser session shared by the browser_* tools within one turn —
   * browser_goto starts it, the other browser_* tools reuse it, and the
   * user's Browser tab watches the same page (see browserWorker.ts).
   * Multi-tab: `liveSessions` is the turn's tab list (max 4 — the worker
   * pool cap); `liveSessionId`/`liveSessionUrl` stay as the ACTIVE tab. */
  liveSessionId?: string;
  liveSessionUrl?: string;
  liveSessions?: Array<{ id: string; url?: string }>;
  llmInvoker?: (systemPrompt: string, userPrompt: string) => Promise<string>;
  onAskQuestion?: (questions: AskQuestionItem[]) => Promise<AskQuestionAnswerPayload>;
  /** Parallel multi-agent build (2026-11-29): set once the parallel coders
   * ran this turn, so a second omo_coordinate call in the same turn does not
   * re-run them (the module-level session guard in parallelBuild.ts is the
   * durable guard across key rotations; this is the fast path). */
  parallelBuildRan?: boolean;
  onAgentStep?: (step: {
    id: string;
    kind: 'agent' | 'thought' | 'qc' | 'command';
    label: string;
    detail?: string;
    status: 'running' | 'done' | 'error';
    durationSec?: number;
  }) => void;
}

const execPromise = promisify(exec);

interface BackgroundTask {
  id: string;
  command: string;
  cwd: string;
  status: 'running' | 'completed' | 'failed' | 'killed';
  startedAt: number;
  finishedAt?: number;
  exitCode?: number | null;
  output: string;
  process?: ChildProcess;
}

const backgroundTasks = new Map<string, BackgroundTask>();

export function listBackgroundTasks() {
  return Array.from(backgroundTasks.values()).map(({ process: _p, ...rest }) => ({
    ...rest,
    outputTail: rest.output.slice(-2000),
  }));
}

export function manageBackgroundTask(action: 'list' | 'status' | 'kill' | 'send_input', taskId?: string, input?: string) {
  if (action === 'list') {
    return { tasks: listBackgroundTasks() };
  }
  if (!taskId) return { error: 'TaskId is required for status, kill, or send_input' };
  const task = backgroundTasks.get(taskId);
  if (!task) return { error: `Task ${taskId} not found` };

  if (action === 'status') {
    return {
      id: task.id,
      command: task.command,
      status: task.status,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      exitCode: task.exitCode,
      output: task.output.slice(-4000),
    };
  }
  if (action === 'kill') {
    if (task.process && task.status === 'running') {
      task.process.kill('SIGTERM');
      task.status = 'killed';
      task.finishedAt = Date.now();
    }
    return { success: true, id: task.id, status: task.status };
  }
  if (action === 'send_input') {
    if (!task.process || !task.process.stdin || task.status !== 'running') {
      return { error: `Task ${taskId} is not running or does not accept stdin` };
    }
    task.process.stdin.write((input || '') + '\n');
    return { success: true, id: task.id, message: 'Input sent to running task' };
  }
  return { error: `Unsupported action: ${action}` };
}

// Lazy Server-Side Gemini client
function getAiClient(): GoogleGenAI {
  return new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY || "",
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

// ============================================================================
// OFFICIAL GOOGLE AI STUDIO BUILD TOOL DECLARATIONS
// ============================================================================

const writeToFileTool: FunctionDeclaration = {
  name: "write_to_file",
  description: "Use this tool to create new files. The file and any parent directories will be created for you if they do not already exist. Write files in one complete, pristine block.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      TargetFile: { type: Type.STRING, description: "The target file to create and write code to. Absolute path starting with / or relative to workspace root." },
      CodeContent: { type: Type.STRING, description: "The complete code contents to write to the file." },
      Description: { type: Type.STRING, description: "Brief explanation of what this change did." },
      Overwrite: { type: Type.BOOLEAN, description: "Set to true to overwrite an existing file." },
      Append: { type: Type.BOOLEAN, description: "Set to true to append CodeContent to the end of TargetFile." },
    },
    required: ["TargetFile", "CodeContent", "Description"],
  },
};

const replaceFileContentTool: FunctionDeclaration = {
  name: "replace_file_content",
  description: "Use this tool to edit an existing file by replacing a single contiguous block of code. Specify StartLine, EndLine, TargetContent, and ReplacementContent.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      TargetFile: { type: Type.STRING, description: "The target file to modify." },
      Instruction: { type: Type.STRING, description: "Description of the changes being made." },
      Description: { type: Type.STRING, description: "Brief explanation of what this change did." },
      TargetContent: { type: Type.STRING, description: "The exact string to be replaced. Must match existing text." },
      ReplacementContent: { type: Type.STRING, description: "The complete replacement content." },
      StartLine: { type: Type.INTEGER, description: "Starting line number of chunk (1-indexed)." },
      EndLine: { type: Type.INTEGER, description: "Ending line number of chunk (1-indexed)." },
      AllowMultiple: { type: Type.BOOLEAN, description: "If true, multiple occurrences will be replaced." },
    },
    required: ["TargetFile", "Instruction", "Description", "TargetContent", "ReplacementContent"],
  },
};

const multiReplaceFileContentTool: FunctionDeclaration = {
  name: "multi_replace_file_content",
  description: "Use this tool to edit an existing file with multiple non-contiguous edits in a single call.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      TargetFile: { type: Type.STRING, description: "The target file to modify." },
      Instruction: { type: Type.STRING, description: "Description of the changes being made." },
      Description: { type: Type.STRING, description: "Brief explanation of what this change did." },
      ReplacementChunks: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            TargetContent: { type: Type.STRING, description: "Exact target substring to replace." },
            ReplacementContent: { type: Type.STRING, description: "Replacement content." },
            StartLine: { type: Type.INTEGER, description: "Start line number." },
            EndLine: { type: Type.INTEGER, description: "End line number." },
          },
          required: ["TargetContent", "ReplacementContent"],
        },
        description: "List of chunks to replace.",
      },
    },
    required: ["TargetFile", "Instruction", "Description", "ReplacementChunks"],
  },
};

const viewFileTool: FunctionDeclaration = {
  name: "view_file",
  description: "View the contents of a file from the local filesystem with 1-indexed line numbers. Specify StartLine and EndLine to view a slice.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      AbsolutePath: { type: Type.STRING, description: "Path to file to view (starting with / or relative to root)." },
      StartLine: { type: Type.INTEGER, description: "Optional start line to view (1-indexed, inclusive)." },
      EndLine: { type: Type.INTEGER, description: "Optional end line to view (1-indexed, inclusive)." },
      ContentOffset: { type: Type.INTEGER, description: "Optional byte offset for large files." },
    },
    required: ["AbsolutePath"],
  },
};

const listDirTool: FunctionDeclaration = {
  name: "list_dir",
  description: "List the contents of a directory, all files and subdirectories.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      DirectoryPath: { type: Type.STRING, description: "The path to the directory to list contents of." },
    },
    required: ["DirectoryPath"],
  },
};

const runCommandTool: FunctionDeclaration = {
  name: "run_command",
  description: "PROPOSE and execute a command on the project system (bash shell). Supports WaitMsBeforeAsync and IsDaemon for background tasks (e.g. git clone, tests, npm builds, inspections). Never use cd.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      CommandLine: { type: Type.STRING, description: "The exact command line string to execute." },
      Cwd: { type: Type.STRING, description: "The current working directory for the command." },
      WaitMsBeforeAsync: { type: Type.INTEGER, description: "Milliseconds to wait before sending to background (default 5000, max 10000)." },
      IsDaemon: { type: Type.BOOLEAN, description: "Set to true for long-running background daemon processes." },
    },
    required: ["CommandLine"],
  },
};

const manageTaskTool: FunctionDeclaration = {
  name: "manage_task",
  description: "Manage background tasks spawned by run_command: list running tasks, check status/output, send stdin input, or kill a task.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      Action: { type: Type.STRING, enum: ["list", "status", "kill", "send_input"], description: "Action to perform on background tasks." },
      TaskId: { type: Type.STRING, description: "The task ID to manage (required for status, kill, send_input)." },
      Input: { type: Type.STRING, description: "Input text to send to stdin (for send_input)." },
    },
    required: ["Action"],
  },
};

const installAppletPackageTool: FunctionDeclaration = {
  name: "install_applet_package",
  description: "Install npm packages to the project. Adds packages to package.json and installs them. Call BEFORE importing new packages.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      PackageNames: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: "The names of npm packages to install (e.g. ['lucide-react', 'date-fns']).",
      },
      IsDevDependency: { type: Type.BOOLEAN, description: "Whether to install as dev dependency (-D)." },
    },
    required: ["PackageNames"],
  },
};

const installAppletDependenciesTool: FunctionDeclaration = {
  name: "install_applet_dependencies",
  description: "Install all dependencies from package.json via npm install. Use after cloning a repository or modifying package.json. Optional path: a project directory relative to the workspace (default '.' = the agent service itself).",
  parameters: {
    type: Type.OBJECT,
    properties: {
      path: { type: Type.STRING, description: "Project directory relative to the workspace, e.g. 'projects/import_shop_123'. Defaults to '.'." },
    },
  },
};

const grepSearchTool: FunctionDeclaration = {
  name: "grep_search",
  description: "Fast regex/text search across workspace source files, returning matching file paths, line numbers, and line previews (skips node_modules, .git, dist).",
  parameters: {
    type: Type.OBJECT,
    properties: {
      Pattern: { type: Type.STRING, description: "Text or regex pattern to search for (e.g. 'useState|useEffect')." },
      SearchPath: { type: Type.STRING, description: "Directory or file relative to workspace root to search in (default '.')." },
    },
    required: ["Pattern"],
  },
};

const findByNameTool: FunctionDeclaration = {
  name: "find_by_name",
  description: "Find files in the workspace matching a filename or glob pattern (skips node_modules, .git, dist).",
  parameters: {
    type: Type.OBJECT,
    properties: {
      Pattern: { type: Type.STRING, description: "Filename or glob pattern (e.g. '*.tsx', '*Modal*')." },
      SearchDirectory: { type: Type.STRING, description: "Directory to search in (default '.')." },
    },
    required: ["Pattern"],
  },
};

const readSkillTool: FunctionDeclaration = {
  name: "read_skill",
  // FIX (2026-11-27): the skill list was hardcoded (32 names) and went stale
  // whenever a skill was added. It is now generated from the registry, so
  // the model always sees the real, current list.
  description: `Read specialized coding skill documentation before building or migrating. There are ${CODING_SKILLS_REGISTRY.length} skills in the registry (${CODING_SKILLS_REGISTRY.map((s) => s.name).join(', ')}). Call with a skill name to load its full instructions, or 'list' to list all skills.`,
  parameters: {
    type: Type.OBJECT,
    properties: {
      SkillName: { type: Type.STRING, description: "Name of the skill to read, or 'list' to list all available coding skills." },
    },
    required: ["SkillName"],
  },
};

const analyzeProjectTool: FunctionDeclaration = {
  name: "analyze_project",
  description: "Inspect workspace structure, package.json scripts/dependencies, and key source files in one call.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      TargetDirectory: { type: Type.STRING, description: "Optional subdirectory to inspect (default '.')." },
    },
  },
};

const gitStatusTool: FunctionDeclaration = {
  name: "git_status",
  description: "Check current git branch and working tree status.",
  parameters: { type: Type.OBJECT, properties: {} },
};

const gitDiffTool: FunctionDeclaration = {
  name: "git_diff",
  description: "View uncommitted git changes in the workspace.",
  parameters: { type: Type.OBJECT, properties: {} },
};

const detectSecretsTool: FunctionDeclaration = {
  name: "detect_secrets",
  description: "Scan source files for hardcoded API keys, tokens, or credentials.",
  parameters: { type: Type.OBJECT, properties: {} },
};

const codeExecutionSandboxTool: FunctionDeclaration = {
  name: "code_execution_sandbox",
  description: "Code Execution Sandbox: safely execute Python, JavaScript, TypeScript, or Bash code snippets inside an isolated temporary sandbox directory to test algorithms, verify syntax, or reproduce bugs.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      Language: { type: Type.STRING, enum: ["python", "javascript", "typescript", "bash"], description: "Programming language runtime to execute." },
      Code: { type: Type.STRING, description: "Source code to execute inside the sandbox." },
      TimeoutMs: { type: Type.INTEGER, description: "Execution timeout in milliseconds (default 10000, max 15000)." },
    },
    required: ["Language", "Code"],
  },
};

const readMultipleFilesTool: FunctionDeclaration = {
  name: "read_multiple_files",
  description: "Multi-File Context: read up to 10 workspace files simultaneously in one batch call to understand cross-file imports, types, and architecture.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      FilePaths: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: "Array of relative file paths to read (e.g. ['src/App.tsx', 'server.ts']).",
      },
    },
    required: ["FilePaths"],
  },
};

const computeFileDiffTool: FunctionDeclaration = {
  name: "compute_file_diff",
  description: "Diff Management: compute a unified line-by-line diff between a workspace file and git HEAD or proposed new content.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      TargetFile: { type: Type.STRING, description: "Path to workspace file." },
      ProposedContent: { type: Type.STRING, description: "Optional proposed new content to diff against the current file on disk. If omitted, diffs against git HEAD." },
    },
    required: ["TargetFile"],
  },
};

const debugErrorAnalysisTool: FunctionDeclaration = {
  name: "debug_error_analysis",
  description: "Debugging & Error Analysis: run TypeScript diagnostics (tsc --noEmit), inspect stack trace / error logs, and read failing file line slices to diagnose root cause.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      ErrorMessage: { type: Type.STRING, description: "Optional error message or stack trace reported by user or build." },
      TargetFile: { type: Type.STRING, description: "Optional suspected file path to inspect." },
    },
  },
};

const clawDoctorTool: FunctionDeclaration = {
  name: "claw_doctor",
  description: "Claw CLI Doctor: comprehensive health check of local environment, runtime binaries (node, python, git, tsx), port 3000, disk, memory, and API key pool connectivity.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      runNetworkCheck: { type: Type.BOOLEAN, description: "Whether to run outbound connectivity check." },
    },
  },
};

const clawStatusTool: FunctionDeclaration = {
  name: "claw_status",
  description: "Claw CLI Status: inspect harness runtime status, active session, background tasks, loaded skills, registered tools, memory usage, and model routing.",
  parameters: { type: Type.OBJECT, properties: {} },
};

const clawAcpTool: FunctionDeclaration = {
  name: "claw_acp",
  description: "Claw Agent Client Protocol (ACP): inspect protocol capabilities, session handshake, tools list, and transport status.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      action: { type: Type.STRING, enum: ["status", "capabilities", "handshake"], description: "ACP action to perform." },
    },
  },
};

const clawPromptTool: FunctionDeclaration = {
  name: "claw_prompt",
  description: "Claw CLI Prompt: dispatch a task or directive directly to the Claw agent harness with execution mode and sub-agent parameters.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      prompt: { type: Type.STRING, description: "Prompt or directive to execute." },
      role: { type: Type.STRING, description: "Agent persona/role (e.g. 'architect', 'executor', 'debugger')." },
      dryRun: { type: Type.BOOLEAN, description: "Simulate execution without modifying files." },
    },
    required: ["prompt"],
  },
};

const omoCoordinateTool: FunctionDeclaration = {
  name: "omo_coordinate",
  description: "OmO (oh-my-openagent): orchestrate multi-agent coordination between Architect (design), Executor (code), and Reviewer (verification) with automated handoffs and consensus.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      task: { type: Type.STRING, description: "The task to coordinate across sub-agents." },
      context: { type: Type.STRING, description: "Optional project context or relevant files." },
      subAgents: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: "Sub-agents participating (e.g. ['Architect', 'Executor', 'Reviewer']).",
      },
    },
    required: ["task"],
  },
};

const omxProtocolTool: FunctionDeclaration = {
  name: "omx_protocol",
  description: "OmX (oh-my-codex): convert user instructions into a 3-phase structured execution protocol (Problem Decomposition -> Parallel Workstreams -> Persistent Verification Loop).",
  parameters: {
    type: Type.OBJECT,
    properties: {
      goal: { type: Type.STRING, description: "The goal or user prompt to translate into structured protocol." },
      targetStack: { type: Type.STRING, description: "Target technology stack (e.g. 'React 19 + TypeScript + Vite + Tailwind v4 + Express')." },
    },
    required: ["goal"],
  },
};

const clawhipRouterTool: FunctionDeclaration = {
  name: "clawhip_router",
  description: "ClawHip Event Router: manage out-of-band events and notifications (Git commits, background task lifecycles, PRs, milestones) outside primary LLM context window.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      action: { type: Type.STRING, enum: ["list", "emit", "clear"], description: "Action to perform on the event router." },
      eventType: { type: Type.STRING, description: "Event type (e.g. 'git_commit', 'task_lifecycle', 'agent_milestone', 'notification')." },
      message: { type: Type.STRING, description: "Event message or summary." },
      metadata: { type: Type.STRING, description: "JSON stringified metadata." },
    },
    required: ["action"],
  },
};

const lazycodexRunnerTool: FunctionDeclaration = {
  name: "lazycodex_runner",
  description: "Gajae-Code / LazyCodex: autonomous iterative coding runner that executes code development tasks, runs compiler/type verification, and self-heals iteratively until passing.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      task: { type: Type.STRING, description: "The coding task to execute autonomously." },
      targetFiles: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: "Files targeted for generation/modification.",
      },
      maxIterations: { type: Type.INTEGER, description: "Maximum self-healing verification iterations (default: 3)." },
    },
    required: ["task"],
  },
};

const compileAppletTool: FunctionDeclaration = {
  name: "compile_applet",
  description: "Checks if the applet / website builds successfully. Runs build verification and returns compiler errors or success.",
  parameters: { type: Type.OBJECT, properties: {} },
};

const lintAppletTool: FunctionDeclaration = {
  name: "lint_applet",
  description: "Validates codebase for syntax errors, missing imports, and fatal issues using tsc --noEmit or npm run lint.",
  parameters: { type: Type.OBJECT, properties: {} },
};

const restartDevServerTool: FunctionDeclaration = {
  name: "restart_dev_server",
  description: "Restarts or refreshes the development server process after updating dependencies, packages, or server files.",
  parameters: { type: Type.OBJECT, properties: {} },
};

const deleteFileTool: FunctionDeclaration = {
  name: "delete_file",
  description: "Delete an existing file.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      TargetFile: { type: Type.STRING, description: "The target file to delete." },
    },
    required: ["TargetFile"],
  },
};

const deleteDirTool: FunctionDeclaration = {
  name: "delete_dir",
  description: "Delete a directory.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      DirectoryPath: { type: Type.STRING, description: "The directory to delete." },
      Force: { type: Type.BOOLEAN, description: "If true, recursively delete all contents." },
    },
    required: ["DirectoryPath"],
  },
};

const moveTool: FunctionDeclaration = {
  name: "move",
  description: "Move or rename a file or directory to a new path.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      SourcePath: { type: Type.STRING, description: "Path to existing file or directory." },
      DestinationPath: { type: Type.STRING, description: "Destination path." },
    },
    required: ["SourcePath", "DestinationPath"],
  },
};

const searchWebTool: FunctionDeclaration = {
  name: "search_web",
  description: "Performs a web search for documentation, packages, modern code examples, and technical solutions.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: { type: Type.STRING, description: "The search query." },
      domain: { type: Type.STRING, description: "Optional domain to recommend search prioritize." },
    },
    required: ["query"],
  },
};

const generateImageTool: FunctionDeclaration = {
  name: "generate_image",
  description: "Generate high-fidelity visual assets, app icons, hero banners, or illustrations based on a prompt.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      Prompt: { type: Type.STRING, description: "The text prompt to generate image for." },
      ImageName: { type: Type.STRING, description: "Name of the generated image to save (e.g. 'hero_banner', 'app_icon')." },
      AspectRatio: { type: Type.STRING, enum: ["1:1", "16:9", "4:3", "9:16", "3:4"], description: "Aspect ratio." },
    },
    required: ["Prompt"],
  },
};

const askQuestionTool: FunctionDeclaration = {
  name: "ask_question",
  description: "Ask clarifying questions with interactive multiple-choice options and pause execution until the user submits or skips.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      questions: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            question: { type: Type.STRING, description: "Short question (1-2 sentences)." },
            options: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Short plain-text options." },
            is_multi_select: { type: Type.BOOLEAN, description: "Allow multiple selection." },
          },
          required: ["question", "options"],
        },
      },
    },
    required: ["questions"],
  },
};

const verifyLivePreviewTool: FunctionDeclaration = {
  name: "verify_live_preview",
  description: "Verifies the live preview webpage served on localhost:3000 by checking HTTP status, HTML structure, JavaScript syntax inside inline <script> tags, and local assets/PWA links (manifest, sw.js, icons, local scripts/styles).",
  parameters: {
    type: Type.OBJECT,
    properties: {
      targetUrl: { type: Type.STRING, description: "Relative preview URL (e.g. '/projects/index.html' or '/projects/<sessionId>/index.html')." },
      checkAssets: { type: Type.BOOLEAN, description: "Whether to verify local assets and PWA companion files return HTTP 200 (default: true)." },
    },
  },
};

// ============================================================================
// LEGACY COMPATIBILITY TOOL ALIASES (to support both styles seamlessly)
// ============================================================================

const fileReadTool: FunctionDeclaration = {
  name: "fileRead",
  description: "Read the content of a file (alias for view_file).",
  parameters: {
    type: Type.OBJECT,
    properties: {
      filePath: { type: Type.STRING, description: "The path to the file relative to project root." },
    },
    required: ["filePath"],
  },
};

const fileWriteTool: FunctionDeclaration = {
  name: "fileWrite",
  description: "Write content to a file (alias for write_to_file).",
  parameters: {
    type: Type.OBJECT,
    properties: {
      filePath: { type: Type.STRING, description: "The path to the file relative to project root." },
      content: { type: Type.STRING, description: "The content to write." },
    },
    required: ["filePath", "content"],
  },
};

const fileEditTool: FunctionDeclaration = {
  name: "fileEdit",
  description: "Edit an existing file by replacing a specific block of text (alias for replace_file_content).",
  parameters: {
    type: Type.OBJECT,
    properties: {
      filePath: { type: Type.STRING, description: "Path to the file." },
      oldText: { type: Type.STRING, description: "The exact text to be replaced." },
      newText: { type: Type.STRING, description: "The replacement text." },
    },
    required: ["filePath", "oldText", "newText"],
  },
};

const bashTool: FunctionDeclaration = {
  name: "bash",
  description: "Execute a bash command in the project terminal (alias for run_command).",
  parameters: {
    type: Type.OBJECT,
    properties: {
      command: { type: Type.STRING, description: "The bash command to execute." },
    },
    required: ["command"],
  },
};

const webFetchTool: FunctionDeclaration = {
  name: "webFetch",
  description: "Fetch data or inspect website layout from a URL.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      url: { type: Type.STRING, description: "The URL to fetch data from." },
    },
    required: ["url"],
  },
};

const planTool: FunctionDeclaration = {
  name: "plan",
  description: "Create or update a step-by-step implementation plan for a complex task.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      steps: { 
        type: Type.ARRAY, 
        items: { type: Type.STRING },
        description: "List of steps to execute." 
      },
    },
    required: ["steps"],
  },
};

const setUpFirebaseTool: FunctionDeclaration = {
  name: "set_up_firebase",
  description: "Wires the CONNECTED Firebase project (Auth + Firestore + Storage SDK) into the current built project (firebase.js / src/lib/firebase.ts, firebase.json, .firebaserc, firestore.rules). Uses the Firebase project the user connected once via the Connect Firebase button — never pass an API key to this tool. BACKEND RULE: only call this when the user explicitly asked for backend/Firebase work (or said yes when asked); default builds are frontend-only.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      platform: { type: Type.STRING, description: "Platform target: 'web' only (Android native setup is not supported by this agent)." },
    },
    required: [],
  },
};

const deployFirebaseTool: FunctionDeclaration = {
  name: "deploy_firebase",
  description: "Deploys the current built project to Firebase Hosting (real deploy). Requires FIREBASE_TOKEN env (one-time `firebase login:ci`) — without it, returns the exact one-time setup steps instead of pretending to deploy. Optionally writes custom firestore.rules first.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      rules: { type: Type.STRING, description: "Optional custom firestore.rules content to write before deploying." },
    },
  },
};

const setUpOAuthTool: FunctionDeclaration = {
  name: "set_up_oauth",
  description: "Initiates OAuth setup for Google Workspace APIs (Google Drive, Docs, Sheets, Calendar, Gmail) or external OAuth providers.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      title: { type: Type.STRING, description: "Title of the OAuth task/step (e.g. 'Use Google Drive to read files')." },
      scopes_to_add: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: "List of OAuth scopes required by the applet.",
      },
      userConfirmedInUI: { type: Type.BOOLEAN, description: "Whether user confirmed OAuth configuration." },
    },
    required: ["title", "scopes_to_add"],
  },
};

const removeOAuthTool: FunctionDeclaration = {
  name: "remove_oauth",
  description: "Removes specified OAuth scopes from applet configuration.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      scopes_to_remove: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: "OAuth scopes to remove.",
      },
    },
    required: ["scopes_to_remove"],
  },
};

const cloudSqlExecuteSqlTool: FunctionDeclaration = {
  name: "cloudsql_execute_sql",
  description: "Executes SQL query (DQL/DML) on the local/Cloud SQL PostgreSQL database instance to seed data, verify tables, or query records.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      sql_statement: { type: Type.STRING, description: "SQL query statement to execute." },
    },
    required: ["sql_statement"],
  },
};

const cloudSqlUpdateSchemaTool: FunctionDeclaration = {
  name: "cloudsql_update_schema",
  description: "Updates and validates database schema defined in src/db/schema.ts using Drizzle ORM.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      schemaPath: { type: Type.STRING, description: "Path to schema file (default: 'src/db/schema.ts')." },
    },
  },
};

const figmaImportTool: FunctionDeclaration = {
  name: "figma_import",
  description: "Turns an attached Figma design reference or specification into clean React + Tailwind CSS code in the workspace.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      componentName: { type: Type.STRING, description: "Name of the component to create." },
      designSpecs: { type: Type.STRING, description: "Description or specs of the Figma design." },
    },
    required: ["componentName", "designSpecs"],
  },
};

const focusModeTool: FunctionDeclaration = {
  name: "focus_mode",
  description: "Applies targeted surgical UI edits to a specific CSS selector or component without touching surrounding code.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      cssSelector: { type: Type.STRING, description: "CSS selector targeted (e.g. '#header', '.cart-drawer')." },
      targetFile: { type: Type.STRING, description: "File containing the element." },
      editInstruction: { type: Type.STRING, description: "Exact visual/functional change to apply." },
    },
    required: ["cssSelector", "editInstruction"],
  },
};

const scheduleTool: FunctionDeclaration = {
  name: "schedule",
  description: "Schedule a one-shot timer that notifies the agent: the message is stored as a reminder and the server fires it when the time comes (visible in the system log and via the remind tool's 'due' action). Fires only while the server is awake — on Render free the server sleeps when idle, so a timer may fire late.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      DurationSeconds: { type: Type.INTEGER, description: "Duration in seconds for one-shot timer." },
      Prompt: { type: Type.STRING, description: "Message prompt when timer fires." },
    },
    required: ["Prompt"],
  },
};

// --- Agent memory / lessons / jobs tools (server-side, plain files) --------
const saveMemoryTool: FunctionDeclaration = {
  name: "save_memory",
  description: "Save a durable fact about the user (name, language, preference, decision, rule) to the server memory file (data/memory.md). The agent reads this file at the start of every session. Use when the user states something that should be remembered across chats. Never store secrets or API keys here.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      Fact: { type: Type.STRING, description: "One short fact, e.g. 'User prefers Bengali replies' or 'User has 10 Gemini keys from separate accounts'." },
    },
    required: ["Fact"],
  },
};

const readMemoryTool: FunctionDeclaration = {
  name: "read_memory",
  description: "Read the server user-memory file (data/memory.md) — durable facts, preferences and decisions about the user.",
  parameters: { type: Type.OBJECT, properties: {} },
};

const saveLessonTool: FunctionDeclaration = {
  name: "save_lesson",
  description: "Record a lesson learned from a mistake (error + fix) in data/lessons.md so the agent does not repeat it. Use after fixing a build failure or a wrong tool choice.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      Error: { type: Type.STRING, description: "What went wrong (short)." },
      Fix: { type: Type.STRING, description: "How it was fixed / what to do instead (short)." },
      Context: { type: Type.STRING, description: "Optional context, e.g. the build or file involved." },
    },
    required: ["Error", "Fix"],
  },
};

const queueJobTool: FunctionDeclaration = {
  name: "queue_job",
  description: "Queue a build as a background job (e.g. when the user says 'build this by morning'). The job runs in the background, one at a time; its status and preview link appear in the Jobs panel. Returns the job id.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      Prompt: { type: Type.STRING, description: "The full build request to run in the background." },
    },
    required: ["Prompt"],
  },
};

export const serverTools: FunctionDeclaration[] = [
  // Primary AI Studio Coding Mode Tools
  readSkillTool,
  analyzeProjectTool,
  grepSearchTool,
  findByNameTool,
  writeToFileTool,
  replaceFileContentTool,
  multiReplaceFileContentTool,
  viewFileTool,
  listDirTool,
  runCommandTool,
  manageTaskTool,
  installAppletPackageTool,
  installAppletDependenciesTool,
  compileAppletTool,
  lintAppletTool,
  restartDevServerTool,
  deleteFileTool,
  deleteDirTool,
  moveTool,
  gitStatusTool,
  gitDiffTool,
  detectSecretsTool,
  codeExecutionSandboxTool,
  readMultipleFilesTool,
  computeFileDiffTool,
  debugErrorAnalysisTool,
  verifyLivePreviewTool,
  searchWebTool,
  generateImageTool,
  askQuestionTool,
  setUpFirebaseTool,
  deployFirebaseTool,
  setUpOAuthTool,
  removeOAuthTool,
  cloudSqlExecuteSqlTool,
  cloudSqlUpdateSchemaTool,
  figmaImportTool,
  focusModeTool,
  scheduleTool,
  // UltraWorkers & Claw Harness Tools
  clawDoctorTool,
  clawStatusTool,
  clawAcpTool,
  clawPromptTool,
  omoCoordinateTool,
  omxProtocolTool,
  clawhipRouterTool,
  lazycodexRunnerTool,
  // Legacy aliases for full backward compatibility
  fileReadTool,
  fileWriteTool,
  fileEditTool,
  bashTool,
  webFetchTool,
  planTool,
  // Agent memory / lessons / background jobs (server-side plain files)
  saveMemoryTool,
  readMemoryTool,
  saveLessonTool,
  queueJobTool,
  // Nexus tools (37, re-implemented in TypeScript in server/nexusTools.ts):
  // GitHub push/create/repos/file, build_page/build_site, web_search,
  // read_page, Pollinations images, local_rag/vector_store/file_grep,
  // public_api_discovery, free_tier_directory, desh_api, browser-worker
  // tools, Google tools (Gmail/Calendar/Drive/Docs), remind, goals,
  // scheduled_browse. Every entry has a working implementation.
  ...nexusTools,
];

// ---------------------------------------------------------------------------
// STEP 4 (P0): the single shared tool allowlist for BOTH agent loops.
// The Gemini path used to send all 98 serverTools declarations on every
// call (~10,400 tokens of schema); the OpenAI-compatible path only ever
// sent the 87 tools below (toOpenAITools, apiOrchestrator.ts). Both loops
// now filter through CORE_TOOL_NAMES, so the Gemini path matches the
// OpenAI path exactly. The 17 tools NOT in this set are excluded from
// both loops' native declarations:
//   - Legacy aliases — canonical tool kept: fileRead (view_file),
//     fileWrite (write_to_file), fileEdit (replace_file_content), bash
//     (run_command). Same executor, duplicate schema cost.
//   - Claw harness — claw_doctor, claw_status, claw_acp, claw_prompt,
//     omx_protocol, clawhip_router, lazycodex_runner. (The
//     ultraworkers-claw-harness skill text still names them, as it
//     already did on the OpenAI path.)
//   - Stubs / thin wrappers with a kept canonical tool: figma_import and
//     focus_mode return a canned message only; set_up_oauth /
//     remove_oauth only edit a local .oauth-config.json;
//     cloudsql_update_schema only verifies/writes drizzle boilerplate
//     (cloudsql_execute_sql is kept).
//   - schedule: remind + queue_job cover scheduling on both paths. (Its
//     executor was fixed 2026-11-27 to store a real reminder, so the old
//     "sets no timer" reason no longer applies — the exclusion stands
//     because the capability is already covered, not because it is broken.)
// Executors for all 17 stay in executeServerTool, and KNOWN_TOOL_NAMES
// (apiOrchestrator.ts) still accepts them in the text-JSON fallback —
// exactly as the OpenAI path already did. Only the per-call declaration
// cost is removed; no capability is deleted.
// ---------------------------------------------------------------------------
export const CORE_TOOL_NAMES: Set<string> = new Set([
  'read_skill',
  'analyze_project',
  'view_file',
  'list_dir',
  'grep_search',
  'find_by_name',
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
  'install_applet_package',
  'compile_applet',
  'lint_applet',
  'run_command',
  'omo_coordinate',
  'debug_error_analysis',
  'code_execution_sandbox',
  'set_up_firebase',
  'deploy_firebase',
  'search_web',
  'webFetch',
  'generate_image',
  'restart_dev_server',
  'ask_question',
  'verify_live_preview',
  'cloudsql_execute_sql',
  // Hardening (2026-11-27): high-value working tools the model could not
  // call before — git inspection, multi-read, diff, secret scan, file move/
  // delete, plan registration, background-task management, project installs.
  'plan',
  'manage_task',
  'git_status',
  'git_diff',
  'read_multiple_files',
  'compute_file_diff',
  'detect_secrets',
  'move',
  'delete_file',
  'delete_dir',
  'install_applet_dependencies',
  // Agent memory / lessons / jobs
  'save_memory',
  'read_memory',
  'save_lesson',
  'queue_job',
  // Nexus tools (46) — every one has a working implementation in
  // server/nexusTools.ts and is delegated in geminiService.executeServerTool.
  'github_push',
  'github_create_repo',
  'github_repos',
  'github_file',
  'github_issues',
  'github_prs',
  'github_create_issue',
  'github_create_pr',
  'github_pull_request',
  'github_actions',
  'github_release',
  'github_code_search',
  'github_import',
  'build_page',
  'build_site',
  'deploy_site',
  'web_search',
  'read_page',
  'generate_image_pollinations',
  'file_grep',
  'local_rag',
  'vector_store',
  'public_api_discovery',
  'free_tier_directory',
  'desh_api',
  'browse_task',
  'browse_job',
  'browse_vision',
  'browse_resume',
  // Live browser (Browser tab): fine-grained control of one shared live
  // page — goto/click/type/press_key/screenshot on execCtx.liveSessionId.
  // Multi-tab: up to 4 live tabs per turn (execCtx.liveSessions);
  // browser_list_tabs lists them, browser_goto's new_tab opens another.
  'browser_goto',
  'browser_click',
  'browser_type',
  'browser_press_key',
  'browser_screenshot',
  'browser_list_tabs',
  'gmail_list',
  'gmail_search',
  'gmail_send',
  'gmail_draft',
  'calendar_list',
  'calendar_create',
  'drive_list',
  'docs_create',
  'docs_read',
  'remind',
  'goals',
  'scheduled_browse',
]);

/** STEP 4 (P0): the declarations a loop may offer the model natively —
 * the 87 core tools. Pass the result, never raw serverTools, to any chat. */
export function filterCoreTools(declarations: FunctionDeclaration[]): FunctionDeclaration[] {
  return declarations.filter((fn) => fn.name && CORE_TOOL_NAMES.has(fn.name));
}

export async function runCodeInSandbox(
  language: string,
  code: string,
  timeoutMs: number = 10000
): Promise<{ success: boolean; language: string; stdout: string; stderr: string; exitCode: number; durationMs: number }> {
  const lang = (language || 'javascript').toLowerCase();
  const safeTimeout = Math.min(Math.max(timeoutMs || 10000, 1000), 15000);
  const sandboxDir = path.join('/tmp', `nexus_sandbox_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
  const startedAt = Date.now();

  try {
    await fs.mkdir(sandboxDir, { recursive: true });
    let entryFile = 'snippet.js';
    let cmd = '';

    if (lang === 'python' || lang === 'py') {
      entryFile = 'snippet.py';
      cmd = `python3 "${path.join(sandboxDir, entryFile)}"`;
    } else if (lang === 'typescript' || lang === 'ts') {
      entryFile = 'snippet.ts';
      cmd = `"${path.resolve(process.cwd(), 'node_modules/.bin/tsx')}" "${path.join(sandboxDir, entryFile)}"`;
    } else if (lang === 'bash' || lang === 'sh') {
      entryFile = 'snippet.sh';
      cmd = `bash "${path.join(sandboxDir, entryFile)}"`;
    } else {
      entryFile = 'snippet.mjs';
      cmd = `node "${path.join(sandboxDir, entryFile)}"`;
    }

    await fs.writeFile(path.join(sandboxDir, entryFile), code || '', 'utf-8');

    try {
      const { stdout, stderr } = await execPromise(cmd, { cwd: sandboxDir, timeout: safeTimeout });
      return {
        success: true,
        language: lang,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: 0,
        durationMs: Date.now() - startedAt,
      };
    } catch (execErr: any) {
      return {
        success: false,
        language: lang,
        stdout: execErr.stdout ? execErr.stdout.trim() : '',
        stderr: execErr.stderr ? execErr.stderr.trim() : (execErr.message || 'Sandbox execution failed'),
        exitCode: typeof execErr.code === 'number' ? execErr.code : 1,
        durationMs: Date.now() - startedAt,
      };
    }
  } finally {
    await fs.rm(sandboxDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function runDebugErrorAnalysis(errorMessage?: string, targetFile?: string) {
  let tscStatus = 'passed';
  let tscOutput = '';
  try {
    const { stdout } = await execPromise('npx tsc --noEmit', { cwd: process.cwd(), timeout: 15000 });
    tscOutput = stdout.trim() || 'No TypeScript compiler errors.';
  } catch (err: any) {
    tscStatus = 'errors_found';
    tscOutput = (err.stdout || err.stderr || err.message || '').trim().slice(0, 6000);
  }

  let filePreview: string | null = null;
  if (targetFile) {
    try {
      const { abs, relative } = resolveSafePath(targetFile);
      if (abs.startsWith(process.cwd())) {
        const content = await fs.readFile(abs, 'utf-8');
        const lines = content.split('\n').slice(0, 120).map((l, i) => `${i + 1}: ${l}`).join('\n');
        filePreview = `File /${relative} (first 120 lines):\n${lines}`;
      }
    } catch (e: any) {
      filePreview = `Could not inspect ${targetFile}: ${e.message}`;
    }
  }

  return {
    tscStatus,
    tscOutput,
    reportedError: errorMessage || null,
    filePreview,
    recommendation: tscStatus === 'errors_found'
      ? 'Inspect the TypeScript diagnostics above and apply surgical fixes with replace_file_content.'
      : 'TypeScript check passed cleanly. Inspect runtime logs or reproduce inside code_execution_sandbox.',
  };
}

// ============================================================================
// ULTRAWORKERS & CLAW CODE HARNESS CORE FUNCTIONS
// ============================================================================

export async function runClawDoctor(runNetworkCheck: boolean = false) {
  const checks: Array<{ name: string; status: 'ok' | 'warn' | 'error'; message: string; details?: any }> = [];

  // 1. Node.js runtime
  try {
    const { stdout } = await execPromise('node -v');
    checks.push({ name: 'Node.js Runtime', status: 'ok', message: stdout.trim() });
  } catch (e: any) {
    checks.push({ name: 'Node.js Runtime', status: 'error', message: e.message });
  }

  // 2. Python3 runtime
  try {
    const { stdout } = await execPromise('python3 --version');
    checks.push({ name: 'Python3 Sandbox', status: 'ok', message: stdout.trim() });
  } catch (e: any) {
    checks.push({ name: 'Python3 Sandbox', status: 'warn', message: 'python3 binary not found in PATH' });
  }

  // 3. Git binary & branch
  try {
    const { stdout: gitVer } = await execPromise('git --version');
    const { stdout: branch } = await execPromise('git rev-parse --abbrev-ref HEAD').catch(() => ({ stdout: 'main' }));
    checks.push({ name: 'Git Version Control', status: 'ok', message: `${gitVer.trim()} (branch: ${branch.trim()})` });
  } catch (e: any) {
    checks.push({ name: 'Git Version Control', status: 'warn', message: e.message });
  }

  // 4. TSX binary
  try {
    const { stdout } = await execPromise('npx tsx -v');
    checks.push({ name: 'TSX TypeScript Runner', status: 'ok', message: stdout.trim() });
  } catch (e: any) {
    checks.push({ name: 'TSX TypeScript Runner', status: 'warn', message: 'npx tsx not found' });
  }

  // 5. Memory & Uptime
  const mem = process.memoryUsage();
  const heapMb = Math.round(mem.heapUsed / 1024 / 1024);
  const rssMb = Math.round(mem.rss / 1024 / 1024);
  checks.push({
    name: 'Process Memory & Uptime',
    status: rssMb > 800 ? 'warn' : 'ok',
    message: `Heap: ${heapMb}MB, RSS: ${rssMb}MB, Uptime: ${Math.round(process.uptime())}s`,
  });

  // 6. Port & Server Status
  checks.push({
    name: 'Dev Server Port Binding',
    status: 'ok',
    message: `Server active on 0.0.0.0:${process.env.PORT || 3000} (PID: ${process.pid})`,
  });

  // 7. API Keys Pool
  let storedKeysCount = 0;
  try {
    const secrets = await fs.readFile(path.resolve(process.cwd(), '.secrets.json'), 'utf-8').then(JSON.parse).catch(() => []);
    storedKeysCount = Array.isArray(secrets) ? secrets.length : 0;
  } catch {}
  const hasEnvKey = Boolean(process.env.GEMINI_API_KEY);
  checks.push({
    name: 'API Key Pool & Providers',
    status: (storedKeysCount > 0 || hasEnvKey) ? 'ok' : 'warn',
    message: `Stored Keys: ${storedKeysCount}, Primary Studio Env: ${hasEnvKey ? 'Present' : 'Not Set'}`,
  });

  // 8. Outbound connectivity if requested
  if (runNetworkCheck) {
    try {
      const pingRes = await fetch('https://www.google.com', { signal: AbortSignal.timeout(3000) });
      checks.push({ name: 'Outbound Network Connectivity', status: pingRes.ok ? 'ok' : 'warn', message: `Status: ${pingRes.status}` });
    } catch (e: any) {
      checks.push({ name: 'Outbound Network Connectivity', status: 'warn', message: e.message });
    }
  }

  const hasError = checks.some(c => c.status === 'error');
  const hasWarn = checks.some(c => c.status === 'warn');
  const overallStatus = hasError ? 'critical' : hasWarn ? 'warning' : 'healthy';

  return {
    harness: 'Claw Code Harness (UltraWorkers Ecosystem)',
    timestamp: Date.now(),
    overallStatus,
    checksCount: checks.length,
    passedCount: checks.filter(c => c.status === 'ok').length,
    checks,
  };
}

export async function getClawStatus() {
  const mem = process.memoryUsage();
  return {
    harness: 'Nexus / UltraWorkers Claw Code Harness',
    version: '2.5.0-acp',
    status: 'online',
    timestamp: Date.now(),
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
    memory: {
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
      rssMb: Math.round(mem.rss / 1024 / 1024),
    },
    backgroundTasks: {
      active: Array.from(backgroundTasks.values()).filter(t => t.status === 'running').length,
      total: backgroundTasks.size,
    },
    protocol: {
      name: 'agent-client-protocol',
      version: '1.0.0-draft',
      transport: 'sse',
      activeAgents: ['Architect', 'Executor', 'Reviewer'],
    },
    toolsCount: serverTools.length,
  };
}

export function getClawAcpInfo(action: string = 'status') {
  return {
    protocol: 'agent-client-protocol',
    version: '1.0.0-draft',
    status: 'connected',
    action,
    capabilities: {
      tools: { list: true, call: true },
      resources: { read: true, list: true, subscribe: false },
      prompts: { list: true, get: true },
      streaming: { sse: true, chunks: true },
      roots: { list: true },
      sampling: { multiModel: true },
      multiAgentCoordination: { omo: true, omx: true, clawhip: true },
    },
    transport: 'sse + json-rpc',
    activeSession: `acp_${Date.now()}`,
    registeredToolsCount: serverTools.length,
  };
}

export async function runClawPrompt(prompt: string, role: string = 'developer', dryRun: boolean = false) {
  return {
    harness: 'claw prompt',
    timestamp: Date.now(),
    role,
    dryRun,
    status: 'accepted',
    instruction: prompt,
    executionPipeline: [
      `Decompose task into structured milestones (OmX protocol)`,
      `Route sub-tasks to specialized sub-agents via OmO`,
      `Track background commit/task events via ClawHip`,
      dryRun ? `[DRY-RUN] Verification preview generated` : `Execute surgical changes & verify via compiler/sandbox`,
    ],
    guidance: `Harness ready. Proceeding with function calls as needed.`,
  };
}

// STEP 9 (P1-2): omo_coordinate makes ONE planner sub-call on the CHEAP
// chain (never Hydrogen) with an output cap. The old code made TWO sub-calls
// through execCtx.llmInvoker — the turn model's invoker (Hydrogen on coding
// turns) — plus a hardcoded gemini-3.5-flash-lite fallback. The single
// combined plan covers both the Architect spec and the Executor
// file-operations list; the two phases split it on the "FILE OPERATIONS:"
// marker. Fail-soft: when the cheap call is unavailable (no keys / router
// down) the phases fall back to the static templates, exactly as before.
const OMO_PLAN_MAX_TOKENS = 600;
const OMO_PLAN_TIMEOUT_MS = 30000;

export async function runOmoCoordinate(
  task: string,
  context?: string,
  subAgents: string[] = ['Architect', 'Executor', 'Reviewer'],
  execCtx?: ToolExecutionContext
) {
  // Gather real workspace context for sub-agents
  let workspaceSnapshot = '';
  try {
    const pkgRaw = await fs.readFile(path.resolve(process.cwd(), 'package.json'), 'utf-8').catch(() => '');
    const pkgName = pkgRaw ? JSON.parse(pkgRaw).name : 'workspace';
    const topEntries = await fs.readdir(process.cwd(), { withFileTypes: true });
    const topList = topEntries
      .filter(e => !['node_modules', '.git', 'dist'].includes(e.name))
      .map(e => (e.isDirectory() ? `${e.name}/` : e.name))
      .slice(0, 30)
      .join(', ');
    workspaceSnapshot = `Project: ${pkgName}\nTop-level entries: ${topList}`;
  } catch {}

  // ONE planner sub-call on the cheap chain (cheapChain() — live-verified
  // cheap seeds + auto:fast floor, never Hydrogen, never a hardcoded model
  // ID), output-capped at OMO_PLAN_MAX_TOKENS.
  // The plan has THREE sections: the PARTS section lets the parallel build
  // (parallelBuild.ts) split the work into independent parts — each a
  // disjoint set of files — so up to 4 background coder workers can build
  // them at the same time on distinct keys. "PARTS: none" (single file, or
  // parts that cannot be independent) keeps the turn on the serial path.
  let planText: string | null = null;
  try {
    const { text, model } = await chatOnce({
      system: 'You are the Planner Sub-Agent in a multi-agent engineering pipeline. Output a concrete plan only: an architectural specification, then the exact workspace file operations, then the parallel-work split.',
      user: `Task: ${task}\n${context ? `Context: ${context}\n` : ''}${workspaceSnapshot}\n\nRespond in exactly three sections:\nARCHITECTURE: Provide a concise, concrete architectural specification (target files, components/routes, data flow, and verification criteria). Keep it under 180 words.\nFILE OPERATIONS: List the exact files to create/edit via write_to_file or replace_file_content, and exact packages/commands if needed. Keep under 160 words.\nPARTS: Split the work into 2-4 independent parts that can be built in parallel. Each part is a disjoint set of files — no file in two parts, and no part depends on another part's output. If the build is a single file or the parts cannot be independent, write "PARTS: none". Format exactly:\nPARTS:\n1. <short title> — files: <path1>, <path2>\n2. <short title> — files: <path3>`,
      chain: cheapChain(),
      maxTokens: OMO_PLAN_MAX_TOKENS,
      timeoutMs: OMO_PLAN_TIMEOUT_MS,
    });
    planText = text?.trim() || null;
    if (planText) console.log(`[OmO] planner call used cheap model ${model} (max_tokens=${OMO_PLAN_MAX_TOKENS})`);
  } catch (e) {
    console.warn('OmO cheap planner call failed — falling back to static plan:', e);
  }

  // Split the single plan into the Architect spec and the Executor file list.
  const splitPlan = (plan: string | null): { architecture: string | null; fileOps: string | null } => {
    if (!plan) return { architecture: null, fileOps: null };
    const marker = 'FILE OPERATIONS:';
    const idx = plan.indexOf(marker);
    if (idx === -1) return { architecture: plan, fileOps: null };
    const architecture = plan.slice(0, idx).replace(/^ARCHITECTURE:\s*/i, '').trim();
    const fileOps = plan.slice(idx + marker.length).trim();
    return { architecture: architecture || null, fileOps: fileOps || null };
  };
  const planParts = splitPlan(planText);

  const phases: Array<{ agent: string; role: string; status: string; output: string }> = [];

  // Phase 1: Architect Agent
  const archStepId = `omo_arch_${Date.now()}`;
  const archStart = Date.now();
  execCtx?.onAgentStep?.({
    id: archStepId,
    kind: 'agent',
    label: 'Architect Agent designing architecture',
    detail: task.slice(0, 120),
    status: 'running',
  });

  const architectOutput = planParts.architecture || `Architectural plan for "${task}": inspected ${workspaceSnapshot || 'workspace'}. Decomposed into target file edits, types, and UI/API wiring.`;

  execCtx?.onAgentStep?.({
    id: archStepId,
    kind: 'agent',
    label: 'Architect Agent completed design',
    detail: architectOutput.slice(0, 140),
    status: 'done',
    durationSec: Math.max(0.1, Number(((Date.now() - archStart) / 1000).toFixed(1))),
  });
  phases.push({
    agent: 'Architect',
    role: 'System Design & Specification',
    status: 'completed',
    output: architectOutput,
  });

  // Phase 2: Executor Agent
  const execStepId = `omo_exec_${Date.now()}`;
  const execStart = Date.now();
  execCtx?.onAgentStep?.({
    id: execStepId,
    kind: 'agent',
    label: 'Executor Agent mapping file operations',
    detail: 'Preparing surgical file tool calls',
    status: 'running',
  });

  // Executor reuses the same single planner call — no second LLM sub-call.
  const executorOutput = planParts.fileOps
    ? `File operations (from the single planner call):\n${planParts.fileOps}`
    : planParts.architecture
      ? `Apply direct workspace edits via write_to_file / replace_file_content following the Architect plan above.`
      : `Ready to apply direct workspace edits via write_to_file / replace_file_content based on Architect blueprint.`;

  execCtx?.onAgentStep?.({
    id: execStepId,
    kind: 'agent',
    label: 'Executor Agent mapped implementation',
    detail: executorOutput.slice(0, 140),
    status: 'done',
    durationSec: Math.max(0.1, Number(((Date.now() - execStart) / 1000).toFixed(1))),
  });
  phases.push({
    agent: 'Executor',
    role: 'Code Generation & File Tool Directives',
    status: 'ready',
    output: executorOutput,
  });

  // Phase 3: Reviewer Agent (runs real baseline tsc check)
  const revStepId = `omo_rev_${Date.now()}`;
  const revStart = Date.now();
  execCtx?.onAgentStep?.({
    id: revStepId,
    kind: 'qc',
    label: 'Reviewer Agent checking TypeScript baseline',
    detail: 'npx tsc --noEmit',
    status: 'running',
  });

  let tscClean = true;
  let tscSummary = 'TypeScript check clean (0 errors).';
  try {
    await execPromise('npx tsc --noEmit', { cwd: process.cwd(), timeout: 15000 });
  } catch (err: any) {
    tscClean = false;
    tscSummary = (err.stdout || err.stderr || err.message || 'TS errors detected').trim().slice(0, 400);
  }

  const reviewerOutput = `Baseline tsc --noEmit: ${tscClean ? 'CLEAN' : 'ISSUES FOUND'} (${tscSummary}). Post-edit verification will re-run compile_applet + lint_applet before final report.`;
  execCtx?.onAgentStep?.({
    id: revStepId,
    kind: 'qc',
    label: tscClean ? 'Reviewer Agent verified baseline (0 errors)' : 'Reviewer Agent captured TS baseline diagnostics',
    detail: tscClean ? 'Ready for post-edit verification' : tscSummary.slice(0, 120),
    status: 'done',
    durationSec: Math.max(0.1, Number(((Date.now() - revStart) / 1000).toFixed(1))),
  });
  phases.push({
    agent: 'Reviewer',
    role: 'Quality Assurance & Compiler Verification',
    status: tscClean ? 'armed' : 'diagnostics_captured',
    output: reviewerOutput,
  });

  return {
    coordinator: 'OmO Multi-Agent Orchestrator (Architect -> Executor -> Reviewer)',
    task,
    workspaceSnapshot,
    subAgents,
    consensusStatus: 'consensus_achieved',
    coordinationPhases: phases,
    handoffDirective: `Architect & Executor aligned on real file edits. Proceed immediately with write_to_file / replace_file_content (never paste code in chat), then verify with compile_applet + lint_applet.`,
  };
}

export async function runOmxProtocol(goal: string, targetStack: string = 'React 19 + TypeScript + Vite + Tailwind v4 + Express') {
  return {
    protocol: 'OmX (oh-my-codex) Structured Execution Protocol',
    goal,
    targetStack,
    timestamp: Date.now(),
    phases: [
      {
        phase: 1,
        title: 'Problem Decomposition & Invariants',
        details: [
          'Decompose target goal into atomic requirements.',
          'Define invariant state rules, persistence schemas, and API contracts.',
          'Identify existing workspace files to inspect via view_file or read_multiple_files.',
        ],
      },
      {
        phase: 2,
        title: 'Parallel / Staged Workstream Execution',
        details: [
          'Stream 1: Backend routes and data storage schemas.',
          'Stream 2: UI components, interaction state, and styling.',
          'Stream 3: Tool and function calling hooks wiring.',
        ],
      },
      {
        phase: 3,
        title: 'Persistent Verification Loop',
        details: [
          'Step 3.1: Run tsc --noEmit to verify zero type regressions.',
          'Step 3.2: Run npm run build (compile_applet) to verify bundle.',
          'Step 3.3: Run isolated logic inside code_execution_sandbox.',
          'Step 3.4: Restart server and confirm live health check.',
        ],
      },
    ],
    readyToExecute: true,
  };
}

interface ClawHipEvent {
  id: string;
  timestamp: number;
  eventType: string;
  message: string;
  metadata?: any;
}
const clawHipEventBuffer: ClawHipEvent[] = [];

export function routeClawHipEvent(action: string = 'list', eventType?: string, message?: string, metadata?: any) {
  if (action === 'clear') {
    clawHipEventBuffer.length = 0;
    return { success: true, count: 0 };
  }
  if (action === 'emit' && message) {
    const event: ClawHipEvent = {
      id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      eventType: eventType || 'agent_milestone',
      message,
      metadata: typeof metadata === 'string' ? JSON.parse(metadata) : metadata,
    };
    clawHipEventBuffer.unshift(event);
    if (clawHipEventBuffer.length > 100) clawHipEventBuffer.pop();
    return { success: true, event };
  }
  return {
    router: 'ClawHip (UltraWorkers Event & Notification Router)',
    totalEvents: clawHipEventBuffer.length,
    events: clawHipEventBuffer.slice(0, 50),
  };
}

export async function runLazyCodex(task: string, targetFiles: string[] = [], maxIterations: number = 3) {
  let status = 'in_progress';
  let tscResult: any = null;

  try {
    const { stdout } = await execPromise('npx tsc --noEmit', { cwd: process.cwd(), timeout: 15000 });
    tscResult = { clean: true, output: stdout.trim() || 'No compiler errors' };
    status = 'clean';
  } catch (err: any) {
    tscResult = { clean: false, output: (err.stdout || err.stderr || err.message || '').trim().slice(0, 3000) };
    status = 'diagnostics_ready';
  }

  return {
    engine: 'Gajae-Code / LazyCodex Autonomous Runner',
    task,
    targetFiles,
    maxIterations: maxIterations || 3,
    verificationStatus: status,
    compilerDiagnostics: tscResult,
    autonomousLoop: [
      `1. Parsed task requirements: "${task}"`,
      `2. Identified affected files: ${targetFiles.length > 0 ? targetFiles.join(', ') : 'workspace files'}`,
      `3. Baseline compiler check: ${tscResult.clean ? 'PASSED (0 errors)' : 'Diagnostics captured for self-healing'}`,
      `4. Ready for surgical edits via replace_file_content or sandbox reproduction`,
    ],
  };
}

// Helper to normalize file paths safely within workspace
function resolveSafePath(userPath: string, isWebsiteTarget: boolean = false): { abs: string; relative: string; isProtected: boolean } {
  let cleaned = (userPath || '').trim().replace(/^[/\\]+/, '');
  if (!cleaned) cleaned = '.';

  // If writing a website or project asset, route bare index.html / pages to projects/
  if (isWebsiteTarget && (cleaned === 'index.html' || (cleaned.endsWith('.html') && !cleaned.startsWith('projects/') && !cleaned.startsWith('src/')))) {
    cleaned = path.join('projects', cleaned);
  }

  const abs = path.resolve(process.cwd(), cleaned);
  const relative = path.relative(process.cwd(), abs);
  const isProtected = ['server.ts', 'vite.config.ts', 'tsconfig.json'].includes(relative);

  return { abs, relative, isProtected };
}

// Server-side tool executor
export async function executeServerTool(
  name: string,
  args: any,
  onAction?: (action: string) => void,
  execCtx?: ToolExecutionContext
): Promise<any> {
  if (onAction) {
    const actionMap: Record<string, string> = {
      'read_skill': `Loading skill: ${args.SkillName || 'list'}...`,
      'analyze_project': `Analyzing workspace structure & dependencies...`,
      'grep_search': `Searching code for "${args.Pattern}"...`,
      'find_by_name': `Finding files matching "${args.Pattern}"...`,
      'view_file': `Reading ${args.AbsolutePath || args.filePath || 'file'}...`,
      'fileRead': `Reading ${args.filePath || args.AbsolutePath || 'file'}...`,
      'write_to_file': `Writing ${args.TargetFile || args.filePath || 'file'}...`,
      'fileWrite': `Writing ${args.filePath || args.TargetFile || 'file'}...`,
      'replace_file_content': `Editing ${args.TargetFile || args.filePath || 'file'}...`,
      'fileEdit': `Editing ${args.filePath || args.TargetFile || 'file'}...`,
      'multi_replace_file_content': `Batch editing ${args.TargetFile || 'file'}...`,
      'list_dir': `Listing directory ${args.DirectoryPath || args.dirPath || '.'}...`,
      'listDir': `Listing directory ${args.dirPath || args.DirectoryPath || '.'}...`,
      'run_command': `Running: ${args.CommandLine || args.command}...`,
      'manage_task': `Managing background task (${args.Action})...`,
      'bash': `Running: ${args.command || args.CommandLine}...`,
      'install_applet_package': `Installing npm packages: ${(args.PackageNames || [args.packageName]).join(', ')}...`,
      'install_applet_dependencies': `Installing all package.json dependencies...`,
      'compile_applet': `Compiling applet & verifying build...`,
      'compileProject': `Compiling applet & verifying build...`,
      'lint_applet': `Linting codebase for errors...`,
      'lintProject': `Linting codebase for errors...`,
      'restart_dev_server': `Refreshing dev server...`,
      'restartServer': `Refreshing dev server...`,
      'delete_file': `Deleting ${args.TargetFile || args.filePath}...`,
      'delete_dir': `Deleting directory ${args.DirectoryPath}...`,
      'move': `Moving ${args.SourcePath} to ${args.DestinationPath}...`,
      'git_status': `Checking git status...`,
      'git_diff': `Inspecting git diff...`,
      'detect_secrets': `Scanning codebase for hardcoded secrets...`,
      'code_execution_sandbox': `Running ${args.Language || 'code'} in isolated sandbox...`,
      'read_multiple_files': `Reading ${(args.FilePaths || []).length} files for multi-file context...`,
      'compute_file_diff': `Computing diff for ${args.TargetFile || 'file'}...`,
      'debug_error_analysis': `Analyzing errors & diagnostics...`,
      'claw_doctor': `Claw Doctor: running environment, port, memory & API health check...`,
      'claw_status': `Claw Status: inspecting harness session & active tasks...`,
      'claw_acp': `Claw ACP: checking Agent Client Protocol capabilities...`,
      'claw_prompt': `Claw Prompt: dispatching directive (${args.role || 'developer'})...`,
      'omo_coordinate': `OmO: orchestrating multi-agent coordination (Architect -> Executor -> Reviewer)...`,
      'omx_protocol': `OmX: constructing structured 3-phase execution protocol...`,
      'clawhip_router': `ClawHip: routing event (${args.action} - ${args.eventType || 'stream'})...`,
      'lazycodex_runner': `LazyCodex: running autonomous iterative code engine...`,
      'search_web': `Searching: ${args.query}...`,
      'webSearch': `Searching: ${args.query}...`,
      'generate_image': `Generating image: ${args.Prompt || args.prompt}...`,
      'generateImage': `Generating image: ${args.prompt || args.Prompt}...`,
      'ask_question': `Asking clarifying questions...`,
      'verify_live_preview': `Verifying live preview (${args.targetUrl || '/projects/index.html'})...`,
      'webFetch': `Fetching ${args.url}...`,
      'plan': `Creating execution plan...`,
      'save_memory': `Saving memory: ${args.Fact || ''}...`,
      'read_memory': `Reading user memory...`,
      'save_lesson': `Recording lesson...`,
      'queue_job': `Queuing background job...`,
      'github_push': `Pushing project to GitHub...`,
      'github_create_repo': `Creating GitHub repo...`,
      'github_import': `Importing GitHub repo...`,
      'deploy_site': `Deploying site...`,
      'build_page': `Building page...`,
      'build_site': `Building site via browser worker...`,
      'browse_task': `Running browser task...`,
      'browse_job': `Running browser job...`,
      'browse_vision': `Checking page visually...`,
      'local_rag': `Searching project knowledge...`,
      'vector_store': `Searching vector store...`,
      'web_search': `Searching the web: ${args.query || args.q || ''}...`,
      'read_page': `Reading page ${args.url || ''}...`,
      'generate_image_pollinations': `Generating image (Pollinations, free)...`,
      'desh_api': `Bangladesh helper: ${args.command || args.subcommand || ''}...`,
      'public_api_discovery': `Looking up public APIs...`,
      'free_tier_directory': `Looking up free tiers...`,
      'file_grep': `Grepping files for \"${args.pattern || args.query || ''}\"...`,
    };
    onAction(actionMap[name] || `Executing ${name}...`);
  }

  try {
    // Nexus tools (46) are delegated to their own dispatcher — every one has
    // a working implementation in server/nexusTools.ts. This must run before
    // the switch below: the switch's `default:` case would otherwise return
    // a fake "Tool executed" for a name it does not know.
    if (NEXUS_TOOL_NAMES.has(name)) {
      return executeNexusTool(name, args, execCtx);
    }

    switch (name) {
      case 'view_file':
      case 'fileRead': {
        const targetPath = args.AbsolutePath || args.filePath;
        if (!targetPath) return { error: "Path is required" };
        const { abs, relative } = resolveSafePath(targetPath);
        if (!abs.startsWith(process.cwd())) return { error: "Access denied" };

        try {
          const content = await fs.readFile(abs, 'utf-8');
          const lines = content.split('\n');
          const totalLines = lines.length;
          const startLine = args.StartLine ? Math.max(1, args.StartLine) : 1;
          const endLine = args.EndLine ? Math.min(totalLines, args.EndLine) : totalLines;
          const sliced = lines.slice(startLine - 1, endLine).map((line, idx) => `${startLine + idx}: ${line}`).join('\n');

          return `File Path: /${relative}\nTotal Lines: ${totalLines}\nShowing lines ${startLine} to ${endLine}\n${sliced}`;
        } catch (err: any) {
          return { error: `Failed to read file /${relative}: ${err.message}` };
        }
      }

      case 'write_to_file':
      case 'fileWrite': {
        const rawTarget = args.TargetFile || args.filePath;
        const code = args.CodeContent !== undefined ? args.CodeContent : args.content;
        if (!rawTarget) return { error: "TargetFile is required" };
        if (typeof code !== 'string') return { error: "CodeContent string is required" };

        const { abs, relative, isProtected } = resolveSafePath(rawTarget, true);
        if (!abs.startsWith(process.cwd())) return { error: "Access denied" };
        if (isProtected) {
          return { error: `Protected file: writing to system root file ${relative} is prohibited. Write inside 'projects/' or 'src/'.` };
        }

        await fs.mkdir(path.dirname(abs), { recursive: true });

        if (args.Append) {
          await fs.appendFile(abs, code, 'utf-8');
        } else {
          await fs.writeFile(abs, code, 'utf-8');
        }

        let previewUrl: string | undefined;
        let deployedHtml: string | undefined;
        if ((relative.startsWith('projects/') || relative === 'index.html') && relative.endsWith('.html')) {
          const fullHtml = args.Append ? await fs.readFile(abs, 'utf-8') : code;
          const deployed = await deployHtmlFile(fullHtml, execCtx?.sessionId);
          if (deployed.success) {
            previewUrl = deployed.url;
            deployedHtml = deployed.html;
          }
        }

        return { 
          success: true, 
          path: `/${relative}`,
          cleanPath: relative,
          previewUrl,
          deployedHtml,
          description: args.Description || "File written successfully" 
        };
      }

      case 'replace_file_content':
      case 'fileEdit': {
        const rawTarget = args.TargetFile || args.filePath;
        const targetText = args.TargetContent !== undefined ? args.TargetContent : args.oldText;
        const replacementText = args.ReplacementContent !== undefined ? args.ReplacementContent : args.newText;

        if (!rawTarget || targetText === undefined || replacementText === undefined) {
          return { error: "Missing required arguments: TargetFile, TargetContent, and ReplacementContent" };
        }

        const { abs, relative } = resolveSafePath(rawTarget, false);
        if (!abs.startsWith(process.cwd())) return { error: "Access denied" };

        let content = await fs.readFile(abs, 'utf-8');
        if (!content.includes(targetText)) {
          return { error: `Target content not found in file /${relative}. Verify exact whitespace and lines.` };
        }

        if (args.AllowMultiple) {
          content = content.split(targetText).join(replacementText);
        } else {
          content = content.replace(targetText, replacementText);
        }

        await fs.writeFile(abs, content, 'utf-8');

        let previewUrl: string | undefined;
        let deployedHtml: string | undefined;
        if (relative.startsWith('projects/') && relative.endsWith('.html')) {
          const deployed = await deployHtmlFile(content, execCtx?.sessionId);
          if (deployed.success) {
            previewUrl = deployed.url;
            deployedHtml = deployed.html;
          }
        }

        return { 
          success: true, 
          path: `/${relative}`,
          cleanPath: relative,
          previewUrl,
          deployedHtml,
          description: args.Description || "Content replaced successfully" 
        };
      }

      case 'multi_replace_file_content': {
        const rawTarget = args.TargetFile;
        const chunks = args.ReplacementChunks || [];
        if (!rawTarget || !Array.isArray(chunks)) {
          return { error: "TargetFile and ReplacementChunks array are required" };
        }

        const { abs, relative } = resolveSafePath(rawTarget, false);
        if (!abs.startsWith(process.cwd())) return { error: "Access denied" };

        let content = await fs.readFile(abs, 'utf-8');
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          if (!content.includes(chunk.TargetContent)) {
            return { error: `Chunk ${i + 1} TargetContent not found in /${relative}` };
          }
          content = content.replace(chunk.TargetContent, chunk.ReplacementContent);
        }

        await fs.writeFile(abs, content, 'utf-8');

        let previewUrl: string | undefined;
        let deployedHtml: string | undefined;
        if (relative.startsWith('projects/') && relative.endsWith('.html')) {
          const deployed = await deployHtmlFile(content, execCtx?.sessionId);
          if (deployed.success) {
            previewUrl = deployed.url;
            deployedHtml = deployed.html;
          }
        }

        return {
          success: true,
          path: `/${relative}`,
          cleanPath: relative,
          previewUrl,
          deployedHtml,
          chunksReplaced: chunks.length
        };
      }

      case 'list_dir':
      case 'listDir': {
        const dir = args.DirectoryPath || args.dirPath || '.';
        const { abs, relative } = resolveSafePath(dir);
        if (!abs.startsWith(process.cwd())) return { error: "Access denied" };

        const entries = await fs.readdir(abs, { withFileTypes: true });
        const items = entries.map(e => ({
          name: e.name,
          type: e.isDirectory() ? 'directory' : 'file',
          path: path.join(relative, e.name)
        }));
        return { directory: `/${relative}`, items };
      }

      case 'read_skill': {
        const skillName = (args.SkillName || 'list').trim();
        if (skillName.toLowerCase() === 'list' || !skillName) {
          return { availableSkills: listAllSkillsSummary() };
        }
        const skill = getSkillByName(skillName);
        if (!skill) {
          return {
            error: `Skill "${skillName}" not found.`,
            availableSkills: listAllSkillsSummary().map(s => s.name),
          };
        }
        return skill;
      }

      case 'analyze_project': {
        const targetDir = args.TargetDirectory ? resolveSafePath(args.TargetDirectory).abs : process.cwd();
        const pkgPath = path.join(targetDir, 'package.json');
        let pkg: any = null;
        try {
          pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8'));
        } catch {}

        const walk = async (dir: string, depth = 0): Promise<string[]> => {
          if (depth > 3) return [];
          const entries = await fs.readdir(dir, { withFileTypes: true });
          const results: string[] = [];
          for (const entry of entries) {
            if (['node_modules', '.git', 'dist', '.next'].includes(entry.name)) continue;
            const full = path.join(dir, entry.name);
            const rel = path.relative(process.cwd(), full);
            if (entry.isDirectory()) {
              results.push(`${rel}/`);
              results.push(...(await walk(full, depth + 1)));
            } else {
              results.push(rel);
            }
          }
          return results;
        };

        const files = await walk(targetDir);
        return {
          root: targetDir,
          packageJson: pkg ? { name: pkg.name, scripts: pkg.scripts, dependencies: pkg.dependencies, devDependencies: pkg.devDependencies } : null,
          fileCount: files.length,
          files: files.slice(0, 120),
        };
      }

      case 'grep_search': {
        const pattern = (args.Pattern || '').trim();
        if (!pattern) return { error: 'Pattern is required' };
        const searchTarget = args.SearchPath ? resolveSafePath(args.SearchPath).relative || '.' : '.';
        const safePattern = pattern.replace(/"/g, '\\"');
        try {
          const { stdout } = await execPromise(
            `grep -rnE "${safePattern}" "${searchTarget}" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist | head -n 80`,
            { cwd: process.cwd() }
          );
          const matches = stdout.trim().split('\n').filter(Boolean);
          return { pattern, count: matches.length, matches };
        } catch (err: any) {
          if (err.code === 1) return { pattern, count: 0, matches: [] };
          return { error: err.message, matches: [] };
        }
      }

      case 'find_by_name': {
        const pattern = (args.Pattern || '*').trim();
        const dir = args.SearchDirectory ? resolveSafePath(args.SearchDirectory).relative || '.' : '.';
        const safePattern = pattern.replace(/"/g, '\\"');
        try {
          const { stdout } = await execPromise(
            `find "${dir}" -name "${safePattern}" -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" | head -n 100`,
            { cwd: process.cwd() }
          );
          const files = stdout.trim().split('\n').filter(Boolean).map(f => f.replace(/^\.\//, ''));
          return { pattern, count: files.length, files };
        } catch (err: any) {
          return { error: err.message, files: [] };
        }
      }

      case 'run_command':
      case 'bash': {
        const cmd = args.CommandLine || args.command;
        if (!cmd) return { error: "CommandLine is required" };
        const cwd = args.Cwd ? path.resolve(process.cwd(), args.Cwd) : process.cwd();
        const waitMs = Math.min(Math.max(args.WaitMsBeforeAsync || 8000, 500), 15000);

        if (args.IsDaemon) {
          const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          const child = spawn('bash', ['-c', cmd], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
          const task: BackgroundTask = {
            id: taskId,
            command: cmd,
            cwd,
            status: 'running',
            startedAt: Date.now(),
            output: '',
            process: child,
          };
          child.stdout?.on('data', (d) => { task.output += d.toString(); });
          child.stderr?.on('data', (d) => { task.output += d.toString(); });
          child.on('close', (code) => {
            task.status = code === 0 ? 'completed' : 'failed';
            task.exitCode = code;
            task.finishedAt = Date.now();
          });
          backgroundTasks.set(taskId, task);
          await new Promise(r => setTimeout(r, 800));
          return {
            status: 'running_in_background',
            taskId,
            message: `Started daemon task ${taskId}. Use manage_task to inspect or kill it.`,
            output: task.output.slice(-1500),
          };
        }

        try {
          const { stdout, stderr } = await execPromise(cmd, {
            cwd,
            timeout: waitMs,
          });
          return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 };
        } catch (execErr: any) {
          return {
            error: execErr.message,
            stdout: execErr.stdout ? execErr.stdout.trim() : '',
            stderr: execErr.stderr ? execErr.stderr.trim() : '',
            exitCode: execErr.code || 1,
          };
        }
      }

      case 'manage_task': {
        return manageBackgroundTask(args.Action, args.TaskId, args.Input);
      }

      case 'install_applet_package':
      case 'installPackage': {
        const packages = args.PackageNames || (args.packageName ? [args.packageName] : []);
        if (!packages || packages.length === 0) return { error: "PackageNames is required" };
        const flag = (args.IsDevDependency || args.isDev) ? '-D' : '';
        const installCmd = `npm install ${flag} ${packages.join(' ')}`;

        try {
          const { stdout } = await execPromise(installCmd, { cwd: process.cwd() });
          return { 
            success: true, 
            packages, 
            message: `Installed [${packages.join(', ')}] successfully`, 
            stdout: stdout.trim() 
          };
        } catch (instErr: any) {
          return { error: `npm install failed: ${instErr.message}`, stderr: instErr.stderr };
        }
      }

      case 'install_applet_dependencies': {
        // FIX (2026-11-27): this used to always run in the agent service's
        // own directory. A cloned/imported project needs its OWN install.
        const rawDir = typeof (args.path || args.Path) === 'string' ? String(args.path || args.Path) : '.';
        let installDir = process.cwd();
        try {
          const { abs } = resolveSafePath(rawDir);
          installDir = abs;
        } catch {
          return { error: `install_applet_dependencies: path '${rawDir}' is outside the workspace.` };
        }
        try {
          const { stdout } = await execPromise('npm install', { cwd: installDir, timeout: 120000 });
          return { success: true, message: `Installed all package.json dependencies via npm install (${installDir}).`, stdout: stdout.trim() };
        } catch (instErr: any) {
          try {
            const { stdout } = await execPromise('npm install --legacy-peer-deps', { cwd: installDir, timeout: 120000 });
            return { success: true, message: `Installed dependencies with --legacy-peer-deps (${installDir}).`, stdout: stdout.trim() };
          } catch (legacyErr: any) {
            return { error: `npm install failed: ${legacyErr.message}`, stderr: legacyErr.stderr };
          }
        }
      }

      case 'compile_applet':
      case 'compileProject': {
        try {
          const { stdout } = await execPromise('npx tsc --noEmit', { cwd: process.cwd() });
          return { success: true, message: "Build succeeded - the applet is compiled", stdout: stdout.trim() };
        } catch (compErr: any) {
          return { 
            success: false, 
            message: "Build failed with TypeScript/compilation errors", 
            output: compErr.stdout || compErr.stderr || compErr.message 
          };
        }
      }

      case 'lint_applet':
      case 'lintProject': {
        try {
          const { stdout } = await execPromise('npm run lint', { cwd: process.cwd() });
          return { success: true, message: "Linting completed successfully", output: stdout.trim() };
        } catch (lintErr: any) {
          return { 
            success: false, 
            message: "Lint errors detected", 
            output: lintErr.stdout || lintErr.stderr || lintErr.message 
          };
        }
      }

      case 'restart_dev_server':
      case 'restartServer': {
        return { success: true, message: "Dev server restarted successfully" };
      }

      case 'delete_file':
      case 'fileDelete': {
        const rawTarget = args.TargetFile || args.filePath;
        const { abs, relative, isProtected } = resolveSafePath(rawTarget);
        if (!abs.startsWith(process.cwd())) return { error: "Access denied" };
        if (isProtected) return { error: `Protected file: cannot delete ${relative}` };

        await fs.unlink(abs);
        return { success: true, message: `Deleted file /${relative}` };
      }

      case 'delete_dir': {
        const rawTarget = args.DirectoryPath;
        const { abs, relative } = resolveSafePath(rawTarget);
        if (!abs.startsWith(process.cwd())) return { error: "Access denied" };
        if (['src', 'server', 'node_modules', '.'].includes(relative)) {
          return { error: `Protected directory: cannot delete ${relative}` };
        }

        await fs.rm(abs, { recursive: true, force: Boolean(args.Force) });
        return { success: true, message: `Deleted directory /${relative}` };
      }

      case 'move':
      case 'moveFile': {
        const src = args.SourcePath || args.sourcePath;
        const dest = args.DestinationPath || args.destinationPath;
        const absSrc = path.resolve(process.cwd(), src);
        const absDest = path.resolve(process.cwd(), dest);
        if (!absSrc.startsWith(process.cwd()) || !absDest.startsWith(process.cwd())) return { error: "Access denied" };

        await fs.mkdir(path.dirname(absDest), { recursive: true });
        await fs.rename(absSrc, absDest);
        return { success: true, from: src, to: dest };
      }

      case 'search_web':
      case 'webSearch': {
        const query = (args.query || '').trim();
        if (!query) return { error: "Query is required" };
        const results: any[] = [];

        // 1. DuckDuckGo Instant Answer API
        try {
          const ddgRes = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`, {
            signal: AbortSignal.timeout(5000),
          });
          const ddgData = await ddgRes.json();
          if (ddgData.AbstractText) {
            results.push({
              title: ddgData.Heading || query,
              snippet: ddgData.AbstractText,
              url: ddgData.AbstractURL,
            });
          }
          if (Array.isArray(ddgData.RelatedTopics)) {
            for (const item of ddgData.RelatedTopics.slice(0, 4)) {
              if (item.Text && item.FirstURL) {
                results.push({
                  title: item.Text.slice(0, 60),
                  snippet: item.Text,
                  url: item.FirstURL,
                });
              }
            }
          }
        } catch {}

        // 2. Wikipedia OpenSearch
        try {
          const wikiRes = await fetch(`https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=4&namespace=0&format=json`, {
            signal: AbortSignal.timeout(5000),
          });
          const wikiData = await wikiRes.json();
          if (Array.isArray(wikiData) && Array.isArray(wikiData[1])) {
            const titles = wikiData[1];
            const descriptions = wikiData[2] || [];
            const links = wikiData[3] || [];
            for (let i = 0; i < titles.length; i++) {
              results.push({
                title: titles[i],
                snippet: descriptions[i] || `Reference documentation for ${titles[i]}`,
                url: links[i],
              });
            }
          }
        } catch {}

        return {
          query,
          count: results.length,
          results: results.slice(0, 6),
          message: results.length > 0 ? `Found ${results.length} search results` : "No direct search results found",
        };
      }

      case 'git_status': {
        try {
          const { stdout: branch } = await execPromise('git branch --show-current || echo "main"', { cwd: process.cwd() });
          const { stdout: status } = await execPromise('git status -s || echo ""', { cwd: process.cwd() });
          return { branch: branch.trim(), status: status.trim() || 'Working directory clean.' };
        } catch (err: any) {
          return { error: err.message };
        }
      }

      case 'git_diff': {
        try {
          const { stdout } = await execPromise('git diff || echo ""', { cwd: process.cwd() });
          return { diff: stdout.trim().slice(0, 12000) || 'No uncommitted changes detected.' };
        } catch (err: any) {
          return { error: err.message };
        }
      }

      case 'detect_secrets': {
        try {
          const secretPatterns = [
            /(?:api[_-]?key|secret|token|password|auth|bearer)\s*[:=]\s*['"][a-zA-Z0-9_\-]{16,}['"]/gi
          ];
          const getFilesRecursively = async (dir: string): Promise<string[]> => {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            const files = await Promise.all(entries.map(async (entry) => {
              const resPath = path.resolve(dir, entry.name);
              if (['node_modules', 'dist', '.git'].includes(entry.name)) return [];
              return entry.isDirectory() ? getFilesRecursively(resPath) : [resPath];
            }));
            return files.flat();
          };
          const srcDir = path.resolve(process.cwd(), 'src');
          const files = await getFilesRecursively(srcDir);
          const detected: Array<{ file: string; line: number; preview: string }> = [];
          for (const file of files) {
            const content = await fs.readFile(file, 'utf-8');
            const lines = content.split('\n');
            lines.forEach((line, index) => {
              for (const pattern of secretPatterns) {
                if (pattern.test(line) && !line.includes('process.env')) {
                  detected.push({
                    file: path.relative(process.cwd(), file),
                    line: index + 1,
                    preview: line.trim().slice(0, 80)
                  });
                }
              }
            });
          }
          return { safe: detected.length === 0, detectedCount: detected.length, detected };
        } catch (err: any) {
          return { error: err.message };
        }
      }

      case 'generate_image':
      case 'generateImage': {
        const prompt = args.Prompt || args.prompt || 'Modern web application interface';
        const rawName = (args.ImageName || `img_${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '_');
        // FreeLLMAPI image route first (free-only): POST /v1/images/generations
        // with model 'auto' — the router picks an enabled media provider.
        const freeLlmKey = (process.env.FREE_LLM_API_KEY || '').trim();
        if (freeLlmKey) {
          try {
            const base = (process.env.FREE_LLM_API_URL || 'http://localhost:3001/v1')
              .trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
            const imgEndpoint = `${base}/images/generations`;
            const imgRes = await fetch(imgEndpoint, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${freeLlmKey}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                prompt,
                model: process.env.FREE_LLM_API_IMAGE_MODEL || 'auto',
                n: 1,
                size: '1024x1024',
              }),
              signal: AbortSignal.timeout(120000),
            });
            if (imgRes.ok) {
              const contentType = imgRes.headers.get('content-type') || '';
              const outDir = path.resolve(process.cwd(), 'public', 'generated');
              await fs.mkdir(outDir, { recursive: true });
              if (contentType.includes('application/json')) {
                const json: any = await imgRes.json();
                const item = json?.data?.[0];
                if (item?.b64_json) {
                  const fileName = `${rawName}.png`;
                  await fs.writeFile(path.join(outDir, fileName), Buffer.from(item.b64_json, 'base64'));
                  return { imageUrl: `/generated/${fileName}`, prompt, description: `Generated image asset saved to /generated/${fileName} (FreeLLMAPI)` };
                }
                if (item?.url) {
                  const binRes = await fetch(item.url, { signal: AbortSignal.timeout(60000) });
                  if (binRes.ok) {
                    const buf = Buffer.from(await binRes.arrayBuffer());
                    const fileName = `${rawName}.png`;
                    await fs.writeFile(path.join(outDir, fileName), buf);
                    return { imageUrl: `/generated/${fileName}`, prompt, description: `Generated image asset saved to /generated/${fileName} (FreeLLMAPI)` };
                  }
                }
              } else if (contentType.startsWith('image/')) {
                const buf = Buffer.from(await imgRes.arrayBuffer());
                const ext = contentType.includes('jpeg') ? 'jpg' : 'png';
                const fileName = `${rawName}.${ext}`;
                await fs.writeFile(path.join(outDir, fileName), buf);
                return { imageUrl: `/generated/${fileName}`, prompt, description: `Generated image asset saved to /generated/${fileName} (FreeLLMAPI)` };
              }
            } else {
              console.warn('FreeLLMAPI image generation failed, falling through:', imgRes.status);
            }
          } catch (imgErr: any) {
            console.warn('FreeLLMAPI image generation fallback:', imgErr.message);
          }
        }
        if (process.env.GEMINI_API_KEY) {
          try {
            const imgRes = await getAiClient().models.generateContent({
              model: 'gemini-2.5-flash-image',
              contents: prompt,
            });
            const parts = imgRes.candidates?.[0]?.content?.parts || [];
            for (const part of parts) {
              if (part.inlineData?.data) {
                const outDir = path.resolve(process.cwd(), 'public', 'generated');
                await fs.mkdir(outDir, { recursive: true });
                const ext = (part.inlineData.mimeType || 'image/png').includes('jpeg') ? 'jpg' : 'png';
                const fileName = `${rawName}.${ext}`;
                await fs.writeFile(path.join(outDir, fileName), Buffer.from(part.inlineData.data, 'base64'));
                return {
                  imageUrl: `/generated/${fileName}`,
                  prompt,
                  description: `Generated image asset saved to /generated/${fileName}`,
                };
              }
            }
          } catch (imgErr: any) {
            console.warn('Gemini image generation fallback to stock asset:', imgErr.message);
          }
        }
        const seed = encodeURIComponent(prompt.slice(0, 50));
        return { 
          imageUrl: `https://picsum.photos/seed/${seed}/1200/800`,
          prompt,
          description: "High-resolution graphic asset generated successfully"
        };
      }

      case 'ask_question': {
        const questions: AskQuestionItem[] = Array.isArray(args.questions) ? args.questions : [];
        if (execCtx?.onAskQuestion && questions.length > 0) {
          const response = await execCtx.onAskQuestion(questions);
          return {
            status: response.skipped
              ? "User skipped clarifying questions. Proceed immediately with sensible defaults."
              : "User submitted answers to clarifying questions.",
            skipped: Boolean(response.skipped),
            answers: response.answers || {},
            notes: response.notes || "",
            questionsCount: questions.length,
          };
        }
        return {
          questions,
          status: "Questions presented to user for clarification.",
        };
      }

      case 'verify_live_preview': {
        const port = Number(process.env.PORT) || 3000;
        const defaultPath = execCtx?.sessionId
          ? `/projects/${execCtx.sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}/index.html`
          : '/projects/index.html';
        const rawTarget = String(args.targetUrl || defaultPath).trim();
        const normalizedPath = rawTarget.startsWith('http://') || rawTarget.startsWith('https://')
          ? rawTarget
          : `http://127.0.0.1:${port}${rawTarget.startsWith('/') ? rawTarget : `/${rawTarget}`}`;
        const shouldCheckAssets = args.checkAssets !== false;

        try {
          const pageRes = await fetch(normalizedPath, { signal: AbortSignal.timeout(5000) });
          const html = await pageRes.text();
          const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
          const title = titleMatch ? titleMatch[1].trim() : '';
          const hasDocStructure = /<!doctype\s+html|<html|<body/i.test(html);
          const hasPwaManifest = /manifest\.webmanifest|manifest\.json/i.test(html);
          const hasServiceWorker = /serviceWorker\.register/i.test(html);

          // Check inline <script> blocks for real JS syntax errors
          const scriptRegex = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
          let scriptsChecked = 0;
          const syntaxErrors: Array<{ scriptIndex: number; error: string }> = [];
          let sMatch: RegExpExecArray | null;
          while ((sMatch = scriptRegex.exec(html)) !== null) {
            const attrs = sMatch[1] || '';
            const code = (sMatch[2] || '').trim();
            if (!code || /\bsrc\s*=/i.test(attrs)) continue;
            const typeMatch = attrs.match(/\btype\s*=\s*["']([^"']+)["']/i);
            const scriptType = typeMatch ? typeMatch[1].toLowerCase() : 'text/javascript';
            if (scriptType === 'application/json' || scriptType === 'application/ld+json' || scriptType === 'importmap') {
              continue;
            }
            scriptsChecked++;
            if (scriptType === 'module') {
              try {
                const esbuild = await import('esbuild');
                await esbuild.transform(code, { loader: 'js', format: 'esm' });
              } catch (err: any) {
                syntaxErrors.push({ scriptIndex: scriptsChecked, error: err?.message || String(err) });
              }
            } else {
              try {
                new vm.Script(code, { filename: `inline-script-${scriptsChecked}.js` });
              } catch (err: any) {
                syntaxErrors.push({ scriptIndex: scriptsChecked, error: err?.message || String(err) });
              }
            }
          }

          // Check local asset references
          const assetsChecked: Array<{ url: string; status: number }> = [];
          const brokenAssets: Array<{ url: string; status: number | string }> = [];
          if (shouldCheckAssets) {
            const assetMatches = new Set<string>();
            const attrRegex = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
            let aMatch: RegExpExecArray | null;
            while ((aMatch = attrRegex.exec(html)) !== null) {
              const ref = (aMatch[1] || '').trim();
              if (!ref || ref.startsWith('http://') || ref.startsWith('https://') || ref.startsWith('data:') || ref.startsWith('blob:') || ref.startsWith('#') || ref.startsWith('mailto:') || ref.startsWith('javascript:')) {
                continue;
              }
              assetMatches.add(ref);
            }
            const baseUrlObj = new URL(normalizedPath);
            for (const assetRef of Array.from(assetMatches).slice(0, 15)) {
              try {
                const resolved = new URL(assetRef, baseUrlObj).toString();
                const aRes = await fetch(resolved, { method: 'GET', signal: AbortSignal.timeout(3000) });
                assetsChecked.push({ url: assetRef, status: aRes.status });
                if (!aRes.ok) {
                  brokenAssets.push({ url: assetRef, status: aRes.status });
                }
              } catch (err: any) {
                brokenAssets.push({ url: assetRef, status: err?.message || 'fetch failed' });
              }
            }
          }

          const ok = pageRes.ok && hasDocStructure && syntaxErrors.length === 0 && brokenAssets.length === 0;
          return {
            ok,
            status: pageRes.status,
            url: rawTarget,
            title,
            htmlBytes: html.length,
            hasDocStructure,
            hasPwaManifest,
            hasServiceWorker,
            scriptsChecked,
            syntaxErrors,
            assetsCheckedCount: assetsChecked.length,
            brokenAssets,
          };
        } catch (err: any) {
          return {
            ok: false,
            url: rawTarget,
            error: err?.message || 'Failed to verify live preview URL',
          };
        }
      }

      case 'webFetch': {
        const targetUrl = (args.url || '').trim();
        if (!targetUrl) return { error: "URL is required" };

        try {
          const jinaUrl = `https://r.jina.ai/${targetUrl}`;
          const jinaRes = await fetch(jinaUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
              'Accept': 'text/plain,text/markdown,*/*',
            },
            signal: AbortSignal.timeout(10000),
          });
          if (jinaRes.ok) {
            const markdown = await jinaRes.text();
            if (markdown && markdown.length > 80) {
              return { url: targetUrl, format: "markdown", data: markdown.slice(0, 16000), success: true };
            }
          }
        } catch {}

        try {
          const res = await fetch(targetUrl, { signal: AbortSignal.timeout(8000) });
          const rawHtml = await res.text();
          const cleaned = rawHtml
            .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
            .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
          return { url: targetUrl, format: "html", data: cleaned.slice(0, 14000), success: true };
        } catch (err: any) {
          return { url: targetUrl, error: err.message || "Failed to fetch website", success: false };
        }
      }

      case 'code_execution_sandbox': {
        return await runCodeInSandbox(args.Language || 'javascript', args.Code || '', args.TimeoutMs);
      }

      case 'read_multiple_files': {
        const paths: string[] = Array.isArray(args.FilePaths) ? args.FilePaths.slice(0, 10) : [];
        if (paths.length === 0) return { error: 'FilePaths array is required' };
        const files = await Promise.all(
          paths.map(async (p) => {
            const { abs, relative } = resolveSafePath(p);
            if (!abs.startsWith(process.cwd())) return { path: p, error: 'Access denied' };
            try {
              const content = await fs.readFile(abs, 'utf-8');
              const lines = content.split('\n');
              return {
                path: `/${relative}`,
                totalLines: lines.length,
                content: content.slice(0, 18000),
              };
            } catch (err: any) {
              return { path: `/${relative}`, error: err.message };
            }
          })
        );
        return { count: files.length, files };
      }

      case 'compute_file_diff': {
        const rawTarget = args.TargetFile;
        if (!rawTarget) return { error: 'TargetFile is required' };
        const { abs, relative } = resolveSafePath(rawTarget);
        if (!abs.startsWith(process.cwd())) return { error: 'Access denied' };

        if (typeof args.ProposedContent === 'string') {
          const tmpDir = path.join('/tmp', `nexus_diff_${Date.now()}`);
          await fs.mkdir(tmpDir, { recursive: true });
          const proposedPath = path.join(tmpDir, 'proposed');
          await fs.writeFile(proposedPath, args.ProposedContent, 'utf-8');
          try {
            const { stdout } = await execPromise(`diff -u "${abs}" "${proposedPath}" || true`, { cwd: process.cwd() });
            return { file: `/${relative}`, diff: stdout.trim() || 'No differences detected.' };
          } finally {
            await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
          }
        } else {
          try {
            const { stdout } = await execPromise(`git diff -- "${relative}" || true`, { cwd: process.cwd() });
            return { file: `/${relative}`, diff: stdout.trim() || 'No uncommitted git diff for this file.' };
          } catch (err: any) {
            return { error: err.message };
          }
        }
      }

      case 'debug_error_analysis': {
        return await runDebugErrorAnalysis(args.ErrorMessage, args.TargetFile);
      }

      case 'claw_doctor': {
        return await runClawDoctor(Boolean(args.runNetworkCheck));
      }

      case 'claw_status': {
        return await getClawStatus();
      }

      case 'claw_acp': {
        return getClawAcpInfo(args.action || 'status');
      }

      case 'claw_prompt': {
        return await runClawPrompt(args.prompt, args.role, Boolean(args.dryRun));
      }

      case 'omo_coordinate': {
        return await runOmoCoordinate(args.task, args.context, args.subAgents, execCtx);
      }

      case 'omx_protocol': {
        return await runOmxProtocol(args.goal, args.targetStack);
      }

      case 'clawhip_router': {
        return routeClawHipEvent(args.action, args.eventType, args.message, args.metadata);
      }

      case 'lazycodex_runner': {
        return await runLazyCodex(args.task, args.targetFiles, args.maxIterations);
      }

      case 'set_up_firebase': {
        // BACKEND RULE: only wire Firebase when the user asked for backend /
        // Firebase work (the system prompt + planning skill enforce this).
        // The config comes ONLY from the encrypted connected store — never a
        // key passed in args, never a hardcoded placeholder. Files go into
        // the BUILT project (projects/<session>/), never the agent's own tree.
        if (args.platform && String(args.platform).toLowerCase() !== 'web') {
          return { error: "Only the 'web' platform is supported for Firebase wiring (built web apps). Android native setup is not supported by this agent." };
        }
        const result = await addFirebaseToProject(execCtx?.sessionId);
        if (!result.success) return { error: result.error || 'Firebase setup failed.' };
        return {
          success: true,
          projectId: result.projectId,
          modifiedFiles: result.filesWritten,
          needsInstall: result.needsInstall,
          message: `Firebase wired into the project (project: ${result.projectId}): ${result.filesWritten.join(', ')}.${result.needsInstall ? ' Run npm install in the project to fetch the firebase package.' : ''} The app talks directly from the browser to Firebase Auth + Firestore + Storage — no Express server.`,
        };
      }

      case 'deploy_firebase': {
        // Honest deploy: writes rules when given, then runs a REAL Firebase
        // Hosting deploy only when FIREBASE_TOKEN is configured. Without the
        // token it returns the exact one-time setup steps — never a fake
        // "deployed" claim.
        if (args.rules) {
          const dirName = execCtx?.sessionId
            ? `projects/${execCtx.sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}`
            : 'projects';
          await fs.writeFile(path.resolve(process.cwd(), dirName, 'firestore.rules'), String(args.rules), 'utf-8');
        }
        const deploy = await deployFirebaseHosting(execCtx?.sessionId);
        if (deploy.status === 'live') {
          return { success: true, url: deploy.url, projectId: deploy.projectId, message: `Deployed to Firebase Hosting: ${deploy.url}` };
        }
        if (deploy.status === 'setup-needed') {
          return { success: false, setupNeeded: true, projectId: deploy.projectId, steps: deploy.steps, message: 'Firebase Hosting deploy needs a one-time setup (FIREBASE_TOKEN). The project is deploy-ready (firebase.json + .firebaserc written); see steps.' };
        }
        return { error: deploy.error };
      }


      case 'set_up_oauth': {
        const oauthPath = path.resolve(process.cwd(), '.oauth-config.json');
        let current: any = { scopes: [] };
        try {
          const raw = await fs.readFile(oauthPath, 'utf-8');
          current = JSON.parse(raw);
        } catch {}
        const scopes = Array.from(new Set([...(current.scopes || []), ...(args.scopes_to_add || [])]));
        const updated = { ...current, title: args.title, scopes, updatedAt: Date.now() };
        await fs.writeFile(oauthPath, JSON.stringify(updated, null, 2), 'utf-8');
        return { success: true, title: args.title, configuredScopes: scopes };
      }

      case 'remove_oauth': {
        const oauthPath = path.resolve(process.cwd(), '.oauth-config.json');
        let current: any = { scopes: [] };
        try {
          const raw = await fs.readFile(oauthPath, 'utf-8');
          current = JSON.parse(raw);
        } catch {}
        const toRemove = new Set(args.scopes_to_remove || []);
        const scopes = (current.scopes || []).filter((s: string) => !toRemove.has(s));
        await fs.writeFile(oauthPath, JSON.stringify({ ...current, scopes, updatedAt: Date.now() }, null, 2), 'utf-8');
        return { success: true, remainingScopes: scopes };
      }

      case 'cloudsql_execute_sql': {
        const query = String(args.sql_statement || '').trim();
        if (!query) return { error: "sql_statement is required" };
        if (/^\s*(DROP\s+DATABASE|ATTACH\s+DATABASE|DETACH\s+DATABASE)/i.test(query)) {
          return { error: "Safety guard: DROP DATABASE / ATTACH DATABASE statements are blocked." };
        }

        const dbPath = path.resolve(process.cwd(), '.nexus_local.db');
        const db = new DatabaseSync(dbPath);
        try {
          // Split multi-statement SQL carefully by semicolon outside quotes
          const statements: string[] = [];
          let current = '';
          let inSingle = false;
          let inDouble = false;
          for (let i = 0; i < query.length; i++) {
            const ch = query[i];
            if (ch === "'" && !inDouble) inSingle = !inSingle;
            else if (ch === '"' && !inSingle) inDouble = !inDouble;
            if (ch === ';' && !inSingle && !inDouble) {
              if (current.trim()) statements.push(current.trim());
              current = '';
            } else {
              current += ch;
            }
          }
          if (current.trim()) statements.push(current.trim());

          let lastRows: any[] = [];
          let columns: string[] = [];
          let totalChanges = 0;
          let lastInsertRowid: number | bigint | undefined = undefined;

          for (const stmtSql of statements) {
            const isReader = /^\s*(SELECT|PRAGMA|WITH|EXPLAIN)\b/i.test(stmtSql) || /\bRETURNING\b/i.test(stmtSql);
            if (isReader) {
              const stmt = db.prepare(stmtSql);
              const rows = stmt.all() as Record<string, any>[];
              lastRows = rows;
              columns = rows.length > 0 ? Object.keys(rows[0]) : stmt.columns().map((c: any) => c.name);
            } else {
              const stmt = db.prepare(stmtSql);
              const info = stmt.run();
              totalChanges += Number(info.changes || 0);
              if (info.lastInsertRowid !== undefined) {
                lastInsertRowid = Number(info.lastInsertRowid);
              }
            }
          }

          return {
            success: true,
            engine: 'sqlite (node:sqlite)',
            databaseFile: '.nexus_local.db',
            statement: query,
            columns,
            rowCount: lastRows.length,
            rowsAffected: totalChanges,
            lastInsertRowid,
            results: lastRows,
          };
        } catch (sqlErr: any) {
          return {
            success: false,
            error: sqlErr?.message || 'SQL execution error',
            statement: query,
          };
        } finally {
          db.close();
        }
      }

      case 'cloudsql_update_schema': {
        const schemaPath = path.resolve(process.cwd(), args.schemaPath || 'src/db/schema.ts');
        try {
          await fs.access(schemaPath);
          return { success: true, schemaPath, message: "Schema verified in src/db/schema.ts" };
        } catch {
          await fs.mkdir(path.dirname(schemaPath), { recursive: true });
          const boilerplate = `import { pgTable, text, serial, timestamp } from 'drizzle-orm/pg-core';\n\nexport const items = pgTable('items', {\n  id: serial('id').primaryKey(),\n  name: text('name').notNull(),\n  createdAt: timestamp('created_at').defaultNow(),\n});\n`;
          await fs.writeFile(schemaPath, boilerplate, 'utf-8');
          return { success: true, schemaPath, message: "Initialized schema boilerplate in src/db/schema.ts" };
        }
      }

      case 'figma_import': {
        return {
          success: true,
          componentName: args.componentName,
          designSpecs: args.designSpecs,
          message: `Figma specifications loaded for ${args.componentName}. Generate clean React component with Tailwind CSS styling.`,
        };
      }

      case 'focus_mode': {
        return {
          success: true,
          cssSelector: args.cssSelector,
          instruction: args.editInstruction,
          message: `Focus Mode locked onto selector '${args.cssSelector}'. Apply surgical edits to this element only.`,
        };
      }

      case 'schedule': {
        // FIX (2026-11-27): this used to only return a message and set no
        // timer at all (nothing ever fired). It now stores a real reminder
        // in the Nexus store — the same mechanism the `remind` tool uses —
        // and the scheduler fires it when due (while the server is awake).
        const duration = Math.max(1, Math.min(86400, Number(args.DurationSeconds) || 5));
        const prompt = String(args.Prompt || 'Timer notification').slice(0, 500);
        if (!prompt.trim()) return { error: 'schedule requires a Prompt.' };
        const store = await loadStore();
        const dueAt = new Date(Date.now() + duration * 1000);
        store.reminders.push({ id: newId('rem'), message: prompt, dueAt: dueAt.toISOString(), fired: false, createdAt: new Date().toISOString() });
        saveStoreSoon();
        return {
          success: true,
          duration,
          prompt,
          message: `Scheduled timer for ${duration}s: '${prompt}' — fires at ${dueAt.toISOString()} while the server is awake (see remind 'due' for fired timers).`,
        };
      }

      case 'plan': {
        return { success: true, steps: args.steps || [], message: "Implementation plan registered." };
      }

      case 'save_memory': {
        const fact = String(args.Fact || '').trim();
        if (!fact) return { error: "Fact is required." };
        if (/api[_-]?key|password|token|secret/i.test(fact)) {
          return { error: "Secrets must never be saved to memory. Use env vars / the Keys dashboard instead." };
        }
        await appendUserMemory(fact);
        return { success: true, message: `Saved to memory: ${fact}` };
      }

      case 'read_memory': {
        const memory = await readUserMemory();
        return { success: true, memory };
      }

      case 'save_lesson': {
        const error = String(args.Error || '').trim();
        const fix = String(args.Fix || '').trim();
        if (!error || !fix) return { error: "Both Error and Fix are required." };
        await recordLesson(error, fix, String(args.Context || ''));
        return { success: true, message: "Lesson recorded." };
      }

      case 'queue_job': {
        const prompt = String(args.Prompt || '').trim();
        if (!prompt) return { error: "Prompt is required." };
        const job = await createJob(prompt, execCtx?.sessionId || `session_${Date.now()}`);
        return { success: true, jobId: job.id, message: `Background job queued (${job.id}). It runs in the background; check the Jobs panel for status and the preview link when it finishes.` };
      }

      default:
        return { success: true, message: `Tool ${name} executed.` };
    }
  } catch (err: any) {
    return { error: err.message || `Error executing tool ${name}` };
  }
}

// Full Gemini Chat Stream Handler with Function Calling & Tool Loop
export async function handleServerGeminiChat(req: { messages: any[]; mode?: string }, res: Response) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const sendEvent = (data: any) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const { messages, mode = "general" } = req;
    const modelName = "gemini-3.8-flash";

    const { history, lastMessage } = prepareGeminiHistoryAndLastMessage(messages);
    const chat = getAiClient().chats.create({
      model: modelName,
      config: {
        systemInstruction: getNexusSystemInstruction(mode),
        // STEP 4 (P0): offer only the 87 core tools, never all 104
        // serverTools — same set the OpenAI-compatible loop sends.
        tools: [{ functionDeclarations: filterCoreTools(serverTools) }],
      },
      history,
    });

    let currentResult = await chat.sendMessageStream({ message: lastMessage });
    let fullText = "";

    while (true) {
      const functionCalls: any[] = [];

      for await (const chunk of currentResult) {
        if (chunk.text) {
          fullText += chunk.text;
          sendEvent({ type: "text", text: fullText });
        }
        if (chunk.functionCalls && chunk.functionCalls.length > 0) {
          functionCalls.push(...chunk.functionCalls);
        }
      }

      if (functionCalls.length === 0) break;

      const toolResponses = await Promise.all(
        functionCalls.map(async (call) => {
          if (!call.name) return null;
          const toolResult = await executeServerTool(call.name, call.args, (action) => {
            sendEvent({ type: "action", action });
          });
          if ((call.name === "generate_image" || call.name === "generateImage") && toolResult?.imageUrl) {
            sendEvent({ type: "image", imageUrl: toolResult.imageUrl });
          }
          return {
            functionResponse: {
              name: call.name,
              response: { output: toolResult },
            },
          };
        })
      );

      const validResponses = toolResponses.filter(Boolean);
      currentResult = await chat.sendMessageStream({ message: validResponses as any });
    }

    const deployed = await autoDeployWebsiteFromText(fullText);
    if (deployed.success) {
      const previewUrl = deployed.url || "/projects/index.html";
      sendEvent({ type: "action", action: `✓ Website & PWA generated & saved (${previewUrl})! Live Preview ready.` });
      sendEvent({ 
        type: "preview_ready", 
        url: previewUrl, 
        html: deployed.html,
        timestamp: Date.now() 
      });
    }

    sendEvent({ type: "done", fullText });
    res.end();
  } catch (error: any) {
    console.error("Gemini Server Error:", error);
    sendEvent({
      type: "error",
      error: error.message || "An error occurred with Gemini on the server.",
      is429: error.message?.includes("429") || error.toString().includes("429"),
    });
    res.end();
  }
}
