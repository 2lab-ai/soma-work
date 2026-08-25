import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DoctorReport } from '../doctor';
import { type CliOverrides, FALLBACK_FAILURE_DOCUMENT, readControllerVersionFrom, runCli } from '../index';
import type { ProfileName } from '../profile';
import { profilePaths } from '../profile';
import { SetupError } from '../setup/orchestrator';

// ---------------------------------------------------------------------------
// Stream harness
// ---------------------------------------------------------------------------

let home: string;
let outChunks: string[];
let errChunks: string[];
let realStdout: typeof process.stdout.write;
let realStderr: typeof process.stderr.write;
let stdoutSpy: typeof process.stdout.write;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'somawork-cli-'));
  outChunks = [];
  errChunks = [];
  realStdout = process.stdout.write;
  realStderr = process.stderr.write;
  stdoutSpy = ((chunk: unknown) => {
    outChunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = stdoutSpy;
  process.stderr.write = ((chunk: unknown) => {
    errChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stdout.write = realStdout;
  process.stderr.write = realStderr;
  fs.rmSync(home, { recursive: true, force: true });
});

const out = () => outChunks.join('');
const err = () => errChunks.join('');

function baseOverrides(extra: CliOverrides = {}): CliOverrides {
  return { home, env: {}, ...extra };
}

function report(profile: ProfileName, ok = true): DoctorReport {
  return {
    profile,
    ok,
    checks: [{ id: 'llmux', status: ok ? 'pass' : 'fail', detail: ok ? 'fine' : 'not fine' }],
  };
}

// ---------------------------------------------------------------------------
// Private helper routes
// ---------------------------------------------------------------------------

describe('private helper routes', () => {
  /** The start hook carries this run's capture challenge (I-1). */
  const NONCE = 'a'.repeat(64);

  it('reaches _capture-slack-auth before the public parser rejects unknown commands', async () => {
    const seen: string[] = [];
    const code = await runCli(
      ['_capture-slack-auth', '--socket', '/tmp/x.sock', '--nonce', NONCE],
      baseOverrides({
        captureHelper: async (socketPath) => {
          seen.push(socketPath);
        },
      }),
    );
    expect(code).toBe(0);
    expect(seen).toEqual(['/tmp/x.sock']);
  });

  it('writes zero bytes to stdout and stderr when the capture succeeds', async () => {
    await runCli(
      ['_capture-slack-auth', '--socket', '/tmp/x.sock', '--nonce', NONCE],
      baseOverrides({ captureHelper: async () => {} }),
    );
    expect(out()).toBe('');
    expect(err()).toBe('');
  });

  it('refuses the capture route without a well-formed challenge, and says nothing about it', async () => {
    for (const argv of [
      ['_capture-slack-auth', '--socket', '/tmp/x.sock'],
      ['_capture-slack-auth', '--socket', '/tmp/x.sock', '--nonce', 'SENTINELNONCELEAK'],
      ['_capture-slack-auth', '--socket', '/tmp/x.sock', '--nonce', NONCE.slice(0, -1)],
    ]) {
      outChunks = [];
      errChunks = [];
      const helper = vi.fn();
      const code = await runCli(argv, baseOverrides({ captureHelper: helper }));
      expect(code, argv.join(' ')).not.toBe(0);
      expect(helper).not.toHaveBeenCalled();
      expect(out()).toBe('');
      expect(err()).not.toContain('SENTINELNONCELEAK');
    }
  });

  it('reduces a capture failure to fixed text — never env, argv, frame, ack, or token', async () => {
    const leaky = new Error('frame {"botToken":"xoxb-9999-abcdefghijklmnop"} on /tmp/x.sock via SLACK_CLI_XOXB');
    leaky.name = 'SlackCaptureProtocolError';
    const code = await runCli(
      ['_capture-slack-auth', '--socket', '/tmp/x.sock'],
      baseOverrides({
        captureHelper: async () => {
          throw leaky;
        },
      }),
    );
    expect(code).not.toBe(0);
    expect(out()).toBe('');
    expect(err()).not.toContain('xoxb-');
    expect(err()).not.toContain('SLACK_CLI_XOXB');
    expect(err()).not.toContain('/tmp/x.sock');
    expect(err()).not.toContain('botToken');
  });

  it('never falls through into setup after a helper failure', async () => {
    const setup = vi.fn();
    await runCli(
      ['_capture-slack-auth', '--socket', '/tmp/x.sock'],
      baseOverrides({
        captureHelper: async () => {
          throw new Error('nope');
        },
        runSetup: setup as unknown as CliOverrides['runSetup'],
      }),
    );
    expect(setup).not.toHaveBeenCalled();
  });

  it('rejects a helper argv that does not match the exact flag grammar', async () => {
    for (const argv of [['_capture-slack-auth'], ['_capture-slack-auth', '--socket'], ['_print-slack-manifest']]) {
      outChunks = [];
      const code = await runCli(
        argv,
        baseOverrides({ captureHelper: async () => {}, manifestHelper: async () => '{}' }),
      );
      expect(code, argv.join(' ')).not.toBe(0);
      expect(out(), argv.join(' ')).toBe('');
    }
  });

  it('prints exactly the manifest helper JSON on stdout, even with ambient module noise', async () => {
    const code = await runCli(
      ['_print-slack-manifest', '--path', '/tmp/m.json'],
      baseOverrides({
        manifestHelper: async () => {
          console.log('[env-paths] dev env=… data=… config=…');
          process.stdout.write('raw module chatter\n');
          console.warn('a warning nobody asked for');
          return '{"display_information":{"name":"Somawork Preview"}}';
        },
      }),
    );
    expect(code).toBe(0);
    expect(out()).toBe('{"display_information":{"name":"Somawork Preview"}}\n');
    expect(JSON.parse(out())).toEqual({ display_information: { name: 'Somawork Preview' } });
  });

  it('restores the streams after a private route so the next command is clean', async () => {
    await runCli(
      ['_print-slack-manifest', '--path', '/tmp/m.json'],
      baseOverrides({ manifestHelper: async () => '{}' }),
    );
    expect(process.stdout.write).toBe(stdoutSpy);
  });

  it('keeps the private routes out of every public error message', async () => {
    await runCli(['launch'], baseOverrides());
    expect(err()).not.toContain('_capture-slack-auth');
    expect(err()).not.toContain('_print-slack-manifest');
  });
});

// ---------------------------------------------------------------------------
// doctor --json
// ---------------------------------------------------------------------------

describe('doctor --json', () => {
  it('emits exactly one parseable JSON document despite ambient stdout noise', async () => {
    const code = await runCli(
      ['doctor', '--profile', 'preview', '--json'],
      baseOverrides({
        computeDoctorReport: async (profile) => {
          console.log('[env-paths] main env=/x/.env data=/x/data');
          process.stdout.write('{"not":"the document"}\n');
          console.error('[config] loaded 4 plugins');
          process.stderr.write('a stderr line\n');
          return report(profile);
        },
      }),
    );
    expect(code).toBe(0);
    // Parse the RAW captured stdout — no trimming, no "last {" heuristic.
    const parsed = JSON.parse(out());
    expect(parsed).toEqual({ profile: 'preview', ok: true, checks: [{ id: 'llmux', status: 'pass', detail: 'fine' }] });
  });

  it('still emits one JSON document when the doctor throws, and never quotes the throw', async () => {
    const leaky = new Error('llmux unreachable at http://localhost:3456/?admin_key=deadbeefdeadbeef');
    leaky.name = 'LlmuxEndpointError';
    const code = await runCli(
      ['doctor', '--profile', 'preview', '--json'],
      baseOverrides({
        computeDoctorReport: async () => {
          process.stdout.write('partial noise before the throw\n');
          throw leaky;
        },
      }),
    );
    expect(code).not.toBe(0);
    const parsed = JSON.parse(out());
    expect(parsed.ok).toBe(false);
    expect(parsed.profile).toBe('preview');
    expect(out()).not.toContain('admin_key');
    expect(out()).not.toContain('localhost');
    expect(out()).not.toContain('unreachable at');
  });

  it('never embeds the captured ambient bytes into the document', async () => {
    await runCli(
      ['doctor', '--profile', 'preview', '--json'],
      baseOverrides({
        computeDoctorReport: async (profile) => {
          process.stdout.write('SLACK_BOT_TOKEN=xoxb-1111-2222-abcdefghijklmnop\n');
          return report(profile);
        },
      }),
    );
    expect(out()).not.toContain('xoxb-');
    expect(() => JSON.parse(out())).not.toThrow();
  });

  it('restores stdout, stderr and console in finally — proven by the next command', async () => {
    const originalConsoleLog = console.log;
    await runCli(
      ['doctor', '--profile', 'preview', '--json'],
      baseOverrides({
        computeDoctorReport: async () => {
          throw new Error('boom');
        },
      }),
    );
    expect(process.stdout.write).toBe(stdoutSpy);
    expect(process.stderr.write).not.toBe(undefined);
    expect(console.log).toBe(originalConsoleLog);

    outChunks = [];
    await runCli(
      ['doctor', '--profile', 'production', '--json'],
      baseOverrides({ computeDoctorReport: async (p) => report(p) }),
    );
    expect(JSON.parse(out()).profile).toBe('production');
  });

  it('restores the sinks even when the failure path itself throws', async () => {
    // A hostile error whose `name` getter throws: this is the value that reaches
    // `failureDocument`, so without a `finally` the process would be left with a
    // dead stdout and no way to report anything at all.
    const hostile = {};
    Object.defineProperty(hostile, 'name', {
      get() {
        throw new Error('nice try');
      },
    });

    const code = await runCli(
      ['doctor', '--profile', 'preview', '--json'],
      baseOverrides({
        computeDoctorReport: async () => {
          throw hostile;
        },
      }),
    );
    expect(process.stdout.write).toBe(stdoutSpy);
    expect(code).not.toBe(0);
  });

  it('exits nonzero when the report is not ok', async () => {
    const code = await runCli(
      ['doctor', '--profile', 'preview', '--json'],
      baseOverrides({ computeDoctorReport: async (p) => report(p, false) }),
    );
    expect(code).toBe(1);
    expect(JSON.parse(out()).ok).toBe(false);
  });

  it('keeps useful progress in text mode', async () => {
    const code = await runCli(
      ['doctor', '--profile', 'preview'],
      baseOverrides({ computeDoctorReport: async (p) => report(p) }),
    );
    expect(code).toBe(0);
    expect(out()).toContain('llmux');
    expect(() => JSON.parse(out())).toThrow();
  });
});

// ---------------------------------------------------------------------------
// status --json
// ---------------------------------------------------------------------------

describe('status --json', () => {
  function serviceStatus(overrides: Record<string, unknown> = {}) {
    return {
      profile: 'preview',
      label: 'ai.2lab.somawork.preview',
      state: 'running-launchd',
      manager: 'launchd',
      pid: 42,
      supervisorPid: 41,
      registered: true,
      ready: true,
      plistInstalled: true,
      plistPath: '/Users/z/Library/LaunchAgents/ai.2lab.somawork.preview.plist',
      configDir: '/c',
      dataDir: '/d',
      stateDir: '/s',
      runtimeRoot: '/r',
      logDir: '/s/logs',
      pidFile: '/d/soma-work.pid',
      readyFile: '/d/soma-work.ready',
      ...overrides,
    } as never;
  }

  it('emits one JSON document carrying the doctor verdict and the safe service state', async () => {
    const code = await runCli(
      ['status', '--profile', 'preview', '--json'],
      baseOverrides({
        computeDoctorReport: async (p) => {
          console.log('[env-paths] noise that must not reach the document');
          return report(p);
        },
        serviceManager: async () => ({
          install: async () => serviceStatus(),
          start: async () => serviceStatus(),
          stop: async () => serviceStatus(),
          restart: async () => serviceStatus(),
          status: async () => serviceStatus(),
        }),
      }),
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(out());
    expect(parsed.profile).toBe('preview');
    expect(parsed.service.label).toBe('ai.2lab.somawork.preview');
    expect(parsed.service.ready).toBe(true);
    expect(out()).not.toContain('env-paths');
  });

  it('restores the sinks so the next command is clean', async () => {
    await runCli(
      ['status', '--profile', 'preview', '--json'],
      baseOverrides({ computeDoctorReport: async (p) => report(p) }),
    );
    expect(process.stdout.write).toBe(stdoutSpy);

    outChunks = [];
    await runCli(
      ['status', '--profile', 'production', '--json'],
      baseOverrides({ computeDoctorReport: async (p) => report(p) }),
    );
    expect(JSON.parse(out()).profile).toBe('production');
  });

  it('reports a profile with no installed service as service:null rather than failing', async () => {
    const code = await runCli(
      ['status', '--profile', 'preview', '--json'],
      baseOverrides({
        computeDoctorReport: async (p) => report(p),
        serviceManager: async () => {
          throw new Error('no plist here');
        },
      }),
    );
    expect(code).toBe(0);
    expect(JSON.parse(out()).service).toBeNull();
  });

  it('still emits one JSON document when the doctor throws', async () => {
    const boom = new Error('llmux unreachable at http://localhost:3456');
    boom.name = 'LlmuxEndpointError';
    const code = await runCli(
      ['status', '--profile', 'preview', '--json'],
      baseOverrides({
        computeDoctorReport: async () => {
          throw boom;
        },
      }),
    );
    expect(code).not.toBe(0);
    expect(JSON.parse(out()).ok).toBe(false);
    expect(out()).not.toContain('localhost');
  });
});

// ---------------------------------------------------------------------------
// Error rendering
// ---------------------------------------------------------------------------

describe('error rendering', () => {
  it('prints the fixed message of an error this CLI authored', async () => {
    const code = await runCli(
      ['setup'],
      baseOverrides({
        runSetup: async () => {
          throw new SetupError('llmux', 'llmux: LlmuxUnhealthyError', 'llmux is not ready. Re-run to resume.');
        },
      }),
    );
    expect(code).toBe(1);
    expect(err()).toContain('llmux is not ready');
  });

  it('reduces an unknown error to fixed redacted text without its .message', async () => {
    const raw = new Error('Failed to start "/bin/launchctl": spawn EMFILE');
    raw.name = 'CommandSpawnError';
    const code = await runCli(
      ['setup'],
      baseOverrides({
        runSetup: async () => {
          throw raw;
        },
      }),
    );
    expect(code).toBe(1);
    expect(err()).not.toContain('/bin/launchctl');
    expect(err()).not.toContain('EMFILE');
    expect(err()).toContain('somawork');
  });

  it('reduces a thrown non-Error to the same fixed text', async () => {
    const code = await runCli(
      ['setup'],
      baseOverrides({
        runSetup: async () => {
          throw 'xoxb-1111-2222-abcdefghijklmnop';
        },
      }),
    );
    expect(code).toBe(1);
    expect(err()).not.toContain('xoxb-');
  });

  it('prints a parse error for an unknown command', async () => {
    const code = await runCli(['launch'], baseOverrides());
    expect(code).toBe(1);
    expect(err()).toContain('Unknown command');
  });
});

// ---------------------------------------------------------------------------
// setup routing
// ---------------------------------------------------------------------------

describe('setup routing', () => {
  it('runs the identical path for plain setup and --resume', async () => {
    const seen: Array<{ resume?: boolean; requestedProfile?: ProfileName }> = [];
    const spy: CliOverrides['runSetup'] = async (deps) => {
      seen.push({ resume: deps.resume, requestedProfile: deps.requestedProfile });
      return {
        status: 'complete',
        profile: 'preview',
        appId: 'A1',
        teamId: 'T1',
        runtimeVersion: '1.0.0',
        service: { profile: 'preview' } as never,
      };
    };
    expect(await runCli(['setup'], baseOverrides({ runSetup: spy }))).toBe(0);
    expect(await runCli(['setup', '--resume'], baseOverrides({ runSetup: spy }))).toBe(0);
    expect(seen[0].requestedProfile).toBe(seen[1].requestedProfile);
  });

  it('exits with the documented pending code for a Slack approval hold', async () => {
    const code = await runCli(
      ['setup'],
      baseOverrides({
        runSetup: async () => ({
          status: 'pending-slack-approval',
          profile: 'preview',
          appId: 'A0123456789',
          teamId: 'T0123456789',
          step: 'slack_app',
        }),
      }),
    );
    expect(code).toBe(75);
    expect(out()).toContain('A0123456789');
  });
});

// ---------------------------------------------------------------------------
// sessions routing
// ---------------------------------------------------------------------------

describe('sessions routing', () => {
  function seed(dataDir: string): void {
    const dir = path.join(dataDir, 'archives');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'k1_1.json'),
      JSON.stringify({
        archivedAt: 1,
        archiveReason: 'idle',
        sessionKey: 'k1',
        ownerId: 'U1',
        channelId: 'C1',
        lastActivity: 'x',
      }),
    );
  }

  it('reads the selected profile data root, not the working directory', async () => {
    const dataDir = profilePaths(home, 'preview').dataDir;
    seed(dataDir);
    const code = await runCli(['sessions', 'list', '--profile', 'preview'], baseOverrides());
    expect(code).toBe(0);
    expect(out()).toContain('k1');
  });

  it('honours SOMA_DATA_DIR over the profile default', async () => {
    const override = path.join(home, 'elsewhere');
    seed(override);
    const code = await runCli(
      ['sessions', 'show', 'k1', '--profile', 'production'],
      baseOverrides({ env: { SOMA_DATA_DIR: override } }),
    );
    expect(code).toBe(0);
    expect(out()).toContain('Session: k1');
  });

  it('returns nonzero when a session key is missing, without throwing out of the CLI', async () => {
    const dataDir = profilePaths(home, 'preview').dataDir;
    seed(dataDir);
    const code = await runCli(['sessions', 'show', 'nope', '--profile', 'preview'], baseOverrides());
    expect(code).toBe(1);
    expect(err()).toContain('Session not found');
  });

  it('passes the filter tail straight through to the sessions handler', async () => {
    const dataDir = profilePaths(home, 'preview').dataDir;
    seed(dataDir);
    await runCli(['sessions', 'list', '--profile', 'preview', '--user', 'nobody'], baseOverrides());
    expect(out()).toContain('No sessions match the filter.');
  });
});

// ---------------------------------------------------------------------------
// Fix round 1 — I-1: the JSON failure path is total
// ---------------------------------------------------------------------------

describe('total JSON failure documents', () => {
  /** Values whose mere inspection can throw, or which have no `name` at all. */
  function hostileValues(): Array<[label: string, value: unknown]> {
    const throwingGetter = {};
    Object.defineProperty(throwingGetter, 'name', {
      get() {
        throw new Error('nice try');
      },
      enumerable: true,
    });

    const throwingProxy = new Proxy(
      {},
      {
        get() {
          throw new Error('trap');
        },
        has() {
          throw new Error('trap');
        },
      },
    );

    const circular: Record<string, unknown> = { name: 'Circular' };
    circular.self = circular;

    const throwingToString = {
      name: {
        toString() {
          throw new Error('nope');
        },
      },
    };

    return [
      ['throwing name getter', throwingGetter],
      ['throwing proxy trap', throwingProxy],
      ['circular structure', circular],
      ['null', null],
      ['undefined', undefined],
      ['a symbol', Symbol('boom')],
      ['a bare string', 'xoxb-1111-2222-abcdefghijklmnop'],
      ['a number', 42],
      ['an object whose name stringifies badly', throwingToString],
    ];
  }

  for (const command of ['doctor', 'status'] as const) {
    it.each(hostileValues())(`${command} --json still emits one parseable document for %s`, async (_label, value) => {
      const code = await runCli(
        [command, '--profile', 'preview', '--json'],
        baseOverrides({
          computeDoctorReport: async () => {
            throw value;
          },
        }),
      );
      // Parse the RAW captured stdout — no trimming, no "last {" heuristic.
      const parsed = JSON.parse(out());
      expect(parsed.ok).toBe(false);
      expect(parsed).toHaveProperty('checks');
      // The requested profile survives into the document: reaching the frozen
      // last-resort constant (which carries `profile: null`) would mean the
      // name read threw all the way out of `failureDocument`.
      expect(parsed.profile).toBe('preview');
      // A bounded identifier, never a message: `'Error'` for anything hostile
      // or nameless, the object's own `name` when it is already safe.
      expect(parsed.error).toMatch(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);
      expect(code).not.toBe(0);
      expect(out()).not.toContain('xoxb-');
      expect(out()).not.toContain('nice try');
      // Exactly one document.
      expect(outChunks.filter((chunk) => chunk.trimStart().startsWith('{'))).toHaveLength(1);
      // And the sinks are back.
      expect(process.stdout.write).toBe(stdoutSpy);
    });
  }

  it('keeps the last-resort constant a valid, secret-free document', () => {
    // Unreachable through the value types the router can hold, so it is pinned
    // as an artifact: if it ever ships malformed, the branch that needs it is
    // exactly the branch nobody can debug.
    expect(JSON.parse(FALLBACK_FAILURE_DOCUMENT)).toEqual({
      profile: null,
      ok: false,
      checks: [],
      error: 'Error',
    });
  });

  it('never writes zero bytes to stdout on any failure', async () => {
    const throwingGetter = {};
    Object.defineProperty(throwingGetter, 'name', {
      get() {
        throw new Error('nice try');
      },
    });
    for (const command of ['doctor', 'status'] as const) {
      outChunks = [];
      await runCli(
        [command, '--profile', 'preview', '--json'],
        baseOverrides({
          computeDoctorReport: async () => {
            throw throwingGetter;
          },
        }),
      );
      expect(out().length, command).toBeGreaterThan(0);
      expect(() => JSON.parse(out()), command).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Fix round 1 — I-3: concurrent JSON commands
// ---------------------------------------------------------------------------

describe('concurrent JSON commands', () => {
  function documents(): unknown[] {
    // A JSON document is a chunk that starts a JSON value — `profile list --json`
    // legitimately emits an array, the rest emit objects.
    return outChunks.filter((chunk) => /^[[{]/.test(chunk.trimStart())).map((chunk) => JSON.parse(chunk));
  }

  it('yields two independently parseable documents, neither lost nor nested', async () => {
    const results = await Promise.all([
      runCli(
        ['doctor', '--profile', 'preview', '--json'],
        baseOverrides({
          computeDoctorReport: async (p) => {
            process.stdout.write('NOISE-A\n');
            await new Promise((resolve) => setTimeout(resolve, 5));
            console.log('[env-paths] NOISE-A2');
            return report(p);
          },
        }),
      ),
      runCli(
        ['doctor', '--profile', 'production', '--json'],
        baseOverrides({
          computeDoctorReport: async (p) => {
            process.stdout.write('NOISE-B\n');
            return report(p);
          },
        }),
      ),
    ]);

    expect(results).toEqual([0, 0]);
    const parsed = documents() as Array<{ profile: string }>;
    expect(parsed).toHaveLength(2);
    expect(parsed.map((d) => d.profile).sort()).toEqual(['preview', 'production']);
    expect(out()).not.toContain('NOISE');
  });

  it('mixes doctor and status without interleaving their documents', async () => {
    await Promise.all([
      runCli(
        ['doctor', '--profile', 'preview', '--json'],
        baseOverrides({ computeDoctorReport: async (p) => report(p) }),
      ),
      runCli(
        ['status', '--profile', 'production', '--json'],
        baseOverrides({ computeDoctorReport: async (p) => report(p) }),
      ),
      runCli(['profile', 'list', '--json'], baseOverrides({ discoverRuntimes: async () => [] })),
    ]);
    expect(documents()).toHaveLength(3);
  });

  it('releases the lock when a command fails, so the next one still runs', async () => {
    const results = await Promise.all([
      runCli(
        ['doctor', '--profile', 'preview', '--json'],
        baseOverrides({
          computeDoctorReport: async () => {
            throw new Error('first fails');
          },
        }),
      ),
      runCli(
        ['doctor', '--profile', 'production', '--json'],
        baseOverrides({ computeDoctorReport: async (p) => report(p) }),
      ),
    ]);
    expect(results[1]).toBe(0);
    expect(documents()).toHaveLength(2);
    expect(process.stdout.write).toBe(stdoutSpy);
  });

  it('releases the lock even when writing the document throws', async () => {
    let failNext = true;
    process.stdout.write = ((chunk: unknown) => {
      if (failNext && String(chunk).trimStart().startsWith('{')) {
        failNext = false;
        throw new Error('EPIPE');
      }
      outChunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    const first = runCli(
      ['doctor', '--profile', 'preview', '--json'],
      baseOverrides({ computeDoctorReport: async (p) => report(p) }),
    ).catch(() => 'threw');
    const second = runCli(
      ['doctor', '--profile', 'production', '--json'],
      baseOverrides({ computeDoctorReport: async (p) => report(p) }),
    );

    await first;
    expect(await second).toBe(0);
    expect(documents()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Fix round 1 — I-2: the sessions handler owns its own errors
// ---------------------------------------------------------------------------

describe('sessions error paths', () => {
  function seedArchives(dataDir: string): void {
    const dir = path.join(dataDir, 'archives');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'k1_1.json'),
      JSON.stringify({
        archivedAt: 1,
        archiveReason: 'idle',
        sessionKey: 'k1',
        ownerId: 'U1',
        channelId: 'C1',
        lastActivity: 'x',
      }),
    );
  }

  it('prints exactly the historical not-found line, with no setup/doctor advice', async () => {
    seedArchives(profilePaths(home, 'preview').dataDir);
    const code = await runCli(['sessions', 'show', 'nope', '--profile', 'preview'], baseOverrides());
    expect(code).toBe(1);
    expect(err()).toBe('Session not found: nope\n');
    expect(err()).not.toContain('somawork:');
    expect(out()).toBe('');
  });

  it('prints exactly the historical usage line when the key is missing', async () => {
    seedArchives(profilePaths(home, 'preview').dataDir);
    const code = await runCli(['sessions', 'show', '--profile', 'preview'], baseOverrides());
    expect(code).toBe(1);
    expect(err()).toBe('Usage: somawork sessions show <sessionKey> [--conversation] [--json]\n');
    expect(err()).not.toContain('somawork: the command did not complete');
  });

  it('still renders a genuine handler throw through the generic redacted renderer', async () => {
    const dir = path.join(profilePaths(home, 'preview').dataDir, 'archives');
    fs.mkdirSync(dir, { recursive: true });
    // A record that parses but is missing the required `archiveReason` the
    // renderer reads — the pre-existing crash the move preserved byte for byte.
    fs.writeFileSync(path.join(dir, 'bad_1.json'), JSON.stringify({ archivedAt: 1, sessionKey: 'bad' }));
    const code = await runCli(['sessions', 'list', '--profile', 'preview'], baseOverrides());
    expect(code).toBe(1);
    expect(err()).toContain('somawork:');
    expect(err()).not.toContain('SessionsExit');
  });
});

// ---------------------------------------------------------------------------
// Fix round 1 — M-2: an explicitly pinned data directory needs no runtime
// ---------------------------------------------------------------------------

describe('sessions without runtime discovery', () => {
  function seedArchives(dataDir: string): void {
    const dir = path.join(dataDir, 'archives');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'k1_1.json'),
      JSON.stringify({
        archivedAt: 1,
        archiveReason: 'idle',
        sessionKey: 'k1',
        ownerId: 'U1',
        channelId: 'C1',
        lastActivity: 'x',
      }),
    );
  }

  it('uses SOMA_DATA_DIR with no runtime installed and no --profile', async () => {
    const override = path.join(home, 'pinned');
    seedArchives(override);
    let discovered = 0;
    const code = await runCli(
      ['sessions', 'list'],
      baseOverrides({
        env: { SOMA_DATA_DIR: override },
        discoverRuntimes: async () => {
          discovered += 1;
          return [];
        },
      }),
    );
    expect(code).toBe(0);
    expect(out()).toContain('k1');
    expect(discovered).toBe(0);
  });

  it('uses an explicit --profile with no runtime installed', async () => {
    seedArchives(profilePaths(home, 'production').dataDir);
    let discovered = 0;
    const code = await runCli(
      ['sessions', 'list', '--profile', 'production'],
      baseOverrides({
        discoverRuntimes: async () => {
          discovered += 1;
          return [];
        },
      }),
    );
    expect(code).toBe(0);
    expect(out()).toContain('k1');
    expect(discovered).toBe(0);
  });

  it('falls back to runtime discovery only when nothing pins the directory', async () => {
    let discovered = 0;
    await runCli(
      ['sessions', 'list'],
      baseOverrides({
        discoverRuntimes: async () => {
          discovered += 1;
          return [{ profile: 'preview' as ProfileName, root: '/r', version: '1.0.0' }];
        },
      }),
    );
    expect(discovered).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Fix round 1 — M-1: help and version
// ---------------------------------------------------------------------------

describe('help and version', () => {
  it.each([['help'], ['--help'], ['-h']])('%s prints the public grammar on stdout and exits 0', async (token) => {
    const code = await runCli([token], baseOverrides());
    expect(code).toBe(0);
    expect(err()).toBe('');
    for (const command of ['setup', 'doctor', 'status', 'service', 'profile', 'sessions']) {
      expect(out()).toContain(command);
    }
  });

  it('never names a private hook route in help', async () => {
    await runCli(['--help'], baseOverrides());
    expect(out()).not.toContain('_capture-slack-auth');
    expect(out()).not.toContain('_print-slack-manifest');
    expect(out()).not.toMatch(/(^|\s)_[a-z]/);
  });

  it.each([['version'], ['--version'], ['-V']])('%s prints a version and exits 0', async (token) => {
    const code = await runCli([token], baseOverrides());
    expect(code).toBe(0);
    expect(out().trim()).toMatch(/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/);
    expect(err()).toBe('');
  });

  it('needs no runtime, profile or provider to answer help or version', async () => {
    let touched = 0;
    const overrides = baseOverrides({
      discoverRuntimes: async () => {
        touched += 1;
        return [];
      },
      computeDoctorReport: async () => {
        touched += 1;
        throw new Error('must not be called');
      },
    });
    await runCli(['--help'], overrides);
    await runCli(['--version'], overrides);
    expect(touched).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Fix round 1 — profile list/show --json
// ---------------------------------------------------------------------------

describe('profile --json', () => {
  it('lists an empty array and exits 0 on a machine with no runtime', async () => {
    const code = await runCli(['profile', 'list', '--json'], baseOverrides({ discoverRuntimes: async () => [] }));
    expect(code).toBe(0);
    expect(JSON.parse(out())).toEqual([]);
  });

  it('lists every installed runtime', async () => {
    const code = await runCli(
      ['profile', 'list', '--json'],
      baseOverrides({
        discoverRuntimes: async () => [
          { profile: 'preview' as ProfileName, root: '/p', version: '1.0.0-preview.1' },
          { profile: 'production' as ProfileName, root: '/q', version: '1.0.0' },
        ],
      }),
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(out()) as Array<{ profile: string; version: string; root: string }>;
    expect(parsed.map((p) => p.profile)).toEqual(['preview', 'production']);
  });

  it('shows one object for an explicit profile, even with no runtime installed', async () => {
    const code = await runCli(
      ['profile', 'show', '--profile', 'preview', '--json'],
      baseOverrides({ discoverRuntimes: async () => [] }),
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(out());
    expect(parsed.profile).toBe('preview');
    expect(parsed.configDir).toBe(profilePaths(home, 'preview').configDir);
    expect(parsed.runtime).toBeNull();
  });

  it('emits one JSON error document and a nonzero code when show cannot resolve a profile', async () => {
    const code = await runCli(['profile', 'show', '--json'], baseOverrides({ discoverRuntimes: async () => [] }));
    expect(code).not.toBe(0);
    expect(JSON.parse(out()).ok).toBe(false);
  });

  it('keeps profile remove an honest refusal in both modes', async () => {
    const text = await runCli(['profile', 'remove', '--profile', 'preview'], baseOverrides());
    expect(text).toBe(1);
    expect(err()).toContain('not available');

    outChunks = [];
    const json = await runCli(['profile', 'remove', '--profile', 'preview', '--json'], baseOverrides());
    expect(json).toBe(1);
    expect(JSON.parse(out()).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fix round 1 — M-9: SOMAWORK_HOME is canonical, SOMA_HOME is the alias
// ---------------------------------------------------------------------------

describe('home resolution', () => {
  function seedArchives(dataDir: string): void {
    const dir = path.join(dataDir, 'archives');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'k1_1.json'),
      JSON.stringify({
        archivedAt: 1,
        archiveReason: 'idle',
        sessionKey: 'k1',
        ownerId: 'U1',
        channelId: 'C1',
        lastActivity: 'x',
      }),
    );
  }

  it('honours SOMAWORK_HOME', async () => {
    const canonical = path.join(home, 'canonical');
    seedArchives(profilePaths(canonical, 'preview').dataDir);
    const code = await runCli(['sessions', 'list', '--profile', 'preview'], { env: { SOMAWORK_HOME: canonical } });
    expect(code).toBe(0);
    expect(out()).toContain('k1');
  });

  it('still honours SOMA_HOME as a backwards-compatible alias', async () => {
    const legacy = path.join(home, 'legacy');
    seedArchives(profilePaths(legacy, 'preview').dataDir);
    const code = await runCli(['sessions', 'list', '--profile', 'preview'], { env: { SOMA_HOME: legacy } });
    expect(code).toBe(0);
    expect(out()).toContain('k1');
  });

  it('prefers SOMAWORK_HOME when both are set', async () => {
    const canonical = path.join(home, 'canonical2');
    const legacy = path.join(home, 'legacy2');
    seedArchives(profilePaths(canonical, 'preview').dataDir);
    fs.mkdirSync(path.join(profilePaths(legacy, 'preview').dataDir, 'archives'), { recursive: true });
    const code = await runCli(['sessions', 'list', '--profile', 'preview'], {
      env: { SOMAWORK_HOME: canonical, SOMA_HOME: legacy },
    });
    expect(code).toBe(0);
    expect(out()).toContain('k1');
  });
});

// ---------------------------------------------------------------------------
// Fix round 1 — M-1: the version read never throws
// ---------------------------------------------------------------------------

describe('readControllerVersionFrom', () => {
  it('reads the version out of a real manifest', () => {
    const manifest = path.join(home, 'package.json');
    fs.writeFileSync(manifest, JSON.stringify({ name: 'somawork', version: '2.4.0-preview.7' }));
    expect(readControllerVersionFrom(manifest)).toBe('2.4.0-preview.7');
  });

  it('reports unknown rather than throwing for every unusable manifest', () => {
    const missing = path.join(home, 'nope', 'package.json');
    const junk = path.join(home, 'junk.json');
    const arrayManifest = path.join(home, 'array.json');
    const noVersion = path.join(home, 'noversion.json');
    const hostileVersion = path.join(home, 'hostile.json');
    fs.writeFileSync(junk, '{ not json at all');
    fs.writeFileSync(arrayManifest, '[]');
    fs.writeFileSync(noVersion, JSON.stringify({ name: 'somawork' }));
    fs.writeFileSync(hostileVersion, JSON.stringify({ version: '../../etc/passwd\n' }));

    for (const target of [missing, junk, arrayManifest, noVersion, hostileVersion, home]) {
      expect(readControllerVersionFrom(target), target).toBe('unknown');
    }
  });
});

// ---------------------------------------------------------------------------
// Fix round 2 — I-5: the private manifest route is a JSON body too
// ---------------------------------------------------------------------------

describe('manifest route concurrency', () => {
  function documents(): string[] {
    return outChunks.filter((chunk) => /^[[{]/.test(chunk.trimStart()));
  }

  it('does not swallow a concurrent doctor --json document', async () => {
    const codes = await Promise.all([
      runCli(
        ['_print-slack-manifest', '--path', '/tmp/m.json'],
        baseOverrides({
          manifestHelper: async () => {
            // Hold the sinks long enough for the doctor to overlap.
            await new Promise((resolve) => setTimeout(resolve, 10));
            return '{"manifest":true}';
          },
        }),
      ),
      runCli(
        ['doctor', '--profile', 'preview', '--json'],
        baseOverrides({ computeDoctorReport: async (p) => report(p) }),
      ),
    ]);

    expect(codes).toEqual([0, 0]);
    const parsed = documents().map((chunk) => JSON.parse(chunk));
    expect(parsed).toHaveLength(2);
    expect(parsed.some((d) => (d as { manifest?: boolean }).manifest === true)).toBe(true);
    expect(parsed.some((d) => (d as { profile?: string }).profile === 'preview')).toBe(true);
  });

  it('emits two complete documents for two overlapping manifest routes', async () => {
    const codes = await Promise.all([
      runCli(
        ['_print-slack-manifest', '--path', '/tmp/a.json'],
        baseOverrides({
          manifestHelper: async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            return '{"which":"a"}';
          },
        }),
      ),
      runCli(
        ['_print-slack-manifest', '--path', '/tmp/b.json'],
        baseOverrides({ manifestHelper: async () => '{"which":"b"}' }),
      ),
    ]);
    expect(codes).toEqual([0, 0]);
    const parsed = documents().map((chunk) => JSON.parse(chunk) as { which: string });
    expect(parsed.map((d) => d.which).sort()).toEqual(['a', 'b']);
  });

  it('keeps ambient noise inside the manifest route out of a concurrent document', async () => {
    await Promise.all([
      runCli(
        ['_print-slack-manifest', '--path', '/tmp/m.json'],
        baseOverrides({
          manifestHelper: async () => {
            process.stdout.write('MANIFEST-NOISE\n');
            console.log('[env-paths] MANIFEST-NOISE-2');
            await new Promise((resolve) => setTimeout(resolve, 10));
            return '{"manifest":true}';
          },
        }),
      ),
      runCli(
        ['status', '--profile', 'production', '--json'],
        baseOverrides({ computeDoctorReport: async (p) => report(p) }),
      ),
    ]);
    expect(out()).not.toContain('MANIFEST-NOISE');
    expect(documents()).toHaveLength(2);
  });

  it('releases the lock when the helper throws, so a later JSON command still runs', async () => {
    const codes = await Promise.all([
      runCli(
        ['_print-slack-manifest', '--path', '/tmp/m.json'],
        baseOverrides({
          manifestHelper: async () => {
            throw new Error('helper exploded with /tmp/m.json and SLACK_CLI_XOXB');
          },
        }),
      ),
      runCli(
        ['doctor', '--profile', 'preview', '--json'],
        baseOverrides({ computeDoctorReport: async (p) => report(p) }),
      ),
    ]);
    expect(codes[0]).toBe(1);
    expect(codes[1]).toBe(0);
    expect(documents()).toHaveLength(1);
    // Exactly the fixed line and nothing appended: the failure write happens
    // after `restore()`, where the caught value is not even in scope.
    expect(err()).toBe('somawork: the Slack hook helper failed.\n');
    expect(err()).not.toContain('SLACK_CLI_XOXB');
    expect(err()).not.toContain('/tmp/m.json');
  });

  it('releases the lock when writing the manifest document throws', async () => {
    let failNext = true;
    process.stdout.write = ((chunk: unknown) => {
      if (failNext && String(chunk).trimStart().startsWith('{')) {
        failNext = false;
        throw new Error('EPIPE');
      }
      outChunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    const first = runCli(
      ['_print-slack-manifest', '--path', '/tmp/m.json'],
      baseOverrides({ manifestHelper: async () => '{"which":"a"}' }),
    ).catch(() => 'threw');
    const second = runCli(
      ['doctor', '--profile', 'preview', '--json'],
      baseOverrides({ computeDoctorReport: async (p) => report(p) }),
    );

    await first;
    expect(await second).toBe(0);
    expect(documents()).toHaveLength(1);
    expect(process.stdout.write).not.toBe(undefined);
  });

  it('still dispatches before the public parser and still prints only helper JSON', async () => {
    const code = await runCli(
      ['_print-slack-manifest', '--path', '/tmp/m.json'],
      baseOverrides({ manifestHelper: async () => '{"display_information":{"name":"Somawork Preview"}}' }),
    );
    expect(code).toBe(0);
    expect(out()).toBe('{"display_information":{"name":"Somawork Preview"}}\n');
    expect(err()).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Fix round 2 — N-1: a serializer failure is a failure
// ---------------------------------------------------------------------------

describe('serializer failures exit nonzero', () => {
  /** A check whose `detail` getter throws while `doctorReportToJson` projects it. */
  function reportThatFailsToSerialize(profile: ProfileName): DoctorReport {
    const check = { id: 'llmux', status: 'pass' };
    Object.defineProperty(check, 'detail', {
      get() {
        throw new Error('detail exploded');
      },
      enumerable: true,
    });
    return { profile, ok: true, checks: [check as never] };
  }

  it('doctor --json returns nonzero when the successful report cannot be serialized', async () => {
    const code = await runCli(
      ['doctor', '--profile', 'preview', '--json'],
      baseOverrides({ computeDoctorReport: async (p) => reportThatFailsToSerialize(p) }),
    );
    const parsed = JSON.parse(out());
    expect(parsed.ok).toBe(false);
    // The exit code must agree with the document it just emitted.
    expect(code).toBe(1);
    expect(out()).not.toContain('detail exploded');
  });

  it('status --json returns nonzero when the service status cannot be serialized', async () => {
    const hostileStatus = { profile: 'preview', label: 'x' };
    Object.defineProperty(hostileStatus, 'state', {
      get() {
        throw new Error('state exploded');
      },
      enumerable: true,
    });
    const code = await runCli(
      ['status', '--profile', 'preview', '--json'],
      baseOverrides({
        computeDoctorReport: async (p) => report(p),
        serviceManager: async () => ({
          install: async () => hostileStatus as never,
          start: async () => hostileStatus as never,
          stop: async () => hostileStatus as never,
          restart: async () => hostileStatus as never,
          status: async () => hostileStatus as never,
        }),
      }),
    );
    const parsed = JSON.parse(out());
    expect(parsed.ok).toBe(false);
    expect(code).toBe(1);
    expect(out()).not.toContain('state exploded');
  });

  it('profile --json returns nonzero when the listing cannot be serialized', async () => {
    const hostileRoot = {
      toJSON() {
        throw new Error('root exploded');
      },
    };
    const code = await runCli(
      ['profile', 'list', '--json'],
      baseOverrides({
        discoverRuntimes: async () => [
          { profile: 'preview' as ProfileName, root: hostileRoot as never, version: '1.0.0' },
        ],
      }),
    );
    const parsed = JSON.parse(out());
    expect(parsed.ok).toBe(false);
    expect(code).toBe(1);
    expect(out()).not.toContain('root exploded');
  });

  it('names the RESOLVED profile in the failure document, not the flag that was absent', async () => {
    // With no `--profile`, the profile is discovered. A serializer failure must
    // still report which profile the command actually ran against — the outer
    // catch only knows the (absent) request, so this pins that the failure was
    // produced next to the resolved value.
    const code = await runCli(
      ['doctor', '--json'],
      baseOverrides({
        discoverRuntimes: async () => [{ profile: 'production' as ProfileName, root: '/r', version: '1.0.0' }],
        computeDoctorReport: async (p) => reportThatFailsToSerialize(p),
      }),
    );
    expect(code).toBe(1);
    const parsed = JSON.parse(out());
    expect(parsed.ok).toBe(false);
    expect(parsed.profile).toBe('production');
  });

  it('does the same for status --json', async () => {
    const hostileStatus = {};
    Object.defineProperty(hostileStatus, 'state', {
      get() {
        throw new Error('state exploded');
      },
      enumerable: true,
    });
    const code = await runCli(
      ['status', '--json'],
      baseOverrides({
        discoverRuntimes: async () => [{ profile: 'production' as ProfileName, root: '/r', version: '1.0.0' }],
        computeDoctorReport: async (p) => report(p),
        serviceManager: async () => ({
          install: async () => hostileStatus as never,
          start: async () => hostileStatus as never,
          stop: async () => hostileStatus as never,
          restart: async () => hostileStatus as never,
          status: async () => hostileStatus as never,
        }),
      }),
    );
    expect(code).toBe(1);
    expect(JSON.parse(out()).profile).toBe('production');
  });

  it('reports a null profile when the failure happened before one was resolved', async () => {
    const code = await runCli(
      ['doctor', '--json'],
      baseOverrides({
        discoverRuntimes: async () => {
          throw new Error('discovery exploded');
        },
      }),
    );
    expect(code).toBe(1);
    expect(JSON.parse(out()).profile).toBeNull();
  });

  it('keeps a successful serialization on exit 0', async () => {
    const code = await runCli(
      ['doctor', '--profile', 'preview', '--json'],
      baseOverrides({ computeDoctorReport: async (p) => report(p) }),
    );
    expect(code).toBe(0);
    expect(JSON.parse(out()).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fix round 2 — N-3: sessions show accepts its key in any position
// ---------------------------------------------------------------------------

describe('sessions show argument order', () => {
  function seedArchives(dataDir: string): void {
    const dir = path.join(dataDir, 'archives');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'sess-abc_1.json'),
      JSON.stringify({
        archivedAt: 1,
        archiveReason: 'idle',
        sessionKey: 'sess-abc',
        ownerId: 'U1',
        channelId: 'C1',
        lastActivity: 'x',
        conversationId: 'conv1',
      }),
    );
    fs.mkdirSync(path.join(dataDir, 'conversations'), { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, 'conversations', 'conv1.json'),
      JSON.stringify({ id: 'conv1', turns: [{ id: 't', role: 'user', timestamp: 1, rawContent: 'hi' }] }),
    );
  }

  const ORDERINGS: ReadonlyArray<[label: string, argv: string[]]> = [
    ['key first', ['sess-abc', '--json', '--conversation']],
    ['flags first', ['--json', 'sess-abc']],
    ['key in the middle', ['--conversation', 'sess-abc', '--json']],
    ['flags split around the key', ['--json', 'sess-abc', '--conversation']],
  ];

  it.each(ORDERINGS)('resolves the key when it appears %s', async (_label, tail) => {
    const dataDir = path.join(home, 'pinned');
    seedArchives(dataDir);
    const code = await runCli(['sessions', 'show', ...tail], baseOverrides({ env: { SOMA_DATA_DIR: dataDir } }));
    expect(code).toBe(0);
    expect(err()).toBe('');
    expect(out()).not.toContain('Session not found');
  });

  it('preserves the requested flags regardless of order', async () => {
    const dataDir = path.join(home, 'pinned2');
    seedArchives(dataDir);
    await runCli(
      ['sessions', 'show', '--conversation', 'sess-abc'],
      baseOverrides({ env: { SOMA_DATA_DIR: dataDir } }),
    );
    expect(out()).toContain('Conversation: 1 turns');

    outChunks = [];
    await runCli(['sessions', 'show', '--json', 'sess-abc'], baseOverrides({ env: { SOMA_DATA_DIR: dataDir } }));
    expect(JSON.parse(out()).sessionKey).toBe('sess-abc');
  });

  it('still reaches the historical usage line when the key is missing', async () => {
    const dataDir = path.join(home, 'pinned3');
    seedArchives(dataDir);
    const code = await runCli(
      ['sessions', 'show', '--json', '--conversation'],
      baseOverrides({ env: { SOMA_DATA_DIR: dataDir } }),
    );
    expect(code).toBe(1);
    expect(err()).toBe('Usage: somawork sessions show <sessionKey> [--conversation] [--json]\n');
  });

  it('normalizes list filters into the handler without changing their meaning', async () => {
    const dataDir = path.join(home, 'pinned4');
    seedArchives(dataDir);
    const code = await runCli(
      ['sessions', 'list', '--json', '--user', 'U1', '--limit', '5'],
      baseOverrides({ env: { SOMA_DATA_DIR: dataDir } }),
    );
    expect(code).toBe(0);
    expect(JSON.parse(out())).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Fix round 2 — N-4: --limit is validated, not coerced
// ---------------------------------------------------------------------------

describe('sessions list --limit validation', () => {
  function seedArchives(dataDir: string, count: number): void {
    const dir = path.join(dataDir, 'archives');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < count; i++) {
      fs.writeFileSync(
        path.join(dir, `k${i}_1.json`),
        JSON.stringify({
          archivedAt: i,
          archiveReason: 'idle',
          sessionKey: `k${i}`,
          ownerId: 'U1',
          channelId: 'C1',
          lastActivity: 'x',
        }),
      );
    }
  }

  const REJECTED = [
    '0',
    '-1',
    '1.5',
    'abc',
    '',
    ' 5',
    '1e5',
    '0x10',
    '+5',
    'Infinity',
    'NaN',
    '10001',
    '99999999999999999999',
  ];

  it.each(REJECTED)('rejects --limit %s with the program prefix and exit 1', async (value) => {
    const dataDir = path.join(home, 'lim');
    seedArchives(dataDir, 3);
    outChunks = [];
    errChunks = [];
    const code = await runCli(
      ['sessions', 'list', '--limit', value],
      baseOverrides({ env: { SOMA_DATA_DIR: dataDir } }),
    );
    expect(code).toBe(1);
    expect(err()).toMatch(/^somawork: /);
    expect(err()).toContain('--limit');
    expect(out()).toBe('');
  });

  it('accepts the boundary values', async () => {
    const dataDir = path.join(home, 'lim2');
    seedArchives(dataDir, 3);
    for (const value of ['1', '10000']) {
      outChunks = [];
      errChunks = [];
      const code = await runCli(
        ['sessions', 'list', '--limit', value, '--json'],
        baseOverrides({ env: { SOMA_DATA_DIR: dataDir } }),
      );
      expect(code, value).toBe(0);
      expect(err(), value).toBe('');
    }
  });

  it('keeps the historical default of 50 when --limit is omitted', async () => {
    const dataDir = path.join(home, 'lim3');
    seedArchives(dataDir, 60);
    const code = await runCli(['sessions', 'list', '--json'], baseOverrides({ env: { SOMA_DATA_DIR: dataDir } }));
    expect(code).toBe(0);
    expect(JSON.parse(out())).toHaveLength(50);
  });

  it('applies the limit it was given', async () => {
    const dataDir = path.join(home, 'lim4');
    seedArchives(dataDir, 10);
    const code = await runCli(
      ['sessions', 'list', '--limit', '3', '--json'],
      baseOverrides({ env: { SOMA_DATA_DIR: dataDir } }),
    );
    expect(code).toBe(0);
    expect(JSON.parse(out())).toHaveLength(3);
  });
});
