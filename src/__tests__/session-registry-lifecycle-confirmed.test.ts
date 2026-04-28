/**
 * SessionRegistry × user-master lifecycle transaction (#755) — y-confirm path.
 *
 * Sealed contract (#727 / #755):
 *
 *   On y-confirm (model proposed → user clicked Yes):
 *     ONE tx mutates BOTH user master and session pointer:
 *       (1) user store: instructions[] op + linkedSessionIds bookkeeping
 *       (2) session   : currentInstructionId + instructionHistory
 *       (3) user store: append lifecycleEvents[] row, state='confirmed'
 *
 * S1 (add), S2 (link), S4 (cancel) scenarios from the #755 검수 표 are
 * pinned here, plus complete/rename happy paths covering the remaining
 * sealed ops.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  const fsh = require('node:fs') as typeof import('node:fs');
  const osh = require('node:os') as typeof import('node:os');
  const pathh = require('node:path') as typeof import('node:path');
  const dir = fsh.mkdtempSync(pathh.join(osh.tmpdir(), 'soma-lifecycle-confirmed-boot-'));
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
  TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-lifecycle-confirmed-'));
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

describe('SessionRegistry.applyConfirmedLifecycle — y-confirm one-transaction', () => {
  it('S1: add — appends instruction to user master, sets session.currentInstructionId, audits state="confirmed"', () => {
    const userId = 'U-S1';
    const reg = new SessionRegistry();
    const session = reg.createSession(userId, 'Tester', 'C1', 'T1');
    session.sessionId = 'sid-S1';
    const sessionKey = reg.getSessionKey('C1', 'T1');

    const result = reg.applyConfirmedLifecycle(session, {
      requestId: 'req-S1',
      type: 'add',
      by: { type: 'slack-user', id: userId },
      ops: [{ action: 'add', text: 'lint 경고 하나 고쳐줘' }],
    });

    expect(result.ok).toBe(true);
    expect(result.instructionId).toBeDefined();

    const doc = readUserDoc(userId);
    expect(doc.instructions).toHaveLength(1);
    expect(doc.instructions[0].text).toBe('lint 경고 하나 고쳐줘');
    expect(doc.instructions[0].source).toBe('model');
    expect(doc.instructions[0].linkedSessionIds).toContain(sessionKey);

    expect(session.currentInstructionId).toBe(doc.instructions[0].id);
    expect(session.instructionHistory).toContain(doc.instructions[0].id);

    const audit = doc.lifecycleEvents.find((e) => e.requestId === 'req-S1');
    expect(audit).toBeDefined();
    expect(audit?.op).toBe('add');
    expect(audit?.state).toBe('confirmed');
    expect(audit?.by).toEqual({ type: 'slack-user', id: userId });
    expect(audit?.instructionId).toBe(doc.instructions[0].id);
  });

  it('S2: link — appends sessionKey to existing instruction, sets currentInstructionId, audits op="link"', () => {
    const userId = 'U-S2';
    writeUserDoc(userId, {
      schemaVersion: 1,
      instructions: [
        {
          id: 'inst-I3',
          text: '검색 페이지 UX 개선',
          status: 'active',
          linkedSessionIds: ['C-B-T-B'],
          createdAt: '2026-04-01T00:00:00.000Z',
          source: 'model',
          sourceRawInputIds: [],
        },
      ],
      lifecycleEvents: [],
    });

    const reg = new SessionRegistry();
    const session = reg.createSession(userId, 'Tester', 'C-D', 'T-D');
    session.sessionId = 'sid-S2';
    const sessionKey = reg.getSessionKey('C-D', 'T-D');

    const result = reg.applyConfirmedLifecycle(session, {
      requestId: 'req-S2',
      type: 'link',
      by: { type: 'slack-user', id: userId },
      ops: [{ action: 'link', id: 'inst-I3', sessionKey }],
    });

    expect(result.ok).toBe(true);
    expect(result.instructionId).toBe('inst-I3');

    const doc = readUserDoc(userId);
    expect(doc.instructions[0].linkedSessionIds).toContain('C-B-T-B');
    expect(doc.instructions[0].linkedSessionIds).toContain(sessionKey);
    expect(session.currentInstructionId).toBe('inst-I3');
    expect(session.instructionHistory).toContain('inst-I3');

    const audit = doc.lifecycleEvents.find((e) => e.requestId === 'req-S2');
    expect(audit?.op).toBe('link');
    expect(audit?.state).toBe('confirmed');
  });

  it('S4: cancel — flips status=cancelled, nulls currentInstructionId, audits op="cancel"', () => {
    const userId = 'U-S4';
    writeUserDoc(userId, {
      schemaVersion: 1,
      instructions: [
        {
          id: 'inst-I7',
          text: '큰 작업',
          status: 'active',
          linkedSessionIds: ['C-F-T-F'],
          createdAt: '2026-04-01T00:00:00.000Z',
          source: 'model',
          sourceRawInputIds: [],
        },
      ],
      lifecycleEvents: [],
    });

    const reg = new SessionRegistry();
    const session = reg.createSession(userId, 'Tester', 'C-F', 'T-F');
    session.sessionId = 'sid-S4';
    session.currentInstructionId = 'inst-I7';

    const result = reg.applyConfirmedLifecycle(session, {
      requestId: 'req-S4',
      type: 'cancel',
      by: { type: 'slack-user', id: userId },
      ops: [{ action: 'cancel', id: 'inst-I7' }],
    });

    expect(result.ok).toBe(true);

    const doc = readUserDoc(userId);
    expect(doc.instructions[0].status).toBe('cancelled');
    expect(typeof doc.instructions[0].cancelledAt).toBe('string');
    expect(session.currentInstructionId ?? null).toBeNull();

    const audit = doc.lifecycleEvents.find((e) => e.requestId === 'req-S4');
    expect(audit?.op).toBe('cancel');
    expect(audit?.state).toBe('confirmed');
  });

  it('complete — flips status=completed, nulls currentInstructionId, payload carries evidence', () => {
    const userId = 'U-complete';
    writeUserDoc(userId, {
      schemaVersion: 1,
      instructions: [
        {
          id: 'inst-I1',
          text: 'lint fix',
          status: 'active',
          linkedSessionIds: ['C-A-T-A'],
          createdAt: '2026-04-01T00:00:00.000Z',
          source: 'model',
          sourceRawInputIds: [],
        },
      ],
      lifecycleEvents: [],
    });

    const reg = new SessionRegistry();
    const session = reg.createSession(userId, 'Tester', 'C-A', 'T-A');
    session.sessionId = 'sid-complete';
    session.currentInstructionId = 'inst-I1';

    const result = reg.applyConfirmedLifecycle(session, {
      requestId: 'req-complete',
      type: 'complete',
      by: { type: 'slack-user', id: userId },
      ops: [{ action: 'complete', id: 'inst-I1', evidence: 'merged PR #42' }],
    });

    expect(result.ok).toBe(true);

    const doc = readUserDoc(userId);
    expect(doc.instructions[0].status).toBe('completed');
    expect(typeof doc.instructions[0].completedAt).toBe('string');
    expect(session.currentInstructionId ?? null).toBeNull();

    const audit = doc.lifecycleEvents.find((e) => e.requestId === 'req-complete');
    expect(audit?.op).toBe('complete');
    expect(audit?.state).toBe('confirmed');
    expect((audit?.payload as { evidence?: string } | undefined)?.evidence).toBe('merged PR #42');
  });

  it('rename — updates text only, currentInstructionId preserved, audits op="rename"', () => {
    const userId = 'U-rename';
    writeUserDoc(userId, {
      schemaVersion: 1,
      instructions: [
        {
          id: 'inst-R',
          text: 'old name',
          status: 'active',
          linkedSessionIds: ['C-R-T-R'],
          createdAt: '2026-04-01T00:00:00.000Z',
          source: 'model',
          sourceRawInputIds: [],
        },
      ],
      lifecycleEvents: [],
    });

    const reg = new SessionRegistry();
    const session = reg.createSession(userId, 'Tester', 'C-R', 'T-R');
    session.sessionId = 'sid-rename';
    session.currentInstructionId = 'inst-R';

    const result = reg.applyConfirmedLifecycle(session, {
      requestId: 'req-rename',
      type: 'rename',
      by: { type: 'slack-user', id: userId },
      ops: [{ action: 'rename', id: 'inst-R', text: 'new name' }],
    });

    expect(result.ok).toBe(true);

    const doc = readUserDoc(userId);
    expect(doc.instructions[0].text).toBe('new name');
    expect(doc.instructions[0].status).toBe('active');
    expect(session.currentInstructionId).toBe('inst-R');

    const audit = doc.lifecycleEvents.find((e) => e.requestId === 'req-rename');
    expect(audit?.op).toBe('rename');
    expect(audit?.state).toBe('confirmed');
  });
});
