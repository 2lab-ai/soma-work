/**
 * Rollback mode (2026-11-03): a rollback can be taken back (Redo) until the next turn runs, the
 * work log's instructions are points too ("just before this instruction"), and the dashboard gets
 * every point with what it needs to put a button on the entry itself.
 */

import { encodeContextAnchor } from '@soma/slack/context-anchor';
import { describe, expect, it } from 'vitest';
import type { ConversationSession } from '../../types';
import {
  buildRollbackPointsView,
  CONTEXT_REWIND_REDO_MAX,
  CONTEXT_ROLLBACK_REFUSAL_TEXT,
  cancelContextRollback,
  redoContextRollback,
  requestContextRollback,
  rollbackWorkLogInstructionPoints,
} from '../context-rollback';

const SID = 'a1b2c3d4-0000-4000-8000-000000000001';
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const A = (n: number, epoch = 0) => encodeContextAnchor({ sid: SID, epoch, uuid: U(n) });

function session(over: Partial<ConversationSession> = {}): ConversationSession {
  return {
    ownerId: 'U1',
    channelId: 'C1',
    threadTs: 'T1',
    sessionId: SID,
    compactionCount: 0,
    contextAnchor: A(9),
    ...over,
  } as unknown as ConversationSession;
}
let clock = 100;
const ok = { requestActive: false, transcriptHas: () => true, now: () => ++clock };

describe('Redo — a rollback is taken back until the next turn runs', () => {
  it('one rollback, one redo: nothing waits any more and the redo stack is empty', () => {
    const s = session();
    requestContextRollback(s, { anchor: A(3), label: '입력 직전: 배포해', source: 'input', keptUntil: 1 }, 'U1', ok);
    expect(s.rewindRedo).toEqual([null]);
    const r = redoContextRollback(s, 'U1', { requestActive: false });
    expect(r).toMatchObject({ ok: true, undone: { anchor: A(3) } });
    expect(r.ok && r.restored).toBeUndefined();
    expect(s.pendingRewind).toBeUndefined();
    expect(s.rewindRedo).toBeUndefined();
  });

  it('two rollbacks: redo goes back one step at a time', () => {
    const s = session();
    requestContextRollback(s, { anchor: A(5), label: 'first', source: 'worklog' }, 'U1', ok);
    requestContextRollback(s, { anchor: A(2), label: 'further', source: 'input' }, 'U1', ok);
    expect(s.pendingRewind?.label).toBe('further');
    const r1 = redoContextRollback(s, 'U1', { requestActive: false });
    expect(r1.ok && r1.restored?.label).toBe('first');
    expect(s.pendingRewind?.label).toBe('first');
    const r2 = redoContextRollback(s, 'U1', { requestActive: false });
    expect(r2.ok && r2.restored).toBeUndefined();
    expect(s.pendingRewind).toBeUndefined();
    expect(redoContextRollback(s, 'U1', { requestActive: false })).toEqual({ ok: false, reason: 'nothing-to-redo' });
  });

  it('owner only, never while a turn runs, and says so in words', () => {
    const s = session();
    requestContextRollback(s, { anchor: A(3), label: 'x', source: 'input' }, 'U1', ok);
    expect(redoContextRollback(s, 'U2', { requestActive: false })).toEqual({ ok: false, reason: 'not-owner' });
    expect(redoContextRollback(s, 'U1', { requestActive: true })).toEqual({ ok: false, reason: 'busy' });
    expect(s.pendingRewind?.anchor).toBe(A(3));
    expect(CONTEXT_ROLLBACK_REFUSAL_TEXT['nothing-to-redo']).toMatch(/되돌리기/);
  });

  it('a refused request leaves the redo stack alone', () => {
    const s = session();
    requestContextRollback(s, { anchor: A(3), label: 'x', source: 'input' }, 'U1', ok);
    requestContextRollback(s, { anchor: A(4), label: 'y', source: 'input' }, 'U2', ok);
    expect(s.rewindRedo).toEqual([null]);
  });

  it('cancel drops the waiting rollback and its redo history', () => {
    const s = session();
    requestContextRollback(s, { anchor: A(5), label: 'a', source: 'worklog' }, 'U1', ok);
    requestContextRollback(s, { anchor: A(3), label: 'b', source: 'input' }, 'U1', ok);
    expect(cancelContextRollback(s)).toBe(true);
    expect(s.pendingRewind).toBeUndefined();
    expect(s.rewindRedo).toBeUndefined();
  });

  it('the stack is bounded', () => {
    const s = session();
    for (let i = 0; i < CONTEXT_REWIND_REDO_MAX + 5; i++) {
      requestContextRollback(s, { anchor: A(1 + (i % 7)), label: `p${i}`, source: 'worklog' }, 'U1', ok);
    }
    expect(s.rewindRedo).toHaveLength(CONTEXT_REWIND_REDO_MAX);
  });
});

