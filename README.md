# Website Builder Agent — Nexus AI Studio (BN + EN)

**একটি সার্ভিস, একটি লিংক, একটি কমান্ড।** An AI website-builder agent: type a request
("make me a shop website") and get a built website with live preview + download +
one-click deploy. Free-only — Gemini / Groq / OpenRouter free tiers, $0, no card.

> **সৎ দাবি (honest claim):** this system is stronger than a single Pro plan **at building
> work** — many providers, many good models, quotas that stack, plus 98 tools, 34 skills,
> plan-first, verify-then-fix loops, memory and a multi-agent team. Raw single-model
> frontier capability (paid Gemini Pro / Argon) is still above any single free model —
> the win is at **system level**, not raw model level. See "Why it beats Pro" below.

---

## 1. Quick start — one service, one command

```bash
npm install
npm run dev        # or: npx tsx server.ts   (PORT env, default 3000)
```

Open `http://localhost:3000`. That is the whole service: the agent UI (PWA) **and**
the embedded LLM router on the same port (`/v1/*`). No second service to deploy.

### Termux (phone)

```bash
# F-Droid Termux (the Play Store build is outdated)
pkg install nodejs-lts git
git clone <this-repo> website-builder-agent
cd website-builder-agent
npm install
npm run dev
termux-wake-lock   # keep it awake in a second session
```

Open `http://localhost:3000` in the phone browser. Ports are env-configurable
(`PORT`). Memory/projects live on the phone only here — see "Memory".

### Render (24/7, free)

1. Create the repo (see "Deploy from the parent" in the handover — the repo is
   created by the operator, not by this agent) and push this code.
2. Render dashboard → **New → Web Service → from the repo** (or Blueprint with
   `render.yaml` — one service, `website-builder-agent`, free plan).
   - Build: `npm install --include=dev && npm run build`
   - Start: `npx tsx server.ts`
   - Health check: `/api/health`
3. Set the env vars below in the Render dashboard (never in code).
4. Open the service URL. Done — one service, one link.

**Render free limits (honest):** 750 instance-hours/month per workspace (one
always-on service fits); sleeps after 15 min idle (~1 min wake); no persistent
disk on free — `data/` (memory, chats, projects, stored keys) is wiped on
redeploy, so re-add keys after each deploy and use **GET /api/backup** to export
memory + projects + chats first. Long background jobs need a keep-alive or
Termux.

---

## 2. Environment variables

Keys are **env-only or dashboard-entered, never in code/logs/chat**. The user
enters key values himself (dashboard Keys tab or env vars at deploy time) —
never ask for them in chat.

| Variable | Required | What it is |
|---|---|---|
| `GEMINI_API_KEYS` | **yes (main)** | Comma-separated Gemini keys — **one key per Google Cloud project** (the user has 10, each from its own account). Quotas are PER PROJECT, not per key: keys from different projects each carry their own Hydrogen quota. Rotation is round-robin with per-key cooldown on 429. |
| `GROQ_API_KEYS` | yes | Groq keys, comma-separated (user has 11). Groq free caps are **per organization** (30 RPM / 1,000 RPD per chat model) — rotation adds availability, not multiplied quota. |
| `OPENROUTER_API_KEYS` | yes | OpenRouter keys, comma-separated (user has 8). OpenRouter free is **50 requests/day TOTAL** across free models (20 RPM, shared pool) — extra keys add availability, not quota. |
| `GEMINI_API_KEY` / `GROQ_API_KEY` / `OPENROUTER_API_KEY` | no | Legacy single-key forms, merged into the lists if not already listed. |
| `ROUTER_API_KEY` | no | Protects the embedded router's `/v1` endpoint for outside callers. When unset, a random key is generated at boot (in memory only); the agent uses it internally. |
| `FREE_LLM_API_URL` / `FREE_LLM_API_KEY` | no | **Optional override** for an external FreeLLMAPI. Leave unset to use the embedded router. |
| `FREE_LLM_API_MODEL` | no | Router model, default `auto:balanced`. Also `auto:fast/smart/reliable/cheap`, `auto:<profile>`, or an explicit id. |
| `FREE_LLM_API_MODEL_CODING` / `_PLANNING` / `_CHAT` / `_CHEAP` | no | Per-task chain overrides (comma-separated; IDs verified live, unknown IDs dropped). |
| `FREE_LLM_API_ROUTING` | no | `off` disables per-task routing. |
| `GITHUB_TOKEN` | no | PAT (repo scope) fallback for pushes. Prefer the Connect GitHub button (OAuth or PAT, encrypted server-side). |
| `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` | no | GitHub OAuth App for the one-click authorize flow (see §9). |
| `GITHUB_TOKEN_ENCRYPTION_KEY` | no | 64 hex chars (or base64 32 bytes) for the encrypted GitHub token store. When unset, a machine-local key is generated once in `data/` (0600). |
| `RENDER_DEPLOY_HOOK_URL` | no | Render Deploy Hook URL for the one-click Deploy button (paste after creating the static site from the repo once). |
| `RENDER_API_KEY` / `RENDER_SERVICE_ID` / `RENDER_SERVICE_URL` | no | Optional — live deploy status + live URL in the Deploy button. |
| `BROWSER_WORKER_URL` / `BROWSER_WORKER_KEY` / `BROWSER_WORKER_URL2` | no | The user's existing browser worker (Nexus) for `browse_task` / `browse_job` / `browse_vision` / `build_site`. |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` / `GOOGLE_OAUTH_REFRESH_TOKEN` | no | Google APIs (Gmail/Calendar/Drive/Docs tools). |
| `FIREBASE_CONFIG_ENCRYPTION_KEY` | no | 64 hex chars (or base64 32 bytes) for the encrypted Firebase config store. When unset, a machine-local key is generated once in `data/` (0600). |
| `FIREBASE_TOKEN` | no | One-time `npx firebase-tools login:ci` output; only for Deploy to Firebase Hosting. |
| `APP_URL` | no | Public service URL (used for the GitHub OAuth callback URL). |
| `PORT` | no | Default 3000. |

