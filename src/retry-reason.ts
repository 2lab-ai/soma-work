/** Upper bound for the error line a scheduled auto-resume carries to the dashboard card. */
export const RETRY_REASON_MAX_CHARS = 200;

/**
 * The one-line, bounded form of the error behind a scheduled auto-resume —
 * what the dashboard card prints next to "resumes at HH:MM". First non-empty
 * line, whitespace collapsed, cut at {@link RETRY_REASON_MAX_CHARS} with an
 * ellipsis. `undefined` when the error carries no text.
 */
export function retryReasonLine(err: unknown): string | undefined {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : String((err as { message?: unknown } | null | undefined)?.message ?? '');
  const line = raw
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return undefined;
  const flat = line.replace(/\s+/g, ' ');
  return flat.length > RETRY_REASON_MAX_CHARS ? `${flat.slice(0, RETRY_REASON_MAX_CHARS - 1)}…` : flat;
}
