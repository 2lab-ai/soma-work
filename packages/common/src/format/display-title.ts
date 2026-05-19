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