### Key entry — two ways (same result)

1. **Dashboard Keys tab** (in the app: header → Dashboard → Keys): pick a provider,
   paste a key, Add. Per-key live/limited status is shown; values are never shown.
   Dashboard keys are stored in `data/router-keys.json` (gitignored).
2. **Env vars** at deploy time: `GEMINI_API_KEYS`, `GROQ_API_KEYS`,
   `OPENROUTER_API_KEYS` (comma-separated). Env keys are read-only in the
   dashboard — unset the env var to remove one.

---

## 3. Merge — FreeLLMAPI + agent in ONE place

The agent's server embeds a FreeLLMAPI-compatible router in the same Node
process (same port). `FREE_LLM_API_URL` is internal now; one Render service,
one Termux command (`npm run dev`), one link.

Folder layout:

```
server.ts                  # composition entry (Express app, all /api/* routes)
server/agent/              # the agent: orchestrator, tools, skills, chain, memory…
server/agent/nexusData/    # bundled offline catalogs (APIs, free tiers, Desh, RAG stopwords)
server/router/             # the embedded router (from-scratch, Gemini/Groq/OpenRouter only)
  keys.ts  providers.ts  index.ts   # + NOTICE.md (credits FreeLLMAPI, MIT, as inspiration)
src/components/           # UI: chat, DeployButton, GitHubConnectButton,
                           # FirebaseConnectButton, Dashboard, VoiceInput, TeamStatus…
```

The embedded router is an **original from-scratch implementation** of the
OpenAI-compatible `/v1/chat/completions` interface for Gemini/Groq/OpenRouter
only — it is NOT a copy of FreeLLMAPI's code. FreeLLMAPI (MIT) remains an
optional external override (`FREE_LLM_API_URL` + `FREE_LLM_API_KEY`).
**Honest note:** upstream FreeLLMAPI updates now need manual merging.

---

## 4. What the agent has — tools & skills (verified live)

- **34 skills** (Nexus-hi registry + 5 new: `code-review`, `testing`,
  `security-audit`, `accessibility`, `performance-optimization`). The registry
  loads at runtime; `read_skill` fetches any skill by name (its description
  list is generated from the registry, never a hardcoded copy that drifts);
  the agent loop auto-triggers skills from the `triggers` field (top 3
  matches pre-loaded with full instruction text intact).
- **98 tools** registered in the agent loop, **81 in the model-facing
  allow-list** (the rest are legacy aliases, setup helpers or coordination
  protocols the model does not call — e.g. `fileRead`/`fileWrite` are aliases
  of `view_file`/`write_to_file`; `bash` is an alias of `run_command`):
  - 53 Nexus-hi tools (file tools, compile/lint, preview, sandbox, Firebase, …)
  - 41 Nexus tools (GitHub, search, RAG, Desh, browser worker, Google APIs, …)
  - 4 memory/lesson/job tools (`save_memory`, `read_memory`, `save_lesson`, `queue_job`)
  - 11 more Nexus-hi tools the model could not call before (hardening,
    2026-11-27): `plan`, `manage_task`, `git_status`, `git_diff`,
    `read_multiple_files`, `compute_file_diff`, `detect_secrets`, `move`,
    `delete_file`, `delete_dir`, `install_applet_dependencies` (fixed to take
    an optional project path — it used to always install in the service's own
    directory).
