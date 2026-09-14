/**
 * Ordinary Slack CLI authorization (ticket/challenge), as a {@link SetupHost}
 * adapter.
 *
 * ## What this owns
 *
 * Getting the machine to a state where the Slack CLI holds a usable
 * authorization for the workspace somawork is being installed into, and telling
 * the caller *which* one that is. It drives the `slack` binary and nothing
 * else: it never reads `~/.slack/credentials.json`, never touches the developer
 * token the CLI stores there, and never installs the CLI (packaging is Task
 * 11's job — a missing binary is reported as an actionable precondition).
 *
 * ## Why the sequence is what it is
 *
 * `slack auth list` has **no** JSON mode (`cmd/auth/list.go`, and the published
 * reference lists `help` as its only command flag), so the adapter parses text
 * with a **source-pinned strict parser** — pinned to the Go printing code it
 * was derived from, not to a declared CLI version range; the actual dependency
 * floor is Task 11's. That is only safe if the grammar is strict:
 * anything unrecognised inside a non-empty block is a contract failure, never
 * "no authorization" — misreading it that way would push an already-authorized
 * user through a second ticket flow.
 *
 * The completion step is the interesting one. `LoginNoPrompt`
 * (`internal/pkg/auth/login.go:242-271`) returns a **nil error** when the
 * ticket exchange is not ready yet:
 *
 * ```go
 * if err != nil || !authExchangeRes.IsReady {
 *     return types.SlackAuth{}, "", err     // err is nil in the not-ready case
 * }
 * ```
 *
 * and `RunLoginCommand` only prints on a non-empty token, so an unapproved
 * challenge exits **0**, prints nothing, and saves nothing. Exit code alone is
 * therefore never proof of authorization; the adapter always re-reads
 * `auth list` and requires the authorization to actually be there.
 *
 * ## Secret discipline
 *
 * Two ephemeral secrets pass through this module: the auth ticket and the
 * challenge code.
 *
 * - The **ticket** reaches the user through one deliberate, documented carrier
 *   — the injected {@link EnsureSlackCliAuthOptions.onInstruction} callback —
 *   because the user has to paste `/slackauthticket …` into Slack themselves.
 *   It also goes on the clipboard, with the value registered as sensitive so
 *   the recorded call is masked.
 * - The **challenge** is read through `host.promptSecret`, which never echoes
 *   and never records the answer.
 * - Both appear in argv exactly once, on the completion command. That is the
 *   single provider-mandated exception to the no-secret-in-argv rule
 *   (`slack auth login --ticket … --challenge …` is the documented completion
 *   form and the CLI offers no stdin or env alternative). Both are registered
 *   in `sensitiveValues`, so every display surface and the recorded call are
 *   masked; only `unsafeRawCalls()` — a test-only view — sees them.
 *
 * Nothing else carries either value: not the receipt, not an error, not a
 * message, not the environment.
 *
 * ## Raw-output boundary
 *
 * `unsafeRawStdout()` is called at exactly two places
 * ({@link readAuthorizations}, {@link requestTicket}) and each result is reduced
 * to safe records — or to the ticket, which is then handled as above — in the
 * same expression. The `slack version` banner is read through the *redacted*
 * view because it is human output, not machine output, and it is bounded to a
 * version-shaped token before it reaches the receipt.
 */

import type { CommandSpec, SetupHost } from './host';
import { SecretPromptError } from './host';

/** Bare binary name looked up on PATH. Resolved to an absolute path once. */
export const SLACK_BIN = 'slack';

/** Flags forced on every invocation so the output grammar stays parseable. */
const GLOBAL_FLAGS = ['--no-color', '--skip-update'] as const;

/**
 * Trace output is opt-in through `SLACK_TEST_TRACE`
 * (`internal/config/config.go:30`) and would inject extra lines into the
 * listing. Pinned in the child env — env, never argv — so a developer machine
 * that exports it does not break onboarding.
 */
const CHILD_ENV: Readonly<Record<string, string>> = { SLACK_TEST_TRACE: 'false' };

/** The slash command the user pastes into Slack. */
export const TICKET_SLASH_COMMAND = '/slackauthticket';

/** Prompt used for the no-echo challenge read. Exported so tests can script it. */
export const SLACK_CHALLENGE_PROMPT = 'Slack challenge: ';

/** First line of the empty-auth banner (`cmd/auth/list.go:107`). */
const NO_AUTH_LINE = 'You are not logged in to any Slack accounts';
/**
 * Its follow-up guidance (`cmd/auth/list.go:119-122`). Matched by prefix: the
 * tail is a rendered command name, and pinning it in full would brick setup on
 * its single most common path — a machine with no authorization at all.
 */
const NO_AUTH_HINT_PREFIX = 'To login to a Slack account, run';

