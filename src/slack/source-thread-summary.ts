/**
 * Source Thread Summary — posts work summary back to the original thread
 * when a mid-thread-created session completes (PR merge or session close).
 *
 * Issue #64: mid-thread 멘션 시 초기 응답 유지 + 원본 스레드 추적
 */

import { ConversationSession } from '../types';
import { SlackApiHelper } from './slack-api-helper';
import { Logger } from '../logger';

const logger = new Logger('SourceThreadSummary');

/**
 * Post a work summary to the original (source) thread.
 * Fire-and-forget: errors are logged but never thrown.
 *
 * @param slackApi - Slack API helper
 * @param session - The session that completed
 * @param trigger - What triggered the summary ('merged' | 'closed')
 */
export async function postSourceThreadSummary(
  slackApi: SlackApiHelper,
  session: ConversationSession,
  trigger: 'merged' | 'closed'
): Promise<void> {
  if (!session.sourceThread) {
    return;
  }

  try {
    const { channel, threadTs } = session.sourceThread;

    // Build summary lines
    const icon = trigger === 'merged' ? '✅' : '🔚';
    const verb = trigger === 'merged' ? '작업 완료 (PR merged)' : '세션 종료';
    const lines: string[] = [
      `${icon} *"${session.title || 'Untitled'}"* ${verb}`,
    ];

    if (session.links?.issue?.url) {
      lines.push(`📌 *이슈*: <${session.links.issue.url}|${session.links.issue.label || 'Issue'}>`);
    }

    if (session.links?.pr?.url) {
      lines.push(`🔀 *PR*: <${session.links.pr.url}|${session.links.pr.label || 'PR'}>`);
    }

    if (session.workflow) {
      lines.push(`📊 *워크플로우*: \`${session.workflow}\``);
    }

    // Build work thread permalink
    const sessionChannel = session.channelId;
    const sessionThreadTs = session.threadRootTs || session.threadTs;
    if (sessionChannel && sessionThreadTs) {
      const permalink = await slackApi.getPermalink(sessionChannel, sessionThreadTs);
      if (permalink) {
        lines.push(`🧵 *작업 스레드*: <${permalink}|열기>`);
      } else {
        logger.warn('Failed to get permalink for work thread in summary', {
          sessionChannel,
          sessionThreadTs,
        });
      }
    }

    await slackApi.postMessage(channel, lines.join('\n'), { threadTs });

    logger.info('Posted source thread summary', {
      trigger,
      sourceChannel: channel,
      sourceThreadTs: threadTs,
      title: session.title,
    });
  } catch (error) {
    logger.error('Failed to post source thread summary', error);
  }
}
