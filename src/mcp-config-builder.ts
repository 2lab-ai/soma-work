/**
 * McpConfigBuilder - Builds MCP server configuration for Claude queries
 * Extracted from claude-handler.ts (Phase 5.3)
 */

import { Logger } from './logger';
import { McpManager } from './mcp-manager';
import { userSettingsStore } from './user-settings-store';
import { ModelCommandContext } from './model-commands/types';
import { CONFIG_FILE } from './env-paths';
import { normalizeTmpPath, isSafePathSegment } from './path-utils';
import { isAdminUser } from './admin-utils';
import { loadMcpToolPermissions, getRequiredLevel, levelSatisfies, getPermissionGatedServers, type McpToolPermissionConfig, type PermissionLevel } from './mcp-tool-permission-config';
import { mcpToolGrantStore } from './mcp-tool-grant-store';
import * as fs from 'fs';
import * as path from 'path';

const PERMISSION_SERVER_BASENAME = 'permission-mcp-server';
const MODEL_COMMAND_SERVER_BASENAME = 'model-command-mcp-server';
const LLM_SERVER_BASENAME = 'llm-mcp-server';
const SLACK_MCP_SERVER_BASENAME = 'slack-mcp-server';
const SERVER_TOOLS_BASENAME = 'server-tools-mcp-server';
const CRON_SERVER_BASENAME = 'cron-mcp-server';
const MCP_TOOL_PERMISSION_SERVER_BASENAME = 'mcp-tool-permission-mcp-server';
const AGENT_SERVER_BASENAME = 'agent-mcp-server';

/** Root of the project (one level up from src/) */
const PROJECT_ROOT = path.resolve(__dirname, '..');
/** Directory containing extracted MCP servers */
const MCP_SERVERS_DIR = path.join(PROJECT_ROOT, 'mcp-servers');

/** Native SDK tools that require terminal interaction — disallowed in Slack context */
const NATIVE_INTERACTIVE_TOOLS = ['AskUserQuestion'];

/**
 * Native SDK cron tools — disallowed to prevent conflict with soma's managed CronScheduler.
 * Trace: docs/cron-scheduler/trace.md, Scenario 1
 */
const NATIVE_CRON_TOOLS = ['CronCreate', 'CronDelete', 'CronList'];

export interface PermissionServerPathResult {
  resolvedPath: string | null;
  fallbackUsed: boolean;
  triedPaths: string[];
}

export function resolveInternalMcpServer(
  baseDir: string,
  basename: string,
  runtimeExt: '.ts' | '.js',
  existsSync: (path: string) => boolean = fs.existsSync
): PermissionServerPathResult {
  const basePath = path.join(baseDir, basename);
  const preferredPath = `${basePath}${runtimeExt}`;
  const fallbackExt = runtimeExt === '.ts' ? '.js' : '.ts';
  const fallbackPath = `${basePath}${fallbackExt}`;
  const triedPaths = [preferredPath, fallbackPath];

  if (existsSync(preferredPath)) {
    return { resolvedPath: preferredPath, fallbackUsed: false, triedPaths };
  }

  if (existsSync(fallbackPath)) {
    return { resolvedPath: fallbackPath, fallbackUsed: true, triedPaths };
  }

  return { resolvedPath: null, fallbackUsed: false, triedPaths };
}

export function resolvePermissionServerPath(
  baseDir: string,
  runtimeExt: '.ts' | '.js',
  existsSync: (path: string) => boolean = fs.existsSync
): PermissionServerPathResult {
  return resolveInternalMcpServer(baseDir, PERMISSION_SERVER_BASENAME, runtimeExt, existsSync);
}

export function resolveModelCommandServerPath(
  baseDir: string,
  runtimeExt: '.ts' | '.js',
  existsSync: (path: string) => boolean = fs.existsSync
): PermissionServerPathResult {
  return resolveInternalMcpServer(baseDir, MODEL_COMMAND_SERVER_BASENAME, runtimeExt, existsSync);
}

/** True when the bot was mentioned inside an existing thread (not at the root). */
export function isMidThreadMention(ctx?: { mentionTs?: string; threadTs?: string } | null): boolean {
  return !!ctx?.mentionTs && ctx.mentionTs !== ctx.threadTs;
}

