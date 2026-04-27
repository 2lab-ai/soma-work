/**
 * MCP Tool Permission Action Handler
 *
 * Handles Approve/Deny button clicks for MCP tool permission requests.
 * Only admin users can approve or deny.
 *
 * Fixes applied:
 * - Issue 2: Grant written in main process (not MCP child) to avoid stale cache
 * - Issue 4: Race condition guard — check if response already exists
 * - Issue 5: Recompute expiresAt at approval time from duration, not request time
 *
 * Trace: docs/mcp-tool-permission/trace.md, S4
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { type PermissionResponse, sharedStore } from 'somalib/permission/shared-store';
import { isAdminUser } from '../../admin-utils';
import { Logger } from '../../logger';
import {
  MAX_GRANT_DURATION_MS,
  mcpToolGrantStore,
  type PermissionLevel,
  parseDuration,
} from '../../mcp-tool-grant-store';
import type { RespondFn } from './types';

/** Check if a response file already exists for this request (race condition guard) */
function hasExistingResponse(requestId: string): boolean {
  const responseFile = path.join(os.tmpdir(), 'soma-work-store', 'responses', `${requestId}.json`);
  return fs.existsSync(responseFile);
}

export class McpToolPermissionActionHandler {
  private logger = new Logger('McpToolPermissionActionHandler');

  async handleApprove(body: any, respond: RespondFn): Promise<void> {
    try {
      const value = JSON.parse(body.actions[0].value);
      const { requestId, userId, server, level, duration } = value;
      const adminId = body.user?.id;

      if (!isAdminUser(adminId)) {
        await respond({
          response_type: 'ephemeral',
          text: '❌ Only admin users can approve permission requests.',
          replace_original: false,
        });
        return;
      }

      // Race condition guard (Fix Issue 4): another admin may have already responded
      if (hasExistingResponse(requestId)) {
        await respond({
          response_type: 'ephemeral',
          text: '⚠️ This request has already been handled by another admin.',
          replace_original: false,
        });
        return;
      }

      // Recompute expiresAt at approval time (Fix Issue 5)
      const durationMs = parseDuration(duration);
      if (!durationMs) {
        this.logger.error('Invalid duration in approval payload — possible tampering', {
          requestId,
          duration,
        });
        await respond({
          response_type: 'ephemeral',
          text: `❌ Invalid duration "${duration}" in request payload. Cannot approve.`,
          replace_original: false,
        });
        return;
      }
      const effectiveDurationMs = Math.min(durationMs, MAX_GRANT_DURATION_MS);
      const expiresAt = new Date(Date.now() + effectiveDurationMs).toISOString();

      // Write grant in main process (Fix Issue 2) — no stale cache
      mcpToolGrantStore.setGrant(userId, server, level as PermissionLevel, expiresAt, adminId);

      this.logger.info('MCP tool permission approved', {
        requestId,
        userId,
        server,
        level,
        duration,
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
        text: `✅ Permission granted: <@${userId}> → \`${server}\` (${level}, ${duration}) until ${expiresAt}`,
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

      // Race condition guard (Fix Issue 4)
      if (hasExistingResponse(requestId)) {
        await respond({
          response_type: 'ephemeral',
          text: '⚠️ This request has already been handled by another admin.',
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
