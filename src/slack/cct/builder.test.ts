import { describe, expect, it } from 'vitest';
import type { AuthKey, SlotState } from '../../cct-store';
import { buildAddSlotModal, buildCctCardBlocks, buildRemoveSlotModal, buildSlotRow } from './builder';
import { CCT_BLOCK_IDS, CCT_VIEW_IDS } from './views';

function setupSlot(name: string = 'cct1', keyId: string = 'slot-1'): AuthKey {
  return {
    kind: 'cct',
    source: 'setup',
    keyId,
    name,
    setupToken: 'sk-ant-oat01-xxxxxxxx',
    createdAt: '2026-01-01T00:00:00Z',
  };
}

function oauthSlot(name: string = 'oauth-personal', keyId: string = 'slot-2'): AuthKey {
  return {
    kind: 'cct',
    source: 'legacy-attachment',
    keyId,
    name,
    oauthAttachment: {
      accessToken: 'tok',
      refreshToken: 'ref',
      expiresAtMs: Date.parse('2026-12-31T00:00:00Z'),
      scopes: ['user:profile'],
      acknowledgedConsumerTosRisk: true,
    },
    createdAt: '2026-01-01T00:00:00Z',
  };
}

describe('buildSlotRow', () => {
  it('renders the name, active suffix, kind tag, and no ToS badge for cct/setup', () => {
    const slot = setupSlot();
    const now = Date.parse('2026-04-18T03:42:00Z');
    const blocks = buildSlotRow(slot, undefined, true, now, 'Asia/Seoul');
    const section = blocks[0] as any;
    expect(section.type).toBe('section');
    expect(section.text.text).toContain('*cct1*');
    expect(section.text.text).toContain('· active');
    expect(section.text.text).toContain('cct/setup');
    expect(section.text.text).not.toMatch(/ToS-risk/);
  });

  it('renders ConsumerTosBadge for cct/legacy-attachment', () => {
    const slot = oauthSlot();
    const now = Date.parse('2026-04-18T03:42:00Z');
    const blocks = buildSlotRow(slot, undefined, false, now);
    const section = blocks[0] as any;
    expect(section.text.text).toContain('cct/legacy-attachment');
    expect(section.text.text).toContain('ToS-risk');
  });

  it('includes rate-limit timestamp + source + usage segment when state populated', () => {
    const slot = setupSlot();
    const state: SlotState = {
      authState: 'healthy',
      activeLeases: [],
      rateLimitedAt: '2026-04-18T03:37:00Z',
      rateLimitSource: 'response_header',
      usage: {
        fetchedAt: '2026-04-18T03:42:00Z',
        fiveHour: { utilization: 0.72, resetsAt: '2026-04-18T08:37:00Z' },
        sevenDay: { utilization: 0.33, resetsAt: '2026-04-25T03:37:00Z' },
      },
    };
    const now = Date.parse('2026-04-18T03:42:00Z');
    const blocks = buildSlotRow(slot, state, false, now, 'Asia/Seoul');
    const context = blocks[1] as any;
    expect(context.type).toBe('context');
    const text = context.elements[0].text as string;
    expect(text).toContain('rate-limited');
    expect(text).toContain('12:37 KST');
    expect(text).toContain('via response_header');
    expect(text).toContain('5h 72%');
    expect(text).toContain('7d 33%');
  });

  it('honours 0..100 utilization values', () => {
    const slot = setupSlot();
    const state: SlotState = {
      authState: 'healthy',
      activeLeases: [],
      usage: {
        fetchedAt: '2026-04-18T00:00:00Z',
        fiveHour: { utilization: 77, resetsAt: '2026-04-18T05:00:00Z' },
      },
    };
    const blocks = buildSlotRow(slot, state, false, Date.parse('2026-04-18T00:01:00Z'));
    const text = (blocks[1] as any).elements[0].text as string;
    expect(text).toContain('5h 77%');
  });

  it('shows cooldown suffix when still in future', () => {
    const slot = setupSlot();
    const now = Date.parse('2026-04-18T03:42:00Z');
    const state: SlotState = {
      authState: 'healthy',
      activeLeases: [],
      cooldownUntil: '2026-04-18T04:42:00Z',
    };
    const blocks = buildSlotRow(slot, state, false, now, 'Asia/Seoul');
    const text = (blocks[1] as any).elements[0].text as string;
    expect(text).toMatch(/cooldown until/);
  });

  it('emits per-slot Remove/Rename buttons with value = keyId', () => {
    const slot = setupSlot();
    const blocks = buildSlotRow(slot, undefined, false, Date.parse('2026-04-18T00:00:00Z'));
    // Last block should be the actions row with Remove + Rename.
    const actions = blocks.find((b: any) => b.type === 'actions') as any;
    expect(actions).toBeDefined();
    const removeBtn = actions.elements.find((e: any) => e.action_id === 'cct_open_remove');
    const renameBtn = actions.elements.find((e: any) => e.action_id === 'cct_open_rename');
    expect(removeBtn).toBeDefined();
    expect(renameBtn).toBeDefined();
    expect(removeBtn.value).toBe(slot.keyId);
    expect(renameBtn.value).toBe(slot.keyId);
  });
});

