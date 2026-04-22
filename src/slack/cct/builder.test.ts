import { describe, expect, it } from 'vitest';
import type { AuthKey, SlotState } from '../../cct-store';
import {
  buildAddSlotModal,
  buildAttachOAuthModal,
  buildCctCardBlocks,
  buildRemoveSlotModal,
  buildSlotRow,
  formatUsageBar,
  subscriptionBadge,
} from './builder';
import { CCT_ACTION_IDS, CCT_BLOCK_IDS, CCT_VIEW_IDS } from './views';

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

  it('includes rate-limit timestamp + source in the context row (M1-S2 moves usage out of context)', () => {
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
    // isActive=true so the context + usage-panel stack is emitted (#644
    // review — inactive slots are compacted to 2 blocks to fit Slack's
    // 50-block cap).
    const blocks = buildSlotRow(slot, state, true, now, 'Asia/Seoul');
    const context = blocks[1] as any;
    expect(context.type).toBe('context');
    const text = context.elements[0].text as string;
    expect(text).toContain('rate-limited');
    expect(text).toContain('12:37 KST');
    expect(text).toContain('via response_header');
    // M1-S2 — old one-line `usage 5h X% 7d Y%` is removed; the usage panel
    // now lives in a dedicated section/context block rendered after this
    // one. The context row MUST NOT contain the legacy single-line string.
    expect(text).not.toMatch(/5h\s+72%/);
    expect(text).not.toMatch(/7d\s+33%/);
  });

  it('honours 0..100 utilization values in the progress bar panel', () => {
    const slot = setupSlot();
    const state: SlotState = {
      authState: 'healthy',
      activeLeases: [],
      usage: {
        fetchedAt: '2026-04-18T00:00:00Z',
        fiveHour: { utilization: 77, resetsAt: '2026-04-18T05:00:00Z' },
      },
    };
    // isActive=true so the usage panel is emitted.
    const blocks = buildSlotRow(slot, state, true, Date.parse('2026-04-18T00:01:00Z'));
    const flat = JSON.stringify(blocks);
    // Pass-through path: 77 > 1 → rendered as 77%.
    expect(flat).toMatch(/77%/);
  });

  it('shows cooldown suffix when still in future', () => {
    const slot = setupSlot();
    const now = Date.parse('2026-04-18T03:42:00Z');
    const state: SlotState = {
      authState: 'healthy',
      activeLeases: [],
      cooldownUntil: '2026-04-18T04:42:00Z',
    };
    // isActive=true so the context row is emitted (#644 review fix).
    const blocks = buildSlotRow(slot, state, true, now, 'Asia/Seoul');
    const text = (blocks[1] as any).elements[0].text as string;
    expect(text).toMatch(/cooldown until/);
  });

  // #644 review P1 — inactive slots must collapse to section + actions + divider
  // so a 15-slot card stays under Slack's 50-block cap.
  it('inactive slot collapses to section + actions only (no context, no usage panel)', () => {
    const slot = setupSlot();
    const state: SlotState = {
      authState: 'refresh_failed',
      activeLeases: [],
      rateLimitedAt: '2026-04-18T03:37:00Z',
      usage: {
        fetchedAt: '2026-04-18T03:42:00Z',
        fiveHour: { utilization: 0.9, resetsAt: '2026-04-18T08:37:00Z' },
      },
    };
    const now = Date.parse('2026-04-18T03:42:00Z');
    const blocks = buildSlotRow(slot, state, false, now, 'Asia/Seoul');
    const types = blocks.map((b: any) => b.type);
    // Exactly two blocks: a section (headline) + an actions row.
    expect(types).toEqual(['section', 'actions']);
    const flat = JSON.stringify(blocks);
    // No usage progress bars, no rate-limit banner — the context stack is
    // suppressed for inactive rows.
    expect(flat).not.toMatch(/█/);
    expect(flat).not.toMatch(/rate-limited/);
    expect(flat).not.toMatch(/refresh_failed/);
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

describe('buildAddSlotModal — api_key arm (Z3)', () => {
  it('T7: renders the api_key radio option and shows the api_key input when selected', () => {
    // Default radio options include api_key.
    const defaultView = buildAddSlotModal() as any;
    const kindBlock = defaultView.blocks.find((b: any) => b.block_id === CCT_BLOCK_IDS.add_kind);
    const radioValues = kindBlock.element.options.map((o: any) => o.value);
    expect(radioValues).toEqual(expect.arrayContaining(['setup_token', 'oauth_credentials', 'api_key']));

    // api_key arm shows the api_key input and no ToS ack block.
    const view = buildAddSlotModal('api_key') as any;
    const blockIds = view.blocks.map((b: any) => b.block_id);
    expect(blockIds).toContain(CCT_BLOCK_IDS.add_api_key_value);
    expect(blockIds).not.toContain(CCT_BLOCK_IDS.add_setup_token_value);
    expect(blockIds).not.toContain(CCT_BLOCK_IDS.add_oauth_credentials_blob);
    expect(blockIds).not.toContain(CCT_BLOCK_IDS.add_tos_ack);
  });
});

describe('buildAttachOAuthModal (Z2)', () => {
  it('T7b: targets the slot via private_metadata and includes the ToS ack checkbox', () => {
    const slot = setupSlot('setup-a', 'slot-attach');
    const view = buildAttachOAuthModal(slot) as any;
    expect(view.callback_id).toBe(CCT_VIEW_IDS.attach);
    expect(view.private_metadata).toBe('slot-attach');
    const blockIds = view.blocks.map((b: any) => b.block_id);
    expect(blockIds).toContain(CCT_BLOCK_IDS.attach_oauth_blob);
    expect(blockIds).toContain(CCT_BLOCK_IDS.attach_tos_ack);
  });
});

describe('buildSlotRow Attach/Detach buttons (Z2)', () => {
  function setupSlotWithAttachment(name: string = 'cct-attached', keyId: string = 'slot-attached'): AuthKey {
    return {
      kind: 'cct',
      source: 'setup',
      keyId,
      name,
      setupToken: 'sk-ant-oat01-xxxxxxxx',
      oauthAttachment: {
        accessToken: 'tok',
        refreshToken: 'ref',
        expiresAtMs: Date.parse('2026-12-31T00:00:00Z'),
        scopes: ['user:profile', 'user:inference'],
        acknowledgedConsumerTosRisk: true,
      },
      createdAt: '2026-01-01T00:00:00Z',
    };
  }
  function apiKeySlot(name: string = 'api1', keyId: string = 'slot-api'): AuthKey {
    return {
      kind: 'api_key',
      keyId,
      name,
      value: 'sk-ant-api03-abcdefghij',
      createdAt: '2026-01-01T00:00:00Z',
    };
  }
  const now = Date.parse('2026-04-18T00:00:00Z');

  it('T7c-i: setup-source cct slot without attachment gets Attach OAuth button', () => {
    const slot = setupSlot('bare', 'slot-bare');
    const blocks = buildSlotRow(slot, undefined, false, now);
    const actions = blocks.find((b: any) => b.type === 'actions') as any;
    const ids = actions.elements.map((e: any) => e.action_id);
    expect(ids).toContain(CCT_ACTION_IDS.attach);
    expect(ids).not.toContain(CCT_ACTION_IDS.detach);
    const attachBtn = actions.elements.find((e: any) => e.action_id === CCT_ACTION_IDS.attach);
    expect(attachBtn.value).toBe('slot-bare');
  });

  it('T7c-ii: setup-source cct slot with attachment gets Detach OAuth button', () => {
    const slot = setupSlotWithAttachment();
    const blocks = buildSlotRow(slot, undefined, false, now);
    const actions = blocks.find((b: any) => b.type === 'actions') as any;
    const ids = actions.elements.map((e: any) => e.action_id);
    expect(ids).toContain(CCT_ACTION_IDS.detach);
    expect(ids).not.toContain(CCT_ACTION_IDS.attach);
    const detachBtn = actions.elements.find((e: any) => e.action_id === CCT_ACTION_IDS.detach);
    expect(detachBtn.value).toBe('slot-attached');
  });

  it('T7c-iii: legacy-attachment cct slot has NO Attach/Detach (mandatory-attachment arm)', () => {
    const slot = oauthSlot();
    const blocks = buildSlotRow(slot, undefined, false, now);
    const actions = blocks.find((b: any) => b.type === 'actions') as any;
    const ids = actions.elements.map((e: any) => e.action_id);
    expect(ids).not.toContain(CCT_ACTION_IDS.attach);
    expect(ids).not.toContain(CCT_ACTION_IDS.detach);
  });

  it('T7c-iv: api_key slot has NO Attach/Detach (no attachment surface)', () => {
    const slot = apiKeySlot();
    const blocks = buildSlotRow(slot, undefined, false, now);
    const actions = blocks.find((b: any) => b.type === 'actions') as any;
    const ids = actions.elements.map((e: any) => e.action_id);
    expect(ids).not.toContain(CCT_ACTION_IDS.attach);
    expect(ids).not.toContain(CCT_ACTION_IDS.detach);
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

// ────────────────────────────────────────────────────────────────────
// M1-S2 · formatUsageBar (shared progress-bar helper)
// ────────────────────────────────────────────────────────────────────

describe('formatUsageBar (M1-S2)', () => {
  const now = Date.parse('2026-04-21T00:00:00Z');

  it('renders a left-padded label + progress bar + percent + "resets in" hint', () => {
    const iso = new Date(now + 2 * 3_600_000 + 15 * 60_000).toISOString();
    const out = formatUsageBar(0.82, iso, now, '5h');
    // Padded label, filled blocks, unfilled blocks, percent, `resets in` hint.
    expect(out).toMatch(/^5h\s+█+░+\s+82% · resets in /);
  });

  it('renders a stable "(no data)" form when util is undefined', () => {
    const out = formatUsageBar(undefined, undefined, now, '7d');
    // Label is left-padded to the same fixed width used by the populated
    // row so columns align visually. Exact width may be tweaked later, but
    // the output MUST start with the label and contain the sentinel literal.
    expect(out.startsWith('7d')).toBe(true);
    expect(out).toContain('(no data)');
  });

  it('accepts the 0..100 utilization form (pass-through, not *100)', () => {
    const iso = new Date(now + 86_400_000).toISOString();
    const out = formatUsageBar(77, iso, now, '7d-sonnet');
    expect(out).toMatch(/77%/);
  });
});

// ────────────────────────────────────────────────────────────────────
// M1-S2 · buildSlotRow emits 3-line usage panel
// ────────────────────────────────────────────────────────────────────

describe('buildSlotRow — usage panel (M1-S2)', () => {
  const now = Date.parse('2026-04-21T00:00:00Z');
  function slotWithAttachment(): AuthKey {
    return {
      kind: 'cct',
      source: 'setup',
      keyId: 'slot-u',
      name: 'cct-u',
      setupToken: 'sk-ant-oat01-xxxxxxxx',
      oauthAttachment: {
        accessToken: 't',
        refreshToken: 'r',
        expiresAtMs: now + 3_600_000,
        scopes: ['user:profile'],
        acknowledgedConsumerTosRisk: true,
        subscriptionType: 'max_5x',
      },
      createdAt: '2026-04-01T00:00:00Z',
    };
  }

  it('emits three usage lines when state.usage is populated (5h / 7d / 7d-sonnet)', () => {
    const slot = slotWithAttachment();
    const state: SlotState = {
      authState: 'healthy',
      activeLeases: [],
      usage: {
        fetchedAt: new Date(now).toISOString(),
        fiveHour: { utilization: 0.8, resetsAt: new Date(now + 2 * 3_600_000).toISOString() },
        sevenDay: { utilization: 0.28, resetsAt: new Date(now + 3 * 86_400_000).toISOString() },
        sevenDaySonnet: { utilization: 0.18, resetsAt: new Date(now + 3 * 86_400_000).toISOString() },
      },
    };
    // isActive=true — #644 review compacts inactive slots, so the usage
    // panel is emitted only on the active row.
    const blocks = buildSlotRow(slot, state, true, now);
    const flat = JSON.stringify(blocks);
    // Three independent progress rows — label starts-of-line in the rendered text.
    expect(flat).toMatch(/5h[^"]*█/);
    expect(flat).toMatch(/7d[^"]*█/);
    expect(flat).toMatch(/7d-sonnet[^"]*█/);
  });

  it('omits the usage panel entirely when state.usage is undefined', () => {
    const slot = slotWithAttachment();
    const state: SlotState = { authState: 'healthy', activeLeases: [] };
    const blocks = buildSlotRow(slot, state, true, now);
    const flat = JSON.stringify(blocks);
    // No progress-bar glyphs if usage is absent.
    expect(flat).not.toMatch(/█/);
    expect(flat).not.toContain('(no data)');
  });

  it('buildSlotRow never emits the old single-line `usage 5h X% 7d Y%` literal', () => {
    const slot = slotWithAttachment();
    const state: SlotState = {
      authState: 'healthy',
      activeLeases: [],
      usage: {
        fetchedAt: new Date(now).toISOString(),
        fiveHour: { utilization: 0.5, resetsAt: new Date(now + 3_600_000).toISOString() },
        sevenDay: { utilization: 0.2, resetsAt: new Date(now + 86_400_000).toISOString() },
      },
    };
    const blocks = buildSlotRow(slot, state, true, now);
    const flat = JSON.stringify(blocks);
    // The spec explicitly deletes the compact `usage 5h X% 7d Y%` line.
    expect(flat).not.toMatch(/usage 5h \d+% 7d \d+%/);
  });
});

// ────────────────────────────────────────────────────────────────────
// #644 review P1 — block-overflow regression guard (≤ 50 blocks / card)
// ────────────────────────────────────────────────────────────────────

describe('buildCctCardBlocks — Slack 50-block hard cap (#644 review P1)', () => {
  const now = Date.parse('2026-04-21T00:00:00Z');
  // Build `n` oauth-attached cct slots, each with full usage state, and
  // render with `slot-0` as the active one. The cap was introduced in
  // the M1 fix that compacts inactive slots; this guard catches a future
  // refactor that re-enables the per-row detail stack for inactive slots.
  function buildNSlotCard(n: number) {
    const slots: AuthKey[] = [];
    const states: Record<string, SlotState> = {};
    for (let i = 0; i < n; i += 1) {
      const keyId = `slot-${i}`;
      slots.push({
        kind: 'cct',
        source: 'setup',
        keyId,
        name: `cct${i}`,
        setupToken: 'sk-ant-oat01-xxxxxxxx',
        oauthAttachment: {
          accessToken: 't',
          refreshToken: 'r',
          expiresAtMs: now + 86_400_000,
          scopes: ['user:profile'],
          acknowledgedConsumerTosRisk: true,
          subscriptionType: 'max_5x',
        },
        createdAt: '',
      });
      states[keyId] = {
        authState: 'healthy',
        activeLeases: [],
        rateLimitedAt: new Date(now - 60_000).toISOString(),
        usage: {
          fetchedAt: new Date(now).toISOString(),
          fiveHour: { utilization: 0.45, resetsAt: new Date(now + 3 * 3_600_000).toISOString() },
          sevenDay: { utilization: 0.2, resetsAt: new Date(now + 6 * 86_400_000).toISOString() },
          sevenDaySonnet: { utilization: 0.1, resetsAt: new Date(now + 6 * 86_400_000).toISOString() },
        },
      };
    }
    return buildCctCardBlocks({ slots, states, activeKeyId: 'slot-0', nowMs: now });
  }

  // #644 round 4 (autonomous) — N=15 is the design ceiling for this card.
  // With the inactive-slot compact rendering landed in M1, 15 attached cct
  // slots (14 inactive-compact + 1 active-expanded) + header/context/
  // card-level action row sit JUST under the Slack 50-block hard cap. A
  // refactor that re-expands the inactive-slot detail stack would push
  // this case over 50 and cause `views.open` / `chat.postEphemeral` to
  // reject the blocks array entirely. Keep the N=15 row in this matrix as
  // the regression tripwire; do not relax `toBeLessThanOrEqual(50)` —
  // anything above 50 is a hard Slack rejection, not a soft warning.
  it.each([1, 7, 10, 15])('N=%d attached slots → block count ≤ 50 (with slot-0 active)', (n) => {
    const blocks = buildNSlotCard(n);
    expect(blocks.length).toBeLessThanOrEqual(50);
  });
});

// ────────────────────────────────────────────────────────────────────
// M1-S3 · subscriptionBadge helper
// ────────────────────────────────────────────────────────────────────

describe('subscriptionBadge (M1-S3)', () => {
  it('formats max_5x → " · Max 5x"', () => {
    const slot: AuthKey = {
      kind: 'cct',
      source: 'setup',
      keyId: 'k',
      name: 'n',
      setupToken: 'sk-ant-oat01-xxxx',
      oauthAttachment: {
        accessToken: 't',
        refreshToken: 'r',
        expiresAtMs: 0,
        scopes: ['user:profile'],
        acknowledgedConsumerTosRisk: true,
        subscriptionType: 'max_5x',
      },
      createdAt: '',
    };
    expect(subscriptionBadge(slot)).toBe(' · Max 5x');
  });

  it('formats max_20x → " · Max 20x"', () => {
    const slot: AuthKey = {
      kind: 'cct',
      source: 'legacy-attachment',
      keyId: 'k',
      name: 'n',
      oauthAttachment: {
        accessToken: 't',
        refreshToken: 'r',
        expiresAtMs: 0,
        scopes: ['user:profile'],
        acknowledgedConsumerTosRisk: true,
        subscriptionType: 'max_20x',
      },
      createdAt: '',
    };
    expect(subscriptionBadge(slot)).toBe(' · Max 20x');
  });

  it('formats pro → " · Pro"', () => {
    const slot: AuthKey = {
      kind: 'cct',
      source: 'legacy-attachment',
      keyId: 'k',
      name: 'n',
      oauthAttachment: {
        accessToken: 't',
        refreshToken: 'r',
        expiresAtMs: 0,
        scopes: ['user:profile'],
        acknowledgedConsumerTosRisk: true,
        subscriptionType: 'pro',
      },
      createdAt: '',
    };
    expect(subscriptionBadge(slot)).toBe(' · Pro');
  });

  it('returns empty string for api_key slot (no attachment surface)', () => {
    const slot: AuthKey = {
      kind: 'api_key',
      keyId: 'k',
      name: 'n',
      value: 'sk-ant-api03-xxxx',
      createdAt: '',
    };
    expect(subscriptionBadge(slot)).toBe('');
  });

  it('returns empty string when subscriptionType missing', () => {
    const slot: AuthKey = {
      kind: 'cct',
      source: 'setup',
      keyId: 'k',
      name: 'n',
      setupToken: 'sk-ant-oat01-xxxx',
      createdAt: '',
    };
    expect(subscriptionBadge(slot)).toBe('');
  });
});

// ────────────────────────────────────────────────────────────────────
// M1-S4 · per-slot + card-level Refresh buttons
// ────────────────────────────────────────────────────────────────────

describe('buildSlotRow — Refresh button (M1-S4)', () => {
  const now = Date.parse('2026-04-21T00:00:00Z');
  function attachedSetupSlot(): AuthKey {
    return {
      kind: 'cct',
      source: 'setup',
      keyId: 'slot-r',
      name: 'cct-r',
      setupToken: 'sk-ant-oat01-xxxxxxxx',
      oauthAttachment: {
        accessToken: 't',
        refreshToken: 'r',
        expiresAtMs: now + 3_600_000,
        scopes: ['user:profile'],
        acknowledgedConsumerTosRisk: true,
      },
      createdAt: '',
    };
  }

  it('attached cct slot action row has a Refresh button carrying keyId', () => {
    const slot = attachedSetupSlot();
    const blocks = buildSlotRow(slot, undefined, false, now);
    const actions = blocks.find((b: any) => b.type === 'actions') as any;
    const ids = actions.elements.map((e: any) => e.action_id);
    expect(ids).toContain(CCT_ACTION_IDS.refresh_usage_slot);
    const refresh = actions.elements.find((e: any) => e.action_id === CCT_ACTION_IDS.refresh_usage_slot);
    expect(refresh.value).toBe('slot-r');
  });

  // Negative cases — the Refresh button must NOT appear on slots that have no
  // usage-API surface. If it did, a click would 500 on the handler side when
  // `fetchAndStoreUsage` refuses a non-attached slot. Two distinct shapes are
  // checked: a bare setup-source cct slot (setupToken but no oauthAttachment)
  // and an api_key slot (entirely separate kind, no attachment concept).
  it('bare setup-source cct slot (no oauthAttachment) has NO Refresh button', () => {
    const slot: AuthKey = {
      kind: 'cct',
      source: 'setup',
      keyId: 'slot-bare',
      name: 'cct-bare',
      setupToken: 'sk-ant-oat01-xxxxxxxx',
      // oauthAttachment intentionally absent — usage API cannot reach Anthropic.
      createdAt: '',
    };
    const blocks = buildSlotRow(slot, undefined, false, now);
    const actions = blocks.find((b: any) => b.type === 'actions') as any;
    const ids = actions.elements.map((e: any) => e.action_id);
    expect(ids).not.toContain(CCT_ACTION_IDS.refresh_usage_slot);
  });

  it('api_key slot has NO Refresh button (no attachment surface)', () => {
    const slot: AuthKey = {
      kind: 'api_key',
      keyId: 'slot-api',
      name: 'ops-api',
      value: 'sk-ant-api03-xxxxxxxx',
      createdAt: '',
    };
    const blocks = buildSlotRow(slot, undefined, false, now);
    const actions = blocks.find((b: any) => b.type === 'actions') as any;
    const ids = actions.elements.map((e: any) => e.action_id);
    expect(ids).not.toContain(CCT_ACTION_IDS.refresh_usage_slot);
  });
});

// ────────────────────────────────────────────────────────────────────
// #644 review — CCT_ACTION_IDS / CCT_BLOCK_IDS literal-string contract lock
// ────────────────────────────────────────────────────────────────────
//
// These IDs are the wire contract between the Slack view-state snapshot and
// the Bolt block_actions router. A silent rename breaks every deployed
// tenant's in-flight modal state (`views.update` loses typed values) and
// mis-routes refresh clicks to unhandled handlers. Every new ID (including
// M1-S4 `cct_refresh_usage_all` / `cct_refresh_usage_slot`) is locked here
// so a future append-only change is intentional, not silent.
describe('CCT_ACTION_IDS / CCT_BLOCK_IDS literal lock (#644 review)', () => {
  it('CCT_ACTION_IDS maps each key to its exact wire string', () => {
    expect(CCT_ACTION_IDS).toEqual({
      next: 'cct_next',
      add: 'cct_open_add',
      remove: 'cct_open_remove',
      rename: 'cct_open_rename',
      set_active: 'cct_set_active',
      tos_ack: 'cct_tos_ack',
      kind_radio: 'cct_kind_radio',
      name_input: 'cct_name_value',
      setup_token_input: 'cct_setup_token_value',
      oauth_blob_input: 'cct_oauth_blob_value',
      api_key_input: 'cct_api_key_value',
      rename_input: 'cct_rename_value',
      remove_private_metadata: 'cct_remove_slot_id',
      attach: 'cct_open_attach',
      detach: 'cct_detach',
      attach_oauth_input: 'cct_attach_oauth_blob_value',
      attach_tos_ack: 'cct_attach_tos_ack_value',
      refresh_usage_all: 'cct_refresh_usage_all',
      refresh_usage_slot: 'cct_refresh_usage_slot',
    });
  });

  it('CCT_BLOCK_IDS maps each key to its exact wire string', () => {
    expect(CCT_BLOCK_IDS).toEqual({
      add_name: 'cct_add_name',
      add_kind: 'cct_add_kind',
      add_setup_token_value: 'cct_add_value',
      add_oauth_credentials_blob: 'cct_add_oauth_blob',
      add_tos_ack: 'cct_add_tos_ack',
      add_api_key_value: 'cct_add_api_key_value',
      remove_confirm: 'cct_remove_confirm',
      rename_name: 'cct_rename_name',
      attach_oauth_blob: 'cct_attach_oauth_blob',
      attach_tos_ack: 'cct_attach_tos_ack',
    });
  });

  it('CCT_VIEW_IDS maps each key to its exact wire string', () => {
    expect(CCT_VIEW_IDS).toEqual({
      add: 'cct_add_slot',
      remove: 'cct_remove_slot',
      rename: 'cct_rename_slot',
      attach: 'cct_attach_oauth',
    });
  });
});

describe('buildCctCardBlocks — Refresh all (M1-S4)', () => {
  it('card-level action row includes the new Refresh-all button alongside existing actions', () => {
    const slot: AuthKey = {
      kind: 'cct',
      source: 'setup',
      keyId: 'slot-1',
      name: 'cct1',
      setupToken: 'sk-ant-oat01-xxxx',
      createdAt: '',
    };
    const blocks = buildCctCardBlocks({ slots: [slot], states: {} });
    // Find the card-level action row (the one containing cct_next / cct_open_add).
    const cardRow = blocks.find(
      (b: any) => b.type === 'actions' && b.elements.some((e: any) => e.action_id === 'cct_next'),
    ) as any;
    expect(cardRow).toBeDefined();
    const ids = cardRow.elements.map((e: any) => e.action_id);
    expect(ids).toContain(CCT_ACTION_IDS.refresh_usage_all);
    // Existing actions still present — contract guarantees no existing ID
    // changes or removals in this PR.
    expect(ids).toContain(CCT_ACTION_IDS.next);
    expect(ids).toContain(CCT_ACTION_IDS.add);
    // Length assertion: exactly three buttons in the card-level row.
    expect(cardRow.elements).toHaveLength(3);
  });
});