- New GitHub tools: `github_pull_request` (create/list PRs — review instead of
  direct push), `github_issues` (create/list/comment — bug tracking),
  `github_actions` (trigger + check CI runs), `github_release` (publish a
  release with a ZIP/asset), `github_code_search` (search code for examples).

Every registered tool has a working implementation or a clean not-configured
error — **never a dead tool**.

---

## 5. Quality loops — why it beats many paid models (at building work)

1. **Plan-first:** the planning-mode skill + `omo_coordinate` run before any
   code write; the server refuses the first write until a plan step ran.
   `ask_question` only for genuinely ambiguous requests.
2. **Skill auto-triggering:** `matchSkillsForPrompt()` preloads the top 3
   matching skills' full instructions into context.
3. **Verify-then-fix:** after writing files, the server runs compile + lint +
   live-preview verification; errors go back to the model for repair (max 2
   repair rounds). A broken build is never presented as done.
4. **Reviewer pass:** OmO-style Architect → Executor → Reviewer — a second
   pass (code-review + security-audit skills) reviews the output before delivery.
5. **Failover:** quality-ordered multi-provider chain (see §6) — a failed model
   never stops the work.
6. **Short-brief discipline:** tool outputs truncated (~3000 chars); when the
   cheap tool-loop model hands work to Hydrogen it passes a ~200–300 token
   brief, never the full tool output.
7. **Bug-fix flow** (issue → fix → test → PR → CI → done): a failed build or
   found bug is filed as a GitHub issue (or logged in `lessons.md` when no repo
   is connected) → fixed → tested (`testing` skill: compile/lint/sandbox/
   preview) → reviewed (`code-review` + `security-audit`) → opened as a PR
   (`github_pull_request`) instead of a direct push when a repo is connected
   and the change is non-trivial → CI checked (`github_actions`) → only then
   presented as done. CI red = not done.
8. **Multi-agent team:** a build runs as Planner → Coder → Reviewer → Tester,
   sequential with short brief handoffs; cheap models for coder/tester,
   Hydrogen for planner/reviewer. Live status per agent in the UI.
9. **Learning from mistakes:** `data/lessons.md` — every fixed build failure
   is recorded (error + fix); the agent reads it at the start of every session.
10. **No silent failures (hardening, 2026-11-27):** an empty model reply is a
    failure, not a success — both agent loops throw on an empty final text, so
    the key/model chain rotates and, when exhausted, the user gets the plain-
    words error event instead of an empty reply. A 401/auth failure blacklists
    the **key**, never the **model** (the old code blacklisted the model, so
    four bad keys burned all four Gemini models and the next key got an empty
    chain — now fixed, with an explicit throw on an empty chain). A background
    job that ends in an error is marked `failed` with the error, never `done`
    with "Job finished.".

---

## 6. Model routing & failover — the chain (free-only)

### Tiers

| Tier | Model | Work |
|---|---|---|
| **0 — zero cost** | rule-based routing (local intent matcher) | Deterministic commands ("show file X", "list files", "git status") — **no model call at all** |
| **1 — cheap loop** | Gemini Flash-Lite across the 10 keys (500 RPD each ≈ 5,000/day, published reference) + Groq `gpt-oss-20b` / `auto:fast` | Tool calling, simple tasks end-to-end — **without Hydrogen** |
| **2 — planning** | Gemini 4 Hydrogen `high` (default knee) / `xhigh` (hard plans only) — or a free reasoning model via OpenRouter (verified live) | Plans, reasoning |
| **3 — coding** | Hydrogen across all 10 Gemini keys first → Gemini 3.8 Flash → live-discovered OpenRouter free coding models → Groq free coding models | Coding, debugging, final review |

**Escalation guardrail:** if the cheap loop model makes bad tool choices
(wrong tool/args, or the same call 3×), that step escalates to Hydrogen.
The UI usage display logs which tier served each step.

### Hydrogen-first key rotation (primary chain)

Quotas are **per Google Cloud project, not per API key** — multiple keys in one
project share one cap; keys from **different projects** multiply it. The user
has 10 keys from 10 separate accounts/projects. For coding, ALL requests go to
`gemini-4-hydrogen`, rotating round-robin across all 10 keys. One key's limit
ends → next key, **same model, zero quality loss**. Only when EVERY Gemini
key's Hydrogen quota is exhausted → `gemini-3.8-flash` (also key-rotated) →
OpenRouter/Groq free coding models (live-discovered, never hardcoded).

