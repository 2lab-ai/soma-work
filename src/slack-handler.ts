import { App } from '@slack/bolt';
import { ClaudeHandler } from './claude-handler';
import { SDKMessage } from '@anthropic-ai/claude-code';
import { Logger } from './logger';
import { WorkingDirectoryManager } from './working-directory-manager';
import { FileHandler, ProcessedFile } from './file-handler';
import { ConversationSession, UserChoices, UserChoiceQuestion } from './types';
import { TodoManager } from './todo-manager';
import { McpManager } from './mcp-manager';
import { sharedStore, PermissionResponse } from './shared-store';
import { userSettingsStore } from './user-settings-store';
import { config } from './config';
import { mcpCallTracker, McpCallTracker } from './mcp-call-tracker';
import {
  CommandParser,
  ToolFormatter,
  UserChoiceHandler,
  MessageFormatter,
  SlackApiHelper,
  ReactionManager,
  McpStatusDisplay,
  SessionUiManager,
  ActionHandlers,
  ActionHandlerContext,
  EventRouter,
  EventRouterDeps,
  RequestCoordinator,
  ToolTracker,
  CommandRouter,
  CommandDependencies,
  StreamProcessor,
  StreamContext,
  StreamCallbacks,
  ToolEventProcessor,
  ToolUseEvent,
  ToolResultEvent,
  ToolEventContext,
  MessageValidator,
  StatusReporter,
  TodoDisplayManager,
} from './slack';

interface MessageEvent {
  user: string;
  channel: string;
  thread_ts?: string;
  ts: string;
  text?: string;
  files?: Array<{
    id: string;
    name: string;
    mimetype: string;
    filetype: string;
    url_private: string;
    url_private_download: string;
    size: number;
  }>;
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
  private mcpStatusDisplay: McpStatusDisplay;
  private sessionUiManager: SessionUiManager;
  private actionHandlers: ActionHandlers;
  private eventRouter: EventRouter;

  // Phase 2: Session state and concurrency
  private requestCoordinator: RequestCoordinator;
  private toolTracker: ToolTracker;

  // Phase 3: Command routing
  private commandRouter: CommandRouter;

  // Phase 4: Stream and tool processing
  private streamProcessor: StreamProcessor;
  private toolEventProcessor: ToolEventProcessor;

  // Phase 6: Message validation, status reporting, and todo display
  private messageValidator: MessageValidator;
  private statusReporter: StatusReporter;
  private todoDisplayManager: TodoDisplayManager;

  constructor(app: App, claudeHandler: ClaudeHandler, mcpManager: McpManager) {
    this.app = app;
    this.claudeHandler = claudeHandler;
    this.mcpManager = mcpManager;
    this.workingDirManager = new WorkingDirectoryManager();
    this.fileHandler = new FileHandler();
    this.todoManager = new TodoManager();

    // Initialize modular helpers
    this.slackApi = new SlackApiHelper(app);

    // Phase 2: Session state and concurrency
    this.requestCoordinator = new RequestCoordinator();
    this.toolTracker = new ToolTracker();
    this.reactionManager = new ReactionManager(this.slackApi);
    this.mcpStatusDisplay = new McpStatusDisplay(this.slackApi, mcpCallTracker);
    this.sessionUiManager = new SessionUiManager(claudeHandler, this.slackApi);

    // Phase 3: Command routing
    const commandDeps: CommandDependencies = {
      workingDirManager: this.workingDirManager,
      mcpManager: this.mcpManager,
      claudeHandler: this.claudeHandler,
      sessionUiManager: this.sessionUiManager,
    };
    this.commandRouter = new CommandRouter(commandDeps);

    // Phase 6: Message validation, status reporting, and todo display
    this.messageValidator = new MessageValidator(this.workingDirManager, this.claudeHandler);
    this.statusReporter = new StatusReporter(app.client);
    this.todoDisplayManager = new TodoDisplayManager(app.client, this.todoManager, this.reactionManager);

    // Phase 4: Stream and tool processing
    this.toolEventProcessor = new ToolEventProcessor(
      this.toolTracker,
      this.mcpStatusDisplay,
      mcpCallTracker
    );
    this.streamProcessor = new StreamProcessor({
      onToolUse: async (toolUses, context) => {
        await this.toolEventProcessor.handleToolUse(toolUses, {
          channel: context.channel,
          threadTs: context.threadTs,
          say: context.say,
        });
      },
      onToolResult: async (toolResults, context) => {
        await this.toolEventProcessor.handleToolResult(toolResults, {
          channel: context.channel,
          threadTs: context.threadTs,
          say: context.say,
        });
      },
      onTodoUpdate: async (input, context) => {
        await this.todoDisplayManager.handleTodoUpdate(
          input,
          context.sessionKey,
          context.sessionId,
          context.channel,
          context.threadTs,
          context.say
        );
      },
      onStatusUpdate: async (status) => {
        // Status updates are handled in handleMessage
      },
      onPendingFormCreate: (formId, form) => {
        this.actionHandlers.setPendingForm(formId, form);
      },
      getPendingForm: (formId) => {
        return this.actionHandlers.getPendingForm(formId);
      },
    });

    // ActionHandlers needs context
    const actionContext: ActionHandlerContext = {
      slackApi: this.slackApi,
      claudeHandler: this.claudeHandler,
      sessionManager: this.sessionUiManager,
      messageHandler: this.handleMessage.bind(this),
    };
    this.actionHandlers = new ActionHandlers(actionContext);

    // EventRouter for event handling
    const eventRouterDeps: EventRouterDeps = {
      slackApi: this.slackApi,
      claudeHandler: this.claudeHandler,
      sessionManager: this.sessionUiManager,
      actionHandlers: this.actionHandlers,
    };
    this.eventRouter = new EventRouter(app, eventRouterDeps, this.handleMessage.bind(this));
  }

