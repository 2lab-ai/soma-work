import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RESERVED_LEASE_KEYS } from '../auth/query-env-builder';
import { type Config, loadConfig, parseAgentsConfig, parseClaudeEnv, saveConfig } from '../config-loader';

describe('saveConfig', () => {
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
    const config: Config = {
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

    saveConfig(configFile, config);

    const written = fs.readFileSync(configFile, 'utf-8');
    expect(written).toBe(JSON.stringify(config, null, 2) + '\n');
  });

  it('uses atomic write (no leftover .tmp file after success)', () => {
    const config: Config = { mcpServers: {} };

    saveConfig(configFile, config);

    // After successful save, no .tmp file should remain
    const tmpFile = configFile + '.tmp';
    expect(fs.existsSync(tmpFile)).toBe(false);

    // Final file exists with correct content
    expect(fs.existsSync(configFile)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    expect(parsed).toEqual(config);
  });

  it('preserves Config structure through round-trip', () => {
    const config: Config = {
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

    saveConfig(configFile, config);

    const parsed = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    expect(parsed).toEqual(config);
  });

  it('overwrites existing config file', () => {
    const initial: Config = { mcpServers: { old: { command: 'old' } as any } };
    const updated: Config = { mcpServers: { new: { command: 'new' } as any } };

    saveConfig(configFile, initial);
    saveConfig(configFile, updated);

    const parsed = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    expect(parsed).toEqual(updated);
    expect(parsed.mcpServers).not.toHaveProperty('old');
  });

  it('handles empty config', () => {
    const config: Config = {};

    saveConfig(configFile, config);

    const parsed = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    expect(parsed).toEqual({});
  });
});

/**
 * PR #639 dropped the `llmChat` subsystem. Legacy configs keep loading but the
 * key is silently discarded on save. These tests pin down five guarantees
 * that must not regress:
 *   1. `loadConfig` warns at most once per process for repeated loads.
 *   2. Absent `llmChat` key → no warn at all.
 *   3. `saveConfig` round-trip drops the key (data-loss is explicit,
 *      not accidental — the warning is the only user-visible breadcrumb).
 *   4. (Issue #1014) `loadConfig` eagerly strips the key from disk on the
 *      first detection so subsequent process starts see no llmChat at all.
 *      Without this, workspaces that never trigger a plugin-manager save
 *      keep emitting the warn once per boot indefinitely (production grep
 *      showed 55x in a single rotation).
 *   5. (Issue #1014, PR #1022 codex review) The eager strip MUST operate on
 *      the pre-`substituteEnvVars` JSON, so `${VAR}` placeholders survive
 *      verbatim — otherwise we'd persist resolved secret values back to
 *      disk and break env-driven secret rotation.
 *
 * `vi.resetModules()` is the linchpin: `warnedLegacyLlmChat` is a module-scope
 * `let`, so without a fresh import per test the "warn-once" assertion would
 * silently succeed only because of state leaked from a prior test.
 */
describe('loadConfig — legacy llmChat handling', () => {
  let tmpDir: string;
  let configFile: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-config-legacy-'));
    configFile = path.join(tmpDir, 'config.json');
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

    const { loadConfig } = await import('../config-loader');
    loadConfig(configFile);
    loadConfig(configFile);
    loadConfig(configFile);

    expect(legacyWarnCount()).toBe(1);
  });

  it('eagerly strips llmChat from disk on first load (issue #1014 self-heal)', async () => {
    // Legacy config with several other top-level keys that must survive
    // the strip. The strip rewrites the raw object minus `llmChat` — not
    // the typed Config — so unknown future keys also survive.
    const legacy = {
      mcpServers: { foo: { command: 'node', args: ['foo.js'] } },
      llmChat: { snippet: 'deprecated' },
      futureExperimentalKey: { keep: 'me' },
    };
    fs.writeFileSync(configFile, JSON.stringify(legacy), 'utf-8');

    const { loadConfig } = await import('../config-loader');
    loadConfig(configFile);

    // File on disk should no longer contain `llmChat` after the first load.
    const onDisk = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    expect(onDisk).not.toHaveProperty('llmChat');
    // But all other top-level keys must be preserved verbatim — the strip
    // operates on the raw parsed JSON, not the typed Config, so we don't
    // accidentally drop unknown/future keys (regression guard).
    expect(onDisk).toHaveProperty('mcpServers');
    expect(onDisk.mcpServers).toEqual(legacy.mcpServers);
    expect(onDisk).toHaveProperty('futureExperimentalKey');
    expect(onDisk.futureExperimentalKey).toEqual(legacy.futureExperimentalKey);

    // No leftover tmp file from the atomic rename.
    expect(fs.existsSync(`${configFile}.tmp.legacy-llmchat-strip`)).toBe(false);
  });

  it('a second process loading the stripped file does not warn (post-migration steady state)', async () => {
    // Simulate the steady state after the strip already happened — the file
    // has no `llmChat` key. A new process starting fresh must not warn.
    fs.writeFileSync(configFile, JSON.stringify({ mcpServers: {} }), 'utf-8');

    const { loadConfig } = await import('../config-loader');
    loadConfig(configFile);

    expect(legacyWarnCount()).toBe(0);
  });

  it('SECURITY: eager strip preserves ${VAR} placeholders verbatim (no resolved secret persisted)', async () => {
    // Regression guard caught by codex review of PR #1022:
    // an earlier draft spread the POST-`substituteEnvVars` object and
    // would have written resolved secret values back to disk. The strip
    // MUST operate on the pre-substitution `rawParsed`, so any
    // `${VAR}` placeholder survives the rewrite unchanged.
    //
    // Two failure modes this test pins simultaneously:
    //   (a) secret disclosure — the env-resolved token must NOT appear
    //       in the rewritten config.json.
    //   (b) round-trip corruption — env-driven secret rotation requires
    //       the placeholder to remain a placeholder so a future process
    //       resolves the new env value.
    process.env.PR1022_FAKE_TOKEN = 'super-secret-real-value-must-not-be-persisted';
    try {
      const legacy = {
        mcpServers: {
          jira: {
            command: 'node',
            args: ['jira-mcp.js'],
            env: { Authorization: 'Basic ${PR1022_FAKE_TOKEN}' },
          },
        },
        llmChat: { snippet: 'deprecated' },
      };
      fs.writeFileSync(configFile, JSON.stringify(legacy), 'utf-8');

      const { loadConfig } = await import('../config-loader');
      loadConfig(configFile);

      const onDiskRaw = fs.readFileSync(configFile, 'utf-8');
      // (a) secret value MUST NOT appear in the rewritten file.
      expect(onDiskRaw).not.toContain('super-secret-real-value-must-not-be-persisted');
      // (b) placeholder MUST survive verbatim for the next process to resolve.
      expect(onDiskRaw).toContain('${PR1022_FAKE_TOKEN}');
      // And of course the legacy key is still gone.
      expect(JSON.parse(onDiskRaw)).not.toHaveProperty('llmChat');
    } finally {
      delete process.env.PR1022_FAKE_TOKEN;
    }
  });

  it('does not warn when llmChat key is absent', async () => {
    fs.writeFileSync(configFile, JSON.stringify({ mcpServers: {} }), 'utf-8');

    const { loadConfig } = await import('../config-loader');
    loadConfig(configFile);
    loadConfig(configFile);

    expect(legacyWarnCount()).toBe(0);
  });

  it('saveConfig round-trip drops llmChat (data-loss is by design)', async () => {
    // Legacy input carrying the removed key.
    const legacy = { mcpServers: {}, llmChat: { foo: 'bar' } };
    fs.writeFileSync(configFile, JSON.stringify(legacy), 'utf-8');

    const { loadConfig, saveConfig: save } = await import('../config-loader');
    const loaded = loadConfig(configFile);

    // The loader never surfaces `llmChat` on Config — so saving it
    // back writes a config without the key.
    save(configFile, loaded);

    const written = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    expect(written).not.toHaveProperty('llmChat');
  });
});

