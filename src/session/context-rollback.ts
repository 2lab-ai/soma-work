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
  encodeContextAnchor,
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
  /** The time of the last entry the rollback keeps (see `keptUntilOf`); marks what it drops. */
  keptUntil?: number;
}

/**
 * The last moment a rollback to a point keeps. An input point rolls back to
 * just before the input, so the input itself leaves; a work-log point and the
 * goal's first failure keep their own entry.
 */
export function keptUntilOf(source: PendingRewind['source'], at: number | undefined): number | undefined {
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return undefined;
  return source === 'input' ? at - 1 : at;
}

export interface ContextRollbackDeps {
  /** A turn holds the session's request slot (never cut a running turn). */
  requestActive: boolean;
  /** Does the SDK transcript of `sessionId` contain the chain entry `uuid`? Overrides the default (active-branch) check. */
  transcriptHas?: (sessionId: string, uuid: string) => boolean;
  /** The transcript text of `sessionId` (default: the SDK's `.jsonl`). */
  readTranscript?: (sessionId: string) => string | undefined;
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

/** The SDK transcript text of a session, or undefined. */
export function readTranscriptText(sessionId: string): string | undefined {
  try {
    const file = findTranscriptPath(sessionId);
    return file ? fs.readFileSync(file, 'utf8') : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The uuids on the active chain of a transcript: `tailUuid` and its ancestors by `parentUuid`.
 * After a `resumeSessionAt` rollback the SDK chains the next message to the rollback point, so
 * the dropped branch is no longer an ancestor of the tail. Undefined when the tail is unknown.
 */
export function activeChainUuids(text: string, tailUuid: string): Set<string> | undefined {
  const parent = new Map<string, string | null>();
  for (const line of text.split('\n')) {
    if (!line.includes('"uuid"')) continue;
    let e: { uuid?: unknown; parentUuid?: unknown } | null = null;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e && typeof e.uuid === 'string') parent.set(e.uuid, typeof e.parentUuid === 'string' ? e.parentUuid : null);
  }
  if (!parent.has(tailUuid)) return undefined;
  const chain = new Set<string>();
  let cur: string | null | undefined = tailUuid;
  while (cur && !chain.has(cur)) {
    chain.add(cur);
    cur = parent.get(cur) ?? null;
  }
  return chain;
}

/**
 * Is `uuid` on the active branch of the session's transcript? The tail is the session's latest
 * safe point; without one (or a tail the file lacks) only presence is checked. Fails closed.
 */
export function transcriptOnActiveChain(
  session: Pick<ConversationSession, 'sessionId' | 'contextAnchor'>,
  uuid: string,
  read: (sessionId: string) => string | undefined = readTranscriptText,
): boolean {
  if (!session.sessionId) return false;
  const text = read(session.sessionId);
  if (!text) return false;
  const tail = decodeContextAnchor(session.contextAnchor)?.uuid;
  const chain = tail ? activeChainUuids(text, tail) : undefined;
  return chain ? chain.has(uuid) : text.includes(`"uuid":"${uuid}"`);
}

/** A filter for the point lists: the uuid is on the active branch. Undefined = no filter (unknown). */
export function activeChainFilter(
  session: Pick<ConversationSession, 'sessionId' | 'contextAnchor'>,
  read: (sessionId: string) => string | undefined = readTranscriptText,
): ((uuid: string) => boolean) | undefined {
  const tail = decodeContextAnchor(session.contextAnchor)?.uuid;
  if (!session.sessionId || !tail) return undefined;
  const text = read(session.sessionId);
  const chain = text ? activeChainUuids(text, tail) : undefined;
  return chain ? (uuid: string) => chain.has(uuid) : undefined;
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
  // The point must be on the ACTIVE branch: after a rollback the dropped branch's uuids stay in
  // the file, but the SDK cannot resume there ("No message found with message.uuid").
  const has =
    deps.transcriptHas ?? ((_sid: string, u: string) => transcriptOnActiveChain(session, u, deps.readTranscript));
  if (!has(session.sessionId as string, uuid)) return { ok: false, reason: 'not-in-transcript' };
  const requestedAt = (deps.now ?? Date.now)();
  const kept = target.keptUntil;
  const rewind: PendingRewind = {
    anchor: target.anchor,
    label: target.label.slice(0, 300),
    requestedAt,
    requestedBy: actor,
    source: target.source,
    ...(typeof kept === 'number' && Number.isFinite(kept) && kept >= 0 && kept <= requestedAt
      ? { keptUntil: kept }
      : {}),
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
  'not-in-transcript':
    '모델 대화 기록의 현재 흐름에서 이 지점을 찾을 수 없어 되돌릴 수 없습니다 (이미 되돌려서 빠진 지점일 수 있습니다).',
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
  /** Keep only points on the active branch (`activeChainFilter`); absent = no filter. */
  onChain?: (uuid: string) => boolean,
  /** Anchors for inputs recorded without one, from the transcript (`inputAnchorsFromTranscript`). */
  derived?: ReadonlyMap<string, string>,
): RollbackInputPoint[] {
  if (!record) return [];
  const tail = turnStartAnchor(session);
  const out: RollbackInputPoint[] = [];
  for (const t of record.turns as ConversationTurn[]) {
    if (t.role !== 'user' || t.origin?.by === 'system') continue;
    const anchor = typeof t.anchor === 'string' ? t.anchor : derived?.get(t.id);
    if (!anchor || anchor === tail || anchorRefusal(session, anchor)) continue;
    if (onChain && !onChain(decodeContextAnchor(anchor)?.uuid ?? '')) continue;
    out.push({ turnId: t.id, timestamp: t.timestamp, text: t.rawContent, anchor });
  }
  return out;
}

type TranscriptEntry = {
  type?: string;
  subtype?: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  message?: { content?: unknown };
};

function blocks(e: TranscriptEntry): Array<{ type?: string }> {
  const c = e.message?.content;
  return Array.isArray(c) ? (c as Array<{ type?: string }>) : [];
}

/** A prompt the host sent (an input turn): text content, not a tool result, not SDK metadata. */
function isPrompt(e: TranscriptEntry): boolean {
  if (e.type !== 'user' || e.isMeta || e.isCompactSummary) return false;
  const c = e.message?.content;
  if (typeof c === 'string') return c.length > 0;
  const b = blocks(e);
  return b.some((x) => x.type === 'text') && !b.some((x) => x.type === 'tool_result');
}

/** A safe cut point: an assistant message with no tool_use, or a tool_result message. */
function isSafePoint(e: TranscriptEntry): boolean {
  if (e.type === 'assistant') return !blocks(e).some((x) => x.type === 'tool_use');
  return e.type === 'user' && blocks(e).some((x) => x.type === 'tool_result');
}

/**
 * Anchors for the record's inputs that were recorded without one (before anchors were kept, or
 * by an older build), read from the SDK transcript: on the active branch since the last
 * compaction, each prompt's "just before" point is the last safe chain point above it. Prompts
 * are matched to the record's turns by time (the prompt is written within seconds of the turn
 * being recorded). Returns turn id → anchor; empty when anything is unknown.
 */
export function inputAnchorsFromTranscript(
  session: Pick<ConversationSession, 'sessionId' | 'contextAnchor' | 'compactionCount'>,
  record: Pick<ConversationRecord, 'turns'> | null | undefined,
  text: string | undefined,
): Map<string, string> {
  const out = new Map<string, string>();
  const tail = decodeContextAnchor(session.contextAnchor)?.uuid;
  if (!record || !text || !tail || !session.sessionId) return out;
  const byUuid = new Map<string, TranscriptEntry>();
  for (const line of text.split('\n')) {
    if (!line.includes('"uuid"')) continue;
    try {
      const e = JSON.parse(line) as TranscriptEntry;
      if (e && typeof e.uuid === 'string') byUuid.set(e.uuid, e);
    } catch {
      // not an entry
    }
  }
  if (!byUuid.has(tail)) return out;
  // The active branch since the last compaction, oldest first.
  const chain: TranscriptEntry[] = [];
  for (let cur = byUuid.get(tail); cur; cur = cur.parentUuid ? byUuid.get(cur.parentUuid) : undefined) {
    if (cur.type === 'system' && cur.subtype === 'compact_boundary') break;
    chain.push(cur);
    if (chain.length > 200_000) break;
  }
  chain.reverse();
  const prompts: Array<{ ts: number; anchor: string }> = [];
  let lastSafe: string | undefined;
  for (const e of chain) {
    if (isPrompt(e)) {
      const ts = Date.parse(e.timestamp ?? '');
      if (lastSafe && Number.isFinite(ts)) {
        prompts.push({
          ts,
          anchor: encodeContextAnchor({ sid: session.sessionId, epoch: session.compactionCount ?? 0, uuid: lastSafe }),
        });
      }
    } else if (isSafePoint(e)) {
      lastSafe = e.uuid;
    }
  }
  const turns = [...(record.turns as ConversationTurn[])]
    .filter((t) => t.role === 'user')
    .sort((a, b) => a.timestamp - b.timestamp);
  let i = 0;
  for (const t of turns) {
    while (i < prompts.length && prompts[i].ts < t.timestamp - 2_000) i++;
    if (i < prompts.length && prompts[i].ts <= t.timestamp + 120_000) {
      if (typeof t.anchor !== 'string') out.set(t.id, prompts[i].anchor);
      i++;
    }
  }
  return out;
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
  /** A tool result's call (the `tool` entry with the same toolUseId), for its label. */
  call?: string;
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
  entries: ReadonlyArray<{ seq: number; ts: number; kind: string; text: string; anchor?: string; toolUseId?: string }>,
  /** Keep only points on the active branch (`activeChainFilter`); absent = no filter. */
  onChain?: (uuid: string) => boolean,
): RollbackWorkLogPoint[] {
  const tail = turnStartAnchor(session);
  const out: RollbackWorkLogPoint[] = [];
  let previous: string | undefined;
  const calls = new Map<string, string>();
  for (const e of entries) if (e.kind === 'tool' && e.toolUseId) calls.set(e.toolUseId, e.text);
  for (const e of [...entries].sort((a, b) => a.seq - b.seq)) {
    const anchor = typeof e.anchor === 'string' ? e.anchor : undefined;
    const moved = anchor !== undefined && anchor !== previous;
    if (anchor !== undefined) previous = anchor;
    if (!moved || !WORK_LOG_POINT_KINDS.has(e.kind)) continue;
    if (anchor === tail || anchorRefusal(session, anchor)) continue;
    if (onChain && !onChain(decodeContextAnchor(anchor)?.uuid ?? '')) continue;
    const call = e.kind === 'tool_result' && e.toolUseId ? calls.get(e.toolUseId) : undefined;
    out.push({ seq: e.seq, ts: e.ts, kind: e.kind, text: e.text, anchor, ...(call ? { call } : {}) });
  }
  return out;
}

/** What the picker and the rollback API answer for a session. */
export interface RollbackPointsView {
  /** Why nothing can be rolled back right now (busy, not the owner …); absent = it can. */
  refusal?: ContextRollbackRefusal;
  /** The refusal in the thread's words. */
  refusalText?: string;
  pending?: { label: string; requestedAt: number };
  inputs: Array<{ anchor: string; label: string; at: number }>;
  worklog: Array<{ anchor: string; label: string; at: number; kind: string }>;
}

/** "Bash {\"command\":\"npm test\"}" → "Bash · npm test": the tool and what it was asked to do. */
export function toolCallLabel(call: string, max = 80): string {
  const sp = call.indexOf(' ');
  const name = sp > 0 ? call.slice(0, sp) : call;
  const shortName = name.startsWith('mcp__') ? (name.split('__').pop() ?? name) : name;
  // The stored call is often cut short (invalid JSON): read the first useful string field as text.
  const m = (sp > 0 ? call.slice(sp + 1) : '').match(
    /"(command|description|file_path|path|pattern|url|query|text|prompt)"\s*:\s*"((?:[^"\\]|\\.)*)/,
  );
  let what = m ? m[2].replace(/\\n/g, ' ').replace(/\\(.)/g, '$1') : '';
  if (m?.[1] === 'command') what = what.replace(/^cd\s+\S+\s*&&\s*/, '');
  what = what.replace(/\s+/g, ' ').trim();
  return what ? rollbackInputLabel(`${shortName} · ${what}`, max) : shortName;
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
    ...(refusal ? { refusal, refusalText: CONTEXT_ROLLBACK_REFUSAL_TEXT[refusal] } : {}),
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
      label: `${WORK_LOG_KIND_LABEL[p.kind] ?? p.kind}까지: ${p.call ? toolCallLabel(p.call) : rollbackInputLabel(p.text)}`,
      at: p.ts,
      kind: p.kind,
    })),
  };
}
