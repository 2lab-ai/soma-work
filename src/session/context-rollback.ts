/**
 * Context rollback (#743) — the owner rolls the model's conversation context
 * back to an earlier point: just before one of their inputs, or a point in
 * the work log. The request is stored on the session (`pendingRewind`) and the
 * next turn resumes there (`resumeSessionAt`, applied once in
 * `ClaudeHandler.streamSdkQuery`). Files the model changed are NOT restored —
 * only what the model remembers.
 *
 * One function decides whether a rollback may be requested, for every surface
 * (the thread `rollback` command, the dashboard, the goal stall question).
 */

import * as fs from 'node:fs';
import {
  type AnchorRefusal,
  anchorRefusal,
  decodeContextAnchor,
  type PendingRewind,
  turnStartAnchor,
} from '@soma/slack/context-anchor';
import { findTranscriptPath } from '@soma/slack/pipeline/transcript-sanitizer';
import type { ConversationRecord, ConversationTurn } from '../conversation/types';
import type { ConversationSession } from '../types';

export type ContextRollbackRefusal =
  | AnchorRefusal
  | 'busy'
  | 'not-owner'
  | 'not-in-transcript'
  /** The target is the current tail: nothing to roll back. */
  | 'no-change';

export type ContextRollbackResult = { ok: true; rewind: PendingRewind } | { ok: false; reason: ContextRollbackRefusal };

export interface ContextRollbackTarget {
  anchor: string;
  label: string;
  source: PendingRewind['source'];
}

export interface ContextRollbackDeps {
  /** A turn holds the session's request slot (never cut a running turn). */
  requestActive: boolean;
  /** Does the SDK transcript of `sessionId` contain the chain entry `uuid`? */
  transcriptHas?: (sessionId: string, uuid: string) => boolean;
  now?: () => number;
}

/** Default transcript probe: the session's `.jsonl` lists the uuid. Fails closed. */
export function transcriptHasUuid(sessionId: string, uuid: string): boolean {
  try {
    const file = findTranscriptPath(sessionId);
    if (!file) return false;
    return fs.readFileSync(file, 'utf8').includes(`"uuid":"${uuid}"`);
  } catch {
    return false;
  }
}

/**
 * Ask for a rollback. Owner only, never while a turn runs, only to a cut point
 * of THIS SDK session and context (no `/compact`, `/new` or renew since), and
 * only to a point the transcript still has. Mutates the session on success;
 * the caller persists and tells the thread.
 */
export function requestContextRollback(
  session: ConversationSession,
  target: ContextRollbackTarget,
  actor: string,
  deps: ContextRollbackDeps,
): ContextRollbackResult {
  if (actor !== session.ownerId) return { ok: false, reason: 'not-owner' };
  if (deps.requestActive) return { ok: false, reason: 'busy' };
  const refusal = anchorRefusal(session, target.anchor);
  if (refusal) return { ok: false, reason: refusal };
  if (target.anchor === session.contextAnchor && !session.pendingRewind) return { ok: false, reason: 'no-change' };
  const { uuid } = decodeContextAnchor(target.anchor)!;
  const has = deps.transcriptHas ?? transcriptHasUuid;
  if (!has(session.sessionId as string, uuid)) return { ok: false, reason: 'not-in-transcript' };
  const rewind: PendingRewind = {
    anchor: target.anchor,
    label: target.label.slice(0, 300),
    requestedAt: (deps.now ?? Date.now)(),
    requestedBy: actor,
    source: target.source,
  };
  session.pendingRewind = rewind;
  return { ok: true, rewind };
}

/** Drop a rollback that has not run yet. Returns whether there was one. */
export function cancelContextRollback(session: ConversationSession): boolean {
  const had = !!session.pendingRewind;
  session.pendingRewind = undefined;
  return had;
}

/** One line per refusal, for the thread and the dashboard. */
export const CONTEXT_ROLLBACK_REFUSAL_TEXT: Record<ContextRollbackRefusal, string> = {
  busy: '작업이 진행 중이라 지금은 되돌릴 수 없습니다. 턴이 끝난 뒤 다시 시도하세요.',
  'not-owner': '세션 주인만 문맥을 되돌릴 수 있습니다.',
  invalid: '이 지점은 되돌릴 수 있는 기록이 없습니다.',
  'other-session': '이 지점은 이전 대화(new/renew 이전)라 되돌릴 수 없습니다.',
  compacted: '이 지점 뒤에 문맥 압축(/compact)이 있어 되돌릴 수 없습니다.',
  'not-in-transcript': '모델 대화 기록에서 이 지점을 찾을 수 없어 되돌릴 수 없습니다.',
  'no-change': '이미 이 지점이 마지막입니다 — 되돌릴 것이 없습니다.',
};

