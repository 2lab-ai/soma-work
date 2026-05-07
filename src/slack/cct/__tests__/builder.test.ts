import { describe, expect, it } from 'vitest';
import type { AuthKey, SlotState } from '../../../cct-store';
import {
  appendStoreReadFailureBanner,
  buildAddSlotModal,
  buildAttachOAuthModal,
  buildCctCardBlocks,
  buildRemoveSlotModal,
  buildSlotRow,
  formatRateLimitTier,
  formatUsageBar,
  subscriptionBadge,
} from '../builder';
import { CCT_ACTION_IDS, CCT_BLOCK_IDS, CCT_VIEW_IDS } from '../views';

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

  // #801 — `inferred_shared` is the propagation arm of `RateLimitSource`.
  // The /cct card surfaces it as `via inferred shared bucket` so operators
  // can tell apart "this slot itself 429d" from "we inferred this slot is
  // in the same bucket as a recently-limited sibling".
  it('AC-7: rateLimitSource=inferred_shared renders via inferred shared bucket', () => {
    const slot = setupSlot();
    const state: SlotState = {
      authState: 'healthy',
      activeLeases: [],
      rateLimitedAt: '2026-04-18T03:37:00Z',
      rateLimitSource: 'inferred_shared',
    };
    const now = Date.parse('2026-04-18T03:42:00Z');
    const blocks = buildSlotRow(slot, state, true, now, 'Asia/Seoul');
    const text = (blocks[0] as any).text.text as string;
    expect(text).toContain('rate-limited');
    expect(text).toContain('via inferred shared bucket');
    // Must NOT raw-leak the enum literal.
    expect(text).not.toMatch(/via inferred_shared\b/);
  });

  it('rate-limit timestamp + source render in the section multi-line body (always, not gated on isActive)', () => {
    const slot = setupSlot();
    const state: SlotState = {
      authState: 'healthy',
      activeLeases: [],
      rateLimitedAt: '2026-04-18T03:37:00Z',
      rateLimitSource: 'response_header',
      usage: {
        fetchedAt: '2026-04-18T03:42:00Z',
        fiveHour: { utilization: 72, resetsAt: '2026-04-18T08:37:00Z' },
        sevenDay: { utilization: 33, resetsAt: '2026-04-25T03:37:00Z' },
      },
    };
    const now = Date.parse('2026-04-18T03:42:00Z');
    // #653 M2 collapses the former separate context block into a
    // multi-line `section` body so the line-1 identity and line-2 live
    // status fit in one Slack block. isActive is irrelevant — the
    // status line is emitted for every row now.
    const blocks = buildSlotRow(slot, state, true, now, 'Asia/Seoul');
    const section = blocks[0] as any;
    expect(section.type).toBe('section');
    const text = section.text.text as string;
    expect(text).toContain('rate-limited');
    expect(text).toContain('12:37 KST');
    expect(text).toContain('via response_header');
    // Old one-line `usage 5h X% 7d Y%` literal must never re-appear.
    expect(text).not.toMatch(/usage 5h \d+% 7d \d+%/);
  });

  it('honours 0..100 utilization values in the progress bar panel', () => {
    // usage panel only renders for slots with an oauthAttachment
    // (the only ones with live usage data). Use an attached slot so the
    // panel surfaces.
    const slot = oauthSlot();
    const state: SlotState = {
      authState: 'healthy',
      activeLeases: [],
      usage: {
        fetchedAt: '2026-04-18T00:00:00Z',
        fiveHour: { utilization: 77, resetsAt: '2026-04-18T05:00:00Z' },
      },
    };
    const blocks = buildSlotRow(slot, state, true, Date.parse('2026-04-18T00:01:00Z'));
    const flat = JSON.stringify(blocks);
    // Pass-through path: 77 > 1 → rendered as 77%.
    expect(flat).toMatch(/77%/);
  });

  it('shows cooldown badge when still in future (#672 follow-up: option A — non-OAuth slot, generic Cooldown label)', () => {
    // setupSlot() has no oauthAttachment → non-OAuth path uses
    // computeManualCooldown + generic `Cooldown` label (no `5h` / `7d` prefix).
    const slot = setupSlot();
    const now = Date.parse('2026-04-18T03:42:00Z');
    const state: SlotState = {
      authState: 'healthy',
      activeLeases: [],
      cooldownUntil: '2026-04-18T04:42:00Z', // 1h ahead → yellow boundary
    };
    const blocks = buildSlotRow(slot, state, true, now, 'Asia/Seoul');
    const text = (blocks[0] as any).text.text as string;
    // New contract: option-A — color circle + `Cooldown <dur>` segment.
    // Manual cooldown does not carry the `5h` / `7d` source label.
    expect(text).toMatch(/:large_yellow_circle: Cooldown 1h 0m/);
    expect(text).not.toMatch(/cooldown until/);
    expect(text).not.toMatch(/via manual limit/);
  });

  // the OLD "inactive collapses to section + actions only" rule is
  // explicitly reversed: the user wants tier/5h/7d/rate-limited visible on
  // EVERY slot, not just the active one. This test locks the new contract:
  // inactive slots still carry the authState+rate-limited segments on their
  // section multi-line body. (Block budget is preserved via trimBlocksToSlackCap
  // in `buildCctCardBlocks`; the N=15 cap tests below still pass.)
  it('inactive slot DOES render rate-limited + Unavailable badge on its section body (non-OAuth path)', () => {
    // setupSlot() is non-OAuth (no oauthAttachment) → the buildSlotStatusLine
    // non-OAuth branch keeps `rate-limited` visible. authState='refresh_failed'
    // collapses to `Unavailable` per option A (PR #672 follow-up).
    const slot = setupSlot();
    const state: SlotState = {
      authState: 'refresh_failed',
      activeLeases: [],
      rateLimitedAt: '2026-04-18T03:37:00Z',
      usage: {
        fetchedAt: '2026-04-18T03:42:00Z',
        fiveHour: { utilization: 90, resetsAt: '2026-04-18T08:37:00Z' },
      },
    };
    const now = Date.parse('2026-04-18T03:42:00Z');
    const blocks = buildSlotRow(slot, state, false, now, 'Asia/Seoul');
    const section = blocks[0] as any;
    expect(section.type).toBe('section');
    const text = section.text.text as string;
    // Non-OAuth slot keeps the historical rate-limited segment.
    expect(text).toMatch(/rate-limited/);
    // refresh_failed → option-A `Unavailable` badge.
    expect(text).toContain(':black_circle: Unavailable');
    // The inactive row still skips the usage panel when there's no
    // oauthAttachment, so no progress-bar glyphs leak in.
    const flat = JSON.stringify(blocks);
    expect(flat).not.toMatch(/█/);
  });

  // the [Activate] button appears on every non-active slot that
  // can be activated (i.e. cct slots, not api_key). Lock the button shape
  // + styling + value so the actions.ts router keeps routing correctly.
  it('non-active cct slot gets [Activate] button with style=primary and value=cm:admin|keyId (#803)', () => {
    const slot = setupSlot('cct-foo', 'slot-foo');
    const blocks = buildSlotRow(slot, undefined, false, Date.parse('2026-04-21T00:00:00Z'));
    const actions = blocks.find((b: any) => b.type === 'actions') as any;
    const activateBtn = actions.elements.find((e: any) => e.action_id === CCT_ACTION_IDS.activate_slot);
    expect(activateBtn).toBeDefined();
    expect(activateBtn.style).toBe('primary');
    // #803 — button value is now `cm:<mode>|<payload>` so the action
    // dispatch can preserve the card mode across re-renders.
    expect(activateBtn.value).toBe('cm:admin|slot-foo');
  });

  it('active cct slot does NOT get [Activate] button (already active)', () => {
    const slot = setupSlot();
    const blocks = buildSlotRow(slot, undefined, true, Date.parse('2026-04-21T00:00:00Z'));
    const actions = blocks.find((b: any) => b.type === 'actions') as any;
    const activateBtn = actions.elements.find((e: any) => e.action_id === CCT_ACTION_IDS.activate_slot);
    expect(activateBtn).toBeUndefined();
  });

  it('OAuth expiry hint appears on attached slots and updates with time', () => {
    const nowMs = Date.parse('2026-04-21T00:00:00Z');
    const slot: AuthKey = {
      kind: 'cct',
      source: 'setup',
      keyId: 'slot-oauth',
      name: 'oauth-s',
      setupToken: 'sk-ant-oat01-x',
      oauthAttachment: {
        accessToken: 't',
        refreshToken: 'r',
        expiresAtMs: nowMs + 2 * 3_600_000 + 15 * 60_000, // 2h 15m ahead
        scopes: ['user:profile'],
        acknowledgedConsumerTosRisk: true,
      },
      createdAt: '',
    };
    const blocks = buildSlotRow(slot, undefined, false, nowMs);
    const section = blocks[0] as any;
    expect(section.text.text as string).toMatch(/OAuth refreshes in 2h 15m/);
    // Bare setup-token slots (no attachment) do NOT display an expiry hint.
    const bareSlot = setupSlot();
    const bareBlocks = buildSlotRow(bareSlot, undefined, false, nowMs);
    const bareSection = bareBlocks[0] as any;
    expect(bareSection.text.text as string).not.toMatch(/OAuth refreshes in/);
  });

  it('expired OAuth attachment surfaces :warning: expired (no negative durations)', () => {
    const nowMs = Date.parse('2026-04-21T00:00:00Z');
    const slot: AuthKey = {
      kind: 'cct',
      source: 'legacy-attachment',
      keyId: 'slot-exp',
      name: 'expired',
      oauthAttachment: {
        accessToken: 't',
        refreshToken: 'r',
        expiresAtMs: nowMs - 3_600_000, // 1h ago
        scopes: ['user:profile'],
        acknowledgedConsumerTosRisk: true,
      },
      createdAt: '',
    };
    const blocks = buildSlotRow(slot, undefined, false, nowMs);
    const section = blocks[0] as any;
    const text = section.text.text as string;
    expect(text).toContain(':warning: OAuth expired');
    expect(text).not.toMatch(/OAuth refreshes in -/); // no negative duration
  });

  it('emits per-slot Remove button with value = cm:admin|keyId (#803)', () => {
    const slot = setupSlot();
    const blocks = buildSlotRow(slot, undefined, false, Date.parse('2026-04-18T00:00:00Z'));
    // Last block should be the actions row with Remove. The per-slot
    // Rename button was removed in the card v2 follow-up.
    const actions = blocks.find((b: any) => b.type === 'actions') as any;
    expect(actions).toBeDefined();
    const removeBtn = actions.elements.find((e: any) => e.action_id === 'cct_open_remove');
    expect(removeBtn).toBeDefined();
    expect(removeBtn.value).toBe(`cm:admin|${slot.keyId}`);
    // Per-slot Rename no longer exists on the row.
    expect(actions.elements.find((e: any) => e.action_id === 'cct_open_rename')).toBeUndefined();
  });
});

