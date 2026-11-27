import fs from 'fs/promises';
import path from 'path';
import { CODING_SKILLS_REGISTRY } from './skillsRegistry.ts';

export interface DeployResult {
  success: boolean;
  html?: string;
  path?: string;
  url?: string;
  isPWA?: boolean;
}

/**
 * Returns the Master System Instruction for Nexus AI, instructing it to build
 * ALL kinds of websites, dashboards, e-commerce stores, games, and PWAs just like Google AI Studio Build.
 */
export interface SystemInstructionOptions {
  developerPersona?: string;
  customSystemInstruction?: string;
  outputFormat?: 'auto' | 'markdown' | 'json';
  multiAgent?: boolean;
  sessionId?: string;
  conversational?: boolean;
  // Full instruction text of skills matched to this request (from the
  // registry `triggers` field). Injected verbatim into the system prompt.
  matchedSkills?: string;
  // User memory (data/memory.md) + lessons (data/lessons.md), injected at
  // session start so the agent remembers durable facts and past mistakes.
  memory?: string;
  lessons?: string;
}

export function getNexusSystemInstruction(mode: string = 'general', options: SystemInstructionOptions = {}): string {
  const personaSection = options.developerPersona
    ? `\nACTIVE DEVELOPER PERSONA: ${options.developerPersona}\nFollow the idioms, best practices, strict typing, and conventions of this persona.`
    : '';

  const customSection = options.customSystemInstruction?.trim()
    ? `\nCUSTOM USER SYSTEM INSTRUCTIONS (HIGHEST PRIORITY):\n${options.customSystemInstruction.trim()}`
    : '';

  if (options.conversational) {
    return `You are Nexus AI, a friendly and concise software engineering assistant.${personaSection}${customSection}

CONVERSATIONAL FAST-PATH RULE:
- The user sent a casual greeting or simple conversational message (not a coding, file-editing, debugging, or web-search task).
- Reply directly, warmly, and concisely in natural language (Bengali if the user wrote in Bengali, or English if in English; default friendly bilingual greeting if ambiguous).
- DO NOT call any tools, DO NOT read files, and DO NOT run multi-agent planning for greetings or simple chat.`;
  }

  const outputFormatSection =
    options.outputFormat === 'json'
      ? `\nOUTPUT FORMAT CONSTRAINT: Return strictly valid JSON output (no trailing prose outside JSON) unless calling file tools.`
      : options.outputFormat === 'markdown'
        ? `\nOUTPUT FORMAT CONSTRAINT: Keep chat summaries structured in concise Markdown (never dump full source files into chat; write code directly into workspace files using tools).`
        : '';

  const multiAgentSection = options.multiAgent
    ? `\nMULTI-AGENT ORCHESTRATION ENABLED (OmO: Architect -> Executor -> Reviewer):
For any non-trivial coding or app-building request, FIRST call \`omo_coordinate\` with the task and relevant context so the Architect, Executor, and Reviewer sub-agents align before you edit files, then execute the edits with \`write_to_file\` / \`replace_file_content\`, and finish with \`compile_applet\` + \`lint_applet\`.`
    : '';

  const sessionPreviewTarget = options.sessionId
    ? `projects/${options.sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}/index.html`
    : 'projects/index.html';

  // Skill list is generated from CODING_SKILLS_REGISTRY (single source of
  // truth — every skill in the registry, never a hardcoded copy that drifts).
  const skillListSection = CODING_SKILLS_REGISTRY
    .map((s, i) => `${i + 1}. [${s.name}]: ${s.description}`)
    .join('\n');

  const matchedSkillsSection = options.matchedSkills?.trim()
    ? `\n\n================================================================================
# PRE-LOADED SKILLS FOR THIS REQUEST (matched from the user's message)
================================================================================
The following skill instructions were matched to this request — follow them closely:
${options.matchedSkills.trim()}`
    : '';

  // Memory + lessons: durable facts about the user and mistakes already fixed.
  // Read from data/memory.md and data/lessons.md at session start. The model
  // is stateless — this is the agent's memory. Keep both short (they are
  // truncated here so they never eat the context).
  const memorySection = options.memory?.trim()
    ? `\n\n================================================================================
# USER MEMORY (durable facts — from data/memory.md; update via save_memory)
================================================================================
${options.memory.trim().slice(0, 3000)}`
    : '';
  const lessonsSection = options.lessons?.trim()
    ? `\n\n================================================================================
# LESSONS FROM PAST MISTAKES (from data/lessons.md — check before writing similar code)
================================================================================
${options.lessons.trim().slice(0, 3000)}`
    : '';

  return `You are the coding engine behind Google AI Studio Build. You act as a senior software engineer: users describe what they want in natural language, and you create, modify, debug, and deploy complete applications. You are the primary engineer responsible for the user's task — building a new codebase, changing an existing one, or answering a question.

Current Mode: ${mode}${personaSection}${customSection}${outputFormatSection}${multiAgentSection}

================================================================================
# WHEN TO CALL TOOLS VS REPLY DIRECTLY
================================================================================
- ONLY invoke tools when the user asks to create, build, inspect, read, edit, fix, debug, search, or deploy code/files/apps/websites.
- If the user only says a greeting ("Hi", "Hello", "হ্যালো", "কেমন আছো") or asks a general question unrelated to workspace files, DO NOT call any tools—answer directly in chat!

================================================================================
# BACKEND RULE — FRONTEND-ONLY BY DEFAULT (user rule, never override)
================================================================================
- DEFAULT BUILDS ARE FRONTEND-ONLY: HTML/CSS/JS/React. No Auth, no Firestore,
  no Firebase wiring, no backend code — unless the user explicitly asks for
  backend or Firebase work. NEVER add Firebase "just in case" and NEVER assume
  a login/database is wanted.
- If a request IMPLIES backend needs (login, saving user data, orders, user
  accounts) but the user did NOT say backend/Firebase: ASK ONCE with
  ask_question ("Add a Firebase backend (login + database)?") and proceed ONLY
  on yes. If the user says no, build frontend-only.
- WHEN backend work IS asked for, Firebase is the DEFAULT backend choice:
  the app talks DIRECTLY from the browser to Firebase Auth + Firestore +
  Storage + Hosting (FIREBASE-DIRECT). No Express server is needed for login,
  data, files or hosting.
- Express is used ONLY when the user explicitly asks for it — the user says
  the word "Express" or asks for a custom Node/Express server. NEVER add an
  Express server to a built app on your own, even when backend work is
  requested. If server logic is needed and the user did NOT ask for Express,
  prefer Firebase Cloud Functions first — and ASK before adding any server at
  all. (Cloning a repo that already contains an Express server is different:
  leave its code as-is; the rule is about ADDING one.)
- SEPARATION: the AGENT itself runs on Express (its own server) — that is the
  agent's backend, not the built app's. The built app and the agent are
  different things; do not confuse them.

================================================================================
# BUILDING A SIMILAR SITE FROM A LINK (inspired-by, never a copy)
================================================================================
- When the user gives a URL and asks for a similar site: fetch it with
  read_page (plain pages) or browse_task (JS-heavy pages), analyse its
  LAYOUT, SECTIONS and STYLE — then build a SIMILAR site with FRESH, original
  content.
- NEVER copy the site's copyrighted text, images, logos or branding. NEVER
  claim to copy its private source code — only the public rendered page is
  visible; its source is not available to you.
- Login/paywalled pages cannot be cloned (their content is not public).
- If the page cannot be read (JS-rendered with no readable text, or blocked),
  say so and build from the user's description instead.

================================================================================
# SKILL CHECK & DYNAMIC SKILL LOADING (${CODING_SKILLS_REGISTRY.length} CODING SKILLS)
================================================================================
At the start of a NEW CODING TASK or when user prompt shifts to implementation, perform a Skill Check!
If any skill below is [RELEVANT] to the user's request, call \`read_skill\` with its SkillName BEFORE modifying or creating code files:

${skillListSection}${matchedSkillsSection}${memorySection}${lessonsSection}

================================================================================
# QUALITY LOOPS (ENFORCED BY THE SERVER — NOT OPTIONAL)
================================================================================
1. PLAN-FIRST (HARD RULE): Before your FIRST write_to_file / replace_file_content / multi_replace_file_content call, you MUST call omo_coordinate with the task (Architect → Executor → Reviewer plan) and read_skill for every relevant skill. The server REFUSES the first write until a plan step has run. Only call ask_question when the request is genuinely ambiguous — otherwise plan with sensible defaults and proceed (never stall a build waiting for answers).
2. VERIFY-BEFORE-DONE: After you finish writing files, the server automatically runs live-preview verification (HTTP 200, HTML structure, inline JS syntax, asset links) and a reviewer pass. If either reports issues, you MUST fix them with the file tools — never present a broken build as finished.
BUG-FIX FLOW (when a build fails or a bug is found — issue → fix → test → PR → CI → done): (a) FILE IT — if a GitHub repo is connected for the project, create an issue with github_issues (action create: what broke, where, the error); if no repo is connected, record it with save_lesson. (b) FIX it with the file tools. (c) TEST it — run the testing skill: compile_applet + lint_applet + code_execution_sandbox + verify_live_preview; read the actual output, never claim a test passed without running it. (d) REVIEW it — run the code-review skill and the security-audit skill on the changed code (no secrets, no XSS/injection). (e) PR IT — if a repo is connected and the change is non-trivial, open a pull request with github_pull_request instead of pushing directly. (f) CI CHECK — check the run with github_actions (list_runs); only present the work as done when CI is green (or no CI exists). If CI fails, fix and repeat from (b). Never present a build as done while its tests or CI are red.
3. SHORT-BRIEF DISCIPLINE: Tool results are truncated to ~3000 characters. Never dump whole files into context — use grep_search with patterns and view_file on narrow targets. Summarize, don't paste.
4. FAILOVER: If a model call fails, the server retries the next free model automatically — keep working, do not apologize or stop.

================================================================================
# THE 6-PHASE AUTONOMOUS ENGINEERING PIPELINE
================================================================================
Process every user prompt through this 6-phase engineering workflow:

Phase 1: Intent Triage & Skill Selection
- Analyze user prompt: Is it a new app, a feature addition, a bug fix, or a query?
- Identify matching skills and load guidelines via \`read_skill\`.

Phase 2: Context Gathering & Codebase Inspection
- Call \`analyze_project\`, \`list_dir\`, \`grep_search\`, or \`find_by_name\` to inspect existing workspace structure.
- Call \`view_file\` or \`read_multiple_files\` to examine relevant components, server routes, or package.json before writing code.

Phase 3: Surgical Execution & File Generation
- Call \`install_applet_package\` BEFORE importing any new npm library.
- Call \`write_to_file\` to create new files in complete, pristine blocks (never empty placeholders or '// TODO' stubs).
- Call \`replace_file_content\` or \`multi_replace_file_content\` for targeted edits without breaking working code.
- Ensure dev server always binds to host 0.0.0.0 and port 3000.

Phase 4: Dual Verification Loop
- Run \`compile_applet\` and \`lint_applet\` together to verify zero syntax, missing import, or TypeScript errors.
- If errors occur, diagnose with \`debug_error_analysis\` or sandbox test, fix them surgically, and re-verify (up to 3 fix attempts).

Phase 5: Runtime & Dev Server Validation
- Call \`restart_dev_server\` when server.ts, configuration, or dependencies change.
- Call \`verify_live_preview\` after deploying or updating \`${sessionPreviewTarget}\` to verify HTTP 200 status, HTML/JS syntax, and asset integrity.

Phase 6: Scannable Structured Reporting
- Present a concise, scannable summary: what was built, what was fixed, and current live status.
- Zero unnecessary pleasantries or filler talk before invoking tools.

================================================================================
# STRICT WORKSPACE FILE-WRITING RULE (NEVER WRITE CODE OR TOOL JSON IN CHAT)
================================================================================
- CRITICAL: Whenever the user asks to create, design, modify, fix, or build ANY app, website, dashboard, game, PWA, component, or backend code, you MUST write/edit the actual files on disk using \`write_to_file\`, \`replace_file_content\`, or \`multi_replace_file_content\`.
- NEVER output \`{"tool_calls": ...}\` JSON in chat! Always invoke real tool calls directly, and keep executing tool calls across turns until ALL requested features are implemented in files and verified.
- NEVER stop after calling \`set_up_firebase\`, \`omo_coordinate\`, or \`view_file\`—immediately continue with \`write_to_file\` / \`replace_file_content\` to build and update the actual app files, then run \`compile_applet\` + \`lint_applet\`.
- NEVER paste large code blocks, full files, or \`\`\`html ... \`\`\` dumps in your chat response! Only write code inside workspace files via tool calls, then present a concise, scannable summary in chat.
- Always follow: Inspect (\`view_file\`, \`read_multiple_files\`, \`grep_search\`, \`list_dir\`) -> Write/Edit (\`write_to_file\`, \`replace_file_content\`, \`multi_replace_file_content\`) -> Verify (\`compile_applet\`, \`lint_applet\`).

1. Live Interactive Website / PWA Mode:
   - When asked to design/build or add features to a standalone website, landing page, dashboard, game, store, or PWA preview:
   - If \`${sessionPreviewTarget}\` already exists, FIRST inspect it with \`view_file\`, then update it using \`write_to_file\` or \`replace_file_content\` with all new features integrated.
   - Otherwise, call \`write_to_file\` with \`TargetFile: "${sessionPreviewTarget}"\` and complete, 100% functional production HTML/CSS/JS inside \`CodeContent\`.
   - Nexus AI automatically injects PWA manifest & service worker, updates the session preview, and renders it in Live Preview immediately.

2. Full-Stack Workspace Coding Mode:
   - When asked to clone repos, modify app source code, add features, debug errors, or inspect files:
   - Execute real workspace tools (\`read_skill\`, \`omo_coordinate\`, \`read_multiple_files\`, \`code_execution_sandbox\`, \`debug_error_analysis\`, \`verify_live_preview\`, \`compute_file_diff\`, \`grep_search\`, \`find_by_name\`, \`view_file\`, \`write_to_file\`, \`replace_file_content\`, \`multi_replace_file_content\`, \`run_command\`, \`install_applet_package\`, \`compile_applet\`, \`lint_applet\`, \`restart_dev_server\`, \`ask_question\`, \`set_up_firebase\`, \`deploy_firebase\`, \`set_up_oauth\`, \`cloudsql_execute_sql\`, \`figma_import\`, \`focus_mode\`, \`schedule\`).

================================================================================
# LANGUAGE & PRESENTATION
================================================================================
- Respond in Bengali (বাংলা) if the user writes in Bengali, or English if in English.
- Action over talk: call tools directly instead of saying what tool you will call next.
- Provide concise, scannable completion summaries without pasting source files into chat.`;
}

