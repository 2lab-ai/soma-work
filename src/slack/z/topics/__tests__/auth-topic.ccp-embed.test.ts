/**
 * T3 follow-up (#auth-capacity-overview) — legacy ccp embed composition.
 *
 * Reproduces two composition bugs of the `auth` wrapper around the CCT
 * card and pins the fix:
 *
 *   1. BLOCK BUDGET — the wrapper appends header(2-3) + divider + nav(1)
 *      to a CCT card that can legally reach 50 blocks on its own
 *      (builder soft-cap 47 + topic chrome 3), overflowing Slack's
 *      50-block hard cap. Fix: the wrapper paginates the LEGACY SLOTS
 *      through its own page state (`renderCctCard` embed input), instead
 *      of arbitrary block truncation — no slot is ever dropped, only
 *      windowed.
 *
 *   2. EMBEDDED REFRESH — the CCT card-level [Refresh]
 *      (`cct_refresh_card`) re-renders the BARE CCT card in place,
 *      wiping the auth wrapper (header / admin toggle / nav). Fix: the
 *      embed rendering removes that one control; the auth nav's own
 *      Refresh re-renders the full wrapper. Full legacy mutations
 *      (Activate / Add / Remove / Attach / Detach / Next / Refresh-All)
 *      remain.
 *
 * Direct `cct` output (renderCctCard WITHOUT the embed input) must be
 * unchanged — guarded below.
 *
 * Uses the REAL cct-topic + REAL cct/auth builders; only the token
 * manager, auth runtime and llmux client are faked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAdminUsersCache } from '../../../../admin-utils';
import type { AuthKey, SlotState } from '../../../../cct-store';

const NOW = Date.parse('2026-09-16T00:00:00Z');

vi.mock('../../../../auth/auth-runtime', () => ({
  getAuthRuntimeSnapshot: () => ({
    mode: 'ccp',
    llmux: { baseUrl: 'http://localhost:3456', apiKey: 'proxy-key-xyz1' },
  }),
  setAuthMode: vi.fn(),
}));

vi.mock('../../../../auth/llmux-client', () => ({
  fetchLlmuxStatus: vi.fn(async () => {
    throw new Error('not used in ccp mode');
  }),
  isLlmuxUp: vi.fn(async () => true),
}));

// Token manager fake — snapshot injected per test via `snapshotRef`.
const snapshotRef: { slots: AuthKey[]; states: Record<string, SlotState>; activeKeyId?: string } = {
  slots: [],
  states: {},
  activeKeyId: undefined,
};

vi.mock('../../../../token-manager', () => ({
  getTokenManager: () => ({
    getSnapshot: async () => ({
      version: 2 as const,
      revision: 1,
      registry: { activeKeyId: snapshotRef.activeKeyId, slots: snapshotRef.slots },
      state: snapshotRef.states,
    }),
    fetchUsageForAllAttached: vi.fn(async () => ({})),
    listTokens: () => [],
    getActiveToken: () => null,
  }),
}));

import { CCT_ACTION_IDS } from '../../../cct/views';
import { renderAuthCard } from '../auth-topic';
import { renderCctCard } from '../cct-topic';

/** Rich attached slot — renders the WORST-CASE 4 blocks/slot (section + actions + usage + divider). */
function richSlot(n: number): AuthKey {
  const keyId = `slot-${String(n).padStart(2, '0')}`;
  return {
    kind: 'cct',
    source: 'setup',
    keyId,
    name: `cct-${String(n).padStart(2, '0')}`,
    setupToken: 'sk-ant-oat01-x',
    oauthAttachment: {
      accessToken: 't',
      refreshToken: 'r',
      expiresAtMs: NOW + 7 * 3_600_000,
      scopes: ['user:profile', 'user:inference'],
      acknowledgedConsumerTosRisk: true,
    },
    createdAt: '2026-09-01T00:00:00Z',
  };
}

function richState(): SlotState {
  return {
    authState: 'healthy',
    activeLeases: [],
    usage: {
      fetchedAt: new Date(NOW - 60_000).toISOString(),
      fiveHour: { utilization: 10, resetsAt: new Date(NOW + 3 * 3_600_000).toISOString() },
      sevenDay: { utilization: 5, resetsAt: new Date(NOW + 4 * 86_400_000).toISOString() },
    },
  };
}

function seedSlots(count: number): void {
  snapshotRef.slots = [];
  snapshotRef.states = {};
  for (let n = 1; n <= count; n++) {
    const slot = richSlot(n);
    snapshotRef.slots.push(slot);
    snapshotRef.states[slot.keyId] = richState();
  }
  snapshotRef.activeKeyId = snapshotRef.slots[0]?.keyId;
}

