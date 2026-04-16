import { describe, expect, it } from 'vitest';
import type { TombstoneHint } from './tombstone';
import { buildHelpCard, buildSettingCard, buildTombstoneCard, zBlockId } from './ui-builder';

describe('zBlockId', () => {
  it('generates deterministic id from topic/issuedAt/index', () => {
    expect(zBlockId('persona', 1_700_000_000_000, 0)).toBe('z_persona_1700000000000_0');
    expect(zBlockId('persona', 1_700_000_000_000, 1)).toBe('z_persona_1700000000000_1');
  });

  it('lowercases and sanitizes topic', () => {
    expect(zBlockId('Admin Config', 1, 0)).toBe('z_admin_config_1_0');
    expect(zBlockId('admin:config', 1, 0)).toBe('z_admin_config_1_0');
  });

  it('defaults to "z" when topic is empty/invalid', () => {
    expect(zBlockId('', 1, 0)).toBe('z_z_1_0');
    expect(zBlockId('!!!', 1, 0)).toBe('z_z_1_0');
  });

  it('same inputs produce same id (deterministic)', () => {
    const a = zBlockId('model', 999, 2);
    const b = zBlockId('model', 999, 2);
    expect(a).toBe(b);
  });
});

describe('buildHelpCard', () => {
  it('returns at least one block with stable block_id', () => {
    const blocks = buildHelpCard({ issuedAt: 12345 });
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks.length).toBeGreaterThan(0);
    expect((blocks[0] as any).block_id).toBe('z_help_12345_0');
    expect((blocks[0] as any).type).toBe('section');
  });

  it('body mentions all major topics', () => {
    const blocks = buildHelpCard({ issuedAt: 1 });
    const text = ((blocks[0] as any).text.text as string).toLowerCase();
    for (const topic of [
      'persona',
      'model',
      'verbosity',
      'bypass',
      'sandbox',
      'notify',
      'webhook',
      'memory',
      'mcp',
      'plugin',
      'skill',
      'cwd',
      'cct',
      'report',
      'admin',
    ]) {
      expect(text, `topic ${topic} missing`).toContain(topic);
    }
  });
});

describe('buildTombstoneCard', () => {
  const hint: TombstoneHint = {
    match: /^persona$/i,
    title: 'persona',
    oldForm: 'persona set <n>',
    newForm: '/z persona set <n>',
  };

  it('returns 3 blocks: header, actions, footer', () => {
    const blocks = buildTombstoneCard({ hint, issuedAt: 1000 });
    expect(blocks.length).toBe(3);
    expect((blocks[0] as any).type).toBe('section');
    expect((blocks[1] as any).type).toBe('actions');
    expect((blocks[2] as any).type).toBe('context');
  });

  it('header shows oldForm and newForm', () => {
    const blocks = buildTombstoneCard({ hint, issuedAt: 1000 });
    const text = (blocks[0] as any).text.text as string;
    expect(text).toContain(hint.oldForm);
    expect(text).toContain(hint.newForm);
  });

  it('actions include copy + dismiss buttons with action_ids scoped by topic', () => {
    const blocks = buildTombstoneCard({ hint, issuedAt: 1000 });
    const elements = (blocks[1] as any).elements as any[];
    expect(elements.length).toBe(2);
    expect(elements[0].action_id).toBe('z_tombstone_copy_persona');
    expect(elements[1].action_id).toBe('z_tombstone_dismiss_persona');
    expect(elements[0].value).toBe(hint.newForm);
  });

  it('all block_ids follow z_<topic>_<issuedAt>_<index> pattern', () => {
    const blocks = buildTombstoneCard({ hint, issuedAt: 777 });
    expect((blocks[0] as any).block_id).toBe('z_persona_777_0');
    expect((blocks[1] as any).block_id).toBe('z_persona_777_1');
    expect((blocks[2] as any).block_id).toBe('z_persona_777_2');
  });
});

describe('buildSettingCard (Phase 2 stub)', () => {
  it('returns a minimal section block that does not crash', () => {
    const blocks = buildSettingCard({
      topic: 'persona',
      icon: '🎭',
      title: 'Persona',
      currentLabel: 'linus',
      options: [],
      issuedAt: 5555,
    });
    expect(blocks.length).toBe(1);
    expect((blocks[0] as any).type).toBe('section');
    expect((blocks[0] as any).block_id).toBe('z_persona_5555_0');
  });

  it('stub text mentions Phase 2', () => {
    const blocks = buildSettingCard({
      topic: 'model',
      icon: '🤖',
      title: 'Model',
      currentLabel: 'sonnet',
      options: [{ id: 'sonnet', label: 'Sonnet' }],
      issuedAt: 1,
    });
    const text = (blocks[0] as any).text.text as string;
    expect(text).toContain('Phase 2');
  });
});
