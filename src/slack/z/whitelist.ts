/**
 * Naked command whitelist for the `/z` refactor.
 *
 * These are naked (no `/z` prefix) commands that continue to work alongside
 * their `/z` counterparts. Anything not on this list is cut off and shown a
 * tombstone hint once per user.
 *
 * See: plan/MASTER-SPEC.md §4 (Naked whitelist — user-modified exception).
 */

/**
 * Returns true if `text` matches one of the whitelisted naked commands.
 *
 * Matching rules (case-insensitive):
 *  - `session`
 *  - `sessions`
 *  - `sessions public`
 *  - `sessions terminate <key>`
 *  - `theme`
 *  - `theme set <name>`
 *  - `sessions theme [set <name>]`
 *  - `new` / `new <prompt>`
 *  - `renew` / `renew <prompt>`
 *  - `$` alone
 *  - `$model <v>`, `$verbosity <v>`, `$effort <v>`, `$thinking <v>`,
 *    `$thinking_summary <v>`  (each may also appear alone for status)
 */
export function isWhitelistedNaked(text: string): boolean {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return false;

  // $ prefix — $, $model [v], $verbosity [v], $effort [v], $thinking [v],
  // $thinking_summary [v]
  if (/^\$(?:model|verbosity|effort|thinking_summary|thinking)?(?:\s+\S+)?$/i.test(trimmed)) {
    return true;
  }

  // new / new <prompt>
  if (/^new(?:\s+[\s\S]*)?$/i.test(trimmed)) return true;

  // renew / renew <prompt>
  if (/^renew(?:\s+[\s\S]*)?$/i.test(trimmed)) return true;

  // session / sessions  (bare)
  if (/^sessions?$/i.test(trimmed)) return true;

  // sessions public
  if (/^sessions?\s+public$/i.test(trimmed)) return true;

  // sessions terminate <key>
  if (/^sessions?\s+terminate\s+\S+$/i.test(trimmed)) return true;

  // sessions theme [set X] / sessions theme=X
  if (/^sessions?\s+theme(?:\s+(?:set\s+)?\S+|\s*=\s*\S+)?$/i.test(trimmed)) return true;

  // theme / theme set X / theme=X / theme X
  if (/^theme(?:\s+(?:set\s+)?\S+|\s*=\s*\S+)?$/i.test(trimmed)) return true;

  // ui-test / ui-test stream / ui-test plan — Phase 0 of #525.
  // Handler (`UITestHandler`) gates env + admin + DM-only internally.
  // Slash `/z ui-test` is blocked via SLASH_FORBIDDEN (capability.ts).
  if (/^ui-test(?:\s+(?:stream|plan))?$/i.test(trimmed)) return true;

  return false;
}
