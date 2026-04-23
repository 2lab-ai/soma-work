import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

  it('backfills effort from user default on legacy sessions without effort field', () => {
    // Simulate a sessions.json written before the effort field existed. Without
    // backfill, the restored session would have effort=undefined and the handler
    // would fall through to the SDK internal default instead of the app's
    // DEFAULT_EFFORT ('xhigh'). See review finding on PR #527 (risk vector P3).
    const sessionsFile = `${TEST_DATA_DIR}/sessions.json`;
    fs.writeFileSync(
      sessionsFile,
      JSON.stringify(
        [
          {
            key: 'C-legacy-170.000',
            ownerId: 'U-legacy',
            userId: 'U-legacy',
            channelId: 'C-legacy',
            threadTs: '170.000',
            sessionId: 'legacy-session-1',
            isActive: true,
            lastActivity: new Date().toISOString(),
            state: 'MAIN',
            workflow: 'default',
            // effort deliberately omitted to mimic legacy payload
          },
        ],
        null,
        2,
      ),
    );

    const reader = new SessionRegistry();
    const loaded = reader.loadSessions();
    const restored = reader.getSession('C-legacy', '170.000');

    // Sanity: the session must actually be loaded (not filtered out by age).
    expect(loaded).toBe(1);
    expect(restored).toBeDefined();
    // DEFAULT_EFFORT is 'xhigh' per user-settings-store; user has no stored
    // effort override so legacy restore should backfill to that default.
    expect(restored?.effort).toBe('xhigh');
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
    const oldFormatSessions = [
      {
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
      },
    ];
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
    const maliciousSessions = [
      {
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
      },
    ];
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

  // === Issue #391: Preserve activityState on restart ===

  it('preserves working activityState across save/load', () => {
    const writer = new SessionRegistry();
    const session = writer.createSession('U123', 'Tester', 'C391', '171.391a');
    session.sessionId = 'session-391a';
    session.activityState = 'working';
    session.state = 'MAIN';

    writer.saveSessions();

    const reader = new SessionRegistry();
    reader.loadSessions();
    const restored = reader.getSession('C391', '171.391a');

    expect(restored).toBeDefined();
    expect(restored!.activityState).toBe('working');
  });

  it('preserves waiting activityState across save/load', () => {
    const writer = new SessionRegistry();
    const session = writer.createSession('U123', 'Tester', 'C391', '171.391b');
    session.sessionId = 'session-391b';
    session.activityState = 'waiting';
    session.state = 'MAIN';

    writer.saveSessions();

    const reader = new SessionRegistry();
    reader.loadSessions();
    const restored = reader.getSession('C391', '171.391b');

    expect(restored).toBeDefined();
    expect(restored!.activityState).toBe('waiting');
  });

  it('defaults to idle when activityState is missing from serialized data', () => {
    const fs = require('fs');
    const path = require('path');
    const sessionsData = [
      {
        key: 'C391-171.391c',
        ownerId: 'U123',
        ownerName: 'Tester',
        channelId: 'C391',
        threadTs: '171.391c',
        sessionId: 'session-391c',
        isActive: true,
        lastActivity: new Date().toISOString(),
        state: 'MAIN',
        // NO activityState field — legacy format
      },
    ];
    fs.writeFileSync(path.join(TEST_DATA_DIR, 'sessions.json'), JSON.stringify(sessionsData));

    const reader = new SessionRegistry();
    reader.loadSessions();
    const restored = reader.getSession('C391', '171.391c');

    expect(restored).toBeDefined();
    expect(restored!.activityState).toBe('idle');
  });

  it('crash recovery still detects working sessions after activityState preservation', () => {
    const writer = new SessionRegistry();
    const session = writer.createSession('U123', 'Tester', 'C391', '171.391d');
    session.sessionId = 'session-391d';
    session.activityState = 'working';
    session.state = 'MAIN';

    writer.saveSessions();

    const reader = new SessionRegistry();
    reader.loadSessions();

    const recovered = reader.getCrashRecoveredSessions();
    expect(recovered.length).toBe(1);
    expect(recovered[0].activityState).toBe('working');
    expect(recovered[0].sessionKey).toBe('C391-171.391d');
  });
});

