/**
 * Session notices — one-line host announcements in a session's thread (forced
 * `$skill` / autoskill RPG banners, goal-loop and autogoal notices) and the
 * single rule for where they go.
 *
 * Every notice is recorded in the conversation's work log as a `notice` at
 * every level: verbosity decides what reaches the thread, never what is
 * recorded (`packages/slack/src/work-log.ts`). Conversation-level — no
 * `turnId`; nothing without a `conversationId`. `recordConversationWorkLog`
 * swallows a throwing store.
 *
 * Spec 10 §3.2-5: at `minimal` the thread keeps only the header, task list,
 * final answer, choice/approval and errors. So a notice that is progress or
 * flavor is posted only when the session's mask carries its flag
 * (`announceSessionNotice`); a notice that carries a result or asks the user
 * to act is posted by its caller at every level and only recorded here
 * (`recordSessionNotice`).
 */

import { resolveVerbosityMask, shouldOutput } from '@soma/slack/output-flags';
import { recordConversationWorkLog } from '@soma/slack/pipeline/stream-executor';
import type { ConversationSession } from '../types';

/** The two session fields a notice needs: where it is recorded, and the thread's mask. */
type NoticeSession = Pick<ConversationSession, 'logVerbosity' | 'conversationId'>;

/** Record `text` as a `notice` in the session's conversation work log (no-op without one). */
export function recordSessionNotice(
  session: NoticeSession | undefined,
  text: string,
  logContext: { sessionKey?: string } = {},
): void {
  if (!session?.conversationId) return;
  recordConversationWorkLog(session.conversationId, { kind: 'notice', text }, logContext);
}

/**
 * Record `text` (see {@link recordSessionNotice}), then run `post` iff the
 * session's mask carries `flag`. A missing session or mask reads as the
 * default detail (`resolveVerbosityMask`). Records before the first await; a
 * `post` rejection propagates to the caller unchanged.
 */
export async function announceSessionNotice(
  session: NoticeSession | undefined,
  flag: number,
  text: string,
  post: () => Promise<unknown>,
  logContext: { sessionKey?: string } = {},
): Promise<void> {
  recordSessionNotice(session, text, logContext);
  if (!shouldOutput(flag, resolveVerbosityMask(session?.logVerbosity))) return;
  await post();
}
