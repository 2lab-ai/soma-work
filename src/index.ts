import './env-paths';
import { App } from '@slack/bolt';
import { config, validateConfig, runPreflightChecks } from './config';
import { ClaudeHandler } from './claude-handler';
import { SlackHandler } from './slack-handler';
import { McpManager } from './mcp-manager';
import { PluginManager } from './plugin/plugin-manager';
import { loadUnifiedConfig } from './unified-config-loader';
import { CONFIG_FILE, MCP_CONFIG_FILE, PLUGINS_DIR } from './env-paths';
import { Logger } from './logger';
import { discoverInstallations, isGitHubAppConfigured, getGitHubAppAuth } from './github-auth.js';
import { initializeDispatchService } from './dispatch-service';
import { initRecorder, startWebServer, stopWebServer } from './conversation';
import { notifyRelease, getVersionInfo, formatTimestamp } from './release-notifier';
import { scanChannels } from './channel-registry';

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

    // Initialize handlers
    const claudeHandler = new ClaudeHandler(mcpManager);
    // Inject plugin paths if PluginManager resolved any plugins
    const pluginPaths = pluginManager.getPluginPaths();
    if (pluginPaths.length > 0) {
      claudeHandler.setPluginPaths(pluginPaths);
    }
    timing('ClaudeHandler initialized');

    // Initialize dispatch service with ClaudeHandler for unified auth
    initializeDispatchService(claudeHandler);
    timing('DispatchService initialized with ClaudeHandler');

    const slackHandler = new SlackHandler(app, claudeHandler, mcpManager);
    timing('SlackHandler initialized');

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

    // Start conversation viewer web server
    try {
      await startWebServer();
      timing('Conversation viewer web server started');
    } catch (error) {
      logger.warn('Failed to start conversation viewer (non-critical)', error);
    }

    // Start the app
    await app.start();
    timing('Slack socket connected');
    const versionInfoForLog = getVersionInfo();
    const versionTag = versionInfoForLog ? `v${versionInfoForLog.version} (${versionInfoForLog.commitHash?.slice(0, 7) || 'dev'})` : 'dev';
    logger.info(`⚡️ Claude Code Slack bot is running! [${versionTag}]`);

    // Scan channels the bot is a member of (non-blocking)
    scanChannels(app.client).then(count => {
      timing(`Channel scan complete (${count} channels)`);
    }).catch(error => {
      logger.warn('Channel scan failed (non-critical)', error);
    });

    // Send release notification to configured channel
    try {
      await notifyRelease(app.client);
      timing('Release notification sent');
    } catch (error) {
      logger.warn('Failed to send release notification (non-critical)', error);
    }

    // Send startup notification to channel
    const STARTUP_CHANNEL_ID = 'C0A25HMBC49';
    try {
      const versionInfo = getVersionInfo();
      const mcpNames = mcpConfig ? Object.keys(mcpConfig.mcpServers) : [];
      const blocks: any[] = [];

      if (versionInfo) {
        const isUpgrade = versionInfo.previousVersion !== '0.0.0' &&
          versionInfo.version !== versionInfo.previousVersion;
        const isRollback = versionInfo.isRollback === true;
        const headerText = isRollback
          ? `⏪ v${versionInfo.version} Rollback (${versionInfo.previousVersion} → ${versionInfo.rollbackTargetVersion || 'previous'})`
          : isUpgrade
            ? `🚀 v${versionInfo.version} Started (${versionInfo.previousVersion} → ${versionInfo.version})`
            : `🚀 v${versionInfo.version} Started`;
        blocks.push(
          {
            type: 'header',
            text: {
              type: 'plain_text',
              text: headerText,
              emoji: true,
            },
          },
          {
            type: 'section',
            fields: [
              { type: 'mrkdwn', text: `*Version*\n\`${versionInfo.tag}\`` },
              { type: 'mrkdwn', text: `*Branch*\n\`${versionInfo.branch}\`` },
              { type: 'mrkdwn', text: `*Commit*\n\`${versionInfo.commitHashShort}\`` },
              { type: 'mrkdwn', text: `*Started*\n${formatTimestamp(new Date().toISOString())}` },
            ],
          },
        );
      } else {
        blocks.push({
          type: 'header',
          text: { type: 'plain_text', text: '🚀 soma-work Started (dev)', emoji: true },
        });
      }

      // Operational status
      blocks.push({
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*MCP*\n${mcpNames.length > 0 ? mcpNames.map(n => `\`${n}\``).join(', ') : '_none_'}` },
          { type: 'mrkdwn', text: `*Sessions*\n${loadedSessions} restored` },
        ],
      });

      // Changelog
      if (versionInfo?.releaseNotes) {
        const isVersionChange = versionInfo.previousVersion !== '0.0.0' &&
          versionInfo.version !== versionInfo.previousVersion;
        const rollback = versionInfo.isRollback === true;
        const changelogLabel = rollback ? '*⏪ 롤백*' : '*📋 변경 사항*';
        const tagTransition = rollback
          ? ` _(${versionInfo.previousTag} → ${versionInfo.rollbackTargetTag || 'previous'})_`
          : isVersionChange
            ? ` _(${versionInfo.previousTag} → ${versionInfo.tag})_`
            : '';
        blocks.push(
          { type: 'divider' },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `${changelogLabel}${tagTransition}\n\n${versionInfo.releaseNotes}`,
            },
          },
        );
      }

      // Footer
      const footerParts: string[] = [];
      if (versionInfo) {
        footerParts.push(`commit: \`${versionInfo.commitHash.substring(0, 12)}\``);
        footerParts.push(`built: ${formatTimestamp(versionInfo.buildTime)}`);
      }
      footerParts.push('_Reply to test events_');
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: footerParts.join(' | ') }],
      });

      await app.client.chat.postMessage({
        channel: STARTUP_CHANNEL_ID,
        text: versionInfo ? `Bot Started - v${versionInfo.version} (${versionInfo.branch})` : 'Bot Started',
        blocks,
        unfurl_links: false,
        unfurl_media: false,
      });
      logger.info('Startup notification sent', { channel: STARTUP_CHANNEL_ID });
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
        // Notify all active sessions about shutdown
        await slackHandler.notifyShutdown();

        // Save sessions for persistence
        slackHandler.saveSessions();
        logger.info('Sessions saved successfully');

        // Save pending forms for persistence
        slackHandler.savePendingForms();
        logger.info('Pending forms saved successfully');
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

      process.exit(0);
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    // Crash safety net: save sessions before unclean exit
    // SDK can throw uncaught exceptions (e.g., write to aborted process)
    process.on('uncaughtException', (error) => {
      logger.error('Uncaught exception — saving sessions before exit', error);
      try {
        slackHandler.saveSessions();
        slackHandler.savePendingForms();
      } catch (saveError) {
        logger.error('Failed to save sessions during crash', saveError);
      }
      process.exit(1);
    });

    process.on('unhandledRejection', (reason) => {
      logger.error('Unhandled rejection — saving sessions before exit', reason);
      try {
        slackHandler.saveSessions();
        slackHandler.savePendingForms();
      } catch (saveError) {
        logger.error('Failed to save sessions during crash', saveError);
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
