import { isAdminUser } from '../../admin-utils';
import type { SessionInstruction, SessionInstructionStatus } from '../../types';
import { CommandParser } from '../command-parser';
import type { CommandContext, CommandDependencies, CommandHandler, CommandResult } from './types';

// Slack has a practical limit of ~4000 chars per message text block.
const MAX_OUTPUT_CHARS = 3800;
const MAX_INITIAL_PREVIEW = 1000;
// Sealed status set (#754): active | completed | cancelled.
const STATUS_ICON: Record<SessionInstructionStatus, string> = {
  active: '🟢',
  completed: '✅',
  cancelled: '🚫',
};

export class InstructionsHandler implements CommandHandler {
  constructor(private deps: CommandDependencies) {}

  canHandle(text: string): boolean {
    return CommandParser.isShowInstructionsCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { user, channel, threadTs } = ctx;

    if (!isAdminUser(user)) {
      await this.deps.slackApi.postSystemMessage(channel, '⛔ Admin only command', { threadTs });
      return { handled: true };
    }

    const session = this.deps.claudeHandler.getSession(channel, threadTs);

    if (!session) {
      await this.deps.slackApi.postSystemMessage(
        channel,
        '💡 No active session in this thread. Start a conversation first!',
        { threadTs },
      );
      return { handled: true };
    }

    const ssotInstructions = session.instructions || [];
    const hasLegacy = !!session.initialInstruction || (session.followUpInstructions?.length ?? 0) > 0;
    if (!hasLegacy && ssotInstructions.length === 0) {
      await this.deps.slackApi.postSystemMessage(
        channel,
        '📋 *User Instructions*\n\nNo instructions captured yet. Send a message first.',
        { threadTs },
      );
      return { handled: true };
    }

    const lines: string[] = ['📋 *User Instructions (SSOT)*', ''];

    if (ssotInstructions.length > 0) {
      const grouped: Record<SessionInstructionStatus, SessionInstruction[]> = {
        active: [],
        completed: [],
        cancelled: [],
      };
      for (const i of ssotInstructions) grouped[i.status ?? 'active'].push(i);
      for (const status of ['active', 'cancelled', 'completed'] as SessionInstructionStatus[]) {
        const entries = grouped[status];
        if (entries.length === 0) continue;
        lines.push(`*${STATUS_ICON[status]} ${status} (${entries.length})*`);
        for (const i of entries) {
          const text = i.text.length > 200 ? `${i.text.slice(0, 200)}…` : i.text;
          const bullet = `• \`${i.id}\` — ${text}`;
          // Sealed shape (#727 P1-5): no `evidence` on the instruction row.
          // The dashboard / drilldown surface reads completion evidence
          // from the matching `lifecycleEvents` `op:'complete'` payload.
          const completedAt = i.completedAt ? ` _(completed ${i.completedAt})_` : '';
          lines.push(`${bullet}${completedAt}`);
        }
        lines.push('');
      }
    }

    if (session.initialInstruction) {
      const preview =
        session.initialInstruction.length > MAX_INITIAL_PREVIEW
          ? session.initialInstruction.slice(0, MAX_INITIAL_PREVIEW) + '... (truncated)'
          : session.initialInstruction;
      lines.push('*Initial Instruction:*');
      lines.push('```');
      lines.push(preview);
      lines.push('```');
    }

    if (session.followUpInstructions && session.followUpInstructions.length > 0) {
      lines.push('');
      lines.push(`*Follow-up Instructions (${session.followUpInstructions.length}):*`);
      let charBudget = MAX_OUTPUT_CHARS - lines.join('\n').length - 200; // reserve for footer
      for (let i = 0; i < session.followUpInstructions.length; i++) {
        const inst = session.followUpInstructions[i];
        const time = new Date(inst.timestamp)
          .toISOString()
          .replace('T', ' ')
          .replace(/\.\d+Z$/, 'Z');
        const preview = inst.text.length > 200 ? inst.text.slice(0, 200) + '...' : inst.text;
        const line = `${i + 1}. [${time}] _${inst.speaker}_: ${preview}`;
        charBudget -= line.length + 1;
        if (charBudget <= 0) {
          lines.push(`... and ${session.followUpInstructions.length - i} more (truncated for Slack limit)`);
          break;
        }
        lines.push(line);
      }
    }

    const workflow = session.workflow || 'default';
    const legacyCount = (session.initialInstruction ? 1 : 0) + (session.followUpInstructions?.length || 0);
    lines.push('');
    lines.push(`_Workflow: \`${workflow}\` | SSOT: ${ssotInstructions.length} | Legacy turn-log: ${legacyCount}_`);

    await this.deps.slackApi.postSystemMessage(channel, lines.join('\n'), { threadTs });

    return { handled: true };
  }
}
