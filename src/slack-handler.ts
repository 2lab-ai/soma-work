import fs from 'node:fs';
import path from 'node:path';
import type { App } from '@slack/bolt';
import { getAdminUsers, isAdminUser } from './admin-utils';
import type { ContinuationHandler, TurnRunnerSurface } from './agent-session';
import { TurnRunner, V1QueryAdapter } from './agent-session';
import type { ClaudeHandler } from './claude-handler';
import { FileHandler } from './file-handler';
import { Logger } from './logger';
import { mcpCallTracker } from './mcp-call-tracker';
import type { McpManager } from './mcp-manager';
import { SlackBlockKitChannel } from './notification-channels/slack-block-kit-channel';
import { SlackDmChannel } from './notification-channels/slack-dm-channel';
import { TelegramChannel } from './notification-channels/telegram-channel';
import { WebhookChannel } from './notification-channels/webhook-channel';
import {
  type ActionHandlerContext,
  ActionHandlers,
  AssistantStatusManager,
  type CommandDependencies,
  CommandRouter,
  ContextWindowManager,
  EventRouter,
  type EventRouterDeps,
  McpHealthMonitor,
  McpStatusDisplay,
  MessageValidator,
  ReactionManager,
  RequestCoordinator,
  SessionUiManager,
  SlackApiHelper,
  StatusReporter,
  StreamProcessor,
  ThreadPanel,
  TodoDisplayManager,
  ToolEventProcessor,
  ToolTracker,
} from './slack';
import { CompletionMessageTracker } from './slack/completion-message-tracker';
import { createForkExecutor } from './slack/create-fork-executor';
import { InputProcessor, type MessageEvent, SessionInitializer, StreamExecutor } from './slack/pipeline';
import { SummaryService } from './slack/summary-service';
import { SummaryTimer } from './slack/summary-timer';
import { TodoManager } from './todo-manager';
import { TurnNotifier } from './turn-notifier';
import type { ConversationSession } from './types';
import { userSettingsStore } from './user-settings-store';
import { WorkingDirectoryManager } from './working-directory-manager';

interface SlackPermalinkTarget {
  channelId: string;
  messageTs: string;
}

interface DmDeleteActionValue {
  requesterId: string;
  targetChannel: string;
  targetTs: string;
}

export class SlackHandler {
  private app: App;
  private claudeHandler: ClaudeHandler;
  private logger = new Logger('SlackHandler');
  private workingDirManager: WorkingDirectoryManager;
  private fileHandler: FileHandler;
  private todoManager: TodoManager;
  private mcpManager: McpManager;

  // Modular helpers
  private slackApi: SlackApiHelper;
  private reactionManager: ReactionManager;
  private contextWindowManager: ContextWindowManager;
  private mcpStatusDisplay: McpStatusDisplay;
  private mcpHealthMonitor: McpHealthMonitor;
  private sessionUiManager: SessionUiManager;
  private actionHandlers: ActionHandlers;
  private eventRouter: EventRouter;
  private threadPanel: ThreadPanel;

  // Concurrency and tracking
  private requestCoordinator: RequestCoordinator;
  private toolTracker: ToolTracker;

  // Command routing
  private commandRouter: CommandRouter;

  // Stream and tool processing
  private toolEventProcessor: ToolEventProcessor;

  // Message validation, status reporting, and todo display
  private messageValidator: MessageValidator;
  private statusReporter: StatusReporter;
  private todoDisplayManager: TodoDisplayManager;

  // Native Slack AI spinner
  private assistantStatusManager: AssistantStatusManager;

  // Pipeline components
  private inputProcessor: InputProcessor;
  private sessionInitializer: SessionInitializer;
  private streamExecutor: StreamExecutor;

