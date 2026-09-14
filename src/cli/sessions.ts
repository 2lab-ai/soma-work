/**
 * `somawork sessions list|show` — the archived-session query surface.
 *
 * This is the single owner of the session-archive parser, filters and renderers
 * that used to live in `scripts/soma-cli.ts`. The logic **moved** here rather
 * than being reimplemented: the same table, the same JSON, the same field order,
 * the same "not found" wording, so an operator's existing muscle memory and any
 * script parsing the output keep working. `scripts/soma-cli.ts` is now a thin
 * compatibility entry that calls straight into these functions.
 *
 * ## Where the data directory comes from
 *
 * The old module resolved it at import time from `SOMA_CONFIG_DIR/data`, and
 * otherwise from `process.cwd()` plus **the current git branch**, via a
 * `execSync('git branch --show-current')` subprocess. That is wrong three times
 * over for a packaged controller: it contradicts Task 9's canonical
 * `SOMA_DATA_DIR`, it makes the answer depend on which directory the operator
 * happened to be standing in, and it shells out.
 *
 * {@link resolveSessionsDataDir} replaces all of it with exactly two sources —
 * the canonical `SOMA_DATA_DIR` override, then the selected profile's
 * `ProfilePaths.dataDir`. No cwd, no branch, no subprocess. Every function below
 * takes its directories as arguments and reads no ambient state at all.
 */

import { resolveDataDirOverride } from '@soma/common/soma-paths';
import * as fs from 'fs';
import * as path from 'path';
import { type ProfileName, profilePaths } from './profile';

// ---------------------------------------------------------------------------
// Types (subset of ArchivedSession / ConversationRecord)
// ---------------------------------------------------------------------------

export interface ArchivedSession {
  archivedAt: number;
  archiveReason: string;
  sessionKey: string;
  sessionId?: string;
  conversationId?: string;
  ownerId: string;
  ownerName?: string;
  channelId: string;
  threadTs?: string;
  title?: string;
  model?: string;
  workflow?: string;
  lastActivity: string;
  links?: { issue?: { url: string; label?: string }; pr?: { url: string; label?: string; status?: string } };
  linkHistory?: { issues: unknown[]; prs: unknown[]; docs: unknown[] };
  instructions?: Array<{ id: string; text: string; addedAt: number; source?: string }>;
  mergeStats?: { totalLinesAdded: number; totalLinesDeleted: number; mergedPRs: unknown[] };
  usage?: { totalInputTokens: number; totalOutputTokens: number; totalCostUsd: number };
  finalState?: string;
  finalActivityState?: string;
}

export interface ConversationTurn {
  id: string;
  role: 'user' | 'assistant';
  timestamp: number;
  userName?: string;
  rawContent: string;
  summaryTitle?: string;
  summaryBody?: string;
}

export interface ConversationRecord {
  id: string;
  title?: string;
  turns: ConversationTurn[];
}

// ---------------------------------------------------------------------------
// Directory resolution
// ---------------------------------------------------------------------------

export const ARCHIVES_DIRNAME = 'archives';
export const CONVERSATIONS_DIRNAME = 'conversations';

/**
 * Resolve the data root sessions are read from.
 *
 * Exactly two sources, in order:
 * 1. `SOMA_DATA_DIR` — Task 9's canonical override, shared with the service
 *    environment and `@soma/common/env-paths`, so a CLI query and the running
 *    daemon can never disagree about where archives live.
 * 2. The selected profile's `ProfilePaths.dataDir`.
 *
 * `env` and `home` are parameters rather than reads of `process`, so a test
 * pins the answer without mutating the runner's environment.
 */
export function resolveSessionsDataDir(input: { env: NodeJS.ProcessEnv; home: string; profile: ProfileName }): string {
  return resolveDataDirOverride(input.env) ?? profilePaths(input.home, input.profile).dataDir;
}

