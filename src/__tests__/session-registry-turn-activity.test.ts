import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// `vi.mock` is hoisted — keep the path computation inside the factory.
vi.mock('../env-paths', () => ({
  DATA_DIR: require('path').join(
    process.env.TMPDIR ?? require('os').tmpdir(),
    'soma-work-session-registry-turn-activity',
  ),
}));

import { SessionRegistry } from '../session-registry';

const TEST_DATA_DIR = path.join(process.env.TMPDIR ?? os.tmpdir(), 'soma-work-session-registry-turn-activity');

/**
 * .prd/39 S1 — the turn occupancy hears every activity report of the turn runtime, a repeat included, and nothing
 * else: a value loaded from disk or written straight onto the session is no report.
 */
describe('SessionRegistry — turn activity reports', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  });

  it('reports both setters to every listener, repeats included', () => {
    const registry = new SessionRegistry();
    registry.createSession('U1', 'Tester', 'C1', '111.222');
    const key = registry.getSessionKey('C1', '111.222');
    const heard: Array<[string, string]> = [];
    registry.addTurnActivityListener((k, state) => heard.push([k, state]));

    registry.setActivityState('C1', '111.222', 'working');
    registry.setActivityState('C1', '111.222', 'working'); // a repeat: no transition, still a report
    registry.setActivityStateByKey(key, 'idle');
    registry.setActivityStateByKey(key, 'idle');

    expect(heard).toEqual([
      [key, 'working'],
      [key, 'working'],
      [key, 'idle'],
      [key, 'idle'],
    ]);
  });

  it('stops reporting after unsubscribe, and a throwing listener does not stop the transition', () => {
    const registry = new SessionRegistry();
    const session = registry.createSession('U1', 'Tester', 'C1', '111.333');
    const heard: string[] = [];
    const off = registry.addTurnActivityListener((_k, state) => heard.push(state));
    registry.addTurnActivityListener(() => {
      throw new Error('listener bug');
    });

    registry.setActivityState('C1', '111.333', 'working');
    expect(session.activityState).toBe('working');
    off();
    registry.setActivityState('C1', '111.333', 'idle');

    expect(heard).toEqual(['working']);
    expect(session.activityState).toBe('idle');
  });

  it('reports nothing for a session it does not hold, and nothing for a loaded value', () => {
    const writer = new SessionRegistry();
    const s = writer.createSession('U1', 'Tester', 'C1', '111.444');
    s.sessionId = 'sdk-1';
    s.activityState = 'working';
    writer.saveSessions();

    const reader = new SessionRegistry();
    const heard: string[] = [];
    reader.addTurnActivityListener((_k, state) => heard.push(state));
    reader.loadSessions();
    reader.setActivityState('C9', '999.999', 'working');

    expect(heard).toEqual([]);
  });
});
