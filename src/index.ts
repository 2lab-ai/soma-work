import './env-paths';
import { App } from '@slack/bolt';
import { scanChannels } from './channel-registry';
import { ClaudeHandler } from './claude-handler';
import { config, runPreflightChecks, validateConfig } from './config';
import {
  broadcastConversationUpdate,
  broadcastSessionUpdate,
  broadcastTaskUpdate,
  initRecorder,
  setDashboardChoiceAnswerHandler,
  setDashboardCloseHandler,
  setDashboardCommandHandler,
  setDashboardMultiChoiceAnswerHandler,
  setDashboardSessionAccessor,
  setDashboardStopHandler,
  setDashboardTaskAccessor,
  setDashboardTrashHandler,
  setOAuthUserLookup,
  setOnTurnRecordedCallback,
  startWebServer,
  stopWebServer,
} from './conversation';
import { CronScheduler, type SyntheticMessageEvent } from './cron-scheduler';
import { CronStorage } from './cron-storage';
import { initializeDispatchService } from './dispatch-service';
import { CONFIG_FILE, DATA_DIR, MCP_CONFIG_FILE, PLUGINS_DIR } from './env-paths';
import { discoverInstallations, getGitHubAppAuth, isGitHubAppConfigured } from './github-auth.js';
import { Logger } from './logger';
import { McpManager } from './mcp-manager';
import { startReportScheduler, stopReportScheduler } from './metrics';
import { acquirePidLock, releasePidLock } from './pid-lock';
import { PluginManager } from './plugin/plugin-manager';
import { getVersionInfo, notifyRelease } from './release-notifier';
import { SlackHandler } from './slack-handler';
import { notifyStartup } from './startup-notifier';
import { tokenManager } from './token-manager';
import { loadUnifiedConfig } from './unified-config-loader';

const logger = new Logger('Main');

