/**
 * Task 5 — Slack CLI ordinary authorization adapter (ticket/challenge).
 *
 * Every case runs against {@link FakeHost}: no `slack` binary, no workspace, no
 * clipboard, no TTY. The one exception is named — the source-byte scan reads
 * the two Task 5 files off disk.
 *
 * Fixtures reproduce the *verified* Slack CLI surface at `slackapi/slack-cli`
 * `8b4c66e`:
 *
 * - `cmd/auth/list.go:66-112` — leading blank line, then per authorization
 *   `<domain> (Team ID: …)`, `User ID: …`, optional `API Host: …`,
 *   `Last Updated: …` (Go layout `2006-01-02 15:04:05 Z07:00`),
 *   `Authorization Level: …`, blank. No trailing guidance when non-empty.
 * - `cmd/auth/list.go:106-126` — `You are not logged in to any Slack accounts`,
 *   blank, `To login to a Slack account, run …`, blank.
 * - `internal/pkg/auth/login.go:176-197` — explanatory prose section, then one
 *   standalone `/slackauthticket <ticket>` line, printed to **stdout**.
 * - `internal/pkg/auth/login.go:242-271` — `LoginNoPrompt` returns a **nil
 *   error** when the ticket exchange is not ready yet, so a pending challenge
 *   exits 0 having saved nothing. Exit code alone is never proof.
 *
 * The ticket, the challenge, the custom API host and the team domains in these
 * fixtures are fictional and act as **sentinels**: the last describe block
 * proves the ticket and challenge reach exactly one place — the provider-
 * mandated completion argv inside `unsafeRawCalls()` — and that nothing else
 * (receipt, errors, public call log, selection candidates) carries them.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { FakeHost, type RecordedCall } from '../fake-host';
import { CommandSpawnError, SecretPromptError } from '../host';
import { RealHost } from '../real-host';
import {
  ensureSlackCliAuth,
  parseSlackAuthList,
  SLACK_CHALLENGE_PROMPT,
  SlackAuthCancelledError,
  SlackAuthChallengeError,
  SlackAuthCommandError,
  SlackAuthCompletionError,
  SlackAuthContractError,
  SlackAuthError,
  SlackAuthInstructionSinkError,
  SlackAuthNotReadyError,
  SlackAuthOptionsError,
  SlackAuthSelectionRequiredError,
  SlackAuthTeamNotFoundError,
  SlackAuthTicketError,
  SlackCliMissingError,
  SlackCliVersionError,
  TICKET_SLASH_COMMAND,
} from '../slack-auth';
import { assertSecretFree } from '../state';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SLACK_BIN = '/opt/homebrew/bin/slack';

/** Fictional secrets used as leak sentinels. */
const TICKET = 'ISQWLiZT0OtMLO3YWNTJO0SENTINELticket9f3a';
const CHALLENGE = 'SENTINELchallenge4f2a';
const API_HOST_SENTINEL = 'https://sentinel-api-host.example.test';
const RAW_STDOUT_SENTINEL = 'RAW-STDOUT-SENTINEL-5b7c';

const DOMAIN_A = 'zelda-sentinel-alpha';
const DOMAIN_B = 'zelda-sentinel-beta';
const TEAM_A = 'T01SENTINELAA';
const TEAM_B = 'T01SENTINELBB';
const USER_A = 'U01SENTINELAA';
const USER_B = 'U01SENTINELBB';

const SENTINELS = [TICKET, CHALLENGE, API_HOST_SENTINEL, RAW_STDOUT_SENTINEL, DOMAIN_A, DOMAIN_B];

const VERSION_OUTPUT = 'Using slack v3.2.1\n';

interface BlockOptions {
  domain: string;
  teamId: string;
  userId: string;
  apiHost?: string;
  lastUpdated?: string;
  level?: string;
}

/** One authorization block exactly as `printAuthList` emits it. */
function authBlock(options: BlockOptions): string[] {
  const lines = [`${options.domain} (Team ID: ${options.teamId})`, `User ID: ${options.userId}`];
  if (options.apiHost !== undefined) lines.push(`API Host: ${options.apiHost}`);
  lines.push(`Last Updated: ${options.lastUpdated ?? '2026-08-24 11:18:00 +09:00'}`);
  lines.push(`Authorization Level: ${options.level ?? 'Workspace'}`);
  return lines;
}

/** `cmd.Println()` first, then every block followed by its own `cmd.Println()`. */
function renderAuthList(blocks: string[][]): string {
  let out = '\n';
  for (const block of blocks) out += `${block.map((line) => `${line}\n`).join('')}\n`;
  return out;
}

const BLOCK_A = authBlock({ domain: DOMAIN_A, teamId: TEAM_A, userId: USER_A });
const BLOCK_B = authBlock({ domain: DOMAIN_B, teamId: TEAM_B, userId: USER_B, level: 'Enterprise' });

const LIST_ONE = renderAuthList([BLOCK_A]);
const LIST_TWO = renderAuthList([BLOCK_A, BLOCK_B]);

/** `cmd/auth/list.go:106-126` — the exact empty-auth source path. */
const LIST_EMPTY = [
  '',
  'You are not logged in to any Slack accounts',
  '',
  'To login to a Slack account, run `slack login`',
  '',
  '',
].join('\n');

/** `printAuthTicketSubmissionInstructions` — prose section, then the one line. */
function renderTicketOutput(ticketLine: string | null, extraLines: string[] = []): string {
  const prose = [
    '📋 Run the following slash command in any Slack channel or DM',
    '   This will open a modal with user permissions for you to approve',
    '   Once approved, a challenge code will be generated in Slack',
  ];
  const body = [...prose, ...(ticketLine === null ? [] : [ticketLine]), ...extraLines];
  return `\n${body.join('\n')}\n\n`;
}

const TICKET_OUTPUT = renderTicketOutput(`${TICKET_SLASH_COMMAND} ${TICKET}`);
const TICKET_COMMAND = `${TICKET_SLASH_COMMAND} ${TICKET}`;

// -- argv matchers ----------------------------------------------------------

const VERSION_CMD = `${SLACK_BIN} version`;
const LIST_CMD = `${SLACK_BIN} auth list`;
const TICKET_CMD = `${SLACK_BIN} auth login --no-prompt --no-color`;
const COMPLETE_CMD = `${SLACK_BIN} auth login --no-prompt --ticket`;

const VERSION_ARGV = ['version', '--no-color', '--skip-update'];
const LIST_ARGV = ['auth', 'list', '--no-color', '--skip-update'];
const TICKET_ARGV = ['auth', 'login', '--no-prompt', '--no-color', '--skip-update'];
const COMPLETE_ARGV = [
  'auth',
  'login',
  '--no-prompt',
  '--ticket',
  TICKET,
  '--challenge',
  CHALLENGE,
  '--no-color',
  '--skip-update',
];

