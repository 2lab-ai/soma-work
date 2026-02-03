import { SlackApiHelper } from './slack-api-helper';
import { MessageFormatter } from './message-formatter';
import { ReactionManager } from './reaction-manager';
import { ConversationSession, SessionLinks, ActivityState } from '../types';
import { ClaudeHandler } from '../claude-handler';
import { userSettingsStore } from '../user-settings-store';
import {
  fetchLinkMetadata,
  getStatusEmoji,
  fetchJiraTransitions,
  fetchGitHubPRDetails,
  isPRMergeable,
  extractJiraKey,
  JiraTransition,
  GitHubPRDetails,
} from '../link-metadata-fetcher';
import { Logger } from '../logger';

export interface FormatSessionsOptions {
  showControls?: boolean; // Show kill buttons (default: true)
}


export type SayFn = (args: any) => Promise<any>;

/**
 * 세션 관련 UI 포맷팅 및 알림을 관리하는 클래스
 */
export class SessionUiManager {
  private logger = new Logger('SessionUiManager');

  private reactionManager?: ReactionManager;

  constructor(
    private claudeHandler: ClaudeHandler,
    private slackApi: SlackApiHelper
  ) {}

  /**
   * Set reaction manager for lifecycle emojis (optional dependency)
   */
  setReactionManager(reactionManager: ReactionManager): void {
    this.reactionManager = reactionManager;
  }

  /**
   * 사용자의 세션 목록을 Block Kit 형식으로 포맷팅
   */
  async formatUserSessionsBlocks(
    userId: string,
    options: FormatSessionsOptions = {}
  ): Promise<{ text: string; blocks: any[] }> {
    const { showControls = true } = options;
    const allSessions = this.claudeHandler.getAllSessions();
    const userSessions: Array<{ key: string; session: ConversationSession }> = [];

    for (const [key, session] of allSessions.entries()) {
      if (session.ownerId === userId && session.sessionId) {
        // Include both active and sleeping sessions
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

    // Group sessions by repository
    const repoGroups = new Map<string, Array<{ key: string; session: ConversationSession }>>();
    for (const item of userSessions) {
      const repoName = this.extractRepoName(item.session);
      if (!repoGroups.has(repoName)) {
        repoGroups.set(repoName, []);
      }
      repoGroups.get(repoName)!.push(item);
    }

    const blocks: any[] = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `📋 내 세션 목록 (${userSessions.length}개)`,
          emoji: true,
        },
      },
    ];

    let sessionIndex = 0;
    const showGroupHeaders = repoGroups.size > 1;

