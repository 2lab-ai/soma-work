import { setUserSkillRoundtripProviders } from '@soma/slack/user-skill-file-roundtrip';

import { computeContentHash, getUserSkill, MAX_SKILL_SIZE, updateUserSkill } from '../user-skill-store';

setUserSkillRoundtripProviders({
  readCurrentContent: (userId, skillName) => getUserSkill(userId, skillName)?.content ?? null,
  hashContent: computeContentHash,
  applyUpdate: updateUserSkill,
  getMaxSkillSize: () => MAX_SKILL_SIZE,
});

export * from '@soma/slack/user-skill-file-roundtrip';
