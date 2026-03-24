import { App } from '@slack/bolt';
import { SlackApiHelper } from './slack-api-helper';
import { SessionUiManager } from './session-manager';
import { ActionHandlers, MessageHandler, MessageEvent, SayFn } from './action-handlers';
import { ClaudeHandler, SessionExpiryCallbacks } from '../claude-handler';
import { config } from '../config';
import { Logger } from '../logger';
import { registerChannel, unregisterChannel } from '../channel-registry';

export interface EventRouterDeps {
  slackApi: SlackApiHelper;
  claudeHandler: ClaudeHandler;
  sessionManager: SessionUiManager;
  actionHandlers: ActionHandlers;
}

/**
 * Slack 이벤트 라우팅 및 등록을 담당하는 클래스
 */
export class EventRouter {
  private logger = new Logger('EventRouter');
  private cleanupIntervalId: NodeJS.Timeout | null = null;

  constructor(
    private app: App,
    private deps: EventRouterDeps,
    private messageHandler: MessageHandler
  ) {}

  /**
   * 모든 이벤트 핸들러 설정
   */
  setup(): void {
    this.setupMessageHandlers();
    this.setupMemberJoinHandler();
    this.deps.actionHandlers.registerHandlers(this.app);
    this.setupSessionExpiryCallbacks();
    this.setupSessionCleanup();
  }

  /**
   * 메시지 이벤트 핸들러 설정
   */
  private setupMessageHandlers(): void {
    // DM 메시지 처리
    this.app.message(async ({ message, say }) => {
      const msg = message as any;
      this.logger.debug('📬 app.message() triggered', {
        channel: msg.channel,
        user: msg.user,
        subtype: message.subtype,
        isDM: msg.channel?.startsWith('D'),
      });
      if (message.subtype === undefined && 'user' in message) {
        const messageEvent = message as any;
        // DM 채널만 처리
        if (!messageEvent.channel?.startsWith('D')) {
          return;
        }
        this.logger.info('Handling direct message event');
        await this.messageHandler(message as MessageEvent, say);
      }
    });

    // 앱 멘션 처리
    this.app.event('app_mention', async ({ event, say }) => {
      this.logger.info('📢 app_mention event received', {
        channel: event.channel,
        user: event.user,
        thread_ts: event.thread_ts,
        text: event.text?.substring(0, 50),
      });

      // Source thread re-mention: if mentioned in a thread that has a linked bot session,
      // respond with that session's status instead of creating a new session
      if (event.thread_ts) {
        const existingSession = this.deps.claudeHandler.getSession(event.channel, event.thread_ts);
        if (!existingSession) {
          const linkedSession = this.deps.claudeHandler.findSessionBySourceThread(event.channel, event.thread_ts);
          if (linkedSession) {
            await this.respondWithLinkedSessionStatus(event.channel, event.thread_ts, linkedSession, say);
            return;
          }
        }
      }

      const text = event.text.replace(/<@[^>]+>/g, '').trim();
      await this.messageHandler(
        {
          ...event,
          text,
        } as MessageEvent,
        say
      );
    });

    // 스레드 메시지 처리 (멘션 없이도 세션이 있으면 응답)
    this.app.event('message', async ({ event, say }) => {
      const messageEvent = event as any;

      // 봇 메시지 스킵
      if ('bot_id' in event || !('user' in event)) {
        this.logger.debug('Skipping bot message or no user');
        return;
      }

      this.logger.info('📨 MESSAGE event received', {
        type: event.type,
        subtype: event.subtype,
        channel: messageEvent.channel,
        channelType: messageEvent.channel_type,
        user: messageEvent.user,
        bot_id: (event as any).bot_id,
        thread_ts: messageEvent.thread_ts,
        hasText: !!messageEvent.text,
      });

      
      // 파일 업로드 처리
      if (event.subtype === 'file_share' && messageEvent.files) {
        await this.handleFileUpload(messageEvent, say);
        return;
      }

      // 멘션 없는 스레드 메시지 처리
      if (event.subtype === undefined && messageEvent.thread_ts) {
        await this.handleThreadMessage(messageEvent, say);
      }
    });
  }

