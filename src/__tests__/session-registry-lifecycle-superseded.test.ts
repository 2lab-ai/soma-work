/**
 * SessionRegistry × user-master lifecycle transaction (#755) — supersede path.
 *
 * Sealed contract (#755 §구현 스펙):
 *   기존 pending entry가 있는데 새 라이프사이클 요청이 들어오면 기존을
 *   `state: 'superseded'`로 lifecycleEvents에 기록 + 새 pending 게시.
 *
 * Stream-executor calls `recordSupersededLifecycle` with the EVICTED entry
 * (not the new request). The data must remain unchanged — only the audit
 * trail expands.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  const fsh = require('node:fs') as typeof import('node:fs');
  const osh = require('node:os') as typeof import('node:os');
  const pathh = require('node:path') as typeof import('node:path');
  const dir = fsh.mkdtempSync(pathh.join(osh.tmpdir(), 'soma-lifecycle-sup-boot-'));
  return { dir };
});

vi.mock('../env-paths', () => ({
  get DATA_DIR() {
    return state.dir;
  },
}));

import { SessionRegistry } from '../session-registry';
import { initUserSessionStore, type UserSessionDoc } from '../user-session-store';

let TEST_DATA_DIR: string;

beforeEach(() => {
  TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-lifecycle-sup-'));
  state.dir = TEST_DATA_DIR;
  initUserSessionStore(TEST_DATA_DIR);
});

afterEach(() => {
  if (TEST_DATA_DIR && fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
});

function userDocPath(userId: string): string {
  return path.join(TEST_DATA_DIR, 'users', userId, 'user-session.json');
}

function readUserDoc(userId: string): UserSessionDoc {
  return JSON.parse(fs.readFileSync(userDocPath(userId), 'utf-8')) as UserSessionDoc;
}

function writeUserDoc(userId: string, doc: UserSessionDoc): void {
  fs.mkdirSync(path.dirname(userDocPath(userId)), { recursive: true });
  fs.writeFileSync(userDocPath(userId), JSON.stringify(doc, null, 2));
}

describe('SessionRegistry.recordSupersededLifecycle — supersede path (#755)', () => {
  it('add → link supersede: pushes lifecycleEvents state="superseded" for the evicted add request', () => {
    const userId = 'U-sup-add';
    const reg = new SessionRegistry();
    const session = reg.createSession(userId, 'Tester', 'C-S', 'T-S');
    session.sessionId = 'sid-sup-add';

    // The evicted (old) request was an `add` — instructionId=null since
    // nothing was committed yet.
    reg.recordSupersededLifecycle(session, {
      requestId: 'req-evicted-add',
      type: 'add',
      by: { type: 'slack-user', id: userId },
      ops: [{ action: 'add', text: 'old proposal that got replaced' }],
    });

    const doc = readUserDoc(userId);
    expect(doc.instructions).toHaveLength(0);

    const audit = doc.lifecycleEvents.find((e) => e.requestId === 'req-evicted-add');
    expect(audit?.op).toBe('add');
    expect(audit?.state).toBe('superseded');
    expect(audit?.instructionId ?? null).toBeNull();
    expect(audit?.by).toEqual({ type: 'slack-user', id: userId });
  });

  it('link supersede: pushes lifecycleEvents state="superseded" with target instructionId', () => {
    const userId = 'U-sup-link';
    writeUserDoc(userId, {
      schemaVersion: 1,
      instructions: [
        {
          id: 'inst-LX',
          text: 'existing',
          status: 'active',
          linkedSessionIds: [],
          createdAt: '2026-04-01T00:00:00.000Z',
          source: 'model',
          sourceRawInputIds: [],
        },
      ],
      lifecycleEvents: [],
    });

    const reg = new SessionRegistry();
    const session = reg.createSession(userId, 'Tester', 'C-S2', 'T-S2');
    session.sessionId = 'sid-sup-link';

    reg.recordSupersededLifecycle(session, {
      requestId: 'req-evicted-link',
      type: 'link',
      by: { type: 'slack-user', id: userId },
      ops: [{ action: 'link', id: 'inst-LX', sessionKey: 'C-S2-T-S2' }],
    });

    const doc = readUserDoc(userId);
    // Data unchanged — supersede MUST be a pure audit, not a mutation.
    expect(doc.instructions[0].linkedSessionIds).toEqual([]);

    const audit = doc.lifecycleEvents.find((e) => e.requestId === 'req-evicted-link');
    expect(audit?.op).toBe('link');
    expect(audit?.state).toBe('superseded');
    expect(audit?.instructionId).toBe('inst-LX');
  });
});