describe('buildCctCardBlocks', () => {
  it('renders empty state when no slots configured', () => {
    const blocks = buildCctCardBlocks({ slots: [], states: {} });
    const anyBlock = blocks.find((b: any) => b.type === 'section') as any;
    expect(anyBlock.text.text).toMatch(/No CCT slots/);
    // Card-level action row (Next + Add) is always present. Remove lives on
    // each slot row now, so it is absent when no slots exist. Per-slot
    // Rename was removed entirely in the card v2 follow-up.
    const cardActions = blocks.find((b: any) => b.type === 'actions') as any;
    const actionIds = cardActions.elements.map((e: any) => e.action_id);
    expect(actionIds).toContain('cct_next');
    expect(actionIds).toContain('cct_open_add');
    expect(actionIds).not.toContain('cct_open_remove');
    expect(actionIds).not.toContain('cct_open_rename');
  });

  it('no set-active fallback dropdown is rendered regardless of slot count (card v2 follow-up)', () => {
    const slot = setupSlot();
    const slot2 = { ...setupSlot('cct2', 'slot-2') };
    const blocks = buildCctCardBlocks({ slots: [slot, slot2], states: {}, activeKeyId: 'slot-1' });
    const selectors = blocks.filter(
      (b: any) => b.type === 'actions' && b.elements.some((e: any) => e.type === 'static_select'),
    );
    expect(selectors.length).toBe(0);
  });

  it('each slot row carries a per-slot Remove button whose value is that keyId (no Rename; removed in card v2 follow-up)', () => {
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
    // #803 — button values are now `cm:admin|<keyId>`.
    expect(removeValues).toEqual(expect.arrayContaining(['cm:admin|slot-1', 'cm:admin|slot-2']));
    // No rename buttons anywhere on the card.
    const renameRows = blocks.filter(
      (b: any) => b.type === 'actions' && b.elements.some((e: any) => e.action_id === 'cct_open_rename'),
    );
    expect(renameRows).toHaveLength(0);
  });

  // ────────────────────────────────────────────────────────────────────
  // #803 — viewerMode='readonly' (non-admin reveal)
  // ────────────────────────────────────────────────────────────────────

  it('#803: viewerMode=readonly strips per-slot mutating actions but keeps slot rows', () => {
    const slot1 = setupSlot('cct1', 'slot-1');
    const slot2 = setupSlot('cct2', 'slot-2');
    const blocks = buildCctCardBlocks({
      slots: [slot1, slot2],
      states: {},
      activeKeyId: 'slot-1',
      viewerMode: 'readonly',
    });
    // Slot rows MUST still render — readonly viewer sees the same identity
    // line and status segments as admin (#803 spec Q3=A).
    const flat = JSON.stringify(blocks);
    expect(flat).toContain('cct1');
    expect(flat).toContain('cct2');
    // No per-slot Activate / Attach / Detach / Remove anywhere on the card.
    const allActionIds = blocks
      .filter((b: any) => b.type === 'actions')
      .flatMap((b: any) => b.elements.map((e: any) => e.action_id));
    expect(allActionIds).not.toContain(CCT_ACTION_IDS.activate_slot);
    expect(allActionIds).not.toContain(CCT_ACTION_IDS.attach);
    expect(allActionIds).not.toContain(CCT_ACTION_IDS.detach);
    expect(allActionIds).not.toContain(CCT_ACTION_IDS.remove);
  });

  it('#803: viewerMode=readonly omits per-slot empty actions block (no zero-element actions row)', () => {
    const slot = setupSlot('cct1', 'slot-1');
    const blocks = buildCctCardBlocks({
      slots: [slot],
      states: {},
      activeKeyId: 'slot-1',
      viewerMode: 'readonly',
    });
    // Slack rejects an `actions` block with zero elements. The readonly
    // path must SKIP the per-slot actions block entirely instead of
    // emitting an empty one. Only the card-level Refresh actions block
    // should remain after the slot row + divider.
    const allActions = blocks.filter((b: any) => b.type === 'actions');
    for (const a of allActions) {
      expect((a as any).elements.length).toBeGreaterThan(0);
    }
    // Exactly ONE actions block on the card (card-level Refresh only).
    expect(allActions.length).toBe(1);
  });

  it('#803: viewerMode=readonly card-level row is Refresh only (no Add/Next/RefreshAll)', () => {
    const slot = setupSlot('cct1', 'slot-1');
    const blocks = buildCctCardBlocks({
      slots: [slot],
      states: {},
      activeKeyId: 'slot-1',
      viewerMode: 'readonly',
    });
    const allActions = blocks.filter((b: any) => b.type === 'actions');
    const lastRow = allActions[allActions.length - 1] as any;
    const ids = lastRow.elements.map((e: any) => e.action_id);
    expect(ids).toEqual([CCT_ACTION_IDS.refresh_card]);
    // The card-level Refresh button carries the readonly mode in its
    // value so the action handler can preserve the card mode + force
    // gate on re-render.
    expect(lastRow.elements[0].value).toBe('cm:readonly|refresh_card');
  });

  it('#803: viewerMode=readonly empty-state copy switches from "Click *Add*" to "(no slots cached)"', () => {
    const blocks = buildCctCardBlocks({ slots: [], states: {}, viewerMode: 'readonly' });
    const flat = JSON.stringify(blocks);
    expect(flat).toContain('(no slots cached)');
    expect(flat).not.toMatch(/Click \*Add\*/);
    // Even in the empty case, the readonly card-level row is Refresh only.
    const allActions = blocks.filter((b: any) => b.type === 'actions') as any[];
    expect(allActions).toHaveLength(1);
    expect(allActions[0].elements.map((e: any) => e.action_id)).toEqual([CCT_ACTION_IDS.refresh_card]);
  });

  it('#803: viewerMode=admin stamps cm:admin| on every per-slot AND card-level button value', () => {
    const slot = setupSlot('cct1', 'slot-1');
    const blocks = buildCctCardBlocks({
      slots: [slot],
      states: {},
      activeKeyId: undefined,
      viewerMode: 'admin',
    });
    const allButtons = blocks
      .filter((b: any) => b.type === 'actions')
      .flatMap((b: any) => b.elements.filter((e: any) => e.type === 'button'));
    for (const btn of allButtons) {
      expect(btn.value).toMatch(/^cm:admin\|/);
    }
  });

  it('#803: usage panel still renders for attached slots in viewerMode=readonly', () => {
    const slot: AuthKey = {
      kind: 'cct',
      source: 'setup',
      keyId: 'slot-1',
      name: 'cct1',
      setupToken: 'sk-ant-oat01-x',
      oauthAttachment: {
        accessToken: 't',
        refreshToken: 'r',
        expiresAtMs: Date.parse('2026-12-31T00:00:00Z'),
        scopes: ['user:profile'],
        acknowledgedConsumerTosRisk: true,
      },
      createdAt: '',
    };
    const states: Record<string, any> = {
      'slot-1': {
        authState: 'healthy',
        activeLeases: [],
        usage: {
          fetchedAt: '2026-04-21T00:00:00Z',
          fiveHour: { utilization: 50, resetsAt: '2026-04-21T03:00:00Z' },
          sevenDay: { utilization: 20, resetsAt: '2026-04-28T00:00:00Z' },
        },
      },
    };
    const blocks = buildCctCardBlocks({
      slots: [slot],
      states,
      activeKeyId: 'slot-1',
      nowMs: Date.parse('2026-04-21T00:00:00Z'),
      viewerMode: 'readonly',
    });
    // Usage progress glyph must still be present so non-admin sees usage.
    const flat = JSON.stringify(blocks);
    expect(flat).toMatch(/█/);
    expect(flat).toMatch(/5h/);
    expect(flat).toMatch(/7d/);
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
    // #803 — button value is now `cm:admin|<keyId>`.
    expect(attachBtn.value).toBe('cm:admin|slot-bare');
  });

  it('T7c-ii: setup-source cct slot with attachment gets Detach OAuth button', () => {
    const slot = setupSlotWithAttachment();
    const blocks = buildSlotRow(slot, undefined, false, now);
    const actions = blocks.find((b: any) => b.type === 'actions') as any;
    const ids = actions.elements.map((e: any) => e.action_id);
    expect(ids).toContain(CCT_ACTION_IDS.detach);
    expect(ids).not.toContain(CCT_ACTION_IDS.attach);
    const detachBtn = actions.elements.find((e: any) => e.action_id === CCT_ACTION_IDS.detach);
    // #803 — button value is now `cm:admin|<keyId>`.
    expect(detachBtn.value).toBe('cm:admin|slot-attached');
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

  it('renders a left-padded label + utilization bar + percent + remaining bar + "resets in" hint', () => {
    const iso = new Date(now + 2 * 3_600_000 + 15 * 60_000).toISOString();
    // #701 — utilization is now percent-only; `82` means 82%.
    const out = formatUsageBar(82, iso, now, '5h');
    // Padded label, filled util blocks, percent, remaining bar, `resets in` hint.
    // Structure: `5h {utilBar} 82% · {remainingBar} resets in 2h 15m`
    expect(out).toMatch(/^5h\s+[█░]+\s+82% · [█░]+ resets in 2h 15m$/);
  });

  it('renders a stable "(no data)" form when util is undefined', () => {
    const out = formatUsageBar(undefined, undefined, now, '7d');
    expect(out.startsWith('7d')).toBe(true);
    expect(out).toContain('(no data)');
  });

  it('accepts the 0..100 utilization form (pass-through, not *100)', () => {
    const iso = new Date(now + 86_400_000).toISOString();
    const out = formatUsageBar(77, iso, now, '7d-sonnet');
    expect(out).toMatch(/77%/);
  });

  // #701 — percent-only boundary locks. Every row here documents the fix
  // for the pre-#701 dual-form regression where `utilization: 1` rendered
  // as `100%` and tripped the 7d Cooldown badge.
  describe('#701: utilToPctInt percent-only boundary', () => {
    const iso = new Date(now + 3_600_000).toISOString();
    const rows: Array<[number, number]> = [
      [0, 0],
      [0.5, 1], // rounds up
      [1, 1], // THE #701 fix — not 100
      [1.4, 1],
      [1.5, 2], // rounds up
      [2, 2],
      [50, 50],
      [99, 99],
      [99.49, 99],
      [99.5, 100],
      [100, 100],
      [105, 100], // clamp
      [-5, 0], // clamp
    ];
    for (const [input, expected] of rows) {
      it(`utilToPctInt(${input}) → ${expected}%`, () => {
        const out = formatUsageBar(input, iso, now, '5h');
        // Fixed width bar; check the percent segment explicitly.
        expect(out).toMatch(new RegExp(`\\s${expected}%\\s`));
      });
    }
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
        fiveHour: { utilization: 80, resetsAt: new Date(now + 2 * 3_600_000).toISOString() },
        sevenDay: { utilization: 28, resetsAt: new Date(now + 3 * 86_400_000).toISOString() },
        sevenDaySonnet: { utilization: 18, resetsAt: new Date(now + 3 * 86_400_000).toISOString() },
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
        fiveHour: { utilization: 50, resetsAt: new Date(now + 3_600_000).toISOString() },
        sevenDay: { utilization: 20, resetsAt: new Date(now + 86_400_000).toISOString() },
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
          fiveHour: { utilization: 45, resetsAt: new Date(now + 3 * 3_600_000).toISOString() },
          sevenDay: { utilization: 20, resetsAt: new Date(now + 6 * 86_400_000).toISOString() },
          sevenDaySonnet: { utilization: 10, resetsAt: new Date(now + 6 * 86_400_000).toISOString() },
        },
      };
    }
    return buildCctCardBlocks({ slots, states, activeKeyId: 'slot-0', nowMs: now });
  }

  // N=15 is the design ceiling: 14 inactive-compact + 1 active-expanded +
  // header/context/actions sits just under Slack's hard 50-block cap.
  // Re-expanding inactive slots would overflow and Slack rejects the whole
  // blocks array. Keep N=15 as the tripwire.
  it.each([1, 7, 10, 15])('N=%d attached slots → block count ≤ 50 (with slot-0 active)', (n) => {
    const blocks = buildNSlotCard(n);
    expect(blocks.length).toBeLessThanOrEqual(50);
  });

  // Overflow guard identifies usage panels by stable `block_id` prefix,
  // not by text content. Lock the contract so a future card-format
  // tweak (e.g. dropping the code fence) doesn't silently break the
  // overflow guard.
  it('usage panels carry the stable `cct_usage_panel:` block_id prefix', () => {
    const blocks = buildNSlotCard(3);
    const usagePanels = blocks.filter(
      (b) =>
        (b as { type?: string }).type === 'context' &&
        typeof (b as { block_id?: string }).block_id === 'string' &&
        ((b as { block_id: string }).block_id as string).startsWith('cct_usage_panel:'),
    );
    expect(usagePanels.length).toBe(3);
    // Each panel's block_id ends with the slot keyId — proves uniqueness.
    const suffixes = usagePanels.map((b) => (b as { block_id: string }).block_id.split(':')[1]);
    expect(new Set(suffixes).size).toBe(3);
  });
});

