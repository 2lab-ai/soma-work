/**
 * Single-source-of-truth for the user-facing session title.
 *
 * Priority (#762):
 *   1. `summaryTitle`   — LLM-generated session summary (best signal).
 *   2. `links.issue.title` — fetched issue title (when an issue is linked).
 *   3. `links.pr.title`    — fetched PR title (when a PR is linked).
 *   4. `title`          — initial title set from the first user message.
 *   5. `'Untitled'`     — final fallback.
 *
 * Each tier is treated as missing when empty after `.trim()` so a stale
 * whitespace-only value doesn't shadow a useful lower tier.
 */
export interface DisplayTitleSource {
  summaryTitle?: string;
  title?: string;
  links?: {
    issue?: { title?: string };
    pr?: { title?: string };
  };
}

/**
 * Treat empty / whitespace-only strings as missing. Exported so
 * `link-derived-title.ts` (and any future title-source) shares one definition.
 */
export function nonBlank(value: string | undefined | null): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function displayTitle(session: DisplayTitleSource): string {
  return (
    nonBlank(session.summaryTitle) ??
    nonBlank(session.links?.issue?.title) ??
    nonBlank(session.links?.pr?.title) ??
    nonBlank(session.title) ??
    'Untitled'
  );
}

/**
 * Host-written stand-in titles. The host writes one of these only when it has
 * no real title to give a session:
 *   • `PLACEHOLDER_SESSION_TITLE` — the first message carried no usable text
 *     (voice memo / image / file only), a forced workflow, a dispatch wait
 *     timeout, or a dispatch title that sanitized to nothing.
 *   • `SESSION_RESET_TITLE` — re-dispatch after a context reset with no text.
 *   • `SKIP_DISPATCH_TITLE` — cron / auto-resume / goal turns that bypass the
 *     workflow classifier.
 *
 * A session wearing one of these has a dashboard card that says nothing about
 * the work, so the host asks the model to replace it once it knows the intent
 * (`packages/slack/src/pipeline/session-title-notice.ts`), and the fill-only
 * title write (`SessionRegistry.fillPlaceholderSessionTitle`) only overwrites
 * these. Producers must use the constants — a fourth literal copy would
 * silently fall out of both.
 */
export const PLACEHOLDER_SESSION_TITLE = 'New Session';
export const SESSION_RESET_TITLE = 'Session Reset';
export const SKIP_DISPATCH_TITLE = 'Direct (skipDispatch)';

const PLACEHOLDER_SESSION_TITLES: ReadonlySet<string> = new Set([
  PLACEHOLDER_SESSION_TITLE,
  SESSION_RESET_TITLE,
  SKIP_DISPATCH_TITLE,
]);

/**
 * True only for a host-written stand-in title. An empty title is NOT a stand-in:
 * empty titles belong to the per-turn summary fallback (src/index.ts
 * onSummaryGenerated), and claiming them here would race that path.
 */
export function isPlaceholderSessionTitle(title: string | undefined | null): boolean {
  const trimmed = nonBlank(title);
  return trimmed !== undefined && PLACEHOLDER_SESSION_TITLES.has(trimmed);
}
