/**
 * Context rollback requests (#743): who may ask, when, and to which points.
 */

import { encodeContextAnchor } from '@soma/slack/context-anchor';
import { describe, expect, it } from 'vitest';
import type { ConversationTurn } from '../../conversation/types';
import type { ConversationSession } from '../../types';
import {
  cancelContextRollback,
  requestContextRollback,
  rollbackInputLabel,
  rollbackInputPoints,
} from '../context-rollback';

const SID = 'a1b2c3d4-0000-4000-8000-000000000001';
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const A = (n: number, epoch = 0, sid = SID) => encodeContextAnchor({ sid, epoch, uuid: U(n) });

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

const ok = { requestActive: false, transcriptHas: () => true, now: () => 5 };

describe('requestContextRollback', () => {
  it('stores the request for the next turn', () => {
    const s = session();
    const r = requestContextRollback(s, { anchor: A(3), label: 'before: 배포해', source: 'input' }, 'U1', ok);
    expect(r.ok).toBe(true);
    expect(s.pendingRewind).toEqual({
      anchor: A(3),
      label: 'before: 배포해',
      requestedAt: 5,
      requestedBy: 'U1',
      source: 'input',
    });
  });

  it('owner only', () => {
    const r = requestContextRollback(session(), { anchor: A(3), label: 'x', source: 'input' }, 'U2', ok);
    expect(r).toEqual({ ok: false, reason: 'not-owner' });
  });

  it('never while a turn runs', () => {
    const r = requestContextRollback(session(), { anchor: A(3), label: 'x', source: 'input' }, 'U1', {
      ...ok,
      requestActive: true,
    });
    expect(r).toEqual({ ok: false, reason: 'busy' });
  });

  it('refuses a point from before a compaction or from another conversation', () => {
    expect(
      requestContextRollback(session({ compactionCount: 1 }), { anchor: A(3), label: 'x', source: 'input' }, 'U1', ok),
    ).toEqual({ ok: false, reason: 'compacted' });
    expect(
      requestContextRollback(session(), { anchor: A(3, 0, 'old-sid'), label: 'x', source: 'input' }, 'U1', ok),
    ).toEqual({ ok: false, reason: 'other-session' });
  });

  it('refuses a point the transcript does not have (the resume would fail the turn)', () => {
    const r = requestContextRollback(session(), { anchor: A(3), label: 'x', source: 'worklog' }, 'U1', {
      ...ok,
      transcriptHas: () => false,
    });
    expect(r).toEqual({ ok: false, reason: 'not-in-transcript' });
  });

  it('refuses the current tail (nothing to drop)', () => {
    const r = requestContextRollback(session(), { anchor: A(9), label: 'x', source: 'worklog' }, 'U1', ok);
    expect(r).toEqual({ ok: false, reason: 'no-change' });
  });

  it('cancel drops a waiting request', () => {
    const s = session();
    requestContextRollback(s, { anchor: A(3), label: 'x', source: 'input' }, 'U1', ok);
    expect(cancelContextRollback(s)).toBe(true);
    expect(s.pendingRewind).toBeUndefined();
    expect(cancelContextRollback(s)).toBe(false);
  });
});

describe('rollbackInputPoints — the inputs the owner can roll back before', () => {
  const turn = (id: string, over: Partial<ConversationTurn>): ConversationTurn => ({
    id,
    role: 'user',
    timestamp: 1,
    rawContent: id,
    ...over,
  });

  it('lists the person’s inputs with a usable anchor, oldest first', () => {
    const s = session({ compactionCount: 1, contextAnchor: A(9, 1) });
    const points = rollbackInputPoints(s, {
      turns: [
        turn('first', {}), // no anchor: the first input of the conversation
        turn('old', { anchor: A(1, 0) }), // before a compaction
        turn('a', { anchor: A(2, 1) }),
        turn('goal-continuation', { anchor: A(3, 1), origin: { by: 'system' } }),
        { id: 'reply', role: 'assistant', timestamp: 2, rawContent: 'ok' },
        turn('b', { anchor: A(4, 1), origin: { by: 'user' } }),
      ],
    });
    expect(points.map((p) => p.turnId)).toEqual(['a', 'b']);
    expect(points[1].anchor).toBe(A(4, 1));
  });

  it('labels an input by its first line', () => {
    expect(rollbackInputLabel('\n  배포해줘\n둘째 줄')).toBe('배포해줘');
    expect(rollbackInputLabel('x'.repeat(100), 10)).toHaveLength(10);
  });
});

describe('rollbackWorkLogPoints — the work-log points', () => {
  it('lists the first entry after each new cut point, model output only', async () => {
    const { rollbackWorkLogPoints } = await import('../context-rollback');
    const s = session({ contextAnchor: A(9) });
    const points = rollbackWorkLogPoints(s, [
      { seq: 1, ts: 1, kind: 'instruction', text: '배포해', anchor: A(1) },
      { seq: 2, ts: 2, kind: 'narration', text: '확인할게요', anchor: A(2) },
      { seq: 3, ts: 3, kind: 'tool', text: 'Bash ls', anchor: A(2) },
      { seq: 4, ts: 4, kind: 'tool_result', text: 'ok', anchor: A(3) },
      { seq: 5, ts: 5, kind: 'notice', text: 'n', anchor: A(4) },
      { seq: 6, ts: 6, kind: 'narration', text: 'more', anchor: A(4) },
      { seq: 7, ts: 7, kind: 'final', text: '끝', anchor: A(9) }, // the tail
      { seq: 8, ts: 8, kind: 'narration', text: 'old log', anchor: undefined },
    ]);
    expect(points.map((p) => p.seq)).toEqual([2, 4]);
  });
});

describe('buildRollbackPointsView', () => {
  it('says why a viewer cannot roll back and carries a waiting request', async () => {
    const { buildRollbackPointsView } = await import('../context-rollback');
    const s = session({
      pendingRewind: { anchor: A(2), label: '입력 직전: x', requestedAt: 3, requestedBy: 'U1', source: 'input' },
    });
    const v = buildRollbackPointsView(
      s,
      [{ turnId: 't', timestamp: 1, text: '배포해\n자세히', anchor: A(1) }],
      [{ seq: 2, ts: 2, kind: 'tool_result', text: 'ok', anchor: A(2) }],
      { actor: 'U2', requestActive: false },
    );
    expect(v.refusal).toBe('not-owner');
    expect(v.pending).toEqual({ label: '입력 직전: x', requestedAt: 3 });
    expect(v.inputs[0]).toEqual({ anchor: A(1), label: '입력 직전: 배포해', at: 1 });
    expect(v.worklog[0].label).toBe('툴 결과까지: ok');
    expect(buildRollbackPointsView(s, [], [], { actor: 'U1', requestActive: true }).refusal).toBe('busy');
  });
});
