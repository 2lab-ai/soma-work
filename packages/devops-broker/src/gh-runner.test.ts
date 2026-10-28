import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { classifyGh, type GhPolicyContext } from '@soma/process-shared/devops/gh-policy.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGhRunner, GH_RUN_DEFAULTS, type GhPathStat, GhRunDeniedError, type GhRunResult } from './gh-runner.js';

// The broker's gh execution (.prd/16-devops-tools-architecture.md §7) against a fake gh
// (`__fixtures__/fake-gh.cjs`). loop.md WU3 RED: a fake gh that prints the env token still yields `<redacted>`;
// the stored account directory and HOME are never read.

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
const spawnSpy = vi.mocked(childProcess.spawn);
vi.mock('@soma/process-shared/devops/gh-policy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@soma/process-shared/devops/gh-policy.js')>();
  return { ...actual, classifyGh: vi.fn(actual.classifyGh) };
});
const classifySpy = vi.mocked(classifyGh);

const FIXTURE = path.join(__dirname, '__fixtures__', 'fake-gh.cjs');
const ctx: GhPolicyContext = { allowedOwners: ['example-org'] };
const argvFor = (mode: string) => ['pr', 'list', '-R', `example-org/${mode}`];

// Assembled at load time — a complete token literal in a blob reads as a leak to push protection.
const TOKEN = ['ghp', '_', 'Wq3RtY7uIo9PaS1dFg5HjK2lZx4CvB6nM8eQ'].join('');
/** Non-whitespace token whose base64 and percent-encodings differ from itself. */
const ODD_TOKEN = 'S3cr3t???~tok/with+eq=amp&end>>>';
const CUT = 64 * 1024;

const ALLOWED_ENV_KEYS = [
  'DO_NOT_TRACK',
  'GH_CONFIG_DIR',
  'GH_NO_EXTENSION_UPDATE_NOTIFIER',
  'GH_NO_UPDATE_NOTIFIER',
  'GH_PAGER',
  'GH_PROMPT_DISABLED',
  'GH_TELEMETRY',
  'GH_TOKEN',
  'GIT_CEILING_DIRECTORIES',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_TERMINAL_PROMPT',
  'HOME',
  'LANG',
  'NO_COLOR',
  'PAGER',
  'PATH',
  'XDG_CONFIG_HOME',
];

interface EnvReport {
  env: Record<string, string>;
  cwd: string;
  cwdEntries: string[] | string;
  homeEntries: string[] | string;
  configEntries: string[] | string;
  hostsReads: Array<{ file: string; content?: string; error?: string }>;
}

let work: string;
let tmpRoot: string;
let ghPath: string;
let marker: string;