// -- host builders ----------------------------------------------------------

/** A `FakeHost` whose pasteboard is unavailable, as on a headless machine. */
class NoClipboardHost extends FakeHost {
  override async copyToClipboard(): Promise<void> {
    throw new Error('no pbcopy on this machine');
  }
}

/** The user pressed Ctrl-C at the challenge prompt (`real-host.ts` U+0003). */
class InterruptedPromptHost extends FakeHost {
  override async promptSecret(prompt: string): Promise<string> {
    await super.promptSecret(prompt).catch(() => undefined);
    throw new SecretPromptError('Secret entry cancelled.', 'cancelled');
  }
}

/** Not an interactive terminal — a pipe or a CI runner. */
class NoTtyPromptHost extends FakeHost {
  override async promptSecret(prompt: string): Promise<string> {
    await super.promptSecret(prompt).catch(() => undefined);
    throw new SecretPromptError('Cannot read a secret without a TTY.', 'unavailable');
  }
}

/** A host with `slack` installed and a working `version` probe. */
function installedHost(base: FakeHost = new FakeHost()): FakeHost {
  return base.stubWhich('slack', SLACK_BIN).stubCommand(VERSION_CMD, { stdout: VERSION_OUTPUT });
}

/** Already authorized: one `auth list` answer, forever. */
function authorizedHost(list = LIST_ONE): FakeHost {
  return installedHost().stubCommand(LIST_CMD, { stdout: list });
}

/**
 * The fresh-authorization host: empty list → ticket → completion → final list.
 * `stubCommandOnce` on the first list is what makes "re-read after login" real.
 */
function freshHost(
  options: {
    finalList?: string;
    ticket?: Parameters<FakeHost['stubCommand']>[1];
    completion?: Parameters<FakeHost['stubCommand']>[1];
    challenge?: string;
  } = {},
  base: FakeHost = new FakeHost(),
): FakeHost {
  const host = installedHost(base)
    .stubCommandOnce(LIST_CMD, { stdout: LIST_EMPTY })
    .stubCommand(LIST_CMD, { stdout: options.finalList ?? LIST_ONE })
    .stubCommand(TICKET_CMD, options.ticket ?? { stdout: TICKET_OUTPUT })
    .stubCommand(COMPLETE_CMD, options.completion ?? { stdout: '' });
  host.stubPromptSecret(SLACK_CHALLENGE_PROMPT, options.challenge ?? CHALLENGE);
  return host;
}

const noop = (): void => {};

/** Command lines actually run, in order — the state machine made visible. */
function commandLines(host: FakeHost): string[] {
  return host.calls
    .filter((call): call is Extract<RecordedCall, { kind: 'command' }> => call.kind === 'command')
    .map((call) => [call.command, ...call.args].join(' '));
}

function kinds(host: FakeHost): string[] {
  return host.calls.map((call) => call.kind);
}

/** The shape Task 10 would persist: an actual JSON round trip. */
const persisted = (value: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(value));

async function failure(run: () => Promise<unknown>): Promise<Error> {
  return run().then(
    () => {
      throw new Error('expected a rejection but the call resolved');
    },
    (error: Error) => error,
  );
}

// ---------------------------------------------------------------------------
// parseSlackAuthList — strict, version-pinned grammar
// ---------------------------------------------------------------------------

describe('parseSlackAuthList', () => {
  it('reads the exact empty-auth source path as zero authorizations', () => {
    expect(parseSlackAuthList(LIST_EMPTY)).toEqual([]);
  });

  it('still reads zero authorizations when the login guidance is absent', () => {
    expect(parseSlackAuthList('\nYou are not logged in to any Slack accounts\n\n')).toEqual([]);
  });

  it('rejects unknown output that follows the not-logged-in banner', () => {
    const error = () => parseSlackAuthList(`\nYou are not logged in to any Slack accounts\n\n${RAW_STDOUT_SENTINEL}\n`);
    expect(error).toThrow(SlackAuthContractError);
    expect(error).toThrow(/line 4/);
  });

  it('reduces one workspace to a safe record', () => {
    expect(parseSlackAuthList(LIST_ONE)).toEqual([
      {
        teamId: TEAM_A,
        userId: USER_A,
        domain: DOMAIN_A,
        authorizationLevel: 'Workspace',
        hasCustomApiHost: false,
        lastUpdated: '2026-08-24 11:18:00 +09:00',
      },
    ]);
  });

  it('reads every block of a multi-workspace listing, in order', () => {
    expect(parseSlackAuthList(LIST_TWO).map((a) => a.teamId)).toEqual([TEAM_A, TEAM_B]);
    expect(parseSlackAuthList(LIST_TWO)[1].authorizationLevel).toBe('Enterprise');
  });

  it('reduces an optional API Host to a boolean and keeps the host itself out of the record', () => {
    const list = renderAuthList([
      authBlock({ domain: DOMAIN_A, teamId: TEAM_A, userId: USER_A, apiHost: API_HOST_SENTINEL }),
    ]);
    const [record] = parseSlackAuthList(list);

    expect(record.hasCustomApiHost).toBe(true);
    expect(JSON.stringify(record)).not.toContain(API_HOST_SENTINEL);
  });

  it('accepts a non-ASCII team domain', () => {
    const domain = '한글-워크스페이스';
    const list = renderAuthList([authBlock({ domain, teamId: TEAM_A, userId: USER_A })]);

    expect(parseSlackAuthList(list)[0].domain).toBe(domain);
  });

  it('parses an enterprise E team id and a W user id without coercing them', () => {
    const list = renderAuthList([
      authBlock({ domain: DOMAIN_A, teamId: 'E01SENTINELEE', userId: 'W01SENTINELWW', level: 'Enterprise' }),
    ]);
    const [record] = parseSlackAuthList(list);

    expect(record.teamId).toBe('E01SENTINELEE');
    expect(record.userId).toBe('W01SENTINELWW');
  });

  it('tolerates CRLF line endings and trailing blank lines', () => {
    expect(parseSlackAuthList(`${LIST_TWO.replace(/\n/g, '\r\n')}\r\n\r\n`).map((a) => a.teamId)).toEqual([
      TEAM_A,
      TEAM_B,
    ]);
  });

  it('accepts the Go `Z` rendering of a zero UTC offset', () => {
    const list = renderAuthList([
      authBlock({ domain: DOMAIN_A, teamId: TEAM_A, userId: USER_A, lastUpdated: '2026-08-24 02:18:00 Z' }),
    ]);

    expect(parseSlackAuthList(list)[0].lastUpdated).toBe('2026-08-24 02:18:00 Z');
  });

  it('fails loudly on an unknown extra line inside a block, naming the line number only', () => {
    const list = renderAuthList([[...BLOCK_A, `Weird New Field: ${RAW_STDOUT_SENTINEL}`]]);
    const error = failureOf(() => parseSlackAuthList(list));

    expect(error).toBeInstanceOf(SlackAuthContractError);
    expect(error.message).toMatch(/line 6/);
    expect(error.message).not.toContain(RAW_STDOUT_SENTINEL);
  });

  it('fails loudly on a missing User ID line', () => {
    const list = renderAuthList([BLOCK_A.filter((line) => !line.startsWith('User ID:'))]);

    expect(() => parseSlackAuthList(list)).toThrow(SlackAuthContractError);
  });

  it('fails loudly on out-of-order lines', () => {
    const list = renderAuthList([[BLOCK_A[0], BLOCK_A[2], BLOCK_A[1], BLOCK_A[3]]]);
    const error = failureOf(() => parseSlackAuthList(list));

    expect(error).toBeInstanceOf(SlackAuthContractError);
    expect(error.message).toMatch(/line 3/);
  });

  it('fails loudly on a duplicated line inside a block', () => {
    const list = renderAuthList([[BLOCK_A[0], BLOCK_A[1], BLOCK_A[1], BLOCK_A[2], BLOCK_A[3]]]);

    expect(() => parseSlackAuthList(list)).toThrow(SlackAuthContractError);
  });

  it('fails loudly when the same Team ID appears twice', () => {
    const error = failureOf(() => parseSlackAuthList(renderAuthList([BLOCK_A, BLOCK_A])));

    expect(error).toBeInstanceOf(SlackAuthContractError);
    expect(error.message).toMatch(/line 7/);
    expect(error.message).not.toContain(TEAM_A);
  });

  it('fails loudly on an unrecognisable header line', () => {
    expect(() => parseSlackAuthList(`\n${DOMAIN_A} team ${TEAM_A}\n\n`)).toThrow(SlackAuthContractError);
  });

  it('fails loudly on empty output rather than reporting zero authorizations', () => {
    expect(() => parseSlackAuthList('')).toThrow(SlackAuthContractError);
    expect(() => parseSlackAuthList('\n\n')).toThrow(SlackAuthContractError);
  });

  it('fails loudly on styled output, so `--no-color` is load-bearing rather than cosmetic', () => {
    const esc = String.fromCharCode(27);
    const styled = `\n${esc}[1m${DOMAIN_A} (Team ID: ${TEAM_A})${esc}[0m\nUser ID: ${USER_A}\nLast Updated: 2026-08-24 11:18:00 +09:00\nAuthorization Level: Workspace\n\n`;

    expect(() => parseSlackAuthList(styled)).toThrow(SlackAuthContractError);
  });

  it('never quotes the offending line, which carries the workspace identity', () => {
    const cases = [
      `\n${DOMAIN_A} team ${TEAM_A}\n\n`,
      renderAuthList([[BLOCK_A[0], `User ID: ${RAW_STDOUT_SENTINEL}`, BLOCK_A[2], BLOCK_A[3]]]),
      renderAuthList([[...BLOCK_A, `Unknown Field: ${RAW_STDOUT_SENTINEL}`]]),
    ];

    for (const [index, text] of cases.entries()) {
      const error = failureOf(() => parseSlackAuthList(text));
      for (const sentinel of [...SENTINELS, TEAM_A]) {
        expect(`case ${index}: ${error.message}`).not.toContain(sentinel);
      }
    }
  });
});

