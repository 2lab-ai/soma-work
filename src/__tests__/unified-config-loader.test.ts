import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseAgentsConfig, saveUnifiedConfig, type UnifiedConfig } from '../unified-config-loader';

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

    const { loadUnifiedConfig } = await import('../unified-config-loader');
    loadUnifiedConfig(configFile, mcpFallback);
    loadUnifiedConfig(configFile, mcpFallback);
    loadUnifiedConfig(configFile, mcpFallback);

    expect(legacyWarnCount()).toBe(1);
  });

  it('does not warn when llmChat key is absent', async () => {
    fs.writeFileSync(configFile, JSON.stringify({ mcpServers: {} }), 'utf-8');

    const { loadUnifiedConfig } = await import('../unified-config-loader');
    loadUnifiedConfig(configFile, mcpFallback);
    loadUnifiedConfig(configFile, mcpFallback);

    expect(legacyWarnCount()).toBe(0);
  });

  it('saveUnifiedConfig round-trip drops llmChat (data-loss is by design)', async () => {
    // Legacy input carrying the removed key.
    const legacy = { mcpServers: {}, llmChat: { foo: 'bar' } };
    fs.writeFileSync(configFile, JSON.stringify(legacy), 'utf-8');

    const { loadUnifiedConfig, saveUnifiedConfig: save } = await import('../unified-config-loader');
    const loaded = loadUnifiedConfig(configFile, mcpFallback);

    // The loader never surfaces `llmChat` on UnifiedConfig — so saving it
    // back writes a config without the key.
    save(configFile, loaded);

    const written = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    expect(written).not.toHaveProperty('llmChat');
  });
});

/**
 * Characterization tests for `parseAgentsConfig` (issue #793 PR 1/8 — fallow
 * complexity refactor). These pin down the contract before extraction so the
 * decomposition into validator helpers stays byte-equivalent.
 *
 * Invariants guarded:
 *   1. Returns `{}` silently (no warn) when raw / raw.agents is missing or
 *      not a plain object.
 *   2. Per-agent validation order: slackBotToken → slackAppToken →
 *      signingSecret. The first failure decides the warning message — order
 *      matters because it shapes the user-facing diagnostic.
 *   3. `xoxb-` / `xapp-` prefixes are required; `signingSecret` length ≥ 20.
 *   4. Optional defaults: `promptDir` falls back to `src/prompt/${name}`,
 *      `persona` to `'default'`, while `description` and `model` stay
 *      `undefined` when absent or non-string.
 *   5. Skip-on-warn: an invalid agent must not poison sibling agents — the
 *      valid ones still load.
 *   6. The summary `logger.info` fires only when ≥ 1 agent loaded.
 */
