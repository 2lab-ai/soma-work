// gh execution inside the broker (.prd/16-devops-tools-architecture.md §7): the root-owned pinned gh, one token
// per call through GH_TOKEN, a fixed environment, fresh empty HOME / config / cwd, time, output and memory caps,
// and scrubbed output. Never `gh auth switch` and never the operator's gh config.

import { type ChildProcess, execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { classifyGh, type GhDenyCode, type GhPolicyContext } from '@soma/process-shared/devops/gh-policy.js';
import { scrub, scrubTruncated } from './scrub.js';

export interface GhRunResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  /** gh's resident memory went over `maxRssBytes` and its process group was killed. */
  killedForMemory: boolean;
  /** Memory could not be sampled several times in a row, so the process group was killed (fail closed). */
  watchdogFailed: boolean;
  durationMs: number;
}

/** What the ownership check reads from a path (an `fs.Stats` fits). */
export interface GhPathStat {
  uid: number;
  mode: number;
  isFile(): boolean;
  isDirectory(): boolean;
}

export interface GhRunner {
  run(token: string, argv: readonly string[]): Promise<GhRunResult>;
}

export interface GhRunnerOptions {
  /** Absolute path of the pinned gh (`/usr/local/libexec/soma-devops/gh` once installed). */
  ghPath: string;
  ctx: GhPolicyContext;
  timeoutMs?: number;
  /** Cap per stream, in bytes. */
  maxOutputBytes?: number;
  /** Resident-memory ceiling for gh, in bytes. */
  maxRssBytes?: number;
  /** How often gh's resident memory is sampled. */
  memoryPollMs?: number;
  /** Prints gh's resident set size in KiB (`ps -o rss=` output); a rejection is a failed sample. Tests only. */
  rssProbe?: (pid: number) => Promise<string>;
  tmpRoot?: string;
  /**
   * Refuse a gh that is not root-owned, or whose directory chain up to `/` is not root-owned, is
   * group/other-writable, or has a sticky bit. Off only in tests.
   */
  requireRootOwnedGh?: boolean;
  /** Stats one path without following a symlink (default `fs.lstatSync`). Tests only. */
  statPath?: (file: string) => GhPathStat;
}

/** Defaults. The timeout stays well under the MCP server's 330 s wait for a whole call. */
export const GH_RUN_DEFAULTS = Object.freeze({
  timeoutMs: 60_000,
  maxOutputBytes: 1024 * 1024,
  // An allowed `--jq` can still build a huge value; the read classification does not bound memory.
  maxRssBytes: 1024 ** 3,
  memoryPollMs: 500,
});

/** After gh exits, how long its pipes may stay open (held by a process outside its group) before they are cut. */
const PIPE_GRACE_MS = 1_000;

/** Bad memory samples in a row (probe failed or printed something unparsable) that kill gh. */
const WATCHDOG_MAX_BAD_SAMPLES = 3;

/** argv the allowlist refuses — thrown before anything is spawned or created on disk. */
export class GhRunDeniedError extends Error {
  readonly code: GhDenyCode;
  readonly reason: string;

  constructor(code: GhDenyCode, reason: string) {
    super(`gh-runner: argv denied (${code}): ${reason}`);
    this.name = 'GhRunDeniedError';
    this.code = code;
    this.reason = reason;
  }
}

/** Non-empty, no whitespace, no control characters (an env value cannot carry NUL anyway). */
function isUsableToken(token: unknown): token is string {
  if (typeof token !== 'string' || token.length === 0 || /\s/.test(token)) return false;
  for (let i = 0; i < token.length; i++) {
    const c = token.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return false;
  }
  return true;
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`gh-runner: ${name} must be a positive integer`);
  return value;
}

/** The real gh path followed by every directory above it, ending at the root. */
function trustChain(real: string): string[] {
  const chain = [real];
  for (let dir = path.dirname(real); ; dir = path.dirname(dir)) {
    chain.push(dir);
    if (path.dirname(dir) === dir) return chain;
  }
}

/**
 * Whoever can write to gh or to any directory above it can swap the binary the broker runs with a token in
 * its env. So: a regular file and plain directories (lstat: no symlinks), root-owned, not group/other-writable,
 * and no sticky bit (a sticky directory is a shared one).
 */
function assertTrustedChain(chain: readonly string[], statPath: (file: string) => GhPathStat): void {
  chain.forEach((file, i) => {
    const st = statPath(file);
    const kind = i === 0 ? 'file' : 'directory';
    if (!(i === 0 ? st.isFile() : st.isDirectory())) throw new Error(`gh-runner: ${file} is not a ${kind}`);
    if (st.uid !== 0) throw new Error(`gh-runner: ${file} must be owned by root (uid ${st.uid})`);
    if ((st.mode & 0o022) !== 0) {
      throw new Error(
        `gh-runner: ${file} must not be group- or other-writable (mode ${(st.mode & 0o7777).toString(8)})`,
      );
    }
    if (i > 0 && (st.mode & 0o1000) !== 0) {
      throw new Error(`gh-runner: ${file} must not have the sticky bit (mode ${(st.mode & 0o7777).toString(8)})`);
    }
  });
}

