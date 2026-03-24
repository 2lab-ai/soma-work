/**
 * McpConfigBuilder - Builds MCP server configuration for Claude queries
 * Extracted from claude-handler.ts (Phase 5.3)
 */

import { Logger } from './logger';
import { McpManager } from './mcp-manager';
import { userSettingsStore } from './user-settings-store';
import { ModelCommandContext } from './model-commands/types';
import { CONFIG_FILE } from './env-paths';
import * as fs from 'fs';
import * as path from 'path';

const PERMISSION_SERVER_BASENAME = 'permission-mcp-server';
const MODEL_COMMAND_SERVER_BASENAME = 'model-command-mcp-server';
const LLM_SERVER_BASENAME = 'llm-mcp-server';
const SLACK_THREAD_SERVER_BASENAME = 'slack-thread-mcp-server';

/** Native SDK tools that require terminal interaction — disallowed in Slack context */
const NATIVE_INTERACTIVE_TOOLS = ['AskUserQuestion'];

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

/**
 * Slack context for permission prompts
 */
export interface SlackContext {
  channel: string;
  threadTs?: string;
  mentionTs?: string;
  user: string;
  channelDescription?: string;
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

  constructor(mcpManager: McpManager) {
    this.mcpManager = mcpManager;
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

    if (slackContext) {
      internalServers['model-command'] = this.buildModelCommandServer(
        slackContext,
        modelCommandContext
      );
    }

    // Add slack-thread server only for mid-thread mentions (mentionTs !== threadTs)
    // When mentionTs === threadTs, the mention IS the thread root — no prior context to explore
    if (slackContext?.mentionTs && slackContext.mentionTs !== slackContext.threadTs) {
      internalServers['slack-thread'] = this.buildSlackThreadServer(slackContext);
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

    // Disallow native interactive tools in Slack context
    // These tools expect terminal input which doesn't exist in Slack
    if (slackContext) {
      config.disallowedTools = [...NATIVE_INTERACTIVE_TOOLS];
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
   * Resolve and cache an internal MCP server path with logging.
   * Deduplicates the resolve/log/throw pattern used by all internal servers.
   */
  private resolveServerPath(
    label: string,
    basename: string,
    cache: { path: string | null; checked: boolean; triedPaths: string[] }
  ): string {
    if (!cache.checked) {
      const runtimeExt = __filename.endsWith('.ts') ? '.ts' : '.js';
      const result = resolveInternalMcpServer(__dirname, basename, runtimeExt);
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

  private permissionServerCache = { path: null as string | null, checked: false, triedPaths: [] as string[] };
  private getPermissionServerPath(): string {
    return this.resolveServerPath('Permission', PERMISSION_SERVER_BASENAME, this.permissionServerCache);
  }

  private modelCommandServerCache = { path: null as string | null, checked: false, triedPaths: [] as string[] };
  private getModelCommandServerPath(): string {
    return this.resolveServerPath('Model-command', MODEL_COMMAND_SERVER_BASENAME, this.modelCommandServerCache);
  }

  private slackThreadServerCache = { path: null as string | null, checked: false, triedPaths: [] as string[] };
  private getSlackThreadServerPath(): string {
    return this.resolveServerPath('Slack-thread', SLACK_THREAD_SERVER_BASENAME, this.slackThreadServerCache);
  }

  private llmServerCache = { path: null as string | null, checked: false, triedPaths: [] as string[] };
  private getLlmServerPath(): string {
    return this.resolveServerPath('LLM', LLM_SERVER_BASENAME, this.llmServerCache);
  }

  /**
   * Build slack-thread MCP server configuration (thread context exploration)
   */
  private buildSlackThreadServer(slackContext: SlackContext): Record<string, any> {
    const serverPath = this.getSlackThreadServerPath();
    const threadTs = slackContext.threadTs;
    if (!threadTs) {
      throw new Error('Cannot build slack-thread server without threadTs');
    }

    const threadContext = {
      channel: slackContext.channel,
      threadTs,
      mentionTs: slackContext.mentionTs ?? '',
    };

    return {
      command: 'npx',
      args: ['tsx', serverPath],
      env: {
        SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN || '',
        SLACK_THREAD_CONTEXT: JSON.stringify(threadContext),
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
   * Build the list of allowed tools
   */
  private buildAllowedTools(slackContext?: SlackContext, userBypass?: boolean): string[] {
    const allowedTools = this.mcpManager.getDefaultAllowedTools();

    // Add Skill tool for local plugins
    allowedTools.push('Skill');

    // Always allow LLM aggregate tools
    allowedTools.push('mcp__llm');

    if (slackContext) {
      allowedTools.push('mcp__model-command');
    }

    // Allow slack-thread tools only for mid-thread mentions
    if (slackContext?.mentionTs && slackContext.mentionTs !== slackContext.threadTs) {
      allowedTools.push('mcp__slack-thread');
    }

    // Always add permission prompt tool (even for bypass users, needed for dangerous commands)
    if (slackContext) {
      allowedTools.push('mcp__permission-prompt__permission_prompt');
    }

    // Auto-approve plan mode tools (no terminal interaction needed)
    allowedTools.push('EnterPlanMode');
    allowedTools.push('ExitPlanMode');

    return allowedTools;
  }
}
