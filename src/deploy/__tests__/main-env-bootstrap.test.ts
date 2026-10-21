import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AVAILABLE_MODELS, DEFAULT_MODEL as STORE_DEFAULT_MODEL } from '../../user-settings-store';
import {
  __TEST_ONLY_coerceModel,
  __TEST_ONLY_VALID_MODELS,
  bootstrapMainEnvironment,
  normalizeMainTargetData,
} from '../main-env-bootstrap';

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

describe('main-env-bootstrap', () => {
  const tempDirs: string[] = [];

  function makeTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('bootstraps main target from dev and legacy sources', async () => {
    const devSourceDir = makeTempDir('bootstrap-dev-');
    const legacyRootDir = makeTempDir('bootstrap-legacy-');
    const targetDir = makeTempDir('bootstrap-target-');
    const normalize = vi.fn().mockResolvedValue(undefined);

    fs.rmSync(targetDir, { recursive: true, force: true });

    fs.writeFileSync(path.join(devSourceDir, '.system.prompt'), 'prompt', 'utf8');
    writeJson(path.join(devSourceDir, 'config.json'), { plugin: { enabled: true } });

    fs.writeFileSync(path.join(legacyRootDir, '.env'), 'SLACK_BOT_TOKEN=xoxb-test\n', 'utf8');
    writeJson(path.join(legacyRootDir, 'data', 'user-settings.json'), {
      U1: {
        userId: 'U1',
        defaultDirectory: '',
        bypassPermission: false,
        persona: 'default',
        defaultModel: 'claude-opus-4-6',
        lastUpdated: '2026-03-12T00:00:00.000Z',
      },
    });

    const result = await bootstrapMainEnvironment({
      devSourceDir,
      legacyRootDir,
      targetDir,
      normalize,
      now: () => new Date('2026-03-12T12:00:00.000Z'),
    });

    expect(result.bootstrapped).toBe(true);
    expect(result.skipped).toBe(false);
    expect(fs.readFileSync(path.join(targetDir, '.system.prompt'), 'utf8')).toBe('prompt');
    expect(fs.readFileSync(path.join(targetDir, '.env'), 'utf8')).toContain('SLACK_BOT_TOKEN=xoxb-test');
    expect(fs.existsSync(path.join(targetDir, 'logs'))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, 'data', 'user-settings.json'))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, '.main-bootstrap.json'))).toBe(true);
    expect(normalize).toHaveBeenCalledWith(targetDir);
  });

  it('skips bootstrap when marker already exists', async () => {
    const devSourceDir = makeTempDir('bootstrap-dev-');
    const legacyRootDir = makeTempDir('bootstrap-legacy-');
    const targetDir = makeTempDir('bootstrap-target-');
    const normalize = vi.fn().mockResolvedValue(undefined);

    fs.writeFileSync(path.join(devSourceDir, '.system.prompt'), 'prompt', 'utf8');
    fs.writeFileSync(path.join(legacyRootDir, '.env'), 'SLACK_BOT_TOKEN=legacy\n', 'utf8');
    fs.mkdirSync(path.join(legacyRootDir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(targetDir, '.env'), 'SLACK_BOT_TOKEN=current\n', 'utf8');
    writeJson(path.join(targetDir, '.main-bootstrap.json'), {
      completedAt: '2026-03-12T00:00:00.000Z',
    });

    const result = await bootstrapMainEnvironment({
      devSourceDir,
      legacyRootDir,
      targetDir,
      normalize,
    });

    expect(result.bootstrapped).toBe(false);
    expect(result.skipped).toBe(true);
    expect(fs.readFileSync(path.join(targetDir, '.env'), 'utf8')).toContain('SLACK_BOT_TOKEN=current');
    expect(normalize).not.toHaveBeenCalled();
  });

  it('adopts an already-provisioned target whose marker was lost (rewrites marker, skips copy)', async () => {
    // Regression guard for the prod deploy failure: an older deploy's
    // `rsync --delete` wiped `.main-bootstrap.json` (it was not in
    // protected-paths.txt), so the next deploy saw a non-empty target with no
    // marker. Bootstrap must adopt it — rewrite the marker and preserve live
    // data — instead of throwing.
    const devSourceDir = makeTempDir('bootstrap-dev-');
    const legacyRootDir = makeTempDir('bootstrap-legacy-');
    const targetDir = makeTempDir('bootstrap-target-');
    const normalize = vi.fn().mockResolvedValue(undefined);

    // Seed/legacy sources intentionally left missing — an adopt must not need them.

    // Target already carries the protected runtime files a prior bootstrap left.
    fs.writeFileSync(path.join(targetDir, '.env'), 'SLACK_BOT_TOKEN=live\n', 'utf8');
    writeJson(path.join(targetDir, 'config.json'), { plugin: { enabled: true } });
    writeJson(path.join(targetDir, 'data', 'user-settings.json'), { U1: { userId: 'U1' } });

    const result = await bootstrapMainEnvironment({
      devSourceDir,
      legacyRootDir,
      targetDir,
      normalize,
      now: () => new Date('2026-06-17T13:00:00.000Z'),
    });

    expect(result.bootstrapped).toBe(false);
    expect(result.skipped).toBe(true);
    // Marker rewritten so subsequent deploys skip cleanly.
    expect(fs.existsSync(path.join(targetDir, '.main-bootstrap.json'))).toBe(true);
    // Live data untouched (no clobber, no copy from seed/legacy).
    expect(fs.readFileSync(path.join(targetDir, '.env'), 'utf8')).toContain('SLACK_BOT_TOKEN=live');
    expect(normalize).not.toHaveBeenCalled();
  });

  it('fails when target is non-empty without marker', async () => {
    const devSourceDir = makeTempDir('bootstrap-dev-');
    const legacyRootDir = makeTempDir('bootstrap-legacy-');
    const targetDir = makeTempDir('bootstrap-target-');

    fs.writeFileSync(path.join(devSourceDir, '.system.prompt'), 'prompt', 'utf8');
    writeJson(path.join(devSourceDir, 'config.json'), { plugin: { enabled: true } });
    fs.writeFileSync(path.join(legacyRootDir, '.env'), 'SLACK_BOT_TOKEN=legacy\n', 'utf8');
    fs.mkdirSync(path.join(legacyRootDir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'unexpected.txt'), 'keep me', 'utf8');

    await expect(
      bootstrapMainEnvironment({
        devSourceDir,
        legacyRootDir,
        targetDir,
      }),
    ).rejects.toThrow(/non-empty target/i);
  });

  it('fails with an actionable message when target parent is not writable', async () => {
    const devSourceDir = makeTempDir('bootstrap-dev-');
    const legacyRootDir = makeTempDir('bootstrap-legacy-');
    const rootDir = makeTempDir('bootstrap-root-');
    const blockedParent = path.join(rootDir, 'blocked');
    const targetDir = path.join(blockedParent, 'main');

    fs.mkdirSync(blockedParent, { recursive: true });
    fs.chmodSync(blockedParent, 0o555);

    fs.writeFileSync(path.join(devSourceDir, '.system.prompt'), 'prompt', 'utf8');
    writeJson(path.join(devSourceDir, 'config.json'), { plugin: { enabled: true } });
    fs.writeFileSync(path.join(legacyRootDir, '.env'), 'SLACK_BOT_TOKEN=legacy\n', 'utf8');
    fs.mkdirSync(path.join(legacyRootDir, 'data'), { recursive: true });

    try {
      await expect(
        bootstrapMainEnvironment({
          devSourceDir,
          legacyRootDir,
          targetDir,
        }),
      ).rejects.toThrow(/pre-create .* and chown it to the runner user/i);
    } finally {
      fs.chmodSync(blockedParent, 0o755);
    }
  });

  it('normalizes legacy user settings and sessions after copy', async () => {
    // Unknown model → DEFAULT_MODEL. opus-4-5-20251101 is still in VALID_MODELS
    // per Issue #656 (KEEP), so use a genuinely-unknown id here to validate the
    // fallback path.
    const targetDir = makeTempDir('bootstrap-target-');

    fs.mkdirSync(path.join(targetDir, 'data'), { recursive: true });
    writeJson(path.join(targetDir, 'data', 'user-settings.json'), {
      U1: {
        userId: 'U1',
        defaultDirectory: '',
        bypassPermission: false,
        persona: 'default',
        defaultModel: 'claude-obsolete-model-v0',
        lastUpdated: '2026-03-12T00:00:00.000Z',
      },
    });
    writeJson(path.join(targetDir, 'data', 'sessions.json'), [
      {
        key: 'C123-thread123',
        userId: 'U1',
        channelId: 'C123',
        threadTs: 'thread123',
        isActive: true,
        lastActivity: new Date().toISOString(),
      },
    ]);

    await normalizeMainTargetData(targetDir);

    const settings = JSON.parse(fs.readFileSync(path.join(targetDir, 'data', 'user-settings.json'), 'utf8'));
    const sessions = JSON.parse(fs.readFileSync(path.join(targetDir, 'data', 'sessions.json'), 'utf8'));

    expect(settings.U1.accepted).toBe(true);
    expect(settings.U1.defaultModel).toBe('gpt-5.6-sol'); // bootstrap DEFAULT_MODEL
    expect(sessions[0].ownerId).toBe('U1');
    expect(sessions[0].state).toBe('MAIN');
    expect(sessions[0].workflow).toBe('default');
  });

  it('preserves opus-4-5-20251101 through normalize (Issue #656: KEEP, not retired)', async () => {
    const targetDir = makeTempDir('bootstrap-target-');

    fs.mkdirSync(path.join(targetDir, 'data'), { recursive: true });
    writeJson(path.join(targetDir, 'data', 'user-settings.json'), {
      U1: {
        userId: 'U1',
        defaultModel: 'claude-opus-4-5-20251101',
        lastUpdated: '2026-03-12T00:00:00.000Z',
        accepted: true,
      },
    });

    await normalizeMainTargetData(targetDir);

    const settings = JSON.parse(fs.readFileSync(path.join(targetDir, 'data', 'user-settings.json'), 'utf8'));
    expect(settings.U1.defaultModel).toBe('claude-opus-4-5-20251101');
  });

  it('preserves stored claude-opus-4-7 setting through normalize', async () => {
    const targetDir = makeTempDir('bootstrap-target-');

    fs.mkdirSync(path.join(targetDir, 'data'), { recursive: true });
    writeJson(path.join(targetDir, 'data', 'user-settings.json'), {
      U1: {
        userId: 'U1',
        defaultDirectory: '',
        bypassPermission: false,
        persona: 'default',
        defaultModel: 'claude-opus-4-7',
        lastUpdated: '2026-03-12T00:00:00.000Z',
        accepted: true,
      },
    });

    await normalizeMainTargetData(targetDir);

    const settings = JSON.parse(fs.readFileSync(path.join(targetDir, 'data', 'user-settings.json'), 'utf8'));
    expect(settings.U1.defaultModel).toBe('claude-opus-4-7');
  });

  it('preserves stored claude-opus-4-6 setting through normalize', async () => {
    const targetDir = makeTempDir('bootstrap-target-');

    fs.mkdirSync(path.join(targetDir, 'data'), { recursive: true });
    writeJson(path.join(targetDir, 'data', 'user-settings.json'), {
      U1: {
        userId: 'U1',
        defaultDirectory: '',
        bypassPermission: false,
        persona: 'default',
        defaultModel: 'claude-opus-4-6',
        lastUpdated: '2026-03-12T00:00:00.000Z',
        accepted: true,
      },
    });

    await normalizeMainTargetData(targetDir);

    const settings = JSON.parse(fs.readFileSync(path.join(targetDir, 'data', 'user-settings.json'), 'utf8'));
    expect(settings.U1.defaultModel).toBe('claude-opus-4-6');
  });

  it('VALID_MODELS + DEFAULT_MODEL stay in sync with user-settings-store canonical list', async () => {
    // Bootstrap duplicates these constants (to keep bootstrap import-lean). This
    // drift guard catches the failure mode that originally shipped sonnet-4-6 as
    // silently force-migrated to the default: any model added to the canonical
    // AVAILABLE_MODELS must also be accepted here, otherwise users on that model
    // will be rewritten to DEFAULT_MODEL on boot normalize.
    const targetDir = makeTempDir('bootstrap-target-');
    fs.mkdirSync(path.join(targetDir, 'data'), { recursive: true });
    const settings: Record<string, Record<string, unknown>> = {};
    for (const model of AVAILABLE_MODELS) {
      const userId = `U-${model}`;
      settings[userId] = {
        userId,
        defaultDirectory: '',
        bypassPermission: false,
        persona: 'default',
        defaultModel: model,
        lastUpdated: '2026-03-12T00:00:00.000Z',
        accepted: true,
      };
    }
    writeJson(path.join(targetDir, 'data', 'user-settings.json'), settings);

    await normalizeMainTargetData(targetDir);

    const after = JSON.parse(fs.readFileSync(path.join(targetDir, 'data', 'user-settings.json'), 'utf8'));
    for (const model of AVAILABLE_MODELS) {
      // Every AVAILABLE_MODELS entry round-trips — including [1m] variants
      // and claude-opus-4-5-20251101 (kept, not retired, per Issue #656).
      expect(after[`U-${model}`].defaultModel).toBe(model);
    }
    // And the store's canonical default is one of the accepted models.
    expect(AVAILABLE_MODELS).toContain(STORE_DEFAULT_MODEL);
  });

  it('preserves stored claude-sonnet-4-6 setting through normalize', async () => {
    // Regression guard: VALID_MODELS must include sonnet-4-6 so Sonnet users
    // are NOT silently force-migrated to the default Opus 4.7 model on boot.
    const targetDir = makeTempDir('bootstrap-target-');

    fs.mkdirSync(path.join(targetDir, 'data'), { recursive: true });
    writeJson(path.join(targetDir, 'data', 'user-settings.json'), {
      U1: {
        userId: 'U1',
        defaultDirectory: '',
        bypassPermission: false,
        persona: 'default',
        defaultModel: 'claude-sonnet-4-6',
        lastUpdated: '2026-03-12T00:00:00.000Z',
        accepted: true,
      },
    });

    await normalizeMainTargetData(targetDir);

    const settings = JSON.parse(fs.readFileSync(path.join(targetDir, 'data', 'user-settings.json'), 'utf8'));
    expect(settings.U1.defaultModel).toBe('claude-sonnet-4-6');
  });

  // --- Issue #656: exact-set equality + coerce + 1M round-trip + sessions normalize ---

  describe('VALID_MODELS exact-set equality', () => {
    it('bootstrap VALID_MODELS is identical to AVAILABLE_MODELS (as a set)', () => {
      // Drift guard: this is the single killshot that caught PR #652's silent
      // shrinkage of AVAILABLE_MODELS. Exact-set equality (not just length).
      const canonical = new Set<string>(AVAILABLE_MODELS as readonly string[]);
      const bootstrap = __TEST_ONLY_VALID_MODELS;
      expect(bootstrap.size).toBe(canonical.size);
      for (const m of canonical) {
        expect(bootstrap.has(m)).toBe(true);
      }
      for (const m of bootstrap) {
        expect(canonical.has(m)).toBe(true);
      }
    });

    it('includes both [1m] variants explicitly', () => {
      expect(__TEST_ONLY_VALID_MODELS.has('claude-opus-4-7[1m]')).toBe(true);
      expect(__TEST_ONLY_VALID_MODELS.has('claude-opus-4-6[1m]')).toBe(true);
    });

    it('includes the 2026-08-26 additions so a fresh deploy cannot normalize them away', () => {
      // A model that survives `resolveModelInput` but is missing from the
      // bootstrap's duplicated set gets silently coerced to DEFAULT_MODEL the
      // first time a deploy normalizes the data dir.
      for (const model of ['claude-opus-5', 'claude-opus-5[1m]', 'claude-fable-5[1m]', 'gpt-5.6-sol[1m]', 'grok-4.6']) {
        expect(__TEST_ONLY_VALID_MODELS.has(model)).toBe(true);
      }
    });

    it('includes all pre-existing models (no silent drops)', () => {
      for (const model of [
        'claude-opus-4-7',
        'claude-opus-4-6',
        'claude-sonnet-4-6',
        'claude-sonnet-4-5-20250929',
        'claude-opus-4-5-20251101',
        'claude-haiku-4-5-20251001',
      ]) {
        expect(__TEST_ONLY_VALID_MODELS.has(model)).toBe(true);
      }
    });
  });

  describe('coerceModel', () => {
    it('accepts every AVAILABLE_MODELS entry verbatim', () => {
      for (const model of AVAILABLE_MODELS) {
        expect(__TEST_ONLY_coerceModel(model)).toBe(model);
      }
    });

    it('lowercases uppercase [1M] to the canonical [1m] variant', () => {
      expect(__TEST_ONLY_coerceModel('claude-opus-4-7[1M]')).toBe('claude-opus-4-7[1m]');
      expect(__TEST_ONLY_coerceModel('claude-opus-4-6[1M]')).toBe('claude-opus-4-6[1m]');
    });

    it('trims surrounding whitespace', () => {
      expect(__TEST_ONLY_coerceModel('  claude-opus-4-7  ')).toBe('claude-opus-4-7');
      expect(__TEST_ONLY_coerceModel('\tclaude-opus-4-6[1m]\n')).toBe('claude-opus-4-6[1m]');
    });

    it('falls back to DEFAULT_MODEL for unknown / empty / non-string', () => {
      // Fallback target mirrors user-settings-store DEFAULT_MODEL — keep both
      // in sync when bumping the default-model generation (gpt-5.6 since
      // 2026-07-10).
      expect(__TEST_ONLY_coerceModel('gpt-99-turbo')).toBe('gpt-5.6-sol');
      expect(__TEST_ONLY_coerceModel('')).toBe('gpt-5.6-sol');
      expect(__TEST_ONLY_coerceModel('   ')).toBe('gpt-5.6-sol');
      expect(__TEST_ONLY_coerceModel(undefined)).toBe('gpt-5.6-sol');
      expect(__TEST_ONLY_coerceModel(null)).toBe('gpt-5.6-sol');
      expect(__TEST_ONLY_coerceModel(42)).toBe('gpt-5.6-sol');
    });
  });

  describe('coerceModel — llmux catalog snapshot overlay', () => {
    const GROK_SNAPSHOT = {
      fetchedAt: 1,
      models: [
        {
          id: 'grok-4.5',
          aliases: ['grok'],
          name: 'Grok 4.5',
          efforts: ['low', 'medium', 'high'],
          maxContext: 500_000,
          group: 'grok',
        },
      ],
    };

    it('preserves a catalog id when the snapshot file lists it', () => {
      const dataDir = makeTempDir('bootstrap-catalog-');
      writeJson(path.join(dataDir, 'model-catalog.json'), GROK_SNAPSHOT);
      expect(__TEST_ONLY_coerceModel('grok-4.5', dataDir)).toBe('grok-4.5');
    });

    it('falls back to DEFAULT_MODEL without a snapshot file', () => {
      const dataDir = makeTempDir('bootstrap-catalog-');
      expect(__TEST_ONLY_coerceModel('grok-4.5', dataDir)).toBe('gpt-5.6-sol');
      expect(__TEST_ONLY_coerceModel('grok-4.5')).toBe('gpt-5.6-sol');
    });

    it('fails soft on a corrupt snapshot file (static behavior)', () => {
      const dataDir = makeTempDir('bootstrap-catalog-');
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(path.join(dataDir, 'model-catalog.json'), '{ nope', 'utf8');
      expect(__TEST_ONLY_coerceModel('grok-4.5', dataDir)).toBe('gpt-5.6-sol');
      expect(__TEST_ONLY_coerceModel('claude-opus-4-7', dataDir)).toBe('claude-opus-4-7');
    });

    it('falls back to the `.bak` snapshot when the live file is corrupt (mirrors loadSnapshotSync)', () => {
      const dataDir = makeTempDir('bootstrap-catalog-');
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(path.join(dataDir, 'model-catalog.json'), '{ nope', 'utf8');
      writeJson(path.join(dataDir, 'model-catalog.json.bak'), GROK_SNAPSHOT);
      expect(__TEST_ONLY_coerceModel('grok-4.5', dataDir)).toBe('grok-4.5');
    });

    it('rejects fake grok [1m] ids even when the catalog snapshot advertises them', () => {
      const dataDir = makeTempDir('bootstrap-catalog-');
      writeJson(path.join(dataDir, 'model-catalog.json'), {
        fetchedAt: 1,
        models: [{ id: 'grok-4.6[1m]' }, { id: 'claude-fable-5[1m]' }],
      });
      expect(__TEST_ONLY_coerceModel('grok-4.6[1m]', dataDir)).toBe('gpt-5.6-sol');
      expect(__TEST_ONLY_coerceModel('claude-fable-5[1m]', dataDir)).toBe('claude-fable-5[1m]');
    });

    it('preserves the literal fable [1m] id (the 2026-08-26 filter removal)', () => {
      // The import-lean duplicate of `isCatalogIdSelectable` used to drop
      // `claude-fable-5[1m]` here, so a deploy-time normalize downgraded any
      // user or session on that id to DEFAULT_MODEL. Both the static entry and
      // the catalog snapshot path must now keep it.
      const dataDir = makeTempDir('bootstrap-catalog-');
      writeJson(path.join(dataDir, 'model-catalog.json'), {
        fetchedAt: 1,
        models: [{ id: 'claude-fable-5[1m]' }, ...GROK_SNAPSHOT.models],
      });
      expect(__TEST_ONLY_coerceModel('claude-fable-5[1m]', dataDir)).toBe('claude-fable-5[1m]');
      expect(__TEST_ONLY_coerceModel('claude-fable-5[1m]')).toBe('claude-fable-5[1m]');
      expect(__TEST_ONLY_coerceModel('grok-4.5', dataDir)).toBe('grok-4.5');
    });

    it('normalizeMainTargetData preserves the new [1m] ids on user settings AND sessions', async () => {
      const targetDir = makeTempDir('bootstrap-1m-target-');
      const dataDir = path.join(targetDir, 'data');
      writeJson(path.join(dataDir, 'user-settings.json'), {
        U1: { userId: 'U1', defaultModel: 'claude-fable-5[1m]', accepted: true },
        U2: { userId: 'U2', defaultModel: 'claude-opus-5[1m]', accepted: true },
        U3: { userId: 'U3', defaultModel: 'gpt-5.6-sol[1m]', accepted: true },
        U4: { userId: 'U4', defaultModel: 'grok-4.6', accepted: true },
      });
      writeJson(path.join(dataDir, 'sessions.json'), [
        { sessionKey: 'C1:1.1', userId: 'U1', model: 'claude-fable-5[1m]' },
      ]);

      await normalizeMainTargetData(targetDir);

      const settings = JSON.parse(fs.readFileSync(path.join(dataDir, 'user-settings.json'), 'utf8'));
      expect(settings.U1.defaultModel).toBe('claude-fable-5[1m]');
      expect(settings.U2.defaultModel).toBe('claude-opus-5[1m]');
      expect(settings.U3.defaultModel).toBe('gpt-5.6-sol[1m]');
      expect(settings.U4.defaultModel).toBe('grok-4.6');
      const sessions = JSON.parse(fs.readFileSync(path.join(dataDir, 'sessions.json'), 'utf8'));
      expect(sessions[0].model).toBe('claude-fable-5[1m]');
    });

    it('normalizeMainTargetData preserves grok-4.5 settings when the data dir has the snapshot', async () => {
      const targetDir = makeTempDir('bootstrap-catalog-target-');
      const dataDir = path.join(targetDir, 'data');
      writeJson(path.join(dataDir, 'model-catalog.json'), GROK_SNAPSHOT);
      writeJson(path.join(dataDir, 'user-settings.json'), {
        U1: { userId: 'U1', defaultModel: 'grok-4.5', accepted: true },
        U2: { userId: 'U2', defaultModel: 'not-a-model', accepted: true },
      });

      await normalizeMainTargetData(targetDir);

      const settings = JSON.parse(fs.readFileSync(path.join(dataDir, 'user-settings.json'), 'utf8'));
      expect(settings.U1.defaultModel).toBe('grok-4.5');
      expect(settings.U2.defaultModel).toBe('gpt-5.6-sol');
    });
  });

  describe('normalizeMainTargetData — [1M] round-trip + trim + sessions', () => {
    it('round-trips claude-opus-4-7[1m] through settings normalize', async () => {
      const targetDir = makeTempDir('bootstrap-target-');
      fs.mkdirSync(path.join(targetDir, 'data'), { recursive: true });
      writeJson(path.join(targetDir, 'data', 'user-settings.json'), {
        U1: {
          userId: 'U1',
          defaultModel: 'claude-opus-4-7[1m]',
          lastUpdated: '2026-03-12T00:00:00.000Z',
          accepted: true,
        },
      });

      await normalizeMainTargetData(targetDir);

      const settings = JSON.parse(fs.readFileSync(path.join(targetDir, 'data', 'user-settings.json'), 'utf8'));
      expect(settings.U1.defaultModel).toBe('claude-opus-4-7[1m]');
    });

    it('canonicalizes uppercase [1M] through settings normalize', async () => {
      const targetDir = makeTempDir('bootstrap-target-');
      fs.mkdirSync(path.join(targetDir, 'data'), { recursive: true });
      writeJson(path.join(targetDir, 'data', 'user-settings.json'), {
        U1: {
          userId: 'U1',
          defaultModel: 'claude-opus-4-6[1M]',
          lastUpdated: '2026-03-12T00:00:00.000Z',
          accepted: true,
        },
      });

      await normalizeMainTargetData(targetDir);

      const settings = JSON.parse(fs.readFileSync(path.join(targetDir, 'data', 'user-settings.json'), 'utf8'));
      expect(settings.U1.defaultModel).toBe('claude-opus-4-6[1m]');
    });

    it('trims whitespace in settings defaultModel', async () => {
      const targetDir = makeTempDir('bootstrap-target-');
      fs.mkdirSync(path.join(targetDir, 'data'), { recursive: true });
      writeJson(path.join(targetDir, 'data', 'user-settings.json'), {
        U1: {
          userId: 'U1',
          defaultModel: '  claude-sonnet-4-6  ',
          lastUpdated: '2026-03-12T00:00:00.000Z',
          accepted: true,
        },
      });

      await normalizeMainTargetData(targetDir);

      const settings = JSON.parse(fs.readFileSync(path.join(targetDir, 'data', 'user-settings.json'), 'utf8'));
      expect(settings.U1.defaultModel).toBe('claude-sonnet-4-6');
    });

    it('normalizes session.model in sessions.json', async () => {
      const targetDir = makeTempDir('bootstrap-target-');
      fs.mkdirSync(path.join(targetDir, 'data'), { recursive: true });
      writeJson(path.join(targetDir, 'data', 'sessions.json'), [
        {
          key: 'C1-t1',
          userId: 'U1',
          channelId: 'C1',
          threadTs: 't1',
          isActive: true,
          lastActivity: new Date().toISOString(),
          model: 'claude-opus-4-7[1M]',
        },
        {
          key: 'C2-t2',
          userId: 'U2',
          channelId: 'C2',
          threadTs: 't2',
          isActive: true,
          lastActivity: new Date().toISOString(),
          model: '  claude-sonnet-4-6  ',
        },
        {
          key: 'C3-t3',
          userId: 'U3',
          channelId: 'C3',
          threadTs: 't3',
          isActive: true,
          lastActivity: new Date().toISOString(),
          // No model field — must be left untouched.
        },
      ]);

      await normalizeMainTargetData(targetDir);

      const sessions = JSON.parse(fs.readFileSync(path.join(targetDir, 'data', 'sessions.json'), 'utf8'));
      expect(sessions[0].model).toBe('claude-opus-4-7[1m]');
      expect(sessions[1].model).toBe('claude-sonnet-4-6');
      expect(sessions[2].model).toBeUndefined();
    });
  });
});
