import { App } from '@slack/bolt';
import { ClaudeHandler } from './claude-handler';
import { Logger } from './logger';
import { WorkingDirectoryManager } from './working-directory-manager';
import { FileHandler } from './file-handler';
import { TodoManager } from './todo-manager';
import { McpManager } from './mcp-manager';
import { mcpCallTracker } from './mcp-call-tracker';
import {
  SlackApiHelper,
  ReactionManager,
  ContextWindowManager,
  McpStatusDisplay,
  McpHealthMonitor,
  SessionUiManager,
  ActionHandlers,
  ActionHandlerContext,
  EventRouter,
  EventRouterDeps,
  RequestCoordinator,
  ActionPanelManager,
  ToolTracker,
  CommandRouter,
  CommandDependencies,
  StreamProcessor,
  ToolEventProcessor,
  MessageValidator,
  StatusReporter,
  TodoDisplayManager,
  AssistantStatusManager,
} from './slack';
import {
  InputProcessor,
  SessionInitializer,
  StreamExecutor,
  MessageEvent,
} from './slack/pipeline';

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
  private actionPanelManager: ActionPanelManager;

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
    this.actionPanelManager = new ActionPanelManager({
      slackApi: this.slackApi,
      claudeHandler: this.claudeHandler,
      requestCoordinator: this.requestCoordinator,
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
    this.statusReporter = new StatusReporter(app.client);
    this.todoDisplayManager = new TodoDisplayManager(app.client, this.todoManager, this.reactionManager);

    // Native Slack AI spinner
    this.assistantStatusManager = new AssistantStatusManager(this.slackApi);

    // Tool processing
    this.toolEventProcessor = new ToolEventProcessor(
      this.toolTracker,
      this.mcpStatusDisplay,
      mcpCallTracker,
      this.assistantStatusManager,
      this.mcpHealthMonitor
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
      actionPanelManager: this.actionPanelManager,
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
      reactionManager: this.reactionManager,
      requestCoordinator: this.requestCoordinator,
      contextWindowManager: this.contextWindowManager,
      assistantStatusManager: this.assistantStatusManager,
      actionPanelManager: this.actionPanelManager,
    });

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
      actionPanelManager: this.actionPanelManager,
    });

    // EventRouter for event handling
    const eventRouterDeps: EventRouterDeps = {
      slackApi: this.slackApi,
      claudeHandler: this.claudeHandler,
      sessionManager: this.sessionUiManager,
      actionHandlers: this.actionHandlers,
    };
    this.eventRouter = new EventRouter(app, eventRouterDeps, this.handleMessage.bind(this));
  }

  /**
   * Main message handler - orchestrates the pipeline
   */
  async handleMessage(event: MessageEvent, say: any): Promise<void> {
    const { channel, thread_ts, ts } = event;
    const threadTs = thread_ts || ts;

    // Immediately acknowledge the message with eyes emoji
    await this.slackApi.addReaction(channel, ts, 'eyes');

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
    const { handled, continueWithPrompt } = await this.inputProcessor.routeCommand(event, wrappedSay);
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
    const sessionResult = await this.sessionInitializer.initialize(event, cwdResult.workingDirectory!, effectiveText);

    // Channel routing check: if session was halted due to wrong channel, stop processing
    if (sessionResult.halted) {
      await this.slackApi.removeReaction(channel, ts, 'eyes');
      return;
    }

    await this.actionPanelManager?.ensurePanel(sessionResult.session, sessionResult.sessionKey);

    // Replace eyes with brain emoji - message is being sent to model
    // Skip for first message (creates thread) - model adds emoji via reactionManager
    await this.slackApi.removeReaction(channel, ts, 'eyes');
    if (thread_ts) {
      await this.slackApi.addReaction(channel, ts, 'brain');
    }

    // Step 5: Execute stream with continuation loop
    let currentText = effectiveText;
    let currentSession = sessionResult.session;
    let currentAbortController = sessionResult.abortController;

    // Continuation loop - handles chained executions (e.g., renew: save -> reset -> load)
    while (true) {
      const result = await this.streamExecutor.execute({
        session: currentSession,
        sessionKey: sessionResult.sessionKey,
        userName: sessionResult.userName,
        workingDirectory: sessionResult.workingDirectory,
        abortController: currentAbortController,
        processedFiles: currentText === effectiveText ? processedFiles : [], // Only pass files on first iteration
        text: currentText,
        channel,
        threadTs,
        user: event.user,
        say: wrappedSay,
      });

      // No continuation - exit loop
      if (!result.continuation) break;

      // Reset session if requested (e.g., renew flow)
      if (result.continuation.resetSession) {
        this.claudeHandler.resetSessionContext(channel, threadTs);
        // Re-run dispatch with the appropriate text
        const dispatchText = result.continuation.dispatchText || result.continuation.prompt;
        await this.sessionInitializer.runDispatch(channel, threadTs, dispatchText);
      }

      // Prepare for next iteration
      currentText = result.continuation.prompt;
      currentAbortController = new AbortController();

      // Re-fetch session after potential reset
      currentSession = this.claudeHandler.getSession(channel, threadTs)!;
    }
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
}
