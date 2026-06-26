/**
 * Action-id prefixes and `value` discriminator constants for the per-skill
 * overflow menu.
 */
export const MENU_ACTION_ID_PREFIX = 'user_skill_menu_';
export const LEGACY_INVOKE_ACTION_ID_PREFIX = 'user_skill_invoke_';

export const VALUE_KIND_INVOKE = 'user_skill_invoke';
export const VALUE_KIND_EDIT = 'user_skill_edit';
export const VALUE_KIND_DELETE = 'user_skill_delete';
export const VALUE_KIND_RENAME = 'user_skill_rename';
export const VALUE_KIND_SHARE = 'user_skill_share';
/**
 * Cross-user list verbs (S4). Rendered on a `$user:{otherUser}` list where the
 * clicker is browsing ANOTHER user's skills:
 *   - VIEW → show the SKILL.md (read-only, ephemeral).
 *   - COPY → install the skill into the clicker's own set (carries the origin
 *     owner via `copied_from`, see `copyUserSkill`).
 * Both carry an `ownerId` (the source user) in the action value alongside the
 * `requesterId` (the clicker who rendered the list).
 */
export const VALUE_KIND_VIEW = 'user_skill_view';
export const VALUE_KIND_COPY = 'user_skill_copy';
