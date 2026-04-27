import { describe, expect, it } from 'vitest';
import { applyInstructionOperations } from './catalog';
import type { SessionInstruction } from './session-types';

describe('applyInstructionOperations — lifecycle ops', () => {
  function seed(): SessionInstruction[] {
    return [
      { id: 'i1', text: 'a', addedAt: 1, status: 'active' },
      // Sealed schema: legacy 'todo' migrated to 'active'; 'cancelled' is the
      // new first-class non-active state.
      { id: 'i2', text: 'b', addedAt: 2, status: 'cancelled' },
    ];
  }

  it('add seeds status=active on new entries', () => {
    const arr: SessionInstruction[] = [];
    const changed = applyInstructionOperations(arr, [{ action: 'add', text: 'hi' }]);
    expect(changed).toBe(true);
    expect(arr).toHaveLength(1);
    expect(arr[0].status).toBe('active');
  });

  it('complete requires both id and evidence (drops malformed ops)', () => {
    const arr = seed();
    expect(applyInstructionOperations(arr, [{ action: 'complete', id: 'i1', evidence: '' }])).toBe(false);
    // @ts-expect-error intentionally malformed — covers defensive branch
    expect(applyInstructionOperations(arr, [{ action: 'complete', id: 'i1' }])).toBe(false);
    expect(arr[0].status).toBe('active');
  });

  it('complete stamps completedAt + evidence on the target entry', () => {
    const arr = seed();
    const changed = applyInstructionOperations(arr, [
      { action: 'complete', id: 'i1', evidence: 'merged PR #42' },
    ]);
    expect(changed).toBe(true);
    expect(arr[0].status).toBe('completed');
    expect(arr[0].evidence).toBe('merged PR #42');
    expect(typeof arr[0].completedAt).toBe('number');
  });

  it('setStatus transitions without evidence and clears completedAt when leaving completed', () => {
    const arr = seed();
    // Flip i1 → completed (setStatus, escape hatch).
    applyInstructionOperations(arr, [{ action: 'setStatus', id: 'i1', status: 'completed' }]);
    expect(arr[0].completedAt).toBeDefined();

    // Flip back to active — the completedAt/evidence should clear.
    const changed = applyInstructionOperations(arr, [{ action: 'setStatus', id: 'i1', status: 'active' }]);
    expect(changed).toBe(true);
    expect(arr[0].status).toBe('active');
    expect(arr[0].completedAt).toBeUndefined();
    expect(arr[0].evidence).toBeUndefined();
  });

  it('setStatus no-op when target status already matches', () => {
    const arr = seed();
    const changed = applyInstructionOperations(arr, [{ action: 'setStatus', id: 'i2', status: 'cancelled' }]);
    expect(changed).toBe(false);
  });

  it('unknown id silently drops complete/setStatus', () => {
    const arr = seed();
    const changed = applyInstructionOperations(arr, [
      { action: 'complete', id: 'ghost', evidence: 'x' },
      { action: 'setStatus', id: 'ghost', status: 'cancelled' },
    ]);
    expect(changed).toBe(false);
  });
});