function failureOf(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a throw');
}

// ---------------------------------------------------------------------------
// Ticket extraction — driven end to end, because the parser is not exported
//
// `parseSlackAuthTicket` returns a secret and has no production consumer
// outside this module, so it stays private and is exercised through the flow
// that actually uses it. `instructionOf` reads the extracted ticket back out of
// the required carrier, which is where it is supposed to end up anyway.
// ---------------------------------------------------------------------------

/** Run the fresh flow against `stdout` and return what the sink was handed. */
async function instructionOf(stdout: string): Promise<string> {
  const seen: string[] = [];
  await ensureSlackCliAuth(freshHost({ ticket: { stdout } }), undefined, {
    onInstruction: (text) => {
      seen.push(text);
    },
  });
  return seen[0];
}

/** Run the fresh flow against `stdout` and return the rejection. */
function ticketFailure(stdout: string): Promise<Error> {
  return failure(() => ensureSlackCliAuth(freshHost({ ticket: { stdout } }), undefined, { onInstruction: noop }));
}

describe('ensureSlackCliAuth — ticket extraction', () => {
  it('finds the one slash command amid the explanatory prose', async () => {
    expect(await instructionOf(TICKET_OUTPUT)).toBe(TICKET_COMMAND);
  });

  it('does not require the surrounding prose to stay byte-identical', async () => {
    const reworded = `\nA totally new section header\n  with new secondary copy\n${TICKET_COMMAND}\n\n`;

    expect(await instructionOf(reworded)).toBe(TICKET_COMMAND);
  });

  it('does not count prose that merely mentions the command as a second ticket', async () => {
    const chatty = renderTicketOutput(TICKET_COMMAND, ['Paste the /slackauthticket line above into Slack.']);

    expect(await instructionOf(chatty)).toBe(TICKET_COMMAND);
  });

  it('accepts an opaque ticket the CLI never constrained — dots, tildes and all', async () => {
    const opaque = 'eyJhbGciOi.J9~SENTINEL_opaque+ticket/value=';
    const seen: string[] = [];

    await ensureSlackCliAuth(
      freshHost({ ticket: { stdout: renderTicketOutput(`${TICKET_SLASH_COMMAND} ${opaque}`) } }),
      undefined,
      {
        onInstruction: (text) => {
          seen.push(text);
        },
      },
    );

    expect(seen[0]).toBe(`${TICKET_SLASH_COMMAND} ${opaque}`);
  });

  it('tolerates CRLF', async () => {
    expect(await instructionOf(TICKET_OUTPUT.replace(/\n/g, '\r\n'))).toBe(TICKET_COMMAND);
  });

  it('rejects output with no ticket line', async () => {
    expect(await ticketFailure(renderTicketOutput(null))).toBeInstanceOf(SlackAuthTicketError);
  });

  it('rejects output with two ticket lines', async () => {
    const two = renderTicketOutput(TICKET_COMMAND, [`${TICKET_SLASH_COMMAND} SECONDticketvalue0001`]);

    expect(await ticketFailure(two)).toBeInstanceOf(SlackAuthTicketError);
  });

  it('rejects an indented ticket line, which Slack itself cannot execute', async () => {
    expect(await ticketFailure(renderTicketOutput(`   ${TICKET_COMMAND}`))).toBeInstanceOf(SlackAuthTicketError);
  });

  it('rejects a ticket line embedded in prose', async () => {
    expect(await ticketFailure(renderTicketOutput(`Run ${TICKET_COMMAND} in Slack`))).toBeInstanceOf(
      SlackAuthTicketError,
    );
  });

  it('rejects a ticket line with no value', async () => {
    expect(await ticketFailure(renderTicketOutput(TICKET_SLASH_COMMAND))).toBeInstanceOf(SlackAuthTicketError);
  });

  it('rejects a ticket value that could be read as a flag', async () => {
    expect(await ticketFailure(renderTicketOutput(`${TICKET_SLASH_COMMAND} -notaticket0001`))).toBeInstanceOf(
      SlackAuthTicketError,
    );
  });

  it('rejects a ticket value carrying whitespace', async () => {
    expect(await ticketFailure(renderTicketOutput(`${TICKET_SLASH_COMMAND} tick et value`))).toBeInstanceOf(
      SlackAuthTicketError,
    );
  });

  it('never quotes the ticket in its failure message', async () => {
    const two = renderTicketOutput(TICKET_COMMAND, [`${TICKET_SLASH_COMMAND} SECONDticketvalue0001`]);
    const error = await ticketFailure(two);

    expect(error.message).not.toContain(TICKET);
    expect(error.message).not.toContain('SECONDticketvalue0001');
  });
});

