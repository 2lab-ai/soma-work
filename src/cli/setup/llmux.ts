/**
 * Local llmux installation + Claude/Codex onboarding, as a {@link SetupHost}
 * adapter.
 *
 * ## What this owns
 *
 * Getting the machine to a state where a local llmux daemon is running with at
 * least one healthy Claude (OAuth) account and one healthy Codex account. It
 * does that by driving the `llmux` CLI and nothing else: it never reads
 * `~/.config/llmux.json`, never touches a provider token, and never runs an
 * OAuth flow of its own — `llmux login` owns the browser round trip and writes
 * the credential itself.
 *
 * ## Why the sequence is what it is
 *
 * `llmux accounts --json` reads the *live* daemon, and the daemon refuses to
 * start with an empty account list (`daemon.rs:205-216`). So the health check
 * cannot be the first thing we run: we read the **offline** roster first
 * (`accounts.rs:20-94`, a local config listing with no tokens in it), log in to
 * whichever provider is missing, and only then restart and probe.
 *
 * `llmux restart` already drains and waits up to 30s for readiness before it
 * returns (`daemon.rs:25,235-269`). Two consequences, and they point opposite
 * ways:
 *
 * - a **successful** restart may still be a beat ahead of the daemon, so a
 *   short `host.sleep` poll absorbs that race — never a second restart, which
 *   would drain a daemon that is on its way up;
 * - a **non-zero** restart is a completed hard failure, not a slow start
 *   (`daemon.rs:196-201` port-in-use, `:205-216` no-accounts). Polling it
 *   burns the readiness budget and then reports the wrong cause, so it fails
 *   immediately with llmux's own redacted diagnostic attached.
 *
 * ## Output discipline
 *
 * Raw child output is read at exactly three narrowly named points
 * ({@link readOfflineRoster}, {@link probeLiveDaemon}, {@link readEndpoint}) and
 * reduced immediately to booleans, counts, a closed status enum, and one
 * validated origin. Nothing carries an account name, a masked key, a config
 * path, or raw stdout.
 *
 * {@link readEndpoint} is the strictest of the three and the reason the rule is
 * stated as "raw, then reduce" rather than "the redacted view is enough":
 * `llmux env` prints the proxy api key beside the URL when one is configured
 * (`env.rs:19-21`), that key is an arbitrary operator-chosen string, and
 * `ANTHROPIC_API_KEY=` is not one of the key/value names the redactor knows
 * (`packages/common/src/logger.ts:64-70`). So for that one command the
 * *redacted* `stdout` is credential-bearing too: it is never read, never
 * quoted in an error, and the raw bytes are consumed once inside
 * {@link parseLlmuxEnvBaseUrl}, which returns an origin and nothing else.
 *
 * The **redacted** views (`CommandResult.stderr`, the `spawn` line streams) are
 * a different matter: `host.ts` documents them as safe for terminal, log, and
 * report sinks, and they carry every actionable thing llmux knows — the OAuth
 * fallback URL, "port in use", "no accounts configured". They are forwarded,
 * bounded, to the human. Discarding them was the previous revision's mistake.
 */

import type { CommandSpec, ProcessExit, SetupHost } from './host';
import { LlmuxEndpointError, validateLlmuxBaseUrl } from './llmux-endpoint';

/** Homebrew formula that provides the `llmux` binary. */
export const LLMUX_FORMULA = '2lab-ai/tap/llmux';

/** Backend groups this adapter requires to be healthy. */
export type LlmuxGroup = 'claude' | 'codex';

/** The groups somawork depends on, in reporting order. */
export const LLMUX_GROUPS: readonly LlmuxGroup[] = ['claude', 'codex'];

/** Statuses `llmux status` reports; anything else is normalised to `unknown`. */
export type LlmuxAccountStatus = 'active' | 'ok' | 'cooldown' | 'auth_failed' | 'unknown';

/** Statuses that count as a usable account (`status.rs:120-142`). */
const HEALTHY_STATUSES = new Set<LlmuxAccountStatus>(['active', 'ok']);

const KNOWN_STATUSES = new Set<string>(['active', 'ok', 'cooldown', 'auth_failed']);

/** Credential kinds the offline roster can print (`accounts.rs:36-93`). */
const ROSTER_KINDS = ['apikey', 'oauth', 'codex', 'grok'] as const;
type RosterKind = (typeof ROSTER_KINDS)[number];

/**
 * One offline roster row: `  [N] NAME (kind[, tier])[  mask]`.
 *
 * Greedy name capture on purpose — the kind marker is the *last* parenthesised
 * group on the line, so backtracking lands on it even when an account name
 * contains parentheses.
 */
const ROSTER_ROW = new RegExp(`^ {2}\\[\\d+\\] .+ \\((${ROSTER_KINDS.join('|')})(?:, [^)]+)?\\)(?: {2}.*)?$`);

/** First line of the empty-config banner (`accounts.rs:31`). */
const NO_ACCOUNTS_LINE = 'No accounts configured.';
/**
 * Second line of that banner. Matched by prefix rather than in full: the exact
 * wording lists the *add* commands, so an llmux release that adds one more way
 * to add an account would otherwise break onboarding on its single most common
 * path (a machine with no accounts at all).
 */
const NO_ACCOUNTS_HINT_PREFIX = 'Add one with:';

/** Longest redacted child-output tail copied into an error message. */
const MAX_DETAIL_CHARS = 400;
/** Longest single progress line forwarded to `onProgress`. */
const MAX_PROGRESS_LINE_CHARS = 500;
/** Progress lines retained to explain a failed login. */
const MAX_TAIL_LINES = 8;

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

/** How the binary got onto the machine. */
export type LlmuxInstallDisposition = 'already-installed' | 'installed-via-brew';

/** Healthy-account counts for the two groups somawork depends on. */
export interface LlmuxAccountCounts {
  claudeHealthy: number;
  codexHealthy: number;
}

/** What the live daemon says about one group. */
export type LlmuxGroupCondition = 'healthy' | 'auth-failed' | 'cooldown' | 'absent';

/** One group's live condition, safe to persist. */
export interface LlmuxGroupReport {
  group: LlmuxGroup;
  condition: LlmuxGroupCondition;
}

/** Per-group status tally used to explain an unhealthy outcome. */
export interface LlmuxStatusCount {
  group: string;
  status: LlmuxAccountStatus;
  count: number;
}

/** How far onboarding got. Attached to every failure for Task 10 resume. */
export interface LlmuxProgress {
  install: LlmuxInstallDisposition | null;
  restartCount: number;
  readinessChecks: number;
}

