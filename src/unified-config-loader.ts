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
import { Logger } from './logger';
import { PluginConfig } from './plugin/types';
import { validatePluginConfig } from './plugin/config-parser';
import type { McpServerConfig } from './mcp/config-loader';
import type { AgentConfig } from './types';

const logger = new Logger('UnifiedConfigLoader');

export interface LlmBackendConfigJson {
  backend: string;
  model: string;
  configOverride?: Record<string, string>;
}

export interface UnifiedConfig {
  mcpServers?: Record<string, McpServerConfig>;
  plugin?: PluginConfig;
  llmChat?: Record<string, LlmBackendConfigJson>;
  agents?: Record<string, AgentConfig>;
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
    const agent = entry as Record<string, unknown>;
    if (!agent || typeof agent !== 'object') {
      logger.warn(`Skipping agent '${name}': invalid entry (not an object)`);
      continue;
    }

    // Validate required tokens
    if (!agent.slackBotToken || typeof agent.slackBotToken !== 'string') {
      logger.warn(`Skipping agent '${name}': missing or invalid slackBotToken`);
      continue;
    }
    if (!agent.slackBotToken.startsWith('xoxb-')) {
      logger.warn(`Skipping agent '${name}': slackBotToken must start with 'xoxb-'`);
      continue;
    }
    if (!agent?.slackAppToken || typeof agent.slackAppToken !== 'string') {
      logger.warn(`Skipping agent '${name}': missing or invalid slackAppToken`);
      continue;
    }
    if (!agent.slackAppToken.startsWith('xapp-')) {
      logger.warn(`Skipping agent '${name}': slackAppToken must start with 'xapp-'`);
      continue;
    }
    if (!agent?.signingSecret || typeof agent.signingSecret !== 'string' || agent.signingSecret.length < 20) {
      logger.warn(`Skipping agent '${name}': missing or invalid signingSecret (min 20 chars)`);
      continue;
    }

    result[name] = {
      slackBotToken: agent.slackBotToken as string,
      slackAppToken: agent.slackAppToken as string,
      signingSecret: agent.signingSecret as string,
      promptDir: (typeof agent.promptDir === 'string' ? agent.promptDir : undefined) || `src/prompt/${name}`,
      persona: (typeof agent.persona === 'string' ? agent.persona : undefined) || 'default',
      description: typeof agent.description === 'string' ? agent.description : undefined,
      model: typeof agent.model === 'string' ? agent.model : undefined,
    };
  }

  if (Object.keys(result).length > 0) {
    logger.info(`Loaded ${Object.keys(result).length} agent configurations: [${Object.keys(result).join(', ')}]`);
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

      if (raw.llmChat && typeof raw.llmChat === 'object') {
        result.llmChat = raw.llmChat;
      }

      // Parse agents section (Trace: docs/multi-agent/trace.md, S1)
      const agents = parseAgentsConfig(raw);
      if (Object.keys(agents).length > 0) {
        result.agents = agents;
      }

      logger.info('Loaded unified config', {
        path: configFile,
        mcpServers: result.mcpServers ? Object.keys(result.mcpServers).length : 0,
        hasPluginConfig: !!result.plugin,
        hasLlmChat: !!result.llmChat,
        agents: result.agents ? Object.keys(result.agents).length : 0,
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