describe('parseAgentsConfig — characterization (issue #793 PR1)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  const VALID_BOT = 'xoxb-1234567890-abcdefghijklm';
  const VALID_APP = 'xapp-1-A0123456789-1234567890123-abcdef';
  const VALID_SIGNING = 'a'.repeat(32); // ≥ 20 chars

  function makeValidAgent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      slackBotToken: VALID_BOT,
      slackAppToken: VALID_APP,
      signingSecret: VALID_SIGNING,
      ...overrides,
    };
  }

  function lastWarn(): string | undefined {
    const calls = warnSpy.mock.calls;
    if (calls.length === 0) return undefined;
    const [first] = calls[calls.length - 1] as [unknown];
    return typeof first === 'string' ? first : undefined;
  }

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Logger.info() routes through console.log under the hood (see src/logger.ts).
    infoSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  describe('skip-silent on missing/invalid raw.agents', () => {
    it.each([
      ['null raw', null],
      ['undefined raw', undefined],
      ['raw without agents', { mcpServers: {} }],
      ['raw.agents = null', { agents: null }],
      ['raw.agents = string', { agents: 'oops' }],
      ['raw.agents = number', { agents: 42 }],
    ])('returns {} silently for %s', (_label, raw) => {
      const result = parseAgentsConfig(raw);
      expect(result).toEqual({});
      expect(warnSpy).not.toHaveBeenCalled();
      expect(infoSpy).not.toHaveBeenCalled();
    });
  });

  describe('per-agent entry shape', () => {
    it('warns and skips when agent entry is not an object', () => {
      const result = parseAgentsConfig({ agents: { bad: 'not-an-object' } });
      expect(result).toEqual({});
      expect(lastWarn()).toContain("Skipping agent 'bad'");
      expect(lastWarn()).toContain('not an object');
    });

    it('warns and skips when agent entry is null', () => {
      const result = parseAgentsConfig({ agents: { bad: null } });
      expect(result).toEqual({});
      expect(lastWarn()).toContain("Skipping agent 'bad'");
    });
  });

  describe('slackBotToken validation', () => {
    it('skips when slackBotToken is missing', () => {
      const agent = makeValidAgent({ slackBotToken: undefined });
      const result = parseAgentsConfig({ agents: { a: agent } });
      expect(result).toEqual({});
      expect(lastWarn()).toContain('missing or invalid slackBotToken');
    });

    it('skips when slackBotToken is not a string', () => {
      const agent = makeValidAgent({ slackBotToken: 123 });
      const result = parseAgentsConfig({ agents: { a: agent } });
      expect(result).toEqual({});
      expect(lastWarn()).toContain('missing or invalid slackBotToken');
    });

    it("skips when slackBotToken does not start with 'xoxb-'", () => {
      const agent = makeValidAgent({ slackBotToken: 'xoxa-wrong-prefix-token' });
      const result = parseAgentsConfig({ agents: { a: agent } });
      expect(result).toEqual({});
      expect(lastWarn()).toContain("slackBotToken must start with 'xoxb-'");
    });
  });

  describe('slackAppToken validation', () => {
    it('skips when slackAppToken is missing', () => {
      const agent = makeValidAgent({ slackAppToken: undefined });
      const result = parseAgentsConfig({ agents: { a: agent } });
      expect(result).toEqual({});
      expect(lastWarn()).toContain('missing or invalid slackAppToken');
    });

    it("skips when slackAppToken does not start with 'xapp-'", () => {
      const agent = makeValidAgent({ slackAppToken: 'xoxb-not-an-app-token' });
      const result = parseAgentsConfig({ agents: { a: agent } });
      expect(result).toEqual({});
      expect(lastWarn()).toContain("slackAppToken must start with 'xapp-'");
    });
  });

  describe('signingSecret validation', () => {
    it('skips when signingSecret is missing', () => {
      const agent = makeValidAgent({ signingSecret: undefined });
      const result = parseAgentsConfig({ agents: { a: agent } });
      expect(result).toEqual({});
      expect(lastWarn()).toContain('missing or invalid signingSecret');
    });

    it('skips when signingSecret is not a string', () => {
      const agent = makeValidAgent({ signingSecret: 12345 });
      const result = parseAgentsConfig({ agents: { a: agent } });
      expect(result).toEqual({});
      expect(lastWarn()).toContain('missing or invalid signingSecret');
    });

    it('skips when signingSecret length < 20', () => {
      const agent = makeValidAgent({ signingSecret: 'a'.repeat(19) });
      const result = parseAgentsConfig({ agents: { a: agent } });
      expect(result).toEqual({});
      expect(lastWarn()).toContain('min 20 chars');
    });

    it('accepts signingSecret of exactly 20 chars', () => {
      const agent = makeValidAgent({ signingSecret: 'a'.repeat(20) });
      const result = parseAgentsConfig({ agents: { a: agent } });
      expect(result.a).toBeDefined();
      expect(result.a.signingSecret).toBe('a'.repeat(20));
    });
  });

  describe('validation order', () => {
    // Order matters because the first failing rule decides the warning
    // message. Pinning this guards against accidentally reordering checks
    // during the extraction.
    it('reports slackBotToken failure before slackAppToken when both are bad', () => {
      const agent = makeValidAgent({
        slackBotToken: 'xoxa-bad',
        slackAppToken: 'wrong-prefix',
      });
      parseAgentsConfig({ agents: { a: agent } });
      expect(lastWarn()).toContain('slackBotToken');
    });

    it('reports slackAppToken failure before signingSecret when both are bad', () => {
      const agent = makeValidAgent({
        slackAppToken: 'wrong-prefix',
        signingSecret: 'short',
      });
      parseAgentsConfig({ agents: { a: agent } });
      expect(lastWarn()).toContain('slackAppToken');
    });
  });

  describe('valid agent — typed AgentConfig with defaults', () => {
    it("builds AgentConfig with promptDir defaulting to 'src/prompt/<name>'", () => {
      const result = parseAgentsConfig({ agents: { vega: makeValidAgent() } });
      expect(result.vega).toEqual({
        slackBotToken: VALID_BOT,
        slackAppToken: VALID_APP,
        signingSecret: VALID_SIGNING,
        promptDir: 'src/prompt/vega',
        persona: 'default',
        description: undefined,
        model: undefined,
      });
    });

    it('honors explicit promptDir / persona / description / model', () => {
      const agent = makeValidAgent({
        promptDir: 'custom/path',
        persona: 'expert',
        description: 'Test agent',
        model: 'claude-sonnet-4-7',
      });
      const result = parseAgentsConfig({ agents: { vega: agent } });
      expect(result.vega.promptDir).toBe('custom/path');
      expect(result.vega.persona).toBe('expert');
      expect(result.vega.description).toBe('Test agent');
      expect(result.vega.model).toBe('claude-sonnet-4-7');
    });

    it('falls back to defaults when promptDir / persona are non-string', () => {
      const agent = makeValidAgent({ promptDir: 123, persona: { not: 'string' } });
      const result = parseAgentsConfig({ agents: { vega: agent } });
      expect(result.vega.promptDir).toBe('src/prompt/vega');
      expect(result.vega.persona).toBe('default');
    });

    it('leaves description / model undefined when non-string', () => {
      const agent = makeValidAgent({ description: 42, model: false });
      const result = parseAgentsConfig({ agents: { vega: agent } });
      expect(result.vega.description).toBeUndefined();
      expect(result.vega.model).toBeUndefined();
    });

    // The two optional-field code paths intentionally differ on empty strings,
    // and conflating them would silently change observable output for users
    // who deliberately blank a description. Pin the asymmetry explicitly so
    // the refactor that names these helpers cannot regress it.
    it("treats promptDir = '' as falsy (falls back to default)", () => {
      const agent = makeValidAgent({ promptDir: '' });
      const result = parseAgentsConfig({ agents: { vega: agent } });
      expect(result.vega.promptDir).toBe('src/prompt/vega');
    });

    it("treats persona = '' as falsy (falls back to 'default')", () => {
      const agent = makeValidAgent({ persona: '' });
      const result = parseAgentsConfig({ agents: { vega: agent } });
      expect(result.vega.persona).toBe('default');
    });

    it("preserves description = '' verbatim (deliberate blank stays blank)", () => {
      const agent = makeValidAgent({ description: '' });
      const result = parseAgentsConfig({ agents: { vega: agent } });
      expect(result.vega.description).toBe('');
    });

    it("preserves model = '' verbatim (deliberate blank stays blank)", () => {
      const agent = makeValidAgent({ model: '' });
      const result = parseAgentsConfig({ agents: { vega: agent } });
      expect(result.vega.model).toBe('');
    });
  });

  describe('skip-on-warn isolation', () => {
    it('one invalid agent does not block sibling valid agents', () => {
      const result = parseAgentsConfig({
        agents: {
          good1: makeValidAgent(),
          bad: makeValidAgent({ slackBotToken: 'xoxa-bad' }),
          good2: makeValidAgent(),
        },
      });
      expect(Object.keys(result).sort()).toEqual(['good1', 'good2']);
      expect(result.good1).toBeDefined();
      expect(result.good2).toBeDefined();
      expect(result.bad).toBeUndefined();
    });
  });

  describe('summary logging', () => {
    it('emits summary info with count + names when ≥ 1 agent loaded', () => {
      parseAgentsConfig({
        agents: {
          alpha: makeValidAgent(),
          beta: makeValidAgent(),
        },
      });
      const infoMessages = infoSpy.mock.calls
        .map((c: unknown[]) => c[0])
        .filter((m: unknown): m is string => typeof m === 'string');
      const summary = infoMessages.find((m) => m.includes('Loaded') && m.includes('agent configurations'));
      expect(summary).toBeDefined();
      expect(summary).toContain('Loaded 2 agent configurations');
      expect(summary).toContain('alpha');
      expect(summary).toContain('beta');
    });

    it('does not emit summary info when zero agents loaded', () => {
      parseAgentsConfig({ agents: { bad: makeValidAgent({ slackBotToken: 'xoxa-bad' }) } });
      const infoMessages = infoSpy.mock.calls
        .map((c: unknown[]) => c[0])
        .filter((m: unknown): m is string => typeof m === 'string');
      const summary = infoMessages.find((m) => m.includes('agent configurations'));
      expect(summary).toBeUndefined();
    });
  });
});
