/**
 * `/z persona` Block Kit topic — Phase 2 (#507).
 *
 * Single source of truth for:
 *   - renderPersonaCard()        → default `/z persona` Block Kit card
 *   - applyPersona()             → apply a value (used by action handler)
 *   - createPersonaTopicBinding  → ZTopicBinding registered with the action router
 */

import { getAvailablePersonas } from '../../../prompt-builder';
import { userSettingsStore } from '../../../user-settings-store';
import type { ApplyResult, RenderResult, ZTopicBinding } from '../../actions/z-settings-actions';
import { buildSettingCard } from '../ui-builder';

/** Short one-liner taglines for the built-in personas. Unknown personas render without description. */
const PERSONA_TAGLINES: Record<string, string> = {
  zhuge: '제갈 량 — 신중·조언·전략',
  linus: 'Linus — 직설·성능·정확',
  ada: 'Ada Lovelace — 수학·분석적',
  turing: 'Alan Turing — 논리·기계적',
  yoda: 'Yoda — 통찰·수수께끼',
  feynman: 'Feynman — 호기심·설명',
};

function personaTagline(id: string): string | undefined {
  return PERSONA_TAGLINES[id.toLowerCase()];
}

export async function renderPersonaCard(args: { userId: string; issuedAt: number }): Promise<RenderResult> {
  const { userId, issuedAt } = args;
  const personas = getAvailablePersonas();
  const current = userSettingsStore.getUserPersona(userId);
  const blocks = buildSettingCard({
    topic: 'persona',
    icon: '🎭',
    title: 'Persona',
    currentLabel: current,
    currentDescription: personaTagline(current),
    options: personas.map((id) => ({
      id,
      label: id,
      description: personaTagline(id),
    })),
    additionalCommands: ['`/z persona list` — 텍스트 목록', '`/z persona set <name>` — 직접 지정'],
    issuedAt,
  });
  return {
    text: `🎭 Persona (current: ${current})`,
    blocks,
  };
}

export async function applyPersona(args: { userId: string; value: string }): Promise<ApplyResult> {
  const { userId, value } = args;
  const available = getAvailablePersonas();
  if (!available.includes(value)) {
    return {
      ok: false,
      summary: `❌ Unknown persona: \`${value}\``,
      description: `Available: ${available.map((p) => `\`${p}\``).join(', ')}`,
    };
  }
  userSettingsStore.setUserPersona(userId, value);
  return {
    ok: true,
    summary: `🎭 Persona → \`${value}\``,
    description: personaTagline(value) ?? '_Applied to future sessions._',
  };
}

export function createPersonaTopicBinding(): ZTopicBinding {
  return {
    topic: 'persona',
    apply: (args) => applyPersona({ userId: args.userId, value: args.value }),
    renderCard: (args) => renderPersonaCard({ userId: args.userId, issuedAt: args.issuedAt }),
  };
}
