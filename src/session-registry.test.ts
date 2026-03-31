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

  it('restores action panel state but clears stale messageTs/renderKey on reload', () => {
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
    // messageTs and renderKey are intentionally cleared on restore to prevent stale message_not_found errors
    expect(restored?.actionPanel?.messageTs).toBeUndefined();
    expect(restored?.actionPanel?.renderKey).toBeUndefined();
    // Other actionPanel fields should survive the restore
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

  it('keeps active link cleared when set_active is called without url', () => {
    const registry = new SessionRegistry();
    const session = registry.createSession('U123', 'Tester', 'C123', '171.005');
    session.sessionId = 'session-5';

    const addResult = registry.updateSessionResources('C123', '171.005', {
      operations: [
        {
          action: 'add',
          resourceType: 'issue',
          link: {
            url: 'https://jira.example/PTN-300',
            type: 'issue',
            provider: 'jira',
          },
        },
      ],
    });
    expect(addResult.ok).toBe(true);
    if (!addResult.ok) return;
    expect(addResult.snapshot.active.issue?.url).toBe('https://jira.example/PTN-300');

    const clearResult = registry.updateSessionResources('C123', '171.005', {
      operations: [
        {
          action: 'set_active',
          resourceType: 'issue',
        },
      ],
    });

    expect(clearResult.ok).toBe(true);
    if (!clearResult.ok) return;
    expect(clearResult.snapshot.active.issue).toBeUndefined();

    const snapshot = registry.getSessionResourceSnapshot('C123', '171.005');
    expect(snapshot.active.issue).toBeUndefined();
  });

  // Session Recovery Fix: sessionWorkingDir must survive save/load
  // Without this, Claude SDK resumes in the wrong cwd → different project hash → "No conversation found"
  it('persists and restores sessionWorkingDir across save/load', () => {
    const writer = new SessionRegistry();
    const session = writer.createSession('U123', 'Tester', 'C123', '171.006');
    session.sessionId = 'session-6';
    session.sessionWorkingDir = '/tmp/U123/session_1711111111111_abc123';
    session.state = 'MAIN';

    writer.saveSessions();

    const reader = new SessionRegistry();
    reader.loadSessions();
    const restored = reader.getSession('C123', '171.006');

    expect(restored).toBeDefined();
    expect(restored!.sessionWorkingDir).toBe('/tmp/U123/session_1711111111111_abc123');
  });

  // Edge case: legacy session without sessionWorkingDir survives save/load
  it('legacy session without sessionWorkingDir loads with undefined', () => {
    const writer = new SessionRegistry();
    const session = writer.createSession('U123', 'Tester', 'C123', '171.007');
    session.sessionId = 'session-7';
    session.state = 'MAIN';
    // sessionWorkingDir intentionally NOT set (simulates pre-PR#77 session)

    writer.saveSessions();

    const reader = new SessionRegistry();
    reader.loadSessions();
    const restored = reader.getSession('C123', '171.007');

    expect(restored).toBeDefined();
    expect(restored!.sessionWorkingDir).toBeUndefined();
    // effectiveWorkingDir fallback: undefined || baseDir = baseDir
    const baseDir = '/tmp/U123';
    const effectiveDir = restored!.sessionWorkingDir || baseDir;
    expect(effectiveDir).toBe(baseDir);
  });

  // Edge case: multiple sessions with different sessionWorkingDirs
  it('preserves distinct sessionWorkingDir per session across save/load', () => {
    const writer = new SessionRegistry();

    const s1 = writer.createSession('U123', 'Tester', 'C123', '171.008');
    s1.sessionId = 'session-8a';
    s1.sessionWorkingDir = '/tmp/U123/session_aaa';
    s1.state = 'MAIN';

    const s2 = writer.createSession('U456', 'Tester2', 'C456', '171.009');
    s2.sessionId = 'session-8b';
    s2.sessionWorkingDir = '/tmp/U456/session_bbb';
    s2.state = 'MAIN';

    writer.saveSessions();

    const reader = new SessionRegistry();
    reader.loadSessions();

    const r1 = reader.getSession('C123', '171.008');
    const r2 = reader.getSession('C456', '171.009');

    expect(r1).toBeDefined();
    expect(r2).toBeDefined();
    expect(r1!.sessionWorkingDir).toBe('/tmp/U123/session_aaa');
    expect(r2!.sessionWorkingDir).toBe('/tmp/U456/session_bbb');
    // No cross-contamination
    expect(r1!.sessionWorkingDir).not.toBe(r2!.sessionWorkingDir);
  });

  // Edge case: backward compatibility — old JSON without sessionWorkingDir field
  it('loads old JSON format without sessionWorkingDir field gracefully', () => {
    // Write a JSON file manually without sessionWorkingDir
    const fs = require('fs');
    const oldFormatSessions = [{
      key: 'C123-171.010',
      ownerId: 'U123',
      ownerName: 'Tester',
      channelId: 'C123',
      threadTs: '171.010',
      sessionId: 'session-old',
      isActive: true,
      lastActivity: new Date().toISOString(),
      state: 'MAIN',
      workflow: 'default',
      // NO sessionWorkingDir field — simulates pre-fix JSON
    }];
    fs.writeFileSync(
      require('path').join('/tmp/soma-work-session-registry-test', 'sessions.json'),
      JSON.stringify(oldFormatSessions, null, 2),
    );

    const reader = new SessionRegistry();
    reader.loadSessions();
    const restored = reader.getSession('C123', '171.010');

    expect(restored).toBeDefined();
    expect(restored!.sessionWorkingDir).toBeUndefined();
    expect(restored!.sessionId).toBe('session-old');
  });

  it('updateSessionTitle overwrites existing title', () => {
    const registry = new SessionRegistry();
    const session = registry.createSession('U123', 'Tester', 'C123', '171.020');
    session.sessionId = 'session-title-1';
    session.title = 'Original Title';

    registry.updateSessionTitle('C123', '171.020', 'New Title');

    const updated = registry.getSession('C123', '171.020');
    expect(updated?.title).toBe('New Title');
  });

  it('updateSessionTitle works on session with no prior title', () => {
    const registry = new SessionRegistry();
    const session = registry.createSession('U123', 'Tester', 'C123', '171.021');
    session.sessionId = 'session-title-2';
    // No title set

    registry.updateSessionTitle('C123', '171.021', 'First Title');

    const updated = registry.getSession('C123', '171.021');
    expect(updated?.title).toBe('First Title');
  });

  // Security: sessionWorkingDir with path traversal is dropped on load
  it('drops sessionWorkingDir with path traversal on load', () => {
    const fs = require('fs');
    const maliciousSessions = [{
      key: 'C123-171.011',
      ownerId: 'U123',
      ownerName: 'Tester',
      channelId: 'C123',
      threadTs: '171.011',
      sessionId: 'session-malicious',
      isActive: true,
      lastActivity: new Date().toISOString(),
      state: 'MAIN',
      workflow: 'default',
      sessionWorkingDir: '/tmp/../etc/passwd', // path traversal attempt
    }];
    fs.writeFileSync(
      require('path').join('/tmp/soma-work-session-registry-test', 'sessions.json'),
      JSON.stringify(maliciousSessions, null, 2),
    );

    const reader = new SessionRegistry();
    reader.loadSessions();
    const restored = reader.getSession('C123', '171.011');

    expect(restored).toBeDefined();
    expect(restored!.sessionWorkingDir).toBeUndefined(); // dropped by validation
  });

  it('clearSessionId resets file-access retry state', () => {
    const registry = new SessionRegistry();
    const session = registry.createSession('U123', 'Tester', 'C_FA', '171.FA1');
    session.sessionId = 'session-fa';
    session.fileAccessRetryCount = 2;
    session.lastErrorContext = '파일 접근이 차단되었습니다: /tmp/blocked.png';
    session.errorRetryCount = 1;

    registry.clearSessionId('C_FA', '171.FA1');

    expect(session.sessionId).toBeUndefined();
    expect(session.fileAccessRetryCount).toBe(0);
    expect(session.lastErrorContext).toBeUndefined();
    expect(session.errorRetryCount).toBe(0);
  });

  it('resetSessionContext clears file-access retry state', () => {
    const registry = new SessionRegistry();
    const session = registry.createSession('U123', 'Tester', 'C_FA', '171.FA2');
    session.sessionId = 'session-fa2';
    session.fileAccessRetryCount = 3;
    session.lastErrorContext = '차단된 파일';

    const result = registry.resetSessionContext('C_FA', '171.FA2');

    expect(result).toBe(true);
    expect(session.fileAccessRetryCount).toBe(0);
    expect(session.lastErrorContext).toBeUndefined();
  });

  // === Issue #214: clearSessionId persists retry state cleanup to disk ===

  it('clearSessionId calls saveSessions to persist cleanup', () => {
    const registry = new SessionRegistry();
    const session = registry.createSession('U123', 'Tester', 'C_PERSIST', '171.P1');
    session.sessionId = 'session-persist';
    session.fileAccessRetryCount = 2;
    session.errorRetryCount = 1;

    const saveSpy = vi.spyOn(registry as any, 'saveSessions');
    registry.clearSessionId('C_PERSIST', '171.P1');

    expect(saveSpy).toHaveBeenCalled();
    saveSpy.mockRestore();
  });

  // === Issue #215: clearSessionId cancels pending retry timer ===

  it('clearSessionId cancels pendingRetryTimer', () => {
    const registry = new SessionRegistry();
    const session = registry.createSession('U123', 'Tester', 'C_TIMER', '171.T1');
    session.sessionId = 'session-timer';
    const callback = vi.fn();
    session.pendingRetryTimer = setTimeout(callback, 60_000);

    registry.clearSessionId('C_TIMER', '171.T1');

    expect(session.pendingRetryTimer).toBeUndefined();
  });

  it('resetSessionContext cancels pendingRetryTimer', () => {
    const registry = new SessionRegistry();
    const session = registry.createSession('U123', 'Tester', 'C_TIMER', '171.T2');
    session.sessionId = 'session-timer2';
    const callback = vi.fn();
    session.pendingRetryTimer = setTimeout(callback, 60_000);

    registry.resetSessionContext('C_TIMER', '171.T2');

    expect(session.pendingRetryTimer).toBeUndefined();
  });
});
