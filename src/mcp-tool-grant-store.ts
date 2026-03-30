/**
 * McpToolGrantStore — File-based storage for MCP tool permission grants.
 *
 * Stores time-limited grants that allow users to access permission-gated MCP tools.
 * Uses atomic file writes (tmp + rename) for crash safety.
 *
 * Grant hierarchy: write implies read.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './logger';
import { DATA_DIR as ENV_DATA_DIR } from './env-paths';
import { type PermissionLevel } from './mcp-tool-permission-config';

const logger = new Logger('McpToolGrantStore');

/** Maximum grant duration: 4 weeks (Fix Issue 8) */
export const MAX_GRANT_DURATION_MS = 4 * 7 * 24 * 3600 * 1000;

// Re-export for convenience
export type { PermissionLevel } from './mcp-tool-permission-config';

export interface GrantEntry {
  grantedAt: string;   // ISO 8601
  expiresAt: string;   // ISO 8601
  grantedBy: string;   // Admin user ID
}

export interface ServerGrants {
  read?: GrantEntry | null;
  write?: GrantEntry | null;
}

/** userId → serverName → ServerGrants */
type GrantsData = Record<string, Record<string, ServerGrants>>;

/**
 * Parse duration string like "24h", "7d", "4w" into milliseconds.
 * Returns null if format is invalid.
 */
export function parseDuration(duration: string): number | null {
  const match = duration.match(/^(\d+)([hdw])$/);
  if (!match) return null;

  const value = parseInt(match[1], 10);
  if (value <= 0) return null; // zero/negative duration is meaningless

  const unit = match[2];

  switch (unit) {
    case 'h': return value * 3600 * 1000;
    case 'd': return value * 24 * 3600 * 1000;
    case 'w': return value * 7 * 24 * 3600 * 1000;
    default: return null;
  }
}

export class McpToolGrantStore {
  private grantsFile: string;
  private grants: GrantsData = {};
  private lastMtimeMs: number = 0;

  constructor(dataDir?: string) {
    const dir = dataDir || ENV_DATA_DIR;
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.grantsFile = path.join(dir, 'mcp-tool-grants.json');
    this.loadGrants();
  }

  /**
   * Reload grants from disk if file has been modified since last load.
   * Solves cross-process stale cache: MCP child writes, main process reads.
   * (Fix Issue 2)
   */
  reload(): void {
    try {
      if (!fs.existsSync(this.grantsFile)) return;
      const stat = fs.statSync(this.grantsFile);
      if (stat.mtimeMs > this.lastMtimeMs) {
        this.loadGrants();
      }
    } catch (error) {
      logger.warn('Failed to reload grants from disk — using cached state', error);
    }
  }

  private loadGrants(): void {
    try {
      if (fs.existsSync(this.grantsFile)) {
        const data = fs.readFileSync(this.grantsFile, 'utf-8');
        this.grants = JSON.parse(data);
        try {
          this.lastMtimeMs = fs.statSync(this.grantsFile).mtimeMs;
        } catch (statErr) {
          logger.debug('Could not stat grants file for mtime tracking', statErr);
        }
        logger.debug('Loaded MCP tool grants', {
          userCount: Object.keys(this.grants).length,
        });
      }
    } catch (error) {
      logger.error('Failed to load MCP tool grants', error);
      this.grants = {};
    }
  }

  private saveGrants(): void {
    // Snapshot pre-mutation state for safe rollback (avoids loadGrants wiping to {} on disk failure)
    const preMutationGrants = JSON.parse(JSON.stringify(this.grants));
    const snapshot = JSON.stringify(this.grants, null, 2);
    try {
      const tmpFile = this.grantsFile + '.tmp';
      fs.writeFileSync(tmpFile, snapshot, 'utf-8');
      fs.renameSync(tmpFile, this.grantsFile);
      logger.debug('Saved MCP tool grants');
    } catch (error) {
      logger.error('Failed to save MCP tool grants — restoring pre-mutation state', error);
      // Restore from pre-mutation snapshot (not from disk, which may also be unavailable)
      this.grants = preMutationGrants;
    }
  }

  /**
   * Set a grant for a user on a specific server at a permission level.
   */
  setGrant(
    userId: string,
    serverName: string,
    level: PermissionLevel,
    expiresAt: string,
    grantedBy: string,
  ): void {
    if (!this.grants[userId]) {
      this.grants[userId] = {};
    }
    if (!this.grants[userId][serverName]) {
      this.grants[userId][serverName] = {};
    }

    const entry: GrantEntry = {
      grantedAt: new Date().toISOString(),
      expiresAt,
      grantedBy,
    };

    this.grants[userId][serverName][level] = entry;
    this.saveGrants();

    logger.info('Grant set', { userId, serverName, level, expiresAt, grantedBy });
  }

  /**
   * Get active grants for a user on a specific server.
   * Returns null if no grants exist or all are expired.
   */
  getActiveGrant(userId: string, serverName: string): ServerGrants | null {
    const serverGrants = this.grants[userId]?.[serverName];
    if (!serverGrants) return null;

    const now = Date.now();
    const result: ServerGrants = {};
    let hasActive = false;

    if (serverGrants.read && new Date(serverGrants.read.expiresAt).getTime() > now) {
      result.read = serverGrants.read;
      hasActive = true;
    }

    if (serverGrants.write && new Date(serverGrants.write.expiresAt).getTime() > now) {
      result.write = serverGrants.write;
      hasActive = true;
    }

    return hasActive ? result : null;
  }

  /**
   * Check if a user has an active grant at the specified level.
   * write grant satisfies both write and read checks.
   */
  hasActiveGrant(userId: string, serverName: string, requiredLevel: PermissionLevel): boolean {
    const grants = this.getActiveGrant(userId, serverName);
    if (!grants) return false;

    if (requiredLevel === 'read') {
      // read satisfied by either read or write grant
      return !!(grants.read || grants.write);
    }

    // write requires write grant
    return !!grants.write;
  }

  /**
   * Get all grants for a user (including expired, for status display).
   * Returns a shallow copy to prevent external mutation. (Fix Issue 7)
   */
  getGrants(userId: string): Record<string, ServerGrants> | null {
    const userGrants = this.grants[userId];
    if (!userGrants) return null;
    return { ...userGrants };
  }

  /**
   * Revoke a grant for a user.
   * @param level - "read", "write", or "all"
   */
  revokeGrant(userId: string, serverName: string, level: PermissionLevel | 'all'): void {
    const serverGrants = this.grants[userId]?.[serverName];
    if (!serverGrants) return;

    if (level === 'all') {
      delete this.grants[userId][serverName];
    } else {
      serverGrants[level] = null;
    }

    this.saveGrants();
    logger.info('Grant revoked', { userId, serverName, level });
  }
}

// Singleton instance
export const mcpToolGrantStore = new McpToolGrantStore();