describe('buildCctCardBlocks', () => {
  it('renders empty state when no slots configured', () => {
    const blocks = buildCctCardBlocks({ slots: [], states: {} });
    const anyBlock = blocks.find((b: any) => b.type === 'section') as any;
    expect(anyBlock.text.text).toMatch(/No CCT slots/);
    // Card-level action row (Next + Add) is always present. Remove/Rename
    // live on each slot row now, so they are absent when no slots exist.
    const cardActions = blocks.find((b: any) => b.type === 'actions') as any;
    const actionIds = cardActions.elements.map((e: any) => e.action_id);
    expect(actionIds).toContain('cct_next');
    expect(actionIds).toContain('cct_open_add');
    expect(actionIds).not.toContain('cct_open_remove');
    expect(actionIds).not.toContain('cct_open_rename');
  });

  it('renders set-active selector only when >1 slot', () => {
    const slot = setupSlot();
    const slot2 = { ...setupSlot('cct2', 'slot-2') };
    const blocks = buildCctCardBlocks({ slots: [slot, slot2], states: {}, activeKeyId: 'slot-1' });
    const selectors = blocks.filter(
      (b: any) => b.type === 'actions' && b.elements.some((e: any) => e.type === 'static_select'),
    );
    expect(selectors.length).toBe(1);
  });

  it('each slot row carries per-slot Remove/Rename buttons whose value is that keyId', () => {
    const slot1 = setupSlot('cct1', 'slot-1');
    const slot2 = setupSlot('cct2', 'slot-2');
    const blocks = buildCctCardBlocks({ slots: [slot1, slot2], states: {}, activeKeyId: 'slot-1' });
    // Collect every actions row whose elements include a cct_open_remove button.
    const removeRows = blocks.filter(
      (b: any) => b.type === 'actions' && b.elements.some((e: any) => e.action_id === 'cct_open_remove'),
    );
    expect(removeRows).toHaveLength(2);
    const removeValues = removeRows.map((r: any) => {
      const btn = r.elements.find((e: any) => e.action_id === 'cct_open_remove');
      return btn.value as string;
    });
    expect(removeValues).toEqual(expect.arrayContaining(['slot-1', 'slot-2']));
    // Same for rename.
    const renameValues = blocks
      .filter((b: any) => b.type === 'actions' && b.elements.some((e: any) => e.action_id === 'cct_open_rename'))
      .map((r: any) => {
        const btn = r.elements.find((e: any) => e.action_id === 'cct_open_rename');
        return btn.value as string;
      });
    expect(renameValues).toEqual(expect.arrayContaining(['slot-1', 'slot-2']));
  });
});

describe('buildAddSlotModal', () => {
  it('defaults to setup_token inputs and contains no ToS ack checkbox', () => {
    const view = buildAddSlotModal() as any;
    expect(view.type).toBe('modal');
    expect(view.callback_id).toBe(CCT_VIEW_IDS.add);
    const blockIds = view.blocks.map((b: any) => b.block_id);
    expect(blockIds).toContain(CCT_BLOCK_IDS.add_name);
    expect(blockIds).toContain(CCT_BLOCK_IDS.add_kind);
    expect(blockIds).toContain(CCT_BLOCK_IDS.add_setup_token_value);
    expect(blockIds).not.toContain(CCT_BLOCK_IDS.add_tos_ack);
    expect(view.blocks.length).toBeLessThanOrEqual(100);
  });

  it('includes oauth blob input + ToS ack when kind is oauth_credentials', () => {
    const view = buildAddSlotModal('oauth_credentials') as any;
    const blockIds = view.blocks.map((b: any) => b.block_id);
    expect(blockIds).toContain(CCT_BLOCK_IDS.add_oauth_credentials_blob);
    expect(blockIds).toContain(CCT_BLOCK_IDS.add_tos_ack);
    expect(view.blocks.length).toBeLessThanOrEqual(100);
  });

  it('kind radio has dispatch_action so views.update fires on change', () => {
    const view = buildAddSlotModal() as any;
    const kindBlock = view.blocks.find((b: any) => b.block_id === CCT_BLOCK_IDS.add_kind);
    expect(kindBlock.dispatch_action).toBe(true);
  });
});

describe('buildRemoveSlotModal', () => {
  it('shows warning when active leases present', () => {
    const view = buildRemoveSlotModal(setupSlot('cct1'), true) as any;
    expect(view.callback_id).toBe(CCT_VIEW_IDS.remove);
    const body = view.blocks[0].text.text as string;
    expect(body).toMatch(/tombstoned/);
    expect(view.private_metadata).toBe('slot-1');
    expect(view.blocks.length).toBeLessThanOrEqual(100);
  });

  it('skips drain warning when no active leases', () => {
    const view = buildRemoveSlotModal(setupSlot('cct1'), false) as any;
    const body = view.blocks[0].text.text as string;
    expect(body).toMatch(/immediately/);
  });
});
