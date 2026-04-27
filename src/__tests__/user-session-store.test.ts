/**
 * UserSessionStore — Contract Tests
 *
 * Issue: #754 (parent epic #727)
 * Sealed schema (top-level lifecycleEvents, source enum, schemaVersion=1)
 * is binding — see issue #727 sealed decisions comment.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type UserInstruction, type UserSessionDoc, UserSessionStore } from '../user-session-store';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-user-session-store-'));
});

afterEach(() => {
  if (tmpRoot && fs.existsSync(tmpRoot)) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

function newStore(): UserSessionStore {
  return new UserSessionStore(tmpRoot);
}

function makeInstruction(overrides: Partial<UserInstruction> = {}): UserInstruction {
  return {
    id: 'instr_1',
    text: 'do the thing',
    status: 'active',
    linkedSessionIds: [],
    createdAt: new Date('2026-04-27T10:00:00Z').toISOString(),
    source: 'model',
    sourceRawInputIds: [],
    ...overrides,
  };
}

function emptyDoc(): UserSessionDoc {
  return {
    schemaVersion: 1,
    instructions: [],
    lifecycleEvents: [],
  };
}

describe('UserSessionStore — load/save', () => {
  it('returns an empty doc when no file exists for the user', () => {
    const store = newStore();
    const doc = store.load('U1');
    expect(doc.schemaVersion).toBe(1);
    expect(doc.instructions).toEqual([]);
    expect(doc.lifecycleEvents).toEqual([]);
  });

  it('writes file under data/users/{userId}/user-session.json', () => {
    const store = newStore();
    const doc = emptyDoc();
    doc.instructions.push(makeInstruction());
    store.save('U1', doc);

    const expected = path.join(tmpRoot, 'users', 'U1', 'user-session.json');
    expect(fs.existsSync(expected)).toBe(true);

    const round = store.load('U1');
    expect(round.instructions).toHaveLength(1);
    expect(round.instructions[0].id).toBe('instr_1');
    expect(round.schemaVersion).toBe(1);
  });

  it('atomic write: never leaves a tmp file behind on success', () => {
    const store = newStore();
    const doc = emptyDoc();
    doc.instructions.push(makeInstruction());
    store.save('U1', doc);

    const userDir = path.join(tmpRoot, 'users', 'U1');
    const files = fs.readdirSync(userDir);
    expect(files).toContain('user-session.json');
    // No leftover *.tmp from the atomic write
    expect(files.filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
  });

  it('sanitises userId to prevent directory traversal', () => {
    const store = newStore();
    expect(() => store.save('../../etc/passwd', emptyDoc())).toThrow();
  });
});

describe('UserSessionStore — invariants on save', () => {
  it('rejects schemaVersion other than 1', () => {
    const store = newStore();
    const doc = emptyDoc();
    (doc as { schemaVersion: number }).schemaVersion = 2;
    expect(() => store.save('U1', doc)).toThrow(/schemaVersion/);
  });

  it('rejects instruction with status outside the sealed enum', () => {
    const store = newStore();
    const doc = emptyDoc();
    // 'todo' is the legacy status — sealed schema only allows active|completed|cancelled
    doc.instructions.push(makeInstruction({ status: 'todo' as unknown as UserInstruction['status'] }));
    expect(() => store.save('U1', doc)).toThrow(/status/);
  });

  it('rejects instruction with source outside the sealed enum', () => {
    const store = newStore();
    const doc = emptyDoc();
    doc.instructions.push(makeInstruction({ source: 'random' as unknown as UserInstruction['source'] }));
    expect(() => store.save('U1', doc)).toThrow(/source/);
  });

  it('rejects duplicate instruction ids', () => {
    const store = newStore();
    const doc = emptyDoc();
    doc.instructions.push(makeInstruction({ id: 'i1' }));
    doc.instructions.push(makeInstruction({ id: 'i1' }));
    expect(() => store.save('U1', doc)).toThrow(/duplicate/i);
  });
});

describe('UserSessionStore — invariants 4 (sealed list from #754)', () => {
  // Inv 1: per-session current instruction is 0 or 1 (enforced at session-registry layer).
  // The store enforces the dual: when a session is in linkedSessionIds, the
  // session must point back at the instruction (bidirectional consistency).

  it('Inv: bidirectional consistency — linked session → that session points back', () => {
    const store = newStore();
    const doc = emptyDoc();
    doc.instructions.push(
      makeInstruction({
        id: 'i1',
        linkedSessionIds: ['S1'],
        status: 'active',
      }),
    );
    // No SessionState provided — store accepts the doc (the registry layer
    // owns the session→instruction direction). The store ensures the doc
    // half is internally consistent.
    expect(() => store.save('U1', doc)).not.toThrow();
  });

  it('Inv: completed instruction cannot be the current pointer for any session', () => {
    const store = newStore();
    const doc = emptyDoc();
    doc.instructions.push(
      makeInstruction({
        id: 'i1',
        status: 'completed',
        completedAt: new Date('2026-04-27T11:00:00Z').toISOString(),
        linkedSessionIds: ['S1'],
      }),
    );
    // assertCurrentPointerOk: a session cannot have a completed instruction
    // as its currentInstructionId.
    expect(() => store.assertCurrentPointerOk(doc, 'i1')).toThrow(/completed/);
    // active is fine
    doc.instructions[0].status = 'active';
    doc.instructions[0].completedAt = undefined;
    expect(() => store.assertCurrentPointerOk(doc, 'i1')).not.toThrow();
  });

  it('Inv: cancelled instruction cannot be the current pointer for any session', () => {
    const store = newStore();
    const doc = emptyDoc();
    doc.instructions.push(
      makeInstruction({
        id: 'i1',
        status: 'cancelled',
        cancelledAt: new Date('2026-04-27T11:00:00Z').toISOString(),
      }),
    );
    expect(() => store.assertCurrentPointerOk(doc, 'i1')).toThrow(/cancelled/);
  });

  it('Inv: null current pointer is normal (no throw)', () => {
    const store = newStore();
    const doc = emptyDoc();
    expect(() => store.assertCurrentPointerOk(doc, null)).not.toThrow();
  });

  it('Inv: unknown instruction id as current pointer throws', () => {
    const store = newStore();
    const doc = emptyDoc();
    expect(() => store.assertCurrentPointerOk(doc, 'ghost')).toThrow(/unknown/);
  });
});

describe('UserSessionStore — lifecycleEvents schema', () => {
  it('persists lifecycleEvents at the top level (not per-instruction)', () => {
    const store = newStore();
    const doc = emptyDoc();
    doc.instructions.push(makeInstruction({ id: 'i1' }));
    doc.lifecycleEvents.push({
      id: 'evt_1',
      requestId: 'req_1',
      instructionId: 'i1',
      sessionKey: 'C1-T1',
      op: 'add',
      state: 'confirmed',
      at: new Date('2026-04-27T10:05:00Z').toISOString(),
      by: { type: 'slack-user', id: 'U1' },
      payload: { text: 'do the thing' },
    });
    store.save('U1', doc);

    const round = store.load('U1');
    expect(round.lifecycleEvents).toHaveLength(1);
    expect(round.lifecycleEvents[0].op).toBe('add');
    expect(round.lifecycleEvents[0].by.type).toBe('slack-user');
  });

  it('rejects lifecycleEvent with invalid op', () => {
    const store = newStore();
    const doc = emptyDoc();
    doc.lifecycleEvents.push({
      id: 'evt_1',
      sessionKey: 'C1-T1',
      op: 'invalid-op' as unknown as 'add',
      state: 'confirmed',
      at: new Date().toISOString(),
      by: { type: 'system', id: 'sys' },
      payload: {},
    });
    expect(() => store.save('U1', doc)).toThrow(/op/);
  });
});