/**
 * Secret-safe evidence that llmux onboarding completed.
 *
 * Deliberately contains only dispositions and counts. It is designed to pass
 * `assertSecretFree` so Task 10 can persist it verbatim in setup state, and to
 * answer the doctor checks (`llmux`, `llmux_claude`, `llmux_codex`) without a
 * second live probe.
 */
export interface LlmuxReceipt extends LlmuxAccountCounts {
  install: LlmuxInstallDisposition;
  /**
   * The endpoint this machine's llmux actually listens on, as an origin
   * (`http://localhost:13456`).
   *
   * Read from `llmux env`. In LOCAL mode that resolves `config.proxy.port`, the
   * same port `accounts` / `restart` / the daemon itself use (`llmux`
   * `src/cli/mod.rs:639`, the `remote: false` arm of `resolve_endpoint`) — so it
   * is the one answer that stays true when 3456 is already owned by another
   * llmux under the same uid. `llmux env` is *not* unconditionally local:
   * `env.rs:17` calls the same `resolve_endpoint`, which returns the configured
   * `remote.host` endpoint when one is set (`mod.rs:633`). somawork never sees
   * that arm, because a remote-configured llmux is refused at the first command
   * `onboard` runs — `readOfflineRoster` throws {@link LlmuxRemoteModeError} on
   * `llmux accounts` (see below), long before `llmux env` is reached. Non-secret
   * by construction: the parser returns a validated loopback origin and discards
   * everything else `llmux env` printed, so this field clears `assertSecretFree`
   * and is safe to persist, log, and write into the profile's `.env`.
   */
  baseUrl: string;
  /** A first-time `llmux login` ran because no Claude OAuth account existed. */
  claudeLoginPerformed: boolean;
  /** A first-time `llmux login --codex` ran because no Codex account existed. */
  codexLoginPerformed: boolean;
  /** A recovery `llmux login` ran because the claude group was unhealthy. */
  claudeReloginPerformed: boolean;
  /** A recovery `llmux login --codex` ran because the codex group was unhealthy. */
  codexReloginPerformed: boolean;
  /** How many times `llmux restart` was issued. Never more than 2. */
  restartCount: number;
  /** How many `llmux accounts --json` probes were made in total. */
  readinessChecks: number;
}

/** What the offline roster proves about the local config. */
export interface OfflineRoster {
  /** At least one `(oauth…)` row. An `(apikey)` row does NOT satisfy this. */
  hasClaudeOauth: boolean;
  /** At least one `(codex)` row. */
  hasCodex: boolean;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** The persistable projection of an llmux failure. Never carries child output. */
export interface LlmuxErrorJson {
  name: string;
  summary: string;
  progress: LlmuxProgress | null;
}

/**
 * Base class so a caller can catch every llmux onboarding failure at once.
 *
 * Two views on purpose. `message` is for the human and may end with a bounded,
 * host-redacted tail of llmux's own diagnostic. `toJSON()` is the shape a
 * caller may persist: `summary` only, with no child output in it at all, so it
 * clears `assertSecretFree` by construction rather than by luck.
 */
export class LlmuxError extends Error {
  /** Child-output-free restatement of the failure. Safe to persist. */
  readonly summary: string;
  /** How far onboarding got. Stamped by {@link ensureLlmux} on the way out. */
  progress: LlmuxProgress | null = null;

  constructor(summary: string, detail?: string | null) {
    super(detail ? `${summary} llmux said: ${detail}` : summary);
    this.name = new.target.name;
    this.summary = summary;
  }

  toJSON(): LlmuxErrorJson {
    return { name: this.name, summary: this.summary, progress: this.progress };
  }
}

/** Bad `ensureLlmux` options. Thrown before any side effect. */
export class LlmuxOptionsError extends LlmuxError {}

/** llmux is not installed and could not be installed. */
export class LlmuxInstallError extends LlmuxError {}

/**
 * llmux produced output this adapter does not recognise — an unparseable roster
 * line, a live document without the documented schema, a non-zero probe that is
 * not the not-running document, an unknown account status. Treated as a
 * version-contract failure, never as "nothing is configured".
 */
export class LlmuxContractError extends LlmuxError {}

/**
 * `llmux accounts` answered with a live JSON document instead of the local
 * roster, which means this machine's llmux config points at a remote endpoint
 * (`accounts.rs:20-25` + `mod.rs:614-629`).
 */
export class LlmuxRemoteModeError extends LlmuxError {}

/** An llmux command exited non-zero or timed out. */
export class LlmuxCommandError extends LlmuxError {
  constructor(
    summary: string,
    /** Subcommand name, e.g. `accounts` or `restart`. Never argv. */
    readonly step: string,
    readonly exitStatus: number | null,
    detail?: string | null,
  ) {
    super(summary, detail);
  }

  override toJSON() {
    return { ...super.toJSON(), step: this.step, exitStatus: this.exitStatus };
  }
}

/** `llmux restart` failed outright. llmux already waited; do not poll. */
export class LlmuxRestartError extends LlmuxCommandError {}

/** `llmux login` / `llmux login --codex` did not complete. */
export class LlmuxLoginError extends LlmuxError {
  constructor(
    summary: string,
    readonly group: LlmuxGroup,
    readonly outcome: 'nonzero' | 'timeout',
    readonly exitStatus: number | null,
    detail?: string | null,
  ) {
    super(summary, detail);
  }

  override toJSON() {
    return { ...super.toJSON(), group: this.group, outcome: this.outcome, exitStatus: this.exitStatus };
  }
}

/** The caller's `AbortSignal` fired. Distinct so an orchestrator can resume. */
export class LlmuxCancelledError extends LlmuxError {}

/** The daemon never reported running within the bounded poll budget. */
export class LlmuxReadinessTimeoutError extends LlmuxError {
  constructor(
    summary: string,
    readonly attempts: number,
  ) {
    super(summary);
  }

  override toJSON() {
    return { ...super.toJSON(), attempts: this.attempts };
  }
}

/** A required group has no usable account after the one allowed recovery pass. */
export class LlmuxUnhealthyError extends LlmuxError {
  constructor(
    summary: string,
    readonly unhealthyGroups: readonly LlmuxGroup[],
    readonly cooldownGroups: readonly LlmuxGroup[],
    readonly claudeHealthy: number,
    readonly codexHealthy: number,
    readonly statusCounts: readonly LlmuxStatusCount[],
    readonly groupConditions: readonly LlmuxGroupReport[],
  ) {
    super(summary);
  }