describe('SessionRegistry session-scoped dangerous-rule overrides', () => {
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

  it('records a single disabled rule per session', () => {
    const reg = new SessionRegistry();
    reg.createSession('U1', 'Tester', 'C1', '171.100');
    const key = reg.getSessionKey('C1', '171.100');

    expect(reg.isDangerousRuleDisabled(key, 'kill')).toBe(false);
    reg.disableDangerousRule(key, 'kill');
    expect(reg.isDangerousRuleDisabled(key, 'kill')).toBe(true);
    expect(reg.isDangerousRuleDisabled(key, 'reboot')).toBe(false);
    expect(reg.listDisabledDangerousRules(key)).toEqual(['kill']);
  });

  it('batch-disables multiple rules atomically', () => {
    const reg = new SessionRegistry();
    reg.createSession('U1', 'Tester', 'C2', '171.101');
    const key = reg.getSessionKey('C2', '171.101');

    reg.disableDangerousRules(key, ['kill', 'rm-recursive', 'rm-force']);
    expect(reg.isDangerousRuleDisabled(key, 'kill')).toBe(true);
    expect(reg.isDangerousRuleDisabled(key, 'rm-recursive')).toBe(true);
    expect(reg.isDangerousRuleDisabled(key, 'rm-force')).toBe(true);
    expect(reg.listDisabledDangerousRules(key).sort()).toEqual(['kill', 'rm-force', 'rm-recursive']);
  });

  it('disable is idempotent (same rule twice = one entry)', () => {
    const reg = new SessionRegistry();
    reg.createSession('U1', 'Tester', 'C3', '171.102');
    const key = reg.getSessionKey('C3', '171.102');

    reg.disableDangerousRule(key, 'kill');
    reg.disableDangerousRule(key, 'kill');
    expect(reg.listDisabledDangerousRules(key)).toEqual(['kill']);
  });

  it('disables are isolated between sessions', () => {
    const reg = new SessionRegistry();
    reg.createSession('U1', 'Tester', 'C4', '171.103');
    reg.createSession('U1', 'Tester', 'C4', '171.104');
    const keyA = reg.getSessionKey('C4', '171.103');
    const keyB = reg.getSessionKey('C4', '171.104');

    reg.disableDangerousRule(keyA, 'kill');
    expect(reg.isDangerousRuleDisabled(keyA, 'kill')).toBe(true);
    expect(reg.isDangerousRuleDisabled(keyB, 'kill')).toBe(false);
  });

  it('no-op on unknown session key (safe side — still returns false)', () => {
    const reg = new SessionRegistry();
    reg.disableDangerousRule('C-unknown-171.999', 'kill');
    expect(reg.isDangerousRuleDisabled('C-unknown-171.999', 'kill')).toBe(false);
    expect(reg.listDisabledDangerousRules('C-unknown-171.999')).toEqual([]);
  });

  it('disabledDangerousRules is NOT persisted across save/load (in-memory only)', () => {
    const writer = new SessionRegistry();
    const session = writer.createSession('U1', 'Tester', 'C5', '171.105');
    // saveSessions() only serialises sessions with a sessionId — set one so the
    // persistence path actually runs (otherwise we'd be testing nothing).
    session.sessionId = 'session-rule-disable-roundtrip';
    const key = writer.getSessionKey('C5', '171.105');
    writer.disableDangerousRule(key, 'kill');
    writer.disableDangerousRule(key, 'reboot');

    writer.saveSessions();

    const reader = new SessionRegistry();
    reader.loadSessions();
    expect(reader.isDangerousRuleDisabled(key, 'kill')).toBe(false);
    expect(reader.isDangerousRuleDisabled(key, 'reboot')).toBe(false);
    expect(reader.listDisabledDangerousRules(key)).toEqual([]);
  });
});

// --- Issue #656: coerceToAvailableModel on deserialize ---

