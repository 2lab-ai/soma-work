// resolveThemeInput is an instance method on UserSettingsStore.
// We can instantiate a throwaway store pointed at a temp dir to test it.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { modelCatalog } from '../model-catalog';
import {
  AVAILABLE_MODELS,
  COMPACT_THRESHOLD_MAX,
  COMPACT_THRESHOLD_MIN,
  coerceToAvailableModel,
  DEFAULT_COMPACT_THRESHOLD,
  DEFAULT_MODEL,
  GOAL_MAX_CONTINUATIONS_MAX,
  GOAL_MAX_CONTINUATIONS_MIN,
  MODEL_ALIASES,
  migrateLegacyTheme,
  UserSettingsStore,
  validateCompactThreshold,
  validateGoalMaxContinuations,
} from '../user-settings-store';

function makeStore(): UserSettingsStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uss-test-'));
  return new UserSettingsStore(dir);
}

describe('Slack display-name identity (cross-user skill resolution)', () => {
  it('stores slackDisplayName + exposes it via getAllUsers', () => {
    const s = makeStore();
    s.setUserSlackDisplayName('U094E5L4A15', 'Z');
    const rec = s.getAllUsers().find((u) => u.userId === 'U094E5L4A15');
    expect(rec?.slackDisplayName).toBe('Z');
    expect(typeof rec?.slackIdentitySyncedAt).toBe('number');
  });

  it('shouldRefreshSlackIdentity: true when never synced, false right after a sync', () => {
    const s = makeStore();
    expect(s.shouldRefreshSlackIdentity('U1', 1000)).toBe(true); // never synced
    s.setUserSlackDisplayName('U1', 'Z');
    expect(s.shouldRefreshSlackIdentity('U1', 60_000)).toBe(false); // just synced
  });

  it('shouldRefreshSlackIdentity: true once the TTL has elapsed', () => {
    const s = makeStore();
    s.setUserSlackDisplayName('U1', 'Z');
    expect(s.shouldRefreshSlackIdentity('U1', -1)).toBe(true); // negative ttl ⇒ always stale
  });
});

