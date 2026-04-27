import { describe, expect, it } from 'vitest';
import { applyInstructionOperations } from './catalog';
import type { SessionInstruction } from './session-types';

describe('applyInstructionOperations — lifecycle ops', () => {
  function seed(): SessionInstruction[] {
    // Sealed shape (#727 / #754): createdAt (ISO), source enum,
    // linkedSessionIds + sourceRawInputIds required.
    return [
      {
        id: 'i1',
        text: 'a',
        createdAt: new Date(1).toISOString(),
        status: 'active',
        source: 'model',
        linkedSessionIds: [],
        sourceRawInputIds: [],
      },
      {
        id: 'i2',
        text: 'b',
        createdAt: new Date(2).toISOString(),
        status: 'cancelled',
        source: 'model',
        linkedSessionIds: [],
        sourceRawInputIds: [],
      },
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

  it('complete stamps completedAt and flips status (no evidence on row, sealed #727 P1-5)', () => {
    const arr = seed();
    const changed = applyInstructionOperations(arr, [
      { action: 'complete', id: 'i1', evidence: 'merged PR #42' },
    ]);
    expect(changed).toBe(true);
    expect(arr[0].status).toBe('completed');
    // Sealed schema (#727 P1-5): instructions carry NO `evidence` field.
    expect((arr[0] as { evidence?: unknown }).evidence).toBeUndefined();
    expect(typeof arr[0].completedAt).toBe('string');
  });

  it('setStatus transitions and clears completedAt when leaving completed', () => {
    const arr = seed();
    // Flip i1 → completed (setStatus, escape hatch).
    applyInstructionOperations(arr, [{ action: 'setStatus', id: 'i1', status: 'completed' }]);
    expect(arr[0].completedAt).toBeDefined();

    // Flip back to active — completedAt should clear; row never carried evidence.
    const changed = applyInstructionOperations(arr, [{ action: 'setStatus', id: 'i1', status: 'active' }]);
    expect(changed).toBe(true);
    expect(arr[0].status).toBe('active');
    expect(arr[0].completedAt).toBeUndefined();
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