/**
 * The data root when something already pins it, or `null` when it does not.
 *
 * "Pinned" means resolvable **without runtime discovery**: the canonical
 * `SOMA_DATA_DIR` override, or an explicitly named profile. Splitting this out
 * of {@link resolveSessionsDataDir} is what lets `somawork sessions list` work
 * on a machine with no Homebrew runtime — previously the route resolved a
 * profile first, so a pinned `SOMA_DATA_DIR` died with "No somawork runtime is
 * installed" and the documented override was unreachable.
 *
 * The override outranks an explicit profile, matching {@link resolveSessionsDataDir}.
 */
export function resolvePinnedSessionsDataDir(input: {
  env: NodeJS.ProcessEnv;
  home: string;
  profile?: ProfileName;
}): string | null {
  const override = resolveDataDirOverride(input.env);
  if (override !== null) return override;
  if (input.profile !== undefined) return profilePaths(input.home, input.profile).dataDir;
  return null;
}

/** The two archive roots under one data directory. */
export function sessionDirs(dataDir: string): { archivesDir: string; conversationsDir: string } {
  return {
    archivesDir: path.join(dataDir, ARCHIVES_DIRNAME),
    conversationsDir: path.join(dataDir, CONVERSATIONS_DIRNAME),
  };
}

// ---------------------------------------------------------------------------
// Flag grammar
// ---------------------------------------------------------------------------

/** Whether a flag stands alone or consumes the next token. */
export type SessionsFlagKind = 'boolean' | 'value';

/** Rows returned when `--limit` is omitted. Historical value; do not change lightly. */
export const SESSIONS_DEFAULT_LIMIT = 50;

/**
 * Largest `--limit` this command will honour.
 *
 * A bound rather than `Number.MAX_SAFE_INTEGER` because the list is rendered by
 * loading every archive into memory first: an operator who types an extra digit
 * should get a refusal, not a machine that starts reading a directory it will
 * never finish. Ten thousand is far above any real archive and far below
 * anything that hurts.
 */
export const SESSIONS_MAX_LIMIT = 10_000;

/**
 * A session command was given an argument it cannot act on.
 *
 * Carries a fixed, caller-written `detail`; the two entry points render it with
 * their own program name so `somawork` and `soma-cli` report identically-shaped
 * errors under their own prefixes.
 */
export class SessionsArgumentError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'SessionsArgumentError';
  }
}

/**
 * The flags {@link listSessions} reads, declared once.
 *
 * `args.ts` validates the `sessions list` tail against this table so a mistyped
 * `--limt` is rejected instead of silently ignored. Keeping the table next to
 * the parser that consumes it is what stops the two from drifting; a test in
 * `__tests__/sessions.test.ts` pins the exact key set.
 */
export const SESSIONS_LIST_FLAGS: Readonly<Record<string, SessionsFlagKind>> = {
  '--user': 'value',
  '--model': 'value',
  '--since': 'value',
  '--until': 'value',
  '--limit': 'value',
  '--json': 'boolean',
};

/** The flags {@link showSession} reads. See {@link SESSIONS_LIST_FLAGS}. */
export const SESSIONS_SHOW_FLAGS: Readonly<Record<string, SessionsFlagKind>> = {
  '--conversation': 'boolean',
  '--json': 'boolean',
};

// ---------------------------------------------------------------------------
// Injected IO
// ---------------------------------------------------------------------------

/**
 * Everything the two commands touch outside their arguments.
 *
 * `archivesDir` / `conversationsDir` are **required**: the whole point of the
 * move is that no code path in this module can invent a directory.
 */
export interface SessionsContextOptions {
  archivesDir: string;
  conversationsDir: string;
  /**
   * Program name used in the usage line.
   *
   * Exists so `scripts/soma-cli.ts` keeps printing its historical
   * `Usage: soma-cli sessions show …` while sharing this exact implementation —
   * output preservation without a second copy of the handler.
   */
  programName?: string;
  write?: (line: string) => void;
  writeErr?: (line: string) => void;
  exit?: (code: number) => never;
}

interface SessionsContext {
  archivesDir: string;
  conversationsDir: string;
  programName: string;
  write: (line: string) => void;
  writeErr: (line: string) => void;
  exit: (code: number) => never;
}