  constructor(app: App, claudeHandler: ClaudeHandler, mcpManager: McpManager) {
    this.app = app;
    this.claudeHandler = claudeHandler;
    this.mcpManager = mcpManager;
    this.workingDirManager = new WorkingDirectoryManager();
    this.fileHandler = new FileHandler();
    this.todoManager = new TodoManager();

    // Initialize modular helpers
    this.slackApi = new SlackApiHelper(app);
    this.requestCoordinator = new RequestCoordinator();
    this.toolTracker = new ToolTracker();
    this.reactionManager = new ReactionManager(this.slackApi);
    this.contextWindowManager = new ContextWindowManager(this.slackApi);
    this.mcpStatusDisplay = new McpStatusDisplay(this.slackApi, mcpCallTracker);
    this.mcpHealthMonitor = new McpHealthMonitor(this.slackApi, this.mcpManager);
    this.sessionUiManager = new SessionUiManager(claudeHandler, this.slackApi);
    this.sessionUiManager.setReactionManager(this.reactionManager);
    const completionMessageTracker = new CompletionMessageTracker();
    this.threadPanel = new ThreadPanel({
      slackApi: this.slackApi,
      claudeHandler: this.claudeHandler,
      requestCoordinator: this.requestCoordinator,
      todoManager: this.todoManager,
      completionMessageTracker,
    });

    // Command routing
    const commandDeps: CommandDependencies = {
      workingDirManager: this.workingDirManager,
      mcpManager: this.mcpManager,
      claudeHandler: this.claudeHandler,
      sessionUiManager: this.sessionUiManager,
      requestCoordinator: this.requestCoordinator,
      slackApi: this.slackApi,
      reactionManager: this.reactionManager,
      contextWindowManager: this.contextWindowManager,
    };
    this.commandRouter = new CommandRouter(commandDeps);

    // Message validation, status reporting, and todo display
    this.messageValidator = new MessageValidator(this.workingDirManager, this.claudeHandler);
    this.statusReporter = new StatusReporter(this.slackApi);
    this.todoDisplayManager = new TodoDisplayManager(this.slackApi, this.todoManager, this.reactionManager);
    // Wire todo updates to trigger thread header re-render
    this.todoDisplayManager.setRenderRequestCallback(async (session, sessionKey) => {
      await this.threadPanel?.updatePanel(session, sessionKey);
    });

    // Native Slack AI spinner
    this.assistantStatusManager = new AssistantStatusManager(this.slackApi);

    // Tool processing
    this.toolEventProcessor = new ToolEventProcessor(
      this.toolTracker,
      this.mcpStatusDisplay,
      mcpCallTracker,
      this.assistantStatusManager,
      this.mcpHealthMonitor,
    );
    // Set reaction manager for MCP pending tracking (hourglass emoji)
    this.toolEventProcessor.setReactionManager(this.reactionManager);

    // ActionHandlers needs context
    const actionContext: ActionHandlerContext = {
      slackApi: this.slackApi,
      claudeHandler: this.claudeHandler,
      sessionManager: this.sessionUiManager,
      messageHandler: this.handleMessage.bind(this),
      reactionManager: this.reactionManager,
      threadPanel: this.threadPanel,
      requestCoordinator: this.requestCoordinator,
      completionMessageTracker,
      mcpManager: this.mcpManager,
    };
    this.actionHandlers = new ActionHandlers(actionContext);

    // Pipeline components
    this.inputProcessor = new InputProcessor({
      fileHandler: this.fileHandler,
      commandRouter: this.commandRouter,
    });

    this.sessionInitializer = new SessionInitializer({
      claudeHandler: this.claudeHandler,
      slackApi: this.slackApi,
      messageValidator: this.messageValidator,
      workingDirManager: this.workingDirManager,
      reactionManager: this.reactionManager,
      requestCoordinator: this.requestCoordinator,
      contextWindowManager: this.contextWindowManager,
      assistantStatusManager: this.assistantStatusManager,
      threadPanel: this.threadPanel,
    });

    // Wire turn completion notification channels
    const turnNotifier = new TurnNotifier([
      new SlackBlockKitChannel(this.slackApi, completionMessageTracker),
      new SlackDmChannel(this.slackApi, userSettingsStore),
      new WebhookChannel(userSettingsStore),
      new TelegramChannel(userSettingsStore, process.env.TELEGRAM_BOT_TOKEN),
    ]);

    const summaryTimer = new SummaryTimer();
    const forkExecutor = createForkExecutor(this.claudeHandler);
    const summaryService = new SummaryService(forkExecutor);

    this.streamExecutor = new StreamExecutor({
      claudeHandler: this.claudeHandler,
      fileHandler: this.fileHandler,
      toolEventProcessor: this.toolEventProcessor,
      statusReporter: this.statusReporter,
      reactionManager: this.reactionManager,
      contextWindowManager: this.contextWindowManager,
      toolTracker: this.toolTracker,
      todoDisplayManager: this.todoDisplayManager,
      actionHandlers: this.actionHandlers,
      requestCoordinator: this.requestCoordinator,
      slackApi: this.slackApi,
      assistantStatusManager: this.assistantStatusManager,
      threadPanel: this.threadPanel,
      turnNotifier,
      summaryTimer,
      completionMessageTracker,
      summaryService,
    });

    // EventRouter for event handling
    const eventRouterDeps: EventRouterDeps = {
      slackApi: this.slackApi,
      claudeHandler: this.claudeHandler,
      sessionManager: this.sessionUiManager,
      actionHandlers: this.actionHandlers,
      commandDeps,
    };
    this.eventRouter = new EventRouter(app, eventRouterDeps, this.handleMessage.bind(this));
  }

