import { describe, it, expect } from 'vitest';
import {
  buildCompactionContext,
  snapshotFromSession,
  CompactionSessionSnapshot,
} from './compaction-context-builder';
import { ConversationSession, SessionLinks } from '../types';

describe('buildCompactionContext', () => {
  const baseSnapshot: CompactionSessionSnapshot = {
    ownerId: 'U001',
    ownerName: 'Alice',
  };

  it('returns undefined when snapshot has no meaningful data', () => {
    const result = buildCompactionContext({ ownerId: 'U001' });
    // ownerName is missing, no title, no workflow, no links — but ownerId alone is not emitted
    expect(result).toBeUndefined();
  });

  it('includes session title', () => {
    const result = buildCompactionContext({ ...baseSnapshot, title: '[PTN-123] Fix login bug' });
    expect(result).toContain('Session: [PTN-123] Fix login bug');
  });

  it('includes workflow (non-default)', () => {
    const result = buildCompactionContext({ ...baseSnapshot, workflow: 'pr-review' });
    expect(result).toContain('Workflow: pr-review');
  });

  it('excludes default workflow', () => {
    const result = buildCompactionContext({ ...baseSnapshot, title: 'test', workflow: 'default' });
    expect(result).not.toContain('Workflow:');
  });

  it('includes working directory', () => {
    const result = buildCompactionContext({
      ...baseSnapshot,
      workingDirectory: '/tmp/U001/soma-work',
    });
    expect(result).toContain('Working directory: /tmp/U001/soma-work');
  });

  it('includes linked resources with label, title, and status', () => {
    const links: SessionLinks = {
      issue: {
        url: 'https://jira.example.com/PTN-123',
        type: 'issue',
        provider: 'jira',
        label: 'PTN-123',
        title: 'Fix login redirect',
        status: 'in-progress',
      },
      pr: {
        url: 'https://github.com/org/repo/pull/42',
        type: 'pr',
        provider: 'github',
        label: 'PR #42',
        status: 'open',
      },
    };
    const result = buildCompactionContext({ ...baseSnapshot, links });
    expect(result).toContain('Linked resources:');
    expect(result).toContain('- [issue] PTN-123 "Fix login redirect" https://jira.example.com/PTN-123 (in-progress)');
    expect(result).toContain('- [pr] PR #42 https://github.com/org/repo/pull/42 (open)');
  });

  it('includes model', () => {
    const result = buildCompactionContext({ ...baseSnapshot, model: 'claude-opus-4-6' });
    expect(result).toContain('Model: claude-opus-4-6');
  });

  it('includes session owner name', () => {
    const result = buildCompactionContext({ ...baseSnapshot, title: 'test' });
    expect(result).toContain('Session owner: Alice');
  });

  it('wraps output in XML-style tags', () => {
    const result = buildCompactionContext({ ...baseSnapshot, title: 'test' })!;
    expect(result).toMatch(/^<session-context-after-compaction>/);
    expect(result).toMatch(/<\/session-context-after-compaction>$/);
  });

  it('includes full context for a rich snapshot', () => {
    const result = buildCompactionContext({
      ownerId: 'U001',
      ownerName: 'Bob',
      title: '[FEAT-99] Dashboard',
      workflow: 'jira-create-pr',
      workingDirectory: '/tmp/work',
      model: 'claude-sonnet-4-6',
      links: {
        issue: {
          url: 'https://jira.example.com/FEAT-99',
          type: 'issue',
          provider: 'jira',
          label: 'FEAT-99',
        },
      },
    })!;
    expect(result).toContain('Session: [FEAT-99] Dashboard');
    expect(result).toContain('Workflow: jira-create-pr');
    expect(result).toContain('Working directory: /tmp/work');
    expect(result).toContain('Model: claude-sonnet-4-6');
    expect(result).toContain('Session owner: Bob');
    expect(result).toContain('FEAT-99');
  });
});

describe('snapshotFromSession', () => {
  it('extracts relevant fields from ConversationSession', () => {
    const session = {
      ownerId: 'U001',
      ownerName: 'Alice',
      channelId: 'C001',
      isActive: true,
      lastActivity: new Date(),
      userId: 'U001',
      title: 'Test session',
      workflow: 'pr-review' as const,
      workingDirectory: '/tmp/work',
      model: 'claude-opus-4-6',
      links: {
        issue: {
          url: 'https://example.com',
          type: 'issue' as const,
          provider: 'jira' as const,
        },
      },
      // Fields that should NOT be in snapshot
      sessionId: 'sess-123',
      threadTs: '123.456',
      usage: { currentInputTokens: 0, currentOutputTokens: 0, currentCacheReadTokens: 0, currentCacheCreateTokens: 0, contextWindow: 200000, totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0, lastUpdated: 0 },
    } as ConversationSession;

    const snapshot = snapshotFromSession(session);
    expect(snapshot.title).toBe('Test session');
    expect(snapshot.workflow).toBe('pr-review');
    expect(snapshot.workingDirectory).toBe('/tmp/work');
    expect(snapshot.model).toBe('claude-opus-4-6');
    expect(snapshot.ownerId).toBe('U001');
    expect(snapshot.ownerName).toBe('Alice');
    expect(snapshot.links?.issue?.url).toBe('https://example.com');
    // Ensure no extra fields leaked
    expect((snapshot as any).sessionId).toBeUndefined();
    expect((snapshot as any).usage).toBeUndefined();
  });
});