/** Absolute path check, then the real path and its trust chain (null when the ownership check is off). */
function resolveGh(ghPath: string, requireRootOwned: boolean): { gh: string; chain: string[] | null } {
  if (typeof ghPath !== 'string' || !path.isAbsolute(ghPath)) {
    throw new Error(`gh-runner: ghPath must be an absolute path, got ${JSON.stringify(ghPath)}`);
  }
  if (!requireRootOwned) return { gh: ghPath, chain: null };
  // Execute the vetted real path, so a symlink in the configured path cannot be repointed later.
  const real = fs.realpathSync(ghPath);
  return { gh: real, chain: trustChain(real) };
}

/** Bytes kept from one stream: the first `cap`, the rest read and dropped so the child never blocks. */
class CappedBuffer {
  private readonly chunks: Buffer[] = [];
  private kept = 0;
  truncated = false;

  constructor(private readonly cap: number) {}

  push(chunk: Buffer): void {
    const room = this.cap - this.kept;
    if (chunk.length <= room) {
      this.chunks.push(chunk);
      this.kept += chunk.length;
      return;
    }
    this.truncated = true;
    if (room > 0) {
      this.chunks.push(Buffer.from(chunk.subarray(0, room)));
      this.kept = this.cap;
    }
  }

  /** UTF-8 text; a cut that split a character drops the partial character instead of emitting U+FFFD. */
  text(): string {
    let bytes = Buffer.concat(this.chunks);
    if (this.truncated) bytes = bytes.subarray(0, utf8Boundary(bytes));
    return bytes.toString('utf8');
  }
}

/** Length of the longest prefix of `bytes` that does not end inside a multi-byte UTF-8 sequence. */
function utf8Boundary(bytes: Buffer): number {
  let i = bytes.length;
  let continuation = 0;
  while (i > 0 && continuation < 3 && (bytes[i - 1] & 0xc0) === 0x80) {
    i--;
    continuation++;
  }
  if (i === 0) return bytes.length;
  const lead = bytes[i - 1];
  const need = lead >= 0xf0 ? 3 : lead >= 0xe0 ? 2 : lead >= 0xc0 ? 1 : 0;
  return need > continuation ? i - 1 : bytes.length;
}

interface RunDirs {
  base: string;
  cwd: string;
  home: string;
  config: string;
}

function childEnv(token: string, dirs: RunDirs): NodeJS.ProcessEnv {
  return {
    GH_TOKEN: token,
    HOME: dirs.home,
    GH_CONFIG_DIR: dirs.config,
    XDG_CONFIG_HOME: dirs.config,
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
    // gh v2.102.0 defaults telemetry on (internal/config/config.go:791-793) and flushes it through a detached
    // `gh send-telemetry` child in its own process group (internal/telemetry/telemetry.go:452,467) that would
    // inherit GH_TOKEN and outlive the timeout. GH_TELEMETRY wins over everything (telemetry.go:108);
    // DO_NOT_TRACK is the next check (telemetry.go:126).
    GH_TELEMETRY: 'disabled',
    DO_NOT_TRACK: '1',
    // Some allowed subcommands shell out to git even with -R: no repository above the empty cwd, no system or
    // global git config, no credential prompt.
    GIT_CEILING_DIRECTORIES: dirs.base,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    NO_COLOR: '1',
    GH_PAGER: 'cat',
    PAGER: 'cat',
    PATH: '/usr/bin:/bin',
    LANG: 'C.UTF-8',
  };
}

/**
 * SIGKILL gh's process group (gh is its leader). This reaches gh and every descendant still in that group; a
 * descendant that moved to its own session or group (setsid / setpgid) is out of reach — it only loses its
 * pipes when they are cut after the grace period.
 */
function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // ESRCH: the group is already empty.
  }
}

/** `ps -o rss= -p <pid>`: resident set size in KiB. Rejects when ps fails. */
function psRss(pid: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      '/bin/ps',
      ['-o', 'rss=', '-p', String(pid)],
      { env: { PATH: '/usr/bin:/bin', LANG: 'C' }, timeout: 5_000 },
      (error, stdout) => (error ? reject(error) : resolve(String(stdout))),
    );
  });
}

/** Resident set size in bytes, or null for a failed or unparsable sample. */
async function sampleRssBytes(probe: (pid: number) => Promise<string>, pid: number): Promise<number | null> {
  try {
    const match = /^\s*(\d+)\s*$/.exec(await probe(pid));
    return match ? Number(match[1]) * 1024 : null;
  } catch {
    return null;
  }
}