// Issue #656 — 1M context variants + allow-list regression guards.
//
// The killshot that felled PR #652 was a silent shrinking of the user-facing
// allow-list: 6 → 4 entries, deleting `claude-sonnet-4-6`,
// `claude-sonnet-4-5-*`, `claude-opus-4-5-*`, and `claude-haiku-4-5-*`. These
// tests assert the **exact** expected arrays/records, not just the length,
// so any future silent removal is caught immediately.
describe('Issue #656 — AVAILABLE_MODELS + MODEL_ALIASES (exact-set guards)', () => {
  it('AVAILABLE_MODELS is exactly 20 entries in the expected order', () => {
    // Fable 5 (2026-06-09) leads as the flagship; Opus 5 (2026-08-26) heads the
    // opus tier so substring matchers see it before 4.8/4.7. The `[1m]` block
    // now carries the literal `claude-fable-5[1m]` and `gpt-5.6-sol[1m]` — the
    // suffix is what makes Claude Code's own accounting use a 1M denominator,
    // which the 750k/600k auto-compact defaults depend on. `grok-4.6` is
    // declared statically so a cold start with no llmux catalog snapshot can
    // still select it. Historical entries MUST survive every bump.
    expect([...AVAILABLE_MODELS]).toEqual([
      'claude-fable-5',
      'claude-opus-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'claude-sonnet-4-5-20250929',
      'claude-opus-4-5-20251101',
      'claude-haiku-4-5-20251001',
      'claude-fable-5[1m]',
      'claude-opus-5[1m]',
      'claude-opus-4-8[1m]',
      'claude-opus-4-7[1m]',
      'claude-opus-4-6[1m]',
      'gpt-5.5',
      'gpt-5.6-sol',
      'gpt-5.6-sol[1m]',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'grok-4.6',
    ]);
  });

  it('AVAILABLE_MODELS carries the literal claude-fable-5[1m] variant', () => {
    // Superseded 2026-08-26: the old guard FORBADE this id, on the theory that
    // the SDK `[1m]` path would inject the opus beta header for a native-1M
    // model. The live llmux probe disproved it — literal `claude-fable-5[1m]`
    // is accepted upstream AND is the only spelling for which Claude Code
    // reports contextWindow=1,000,000 (bare `fable` reports 200,000). Both
    // spellings stay selectable; the aliases point at the literal one.
    expect(AVAILABLE_MODELS as readonly string[]).toContain('claude-fable-5[1m]');
    expect(AVAILABLE_MODELS as readonly string[]).toContain('claude-fable-5');
  });

  it('MODEL_ALIASES has exactly the 28 expected key→value mappings', () => {
    // `fable` / `fable[1m]` → the literal 1M id. `opus` / `opus[1m]` follow
    // "latest opus" semantics → Opus 5, and both land on the `[1m]` variant
    // because that is the id whose client-side denominator is 1M. Version-
    // pinned aliases (`opus-4.8`, `opus-4.7`, ...) remain pinned.
    expect(MODEL_ALIASES).toEqual({
      fable: 'claude-fable-5[1m]',
      'fable-5': 'claude-fable-5[1m]',
      'fable[1m]': 'claude-fable-5[1m]',
      'fable-5[1m]': 'claude-fable-5[1m]',
      sonnet: 'claude-sonnet-4-6',
      'sonnet-4.6': 'claude-sonnet-4-6',
      'sonnet-4.5': 'claude-sonnet-4-5-20250929',
      opus: 'claude-opus-5[1m]',
      'opus-5': 'claude-opus-5',
      'opus-4.8': 'claude-opus-4-8',
      'opus-4.7': 'claude-opus-4-7',
      'opus-4.6': 'claude-opus-4-6',
      'opus-4.5': 'claude-opus-4-5-20251101',
      haiku: 'claude-haiku-4-5-20251001',
      'haiku-4.5': 'claude-haiku-4-5-20251001',
      gpt: 'gpt-5.6-sol',
      'gpt5.5': 'gpt-5.5',
      'gpt-5.6': 'gpt-5.6-sol',
      'gpt5.6': 'gpt-5.6-sol',
      sol: 'gpt-5.6-sol',
      'sol[1m]': 'gpt-5.6-sol[1m]',
      terra: 'gpt-5.6-terra',
      luna: 'gpt-5.6-luna',
      'opus[1m]': 'claude-opus-5[1m]',
      'opus-5[1m]': 'claude-opus-5[1m]',
      'opus-4.8[1m]': 'claude-opus-4-8[1m]',
      'opus-4.7[1m]': 'claude-opus-4-7[1m]',
      'opus-4.6[1m]': 'claude-opus-4-6[1m]',
    });
  });

  it('DEFAULT_MODEL is a member of AVAILABLE_MODELS', () => {
    expect(AVAILABLE_MODELS as readonly string[]).toContain(DEFAULT_MODEL);
  });
});

describe('Issue #656 — getModelDisplayName covers every AVAILABLE_MODELS entry', () => {
  const store = makeStore();
  for (const model of AVAILABLE_MODELS) {
    it(`returns a non-empty label for '${model}' (not the raw id)`, () => {
      const label = store.getModelDisplayName(model);
      expect(label).toBeTruthy();
      expect(label.length).toBeGreaterThan(0);
      // Display labels are curated (e.g. "Opus 4.7"); they must not equal
      // the raw model id string itself. A `default` branch leaking the raw
      // id back means we forgot to add a case.
      expect(label).not.toBe(model);
    });
  }

  it("appends ' (1M)' to [1m] variant labels", () => {
    const store = makeStore();
    expect(store.getModelDisplayName('claude-opus-4-7[1m]')).toBe('Opus 4.7 (1M)');
    expect(store.getModelDisplayName('claude-opus-4-6[1m]')).toBe('Opus 4.6 (1M)');
  });
});