  /**
   * Main message handler - orchestrates the pipeline
   */
  async handleMessage(event: MessageEvent, say: any): Promise<void> {
    const { channel, thread_ts, ts } = event;
    const originalThreadTs = thread_ts || ts;

    if (channel.startsWith('D')) {
      const handledCleanupRequest = await this.handleDmCleanupRequest(event, say);
      if (handledCleanupRequest) {
        return;
      }
      // DM messages that aren't cleanup requests should not enter the session pipeline.
      // DMs are reserved for bot management commands (message deletion, etc.).
      this.logger.debug('Ignoring non-cleanup DM message', { user: event.user, channel });
      return;
    }

    // Immediately acknowledge the message with eyes emoji
    await this.slackApi.addReaction(channel, ts, 'eyes');

    // Check for abort command: "!" or "!{prompt}"
    const trimmedText = (event.text || '').trim();
    if (trimmedText.startsWith('!')) {
      const sessionKey = this.claudeHandler.getSessionKey(channel, originalThreadTs);
      const aborted = this.requestCoordinator.abortSession(sessionKey);
      const followUpPrompt = trimmedText.slice(1).trim();

      if (followUpPrompt) {
        // "!{prompt}" — abort current request, continue pipeline with new prompt
        if (aborted) {
          this.logger.info('Aborted active request, continuing with new prompt', {
            sessionKey,
            user: event.user,
            prompt: followUpPrompt.substring(0, 100),
          });
        }
        event.text = followUpPrompt;
      } else {
        // "!" only — abort and stop pipeline
        await this.slackApi.removeReaction(channel, ts, 'eyes');
        if (aborted) {
          await this.slackApi.addReaction(channel, ts, 'octagonal_sign');
          this.logger.info('Request aborted by user', { sessionKey, user: event.user });
        } else {
          await this.slackApi.addReaction(channel, ts, 'heavy_multiplication_x');
          this.logger.debug('Abort requested but no active request', { sessionKey, user: event.user });
        }
        return;
      }
    }

    // Wrap say function
    const wrappedSay = async (args: any) => {
      const result = await say({
        text: args.text,
        thread_ts: args.thread_ts,
        blocks: args.blocks,
        attachments: args.attachments,
      });
      return { ts: result?.ts };
    };

    // Step 1: Process files and check for content
    const { files: processedFiles, shouldContinue } = await this.inputProcessor.processFiles(event, wrappedSay);
    if (!shouldContinue) {
      // Remove eyes emoji if nothing to process
      await this.slackApi.removeReaction(channel, ts, 'eyes');
      return;
    }

    this.logger.debug('Received message from Slack', {
      user: event.user,
      channel,
      thread_ts,
      ts,
      text: event.text ? event.text.substring(0, 100) + (event.text.length > 100 ? '...' : '') : '[no text]',
      fileCount: processedFiles.length,
    });

    // Step 2: Route commands
    const { handled, continueWithPrompt, forceWorkflow } = await this.inputProcessor.routeCommand(event, wrappedSay);
    if (handled && !continueWithPrompt) {
      // Command was handled - replace eyes with zap emoji
      await this.slackApi.removeReaction(channel, ts, 'eyes');
      await this.slackApi.addReaction(channel, ts, 'zap');
      return;
    }

    // If command returned a follow-up prompt (e.g., /new <prompt>), use that instead
    const effectiveText = continueWithPrompt || event.text;

    // Step 3: Validate working directory
    const cwdResult = await this.sessionInitializer.validateWorkingDirectory(event, wrappedSay);
    if (!cwdResult.valid) {
      // CWD validation failed - replace eyes with warning emoji
      await this.slackApi.removeReaction(channel, ts, 'eyes');
      await this.slackApi.addReaction(channel, ts, 'warning');
      return;
    }

    // Step 4: Initialize session (pass effectiveText for proper dispatch after command parsing)
    const sessionResult = await this.sessionInitializer.initialize(
      event,
      cwdResult.workingDirectory!,
      effectiveText,
      forceWorkflow,
    );

    // Channel routing check: if session was halted due to wrong channel, stop processing
    if (sessionResult.halted) {
      await this.slackApi.removeReaction(channel, ts, 'eyes');
      return;
    }

    const activeChannel = sessionResult.session.channelId || channel;
    const activeThreadTs = sessionResult.session.threadRootTs || sessionResult.session.threadTs || originalThreadTs;

    const hasPendingChoice = sessionResult.session.actionPanel?.waitingForChoice === true;
    if (hasPendingChoice) {
      await this.threadPanel?.clearChoice(sessionResult.sessionKey);
      // Treat direct user message as completing manual input from choice UI.
      this.claudeHandler.setActivityStateByKey(sessionResult.sessionKey, 'working');
    }

    await this.threadPanel?.create(sessionResult.session, sessionResult.sessionKey);

    // Replace eyes with brain emoji - message is being sent to model
    // Skip for first message (creates thread) - model adds emoji via reactionManager
    await this.slackApi.removeReaction(channel, ts, 'eyes');
    if (thread_ts) {
      await this.slackApi.addReaction(channel, ts, 'brain');
    }

    // Step 5: Execute via AgentSession (Phase 3c — Issue #87)
    // For the initial mention (thread migration), activeThreadTs differs from originalThreadTs.
    // For continuation messages in the work thread, both are equal — fall back to persisted sourceThread.
    const sourceThreadTs =
      activeThreadTs !== originalThreadTs ? originalThreadTs : sessionResult.session.sourceThread?.threadTs;
    const sourceChannel = activeChannel !== channel ? channel : sessionResult.session.sourceThread?.channel;

    const agentSession = this.createAgentSession(sessionResult, wrappedSay, {
      channel: activeChannel,
      threadTs: activeThreadTs,
      user: event.user,
      mentionTs: ts,
      sourceThreadTs,
      sourceChannel,
      synthetic: event.synthetic,
    });

    const continuationHandler: ContinuationHandler = {
      shouldContinue: (result) => {
        const cont = result.continuation as any;
        if (!cont) return { continue: false };
        return { continue: true, prompt: cont.prompt };
      },
      onResetSession: async (continuation: any) => {
        this.claudeHandler.resetSessionContext(activeChannel, activeThreadTs);
        const dispatchText = continuation.dispatchText || continuation.prompt;
        await this.sessionInitializer.runDispatch(
          activeChannel,
          activeThreadTs,
          dispatchText,
          continuation.forceWorkflow,
        );
      },
      refreshSession: () => this.claudeHandler.getSession(activeChannel, activeThreadTs),
    };

    try {
      await agentSession.startWithContinuation(effectiveText || '', continuationHandler, processedFiles);
    } catch (error) {
      // Auto-retry on recoverable errors (merged from main — auto-retry on error)
      const retryAfterMs = agentSession.getRetryAfterMs();
      if (retryAfterMs) {
        const currentSession = this.claudeHandler.getSession(activeChannel, activeThreadTs);
        const retryCount = currentSession?.errorRetryCount ?? 0;
        this.logger.info('Scheduling auto-retry after recoverable error', {
          channelId: activeChannel,
          threadTs: activeThreadTs,
          retryCount,
          delayMs: retryAfterMs,
        });

        // Schedule retry after delay using autoResumeSession pattern.
        // Store timer handle so session reset can cancel it (Issue #215).
        const errorContext = currentSession?.lastErrorContext;
        const sessionIdAtSchedule = currentSession?.sessionId;
        const timer = setTimeout(() => {
          // Verify session hasn't been reset since retry was scheduled (Issue #215)
          const freshSession = this.claudeHandler.getSession(activeChannel, activeThreadTs);
          if (!freshSession || freshSession.sessionId !== sessionIdAtSchedule) {
            this.logger.info('Skipping stale auto-retry — session was reset', {
              channelId: activeChannel,
              threadTs: activeThreadTs,
            });
            return;
          }
          freshSession.pendingRetryTimer = undefined;
          this.autoResumeSession(
            { channelId: activeChannel, threadTs: activeThreadTs, ownerId: event.user },
            undefined,
            errorContext,
          )
            .then(() => {
              this.logger.info('Error auto-retry completed', {
                channelId: activeChannel,
                threadTs: activeThreadTs,
              });
            })
            .catch((retryError) => {
              this.logger.error('Error auto-retry failed', {
                channelId: activeChannel,
                threadTs: activeThreadTs,
                error: (retryError as Error).message,
              });
            });
        }, retryAfterMs);
        // Store handle for cancellation on session reset
        if (currentSession) {
          currentSession.pendingRetryTimer = timer;
        }
        return; // Retry scheduled — don't re-throw
      }
      throw error; // Non-recoverable error — propagate
    }
  }

