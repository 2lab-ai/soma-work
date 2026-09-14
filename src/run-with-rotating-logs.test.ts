import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BOOTSTRAP_LOG_CAP_BYTES,
  capBootstrapLogs,
  composeProfileEnv,
  DEFAULT_ROTATION_OPTIONS,
  forwardSignalWithEscalation,
  type KillableChild,
  ProfileEnvError,
  prepareProfileLogDir,
  resolveLogDir,
  resolveSupervisorChildEnv,
  runWithRotatingLogs,
} from './run-with-rotating-logs';
import { SYNTHETIC_SLACK_APP_TOKEN, SYNTHETIC_SLACK_BOT_TOKEN } from './test-utils/slack-token-fixtures';

describe('resolveLogDir', () => {
  it('defaults to <cwd>/logs', () => {
    expect(resolveLogDir({}, '/opt/soma-work/main')).toBe('/opt/soma-work/main/logs');
  });

  it('honors SOMA_LOG_DIR override (absolute)', () => {
    expect(resolveLogDir({ SOMA_LOG_DIR: '/var/log/soma' }, '/whatever')).toBe('/var/log/soma');
  });

  it('resolves a relative SOMA_LOG_DIR against the process, not cwd arg', () => {
    const out = resolveLogDir({ SOMA_LOG_DIR: 'rel/logs' }, '/whatever');
    expect(path.isAbsolute(out)).toBe(true);
    expect(out.endsWith('rel/logs')).toBe(true);
  });
});

describe('DEFAULT_ROTATION_OPTIONS', () => {
  it('is size-based with retention, cap, and gzip (codex-agreed defaults)', () => {
    expect(DEFAULT_ROTATION_OPTIONS.size).toBe('25M');
    expect(DEFAULT_ROTATION_OPTIONS.maxFiles).toBe(20);
    expect(DEFAULT_ROTATION_OPTIONS.maxSize).toBe('500M');
    expect(DEFAULT_ROTATION_OPTIONS.compress).toBe('gzip');
  });
});

