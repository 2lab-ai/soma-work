/**
 * Unified config.json loader.
 *
 * Loads the new config.json format which combines:
 * - mcpServers (previously in mcp-servers.json)
 * - plugin (marketplace + local overrides)
 *
 * Falls back to the legacy mcp-servers.json if config.json doesn't exist.
 */

import * as fs from 'fs';
import type { A2tConfig } from './a2t/types';
import { RESERVED_LEASE_KEYS } from './auth/query-env-builder';
import { Logger } from './logger';
import type { McpServerConfig } from './mcp/config-loader';
import { validatePluginConfig } from './plugin/config-parser';
import type { PluginConfig } from './plugin/types';
import type { AgentConfig } from './types';

const logger = new Logger('UnifiedConfigLoader');

/**
 * Identifier regex for `claude.env` keys. Matches POSIX env-var conventions
 * (alpha/underscore start, alphanumeric/underscore continue). Anything else
 * is rejected at load time — operators get a warn so the typo is visible.
 */
const ENV_KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

const RESERVED_LEASE_KEYS_SET = new Set<string>(RESERVED_LEASE_KEYS);

/**
 * Process-scoped guard so the legacy `llmChat` warning fires at most once.
 * `loadUnifiedConfig` is called on boot *and* every plugin-manager save, which
 * would otherwise double-log the same deprecation message within seconds.
 */
let warnedLegacyLlmChat = false;

export interface UnifiedConfig {
  mcpServers?: Record<string, McpServerConfig>;
  plugin?: PluginConfig;
  agents?: Record<string, AgentConfig>;
  a2t?: A2tConfig;
  /**
   * Operator-controlled env vars injected into every Claude Agent SDK
   * subprocess at `query()` time, equivalent to a shell `KEY=VALUE`
   * prefix on the `claude` invocation.
   *
   * The dotted JSON key (`"claude.env"`) is preserved verbatim so the file
   * round-trips through `plugin-manager.saveConfig` (which uses
   * `{...full, plugin: ...}` spread) without rename.
   *
   * Values in this Record are always strings — the parser stringifies
   * `number`/`boolean` JSON values and rejects everything else with a warn.
   */
  'claude.env'?: Record<string, string>;
}

/**
 * Validate and normalize the raw `config.json#claude.env` field into a
 * `Record<string, string>` ready to install via `setQueryEnvAdditional`.
 *
 * Rules (mirrored in unit tests):
 *   - The whole field must be a plain JSON object. `null`, arrays, strings,
 *     numbers → field ignored entirely with a warn.
 *   - Keys must match `/^[A-Za-z_][A-Za-z0-9_]*$/` → otherwise drop entry.
 *   - Keys in `RESERVED_LEASE_KEYS` → drop entry with a warn ("operator
 *     footgun guard"). The lease/auth path owns those slots.
 *   - Values: `string` (verbatim, including empty string for "unset"
 *     intent), `boolean` (→ `"true"` / `"false"`), finite `number`
 *     (→ `String(n)`). Everything else (`null`, `undefined`, object, array,
 *     `NaN`, `Infinity`, `bigint`, `symbol`, `function`) → drop with warn.
 *
 * Logging contract: warnings include only the offending KEY name, never
 * the value. Operators may misconfigure secrets here; logs MUST NOT leak
 * them. `unified-config-loader.test.ts` enforces this with a regex.
 */
export function parseClaudeEnv(raw: unknown): Record<string, string> | undefined {
  if (raw === undefined) return undefined;

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    logger.warn(`Ignoring config.json#"claude.env": expected a JSON object, got ${describeKind(raw)}`);
    return undefined;
  }

  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!ENV_KEY_REGEX.test(key)) {
      logger.warn(`Skipping claude.env entry: invalid env key (key=${key})`);
      continue;
    }
    if (RESERVED_LEASE_KEYS_SET.has(key)) {
      logger.warn(`Skipping claude.env entry: ${key} is reserved (auth/provider/proxy slot owned by lease)`);
      continue;
    }
    const coerced = coerceEnvValue(value);
    if (coerced === null) {
      // describeKind never reads the value contents — only its typeof — so
      // string contents (which may be a secret) never reach the log.
      logger.warn(`Skipping claude.env entry: invalid value type (key=${key}, type=${describeKind(value)})`);
      continue;
    }
    result[key] = coerced;
  }

  return result;
}

/**
 * Stringify a JSON value for env injection, or return `null` to signal
 * "drop this entry." Empty string IS allowed — operators may want to clear
 * an inherited process.env value; layer 2 of `buildQueryEnv` writes
 * `env[KEY] = ''` which is forwarded to the spawn.
 */
function coerceEnvValue(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return String(value);
  }
  return null;
}

