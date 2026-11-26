import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  instructionProgressOf,
  noteInstructionReachedModel,
  noteInstructionStage,
  resetInstructionProgressForTests,
  setInstructionProgressListener,
} from '../instruction-progress';

// Z 2026-11-26 (#1466): where an instruction sent from the dashboard really is — the stages the server itself passes
// for it, by the ref the panel gave it, never a guess.
const REF = 'optimistic-1795680000000-abc123';
const REF2 = 'optimistic-1795680009999-def456';

describe('instruction-progress', () => {
  beforeEach(() => resetInstructionProgressForTests());

  it('records the stages one instruction passes, in order, with when each was reached', () => {
    noteInstructionStage('k', REF, 'received', 100);
    expect(instructionProgressOf('k')).toEqual({ ref: REF, stage: 'received', at: 100 });
    noteInstructionStage('k', REF, 'starting', 200);
    expect(instructionProgressOf('k')).toEqual({ ref: REF, stage: 'starting', at: 200 });
    noteInstructionReachedModel('k', 300);
    expect(instructionProgressOf('k')).toEqual({ ref: REF, stage: 'delivered', at: 300 });
  });

  it('never moves an instruction back to an earlier stage', () => {
    noteInstructionStage('k', REF, 'starting', 200);
    noteInstructionStage('k', REF, 'received', 250); // a late route write after the dispatch
    expect(instructionProgressOf('k')).toMatchObject({ stage: 'starting', at: 200 });
    noteInstructionStage('k', REF, 'queued', 260);
    expect(instructionProgressOf('k')).toMatchObject({ stage: 'starting' });
  });

  it('the task queue holds it, then starts it: queued → starting → delivered', () => {
    noteInstructionStage('k', REF, 'received', 100);
    noteInstructionStage('k', REF, 'queued', 110);
    expect(instructionProgressOf('k')).toMatchObject({ stage: 'queued' });
    noteInstructionStage('k', REF, 'starting', 5_000);
    noteInstructionReachedModel('k', 6_000);
    expect(instructionProgressOf('k')).toMatchObject({ stage: 'delivered', at: 6_000 });
  });

  it('approved by the owner, it can still wait in the queue: approval → queued → starting', () => {
    noteInstructionStage('k', REF, 'approval', 100);
    noteInstructionStage('k', REF, 'queued', 200);
    expect(instructionProgressOf('k')).toMatchObject({ stage: 'queued' });
    noteInstructionStage('k', REF, 'starting', 300);
    expect(instructionProgressOf('k')).toMatchObject({ stage: 'starting' });
  });

  it('the model receiving a turn marks only an instruction whose turn is starting', () => {
    noteInstructionStage('k', REF, 'received', 100);
    noteInstructionReachedModel('k', 150); // another turn's first event (one already running)
    expect(instructionProgressOf('k')).toMatchObject({ stage: 'received' });
    noteInstructionStage('k', REF, 'queued', 160);
    noteInstructionReachedModel('k', 170);
    expect(instructionProgressOf('k')).toMatchObject({ stage: 'queued' });
    noteInstructionReachedModel('other', 180);
    expect(instructionProgressOf('other')).toBeUndefined();
  });

  it('a newer instruction replaces the record; a stage for an older one is ignored', () => {
    noteInstructionStage('k', REF, 'delivered', 100);
    noteInstructionStage('k', REF2, 'received', 200);
    expect(instructionProgressOf('k')).toEqual({ ref: REF2, stage: 'received', at: 200 });
    noteInstructionStage('k', REF, 'starting', 210); // the old one's late write
    expect(instructionProgressOf('k')).toMatchObject({ ref: REF2, stage: 'received' });
  });

  it('only a real ref is recorded (a Slack message carries none)', () => {
    noteInstructionStage('k', undefined, 'received', 100);
    noteInstructionStage('k', 'not a ref', 'received', 100);
    expect(instructionProgressOf('k')).toBeUndefined();
  });

  it('tells the listener which session changed, once per real change', () => {
    const heard = vi.fn();
    setInstructionProgressListener(heard);
    noteInstructionStage('k', REF, 'received', 100);
    noteInstructionStage('k', REF, 'received', 120); // same stage again: nothing new
    noteInstructionStage('k', REF, 'starting', 130);
    noteInstructionReachedModel('k', 140);
    noteInstructionReachedModel('k', 150); // already delivered
    expect(heard.mock.calls).toEqual([['k'], ['k'], ['k']]);
  });

  it('a listener that throws never breaks the turn', () => {
    setInstructionProgressListener(() => {
      throw new Error('push failed');
    });
    expect(() => noteInstructionStage('k', REF, 'received', 100)).not.toThrow();
    expect(instructionProgressOf('k')).toMatchObject({ stage: 'received' });
  });
});