describe('Issue #656 — coerceToAvailableModel', () => {
  it('passes through every known AVAILABLE_MODELS entry unchanged', () => {
    for (const model of AVAILABLE_MODELS) {
      expect(coerceToAvailableModel(model)).toBe(model);
    }
  });

  it('lowercases uppercase [1M] typo → [1m] (case-insensitive round-trip)', () => {
    expect(coerceToAvailableModel('claude-opus-4-7[1M]')).toBe('claude-opus-4-7[1m]');
    expect(coerceToAvailableModel('claude-opus-4-6[1M]')).toBe('claude-opus-4-6[1m]');
  });

  it('trims surrounding whitespace then passes through', () => {
    expect(coerceToAvailableModel('  claude-sonnet-4-6  ')).toBe('claude-sonnet-4-6');
    expect(coerceToAvailableModel('\tclaude-opus-4-7[1m]\n')).toBe('claude-opus-4-7[1m]');
  });

  it('preserves legacy-but-still-valid opus-4-5 (NOT forced to DEFAULT)', () => {
    // Regression guard: previous code in loadSettings force-reset opus-4-5 to
    // DEFAULT. #656 keeps it as a valid allow-list member.
    expect(coerceToAvailableModel('claude-opus-4-5-20251101')).toBe('claude-opus-4-5-20251101');
  });

  it('coerces unknown / garbage values to DEFAULT_MODEL', () => {
    expect(coerceToAvailableModel('bogus-model')).toBe(DEFAULT_MODEL);
    expect(coerceToAvailableModel('claude-sonnet-3-5')).toBe(DEFAULT_MODEL);
  });

  it('handles null / undefined / empty / non-string inputs safely', () => {
    expect(coerceToAvailableModel(null)).toBe(DEFAULT_MODEL);
    expect(coerceToAvailableModel(undefined)).toBe(DEFAULT_MODEL);
    expect(coerceToAvailableModel('')).toBe(DEFAULT_MODEL);
    expect(coerceToAvailableModel('   ')).toBe(DEFAULT_MODEL);
  });
});

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

