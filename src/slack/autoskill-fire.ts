/**
 * Autoskill firing — build the visible force-invocation payload for a user's
 * registered autoskills.
 *
 * This is the `$skill`-equivalent for autoskills: instead of silently embedding
 * skill content in the system prompt, the registered autoskills are *fired* on
 * the first turn of a new session — exactly like the user had typed
 * `$using-ssot $using-govuk`. The caller (slack-handler) posts the RPG banner
 * and appends `invokedBlock` to that turn's dispatch prompt so the model
 * actually executes the skills.
 *
 * The `<invoked_skills>` block format is byte-identical to
 * `SkillForceHandler.execute` so the model sees the same structure whether a
 * skill was fired manually or via autoskill.
 */

import { resolveAutoskillContent } from '../skill-locator';
import { userSettingsStore } from '../user-settings-store';
import { ToolFormatter } from './tool-formatter';

export interface AutoskillFire {
  /** Canonical `<namespace>:<name>` keys that resolved (for logging/banner). */
  keys: string[];
  /** `<invoked_skills>…</invoked_skills>` block to append to the dispatch prompt. */
  invokedBlock: string;
  /** RPG banner attachment (text + color) to post before dispatch. */
  banner: { text: string; color: string };
}

/**
 * Build the autoskill force-fire payload for `userId`. Returns null when the
 * user has no registered autoskills or none of them resolve on disk (caller
 * fires nothing). `casterName` is the Slack mention shown in the banner.
 */
export function buildAutoskillFire(userId: string, casterName: string): AutoskillFire | null {
  const names = userSettingsStore.getUserAutoskills(userId);
  if (names.length === 0) return null;

  const blocks: string[] = [];
  const keys: string[] = [];
  for (const name of names) {
    const resolved = resolveAutoskillContent(name, userId);
    if (!resolved) continue; // skip unresolvable names silently (same as $skill)
    blocks.push(`<${resolved.key}>\n${resolved.content}\n</${resolved.key}>`);
    keys.push(resolved.key);
  }
  if (blocks.length === 0) return null;

  const invokedBlock = `<invoked_skills>\n${blocks.join('\n')}\n</invoked_skills>`;
  const banner = ToolFormatter.formatSkillForceInvocationRPG(keys, casterName);
  return { keys, invokedBlock, banner };
}
