/**
 * AgentHandler - Slack command handler for multi-agent management.
 *
 * Commands:
 *   agent               - Show registered agents and status
 *   agent list           - List all registered agents
 *   agent health         - Run health checks
 *   agent ask <id> <msg> - Send a task to a specific sub-agent
 */

import { CommandHandler, CommandContext, CommandResult } from './types';
import { CommandParser } from '../command-parser';
import { AgentRegistry } from '../../agent/registry';
import { WorkingDirectoryManager } from '../../working-directory-manager';
import { isAdminUser } from '../../admin-utils';
import { Logger } from '../../logger';
import { randomUUID } from 'crypto';

const logger = new Logger('AgentHandler');

const STATUS_EMOJI: Record<string, string> = {
  healthy: '🟢',
  degraded: '🟡',
};

export class AgentHandler implements CommandHandler {
  private registry: AgentRegistry;
  private workingDirManager?: WorkingDirectoryManager;

  constructor(registry: AgentRegistry, workingDirManager?: WorkingDirectoryManager) {
    this.registry = registry;
    this.workingDirManager = workingDirManager;
  }

  canHandle(text: string): boolean {
    return CommandParser.isAgentCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { text, user, threadTs, say } = ctx;
    const action = CommandParser.parseAgentCommand(text);
    const reply = (message: string) => say({ text: message, thread_ts: threadTs });

    try {
      switch (action.action) {
        case 'list':
        case 'status': {
          const display = this.registry.formatForDisplay();
          await reply(`🤖 *Agent Registry*\n\n${display}`);
          break;
        }

        case 'health': {
          await reply('🔍 Running health checks...');
          const results = await this.registry.checkAllHealth();

          if (results.length === 0) {
            await reply('_No sub-agents registered._');
            break;
          }

          const lines = results.map(r => {
            const emoji = STATUS_EMOJI[r.status] ?? '🔴';
            const latency = r.latencyMs ? `${r.latencyMs}ms` : 'n/a';
            const error = r.error ? ` — ${r.error}` : '';
            return `${emoji} *${r.agentId}*: ${r.status} (${latency})${error}`;
          });

          await reply(`🏥 *Agent Health*\n\n${lines.join('\n')}`);
          break;
        }

        case 'ask': {
          // P0: Admin-only — sub-agents can execute arbitrary code
          if (!isAdminUser(user)) {
            await reply('❌ `agent ask` is restricted to admin users.');
            break;
          }

          const { agentId, prompt } = action;
          const agent = this.registry.get(agentId);
          if (!agent) {
            const available = this.registry.getAll().map(a => a.id).join(', ') || 'none';
            await reply(`❌ Agent \`${agentId}\` not found.\nAvailable agents: ${available}`);
            break;
          }

          const client = this.registry.getClient(agentId);
          if (!client) {
            await reply(`❌ No client available for agent \`${agentId}\`.`);
            break;
          }

          await reply(`⏳ Sending task to \`${agentId}\`...`);

          const requestId = randomUUID();
          const cwd = this.workingDirManager?.getWorkingDirectory(ctx.channel, ctx.threadTs, ctx.user);
          const task = { type: 'llm_chat' as const, prompt, ...(cwd && { cwd }) };
          const result = await client.execute(requestId, task, {
            channel: ctx.channel,
            threadTs: ctx.threadTs,
            userId: ctx.user,
          });

          if (result.ok) {
            const content = result.content || '(no content)';
            const meta = [
              result.model ? `Model: ${result.model}` : null,
              result.durationMs ? `Duration: ${result.durationMs}ms` : null,
              result.sessionId ? `Session: \`${result.sessionId.slice(0, 8)}...\`` : null,
            ].filter(Boolean).join(' | ');

            await reply(`🤖 *${agentId}* response:\n\n${content}\n\n_${meta}_`);
          } else {
            const errMsg = result.error?.message || 'Unknown error';
            await reply(`❌ Agent \`${agentId}\` error: ${errMsg}`);
          }
          break;
        }

        case 'error': {
          await reply(`❌ ${action.message}`);
          break;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('AgentHandler.execute failed', { error: message, user, action: action.action });
      try {
        await reply(`❌ Agent command failed: ${message}`);
      } catch (replyError) {
        logger.error('Failed to send error reply to Slack', { error: String(replyError) });
      }
    }

    return { handled: true };
  }
}
