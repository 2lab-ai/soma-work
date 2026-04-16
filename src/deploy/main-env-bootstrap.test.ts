import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AVAILABLE_MODELS, DEFAULT_MODEL as STORE_DEFAULT_MODEL } from '../user-settings-store';
import { bootstrapMainEnvironment, normalizeMainTargetData } from './main-env-bootstrap';

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
    const targetDir = makeTempDir('bootstrap-target-');

    fs.mkdirSync(path.join(targetDir, 'data'), { recursive: true });
    writeJson(path.join(targetDir, 'data', 'user-settings.json'), {
      U1: {
        userId: 'U1',
        defaultDirectory: '',
        bypassPermission: false,
        persona: 'default',
        defaultModel: 'claude-opus-4-5-20251101',
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
      // claude-opus-4-5-20251101 is intentionally still migrated (retired model).
      if (model === 'claude-opus-4-5-20251101') continue;
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
      if (model === 'claude-opus-4-5-20251101') continue;
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
});
