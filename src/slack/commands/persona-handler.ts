import { getAvailablePersonas } from '../../claude-handler';
import { userSettingsStore } from '../../user-settings-store';
import { CommandParser } from '../command-parser';
import { applyPersona, renderPersonaCard } from '../z/topics/persona-topic';
import type { CommandContext, CommandHandler, CommandResult } from './types';

/**
 * Handles persona commands (status/list/set).
 *
 * Phase 2 (#507):
 *   - bare `persona` → Block Kit setting card (via /z topic builder)
 *   - `persona list` → text listing (back-compat)
 *   - `persona set <n>` → apply + text ack (back-compat)
 */
export class PersonaHandler implements CommandHandler {
  canHandle(text: string): boolean {
    return CommandParser.isPersonaCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { user, text, threadTs, say } = ctx;
    const personaAction = CommandParser.parsePersonaCommand(text);

    if (personaAction.action === 'status') {
      // Phase 2: render Block Kit card by default.
      const { text: fallback, blocks } = await renderPersonaCard({
        userId: user,
        issuedAt: Date.now(),
      });
      await say({ text: fallback ?? '🎭 Persona', blocks, thread_ts: threadTs });
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
      const result = await applyPersona({ userId: user, value: personaAction.persona });
      if (result.ok) {
        await say({
          text: `✅ *Persona Changed*\n\n${result.summary}\n\n${result.description ?? ''}`,
          thread_ts: threadTs,
        });
      } else {
        await say({
          text: `❌ *Unknown Persona*\n\n${result.summary}\n\n${result.description ?? ''}`,
          thread_ts: threadTs,
        });
      }
    }

    return { handled: true };
  }
}