/** Copy the fixture with an absolute interpreter: the child's PATH (/usr/bin:/bin) has no node on it. */
function installFakeGh(dir: string): string {
  if (/\s/.test(process.execPath)) throw new Error(`node path has whitespace: ${process.execPath}`);
  const body = fs.readFileSync(FIXTURE, 'utf8').replace(/^#!.*\n/, '');
  const target = path.join(dir, 'gh');
  fs.writeFileSync(target, `#!${process.execPath}\n${body}`, { mode: 0o755 });
  return target;
}

function make(opts: { timeoutMs?: number; maxOutputBytes?: number } = {}) {
  return createGhRunner({ ghPath, ctx, tmpRoot, requireRootOwnedGh: false, ...opts });
}

function invocations(): string[] {
  return fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n') : [];
}

/** `os.tmpdir()` may sit behind a symlink (macOS /var -> /private/var); the child's cwd is the real path. */
function canon(p: string): string {
  return p.startsWith(`${tmpRoot}${path.sep}`) ? fs.realpathSync(tmpRoot) + p.slice(tmpRoot.length) : p;
}

function underTmpRoot(p: string): boolean {
  return canon(p).startsWith(`${fs.realpathSync(tmpRoot)}${path.sep}`);
}

async function envReport(): Promise<{ result: GhRunResult; report: EnvReport }> {
  const result = await make().run(TOKEN, argvFor('env'));
  expect(result.exitCode, result.stderr).toBe(0);
  return { result, report: JSON.parse(result.stdout) as EnvReport };
}

/** Wait until `pid` is gone (a SIGKILLed orphan is a zombie until init reaps it). */
async function gone(pid: number, withinMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

function pidFrom(stdout: string, key: string): number {
  const match = new RegExp(`${key}=(\\d+)`).exec(stdout);
  if (!match) throw new Error(`no ${key}= in ${JSON.stringify(stdout)}`);
  return Number(match[1]);
}

beforeEach(() => {
  spawnSpy.mockClear();
  classifySpy.mockClear();
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-runner-test-'));
  tmpRoot = path.join(work, 'tmp');
  fs.mkdirSync(tmpRoot);
  const bin = path.join(work, 'bin');
  fs.mkdirSync(bin);
  ghPath = installFakeGh(bin);
  marker = path.join(bin, 'invocations.log');
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(work, { recursive: true, force: true });
});

describe('fixture argv shapes', () => {
  it.each([
    'env',
    'token-raw',
    'token-encoded',
    'stderr-exit',
    'sleep',
    'flood',
    'token-at-cut',
    'utf8-at-cut',
    'grandchild-exit',
    'grandchild-timeout',
    'setsid-holder',
    'nap',
    'balloon',
  ])('classifyGh accepts the %s mode argv as a read', (mode) => {
    expect(classifyGh(argvFor(mode), ctx).kind).toBe('read');
  });
});

describe('createGhRunner — gh binary checks', () => {
  it('rejects a relative gh path', () => {
    expect(() => createGhRunner({ ghPath: 'gh', ctx, requireRootOwnedGh: false })).toThrow(/absolute/);
  });

  it.skipIf(process.getuid?.() === 0)('rejects a gh binary not owned by root by default', () => {
    expect(() => createGhRunner({ ghPath, ctx })).toThrow(/root/);
  });

  it('accepts a root-owned regular file in a root-owned directory', () => {
    expect(() => createGhRunner({ ghPath: '/bin/ls', ctx })).not.toThrow();
  });
});

/** A stat stand-in: everything on the chain is root-owned 0755 unless `overrides` says otherwise. */
function fakeStat(overrides: Map<string, Partial<{ uid: number; mode: number; kind: 'file' | 'dir' | 'link' }>>) {
  const seen: string[] = [];
  const stat = (p: string): GhPathStat => {
    seen.push(p);
    const o = overrides.get(p) ?? {};
    const kind = o.kind ?? (p === realGh() ? 'file' : 'dir');
    return {
      uid: o.uid ?? 0,
      mode: o.mode ?? 0o755,
      isFile: () => kind === 'file',
      isDirectory: () => kind === 'dir',
    };
  };
  return { stat, seen };
}

function realGh(): string {
  return fs.realpathSync(ghPath);
}

function ancestors(file: string): string[] {
  const out: string[] = [];
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    out.push(dir);
    if (path.dirname(dir) === dir) return out;
  }
}

describe('createGhRunner — trusted ancestor chain', () => {
  const rooted = (stat: (p: string) => GhPathStat) => createGhRunner({ ghPath, ctx, tmpRoot, statPath: stat });

  it('stats the real gh and every directory up to /', async () => {
    const { stat, seen } = fakeStat(new Map());
    const runner = rooted(stat);
    expect(seen).toEqual([realGh(), ...ancestors(realGh())]);
    expect(seen.at(-1)).toBe(path.parse(realGh()).root);
    const result = await runner.run(TOKEN, argvFor('token-raw'));
    expect(result.exitCode).toBe(0);
  });

  it.each([
    ['group-writable grandparent', { mode: 0o775 }, /group- or other-writable/],
    ['other-writable grandparent', { mode: 0o757 }, /group- or other-writable/],
    ['grandparent owned by a user', { uid: 501 }, /owned by root/],
    ['sticky-bit grandparent', { mode: 0o1755 }, /sticky/],
    ['grandparent is a symlink', { kind: 'link' as const }, /not a directory/],
  ])('rejects a %s at creation', (_name, override, message) => {
    const grandparent = path.dirname(path.dirname(realGh()));
    const { stat } = fakeStat(new Map([[grandparent, override]]));
    expect(() => rooted(stat)).toThrow(message);
  });

  it('rejects a writable / and a gh that is not a regular file', () => {
    expect(() => rooted(fakeStat(new Map([[path.parse(realGh()).root, { mode: 0o777 }]])).stat)).toThrow(/writable/);
    expect(() => rooted(fakeStat(new Map([[realGh(), { kind: 'link' }]])).stat)).toThrow(/not a file/);
    expect(() => rooted(fakeStat(new Map([[realGh(), { mode: 0o775 }]])).stat)).toThrow(/writable/);
  });

  it('re-checks the chain before every spawn and refuses after a layout change', async () => {
    const overrides = new Map<string, { mode: number }>();
    const { stat } = fakeStat(overrides);
    const runner = rooted(stat);
    expect((await runner.run(TOKEN, argvFor('token-raw'))).exitCode).toBe(0);
    expect(invocations()).toHaveLength(1);
    spawnSpy.mockClear();

    overrides.set(path.dirname(path.dirname(realGh())), { mode: 0o777 });
    await expect(runner.run(TOKEN, argvFor('token-raw'))).rejects.toThrow(/group- or other-writable/);
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(invocations()).toHaveLength(1);
    expect(fs.readdirSync(tmpRoot)).toEqual([]);
  });
});

describe('run — refuses before spawning', () => {
  it.each([
    [['auth', 'token']],
    [['auth', 'switch', '--user', 'alice']],
    [['api', '-X', 'DELETE', 'repos/example-org/app']],
    [['pr', 'list']],
    [['pr', 'list', '-R', 'other-org/app']],
    [['gh', 'pr', 'list', '-R', 'example-org/app']],
  ])('denies %j without executing gh', async (argv) => {
    const run = make().run(TOKEN, argv);
    await expect(run).rejects.toBeInstanceOf(GhRunDeniedError);
    await expect(run).rejects.toThrow(/denied/);
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(invocations()).toEqual([]);
    expect(fs.readdirSync(tmpRoot)).toEqual([]);
  });

  it('treats a classifier that throws as a denial', async () => {
    classifySpy.mockImplementationOnce(() => {
      throw new Error('classifier bug');
    });
    const run = make().run(TOKEN, argvFor('env'));
    await expect(run).rejects.toBeInstanceOf(GhRunDeniedError);
    await expect(run).rejects.toMatchObject({ code: 'internal-error' });
    await expect(run).rejects.toThrow(/classifier bug/);
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(invocations()).toEqual([]);
    expect(fs.readdirSync(tmpRoot)).toEqual([]);
  });

  it.each([
    '',
    ' ',
    'a b',
    'a\nb',
    'a\tb',
    'a\u0000b',
    `${TOKEN}\n`,
  ])('rejects token %j without executing gh', async (token) => {
    await expect(make().run(token, argvFor('env'))).rejects.toThrow(/token/);
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(invocations()).toEqual([]);
    expect(fs.readdirSync(tmpRoot)).toEqual([]);
  });
});

describe('run — child environment', () => {
  it('spawns gh directly with exactly the allowlisted env, no shell, stdin closed, a fresh cwd', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'parent-github-token-value');
    await make().run(TOKEN, argvFor('env'));
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const [file, args, options] = spawnSpy.mock.calls[0] as unknown as [string, string[], childProcess.SpawnOptions];
    expect(file).toBe(ghPath);
    expect(args).toEqual(argvFor('env'));
    expect(options.shell).toBe(false);
    expect(options.detached).toBe(true);
    expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    expect(Object.keys(options.env ?? {}).sort()).toEqual(ALLOWED_ENV_KEYS);
    expect(options.env?.GH_TOKEN).toBe(TOKEN);
    expect(underTmpRoot(String(options.cwd))).toBe(true);
  });

  it('passes exactly the allowlisted env, even when the parent carries gh credentials', async () => {
    const operatorHome = path.join(work, 'operator-home');
    vi.stubEnv('HOME', operatorHome);
    vi.stubEnv('GITHUB_TOKEN', 'parent-github-token-value');
    vi.stubEnv('GH_TOKEN', 'parent-gh-token-value');
    vi.stubEnv('GH_ENTERPRISE_TOKEN', 'parent-enterprise-token-value');
    vi.stubEnv('GH_HOST', 'git.example.com');
    vi.stubEnv('GH_CONFIG_DIR', path.join(operatorHome, '.config', 'gh'));
    vi.stubEnv('XDG_CONFIG_HOME', path.join(operatorHome, '.config'));

    const { result, report } = await envReport();
    const env = report.env;

    // macOS CoreFoundation adds __CF_USER_TEXT_ENCODING inside the (node) child at startup; it is not passed
    // in — spawning /usr/bin/env with the same env shows only the passed keys.
    const seen = Object.keys(env).filter((k) => !(process.platform === 'darwin' && k === '__CF_USER_TEXT_ENCODING'));
    expect(seen.sort()).toEqual(ALLOWED_ENV_KEYS);
    expect(env.GH_TOKEN).toBe('<redacted>');
    expect(env).toMatchObject({
      GH_PROMPT_DISABLED: '1',
      GH_NO_UPDATE_NOTIFIER: '1',
      GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
      NO_COLOR: '1',
      GH_PAGER: 'cat',
      PAGER: 'cat',
      PATH: '/usr/bin:/bin',
      LANG: 'C.UTF-8',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GH_TELEMETRY: 'disabled',
      DO_NOT_TRACK: '1',
    });
    expect(env.XDG_CONFIG_HOME).toBe(env.GH_CONFIG_DIR);
    expect(canon(env.GIT_CEILING_DIRECTORIES)).toBe(path.dirname(canon(report.cwd)));
    expect(underTmpRoot(env.HOME)).toBe(true);
    expect(underTmpRoot(env.GH_CONFIG_DIR)).toBe(true);
    expect(underTmpRoot(report.cwd)).toBe(true);
    expect(new Set([canon(env.HOME), canon(env.GH_CONFIG_DIR), canon(report.cwd)]).size).toBe(3);
    for (const leaked of ['parent-github-token-value', 'parent-gh-token-value', 'parent-enterprise-token-value']) {
      expect(result.stdout).not.toContain(leaked);
    }
    expect(result.stdout).not.toContain(operatorHome);
    expect(result.stdout).not.toContain('git.example.com');
  });

  it('runs in empty cwd, HOME and config dirs and removes them afterwards', async () => {
    const { report } = await envReport();
    expect(report.cwdEntries).toEqual([]);
    expect(report.homeEntries).toEqual([]);
    expect(report.configEntries).toEqual([]);
    expect(fs.existsSync(report.cwd)).toBe(false);
    expect(fs.existsSync(report.env.HOME)).toBe(false);
    expect(fs.existsSync(report.env.GH_CONFIG_DIR)).toBe(false);
    expect(fs.readdirSync(tmpRoot)).toEqual([]);
  });

  it("never reads the operator's stored gh account", async () => {
    const operatorHome = path.join(work, 'operator-home');
    const stored = path.join(operatorHome, '.config', 'gh');
    fs.mkdirSync(stored, { recursive: true });
    const planted = ['gho', '_', 'Pl4nt3dStoredAccountTokenValue0000x'].join('');
    fs.writeFileSync(path.join(stored, 'hosts.yml'), `github.com:\n  oauth_token: ${planted}\n  user: alice\n`);
    vi.stubEnv('HOME', operatorHome);
    vi.stubEnv('GH_CONFIG_DIR', stored);

    const { result, report } = await envReport();
    expect(report.hostsReads).toHaveLength(3);
    for (const read of report.hostsReads) {
      expect(read.error, read.file).toBe('ENOENT');
      expect(underTmpRoot(read.file), read.file).toBe(true);
    }
    expect(result.stdout).not.toContain(planted.slice(4));
    expect(result.stdout).not.toContain('alice');
  });

  it('gives concurrent runs separate directories', async () => {
    const [a, b] = await Promise.all([envReport(), envReport()]);
    expect(a.report.env.HOME).not.toBe(b.report.env.HOME);
    expect(a.report.cwd).not.toBe(b.report.cwd);
    expect(fs.readdirSync(tmpRoot)).toEqual([]);
  });
});

