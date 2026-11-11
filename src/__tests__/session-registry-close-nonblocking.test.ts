/**
 * Closing a task card froze the whole server (SSOT 2026-11-10 T1: "닫기 누르면 너무 오래 걸림 … 지금은 전체가 다
 * 멈추는 느낌임"). terminateSession deleted the session's working folders with fs.rmSync(recursive) — a repo clone
 * with its node_modules is tens of thousands of files, and the delete held Node's one event loop for seconds: every
 * dashboard request, WebSocket and Slack event waited behind it.
 *
 * Now the folder leaves its path at once (one rename) and its tree is deleted in the background:
 *   C1  right after terminateSession returns, the folder is gone from its path
 *   C2  …and its files have not been deleted yet — they wait under a sibling name (the delete is not on this tick)
 *   C3  the background delete removes them
 *   C4  the sleep sweep (the other caller) gets the same: the path is gone at once, the tree goes after
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../env-paths', () => ({
  DATA_DIR: '/tmp/soma-work-close-nonblocking-test',
}));

import { SessionRegistry } from '../session-registry';

const TEST_DATA_DIR = '/tmp/soma-work-close-nonblocking-test';
const TEST_WORKING_DIR = '/tmp/soma-work-close-nonblocking-dirs';

/** The parked copies of `name` waiting for their background delete. */
function parked(name: string): string[] {
  return fs.readdirSync(TEST_WORKING_DIR).filter((f) => f !== name && f.startsWith(`.${name}.removing-`));
}

/** A small clone-shaped tree: a few nested folders with files. */
function makeTree(dir: string): void {
  for (const sub of ['src', 'node_modules/a/lib', 'node_modules/b']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(dir, sub, `f${i}.js`), 'x');
  }
}

describe('closing a session never deletes its folders on the event loop (SSOT 2026-11-10 T1)', () => {
  let registry: SessionRegistry;

  beforeEach(() => {
    for (const d of [TEST_DATA_DIR, TEST_WORKING_DIR]) {
      fs.rmSync(d, { recursive: true, force: true });
      fs.mkdirSync(d, { recursive: true });
    }
    registry = new SessionRegistry();
    const session = registry.createSession('U001', 'Tester', 'C001', '100.001');
    session.sessionId = 'test-session-1';
    session.state = 'MAIN';
  });

  afterEach(() => {
    for (const d of [TEST_DATA_DIR, TEST_WORKING_DIR]) fs.rmSync(d, { recursive: true, force: true });
  });

  it('C1–C3 — terminate: the path is gone at once, the files go in the background', async () => {
    const dir = path.join(TEST_WORKING_DIR, 'repo-clone');
    makeTree(dir);
    expect(registry.addSourceWorkingDir('C001', '100.001', dir)).toBe(true);

    expect(registry.terminateSession('C001-100.001')).toBe(true);

    // C1 — gone from its path the moment terminate returns.
    expect(fs.existsSync(dir)).toBe(false);
    // C2 — not deleted on this tick: the tree waits, whole, under a parked sibling name.
    const waiting = parked('repo-clone');
    expect(waiting).toHaveLength(1);
    expect(fs.existsSync(path.join(TEST_WORKING_DIR, waiting[0], 'node_modules', 'a', 'lib', 'f0.js'))).toBe(true);
    // C3 — the background delete removes it.
    await vi.waitFor(() => expect(parked('repo-clone')).toHaveLength(0), { timeout: 5000, interval: 20 });
  });

  it('C4 — the sleep sweep: the path is gone at once, the files go in the background', async () => {
    const dir = path.join(TEST_WORKING_DIR, 'sleepy-clone');
    makeTree(dir);
    expect(registry.addSourceWorkingDir('C001', '100.001', dir)).toBe(true);
    const session = registry.getSession('C001', '100.001');
    if (!session) throw new Error('no session');
    session.lastActivity = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);

    const sweep = registry.cleanupInactiveSessions(1);
    expect(fs.existsSync(dir)).toBe(false);
    expect(parked('sleepy-clone')).toHaveLength(1);
    await sweep;
    await vi.waitFor(() => expect(parked('sleepy-clone')).toHaveLength(0), { timeout: 5000, interval: 20 });
    expect(session.sourceWorkingDirs ?? []).toEqual([]);
  });
});
