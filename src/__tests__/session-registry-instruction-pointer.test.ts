/**
 * SessionRegistry × UserSessionStore — assertSessionPointer wiring
 *
 * Issue: #754 (parent epic #727), oracle review fix-loop #2
 *
 * Round 2 reviewers flagged that the round-1 self-heal wiring on
 * SessionRegistry's saveSessions() / loadSessions() lacks an integration
 * test. A future refactor that drops the `assertSessionPointer` call (or
 * weakens it) would silently regress the sealed pointer invariant.
 *
 * These tests assert that BOTH the save-pointer guard and the load-pointer
 * guard:
 *   1. Detect a `currentInstructionId` that points at a `completed`
 *      instruction on the user master.
 *   2. Null out the pointer in memory.
 *   3. Append a `state: 'rejected'` lifecycle audit row to the user master,
 *      with `op:'link'` and `payload.rejectedInstructionId` matching the
 *      bad reference.
 *   4. Persist the audit row to disk.
 *
 * Round-2 P1-A/P1-B add a corruption-aware catch: when
 * `UserSessionStoreCorruptError` bubbles out of the store, the catch must
 * NOT silently log at debug — it must `logger.error` AND null the pointer
 * in memory so the bad pointer doesn't propagate to disk this cycle.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `vi.hoisted` runs before all imports, ensuring our state object exists before
// the mock factory below references it. We pre-create a tmpdir at hoist time so
// the module-level singletons (`userSettingsStore`) that read DATA_DIR at import
// can mkdir successfully. Per-test isolation is then provided by overwriting
// `state.dir` in `beforeEach`.
const state = vi.hoisted(() => {
  const fsh = require('node:fs') as typeof import('node:fs');
  const osh = require('node:os') as typeof import('node:os');
  const pathh = require('node:path') as typeof import('node:path');
  const dir = fsh.mkdtempSync(pathh.join(osh.tmpdir(), 'soma-session-pointer-boot-'));
  return { dir };
});

vi.mock('../env-paths', () => ({
  get DATA_DIR() {
    return state.dir;
  },
}));

import { SessionRegistry } from '../session-registry';
import {
  type UserSessionDoc,
  initUserSessionStore,
  UserSessionStoreCorruptError,
} from '../user-session-store';

let TEST_DATA_DIR: string;

beforeEach(() => {
  TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-session-pointer-'));
  state.dir = TEST_DATA_DIR;
  // Re-bind the singleton to the per-test data dir so getUserSessionStore()
  // (used by SessionRegistry) reads/writes under this temp root.
  initUserSessionStore(TEST_DATA_DIR);
});

afterEach(() => {
  if (TEST_DATA_DIR && fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
});

function writeUserDoc(userId: string, doc: UserSessionDoc): void {
  const dir = path.join(TEST_DATA_DIR, 'users', userId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'user-session.json'), JSON.stringify(doc, null, 2));
}

function readUserDoc(userId: string): UserSessionDoc {
  const file = path.join(TEST_DATA_DIR, 'users', userId, 'user-session.json');
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as UserSessionDoc;
}

describe('SessionRegistry × assertSessionPointer — on-load self-heal', () => {
  it('nulls a session.currentInstructionId that references a completed instruction, audits to user master', () => {
    const userId = 'U_LOAD_1';
    const sessionKey = 'C1-T1';
    // 1. user-session.json with one COMPLETED instruction
    writeUserDoc(userId, {
      schemaVersion: 1,
      instructions: [
        {
          id: 'inst-A',
          text: 'old work',
          status: 'completed',
          linkedSessionIds: [sessionKey],
          createdAt: '2026-04-01T00:00:00.000Z',
          completedAt: '2026-04-02T00:00:00.000Z',
          source: 'model',
          sourceRawInputIds: [],
        },
      ],
      lifecycleEvents: [],
    });

    // 2. sessions.json with a session whose currentInstructionId references
    //    that completed instruction.
    const writer = new SessionRegistry();
    const session = writer.createSession(userId, 'Tester', 'C1', 'T1');
    session.sessionId = 'sid-load-1';
    session.currentInstructionId = 'inst-A';
    writer.saveSessions();

    // 3. New registry instance loads from disk — load-time guard must
    //    null out the bad pointer.
    const reader = new SessionRegistry();
    reader.loadSessions();
    const loaded = reader.getSession('C1', 'T1');

    // 4a. loaded session has currentInstructionId === null
    expect(loaded?.currentInstructionId ?? null).toBeNull();

    // 4b. user master has a fresh `state: 'rejected'` lifecycle event
    const doc = readUserDoc(userId);
    const rejected = doc.lifecycleEvents.find(
      (e) =>
        e.state === 'rejected' &&
        e.sessionKey === sessionKey &&
        (e.payload as { rejectedInstructionId?: string } | undefined)?.rejectedInstructionId === 'inst-A',
    );
    expect(rejected).toBeDefined();
    expect(rejected?.op).toBe('link');
  });
});

describe('SessionRegistry × assertSessionPointer — on-save self-heal', () => {
  it('nulls currentInstructionId and audits when the in-memory pointer references a completed instruction', () => {
    const userId = 'U_SAVE_1';
    const sessionKey = 'C2-T2';
    writeUserDoc(userId, {
      schemaVersion: 1,
      instructions: [
        {
          id: 'inst-B',
          text: 'finished work',
          status: 'completed',
          linkedSessionIds: [sessionKey],
          createdAt: '2026-04-01T00:00:00.000Z',
          completedAt: '2026-04-02T00:00:00.000Z',
          source: 'model',
          sourceRawInputIds: [],
        },
      ],
      lifecycleEvents: [],
    });

    const writer = new SessionRegistry();
    const session = writer.createSession(userId, 'Tester', 'C2', 'T2');
    session.sessionId = 'sid-save-1';
    // Mutate the pointer to reference a completed instruction (simulates a
    // bug elsewhere or external mutation).
    session.currentInstructionId = 'inst-B';

    writer.saveSessions();

    // After save, the in-memory session pointer should be nulled.
    expect(session.currentInstructionId).toBeNull();

    // And the user master should carry a fresh rejection audit.
    const doc = readUserDoc(userId);
    const rejected = doc.lifecycleEvents.find(
      (e) =>
        e.state === 'rejected' &&
        e.sessionKey === sessionKey &&
        (e.payload as { rejectedInstructionId?: string } | undefined)?.rejectedInstructionId === 'inst-B',
    );
    expect(rejected).toBeDefined();
    expect(rejected?.op).toBe('link');
  });
});

describe('SessionRegistry × UserSessionStoreCorruptError handling', () => {
  it('on save: nulls in-memory currentInstructionId and does NOT silently swallow the corrupt-store error at debug level', () => {
    const userId = 'U_CORRUPT_SAVE';
    // Write a corrupt user-session.json that the store will reject on load.
    const dir = path.join(TEST_DATA_DIR, 'users', userId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'user-session.json'), '{not-json,');

    const writer = new SessionRegistry();
    const session = writer.createSession(userId, 'Tester', 'C9', 'T9');
    session.sessionId = 'sid-corrupt-save';
    session.currentInstructionId = 'inst-X'; // arbitrary

    // Capture logger calls — the contract is that
    // UserSessionStoreCorruptError must surface at logger.error (NOT
    // debug) and the in-memory pointer must be nulled so we don't
    // re-write the bad pointer to sessions.json.
    const errorSpy = vi.spyOn((writer as unknown as { logger: { error: (...args: unknown[]) => void } }).logger, 'error');
    const debugSpy = vi.spyOn((writer as unknown as { logger: { debug: (...args: unknown[]) => void } }).logger, 'debug');

    expect(() => writer.saveSessions()).not.toThrow();

    // P1-A: must escalate to logger.error, not logger.debug
    const errorCalls = errorSpy.mock.calls.filter((args) =>
      String(args[0] ?? '').includes('UserSessionStoreCorruptError') ||
      String(args[0] ?? '').toLowerCase().includes('user-session.json corrupt') ||
      String(args[0] ?? '').toLowerCase().includes('session pointer'),
    );
    expect(errorCalls.length).toBeGreaterThan(0);

    const debugCalls = debugSpy.mock.calls.filter((args) =>
      String(args[0] ?? '').includes('assertSessionPointer'),
    );
    // The legacy "skipped at debug" path is what round-1 used for ALL
    // errors. After P1-A, the corrupt-store path must NOT take the debug
    // branch.
    expect(debugCalls.length).toBe(0);

    // In-memory pointer is nulled so we don't propagate the bad pointer.
    expect(session.currentInstructionId).toBeNull();
  });

  it('on load: nulls restored session.currentInstructionId when the store is corrupt and surfaces logger.error', () => {
    const userId = 'U_CORRUPT_LOAD';
    const sessionKey = 'C8-T8';
    // First save a clean session so sessions.json has a serialized
    // session that references some instruction id.
    {
      // Provide a clean store so saveSessions works.
      writeUserDoc(userId, {
        schemaVersion: 1,
        instructions: [
          {
            id: 'inst-Y',
            text: 'work',
            status: 'active',
            linkedSessionIds: [sessionKey],
            createdAt: '2026-04-01T00:00:00.000Z',
            source: 'model',
            sourceRawInputIds: [],
          },
        ],
        lifecycleEvents: [],
      });
      const writer = new SessionRegistry();
      const s = writer.createSession(userId, 'Tester', 'C8', 'T8');
      s.sessionId = 'sid-corrupt-load';
      s.currentInstructionId = 'inst-Y';
      writer.saveSessions();
    }

    // Now corrupt the user-session.json so the next loadSessions() pass
    // hits UserSessionStoreCorruptError when it tries to validate the
    // pointer.
    const userFile = path.join(TEST_DATA_DIR, 'users', userId, 'user-session.json');
    fs.writeFileSync(userFile, '{not-json,');

    // Reset cache so the corrupt file is actually re-read.
    initUserSessionStore(TEST_DATA_DIR);

    const reader = new SessionRegistry();
    const errorSpy = vi.spyOn((reader as unknown as { logger: { error: (...args: unknown[]) => void } }).logger, 'error');
    const debugSpy = vi.spyOn((reader as unknown as { logger: { debug: (...args: unknown[]) => void } }).logger, 'debug');

    expect(() => reader.loadSessions()).not.toThrow();
    const restored = reader.getSession('C8', 'T8');

    // The session itself loads, but its pointer is nulled because we
    // could not validate against the corrupt master.
    expect(restored).toBeDefined();
    expect(restored?.currentInstructionId ?? null).toBeNull();

    // Error path surfaces, debug path does NOT swallow.
    const errorCalls = errorSpy.mock.calls.filter((args) =>
      String(args[0] ?? '').includes('UserSessionStoreCorruptError') ||
      String(args[0] ?? '').toLowerCase().includes('user-session.json corrupt') ||
      String(args[0] ?? '').toLowerCase().includes('session pointer'),
    );
    expect(errorCalls.length).toBeGreaterThan(0);

    const debugCalls = debugSpy.mock.calls.filter((args) =>
      String(args[0] ?? '').includes('assertSessionPointer'),
    );
    expect(debugCalls.length).toBe(0);
  });
});

describe('UserSessionStoreCorruptError export', () => {
  it('is a named export for catch-narrowing in callers', () => {
    expect(UserSessionStoreCorruptError).toBeDefined();
    const err = new UserSessionStoreCorruptError('x', 'u', '/tmp/x');
    expect(err).toBeInstanceOf(UserSessionStoreCorruptError);
    expect(err).toBeInstanceOf(Error);
  });
});
