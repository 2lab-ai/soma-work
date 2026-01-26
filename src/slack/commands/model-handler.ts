import { CommandHandler, CommandContext, CommandResult } from './types';
import { CommandParser } from '../command-parser';
import { userSettingsStore, AVAILABLE_MODELS, MODEL_ALIASES } from '../../user-settings-store';

/**
 * Handles model commands (status/list/set)
 */
export class ModelHandler implements CommandHandler {
  canHandle(text: string): boolean {
    return CommandParser.isModelCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { user, text, threadTs, say } = ctx;
    const modelAction = CommandParser.parseModelCommand(text);

    if (modelAction.action === 'status') {
      const currentModel = userSettingsStore.getUserDefaultModel(user);
      const displayName = userSettingsStore.getModelDisplayName(currentModel);
      const aliasesText = Object.entries(MODEL_ALIASES)
        .map(([alias, model]) => `\`${alias}\` → ${userSettingsStore.getModelDisplayName(model)}`)
        .join('\n');

      await say({
        text: `🤖 *Model Status*\n\nYour default model: *${displayName}*\n\`${currentModel}\`\n\n*Available aliases:*\n${aliasesText}\n\n_Use \`model set <name>\` to change your default model._`,
        thread_ts: threadTs,
      });
    } else if (modelAction.action === 'list') {
      const currentModel = userSettingsStore.getUserDefaultModel(user);
      const modelList = AVAILABLE_MODELS
        .map(m => {
          const displayName = userSettingsStore.getModelDisplayName(m);
          return m === currentModel ? `• *${displayName}* _(current)_\n  \`${m}\`` : `• ${displayName}\n  \`${m}\``;
        })
        .join('\n');

      await say({
        text: `🤖 *Available Models*\n\n${modelList}\n\n_Use \`model set <name>\` to change your default model._`,
        thread_ts: threadTs,
      });
    } else if (modelAction.action === 'set' && modelAction.model) {
      const resolvedModel = userSettingsStore.resolveModelInput(modelAction.model);
      if (resolvedModel) {
        userSettingsStore.setUserDefaultModel(user, resolvedModel);
        const displayName = userSettingsStore.getModelDisplayName(resolvedModel);
        await say({
          text: `✅ *Model Changed*\n\nYour default model is now: *${displayName}*\n\`${resolvedModel}\`\n\n_New sessions will use this model._`,
          thread_ts: threadTs,
        });
      } else {
        const aliasesText = Object.keys(MODEL_ALIASES).map(a => `\`${a}\``).join(', ');
        await say({
          text: `❌ *Unknown Model*\n\nModel \`${modelAction.model}\` not found.\n\n*Available aliases:* ${aliasesText}\n\n_Use \`model list\` to see all available models._`,
          thread_ts: threadTs,
        });
      }
    }

    return { handled: true };
  }
}
