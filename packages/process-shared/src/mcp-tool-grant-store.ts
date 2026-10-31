/**
 * McpToolGrantStore — File-based storage for MCP tool permission grants.
 *
 * Stores time-limited grants that allow users to access permission-gated MCP tools.
 * Uses atomic file writes (unique tmp + rename) and a cross-process lock around
 * every read-modify-write: the main process and the MCP child both write it.
 *
 * Grant hierarchy: write implies read.
 */

import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR as ENV_DATA_DIR } from './env-paths';
import { Logger } from './logger';
import type { PermissionLevel } from './mcp-tool-permission-config';

const logger = new Logger('McpToolGrantStore');

/** How long a writer waits for the grants file lock, and when a held lock counts as abandoned. */
const GRANT_LOCK_WAIT_MS = 5_000;
const GRANT_LOCK_STALE_MS = 10_000;

/** Maximum grant duration: 4 weeks (Fix Issue 8) */
export const MAX_GRANT_DURATION_MS = 4 * 7 * 24 * 3600 * 1000;

// Re-export for convenience
export type { PermissionLevel } from './mcp-tool-permission-config';

export interface GrantEntry {
  grantedAt: string; // ISO 8601
  expiresAt: string; // ISO 8601
  grantedBy: string; // Admin user ID
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
    case 'h':
      return value * 3600 * 1000;
    case 'd':
      return value * 24 * 3600 * 1000;
    case 'w':
      return value * 7 * 24 * 3600 * 1000;
    default:
      return null;
  }
}

export class McpToolGrantStore {
  private grantsFile: string;
  private grants: GrantsData = {};
  private lastMtimeMs: number = 0;

  constructor(
    dataDir?: string,
    private readonly lockWaitMs: number = GRANT_LOCK_WAIT_MS,
  ) {
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

  /**
   * Run one read-modify-write of the grants file under a cross-process lock.
   * Two processes write this file (the main process grants; the MCP child
   * revokes), so the read, the change and the write are one transaction: no
   * writer can save over another's change. A lock left by a crashed holder is
   * broken after {@link GRANT_LOCK_STALE_MS}.
   */
  private transact<T>(change: () => T): T {
    const lockFile = `${this.grantsFile}.lock`;
    const deadline = Date.now() + this.lockWaitMs;
    for (;;) {
      try {
        fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          if (Date.now() - fs.statSync(lockFile).mtimeMs > GRANT_LOCK_STALE_MS) {
            fs.unlinkSync(lockFile);
            continue;
          }
        } catch {
          continue; // released between the open and the stat
        }
        if (Date.now() > deadline) throw new Error('MCP tool grants are locked by another process');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    try {
      this.readLatest();
      return change();
    } finally {
      try {
        fs.unlinkSync(lockFile);
      } catch {
        /* already gone */
      }
    }
  }

  /** The file as it is now. An unreadable file refuses the write rather than saving over it. */
  private readLatest(): void {
    if (!fs.existsSync(this.grantsFile)) return;
    this.grants = JSON.parse(fs.readFileSync(this.grantsFile, 'utf-8'));
    this.lastMtimeMs = fs.statSync(this.grantsFile).mtimeMs;
  }

  /** Write the map (unique temp file + rename). On failure the map is restored and the error thrown. */
  private saveGrants(previous: GrantsData): void {
    const tmpFile = `${this.grantsFile}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      fs.writeFileSync(tmpFile, JSON.stringify(this.grants, null, 2), 'utf-8');
      fs.renameSync(tmpFile, this.grantsFile);
      logger.debug('Saved MCP tool grants');
    } catch (error) {
      logger.error('Failed to save MCP tool grants — restoring pre-mutation state', error);
      this.grants = previous;
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        /* not created */
      }
      throw error;
    }
  }

  /**
   * Set a grant for a user on a specific server at a permission level.
   * Throws when it could not be written. Returns the entry it replaced and the
   * one it wrote (for {@link restoreGrant}).
   */
  setGrant(
    userId: string,
    serverName: string,
    level: PermissionLevel,
    expiresAt: string,
    grantedBy: string,
  ): { replaced: GrantEntry | null; written: GrantEntry } {
    const result = this.transact(() => {
      const previous: GrantsData = JSON.parse(JSON.stringify(this.grants));
      const replaced = this.grants[userId]?.[serverName]?.[level] ?? null;
      const written: GrantEntry = { grantedAt: new Date().toISOString(), expiresAt, grantedBy };
      if (!this.grants[userId]) this.grants[userId] = {};
      if (!this.grants[userId][serverName]) this.grants[userId][serverName] = {};
      this.grants[userId][serverName][level] = written;
      this.saveGrants(previous);
      return { replaced, written };
    });
    logger.info('Grant set', { userId, serverName, level, expiresAt, grantedBy });
    return result;
  }

  /**
   * Take back a grant {@link setGrant} wrote — only when it must not stand (its
   * approval could not be delivered), and only if it is still the entry there:
   * a revoke or another grant that landed since is never undone. Puts back what
   * it replaced (nothing → the level is removed). Returns whether it changed
   * anything; throws when it could not be written.
   */
  restoreGrant(
    userId: string,
    serverName: string,
    level: PermissionLevel,
    change: { replaced: GrantEntry | null; written: GrantEntry },
  ): boolean {
    const restored = this.transact(() => {
      const server = this.grants[userId]?.[serverName];
      const current = server?.[level];
      if (!server || !current || JSON.stringify(current) !== JSON.stringify(change.written)) return false;
      const previous: GrantsData = JSON.parse(JSON.stringify(this.grants));
      if (change.replaced) server[level] = change.replaced;
      else delete server[level];
      this.saveGrants(previous);
      return true;
    });
    logger.info('Grant restored', { userId, serverName, level, restored });
    return restored;
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
    const revoked = this.transact(() => {
      const serverGrants = this.grants[userId]?.[serverName];
      if (!serverGrants) return false;
      const previous: GrantsData = JSON.parse(JSON.stringify(this.grants));
      if (level === 'all') delete this.grants[userId][serverName];
      else serverGrants[level] = null;
      this.saveGrants(previous);
      return true;
    });
    if (revoked) logger.info('Grant revoked', { userId, serverName, level });
  }
}

// Singleton instance
export const mcpToolGrantStore = new McpToolGrantStore();
