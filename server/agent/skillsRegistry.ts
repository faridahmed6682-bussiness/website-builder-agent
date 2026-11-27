export interface SkillDefinition {
  name: string;
  category: 'design' | 'migration' | 'backend' | 'ai' | 'realtime' | 'spatial' | 'workflow';
  description: string;
  triggers: string[];
  instructions: string;
}

export const CODING_SKILLS_REGISTRY: SkillDefinition[] = [
  {
    name: 'frontend-design',
    category: 'design',
    description: 'Universal design constitution and domain-specific guidelines for production-grade web apps, dashboards, games, and landing pages.',
    triggers: ['website', 'landing page', 'dashboard', 'ui', 'redesign', 'store', 'portfolio', 'game'],
    instructions: `# Frontend Design Skill
1. Anti-AI Slop Rules:
   - Avoid generic purple/blue gradients and repetitive card grids with identical pill badges (Zero-pill discipline).
   - Establish real typographic hierarchy, high-contrast color surfaces, intentional spacing, and responsive breakpoints.
   - Use domain-appropriate visual identity (editorial, industrial, glassmorphic, fintech, retro-arcade, etc.).
2. 100% Interactive Completeness:
   - Every tab, filter, search bar, modal, drawer, form, and button MUST actually work with real state transitions.
   - Never leave dead links, placeholder "// TODO" actions, or unstyled elements.
3. Media & Assets:
   - Use generate_image for hero visuals or bespoke illustrations, and clean inline SVGs or Lucide icons for UI controls.`
  },
  {
    name: 'github-import-migration',
    category: 'migration',
    description: 'Execute-First migration protocol for cloning and booting GitHub repositories in Node.js 22 / Vite / Express on port 3000.',
    triggers: ['github', 'clone', 'repo', 'import', 'migrate', 'repository'],
    instructions: `# GitHub Import & Migration Skill
1. Triage & Clone:
   - Clone target repo using run_command ('git clone <url> <dir>') and inspect package.json + directory tree via view_file / list_dir.
2. Package Manager Normalization:
   - Remove bun.lock, yarn.lock, pnpm-lock.yaml; convert resolutions -> overrides; remove packageManager / preinstall scripts.
   - Install dependencies using install_applet_package or install_applet_dependencies (npm only).
3. Runtime & Port 3000 Constraints:
   - Ensure dev server binds to host '0.0.0.0' and port 3000.
   - Replace incompatible native addons (bcrypt -> bcryptjs, node-sass -> sass) and mock external DBs if offline.
4. Verification Loop:
   - Run compile_applet and lint_applet together, fix any missing imports or type errors, then call restart_dev_server.`
  },
  {
    name: 'github-import-rewrite',
    category: 'migration',
    description: 'Cross-framework rewrite protocol when an imported project uses an unsupported runtime or mobile framework (Flutter, Python, Go, React Native).',
    triggers: ['rewrite', 'python', 'django', 'flask', 'fastapi', 'flutter', 'react-native', 'go'],
    instructions: `# GitHub Cross-Framework Rewrite Skill
1. Catalog core endpoints, data models, UI routes, and authentication flows from the source repo.
2. Target Stack: Vite + React + TypeScript + Tailwind CSS + Express (server.ts) on port 3000.
3. Reimplement core 3-5 workflows cleanly with in-memory or local persistence, verify with compile_applet + lint_applet.`
  },
  {
    name: 'gemini-api',
    category: 'ai',
    description: 'Coding patterns and model selection for @google/genai TypeScript SDK (streaming, function calling, structured output, image/audio).',
    triggers: ['gemini', 'genai', 'ai', 'llm', 'chatbot', 'streaming', 'function calling'],
    instructions: `# Gemini API (@google/genai) Skill
1. Always use the modern '@google/genai' SDK (never legacy '@google/generative-ai').
2. Keep GEMINI_API_KEY strictly server-side behind '/api/*' Express routes.
3. Use 'gemini-3.8-flash' (or 'gemini-3.1-flash-lite' for high-throughput) for text/multimodal/tool calling.
4. Sanitize chat turn alternation (user -> model -> user) and avoid empty text parts to prevent protobuf errors.`
  },
  {
    name: 'gemini-interactions-api',
    category: 'ai',
    description: 'Patterns for Deep Research agent, Omni models (video generation/editing), Live API real-time audio, and Lyria music generation.',
    triggers: ['interactions api', 'deep research', 'omni', 'live api', 'lyria', 'video generation'],
    instructions: `# Gemini Interactions API Skill
1. Use server-side proxy routes for Interactions API, Deep Research, and Omni video/multimodal workflows.
2. Stream progress events over SSE ('text/event-stream') to keep the frontend responsive during long-running tasks.`
  },
  {
    name: 'pwa-integration',
    category: 'workflow',
    description: 'Full Progressive Web App (PWA) compliance: manifest.webmanifest, Service Worker offline caching, icons, and install prompt.',
    triggers: ['pwa', 'offline', 'service worker', 'manifest', 'installable', 'mobile app'],
    instructions: `# PWA Integration Skill
1. Provide valid manifest.webmanifest (name, short_name, start_url, display: 'standalone', theme_color, 192x192 & 512x512 icons).
2. Register Service Worker (sw.js) with network-first for HTML documents and cache-first for static assets.
3. Listen for 'beforeinstallprompt' on window and provide a working Install App button + offline indicator.`
  },
  {
    name: 'applet-seo',
    category: 'design',
    description: 'Configures SEO meta tags, OpenGraph social cards, Twitter cards, canonical URLs, and Schema.org JSON-LD.',
    triggers: ['seo', 'meta', 'opengraph', 'og:', 'json-ld', 'schema.org', 'social card'],
    instructions: `# Applet SEO Skill
1. Sync <title>, <meta name="description">, og:title, og:description, og:type, twitter:card in index.html.
2. Add semantic HTML5 landmarks (<header>, <main>, <article>, <footer>) and JSON-LD structured data when building public web apps.`
  },
  {
    name: 'firebase-integration',
    category: 'backend',
    description: 'Integrates Firebase Auth and Firestore with secure firestore.rules, RBAC, and real-time listeners.',
    triggers: ['firebase', 'firestore', 'auth', 'login', 'rbac', 'rules', 'persistent database'],
    instructions: `# Firebase & Firestore Integration Skill
1. Initialize Firebase client cleanly from config without exposing admin service accounts.
2. Write strict 'firestore.rules' enforcing 'request.auth != null', ownership checks ('request.auth.uid == resource.data.userId'), and role validation.
3. Use real-time 'onSnapshot' or async Firestore queries with proper error handling.`
  },
  {
    name: 'cloudsql-setup',
    category: 'backend',
    description: 'PostgreSQL / Drizzle ORM schema design (src/db/schema.ts), relational modeling, and parameterized queries.',
    triggers: ['postgres', 'postgresql', 'sql', 'drizzle', 'relational', 'database', 'schema'],
    instructions: `# Cloud SQL / PostgreSQL & Drizzle Skill
1. Define normalized tables and foreign keys in 'src/db/schema.ts' using 'drizzle-orm/pg-core'.
2. Keep all DB connections and queries strictly on the server ('server.ts' / 'server/*'), never in browser code.
3. Always use parameterized Drizzle queries or prepared statements to prevent SQL injection.`
  },
  {
    name: 'cloudsql-execute-sql',
    category: 'backend',
    description: 'Executes SQL statements on the database instance for DQL/DML operations, seeding, data queries, and debugging.',
    triggers: ['execute sql', 'sql query', 'seed database', 'run query', 'query data', 'sql statement'],
    instructions: `# Cloud SQL Execute SQL Skill
1. Use 'cloudsql_execute_sql' for DQL/DML operations (SELECT, INSERT, UPDATE, DELETE).
2. Do not use for destructive DROP TABLE or DROP DATABASE operations.
3. Always verify table schema with 'src/db/schema.ts' before writing complex joins.`
  },
  {
    name: 'cloudsql-update-schema',
    category: 'backend',
    description: 'Updates and validates database schema in src/db/schema.ts and ensures type safety across queries.',
    triggers: ['update schema', 'drizzle schema', 'db migration', 'drizzle push', 'schema update'],
    instructions: `# Cloud SQL Update Schema Skill
1. Keep table definitions synchronized in 'src/db/schema.ts'.
2. Export all tables and relation schemas with strict TypeScript infer types.
3. Re-verify the app build with compile_applet and lint_applet after schema updates.`
  },
  {
    name: 'figma-import',
    category: 'design',
    description: 'Converts attached Figma designs, screenshots, or design tokens into production-ready React + Tailwind CSS code.',
    triggers: ['figma', 'figma design', 'import figma', 'figma.com', 'design mockup', 'design screenshot'],
    instructions: `# Figma Import Skill
1. Analyze color palette, typography hierarchy, responsive container widths, and grid layouts from Figma specs.
2. Port to clean React functional components using Tailwind CSS classes.
3. Ensure every button, input, drawer, and modal in the design has real interactive state.`
  },
  {
    name: 'focus-mode',
    category: 'workflow',
    description: 'Applies surgical edits to specific CSS selectors or selected UI components without modifying surrounding code.',
    triggers: ['focus mode', 'css selector', 'edit element', 'targeted edit', 'selected element', 'highlighted component'],
    instructions: `# Focus Mode Skill
1. When user selects a specific element (by CSS selector, ID, or class), locate its exact lines in the target file.
2. Use 'replace_file_content' to make a single contiguous edit to that component only.
3. Preserve all existing event handlers, state bindings, and props of surrounding sibling elements.`
  },
  {
    name: 'real-time-and-multi-user',
    category: 'realtime',
    description: 'Real-time WebSockets, SSE live sync, multiplayer game loops, and collaborative canvases.',
    triggers: ['websocket', 'realtime', 'multiplayer', 'chat', 'collaborative', 'live sync'],
    instructions: `# Real-Time & Multi-User Skill
1. Multiplex WebSockets on the same HTTP server on port 3000 (never open a separate port).
2. Keep authoritative state on the server and broadcast typed delta events to connected clients.`
  },
  {
    name: 'threejs',
    category: 'spatial',
    description: '3D WebGL scenes using Three.js, lighting, PBR materials, OrbitControls, shaders, and animation loops.',
    triggers: ['3d', 'threejs', 'three.js', 'webgl', 'shader', 'mesh', 'canvas 3d'],
    instructions: `# Three.js 3D Spatial Skill
1. Install 'three' and '@types/three' via install_applet_package before importing.
2. Configure WebGLRenderer with antialias, responsive ResizeObserver, ACESFilmicToneMapping, and dispose geometries/materials on unmount.`
  },
  {
    name: 'google-maps-platform',
    category: 'spatial',
    description: 'Interactive maps, geolocation, route planning, places search, and geocoding.',
    triggers: ['map', 'google maps', 'gps', 'location', 'coordinates', 'directions', 'routing'],
    instructions: `# Google Maps Platform Skill
1. Load Maps JS API safely with environment-configured key or Leaflet/OpenStreetMap fallback if key is absent.
2. Handle browser geolocation permission gracefully with manual coordinate/address fallback.`
  },
  {
    name: 'oauth-integration',
    category: 'backend',
    description: 'Third-party OAuth2 popup flows (GitHub, Discord, Spotify, Strava) compatible with iframe sandboxing.',
    triggers: ['oauth', 'third-party login', 'github login', 'spotify', 'discord'],
    instructions: `# Third-Party OAuth Skill
1. In iframe environments, open OAuth in a popup window and communicate completion back via 'window.opener.postMessage'.
2. Use 'SameSite=None; Secure' cookies and validate state parameter to prevent CSRF.`
  },
  {
    name: 'workspace-integration',
    category: 'backend',
    description: 'Google Workspace APIs (Drive, Docs, Sheets, Calendar, Gmail) using client-side OAuth tokens + Bearer headers.',
    triggers: ['google drive', 'google sheets', 'google calendar', 'gmail', 'google docs', 'workspace'],
    instructions: `# Google Workspace Integration Skill
1. Obtain Google Workspace access tokens client-side via OAuth2 token flow; never store client secrets in browser code.
2. Pass tokens to backend routes via 'Authorization: Bearer <token>' headers when server proxying is needed.`
  },
  {
    name: 'shadcn-ui',
    category: 'design',
    description: 'Composable accessible UI primitives with Tailwind CSS, Radix-style keyboard navigation, and clean token theming.',
    triggers: ['shadcn', 'radix', 'dialog', 'dropdown', 'popover', 'accessible ui'],
    instructions: `# shadcn/ui Component Skill
1. Build modular, accessible components using 'clsx' + 'tailwind-merge' ('cn()' helper in src/lib/utils.ts).
2. Support keyboard escape/focus handling on dialogs, drawers, and dropdown menus.`
  },
  {
    name: 'image-generation',
    category: 'ai',
    description: 'Visual asset strategy: choosing between generate_image, inline SVGs, and verified static assets.',
    triggers: ['image', 'illustration', 'banner', 'avatar', 'logo', 'icon', 'generate_image'],
    instructions: `# Image Generation & Asset Strategy Skill
1. Use 'generate_image' for hero banners, product visuals, avatars, and bespoke illustrations.
2. Use Lucide icons or crisp inline SVGs for UI icons, badges, and vector logos.`
  },
  {
    name: 'planning-mode',
    category: 'workflow',
    description: 'Clarifying ambiguous user requests with ask_question and producing structured architectural implementation plans before coding.',
    triggers: ['plan', 'architecture', 'clarify', 'design first', 'spec'],
    instructions: `# Planning Mode & Focus Mode Skill
1. When requirements are ambiguous or multi-faceted, call 'ask_question' with concise plain-text questions and 2-6 short options.
2. Outline clear architectural decisions (files to create/edit, data models, verification steps) before writing code.
3. In Focus Mode (when a user targets a specific CSS selector or UI element), apply surgical edits via 'replace_file_content' without disturbing unrelated sections.

## BACKEND RULE — FRONTEND-ONLY BY DEFAULT (user rule, never override)
4. DEFAULT BUILDS ARE FRONTEND-ONLY (HTML/CSS/JS/React). Do NOT plan any backend, Auth, Firestore or Firebase work unless the user explicitly asked for backend or Firebase work. Never add Firebase "just in case".
5. If the request IMPLIES backend needs (login, saving user data, orders, user accounts) but the user did NOT say backend/Firebase: ask ONCE with ask_question ("Add a Firebase backend (login + database)?") and plan backend ONLY on yes. If no, plan frontend-only.
6. When backend work IS asked for, Firebase is the DEFAULT backend: plan Firebase-direct (browser → Firebase Auth + Firestore + Storage + Hosting), no Express. Express ONLY if the user explicitly says the word "Express" (or asks for a custom Node/Express server) — NEVER add an Express server on your own. If server logic is needed and the user did NOT ask for Express, plan Firebase Cloud Functions first — and ask before adding any server at all. (Cloning a repo that already contains Express is different: leave its code as-is.)`
  },
  {
    name: 'system-instructions-persona',
    category: 'workflow',
    description: 'Enforces a dedicated Developer Persona, target programming language (React, Node.js, Python, TypeScript), and strict coding standards.',
    triggers: ['persona', 'system instruction', 'typescript', 'python', 'react', 'nodejs', 'coding standard'],
    instructions: `# System Instructions & Developer Persona Skill
1. Adopt the active Developer Persona (e.g., Senior Full-Stack TypeScript/React, Node.js Backend Architect, Python Specialist).
2. Enforce clean modular architecture, strict TypeScript types, top-level imports, and idiomatic framework patterns.
3. Respect user-defined Custom System Instructions across all generated code, tool calls, and explanations.`
  },
  {
    name: 'structured-code-output',
    category: 'design',
    description: 'Formats generated code cleanly into fenced Markdown language blocks or strict JSON schemas.',
    triggers: ['json', 'markdown', 'format', 'schema', 'structured output', 'code block'],
    instructions: `# Structured Code Output Skill
1. Always wrap generated code in explicit language-tagged Markdown fences (\`\`\`tsx, \`\`\`ts, \`\`\`python, \`\`\`json, \`\`\`html) with clear file path headers.
2. When Structured JSON output is requested, return strictly valid JSON matching the requested schema without trailing prose.`
  },
  {
    name: 'multi-file-context-diff',
    category: 'migration',
    description: 'Reads multiple workspace files together, tracks line-by-line diffs, and preserves cross-file consistency.',
    triggers: ['multi-file', 'diff', 'compare', 'refactor', 'context', 'cross-file'],
    instructions: `# Multi-File Context & Diff Management Skill
1. Use 'read_multiple_files' or 'view_file' to load related frontend, backend, and type definition files before making cross-file edits.
2. Use 'compute_file_diff' or 'git_diff' to verify exact line changes and ensure imports, types, and API contracts stay synchronized.`
  },
  {
    name: 'debugging-error-analysis',
    category: 'workflow',
    description: 'Analyzes stack traces, compiler/lint logs, and runtime failures to diagnose root causes and apply verified fixes.',
    triggers: ['debug', 'error', 'bug', 'fix', 'stack trace', 'crash', 'exception', 'tsc'],
    instructions: `# Debugging & Error Analysis Skill
1. Call 'debug_error_analysis' to collect TypeScript/build diagnostics and inspect failing files.
2. Reproduce or verify logic inside 'code_execution_sandbox' when helpful.
3. Apply targeted surgical fixes via 'replace_file_content', then re-verify with 'compile_applet' and 'lint_applet'.`
  },
  {
    name: 'ultraworkers-claw-harness',
    category: 'workflow',
    description: 'UltraWorkers Claw CLI agent harness integrating file operations, glob/grep search, shell execution, claw doctor, claw acp, claw prompt, and claw status.',
    triggers: ['claw', 'ultraworkers', 'harness', 'claw doctor', 'claw acp', 'claw status', 'claw prompt'],
    instructions: `# UltraWorkers Claw Code Harness Skill
1. Core Capabilities:
   - File Operations: view_file, write_to_file, replace_file_content, delete_file, move, list_dir.
   - Search: grep_search, find_by_name.
   - Shell Execution: run_command, manage_task, code_execution_sandbox.
2. Claw CLI Commands:
   - claw_doctor: Full local environment, configuration, and API connectivity health check.
   - claw_status: Session, loaded skills, background tasks, and memory status inspector.
   - claw_acp: Agent Client Protocol capability and session handshake manager.
   - claw_prompt: Structured task execution harness with configurable agent parameters.
3. Local OpenAI-Compatible & Custom Provider Setup:
   - Works seamlessly with Google Gemini, OpenRouter, Groq, Cerebras, Mistral, and local OpenAI-compatible endpoints.`
  },
  {
    name: 'omo-multi-agent-coordination',
    category: 'workflow',
    description: 'OmO (oh-my-openagent) multi-agent coordination layer with specialized Architect, Executor, and Reviewer sub-agents, automated handoffs, and verification loops.',
    triggers: ['omo', 'oh-my-openagent', 'multi-agent', 'handoff', 'architect', 'executor', 'reviewer', 'consensus'],
    instructions: `# OmO (oh-my-openagent) Multi-Agent Coordination Skill
1. Sub-Agent Specialization:
   - Architect: Decomposes tasks, designs system architecture, defines API contracts, schemas, and file boundaries.
   - Executor: Implements files, writes code, manages dependencies, and applies surgical refactors.
   - Reviewer: Validates code quality, runs verification tools (tsc, lint, build), checks edge-cases, and tests in sandbox.
2. Automated Handoffs & Consensus:
   - Call 'omo_coordinate' to orchestrate handoffs between Architect -> Executor -> Reviewer.
   - Resolve disagreements via consensus voting and persist verified outputs.`
  },
  {
    name: 'omx-structured-execution',
    category: 'workflow',
    description: 'OmX (oh-my-codex) workflow and orchestration layer that translates high-level prompts into structured execution protocols with phased workstreams and verification.',
    triggers: ['omx', 'oh-my-codex', 'protocol', 'staged execution', 'parallel workstream', 'verification loop'],
    instructions: `# OmX (oh-my-codex) Structured Execution Skill
1. Protocol Transformation:
   - Call 'omx_protocol' to translate human instructions into a 3-phase execution blueprint:
     * Phase 1: Problem Decomposition & Invariants Definition.
     * Phase 2: Parallel / Staged Workstream Execution Plan.
     * Phase 3: Persistent Verification Loop (tsc --noEmit, npm run build, runtime sandbox).
2. Execute workstreams sequentially or in parallel while maintaining strict cross-file type consistency.`
  },
  {
    name: 'clawhip-event-routing',
    category: 'workflow',
    description: 'ClawHip out-of-band event and notification router for Git commits, background tasks, GitHub issues & PRs, and agent milestones outside primary LLM context.',
    triggers: ['clawhip', 'event router', 'notification', 'git commit event', 'lifecycle', 'background event'],
    instructions: `# ClawHip Event & Notification Router Skill
1. Out-of-Band Routing:
   - Track background events (git commits, task completions, test results, PRs) via 'clawhip_router'.
   - Keep event logs out of the primary LLM context window to prevent context bloat and distraction.
2. Query event streams on demand when diagnosing regressions or verifying milestones.`
  },
  {
    name: 'code-review',
    category: 'workflow',
    description: 'Reviewer pass on the agent’s own generated code before it is presented as done: correctness, completeness, security, no secrets, no dead code, error handling.',
    triggers: ['review', 'code review', 'check my code', 'review the code', 'quality check', 'is this correct', 'pull request', 'pr review'],
    instructions: `# Code Review Skill
1. Review BEFORE presenting: read every file the build wrote (view_file / read_multiple_files) and check:
   - Correctness: does the code do what the user asked? Every button, form, tab and link works with real state — no dead handlers, no placeholder TODOs.
   - Completeness: all requested features present; no missing imports, no undefined variables, no half-written functions.
   - Errors: compile_applet + lint_applet pass; the live preview loads (verify_live_preview) with no console errors.
2. Report findings as a short list (file:line — what is wrong — how to fix). Fix every finding, then re-verify. Never present code you have not reviewed.
3. On a PR (github_pull_request): review the diff the same way and post the findings as a PR comment before merging.`
  },
  {
    name: 'testing',
    category: 'workflow',
    description: 'Write and run tests for generated code: unit tests for logic, smoke tests for pages, and the verify-then-fix loop. A build is not done until its tests pass.',
    triggers: ['test', 'tests', 'testing', 'unit test', 'run the tests', 'check it works', 'verify', 'smoke test'],
    instructions: `# Testing Skill
1. Write tests for the logic you generate: pure functions get unit tests (run them with code_execution_sandbox); pages get a smoke test (load the preview, check the key elements exist, click the main action).
2. Run the tests with code_execution_sandbox / compile_applet / lint_applet / verify_live_preview. Read the actual output — never claim a test passed without running it.
3. On failure: fix, re-run, repeat (max 2 repair rounds, then report honestly). Record the failure + fix in lessons.md (save_lesson) so the same mistake is not repeated.
4. Bug-fix flow: failing test -> github_issues (file the bug, or log it) -> fix -> re-run tests -> github_pull_request -> github_actions (CI green) -> only then present as done.`
  },
  {
    name: 'security-audit',
    category: 'workflow',
    description: 'Detect secrets and common vulnerabilities in generated code: leaked API keys, XSS, injection, insecure storage, overly broad permissions.',
    triggers: ['security', 'security audit', 'vulnerability', 'secret', 'leaked key', 'xss', 'injection', 'safe', 'audit'],
    instructions: `# Security Audit Skill
1. Scan every generated file before presenting: grep for key-like literals (AIza, sk-, ghp_, xoxb-, AKIA, Bearer tokens, passwords) — a real key in code is a defect, never ship it. Use detect_secrets.
2. Check for common vulnerabilities: XSS (unescaped user input into innerHTML), injection (unsanitised input into queries/commands), secrets in URLs or logs, localStorage holding tokens, overly broad Firebase rules (allow read/write: if true on all paths).
3. Fix what you find: move secrets to env vars / the Keys tab, escape output, validate input, tighten rules. Re-scan after the fix.
4. Never write a real API key, token or password into generated code, config, logs or chat — keys come only from env vars or the Keys tab at runtime.`
  },
  {
    name: 'accessibility',
    category: 'workflow',
    description: 'Make built sites usable by everyone: semantic HTML, keyboard navigation, screen-reader labels, colour contrast, focus states. Check the built page against WCAG basics before presenting it.',
    triggers: ['accessible', 'accessibility', 'a11y', 'screen reader', 'keyboard navigation', 'contrast', 'wcag', 'aria'],
    instructions: `# Accessibility Skill
1. Build with semantic HTML first: <header>, <nav>, <main>, <section>, <footer>, real <button> and <a> (never a clickable <div>), <label> for every input, alt text for every image.
2. Keyboard: every interactive element reachable by Tab, visible focus state, no keyboard traps; modals trap focus and close with Escape.
3. Screen readers: aria-label on icon-only buttons, aria-live for status messages, headings in logical order (one h1), form errors announced.
4. Contrast & motion: text contrast at least 4.5:1 (3:1 for large text); never convey meaning by colour alone; honour prefers-reduced-motion.
5. Before presenting a build, run this check on the preview: Tab through the page once, check labels/alt/contrast. Fix what fails — an inaccessible build is not a finished build.`
  },
  {
    name: 'performance-optimization',
    category: 'workflow',
    description: 'Make built sites fast: small bundles, lazy images, no render-blocking bloat, fast first paint. Check the built page for the obvious performance mistakes before presenting it.',
    triggers: ['fast', 'performance', 'speed', 'slow', 'optimize', 'optimise', 'loading time', 'lighthouse', 'bundle size', 'lazy load'],
    instructions: `# Performance Optimization Skill
1. Keep it light: one CSS file, one JS bundle where possible; no framework for a simple page (vanilla HTML/CSS/JS beats a 200KB framework for a landing page). Tree-shake and minify before deploy.
2. Images: lazy-load below-the-fold images (loading="lazy"), width/height attributes to avoid layout shift, modern formats (WebP/AVIF) with fallbacks, never serve a 2MB photo as a thumbnail.
3. Fonts: system font stack first; if a web font is needed, use font-display: swap and at most two weights.
4. First paint: critical CSS inline, scripts deferred (defer/async), no render-blocking third-party scripts.
5. Before presenting a build, check the preview: total page weight, image sizes, and whether the page renders without waiting on slow requests. Fix the obvious bloat — a slow build is not a finished build.`
  }
];

