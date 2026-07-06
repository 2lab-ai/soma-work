import { describe, expect, it } from 'vitest';
import type { AuthRuntimeState } from '../../../auth/auth-runtime';
import type { LlmuxAccount, LlmuxStatus } from '../../../auth/llmux-client';
import {
  buildAuthCardBlocks,
  buildAuthModeHeaderBlocks,
  collectScopedWindows,
  maskSecret,
  readonlySlotLabel,
} from '../builder';
import { AUTH_ACTION_IDS } from '../views';

const RUNTIME_LLMUX: AuthRuntimeState = {
  mode: 'llmux',
  llmux: { baseUrl: 'http://localhost:3456', apiKey: 'proxy-key-xyz1' },
};

const NOW = 1_900_000_000_000; // ms

const STATUS: LlmuxStatus = {
  version: '0.2.11',
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
      five_hour: { utilization: 0.6, resets_at: NOW / 1000 + 3600, resets_in_secs: 3600 },
      seven_day: { utilization: 0.2, resets_at: NOW / 1000 + 400_000, resets_in_secs: 400_000 },
    },
    {
      name: 'claude:other@example.com',
      type: 'oauth',
      group: 'claude',
      status: 'cooldown',
      order: 2,
      blocked: 'cooldown 12m',
      five_hour: { utilization: 0.95, resets_at: NOW / 1000 + 600, resets_in_secs: 600 },
      seven_day: null,
    },
  ],
};

function allText(blocks: unknown[]): string {
  return JSON.stringify(blocks);
}

describe('auth card builder (#llmux runtime switch)', () => {
  it('maskSecret shows last 4 chars only', () => {
    expect(maskSecret('proxy-key-xyz1')).toBe('••••xyz1');
    expect(maskSecret('abc')).toBe('••••');
  });

  it('admin llmux card: mode buttons, settings line, account names, switch/remove/add buttons', () => {
    const blocks = buildAuthCardBlocks({
      runtime: RUNTIME_LLMUX,
      llmuxStatus: STATUS,
      viewerMode: 'admin',
      nowMs: NOW,
    });
    const text = allText(blocks);
    expect(text).toContain(`${AUTH_ACTION_IDS.mode}_llmux`);
    expect(text).toContain(`${AUTH_ACTION_IDS.mode}_ccp`);
    expect(text).toContain(AUTH_ACTION_IDS.settings);
    expect(text).toContain(AUTH_ACTION_IDS.add);
    expect(text).toContain(AUTH_ACTION_IDS.remove);
    expect(text).toContain('claude:me@example.com');
    // Raw key never appears; masked form does.
    expect(text).not.toContain('proxy-key-xyz1');
    expect(text).toContain('••••xyz1');
    // Active account gets no Switch button; the cooldown one does.
    const switchButtons = JSON.stringify(blocks).match(new RegExp(AUTH_ACTION_IDS.switch, 'g')) ?? [];
    expect(switchButtons.length).toBe(1);
    // Usage: 0.6 ratio renders as 60%.
    expect(text).toContain('60%');
  });

  it('readonly llmux card: NO emails, NO mutating buttons, usage + slot count still visible', () => {
    const blocks = buildAuthCardBlocks({
      runtime: RUNTIME_LLMUX,
      llmuxStatus: STATUS,
      viewerMode: 'readonly',
      nowMs: NOW,
    });
    const text = allText(blocks);
    // Requirement 4: emails must not be visible to non-admin.
    expect(text).not.toContain('example.com');
    expect(text).not.toContain('claude:me');
    expect(text).toContain('slot 1 (oauth)');
    expect(text).toContain('slot 2 (oauth)');
    expect(text).toContain('2 slot(s)');
    expect(text).toContain('60%');
    // No mutating affordances (mode switch / settings / add / remove / switch).
    expect(text).not.toContain(AUTH_ACTION_IDS.settings);
    expect(text).not.toContain(AUTH_ACTION_IDS.add);
    expect(text).not.toContain(AUTH_ACTION_IDS.remove);
    expect(text).not.toContain(AUTH_ACTION_IDS.switch);
    expect(text).not.toContain(`${AUTH_ACTION_IDS.mode}_llmux`);
    // Refresh (read-only fetch) stays available.
    expect(text).toContain(AUTH_ACTION_IDS.refresh);
    // Settings line (base URL) is admin-only.
    expect(text).not.toContain('localhost:3456');
  });

  it('unreachable llmux renders the error banner instead of accounts', () => {
    const blocks = buildAuthCardBlocks({
      runtime: RUNTIME_LLMUX,
      llmuxStatus: null,
      llmuxError: 'llmux unreachable at http://localhost:3456 (ECONNREFUSED)',
      viewerMode: 'admin',
      nowMs: NOW,
    });
    const text = allText(blocks);
    expect(text).toContain('llmux unreachable');
    expect(text).not.toContain('slot(s)');
  });

  it('ccp mode header labels cct as legacy and exposes mode buttons for admin only', () => {
    const runtime: AuthRuntimeState = { ...RUNTIME_LLMUX, mode: 'ccp' };
    const admin = allText(buildAuthModeHeaderBlocks(runtime, 'admin'));
    expect(admin).toContain('cct (legacy)');
    expect(admin).toContain(`${AUTH_ACTION_IDS.mode}_llmux`);
    const readonly = allText(buildAuthModeHeaderBlocks(runtime, 'readonly'));
    expect(readonly).not.toContain(`${AUTH_ACTION_IDS.mode}_llmux`);
  });

  it('readonlySlotLabel never includes the account name', () => {
    expect(readonlySlotLabel(STATUS.accounts[0])).toBe('slot 1 (oauth)');
  });
});

