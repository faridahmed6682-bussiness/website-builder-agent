// Firebase one-click connect — Google AI Studio-style.
//
// HONEST SETUP (documented in the README): the agent cannot create a
// Firebase project inside the user's Google account by itself. First time,
// the user connects once — either by pasting the Firebase web config (from
// the Firebase console: Project settings → Your apps → Web app) or a
// google-services.json — or via Google authorize. After that single connect,
// every project gets Firebase in one click. Free Spark plan, no card needed.
//
// Storage: the config is stored ENCRYPTED server-side (AES-256-GCM, same
// pattern as server/githubAuth.ts) in data/firebase-config.enc.json. The
// encryption key comes from env FIREBASE_CONFIG_ENCRYPTION_KEY or a
// machine-local key file (data/firebase-enc-key, 0600). The API key is NEVER
// printed, logged, or returned by any endpoint — only projectId/authDomain
// are ever shown. (Note: a Firebase WEB apiKey is a public client identifier
// — Google's own docs say it is not a secret — but this project still treats
// it as sensitive: encrypted at rest, never in code/logs/chat.)
//
// Validation (the Nexus pattern): format-check the config, then test the
// connection live with an Identity Toolkit probe (accounts:signUp with no
// credentials — it fails with MISSING_EMAIL when the key is valid, and with
// "API key not valid" when it is not; nothing is created).
//
// Project wiring (addFirebaseToProject): writes the Firebase SDK + Auth +
// Firestore code into the BUILT project (projects/<session>/), plus
// firebase.json + .firebaserc + firestore.rules, so the project is
// deploy-ready. Plain-HTML projects get a CDN-module firebase.js; Vite/React
// projects also get src/lib/firebase.ts and firebase added to dependencies.
// The agent's OWN source tree is never written to — the old upstream pattern
// (plaintext firebase-config.json + src/lib/firebase.ts in the repo root) is
// deliberately NOT used here.
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const DATA_DIR = path.resolve(process.cwd(), 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'firebase-config.enc.json');
const KEY_FILE = path.join(DATA_DIR, 'firebase-enc-key');
const PROJECTS_DIR = path.resolve(process.cwd(), 'projects');

export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId?: string;
}

// ---------------------------------------------------------------------------
// Encryption (AES-256-GCM; key from env or a machine-local key file)
// ---------------------------------------------------------------------------
async function getOrCreateEncryptionKey(): Promise<Buffer> {
  const envKey = process.env.FIREBASE_CONFIG_ENCRYPTION_KEY || '';
  if (envKey) {
    const b = /^[0-9a-fA-F]{64}$/.test(envKey)
      ? Buffer.from(envKey, 'hex')
      : Buffer.from(envKey, 'base64');
    if (b.length === 32) return b;
  }
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(KEY_FILE, 'utf-8');
    const b = Buffer.from(raw.trim(), 'base64');
    if (b.length === 32) return b;
  } catch { /* fall through to generation */ }
  const key = crypto.randomBytes(32);
  await fs.writeFile(KEY_FILE, key.toString('base64'), { mode: 0o600 }).catch(() => {});
  return key;
}

