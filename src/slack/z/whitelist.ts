/**
 * Naked command whitelist for the `/z` refactor.
 *
 * These are naked (no `/z` prefix) commands that continue to work alongside
 * their `/z` counterparts. Anything not on this list is cut off and shown a
 * tombstone hint once per user.
 *
 * See: plan/MASTER-SPEC.md §4 (Naked whitelist — user-modified exception).
 */

import { stripZPrefix } from './strip-z-prefix';

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

  // ui-test / ui-test <stream|plan|task_card|work> — Phase 0 of #525.
  // Handler (`UITestHandler`) gates env + admin + DM-only internally.
  // Slash `/z ui-test` is blocked via SLASH_FORBIDDEN (capability.ts).
  if (/^ui-test(?:\s+(?:stream|plan|task_card|work))?$/i.test(trimmed)) return true;

  return false;
}

/**
 * `/z` topics that are considered "safe" for non-admin DM use.
 *
 * Derived from the registered topic set in `src/slack/z/topics/index.ts`.
 * Intentionally excludes:
 *  - session-creating topics that spawn a new AI session with the text as a
 *    prompt: `new`, `renew`, `compact`. These are the DM silent-drop vector
 *    Issue #553 targeted — non-admins must not be able to open prompt
 *    sessions via the `/z` surface.
 *  - topics that don't exist as first-class `/z` verbs: `thinking`,
 *    `thinking_summary`.
 *
 * Note: topics in the list (persona, model, verbosity, effort, theme, cwd,
 * email, memory, notify, sandbox, cct, bypass) configure user/session
 * settings and do NOT execute prompts. `persona`/`model`/etc. are explicit
 * settings topics surfaced to end users through the docs — keeping them
 * accessible from DM for non-admins is intentional and matches the SSOT:
 * "어드민이 아니면 프롬프트는 안받고 그냥 일반 커맨드만 받음 — 설정 처리나
 * 세션리스트 확인 등".
 *
 * Matched against the text AFTER `stripZPrefix()` has removed the `/z`
 * marker. The trailing `(?:\s+.*)?` allows subcommands/args (e.g.
 * `/z sessions public`, `/z theme set dark`, `/z model haiku`).
 */
const SAFE_Z_TOPICS =
  /^(?:help|sessions?|theme|persona|model|verbosity|effort|cwd|email|memory|notify|sandbox|cct|bypass)(?:\s+.*)?$/;

/**
 * Non-admin DM policy gate (Issue #553).
 *
 * Returns `true` when `text` is allowed for a non-admin user in a DM.
 * Allowed surface: safe `/z` topics, naked `sessions`/`theme`/`help`, and
 * the `%…` / `$…` session-config prefix. Plain prose and session-creating
 * commands (`new`, `renew`, prompts) are NOT allowed — the caller must
 * reject those with an ephemeral notice.
 *
 * Admin users bypass this gate entirely at the call site.
 */
export function isDmAllowedForNonAdmin(text: string): boolean {
  const raw = (text ?? '').trim();
  if (!raw) return false;

  // `/z …` surface — strip prefix then match against the safe topic list.
  const zStripped = stripZPrefix(raw);
  if (zStripped !== null) {
    const t = zStripped.trim().toLowerCase();
    if (!t) return true; // bare `/z` → help card
    return SAFE_Z_TOPICS.test(t);
  }

  // Naked surface — help / sessions / theme / %…$… only.
  const lower = raw.toLowerCase();
  if (/^help$/.test(lower)) return true;
  if (/^sessions?$/.test(lower)) return true;
  if (/^sessions?\s+public$/.test(lower)) return true;
  if (/^sessions?\s+terminate\s+\S+$/.test(lower)) return true;
  if (/^sessions?\s+theme(?:\s+(?:set\s+)?\S+|\s*=\s*\S+)?$/.test(lower)) return true;
  if (/^theme(?:\s+(?:set\s+)?\S+|\s*=\s*\S+)?$/.test(lower)) return true;
  // `%` is primary, `$` is deprecated (SessionCommandHandler still accepts both).
  if (/^[%$](?:model|verbosity|effort|thinking_summary|thinking)?(?:\s+\S+)?$/.test(lower)) return true;

  return false;
}
