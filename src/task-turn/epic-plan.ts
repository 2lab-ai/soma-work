/**
 * E4 ② — an epic's plan tree and event queue (.prd/19 D2 · D5 · D6 · D10 a).
 *
 * Pure functions over plain records; the registry stores what they return.
 *
 * - The plan is the epic's own record (`plan`): issue nodes, sub nodes under
 *   an issue, written only through `applyPlanWrite` — a checked replacement,
 *   not a free overwrite. A removed node's id is retired for good, so an
 *   event or child naming it can never land on a different node. The
 *   sanitizer for load keeps what is well formed.
 * - A node's status is never stored: it is computed from the live children
 *   the server recorded (`epicNodeStatus`), so a child's own words cannot
 *   move it. `accepted` is the epic's verdict on a node; `done` is the
 *   epic's (or all of at least one node accepted).
 * - Events (`epicEvents`) are what a child owes its epic: one per chain end,
 *   approval request or close, without any text the child produced.
 */
import type { ConversationSession, EpicEvent, EpicPlan, EpicPlanNode } from '../types';

/** A plan node id: a short slug, unique within its epic (the same rule as a child's `planNodeId`). */
export const EPIC_NODE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const EPIC_PLAN_MAX_NODES = 50;
export const EPIC_NODE_TITLE_MAX = 200;
export const EPIC_NODE_BODY_MAX = 2000;
/** A plan remembers at most this many removed node ids (D2: an id is never reused). */
export const EPIC_RETIRED_MAX = 200;
/** An epic keeps at most this many events (D6). */
export const EPIC_EVENTS_MAX = 100;

export type EpicNodeStatus =
  | 'none'
  | 'running'
  | 'needs-input'
  | 'finished'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'closed';

export type EpicPlanErrorCode =
  | 'bad-input'
  | 'too-many-nodes'
  | 'bad-id'
  | 'duplicate-id'
  | 'id-reused'
  | 'bad-title'
  | 'bad-body'
  | 'bad-kind'
  | 'bad-parent'
  | 'node-has-children'
  | 'children-running';

/** A refused plan write: nothing was changed. */
export class EpicPlanError extends Error {
  constructor(
    readonly code: EpicPlanErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EpicPlanError';
  }
}

/** What the epic's `plan_write` sends: the whole tree, plus verdicts. */
export interface PlanWriteInput {
  nodes: Array<{
    id: string;
    title: string;
    kind: 'issue' | 'sub';
    parent?: string;
    body?: string;
    /** true sets the verdict (kept if already set), false clears it, omitted keeps it. */
    accepted?: boolean;
  }>;
  /** true marks the epic done (refused while a child runs or waits), false clears it, omitted keeps it. */
  done?: boolean;
}