describe('run — spawn failure', () => {
  it('rejects when gh cannot be executed and still removes its directories', async () => {
    fs.chmodSync(ghPath, 0o644);
    await expect(make().run(TOKEN, argvFor('env'))).rejects.toThrow(/failed to run gh \(EACCES\)/);
    expect(fs.readdirSync(tmpRoot)).toEqual([]);
  });
});

describe('run — output scrubbing', () => {
  it('redacts the token printed raw on stdout and stderr', async () => {
    const result = await make().run(TOKEN, argvFor('token-raw'));
    expect(result.stdout).toBe('token=<redacted>\nagain:<redacted><redacted>\n');
    expect(result.stderr).toBe('debug: GH_TOKEN=<redacted>\n');
    expect(`${result.stdout}${result.stderr}`).not.toContain(TOKEN.slice(4));
    expect(result).toMatchObject({
      exitCode: 0,
      signal: null,
      truncated: false,
      timedOut: false,
      killedForMemory: false,
      watchdogFailed: false,
    });
  });

  it('redacts base64, base64url and percent-encoded forms of the token', async () => {
    const result = await make().run(ODD_TOKEN, argvFor('token-encoded'));
    const lines = Object.fromEntries(
      result.stdout
        .trim()
        .split('\n')
        .map((line) => line.split(/=(.*)/s).slice(0, 2) as [string, string]),
    );
    expect(Object.keys(lines)).toEqual([
      'b64-0',
      'b64-1',
      'b64-2',
      'b64url-0',
      'b64url-1',
      'b64url-2',
      'pct',
      'pct-lower',
    ]);
    for (const key of ['b64-0', 'b64-1', 'b64-2']) {
      expect(lines[key], key).toMatch(/^[A-Za-z0-9+/]{0,3}<redacted>[A-Za-z0-9+/=]{0,3}$/);
    }
    for (const key of ['b64url-0', 'b64url-1', 'b64url-2']) {
      expect(lines[key], key).toMatch(/^[A-Za-z0-9_-]{0,3}<redacted>[A-Za-z0-9_-]{0,3}$/);
    }
    expect(lines.pct).toBe('<redacted>');
    expect(lines['pct-lower']).toBe('<redacted>');
  });

  it('reports a non-zero exit with stderr, scrubbed', async () => {
    const result = await make().run(TOKEN, argvFor('stderr-exit'));
    expect(result).toMatchObject({ exitCode: 3, signal: null, stdout: 'partial result\n', timedOut: false });
    expect(result.stderr).toBe('HTTP 401: Bad credentials (token <redacted>)\n');
  });
});

