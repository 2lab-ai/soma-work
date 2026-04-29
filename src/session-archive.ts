/**
 * SessionArchiveStore — Persists session metadata to disk on terminate/expire.
 *
 * Trace: docs/session-archive/trace.md
 * Issue: #401
 *
 * Sessions are archived as individual JSON files in {DATA_DIR}/archives/.
 * Archive failure never blocks session termination (fire-and-forget with logging).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { DATA_DIR } from './env-paths';
import { Logger } from './logger';
import type {
  ActivityState,
  ConversationSession,
  SessionInstruction,
  SessionLinkHistory,
  SessionLinks,
  SessionState,
  SessionUsage,
  WorkflowType,
} from './types';

const logger = new Logger('SessionArchiveStore');

/**
 * Archived session snapshot — persisted to disk when a session is terminated or expires.
 * Contains all metadata that would otherwise be lost when the session is deleted from memory.
 */
export interface ArchivedSession {
  // Archive metadata
  archivedAt: number; // Unix ms
  archiveReason: 'terminated' | 'sleep_expired';

  // Session identity
  sessionKey: string;
  sessionId?: string;
  conversationId?: string; // → conversations/{id}.json

  // Owner
  ownerId: string;
  ownerName?: string;

  // Session context
  channelId: string;
  threadTs?: string;
  title?: string;
  model?: string;
  workflow?: WorkflowType;

  // Timestamps
  lastActivity: string; // ISO date

  // Work artifacts
  links?: SessionLinks;
  linkHistory?: SessionLinkHistory;
  instructions?: SessionInstruction[];
  mergeStats?: {
    totalLinesAdded: number;
    totalLinesDeleted: number;
    mergedPRs: Array<{
      prNumber: number;
      linesAdded: number;
      linesDeleted: number;
      mergedAt: number;
    }>;
  };

  // Usage snapshot at time of archive
  usage?: SessionUsage;

  // State at time of archive
  finalState?: SessionState;
  finalActivityState?: ActivityState;

  // Dashboard v2.1 — snapshot so closed sessions still contribute to
  // thread-level totals once the live session is gone from memory.
  busyMs?: number;
  compactionCount?: number;
  summaryTitle?: string;
}

/**
 * Filter options for listing archived sessions.
 */
export interface ArchiveFilter {
  ownerId?: string;
  model?: string;
  after?: number; // Unix ms — archivedAt >= after
  before?: number; // Unix ms — archivedAt <= before
  workflow?: string;
  limit?: number;
}

/**
 * Sanitize a session key for use as a filename.
 * Replaces characters unsafe for filenames with hyphens.
 */
function sanitizeKey(sessionKey: string): string {
  return sessionKey.replace(/[^a-zA-Z0-9._-]/g, '-');
}

/**
 * Convert a ConversationSession to an ArchivedSession snapshot.
 */
function sessionToArchive(
  session: ConversationSession,
  sessionKey: string,
  reason: 'terminated' | 'sleep_expired',
): ArchivedSession {
  return {
    archivedAt: Date.now(),
    archiveReason: reason,

    sessionKey,
    sessionId: session.sessionId,
    conversationId: session.conversationId,

    ownerId: session.ownerId,
    ownerName: session.ownerName,

    channelId: session.channelId,
    threadTs: session.threadTs,
    title: session.title,
    model: session.model,
    workflow: session.workflow,

    lastActivity: session.lastActivity.toISOString(),

    // Deep copy mutable objects to capture snapshot
    links: session.links ? JSON.parse(JSON.stringify(session.links)) : undefined,
    linkHistory: session.linkHistory ? JSON.parse(JSON.stringify(session.linkHistory)) : undefined,
    instructions: session.instructions ? JSON.parse(JSON.stringify(session.instructions)) : undefined,
    mergeStats: session.mergeStats ? JSON.parse(JSON.stringify(session.mergeStats)) : undefined,
    usage: session.usage ? JSON.parse(JSON.stringify(session.usage)) : undefined,

    finalState: session.state,
    finalActivityState: session.activityState,

    // Dashboard v2.1 — snapshot busy time + compactionCount so thread
    // aggregate keeps rendering historic totals after the live session
    // leaves memory. Fold any open leg first (MAX_LEG_MS cap lives in
    // session-registry; here we take the accumulator at face value since
    // archive is called post endTurn on the happy path).
    busyMs: session.activeAccumulatedMs,
    compactionCount: session.compactionCount,
    summaryTitle: session.summaryTitle,
  };
}

export class SessionArchiveStore {
  private archiveDir: string;
  private dirEnsured = false;

  constructor(baseDir?: string) {
    this.archiveDir = baseDir || path.join(DATA_DIR, 'archives');
  }

  /** Ensure archive directory exists (idempotent). */
  private ensureDir(): void {
    if (this.dirEnsured) return;
    try {
      if (!fs.existsSync(this.archiveDir)) {
        fs.mkdirSync(this.archiveDir, { recursive: true });
      }
      this.dirEnsured = true;
    } catch (err) {
      logger.error('Failed to create archives directory', err);
    }
  }

  /**
   * Get the file path for a given session key.
   * Uses append-only naming: {sanitizedKey}_{timestamp}.json
   * This prevents overwriting when the same thread starts a new session.
   */
  private filePath(sessionKey: string, archivedAt?: number): string {
    const ts = archivedAt || Date.now();
    return path.join(this.archiveDir, `${sanitizeKey(sessionKey)}_${ts}.json`);
  }

