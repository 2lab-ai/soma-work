/**
 * SessionArchiveStore — Persists session metadata to disk on terminate/expire.
 *
 * Trace: docs/current/plans/session-archive/trace.md
 * Issue: #401
 *
 * Sessions are archived as individual JSON files in {DATA_DIR}/archives/.
 * Archive failure never blocks session termination (fire-and-forget with logging).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { sumLiveUsage } from '@soma/slack/live-usage';
import { findTranscriptPath } from '@soma/slack/pipeline/transcript-sanitizer';
import type { TaskUsage } from '@soma/slack/session-usage-math';
import { DATA_DIR } from './env-paths';
import { Logger } from './logger';
import { calculateTokenCost } from './metrics/model-registry';
import { isSafePathSegment, normalizeTmpPath } from './path-utils';
import type { AgentRegistry } from './session/agent-registry';
import type { TaskLedger } from './session/task-ledger';
import type {
  ActivityState,
  ConversationSession,
  SessionCronJob,
  SessionGoal,
  SessionIncidentRequest,
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
  /** SSOT 2026-10-26 T3 — what the whole task spent (the closed card's total). */
  taskUsage?: TaskUsage;

  // State at time of archive
  finalState?: SessionState;
  finalActivityState?: ActivityState;
  /**
   * Spec 13 §3.7 — when its work last finished (Unix ms): the switch to idle
   * or waiting, or the archive itself when it was archived mid-turn. Absent
   * when unknown (no state stamp, or an archive written before this field).
   * `lastActivity` moves on user input only, so it cannot say this.
   */
  doneAt?: number;

  // Dashboard v2.1 — snapshot so closed sessions still contribute to
  // thread-level totals once the live session is gone from memory.
  busyMs?: number;
  compactionCount?: number;
  summaryTitle?: string;

  // SSOT 2026-10-22 — so a closed card keeps its goals (T6) and tasks (T7/T8).
  goal?: SessionGoal;
  goalHistory?: SessionGoal[];
  taskLedger?: TaskLedger;

  // SSOT 2026-10-23 — a closed cron run stays filed under its job.
  cronJob?: SessionCronJob;
  // Spec 12 — so a closed card keeps its subagents.
  agents?: AgentRegistry;

  // SSOT 2026-10-30 T4.2 — what a revive needs to continue the conversation.
  /** The session's cwd: the SDK files its transcript under this directory's encoding. */
  sessionWorkingDir?: string;
  /** Incident ownership: a revived incident session must stay restricted. */
  incidentRequest?: SessionIncidentRequest;
  incidentAttemptFinishedId?: string;
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
function archiveDoneAt(session: ConversationSession, now: number): number | undefined {
  if ((session.activityState || 'idle') === 'working') return now;
  const changed = session.activityStateChangedAt;
  return typeof changed === 'number' && Number.isFinite(changed) ? changed : undefined;
}

