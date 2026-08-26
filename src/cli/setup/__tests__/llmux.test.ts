/**
 * Task 4 — local llmux installation + Claude/Codex onboarding adapter.
 *
 * Every case here runs against {@link FakeHost}: no llmux binary, no daemon, no
 * browser, no wall clock. The two exceptions are deliberate and named — the
 * source-byte scan reads the files off disk, and the chunk-split streaming case
 * runs a real `/bin/sh` through the reviewed {@link RealHost} because that is
 * the only way to prove line assembly across a real pipe boundary.
 *
 * The fixtures reproduce the *verified* llmux surface (`src/cli/accounts.rs:20-134`,
 * `src/cli/status.rs:120-142`, `src/cli/daemon.rs:25,196-216,235-269`,
 * `src/auth/oauth.rs:155-171`), so a contract drift in llmux shows up here as a
 * loud failure rather than as a silent "nothing configured".
 *
 * Identities and credentials in the fixtures are fictional and act as
 * **sentinels**: the last describe block proves none of them — nor any raw
 * stdout — reaches a receipt, a progress line, the recorded call log, or a
 * thrown error.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { type FakeCommandResponse, FakeHost, type FakeSpawnBehavior, type RecordedCall } from '../fake-host';
import type { CommandSpec } from '../host';
import {
  classifyLlmuxAccounts,
  emitProgressLines,
  ensureLlmux,
  LlmuxCancelledError,
  LlmuxCommandError,
  LlmuxContractError,
  LlmuxCooldownError,
  LlmuxInstallError,
  LlmuxLoginError,
  LlmuxOptionsError,
  LlmuxReadinessTimeoutError,
  LlmuxRemoteModeError,
  LlmuxRestartError,
  LlmuxUnhealthyError,
} from '../llmux';
import { RealHost } from '../real-host';
import { assertSecretFree } from '../state';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const LLMUX_BIN = '/opt/homebrew/bin/llmux';
const BREW_BIN = '/opt/homebrew/bin/brew';

/** Fictional identities and a fictional credential, used as leak sentinels. */
const CLAUDE_ACCOUNT = 'zelda-oauth@example.test';
const CODEX_ACCOUNT = 'zelda-codex@example.test';
const APIKEY_MASK = '****SENTINELKEY9';
const RAW_STDOUT_SENTINEL = 'RAW-STDOUT-SENTINEL-9f3a';
const CREDENTIAL_SENTINEL = 'sk-ant-oat01-SENTINELtoken1234';
/**
 * The proxy api key `llmux env` prints when one is configured
 * (`src/cli/env.rs:19-21`).
 *
 * Deliberately shaped like NOTHING the redactor recognises
 * (`packages/common/src/logger.ts:34-56` knows `sk-ant-`, `lmk-`, Slack and
 * GitHub families, and `ANTHROPIC_API_KEY=` is not one of its key/value names).
 * A `llmux.json` `proxy.api_key` is an arbitrary operator-chosen string, so
 * `CommandResult.stdout` — the *redacted* view — carries it verbatim. Finding
 * this sentinel anywhere therefore proves a real leak rather than a redaction
 * gap, and it is why the env step reads `unsafeRawStdout()` at the parser and
 * never touches the redacted view.
 */
const PROXY_API_KEY_SENTINEL = 'PROXYKEY-SENTINEL-7c1e9b';

const SENTINELS = [
  CLAUDE_ACCOUNT,
  CODEX_ACCOUNT,
  APIKEY_MASK,
  RAW_STDOUT_SENTINEL,
  CREDENTIAL_SENTINEL,
  PROXY_API_KEY_SENTINEL,
];

/** `llmux accounts` with an empty config (`accounts.rs:30-34`). */
const ROSTER_EMPTY = ['No accounts configured.', 'Add one with: llmux import, llmux login, or llmux login --api'].join(
  '\n',
);

const rosterOauth = (tier?: string) => `  [1] ${CLAUDE_ACCOUNT} (oauth${tier ? `, ${tier}` : ''})`;
const rosterCodex = (index = 1) => `  [${index}] ${CODEX_ACCOUNT} (codex)`;
const rosterApikey = () => `  [1] ${CLAUDE_ACCOUNT} (apikey)  ${APIKEY_MASK}`;

/** Claude OAuth (with tier) + Codex — the "already fully configured" roster. */
const ROSTER_BOTH = [rosterOauth('max20'), rosterCodex(2)].join('\n');

/** What `llmux login` prints before firing `open` (`oauth.rs:155-171`). */
const OAUTH_GUIDANCE = [
  'Opening browser for authentication...',
  "If it doesn't open, visit:",
  '  https://claude.ai/oauth/authorize',
  '',
].join('\n');

/** The `/llmux/status` document slice `accounts --json` prints on exit 0. */
const liveDoc = (accounts: Array<{ group: string; status: string; name?: string }>) =>
  `${JSON.stringify(
    {
      server: 'running',
      note: RAW_STDOUT_SENTINEL,
      current: CLAUDE_ACCOUNT,
      current_by_group: { claude: CLAUDE_ACCOUNT, codex: CODEX_ACCOUNT },
      accounts: accounts.map((a, i) => ({
        name: a.name ?? `${a.group}-acct@example.test`,
        group: a.group,
        status: a.status,
        order: i + 1,
        in_flight: 0,
      })),
    },
    null,
    2,
  )}\n`;

const HEALTHY_BOTH = liveDoc([
  { group: 'claude', status: 'active', name: CLAUDE_ACCOUNT },
  { group: 'codex', status: 'ok', name: CODEX_ACCOUNT },
]);

/** `ServerProbe::NotRunning` — exit 1 with a JSON body (`accounts.rs:120-126`). */
const NOT_RUNNING = `${JSON.stringify({ server: 'not running', port: 3456 }, null, 2)}\n`;

/** llmux's own local endpoint contract: `http://localhost:<proxy.port>` (`cli/mod.rs:544`). */
const DEFAULT_ENDPOINT = 'http://localhost:3456';

/**
 * `llmux env` output (`src/cli/env.rs:18-21`): one `export` line for the base
 * URL, and the proxy api key line only when the config sets one.
 */
const envOutput = (baseUrl: string, apiKey?: string) =>
  `${[
    `export ANTHROPIC_BASE_URL=${baseUrl}`,
    ...(apiKey === undefined ? [] : [`export ANTHROPIC_API_KEY=${apiKey}`]),
  ].join('\n')}\n`;

// ---------------------------------------------------------------------------
// Matchers — exact argv arrays, so `accounts` never shadows `accounts --json`
// ---------------------------------------------------------------------------

/**
 * Exact-argv matcher. Array equality, deliberately: a joined-string matcher
 * needs a separator, and the separator is exactly where the previous revision
 * put a raw control byte.
 */
const argv = (...expected: string[]) => {
  return (spec: CommandSpec) => {
    const actual = spec.args ?? [];
    return spec.command === LLMUX_BIN && actual.length === expected.length && actual.every((a, i) => a === expected[i]);
  };
};

const ACCOUNTS = argv('accounts');
const ACCOUNTS_JSON = argv('accounts', '--json');
const LOGIN = argv('login');
const LOGIN_CODEX = argv('login', '--codex');
const RESTART = argv('restart');
const ENV = argv('env');

/** Argv of every recorded `command` call. */
const commandLines = (host: FakeHost): string[] =>
  host.calls.flatMap((c) => (c.kind === 'command' ? [[c.command, ...c.args].join(' ')] : []));

/** Argv of every recorded `command` *and* `spawn` call, in order. */
const callLines = (host: FakeHost): string[] =>
  host.calls.flatMap((c) => (c.kind === 'command' || c.kind === 'spawn' ? [[c.command, ...c.args].join(' ')] : []));

const kills = (host: FakeHost): RecordedCall[] => host.calls.filter((c) => c.kind === 'kill');

/**
 * A host with llmux installed and a working roster. Logins succeed silently
 * unless the caller scripts them.
 *
 * Login behaviour is a *parameter*, not a later `stubSpawn` call: FakeHost
 * resolves general stubs in registration order, so a default registered here
 * would permanently shadow a per-test override added afterwards.
 */
