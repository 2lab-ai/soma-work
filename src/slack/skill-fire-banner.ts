/**
 * Forced-skill banner — the red RPG attachment ("⚡ … *강제 발동*") that a
 * forced `$skill` or an autoskill fire announces itself with.
 *
 * Spec 10 §3.2-2: the banner is posted to the thread only when the session's
 * mask carries `SKILL_INVOCATION` (compact and above) — the same flag that
 * gates the model's own Skill banner in stream-processor. It is recorded in the
 * conversation's work log as a `notice` at every level (verbosity decides what
 * reaches the thread, never what is recorded — `packages/slack/src/work-log.ts`),
 * so at `minimal` the dashboard still shows the skill fired.
 *
 * Only the announcement is gated: the `<invoked_skills>` block that makes the
 * model execute the skill is the caller's and is appended at every level.
 */

import { OutputFlag, resolveVerbosityMask, shouldOutput } from '@soma/slack/output-flags';
import { recordConversationWorkLog } from '@soma/slack/pipeline/stream-executor';
import type { ConversationSession } from '../types';

/** Banner attachment as `ToolFormatter.formatSkillForceInvocationRPG` returns it. */
interface SkillFireBanner {
  text: string;
  color: string;
}

/**
 * Record `banner` in the session's conversation work log (no `turnId`; nothing
 * without a conversation), then post it through `post` iff the session's mask
 * carries `SKILL_INVOCATION`. A missing session or mask reads as the default
 * detail, so the banner is posted as before. Records before the first await;
 * a `post` rejection propagates to the caller unchanged.
 */
export async function announceForcedSkillFire(
  session: Pick<ConversationSession, 'logVerbosity' | 'conversationId'> | undefined,
  banner: SkillFireBanner,
  post: (attachment: SkillFireBanner) => Promise<unknown>,
  logContext: { sessionKey?: string } = {},
): Promise<void> {
  if (session?.conversationId) {
    recordConversationWorkLog(session.conversationId, { kind: 'notice', text: banner.text }, logContext);
  }
  if (!shouldOutput(OutputFlag.SKILL_INVOCATION, resolveVerbosityMask(session?.logVerbosity))) return;
  await post({ color: banner.color, text: banner.text });
}