/**
 * Integration test: `${VAR}` placeholders in `mcpServers` get substituted at
 * load time. Pins the contract operators rely on for the documented config:
 *
 *     "Authorization": "Basic ${JIRA_PAT_TOKEN}"
 *
 * The substituted value must reach the in-memory `Config.mcpServers`
 * structure so `McpManager.fromParsedServers` (the next hop) sees the real
 * token, not the placeholder.
 *
 * `vi.resetModules()` is required because `config-env-substitution.ts`
 * holds module-scoped dedupe sets for `.env` paths and missing-var warns —
 * without a fresh import the second test would see stale state.
 */
describe('loadConfig — env-var substitution', () => {
  let tmpDir: string;
  let configFile: string;
  const envSnapshot = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-config-envsub-'));
    configFile = path.join(tmpDir, 'config.json');
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.env = { ...envSnapshot };
  });

  it('substitutes ${VAR} in mcpServers headers from process.env', async () => {
    process.env.JIRA_PAT_TOKEN = 'Basic-abcdef-ZmFrZQ==';
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        mcpServers: {
          atlassian: {
            type: 'http',
            url: 'https://mcp.atlassian.com/v1/mcp',
            headers: { Authorization: 'Basic ${JIRA_PAT_TOKEN}' },
          },
        },
      }),
      'utf-8',
    );

    const { loadConfig } = await import('../config-loader');
    const loaded = loadConfig(configFile);

    expect(loaded.mcpServers?.atlassian).toMatchObject({
      headers: { Authorization: 'Basic Basic-abcdef-ZmFrZQ==' },
    });
  });

  it('reads .env adjacent to config.json when process.env is empty', async () => {
    delete process.env.ENV_FILE_TOKEN;
    fs.writeFileSync(path.join(tmpDir, '.env'), 'ENV_FILE_TOKEN=from-dotenv-file\n');
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        mcpServers: {
          srv: {
            type: 'http',
            url: 'https://example.com',
            headers: { Authorization: '${ENV_FILE_TOKEN}' },
          },
        },
      }),
      'utf-8',
    );

    const { loadConfig } = await import('../config-loader');
    const loaded = loadConfig(configFile);

    expect(loaded.mcpServers?.srv).toMatchObject({
      headers: { Authorization: 'from-dotenv-file' },
    });
  });

  it('preserves the placeholder verbatim when var is unset (no silent empty)', async () => {
    delete process.env.MISSING_TOKEN;
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        mcpServers: {
          srv: {
            type: 'http',
            url: 'https://example.com',
            headers: { Authorization: 'Basic ${MISSING_TOKEN}' },
          },
        },
      }),
      'utf-8',
    );

    const { loadConfig } = await import('../config-loader');
    const loaded = loadConfig(configFile);

    // Verbatim placeholder makes the failure mode visible at the request
    // layer (remote returns 401 with a recognizable string in logs)
    // instead of silently producing `Authorization: Basic ` which would
    // confuse the same operator a week later.
    expect(loaded.mcpServers?.srv).toMatchObject({
      headers: { Authorization: 'Basic ${MISSING_TOKEN}' },
    });
  });

  it('respects ${VAR:-default} when var is unset', async () => {
    delete process.env.SOMETHING;
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        mcpServers: {
          srv: {
            type: 'http',
            url: '${SOMETHING:-https://default.example.com}',
          },
        },
      }),
      'utf-8',
    );

    const { loadConfig } = await import('../config-loader');
    const loaded = loadConfig(configFile);
    expect(loaded.mcpServers?.srv).toMatchObject({ url: 'https://default.example.com' });
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
      const infoMessages: string[] = infoSpy.mock.calls
        .map((c: unknown[]) => c[0])
        .filter((m: unknown): m is string => typeof m === 'string');
      const summary = infoMessages.find((m: string) => m.includes('Loaded') && m.includes('agent configurations'));
      expect(summary).toBeDefined();
      expect(summary).toContain('Loaded 2 agent configurations');
      expect(summary).toContain('alpha');
      expect(summary).toContain('beta');
    });

    it('does not emit summary info when zero agents loaded', () => {
      parseAgentsConfig({ agents: { bad: makeValidAgent({ slackBotToken: 'xoxa-bad' }) } });
      const infoMessages: string[] = infoSpy.mock.calls
        .map((c: unknown[]) => c[0])
        .filter((m: unknown): m is string => typeof m === 'string');
      const summary = infoMessages.find((m: string) => m.includes('agent configurations'));
      expect(summary).toBeUndefined();
    });
  });
});