const HEADER_RE = /^(.+) \(Team ID: ([TE][A-Z0-9]{1,20})\)$/;
const USER_RE = /^User ID: ([UW][A-Z0-9]{1,20})$/;
const API_HOST_RE = /^API Host: \S.*$/;
/** Go layout `2006-01-02 15:04:05 Z07:00` — a zero offset renders as `Z`. */
const LAST_UPDATED_RE = /^Last Updated: (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} (?:[+-]\d{2}:\d{2}|Z))$/;
const LEVEL_RE = /^Authorization Level: ([A-Za-z][A-Za-z0-9 ._-]{0,63})$/;
const TICKET_LINE_RE = /^\/slackauthticket (\S{8,4096})$/;
const TEAM_ID_RE = /^[TE][A-Z0-9]{1,20}$/;
const VERSION_BANNER_RE = /^Using \S+ (\S+)$/;
const VERSION_VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
/** Unicode `Cc` — the C0 and C1 control ranges, written without literal bytes. */
const CONTROL_CHAR_RE = /\p{Cc}/u;

/** Longest redacted child-output tail copied into an error message. */
const MAX_DETAIL_CHARS = 400;
/** Longest accepted challenge, so a paste accident cannot become giant argv. */
const MAX_CHALLENGE_CHARS = 512;
/** Longest accepted team domain. */
const MAX_DOMAIN_CHARS = 255;
/** Recorded when the version banner does not match the known shape. */
const UNKNOWN_VERSION = 'unknown';

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

/**
 * One authorization, reduced from the listing.
 *
 * `authorizationLevel` keeps Slack's own field name because this type is a
 * parse product, not a persisted one — `assertSecretFree` rejects the word
 * `authorization` as a key, so the persisted {@link SlackCliAuthReceipt} renames
 * it to `accessLevel`.
 */
export interface SlackAuthRecord {
  teamId: string;
  userId: string;
  domain: string;
  authorizationLevel: string;
  /** Whether the CLI printed an `API Host:` line. The host itself is dropped. */
  hasCustomApiHost: boolean;
  lastUpdated: string;
}

/** The minimum a picker needs. Deliberately nothing else. */
export interface SlackAuthCandidate {
  teamId: string;
  domain: string;
}

/**
 * Secret-safe evidence that the Slack CLI is authorized for one workspace.
 *
 * Designed to pass `assertSecretFree` so Task 10 can persist it verbatim:
 * no ticket, no challenge, no developer token, no credentials path, no raw
 * output, and no field name the state gate reads as a credential.
 */
export interface SlackCliAuthReceipt {
  teamId: string;
  userId: string;
  domain: string;
  /** Slack's "Authorization Level" (`Workspace` / `Enterprise`), renamed. */
  accessLevel: string;
  hasCustomApiHost: boolean;
  lastUpdated: string;
  /** Bounded `slack version` token, or `unknown` when the banner changed. */
  cliVersion: string;
  /** How many authorizations the final listing held. */
  workspaceCount: number;
  /** A fresh ticket/challenge authorization ran during this call. */
  loginPerformed: boolean;
  /** The slash command reached the system clipboard. */
  instructionCopiedToClipboard: boolean;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** The persistable projection of a Slack authorization failure. */
export interface SlackAuthErrorJson {
  name: string;
  summary: string;
}

/**
 * Base class so a caller can catch every Slack authorization failure at once.
 *
 * Two views, as in the llmux adapter: `message` is for the human and may end
 * with a bounded, host-**redacted** tail of the CLI's own diagnostic, while
 * `toJSON()` returns `summary` only, so the persisted shape carries no child
 * output at all and clears `assertSecretFree` by construction.
 */
export class SlackAuthError extends Error {
  /** Child-output-free restatement of the failure. Safe to persist. */
  readonly summary: string;

  constructor(summary: string, detail?: string | null) {
    super(detail ? `${summary} The Slack CLI said: ${detail}` : summary);
    this.name = new.target.name;
    this.summary = summary;
  }

  toJSON(): SlackAuthErrorJson {
    return { name: this.name, summary: this.summary };
  }
}

/** Bad arguments. Thrown before any host call. */
export class SlackAuthOptionsError extends SlackAuthError {}

/** The `slack` binary is not on PATH. Task 11 owns installing it. */
export class SlackCliMissingError extends SlackAuthError {}

/** `slack version` did not run. The binary is present but unusable. */
export class SlackCliVersionError extends SlackAuthError {}

/** The CLI printed something this adapter's version-pinned grammar rejects. */
export class SlackAuthContractError extends SlackAuthError {}

/** A `slack` command exited non-zero or timed out. */
export class SlackAuthCommandError extends SlackAuthError {
  constructor(
    summary: string,
    /** Which step ran: `version`, `list`, `ticket`, `completion`. Never argv. */
    readonly step: 'version' | 'list' | 'ticket' | 'completion',
    readonly exitStatus: number | null,
    detail?: string | null,
  ) {
    super(summary, detail);
  }