/**
 * Slack context for permission prompts
 */
export interface SlackContext {
  channel: string;
  threadTs?: string;
  mentionTs?: string;
  /** Original thread where the mention occurred (before bot-initiated thread migration) */
  sourceThreadTs?: string;
  /** Original channel where the mention occurred (before channel routing) */
  sourceChannel?: string;
  user: string;
  channelDescription?: string;
  /** Structured repo names parsed from channel description (e.g., ["2lab-ai/soma-work"]) */
  repos?: string[];
  /** Confluence wiki URL from channel description */
  confluenceUrl?: string;
}

/**
 * MCP configuration result
 */
export interface McpConfig {
  mcpServers?: Record<string, any>;
  allowedTools?: string[];
  /** Tools to completely remove from the model's context (e.g. native interactive tools in Slack) */
  disallowedTools?: string[];
  permissionPromptToolName?: string;
  permissionMode: 'default' | 'bypassPermissions';
  allowDangerouslySkipPermissions?: boolean;
  /** Whether the user has bypass enabled (used by PermissionRequest hook for auto-approve) */
  userBypass: boolean;
}

/**
 * McpConfigBuilder assembles MCP server configuration
 * - Adds permission prompt server when needed
 * - Manages allowed tools list
 * - Handles bypass permission logic
 */
export class McpConfigBuilder {
  private logger = new Logger('McpConfigBuilder');
  private mcpManager: McpManager;
  /** Agent configs for agent MCP server (Trace: docs/multi-agent/trace.md, S4) */
  private agentConfigs?: Record<string, any>;

  constructor(mcpManager: McpManager) {
    this.mcpManager = mcpManager;
  }

  /**
   * Set agent configurations (called from index.ts after loading config).
   * Trace: docs/multi-agent/trace.md, Scenario 4
   */
  setAgentConfigs(configs: Record<string, any>): void {
    this.agentConfigs = configs;
  }

