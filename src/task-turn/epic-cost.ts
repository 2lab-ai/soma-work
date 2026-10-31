/**
 * E4 ③ — what an epic tree has spent (.prd/19 D9 e): the cost cap's input.
 *
 * One formula for a task's spend, shared with the dashboard card
 * (`tokenUsageOf`): the task total (`taskUsage`, or the runtime total before
 * the task had one) plus the calls of the turn still running, priced at the
 * session model.
 */
import { sumLiveUsage } from '@soma/slack/live-usage';
import { calculateTokenCost } from '../metrics/model-registry';
import type { ArchivedSession } from '../session-archive';
import type { ConversationSession } from '../types';

type Spend = Pick<ConversationSession, 'taskUsage' | 'usage' | 'liveUsage' | 'model'>;

/** A task's spend in USD, as its card shows it. */
export function sessionCostUsd(s: Spend): number {
  const live = sumLiveUsage(s.liveUsage);
  const liveTokens = live.inputTokens + live.outputTokens + live.cacheReadTokens + live.cacheCreateTokens;
  const base = s.taskUsage ? s.taskUsage.costUsd || 0 : s.usage?.totalCostUsd || 0;
  const liveCost =
    liveTokens > 0
      ? calculateTokenCost(s.model, live.inputTokens, live.outputTokens, live.cacheReadTokens, live.cacheCreateTokens)
      : 0;
  return base + liveCost;
}

/** A closed task's spend, from its archive (whose task total already holds its last turn's calls). */
export function archivedCostUsd(archived: Pick<ArchivedSession, 'taskUsage' | 'usage'> | null | undefined): number {
  if (!archived) return 0;
  return archived.taskUsage ? archived.taskUsage.costUsd || 0 : archived.usage?.totalCostUsd || 0;
}

/**
 * An epic tree's spend: the epic, and every child it made (`childTaskIds` —
 * closed and archived children too, as the 7-child cap counts them): a live
 * child's current spend, or a closed one's from its latest archive.
 */
export function epicTreeCostUsd(
  epic: Spend & Pick<ConversationSession, 'childTaskIds'>,
  lookup: { live(taskId: string): Spend | undefined; archived(taskId: string): number },
): number {
  let total = sessionCostUsd(epic);
  for (const childId of epic.childTaskIds ?? []) {
    const live = lookup.live(childId);
    total += live ? sessionCostUsd(live) : lookup.archived(childId);
  }
  return total;
}