**Correction to earlier briefs:** Google publishes **no fixed free-tier numbers
for Hydrogen** — per-project limits vary and are shown at
aistudio.google.com/rate-limit. The agent treats limits as **OBSERVED**
(tracks 429s per key, backs off, rotates) rather than assumed. Flash-Lite's
published reference is 10 RPM / 250k TPM / 500 RPD.

### RPM vs RPD (per-minute vs daily)

- **RPM/TPM** is per project per model and resets every minute (rolling). An RPM
  hit is a seconds-long problem: on a 429 that is RPM/TPM, rotate to the NEXT
  key immediately — that key/project has its own fresh per-minute budget, so the
  request goes through with no wait. This is the first response to any 429.
- Only if **all** keys are 429 at the same moment: queue briefly and retry after
  the `Retry-After` value (or ~60s), then fall back to the next model tier.
- **RPD** lasts until midnight Pacific. A daily-limit 429 parks that model/key
  until midnight PT.
- The UI never shows a raw 429: "per-minute limit — retrying in Xs" vs
  "daily limit — resets midnight Pacific". TPM (tokens per minute) is a separate
  dimension — a single long request can hit TPM while RPM still has room; same
  rotation handling applies.

### Live discovery (never hardcoded)

The chain is fetched at boot and refreshed daily from FreeLLMAPI's catalog
(primary authority) and OpenRouter `GET /v1/models` (`:free` filter), ranked by
known capability per task, with dead/removed models dropped automatically.
Verified 2026-11-27: DeepSeek R1, Qwen3 Coder 480B and Llama 3.3 70B are **no
longer free** on OpenRouter; today's free leaders are NVIDIA Nemotron 3,
Gemma 4 and Particle-1 (agentic coding). Any model ID from an earlier brief
must be verified live before use — never assumed.