  /**
   * AgentSession factory — V1QueryAdapter를 세션 컨텍스트로 조립 (Issue #87, Phase 3c)
   */
  private createAgentSession(
    sessionResult: any,
    say: any,
    context: {
      channel: string;
      threadTs: string;
      user: string;
      mentionTs: string;
      sourceThreadTs?: string;
      sourceChannel?: string;
      synthetic?: boolean;
    },
  ): V1QueryAdapter {
    // TurnRunnerSurface adapter: ThreadPanel → TurnRunnerSurface
    const turnRunnerSurface: TurnRunnerSurface = {
      setStatus: async (session, sessionKey, patch) => {
        await this.threadPanel?.setStatus(session, sessionKey, patch);
      },
      finalizeOnEndTurn: async (session, sessionKey, endTurnInfo, hasPendingChoice) => {
        await this.threadPanel?.finalizeOnEndTurn(session, sessionKey, endTurnInfo, hasPendingChoice);
      },
    };

    const turnRunner = new TurnRunner({
      threadSurface: turnRunnerSurface,
      session: sessionResult.session,
      sessionKey: sessionResult.sessionKey,
    });

    const executeParams = {
      session: sessionResult.session,
      sessionKey: sessionResult.sessionKey,
      userName: sessionResult.userName,
      workingDirectory: sessionResult.workingDirectory,
      abortController: sessionResult.abortController,
      processedFiles: [],
      channel: context.channel,
      threadTs: context.threadTs,
      user: context.user,
      say,
      mentionTs: context.mentionTs,
      sourceThreadTs: context.sourceThreadTs,
      sourceChannel: context.sourceChannel,
      isUserInput: !context.synthetic,
    };

    return new V1QueryAdapter({
      streamExecutor: this.streamExecutor,
      executeParams,
      turnRunner,
    });
  }

