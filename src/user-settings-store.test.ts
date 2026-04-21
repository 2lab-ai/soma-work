// resolveThemeInput is an instance method on UserSettingsStore.
// We can instantiate a throwaway store pointed at a temp dir to test it.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  AVAILABLE_MODELS,
  COMPACT_THRESHOLD_MAX,
  COMPACT_THRESHOLD_MIN,
  DEFAULT_COMPACT_THRESHOLD,
  DEFAULT_MODEL,
  MODEL_ALIASES,
  migrateLegacyTheme,
  UserSettingsStore,
  validateCompactThreshold,
} from './user-settings-store';

function makeStore(): UserSettingsStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uss-test-'));
  return new UserSettingsStore(dir);
}

describe('migrateLegacyTheme', () => {
  it('maps legacy A to minimal', () => {
    expect(migrateLegacyTheme('A')).toBe('minimal');
  });

  it('maps legacy G to default', () => {
    expect(migrateLegacyTheme('G')).toBe('default');
  });

  it('maps legacy C to compact', () => {
    expect(migrateLegacyTheme('C')).toBe('compact');
  });

  it('returns default for unknown input', () => {
    expect(migrateLegacyTheme('unknown')).toBe('default');
  });

  it('returns as-is when already a 3-tier theme', () => {
    expect(migrateLegacyTheme('default')).toBe('default');
  });
});

describe('resolveThemeInput', () => {
  const store = makeStore();

  it('resolves "default" to default', () => {
    expect(store.resolveThemeInput('default')).toBe('default');
  });

  it('resolves "compact" to compact', () => {
    expect(store.resolveThemeInput('compact')).toBe('compact');
  });

  it('resolves "minimal" to minimal', () => {
    expect(store.resolveThemeInput('minimal')).toBe('minimal');
  });

  it('resolves legacy letter A to minimal', () => {
    expect(store.resolveThemeInput('A')).toBe('minimal');
  });

  it('resolves "reset" to reset', () => {
    expect(store.resolveThemeInput('reset')).toBe('reset');
  });
});

describe('Sandbox + network toggles', () => {
  it('defaults sandbox to ON (disabled=false) and network to ON (disabled=false)', () => {
    const store = makeStore();
    expect(store.getUserSandboxDisabled('U1')).toBe(false);
    expect(store.getUserNetworkDisabled('U1')).toBe(false);
  });

  it('persists sandboxDisabled + networkDisabled independently', () => {
    const store = makeStore();
    store.setUserSandboxDisabled('U1', true);
    store.setUserNetworkDisabled('U1', true);
    expect(store.getUserSandboxDisabled('U1')).toBe(true);
    expect(store.getUserNetworkDisabled('U1')).toBe(true);

    store.setUserNetworkDisabled('U1', false);
    expect(store.getUserSandboxDisabled('U1')).toBe(true);
    expect(store.getUserNetworkDisabled('U1')).toBe(false);
  });

  it('keeps settings isolated per user', () => {
    const store = makeStore();
    store.setUserNetworkDisabled('U1', true);
    expect(store.getUserNetworkDisabled('U1')).toBe(true);
    expect(store.getUserNetworkDisabled('U2')).toBe(false);
  });

  it('survives a reload from disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uss-reload-'));
    const s1 = new UserSettingsStore(dir);
    s1.setUserNetworkDisabled('U1', true);
    s1.setUserSandboxDisabled('U1', true);

    const s2 = new UserSettingsStore(dir);
    expect(s2.getUserSandboxDisabled('U1')).toBe(true);
    expect(s2.getUserNetworkDisabled('U1')).toBe(true);
  });
});

describe('updateUserJiraInfo (regression: must not reset unrelated fields)', () => {
  // Before the patchUserSettings refactor, updateUserJiraInfo overwrote the
  // whole settings record — silently zeroing out sandboxDisabled,
  // networkDisabled, sessionTheme, notifications, etc. This test pins the
  // new behaviour so we never regress.
  it('preserves sandboxDisabled + networkDisabled when syncing Jira info', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uss-jira-'));

    // Seed Slack↔Jira mapping on disk before constructing the store.
    const mappingFile = path.join(dir, 'slack_jira_mapping.json');
    fs.writeFileSync(
      mappingFile,
      JSON.stringify({ U1: { jiraAccountId: 'jira-U1', name: 'Alice', slackName: 'alice' } }, null, 2),
      'utf8',
    );

    const store = new UserSettingsStore(dir);
    store.setUserSandboxDisabled('U1', true);
    store.setUserNetworkDisabled('U1', true);
    store.setUserEmail('U1', 'alice@example.com');

    const changed = store.updateUserJiraInfo('U1', 'alice');
    expect(changed).toBe(true);

    // Jira fields updated …
    expect(store.getUserJiraAccountId('U1')).toBe('jira-U1');
    expect(store.getUserJiraName('U1')).toBe('Alice');
    // … but unrelated fields must still be intact.
    expect(store.getUserSandboxDisabled('U1')).toBe(true);
    expect(store.getUserNetworkDisabled('U1')).toBe(true);
    expect(store.getUserEmail('U1')).toBe('alice@example.com');
  });
});

