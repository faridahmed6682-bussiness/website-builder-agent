// GitHub one-click connect — OAuth App flow + PAT fallback.
//
// Token storage: AES-256-GCM encrypted at rest in data/github-token.enc.json.
// The encryption key comes from env GITHUB_TOKEN_ENCRYPTION_KEY (64 hex chars
// or base64 32 bytes) or, if unset, a machine-local key generated once and kept
// in data/github-enc-key (never committed — data/ is gitignored). On Render
// free the disk is ephemeral, so a redeploy may require reconnecting once;
// that is by design and is documented in the README.
// The token value is NEVER logged, NEVER returned by any endpoint, and NEVER
// embedded in a URL (unlike the legacy /api/github/sync git-remote approach).
import crypto from 'node:crypto';
import fs from 'fs/promises';
import path from 'path';
import { Octokit } from 'octokit';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const TOKEN_FILE = path.join(DATA_DIR, 'github-token.enc.json');
const KEY_FILE = path.join(DATA_DIR, 'github-enc-key');

export type GitHubTokenSource = 'oauth' | 'pat' | 'env';

export interface GitHubConnectionMeta {
  source: GitHubTokenSource;
  login: string;
  avatarUrl?: string;
  createdAt: string;
}

interface StoredTokenFile {
  iv: string;
  tag: string;
  data: string;
  meta: GitHubConnectionMeta;
}

// ---------------------------------------------------------------------------
// Encryption key
// ---------------------------------------------------------------------------

function parseKey(value: string): Buffer | null {
  const v = value.trim();
  try {
    if (/^[0-9a-fA-F]{64}$/.test(v)) return Buffer.from(v, 'hex');
    const b = Buffer.from(v, 'base64');
    if (b.length === 32) return b;
  } catch {
    return null;
  }
  return null;
}

async function getEncryptionKey(): Promise<Buffer> {
  const envKey = process.env.GITHUB_TOKEN_ENCRYPTION_KEY;
  if (envKey) {
    const parsed = parseKey(envKey);
    if (parsed) return parsed;
    console.warn('[github-auth] GITHUB_TOKEN_ENCRYPTION_KEY is set but not a 32-byte hex/base64 value; ignoring it.');
  }
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(KEY_FILE, 'utf-8');
    const parsed = parseKey(raw);
    if (parsed) return parsed;
  } catch {
    // fall through to generation
  }
  const generated = crypto.randomBytes(32);
  await fs.writeFile(KEY_FILE, generated.toString('hex'), { mode: 0o600 });
  return generated;
}

function encryptToken(key: Buffer, token: string): { iv: string; tag: string; data: string } {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

function decryptToken(key: Buffer, stored: StoredTokenFile): string {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(stored.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(stored.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(stored.data, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

// ---------------------------------------------------------------------------
// Store / read / delete
// ---------------------------------------------------------------------------

export async function storeGitHubToken(
  token: string,
  source: 'oauth' | 'pat',
): Promise<GitHubConnectionMeta> {
  const octokit = new Octokit({ auth: token });
  const { data: user } = await octokit.rest.users.getAuthenticated();
  const meta: GitHubConnectionMeta = {
    source,
    login: user.login,
    avatarUrl: user.avatar_url,
    createdAt: new Date().toISOString(),
  };
  const key = await getEncryptionKey();
  const enc = encryptToken(key, token);
  await fs.mkdir(DATA_DIR, { recursive: true });
  const file: StoredTokenFile = { ...enc, meta };
  await fs.writeFile(TOKEN_FILE, JSON.stringify(file, null, 2), { mode: 0o600 });
  return meta;
}

export async function readStoredGitHubToken(): Promise<{ token: string; meta: GitHubConnectionMeta } | null> {
  try {
    const raw = await fs.readFile(TOKEN_FILE, 'utf-8');
    const stored = JSON.parse(raw) as StoredTokenFile;
    const key = await getEncryptionKey();
    const token = decryptToken(key, stored);
    return { token, meta: stored.meta };
  } catch {
    return null;
  }
}

export async function deleteStoredGitHubToken(): Promise<void> {
  try {
    await fs.unlink(TOKEN_FILE);
  } catch {
    // already gone
  }
}

/** Preferred token: the one-click connected token first, GITHUB_TOKEN env as fallback. */
export async function getGitHubToken(): Promise<{ token: string; source: GitHubTokenSource } | null> {
  const stored = await readStoredGitHubToken();
  if (stored) return { token: stored.token, source: stored.meta.source };
  const envToken = process.env.GITHUB_TOKEN;
  if (envToken) return { token: envToken, source: 'env' };
  return null;
}

export async function getGitHubConnection(): Promise<
  { connected: true; source: GitHubTokenSource; login: string; avatarUrl?: string; createdAt?: string } | { connected: false }
> {
  const stored = await readStoredGitHubToken();
  if (stored) {
    return {
      connected: true,
      source: stored.meta.source,
      login: stored.meta.login,
      avatarUrl: stored.meta.avatarUrl,
      createdAt: stored.meta.createdAt,
    };
  }
  const envToken = process.env.GITHUB_TOKEN;
  if (envToken) {
    try {
      const octokit = new Octokit({ auth: envToken });
      const { data: user } = await octokit.rest.users.getAuthenticated();
      return { connected: true, source: 'env', login: user.login, avatarUrl: user.avatar_url };
    } catch {
      return { connected: false };
    }
  }
  return { connected: false };
}

// ---------------------------------------------------------------------------
// OAuth App flow
// ---------------------------------------------------------------------------

export function isOAuthConfigured(): boolean {
  return Boolean(process.env.GITHUB_OAUTH_CLIENT_ID && process.env.GITHUB_OAUTH_CLIENT_SECRET);
}

export function getOAuthCallbackUrl(reqOrigin: string): string {
  const appUrl = (process.env.APP_URL || '').replace(/\/$/, '');
  const origin = appUrl || reqOrigin.replace(/\/$/, '');
  return `${origin}/api/github/oauth/callback`;
}

// One-time state values (10 min expiry) to prevent CSRF on the callback.
const oauthStates = new Map<string, number>();

export function newOAuthState(): string {
  const state = crypto.randomBytes(24).toString('hex');
  oauthStates.set(state, Date.now() + 10 * 60 * 1000);
  return state;
}

export function consumeOAuthState(state: string): boolean {
  const expiry = oauthStates.get(state);
  oauthStates.delete(state);
  return Boolean(expiry && expiry > Date.now());
}

export function buildAuthorizeUrl(callbackUrl: string, state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GITHUB_OAUTH_CLIENT_ID || '',
    redirect_uri: callbackUrl,
    scope: 'repo',
    state,
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

export async function exchangeCodeForToken(code: string, redirectUri: string): Promise<string> {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.GITHUB_OAUTH_CLIENT_ID,
      client_secret: process.env.GITHUB_OAUTH_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    }),
  });
  const body = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!res.ok || !body.access_token) {
    throw new Error(body.error_description || body.error || `GitHub token exchange failed (HTTP ${res.status})`);
  }
  return body.access_token;
}

/**
 * Revoke an OAuth App token at GitHub (DELETE /applications/:client_id/token).
 * PATs cannot be revoked via the API — the caller must tell the user to delete
 * the PAT in GitHub Settings. Returns true when GitHub confirmed revocation.
 */
export async function revokeOAuthToken(token: string): Promise<boolean> {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return false;
  try {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const res = await fetch(
      `https://api.github.com/applications/${encodeURIComponent(clientId)}/token`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Basic ${basic}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({ access_token: token }),
      },
    );
    return res.status === 204;
  } catch {
    return false;
  }
}