  /**
   * Build MCP configuration for a query
   */
  async buildConfig(
    slackContext?: SlackContext,
    modelCommandContext?: ModelCommandContext
  ): Promise<McpConfig> {
    // Check if user has bypass permission enabled
    const userBypass = slackContext?.user
      ? userSettingsStore.getUserBypassPermission(slackContext.user)
      : false;

    // Without Slack context or bypass ON: bypass permissions
    // Bypass ON still gets permission-prompt server for dangerous command interception via PreToolUse hook
    const config: McpConfig = !slackContext || userBypass
      ? { permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true, userBypass }
      : { permissionMode: 'default', userBypass };

    // Get base MCP server configuration
    const mcpServers = await this.mcpManager.getServerConfiguration();
    const internalServers: Record<string, any> = {};

    // Always add LLM aggregate server (wraps codex + gemini)
    internalServers['llm'] = this.buildLlmServer();

    // Add agent MCP server when agents are configured (Trace: docs/multi-agent/trace.md, S4)
    if (this.agentConfigs && Object.keys(this.agentConfigs).length > 0) {
      internalServers['agent'] = this.buildAgentServer();
    }

    if (slackContext) {
      internalServers['model-command'] = this.buildModelCommandServer(
        slackContext,
        modelCommandContext
      );
    }

    // Add slack-mcp server only for mid-thread mentions (mentionTs !== threadTs)
    // When mentionTs === threadTs, the mention IS the thread root — no prior context to explore
    if (isMidThreadMention(slackContext)) {
      internalServers['slack-mcp'] = this.buildSlackMcpServer(slackContext!);
    }

    // Add cron MCP server for cron CRUD (Trace: docs/cron-scheduler/trace.md, S2-S3)
    if (slackContext) {
      internalServers['cron'] = this.buildCronServer(slackContext);
    }

    // Conditionally add server-tools when config.json has server-tools section
    if (this.hasServerToolsConfig()) {
      internalServers['server-tools'] = this.buildServerToolsServer();
    }

    // Add mcp-tool-permission server for permission request/check/revoke
    // Trace: docs/mcp-tool-permission/trace.md, S4/S7/S8
    if (slackContext) {
      internalServers['mcp-tool-permission'] = this.buildMcpToolPermissionServer(slackContext);
    }

    // Always add permission prompt server when in Slack context
    // Even bypass users need the MCP server for dangerous command approval via Slack UI
    if (slackContext) {
      internalServers['permission-prompt'] = this.buildPermissionServer(slackContext)['permission-prompt'];
      config.permissionPromptToolName = 'mcp__permission-prompt__permission_prompt';

      this.logger.debug('Configured permission prompts for Slack integration', {
        channel: slackContext.channel,
        user: slackContext.user,
        hasThread: !!slackContext.threadTs,
        userBypass,
      });
    }

    const hasBaseServers = !!mcpServers && Object.keys(mcpServers).length > 0;
    const hasInternalServers = Object.keys(internalServers).length > 0;

    if (hasBaseServers || hasInternalServers) {
      config.mcpServers = {
        ...(mcpServers || {}),
        ...internalServers,
      };
    }

    // Restrict filesystem MCP to user's /tmp/{slackId} directory
    if (slackContext?.user && config.mcpServers?.filesystem) {
      const userId = slackContext.user;
      // Defense-in-depth: validate userId has no path traversal characters
      if (!isSafePathSegment(userId)) {
        this.logger.warn('slackContext.user contains path traversal characters, skipping filesystem restriction', { userId });
      } else {
        const userTmpDir = normalizeTmpPath(path.join('/tmp', userId));
        const fsConfig = config.mcpServers.filesystem as { args?: string[] };
        if (Array.isArray(fsConfig.args)) {
          // Replace ALL /tmp-prefixed args (MCP filesystem accepts multiple dirs)
          let replaced = false;
          for (let i = 0; i < fsConfig.args.length; i++) {
            if (fsConfig.args[i].startsWith('/tmp') || fsConfig.args[i].startsWith('/private/tmp')) {
              fsConfig.args[i] = userTmpDir;
              replaced = true;
            }
          }
          if (!replaced) {
            fsConfig.args.push(userTmpDir);
          }
          this.logger.debug('Filesystem MCP restricted to user directory', {
            user: userId,
            userTmpDir,
          });
        }
      }
    }

    // Build allowed tools list
    if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
      config.allowedTools = this.buildAllowedTools(slackContext, userBypass);

      this.logger.debug('Added MCP configuration', {
        serverCount: Object.keys(config.mcpServers).length,
        servers: Object.keys(config.mcpServers),
        allowedTools: config.allowedTools,
        hasSlackContext: !!slackContext,
        userBypass,
        permissionMode: config.permissionMode,
      });
    }

    // Disallow native interactive tools and SDK cron tools in Slack context
    // Interactive tools expect terminal input; cron tools conflict with soma's CronScheduler
    // Trace: docs/cron-scheduler/trace.md, Scenario 1
    if (slackContext) {
      config.disallowedTools = [...NATIVE_INTERACTIVE_TOOLS, ...NATIVE_CRON_TOOLS];
    }

    if (slackContext && userBypass) {
      this.logger.debug('Bypass ON — dangerous Bash commands intercepted via PreToolUse hook', {
        user: slackContext.user,
      });
    }

