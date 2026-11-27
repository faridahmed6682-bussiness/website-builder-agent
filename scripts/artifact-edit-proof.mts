// Step 12 (P1) proof — no real API keys, no model calls, no provider network.
// Run: npx tsx scripts/artifact-edit-proof.mts
// Proves:
//  1. The Artifacts panel is editable: the component renders an Edit toggle,
//     a <textarea> editor and a Save button, while the read-only <pre> view
//     stays the default.
//  2. Save calls the EXISTING /api/tools/file-write endpoint (no new server
//     code) with the new content — verified live against a scratch file on a
//     throwaway server port, then read back via /api/tools/file-read.
//  3. Save bumps previewKey (setPreviewKey(k => k + 1)) so the preview
//     iframe remounts, and notifies the parent via onArtifactSaved so the
//     in-memory currentSessionHtml (preview srcDoc) is synced.
//  4. No model call is made by editing: the component's save path contains
//     no provider fetch (Gemini/Groq/OpenRouter) and the proof server runs
//     with all key env vars unset.
import assert from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const COMPONENT = await fs.readFile(
  path.join(ROOT, 'src/components/GoogleAIStudioCoderView.tsx'),
  'utf-8',
);
const APP = await fs.readFile(path.join(ROOT, 'src/App.tsx'), 'utf-8');

// --- 1. Component source checks -------------------------------------------
// Read-only view is still the default: <pre> present, edit mode off initially.
assert.ok(COMPONENT.includes("useState(false)"), 'edit mode defaults off');
assert.ok(COMPONENT.includes('<pre className="flex-1 whitespace-pre-wrap'), 'read-only <pre> still present');
// Edit toggle + textarea editor + Save button.
assert.ok(COMPONENT.includes('handleStartEditingArtifact'), 'Edit toggle handler present');
assert.ok(COMPONENT.includes('<textarea'), 'textarea editor present');
assert.ok(COMPONENT.includes('handleSaveArtifact'), 'Save handler present');
assert.ok(COMPONENT.includes("'/api/tools/file-write'"), 'Save calls existing /api/tools/file-write');
// Preview refresh: previewKey bump + parent sync callback.
assert.ok(COMPONENT.includes('setPreviewKey((k) => k + 1)'), 'Save bumps previewKey');
assert.ok(COMPONENT.includes('onArtifactSaved?.(selectedArtifact, editedArtifactContent)'), 'Save notifies parent');
// Save status shown to the user.
assert.ok(COMPONENT.includes('Saved — preview refreshed'), 'saved status shown');
assert.ok(COMPONENT.includes('Save failed'), 'error status shown');
// No provider/model call anywhere in the save path: the component's only
// fetch calls in the artifact flow are file-read / file-write.
const artifactFetches = [...COMPONENT.matchAll(/fetch\('([^']+)'/g)].map((m) => m[1]);
assert.ok(artifactFetches.includes('/api/tools/file-read'), 'artifact read uses file-read');
assert.ok(artifactFetches.includes('/api/tools/file-write'), 'artifact save uses file-write');
assert.ok(
  !artifactFetches.some((u) => /generativelanguage|groq|openrouter|chat\/completions|generateContent/i.test(u)),
  'no provider/model fetch in component: ' + artifactFetches.join(', '),
);
// Parent syncs the preview's in-memory HTML when index.html is edited.
assert.ok(APP.includes("onArtifactSaved={(filePath, content) => {"), 'App wires onArtifactSaved');
assert.ok(APP.includes("if (filePath === 'projects/index.html') setCurrentSessionHtml(content);"), 'App syncs currentSessionHtml on index.html save');
console.log('✓ component + parent source checks pass');

// --- 2. Live endpoint check (throwaway server, no keys) --------------------
const PORT = 34567;
const SCRATCH = 'projects/__artifact-edit-proof.txt';
const EDITED = '<!-- edited by step-12 proof -->\n<h1>Edited artifact</h1>\n';

for (const v of ['GEMINI_API_KEY', 'GEMINI_API_KEYS', 'GROQ_API_KEY', 'GROQ_API_KEYS', 'OPENROUTER_API_KEY', 'OPENROUTER_API_KEYS', 'FREE_LLM_API_KEY']) {
  delete process.env[v];
}

const server: ChildProcess = spawn(
  // Spawn node + the tsx CLI directly (not via npx): SIGTERM then reaches
  // the server process itself, so the proof exits cleanly afterwards.
  process.execPath,
  ['node_modules/tsx/dist/cli.mjs', 'server.ts', '--port', String(PORT)],
  { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] },
);
let serverOut = '';
server.stdout?.on('data', (d) => { serverOut += String(d); });
server.stderr?.on('data', (d) => { serverOut += String(d); });

const waitForServer = async () => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not come up in 30s; output:\n' + serverOut);
};

try {
  await waitForServer();

  // Edit -> Save: POST the new content to the existing file-write endpoint.
  const writeRes = await fetch(`http://127.0.0.1:${PORT}/api/tools/file-write`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filePath: SCRATCH, content: EDITED }),
  });
  const writeJson: any = await writeRes.json();
  assert.strictEqual(writeRes.status, 200, 'file-write status 200, got ' + writeRes.status);
  assert.strictEqual(writeJson.success, true, 'file-write success:true');

  // Read back via the existing file-read endpoint — what the panel shows.
  const readRes = await fetch(`http://127.0.0.1:${PORT}/api/tools/file-read`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filePath: SCRATCH }),
  });
  const readJson: any = await readRes.json();
  assert.strictEqual(readJson.content, EDITED, 'read-back content equals edited content');
  console.log('✓ live file-write + file-read round-trip pass (edited content persisted)');
} finally {
  server.kill('SIGTERM');
  // Fallback: if the server ignores SIGTERM, force-kill it so this proof
  // process can exit (an orphaned server kept the first run alive).
  await new Promise((r) => setTimeout(r, 1000));
  try { process.kill(server.pid!, 'SIGKILL'); } catch { /* already dead */ }
  await fs.unlink(path.join(ROOT, SCRATCH)).catch(() => {});
}

console.log('STEP 12 PROOF: PASS — editable Artifacts panel, save via existing file-write, previewKey bump + parent sync, zero model calls');
