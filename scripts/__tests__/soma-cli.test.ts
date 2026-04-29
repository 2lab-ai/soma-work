import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ArchivedSession, ConversationRecord } from '../soma-cli';
import { showSession } from '../soma-cli';

// Characterization tests for showSession (Issue #748).
// Trace: scripts/soma-cli.ts showSession (cog 43 → ≤ 15)

interface Captured {
  out: string[];
  err: string[];
  exitCode: number | null;
}

function makeCapture(): { captured: Captured; opts: Parameters<typeof showSession>[1] } {
  const captured: Captured = { out: [], err: [], exitCode: null };
  return {
    captured,
    opts: {
      write: (line: string) => {
        captured.out.push(line);
      },
      writeErr: (line: string) => {
        captured.err.push(line);
      },
      exit: ((code: number) => {
        captured.exitCode = code;
        // Throw a sentinel so the caller stops execution, mirroring process.exit semantics.
        throw new Error(`__exit_${code}__`);
      }) as (code: number) => never,
    },
  };
}

function runShow(args: string[], baseOpts: Parameters<typeof showSession>[1]): Captured {
  const { captured, opts } = makeCapture();
  const merged = { ...baseOpts, ...opts };
  try {
    showSession(args, merged);
  } catch (e) {
    if (!(e instanceof Error) || !/^__exit_\d+__$/.test(e.message)) throw e;
  }
  return captured;
}

function makeArchive(overrides: Partial<ArchivedSession> = {}): ArchivedSession {
  return {
    archivedAt: new Date('2026-04-29T10:00:00Z').getTime(),
    archiveReason: 'completed',
    sessionKey: 'C123_thread1',
    sessionId: 'sid-1',
    ownerId: 'U1',
    ownerName: 'Alice',
    channelId: 'C123',
    threadTs: '1.0',
    title: 'Test session',
    model: 'claude-opus-4',
    workflow: 'default',
    lastActivity: '2026-04-29T10:00:00Z',
    finalState: 'archived',
    finalActivityState: 'idle',
    ...overrides,
  };
}