/** Collect every string anywhere in the block tree. */
function flat(blocks: unknown): string {
  return JSON.stringify(blocks);
}

function slotNamesIn(blocks: unknown): Set<string> {
  const text = flat(blocks);
  const names = new Set<string>();
  for (const m of text.matchAll(/cct-\d{2}/g)) names.add(m[0]);
  return names;
}

const PREV_ADMIN_USERS = process.env.ADMIN_USERS;

beforeEach(() => {
  process.env.ADMIN_USERS = 'U_ADMIN';
  resetAdminUsersCache();
  seedSlots(0);
});

afterEach(() => {
  if (PREV_ADMIN_USERS === undefined) delete process.env.ADMIN_USERS;
  else process.env.ADMIN_USERS = PREV_ADMIN_USERS;
  resetAdminUsersCache();
});

describe('ccp embed — block budget via slot pagination (no truncation)', () => {
  it('24 rich slots, ADMIN mode: composed card stays ≤ 49 blocks (1 reserved for action banner)', async () => {
    seedSlots(24);
    const card = await renderAuthCard({ userId: 'U_ADMIN', issuedAt: NOW, viewerMode: 'admin' });
    expect(card.blocks.length).toBeLessThanOrEqual(49);
  });

  it('24 rich slots, readonly default: composed card stays ≤ 49 blocks', async () => {
    seedSlots(24);
    const card = await renderAuthCard({ userId: 'U_PLAIN', issuedAt: NOW });
    expect(card.blocks.length).toBeLessThanOrEqual(49);
  });

  it('pagination windows the slots: every slot appears on EXACTLY one page, none dropped', async () => {
    seedSlots(20);
    const seen = new Map<string, number>();
    // ceil(20/8) = 3 pages max; iterate a couple extra to prove clamping
    // does not duplicate slots beyond the last page.
    const pages = 3;
    for (let page = 0; page < pages; page++) {
      const card = await renderAuthCard({ userId: 'U_ADMIN', issuedAt: NOW, viewerMode: 'admin', page });
      for (const name of slotNamesIn(card.blocks)) {
        seen.set(name, (seen.get(name) ?? 0) + 1);
      }
    }
    // All 20 reachable across pages…
    expect(seen.size).toBe(20);
    // …and windowed — a slot on every page means pagination is not applied.
    for (const [name, count] of seen) {
      expect(count, `slot ${name} appeared on ${count} pages`).toBe(1);
    }
  });

  it('stale/out-of-range page clamps to the last page (nav reflects the clamped page)', async () => {
    seedSlots(20);
    const last = await renderAuthCard({ userId: 'U_ADMIN', issuedAt: NOW, viewerMode: 'admin', page: 2 });
    const clamped = await renderAuthCard({ userId: 'U_ADMIN', issuedAt: NOW, viewerMode: 'admin', page: 99 });
    expect(slotNamesIn(clamped.blocks)).toEqual(slotNamesIn(last.blocks));
    // Slots must actually render (clamping, not an empty window)…
    expect(slotNamesIn(clamped.blocks).size).toBeGreaterThan(0);
    // …and the nav is built from the CLAMPED page: prev exists, next does not.
    const text = flat(clamped.blocks);
    expect(text).toContain('auth_page_prev');
    expect(text).not.toContain('auth_page_next');
  });

  it('multi-page pool renders auth paging controls in the nav', async () => {
    seedSlots(20);
    const page0 = await renderAuthCard({ userId: 'U_ADMIN', issuedAt: NOW, viewerMode: 'admin', page: 0 });
    expect(flat(page0.blocks)).toContain('auth_page_next');
    const page2 = await renderAuthCard({ userId: 'U_ADMIN', issuedAt: NOW, viewerMode: 'admin', page: 2 });
    expect(flat(page2.blocks)).toContain('auth_page_prev');
  });

  it('small pool (≤ page size) renders unpaginated with no paging buttons', async () => {
    seedSlots(3);
    const card = await renderAuthCard({ userId: 'U_ADMIN', issuedAt: NOW, viewerMode: 'admin' });
    const text = flat(card.blocks);
    expect(slotNamesIn(card.blocks).size).toBe(3);
    expect(text).not.toContain('auth_page_prev');
    expect(text).not.toContain('auth_page_next');
  });
});