function context(opts: SessionsContextOptions): SessionsContext {
  return {
    archivesDir: opts.archivesDir,
    conversationsDir: opts.conversationsDir,
    programName: opts.programName ?? 'somawork',
    write: opts.write ?? ((line: string) => console.log(line)),
    writeErr: opts.writeErr ?? ((line: string) => console.error(line)),
    exit: opts.exit ?? ((code: number) => process.exit(code)),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadAllArchives(archivesDir: string): ArchivedSession[] {
  if (!fs.existsSync(archivesDir)) return [];
  const files = fs.readdirSync(archivesDir).filter((f) => f.endsWith('.json'));
  const archives: ArchivedSession[] = [];
  for (const file of files) {
    try {
      archives.push(JSON.parse(fs.readFileSync(path.join(archivesDir, file), 'utf-8')));
    } catch {
      // skip corrupt files
    }
  }
  return archives.sort((a, b) => b.archivedAt - a.archivedAt);
}

function loadConversation(conversationsDir: string, conversationId: string): ConversationRecord | null {
  const safeId = conversationId.replace(/[^a-zA-Z0-9_-]/g, '');
  const filePath = path.join(conversationsDir, `${safeId}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function formatDate(unixMs: number): string {
  return new Date(unixMs).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen - 3)}...`;
}

function padRight(s: string, len: number): string {
  return s.length >= len ? s.slice(0, len) : s + ' '.repeat(len - s.length);
}

// ---------------------------------------------------------------------------
// sessions list
// ---------------------------------------------------------------------------

interface ListFilters {
  user?: string;
  model?: string;
  since?: number;
  until?: number;
  limit: number;
  json: boolean;
}

/**
 * Strictly base-10, no sign, no exponent, no radix prefix, no surrounding space.
 *
 * `parseInt` would accept every one of those and quietly discard the tail —
 * `parseInt('1e5', 10)` is `1`, `parseInt('0x10', 10)` is `0`, and
 * `parseInt('abc', 10) || 50` turned a typo into the default.
 */
const LIMIT_RE = /^[0-9]+$/;

/**
 * Validate `--limit`, refusing rather than coercing.
 *
 * The old expression was `parseInt(value, 10) || 50`, which treated `0`, a
 * negative, and any unparseable string as "not supplied" — so
 * `--limit 0` silently listed fifty sessions. An operator who asked for a
 * specific number and got a different one has no way to notice.
 */
function parseLimit(raw: string | undefined): number {
  if (raw === undefined || !LIMIT_RE.test(raw)) {
    throw new SessionsArgumentError(
      `--limit must be a whole number between 1 and ${SESSIONS_MAX_LIMIT}; received "${String(raw ?? '')}".`,
    );
  }
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SESSIONS_MAX_LIMIT) {
    throw new SessionsArgumentError(
      `--limit must be a whole number between 1 and ${SESSIONS_MAX_LIMIT}; received "${raw}".`,
    );
  }
  return limit;
}

function parseListArgs(args: string[]): ListFilters {
  const filters: ListFilters = { limit: SESSIONS_DEFAULT_LIMIT, json: false };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--user':
        filters.user = args[++i];
        break;
      case '--model':
        filters.model = args[++i];
        break;
      case '--since':
        filters.since = new Date(args[++i]).getTime();
        break;
      case '--until':
        filters.until = new Date(args[++i]).getTime();
        break;
      case '--limit':
        filters.limit = parseLimit(args[++i]);
        break;
      case '--json':
        filters.json = true;
        break;
    }
  }
  return filters;
}

function applyListFilters(archives: ArchivedSession[], filters: ListFilters): ArchivedSession[] {
  let result = archives;
  if (filters.user) result = result.filter((a) => a.ownerId === filters.user || a.ownerName === filters.user);
  if (filters.model) result = result.filter((a) => a.model === filters.model);
  if (filters.since) result = result.filter((a) => a.archivedAt >= (filters.since as number));
  if (filters.until) result = result.filter((a) => a.archivedAt <= (filters.until as number));
  return result.slice(0, filters.limit);
}

