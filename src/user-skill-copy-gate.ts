/**
 * Permission gate for the `MANAGE_SKILL action=copy` model-command.
 *
 * Copying reads another user's SKILL.md, so — like the interactive use/view/
 * copy paths — it requires the owner's grant (codex review: the model-command
 * was a gate bypass). Unlike the Slack UI, a model-command has no channel to
 * post an interactive prompt, so a denial returns a message telling A to use
 * the `$user:<@owner>` list's copy button (which runs the request flow).
 */
import { resolveUserIdentifier } from './slack/commands/user-identity-resolver';
import { consumeOneTimeGrant, isSkillUseAllowed } from './user-skill-grants-store';
import { copyUserSkill } from './user-skill-store';

export function gatedManageSkillCopy(
  user: string,
  sourceUser: string,
  name: string,
  newName?: string,
): { ok: boolean; message: string } {
  const sourceUid = resolveUserIdentifier(sourceUser);
  if (!sourceUid) {
    return { ok: false, message: `Source user "${sourceUser}" not found.` };
  }
  if (sourceUid === user) {
    return { ok: false, message: 'Cannot copy your own skill.' };
  }
  if (!isSkillUseAllowed(sourceUid, name, user)) {
    return {
      ok: false,
      message:
        `<@${sourceUid}>님의 허락이 필요합니다. Slack에서 \`$user:<@${sourceUid}>\` 목록을 열어 ` +
        `\`${name}\` 의 '📋 복사' 를 눌러 권한을 요청하세요.`,
    };
  }
  const result = copyUserSkill(sourceUid, name, user, newName);
  // Strict single-use: a one-time grant that authorized this copy is spent now.
  if (result.ok) consumeOneTimeGrant(sourceUid, name, user);
  return result;
}
