import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `vi.mock` is hoisted — keep the path computation inside the factory.
vi.mock('../env-paths', () => ({
  DATA_DIR: require('path').join(process.env.TMPDIR ?? require('os').tmpdir(), 'soma-work-session-registry-safeguard'),
}));

import { SessionRegistry } from '../session-registry';

const TEST_DATA_DIR = path.join(process.env.TMPDIR ?? os.tmpdir(), 'soma-work-session-registry-safeguard');

/**
 * ssot-task: T2 · T3 — a restart must not unlock a session the safeguards
 * stopped. The lock is the only thing standing between a non-admin (or the
 * restart's own goal resume) and the blocked session.
 */
describe('SessionRegistry — safeguardHalt survives a restart', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  it('saves and restores the halt', () => {
    const writer = new SessionRegistry();
    const session = writer.createSession('U1', 'Tester', 'C1', '171.501');
    session.sessionId = 'sdk-A';
    session.safeguardHalt = {
      atMs: 1_793_752_964_388,
      model: 'Opus 5.5 (1M context)',
      detail: 'reasoning_extraction',
      requestId: 'req_011CggxYZxQ7TEBU95XW3X19',
      messageId: 'msg_011CggxYckLHkHA9sUKftEWG',
    };
    writer.saveSessions();

    const reader = new SessionRegistry();
    reader.loadSessions();
    expect(reader.getSession('C1', '171.501')?.safeguardHalt).toEqual(session.safeguardHalt);
  });

  it('a session without a halt restores without one', () => {
    const writer = new SessionRegistry();
    const session = writer.createSession('U1', 'Tester', 'C1', '171.502');
    session.sessionId = 'sdk-B';
    writer.saveSessions();

    const reader = new SessionRegistry();
    reader.loadSessions();
    expect(reader.getSession('C1', '171.502')?.safeguardHalt).toBeUndefined();
  });

  it('drops a malformed halt (no atMs) instead of locking on garbage', () => {
    const writer = new SessionRegistry();
    const session = writer.createSession('U1', 'Tester', 'C1', '171.503');
    session.sessionId = 'sdk-C';
    (session as any).safeguardHalt = { detail: 'x' };
    writer.saveSessions();

    const reader = new SessionRegistry();
    reader.loadSessions();
    expect(reader.getSession('C1', '171.503')?.safeguardHalt).toBeUndefined();
  });
});
