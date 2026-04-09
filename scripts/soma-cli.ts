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

import * as fs from 'fs';
import * as path from 'path';

// ── Resolve DATA_DIR (simplified from env-paths.ts) ─────────────────

function resolveDataDir(): string {
  if (process.env.SOMA_CONFIG_DIR) {
    return path.join(process.env.SOMA_CONFIG_DIR, 'data');
  }
  const root = process.cwd();
  try {
    const { execSync } = require('child_process');
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
  linkHistory?: { issues: any[]; prs: any[]; docs: any[] };
  instructions?: Array<{ id: string; text: string; addedAt: number; source?: string }>;
  mergeStats?: { totalLinesAdded: number; totalLinesDeleted: number; mergedPRs: any[] };
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

function loadConversation(conversationId: string): ConversationRecord | null {
  const safeId = conversationId.replace(/[^a-zA-Z0-9_-]/g, '');
  const filePath = path.join(CONVERSATIONS_DIR, `${safeId}.json`);
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
  return s.slice(0, maxLen - 3) + '...';
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
  if (sinceDate) archives = archives.filter((a) => a.archivedAt >= sinceDate!);
  if (untilDate) archives = archives.filter((a) => a.archivedAt <= untilDate!);

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

function showSession(args: string[]): void {
  if (args.length === 0) {
    console.error('Usage: soma-cli sessions show <sessionKey> [--conversation] [--json]');
    process.exit(1);
  }

  const sessionKey = args[0];
  const showConversation = args.includes('--conversation');
  const jsonOutput = args.includes('--json');

  // Find archive file (append-only naming: {key}_{timestamp}.json)
  const sanitizedKey = sessionKey.replace(/[^a-zA-Z0-9._-]/g, '-');

  if (!fs.existsSync(ARCHIVES_DIR)) {
    console.error(`Session not found: ${sessionKey}`);
    process.exit(1);
  }

  // Find the most recent archive matching this key
  const prefix = sanitizedKey + '_';
  const matchingFiles = fs.readdirSync(ARCHIVES_DIR)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
    .sort()
    .reverse();

  if (matchingFiles.length === 0) {
    console.error(`Session not found: ${sessionKey}`);
    process.exit(1);
  }

  const archivePath = path.join(ARCHIVES_DIR, matchingFiles[0]);

  let archived: ArchivedSession;
  try {
    archived = JSON.parse(fs.readFileSync(archivePath, 'utf-8'));
  } catch {
    console.error(`Failed to parse archive: ${sessionKey}`);
    process.exit(1);
  }

  if (jsonOutput && !showConversation) {
    console.log(JSON.stringify(archived, null, 2));
    return;
  }

  // Session detail
  console.log(`Session: ${archived.sessionKey}`);
  console.log(`Owner:   ${archived.ownerName || 'unknown'} (${archived.ownerId})`);
  console.log(`Model:   ${archived.model || 'unknown'}`);
  console.log(`Title:   ${archived.title || 'Untitled'}`);
  console.log(`Workflow: ${archived.workflow || 'default'}`);
  console.log(`Archived: ${formatDate(archived.archivedAt)} (${archived.archiveReason})`);
  console.log(`Last Activity: ${archived.lastActivity}`);
  console.log(`Final State: ${archived.finalState || 'unknown'} / ${archived.finalActivityState || 'unknown'}`);

  if (archived.links?.issue) {
    console.log(`\nIssue: ${archived.links.issue.label || ''} — ${archived.links.issue.url}`);
  }
  if (archived.links?.pr) {
    console.log(`PR: ${archived.links.pr.label || ''} (${archived.links.pr.status || 'unknown'}) — ${archived.links.pr.url}`);
  }

  if (archived.mergeStats) {
    console.log(
      `\nMerge Stats: +${archived.mergeStats.totalLinesAdded} / -${archived.mergeStats.totalLinesDeleted} (${archived.mergeStats.mergedPRs?.length || 0} PRs merged)`,
    );
  }

  if (archived.usage) {
    console.log(
      `\nToken Usage: ${archived.usage.totalInputTokens.toLocaleString()} in / ${archived.usage.totalOutputTokens.toLocaleString()} out / $${archived.usage.totalCostUsd.toFixed(4)}`,
    );
  }

  if (archived.instructions?.length) {
    console.log(`\nInstructions:`);
    for (const instr of archived.instructions) {
      console.log(`  ${instr.id}. [${instr.source || 'user'}] ${instr.text}`);
    }
  }

  // Conversation
  if (showConversation) {
    if (!archived.conversationId) {
      console.log('\nNo conversation linked to this session.');
      return;
    }

    const conversation = loadConversation(archived.conversationId);
    if (!conversation) {
      console.log(`\nConversation ${archived.conversationId} not found on disk.`);
      return;
    }

    if (jsonOutput) {
      console.log(JSON.stringify({ session: archived, conversation }, null, 2));
      return;
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Conversation: ${conversation.turns.length} turns\n`);

    for (const turn of conversation.turns) {
      const time = formatDate(turn.timestamp);
      if (turn.role === 'user') {
        console.log(`[User] ${turn.userName || 'unknown'} — ${time}`);
        console.log(`  ${truncate(turn.rawContent, 200)}\n`);
      } else {
        const summary = turn.summaryTitle || truncate(turn.rawContent, 100);
        console.log(`[Assistant] — ${time}`);
        console.log(`  ${summary}`);
        if (turn.summaryBody) console.log(`  ${turn.summaryBody}`);
        console.log();
      }
    }
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

main();
