/**
 * Which titles the turn-summary writer may replace (SSOT 2026-10-23 T2).
 *
 * The per-turn summary callback (`setOnSummaryGeneratedCallback` in
 * src/index.ts) used to treat any title other than the conversation id as
 * deliberate, so a cron session never left its first title. A provisional
 * title — a cron job's name, set until the work names itself — is replaceable;
 * a deliberate title still is not.
 */
export interface SummaryTitleTarget {
  title?: string;
  conversationId?: string;
  titleProvisional?: boolean;
}

export function canApplySummaryTitle(session: SummaryTitleTarget): boolean {
  if (!session.title) return true;
  if (session.title === session.conversationId) return true;
  return session.titleProvisional === true;
}