describe('autogoal mode (S2) + goal max-continuations (S4)', () => {
  it('autogoal defaults to false and toggles per-user', () => {
    const store = makeStore();
    expect(store.getUserAutoGoalEnabled('U1')).toBe(false);
    expect(store.toggleUserAutoGoalEnabled('U1')).toBe(true);
    expect(store.getUserAutoGoalEnabled('U1')).toBe(true);
    expect(store.toggleUserAutoGoalEnabled('U1')).toBe(false);
    store.setUserAutoGoalEnabled('U2', true);
    expect(store.getUserAutoGoalEnabled('U1')).toBe(false);
    expect(store.getUserAutoGoalEnabled('U2')).toBe(true);
  });

  it('validateGoalMaxContinuations clamps to [1, 1000] and rejects non-integers', () => {
    expect(validateGoalMaxContinuations(100)).toBe(100);
    expect(validateGoalMaxContinuations(5000)).toBe(GOAL_MAX_CONTINUATIONS_MAX);
    expect(validateGoalMaxContinuations(0)).toBe(GOAL_MAX_CONTINUATIONS_MIN);
    expect(() => validateGoalMaxContinuations(1.5)).toThrow();
    expect(() => validateGoalMaxContinuations('x' as unknown as number)).toThrow();
  });

  it('goal max-continuations is undefined until set, then persists per-user', () => {
    const store = makeStore();
    expect(store.getUserGoalMaxContinuations('U1')).toBeUndefined();
    store.setUserGoalMaxContinuations('U1', 50);
    expect(store.getUserGoalMaxContinuations('U1')).toBe(50);
    expect(store.getUserGoalMaxContinuations('U2')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// llmux model catalog — catalog-aware selection (grok-4.5)
//
// The static AVAILABLE_MODELS allow-list above stays byte-identical (#656);
// the catalog is a runtime OVERLAY that extends selection. These tests use
// the modelCatalog test hooks to seed/clear the overlay.
// ---------------------------------------------------------------------------
describe('llmux model catalog overlay (grok-4.5 selection)', () => {
  const GROK = {
    id: 'grok-4.5',
    aliases: ['grok'],
    name: 'Grok 4.5',
    efforts: ['low', 'medium', 'high'],
    max_context: 500_000,
    group: 'grok',
  };

  afterEach(() => {
    modelCatalog.__testReset();
  });

  it("resolveModelInput('grok') resolves via the catalog alias", () => {
    modelCatalog.__testSeed([GROK]);
    const store = makeStore();
    expect(store.resolveModelInput('grok')).toBe('grok-4.5');
  });

  it("resolveModelInput('grok-4.5') resolves the catalog id", () => {
    modelCatalog.__testSeed([GROK]);
    const store = makeStore();
    expect(store.resolveModelInput('grok-4.5')).toBe('grok-4.5');
  });

  it('static ids/aliases still win over the catalog', () => {
    modelCatalog.__testSeed([GROK]);
    const store = makeStore();
    expect(store.resolveModelInput('opus')).toBe('claude-opus-5[1m]');
    expect(store.resolveModelInput('gpt-5.6-sol')).toBe('gpt-5.6-sol');
  });

  it("coerceToAvailableModel('grok-4.5') preserves the catalog id (not DEFAULT_MODEL)", () => {
    modelCatalog.__testSeed([GROK]);
    expect(coerceToAvailableModel('grok-4.5')).toBe('grok-4.5');
  });

  it("getModelDisplayName('grok-4.5') uses the catalog display name", () => {
    modelCatalog.__testSeed([GROK]);
    const store = makeStore();
    expect(store.getModelDisplayName('grok-4.5')).toBe('Grok 4.5');
  });

  it('with the catalog empty, unknown ids still coerce to DEFAULT_MODEL', () => {
    expect(coerceToAvailableModel('grok-4.5')).toBe(DEFAULT_MODEL);
    const store = makeStore();
    expect(store.resolveModelInput('grok')).toBeNull();
    expect(store.getModelDisplayName('grok-4.5')).toBe('grok-4.5');
  });

  it('the `[1m]` fable catalog variant IS selectable (2026-08-26 probe supersedes the old filter)', () => {
    // Superseded: `isCatalogIdSelectable` used to drop `claude-fable-5[1m]`.
    // The live llmux probe showed the literal id is accepted upstream and is
    // the ONLY spelling for which the client reports a 1M denominator, so the
    // filter is gone and the id is both catalog- and statically-selectable.
    modelCatalog.__testSeed([
      {
        id: 'claude-fable-5[1m]',
        aliases: [],
        name: 'Claude Fable 5',
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        max_context: 1_000_000,
        group: 'claude',
      },
      GROK,
    ]);
    const store = makeStore();
    expect(store.resolveModelInput('claude-fable-5[1m]')).toBe('claude-fable-5[1m]');
    expect(coerceToAvailableModel('claude-fable-5[1m]')).toBe('claude-fable-5[1m]');
    // Opus [1m] variants stay selectable (static list) and grok is untouched.
    expect(store.resolveModelInput('claude-opus-4-8[1m]')).toBe('claude-opus-4-8[1m]');
    expect(store.resolveModelInput('grok-4.5')).toBe('grok-4.5');
  });
});

// ---------------------------------------------------------------------------
// Fake `grok-*[1m]` inputs (2026-08-26). llmux's grok provider forwards any
// `grok-*` id VERBATIM upstream, so `grok-4.6[1m]` would reach xAI as a model
// name that does not exist — and silently rewriting it to `grok-4.6` would
// serve a different model than the one asked for. The store must therefore
// distinguish REJECTED (visible, with a suggestion) from UNKNOWN (typo).
// ---------------------------------------------------------------------------
describe('model input resolution — accepted / rejected / unknown', () => {
  afterEach(() => {
    modelCatalog.__testReset();
  });

  it('accepts the requested aliases and canonical ids', () => {
    const store = makeStore();
    expect(store.resolveModelInput('fable')).toBe('claude-fable-5[1m]');
    expect(store.resolveModelInput('fable[1m]')).toBe('claude-fable-5[1m]');
    expect(store.resolveModelInput('opus')).toBe('claude-opus-5[1m]');
    expect(store.resolveModelInput('opus[1m]')).toBe('claude-opus-5[1m]');
    expect(store.resolveModelInput('opus-5')).toBe('claude-opus-5');
    expect(store.resolveModelInput('sol[1m]')).toBe('gpt-5.6-sol[1m]');
    expect(store.resolveModelInput('grok-4.6')).toBe('grok-4.6');
  });

  it('resolves bare grok-4.6 with NO llmux catalog snapshot loaded', () => {
    // Static declaration, not catalog-derived: a cold start must still be able
    // to select the model whose 450k auto-compact default is declared policy.
    const store = makeStore();
    expect(store.resolveModelInput('grok-4.6')).toBe('grok-4.6');
    expect(coerceToAvailableModel('grok-4.6')).toBe('grok-4.6');
  });

  it('REJECTS grok-4.6[1m] visibly with a `grok-4.6` suggestion', () => {
    const store = makeStore();
    const result = store.resolveModelInputDetailed('grok-4.6[1m]');
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('unreachable');
    expect(result.suggestedModel).toBe('grok-4.6');
    expect(result.rejectedReason).toContain('grok-4.6[1m]');
    expect(result.rejectedReason).toContain('grok-4.6');
  });

  it('never normalizes or persists a fake grok `[1m]` id', () => {
    const store = makeStore();
    expect(store.resolveModelInput('grok-4.6[1m]')).toBeNull();
    expect(coerceToAvailableModel('grok-4.6[1m]')).toBe(DEFAULT_MODEL);
  });

  it('rejects a fake grok `[1m]` id even when the catalog advertises it', () => {
    // Defence in depth: llmux must never be able to make the harness persist
    // an id its own grok provider would forward verbatim to xAI.
    modelCatalog.__testSeed([
      { id: 'grok-4.6[1m]', aliases: [], name: 'Grok 4.6 1M', efforts: ['low'], max_context: 1_000_000, group: 'grok' },
    ]);
    const store = makeStore();
    expect(store.resolveModelInput('grok-4.6[1m]')).toBeNull();
    expect(coerceToAvailableModel('grok-4.6[1m]')).toBe(DEFAULT_MODEL);
  });

  it('does NOT force a catalog refresh for a rejected id (only for unknown ones)', async () => {
    const store = makeStore();
    const refresh = vi.spyOn(modelCatalog, 'refresh').mockResolvedValue(undefined as never);
    try {
      const rejected = await store.resolveModelInputDetailedWithRefresh('grok-4.6[1m]');
      expect(rejected.status).toBe('rejected');
      expect(refresh).not.toHaveBeenCalled();

      const unknown = await store.resolveModelInputDetailedWithRefresh('totally-made-up');
      expect(unknown.status).toBe('unknown');
      expect(refresh).toHaveBeenCalledTimes(1);
    } finally {
      refresh.mockRestore();
    }
  });

  it('reports an unknown typo as `unknown`, not `rejected`', () => {
    const store = makeStore();
    expect(store.resolveModelInputDetailed('opuss').status).toBe('unknown');
    expect(store.resolveModelInputDetailed('').status).toBe('unknown');
  });
});
