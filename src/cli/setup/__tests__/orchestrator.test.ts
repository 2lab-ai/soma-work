import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SYNTHETIC_SLACK_BOT_TOKEN } from '../../../test-utils/slack-token-fixtures';
import type { DoctorReport } from '../../doctor';
import type { ProfileName, RuntimeInstall } from '../../profile';
import { profilePaths } from '../../profile';
import type { ServiceStatus } from '../../service';
import { FakeHost } from '../fake-host';
import type { LlmuxReceipt } from '../llmux';
import type { ProfileReceipt } from '../materialize';
import {
  buildPeerReceipts,
  classifySetupFailure,
  DEFAULT_WORKSPACES_DIRNAME,
  discoverRuntimes,
  isSlackApprovalPendingLine,
  resolveBaseDirectory,
  runSetup,
  SETUP_PENDING_EXIT_CODE,
  SETUP_STEPS,
  type SetupDeps,
  SetupError,
  type SetupWorkspaceFs,
} from '../orchestrator';
import type { SlackCliAuthReceipt } from '../slack-auth';
import { SlackAuthSelectionRequiredError } from '../slack-auth';
import { SlackCaptureTimeoutError } from '../slack-capture';
import { generateCaptureNonce, type SlackProject } from '../slack-manifest';
import { type SetupState, SetupStateStore } from '../state';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'somawork-orch-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const PREVIEW_ROOT = '/opt/homebrew/opt/somawork-preview';
const PRODUCTION_ROOT = '/opt/homebrew/opt/somawork';

function runtime(profile: ProfileName, root: string): RuntimeInstall {
  return { profile, root, version: profile === 'preview' ? '1.2.0-preview.1' : '1.2.0' };
}

function okDoctor(profile: ProfileName): DoctorReport {
  return { profile, ok: true, checks: [{ id: 'llmux', status: 'pass', detail: 'fine' }] };
}

function failedDoctor(profile: ProfileName): DoctorReport {
  return {
    profile,
    ok: false,
    checks: [
      { id: 'llmux', status: 'pass', detail: 'fine' },
      { id: 'slack_bot', status: 'fail', detail: 'the bot credential was rejected' },
    ],
  };
}

function liveStatus(profile: ProfileName): ServiceStatus {
  const paths = profilePaths(home, profile);
  return {
    profile,
    label: paths.serviceLabel,
    state: 'running-launchd',
    manager: 'launchd',
    pid: 4321,
    supervisorPid: 4320,
    registered: true,
    ready: true,
    plistInstalled: true,
    plistPath: path.join(home, 'Library', 'LaunchAgents', `${paths.serviceLabel}.plist`),
    configDir: paths.configDir,
    dataDir: paths.dataDir,
    stateDir: paths.stateDir,
    runtimeRoot: PREVIEW_ROOT,
    logDir: path.join(paths.stateDir, 'logs'),
    pidFile: path.join(paths.dataDir, 'soma-work.pid'),
    readyFile: path.join(paths.dataDir, 'soma-work.ready'),
  };
}

/**
 * A receipt whose endpoint is deliberately NOT llmux's default port: a
 * materializer that hardcodes 3456 passes with the default and fails here.
 */
const LLMUX_ENDPOINT = 'http://localhost:13456';

function llmuxReceipt(): LlmuxReceipt {
  return {
    baseUrl: LLMUX_ENDPOINT,
    install: 'already-installed',
    claudeLoginPerformed: false,
    codexLoginPerformed: false,
    claudeReloginPerformed: false,
    codexReloginPerformed: false,
    restartCount: 1,
    readinessChecks: 1,
    claudeHealthy: 2,
    codexHealthy: 1,
  };
}

function slackAuthReceipt(teamId = 'T0123456789'): SlackCliAuthReceipt {
  return {
    teamId,
    userId: 'U0123456789',
    domain: 'acme',
    accessLevel: 'Workspace',
    hasCustomApiHost: false,
    lastUpdated: '2026-08-25',
    cliVersion: '2.30.0',
    workspaceCount: 1,
    loginPerformed: false,
    instructionCopiedToClipboard: true,
  };
}

function slackProject(profile: ProfileName, teamId: string): SlackProject {
  const stateDir = profilePaths(home, profile).stateDir;
  const root = path.join(stateDir, 'slack-project');
  return {
    profile,
    teamId,
    root,
    manifestPath: path.join(root, 'manifest.json'),
    hooksPath: path.join(root, '.slack', 'hooks.json'),
    devAppsPath: path.join(root, '.slack', 'apps.dev.json'),
    deployedAppsPath: path.join(root, '.slack', 'apps.json'),
    socketPath: path.join(stateDir, 'run', 'slack-capture.sock'),
    captureNonce: generateCaptureNonce(),
    appMapping: null,
  };
}

function profileReceipt(profile: ProfileName, appId = 'A0123456789', teamId = 'T0123456789'): ProfileReceipt {
  const paths = profilePaths(home, profile);
  return {
    profile,
    runtimeVersion: '1.2.0',
    runtimeRoot: profile === 'preview' ? PREVIEW_ROOT : PRODUCTION_ROOT,
    configDir: paths.configDir,
    runtimeEnvFile: path.join(paths.configDir, '.env'),
    configFile: path.join(paths.configDir, 'config.json'),
    promptFile: path.join(paths.configDir, '.system.prompt'),
    runtimeDataDir: path.join(paths.configDir, 'data'),
    dataDir: paths.dataDir,
    stateDir: paths.stateDir,
    baseDirectory: path.join(paths.dataDir, DEFAULT_WORKSPACES_DIRNAME),
    appId,
    teamId,
    serviceEnvFiles: [path.join(paths.configDir, '.env'), path.join(paths.configDir, 'secrets.env')],
  };
}

