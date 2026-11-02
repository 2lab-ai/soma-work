/**
 * Context anchors — where the model's context can be cut and resumed.
 *
 * A context rollback (requested 2026-11-02: "채팅 내역을 이용하여 원하는 지점으로
 * 문맥 대화 롤백 기능 (대화해서 특정 유저의 입력 시점으로 롤백, 작업 로그에서 특정
 * 시점으로 롤백 2가지 지원") resumes the next turn with the Agent SDK's
 * `resumeSessionAt: <chain uuid>`: the session id stays, every transcript entry
 * after that uuid leaves the context, and later plain resumes stay on the
 * shortened branch (verified on SDK 0.3.284, 2026-11-02).
 *
 * Not every uuid is a good place to cut. Cutting after an assistant message
 * that called a tool but before its result leaves a dangling `tool_use`. So the
 * host tracks the latest SAFE chain entry of the main agent:
 *   - an assistant message with no `tool_use` block, or
 *   - the `tool_result` user message that answers the last outstanding call.
 * Subagent frames (`parent_tool_use_id` set) live in their own transcript and
 * are ignored.
 *
 * An anchor is bound to the SDK session id and to the session's compaction
 * count: a `/compact` replaces the context with a summary, so an anchor from
 * before it would resurrect the whole pre-compaction context (and a new
 * session — `/new`, renew — has a different id).
 *
 * Encoded as one short string so it fits any persisted field:
 * `<sessionId>~<compactionCount>~<uuid>`.
 */

export interface ContextAnchor {
  sid: string;
  epoch: number;
  uuid: string;
}

/** The session fields anchors read and write (a structural slice of ConversationSession). */
export interface ContextAnchorSession {
  sessionId?: string;
  compactionCount?: number;
  /** Latest safe chain point of the main agent, encoded. Persisted. */
  contextAnchor?: string;
  /** A rollback waiting for the next turn. Persisted. */
  pendingRewind?: PendingRewind;
  /** What applied rollbacks dropped from the context, oldest first (the dashboard marks it). Persisted. */
  contextRewinds?: ContextRewindRecord[];
}

/**
 * One applied rollback: entries and turns made after `from` and up to `to`
 * (when it was asked for — the session is idle until the next turn applies
 * it) left the model's context. `at` is when it was applied.
 */
export interface ContextRewindRecord {
  from: number;
  to: number;
  label: string;
  at: number;
}

/** Applied rollbacks a session keeps for the marks. */
export const CONTEXT_REWIND_HISTORY_MAX = 10;

/** A rollback requested by the owner, applied as `resumeSessionAt` on the next turn. */
export interface PendingRewind {
  anchor: string;
  /** What the owner picked, for the notice and the dashboard ("before: <input>"). */
  label: string;
  requestedAt: number;
  requestedBy: string;
  /** `input`: just before a user input. `worklog`: a point in the work log. `goal`: the goal's first failure. */
  source: 'input' | 'worklog' | 'goal';
  /**
   * The time of the last entry the rollback keeps: what was made after it
   * leaves the context. Absent when unknown (no marks are drawn then).
   */
  keptUntil?: number;
}

const SEP = '~';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeContextAnchor(a: ContextAnchor): string {
  return `${a.sid}${SEP}${a.epoch}${SEP}${a.uuid}`;
}

export function decodeContextAnchor(raw: unknown): ContextAnchor | undefined {
  if (typeof raw !== 'string') return undefined;
  const parts = raw.split(SEP);
  if (parts.length !== 3) return undefined;
  const [sid, epochText, uuid] = parts;
  const epoch = Number(epochText);
  if (!sid || !Number.isInteger(epoch) || epoch < 0 || !UUID_RE.test(uuid)) return undefined;
  return { sid, epoch, uuid };
}

/** Why an anchor cannot be used now (undefined = usable). */
export type AnchorRefusal = 'invalid' | 'other-session' | 'compacted';

export function anchorRefusal(session: ContextAnchorSession, raw: string | undefined): AnchorRefusal | undefined {
  const a = decodeContextAnchor(raw);
  if (!a) return 'invalid';
  if (!session.sessionId || a.sid !== session.sessionId) return 'other-session';
  if (a.epoch !== (session.compactionCount ?? 0)) return 'compacted';
  return undefined;
}

/**
 * The anchor a turn starts from — "just before this input". A rollback still
 * waiting for this turn wins: the turn will run from there.
 */
export function turnStartAnchor(session: ContextAnchorSession): string | undefined {
  return session.pendingRewind?.anchor ?? session.contextAnchor;
}

// Outstanding main-agent tool calls per session (runtime only — a turn that
// ends mid-call leaves its last safe point as the anchor, and the next turn's
// `system/init` resets the set).
const outstanding = new WeakMap<object, Set<string>>();

