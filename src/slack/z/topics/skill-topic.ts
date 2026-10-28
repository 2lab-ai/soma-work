/**
 * `/z skill` help-card topic — the help card's `skill` button opens the same lists the `skill`
 * command posts: the personal skill list replaces the help card, the environment skills follow.
 *
 * A list, not a setting: no `apply` (the card has no `z_setting_skill_set_*` buttons).
 */

import { type EnvSkillRegistry, envSkillRegistry } from '../../../env-skill-registry';
import type { ZTopicBinding } from '../../actions/z-settings-actions';
import { buildSkillListMessages } from '../../commands/skills-handler';

export function createSkillTopicBinding(
  envRegistry: () => EnvSkillRegistry = () => envSkillRegistry(undefined),
): ZTopicBinding {
  return {
    topic: 'skill',
    async renderCard({ userId }) {
      const [personal, env] = buildSkillListMessages(userId, envRegistry());
      return { ...personal, followUp: env };
    },
  };
}