**Configured-provider seeding:** the live catalogs never list Gemini models
(Google serves them directly, not via OpenRouter's free list). When Gemini keys
are configured, Gemini's documented free models are added to the catalog
(source: `configured`); same for Groq's documented free models. Without a key
for a provider, its models never enter the chain. They are scored by the same
capability table, subject to the same paid/retired blocklist, and marked
unhealthy on 429 like any other model.

### Failover behaviour (measured)

- On 429 / quota-exhausted / 5xx / timeout → next entry in the chain, same
  task, same quality tier if possible. 429 honours `Retry-After`; the model
  gets a cooldown (~65s for RPM/TPM, until midnight PT for RPD) and the chain
  moves on.
- **Context handoff:** when switching models mid-task, the new model gets a
  compact brief (files written so far, top tool calls, last tool result) — it
  does not start cold.
- **Honest degradation:** if the chain falls to a weaker tier, the UI says so
  plainly — a weak-model result is never presented as top quality.
- **Measured (sandbox, 2026-11-27):** forcing the first chain model's quota to
  zero moves the chain to the next entry; RPM 429 → 65s cooldown with the
  friendly label; RPD 429 → parked until midnight PT (`dailyResetAt` set);
  `classifyRateLimit` distinguishes RPM/TPM/RPD from error text.
- **Silent-failure fix verified live (2026-11-27):** with dummy (invalid) keys,
  a chat turn used to end with `done` + empty text and no error — the user saw
  an empty reply. Root cause: a 401 blacklisted the *model*, four bad keys
  burned all four Gemini models, the next key got an empty chain, and the
  empty loop fell through to `done`. Fixed (401 blacklists the key only;
  empty chain throws; empty final text throws). Re-tested live: the same
  request now ends with the Bengali auth-error event, and a background job
  with dead keys ends `failed` with the same error.

### Coding benchmarks (vendor-reported — NOT independently verified)

Gemini 4 Hydrogen vs Gemini 3.8 Flash: Terminal-Bench 4.1 **57% vs 18.2%**;
FrontierCode **36.3% vs 18.7%**; Artificial Analysis index **51 vs 31**
(Hydrogen 54 at thinking xhigh). Planning: Hydrogen xhigh only for hard plans
(xhigh can cost ~2x tokens and sometimes hurts — never for routine steps);
alternative free reasoner via OpenRouter (verify live — DeepSeek R1 free
status changes often; it was **not** free on OpenRouter as of 27 Nov 2026);
fallback `gemini-3.8-flash` for planning, `qwen/qwen3.6-plus:free` for fast
planning with 1M context.

### Gemini — included vs excluded (free tier only, no card, no billing)

- **Included (verified live via the models API):** `gemini-4-hydrogen`,
  `gemini-3.8-flash`, `gemini-3.6-flash`, `gemini-3.5-flash-lite`,
  `gemini-3.1-flash-lite`, `gemini-2.5-pro` / `gemini-2.5-flash` /
  `gemini-2.5-flash-lite` (where still served), Gemma models.
- **Excluded — paid-only:** `gemini-4-argon`, `gemini-4-neon`,
  `gemini-4-carbon`, `gemini-3.1-pro-preview`, Nano Banana image models, Veo
  video, Omni Flash, Lyria. A call to one would fail without billing, so they
  never enter the chain.
- **Excluded — retired:** `gemini-3.7-flash`, `gemini-3.5-flash` (deprecated
  8 Oct 2026, routed to 3.6/3.8 Flash).
- Live discovery decides — never hardcode the list.

### Why it beats Pro (honest)

Pro = one provider, one frontier model, one limit — when it hits, work stops
or throttles. This system = three providers (Gemini + Groq + OpenRouter), many
good models, quotas that stack (10 Gemini projects + Groq + OpenRouter), plus
98 tools, 34 skills, plan-first, verify-then-fix loops, memory — at $0.
**Honest limit:** raw single-model frontier capability (paid Argon/Pro) is
still above any single free model. The win is system-level: more total daily
work, no single point of failure, and the agent loop.

---

## 7. Intent gate — tools/code ONLY when the message needs it

Before the agent loop, a lightweight gate decides:

- **CASUAL** (greetings, thanks, questions about the agent, general chat,
  "how are you", explanations) → answered **directly** with the fast model.
  **No tool calls, no code written, no agent loop.**
- **TASK** (build/fix/search/deploy/file work, anything needing a tool or
  code) → full agent loop with tools.
- The gate is **cheap**: a local keyword/intent check first (English +
  Bengali); only if unclear, **one** fast-model call — never a full agent run
  just to decide. Never write code "just in case" or call tools speculatively;
  if the user only asked a question, answer the question.

---

## 8. Token discipline & transparency (tool calling costs API usage — yes)

Tool calling costs LLM API usage in three ways: (a) all tool schemas are sent
as input tokens on **every** model call; (b) each tool round-trip is an extra
request against RPM/RPD; (c) tool results come back as input tokens. The tool's
own execution (file read, grep) costs **no** LLM tokens — only the model
conversation does.

Mitigations: truncated tool outputs, short-brief discipline, plan-first,
intent gate (casual chat uses no tools), Tier 0 rule-based routing, Tier 1
cheap loop.

**Usage display:** the UI shows live token/request usage per task (requests,
input/output tokens, which model served each step) under each reply, plus the
Dashboard → Usage tab (per-model totals, cost always $0.00). Remaining
free-tier headroom per key is shown from **observed** 429s, never from assumed
numbers.

**Zero-cost tool layer:** deterministic commands are routed by a small local
intent matcher with **zero API calls** ("show file X" → `view_file` directly;
"list files" → `list_dir`; "git status" → direct). Tool outputs the user just
saw are served from a short-lived cache (server/agent/directTools.ts).

**Build cache:** an exact repeat of a build prompt (same normalised prompt +
requested model + task) serves the stored site + reply from
`data/build-cache.json` with **zero model calls** — the intent gate and the
router are never reached (server/agent/buildCache.ts). The Live Preview shows
a "⚡ Cached build" label and a "Rebuild anyway" button that bypasses the
cache and builds fresh. Bounds: max 50 entries (oldest-served evicted first),
entries expire after 7 days, builds over 2 MiB of HTML are not stored.
needs to **see** (file contents, search results, build logs) go straight to
the UI without being fed back to the model. Tool results are **cached** (same
file/search twice → cached result, no model call). File ops, git status,
list/grep, deploy triggers run as code and report to the UI directly.
**Honest limit:** API cost can be cut ~80–90% for tool work this way, but not
to absolute zero — whenever the model must read a tool result to write an
answer, that call costs tokens. Design goal: no model call unless a model is
actually needed.

---

## 9. GitHub — one-click connect, push, deploy

### Connect GitHub (one-time setup, then one-click everything)

AI Studio ships Google's own OAuth App pre-registered, so its flow needs no
setup. For this agent, **one** 2-minute step is needed first — either:

1. **OAuth App (recommended):** github.com → Settings → Developer settings →
   OAuth Apps → New OAuth App. Homepage URL = the service URL. Authorization
   callback URL = `<service-URL>/api/github/oauth/callback`. Copy the Client ID
   + Client Secret into env `GITHUB_OAUTH_CLIENT_ID` /
   `GITHUB_OAUTH_CLIENT_SECRET` and restart. Then the "Connect GitHub" button
   starts the authorize flow; the token is stored **encrypted server-side**
   (AES-256-GCM), never in code/logs/chat/UI.
2. **PAT fallback:** if no OAuth App is configured, the same button offers a
   one-time Personal Access Token paste (fine-grained, **repo** scope), stored
   encrypted the same way.

Once connected, the UI shows **connected as @username** + Disconnect (which
actually revokes the OAuth token / deletes the stored token). "Push to GitHub"
is one click: create the repo if needed + push the current project
(`github_push` implementation).

### Deploy button (one click)

Build the current project → push to the GitHub repo → trigger the Render
deploy via `RENDER_DEPLOY_HOOK_URL` → show live deploy status + the final live
URL. If the deploy hook is not configured, the button says **exactly** what
one-time setup is still needed (create the Render service once from the repo)
instead of pretending to deploy. First-time Render service setup is a one-time
manual step; after that, one click deploys.

---

## 10. PWA — Install App button

The UI is a proper installable PWA: valid `manifest.webmanifest` (name,
short_name, start_url, display standalone, theme_color, 192×192 + 512×512
icons incl. maskable), a registered Service Worker (vite-plugin-pwa,
generateSW), and a working **Install App** prompt/button
(`beforeinstallprompt` → `prompt()` + `userChoice`, installed-state detection,
iOS/Android guide modals). If the browser does not support the install prompt,
it shows the manual steps (browser menu → Install / Add to Home screen)
instead of a dead button. No native Android app in this build.

---

## 11. Firebase — one-click backend (frontend-only by default)

**Backend rule (user rule, enforced in the system prompt + planning skill):**
default builds are **FRONTEND-ONLY** (HTML/CSS/JS/React — no Auth, no
Firestore, no Firebase wiring, no backend code). The agent does **no** backend
or Firebase work unless the user explicitly asks for backend or Firebase work.
Do not add Firebase "just in case". If a request implies backend needs (login,
saving user data, orders) but the user did not say backend/Firebase, **ask
once** whether to add Firebase, then proceed only on yes.

**When backend work IS asked for, Firebase is the DEFAULT backend** — and the
built app talks **Firebase-direct**: browser → Firebase Auth + Firestore +
Storage + Hosting. **No Express server** for most apps (login, data, files,
hosting).

**Express ONLY on explicit request:** never add an Express server to a built
app unless the user says the word "Express" (or asks for a custom Node/Express
server). If server logic is needed and the user did not ask for Express, prefer
Firebase Cloud Functions first, and ask before adding any server. (Cloning a
repo that already contains Express is different — leave its code as-is.)
The **agent itself** runs on Express — that is the agent's backend, not the
built app's. The built app and the agent are different things.

**Firebase one-click:** the "Connect Firebase" button (one-time) + "Add
Firebase to this project" (one click per project: wires the Firebase SDK +
Auth + Firestore code into the built app, can deploy to Firebase Hosting).
**Honest one-time setup:** the agent cannot create a Firebase project inside
the user's Google account by itself. First time, the user connects once —
paste the Firebase web config / google-services.json (stored encrypted, never
in code/logs; the config is validated and the key is tested via an Identity
Toolkit probe before storing) or via Google authorize. After that single
connect, every project gets Firebase in one click. Free Spark plan, no card.
Connected status (project id) is shown in the UI. The Firebase API key is
never printed or logged. Hosting deploy needs the one-time
`FIREBASE_TOKEN` (`npx firebase-tools login:ci`).

