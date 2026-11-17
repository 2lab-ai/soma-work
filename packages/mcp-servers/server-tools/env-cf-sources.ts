/**
 * Deploy sources for `cf_api`: files a Cloudflare account entry may upload straight from a GitHub repository branch
 * (`cloudflare.accounts.<name>.sources`, e.g. `{"acme/site": ["main"]}`), read with the server's own GitHub token.
 *
 * A Worker's modules (about 250 KB for a small app) and its static assets (megabytes, binary) cannot ride in a tool
 * call, so the call names a repository, a branch and paths, and server-tools reads the files itself: the branch is
 * resolved to one commit first, every file is read at that commit, and the commit goes to the audit ledger. Only the
 * repositories and branches the account entry lists are read; the GitHub token never leaves server-tools.
 */

import { createHash } from 'node:crypto';
import { CfError, type CfFetch, type CfResponse } from './env-cloudflare.js';

const GITHUB = 'https://api.github.com';
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA = /^[0-9a-f]{40}$/;
const PATH_SEGMENT = /^[A-Za-z0-9_.@+~-]+$/;
const CALL_TIMEOUT_MS = 30_000;
/** One file read at most (Cloudflare's own limit on one static asset). */
export const MAX_SOURCE_FILE = 25 * 1024 * 1024;
/** All files of one call at most, and how many. */
export const MAX_SOURCE_TOTAL = 64 * 1024 * 1024;
export const MAX_SOURCE_FILES = 2000;

/** Repositories and branches an account entry may deploy from: `owner/name` → branch names. */
export type CfSources = Record<string, string[]>;

export interface SourceFile {
  /** Path below the directory read (for a single file, the path as named). */
  path: string;
  bytes: Buffer;
}

function scrub(text: string, token: string): string {
  return token ? text.split(token).join('[redacted]') : text;
}

/** The repository and branch a call names, checked against the account entry's `sources`. */
export function sourceRef(
  sources: CfSources | undefined,
  value: unknown,
  account: string,
): { repo: string; ref: string } {
  const { repo, ref } = (value ?? {}) as { repo?: unknown; ref?: unknown };
  if (typeof repo !== 'string' || !REPO.test(repo) || typeof ref !== 'string' || ref === '') {
    throw new CfError('a source is {"repo": "owner/name", "ref": "<branch>"}');
  }
  const own = Object.entries(sources ?? {}).find(([name]) => name.toLowerCase() === repo.toLowerCase());
  if (!own) throw new CfError(`${repo} is not a source of account ${account} (cloudflare.accounts.${account}.sources)`);
  if (!Array.isArray(own[1]) || !own[1].includes(ref)) {
    throw new CfError(`${ref} is not a branch account ${account} deploys ${repo} from`);
  }
  return { repo: own[0], ref };
}

/** A path inside the repository: plain segments, no `.` or `..`, no leading or doubled `/`. */
export function sourcePath(value: unknown): string {
  if (typeof value !== 'string' || value === '' || value.length > 512) throw new CfError('a source path is required');
  const segments = value.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..' || !PATH_SEGMENT.test(s))) {
    throw new CfError(`${value} is not a plain path in the repository`);
  }
  return segments.join('/');
}

