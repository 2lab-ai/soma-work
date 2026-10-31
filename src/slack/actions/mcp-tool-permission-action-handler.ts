/**
 * MCP Tool Permission Action Handler
 *
 * Approve / Deny clicks on the admins' DM prompts for an MCP tool access
 * request. The decision itself is {@link decideMcpGrant} — the same one the
 * dashboard's admin approvals take (#621): only an admin, at most once across
 * processes (atomic claim), the grant's server / level / duration read from the
 * stored request (never from the button payload), every admin's DM copy
 * rewritten with the outcome.
 *
 * Trace: docs/current/plans/mcp-tool-permission/trace.md, S4
 */

import { Logger } from '../../logger';
import { type DecideMcpGrantArgs, decideMcpGrant, type McpGrantDecision } from '../mcp-grant-decision';
import type { RespondFn } from './types';

export class McpToolPermissionActionHandler {
  private logger = new Logger('McpToolPermissionActionHandler');

  constructor(private readonly deps: { updateDm?: DecideMcpGrantArgs['updateDm'] } = {}) {}

  async handleApprove(body: any, respond: RespondFn): Promise<void> {
    await this.handle(body, respond, 'approve');
  }

  async handleDeny(body: any, respond: RespondFn): Promise<void> {
    await this.handle(body, respond, 'deny');
  }

  private async handle(body: any, respond: RespondFn, decision: McpGrantDecision): Promise<void> {
    try {
      const { requestId } = JSON.parse(body.actions[0].value) as { requestId?: string };
      const result = await decideMcpGrant({
        requestId: String(requestId ?? ''),
        decision,
        actor: body.user?.id,
        via: 'slack',
        updateDm: this.deps.updateDm,
      });
      if (!result.ok) {
        await respond({ response_type: 'ephemeral', text: result.message, replace_original: false });
        return;
      }
      // Every copy is rewritten through updateDm; the clicked one also here (older requests stored no copies).
      await respond({ text: result.text, replace_original: true });
    } catch (error) {
      this.logger.error('Error processing an MCP tool permission answer', error);
      await respond({
        response_type: 'ephemeral',
        text: `❌ Error processing the ${decision === 'approve' ? 'approval' : 'denial'}. The request may have expired.`,
        replace_original: false,
      });
    }
  }
}
