/**
 * SessionRegistry - Manages conversation sessions and persistence
 * Extracted from claude-handler.ts (Phase 5.1)
 */

import * as fs from 'fs';
import * as path from 'path';
import { applyInstructionOperations } from 'somalib/model-commands/catalog';
import { decodeSlackEntities } from './dispatch-service';
import { DATA_DIR } from './env-paths';
import { Logger } from './logger';
import { getMetricsEmitter } from './metrics/event-emitter';
import { normalizeTmpPath } from './path-utils';
import { getArchiveStore } from './session-archive';
import type {
  ActionPanelState,
  ActivityState,
  ConversationSession,
  SessionInstruction,
  SessionLink,
  SessionLinkHistory,
  SessionLinks,
  SessionResourceOperation,
  SessionResourceSnapshot,
  SessionResourceType,
  SessionResourceUpdateRequest,
  SessionResourceUpdateResult,
  SessionState,
  WorkflowType,
} from './types';
import { type EffortLevel, userSettingsStore } from './user-settings-store';

const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

// Default session timeout: 24 hours (Active → Sleep)
const DEFAULT_SESSION_TIMEOUT = 24 * 60 * 60 * 1000;

// Dashboard improvements (v2.1): max duration of a single active-leg before we
// assume the process missed an endTurn (crash / OS sleep) and cap the accumulator.
// 30min default. idle은 대부분 이내 재개, OS sleep/crash는 이보다 길다고 가정.
export const MAX_LEG_MS = Number(process.env.MAX_LEG_MS) || 30 * 60 * 1000;

// Maximum sleep duration: 7 days (Sleep → Delete)
const MAX_SLEEP_DURATION = 7 * 24 * 60 * 60 * 1000;

// Session expiry warning intervals in milliseconds (from session expiry time)
// Sorted descending: most urgent first
const WARNING_INTERVALS = [
  12 * 60 * 60 * 1000, // 12 hours remaining - idle check (ask if session is done)
  10 * 60 * 1000, // 10 minutes remaining - final warning
];

const HISTORY_KEY_BY_RESOURCE: Record<SessionResourceType, keyof SessionLinkHistory> = {
  issue: 'issues',
  pr: 'prs',
  doc: 'docs',
};

const ACTIVE_KEY_BY_RESOURCE: Record<SessionResourceType, keyof SessionLinks> = {
  issue: 'issue',
  pr: 'pr',
  doc: 'doc',
};

/**
 * Serialized session for file persistence
 */
interface SerializedSession {
  key: string;
  ownerId: string;
  ownerName?: string;
  userId: string; // Legacy field
  channelId: string;
  threadTs?: string;
  sessionId?: string;
  isActive: boolean;
  lastActivity: string; // ISO date string
  workingDirectory?: string;
  title?: string;
  model?: string;
  // Session state machine fields
  state?: SessionState;
  workflow?: WorkflowType;
  // Session links
  links?: SessionLinks;
  linkHistory?: SessionLinkHistory;
  linkSequence?: number;
  // Sleep mode
  sleepStartedAt?: string; // ISO date string
  // Activity state
  activityState?: ActivityState;
  // Log verbosity bitmask
  logVerbosity?: number;
  // Effort level for Claude thinking
  effort?: EffortLevel;
  // Extended thinking (adaptive reasoning) toggle
  thinkingEnabled?: boolean;
  // Thinking summary display toggle
  showThinking?: boolean;
  // Action panel state
  actionPanel?: ActionPanelState;
  // Bot-initiated thread metadata
  threadModel?: 'user-initiated' | 'bot-initiated';
  threadRootTs?: string;
  // Onboarding flag
  isOnboarding?: boolean;
  // Source working directories tracked for cleanup
  sourceWorkingDirs?: string[];
  // Mid-thread source thread reference
  sourceThread?: { channel: string; threadTs: string };
  // Session-unique working directory for workspace isolation (#77)
  sessionWorkingDir?: string;
  // Conversation record ID (links session to conversation history)
  conversationId?: string;
  // Merge code change stats
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
  // User SSOT instructions (persisted)
  instructions?: SessionInstruction[];
  // Dashboard v2.1 — thread-aggregate snapshot fields (live aggregate derived from memory).
  compactionCount?: number;
  activeLegStartedAtMs?: number;
  activeAccumulatedMs?: number;
  summaryTitle?: string;
  summaryTitleTurnId?: string;
  summaryTitleLastUpdatedAtMs?: number;
}

/**
 * Callbacks for session expiry events
 */
export interface SessionExpiryCallbacks {
  onWarning: (
    session: ConversationSession,
    timeRemaining: number,
    warningMessageTs?: string,
  ) => Promise<string | undefined>;
  onSleep: (session: ConversationSession) => Promise<void>;
  onExpiry: (session: ConversationSession) => Promise<void>;
}

/**
 * SessionRegistry manages all conversation sessions
 * - Session CRUD operations
 * - Session persistence (save/load)
 * - Session expiry and cleanup
 */
export interface CrashRecoveredSession {
  channelId: string;
  threadTs?: string;
  ownerId: string;
  ownerName?: string;
  activityState: string;
  sessionKey: string;
  /** Session title at the time of crash — gives the model context about what was happening */
  title?: string;
  /** Workflow type (default, jira-create-pr, pr-review, etc.) */
  workflow?: string;
}

export class SessionRegistry {
  private sessions: Map<string, ConversationSession> = new Map();
  private logger = new Logger('SessionRegistry');
  private expiryCallbacks?: SessionExpiryCallbacks;
  private _crashRecoveredSessions: CrashRecoveredSession[] = [];

  /**
   * onIdle callback registry — fired when session transitions to idle.
   * Trace: docs/cron-scheduler/trace.md, Scenario 5, Section 3b-3c
   */
  private onIdleCallbacks: Map<string, Array<() => void>> = new Map();

  /**
   * Callback fired whenever any session's activity state changes.
   * Used by the dashboard WebSocket to push real-time updates.
   */
  private onActivityStateChangeCallback?: () => void;

  /**
   * Set callbacks for session expiry events
   */
  setExpiryCallbacks(callbacks: SessionExpiryCallbacks): void {
    this.expiryCallbacks = callbacks;
  }

  /**
   * Register callback for activity state changes (e.g., dashboard WebSocket broadcast)
   */
  setActivityStateChangeCallback(callback: () => void): void {
    this.onActivityStateChangeCallback = callback;
  }

  /**
   * Fire the activity-state/session-update callback without changing session state.
   * Used by turn-timer / compaction-counter paths so dashboard reflects changes.
   */
  broadcastSessionUpdate(): void {
    try {
      this.onActivityStateChangeCallback?.();
    } catch (err) {
      this.logger.debug('broadcastSessionUpdate failed', { error: err });
    }
  }

  /**
   * Get session key - based on channel and thread only (shared session)
   */
  getSessionKey(channelId: string, threadTs?: string): string {
    return `${channelId}-${threadTs || 'direct'}`;
  }

  /**
   * Legacy method for backward compatibility - ignores userId
   */
  getSessionKeyWithUser(userId: string, channelId: string, threadTs?: string): string {
    return this.getSessionKey(channelId, threadTs);
  }

