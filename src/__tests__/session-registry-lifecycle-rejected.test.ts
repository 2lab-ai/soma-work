/**
 * SessionRegistry × user-master lifecycle transaction (#755) — n-confirm path.
 *
 * Sealed contract (#755 §구현 스펙):
 *   On n-confirm:
 *     append `lifecycleEvents[]` row state='rejected' + delete pending.
 *     NO data mutation.
 *
 * S8 ("새 세션의 currentInstructionId=null + 안녕 인사말 → 지시로 등록할까요?
 * → n → add 이벤트가 lifecycleEvents에 state:'rejected'로 기록됨") is
 * pinned here. The non-add rejected path (link/complete/cancel/rename
 * said no) is also covered so the dashboard drilldown shows the
 * abandoned intent on the original target id.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  const fsh = require('node:fs') as typeof import('node:fs');
  const osh = require('node:os') as typeof import('node:os');
  const pathh = require('node:path') as typeof import('node:path');
  const dir = fsh.mkdtempSync(pathh.join(osh.tmpdir(), 'soma-lifecycle-rejected-boot-'));
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
  TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-lifecycle-rejected-'));
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

describe('SessionRegistry.recordRejectedLifecycle — n-confirm (#755 S8)', () => {
  it('S8: add reject — pushes lifecycleEvents state="rejected" with instructionId=null, no data mutation', () => {
    const userId = 'U-S8';
    const reg = new SessionRegistry();
    const session = reg.createSession(userId, 'Tester', 'C-G', 'T-G');
    session.sessionId = 'sid-S8';

    reg.recordRejectedLifecycle(session, {
      requestId: 'req-S8',
      type: 'add',
      by: { type: 'slack-user', id: userId },
      ops: [{ action: 'add', text: '안녕' }],
    });

    const doc = readUserDoc(userId);
    expect(doc.instructions).toHaveLength(0);

    const audit = doc.lifecycleEvents.find((e) => e.requestId === 'req-S8');
    expect(audit?.op).toBe('add');
    expect(audit?.state).toBe('rejected');
    expect(audit?.instructionId ?? null).toBeNull();
    expect(audit?.by).toEqual({ type: 'slack-user', id: userId });

    expect(session.currentInstructionId ?? null).toBeNull();
  });

  it('cancel reject — pushes state="rejected" with instructionId=target, instruction stays active', () => {
    const userId = 'U-rej-cancel';
    writeUserDoc(userId, {
      schemaVersion: 1,
      instructions: [
        {
          id: 'inst-K',
          text: 'keep going',
          status: 'active',
          linkedSessionIds: ['C-K-T-K'],
          createdAt: '2026-04-01T00:00:00.000Z',
          source: 'model',
          sourceRawInputIds: [],
        },
      ],
      lifecycleEvents: [],
    });

    const reg = new SessionRegistry();
    const session = reg.createSession(userId, 'Tester', 'C-K', 'T-K');
    session.sessionId = 'sid-rej-cancel';
    session.currentInstructionId = 'inst-K';

    reg.recordRejectedLifecycle(session, {
      requestId: 'req-rej-cancel',
      type: 'cancel',
      by: { type: 'slack-user', id: userId },
      ops: [{ action: 'cancel', id: 'inst-K' }],
    });

    const doc = readUserDoc(userId);
    expect(doc.instructions[0].status).toBe('active');
    expect(doc.instructions[0].cancelledAt).toBeUndefined();

    const audit = doc.lifecycleEvents.find((e) => e.requestId === 'req-rej-cancel');
    expect(audit?.op).toBe('cancel');
    expect(audit?.state).toBe('rejected');
    expect(audit?.instructionId).toBe('inst-K');

    // Pointer untouched — user said no, the instruction stays current.
    expect(session.currentInstructionId).toBe('inst-K');
  });
});