/**
 * Enriches HTML with PWA meta tags/service worker and writes it to both
 * global projects/ and the active session directory for immediate Live Preview.
 */
export async function deployHtmlFile(
  rawHtml: string,
  sessionId?: string
): Promise<DeployResult> {
  try {
    let htmlContent = (rawHtml || '').trim();
    if (!htmlContent || htmlContent.length < 30 || !htmlContent.includes('<')) {
      return { success: false };
    }

    if (!htmlContent.toLowerCase().includes('<!doctype html>')) {
      htmlContent = `<!DOCTYPE html>\n${htmlContent}`;
    }

    // Extract title and theme color for PWA Manifest
    const titleMatch = htmlContent.match(/<title>([^<]+)<\/title>/i);
    const rawTitle = titleMatch ? titleMatch[1].trim() : 'Nexus Web App';
    const appTitle = rawTitle.replace(/[|•-].*$/, '').trim() || 'Nexus App';
    const appShortName = appTitle.slice(0, 14).trim() || 'NexusApp';

    const themeColorMatch = htmlContent.match(/<meta\s+name=["']theme-color["']\s+content=["']([^"']+)["']/i);
    const themeColor = themeColorMatch ? themeColorMatch[1] : '#4f46e5';

    // Enrich HTML with PWA meta tags & Service Worker if missing
    let enrichedHtml = htmlContent;

    // Check if manifest link is present
    if (!enrichedHtml.includes('manifest.webmanifest') && !enrichedHtml.includes('manifest.json')) {
      const headIndex = enrichedHtml.indexOf('</head>');
      if (headIndex !== -1) {
        const pwaMetaTags = `
  <!-- PWA & Mobile Meta Tags (Auto-injected by Nexus AI) -->
  <link rel="manifest" href="manifest.webmanifest" />
  <meta name="theme-color" content="${themeColor}" />
  <meta name="mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <link rel="apple-touch-icon" href="/icon.svg" />
  <link rel="icon" type="image/svg+xml" href="/icon.svg" />
`;
        enrichedHtml = enrichedHtml.slice(0, headIndex) + pwaMetaTags + enrichedHtml.slice(headIndex);
      }
    }

    // Check if Service Worker registration is present
    if (!enrichedHtml.includes('serviceWorker.register')) {
      const bodyCloseIndex = enrichedHtml.lastIndexOf('</body>');
      const swRegisterScript = `
  <!-- PWA Service Worker Registration & Install Prompt (Auto-injected by Nexus AI) -->
  <script>
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function() {
        navigator.serviceWorker.register('./sw.js').then(function(reg) {
          console.log('Nexus PWA Service Worker registered:', reg.scope);
        }).catch(function(err) {
          console.log('SW registration note:', err);
        });
      });
    }

    // Global PWA Install Prompt Listener
    let deferredInstallPrompt = null;
    window.addEventListener('beforeinstallprompt', function(e) {
      e.preventDefault();
      deferredInstallPrompt = e;
      window.dispatchEvent(new CustomEvent('pwa-installable'));
      var installBtn = document.getElementById('nexus-pwa-install-btn');
      if (installBtn) installBtn.style.display = 'inline-flex';
    });

    window.triggerPWAInstall = function() {
      if (deferredInstallPrompt) {
        deferredInstallPrompt.prompt();
        deferredInstallPrompt.userChoice.then(function(choice) {
          if (choice.outcome === 'accepted') {
            console.log('User accepted PWA installation');
          }
          deferredInstallPrompt = null;
        });
      } else {
        alert('অ্যাপটি ইনস্টল করতে ব্রাউজারের শেয়ার বা মেনু থেকে "Add to Home Screen" বা "Install" নির্বাচন করুন।');
      }
    };
  </script>
`;
      if (bodyCloseIndex !== -1) {
        enrichedHtml = enrichedHtml.slice(0, bodyCloseIndex) + swRegisterScript + enrichedHtml.slice(bodyCloseIndex);
      } else {
        enrichedHtml += swRegisterScript;
      }
    }

    // Inject lightweight Runtime Error Bridge for Nexus Live Preview parent iframe inspection
    if (!enrichedHtml.includes('__nexusErrorBridge')) {
      const runtimeBridgeScript = `
  <!-- Nexus Runtime Error Bridge (Auto-injected by Nexus AI) -->
  <script>
    (function() {
      if (window.__nexusErrorBridge) return;
      window.__nexusErrorBridge = true;
      function notifyParent(payload) {
        try {
          if (window.parent && window.parent !== window) {
            window.parent.postMessage({ type: 'nexus-preview-error', payload: payload }, '*');
          }
        } catch (e) {}
      }
      window.addEventListener('error', function(event) {
        notifyParent({
          message: event.message || 'Runtime script error',
          source: event.filename || '',
          line: event.lineno || 0,
          col: event.colno || 0
        });
      });
      window.addEventListener('unhandledrejection', function(event) {
        var reason = event.reason;
        notifyParent({
          message: (reason && reason.message) ? reason.message : String(reason || 'Unhandled Promise Rejection'),
          source: 'Promise',
          line: 0,
          col: 0
        });
      });
    })();
  </script>
`;
      const headOpenClose = enrichedHtml.indexOf('</head>');
      if (headOpenClose !== -1) {
        enrichedHtml = enrichedHtml.slice(0, headOpenClose) + runtimeBridgeScript + enrichedHtml.slice(headOpenClose);
      } else {
        enrichedHtml = runtimeBridgeScript + enrichedHtml;
      }
    }

    // Create standard PWA Manifest JSON
    const manifestContent = JSON.stringify({
      id: './',
      name: appTitle,
      short_name: appShortName,
      description: `${appTitle} - Progressive Web Application built with Nexus AI`,
      start_url: './index.html',
      scope: './',
      display: 'standalone',
      orientation: 'portrait-primary',
      background_color: '#020617',
      theme_color: themeColor,
      icons: [
        {
          src: '/icon.svg',
          sizes: '192x192 512x512',
          type: 'image/svg+xml',
          purpose: 'any maskable'
        },
        {
          src: '/pwa-192x192.png',
          sizes: '192x192',
          type: 'image/png',
          purpose: 'any'
        },
        {
          src: '/pwa-512x512.png',
          sizes: '512x512',
          type: 'image/png',
          purpose: 'any'
        }
      ]
    }, null, 2);

    // Create resilient Service Worker script
    const swContent = `// Nexus PWA Service Worker (Auto-generated by Nexus AI)
const CACHE_NAME = 'nexus-pwa-${Date.now()}';
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.webmanifest'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_URLS).catch((err) => {
        console.warn('Pre-caching assets:', err);
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) return caches.delete(key);
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);

  // Network-first with cache fallback for HTML documents; Cache-first for static resources
  if (event.request.destination === 'document') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((c) => c.put(event.request, copy));
          }
          return response;
        })
        .catch(() => caches.match(event.request).then((res) => res || caches.match('./index.html')))
    );
  } else {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((c) => c.put(event.request, copy));
          }
          return response;
        }).catch(() => null);
      })
    );
  }
});
`;

    const projectsDir = path.resolve(process.cwd(), 'projects');
    await fs.mkdir(projectsDir, { recursive: true });

    // Always deploy to global projects/
    await fs.writeFile(path.join(projectsDir, 'index.html'), enrichedHtml, 'utf-8');
    await fs.writeFile(path.join(projectsDir, 'manifest.webmanifest'), manifestContent, 'utf-8');
    await fs.writeFile(path.join(projectsDir, 'sw.js'), swContent, 'utf-8');

    let targetUrl = '/projects/index.html';
    let targetPath = 'projects/index.html';

    // If chat session ID provided, deploy to chat session folder
    if (sessionId) {
      const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
      const sessionDir = path.join(projectsDir, safeSessionId);
      await fs.mkdir(sessionDir, { recursive: true });

      await fs.writeFile(path.join(sessionDir, 'index.html'), enrichedHtml, 'utf-8');
      await fs.writeFile(path.join(sessionDir, 'manifest.webmanifest'), manifestContent, 'utf-8');
      await fs.writeFile(path.join(sessionDir, 'sw.js'), swContent, 'utf-8');

      targetUrl = `/projects/${safeSessionId}/index.html`;
      targetPath = `projects/${safeSessionId}/index.html`;
    }

    return { 
      success: true, 
      html: enrichedHtml, 
      path: targetPath, 
      url: targetUrl,
      isPWA: true
    };
  } catch (err) {
    console.warn("Failed to deploy HTML and PWA files:", err);
    return { success: false };
  }
}

/**
 * Extracts and deploys complete websites and PWA companion files (manifest, service worker)
 * from text output as a fallback if the model wrote HTML in text instead of calling write_to_file.
 */
export async function autoDeployWebsiteFromText(
  text: string, 
  sessionId?: string
): Promise<DeployResult> {
  try {
    let htmlContent = '';
    
    // 1. Check for ```html ... ``` block
    const codeBlockMatch = text.match(/```(?:html|htm)\s*([\s\S]*?)```/i);
    if (codeBlockMatch && codeBlockMatch[1] && codeBlockMatch[1].includes('<')) {
      htmlContent = codeBlockMatch[1].trim();
    }
    
    // 2. Check for <!DOCTYPE html ... </html>
    if (!htmlContent) {
      const docMatch = text.match(/(<!DOCTYPE\s+html[\s\S]*?<\/html>)/i);
      if (docMatch && docMatch[1]) {
        htmlContent = docMatch[1].trim();
      }
    }

    // 3. Check for <html ... </html>
    if (!htmlContent) {
      const htmlMatch = text.match(/(<html[\s\S]*?<\/html>)/i);
      if (htmlMatch && htmlMatch[1]) {
        htmlContent = `<!DOCTYPE html>\n${htmlMatch[1].trim()}`;
      }
    }

    if (!htmlContent || htmlContent.length < 50) {
      return { success: false };
    }

    return await deployHtmlFile(htmlContent, sessionId);
  } catch (err) {
    console.warn("Failed to auto-deploy website from text:", err);
    return { success: false };
  }
}

export interface SanitizedGeminiChatInput {
  history: { role: 'user' | 'model'; parts: { text: string }[] }[];
  lastMessage: string;
}

/**
 * Sanitize chat messages for @google/genai to prevent empty/uninitialized data oneof field errors.
 * Ensures:
 * 1. Every part has non-empty text.
 * 2. Proper turn alternation (user -> model -> user -> model).
 * 3. Consecutive turns of identical role are merged.
 * 4. Prepares a clean lastMessage for chat.sendMessageStream.
 */
export function prepareGeminiHistoryAndLastMessage(messages: any[]): SanitizedGeminiChatInput {
  if (!Array.isArray(messages) || messages.length === 0) {
    return {
      history: [],
      lastMessage: "Hello! Please assist me."
    };
  }

  // 1. Sanitize all turns to ensure every single turn has at least 1 non-empty text part
  const rawCleaned: { role: 'user' | 'model'; text: string }[] = [];

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;
    const role: 'user' | 'model' = m.role === 'model' ? 'model' : 'user';

    let text = '';
    if (Array.isArray(m.parts)) {
      for (const p of m.parts) {
        if (typeof p === 'string' && p.trim()) {
          text += (text ? '\n' : '') + p.trim();
        } else if (p && typeof p.text === 'string' && p.text.trim()) {
          text += (text ? '\n' : '') + p.text.trim();
        }
      }
    } else if (typeof m.content === 'string' && m.content.trim()) {
      text = m.content.trim();
    } else if (typeof m.text === 'string' && m.text.trim()) {
      text = m.text.trim();
    }

    // Crucial safeguard against empty/uninitialized data oneof field in Gemini protobuf:
    if (!text.trim()) {
      if (m.imageUrl) {
        text = `[Attached Image: ${m.imageUrl}]`;
      } else if (role === 'model') {
        text = 'Code and architecture implemented.';
      } else {
        text = 'Please proceed with implementation.';
      }
    }

    rawCleaned.push({ role, text: text.trim() });
  }

  if (rawCleaned.length === 0) {
    return {
      history: [],
      lastMessage: "Hello! Please assist me."
    };
  }

  // 2. The latest turn to send to chat.sendMessageStream must be user text
  const lastTurn = rawCleaned.pop()!;
  let lastMessage = lastTurn.text;

  // 3. Construct alternating history
  const history: { role: 'user' | 'model'; parts: { text: string }[] }[] = [];

  for (const item of rawCleaned) {
    if (history.length === 0) {
      history.push({ role: item.role, parts: [{ text: item.text }] });
    } else {
      const prev = history[history.length - 1];
      if (prev.role === item.role) {
        // Merge consecutive turns of identical role
        prev.parts[0].text += '\n\n' + item.text;
      } else {
        history.push({ role: item.role, parts: [{ text: item.text }] });
      }
    }
  }

  // If history ends with 'user', and we are about to send a 'user' turn:
  // Gemini chat expects alternating turns (last history item must be 'model').
  // Prepend the trailing user turn to lastMessage!
  if (history.length > 0 && history[history.length - 1].role === 'user') {
    const trailingUser = history.pop()!;
    lastMessage = trailingUser.parts[0].text + '\n\n' + lastMessage;
  }

  // If history still starts with 'model', prepend a greeting user turn to satisfy Gemini turn order
  if (history.length > 0 && history[0].role === 'model') {
    history.unshift({ role: 'user', parts: [{ text: 'Hello' }] });
  }

  return {
    history,
    lastMessage: lastMessage.trim() || 'Please proceed with the task.'
  };
}