  override toJSON() {
    return { ...super.toJSON(), step: this.step, exitStatus: this.exitStatus };
  }
}

/** The ticket request produced no single usable `/slackauthticket` line. */
export class SlackAuthTicketError extends SlackAuthError {}

/** No `onInstruction` sink, so a requested ticket could never be shown. */
export class SlackAuthInstructionSinkError extends SlackAuthError {}

/** The typed challenge was empty, or unusable as an argument. */
export class SlackAuthChallengeError extends SlackAuthError {}

/**
 * The ticket exchange did not produce an authorization.
 *
 * Covers the invalid / denied / expired outcomes. Never retried: a ticket is
 * single-use, so a retry would exchange a spent value. Re-running setup mints a
 * fresh one.
 */
export class SlackAuthCompletionError extends SlackAuthCommandError {
  constructor(summary: string, exitStatus: number | null, detail?: string | null) {
    super(summary, 'completion', exitStatus, detail);
  }
}

/**
 * The completion exited 0 but no authorization exists — the pending case from
 * `LoginNoPrompt`'s `!IsReady` branch. A subclass so a caller that only cares
 * about "the exchange failed" still catches it.
 */
export class SlackAuthNotReadyError extends SlackAuthCompletionError {}

/** Several authorizations exist and the caller did not say which one. */
export class SlackAuthSelectionRequiredError extends SlackAuthError {
  constructor(
    summary: string,
    readonly candidates: readonly SlackAuthCandidate[],
    /**
     * Whether a fresh ticket/challenge authorization completed before the
     * ambiguity appeared. Without it a resume path cannot tell "authorized,
     * needs a pick" from "never authorized".
     */
    readonly loginPerformed: boolean = false,
  ) {
    super(summary);
  }

  override toJSON() {
    return {
      ...super.toJSON(),
      candidates: this.candidates.map((c) => ({ ...c })),
      loginPerformed: this.loginPerformed,
    };
  }
}

/** The requested Team ID is not among the authorizations. */
export class SlackAuthTeamNotFoundError extends SlackAuthError {
  constructor(
    summary: string,
    readonly requestedTeam: string,
    readonly candidates: readonly SlackAuthCandidate[],
    /** See {@link SlackAuthSelectionRequiredError.loginPerformed}. */
    readonly loginPerformed: boolean = false,
  ) {
    super(summary);
  }