export function getSkillByName(name: string): SkillDefinition | undefined {
  const normalized = (name || '').trim().toLowerCase();
  return CODING_SKILLS_REGISTRY.find(
    s => s.name.toLowerCase() === normalized || s.name.toLowerCase().includes(normalized)
  );
}

export function listAllSkillsSummary(): Array<{ name: string; category: string; description: string; triggers: string[] }> {
  return CODING_SKILLS_REGISTRY.map(({ name, category, description, triggers }) => ({
    name,
    category,
    description,
    triggers
  }));
}

/**
 * Match skills against a user request using each skill's `triggers` field.
 * Case-insensitive substring matching on the prompt, plus a bonus when the
 * skill name itself (or a hyphen-split part of it) appears in the prompt.
 * Returns up to `maxSkills` skills, best match first. The full instruction
 * text of every skill is kept intact in the registry — this only selects.
 */
export function matchSkillsForPrompt(prompt: string, maxSkills: number = 3): SkillDefinition[] {
  const text = (prompt || '').toLowerCase();
  if (!text.trim()) return [];
  const scored = CODING_SKILLS_REGISTRY.map((skill) => {
    let score = 0;
    for (const trigger of skill.triggers) {
      const t = trigger.toLowerCase().trim();
      if (t && text.includes(t)) score += t.length >= 6 ? 2 : 1;
    }
    const name = skill.name.toLowerCase();
    if (text.includes(name)) score += 3;
    for (const part of name.split('-')) {
      if (part.length >= 4 && text.includes(part)) score += 1;
    }
    return { skill, score };
  }).filter(({ score }) => score > 0);
  scored.sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));
  return scored.slice(0, Math.max(1, maxSkills)).map(({ skill }) => skill);
}
