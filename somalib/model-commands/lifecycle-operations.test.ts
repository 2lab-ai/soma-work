/**
 * Lifecycle 5-op vocabulary at the catalog seam — sub-issue #755.
 *
 * The data model (#754) sealed the user-master schema; #755 wires the
 * model→host operation vocabulary that produces `lifecycleEvents[]` rows.
 *
 * `SessionInstructionOperation` MUST cover the 5 sealed lifecycle ops:
 *   add | link | complete | cancel | rename
 *
 * `clear` and `setStatus` are deprecated escape hatches (kept for
 * backwards-compat with already-emitted prompts; no new code may emit them
 * — see catalog JSDoc). The catalog `applyInstructionOperations` is the
 * row-level mutator: it does NOT touch lifecycleEvents (that's the
 * SessionRegistry tx in #755). It only flips row state on the supplied
 * instruction array.
 */

import { describe, expect, it } from 'vitest';
import { applyInstructionOperations } from './catalog';
import type { SessionInstruction, SessionInstructionOperation } from './session-types';

function mkInst(id: string, text: string, status: SessionInstruction['status'] = 'active'): SessionInstruction {
  return {
    id,
    text,
    createdAt: new Date(1).toISOString(),
    status,
    source: 'model',
    linkedSessionIds: [],
    sourceRawInputIds: [],
  };
}

describe('SessionInstructionOperation — sealed lifecycle ops (#755)', () => {
  it('link op records the session in linkedSessionIds without changing status or text', () => {
    const arr = [mkInst('i1', 'long instruction')];
    const op: SessionInstructionOperation = {
      action: 'link',
      id: 'i1',
      sessionKey: 'C-D|T-D',
    };
    const changed = applyInstructionOperations(arr, [op]);
    expect(changed).toBe(true);
    expect(arr[0].status).toBe('active');
    expect(arr[0].text).toBe('long instruction');
    expect(arr[0].linkedSessionIds).toContain('C-D|T-D');
  });

  it('link op deduplicates linkedSessionIds when called twice', () => {
    const arr = [mkInst('i1', 'work')];
    applyInstructionOperations(arr, [{ action: 'link', id: 'i1', sessionKey: 'sess-1' }]);
    const changedAgain = applyInstructionOperations(arr, [{ action: 'link', id: 'i1', sessionKey: 'sess-1' }]);
    expect(changedAgain).toBe(false);
    expect(arr[0].linkedSessionIds).toEqual(['sess-1']);
  });

  it('cancel op flips status=cancelled and stamps cancelledAt', () => {
    const arr = [mkInst('i7', 'work')];
    const changed = applyInstructionOperations(arr, [{ action: 'cancel', id: 'i7' }]);
    expect(changed).toBe(true);
    expect(arr[0].status).toBe('cancelled');
    expect(typeof arr[0].cancelledAt).toBe('string');
    // completedAt must remain unset — cancel is a separate first-class state (Q3 sealed YES).
    expect(arr[0].completedAt).toBeUndefined();
  });

  it('cancel op is no-op when already cancelled', () => {
    const arr = [mkInst('i9', 'work', 'cancelled')];
    arr[0].cancelledAt = '2026-01-01T00:00:00.000Z';
    const changed = applyInstructionOperations(arr, [{ action: 'cancel', id: 'i9' }]);
    expect(changed).toBe(false);
  });

  it('rename op updates text but preserves id, status, linkedSessionIds, source', () => {
    const arr = [mkInst('i3', 'old name')];
    arr[0].linkedSessionIds = ['sA', 'sB'];
    const changed = applyInstructionOperations(arr, [{ action: 'rename', id: 'i3', text: 'new name' }]);
    expect(changed).toBe(true);
    expect(arr[0].id).toBe('i3');
    expect(arr[0].text).toBe('new name');
    expect(arr[0].status).toBe('active');
    expect(arr[0].linkedSessionIds).toEqual(['sA', 'sB']);
    expect(arr[0].source).toBe('model');
  });

  it('rename drops malformed ops (empty text)', () => {
    const arr = [mkInst('i3', 'old')];
    const changed = applyInstructionOperations(arr, [{ action: 'rename', id: 'i3', text: '   ' }]);
    expect(changed).toBe(false);
    expect(arr[0].text).toBe('old');
  });

  it('rename of unknown id is silently dropped (matches add/complete leniency)', () => {
    const arr = [mkInst('i3', 'old')];
    const changed = applyInstructionOperations(arr, [{ action: 'rename', id: 'ghost', text: 'x' }]);
    expect(changed).toBe(false);
  });
});