describe('SessionRegistry deserialize — model coerce', () => {
  const SESSIONS_FILE = `${TEST_DATA_DIR}/sessions.json`;

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

  function writeSessionsFile(sessions: Array<Record<string, unknown>>): void {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2), 'utf8');
  }

  it('passes known [1m] model id through unchanged', () => {
    const now = new Date().toISOString();
    writeSessionsFile([
      {
        key: 'C1-t1',
        ownerId: 'U1',
        userId: 'U1',
        channelId: 'C1',
        threadTs: 't1',
        sessionId: 's1',
        isActive: true,
        lastActivity: now,
        model: 'claude-opus-4-7[1m]',
        state: 'MAIN',
        workflow: 'default',
      },
    ]);

    const reader = new SessionRegistry();
    reader.loadSessions();
    const restored = reader.getSession('C1', 't1');
    expect(restored?.model).toBe('claude-opus-4-7[1m]');
  });

  it('lowercases uppercase [1M] on restore', () => {
    const now = new Date().toISOString();
    writeSessionsFile([
      {
        key: 'C1-t2',
        ownerId: 'U1',
        userId: 'U1',
        channelId: 'C1',
        threadTs: 't2',
        sessionId: 's2',
        isActive: true,
        lastActivity: now,
        model: 'claude-opus-4-7[1M]',
        state: 'MAIN',
        workflow: 'default',
      },
    ]);

    const reader = new SessionRegistry();
    reader.loadSessions();
    const restored = reader.getSession('C1', 't2');
    expect(restored?.model).toBe('claude-opus-4-7[1m]');
  });

  it('preserves legacy sonnet-4-6 (not force-migrated to DEFAULT)', () => {
    // Regression guard for PR #652-style silent drop: sonnet users stay on sonnet.
    const now = new Date().toISOString();
    writeSessionsFile([
      {
        key: 'C1-t3',
        ownerId: 'U1',
        userId: 'U1',
        channelId: 'C1',
        threadTs: 't3',
        sessionId: 's3',
        isActive: true,
        lastActivity: now,
        model: 'claude-sonnet-4-6',
        state: 'MAIN',
        workflow: 'default',
      },
    ]);

    const reader = new SessionRegistry();
    reader.loadSessions();
    const restored = reader.getSession('C1', 't3');
    expect(restored?.model).toBe('claude-sonnet-4-6');
  });

  it('coerces unknown model ids to DEFAULT_MODEL', () => {
    const now = new Date().toISOString();
    writeSessionsFile([
      {
        key: 'C1-t4',
        ownerId: 'U1',
        userId: 'U1',
        channelId: 'C1',
        threadTs: 't4',
        sessionId: 's4',
        isActive: true,
        lastActivity: now,
        model: 'gpt-99-turbo',
        state: 'MAIN',
        workflow: 'default',
      },
    ]);

    const reader = new SessionRegistry();
    reader.loadSessions();
    const restored = reader.getSession('C1', 't4');
    expect(restored?.model).toBe('claude-opus-4-7'); // DEFAULT_MODEL
  });

  it('preserves undefined when session was saved without a model', () => {
    // Behavior parity guard: before coerce was added, undefined model stayed
    // undefined. We explicitly preserve that so the downstream "no model yet"
    // code paths are unchanged.
    const now = new Date().toISOString();
    writeSessionsFile([
      {
        key: 'C1-t5',
        ownerId: 'U1',
        userId: 'U1',
        channelId: 'C1',
        threadTs: 't5',
        sessionId: 's5',
        isActive: true,
        lastActivity: now,
        state: 'MAIN',
        workflow: 'default',
        // No model field.
      },
    ]);

    const reader = new SessionRegistry();
    reader.loadSessions();
    const restored = reader.getSession('C1', 't5');
    expect(restored).toBeDefined();
    expect(restored?.model).toBeUndefined();
  });
});

describe('persistAndBroadcast', () => {
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

  it('calls saveSessions + broadcast callback exactly once', () => {
    const registry = new SessionRegistry();
    const savesSpy = vi.spyOn(registry, 'saveSessions');
    const broadcasts: number[] = [];
    registry.setActivityStateChangeCallback(() => broadcasts.push(Date.now()));
    registry.persistAndBroadcast('chan:thr');
    expect(savesSpy).toHaveBeenCalledTimes(1);
    expect(broadcasts.length).toBe(1);
  });

  it('swallows broadcast callback errors and still saves', () => {
    const registry = new SessionRegistry();
    const savesSpy = vi.spyOn(registry, 'saveSessions');
    registry.setActivityStateChangeCallback(() => {
      throw new Error('broadcast boom');
    });
    expect(() => registry.persistAndBroadcast('chan:thr')).not.toThrow();
    expect(savesSpy).toHaveBeenCalledTimes(1);
  });
});

describe('invalidateSystemPromptForUser', () => {
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

  it('clears systemPrompt only on sessions owned by the target user', () => {
    const registry = new SessionRegistry();
    const mine1 = registry.createSession('U-alice', 'alice', 'C1', 't1');
    mine1.systemPrompt = 'cached-1';
    const mine2 = registry.createSession('U-alice', 'alice', 'C2', 't2');
    mine2.systemPrompt = 'cached-2';
    const theirs = registry.createSession('U-bob', 'bob', 'C3', 't3');
    theirs.systemPrompt = 'cached-bob';

    const count = registry.invalidateSystemPromptForUser('U-alice');
    expect(count).toBe(2);
    expect(mine1.systemPrompt).toBeUndefined();
    expect(mine2.systemPrompt).toBeUndefined();
    // Other-user sessions untouched.
    expect(theirs.systemPrompt).toBe('cached-bob');
  });

  it('returns 0 for an unknown userId or empty string (no-op)', () => {
    const registry = new SessionRegistry();
    const s = registry.createSession('U-alice', 'alice', 'C1', 't1');
    s.systemPrompt = 'cached';

    expect(registry.invalidateSystemPromptForUser('U-ghost')).toBe(0);
    expect(registry.invalidateSystemPromptForUser('')).toBe(0);
    expect(s.systemPrompt).toBe('cached');
  });
});