function installedHost(
  roster: string,
  logins: { claude?: FakeSpawnBehavior; codex?: FakeSpawnBehavior } = {},
): FakeHost {
  return new FakeHost()
    .stubWhich('llmux', LLMUX_BIN)
    .stubCommand(ACCOUNTS, { stdout: roster })
    .stubCommand(ENV, { stdout: envOutput(DEFAULT_ENDPOINT) })
    .stubSpawn(LOGIN, logins.claude ?? {})
    .stubSpawn(LOGIN_CODEX, logins.codex ?? {});
}

/** …plus a successful restart and a healthy live document. */
const healthyDaemon = (host: FakeHost) =>
  host.stubCommand(RESTART, {}).stubCommand(ACCOUNTS_JSON, { stdout: HEALTHY_BOTH });

// ---------------------------------------------------------------------------
// C-1 — the files must be text
// ---------------------------------------------------------------------------

describe('source bytes', () => {
  const files = ['src/cli/setup/llmux.ts', 'src/cli/setup/__tests__/llmux.test.ts'];

  it.each(files)('%s contains no NUL byte, so grep/rg/git diff can read it', (relative) => {
    const absolute = path.join(process.cwd(), relative);
    // Guard the guard: a wrong path must fail, not vacuously pass.
    expect(fs.existsSync(absolute)).toBe(true);
    const bytes = fs.readFileSync(absolute);
    expect(bytes.length).toBeGreaterThan(1000);
    expect(bytes.indexOf(0)).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

describe('ensureLlmux — installation', () => {
  it('skips installation when llmux is already on PATH', async () => {
    const receipt = await ensureLlmux(healthyDaemon(installedHost(ROSTER_BOTH)));

    expect(receipt.install).toBe('already-installed');
  });

  it('never looks for brew when llmux is present', async () => {
    const host = healthyDaemon(installedHost(ROSTER_BOTH));

    await ensureLlmux(host);

    expect(host.calls.some((c) => c.kind === 'which' && c.bin === 'brew')).toBe(false);
    expect(host.calls.some((c) => c.kind === 'command' && c.command === BREW_BIN)).toBe(false);
  });

  it('installs the tap formula with argv separation when llmux is absent', async () => {
    const host = new FakeHost()
      .stubWhich('llmux', null)
      .stubWhich('brew', BREW_BIN)
      .stubCommand(ACCOUNTS, { stdout: ROSTER_BOTH })
      .stubCommand(RESTART, {})
      .stubCommand(ACCOUNTS_JSON, { stdout: HEALTHY_BOTH })
      .stubCommand(ENV, { stdout: envOutput(DEFAULT_ENDPOINT) });
    // The formula lands while `brew install` runs, so the re-`which` finds it.
    host.stubCommand(
      (s) => s.command === BREW_BIN,
      () => {
        host.stubWhich('llmux', LLMUX_BIN);
        return { code: 0 };
      },
    );

    const receipt = await ensureLlmux(host);

    expect(receipt.install).toBe('installed-via-brew');
    const brewCall = host.calls.find((c) => c.kind === 'command' && c.command === BREW_BIN);
    expect(brewCall).toMatchObject({ args: ['install', '2lab-ai/tap/llmux'] });
  });

  it('fails with an actionable error when Homebrew is missing', async () => {
    const host = new FakeHost().stubWhich('llmux', null).stubWhich('brew', null);

    const error = await ensureLlmux(host).catch((e) => e);

    expect(error).toBeInstanceOf(LlmuxInstallError);
    expect(error.message).toMatch(/brew/i);
    expect(error.progress).toEqual({ install: null, restartCount: 0, readinessChecks: 0 });
  });

  it('fails when `brew install` exits non-zero, quoting brew redacted', async () => {
    const host = new FakeHost()
      .stubWhich('llmux', null)
      .stubWhich('brew', BREW_BIN)
      .stubCommand((s) => s.command === BREW_BIN, { code: 1, stderr: 'Error: No available formula' });

    const error = await ensureLlmux(host).catch((e) => e);

    expect(error).toBeInstanceOf(LlmuxInstallError);
    expect(error.message).toMatch(/No available formula/);
  });

  it('fails when llmux is still absent after a successful install', async () => {
    const host = new FakeHost()
      .stubWhich('llmux', null)
      .stubWhich('brew', BREW_BIN)
      .stubCommand((s) => s.command === BREW_BIN, { code: 0 });

    await expect(ensureLlmux(host)).rejects.toThrow(/still not on PATH/i);
  });

  it('runs llmux through its resolved absolute path, never a bare name', async () => {
    const host = healthyDaemon(installedHost(ROSTER_BOTH));

    await ensureLlmux(host);

    for (const line of callLines(host)) expect(line.startsWith(`${LLMUX_BIN} `)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// M-2 — option validation happens before any side effect
// ---------------------------------------------------------------------------

describe('ensureLlmux — option validation', () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ['zero checks', { maxReadinessChecks: 0 }],
    ['negative interval', { readinessIntervalMs: -1 }],
    ['NaN timeout', { restartTimeoutMs: Number.NaN }],
    ['Infinity timeout', { probeTimeoutMs: Number.POSITIVE_INFINITY }],
    ['fractional timeout', { loginTimeoutMs: 1.5 }],
    ['zero roster timeout', { rosterTimeoutMs: 0 }],
    ['non-function onProgress', { onProgress: 'nope' }],
  ];

  it.each(bad)('rejects %s before the first host call', async (_label, options) => {
    const host = healthyDaemon(installedHost(ROSTER_BOTH));

    await expect(ensureLlmux(host, options)).rejects.toBeInstanceOf(LlmuxOptionsError);
    expect(host.calls).toHaveLength(0);
  });

  it('accepts an explicit undefined without clobbering the default', async () => {
    const host = healthyDaemon(installedHost(ROSTER_BOTH));

    await expect(ensureLlmux(host, { maxReadinessChecks: undefined })).resolves.toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Offline roster → which logins are needed
// ---------------------------------------------------------------------------

describe('ensureLlmux — offline roster drives the logins', () => {
  it('logs in to both providers when nothing is configured', async () => {
    const receipt = await ensureLlmux(healthyDaemon(installedHost(ROSTER_EMPTY)));

    expect(receipt.claudeLoginPerformed).toBe(true);
    expect(receipt.codexLoginPerformed).toBe(true);
  });

  it('logs in to Codex only when Claude OAuth is already configured', async () => {
    const host = healthyDaemon(installedHost(rosterOauth()));

    const receipt = await ensureLlmux(host);

    expect(receipt.claudeLoginPerformed).toBe(false);
    expect(receipt.codexLoginPerformed).toBe(true);
    expect(callLines(host)).not.toContain(`${LLMUX_BIN} login`);
  });

  it('logs in to Claude only when Codex is already configured', async () => {
    const host = healthyDaemon(installedHost(rosterCodex()));

    const receipt = await ensureLlmux(host);

    expect(receipt.claudeLoginPerformed).toBe(true);
    expect(receipt.codexLoginPerformed).toBe(false);
    expect(callLines(host)).not.toContain(`${LLMUX_BIN} login --codex`);
  });

  it('logs in to neither provider when both are configured', async () => {
    const receipt = await ensureLlmux(healthyDaemon(installedHost(ROSTER_BOTH)));

    expect(receipt.claudeLoginPerformed).toBe(false);
    expect(receipt.codexLoginPerformed).toBe(false);
  });

  it('treats an apikey account as NOT satisfying the Claude OAuth requirement', async () => {
    const host = healthyDaemon(installedHost([rosterApikey(), rosterCodex(2)].join('\n')));

    const receipt = await ensureLlmux(host);

    expect(receipt.claudeLoginPerformed).toBe(true);
    expect(callLines(host)).toContain(`${LLMUX_BIN} login`);
  });

  it('accepts the tier-suffixed OAuth row form', async () => {
    const receipt = await ensureLlmux(healthyDaemon(installedHost([rosterOauth('max20'), rosterCodex(2)].join('\n'))));

    expect(receipt.claudeLoginPerformed).toBe(false);
  });

  it('ignores a grok row for both requirements', async () => {
    const receipt = await ensureLlmux(healthyDaemon(installedHost('  [1] grok-user@example.test (grok)')));

    expect(receipt.claudeLoginPerformed).toBe(true);
    expect(receipt.codexLoginPerformed).toBe(true);
  });

  it('bounds the offline roster read with its own timeout', async () => {
    const host = healthyDaemon(installedHost(ROSTER_BOTH));

    await ensureLlmux(host, { rosterTimeoutMs: 4321 });

    const call = host.calls.find((c) => c.kind === 'command' && c.args[0] === 'accounts' && c.args.length === 1);
    expect(call).toMatchObject({ timeoutMs: 4321 });
  });

  it('fails loudly on an unrecognised roster line instead of assuming nothing is configured', async () => {
    await expect(ensureLlmux(installedHost(`  [1] ${CLAUDE_ACCOUNT} (quantum-oauth-v2)`))).rejects.toBeInstanceOf(
      LlmuxContractError,
    );
  });

  it('fails loudly on verbose child lines (contract drift, not a parseable roster)', async () => {
    const host = installedHost([rosterOauth(), '       Uuid:  aaaa-bbbb', '       Token: valid'].join('\n'));

    await expect(ensureLlmux(host)).rejects.toBeInstanceOf(LlmuxContractError);
  });

  it('fails loudly on empty `llmux accounts` output', async () => {
    await expect(ensureLlmux(installedHost('   \n'))).rejects.toBeInstanceOf(LlmuxContractError);
  });

  it('fails loudly when the no-account banner drifts', async () => {
    await expect(ensureLlmux(installedHost('No accounts configured.'))).rejects.toBeInstanceOf(LlmuxContractError);
  });
});

// ---------------------------------------------------------------------------
// I-2 — the offline `accounts` result is inspected before it is parsed
// ---------------------------------------------------------------------------

describe('ensureLlmux — offline accounts result is inspected', () => {
  it('fails on a non-zero exit even when stdout is a perfectly valid roster', async () => {
    // The mutation bite: delete the exit-code guard and this stdout parses
    // cleanly, so the test can only pass because the guard exists.
    const host = new FakeHost()
      .stubWhich('llmux', LLMUX_BIN)
      .stubCommand(ACCOUNTS, { code: 3, stdout: ROSTER_BOTH, stderr: 'config lock is held' });

    const error = await ensureLlmux(host).catch((e) => e);

    expect(error).toBeInstanceOf(LlmuxCommandError);
    expect(error.step).toBe('accounts');
    expect(error.exitStatus).toBe(3);
    expect(error.message).toMatch(/config lock is held/);
    expect(callLines(host)).toEqual([`${LLMUX_BIN} accounts`]);
  });

  it('fails on a timed-out roster read', async () => {
    const host = new FakeHost().stubWhich('llmux', LLMUX_BIN).stubCommand(ACCOUNTS, { timedOut: true });

    const error = await ensureLlmux(host).catch((e) => e);

    expect(error).toBeInstanceOf(LlmuxCommandError);
    expect(error.exitStatus).toBeNull();
  });

  it('turns an aborted roster read into a cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    const host = installedHost(ROSTER_BOTH);

    await expect(ensureLlmux(host, { signal: controller.signal })).rejects.toBeInstanceOf(LlmuxCancelledError);
  });
});

// ---------------------------------------------------------------------------
// I-3 — remote-configured llmux answers `accounts` with the live document
// ---------------------------------------------------------------------------

describe('ensureLlmux — remote endpoint mode', () => {
  it('explains remote mode when `accounts` returns a running status document', async () => {
    const host = new FakeHost().stubWhich('llmux', LLMUX_BIN).stubCommand(ACCOUNTS, { stdout: HEALTHY_BOTH });

    const error = await ensureLlmux(host).catch((e) => e);

    expect(error).toBeInstanceOf(LlmuxRemoteModeError);
    expect(error.message).toMatch(/remote endpoint/i);
    expect(error.message).toMatch(/local/i);
  });

  it('explains remote mode even when the remote daemon is down (exit 1 + JSON)', async () => {
    const host = new FakeHost()
      .stubWhich('llmux', LLMUX_BIN)
      .stubCommand(ACCOUNTS, { code: 1, stdout: NOT_RUNNING, stderr: '' });

    const error = await ensureLlmux(host).catch((e) => e);

    // Diagnosed as remote mode, not as "`llmux accounts` failed": the exit code
    // is a symptom of the remote config, not the cause.
    expect(error).toBeInstanceOf(LlmuxRemoteModeError);
    expect(error).not.toBeInstanceOf(LlmuxCommandError);
  });

  it('names no host, URL, port, or account in the remote-mode error', async () => {
    const host = new FakeHost().stubWhich('llmux', LLMUX_BIN).stubCommand(ACCOUNTS, { stdout: HEALTHY_BOTH });

    const error = await ensureLlmux(host).catch((e) => e);

    for (const sentinel of SENTINELS) expect(error.message).not.toContain(sentinel);
    expect(error.message).not.toMatch(/3456/);
  });
});

// ---------------------------------------------------------------------------
// C-2 — interactive login is spawned and streamed
// ---------------------------------------------------------------------------

describe('ensureLlmux — interactive login streams llmux guidance', () => {
  it('spawns login rather than buffering it through command()', async () => {
    const host = healthyDaemon(installedHost(ROSTER_EMPTY));

    await ensureLlmux(host);

    const spawns = host.calls.flatMap((c) => (c.kind === 'spawn' ? [c.args.join(' ')] : []));
    expect(spawns).toEqual(['login', 'login --codex']);
    expect(commandLines(host).some((l) => l.includes('login'))).toBe(false);
  });

  it('surfaces the OAuth fallback URL while the login child is still running', async () => {
    const controller = new AbortController();
    const seen: string[] = [];
    const host = installedHost(ROSTER_EMPTY, { claude: { stdout: OAUTH_GUIDANCE, runUntilKilled: true } });

    const error = await ensureLlmux(host, {
      signal: controller.signal,
      onProgress: (line) => {
        seen.push(line);
        // Cancelling from inside the callback proves the line arrived while the
        // child was still alive — the child cannot have exited yet.
        if (line.includes('claude.ai/oauth/authorize')) controller.abort();
      },
    }).catch((e) => e);

    expect(seen).toContain('Opening browser for authentication...');
    expect(seen.some((l) => l.includes('claude.ai/oauth/authorize'))).toBe(true);
    expect(error).toBeInstanceOf(LlmuxCancelledError);
    expect(kills(host)).toHaveLength(1);
  });

  it('forwards each output line separately, trimmed, dropping blanks', async () => {
    const seen: string[] = [];
    const host = healthyDaemon(
      installedHost(rosterCodex(), {
        claude: { stdout: OAUTH_GUIDANCE, stderr: 'warning: interactive ChatGPT login failed\n' },
      }),
    );

    await ensureLlmux(host, { onProgress: (l) => void seen.push(l) });

    expect(seen).toEqual([
      'Opening browser for authentication...',
      "If it doesn't open, visit:",
      'https://claude.ai/oauth/authorize',
      'warning: interactive ChatGPT login failed',
    ]);
  });

  it('redacts a credential that appears in the login stream', async () => {
    const seen: string[] = [];
    const host = healthyDaemon(
      installedHost(rosterCodex(), { claude: { stdout: `saved credential ${CREDENTIAL_SENTINEL}\n` } }),
    );

    await ensureLlmux(host, { onProgress: (l) => void seen.push(l) });

    expect(seen.join('\n')).not.toContain(CREDENTIAL_SENTINEL);
    expect(seen.join('\n')).toMatch(/REDACTED/);
  });

  it('never opens a browser itself; llmux owns the OAuth flow', async () => {
    const host = healthyDaemon(installedHost(ROSTER_EMPTY));

    await ensureLlmux(host);

    expect(host.calls.some((c) => c.kind === 'openUrl')).toBe(false);
  });

  it('does not kill a login that exits on its own', async () => {
    const host = healthyDaemon(installedHost(ROSTER_EMPTY));

    await ensureLlmux(host);

    expect(kills(host)).toHaveLength(0);
  });

  it('kills the child exactly once on timeout and reports it as a login failure', async () => {
    const host = installedHost(ROSTER_EMPTY, { claude: { stdout: OAUTH_GUIDANCE, runUntilKilled: true } });

    const error = await ensureLlmux(host, { loginTimeoutMs: 5 }).catch((e) => e);

    expect(error).toBeInstanceOf(LlmuxLoginError);
    expect(error.outcome).toBe('timeout');
    expect(error.group).toBe('claude');
    expect(kills(host)).toHaveLength(1);
    // Never proceeds to restart on a failed sign-in.
    expect(commandLines(host)).toEqual([`${LLMUX_BIN} accounts`]);
  });

  it('reports a non-zero login as actionable, with llmux redacted output attached', async () => {
    const host = installedHost(ROSTER_EMPTY, {
      claude: { stderr: 'oauth exchange failed: invalid_grant\n', code: 1 },
    });

    const error = await ensureLlmux(host).catch((e) => e);

    expect(error).toBeInstanceOf(LlmuxLoginError);
    expect(error.outcome).toBe('nonzero');
    expect(error.exitStatus).toBe(1);
    expect(error.message).toMatch(/invalid_grant/);
    expect(commandLines(host)).not.toContain(`${LLMUX_BIN} restart`);
  });

  it('distinguishes cancellation from failure so the orchestrator can resume', async () => {
    const controller = new AbortController();
    const host = installedHost(ROSTER_EMPTY, { claude: { stdout: OAUTH_GUIDANCE, runUntilKilled: true } });

    const error = await ensureLlmux(host, {
      signal: controller.signal,
      onProgress: () => controller.abort(),
    }).catch((e) => e);

    expect(error).toBeInstanceOf(LlmuxCancelledError);
    expect(error).not.toBeInstanceOf(LlmuxLoginError);
  });

  it('propagates an already-aborted signal before spawning anything', async () => {
    const controller = new AbortController();
    controller.abort();
    const host = installedHost(ROSTER_EMPTY);

    await expect(ensureLlmux(host, { signal: controller.signal })).rejects.toBeInstanceOf(LlmuxCancelledError);
    expect(host.calls.some((c) => c.kind === 'spawn')).toBe(false);
  });

  it('assembles whole lines from a chunk-split real child (RealHost)', async () => {
    // The only real process in this file. RealHost line-buffers before
    // redacting; this proves the adapter's line splitter agrees with it when a
    // pipe read boundary falls mid-line and mid-UTF-8.
    const script = [
      "printf 'Opening browser for authentication...\\n'",
      'sleep 0.15',
      "printf 'If it does not open, vis'",
      'sleep 0.15',
      "printf 'it:\\r\\n  https://claude.ai/oauth/authorize\\n'",
    ].join('; ');
    const child = new RealHost().spawn({ command: '/bin/sh', args: ['-c', script] });
    const lines: string[] = [];
    child.onStdout((chunk) => emitProgressLines(chunk, (l) => lines.push(l)));

    await child.exited;
    await new Promise((r) => setTimeout(r, 60));

    expect(lines).toEqual([
      'Opening browser for authentication...',
      'If it does not open, visit:',
      'https://claude.ai/oauth/authorize',
    ]);
  });
});

// ---------------------------------------------------------------------------
// classifyLlmuxAccounts
// ---------------------------------------------------------------------------

describe('classifyLlmuxAccounts', () => {
  const parse = (text: string) => classifyLlmuxAccounts(JSON.parse(text));

  it('counts only active/ok accounts in the claude and codex groups', () => {
    expect(parse(HEALTHY_BOTH)).toEqual({ claudeHealthy: 1, codexHealthy: 1 });
  });

  it('does not count auth_failed', () => {
    const doc = liveDoc([
      { group: 'claude', status: 'active' },
      { group: 'codex', status: 'auth_failed' },
    ]);
    expect(parse(doc)).toEqual({ claudeHealthy: 1, codexHealthy: 0 });
  });

  it('does not count cooldown', () => {
    const doc = liveDoc([
      { group: 'claude', status: 'cooldown' },
      { group: 'codex', status: 'ok' },
    ]);
    expect(parse(doc)).toEqual({ claudeHealthy: 0, codexHealthy: 1 });
  });

  it('does not count an unknown status', () => {
    const doc = liveDoc([{ group: 'claude', status: 'warming_up' }]);
    expect(parse(doc)).toEqual({ claudeHealthy: 0, codexHealthy: 0 });
  });

  it('ignores foreign groups such as grok', () => {
    const doc = liveDoc([
      { group: 'grok', status: 'active' },
      { group: 'claude', status: 'ok' },
    ]);
    expect(parse(doc)).toEqual({ claudeHealthy: 1, codexHealthy: 0 });
  });

  it('sums multiple healthy accounts per group', () => {
    const doc = liveDoc([
      { group: 'claude', status: 'active' },
      { group: 'claude', status: 'ok' },
      { group: 'codex', status: 'active' },
    ]);
    expect(parse(doc)).toEqual({ claudeHealthy: 2, codexHealthy: 1 });
  });

  it('throws on a document without a top-level accounts array', () => {
    expect(() => classifyLlmuxAccounts({ server: 'running', current: null })).toThrow(LlmuxContractError);
  });

  it('throws on an account entry missing group/status', () => {
    expect(() => classifyLlmuxAccounts({ accounts: [{ group: 'claude' }] })).toThrow(LlmuxContractError);
  });

  it('throws on a non-object document', () => {
    expect(() => classifyLlmuxAccounts([])).toThrow(LlmuxContractError);
    expect(() => classifyLlmuxAccounts(null)).toThrow(LlmuxContractError);
  });
});

// ---------------------------------------------------------------------------
// I-1 — restart results are inspected; only success reaches the poll
// ---------------------------------------------------------------------------

describe('ensureLlmux — restart and readiness', () => {
  it('restarts once and makes one immediate live check when the daemon is healthy', async () => {
    const host = healthyDaemon(installedHost(ROSTER_BOTH));

    const receipt = await ensureLlmux(host);

    expect(receipt.restartCount).toBe(1);
    expect(receipt.readinessChecks).toBe(1);
    expect(receipt.claudeHealthy).toBe(1);
    expect(receipt.codexHealthy).toBe(1);
    expect(host.calls.some((c) => c.kind === 'sleep')).toBe(false);
  });

  it('polls the not-running document with host.sleep and never restarts a second time', async () => {
    const host = installedHost(ROSTER_BOTH)
      .stubCommand(RESTART, {})
      .stubCommandOnce(ACCOUNTS_JSON, { code: 1, stdout: NOT_RUNNING })
      .stubCommandOnce(ACCOUNTS_JSON, { code: 1, stdout: NOT_RUNNING })
      .stubCommand(ACCOUNTS_JSON, { stdout: HEALTHY_BOTH });

    const receipt = await ensureLlmux(host);

    expect(receipt.readinessChecks).toBe(3);
    expect(receipt.restartCount).toBe(1);
    expect(commandLines(host).filter((l) => l === `${LLMUX_BIN} restart`)).toHaveLength(1);
    expect(host.calls.filter((c) => c.kind === 'sleep')).toHaveLength(2);
  });

  it('treats a timed-out live probe as retryable, not as a contract failure', async () => {
    const host = installedHost(ROSTER_BOTH)
      .stubCommand(RESTART, {})
      .stubCommandOnce(ACCOUNTS_JSON, { timedOut: true })
      .stubCommand(ACCOUNTS_JSON, { stdout: HEALTHY_BOTH });

    const receipt = await ensureLlmux(host);

    expect(receipt.readinessChecks).toBe(2);
    expect(receipt.restartCount).toBe(1);
  });

  it('gives up with a readiness timeout after the bounded poll budget', async () => {
    const host = installedHost(ROSTER_BOTH)
      .stubCommand(RESTART, {})
      .stubCommand(ACCOUNTS_JSON, { code: 1, stdout: NOT_RUNNING });

    const error = await ensureLlmux(host, { maxReadinessChecks: 3, readinessIntervalMs: 100 }).catch((e) => e);

    expect(error).toBeInstanceOf(LlmuxReadinessTimeoutError);
    expect(error.attempts).toBe(3);
    expect(error.progress).toEqual({ install: 'already-installed', restartCount: 1, readinessChecks: 3 });
    expect(commandLines(host).filter((l) => l === `${LLMUX_BIN} restart`)).toHaveLength(1);
  });

  it('fails immediately on a non-zero restart instead of polling a hard error', async () => {
    const host = installedHost(ROSTER_BOTH)
      .stubCommand(RESTART, { code: 1, stderr: 'no accounts configured\nAdd one with: llmux login' })
      .stubCommand(ACCOUNTS_JSON, { stdout: HEALTHY_BOTH });

    const error = await ensureLlmux(host).catch((e) => e);

    expect(error).toBeInstanceOf(LlmuxRestartError);
    expect(error.step).toBe('restart');
    expect(error.exitStatus).toBe(1);
    // llmux's own diagnostic reaches the user instead of being discarded.
    expect(error.message).toMatch(/no accounts configured/);
    // and the readiness budget is never spent on it.
    expect(commandLines(host)).not.toContain(`${LLMUX_BIN} accounts --json`);
    expect(host.calls.some((c) => c.kind === 'sleep')).toBe(false);
  });

  it('fails immediately on a port-in-use restart, quoting llmux', async () => {
    const host = installedHost(ROSTER_BOTH)
      .stubCommand(RESTART, {
        code: 1,
        stderr: 'port 3456 is in use by something that is not llmux (nginx)\nFree the port or change proxy.port',
      })
      .stubCommand(ACCOUNTS_JSON, { stdout: HEALTHY_BOTH });

    const error = await ensureLlmux(host).catch((e) => e);

    expect(error).toBeInstanceOf(LlmuxRestartError);
    expect(error.message).toMatch(/is in use by something that is not llmux/);
    expect(commandLines(host)).not.toContain(`${LLMUX_BIN} accounts --json`);
  });

  it('fails immediately on a timed-out restart', async () => {
    const host = installedHost(ROSTER_BOTH)
      .stubCommand(RESTART, { timedOut: true })
      .stubCommand(ACCOUNTS_JSON, { stdout: HEALTHY_BOTH });

    const error = await ensureLlmux(host).catch((e) => e);

    expect(error).toBeInstanceOf(LlmuxRestartError);
    expect(error.exitStatus).toBeNull();
    expect(commandLines(host)).not.toContain(`${LLMUX_BIN} accounts --json`);
  });

  it('turns an aborted restart into a cancellation and never polls', async () => {
    const controller = new AbortController();
    const host = installedHost(ROSTER_BOTH)
      .stubCommand(RESTART, () => {
        controller.abort();
        return { aborted: true };
      })
      .stubCommand(ACCOUNTS_JSON, { stdout: HEALTHY_BOTH });

    const error = await ensureLlmux(host, { signal: controller.signal }).catch((e) => e);

    expect(error).toBeInstanceOf(LlmuxCancelledError);
    expect(commandLines(host)).not.toContain(`${LLMUX_BIN} accounts --json`);
  });

  it('fails loudly on unparseable live output', async () => {
    const host = installedHost(ROSTER_BOTH)
      .stubCommand(RESTART, {})
      .stubCommand(ACCOUNTS_JSON, { stdout: 'llmux: something went sideways\n' });

    await expect(ensureLlmux(host)).rejects.toBeInstanceOf(LlmuxContractError);
  });

  it('fails loudly on a live document missing the accounts schema', async () => {
    const host = installedHost(ROSTER_BOTH)
      .stubCommand(RESTART, {})
      .stubCommand(ACCOUNTS_JSON, { stdout: JSON.stringify({ server: 'running', current: null }) });

    await expect(ensureLlmux(host)).rejects.toBeInstanceOf(LlmuxContractError);
  });

  it('fails loudly on a non-zero probe whose output is not the not-running document', async () => {
    const host = installedHost(ROSTER_BOTH)
      .stubCommand(RESTART, {})
      .stubCommand(ACCOUNTS_JSON, { code: 1, stderr: 'llmux on port 3456 rejected the api key (401)' });

    const error = await ensureLlmux(host).catch((e) => e);

    expect(error).toBeInstanceOf(LlmuxContractError);
    expect(error).not.toBeInstanceOf(LlmuxReadinessTimeoutError);
    expect(error.message).toMatch(/rejected the api key/);
  });

  it('aborts mid-poll without issuing another restart', async () => {
    const controller = new AbortController();
    const host = installedHost(ROSTER_BOTH)
      .stubCommand(RESTART, {})
      .stubCommandOnce(ACCOUNTS_JSON, () => {
        controller.abort();
        return { code: 1, stdout: NOT_RUNNING };
      })
      .stubCommand(ACCOUNTS_JSON, { stdout: HEALTHY_BOTH });

    const error = await ensureLlmux(host, { signal: controller.signal }).catch((e) => e);

    expect(error).toBeInstanceOf(LlmuxCancelledError);
    expect(commandLines(host).filter((l) => l === `${LLMUX_BIN} restart`)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// I-4 — recovery is gated on auth_failed/absent; cooldown never gets an OAuth
// ---------------------------------------------------------------------------

describe('ensureLlmux — recovery re-login', () => {
  const AUTH_FAILED_CODEX = liveDoc([
    { group: 'claude', status: 'active' },
    { group: 'codex', status: 'auth_failed' },
  ]);
  const AUTH_FAILED_BOTH = liveDoc([
    { group: 'claude', status: 'auth_failed' },
    { group: 'codex', status: 'auth_failed' },
  ]);
  const COOLDOWN_CODEX = liveDoc([
    { group: 'claude', status: 'active' },
    { group: 'codex', status: 'cooldown' },
  ]);
  const MIXED = liveDoc([
    { group: 'claude', status: 'auth_failed' },
    { group: 'codex', status: 'cooldown' },
  ]);
  const CLAUDE_ONLY = liveDoc([{ group: 'claude', status: 'active' }]);
  const UNKNOWN_CODEX = liveDoc([
    { group: 'claude', status: 'active' },
    { group: 'codex', status: 'warming_up' },
  ]);

  it('re-logs in exactly the auth_failed group, once, then restarts once and rechecks', async () => {
    const host = installedHost(ROSTER_BOTH)
      .stubCommand(RESTART, {})
      .stubCommandOnce(ACCOUNTS_JSON, { stdout: AUTH_FAILED_CODEX })
      .stubCommand(ACCOUNTS_JSON, { stdout: HEALTHY_BOTH });

    const receipt = await ensureLlmux(host);

    expect(receipt.codexReloginPerformed).toBe(true);
    expect(receipt.claudeReloginPerformed).toBe(false);
    expect(callLines(host)).toEqual([
      `${LLMUX_BIN} accounts`,
      `${LLMUX_BIN} restart`,
      `${LLMUX_BIN} accounts --json`,
      `${LLMUX_BIN} login --codex`,
      `${LLMUX_BIN} restart`,
      `${LLMUX_BIN} accounts --json`,
      `${LLMUX_BIN} env`,
    ]);
    expect(receipt.restartCount).toBe(2);
  });

  it('re-logs in a group that is absent from live status', async () => {
    const host = installedHost(ROSTER_BOTH)
      .stubCommand(RESTART, {})
      .stubCommandOnce(ACCOUNTS_JSON, { stdout: CLAUDE_ONLY })
      .stubCommand(ACCOUNTS_JSON, { stdout: HEALTHY_BOTH });

    const receipt = await ensureLlmux(host);

    expect(receipt.codexReloginPerformed).toBe(true);
    expect(receipt.claudeReloginPerformed).toBe(false);
  });

  it('re-logs in both groups when both are auth_failed', async () => {
    const host = installedHost(ROSTER_BOTH)
      .stubCommand(RESTART, {})
      .stubCommandOnce(ACCOUNTS_JSON, { stdout: AUTH_FAILED_BOTH })
      .stubCommand(ACCOUNTS_JSON, { stdout: HEALTHY_BOTH });

    const receipt = await ensureLlmux(host);

    expect(receipt.claudeReloginPerformed).toBe(true);
    expect(receipt.codexReloginPerformed).toBe(true);
    expect(callLines(host).filter((l) => l.includes(' login'))).toEqual([
      `${LLMUX_BIN} login`,
      `${LLMUX_BIN} login --codex`,
    ]);
  });

  it('NEVER runs an OAuth flow for a cooldown-only group', async () => {
    const host = installedHost(ROSTER_BOTH)
      .stubCommand(RESTART, {})
      .stubCommand(ACCOUNTS_JSON, { stdout: COOLDOWN_CODEX });

    const error = await ensureLlmux(host).catch((e) => e);

    expect(error).toBeInstanceOf(LlmuxCooldownError);
    expect(error).toBeInstanceOf(LlmuxUnhealthyError);
    expect(error.cooldownGroups).toEqual(['codex']);
    expect(error.message).toMatch(/rate-limited/i);
    // No login, and no second restart spent on something OAuth cannot fix.
    expect(host.calls.some((c) => c.kind === 'spawn')).toBe(false);
    expect(commandLines(host).filter((l) => l === `${LLMUX_BIN} restart`)).toHaveLength(1);
  });

  it('recovers only the auth_failed group when the other is merely rate-limited', async () => {
    const host = installedHost(ROSTER_BOTH)
      .stubCommand(RESTART, {})
      .stubCommandOnce(ACCOUNTS_JSON, { stdout: MIXED })
      .stubCommand(ACCOUNTS_JSON, { stdout: COOLDOWN_CODEX });

    const error = await ensureLlmux(host).catch((e) => e);

    // claude got its one re-login; codex never did.
    expect(callLines(host).filter((l) => l.includes(' login'))).toEqual([`${LLMUX_BIN} login`]);
    expect(error).toBeInstanceOf(LlmuxCooldownError);
    expect(error.cooldownGroups).toEqual(['codex']);
    expect(error.progress).toEqual({ install: 'already-installed', restartCount: 2, readinessChecks: 2 });
  });

  it('treats an unrecognised status as a contract failure, not as a reason to sign in', async () => {
    const host = installedHost(ROSTER_BOTH)
      .stubCommand(RESTART, {})
      .stubCommand(ACCOUNTS_JSON, { stdout: UNKNOWN_CODEX });

    const error = await ensureLlmux(host).catch((e) => e);

    expect(error).toBeInstanceOf(LlmuxContractError);
    expect(host.calls.some((c) => c.kind === 'spawn')).toBe(false);
  });

  it('throws an actionable error naming the groups when a group stays auth_failed', async () => {
    const host = installedHost(ROSTER_BOTH)
      .stubCommand(RESTART, {})
      .stubCommand(ACCOUNTS_JSON, { stdout: AUTH_FAILED_CODEX });

    const error = await ensureLlmux(host).catch((e) => e);

    expect(error).toBeInstanceOf(LlmuxUnhealthyError);
    expect(error).not.toBeInstanceOf(LlmuxCooldownError);
    expect(error.unhealthyGroups).toEqual(['codex']);
    expect(error.claudeHealthy).toBe(1);
    expect(error.codexHealthy).toBe(0);
    expect(error.statusCounts).toContainEqual({ group: 'codex', status: 'auth_failed', count: 1 });
    expect(error.groupConditions).toEqual([
      { group: 'claude', condition: 'healthy' },
      { group: 'codex', condition: 'auth-failed' },
    ]);
  });

  it('never runs a third restart or a second re-login', async () => {
    const host = installedHost(ROSTER_BOTH)
      .stubCommand(RESTART, {})
      .stubCommand(ACCOUNTS_JSON, { stdout: AUTH_FAILED_CODEX });

    await ensureLlmux(host).catch(() => {});

    expect(commandLines(host).filter((l) => l === `${LLMUX_BIN} restart`)).toHaveLength(2);
    expect(callLines(host).filter((l) => l === `${LLMUX_BIN} login --codex`)).toHaveLength(1);
  });

  it('surfaces a re-login failure as a login error, not as an unhealthy result', async () => {
    const host = installedHost(ROSTER_BOTH, { codex: { code: 1, stderr: 'device flow denied\n' } })
      .stubCommand(RESTART, {})
      .stubCommand(ACCOUNTS_JSON, { stdout: AUTH_FAILED_CODEX });

    const error = await ensureLlmux(host).catch((e) => e);

    expect(error).toBeInstanceOf(LlmuxLoginError);
    expect(commandLines(host).filter((l) => l === `${LLMUX_BIN} restart`)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The endpoint is llmux's answer, never somawork's constant
// ---------------------------------------------------------------------------

describe('ensureLlmux — the endpoint comes from `llmux env`', () => {
  /**
   * A healthy run whose `llmux env` answers `stdout`.
   *
   * `stubCommandOnce` rather than `stubCommand`: `installedHost` already
   * registered the default endpoint as a general stub, and FakeHost resolves
   * general stubs in registration order, so a second general stub would be
   * permanently shadowed by the first.
   */
  const endpointHost = (stdout: string, extra: FakeCommandResponse = {}) =>
    installedHost(ROSTER_BOTH)
      .stubCommand(RESTART, {})
      .stubCommand(ACCOUNTS_JSON, { stdout: HEALTHY_BOTH })
      .stubCommandOnce(ENV, { stdout, ...extra });

  it('reports the default local endpoint when llmux runs on its default port', async () => {
    const receipt = await ensureLlmux(endpointHost(envOutput('http://localhost:3456')));

    expect(receipt.baseUrl).toBe('http://localhost:3456');
  });

  it('reports the configured port when another llmux already owns 3456', async () => {
    const receipt = await ensureLlmux(endpointHost(envOutput('http://localhost:13456')));

    expect(receipt.baseUrl).toBe('http://localhost:13456');
  });

  it.each([
    ['a 127.0.0.1 endpoint', 'http://127.0.0.1:13456', 'http://127.0.0.1:13456'],
    ['an IPv6 loopback endpoint', 'http://[::1]:13456', 'http://[::1]:13456'],
    ['a bare host with no port', 'http://localhost', 'http://localhost'],
    ['a trailing slash, normalised to the origin', 'http://localhost:13456/', 'http://localhost:13456'],
  ])('accepts %s', async (_label, printed, expected) => {
    const receipt = await ensureLlmux(endpointHost(envOutput(printed)));

    expect(receipt.baseUrl).toBe(expected);
  });

  it('ignores the api key line llmux prints beside the URL', async () => {
    const receipt = await ensureLlmux(endpointHost(envOutput('http://localhost:13456', PROXY_API_KEY_SENTINEL)));

    expect(receipt.baseUrl).toBe('http://localhost:13456');
  });

  it('keeps the api key out of the receipt, the call log, and the setup-state gate', async () => {
    const host = endpointHost(envOutput('http://localhost:13456', PROXY_API_KEY_SENTINEL));
    const progress: string[] = [];

    const receipt = await ensureLlmux(host, { onProgress: (line) => void progress.push(line) });

    for (const surface of [
      JSON.stringify(receipt),
      JSON.stringify(host.calls),
      JSON.stringify(host.unsafeRawCalls()),
      progress.join('\n'),
    ]) {
      expect(surface).not.toContain(PROXY_API_KEY_SENTINEL);
    }
    expect(() => assertSecretFree(receipt)).not.toThrow();
    expect(() => assertSecretFree(JSON.parse(JSON.stringify(receipt)))).not.toThrow();
  });

  it('never runs `llmux env` on a path that ends in failure', async () => {
    const host = installedHost(ROSTER_BOTH)
      .stubCommand(RESTART, {})
      .stubCommand(ACCOUNTS_JSON, {
        stdout: liveDoc([
          { group: 'claude', status: 'active' },
          { group: 'codex', status: 'cooldown' },
        ]),
      });

    await ensureLlmux(host).catch(() => {});

    expect(commandLines(host)).not.toContain(`${LLMUX_BIN} env`);
  });

  it.each([
    ['nothing at all', ''],
    ['whitespace only', '   \n\n'],
    ['only the api key line', `export ANTHROPIC_API_KEY=${PROXY_API_KEY_SENTINEL}\n`],
    [
      'two base URL lines',
      'export ANTHROPIC_BASE_URL=http://localhost:3456\nexport ANTHROPIC_BASE_URL=http://localhost:13456\n',
    ],
    [
      'two api key lines',
      `export ANTHROPIC_BASE_URL=http://localhost:3456\nexport ANTHROPIC_API_KEY=a${PROXY_API_KEY_SENTINEL}\nexport ANTHROPIC_API_KEY=b${PROXY_API_KEY_SENTINEL}\n`,
    ],
    ['an unexpected export', 'export ANTHROPIC_BASE_URL=http://localhost:3456\nexport PATH=/tmp/evil\n'],
    ['an assignment with no `export`', 'ANTHROPIC_BASE_URL=http://localhost:3456\n'],
    ['a comment line', '# llmux 0.9\nexport ANTHROPIC_BASE_URL=http://localhost:3456\n'],
    ['a single-quoted value', "export ANTHROPIC_BASE_URL='http://localhost:3456'\n"],
    ['a double-quoted value', 'export ANTHROPIC_BASE_URL="http://localhost:3456"\n'],
    ['a backtick command substitution', 'export ANTHROPIC_BASE_URL=`id`\n'],
    ['a $() command substitution', 'export ANTHROPIC_BASE_URL=http://localhost:$(id -u)\n'],
    ['a trailing shell command', 'export ANTHROPIC_BASE_URL=http://localhost:3456;curl evil.example\n'],
    ['a value with a space', 'export ANTHROPIC_BASE_URL=http://localhost:3456 evil\n'],
    ['a remote host', 'export ANTHROPIC_BASE_URL=http://10.0.0.5:3456\n'],
    ['a lookalike registrable domain', 'export ANTHROPIC_BASE_URL=http://localhost.evil.example:3456\n'],
    ['an https endpoint', 'export ANTHROPIC_BASE_URL=https://localhost:3456\n'],
    ['embedded userinfo', 'export ANTHROPIC_BASE_URL=http://user:pass@localhost:3456\n'],
    ['a path', 'export ANTHROPIC_BASE_URL=http://localhost:3456/exfil\n'],
    ['a query string', 'export ANTHROPIC_BASE_URL=http://localhost:3456/?to=evil.example\n'],
    ['a fragment', 'export ANTHROPIC_BASE_URL=http://localhost:3456/#evil\n'],
    ['an out-of-range port', 'export ANTHROPIC_BASE_URL=http://localhost:99999\n'],
    ['a value that is not a URL', 'export ANTHROPIC_BASE_URL=nope\n'],
    ['an empty value', 'export ANTHROPIC_BASE_URL=\n'],
  ])('refuses %s as a contract failure', async (_label, stdout) => {
    const host = endpointHost(stdout);

    const error = await ensureLlmux(host).catch((e) => e);

    expect(error).toBeInstanceOf(LlmuxContractError);
    // The offending bytes came from a child process; naming them in an error
    // that a caller may print or persist is the leak this parser exists to
    // avoid. Line shape only.
    const surfaces = [error.message, JSON.stringify(error), JSON.stringify(error.toJSON())];
    for (const surface of surfaces) {
      expect(surface).not.toContain(PROXY_API_KEY_SENTINEL);
      expect(surface).not.toContain('evil.example');
      expect(surface).not.toContain('id -u');
    }
  });

  it('fails with a command error, not a contract error, when `llmux env` exits non-zero', async () => {
    const host = endpointHost('', { code: 1, stderr: 'llmux: config is unreadable' });

    const error = await ensureLlmux(host).catch((e) => e);

    expect(error).toBeInstanceOf(LlmuxCommandError);
    expect(error.step).toBe('env');
    expect(error.exitStatus).toBe(1);
    expect(error.message).toMatch(/config is unreadable/);
  });

  it('fails with a command error when `llmux env` has to be killed', async () => {
    const host = endpointHost('', { timedOut: true });

    const error = await ensureLlmux(host).catch((e) => e);

    expect(error).toBeInstanceOf(LlmuxCommandError);
    expect(error.step).toBe('env');
  });

  it('never quotes `llmux env` stdout in a failure, even when the exit is non-zero', async () => {
    const host = endpointHost(`export ANTHROPIC_API_KEY=${PROXY_API_KEY_SENTINEL}\n`, {
      code: 1,
      stderr: 'boom',
    });

    const error = await ensureLlmux(host).catch((e) => e);

    expect(`${error.message} ${JSON.stringify(error)}`).not.toContain(PROXY_API_KEY_SENTINEL);
  });

  it('carries progress on an endpoint failure so a resume knows how far it got', async () => {
    const host = endpointHost('export ANTHROPIC_BASE_URL=http://10.0.0.5:3456\n');

    const error = await ensureLlmux(host).catch((e) => e);

    expect(error.progress).toEqual({ install: 'already-installed', restartCount: 1, readinessChecks: 1 });
  });
});

// ---------------------------------------------------------------------------
// Full command order
// ---------------------------------------------------------------------------

describe('ensureLlmux — command order', () => {
  it('runs which → accounts → login → login --codex → restart → accounts --json → env', async () => {
    const host = healthyDaemon(installedHost(ROSTER_EMPTY));

    await ensureLlmux(host);

    expect(
      host.calls.map((c) =>
        c.kind === 'command' || c.kind === 'spawn' ? `${c.kind}:${[c.command, ...c.args].join(' ')}` : c.kind,
      ),
    ).toEqual([
      'which',
      `command:${LLMUX_BIN} accounts`,
      `spawn:${LLMUX_BIN} login`,
      `spawn:${LLMUX_BIN} login --codex`,
      `command:${LLMUX_BIN} restart`,
      `command:${LLMUX_BIN} accounts --json`,
      `command:${LLMUX_BIN} env`,
    ]);
  });

  it('reads the endpoint exactly once, after the daemon is proven healthy', async () => {
    const host = installedHost(ROSTER_BOTH)
      .stubCommand(RESTART, {})
      .stubCommandOnce(ACCOUNTS_JSON, { code: 1, stdout: NOT_RUNNING })
      .stubCommand(ACCOUNTS_JSON, { stdout: HEALTHY_BOTH });

    await ensureLlmux(host);

    const lines = commandLines(host);
    expect(lines.filter((l) => l === `${LLMUX_BIN} env`)).toHaveLength(1);
    expect(lines.indexOf(`${LLMUX_BIN} env`)).toBe(lines.length - 1);
  });
});

// ---------------------------------------------------------------------------
// M-4 / M-6 — persistable shapes are secret-safe and carry progress
// ---------------------------------------------------------------------------

describe('ensureLlmux — persistable shapes', () => {
  /** The shape Task 10 would actually persist: the JSON round trip. */
  const persisted = (value: unknown) => JSON.parse(JSON.stringify(value));

  it('produces a receipt that survives the setup-state secret gate', async () => {
    const receipt = await ensureLlmux(healthyDaemon(installedHost(ROSTER_BOTH)));

    expect(() => assertSecretFree(receipt)).not.toThrow();
    expect(() => assertSecretFree(persisted(receipt))).not.toThrow();
  });

  it('serializes every failure into a secret-gate-clean shape carrying progress', async () => {
    const failures: Array<() => Promise<unknown>> = [
      () => ensureLlmux(new FakeHost().stubWhich('llmux', null).stubWhich('brew', null)),
      () =>
        ensureLlmux(
          new FakeHost()
            .stubWhich('llmux', LLMUX_BIN)
            .stubCommand(ACCOUNTS, { code: 3, stdout: ROSTER_BOTH, stderr: `lock held by ${CLAUDE_ACCOUNT}` }),
        ),
      () => ensureLlmux(new FakeHost().stubWhich('llmux', LLMUX_BIN).stubCommand(ACCOUNTS, { stdout: HEALTHY_BOTH })),
      () =>
        ensureLlmux(
          installedHost(ROSTER_EMPTY, {
            claude: { code: 1, stderr: `denied for ${CLAUDE_ACCOUNT} ${CREDENTIAL_SENTINEL}\n` },
          }),
        ),
      () =>
        ensureLlmux(
          installedHost(ROSTER_BOTH)
            .stubCommand(RESTART, { code: 1, stderr: `no accounts configured ${CREDENTIAL_SENTINEL}` })
            .stubCommand(ACCOUNTS_JSON, { stdout: HEALTHY_BOTH }),
        ),
      () =>
        ensureLlmux(
          installedHost(ROSTER_BOTH).stubCommand(RESTART, {}).stubCommand(ACCOUNTS_JSON, {
            code: 1,
            stdout: NOT_RUNNING,
          }),
          { maxReadinessChecks: 2, readinessIntervalMs: 1 },
        ),
      () =>
        ensureLlmux(
          installedHost(ROSTER_BOTH)
            .stubCommand(RESTART, {})
            .stubCommand(ACCOUNTS_JSON, {
              stdout: liveDoc([
                { group: 'claude', status: 'active', name: CLAUDE_ACCOUNT },
                { group: 'codex', status: 'cooldown', name: CODEX_ACCOUNT },
              ]),
            }),
        ),
    ];

    for (const [index, run] of failures.entries()) {
      const error = await run().then(
        () => {
          throw new Error(`failure case ${index} unexpectedly succeeded`);
        },
        (e) => e,
      );
      const shape = persisted(error);
      expect(() => assertSecretFree(shape), `case ${index}`).not.toThrow();
      // Progress is present on everything past option validation…
      expect(shape.progress, `case ${index}`).not.toBeNull();
      expect(typeof shape.progress.restartCount, `case ${index}`).toBe('number');
      // …and the persisted projection carries no child output at all.
      for (const sentinel of SENTINELS) {
        expect(JSON.stringify(shape), `case ${index}`).not.toContain(sentinel);
      }
    }
  });

  it('records the install disposition on a post-install failure', async () => {
    const host = installedHost(ROSTER_BOTH)
      .stubCommand(RESTART, {})
      .stubCommand(ACCOUNTS_JSON, { code: 1, stdout: NOT_RUNNING });

    const error = await ensureLlmux(host, { maxReadinessChecks: 1 }).catch((e) => e);

    expect(persisted(error).progress).toEqual({
      install: 'already-installed',
      restartCount: 1,
      readinessChecks: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// Secret safety
// ---------------------------------------------------------------------------

describe('ensureLlmux — nothing sensitive escapes', () => {
  const scan = (label: string, value: unknown) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    for (const sentinel of SENTINELS) {
      expect(`${label}: ${text}`).not.toContain(sentinel);
    }
  };

  it('keeps account names and raw stdout out of the receipt and the call log', async () => {
    const host = healthyDaemon(installedHost([rosterApikey(), rosterCodex(2)].join('\n')));

    const receipt = await ensureLlmux(host);

    scan('receipt', receipt);
    scan('calls', host.calls);
    scan('rawCalls', host.unsafeRawCalls());
  });

  it('keeps account names out of progress lines and of the messages that quote llmux', async () => {
    const seen: string[] = [];
    const host = installedHost(ROSTER_EMPTY, {
      claude: { stdout: `authorised ${CREDENTIAL_SENTINEL}\n`, stderr: 'oauth failed\n', code: 1 },
    });

    const error = await ensureLlmux(host, { onProgress: (l) => void seen.push(l) }).catch((e) => e);

    scan('progress', seen);
    // The human-facing message may quote llmux, but only the redacted view.
    scan('message', error.message);
    expect(error.message).toMatch(/oauth failed/);
  });

  it('keeps account names and raw output out of every thrown error message', async () => {
    const cases: Array<() => Promise<unknown>> = [
      () => ensureLlmux(installedHost(`  [1] ${CLAUDE_ACCOUNT} (quantum-oauth-v2)`)).catch((e: Error) => e.message),
      () =>
        ensureLlmux(
          installedHost(ROSTER_BOTH)
            .stubCommand(RESTART, {})
            .stubCommand(ACCOUNTS_JSON, { stdout: `garbage ${RAW_STDOUT_SENTINEL}` }),
        ).catch((e: Error) => e.message),
      () =>
        ensureLlmux(
          installedHost(ROSTER_BOTH)
            .stubCommand(RESTART, {})
            .stubCommand(ACCOUNTS_JSON, {
              stdout: liveDoc([
                { group: 'claude', status: 'active', name: CLAUDE_ACCOUNT },
                { group: 'codex', status: 'auth_failed', name: CODEX_ACCOUNT },
              ]),
            }),
        ).catch((e: LlmuxUnhealthyError) => `${e.message}|${JSON.stringify(e)}`),
      () =>
        ensureLlmux(new FakeHost().stubWhich('llmux', LLMUX_BIN).stubCommand(ACCOUNTS, { stdout: HEALTHY_BOTH })).catch(
          (e: Error) => e.message,
        ),
    ];

    for (const [index, run] of cases.entries()) {
      scan(`error-${index}`, await run());
    }
  });
});

// ---------------------------------------------------------------------------
// I-7 / M-10 — identity in a timeout detail, and a hostile progress sink
// ---------------------------------------------------------------------------

describe('ensureLlmux — the roster timeout quotes stderr only', () => {
  it('never puts partially flushed roster stdout in the timeout detail', async () => {
    // The wedged-daemon shape: `llmux accounts` is killed after flushing part
    // of the roster to stdout and nothing to stderr. Redaction masks vendor
    // token shapes, not an account name — which in practice is an email
    // address — so stdout must not be a fallback candidate here.
    const host = new FakeHost()
      .stubWhich('llmux', LLMUX_BIN)
      .stubCommand(ACCOUNTS, { timedOut: true, stdout: ROSTER_BOTH, stderr: '' });

    const error = await ensureLlmux(host).catch((e) => e);

    expect(error).toBeInstanceOf(LlmuxCommandError);
    expect(error.step).toBe('accounts');
    // No detail at all: `boundedDetail` has one candidate and it is empty.
    expect(error.message).not.toMatch(/llmux said/);
    expect(error.message).toBe(error.summary);
    for (const sentinel of SENTINELS) expect(`${error.message}|${JSON.stringify(error)}`).not.toContain(sentinel);
  });

  it('still quotes stderr when the wedged daemon wrote one', async () => {
    const host = new FakeHost()
      .stubWhich('llmux', LLMUX_BIN)
      .stubCommand(ACCOUNTS, { timedOut: true, stdout: ROSTER_BOTH, stderr: 'config lock is held\n' });

    const error = await ensureLlmux(host).catch((e) => e);

    expect(error.message).toMatch(/llmux said: config lock is held$/);
    for (const sentinel of SENTINELS) expect(error.message).not.toContain(sentinel);
  });
});

describe('ensureLlmux — a failing progress sink cannot stall or escape the login', () => {
  it('survives a synchronous throw from onProgress and still completes', async () => {
    const host = healthyDaemon(installedHost(rosterCodex(), { claude: { stdout: OAUTH_GUIDANCE } }));

    const receipt = await ensureLlmux(host, {
      onProgress: () => {
        throw new Error('renderer exploded');
      },
    });

    expect(receipt.claudeHealthy).toBeGreaterThan(0);
  });

  it('survives an asynchronously rejecting onProgress and still completes', async () => {
    const host = healthyDaemon(installedHost(rosterCodex(), { claude: { stdout: OAUTH_GUIDANCE } }));

    const receipt = await ensureLlmux(host, {
      onProgress: () => Promise.reject(new Error('renderer exploded later')),
    });

    expect(receipt.claudeHealthy).toBeGreaterThan(0);
  });

  it('keeps the sink failure out of the error path when the login itself fails', async () => {
    const host = installedHost(ROSTER_EMPTY, {
      claude: { stdout: `authorised ${CREDENTIAL_SENTINEL}\n`, stderr: 'oauth failed\n', code: 1 },
    });

    const error = await ensureLlmux(host, {
      onProgress: () => {
        throw new Error(`renderer saw ${CREDENTIAL_SENTINEL}`);
      },
    }).catch((e) => e);

    expect(error).toBeInstanceOf(LlmuxLoginError);
    expect(error.message).toMatch(/oauth failed/);
    for (const sentinel of SENTINELS) {
      expect(`${error.message}|${JSON.stringify(error)}`).not.toContain(sentinel);
    }
  });
});