// #617 — Compaction Tracking + Per-User Threshold
// Covers AC1 (validation + persistence 50–95) and AC2 (default=80 when unset).
describe('validateCompactThreshold (#617 AC1)', () => {
  it('AC1: rejects 49 (below min)', () => {
    expect(() => validateCompactThreshold(49)).toThrow(/50, 95/);
  });

  it('AC1: accepts 50 (lower boundary)', () => {
    expect(validateCompactThreshold(50)).toBe(50);
  });

  it('AC1: accepts 80 (mid-range)', () => {
    expect(validateCompactThreshold(80)).toBe(80);
  });

  it('AC1: accepts 95 (upper boundary)', () => {
    expect(validateCompactThreshold(95)).toBe(95);
  });

  it('AC1: rejects 96 (above max)', () => {
    expect(() => validateCompactThreshold(96)).toThrow(/50, 95/);
  });

  it('AC1: rejects non-numeric "abc" (type guard)', () => {
    expect(() => validateCompactThreshold('abc')).toThrow(/integer/);
  });

  it('AC1: rejects fractional 3.5 (integer guard)', () => {
    expect(() => validateCompactThreshold(3.5)).toThrow(/integer/);
  });

  it('AC1: rejects fractional 80.5 even if inside range (integer guard)', () => {
    expect(() => validateCompactThreshold(80.5)).toThrow(/integer/);
  });

  it('AC1: exposes MIN=50, MAX=95 constants', () => {
    expect(COMPACT_THRESHOLD_MIN).toBe(50);
    expect(COMPACT_THRESHOLD_MAX).toBe(95);
  });
});

describe('UserSettingsStore.getUserCompactThreshold / setUserCompactThreshold (#617 AC1, AC2)', () => {
  it('AC2: returns DEFAULT_COMPACT_THRESHOLD=80 when user has no settings', () => {
    const store = makeStore();
    expect(DEFAULT_COMPACT_THRESHOLD).toBe(80);
    expect(store.getUserCompactThreshold('U_NEW')).toBe(80);
  });

  it('AC2: returns 80 when user exists but compactThreshold is unset', () => {
    const store = makeStore();
    // Seed unrelated field so the record exists without compactThreshold.
    store.setUserSandboxDisabled('U1', true);
    expect(store.getUserCompactThreshold('U1')).toBe(80);
  });

  it('AC1: persists a valid threshold via setUserCompactThreshold', () => {
    const store = makeStore();
    store.setUserCompactThreshold('U1', 70);
    expect(store.getUserCompactThreshold('U1')).toBe(70);
  });

  it('AC1: round-trips across store reloads', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uss-compact-'));
    const s1 = new UserSettingsStore(dir);
    s1.setUserCompactThreshold('U1', 65);

    const s2 = new UserSettingsStore(dir);
    expect(s2.getUserCompactThreshold('U1')).toBe(65);
  });

  it('AC1: setUserCompactThreshold throws on out-of-range (30) and does not persist', () => {
    const store = makeStore();
    expect(() => store.setUserCompactThreshold('U1', 30)).toThrow();
    expect(store.getUserCompactThreshold('U1')).toBe(80); // default, not persisted
  });

  it('AC1: setUserCompactThreshold throws on 100 (above max) and does not persist', () => {
    const store = makeStore();
    expect(() => store.setUserCompactThreshold('U1', 100)).toThrow();
    expect(store.getUserCompactThreshold('U1')).toBe(80);
  });

  it('AC1: threshold is per-user isolated', () => {
    const store = makeStore();
    store.setUserCompactThreshold('U1', 60);
    store.setUserCompactThreshold('U2', 90);
    expect(store.getUserCompactThreshold('U1')).toBe(60);
    expect(store.getUserCompactThreshold('U2')).toBe(90);
  });
});