async function github(fetch: CfFetch, token: string, path: string, accept: string): Promise<CfResponse> {
  let res: CfResponse;
  try {
    res = await fetch(`${GITHUB}${path}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: accept,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'soma-work-server-tools',
      },
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      // A redirect would carry the token somewhere this module never checked.
      redirect: 'manual',
    });
  } catch (err) {
    throw new CfError(`GitHub GET ${path} got no answer (${err instanceof Error ? err.name : 'error'})`);
  }
  if (res.status !== 200) {
    let message = 'no message';
    try {
      const json = (await res.json()) as { message?: unknown } | null;
      if (typeof json?.message === 'string') message = json.message;
    } catch {
      // no readable message
    }
    throw new CfError(`GitHub GET ${path} answered ${res.status}: ${scrub(message, token)}`);
  }
  return res;
}

async function json(res: CfResponse): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    throw new CfError('GitHub answered with an unreadable body');
  }
}

/**
 * The branch's head commit now: every file of the call is read at this commit. Resolved through the branches
 * endpoint, which takes branch names only — a tag or a commit with the same name never stands in for the branch.
 */
export async function sourceCommit(fetch: CfFetch, token: string, repo: string, ref: string): Promise<string> {
  const res = await github(
    fetch,
    token,
    `/repos/${repo}/branches/${encodeURIComponent(ref)}`,
    'application/vnd.github+json',
  );
  const branch = (await json(res)) as { name?: unknown; commit?: { sha?: unknown } } | null;
  const sha = branch?.commit?.sha;
  if (branch?.name !== ref || typeof sha !== 'string' || !SHA.test(sha)) {
    throw new CfError(`GitHub named no head commit for branch ${ref} of ${repo}`);
  }
  return sha;
}

const contentsPath = (repo: string, commit: string, path: string) =>
  `/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${commit}`;

/** A body read up to `limit` bytes and no further: a larger file fails without filling this process's memory. */
async function boundedBytes(res: CfResponse, limit: number, path: string): Promise<Buffer> {
  const tooLarge = () => new CfError(`${path} is larger than the ${limit} bytes left for this call`);
  const stream = res.body;
  if (stream && typeof stream.getReader === 'function') {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks);
      total += value.length;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
    }
  }
  if (typeof res.arrayBuffer !== 'function') throw new CfError(`GitHub answered ${path} without its bytes`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > limit) throw tooLarge();
  return bytes;
}

/** One file's bytes at the commit, at most `limit` of them (and never more than `MAX_SOURCE_FILE`). */
export async function sourceFile(
  fetch: CfFetch,
  token: string,
  repo: string,
  commit: string,
  path: string,
  limit = MAX_SOURCE_FILE,
): Promise<Buffer> {
  const res = await github(fetch, token, contentsPath(repo, commit, path), 'application/vnd.github.raw');
  return boundedBytes(res, Math.min(limit, MAX_SOURCE_FILE), path);
}

/**
 * Every file below a directory at the commit, its path relative to the directory. Listed from the commit's whole Git
 * tree (a contents listing stops at 1,000 entries, which would deploy with files missing); a tree GitHub truncated is
 * refused. Symbolic links (mode 120000) and submodules are refused by their Git metadata: they point outside what the
 * branch holds. The count and sizes are checked from the tree before anything is read.
 */
export async function sourceDir(
  fetch: CfFetch,
  token: string,
  repo: string,
  commit: string,
  dir: string,
): Promise<SourceFile[]> {
  const tree = (await json(
    await github(fetch, token, `/repos/${repo}/git/trees/${commit}?recursive=1`, 'application/vnd.github+json'),
  )) as { tree?: unknown; truncated?: unknown } | null;
  if (!tree || !Array.isArray(tree.tree) || tree.truncated !== false) {
    throw new CfError(`GitHub could not list the whole tree of ${repo} at ${commit}; nothing was uploaded`);
  }
  const below: { path: string; size: number }[] = [];
  for (const entry of tree.tree as { path?: unknown; mode?: unknown; type?: unknown; size?: unknown }[]) {
    if (typeof entry?.path !== 'string' || !entry.path.startsWith(`${dir}/`)) continue;
    const path = sourcePath(entry.path);
    if (entry.type === 'tree') continue;
    if (entry.type === 'commit') throw new CfError(`${path} is a submodule, not a file`);
    if (entry.type !== 'blob' || entry.mode === '120000') throw new CfError(`${path} is a symbolic link, not a file`);
    if (typeof entry.size !== 'number' || entry.size < 0) throw new CfError(`GitHub gave no size for ${path}`);
    if (entry.size > MAX_SOURCE_FILE) throw new CfError(`${path} is larger than ${MAX_SOURCE_FILE} bytes`);
    below.push({ path, size: entry.size });
  }
  if (below.length === 0) throw new CfError(`${dir} holds no files`);
  if (below.length > MAX_SOURCE_FILES) throw new CfError(`${dir} holds more than ${MAX_SOURCE_FILES} files`);
  if (below.reduce((n, f) => n + f.size, 0) > MAX_SOURCE_TOTAL) {
    throw new CfError(`${dir} holds more than ${MAX_SOURCE_TOTAL} bytes`);
  }
  const files: SourceFile[] = [];
  for (const { path, size } of below) {
    const bytes = await sourceFile(fetch, token, repo, commit, path, size);
    files.push({ path: path.slice(dir.length + 1), bytes });
  }
  return files;
}

const MEDIA_TYPES: Record<string, string> = {
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'application/javascript',
  mjs: 'application/javascript',
  json: 'application/json',
  map: 'application/json',
  txt: 'text/plain',
  xml: 'application/xml',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  webm: 'video/webm',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wasm: 'application/wasm',
  pdf: 'application/pdf',
  webmanifest: 'application/manifest+json',
};

export interface StaticAsset {
  /** The path the Worker serves it at: `/` + its path below the directory. */
  path: string;
  hash: string;
  size: number;
  type: string;
  base64: string;
}

/**
 * Static assets as Cloudflare's upload takes them: hash = the first 32 hex characters of the SHA-256 of the file's
 * base64 followed by its extension (no dot), as wrangler computes it.
 */
export function staticAssets(files: SourceFile[]): StaticAsset[] {
  return files.map(({ path, bytes }) => {
    const base64 = bytes.toString('base64');
    const dot = path.lastIndexOf('.');
    const extension = dot > path.lastIndexOf('/') && dot >= 0 ? path.slice(dot + 1) : '';
    return {
      path: `/${path}`,
      hash: createHash('sha256')
        .update(base64 + extension)
        .digest('hex')
        .slice(0, 32),
      size: bytes.length,
      type: MEDIA_TYPES[extension.toLowerCase()] ?? 'application/octet-stream',
      base64,
    };
  });
}
