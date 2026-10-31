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
/**
 * A plan remembers at most this many removed node ids (D2: an id is never
 * reused). Forgetting one would make it reusable, so past this a removal is
 * refused with its own code (`too-many-retired`).
 */
export const EPIC_RETIRED_MAX = 1000;
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
  | 'too-many-retired'
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
 * The one node check (D2: the sanitizer is the validator — load and write
 * share it): the code a write refuses a node with, or null. A sub's parent is
 * checked against the whole plan by the caller.
 */
function nodeProblem(raw: Record<string, unknown>): { code: EpicPlanErrorCode; message: string } | null {
  const id = String(raw.id);
  if (typeof raw.id !== 'string' || !EPIC_NODE_ID.test(raw.id)) {
    return { code: 'bad-id', message: `node id ${id} is not a short lowercase slug` };
  }
  if (typeof raw.title !== 'string' || raw.title.trim() === '' || raw.title.length > EPIC_NODE_TITLE_MAX) {
    return { code: 'bad-title', message: `node ${id}: a title of 1–${EPIC_NODE_TITLE_MAX} characters` };
  }
  if (raw.body !== undefined && (typeof raw.body !== 'string' || raw.body.length > EPIC_NODE_BODY_MAX)) {
    return { code: 'bad-body', message: `node ${id}: a body of at most ${EPIC_NODE_BODY_MAX} characters` };
  }
  if (raw.kind !== 'issue' && raw.kind !== 'sub') return { code: 'bad-kind', message: `node ${id}: issue or sub` };
  if (raw.kind === 'issue' && raw.parent !== undefined) {
    return { code: 'bad-parent', message: `node ${id}: an issue has no parent` };
  }
  if (raw.kind === 'sub' && typeof raw.parent !== 'string') {
    return { code: 'bad-parent', message: `node ${id}: a sub hangs under an issue of this plan` };
  }
  return null;
}

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
    const problem = nodeProblem(raw);
    if (problem) throw new EpicPlanError(problem.code, problem.message);
    const id = raw.id as string;
    if (ids.has(id)) throw new EpicPlanError('duplicate-id', `node id ${id} is used twice`);
    if (retired.has(id)) throw new EpicPlanError('id-reused', `node id ${id} was removed and cannot be reused`);
    ids.add(id);
  }
  const kinds = new Map<string, unknown>(input.nodes.map((n) => [n.id, n.kind]));
  const nodes: EpicPlanNode[] = input.nodes.map((raw) => {
    if (raw.kind === 'sub' && kinds.get(raw.parent as string) !== 'issue') {
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
    throw new EpicPlanError('too-many-retired', `a plan removes at most ${EPIC_RETIRED_MAX} node ids in its life`);
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
  liveChildren: Array<
    Pick<ConversationSession, 'taskId' | 'planNodeId' | 'activityState' | 'lastTurnOutcome' | 'openChain'>
  >,
  events: EpicEvent[],
): EpicNodeStatus {
  const mine = liveChildren.filter((c) => c.planNodeId === node.id);
  // One live child per node is the rule (spawn_child is idempotent per node); if there are
  // more, the one running speaks for the node, then one waiting, then the newest.
  const child =
    mine.find((c) => c.activityState === 'working') ??
    mine.find((c) => c.activityState === 'waiting') ??
    mine[mine.length - 1];
  if (!child) return (node.spawned?.length ?? 0) > 0 ? 'closed' : 'none';
  if (child.activityState === 'working') {
    const openApproval = events.some(
      (e) =>
        e.childTaskId === child.taskId &&
        e.outcome === 'needs-input' &&
        e.approvalId !== undefined &&
        !e.resolvedAt &&
        // An approval of an earlier chain (one a crash left open) is not this run's.
        e.chainId !== undefined &&
        e.chainId === child.openChain,
    );
    return openApproval ? 'needs-input' : 'running';
  }
  // The chain's result as its end was recorded (D5): a `/compact` end with nothing re-run is
  // `failed` though its hop completed — the event of that same outcome says so (fable #701 R1).
  const last = child.lastTurnOutcome;
  const end = last
    ? events.find(
        (e) =>
          e.childTaskId === child.taskId &&
          e.approvalId === undefined &&
          e.outcome !== 'closed' &&
          e.turnId === last.turnId,
      )
    : undefined;
  switch (end?.outcome ?? last?.outcome) {
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
  /** Slug ids of nodes this load dropped: retired, so a later write cannot hand them to another node. */
  const dropped = new Set<string>();
  for (const raw of value.nodes.slice(0, EPIC_PLAN_MAX_NODES)) {
    if (!isObject(raw) || seen.has(String(raw.id))) continue;
    if (nodeProblem(raw)) {
      if (typeof raw.id === 'string' && EPIC_NODE_ID.test(raw.id)) dropped.add(raw.id);
      continue;
    }
    if (typeof raw.id !== 'string' || typeof raw.title !== 'string' || (raw.kind !== 'issue' && raw.kind !== 'sub')) {
      continue;
    }
    const spawned = Array.isArray(raw.spawned)
      ? [...new Set(raw.spawned.filter((x): x is string => typeof x === 'string' && x !== ''))]
      : [];
    const accepted = verdictOf(raw.accepted);
    seen.add(raw.id);
    nodes.push({
      id: raw.id,
      title: raw.title,
      kind: raw.kind,
      ...(raw.kind === 'sub' ? { parent: raw.parent as string } : {}),
      ...(typeof raw.body === 'string' && raw.body ? { body: raw.body } : {}),
      ...(accepted ? { accepted } : {}),
      ...(spawned.length ? { spawned } : {}),
    });
  }
  const issues = new Set(nodes.filter((n) => n.kind === 'issue').map((n) => n.id));
  const kept = nodes.filter((n) => n.kind === 'issue' || (n.parent !== undefined && issues.has(n.parent)));
  for (const n of nodes) if (!kept.includes(n)) dropped.add(n.id);
  const done = verdictOf(value.done);
  const live = new Set(kept.map((n) => n.id));
  const stored = Array.isArray(value.retired) ? value.retired : [];
  const retired = [
    ...new Set(
      [...stored, ...dropped].filter((x): x is string => typeof x === 'string' && EPIC_NODE_ID.test(x) && !live.has(x)),
    ),
  ].slice(0, EPIC_RETIRED_MAX);
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
  // More children than the cap (none under the 7-child limit): the oldest go anyway — a cap is a cap.
  for (const e of byAge) {
    if (kept.length - drop.size <= EPIC_EVENTS_MAX) break;
    drop.add(e.id);
  }
  return kept.filter((e) => !drop.has(e.id));
}

/**
 * E4 ⑤ (D6) — the events with this one added, once: its id is deterministic
 * (a re-recorded end, or a restart's reconciliation of a held one, is the same
 * event), then held to the cap.
 */
export function withEpicEvent(events: EpicEvent[] | undefined, event: EpicEvent): EpicEvent[] {
  const list = events ?? [];
  if (list.some((e) => e.id === event.id)) return list;
  return capEpicEvents([...list, event]);
}

/** E4 ⑤ (D6) — the events with the open approval events `match` picks closed at `at` (and delivered). */
export function resolveEpicApprovals(
  events: EpicEvent[] | undefined,
  match: (e: EpicEvent) => boolean,
  at: number,
): EpicEvent[] | undefined {
  if (!events?.some((e) => e.outcome === 'needs-input' && !e.resolvedAt && match(e))) return events;
  // A closed approval wakes no one and is done: delivered, so the cap drops it before a pending
  // chain end (fable #701 R1).
  return events.map((e) =>
    e.outcome === 'needs-input' && !e.resolvedAt && match(e) ? { ...e, resolvedAt: at, state: 'delivered' } : e,
  );
}

/** E4 ⑥ (D7) — the word a chain end wakes its epic with. An approval (`needs-input`) and a close never wake. */
const WAKE_WORD: Partial<Record<EpicEvent['outcome'], string>> = {
  completed: 'finished',
  failed: 'failed',
  cancelled: 'cancelled',
  waiting: 'needs-input',
  interrupted: 'interrupted',
};

/**
 * E4 ⑥ (D7) — the events that wake an epic: its pending chain ends, in the order they came
 * (an approval is `needs-input` and a close `closed` — neither has a wake word).
 */
export function wakeableEpicEvents(events: EpicEvent[] | undefined): EpicEvent[] {
  return (events ?? []).filter((e) => e.state === 'pending' && WAKE_WORD[e.outcome] !== undefined);
}

/**
 * E4 ⑥ (D7) — the wake instruction, a fixed template: a count, node ids and
 * outcome words only. No title, question, reason or final — the details are
 * `child_status`'s. It never starts with `/` or `%`.
 */
export function epicWakeText(events: EpicEvent[]): string {
  const n = events.length;
  const items = events.map((e) => `${EPIC_NODE_ID.test(e.planNodeId) ? e.planNodeId : 'node'}:${WAKE_WORD[e.outcome]}`);
  return `Epic wake: ${n} event${n === 1 ? '' : 's'} — ${items.join(', ')}. Read details with child_status.`;
}

/** E4 ⑥ (D7) — the events with those `ids` still pending marked delivered to the chain `chainId`. */
export function consumeEpicEvents(
  events: EpicEvent[] | undefined,
  ids: readonly string[],
  chainId: string,
): EpicEvent[] | undefined {
  const take = new Set(ids);
  if (!events?.some((e) => take.has(e.id) && e.state === 'pending')) return events;
  return events.map((e) =>
    take.has(e.id) && e.state === 'pending' ? { ...e, state: 'delivered', consumedBy: chainId } : e,
  );
}

/** E4 ⑥ (D7) — a consuming chain reconciled `interrupted`: its events are pending again (they wake once more). */
export function releaseEpicEvents(events: EpicEvent[] | undefined, chainId: string): EpicEvent[] | undefined {
  if (!events?.some((e) => e.consumedBy === chainId)) return events;
  return events.map((e) => {
    if (e.consumedBy !== chainId) return e;
    const { consumedBy: _consumed, ...rest } = e;
    return { ...rest, state: 'pending' };
  });
}