/** In-memory workspace filesystem that records every mutation it is asked for. */
function memoryWorkspaceFs(seed: Record<string, 'dir' | 'file' | 'symlink'> = {}) {
  const entries = new Map<string, 'dir' | 'file' | 'symlink'>(Object.entries(seed));
  const created: Array<{ target: string; mode: number }> = [];
  const readOnly = new Set<string>();
  const impl: SetupWorkspaceFs = {
    exists: (target) => entries.has(target),
    lstat: (target) => {
      const kind = entries.get(target);
      if (kind === undefined) return null;
      return { isDirectory: kind === 'dir', isFile: kind === 'file', isSymbolicLink: kind === 'symlink' };
    },
    canWrite: (target) => !readOnly.has(target),
    createDir: (target, mode) => {
      created.push({ target, mode });
      entries.set(target, 'dir');
    },
  };
  return { impl, created, entries, readOnly };
}

interface Harness {
  deps: SetupDeps;
  calls: {
    llmux: number;
    slackAuth: Array<string | undefined>;
    slackProject: number;
    capture: number;
    materialize: number;
    doctor: number;
    serviceInstall: number;
    serviceStatus: number;
    prompts: string[];
  };
  store: SetupStateStore;
  workspace: ReturnType<typeof memoryWorkspaceFs>;
  peers: RuntimeInstall[][];
  progressSink: { emit: (line: string) => void } | null;
}

function harness(
  overrides: Partial<SetupDeps> = {},
  opts: { profile?: ProfileName; installed?: RuntimeInstall[] } = {},
) {
  const profile = opts.profile ?? 'preview';
  const installed = opts.installed ?? [runtime('preview', PREVIEW_ROOT)];
  const paths = profilePaths(home, profile);
  const workspace = memoryWorkspaceFs();
  const store = new SetupStateStore({ profile, stateDir: paths.stateDir });
  const peers: RuntimeInstall[][] = [];
  const calls: Harness['calls'] = {
    llmux: 0,
    slackAuth: [],
    slackProject: 0,
    capture: 0,
    materialize: 0,
    doctor: 0,
    serviceInstall: 0,
    serviceStatus: 0,
    prompts: [],
  };
  const captured: { onProgress?: (chunk: string) => void } = {};

  const deps: SetupDeps = {
    host: new FakeHost().stubWhich('slack', '/opt/homebrew/bin/slack'),
    home,
    uid: 501,
    now: () => '2026-08-25T00:00:00.000Z',
    discoverRuntimes: async () => installed,
    prompt: {
      choose: async (question, choices) => {
        calls.prompts.push(question);
        return choices[0].value;
      },
    },
    output: { step: () => {}, info: () => {}, instruction: () => {}, card: () => {} },
    workspaceFs: workspace.impl,
    createStateStore: (p, stateDir) => new SetupStateStore({ profile: p, stateDir }),
    ensureLlmux: async () => {
      calls.llmux += 1;
      return llmuxReceipt();
    },
    ensureSlackCliAuth: async (_host, requestedTeam) => {
      calls.slackAuth.push(requestedTeam);
      return slackAuthReceipt();
    },
    materializeSlackProject: (p, teamId) => {
      calls.slackProject += 1;
      return slackProject(p, teamId);
    },
    captureSlackTokens: async (_host, options) => {
      calls.capture += 1;
      captured.onProgress = options.onProgress as (chunk: string) => void;
      return { appId: 'A0123456789', teamId: options.project.teamId, profile };
    },
    secretSink: () => ({ write: () => {} }),
    readSlackAppMapping: () => ({ appId: 'A0123456789', teamId: 'T0123456789', source: 'dev' }),
    readExistingBaseDirectory: () => null,
    materializeProfile: (input) => {
      calls.materialize += 1;
      const receipt = profileReceipt(input.profile, input.slack.appId, input.slack.teamId);
      return { ...receipt, baseDirectory: input.baseDirectory };
    },
    packagedAssets: () => ({ defaultConfig: { content: '{}' }, systemPrompt: { content: 'prompt' } }),
    runDoctor: async (input) => {
      calls.doctor += 1;
      return okDoctor(input.profile);
    },
    createServiceManager: (input) => {
      peers.push([...input.peers.map((r) => runtime(r.profile, r.runtimeRoot))]);
      return {
        install: async () => {
          calls.serviceInstall += 1;
          return liveStatus(input.receipt.profile);
        },
        status: async () => {
          calls.serviceStatus += 1;
          return liveStatus(input.receipt.profile);
        },
      };
    },
    ...overrides,
  };

  return {
    deps,
    calls,
    store,
    workspace,
    peers,
    progressSink: { emit: (line: string) => captured.onProgress?.(line) },
  };
}

function stepsOf(store: SetupStateStore): string[] {
  return (store.load()?.completedSteps ?? []).map((s) => s.step);
}

// ---------------------------------------------------------------------------
// Runtime discovery
// ---------------------------------------------------------------------------