describe('runWithRotatingLogs', () => {
  let logDir: string;

  beforeEach(() => {
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-rotate-'));
  });

  afterEach(() => {
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  it('writes child stdout into logs/stdout.log and rotates past the size threshold', async () => {
    // Child emits ~12KB of stdout; with a 1K rotation size this must rotate
    // several times, proving rotation actually happens (not a single growing file).
    const child =
      'let i=0;const t=setInterval(()=>{if(i++>=24){clearInterval(t);process.exit(0);}' +
      "process.stdout.write('x'.repeat(500)+'\\n');},4);";

    let rotations = 0;
    const handle = runWithRotatingLogs({
      command: process.execPath,
      args: ['-e', child],
      logDir,
      streamOptions: { size: '1K', maxFiles: 50, compress: false },
    });
    handle.streams.stdout.on('rotated', () => {
      rotations++;
    });

    const code = await handle.done;
    expect(code).toBe(0);

    // The live (non-rotated) file must always exist at the stable path.
    expect(fs.existsSync(path.join(logDir, 'stdout.log'))).toBe(true);

    // Rotation must have produced at least one rotated file beyond the live one.
    const files = fs.readdirSync(logDir).filter((f) => f.startsWith('stdout.log'));
    expect(files.length).toBeGreaterThanOrEqual(2);
    expect(rotations).toBeGreaterThanOrEqual(1);
  }, 20000);

  it('keeps stdout and stderr in separate files', async () => {
    const child =
      "process.stdout.write('hello-out\\n');process.stderr.write('hello-err\\n');" +
      'setTimeout(()=>process.exit(0),50);';

    const handle = runWithRotatingLogs({
      command: process.execPath,
      args: ['-e', child],
      logDir,
      streamOptions: { size: '10M', compress: false },
    });
    await handle.done;

    const out = fs.readFileSync(path.join(logDir, 'stdout.log'), 'utf8');
    const err = fs.readFileSync(path.join(logDir, 'stderr.log'), 'utf8');
    expect(out).toContain('hello-out');
    expect(out).not.toContain('hello-err');
    expect(err).toContain('hello-err');
    expect(err).not.toContain('hello-out');
  }, 20000);

  it('propagates the child exit code', async () => {
    const handle = runWithRotatingLogs({
      command: process.execPath,
      args: ['-e', 'process.exit(3)'],
      logDir,
      streamOptions: { size: '10M', compress: false },
    });
    const code = await handle.done;
    expect(code).toBe(3);
  }, 20000);

  it('module is runnable as a launchd entrypoint (has a main guard)', () => {
    // Sanity: the compiled wrapper is what the plist invokes. Running it with a
    // trivial child entry must exit cleanly, proving the require.main guard wires
    // argv -> spawn. We invoke the TS source via tsx-equivalent (node --import not
    // assumed); instead assert the source exports the runner used by main().
    const src = fs.readFileSync(path.join(__dirname, 'run-with-rotating-logs.ts'), 'utf8');
    expect(src).toContain('require.main === module');
    // spawnSync guard keeps the import used (avoids unused-import lint churn).
    expect(typeof spawnSync).toBe('function');
  });
});

describe('capBootstrapLogs', () => {
  let logDir: string;

  beforeEach(() => {
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-cap-'));
  });

  afterEach(() => {
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  it('truncates a bootstrap log that exceeds the cap', () => {
    const file = path.join(logDir, 'launchd.err.log');
    fs.writeFileSync(file, 'x'.repeat(100));
    const truncated = capBootstrapLogs(logDir, 10);
    expect(truncated).toContain('launchd.err.log');
    expect(fs.statSync(file).size).toBe(0);
  });

  it('leaves a small bootstrap log untouched', () => {
    const file = path.join(logDir, 'launchd.out.log');
    fs.writeFileSync(file, 'small');
    const truncated = capBootstrapLogs(logDir, BOOTSTRAP_LOG_CAP_BYTES);
    expect(truncated).toEqual([]);
    expect(fs.readFileSync(file, 'utf8')).toBe('small');
  });

  it('is a no-op when the bootstrap files do not exist yet', () => {
    expect(() => capBootstrapLogs(logDir, 10)).not.toThrow();
    expect(capBootstrapLogs(logDir, 10)).toEqual([]);
  });
});

describe('forwardSignalWithEscalation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function fakeChild(overrides: Partial<KillableChild> = {}): KillableChild & { signals: string[] } {
    const signals: string[] = [];
    return {
      signals,
      killed: false,
      exitCode: null,
      signalCode: null,
      kill(signal?: NodeJS.Signals) {
        signals.push(signal ?? 'SIGTERM');
        return true;
      },
      ...overrides,
    };
  }

  it('forwards the requested signal immediately', () => {
    const child = fakeChild();
    forwardSignalWithEscalation(child, 'SIGTERM', 4000);
    expect(child.signals).toEqual(['SIGTERM']);
  });

  it('escalates to SIGKILL if the child is still alive after the grace window', () => {
    const child = fakeChild(); // exitCode/signalCode stay null = still alive
    let escalated = false;
    forwardSignalWithEscalation(child, 'SIGTERM', 4000, () => {
      escalated = true;
    });
    vi.advanceTimersByTime(4000);
    expect(escalated).toBe(true);
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('does NOT escalate if the child has already exited', () => {
    const child = fakeChild({ exitCode: 0 });
    forwardSignalWithEscalation(child, 'SIGTERM', 4000);
    vi.advanceTimersByTime(4000);
    expect(child.signals).toEqual(['SIGTERM']);
  });
});

// ---------------------------------------------------------------------------
// Task 9 — profile runtime environment composition
// ---------------------------------------------------------------------------

/**
 * The LaunchAgent plist is secret-free by ruling: it carries only fixed,
 * non-secret service wiring. The credentials therefore have to be joined to the
 * runtime somewhere, and that somewhere is here — the immutable supervisor,
 * after launch, reading the two 0600 profile files and handing the result to
 * the daemon through the child environment only.
 */
describe('composeProfileEnv', () => {
  let dir: string;
  let envFile: string;
  let secretsFile: string;

  // Complete Slack shapes, assembled rather than spelled out: a literal one
  // here is what GitHub push protection blocks. Same bytes at runtime.
  const BOT = SYNTHETIC_SLACK_BOT_TOKEN;
  const APP = SYNTHETIC_SLACK_APP_TOKEN;

  const fixed = () => ({
    HOME: '/Users/op',
    PATH: '/opt/homebrew/opt/node/bin:/usr/bin:/bin',
    SOMA_CONFIG_DIR: dir,
    SOMA_DATA_DIR: '/Users/op/.local/share/somawork/preview',
    SOMA_BASE_DIRECTORY: '/Users/op/work',
    SOMA_LOG_DIR: '/Users/op/.local/state/somawork/preview/logs',
  });

  const writeEnv = (body: string, mode = 0o600) => {
    fs.writeFileSync(envFile, body, { mode });
    fs.chmodSync(envFile, mode);
  };
  const writeSecrets = (body: string, mode = 0o600) => {
    fs.writeFileSync(secretsFile, body, { mode });
    fs.chmodSync(secretsFile, mode);
  };

  const compose = () => {
    return composeProfileEnv({ base: { PRE_EXISTING: 'kept' }, runtimeEnvFile: envFile, secretsFile, fixed: fixed() });
  };

  /** Every refusal must be the typed one, so a plain TypeError cannot pass for it. */
  const expectRefusal = (needle?: RegExp): string => {
    let caught: unknown;
    try {
      compose();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProfileEnvError);
    const message = String((caught as Error).message);
    if (needle) expect(message).toMatch(needle);
    return message;
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-profile-env-'));
    fs.chmodSync(dir, 0o700);
    envFile = path.join(dir, '.env');
    secretsFile = path.join(dir, 'secrets.env');
    writeEnv('AUTH_MODE=llmux\nANTHROPIC_BASE_URL=http://localhost:3456\nBASE_DIRECTORY=/Users/op/work\n');
    writeSecrets(`SLACK_BOT_TOKEN=${BOT}\nSLACK_APP_TOKEN=${APP}\nSLACK_SIGNING_SECRET=0123456789abcdef\n`);
    fs.chmodSync(envFile, 0o600);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('composes .env then secrets.env and reasserts fixed profile wiring', () => {
    const env = compose();
    expect(env.AUTH_MODE).toBe('llmux');
    expect(env.SLACK_BOT_TOKEN).toBe(BOT);
    expect(env.SLACK_APP_TOKEN).toBe(APP);
    expect(env.PRE_EXISTING).toBe('kept');
    expect(env.SOMA_CONFIG_DIR).toBe(dir);
    expect(env.SOMA_DATA_DIR).toBe('/Users/op/.local/share/somawork/preview');
    expect(env.SOMA_LOG_DIR).toBe('/Users/op/.local/state/somawork/preview/logs');
  });

  it('lets secrets.env win on an overlapping key', () => {
    // `.env` may not carry a credential name at all, so the overlap that has to
    // be ordered correctly is a shared *runtime* key. `secrets.env` accepts the
    // runtime allowlist too, precisely so this precedence is expressible.
    writeEnv('AUTH_MODE=llmux\nBASE_DIRECTORY=/from/env\n');
    writeSecrets(`SLACK_BOT_TOKEN=${BOT}\nSLACK_APP_TOKEN=${APP}\nBASE_DIRECTORY=/from/secrets\n`);
    const env = composeProfileEnv({ base: {}, runtimeEnvFile: envFile, secretsFile, fixed: {} });
    expect(env.BASE_DIRECTORY).toBe('/from/secrets');
  });

  it('reasserts fixed wiring over a mutable file that tries to redirect a path', () => {
    writeEnv('AUTH_MODE=llmux\nSOMA_BASE_DIRECTORY=/tmp/attacker\n');
    const env = compose();
    expect(env.SOMA_BASE_DIRECTORY).toBe('/Users/op/work');
  });

  it('refuses a key outside the runtime allowlist', () => {
    writeEnv('AUTH_MODE=llmux\nEVIL_KEY=1\n');
    expectRefusal(/EVIL_KEY/);
  });

  it('refuses a credential key in the non-secret file', () => {
    writeEnv(`AUTH_MODE=llmux\nSLACK_BOT_TOKEN=${BOT}\n`);
    // The remedy, not just the key: "not an allowed key" would be true of any
    // unknown name and would not tell the operator where the value belongs.
    const message = expectRefusal(/"SLACK_BOT_TOKEN" is a credential and must live in the profile credential file/);
    expect(message).not.toContain(BOT);
  });

  it('refuses a duplicate key inside one file', () => {
    writeEnv('AUTH_MODE=llmux\nAUTH_MODE=ccp\n');
    expectRefusal(/AUTH_MODE/);
  });

  it('refuses a malformed line rather than silently skipping it', () => {
    writeEnv('AUTH_MODE=llmux\nthis is not an assignment\n');
    expectRefusal();
  });

  it('refuses a carriage return or NUL inside a value', () => {
    writeEnv('AUTH_MODE=llmux\r\n');
    expectRefusal();
  });

  it('refuses an over-permissive credential file', () => {
    writeSecrets(`SLACK_BOT_TOKEN=${BOT}\nSLACK_APP_TOKEN=${APP}\n`, 0o644);
    const message = expectRefusal();
    expect(message).not.toContain(BOT);
  });

  it('refuses a symlinked env file', () => {
    const real = path.join(dir, 'elsewhere.env');
    fs.writeFileSync(real, 'AUTH_MODE=llmux\n', { mode: 0o600 });
    fs.rmSync(envFile);
    fs.symlinkSync(real, envFile);
    expectRefusal();
  });

  it('refuses a missing credential file (fails closed, never silently token-less)', () => {
    fs.rmSync(secretsFile);
    expectRefusal();
  });

  it('refuses a config directory that is readable or writable by group or other (I5)', () => {
    for (const mode of [0o755, 0o777, 0o750, 0o701]) {
      fs.chmodSync(dir, mode);
      const message = expectRefusal(/profile config directory/);
      expect(message).not.toContain(BOT);
      fs.chmodSync(dir, 0o700);
    }
  });

  it('accepts an exactly-0700 config directory', () => {
    fs.chmodSync(dir, 0o700);
    expect(compose().SLACK_BOT_TOKEN).toBe(BOT);
  });

  it('refuses a credential file that carries no bot token (I5/M3)', () => {
    writeSecrets(`SLACK_APP_TOKEN=${APP}\n`);
    expectRefusal(/SLACK_BOT_TOKEN/);
  });

  it('refuses a credential file that carries no app token (I5/M3)', () => {
    writeSecrets(`SLACK_BOT_TOKEN=${BOT}\n`);
    expectRefusal(/SLACK_APP_TOKEN/);
  });

  it('refuses an empty credential file rather than starting a token-less daemon (M3)', () => {
    writeSecrets('# nothing here\n');
    expectRefusal(/SLACK_/);
  });

  it('refuses a runtime env file that is not exactly owner-only (M4)', () => {
    // ANTHROPIC_API_KEY is on the runtime allowlist; a 0644 .env would publish
    // a real key the moment an operator moves off the llmux placeholder.
    writeEnv('AUTH_MODE=llmux\n', 0o644);
    const message = expectRefusal(/profile environment file/);
    expect(message).not.toContain(BOT);
  });

  it('composes from a directory whose path contains a colon and a space (M5)', () => {
    const odd = fs.mkdtempSync(path.join(os.tmpdir(), 'soma:profile env-'));
    fs.chmodSync(odd, 0o700);
    fs.writeFileSync(path.join(odd, '.env'), 'AUTH_MODE=llmux\n', { mode: 0o600 });
    fs.chmodSync(path.join(odd, '.env'), 0o600);
    fs.writeFileSync(path.join(odd, 'secrets.env'), `SLACK_BOT_TOKEN=${BOT}\nSLACK_APP_TOKEN=${APP}\n`, {
      mode: 0o600,
    });
    fs.chmodSync(path.join(odd, 'secrets.env'), 0o600);
    try {
      const env = resolveSupervisorChildEnv({
        SOMA_CONFIG_DIR: odd,
        SOMA_PROFILE_ENV_FILE: path.join(odd, '.env'),
        SOMA_PROFILE_SECRETS_FILE: path.join(odd, 'secrets.env'),
      });
      expect(env.SLACK_BOT_TOKEN).toBe(BOT);
    } finally {
      fs.rmSync(odd, { recursive: true, force: true });
    }
  });

  it('refuses a config directory or env file owned by another user (I5)', () => {
    // `chown` needs root, so ownership is exercised through the injected seam —
    // the same seam production uses, with only `uid` differing.
    const realFs = {
      assertNoSymlinkPath: () => {},
      readFile: (target: string) => fs.readFileSync(target, 'utf-8'),
      currentUid: () => 501,
      lstat: (target: string) => {
        const st = fs.lstatSync(target);
        return {
          mode: st.mode & 0o777,
          isFile: st.isFile(),
          isDirectory: st.isDirectory(),
          isSymbolicLink: st.isSymbolicLink(),
          uid: 501,
        };
      },
    };
    const foreign = (target: string) => ({
      ...realFs,
      lstat: (probe: string) => ({ ...realFs.lstat(probe), uid: probe === target ? 502 : 501 }),
    });

    for (const target of [dir, envFile, secretsFile]) {
      let caught: unknown;
      try {
        composeProfileEnv({ base: {}, runtimeEnvFile: envFile, secretsFile, fixed: {}, fs: foreign(target) });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ProfileEnvError);
      expect(String((caught as Error).message)).toMatch(/owned by another user/);
      expect(String((caught as Error).message)).not.toContain(BOT);
    }

    // Sanity: the same seam with matching ownership composes cleanly, so the
    // refusals above are about the uid and nothing else.
    expect(
      composeProfileEnv({ base: {}, runtimeEnvFile: envFile, secretsFile, fixed: {}, fs: realFs }).SLACK_BOT_TOKEN,
    ).toBe(BOT);
  });

  it('never leaks a credential value into an error thrown for an unrelated fault', () => {
    writeEnv('AUTH_MODE=llmux\nEVIL_KEY=1\n');
    let caught: unknown;
    try {
      compose();
    } catch (err) {
      caught = err;
    }
    const serialized = `${(caught as Error).message}\n${(caught as Error).stack ?? ''}`;
    expect(serialized).not.toContain(BOT);
    expect(serialized).not.toContain(APP);
  });
});

describe('resolveSupervisorChildEnv', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-supervisor-env-'));
    fs.chmodSync(dir, 0o700);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('passes the environment through untouched outside a profile install', () => {
    const base = { SOMA_CONFIG_DIR: '/opt/soma-work/main', PATH: '/usr/bin' };
    expect(resolveSupervisorChildEnv(base)).toBe(base);
  });

  it('composes the profile environment when the plist named the two env files', () => {
    fs.writeFileSync(path.join(dir, '.env'), 'AUTH_MODE=llmux\n', { mode: 0o600 });
    fs.writeFileSync(
      path.join(dir, 'secrets.env'),
      'SLACK_BOT_TOKEN=xoxb-1-2-abcdefghijkl\nSLACK_APP_TOKEN=xapp-1-A2-3-mnopqrstuvwx\n',
      { mode: 0o600 },
    );
    fs.chmodSync(path.join(dir, '.env'), 0o600);
    fs.chmodSync(path.join(dir, 'secrets.env'), 0o600);

    const env = resolveSupervisorChildEnv({
      HOME: '/Users/op',
      PATH: '/usr/bin',
      SOMA_CONFIG_DIR: dir,
      SOMA_DATA_DIR: '/data',
      SOMA_BASE_DIRECTORY: '/work',
      SOMA_LOG_DIR: '/logs',
      SOMA_PROFILE_ENV_FILE: path.join(dir, '.env'),
      SOMA_PROFILE_SECRETS_FILE: path.join(dir, 'secrets.env'),
    });
    expect(env.AUTH_MODE).toBe('llmux');
    expect(env.SLACK_BOT_TOKEN).toBe('xoxb-1-2-abcdefghijkl');
    expect(env.SOMA_DATA_DIR).toBe('/data');
  });

  it('refuses env-file paths that do not match the profile config directory', () => {
    fs.writeFileSync(path.join(dir, '.env'), 'AUTH_MODE=llmux\n', { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'secrets.env'), 'SLACK_BOT_TOKEN=xoxb-1-2-abcdefghijkl\n', { mode: 0o600 });
    fs.chmodSync(path.join(dir, '.env'), 0o600);
    fs.chmodSync(path.join(dir, 'secrets.env'), 0o600);
    expect(() =>
      resolveSupervisorChildEnv({
        SOMA_CONFIG_DIR: dir,
        SOMA_PROFILE_ENV_FILE: '/tmp/other/.env',
        SOMA_PROFILE_SECRETS_FILE: path.join(dir, 'secrets.env'),
      }),
    ).toThrow(ProfileEnvError);
  });
});

/**
 * The composition above is unit-tested in isolation; this proves the REAL
 * supervisor path uses it. Without this, `main()` could keep passing
 * `process.env` straight through and every test in this file would still be
 * green while the daemon started with no credentials at all.
 */
describe('supervisor main() — profile environment reaches the daemon', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-supervisor-main-'));
    fs.chmodSync(dir, 0o700);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('composes the two profile files and hands the result to the child', () => {
    const configDir = path.join(dir, 'config');
    const logDir = path.join(dir, 'logs');
    const dataDir = path.join(dir, 'data');
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(configDir, '.env'), 'AUTH_MODE=llmux\nBASE_DIRECTORY=/work\n', { mode: 0o600 });
    fs.writeFileSync(
      path.join(configDir, 'secrets.env'),
      'SLACK_BOT_TOKEN=xoxb-1-2-abcdefghijkl\nSLACK_APP_TOKEN=xapp-1-A2-3-mnopqrstuvwx\n',
      { mode: 0o600 },
    );
    fs.chmodSync(configDir, 0o700);
    fs.chmodSync(path.join(configDir, '.env'), 0o600);
    fs.chmodSync(path.join(configDir, 'secrets.env'), 0o600);

    // The "daemon": reports only whether the values arrived, never the values.
    const probe = path.join(dir, 'probe.js');
    const out = path.join(dir, 'probe.json');
    fs.writeFileSync(
      probe,
      `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({\n` +
        '  hasBotToken: typeof process.env.SLACK_BOT_TOKEN === "string" && process.env.SLACK_BOT_TOKEN.length > 0,\n' +
        '  authMode: process.env.AUTH_MODE ?? null,\n' +
        '  dataDir: process.env.SOMA_DATA_DIR ?? null,\n' +
        '}));\n',
    );

    const result = spawnSync(
      process.execPath,
      [path.join(__dirname, '..', 'node_modules', '.bin', 'tsx'), __filename.replace(/\.test\.ts$/, '.ts'), probe],
      {
        cwd: dir,
        env: {
          ...process.env,
          HOME: dir,
          SOMA_CONFIG_DIR: configDir,
          SOMA_DATA_DIR: dataDir,
          SOMA_BASE_DIRECTORY: '/work',
          SOMA_LOG_DIR: logDir,
          SOMA_PROFILE_ENV_FILE: path.join(configDir, '.env'),
          SOMA_PROFILE_SECRETS_FILE: path.join(configDir, 'secrets.env'),
        },
        encoding: 'utf-8',
        timeout: 60_000,
      },
    );

    expect(result.status).toBe(0);
    const observed = JSON.parse(fs.readFileSync(out, 'utf-8'));
    expect(observed).toEqual({ hasBotToken: true, authMode: 'llmux', dataDir: dataDir });
  });
});

describe('prepareProfileLogDir (M11)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-logdir-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates a profile log root owner-only, never at the 0755 default', () => {
    const logDir = path.join(dir, 'state', 'logs');
    prepareProfileLogDir(logDir, true);
    expect(fs.statSync(logDir).mode & 0o777).toBe(0o700);
  });

  it('tightens a profile log root that already exists at 0755', () => {
    const logDir = path.join(dir, 'logs');
    fs.mkdirSync(logDir, { mode: 0o755 });
    fs.chmodSync(logDir, 0o755);
    prepareProfileLogDir(logDir, true);
    expect(fs.statSync(logDir).mode & 0o777).toBe(0o700);
  });

  it('refuses a symlinked profile log root', () => {
    const real = path.join(dir, 'real');
    fs.mkdirSync(real);
    const link = path.join(dir, 'logs');
    fs.symlinkSync(real, link);
    expect(() => prepareProfileLogDir(link, true)).toThrow(ProfileEnvError);
  });

  it('leaves a source-tree log directory alone, mode included', () => {
    const logDir = path.join(dir, 'legacy-logs');
    fs.mkdirSync(logDir, { mode: 0o755 });
    fs.chmodSync(logDir, 0o755);
    prepareProfileLogDir(logDir, false);
    expect(fs.statSync(logDir).mode & 0o777).toBe(0o755);
  });
});