    return config;
  }

  /**
   * Build the permission prompt MCP server configuration
   */
  private buildPermissionServer(slackContext: SlackContext): Record<string, any> {
    const permissionServerPath = this.getPermissionServerPath();
    return {
      'permission-prompt': {
        command: 'npx',
        args: ['tsx', permissionServerPath],
        env: {
          SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
          SLACK_CONTEXT: JSON.stringify(slackContext),
        },
      },
    };
  }

  /**
   * Build model-command MCP server configuration
   */
  private buildModelCommandServer(
    slackContext: SlackContext,
    modelCommandContext?: ModelCommandContext
  ): Record<string, any> {
    const modelCommandServerPath = this.getModelCommandServerPath();
    const context: ModelCommandContext = modelCommandContext || {
      channel: slackContext.channel,
      threadTs: slackContext.threadTs,
      user: slackContext.user,
    };

    return {
      command: 'npx',
      args: ['tsx', modelCommandServerPath],
      env: {
        SOMA_COMMAND_CONTEXT: JSON.stringify(context),
      },
    };
  }

  /**
   * Build cron MCP server configuration.
   * Trace: docs/cron-scheduler/trace.md, Scenarios 2-3
   */
  private buildCronServer(slackContext: SlackContext): Record<string, any> {
    const cronServerPath = this.getCronServerPath();
    const context = {
      user: slackContext.user,
      channel: slackContext.channel,
      threadTs: slackContext.threadTs,
    };

    return {
      command: 'npx',
      args: ['tsx', cronServerPath],
      env: {
        SOMA_CRON_CONTEXT: JSON.stringify(context),
      },
    };
  }

  /**
   * Resolve and cache an internal MCP server path with logging.
   * Deduplicates the resolve/log/throw pattern used by all internal servers.
   */
  private resolveServerPath(
    label: string,
    basename: string,
    serverDir: string,
    cache: { path: string | null; checked: boolean; triedPaths: string[] }
  ): string {
    if (!cache.checked) {
      const runtimeExt = __filename.endsWith('.ts') ? '.ts' : '.js';
      const result = resolveInternalMcpServer(serverDir, basename, runtimeExt);
      cache.checked = true;
      cache.path = result.resolvedPath;
      cache.triedPaths = result.triedPaths;

      if (!result.resolvedPath) {
        this.logger.error(`${label} MCP server file not found`, {
          tried: result.triedPaths,
          runtimeExt,
        });
      } else if (result.fallbackUsed) {
        this.logger.warn(`${label} MCP server path fallback used`, {
          resolvedPath: result.resolvedPath,
          tried: result.triedPaths,
          runtimeExt,
        });
      }
    }

    if (!cache.path) {
      throw new Error(`${label} MCP server file not found. Tried: ${cache.triedPaths.join(', ')}`);
    }

    return cache.path;
  }

  /** Registry of server path caches — replaces 5 individual cache fields */
  private serverPathRegistry = new Map<string, { path: string | null; checked: boolean; triedPaths: string[] }>();

  /**
   * Resolve an internal MCP server path with caching.
   * Single entry point for all server path lookups.
   */
  private getServerPath(label: string, basename: string, subdir: string): string {
    if (!this.serverPathRegistry.has(basename)) {
      this.serverPathRegistry.set(basename, { path: null, checked: false, triedPaths: [] });
    }
    return this.resolveServerPath(label, basename, path.join(MCP_SERVERS_DIR, subdir), this.serverPathRegistry.get(basename)!);
  }

  private getPermissionServerPath(): string {
    return this.getServerPath('Permission', PERMISSION_SERVER_BASENAME, 'permission');
  }

  private getModelCommandServerPath(): string {
    return this.getServerPath('Model-command', MODEL_COMMAND_SERVER_BASENAME, 'model-command');
  }

  private getSlackMcpServerPath(): string {
    return this.getServerPath('Slack-mcp', SLACK_MCP_SERVER_BASENAME, 'slack-mcp');
  }

  private getLlmServerPath(): string {
    return this.getServerPath('LLM', LLM_SERVER_BASENAME, 'llm');
  }

  private getServerToolsServerPath(): string {
    return this.getServerPath('Server-tools', SERVER_TOOLS_BASENAME, 'server-tools');
  }

  private getCronServerPath(): string {
    return this.getServerPath('Cron', CRON_SERVER_BASENAME, 'cron');
  }

  /**
   * Build slack-mcp server configuration (thread context + file upload)
   */
  private buildSlackMcpServer(slackContext: SlackContext): Record<string, any> {
    const serverPath = this.getSlackMcpServerPath();
    // Use source thread (original thread before migration) if available,
    // otherwise fall back to current threadTs.
    // This is critical: after bot-initiated thread migration, threadTs points to
    // the NEW (empty) thread, but we need to read from the ORIGINAL thread.
    const threadTs = slackContext.sourceThreadTs || slackContext.threadTs;
    const channel = slackContext.sourceChannel || slackContext.channel;
    if (!threadTs) {
      throw new Error('Cannot build slack-mcp server without threadTs');
    }

    const threadContext = {
      channel,
      threadTs,
      mentionTs: slackContext.mentionTs ?? '',
    };

    return {
      command: 'npx',
      args: ['tsx', serverPath],
      env: {
        SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN || '',
        SLACK_MCP_CONTEXT: JSON.stringify(threadContext),
      },
    };
  }

  private buildLlmServer(): Record<string, any> {
    const llmServerPath = this.getLlmServerPath();
    return {
      command: 'npx',
      args: ['tsx', llmServerPath],
      env: {
        SOMA_CONFIG_FILE: CONFIG_FILE,
      },
    };
  }

  /**
   * Build agent MCP server configuration.
   * Passes agent configs via env so the MCP server can validate agent names.
   * Trace: docs/multi-agent/trace.md, Scenario 4
   */
  private buildAgentServer(): Record<string, any> {
    const agentServerPath = this.getAgentServerPath();
    // Strip sensitive tokens — only pass metadata needed for MCP tool validation
    const safeConfigs: Record<string, any> = {};
    if (this.agentConfigs) {
      for (const [name, config] of Object.entries(this.agentConfigs)) {
        safeConfigs[name] = {
          promptDir: config.promptDir,
          persona: config.persona,
          description: config.description,
          model: config.model,
        };
      }
    }
    return {
      command: 'npx',
      args: ['tsx', agentServerPath],
      env: {
        SOMA_AGENT_CONFIGS: JSON.stringify(safeConfigs),
      },
    };
  }

  private getAgentServerPath(): string {
    return this.getServerPath('Agent', AGENT_SERVER_BASENAME, 'agent');
  }

  /**
   * Build the list of allowed tools.
   * Filters permission-gated MCP servers based on user's active grants.
   * Admin users bypass all permission checks.
   * Trace: docs/mcp-tool-permission/trace.md, S2/S3/S5
   */
  private buildAllowedTools(slackContext?: SlackContext, userBypass?: boolean): string[] {
    const allowedTools = this.mcpManager.getDefaultAllowedTools();

    // Add Skill tool for local plugins
    allowedTools.push('Skill');

    // Always allow LLM aggregate tools
    allowedTools.push('mcp__llm');

    // Allow agent tools when agents are configured
    if (this.agentConfigs && Object.keys(this.agentConfigs).length > 0) {
      allowedTools.push('mcp__agent');
    }

    if (slackContext) {
      allowedTools.push('mcp__model-command');
    }

    // Allow slack-mcp tools only for mid-thread mentions
    if (isMidThreadMention(slackContext)) {
      allowedTools.push('mcp__slack-mcp');
    }

    // Always add permission prompt tool (even for bypass users, needed for dangerous commands)
    if (slackContext) {
      allowedTools.push('mcp__permission-prompt__permission_prompt');
    }

    // Allow cron MCP tools in Slack context
    if (slackContext) {
      allowedTools.push('mcp__cron');
    }

    // Allow mcp-tool-permission tools (always available in Slack context for requesting permissions)
    if (slackContext) {
      allowedTools.push('mcp__mcp-tool-permission');
    }

    // Generic per-tool permission gating for ALL MCP servers with a `permission` key in config.json.
    // Iterates every gated server (not just server-tools) and applies the same logic:
    //   admin → blanket allow | non-admin with grant → per-tool filter | no grant → blocked
    // Trace: docs/mcp-tool-permission/trace.md, S2/S3/S5
    this.applyPermissionGating(allowedTools, slackContext);

    // Auto-approve plan mode tools (no terminal interaction needed)
    allowedTools.push('EnterPlanMode');
    allowedTools.push('ExitPlanMode');

    return allowedTools;
  }

  /**
   * Apply per-tool permission gating for ALL MCP servers that have a `permission` key in config.json.
   * For each gated server:
   *  - Admin or no user context → blanket allow (mcp__{serverName})
   *  - Non-admin with matching grant → per-tool filtering based on level
   *  - Non-admin without grant → server entirely blocked
   */
  private applyPermissionGating(allowedTools: string[], slackContext?: SlackContext): void {
    const toolPermConfig = this.loadToolPermissions();
    const gatedServers = getPermissionGatedServers(toolPermConfig);

    if (gatedServers.length === 0) {
      // No gated servers — allow server-tools blanket if config exists (backward compat)
      if (this.hasServerToolsConfig()) {
        allowedTools.push('mcp__server-tools');
      }
      return;
    }

    const userId = slackContext?.user;

    // Reload grants once before iterating servers (not per-server)
    if (userId && !isAdminUser(userId)) {
      mcpToolGrantStore.reload();
    }

    for (const serverName of gatedServers) {
      const serverPerms = toolPermConfig[serverName];
      const mcpPrefix = `mcp__${serverName}`;

      // Ensure this server's MCP config actually exists in the build
      // (server-tools has its own hasServerToolsConfig check; other servers checked via raw config)
      if (serverName === 'server-tools' && !this.hasServerToolsConfig()) continue;

      if (!userId || isAdminUser(userId)) {
        // Admin or no user context → full access
        allowedTools.push(mcpPrefix);
        continue;
      }

      // Non-admin: check grants
      const hasWriteGrant = mcpToolGrantStore.hasActiveGrant(userId, serverName, 'write');
      const hasReadGrant = mcpToolGrantStore.hasActiveGrant(userId, serverName, 'read');
      const userLevel: PermissionLevel | null = hasWriteGrant ? 'write' : hasReadGrant ? 'read' : null;

      if (!userLevel) {
        this.logger.debug('Permission-gated server blocked — no active grant', {
          user: userId,
          server: serverName,
        });
        continue;
      }

      // Per-tool filtering: allow tools whose required level is satisfied by user's grant
      const allowedForServer: string[] = [];
      for (const [toolName, requiredLevel] of Object.entries(serverPerms)) {
        if (levelSatisfies(userLevel, requiredLevel)) {
          const fullToolName = `${mcpPrefix}__${toolName}`;
          allowedTools.push(fullToolName);
          allowedForServer.push(fullToolName);
        }
      }

      this.logger.debug('Permission-gated server per-tool filtering applied', {
        user: userId,
        server: serverName,
        userLevel,
        allowed: allowedForServer,
      });
    }
  }

  /**
   * Load tool permission config from config.json (cached per build).
   */
  private toolPermConfigCache: McpToolPermissionConfig | null = null;
  private loadToolPermissions(): McpToolPermissionConfig {
    if (!this.toolPermConfigCache) {
      this.toolPermConfigCache = CONFIG_FILE ? loadMcpToolPermissions(CONFIG_FILE) : {};
    }
    return this.toolPermConfigCache;
  }

  /**
   * Check if config.json has a server-tools section with at least one server.
   * The "permission" key is reserved for tool-level permission config — not counted as a server.
   * Uses cached raw config to avoid redundant file reads (Fix Issue 6).
   */
  private rawConfigCache: Record<string, any> | null | undefined = undefined;
  private getRawConfig(): Record<string, any> | null {
    if (this.rawConfigCache === undefined) {
      if (!CONFIG_FILE) { this.rawConfigCache = null; return null; }
      try {
        this.rawConfigCache = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      } catch {
        this.rawConfigCache = null;
      }
    }
    return this.rawConfigCache ?? null;
  }

  private hasServerToolsConfig(): boolean {
    const raw = this.getRawConfig();
    if (!raw) return false;
    const serverTools = raw['server-tools'];
    if (!serverTools || typeof serverTools !== 'object') return false;
    const serverKeys = Object.keys(serverTools).filter(k => k !== 'permission');
    return serverKeys.length > 0;
  }

  /**
   * Build server-tools MCP server configuration
   */
  private buildServerToolsServer(): Record<string, any> {
    const serverPath = this.getServerToolsServerPath();
    return {
      command: 'npx',
      args: ['tsx', serverPath],
      env: {
        SOMA_CONFIG_FILE: CONFIG_FILE,
      },
    };
  }

  private getMcpToolPermissionServerPath(): string {
    return this.getServerPath('Mcp-tool-permission', MCP_TOOL_PERMISSION_SERVER_BASENAME, 'mcp-tool-permission');
  }

  /**
   * Build mcp-tool-permission MCP server configuration.
   * Provides tools for requesting, checking, and revoking MCP tool permissions.
   * Trace: docs/mcp-tool-permission/trace.md, S4/S7/S8
   */
  private buildMcpToolPermissionServer(slackContext: SlackContext): Record<string, any> {
    const serverPath = this.getMcpToolPermissionServerPath();
    return {
      command: 'npx',
      args: ['tsx', serverPath],
      env: {
        SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN || '',
        SLACK_CONTEXT: JSON.stringify(slackContext),
        SOMA_CONFIG_FILE: CONFIG_FILE,
      },
    };
  }
}
