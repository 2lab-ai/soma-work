import type { WorkLogEntry, WorkLogPage } from '../conversation/work-log';

/** How far back a turn's `final` is looked for, in pages of the latest window. */
const PAGE = 200;
const MAX_PAGES = 5;

type ReadWorkLog = (
  conversationId: string,
  options: { beforeSeq?: number; limit?: number },
) => Promise<Pick<WorkLogPage, 'entries' | 'hasMore'>>;

/**
 * E2 ⑤ — a task turn's answer for its instruction thread (.prd/18 D8, §6.3):
 * the main agent's last `final` entry of that same turn in the task's work
 * log. Never an earlier turn's answer, never a subagent's. The stored text is
 * the work log's (capped at 4,000 chars); `clipped` says the answer was longer
 * (the entry kept the whole text as its raw). Undefined when that turn wrote no
 * `final` within the pages looked at.
 */
export async function readTurnFinal(
  readWorkLog: ReadWorkLog,
  conversationId: string,
  turnId: string,
): Promise<{ text: string; clipped: boolean } | undefined> {
  let beforeSeq: number | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { entries, hasMore } = await readWorkLog(conversationId, {
      limit: PAGE,
      ...(beforeSeq !== undefined ? { beforeSeq } : {}),
    });
    for (let i = entries.length - 1; i >= 0; i--) {
      const e: WorkLogEntry = entries[i];
      if (e.kind === 'final' && e.turnId === turnId && !e.agentId) {
        return { text: e.text, clipped: e.rawBytes !== undefined };
      }
    }
    if (!hasMore || entries.length === 0) return undefined;
    beforeSeq = entries[0].seq;
  }
  return undefined;
}
