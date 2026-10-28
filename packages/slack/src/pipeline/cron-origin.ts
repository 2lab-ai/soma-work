/**
 * Cron origin of a synthetic message (SSOT 2026-10-23 T1).
 *
 * A cron fire (src/cron-scheduler.ts) injects a `skipDispatch` event carrying
 * the structured `cron: { jobId, jobName }` field. The dispatch-bypass branch
 * of SessionInitializer names the session it creates after the job instead of
 * the old fixed literal, and stamps the session so the dashboard can file it
 * under the job.
 *
 * Only the structured field counts: the injector and this pipeline ship in the
 * same build, so a second path that parses the `[cron:<name>]` text prefix
 * would only drift — and a user can type that prefix.
 */

/** Title every non-cron dispatch bypass (auto-resume, goal, incident) keeps. */
export const SKIP_DISPATCH_TITLE = 'Direct (skipDispatch)';

export interface CronOrigin {
  jobId?: string;
  jobName: string;
}

interface CronOriginSource {
  skipDispatch?: boolean;
  cron?: { jobId?: string; jobName?: string };
}

/** The cron job a dispatch-bypass event came from, or undefined for any other event. */
export function resolveCronOrigin(event: CronOriginSource): CronOrigin | undefined {
  if (!event.skipDispatch || !event.cron) return undefined;
  const jobName = typeof event.cron.jobName === 'string' ? event.cron.jobName.trim() : '';
  if (!jobName) return undefined;
  const jobId = typeof event.cron.jobId === 'string' && event.cron.jobId.trim() ? event.cron.jobId : undefined;
  return jobId ? { jobId, jobName } : { jobName };
}

/** Title the dispatch-bypass branch gives a fresh session. */
export function skipDispatchTitle(origin: CronOrigin | undefined): string {
  return origin ? origin.jobName : SKIP_DISPATCH_TITLE;
}