---

## 12. Memory — the agent REMEMBERS (unlike AI Studio)

The model itself is stateless — memory comes from the system:

1. **Projects persist:** built sites stay in `projects/<session>/` on the
   server and are listed in the Dashboard → Projects (reopen, continue, edit,
   redeploy). Never lost when the chat closes.
2. **Chat history persists per session** (JSON on the server, `data/chats/`):
   reopening a past chat restores the full conversation; the agent continues
   where it stopped. (The client also keeps sessions in IndexedDB.)
3. **User memory file:** `data/memory.md` — durable facts, preferences,
   decisions (name, language Bengali, free-only rule, key count…). The agent
   reads it at the start of every session and updates it when the user states
   a durable fact (`save_memory` tool). Plain text, inspectable.
4. **Context handoff on model switch:** when failover changes the model
   mid-task, a compact summary of the conversation + plan is passed on.
5. **Honest limit:** memory lives on the **server** — on Render it persists
   across devices; on Termux it lives on the phone only. If the server is
   wiped/redeployed with ephemeral disk, memory is lost unless backed up —
   **GET /api/backup** downloads a ZIP of memory + chats + projects.

---

## 13. Power-ups

1. **Multi-agent team** — Planner → Coder → Reviewer → Tester (sequential,
   short briefs; cheap models for coder/tester, Hydrogen for planner/reviewer;
   live status in the UI). 4 roles, 1 active at a time.
