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
import { Logger } from './logger';
import type { McpServerConfig } from './mcp/config-loader';
import { validatePluginConfig } from './plugin/config-parser';
import type { PluginConfig } from './plugin/types';
import type { AgentConfig } from './types';

const logger = new Logger('UnifiedConfigLoader');

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
 * Validate one raw agent entry and assemble the typed `AgentConfig`.
 * Validation order is fixed (slackBotToken → slackAppToken → signingSecret)
 * because the first-failing rule decides the warning text — reordering
 * would silently change diagnostics seen by operators.
 *
 * Optional fields fall back to defaults documented on `AgentConfig`:
 *   - promptDir → `src/prompt/${name}`
 *   - persona   → 'default'
 *   - description / model → undefined when absent or non-string
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
      promptDir: (typeof agent.promptDir === 'string' ? agent.promptDir : undefined) || `src/prompt/${name}`,
      persona: (typeof agent.persona === 'string' ? agent.persona : undefined) || 'default',
      description: typeof agent.description === 'string' ? agent.description : undefined,
      model: typeof agent.model === 'string' ? agent.model : undefined,
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
