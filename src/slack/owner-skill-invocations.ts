/**
 * The skills a session owner invoked THEMSELVES — the only provenance the
 * auto-mode classifier trusts for a skill delegation (`SKILL_DELEGATIONS`):
 *
 *   • the `$skill` / `$local:skill` tokens in the owner's own prose (the host
 *     strips appended skill blocks before this sees it), and
 *   • the autoskills the owner registered — written only from the owner's own
 *     Slack command, buttons, or dashboard settings; no model path writes them.
 *
 * Never the `<invoked_skills>` text: a skill body can fake section boundaries,
 * and a skill's own `$refs` are expanded as dependencies the owner never typed
 * (review of 99f819c5, astra P1 ×2). Cross-user and plugin-qualified tokens are
 * left out — none of them is a delegation.
 */

import { resolveAutoskillContent } from '../skill-locator';
import { userSettingsStore } from '../user-settings-store';

export interface OwnerSkillDeps {
  /** The owner's registered autoskill names. */
  autoskills(owner: string): readonly string[];
  /**
   * `name` → the key it runs as (user → local → plugins, as `$skill` and
   * autoskill firing resolve it). Without an owner, user skills are skipped.
   */
  resolveKey(name: string, owner?: string): string | undefined;
}

const productionDeps: OwnerSkillDeps = {
  autoskills: (owner) => userSettingsStore.getUserAutoskills(owner),
  resolveKey: (name, owner) => resolveAutoskillContent(name, owner)?.key,
};

const LOCAL_REF = /\$local:([\w-]+)/g;
const BARE_REF = /\$([\w-]+)(?![\w-]*:)/g;

export function ownerInvokedSkills(
  owner: string,
  prose: readonly string[],
  deps: OwnerSkillDeps = productionDeps,
): string[] {
  const keys = new Set<string>();
  const add = (key: string | undefined) => {
    if (key) keys.add(key);
  };
  for (const name of deps.autoskills(owner)) add(deps.resolveKey(name, owner));
  for (const text of prose) {
    for (const m of text.matchAll(LOCAL_REF)) {
      const key = deps.resolveKey(m[1]);
      if (key === `local:${m[1]}`) add(key);
    }
    for (const m of text.matchAll(BARE_REF)) add(deps.resolveKey(m[1], owner));
  }
  return [...keys];
}