/**
 * Model-scoped weekly windows (llmux `fable_weekly` / `scoped_limits[]`) —
 * the auth card must surface every usage window llmux emits, not just 5h/7d.
 */
describe('auth card — scoped weekly usage windows (fable)', () => {
  const FABLE = { utilization: 0.42, resets_at: NOW / 1000 + 200_000, resets_in_secs: 200_000 };

  function accountWith(extra: Partial<LlmuxAccount>): LlmuxAccount {
    return { ...STATUS.accounts[0], ...extra };
  }

  it('collectScopedWindows prefers scoped_limits (labelled 7d-<scope>) over fable_weekly', () => {
    const account = accountWith({
      fable_weekly: { ...FABLE },
      scoped_limits: [{ ...FABLE, scope_label: 'Fable', severity: 'warning', is_active: true }],
    });
    const scoped = collectScopedWindows(account);
    // scoped_limits already contains the Fable entry — fable_weekly must not
    // be double-rendered.
    expect(scoped).toHaveLength(1);
    expect(scoped[0].label).toBe('7d-fable');
  });

  it('collectScopedWindows falls back to fable_weekly when scoped_limits is absent', () => {
    const account = accountWith({ fable_weekly: { ...FABLE } });
    const scoped = collectScopedWindows(account);
    expect(scoped).toHaveLength(1);
    expect(scoped[0].label).toBe('7d-fable');
  });

  it('collectScopedWindows returns [] when llmux emits neither (older llmux)', () => {
    expect(collectScopedWindows(STATUS.accounts[0])).toEqual([]);
    expect(collectScopedWindows(accountWith({ fable_weekly: null, scoped_limits: [] }))).toEqual([]);
  });

  it('renders a 7d-fable bar row with the utilization percent on the card', () => {
    const status: LlmuxStatus = {
      ...STATUS,
      accounts: [
        accountWith({
          scoped_limits: [{ ...FABLE, scope_label: 'Fable', severity: 'warning', is_active: true }],
        }),
        STATUS.accounts[1],
      ],
    };
    const text = allText(
      buildAuthCardBlocks({ runtime: RUNTIME_LLMUX, llmuxStatus: status, viewerMode: 'admin', nowMs: NOW }),
    );
    expect(text).toContain('7d-fable');
    // 0.42 ratio renders as 42%.
    expect(text).toContain('42%');
  });

  it('renders future scoped models generically from scope_label', () => {
    const status: LlmuxStatus = {
      ...STATUS,
      accounts: [
        accountWith({
          scoped_limits: [
            { ...FABLE, scope_label: 'Fable' },
            { ...FABLE, utilization: 0.9, scope_label: 'Vision' },
          ],
        }),
      ],
    };
    const text = allText(
      buildAuthCardBlocks({ runtime: RUNTIME_LLMUX, llmuxStatus: status, viewerMode: 'admin', nowMs: NOW }),
    );
    expect(text).toContain('7d-fable');
    expect(text).toContain('7d-vision');
  });

  it('card without scoped data renders exactly as before (no scoped rows)', () => {
    const text = allText(
      buildAuthCardBlocks({ runtime: RUNTIME_LLMUX, llmuxStatus: STATUS, viewerMode: 'admin', nowMs: NOW }),
    );
    expect(text).not.toContain('7d-fable');
  });
});