/**
 * Describe a JSON value's shape WITHOUT echoing its contents — used in
 * warn messages. Returns one of: 'null', 'undefined', 'array', 'object',
 * 'string', 'number', 'boolean', 'bigint', 'symbol', 'function', 'NaN',
 * 'Infinity'. Never includes the actual value, so secrets cannot leak.
 */
function describeKind(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  if (t === 'number') {
    if (Number.isNaN(value as number)) return 'NaN';
    if (!Number.isFinite(value as number)) return 'Infinity';
  }
  return t;
}

/**
 * Tagged-union return for validators below. Surfacing the failure as data
 * (rather than throwing) lets `parseAgentsConfig` apply the skip-on-warn
 * rule without try/catch noise: one bad agent must not poison sibling
 * agents — Trace: docs/multi-agent/trace.md, Scenario 1.
 */
type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

/**
 * Required tokens an agent must declare (string-typed).
 * Listed explicitly to keep `extractRequiredString` callers type-safe.
 */
type RequiredAgentStringKey = 'slackBotToken' | 'slackAppToken' | 'signingSecret';

/**
 * Pull a required string field off a raw agent entry, optionally enforcing
 * a fixed prefix (Slack token format) and/or a minimum length. The two
 * failure modes produce distinct warnings on purpose:
 *   - presence / type / min-length     → 'missing or invalid <key>[ (min N chars)]'
 *   - prefix mismatch                  → "<key> must start with '<prefix>-'"
 *
 * The original `parseAgentsConfig` (cog 30) ran these checks inline; the
 * exact wording is part of the contract pinned by the characterization
 * tests in `src/__tests__/unified-config-loader.test.ts`.
 */
function extractRequiredString(
  name: string,
  agent: Record<string, unknown>,
  key: RequiredAgentStringKey,
  opts?: { prefix?: string; minLength?: number },
): Result<string, string> {
  const value = agent[key];
  const minLength = opts?.minLength ?? 0;

  if (!value || typeof value !== 'string' || value.length < minLength) {
    const suffix = minLength > 0 ? ` (min ${minLength} chars)` : '';
    return { ok: false, error: `Skipping agent '${name}': missing or invalid ${key}${suffix}` };
  }

  if (opts?.prefix && !value.startsWith(opts.prefix)) {
    return {
      ok: false,
      error: `Skipping agent '${name}': ${key} must start with '${opts.prefix}'`,
    };
  }

  return { ok: true, value };
}

/**
 * Read an optional string field, returning `fallback` when the field is
 * absent, non-string, OR empty. Used for `promptDir` / `persona`: an empty
 * value here would silently overwrite the documented default, so we treat
 * it as "unset."
 */
