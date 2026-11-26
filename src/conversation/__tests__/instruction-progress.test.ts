import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  instructionProgressOf,
  instructionStagesOf,
  noteInstructionReachedModel,
  noteInstructionRunEnded,
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
    noteInstructionStage('k', REF, 'starting', 200, 7);
    expect(instructionProgressOf('k')).toEqual({ ref: REF, stage: 'starting', at: 200 });
    noteInstructionReachedModel('k', { turnEpoch: 7 }, 300);
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
    noteInstructionStage('k', REF, 'starting', 5_000, 3);
    noteInstructionReachedModel('k', { turnEpoch: 3 }, 6_000);
    expect(instructionProgressOf('k')).toMatchObject({ stage: 'delivered', at: 6_000 });
  });

  it('approved by the owner, it can still wait in the queue: approval → queued → starting', () => {
    noteInstructionStage('k', REF, 'approval', 100);
    noteInstructionStage('k', REF, 'queued', 200);
    expect(instructionProgressOf('k')).toMatchObject({ stage: 'queued' });
    noteInstructionStage('k', REF, 'starting', 300);
    expect(instructionProgressOf('k')).toMatchObject({ stage: 'starting' });
  });

  it('the model receiving a turn marks only an instruction whose own run is starting (its epoch)', () => {
    noteInstructionStage('k', REF, 'received', 100);
    noteInstructionReachedModel('k', { turnEpoch: 4 }, 150); // another turn's first event (one already running)
    expect(instructionProgressOf('k')).toMatchObject({ stage: 'received' });
    noteInstructionStage('k', REF, 'queued', 160);
    noteInstructionReachedModel('k', { turnEpoch: 4 }, 170);
    expect(instructionProgressOf('k')).toMatchObject({ stage: 'queued' });
    noteInstructionStage('k', REF, 'starting', 180, 5);
    noteInstructionReachedModel('k', { turnEpoch: 4 }, 190); // a late event of the run before
    noteInstructionReachedModel('k', {}, 195); // no run named
    expect(instructionProgressOf('k')).toMatchObject({ stage: 'starting' });
    // Review on #1468: a post-compact replay reports the run it runs in as its replayEpoch.
    noteInstructionReachedModel('k', { replayEpoch: 5 }, 200);
    expect(instructionProgressOf('k')).toMatchObject({ stage: 'delivered', at: 200 });
    noteInstructionReachedModel('other', { turnEpoch: 5 }, 210);
    expect(instructionProgressOf('other')).toBeUndefined();
  });

  it('its run ended before the model had it: not delivered; another run’s end changes nothing', () => {
    noteInstructionStage('k', REF, 'starting', 100, 9);
    noteInstructionRunEnded('k', REF, 8, 150); // another run's end
    expect(instructionProgressOf('k')).toMatchObject({ stage: 'starting' });
    noteInstructionRunEnded('k', REF, 9, 200);
    expect(instructionProgressOf('k')).toEqual({ ref: REF, stage: 'not-delivered', at: 200 });
    noteInstructionStage('k', REF2, 'starting', 300, 10);
    noteInstructionReachedModel('k', { turnEpoch: 10 }, 310);
    noteInstructionRunEnded('k', REF2, 11, 400); // another run's end
    expect(instructionProgressOf('k')).toMatchObject({ ref: REF2, stage: 'delivered' });
  });

  it('review on #1468 — sent into a running turn: the follow-up queue owns it from there', () => {
    noteInstructionStage('k', REF, 'received', 100);
    noteInstructionStage('k', REF, 'followup', 110);
    expect(instructionProgressOf('k')).toMatchObject({ stage: 'followup' });
    // Its later run (the queue's drain) is the queue's to report: no starting stage over it.
    noteInstructionStage('k', REF, 'starting', 120, 3);
    expect(instructionProgressOf('k')).toMatchObject({ stage: 'followup' });
  });

  it('review on #1468 — each instruction keeps its own stage; the card carries the session’s recent ones', () => {
    noteInstructionStage('k', REF, 'approval', 100);
    noteInstructionStage('k', REF2, 'approval', 200);
    // Two held for the owner: both still say so (one per session used to wipe the first).
    expect(instructionStagesOf('k')).toEqual([
      { ref: REF2, stage: 'approval', at: 200 },
      { ref: REF, stage: 'approval', at: 100 },
    ]);
    noteInstructionStage('k', REF, 'starting', 300, 4); // the first one approved and run
    expect(instructionStagesOf('k').map((p) => `${p.ref}:${p.stage}`)).toEqual([
      `${REF}:starting`,
      `${REF2}:approval`,
    ]);
    expect(instructionProgressOf('k')).toMatchObject({ ref: REF, stage: 'starting' });
    // At most the five latest of a session.
    for (let i = 0; i < 7; i++) noteInstructionStage('k', `optimistic-${i}-x`, 'received', 400 + i);
    expect(instructionStagesOf('k')).toHaveLength(5);
    expect(instructionStagesOf('k')[0]).toMatchObject({ ref: 'optimistic-6-x' });
    expect(instructionStagesOf('other')).toEqual([]);
  });

  it('review on #1468 — 그래도 시작 into the task queue: same-work → queued', () => {
    noteInstructionStage('k', REF, 'same-work', 100);
    noteInstructionStage('k', REF, 'queued', 200);
    expect(instructionProgressOf('k')).toMatchObject({ stage: 'queued' });
  });

  it('review on #1468 — its run ended after the model had it (answered, stopped or failed): done, no stage left', () => {
    noteInstructionStage('k', REF, 'starting', 100, 6);
    noteInstructionReachedModel('k', { turnEpoch: 6 }, 150);
    noteInstructionRunEnded('k', REF, 6, 200);
    expect(instructionProgressOf('k')).toEqual({ ref: REF, stage: 'done', at: 200 });
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
    noteInstructionStage('k', REF, 'starting', 130, 2);
    noteInstructionReachedModel('k', { turnEpoch: 2 }, 140);
    noteInstructionReachedModel('k', { turnEpoch: 2 }, 150); // already delivered
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
