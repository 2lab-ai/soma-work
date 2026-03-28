import { App } from '@slack/bolt';
import { SlackApiHelper } from './slack-api-helper';
import { SessionUiManager } from './session-manager';
import { ActionHandlers, MessageHandler, MessageEvent, SayFn } from './action-handlers';
import { ClaudeHandler, SessionExpiryCallbacks } from '../claude-handler';
import { config } from '../config';
import { Logger } from '../logger';
import { registerChannel, unregisterChannel } from '../channel-registry';
import { ConversationSession } from '../types';
import { SlashCommandAdapter } from './slash-command-adapter';
import { CommandRouter } from './commands/command-router';
import { CommandParser } from './command-parser';
import { CommandDependencies } from './commands/types';

export interface EventRouterDeps {
  slackApi: SlackApiHelper;
  claudeHandler: ClaudeHandler;
  sessionManager: SessionUiManager;
  actionHandlers: ActionHandlers;
  commandDeps?: CommandDependencies;
}

/**
 * Slack 이벤트 라우팅 및 등록을 담당하는 클래스
 */
export class EventRouter {
  private logger = new Logger('EventRouter');
  private cleanupIntervalId: NodeJS.Timeout | null = null;
  private commandRouter: CommandRouter | null = null;

  constructor(
    private app: App,
    private deps: EventRouterDeps,
    private messageHandler: MessageHandler
  ) {
    if (deps.commandDeps) {
      this.commandRouter = new CommandRouter(deps.commandDeps);
    }
  }