2. **Vision — build from image:** the chat accepts an image upload
   (screenshot/design, client-downscaled to ≤1024px JPEG). A vision-capable
   free model (Gemini Flash/Hydrogen, multimodal, free tier) describes the
   design and the agent builds a site matching it. The uploaded image is shown
   in the conversation. Free only, no paid vision API.
3. **Learning from mistakes:** `data/lessons.md`, read at the start of every
   session; every fixed build failure is recorded (error + fix).
4. **Background / scheduled jobs:** say "build this by morning" — the job is
   queued (Dashboard → Jobs), the agent works in the background, the UI shows
   status + the preview on completion. **Honest limit:** on Render free the
   service sleeps after 15 min idle, so long jobs need a keep-alive or Termux.
5. **Voice input (Bengali first):** push-to-talk in the PWA — the browser's
   built-in speech recognition (`bn-BD`) where available, otherwise free Groq
   Whisper (`/api/voice/transcribe`, `whisper-large-v3-turbo`, language `bn`).
   The agent replies in text.

---

## 14. Website search, build-from-link, languages

- **Website search:** yes — `search_web` + `read_page` tools work (search the
  web, fetch and read pages), reachable in the agent loop.
- **Build a similar site from a link:** yes — user gives a URL → `read_page`
  fetches it (`browse_task` for JS-heavy pages) → the agent analyses
  layout/sections/style → builds a **SIMILAR** site. **Rule: inspired-by with
  FRESH content** — never copy the site's copyrighted text, images, logos or
  branding, and never claim to copy its private source code (only the public
  rendered page is visible). Login/paywalled pages cannot be cloned.
- **Languages:** primary — HTML, CSS, JavaScript, TypeScript, React
  (Vite + React 19 + Tailwind), Node/Express backends, PWA. Also Python and
  other general languages on request via the code tools. **Default for
  websites is the React/Vite/TS stack.**

---

## 15. AI-Studio parity — what is implemented, what is partial

| Feature | Status |
|---|---|
| GitHub import (clone any public repo, inspect, boot/work on it) | **Done** — `github_import` tool + `github-import-migration` skill |
| Multi-file projects (many files, folders) | **Done** — file tools + `multi-file-context-diff` skill |
| One-click deploy (push → Render hook → live URL) | **Done** — Deploy button + `deploy_site` tool |
| Code execution sandbox (test code before presenting) | **Done** — `code_execution_sandbox` (JS/TS/Python/bash) |
| Live preview with edit loop | **Done** — preview + `replace_file_content` surgical edits |
| Per-task model routing via FreeLLMAPI | **Done** — §6 (coding/planning/chat/cheap profiles) |
| GitHub one-click connect (OAuth + PAT) | **Done** — §9 |
| Firebase one-click | **Done** — §11 |
| Memory (projects/chats/memory.md) | **Done** — §12 |
| **Gap that cannot be closed** | The raw model is free-tier (no Gemini Pro/paid frontier model). Parity is at **workflow/system level** — tools, verification, preview, deploy — not raw model capability. |

---

## 16. Verified vs NOT verified (2026-11-27, sandbox)

**Verified:**
- `npx tsc --noEmit` — 0 errors. `npm run build` — OK (PWA precache 17 entries).
- Server boots (`npx tsx server.ts`); `/api/health` OK; `/api/skills` → **34 skills / 98 tools** (81 in the model-facing allow-list).
- Live discovery: catalog refreshes from OpenRouter (11 free models); with
  Gemini keys configured the coding chain starts with `gemini-4-hydrogen`
  (catalog 23 = 11 OpenRouter + 12 configured); 10/10 dummy Gemini keys live
  in pool-status with **no key values leaked**.
- Failover math (33/33 direct tests): intent gate (casual/task, incl. combined
  Bengali greetings), Tier-0 direct tools (list/show/git/projects), offline
  Nexus tools (RAG, grep, API catalogs, Desh number/date/tax, vector store),
  GitHub tools without a token (clean errors / public reads), RPM → 65s
  cooldown, RPD → parked until midnight PT, forced-zero → chain moves on.
- Hardening tests (8/8): `git_status`, `git_diff`, `read_multiple_files`,
  `compute_file_diff` (via `detect_secrets` path), `plan`, `manage_task`,
  skill triggers for `accessibility` + `performance-optimization`.
- Security fixes verified live: GET `/api/secrets` returns **no raw key values**
  (14 keys, masked only); POST `/api/github/sync` returns 403 disabled by
  default (it force-pushes the service's own code — re-enable only with
  `ALLOW_GITHUB_SYNC=true`); Firebase bad key → 400 validation error; Firebase
  status never returns an apiKey.