describe('parseClaudeEnv', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  // Collect all string warn arguments emitted during a test, regardless of
  // whether they are first-arg messages or contextual data passed alongside.
  // The Logger formatter forwards both into console.warn; we want the union.
  function collectWarnText(): string[] {
    const out: string[] = [];
    for (const call of warnSpy.mock.calls) {
      for (const arg of call) {
        if (typeof arg === 'string') out.push(arg);
        else out.push(JSON.stringify(arg));
      }
    }
    return out;
  }

  it('returns undefined when the field is absent', () => {
    expect(parseClaudeEnv(undefined)).toBeUndefined();
    // No warn for absence — that's the normal case for opted-out configs.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('coerces mixed string / number / boolean values into strings', () => {
    const out = parseClaudeEnv({
      STR_VAR: 'hello',
      INT_VAR: 4096,
      FLOAT_VAR: 1.5,
      BOOL_TRUE: true,
      BOOL_FALSE: false,
    });
    expect(out).toEqual({
      STR_VAR: 'hello',
      INT_VAR: '4096',
      FLOAT_VAR: '1.5',
      BOOL_TRUE: 'true',
      BOOL_FALSE: 'false',
    });
  });

  it('preserves empty-string values (explicit "unset inherited" intent)', () => {
    const out = parseClaudeEnv({ EMPTY: '' });
    expect(out).toEqual({ EMPTY: '' });
  });

  it('drops keys that do not match the env-var identifier regex', () => {
    const out = parseClaudeEnv({
      VALID: 'ok',
      '1INVALID': 'starts-with-digit',
      'KEBAB-CASE': 'has-dash',
      'with.dot': 'has-dot',
      '': 'empty',
    });
    expect(out).toEqual({ VALID: 'ok' });
    expect(warnSpy).toHaveBeenCalled();
  });

  it.each(RESERVED_LEASE_KEYS.map((k) => [k]))('drops reserved key %s with a warn', (reservedKey: string) => {
    const out = parseClaudeEnv({ [reservedKey]: 'attempted-override' });
    expect(out).toEqual({});
    const warnText = collectWarnText().join('\n');
    expect(warnText).toContain(reservedKey);
    expect(warnText).toContain('reserved');
  });

  it('drops non-primitive values (object, array, null, undefined)', () => {
    const out = parseClaudeEnv({
      OBJ: { nested: 1 },
      ARR: [1, 2, 3],
      NUL: null,
      UND: undefined,
      OK: 'kept',
    });
    expect(out).toEqual({ OK: 'kept' });
    expect(warnSpy).toHaveBeenCalled();
  });

  it('drops NaN, Infinity, and -Infinity number values', () => {
    const out = parseClaudeEnv({
      NAN: Number.NaN,
      INF: Number.POSITIVE_INFINITY,
      NEG_INF: Number.NEGATIVE_INFINITY,
      OK: 42,
    });
    expect(out).toEqual({ OK: '42' });
  });

  it('ignores the entire field when the top-level value is not a plain object', () => {
    expect(parseClaudeEnv(null)).toBeUndefined();
    expect(parseClaudeEnv('string-value')).toBeUndefined();
    expect(parseClaudeEnv(['arr'])).toBeUndefined();
    expect(parseClaudeEnv(42)).toBeUndefined();
    expect(warnSpy.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it('SECURITY: warn messages NEVER contain operator-supplied values (only keys)', () => {
    const SECRET_VALUE = '__SECRET_TOKEN_12345__';
    parseClaudeEnv({
      // Various rejection paths:
      OBJ_KEY: { secret: SECRET_VALUE },
      'BAD-KEY': SECRET_VALUE, // invalid key
      CLAUDE_CODE_OAUTH_TOKEN: SECRET_VALUE, // reserved
      NAN_KEY: Number.NaN,
      // For nested-object rejection, JSON.stringify of the contextual arg
      // could leak; we ensure the warn arg list never stringifies into the
      // secret.
    });
    const warnText = collectWarnText().join('\n');
    expect(warnText).not.toContain(SECRET_VALUE);
    // But the offending KEYS ARE expected — operators need to fix them.
    expect(warnText).toContain('BAD-KEY');
    expect(warnText).toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });
});

describe('loadConfig (claude.env round-trip)', () => {
  let tmpDir: string;
  let configFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-config-claude-env-'));
    configFile = path.join(tmpDir, 'config.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses a valid claude.env block end-to-end', () => {
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        'claude.env': {
          ENABLE_CLAUDEAI_MCP_SERVERS: false,
          MAX_TOKENS: 4096,
          FOO: 'bar',
        },
      }),
    );
    const cfg = loadConfig(configFile);
    expect(cfg['claude.env']).toEqual({
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
      MAX_TOKENS: '4096',
      FOO: 'bar',
    });
  });

  it('omits the field entirely when the parsed result is empty', () => {
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        'claude.env': {
          // Every entry is rejected — load should not set the field at all.
          'BAD-KEY': 'x',
          CLAUDE_CODE_OAUTH_TOKEN: 'evil',
        },
      }),
    );
    const cfg = loadConfig(configFile);
    expect(cfg['claude.env']).toBeUndefined();
  });

  it('round-trips the dotted JSON key through plugin-manager-style spread', () => {
    // plugin-manager.ts:saveConfig reads → spread-merges → saves. Confirm
    // the dotted key survives that pattern unchanged.
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        'claude.env': { FOO: 'bar' },
        plugin: { marketplace: [], plugins: [], localOverrides: [] },
      }),
    );
    const loaded = loadConfig(configFile);
    const updated = { ...loaded, plugin: { ...loaded.plugin, plugins: ['some@plugin'] } };
    saveConfig(configFile, updated);

    const reloaded = loadConfig(configFile);
    expect(reloaded['claude.env']).toEqual({ FOO: 'bar' });
  });
});