/** Call on the main agent's `system/init` (a new CLI turn). */
export function resetChainTracking(session: ContextAnchorSession): void {
  outstanding.set(session, new Set());
}

function blocksOf(raw: Record<string, unknown>): Array<Record<string, unknown>> {
  const message = raw.message as { content?: unknown } | undefined;
  return Array.isArray(message?.content) ? (message.content as Array<Record<string, unknown>>) : [];
}

/**
 * Feed every SDK message of a turn, in order. Updates `contextAnchor` when the
 * message is a safe chain point of the main agent. Returns whether it moved.
 */
export function trackChainPoint(session: ContextAnchorSession, raw: Record<string, unknown>): boolean {
  if (raw.parent_tool_use_id !== undefined && raw.parent_tool_use_id !== null) return false;
  if (raw.type !== 'assistant' && raw.type !== 'user') return false;
  if (raw.isReplay === true || raw.isSynthetic === true) return false;
  const uuid = typeof raw.uuid === 'string' ? raw.uuid : undefined;
  if (!uuid || !UUID_RE.test(uuid) || !session.sessionId) return false;
  let open = outstanding.get(session);
  if (!open) {
    open = new Set();
    outstanding.set(session, open);
  }
  const blocks = blocksOf(raw);
  if (raw.type === 'assistant') {
    for (const b of blocks) if (b.type === 'tool_use' && typeof b.id === 'string') open.add(b.id);
  } else {
    const results = blocks.filter((b) => b.type === 'tool_result');
    // A user frame that is not a tool result (a prompt the CLI echoed) is not a cut point.
    if (results.length === 0) return false;
    for (const b of results) if (typeof b.tool_use_id === 'string') open.delete(b.tool_use_id);
  }
  if (open.size > 0) return false;
  session.contextAnchor = encodeContextAnchor({
    sid: session.sessionId,
    epoch: session.compactionCount ?? 0,
    uuid,
  });
  return true;
}

/**
 * The next turn's query options: a pending rollback for THIS session becomes
 * `resumeSessionAt`. One-shot — the caller clears `pendingRewind` once the
 * options are built (a refused uuid fails that turn only, never every turn).
 * Returns the uuid to resume at, or undefined.
 */
export function consumePendingRewind(
  session: ContextAnchorSession,
  now: () => number = Date.now,
): { uuid: string; rewind: PendingRewind } | undefined {
  const rewind = session.pendingRewind;
  if (!rewind) return undefined;
  session.pendingRewind = undefined;
  if (anchorRefusal(session, rewind.anchor)) return undefined;
  const a = decodeContextAnchor(rewind.anchor) as ContextAnchor;
  // The conversation continues from the anchor: it is the new tail.
  session.contextAnchor = rewind.anchor;
  if (typeof rewind.keptUntil === 'number' && rewind.keptUntil <= rewind.requestedAt) {
    const span: ContextRewindRecord = {
      from: rewind.keptUntil,
      to: rewind.requestedAt,
      label: rewind.label,
      at: now(),
    };
    session.contextRewinds = [...(session.contextRewinds ?? []), span].slice(-CONTEXT_REWIND_HISTORY_MAX);
  }
  return { uuid: a.uuid, rewind };
}

/** Restore a persisted rollback request; anything malformed is dropped. */
export function sanitizePendingRewind(raw: unknown): PendingRewind | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (!decodeContextAnchor(r.anchor)) return undefined;
  if (r.source !== 'input' && r.source !== 'worklog' && r.source !== 'goal') return undefined;
  return {
    anchor: r.anchor as string,
    label: typeof r.label === 'string' ? r.label.slice(0, 300) : '',
    requestedAt: typeof r.requestedAt === 'number' ? r.requestedAt : 0,
    requestedBy: typeof r.requestedBy === 'string' ? r.requestedBy : '',
    source: r.source,
    ...(isTime(r.keptUntil) ? { keptUntil: r.keptUntil } : {}),
  };
}

function isTime(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/** Restore the persisted spans; malformed ones are dropped. */
export function sanitizeContextRewinds(raw: unknown): ContextRewindRecord[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ContextRewindRecord[] = [];
  for (const x of raw) {
    if (!x || typeof x !== 'object') continue;
    const r = x as Record<string, unknown>;
    if (!isTime(r.from) || !isTime(r.to) || !isTime(r.at) || r.from > r.to) continue;
    out.push({ from: r.from, to: r.to, label: typeof r.label === 'string' ? r.label.slice(0, 300) : '', at: r.at });
  }
  return out.length ? out.slice(-CONTEXT_REWIND_HISTORY_MAX) : undefined;
}