  private async handleDmCleanupRequest(event: MessageEvent, say: any): Promise<boolean> {
    const target = this.extractSlackPermalinkTarget(event);
    if (!target) {
      return false;
    }

    const targetMessage = await this.slackApi.getMessage(target.channelId, target.messageTs);
    if (!targetMessage) {
      this.logger.info('DM cleanup target not found', target);
      return true;
    }

    const botUserId = await this.slackApi.getBotUserId();
    const isBotMessage = targetMessage.user === botUserId || !!targetMessage.bot_id;
    if (!isBotMessage) {
      return false;
    }

    // Admin users can delete bot messages directly
    if (isAdminUser(event.user)) {
      try {
        await this.slackApi.deleteMessage(target.channelId, target.messageTs);
        await this.slackApi.addReaction(event.channel, event.ts, 'white_check_mark');
        this.logger.info('Admin deleted bot message via DM', {
          adminId: event.user,
          targetChannel: target.channelId,
          targetTs: target.messageTs,
        });
      } catch (error) {
        this.logger.warn('Admin DM cleanup failed', {
          adminId: event.user,
          targetChannel: target.channelId,
          targetTs: target.messageTs,
          error,
        });
        await say({ text: '⚠️ 메시지 삭제에 실패했습니다.' });
      }
      return true;
    }

    // Non-admin users: send delete request to admins for approval
    await this.sendAdminDeleteApproval(event, target, say);
    return true;
  }