async function encryptConfig(config: FirebaseWebConfig): Promise<string> {
  const key = await getOrCreateEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(config), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

async function decryptConfig(blob: string): Promise<FirebaseWebConfig> {
  const key = await getOrCreateEncryptionKey();
  const buf = Buffer.from(blob, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const out = Buffer.concat([decipher.update(enc), decipher.final()]);
  return JSON.parse(out.toString('utf-8')) as FirebaseWebConfig;
}

// ---------------------------------------------------------------------------
// Parsing: Firebase web config object OR google-services.json
// ---------------------------------------------------------------------------
export function parseFirebaseWebConfig(input: unknown): FirebaseWebConfig | null {
  const obj = typeof input === 'string' ? safeJsonParse(input) : input;
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, any>;
  const apiKey = String(o.apiKey || o.api_key || '').trim();
  const projectId = String(o.projectId || o.project_id || '').trim();
  if (!apiKey || !projectId) return null;
  return {
    apiKey,
    authDomain: String(o.authDomain || `${projectId}.firebaseapp.com`),
    projectId,
    storageBucket: String(o.storageBucket || `${projectId}.appspot.com`),
    messagingSenderId: String(o.messagingSenderId || ''),
    appId: String(o.appId || ''),
  };
}

export function parseGoogleServicesJson(text: string): FirebaseWebConfig | null {
  const obj = safeJsonParse(text);
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, any>;
  const projectId = String(o.project_info?.project_id || '').trim();
  const client = Array.isArray(o.client) ? o.client[0] : null;
  const apiKey = String(client?.api_key?.[0]?.current_key || '').trim();
  const appId = String(client?.client_info?.mobilesdk_app_id || '').trim();
  if (!apiKey || !projectId) return null;
  return {
    apiKey,
    authDomain: `${projectId}.firebaseapp.com`,
    projectId,
    storageBucket: String(o.project_info?.storage_bucket || `${projectId}.appspot.com`),
    messagingSenderId: String(o.project_info?.project_number || ''),
    appId,
  };
}

function safeJsonParse(text: string): any {
  try {
    // Tolerate a pasted JS object literal (const firebaseConfig = {...};)
    const cleaned = text.trim().replace(/^(const|let|var)\s+\w+\s*=\s*/, '').replace(/;$/, '');
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Live connection test — Identity Toolkit probe (creates nothing)
// ---------------------------------------------------------------------------
export async function testFirebaseConfig(config: FirebaseWebConfig): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(config.apiKey)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}), signal: AbortSignal.timeout(15000) },
    );
    const body: any = await res.json().catch(() => null);
    const msg = String(body?.error?.message || '');
    if (/API key not valid|API_KEY_INVALID/i.test(msg)) {
      return { ok: false, error: 'The Firebase API key is not valid. Copy the web config again from Firebase console → Project settings → Your apps.' };
    }
    if (/PROJECT_NOT_FOUND|PERMISSION_DENIED|has been deleted/i.test(msg)) {
      return { ok: false, error: `Firebase project "${config.projectId}" was not accepted: ${msg.slice(0, 160)}` };
    }
    // MISSING_EMAIL / INVALID_EMAIL / WEAK_PASSWORD etc. all mean the key was
    // accepted and the project exists — the probe creates nothing.
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: `Could not reach Google to test the key (${err?.message || 'network error'}). Check the network and try again.` };
  }
}

// ---------------------------------------------------------------------------
// Store / status / disconnect
// ---------------------------------------------------------------------------
export async function storeFirebaseConfig(config: FirebaseWebConfig): Promise<{ projectId: string; verified: boolean; warning?: string }> {
  if (!/^AIza[0-9A-Za-z_-]{35}$/.test(config.apiKey)) {
    throw new Error('The API key does not look like a Firebase web API key (it should start with "AIza" and be 39 characters).');
  }
  if (!/^[a-z0-9][a-z0-9-]{4,29}$/.test(config.projectId)) {
    throw new Error(`"${config.projectId}" does not look like a Firebase project ID (lowercase letters, digits, dashes).`);
  }
  const test = await testFirebaseConfig(config);
  if (!test.ok && !/Could not reach Google/.test(test.error || '')) {
    throw new Error(test.error || 'Firebase connection test failed.');
  }
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(CONFIG_FILE, JSON.stringify({ encrypted: await encryptConfig(config) }, null, 2), 'utf-8');
  return {
    projectId: config.projectId,
    verified: test.ok,
    warning: test.ok ? undefined : 'Saved, but the live test could not reach Google — the key is unverified.',
  };
}

export async function readFirebaseConfig(): Promise<FirebaseWebConfig | null> {
  try {
    const raw = await fs.readFile(CONFIG_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed?.encrypted) return null;
    return decryptConfig(parsed.encrypted);
  } catch {
    return null;
  }
}

/** Connected status — projectId/authDomain ONLY, never the API key. */
export async function getFirebaseStatus(): Promise<{ connected: boolean; projectId?: string; authDomain?: string; storageBucket?: string }> {
  const config = await readFirebaseConfig();
  if (!config) return { connected: false };
  return { connected: true, projectId: config.projectId, authDomain: config.authDomain, storageBucket: config.storageBucket };
}

