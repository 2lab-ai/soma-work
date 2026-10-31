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

export interface SummaryTitleSession extends SummaryTitleTarget {
  slackless?: boolean;
}

export type SummaryTitleResult<S> =
  | { outcome: 'no-session' }
  | { outcome: 'kept'; sessionKey: string; session: S }
  | { outcome: 'applied'; sessionKey: string; session: S };

/**
 * Apply a turn summary's title to the session whose conversation it is. The
 * session is addressed by its registry key throughout, so a Slack-less task
 * (`task:<taskId>`, no channel/thread) works the same as a Slack session
 * (#615 R1); only a Slack session re-renders its thread.
 */
export function applySummaryTitle<S extends SummaryTitleSession>(
  registry: {
    getAllSessions(): Map<string, S>;
    updateSessionTitleByKey(sessionKey: string, title: string): void;
  },
  conversationId: string,
  summaryTitle: string,
  hooks: { renderThread(session: S): void; scheduleLiveUpdate(sessionKey: string): void },
): SummaryTitleResult<S> {
  const found = [...registry.getAllSessions()].find(([, s]) => s.conversationId === conversationId);
  if (!found) return { outcome: 'no-session' };
  const [sessionKey, session] = found;
  if (!canApplySummaryTitle(session)) return { outcome: 'kept', sessionKey, session };
  registry.updateSessionTitleByKey(sessionKey, summaryTitle);
  if (session.slackless !== true) hooks.renderThread(session);
  // The dashboard card shows the new headline now, not at the next poll.
  hooks.scheduleLiveUpdate(sessionKey);
  return { outcome: 'applied', sessionKey, session };
}
