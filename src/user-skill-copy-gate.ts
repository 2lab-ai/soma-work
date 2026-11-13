/**
 * Permission gate for the `MANAGE_SKILL action=copy` model-command.
 *
 * Copying reads another user's SKILL.md, so — like the interactive use/view/
 * copy paths — it requires the owner's grant (codex review: the model-command
 * was a gate bypass). Unlike the Slack UI, a model-command has no channel to
 * post an interactive prompt, so a denial returns a message telling A to use
 * the `$user:<@owner>` list's copy button (which runs the request flow).
 */
import { isEnvironmentUser } from './env-users';
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
  // An environment user's skills run as the environment user; a copy would run them in the requester's session.
  if (isEnvironmentUser(sourceUid)) {
    return {
      ok: false,
      message: `환경 유저(\`${sourceUid}\`)의 스킬은 복사할 수 없습니다. \`$${sourceUid.slice(4)}:${name}\`로 실행을 요청하세요.`,
    };
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