  override toJSON() {
    return {
      ...super.toJSON(),
      requestedTeam: this.requestedTeam,
      candidates: this.candidates.map((c) => ({ ...c })),
      loginPerformed: this.loginPerformed,
    };
  }
}

/** The caller's `AbortSignal` fired. Distinct so an orchestrator can resume. */
export class SlackAuthCancelledError extends SlackAuthError {}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/** Tunables. All optional, so `ensureSlackCliAuth(host)` stays a one-arg call. */
export interface EnsureSlackCliAuthOptions {
  /** Cancels the whole flow, including a pending completion. */
  signal?: AbortSignal;
  /**
   * The one user-facing carrier for the full `/slackauthticket <ticket>` line.
   *
   * **Intentional and documented:** the ordinary Slack CLI authorization is a
   * conversation flow — the user pastes this slash command into any Slack
   * channel or DM, approves the permissions modal, and reads back a challenge
   * code. There is no way to complete it without showing them the command, so
   * this callback receives the ticket verbatim and is the only place that does.
   * It is an ephemeral display sink: do not log it, persist it, or put it in a
   * report. Without it, `ensureSlackCliAuth` refuses to request a ticket at
   * all rather than mint an invisible one.
   *
   * May be async; the flow awaits it before doing anything else, because
   * nothing after this point is worth doing if the user never saw the command.
   * A sink that throws or rejects becomes a
   * {@link SlackAuthInstructionSinkError} carrying only the failing error's
   * *class name* — never its message, which for a renderer typically quotes the
   * very line it failed to write.
   */
  onInstruction?: (text: string) => void | Promise<void>;
  /** Cap on `slack version`. Default 30000ms. */
  versionTimeoutMs?: number;
  /** Cap on `slack auth list`. Default 30000ms. */
  listTimeoutMs?: number;
  /** Cap on the ticket request. Default 60000ms. */
  ticketTimeoutMs?: number;
  /** Cap on the ticket/challenge exchange. Default 120000ms. */
  completionTimeoutMs?: number;
  /**
   * Cap on the best-effort clipboard write. Default 10000ms.
   *
   * Finite by construction: `pbcopy` against a wedged pasteboard server never
   * exits, and this is the one child that runs while a live auth ticket is in
   * hand.
   */
  clipboardTimeoutMs?: number;
}

type Tunables = Required<Omit<EnsureSlackCliAuthOptions, 'signal' | 'onInstruction'>>;

const DEFAULTS: Tunables = {
  versionTimeoutMs: 30_000,
  listTimeoutMs: 30_000,
  ticketTimeoutMs: 60_000,
  completionTimeoutMs: 120_000,
  clipboardTimeoutMs: 10_000,
};

const TUNABLE_KEYS = Object.keys(DEFAULTS) as Array<keyof Tunables>;

type Policy = Tunables & { signal?: AbortSignal; onInstruction?: (text: string) => void | Promise<void> };

/** Drop explicit `undefined` so it cannot clobber a default via spread. */
function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Merge and validate options **before** the first host call. */
function resolvePolicy(options: EnsureSlackCliAuthOptions): Policy {
  const merged: Policy = { ...DEFAULTS, ...stripUndefined(options) };
  for (const key of TUNABLE_KEYS) {
    const value = merged[key];
    if (!Number.isInteger(value) || value <= 0) {
      throw new SlackAuthOptionsError(
        `ensureSlackCliAuth option \`${key}\` must be a positive whole number of milliseconds; received ${String(value)}.`,
      );
    }
  }
  if (merged.onInstruction !== undefined && typeof merged.onInstruction !== 'function') {
    throw new SlackAuthOptionsError('ensureSlackCliAuth option `onInstruction` must be a function.');
  }
  return merged;
}

/** Validate the caller's Team ID so a bad one never reaches an error message. */
function resolveRequestedTeam(requestedTeam: string | undefined): string | null {
  if (requestedTeam === undefined) return null;
  // Upper-cased after trimming: Slack ids are canonically uppercase, so this
  // cannot create a false match, and rejecting `t01abc…` as "malformed" when it
  // differs only in case is a needless brick.
  const trimmed = requestedTeam.trim().toUpperCase();
  if (!TEAM_ID_RE.test(trimmed)) {
    throw new SlackAuthOptionsError(
      'ensureSlackCliAuth `requestedTeam` must be a Slack Team ID such as `T0123456789` (or an enterprise `E…` id).',
    );
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// Redacted-output helpers (safe views only — never `unsafeRaw*`)
// ---------------------------------------------------------------------------

/**
 * Collapse an already-redacted child-output blob into one bounded line.
 * Input is redacted by the host; this only bounds the size so a runaway child
 * cannot turn an error message into a log dump.
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

// ---------------------------------------------------------------------------
// Auth-list grammar (raw-output boundary #1)
// ---------------------------------------------------------------------------

interface NumberedLine {
  text: string;
  /** 1-based line number in the original output. The only thing errors quote. */
  number: number;
}

/**
 * Report a grammar violation by **line number only**.
 *
 * The line itself carries the workspace identity (domain, team id, user id, a
 * custom API host), so quoting it would put exactly the thing this adapter
 * exists to keep out of reports into every error message.
 */
function contractAt(line: NumberedLine, expected: string): SlackAuthContractError {
  return new SlackAuthContractError(
    `\`slack auth list\` line ${line.number} is not ${expected}; the Slack CLI output contract changed, so setup will not guess.`,
  );
}

function validateDomain(domain: string, line: NumberedLine): void {
  if (domain.length === 0 || domain.length > MAX_DOMAIN_CHARS) throw contractAt(line, 'a plausible workspace domain');
  if (domain !== domain.trim()) throw contractAt(line, 'a workspace domain without surrounding whitespace');
  // Also rejects ANSI escapes, which is how a missing `--no-color` shows up.
  if (CONTROL_CHAR_RE.test(domain)) throw contractAt(line, 'an unstyled workspace domain (is `--no-color` set?)');
}

function parseBlock(block: NumberedLine[], seenTeams: Set<string>): SlackAuthRecord {
  let index = 0;
  const nextLine = (what: string): NumberedLine => {
    const line = block[index];
    if (line === undefined) {
      const last = block[block.length - 1];
      throw new SlackAuthContractError(
        `\`slack auth list\` block ending at line ${last.number} has no ${what} line; the Slack CLI output contract changed.`,
      );
    }
    index += 1;
    return line;
  };

  const header = nextLine('workspace header');
  const headerMatch = HEADER_RE.exec(header.text);
  if (headerMatch === null) throw contractAt(header, 'a `<domain> (Team ID: T…)` header');
  const domain = headerMatch[1];
  const teamId = headerMatch[2];
  validateDomain(domain, header);
  if (seenTeams.has(teamId)) {
    throw new SlackAuthContractError(
      `\`slack auth list\` line ${header.number} repeats a Team ID already listed; setup will not guess which authorization is meant.`,
    );
  }
  seenTeams.add(teamId);

  const userLine = nextLine('`User ID:`');
  const userMatch = USER_RE.exec(userLine.text);
  if (userMatch === null) throw contractAt(userLine, 'a `User ID: U…` line');

  // The value is never captured: a custom API host is deployment topology and
  // has no business in a receipt or an error. Its presence is the only signal.
  let hasCustomApiHost = false;
  if (index < block.length && API_HOST_RE.test(block[index].text)) {
    index += 1;
    hasCustomApiHost = true;
  }

  const updatedLine = nextLine('`Last Updated:`');
  const updatedMatch = LAST_UPDATED_RE.exec(updatedLine.text);
  if (updatedMatch === null) throw contractAt(updatedLine, 'a `Last Updated: YYYY-MM-DD HH:MM:SS ±HH:MM` line');

  const levelLine = nextLine('`Authorization Level:`');
  const levelMatch = LEVEL_RE.exec(levelLine.text);
  if (levelMatch === null) throw contractAt(levelLine, 'an `Authorization Level: …` line');

  // Duplicated and unknown trailing lines both land here.
  if (index !== block.length) throw contractAt(block[index], 'the end of a workspace block');

  return {
    teamId,
    userId: userMatch[1],
    domain,
    authorizationLevel: levelMatch[1],
    hasCustomApiHost,
    lastUpdated: updatedMatch[1],
  };
}

/**
 * Parse `slack auth list --no-color` into safe records.
 *
 * `text` is consumed here and nowhere else. Blocks are blank-line separated
 * (`cmd/auth/list.go:66-112` prints a leading blank line and a trailing blank
 * after every block), so CRLF and trailing blanks are absorbed while every
 * non-blank line still has to earn its place in the grammar.
 *
 * The empty-auth banner is the *only* zero-authorization answer. Unrecognised
 * output throws rather than degrading to `[]`, because "no authorization" sends
 * the caller into a fresh ticket flow on a machine that may already be
 * authorized.
 */
export function parseSlackAuthList(text: string): SlackAuthRecord[] {
  const groups: NumberedLine[][] = [];
  let current: NumberedLine[] = [];
  for (const [index, raw] of text.replace(/\r\n?/g, '\n').split('\n').entries()) {
    const line: NumberedLine = { text: raw, number: index + 1 };
    if (line.text.trim().length === 0) {
      if (current.length > 0) {
        groups.push(current);
        current = [];
      }
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) groups.push(current);

  if (groups.length === 0) {
    throw new SlackAuthContractError(
      '`slack auth list` printed nothing; expected an authorization listing or the not-logged-in banner.',
    );
  }

  const first = groups[0];
  if (first.length === 1 && first[0].text === NO_AUTH_LINE) {
    for (const group of groups.slice(1)) {
      if (!group[0].text.startsWith(NO_AUTH_HINT_PREFIX)) throw contractAt(group[0], 'the expected login guidance');
    }
    return [];
  }

  const seenTeams = new Set<string>();
  return groups.map((group) => parseBlock(group, seenTeams));
}

// ---------------------------------------------------------------------------
// Ticket grammar (raw-output boundary #2)
// ---------------------------------------------------------------------------

/**
 * Pull the one auth ticket out of the login instructions.
 *
 * `printAuthTicketSubmissionInstructions` prints an explanatory section and
 * then a single standalone `/slackauthticket <ticket>` line. The prose is not
 * pinned — it is guidance and will be reworded — but the slash line is, and
 * strictly: the source itself notes (issues #99 and #129) that an indented or
 * decorated slash command silently fails to execute inside Slack, so a line
 * that is not exactly executable is a malformed line, not a ticket.
 *
 * Zero, several, or malformed candidates all fail. Returning "the first one"
 * would hand the user a command Slack cannot run, or the wrong ticket.
 */
function parseSlackAuthTicket(text: string): string {
  // Anchored at column zero, not `includes`: the prose around the command is
  // explicitly unpinned, and a rewording as ordinary as "Run the
  // /slackauthticket command below" would otherwise count as a second candidate
  // and hard-fail — after a live ticket has already been minted.
  const candidates = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => line.startsWith(TICKET_SLASH_COMMAND));

  if (candidates.length === 0) {
    throw new SlackAuthTicketError(
      `\`slack auth login --no-prompt\` printed no \`${TICKET_SLASH_COMMAND}\` line; setup cannot continue without an auth ticket.`,
    );
  }
  if (candidates.length > 1) {
    throw new SlackAuthTicketError(
      `\`slack auth login --no-prompt\` printed ${candidates.length} \`${TICKET_SLASH_COMMAND}\` lines; setup will not guess which ticket is live.`,
    );
  }

  const match = TICKET_LINE_RE.exec(candidates[0]);
  const ticket = match?.[1];
  // The ticket is an opaque server value (`GenerateAuthTicketResult.Ticket`);
  // nothing in the CLI constrains its alphabet, so the only checks are the ones
  // that are actually security- or executability-relevant: a single
  // whitespace-free token, no control characters, a length bound, and no
  // leading `-` that argv would read as a flag.
  if (ticket === undefined || ticket.startsWith('-') || CONTROL_CHAR_RE.test(ticket)) {
    // No line text and no partial value in the message: the malformed line
    // still contains a ticket.
    throw new SlackAuthTicketError(
      `\`slack auth login --no-prompt\` printed a \`${TICKET_SLASH_COMMAND}\` line that is not an executable slash command; the Slack CLI output contract changed.`,
    );
  }
  return ticket;
}

// ---------------------------------------------------------------------------
// Command helpers
// ---------------------------------------------------------------------------

function throwIfAborted(policy: Policy, what: string): void {
  if (policy.signal?.aborted) throw new SlackAuthCancelledError(`Slack CLI authorization cancelled ${what}.`);
}

/** Run a `slack` command and turn an abort into {@link SlackAuthCancelledError}. */
async function run(host: SetupHost, spec: CommandSpec, policy: Policy, what: string) {
  throwIfAborted(policy, `before ${what}`);
  const result = await host.command({ ...spec, env: CHILD_ENV, signal: policy.signal });
  if (result.aborted) throw new SlackAuthCancelledError(`Slack CLI authorization cancelled during ${what}.`);
  return result;
}

const slackSpec = (bin: string, args: readonly string[], timeoutMs: number): CommandSpec => ({
  command: bin,
  args: [...args, ...GLOBAL_FLAGS],
  timeoutMs,
});

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * Bound the version banner to a version-shaped token.
 *
 * Read from the **redacted** view: this is a human banner, not machine output.
 * An unrecognised banner yields `unknown` rather than a hard failure — the
 * version is diagnostic, and bricking onboarding over a cosmetic string is a
 * worse outcome than a missing field.
 */
function parseCliVersion(text: string): string {
  const line = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((value) => value.trim())
    .find((value) => value.length > 0);
  const match = line === undefined ? null : VERSION_BANNER_RE.exec(line);
  const value = match?.[1];
  return value !== undefined && VERSION_VALUE_RE.test(value) ? value : UNKNOWN_VERSION;
}

async function readVersion(host: SetupHost, bin: string, policy: Policy): Promise<string> {
  const result = await run(host, slackSpec(bin, ['version'], policy.versionTimeoutMs), policy, '`slack version`');

  if (result.timedOut) {
    throw new SlackCliVersionError(
      `\`slack version\` did not return within ${policy.versionTimeoutMs}ms and was terminated; the Slack CLI on PATH is not usable.`,
      boundedDetail(result.stderr, result.stdout),
    );
  }
  if (!result.ok) {
    throw new SlackCliVersionError(
      `\`slack version\` failed (exit ${String(result.code)}); the Slack CLI on PATH is not usable.`,
      boundedDetail(result.stderr, result.stdout),
    );
  }
  return parseCliVersion(result.stdout);
}

/** Read and classify the listing, inspecting the command result first. */
async function readAuthorizations(host: SetupHost, bin: string, policy: Policy): Promise<SlackAuthRecord[]> {
  const result = await run(host, slackSpec(bin, ['auth', 'list'], policy.listTimeoutMs), policy, '`slack auth list`');

  if (result.timedOut) {
    throw new SlackAuthCommandError(
      `\`slack auth list\` did not return within ${policy.listTimeoutMs}ms and was terminated.`,
      'list',
      null,
      // stderr ONLY. A killed `auth list` has usually already flushed part of
      // the listing, and redaction does not mask a workspace domain, a team or
      // user id, or a custom API host — none of them match a vendor token
      // pattern. Quoting stdout here would put exactly the identity this module
      // refuses to print anywhere else into the one path that survives to
      // `SetupState.lastError`.
      boundedDetail(result.stderr),
    );
  }
  if (!result.ok) {
    throw new SlackAuthCommandError(
      `\`slack auth list\` failed (exit ${String(result.code)}); somawork could not read the Slack CLI authorizations.`,
      'list',
      result.code,
      boundedDetail(result.stderr),
    );
  }
  return parseSlackAuthList(result.unsafeRawStdout());
}

/** Request a fresh ticket. The return value is a secret; treat it as one. */
async function requestTicket(host: SetupHost, bin: string, policy: Policy): Promise<string> {
  const result = await run(
    host,
    slackSpec(bin, ['auth', 'login', '--no-prompt'], policy.ticketTimeoutMs),
    policy,
    '`slack auth login --no-prompt`',
  );

  if (result.timedOut) {
    throw new SlackAuthCommandError(
      `\`slack auth login --no-prompt\` did not return within ${policy.ticketTimeoutMs}ms and was terminated.`,
      'ticket',
      null,
      // stderr only: stdout is where the ticket is printed.
      boundedDetail(result.stderr),
    );
  }
  if (!result.ok) {
    throw new SlackAuthCommandError(
      `\`slack auth login --no-prompt\` failed (exit ${String(result.code)}); Slack did not issue an auth ticket.`,
      'ticket',
      result.code,
      boundedDetail(result.stderr),
    );
  }
  return parseSlackAuthTicket(result.unsafeRawStdout());
}

/**
 * Read the challenge with no echo.
 *
 * The value is validated as an argument before it can reach argv: empty means
 * the user pressed enter, and a leading `-` or an embedded newline is either a
 * paste accident or an injection attempt. Nothing about the value — not its
 * length, not a prefix — appears in the failure.
 */
async function readChallenge(host: SetupHost, policy: Policy): Promise<string> {
  throwIfAborted(policy, 'before the challenge prompt');

  let raw: string;
  try {
    raw = await host.promptSecret(SLACK_CHALLENGE_PROMPT, { signal: policy.signal });
  } catch (error) {
    // Branch on the discriminant, not on the message: `cancelled` (Ctrl-C) and
    // `aborted` both mean the human walked away, which is the branch a resume
    // path keys on. Only `unavailable` (no TTY) is an input problem. Ctrl-C is
    // the common case and `signal` is optional, so message-matching would have
    // mis-classified the default path.
    if (error instanceof SecretPromptError) {
      if (error.reason === 'cancelled' || error.reason === 'aborted' || policy.signal?.aborted) {
        throw new SlackAuthCancelledError('Slack CLI authorization cancelled while waiting for the challenge code.');
      }
      throw new SlackAuthChallengeError(`Could not read the Slack challenge code: ${error.message}`);
    }
    if (policy.signal?.aborted) {
      throw new SlackAuthCancelledError('Slack CLI authorization cancelled while waiting for the challenge code.');
    }
    throw error;
  }

  const challenge = raw.trim();
  if (challenge.length === 0) {
    throw new SlackAuthChallengeError(
      'No Slack challenge code was entered. Approve the permissions modal in Slack, copy the challenge code it shows, then re-run setup.',
    );
  }
  if (challenge.length > MAX_CHALLENGE_CHARS || challenge.startsWith('-') || CONTROL_CHAR_RE.test(challenge)) {
    throw new SlackAuthChallengeError(
      'The Slack challenge code is not a usable value (it is too long, starts with `-`, or contains a control character). Copy just the code Slack showed you and re-run setup.',
    );
  }
  return challenge;
}

/**
 * Exchange the ticket for an authorization.
 *
 * **The one provider-mandated secret-in-argv exception.** `slack auth login
 * --no-prompt --ticket <t> --challenge <c>` is the documented completion form
 * and the CLI accepts these values through no other channel — not stdin, not
 * env. Both are registered in `sensitiveValues`, so the host masks them in the
 * recorded call and in every display built from the result.
 *
 * Never retried. The ticket is single-use, so a retry would spend a value
 * Slack has already consumed; a fresh, explicit re-run mints a new one.
 */
async function completeLogin(
  host: SetupHost,
  bin: string,
  ticket: string,
  challenge: string,
  policy: Policy,
): Promise<void> {
  const spec: CommandSpec = {
    command: bin,
    args: ['auth', 'login', '--no-prompt', '--ticket', ticket, '--challenge', challenge, ...GLOBAL_FLAGS],
    timeoutMs: policy.completionTimeoutMs,
    sensitiveValues: [ticket, challenge],
  };
  const result = await run(host, spec, policy, '`slack auth login --ticket …`');

  if (result.timedOut) {
    throw new SlackAuthCompletionError(
      `The Slack ticket exchange did not return within ${policy.completionTimeoutMs}ms and was terminated; re-run setup to start a fresh authorization.`,
      null,
      boundedDetail(result.stderr),
    );
  }
  if (!result.ok) {
    throw new SlackAuthCompletionError(
      `The Slack ticket exchange failed (exit ${String(result.code)}). The ticket may have expired or the challenge may have been wrong or denied; re-run setup to start a fresh authorization.`,
      result.code,
      boundedDetail(result.stderr),
    );
  }
}

/** Put the slash command where the user can paste it from. Never fatal. */
/**
 * Put the slash command where the user can paste it from. Best-effort.
 *
 * Runs **after** {@link deliverInstruction}, and bounded: the user has already
 * seen the command by the time the pasteboard is touched, so a wedged `pbcopy`
 * can only cost `clipboardTimeoutMs`, never strand a live ticket the user never
 * saw. A miss is a modelled outcome (`instructionCopiedToClipboard: false`),
 * not a failure — but a *cancellation* is not a miss, and the caller checks
 * `signal` immediately after this returns.
 *
 * The thrown error is dropped on purpose: `RealHost` builds it from a command
 * result whose stdin was the ticket.
 */
async function copyInstruction(host: SetupHost, command: string, ticket: string, policy: Policy): Promise<boolean> {
  try {
    await host.copyToClipboard(command, {
      sensitiveValues: [ticket],
      timeoutMs: policy.clipboardTimeoutMs,
      ...(policy.signal === undefined ? {} : { signal: policy.signal }),
    });
    return true;
  } catch {
    return false;
  }
}

/** Bounded, safe class name of a foreign error. Never its message. */
function sinkErrorLabel(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : 'an unnamed error';
}

/**
 * Hand the slash command to the caller's sink, guarded.
 *
 * This is the only place a caller's own code runs inside the flow, and it runs
 * holding the ticket. An unguarded throw would escape the documented
 * `SlackAuthError` hierarchy *and* — for the ordinary renderer shape
 * `failed to write "<line>"` — carry the ticket out inside a foreign,
 * unredacted message. So: catch everything, await a promise, and re-throw a
 * typed error built from the class name alone.
 *
 * A failing sink stops the flow here. The ticket is spent from somawork's point
 * of view; nothing is copied, prompted, or exchanged, and a re-run mints a
 * fresh one.
 */
async function deliverInstruction(
  onInstruction: (text: string) => void | Promise<void>,
  command: string,
): Promise<void> {
  try {
    await onInstruction(command);
  } catch (error) {
    throw new SlackAuthInstructionSinkError(
      `Setup could not display the \`${TICKET_SLASH_COMMAND}\` command: the display callback failed with ${sinkErrorLabel(error)}. Nothing was copied or submitted; re-run setup to start a fresh authorization.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

const candidatesOf = (auths: readonly SlackAuthRecord[]): SlackAuthCandidate[] =>
  auths.map((auth) => ({ teamId: auth.teamId, domain: auth.domain }));

/**
 * Pick the authorization this setup run is about.
 *
 * An enterprise `E…` id selects like any other. Whether somawork *supports* an
 * enterprise install is Task 6's call; silently coercing it to a workspace here
 * would hide the question.
 */
function selectAuthorization(
  auths: readonly SlackAuthRecord[],
  requestedTeam: string | null,
  loginPerformed: boolean,
): SlackAuthRecord {
  if (requestedTeam !== null) {
    const matches = auths.filter((auth) => auth.teamId === requestedTeam);
    if (matches.length === 1) return matches[0];
    if (matches.length === 0) {
      throw new SlackAuthTeamNotFoundError(
        `The Slack CLI is not authorized for team ${requestedTeam}. Run \`slack auth login\` for that workspace, or re-run setup naming one of the authorized teams.`,
        requestedTeam,
        candidatesOf(auths),
        loginPerformed,
      );
    }
    throw new SlackAuthSelectionRequiredError(
      `The Slack CLI reports ${matches.length} authorizations for team ${requestedTeam}; setup needs to be told which one to use.`,
      candidatesOf(matches),
      loginPerformed,
    );
  }

  if (auths.length === 1) return auths[0];
  throw new SlackAuthSelectionRequiredError(
    `The Slack CLI is authorized for ${auths.length} workspaces; setup needs to be told which one somawork should install into.`,
    candidatesOf(auths),
    loginPerformed,
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Ensure the Slack CLI holds an authorization for the workspace somawork is
 * being installed into, running the ordinary ticket/challenge flow if it does
 * not, and report which authorization was selected.
 *
 * ```text
 *   which slack ──┬─ null → SlackCliMissingError (Task 11 installs it)
 *                 └─ path
 *   slack version --no-color --skip-update      bounded token, or `unknown`
 *   slack auth list --no-color --skip-update    strict grammar, raw stdout once
 *   ── zero authorizations ────────────────────────────────────────────────
 *   (no onInstruction)                          → SlackAuthInstructionSinkError
 *                                                 BEFORE any ticket is minted
 *   slack auth login --no-prompt …              → exactly one ticket line
 *   onInstruction(`/slackauthticket …`)           REQUIRED carrier, awaited,
 *                                                 guarded → SinkError on throw
 *   host.copyToClipboard(`/slackauthticket …`)    best-effort, bounded,
 *                                                 cancellable, ticket masked
 *   host.promptSecret('Slack challenge: ')        no echo, never recorded
 *   slack auth login --no-prompt --ticket … --challenge … --no-color --skip-update
 *                                                 provider-mandated argv
 *   slack auth list …                           re-read: exit 0 proves nothing
 *   ── selection ──────────────────────────────────────────────────────────
 *   requestedTeam  → exactly one match, else not-found / selection-required
 *   no requested   → exactly one authorization, else selection-required
 * ```
 *
 * Hard ceilings: at most **one** ticket request and **one** exchange per call,
 * never an automatic retry, never an install, never a browser, never a read of
 * `~/.slack/credentials.json`.
 *
 * @param requestedTeam Slack Team ID (`T…`, or an enterprise `E…`) to select.
 */
export async function ensureSlackCliAuth(
  host: SetupHost,
  requestedTeam?: string,
  options: EnsureSlackCliAuthOptions = {},
): Promise<SlackCliAuthReceipt> {
  const policy = resolvePolicy(options);
  const team = resolveRequestedTeam(requestedTeam);
  throwIfAborted(policy, 'before it started');

  const bin = await host.which(SLACK_BIN);
  if (bin === null) {
    throw new SlackCliMissingError(
      'The Slack CLI (`slack`) is not on PATH. somawork does not install it — install the Slack CLI, open a new shell so PATH picks it up, then re-run setup.',
    );
  }

  const cliVersion = await readVersion(host, bin, policy);

  let auths = await readAuthorizations(host, bin, policy);
  let loginPerformed = false;
  let instructionCopiedToClipboard = false;

  if (auths.length === 0) {
    const onInstruction = policy.onInstruction;
    if (onInstruction === undefined) {
      // Before the request, not after: a ticket nobody can see is a live
      // authorization grant left dangling, and the clipboard alone is not a
      // channel the caller can prove reached the user.
      throw new SlackAuthInstructionSinkError(
        'The Slack CLI has no authorization and setup has no way to show you the `/slackauthticket` command; pass `onInstruction` so the slash command can be displayed, then re-run setup.',
      );
    }

    const ticket = await requestTicket(host, bin, policy);
    const command = `${TICKET_SLASH_COMMAND} ${ticket}`;

    // Required carrier first, best-effort carrier second. The clipboard is a
    // convenience; `onInstruction` is the only channel that provably reached
    // the user, so a pasteboard that hangs (bounded, but still) must not be
    // able to strand a live ticket nobody has seen.
    await deliverInstruction(onInstruction, command);
    instructionCopiedToClipboard = await copyInstruction(host, command, ticket, policy);
    // A clipboard *miss* is modelled; a clipboard *cancellation* is not — it
    // means the user cancelled the run, and continuing to the challenge prompt
    // would ignore that.
    throwIfAborted(policy, 'while copying the slash command to the clipboard');

    const challenge = await readChallenge(host, policy);
    await completeLogin(host, bin, ticket, challenge, policy);
    loginPerformed = true;

    auths = await readAuthorizations(host, bin, policy);
    if (auths.length === 0) {
      // `LoginNoPrompt` returns a nil error when the exchange is not ready, so
      // this is the normal shape of "the modal was never approved".
      throw new SlackAuthNotReadyError(
        'The Slack ticket exchange reported success but the Slack CLI still has no authorization, which means the permissions modal was never approved. Re-run setup to start a fresh authorization — the ticket you used is spent.',
        0,
      );
    }
  }

  const selected = selectAuthorization(auths, team, loginPerformed);

  return {
    teamId: selected.teamId,
    userId: selected.userId,
    domain: selected.domain,
    accessLevel: selected.authorizationLevel,
    hasCustomApiHost: selected.hasCustomApiHost,
    lastUpdated: selected.lastUpdated,
    cliVersion,
    workspaceCount: auths.length,
    loginPerformed,
    instructionCopiedToClipboard,
  };
}
