/**
 * MCP Tool Permission Config — Parses per-tool permission levels from config.json
 *
 * config.json structure:
 * {
 *   "server-tools": {
 *     "permission": { "db_query": "write", "logs": "read" },
 *     "dev2": { "ssh": { ... } }
 *   }
 * }
 *
 * The "permission" key is reserved within each MCP server section.
 * It maps tool names to their required permission level.
 */

import * as fs from 'fs';
import { Logger } from './logger';

const logger = new Logger('McpToolPermissionConfig');

export type PermissionLevel = 'read' | 'write';

const VALID_LEVELS: ReadonlySet<string> = new Set(['read', 'write']);

/**
 * Mapping: serverName → toolName → requiredLevel
 */
export type McpToolPermissionConfig = Record<string, Record<string, PermissionLevel>>;

/**
 * Load MCP tool permission configuration from config.json.
 * Scans all top-level sections for a `permission` sub-key.
 */
export function loadMcpToolPermissions(configFile: string): McpToolPermissionConfig {
  if (!configFile) return {};

  try {
    if (!fs.existsSync(configFile)) return {};

    const raw = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    const result: McpToolPermissionConfig = {};

    for (const [sectionName, sectionValue] of Object.entries(raw)) {
      if (!sectionValue || typeof sectionValue !== 'object') continue;
      const section = sectionValue as Record<string, unknown>;
      const perm = section['permission'];
      if (!perm || typeof perm !== 'object') continue;

      const toolPerms: Record<string, PermissionLevel> = {};
      for (const [toolName, level] of Object.entries(perm as Record<string, unknown>)) {
        if (typeof level === 'string' && VALID_LEVELS.has(level)) {
          toolPerms[toolName] = level as PermissionLevel;
        } else {
          logger.warn('Invalid permission level, skipping', { section: sectionName, tool: toolName, level });
        }
      }

      if (Object.keys(toolPerms).length > 0) {
        result[sectionName] = toolPerms;
      }
    }

    return result;
  } catch (error) {
    logger.error('Failed to load MCP tool permissions', error);
    return {};
  }
}

/**
 * Get the required permission level for a specific tool.
 * Returns null if the tool has no permission requirement (unrestricted).
 */
export function getRequiredLevel(
  config: McpToolPermissionConfig,
  serverName: string,
  toolName: string,
): PermissionLevel | null {
  return config[serverName]?.[toolName] ?? null;
}

/**
 * Check if a given level satisfies the required level.
 * write satisfies both write and read requirements.
 * read satisfies only read requirements.
 */
export function levelSatisfies(userLevel: PermissionLevel, requiredLevel: PermissionLevel): boolean {
  if (userLevel === 'write') return true; // write implies read
  return requiredLevel === 'read';
}

/**
 * Get all servers that have permission configurations.
 */
export function getPermissionGatedServers(config: McpToolPermissionConfig): string[] {
  return Object.keys(config);
}
