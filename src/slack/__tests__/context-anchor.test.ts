/**
 * Context anchors (#743) — where the model's context can be cut. The rollback
 * resumes the next turn with `resumeSessionAt: <uuid>`; a cut between a
 * tool call and its result would leave a dangling tool_use, so only safe chain
 * points become anchors.
 */

import {
  anchorRefusal,
  type ContextAnchorSession,
  consumePendingRewind,
  decodeContextAnchor,
  encodeContextAnchor,
  resetChainTracking,
  trackChainPoint,
  turnStartAnchor,
} from '@soma/slack/context-anchor';
import { describe, expect, it } from 'vitest';

const SID = 'a1b2c3d4-0000-4000-8000-000000000001';
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function session(over: Partial<ContextAnchorSession> = {}): ContextAnchorSession {
  const s: ContextAnchorSession = { sessionId: SID, compactionCount: 0, ...over };
  resetChainTracking(s);
  return s;
}

const assistantText = (n: number) => ({
  type: 'assistant',
  uuid: U(n),
  message: { content: [{ type: 'text', text: 'hi' }] },
});
const assistantTool = (n: number, ...ids: string[]) => ({
  type: 'assistant',
  uuid: U(n),
  message: { content: ids.map((id) => ({ type: 'tool_use', id, name: 'Bash', input: {} })) },
});
const toolResult = (n: number, ...ids: string[]) => ({
  type: 'user',
  uuid: U(n),
  message: { content: ids.map((id) => ({ type: 'tool_result', tool_use_id: id, content: 'ok' })) },
});

describe('encode / decode', () => {
  it('round-trips', () => {
    const a = { sid: SID, epoch: 2, uuid: U(7) };
    expect(decodeContextAnchor(encodeContextAnchor(a))).toEqual(a);
  });
  it('rejects junk', () => {
    expect(decodeContextAnchor('nope')).toBeUndefined();
    expect(decodeContextAnchor(`${SID}~x~${U(1)}`)).toBeUndefined();
    expect(decodeContextAnchor(`${SID}~0~not-a-uuid`)).toBeUndefined();
    expect(decodeContextAnchor(42)).toBeUndefined();
  });
});

describe('trackChainPoint — only safe cut points', () => {
  it('a text-only assistant message is a cut point', () => {
    const s = session();
    expect(trackChainPoint(s, assistantText(1))).toBe(true);
    expect(decodeContextAnchor(s.contextAnchor)?.uuid).toBe(U(1));
  });

  it('a tool call is not; its result is', () => {
    const s = session();
    trackChainPoint(s, assistantText(1));
    expect(trackChainPoint(s, assistantTool(2, 't1'))).toBe(false);
    expect(decodeContextAnchor(s.contextAnchor)?.uuid).toBe(U(1));
    expect(trackChainPoint(s, toolResult(3, 't1'))).toBe(true);
    expect(decodeContextAnchor(s.contextAnchor)?.uuid).toBe(U(3));
  });

  it('parallel calls: only the result that answers the last open call', () => {
    const s = session();
    trackChainPoint(s, assistantTool(1, 'a'));
    trackChainPoint(s, assistantTool(2, 'b'));
    expect(trackChainPoint(s, toolResult(3, 'a'))).toBe(false);
    expect(trackChainPoint(s, toolResult(4, 'b'))).toBe(true);
    expect(decodeContextAnchor(s.contextAnchor)?.uuid).toBe(U(4));
  });

  it('ignores subagent frames, replays and echoed prompts', () => {
    const s = session();
    expect(trackChainPoint(s, { ...assistantText(1), parent_tool_use_id: 'toolu_x' })).toBe(false);
    expect(trackChainPoint(s, { ...assistantText(2), isReplay: true })).toBe(false);
    expect(trackChainPoint(s, { type: 'user', uuid: U(3), message: { content: [{ type: 'text', text: 'hi' }] } })).toBe(
      false,
    );
    expect(s.contextAnchor).toBeUndefined();
  });

  it('carries the session id and the compaction count', () => {
    const s = session({ compactionCount: 3 });
    trackChainPoint(s, assistantText(1));
    expect(decodeContextAnchor(s.contextAnchor)).toEqual({ sid: SID, epoch: 3, uuid: U(1) });
  });
});

describe('anchorRefusal', () => {
  it('usable in the same session and context', () => {
    const s = session();
    expect(anchorRefusal(s, encodeContextAnchor({ sid: SID, epoch: 0, uuid: U(1) }))).toBeUndefined();
  });
  it('refuses another session (/new, renew)', () => {
    expect(anchorRefusal(session(), encodeContextAnchor({ sid: 'other', epoch: 0, uuid: U(1) }))).toBe('other-session');
  });
  it('refuses an anchor from before a compaction', () => {
    expect(
      anchorRefusal(session({ compactionCount: 1 }), encodeContextAnchor({ sid: SID, epoch: 0, uuid: U(1) })),
    ).toBe('compacted');
  });
});

describe('consumePendingRewind — one-shot', () => {
  const rewind = (anchor: string) => ({
    anchor,
    label: 'x',
    requestedAt: 1,
    requestedBy: 'U1',
    source: 'input' as const,
  });

  it('returns the uuid, clears the request and moves the tail to the anchor', () => {
    const anchor = encodeContextAnchor({ sid: SID, epoch: 0, uuid: U(5) });
    const s = session({ contextAnchor: encodeContextAnchor({ sid: SID, epoch: 0, uuid: U(9) }) });
    s.pendingRewind = rewind(anchor);
    expect(turnStartAnchor(s)).toBe(anchor);
    expect(consumePendingRewind(s)?.uuid).toBe(U(5));
    expect(s.pendingRewind).toBeUndefined();
    expect(s.contextAnchor).toBe(anchor);
    expect(consumePendingRewind(s)).toBeUndefined();
  });

  it('a stale request (other session) is dropped without a resume point', () => {
    const s = session();
    s.pendingRewind = rewind(encodeContextAnchor({ sid: 'old', epoch: 0, uuid: U(5) }));
    expect(consumePendingRewind(s)).toBeUndefined();
    expect(s.pendingRewind).toBeUndefined();
  });
});
