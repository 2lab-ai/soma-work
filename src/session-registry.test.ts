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
});
