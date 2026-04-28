/**
 * SessionRegistry × user-master lifecycle transaction rollback (#755).
 *
 * Sealed contract (#755 §구현 스펙):
 *   y 응답 시 한 트랜잭션으로:
 *     ① user store mutation,
 *     ② 세션 측 currentInstructionId/instructionHistory 갱신,
 *     ③ lifecycleEvents push state='confirmed',
 *     ④ pending entry 삭제.
 *   셋 중 하나라도 실패하면 전체 롤백.
 *
 * This file exercises the failure path: forces step ② / ③ / ④ to fail
 * and verifies BOTH the user-master disk state AND the session pointer
 * are restored.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  const fsh = require('node:fs') as typeof import('node:fs');
  const osh = require('node:os') as typeof import('node:os');
  const pathh = require('node:path') as typeof import('node:path');
  const dir = fsh.mkdtempSync(pathh.join(osh.tmpdir(), 'soma-lifecycle-rb-boot-'));
  return { dir };
});

vi.mock('../env-paths', () => ({
  get DATA_DIR() {
    return state.dir;
  },
}));

import { SessionRegistry } from '../session-registry';
import { getUserSessionStore, initUserSessionStore, type UserSessionDoc } from '../user-session-store';

let TEST_DATA_DIR: string;

beforeEach(() => {
  TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-lifecycle-rb-'));
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

describe('SessionRegistry.applyConfirmedLifecycle — transaction rollback (#755)', () => {
  it('rolls back BOTH user master and session pointer when the user-store save fails', () => {
    const userId = 'U-rb-1';
    writeUserDoc(userId, {
      schemaVersion: 1,
      instructions: [
        {
          id: 'inst-keep',
          text: 'pre-existing',
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
    const session = reg.createSession(userId, 'Tester', 'C-RB1', 'T-RB1');
    session.sessionId = 'sid-rb-1';
    session.currentInstructionId = null;
    const beforeHistory = [...(session.instructionHistory ?? [])];

    // Force the user-store save to fail on the FIRST call only — the
    // rollback path then re-saves the snapshot, which must succeed.
    const store = getUserSessionStore();
    const realSave = store.save.bind(store);
    let calls = 0;
    store.save = vi.fn((uid: string, doc) => {
      calls += 1;
      if (calls === 1) {
        throw new Error('forced failure to test rollback');
      }
      return realSave(uid, doc);
    }) as typeof store.save;

    const result = reg.applyConfirmedLifecycle(session, {
      requestId: 'req-rb-1',
      type: 'add',
      by: { type: 'slack-user', id: userId },
      ops: [{ action: 'add', text: 'should not survive' }],
    });

    // Restore real save so afterEach cleanup is healthy.
    store.save = realSave;

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('TX_FAILED');

    // Rollback: user doc unchanged on disk
    const docAfter = readUserDoc(userId);
    expect(docAfter.instructions).toHaveLength(1);
    expect(docAfter.instructions[0].id).toBe('inst-keep');
    expect(docAfter.lifecycleEvents.find((e) => e.requestId === 'req-rb-1')).toBeUndefined();

    // Session in-memory pointer + history rolled back to pre-state
    expect(session.currentInstructionId ?? null).toBeNull();
    expect(session.instructionHistory ?? []).toEqual(beforeHistory);
  });

  it('rolls back BOTH halves when the SECOND save (session-side persistence) fails after the user master commit', () => {
    // This guards the inter-step failure: user master is already on disk
    // when saveSessions throws — the impl MUST re-save the snapshot before
    // surfacing TX_FAILED, otherwise a successful audit row would leak into
    // the master while the session-side state has rolled back.
    const userId = 'U-rb-2';
    writeUserDoc(userId, {
      schemaVersion: 1,
      instructions: [
        {
          id: 'inst-X',
          text: 'pre',
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
    const session = reg.createSession(userId, 'Tester', 'C-RB2', 'T-RB2');
    session.sessionId = 'sid-rb-2';
    const beforePointer = session.currentInstructionId ?? null;
    const beforeHistory = [...(session.instructionHistory ?? [])];

    // Force `saveSessions` to throw exactly once so the user-master write
    // has already committed before the failure is detected. The
    // recovery path re-saves the user-master snapshot.
    const realSaveSessions = (reg as unknown as { saveSessions: () => void }).saveSessions.bind(reg);
    let saveSessionsCalls = 0;
    (reg as unknown as { saveSessions: () => void }).saveSessions = vi.fn(() => {
      saveSessionsCalls += 1;
      if (saveSessionsCalls === 1) {
        throw new Error('forced saveSessions failure');
      }
      return realSaveSessions();
    }) as () => void;

    const result = reg.applyConfirmedLifecycle(session, {
      requestId: 'req-rb-2',
      type: 'link',
      by: { type: 'slack-user', id: userId },
      ops: [{ action: 'link', id: 'inst-X', sessionKey: 'C-RB2-T-RB2' }],
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('TX_FAILED');

    // User master rolled back: linkedSessionIds stays empty, no audit row.
    const docAfter = readUserDoc(userId);
    expect(docAfter.instructions[0].linkedSessionIds).toEqual([]);
    expect(docAfter.lifecycleEvents.find((e) => e.requestId === 'req-rb-2')).toBeUndefined();

    // Session pointer + history rolled back to pre-state.
    expect(session.currentInstructionId ?? null).toEqual(beforePointer);
    expect(session.instructionHistory ?? []).toEqual(beforeHistory);
  });

  // PR2 P1-1 (#755): pull pending-delete INSIDE the transaction. The full
  // 4-step tx is now (1) user-store mutation + audit row, (2) session
  // pointer/history update, (3) session-side persistence, (4) pending-store
  // delete. ANY of the four failing must roll back the previous three.
  // The legacy code did the pending-delete in `handleYes` AFTER
  // applyConfirmedLifecycle returned ok=true, so a failure there left an
  // orphaned pending entry while the user master + session pointer had
  // already been mutated.
  it('rolls back BOTH user master and session pointer when the pending-store delete (step ④) fails', () => {
    const userId = 'U-rb-3';
    writeUserDoc(userId, {
      schemaVersion: 1,
      instructions: [
        {
          id: 'inst-K',
          text: 'pre-existing',
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
    const session = reg.createSession(userId, 'Tester', 'C-RB3', 'T-RB3');
    session.sessionId = 'sid-rb-3';
    const beforePointer = session.currentInstructionId ?? null;
    const beforeHistory = [...(session.instructionHistory ?? [])];

    const result = reg.applyConfirmedLifecycle(
      session,
      {
        requestId: 'req-rb-3',
        type: 'add',
        by: { type: 'slack-user', id: userId },
        ops: [{ action: 'add', text: 'must be rolled back' }],
      },
      () => {
        // Simulate the pending-store delete throwing — disk full, store
        // unavailable, whatever. The tx contract says all earlier writes
        // must roll back.
        throw new Error('forced pending-delete failure');
      },
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('TX_FAILED');

    // User master rolled back: no new instruction, no audit row.
    const docAfter = readUserDoc(userId);
    expect(docAfter.instructions).toHaveLength(1);
    expect(docAfter.instructions[0].id).toBe('inst-K');
    expect(docAfter.lifecycleEvents.find((e) => e.requestId === 'req-rb-3')).toBeUndefined();

    // Session pointer + history rolled back to pre-state.
    expect(session.currentInstructionId ?? null).toEqual(beforePointer);
    expect(session.instructionHistory ?? []).toEqual(beforeHistory);
  });

  it('calls the pending-delete callback after the user master + session-side commits succeed', () => {
    const userId = 'U-rb-4';
    writeUserDoc(userId, {
      schemaVersion: 1,
      instructions: [],
      lifecycleEvents: [],
    });

    const reg = new SessionRegistry();
    const session = reg.createSession(userId, 'Tester', 'C-RB4', 'T-RB4');
    session.sessionId = 'sid-rb-4';

    let deleteCalled = 0;
    const result = reg.applyConfirmedLifecycle(
      session,
      {
        requestId: 'req-rb-4',
        type: 'add',
        by: { type: 'slack-user', id: userId },
        ops: [{ action: 'add', text: 'committed' }],
      },
      () => {
        // The contract: this fires only AFTER the user-master save AND the
        // session-side persistence succeed (steps ①+②+③). On invocation,
        // both writes must already be on disk.
        const onDisk = readUserDoc(userId);
        expect(onDisk.instructions).toHaveLength(1);
        expect(onDisk.lifecycleEvents.find((e) => e.requestId === 'req-rb-4')).toBeDefined();
        deleteCalled += 1;
      },
    );

    expect(result.ok).toBe(true);
    expect(deleteCalled).toBe(1);
  });
});
