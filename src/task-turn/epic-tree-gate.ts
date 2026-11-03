/**
 * #854 — an epic tree's limits on the Slack path (.prd/19 D9 c–e).
 *
 * An epic and its children are Slack sessions: each child is its own thread, and an instruction
 * to a child that is working waits in that thread's follow-up queue. What an epic may start on
 * its own (making a child, instructing an idle one, its own wake) still has the tree's bounds:
 *
 *   - at most `maxRunningChildren` children running at once (an instruction to a child that is
 *     already running only queues — it takes no new place);
 *   - at most `maxStartsPerWindow` host starts per `windowMs` in one tree;
 *   - no host start once the tree's spend (`epicTreeCostUsd`) reached its owner's limit.
 *
 * In memory: a restart forgets the window (it only ever lets more through, never fewer — the
 * running children and the spend are read live).
 */
import type { ConversationSession } from '../types';

export const EPIC_MAX_RUNNING_CHILDREN = 3;
export const EPIC_MAX_TREE_STARTS = 30;
export const EPIC_TREE_WINDOW_MS = 10 * 60_000;
export const DEFAULT_EPIC_COST_LIMIT = 50;

export interface EpicTreeGateDeps {
  getChildTasks(parentTaskId: string): ConversationSession[];
  /** A turn of this session runs now. */
  isRunning(session: ConversationSession): boolean;
  /** The tree's spend so far (the epic, its live children, its closed ones). */
  treeCostUsd(epic: ConversationSession): number;
  /** The owner's limit for one tree. */
  costLimitUsd(ownerId: string): number | undefined;
  now?: () => number;
  maxRunningChildren?: number;
  maxStartsPerWindow?: number;
  windowMs?: number;
}

export interface EpicTreeGate {
  /**
   * Why a host start in this epic's tree may not happen now, or undefined. `child`: the child a
   * turn would start in (instructing one); `newChild`: a child about to be made; neither: the
   * epic's own wake. `making`: children of this tree whose threads are being made right now — not
   * sessions yet, but each takes a running place (parallel `spawn_child` calls, review #872).
   */
  refusal(
    epic: ConversationSession,
    start: { child?: ConversationSession; newChild?: true; making?: number; pending?: number },
  ): string | undefined;
  /** Count a start in the tree's window. */
  record(epic: ConversationSession): void;
}

export function createEpicTreeGate(deps: EpicTreeGateDeps): EpicTreeGate {
  const now = deps.now ?? Date.now;
  const maxRunning = deps.maxRunningChildren ?? EPIC_MAX_RUNNING_CHILDREN;
  const maxStarts = deps.maxStartsPerWindow ?? EPIC_MAX_TREE_STARTS;
  const windowMs = deps.windowMs ?? EPIC_TREE_WINDOW_MS;
  /** Start times per tree (the epic's task id), newest last. */
  const starts = new Map<string, number[]>();

  const recent = (treeId: string, t: number) => (starts.get(treeId) ?? []).filter((at) => t - at < windowMs);

  return {
    refusal(epic, start) {
      const treeId = epic.taskId ?? '';
      const limit = deps.costLimitUsd(epic.ownerId ?? '') ?? DEFAULT_EPIC_COST_LIMIT;
      if (deps.treeCostUsd(epic) >= limit) {
        return `this epic reached its cost limit ($${limit}) — an instruction from its owner still runs`;
      }
      // Starts still being handed over (`making`) are not recorded yet, but they will be (review #872 R2).
      // Starts in flight not recorded yet: the ones taking a running place (`making`) and the ones
      // that do not (`pending` — a working child's queued word); `pending` includes `making` when given.
      if (recent(treeId, now()).length + (start.pending ?? start.making ?? 0) >= maxStarts) {
        return 'too many starts in this epic — try again shortly';
      }
      if (start.newChild || (start.child && !deps.isRunning(start.child))) {
        const running = deps
          .getChildTasks(treeId)
          .filter((c) => c !== start.child && c.taskId !== start.child?.taskId && deps.isRunning(c)).length;
        if (running + (start.making ?? 0) >= maxRunning) {
          return `at most ${maxRunning} children of an epic run at once — wait for one to finish`;
        }
      }
      return undefined;
    },
    record(epic) {
      const treeId = epic.taskId ?? '';
      const t = now();
      starts.set(treeId, [...recent(treeId, t), t]);
    },
  };
}