describe('loadConfig — ui surfaces passthrough', () => {
  let tmpDir: string;
  let configFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-config-ui-'));
    configFile = path.join(tmpDir, 'config.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const UI_SECTION = {
    threadheader: {
      lines: [{ block: 'header', fields: [{ field: 'title', truncate: 80 }] }],
    },
  };

  it('loads a ui object into result.ui verbatim (opaque passthrough)', () => {
    fs.writeFileSync(configFile, JSON.stringify({ ui: UI_SECTION }));
    const cfg = loadConfig(configFile);
    expect(cfg.ui).toEqual(UI_SECTION);
  });

  it('round-trips ui through loadConfig → saveConfig (plugin-manager data-loss guard)', () => {
    // plugin-manager.ts saveConfig path: loadConfig → {...full, plugin} →
    // saveConfig. Without passthrough a plugin save would DELETE the
    // operator's ui config.
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        ui: UI_SECTION,
        plugin: { marketplace: [], plugins: [], localOverrides: [] },
      }),
    );
    const loaded = loadConfig(configFile);
    const updated = { ...loaded, plugin: { ...loaded.plugin, plugins: ['some@plugin'] } };
    saveConfig(configFile, updated);

    const onDisk = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    expect(onDisk.ui).toEqual(UI_SECTION);
    const reloaded = loadConfig(configFile);
    expect(reloaded.ui).toEqual(UI_SECTION);
  });

  it('SECURITY: ui keeps ${VAR} placeholders literal — never substituted, never persisted resolved', () => {
    // ui is display-only config: env substitution must NOT apply to it.
    // Regression guard for the round-trip leak: loadConfig used to surface
    // the POST-substituteEnvVars ui object, so plugin-manager's
    // loadConfig → saveConfig cycle would persist the RESOLVED env value
    // to disk (secret disclosure + breaks env-driven rotation).
    process.env.LEAK_TEST_VAR = 'resolved-secret-value-must-stay-in-env';
    try {
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          ui: {
            threadheader: {
              lines: [{ block: 'header', fields: [{ field: 'title', label: '${LEAK_TEST_VAR}' }] }],
            },
          },
          plugin: { marketplace: [], plugins: [], localOverrides: [] },
        }),
      );

      const loaded = loadConfig(configFile);
      // In-memory Config.ui still carries the literal placeholder.
      expect(JSON.stringify(loaded.ui)).toContain('${LEAK_TEST_VAR}');
      expect(JSON.stringify(loaded.ui)).not.toContain('resolved-secret-value-must-stay-in-env');

      // plugin-manager saveConfig path: loadConfig → spread → saveConfig.
      saveConfig(configFile, { ...loaded, plugin: { ...loaded.plugin, plugins: ['some@plugin'] } });

      const onDiskRaw = fs.readFileSync(configFile, 'utf-8');
      expect(onDiskRaw).toContain('${LEAK_TEST_VAR}');
      expect(onDiskRaw).not.toContain('resolved-secret-value-must-stay-in-env');
    } finally {
      delete process.env.LEAK_TEST_VAR;
    }
  });

  it('drops a malformed ui (array) without throwing', () => {
    fs.writeFileSync(configFile, JSON.stringify({ ui: [1, 2, 3] }));
    const cfg = loadConfig(configFile);
    expect(cfg.ui).toBeUndefined();
  });

  it('drops a malformed ui (string) without throwing', () => {
    fs.writeFileSync(configFile, JSON.stringify({ ui: 'compact' }));
    const cfg = loadConfig(configFile);
    expect(cfg.ui).toBeUndefined();
  });
});

