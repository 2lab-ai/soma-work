import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyPersona, createPersonaTopicBinding, renderPersonaCard } from '../persona-topic';

vi.mock('../../../../prompt-builder', () => ({
  getAvailablePersonas: () => ['zhuge', 'linus', 'ada'],
}));

// Bypass real userSettingsStore persistence.
vi.mock('../../../../user-settings-store', () => {
  const store: Record<string, string> = {};
  return {
    userSettingsStore: {
      getUserPersona: (u: string) => store[u] ?? 'zhuge',
      setUserPersona: (u: string, p: string) => {
        store[u] = p;
      },
    },
  };
});

describe('persona-topic.renderPersonaCard', () => {
  it('returns blocks with current persona + all available personas as buttons', async () => {
    const { blocks, text } = await renderPersonaCard({ userId: 'U1', issuedAt: 100 });
    expect(text).toContain('Persona');
    const header = blocks[0] as any;
    expect(header.type).toBe('header');
    expect(header.text.text).toContain('Persona');

    const actionBlocks = (blocks as any[]).filter((b) => b.type === 'actions' && b.block_id !== 'z_persona_100_99');
    const actionIds = actionBlocks.flatMap((b: any) => b.elements.map((e: any) => e.action_id));
    expect(actionIds).toContain('z_setting_persona_set_zhuge');
    expect(actionIds).toContain('z_setting_persona_set_linus');
    expect(actionIds).toContain('z_setting_persona_set_ada');
  });

  it('cancel button always present with danger style', async () => {
    const { blocks } = await renderPersonaCard({ userId: 'U1', issuedAt: 5 });
    const cancel = (blocks as any[]).find((b) => b.type === 'actions' && b.block_id === 'z_persona_5_99');
    expect(cancel).toBeDefined();
    expect(cancel.elements[0].action_id).toBe('z_setting_persona_cancel');
  });
});

describe('persona-topic.applyPersona', () => {
  it('sets persona when value is valid', async () => {
    const r = await applyPersona({ userId: 'U1', value: 'linus' });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('linus');
  });

  it('returns error on unknown persona', async () => {
    const r = await applyPersona({ userId: 'U1', value: 'ghostface' });
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('Unknown');
  });
});

describe('createPersonaTopicBinding', () => {
  it('exposes topic + apply + renderCard', () => {
    const b = createPersonaTopicBinding();
    expect(b.topic).toBe('persona');
    expect(typeof b.apply).toBe('function');
    expect(typeof b.renderCard).toBe('function');
  });
});