// ────────────────────────────────────────────────────────────────────
// M1-S3 · subscriptionBadge helper
// ────────────────────────────────────────────────────────────────────

describe('subscriptionBadge (M1-S3)', () => {
  it('formats max_5x → " · Max 5×"', () => {
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
    expect(subscriptionBadge(slot)).toBe(' · Max 5×');
  });

  it('formats max_20x → " · Max 20×"', () => {
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
    expect(subscriptionBadge(slot)).toBe(' · Max 20×');
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

// ────────────────────────────────────────────────────────────────────
// #644 review — CCT_ACTION_IDS / CCT_BLOCK_IDS literal-string contract lock
// ────────────────────────────────────────────────────────────────────
//
// These IDs are the wire contract between the Slack view-state snapshot and
// the Bolt block_actions router. A silent rename breaks every deployed
// tenant's in-flight modal state (`views.update` loses typed values) and
// mis-routes refresh clicks to unhandled handlers. Every new ID (including
// M1-S4 `cct_refresh_usage_all` + card-v2 follow-up `cct_refresh_card`) is
// locked here so a future append-only change is intentional, not silent.
describe('CCT_ACTION_IDS / CCT_BLOCK_IDS literal lock (#644 review)', () => {
  it('CCT_ACTION_IDS maps each key to its exact wire string', () => {
    expect(CCT_ACTION_IDS).toEqual({
      next: 'cct_next',
      add: 'cct_open_add',
      remove: 'cct_open_remove',
      tos_ack: 'cct_tos_ack',
      kind_radio: 'cct_kind_radio',
      name_input: 'cct_name_value',
      setup_token_input: 'cct_setup_token_value',
      oauth_blob_input: 'cct_oauth_blob_value',
      api_key_input: 'cct_api_key_value',
      remove_private_metadata: 'cct_remove_slot_id',
      attach: 'cct_open_attach',
      detach: 'cct_detach',
      attach_oauth_input: 'cct_attach_oauth_blob_value',
      attach_tos_ack: 'cct_attach_tos_ack_value',
      refresh_usage_all: 'cct_refresh_usage_all',
      refresh_card: 'cct_refresh_card',
      activate_slot: 'cct_activate_slot',
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
      attach_oauth_blob: 'cct_attach_oauth_blob',
      attach_tos_ack: 'cct_attach_tos_ack',
    });
  });

  it('CCT_VIEW_IDS maps each key to its exact wire string', () => {
    expect(CCT_VIEW_IDS).toEqual({
      add: 'cct_add_slot',
      remove: 'cct_remove_slot',
      attach: 'cct_attach_oauth',
    });
  });
});

describe('buildCctCardBlocks — card-level action row', () => {
  it('card-level action row contains Next/Add/Refresh-All-OAuth/Refresh in order (4 buttons)', () => {
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
    expect(ids).toEqual([
      CCT_ACTION_IDS.next,
      CCT_ACTION_IDS.add,
      CCT_ACTION_IDS.refresh_usage_all,
      CCT_ACTION_IDS.refresh_card,
    ]);
    // Length assertion: exactly four buttons in the card-level row.
    expect(cardRow.elements).toHaveLength(4);
  });

  it('the Refresh All OAuth Tokens button carries the updated label', () => {
    const slot: AuthKey = {
      kind: 'cct',
      source: 'setup',
      keyId: 'slot-1',
      name: 'cct1',
      setupToken: 'sk-ant-oat01-xxxx',
      createdAt: '',
    };
    const blocks = buildCctCardBlocks({ slots: [slot], states: {} });
    const cardRow = blocks.find(
      (b: any) => b.type === 'actions' && b.elements.some((e: any) => e.action_id === 'cct_refresh_usage_all'),
    ) as any;
    const btn = cardRow.elements.find((e: any) => e.action_id === 'cct_refresh_usage_all');
    expect(btn.text.text).toBe(':arrows_counterclockwise: Refresh All OAuth Tokens');
  });
});

// ────────────────────────────────────────────────────────────────────
// PR #672 follow-up · authStateBadge + buildSlotStatusLine option A
// ────────────────────────────────────────────────────────────────────

describe('authStateBadge + buildSlotStatusLine — option A (PR #672 follow-up)', () => {
  const now = Date.parse('2026-04-22T00:00:00Z');
  const HOUR = 3_600_000;

  /** OAuth-attached cct slot factory (oauthAttachment set, expiresAtMs ~7h ahead). */
  function oauthAttachedSlot(overrides: Partial<AuthKey> = {}): AuthKey {
    return {
      kind: 'cct',
      source: 'setup',
      keyId: 'slot-oauth',
      name: 'cct-oauth',
      setupToken: 'sk-ant-oat01-xxxx',
      oauthAttachment: {
        accessToken: 't',
        refreshToken: 'r',
        // 7h 18m ahead so the OAuth-refresh hint is not zero/expired.
        expiresAtMs: now + 7 * HOUR + 18 * 60_000,
        scopes: ['user:profile'],
        acknowledgedConsumerTosRisk: true,
      },
      createdAt: '',
      ...overrides,
    } as AuthKey;
  }

  /** Non-OAuth setup-only cct slot factory (no oauthAttachment). */
  function bareSetupSlot(overrides: Partial<AuthKey> = {}): AuthKey {
    return {
      kind: 'cct',
      source: 'setup',
      keyId: 'slot-bare',
      name: 'cct-bare',
      setupToken: 'sk-ant-oat01-xxxx',
      createdAt: '',
      ...overrides,
    } as AuthKey;
  }

  function statusText(slot: AuthKey, state: SlotState | undefined, isActive = true): string {
    const blocks = buildSlotRow(slot, state, isActive, now, 'Asia/Seoul');
    const section = blocks[0] as any;
    const lines = (section.text.text as string).split('\n');
    // Line 2 holds the status segments per buildSlotRow layout.
    return lines[1] ?? '';
  }

  // ── OAuth slots ────────────────────────────────────────────────────

  it('OAuth healthy (5h util=0.5, 7d util=0.5) → green Healthy + OAuth refresh hint only', () => {
    const slot = oauthAttachedSlot();
    const state: SlotState = {
      authState: 'healthy',
      activeLeases: [],
      usage: {
        fetchedAt: new Date(now).toISOString(),
        fiveHour: { utilization: 50, resetsAt: new Date(now + 2 * HOUR).toISOString() },
        sevenDay: { utilization: 50, resetsAt: new Date(now + 3 * 86_400_000).toISOString() },
      },
    };
    const text = statusText(slot, state);
    expect(text).toContain(':large_green_circle: Healthy');
    expect(text).toContain('OAuth refreshes in 7h 18m');
    // No cooldown noise.
    expect(text).not.toMatch(/Cooldown/);
  });

  it('OAuth 5h util=1.0, fiveHour.resetsAt = now + 30m → yellow 5h Cooldown 30m', () => {
    const slot = oauthAttachedSlot();
    const state: SlotState = {
      authState: 'healthy',
      activeLeases: [],
      usage: {
        fetchedAt: new Date(now).toISOString(),
        fiveHour: { utilization: 100, resetsAt: new Date(now + 30 * 60_000).toISOString() },
      },
    };
    const text = statusText(slot, state);
    expect(text).toContain(':large_yellow_circle: 5h Cooldown 30m');
  });

  it('OAuth 5h util=1.0, fiveHour.resetsAt = now + 3h → orange 5h Cooldown 3h 0m', () => {
    const slot = oauthAttachedSlot();
    const state: SlotState = {
      authState: 'healthy',
      activeLeases: [],
      usage: {
        fetchedAt: new Date(now).toISOString(),
        fiveHour: { utilization: 100, resetsAt: new Date(now + 3 * HOUR).toISOString() },
      },
    };
    const text = statusText(slot, state);
    expect(text).toContain(':large_orange_circle: 5h Cooldown 3h 0m');
  });

  it('OAuth boundary: 5h util=1.0, resetsAt = now + 1h exact → yellow (≤1h inclusive)', () => {
    const slot = oauthAttachedSlot();
    const state: SlotState = {
      authState: 'healthy',
      activeLeases: [],
      usage: {
        fetchedAt: new Date(now).toISOString(),
        fiveHour: { utilization: 100, resetsAt: new Date(now + HOUR).toISOString() },
      },
    };
    const text = statusText(slot, state);
    expect(text).toContain(':large_yellow_circle:');
    expect(text).not.toContain(':large_orange_circle:');
  });

  it('OAuth boundary: 5h util=1.0, resetsAt = now + 5h exact → orange (≤5h inclusive)', () => {
    const slot = oauthAttachedSlot();
    const state: SlotState = {
      authState: 'healthy',
      activeLeases: [],
      usage: {
        fetchedAt: new Date(now).toISOString(),
        fiveHour: { utilization: 100, resetsAt: new Date(now + 5 * HOUR).toISOString() },
      },
    };
    const text = statusText(slot, state);
    expect(text).toContain(':large_orange_circle:');
    expect(text).not.toContain(':large_purple_circle:');
  });

  it('OAuth 7d util=1.0, sevenDay.resetsAt = now + 12h → purple 7d Cooldown 12h 0m', () => {
    const slot = oauthAttachedSlot();
    const state: SlotState = {
      authState: 'healthy',
      activeLeases: [],
      usage: {
        fetchedAt: new Date(now).toISOString(),
        sevenDay: { utilization: 100, resetsAt: new Date(now + 12 * HOUR).toISOString() },
      },
    };
    const text = statusText(slot, state);
    expect(text).toContain(':large_purple_circle: 7d Cooldown 12h 0m');
  });

  it('OAuth boundary: 7d resetsAt = now + 24h exact → purple (≤24h inclusive)', () => {
    const slot = oauthAttachedSlot();
    const state: SlotState = {
      authState: 'healthy',
      activeLeases: [],
      usage: {
        fetchedAt: new Date(now).toISOString(),
        sevenDay: { utilization: 100, resetsAt: new Date(now + 24 * HOUR).toISOString() },
      },
    };
    const text = statusText(slot, state);
    expect(text).toContain(':large_purple_circle:');
    expect(text).not.toContain(':red_circle:');
  });

  it('OAuth boundary: 7d resetsAt = now + 24h + 1ms → red (>24h)', () => {
    const slot = oauthAttachedSlot();
    const state: SlotState = {
      authState: 'healthy',
      activeLeases: [],
      usage: {
        fetchedAt: new Date(now).toISOString(),
        sevenDay: { utilization: 100, resetsAt: new Date(now + 24 * HOUR + 1).toISOString() },
      },
    };
    const text = statusText(slot, state);
    expect(text).toContain(':red_circle:');
    expect(text).not.toContain(':large_purple_circle:');
  });

  it('OAuth 7d util=1.0, sevenDay.resetsAt = now + 2d → red 7d Cooldown 2d 0h', () => {
    const slot = oauthAttachedSlot();
    const state: SlotState = {
      authState: 'healthy',
      activeLeases: [],
      usage: {
        fetchedAt: new Date(now).toISOString(),
        sevenDay: { utilization: 100, resetsAt: new Date(now + 2 * 86_400_000).toISOString() },
      },
    };
    const text = statusText(slot, state);
    expect(text).toContain(':red_circle: 7d Cooldown 2d 0h');
  });

  it('OAuth priority: 7d util=1 + 5h util=1 simultaneously → 7d wins', () => {
    const slot = oauthAttachedSlot();
    const state: SlotState = {
      authState: 'healthy',
      activeLeases: [],
      usage: {
        fetchedAt: new Date(now).toISOString(),
        fiveHour: { utilization: 100, resetsAt: new Date(now + 30 * 60_000).toISOString() },
        sevenDay: { utilization: 100, resetsAt: new Date(now + 12 * HOUR).toISOString() },
      },
    };
    const text = statusText(slot, state);
    expect(text).toContain('7d Cooldown');
    expect(text).not.toContain('5h Cooldown');
  });

  it('OAuth authState=refresh_failed → :black_circle: Unavailable · :warning: OAuth refresh failed (D fallback, no refresh hint)', () => {
    const slot = oauthAttachedSlot();
    const state: SlotState = {
      authState: 'refresh_failed',
      activeLeases: [],
    };
    const text = statusText(slot, state);
    // #723 +D: without lastRefreshError diagnostic, fall back to a canned reason.
    expect(text).toBe(':black_circle: Unavailable · :warning: OAuth refresh failed');
    // Hint suppressed for non-healthy OAuth slots — TO-BE-3 SSOT lock.
    expect(text).not.toContain('OAuth refreshes in');
  });

  it('OAuth authState=revoked → :black_circle: Unavailable · :warning: OAuth revoked (D fallback, no refresh hint)', () => {
    const slot = oauthAttachedSlot();
    const state: SlotState = {
      authState: 'revoked',
      activeLeases: [],
    };
    const text = statusText(slot, state);
    expect(text).toBe(':black_circle: Unavailable · :warning: OAuth revoked');
    expect(text).not.toContain('OAuth refreshes in');
  });

  it('OAuth utilization === 1.0 exactly → cooldown fires (≥1)', () => {
    const slot = oauthAttachedSlot();
    const state: SlotState = {
      authState: 'healthy',
      activeLeases: [],
      usage: {
        fetchedAt: new Date(now).toISOString(),
        fiveHour: { utilization: 100, resetsAt: new Date(now + 30 * 60_000).toISOString() },
      },
    };
    const text = statusText(slot, state);
    expect(text).toContain('5h Cooldown');
  });

  it('OAuth utilization === 0.999 → still Healthy (cooldown not triggered)', () => {
    const slot = oauthAttachedSlot();
    const state: SlotState = {
      authState: 'healthy',
      activeLeases: [],
      usage: {
        fetchedAt: new Date(now).toISOString(),
        fiveHour: { utilization: 99.9, resetsAt: new Date(now + 30 * 60_000).toISOString() },
      },
    };
    const text = statusText(slot, state);
    expect(text).toContain(':large_green_circle: Healthy');
    expect(text).not.toMatch(/Cooldown/);
  });

  it('OAuth utilization === 1.5 → cooldown fires (≥1 catches over-budget too)', () => {
    const slot = oauthAttachedSlot();
    const state: SlotState = {
      authState: 'healthy',
      activeLeases: [],
      usage: {
        fetchedAt: new Date(now).toISOString(),
        fiveHour: { utilization: 100, resetsAt: new Date(now + 30 * 60_000).toISOString() },
      },
    };
    const text = statusText(slot, state);
    expect(text).toContain('5h Cooldown');
  });

  it('OAuth invalid resetsAt (NaN) → cooldown still triggers, remaining clamps to 0 (<1m)', () => {
    const slot = oauthAttachedSlot();
    const state: SlotState = {
      authState: 'healthy',
      activeLeases: [],
      usage: {
        fetchedAt: new Date(now).toISOString(),
        fiveHour: { utilization: 100, resetsAt: 'not-a-valid-iso' },
      },
    };
    const text = statusText(slot, state);
    expect(text).toContain('5h Cooldown <1m');
    // 0ms remaining ≤ 1h → yellow.
    expect(text).toContain(':large_yellow_circle:');
  });

  it('OAuth past resetsAt (now - 1h) → cooldown clamped to 0 (<1m), yellow', () => {
    const slot = oauthAttachedSlot();
    const state: SlotState = {
      authState: 'healthy',
      activeLeases: [],
      usage: {
        fetchedAt: new Date(now).toISOString(),
        fiveHour: { utilization: 100, resetsAt: new Date(now - HOUR).toISOString() },
      },
    };
    const text = statusText(slot, state);
    expect(text).toContain('5h Cooldown <1m');
    expect(text).toContain(':large_yellow_circle:');
  });

  // ── #684 regression: 0..100 percent form (real Anthropic API response) ──
  //
  // `/api/oauth/usage` returns utilization as an integer percent (0..100).
  // The pre-fix `>= 1` check classified any non-zero usage (≥1%) as full,
  // so every healthy OAuth slot rendered as "7d Cooldown" in the CCT card
  // — see PR #684 screenshot (notify 19/63, info 2/94, ai 54/79 all
  // wrongly badged as Cooldown). The fix applies the same `> 1.5`
  // disambiguation used by `parsePercent` in `src/oauth/header-parser.ts`.

  it('#684: OAuth utilization=19 (percent form, 5h=19%) → Healthy, not Cooldown', () => {
    const slot = oauthAttachedSlot();
    const state: SlotState = {
      authState: 'healthy',
      activeLeases: [],
      usage: {
        fetchedAt: new Date(now).toISOString(),
        fiveHour: { utilization: 19, resetsAt: new Date(now + HOUR).toISOString() },
        sevenDay: { utilization: 63, resetsAt: new Date(now + 15 * HOUR).toISOString() },
      },
    };
    const text = statusText(slot, state);
    expect(text).toContain(':large_green_circle: Healthy');
    expect(text).not.toMatch(/Cooldown/);
  });

  it('#684: OAuth utilization=94 (7d=94%, well under full) → Healthy, not 7d Cooldown', () => {
    const slot = oauthAttachedSlot();
    const state: SlotState = {
      authState: 'healthy',
      activeLeases: [],
      usage: {
        fetchedAt: new Date(now).toISOString(),
        fiveHour: { utilization: 2, resetsAt: new Date(now + 4 * HOUR).toISOString() },
        sevenDay: { utilization: 94, resetsAt: new Date(now + 24 * HOUR).toISOString() },
      },
    };
    const text = statusText(slot, state);
    expect(text).toContain(':large_green_circle: Healthy');
    expect(text).not.toMatch(/Cooldown/);
  });

  it('#684: OAuth utilization=100 (percent form, exactly full) → 7d Cooldown', () => {
    const slot = oauthAttachedSlot();
    const state: SlotState = {
      authState: 'healthy',
      activeLeases: [],
      usage: {
        fetchedAt: new Date(now).toISOString(),
        sevenDay: { utilization: 100, resetsAt: new Date(now + 16 * HOUR).toISOString() },
      },
    };
    const text = statusText(slot, state);
    expect(text).toContain('7d Cooldown');
  });

  it('#684: OAuth utilization=150 (percent form, over-budget) → 5h Cooldown', () => {
    const slot = oauthAttachedSlot();
    const state: SlotState = {
      authState: 'healthy',
      activeLeases: [],
      usage: {
        fetchedAt: new Date(now).toISOString(),
        fiveHour: { utilization: 150, resetsAt: new Date(now + 30 * 60_000).toISOString() },
      },
    };
    const text = statusText(slot, state);
    expect(text).toContain('5h Cooldown');
  });

  it('#701: OAuth utilization=1 is percent-form 1% (NOT full — does not trigger Cooldown)', () => {
    // The #684 dual-form split treated `util=1` as fraction-form 1.0 =
    // full, which misrendered real account data: Anthropic's usage API
    // sends integer percents, so `seven_day.utilization = 1` means 1%.
    // #701 drops the dual-form entirely; the card now correctly renders
    // Healthy + 1% instead of 7d Cooldown + 100%.
    const slot = oauthAttachedSlot();
    const state: SlotState = {
      authState: 'healthy',
      activeLeases: [],
      usage: {
        fetchedAt: new Date(now).toISOString(),
        fiveHour: { utilization: 1, resetsAt: new Date(now + 30 * 60_000).toISOString() },
      },
    };
    const text = statusText(slot, state);
    expect(text).toContain(':large_green_circle: Healthy');
    expect(text).not.toContain('Cooldown');
  });

  // ── Regression locks: OAuth slots HIDE all operator signals ────────

  it('regression: OAuth slot hides `rate-limited` even when state.rateLimitedAt is set', () => {
    const slot = oauthAttachedSlot();
    const state: SlotState = {
      authState: 'healthy',
      activeLeases: [],
      rateLimitedAt: new Date(now - 60_000).toISOString(),
      rateLimitSource: 'response_header',
    };
    const text = statusText(slot, state);
    expect(text).not.toMatch(/rate-limited/);
  });

  it('regression: OAuth slot hides `tombstoned` segment', () => {
    const slot = oauthAttachedSlot();
    const state: SlotState = {
      authState: 'healthy',
      activeLeases: [],
      tombstoned: true,
    };
    const text = statusText(slot, state);
    expect(text).not.toMatch(/tombstoned/);
  });

  it('regression: OAuth slot hides `:lock: rotation-off` even when slot.disableRotation=true', () => {
    const slot = oauthAttachedSlot({ disableRotation: true } as Partial<AuthKey>);
    const state: SlotState = { authState: 'healthy', activeLeases: [] };
    const text = statusText(slot, state);
    expect(text).not.toMatch(/rotation-off/);
  });

  it('regression: OAuth slot hides `leases:` segment', () => {
    const slot = oauthAttachedSlot();
    const mkLease = (id: string) => ({
      leaseId: id,
      ownerTag: 'test',
      acquiredAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 15 * 60_000).toISOString(),
    });
    const state: SlotState = {
      authState: 'healthy',
      activeLeases: [mkLease('lease-1'), mkLease('lease-2'), mkLease('lease-3')],
    };
    const text = statusText(slot, state);
    expect(text).not.toMatch(/leases:/);
  });

  it('regression: OAuth slot hides ` · active` segment when isActive=true', () => {
    const slot = oauthAttachedSlot();
    const state: SlotState = { authState: 'healthy', activeLeases: [] };
    const text = statusText(slot, state, /* isActive */ true);
    // The line-2 status MUST NOT include the `active` operator marker for
    // OAuth slots (option A — utilization snapshot is the SSOT).
    expect(text).not.toMatch(/(^|\s·\s)active(\s|$)/);
  });

  // ── Non-OAuth slots ────────────────────────────────────────────────

  it('non-OAuth cooldownUntil = now + 30m → yellow Cooldown 30m', () => {
    const slot = bareSetupSlot();
    const state: SlotState = {
      authState: 'healthy',
      activeLeases: [],
      cooldownUntil: new Date(now + 30 * 60_000).toISOString(),
    };
    const text = statusText(slot, state);
    expect(text).toContain(':large_yellow_circle: Cooldown 30m');
  });

  it('non-OAuth cooldownUntil = now + 3h → orange Cooldown 3h 0m', () => {
    const slot = bareSetupSlot();
    const state: SlotState = {
      authState: 'healthy',
      activeLeases: [],
      cooldownUntil: new Date(now + 3 * HOUR).toISOString(),
    };
    const text = statusText(slot, state);
    expect(text).toContain(':large_orange_circle: Cooldown 3h 0m');
  });

  it('non-OAuth cooldownUntil in the past → green Healthy (manual cooldown expired)', () => {
    const slot = bareSetupSlot();
    const state: SlotState = {
      authState: 'healthy',
      activeLeases: [],
      cooldownUntil: new Date(now - HOUR).toISOString(),
    };
    const text = statusText(slot, state);
    expect(text).toContain(':large_green_circle: Healthy');
    expect(text).not.toMatch(/Cooldown/);
  });

  it('non-OAuth manual cooldown label is generic — never carries `5h` / `7d` prefix', () => {
    const slot = bareSetupSlot();
    const state: SlotState = {
      authState: 'healthy',
      activeLeases: [],
      cooldownUntil: new Date(now + 2 * HOUR).toISOString(),
    };
    const text = statusText(slot, state);
    expect(text).toMatch(/Cooldown/);
    expect(text).not.toMatch(/5h Cooldown/);
    expect(text).not.toMatch(/7d Cooldown/);
  });

  it('non-OAuth without cooldownUntil but with rateLimitedAt → Healthy + rate-limited preserved', () => {
    const slot = bareSetupSlot();
    const state: SlotState = {
      authState: 'healthy',
      activeLeases: [],
      rateLimitedAt: new Date(now - 60_000).toISOString(),
      rateLimitSource: 'response_header',
    };
    const text = statusText(slot, state, false);
    expect(text).toContain(':large_green_circle: Healthy');
    expect(text).toMatch(/rate-limited .* via response_header/);
  });

  it('non-OAuth regression: `active` segment preserved for active slots', () => {
    const slot = bareSetupSlot();
    const text = statusText(slot, { authState: 'healthy', activeLeases: [] }, true);
    expect(text).toContain(' · active');
  });

  it('non-OAuth regression: `:lock: rotation-off` preserved when disableRotation=true', () => {
    const slot = bareSetupSlot({ disableRotation: true } as Partial<AuthKey>);
    const text = statusText(slot, { authState: 'healthy', activeLeases: [] }, false);
    expect(text).toContain(':lock: rotation-off');
  });

  it('non-OAuth regression: `tombstoned` segment preserved', () => {
    const slot = bareSetupSlot();
    const state: SlotState = { authState: 'healthy', activeLeases: [], tombstoned: true };
    const text = statusText(slot, state);
    expect(text).toMatch(/tombstoned/);
  });

  it('non-OAuth regression: `leases: N` preserved when activeLeases.length > 0', () => {
    const slot = bareSetupSlot();
    const mkLease = (id: string) => ({
      leaseId: id,
      ownerTag: 'test',
      acquiredAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 15 * 60_000).toISOString(),
    });
    const state: SlotState = {
      authState: 'healthy',
      activeLeases: [mkLease('l1'), mkLease('l2')],
    };
    const text = statusText(slot, state);
    expect(text).toContain('leases: 2');
  });
});

// ────────────────────────────────────────────────────────────────────
// Codex P1 follow-up (#679) · OAuth slot cooldownUntil priority
//
// Background: TokenManager.isEligible / rotateOnRateLimit /
// recordRateLimitHint still honor `state.cooldownUntil` (set on SDK 429)
// even for OAuth slots, but the option-A card was utilization-only —
// so an SDK-429'd OAuth slot rendered Healthy while the picker rejected
// it. We now honor cooldownUntil in the OAuth path too, slotted between
// utilization-driven cooldown and the healthy fallback. Priority order:
//   7d util≥1 > 5h util≥1 > cooldownUntil(future) > healthy
// Manual source label stays generic ("Cooldown <dur>") because the SDK
// 429 doesn't disclose which window triggered it.
// ────────────────────────────────────────────────────────────────────

describe('Codex P1 follow-up (#679): OAuth cooldownUntil priority', () => {
  const now = Date.parse('2026-04-22T00:00:00Z');
  const HOUR = 3_600_000;

  function oauthAttachedSlot(overrides: Partial<AuthKey> = {}): AuthKey {
    return {
      kind: 'cct',
      source: 'setup',
      keyId: 'slot-oauth',
      name: 'cct-oauth',
      setupToken: 'sk-ant-oat01-xxxx',
      oauthAttachment: {
        accessToken: 't',
        refreshToken: 'r',
        expiresAtMs: now + 7 * HOUR + 18 * 60_000,
        scopes: ['user:profile'],
        acknowledgedConsumerTosRisk: true,
      },
      createdAt: '',
      ...overrides,
    } as AuthKey;
  }

  function statusText(slot: AuthKey, state: SlotState | undefined, isActive = true): string {
    const blocks = buildSlotRow(slot, state, isActive, now, 'Asia/Seoul');
    const section = blocks[0] as any;
    const lines = (section.text.text as string).split('\n');
    return lines[1] ?? '';
  }

  it('OAuth + cooldownUntil = now + 30m, no utilization → yellow Cooldown 30m + OAuth refresh hint', () => {
    const slot = oauthAttachedSlot();
    const state: SlotState = {
      authState: 'healthy',
      activeLeases: [],
      cooldownUntil: new Date(now + 30 * 60_000).toISOString(),
    };
    const text = statusText(slot, state);
    expect(text).toContain(':large_yellow_circle: Cooldown 30m');
    // Generic "Cooldown" — no 5h/7d prefix for manual source.
    expect(text).not.toMatch(/5h Cooldown/);
    expect(text).not.toMatch(/7d Cooldown/);
    // OAuth refresh hint still emitted because authState is healthy.
    expect(text).toContain('OAuth refreshes in');
  });

  it('OAuth + cooldownUntil = now + 3h + 5h util=0.5 (sub-threshold) → orange Cooldown 3h 0m', () => {
    const slot = oauthAttachedSlot();
    const state: SlotState = {
      authState: 'healthy',
      activeLeases: [],
      cooldownUntil: new Date(now + 3 * HOUR).toISOString(),
      usage: {
        fetchedAt: new Date(now).toISOString(),
        fiveHour: { utilization: 50, resetsAt: new Date(now + 4 * HOUR).toISOString() },
      },
    };
    const text = statusText(slot, state);
    expect(text).toContain(':large_orange_circle: Cooldown 3h 0m');
    // Utilization < 1 so the cooldownUntil triggers, not the 5h source.
    expect(text).not.toMatch(/5h Cooldown/);
    expect(text).not.toMatch(/7d Cooldown/);
  });

  it('OAuth + 7d util=1.0 (resets in 12h) + cooldownUntil = now + 3h → 7d Cooldown wins (12h 0m, purple)', () => {
    const slot = oauthAttachedSlot();
    const state: SlotState = {
      authState: 'healthy',
      activeLeases: [],
      cooldownUntil: new Date(now + 3 * HOUR).toISOString(),
      usage: {
        fetchedAt: new Date(now).toISOString(),
        sevenDay: { utilization: 100, resetsAt: new Date(now + 12 * HOUR).toISOString() },
      },
    };
    const text = statusText(slot, state);
    expect(text).toContain(':large_purple_circle: 7d Cooldown 12h 0m');
    // cooldownUntil is overridden by the higher-priority 7d source.
    expect(text).not.toMatch(/(^|\s)Cooldown 3h/);
  });

  it('OAuth + 5h util=1.0 (resets in 30m) + cooldownUntil = now + 3h → 5h Cooldown wins (30m, yellow)', () => {
    const slot = oauthAttachedSlot();
    const state: SlotState = {
      authState: 'healthy',
      activeLeases: [],
      cooldownUntil: new Date(now + 3 * HOUR).toISOString(),
      usage: {
        fetchedAt: new Date(now).toISOString(),
        fiveHour: { utilization: 100, resetsAt: new Date(now + 30 * 60_000).toISOString() },
      },
    };
    const text = statusText(slot, state);
    expect(text).toContain(':large_yellow_circle: 5h Cooldown 30m');
    expect(text).not.toMatch(/(^|\s)Cooldown 3h/);
  });

  it('OAuth + cooldownUntil expired (now - 1h) + util=0.5/0.5 → green Healthy', () => {
    const slot = oauthAttachedSlot();
    const state: SlotState = {
      authState: 'healthy',
      activeLeases: [],
      cooldownUntil: new Date(now - HOUR).toISOString(),
      usage: {
        fetchedAt: new Date(now).toISOString(),
        fiveHour: { utilization: 50, resetsAt: new Date(now + 2 * HOUR).toISOString() },
        sevenDay: { utilization: 50, resetsAt: new Date(now + 3 * 86_400_000).toISOString() },
      },
    };
    const text = statusText(slot, state);
    expect(text).toContain(':large_green_circle: Healthy');
    expect(text).not.toMatch(/Cooldown/);
  });

  it('regression lock: OAuth + cooldownUntil + util<1 → label is bare "Cooldown" (never "5h Cooldown" / "7d Cooldown")', () => {
    const slot = oauthAttachedSlot();
    const state: SlotState = {
      authState: 'healthy',
      activeLeases: [],
      cooldownUntil: new Date(now + 2 * HOUR).toISOString(),
      usage: {
        fetchedAt: new Date(now).toISOString(),
        fiveHour: { utilization: 30, resetsAt: new Date(now + HOUR).toISOString() },
        sevenDay: { utilization: 40, resetsAt: new Date(now + 6 * 86_400_000).toISOString() },
      },
    };
    const text = statusText(slot, state);
    // Match bare " Cooldown " with no 5h/7d marker (start-of-segment after the color emoji).
    expect(text).toMatch(/:large_orange_circle: Cooldown 2h/);
    expect(text).not.toMatch(/5h Cooldown/);
    expect(text).not.toMatch(/7d Cooldown/);
  });

  it('OAuth + cooldownUntil with NaN ISO → no manual cooldown fired (falls through to Healthy)', () => {
    const slot = oauthAttachedSlot();
    const state: SlotState = {
      authState: 'healthy',
      activeLeases: [],
      cooldownUntil: 'not-a-valid-iso',
    };
    const text = statusText(slot, state);
    expect(text).toContain(':large_green_circle: Healthy');
    expect(text).not.toMatch(/Cooldown/);
  });
});

// ────────────────────────────────────────────────────────────────────
// #723: B+D UX context — rate-limit source attribution for OAuth bare
// "Cooldown", plus a canned "Unavailable" reason when the refresh-error
// diagnostic is missing.
//
// +B surfaces *why* the badge shows bare "Cooldown" (manual source) —
// the rate-limited timestamp + source enum the TokenManager already
// records. Gated on: authState=healthy, cooldown.source='manual',
// state.rateLimitedAt present. Non-manual sources (5h/7d) win priority
// in the badge and already self-explain, so B is quiet there.
//
// +D surfaces *why* the badge shows "Unavailable" when there is no
// lastRefreshError diagnostic yet (e.g. the state was mutated directly
// by ops tooling). When a lastRefreshError *is* present, formatRefresh-
// ErrorSegment produces a richer message and D stays silent (no
// double-up).
// ────────────────────────────────────────────────────────────────────

describe('B+D UX context (#723)', () => {
  const now = Date.parse('2026-04-22T00:00:00Z');
  const HOUR = 3_600_000;

  function oauthAttachedSlot(overrides: Partial<AuthKey> = {}): AuthKey {
    return {
      kind: 'cct',
      source: 'setup',
      keyId: 'slot-oauth',
      name: 'cct-oauth',
      setupToken: 'sk-ant-oat01-xxxx',
      oauthAttachment: {
        accessToken: 't',
        refreshToken: 'r',
        expiresAtMs: now + 7 * HOUR + 18 * 60_000,
        scopes: ['user:profile'],
        acknowledgedConsumerTosRisk: true,
      },
      createdAt: '',
      ...overrides,
    } as AuthKey;
  }

  function statusText(slot: AuthKey, state: SlotState | undefined, isActive = true): string {
    const blocks = buildSlotRow(slot, state, isActive, now, 'Asia/Seoul');
    const section = blocks[0] as any;
    const lines = (section.text.text as string).split('\n');
    return lines[1] ?? '';
  }

  // Defaults: healthy + empty leases. Each test overrides only the
  // fields that drive its assertion, so the variant under test is the
  // only visible field in the literal.
  function makeState(overrides: Partial<SlotState> = {}): SlotState {
    return {
      authState: 'healthy',
      activeLeases: [],
      ...overrides,
    };
  }

  const manualCooldown = new Date(now + 2 * HOUR).toISOString();
  const rlRecent = new Date(now - 5 * 60_000).toISOString();

  // ── +B: rate-limit source attribution on bare Cooldown ─────────────

  it('B: OAuth healthy + manual cooldown (future) + rateLimitedAt + source=response_header → rate-limited <ts> via response_header between badge and refresh hint', () => {
    const text = statusText(
      oauthAttachedSlot(),
      makeState({
        cooldownUntil: manualCooldown,
        rateLimitedAt: rlRecent,
        rateLimitSource: 'response_header',
      }),
    );
    expect(text).toContain(':large_orange_circle: Cooldown 2h');
    expect(text).toContain('rate-limited');
    expect(text).toContain('via response_header');
    // Segment ordering: badge → rate-limited → OAuth refresh hint.
    const idxCooldown = text.indexOf('Cooldown 2h');
    const idxRL = text.indexOf('rate-limited');
    const idxHint = text.indexOf('OAuth refreshes in');
    expect(idxCooldown).toBeGreaterThanOrEqual(0);
    expect(idxRL).toBeGreaterThan(idxCooldown);
    expect(idxHint).toBeGreaterThan(idxRL);
  });

  it('B: OAuth healthy + manual cooldown + rateLimitedAt + rateLimitSource undefined → rate-limited <ts> with no "via ..." suffix', () => {
    const text = statusText(oauthAttachedSlot(), makeState({ cooldownUntil: manualCooldown, rateLimitedAt: rlRecent }));
    expect(text).toContain('rate-limited');
    // No attribution suffix when source is undefined (legacy payload).
    expect(text).not.toContain(' via ');
  });

  it('B: OAuth healthy + manual cooldown + rateLimitedAt undefined → NO rate-limited segment (legacy-migrated cooldown path)', () => {
    const text = statusText(oauthAttachedSlot(), makeState({ cooldownUntil: manualCooldown }));
    expect(text).toContain(':large_orange_circle: Cooldown 2h');
    expect(text).not.toContain('rate-limited');
  });

  it('B gate: OAuth healthy + 5h util=1.0 cooldown + rateLimitedAt + rateLimitSource → NO rate-limited segment (attribution is manual-source-only)', () => {
    const text = statusText(
      oauthAttachedSlot(),
      makeState({
        rateLimitedAt: rlRecent,
        rateLimitSource: 'response_header',
        usage: {
          fetchedAt: new Date(now).toISOString(),
          fiveHour: { utilization: 100, resetsAt: new Date(now + 30 * 60_000).toISOString() },
        },
      }),
    );
    expect(text).toContain('5h Cooldown');
    // 5h self-explains; B is quiet so we don't double-attribute.
    expect(text).not.toContain('rate-limited');
  });

  it('B gate: OAuth non-healthy + manual cooldown + rateLimitedAt + rateLimitSource → NO rate-limited segment (B is healthy-only)', () => {
    const text = statusText(
      oauthAttachedSlot(),
      makeState({
        authState: 'refresh_failed',
        cooldownUntil: manualCooldown,
        rateLimitedAt: rlRecent,
        rateLimitSource: 'response_header',
      }),
    );
    // Unavailable wins; D fallback supplies the reason.
    expect(text).toBe(':black_circle: Unavailable · :warning: OAuth refresh failed');
    expect(text).not.toContain('rate-limited');
  });

  // ── +D: Unavailable-reason fallback when no refresh diagnostic ────

  it('D gate: OAuth authState=refresh_failed WITH lastRefreshError → refreshErrSeg wins, no :warning: OAuth refresh failed fallback', () => {
    const text = statusText(
      oauthAttachedSlot(),
      makeState({
        authState: 'refresh_failed',
        lastRefreshFailedAt: now - 2 * 60_000,
        lastRefreshError: {
          kind: 'unauthorized',
          message: 'OAuth refresh rejected (401)',
          at: now - 2 * 60_000,
        },
      }),
    );
    expect(text).toContain(':black_circle: Unavailable');
    expect(text).toContain('OAuth refresh rejected (401)');
    // D fallback suppressed when the diagnostic is present (no double-up).
    expect(text).not.toContain(':warning: OAuth refresh failed');
  });

  it('D gate: OAuth authState=revoked WITH lastRefreshError → refreshErrSeg wins, no :warning: OAuth revoked fallback', () => {
    const text = statusText(
      oauthAttachedSlot(),
      makeState({
        authState: 'revoked',
        lastRefreshFailedAt: now - 2 * 60_000,
        lastRefreshError: {
          kind: 'revoked',
          message: 'OAuth credentials revoked',
          at: now - 2 * 60_000,
        },
      }),
    );
    expect(text).toContain(':black_circle: Unavailable');
    expect(text).toContain('OAuth credentials revoked');
    expect(text).not.toContain(':warning: OAuth revoked');
  });
});

// ────────────────────────────────────────────────────────────────────
// #668 follow-up · email / rate-limit tier / rotation-off segment /
// 7d-sonnet 0% hide / expires suffix
// ────────────────────────────────────────────────────────────────────

describe('formatRateLimitTier (#668 follow-up)', () => {
  it('maps each known default_claude_* tier to its label', () => {
    expect(formatRateLimitTier('default_claude_max_20x', 'cct')).toBe('Max 20×');
    expect(formatRateLimitTier('default_claude_max_5x', 'cct')).toBe('Max 5×');
    expect(formatRateLimitTier('default_claude_pro', 'cct')).toBe('Pro');
    expect(formatRateLimitTier('default_claude_max', 'cct')).toBe('Max');
  });
  it('api_key kind always returns API regardless of raw', () => {
    expect(formatRateLimitTier(undefined, 'api_key')).toBe('API');
    expect(formatRateLimitTier('default_claude_max_20x', 'api_key')).toBe('API');
  });
  it('unknown tier passes through as the raw string', () => {
    expect(formatRateLimitTier('default_claude_enterprise', 'cct')).toBe('default_claude_enterprise');
  });
  it('undefined raw on a cct slot → null (no badge)', () => {
    expect(formatRateLimitTier(undefined, 'cct')).toBeNull();
  });
});

describe('subscriptionBadge — profile.rateLimitTier priority (#668 follow-up)', () => {
  const base = {
    kind: 'cct' as const,
    source: 'setup' as const,
    keyId: 'k',
    name: 'n',
    setupToken: 'sk-ant-oat01-xxxx',
    createdAt: '',
  };
  it('prefers profile.rateLimitTier over attachment.rateLimitTier and subscriptionType', () => {
    const slot: AuthKey = {
      ...base,
      oauthAttachment: {
        accessToken: 't',
        refreshToken: 'r',
        expiresAtMs: 0,
        scopes: ['user:profile'],
        acknowledgedConsumerTosRisk: true,
        subscriptionType: 'pro',
        rateLimitTier: 'default_claude_pro',
        profile: { fetchedAt: 1, rateLimitTier: 'default_claude_max_20x' },
      },
    };
    expect(subscriptionBadge(slot)).toBe(' · Max 20×');
  });
  it('falls back to attachment.rateLimitTier when profile missing', () => {
    const slot: AuthKey = {
      ...base,
      oauthAttachment: {
        accessToken: 't',
        refreshToken: 'r',
        expiresAtMs: 0,
        scopes: ['user:profile'],
        acknowledgedConsumerTosRisk: true,
        rateLimitTier: 'default_claude_max_5x',
      },
    };
    expect(subscriptionBadge(slot)).toBe(' · Max 5×');
  });
});

describe('buildSlotRow — email suffix (#668 follow-up)', () => {
  const now = Date.parse('2026-04-22T00:00:00Z');
  function slotWithEmail(email: string): AuthKey {
    return {
      kind: 'cct',
      source: 'setup',
      keyId: 'slot-e',
      name: 'cct-e',
      setupToken: 'sk-ant-oat01-xxxx',
      oauthAttachment: {
        accessToken: 't',
        refreshToken: 'r',
        expiresAtMs: now + 86_400_000,
        scopes: ['user:profile'],
        acknowledgedConsumerTosRisk: true,
        profile: { fetchedAt: 1, email, rateLimitTier: 'default_claude_max_20x' },
      },
      createdAt: '',
    };
  }

  it('renders email as a " · " segment on the head line', () => {
    const blocks = buildSlotRow(slotWithEmail('alice@example.com'), undefined, false, now);
    const text = (blocks[0] as any).text.text as string;
    expect(text).toContain('· alice@example.com');
  });

  it('middle-truncates emails longer than 40 chars', () => {
    const long = 'very.long.local.part.name@very-long-corp-domain.example.com';
    const blocks = buildSlotRow(slotWithEmail(long), undefined, false, now);
    const text = (blocks[0] as any).text.text as string;
    // Should contain ellipsis marker and not the full string.
    expect(text).toMatch(/\.\.\./);
    expect(text).not.toContain(long);
  });

  it('no email → no email segment', () => {
    const noProfileSlot: AuthKey = {
      kind: 'cct',
      source: 'setup',
      keyId: 'slot-ne',
      name: 'cct-ne',
      setupToken: 'sk-ant-oat01-xxxx',
      createdAt: '',
    };
    const blocks = buildSlotRow(noProfileSlot, undefined, false, now);
    const text = (blocks[0] as any).text.text as string;
    expect(text).not.toMatch(/@/);
  });
});

describe('buildSlotRow — rotation-off segment (#668 follow-up)', () => {
  const now = Date.parse('2026-04-22T00:00:00Z');
  it('renders `:lock: rotation-off` when slot.disableRotation=true', () => {
    const slot: AuthKey = {
      kind: 'cct',
      source: 'setup',
      keyId: 'slot-d',
      name: 'cct-d',
      setupToken: 'sk-ant-oat01-xxxx',
      createdAt: '',
      disableRotation: true,
    };
    const blocks = buildSlotRow(slot, undefined, false, now);
    const text = (blocks[0] as any).text.text as string;
    expect(text).toContain(':lock: rotation-off');
  });
  it('absent flag → no rotation-off segment', () => {
    const slot: AuthKey = {
      kind: 'cct',
      source: 'setup',
      keyId: 'slot-d',
      name: 'cct-d',
      setupToken: 'sk-ant-oat01-xxxx',
      createdAt: '',
    };
    const blocks = buildSlotRow(slot, undefined, false, now);
    const text = (blocks[0] as any).text.text as string;
    expect(text).not.toContain('rotation-off');
  });
});

describe('buildSlotRow — 7d-sonnet 0% hide (#668 follow-up)', () => {
  const now = Date.parse('2026-04-22T00:00:00Z');
  function slotWithAttachment(): AuthKey {
    return {
      kind: 'cct',
      source: 'setup',
      keyId: 'slot-s',
      name: 'cct-s',
      setupToken: 'sk-ant-oat01-xxxx',
      oauthAttachment: {
        accessToken: 't',
        refreshToken: 'r',
        expiresAtMs: now + 86_400_000,
        scopes: ['user:profile'],
        acknowledgedConsumerTosRisk: true,
      },
      createdAt: '',
    };
  }
  it('hides 7d-sonnet row when utilization is exactly 0', () => {
    const slot = slotWithAttachment();
    const state: SlotState = {
      authState: 'healthy',
      activeLeases: [],
      usage: {
        fetchedAt: new Date(now).toISOString(),
        fiveHour: { utilization: 10, resetsAt: new Date(now + 3_600_000).toISOString() },
        sevenDaySonnet: { utilization: 0, resetsAt: new Date(now + 6 * 86_400_000).toISOString() },
      },
    };
    const blocks = buildSlotRow(slot, state, true, now);
    const flat = JSON.stringify(blocks);
    expect(flat).not.toMatch(/7d-sonnet/);
  });
  it('shows 7d-sonnet row when utilization > 0', () => {
    const slot = slotWithAttachment();
    const state: SlotState = {
      authState: 'healthy',
      activeLeases: [],
      usage: {
        fetchedAt: new Date(now).toISOString(),
        fiveHour: { utilization: 10, resetsAt: new Date(now + 3_600_000).toISOString() },
        sevenDaySonnet: { utilization: 1, resetsAt: new Date(now + 6 * 86_400_000).toISOString() },
      },
    };
    const blocks = buildSlotRow(slot, state, true, now);
    const flat = JSON.stringify(blocks);
    expect(flat).toMatch(/7d-sonnet/);
  });
});

describe('formatUsageBar — second gauge bar (card v2 follow-up)', () => {
  const now = Date.parse('2026-04-22T00:00:00Z');

  it('drops the legacy ` · expires in <dur>` suffix from the output', () => {
    // The duplicated `expires in` hint was replaced by a second
    // progress bar that visualises the remaining portion of the window.
    const iso = new Date(now + 3 * 3_600_000).toISOString();
    const out = formatUsageBar(0.5, iso, now, '5h');
    expect(out).not.toMatch(/expires in/);
    expect(out).toMatch(/resets in 3h 0m$/);
  });

  it('mid-window 5h with 2.5h remaining → remaining bar roughly half-filled (5/10 cells)', () => {
    const iso = new Date(now + 2.5 * 3_600_000).toISOString();
    const out = formatUsageBar(0.5, iso, now, '5h');
    // Format: `5h <utilBar> 50% · <remainingBar> resets in 2h 30m`.
    const m = out.match(/· ([█░]+) resets in/);
    expect(m).not.toBeNull();
    const rBar = m![1];
    expect(rBar.length).toBe(10);
    // 2.5/5 = 50% → 5 filled cells.
    expect(rBar).toBe('█████░░░░░');
  });

  it('window-just-started 7d with ~7d remaining → remaining bar near full (9-10 filled)', () => {
    // 2.5 minutes into a 7d window → ~7d remaining.
    const iso = new Date(now + 7 * 86_400_000 - 150_000).toISOString();
    const out = formatUsageBar(0.1, iso, now, '7d');
    const m = out.match(/· ([█░]+) resets in/);
    expect(m).not.toBeNull();
    const rBar = m![1];
    const filled = (rBar.match(/█/g) ?? []).length;
    expect(filled).toBeGreaterThanOrEqual(9);
    expect(filled).toBeLessThanOrEqual(10);
  });

  it('window-expired-past 7d → remaining bar all empty, hint "<1m"', () => {
    const iso = new Date(now - 3_600_000).toISOString(); // 1h ago
    const out = formatUsageBar(0.95, iso, now, '7d');
    const m = out.match(/· ([█░]+) resets in/);
    expect(m).not.toBeNull();
    const rBar = m![1];
    expect(rBar).toBe('░'.repeat(10));
    expect(out).toMatch(/resets in <1m$/);
  });

  it('invalid resetsAt → dotted-placeholder remaining bar + "<1m" hint', () => {
    const out = formatUsageBar(0.3, 'not-a-valid-iso', now, '5h');
    // Dotted placeholder signals the column can't be computed without
    // dropping the row entirely.
    expect(out).toContain('··········');
    expect(out).toMatch(/resets in <1m$/);
  });
});

describe('buildCctCardBlocks — 15-slot fleet stays under cap (PR #672 follow-up: footer removed)', () => {
  const now = Date.parse('2026-04-22T00:00:00Z');

  it('15 OAuth-attached slots → blocks ≤ 47 (no footer; pure regression guard)', () => {
    const slots: AuthKey[] = [];
    const states: Record<string, SlotState> = {};
    for (let i = 0; i < 15; i++) {
      const keyId = `slot-${i}`;
      slots.push({
        kind: 'cct',
        source: 'setup',
        keyId,
        name: `cct${i}`,
        setupToken: 'sk-ant-oat01-x',
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
        usage: {
          fetchedAt: new Date(now).toISOString(),
          fiveHour: { utilization: 30, resetsAt: new Date(now + 3 * 3_600_000).toISOString() },
          sevenDay: {
            utilization: i * 0.05,
            resetsAt: new Date(now + (i + 1) * 86_400_000).toISOString(),
          },
        },
      };
    }
    const blocks = buildCctCardBlocks({ slots, states, activeKeyId: 'slot-0', nowMs: now });
    expect(blocks.length).toBeLessThanOrEqual(47);
  });
});

describe('appendStoreReadFailureBanner', () => {
  // Both entry points (`actions.ts buildCardFromManager` catch-path and
  // `cct-topic.ts loadSnapshotOrEmpty`) call the shared helper so operators
  // see the same wording — lock the rendered shape here.
  it('appends one :warning: context block with the store-read failure wording', () => {
    const blocks: any[] = [];
    appendStoreReadFailureBanner(blocks);
    expect(blocks).toHaveLength(1);
    const [b] = blocks;
    expect(b.type).toBe('context');
    expect(b.elements).toHaveLength(1);
    expect(b.elements[0].type).toBe('mrkdwn');
    expect(b.elements[0].text).toBe(
      ':warning: *Store read failed* — card rendered empty as a fallback. Check the CctTopic logs for `loadSnapshotOrEmpty: getSnapshot failed` or `buildCardFromManager: getSnapshot failed`.',
    );
  });

  it('mutates the passed array (no return value needed)', () => {
    const blocks: any[] = [{ type: 'header', text: { type: 'plain_text', text: 'X' } }];
    const before = blocks.length;
    const ret = appendStoreReadFailureBanner(blocks);
    expect(ret).toBeUndefined();
    expect(blocks.length).toBe(before + 1);
    expect(blocks[before].type).toBe('context');
  });
});