// #648 — Context window via `[1m]` model suffix
describe('AVAILABLE_MODELS + MODEL_ALIASES (#648)', () => {
  it('exposes exactly 4 user-facing models (opus 4.6/4.7 × {bare,[1m]})', () => {
    expect(AVAILABLE_MODELS).toEqual([
      'claude-opus-4-6',
      'claude-opus-4-6[1m]',
      'claude-opus-4-7',
      'claude-opus-4-7[1m]',
    ]);
  });

  it('keeps DEFAULT_MODEL as bare claude-opus-4-7 (200k)', () => {
    expect(DEFAULT_MODEL).toBe('claude-opus-4-7');
  });

  it('MODEL_ALIASES contains only opus-keyed aliases (S20)', () => {
    expect(Object.keys(MODEL_ALIASES).sort()).toEqual(
      ['opus', 'opus-4.6', 'opus-4.6[1m]', 'opus-4.7', 'opus-4.7[1m]', 'opus[1m]'].sort(),
    );
  });

  it('MODEL_ALIASES has no legacy sonnet/haiku/4.5 keys', () => {
    const keys = Object.keys(MODEL_ALIASES);
    expect(keys).not.toContain('sonnet');
    expect(keys).not.toContain('sonnet-4.6');
    expect(keys).not.toContain('sonnet-4.5');
    expect(keys).not.toContain('opus-4.5');
    expect(keys).not.toContain('haiku');
    expect(keys).not.toContain('haiku-4.5');
  });
});

describe('resolveModelInput (#648)', () => {
  it('returns suffixed form intact for canonical id', () => {
    const store = makeStore();
    expect(store.resolveModelInput('claude-opus-4-7[1m]')).toBe('claude-opus-4-7[1m]');
  });

  it('returns bare form for bare canonical id', () => {
    const store = makeStore();
    expect(store.resolveModelInput('claude-opus-4-7')).toBe('claude-opus-4-7');
  });

  it('resolves opus alias to bare model', () => {
    const store = makeStore();
    expect(store.resolveModelInput('opus')).toBe('claude-opus-4-7');
  });

  it('resolves opus[1m] alias to suffixed model', () => {
    const store = makeStore();
    expect(store.resolveModelInput('opus[1m]')).toBe('claude-opus-4-7[1m]');
  });

  it('is case-insensitive on alias + suffix', () => {
    const store = makeStore();
    expect(store.resolveModelInput('OPUS-4.6[1M]')).toBe('claude-opus-4-6[1m]');
  });

  it('returns null for unknown / legacy aliases', () => {
    const store = makeStore();
    expect(store.resolveModelInput('sonnet')).toBeNull();
    expect(store.resolveModelInput('haiku')).toBeNull();
    expect(store.resolveModelInput('claude-sonnet-4-6')).toBeNull();
    expect(store.resolveModelInput('does-not-exist')).toBeNull();
  });
});

describe('getModelDisplayName (#648)', () => {
  const store = makeStore();

  it('renders bare + [1m] pairs with "(1M)" suffix on the latter', () => {
    expect(store.getModelDisplayName('claude-opus-4-7')).toBe('Opus 4.7');
    expect(store.getModelDisplayName('claude-opus-4-7[1m]')).toBe('Opus 4.7 (1M)');
    expect(store.getModelDisplayName('claude-opus-4-6')).toBe('Opus 4.6');
    expect(store.getModelDisplayName('claude-opus-4-6[1m]')).toBe('Opus 4.6 (1M)');
  });

  it('falls back gracefully for unknown [1m] string (strip + recurse + append)', () => {
    // Transient state between pre-deploy persistence and post-deploy coerce:
    // an unknown bare model with a [1m] suffix should still render reasonably.
    // We can't hit this without bypassing the type system, so use an `as any`.
    expect(store.getModelDisplayName('claude-opus-4-7[1m]' as never)).toBe('Opus 4.7 (1M)');
  });
});

describe('UserSettingsStore model persistence (#648)', () => {
  it('silently resets legacy defaultModel (claude-sonnet-4-6) on load', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uss-648-legacy-'));
    const settingsFile = path.join(dir, 'user-settings.json');
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          U1: {
            userId: 'U1',
            defaultDirectory: '',
            bypassPermission: false,
            persona: 'default',
            defaultModel: 'claude-sonnet-4-6',
            accepted: true,
            lastUpdated: '2026-04-20T00:00:00.000Z',
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const store = new UserSettingsStore(dir);
    expect(store.getUserDefaultModel('U1')).toBe(DEFAULT_MODEL);
    // And it was persisted — reloading yields the same coerced value.
    const store2 = new UserSettingsStore(dir);
    expect(store2.getUserDefaultModel('U1')).toBe(DEFAULT_MODEL);
  });

  it('preserves [1m] defaultModel across load → save → reload', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uss-648-1m-'));
    const store = new UserSettingsStore(dir);
    store.setUserDefaultModel('U1', 'claude-opus-4-7[1m]');

    const reloaded = new UserSettingsStore(dir);
    expect(reloaded.getUserDefaultModel('U1')).toBe('claude-opus-4-7[1m]');
  });
});
