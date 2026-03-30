import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';

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
vi.mock('./stderr-logger.js', () => ({
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

    const cache = new ConfigCache(
      { fallback: true },
      { section: 'test', loader: (raw: any) => raw || null }
    );

    expect(cache.get()).toEqual({ fallback: true });
  });

  // Trace: Scenario 2, Section 3a — loads from file on first call
  it('loads config from file on first get()', () => {
    process.env.SOMA_CONFIG_FILE = '/tmp/test-config.json';
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 1000, size: 100 } as fs.Stats);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ test: { loaded: true } }));

    const cache = new ConfigCache(
      { loaded: false },
      { section: 'test', loader: (raw: any) => raw || null }
    );

    expect(cache.get()).toEqual({ loaded: true });
  });

  // Trace: Scenario 2, Section 3a — caches by mtime
  it('does not re-read file when mtime is unchanged', () => {
    process.env.SOMA_CONFIG_FILE = '/tmp/test-config.json';
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 2000, size: 200 } as fs.Stats);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ test: { value: 1 } }));

    const cache = new ConfigCache(
      { value: 0 },
      { section: 'test', loader: (raw: any) => raw || null }
    );

    cache.get(); // first read
    cache.get(); // should be cached
    expect(fs.readFileSync).toHaveBeenCalledTimes(1);
  });

  // Trace: Scenario 2, Section 3a — reloads on mtime change
  it('re-reads file when mtime changes', () => {
    process.env.SOMA_CONFIG_FILE = '/tmp/test-config.json';
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 3000, size: 200 } as fs.Stats);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ test: { v: 1 } }));

    const cache = new ConfigCache(
      { v: 0 },
      { section: 'test', loader: (raw: any) => raw || null }
    );

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

    const cache = new ConfigCache(
      { x: 0 },
      { section: 'test', loader: (raw: any) => raw || null }
    );

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

    const cache = new ConfigCache(
      { safe: true },
      { section: 'test', loader: (raw: any) => raw || null }
    );

    expect(cache.get()).toEqual({ safe: true });
  });
});
