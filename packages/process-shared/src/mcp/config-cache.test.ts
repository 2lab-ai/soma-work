import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    statSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

// Mock stderr-logger
vi.mock('@soma/process-shared/stderr-logger.js', () => ({
  StderrLogger: class {
    debug() {}
    info() {}
    warn() {}
    error() {}
  },
}));

import { ConfigCache } from './config-cache.js';

// ── Tests for ConfigCache ──────────────────────────────────
// Trace: Scenario 2 — ConfigCache extraction

describe('ConfigCache', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.mocked(fs.statSync).mockClear();
    vi.mocked(fs.readFileSync).mockClear();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  // Trace: Scenario 2, Section 3a — returns default when no file
  it('returns default value when SOMA_CONFIG_FILE is not set', () => {
    delete process.env.SOMA_CONFIG_FILE;

    const cache = new ConfigCache({ fallback: true }, { section: 'test', loader: (raw: any) => raw || null });

    expect(cache.get()).toEqual({ fallback: true });
  });

  // Trace: Scenario 2, Section 3a — loads from file on first call
  it('loads config from file on first get()', () => {
    process.env.SOMA_CONFIG_FILE = '/tmp/test-config.json';
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 1000, size: 100 } as fs.Stats);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ test: { loaded: true } }));

    const cache = new ConfigCache({ loaded: false }, { section: 'test', loader: (raw: any) => raw || null });

    expect(cache.get()).toEqual({ loaded: true });
  });

  // Trace: Scenario 2, Section 3a — caches by mtime
  it('does not re-read file when mtime is unchanged', () => {
    process.env.SOMA_CONFIG_FILE = '/tmp/test-config.json';
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 2000, size: 200 } as fs.Stats);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ test: { value: 1 } }));

    const cache = new ConfigCache({ value: 0 }, { section: 'test', loader: (raw: any) => raw || null });

    cache.get(); // first read
    cache.get(); // should be cached
    expect(fs.readFileSync).toHaveBeenCalledTimes(1);
  });

  // Trace: Scenario 2, Section 3a — reloads on mtime change
  it('re-reads file when mtime changes', () => {
    process.env.SOMA_CONFIG_FILE = '/tmp/test-config.json';
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 3000, size: 200 } as fs.Stats);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ test: { v: 1 } }));

    const cache = new ConfigCache({ v: 0 }, { section: 'test', loader: (raw: any) => raw || null });

    cache.get();
    expect(fs.readFileSync).toHaveBeenCalledTimes(1);

    // mtime changed
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 4000, size: 200 } as fs.Stats);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ test: { v: 2 } }));
    const result = cache.get();

    expect(fs.readFileSync).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ v: 2 });
  });

  // Trace: Scenario 2, Section 3a — reset clears cache
  it('reset() forces re-read on next get()', () => {
    process.env.SOMA_CONFIG_FILE = '/tmp/test-config.json';
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 5000, size: 300 } as fs.Stats);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ test: { x: 1 } }));

    const cache = new ConfigCache({ x: 0 }, { section: 'test', loader: (raw: any) => raw || null });

    cache.get();
    expect(fs.readFileSync).toHaveBeenCalledTimes(1);

    cache.reset();

    // Same mtime but cache was reset — should re-read
    cache.get();
    expect(fs.readFileSync).toHaveBeenCalledTimes(2);
  });

  // Trace: Scenario 2, Section 5 — survives invalid JSON
  it('returns cached value when config file contains invalid JSON', () => {
    process.env.SOMA_CONFIG_FILE = '/tmp/test-config.json';
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 6000, size: 10 } as fs.Stats);
    vi.mocked(fs.readFileSync).mockReturnValue('not valid json!!!');

    const cache = new ConfigCache({ safe: true }, { section: 'test', loader: (raw: any) => raw || null });

    expect(cache.get()).toEqual({ safe: true });
  });
});

// secret-access WU1 (#1337): a loader that resolves {"$secret"} references must re-run when the secret store
// changes, not only when config.json does — the dashboard adds a secret without touching the config.
describe('ConfigCache — watched directory', () => {
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = { ...originalEnv, SOMA_CONFIG_FILE: '/cfg/config.json' };
    vi.mocked(fs.statSync).mockReset();
    vi.mocked(fs.readFileSync).mockReset();
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  it('reloads when the watched directory changes while the file stays the same', () => {
    let dirMtime = 100;
    vi.mocked(fs.statSync).mockImplementation(((p: string) =>
      p === '/cfg/secrets' ? { mtimeMs: dirMtime, size: 0 } : { mtimeMs: 1, size: 10 }) as never);
    vi.mocked(fs.readFileSync).mockReturnValue('{"s":{"v":1}}');
    const loader = vi.fn((raw: any) => raw);
    const cache = new ConfigCache({}, { section: 's', loader, watchDir: () => '/cfg/secrets' });
    cache.get();
    cache.get();
    expect(loader).toHaveBeenCalledTimes(1);
    dirMtime = 200;
    cache.get();
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('a watched directory that does not exist does not stop the config from loading', () => {
    vi.mocked(fs.statSync).mockImplementation(((p: string) => {
      if (p === '/cfg/secrets') throw Object.assign(new Error('nope'), { code: 'ENOENT' });
      return { mtimeMs: 1, size: 10 };
    }) as never);
    vi.mocked(fs.readFileSync).mockReturnValue('{"s":{"v":1}}');
    const cache = new ConfigCache({}, { section: 's', loader: (raw: any) => raw, watchDir: () => '/cfg/secrets' });
    expect(cache.get()).toEqual({ v: 1 });
  });
});
