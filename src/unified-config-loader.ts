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

const logger = new Logger('UnifiedConfigLoader');

export interface UnifiedConfig {
  mcpServers?: Record<string, McpServerConfig>;
  plugin?: PluginConfig;
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

      logger.info('Loaded unified config', {
        path: configFile,
        mcpServers: result.mcpServers ? Object.keys(result.mcpServers).length : 0,
        hasPluginConfig: !!result.plugin,
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
