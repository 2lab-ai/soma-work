/**
 * Task 8 RED — secret-safe `somawork doctor`.
 *
 * Every seam is injected, so these are true behaviour tests: the socket probe
 * really returns a sentinel `wss://` URL and the assertions prove it never
 * reaches the report, the JSON, or a console sink.
 */

import dotenv from 'dotenv';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDefaultDoctorDeps,
  createNodeDoctorFileSystem,
  DEFAULT_LLMUX_BASE_URL,
  DOCTOR_CHECK_IDS,
  type DoctorDeps,
  type DoctorReport,
  doctorReportToJson,
  LlmuxEndpointError,
  openSlackSocketProbe,
  resolveLlmuxBaseUrl,
  runDoctor,
  SLACK_CONNECTIONS_OPEN_URL,
} from '../doctor';
import { type ProfilePaths, profilePaths, type RuntimeInstall } from '../profile';
import { materializeProfile } from '../setup/materialize';
import { SecretStore } from '../setup/secrets';
import { assertSecretFree } from '../setup/state';

/** The app-token probe response really does carry a live socket URL. */
const SENTINEL_WSS = 'wss://wss-primary.slack.com/link/?ticket=SENTINEL-TICKET-VALUE';
const BOT_TOKEN = 'xoxb-doctor-sentinel-bot';
const APP_TOKEN = 'xapp-doctor-sentinel-app';

const PACKAGED_CONFIG = JSON.stringify({ ui: { threadheader: { lines: [] } } });
const PACKAGED_PROMPT = '# prompt\n';

function healthyLlmuxDocument(): unknown {
  return {
    current: 'acct-one',
    accounts: [
      { name: 'acct-one', type: 'oauth', group: 'claude', status: 'active', order: 1 },
      { name: 'acct-two', type: 'codex', group: 'codex', status: 'ok', order: 2 },
    ],
  };
}