  /**
   * Find the most recent archive file for a session key (for load/exists).
   * Returns null if no archive exists.
   */
  private findLatestArchive(sessionKey: string): string | null {
    if (!fs.existsSync(this.archiveDir)) return null;
    const prefix = `${sanitizeKey(sessionKey)}_`;
    try {
      const files = fs
        .readdirSync(this.archiveDir)
        .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
        .sort()
        .reverse(); // newest first (lexicographic sort on timestamp suffix)
      return files.length > 0 ? path.join(this.archiveDir, files[0]) : null;
    } catch {
      return null;
    }
  }

  /**
   * Archive a session to disk.
   * MUST be called before the session is deleted from the Map.
   * Never throws — errors are logged and swallowed.
   *
   * Trace: Scenario 1 Section 3b, Scenario 2 Section 3a
   */
  archive(session: ConversationSession, sessionKey: string, reason: 'terminated' | 'sleep_expired'): void {
    try {
      this.ensureDir();
      const archived = sessionToArchive(session, sessionKey, reason);
      const data = JSON.stringify(archived, null, 2);
      const finalPath = this.filePath(sessionKey, archived.archivedAt);
      const tmpPath = `${finalPath}.tmp`;

      // Atomic write: tmp → rename
      fs.writeFileSync(tmpPath, data, 'utf-8');
      fs.renameSync(tmpPath, finalPath);

      logger.info('Session archived', { sessionKey, reason });
    } catch (err) {
      logger.error('Failed to archive session', { sessionKey, error: err });
      // Clean up orphaned tmp file (best-effort)
      try {
        const tmpPath = `${this.filePath(sessionKey, Date.now())}.tmp`;
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {
        /* ignore cleanup errors */
      }
    }
  }

  /**
   * Load a single archived session by session key.
   * Returns null if not found or corrupt.
   */
  load(sessionKey: string): ArchivedSession | null {
    try {
      const filePath = this.findLatestArchive(sessionKey);
      if (!filePath) return null;
      const data = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(data) as ArchivedSession;
    } catch (err) {
      logger.error(`Failed to load archive for ${sessionKey}`, err);
      return null;
    }
  }

  /**
   * List archived sessions within a recent time window.
   * Optimized: uses file mtime for pre-filtering to avoid parsing old files.
   *
   * Trace: Scenario 3 Section 3b
   */
  listRecent(maxAgeMs: number): ArchivedSession[] {
    const cutoff = Date.now() - maxAgeMs;
    return this.listWithFilter((archived) => archived.archivedAt >= cutoff, cutoff);
  }

  /**
   * List all archived sessions with optional filter.
   * Used by CLI (Scenario 4).
   */
  list(filter?: ArchiveFilter): ArchivedSession[] {
    const mtimeCutoff = filter?.after ? filter.after : undefined;
    const results = this.listWithFilter((archived) => {
      if (filter?.ownerId && archived.ownerId !== filter.ownerId) return false;
      if (filter?.model && archived.model !== filter.model) return false;
      if (filter?.after && archived.archivedAt < filter.after) return false;
      if (filter?.before && archived.archivedAt > filter.before) return false;
      if (filter?.workflow && archived.workflow !== filter.workflow) return false;
      return true;
    }, mtimeCutoff);

    // Sort by archivedAt desc (newest first)
    results.sort((a, b) => b.archivedAt - a.archivedAt);

    // Apply limit
    if (filter?.limit && results.length > filter.limit) {
      return results.slice(0, filter.limit);
    }
    return results;
  }

  /**
   * Check if an archive exists for a session key.
   */
  exists(sessionKey: string): boolean {
    return this.findLatestArchive(sessionKey) !== null;
  }

  /**
   * Internal: read and filter archive files with optional mtime pre-filtering.
   */
  private listWithFilter(predicate: (archived: ArchivedSession) => boolean, mtimeCutoffMs?: number): ArchivedSession[] {
    const results: ArchivedSession[] = [];

    try {
      if (!fs.existsSync(this.archiveDir)) return results;

      const files = fs.readdirSync(this.archiveDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        const filePath = path.join(this.archiveDir, file);

        // Pre-filter by mtime to skip obviously old files
        if (mtimeCutoffMs !== undefined) {
          try {
            const stat = fs.statSync(filePath);
            if (stat.mtimeMs < mtimeCutoffMs) continue;
          } catch {
            continue;
          }
        }

        try {
          const data = fs.readFileSync(filePath, 'utf-8');
          const archived = JSON.parse(data) as ArchivedSession;
          if (predicate(archived)) {
            results.push(archived);
          }
        } catch (err) {
          logger.warn(`Failed to parse archive file: ${file}`, err);
        }
      }
    } catch (err) {
      logger.error('Failed to list archives', err);
    }

    return results;
  }
}

// ── Singleton ───────────────────────────────────────────────

let _instance: SessionArchiveStore | null = null;

/**
 * Get the singleton SessionArchiveStore instance.
 */
export function getArchiveStore(): SessionArchiveStore {
  if (!_instance) {
    _instance = new SessionArchiveStore();
  }
  return _instance;
}

/**
 * Initialize with custom base directory (for testing).
 */
function initArchiveStore(baseDir?: string): SessionArchiveStore {
  _instance = new SessionArchiveStore(baseDir);
  return _instance;
}