/** `somawork sessions list` — historical table/JSON output, unchanged. */
export function listSessions(args: string[], opts: SessionsContextOptions): void {
  const ctx = context(opts);

  let filters: ListFilters;
  try {
    filters = parseListArgs(args);
  } catch (error) {
    if (error instanceof SessionsArgumentError) {
      // Prefixed with the caller's own program name so `somawork` and
      // `soma-cli` are self-identifying and agree on the rule itself.
      ctx.writeErr(`${ctx.programName}: ${error.detail}`);
      ctx.exit(1);
      return;
    }
    throw error;
  }

  const archives = applyListFilters(loadAllArchives(ctx.archivesDir), filters);

  if (archives.length === 0) {
    ctx.write('No sessions match the filter.');
    return;
  }

  if (filters.json) {
    ctx.write(JSON.stringify(archives, null, 2));
    return;
  }

  ctx.write(
    `${padRight('SessionKey', 30)} ${padRight('Owner', 12)} ${padRight('Model', 20)} ${padRight('Workflow', 15)} ${padRight('Archived At', 22)} ${padRight('Reason', 14)}`,
  );
  ctx.write('-'.repeat(115));

  for (const a of archives) {
    ctx.write(
      `${padRight(truncate(a.sessionKey, 28), 30)} ${padRight(truncate(a.ownerName || a.ownerId, 10), 12)} ${padRight(truncate(a.model || 'unknown', 18), 20)} ${padRight(a.workflow || 'default', 15)} ${padRight(formatDate(a.archivedAt), 22)} ${padRight(a.archiveReason, 14)}`,
    );
  }

  ctx.write(`\nTotal: ${archives.length} session(s)`);
}

// ---------------------------------------------------------------------------
// sessions show
// ---------------------------------------------------------------------------

interface ShowSessionArgs {
  /** `undefined` when the invocation named no session key. */
  sessionKey: string | undefined;
  showConversation: boolean;
  jsonOutput: boolean;
}

/**
 * The session key is the first token, and a flag is never a session key.
 *
 * `args[0]` alone was the historical rule, so `sessions show --json` reported
 * `Session not found: --json` — a confusing answer to an invocation that simply
 * omitted the key. No archived session key can begin with `-` (they are Slack
 * channel/thread identifiers), so a leading flag means "no key was given" and
 * the caller gets the usage line instead.
 *
 * The controller's parser already normalizes an out-of-order key to the front,
 * so this rule and that ordering agree: whatever the operator typed,
 * `args[0]` is the key when there is one.
 */
function parseShowArgs(args: string[]): ShowSessionArgs {
  const first = args[0];
  return {
    sessionKey: first === undefined || first.startsWith('-') ? undefined : first,
    showConversation: args.includes('--conversation'),
    jsonOutput: args.includes('--json'),
  };
}

type LoadArchiveResult = { ok: true; archive: ArchivedSession } | { ok: false; error: string };

