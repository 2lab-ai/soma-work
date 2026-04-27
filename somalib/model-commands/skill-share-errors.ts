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