// ---------------------------------------------------------------------------
// Preconditions: binary, version, options
// ---------------------------------------------------------------------------

describe('ensureSlackCliAuth — preconditions', () => {
  it('reports a missing Slack CLI as actionable and runs nothing else', async () => {
    const host = new FakeHost().stubWhich('slack', null);

    const error = await failure(() => ensureSlackCliAuth(host));

    expect(error).toBeInstanceOf(SlackCliMissingError);
    expect(error.message).toMatch(/slack/i);
    expect(commandLines(host)).toEqual([]);
  });

  it('runs every Slack command through the resolved absolute path', async () => {
    const host = authorizedHost();

    await ensureSlackCliAuth(host);

    for (const line of commandLines(host)) expect(line.startsWith(`${SLACK_BIN} `)).toBe(true);
  });

  it('probes the version before touching authorizations', async () => {
    const host = authorizedHost();

    const receipt = await ensureSlackCliAuth(host);

    expect(commandLines(host)).toEqual([
      `${SLACK_BIN} ${VERSION_ARGV.join(' ')}`,
      `${SLACK_BIN} ${LIST_ARGV.join(' ')}`,
    ]);
    expect(receipt.cliVersion).toBe('v3.2.1');
  });

  it('fails when the version probe exits non-zero', async () => {
    const host = new FakeHost()
      .stubWhich('slack', SLACK_BIN)
      .stubCommand(VERSION_CMD, { code: 1, stderr: 'bad install' });

    const error = await failure(() => ensureSlackCliAuth(host));

    expect(error).toBeInstanceOf(SlackCliVersionError);
    expect(error.message).toMatch(/bad install/);
  });

  it('fails when the version probe times out', async () => {
    const host = new FakeHost().stubWhich('slack', SLACK_BIN).stubCommand(VERSION_CMD, { delayMs: 10 ** 9 });

    expect(await failure(() => ensureSlackCliAuth(host))).toBeInstanceOf(SlackCliVersionError);
  });

  it('treats an unrecognisable version banner as unknown rather than bricking setup', async () => {
    const host = new FakeHost()
      .stubWhich('slack', SLACK_BIN)
      .stubCommand(VERSION_CMD, { stdout: `a brand new banner ${RAW_STDOUT_SENTINEL}\n` })
      .stubCommand(LIST_CMD, { stdout: LIST_ONE });

    const receipt = await ensureSlackCliAuth(host);

    expect(receipt.cliVersion).toBe('unknown');
    expect(JSON.stringify(receipt)).not.toContain(RAW_STDOUT_SENTINEL);
  });

  it('rejects a malformed requested team before the first host call', async () => {
    const host = authorizedHost();

    const error = await failure(() => ensureSlackCliAuth(host, 'not a team id'));

    expect(error).toBeInstanceOf(SlackAuthOptionsError);
    expect(host.calls).toEqual([]);
  });

  it('rejects a non-positive timeout before the first host call', async () => {
    for (const options of [{ listTimeoutMs: 0 }, { versionTimeoutMs: -1 }, { completionTimeoutMs: 1.5 }]) {
      const host = authorizedHost();

      expect(await failure(() => ensureSlackCliAuth(host, undefined, options))).toBeInstanceOf(SlackAuthOptionsError);
      expect(host.calls).toEqual([]);
    }
  });

  it('rejects a non-function instruction sink before the first host call', async () => {
    const host = authorizedHost();
    const options = { onInstruction: 'nope' } as unknown as { onInstruction: (text: string) => void };

    expect(await failure(() => ensureSlackCliAuth(host, undefined, options))).toBeInstanceOf(SlackAuthOptionsError);
    expect(host.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Already-authorized selection
// ---------------------------------------------------------------------------

describe('ensureSlackCliAuth — existing authorizations', () => {
  it('returns the only authorization when no team was requested', async () => {
    const receipt = await ensureSlackCliAuth(authorizedHost());

    expect(receipt).toEqual({
      teamId: TEAM_A,
      userId: USER_A,
      domain: DOMAIN_A,
      accessLevel: 'Workspace',
      hasCustomApiHost: false,
      lastUpdated: '2026-08-24 11:18:00 +09:00',
      cliVersion: 'v3.2.1',
      workspaceCount: 1,
      loginPerformed: false,
      instructionCopiedToClipboard: false,
    });
  });

  it('never prompts, copies, or opens a browser when an authorization already exists', async () => {
    const host = authorizedHost(LIST_TWO);

    await ensureSlackCliAuth(host, TEAM_B);

    expect(kinds(host)).toEqual(['which', 'command', 'command']);
  });

  it('selects the exact Team ID out of several', async () => {
    const receipt = await ensureSlackCliAuth(authorizedHost(LIST_TWO), TEAM_B);

    expect(receipt.teamId).toBe(TEAM_B);
    expect(receipt.accessLevel).toBe('Enterprise');
    expect(receipt.workspaceCount).toBe(2);
  });

  it('asks Task 10 to choose when several exist and none was requested', async () => {
    const error = (await failure(() =>
      ensureSlackCliAuth(authorizedHost(LIST_TWO)),
    )) as SlackAuthSelectionRequiredError;

    expect(error).toBeInstanceOf(SlackAuthSelectionRequiredError);
    expect(error.candidates).toEqual([
      { teamId: TEAM_A, domain: DOMAIN_A },
      { teamId: TEAM_B, domain: DOMAIN_B },
    ]);
  });

  it('reports a requested team that is not authorized, with safe candidates', async () => {
    const error = (await failure(() =>
      ensureSlackCliAuth(authorizedHost(LIST_TWO), 'T01NOTTHEREXX'),
    )) as SlackAuthTeamNotFoundError;

    expect(error).toBeInstanceOf(SlackAuthTeamNotFoundError);
    expect(error.requestedTeam).toBe('T01NOTTHEREXX');
    expect(error.candidates.map((c) => c.teamId)).toEqual([TEAM_A, TEAM_B]);
  });

  it('fails when `auth list` exits non-zero, even with parseable stdout', async () => {
    const host = installedHost().stubCommand(LIST_CMD, { code: 3, stdout: LIST_ONE, stderr: 'credentials locked' });

    const error = (await failure(() => ensureSlackCliAuth(host))) as SlackAuthCommandError;

    expect(error).toBeInstanceOf(SlackAuthCommandError);
    expect(error.step).toBe('list');
    expect(error.message).toMatch(/credentials locked/);
  });

  it('fails when `auth list` times out', async () => {
    const host = installedHost().stubCommand(LIST_CMD, { delayMs: 10 ** 9 });

    expect(await failure(() => ensureSlackCliAuth(host))).toBeInstanceOf(SlackAuthCommandError);
  });

  it('reports cancellation distinctly so an orchestrator can resume', async () => {
    const controller = new AbortController();
    controller.abort();
    const host = authorizedHost();

    const error = await failure(() => ensureSlackCliAuth(host, undefined, { signal: controller.signal }));

    expect(error).toBeInstanceOf(SlackAuthCancelledError);
  });
});

// ---------------------------------------------------------------------------
// Fresh ticket/challenge flow
// ---------------------------------------------------------------------------

describe('ensureSlackCliAuth — fresh authorization', () => {
  it('refuses to request a ticket when there is no way to show it to the user', async () => {
    const host = installedHost().stubCommand(LIST_CMD, { stdout: LIST_EMPTY });

    const error = await failure(() => ensureSlackCliAuth(host));

    expect(error).toBeInstanceOf(SlackAuthInstructionSinkError);
    expect(commandLines(host)).toEqual([
      `${SLACK_BIN} ${VERSION_ARGV.join(' ')}`,
      `${SLACK_BIN} ${LIST_ARGV.join(' ')}`,
    ]);
  });

  it('drives version → list → ticket → clipboard → instruction → challenge → completion → list', async () => {
    const host = freshHost();
    const seen: Array<{ text: string; promptsBefore: number; copiesBefore: number }> = [];

    const receipt = await ensureSlackCliAuth(host, undefined, {
      onInstruction: (text) => {
        seen.push({
          text,
          promptsBefore: kinds(host).filter((k) => k === 'promptSecret').length,
          copiesBefore: kinds(host).filter((k) => k === 'copyToClipboard').length,
        });
      },
    });

    expect(kinds(host)).toEqual([
      'which',
      'command', // version
      'command', // auth list (empty)
      'command', // auth login --no-prompt
      'copyToClipboard', // …after onInstruction; pinned by `copiesBefore` below
      'promptSecret',
      'command', // auth login --ticket --challenge
      'command', // auth list (re-read)
    ]);
    expect(receipt.loginPerformed).toBe(true);
    expect(receipt.instructionCopiedToClipboard).toBe(true);
    expect(receipt.teamId).toBe(TEAM_A);
    expect(seen).toHaveLength(1);
    expect(seen[0].text).toBe(TICKET_COMMAND);
    expect(seen[0].promptsBefore).toBe(0);
    // The required carrier runs before the best-effort one: a wedged pasteboard
    // must never be able to strand a live ticket the user has not seen.
    expect(seen[0].copiesBefore).toBe(0);
  });

  it('puts the exact slash command on the clipboard', async () => {
    const host = freshHost();

    await ensureSlackCliAuth(host, undefined, { onInstruction: noop });

    const copy = host.unsafeRawCalls().find((call) => call.kind === 'copyToClipboard');
    expect(copy).toBeDefined();
    expect((copy as Extract<RecordedCall, { kind: 'copyToClipboard' }>).text).toBe(TICKET_COMMAND);
  });

  it('still shows the instruction when the clipboard is unavailable', async () => {
    const host = freshHost({}, new NoClipboardHost());
    const seen: string[] = [];

    const receipt = await ensureSlackCliAuth(host, undefined, {
      onInstruction: (text) => {
        seen.push(text);
      },
    });

    expect(seen).toEqual([TICKET_COMMAND]);
    expect(receipt.instructionCopiedToClipboard).toBe(false);
    expect(receipt.loginPerformed).toBe(true);
  });

  it('asks for the challenge with the no-echo secret prompt', async () => {
    const host = freshHost();

    await ensureSlackCliAuth(host, undefined, { onInstruction: noop });

    expect(host.calls.filter((c) => c.kind === 'promptSecret')).toEqual([
      { kind: 'promptSecret', prompt: SLACK_CHALLENGE_PROMPT },
    ]);
  });

  it('rejects an empty or whitespace challenge before spawning the completion', async () => {
    for (const value of ['', '   ', '\t']) {
      const host = freshHost({ challenge: value });

      const error = await failure(() => ensureSlackCliAuth(host, undefined, { onInstruction: noop }));

      expect(error).toBeInstanceOf(SlackAuthChallengeError);
      expect(commandLines(host).filter((line) => line.includes('--challenge'))).toEqual([]);
    }
  });

  it('rejects a challenge that could be read as a flag or carries a newline', async () => {
    for (const value of ['-x', 'good\nbad']) {
      const host = freshHost({ challenge: value });

      expect(await failure(() => ensureSlackCliAuth(host, undefined, { onInstruction: noop }))).toBeInstanceOf(
        SlackAuthChallengeError,
      );
      expect(commandLines(host).filter((line) => line.includes('--challenge'))).toEqual([]);
    }
  });

  it('completes with the exact provider-required argv', async () => {
    const host = freshHost();

    await ensureSlackCliAuth(host, undefined, { onInstruction: noop });

    const completion = host
      .unsafeRawCalls()
      .filter((call): call is Extract<RecordedCall, { kind: 'command' }> => call.kind === 'command')
      .find((call) => call.args.includes('--ticket'));

    expect(completion?.command).toBe(SLACK_BIN);
    expect(completion?.args).toEqual(COMPLETE_ARGV);
  });

  it('fails when the ticket request exits non-zero', async () => {
    const host = freshHost({ ticket: { code: 1, stderr: 'ticket service unavailable' } });

    const error = (await failure(() =>
      ensureSlackCliAuth(host, undefined, { onInstruction: noop }),
    )) as SlackAuthCommandError;

    expect(error).toBeInstanceOf(SlackAuthCommandError);
    expect(error.step).toBe('ticket');
    expect(kinds(host)).not.toContain('promptSecret');
  });

  it('fails when the ticket output is unparseable', async () => {
    const host = freshHost({ ticket: { stdout: renderTicketOutput(null) } });

    expect(await failure(() => ensureSlackCliAuth(host, undefined, { onInstruction: noop }))).toBeInstanceOf(
      SlackAuthTicketError,
    );
  });

  it('fails when the completion exits non-zero, and does not retry', async () => {
    const host = freshHost({ completion: { code: 1, stderr: 'invalid_challenge' } });

    const error = (await failure(() =>
      ensureSlackCliAuth(host, undefined, { onInstruction: noop }),
    )) as SlackAuthCompletionError;

    expect(error).toBeInstanceOf(SlackAuthCompletionError);
    expect(error.message).toMatch(/invalid_challenge/);
    expect(commandLines(host).filter((line) => line.includes('--ticket'))).toHaveLength(1);
    expect(commandLines(host).filter((line) => line === `${SLACK_BIN} ${TICKET_ARGV.join(' ')}`)).toHaveLength(1);
  });

  it('fails when the completion times out', async () => {
    const host = freshHost({ completion: { delayMs: 10 ** 9 } });

    expect(await failure(() => ensureSlackCliAuth(host, undefined, { onInstruction: noop }))).toBeInstanceOf(
      SlackAuthCompletionError,
    );
  });

  it('fails when the completion is aborted', async () => {
    const host = freshHost({ completion: { aborted: true } });

    expect(await failure(() => ensureSlackCliAuth(host, undefined, { onInstruction: noop }))).toBeInstanceOf(
      SlackAuthCancelledError,
    );
  });

  it('never trusts a zero exit: a pending challenge saves nothing and must fail', async () => {
    const host = freshHost({ finalList: LIST_EMPTY });

    const error = await failure(() => ensureSlackCliAuth(host, undefined, { onInstruction: noop }));

    expect(error).toBeInstanceOf(SlackAuthNotReadyError);
    expect(error).toBeInstanceOf(SlackAuthCompletionError);
    expect(error.message).toMatch(/re-run setup/i);
    expect(commandLines(host).filter((line) => line.includes('--ticket'))).toHaveLength(1);
  });

  it('fails when the newly authorized workspace is not the requested one', async () => {
    const host = freshHost({ finalList: LIST_TWO });

    const error = await failure(() => ensureSlackCliAuth(host, 'T01NOTTHEREXX', { onInstruction: noop }));

    expect(error).toBeInstanceOf(SlackAuthTeamNotFoundError);
  });

  it('re-reads the list after login rather than trusting the login output', async () => {
    const host = freshHost({ finalList: LIST_TWO });

    const receipt = await ensureSlackCliAuth(host, TEAM_B, { onInstruction: noop });

    expect(receipt.teamId).toBe(TEAM_B);
    expect(commandLines(host).filter((line) => line === `${SLACK_BIN} ${LIST_ARGV.join(' ')}`)).toHaveLength(2);
  });

  it('does not install anything; a missing binary is Task 11 packaging, not Task 5', async () => {
    const host = freshHost();

    await ensureSlackCliAuth(host, undefined, { onInstruction: noop });

    for (const call of host.calls) {
      if (call.kind !== 'command') continue;
      expect(call.args.join(' ')).not.toMatch(/brew|npm|install/);
    }
  });
});

// ---------------------------------------------------------------------------
// Secret discipline
// ---------------------------------------------------------------------------

describe('ensureSlackCliAuth — the ticket and challenge reach exactly one place', () => {
  it('produces a receipt that survives the setup-state secret gate', async () => {
    const host = freshHost({
      finalList: renderAuthList([
        authBlock({ domain: DOMAIN_A, teamId: TEAM_A, userId: USER_A, apiHost: API_HOST_SENTINEL }),
      ]),
    });

    const receipt = await ensureSlackCliAuth(host, undefined, { onInstruction: noop });

    expect(() => assertSecretFree(receipt)).not.toThrow();
    expect(() => assertSecretFree(persisted(receipt))).not.toThrow();
    for (const sentinel of [TICKET, CHALLENGE, API_HOST_SENTINEL, RAW_STDOUT_SENTINEL]) {
      expect(JSON.stringify(receipt)).not.toContain(sentinel);
    }
  });

  it('names the authorization level with a key the state gate accepts', async () => {
    const receipt = await ensureSlackCliAuth(authorizedHost());

    // `authorizationLevel` is the parser's domain name and would be rejected as
    // a credential field, so the persistable receipt renames it.
    expect(Object.keys(receipt)).toContain('accessLevel');
    expect(() => assertSecretFree({ authorizationLevel: 'Workspace' })).toThrow();
    expect(() => assertSecretFree({ accessLevel: 'Workspace' })).not.toThrow();
  });

  it('keeps the ticket and challenge out of every serialized failure', async () => {
    const cases: Array<() => Promise<unknown>> = [
      () => ensureSlackCliAuth(new FakeHost().stubWhich('slack', null)),
      () =>
        ensureSlackCliAuth(
          new FakeHost().stubWhich('slack', SLACK_BIN).stubCommand(VERSION_CMD, { code: 1, stderr: 'boom' }),
        ),
      () => ensureSlackCliAuth(installedHost().stubCommand(LIST_CMD, { code: 2, stderr: RAW_STDOUT_SENTINEL })),
      () => ensureSlackCliAuth(installedHost().stubCommand(LIST_CMD, { stdout: `${RAW_STDOUT_SENTINEL}\n` })),
      () => ensureSlackCliAuth(authorizedHost(LIST_TWO)),
      () => ensureSlackCliAuth(authorizedHost(LIST_TWO), 'T01NOTTHEREXX'),
      () => ensureSlackCliAuth(installedHost().stubCommand(LIST_CMD, { stdout: LIST_EMPTY })),
      () =>
        ensureSlackCliAuth(freshHost({ ticket: { stdout: renderTicketOutput(null) } }), undefined, {
          onInstruction: noop,
        }),
      () => ensureSlackCliAuth(freshHost({ challenge: '  ' }), undefined, { onInstruction: noop }),
      () =>
        ensureSlackCliAuth(freshHost({ completion: { code: 1, stderr: `denied ${RAW_STDOUT_SENTINEL}` } }), undefined, {
          onInstruction: noop,
        }),
      () => ensureSlackCliAuth(freshHost({ finalList: LIST_EMPTY }), undefined, { onInstruction: noop }),
    ];

    for (const [index, run] of cases.entries()) {
      const error = await failure(run);
      const shape = persisted(error);

      expect(() => assertSecretFree(shape), `case ${index}`).not.toThrow();
      for (const sentinel of [TICKET, CHALLENGE, RAW_STDOUT_SENTINEL, API_HOST_SENTINEL]) {
        expect(`case ${index}: ${JSON.stringify(shape)}`).not.toContain(sentinel);
      }
      // The human-facing message may end with the CLI's own redacted
      // diagnostic; it may never carry an ephemeral secret.
      for (const sentinel of [TICKET, CHALLENGE, API_HOST_SENTINEL]) {
        expect(`case ${index}: ${error.message}`).not.toContain(sentinel);
      }
    }
  });

  it('leaves neither value in the public call log', async () => {
    const host = freshHost();

    await ensureSlackCliAuth(host, undefined, { onInstruction: noop });

    const publicCalls = JSON.stringify(host.calls);
    expect(publicCalls).not.toContain(TICKET);
    expect(publicCalls).not.toContain(CHALLENGE);
  });

  it('carries the raw values only in the two carriers the provider flow mandates', async () => {
    const host = freshHost();

    await ensureSlackCliAuth(host, undefined, { onInstruction: noop });

    const rawCalls = host.unsafeRawCalls();
    const withTicket = rawCalls.filter((call) => JSON.stringify(call).includes(TICKET));
    const withChallenge = rawCalls.filter((call) => JSON.stringify(call).includes(CHALLENGE));

    // The challenge has exactly one carrier: the completion argv.
    expect(withChallenge).toHaveLength(1);
    const completion = withChallenge[0] as Extract<RecordedCall, { kind: 'command' }>;
    expect(completion.kind).toBe('command');
    expect(completion.args).toEqual(COMPLETE_ARGV);

    // The ticket has two, both mandated: the pasteboard the user copies from,
    // and the same completion argv. Nothing else, and never in the public view.
    expect(withTicket.map((call) => call.kind)).toEqual(['copyToClipboard', 'command']);
    expect(withTicket[1]).toBe(completion);
  });

  it('never places a secret in the environment or in a spawned child', async () => {
    const host = freshHost();

    await ensureSlackCliAuth(host, undefined, { onInstruction: noop });

    for (const call of host.unsafeRawCalls()) {
      if (call.kind !== 'command') continue;
      expect(JSON.stringify(call.env)).not.toContain(TICKET);
      expect(JSON.stringify(call.env)).not.toContain(CHALLENGE);
    }
    expect(kinds(host)).not.toContain('spawn');
    expect(kinds(host)).not.toContain('openUrl');
  });

  it('offers selection candidates that carry only a team id and a domain', async () => {
    const error = (await failure(() =>
      ensureSlackCliAuth(authorizedHost(LIST_TWO)),
    )) as SlackAuthSelectionRequiredError;

    for (const candidate of error.candidates) expect(Object.keys(candidate).sort()).toEqual(['domain', 'teamId']);
    expect(() => assertSecretFree(persisted(error))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Fix round 1 — regressions for the review's three Important findings
// ---------------------------------------------------------------------------

describe('ensureSlackCliAuth — fix round 1 regressions', () => {
  // -- I1: a killed `auth list` has usually already flushed part of the listing
  const PARTIAL_LISTING = renderAuthList([
    authBlock({ domain: DOMAIN_A, teamId: TEAM_A, userId: USER_A, apiHost: API_HOST_SENTINEL }),
  ]);

  it('never quotes a partially flushed listing when `auth list` times out', async () => {
    const host = installedHost().stubCommand(LIST_CMD, { delayMs: 10 ** 9, stdout: PARTIAL_LISTING });

    const error = await failure(() => ensureSlackCliAuth(host));

    expect(error).toBeInstanceOf(SlackAuthCommandError);
    // Redaction does not mask a domain, a team id, a user id, or an API host —
    // none of them match a vendor token pattern — so the only defence is not
    // reading stdout at all.
    for (const identity of [DOMAIN_A, TEAM_A, USER_A, API_HOST_SENTINEL]) {
      expect(error.message).not.toContain(identity);
      expect(JSON.stringify(persisted(error))).not.toContain(identity);
    }
  });

  it('still surfaces the CLI diagnostic from stderr on a list timeout', async () => {
    const host = installedHost().stubCommand(LIST_CMD, {
      delayMs: 10 ** 9,
      stdout: PARTIAL_LISTING,
      stderr: 'token refresh is hanging',
    });

    expect((await failure(() => ensureSlackCliAuth(host))).message).toMatch(/token refresh is hanging/);
  });

  // -- I2: the clipboard is bounded, cancellable, and second in line
  it('bounds the clipboard write and hands it a cancellation signal', async () => {
    const host = freshHost();
    const controller = new AbortController();

    await ensureSlackCliAuth(host, undefined, { onInstruction: noop, signal: controller.signal });

    const copy = host.calls.find((call) => call.kind === 'copyToClipboard');
    expect(copy).toEqual({ kind: 'copyToClipboard', text: expect.any(String), timeoutMs: 10_000, cancellable: true });
  });

  it('honours a caller-supplied clipboard bound', async () => {
    const host = freshHost();

    await ensureSlackCliAuth(host, undefined, { onInstruction: noop, clipboardTimeoutMs: 250 });

    const copy = host.calls.find((call) => call.kind === 'copyToClipboard');
    expect((copy as Extract<RecordedCall, { kind: 'copyToClipboard' }>).timeoutMs).toBe(250);
  });

  it('rejects a non-positive clipboard bound before the first host call', async () => {
    const host = freshHost();

    const error = await failure(() =>
      ensureSlackCliAuth(host, undefined, { onInstruction: noop, clipboardTimeoutMs: 0 }),
    );

    expect(error).toBeInstanceOf(SlackAuthOptionsError);
    expect(host.calls).toEqual([]);
  });

  it('shows the instruction even when the pasteboard never answers', async () => {
    const host = freshHost({}, new NoClipboardHost());
    const seen: string[] = [];

    const receipt = await ensureSlackCliAuth(host, undefined, {
      onInstruction: (text) => {
        seen.push(text);
      },
    });

    expect(seen).toEqual([TICKET_COMMAND]);
    expect(receipt.instructionCopiedToClipboard).toBe(false);
    expect(kinds(host)).toContain('promptSecret');
  });

  it('stops the whole flow when the run is cancelled during the clipboard write', async () => {
    const controller = new AbortController();
    const host = freshHost();

    const error = await failure(() =>
      ensureSlackCliAuth(host, undefined, {
        signal: controller.signal,
        // The user hits Ctrl-C while reading the instruction; the pasteboard
        // write is the next thing that runs.
        onInstruction: () => {
          controller.abort();
        },
      }),
    );

    expect(error).toBeInstanceOf(SlackAuthCancelledError);
    // Reported from the clipboard stage, not swept up by the next guard: a
    // resume path should be able to say where the run stopped.
    expect(error.message).toMatch(/clipboard/i);
    // Cancelled means cancelled: no challenge was asked for, nothing exchanged.
    expect(kinds(host)).not.toContain('promptSecret');
    expect(commandLines(host).filter((line) => line.includes('--ticket'))).toEqual([]);
  });

  it('bounds and cancels a real pasteboard write, not just the fake one', async () => {
    // The only real process in this file. `FakeHost` can prove the adapter
    // *passes* the options; only a real child proves `RealHost` acts on them —
    // `command` arms its kill timer solely when `timeoutMs` is set.
    const bounded = new RealHost({ clipboardCommand: '/bin/sleep', clipboardArgs: ['5'] });
    const startedAt = Date.now();

    await expect(bounded.copyToClipboard('x', { timeoutMs: 150 })).rejects.toBeInstanceOf(CommandSpawnError);
    expect(Date.now() - startedAt).toBeLessThan(3000);

    const cancellable = new RealHost({ clipboardCommand: '/bin/sleep', clipboardArgs: ['5'] });
    const controller = new AbortController();
    const pending = cancellable.copyToClipboard('x', { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(CommandSpawnError);
  });

  // -- I3: the one place caller code runs inside the flow
  it('converts a throwing instruction sink into a typed error that never leaks the ticket', async () => {
    const host = freshHost();

    const error = await failure(() =>
      ensureSlackCliAuth(host, undefined, {
        onInstruction: (text) => {
          // The ordinary renderer shape: it quotes the line it could not write.
          throw new Error(`EPIPE writing "${text}"`);
        },
      }),
    );

    expect(error).toBeInstanceOf(SlackAuthInstructionSinkError);
    expect(error).toBeInstanceOf(SlackAuthError);
    expect(error.message).not.toContain(TICKET);
    expect(JSON.stringify(persisted(error))).not.toContain(TICKET);
    // Neither the sink's own message nor anything derived from it survives.
    expect(error.message).not.toContain('EPIPE');
  });

  it('converts a rejecting async instruction sink the same way', async () => {
    const host = freshHost();

    const error = await failure(() =>
      ensureSlackCliAuth(host, undefined, {
        onInstruction: async (text) => {
          throw new TypeError(`stream closed: ${text}`);
        },
      }),
    );

    expect(error).toBeInstanceOf(SlackAuthInstructionSinkError);
    expect(error.message).toContain('TypeError');
    expect(error.message).not.toContain(TICKET);
  });

  it('awaits an async sink before touching the clipboard or the prompt', async () => {
    const host = freshHost();
    const order: string[] = [];

    await ensureSlackCliAuth(host, undefined, {
      onInstruction: async () => {
        await Promise.resolve();
        order.push(`sink after ${kinds(host).filter((k) => k === 'copyToClipboard').length} copies`);
      },
    });

    expect(order).toEqual(['sink after 0 copies']);
  });

  it('does nothing further once the sink has failed', async () => {
    const host = freshHost();

    await failure(() =>
      ensureSlackCliAuth(host, undefined, {
        onInstruction: () => {
          throw new Error('sink is gone');
        },
      }),
    );

    expect(kinds(host)).not.toContain('copyToClipboard');
    expect(kinds(host)).not.toContain('promptSecret');
    expect(commandLines(host).filter((line) => line.includes('--ticket'))).toEqual([]);
    // Exactly one ticket was minted and it is spent; a re-run starts fresh.
    expect(commandLines(host).filter((line) => line === `${SLACK_BIN} ${TICKET_ARGV.join(' ')}`)).toHaveLength(1);
  });

  it('leaves the ticket out of the public call log even when the sink fails', async () => {
    const host = freshHost();

    await failure(() =>
      ensureSlackCliAuth(host, undefined, {
        onInstruction: (text) => {
          throw new Error(text);
        },
      }),
    );

    expect(JSON.stringify(host.calls)).not.toContain(TICKET);
    // …and no raw carrier was created either: the sink argument was the only
    // place the value went.
    expect(host.unsafeRawCalls().filter((call) => JSON.stringify(call).includes(TICKET))).toEqual([]);
  });

  // -- M1: an interrupt is walking away, not bad input
  it('classifies a keyboard interrupt at the challenge prompt as cancellation', async () => {
    const host = freshHost({}, new InterruptedPromptHost());

    const error = await failure(() => ensureSlackCliAuth(host, undefined, { onInstruction: noop }));

    expect(error).toBeInstanceOf(SlackAuthCancelledError);
    expect(error).not.toBeInstanceOf(SlackAuthChallengeError);
    expect(commandLines(host).filter((line) => line.includes('--ticket'))).toEqual([]);
  });

  it('still classifies a missing TTY as a challenge problem, not a cancellation', async () => {
    const host = freshHost({}, new NoTtyPromptHost());

    const error = await failure(() => ensureSlackCliAuth(host, undefined, { onInstruction: noop }));

    expect(error).toBeInstanceOf(SlackAuthChallengeError);
    expect(error).not.toBeInstanceOf(SlackAuthCancelledError);
  });

  // -- M5: case is not malformation
  it('accepts a lower-case requested team id', async () => {
    const receipt = await ensureSlackCliAuth(authorizedHost(LIST_TWO), TEAM_B.toLowerCase());

    expect(receipt.teamId).toBe(TEAM_B);
  });

  it('still rejects a requested team that is not a Team ID at all', async () => {
    expect(await failure(() => ensureSlackCliAuth(authorizedHost(), 'acme.slack.com'))).toBeInstanceOf(
      SlackAuthOptionsError,
    );
  });

  // -- M7(a): a post-login ambiguity must not lose the fact that login happened
  it('reports a post-login selection ambiguity as having already authorized', async () => {
    const host = freshHost({ finalList: LIST_TWO });

    const error = (await failure(() =>
      ensureSlackCliAuth(host, undefined, { onInstruction: noop }),
    )) as SlackAuthSelectionRequiredError;

    expect(error).toBeInstanceOf(SlackAuthSelectionRequiredError);
    expect(error.loginPerformed).toBe(true);
    expect(persisted(error).loginPerformed).toBe(true);
    expect(() => assertSecretFree(persisted(error))).not.toThrow();
  });

  it('reports a pre-login selection ambiguity as not having authorized', async () => {
    const error = (await failure(() =>
      ensureSlackCliAuth(authorizedHost(LIST_TWO)),
    )) as SlackAuthSelectionRequiredError;

    expect(error.loginPerformed).toBe(false);
  });

  it('carries the same flag on a post-login team-not-found', async () => {
    const host = freshHost({ finalList: LIST_TWO });

    const error = (await failure(() =>
      ensureSlackCliAuth(host, 'T01NOTTHEREXX', { onInstruction: noop }),
    )) as SlackAuthTeamNotFoundError;

    expect(error.loginPerformed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Source hygiene
// ---------------------------------------------------------------------------

describe('Task 5 source bytes', () => {
  it('contains no NUL byte, so every grep-based security check is honest', () => {
    const files = [path.join(__dirname, '..', 'slack-auth.ts'), path.join(__dirname, 'slack-auth.test.ts')];

    for (const file of files) {
      expect(fs.existsSync(file), file).toBe(true);
      const bytes = fs.readFileSync(file);
      expect(bytes.length, file).toBeGreaterThan(1000);
      expect(bytes.indexOf(0), file).toBe(-1);
    }
  });
});
