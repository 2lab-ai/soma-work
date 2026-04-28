/**
 * Shared error / status messages for the MANAGE_SKILL `share` action.
 *
 * Two storage layers implement `SkillStore.shareSkill`:
 *   - `src/user-skill-store.ts` (in-process, used by the host app)
 *   - `somalib/model-commands/skill-file-store.ts` (standalone MCP)
 *
 * They MUST agree on user-facing strings so the model and Slack viewer see
 * the same wording regardless of which layer answered. Centralizing here
 * removes the only duplication that could let the two drift.
 *
 * The 2500-char cap is enforced at the dispatcher (`runModelCommand`) layer,
 * not here — but the over-limit message is composed using this constant so
 * the number can never disagree with the message.
 */

/** Maximum shareable content length, measured in characters (UTF-16 code units). */
export const SHARE_CONTENT_CHAR_LIMIT = 2500;

/**
 * Maximum skill-name length in characters. Owned here so both store
 * implementations (`src/user-skill-store.ts` and
 * `somalib/model-commands/skill-file-store.ts`) can import the same constant
 * instead of redeclaring it with a "kept in lockstep" comment that the
 * compiler can't enforce. See `MAX_SKILL_NAME_LENGTH` in `user-skill-store.ts`
 * for the original 64-char rationale (Slack overflow option text + action_id
 * caps).
 */
export const MAX_SKILL_NAME_LENGTH = 64;

export function invalidSkillNameMessage(name: string): string {
  return `Invalid skill name "${name}". Use kebab-case (e.g. my-deploy).`;
}

export function skillNotFoundMessage(name: string): string {
  return `Skill "${name}" not found.`;
}

export function shareSuccessMessage(name: string): string {
  return (
    `Skill "${name}" shared. ` +
    `Recipient: invoke MANAGE_SKILL with action='create', the same name, ` +
    `and the content payload to install this skill on your own account.`
  );
}

export function shareOverLimitMessage(name: string, length: number): string {
  return (
    `Skill "${name}" content (${length} chars) exceeds share limit ` +
    `(${SHARE_CONTENT_CHAR_LIMIT} chars). Trim the SKILL.md before sharing.`
  );
}

/**
 * Stable error codes for `SkillStore.renameSkill` failures.
 *
 * Owned here (not in catalog.ts) so both store implementations agree on the
 * machine-readable discriminant — the Slack rename modal switches on this
 * code to map storage errors onto inline `response_action: 'errors'` strings
 * without re-parsing prose.
 *
 *   NOT_FOUND  — source skill directory does not exist.
 *   EEXIST     — a skill with `newName` already exists (case-insensitive
 *                filesystems collapse `foo` and `Foo`, but the rename layer
 *                still uses a temp-staging step so `foo → Foo` is allowed
 *                provided no third skill named `Foo` exists).
 *   INVALID    — name violates the kebab-case predicate or the length cap,
 *                or oldName === newName (no-op rejected so callers don't
 *                accidentally fire invalidation hooks for a no-op).
 *   IO         — fs.rename or fs.rmdir threw despite the pre-checks.
 */
export type SkillRenameErrorCode = 'NOT_FOUND' | 'EEXIST' | 'INVALID' | 'IO';

export function skillRenameSuccessMessage(oldName: string, newName: string): string {
  return `Skill "${oldName}" renamed to "${newName}".`;
}

export function skillRenameTargetExistsMessage(newName: string): string {
  return `Skill "${newName}" already exists. Pick a different name or delete the existing one first.`;
}

export function skillRenameSameNameMessage(name: string): string {
  return `New name "${name}" is identical to the current name — nothing to do.`;
}

export function skillRenameSourceMissingMessage(name: string): string {
  return `Skill "${name}" not found.`;
}

export function skillRenameIoFailureMessage(oldName: string, newName: string): string {
  return `Failed to rename "${oldName}" to "${newName}" — filesystem error.`;
}
