import { SlackApiHelper } from './slack-api-helper';
import { MessageFormatter } from './message-formatter';
import { ConversationSession } from '../types';
import { ClaudeHandler } from '../claude-handler';
import { userSettingsStore } from '../user-settings-store';
import { Logger } from '../logger';

export type SayFn = (args: any) => Promise<any>;

/**
 * 세션 관련 UI 포맷팅 및 알림을 관리하는 클래스
 */
export class SessionUiManager {
  private logger = new Logger('SessionUiManager');

  constructor(
    private claudeHandler: ClaudeHandler,
    private slackApi: SlackApiHelper
  ) {}

  /**
   * 사용자의 세션 목록을 Block Kit 형식으로 포맷팅
   */
  async formatUserSessionsBlocks(userId: string): Promise<{ text: string; blocks: any[] }> {
    const allSessions = this.claudeHandler.getAllSessions();
    const userSessions: Array<{ key: string; session: ConversationSession }> = [];

    for (const [key, session] of allSessions.entries()) {
      if (session.ownerId === userId && session.sessionId) {
        userSessions.push({ key, session });
      }
    }

    if (userSessions.length === 0) {
      return {
        text: '📭 활성 세션 없음',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '📭 *활성 세션 없음*\n\n현재 진행 중인 세션이 없습니다.',
            },
          },
        ],
      };
    }

    // 최근 활동 순 정렬
    userSessions.sort((a, b) => b.session.lastActivity.getTime() - a.session.lastActivity.getTime());

    const blocks: any[] = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `📋 내 세션 목록 (${userSessions.length}개)`,
          emoji: true,
        },
      },
      { type: 'divider' },
    ];

    for (let i = 0; i < userSessions.length; i++) {
      const { key, session } = userSessions[i];
      const channelName = await this.slackApi.getChannelName(session.channelId);
      const timeAgo = MessageFormatter.formatTimeAgo(session.lastActivity);
      const expiresIn = MessageFormatter.formatExpiresIn(session.lastActivity);
      const workDir = session.workingDirectory
        ? `\`${session.workingDirectory.split('/').pop()}\``
        : '_미설정_';
      const modelDisplay = session.model
        ? userSettingsStore.getModelDisplayName(session.model as any)
        : 'Sonnet 4';
      const initiator = session.currentInitiatorName
        ? ` | 🎯 ${session.currentInitiatorName}`
        : '';

      // 스레드 퍼머링크
      const permalink = session.threadTs
        ? await this.slackApi.getPermalink(session.channelId, session.threadTs)
        : null;

      const sessionId = key;

      // 세션 정보 텍스트 구성
      let sessionText = `*${i + 1}.*`;
      if (session.title) {
        sessionText += ` ${session.title}`;
      }
      sessionText += ` _${channelName}_`;
      if (session.threadTs && permalink) {
        sessionText += ` <${permalink}|(열기)>`;
      } else if (session.threadTs) {
        sessionText += ` (thread)`;
      }
      sessionText += `\n🤖 ${modelDisplay} | 📁 ${workDir} | 🕐 ${timeAgo}${initiator} | ⏳ ${expiresIn}`;

      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: sessionText,
        },
        accessory: {
          type: 'button',
          text: {
            type: 'plain_text',
            text: '🗑️ 종료',
            emoji: true,
          },
          style: 'danger',
          value: sessionId,
          action_id: 'terminate_session',
          confirm: {
            title: {
              type: 'plain_text',
              text: '세션 종료',
            },
            text: {
              type: 'mrkdwn',
              text: `정말로 이 세션을 종료하시겠습니까?\n*${channelName}*`,
            },
            confirm: {
              type: 'plain_text',
              text: '종료',
            },
            deny: {
              type: 'plain_text',
              text: '취소',
            },
          },
        },
      });
    }

    blocks.push(
      { type: 'divider' },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: '💡 `terminate <session-key>` 명령으로도 세션을 종료할 수 있습니다.',
          },
        ],
      }
    );

    return {
      text: `📋 내 세션 목록 (${userSessions.length}개)`,
      blocks,
    };
  }

  /**
   * 전체 세션 현황 포맷팅
   */
  async formatAllSessions(): Promise<string> {
    const allSessions = this.claudeHandler.getAllSessions();
    const activeSessions: Array<{ key: string; session: ConversationSession }> = [];

    for (const [key, session] of allSessions.entries()) {
      if (session.sessionId) {
        activeSessions.push({ key, session });
      }
    }

    if (activeSessions.length === 0) {
      return '📭 *활성 세션 없음*\n\n현재 진행 중인 세션이 없습니다.';
    }

    const lines: string[] = [
      `🌐 *전체 세션 현황* (${activeSessions.length}개)`,
      '',
    ];

    // 최근 활동 순 정렬
    activeSessions.sort((a, b) => b.session.lastActivity.getTime() - a.session.lastActivity.getTime());

    // 소유자별 그룹핑
    const sessionsByOwner = new Map<string, Array<{ key: string; session: ConversationSession }>>();
    for (const item of activeSessions) {
      const ownerId = item.session.ownerId;
      if (!sessionsByOwner.has(ownerId)) {
        sessionsByOwner.set(ownerId, []);
      }
      sessionsByOwner.get(ownerId)!.push(item);
    }

    for (const [ownerId, sessions] of sessionsByOwner.entries()) {
      const ownerName = sessions[0].session.ownerName || await this.slackApi.getUserName(ownerId);
      lines.push(`👤 *${ownerName}* (${sessions.length}개 세션)`);

      for (const { session } of sessions) {
        const channelName = await this.slackApi.getChannelName(session.channelId);
        const timeAgo = MessageFormatter.formatTimeAgo(session.lastActivity);
        const expiresIn = MessageFormatter.formatExpiresIn(session.lastActivity);
        const workDir = session.workingDirectory
          ? session.workingDirectory.split('/').pop() || session.workingDirectory
          : '-';
        const initiator = session.currentInitiatorName && session.currentInitiatorId !== session.ownerId
          ? ` | 🎯 ${session.currentInitiatorName}`
          : '';

        lines.push(`   • ${channelName}${session.threadTs ? ' (thread)' : ''} | 📁 \`${workDir}\` | 🕐 ${timeAgo}${initiator} | ⏳ ${expiresIn}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * 세션 종료 명령 처리
   */
  async handleTerminateCommand(
    sessionKey: string,
    userId: string,
    channel: string,
    threadTs: string,
    say: SayFn
  ): Promise<void> {
    const session = this.claudeHandler.getSessionByKey(sessionKey);

    if (!session) {
      await say({
        text: `❌ 세션을 찾을 수 없습니다: \`${sessionKey}\`\n\n\`sessions\` 명령으로 활성 세션 목록을 확인하세요.`,
        thread_ts: threadTs,
      });
      return;
    }

    if (session.ownerId !== userId) {
      await say({
        text: `❌ 이 세션을 종료할 권한이 없습니다. 세션 소유자만 종료할 수 있습니다.`,
        thread_ts: threadTs,
      });
      return;
    }

    const success = this.claudeHandler.terminateSession(sessionKey);

    if (success) {
      const channelName = await this.slackApi.getChannelName(session.channelId);
      await say({
        text: `✅ 세션이 종료되었습니다.\n\n*채널:* ${channelName}\n*세션 키:* \`${sessionKey}\``,
        thread_ts: threadTs,
      });

      // 원래 스레드에도 알림 (다른 스레드인 경우)
      if (session.threadTs && session.threadTs !== threadTs) {
        try {
          await this.slackApi.postMessage(
            session.channelId,
            `🔒 *세션이 종료되었습니다*\n\n<@${userId}>에 의해 세션이 종료되었습니다. 새로운 대화를 시작하려면 다시 메시지를 보내주세요.`,
            { threadTs: session.threadTs }
          );
        } catch (error) {
          this.logger.warn('Failed to notify original thread about session termination', error);
        }
      }
    } else {
      await say({
        text: `❌ 세션 종료에 실패했습니다: \`${sessionKey}\``,
        thread_ts: threadTs,
      });
    }
  }

  /**
   * 세션 만료 경고 처리
   */
  async handleSessionWarning(
    session: ConversationSession,
    timeRemaining: number,
    existingMessageTs?: string
  ): Promise<string | undefined> {
    const warningText = `⚠️ *세션 만료 예정*\n\n이 세션은 *${MessageFormatter.formatTimeRemaining(timeRemaining)}* 후에 만료됩니다.\n세션을 유지하려면 메시지를 보내주세요.`;
    const threadTs = session.threadTs;
    const channel = session.channelId;

    try {
      if (existingMessageTs) {
        await this.slackApi.updateMessage(channel, existingMessageTs, warningText);
        return existingMessageTs;
      } else {
        const result = await this.slackApi.postMessage(channel, warningText, { threadTs });
        return result.ts;
      }
    } catch (error) {
      this.logger.error('Failed to send/update session warning message', error);
      return undefined;
    }
  }

  /**
   * 세션 만료 처리
   */
  async handleSessionExpiry(session: ConversationSession): Promise<void> {
    const expiryText = `🔒 *세션이 종료되었습니다*\n\n24시간 동안 활동이 없어 이 세션이 종료되었습니다.\n새로운 대화를 시작하려면 다시 메시지를 보내주세요.`;

    try {
      if (session.warningMessageTs) {
        await this.slackApi.updateMessage(session.channelId, session.warningMessageTs, expiryText);
      } else {
        await this.slackApi.postMessage(session.channelId, expiryText, { threadTs: session.threadTs });
      }

      this.logger.info('Session expired', {
        userId: session.userId,
        channelId: session.channelId,
        threadTs: session.threadTs,
      });
    } catch (error) {
      this.logger.error('Failed to send session expiry message', error);
    }
  }

  /**
   * 서버 종료 시 모든 세션에 알림
   */
  async notifyShutdown(): Promise<void> {
    const shutdownText = `🔄 *서버 재시작 중*\n\n서버가 재시작됩니다. 잠시 후 다시 대화를 이어갈 수 있습니다.\n세션이 저장되었으므로 서버 재시작 후에도 대화 내용이 유지됩니다.`;

    const sessions = this.claudeHandler.getAllSessions();
    const notifyPromises: Promise<void>[] = [];

    for (const [key, session] of sessions.entries()) {
      if (session.sessionId) {
        const promise = (async () => {
          try {
            await this.slackApi.postMessage(session.channelId, shutdownText, {
              threadTs: session.threadTs,
            });
            this.logger.debug('Sent shutdown notification', {
              sessionKey: key,
              channel: session.channelId,
            });
          } catch (error) {
            this.logger.error('Failed to send shutdown notification', {
              sessionKey: key,
              error,
            });
          }
        })();
        notifyPromises.push(promise);
      }
    }

    if (notifyPromises.length > 0) {
      this.logger.info(`Sending shutdown notifications to ${notifyPromises.length} sessions`);
      await Promise.race([
        Promise.all(notifyPromises),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    }
  }
}