  override toJSON() {
    return {
      ...super.toJSON(),
      unhealthyGroups: [...this.unhealthyGroups],
      cooldownGroups: [...this.cooldownGroups],
      claudeHealthy: this.claudeHealthy,
      codexHealthy: this.codexHealthy,
      statusCounts: this.statusCounts.map((c) => ({ ...c })),
      groupConditions: this.groupConditions.map((c) => ({ ...c })),
    };
  }
}

/**
 * Every blocking group is merely rate-limited.
 *
 * A subclass of {@link LlmuxUnhealthyError} so a caller that only cares about
 * "setup could not finish" still catches it, while a caller that wants to say
 * "wait for the reset" can branch. Signing in again cannot clear a cooldown,
 * so this is never preceded by an OAuth prompt.
 */
export class LlmuxCooldownError extends LlmuxUnhealthyError {}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/** Tunables. All optional, so `ensureLlmux(host)` stays a one-argument call. */
export interface EnsureLlmuxOptions {
  /** Cancels the whole flow, including a login the user is still completing. */
  signal?: AbortSignal;
  /**
   * Sink for llmux's own redacted progress lines during an interactive login —
   * notably the "If it doesn't open, visit: <url>" fallback, which is the
   * user's only recovery when `open` silently fails (`oauth.rs:155-171`).
   * Lines are forwarded as they arrive. This adapter never writes to the
   * console itself and never parses or opens the URL.
   *
   * Called best-effort: a throw or a rejected promise from this callback is
   * swallowed rather than allowed to abort — or stall — the login. May be sync
   * or async.
   */
  onProgress?: (line: string) => void | Promise<void>;
  /** Live probes allowed per restart before giving up. Default 10. */
  maxReadinessChecks?: number;
  /** Delay between live probes, via `host.sleep`. Default 2000ms. */
  readinessIntervalMs?: number;
  /** Cap on `brew install`. Default 900000ms (15 min). */
  installTimeoutMs?: number;
  /** Cap on an interactive `llmux login`. Default 600000ms (10 min). */
  loginTimeoutMs?: number;
  /** Cap on `llmux restart`; must exceed llmux's own 30s wait. Default 90000ms. */
  restartTimeoutMs?: number;
  /** Cap on one `llmux accounts --json` probe. Default 15000ms. */
  probeTimeoutMs?: number;
  /** Cap on the offline `llmux accounts` read. Default 30000ms. */
  rosterTimeoutMs?: number;
  /** Cap on the `llmux env` endpoint read. Default 15000ms. */
  envTimeoutMs?: number;
}

type LlmuxTunables = Required<Omit<EnsureLlmuxOptions, 'signal' | 'onProgress'>>;

const DEFAULTS: LlmuxTunables = {
  maxReadinessChecks: 10,
  readinessIntervalMs: 2_000,
  installTimeoutMs: 900_000,
  loginTimeoutMs: 600_000,
  restartTimeoutMs: 90_000,
  probeTimeoutMs: 15_000,
  rosterTimeoutMs: 30_000,
  envTimeoutMs: 15_000,
};

const TUNABLE_KEYS = Object.keys(DEFAULTS) as Array<keyof LlmuxTunables>;

type Policy = LlmuxTunables & { signal?: AbortSignal; onProgress?: (line: string) => void | Promise<void> };

/** Drop explicit `undefined` so it cannot clobber a default via spread. */
function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * Merge and validate options **before** the first host call.
 *
 * `maxReadinessChecks: 0` used to produce an immediate readiness timeout after
 * a real restart, and a negative interval reached `host.sleep`. A bad tunable
 * is a programming error and should never cost a daemon restart to discover.
 */
function resolvePolicy(options: EnsureLlmuxOptions): Policy {
  const merged: Policy = { ...DEFAULTS, ...stripUndefined(options) };
  for (const key of TUNABLE_KEYS) {
    const value = merged[key];
    if (!Number.isInteger(value) || value <= 0) {
      const unit = key.endsWith('Ms') ? 'milliseconds' : 'checks';
      throw new LlmuxOptionsError(
        `ensureLlmux option \`${key}\` must be a positive whole number of ${unit}; received ${String(value)}.`,
      );
    }
  }
  if (merged.onProgress !== undefined && typeof merged.onProgress !== 'function') {
    throw new LlmuxOptionsError('ensureLlmux option `onProgress` must be a function.');
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Redacted-output helpers (safe views only — never `unsafeRaw*`)
// ---------------------------------------------------------------------------

/**
 * Collapse a redacted child-output blob into one bounded line for an error
 * message. Input is already redacted by the host; this only bounds the size so
 * a runaway child cannot turn an error into a log dump.
 */
function boundedDetail(...candidates: string[]): string | null {
  for (const candidate of candidates) {
    const lines = candidate
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (lines.length === 0) continue;
    const joined = lines.join(' / ');
    return joined.length > MAX_DETAIL_CHARS ? `${joined.slice(0, MAX_DETAIL_CHARS)}…` : joined;
  }
  return null;
}

/**
 * Split a redacted stream chunk into whole, non-empty, bounded lines.
 *
 * Exported because it is the seam the streaming tests exercise against the real
 * host: `RealHost` line-buffers before redacting, so a chunk here is already a
 * whole line, while `FakeHost` delivers a whole blob — this handles both, plus
 * a CRLF child.
 */
export function emitProgressLines(chunk: string, sink: (line: string) => void): void {
  for (const raw of chunk.split('\n')) {
    const line = raw.replace(/\r+$/, '').trim();
    if (line.length === 0) continue;
    sink(line.length > MAX_PROGRESS_LINE_CHARS ? `${line.slice(0, MAX_PROGRESS_LINE_CHARS)}…` : line);
  }
}

/**
 * Hand one line to the caller's sink, guarded — the Slack sibling's pattern
 * (`slack-capture.ts:742-758`).
 *
 * This runs inside the host's `'data'` handler, so an uncaught throw here would
 * escape a stream callback with no `finally` above it: the login is left
 * unsettled (`await child.exited` never resolves), the sign-in child is never
 * killed, and the process drains its event loop and exits 0 having done
 * nothing. A progress renderer is decoration; it must never be able to take the
 * flow down with it. Sync throws are swallowed, and a rejected promise is
 * swallowed too so an async renderer cannot become an unhandled rejection
 * either. Nothing about the failure is reported: the value a failing renderer
 * throws is the one object in scope most likely to quote the line it was
 * handed.
 */
function emitProgressSafely(sink: ((line: string) => void | Promise<void>) | undefined, line: string): void {
  if (sink === undefined) return;
  try {
    const result = sink(line) as unknown;
    if (result !== null && typeof result === 'object' && typeof (result as PromiseLike<void>).then === 'function') {
      void Promise.resolve(result).catch(() => undefined);
    }
  } catch {
    // Deliberately swallowed: see above.
  }
}

function describeExit(exit: ProcessExit): string {
  if (exit.signal !== null) return `signal ${exit.signal}`;
  return String(exit.code);
}

// ---------------------------------------------------------------------------
// Offline roster (raw-output boundary #1)
// ---------------------------------------------------------------------------

/**
 * A leading `{` means we got the live status document, not a roster.
 *
 * Only `{` — never `[`. Both live shapes llmux can print here are JSON
 * *objects* (`accounts.rs:117,122`), while every roster row begins
 * `  [N] ...`, so accepting `[` after trimming would classify an ordinary
 * two-account roster as remote mode.
 */
function looksLikeJsonDocument(raw: string): boolean {
  return raw.trimStart().startsWith('{');
}

/**
 * Parse `llmux accounts` (offline, no daemon, no tokens) into two booleans.
 *
 * `raw` is consumed here and nowhere else; the return value carries no text.
 * Anything that is neither the empty-config banner nor a well-formed row is a
 * contract failure — silently reading it as "no accounts" would trigger a
 * duplicate OAuth prompt on a machine that is already set up.
 */
export function parseOfflineRoster(raw: string): OfflineRoster {
  const lines = raw.split('\n').filter((line) => line.trim().length > 0);

  if (lines.length === 0) {
    throw new LlmuxContractError('`llmux accounts` printed nothing; expected an account roster or the empty banner.');
  }

  if (lines[0] === NO_ACCOUNTS_LINE) {
    if (lines.length !== 2 || !lines[1].startsWith(NO_ACCOUNTS_HINT_PREFIX)) {
      throw new LlmuxContractError(
        `\`llmux accounts\` printed "${NO_ACCOUNTS_LINE}" but not the expected two-line banner (${lines.length} line(s)); refusing to guess.`,
      );
    }
    return { hasClaudeOauth: false, hasCodex: false };
  }

  const kinds: RosterKind[] = [];
  for (const [index, line] of lines.entries()) {
    const match = ROSTER_ROW.exec(line);
    if (match === null) {
      // Line number only — the line itself holds an account name.
      throw new LlmuxContractError(
        `\`llmux accounts\` line ${index + 1} does not match the expected roster row format; llmux output contract changed.`,
      );
    }
    kinds.push(match[1] as RosterKind);
  }

  return {
    hasClaudeOauth: kinds.includes('oauth'),
    hasCodex: kinds.includes('codex'),
  };
}

/**
 * Read and classify the offline roster, inspecting the command result first.
 *
 * Order matters. The remote-mode check runs before the exit-code guard because
 * a remote-configured llmux with a *down* daemon prints the not-running JSON
 * and exits 1 — reporting that as "`llmux accounts` failed" would hide the real
 * cause.
 */
async function readOfflineRoster(host: SetupHost, bin: string, policy: Policy): Promise<OfflineRoster> {
  const result = await run(
    host,
    { command: bin, args: ['accounts'], timeoutMs: policy.rosterTimeoutMs },
    policy,
    '`llmux accounts`',
  );

  if (result.timedOut) {
    throw new LlmuxCommandError(
      `\`llmux accounts\` did not return within ${policy.rosterTimeoutMs}ms and was terminated.`,
      'accounts',
      null,
      // stderr ONLY, exactly as the `slack auth list` sibling
      // (`slack-auth.ts:702-708`). A killed `llmux accounts` has usually
      // already flushed part of the roster, and redaction masks vendor token
      // shapes — not an account name, which in practice is an email address.
      // `boundedDetail` returns the first NON-EMPTY candidate, so passing
      // stdout as a fallback hands it the roster on every wedged daemon with
      // an empty stderr, and puts that identity on a terminal, in CI logs, and
      // in pasted issue reports.
      boundedDetail(result.stderr),
    );
  }

  const raw = result.unsafeRawStdout();

  if (looksLikeJsonDocument(raw)) {
    throw new LlmuxRemoteModeError(
      "llmux is configured for a remote endpoint, so `llmux accounts` returned a live status document instead of this machine's roster. somawork v1 onboards the LOCAL daemon: run setup on the machine that hosts llmux, or clear the remote endpoint from your llmux config and re-run.",
    );
  }

  if (!result.ok) {
    throw new LlmuxCommandError(
      `\`llmux accounts\` failed (exit ${String(result.code)}); somawork could not read the local account roster.`,
      'accounts',
      result.code,
      boundedDetail(result.stderr),
    );
  }

  return parseOfflineRoster(raw);
}

// ---------------------------------------------------------------------------
// Live status (raw-output boundary #2)
// ---------------------------------------------------------------------------

interface GroupTally {
  healthy: number;
  authFailed: number;
  cooldown: number;
  unknown: number;
  total: number;
}

interface LlmuxAccountSummary extends LlmuxAccountCounts {
  statusCounts: LlmuxStatusCount[];
  groups: Record<LlmuxGroup, GroupTally>;
}

function normaliseStatus(status: string): LlmuxAccountStatus {
  return KNOWN_STATUSES.has(status) ? (status as LlmuxAccountStatus) : 'unknown';
}

function emptyTally(): GroupTally {
  return { healthy: 0, authFailed: 0, cooldown: 0, unknown: 0, total: 0 };
}

/**
 * Validate the `/llmux/status` document and tally it.
 *
 * Only `group` in {claude, codex} with `status` in {active, ok} counts as
 * healthy. Anything outside the documented schema throws rather than degrading
 * to zero, because "zero healthy" and "I could not read this" lead to very
 * different fixes.
 */
function summariseLlmuxAccounts(json: unknown): LlmuxAccountSummary {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new LlmuxContractError('`llmux accounts --json` did not return a status object.');
  }
  const accounts = (json as { accounts?: unknown }).accounts;
  if (!Array.isArray(accounts)) {
    throw new LlmuxContractError('`llmux accounts --json` returned a document without a top-level `accounts` array.');
  }

  // Nested map, not a composed string key: `group` and `status` are both closed
  // vocabularies here, and a delimiter in a key is a bug waiting for an input
  // that contains it.
  const tally = new Map<string, Map<LlmuxAccountStatus, number>>();
  const groups: Record<LlmuxGroup, GroupTally> = { claude: emptyTally(), codex: emptyTally() };

  for (const [index, entry] of accounts.entries()) {
    if (typeof entry !== 'object' || entry === null) {
      throw new LlmuxContractError(`\`llmux accounts --json\` account ${index} is not an object.`);
    }
    const { group, status } = entry as { group?: unknown; status?: unknown };
    if (typeof group !== 'string' || typeof status !== 'string') {
      throw new LlmuxContractError(`\`llmux accounts --json\` account ${index} is missing a string group/status.`);
    }

    const normalised = normaliseStatus(status);
    // A foreign group name is bucketed so no unvetted string leaves this
    // function; `claude`/`codex` are echoed because they are our own literals.
    const groupLabel = group === 'claude' || group === 'codex' ? group : 'other';
    const byStatus = tally.get(groupLabel) ?? new Map<LlmuxAccountStatus, number>();
    byStatus.set(normalised, (byStatus.get(normalised) ?? 0) + 1);
    tally.set(groupLabel, byStatus);

    if (groupLabel !== 'other') {
      const bucket = groups[groupLabel];
      bucket.total += 1;
      if (HEALTHY_STATUSES.has(normalised)) bucket.healthy += 1;
      else if (normalised === 'auth_failed') bucket.authFailed += 1;
      else if (normalised === 'cooldown') bucket.cooldown += 1;
      else bucket.unknown += 1;
    }
  }

  const statusCounts: LlmuxStatusCount[] = [];
  for (const [group, byStatus] of tally) {
    for (const [status, count] of byStatus) statusCounts.push({ group, status, count });
  }

  return {
    claudeHealthy: groups.claude.healthy,
    codexHealthy: groups.codex.healthy,
    statusCounts,
    groups,
  };
}

/**
 * Healthy Claude/Codex account counts from a parsed `llmux accounts --json`
 * document. Throws {@link LlmuxContractError} on anything off-schema.
 */
export function classifyLlmuxAccounts(json: unknown): LlmuxAccountCounts {
  const { claudeHealthy, codexHealthy } = summariseLlmuxAccounts(json);
  return { claudeHealthy, codexHealthy };
}

/**
 * Per-group live conditions from a parsed llmux status document.
 *
 * Exported alongside {@link classifyLlmuxAccounts} because a raw healthy count
 * cannot distinguish "no account configured" from "the account is rate-limited"
 * from "the account needs re-authentication" — three states with three
 * different remedies, which `somawork doctor` has to report separately.
 * Reuses the same validator, so a schema drift is a single-point failure.
 *
 * Throws {@link LlmuxContractError} on anything off-schema.
 */
export function classifyLlmuxGroups(json: unknown): LlmuxGroupReport[] {
  return conditionsFor(summariseLlmuxAccounts(json));
}

/**
 * Classify one group's live condition.
 *
 * `cooldown` is a **usage rate limit**, not a credential failure — llmux counts
 * it separately from `auth_failed` for exactly that reason
 * (`status.rs:126-129`). Re-running OAuth structurally cannot clear it, so it
 * never routes to a login; it routes to "wait or add an account".
 */
function conditionFor(group: LlmuxGroup, tally: GroupTally): LlmuxGroupCondition {
  if (tally.healthy > 0) return 'healthy';
  if (tally.total === 0) return 'absent';
  if (tally.authFailed > 0) return 'auth-failed';
  if (tally.unknown > 0) {
    throw new LlmuxContractError(
      `\`llmux accounts --json\` reported an account status somawork does not recognise for the ${group} group; llmux's status vocabulary changed, so setup will not guess a remedy.`,
    );
  }
  return 'cooldown';
}

function conditionsFor(summary: LlmuxAccountSummary): LlmuxGroupReport[] {
  return LLMUX_GROUPS.map((group) => ({ group, condition: conditionFor(group, summary.groups[group]) }));
}

function groupsWith(reports: readonly LlmuxGroupReport[], conditions: readonly LlmuxGroupCondition[]): LlmuxGroup[] {
  return reports.filter((r) => conditions.includes(r.condition)).map((r) => r.group);
}

/** `ServerProbe::NotRunning` prints this document and exits 1 (`accounts.rs:120-126`). */
function isNotRunningDocument(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as { server?: unknown }).server === 'not running';
}

function tryParseJson(raw: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// Endpoint (raw-output boundary #3)
// ---------------------------------------------------------------------------

/**
 * One `export NAME=value` line, whole.
 *
 * `\S*` for the value, not `.*`: `llmux env` is meant for `eval "$(llmux env)"`
 * and prints an unquoted value (`env.rs:18`), so a value containing whitespace
 * is not a value this contract can produce. Refusing the line is the right
 * answer — accepting the prefix would silently truncate whatever produced it.
 */
const ENV_EXPORT_LINE = /^export ([A-Z][A-Z0-9_]*)=(\S*)$/;

/**
 * Characters that mean something to a shell.
 *
 * Redundant with {@link validateLlmuxBaseUrl} — `'…'`, `` `id` `` and
 * `$(id)` are all rejected by `new URL` or by the path/port checks — and kept
 * anyway because the hazard is worth naming at the boundary that reads a
 * child's bytes: this output is designed to be `eval`'d, and the refusal
 * should read as "somawork does not eval this" rather than depend on a URL
 * parser incidentally saying no.
 */
const SHELL_METACHARACTERS = /['"`\\$;&|<>()]/;

/** Variables `llmux env` is allowed to export (`env.rs:18-21`). */
const ENV_BASE_URL_NAME = 'ANTHROPIC_BASE_URL';
const ENV_API_KEY_NAME = 'ANTHROPIC_API_KEY';

/**
 * Reduce `llmux env` output to the one thing somawork is allowed to keep.
 *
 * `raw` is consumed here and nowhere else, and nothing derived from it leaves
 * this function except a validated loopback origin — in particular the
 * `ANTHROPIC_API_KEY` line is counted (so a duplicate is still a contract
 * failure) and never read. `llmux env` deliberately prints that key for
 * off-host clients (`env.rs:9-12`); somawork is on-host and writes the
 * throwaway `llmux-local` placeholder instead, so retaining the real one would
 * be storing a credential it has no use for.
 *
 * Everything is refused that is not exactly the documented two-line shape:
 * a missing URL, a duplicate of either line, an unexpected variable, a line
 * that is not an `export`, a quoted or command-substituted value, and any
 * endpoint {@link validateLlmuxBaseUrl} will not accept (remote host, https,
 * userinfo, path, query, fragment, bad port). A "close enough" read here would
 * point the materialized profile — and therefore the running service — at an
 * endpoint llmux is not serving, or at one it is not the only thing serving.
 *
 * No message quotes the offending bytes: the line that failed is exactly the
 * line most likely to be carrying the key.
 */
export function parseLlmuxEnvBaseUrl(raw: string): string {
  const lines = raw
    .split('\n')
    .map((line) => line.replace(/\r+$/, ''))
    .filter((line) => line.trim().length > 0);

  let baseUrl: string | null = null;
  let sawApiKey = false;

  for (const [index, line] of lines.entries()) {
    const match = ENV_EXPORT_LINE.exec(line);
    if (match === null) {
      // Line number only, exactly as the roster parser: the line itself is the
      // thing that may hold a credential.
      throw new LlmuxContractError(
        `\`llmux env\` line ${index + 1} is not a plain \`export NAME=value\` line; llmux's env output contract changed.`,
      );
    }
    const [, name, value] = match;
    if (name === ENV_BASE_URL_NAME) {
      if (baseUrl !== null) {
        throw new LlmuxContractError(`\`llmux env\` exported ${ENV_BASE_URL_NAME} more than once; refusing to guess.`);
      }
      if (SHELL_METACHARACTERS.test(value)) {
        throw new LlmuxContractError(
          `\`llmux env\` exported a ${ENV_BASE_URL_NAME} the shell would have to expand; somawork does not evaluate llmux's output.`,
        );
      }
      baseUrl = value;
    } else if (name === ENV_API_KEY_NAME) {
      if (sawApiKey) {
        throw new LlmuxContractError(`\`llmux env\` exported ${ENV_API_KEY_NAME} more than once; refusing to guess.`);
      }
      // Counted, never read: see above.
      sawApiKey = true;
    } else {
      // The variable NAME is withheld too. It is `[A-Z_]`-shaped and so cannot
      // carry a URL or a token body, but this module's rule is that no text
      // derived from child output leaves it, and a one-off exception is how
      // that rule stops being checkable.
      throw new LlmuxContractError(
        `\`llmux env\` line ${index + 1} exported a variable somawork does not expect; llmux's env output contract changed.`,
      );
    }
  }

  if (baseUrl === null) {
    throw new LlmuxContractError(
      `\`llmux env\` did not print ${ENV_BASE_URL_NAME}; somawork cannot tell which endpoint this machine's llmux is serving.`,
    );
  }

  try {
    return validateLlmuxBaseUrl(baseUrl);
  } catch (error) {
    if (error instanceof LlmuxEndpointError) {
      throw new LlmuxContractError(
        `\`llmux env\` named an endpoint that is not a plain local http address; somawork v1 onboards the LOCAL daemon.`,
      );
    }
    throw error;
  }
}

/**
 * Ask llmux where it listens.
 *
 * Runs on the success path only — after the daemon has been restarted and
 * proven healthy — for two reasons that point the same way. The endpoint is
 * only meaningful once there is a daemon behind it, and this is the single
 * command in the flow that prints a live credential, so no failure path spends
 * one on it.
 *
 * `unsafeRawStdout()` is called exactly once, inside the parser, and the
 * redacted `stdout` is never touched: for this command it is not a safe view
 * (module header). Failures quote `stderr` only, which carries llmux's own
 * `CliError` text and never the key `println!`d to stdout.
 */
async function readEndpoint(host: SetupHost, bin: string, policy: Policy): Promise<string> {
  const result = await run(
    host,
    { command: bin, args: ['env'], timeoutMs: policy.envTimeoutMs },
    policy,
    '`llmux env`',
  );

  if (result.timedOut) {
    throw new LlmuxCommandError(
      `\`llmux env\` did not return within ${policy.envTimeoutMs}ms and was terminated; somawork could not learn which endpoint llmux is serving.`,
      'env',
      null,
      boundedDetail(result.stderr),
    );
  }
  if (!result.ok) {
    throw new LlmuxCommandError(
      `\`llmux env\` failed (exit ${String(result.code)}); somawork could not learn which endpoint llmux is serving.`,
      'env',
      result.code,
      boundedDetail(result.stderr),
    );
  }

  return parseLlmuxEnvBaseUrl(result.unsafeRawStdout());
}

// ---------------------------------------------------------------------------
// Command helpers
// ---------------------------------------------------------------------------

function throwIfAborted(policy: Policy, what: string): void {
  if (policy.signal?.aborted) throw new LlmuxCancelledError(`llmux onboarding cancelled ${what}.`);
}

/** Run a command and turn an abort into {@link LlmuxCancelledError}. */
async function run(host: SetupHost, spec: CommandSpec, policy: Policy, what: string) {
  throwIfAborted(policy, `before ${what}`);
  const result = await host.command({ ...spec, signal: policy.signal });
  if (result.aborted) throw new LlmuxCancelledError(`llmux onboarding cancelled during ${what}.`);
  return result;
}

const loginArgs = (group: LlmuxGroup): string[] => (group === 'codex' ? ['login', '--codex'] : ['login']);

/**
 * Run an interactive `llmux login`, streaming its guidance to the human.
 *
 * `spawn`, not `command`, and this is the whole point. `llmux login` prints
 * "If it doesn't open, visit: <url>" and then fires `open` in a way that
 * swallows every failure (`oauth.rs:155-171`). On a headless box, over ssh, or
 * with no default handler, that URL is the user's *only* path through the flow
 * — and `command()` buffers it into a string this adapter would then have to
 * remember to print after the fact, i.e. after the ten-minute timeout it was
 * supposed to prevent. Streaming makes it visible as it arrives.
 *
 * The stream is the host's **redacted** view; the URL is guidance, not a
 * credential, and somawork neither parses nor opens it — llmux owns the browser.
 *
 * Cancel and timeout both kill the child exactly once and then wait for its
 * exit, so no sign-in process is left behind, and the three outcomes stay
 * distinguishable to the caller.
 */
async function login(host: SetupHost, bin: string, group: LlmuxGroup, policy: Policy): Promise<void> {
  const args = loginArgs(group);
  const label = `\`llmux ${args.join(' ')}\``;
  throwIfAborted(policy, `before ${label}`);

  const child = host.spawn({ command: bin, args });

  // Subscribe before awaiting anything: both hosts queue lines emitted before
  // the first listener attaches, but only if someone attaches promptly.
  const tail: string[] = [];
  const forward = (chunk: string) => {
    emitProgressLines(chunk, (line) => {
      tail.push(line);
      if (tail.length > MAX_TAIL_LINES) tail.shift();
      emitProgressSafely(policy.onProgress, line);
    });
  };
  child.onStdout(forward);
  child.onStderr(forward);

  // A holder rather than a bare `let`: the only writes happen inside callbacks,
  // which TypeScript's control-flow analysis cannot see, so a plain `let` stays
  // narrowed to `'exit'` and the classification below becomes dead code.
  const outcome: { disposition: 'exit' | 'timeout' | 'aborted' } = { disposition: 'exit' };
  let killed = false;
  const killOnce = (why: 'timeout' | 'aborted') => {
    if (killed) return;
    killed = true;
    outcome.disposition = why;
    child.kill('SIGTERM');
  };

  const timer = setTimeout(() => killOnce('timeout'), policy.loginTimeoutMs);
  const onAbort = () => killOnce('aborted');
  policy.signal?.addEventListener('abort', onAbort);
  // The signal can have fired between the guard above and this subscription.
  if (policy.signal?.aborted) killOnce('aborted');

  let exit: ProcessExit;
  try {
    exit = await child.exited;
  } finally {
    clearTimeout(timer);
    policy.signal?.removeEventListener('abort', onAbort);
  }

  if (outcome.disposition === 'aborted') {
    throw new LlmuxCancelledError(`llmux onboarding cancelled during ${label}; the sign-in process was terminated.`);
  }
  if (outcome.disposition === 'timeout') {
    throw new LlmuxLoginError(
      `${label} did not finish within ${policy.loginTimeoutMs}ms and was terminated; complete the ${group} sign-in, then re-run setup.`,
      group,
      'timeout',
      null,
      boundedDetail(tail.join('\n')),
    );
  }
  if (exit.code === 0 && exit.signal === null) return;

  throw new LlmuxLoginError(
    `${label} did not complete (exit ${describeExit(exit)}); finish the ${group} sign-in and re-run setup.`,
    group,
    'nonzero',
    exit.code,
    boundedDetail(tail.join('\n')),
  );
}

type Probe =
  | { kind: 'status'; summary: LlmuxAccountSummary }
  /** Daemon is not up yet (or the probe timed out) — safe to poll. */
  | { kind: 'not-running' };

/**
 * One `llmux accounts --json`. Exit 0 must be a status document; exit non-zero
 * must be the not-running document. Everything else (401 text, a foreign
 * listener's reply, garbage) fails loudly instead of being polled forever.
 */
async function probeLiveDaemon(host: SetupHost, bin: string, policy: Policy): Promise<Probe> {
  const result = await run(
    host,
    { command: bin, args: ['accounts', '--json'], timeoutMs: policy.probeTimeoutMs },
    policy,
    '`llmux accounts --json`',
  );

  if (result.timedOut) return { kind: 'not-running' };

  const parsed = tryParseJson(result.unsafeRawStdout());

  if (result.ok) {
    if (!parsed.ok) {
      throw new LlmuxContractError('`llmux accounts --json` exited 0 but its output was not JSON.');
    }
    return { kind: 'status', summary: summariseLlmuxAccounts(parsed.value) };
  }

  if (parsed.ok && isNotRunningDocument(parsed.value)) return { kind: 'not-running' };

  throw new LlmuxContractError(
    `\`llmux accounts --json\` exited ${String(result.code)} without the expected not-running document; check the daemon port and api key.`,
    boundedDetail(result.stderr),
  );
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

async function resolveBinary(
  host: SetupHost,
  policy: Policy,
): Promise<{ bin: string; install: LlmuxInstallDisposition }> {
  const existing = await host.which('llmux');
  if (existing !== null) return { bin: existing, install: 'already-installed' };

  const brew = await host.which('brew');
  if (brew === null) {
    throw new LlmuxInstallError(
      `llmux is not installed and Homebrew (brew) was not found on PATH; install Homebrew, then re-run setup (it installs ${LLMUX_FORMULA}).`,
    );
  }

  const result = await run(
    host,
    { command: brew, args: ['install', LLMUX_FORMULA], timeoutMs: policy.installTimeoutMs },
    policy,
    `\`brew install ${LLMUX_FORMULA}\``,
  );
  if (!result.ok) {
    throw new LlmuxInstallError(
      `\`brew install ${LLMUX_FORMULA}\` failed (exit ${result.timedOut ? 'timeout' : String(result.code)}).`,
      boundedDetail(result.stderr, result.stdout),
    );
  }

  const installed = await host.which('llmux');
  if (installed === null) {
    throw new LlmuxInstallError(
      `\`brew install ${LLMUX_FORMULA}\` reported success but llmux is still not on PATH; check your Homebrew shell environment.`,
    );
  }
  return { bin: installed, install: 'installed-via-brew' };
}

// ---------------------------------------------------------------------------
// Restart + bounded readiness poll
// ---------------------------------------------------------------------------

type MutableProgress = { -readonly [K in keyof LlmuxProgress]: LlmuxProgress[K] };

/**
 * Restart once, then probe until the daemon answers.
 *
 * A **non-zero** restart throws here and never reaches the poll: llmux already
 * spent its own 30s readiness budget before returning, so exit != 0 means a
 * completed hard failure with an actionable reason on stderr (`no accounts
 * configured`, `port N is in use by something that is not llmux`). Polling it
 * would spend the readiness budget and then blame the wrong thing.
 *
 * A **successful** restart can still be a beat ahead of the daemon, and *that*
 * is what the poll is for. Never a second restart — that drains a daemon which
 * is mid-startup.
 */
async function restartAndProbe(
  host: SetupHost,
  bin: string,
  policy: Policy,
  progress: MutableProgress,
): Promise<LlmuxAccountSummary> {
  const result = await run(
    host,
    { command: bin, args: ['restart'], timeoutMs: policy.restartTimeoutMs },
    policy,
    '`llmux restart`',
  );
  progress.restartCount += 1;

  if (result.timedOut) {
    throw new LlmuxRestartError(
      `\`llmux restart\` did not return within ${policy.restartTimeoutMs}ms and was terminated; llmux waits for readiness itself, so this is a wedged daemon, not a slow start.`,
      'restart',
      null,
      boundedDetail(result.stderr, result.stdout),
    );
  }
  if (!result.ok) {
    throw new LlmuxRestartError(
      `\`llmux restart\` failed (exit ${String(result.code)}); llmux already waited for readiness, so this is a hard failure rather than a slow start.`,
      'restart',
      result.code,
      boundedDetail(result.stderr, result.stdout),
    );
  }

  for (let attempt = 1; attempt <= policy.maxReadinessChecks; attempt += 1) {
    const probe = await probeLiveDaemon(host, bin, policy);
    progress.readinessChecks += 1;
    if (probe.kind === 'status') return probe.summary;

    throwIfAborted(policy, 'while waiting for the llmux daemon');
    if (attempt === policy.maxReadinessChecks) break;
    await host.sleep(policy.readinessIntervalMs);
  }

  throw new LlmuxReadinessTimeoutError(
    `The llmux daemon did not report running after ${policy.maxReadinessChecks} checks following a successful \`llmux restart\`; run \`llmux status\` to inspect it.`,
    policy.maxReadinessChecks,
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function unhealthyError(
  summary: LlmuxAccountSummary,
  conditions: readonly LlmuxGroupReport[],
  blocked: readonly LlmuxGroup[],
  cooldown: readonly LlmuxGroup[],
): LlmuxUnhealthyError {
  const cooldownOnly = blocked.length > 0 && blocked.length === cooldown.length;
  const Ctor = cooldownOnly ? LlmuxCooldownError : LlmuxUnhealthyError;
  const message = cooldownOnly
    ? `llmux has no usable account in group(s) ${cooldown.join(', ')}: every account there is rate-limited (cooldown). Signing in again cannot clear a rate limit — wait for the window to reset, or add another account.`
    : `llmux has no healthy account in group(s) ${blocked.join(', ')}${
        cooldown.length > 0 ? ` (rate-limited: ${cooldown.join(', ')})` : ''
      }; claude healthy: ${summary.claudeHealthy}, codex healthy: ${summary.codexHealthy}. Run \`llmux accounts\` to inspect.`;
  return new Ctor(
    message,
    blocked,
    cooldown,
    summary.claudeHealthy,
    summary.codexHealthy,
    summary.statusCounts,
    conditions,
  );
}

/**
 * Install llmux if needed, ensure a Claude OAuth account and a Codex account
 * exist, and leave a running daemon in which both groups are healthy.
 *
 * Command sequence (each step at most once unless noted):
 *
 * ```text
 * which llmux ─┬─ present ────────────────────────────────────────────────┐
 *              └─ absent → which brew → brew install <formula> → which ───┤
 *                                                                         ▼
 *   llmux accounts            offline roster → {hasClaudeOauth, hasCodex}
 *                             · JSON-looking stdout → LlmuxRemoteModeError
 *                             · timeout / non-zero  → LlmuxCommandError
 *   llmux login               iff !hasClaudeOauth   (apikey does NOT satisfy)
 *   llmux login --codex       iff !hasCodex         (spawned + streamed)
 *   llmux restart             RESTART #1 — non-zero fails here, no poll
 *   llmux accounts --json     probe immediately, then bounded sleep-poll
 *   ── per-group condition ──
 *   auth-failed / absent  → exactly one recovery login for that group
 *   cooldown              → never a login; rate limits do not answer to OAuth
 *   unknown status        → LlmuxContractError
 *   llmux restart             RESTART #2 (only if something was re-logged in)
 *   llmux accounts --json     probe + bounded poll again
 *   llmux env                 SUCCESS PATH ONLY — the endpoint llmux serves
 *                             · reduced to one loopback origin at the parser
 *                             · the api key line it may print is discarded
 * ```
 *
 * The endpoint is read last, and it is read from llmux rather than assumed: in
 * LOCAL mode llmux resolves `config.proxy.port` for `accounts`, `restart`, the
 * daemon and `env` alike (`llmux` `src/cli/mod.rs:639`), so a machine whose 3456
 * is already taken by another llmux under the same uid answers with its real
 * port. Assuming 3456 pointed the materialized profile at the other daemon.
 *
 * LOCAL mode is the only mode this pipeline can be in by the time `llmux env`
 * runs. `env` shares `resolve_endpoint` with every other subcommand
 * (`env.rs:17`), and that function prefers a configured `remote.host`
 * (`mod.rs:633`) — but a remote-configured llmux never gets this far: step one,
 * `llmux accounts`, answers with a live JSON document instead of a roster and
 * {@link LlmuxRemoteModeError} ends the run before any login, restart, or read.
 * The parser's loopback gate is a second, independent backstop rather than the
 * thing that makes the claim true, so no runtime branch is needed here.
 */
export async function ensureLlmux(host: SetupHost, options: EnsureLlmuxOptions = {}): Promise<LlmuxReceipt> {
  const policy = resolvePolicy(options);
  const progress: MutableProgress = { install: null, restartCount: 0, readinessChecks: 0 };
  try {
    return await onboard(host, policy, progress);
  } catch (error) {
    // Every failure carries how far we got, so Task 10 can resume and a doctor
    // can tell "never installed" from "installed but the daemon won't come up".
    if (error instanceof LlmuxError && error.progress === null) error.progress = { ...progress };
    throw error;
  }
}

async function onboard(host: SetupHost, policy: Policy, progress: MutableProgress): Promise<LlmuxReceipt> {
  throwIfAborted(policy, 'before it started');

  const { bin, install } = await resolveBinary(host, policy);
  progress.install = install;

  const roster = await readOfflineRoster(host, bin, policy);

  const claudeLoginPerformed = !roster.hasClaudeOauth;
  const codexLoginPerformed = !roster.hasCodex;
  if (claudeLoginPerformed) await login(host, bin, 'claude', policy);
  if (codexLoginPerformed) await login(host, bin, 'codex', policy);

  let summary = await restartAndProbe(host, bin, policy, progress);
  let conditions = conditionsFor(summary);

  let claudeReloginPerformed = false;
  let codexReloginPerformed = false;

  const recoverable = groupsWith(conditions, ['auth-failed', 'absent']);
  const cooldown = groupsWith(conditions, ['cooldown']);

  if (recoverable.length === 0 && cooldown.length > 0) {
    // Nothing a login could fix. Fail now rather than after a pointless browser
    // round trip and a second daemon restart.
    throw unhealthyError(summary, conditions, cooldown, cooldown);
  }

  if (recoverable.length > 0) {
    // Exactly one recovery pass: one re-login per recoverable group, one restart.
    for (const group of recoverable) {
      await login(host, bin, group, policy);
      if (group === 'claude') claudeReloginPerformed = true;
      else codexReloginPerformed = true;
    }
    summary = await restartAndProbe(host, bin, policy, progress);
    conditions = conditionsFor(summary);
  }

  const blocked = groupsWith(conditions, ['auth-failed', 'absent', 'cooldown']);
  if (blocked.length > 0) {
    throw unhealthyError(summary, conditions, blocked, groupsWith(conditions, ['cooldown']));
  }

  const baseUrl = await readEndpoint(host, bin, policy);

  return {
    install,
    baseUrl,
    claudeLoginPerformed,
    codexLoginPerformed,
    claudeReloginPerformed,
    codexReloginPerformed,
    restartCount: progress.restartCount,
    readinessChecks: progress.readinessChecks,
    claudeHealthy: summary.claudeHealthy,
    codexHealthy: summary.codexHealthy,
  };
}