async function start() {
  const startTime = Date.now();
  const timing = (label: string) => {
    const elapsed = Date.now() - startTime;
    logger.info(`[${elapsed}ms] ${label}`);
  };

  try {
    // Validate configuration
    validateConfig();
    timing('Config validated');

    // Single instance guard — prevent duplicate processes (Issue #152)
    if (!acquirePidLock(DATA_DIR)) {
      logger.error(
        'Another soma-work instance is already running. Exiting to prevent duplicate Socket Mode connections.',
      );
      process.exit(1);
    }
    timing('PID lock acquired');

    // Initialize token manager (before preflight — tokens may be needed for API calls)
    tokenManager.initialize(DATA_DIR);
    timing('TokenManager initialized');

    // Run preflight checks
    const preflight = await runPreflightChecks();
    timing('Preflight checks completed');

    if (!preflight.success) {
      logger.error('Preflight checks failed! Fix the errors above before starting.');
      process.exit(1);
    }

    logger.info('Starting Claude Code Slack bot', {
      debug: config.debug,
      useBedrock: config.claude.useBedrock,
      useVertex: config.claude.useVertex,
    });

    // Initialize Slack app
    const app = new App({
      token: config.slack.botToken,
      signingSecret: config.slack.signingSecret,
      socketMode: true,
      appToken: config.slack.appToken,
    });

    // Log ALL incoming events (before any handler)
    app.use(async ({ payload, body, next }) => {
      const bodyAny = body as any;
      const payloadAny = payload as any;
      const eventType = bodyAny?.type || 'unknown';
      const eventSubtype = bodyAny?.event?.type || payloadAny?.type || 'unknown';
      logger.debug(`🔔 SLACK EVENT RECEIVED: ${eventType}/${eventSubtype}`, {
        bodyType: bodyAny?.type,
        eventType: bodyAny?.event?.type,
        payloadType: payloadAny?.type,
        channel: bodyAny?.event?.channel || payloadAny?.channel,
        user: bodyAny?.event?.user || payloadAny?.user,
      });
      await next();
    });

    timing('Slack App initialized');

    // Load unified config (config.json → fallback mcp-servers.json)
    const unifiedConfig = loadUnifiedConfig(CONFIG_FILE, MCP_CONFIG_FILE);
    timing('Unified config loaded');

    // Initialize MCP manager (from unified config or legacy path)
    const mcpManager = unifiedConfig.mcpServers
      ? McpManager.fromParsedServers(unifiedConfig.mcpServers)
      : new McpManager();
    const mcpConfig = mcpManager.loadConfiguration();
    timing(`MCP config loaded (${mcpConfig ? Object.keys(mcpConfig.mcpServers).length : 0} servers)`);

    // Initialize Plugin manager
    const pluginManager = new PluginManager(unifiedConfig.plugin || {}, PLUGINS_DIR);
    try {
      await pluginManager.initialize();
      mcpManager.setPluginManager(pluginManager);
      timing(`Plugins initialized (${pluginManager.getResolvedPlugins().length} plugins)`);
    } catch (error) {
      logger.error('Plugin initialization failed (non-critical, using fallback)', error);
    }

    // Initialize GitHub App authentication and auto-refresh if configured
    if (isGitHubAppConfigured()) {
      await discoverInstallations();
      timing('GitHub installations discovered');

      // Start auto-refresh for GitHub App tokens
      const githubAuth = getGitHubAppAuth();
      if (githubAuth) {
        try {
          await githubAuth.startAutoRefresh();
          timing('GitHub App token auto-refresh started');
          logger.info('GitHub App token auto-refresh initialized');
        } catch (error) {
          logger.error('Failed to start GitHub App token auto-refresh:', error);
        }
      }
    }

    // Initialize AgentManager if agents are configured (Trace: docs/multi-agent/trace.md, S2)
    let agentManager: import('./agent-manager').AgentManager | undefined;
    if (unifiedConfig.agents && Object.keys(unifiedConfig.agents).length > 0) {
      const { AgentManager } = await import('./agent-manager');
      agentManager = new AgentManager(unifiedConfig.agents, mcpManager);
      timing(`AgentManager created (${Object.keys(unifiedConfig.agents).length} agents configured)`);
    }

    // Initialize handlers
    const claudeHandler = new ClaudeHandler(mcpManager);
    // Plugin paths are now resolved dynamically via mcpManager.getPluginManager()?.getPluginPaths()
    // inside ClaudeHandler.getEffectivePluginPaths() — no static injection needed.
    // Inject agent configs into ClaudeHandler's McpConfigBuilder
    if (unifiedConfig.agents && Object.keys(unifiedConfig.agents).length > 0) {
      claudeHandler.setAgentConfigs(unifiedConfig.agents);
    }
    timing('ClaudeHandler initialized');

    // Initialize dispatch service with ClaudeHandler for unified auth
    initializeDispatchService(claudeHandler);
    timing('DispatchService initialized with ClaudeHandler');

    const slackHandler = new SlackHandler(app, claudeHandler, mcpManager);
    timing('SlackHandler initialized');

    // Initialize Slack workspace URL for correct thread permalinks
    try {
      const slackApi = slackHandler.getSlackApi();
      const authContext = await slackApi.getAuthContext();
      const { setSlackWorkspaceUrl } = await import('./turn-notifier');
      setSlackWorkspaceUrl(authContext.url);
      timing(`Slack workspace URL: ${authContext.url}`);
    } catch (error) {
      logger.error('Failed to initialize Slack workspace URL — thread permalinks will be unavailable', error);
    }

    // Setup event handlers
    slackHandler.setupEventHandlers();
    timing('Event handlers setup');

    // Load saved sessions from previous run
    const loadedSessions = slackHandler.loadSavedSessions();
    timing(`Sessions loaded (${loadedSessions} restored)`);
    if (loadedSessions > 0) {
      logger.info(`Restored ${loadedSessions} sessions from previous run`);
    }

    // Load pending forms from previous run
    const loadedForms = slackHandler.loadPendingForms();
    timing(`Pending forms loaded (${loadedForms} restored)`);
    if (loadedForms > 0) {
      logger.info(`Restored ${loadedForms} pending forms from previous run`);
    }

    // Initialize conversation recorder
    initRecorder();
    timing('Conversation recorder initialized');

    // Backfill conversationIds for sessions that lost them across restarts
    const backfilled = await claudeHandler.getSessionRegistry().backfillConversationIds();
    if (backfilled > 0) {
      logger.info(`Backfilled ${backfilled} session conversationIds from conversation storage`);
    }
    timing('ConversationId backfill complete');

    // Connect dashboard: session accessor + real-time WebSocket broadcast on state changes
    setDashboardSessionAccessor(() => claudeHandler.getAllSessions());
    claudeHandler.getSessionRegistry().setActivityStateChangeCallback(() => broadcastSessionUpdate());

    // Connect dashboard: task accessor (resolve sessionKey → sessionId for TodoManager)
    setDashboardTaskAccessor((sessionKey: string) => {
      const session = claudeHandler.getSessionRegistry().getSessionByKey(sessionKey);
      const lookupId = session?.sessionId || sessionKey;
      const todos = slackHandler.getTodoManager().getTodos(lookupId);
      return todos.map((t) => ({
        content: t.content,
        status: t.status,
        startedAt: t.startedAt,
        completedAt: t.completedAt,
      }));
    });

    // Connect dashboard: stop handler (abort running session)
    setDashboardStopHandler(async (sessionKey: string) => {
      slackHandler.getRequestCoordinator().abortSession(sessionKey);
      logger.info('Dashboard: stopped session', { sessionKey });
    });

    // Connect dashboard: close handler (terminate session)
    setDashboardCloseHandler(async (sessionKey: string) => {
      claudeHandler.terminateSession(sessionKey);
      logger.info('Dashboard: closed session', { sessionKey });
    });

    // Connect dashboard: trash handler (hide session from dashboard)
    setDashboardTrashHandler(async (sessionKey: string) => {
      claudeHandler.getSessionRegistry().trashSession(sessionKey);
      logger.info('Dashboard: trashed session', { sessionKey });
    });

    // Connect dashboard: command handler (inject message as if user typed in Slack)
    setDashboardCommandHandler(async (sessionKey: string, message: string) => {
      const session = claudeHandler.getSessionByKey(sessionKey);
      if (!session) {
        logger.warn('Dashboard command: session not found', { sessionKey });
        return;
      }
      // Dashboard bypasses Slack, so the thread lacks the user's input without this echo
      const senderName = session.ownerName || 'Dashboard';
      const escapedName = senderName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const escapedMessage = message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const echoResult = await app.client.chat
        .postMessage({
          channel: session.channelId,
          text: `${escapedName}: ${escapedMessage}`,
          thread_ts: session.threadTs,
        })
        .catch((err) => {
          logger.warn('Dashboard echo failed', { err });
          return undefined;
        });

      const dashboardSay = async (args: any) => {
        const text = typeof args === 'string' ? args : args?.text;
        const result = await app.client.chat.postMessage({
          channel: session.channelId,
          text: text || ' ',
          thread_ts: typeof args === 'string' ? session.threadTs : args?.thread_ts || session.threadTs,
          blocks: typeof args === 'string' ? undefined : args?.blocks,
          attachments: typeof args === 'string' ? undefined : args?.attachments,
        });
        return { ts: result.ts as string | undefined };
      };
      await slackHandler.handleMessage(
        {
          type: 'message',
          channel: session.channelId,
          thread_ts: session.threadTs,
          text: message,
          user: session.ownerId,
          ts: echoResult?.ts || String(Date.now() / 1000),
        } as any,
        dashboardSay,
      );
      logger.info('Dashboard: command sent to session', { sessionKey, messageLength: message.length });
    });

    // Connect dashboard: choice answer handler (dashboard button click → same path as Slack button)
    setDashboardChoiceAnswerHandler(async (sessionKey: string, choiceId: string, label: string, question: string) => {
      try {
        await slackHandler.handleDashboardChoiceAnswer(sessionKey, choiceId, label, question);
        logger.info('Dashboard: choice answered', { sessionKey, choiceId, label });
      } catch (error) {
        logger.error('Dashboard: choice answer failed', { sessionKey, choiceId, label, error });
        throw error; // Re-throw so the API endpoint returns the correct HTTP status
      }
    });

    // Connect dashboard: multi-choice form answer handler
    setDashboardMultiChoiceAnswerHandler(
      async (sessionKey: string, selections: Record<string, { choiceId: string; label: string }>) => {
        try {
          await slackHandler.handleDashboardMultiChoiceAnswer(sessionKey, selections);
          logger.info('Dashboard: multi-choice answered', {
            sessionKey,
            selectionCount: Object.keys(selections).length,
          });
        } catch (error) {
          logger.error('Dashboard: multi-choice answer failed', { sessionKey, error });
          throw error;
        }
      },
    );

    // Connect dashboard: real-time task updates
    // TodoManager fires with sessionId, but dashboard caches by sessionKey.
    // Resolve sessionId → sessionKey so WebSocket clients can match the update.
    slackHandler.getTodoManager().setOnUpdateCallback((sessionId, todos) => {
      let sessionKey = sessionId;
      const allSessions = claudeHandler.getSessionRegistry().getAllSessions();
      for (const [key, session] of allSessions) {
        if (session.sessionId === sessionId) {
          sessionKey = key;
          break;
        }
      }
      broadcastTaskUpdate(
        sessionKey,
        todos.map((t) => ({
          content: t.content,
          status: t.status,
          activeForm: t.activeForm,
          startedAt: t.startedAt,
          completedAt: t.completedAt,
        })),
      );
    });

    // Connect dashboard: real-time conversation turn updates
    setOnTurnRecordedCallback((conversationId, turn) => {
      broadcastConversationUpdate(conversationId, turn);
    });

    // Connect OAuth: email → Slack user lookup for dashboard login
    {
      const { userSettingsStore } = await import('./user-settings-store');
      setOAuthUserLookup((email: string) => {
        const allUsers = userSettingsStore.getAllUsers();
        const emailLower = email.toLowerCase();
        for (const u of allUsers) {
          if (u.email && u.email.toLowerCase() === emailLower) {
            return { userId: u.userId, name: u.slackName || u.userId };
          }
        }
        return null;
      });
    }

    // Start conversation viewer web server (includes dashboard)
    try {
      await startWebServer();
      timing('Conversation viewer web server started');
    } catch (error) {
      logger.warn('Failed to start conversation viewer (non-critical)', error);
    }

    // Start the app
    await app.start();
    timing('Slack socket connected');

    // Start sub-agent instances after main bot (Trace: docs/multi-agent/trace.md, S2)
    if (agentManager) {
      try {
        await agentManager.startAll();
        timing('Sub-agents started');
      } catch (error) {
        logger.error('AgentManager.startAll() failed (non-critical)', error);
      }
    }

    const versionInfoForLog = getVersionInfo();
    const versionTag = versionInfoForLog
      ? `v${versionInfoForLog.version} (${versionInfoForLog.commitHash?.slice(0, 7) || 'dev'})`
      : 'dev';
    logger.info(`⚡️ Claude Code Slack bot is running! [${versionTag}]`);

    // Start report scheduler (non-blocking, non-critical)
    try {
      const slackApiForReports = {
        async postMessage(channel: string, text: string, options?: { blocks?: any[]; threadTs?: string }) {
          const result = await app.client.chat.postMessage({
            channel,
            text,
            blocks: options?.blocks,
            thread_ts: options?.threadTs,
          });
          return { ts: result.ts, channel: result.channel };
        },
      };
      startReportScheduler(slackApiForReports);
      timing('Report scheduler initialized');
    } catch (error) {
      logger.warn('Failed to start report scheduler (non-critical)', error);
    }

    // Start cron scheduler (non-blocking, non-critical)
    // Trace: docs/cron-scheduler/spec.md §5.4 — Scheduler lifecycle
    let cronScheduler: CronScheduler | null = null;
    try {
      const cronStorage = new CronStorage();

      // Build a real say function that posts to Slack via chat.postMessage.
      // noopSay caused drain output to be silently discarded — the model ran
      // but its responses never reached the channel.
      const makeSay = (channel: string, threadTs?: string) => {
        return async (args: any) => {
          const text = typeof args === 'string' ? args : args?.text;
          const result = await app.client.chat.postMessage({
            channel,
            text: text || ' ',
            thread_ts: typeof args === 'string' ? threadTs : args?.thread_ts || threadTs,
            blocks: typeof args === 'string' ? undefined : args?.blocks,
            attachments: typeof args === 'string' ? undefined : args?.attachments,
          });
          return { ts: result.ts as string | undefined };
        };
      };

      const messageInjector = async (event: SyntheticMessageEvent) => {
        const say = makeSay(event.channel, event.thread_ts);
        await slackHandler.handleMessage(event as any, say);
      };

      const threadCreator = async (channel: string, text: string): Promise<string | undefined> => {
        const result = await app.client.chat.postMessage({ channel, text });
        return result.ts as string | undefined;
      };

      const dmSender = async (userId: string, text: string): Promise<void> => {
        // Open DM channel with user, then post message
        const dmResult = await app.client.conversations.open({ users: userId });
        const dmChannel = dmResult.channel?.id;
        if (!dmChannel) throw new Error(`Failed to open DM channel with ${userId}`);
        await app.client.chat.postMessage({ channel: dmChannel, text });
      };

      const threadReplier = async (channel: string, threadTs: string, text: string): Promise<void> => {
        await app.client.chat.postMessage({ channel, text, thread_ts: threadTs });
      };

      cronScheduler = new CronScheduler({
        storage: cronStorage,
        sessionRegistry: claudeHandler.getSessionRegistry(),
        messageInjector,
        threadCreator,
        dmSender,
        threadReplier,
      });
      cronScheduler.start();
      timing('Cron scheduler initialized');
    } catch (error) {
      logger.warn('Failed to start cron scheduler (non-critical)', error);
    }

    // Notify users whose sessions were interrupted by crash (non-blocking)
    slackHandler
      .notifyCrashRecovery()
      .then((notified) => {
        if (notified > 0) {
          timing(`Crash recovery notifications sent (${notified} sessions)`);
        }
      })
      .catch((error) => {
        logger.warn('Crash recovery notifications failed (non-critical)', error);
      });

    // Scan channels the bot is a member of (non-blocking)
    scanChannels(app.client)
      .then((count) => {
        timing(`Channel scan complete (${count} channels)`);
      })
      .catch((error) => {
        logger.warn('Channel scan failed (non-critical)', error);
      });

    // Send release notification to configured channel
    try {
      await notifyRelease(app.client);
      timing('Release notification sent');
    } catch (error) {
      logger.warn('Failed to send release notification (non-critical)', error);
    }

    try {
      const startupNotified = await notifyStartup(app.client, {
        loadedSessions,
        mcpNames: mcpConfig ? Object.keys(mcpConfig.mcpServers) : [],
        versionInfo: getVersionInfo(),
      });
      if (startupNotified) {
        timing('Startup notification sent');
      }
    } catch (err) {
      logger.error('Failed to send startup notification', err);
    }

    // Handle graceful shutdown
    let isShuttingDown = false;
    const cleanup = async () => {
      if (isShuttingDown) return;
      isShuttingDown = true;

      logger.info('Shutting down gracefully...');

      try {
        // Stop report scheduler
        stopReportScheduler();

        // Stop cron scheduler
        if (cronScheduler) {
          cronScheduler.stop();
        }

        // Notify all active sessions about shutdown
        await slackHandler.notifyShutdown();

        // Save sessions for persistence
        slackHandler.saveSessions();
        logger.info('Sessions saved successfully');

        // Save pending forms for persistence
        slackHandler.savePendingForms();
        logger.info('Pending forms saved successfully');

        // Stop sub-agents (Trace: docs/multi-agent/trace.md, S7)
        if (agentManager) {
          await agentManager.stopAll();
          logger.info('Sub-agents stopped');
        }
      } catch (error) {
        logger.error('Error during shutdown:', error);
      }

      const githubAuth = getGitHubAppAuth();
      if (githubAuth) {
        githubAuth.stopAutoRefresh();
        logger.info('GitHub App auto-refresh stopped');
      }

      // Stop conversation viewer
      try {
        await stopWebServer();
        logger.info('Conversation viewer stopped');
      } catch (error) {
        logger.error('Error stopping conversation viewer:', error);
      }

      // Release PID lock last — after all connections are torn down
      releasePidLock(DATA_DIR);

      process.exit(0);
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    // Crash safety net: save sessions before unclean exit
    // SDK can throw uncaught exceptions (e.g., write to aborted process)
    // Uses console.error instead of logger — logger may not flush before process.exit
    process.on('uncaughtException', (error) => {
      console.error('CRASH: uncaught exception — saving sessions before exit', error);
      try {
        slackHandler.saveSessions();
        slackHandler.savePendingForms();
        console.error('CRASH: sessions saved successfully');
      } catch (saveError) {
        console.error('CRASH: failed to save sessions', saveError);
      }
      process.exit(1);
    });

    process.on('unhandledRejection', (reason) => {
      console.error('CRASH: unhandled rejection — saving sessions before exit', reason);
      try {
        slackHandler.saveSessions();
        slackHandler.savePendingForms();
        console.error('CRASH: sessions saved successfully');
      } catch (saveError) {
        console.error('CRASH: failed to save sessions', saveError);
      }
      process.exit(1);
    });

    // Periodic session auto-save (every 5 minutes)
    // Reduces session loss on crash to at most 5 minutes of data
    const SESSION_SAVE_INTERVAL = 5 * 60 * 1000;
    setInterval(() => {
      try {
        slackHandler.saveSessions();
        logger.debug('Periodic session auto-save completed');
      } catch (error) {
        logger.error('Periodic session auto-save failed', error);
      }
    }, SESSION_SAVE_INTERVAL);

    logger.info('Configuration:', {
      usingBedrock: config.claude.useBedrock,
      usingVertex: config.claude.useVertex,
      usingAnthropicAPI: !config.claude.useBedrock && !config.claude.useVertex,
      debugMode: config.debug,
      baseDirectory: config.baseDirectory || 'not set',
      mcpServers: mcpConfig ? Object.keys(mcpConfig.mcpServers).length : 0,
      mcpServerNames: mcpConfig ? Object.keys(mcpConfig.mcpServers) : [],
    });
  } catch (error) {
    logger.error('Failed to start the bot', error);
    process.exit(1);
  }
}

start();