  /**
   * 모든 이벤트 핸들러 설정
   */
  setup(): void {
    this.setupMessageHandlers();
    this.setupSlashCommands();
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
        hasFiles: !!((event as any).files?.length),
      });

      // Dedup guard: if message has files, the file_share handler is authoritative.
      // app_mention does not reliably carry the files field, so let file_share handle it.
      // (Issue #127: file attachments ignored on session initiation)
      if ((event as any).files?.length > 0) {
        this.logger.debug('Skipping app_mention with files (handled by file_share handler)', {
          channel: event.channel,
          fileCount: (event as any).files.length,
        });
        return;
      }

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

      // Issue #141: Strip only bot mention, preserve other user mentions in the prompt.
      let botId: string | undefined;
      try {
        botId = await this.deps.slackApi.getBotUserId();
      } catch (err) {
        this.logger.warn('Failed to get bot user ID for mention stripping', { error: (err as Error).message });
      }
      const text = botId
        ? event.text.replace(new RegExp(`<@${botId}>`, 'g'), '').trim()
        : event.text.trim(); // fallback: preserve all mentions if botId unavailable
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

  // Commands that require thread/session context — not available via slash commands
  // These need a real thread_ts to find or create sessions.
  private static readonly SESSION_DEPENDENT_COMMANDS = [
    'new', 'close', 'renew', 'context', 'restore', 'link',
  ];

  /**
   * Slash command 핸들러 설정
   * Trace: docs/slash-commands/trace.md, Scenario 1-5
   */
  private setupSlashCommands(): void {
    // /soma [subcommand] — 범용 명령 (Scenario 2, 3)
    this.app.command('/soma', async ({ command, ack, respond }) => {
      await ack();
      this.logger.info('Slash command /soma', {
        text: command.text?.substring(0, 50),
        user: command.user_id,
        channel: command.channel_id,
      });

      try {
        const ctx = SlashCommandAdapter.adapt(command, respond);

        // Empty text → help fallback (Scenario 3, Case A)
        if (!ctx.text.trim()) {
          await respond({
            text: CommandParser.getHelpMessage(),
            response_type: 'ephemeral',
          });
          return;
        }

        // Block session-dependent commands — slash commands have no thread context
        const firstWord = ctx.text.trim().split(/\s+/)[0]?.toLowerCase();
        if (firstWord && EventRouter.SESSION_DEPENDENT_COMMANDS.includes(firstWord)) {
          await respond({
            text: `⚠️ \`${firstWord}\` 명령은 스레드 컨텍스트가 필요합니다.\n봇이 응답하고 있는 스레드에서 \`${firstWord}\` 를 텍스트로 입력해주세요.`,
            response_type: 'ephemeral',
          });
          return;
        }

        // Route through existing CommandRouter
        if (this.commandRouter) {
          const result = await this.commandRouter.route(ctx);

          // If CommandRouter didn't handle it, show help
          if (!result.handled) {
            await respond({
              text: CommandParser.getHelpMessage(),
              response_type: 'ephemeral',
            });
          }
        } else {
          this.logger.warn('CommandRouter not available for slash commands');
          await respond({
            text: '⚠️ Bot is still initializing. Please try again in a moment.',
            response_type: 'ephemeral',
          });
        }
      } catch (error: any) {
        const errorMessage = error?.message || String(error) || 'Unknown error';
        this.logger.error('Error handling /soma slash command', {
          error: errorMessage,
          stack: error?.stack,
          user: command.user_id,
          channel: command.channel_id,
          text: command.text?.substring(0, 50),
        });
        try {
          await respond({
            text: '⚠️ 명령 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.',
            response_type: 'ephemeral',
          });
        } catch (respondError: any) {
          this.logger.error('Failed to send error response for /soma', {
            originalError: errorMessage,
            respondError: respondError?.message,
          });
        }
      }
    });

    // /session — 세션 관리 (Scenario 4)
    // NOTE: Intentionally bypasses CommandRouter and calls SessionManager directly.
    // The text command 'sessions' goes through CommandRouter → SessionHandler,
    // but /session uses a direct call for clarity. If SessionHandler evolves,
    // update this path as well. See: docs/slash-commands/trace.md, Scenario 4, Section 3a.
    this.app.command('/session', async ({ command, ack, respond }) => {
      await ack();
      this.logger.info('Slash command /session', {
        user: command.user_id,
        channel: command.channel_id,
      });

      try {
        const { text, blocks } = await this.deps.sessionManager.formatUserSessionsBlocks(
          command.user_id,
          { showControls: true }
        );
        await respond({
          text,
          blocks,
          response_type: 'ephemeral',
        });
      } catch (error: any) {
        const errorMessage = error?.message || String(error) || 'Unknown error';
        this.logger.error('Error handling /session slash command', {
          error: errorMessage,
          stack: error?.stack,
          user: command.user_id,
          channel: command.channel_id,
        });
        try {
          await respond({
            text: '⚠️ 세션 조회 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.',
            response_type: 'ephemeral',
          });
        } catch (respondError: any) {
          this.logger.error('Failed to send error response for /session', {
            originalError: errorMessage,
            respondError: respondError?.message,
          });
        }
      }
    });

    // /new — 세션 리셋 fallback (Scenario 5)
    this.app.command('/new', async ({ command, ack, respond }) => {
      await ack();
      this.logger.info('Slash command /new', {
        text: command.text?.substring(0, 50),
        user: command.user_id,
        channel: command.channel_id,
      });

      try {
        // SlashCommand has no thread_ts — always show fallback guidance
        const prompt = command.text?.trim();
        let message = '💡 `/new` 명령은 스레드 내에서만 사용할 수 있습니다.\n\n';
        message += '봇이 응답하고 있는 스레드에서 `new` 를 텍스트로 입력해주세요.';
        if (prompt) {
          message += `\n프롬프트를 함께 전달하려면: \`new ${prompt}\``;
        }

        await respond({
          text: message,
          response_type: 'ephemeral',
        });
      } catch (error: any) {
        const errorMessage = error?.message || String(error) || 'Unknown error';
        this.logger.error('Error handling /new slash command', {
          error: errorMessage,
          stack: error?.stack,
          user: command.user_id,
          channel: command.channel_id,
        });
        try {
          await respond({
            text: '⚠️ /new 명령 처리 중 오류가 발생했습니다.',
            response_type: 'ephemeral',
          });
        } catch (respondError: any) {
          this.logger.error('Failed to send error response for /new', {
            originalError: errorMessage,
            respondError: respondError?.message,
          });
        }
      }
    });

    this.logger.info('Slash commands registered: /soma, /session, /new');
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

    // Issue #127: First mention + file attachment — no session exists yet.
    // app_mention does not reliably include files, so file_share is the authoritative path.
    // If the message contains a bot mention, treat it as session initiation with files.
    const text: string = messageEvent.text || '';
    const botId = await this.deps.slackApi.getBotUserId();
    if (botId && text.includes(`<@${botId}>`)) {
      this.logger.info('Handling file upload with bot mention as new session initiation', {
        channel,
        user: messageEvent.user,
        fileCount: messageEvent.files?.length,
      });
      // Clone event to avoid mutating the original Slack event object.
      // Strip only bot mention (preserve other user mentions in the prompt).
      const clonedEvent = { ...messageEvent };
      clonedEvent.text = text.replace(new RegExp(`<@${botId}>`, 'g'), '').trim();
      await this.messageHandler(clonedEvent as MessageEvent, say);
      return;
    }

    // No session and no mention - file not relevant to bot
    this.logger.debug('Ignoring file upload - not in DM, no session, no mention', {
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
    session: ConversationSession,
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