/** A user input the owner can roll back to (just before it). */
export interface RollbackInputPoint {
  turnId: string;
  timestamp: number;
  text: string;
  anchor: string;
}

/**
 * The person's inputs in this context that can be rolled back to, oldest
 * first: recorded with an anchor that is still usable. System turns (goal
 * continuations, resumes, compaction) are left out — the owner picks among
 * what they said.
 */
export function rollbackInputPoints(
  session: ConversationSession,
  record: Pick<ConversationRecord, 'turns'> | null | undefined,
): RollbackInputPoint[] {
  if (!record) return [];
  const tail = turnStartAnchor(session);
  return record.turns
    .filter(
      (t: ConversationTurn) =>
        t.role === 'user' &&
        t.origin?.by !== 'system' &&
        typeof t.anchor === 'string' &&
        t.anchor !== tail &&
        !anchorRefusal(session, t.anchor),
    )
    .map((t) => ({ turnId: t.id, timestamp: t.timestamp, text: t.rawContent, anchor: t.anchor as string }));
}

/** First line of an input, cut for a list or a notice. */
export function rollbackInputLabel(text: string, max = 80): string {
  const line = (text.split('\n').find((l) => l.trim()) ?? '').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line || '(빈 입력)';
}

/** A point in the work log the owner can roll back to (everything up to it stays). */
export interface RollbackWorkLogPoint {
  seq: number;
  ts: number;
  kind: string;
  text: string;
  anchor: string;
}

/** Work-log kinds that can mark a cut point — what the model said or got back. */
const WORK_LOG_POINT_KINDS = new Set(['narration', 'final', 'tool_result']);

/**
 * The work-log points of this context, oldest first: each is the first entry
 * made after the model reached a new safe cut point (a reply, or a tool result
 * that closed the open calls), so rolling back there keeps that entry and
 * everything before it. Entries without an anchor (older logs), from before a
 * compaction or another conversation, and the current tail are left out.
 */
export function rollbackWorkLogPoints(
  session: ConversationSession,
  entries: ReadonlyArray<{ seq: number; ts: number; kind: string; text: string; anchor?: string }>,
): RollbackWorkLogPoint[] {
  const tail = turnStartAnchor(session);
  const out: RollbackWorkLogPoint[] = [];
  let previous: string | undefined;
  for (const e of [...entries].sort((a, b) => a.seq - b.seq)) {
    const anchor = typeof e.anchor === 'string' ? e.anchor : undefined;
    const moved = anchor !== undefined && anchor !== previous;
    if (anchor !== undefined) previous = anchor;
    if (!moved || !WORK_LOG_POINT_KINDS.has(e.kind)) continue;
    if (anchor === tail || anchorRefusal(session, anchor)) continue;
    out.push({ seq: e.seq, ts: e.ts, kind: e.kind, text: e.text, anchor });
  }
  return out;
}

/** What the picker and the rollback API answer for a session. */
export interface RollbackPointsView {
  /** Why nothing can be rolled back right now (busy, not the owner …); absent = it can. */
  refusal?: ContextRollbackRefusal;
  pending?: { label: string; requestedAt: number };
  inputs: Array<{ anchor: string; label: string; at: number }>;
  worklog: Array<{ anchor: string; label: string; at: number; kind: string }>;
}

const WORK_LOG_KIND_LABEL: Record<string, string> = { narration: '응답', final: '최종 답', tool_result: '툴 결과' };

export function buildRollbackPointsView(
  session: ConversationSession,
  inputs: RollbackInputPoint[],
  worklog: RollbackWorkLogPoint[],
  gate: { actor: string | undefined; requestActive: boolean },
): RollbackPointsView {
  const refusal: ContextRollbackRefusal | undefined =
    gate.actor !== session.ownerId ? 'not-owner' : gate.requestActive ? 'busy' : undefined;
  return {
    ...(refusal ? { refusal } : {}),
    ...(session.pendingRewind
      ? { pending: { label: session.pendingRewind.label, requestedAt: session.pendingRewind.requestedAt } }
      : {}),
    inputs: inputs.slice(-20).map((p) => ({
      anchor: p.anchor,
      label: `입력 직전: ${rollbackInputLabel(p.text)}`,
      at: p.timestamp,
    })),
    worklog: worklog.slice(-30).map((p) => ({
      anchor: p.anchor,
      label: `${WORK_LOG_KIND_LABEL[p.kind] ?? p.kind}까지: ${rollbackInputLabel(p.text)}`,
      at: p.ts,
      kind: p.kind,
    })),
  };
}
