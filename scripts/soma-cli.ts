#!/usr/bin/env tsx
/**
 * soma-cli — CLI tool for querying archived sessions.
 *
 * Usage:
 *   tsx scripts/soma-cli.ts sessions list [--user <id>] [--model <name>] [--since <date>] [--until <date>] [--limit N] [--json]
 *   tsx scripts/soma-cli.ts sessions show <sessionKey> [--conversation] [--json]
 *
 * Trace: docs/session-archive/trace.md, Scenarios 4 & 5
 * Issue: #401
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ── Resolve DATA_DIR (simplified from env-paths.ts) ─────────────────

function resolveDataDir(): string {
  if (process.env.SOMA_CONFIG_DIR) {
    return path.join(process.env.SOMA_CONFIG_DIR, 'data');
  }
  const root = process.cwd();
  try {
    const { execSync } = require('node:child_process');
    const branch = execSync('git branch --show-current', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    return path.join(root, branch === 'main' ? 'data' : 'data.dev');
  } catch {
    return path.join(root, 'data');
  }
}

const DATA_DIR = resolveDataDir();
const ARCHIVES_DIR = path.join(DATA_DIR, 'archives');
const CONVERSATIONS_DIR = path.join(DATA_DIR, 'conversations');

// ── Types (subset of ArchivedSession / ConversationRecord) ──────────

interface ArchivedSession {
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

interface ConversationTurn {
  id: string;
  role: 'user' | 'assistant';
  timestamp: number;
  userName?: string;
  rawContent: string;
  summaryTitle?: string;
  summaryBody?: string;
}

interface ConversationRecord {
  id: string;
  title?: string;
  turns: ConversationTurn[];
}

// ── DI options for showSession ──────────────────────────────────────

interface ShowSessionOptions {
  archivesDir?: string;
  conversationsDir?: string;
  write?: (line: string) => void;
  writeErr?: (line: string) => void;
  exit?: (code: number) => never;
}

interface ShowSessionContext {
  archivesDir: string;
  conversationsDir: string;
  write: (line: string) => void;
  writeErr: (line: string) => void;
  exit: (code: number) => never;
}

interface ShowSessionArgs {
  sessionKey: string;
  showConversation: boolean;
  jsonOutput: boolean;
}

// ── Helpers ─────────────────────────────────────────────────────────

function loadAllArchives(): ArchivedSession[] {
  if (!fs.existsSync(ARCHIVES_DIR)) return [];
  const files = fs.readdirSync(ARCHIVES_DIR).filter((f) => f.endsWith('.json'));
  const archives: ArchivedSession[] = [];
  for (const file of files) {
    try {
      const data = fs.readFileSync(path.join(ARCHIVES_DIR, file), 'utf-8');
      archives.push(JSON.parse(data));
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

// ── Commands ────────────────────────────────────────────────────────

function listSessions(args: string[]): void {
  let filterUser: string | undefined;
  let filterModel: string | undefined;
  let sinceDate: number | undefined;
  let untilDate: number | undefined;
  let limit = 50;
  let jsonOutput = false;

  // Parse args
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--user':
        filterUser = args[++i];
        break;
      case '--model':
        filterModel = args[++i];
        break;
      case '--since':
        sinceDate = new Date(args[++i]).getTime();
        break;
      case '--until':
        untilDate = new Date(args[++i]).getTime();
        break;
      case '--limit':
        limit = parseInt(args[++i], 10) || 50;
        break;
      case '--json':
        jsonOutput = true;
        break;
    }
  }

  let archives = loadAllArchives();

  // Apply filters
  if (filterUser) archives = archives.filter((a) => a.ownerId === filterUser || a.ownerName === filterUser);
  if (filterModel) archives = archives.filter((a) => a.model === filterModel);
  if (sinceDate) archives = archives.filter((a) => a.archivedAt >= (sinceDate as number));
  if (untilDate) archives = archives.filter((a) => a.archivedAt <= (untilDate as number));

  archives = archives.slice(0, limit);

  if (archives.length === 0) {
    console.log('No sessions match the filter.');
    return;
  }

  if (jsonOutput) {
    console.log(JSON.stringify(archives, null, 2));
    return;
  }

  // Table output
  console.log(
    `${padRight('SessionKey', 30)} ${padRight('Owner', 12)} ${padRight('Model', 20)} ${padRight('Workflow', 15)} ${padRight('Archived At', 22)} ${padRight('Reason', 14)}`,
  );
  console.log('-'.repeat(115));

  for (const a of archives) {
    console.log(
      `${padRight(truncate(a.sessionKey, 28), 30)} ${padRight(truncate(a.ownerName || a.ownerId, 10), 12)} ${padRight(truncate(a.model || 'unknown', 18), 20)} ${padRight(a.workflow || 'default', 15)} ${padRight(formatDate(a.archivedAt), 22)} ${padRight(a.archiveReason, 14)}`,
    );
  }

  console.log(`\nTotal: ${archives.length} session(s)`);
}

// ── showSession helpers ─────────────────────────────────────────────

function parseShowArgs(args: string[]): ShowSessionArgs {
  return {
    sessionKey: args[0],
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
  const archivePath = path.join(archivesDir, matchingFiles[0]);
  try {
    return { ok: true, archive: JSON.parse(fs.readFileSync(archivePath, 'utf-8')) as ArchivedSession };
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

function printConversationSection(archived: ArchivedSession, parsed: ShowSessionArgs, ctx: ShowSessionContext): void {
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

function showSession(args: string[], opts: ShowSessionOptions = {}): void {
  const ctx: ShowSessionContext = {
    archivesDir: opts.archivesDir ?? ARCHIVES_DIR,
    conversationsDir: opts.conversationsDir ?? CONVERSATIONS_DIR,
    write: opts.write ?? ((line: string) => console.log(line)),
    writeErr: opts.writeErr ?? ((line: string) => console.error(line)),
    exit: opts.exit ?? ((code: number) => process.exit(code)),
  };

  if (args.length === 0) {
    ctx.writeErr('Usage: soma-cli sessions show <sessionKey> [--conversation] [--json]');
    ctx.exit(1);
    return;
  }

  const parsed = parseShowArgs(args);
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

// ── Main ────────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);

  if (args.length < 2 || args[0] !== 'sessions') {
    console.log(`soma-cli — Session Archive Query Tool

Usage:
  tsx scripts/soma-cli.ts sessions list [options]
  tsx scripts/soma-cli.ts sessions show <sessionKey> [--conversation] [--json]

List Options:
  --user <id>       Filter by user ID or name
  --model <model>   Filter by model name
  --since <date>    Start date (YYYY-MM-DD)
  --until <date>    End date (YYYY-MM-DD)
  --limit <N>       Max results (default: 50)
  --json            Output as JSON`);
    process.exit(args.length === 0 ? 0 : 1);
  }

  const subcommand = args[1];
  const subArgs = args.slice(2);

  switch (subcommand) {
    case 'list':
      listSessions(subArgs);
      break;
    case 'show':
      showSession(subArgs);
      break;
    default:
      console.error(`Unknown subcommand: ${subcommand}`);
      process.exit(1);
  }
}

// Only execute when invoked directly (not imported by tests).
if (require.main === module) {
  main();
}

export type { ArchivedSession, ConversationRecord, ShowSessionOptions };
// ── Test-only exports ───────────────────────────────────────────────
export {
  loadArchiveBySessionKey,
  parseShowArgs,
  printConversationSection,
  printSessionExtras,
  printSessionHeader,
  showSession,
};