describe('soma-cli showSession', () => {
  let tmpRoot: string;
  let archivesDir: string;
  let conversationsDir: string;
  let baseOpts: Parameters<typeof showSession>[1];

  beforeEach(() => {
    tmpRoot = path.join(os.tmpdir(), `soma-cli-test-${crypto.randomUUID()}`);
    archivesDir = path.join(tmpRoot, 'archives');
    conversationsDir = path.join(tmpRoot, 'conversations');
    fs.mkdirSync(archivesDir, { recursive: true });
    fs.mkdirSync(conversationsDir, { recursive: true });
    baseOpts = { archivesDir, conversationsDir };
  });

  afterEach(() => {
    if (fs.existsSync(tmpRoot)) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('errors with usage when no args', () => {
    const captured = runShow([], baseOpts);
    expect(captured.exitCode).toBe(1);
    expect(captured.err).toEqual(['Usage: soma-cli sessions show <sessionKey> [--conversation] [--json]']);
    expect(captured.out).toEqual([]);
  });

  it('errors when archives dir is missing', () => {
    fs.rmSync(archivesDir, { recursive: true, force: true });
    const captured = runShow(['missing-key'], baseOpts);
    expect(captured.exitCode).toBe(1);
    expect(captured.err).toEqual(['Session not found: missing-key']);
  });

  it('errors when no archive matches sessionKey', () => {
    const captured = runShow(['nomatch'], baseOpts);
    expect(captured.exitCode).toBe(1);
    expect(captured.err).toEqual(['Session not found: nomatch']);
  });

  it('errors when archive parse fails', () => {
    const sessionKey = 'C123_thread1';
    fs.writeFileSync(path.join(archivesDir, `${sessionKey}_1.json`), 'not valid json');
    const captured = runShow([sessionKey], baseOpts);
    expect(captured.exitCode).toBe(1);
    expect(captured.err).toEqual([`Failed to parse archive: ${sessionKey}`]);
  });

  it('outputs JSON when --json without --conversation', () => {
    const archived = makeArchive();
    fs.writeFileSync(path.join(archivesDir, `${archived.sessionKey}_1.json`), JSON.stringify(archived));
    const captured = runShow([archived.sessionKey, '--json'], baseOpts);
    expect(captured.exitCode).toBeNull();
    expect(captured.out).toHaveLength(1);
    expect(JSON.parse(captured.out[0])).toEqual(archived);
  });

  it('prints default text output with minimal fields', () => {
    const archived = makeArchive({
      ownerName: undefined,
      title: undefined,
      model: undefined,
      workflow: undefined,
      finalState: undefined,
      finalActivityState: undefined,
    });
    fs.writeFileSync(path.join(archivesDir, `${archived.sessionKey}_1.json`), JSON.stringify(archived));
    const captured = runShow([archived.sessionKey], baseOpts);
    expect(captured.exitCode).toBeNull();
    // 8 header lines, no extras, no conversation
    expect(captured.out).toHaveLength(8);
    expect(captured.out[0]).toBe(`Session: ${archived.sessionKey}`);
    expect(captured.out[1]).toBe('Owner:   unknown (U1)');
    expect(captured.out[2]).toBe('Model:   unknown');
    expect(captured.out[3]).toBe('Title:   Untitled');
    expect(captured.out[4]).toBe('Workflow: default');
    expect(captured.out[6]).toBe('Last Activity: 2026-04-29T10:00:00Z');
    expect(captured.out[7]).toBe('Final State: unknown / unknown');
  });

  it('prints links/mergeStats/usage/instructions sections when present', () => {
    const archived = makeArchive({
      links: {
        issue: { url: 'https://example.com/i/1', label: 'ISSUE-1' },
        pr: { url: 'https://example.com/pr/2', label: 'PR-2', status: 'merged' },
      },
      mergeStats: { totalLinesAdded: 100, totalLinesDeleted: 20, mergedPRs: [{}, {}] },
      usage: { totalInputTokens: 12345, totalOutputTokens: 6789, totalCostUsd: 0.123456 },
      instructions: [
        { id: 'i1', text: 'Be concise', addedAt: 1, source: 'user' },
        { id: 'i2', text: 'Use markdown', addedAt: 2 },
      ],
    });
    fs.writeFileSync(path.join(archivesDir, `${archived.sessionKey}_1.json`), JSON.stringify(archived));
    const captured = runShow([archived.sessionKey], baseOpts);
    expect(captured.exitCode).toBeNull();
    const joined = captured.out.join('\n');
    expect(joined).toContain('Issue: ISSUE-1 — https://example.com/i/1');
    expect(joined).toContain('PR: PR-2 (merged) — https://example.com/pr/2');
    expect(joined).toContain('Merge Stats: +100 / -20 (2 PRs merged)');
    expect(joined).toContain('Token Usage: 12,345 in / 6,789 out / $0.1235');
    expect(joined).toContain('Instructions:');
    expect(joined).toContain('  i1. [user] Be concise');
    expect(joined).toContain('  i2. [user] Use markdown');
  });

  it('says no conversation linked when --conversation but no conversationId', () => {
    const archived = makeArchive();
    fs.writeFileSync(path.join(archivesDir, `${archived.sessionKey}_1.json`), JSON.stringify(archived));
    const captured = runShow([archived.sessionKey, '--conversation'], baseOpts);
    expect(captured.exitCode).toBeNull();
    expect(captured.out[captured.out.length - 1]).toBe('\nNo conversation linked to this session.');
  });

  it('says conversation not found on disk when file missing', () => {
    const archived = makeArchive({ conversationId: 'conv-missing' });
    fs.writeFileSync(path.join(archivesDir, `${archived.sessionKey}_1.json`), JSON.stringify(archived));
    const captured = runShow([archived.sessionKey, '--conversation'], baseOpts);
    expect(captured.exitCode).toBeNull();
    expect(captured.out[captured.out.length - 1]).toBe('\nConversation conv-missing not found on disk.');
  });

  it('prints conversation turns mixing user/assistant with optional summary fields', () => {
    const conv: ConversationRecord = {
      id: 'conv-1',
      title: 'Chat',
      turns: [
        {
          id: 't1',
          role: 'user',
          timestamp: new Date('2026-04-29T10:00:00Z').getTime(),
          userName: 'Alice',
          rawContent: 'Hello assistant',
        },
        {
          id: 't2',
          role: 'assistant',
          timestamp: new Date('2026-04-29T10:01:00Z').getTime(),
          rawContent: 'Hi there, this is the raw assistant content for fallback when no summary title is set',
        },
        {
          id: 't3',
          role: 'assistant',
          timestamp: new Date('2026-04-29T10:02:00Z').getTime(),
          rawContent: 'irrelevant',
          summaryTitle: 'Summary title here',
          summaryBody: 'Summary body details.',
        },
        {
          id: 't4',
          role: 'user',
          timestamp: new Date('2026-04-29T10:03:00Z').getTime(),
          rawContent: 'no userName',
        },
      ],
    };
    const archived = makeArchive({ conversationId: conv.id });
    fs.writeFileSync(path.join(archivesDir, `${archived.sessionKey}_1.json`), JSON.stringify(archived));
    fs.writeFileSync(path.join(conversationsDir, `${conv.id}.json`), JSON.stringify(conv));

    const captured = runShow([archived.sessionKey, '--conversation'], baseOpts);
    expect(captured.exitCode).toBeNull();
    const joined = captured.out.join('\n');
    expect(joined).toContain('Conversation: 4 turns');
    expect(joined).toContain('[User] Alice — ');
    expect(joined).toContain('  Hello assistant\n');
    expect(joined).toContain('[Assistant] — ');
    // Assistant fallback to truncated rawContent when no summaryTitle
    expect(joined).toContain('Hi there, this is the raw assistant content for fallback when no summary title is set');
    expect(joined).toContain('  Summary title here');
    expect(joined).toContain('  Summary body details.');
    expect(joined).toContain('[User] unknown — ');
    expect(joined).toContain('  no userName\n');
  });

  it('outputs combined session+conversation JSON when --json --conversation', () => {
    const conv: ConversationRecord = {
      id: 'conv-2',
      title: 'Chat',
      turns: [
        {
          id: 't1',
          role: 'user',
          timestamp: new Date('2026-04-29T10:00:00Z').getTime(),
          userName: 'Alice',
          rawContent: 'Hi',
        },
      ],
    };
    const archived = makeArchive({ conversationId: conv.id });
    fs.writeFileSync(path.join(archivesDir, `${archived.sessionKey}_1.json`), JSON.stringify(archived));
    fs.writeFileSync(path.join(conversationsDir, `${conv.id}.json`), JSON.stringify(conv));

    const captured = runShow([archived.sessionKey, '--conversation', '--json'], baseOpts);
    expect(captured.exitCode).toBeNull();
    // Header + extras still print, then last entry is the combined JSON
    const last = captured.out[captured.out.length - 1];
    const parsed = JSON.parse(last);
    expect(parsed).toEqual({ session: archived, conversation: conv });
  });
});
