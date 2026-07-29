/**
 * `auth` card end-to-end wiring (command → topic → builder).
 *
 * The card the non-admin actually receives must carry the same account
 * info as the admin card: llmux account names + the `current:` account.
 * Only mutating affordances and the settings line stay admin-only.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAdminUsersCache } from '../../../../admin-utils';
import type { AuthRuntimeState } from '../../../../auth/auth-runtime';
import type { LlmuxStatus } from '../../../../auth/llmux-client';
import { AUTH_ACTION_IDS } from '../../../auth/views';
import { renderAuthCard } from '../auth-topic';

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

describe('renderAuthCard — account info is viewer-independent', () => {
  const PREV_ADMIN_USERS = process.env.ADMIN_USERS;

  beforeEach(() => {
    process.env.ADMIN_USERS = 'U_ADMIN';
    resetAdminUsersCache();
  });

  afterEach(() => {
    if (PREV_ADMIN_USERS === undefined) delete process.env.ADMIN_USERS;
    else process.env.ADMIN_USERS = PREV_ADMIN_USERS;
    resetAdminUsersCache();
  });

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
