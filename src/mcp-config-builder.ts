/**
 * McpConfigBuilder - Builds MCP server configuration for Claude queries
 * Extracted from claude-handler.ts (Phase 5.3)
 */

import { Logger } from './logger';
import { McpManager } from './mcp-manager';
import { userSettingsStore } from './user-settings-store';
import * as fs from 'fs';
import * as path from 'path';

const PERMISSION_SERVER_BASENAME = 'permission-mcp-server';

export interface PermissionServerPathResult {
  resolvedPath: string | null;
  fallbackUsed: boolean;
  triedPaths: string[];
}

export function resolvePermissionServerPath(
  baseDir: string,
  runtimeExt: '.ts' | '.js',
  existsSync: (path: string) => boolean = fs.existsSync
): PermissionServerPathResult {
  const basePath = path.join(baseDir, PERMISSION_SERVER_BASENAME);
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

/**
 * Slack context for permission prompts
 */
export interface SlackContext {
  channel: string;
  threadTs?: string;
  user: string;
  channelDescription?: string;
}

/**
 * MCP configuration result
 */
export interface McpConfig {
  mcpServers?: Record<string, any>;
  allowedTools?: string[];
  permissionPromptToolName?: string;
  permissionMode: 'default' | 'bypassPermissions';
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
  private permissionServerPath: string | null = null;
  private permissionServerPathChecked = false;

  constructor(mcpManager: McpManager) {
    this.mcpManager = mcpManager;
  }

  /**
   * Build MCP configuration for a query
   */
  async buildConfig(slackContext?: SlackContext): Promise<McpConfig> {
    // Check if user has bypass permission enabled
    const userBypass = slackContext?.user
      ? userSettingsStore.getUserBypassPermission(slackContext.user)
      : false;

    const config: McpConfig = {
      permissionMode: !slackContext || userBypass ? 'bypassPermissions' : 'default',
    };

    // Get base MCP server configuration
    const mcpServers = await this.mcpManager.getServerConfiguration();

    // Add permission prompt server if needed
    if (slackContext && !userBypass) {
      const permissionServer = this.buildPermissionServer(slackContext);

      if (mcpServers) {
        config.mcpServers = { ...mcpServers, ...permissionServer };
      } else {
        config.mcpServers = permissionServer;
      }

      config.permissionPromptToolName = 'mcp__permission-prompt__permission_prompt';

      this.logger.debug('Configured permission prompts for Slack integration', {
        channel: slackContext.channel,
        user: slackContext.user,
        hasThread: !!slackContext.threadTs,
      });
    } else if (mcpServers && Object.keys(mcpServers).length > 0) {
      config.mcpServers = mcpServers;
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

    if (slackContext && userBypass) {
      this.logger.debug('Bypassing permission prompts for user', {
        user: slackContext.user,
        bypassEnabled: true,
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

  private getPermissionServerPath(): string {
    if (!this.permissionServerPathChecked) {
      const runtimeExt = __filename.endsWith('.ts') ? '.ts' : '.js';
      const result = resolvePermissionServerPath(__dirname, runtimeExt);
      this.permissionServerPathChecked = true;

      if (!result.resolvedPath) {
        this.logger.error('Permission MCP server file not found', {
          tried: result.triedPaths,
          runtimeExt,
        });
      } else if (result.fallbackUsed) {
        this.logger.warn('Permission MCP server path fallback used', {
          resolvedPath: result.resolvedPath,
          tried: result.triedPaths,
          runtimeExt,
        });
      }

      this.permissionServerPath = result.resolvedPath;
    }

    if (!this.permissionServerPath) {
      throw new Error(`Permission MCP server file not found. Tried: ${this.getPermissionServerTriedPaths().join(', ')}`);
    }

    return this.permissionServerPath;
  }

  private getPermissionServerTriedPaths(): string[] {
    const runtimeExt = __filename.endsWith('.ts') ? '.ts' : '.js';
    return resolvePermissionServerPath(__dirname, runtimeExt).triedPaths;
  }

  /**
   * Build the list of allowed tools
   */
  private buildAllowedTools(slackContext?: SlackContext, userBypass?: boolean): string[] {
    const allowedTools = this.mcpManager.getDefaultAllowedTools();

    // Add Skill tool for local plugins
    allowedTools.push('Skill');

    // Add permission prompt tool if not bypassed
    if (slackContext && !userBypass) {
      allowedTools.push('mcp__permission-prompt__permission_prompt');
    }

    return allowedTools;
  }
}