describe('runDoctor', () => {
  let home: string;
  let runtimeRoot: string;
  let baseDirectory: string;
  let paths: ProfilePaths;
  let runtime: RuntimeInstall;
  let deps: DoctorDeps;
  let openedSockets: string[];
  let consoleSpies: Array<{ restore: () => void }>;
  let consoleOutput: string[];

  function makeDeps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
    const store = new SecretStore({ secretsFile: paths.secretsFile });
    return {
      paths,
      runtime,
      baseDirectory,
      uid: os.userInfo().uid,
      runtimeAssets: [{ path: path.join('dist', 'index.js'), required: true }],
      fs: createNodeDoctorFileSystem(),
      readSecrets: () => store.read(),
      probeSlackBot: async () => ({ ok: true, fatalAuth: false }),
      openSlackSocket: async (token: string) => {
        openedSockets.push(token);
        // The real Slack response body includes `url`; the seam must reduce it.
        return { ok: true };
      },
      fetchLlmuxStatus: async () => healthyLlmuxDocument(),
      loadConfigFile: () => ({ loaded: true, missing: [] }),
      ...overrides,
    };
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-test-'));
    runtimeRoot = path.join(home, 'runtime');
    baseDirectory = path.join(home, 'Code');
    fs.mkdirSync(path.join(runtimeRoot, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(runtimeRoot, 'dist', 'index.js'), '// entry\n');
    fs.mkdirSync(baseDirectory, { recursive: true });
    paths = profilePaths(home, 'preview');
    runtime = { profile: 'preview', root: runtimeRoot, version: '1.2.3' };

    new SecretStore({ secretsFile: paths.secretsFile }).write({
      SLACK_BOT_TOKEN: BOT_TOKEN,
      SLACK_APP_TOKEN: APP_TOKEN,
    });
    materializeProfile({
      profile: 'preview',
      paths,
      runtime,
      baseDirectory,
      slack: { appId: 'A0123456789', teamId: 'T0123456789' },
      defaultConfig: { content: PACKAGED_CONFIG },
      systemPrompt: { content: PACKAGED_PROMPT },
    });

    openedSockets = [];
    consoleOutput = [];
    consoleSpies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((method) => {
      const spy = vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        consoleOutput.push(args.map((a) => String(a)).join(' '));
      });
      return { restore: () => spy.mockRestore() };
    });
    deps = makeDeps();
  });

  afterEach(() => {
    for (const spy of consoleSpies) spy.restore();
    fs.rmSync(home, { recursive: true, force: true });
  });

  // ------------------------------------------------------------------ shape

  it('reports exactly the nine stable check ids in a fixed order', async () => {
    const report = await runDoctor('preview', deps);
    expect(report.checks.map((c) => c.id)).toEqual([
      'llmux',
      'llmux_claude',
      'llmux_codex',
      'slack_bot',
      'slack_socket',
      'base_directory',
      'profile_permissions',
      'runtime',
      'config',
    ]);
    expect(DOCTOR_CHECK_IDS).toEqual(report.checks.map((c) => c.id));
  });

  it('uses check ids the setup-state secret gate accepts as field names', () => {
    for (const id of DOCTOR_CHECK_IDS) {
      expect(id).not.toMatch(/auth|token|secret/);
      // Mechanized, not eyeballed: the id has to survive the same gate that
      // guards persisted setup state, since Task 10 records these verbatim.
      expect(() => assertSecretFree({ [id]: 'pass' })).not.toThrow();
    }
    // Mutation check — the gate above is live, not vacuous.
    expect(() => assertSecretFree({ slack_bot_token: 'pass' })).toThrow();
    expect(() => assertSecretFree({ llmux_auth: 'pass' })).toThrow();
  });

  it('passes every check and reports ok on a fully materialized healthy profile', async () => {
    const report = await runDoctor('preview', deps);
    expect(report.checks.filter((c) => c.status !== 'pass')).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.profile).toBe('preview');
  });

  it('emits only pass, warn or fail statuses', async () => {
    const report = await runDoctor('preview', deps);
    for (const check of report.checks) {
      expect(['pass', 'warn', 'fail']).toContain(check.status);
    }
  });

  // ------------------------------------------------------------------ llmux

  it('fails the llmux checks — but still runs them all — when the daemon is unreachable', async () => {
    const report = await runDoctor(
      'preview',
      makeDeps({
        fetchLlmuxStatus: async () => {
          throw new Error(`llmux unreachable at http://localhost:3456 (token=${BOT_TOKEN})`);
        },
      }),
    );
    expect(statusOf(report, 'llmux')).toBe('fail');
    expect(statusOf(report, 'llmux_claude')).toBe('fail');
    expect(statusOf(report, 'llmux_codex')).toBe('fail');
    expect(statusOf(report, 'config')).toBe('pass');
    expect(report.ok).toBe(false);
    expect(JSON.stringify(report)).not.toContain(BOT_TOKEN);
  });

  it('fails llmux when the daemon returns a malformed document', async () => {
    const report = await runDoctor('preview', makeDeps({ fetchLlmuxStatus: async () => ({ nope: true }) }));
    expect(statusOf(report, 'llmux')).toBe('fail');
    expect(report.ok).toBe(false);
  });

  it('fails the group check when a required account group is absent', async () => {
    const report = await runDoctor(
      'preview',
      makeDeps({
        fetchLlmuxStatus: async () => ({
          current: 'acct-one',
          accounts: [{ name: 'acct-one', type: 'oauth', group: 'claude', status: 'active', order: 1 }],
        }),
      }),
    );
    expect(statusOf(report, 'llmux')).toBe('pass');
    expect(statusOf(report, 'llmux_claude')).toBe('pass');
    expect(statusOf(report, 'llmux_codex')).toBe('fail');
  });

  it('fails a cooldown group with a fixed detail and no account names', async () => {
    const report = await runDoctor(
      'preview',
      makeDeps({
        fetchLlmuxStatus: async () => ({
          current: 'secret-account-name',
          accounts: [
            { name: 'secret-account-name', type: 'oauth', group: 'claude', status: 'cooldown', order: 1 },
            { name: 'other-account', type: 'codex', group: 'codex', status: 'ok', order: 2 },
          ],
        }),
      }),
    );
    expect(statusOf(report, 'llmux_claude')).toBe('fail');
    expect(detailOf(report, 'llmux_claude')).toMatch(/rate-limited|cooldown/i);
    expect(JSON.stringify(report)).not.toContain('secret-account-name');
    expect(JSON.stringify(report)).not.toContain('other-account');
  });

  it('fails an auth_failed group with a fixed re-authentication detail', async () => {
    const report = await runDoctor(
      'preview',
      makeDeps({
        fetchLlmuxStatus: async () => ({
          current: null,
          accounts: [
            { name: 'a', type: 'oauth', group: 'claude', status: 'auth_failed', order: 1 },
            { name: 'b', type: 'codex', group: 'codex', status: 'ok', order: 2 },
          ],
        }),
      }),
    );
    expect(statusOf(report, 'llmux_claude')).toBe('fail');
    expect(report.ok).toBe(false);
  });

  // ------------------------------------------------------------- slack bot

  it('fails slack_bot on a fatal credential rejection without echoing the API message', async () => {
    const report = await runDoctor(
      'preview',
      makeDeps({
        probeSlackBot: async () => ({ ok: false, fatalAuth: true }),
      }),
    );
    expect(statusOf(report, 'slack_bot')).toBe('fail');
    expect(report.ok).toBe(false);
  });

  it('fails slack_bot when a transient failure is exhausted, since the check is mandatory', async () => {
    const report = await runDoctor(
      'preview',
      makeDeps({ probeSlackBot: async () => ({ ok: false, fatalAuth: false }) }),
    );
    expect(statusOf(report, 'slack_bot')).toBe('fail');
    expect(detailOf(report, 'slack_bot')).toMatch(/unavailable/i);
    expect(report.ok).toBe(false);
  });

  it('fails slack_bot when the bot credential is missing from the store', async () => {
    const report = await runDoctor('preview', makeDeps({ readSecrets: () => ({ SLACK_APP_TOKEN: APP_TOKEN }) }));
    expect(statusOf(report, 'slack_bot')).toBe('fail');
    expect(statusOf(report, 'slack_socket')).toBe('pass');
  });

  it('fails slack_bot when the stored bot credential has the wrong prefix', async () => {
    const report = await runDoctor(
      'preview',
      makeDeps({ readSecrets: () => ({ SLACK_BOT_TOKEN: 'nope', SLACK_APP_TOKEN: APP_TOKEN }) }),
    );
    expect(statusOf(report, 'slack_bot')).toBe('fail');
  });

  it('passes the real credential to the bot probe and keeps it out of the report', async () => {
    const seen: string[] = [];
    const report = await runDoctor(
      'preview',
      makeDeps({
        probeSlackBot: async (token: string) => {
          seen.push(token);
          return { ok: true, fatalAuth: false };
        },
      }),
    );
    expect(seen).toEqual([BOT_TOKEN]);
    expect(JSON.stringify(report)).not.toContain(BOT_TOKEN);
  });

  // ------------------------------------------------------------ slack socket

  it('opens the socket probe with the app-level credential', async () => {
    await runDoctor('preview', deps);
    expect(openedSockets).toEqual([APP_TOKEN]);
  });

  it('never lets a returned wss URL reach the report, its JSON, or the console', async () => {
    const leaky: DoctorDeps = makeDeps({
      openSlackSocket: async () => {
        // A seam that (incorrectly) leaked would hand this back; the core must
        // consume `{ ok }` only, so the sentinel has no path to the report.
        const response = { ok: true, url: SENTINEL_WSS } as { ok: boolean; url?: string };
        return { ok: response.ok };
      },
    });
    const report = await runDoctor('preview', leaky);
    const json = doctorReportToJson(report);
    expect(statusOf(report, 'slack_socket')).toBe('pass');
    expect(JSON.stringify(report)).not.toContain('wss://');
    expect(JSON.stringify(report)).not.toContain('SENTINEL-TICKET-VALUE');
    expect(json).not.toContain('wss://');
    expect(json).not.toContain('SENTINEL-TICKET-VALUE');
    expect(consoleOutput.join('\n')).not.toContain('SENTINEL-TICKET-VALUE');
  });

  it('fails slack_socket and says rejected only when Slack itself rejected the credential', async () => {
    const report = await runDoctor(
      'preview',
      makeDeps({ openSlackSocket: async () => ({ ok: false, reason: 'rejected' as const }) }),
    );
    expect(statusOf(report, 'slack_socket')).toBe('fail');
    expect(detailOf(report, 'slack_socket')).toMatch(/rejected/);
    expect(report.ok).toBe(false);
  });

  it('fails slack_socket WITHOUT claiming rejection when the endpoint was merely unavailable', async () => {
    // A proxy 502 or a captive portal never reaches Slack's auth check. Saying
    // "rejected" here sends the operator to revoke a healthy xapp- token.
    const report = await runDoctor(
      'preview',
      makeDeps({ openSlackSocket: async () => ({ ok: false, reason: 'transport' as const }) }),
    );
    expect(statusOf(report, 'slack_socket')).toBe('fail');
    expect(detailOf(report, 'slack_socket')).toMatch(/unavailable/i);
    expect(detailOf(report, 'slack_socket')).not.toMatch(/rejected/);
    expect(report.ok).toBe(false);
  });

  it('does not claim rejection for a probe that reports no reason at all', async () => {
    const report = await runDoctor('preview', makeDeps({ openSlackSocket: async () => ({ ok: false }) }));
    expect(detailOf(report, 'slack_socket')).not.toMatch(/rejected/);
  });

  it('fails slack_socket without leaking a thrown error that carries the credential', async () => {
    const report = await runDoctor(
      'preview',
      makeDeps({
        openSlackSocket: async () => {
          throw new Error(`apps.connections.open failed for ${APP_TOKEN} -> ${SENTINEL_WSS}`);
        },
      }),
    );
    expect(statusOf(report, 'slack_socket')).toBe('fail');
    const json = doctorReportToJson(report);
    expect(json).not.toContain(APP_TOKEN);
    expect(json).not.toContain('SENTINEL-TICKET-VALUE');
  });

  it('fails slack_socket when the app-level credential is missing', async () => {
    const report = await runDoctor('preview', makeDeps({ readSecrets: () => ({ SLACK_BOT_TOKEN: BOT_TOKEN }) }));
    expect(statusOf(report, 'slack_socket')).toBe('fail');
    expect(openedSockets).toEqual([]);
  });

  it('fails both Slack checks when the secret store itself is unreadable', async () => {
    const report = await runDoctor(
      'preview',
      makeDeps({
        readSecrets: () => {
          throw new Error(`malformed secrets file containing ${BOT_TOKEN}`);
        },
      }),
    );
    expect(statusOf(report, 'slack_bot')).toBe('fail');
    expect(statusOf(report, 'slack_socket')).toBe('fail');
    expect(doctorReportToJson(report)).not.toContain(BOT_TOKEN);
  });

  // ------------------------------------------------------------ filesystem

  it('fails base_directory when the path does not exist', async () => {
    fs.rmSync(baseDirectory, { recursive: true, force: true });
    const report = await runDoctor('preview', deps);
    expect(statusOf(report, 'base_directory')).toBe('fail');
  });

  it('fails base_directory when the path is a file rather than a directory', async () => {
    fs.rmSync(baseDirectory, { recursive: true, force: true });
    fs.writeFileSync(baseDirectory, 'not a dir');
    const report = await runDoctor('preview', deps);
    expect(statusOf(report, 'base_directory')).toBe('fail');
  });

  // Mutation guard: reverting `statFollow` to `stat` in `doctor.ts` fails this
  // test and only this test — the lstat projection reports the link itself, so
  // a perfectly good workspace was rejected as "not a directory".
  it('passes base_directory when the workspace is reached through a symlink', async () => {
    const real = path.join(home, 'volume', 'Code');
    fs.mkdirSync(real, { recursive: true });
    const linked = path.join(home, 'linked-code');
    fs.symlinkSync(real, linked);
    const report = await runDoctor('preview', makeDeps({ baseDirectory: linked }));
    expect(statusOf(report, 'base_directory')).toBe('pass');
  });

  it('fails base_directory when a symlink points at a file', async () => {
    const file = path.join(home, 'not-a-dir');
    fs.writeFileSync(file, 'x');
    const linked = path.join(home, 'linked-file');
    fs.symlinkSync(file, linked);
    const report = await runDoctor('preview', makeDeps({ baseDirectory: linked }));
    expect(statusOf(report, 'base_directory')).toBe('fail');
  });

  it('fails base_directory when a symlink dangles', async () => {
    const linked = path.join(home, 'linked-missing');
    fs.symlinkSync(path.join(home, 'nowhere'), linked);
    const report = await runDoctor('preview', makeDeps({ baseDirectory: linked }));
    expect(statusOf(report, 'base_directory')).toBe('fail');
  });

  it('fails base_directory when the directory is not writable', async () => {
    fs.chmodSync(baseDirectory, 0o500);
    try {
      const report = await runDoctor('preview', deps);
      expect(statusOf(report, 'base_directory')).toBe('fail');
    } finally {
      fs.chmodSync(baseDirectory, 0o700);
    }
  });

  it('fails profile_permissions when the config directory is group readable', async () => {
    fs.chmodSync(paths.configDir, 0o755);
    const report = await runDoctor('preview', deps);
    expect(statusOf(report, 'profile_permissions')).toBe('fail');
    expect(report.ok).toBe(false);
  });

  it('fails profile_permissions when the secret file is not 0600', async () => {
    fs.chmodSync(paths.secretsFile, 0o644);
    const report = await runDoctor('preview', deps);
    expect(statusOf(report, 'profile_permissions')).toBe('fail');
  });

  it('fails profile_permissions when the secret file is missing entirely', async () => {
    fs.rmSync(paths.secretsFile, { force: true });
    const report = await runDoctor('preview', deps);
    expect(statusOf(report, 'profile_permissions')).toBe('fail');
  });

  it('fails profile_permissions when the credential backup file is not 0600', async () => {
    // SecretStore keeps the previous credentials at <file>.bak on every write.
    const backup = `${paths.secretsFile}.bak`;
    fs.writeFileSync(backup, 'SLACK_BOT_TOKEN=xoxb-old-value-here\n', { mode: 0o600 });
    fs.chmodSync(backup, 0o644);
    const report = await runDoctor('preview', deps);
    expect(statusOf(report, 'profile_permissions')).toBe('fail');
  });

  it('passes profile_permissions when no credential backup exists yet', async () => {
    expect(fs.existsSync(`${paths.secretsFile}.bak`)).toBe(false);
    const report = await runDoctor('preview', deps);
    expect(statusOf(report, 'profile_permissions')).toBe('pass');
  });

  it('does not treat a short stored value as a credential copied into config', async () => {
    // A substring search for a few characters matches ordinary env text; the
    // scan must be bounded below or it fails healthy profiles.
    const report = await runDoctor(
      'preview',
      makeDeps({ readSecrets: () => ({ SLACK_BOT_TOKEN: BOT_TOKEN, SLACK_SIGNING_SECRET: 'llmux' }) }),
    );
    expect(statusOf(report, 'config')).toBe('pass');
  });

  it('does not write to the directories it inspects', async () => {
    const before = fs.readdirSync(baseDirectory);
    await runDoctor('preview', deps);
    expect(fs.readdirSync(baseDirectory)).toEqual(before);
  });

  // --------------------------------------------------------------- runtime

  it('fails runtime when the runtime root is missing', async () => {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
    const report = await runDoctor('preview', deps);
    expect(statusOf(report, 'runtime')).toBe('fail');
  });

  it('fails runtime when a required entry asset is missing', async () => {
    fs.rmSync(path.join(runtimeRoot, 'dist', 'index.js'), { force: true });
    const report = await runDoctor('preview', deps);
    expect(statusOf(report, 'runtime')).toBe('fail');
  });

  it('warns rather than fails when only an optional runtime asset is missing', async () => {
    const report = await runDoctor(
      'preview',
      makeDeps({
        runtimeAssets: [
          { path: path.join('dist', 'index.js'), required: true },
          { path: path.join('dist', 'optional.js'), required: false },
        ],
      }),
    );
    expect(statusOf(report, 'runtime')).toBe('warn');
    expect(report.ok).toBe(true);
  });

  it('warns rather than passing when no runtime program files were listed', async () => {
    const report = await runDoctor('preview', makeDeps({ runtimeAssets: [] }));
    expect(statusOf(report, 'runtime')).toBe('warn');
    expect(detailOf(report, 'runtime')).toMatch(/no runtime program files/i);
  });

  it('fails runtime when the installed runtime belongs to another profile', async () => {
    const report = await runDoctor(
      'preview',
      makeDeps({ runtime: { profile: 'production', root: runtimeRoot, version: '1.2.3' } }),
    );
    expect(statusOf(report, 'runtime')).toBe('fail');
  });

  // ---------------------------------------------------------------- config

  it('fails config when a materialized artifact is missing', async () => {
    fs.rmSync(path.join(paths.configDir, 'config.json'), { force: true });
    const report = await runDoctor('preview', deps);
    expect(statusOf(report, 'config')).toBe('fail');
  });

  it('fails config when an artifact is not 0600', async () => {
    fs.chmodSync(path.join(paths.configDir, '.env'), 0o644);
    const report = await runDoctor('preview', deps);
    expect(statusOf(report, 'config')).toBe('fail');
  });

  it('fails config when config.json cannot be parsed', async () => {
    fs.writeFileSync(path.join(paths.configDir, 'config.json'), '{ not json', { mode: 0o600 });
    fs.chmodSync(path.join(paths.configDir, 'config.json'), 0o600);
    const report = await runDoctor('preview', deps);
    expect(statusOf(report, 'config')).toBe('fail');
  });

  it('fails config when the runtime loader could not load the file at all', async () => {
    // A `${VAR:?}` failure throws inside substitution BEFORE the missing list
    // exists, so `missing: []` is exactly what a real failure looks like.
    const report = await runDoctor('preview', makeDeps({ loadConfigFile: () => ({ loaded: false, missing: [] }) }));
    expect(statusOf(report, 'config')).toBe('fail');
    expect(report.ok).toBe(false);
  });

  it('fails config when a placeholder cannot be resolved from the merged env map', async () => {
    const report = await runDoctor(
      'preview',
      makeDeps({ loadConfigFile: () => ({ loaded: true, missing: ['SOMA_MISSING_VALUE'] }) }),
    );
    expect(statusOf(report, 'config')).toBe('fail');
  });

  it('resolves placeholders against the .env plus secrets map without touching process.env', async () => {
    fs.writeFileSync(
      path.join(paths.configDir, 'config.json'),
      JSON.stringify({ ui: {}, probe: '${BASE_DIRECTORY}' }),
      { mode: 0o600 },
    );
    fs.chmodSync(path.join(paths.configDir, 'config.json'), 0o600);
    const seen: Array<Record<string, string | undefined>> = [];
    const before = { ...process.env };
    const report = await runDoctor(
      'preview',
      makeDeps({
        loadConfigFile: (_file, env) => {
          seen.push(env);
          return { loaded: true, missing: [] };
        },
      }),
    );
    expect(statusOf(report, 'config')).toBe('pass');
    expect(seen[0]?.BASE_DIRECTORY).toBe(baseDirectory);
    expect(seen[0]?.SLACK_BOT_TOKEN).toBe(BOT_TOKEN);
    expect(process.env).toEqual(before);
  });

  it('fails config when a stored credential has been copied into a non-secret file', async () => {
    fs.writeFileSync(path.join(paths.configDir, '.system.prompt'), `leaked ${BOT_TOKEN}\n`, { mode: 0o600 });
    fs.chmodSync(path.join(paths.configDir, '.system.prompt'), 0o600);
    const report = await runDoctor('preview', deps);
    expect(statusOf(report, 'config')).toBe('fail');
    expect(doctorReportToJson(report)).not.toContain(BOT_TOKEN);
  });

  it('warns when the system prompt has been emptied', async () => {
    fs.writeFileSync(path.join(paths.configDir, '.system.prompt'), '   \n', { mode: 0o600 });
    fs.chmodSync(path.join(paths.configDir, '.system.prompt'), 0o600);
    const report = await runDoctor('preview', deps);
    expect(statusOf(report, 'config')).toBe('warn');
    expect(report.ok).toBe(true);
  });

  // ------------------------------------------------------------- reporting

  it('produces a JSON document with exactly the report fields and nothing else', async () => {
    const report = await runDoctor('preview', deps);
    const parsed = JSON.parse(doctorReportToJson(report)) as DoctorReport;
    expect(Object.keys(parsed).sort()).toEqual(['checks', 'ok', 'profile']);
    for (const check of parsed.checks) {
      expect(Object.keys(check).sort()).toEqual(['detail', 'id', 'status']);
    }
  });

  it('produces a report that clears the setup-state secret gate', async () => {
    const report = await runDoctor('preview', deps);
    expect(() => assertSecretFree(report)).not.toThrow();
  });

  it('keeps absolute filesystem paths out of every check detail', async () => {
    fs.rmSync(baseDirectory, { recursive: true, force: true });
    const report = await runDoctor('preview', deps);
    for (const check of report.checks) {
      expect(check.detail).not.toContain('/');
      expect(check.detail).not.toContain(home);
    }
  });

  it('never surfaces a raw exception message from any seam', async () => {
    const marker = 'RAW-EXCEPTION-MARKER';
    const report = await runDoctor(
      'preview',
      makeDeps({
        fetchLlmuxStatus: async () => {
          throw new Error(marker);
        },
        probeSlackBot: async () => {
          throw new Error(marker);
        },
        openSlackSocket: async () => {
          throw new Error(marker);
        },
        loadConfigFile: () => {
          throw new Error(marker);
        },
      }),
    );
    expect(doctorReportToJson(report)).not.toContain(marker);
    expect(report.checks.filter((c) => c.status === 'fail').length).toBeGreaterThanOrEqual(4);
    // Every check still ran: a thrown seam must not truncate the report.
    expect(report.checks).toHaveLength(DOCTOR_CHECK_IDS.length);
  });

  it('gates the service on required failures', async () => {
    const healthy = await runDoctor('preview', deps);
    expect(healthy.ok).toBe(true);
    const broken = await runDoctor('preview', makeDeps({ openSlackSocket: async () => ({ ok: false }) }));
    expect(broken.ok).toBe(false);
  });
});

