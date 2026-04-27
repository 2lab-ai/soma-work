#!/usr/bin/env node

/**
 * MCP Tool Permission Server — Request, check, and revoke MCP tool access grants.
 *
 * Provides three tools:
 * - request_permission: Request time-limited access to a permission-gated MCP server
 * - check_permission: Check current grant status
 * - revoke_permission: Admin-only, revoke a user's grant
 *
 * Trace: docs/mcp-tool-permission/trace.md, S4/S7/S8
 */

import { WebClient } from '@slack/web-api';
import { BaseMcpServer } from '../_shared/base-mcp-server.js';
import type { ToolDefinition, ToolResult } from '../_shared/base-mcp-server.js';
import { sharedStore, type PendingApproval, type PermissionResponse } from 'somalib/permission/shared-store.js';
import { McpToolGrantStore, parseDuration, MAX_GRANT_DURATION_MS, type PermissionLevel } from '../../src/mcp-tool-grant-store.js';
import { loadMcpToolPermissions, type McpToolPermissionConfig } from '../../src/mcp-tool-permission-config.js';
import { isAdminUser, getAdminUsers } from '../../src/admin-utils.js';

interface SlackContext {
  channel: string;
  threadTs?: string;
  user: string;
}

class McpToolPermissionMCPServer extends BaseMcpServer {
  private slack: WebClient;
  private slackContext: SlackContext;
  private grantStore: McpToolGrantStore;
  private permConfig: McpToolPermissionConfig;

  constructor() {
    super('mcp-tool-permission');
    this.slack = new WebClient(process.env.SLACK_BOT_TOKEN);
    this.slackContext = JSON.parse(process.env.SLACK_CONTEXT || '{}');
    this.grantStore = new McpToolGrantStore();
    const configFile = process.env.SOMA_CONFIG_FILE || '';
    this.permConfig = loadMcpToolPermissions(configFile);
  }

  defineTools(): ToolDefinition[] {
    return [
      {
        name: 'request_permission',
        description:
          'Request time-limited access to a permission-gated MCP server. ' +
          'An admin must approve the request via Slack. ' +
          'Duration format: "24h" (hours), "7d" (days), "4w" (weeks).',
        inputSchema: {
          type: 'object',
          properties: {
            server: {
              type: 'string',
              description: 'MCP server name (e.g., "server-tools")',
            },
            level: {
              type: 'string',
              enum: ['read', 'write'],
              description: 'Permission level to request',
            },
            duration: {
              type: 'string',
              description: 'Duration of access (e.g., "24h", "7d", "4w")',
            },
          },
          required: ['server', 'level', 'duration'],
        },
      },
      {
        name: 'check_permission',
        description:
          'Check current permission grants for the requesting user. ' +
          'Optionally filter by server name.',
        inputSchema: {
          type: 'object',
          properties: {
            server: {
              type: 'string',
              description: 'Optional: filter to a specific MCP server',
            },
          },
          required: [],
        },
      },
      {
        name: 'revoke_permission',
        description:
          'Admin-only: Revoke a user\'s permission grant.',
        inputSchema: {
          type: 'object',
          properties: {
            user: {
              type: 'string',
              description: 'Slack user ID whose grant to revoke',
            },
            server: {
              type: 'string',
              description: 'MCP server name',
            },
            level: {
              type: 'string',
              enum: ['read', 'write', 'all'],
              description: 'Permission level to revoke (default: "all")',
            },
          },
          required: ['user', 'server'],
        },
      },
    ];
  }