    for (const [repoName, groupSessions] of repoGroups.entries()) {
      blocks.push({ type: 'divider' });

      // Group header (only if multiple groups)
      if (showGroupHeaders) {
        blocks.push({
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `📦 *${repoName}* (${groupSessions.length})`,
            },
          ],
        });
      }

      for (const { key, session } of groupSessions) {
        sessionIndex++;
        const channelName = await this.slackApi.getChannelName(session.channelId);
        const timeAgo = MessageFormatter.formatTimeAgo(session.lastActivity);
        const expiresIn = MessageFormatter.formatExpiresIn(session.lastActivity);
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
        const activityEmoji = this.formatActivityEmoji(session.activityState);
        let sessionText = `${activityEmoji}*${sessionIndex}.*`;
        if (session.title) {
          sessionText += ` ${session.title}`;
        }
        sessionText += ` _${channelName}_`;
        if (session.threadTs && permalink) {
          sessionText += ` <${permalink}|(열기)>`;
        } else if (session.threadTs) {
          sessionText += ` (thread)`;
        }

        // Links line
        const linksLine = await this.formatLinksLine(session.links);
        if (linksLine) {
          sessionText += `\n${linksLine}`;
        }

        // Show different status line for sleeping sessions
        if (session.state === 'SLEEPING') {
          const sleepExpires = session.sleepStartedAt
            ? MessageFormatter.formatSleepExpiresIn(session.sleepStartedAt)
            : '?';
          sessionText += `\n💤 *Sleep* | 🤖 ${modelDisplay} | 🕐 ${timeAgo} | ⏳ ${sleepExpires}`;
        } else {
          sessionText += `\n🤖 ${modelDisplay} | 🕐 ${timeAgo}${initiator} | ⏳ ${expiresIn}`;
        }

        const block: any = {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: sessionText,
          },
        };

        // Only show kill button when controls are enabled
        if (showControls) {
          block.accessory = {
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
          };
        }

        blocks.push(block);

        // Action buttons: Jira transitions + PR merge (only when controls enabled)
        if (showControls) {
          const actionElements = await this.buildSessionActionButtons(key, session);
          if (actionElements.length > 0) {
            blocks.push({
              type: 'actions',
              elements: actionElements,
            });
          }
        }
      }
    }

    blocks.push({ type: 'divider' });

    // Add refresh button when controls are enabled
    if (showControls) {
      blocks.push({
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: '🔄 새로고침',
              emoji: true,
            },
            action_id: 'refresh_sessions',
          },
        ],
      });
    }

    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: '💡 `terminate <session-key>` 명령으로도 세션을 종료할 수 있습니다.',
        },
      ],
    });

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
        const initiator = session.currentInitiatorName && session.currentInitiatorId !== session.ownerId
          ? ` | 🎯 ${session.currentInitiatorName}`
          : '';

        lines.push(`   • ${channelName}${session.threadTs ? ' (thread)' : ''} | 🕐 ${timeAgo}${initiator} | ⏳ ${expiresIn}`);
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
   * 세션 Sleep 전환 처리
   */
  async handleSessionSleep(session: ConversationSession): Promise<void> {
    const sleepText = `💤 *세션이 Sleep 모드로 전환되었습니다*\n\n24시간 동안 활동이 없어 세션이 Sleep 상태로 전환되었습니다.\n메시지를 보내면 다시 대화를 이어갈 수 있습니다.\n\n> Sleep 모드는 7일간 유지되며, 이후 자동으로 종료됩니다.`;

    // Add zzz emoji to thread
    const sessionKey = this.claudeHandler.getSessionKey(session.channelId, session.threadTs);
    await this.reactionManager?.setSessionExpired(sessionKey, session.channelId, session.threadTs);

    try {
      if (session.warningMessageTs) {
        await this.slackApi.updateMessage(session.channelId, session.warningMessageTs, sleepText);
      } else {
        await this.slackApi.postMessage(session.channelId, sleepText, { threadTs: session.threadTs });
      }

      this.logger.info('Session transitioned to sleep', {
        userId: session.userId,
        channelId: session.channelId,
        threadTs: session.threadTs,
      });
    } catch (error) {
      this.logger.error('Failed to send session sleep message', error);
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
    const expiryText = `🔒 *세션이 종료되었습니다*\n\nSleep 모드가 7일 경과하여 세션이 종료되었습니다.\n새로운 대화를 시작하려면 다시 메시지를 보내주세요.`;

    // Add zzz emoji (may already be there from sleep transition)
    const sessionKey = this.claudeHandler.getSessionKey(session.channelId, session.threadTs);
    await this.reactionManager?.setSessionExpired(sessionKey, session.channelId, session.threadTs);

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
   * Build action buttons for Jira transitions and PR merge for a session.
   * Fetches Jira transitions and GitHub PR details in parallel.
   * Returns empty array if no actions are available.
   */
  private async buildSessionActionButtons(
    sessionKey: string,
    session: ConversationSession
  ): Promise<any[]> {
    const elements: any[] = [];
    const keyPrefix = sessionKey.substring(0, 8);

    try {
      // Fetch Jira transitions and PR details in parallel
      const [jiraTransitions, prDetails] = await Promise.all([
        this.fetchJiraTransitionsForSession(session),
        this.fetchPRDetailsForSession(session),
      ]);

      // Jira transition buttons (max 3 to leave room for merge button)
      if (jiraTransitions.length > 0) {
        const issueKey = session.links?.issue?.label
          || extractJiraKey(session.links?.issue?.url || '')
          || '';
        const maxTransitions = prDetails && isPRMergeable(prDetails) ? 3 : 4;

        for (const transition of jiraTransitions.slice(0, maxTransitions)) {
          const isDone = transition.to.statusCategory === 'done';
          const button: any = {
            type: 'button',
            text: {
              type: 'plain_text',
              text: `${isDone ? '✅ ' : ''}${transition.name}`,
              emoji: true,
            },
            value: JSON.stringify({
              sessionKey,
              issueKey,
              transitionId: transition.id,
              transitionName: transition.name,
            }),
            action_id: `jira_transition_${transition.id}_${keyPrefix}`,
          };
          if (isDone) {
            button.style = 'primary';
          }
          elements.push(button);
        }
      }

      // PR merge button
      if (prDetails && isPRMergeable(prDetails) && session.links?.pr) {
        const prLabel = session.links.pr.label || 'PR';
        elements.push({
          type: 'button',
          text: {
            type: 'plain_text',
            text: '🔀 Merge',
            emoji: true,
          },
          style: 'primary',
          value: JSON.stringify({
            sessionKey,
            prUrl: session.links.pr.url,
            prLabel,
            headBranch: prDetails.head,
            baseBranch: prDetails.base,
          }),
          action_id: `merge_pr_${keyPrefix}`,
          confirm: {
            title: {
              type: 'plain_text',
              text: 'PR 머지',
            },
            text: {
              type: 'mrkdwn',
              text: `*${prLabel}*을(를) 머지하시겠습니까?\n\n\`${prDetails.head}\` → \`${prDetails.base}\`\n\n_Squash merge로 진행되며, 머지 후 소스 브랜치가 삭제됩니다._`,
            },
            confirm: {
              type: 'plain_text',
              text: '머지',
            },
            deny: {
              type: 'plain_text',
              text: '취소',
            },
          },
        });
      }
    } catch (error) {
      this.logger.debug('Failed to build session action buttons', { sessionKey, error });
    }

    // Slack allows max 5 elements per actions block
    return elements.slice(0, 5);
  }

  private async fetchJiraTransitionsForSession(session: ConversationSession): Promise<JiraTransition[]> {
    if (!session.links?.issue || session.links.issue.provider !== 'jira') return [];
    const issueKey = session.links.issue.label || extractJiraKey(session.links.issue.url || '');
    if (!issueKey) return [];
    return fetchJiraTransitions(issueKey);
  }

  private async fetchPRDetailsForSession(session: ConversationSession): Promise<GitHubPRDetails | undefined> {
    if (!session.links?.pr || session.links.pr.provider !== 'github') return undefined;
    return fetchGitHubPRDetails(session.links.pr);
  }

  /**
   * Format activity state as emoji prefix for session display.
   * working → ⚙️, waiting → ✋, idle/undefined → empty string
   */
  private formatActivityEmoji(state?: ActivityState): string {
    switch (state) {
      case 'working': return '⚙️ ';
      case 'waiting': return '✋ ';
      default: return '';
    }
  }

  /**
   * Extract repository name from session data.
   * Priority: 1) GitHub PR/Issue URL → org/repo, 2) workingDirectory → last path component, 3) '_기타_'
   */
  private extractRepoName(session: ConversationSession): string {
    // Try GitHub URL from links
    const githubUrl = session.links?.pr?.url || session.links?.issue?.url;
    if (githubUrl) {
      const match = githubUrl.match(/github\.com\/([^/]+\/[^/]+)/);
      if (match) return match[1];
    }

    // Fallback to working directory last path component
    if (session.workingDirectory) {
      const parts = session.workingDirectory.replace(/\/+$/, '').split('/');
      const lastPart = parts[parts.length - 1];
      if (lastPart) return lastPart;
    }

    return '_기타_';
  }

  /**
   * Format links line for session display
   * Shows title and status from Jira/GitHub API when available.
   * Priority: issue title > PR title (when no issue)
   */
  private async formatLinksLine(links?: SessionLinks): Promise<string | null> {
    if (!links) return null;

    const parts: string[] = [];

    // Fetch metadata (title + status) in parallel
    const [issueMeta, prMeta] = await Promise.all([
      links.issue ? fetchLinkMetadata(links.issue) : undefined,
      links.pr ? fetchLinkMetadata(links.pr) : undefined,
    ]);

    if (links.issue) {
      const label = links.issue.label || '이슈';
      const title = issueMeta?.title ? `: ${issueMeta.title}` : '';
      const statusEmoji = getStatusEmoji(issueMeta?.status);
      const statusText = issueMeta?.status ? ` ${statusEmoji}${issueMeta.status}` : '';
      parts.push(`🎫 <${links.issue.url}|${label}${title}>${statusText}`);
    }
    if (links.pr) {
      const label = links.pr.label || 'PR';
      // Only show PR title if there's no issue (issue title takes priority)
      const title = !links.issue && prMeta?.title ? `: ${prMeta.title}` : '';
      const statusEmoji = getStatusEmoji(prMeta?.status, 'pr');
      const statusText = prMeta?.status ? ` ${statusEmoji}${prMeta.status}` : '';
      parts.push(`🔀 <${links.pr.url}|${label}${title}>${statusText}`);
    }
    if (links.doc) {
      parts.push(`📄 <${links.doc.url}|${links.doc.label || '문서'}>`);
    }

    return parts.length > 0 ? `🔗 ${parts.join(' | ')}` : null;
  }

  /**
   * 12시간 유휴 세션 확인 메시지 처리
   */
  async handleIdleCheck(
    session: ConversationSession,
    timeRemaining: number,
    existingMessageTs?: string
  ): Promise<string | undefined> {
    const sessionKey = this.claudeHandler.getSessionKey(session.channelId, session.threadTs);
    const threadTs = session.threadTs;
    const channel = session.channelId;

    // 12h idle check (when more than 10 minutes remain = not yet at final warning stage)
    if (timeRemaining > 60 * 60 * 1000) {
      // Add idle emoji to thread
      await this.reactionManager?.setSessionIdle(sessionKey);
      const blocks = [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `💤 *세션 활동 확인*\n\n이 세션이 12시간 이상 비활성 상태입니다.\n작업이 완료되었나요?`,
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: '✅ 종료',
                emoji: true,
              },
              style: 'danger',
              value: sessionKey,
              action_id: 'idle_close_session',
            },
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: '🔄 유지',
                emoji: true,
              },
              value: sessionKey,
              action_id: 'idle_keep_session',
            },
          ],
        },
      ];

      try {
        const result = await this.slackApi.postMessage(channel, '💤 세션 활동 확인', {
          threadTs,
          blocks,
        });
        return result.ts;
      } catch (error) {
        this.logger.error('Failed to send idle check message', error);
        return undefined;
      }
    }

    // Fallback to regular warning for shorter time remaining
    return this.handleSessionWarning(session, timeRemaining, existingMessageTs);
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