/**
 * The production wiring, not a fake.
 *
 * Everything above injects its seams, which proves the doctor core but says
 * nothing about the seam that will actually run on a clean machine. These
 * exercise the real `createDefaultDoctorDeps` seams — the config inspector
 * against the real `loadConfig`, and the socket probe against an injected
 * transport so the assertions are deterministic without a network call.
 */
describe('default doctor seams', () => {
  let home: string;
  let paths: ProfilePaths;
  let runtime: RuntimeInstall;
  let baseDirectory: string;
  let runtimeRoot: string;

  /** The real seam under test, wired exactly as production wires it. */
  function realLoadConfigFile(): DoctorDeps['loadConfigFile'] {
    return createDefaultDoctorDeps({
      paths,
      runtime,
      baseDirectory,
      uid: os.userInfo().uid,
      runtimeAssets: [],
      readSecrets: () => ({}),
    }).loadConfigFile;
  }

  function writeConfig(body: string): string {
    const file = path.join(paths.configDir, 'config.json');
    fs.writeFileSync(file, body, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    return file;
  }

  /** Bytes + permission bits + mtime, the three things a "read-only" claim covers. */
  function snapshot(file: string): { text: string; mode: number; mtimeMs: number } {
    const stat = fs.statSync(file);
    return { text: fs.readFileSync(file, 'utf-8'), mode: stat.mode & 0o7777, mtimeMs: stat.mtimeMs };
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-seam-test-'));
    runtimeRoot = path.join(home, 'runtime');
    baseDirectory = path.join(home, 'Code');
    fs.mkdirSync(baseDirectory, { recursive: true });
    fs.mkdirSync(runtimeRoot, { recursive: true });
    paths = profilePaths(home, 'preview');
    runtime = { profile: 'preview', root: runtimeRoot, version: '1.2.3' };
    fs.mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  // --------------------------------------------------------- C-1: false green

  it('reports loaded:false for a required ${VAR:?} placeholder the runtime cannot resolve', async () => {
    const file = writeConfig(JSON.stringify({ ui: {}, agents: { a: { token: '${SOMA_REQUIRED:?set me}' } } }));
    const result = await realLoadConfigFile()(file, {});
    // `:?` throws inside substitution, so `missing` is empty — the ONLY signal
    // that the config failed is `loaded`.
    expect(result.missing).toEqual([]);
    expect(result.loaded).toBe(false);
  });

  it('fails the doctor config check for a required placeholder with no value', async () => {
    const store = new SecretStore({ secretsFile: paths.secretsFile });
    store.write({ SLACK_BOT_TOKEN: BOT_TOKEN, SLACK_APP_TOKEN: APP_TOKEN });
    materializeProfile({
      profile: 'preview',
      paths,
      runtime,
      baseDirectory,
      slack: { appId: 'A0123456789', teamId: 'T0123456789' },
      defaultConfig: { content: JSON.stringify({ ui: { threadheader: {} } }) },
      systemPrompt: { content: PACKAGED_PROMPT },
    });
    writeConfig(JSON.stringify({ ui: {}, probe: '${SOMA_REQUIRED:?set me}' }));

    const report = await runDoctor('preview', {
      paths,
      runtime,
      baseDirectory,
      uid: os.userInfo().uid,
      runtimeAssets: [],
      fs: createNodeDoctorFileSystem(),
      readSecrets: () => store.read(),
      probeSlackBot: async () => ({ ok: true, fatalAuth: false }),
      openSlackSocket: async () => ({ ok: true }),
      fetchLlmuxStatus: async () => healthyLlmuxDocument(),
      loadConfigFile: realLoadConfigFile(),
    });
    expect(statusOf(report, 'config')).toBe('fail');
    expect(report.ok).toBe(false);
  });

  it('reports loaded:false for malformed JSON', async () => {
    const file = writeConfig('{ not json');
    expect((await realLoadConfigFile()(file, {})).loaded).toBe(false);
  });

  it('reports loaded:true for a bad plugin/agent section, which the loader warns-and-skips', async () => {
    // Documents the real blast radius of the `loaded` flag. Contrary to what a
    // reading of the catch-all suggests, neither `validatePluginConfig` nor
    // `parseAgentsConfig` throws — both warn and drop the entry — so the load
    // genuinely succeeds with that section absent. The flag exists for the two
    // paths that DO throw: `${VAR:?}` and a malformed document. If a future
    // change makes either validator throw, this test flips and the gate
    // correctly starts failing such a config.
    const file = writeConfig(JSON.stringify({ ui: {}, plugin: { enabled: 'not-a-boolean', servers: 42 } }));
    const result = await realLoadConfigFile()(file, {});
    expect(result.loaded).toBe(true);
  });

  it('reports loaded:false when the file does not exist', async () => {
    const result = await realLoadConfigFile()(path.join(paths.configDir, 'absent.json'), {});
    expect(result.loaded).toBe(false);
  });

  it('surfaces unresolved bare placeholders with loaded:true', async () => {
    const file = writeConfig(JSON.stringify({ ui: {}, probe: '${SOMA_ABSENT}' }));
    const result = await realLoadConfigFile()(file, {});
    expect(result.loaded).toBe(true);
    expect(result.missing).toEqual(['SOMA_ABSENT']);
  });

  it('resolves placeholders from the supplied env map and reports nothing missing', async () => {
    const file = writeConfig(JSON.stringify({ ui: {}, probe: '${SOMA_SUPPLIED}' }));
    const result = await realLoadConfigFile()(file, { SOMA_SUPPLIED: 'value' });
    expect(result).toEqual({ loaded: true, missing: [] });
  });

  // ----------------------------------------------------- I-1: truly read-only

  it('does not touch a config with no ui key, which the runtime loader would seed and rewrite', async () => {
    const file = writeConfig(JSON.stringify({ mcpServers: {} }));
    const before = snapshot(file);
    await realLoadConfigFile()(file, {});
    expect(snapshot(file)).toEqual(before);
  });

  it('does not touch a config carrying the legacy llmChat key, which the runtime loader would strip', async () => {
    const file = writeConfig(JSON.stringify({ ui: {}, llmChat: { model: 'legacy' } }));
    const before = snapshot(file);
    await realLoadConfigFile()(file, {});
    const after = snapshot(file);
    expect(after).toEqual(before);
    expect(JSON.parse(after.text).llmChat).toEqual({ model: 'legacy' });
  });

  it('does not touch a malformed config', async () => {
    const file = writeConfig('{ not json');
    const before = snapshot(file);
    await realLoadConfigFile()(file, {});
    expect(snapshot(file)).toEqual(before);
  });

  it('does not touch a valid config', async () => {
    const file = writeConfig(`${JSON.stringify({ ui: { threadheader: {} } }, null, 2)}\n`);
    const before = snapshot(file);
    await realLoadConfigFile()(file, {});
    expect(snapshot(file)).toEqual(before);
  });

  it('leaves the config directory with no stray temp files after an inspection', async () => {
    writeConfig(JSON.stringify({ mcpServers: {} }));
    await realLoadConfigFile()(path.join(paths.configDir, 'config.json'), {});
    expect(fs.readdirSync(paths.configDir)).toEqual(['config.json']);
  });

  it('does not mutate process.env while inspecting a profile that defines variables', async () => {
    fs.writeFileSync(path.join(paths.configDir, '.env'), 'SOMA_PROFILE_ONLY_VALUE=leaked\n', { mode: 0o600 });
    const file = writeConfig(JSON.stringify({ ui: {} }));
    const before = { ...process.env };
    await realLoadConfigFile()(file, { SOMA_SUPPLIED: 'value' });
    expect(process.env).toEqual(before);
    expect(process.env.SOMA_PROFILE_ONLY_VALUE).toBeUndefined();
  });

  // --------------------------------------- llmux endpoint: profile-scoped

  /**
   * `fetchLlmuxStatus` sends the operator's llmux **admin key** to whatever
   * host it is given, so the destination read out of a profile file is an
   * outbound-credential decision. These assert on the real
   * `createDefaultDoctorDeps` seam with only the global transport spied, so
   * "the fetch never happened" is observed rather than argued.
   */
  function llmuxDeps(overrides: { llmuxBaseUrl?: string } = {}): DoctorDeps {
    return createDefaultDoctorDeps({
      paths,
      runtime,
      baseDirectory,
      uid: os.userInfo().uid,
      runtimeAssets: [],
      readSecrets: () => ({}),
      ...overrides,
    });
  }

  function writeProfileEnv(baseUrl: string): void {
    fs.writeFileSync(path.join(paths.configDir, '.env'), `AUTH_MODE=llmux\nANTHROPIC_BASE_URL=${baseUrl}\n`, {
      mode: 0o600,
    });
  }

  /** Spy on the global fetch the llmux client uses; returns the URLs it saw. */
  function spyFetch(): { urls: string[]; restore: () => void } {
    const urls: string[] = [];
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: unknown) => {
      urls.push(typeof input === 'string' ? input : String(input));
      return new Response(JSON.stringify({ current: null, accounts: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch);
    return { urls, restore: () => spy.mockRestore() };
  }

  it("probes the endpoint named in the profile's own .env", async () => {
    writeProfileEnv('http://127.0.0.1:9999');
    const { urls, restore } = spyFetch();
    try {
      await llmuxDeps().fetchLlmuxStatus();
    } finally {
      restore();
    }
    expect(urls).toEqual(['http://127.0.0.1:9999/llmux/status']);
  });

  it('lets an explicit override win over the profile value', async () => {
    writeProfileEnv('http://127.0.0.1:9999');
    const { urls, restore } = spyFetch();
    try {
      await llmuxDeps({ llmuxBaseUrl: 'http://localhost:4444' }).fetchLlmuxStatus();
    } finally {
      restore();
    }
    expect(urls).toEqual(['http://localhost:4444/llmux/status']);
  });

  it('falls back to the exact local default when the profile names none', async () => {
    fs.writeFileSync(path.join(paths.configDir, '.env'), 'AUTH_MODE=llmux\n', { mode: 0o600 });
    const { urls, restore } = spyFetch();
    try {
      await llmuxDeps().fetchLlmuxStatus();
    } finally {
      restore();
    }
    expect(DEFAULT_LLMUX_BASE_URL).toBe('http://localhost:3456');
    expect(urls).toEqual([`${DEFAULT_LLMUX_BASE_URL}/llmux/status`]);
  });

  it('falls back to the exact local default when the profile has no .env at all', async () => {
    const { urls, restore } = spyFetch();
    try {
      await llmuxDeps().fetchLlmuxStatus();
    } finally {
      restore();
    }
    expect(urls).toEqual([`${DEFAULT_LLMUX_BASE_URL}/llmux/status`]);
  });

  it.each([
    ['a remote https host', 'https://evil.example.com'],
    ['a lookalike registrable domain', 'http://localhost.evil.com:3456'],
    ['a remote host on the expected port', 'http://10.0.0.5:3456'],
    ['embedded userinfo', 'http://user:pass@localhost:3456'],
    ['a path', 'http://localhost:3456/exfil'],
    ['a query string', 'http://localhost:3456/?to=evil.example.com'],
    ['a non-http scheme', 'file:///etc/passwd'],
    ['an unparseable value', 'not a url'],
    ['an out-of-range port', 'http://localhost:99999'],
  ])('refuses %s and makes no request at all', async (_label, badUrl) => {
    writeProfileEnv(badUrl);
    const { urls, restore } = spyFetch();
    let caught: unknown;
    try {
      await llmuxDeps().fetchLlmuxStatus();
    } catch (err) {
      caught = err;
    } finally {
      restore();
    }
    expect(caught).toBeInstanceOf(LlmuxEndpointError);
    // Zero network calls: the refusal precedes both the client import and the
    // admin-key resolution that would have chosen what to send.
    expect(urls).toEqual([]);
    // The rejected value came from a file an attacker may control.
    expect(String((caught as Error).message)).not.toContain(badUrl);
    expect(JSON.stringify(caught)).not.toContain('evil');
  });

  it('refuses a fragment, which only an override can carry', async () => {
    // Not reachable through `.env`: dotenv truncates the value at `#`, so
    // `ANTHROPIC_BASE_URL=http://localhost:3456/#evil` is read back as
    // `http://localhost:3456/`. The override path has no such filter.
    expect(dotenv.parse('K=http://localhost:3456/#evil\n').K).toBe('http://localhost:3456/');
    expect(() => resolveLlmuxBaseUrl(paths.configDir, 'http://localhost:3456/#evil')).toThrow(LlmuxEndpointError);
  });

  it('applies the same refusal to an explicit override, which is not privileged', async () => {
    const { urls, restore } = spyFetch();
    let caught: unknown;
    try {
      await llmuxDeps({ llmuxBaseUrl: 'https://evil.example.com' }).fetchLlmuxStatus();
    } catch (err) {
      caught = err;
    } finally {
      restore();
    }
    expect(caught).toBeInstanceOf(LlmuxEndpointError);
    expect(urls).toEqual([]);
  });

  it.each([
    ['a bare query delimiter', 'http://localhost:3456/?'],
    ['a bare fragment delimiter', 'http://localhost:3456/#'],
    ['a trailing slash', 'http://localhost:3456/'],
    ['no port with a trailing slash', 'http://localhost/'],
  ])('canonicalizes %s so the client appends a real path', (_label, candidate) => {
    // NN-3: `search`/`hash` are empty for a bare delimiter, so these pass
    // validation. Returning the raw candidate then makes the client build
    // `http://localhost:3456/?/llmux/status` — the daemon is dialed at `/`
    // with the real path as a query, and doctor calls a healthy daemon dead.
    const resolved = resolveLlmuxBaseUrl(paths.configDir, candidate);
    expect(resolved).toBe(new URL(candidate).origin);
    expect(resolved).not.toMatch(/[?#]/);
  });

  it('sends a canonical status URL even when the profile names a bare delimiter', async () => {
    writeProfileEnv('http://127.0.0.1:9999/?');
    const { urls, restore } = spyFetch();
    try {
      await llmuxDeps().fetchLlmuxStatus();
    } finally {
      restore();
    }
    expect(urls).toEqual(['http://127.0.0.1:9999/llmux/status']);
  });

  it('accepts every supported loopback spelling', () => {
    for (const ok of [
      'http://localhost:3456',
      'http://127.0.0.1:3456',
      'http://[::1]:3456',
      'http://localhost',
      'http://localhost:3456/',
    ]) {
      // The validated form and the transmitted form are the same object.
      expect(resolveLlmuxBaseUrl(paths.configDir, ok)).toBe(new URL(ok).origin);
    }
  });

  it('fails the llmux check locally, with a distinct detail and no leaked value', async () => {
    writeProfileEnv('https://evil.example.com');
    const { urls, restore } = spyFetch();
    let report: DoctorReport;
    try {
      report = await runDoctor('preview', {
        paths,
        runtime,
        baseDirectory,
        uid: os.userInfo().uid,
        runtimeAssets: [],
        fs: createNodeDoctorFileSystem(),
        readSecrets: () => ({}),
        probeSlackBot: async () => ({ ok: true, fatalAuth: false }),
        openSlackSocket: async () => ({ ok: true }),
        fetchLlmuxStatus: llmuxDeps().fetchLlmuxStatus,
        loadConfigFile: () => ({ loaded: true, missing: [] }),
      });
    } finally {
      restore();
    }
    expect(statusOf(report, 'llmux')).toBe('fail');
    expect(detailOf(report, 'llmux')).toMatch(/not a supported local address/);
    expect(detailOf(report, 'llmux')).not.toMatch(/unreachable/);
    expect(urls).toEqual([]);
    expect(doctorReportToJson(report)).not.toContain('evil');
  });

  // ------------------------------------------------- I-4: real socket probe

  it('posts the credential in the Authorization header, never in the URL or body', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ ok: true, url: SENTINEL_WSS }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const result = await openSlackSocketProbe(APP_TOKEN, { fetchImpl });
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(SLACK_CONNECTIONS_OPEN_URL);
    expect(calls[0].url).not.toContain(APP_TOKEN);
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.body ?? '').not.toContain(APP_TOKEN);
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(`Bearer ${APP_TOKEN}`);
  });

  it('discards the wss URL from a successful response', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ok: true, url: SENTINEL_WSS }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const result = await openSlackSocketProbe(APP_TOKEN, { fetchImpl });
    expect(JSON.stringify(result)).not.toContain('wss://');
    expect(JSON.stringify(result)).not.toContain('SENTINEL-TICKET-VALUE');
    expect(Object.keys(result)).toEqual(['ok']);
    expect(result.reason).toBeUndefined();
  });

  it('classifies a 200 invalid_auth body as a credential rejection', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ok: false, error: 'invalid_auth' }), { status: 200 })) as unknown as typeof fetch;
    expect(await openSlackSocketProbe(APP_TOKEN, { fetchImpl })).toEqual({ ok: false, reason: 'rejected' });
  });

  it('classifies a proxy 502 as transport, never as a credential rejection', async () => {
    const fetchImpl = (async () =>
      new Response('<html>502 Bad Gateway</html>', { status: 502 })) as unknown as typeof fetch;
    expect(await openSlackSocketProbe(APP_TOKEN, { fetchImpl })).toEqual({ ok: false, reason: 'transport' });
  });

  it('classifies a captive-portal HTML body as transport, never as a credential rejection', async () => {
    const fetchImpl = (async () =>
      new Response('<html>sign in to the wifi</html>', { status: 200 })) as unknown as typeof fetch;
    expect(await openSlackSocketProbe(APP_TOKEN, { fetchImpl })).toEqual({ ok: false, reason: 'transport' });
  });

  it('classifies a timeout as transport and resolves instead of throwing', async () => {
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        (init.signal as AbortSignal).addEventListener('abort', () => reject(new Error(`aborted for ${APP_TOKEN}`)));
      })) as unknown as typeof fetch;
    const result = await openSlackSocketProbe(APP_TOKEN, { fetchImpl, timeoutMs: 20 });
    expect(result).toEqual({ ok: false, reason: 'transport' });
    expect(JSON.stringify(result)).not.toContain(APP_TOKEN);
  });

  it('classifies a network fault as transport without surfacing the error', async () => {
    const fetchImpl = (async () => {
      throw new Error(`ECONNREFUSED while sending ${APP_TOKEN}`);
    }) as unknown as typeof fetch;
    const result = await openSlackSocketProbe(APP_TOKEN, { fetchImpl });
    expect(result).toEqual({ ok: false, reason: 'transport' });
    expect(JSON.stringify(result)).not.toContain(APP_TOKEN);
  });

  it('reports ok:false for a non-2xx response without parsing its body', async () => {
    let parsed = false;
    const response = new Response('<html>gateway error</html>', { status: 502 });
    Object.defineProperty(response, 'json', {
      value: async () => {
        parsed = true;
        return {};
      },
    });
    const fetchImpl = (async () => response) as unknown as typeof fetch;
    expect(await openSlackSocketProbe(APP_TOKEN, { fetchImpl })).toEqual({ ok: false, reason: 'transport' });
    expect(parsed).toBe(false);
  });

  it('reports ok:false for a 2xx body that is not JSON', async () => {
    const fetchImpl = (async () =>
      new Response('<html>captive portal</html>', { status: 200 })) as unknown as typeof fetch;
    expect(await openSlackSocketProbe(APP_TOKEN, { fetchImpl })).toEqual({ ok: false, reason: 'transport' });
  });

  it('aborts a black-holed request on its own deadline instead of hanging the gate', async () => {
    let abortSeen = false;
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init.signal as AbortSignal;
        signal.addEventListener('abort', () => {
          abortSeen = true;
          reject(new Error('aborted'));
        });
      })) as unknown as typeof fetch;

    expect(await openSlackSocketProbe(APP_TOKEN, { fetchImpl, timeoutMs: 20 })).toEqual({
      ok: false,
      reason: 'transport',
    });
    expect(abortSeen).toBe(true);
  });

  it('is wired into the default deps with the injected transport', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen.push((init.headers as Record<string, string>).authorization);
      return new Response(JSON.stringify({ ok: true, url: SENTINEL_WSS }), { status: 200 });
    }) as unknown as typeof fetch;
    const deps = createDefaultDoctorDeps({
      paths,
      runtime,
      baseDirectory,
      uid: os.userInfo().uid,
      runtimeAssets: [],
      readSecrets: () => ({}),
      fetchImpl,
    });
    expect(await deps.openSlackSocket(APP_TOKEN)).toEqual({ ok: true });
    expect(seen).toEqual([`Bearer ${APP_TOKEN}`]);
  });
});

function statusOf(report: DoctorReport, id: string): string {
  const check = report.checks.find((c) => c.id === id);
  if (!check) throw new Error(`no check ${id}`);
  return check.status;
}

function detailOf(report: DoctorReport, id: string): string {
  const check = report.checks.find((c) => c.id === id);
  if (!check) throw new Error(`no check ${id}`);
  return check.detail;
}
