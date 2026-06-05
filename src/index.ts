import { installConsoleRedaction } from './logger';

installConsoleRedaction();

import './env-paths';
import { registerMemoryStore, registerSkillStore } from 'somalib/model-commands/catalog';
import * as userMemoryStore from './user-memory-store';
import { setSettingsPromptInvalidationHook } from './user-settings-store';
import {
  createUserSkill,
  deleteUserSkill,
  listUserSkills,
  renameUserSkill,
  setSkillPromptInvalidationHook,
  shareUserSkill,
  updateUserSkill,
} from './user-skill-store';

registerMemoryStore(userMemoryStore);
registerSkillStore({
  listSkills: listUserSkills,
  createSkill: createUserSkill,
  updateSkill: updateUserSkill,
  deleteSkill: deleteUserSkill,
  shareSkill: shareUserSkill,
  renameSkill: renameUserSkill,
});

import { App, LogLevel, SocketModeReceiver } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import * as path from 'path';
import { CronStorage } from 'somalib/cron/cron-storage';
import { initA2tService, shutdownA2tService } from './a2t/a2t-service';
import { setQueryEnvAdditional } from './auth/query-env-builder';
import { scanChannels } from './channel-registry';
import { ClaudeHandler } from './claude-handler';
import { config, runPreflightChecks, validateConfig } from './config';
import { loadConfig } from './config-loader';
import {
  broadcastConversationUpdate,
  broadcastSessionUpdate,
  broadcastSummaryTitleChanged,
  broadcastTaskUpdate,
  initRecorder,
  setDashboardChoiceAnswerHandler,
  setDashboardCloseHandler,
  setDashboardCommandHandler,
  setDashboardMultiChoiceAnswerHandler,
  setDashboardSessionAccessor,
  setDashboardStopHandler,
  setDashboardSubmitRecommendedHandler,
  setDashboardTaskAccessor,
  setDashboardTrashHandler,
  setOAuthUserLookup,
  setOnSummaryGeneratedCallback,
  setOnTurnRecordedCallback,
  setSessionTitleBridge,
  startWebServer,
  stopWebServer,
} from './conversation';
import { CronScheduler, type SyntheticMessageEvent } from './cron-scheduler';
import { forceMigrateOpus1m } from './deploy/force-migrate-opus-1m';
import { initializeDispatchService } from './dispatch-service';
import { CONFIG_FILE, DATA_DIR, PLUGINS_DIR } from './env-paths';
import { discoverInstallations, getGitHubAppAuth, isGitHubAppConfigured } from './github-auth.js';
import { Logger } from './logger';
import { McpManager } from './mcp-manager';
import { startReportScheduler, stopReportScheduler } from './metrics';
import {
  evaluateAndMaybeRotate,
  notifyAutoRotation,
  type OAuthRefreshScheduler,
  startOAuthRefreshScheduler,
  startUsageRefreshScheduler,
  type UsageRefreshScheduler,
} from './oauth';
import { acquirePidLock, releasePidLock } from './pid-lock';
import { PluginManager } from './plugin/plugin-manager';
import { buildGoalContinuationPrompt } from './prompt/session-goal-block';
import { getVersionInfo, notifyRelease } from './release-notifier';
import {
  applyGoalEvalDispatchFailure,
  decideGoalEvalOutcome,
  evaluateGoalCompletion,
  shouldRunGoalIdleDriver,
} from './slack/goal-completion-evaluator';
import { GOAL_CONTINUATION_TEXT_PREFIX } from './slack/goal-continuation';
import { SlackHandler } from './slack-handler';
import { type SocketWatchdogUnhealthyReason, startSlackSocketWatchdog } from './slack-socket-watchdog';
import { notifyStartup } from './startup-notifier';
import { getTokenManager } from './token-manager';

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

    // #1003 — release the PID lock on EVERY exit path, not just SIGINT/SIGTERM.
    // The socket-watchdog trip (`process.exit(1)`), the preflight-failure exit,
    // and the uncaughtException/unhandledRejection crash handlers all bypass
    // `cleanup`, so without this the lock file survives and the next boot logs
    // "Stale PID lock detected" (~45x/rotation in dev ≈ 2× each watchdog
    // restart). Registered immediately after acquisition so it also covers an
    // exit between here and the SIGINT/SIGTERM wiring below. Must stay
    // synchronous — `releasePidLock` uses sync fs only, and only unlinks when
    // the lock file still holds THIS pid (safe no-op otherwise).
    process.on('exit', () => {
      releasePidLock(DATA_DIR);
    });

    // Initialize token manager (before preflight — tokens may be needed for API calls)
    // Align DATA_DIR so getTokenManager()'s singleton resolves the same cct-store.json
    // path as env-paths computed above (branch detection + dotenv already ran).
    process.env.DATA_DIR = DATA_DIR;
    const tokenManager = getTokenManager();
    await tokenManager.init({ startReaper: true });
    timing('TokenManager initialized');

    // One-shot force-migration: every existing user.defaultModel that isn't
    // already `claude-opus-4-8[1m]` is rewritten to it. Gated by a dedicated
    // marker in DATA_DIR so a re-deploy of the same host doesn't re-touch.
    // MUST run before UserSettingsStore.load (further down) so the store
    // sees the migrated file.
    const opus1mResult = forceMigrateOpus1m({ dataDir: DATA_DIR });
    logger.info(
      `opus[1m] migration: ${opus1mResult.status} (migrated=${opus1mResult.migrated}/${opus1mResult.total}, marker=${opus1mResult.markerFile})`,
    );
    timing('opus[1m] migration evaluated');

    // Run preflight checks
    const preflight = await runPreflightChecks();
    timing('Preflight checks completed');

    if (!preflight.success) {
      logger.error('Preflight checks failed! Fix the errors above before starting.');
      process.exit(1);
    }

    // Start CCT usage refresh scheduler (#641 M1-S1).
    // Periodically pumps TokenManager.fetchUsageForAllAttached — the tick
    // MUST NOT pass { force: true } (see src/oauth/usage-scheduler.ts).
    // Null is returned when USAGE_REFRESH_ENABLED=0 kills the feature flag.
    const usageRefreshScheduler: UsageRefreshScheduler | null = startUsageRefreshScheduler(tokenManager, {
      intervalMs: config.usage.refreshIntervalMs,
      timeoutMs: config.usage.fetchTimeoutMs,
      enabled: config.usage.refreshEnabled,
    });
    timing('Usage refresh scheduler wired');

    // OAuth refresh + auto-rotation scheduler is wired AFTER `new App`
    // below (#737 P0 hygiene fix) so we can pass `app.client` directly
    // to the rotation notifier — no late-binding closure required.
    let oauthRefreshScheduler: OAuthRefreshScheduler | null = null;

    logger.info('Starting Claude Code Slack bot', {
      debug: config.debug,
      useBedrock: config.claude.useBedrock,
      useVertex: config.claude.useVertex,
    });

    // Construct the SocketMode receiver explicitly (instead of `App({
    // socketMode: true })`) for three reasons:
    //   1. Raise `clientPingTimeout` above the 5s default — that default
    //      was producing false-positive disconnects that wedged the
    //      internal reconnect loop on iq-64 dev (PR #992).
    //   2. Honor `SLACK_LOG_LEVEL=debug` per-host (PR #990) and propagate
    //      it to the SocketMode receiver so wss lifecycle transitions are
    //      observable when the next incident hits.
    //   3. Expose `receiver.client` directly for the lifecycle observer
    //      below and the watchdog wired after `app.start()`.
    // `pingPongLoggingEnabled` keeps ping/pong visible in stderr.
    const slackLogLevel = process.env.SLACK_LOG_LEVEL === 'debug' ? LogLevel.DEBUG : LogLevel.INFO;
    const slackReceiver = new SocketModeReceiver({
      appToken: config.slack.appToken,
      clientPingTimeout: 30_000,
      pingPongLoggingEnabled: true,
      logLevel: slackLogLevel,
    });
    const app = new App({
      token: config.slack.botToken,
      signingSecret: config.slack.signingSecret,
      receiver: slackReceiver,
      logLevel: slackLogLevel,
    });

    // Diagnostic lifecycle observer (PR #990). Surfaces wss transitions
    // regardless of log level so the next incident has a paper trail.
    // Direct reference to `slackReceiver.client` — no internal-API cast
    // needed since we own the receiver.
    {
      const smClient = slackReceiver.client;
      const events = [
        'connecting',
        'authenticated',
        'connected',
        'disconnecting',
        'disconnected',
        'reconnecting',
        'unable_to_socket_mode_start',
        'error',
      ];
      for (const evt of events) {
        smClient.on(evt, (...args: unknown[]) => {
          // The error path can carry an Error instance; coerce so we get
          // message + code instead of `{}`.
          const first = args[0];
          const payload =
            first instanceof Error
              ? { name: first.name, message: first.message, code: (first as unknown as { code?: string }).code }
              : first && typeof first === 'object'
                ? first
                : { value: first };
          logger.info(`[socket-mode-diag] ${evt}`, payload as Record<string, unknown>);
        });
      }
      logger.info('[socket-mode-diag] lifecycle listeners attached');
    }

    // #653 M2 — Start CCT OAuth-token refresh scheduler. Hourly fan-out
    // force-refreshes every attached slot's access_token via
    // `TokenManager.refreshAllAttachedOAuthTokens`. Surfaces stale
    // refreshTokens as `refresh_failed` within 1h and keeps the card's
    // "OAuth refreshes in X" hint honest. Null when OAUTH_REFRESH_ENABLED=0.
    //
    // #737 — onAfterTick wires auto CCT rotation. Wired after `new App`
    // so we pass `app.client` directly (no late-binding closure). The
    // CAS commit primitive `applyTokenIfActiveMatches` re-validates the
    // active slot's lease count + target slot's eligibility inside the
    // same store.mutate that flips activeKeyId — preventing a TOCTOU
    // window between the evaluator's snapshot read and the commit.
    const slackClient: WebClient = app.client;
    oauthRefreshScheduler = startOAuthRefreshScheduler(tokenManager, {
      intervalMs: config.oauthRefresh.intervalMs,
      timeoutMs: config.oauthRefresh.fanOutTimeoutMs,
      enabled: config.oauthRefresh.enabled,
      onAfterTick: async () => {
        const outcome = await evaluateAndMaybeRotate(
          {
            loadSnapshot: () => tokenManager.getSnapshot(),
            applyTokenIfActiveMatches: (target, expected, precond) =>
              tokenManager.applyTokenIfActiveMatches(target, expected, precond),
          },
          {
            enabled: config.autoRotate.enabled,
            dryRun: config.autoRotate.dryRun,
            thresholds: {
              fiveHourMax: config.autoRotate.fiveHourMax,
              sevenDayMax: config.autoRotate.sevenDayMax,
            },
            // Reject candidates whose usage snapshot is older than 2× the
            // usage refresh interval. A stuck poller can't pin the rotation
            // decision on a stale resetsAt that has already elapsed upstream.
            usageMaxAgeMs: 2 * config.usage.refreshIntervalMs,
          },
        );
        if (outcome.kind === 'rotated') {
          logger.info('Auto CCT rotated', {
            from: outcome.from?.name,
            to: outcome.to.name,
            sevenDayResetsAt: outcome.to.sevenDayResetsAt,
          });
          await notifyAutoRotation(slackClient, { from: outcome.from, to: outcome.to });
        } else if (outcome.kind === 'noop') {
          logger.debug('Auto CCT rotation no-op', {
            reason: outcome.reason,
            active: outcome.active?.name,
          });
        } else if (outcome.kind === 'skipped') {
          logger.info('Auto CCT rotation skipped', { reason: outcome.reason });
        } else if (outcome.kind === 'dry-run') {
          logger.info('Auto CCT rotation dry-run', {
            would: outcome.would,
            from: outcome.from?.name,
            to: outcome.to?.name,
          });
        }
      },
    });
    timing('OAuth refresh scheduler wired');

    // Log ALL incoming events (before any handler)
    type SlackEventBody = {
      type?: string;
      event?: { type?: string; channel?: string; user?: string };
    };
    type SlackEventPayload = { type?: string; channel?: string; user?: string };
    app.use(async ({ payload, body, next }) => {
      const bodyShape = body as SlackEventBody;
      const payloadShape = payload as SlackEventPayload;
      const eventType = bodyShape?.type || 'unknown';
      const eventSubtype = bodyShape?.event?.type || payloadShape?.type || 'unknown';
      logger.debug(`🔔 SLACK EVENT RECEIVED: ${eventType}/${eventSubtype}`, {
        bodyType: bodyShape?.type,
        eventType: bodyShape?.event?.type,
        payloadType: payloadShape?.type,
        channel: bodyShape?.event?.channel || payloadShape?.channel,
        user: bodyShape?.event?.user || payloadShape?.user,
      });
      await next();
    });

    timing('Slack App initialized');

    // Load config from config.json (mcpServers + plugin + agents + claude.env + a2t)
    const appConfig = loadConfig(CONFIG_FILE);
    timing('Config loaded');

    // Install operator-controlled additional env (config.json#claude.env)
    // BEFORE any ClaudeHandler / SDK consumers are constructed, so every
    // subsequent buildQueryEnv() call across all 7 callsites in the repo
    // (claude-handler ×2, conversation/* ×3, slack/z/topics/*) sees the
    // installed env. Hot reload is intentionally not supported — operators
    // must restart after editing config.json#claude.env.
    const claudeEnv = appConfig['claude.env'] ?? {};
    setQueryEnvAdditional(claudeEnv);
    const claudeEnvKeys = Object.keys(claudeEnv);
    if (claudeEnvKeys.length > 0) {
      // Keys-only — values are operator-supplied and may be secrets.
      timing(`claude.env applied (${claudeEnvKeys.length} vars): [${claudeEnvKeys.join(', ')}]`);
    }

    // Initialize MCP manager from config.json#mcpServers.
    // Empty section ⇒ start with no remote MCP servers; default/internal
    // servers (llm, agent, model-command, …) are still provisioned by
    // McpServerFactory inside the manager.
    const mcpManager = McpManager.fromParsedServers(appConfig.mcpServers ?? {});
    const mcpConfig = mcpManager.loadConfiguration();
    timing(`MCP config loaded (${mcpConfig ? Object.keys(mcpConfig.mcpServers).length : 0} servers)`);

    // Initialize Plugin manager
    const pluginManager = new PluginManager(appConfig.plugin || {}, PLUGINS_DIR);
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

    // Initialize A2T service (audio-to-text transcription, non-critical)
    try {
      const a2tConfig = appConfig.a2t || {};
      if (a2tConfig.enabled !== false) {
        const a2t = await initA2tService(a2tConfig);
        if (a2t) {
          timing(`A2T service initialized (${a2t.getStatus().state})`);
        } else {
          timing('A2T service unavailable (Python/faster-whisper not installed)');
        }
      } else {
        timing('A2T service disabled by configuration');
      }
    } catch (error) {
      logger.warn('Failed to start A2T service (non-critical)', error);
    }

    // Initialize AgentManager if agents are configured (Trace: docs/current/plans/multi-agent/trace.md, S2)
    let agentManager: import('./agent-manager').AgentManager | undefined;
    if (appConfig.agents && Object.keys(appConfig.agents).length > 0) {
      const { AgentManager } = await import('./agent-manager');
      agentManager = new AgentManager(appConfig.agents, mcpManager);
      timing(`AgentManager created (${Object.keys(appConfig.agents).length} agents configured)`);
    }

    // Initialize handlers
    const claudeHandler = new ClaudeHandler(mcpManager);
    // Plugin paths are now resolved dynamically via mcpManager.getPluginManager()?.getPluginPaths()
    // inside ClaudeHandler.getEffectivePluginPaths() — no static injection needed.
    // Inject agent configs into ClaudeHandler's McpConfigBuilder
    if (appConfig.agents && Object.keys(appConfig.agents).length > 0) {
      claudeHandler.setAgentConfigs(appConfig.agents);
    }
    timing('ClaudeHandler initialized');

    // Initialize dispatch service with ClaudeHandler for unified auth
    initializeDispatchService(claudeHandler);
    timing('DispatchService initialized with ClaudeHandler');

    const slackHandler = new SlackHandler(app, claudeHandler, mcpManager);
    timing('SlackHandler initialized');

    // Initialize Slack workspace URL and bot display name
    try {
      const slackApi = slackHandler.getSlackApi();
      const authContext = await slackApi.getAuthContext();
      const { setSlackWorkspaceUrl } = await import('./turn-notifier');
      setSlackWorkspaceUrl(authContext.url);
      if (authContext.botName) {
        const { setBotDisplayName } = await import('./slack/tool-formatter');
        setBotDisplayName(authContext.botName);
      }
      timing(`Slack workspace URL: ${authContext.url}, bot: ${authContext.botName ?? 'unknown'}`);
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

    // user-memory-store, user-settings-store, AND user-skill-store mutate
    // SSOT fields that feed the cached system prompt but live outside the
    // stream-executor reset points. Injecting the registry here avoids a
    // cyclic import.
    {
      const registry = claudeHandler.getSessionRegistry();
      const invalidate = (userId: string): void => {
        registry.invalidateSystemPromptForUser(userId);
      };
      userMemoryStore.setMemoryPromptInvalidationHook(invalidate);
      setSettingsPromptInvalidationHook(invalidate);
      // Personal skills are injected into every system prompt by
      // `prompt-builder.ts`, so create/update/delete/rename mutations must
      // also drop cached snapshots for the affected user. (#774)
      setSkillPromptInvalidationHook(invalidate);
    }

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

    // Connect dashboard: stop handler (abort running session). Dashboard
    // stop is an explicit user action, so tag `user-stop` to keep the
    // notification gate quiet (the dashboard itself shows the result).
    setDashboardStopHandler(async (sessionKey: string) => {
      slackHandler.getRequestCoordinator().abortSession(sessionKey, 'user-stop');
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
      // Post the user's message to the Slack thread so it's visible,
      // styled as a quote block with dashboard origin indicator.
      // Validate required fields before attempting Slack echo — fail fast on programming errors
      if (!session.channelId || !session.threadTs) {
        logger.error('Dashboard echo: missing channelId or threadTs', {
          sessionKey,
          channelId: session.channelId,
          threadTs: session.threadTs,
        });
        return;
      }

      let echoTs: string | undefined;
      try {
        const echoResult = await app.client.chat.postMessage({
          channel: session.channelId,
          thread_ts: session.threadTs,
          text: message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
          blocks: [
            {
              type: 'context',
              elements: [{ type: 'mrkdwn', text: `💬 *<@${session.ownerId}>* via Dashboard` }],
            },
            {
              type: 'section',
              text: { type: 'plain_text', text: message.length > 3000 ? `${message.slice(0, 2997)}...` : message },
            },
          ],
        });
        echoTs = echoResult.ts as string | undefined;
      } catch (err) {
        logger.warn('Dashboard: failed to echo user message to Slack', { sessionKey, error: err });
      }

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
      if (!echoTs) {
        logger.warn('Dashboard echo: using fabricated timestamp (echo failed or was skipped)', { sessionKey });
      }
      await slackHandler.handleMessage(
        {
          type: 'message',
          channel: session.channelId,
          thread_ts: session.threadTs,
          text: message,
          user: session.ownerId,
          ts: echoTs || String(Date.now() / 1000),
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

    // Connect dashboard: hero "Submit All Recommended" (group-only one-click)
    setDashboardSubmitRecommendedHandler(async (sessionKey: string) => {
      try {
        await slackHandler.handleDashboardSubmitRecommended(sessionKey);
        logger.info('Dashboard: submit-recommended completed', { sessionKey });
      } catch (error) {
        logger.error('Dashboard: submit-recommended failed', { sessionKey, error });
        throw error;
      }
    });

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
    setOnTurnRecordedCallback(broadcastConversationUpdate);

    // Dashboard v2.1 — wire session title bridge so the recorder can
    // regenerate session summaryTitle without importing session-registry
    // (which would create a cycle with conversation/recorder).
    setSessionTitleBridge({
      getSnapshot: (conversationId) => {
        const registry = claudeHandler.getSessionRegistry();
        const sessions = registry.getAllSessions();
        let found: { key: string; session: any } | null = null;
        for (const [k, s] of sessions.entries()) {
          if (s.conversationId === conversationId) {
            found = { key: k, session: s };
            break;
          }
        }
        if (!found) return null;
        const { key, session } = found;
        const userMessages: string[] = Array.isArray(session.followUpInstructions)
          ? (session.followUpInstructions as Array<{ text: string }>).map((f) => f.text)
          : [];
        if (session.initialInstruction) {
          userMessages.unshift(session.initialInstruction);
        }
        const links = {
          issueTitle: session.links?.issue?.title,
          issueLabel: session.links?.issue?.label,
          prTitle: session.links?.pr?.title,
          prLabel: session.links?.pr?.label,
          prStatus: session.links?.pr?.status,
        };
        return {
          sessionKey: key,
          userMessages,
          lastAssistantTurnId: session.lastAssistantTurnId,
          summaryTitleLastUpdatedAtMs: session.summaryTitleLastUpdatedAtMs,
          links,
        };
      },
      setLastAssistantTurnId: (conversationId, turnId) => {
        const registry = claudeHandler.getSessionRegistry();
        for (const session of registry.getAllSessions().values()) {
          if (session.conversationId === conversationId) {
            session.lastAssistantTurnId = turnId;
            break;
          }
        }
      },
      applyTitle: (sessionKey, title, turnId, _model) => {
        const registry = claudeHandler.getSessionRegistry();
        const session = registry.getSessionByKey(sessionKey);
        if (!session) return;
        session.summaryTitle = title;
        session.summaryTitleTurnId = turnId;
        session.summaryTitleLastUpdatedAtMs = Date.now();
        registry.saveSessions();
        // Scoped push — only the title changes, no need to re-send the full board.
        broadcastSummaryTitleChanged(sessionKey, title);
      },
    });

    // Connect summary generation: update session title on Slack thread header
    setOnSummaryGeneratedCallback((conversationId, _turn, summaryTitle) => {
      const registry = claudeHandler.getSessionRegistry();
      const allSessions = registry.getAllSessions();
      const session = [...allSessions.values()].find((s) => s.conversationId === conversationId);
      if (!session) {
        logger.warn('Summary generated but no active session found', {
          conversationId,
          summaryTitle,
          totalActiveSessions: allSessions.size,
        });
        return;
      }
      // Guard: only overwrite title when it hasn't been deliberately set
      // (e.g. by dispatch or issue linking). Treat conversationId-equal titles as "empty".
      if (session.title && session.title !== session.conversationId) {
        logger.debug('Skipping summary title — session already has a deliberate title', {
          conversationId,
          existingTitle: session.title,
          summaryTitle,
        });
        return;
      }
      registry.updateSessionTitle(session.channelId, session.threadTs, summaryTitle);
      slackHandler.requestThreadSurfaceRender(session);
      logger.debug('Summary title applied to session', {
        conversationId,
        summaryTitle,
        sessionKey: `${session.channelId}:${session.threadTs}`,
      });
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

    // Wire AFTER app.start() so boot-time reconnects don't count against
    // the storm threshold. exit(1) → supervisor (launchd/systemd) recycles.
    startSlackSocketWatchdog({
      client: slackReceiver.client,
      // `app.start()` above only resolves after the socket's first
      // `connected`, which this post-start wiring can't observe. Seed the
      // flag so a healthy-but-quiet socket doesn't trip stale-inbound and
      // loop-restart the process every `stalenessMs`.
      initiallyConnected: true,
      reconnectStormThreshold: 5,
      stalenessMs: 5 * 60_000,
      checkIntervalMs: 30_000,
      onUnhealthy: (reason: SocketWatchdogUnhealthyReason, detail) => {
        logger.error('Slack socket watchdog tripped — exiting for supervisor restart', {
          reason,
          detail,
        });
        process.exit(1);
      },
    });

    // Start sub-agent instances after main bot (Trace: docs/current/plans/multi-agent/trace.md, S2)
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
    // Trace: docs/archive/features/cron-scheduler/spec.md §5.4 — Scheduler lifecycle
    let cronScheduler: CronScheduler | null = null;
    try {
      const cronStorage = new CronStorage(path.join(DATA_DIR, 'cron-jobs.json'));

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

    // Goal auto-continuation loop — idle-settle driver.
    //
    // Spec (docs/goal-command/spec.md §Auto-Continuation Loop):
    //   1. user input → 2. model WORKS on the goal → 3. the work turn ENDS
    //      and the session settles to idle → 4. if a goal is active, fork a
    //      clean eval turn asking "is the goal complete? (y/n)" → 5. on
    //      "n", inject the goal back as the next turn (loop); on "y", stop.
    //
    // The driver fires from the session idle-after-drain hook, DEFERRED off
    // the turn's call stack so the just-finished turn has released its
    // request slot first. It acts ONLY when the session has genuinely
    // settled to idle with no in-flight request (`shouldRunGoalIdleDriver`),
    // so it can NEVER supersede a live work turn — the regression that made
    // a freshly-set goal spin on empty evals (PTN-4695 incident: the old
    // per-turn-end trigger injected a continuation that aborted the model
    // mid-work, yielding empty output and a tight eval loop).
    try {
      const registry = claudeHandler.getSessionRegistry();
      const requestCoordinator = slackHandler.getRequestCoordinator();
      const goalSlackApi = slackHandler.getSlackApi();
      const postGoalNotice = (channel: string, threadTs: string | undefined, text: string): Promise<unknown> =>
        goalSlackApi.postSystemMessage(channel, text, { threadTs });

      // Synthetic-turn injector for goal continuations — same surface as
      // the cron-scheduler injection path (chat.postMessage say-builder →
      // slackHandler.handleMessage).
      const goalMessageInjector = async (event: SyntheticMessageEvent): Promise<void> => {
        const say = async (args: any) => {
          const text = typeof args === 'string' ? args : args?.text;
          const result = await app.client.chat.postMessage({
            channel: event.channel,
            text: text || ' ',
            thread_ts: typeof args === 'string' ? event.thread_ts : args?.thread_ts || event.thread_ts,
            blocks: typeof args === 'string' ? undefined : args?.blocks,
            attachments: typeof args === 'string' ? undefined : args?.attachments,
          });
          return { ts: result.ts as string | undefined };
        };
        await slackHandler.handleMessage(event as any, say);
      };

      // The driver: runs at most one eval per idle settle, and on "not
      // complete" injects exactly one continuation (only while idle).
      const runGoalIdleDriver = async (sessionKey: string): Promise<void> => {
        const session = registry.getSessionByKey(sessionKey);
        const goal = session?.goal;
        if (
          !session ||
          !shouldRunGoalIdleDriver({
            goal,
            requestActive: requestCoordinator.isRequestActive(sessionKey),
            activityState: registry.getActivityStateByKey(sessionKey),
          })
        ) {
          return;
        }
        // `shouldRunGoalIdleDriver` guarantees an active, non-pending goal.
        const activeGoal = session.goal!;

        // Stamp pendingEval so a racing idle settle doesn't start a second
        // eval. Every goal-state change drops the cached system prompt
        // (spec §Prompt Injection).
        const startedAt = Date.now();
        activeGoal.pendingEval = { requestedAt: startedAt, turnId: `${startedAt}` };
        activeGoal.updatedAt = startedAt;
        session.systemPrompt = undefined;
        registry.saveSessions();

        const workSummaryRaw = (session.goalLastTurnText ?? '').trim();
        const evalUserSummary = [
          'Eval trigger: idle-settle (work turn ended)',
          '',
          '## Assistant turn output (latest work turn)',
          workSummaryRaw ? workSummaryRaw.slice(0, 16_000) : '(no assistant text was produced this turn)',
        ].join('\n');

        logger.info('Goal session settled idle — dispatching completion eval', { sessionKey });
        try {
          const verdict = await evaluateGoalCompletion(
            {
              objective: activeGoal.objective,
              workSummary: evalUserSummary,
              // Eval must NOT be weaker than the work model — pin the same
              // model+effort; fall back to the session model, never downgrade.
              model: session.model || 'claude-sonnet-4-20250514',
              effort: session.effort,
              cwd: session.workingDirectory,
            },
            ({ systemPrompt, userPrompt, model, abortController, cwd }) =>
              claudeHandler.dispatchOneShot(userPrompt, systemPrompt, model, abortController, undefined, cwd),
          );

          const outcome = decideGoalEvalOutcome(activeGoal, verdict);
          session.systemPrompt = undefined;
          registry.saveSessions();

          // "y" — the goal is done. Stop the loop.
          if (outcome.action === 'complete') {
            await postGoalNotice(
              session.channelId,
              session.threadTs,
              `✅ Goal completed (eval-model verdict).\n*Objective:* ${activeGoal.objective}\n*Eval reason:* ${verdict.reason}`,
            );
            return;
          }

          const remaining = verdict.remaining.length
            ? verdict.remaining.map((r) => `• ${r}`).join('\n')
            : '_(no remaining items reported)_';

          // Cap backstop — pause until a real user message resets the
          // counter (resetGoalContinuationOnUserMessage).
          if (outcome.action === 'cap-paused') {
            logger.info('Goal continuation cap reached', {
              sessionKey,
              continuationCount: activeGoal.continuationCount,
              maxContinuations: activeGoal.maxContinuations,
            });
            await postGoalNotice(
              session.channelId,
              session.threadTs,
              `⏹️ Goal auto-continuation paused after ${activeGoal.maxContinuations} turns.\n*Latest reason:* ${verdict.reason}\nSend a message in this thread to resume.`,
            );
            return;
          }

          // "n" under cap → continue: feed the goal back to the model.
          await postGoalNotice(
            session.channelId,
            session.threadTs,
            `🔄 Goal not yet complete (eval-model verdict).\n*Reason:* ${verdict.reason}\n*Remaining:*\n${remaining}`,
          );

          // A user turn may have started during the eval. NEVER supersede
          // it — skip injection; when that turn ends and the session
          // settles idle again, the driver re-runs and continues the loop.
          if (requestCoordinator.isRequestActive(sessionKey)) {
            logger.info('Goal continuation deferred — session became busy during eval', { sessionKey });
            return;
          }

          const now = Date.now();
          const syntheticEvent: SyntheticMessageEvent = {
            user: activeGoal.createdBy,
            channel: session.channelId,
            thread_ts: session.threadTs,
            ts: `${now / 1000}`,
            text: `${GOAL_CONTINUATION_TEXT_PREFIX} ${buildGoalContinuationPrompt(activeGoal)}`,
            synthetic: true,
            // Bypass workflow classification — this is a goal-driven turn.
            skipDispatch: true,
            routeContext: { skipAutoBotThread: true },
          };
          logger.info('Injecting goal continuation', {
            sessionKey,
            continuationCount: activeGoal.continuationCount,
            maxContinuations: activeGoal.maxContinuations,
          });
          // Fire-and-forget. Injection is the only thing that drives the
          // loop forward on 'continue'; if it throws the loop silently
          // stalls, so escalate to error + an actionable notice.
          goalMessageInjector(syntheticEvent).catch(async (err: unknown) => {
            const injectErr = err instanceof Error ? err.message : String(err);
            logger.error('Goal continuation injection failed — loop stalled', { sessionKey, error: injectErr });
            try {
              await postGoalNotice(
                session.channelId,
                session.threadTs,
                `⚠️ Goal continuation failed to start: ${injectErr}. The loop is paused — send a message in this thread to resume, or use \`goal pause\` / \`goal clear\`.`,
              );
            } catch (noticeErr: unknown) {
              logger.error('Failed to post goal continuation-failure notice', {
                sessionKey,
                error: noticeErr instanceof Error ? noticeErr.message : String(noticeErr),
              });
            }
          });
        } catch (err: unknown) {
          // Parse / network / timeout failure — status preserved; only
          // `pendingEval` resets so the loop can resume on the next settle.
          applyGoalEvalDispatchFailure(activeGoal);
          session.systemPrompt = undefined;
          registry.saveSessions();
          const message = err instanceof Error ? err.message : String(err);
          logger.error('Goal eval dispatch failed', { sessionKey, error: message });
          await postGoalNotice(
            session.channelId,
            session.threadTs,
            `⚠️ Goal completion evaluation failed: ${message}. Run \`goal done\` to force completion or \`goal pause\` / \`goal clear\` to stop the loop.`,
          );
        }
      };

      // Trigger from the turn-settled hook (TurnRunner.finish →
      // onAssistantTurnComplete), which fires AFTER the just-finished turn
      // released its request-coordinator slot. The previous wiring used the
      // idle-after-drain hook, but that fires from inside
      // `setActivityState('idle')` ~1s BEFORE `removeController` runs, so
      // `shouldRunGoalIdleDriver` always saw `requestActive === true` and
      // bailed silently — the eval never ran ("goal stopped checking"
      // regression). The driver still re-checks `isRequestActive` before
      // injecting a continuation, so it can never supersede a live turn.
      slackHandler.setGoalTurnSettledHandler((sessionKey: string) => {
        runGoalIdleDriver(sessionKey).catch((err: unknown) => {
          logger.warn('Goal driver failed', {
            sessionKey,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      });
      timing('Goal turn-settled driver installed');
    } catch (error) {
      logger.warn('Failed to install goal turn-settled driver (non-critical)', error);
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

        // Stop CCT usage refresh scheduler before TM so no pump fires mid-teardown
        if (usageRefreshScheduler) {
          usageRefreshScheduler.stop();
        }

        // Stop CCT OAuth refresh scheduler before TM for the same reason —
        // a tick firing mid-teardown could end up refreshing into a store
        // whose handles have already been released. Must come before the
        // token-manager teardown call immediately below (invariant locked
        // by `oauth-refresh-scheduler.test.ts`).
        if (oauthRefreshScheduler) {
          oauthRefreshScheduler.stop();
        }

        // Stop TokenManager lease reaper
        tokenManager.stop();

        // Notify all active sessions about shutdown
        await slackHandler.notifyShutdown();

        // Save sessions for persistence
        slackHandler.saveSessions();
        logger.info('Sessions saved successfully');

        // Save pending forms for persistence
        slackHandler.savePendingForms();
        logger.info('Pending forms saved successfully');

        // Stop A2T service
        await shutdownA2tService();

        // Stop sub-agents (Trace: docs/current/plans/multi-agent/trace.md, S7)
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
