import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';

vi.mock('./env-paths', () => ({
  DATA_DIR: '/tmp/soma-work-session-registry-test',
}));

import { SessionRegistry } from './session-registry';

const TEST_DATA_DIR = '/tmp/soma-work-session-registry-test';

describe('SessionRegistry persistence', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) {
      fs.rmSync(TEST_DATA_DIR, { recursive: true });
    }
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) {
      fs.rmSync(TEST_DATA_DIR, { recursive: true });
    }
  });

  it('restores action panel state including existing panel message ts', () => {
    const writer = new SessionRegistry();
    const session = writer.createSession('U123', 'Tester', 'C123', '171.001');
    session.sessionId = 'session-1';
    session.actionPanel = {
      channelId: 'C123',
      userId: 'U123',
      messageTs: '999.100',
      choiceMessageTs: '999.101',
      waitingForChoice: true,
      choiceBlocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'choose one' } }],
      threadTs: '171.001',
      threadLink: 'https://example.com/thread',
    };

    writer.saveSessions();

    const reader = new SessionRegistry();
    const loaded = reader.loadSessions();
    const restored = reader.getSession('C123', '171.001');

    expect(loaded).toBe(1);
    expect(restored?.actionPanel?.messageTs).toBe('999.100');
    expect(restored?.actionPanel?.choiceMessageTs).toBe('999.101');
    expect(restored?.actionPanel?.waitingForChoice).toBe(true);
    expect(restored?.actionPanel?.choiceBlocks).toHaveLength(1);
    expect(restored?.actionPanel?.threadTs).toBe('171.001');
  });

  it('restores bot-initiated thread metadata', () => {
    const writer = new SessionRegistry();
    const session = writer.createSession('U123', 'Tester', 'C123', '171.002');
    session.sessionId = 'session-2';
    session.threadModel = 'bot-initiated';
    session.threadRootTs = '777.888';

    writer.saveSessions();

    const reader = new SessionRegistry();
    const loaded = reader.loadSessions();
    const restored = reader.getSession('C123', '171.002');

    expect(loaded).toBe(1);
    expect(restored?.threadModel).toBe('bot-initiated');
    expect(restored?.threadRootTs).toBe('777.888');
  });

  it('persists linkHistory and sequence for session resources', () => {
    const writer = new SessionRegistry();
    const session = writer.createSession('U123', 'Tester', 'C123', '171.003');
    session.sessionId = 'session-3';

    writer.setSessionLink('C123', '171.003', {
      url: 'https://jira.example/PTN-100',
      type: 'issue',
      provider: 'jira',
      label: 'PTN-100',
    });
    writer.setSessionLink('C123', '171.003', {
      url: 'https://jira.example/PTN-101',
      type: 'issue',
      provider: 'jira',
      label: 'PTN-101',
    });
    writer.setSessionLink('C123', '171.003', {
      url: 'https://github.com/org/repo/pull/55',
      type: 'pr',
      provider: 'github',
      label: 'PR #55',
    });
    writer.saveSessions();

    const reader = new SessionRegistry();
    reader.loadSessions();
    const snapshot = reader.getSessionResourceSnapshot('C123', '171.003');

    expect(snapshot.issues).toHaveLength(2);
    expect(snapshot.prs).toHaveLength(1);
    expect(snapshot.active.issue?.url).toBe('https://jira.example/PTN-101');
    expect(snapshot.active.pr?.url).toBe('https://github.com/org/repo/pull/55');
    expect(snapshot.sequence).toBeGreaterThan(0);
  });

  it('enforces optimistic sequence checks on updateSessionResources', () => {
    const registry = new SessionRegistry();
    const session = registry.createSession('U123', 'Tester', 'C123', '171.004');
    session.sessionId = 'session-4';

    const first = registry.updateSessionResources('C123', '171.004', {
      operations: [
        {
          action: 'add',
          resourceType: 'issue',
          link: {
            url: 'https://jira.example/PTN-200',
            type: 'issue',
            provider: 'jira',
          },
        },
      ],
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const stale = registry.updateSessionResources('C123', '171.004', {
      expectedSequence: 0,
      operations: [
        {
          action: 'set_active',
          resourceType: 'issue',
          url: 'https://jira.example/PTN-200',
        },
      ],
    });

    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.reason).toBe('SEQUENCE_MISMATCH');
    expect(stale.sequenceMismatch?.actual).toBe(first.snapshot.sequence);
  });
});
