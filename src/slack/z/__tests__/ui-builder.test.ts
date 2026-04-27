import { describe, expect, it } from 'vitest';
import type { TombstoneHint } from '../tombstone';
import {
  buildConfirmationCard,
  buildHelpCard,
  buildSettingCard,
  buildTombstoneCard,
  DEFAULT_HELP_CATEGORIES,
  zBlockId,
} from '../ui-builder';

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
  it('starts with a header block whose block_id encodes help + issuedAt + 0', () => {
    const blocks = buildHelpCard({ issuedAt: 12345 });
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks.length).toBeGreaterThan(0);
    expect((blocks[0] as any).block_id).toBe('z_help_12345_0');
    expect((blocks[0] as any).type).toBe('header');
  });

  it('renders at least one nav button per default category', () => {
    const blocks = buildHelpCard({ issuedAt: 1 });
    const actionIds: string[] = [];
    for (const b of blocks as any[]) {
      if (b.type === 'actions') {
        for (const el of b.elements as any[]) {
          if (typeof el.action_id === 'string') actionIds.push(el.action_id);
        }
      }
    }
    for (const cat of DEFAULT_HELP_CATEGORIES) {
      for (const t of cat.topics) {
        expect(actionIds, `nav action for ${t.id} missing`).toContain(`z_help_nav_${t.id}`);
      }
    }
  });

  it('accepts custom categories and emits one section + actions rows per category', () => {
    const blocks = buildHelpCard({
      issuedAt: 2,
      categories: [
        {
          title: '*Test*',
          topics: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' },
          ],
        },
      ],
    });
    const sections = (blocks as any[]).filter((b) => b.type === 'section');
    expect(sections.length).toBe(1);
    const actions = (blocks as any[]).filter((b) => b.type === 'actions');
    expect(actions.length).toBe(1);
    expect((actions[0] as any).elements.length).toBe(2);
  });

  it('chunks >5 topics into multiple actions rows', () => {
    const topics = Array.from({ length: 7 }, (_, i) => ({ id: `t${i}`, label: `T${i}` }));
    const blocks = buildHelpCard({
      issuedAt: 3,
      categories: [{ title: '*Many*', topics }],
    });
    const actions = (blocks as any[]).filter((b) => b.type === 'actions');
    expect(actions.length).toBe(2);
    expect((actions[0] as any).elements.length).toBe(5);
    expect((actions[1] as any).elements.length).toBe(2);
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

describe('buildSettingCard (Phase 2)', () => {
  it('renders header + current context as first two blocks', () => {
    const blocks = buildSettingCard({
      topic: 'persona',
      icon: '🎭',
      title: 'Persona',
      currentLabel: 'linus',
      options: [{ id: 'linus', label: 'Linus' }],
      issuedAt: 5555,
    });
    expect((blocks[0] as any).type).toBe('header');
    expect((blocks[0] as any).block_id).toBe('z_persona_5555_0');
    expect((blocks[0] as any).text.text).toBe('🎭 Persona');
    expect((blocks[1] as any).type).toBe('context');
    expect((blocks[1] as any).elements[0].text).toContain('linus');
  });

  it('emits options buttons with z_setting_<topic>_set_<id> action_id', () => {
    const blocks = buildSettingCard({
      topic: 'model',
      icon: '🤖',
      title: 'Model',
      currentLabel: 'sonnet',
      options: [
        { id: 'sonnet', label: 'Sonnet' },
        { id: 'opus', label: 'Opus' },
      ],
      issuedAt: 1,
    });
    const actions = (blocks as any[]).find((b) => b.type === 'actions');
    expect(actions.elements[0].action_id).toBe('z_setting_model_set_sonnet');
    expect(actions.elements[1].action_id).toBe('z_setting_model_set_opus');
  });

  it('chunks >5 options into multiple actions blocks', () => {
    const options = Array.from({ length: 12 }, (_, i) => ({ id: `o${i}`, label: `O${i}` }));
    const blocks = buildSettingCard({
      topic: 'persona',
      icon: '🎭',
      title: 'Persona',
      currentLabel: 'x',
      options,
      issuedAt: 1,
    });
    const actionBlocks = (blocks as any[]).filter(
      (b) => b.type === 'actions' && (b.block_id as string).startsWith('z_persona_1_'),
    );
    // 12 options → 3 rows of [5,5,2] plus cancel (1 more row with block_id 99)
    const optionsRows = actionBlocks.filter((b) => (b.block_id as string) !== 'z_persona_1_99');
    expect(optionsRows.length).toBe(3);
    expect(optionsRows[0].elements.length).toBe(5);
    expect(optionsRows[1].elements.length).toBe(5);
    expect(optionsRows[2].elements.length).toBe(2);
  });

  it('injects confirm dialog when option has description', () => {
    const blocks = buildSettingCard({
      topic: 'sandbox',
      icon: '🛡️',
      title: 'Sandbox',
      currentLabel: 'ON',
      options: [{ id: 'off', label: 'Off', description: '샌드박스 격리 해제' }],
      issuedAt: 7,
    });
    const actions = (blocks as any[]).find((b) => b.type === 'actions');
    expect(actions.elements[0].confirm).toBeDefined();
    expect(actions.elements[0].confirm.text.text).toContain('샌드박스');
  });

  it('emits cancel action by default with block_id suffix 99', () => {
    const blocks = buildSettingCard({
      topic: 'persona',
      icon: '🎭',
      title: 'Persona',
      currentLabel: 'linus',
      options: [{ id: 'linus', label: 'Linus' }],
      issuedAt: 42,
    });
    const cancel = (blocks as any[]).find((b) => b.type === 'actions' && b.block_id === 'z_persona_42_99');
    expect(cancel).toBeDefined();
    expect(cancel.elements[0].action_id).toBe('z_setting_persona_cancel');
    expect(cancel.elements[0].style).toBe('danger');
  });

  it('omits cancel action when showCancel is false', () => {
    const blocks = buildSettingCard({
      topic: 'persona',
      icon: '🎭',
      title: 'Persona',
      currentLabel: 'linus',
      options: [{ id: 'linus', label: 'Linus' }],
      issuedAt: 42,
      showCancel: false,
    });
    const cancel = (blocks as any[]).find((b) => b.type === 'actions' && b.block_id === 'z_persona_42_99');
    expect(cancel).toBeUndefined();
  });

  it('appends divider + context when additionalCommands is provided', () => {
    const blocks = buildSettingCard({
      topic: 'persona',
      icon: '🎭',
      title: 'Persona',
      currentLabel: 'linus',
      options: [{ id: 'linus', label: 'Linus' }],
      additionalCommands: ['`/z persona list`', '`/z persona set <n>`'],
      issuedAt: 1,
    });
    const divider = (blocks as any[]).find((b) => b.type === 'divider');
    expect(divider).toBeDefined();
    const ctxBlocks = (blocks as any[]).filter((b) => b.type === 'context');
    // 2 context blocks: current + additionalCommands
    expect(ctxBlocks.length).toBe(2);
    expect(ctxBlocks[1].elements[0].text).toContain('/z persona list');
  });

  it('appends extraActions row with explicit action_ids', () => {
    const blocks = buildSettingCard({
      topic: 'notify',
      icon: '🔔',
      title: 'Notify',
      currentLabel: 'on',
      options: [],
      extraActions: [
        { actionId: 'z_setting_notify_open_modal', label: 'Set Telegram', style: 'primary' },
        { actionId: 'z_setting_notify_set_remove_telegram', label: 'Remove Telegram', style: 'danger' },
      ],
      issuedAt: 1,
    });
    const actions = (blocks as any[]).filter((b) => b.type === 'actions');
    // options is empty → first actions row is the extra row
    expect(actions[0].elements[0].action_id).toBe('z_setting_notify_open_modal');
    expect(actions[0].elements[1].action_id).toBe('z_setting_notify_set_remove_telegram');
  });

  it('generates deterministic block_ids (z_<topic>_<issuedAt>_<idx>)', () => {
    const a = buildSettingCard({
      topic: 'persona',
      icon: '🎭',
      title: 'P',
      currentLabel: 'x',
      options: [{ id: 'a', label: 'A' }],
      issuedAt: 1000,
    });
    const b = buildSettingCard({
      topic: 'persona',
      icon: '🎭',
      title: 'P',
      currentLabel: 'x',
      options: [{ id: 'a', label: 'A' }],
      issuedAt: 1000,
    });
    const ids = (blocks: any[]) => blocks.map((x: any) => x.block_id);
    expect(ids(a as any[])).toEqual(ids(b as any[]));
  });
});

describe('buildConfirmationCard', () => {
  it('returns a single section with optional context', () => {
    const one = buildConfirmationCard({
      topic: 'persona',
      icon: '✅',
      title: 'Persona updated',
      summary: 'Your persona is now `linus`.',
      issuedAt: 1,
    });
    expect(one.length).toBe(1);

    const two = buildConfirmationCard({
      topic: 'persona',
      icon: '✅',
      title: 'Persona updated',
      summary: 'Your persona is now `linus`.',
      description: '_Applied to future sessions._',
      issuedAt: 1,
    });
    expect(two.length).toBe(2);
    expect((two[1] as any).type).toBe('context');
  });
});