describe('discoverRuntimes', () => {
  function discoveryFs(roots: Record<string, { entries: string[]; version?: string }>) {
    return {
      realpath: (target: string) => (target in roots ? target : null),
      isDirectory: (target: string) => target in roots,
      isFile: (target: string) => {
        for (const [root, spec] of Object.entries(roots)) {
          if (spec.entries.some((e) => path.join(root, e) === target)) return true;
          if (spec.version !== undefined && path.join(root, 'package.json') === target) return true;
        }
        return false;
      },
      readFile: (target: string) => {
        for (const [root, spec] of Object.entries(roots)) {
          if (path.join(root, 'package.json') === target && spec.version !== undefined) {
            return JSON.stringify({ name: 'somawork', version: spec.version });
          }
        }
        return null;
      },
    };
  }

  const FULL = ['dist/run-with-rotating-logs.js', 'dist/index.js'];

  it('reports a runtime only when brew prefix, entries and version all validate', async () => {
    const host = new FakeHost()
      .stubWhich('brew', '/opt/homebrew/bin/brew')
      .stubCommand('/opt/homebrew/bin/brew --prefix somawork-preview', { code: 0, stdout: `${PREVIEW_ROOT}\n` })
      .stubCommand('/opt/homebrew/bin/brew --prefix somawork', { code: 1, stderr: 'No available formula' });

    const found = await discoverRuntimes({
      host,
      fs: discoveryFs({ [PREVIEW_ROOT]: { entries: FULL, version: '1.2.0-preview.1' } }),
    });

    expect(found).toEqual([{ profile: 'preview', root: PREVIEW_ROOT, version: '1.2.0-preview.1' }]);
  });

  it('rejects a prefix whose immutable runtime entries are missing', async () => {
    const host = new FakeHost()
      .stubWhich('brew', '/opt/homebrew/bin/brew')
      .stubCommand('/opt/homebrew/bin/brew --prefix somawork-preview', { code: 0, stdout: `${PREVIEW_ROOT}\n` })
      .stubCommand('/opt/homebrew/bin/brew --prefix somawork', { code: 1 });

    const found = await discoverRuntimes({
      host,
      // supervisor entry present, daemon entry missing
      fs: discoveryFs({ [PREVIEW_ROOT]: { entries: ['dist/run-with-rotating-logs.js'], version: '1.2.0' } }),
    });

    expect(found).toEqual([]);
  });

  it('rejects malformed brew output (multi-line, relative, or empty)', async () => {
    for (const stdout of ['', '   \n', 'not-a-path\n', `${PREVIEW_ROOT}\n${PRODUCTION_ROOT}\n`]) {
      const host = new FakeHost()
        .stubWhich('brew', '/opt/homebrew/bin/brew')
        .stubCommand('/opt/homebrew/bin/brew --prefix somawork-preview', { code: 0, stdout })
        .stubCommand('/opt/homebrew/bin/brew --prefix somawork', { code: 1 });
      const found = await discoverRuntimes({
        host,
        fs: discoveryFs({ [PREVIEW_ROOT]: { entries: FULL, version: '1.2.0' } }),
      });
      expect(found, `stdout=${JSON.stringify(stdout)}`).toEqual([]);
    }
  });

  it('returns nothing when brew itself is not installed, and never guesses a source checkout', async () => {
    const host = new FakeHost().stubWhich('brew', null);
    const found = await discoverRuntimes({ host, fs: discoveryFs({}) });
    expect(found).toEqual([]);
    expect(host.calls.filter((c) => c.kind === 'command')).toEqual([]);
  });

  it('canonicalises the root through realpath before returning it', async () => {
    const host = new FakeHost()
      .stubWhich('brew', '/opt/homebrew/bin/brew')
      .stubCommand('/opt/homebrew/bin/brew --prefix somawork-preview', {
        code: 0,
        stdout: '/opt/homebrew/Cellar/link\n',
      })
      .stubCommand('/opt/homebrew/bin/brew --prefix somawork', { code: 1 });

    const discovery = discoveryFs({ [PREVIEW_ROOT]: { entries: FULL, version: '9.9.9' } });
    const found = await discoverRuntimes({
      host,
      fs: { ...discovery, realpath: (t) => (t === '/opt/homebrew/Cellar/link' ? PREVIEW_ROOT : discovery.realpath(t)) },
    });

    expect(found).toEqual([{ profile: 'preview', root: PREVIEW_ROOT, version: '9.9.9' }]);
  });

  it('treats an unreadable/malformed package.json as "not an installed runtime"', async () => {
    const host = new FakeHost()
      .stubWhich('brew', '/opt/homebrew/bin/brew')
      .stubCommand('/opt/homebrew/bin/brew --prefix somawork-preview', { code: 0, stdout: `${PREVIEW_ROOT}\n` })
      .stubCommand('/opt/homebrew/bin/brew --prefix somawork', { code: 1 });

    const found = await discoverRuntimes({
      host,
      fs: {
        realpath: (t) => t,
        isDirectory: () => true,
        isFile: () => true,
        readFile: () => '{ this is not json',
      },
    });
    expect(found).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Base directory
// ---------------------------------------------------------------------------

describe('resolveBaseDirectory', () => {
  it('creates the default at exactly 0700 when it is absent', () => {
    const ws = memoryWorkspaceFs();
    const target = path.join('/data', DEFAULT_WORKSPACES_DIRNAME);
    expect(resolveBaseDirectory({ fs: ws.impl, dataDir: '/data' })).toBe(target);
    expect(ws.created).toEqual([{ target, mode: 0o700 }]);
  });

  it('never chmods or re-creates an existing default directory', () => {
    const target = path.join('/data', DEFAULT_WORKSPACES_DIRNAME);
    const ws = memoryWorkspaceFs({ [target]: 'dir' });
    expect(resolveBaseDirectory({ fs: ws.impl, dataDir: '/data' })).toBe(target);
    expect(ws.created).toEqual([]);
  });

  it('never creates or chmods an existing operator-selected directory', () => {
    const ws = memoryWorkspaceFs({ '/Volumes/work': 'dir' });
    expect(resolveBaseDirectory({ fs: ws.impl, dataDir: '/data', selected: '/Volumes/work' })).toBe('/Volumes/work');
    expect(ws.created).toEqual([]);
  });

  it('refuses a selected path that is a file, a symlink, relative, or unwritable', () => {
    const ws = memoryWorkspaceFs({ '/f': 'file', '/l': 'symlink', '/ro': 'dir' });
    ws.readOnly.add('/ro');
    for (const selected of ['/f', '/l', 'relative/dir', '/missing', '/ro']) {
      expect(() => resolveBaseDirectory({ fs: ws.impl, dataDir: '/data', selected }), selected).toThrow(SetupError);
    }
    expect(ws.created).toEqual([]);
  });

  it('refuses when the default path exists as a file or symlink instead of a directory', () => {
    for (const kind of ['file', 'symlink'] as const) {
      const target = path.join('/data', DEFAULT_WORKSPACES_DIRNAME);
      const ws = memoryWorkspaceFs({ [target]: kind });
      expect(() => resolveBaseDirectory({ fs: ws.impl, dataDir: '/data' }), kind).toThrow(SetupError);
      expect(ws.created).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Fresh success
// ---------------------------------------------------------------------------

describe('runSetup — fresh success', () => {
  it('runs every step in order and writes exactly the documented markers', async () => {
    const h = harness();
    const outcome = await runSetup(h.deps);

    expect(outcome).toMatchObject({ status: 'complete', profile: 'preview', appId: 'A0123456789' });
    expect(stepsOf(h.store)).toEqual([...SETUP_STEPS]);
    expect(h.store.load()?.lastError).toBeNull();
  });

  it('asks zero questions when one runtime and one workspace exist', async () => {
    const h = harness();
    await runSetup(h.deps);
    expect(h.calls.prompts).toEqual([]);
  });

  it('creates the default workspaces directory at 0700 and passes it to materialization', async () => {
    const h = harness();
    await runSetup(h.deps);
    const expected = path.join(profilePaths(home, 'preview').dataDir, DEFAULT_WORKSPACES_DIRNAME);
    expect(h.workspace.created).toEqual([{ target: expected, mode: 0o700 }]);
  });

  it('reuses the base directory an existing profile already declares, without creating anything', async () => {
    const h = harness({ readExistingBaseDirectory: () => '/Volumes/work' });
    h.workspace.entries.set('/Volumes/work', 'dir');
    const seen: string[] = [];
    (h.deps as SetupDeps).materializeProfile = (input) => {
      seen.push(input.baseDirectory);
      return { ...profileReceipt(input.profile), baseDirectory: input.baseDirectory };
    };
    await runSetup(h.deps);
    expect(seen).toEqual(['/Volumes/work']);
    expect(h.workspace.created).toEqual([]);
  });

  it('hands the materializer the endpoint `ensureLlmux` reported, not a default', async () => {
    const h = harness();
    const seen: string[] = [];
    (h.deps as SetupDeps).materializeProfile = (input) => {
      seen.push(input.llmuxBaseUrl);
      return { ...profileReceipt(input.profile), baseDirectory: input.baseDirectory };
    };
    await runSetup(h.deps);
    expect(seen).toEqual([LLMUX_ENDPOINT]);
  });

  it('gates service installation behind an all-green doctor', async () => {
    const order: string[] = [];
    const h = harness({
      runDoctor: async (input) => {
        order.push('doctor');
        return okDoctor(input.profile);
      },
    });
    (h.deps as SetupDeps).createServiceManager = (input) => ({
      install: async () => {
        order.push('install');
        return liveStatus(input.receipt.profile);
      },
      status: async () => {
        order.push('status');
        return liveStatus(input.receipt.profile);
      },
    });
    await runSetup(h.deps);
    expect(order).toEqual(['doctor', 'install', 'status']);
  });

  it('revalidates the post-start result without starting a second process', async () => {
    const h = harness();
    await runSetup(h.deps);
    expect(h.calls.serviceInstall).toBe(1);
    expect(h.calls.serviceStatus).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Profile resolution / prompt budget
// ---------------------------------------------------------------------------

describe('runSetup — profile resolution', () => {
  it('infers the single installed profile with zero prompts', async () => {
    const h = harness({}, { profile: 'production', installed: [runtime('production', PRODUCTION_ROOT)] });
    const outcome = await runSetup(h.deps);
    expect(outcome.profile).toBe('production');
    expect(h.calls.prompts).toEqual([]);
  });

  it('asks exactly one choice when both runtimes are installed', async () => {
    const h = harness({}, { installed: [runtime('preview', PREVIEW_ROOT), runtime('production', PRODUCTION_ROOT)] });
    await runSetup(h.deps);
    expect(h.calls.prompts).toHaveLength(1);
  });

  it('asks nothing when both are installed but --profile was given', async () => {
    const h = harness(
      { requestedProfile: 'production' },
      { profile: 'production', installed: [runtime('preview', PREVIEW_ROOT), runtime('production', PRODUCTION_ROOT)] },
    );
    const outcome = await runSetup(h.deps);
    expect(outcome.profile).toBe('production');
    expect(h.calls.prompts).toEqual([]);
  });

  it('fails with install guidance and touches nothing when no runtime is installed', async () => {
    const h = harness({ discoverRuntimes: async () => [] });
    await expect(runSetup(h.deps)).rejects.toThrow(/install/i);
    expect(h.calls.llmux).toBe(0);
    expect(h.workspace.created).toEqual([]);
  });

  it('refuses an explicit profile whose runtime is not installed', async () => {
    const h = harness({ requestedProfile: 'production' }, { installed: [runtime('preview', PREVIEW_ROOT)] });
    await expect(runSetup(h.deps)).rejects.toThrow(SetupError);
  });

  it('wires every other installed runtime in as a service collision peer', async () => {
    const h = harness({}, { installed: [runtime('preview', PREVIEW_ROOT), runtime('production', PRODUCTION_ROOT)] });
    await runSetup(h.deps);
    expect(h.peers).toHaveLength(1);
    expect(h.peers[0].map((r) => r.profile)).toEqual(['production']);
  });

  it('canonicalises peer roots from discovery rather than re-deriving them', () => {
    const peers = buildPeerReceipts({
      home,
      profile: 'preview',
      runtimes: [runtime('preview', PREVIEW_ROOT), runtime('production', PRODUCTION_ROOT)],
    });
    expect(peers.map((p) => [p.profile, p.runtimeRoot])).toEqual([['production', PRODUCTION_ROOT]]);
    const prodPaths = profilePaths(home, 'production');
    expect(peers[0].configDir).toBe(prodPaths.configDir);
    expect(peers[0].dataDir).toBe(prodPaths.dataDir);
    expect(peers[0].stateDir).toBe(prodPaths.stateDir);
  });
});

// ---------------------------------------------------------------------------
// Resume — markers are advisory
// ---------------------------------------------------------------------------

describe('runSetup — resume', () => {
  it('is byte-identical whether or not --resume was typed', async () => {
    const seed: SetupState = {
      schemaVersion: 1,
      profile: 'preview',
      currentStep: 'slack_app',
      slackAppId: null,
      slackTeamId: 'T0123456789',
      completedSteps: SETUP_STEPS.slice(0, 3).map((step) => ({ step, completedAt: '2026-01-01T00:00:00.000Z' })),
      lastError: 'slack_app: SlackCaptureTimeoutError',
    };

    async function once(resume: boolean) {
      fs.rmSync(home, { recursive: true, force: true });
      home = fs.mkdtempSync(path.join(os.tmpdir(), 'somawork-orch-'));
      new SetupStateStore({ profile: 'preview', stateDir: profilePaths(home, 'preview').stateDir }).save(seed);
      const h = harness(resume ? { resume: true } : {});
      const outcome = await runSetup(h.deps);
      // The temp home differs per run; normalise it so the comparison is about
      // behaviour rather than about `mkdtemp`'s suffix.
      const normalise = (value: unknown) => JSON.parse(JSON.stringify(value).split(home).join('<HOME>'));
      return {
        outcome: normalise(outcome),
        calls: h.calls,
        steps: stepsOf(h.store),
        state: normalise(h.store.load()),
      };
    }

    const plain = await once(false);
    const resumed = await once(true);
    expect(resumed.outcome).toEqual(plain.outcome);
    expect(resumed.calls).toEqual(plain.calls);
    expect(resumed.steps).toEqual(plain.steps);
    expect(resumed.state).toEqual(plain.state);
  });

  it('re-runs every live check even when all markers are already complete', async () => {
    const paths = profilePaths(home, 'preview');
    const store = new SetupStateStore({ profile: 'preview', stateDir: paths.stateDir });
    store.save({
      schemaVersion: 1,
      profile: 'preview',
      currentStep: null,
      slackAppId: 'A0123456789',
      slackTeamId: 'T0123456789',
      completedSteps: SETUP_STEPS.map((step) => ({ step, completedAt: '2026-01-01T00:00:00.000Z' })),
      lastError: null,
    });

    const h = harness();
    await runSetup(h.deps);

    expect(h.calls.llmux).toBe(1);
    expect(h.calls.slackAuth).toHaveLength(1);
    expect(h.calls.doctor).toBe(1);
    expect(h.calls.serviceInstall).toBe(1);
  });

  it('truncates later markers when an earlier step re-runs and a later one fails', async () => {
    const paths = profilePaths(home, 'preview');
    const store = new SetupStateStore({ profile: 'preview', stateDir: paths.stateDir });
    store.save({
      schemaVersion: 1,
      profile: 'preview',
      currentStep: null,
      slackAppId: 'A0123456789',
      slackTeamId: 'T0123456789',
      completedSteps: SETUP_STEPS.map((step) => ({ step, completedAt: '2026-01-01T00:00:00.000Z' })),
      lastError: null,
    });

    const h = harness({ runDoctor: async (input) => failedDoctor(input.profile) });
    await expect(runSetup(h.deps)).rejects.toThrow(SetupError);

    // Everything up to and including `profile` is real; `doctor` and everything
    // after it must be gone rather than carried forward as false success.
    expect(stepsOf(h.store)).toEqual(['inspect', 'llmux', 'slack_cli_auth', 'slack_app', 'profile']);
  });

  it('reuses the persisted team id so a resume never re-picks a workspace', async () => {
    const paths = profilePaths(home, 'preview');
    new SetupStateStore({ profile: 'preview', stateDir: paths.stateDir }).save({
      schemaVersion: 1,
      profile: 'preview',
      currentStep: 'slack_app',
      slackAppId: null,
      slackTeamId: 'T9999999999',
      completedSteps: [{ step: 'inspect', completedAt: '2026-01-01T00:00:00.000Z' }],
      lastError: null,
    });
    const h = harness();
    await runSetup(h.deps);
    expect(h.calls.slackAuth).toEqual(['T9999999999']);
  });

  it('discards persisted state that belongs to another profile', async () => {
    const paths = profilePaths(home, 'preview');
    fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(paths.stateDir, 'setup-state.json'),
      JSON.stringify({
        schemaVersion: 1,
        profile: 'production',
        currentStep: null,
        slackAppId: 'A7777777777',
        slackTeamId: 'T7777777777',
        completedSteps: [],
        lastError: null,
      }),
      { mode: 0o600 },
    );
    const h = harness();
    await runSetup(h.deps);
    expect(h.calls.slackAuth).toEqual([undefined]);
    expect(h.store.load()?.profile).toBe('preview');
  });

  it('resumes at each boundary, completing from any prefix of the step list', async () => {
    for (let cut = 0; cut < SETUP_STEPS.length; cut++) {
      fs.rmSync(home, { recursive: true, force: true });
      home = fs.mkdtempSync(path.join(os.tmpdir(), 'somawork-orch-'));
      const paths = profilePaths(home, 'preview');
      new SetupStateStore({ profile: 'preview', stateDir: paths.stateDir }).save({
        schemaVersion: 1,
        profile: 'preview',
        currentStep: SETUP_STEPS[cut],
        slackAppId: cut >= 4 ? 'A0123456789' : null,
        slackTeamId: cut >= 3 ? 'T0123456789' : null,
        completedSteps: SETUP_STEPS.slice(0, cut).map((step) => ({ step, completedAt: '2026-01-01T00:00:00.000Z' })),
        lastError: 'llmux: LlmuxUnhealthyError',
      });
      const h = harness();
      const outcome = await runSetup(h.deps);
      expect(outcome.status, `cut=${cut}`).toBe('complete');
      expect(stepsOf(h.store), `cut=${cut}`).toEqual([...SETUP_STEPS]);
      expect(h.store.load()?.lastError, `cut=${cut}`).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Slack workspace selection
// ---------------------------------------------------------------------------

describe('runSetup — Slack workspace selection', () => {
  it('asks exactly once and retries with the chosen team', async () => {
    let attempt = 0;
    const h = harness({
      ensureSlackCliAuth: async (_host, requestedTeam) => {
        attempt += 1;
        if (requestedTeam === undefined) {
          throw new SlackAuthSelectionRequiredError(
            'more than one workspace is authorized',
            [
              { teamId: 'T1111111111', domain: 'alpha' },
              { teamId: 'T2222222222', domain: 'beta' },
            ],
            false,
          );
        }
        return slackAuthReceipt(requestedTeam);
      },
      prompt: {
        choose: async (_q, choices) => choices[1].value,
      },
    });

    const outcome = await runSetup(h.deps);
    expect(attempt).toBe(2);
    expect(outcome.teamId).toBe('T2222222222');
  });

  it('never asks twice for the same ambiguity', async () => {
    const asked: string[] = [];
    const h = harness({
      ensureSlackCliAuth: async () => {
        throw new SlackAuthSelectionRequiredError(
          'ambiguous',
          [
            { teamId: 'T1111111111', domain: 'alpha' },
            { teamId: 'T2222222222', domain: 'beta' },
          ],
          false,
        );
      },
      prompt: {
        choose: async (q, choices) => {
          asked.push(q);
          return choices[0].value;
        },
      },
    });
    await expect(runSetup(h.deps)).rejects.toThrow(SetupError);
    expect(asked).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Pending Slack admin approval
// ---------------------------------------------------------------------------

describe('runSetup — pending Slack admin approval', () => {
  it('recognises the Slack CLI approval notices and nothing else', () => {
    expect(isSlackApprovalPendingLine('This app requires admin approval before it can be installed')).toBe(true);
    expect(isSlackApprovalPendingLine('  Your request is pending admin approval  ')).toBe(true);
    expect(isSlackApprovalPendingLine('Connected, awaiting approval from a workspace admin')).toBe(true);
    expect(isSlackApprovalPendingLine('Installed successfully')).toBe(false);
    expect(isSlackApprovalPendingLine('approval')).toBe(false);
  });

  it('returns a resumable non-error terminal status carrying only app/team ids', async () => {
    const h = harness({
      captureSlackTokens: async (_host, options) => {
        (options.onProgress as (c: string) => void)('This app requires admin approval before it can be installed.');
        throw new SlackCaptureTimeoutError('capture timed out');
      },
    });

    const outcome = await runSetup(h.deps);
    expect(outcome).toEqual({
      status: 'pending-slack-approval',
      profile: 'preview',
      appId: 'A0123456789',
      teamId: 'T0123456789',
      step: 'slack_app',
    });
    expect(SETUP_PENDING_EXIT_CODE).toBe(75);
  });

  it('persists the ids and stops before profile materialization', async () => {
    const h = harness({
      captureSlackTokens: async (_host, options) => {
        (options.onProgress as (c: string) => void)('pending admin approval');
        throw new SlackCaptureTimeoutError('capture timed out');
      },
    });
    await runSetup(h.deps);
    const state = h.store.load();
    expect(state?.slackAppId).toBe('A0123456789');
    expect(state?.slackTeamId).toBe('T0123456789');
    expect(state?.currentStep).toBe('slack_app');
    expect(stepsOf(h.store)).toEqual(['inspect', 'llmux', 'slack_cli_auth']);
    expect(h.calls.materialize).toBe(0);
    expect(h.calls.serviceInstall).toBe(0);
  });

  it('does not create a second app on the resume after approval', async () => {
    const h = harness({
      captureSlackTokens: async (_host, options) => {
        (options.onProgress as (c: string) => void)('pending admin approval');
        throw new SlackCaptureTimeoutError('capture timed out');
      },
    });
    await runSetup(h.deps);

    const second = harness();
    const outcome = await runSetup(second.deps);
    expect(outcome.status).toBe('complete');
    expect(second.calls.slackProject).toBe(1);
    expect(second.calls.capture).toBe(1);
  });

  it('keeps a capture timeout WITHOUT an approval notice an error that retains the ids', async () => {
    const h = harness({
      captureSlackTokens: async () => {
        throw new SlackCaptureTimeoutError('capture timed out');
      },
    });
    await expect(runSetup(h.deps)).rejects.toThrow(SetupError);
    const state = h.store.load();
    expect(state?.slackTeamId).toBe('T0123456789');
    expect(state?.slackAppId).toBe('A0123456789');
    expect(state?.lastError).toBe('slack_app: SlackCaptureTimeoutError');
  });
});

// ---------------------------------------------------------------------------
// Cancellation / failure
// ---------------------------------------------------------------------------

describe('runSetup — failures', () => {
  it('records only a fixed, classified summary in lastError', async () => {
    const leaky = new Error('llmux said xoxb-1111-2222-abcdefghijklmnop at http://localhost:3456/admin?key=deadbeef');
    leaky.name = 'LlmuxUnhealthyError';
    const h = harness({
      ensureLlmux: async () => {
        throw leaky;
      },
    });
    await expect(runSetup(h.deps)).rejects.toThrow();
    const state = h.store.load();
    expect(state?.lastError).toBe('llmux: LlmuxUnhealthyError');
    expect(JSON.stringify(state)).not.toContain('xoxb-');
    expect(JSON.stringify(state)).not.toContain('localhost');
  });

  it('classifies an error whose name is attacker-controlled to a safe constant', () => {
    const weird = new Error('boom');
    (weird as { name: string }).name = 'xoxb-1111-2222/../../etc/passwd';
    expect(classifySetupFailure('doctor', weird)).toBe('doctor: Error');
    expect(classifySetupFailure('doctor', 'a raw string')).toBe('doctor: Error');
  });

  it('leaves an OAuth cancellation resumable at the same step', async () => {
    const cancelled = new Error('cancelled');
    cancelled.name = 'LlmuxCancelledError';
    const h = harness({
      ensureLlmux: async () => {
        throw cancelled;
      },
    });
    await expect(runSetup(h.deps)).rejects.toThrow(SetupError);
    expect(h.store.load()?.currentStep).toBe('llmux');
    expect(stepsOf(h.store)).toEqual(['inspect']);

    const resumed = harness();
    expect((await runSetup(resumed.deps)).status).toBe('complete');
  });

  it('does not mark the service step when installation rolls back', async () => {
    const boom = new Error('post-start doctor failed');
    boom.name = 'ServiceError';
    const h = harness();
    (h.deps as SetupDeps).createServiceManager = () => ({
      install: async () => {
        throw boom;
      },
      status: async () => {
        throw new Error('status must not be probed after a failed install');
      },
    });
    await expect(runSetup(h.deps)).rejects.toThrow(SetupError);
    expect(stepsOf(h.store)).toEqual(['inspect', 'llmux', 'slack_cli_auth', 'slack_app', 'profile', 'doctor']);
    expect(h.store.load()?.lastError).toBe('service: ServiceError');
  });

  it('does not mark post_start_doctor when the fresh status is not ready', async () => {
    const h = harness();
    (h.deps as SetupDeps).createServiceManager = (input) => ({
      install: async () => liveStatus(input.receipt.profile),
      status: async () => ({ ...liveStatus(input.receipt.profile), ready: false, state: 'stale' }),
    });
    await expect(runSetup(h.deps)).rejects.toThrow(SetupError);
    expect(stepsOf(h.store)).not.toContain('post_start_doctor');
  });

  it('never writes a credential-shaped byte into setup state', async () => {
    const h = harness({
      captureSlackTokens: async () => ({
        appId: 'A0123456789',
        teamId: 'T0123456789',
        profile: 'preview' as ProfileName,
      }),
    });
    await runSetup(h.deps);
    const raw = fs.readFileSync(h.store.filePath, 'utf-8');
    expect(raw).not.toMatch(/xox[abeprs]-|xapp-|sk-ant-/);
  });
});

// ---------------------------------------------------------------------------
// I-5 — an unusable advisory state file must not brick setup
// ---------------------------------------------------------------------------

describe('runSetup — unusable setup state is quarantined, not fatal', () => {
  const stateFileOf = (profile: ProfileName = 'preview') =>
    path.join(profilePaths(home, profile).stateDir, 'setup-state.json');

  /** Write raw bytes to the live state file and/or its backup. */
  function plant(live: string | null, backup: string | null): string {
    const file = stateFileOf();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (live !== null) fs.writeFileSync(file, live, { mode: 0o600 });
    if (backup !== null) fs.writeFileSync(`${file}.bak`, backup, { mode: 0o600 });
    return file;
  }

  const quarantinedSiblings = (file: string): string[] =>
    fs
      .readdirSync(path.dirname(file))
      .filter((name) => name.startsWith(`${path.basename(file)}`) && name.includes('.corrupt-'))
      .sort();

  const FUTURE_SCHEMA = `${JSON.stringify({
    schemaVersion: 2,
    profile: 'preview',
    currentStep: null,
    slackAppId: null,
    slackTeamId: null,
    completedSteps: [],
    lastError: null,
  })}\n`;

  const CREDENTIAL_SHAPED = `${JSON.stringify({
    schemaVersion: 1,
    profile: 'preview',
    currentStep: null,
    slackAppId: null,
    slackTeamId: null,
    completedSteps: [],
    lastError: `invalid_auth token=${SYNTHETIC_SLACK_BOT_TOKEN}`,
  })}\n`;

  const cases: Array<[string, string | null, string | null]> = [
    ['a truncated live file with a truncated backup', '{not json, truncated', '{also truncated'],
    ['a truncated live file with no backup at all', '{not json, truncated', null],
    ['a future schema version in both files', FUTURE_SCHEMA, FUTURE_SCHEMA],
    ['a future schema version with no backup', FUTURE_SCHEMA, null],
    ['a credential-shaped state document', CREDENTIAL_SHAPED, CREDENTIAL_SHAPED],
  ];

  it.each(cases)('completes setup despite %s', async (_name, live, backup) => {
    const file = plant(live, backup);
    const h = harness();

    const outcome = await runSetup(h.deps);

    expect(outcome).toMatchObject({ status: 'complete', profile: 'preview' });
    expect(stepsOf(h.store)).toEqual([...SETUP_STEPS]);
    // The unusable documents are out of the load path but still on disk.
    expect(quarantinedSiblings(file).length).toBe(backup === null ? 1 : 2);
  });

  it('says so exactly once, naming the quarantined path and no state bytes', async () => {
    const file = plant(CREDENTIAL_SHAPED, CREDENTIAL_SHAPED);
    const info: string[] = [];
    const h = harness({
      output: { step: () => {}, info: (line: string) => info.push(line), instruction: () => {}, card: () => {} },
    });

    await runSetup(h.deps);

    const lines = info.filter((line) => line.includes('.corrupt-'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(path.basename(file));
    // Never the bytes: not the credential, not the raw document, not the
    // underlying parser complaint.
    expect(info.join('\n')).not.toContain('xoxb-');
    expect(info.join('\n')).not.toContain('invalid_auth');
    expect(info.join('\n')).not.toContain('schemaVersion');
  });

  it('keeps the quarantined bytes readable for diagnosis and never overwrites evidence', async () => {
    const file = plant(CREDENTIAL_SHAPED, null);
    await runSetup(harness().deps);
    const first = quarantinedSiblings(file);
    expect(first).toHaveLength(1);
    const preserved = fs.readFileSync(path.join(path.dirname(file), first[0]), 'utf-8');
    expect(preserved).toBe(CREDENTIAL_SHAPED);
    expect(fs.statSync(path.join(path.dirname(file), first[0])).mode & 0o777).toBe(0o600);

    // Same corruption again: the deterministic name means the evidence is not
    // duplicated, and — crucially — the second run is not blocked either.
    fs.rmSync(file, { force: true });
    fs.rmSync(`${file}.bak`, { force: true });
    plant(CREDENTIAL_SHAPED, null);
    const second = await runSetup(harness().deps);
    expect(second).toMatchObject({ status: 'complete' });
    expect(quarantinedSiblings(file)).toEqual(first);
    expect(fs.readFileSync(path.join(path.dirname(file), first[0]), 'utf-8')).toBe(CREDENTIAL_SHAPED);

    // A *different* corruption gets its own slot rather than replacing it.
    // (The run above left a VALID `.bak`; leaving it would be recovered from
    // rather than quarantined, which is the correct behaviour and not what
    // this assertion is about.)
    fs.rmSync(`${file}.bak`, { force: true });
    plant('{different garbage', null);
    await runSetup(harness().deps);
    expect(quarantinedSiblings(file)).toHaveLength(2);
  });

  it('still recovers from a good backup rather than quarantining anything', async () => {
    const file = stateFileOf();
    const store = new SetupStateStore({ profile: 'preview', stateDir: path.dirname(file) });
    store.save({
      schemaVersion: 1,
      profile: 'preview',
      currentStep: 'llmux',
      slackAppId: null,
      slackTeamId: 'T0123456789',
      completedSteps: [{ step: 'inspect', completedAt: '2026-01-01T00:00:00.000Z' }],
      lastError: null,
    });
    store.save({
      schemaVersion: 1,
      profile: 'preview',
      currentStep: 'llmux',
      slackAppId: null,
      slackTeamId: 'T0123456789',
      completedSteps: [{ step: 'inspect', completedAt: '2026-01-01T00:00:00.000Z' }],
      lastError: null,
    });
    fs.writeFileSync(file, '{truncated by a crash');

    const info: string[] = [];
    const h = harness({
      output: { step: () => {}, info: (line: string) => info.push(line), instruction: () => {}, card: () => {} },
    });
    await runSetup(h.deps);

    expect(quarantinedSiblings(file)).toEqual([]);
    expect(info.some((line) => line.includes('.corrupt-'))).toBe(false);
  });

  it('says nothing when there is no state file at all', async () => {
    const info: string[] = [];
    const h = harness({
      output: { step: () => {}, info: (line: string) => info.push(line), instruction: () => {}, card: () => {} },
    });
    await runSetup(h.deps);
    expect(info.some((line) => line.includes('.corrupt-'))).toBe(false);
    expect(quarantinedSiblings(stateFileOf())).toEqual([]);
  });

  it('does not swallow an unrelated I/O failure from the state store', async () => {
    const boom = new Error('EACCES: permission denied');
    boom.name = 'Error';
    const h = harness({
      createStateStore: (profile, stateDir) => {
        const store = new SetupStateStore({ profile, stateDir });
        return Object.assign(store, {
          load: () => {
            throw boom;
          },
        });
      },
    });

    await expect(runSetup(h.deps)).rejects.toBe(boom);
  });
});
