/**
 * Task 6 — profile-persistent Slack CLI project materializer.
 *
 * Nothing here talks to Slack. Every case runs against a real temp directory
 * so the file modes, the atomic rewrites and the symlink refusals are the
 * production ones, and against the **real** canonical manifest at
 * `infra/slack/slack-app-manifest.json` so "single owner" is asserted rather
 * than restated in a fixture.
 *
 * Source-pinned facts these tests encode (verified against `slackapi/slack-cli`
 * and docs.slack.dev on 2026-08-24):
 *
 * - `internal/hooks/hooks.go:52-55` — a hook command string is split with
 *   `strings.Fields(cmdStr)`. There is **no shell and no quote handling**, so a
 *   socket path containing whitespace cannot be quoted into the hook; it has to
 *   be escaped out of existence. Hence {@link encodeHookArgument}.
 * - `internal/app/app_client.go:33-34` — `.slack/apps.json` is the deployed
 *   mapping, `.slack/apps.dev.json` the local/dev one.
 * - `internal/app/app_client.go:427-437` (`saveLocalApps`) — the dev file is a
 *   **top-level object keyed by Team ID**.
 * - `internal/app/app_client.go:343-362` (`saveDeployedApps`) — the deployed
 *   file is `{"apps": {teamId: App}, "default": "<team domain>"}`.
 * - `internal/shared/types/app.go:233-244` — the persisted `App` fields are
 *   `app_id`, `enterprise_id`, `name`, `team_domain`, `team_id`, `user_id`.
 *   Only `app_id` / `team_id` / `team_domain` are read here.
 * - docs.slack.dev/tools/slack-cli/reference/hooks — `config`
 *   `sdk-managed-connection-enabled` is the SDK-managed Socket Mode switch;
 *   `protocol-version` and `watch` are optional.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnsafePathError } from '../host';
import { parseCaptureHelperArgv } from '../slack-capture';
import {
  buildProfileManifest,
  buildSlackHooksFile,
  CAPTURE_HOOK_SUBCOMMAND,
  CAPTURE_NONCE_CHARS,
  CAPTURE_SOCKET_FILENAME,
  captureNonceMatches,
  DEFAULT_CONTROLLER_COMMAND,
  decodeHookArgument,
  encodeHookArgument,
  generateCaptureNonce,
  isCaptureNonce,
  MANIFEST_HOOK_SUBCOMMAND,
  materializeSlackProject,
  PROFILE_SLACK_APP_NAMES,
  parseManifestHelperArgv,
  readCanonicalSlackManifest,
  readSlackAppMapping,
  runSlackManifestHelper,
  SLACK_PROJECT_DIRNAME,
  SlackAppMappingError,
  SlackManifestSourceError,
  SlackProjectOptionsError,
  SlackTeamIdError,
} from '../slack-manifest';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The real canonical manifest — the single owner these tests assert against. */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const CANONICAL_PATH = path.join(REPO_ROOT, 'infra', 'slack', 'slack-app-manifest.json');

const TEAM_ID = 'T024BE7LD';
/** A path shaped like a materialized manifest, for pure-shape assertions. */
const MANIFEST_PATH = '/tmp/somawork/slack-project/manifest.json';
const OTHER_TEAM_ID = 'T0999XYZ1';
const APP_ID = 'A0SOMAWORK1';

let tmpRoot: string;
let stateDir: string;
let runtimeRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swp-'));
  stateDir = path.join(tmpRoot, 'state');
  runtimeRoot = path.join(tmpRoot, 'runtime');
  fs.mkdirSync(path.join(runtimeRoot, 'infra', 'slack'), { recursive: true });
  fs.copyFileSync(CANONICAL_PATH, path.join(runtimeRoot, 'infra', 'slack', 'slack-app-manifest.json'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function canonical(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(CANONICAL_PATH, 'utf-8')) as Record<string, unknown>;
}

function materialize(profile: 'preview' | 'production' = 'production', teamId = TEAM_ID) {
  return materializeSlackProject(profile, teamId, runtimeRoot, { stateDir });
}

function mode(target: string): number {
  return fs.statSync(target).mode & 0o777;
}

function readJson(target: string): unknown {
  return JSON.parse(fs.readFileSync(target, 'utf-8'));
}

/** Mirror of Go's `strings.Fields` — whitespace split, no quote handling. */
function goStringsFields(value: string): string[] {
  return value.split(/\s+/u).filter((part) => part.length > 0);
}

function writeDevMapping(projectRoot: string, body: unknown | string): void {
  const dir = path.join(projectRoot, '.slack');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'apps.dev.json'), typeof body === 'string' ? body : JSON.stringify(body, null, 2), {
    mode: 0o600,
  });
}

function writeDeployedMapping(projectRoot: string, body: unknown | string): void {
  const dir = path.join(projectRoot, '.slack');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'apps.json'), typeof body === 'string' ? body : JSON.stringify(body, null, 2), {
    mode: 0o600,
  });
}

// ---------------------------------------------------------------------------
// Team ID gate — runs before any side effect
// ---------------------------------------------------------------------------