  async handleMessage(event: MessageEvent, say: any) {
    const { user, channel, thread_ts, ts, text, files } = event;

    // Update user's Jira info from mapping (if available)
    userSettingsStore.updateUserJiraInfo(user);

    // Process any attached files
    let processedFiles: ProcessedFile[] = [];
    if (files && files.length > 0) {
      this.logger.info('Processing uploaded files', { count: files.length });
      processedFiles = await this.fileHandler.downloadAndProcessFiles(files);

      if (processedFiles.length > 0) {
        await say({
          text: `📎 Processing ${processedFiles.length} file(s): ${processedFiles.map(f => f.name).join(', ')}`,
          thread_ts: thread_ts || ts,
        });
      }
    }

    // If no text and no files, nothing to process
    if (!text && processedFiles.length === 0) return;

    this.logger.debug('Received message from Slack', {
      user,
      channel,
      thread_ts,
      ts,
      text: text ? text.substring(0, 100) + (text.length > 100 ? '...' : '') : '[no text]',
      fileCount: processedFiles.length,
    });

    // Route to command handlers (cwd, mcp, bypass, persona, model, restore, help, sessions, terminate, all_sessions)
    if (text) {
      const commandResult = await this.commandRouter.route({
        user,
        channel,
        threadTs: thread_ts || ts,
        text,
        say,
      });
      if (commandResult.handled) {
        return;
      }
    }

    // Validate working directory using MessageValidator
    const cwdValidation = this.messageValidator.validateWorkingDirectory(user, channel, thread_ts);
    if (!cwdValidation.valid) {
      await say({
        text: cwdValidation.errorMessage!,
        thread_ts: thread_ts || ts,
      });
      return;
    }
    const workingDirectory = cwdValidation.workingDirectory!;

    // Get user's display name for speaker tag
    const userName = await this.slackApi.getUserName(user);

    // Session key is now based on channel + thread only (shared session)
    const sessionKey = this.claudeHandler.getSessionKey(channel, thread_ts || ts);

    // Store the original message info for status reactions
    const originalMessageTs = thread_ts || ts;
    this.reactionManager.setOriginalMessage(sessionKey, channel, originalMessageTs);

    // Get or create session
    const existingSession = this.claudeHandler.getSession(channel, thread_ts || ts);
    const isNewSession = !existingSession;

    const session = isNewSession
      ? this.claudeHandler.createSession(user, userName, channel, thread_ts || ts)
      : existingSession;

    if (isNewSession) {
      this.logger.debug('Creating new session', { sessionKey, owner: userName });
      // Generate session title from first message
      if (text) {
        const title = MessageFormatter.generateSessionTitle(text);
        this.claudeHandler.setSessionTitle(channel, thread_ts || ts, title);
      }
    } else {
      this.logger.debug('Using existing session', {
        sessionKey,
        sessionId: session.sessionId,
        owner: session.ownerName,
        currentInitiator: session.currentInitiatorName,
      });
    }

    // Check if this user can interrupt the current response
    const canInterrupt = this.claudeHandler.canInterrupt(channel, thread_ts || ts, user);

    // Cancel existing request only if user can interrupt (owner or current initiator)
    if (this.requestCoordinator.isRequestActive(sessionKey) && canInterrupt) {
      this.logger.debug('Cancelling existing request for session', { sessionKey, interruptedBy: userName });
      this.requestCoordinator.abortSession(sessionKey);
    } else if (this.requestCoordinator.isRequestActive(sessionKey) && !canInterrupt) {
      // User cannot interrupt - their message will be queued for after current response
      this.logger.debug('User cannot interrupt, message will be processed after current response', {
        sessionKey,
        user: userName,
        owner: session.ownerName,
        currentInitiator: session.currentInitiatorName,
      });
      // Don't return - we'll still process this message, just won't abort the existing one
      // The existing controller will complete and this new request will start after
    }

    const abortController = new AbortController();
    this.requestCoordinator.setController(sessionKey, abortController);

    // Update the current initiator
    this.claudeHandler.updateInitiator(channel, thread_ts || ts, user, userName);

    let statusMessageTs: string | undefined;

    try {
      // Prepare the prompt with file attachments
      let rawPrompt = processedFiles.length > 0
        ? await this.fileHandler.formatFilePrompt(processedFiles, text || '')
        : text || '';

      // Wrap the prompt with speaker tag to identify who is speaking
      let finalPrompt = `<speaker>${userName}</speaker>\n${rawPrompt}`;

      // Inject user info (Jira name, Slack name) at the end of the prompt
      const userInfo = this.getUserInfoContext(user);
      if (userInfo) {
        finalPrompt = `${finalPrompt}\n\n${userInfo}`;
      }

      this.logger.info('Sending query to Claude Code SDK', {
        prompt: finalPrompt.substring(0, 200) + (finalPrompt.length > 200 ? '...' : ''),
        sessionId: session.sessionId,
        workingDirectory,
        fileCount: processedFiles.length,
        speaker: userName,
        isOwner: session.ownerId === user,
      });

      // Send initial status message via StatusReporter
      statusMessageTs = await this.statusReporter.createStatusMessage(
        channel,
        thread_ts || ts,
        sessionKey,
        'thinking'
      );

      // Add thinking reaction to original message
      await this.reactionManager.updateReaction(sessionKey, this.statusReporter.getStatusEmoji('thinking'));

      // Create Slack context for permission prompts
      const slackContext = {
        channel,
        threadTs: thread_ts || ts,  // Always provide a thread context
        user
      };

      // Create stream context for the stream processor
      const streamContext: StreamContext = {
        channel,
        threadTs: thread_ts || ts,
        sessionKey,
        sessionId: session?.sessionId,
        say: async (msg) => {
          const result = await say({
            text: msg.text,
            thread_ts: msg.thread_ts,
            blocks: msg.blocks,
            attachments: msg.attachments,
          });
          return { ts: result?.ts };
        },
      };

      // Create custom callbacks for status updates
      const streamCallbacks: StreamCallbacks = {
        onToolUse: async (toolUses, ctx) => {
          // Update status to working via StatusReporter
          if (statusMessageTs) {
            await this.statusReporter.updateStatusDirect(channel, statusMessageTs, 'working');
          }
          await this.reactionManager.updateReaction(sessionKey, this.statusReporter.getStatusEmoji('working'));

          // Delegate to tool event processor
          await this.toolEventProcessor.handleToolUse(toolUses, {
            channel: ctx.channel,
            threadTs: ctx.threadTs,
            say: ctx.say,
          });
        },
        onToolResult: async (toolResults, ctx) => {
          await this.toolEventProcessor.handleToolResult(toolResults, {
            channel: ctx.channel,
            threadTs: ctx.threadTs,
            say: ctx.say,
          });
        },
        onTodoUpdate: async (input, ctx) => {
          await this.todoDisplayManager.handleTodoUpdate(
            input,
            ctx.sessionKey,
            ctx.sessionId,
            ctx.channel,
            ctx.threadTs,
            ctx.say
          );
        },
        onPendingFormCreate: (formId, form) => {
          this.actionHandlers.setPendingForm(formId, form);
        },
        getPendingForm: (formId) => {
          return this.actionHandlers.getPendingForm(formId);
        },
      };

      // Create a new stream processor with the callbacks
      const processor = new StreamProcessor(streamCallbacks);

      // Process the stream
      const streamResult = await processor.process(
        this.claudeHandler.streamQuery(finalPrompt, session, abortController, workingDirectory, slackContext),
        streamContext,
        abortController.signal
      );

      // If aborted, throw to trigger the catch block
      if (streamResult.aborted) {
        const abortError = new Error('Request was aborted');
        abortError.name = 'AbortError';
        throw abortError;
      }

      // Update status to completed via StatusReporter
      if (statusMessageTs) {
        await this.statusReporter.updateStatusDirect(channel, statusMessageTs, 'completed');
      }
      await this.reactionManager.updateReaction(sessionKey, this.statusReporter.getStatusEmoji('completed'));

      this.logger.info('Completed processing message', {
        sessionKey,
        messageCount: streamResult.messageCount,
      });

      // Clean up temporary files
      if (processedFiles.length > 0) {
        await this.fileHandler.cleanupTempFiles(processedFiles);
      }
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        this.logger.error('Error handling message', error);

        // Update status to error via StatusReporter
        if (statusMessageTs) {
          await this.statusReporter.updateStatusDirect(channel, statusMessageTs, 'error');
        }
        await this.reactionManager.updateReaction(sessionKey, this.statusReporter.getStatusEmoji('error'));

        await say({
          text: `Error: ${error.message || 'Something went wrong'}`,
          thread_ts: thread_ts || ts,
        });
      } else {
        this.logger.debug('Request was aborted', { sessionKey });

        // Update status to cancelled via StatusReporter
        if (statusMessageTs) {
          await this.statusReporter.updateStatusDirect(channel, statusMessageTs, 'cancelled');
        }
        await this.reactionManager.updateReaction(sessionKey, this.statusReporter.getStatusEmoji('cancelled'));
      }

      // Clean up temporary files in case of error too
      if (processedFiles.length > 0) {
        await this.fileHandler.cleanupTempFiles(processedFiles);
      }
    } finally {
      this.requestCoordinator.removeController(sessionKey);

      // Clean up todo tracking if session ended
      if (session?.sessionId) {
        // Don't immediately clean up - keep todos visible for a while
        this.toolTracker.scheduleCleanup(5 * 60 * 1000, () => {
          this.todoDisplayManager.cleanupSession(session.sessionId!);
          this.todoDisplayManager.cleanup(sessionKey);
          this.reactionManager.cleanup(sessionKey);
          this.statusReporter.cleanup(sessionKey);
        });
      }
    }
  }


  private getUserInfoContext(userId: string): string | null {
    const jiraName = userSettingsStore.getUserJiraName(userId);
    const jiraAccountId = userSettingsStore.getUserJiraAccountId(userId);
    const settings = userSettingsStore.getUserSettings(userId);
    const slackName = settings?.slackName;

    if (!jiraName && !slackName) {
      return null;
    }

    const lines: string[] = ['<user-context>'];
    if (slackName) {
      lines.push(`  <slack-name>${slackName}</slack-name>`);
    }
    if (jiraName) {
      lines.push(`  <jira-name>${jiraName}</jira-name>`);
    }
    if (jiraAccountId) {
      lines.push(`  <jira-account-id>${jiraAccountId}</jira-account-id>`);
    }
    lines.push('</user-context>');

    return lines.join('\n');
  }


  /**
   * Setup all event handlers via EventRouter
   */
  setupEventHandlers(): void {
    this.eventRouter.setup();
  }

  /**
   * Notify all active sessions about server shutdown
   * Called before the service shuts down
   */
  async notifyShutdown(): Promise<void> {
    await this.sessionUiManager.notifyShutdown();
  }

  /**
   * Load saved sessions from file
   * Returns the number of sessions loaded
   */
  loadSavedSessions(): number {
    return this.claudeHandler.loadSessions();
  }

  /**
   * Save sessions to file before shutdown
   */
  saveSessions(): void {
    this.claudeHandler.saveSessions();
  }
}