describe('the work log’s instructions are points: just before each person’s instruction', () => {
  it('a person’s instruction with a usable anchor on the active branch; system turns and the tail are not', () => {
    const s = session({ contextAnchor: A(9) });
    const points = rollbackWorkLogInstructionPoints(
      s,
      [
        { seq: 1, ts: 10, kind: 'instruction', text: '배포해', anchor: A(1), by: 'user' },
        { seq: 2, ts: 11, kind: 'narration', text: '네', anchor: A(2) },
        { seq: 3, ts: 12, kind: 'instruction', text: '[goal-continuation] …', anchor: A(2), by: 'system' },
        { seq: 4, ts: 13, kind: 'instruction', text: '롤백 테스트', anchor: A(4) },
        { seq: 5, ts: 14, kind: 'instruction', text: 'old', anchor: A(5, 3) }, // another epoch
        { seq: 6, ts: 15, kind: 'instruction', text: '지금', anchor: A(9) }, // the tail: nothing to drop
        { seq: 7, ts: 16, kind: 'instruction', text: 'dropped', anchor: A(7) },
      ],
      (uuid) => uuid !== U(7),
    );
    expect(points.map((p) => p.seq)).toEqual([1, 4]);
    expect(points[0]).toEqual({ seq: 1, ts: 10, text: '배포해', anchor: A(1) });
  });
});

describe('the view the rollback mode reads: every point, keyed to the entry it sits on', () => {
  it('inputs carry their turn id and full text; work-log points their seq; no cap at 20/30', () => {
    const s = session();
    const inputs = Array.from({ length: 40 }, (_, i) => ({
      turnId: `t${i}`,
      timestamp: 1000 + i,
      text: `지시 ${i}\n둘째 줄`,
      anchor: A(1 + (i % 8)),
    }));
    const worklog = Array.from({ length: 60 }, (_, i) => ({
      seq: i + 1,
      ts: 2000 + i,
      kind: 'narration',
      text: `응답 ${i}`,
      anchor: A(1 + (i % 8)),
    }));
    const v = buildRollbackPointsView(s, inputs, worklog, { actor: 'U1', requestActive: false });
    expect(v.inputs).toHaveLength(40);
    expect(v.worklog).toHaveLength(60);
    expect(v.inputs[0]).toEqual({
      turnId: 't0',
      anchor: A(1),
      label: '입력 직전: 지시 0',
      text: '지시 0\n둘째 줄',
      at: 1000,
    });
    expect(v.worklog[0]).toMatchObject({
      seq: 1,
      anchor: A(1),
      label: '응답까지: 응답 0',
      at: 2000,
      kind: 'narration',
    });
  });

  it('a work-log instruction is "just before it": it rolls back with its input’s time when they share the anchor', () => {
    const s = session();
    const v = buildRollbackPointsView(
      s,
      [{ turnId: 't1', timestamp: 990, text: '배포해', anchor: A(1) }],
      [],
      { actor: 'U1', requestActive: false },
      [
        { seq: 3, ts: 1000, text: '배포해', anchor: A(1) },
        { seq: 9, ts: 3000, text: '확인해', anchor: A(4) },
      ],
    );
    expect(v.instructions).toEqual([
      { seq: 3, anchor: A(1), label: '입력 직전: 배포해', text: '배포해', at: 990 },
      { seq: 9, anchor: A(4), label: '입력 직전: 확인해', text: '확인해', at: 3000 },
    ]);
  });

  it('carries the waiting rollback (what it keeps) and how many steps Redo can take back', () => {
    const s = session();
    requestContextRollback(s, { anchor: A(3), label: '입력 직전: x', source: 'input', keptUntil: 7 }, 'U1', ok);
    const v = buildRollbackPointsView(s, [], [], { actor: 'U1', requestActive: false });
    expect(v.pending).toMatchObject({ label: '입력 직전: x', keptUntil: 7, source: 'input' });
    expect(v.redo).toBe(1);
  });
});
