/**
 * Action-id prefixes and `value` discriminator constants for the per-skill
 * overflow menu.
 *
 * Lives in its own leaf module so the renderer
 * (`commands/user-skills-list-handler.ts`) can import them without forming a
 * `list-handler → menu-action-handler → view-submission-shared → list-handler`
 * cycle (#745).
 *
 * Pure string constants — no runtime dependencies.
 */

/**
 * Action_id prefixes for the per-skill accessory.
 *
 * Issue #750 promotes the single-button accessory to an overflow menu carrying
 * `발동` + `편집` for single-file skills (multi-file skills still get a plain
 * button). The new prefix `user_skill_menu_` covers overflow accessories;
 * `user_skill_invoke_` stays as the BC button prefix. `actions/index.ts`
 * registers two regexes (`/^user_skill_invoke_/` for legacy in-flight
 * messages, `/^user_skill_menu_/` for new ones) and routes both to the same
 * handler.
 */
export const MENU_ACTION_ID_PREFIX = 'user_skill_menu_';
export const LEGACY_INVOKE_ACTION_ID_PREFIX = 'user_skill_invoke_';

export const VALUE_KIND_INVOKE = 'user_skill_invoke';
export const VALUE_KIND_EDIT = 'user_skill_edit';

/**
 * Issue #774 additions — keep verbs alongside the existing pair so the
 * dispatch in `user-skill-menu-action-handler.handleAction` stays exhaustive
 * at compile time.
 *
 *   delete  → opens a confirmation modal (Slack overflow options can't carry
 *             their own confirm dialog, so a 2-step modal is the safest UX).
 *   rename  → opens a rename modal (single text input).
 *   share   → posts an ephemeral message with a four-backtick fenced code
 *             block carrying the SKILL.md content + install instructions.
 *             Read-only (does not fire system-prompt invalidation).
 */
export const VALUE_KIND_DELETE = 'user_skill_delete';
export const VALUE_KIND_RENAME = 'user_skill_rename';
export const VALUE_KIND_SHARE = 'user_skill_share';