export interface PlanWriteContext {
  now: number;
  by: 'epic' | 'owner';
  /** The epic's live children: which node each was made for, and whether it is running or waiting. */
  children: Array<{ planNodeId?: string; active: boolean }>;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const verdictOf = (v: unknown): EpicPlanNode['accepted'] =>
  isObject(v) && (v.by === 'epic' || v.by === 'owner') && typeof v.at === 'number' && Number.isFinite(v.at)
    ? { by: v.by, at: v.at }
    : undefined;

/**
 * The plan after a write, or `EpicPlanError` (nothing changed). Rules:
 * at most 50 nodes; slug ids, unique; a non-empty title ≤ 200; a body ≤ 2,000;
 * an issue has no parent, a sub's parent is an issue of the same write; a node
 * that has (or had) a child cannot be removed; a removed node's id is retired
 * and never names another node; `accepted` survives a write that keeps the
 * node id; `spawned` and `retired` are the host's, never the writer's.
 */
export function applyPlanWrite(current: EpicPlan | undefined, input: PlanWriteInput, ctx: PlanWriteContext): EpicPlan {
  if (!isObject(input) || !Array.isArray(input.nodes)) throw new EpicPlanError('bad-input', 'nodes must be a list');
  if (input.nodes.length > EPIC_PLAN_MAX_NODES) {
    throw new EpicPlanError('too-many-nodes', `a plan has at most ${EPIC_PLAN_MAX_NODES} nodes`);
  }
  const previous = new Map((current?.nodes ?? []).map((n) => [n.id, n]));
  const retired = new Set(current?.retired ?? []);
  const ids = new Set<string>();
  for (const raw of input.nodes as unknown[]) {
    if (!isObject(raw)) throw new EpicPlanError('bad-input', 'a node must be an object');
    if (typeof raw.id !== 'string' || !EPIC_NODE_ID.test(raw.id)) {
      throw new EpicPlanError('bad-id', `node id ${String(raw.id)} is not a short lowercase slug`);
    }
    if (ids.has(raw.id)) throw new EpicPlanError('duplicate-id', `node id ${raw.id} is used twice`);
    if (retired.has(raw.id)) throw new EpicPlanError('id-reused', `node id ${raw.id} was removed and cannot be reused`);
    ids.add(raw.id);
  }
  const kinds = new Map<string, unknown>(input.nodes.map((n) => [n.id, n.kind]));
  const nodes: EpicPlanNode[] = input.nodes.map((raw) => {
    if (typeof raw.title !== 'string' || raw.title.trim() === '' || raw.title.length > EPIC_NODE_TITLE_MAX) {
      throw new EpicPlanError('bad-title', `node ${raw.id}: a title of 1–${EPIC_NODE_TITLE_MAX} characters`);
    }
    if (raw.body !== undefined && (typeof raw.body !== 'string' || raw.body.length > EPIC_NODE_BODY_MAX)) {
      throw new EpicPlanError('bad-body', `node ${raw.id}: a body of at most ${EPIC_NODE_BODY_MAX} characters`);
    }
    if (raw.kind !== 'issue' && raw.kind !== 'sub') throw new EpicPlanError('bad-kind', `node ${raw.id}: issue or sub`);
    if (raw.kind === 'issue' && raw.parent !== undefined) {
      throw new EpicPlanError('bad-parent', `node ${raw.id}: an issue has no parent`);
    }
    if (raw.kind === 'sub' && (typeof raw.parent !== 'string' || kinds.get(raw.parent) !== 'issue')) {
      throw new EpicPlanError('bad-parent', `node ${raw.id}: a sub hangs under an issue of this plan`);
    }
    const before = previous.get(raw.id);
    const accepted =
      raw.accepted === true
        ? (before?.accepted ?? { by: ctx.by, at: ctx.now })
        : raw.accepted === false
          ? undefined
          : before?.accepted;
    return {
      id: raw.id,
      title: raw.title,
      kind: raw.kind,
      ...(raw.kind === 'sub' ? { parent: raw.parent } : {}),
      ...(raw.body ? { body: raw.body } : {}),
      ...(accepted ? { accepted } : {}),
      ...(before?.spawned?.length ? { spawned: before.spawned } : {}),
    };
  });
  for (const gone of previous.values()) {
    if (ids.has(gone.id)) continue;
    const hasChild = (gone.spawned?.length ?? 0) > 0 || ctx.children.some((c) => c.planNodeId === gone.id);
    if (hasChild) throw new EpicPlanError('node-has-children', `node ${gone.id} has a child and cannot be removed`);
    retired.add(gone.id);
  }
  if (retired.size > EPIC_RETIRED_MAX) {
    throw new EpicPlanError('too-many-nodes', `a plan removes at most ${EPIC_RETIRED_MAX} node ids`);
  }
  let done = current?.done;
  if (input.done === true) {
    if (ctx.children.some((c) => c.active)) {
      throw new EpicPlanError('children-running', 'a child is still running or waiting — done refused');
    }
    done = done ?? { by: ctx.by, at: ctx.now };
  } else if (input.done === false) {
    done = undefined;
  }
  return { nodes, ...(done ? { done } : {}), ...(retired.size ? { retired: [...retired] } : {}) };
}

/** The epic is done: marked so, or at least one node and every node accepted (D10 a). */
export function isEpicDone(plan: EpicPlan | undefined): boolean {
  if (!plan) return false;
  if (plan.done) return true;
  return plan.nodes.length > 0 && plan.nodes.every((n) => n.accepted !== undefined);
}

/**
 * A node's status from the server's records only (D5): its live child's
 * state, or `closed` when every child it had is gone. A child that is not
 * running reads as its last chain result; a running one reads `needs-input`
 * while an approval it asked is open.
 */
export function epicNodeStatus(
  node: EpicPlanNode,
  liveChildren: Array<Pick<ConversationSession, 'taskId' | 'planNodeId' | 'activityState' | 'lastTurnOutcome'>>,
  events: EpicEvent[],
): EpicNodeStatus {
  const mine = liveChildren.filter((c) => c.planNodeId === node.id);
  const child = mine[mine.length - 1];
  if (!child) return (node.spawned?.length ?? 0) > 0 ? 'closed' : 'none';
  if (child.activityState === 'working') {
    const openApproval = events.some(
      (e) =>
        e.childTaskId === child.taskId && e.outcome === 'needs-input' && e.approvalId !== undefined && !e.resolvedAt,
    );
    return openApproval ? 'needs-input' : 'running';
  }
  switch (child.lastTurnOutcome?.outcome) {
    case 'completed':
      return 'finished';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'waiting':
      return 'needs-input';
    case 'interrupted':
      return 'interrupted';
    default:
      return 'none';
  }
}

/** A stored plan, or undefined: well-formed nodes only, subs whose issue survived, a valid verdict. */
export function sanitizeEpicPlan(value: unknown): EpicPlan | undefined {
  if (!isObject(value) || !Array.isArray(value.nodes)) return undefined;
  const nodes: EpicPlanNode[] = [];
  const seen = new Set<string>();
  for (const raw of value.nodes.slice(0, EPIC_PLAN_MAX_NODES)) {
    if (!isObject(raw) || typeof raw.id !== 'string' || !EPIC_NODE_ID.test(raw.id) || seen.has(raw.id)) continue;
    if (typeof raw.title !== 'string' || raw.title === '' || raw.title.length > EPIC_NODE_TITLE_MAX) continue;
    if (raw.kind !== 'issue' && raw.kind !== 'sub') continue;
    if (raw.body !== undefined && (typeof raw.body !== 'string' || raw.body.length > EPIC_NODE_BODY_MAX)) continue;
    const spawned = Array.isArray(raw.spawned)
      ? [...new Set(raw.spawned.filter((x): x is string => typeof x === 'string' && x !== ''))]
      : [];
    const accepted = verdictOf(raw.accepted);
    seen.add(raw.id);
    nodes.push({
      id: raw.id,
      title: raw.title,
      kind: raw.kind,
      ...(raw.kind === 'sub' && typeof raw.parent === 'string' ? { parent: raw.parent } : {}),
      ...(typeof raw.body === 'string' && raw.body ? { body: raw.body } : {}),
      ...(accepted ? { accepted } : {}),
      ...(spawned.length ? { spawned } : {}),
    });
  }
  const issues = new Set(nodes.filter((n) => n.kind === 'issue').map((n) => n.id));
  const kept = nodes.filter((n) => n.kind === 'issue' || (n.parent !== undefined && issues.has(n.parent)));
  const done = verdictOf(value.done);
  const live = new Set(kept.map((n) => n.id));
  const retired = Array.isArray(value.retired)
    ? [
        ...new Set(
          value.retired.filter((x): x is string => typeof x === 'string' && EPIC_NODE_ID.test(x) && !live.has(x)),
        ),
      ].slice(0, EPIC_RETIRED_MAX)
    : [];
  return { nodes: kept, ...(done ? { done } : {}), ...(retired.length ? { retired } : {}) };
}

const EVENT_OUTCOMES = new Set(['completed', 'failed', 'cancelled', 'waiting', 'interrupted', 'needs-input', 'closed']);

/**
 * Stored events, or undefined: well-formed only, at most `EPIC_EVENTS_MAX`.
 * Over the cap, delivered events go first, then the oldest — the newest of
 * every child stays.
 */
export function sanitizeEpicEvents(value: unknown): EpicEvent[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const str = (x: unknown): x is string => typeof x === 'string' && x !== '';
  const events: EpicEvent[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!isObject(raw) || !str(raw.id) || seen.has(raw.id) || !str(raw.childTaskId) || !str(raw.planNodeId)) continue;
    if (typeof raw.outcome !== 'string' || !EVENT_OUTCOMES.has(raw.outcome)) continue;
    if (typeof raw.at !== 'number' || !Number.isFinite(raw.at)) continue;
    if (raw.state !== 'pending' && raw.state !== 'delivered') continue;
    seen.add(raw.id);
    events.push({
      id: raw.id,
      childTaskId: raw.childTaskId,
      planNodeId: raw.planNodeId,
      outcome: raw.outcome as EpicEvent['outcome'],
      at: raw.at,
      state: raw.state,
      ...(str(raw.chainId) ? { chainId: raw.chainId } : {}),
      ...(str(raw.turnId) ? { turnId: raw.turnId } : {}),
      ...(str(raw.approvalId) ? { approvalId: raw.approvalId } : {}),
      ...(str(raw.consumedBy) ? { consumedBy: raw.consumedBy } : {}),
      ...(typeof raw.resolvedAt === 'number' && Number.isFinite(raw.resolvedAt) ? { resolvedAt: raw.resolvedAt } : {}),
    });
  }
  return events.length ? capEpicEvents(events) : undefined;
}

/** Keep at most `EPIC_EVENTS_MAX`: drop delivered first, then the oldest that is not a child's newest. */
export function capEpicEvents(events: EpicEvent[]): EpicEvent[] {
  if (events.length <= EPIC_EVENTS_MAX) return events;
  let kept = events.filter((e) => e.state !== 'delivered');
  if (kept.length <= EPIC_EVENTS_MAX) {
    const delivered = events.filter((e) => e.state === 'delivered').sort((a, b) => b.at - a.at);
    kept = [...kept, ...delivered.slice(0, EPIC_EVENTS_MAX - kept.length)];
    return events.filter((e) => kept.includes(e));
  }
  const newest = new Map<string, EpicEvent>();
  for (const e of kept) if ((newest.get(e.childTaskId)?.at ?? -1) <= e.at) newest.set(e.childTaskId, e);
  const protectedIds = new Set([...newest.values()].map((e) => e.id));
  const byAge = [...kept].sort((a, b) => a.at - b.at);
  const drop = new Set<string>();
  for (const e of byAge) {
    if (kept.length - drop.size <= EPIC_EVENTS_MAX) break;
    if (!protectedIds.has(e.id)) drop.add(e.id);
  }
  return kept.filter((e) => !drop.has(e.id));
}