  /**
   * Get a session by channel and thread
   */
  getSession(channelId: string, threadTs?: string): ConversationSession | undefined {
    return this.sessions.get(this.getSessionKey(channelId, threadTs));
  }

  /**
   * Legacy method for backward compatibility
   */
  getSessionWithUser(userId: string, channelId: string, threadTs?: string): ConversationSession | undefined {
    return this.getSession(channelId, threadTs);
  }

  /**
   * Get a session by its key directly
   */
  getSessionByKey(sessionKey: string): ConversationSession | undefined {
    return this.sessions.get(sessionKey);
  }

  /**
   * Find a session that was created from a mid-thread mention in the given thread.
   * Reverse lookup: original thread → bot-initiated session.
   */
  findSessionBySourceThread(channel: string, threadTs: string): ConversationSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.sourceThread?.channel === channel && session.sourceThread?.threadTs === threadTs) {
        return session;
      }
    }
    return undefined;
  }

  /**
   * Get all active sessions
   */
  getAllSessions(): Map<string, ConversationSession> {
    return this.sessions;
  }

  /**
   * Dashboard v2.1 — Turn timer hooks (called from stream-executor).
   * Kept on the registry so tests can exercise the timer + persistence path
   * without booting the full Slack pipeline.
   */
  beginTurn(session: ConversationSession, now: number = Date.now()): void {
    // Fold any stale leg first (MAX_LEG_MS cap covers crash / missed endTurn).
    if (session.activeLegStartedAtMs) {
      const elapsed = Math.min(now - session.activeLegStartedAtMs, MAX_LEG_MS);
      session.activeAccumulatedMs = (session.activeAccumulatedMs || 0) + Math.max(0, elapsed);
    }
    session.activeLegStartedAtMs = now;
  }

  endTurn(session: ConversationSession, now: number = Date.now()): void {
    if (session.activeLegStartedAtMs) {
      const elapsed = Math.min(now - session.activeLegStartedAtMs, MAX_LEG_MS);
      session.activeAccumulatedMs = (session.activeAccumulatedMs || 0) + Math.max(0, elapsed);
    }
    session.activeLegStartedAtMs = undefined;
  }

  /**
   * Live thread-level aggregate derived from in-memory sessions sharing a threadKey.
   * Returns derived totals — never a persisted top-level store.
   */
  getThreadAggregate(
    channelId: string,
    threadTs: string | undefined,
    now: number = Date.now(),
  ): { totalActiveMs: number; sessionCount: number; compactionCount: number } {
    const threadKey = `${channelId}-${threadTs || 'direct'}`;
    let totalActiveMs = 0;
    let sessionCount = 0;
    let compactionCount = 0;
    for (const [key, s] of this.sessions.entries()) {
      if (key !== threadKey) continue;
      sessionCount += 1;
      compactionCount += s.compactionCount || 0;
      let acc = s.activeAccumulatedMs || 0;
      if (s.activeLegStartedAtMs) {
        acc += Math.min(now - s.activeLegStartedAtMs, MAX_LEG_MS);
      }
      totalActiveMs += acc;
    }
    return { totalActiveMs, sessionCount, compactionCount };
  }

  /**
   * Create a new session
   */
  createSession(
    ownerId: string,
    ownerName: string,
    channelId: string,
    threadTs?: string,
    model?: string,
  ): ConversationSession {
    // Get user's default model if not provided
    const sessionModel = model || userSettingsStore.getUserDefaultModel(ownerId);

    const session: ConversationSession = {
      ownerId,
      ownerName,
      userId: ownerId, // Legacy field
      channelId,
      threadTs,
      isActive: true,
      lastActivity: new Date(),
      model: sessionModel,
      logVerbosity: userSettingsStore.getUserLogVerbosityFlags(ownerId),
      effort: userSettingsStore.getUserDefaultEffort(ownerId),
      state: 'INITIALIZING', // Start in INITIALIZING state
      activityState: 'idle',
      // Compaction Tracking (#617): explicit zero-state for epoch-based dedupe.
      compactEpoch: 0,
      compactPostedByEpoch: {},
      compactionRehydratedByEpoch: {},
      preCompactUsagePct: null,
      lastKnownUsagePct: null,
      autoCompactPending: false,
      pendingUserText: null,
      pendingEventContext: null,
    };

    this.sessions.set(this.getSessionKey(channelId, threadTs), session);

    // Metrics: emit session_created event (fire-and-forget)
    getMetricsEmitter()
      .emitSessionCreated(session)
      .catch((err) => this.logger.debug('metrics emit failed', err));

    return session;
  }

  /**
   * Transition session from INITIALIZING to MAIN state
   * Sets the workflow type determined by dispatch
   * @returns true if transition succeeded, false if session not found or already transitioned
   */
  transitionToMain(channelId: string, threadTs: string | undefined, workflow: WorkflowType, title?: string): boolean {
    const session = this.getSession(channelId, threadTs);
    if (!session) {
      this.logger.debug('transitionToMain: session not found', { channelId, threadTs });
      return false;
    }

    if (session.state !== 'INITIALIZING') {
      // This is expected in race conditions where another dispatch completed first
      // Use debug level to avoid noisy logs
      this.logger.debug('Session already transitioned (idempotent)', {
        channelId,
        threadTs,
        currentState: session.state,
        currentWorkflow: session.workflow,
        attemptedWorkflow: workflow,
      });
      return false;
    }

    session.state = 'MAIN';
    session.workflow = workflow;
    if (title && !session.title) {
      session.title = title;
    }
    this.logger.info('Session transitioned to MAIN', {
      channelId,
      threadTs,
      workflow,
    });
    this.saveSessions();
    return true;
  }

  /**
   * Get session state
   */
  getSessionState(channelId: string, threadTs?: string): SessionState | undefined {
    const session = this.getSession(channelId, threadTs);
    return session?.state;
  }

  /**
   * Get session workflow
   */
  getSessionWorkflow(channelId: string, threadTs?: string): WorkflowType | undefined {
    const session = this.getSession(channelId, threadTs);
    return session?.workflow;
  }

  /**
   * Check if session needs dispatch (is in INITIALIZING state)
   */
  needsDispatch(channelId: string, threadTs?: string): boolean {
    const session = this.getSession(channelId, threadTs);
    return session?.state === 'INITIALIZING';
  }

  /**
   * Check if session is sleeping
   */
  isSleeping(channelId: string, threadTs?: string): boolean {
    const session = this.getSession(channelId, threadTs);
    return session?.state === 'SLEEPING';
  }

  /**
   * Transition session to SLEEPING state
   * Called when session has been inactive for 24 hours
   */
  transitionToSleep(channelId: string, threadTs?: string): boolean {
    const session = this.getSession(channelId, threadTs);
    if (!session || session.state === 'SLEEPING') return false;

    session.state = 'SLEEPING';
    session.sleepStartedAt = new Date();
    // Clear warning state
    session.warningMessageTs = undefined;
    session.lastWarningSentAt = undefined;

    this.logger.info('Session transitioned to SLEEPING', {
      channelId,
      threadTs,
      sessionId: session.sessionId,
      owner: session.ownerName,
    });
    this.saveSessions();

    // Metrics: emit session_slept event (fire-and-forget)
    getMetricsEmitter()
      .emitSessionSlept(session)
      .catch((err) => this.logger.debug('metrics emit failed', err));

    return true;
  }

  /**
   * Wake session from SLEEPING back to MAIN state
   * Called when user sends a message to a sleeping session
   */
  wakeFromSleep(channelId: string, threadTs?: string): boolean {
    const session = this.getSession(channelId, threadTs);
    if (!session || session.state !== 'SLEEPING') return false;

    session.state = 'MAIN';
    session.sleepStartedAt = undefined;
    session.lastActivity = new Date();
    // Clear warning state
    session.warningMessageTs = undefined;
    session.lastWarningSentAt = undefined;

    this.logger.info('Session woken from sleep', {
      channelId,
      threadTs,
      sessionId: session.sessionId,
      owner: session.ownerName,
    });
    this.saveSessions();
    return true;
  }

  /**
   * Set activity state for a session (working/waiting/idle)
   * Only persists on transition to idle (to avoid excessive disk writes during active work)
   */
  setActivityState(channelId: string, threadTs: string | undefined, state: ActivityState): void {
    const session = this.getSession(channelId, threadTs);
    if (!session) return;
    if (session.activityState === state) return; // No-op for duplicate transitions

    session.activityState = state;
    session.activityStateChangedAt = Date.now();

    this.logger.debug('Activity state changed', {
      channelId,
      threadTs,
      state,
    });

    // Notify dashboard WebSocket clients
    try {
      this.onActivityStateChangeCallback?.();
    } catch {
      /* fire-and-forget */
    }

    // Only persist on idle transition to minimize disk I/O
    if (state === 'idle') {
      this.saveSessions();
      // Drain onIdle callbacks (e.g., pending cron jobs)
      // Trace: docs/cron-scheduler/trace.md, Scenario 5, Section 3b
      const sessionKey = this.getSessionKey(channelId, threadTs);
      this.drainOnIdleCallbacks(sessionKey);
    }
  }

  /**
   * Set activity state by session key
   */
  setActivityStateByKey(sessionKey: string, state: ActivityState): void {
    const session = this.getSessionByKey(sessionKey);
    if (!session) return;
    if (session.activityState === state) return;

    session.activityState = state;
    session.activityStateChangedAt = Date.now();
    this.logger.debug('Activity state changed', { sessionKey, state });

    // Notify dashboard WebSocket clients (was missing — caused stale dashboard state)
    try {
      this.onActivityStateChangeCallback?.();
    } catch (err) {
      this.logger.debug('Activity state change callback failed', { sessionKey, state, error: err });
    }

    if (state === 'idle') {
      this.saveSessions();
      // Drain onIdle callbacks (e.g., pending cron jobs)
      this.drainOnIdleCallbacks(sessionKey);
    }
  }

  /**
   * Get activity state for a session
   */
  getActivityState(channelId: string, threadTs?: string): ActivityState | undefined {
    const session = this.getSession(channelId, threadTs);
    return session?.activityState;
  }

  /**
   * Get activity state by session key
   */
  getActivityStateByKey(sessionKey: string): ActivityState | undefined {
    const session = this.getSessionByKey(sessionKey);
    return session?.activityState;
  }

  /**
   * Register a callback to be fired when a session transitions to idle.
   * Trace: docs/cron-scheduler/trace.md, Scenario 5, Section 3c
   */
  registerOnIdle(sessionKey: string, callback: () => void): void {
    const existing = this.onIdleCallbacks.get(sessionKey) || [];
    existing.push(callback);
    this.onIdleCallbacks.set(sessionKey, existing);
    this.logger.debug('Registered onIdle callback', { sessionKey, total: existing.length });
  }

  /**
   * Drain and execute all onIdle callbacks for a session.
   * Fire-and-forget: each callback wrapped in try/catch.
   * Trace: docs/cron-scheduler/trace.md, Scenario 5, Section 3b
   */
  private drainOnIdleCallbacks(sessionKey: string): void {
    const callbacks = this.onIdleCallbacks.get(sessionKey);
    if (!callbacks || callbacks.length === 0) return;

    this.logger.debug('Draining onIdle callbacks', { sessionKey, count: callbacks.length });
    this.onIdleCallbacks.delete(sessionKey);

    for (const cb of callbacks) {
      try {
        cb();
      } catch (error: any) {
        this.logger.warn('onIdle callback failed', { sessionKey, error: error?.message });
      }
    }
  }

  /**
   * Clear onIdle callbacks for a session (e.g., on session removal).
   * Trace: docs/cron-scheduler/trace.md, Scenario 5, Section 5
   */
  clearOnIdleCallbacks(sessionKey: string): void {
    this.onIdleCallbacks.delete(sessionKey);
  }

  /**
   * Set session title (typically auto-generated from first Q&A).
   * Only sets if title is not already present.
   */
  setSessionTitle(channelId: string, threadTs: string | undefined, title: string): void {
    const session = this.getSession(channelId, threadTs);
    if (session && !session.title) {
      session.title = decodeSlackEntities(title);
      this.saveSessions();
    }
  }

  /**
   * Update session title unconditionally (e.g. when issue is linked or PR is merged).
   * Unlike setSessionTitle, this overwrites existing title.
   */
  updateSessionTitle(channelId: string, threadTs: string | undefined, title: string): void {
    const session = this.getSession(channelId, threadTs);
    if (session) {
      session.title = decodeSlackEntities(title);
      this.saveSessions();
    }
  }

  /**
   * Record merge code change stats (lines added/deleted) for a merged PR in this session.
   */
  addMergeStats(
    channelId: string,
    threadTs: string | undefined,
    prNumber: number,
    linesAdded: number,
    linesDeleted: number,
  ): void {
    const session = this.getSession(channelId, threadTs);
    if (!session) return;

    if (!session.mergeStats) {
      session.mergeStats = { totalLinesAdded: 0, totalLinesDeleted: 0, mergedPRs: [] };
    }

    session.mergeStats.totalLinesAdded += linesAdded;
    session.mergeStats.totalLinesDeleted += linesDeleted;
    session.mergeStats.mergedPRs.push({
      prNumber,
      linesAdded,
      linesDeleted,
      mergedAt: Date.now(),
    });
    this.saveSessions();
  }

  /**
   * Set a link on a session (issue, pr, or doc)
   */
  setSessionLink(channelId: string, threadTs: string | undefined, link: SessionLink): void {
    this.updateSessionResources(channelId, threadTs, {
      operations: [
        {
          action: 'add',
          resourceType: link.type,
          link,
        },
      ],
    });
  }

  /**
   * Set multiple session links at once
   */
  setSessionLinks(channelId: string, threadTs: string | undefined, links: SessionLinks): void {
    const operations: SessionResourceOperation[] = [];

    if (links.issue) {
      operations.push({
        action: 'add',
        resourceType: 'issue',
        link: links.issue,
      });
    }
    if (links.pr) {
      operations.push({
        action: 'add',
        resourceType: 'pr',
        link: links.pr,
      });
    }
    if (links.doc) {
      operations.push({
        action: 'add',
        resourceType: 'doc',
        link: links.doc,
      });
    }

    if (operations.length === 0) {
      return;
    }

    this.updateSessionResources(channelId, threadTs, { operations });
  }

  /**
   * Refresh session activity timestamp and clear warning state.
   * Used when user clicks "Keep" on idle check prompt.
   */
  refreshSessionActivity(channelId: string, threadTs: string | undefined): boolean {
    return this.refreshSessionActivityByKey(this.getSessionKey(channelId, threadTs));
  }

  /**
   * Refresh session activity by session key.
   */
  refreshSessionActivityByKey(sessionKey: string): boolean {
    const session = this.getSessionByKey(sessionKey);
    if (!session) return false;
    session.lastActivity = new Date();
    session.lastWarningSentAt = undefined;
    session.warningMessageTs = undefined;
    this.saveSessions();
    return true;
  }

  /**
   * Get session links
   */
  getSessionLinks(channelId: string, threadTs?: string): SessionLinks | undefined {
    const session = this.getSession(channelId, threadTs);
    if (session) {
      this.ensureSessionLinkState(session);
    }
    return session?.links;
  }

  /**
   * Get current session resource snapshot used by model-command tool.
   */
  getSessionResourceSnapshot(channelId: string, threadTs?: string): SessionResourceSnapshot {
    const session = this.getSession(channelId, threadTs);
    return this.buildSessionResourceSnapshot(session);
  }

  /**
   * Update session resources (issues/prs/docs + active links) with optimistic locking.
   */
  updateSessionResources(
    channelId: string,
    threadTs: string | undefined,
    request: SessionResourceUpdateRequest,
  ): SessionResourceUpdateResult {
    const session = this.getSession(channelId, threadTs);
    if (!session) {
      return {
        ok: false,
        reason: 'SESSION_NOT_FOUND',
        error: 'Session not found',
        snapshot: this.buildSessionResourceSnapshot(undefined),
      };
    }

    this.ensureSessionLinkState(session);

    const currentSequence = session.linkSequence ?? 0;
    if (typeof request.expectedSequence === 'number' && request.expectedSequence !== currentSequence) {
      return {
        ok: false,
        reason: 'SEQUENCE_MISMATCH',
        error: 'Session sequence mismatch',
        sequenceMismatch: {
          expected: request.expectedSequence,
          actual: currentSequence,
        },
        snapshot: this.buildSessionResourceSnapshot(session),
      };
    }

    const applyResult = this.applySessionResourceOperations(session, request.operations ?? []);
    if (!applyResult.ok) {
      return {
        ok: false,
        reason: 'INVALID_OPERATION',
        error: applyResult.error,
        snapshot: this.buildSessionResourceSnapshot(session),
      };
    }

    // Apply instruction operations (shared helper)
    if (!session.instructions) {
      session.instructions = [];
    }
    const instructionChanged = applyInstructionOperations(session.instructions, request.instructionOperations);

    if (applyResult.changed || instructionChanged) {
      session.linkSequence = (session.linkSequence ?? 0) + 1;
      this.saveSessions();
    }

    return {
      ok: true,
      snapshot: this.buildSessionResourceSnapshot(session),
    };
  }

  private buildSessionResourceSnapshot(session: ConversationSession | undefined): SessionResourceSnapshot {
    if (!session) {
      return {
        issues: [],
        prs: [],
        docs: [],
        active: {},
        instructions: [],
        sequence: 0,
      };
    }

    this.ensureSessionLinkState(session);
    const history = session.linkHistory!;
    return {
      issues: history.issues.map((link) => ({ ...link })),
      prs: history.prs.map((link) => ({ ...link })),
      docs: history.docs.map((link) => ({ ...link })),
      active: {
        issue: session.links?.issue ? { ...session.links.issue } : undefined,
        pr: session.links?.pr ? { ...session.links.pr } : undefined,
        doc: session.links?.doc ? { ...session.links.doc } : undefined,
      },
      instructions: (session.instructions || []).map((i) => ({ ...i })),
      sequence: session.linkSequence ?? 0,
    };
  }

  private ensureSessionLinkState(session: ConversationSession): void {
    if (!session.links) {
      session.links = {};
    }

    if (!session.linkHistory) {
      session.linkHistory = {
        issues: [],
        prs: [],
        docs: [],
      };
    }

    for (const resourceType of Object.keys(HISTORY_KEY_BY_RESOURCE) as SessionResourceType[]) {
      const historyKey = HISTORY_KEY_BY_RESOURCE[resourceType];
      const activeKey = ACTIVE_KEY_BY_RESOURCE[resourceType];

      const deduped = new Map<string, SessionLink>();
      for (const link of session.linkHistory[historyKey]) {
        if (!link?.url) continue;
        deduped.set(link.url, this.normalizeSessionLink(link, resourceType));
      }

      const activeLink = session.links[activeKey];
      if (activeLink?.url) {
        deduped.set(activeLink.url, this.normalizeSessionLink(activeLink, resourceType));
      }

      const normalizedHistory = Array.from(deduped.values());
      session.linkHistory[historyKey] = normalizedHistory;

      if (activeLink?.url) {
        const foundActive = normalizedHistory.find((link) => link.url === activeLink.url);
        session.links[activeKey] = foundActive ? { ...foundActive } : undefined;
      }
    }

    if (!Number.isInteger(session.linkSequence)) {
      session.linkSequence = 0;
    }
  }

  private applySessionResourceOperations(
    session: ConversationSession,
    operations: SessionResourceOperation[],
  ): { ok: true; changed: boolean } | { ok: false; changed: boolean; error: string } {
    this.ensureSessionLinkState(session);

    let changed = false;

    for (const operation of operations) {
      const historyKey = HISTORY_KEY_BY_RESOURCE[operation.resourceType];
      const activeKey = ACTIVE_KEY_BY_RESOURCE[operation.resourceType];
      const history = session.linkHistory![historyKey];

      if (operation.action === 'add') {
        if (!operation.link?.url) {
          return {
            ok: false,
            changed,
            error: `add operation requires link url (${operation.resourceType})`,
          };
        }

        const normalized = this.normalizeSessionLink(operation.link, operation.resourceType);
        const existingIndex = history.findIndex((link) => link.url === normalized.url);
        if (existingIndex >= 0) {
          history.splice(existingIndex, 1);
        }
        history.push(normalized);
        session.links![activeKey] = { ...normalized };
        changed = true;

        // Metrics: emit GitHub events on resource link changes (fire-and-forget)
        // NOTE: pr_created / pr_merged are emitted exclusively from tool-result-interceptor.ts
        //       (single source of truth via stdout parsing). Only issue_created is emitted here.
        if (existingIndex < 0 && operation.resourceType === 'issue') {
          const emitter = getMetricsEmitter();
          const sessionKey = `${session.channelId}-${session.threadTs || 'direct'}`;
          emitter
            .emitGitHubEvent('issue_created', session.ownerId, session.ownerName || 'unknown', sessionKey, {
              url: normalized.url,
            })
            .catch((err) => this.logger.debug('metrics emit failed', err));
        }

        continue;
      }

      if (operation.action === 'remove') {
        const existingIndex = history.findIndex((link) => link.url === operation.url);
        if (existingIndex >= 0) {
          history.splice(existingIndex, 1);
          changed = true;
        }

        if (session.links![activeKey]?.url === operation.url) {
          session.links![activeKey] = history.length > 0 ? { ...history[history.length - 1] } : undefined;
          changed = true;
        }
        continue;
      }

      if (!operation.url) {
        if (session.links![activeKey]) {
          session.links![activeKey] = undefined;
          changed = true;
        }
        continue;
      }

      const found = history.find((link) => link.url === operation.url);
      if (!found) {
        return {
          ok: false,
          changed,
          error: `set_active target not found in ${operation.resourceType} history: ${operation.url}`,
        };
      }

      if (session.links![activeKey]?.url !== found.url) {
        session.links![activeKey] = { ...found };
        changed = true;
      }
    }

    return { ok: true, changed };
  }

  private normalizeSessionLink(link: SessionLink, type: SessionResourceType): SessionLink {
    return {
      ...link,
      type,
      provider: link.provider || 'unknown',
    };
  }

  /**
   * Update the current initiator of a session
   */
  updateInitiator(channelId: string, threadTs: string | undefined, initiatorId: string, initiatorName: string): void {
    const session = this.getSession(channelId, threadTs);
    if (session) {
      session.currentInitiatorId = initiatorId;
      session.currentInitiatorName = initiatorName;
      session.lastActivity = new Date();
    }
  }

  /**
   * Check if a user can interrupt the current response
   * Only owner or current initiator can interrupt
   */
  canInterrupt(channelId: string, threadTs: string | undefined, userId: string): boolean {
    const session = this.getSession(channelId, threadTs);
    if (!session) return true;
    return session.ownerId === userId || session.currentInitiatorId === userId;
  }

  /**
   * Update session with session ID from Claude SDK
   */
  updateSessionId(channelId: string, threadTs: string | undefined, sessionId: string): void {
    const session = this.getSession(channelId, threadTs);
    if (session) {
      session.sessionId = sessionId;
    }
  }

  /**
   * Clear session ID (e.g., after abort or error)
   * This forces a new Claude session on the next request
   */
  clearSessionId(channelId: string, threadTs: string | undefined): void {
    const session = this.getSession(channelId, threadTs);
    if (session) {
      this.logger.info('Clearing sessionId for session', {
        channelId,
        threadTs,
        previousSessionId: session.sessionId,
      });
      session.sessionId = undefined;
      // Clear error retry state so fresh session doesn't inherit exhausted budgets
      session.errorRetryCount = 0;
      session.fileAccessRetryCount = 0;
      session.lastErrorContext = undefined;
      // Cancel any pending file-access retry timer (Issue #215)
      if (session.pendingRetryTimer) {
        clearTimeout(session.pendingRetryTimer);
        session.pendingRetryTimer = undefined;
      }
      // Persist to disk so restart doesn't resurrect stale state (Issue #214)
      this.saveSessions();
    }
  }

  /**
   * Reset session context (conversation history) while preserving session metadata
   * Use this for /new and /renew commands - clears sessionId but keeps owner, workingDirectory, model, etc.
   * Also resets state to INITIALIZING to trigger re-dispatch on next message.
   * @returns true if session had active conversation and was reset, false if no session or already reset
   */
  resetSessionContext(channelId: string, threadTs: string | undefined): boolean {
    const session = this.getSession(channelId, threadTs);
    // Only return true if there was actually something to reset (had an active conversation)
    if (!session || !session.sessionId) {
      return false;
    }

    this.logger.info('Resetting session context', {
      channelId,
      threadTs,
      previousSessionId: session.sessionId,
      previousWorkflow: session.workflow,
      preservedOwner: session.ownerId,
      preservedWorkingDirectory: session.workingDirectory,
    });

    // Clear conversation-related fields
    session.sessionId = undefined;
    session.title = undefined;
    session.lastActivity = new Date();

    // Reset state to INITIALIZING to trigger re-dispatch on next message
    session.state = 'INITIALIZING';
    session.workflow = undefined;

    // Clear current initiator (fresh start means no active initiator)
    session.currentInitiatorId = undefined;
    session.currentInitiatorName = undefined;

    // Clear expiry warning state
    session.warningMessageTs = undefined;
    session.lastWarningSentAt = undefined;

    // Clear usage data to reset context percentage
    session.usage = undefined;

    // Clear in-memory debugging fields (system prompt snapshot, user instruction SSOT)
    session.systemPrompt = undefined;
    session.initialInstruction = undefined;
    session.followUpInstructions = undefined;

    // Reset activity state
    session.activityState = 'idle';

    // Clear error retry state (including file-access-specific counters)
    session.errorRetryCount = 0;
    session.fileAccessRetryCount = 0;
    session.lastErrorContext = undefined;
    // Cancel any pending file-access retry timer (Issue #215)
    if (session.pendingRetryTimer) {
      clearTimeout(session.pendingRetryTimer);
      session.pendingRetryTimer = undefined;
    }

    // Dashboard v2.1 — /new (and /renew) starts a fresh logical session.
    // Orphan-sweep any open leg into the accumulator, then reset the
    // session-level counters/timers so the new logical session starts clean.
    // Thread aggregate is derived from the (in-memory) session history, so
    // the prior session's totals remain visible at the thread level until
    // the process restarts.
    if (session.activeLegStartedAtMs) {
      const elapsed = Math.min(Date.now() - session.activeLegStartedAtMs, MAX_LEG_MS);
      session.activeAccumulatedMs = (session.activeAccumulatedMs || 0) + Math.max(0, elapsed);
      session.activeLegStartedAtMs = undefined;
    }
    session.activeAccumulatedMs = 0;
    session.activeLegStartedAtMs = undefined;
    session.compactionCount = 0;
    session.summaryTitle = undefined;
    session.summaryTitleTurnId = undefined;
    session.summaryTitleLastUpdatedAtMs = undefined;

    this.saveSessions();
    this.broadcastSessionUpdate();
    return true;
  }

  /**
   * Validate that a directory path is a safe /tmp/ path suitable for tracking.
   * Checks: absolute path under /tmp/ or /private/tmp/, no traversal, minimum depth.
   */
  private isValidSourceWorkingDirPath(dirPath: string): boolean {
    if (typeof dirPath !== 'string') return false;
    const isTmpPath = dirPath.startsWith('/tmp/') || dirPath.startsWith('/private/tmp/');
    if (!isTmpPath || dirPath.includes('..')) return false;
    const segments = dirPath.replace(/\/+$/, '').split('/').filter(Boolean);
    // /private/tmp/X has 3 segments but is same depth as /tmp/X (2 segments)
    // Require at least one dir below the tmp root to prevent top-level deletion
    const minDepth = dirPath.startsWith('/private/tmp/') ? 4 : 3;
    return segments.length >= minDepth;
  }

  /**
   * Safely remove a single directory after re-validating its path.
   * Non-blocking: logs errors but never throws. Returns true if removed.
   */
  private safeRemoveSourceDir(dir: string): boolean {
    if (!this.isValidSourceWorkingDirPath(dir)) {
      this.logger.warn('Skipping cleanup of suspicious dir path', { dir });
      return false;
    }
    try {
      if (!fs.existsSync(dir)) return true; // Already gone — treat as success
      const stat = fs.lstatSync(dir);
      if (stat.isSymbolicLink()) {
        this.logger.warn('Skipping cleanup: path is now a symlink', { dir });
        return false;
      }
      fs.rmSync(dir, { recursive: true, force: true });
      this.logger.info('Cleaned up source working dir', { dir });
      return true;
    } catch (error) {
      this.logger.error('Failed to cleanup source working dir (non-blocking)', { dir, error });
      return false;
    }
  }

  /**
   * Add a source working directory to the session for lifecycle tracking.
   * The directory must already exist on disk.
   */
  addSourceWorkingDir(channel: string, threadTs: string | undefined, dirPath: string): boolean {
    const key = this.getSessionKey(channel, threadTs);
    const session = this.sessions.get(key);
    if (!session) {
      this.logger.warn('Cannot add source working dir: session not found', { channel, threadTs, key, dirPath });
      return false;
    }

    if (!this.isValidSourceWorkingDirPath(dirPath)) {
      this.logger.warn('Rejected invalid source working dir path', { dirPath });
      return false;
    }

    if (!fs.existsSync(dirPath)) {
      this.logger.warn('Source working dir does not exist, not registering', { dirPath });
      return false;
    }

    // Resolve symlinks, then normalize /private/tmp → /tmp for consistency.
    // macOS resolves /tmp → /private/tmp via realpathSync; we normalize back.
    let resolvedPath: string;
    try {
      resolvedPath = normalizeTmpPath(fs.realpathSync(dirPath));
    } catch (error) {
      this.logger.warn('Failed to resolve real path for source working dir', { dirPath, error });
      return false;
    }
    if (!this.isValidSourceWorkingDirPath(resolvedPath)) {
      this.logger.warn('Resolved path escapes /tmp/', { dirPath, resolvedPath });
      return false;
    }

    session.sourceWorkingDirs ??= [];
    const MAX_SOURCE_WORKING_DIRS = 50;
    if (session.sourceWorkingDirs.length >= MAX_SOURCE_WORKING_DIRS) {
      this.logger.warn('sourceWorkingDirs limit reached, rejecting new dir', {
        key,
        dirPath: resolvedPath,
        count: session.sourceWorkingDirs.length,
      });
      return false;
    }
    if (!session.sourceWorkingDirs.includes(resolvedPath)) {
      session.sourceWorkingDirs.push(resolvedPath);
      this.logger.info('Source working dir added to session', { key, dirPath: resolvedPath });
      this.saveSessions();
    }
    return true;
  }

  /**
   * Remove and delete all source working directories for a session.
   * Updates the session's sourceWorkingDirs to only contain dirs that failed removal.
   * Non-blocking: logs errors but never throws.
   */
  private cleanupSourceWorkingDirs(session: ConversationSession): void {
    if (!session.sourceWorkingDirs?.length) return;
    const failed = session.sourceWorkingDirs.filter((dir) => !this.safeRemoveSourceDir(dir));
    session.sourceWorkingDirs = failed;
    if (failed.length > 0) {
      this.logger.warn('Some source working dirs could not be cleaned up', { count: failed.length, dirs: failed });
    }
  }

  /**
   * Terminate a session by its key
   */
  terminateSession(sessionKey: string): boolean {
    const session = this.sessions.get(sessionKey);
    if (!session) {
      return false;
    }

    // Ghost Session Fix #99: set terminated flag BEFORE deleting from Map.
    // In-flight code holding a reference to this session object will see the flag
    // and self-terminate, even though the Map entry is gone.
    session.terminated = true;

    // Metrics: emit session_closed event before deletion (fire-and-forget)
    getMetricsEmitter()
      .emitSessionClosed(session, sessionKey)
      .catch((err) => this.logger.debug('metrics emit failed', err));

    // Archive session metadata to disk before deletion (#401)
    getArchiveStore().archive(session, sessionKey, 'terminated');

    this.cleanupSourceWorkingDirs(session);
    this.clearOnIdleCallbacks(sessionKey); // Clean up any pending cron callbacks
    this.sessions.delete(sessionKey);
    this.logger.info('Session terminated', { sessionKey, ownerId: session.ownerId });

    this.saveSessions();
    return true;
  }

  /** Mark a session as trashed (hidden from dashboard but kept in conversation list) */
  trashSession(sessionKey: string): boolean {
    const session = this.sessions.get(sessionKey);
    if (!session) return false;
    session.trashed = true;
    this.logger.info('Session trashed', { sessionKey, ownerId: session.ownerId });
    this.saveSessions();
    return true;
  }

  /**
   * Clean up inactive sessions based on max age
   * 3-stage lifecycle: Active → Sleep (24h) → Delete (7d sleep)
   */
  async cleanupInactiveSessions(maxAge: number = DEFAULT_SESSION_TIMEOUT): Promise<void> {
    const now = Date.now();
    let cleaned = 0;
    let slept = 0;

    for (const [key, session] of this.sessions.entries()) {
      // Stage 1: SLEEPING sessions - check if sleep duration exceeded (7 days)
      if (session.state === 'SLEEPING') {
        const sleepAge = session.sleepStartedAt ? now - session.sleepStartedAt.getTime() : MAX_SLEEP_DURATION + 1; // Force expire if no sleepStartedAt

        if (sleepAge >= MAX_SLEEP_DURATION) {
          if (this.expiryCallbacks) {
            try {
              await this.expiryCallbacks.onExpiry(session);
            } catch (error) {
              this.logger.error('Failed to send sleep expiry message', error);
            }
          }
          // Archive session metadata to disk before deletion (#401)
          getArchiveStore().archive(session, key, 'sleep_expired');

          this.cleanupSourceWorkingDirs(session);
          this.clearOnIdleCallbacks(key); // Clean up any pending cron callbacks
          this.sessions.delete(key);
          cleaned++;
        }
        // Sleeping sessions don't get warnings
        continue;
      }

      // Stage 2: Active sessions - check if inactive for 24h → transition to Sleep
      const sessionAge = now - session.lastActivity.getTime();
      const timeUntilExpiry = maxAge - sessionAge;

      if (timeUntilExpiry <= 0) {
        // Transition to sleep instead of deleting
        session.state = 'SLEEPING';
        session.sleepStartedAt = new Date();
        session.warningMessageTs = undefined;
        session.lastWarningSentAt = undefined;
        this.cleanupSourceWorkingDirs(session);
        slept++;

        if (this.expiryCallbacks) {
          try {
            await this.expiryCallbacks.onSleep(session);
          } catch (error) {
            this.logger.error('Failed to send session sleep message', error);
          }
        }
        continue;
      }

      // Stage 3: Active sessions with time remaining - check for warnings
      if (this.expiryCallbacks) {
        await this.checkAndSendWarning(key, session, timeUntilExpiry);
      }
    }

    if (cleaned > 0 || slept > 0) {
      this.logger.info(`Session cleanup: ${slept} put to sleep, ${cleaned} expired`);
    }

    if (cleaned > 0 || slept > 0) {
      this.saveSessions();
    }
  }

  /**
   * Check and send expiry warning if needed
   */
  private async checkAndSendWarning(
    sessionKey: string,
    session: ConversationSession,
    timeUntilExpiry: number,
  ): Promise<void> {
    for (const warningInterval of WARNING_INTERVALS) {
      if (timeUntilExpiry <= warningInterval) {
        const lastWarningSent = session.lastWarningSentAt || Infinity;

        // Only send if this is a new/more urgent warning
        if (warningInterval < lastWarningSent) {
          try {
            const newMessageTs = await this.expiryCallbacks!.onWarning(
              session,
              timeUntilExpiry,
              session.warningMessageTs,
            );

            // Update session with warning info
            session.lastWarningSentAt = warningInterval;
            if (newMessageTs) {
              session.warningMessageTs = newMessageTs;
            }

            this.logger.debug('Sent session expiry warning', {
              sessionKey,
              timeRemaining: timeUntilExpiry,
              warningInterval,
            });
          } catch (error) {
            this.logger.error('Failed to send session warning', error);
          }
          break; // Sent warning — stop checking less urgent intervals
        }
        // Not sent (already sent this level) — continue to check more urgent intervals
      }
    }
  }

  /**
   * Sessions that were actively processing when the process crashed.
   * Populated during loadSessions(), cleared after notification.
   */
  getCrashRecoveredSessions(): CrashRecoveredSession[] {
    return this._crashRecoveredSessions;
  }

  clearCrashRecoveredSessions(): void {
    this._crashRecoveredSessions = [];
  }

  /**
   * Save all sessions to file for persistence across restarts
   */
  saveSessions(): void {
    try {
      // Ensure data directory exists
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }

      const sessionsArray: SerializedSession[] = [];
      for (const [key, session] of this.sessions.entries()) {
        // Only save sessions with sessionId (meaning they have conversation history)
        if (session.sessionId) {
          this.ensureSessionLinkState(session);
          sessionsArray.push({
            key,
            ownerId: session.ownerId,
            ownerName: session.ownerName,
            userId: session.userId, // Legacy field
            channelId: session.channelId,
            threadTs: session.threadTs,
            sessionId: session.sessionId,
            isActive: session.isActive,
            lastActivity: session.lastActivity.toISOString(),
            workingDirectory: session.workingDirectory,
            title: session.title,
            model: session.model,
            state: session.state,
            workflow: session.workflow,
            links: session.links,
            linkHistory: session.linkHistory,
            linkSequence: session.linkSequence,
            sleepStartedAt: session.sleepStartedAt?.toISOString(),
            activityState: session.activityState,
            logVerbosity: session.logVerbosity,
            effort: session.effort,
            thinkingEnabled: session.thinkingEnabled,
            showThinking: session.showThinking,
            actionPanel: session.actionPanel ? { ...session.actionPanel } : undefined,
            threadModel: session.threadModel,
            threadRootTs: session.threadRootTs,
            isOnboarding: session.isOnboarding,
            sourceWorkingDirs: session.sourceWorkingDirs,
            sourceThread: session.sourceThread,
            // Session workspace isolation (#77): persist session-unique cwd
            // so Claude SDK can find its conversation files after restart
            sessionWorkingDir: session.sessionWorkingDir,
            // Conversation record ID
            conversationId: session.conversationId,
            // Merge code change stats
            mergeStats: session.mergeStats,
            // User SSOT instructions (persisted)
            instructions: session.instructions,
            // Dashboard v2.1 — derive-first aggregate snapshot (persisted per session)
            compactionCount: session.compactionCount,
            activeLegStartedAtMs: session.activeLegStartedAtMs,
            activeAccumulatedMs: session.activeAccumulatedMs,
            summaryTitle: session.summaryTitle,
            summaryTitleTurnId: session.summaryTitleTurnId,
            summaryTitleLastUpdatedAtMs: session.summaryTitleLastUpdatedAtMs,
          });
        }
      }

      fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessionsArray, null, 2));
      this.logger.info(`Saved ${sessionsArray.length} sessions to file`);
    } catch (error) {
      this.logger.error('Failed to save sessions', error);
    }
  }

  /**
   * Archive a serialized session during loadSessions() when it's being discarded (#401).
   * Creates a minimal ConversationSession from serialized data to pass to the archive store.
   */
  private archiveSerializedOnLoad(
    serialized: SerializedSession,
    lastActivity: Date,
    reason: 'terminated' | 'sleep_expired',
  ): void {
    try {
      // Skip if already archived (prevents duplicates on repeated restarts)
      if (getArchiveStore().exists(serialized.key)) return;

      const session: ConversationSession = {
        ownerId: serialized.ownerId || serialized.userId,
        ownerName: serialized.ownerName,
        userId: serialized.userId,
        channelId: serialized.channelId,
        threadTs: serialized.threadTs,
        sessionId: serialized.sessionId,
        isActive: false,
        lastActivity,
        title: serialized.title,
        model: serialized.model,
        state: serialized.state || 'MAIN',
        workflow: serialized.workflow || 'default',
        links: serialized.links,
        linkHistory: serialized.linkHistory,
        conversationId: serialized.conversationId,
        mergeStats: serialized.mergeStats,
        instructions: serialized.instructions,
        activityState: serialized.activityState || 'idle',
      };
      getArchiveStore().archive(session, serialized.key, reason);
    } catch (err) {
      this.logger.debug('Failed to archive session during load', { key: serialized.key, error: err });
    }
  }

  /**
   * Load sessions from file after restart
   */
  loadSessions(): number {
    try {
      if (!fs.existsSync(SESSIONS_FILE)) {
        this.logger.debug('No sessions file found');
        return 0;
      }

      const data = fs.readFileSync(SESSIONS_FILE, 'utf-8');
      const sessionsArray: SerializedSession[] = JSON.parse(data);

      let loaded = 0;
      const now = Date.now();
      const maxAge = DEFAULT_SESSION_TIMEOUT;
      this._crashRecoveredSessions = [];

      for (const serialized of sessionsArray) {
        const lastActivity = new Date(serialized.lastActivity);
        const sleepStartedAt = serialized.sleepStartedAt ? new Date(serialized.sleepStartedAt) : undefined;

        // For SLEEPING sessions: check against MAX_SLEEP_DURATION
        if (serialized.state === 'SLEEPING') {
          const sleepAge = sleepStartedAt ? now - sleepStartedAt.getTime() : MAX_SLEEP_DURATION + 1;
          if (sleepAge >= MAX_SLEEP_DURATION) {
            // Archive expired session before discarding (#401)
            this.archiveSerializedOnLoad(serialized, lastActivity, 'sleep_expired');
            serialized.sourceWorkingDirs?.forEach((dir) => this.safeRemoveSourceDir(dir));
            continue;
          }
        } else {
          // For active sessions: check against 24h timeout
          const sessionAge = now - lastActivity.getTime();
          if (sessionAge >= maxAge) {
            // Archive expired session before discarding (#401)
            this.archiveSerializedOnLoad(serialized, lastActivity, 'terminated');
            serialized.sourceWorkingDirs?.forEach((dir) => this.safeRemoveSourceDir(dir));
            continue;
          }
        }

        const resolvedOwnerId = serialized.ownerId || serialized.userId;
        const session: ConversationSession = {
          ownerId: resolvedOwnerId, // Fallback for legacy sessions
          ownerName: serialized.ownerName,
          userId: serialized.userId, // Legacy field
          channelId: serialized.channelId,
          threadTs: serialized.threadTs,
          sessionId: serialized.sessionId,
          isActive: serialized.isActive,
          lastActivity,
          workingDirectory: serialized.workingDirectory,
          title: serialized.title,
          model: serialized.model,
          state: serialized.state || 'MAIN', // Default to MAIN for legacy sessions
          workflow: serialized.workflow || 'default', // Default to 'default' for legacy sessions
          links: serialized.links,
          linkHistory: serialized.linkHistory,
          linkSequence: serialized.linkSequence,
          sleepStartedAt,
          activityState: serialized.activityState || 'idle', // Preserve saved state for correct dashboard display; crash recovery handles auto-resume
          logVerbosity: serialized.logVerbosity,
          // Backfill effort on legacy sessions so resume uses DEFAULT_EFFORT
          // rather than the SDK default.
          effort: serialized.effort ?? userSettingsStore.getUserDefaultEffort(resolvedOwnerId),
          thinkingEnabled: serialized.thinkingEnabled,
          showThinking: serialized.showThinking,
          // Clear stale messageTs/renderKey on restore — the Slack message may have been
          // deleted while the service was down, causing endless `message_not_found` errors
          // when ThreadSurface tries to chat.update a ghost message.
          actionPanel: serialized.actionPanel
            ? {
                ...serialized.actionPanel,
                messageTs: undefined,
                renderKey: undefined,
                lastRenderedAt: undefined,
              }
            : undefined,
          threadModel: serialized.threadModel,
          threadRootTs: serialized.threadRootTs,
          isOnboarding: serialized.isOnboarding,
          sourceThread: serialized.sourceThread,
          sourceWorkingDirs: (serialized.sourceWorkingDirs || []).filter((d: unknown) => {
            if (typeof d !== 'string') {
              this.logger.warn('Dropped non-string sourceWorkingDir during deserialization', {
                dir: d,
                key: serialized.key,
              });
              return false;
            }
            const valid = this.isValidSourceWorkingDirPath(d);
            if (!valid)
              this.logger.warn('Dropped invalid sourceWorkingDir during deserialization', {
                dir: d,
                key: serialized.key,
              });
            return valid;
          }),
          // Session workspace isolation (#77): restore session-unique cwd
          // so Claude SDK resumes in the same project dir where conversations are stored
          sessionWorkingDir:
            serialized.sessionWorkingDir && this.isValidSourceWorkingDirPath(serialized.sessionWorkingDir)
              ? serialized.sessionWorkingDir
              : undefined,
          // Conversation record ID
          conversationId: serialized.conversationId,
          // Merge code change stats
          mergeStats: serialized.mergeStats,
          // User SSOT instructions (restored from disk)
          instructions: Array.isArray(serialized.instructions) ? serialized.instructions : [],
          // Dashboard v2.1 — restore aggregate snapshot
          compactionCount: typeof serialized.compactionCount === 'number' ? serialized.compactionCount : 0,
          activeLegStartedAtMs: serialized.activeLegStartedAtMs,
          activeAccumulatedMs: typeof serialized.activeAccumulatedMs === 'number' ? serialized.activeAccumulatedMs : 0,
          summaryTitle: serialized.summaryTitle,
          summaryTitleTurnId: serialized.summaryTitleTurnId,
          summaryTitleLastUpdatedAtMs: serialized.summaryTitleLastUpdatedAtMs,
          // Compaction Tracking (#617): runtime-only dedupe state — always reset on reload.
          // Pending state (autoCompactPending / pendingUserText / pendingEventContext) is
          // intentionally NOT rehydrated because the original event context cannot be
          // reconstructed across a restart, and the user can simply retype the message.
          compactEpoch: 0,
          compactPostedByEpoch: {},
          compactionRehydratedByEpoch: {},
          preCompactUsagePct: null,
          lastKnownUsagePct: null,
          autoCompactPending: false,
          pendingUserText: null,
          pendingEventContext: null,
        };
        // Orphan sweep: if process crashed while a turn was active, fold the elapsed
        // leg (capped by MAX_LEG_MS) into the accumulator and clear the marker so
        // the next beginTurn starts a fresh leg.
        if (session.activeLegStartedAtMs) {
          const elapsed = Math.min(Date.now() - session.activeLegStartedAtMs, MAX_LEG_MS);
          session.activeAccumulatedMs = (session.activeAccumulatedMs || 0) + Math.max(0, elapsed);
          session.activeLegStartedAtMs = undefined;
        }
        this.ensureSessionLinkState(session);
        this.sessions.set(serialized.key, session);
        loaded++;

        // Track sessions that were active when process crashed
        if (serialized.activityState && serialized.activityState !== 'idle') {
          this._crashRecoveredSessions.push({
            channelId: serialized.channelId,
            threadTs: serialized.threadTs,
            ownerId: serialized.ownerId || serialized.userId,
            ownerName: serialized.ownerName,
            activityState: serialized.activityState,
            sessionKey: serialized.key,
            title: serialized.title,
            workflow: serialized.workflow,
          });
        }
      }

      this.logger.info(`Loaded ${loaded} sessions from file (${sessionsArray.length - loaded} expired)`);

      return loaded;
    } catch (error) {
      this.logger.error('Failed to load sessions', error);
      return 0;
    }
  }

  /**
   * Backfill conversationId for restored sessions that lost it.
   * Builds an index from conversation storage files, then matches by channelId:threadTs
   * and sourceThread (for bot-migrated sessions). Call once at startup after loadSessions().
   */
  async backfillConversationIds(): Promise<number> {
    const { ConversationStorage } = await import('./conversation/storage');
    const storage = new ConversationStorage();
    const threadIndex = await storage.buildThreadIndex();
    let count = 0;
    for (const [, session] of this.sessions) {
      if (session.conversationId) continue;
      // Try 1: exact channelId:threadTs match
      if (session.channelId && session.threadTs) {
        const exactKey = `${session.channelId}:${session.threadTs}`;
        const convId = threadIndex.get(exactKey);
        if (convId) {
          session.conversationId = convId;
          count++;
          continue;
        }
      }
      // Try 2: sourceThread match (bot-migrated sessions)
      if (session.sourceThread) {
        const sourceKey = `${session.sourceThread.channel}:${session.sourceThread.threadTs}`;
        const sourceConvId = threadIndex.get(sourceKey);
        if (sourceConvId) {
          session.conversationId = sourceConvId;
          count++;
        }
      }
    }
    if (count > 0) {
      this.saveSessions();
      this.logger.info(`Backfilled ${count} session conversationIds`);
    }
    return count;
  }
}