function optionalStringWithFallback(agent: Record<string, unknown>, key: string, fallback: string): string {
  const value = agent[key];
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/**
 * Read an optional string field, returning `undefined` only when the field
 * is absent or non-string. Empty strings are preserved verbatim — used for
 * `description` / `model`, which are allowed to be deliberately blank.
 *
 * The asymmetry vs. `optionalStringWithFallback` is intentional and pinned
 * by tests in `unified-config-loader.test.ts`.
 */
function optionalString(agent: Record<string, unknown>, key: string): string | undefined {
  const value = agent[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Validate one raw agent entry and assemble the typed `AgentConfig`.
 * Validation order is fixed (slackBotToken → slackAppToken → signingSecret)
 * because the first-failing rule decides the warning text — reordering
 * would silently change diagnostics seen by operators.
 *
 * Optional fields fall back to defaults documented on `AgentConfig`:
 *   - promptDir → `src/prompt/${name}`     (empty string ⇒ fallback)
 *   - persona   → 'default'                (empty string ⇒ fallback)
 *   - description / model → undefined when absent or non-string
 *                          (empty string preserved verbatim)
 */
function validateAgentConfig(name: string, raw: unknown): Result<AgentConfig, string> {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: `Skipping agent '${name}': invalid entry (not an object)` };
  }
  const agent = raw as Record<string, unknown>;

  const bot = extractRequiredString(name, agent, 'slackBotToken', { prefix: 'xoxb-' });
  if (!bot.ok) return bot;
  const app = extractRequiredString(name, agent, 'slackAppToken', { prefix: 'xapp-' });
  if (!app.ok) return app;
  const signing = extractRequiredString(name, agent, 'signingSecret', { minLength: 20 });
  if (!signing.ok) return signing;

  return {
    ok: true,
    value: {
      slackBotToken: bot.value,
      slackAppToken: app.value,
      signingSecret: signing.value,
      promptDir: optionalStringWithFallback(agent, 'promptDir', `src/prompt/${name}`),
      persona: optionalStringWithFallback(agent, 'persona', 'default'),
      description: optionalString(agent, 'description'),
      model: optionalString(agent, 'model'),
    },
  };
}

/**
 * Parse and validate the agents section from raw config JSON.
 * Invalid agents are skipped with a warning (not fatal).
 * Trace: docs/multi-agent/trace.md, Scenario 1
 */
export function parseAgentsConfig(raw: any): Record<string, AgentConfig> {
  const result: Record<string, AgentConfig> = {};

  if (!raw?.agents || typeof raw.agents !== 'object') {
    return result;
  }

  for (const [name, entry] of Object.entries(raw.agents)) {
    const validated = validateAgentConfig(name, entry);
    if (validated.ok) {
      result[name] = validated.value;
    } else {
      logger.warn(validated.error);
    }
  }

  const names = Object.keys(result);
  if (names.length > 0) {
    logger.info(`Loaded ${names.length} agent configurations: [${names.join(', ')}]`);
  }

  return result;
}

/**
 * Load unified config from config.json.
 * Falls back to legacy mcp-servers.json if the unified config doesn't exist.
 *
 * @param configFile   Path to the unified config.json
 * @param mcpFallback  Path to the legacy mcp-servers.json
 */
export function loadUnifiedConfig(configFile: string, mcpFallback: string): UnifiedConfig {
  // Try unified config first
  if (fs.existsSync(configFile)) {
    try {
      const raw = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
      const result: UnifiedConfig = {};

      if (raw.mcpServers && typeof raw.mcpServers === 'object') {
        result.mcpServers = raw.mcpServers;
      }

      if (raw.plugin) {
        result.plugin = validatePluginConfig(raw.plugin);
      }

      // Parse agents section (Trace: docs/multi-agent/trace.md, S1)
      const agents = parseAgentsConfig(raw);
      if (Object.keys(agents).length > 0) {
        result.agents = agents;
      }

      // Parse A2T (audio-to-text) config section
      if (raw.a2t && typeof raw.a2t === 'object') {
        result.a2t = raw.a2t as A2tConfig;
      }

      // Parse claude.env — operator-controlled env vars injected into every
      // Claude Agent SDK subprocess. Validated + denylist-filtered;
      // warnings log keys only (never values).
      const claudeEnv = parseClaudeEnv(raw['claude.env']);
      if (claudeEnv && Object.keys(claudeEnv).length > 0) {
        result['claude.env'] = claudeEnv;
      }

      // PR #639 removed the `llmChat` subsystem (prompt-builder snippet,
      // llmChatConfigStore, Slack LlmChatHandler). Legacy configs still
      // carrying `llmChat` keep working but the key is silently dropped on
      // the next saveUnifiedConfig round-trip; warn so upgraded users see a
      // trace rather than discovering the drop via vanished data. The flag
      // is process-scoped because this loader runs at boot *and* on every
      // plugin-manager save.
      if (raw.llmChat !== undefined && !warnedLegacyLlmChat) {
        warnedLegacyLlmChat = true;
        logger.warn(
          'Ignoring legacy `llmChat` config key — subsystem removed in PR #639. ' +
            'The key will be dropped on the next config save.',
          { path: configFile },
        );
      }

      logger.info('Loaded unified config', {
        path: configFile,
        mcpServers: result.mcpServers ? Object.keys(result.mcpServers).length : 0,
        hasPluginConfig: !!result.plugin,
        agents: result.agents ? Object.keys(result.agents).length : 0,
        hasA2t: !!result.a2t,
        // keys-only — never log the values
        claudeEnvKeys: result['claude.env'] ? Object.keys(result['claude.env']) : [],
      });

      return result;
    } catch (error) {
      logger.error('Failed to parse unified config, trying fallback', {
        path: configFile,
        error: (error as Error).message,
      });
    }
  }

  // Fallback to legacy mcp-servers.json
  if (fs.existsSync(mcpFallback)) {
    try {
      const raw = JSON.parse(fs.readFileSync(mcpFallback, 'utf-8'));
      logger.info('Using legacy mcp-servers.json fallback', { path: mcpFallback });
      return {
        mcpServers: raw.mcpServers || undefined,
      };
    } catch (error) {
      logger.error('Failed to parse legacy MCP config', {
        path: mcpFallback,
        error: (error as Error).message,
      });
    }
  }

  logger.warn('No configuration file found', { configFile, mcpFallback });
  return {};
}

/**
 * Save unified config to config.json using atomic write.
 *
 * Writes to a temporary file first, then renames to the target path.
 * This prevents corruption if the process crashes mid-write.
 *
 * @param configFile  Path to the unified config.json
 * @param config      The UnifiedConfig to persist
 */
export function saveUnifiedConfig(configFile: string, config: UnifiedConfig): void {
  const tmpFile = configFile + '.tmp';
  const content = JSON.stringify(config, null, 2) + '\n';
  fs.writeFileSync(tmpFile, content, 'utf-8');
  fs.renameSync(tmpFile, configFile);
  logger.info('Saved unified config', { path: configFile });
}