describe('config.json ui defaults seeding (디폴트 설정을 config.json에)', () => {
  // User requirement SSOT_1: defaults must land IN config.json itself so the
  // operator sees and edits them there. Seed happens once, only when the
  // `ui` key is absent; existing/emptied `ui` is never overwritten.
  let tmpDir: string;
  let configFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-seed-test-'));
    configFile = path.join(tmpDir, 'config.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('seeds DEFAULT_UI_SURFACES into config.json when ui key is absent', async () => {
    fs.writeFileSync(configFile, JSON.stringify({ mcpServers: {} }, null, 2));
    const { loadConfig } = await import('../config-loader');
    const { DEFAULT_UI_SURFACES } = await import('../slack/surface-config');

    const cfg = loadConfig(configFile);
    expect(cfg.ui).toEqual(JSON.parse(JSON.stringify(DEFAULT_UI_SURFACES)));

    const onDisk = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    expect(onDisk.ui).toEqual(JSON.parse(JSON.stringify(DEFAULT_UI_SURFACES)));
    expect(onDisk.ui.threadheader.lines[0].fields[0].field).toBe('title');
    expect(onDisk.mcpServers).toEqual({});
    // No tmp leftover from the atomic write
    expect(fs.readdirSync(tmpDir).filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  it('does NOT overwrite an operator-customized ui key (file byte-content untouched)', async () => {
    const custom = { ui: { threadheader: { lines: [{ fields: [{ field: 'title' }] }] } } };
    // Deliberately non-pretty JSON: a rewrite would reformat, so byte
    // equality proves the loader never touched the file at all.
    const originalBytes = JSON.stringify(custom);
    fs.writeFileSync(configFile, originalBytes);
    const { loadConfig } = await import('../config-loader');

    const cfg = loadConfig(configFile);
    expect(cfg.ui).toEqual(custom.ui);
    expect(fs.readFileSync(configFile, 'utf-8')).toBe(originalBytes);
  });

  it('preserves ${VAR} placeholders elsewhere in the file when seeding', async () => {
    fs.writeFileSync(
      configFile,
      JSON.stringify({ mcpServers: { j: { type: 'sse', url: '${SEED_TEST_URL}' } } }, null, 2),
    );
    process.env.SEED_TEST_URL = 'https://resolved.example';
    try {
      const { loadConfig } = await import('../config-loader');
      loadConfig(configFile);
      const onDisk = fs.readFileSync(configFile, 'utf-8');
      expect(onDisk).toContain('${SEED_TEST_URL}');
      expect(onDisk).not.toContain('https://resolved.example');
    } finally {
      delete process.env.SEED_TEST_URL;
    }
  });

  it('second load is a no-op (seed is idempotent)', async () => {
    fs.writeFileSync(configFile, JSON.stringify({}, null, 2));
    const { loadConfig } = await import('../config-loader');
    loadConfig(configFile);
    const first = fs.readFileSync(configFile, 'utf-8');
    loadConfig(configFile);
    expect(fs.readFileSync(configFile, 'utf-8')).toBe(first);
  });

  it('missing config.json → returns {} and does NOT create the file', async () => {
    // Seeding must never manufacture a config.json out of thin air — the
    // loader's missing-file contract (warn + empty Config) stays intact.
    const { loadConfig } = await import('../config-loader');
    const cfg = loadConfig(configFile);
    expect(cfg).toEqual({});
    expect(fs.existsSync(configFile)).toBe(false);
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });

  it('round-trip: seeded file → loadConfig → saveConfig keeps ui present', async () => {
    // plugin-manager path: loadConfig → spread → saveConfig. The seeded
    // defaults must survive that cycle like any operator-authored ui.
    fs.writeFileSync(
      configFile,
      JSON.stringify({ plugin: { marketplace: [], plugins: [], localOverrides: [] } }, null, 2),
    );
    const { loadConfig, saveConfig: save } = await import('../config-loader');
    const { DEFAULT_UI_SURFACES } = await import('../slack/surface-config');

    const loaded = loadConfig(configFile); // triggers seed
    save(configFile, { ...loaded, plugin: { ...loaded.plugin, plugins: ['some@plugin'] } as Config['plugin'] });

    const onDisk = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    expect(onDisk.ui).toEqual(JSON.parse(JSON.stringify(DEFAULT_UI_SURFACES)));
    const reloaded = loadConfig(configFile);
    expect(reloaded.ui).toEqual(JSON.parse(JSON.stringify(DEFAULT_UI_SURFACES)));
  });

  it('logs the seed info at most once per process (module-scoped flag)', async () => {
    // `loadConfig` runs at boot AND on every plugin-manager save; without
    // the flag, seeding two different config files (multi-agent setups)
    // would double-log. vi.resetModules gives this test a fresh flag.
    vi.resetModules();
    const infoSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { loadConfig } = await import('../config-loader');
      const otherFile = path.join(tmpDir, 'config-b.json');
      fs.writeFileSync(configFile, JSON.stringify({}, null, 2));
      fs.writeFileSync(otherFile, JSON.stringify({}, null, 2));

      loadConfig(configFile);
      loadConfig(otherFile);

      const seedLogs = infoSpy.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('Seeded default `ui`'),
      );
      expect(seedLogs.length).toBe(1);
      // Both files are still seeded — only the LOG is deduped.
      expect(JSON.parse(fs.readFileSync(configFile, 'utf-8')).ui).toBeDefined();
      expect(JSON.parse(fs.readFileSync(otherFile, 'utf-8')).ui).toBeDefined();
    } finally {
      infoSpy.mockRestore();
    }
  });
});

describe('ui seeding + legacy llmChat strip interplay (PR #1270 codex finding)', () => {
  let tmpDir: string;
  let configFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-seed-llmchat-'));
    configFile = path.join(tmpDir, 'config.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('keeps the seeded ui when the llmChat strip rewrites the file in the same load', async () => {
    // Both migrations fire in one loadConfig: (1) seed ui, (2) strip llmChat.
    // The strip rewrites from rawParsed — it must include the seeded ui,
    // otherwise the second rename drops it (BLOCKING finding, PR #1270).
    vi.resetModules();
    fs.writeFileSync(configFile, JSON.stringify({ llmChat: { legacy: true }, mcpServers: {} }, null, 2));
    const { loadConfig } = await import('../config-loader');
    const { DEFAULT_UI_SURFACES } = await import('../slack/surface-config');

    const cfg = loadConfig(configFile);
    expect(cfg.ui).toEqual(JSON.parse(JSON.stringify(DEFAULT_UI_SURFACES)));

    const onDisk = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    expect(onDisk.llmChat).toBeUndefined();
    expect(onDisk.ui).toEqual(JSON.parse(JSON.stringify(DEFAULT_UI_SURFACES)));
  });
});
