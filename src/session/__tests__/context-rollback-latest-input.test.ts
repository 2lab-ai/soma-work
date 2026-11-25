/**
 * 되돌리기 모드 — the person's latest instruction is a point too (SSOT 2026-11-25: "되돌리기를 누르면 최근에
 * 내가 보낸 메세지도 선택할수 있어야함 … 맨 밑에 내가 보냈던 지시에 여기로 되돌리기가 나와야하고").
 *
 * Found on dev: an instruction stopped 22 s after it was sent left no reply, so no safe point after it —
 * its anchor (the point its turn started from) stayed the session's tail. The points left it out as "the
 * tail: nothing to drop", but its prompt was in the transcript after the tail: the next turn's model
 * answered "직전 '보드 전체 줄이기'는 취소하고 …". Rolling back to just before it does drop it.
 */

import { encodeContextAnchor } from '@soma/slack/context-anchor';
import { describe, expect, it } from 'vitest';
import type { ConversationTurn } from '../../conversation/types';
import type { ConversationSession } from '../../types';
import {
  buildRollbackPointsView,
  requestContextRollback,
  rollbackInputPoints,
  rollbackWorkLogInstructionPoints,
} from '../context-rollback';

const SID = 'a1b2c3d4-0000-4000-8000-000000000001';
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const A = (n: number) => encodeContextAnchor({ sid: SID, epoch: 0, uuid: U(n) });

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
const ok = { requestActive: false, transcriptHas: () => true, now: () => 500 };
const turn = (id: string, timestamp: number, anchor?: string): ConversationTurn => ({
  id,
  role: 'user',
  timestamp,
  rawContent: id,
  origin: { by: 'user' },
  ...(anchor ? { anchor } : {}),
});

describe('an instruction whose turn was stopped before any reply (its anchor is the tail)', () => {
  it('the conversation lists it — the latest instruction gets its button', () => {
    const s = session({ contextAnchor: A(9) });
    const points = rollbackInputPoints(s, {
      turns: [
        turn('earlier', 100, A(3)),
        { id: 'r', role: 'assistant', timestamp: 150, rawContent: '네' },
        turn('stopped', 200, A(9)),
      ],
    });
    expect(points.map((p) => p.turnId)).toEqual(['earlier', 'stopped']);
  });

  it('the work log lists it too', () => {
    const s = session({ contextAnchor: A(9) });
    const points = rollbackWorkLogInstructionPoints(s, [
      { seq: 1, ts: 100, kind: 'instruction', text: 'earlier', anchor: A(3), by: 'user' },
      { seq: 2, ts: 200, kind: 'instruction', text: 'stopped', anchor: A(9), by: 'user' },
      { seq: 3, ts: 201, kind: 'notice', text: 'aborted (user-stop)', anchor: A(9) },
    ]);
    expect(points.map((p) => p.seq)).toEqual([1, 2]);
  });

  it('an instruction a waiting rollback already starts from is not offered again', () => {
    const s = session({
      contextAnchor: A(9),
      pendingRewind: { anchor: A(3), label: 'x', requestedAt: 400, requestedBy: 'U1', source: 'input' },
    });
    const inputs = rollbackInputPoints(s, { turns: [turn('earlier', 100, A(3)), turn('stopped', 200, A(9))] });
    expect(inputs.map((p) => p.turnId)).toEqual(['stopped']);
    const rows = rollbackWorkLogInstructionPoints(s, [
      { seq: 1, ts: 100, kind: 'instruction', text: 'earlier', anchor: A(3), by: 'user' },
      { seq: 2, ts: 200, kind: 'instruction', text: 'stopped', anchor: A(9), by: 'user' },
    ]);
    expect(rows.map((p) => p.seq)).toEqual([2]);
  });

  it('the gate takes a rollback to just before it; a work-log point at the tail still changes nothing', () => {
    const s = session({ contextAnchor: A(9) });
    const r = requestContextRollback(
      s,
      { anchor: A(9), label: '입력 직전: stopped', source: 'input', keptUntil: 199 },
      'U1',
      ok,
    );
    expect(r.ok).toBe(true);
    expect(s.pendingRewind).toMatchObject({ anchor: A(9), source: 'input', keptUntil: 199 });
    expect(requestContextRollback(session(), { anchor: A(9), label: 'x', source: 'worklog' }, 'U1', ok)).toEqual({
      ok: false,
      reason: 'no-change',
    });
  });

  it('two instructions from the same point leave together: each carries the earlier one’s time', () => {
    // The stopped instruction, then the one sent after it: both started from A(9), so a rollback to just
    // before either resumes at A(9) and drops both (the chat hides both; the work log marks both).
    const v = buildRollbackPointsView(
      session({ contextAnchor: A(12) }),
      [
        { turnId: 'stopped', timestamp: 200, text: '잘못 보낸 지시', anchor: A(9) },
        { turnId: 'next', timestamp: 300, text: '이거 무시', anchor: A(9) },
      ],
      [],
      { actor: 'U1', requestActive: false },
      [
        { seq: 2, ts: 200, text: '잘못 보낸 지시', anchor: A(9) },
        { seq: 5, ts: 300, text: '이거 무시', anchor: A(9) },
      ],
    );
    expect(v.inputs.map((p) => p.at)).toEqual([200, 200]);
    expect(v.instructions.map((p) => p.at)).toEqual([200, 200]);
    // The instruction itself is still the one the composer gets back.
    expect(v.inputs[1].text).toBe('이거 무시');
  });
});