export function createGhRunner(opts: GhRunnerOptions): GhRunner {
  const { ctx, tmpRoot = os.tmpdir(), requireRootOwnedGh = true, rssProbe = psRss } = opts;
  const statPath = opts.statPath ?? ((file: string): GhPathStat => fs.lstatSync(file));
  const { gh, chain } = resolveGh(opts.ghPath, requireRootOwnedGh);
  if (chain) assertTrustedChain(chain, statPath);
  const timeoutMs = positiveInteger('timeoutMs', opts.timeoutMs ?? GH_RUN_DEFAULTS.timeoutMs);
  const maxOutputBytes = positiveInteger('maxOutputBytes', opts.maxOutputBytes ?? GH_RUN_DEFAULTS.maxOutputBytes);
  const maxRssBytes = positiveInteger('maxRssBytes', opts.maxRssBytes ?? GH_RUN_DEFAULTS.maxRssBytes);
  const memoryPollMs = positiveInteger('memoryPollMs', opts.memoryPollMs ?? GH_RUN_DEFAULTS.memoryPollMs);

  async function run(token: string, argv: readonly string[]): Promise<GhRunResult> {
    if (!isUsableToken(token)) {
      throw new Error('gh-runner: token must be a non-empty string without whitespace or control characters');
    }
    if (!Array.isArray(argv) || argv.some((arg) => typeof arg !== 'string')) {
      throw new Error('gh-runner: argv must be an array of strings');
    }
    // Defense in depth: the broker classified this argv already; re-check right before execution.
    // A classifier that throws is a denial, never a pass.
    let verdict: ReturnType<typeof classifyGh>;
    try {
      verdict = classifyGh(argv, ctx);
    } catch (error) {
      throw new GhRunDeniedError('internal-error', `classifier failed: ${(error as Error)?.message ?? String(error)}`);
    }
    if (verdict.kind === 'deny') throw new GhRunDeniedError(verdict.code, verdict.reason);
    // Stat calls only: a layout change since creation (a writable or re-owned directory) fails closed.
    if (chain) assertTrustedChain(chain, statPath);

    const base = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(tmpRoot, 'soma-gh-')));
    try {
      const dirs: RunDirs = {
        base,
        cwd: path.join(base, 'cwd'),
        home: path.join(base, 'home'),
        config: path.join(base, 'config'),
      };
      for (const dir of [dirs.cwd, dirs.home, dirs.config]) await fs.promises.mkdir(dir, { mode: 0o700 });
      return await spawnGh([...argv], token, dirs);
    } finally {
      await fs.promises.rm(base, { recursive: true, force: true });
    }
  }

  function spawnGh(argv: string[], token: string, dirs: RunDirs): Promise<GhRunResult> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const out = new CappedBuffer(maxOutputBytes);
      const err = new CappedBuffer(maxOutputBytes);
      let timedOut = false;
      let killedForMemory = false;
      let watchdogFailed = false;
      let badSamples = 0;
      let exited = false;
      let settled = false;
      let watchdog: NodeJS.Timeout | undefined;
      let pipeGrace: NodeJS.Timeout | undefined;

      // detached = gh leads its own process group, so a timeout or exit can kill gh and the descendants that
      // stayed in that group (see killGroup for the ones that leave it).
      const child = spawn(gh, argv, {
        shell: false,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: dirs.cwd,
        env: childEnv(token, dirs),
      });

      const timer = setTimeout(() => {
        if (exited || killedForMemory || watchdogFailed) return;
        timedOut = true;
        killGroup(child);
      }, timeoutMs);

      // A best-effort ceiling by polling, not an OS-enforced limit: gh can overshoot between samples. A probe
      // that keeps failing or printing garbage is treated as over the limit — the ceiling must not quietly lapse.
      const sampleMemory = () => {
        watchdog = setTimeout(async () => {
          if (exited || child.pid === undefined) return;
          const rss = await sampleRssBytes(rssProbe, child.pid);
          if (exited || timedOut) return;
          if (rss === null) {
            badSamples++;
            if (badSamples >= WATCHDOG_MAX_BAD_SAMPLES) {
              watchdogFailed = true;
              killGroup(child);
              return;
            }
          } else {
            badSamples = 0;
            if (rss > maxRssBytes) {
              killedForMemory = true;
              killGroup(child);
              return;
            }
          }
          sampleMemory();
        }, memoryPollMs);
      };
      sampleMemory();

      child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
      child.on('error', (error: NodeJS.ErrnoException) => {
        // Only a failed spawn rejects; a running gh always ends through 'close'.
        if (settled || child.pid !== undefined) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(watchdog);
        reject(new Error(`gh-runner: failed to run gh (${error.code ?? 'unknown error'})`));
      });
      child.on('exit', () => {
        exited = true;
        clearTimeout(timer);
        clearTimeout(watchdog);
        // Descendants gh left running in its own process group die with it.
        killGroup(child);
        // A process outside the group (its own session) could still hold the pipes; stop waiting on it.
        pipeGrace = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
        }, PIPE_GRACE_MS);
      });
      child.on('close', (exitCode, signal) => {
        clearTimeout(timer);
        clearTimeout(watchdog);
        clearTimeout(pipeGrace);
        if (settled) return;
        settled = true;
        const secrets = [token];
        resolve({
          exitCode,
          signal,
          stdout: (out.truncated ? scrubTruncated : scrub)(out.text(), secrets),
          stderr: (err.truncated ? scrubTruncated : scrub)(err.text(), secrets),
          truncated: out.truncated || err.truncated,
          timedOut,
          killedForMemory,
          watchdogFailed,
          durationMs: Date.now() - started,
        });
      });
    });
  }

  return { run };
}
