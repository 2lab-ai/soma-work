import { CommandHandler, CommandContext, CommandResult, CommandDependencies } from './types';
import { CommandParser } from '../command-parser';
import { isAdminUser } from '../../admin-utils';

// Slack has a practical limit of ~4000 chars per message text block.
const MAX_OUTPUT_CHARS = 3800;
const MAX_INITIAL_PREVIEW = 1000;

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
      await this.deps.slackApi.postSystemMessage(channel,
        '💡 No active session in this thread. Start a conversation first!',
        { threadTs }
      );
      return { handled: true };
    }

    if (!session.initialInstruction && (!session.followUpInstructions || session.followUpInstructions.length === 0)) {
      await this.deps.slackApi.postSystemMessage(channel,
        '📋 *User Instructions*\n\nNo instructions captured yet. Send a message first.',
        { threadTs }
      );
      return { handled: true };
    }

    const lines: string[] = ['📋 *User Instructions (SSOT)*', ''];

    if (session.initialInstruction) {
      const preview = session.initialInstruction.length > MAX_INITIAL_PREVIEW
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
        const time = new Date(inst.timestamp).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
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
    const totalCount = (session.initialInstruction ? 1 : 0) + (session.followUpInstructions?.length || 0);
    lines.push('');
    lines.push(`_Workflow: \`${workflow}\` | Total instructions: ${totalCount}_`);

    await this.deps.slackApi.postSystemMessage(channel, lines.join('\n'), { threadTs });

    return { handled: true };
  }
}
