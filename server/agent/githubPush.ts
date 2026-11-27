// GitHub push via the Git Data API — one commit per push, no local git,
// no token in any URL (unlike the legacy /api/github/sync git-remote flow).
// Port of Nexus-ai6 GitHubPushClient.kt (pushFiles) + GitHubPushPaths.kt
// (path guard) + GitHubRepoCreator.kt. Auth: GITHUB_TOKEN env or the
// one-click connected token (see githubAuth.ts) — never in code.
import fs from 'fs/promises';
import path from 'path';
import { Octokit } from 'octokit';
import { getGitHubToken } from './githubAuth.ts';

export interface PushFileInput {
  /** Repo-relative path, e.g. "index.html" or "assets/style.css". */
  repoPath: string;
  /** File content as text, or base64 when isBinary is true. */
  content: string;
  isBinary?: boolean;
}

export interface PushResult {
  repoUrl: string;
  commitSha: string;
  commitUrl: string;
  branch: string;
  filesPushed: number;
  skipped: string[];
}

// --- Path guard (GitHubPushPaths.kt, ported verbatim in intent) -------------
const BLOCKED_FILENAME = /^(google-services\.json|\.env.*|id_rsa.*|id_ed25519.*)$/i;
const BLOCKED_EXTENSION = /\.(pem|key|p12|pfx)$/i;
const BINARY_EXTENSIONS = new Set(
  'png jpg jpeg gif webp ico bmp pdf zip apk aab jar mp3 mp4 wav ogg ttf otf woff woff2 eot gz tar xz 7z rar exe dll so bin dat db sqlite class dex'.split(' '),
);

