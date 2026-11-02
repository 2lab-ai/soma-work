/**
 * Context rollback requests (#743): who may ask, when, and to which points.
 */

import { encodeContextAnchor } from '@soma/slack/context-anchor';
import { describe, expect, it } from 'vitest';
import type { ConversationTurn } from '../../conversation/types';
import type { ConversationSession } from '../../types';
import {
  activeChainFilter,
  activeChainUuids,
  buildRollbackPointsView,
  cancelContextRollback,
  inputAnchorsFromTranscript,
  keptUntilOf,
  requestContextRollback,
  rollbackInputLabel,
  rollbackInputPoints,
  rollbackWorkLogPoints,
  toolCallLabel,
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

describe('what the rollback keeps (#744 marks what it dropped)', () => {
  it('a request carries keptUntil when it is a time up to now', () => {
    const s = session();
    requestContextRollback(s, { anchor: A(3), label: 'x', source: 'input', keptUntil: 4 }, 'U1', ok);
    expect(s.pendingRewind?.keptUntil).toBe(4);
    const later = session();
    requestContextRollback(later, { anchor: A(3), label: 'x', source: 'input', keptUntil: 99 }, 'U1', ok);
    expect(later.pendingRewind?.keptUntil).toBeUndefined();
    const bad = session();
    requestContextRollback(bad, { anchor: A(3), label: 'x', source: 'input', keptUntil: Number.NaN }, 'U1', ok);
    expect(bad.pendingRewind?.keptUntil).toBeUndefined();
  });

  it('an input is dropped with what came after it; a work-log point stays', () => {
    expect(keptUntilOf('input', 50)).toBe(49);
    expect(keptUntilOf('worklog', 50)).toBe(50);
    expect(keptUntilOf('goal', 50)).toBe(50);
    expect(keptUntilOf('input', undefined)).toBeUndefined();
    expect(keptUntilOf('worklog', 'x' as unknown as number)).toBeUndefined();
  });
});

describe('after a rollback, only the active branch can be rolled back to (found on dev, 2026-11-02)', () => {
  // A transcript where the context was rolled back to U(2): U(3)/U(4) are the dropped branch,
  // U(5)/U(6) the active one (the SDK chains the next message to the rollback point).
  const line = (uuid: string, parent: string | null) => JSON.stringify({ type: 'user', uuid, parentUuid: parent });
  const text = [
    line(U(1), null),
    line(U(2), U(1)),
    line(U(3), U(2)),
    line(U(4), U(3)),
    line(U(5), U(2)),
    line(U(6), U(5)),
    '{"type":"last-prompt"}',
  ].join('\n');

  it('the active chain is the tail and its ancestors', () => {
    expect([...(activeChainUuids(text, U(6)) ?? [])].sort()).toEqual([U(1), U(2), U(5), U(6)].sort());
    expect(activeChainUuids(text, U(9))).toBeUndefined();
  });

  it('the gate refuses a point on the dropped branch (the SDK would fail the turn: "No message found")', () => {
    const s = session({ contextAnchor: A(6) });
    const deps = { requestActive: false, readTranscript: () => text, now: () => 5 };
    expect(requestContextRollback(s, { anchor: A(4), label: 'x', source: 'worklog' }, 'U1', deps)).toEqual({
      ok: false,
      reason: 'not-in-transcript',
    });
    expect(requestContextRollback(s, { anchor: A(2), label: 'x', source: 'worklog' }, 'U1', deps).ok).toBe(true);
  });

  it('the lists leave the dropped branch out', () => {
    const s = session({ contextAnchor: A(6) });
    const onChain = activeChainFilter(s, () => text);
    expect(onChain).toBeDefined();
    const entries = [3, 4, 5].map((n, i) => ({
      seq: i + 1,
      ts: i + 1,
      kind: 'narration',
      text: `p${n}`,
      anchor: A(n),
    }));
    expect(rollbackWorkLogPoints(s, entries, onChain).map((p) => p.text)).toEqual(['p5']);
    const record = {
      turns: [3, 5].map((n) => ({
        id: `t${n}`,
        role: 'user',
        timestamp: n,
        rawContent: `in${n}`,
        anchor: A(n),
        origin: { by: 'user' },
      })),
    } as never;
    expect(rollbackInputPoints(s, record, onChain).map((p) => p.text)).toEqual(['in5']);
    // No transcript (or no tail) → no filter: the gate still checks presence.
    expect(activeChainFilter(session({ contextAnchor: undefined }), () => text)).toBeUndefined();
  });
});

describe('input points come from the transcript too — inputs recorded before anchors were kept (found on dev, 2026-11-02)', () => {
  const at = (sec: number) => new Date(Date.UTC(2026, 10, 2, 5, 0, sec)).toISOString();
  const e = (o: Record<string, unknown>) => JSON.stringify(o);
  // a1 (reply) → u1 prompt → a2 tool_use → r2 tool_result → a3 reply → s3 system → u2 prompt → a4 reply
  const text = [
    e({ type: 'system', subtype: 'compact_boundary', uuid: U(90), parentUuid: null }),
    e({ type: 'assistant', uuid: U(1), parentUuid: U(90), message: { content: [{ type: 'text', text: 'hi' }] } }),
    e({ type: 'user', uuid: U(11), parentUuid: U(1), timestamp: at(10), message: { content: 'deploy it' } }),
    e({
      type: 'assistant',
      uuid: U(2),
      parentUuid: U(11),
      message: { content: [{ type: 'tool_use', id: 't', name: 'Bash' }] },
    }),
    e({
      type: 'user',
      uuid: U(12),
      parentUuid: U(2),
      message: { content: [{ type: 'tool_result', tool_use_id: 't' }] },
    }),
    e({ type: 'assistant', uuid: U(3), parentUuid: U(12), message: { content: [{ type: 'text', text: 'done' }] } }),
    e({ type: 'system', uuid: U(13), parentUuid: U(3) }),
    e({
      type: 'user',
      uuid: U(14),
      parentUuid: U(13),
      timestamp: at(40),
      message: { content: [{ type: 'text', text: 'goal-continuation' }] },
    }),
    e({ type: 'assistant', uuid: U(4), parentUuid: U(14), message: { content: [{ type: 'text', text: 'ok' }] } }),
    e({ type: 'user', uuid: U(15), parentUuid: U(4), timestamp: at(70), message: { content: 'test again' } }),
    e({ type: 'assistant', uuid: U(5), parentUuid: U(15), message: { content: [{ type: 'text', text: 'ok' }] } }),
  ].join('\n');
  const ms = (sec: number) => Date.UTC(2026, 10, 2, 5, 0, sec);
  const record = {
    turns: [
      { id: 'i1', role: 'user', timestamp: ms(9), rawContent: 'deploy it', origin: { by: 'user' } },
      { id: 'g1', role: 'user', timestamp: ms(39), rawContent: '[goal-continuation] …', origin: { by: 'system' } },
      { id: 'i2', role: 'user', timestamp: ms(69), rawContent: 'test again', origin: { by: 'user' } },
    ],
  } as never;

  it('each input without a recorded anchor gets the last safe point before its prompt', () => {
    const s = session({ contextAnchor: A(5), compactionCount: 0 });
    const derived = inputAnchorsFromTranscript(s, record, text);
    expect(derived.get('i1')).toBe(A(1));
    expect(derived.get('i2')).toBe(A(4));
    const points = rollbackInputPoints(
      s,
      record,
      activeChainFilter(s, () => text),
      derived,
    );
    expect(points.map((p) => p.text)).toEqual(['deploy it', 'test again']);
    expect(points.map((p) => p.anchor)).toEqual([A(1), A(4)]);
  });

  it('no transcript, no tail, or a prompt before the compaction boundary → nothing derived', () => {
    expect(inputAnchorsFromTranscript(session({ contextAnchor: A(5) }), record, undefined).size).toBe(0);
    expect(inputAnchorsFromTranscript(session({ contextAnchor: undefined }), record, text).size).toBe(0);
  });

  it('a tool-result point is labelled with the call it answers, not "Bash ok"', () => {
    const s = session({ contextAnchor: A(9) });
    const entries = [
      {
        seq: 1,
        ts: 1,
        kind: 'tool',
        tool: 'Bash',
        toolUseId: 'x',
        text: 'Bash {"command":"npm test -- --run"}',
        anchor: A(2),
      },
      { seq: 2, ts: 2, kind: 'tool_result', tool: 'Bash', toolUseId: 'x', text: 'Bash ok', anchor: A(3) },
    ];
    const view = buildRollbackPointsView(s, [], rollbackWorkLogPoints(s, entries), {
      actor: 'U1',
      requestActive: false,
    });
    expect(view.worklog[0].label).toBe('툴 결과까지: Bash · npm test -- --run');
  });

  it('a call stored cut short still reads as its command; a `cd <dir> &&` prefix is dropped', () => {
    expect(
      toolCallLabel('Bash {"command":"cd /tmp/x/soma-work && git push -q origin HEAD:feat/a 2>&1 | tail -1; git ls-re'),
    ).toBe('Bash · git push -q origin HEAD:feat/a 2>&1 | tail -1; git ls-re');
    expect(toolCallLabel('mcp__slack-mcp__send_thread_message {"text":"배포 완료\\n다음 단계')).toBe(
      'send_thread_message · 배포 완료 다음 단계',
    );
    expect(toolCallLabel('Read {"file_path":"/a/b.ts"}')).toBe('Read · /a/b.ts');
  });
});
