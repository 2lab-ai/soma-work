/**
 * #1072 — when a session started waiting on its user survives a restart.
 *
 * The registry wrote sessions.json on the switch to `idle` only, so the switch
 * to `waiting` (a question asked) lived in memory: a restart read back the
 * stamp of an older save and the board's 응답 필요 card and the Slack head
 * counted the wait from the wrong time. The switch to `waiting` is saved now.
 * A second question while the session already waits keeps the first stamp, and
 * the person's answer (back to `working`) ends the wait.
 */
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_DIR = '/tmp/soma-work-session-waiting-persist-test';

vi.mock(import('../env-paths'), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, DATA_DIR: '/tmp/soma-work-session-waiting-persist-test' };
});

import { SessionRegistry } from '../session-registry';

const T0 = Date.parse('2026-11-09T09:00:00Z');
const MINUTE = 60_000;

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

/** A saved idle session, then a turn: `working` (never written by itself), then `waiting` at T0 + 5 min. */
function askedQuestion(set: (r: SessionRegistry, state: 'working' | 'waiting' | 'idle') => void) {
  const writer = new SessionRegistry();
  const session = writer.createSession('U1', 'Tester', 'C1', '171.001');
  session.sessionId = 'sess-1';
  writer.saveSessions();
  vi.setSystemTime(T0 + 1 * MINUTE);
  set(writer, 'working');
  vi.setSystemTime(T0 + 5 * MINUTE);
  set(writer, 'waiting');
  return writer;
}

function restart() {
  const reader = new SessionRegistry();
  reader.loadSessions();
  return reader.getSession('C1', '171.001');
}

describe('#1072 — the switch to waiting is saved', () => {
  it('setActivityState: a restart reads back waiting and the same stamp', () => {
    askedQuestion((r, state) => r.setActivityState('C1', '171.001', state));
    vi.setSystemTime(T0 + 60 * MINUTE); // the restart comes later
    const restored = restart();
    expect(restored?.activityState).toBe('waiting');
    expect(restored?.activityStateChangedAt).toBe(T0 + 5 * MINUTE);
  });

  it('setActivityStateByKey: the same', () => {
    askedQuestion((r, state) => r.setActivityStateByKey(r.getSessionKey('C1', '171.001'), state));
    const restored = restart();
    expect(restored?.activityState).toBe('waiting');
    expect(restored?.activityStateChangedAt).toBe(T0 + 5 * MINUTE);
  });

  it('a new question while it waits keeps the first stamp, in memory and on disk', () => {
    const writer = askedQuestion((r, state) => r.setActivityState('C1', '171.001', state));
    vi.setSystemTime(T0 + 20 * MINUTE);
    writer.setActivityState('C1', '171.001', 'waiting');
    expect(writer.getSession('C1', '171.001')?.activityStateChangedAt).toBe(T0 + 5 * MINUTE);
    writer.saveSessions();
    expect(restart()?.activityStateChangedAt).toBe(T0 + 5 * MINUTE);
  });

  it('the answer ends the wait: back to working, the stamp is the answer (the board counts no wait from it)', () => {
    const writer = askedQuestion((r, state) => r.setActivityState('C1', '171.001', state));
    vi.setSystemTime(T0 + 9 * MINUTE);
    writer.setActivityState('C1', '171.001', 'working');
    const live = writer.getSession('C1', '171.001')!;
    expect(live.activityState).toBe('working');
    // dashboard liveWaitingSince ignores a working stamp (dashboard-live-surfaces.test.ts, spec 13 §3.7).
    expect(live.activityStateChangedAt).toBe(T0 + 9 * MINUTE);
  });

  it('working alone is still not written (only waiting and idle are)', () => {
    const writer = new SessionRegistry();
    const session = writer.createSession('U1', 'Tester', 'C1', '171.001');
    session.sessionId = 'sess-1';
    writer.saveSessions();
    vi.setSystemTime(T0 + 1 * MINUTE);
    writer.setActivityState('C1', '171.001', 'working');
    expect(restart()?.activityState).toBe('idle');
  });
});
