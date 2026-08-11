import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Freeze the env-derived defaults so the suite is independent of the host's
// AUTH_MODE / ANTHROPIC_* environment.
vi.mock('../../config', () => ({
  config: {
    auth: {
      mode: 'ccp',
      llmux: { baseUrl: 'http://localhost:3456', apiKey: 'llmux-local' },
    },
  },
  LLMUX_PLACEHOLDER_API_KEY: 'llmux-local',
}));

import {
  getAuthMode,
  getAuthRuntimeSnapshot,
  getLlmuxAdminKey,
  getLlmuxSettings,
  initAuthRuntimeDefault,
  resetAuthRuntimeForTests,
  setAuthMode,
  setLlmuxSettings,
} from '../auth-runtime';

describe('auth-runtime (#llmux runtime switch)', () => {
  let dir: string;
  let storePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-runtime-'));
    storePath = path.join(dir, 'auth-runtime.json');
    resetAuthRuntimeForTests(storePath);
    delete process.env.AUTH_MODE;
  });

  afterEach(() => {
    resetAuthRuntimeForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('defaults to env-config values when no persisted file exists', () => {
    expect(getAuthMode()).toBe('ccp');
    expect(getLlmuxSettings()).toEqual({ baseUrl: 'http://localhost:3456', apiKey: 'llmux-local' });
  });

  it('setAuthMode flips the live mode and persists it', () => {
    setAuthMode('llmux');
    expect(getAuthMode()).toBe('llmux');
    const persisted = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
    expect(persisted.mode).toBe('llmux');
    // Fresh module state (simulated restart) re-loads the persisted mode.
    resetAuthRuntimeForTests(storePath);
    expect(getAuthMode()).toBe('llmux');
  });

  it('setLlmuxSettings is partial — blank/omitted fields keep current values', () => {
    setLlmuxSettings({ baseUrl: 'http://10.0.0.5:3456/' });
    expect(getLlmuxSettings()).toEqual({
      baseUrl: 'http://10.0.0.5:3456', // trailing slash stripped
      apiKey: 'llmux-local',
    });
    setLlmuxSettings({ apiKey: 'proxy-key-1' });
    expect(getLlmuxSettings()).toEqual({ baseUrl: 'http://10.0.0.5:3456', apiKey: 'proxy-key-1' });
  });

  it('persisted file overrides env defaults, and accepts the cct alias', () => {
    fs.writeFileSync(storePath, JSON.stringify({ mode: 'llmux', llmux: { baseUrl: 'http://x:9' } }));
    resetAuthRuntimeForTests(storePath);
    expect(getAuthMode()).toBe('llmux');
    expect(getLlmuxSettings().baseUrl).toBe('http://x:9');
    // 'cct' persists as the legacy alias of 'ccp'.
    fs.writeFileSync(storePath, JSON.stringify({ mode: 'cct' }));
    resetAuthRuntimeForTests(storePath);
    expect(getAuthMode()).toBe('ccp');
  });

  it('a corrupt persisted file falls back to env defaults', () => {
    fs.writeFileSync(storePath, '{not json');
    resetAuthRuntimeForTests(storePath);
    expect(getAuthMode()).toBe('ccp');
  });

  it('getAuthRuntimeSnapshot returns defensive copies', () => {
    const snap = getAuthRuntimeSnapshot();
    snap.mode = 'llmux';
    snap.llmux.baseUrl = 'http://mutated';
    expect(getAuthMode()).toBe('ccp');
    expect(getLlmuxSettings().baseUrl).toBe('http://localhost:3456');
  });

  describe('getLlmuxAdminKey (control-plane credential)', () => {
    let originalLlmuxConfig: string | undefined;
    let originalXdg: string | undefined;

    beforeEach(() => {
      originalLlmuxConfig = process.env.LLMUX_CONFIG;
      originalXdg = process.env.XDG_CONFIG_HOME;
      delete process.env.LLMUX_CONFIG;
      // Point the second candidate (`$XDG_CONFIG_HOME/llmux.json`) at an empty
      // temp dir so a real llmux install on the host cannot leak in.
      process.env.XDG_CONFIG_HOME = dir;
    });

    afterEach(() => {
      if (originalLlmuxConfig === undefined) delete process.env.LLMUX_CONFIG;
      else process.env.LLMUX_CONFIG = originalLlmuxConfig;
      if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = originalXdg;
    });

    it('returns an operator-set key as-is — no llmux config file is consulted', () => {
      // Pointing LLMUX_CONFIG at a readable file proves it is NOT read: the
      // operator key wins outright.
      const llmuxConfig = path.join(dir, 'llmux.json');
      fs.writeFileSync(llmuxConfig, JSON.stringify({ proxy: { api_key: 'from-file' } }));
      process.env.LLMUX_CONFIG = llmuxConfig;
      setLlmuxSettings({ apiKey: 'operator-key' });
      expect(getLlmuxAdminKey()).toBe('operator-key');
    });

    it('falls back to the co-located llmux config key when the operator left the placeholder', () => {
      const llmuxConfig = path.join(dir, 'llmux.json');
      fs.writeFileSync(llmuxConfig, JSON.stringify({ proxy: { api_key: 'admin-from-llmux-config' } }));
      process.env.LLMUX_CONFIG = llmuxConfig;
      expect(getLlmuxSettings().apiKey).toBe('llmux-local'); // placeholder
      expect(getLlmuxAdminKey()).toBe('admin-from-llmux-config');
    });

    it('keeps the placeholder when no llmux config file yields a key', () => {
      process.env.LLMUX_CONFIG = path.join(dir, 'does-not-exist.json');
      expect(getLlmuxAdminKey()).toBe('llmux-local');
    });
  });

  describe('initAuthRuntimeDefault (boot probe)', () => {
    it('defaults to llmux when no persisted file, no AUTH_MODE env, and llmux is up', async () => {
      const state = await initAuthRuntimeDefault(async () => true);
      expect(state.mode).toBe('llmux');
      // Probe result is NOT persisted — restart re-evaluates.
      expect(fs.existsSync(storePath)).toBe(false);
    });

    it('stays ccp when llmux is down', async () => {
      const state = await initAuthRuntimeDefault(async () => false);
      expect(state.mode).toBe('ccp');
    });

    it('honors an explicit AUTH_MODE env — no probe', async () => {
      process.env.AUTH_MODE = 'ccp';
      const probe = vi.fn(async () => true);
      const state = await initAuthRuntimeDefault(probe);
      expect(probe).not.toHaveBeenCalled();
      expect(state.mode).toBe('ccp');
      delete process.env.AUTH_MODE;
    });

    it('honors a persisted choice — no probe', async () => {
      fs.writeFileSync(storePath, JSON.stringify({ mode: 'ccp' }));
      resetAuthRuntimeForTests(storePath);
      const probe = vi.fn(async () => true);
      const state = await initAuthRuntimeDefault(probe);
      expect(probe).not.toHaveBeenCalled();
      expect(state.mode).toBe('ccp');
    });

    it('a failing probe keeps ccp instead of throwing', async () => {
      const state = await initAuthRuntimeDefault(async () => {
        throw new Error('boom');
      });
      expect(state.mode).toBe('ccp');
    });
  });
});
