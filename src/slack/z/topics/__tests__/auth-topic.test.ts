/**
 * `auth` card end-to-end wiring (command → topic → builder).
 *
 * #803 baseline: the card the non-admin actually receives must carry the
 * same account info as the admin card; only mutating affordances and the
 * settings line stay admin-only.
 *
 * T3 (#auth-capacity-overview) additions:
 *   - DEFAULT render is the readonly overview for EVERYONE — admins
 *     included. The admin surface must be requested explicitly via
 *     `viewerMode:'admin'` (the [Admin mode] nav button).
 *   - `renderAuthCard` NEVER honors an admin override for a non-admin:
 *     a forged `viewerMode:'admin'` demotes to readonly.
 *   - builder receives `canManage=isAdminUser(userId)` and `page` so it
 *     can render the one [Admin mode] / [Overview] toggle + paging.
 *   - legacy ccp path passes the EFFECTIVE viewerMode to `renderCctCard`
 *     and appends the shared auth navigation after the CCT blocks. The
 *     direct `cct` command behavior is untouched (renderCctCard itself is
 *     mocked here; its own tests cover that surface).
 *
 * `buildAuthNavigationBlocks` is stubbed (partial builder mock): the
 * helper's markup belongs to `auth/__tests__/builder*.test.ts`; this file
 * pins the topic→builder wiring contract (arguments + placement).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAdminUsersCache } from '../../../../admin-utils';
import type { AuthRuntimeState } from '../../../../auth/auth-runtime';
import type { LlmuxStatus } from '../../../../auth/llmux-client';

const RUNTIME: AuthRuntimeState = {
  mode: 'llmux',
  llmux: { baseUrl: 'http://localhost:3456', apiKey: 'proxy-key-xyz1' },
};

const NOW_SECS = 1_900_000_000;

const STATUS: LlmuxStatus = {
  version: '0.2.19',
  uptime_secs: 7200,
  port: 3456,
  current: 'claude:me@example.com',
  accounts: [
    {
      name: 'claude:me@example.com',
      type: 'oauth',
      group: 'claude',
      status: 'active',
      order: 1,
      five_hour: { utilization: 0.17, resets_at: NOW_SECS + 3600, resets_in_secs: 3600 },
      seven_day: { utilization: 0.36, resets_at: NOW_SECS + 400_000, resets_in_secs: 400_000 },
    },
  ],
};

vi.mock('../../../../auth/auth-runtime', () => ({
  getAuthRuntimeSnapshot: () => RUNTIME,
  setAuthMode: vi.fn(),
}));

vi.mock('../../../../auth/llmux-client', () => ({
  fetchLlmuxStatus: vi.fn(async () => STATUS),
  isLlmuxUp: vi.fn(async () => true),
}));

// Legacy ccp path — the CCT card renderer is a separate surface with its
// own tests; here we only pin what the auth topic HANDS it (viewerMode)
// and where the auth navigation lands relative to its blocks.
vi.mock('../cct-topic', () => ({
  renderCctCard: vi.fn(async (args: { viewerMode?: string }) => ({
    text: '🔑 CCT (active: none)',
    blocks: [
      {
        type: 'section',
        block_id: 'cct_body_stub',
        text: { type: 'mrkdwn', text: `CCT_BODY_${args.viewerMode ?? 'derived'}` },
      },
      {
        type: 'actions',
        elements: [{ type: 'button', action_id: 'z_setting_cct_cancel', value: 'cancel' }],
      },
    ],
  })),
}));

// Partial builder mock: real card builder (wrapped in a spy so call args
// are observable) + a stubbed navigation helper. The nav stub carries a
// recognizable block_id so placement can be asserted.
vi.mock('../../../auth/builder', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const realBuildAuthCardBlocks = actual.buildAuthCardBlocks as (input: unknown) => unknown[];
  return {
    ...actual,
    buildAuthCardBlocks: vi.fn((input: unknown) => realBuildAuthCardBlocks(input)),
    buildAuthNavigationBlocks: vi.fn((viewerMode: string, canManage: boolean, page = 0, pageCount = 1) => [
      {
        type: 'actions',
        block_id: 'auth_nav_stub',
        elements: [
          {
            type: 'button',
            action_id: 'auth_refresh',
            value: JSON.stringify({ viewerMode, page }),
            text: { type: 'plain_text', text: `nav ${viewerMode} ${canManage} ${page}/${pageCount}` },
          },
        ],
      },
    ]),
  };
});

import * as authBuilder from '../../../auth/builder';
import { AUTH_ACTION_IDS } from '../../../auth/views';
import { renderAuthCard } from '../auth-topic';
import { renderCctCard } from '../cct-topic';

const buildAuthCardBlocksMock = vi.mocked(authBuilder.buildAuthCardBlocks);
// Pre-T1 the real builder does not export the nav helper yet — reach
// through the (mocked) namespace without a compile-time dependency.
const buildAuthNavigationBlocksMock = (authBuilder as unknown as Record<string, ReturnType<typeof vi.fn>>)
  .buildAuthNavigationBlocks;

const PREV_ADMIN_USERS = process.env.ADMIN_USERS;

beforeEach(() => {
  process.env.ADMIN_USERS = 'U_ADMIN';
  resetAdminUsersCache();
  RUNTIME.mode = 'llmux';
  buildAuthCardBlocksMock.mockClear();
  buildAuthNavigationBlocksMock.mockClear();
  vi.mocked(renderCctCard).mockClear();
});

afterEach(() => {
  if (PREV_ADMIN_USERS === undefined) delete process.env.ADMIN_USERS;
  else process.env.ADMIN_USERS = PREV_ADMIN_USERS;
  resetAdminUsersCache();
});

describe('renderAuthCard — account info is viewer-independent', () => {
  it('non-admin card shows llmux account names and the current account', async () => {
    const card = await renderAuthCard({ userId: 'U_PLAIN', issuedAt: Date.now() });
    const text = JSON.stringify(card.blocks);
    expect(text).toContain('claude:me@example.com');
    expect(text).toContain('current: *claude:me@example.com*');
    expect(text).not.toContain('slot 1 (oauth)');
    expect(text).not.toContain('current: *set*');
    // The notification/accessibility fallback carries the same identity.
    expect(card.text).toContain('claude:me@example.com');
  });

  it('non-admin card still hides mutating buttons and the settings line', async () => {
    const card = await renderAuthCard({ userId: 'U_PLAIN', issuedAt: Date.now() });
    const text = JSON.stringify(card.blocks);
    expect(text).not.toContain(AUTH_ACTION_IDS.switch);
    expect(text).not.toContain(AUTH_ACTION_IDS.remove);
    expect(text).not.toContain(AUTH_ACTION_IDS.add);
    expect(text).not.toContain(AUTH_ACTION_IDS.settings);
    expect(text).not.toContain(`${AUTH_ACTION_IDS.mode}_llmux`);
    expect(text).not.toContain('localhost:3456');
    expect(text).not.toContain('••••xyz1');
    // Read-only refresh stays available.
    expect(text).toContain(AUTH_ACTION_IDS.refresh);
  });

  it('admin and non-admin agree on account identity', async () => {
    const adminText = JSON.stringify((await renderAuthCard({ userId: 'U_ADMIN', issuedAt: Date.now() })).blocks);
    const plainText = JSON.stringify((await renderAuthCard({ userId: 'U_PLAIN', issuedAt: Date.now() })).blocks);
    for (const fragment of ['claude:me@example.com', 'current: *claude:me@example.com*']) {
      expect(adminText).toContain(fragment);
      expect(plainText).toContain(fragment);
    }
  });
});

describe('renderAuthCard — T3 default readonly overview + explicit admin mode', () => {
  it('ADMIN default render (no viewerMode) is the readonly overview — no mutating affordances', async () => {
    const card = await renderAuthCard({ userId: 'U_ADMIN', issuedAt: Date.now() });
    const text = JSON.stringify(card.blocks);
    expect(text).not.toContain(AUTH_ACTION_IDS.switch);
    expect(text).not.toContain(AUTH_ACTION_IDS.remove);
    expect(text).not.toContain(AUTH_ACTION_IDS.add);
    expect(text).not.toContain(AUTH_ACTION_IDS.settings);
    expect(text).not.toContain(`${AUTH_ACTION_IDS.mode}_llmux`);
    // Builder was asked for the readonly card, but told the viewer CAN
    // manage — that flag is what renders the single [Admin mode] button.
    expect(buildAuthCardBlocksMock).toHaveBeenCalledTimes(1);
    expect(buildAuthCardBlocksMock).toHaveBeenCalledWith(
      expect.objectContaining({ viewerMode: 'readonly', canManage: true, page: 0 }),
    );
  });

  it('ADMIN explicit viewerMode:"admin" renders the full admin UI', async () => {
    const card = await renderAuthCard({ userId: 'U_ADMIN', issuedAt: Date.now(), viewerMode: 'admin' });
    const text = JSON.stringify(card.blocks);
    expect(buildAuthCardBlocksMock).toHaveBeenCalledWith(
      expect.objectContaining({ viewerMode: 'admin', canManage: true }),
    );
    expect(text).toContain(AUTH_ACTION_IDS.settings);
    expect(text).toContain(AUTH_ACTION_IDS.add);
    expect(text).toContain(`${AUTH_ACTION_IDS.mode}_llmux`);
  });

  it('NON-ADMIN requesting viewerMode:"admin" is demoted to readonly (never honored)', async () => {
    const card = await renderAuthCard({ userId: 'U_PLAIN', issuedAt: Date.now(), viewerMode: 'admin' });
    const text = JSON.stringify(card.blocks);
    expect(buildAuthCardBlocksMock).toHaveBeenCalledWith(
      expect.objectContaining({ viewerMode: 'readonly', canManage: false }),
    );
    expect(text).not.toContain(AUTH_ACTION_IDS.settings);
    expect(text).not.toContain(AUTH_ACTION_IDS.add);
    expect(text).not.toContain(AUTH_ACTION_IDS.switch);
    expect(text).not.toContain(AUTH_ACTION_IDS.remove);
    expect(text).not.toContain('localhost:3456');
  });

  it('page is forwarded to the builder', async () => {
    await renderAuthCard({ userId: 'U_ADMIN', issuedAt: Date.now(), viewerMode: 'admin', page: 2 });
    expect(buildAuthCardBlocksMock).toHaveBeenCalledWith(expect.objectContaining({ page: 2 }));
  });
});

describe('renderAuthCard — T3 legacy ccp path', () => {
  beforeEach(() => {
    RUNTIME.mode = 'ccp';
  });

  it('passes the EFFECTIVE viewerMode (default readonly, even for admin) to renderCctCard', async () => {
    await renderAuthCard({ userId: 'U_ADMIN', issuedAt: Date.now() });
    expect(renderCctCard).toHaveBeenCalledTimes(1);
    expect(renderCctCard).toHaveBeenCalledWith(expect.objectContaining({ userId: 'U_ADMIN', viewerMode: 'readonly' }));
  });

  it('admin explicit admin mode flows through to renderCctCard', async () => {
    await renderAuthCard({ userId: 'U_ADMIN', issuedAt: Date.now(), viewerMode: 'admin' });
    expect(renderCctCard).toHaveBeenCalledWith(expect.objectContaining({ userId: 'U_ADMIN', viewerMode: 'admin' }));
  });

  it('non-admin forged admin mode is demoted before reaching renderCctCard', async () => {
    await renderAuthCard({ userId: 'U_PLAIN', issuedAt: Date.now(), viewerMode: 'admin' });
    expect(renderCctCard).toHaveBeenCalledWith(expect.objectContaining({ userId: 'U_PLAIN', viewerMode: 'readonly' }));
  });

  it('appends the auth navigation AFTER the CCT blocks (readonly admin default)', async () => {
    const card = await renderAuthCard({ userId: 'U_ADMIN', issuedAt: Date.now() });
    expect(buildAuthNavigationBlocksMock).toHaveBeenCalledTimes(1);
    expect(buildAuthNavigationBlocksMock).toHaveBeenCalledWith('readonly', true, 0, 1);
    const blocks = card.blocks as Array<{ block_id?: string }>;
    const cctIdx = blocks.findIndex((b) => b.block_id === 'cct_body_stub');
    const navIdx = blocks.findIndex((b) => b.block_id === 'auth_nav_stub');
    expect(cctIdx).toBeGreaterThanOrEqual(0);
    expect(navIdx).toBeGreaterThan(cctIdx);
  });

  it('navigation reflects the effective mode + canManage for a non-admin viewer', async () => {
    await renderAuthCard({ userId: 'U_PLAIN', issuedAt: Date.now(), viewerMode: 'admin', page: 4 });
    expect(buildAuthNavigationBlocksMock).toHaveBeenCalledWith('readonly', false, 4, 1);
  });
});
