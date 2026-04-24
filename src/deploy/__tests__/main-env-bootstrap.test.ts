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
    writeJson(path.join(devSourceDir, 'mcp-servers.json'), { mcpServers: { github: { type: 'stdio' } } });

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

  it('fails when target is non-empty without marker', async () => {
    const devSourceDir = makeTempDir('bootstrap-dev-');
    const legacyRootDir = makeTempDir('bootstrap-legacy-');
    const targetDir = makeTempDir('bootstrap-target-');

    fs.writeFileSync(path.join(devSourceDir, '.system.prompt'), 'prompt', 'utf8');
    writeJson(path.join(devSourceDir, 'config.json'), { plugin: { enabled: true } });
    writeJson(path.join(devSourceDir, 'mcp-servers.json'), { mcpServers: { github: { type: 'stdio' } } });
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
    writeJson(path.join(devSourceDir, 'mcp-servers.json'), { mcpServers: { github: { type: 'stdio' } } });
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
    expect(settings.U1.defaultModel).toBe('claude-opus-4-7');
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
      expect(__TEST_ONLY_coerceModel('gpt-99-turbo')).toBe('claude-opus-4-7');
      expect(__TEST_ONLY_coerceModel('')).toBe('claude-opus-4-7');
      expect(__TEST_ONLY_coerceModel('   ')).toBe('claude-opus-4-7');
      expect(__TEST_ONLY_coerceModel(undefined)).toBe('claude-opus-4-7');
      expect(__TEST_ONLY_coerceModel(null)).toBe('claude-opus-4-7');
      expect(__TEST_ONLY_coerceModel(42)).toBe('claude-opus-4-7');
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
