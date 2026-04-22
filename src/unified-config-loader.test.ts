import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveUnifiedConfig, type UnifiedConfig } from './unified-config-loader';

describe('saveUnifiedConfig', () => {
  let tmpDir: string;
  let configFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-config-test-'));
    configFile = path.join(tmpDir, 'config.json');
  });

  afterEach(() => {
    // Clean up temp directory
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('saves config to file with correct JSON format (2-space indent, trailing newline)', () => {
    const config: UnifiedConfig = {
      mcpServers: {
        'test-server': {
          command: 'node',
          args: ['server.js'],
        } as any,
      },
      plugin: {
        marketplace: [{ name: 'test', repo: 'org/repo' }],
        plugins: ['test@test'],
      } as any,
    };

    saveUnifiedConfig(configFile, config);

    const written = fs.readFileSync(configFile, 'utf-8');
    expect(written).toBe(JSON.stringify(config, null, 2) + '\n');
  });

  it('uses atomic write (no leftover .tmp file after success)', () => {
    const config: UnifiedConfig = { mcpServers: {} };

    saveUnifiedConfig(configFile, config);

    // After successful save, no .tmp file should remain
    const tmpFile = configFile + '.tmp';
    expect(fs.existsSync(tmpFile)).toBe(false);

    // Final file exists with correct content
    expect(fs.existsSync(configFile)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    expect(parsed).toEqual(config);
  });

  it('preserves UnifiedConfig structure through round-trip', () => {
    const config: UnifiedConfig = {
      mcpServers: {
        'server-a': { command: 'npx', args: ['-y', 'some-mcp'] } as any,
        'server-b': { command: 'python', args: ['serve.py'] } as any,
      },
      plugin: {
        marketplace: [{ name: 'official', repo: 'anthropics/plugins', ref: 'v1.0.0' }],
        plugins: ['omc@official'],
        localOverrides: ['./src/local'],
      } as any,
    };

    saveUnifiedConfig(configFile, config);

    const parsed = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    expect(parsed).toEqual(config);
  });

  it('overwrites existing config file', () => {
    const initial: UnifiedConfig = { mcpServers: { old: { command: 'old' } as any } };
    const updated: UnifiedConfig = { mcpServers: { new: { command: 'new' } as any } };

    saveUnifiedConfig(configFile, initial);
    saveUnifiedConfig(configFile, updated);

    const parsed = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    expect(parsed).toEqual(updated);
    expect(parsed.mcpServers).not.toHaveProperty('old');
  });

  it('handles empty config', () => {
    const config: UnifiedConfig = {};

    saveUnifiedConfig(configFile, config);

    const parsed = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    expect(parsed).toEqual({});
  });
});

/**
 * PR #639 dropped the `llmChat` subsystem. Legacy configs keep loading but the
 * key is silently discarded on save. These tests pin down three guarantees
 * that must not regress:
 *   1. `loadUnifiedConfig` warns at most once per process for repeated loads.
 *   2. Absent `llmChat` key → no warn at all.
 *   3. `saveUnifiedConfig` round-trip drops the key (data-loss is explicit,
 *      not accidental — the warning is the only user-visible breadcrumb).
 *
 * `vi.resetModules()` is the linchpin: `warnedLegacyLlmChat` is a module-scope
 * `let`, so without a fresh import per test the "warn-once" assertion would
 * silently succeed only because of state leaked from a prior test.
 */
describe('loadUnifiedConfig — legacy llmChat handling', () => {
  let tmpDir: string;
  let configFile: string;
  let mcpFallback: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-config-legacy-'));
    configFile = path.join(tmpDir, 'config.json');
    mcpFallback = path.join(tmpDir, 'mcp-servers.json');
    // Force a fresh module instance so `warnedLegacyLlmChat` starts at false.
    vi.resetModules();
    // The Logger writes via console.warn; capture there rather than mocking
    // Logger itself so we also verify the message actually reaches stderr.
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function legacyWarnCount(): number {
    return warnSpy.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('Ignoring legacy `llmChat`'),
    ).length;
  }

  it('warns exactly once per process for repeated loads with legacy llmChat', async () => {
    fs.writeFileSync(configFile, JSON.stringify({ mcpServers: {}, llmChat: { old: 'value' } }), 'utf-8');

    const { loadUnifiedConfig } = await import('./unified-config-loader');
    loadUnifiedConfig(configFile, mcpFallback);
    loadUnifiedConfig(configFile, mcpFallback);
    loadUnifiedConfig(configFile, mcpFallback);

    expect(legacyWarnCount()).toBe(1);
  });

  it('does not warn when llmChat key is absent', async () => {
    fs.writeFileSync(configFile, JSON.stringify({ mcpServers: {} }), 'utf-8');

    const { loadUnifiedConfig } = await import('./unified-config-loader');
    loadUnifiedConfig(configFile, mcpFallback);
    loadUnifiedConfig(configFile, mcpFallback);

    expect(legacyWarnCount()).toBe(0);
  });

  it('saveUnifiedConfig round-trip drops llmChat (data-loss is by design)', async () => {
    // Legacy input carrying the removed key.
    const legacy = { mcpServers: {}, llmChat: { foo: 'bar' } };
    fs.writeFileSync(configFile, JSON.stringify(legacy), 'utf-8');

    const { loadUnifiedConfig, saveUnifiedConfig: save } = await import('./unified-config-loader');
    const loaded = loadUnifiedConfig(configFile, mcpFallback);

    // The loader never surfaces `llmChat` on UnifiedConfig — so saving it
    // back writes a config without the key.
    save(configFile, loaded);

    const written = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    expect(written).not.toHaveProperty('llmChat');
  });
});