export function sanitizeRepoPath(raw: string): string | null {
  let p = (raw || '').replace(/\\/g, '/').trim();
  while (p.startsWith('./')) p = p.slice(2);
  while (p.startsWith('/')) p = p.slice(1);
  p = p.replace(/\/{2,}/g, '/').replace(/\/\.\//g, '/');
  if (!p) return null;
  const segments = p.split('/');
  if (segments.some((s) => s === '..' || s === '.git')) return null;
  if (segments.some((s) => /secret|credential/i.test(s))) return null;
  const fileName = segments[segments.length - 1];
  if (BLOCKED_FILENAME.test(fileName) || BLOCKED_EXTENSION.test(fileName)) return null;
  return p;
}

function isBinaryPath(p: string, content: Buffer): boolean {
  const ext = p.split('.').pop()?.toLowerCase() || '';
  if (BINARY_EXTENSIONS.has(ext)) return true;
  return content.subarray(0, 1024).includes(0);
}

async function apiCall<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const status = err?.status;
      if (status === 429 || status === 403) {
        await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

export async function resolveGitHubToken(provided?: string): Promise<string> {
  if (provided) return provided;
  const connected = await getGitHubToken();
  if (connected) return connected.token;
  throw new Error(
    'GitHub is not connected. Connect GitHub once in the UI (OAuth or PAT) or set the GITHUB_TOKEN env var.',
  );
}

export async function getGitHubLogin(token: string): Promise<string> {
  const octokit = new Octokit({ auth: token });
  const { data: user } = await apiCall(() => octokit.rest.users.getAuthenticated());
  return user.login;
}

export async function ensureRepo(
  octokit: Octokit,
  owner: string,
  repo: string,
  isPrivate: boolean,
  description?: string,
): Promise<string> {
  try {
    const { data } = await apiCall(() => octokit.rest.repos.get({ owner, repo }));
    return data.html_url;
  } catch (err: any) {
    if (err?.status !== 404) throw err;
    try {
      const { data } = await apiCall(() =>
        octokit.rest.repos.createForAuthenticatedUser({
          name: repo,
          private: isPrivate,
          description: description || 'Built with Nexus AI Studio',
          auto_init: false,
        }),
      );
      return data.html_url;
    } catch (createErr: any) {
      if (createErr?.status === 403 || createErr?.status === 404) {
        throw new Error(
          'GitHub App installation tokens cannot create repos — use a PAT with repo scope (connect GitHub with a PAT, or set GITHUB_TOKEN).',
        );
      }
      throw createErr;
    }
  }
}

/** Push files to owner/repo/branch as ONE commit (Git Data API). */
export async function pushFilesToGitHub(opts: {
  token?: string;
  owner?: string;
  repo: string;
  branch?: string;
  message: string;
  files: PushFileInput[];
  isPrivate?: boolean;
  description?: string;
}): Promise<PushResult> {
  const token = await resolveGitHubToken(opts.token);
  const octokit = new Octokit({ auth: token });
  const owner = opts.owner || (await getGitHubLogin(token));
  const branch = opts.branch || 'main';
  const repo = opts.repo;
  if (!repo || /[/\s]/.test(repo)) throw new Error('Repository name must not contain "/" or spaces.');
  if (!opts.files.length) throw new Error('No files to push.');

  const repoUrl = await ensureRepo(octokit, owner, repo, Boolean(opts.isPrivate), opts.description);

  // Sanitise + de-duplicate (last wins).
  const byPath = new Map<string, PushFileInput>();
  for (const f of opts.files) {
    const clean = sanitizeRepoPath(f.repoPath);
    if (!clean) continue;
    byPath.set(clean, { ...f, repoPath: clean });
  }
  const files = [...byPath.values()];
  if (!files.length) throw new Error('All file paths were blocked by the safety guard (secrets/keys/.env/.git paths are never pushed).');

  // Base commit/tree (if the branch exists yet).
  let headSha: string | null = null;
  let baseTreeSha: string | null = null;
  try {
    const { data: ref } = await apiCall(() => octokit.rest.git.getRef({ owner, repo, ref: `heads/${branch}` }));
    headSha = ref.object.sha;
    const { data: commit } = await apiCall(() => octokit.rest.git.getCommit({ owner, repo, commit_sha: headSha! }));
    baseTreeSha = commit.tree.sha;
  } catch (err: any) {
    if (err?.status !== 404) throw err;
  }

  // Blobs.
  const tree: Array<{ path: string; mode: '100644'; type: 'blob'; sha: string }> = [];
  for (const f of files) {
    const { data: blob } = await apiCall(() =>
      octokit.rest.git.createBlob({
        owner,
        repo,
        content: f.content,
        encoding: f.isBinary ? 'base64' : 'utf-8',
      }),
    );
    tree.push({ path: f.repoPath, mode: '100644', type: 'blob', sha: blob.sha });
  }

  const { data: newTree } = await apiCall(() =>
    octokit.rest.git.createTree({
      owner,
      repo,
      base_tree: baseTreeSha || undefined,
      tree,
    }),
  );
  const { data: newCommit } = await apiCall(() =>
    octokit.rest.git.createCommit({
      owner,
      repo,
      message: opts.message,
      tree: newTree.sha,
      parents: headSha ? [headSha] : [],
    }),
  );
  const commitUrl = newCommit.html_url || `https://github.com/${owner}/${repo}/commit/${newCommit.sha}`;
  try {
    if (headSha) {
      await apiCall(() =>
        octokit.rest.git.updateRef({ owner, repo, ref: `heads/${branch}`, sha: newCommit.sha, force: false }),
      );
    } else {
      await apiCall(() =>
        octokit.rest.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: newCommit.sha }),
      );
    }
  } catch (err: any) {
    if (err?.status === 422) {
      throw new Error(
        `Push rejected: the ${branch} branch moved since the push started (non-fast-forward). Pull the latest changes and push again.`,
      );
    }
    throw err;
  }
  return { repoUrl, commitSha: newCommit.sha, commitUrl, branch, filesPushed: files.length, skipped: [] };
}

/** Collect a project directory into pushable files (≤500 files, ≤1 MB each). */
export async function collectProjectDir(dir: string): Promise<{ files: PushFileInput[]; skipped: string[] }> {
  const files: PushFileInput[] = [];
  const skipped: string[] = [];
  const skipDirs = new Set(['.git', 'node_modules', '.nexus_sticky_key.json']);
  async function walk(current: string, rel: string) {
    if (files.length >= 500) return;
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) await walk(abs, relPath);
      } else if (entry.isFile()) {
        if (entry.name === '.DS_Store') continue;
        const buf = await fs.readFile(abs);
        if (buf.length > 1024 * 1024) {
          skipped.push(`${relPath} (>1 MB)`);
          continue;
        }
        const binary = isBinaryPath(relPath, buf);
        files.push({ repoPath: relPath, content: binary ? buf.toString('base64') : buf.toString('utf-8'), isBinary: binary });
      }
    }
  }
  await walk(dir, '');
  return { files, skipped };
}