function loadArchiveBySessionKey(archivesDir: string, sessionKey: string): LoadArchiveResult {
  if (!fs.existsSync(archivesDir)) {
    return { ok: false, error: `Session not found: ${sessionKey}` };
  }
  const sanitizedKey = sessionKey.replace(/[^a-zA-Z0-9._-]/g, '-');
  const prefix = `${sanitizedKey}_`;
  const matchingFiles = fs
    .readdirSync(archivesDir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
    .sort()
    .reverse();
  if (matchingFiles.length === 0) {
    return { ok: false, error: `Session not found: ${sessionKey}` };
  }
  try {
    return { ok: true, archive: JSON.parse(fs.readFileSync(path.join(archivesDir, matchingFiles[0]), 'utf-8')) };
  } catch {
    return { ok: false, error: `Failed to parse archive: ${sessionKey}` };
  }
}

function printSessionHeader(archived: ArchivedSession, write: (line: string) => void): void {
  write(`Session: ${archived.sessionKey}`);
  write(`Owner:   ${archived.ownerName || 'unknown'} (${archived.ownerId})`);
  write(`Model:   ${archived.model || 'unknown'}`);
  write(`Title:   ${archived.title || 'Untitled'}`);
  write(`Workflow: ${archived.workflow || 'default'}`);
  write(`Archived: ${formatDate(archived.archivedAt)} (${archived.archiveReason})`);
  write(`Last Activity: ${archived.lastActivity}`);
  write(`Final State: ${archived.finalState || 'unknown'} / ${archived.finalActivityState || 'unknown'}`);
}

function printSessionExtras(archived: ArchivedSession, write: (line: string) => void): void {
  if (archived.links?.issue) {
    write(`\nIssue: ${archived.links.issue.label || ''} — ${archived.links.issue.url}`);
  }
  if (archived.links?.pr) {
    write(`PR: ${archived.links.pr.label || ''} (${archived.links.pr.status || 'unknown'}) — ${archived.links.pr.url}`);
  }
  if (archived.mergeStats) {
    write(
      `\nMerge Stats: +${archived.mergeStats.totalLinesAdded} / -${archived.mergeStats.totalLinesDeleted} (${archived.mergeStats.mergedPRs?.length || 0} PRs merged)`,
    );
  }
  if (archived.usage) {
    write(
      `\nToken Usage: ${archived.usage.totalInputTokens.toLocaleString()} in / ${archived.usage.totalOutputTokens.toLocaleString()} out / $${archived.usage.totalCostUsd.toFixed(4)}`,
    );
  }
  if (archived.instructions?.length) {
    write(`\nInstructions:`);
    for (const instr of archived.instructions) {
      write(`  ${instr.id}. [${instr.source || 'user'}] ${instr.text}`);
    }
  }
}

function printConversationTurn(turn: ConversationTurn, write: (line: string) => void): void {
  const time = formatDate(turn.timestamp);
  if (turn.role === 'user') {
    write(`[User] ${turn.userName || 'unknown'} — ${time}`);
    write(`  ${truncate(turn.rawContent, 200)}\n`);
    return;
  }
  const summary = turn.summaryTitle || truncate(turn.rawContent, 100);
  write(`[Assistant] — ${time}`);
  write(`  ${summary}`);
  if (turn.summaryBody) write(`  ${turn.summaryBody}`);
  write('');
}

function printConversationSection(archived: ArchivedSession, parsed: ShowSessionArgs, ctx: SessionsContext): void {
  if (!archived.conversationId) {
    ctx.write('\nNo conversation linked to this session.');
    return;
  }
  const conversation = loadConversation(ctx.conversationsDir, archived.conversationId);
  if (!conversation) {
    ctx.write(`\nConversation ${archived.conversationId} not found on disk.`);
    return;
  }
  if (parsed.jsonOutput) {
    ctx.write(JSON.stringify({ session: archived, conversation }, null, 2));
    return;
  }
  ctx.write(`\n${'─'.repeat(60)}`);
  ctx.write(`Conversation: ${conversation.turns.length} turns\n`);
  for (const turn of conversation.turns) {
    printConversationTurn(turn, ctx.write);
  }
}

/** `somawork sessions show <sessionKey>` — historical output, unchanged. */
export function showSession(args: string[], opts: SessionsContextOptions): void {
  const ctx = context(opts);

  const parsed = parseShowArgs(args);
  if (parsed.sessionKey === undefined) {
    ctx.writeErr(`Usage: ${ctx.programName} sessions show <sessionKey> [--conversation] [--json]`);
    ctx.exit(1);
    return;
  }

  const result = loadArchiveBySessionKey(ctx.archivesDir, parsed.sessionKey);
  if (!result.ok) {
    ctx.writeErr(result.error);
    ctx.exit(1);
    return;
  }

  const archived = result.archive;
  if (parsed.jsonOutput && !parsed.showConversation) {
    ctx.write(JSON.stringify(archived, null, 2));
    return;
  }

  printSessionHeader(archived, ctx.write);
  printSessionExtras(archived, ctx.write);

  if (parsed.showConversation) {
    printConversationSection(archived, parsed, ctx);
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export type SessionsAction = 'list' | 'show';

/**
 * The single entry both the `somawork sessions` route and the `soma-cli`
 * compatibility shim call. Neither of them re-parses filters or re-renders rows.
 */
export function runSessionsCommand(action: SessionsAction, args: string[], opts: SessionsContextOptions): void {
  if (action === 'list') {
    listSessions(args, opts);
    return;
  }
  showSession(args, opts);
}