describe('run — limits', () => {
  it('defaults: 60 s timeout (well under the MCP wait of 330 s), 1 MiB per stream, 1 GiB RSS', async () => {
    expect(GH_RUN_DEFAULTS).toMatchObject({ timeoutMs: 60_000, maxOutputBytes: 1024 * 1024, maxRssBytes: 1024 ** 3 });
    expect(GH_RUN_DEFAULTS.timeoutMs).toBeLessThanOrEqual(330_000 / 5);
    const timers = vi.spyOn(globalThis, 'setTimeout');
    try {
      await make().run(TOKEN, argvFor('token-raw'));
      expect(timers.mock.calls.some((call) => call[1] === 60_000)).toBe(true);
    } finally {
      timers.mockRestore();
    }
  });

  it('kills gh at the timeout and reports it', { timeout: 20_000 }, async () => {
    const result = await make({ timeoutMs: 300 }).run(TOKEN, argvFor('sleep'));
    expect(result).toMatchObject({ exitCode: null, signal: 'SIGKILL', timedOut: true });
    expect(result.durationMs).toBeGreaterThanOrEqual(290);
    expect(result.durationMs).toBeLessThan(10_000);
    expect(fs.readdirSync(tmpRoot)).toEqual([]);
  });

  it('kills the whole process group at the timeout', { timeout: 20_000 }, async () => {
    const result = await make({ timeoutMs: 3_000 }).run(TOKEN, argvFor('grandchild-timeout'));
    expect(result).toMatchObject({ timedOut: true, signal: 'SIGKILL' });
    expect(await gone(pidFrom(result.stdout, 'grandchild'))).toBe(true);
  });

  it('kills a grandchild left behind when gh exits, and does not wait on its pipes', { timeout: 20_000 }, async () => {
    const result = await make({ timeoutMs: 10_000 }).run(TOKEN, argvFor('grandchild-exit'));
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(result.durationMs).toBeLessThan(5_000);
    expect(await gone(pidFrom(result.stdout, 'grandchild'))).toBe(true);
  });

  it('settles when a process outside the group holds the pipes after gh exits', { timeout: 20_000 }, async () => {
    const result = await make({ timeoutMs: 10_000 }).run(TOKEN, argvFor('setsid-holder'));
    const holder = pidFrom(result.stdout, 'holder');
    try {
      expect(result).toMatchObject({ exitCode: 0, timedOut: false });
      expect(result.durationMs).toBeLessThan(5_000);
      // Out of reach by design: a descendant in its own session is not in gh's process group. It only loses
      // its pipes; it is not killed.
      expect(() => process.kill(holder, 0)).not.toThrow();
    } finally {
      try {
        process.kill(holder, 'SIGKILL');
      } catch {}
    }
  });

  it('kills gh above maxRssBytes and reports it', { timeout: 20_000 }, async () => {
    const result = await createGhRunner({
      ghPath,
      ctx,
      tmpRoot,
      requireRootOwnedGh: false,
      timeoutMs: 15_000,
      maxRssBytes: 256 * 1024 * 1024,
      memoryPollMs: 100,
    }).run(TOKEN, argvFor('balloon'));
    expect(result).toMatchObject({
      killedForMemory: true,
      watchdogFailed: false,
      timedOut: false,
      signal: 'SIGKILL',
      exitCode: null,
    });
    expect(result.durationMs).toBeLessThan(10_000);
    expect(fs.readdirSync(tmpRoot)).toEqual([]);
  });

  it('caps each stream at 1 MiB, keeps draining, and marks the result truncated', { timeout: 30_000 }, async () => {
    const result = await make().run(TOKEN, argvFor('flood'));
    const cap = 1024 * 1024;
    expect(result).toMatchObject({ exitCode: 0, signal: null, truncated: true, timedOut: false });
    expect(Buffer.byteLength(result.stdout)).toBe(cap);
    expect(Buffer.byteLength(result.stderr)).toBe(cap);
  });

  it('redacts a token cut in half by the cap', async () => {
    const result = await make({ maxOutputBytes: CUT }).run(TOKEN, argvFor('token-at-cut'));
    expect(result.truncated).toBe(true);
    expect(result.stdout).not.toContain(TOKEN.slice(0, 12));
    expect(result.stdout.endsWith('<redacted>')).toBe(true);
    expect(result.stdout.slice(0, CUT - 12)).toBe('x'.repeat(CUT - 12));
  });

  it('cuts on a UTF-8 character boundary', async () => {
    const result = await make({ maxOutputBytes: CUT }).run(TOKEN, argvFor('utf8-at-cut'));
    expect(result.truncated).toBe(true);
    expect(result.stdout).toBe('x'.repeat(CUT - 1));
  });
});