  /**
   * Send a delete approval request to admin users via DM.
   * Non-admin users cannot delete bot messages directly.
   */
  private async sendAdminDeleteApproval(event: MessageEvent, target: SlackPermalinkTarget, say: any): Promise<void> {
    const adminUserIds = getAdminUsers();
    if (adminUserIds.size === 0) {
      this.logger.warn('No admin users configured for DM delete approval');
      await say({ text: '⚠️ 어드민이 설정되어 있지 않아 삭제 요청을 보낼 수 없습니다.' });
      return;
    }

    const value: DmDeleteActionValue = {
      requesterId: event.user,
      targetChannel: target.channelId,
      targetTs: target.messageTs,
    };

    const permalink = `https://slack.com/archives/${target.channelId}/p${target.messageTs.replace('.', '')}`;

    // Notify each admin
    let notified = 0;
    for (const adminId of adminUserIds) {
      try {
        const adminDmChannel = await this.slackApi.openDmChannel(adminId);
        await this.slackApi.postMessage(adminDmChannel, '봇 메시지 삭제 요청', {
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `<@${event.user}>님이 봇 메시지 삭제를 요청했습니다.\n<${permalink}|메시지 보기>`,
              },
            },
            {
              type: 'actions',
              elements: [
                {
                  type: 'button',
                  action_id: 'dm_delete_reject',
                  text: { type: 'plain_text', text: '거절', emoji: true },
                  value: JSON.stringify(value),
                },
                {
                  type: 'button',
                  action_id: 'dm_delete_approve',
                  text: { type: 'plain_text', text: '승인', emoji: true },
                  style: 'danger',
                  value: JSON.stringify(value),
                },
              ],
            },
          ],
        });
        notified++;
      } catch (error) {
        this.logger.warn('Failed to send delete approval request to admin', { adminId, error });
      }
    }

    if (notified > 0) {
      await say({ text: '📨 어드민에게 삭제 요청을 보냈습니다. 승인 후 삭제됩니다.' });
      this.logger.info('DM cleanup approval sent to admins', {
        requesterId: event.user,
        targetChannel: target.channelId,
        targetTs: target.messageTs,
        adminsNotified: notified,
      });
    } else {
      await say({ text: '⚠️ 어드민에게 삭제 요청을 보내지 못했습니다.' });
    }
  }

  private extractSlackPermalinkTarget(event: MessageEvent): SlackPermalinkTarget | null {
    const sources: string[] = [];
    if (event.text) {
      sources.push(event.text);
    }

    const rawBlocks = (event as any).blocks;
    if (rawBlocks) {
      sources.push(JSON.stringify(rawBlocks));
    }

    const rawAttachments = (event as any).attachments;
    if (rawAttachments) {
      sources.push(JSON.stringify(rawAttachments));
    }

    for (const source of sources) {
      const match = source.match(/https?:\/\/[^\s>|]*slack\.com\/archives\/([A-Z0-9]+)\/p(\d{10,})/i);
      if (!match) {
        continue;
      }

      const channelId = match[1];
      const rawTs = match[2];
      if (rawTs.length <= 6) {
        continue;
      }

      const messageTs = `${rawTs.slice(0, rawTs.length - 6)}.${rawTs.slice(-6)}`;
      return { channelId, messageTs };
    }

    return null;
  }

  /**
   * Setup all event handlers via EventRouter
   */
  setupEventHandlers(): void {
    this.eventRouter.setup();
  }

  /**
   * Notify all active sessions about server shutdown
   */
  async notifyShutdown(): Promise<void> {
    await this.sessionUiManager.notifyShutdown();
  }

  /**
   * Load saved sessions from file
   */
  loadSavedSessions(): number {
    return this.claudeHandler.loadSessions();
  }

  /**
   * Notify users whose sessions were interrupted by a crash/restart.
   * Should be called after loadSavedSessions() and after Slack app starts.
   */
  /** Resume prompt sent to model for auto-resuming interrupted sessions.
   *  Loaded from src/prompt/restart.prompt at class-load time for easy editing. */
  private static readonly AUTO_RESUME_PROMPT = (() => {
    try {
      return fs.readFileSync(path.join(__dirname, 'prompt', 'restart.prompt'), 'utf-8').trimEnd();
    } catch {
      // Fallback in case the file is missing (e.g. in test environments)
      return (
        '서비스가 재시작되어 이전 작업이 중단되었다. 아래 순서로 작업을 이어가라:\n' +
        '1. mcp__slack-mcp__get_thread_messages (offset: 0, limit: 50)으로 이 스레드의 전체 대화를 먼저 읽어라.\n' +
        '2. 유저가 마지막으로 요청한 작업이 무엇인지 파악하라.\n' +
        '3. 네가 마지막으로 어디까지 진행했는지 확인하라 (git status, 파일 상태 등).\n' +
        '4. 중단된 지점부터 작업을 이어서 완료하라.\n' +
        '5. 만약 작업 상태를 파악할 수 없으면, 유저에게 현재 상황을 설명하고 다음 단계를 물어라.'
      );
    }
  })();

  /** Delay between processing crash-recovered sessions (ms) */
  private static readonly CRASH_RECOVERY_DELAY_MS = 2000;

  async notifyCrashRecovery(): Promise<number> {
    const recovered = this.claudeHandler.getCrashRecoveredSessions();
    if (recovered.length === 0) return 0;

    let notified = 0;
    let autoResumed = 0;
    for (let i = 0; i < recovered.length; i++) {
      const session = recovered[i];
      const isWorking = session.activityState === 'working';

      // Post notification message and capture its ts for use as synthetic event anchor
      let notificationTs: string | undefined;
      try {
        const notificationText = isWorking
          ? `⚠️ 서비스가 재시작되었습니다. 이전 작업(${session.activityState})이 중단되었을 수 있습니다. 자동으로 재개합니다...`
          : `⚠️ 서비스가 재시작되었습니다. 이전 작업(${session.activityState})이 중단되었을 수 있습니다. 다시 시도해주세요.`;

        const result = await this.app.client.chat.postMessage({
          channel: session.channelId,
          thread_ts: session.threadTs,
          text: notificationText,
        });
        notificationTs = result.ts as string | undefined;
        notified++;
      } catch (error) {
        this.logger.warn('Failed to send crash recovery notification', {
          channel: session.channelId,
          threadTs: session.threadTs,
          error: (error as Error).message,
        });
        // Skip auto-resume if notification failed — channel is likely inaccessible
        if (i < recovered.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, SlackHandler.CRASH_RECOVERY_DELAY_MS));
        }
        continue;
      }

      // Auto-resume sessions that were actively working (model mid-execution)
      // IMPORTANT: Fire-and-forget — do NOT await handleMessage.
      // handleMessage triggers Claude SDK streaming which takes minutes.
      // Awaiting would block the loop and prevent other sessions from resuming.
      if (isWorking) {
        this.logger.info('Auto-resuming working session', {
          channelId: session.channelId,
          threadTs: session.threadTs,
          ownerId: session.ownerId,
        });
        this.autoResumeSession(session, notificationTs)
          .then(() => {
            this.logger.info('Auto-resume completed', {
              channelId: session.channelId,
              threadTs: session.threadTs,
            });
          })
          .catch((error) => {
            this.logger.error('Auto-resume failed', {
              channelId: session.channelId,
              threadTs: session.threadTs,
              error: (error as Error).message,
            });
          });
        autoResumed++;
      }

      // Delay between sessions to avoid overwhelming the system
      if (i < recovered.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, SlackHandler.CRASH_RECOVERY_DELAY_MS));
      }
    }

    this.claudeHandler.clearCrashRecoveredSessions();
    this.logger.info(
      `Sent crash recovery notifications to ${notified}/${recovered.length} sessions, auto-resumed ${autoResumed}`,
    );
    return notified;
  }

  /**
   * Auto-resume an interrupted session by sending a synthetic message
   * through the existing handleMessage pipeline.
   */
  private async autoResumeSession(
    session: { channelId: string; threadTs?: string; ownerId: string; title?: string; workflow?: string },
    notificationTs?: string,
    errorContext?: string,
  ): Promise<void> {
    // Use the notification message's ts so that handleMessage's reaction calls
    // (eyes emoji etc.) target a real Slack message instead of a fabricated timestamp.

    // Build context-rich prompt so the model knows WHAT it was doing, not just HOW to resume.
    const contextParts: string[] = [];
    if (session.title) contextParts.push(`세션 제목: ${session.title}`);
    if (session.workflow && session.workflow !== 'default') contextParts.push(`워크플로우: ${session.workflow}`);
    if (errorContext) contextParts.push(`⚠️ 이전 시도 중 오류 발생: ${errorContext}`);

    const resumePrompt =
      contextParts.length > 0
        ? `${SlackHandler.AUTO_RESUME_PROMPT}\n\n--- 중단 시점 컨텍스트 ---\n${contextParts.join('\n')}`
        : SlackHandler.AUTO_RESUME_PROMPT;

    const syntheticEvent: MessageEvent = {
      user: session.ownerId,
      channel: session.channelId,
      thread_ts: session.threadTs,
      ts: notificationTs || `${Date.now() / 1000}`,
      text: resumePrompt,
      synthetic: true,
      skipDispatch: true,
    };

    // Real say — posts to Slack. noopSay silently discarded all bot output.
    const realSay = async (args: any) => {
      const text = typeof args === 'string' ? args : args?.text;
      const result = await this.app.client.chat.postMessage({
        channel: session.channelId,
        text: text || ' ',
        thread_ts: typeof args === 'string' ? session.threadTs : args?.thread_ts || session.threadTs,
        blocks: typeof args === 'string' ? undefined : args?.blocks,
        attachments: typeof args === 'string' ? undefined : args?.attachments,
      });
      return { ts: result.ts as string | undefined };
    };

    await this.handleMessage(syntheticEvent, realSay);
  }

  /**
   * Save sessions to file before shutdown
   */
  saveSessions(): void {
    this.claudeHandler.saveSessions();
  }

  /**
   * Load pending forms from file
   */
  loadPendingForms(): number {
    return this.actionHandlers.loadPendingForms();
  }

  /**
   * Save pending forms to file before shutdown
   */
  savePendingForms(): void {
    this.actionHandlers.savePendingForms();
  }

  /** Expose SlackApiHelper for workspace URL initialization */
  getSlackApi(): SlackApiHelper {
    return this.slackApi;
  }

  /** Expose request coordinator for dashboard stop handler */
  getRequestCoordinator(): RequestCoordinator {
    return this.requestCoordinator;
  }

  /** Expose todo manager for dashboard task accessor */
  getTodoManager(): TodoManager {
    return this.todoManager;
  }

  /** Handle choice answer from dashboard — delegates to ChoiceActionHandler for full Slack UI cleanup */
  async handleDashboardChoiceAnswer(
    sessionKey: string,
    choiceId: string,
    label: string,
    question: string,
  ): Promise<void> {
    const session = this.claudeHandler.getSessionByKey(sessionKey);
    if (!session) {
      throw new Error('Session not found');
    }
    await this.actionHandlers.handleDashboardChoiceAnswer(sessionKey, choiceId, label, question, session.ownerId);
  }

  /** Handle multi-choice form submission from dashboard */
  async handleDashboardMultiChoiceAnswer(
    sessionKey: string,
    selections: Record<string, { choiceId: string; label: string }>,
  ): Promise<void> {
    const session = this.claudeHandler.getSessionByKey(sessionKey);
    if (!session) {
      throw new Error('Session not found');
    }
    await this.actionHandlers.handleDashboardMultiChoiceAnswer(sessionKey, selections, session.ownerId);
  }

  /** Request re-render of the Slack thread header (e.g. after title change) */
  requestThreadSurfaceRender(session: ConversationSession): void {
    this.threadPanel?.updateHeader(session).catch((err) => {
      this.logger.warn('Failed to re-render thread surface after title update', {
        error: err,
        channelId: session.channelId,
        threadTs: session.threadTs,
      });
    });
  }
}
