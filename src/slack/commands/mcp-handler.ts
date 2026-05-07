import { CommandParser } from '../command-parser';
import type { CommandContext, CommandDependencies, CommandHandler, CommandResult } from './types';

/**
 * Handles MCP server commands (mcp info/reload)
 */
export class McpHandler implements CommandHandler {
  constructor(private deps: CommandDependencies) {}

  canHandle(text: string): boolean {
    return CommandParser.isMcpInfoCommand(text) || CommandParser.isMcpReloadCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { text, threadTs, say } = ctx;

    // MCP info command
    if (CommandParser.isMcpInfoCommand(text)) {
      const mcpInfo = await this.deps.mcpManager.formatMcpInfo();
      await say({
        text: mcpInfo,
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    // MCP reload command
    if (CommandParser.isMcpReloadCommand(text)) {
      const reloaded = this.deps.mcpManager.reloadConfiguration();
      if (reloaded) {
        const mcpInfo = await this.deps.mcpManager.formatMcpInfo();
        await say({
          text: `✅ MCP configuration reloaded successfully.\n\n${mcpInfo}`,
          thread_ts: threadTs,
        });
      } else {
        await say({
          text: `❌ Failed to reload MCP configuration. Check the \`mcpServers\` section in config.json.`,
          thread_ts: threadTs,
        });
      }
      return { handled: true };
    }

    return { handled: false };
  }
}