  /**
   * 파일 업로드 처리
   */
  private async handleFileUpload(messageEvent: any, say: SayFn): Promise<void> {
    const { channel, thread_ts: threadTs, ts } = messageEvent;
    const isDM = channel.startsWith('D');

    // DM에서는 항상 처리
    if (isDM) {
      this.logger.info('Handling file upload event in DM');
      await this.messageHandler(messageEvent as MessageEvent, say);
      return;
    }

    // 채널에서는 기존 세션이 있을 때만 처리
    // NOTE: sessionId가 없어도 세션이 있으면 처리 (sessionId는 첫 응답 후에 설정됨)
    const session = threadTs ? this.deps.claudeHandler.getSession(channel, threadTs) : undefined;
    if (session) {
      this.logger.info('Handling file upload event in existing session', {
        channel,
        threadTs,
        sessionId: session.sessionId || '(pending)',
      });
      await this.messageHandler(messageEvent as MessageEvent, say);
      return;
    }

    // No session - add no_entry emoji to indicate file was seen but not processed
    this.logger.debug('Ignoring file upload - not in DM and no existing session', {
      channel,
      threadTs,
      isDM,
    });
    if (ts) {
      await this.deps.slackApi.addReaction(channel, ts, 'no_entry');
    }
  }

  /**
   * 스레드 메시지 처리 (멘션 없이)
   */
  private async handleThreadMessage(messageEvent: any, say: SayFn): Promise<void> {
    const { user, channel, thread_ts: threadTs, ts, text = '' } = messageEvent;

    // 봇 멘션이 포함된 경우 스킵 (app_mention에서 처리)
    const botId = await this.deps.slackApi.getBotUserId();
    if (botId && text.includes(`<@${botId}>`)) {
      this.logger.debug('Skipping thread message with bot mention (handled by app_mention)', {
        channel,
        threadTs,
      });
      return;
    }

    // 기존 세션이 있는 경우에만 처리
    // NOTE: sessionId가 없어도 세션이 있으면 처리 (sessionId는 첫 응답 후에 설정됨)
    const session = this.deps.claudeHandler.getSession(channel, threadTs);
    if (session) {
      this.logger.info('Handling thread message without mention (session exists)', {
        user,
        channel,
        threadTs,
        sessionId: session.sessionId || '(pending)',
        owner: session.ownerName,
      });
      await this.messageHandler(messageEvent as MessageEvent, say);
      return;
    }

    // No session - add 'no_entry' emoji to indicate message was seen but not processed
    this.logger.debug('Ignoring thread message - no session exists', { user, channel, threadTs });
    await this.deps.slackApi.addReaction(channel, ts, 'no_entry');
  }

  /**
   * 채널 참여 이벤트 핸들러 설정
   */
  private setupMemberJoinHandler(): void {
    this.app.event('member_joined_channel', async ({ event, say }) => {
      const botUserId = await this.deps.slackApi.getBotUserId();
      if (event.user === botUserId) {
        this.logger.info('Bot added to channel', { channel: event.channel });
        // Register channel in registry for repo mapping
        await registerChannel(this.deps.slackApi.getClient(), event.channel);
        await this.handleChannelJoin(event.channel, say);
      }
    });

    // Track channel leave events
    this.app.event('member_left_channel' as any, async ({ event }: any) => {
      const botUserId = await this.deps.slackApi.getBotUserId();
      if (event.user === botUserId) {
        this.logger.info('Bot removed from channel', { channel: event.channel });
        unregisterChannel(event.channel);
      }
    });
  }

