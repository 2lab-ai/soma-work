import { getAvailablePersonas } from '../../claude-handler';
import { userSettingsStore } from '../../user-settings-store';
import { CommandParser } from '../command-parser';
import type { CommandContext, CommandHandler, CommandResult } from './types';

/**
 * Handles persona commands (status/list/set)
 */
export class PersonaHandler implements CommandHandler {
  canHandle(text: string): boolean {
    return CommandParser.isPersonaCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { user, text, threadTs, say } = ctx;
    const personaAction = CommandParser.parsePersonaCommand(text);

    if (personaAction.action === 'status') {
      const currentPersona = userSettingsStore.getUserPersona(user);
      const availablePersonas = getAvailablePersonas();
      await say({
        text: `🎭 *Persona Status*\n\nYour current persona: \`${currentPersona}\`\n\nAvailable personas: ${availablePersonas.map((p) => `\`${p}\``).join(', ')}\n\n_Use \`persona set <name>\` to change your persona._`,
        thread_ts: threadTs,
      });
    } else if (personaAction.action === 'list') {
      const availablePersonas = getAvailablePersonas();
      const currentPersona = userSettingsStore.getUserPersona(user);
      const personaList = availablePersonas
        .map((p) => (p === currentPersona ? `• \`${p}\` _(current)_` : `• \`${p}\``))
        .join('\n');
      await say({
        text: `🎭 *Available Personas*\n\n${personaList}\n\n_Use \`persona set <name>\` to change your persona._`,
        thread_ts: threadTs,
      });
    } else if (personaAction.action === 'set' && personaAction.persona) {
      const availablePersonas = getAvailablePersonas();
      if (availablePersonas.includes(personaAction.persona)) {
        userSettingsStore.setUserPersona(user, personaAction.persona);
        await say({
          text: `✅ *Persona Changed*\n\nYour persona is now set to: \`${personaAction.persona}\``,
          thread_ts: threadTs,
        });
      } else {
        await say({
          text: `❌ *Unknown Persona*\n\nPersona \`${personaAction.persona}\` not found.\n\nAvailable personas: ${availablePersonas.map((p) => `\`${p}\``).join(', ')}`,
          thread_ts: threadTs,
        });
      }
    }

    return { handled: true };
  }
}