function sessionToArchive(
  session: ConversationSession,
  sessionKey: string,
  reason: 'terminated' | 'sleep_expired',
): ArchivedSession {
  const now = Date.now();
  return {
    archivedAt: now,
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
    taskUsage: archivedTaskUsage(session),

    finalState: session.state,
    finalActivityState: session.activityState,
    doneAt: archiveDoneAt(session, now),

    // Dashboard v2.1 — snapshot busy time + compactionCount so thread
    // aggregate keeps rendering historic totals after the live session
    // leaves memory. Fold any open leg first (MAX_LEG_MS cap lives in
    // session-registry; here we take the accumulator at face value since
    // archive is called post endTurn on the happy path).
    busyMs: session.activeAccumulatedMs,
    compactionCount: session.compactionCount,
    summaryTitle: session.summaryTitle,
    goal: session.goal ? JSON.parse(JSON.stringify(session.goal)) : undefined,
    goalHistory: session.goalHistory ? JSON.parse(JSON.stringify(session.goalHistory)) : undefined,
    taskLedger: session.taskLedger ? JSON.parse(JSON.stringify(session.taskLedger)) : undefined,
    cronJob: session.cronJob ? { ...session.cronJob } : undefined,
    agents: session.agents ? JSON.parse(JSON.stringify(session.agents)) : undefined,
    sessionWorkingDir: session.sessionWorkingDir,
    incidentRequest: session.incidentRequest ? JSON.parse(JSON.stringify(session.incidentRequest)) : undefined,
    incidentAttemptFinishedId: session.incidentAttemptFinishedId,
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
   * The exact archive a board card names (`archived_<sessionKey>_<archivedAt>`),
   * or null. Never "the latest for the thread": a thread archived twice has two
   * snapshots, and reviving a card must bring back the one it shows. A file
   * whose content names another session is not this card's archive.
   */
  load(sessionKey: string, archivedAt: number): ArchivedSession | null {
    if (!Number.isSafeInteger(archivedAt) || archivedAt <= 0) return null;
    const file = this.filePath(sessionKey, archivedAt);
    try {
      if (!fs.existsSync(file)) return null;
      const archived = JSON.parse(fs.readFileSync(file, 'utf-8')) as ArchivedSession;
      if (!archived || archived.sessionKey !== sessionKey || archived.archivedAt !== archivedAt) return null;
      return archived;
    } catch (err) {
      logger.warn('Failed to read archive file', { sessionKey, archivedAt, error: err });
      return null;
    }
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

// ── Revive (SSOT 2026-10-30 T4) ─────────────────────────────

/**
 * What a star / revive did, or why it refused. Shared by the registry (which
 * acts) and the dashboard (which answers the request with it).
 */
export type SessionLifecycleOutcome =
  | { ok: true; sessionKey: string; starred: boolean; revived: boolean }
  | {
      ok: false;
      code:
        | 'not_found'
        | 'forbidden'
        | 'terminated'
        | 'conflict'
        | 'no_conversation'
        | 'transcript_missing'
        | 'invalid_cwd'
        | 'incident_provenance';
      message: string;
    };

type ResumeRefusal = Extract<SessionLifecycleOutcome, { ok: false }>;

/** A transcript head holds the cwd in its first lines; this much is plenty. */
const TRANSCRIPT_HEAD_BYTES = 256 * 1024;

/** The SDK's project directory name for a cwd: every non-alphanumeric character becomes `-`. */
function sdkProjectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** The first `cwd` the transcript records (its head only), or undefined. */
function transcriptCwd(file: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(TRANSCRIPT_HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.subarray(0, n).toString('utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as { cwd?: unknown };
        if (typeof row.cwd === 'string' && row.cwd) return row.cwd;
      } catch {
        // a line cut by the head limit, or not JSON — keep looking
      }
    }
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return undefined;
}

/**
 * A cwd the revived session may run in: a session directory of its owner
 * (`/tmp/<ownerId>/<dir>`, no traversal), whose SDK project directory is the
 * one the transcript lives in — so `resume` finds exactly this conversation.
 */
function provenCwd(candidate: string | undefined, ownerId: string, projectDir: string): string | undefined {
  if (!candidate || !isSafePathSegment(ownerId)) return undefined;
  const cwd = normalizeTmpPath(candidate).replace(/\/+$/, '');
  if (cwd.includes('..') || !cwd.startsWith(`/tmp/${ownerId}/`)) return undefined;
  if (cwd.split('/').filter(Boolean).length < 3) return undefined;
  const resolves = sdkProjectDirName(cwd) === projectDir || sdkProjectDirName(`/private${cwd}`) === projectDir;
  return resolves ? cwd : undefined;
}

/**
 * Whether an archived session can be brought back to continue its
 * conversation, and the cwd it must run in. Never a silent fresh start: no SDK
 * session, no transcript, or a cwd that does not provably resolve to the
 * transcript is a refusal the user sees.
 *
 * The kept `sessionWorkingDir` is the source; an archive written before that
 * field falls back to the cwd the transcript itself records — accepted only
 * when it passes the same proof (owner's /tmp dir, encodes to the transcript's
 * project directory), so it is the SDK's own lookup key, not a guess.
 *
 * An archive from an incident channel without its incident ownership cannot be
 * revived: it would come back as an ordinary, steerable session.
 */
export function resolveArchivedResume(
  archived: ArchivedSession,
  opts: { configDir?: string; incidentChannelIds?: readonly string[] } = {},
): { ok: true; cwd: string } | ResumeRefusal {
  if (!archived.sessionId) {
    return { ok: false, code: 'no_conversation', message: '이어갈 대화가 없는 세션이에요 (모델과 대화한 적이 없음)' };
  }
  if (!archived.incidentRequest && opts.incidentChannelIds?.includes(archived.channelId)) {
    return { ok: false, code: 'incident_provenance', message: '인시던트 채널의 세션은 소유 정보 없이 살릴 수 없어요' };
  }
  const transcript = findTranscriptPath(archived.sessionId, opts.configDir);
  if (!transcript) {
    return { ok: false, code: 'transcript_missing', message: '대화 기록(transcript)을 찾을 수 없어 이어갈 수 없어요' };
  }
  const projectDir = path.basename(path.dirname(transcript));
  const cwd = archived.sessionWorkingDir
    ? provenCwd(archived.sessionWorkingDir, archived.ownerId, projectDir)
    : provenCwd(transcriptCwd(transcript), archived.ownerId, projectDir);
  if (!cwd) {
    return { ok: false, code: 'invalid_cwd', message: '세션 작업 폴더가 대화 기록과 맞지 않아 이어갈 수 없어요' };
  }
  return { ok: true, cwd };
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
 * SSOT 2026-10-26 T3 — the task total a closed card keeps: the committed
 * total plus the calls the running turn already made. A session closed
 * mid-turn is archived before its turn's cleanup folds those calls in (into
 * an object nobody saves any more), so they are taken here, priced at the
 * session model like the rest of the live cost.
 */
function archivedTaskUsage(session: ConversationSession): TaskUsage | undefined {
  const live = sumLiveUsage(session.liveUsage);
  const liveTokens = live.inputTokens + live.outputTokens + live.cacheReadTokens + live.cacheCreateTokens;
  if (!session.taskUsage && liveTokens === 0) return undefined;
  const t: TaskUsage = session.taskUsage
    ? JSON.parse(JSON.stringify(session.taskUsage))
    : { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, costUsd: 0 };
  delete t.pendingFold;
  if (liveTokens > 0) {
    t.inputTokens += live.inputTokens;
    t.outputTokens += live.outputTokens;
    t.cacheReadTokens += live.cacheReadTokens;
    t.cacheCreateTokens += live.cacheCreateTokens;
    const cost = calculateTokenCost(
      session.model,
      live.inputTokens,
      live.outputTokens,
      live.cacheReadTokens,
      live.cacheCreateTokens,
    );
    if (Number.isFinite(cost) && cost > 0) t.costUsd += cost;
  }
  return t;
}
