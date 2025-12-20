/**
 * McpConfigBuilder - Builds MCP server configuration for Claude queries
 * Extracted from claude-handler.ts (Phase 5.3)
 */

import { Logger } from './logger';
import { McpManager } from './mcp-manager';
import { userSettingsStore } from './user-settings-store';
import * as path from 'path';

/**
 * Slack context for permission prompts
 */
export interface SlackContext {
  channel: string;
  threadTs?: string;
  user: string;
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
    return {
      'permission-prompt': {
        command: 'npx',
        args: ['tsx', path.join(__dirname, 'permission-mcp-server.ts')],
        env: {
          SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
          SLACK_CONTEXT: JSON.stringify(slackContext),
        },
      },
    };
  }

  /**
   * Build the list of allowed tools
   */
  private buildAllowedTools(slackContext?: SlackContext, userBypass?: boolean): string[] {
    const allowedTools = this.mcpManager.getDefaultAllowedTools();

    // Add permission prompt tool if not bypassed
    if (slackContext && !userBypass) {
      allowedTools.push('mcp__permission-prompt__permission_prompt');
    }

    return allowedTools;
  }
}