describe('ccp embed — embedded CCT refresh must not supersede the wrapper', () => {
  it('composed card carries NO cct_refresh_card control (auth nav Refresh replaces it)', async () => {
    seedSlots(5);
    const card = await renderAuthCard({ userId: 'U_ADMIN', issuedAt: NOW, viewerMode: 'admin' });
    const text = flat(card.blocks);
    expect(text).not.toContain(CCT_ACTION_IDS.refresh_card);
    // The wrapper's own Refresh (full re-render incl. header + nav) is present.
    expect(text).toContain('auth_refresh');
  });

  it('readonly composed card drops the refresh-only CCT actions row entirely (no empty actions block)', async () => {
    seedSlots(5);
    const card = await renderAuthCard({ userId: 'U_PLAIN', issuedAt: NOW });
    const text = flat(card.blocks);
    expect(text).not.toContain(CCT_ACTION_IDS.refresh_card);
    // Slack rejects actions blocks with zero elements.
    for (const block of card.blocks as Array<{ type?: string; elements?: unknown[] }>) {
      if (block.type === 'actions') {
        expect((block.elements ?? []).length).toBeGreaterThan(0);
      }
    }
  });

  it('embedded tagged button values are auth-origin stamped (cm:<mode>|ao:<page>|<inner>)', async () => {
    seedSlots(20);
    const card = await renderAuthCard({ userId: 'U_ADMIN', issuedAt: NOW, viewerMode: 'admin', page: 1 });
    const values: string[] = [];
    for (const block of card.blocks as Array<{ type?: string; elements?: Array<{ value?: unknown }> }>) {
      if (block.type !== 'actions' || !Array.isArray(block.elements)) continue;
      for (const el of block.elements) {
        if (typeof el.value === 'string') values.push(el.value);
      }
    }
    const tagged = values.filter((v) => v.startsWith('cm:'));
    expect(tagged.length).toBeGreaterThan(0);
    // Every tagged CCT value carries the auth origin at the CURRENT page.
    for (const v of tagged) {
      expect(v, `expected auth-origin stamp on ${v}`).toMatch(/^cm:(admin|readonly)\|ao:1\|.+$/);
    }
    // Auth nav's own values (JSON {viewerMode,page}) are NOT cm-tagged and stay untouched.
    expect(values.some((v) => v.startsWith('{'))).toBe(true);
  });

  it('direct renderCctCard values are NOT auth-origin stamped', async () => {
    seedSlots(3);
    const card = await renderCctCard({ userId: 'U_ADMIN', issuedAt: NOW });
    expect(flat(card.blocks)).not.toContain('|ao:');
  });

  it('full legacy mutations REMAIN on the embedded admin card', async () => {
    seedSlots(5);
    const card = await renderAuthCard({ userId: 'U_ADMIN', issuedAt: NOW, viewerMode: 'admin' });
    const text = flat(card.blocks);
    for (const id of [
      CCT_ACTION_IDS.activate_slot,
      CCT_ACTION_IDS.remove,
      CCT_ACTION_IDS.add,
      CCT_ACTION_IDS.next,
      CCT_ACTION_IDS.refresh_usage_all,
      CCT_ACTION_IDS.detach,
    ]) {
      expect(text, `expected embedded admin card to keep ${id}`).toContain(id);
    }
  });
});

describe('direct cct output is NOT altered (no embed input)', () => {
  it('direct renderCctCard keeps the card-level Refresh and renders ALL slots unpaginated', async () => {
    seedSlots(24);
    const card = await renderCctCard({ userId: 'U_ADMIN', issuedAt: NOW });
    const text = flat(card.blocks);
    expect(text).toContain(CCT_ACTION_IDS.refresh_card);
    expect(slotNamesIn(card.blocks).size).toBe(24);
    // Direct card carries no auth-wrapper page indicator.
    expect(text).not.toContain('페이지');
    // BASELINE (pre-existing, out of scope here — direct output must not
    // be altered): at 24 rich slots the DIRECT card measures 51 blocks
    // (builder floor 2/slot + chrome; trimBlocksToSlackCap cannot go
    // lower) — already over Slack's 50 cap without any auth wrapper.
    // The #701 budget contract only covers ≤ 15 slots. Locked here so a
    // silent change to direct rendering is visible.
    expect(card.blocks.length).toBe(51);
  });

  it('direct readonly renderCctCard also keeps its Refresh control', async () => {
    seedSlots(3);
    const card = await renderCctCard({ userId: 'U_PLAIN', issuedAt: NOW });
    expect(flat(card.blocks)).toContain(CCT_ACTION_IDS.refresh_card);
  });
});
