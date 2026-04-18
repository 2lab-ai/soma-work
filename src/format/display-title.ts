/**
 * Returns the best user-facing title for a session.
 * Preference order: auto-generated session summary title > raw first-message title > fallback 'Untitled'.
 */
export function displayTitle(session: { summaryTitle?: string; title?: string }): string {
  if (session.summaryTitle && session.summaryTitle.trim().length > 0) {
    return session.summaryTitle;
  }
  if (session.title && session.title.trim().length > 0) {
    return session.title;
  }
  return 'Untitled';
}
