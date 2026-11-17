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
const MAX_DIR_DEPTH = 16;

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

/** The branch's head commit now: every file of the call is read at this commit. */
export async function sourceCommit(fetch: CfFetch, token: string, repo: string, ref: string): Promise<string> {
  const res = await github(
    fetch,
    token,
    `/repos/${repo}/commits/${encodeURIComponent(ref)}`,
    'application/vnd.github+json',
  );
  const sha = ((await json(res)) as { sha?: unknown } | null)?.sha;
  if (typeof sha !== 'string' || !SHA.test(sha)) throw new CfError(`GitHub named no commit for ${repo}@${ref}`);
  return sha;
}

const contentsPath = (repo: string, commit: string, path: string) =>
  `/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${commit}`;

/** One file's bytes at the commit. */
export async function sourceFile(
  fetch: CfFetch,
  token: string,
  repo: string,
  commit: string,
  path: string,
): Promise<Buffer> {
  const res = await github(fetch, token, contentsPath(repo, commit, path), 'application/vnd.github.raw');
  if (typeof res.arrayBuffer !== 'function') throw new CfError(`GitHub answered ${path} without its bytes`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_SOURCE_FILE) throw new CfError(`${path} is larger than ${MAX_SOURCE_FILE} bytes`);
  return bytes;
}

/**
 * Every file below a directory at the commit, its path relative to the directory. Symbolic links and submodules are
 * refused: they point outside what the branch holds.
 */
export async function sourceDir(
  fetch: CfFetch,
  token: string,
  repo: string,
  commit: string,
  dir: string,
): Promise<SourceFile[]> {
  const files: SourceFile[] = [];
  let total = 0;
  const walk = async (path: string, depth: number): Promise<void> => {
    if (depth > MAX_DIR_DEPTH) throw new CfError(`${path} is nested deeper than ${MAX_DIR_DEPTH} directories`);
    const listing = await json(
      await github(fetch, token, contentsPath(repo, commit, path), 'application/vnd.github+json'),
    );
    if (!Array.isArray(listing)) throw new CfError(`${path} is not a directory`);
    for (const entry of listing as { type?: unknown; path?: unknown; size?: unknown }[]) {
      const entryPath = sourcePath(entry?.path);
      if (!entryPath.startsWith(`${dir}/`)) throw new CfError(`GitHub listed ${entryPath} outside ${dir}`);
      if (entry.type === 'dir') {
        await walk(entryPath, depth + 1);
      } else if (entry.type === 'file') {
        if (files.length >= MAX_SOURCE_FILES) throw new CfError(`${dir} holds more than ${MAX_SOURCE_FILES} files`);
        const bytes = await sourceFile(fetch, token, repo, commit, entryPath);
        total += bytes.length;
        if (total > MAX_SOURCE_TOTAL) throw new CfError(`${dir} holds more than ${MAX_SOURCE_TOTAL} bytes`);
        files.push({ path: entryPath.slice(dir.length + 1), bytes });
      } else {
        throw new CfError(`${entryPath} is a ${String(entry?.type)}, not a file or directory`);
      }
    }
  };
  await walk(dir, 0);
  if (files.length === 0) throw new CfError(`${dir} holds no files`);
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