  async handleTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    switch (name) {
      case 'request_permission':
        return await this.handleRequestPermission(args);
      case 'check_permission':
        return await this.handleCheckPermission(args);
      case 'revoke_permission':
        return await this.handleRevokePermission(args);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  private async handleRequestPermission(args: Record<string, unknown>): Promise<ToolResult> {
    const server = args.server as string;
    const level = args.level as PermissionLevel;
    const duration = args.duration as string;
    const userId = this.slackContext.user;

    // Validate: admin doesn't need to request
    if (isAdminUser(userId)) {
      return this.textResult(JSON.stringify({
        status: 'unnecessary',
        message: 'Admin users have all permissions. No request needed.',
      }));
    }

    // Validate: server must have permission config
    if (!this.permConfig[server]) {
      throw new Error(`Unknown or unrestricted MCP server: ${server}. No permission config found.`);
    }

    // Validate: level
    if (level !== 'read' && level !== 'write') {
      throw new Error('Invalid level. Must be "read" or "write".');
    }

    // Validate: duration
    const durationMs = parseDuration(duration);
    if (durationMs === null) {
      throw new Error('Invalid duration format. Use format: 24h, 7d, 4w');
    }

    // Cap at max duration (4 weeks)
    if (durationMs > MAX_GRANT_DURATION_MS) {
      throw new Error(`Duration exceeds maximum (4 weeks). Use 4w or less.`);
    }

    const estimatedExpiry = new Date(Date.now() + durationMs).toISOString();
    const requestId = `grant_req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Send approval request to admins
    const adminUsers = getAdminUsers();
    const approvalText =
      `🔐 *MCP Tool Permission Request*\n` +
      `• *User*: <@${userId}>\n` +
      `• *Server*: \`${server}\`\n` +
      `• *Level*: \`${level}\`\n` +
      `• *Duration*: ${duration}\n` +
      `• *Est. Expiry*: ${estimatedExpiry}`;

    // Button payload carries `duration` (not precomputed expiresAt) so the action handler
    // recomputes expiresAt at approval time. Prevents timing drift and payload tampering.
    // (Fix Issue 5)
    const blocks = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: approvalText },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '✅ Approve' },
            style: 'primary',
            action_id: `mcp_tool_perm_approve_${requestId}`,
            value: JSON.stringify({ requestId, userId, server, level, duration }),
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '❌ Deny' },
            style: 'danger',
            action_id: `mcp_tool_perm_deny_${requestId}`,
            value: JSON.stringify({ requestId, userId, server, level }),
          },
        ],
      },
    ];

    // Store pending request
    const pending: PendingApproval = {
      tool_name: 'request_permission',
      input: { server, level, duration, estimatedExpiry },
      channel: this.slackContext.channel,
      thread_ts: this.slackContext.threadTs,
      user: userId,
      created_at: Date.now(),
      expires_at: Date.now() + 5 * 60 * 1000,
    };
    await sharedStore.storePendingApproval(requestId, pending);

    // DM each admin — track delivery count to fail fast if none reached
    let deliveredCount = 0;
    for (const adminId of adminUsers) {
      try {
        await this.slack.chat.postMessage({
          channel: adminId,
          text: `Permission request from <@${userId}> for ${server} (${level})`,
          blocks,
        });
        deliveredCount++;
      } catch (error) {
        this.logger.warn('Failed to DM admin for permission request', { adminId, error });
      }
    }

    if (deliveredCount === 0) {
      throw new Error(
        'Could not deliver permission request to any admin. ' +
        'Please contact an admin directly or check the Slack bot configuration.'
      );
    }

    // Also post in thread if available
    if (this.slackContext.channel && this.slackContext.threadTs) {
      try {
        await this.slack.chat.postMessage({
          channel: this.slackContext.channel,
          thread_ts: this.slackContext.threadTs,
          text: `⏳ Permission request sent to admins: \`${server}\` (${level}, ${duration})`,
        });
      } catch (error) {
        this.logger.debug('Failed to post thread notification for permission request', { error });
      }
    }

    // Wait for admin response
    const response = await sharedStore.waitForPermissionResponse(requestId, 5 * 60 * 1000);

    if (response.behavior === 'allow') {
      // Parse the grant info from updatedInput if available
      const grantInfo = response.updatedInput || { expiresAt: estimatedExpiry, grantedBy: 'admin' };
      this.grantStore.setGrant(userId, server, level, grantInfo.expiresAt || estimatedExpiry, grantInfo.grantedBy || 'admin');

      return this.textResult(JSON.stringify({
        status: 'approved',
        server,
        level,
        expiresAt: grantInfo.expiresAt || estimatedExpiry,
        grantedBy: grantInfo.grantedBy || 'admin',
      }));
    }

    return this.textResult(JSON.stringify({
      status: 'denied',
      message: response.message || 'Permission request denied by admin',
    }));
  }

  private async handleCheckPermission(args: Record<string, unknown>): Promise<ToolResult> {
    const server = args.server as string | undefined;
    const userId = this.slackContext.user;

    const allGrants = this.grantStore.getGrants(userId);
    const now = Date.now();

    // Build status for each grant
    const grantsStatus: Record<string, any> = {};
    if (allGrants) {
      for (const [serverName, serverGrants] of Object.entries(allGrants)) {
        if (server && serverName !== server) continue;

        const status: Record<string, any> = {};
        for (const [lvl, grant] of Object.entries(serverGrants)) {
          if (!grant) continue;
          status[lvl] = {
            status: new Date(grant.expiresAt).getTime() > now ? 'active' : 'expired',
            expiresAt: grant.expiresAt,
            grantedBy: grant.grantedBy,
            grantedAt: grant.grantedAt,
          };
        }
        if (Object.keys(status).length > 0) {
          grantsStatus[serverName] = status;
        }
      }
    }

    return this.textResult(JSON.stringify({
      userId,
      isAdmin: isAdminUser(userId),
      grants: grantsStatus,
      toolPermissions: server ? { [server]: this.permConfig[server] } : this.permConfig,
    }));
  }

  private async handleRevokePermission(args: Record<string, unknown>): Promise<ToolResult> {
    const targetUser = args.user as string;
    const server = args.server as string;
    const level = (args.level as string) || 'all';
    const callerId = this.slackContext.user;

    // Only admins can revoke
    if (!isAdminUser(callerId)) {
      throw new Error('Only admin users can revoke permissions.');
    }

    this.grantStore.revokeGrant(targetUser, server, level as PermissionLevel | 'all');

    return this.textResult(JSON.stringify({
      status: 'revoked',
      user: targetUser,
      server,
      level,
    }));
  }

  private textResult(text: string): ToolResult {
    return { content: [{ type: 'text', text }] };
  }
}

const serverInstance = new McpToolPermissionMCPServer();
serverInstance.run().catch((error) => {
  console.error('Failed to start MCP Tool Permission Server', error);
  process.exit(1);
});
