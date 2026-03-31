import type { PluginManager } from '../../plugin/plugin-manager';
import type { MarketplaceEntry } from '../../plugin/types';
import { CommandParser, type MarketplaceAction } from '../command-parser';
import type { CommandContext, CommandDependencies, CommandHandler, CommandResult } from './types';

/**
 * Handles marketplace management commands (list/add/remove).
 *
 * Delegates to PluginManager via McpManager.getPluginManager().
 */
export class MarketplaceHandler implements CommandHandler {
  constructor(private deps: CommandDependencies) {}

  canHandle(text: string): boolean {
    return CommandParser.isMarketplaceCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { text, threadTs, say } = ctx;

    const pluginManager = this.deps.mcpManager.getPluginManager();
    if (!pluginManager) {
      await say({
        text: 'Plugin system not initialized. Check your config.json plugin section.',
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    const action: MarketplaceAction = CommandParser.parseMarketplaceCommand(text);

    switch (action.action) {
      case 'list':
        return this.handleList(ctx, pluginManager);
      case 'add':
        return this.handleAdd(ctx, pluginManager, action);
      case 'remove':
        return this.handleRemove(ctx, pluginManager, action);
      default:
        return { handled: false };
    }
  }

  private async handleList(ctx: CommandContext, pluginManager: PluginManager): Promise<CommandResult> {
    const { threadTs, say } = ctx;
    const marketplaces = pluginManager.getMarketplaces();

    if (marketplaces.length === 0) {
      await say({
        text: 'No marketplaces configured. Use `marketplace add owner/repo` to add one.',
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    const lines = marketplaces.map(
      (m: MarketplaceEntry) => `\u2022 *${m.name}* \u2014 \`${m.repo}\` (ref: \`${m.ref || 'main'}\`)`,
    );

    await say({
      text: `\uD83D\uDCE6 *Registered Marketplaces*\n\n${lines.join('\n')}`,
      thread_ts: threadTs,
    });
    return { handled: true };
  }

  private async handleAdd(
    ctx: CommandContext,
    pluginManager: PluginManager,
    action: Extract<MarketplaceAction, { action: 'add' }>,
  ): Promise<CommandResult> {
    const { threadTs, say } = ctx;
    const { repo, name: customName, ref } = action;

    const derivedName = customName || repo.split('/').pop() || repo;
    const entry: MarketplaceEntry = {
      name: derivedName,
      repo,
      ref: ref || 'main',
    };

    const result = pluginManager.addMarketplace(entry);

    if (!result.success) {
      await say({
        text: `Failed to add marketplace: ${result.error}`,
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    await say({
      text: `Marketplace *${derivedName}* added (\`${repo}\`, ref: \`${entry.ref}\`). Refreshing plugins...`,
      thread_ts: threadTs,
    });

    await pluginManager.refresh();
    return { handled: true };
  }

  private async handleRemove(
    ctx: CommandContext,
    pluginManager: PluginManager,
    action: Extract<MarketplaceAction, { action: 'remove' }>,
  ): Promise<CommandResult> {
    const { threadTs, say } = ctx;
    const { name } = action;

    const result = pluginManager.removeMarketplace(name);

    if (!result.success) {
      await say({
        text: `Failed to remove marketplace: ${result.error}`,
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    await say({
      text: `Marketplace *${name}* removed.`,
      thread_ts: threadTs,
    });
    return { handled: true };
  }
}
