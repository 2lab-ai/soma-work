/**
 * MCP Tool Permission Action Handler
 *
 * Handles Approve/Deny button clicks for MCP tool permission requests.
 * Only admin users can approve or deny.
 *
 * Trace: docs/mcp-tool-permission/trace.md, S4
 */

import { sharedStore, type PermissionResponse } from '../../shared-store';
import { isAdminUser } from '../../admin-utils';
import { Logger } from '../../logger';
import { RespondFn } from './types';

export class McpToolPermissionActionHandler {
  private logger = new Logger('McpToolPermissionActionHandler');

  async handleApprove(body: any, respond: RespondFn): Promise<void> {
    try {
      const value = JSON.parse(body.actions[0].value);
      const { requestId, userId, server, level, expiresAt } = value;
      const adminId = body.user?.id;

      if (!isAdminUser(adminId)) {
        await respond({
          response_type: 'ephemeral',
          text: '❌ Only admin users can approve permission requests.',
          replace_original: false,
        });
        return;
      }

      this.logger.info('MCP tool permission approved', {
        requestId,
        userId,
        server,
        level,
        expiresAt,
        approvedBy: adminId,
      });

      const response: PermissionResponse = {
        behavior: 'allow',
        message: `Approved by <@${adminId}>`,
        updatedInput: { expiresAt, grantedBy: adminId },
      };
      await sharedStore.storePermissionResponse(requestId, response);

      await respond({
        text: `✅ Permission granted: <@${userId}> → \`${server}\` (${level}) until ${expiresAt}`,
        replace_original: true,
      });
    } catch (error) {
      this.logger.error('Error processing MCP tool permission approval', error);
      await respond({
        response_type: 'ephemeral',
        text: '❌ Error processing approval. The request may have expired.',
        replace_original: false,
      });
    }
  }

  async handleDeny(body: any, respond: RespondFn): Promise<void> {
    try {
      const value = JSON.parse(body.actions[0].value);
      const { requestId, userId, server, level } = value;
      const adminId = body.user?.id;

      if (!isAdminUser(adminId)) {
        await respond({
          response_type: 'ephemeral',
          text: '❌ Only admin users can deny permission requests.',
          replace_original: false,
        });
        return;
      }

      this.logger.info('MCP tool permission denied', {
        requestId,
        userId,
        server,
        level,
        deniedBy: adminId,
      });

      const response: PermissionResponse = {
        behavior: 'deny',
        message: `Denied by <@${adminId}>`,
      };
      await sharedStore.storePermissionResponse(requestId, response);

      await respond({
        text: `❌ Permission denied: <@${userId}> → \`${server}\` (${level})`,
        replace_original: true,
      });
    } catch (error) {
      this.logger.error('Error processing MCP tool permission denial', error);
      await respond({
        response_type: 'ephemeral',
        text: '❌ Error processing denial. The request may have expired.',
        replace_original: false,
      });
    }
  }
}
