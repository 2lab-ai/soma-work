/**
 * E4 ⑧ — what the board shows of an epic (.prd/19 D11), computed from the
 * server's records only: its state, its progress, and its plan tree with each
 * node's status and live children.
 *
 * The epic's own activity is `idle` while its children work, so its card reads
 * `epicState`:
 *   - `needs-input` — the epic or a child waits on its owner (a question), or a
 *     running child's approval is open (D5's `needs-input`);
 *   - `running` — the epic or a child is working;
 *   - `done` — the plan is done (`isEpicDone`) and nothing above holds;
 *   - `idle` — none of these.
 * An owner's attention comes first: `needs-input` wins over `running`.
 *
 * A child's activity is what the board shows for it (`activityOf`): a turn
 * blocked on a permission prompt reads `waiting`, an idle child with an armed
 * automatic resume reads `working` — its record's otherwise.
 */
import type { ConversationSession, EpicPlanNode } from '../types';
import { type EpicNodeStatus, epicNodeStatus, isEpicDone } from './epic-plan';

export type EpicState = 'running' | 'needs-input' | 'done' | 'idle';

export interface EpicBoardNode {
  id: string;
  title: string;
  kind: EpicPlanNode['kind'];
  parent?: string;
  status: EpicNodeStatus;
  accepted: boolean;
  /** Task ids of the node's live children. */
  childTaskIds: string[];
}

export interface EpicBoardView {
  state: EpicState;
  /** Accepted nodes of all nodes, and how many nodes are in each status. */
  progress: { accepted: number; total: number; byStatus: Partial<Record<EpicNodeStatus, number>> };
  nodes: EpicBoardNode[];
}

export interface EpicBoardOptions {
  /** The activity the board shows for a child; its record's when absent. */
  activityOf?: (child: ConversationSession) => ConversationSession['activityState'];
}

/** The board's view of one epic from its record and its live children (its own owner's only). */
export function epicBoardView(
  epic: ConversationSession,
  liveChildren: ConversationSession[],
  options: EpicBoardOptions = {},
): EpicBoardView {
  const children = liveChildren.filter((c) => c.parentTaskId === epic.taskId && c.ownerId === epic.ownerId);
  const activity = (c: ConversationSession) => options.activityOf?.(c) ?? c.activityState;
  const events = epic.epicEvents ?? [];
  const nodes: EpicBoardNode[] = (epic.plan?.nodes ?? []).map((n) => ({
    id: n.id,
    title: n.title,
    kind: n.kind,
    ...(n.parent ? { parent: n.parent } : {}),
    status: epicNodeStatus(n, children, events),
    accepted: n.accepted !== undefined,
    childTaskIds: children.filter((c) => c.planNodeId === n.id && c.taskId).map((c) => c.taskId as string),
  }));
  const byStatus: Partial<Record<EpicNodeStatus, number>> = {};
  for (const n of nodes) byStatus[n.status] = (byStatus[n.status] ?? 0) + 1;
  const waiting =
    epic.activityState === 'waiting' ||
    children.some((c) => activity(c) === 'waiting') ||
    nodes.some((n) => n.status === 'needs-input');
  const working = epic.activityState === 'working' || children.some((c) => activity(c) === 'working');
  const state: EpicState = waiting ? 'needs-input' : working ? 'running' : isEpicDone(epic.plan) ? 'done' : 'idle';
  return {
    state,
    progress: { accepted: nodes.filter((n) => n.accepted).length, total: nodes.length, byStatus },
    nodes,
  };
}
