/**
 * Context rollback (#743) survives a restart: the cut point and a rollback
 * waiting for the next turn are saved and restored; junk is dropped; a reset
 * (`/new`) clears both.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../env-paths', () => ({
  DATA_DIR: require('path').join(process.env.TMPDIR ?? require('os').tmpdir(), 'soma-work-session-registry-rollback'),
}));

import { encodeContextAnchor } from '@soma/slack/context-anchor';
import { SessionRegistry } from '../session-registry';

const TEST_DATA_DIR = path.join(process.env.TMPDIR ?? os.tmpdir(), 'soma-work-session-registry-rollback');
const SID = 'a1b2c3d4-0000-4000-8000-000000000001';
const A = (n: number) =>
  encodeContextAnchor({ sid: SID, epoch: 0, uuid: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` });

describe('SessionRegistry — context rollback fields', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  });
  afterEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  it('saves and restores the anchor and a waiting rollback', () => {
    const writer = new SessionRegistry();
    const s = writer.createSession('U1', 'Tester', 'C1', '171.1');
    s.sessionId = SID;
    s.contextAnchor = A(5);
    s.pendingRewind = {
      anchor: A(2),
      label: '입력 직전: 배포',
      requestedAt: 7,
      requestedBy: 'U1',
      source: 'input',
      keptUntil: 4,
    };
    s.contextRewinds = [{ from: 1, to: 3, label: '입력 직전: 첫 지시', at: 3 }];
    writer.saveSessions();
    const reader = new SessionRegistry();
    reader.loadSessions();
    const r = reader.getSession('C1', '171.1');
    expect(r?.contextAnchor).toBe(A(5));
    expect(r?.pendingRewind).toEqual({
      anchor: A(2),
      label: '입력 직전: 배포',
      requestedAt: 7,
      requestedBy: 'U1',
      source: 'input',
      keptUntil: 4,
    });
    expect(r?.contextRewinds).toEqual([{ from: 1, to: 3, label: '입력 직전: 첫 지시', at: 3 }]);
  });

  it('drops malformed values on load', () => {
    const writer = new SessionRegistry();
    const s = writer.createSession('U1', 'Tester', 'C1', '171.2');
    s.sessionId = SID;
    (s as any).contextAnchor = 'junk';
    (s as any).pendingRewind = { anchor: 'junk', source: 'input' };
    writer.saveSessions();
    const reader = new SessionRegistry();
    reader.loadSessions();
    const r = reader.getSession('C1', '171.2');
    expect(r?.contextAnchor).toBeUndefined();
    expect(r?.pendingRewind).toBeUndefined();
  });

  it('a reset clears both', () => {
    const reg = new SessionRegistry();
    const s = reg.createSession('U1', 'Tester', 'C1', '171.3');
    s.sessionId = SID;
    s.contextAnchor = A(5);
    s.pendingRewind = { anchor: A(2), label: 'x', requestedAt: 7, requestedBy: 'U1', source: 'input' };
    s.contextRewinds = [{ from: 1, to: 3, label: 'x', at: 3 }];
    reg.resetSessionContext('C1', '171.3');
    expect(s.contextAnchor).toBeUndefined();
    expect(s.pendingRewind).toBeUndefined();
    expect(s.contextRewinds).toBeUndefined();
  });
});