  /**
   * 채널 참여 시 환영 메시지
   */
  private async handleChannelJoin(channelId: string, say: SayFn): Promise<void> {
    try {
      const channelInfo = await this.deps.slackApi.getChannelInfo(channelId);
      const channelName = channelInfo?.name || 'this channel';

      let welcomeMessage = `👋 Hi! I'm Claude Code, your AI coding assistant.\n\n`;
      welcomeMessage += `To get started, I need to know the default working directory for #${channelName}.\n\n`;

      if (config.baseDirectory) {
        welcomeMessage += `You can use:\n`;
        welcomeMessage += `• \`cwd project-name\` (relative to base directory: \`${config.baseDirectory}\`)\n`;
        welcomeMessage += `• \`cwd /absolute/path/to/project\` (absolute path)\n\n`;
      } else {
        welcomeMessage += `Please set it using:\n`;
        welcomeMessage += `• \`cwd /path/to/project\` or \`set directory /path/to/project\`\n\n`;
      }

      welcomeMessage += `This will be the default working directory for this channel. `;
      welcomeMessage += `You can always override it for specific threads by mentioning me with a different \`cwd\` command.\n\n`;
      welcomeMessage += `Once set, you can ask me to help with code reviews, file analysis, debugging, and more!`;

      await say({ text: welcomeMessage });

      this.logger.info('Sent welcome message to channel', { channelId, channelName });
    } catch (error) {
      this.logger.error('Failed to handle channel join', error);
    }
  }

  /**
   * 세션 만료 콜백 설정
   */
  private setupSessionExpiryCallbacks(): void {
    const IDLE_CHECK_THRESHOLD = 60 * 60 * 1000; // 1 hour: above this → idle check, below → final warning

    const callbacks: SessionExpiryCallbacks = {
      onWarning: (session, timeRemaining, existingMessageTs) => {
        // Route to idle check for 12h warning, regular warning for 10m
        if (timeRemaining > IDLE_CHECK_THRESHOLD) {
          return this.deps.sessionManager.handleIdleCheck(session, timeRemaining, existingMessageTs);
        }
        return this.deps.sessionManager.handleSessionWarning(session, timeRemaining, existingMessageTs);
      },
      onSleep: (session) => {
        return this.deps.sessionManager.handleSessionSleep(session);
      },
      onExpiry: (session) => {
        return this.deps.sessionManager.handleSessionExpiry(session);
      },
    };

    this.deps.claudeHandler.setExpiryCallbacks(callbacks);
  }

  /**
   * Respond with linked session status when bot is re-mentioned in the source thread.
   */
  private async respondWithLinkedSessionStatus(
    channel: string,
    threadTs: string,
    session: import('../types').ConversationSession,
    say: SayFn
  ): Promise<void> {
    try {
      const title = session.title || 'Untitled';
      const status = session.activityState || 'unknown';
      const lines: string[] = [`📋 *"${title}"* — ${status}`];

      if (session.links?.issue?.url) {
        lines.push(`📌 *이슈*: <${session.links.issue.url}|${session.links.issue.label || 'Issue'}>`);
      }
      if (session.links?.pr?.url) {
        lines.push(`🔀 *PR*: <${session.links.pr.url}|${session.links.pr.label || 'PR'}>`);
      }

      const workThreadTs = session.threadRootTs || session.threadTs;
      if (session.channelId && workThreadTs) {
        const permalink = await this.deps.slackApi.getPermalink(session.channelId, workThreadTs);
        if (permalink) {
          lines.push(`🧵 *작업 스레드*: <${permalink}|열기>`);
        }
      }

      await say({ text: lines.join('\n'), thread_ts: threadTs });
    } catch (error) {
      this.logger.error('Failed to respond with linked session status', error);
    }
  }

  /**
   * 주기적 세션 정리 설정
   */
  private setupSessionCleanup(): void {
    this.cleanupIntervalId = setInterval(async () => {
      this.logger.debug('Running session cleanup');
      await this.deps.claudeHandler.cleanupInactiveSessions();
    }, 5 * 60 * 1000); // 5분마다
  }

  /**
   * 리소스 정리 (테스트 및 종료 시 사용)
   */
  cleanup(): void {
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = null;
      this.logger.debug('Session cleanup interval cleared');
    }
  }
}