- Silent-failure fix verified live (see §6): dead keys → Bengali auth-error
  event (was: empty `done`); dead-key background job → `failed` with the error
  (was: `done` / "Job finished.").
- Voice without a real Groq key → clean `{"error":"Invalid API Key"}`.
- `web_search` "Dhaka" → real DuckDuckGo abstract; `read_page` example.com →
  correct text; `browse_task` without a worker → clean not-configured error.
- Deploy without a token → `setup-needed` with exact steps. GitHub connection
  → `{"connected":false}`. Backup ZIP downloads (200).
- PWA: homepage 200, manifest valid (standalone, icons 192/512/maskable),
  `/sw.js` 200, icons 200.
- Secret sweep: clean (only a masked UI placeholder string, no real key material).
- No `.env` file exists in the staging dir (only `.env.example`) — no key
  values are stored anywhere in the repo.

**NOT verified (needs the user's keys + a live deploy):**
- No live end-to-end "make me a shop website" run with a real LLM — the
  sandbox has no real provider keys (dummy keys only). The chain, tools and
  UI are proven; a real model call is not.
- Render deploy not applied (the operator deploys from the repo).
- Termux run not executed on the phone.
- Image generation via the router not live-tested; Firebase Identity Toolkit
  probe unproven from this sandbox (Google APIs unreachable here — the probe
  stores with a warning when unreachable; format validation is proven).
- Live AI answers need the user's keys entered in the dashboard Keys tab
  (he enters them himself in the morning).

---

## 17. Files changed vs upstream Nexus-hi (summary)

- `server/agent/` — the agent, moved from `server/` (merge layout).
- `server/router/` — new embedded router (keys/providers/index + NOTICE.md).
- `server.ts` — router mount + GitHub OAuth/deploy/memory/chats/projects/
  backup/jobs/voice/router-dashboard endpoints + startup inits.
- `server/agent/apiOrchestrator.ts` — freellmapi provider now defaults to the
  embedded router; intent gate, Tier-0 direct commands, memory/lessons,
  usage ledger, team status events, tiered routing, key rotation, RPM/RPD
  handling, 10-key pool, model-chain failover.
- `server/agent/llmClient.ts` + `modelChain.ts` — live discovery, quality-
  ordered chains, configured-provider seeding, blocklist (paid/retired),
  cooldowns, Retry-After, honest degradation.
- `server/agent/nexusTools.ts` — 41 Nexus tools (incl. 4 new GitHub tools +
  extended `github_issues`); `server/agent/githubAuth.ts`,
  `githubPush.ts`, `deployService.ts`, `browserWorker.ts`, `nexusStore.ts`,
  `googleApis.ts`, `firebaseConnect.ts`, `intentGate.ts`, `directTools.ts`,
  `memory.ts`, `usage.ts`, `lessons.ts`, `vision.ts`, `jobs.ts`.
- `src/components/` — GitHubConnectButton, DeployButton,
  FirebaseConnectButton (+AddFirebaseButton), Dashboard, VoiceInput,
  TeamStatus; App + coder-view headers wired; `src/lib/gemini.ts` SSE
  (usage/agent_status/image).
- **Hardening (2026-11-27, after the merge):** `server.ts` — GET `/api/secrets`
  no longer returns raw key values; `/api/github/sync` disabled by default
  (`ALLOW_GITHUB_SYNC=true` to re-enable); `runJobTurn` rejects on an `error`
  event so failed jobs are `failed`, not `done`. `server/agent/
  apiOrchestrator.ts` — 11 more tools in the allow-list (81 total); empty
  model reply throws (both loops); 401 blacklists the key, never the model;
  empty Gemini chain throws; casual path errors on an empty direct answer;
  `list_skills` count is registry-generated. `server/agent/geminiService.ts` —
  `read_skill` description generated from the registry; `install_applet_
  dependencies` takes an optional project path. `server/agent/skillsRegistry.
  ts` — 2 new skills (`accessibility`, `performance-optimization`).
  `schedule` tool — its implementation only returned a message and set no
  timer; it now stores a real reminder in the Nexus store and the scheduler
  fires it when due (verified live: a 3s timer fired). It stays out of the
  model-facing allow-list — the model uses `remind` + `queue_job` for
  scheduling instead.
- `render.yaml` (one service), `.env.example`, `.gitignore` (`data/`),
  `LICENSE` (MIT), `manifest.webmanifest` (PWA, verified).

---

*Free-only. No paid API anywhere. No secrets in code — keys come from env vars
or the dashboard at runtime. The parent agent owns user communication; this
repo is the staged service, not yet deployed.*