export async function deleteFirebaseConfig(): Promise<void> {
  await fs.rm(CONFIG_FILE, { force: true }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Add Firebase to a built project (one click per project)
// ---------------------------------------------------------------------------
function firebaseJsModule(config: FirebaseWebConfig): string {
  return `// Firebase — wired by the agent (project: ${config.projectId}).
// BACKEND RULE: this app talks DIRECTLY from the browser to Firebase
// (Auth + Firestore + Storage). No Express server is needed for login, data
// or files — see the README "Backend architecture" section. Express is only
// added when custom server logic is required (hidden secrets, webhooks,
// scheduled jobs), and then Cloud Functions come first.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.3.0/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/13.3.0/firebase-auth.js';
import { getFirestore, collection, addDoc, getDocs, query, orderBy, limit } from 'https://www.gstatic.com/firebasejs/13.3.0/firebase-firestore.js';
import { getStorage } from 'https://www.gstatic.com/firebasejs/13.3.0/firebase-storage.js';

export const firebaseConfig = ${JSON.stringify({ apiKey: config.apiKey, authDomain: config.authDomain, projectId: config.projectId, storageBucket: config.storageBucket, messagingSenderId: config.messagingSenderId, appId: config.appId }, null, 2)};
export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);
export const googleProvider = new GoogleAuthProvider();
export const signInWithGoogle = () => signInWithPopup(auth, googleProvider);
export const signOutUser = () => signOut(auth);
export { onAuthStateChanged, collection, addDoc, getDocs, query, orderBy, limit };
`;
}

function firebaseTsModule(config: FirebaseWebConfig): string {
  return `// Firebase — wired by the agent (project: ${config.projectId}).
// BACKEND RULE: this app talks DIRECTLY from the browser to Firebase
// (Auth + Firestore + Storage). No Express server is needed for login, data
// or files. Express is only added when custom server logic is required.
import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, addDoc, getDocs, query, orderBy, limit } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';

export const firebaseConfig = ${JSON.stringify({ apiKey: config.apiKey, authDomain: config.authDomain, projectId: config.projectId, storageBucket: config.storageBucket, messagingSenderId: config.messagingSenderId, appId: config.appId }, null, 2)};
export const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
export const db = getFirestore(app);
export const auth = getAuth(app);
export const storage = getStorage(app);
export const googleProvider = new GoogleAuthProvider();
export const signInWithGoogle = () => signInWithPopup(auth, googleProvider);
export const signOutUser = () => signOut(auth);
export { onAuthStateChanged, collection, addDoc, getDocs, query, orderBy, limit };
`;
}

const DEFAULT_FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // User profile documents — owner read/write only
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
    // Default: authenticated access only
    match /{document=**} {
      allow read, write: if request.auth != null;
    }
  }
}
`;

export async function addFirebaseToProject(sessionId?: string): Promise<{
  success: boolean;
  projectId: string;
  filesWritten: string[];
  needsInstall: boolean;
  error?: string;
}> {
  const config = await readFirebaseConfig();
  if (!config) {
    return { success: false, projectId: '', filesWritten: [], needsInstall: false, error: 'Firebase is not connected yet. Click "Connect Firebase" once and paste the Firebase web config (or google-services.json), then try again.' };
  }
  const dirName = sessionId ? `projects/${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}` : 'projects';
  const dir = path.resolve(process.cwd(), dirName);
  try {
    await fs.stat(path.join(dir, 'index.html'));
  } catch {
    return { success: false, projectId: config.projectId, filesWritten: [], needsInstall: false, error: `No built project found at ${dirName}/index.html yet. Build the site first, then add Firebase.` };
  }
  const filesWritten: string[] = [];
  // 1. Plain-HTML module (works in any built site) + inject into index.html.
  await fs.writeFile(path.join(dir, 'firebase.js'), firebaseJsModule(config), 'utf-8');
  filesWritten.push('firebase.js');
  const indexPath = path.join(dir, 'index.html');
  let html = await fs.readFile(indexPath, 'utf-8');
  if (!html.includes('firebase.js')) {
    const tag = '\n  <script type="module" src="./firebase.js"></script>\n';
    html = html.includes('</body>') ? html.replace('</body>', `${tag}</body>`) : html + tag;
    await fs.writeFile(indexPath, html, 'utf-8');
    filesWritten.push('index.html (Firebase module injected)');
  }
  // 2. Vite/React projects also get src/lib/firebase.ts + firebase in deps.
  let needsInstall = false;
  const pkgPath = path.join(dir, 'package.json');
  try {
    const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8'));
    const libDir = path.join(dir, 'src', 'lib');
    await fs.mkdir(libDir, { recursive: true });
    await fs.writeFile(path.join(libDir, 'firebase.ts'), firebaseTsModule(config), 'utf-8');
    filesWritten.push('src/lib/firebase.ts');
    if (!pkg.dependencies?.firebase) {
      pkg.dependencies = { ...(pkg.dependencies || {}), firebase: '^13.3.0' };
      await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2), 'utf-8');
      filesWritten.push('package.json (firebase dependency added)');
      needsInstall = true;
    }
  } catch { /* not a Vite project — the CDN module covers it */ }
  // 3. Hosting + rules files (deploy-ready).
  await fs.writeFile(path.join(dir, 'firebase.json'), JSON.stringify({ hosting: { public: '.', ignore: ['firebase.json', '**/.*', '**/node_modules/**'] } }, null, 2), 'utf-8');
  filesWritten.push('firebase.json');
  await fs.writeFile(path.join(dir, '.firebaserc'), JSON.stringify({ projects: { default: config.projectId } }, null, 2), 'utf-8');
  filesWritten.push('.firebaserc');
  try {
    await fs.access(path.join(dir, 'firestore.rules'));
  } catch {
    await fs.writeFile(path.join(dir, 'firestore.rules'), DEFAULT_FIRESTORE_RULES, 'utf-8');
    filesWritten.push('firestore.rules');
  }
  return { success: true, projectId: config.projectId, filesWritten, needsInstall };
}

// ---------------------------------------------------------------------------
// Deploy to Firebase Hosting (real deploy — only with FIREBASE_TOKEN)
// ---------------------------------------------------------------------------
export async function deployFirebaseHosting(sessionId?: string): Promise<
  | { status: 'live'; url: string; projectId: string; output: string }
  | { status: 'setup-needed'; projectId: string; steps: string[] }
  | { status: 'error'; projectId: string; error: string }
> {
  const config = await readFirebaseConfig();
  if (!config) {
    return { status: 'error', projectId: '', error: 'Firebase is not connected yet. Click "Connect Firebase" first.' };
  }
  const token = process.env.FIREBASE_TOKEN || '';
  if (!token) {
    return {
      status: 'setup-needed',
      projectId: config.projectId,
      steps: [
        'One-time setup (2 minutes, free): on your own machine/Termux, run: npx firebase-tools login:ci — sign in with the Google account that owns the Firebase project and copy the token it prints.',
        'Set the FIREBASE_TOKEN env var on this service (Render dashboard → Environment, or export FIREBASE_TOKEN=… in Termux) and restart the service once.',
        'Then click Deploy to Firebase Hosting again — the built site deploys to https://' + config.projectId + '.web.app.',
        'Alternative: the main Deploy button pushes the same project to GitHub + Render hosting in one click (no Firebase login needed).',
      ],
    };
  }
  const dirName = sessionId ? `projects/${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}` : 'projects';
  const dir = path.resolve(process.cwd(), dirName);
  try {
    const { stdout, stderr } = await execAsync(
      `npx -y firebase-tools@latest deploy --only hosting --token "${token.replace(/"/g, '')}" --non-interactive`,
      { cwd: dir, timeout: 300000, maxBuffer: 1024 * 1024 },
    );
    const out = `${stdout}\n${stderr}`.slice(-3000);
    const urlMatch = out.match(/https:\/\/[a-z0-9-]+\.web\.app/g);
    const url = urlMatch?.[0] || `https://${config.projectId}.web.app`;
    return { status: 'live', url, projectId: config.projectId, output: out };
  } catch (err: any) {
    const out = String(err?.stdout || '') + String(err?.stderr || '') + String(err?.message || '');
    return { status: 'error', projectId: config.projectId, error: `Firebase Hosting deploy failed: ${out.slice(-800)}` };
  }
}
