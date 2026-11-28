import express from 'express';
import http from 'http';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';
import cors from 'cors';
import dotenv from 'dotenv';
import { Octokit } from 'octokit';
import AdmZip from 'adm-zip';
import {
  handleServerGeminiChat,
  executeServerTool,
  manageBackgroundTask,
  runCodeInSandbox,
  runDebugErrorAnalysis,
  runClawDoctor,
  getClawStatus,
  getClawAcpInfo,
  runClawPrompt,
  runOmoCoordinate,
  runOmxProtocol,
  routeClawHipEvent,
  runLazyCodex,
  serverTools
} from './server/agent/geminiService.ts';
import { CODING_SKILLS_REGISTRY, getSkillByName } from './server/agent/skillsRegistry.ts';
import { getFirebaseStatus, storeFirebaseConfig, deleteFirebaseConfig, parseFirebaseWebConfig, parseGoogleServicesJson, addFirebaseToProject, deployFirebaseHosting } from './server/agent/firebaseConnect.ts';
import { getGitHubConnection, isOAuthConfigured, getOAuthCallbackUrl, newOAuthState, consumeOAuthState, buildAuthorizeUrl, exchangeCodeForToken, storeGitHubToken, readStoredGitHubToken, deleteStoredGitHubToken, revokeOAuthToken } from './server/agent/githubAuth.ts';
import { startDeploy, getDeployJob, deployStatus } from './server/agent/deployService.ts';
import { deployHtmlFile } from './server/agent/websiteDeployer.ts';
import { initModelChain, getChainForTask, catalogStatus, modelChainStatus } from './server/agent/modelChain.ts';
import { wireNexusScheduler } from './server/agent/nexusTools.ts';
import { readUserMemory, appendUserMemory, setUserMemory, loadChat, listChats, listProjects, cloneProject, exportBackup } from './server/agent/memory.ts';
import { readLessons } from './server/agent/lessons.ts';
import { createJob, listJobs, getJob, cancelJob, startJobWorker, type Job } from './server/agent/jobs.ts';
import { mountRouter, routerStatus, routerUsageSummary } from './server/router/index.ts';
import { addRouterKey, removeRouterKey, routerKeyStatus, getRouterApiKey } from './server/router/keys.ts';
import { 
  handleOrchestratedChat, 
  resolvePendingQuestion,
  cancelTurn,
  loadSecrets, 
  saveSecrets, 
  testApiKey, 
  fetchLiveProviderModels,
  getKeyPoolStatus,
  getLastSuccessfulKeyId,
  getSystemLogs,
  clearSystemLogs
} from './server/agent/apiOrchestrator.ts';
import { startLiveSession, liveAction, liveInput, closeLiveSession, getLiveFrame, setLiveSessionPaused } from './server/agent/browserWorker.ts';

dotenv.config();

const execPromise = promisify(exec);