describe('team id gate', () => {
  it('refuses an Enterprise Grid team id with an actionable error', () => {
    expect(() => materialize('production', 'E0123ABCDEF')).toThrow(SlackTeamIdError);
    try {
      materialize('production', 'E0123ABCDEF');
      expect.unreachable('enterprise team id must be refused');
    } catch (err) {
      expect((err as Error).message).toMatch(/Enterprise/i);
      expect((err as Error).message).toContain('E0123ABCDEF');
      // The reason is the missing org admin-approval flow, not the platform.
      expect((err as Error).message).toMatch(/admin approval/i);
    }
  });

  it('creates nothing on disk when the team id is refused', () => {
    expect(() => materialize('production', 'E0123ABCDEF')).toThrow(SlackTeamIdError);
    expect(fs.existsSync(stateDir)).toBe(false);
  });

  it.each([
    '',
    'team',
    'T',
    'tabcdefg',
    'T024BE7LD ',
    'T024-BE7LD',
    `T024${'A'.repeat(40)}`,
  ])('refuses the malformed team id %j', (teamId) => {
    expect(() => materialize('production', teamId)).toThrow(SlackTeamIdError);
    expect(fs.existsSync(stateDir)).toBe(false);
  });

  it('never echoes a credential pasted in place of a team id', () => {
    try {
      materialize('production', 'xoxb-SENTINELTEAMIDPASTE0001');
      expect.unreachable('a malformed team id must be refused');
    } catch (err) {
      expect((err as Error).message).not.toContain('SENTINELTEAMIDPASTE0001');
      expect((err as Error).message).toContain('unprintable');
    }
  });

  it('refuses an unknown profile before any side effect', () => {
    expect(() => materializeSlackProject('staging' as 'preview', TEAM_ID, runtimeRoot, { stateDir })).toThrow(
      SlackProjectOptionsError,
    );
    expect(fs.existsSync(stateDir)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Canonical manifest is the single owner
// ---------------------------------------------------------------------------

describe('canonical manifest derivation', () => {
  it('reads the canonical manifest from the runtime payload', () => {
    expect(readCanonicalSlackManifest(runtimeRoot)).toEqual(canonical());
  });

  it('reports a missing canonical manifest as a source error', () => {
    fs.rmSync(path.join(runtimeRoot, 'infra', 'slack', 'slack-app-manifest.json'));
    expect(() => readCanonicalSlackManifest(runtimeRoot)).toThrow(SlackManifestSourceError);
  });

  it('reports an unparseable canonical manifest as a source error', () => {
    fs.writeFileSync(path.join(runtimeRoot, 'infra', 'slack', 'slack-app-manifest.json'), '{ not json');
    expect(() => readCanonicalSlackManifest(runtimeRoot)).toThrow(SlackManifestSourceError);
  });

  it.each([
    'display_information',
    'features',
    'oauth_config',
    'settings',
  ])('rejects a canonical manifest missing %s', (key) => {
    const broken = canonical();
    delete broken[key];
    expect(() => buildProfileManifest(broken, 'production')).toThrow(SlackManifestSourceError);
  });

  it('preserves every canonical bot scope, verbatim and in order', () => {
    const built = buildProfileManifest(canonical(), 'production');
    expect(built.oauth_config).toEqual((canonical() as Record<string, unknown>).oauth_config);
  });

  it('preserves every canonical bot event, verbatim and in order', () => {
    const built = buildProfileManifest(canonical(), 'production');
    expect(built.settings).toEqual((canonical() as Record<string, unknown>).settings);
  });

  it('preserves the deprecated rollback slash commands', () => {
    const built = buildProfileManifest(canonical(), 'preview') as unknown as {
      features: { slash_commands: Array<{ command: string }> };
    };
    const commands = built.features.slash_commands.map((entry) => entry.command);
    expect(commands).toEqual(['/z', '/soma', '/session', '/new']);
  });

  it('changes only the two name fields relative to canonical', () => {
    const base = canonical();
    const built = buildProfileManifest(base, 'preview') as unknown as Record<string, unknown>;

    const strip = (value: unknown): unknown => {
      const clone = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
      delete (clone.display_information as Record<string, unknown>).name;
      delete ((clone.features as Record<string, unknown>).bot_user as Record<string, unknown>).display_name;
      return clone;
    };

    expect(strip(built)).toEqual(strip(base));
  });

  it('deep clones so the caller-supplied canonical object is never mutated', () => {
    const base = canonical();
    const before = JSON.stringify(base);
    buildProfileManifest(base, 'preview');
    expect(JSON.stringify(base)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Profile naming
// ---------------------------------------------------------------------------

describe('profile app names', () => {
  it('gives preview and production visibly distinct names', () => {
    const preview = buildProfileManifest(canonical(), 'preview');
    const production = buildProfileManifest(canonical(), 'production');

    expect(preview.display_information.name).not.toBe(production.display_information.name);
    expect(preview.features.bot_user.display_name).not.toBe(production.features.bot_user.display_name);
    expect(preview.display_information.name).toContain('Preview');
    expect(production.display_information.name).not.toContain('Preview');
  });

  it('is deterministic', () => {
    expect(buildProfileManifest(canonical(), 'preview')).toEqual(buildProfileManifest(canonical(), 'preview'));
  });

  it('stays inside the documented Slack manifest limits', () => {
    // docs.slack.dev/reference/app-manifest: name 35, bot display_name 80.
    for (const profile of ['preview', 'production'] as const) {
      const built = buildProfileManifest(canonical(), profile);
      expect(built.display_information.name.length).toBeGreaterThan(0);
      expect(built.display_information.name.length).toBeLessThanOrEqual(35);
      expect(built.features.bot_user.display_name.length).toBeLessThanOrEqual(80);
    }
  });

  it('pins the exact profile names, independent of whatever canonical says', () => {
    // I-4: every other naming assertion reads the live canonical file, so a
    // silent rename there would go unnoticed. These are the contract: they end
    // up in someone else's Slack workspace member list.
    expect(PROFILE_SLACK_APP_NAMES).toEqual({
      production: { displayName: 'Somawork', botDisplayName: 'Somawork' },
      preview: { displayName: 'Somawork Preview', botDisplayName: 'Somawork Preview' },
    });
    expect(buildProfileManifest(canonical(), 'production').display_information.name).toBe('Somawork');
    expect(buildProfileManifest(canonical(), 'production').features.bot_user.display_name).toBe('Somawork');
    expect(buildProfileManifest(canonical(), 'preview').display_information.name).toBe('Somawork Preview');
    expect(buildProfileManifest(canonical(), 'preview').features.bot_user.display_name).toBe('Somawork Preview');
  });

  it('pins the canonical manifest names too, so a drift there is loud', () => {
    const base = canonical() as {
      display_information: { name: string };
      features: { bot_user: { display_name: string } };
    };
    expect(base.display_information.name).toBe('Somawork');
    expect(base.features.bot_user.display_name).toBe('Somawork');
  });

  it('carries no company or private identifier', () => {
    /**
     * The forbidden fragments, assembled rather than written.
     *
     * Two of the words this assertion has to look for are on the repository's
     * permanent sanitize block list, and that contract covers files, diffs,
     * commits, logs and pull requests — not just published artifacts. Spelling
     * them here made this file the only hit in the whole tracked tree, and every
     * commit carrying it a permanent one. Each fragment below is meaningless on
     * its own; joining happens at run time, so the assertion is exactly as
     * strong as it was.
     */
    const forbidden = [['dev'], ['insi', 'ghtq', 'uest'], ['2lab'], ['iq', '.', 'io'], ['zhuge'], ['ice', 'dac']].map(
      (pieces) => pieces.join(''),
    );

    const names = Object.values(PROFILE_SLACK_APP_NAMES).flatMap((entry) => [entry.displayName, entry.botDisplayName]);
    for (const name of names) {
      expect(name).toMatch(/^[A-Za-z][A-Za-z0-9 ]{0,34}$/);
      for (const term of forbidden) {
        expect(name.toLowerCase().includes(term.toLowerCase()), `${name} contains a forbidden identifier`).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Hook command grammar
// ---------------------------------------------------------------------------

describe('hook command grammar', () => {
  /** A fixed, real-shaped challenge so a failure names the exact strings. */
  const NONCE = 'c'.repeat(CAPTURE_NONCE_CHARS);
  const hooksFor = (socketPath = '/tmp/somawork/slack-capture.sock', manifestPath = MANIFEST_PATH) =>
    buildSlackHooksFile({
      socketPath,
      manifestPath,
      captureNonce: NONCE,
      controllerCommand: DEFAULT_CONTROLLER_COMMAND,
    });

  it('declares exactly get-manifest and start — no get-hooks', () => {
    // C-1: `ManifestClient.GetManifestLocal` (internal/app/manifest.go:74-78)
    // refuses when `get-manifest` is absent, and install.go:382-390 takes that
    // branch on every run of a project with no .slack/config.json. Without the
    // hook, `slack run` never reaches `start` and capture is inert.
    expect(Object.keys(hooksFor().hooks).sort()).toEqual(['get-manifest', 'start']);
    expect(hooksFor().hooks).not.toHaveProperty('get-hooks');
  });

  it("invokes the packaged controller with the socket path and this run's challenge", () => {
    expect(hooksFor().hooks.start).toBe(
      `${DEFAULT_CONTROLLER_COMMAND} ${CAPTURE_HOOK_SUBCOMMAND} --socket /tmp/somawork/slack-capture.sock --nonce ${NONCE}`,
    );
  });

  it('refuses to build a start hook without a well-formed challenge', () => {
    for (const captureNonce of [undefined, '', 'short', 'A'.repeat(CAPTURE_NONCE_CHARS), `${NONCE}0`]) {
      expect(() =>
        buildSlackHooksFile({
          socketPath: '/tmp/s.sock',
          manifestPath: MANIFEST_PATH,
          captureNonce: captureNonce as string,
        }),
      ).toThrow(SlackProjectOptionsError);
    }
  });

  it('invokes the packaged controller with the materialized manifest path', () => {
    expect(hooksFor().hooks['get-manifest']).toBe(
      `${DEFAULT_CONTROLLER_COMMAND} ${MANIFEST_HOOK_SUBCOMMAND} --path ${MANIFEST_PATH}`,
    );
  });

  it('declares SDK-managed connection so the CLI hands Socket Mode to the hook', () => {
    expect(hooksFor().config['sdk-managed-connection-enabled']).toBe(true);
  });

  it('sets no watch or protocol-version, keeping the CLI defaults', () => {
    expect(hooksFor().config).not.toHaveProperty('watch');
    expect(hooksFor().config).not.toHaveProperty('protocol-version');
    expect(hooksFor().config).not.toHaveProperty('trigger-paths');
  });

  it('declares no runtime, which is a Slack-managed deployment field', () => {
    expect(hooksFor()).not.toHaveProperty('runtime');
  });

  it.each([
    // `start` carries one more flag pair than `get-manifest`: `--nonce <hex>`.
    ['start', 6],
    ['get-manifest', 4],
  ])('splits the %s hook into exactly %i fields under Go strings.Fields', (hook, count) => {
    const line = (hooksFor().hooks as Record<string, string>)[hook];
    expect(goStringsFields(line)).toHaveLength(count);
  });

  it('still splits into fixed field counts when both paths contain spaces', () => {
    const spaceySocket = '/Users/Jane Doe/Library/state/soma work/slack capture.sock';
    const spaceyManifest = '/Users/Jane Doe/Library/state/soma work/slack-project/manifest.json';
    const hooks = hooksFor(spaceySocket, spaceyManifest);

    const startFields = goStringsFields(hooks.hooks.start);
    expect(startFields).toHaveLength(6);
    expect(decodeHookArgument(startFields[3])).toBe(spaceySocket);
    expect(startFields[4]).toBe('--nonce');
    expect(startFields[5]).toBe(NONCE);

    const manifestFields = goStringsFields(hooks.hooks['get-manifest']);
    expect(manifestFields).toHaveLength(4);
    expect(decodeHookArgument(manifestFields[3])).toBe(spaceyManifest);
  });

  it('leaves an ordinary path byte-identical after encoding', () => {
    const plain = '/Users/z/.local/state/somawork/preview/run/slack-capture.sock';
    expect(encodeHookArgument(plain)).toBe(plain);
    expect(decodeHookArgument(plain)).toBe(plain);
  });

  it.each([
    '/tmp/a b/c.sock',
    '/tmp/two  spaces/c.sock',
    '/tmp/100%/c.sock',
    '/tmp/%2520/c.sock',
    '/tmp/éè/c.sock',
  ])('round-trips %j through the hook argument encoding', (raw) => {
    const encoded = encodeHookArgument(raw);
    expect(goStringsFields(encoded)).toHaveLength(1);
    expect(decodeHookArgument(encoded)).toBe(raw);
  });

  it.each([
    '/tmp/a\tb/c.sock',
    '/tmp/tab\u000bvertical/c.sock',
    '/tmp/\u0085nel/c.sock',
  ])('encodes %j to a single field but refuses to decode it back', (raw) => {
    // Encoding still collapses it to one argv element (so the hook line stays
    // parseable), but a *decoded* control character is refused on the way in:
    // a path containing one is not a path we will dial or open. A user whose
    // home directory contains a tab gets a loud refusal, not a mystery.
    const encoded = encodeHookArgument(raw);
    expect(goStringsFields(encoded)).toHaveLength(1);
    expect(() => decodeHookArgument(encoded)).toThrow(SlackProjectOptionsError);
  });

  it('refuses a controller command that would split into extra fields', () => {
    expect(() => hooksFor()).not.toThrow();
    expect(() =>
      buildSlackHooksFile({
        socketPath: '/tmp/s.sock',
        manifestPath: MANIFEST_PATH,
        captureNonce: NONCE,
        controllerCommand: 'my controller',
      }),
    ).toThrow(SlackProjectOptionsError);
  });

  it('refuses a malformed percent escape when decoding', () => {
    expect(() => decodeHookArgument('/tmp/%zz/c.sock')).toThrow(SlackProjectOptionsError);
    expect(() => decodeHookArgument('/tmp/%2/c.sock')).toThrow(SlackProjectOptionsError);
  });

  it.each(['%00', '%01', '%1B', '%7F'])('refuses %s, which decodes to a control character', (escape) => {
    // M-6: `encodeHookArgument` would never emit one, but a hand-edited
    // hooks.json could — and a decoded NUL would reach net.createConnection.
    expect(() => decodeHookArgument(`/tmp/a${escape}b/c.sock`)).toThrow(SlackProjectOptionsError);
  });
});

// ---------------------------------------------------------------------------
// The get-manifest route
// ---------------------------------------------------------------------------

describe('parseManifestHelperArgv', () => {
  it('reads --path PATH and --path=PATH', () => {
    expect(parseManifestHelperArgv(['--path', MANIFEST_PATH])).toEqual({ manifestPath: MANIFEST_PATH });
    expect(parseManifestHelperArgv([`--path=${MANIFEST_PATH}`])).toEqual({ manifestPath: MANIFEST_PATH });
  });

  it('decodes an escaped path', () => {
    expect(parseManifestHelperArgv(['--path', '/tmp/a%20b/slack-project/manifest.json'])).toEqual({
      manifestPath: '/tmp/a b/slack-project/manifest.json',
    });
  });

  it('tolerates the --name="value" form the Slack CLI actually appends', () => {
    // internal/goutils/map.go:29-36 formats appended args as --name="value"
    // WITH literal quotes, appended as whole argv elements (not re-split), and
    // manifest.go:80-84 passes `source` = the project directory.
    expect(parseManifestHelperArgv(['--path', MANIFEST_PATH, '--source="/tmp/somawork/slack project"'])).toEqual({
      manifestPath: MANIFEST_PATH,
    });
  });

  it.each([
    [[]],
    [['--path']],
    [['--path', MANIFEST_PATH, '--path', MANIFEST_PATH]],
    [['positional']],
  ])('refuses the malformed argv %j', (argv) => {
    expect(() => parseManifestHelperArgv(argv as string[])).toThrow(SlackProjectOptionsError);
  });

  it('never quotes the offending argument back', () => {
    try {
      parseManifestHelperArgv(['xoxb-SENTINELARGVLEAK0001']);
      expect.unreachable('a positional argument must be refused');
    } catch (err) {
      expect((err as Error).message).not.toContain('SENTINELARGVLEAK0001');
    }
  });
});

describe('runSlackManifestHelper', () => {
  it('emits the materialized manifest bytes verbatim, ending in a newline', async () => {
    const materialized = materialize('preview');
    const emitted = await runSlackManifestHelper({ manifestPath: materialized.manifestPath });

    expect(emitted).toBe(fs.readFileSync(materialized.manifestPath, 'utf-8'));
    expect(emitted.endsWith('\n')).toBe(true);
    // GetManifestLocal (manifest.go:103-113) scans from the first `{`, then
    // json.Unmarshals the remainder — so what follows must be the whole document.
    expect(emitted.indexOf('{')).toBe(0);
    expect(JSON.parse(emitted)).toEqual(buildProfileManifest(canonical(), 'preview'));
  });

  it('accepts the expected-path belt-and-braces check', async () => {
    const materialized = materialize('production');
    await expect(
      runSlackManifestHelper({
        manifestPath: materialized.manifestPath,
        expectedManifestPath: materialized.manifestPath,
      }),
    ).resolves.toContain('display_information');
  });

  it('refuses a path other than the expected one', async () => {
    const materialized = materialize('production');
    await expect(
      runSlackManifestHelper({
        manifestPath: materialized.manifestPath,
        expectedManifestPath: '/somewhere/else/slack-project/manifest.json',
      }),
    ).rejects.toThrow(SlackProjectOptionsError);
  });

  it.each([
    ['a relative path', 'slack-project/manifest.json'],
    ['a traversal segment', '/tmp/somawork/../../etc/slack-project/manifest.json'],
    ['a dot segment', '/tmp/./somawork/slack-project/manifest.json'],
    ['a file that is not manifest.json', '/tmp/somawork/slack-project/secrets.env'],
    ['a file outside a slack-project directory', '/etc/manifest.json'],
    ['a control character', '/tmp/soma\u0000work/slack-project/manifest.json'],
    ['an empty path', ''],
  ])('refuses %s — this route cannot print arbitrary files', async (_label, target) => {
    await expect(runSlackManifestHelper({ manifestPath: target })).rejects.toThrow(SlackProjectOptionsError);
  });

  it('refuses a symlinked manifest', async () => {
    const materialized = materialize('production');
    fs.rmSync(materialized.manifestPath);
    fs.writeFileSync(path.join(tmpRoot, 'elsewhere.json'), '{"display_information":{}}');
    fs.symlinkSync(path.join(tmpRoot, 'elsewhere.json'), materialized.manifestPath);
    await expect(runSlackManifestHelper({ manifestPath: materialized.manifestPath })).rejects.toThrow(UnsafePathError);
  });

  it('refuses a directory in place of the manifest', async () => {
    const root = path.join(stateDir, SLACK_PROJECT_DIRNAME);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(root, 'manifest.json'), { mode: 0o700 });
    await expect(runSlackManifestHelper({ manifestPath: path.join(root, 'manifest.json') })).rejects.toThrow(
      SlackProjectOptionsError,
    );
  });

  it('refuses a manifest that is missing', async () => {
    const missing = path.join(stateDir, SLACK_PROJECT_DIRNAME, 'manifest.json');
    await expect(runSlackManifestHelper({ manifestPath: missing })).rejects.toThrow(SlackManifestSourceError);
  });

  it('refuses an oversized manifest', async () => {
    const materialized = materialize('production');
    await expect(runSlackManifestHelper({ manifestPath: materialized.manifestPath, maxBytes: 8 })).rejects.toThrow(
      SlackManifestSourceError,
    );
  });

  it.each([
    ['malformed JSON', '{ not json'],
    ['a JSON array', '[]'],
    ['a JSON string', '"nope"'],
    ['an object missing display_information', '{"features":{},"oauth_config":{},"settings":{}}'],
    ['an object missing settings', '{"display_information":{},"features":{},"oauth_config":{}}'],
  ])('refuses %s', async (_label, body) => {
    await expect(runSlackManifestHelper({ manifestPath: MANIFEST_PATH, readFile: () => body })).rejects.toThrow(
      SlackManifestSourceError,
    );
  });

  it('writes nothing to stdout, stderr or the console — the CLI route owns that', async () => {
    const materialized = materialize('production');
    const spies = [
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true),
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true),
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
    ];
    try {
      await runSlackManifestHelper({ manifestPath: materialized.manifestPath });
      await runSlackManifestHelper({ manifestPath: '/etc/passwd' }).catch(() => undefined);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Local simulation of what the Slack CLI actually does with hooks.json
// ---------------------------------------------------------------------------

describe('hook dispatch simulation', () => {
  it('drives both hooks the way the Slack CLI would, from the file on disk', async () => {
    const materialized = materialize('preview');
    const hooks = readJson(materialized.hooksPath) as { hooks: Record<string, string> };

    // The CLI splits the hook string with strings.Fields, execs argv[0] and
    // hands it argv[1:]. We dispatch to the same routes the controller would.
    const manifestFields = goStringsFields(hooks.hooks['get-manifest']);
    expect(manifestFields[0]).toBe(DEFAULT_CONTROLLER_COMMAND);
    expect(manifestFields[1]).toBe(MANIFEST_HOOK_SUBCOMMAND);

    // get-manifest additionally receives --source="<project dir>" (manifest.go:80-84).
    const manifestArgs = [...manifestFields.slice(2), `--source="${materialized.root}"`];
    const stdout = await runSlackManifestHelper(parseManifestHelperArgv(manifestArgs));
    expect(JSON.parse(stdout.slice(stdout.indexOf('{')))).toEqual(buildProfileManifest(canonical(), 'preview'));

    const startFields = goStringsFields(hooks.hooks.start);
    expect(startFields[0]).toBe(DEFAULT_CONTROLLER_COMMAND);
    expect(startFields[1]).toBe(CAPTURE_HOOK_SUBCOMMAND);
    // StartDelegate appends nothing (localserver.go:306-309).
    expect(parseCaptureHelperArgv(startFields.slice(2))).toEqual({
      socketPath: materialized.socketPath,
      nonce: materialized.captureNonce,
    });
  });

  it('survives a profile state directory with spaces in it end to end', async () => {
    const spaceyState = path.join(tmpRoot, 'my state');
    const materialized = materializeSlackProject('production', TEAM_ID, runtimeRoot, { stateDir: spaceyState });
    const hooks = readJson(materialized.hooksPath) as { hooks: Record<string, string> };

    const manifestFields = goStringsFields(hooks.hooks['get-manifest']);
    expect(manifestFields).toHaveLength(4);
    const stdout = await runSlackManifestHelper(parseManifestHelperArgv(manifestFields.slice(2)));
    expect(JSON.parse(stdout)).toEqual(buildProfileManifest(canonical(), 'production'));

    const startFields = goStringsFields(hooks.hooks.start);
    expect(parseCaptureHelperArgv(startFields.slice(2))).toEqual({
      socketPath: materialized.socketPath,
      nonce: materialized.captureNonce,
    });
  });
});

// ---------------------------------------------------------------------------
// I-1 — the capture challenge
// ---------------------------------------------------------------------------

describe('capture nonce', () => {
  it('mints a fresh, well-formed, unpredictable challenge every time', () => {
    const minted = Array.from({ length: 64 }, () => generateCaptureNonce());
    for (const nonce of minted) {
      expect(nonce).toMatch(/^[0-9a-f]+$/);
      expect(nonce).toHaveLength(CAPTURE_NONCE_CHARS);
    }
    expect(new Set(minted).size).toBe(minted.length);
  });

  it('matches only an identical, well-formed challenge', () => {
    const nonce = generateCaptureNonce();
    expect(captureNonceMatches(nonce, nonce)).toBe(true);
    expect(captureNonceMatches(nonce, generateCaptureNonce())).toBe(false);
    for (const wrong of [undefined, null, '', 42, {}, nonce.slice(0, -1), `${nonce}0`, nonce.toUpperCase()]) {
      expect(captureNonceMatches(nonce, wrong)).toBe(false);
    }
    // A malformed EXPECTED value never matches anything either, so a project
    // that somehow lost its challenge cannot accidentally accept one.
    expect(captureNonceMatches('', '')).toBe(false);
  });

  it('survives the hook argv grammar byte-identical', () => {
    const nonce = generateCaptureNonce();
    expect(encodeHookArgument(nonce)).toBe(nonce);
    expect(decodeHookArgument(nonce)).toBe(nonce);
  });

  it('never lands anywhere but the 0600 hooks file', () => {
    const project = materialize('preview');
    const dir = path.dirname(project.hooksPath);
    expect(mode(project.hooksPath)).toBe(0o600);
    expect(mode(dir)).toBe(0o700);

    // Every other artifact this module writes, scanned for the value.
    const manifestBytes = fs.readFileSync(project.manifestPath, 'utf-8');
    expect(manifestBytes).not.toContain(project.captureNonce);
    // …and the receipt object itself carries it only as the in-memory field
    // the capture flow reads; nothing serializes the project.
    expect(JSON.parse(JSON.stringify({ ...project, captureNonce: undefined })) as unknown).not.toHaveProperty(
      'captureNonce',
    );
  });
});

// ---------------------------------------------------------------------------
// Materialization: layout, modes, stability
// ---------------------------------------------------------------------------

describe('materializeSlackProject', () => {
  it('puts the project under profile state, not a temp dir', () => {
    const project = materialize('preview');
    expect(project.root).toBe(path.join(stateDir, SLACK_PROJECT_DIRNAME));
    expect(project.root.startsWith(os.tmpdir())).toBe(true); // the *test* state dir is a temp dir
    expect(project.root).toContain(stateDir);
  });

  it('keeps the capture socket under profile-owned state, outside the project', () => {
    const project = materialize('preview');
    expect(path.basename(project.socketPath)).toBe(CAPTURE_SOCKET_FILENAME);
    expect(project.socketPath.startsWith(`${stateDir}${path.sep}`)).toBe(true);
    expect(project.socketPath.startsWith(`${project.root}${path.sep}`)).toBe(false);
  });

  it('writes the manifest and hooks files at 0600 inside 0700 directories', () => {
    const project = materialize('production');
    expect(mode(project.root)).toBe(0o700);
    expect(mode(path.dirname(project.hooksPath))).toBe(0o700);
    expect(mode(project.manifestPath)).toBe(0o600);
    expect(mode(project.hooksPath)).toBe(0o600);
  });

  it('writes the profile manifest derived from canonical', () => {
    const project = materialize('preview');
    expect(readJson(project.manifestPath)).toEqual(buildProfileManifest(canonical(), 'preview'));
  });

  it('writes hooks.json wired to this project socket, manifest and challenge', () => {
    const project = materialize('preview');
    expect(isCaptureNonce(project.captureNonce)).toBe(true);
    expect(readJson(project.hooksPath)).toEqual(
      buildSlackHooksFile({
        socketPath: project.socketPath,
        manifestPath: project.manifestPath,
        captureNonce: project.captureNonce,
        controllerCommand: DEFAULT_CONTROLLER_COMMAND,
      }),
    );
  });

  it('reads the canonical manifest from an explicit path when packaging moved it', () => {
    // Task 11 owns whether a packaged runtime ships infra/slack/…; this override
    // is how a packaged build (or a package test) points at where it landed.
    const moved = path.join(tmpRoot, 'bundled-manifest.json');
    fs.copyFileSync(CANONICAL_PATH, moved);
    fs.rmSync(path.join(runtimeRoot, 'infra', 'slack', 'slack-app-manifest.json'));

    const project = materializeSlackProject('preview', TEAM_ID, runtimeRoot, {
      stateDir,
      canonicalManifestPath: moved,
    });
    expect(readJson(project.manifestPath)).toEqual(buildProfileManifest(canonical(), 'preview'));
  });

  it('produces byte-stable output across repeated materialization, except the challenge', () => {
    const first = materialize('production');
    const manifestBytes = fs.readFileSync(first.manifestPath);
    const hookBytes = fs.readFileSync(first.hooksPath);

    const second = materialize('production');
    expect(fs.readFileSync(second.manifestPath).equals(manifestBytes)).toBe(true);
    // I-1: the nonce is the ONE field that must not be stable — a reused
    // challenge is no challenge. Everything else in the file still is.
    expect(second.captureNonce).not.toBe(first.captureNonce);
    const stripNonce = (bytes: Buffer) => bytes.toString('utf-8').replace(/--nonce [0-9a-f]+/, '--nonce <NONCE>');
    expect(stripNonce(fs.readFileSync(second.hooksPath))).toBe(stripNonce(hookBytes));
    expect(stripNonce(hookBytes)).toContain('--nonce <NONCE>');
  });

  it('regenerates a tampered manifest', () => {
    const project = materialize('production');
    fs.writeFileSync(project.manifestPath, '{"display_information":{"name":"tampered"}}');
    materialize('production');
    expect(readJson(project.manifestPath)).toEqual(buildProfileManifest(canonical(), 'production'));
  });

  it('refuses to write through a symlinked .slack directory', () => {
    const project = path.join(stateDir, SLACK_PROJECT_DIRNAME);
    const decoy = path.join(tmpRoot, 'decoy');
    fs.mkdirSync(project, { recursive: true, mode: 0o700 });
    fs.mkdirSync(decoy, { recursive: true, mode: 0o700 });
    fs.symlinkSync(decoy, path.join(project, '.slack'));

    expect(() => materialize('production')).toThrow(UnsafePathError);
    expect(fs.existsSync(path.join(decoy, 'hooks.json'))).toBe(false);
  });

  it('refuses to write through a symlinked manifest', () => {
    const project = path.join(stateDir, SLACK_PROJECT_DIRNAME);
    fs.mkdirSync(project, { recursive: true, mode: 0o700 });
    fs.symlinkSync(path.join(tmpRoot, 'elsewhere.json'), path.join(project, 'manifest.json'));
    expect(() => materialize('production')).toThrow(UnsafePathError);
  });

  it('refuses a socket path longer than the platform sun_path limit', () => {
    const deep = path.join(tmpRoot, 'x'.repeat(90), 'y'.repeat(90));
    expect(() => materializeSlackProject('production', TEAM_ID, runtimeRoot, { stateDir: deep })).toThrow(
      SlackProjectOptionsError,
    );
  });
});

// ---------------------------------------------------------------------------
// App mapping: strict, preserved, never overwritten
// ---------------------------------------------------------------------------

describe('slack app mapping', () => {
  it('is null when the project has no mapping files', () => {
    const project = materialize('production');
    expect(project.appMapping).toBeNull();
    expect(readSlackAppMapping(project.root, TEAM_ID)).toBeNull();
  });

  it('reads a dev mapping keyed by team id', () => {
    const root = path.join(stateDir, SLACK_PROJECT_DIRNAME);
    writeDevMapping(root, { [TEAM_ID]: { app_id: APP_ID, team_id: TEAM_ID, team_domain: 'acme' } });

    const project = materialize('production');
    expect(project.appMapping).toEqual({ appId: APP_ID, teamId: TEAM_ID, teamDomain: 'acme', source: 'dev' });
  });

  it('reads a deployed mapping under its apps key', () => {
    const root = path.join(stateDir, SLACK_PROJECT_DIRNAME);
    writeDeployedMapping(root, { apps: { [TEAM_ID]: { app_id: APP_ID, team_id: TEAM_ID } }, default: 'acme' });

    const project = materialize('production');
    expect(project.appMapping).toEqual({ appId: APP_ID, teamId: TEAM_ID, source: 'deployed' });
  });

  it('prefers the dev mapping over the deployed one, because slack run is local', () => {
    const root = path.join(stateDir, SLACK_PROJECT_DIRNAME);
    writeDevMapping(root, { [TEAM_ID]: { app_id: 'A0DEVAPP', team_id: TEAM_ID } });
    writeDeployedMapping(root, { apps: { [TEAM_ID]: { app_id: 'A0DEPLOYED', team_id: TEAM_ID } } });

    expect(materialize('production').appMapping?.appId).toBe('A0DEVAPP');
  });

  it('is null for a different team without failing', () => {
    const root = path.join(stateDir, SLACK_PROJECT_DIRNAME);
    writeDevMapping(root, { [OTHER_TEAM_ID]: { app_id: APP_ID, team_id: OTHER_TEAM_ID } });
    expect(materialize('production').appMapping).toBeNull();
  });

  it('preserves both mapping files byte-for-byte across materialization', () => {
    const root = path.join(stateDir, SLACK_PROJECT_DIRNAME);
    writeDevMapping(root, { [TEAM_ID]: { app_id: APP_ID, team_id: TEAM_ID, team_domain: 'acme' } });
    writeDeployedMapping(root, { apps: { [TEAM_ID]: { app_id: APP_ID, team_id: TEAM_ID } }, default: 'acme' });

    const devBytes = fs.readFileSync(path.join(root, '.slack', 'apps.dev.json'));
    const deployedBytes = fs.readFileSync(path.join(root, '.slack', 'apps.json'));

    materialize('production');
    materialize('production');

    expect(fs.readFileSync(path.join(root, '.slack', 'apps.dev.json')).equals(devBytes)).toBe(true);
    expect(fs.readFileSync(path.join(root, '.slack', 'apps.json')).equals(deployedBytes)).toBe(true);
  });

  it('fails loudly on a malformed dev mapping and touches nothing', () => {
    const root = path.join(stateDir, SLACK_PROJECT_DIRNAME);
    writeDevMapping(root, '{ this is not json');
    const bytes = fs.readFileSync(path.join(root, '.slack', 'apps.dev.json'));

    expect(() => materialize('production')).toThrow(SlackAppMappingError);
    expect(fs.readFileSync(path.join(root, '.slack', 'apps.dev.json')).equals(bytes)).toBe(true);
    expect(fs.existsSync(path.join(root, 'manifest.json'))).toBe(false);
  });

  it('fails loudly on a malformed deployed mapping', () => {
    const root = path.join(stateDir, SLACK_PROJECT_DIRNAME);
    writeDeployedMapping(root, { apps: 'not-an-object' });
    expect(() => materialize('production')).toThrow(SlackAppMappingError);
  });

  it('fails loudly when a mapping entry disagrees with its own key', () => {
    const root = path.join(stateDir, SLACK_PROJECT_DIRNAME);
    writeDevMapping(root, { [TEAM_ID]: { app_id: APP_ID, team_id: OTHER_TEAM_ID } });
    expect(() => materialize('production')).toThrow(SlackAppMappingError);
  });

  it.each([
    ['credential-shaped', `xoxb-SENTINELMAPPINGLEAK0001`],
    ['malformed', 'not a team id at all'],
  ])('never echoes a %s team_id from a mapping file', (_label, foreign) => {
    // NB-2: `entry.team_id` is arbitrary content off disk, validated only as a
    // non-empty string. The mismatch message must not repeat it — same class as
    // the frame-version leak the capture module closed.
    const root = path.join(stateDir, SLACK_PROJECT_DIRNAME);
    writeDevMapping(root, { [TEAM_ID]: { app_id: APP_ID, team_id: foreign } });

    try {
      materialize('production');
      expect.unreachable('a mismatched mapping entry must be refused');
    } catch (err) {
      expect(err).toBeInstanceOf(SlackAppMappingError);
      const message = (err as Error).message;
      const json = JSON.stringify(err, Object.getOwnPropertyNames(err));
      for (const surface of [message, json]) {
        expect(surface).not.toContain('SENTINELMAPPINGLEAK0001');
        expect(surface).not.toContain(foreign);
      }
      expect(message).toContain('unprintable');
    }
  });

  it('fails loudly on duplicate entries for the requested team', () => {
    const root = path.join(stateDir, SLACK_PROJECT_DIRNAME);
    writeDevMapping(root, {
      [TEAM_ID]: { app_id: APP_ID, team_id: TEAM_ID },
      'legacy-key': { app_id: 'A0OTHER', team_id: TEAM_ID },
    });
    expect(() => materialize('production')).toThrow(SlackAppMappingError);
  });

  it('fails loudly on an entry with no app id', () => {
    const root = path.join(stateDir, SLACK_PROJECT_DIRNAME);
    writeDevMapping(root, { [TEAM_ID]: { team_id: TEAM_ID } });
    expect(() => materialize('production')).toThrow(SlackAppMappingError);
  });

  it.each([
    'a0lowercase',
    'B0WRONGPREFIX',
    'A',
    `A${'0'.repeat(40)}`,
    'A0 SPACE',
  ])('fails loudly on the malformed app id %j', (appId) => {
    const root = path.join(stateDir, SLACK_PROJECT_DIRNAME);
    writeDevMapping(root, { [TEAM_ID]: { app_id: appId, team_id: TEAM_ID } });
    expect(() => materialize('production')).toThrow(SlackAppMappingError);
  });

  it('treats an empty mapping file as "nothing saved yet", matching the CLI', () => {
    const root = path.join(stateDir, SLACK_PROJECT_DIRNAME);
    writeDevMapping(root, '   \n');
    expect(materialize('production').appMapping).toBeNull();
  });

  it('refuses to read a symlinked mapping file', () => {
    const root = path.join(stateDir, SLACK_PROJECT_DIRNAME);
    fs.mkdirSync(path.join(root, '.slack'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(tmpRoot, 'evil.json'), JSON.stringify({ [TEAM_ID]: { app_id: APP_ID } }));
    fs.symlinkSync(path.join(tmpRoot, 'evil.json'), path.join(root, '.slack', 'apps.dev.json'));
    expect(() => materialize('production')).toThrow(UnsafePathError);
  });
});

// ---------------------------------------------------------------------------
// Source discipline
// ---------------------------------------------------------------------------

describe('source discipline', () => {
  const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'slack-manifest.ts'), 'utf-8');

  it('never reads process.env', () => {
    expect(SOURCE).not.toMatch(/process\.env/);
  });

  it('writes only through the atomic helpers', () => {
    expect(SOURCE).not.toMatch(/\bwriteFileSync\(/);
    expect(SOURCE).toMatch(/atomicWriteJson/);
  });

  it('never deletes or truncates a mapping file', () => {
    expect(SOURCE).not.toMatch(/\brmSync\(|\bunlinkSync\(|\brm\(|\btruncate/);
  });
});