describe('run — memory watchdog fails closed', () => {
  /** A probe that answers from `script` in order, repeating the last entry; `Error` entries reject. */
  function scriptedProbe(script: Array<string | Error>) {
    const pids: number[] = [];
    let i = 0;
    const probe = async (pid: number): Promise<string> => {
      pids.push(pid);
      const next = script[Math.min(i++, script.length - 1)];
      if (next instanceof Error) throw next;
      return next;
    };
    return { probe, pids, calls: () => i };
  }

  const watched = (rssProbe: (pid: number) => Promise<string>) =>
    createGhRunner({ ghPath, ctx, tmpRoot, requireRootOwnedGh: false, timeoutMs: 15_000, memoryPollMs: 50, rssProbe });

  it.each([
    ['the probe fails', [new Error('ps: not found')]],
    ['the probe prints garbage', ['garbage']],
    ['the probe prints nothing', ['']],
    ['the probe prints a negative or fractional value', ['-5', '12.5', ' 1e9 ']],
  ])('kills gh after three bad samples in a row when %s', { timeout: 20_000 }, async (_name, script) => {
    const { probe, pids } = scriptedProbe(script as Array<string | Error>);
    const result = await watched(probe).run(TOKEN, argvFor('sleep'));
    expect(result).toMatchObject({
      watchdogFailed: true,
      killedForMemory: false,
      timedOut: false,
      signal: 'SIGKILL',
      exitCode: null,
    });
    expect(result.durationMs).toBeLessThan(10_000);
    expect(pids.length).toBe(3);
    expect(new Set(pids).size).toBe(1);
    expect(fs.readdirSync(tmpRoot)).toEqual([]);
  });

  it('does not kill gh when good samples break up the failures', { timeout: 20_000 }, async () => {
    const fail = new Error('ps failed');
    const pattern: Array<string | Error> = [fail, fail, '2048', fail, '  4096\n', 'garbage', 'junk', '1024'];
    const { probe, calls } = scriptedProbe([...pattern, ...pattern, ...pattern, ...pattern, '1024']);
    const result = await watched(probe).run(TOKEN, argvFor('nap'));
    expect(result).toMatchObject({ exitCode: 0, watchdogFailed: false, killedForMemory: false, stdout: 'rested\n' });
    expect(calls()).toBeGreaterThan(8);
  });

  it('still kills on an over-limit sample from an injected probe', { timeout: 20_000 }, async () => {
    const result = await createGhRunner({
      ghPath,
      ctx,
      tmpRoot,
      requireRootOwnedGh: false,
      memoryPollMs: 50,
      maxRssBytes: 1024 * 1024,
      rssProbe: async () => '2048',
    }).run(TOKEN, argvFor('sleep'));
    expect(result).toMatchObject({ killedForMemory: true, watchdogFailed: false, signal: 'SIGKILL' });
  });
});
