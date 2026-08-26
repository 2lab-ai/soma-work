/**
 * `SOMA_DATA_DIR` — the first-priority data-directory override (Task 9).
 *
 * Why this file exists: `env-paths` used to bind `DATA_DIR` to
 * `<SOMA_CONFIG_DIR>/data`, while design §4.2 declares the canonical mutable
 * root as `~/.local/share/somawork/<profile>`. The service manager puts
 * `SOMA_DATA_DIR=<ProfileReceipt.dataDir>` in the LaunchAgent/headless
 * environment, and `src/index.ts` keeps `process.env.DATA_DIR = DATA_DIR`, so
 * the lazy legacy stores (`cct-store`, `auth-runtime`) converge on the same
 * canonical directory. These tests prove that convergence rather than asserting
 * it in prose.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ENV_KEYS = ['SOMA_CONFIG_DIR', 'SOMA_DATA_DIR', 'DATA_DIR', 'SOMA_HOME'] as const;

let saved: Record<string, string | undefined>;
let home: string;

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-env-paths-'));
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  fs.rmSync(home, { recursive: true, force: true });
  vi.resetModules();
});

describe('resolveDataDirOverride', () => {
  it('returns null when SOMA_DATA_DIR is unset, empty, or whitespace', async () => {
    const { resolveDataDirOverride } = await import('../env-paths');
    expect(resolveDataDirOverride({})).toBeNull();
    expect(resolveDataDirOverride({ SOMA_DATA_DIR: '' })).toBeNull();
    expect(resolveDataDirOverride({ SOMA_DATA_DIR: '   ' })).toBeNull();
  });

  it('resolves a relative override to an absolute path', async () => {
    const { resolveDataDirOverride } = await import('../env-paths');
    const out = resolveDataDirOverride({ SOMA_DATA_DIR: 'rel/data' });
    expect(out).not.toBeNull();
    expect(path.isAbsolute(out as string)).toBe(true);
    expect((out as string).endsWith('rel/data')).toBe(true);
  });
});

describe('DATA_DIR resolution priority', () => {
  it('SOMA_DATA_DIR outranks SOMA_CONFIG_DIR/data', async () => {
    const configDir = path.join(home, '.config', 'somawork', 'profiles', 'preview');
    const dataDir = path.join(home, '.local', 'share', 'somawork', 'preview');
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });

    process.env.SOMA_CONFIG_DIR = configDir;
    process.env.SOMA_DATA_DIR = dataDir;
    vi.resetModules();

    const mod = await import('../env-paths');
    expect(mod.DATA_DIR).toBe(dataDir);
    // The other config-dir bindings are untouched by the override.
    expect(mod.ENV_FILE).toBe(path.join(configDir, '.env'));
    expect(mod.CONFIG_FILE).toBe(path.join(configDir, 'config.json'));
  });

  it('falls back to SOMA_CONFIG_DIR/data when SOMA_DATA_DIR is absent', async () => {
    const configDir = path.join(home, 'cfg');
    fs.mkdirSync(configDir, { recursive: true });
    process.env.SOMA_CONFIG_DIR = configDir;
    delete process.env.SOMA_DATA_DIR;
    vi.resetModules();

    const mod = await import('../env-paths');
    expect(mod.DATA_DIR).toBe(path.join(configDir, 'data'));
  });
});

describe('legacy lazy runtime stores converge on the profile data directory', () => {
  it('cct-store and auth-runtime resolve under SOMA_DATA_DIR once index.ts aligns process.env.DATA_DIR', async () => {
    const configDir = path.join(home, '.config', 'somawork', 'profiles', 'production');
    const dataDir = path.join(home, '.local', 'share', 'somawork', 'production');
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });

    process.env.SOMA_CONFIG_DIR = configDir;
    process.env.SOMA_DATA_DIR = dataDir;
    vi.resetModules();

    const { DATA_DIR } = await import('../env-paths');
    // Exactly what `src/index.ts` does immediately before the token manager and
    // the auth runtime are first touched.
    process.env.DATA_DIR = DATA_DIR;

    const { defaultCctStorePath } = await import('../../../../src/cct-store');
    expect(defaultCctStorePath()).toBe(path.join(dataDir, 'cct-store.json'));

    const authRuntime = await import('../../../../src/auth/auth-runtime');
    authRuntime.resetAuthRuntimeForTests();
    authRuntime.setAuthMode('llmux');
    expect(fs.existsSync(path.join(dataDir, 'auth-runtime.json'))).toBe(true);
    authRuntime.resetAuthRuntimeForTests();
  });
});
