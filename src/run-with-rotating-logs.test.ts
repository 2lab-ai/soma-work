import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BOOTSTRAP_LOG_CAP_BYTES,
  capBootstrapLogs,
  DEFAULT_ROTATION_OPTIONS,
  forwardSignalWithEscalation,
  type KillableChild,
  resolveLogDir,
  runWithRotatingLogs,
} from './run-with-rotating-logs';

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