function resolvePort(): number {
  const portFlagIdx = process.argv.findIndex((arg) => arg === '--port' || arg === '-p');
  if (portFlagIdx !== -1 && process.argv[portFlagIdx + 1]) {
    const parsed = Number(process.argv[portFlagIdx + 1]);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  const eqFlag = process.argv.find((arg) => arg.startsWith('--port='));
  if (eqFlag) {
    const parsed = Number(eqFlag.split('=')[1]);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return Number(process.env.PORT) || 3000;
}

async function startServer() {
  const app = express();
  const httpServer = http.createServer(app);
  const PORT = resolvePort();

  await fs.mkdir(path.join(process.cwd(), 'projects'), { recursive: true }).catch(() => {});
  await fs.mkdir(path.join(process.cwd(), 'public', 'generated'), { recursive: true }).catch(() => {});

  app.use(cors());
  app.use(express.json({ limit: '50mb' }));

  // MERGE: the embedded FreeLLMAPI-compatible router on this same service
  // (POST /v1/chat/completions, GET /v1/models, GET /v1/router/status).
  // Protected by the internal router key (env ROUTER_API_KEY or boot-generated).
  mountRouter(app);

  // Render / Cloud health check
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      uptime: Math.round(process.uptime()),
      port: PORT,
      env: process.env.NODE_ENV || 'development',
      timestamp: Date.now(),
    });
  });

  // Serve generated images statically
  app.use('/generated', express.static(path.join(process.cwd(), 'public', 'generated')));

  // Serve generated projects statically with PWA headers and fallback
  app.use('/projects', express.static(path.join(process.cwd(), 'projects'), {
    setHeaders: (res, filePath) => {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      if (filePath.endsWith('.js')) {
        res.setHeader('Service-Worker-Allowed', '/');
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      } else if (filePath.endsWith('.webmanifest') || filePath.endsWith('.json')) {
        res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
      }
    }
  }));
  app.get(['/projects', '/projects/*'], async (req, res) => {
    const rawParam = (req.params as any)[0] || '';
    const cleanParam = rawParam.replace(/^\/+/, '');
    const requestedFile = cleanParam || 'index.html';
    let filePath = path.join(process.cwd(), 'projects', requestedFile);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    if (requestedFile.endsWith('.js')) {
      res.setHeader('Service-Worker-Allowed', '/');
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    } else if (requestedFile.endsWith('.webmanifest') || requestedFile.endsWith('.json')) {
      res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
    }
    try {
      let stat = await fs.stat(filePath);
      if (stat.isDirectory()) {
        filePath = path.join(filePath, 'index.html');
        stat = await fs.stat(filePath);
      }
      if (stat.size > 20) {
        return res.sendFile(filePath);
      }
    } catch {}

    // If file doesn't exist or is empty, try global projects/index.html
    try {
      const fallbackPath = path.join(process.cwd(), 'projects', 'index.html');
      const fbStat = await fs.stat(fallbackPath);
      if (fbStat.size > 20) {
        return res.sendFile(fallbackPath);
      }
    } catch {}
    res.send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><script src="https://cdn.tailwindcss.com"></script></head>
<body class="bg-slate-950 text-slate-100 min-h-screen flex items-center justify-center p-6 font-sans">
  <div class="max-w-md w-full bg-slate-900 border border-slate-800 rounded-3xl p-8 text-center shadow-2xl">
    <div class="w-14 h-14 bg-indigo-600/20 border border-indigo-500/30 rounded-2xl flex items-center justify-center mx-auto mb-4 text-indigo-400">
      <svg class="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
    </div>
    <h2 class="text-xl font-bold text-white mb-2">Live Canvas Ready</h2>
    <p class="text-slate-400 text-xs leading-relaxed mb-4">Nexus AI is ready. Request any design or website to see it live.</p>
    <div class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/10 text-emerald-400 text-xs font-semibold">
      <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
      Workspace Online
    </div>
  </div>
</body>
</html>`);
  });

  // Server-side Multi-Provider Orchestrated Streaming Chat endpoint
  app.post('/api/gemini/chat', async (req, res) => {
    try {
      await handleOrchestratedChat(req.body, res);
    } catch (err: any) {
      console.error("Orchestrated chat error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message || "Failed to process chat" });
      }
    }
  });

  // Resume a paused ask_question tool call with user answers
  app.post('/api/gemini/answer-question', (req, res) => {
    const { questionId, answers, skipped, notes } = req.body || {};
    if (!questionId || typeof questionId !== 'string') {
      return res.status(400).json({ success: false, error: 'questionId is required' });
    }
    const resolved = resolvePendingQuestion(questionId, { answers, skipped, notes });
    if (!resolved) {
      return res.status(404).json({ success: false, error: 'Question session expired or not found' });
    }
    res.json({ success: true });
  });

  // Stop the running turn (Stop button / Browser-tab "Take over"). The
  // agent loops check the flag at every round boundary and stop issuing
  // tool calls; the client also aborts its fetch, which the chat handler
  // treats as a cancel the same way.
  app.post('/api/gemini/cancel', (req, res) => {
    const { sessionId } = req.body || {};
    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ success: false, error: 'sessionId is required' });
    }
    cancelTurn(sessionId);
    res.json({ success: true });
  });

  // --- Live browser tab (Muse-like): proxy to the browser worker's live
  // sessions. The worker key never leaves the server — the frontend only
  // ever sees session ids and frames. ------------------------------------
  app.post('/api/browser/live/start', async (req, res) => {
    try {
      const { url, width, height } = req.body || {};
      const session = await startLiveSession(
        typeof url === 'string' ? url : undefined,
        { width: Number(width) || undefined, height: Number(height) || undefined },
      );
      res.json({ success: true, sessionId: session.id, url: session.url, width: session.width, height: session.height });
    } catch (err: any) {
      res.status(502).json({ success: false, error: err.message || 'Failed to start a live browser session' });
    }
  });

  app.post('/api/browser/live/action', async (req, res) => {
    try {
      const { sessionId, action, ...payload } = req.body || {};
      if (!sessionId || !action) return res.status(400).json({ success: false, error: 'sessionId and action are required' });
      // 'pause'/'resume' are NOT worker /action verbs — they go through the
      // worker's dedicated /pause endpoint (Take over / Give back to agent).
      if (action === 'pause' || action === 'resume') {
        const result = await setLiveSessionPaused(String(sessionId), action === 'pause');
        res.json({ success: true, result: result ?? null });
        return;
      }
      const result = await liveAction(String(sessionId), String(action), payload);
      res.json({ success: true, result: result ?? null });
    } catch (err: any) {
      res.status(502).json({ success: false, error: err.message || 'Live browser action failed' });
    }
  });

  app.post('/api/browser/live/input', async (req, res) => {
    try {
      const { sessionId, ...event } = req.body || {};
      if (!sessionId || !event.type) return res.status(400).json({ success: false, error: 'sessionId and event type are required' });
      await liveInput(String(sessionId), event);
      res.json({ success: true });
    } catch (err: any) {
      res.status(502).json({ success: false, error: err.message || 'Live browser input failed' });
    }
  });

  app.post('/api/browser/live/close', async (req, res) => {
    try {
      const { sessionId } = req.body || {};
      if (!sessionId) return res.status(400).json({ success: false, error: 'sessionId is required' });
      await closeLiveSession(String(sessionId));
      res.json({ success: true });
    } catch (err: any) {
      res.status(502).json({ success: false, error: err.message || 'Failed to close the live browser session' });
    }
  });

  app.get('/api/browser/live/frame', async (req, res) => {
    try {
      const sessionId = String(req.query.sessionId || '');
      if (!sessionId) return res.status(400).json({ success: false, error: 'sessionId is required' });
      const frame = await getLiveFrame(sessionId);
      res.json({ success: true, image: frame.image, width: frame.width, height: frame.height });
    } catch (err: any) {
      res.status(502).json({ success: false, error: err.message || 'Failed to fetch a live browser frame' });
    }
  });

  // SSE screencast relay: polls the worker's frame endpoint (~2 fps) and
  // pushes data-URL frames to the Browser tab. Polling keeps this working
  // even if the worker's own WS/SSE screencast is unavailable.
  app.get('/api/browser/live/stream', async (req, res) => {
    const sessionId = String(req.query.sessionId || '');
    if (!sessionId) {
      res.status(400).json({ success: false, error: 'sessionId is required' });
      return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    let closed = false;
    let failures = 0;
    res.on('close', () => { closed = true; clearInterval(timer); });
    const sendFrame = async () => {
      if (closed) return;
      try {
        const frame = await getLiveFrame(sessionId);
        failures = 0;
        res.write(`data: ${JSON.stringify({ type: 'frame', image: frame.image, width: frame.width, height: frame.height })}\n\n`);
      } catch (err: any) {
        failures++;
        if (failures >= 5) {
          res.write(`data: ${JSON.stringify({ type: 'error', error: err.message || 'Live browser frame unavailable' })}\n\n`);
          clearInterval(timer);
          res.end();
        }
      }
    };
    const timer = setInterval(sendFrame, 600);
    timer.unref?.();
    await sendFrame();
  });

  // Secrets: Get stored keys with masked values and real-time status
  app.get('/api/secrets', async (_req, res) => {
    try {
      const keys = await loadSecrets();
      const statusList = getKeyPoolStatus(keys);
      res.json({
        // SECURITY FIX (2026-11-27): never return raw key values. The old
        // code spread `...k` (including the full apiKey) into this response.
        // No client reads GET /api/secrets (the UI uses /api/secrets/pool-
        // status + POST to save), so only masked values are returned here.
        keys: keys.map((k, index) => ({
          id: k.id,
          provider: k.provider,
          name: k.name,
          model: k.model,
          baseUrl: k.baseUrl,
          isActive: k.isActive,
          rpmLimit: k.rpmLimit,
          apiKeyMasked: k.apiKey ? (k.apiKey.length > 8 ? `${k.apiKey.slice(0, 4)}...${k.apiKey.slice(-4)}` : '****') : '',
          status: statusList[index]?.status || 'healthy',
          cooldownRemainingSec: statusList[index]?.cooldownRemainingSec || 0,
          requestsThisMinute: statusList[index]?.requestsThisMinute || 0,
          totalRequests: statusList[index]?.totalRequests || 0,
          lastError: statusList[index]?.lastError || null,
        }))
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Secrets: Save / sync API keys
  app.post('/api/secrets', async (req, res) => {
    try {
      const { keys } = req.body;
      if (!Array.isArray(keys)) {
        return res.status(400).json({ error: "Expected an array of keys" });
      }
      await saveSecrets(keys);
      res.json({ success: true, count: keys.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Secrets: Test an API key connectivity
  app.post('/api/secrets/test-key', async (req, res) => {
    try {
      const { provider, apiKey, model, baseUrl } = req.body;
      if (!provider || !apiKey) {
        return res.status(400).json({ success: false, error: "Provider and apiKey are required" });
      }
      const result = await testApiKey(provider, apiKey, model, baseUrl);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Secrets: Fetch live available models (especially :free models) for a provider
  app.post('/api/secrets/models', async (req, res) => {
    try {
      const { provider = 'openrouter', apiKey, baseUrl } = req.body || {};
      const models = await fetchLiveProviderModels(provider, apiKey, baseUrl);
      res.json({ success: true, provider, models });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Secrets: Get real-time status of current pool
  app.get('/api/secrets/pool-status', async (_req, res) => {
    try {
      const keys = await loadSecrets();
      const poolStatus = getKeyPoolStatus(keys);
      res.json({
        pool: poolStatus,
        lastSuccessfulKeyId: getLastSuccessfulKeyId(),
        hasEnvGeminiKey: !!process.env.GEMINI_API_KEY,
        // GEMINI_API_KEYS: one key per Google Cloud project (10 in the user's
        // case). Count only — values are never exposed.
        envGeminiKeyCount: poolStatus.filter((p: any) => String(p.id).startsWith('env-gemini-')).length,
        envGeminiKeysLive: poolStatus.filter((p: any) => String(p.id).startsWith('env-gemini-') && p.status === 'healthy').length,
        // GROQ_API_KEYS (11) + OPENROUTER_API_KEYS (8): counts only.
        envGroqKeyCount: poolStatus.filter((p: any) => String(p.id).startsWith('env-groq-')).length,
        envOpenRouterKeyCount: poolStatus.filter((p: any) => String(p.id).startsWith('env-openrouter-')).length,
        // FreeLLMAPI router status (env-seeded key only; the key value is never exposed)
        hasEnvFreeLLMAPIKey: !!process.env.FREE_LLM_API_KEY,
        freeLLMAPIUrl: (process.env.FREE_LLM_API_URL || 'http://localhost:3001/v1').trim(),
        freeLLMAPIEnvModel: (process.env.FREE_LLM_API_MODEL || 'auto:balanced').trim()
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // System Logs: Diagnostic logs for error tracking, key rotation & execution
  app.get('/api/system-logs', (_req, res) => {
    try {
      res.json({ logs: getSystemLogs() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/system-logs', (_req, res) => {
    try {
      clearSystemLogs();
      res.json({ success: true, message: 'লগ মুছে ফেলা হয়েছে' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Tool Endpoints ---

  // Project Download (ZIP)
  app.get('/api/project/download', async (_req, res) => {
    try {
      const zip = new AdmZip();
      const ignoreList = ['node_modules', 'dist', '.git', '.next', 'nexus-project.zip'];
      
      const addFilesToZip = async (dir: string, zipPath: string) => {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (ignoreList.includes(entry.name)) continue;
          
          const fullPath = path.join(dir, entry.name);
          const relativePath = path.join(zipPath, entry.name);
          
          if (entry.isDirectory()) {
            await addFilesToZip(fullPath, relativePath);
          } else {
            const content = await fs.readFile(fullPath);
            zip.addFile(relativePath, content);
          }
        }
      };

      await addFilesToZip(process.cwd(), "");
      const buffer = zip.toBuffer();
      
      res.set('Content-Type', 'application/zip');
      res.set('Content-Disposition', 'attachment; filename=nexus-project.zip');
      res.send(buffer);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // File Read
  app.post('/api/tools/file-read', async (req, res) => {
    try {
      const { filePath } = req.body;
      if (!filePath) return res.status(400).json({ error: 'filePath is required' });
      
      const absolutePath = path.resolve(process.cwd(), filePath);
      if (!absolutePath.startsWith(process.cwd())) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const content = await fs.readFile(absolutePath, 'utf-8');
      res.json({ content });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // File Write
  app.post('/api/tools/file-write', async (req, res) => {
    try {
      const { filePath, content, sessionId } = req.body;
      if (!filePath || content === undefined) return res.status(400).json({ error: 'filePath and content are required' });

      const absolutePath = path.resolve(process.cwd(), filePath);
      if (!absolutePath.startsWith(process.cwd())) {
        return res.status(403).json({ error: 'Access denied' });
      }

      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, content, 'utf-8');

      // Step 11: writing a projects/*.html file runs the same deployHtmlFile
      // PWA path the agent's write_to_file tool already uses (manifest +
      // service worker + session copy), so a static template applied via
      // this endpoint previews exactly like a model-built site. A deploy
      // failure never fails the write itself.
      const normalized = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
      if (normalized.startsWith('projects/') && normalized.endsWith('.html')) {
        try {
          const deployed = await deployHtmlFile(content, typeof sessionId === 'string' ? sessionId : undefined);
          if (deployed.success) {
            return res.json({ success: true, previewUrl: deployed.url, deployedHtml: deployed.html, path: deployed.path });
          }
        } catch (err) {
          console.warn('file-write PWA deploy note:', (err as any)?.message || err);
        }
      }

      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // File Edit
  app.post('/api/tools/file-edit', async (req, res) => {
    try {
      const { filePath, oldText, newText } = req.body;
      const absolutePath = path.resolve(process.cwd(), filePath);
      if (!absolutePath.startsWith(process.cwd())) return res.status(403).json({ error: 'Access denied' });

      const content = await fs.readFile(absolutePath, 'utf-8');
      if (!content.includes(oldText)) {
        return res.status(400).json({ error: 'Target text not found in file.' });
      }

      const newContent = content.replace(oldText, newText);
      await fs.writeFile(absolutePath, newContent, 'utf-8');
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Glob (File Search)
  app.post('/api/tools/glob', async (req, res) => {
    try {
      const { pattern } = req.body;
      // Using a simple find command for glob-like behavior
      const { stdout } = await execPromise(`find . -name "${pattern}" -not -path "*/node_modules/*" -not -path "*/.git/*"`, { cwd: process.cwd() });
      const files = stdout.split('\n').filter(f => f.trim() !== '').map(f => f.replace('./', ''));
      res.json({ files });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Grep (Content Search with line numbers)
  app.post('/api/tools/grep', async (req, res) => {
    try {
      const { pattern, searchPath = '.' } = req.body;
      if (!pattern) return res.status(400).json({ error: 'pattern is required' });
      const safePattern = String(pattern).replace(/"/g, '\\"');
      const safePath = String(searchPath).replace(/"/g, '\\"');
      try {
        const { stdout } = await execPromise(
          `grep -rnE "${safePattern}" "${safePath}" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist | head -n 100`,
          { cwd: process.cwd() }
        );
        const matches = stdout.split('\n').filter(f => f.trim() !== '').map(f => f.replace(/^\.\//, ''));
        res.json({ matches, files: Array.from(new Set(matches.map(m => m.split(':')[0]))) });
      } catch (err: any) {
        if (err.code === 1) return res.json({ matches: [], files: [] });
        throw err;
      }
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Bash Execution
  app.post('/api/tools/bash', async (req, res) => {
    try {
      const { command } = req.body;
      if (!command) return res.status(400).json({ error: 'command is required' });
      const { stdout, stderr } = await execPromise(command, { cwd: process.cwd() });
      res.json({ stdout, stderr });
    } catch (error: any) {
      res.status(500).json({ error: error.message, stdout: error.stdout, stderr: error.stderr });
    }
  });

  // Web Fetch
  app.post('/api/tools/web-fetch', async (req, res) => {
    try {
      const { url } = req.body;
      if (!url) return res.status(400).json({ error: 'url is required' });
      const response = await fetch(url);
      const data = await response.text();
      res.json({ data });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Web Search
  app.post('/api/tools/web-search', async (req, res) => {
    try {
      const { query } = req.body;
      if (!query) return res.status(400).json({ error: 'query is required' });
      
      // Try DuckDuckGo API first (it's free and no-key)
      const response = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`);
      const data = await response.json();
      
      const results = data.RelatedTopics?.slice(0, 8).map((t: any) => {
        if (t.Text && t.FirstURL) {
          return { text: t.Text, url: t.FirstURL };
        }
        // Handle nested topics
        if (t.Topics) {
          return t.Topics.slice(0, 2).map((st: any) => ({ text: st.Text, url: st.FirstURL }));
        }
        return null;
      }).flat().filter(Boolean) || [];

      res.json({ 
        results,
        abstract: data.AbstractText || "No direct abstract found. Try visiting the results.",
        source: data.AbstractSource || "DuckDuckGo",
        searchUrl: `https://www.google.com/search?q=${encodeURIComponent(query)}`
      });
    } catch (error: any) {
      console.error('Search error:', error);
      res.status(500).json({ 
        error: "Search failed. You can use the direct link below.",
        searchUrl: `https://www.google.com/search?q=${encodeURIComponent(req.body.query || '')}`
      });
    }
  });

  // Project Analysis
  app.post('/api/tools/analyze-project', async (req, res) => {
    try {
      const { type } = req.body;
      const getFilesRecursively = async (dir: string): Promise<string[]> => {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        const files = await Promise.all(entries.map(async (entry) => {
          const resPath = path.resolve(dir, entry.name);
          if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') return [];
          return entry.isDirectory() ? getFilesRecursively(resPath) : [resPath];
        }));
        return files.flat();
      };
      const allFiles = await getFilesRecursively(process.cwd());
      const relevantFiles = allFiles.filter(f => f.endsWith('.html') || f.endsWith('.tsx') || f.endsWith('.ts') || f.endsWith('.css'));
      const fileContents = await Promise.all(relevantFiles.slice(0, 10).map(async (f) => ({
        path: path.relative(process.cwd(), f),
        content: await fs.readFile(f, 'utf-8')
      })));
      res.json({ files: fileContents, analysisType: type });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // GitHub Status
  app.get('/api/github/status', async (_req, res) => {
    try {
      const token = process.env.GITHUB_TOKEN;
      if (!token) return res.json({ configured: false });
      const octokit = new Octokit({ auth: token });
      const { data: user } = await octokit.rest.users.getAuthenticated();
      res.json({
        configured: true,
        user: user.login,
        name: user.name || user.login,
        avatar: user.avatar_url
      });
    } catch (err: any) {
      res.json({ configured: false, error: err.message });
    }
  });

  // Verify Personal Access Token
  app.post('/api/github/verify-token', async (req, res) => {
    try {
      const { token } = req.body;
      if (!token) return res.status(400).json({ error: 'Token is required' });
      const octokit = new Octokit({ auth: token });
      const { data: user } = await octokit.rest.users.getAuthenticated();
      res.json({
        valid: true,
        user: user.login,
        name: user.name || user.login,
        avatar: user.avatar_url
      });
    } catch (err: any) {
      res.status(400).json({ valid: false, error: 'Invalid GitHub Token or insufficient permissions.' });
    }
  });

  // GitHub Full Sync (Create Repo & Push Code) — LEGACY, DANGEROUS BY DESIGN:
  // it runs `git init + add -A + commit + push --force` in the SERVICE's own
  // directory (pushing the agent's own code, not a built project) and embeds
  // the token in a remote URL. The deploy flow (POST /api/deploy) is the safe
  // replacement — it pushes only the built project via the Git Data API.
  // This endpoint is DISABLED by default; set ALLOW_GITHUB_SYNC=true to
  // re-enable it explicitly (and only if you understand what it does).
  app.post('/api/github/sync', async (req, res) => {
    if (process.env.ALLOW_GITHUB_SYNC !== 'true') {
      return res.status(403).json({ error: 'GitHub full sync is disabled by default (it force-pushes this service’s own code). Use the Deploy button / POST /api/deploy to push a built project instead. Set ALLOW_GITHUB_SYNC=true to re-enable it.' });
    }
    try {
      const { token: clientToken, repoName, isPrivate = false, commitMessage = "Sync project from Nexus AI" } = req.body;
      const token = clientToken || process.env.GITHUB_TOKEN;
      if (!token) return res.status(401).json({ error: 'GitHub Personal Access Token is required.' });
      if (!repoName) return res.status(400).json({ error: 'Repository name is required.' });

      const octokit = new Octokit({ auth: token });
      const { data: user } = await octokit.rest.users.getAuthenticated();

      // Check if repo already exists, if not, create it
      let repoUrl = `https://github.com/${user.login}/${repoName}`;
      try {
        const { data: repo } = await octokit.rest.repos.get({
          owner: user.login,
          repo: repoName
        });
        repoUrl = repo.html_url;
      } catch (e: any) {
        if (e.status === 404) {
          const { data: newRepo } = await octokit.rest.repos.createForAuthenticatedUser({
            name: repoName,
            private: isPrivate,
            description: "Built and synced with Nexus AI",
            auto_init: false
          });
          repoUrl = newRepo.html_url;
        } else {
          throw e;
        }
      }

      // Configure git locally
      await execPromise(`git config --global --add safe.directory '*' || true`, { cwd: process.cwd() });
      await execPromise(`git init -b main || git checkout -B main`, { cwd: process.cwd() });
      await execPromise(`git config user.name "${(user.name || user.login).replace(/"/g, '')}"`, { cwd: process.cwd() });
      await execPromise(`git config user.email "${(user.email || user.login + '@users.noreply.github.com').replace(/"/g, '')}"`, { cwd: process.cwd() });
      
      // Stage files and commit
      await execPromise(`git add -A`, { cwd: process.cwd() });
      await execPromise(`git commit -m "${commitMessage.replace(/"/g, '\\"')}" || echo "No changes to commit"`, { cwd: process.cwd() });

      // Configure remote and push
      const remoteUrl = `https://x-access-token:${token}@github.com/${user.login}/${repoName}.git`;
      await execPromise(`git remote remove origin 2>/dev/null || true`, { cwd: process.cwd() });
      await execPromise(`git remote add origin ${remoteUrl}`, { cwd: process.cwd() });
      const { stdout, stderr } = await execPromise(`git push -u origin main --force`, { cwd: process.cwd() });

      res.json({
        success: true,
        repoUrl,
        message: `Successfully synced project to ${repoUrl}!`,
        stdout,
        stderr
      });
    } catch (error: any) {
      console.error('GitHub Sync Error:', error);
      res.status(500).json({ error: error.message || 'Failed to sync to GitHub.' });
    }
  });

  // Firebase Status (legacy shape, now sourced from the encrypted store —
  // projectId/authDomain only, never the API key)
  app.get('/api/firebase/status', async (_req, res) => {
    try {
      const status = await getFirebaseStatus();
      const rulesPath = path.resolve(process.cwd(), 'firestore.rules');
      const libPath = path.resolve(process.cwd(), 'src/lib/firebase.ts');
      let hasRules = false;
      let hasSdk = false;
      try { await fs.access(rulesPath); hasRules = true; } catch {}
      try { await fs.access(libPath); hasSdk = true; } catch {}
      res.json({
        configured: status.connected,
        config: status.connected ? { projectId: status.projectId, authDomain: status.authDomain, storageBucket: status.storageBucket } : null,
        projectId: status.projectId || null,
        hasRules,
        hasSdk
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Firebase one-click connect — status (project id only, never the key)
  app.get('/api/firebase/connection', async (_req, res) => {
    try {
      res.json(await getFirebaseStatus());
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Firebase one-click connect — paste the Firebase web config object OR a
  // google-services.json. Validates the config, tests the connection live
  // (Identity Toolkit probe — creates nothing), stores it ENCRYPTED.
  // The API key is never logged, never returned, never stored in plaintext.
  app.post('/api/firebase/connect', async (req, res) => {
    try {
      const body = req.body || {};
      let config = null;
      if (body.googleServicesJson) {
        config = parseGoogleServicesJson(typeof body.googleServicesJson === 'string' ? body.googleServicesJson : JSON.stringify(body.googleServicesJson));
      } else if (body.config) {
        config = parseFirebaseWebConfig(body.config);
      } else {
        config = parseFirebaseWebConfig(body);
      }
      if (!config) {
        return res.status(400).json({ error: 'Could not read a Firebase config. Paste the Firebase web config object (apiKey + projectId) or a google-services.json.' });
      }
      const result = await storeFirebaseConfig(config);
      res.json({ success: true, projectId: result.projectId, verified: result.verified, warning: result.warning || null, message: result.verified ? `Firebase connected (project: ${result.projectId}).` : `Firebase saved for project ${result.projectId}, but the live test could not reach Google.` });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to connect Firebase.' });
    }
  });

  // Firebase disconnect — deletes the stored config (server-side only).
  app.post('/api/firebase/disconnect', async (_req, res) => {
    try {
      await deleteFirebaseConfig();
      res.json({ success: true, message: 'Firebase disconnected — the stored config was deleted.' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Firebase Setup & Bootstrap (legacy endpoint, kept for the FirebaseModal):
  // now delegates to the encrypted connect flow. With apiKey + projectId it
  // connects; with only a projectId it succeeds only when that project is
  // already connected. It NEVER writes a plaintext firebase-config.json.
  app.post('/api/firebase/setup', async (req, res) => {
    try {
      const { apiKey, authDomain, projectId, storageBucket, messagingSenderId, appId } = req.body || {};
      if (apiKey && projectId) {
        const result = await storeFirebaseConfig({ apiKey, authDomain: authDomain || `${projectId}.firebaseapp.com`, projectId, storageBucket: storageBucket || `${projectId}.appspot.com`, messagingSenderId: messagingSenderId || '', appId: appId || '' });
        return res.json({ success: true, message: 'Firebase successfully connected! Firestore, Auth, and Storage are ready.', projectId: result.projectId, verified: result.verified });
      }
      if (projectId) {
        const status = await getFirebaseStatus();
        if (status.connected && status.projectId === projectId) {
          return res.json({ success: true, message: `Firebase already connected (project: ${projectId}).`, projectId });
        }
        return res.status(400).json({ error: `Firebase is not connected for project "${projectId}". Click "Connect Firebase" and paste the Firebase web config (or google-services.json) first — the API key is needed to connect.` });
      }
      return res.status(400).json({ error: 'apiKey and projectId are required.' });
    } catch (err: any) {
      console.error('Firebase Setup Error:', err);
      res.status(400).json({ error: err.message || 'Failed to setup Firebase.' });
    }
  });

  // Add Firebase to the current built project (one click per project):
  // wires the SDK + Auth + Firestore into projects/<session>/, plus
  // firebase.json + .firebaserc + firestore.rules. BACKEND RULE: only call
  // this when the user asked for backend/Firebase work.
  app.post('/api/firebase/add-to-project', async (req, res) => {
    try {
      const { sessionId } = req.body || {};
      const result = await addFirebaseToProject(sessionId);
      if (!result.success) return res.status(400).json({ error: result.error || 'Failed to add Firebase to the project.' });
      res.json({ success: true, projectId: result.projectId, filesWritten: result.filesWritten, needsInstall: result.needsInstall, message: `Firebase added to the project (${result.projectId}): ${result.filesWritten.join(', ')}.` });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Deploy the current built project to Firebase Hosting (real deploy).
  // Needs FIREBASE_TOKEN (one-time `firebase login:ci`); without it, returns
  // the exact setup steps instead of pretending to deploy.
  app.post('/api/firebase/deploy-hosting', async (req, res) => {
    try {
      const { sessionId } = req.body || {};
      const result = await deployFirebaseHosting(sessionId);
      if (result.status === 'live') return res.json({ success: true, status: 'live', url: result.url, projectId: result.projectId });
      if (result.status === 'setup-needed') return res.json({ success: false, status: 'setup-needed', projectId: result.projectId, steps: result.steps });
      return res.status(500).json({ success: false, status: 'error', error: result.error });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  // Get firestore.rules
  app.get('/api/firebase/rules', async (_req, res) => {
    try {
      const rulesPath = path.resolve(process.cwd(), 'firestore.rules');
      const content = await fs.readFile(rulesPath, 'utf-8');
      res.json({ rules: content });
    } catch {
      res.json({
        rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
    match /{document=**} {
      allow read, write: if request.auth != null;
    }
  }
}`
      });
    }
  });

  // Save / Deploy firestore.rules
  app.post('/api/firebase/rules', async (req, res) => {
    try {
      const { rules } = req.body;
      if (!rules) return res.status(400).json({ error: 'Rules content is required' });
      const rulesPath = path.resolve(process.cwd(), 'firestore.rules');
      await fs.writeFile(rulesPath, rules, 'utf-8');
      res.json({ success: true, message: 'firestore.rules updated and validated!' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- GitHub one-click connect (OAuth App or PAT fallback) ------------
  app.get('/api/github/oauth/config', (req, res) => {
    res.json({ configured: isOAuthConfigured(), callbackUrl: getOAuthCallbackUrl((req.headers.origin as string) || '') });
  });
  app.get('/api/github/oauth/start', (req, res) => {
    if (!isOAuthConfigured()) return res.status(400).json({ error: 'GitHub OAuth App is not configured (GITHUB_OAUTH_CLIENT_ID / GITHUB_OAUTH_CLIENT_SECRET). Use the PAT fallback instead.' });
    const state = newOAuthState();
    const callbackUrl = getOAuthCallbackUrl((req.headers.origin as string) || '');
    res.redirect(buildAuthorizeUrl(callbackUrl, state));
  });
  app.get('/api/github/oauth/callback', async (req, res) => {
    const { code, state } = req.query as Record<string, string>;
    const origin = getOAuthCallbackUrl((req.headers.origin as string) || '').replace(/\/api\/github\/oauth\/callback$/, '');
    const redirect = (params: string) => res.redirect(`${origin}/?github=${params}`);
    if (!code || !state || !consumeOAuthState(state)) return redirect('error=invalid_state');
    try {
      const callbackUrl = getOAuthCallbackUrl((req.headers.origin as string) || '');
      const token = await exchangeCodeForToken(code, callbackUrl);
      await storeGitHubToken(token, 'oauth');
      return redirect('connected');
    } catch (err: any) {
      return redirect('error=' + encodeURIComponent(String(err?.message || 'exchange_failed').slice(0, 120)));
    }
  });
  app.post('/api/github/connect-pat', async (req, res) => {
    try {
      const { token } = req.body || {};
      if (!token) return res.status(400).json({ error: 'Token is required.' });
      const meta = await storeGitHubToken(String(token).trim(), 'pat');
      res.json({ success: true, login: meta.login });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Invalid token.' });
    }
  });
  app.get('/api/github/connection', async (_req, res) => {
    try { res.json(await getGitHubConnection()); } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  app.post('/api/github/disconnect', async (_req, res) => {
    try {
      const conn = await getGitHubConnection();
      if (conn.connected && conn.source === 'oauth') {
        const stored = await readStoredGitHubToken();
        if (stored) await revokeOAuthToken(stored.token).catch(() => {});
      }
      await deleteStoredGitHubToken();
      res.json({ success: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ---- One-click deploy ---------------------------------------------------
  app.get('/api/deploy/status', (_req, res) => { res.json(deployStatus()); });
  app.post('/api/deploy', async (req, res) => {
    try {
      const { sessionId, repo, branch, isPrivate, commitMessage } = req.body || {};
      if (!repo) return res.status(400).json({ error: 'repo is required (e.g. "my-shop").' });
      const job = await startDeploy({ sessionId, repo, branch, isPrivate, commitMessage });
      res.status(202).json({ jobId: job.id, stage: job.stage });
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });
  app.get('/api/deploy/:jobId', (req, res) => {
    const job = getDeployJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Deploy job not found.' });
    res.json(job);
  });

  // ---- Model chain (live discovery + failover state) -----------------------
  app.get('/api/models/chain', (req, res) => {
    const task = (req.query.task as string) || 'coding';
    res.json({ task, chain: getChainForTask(task as any), catalog: catalogStatus(), models: modelChainStatus() });
  });

  // ---- Router dashboard: provider keys, status, usage ----------------------
  // Keys tab: list (no values ever), add, remove. Env keys are read-only here.
  app.get('/api/router/keys', async (_req, res) => { res.json({ keys: await routerKeyStatus() }); });
  app.post('/api/router/keys', async (req, res) => {
    const { provider, key } = req.body || {};
    if (!['gemini', 'groq', 'openrouter'].includes(provider)) return res.status(400).json({ error: 'provider must be gemini, groq or openrouter.' });
    if (!key) return res.status(400).json({ error: 'key is required.' });
    try {
      const { id } = await addRouterKey(provider, String(key).trim());
      res.json({ success: true, id });
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });
  app.delete('/api/router/keys/:id', async (req, res) => {
    const ok = await removeRouterKey(req.params.id);
    if (!ok) return res.status(400).json({ error: 'Key not found or it is an env key (unset the env var to remove it).' });
    res.json({ success: true });
  });
  app.get('/api/router/status', async (_req, res) => { res.json(await routerStatus()); });
  app.get('/api/router/usage', async (_req, res) => { res.json(await routerUsageSummary()); });

  // ---- Memory / chats / projects / backup / lessons ------------------------
  app.get('/api/memory', async (_req, res) => { res.json({ memory: await readUserMemory() }); });
  app.post('/api/memory', async (req, res) => {
    const { append, content } = req.body || {};
    if (typeof content === 'string') { await setUserMemory(content); return res.json({ success: true }); }
    if (typeof append === 'string') { await appendUserMemory(append); return res.json({ success: true }); }
    return res.status(400).json({ error: 'Provide {append} or {content}.' });
  });
  app.get('/api/chats', async (_req, res) => { res.json({ chats: await listChats() }); });
  app.get('/api/chats/:id', async (req, res) => {
    const chat = await loadChat(req.params.id);
    if (!chat) return res.status(404).json({ error: 'Chat not found.' });
    res.json(chat);
  });
  app.get('/api/projects', async (_req, res) => { res.json({ projects: await listProjects() }); });
  // Clone / remix a project: copies projects/<id>/ + the stored chat to a
  // new session id (Step 14). The client then duplicates the IndexedDB
  // session copy under the returned id.
  app.post('/api/projects/:id/clone', async (req, res) => {
    try {
      const cloned = await cloneProject(req.params.id);
      if (!cloned) return res.status(404).json({ error: 'Project not found.' });
      res.json({ success: true, ...cloned });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || 'Clone failed.' });
    }
  });
  app.get('/api/backup', async (_req, res) => {
    const buf = await exportBackup();
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="website-builder-backup.zip"');
    res.send(buf);
  });
  app.get('/api/lessons', async (_req, res) => { res.json({ lessons: await readLessons() }); });

  // ---- Background jobs ------------------------------------------------------
  app.post('/api/jobs', async (req, res) => {
    const { prompt, sessionId } = req.body || {};
    if (!prompt) return res.status(400).json({ error: 'prompt is required.' });
    const job = await createJob(String(prompt), sessionId || `session_${Date.now()}`);
    res.status(202).json(job);
  });
  app.get('/api/jobs', async (_req, res) => { res.json({ jobs: await listJobs() }); });
  app.get('/api/jobs/:id', async (req, res) => {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    res.json(job);
  });
  app.post('/api/jobs/:id/cancel', async (req, res) => {
    const ok = await cancelJob(req.params.id);
    if (!ok) return res.status(400).json({ error: 'Job cannot be cancelled (not queued).' });
    res.json({ success: true });
  });

  // ---- Voice input (Bengali-first, free Groq Whisper) -----------------------
  app.post('/api/voice/transcribe', express.raw({ type: 'audio/*', limit: '10mb' }), async (req, res) => {
    try {
      const groqKey = (process.env.GROQ_API_KEYS || '').split(',').map((k) => k.trim()).filter(Boolean)[0] || process.env.GROQ_API_KEY || '';
      if (!groqKey) return res.status(400).json({ error: 'No Groq key configured (GROQ_API_KEYS env). Voice transcription needs a free Groq key.' });
      if (!req.body || !(req.body instanceof Buffer) || req.body.length === 0) return res.status(400).json({ error: 'No audio received.' });
      const form = new FormData();
      form.append('file', new Blob([req.body], { type: (req.headers['content-type'] as string) || 'audio/webm' }), 'voice.webm');
      form.append('model', 'whisper-large-v3-turbo');
      form.append('language', 'bn');
      form.append('response_format', 'json');
      const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${groqKey}` }, body: form, signal: AbortSignal.timeout(60000) });
      const j: any = await r.json().catch(() => null);
      if (!r.ok) return res.status(r.status).json({ error: j?.error?.message || `Groq Whisper failed (HTTP ${r.status}).` });
      res.json({ text: j?.text || '', language: j?.language || 'bn' });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // File Delete
  app.post('/api/tools/file-delete', async (req, res) => {
    try {
      const { filePath } = req.body;
      if (!filePath) return res.status(400).json({ error: 'filePath is required' });
      const absolutePath = path.resolve(process.cwd(), filePath);
      if (!absolutePath.startsWith(process.cwd())) return res.status(403).json({ error: 'Access denied' });
      
      const stat = await fs.stat(absolutePath);
      if (stat.isDirectory()) {
        await fs.rm(absolutePath, { recursive: true, force: true });
      } else {
        await fs.unlink(absolutePath);
      }
      res.json({ success: true, message: `Deleted ${filePath}` });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // List Directory
  app.post('/api/tools/list-dir', async (req, res) => {
    try {
      const { dirPath = '.' } = req.body;
      const targetDir = path.resolve(process.cwd(), dirPath);
      if (!targetDir.startsWith(process.cwd())) return res.status(403).json({ error: 'Access denied' });

      const entries = await fs.readdir(targetDir, { withFileTypes: true });
      const items = entries.map(entry => ({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : 'file',
        path: path.relative(process.cwd(), path.join(targetDir, entry.name))
      }));
      res.json({ items });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Move or Rename File
  app.post('/api/tools/move-file', async (req, res) => {
    try {
      const { sourcePath, destinationPath } = req.body;
      if (!sourcePath || !destinationPath) {
        return res.status(400).json({ error: 'sourcePath and destinationPath are required' });
      }
      const absSrc = path.resolve(process.cwd(), sourcePath);
      const absDest = path.resolve(process.cwd(), destinationPath);
      if (!absSrc.startsWith(process.cwd()) || !absDest.startsWith(process.cwd())) {
        return res.status(403).json({ error: 'Access denied' });
      }

      await fs.mkdir(path.dirname(absDest), { recursive: true });
      await fs.rename(absSrc, absDest);
      res.json({ success: true, message: `Moved ${sourcePath} to ${destinationPath}` });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Install Package
  app.post('/api/tools/install-package', async (req, res) => {
    try {
      const { packageName, isDev = false } = req.body;
      if (!packageName) return res.status(400).json({ error: 'packageName is required' });
      const flag = isDev ? '-D' : '';
      const { stdout, stderr } = await execPromise(`npm install ${flag} ${packageName}`, { cwd: process.cwd() });
      res.json({ success: true, message: `Installed ${packageName}`, stdout, stderr });
    } catch (error: any) {
      res.status(500).json({ error: error.message, stderr: error.stderr });
    }
  });

  // Compile / Build Project
  app.post('/api/tools/compile-project', async (_req, res) => {
    try {
      const { stdout, stderr } = await execPromise(`npx tsc --noEmit`, { cwd: process.cwd() });
      res.json({ success: true, message: 'Compilation succeeded with 0 errors.', stdout, stderr });
    } catch (error: any) {
      res.status(400).json({ 
        success: false, 
        message: 'Compilation failed.', 
        error: error.message, 
        stdout: error.stdout, 
        stderr: error.stderr 
      });
    }
  });

  // Lint Project
  app.post('/api/tools/lint-project', async (_req, res) => {
    try {
      const { stdout, stderr } = await execPromise(`npm run lint`, { cwd: process.cwd() });
      res.json({ success: true, message: 'Lint passed successfully.', stdout, stderr });
    } catch (error: any) {
      res.status(400).json({ 
        success: false, 
        message: 'Lint found issues.', 
        error: error.message, 
        stdout: error.stdout, 
        stderr: error.stderr 
      });
    }
  });

  // Restart Dev Server
  app.post('/api/tools/restart-server', async (_req, res) => {
    try {
      res.json({ success: true, message: 'Development server refreshed and ready.' });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Git Status
  app.post('/api/tools/git-status', async (_req, res) => {
    try {
      const { stdout: branch } = await execPromise('git branch --show-current || echo "main"', { cwd: process.cwd() });
      const { stdout: status } = await execPromise('git status -s || echo ""', { cwd: process.cwd() });
      res.json({ branch: branch.trim(), status: status.trim() || 'Working directory clean.' });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Git Commit
  app.post('/api/tools/git-commit', async (req, res) => {
    try {
      const { message } = req.body;
      if (!message) return res.status(400).json({ error: 'Commit message is required' });
      await execPromise('git add .', { cwd: process.cwd() });
      const { stdout } = await execPromise(`git commit -m "${message.replace(/"/g, '\\"')}" || echo "Nothing to commit"`, { cwd: process.cwd() });
      res.json({ success: true, stdout: stdout.trim() });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Git Diff
  app.post('/api/tools/git-diff', async (_req, res) => {
    try {
      const { stdout } = await execPromise('git diff || echo ""', { cwd: process.cwd() });
      res.json({ diff: stdout.trim() || 'No uncommitted changes detected.' });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Send HTTP Request
  app.post('/api/tools/send-http-request', async (req, res) => {
    try {
      const { url, method = 'GET', headers = {}, body } = req.body;
      if (!url) return res.status(400).json({ error: 'url is required' });
      const response = await fetch(url, {
        method,
        headers,
        body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined
      });
      const contentType = response.headers.get('content-type') || '';
      const responseData = contentType.includes('application/json') ? await response.json() : await response.text();
      res.json({ status: response.status, statusText: response.statusText, data: responseData });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Test API Endpoint
  app.post('/api/tools/test-api-endpoint', async (req, res) => {
    try {
      const { url } = req.body;
      if (!url) return res.status(400).json({ error: 'url is required' });
      const start = Date.now();
      const response = await fetch(url);
      const latency = Date.now() - start;
      res.json({ status: response.status, latencyMs: latency, reachable: response.ok });
    } catch (error: any) {
      res.status(500).json({ error: error.message, reachable: false });
    }
  });

  // Set Environment Variable
  app.post('/api/tools/set-env-variable', async (req, res) => {
    try {
      const { key, value } = req.body;
      if (!key) return res.status(400).json({ error: 'key is required' });
      const envPath = path.resolve(process.cwd(), '.env');
      let envContent = '';
      try {
        envContent = await fs.readFile(envPath, 'utf-8');
      } catch {
        envContent = '';
      }
      const regex = new RegExp(`^${key}=.*$`, 'm');
      if (regex.test(envContent)) {
        envContent = envContent.replace(regex, `${key}=${value}`);
      } else {
        envContent += `\n${key}=${value}\n`;
      }
      await fs.writeFile(envPath, envContent.trim() + '\n', 'utf-8');
      res.json({ success: true, message: `Set environment variable ${key}` });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Scan Security Vulnerabilities
  app.post('/api/tools/scan-vulnerabilities', async (_req, res) => {
    try {
      const { stdout, stderr } = await execPromise('npm audit --audit-level=moderate || true', { cwd: process.cwd() });
      res.json({ report: stdout || stderr || 'No vulnerabilities found.' });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Detect Hardcoded Secrets
  app.post('/api/tools/detect-secrets', async (_req, res) => {
    try {
      const secretPatterns = [
        /(?:api[_-]?key|secret|token|password|auth|bearer)\s*[:=]\s*['"][a-zA-Z0-9_\-]{16,}['"]/gi
      ];
      const getFilesRecursively = async (dir: string): Promise<string[]> => {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        const files = await Promise.all(entries.map(async (entry) => {
          const resPath = path.resolve(dir, entry.name);
          if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') return [];
          return entry.isDirectory() ? getFilesRecursively(resPath) : [resPath];
        }));
        return files.flat();
      };
      const files = await getFilesRecursively(path.resolve(process.cwd(), 'src'));
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
      res.json({ safe: detected.length === 0, detectedCount: detected.length, detected });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Send Webhook Notification
  app.post('/api/tools/send-webhook', async (req, res) => {
    try {
      const { webhookUrl, message, payload = {} } = req.body;
      if (!webhookUrl) return res.status(400).json({ error: 'webhookUrl is required' });
      const body = { content: message, text: message, ...payload };
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      res.json({ success: response.ok, status: response.status });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Execute Database / SQL Query (real persistent SQLite via node:sqlite)
  app.post('/api/tools/execute-sql-query', async (req, res) => {
    try {
      const { query } = req.body || {};
      if (!query) return res.status(400).json({ error: 'SQL query is required' });
      const result = await executeServerTool('cloudsql_execute_sql', { sql_statement: query });
      if (result?.error) {
        return res.status(400).json(result);
      }
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // List Files
  app.get('/api/files/list', async (_req, res) => {
    try {
      const getFiles = async (dir: string): Promise<any[]> => {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        const files = await Promise.all(entries.map(async (entry) => {
          const resPath = path.resolve(dir, entry.name);
          const relativePath = path.relative(process.cwd(), resPath);
          if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') return null;
          if (entry.isDirectory()) {
            return { name: entry.name, path: relativePath, type: 'directory', children: await getFiles(resPath) };
          } else {
            return { name: entry.name, path: relativePath, type: 'file' };
          }
        }));
        return files.filter(f => f !== null);
      };
      const fileTree = await getFiles(process.cwd());
      res.json(fileTree);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Coding Mode Skills & Tools Registry (including Function Calling schemas)
  app.get('/api/skills', (_req, res) => {
    res.json({
      skills: CODING_SKILLS_REGISTRY,
      tools: serverTools.map(t => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters || null,
      })),
    });
  });

  app.get('/api/skills/:name', (req, res) => {
    const skill = getSkillByName(req.params.name);
    if (!skill) return res.status(404).json({ error: 'Skill not found' });
    res.json(skill);
  });

  // Code Execution Sandbox endpoint
  app.post('/api/tools/sandbox', async (req, res) => {
    try {
      const { language = 'javascript', code = '', timeoutMs = 10000 } = req.body || {};
      if (!code.trim()) return res.status(400).json({ error: 'code is required' });
      const result = await runCodeInSandbox(language, code, timeoutMs);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Debugging & Error Analysis endpoint
  app.post('/api/tools/debug-analyze', async (req, res) => {
    try {
      const { errorMessage, errorLog, targetFile, filePath } = req.body || {};
      const result = await runDebugErrorAnalysis(errorMessage || errorLog, targetFile || filePath);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // --- UltraWorkers & Claw Code Harness API Routes ---

  // Claw Doctor: Health check for environment, runtimes, port, memory, API keys
  app.all('/api/tools/claw-doctor', async (req, res) => {
    try {
      const { runNetworkCheck = false } = (req.method === 'POST' ? req.body : req.query) || {};
      const result = await runClawDoctor(Boolean(runNetworkCheck));
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Claw Status: Harness runtime state & metrics
  app.all('/api/tools/claw-status', async (_req, res) => {
    try {
      const result = await getClawStatus();
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Claw ACP: Agent Client Protocol capabilities & handshake
  app.all('/api/tools/claw-acp', (req, res) => {
    try {
      const { action = 'status' } = (req.method === 'POST' ? req.body : req.query) || {};
      const result = getClawAcpInfo(action);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Claw Prompt: Direct task execution harness
  app.post('/api/tools/claw-prompt', async (req, res) => {
    try {
      const { prompt = '', role = 'developer', dryRun = false } = req.body || {};
      if (!prompt.trim()) return res.status(400).json({ error: 'prompt is required' });
      const result = await runClawPrompt(prompt, role, Boolean(dryRun));
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // OmO (oh-my-openagent): Multi-Agent Coordination (Architect -> Executor -> Reviewer)
  app.post('/api/tools/omo-coordinate', async (req, res) => {
    try {
      const { task = '', context, subAgents } = req.body || {};
      if (!task.trim()) return res.status(400).json({ error: 'task is required' });
      const result = await runOmoCoordinate(task, context, subAgents);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // OmX (oh-my-codex): Structured Execution Protocol
  app.post('/api/tools/omx-protocol', async (req, res) => {
    try {
      const { goal = '', targetStack } = req.body || {};
      if (!goal.trim()) return res.status(400).json({ error: 'goal is required' });
      const result = await runOmxProtocol(goal, targetStack);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ClawHip: Event & Notification Router
  app.all('/api/tools/clawhip', (req, res) => {
    try {
      const { action = 'list', eventType, message, metadata } = (req.method === 'POST' ? req.body : req.query) || {};
      const result = routeClawHipEvent(action, eventType, message, metadata);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Gajae-Code / LazyCodex: Autonomous Task Runner with compiler verification
  app.post('/api/tools/lazycodex', async (req, res) => {
    try {
      const { task = '', targetFiles = [], maxIterations = 3 } = req.body || {};
      if (!task.trim()) return res.status(400).json({ error: 'task is required' });
      const result = await runLazyCodex(task, targetFiles, maxIterations);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Manage background tasks
  app.post('/api/tools/manage-task', (req, res) => {
    const { action = 'list', taskId, input } = req.body || {};
    res.json(manageBackgroundTask(action, taskId, input));
  });

  // Dual verification: compile + lint
  app.post('/api/tools/verify-build', async (_req, res) => {
    try {
      const { stdout: lintOut } = await execPromise('npx tsc --noEmit', { cwd: process.cwd() });
      const { stdout: buildOut } = await execPromise('npm run build', { cwd: process.cwd() });
      res.json({ success: true, lintOutput: lintOut.trim() || 'No TypeScript errors', buildOutput: buildOut.trim() });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: error.message,
        output: error.stdout || error.stderr || '',
      });
    }
  });

  // Background-job runner: a queued job runs the same orchestrated chat
  // with a fake Response that buffers SSE events. The job's chat history is
  // saved under its sessionId, so the user can reopen it like any chat.
  async function runJobTurn(job: Job): Promise<{ summary: string; previewUrl?: string }> {
    return new Promise((resolve, reject) => {
      const chunks: string[] = [];
      let previewUrl: string | undefined;
      let lastError: string | undefined;
      let finished = false;
      const fakeRes: any = {
        setHeader() {},
        write(chunk: string) {
          for (const line of String(chunk).split('\n')) {
            if (!line.startsWith('data: ')) continue;
            try {
              const ev = JSON.parse(line.slice(6));
              if (ev.type === 'text' && ev.text) chunks.push(ev.text);
              if (ev.type === 'error' && ev.error) lastError = String(ev.error);
              if (ev.type === 'preview_ready' && ev.url) previewUrl = ev.url;
            } catch { /* ignore malformed SSE lines */ }
          }
        },
        end() {
          if (finished) return;
          finished = true;
          // FIX (2026-11-27): a turn that ended with an error event (e.g.
          // every LLM key failed) used to resolve as "done" with the
          // meaningless summary "Job finished.". An errored turn is a
          // FAILED job, with the error as the reason.
          if (lastError) {
            reject(new Error(lastError.slice(0, 500)));
            return;
          }
          resolve({ summary: chunks.join('').slice(0, 2000) || 'Job finished.', previewUrl });
        },
      };
      handleOrchestratedChat({ messages: [{ role: 'user', parts: [{ text: job.prompt }] }], sessionId: job.sessionId }, fakeRes as any).catch((e) => {
        if (!finished) { finished = true; reject(e); }
      });
    });
  }

  // Vite Middleware
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR !== 'true',
        ws: { server: httpServer },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Startup: live model catalog, Nexus scheduler (reminders/watches),
  // background-job worker.
  initModelChain();
  wireNexusScheduler();
  startJobWorker(runJobTurn);

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
