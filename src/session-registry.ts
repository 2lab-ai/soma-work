/**
 * SessionRegistry - Manages conversation sessions and persistence
 * Extracted from claude-handler.ts (Phase 5.1)
 */

import { ConversationSession, SessionState, SessionLinks, SessionLink, WorkflowType, ActivityState } from './types';
import { Logger } from './logger';
import { userSettingsStore } from './user-settings-store';
import { DATA_DIR } from './env-paths';
import * as path from 'path';
import * as fs from 'fs';
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

// Default session timeout: 24 hours (Active → Sleep)
const DEFAULT_SESSION_TIMEOUT = 24 * 60 * 60 * 1000;

// Maximum sleep duration: 7 days (Sleep → Delete)
const MAX_SLEEP_DURATION = 7 * 24 * 60 * 60 * 1000;

// Session expiry warning intervals in milliseconds (from session expiry time)
// Sorted descending: most urgent first
const WARNING_INTERVALS = [
  12 * 60 * 60 * 1000, // 12 hours remaining - idle check (ask if session is done)
  10 * 60 * 1000,      // 10 minutes remaining - final warning
];

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
  // Sleep mode
  sleepStartedAt?: string; // ISO date string
  // Activity state
  activityState?: ActivityState;
  // Onboarding flag
  isOnboarding?: boolean;
}

/**
 * Callbacks for session expiry events
 */
export interface SessionExpiryCallbacks {
  onWarning: (
    session: ConversationSession,
    timeRemaining: number,
    warningMessageTs?: string
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
export class SessionRegistry {
  private sessions: Map<string, ConversationSession> = new Map();
  private logger = new Logger('SessionRegistry');
  private expiryCallbacks?: SessionExpiryCallbacks;

  /**
   * Set callbacks for session expiry events
   */
  setExpiryCallbacks(callbacks: SessionExpiryCallbacks): void {
    this.expiryCallbacks = callbacks;
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
  getSessionWithUser(
    userId: string,
    channelId: string,
    threadTs?: string
  ): ConversationSession | undefined {
    return this.getSession(channelId, threadTs);
  }

  /**
   * Get a session by its key directly
   */
  getSessionByKey(sessionKey: string): ConversationSession | undefined {
    return this.sessions.get(sessionKey);
  }

  /**
   * Get all active sessions
   */
  getAllSessions(): Map<string, ConversationSession> {
    return this.sessions;
  }

  /**
   * Create a new session
   */
  createSession(
    ownerId: string,
    ownerName: string,
    channelId: string,
    threadTs?: string,
    model?: string
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
      state: 'INITIALIZING', // Start in INITIALIZING state
      activityState: 'idle',
    };

    this.sessions.set(this.getSessionKey(channelId, threadTs), session);
    return session;
  }

  /**
   * Transition session from INITIALIZING to MAIN state
   * Sets the workflow type determined by dispatch
   * @returns true if transition succeeded, false if session not found or already transitioned
   */
  transitionToMain(
    channelId: string,
    threadTs: string | undefined,
    workflow: WorkflowType,
    title?: string
  ): boolean {
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

    // Only persist on idle transition to minimize disk I/O
    if (state === 'idle') {
      this.saveSessions();
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

    if (state === 'idle') {
      this.saveSessions();
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
   * Set session title (typically auto-generated from first Q&A)
   */
  setSessionTitle(channelId: string, threadTs: string | undefined, title: string): void {
    const session = this.getSession(channelId, threadTs);
    if (session && !session.title) {
      session.title = title;
      this.saveSessions();
    }
  }

  /**
   * Set a link on a session (issue, pr, or doc)
   */
  setSessionLink(
    channelId: string,
    threadTs: string | undefined,
    link: SessionLink
  ): void {
    const session = this.getSession(channelId, threadTs);
    if (session) {
      if (!session.links) {
        session.links = {};
      }
      session.links[link.type] = link;
      this.saveSessions();
    }
  }

  /**
   * Set multiple session links at once
   */
  setSessionLinks(
    channelId: string,
    threadTs: string | undefined,
    links: SessionLinks
  ): void {
    const session = this.getSession(channelId, threadTs);
    if (session) {
      session.links = { ...session.links, ...links };
      this.saveSessions();
    }
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
    return session?.links;
  }

  /**
   * Update the current initiator of a session
   */
  updateInitiator(
    channelId: string,
    threadTs: string | undefined,
    initiatorId: string,
    initiatorName: string
  ): void {
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

    // Reset activity state
    session.activityState = 'idle';

    this.saveSessions();
    return true;
  }

  /**
   * Terminate a session by its key
   */
  terminateSession(sessionKey: string): boolean {
    const session = this.sessions.get(sessionKey);
    if (!session) {
      return false;
    }

    this.sessions.delete(sessionKey);
    this.logger.info('Session terminated', { sessionKey, ownerId: session.ownerId });

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
        const sleepAge = session.sleepStartedAt
          ? now - session.sleepStartedAt.getTime()
          : MAX_SLEEP_DURATION + 1; // Force expire if no sleepStartedAt

        if (sleepAge >= MAX_SLEEP_DURATION) {
          if (this.expiryCallbacks) {
            try {
              await this.expiryCallbacks.onExpiry(session);
            } catch (error) {
              this.logger.error('Failed to send sleep expiry message', error);
            }
          }
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
    timeUntilExpiry: number
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
              session.warningMessageTs
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
            sleepStartedAt: session.sleepStartedAt?.toISOString(),
            activityState: session.activityState,
            isOnboarding: session.isOnboarding,
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

      for (const serialized of sessionsArray) {
        const lastActivity = new Date(serialized.lastActivity);
        const sleepStartedAt = serialized.sleepStartedAt ? new Date(serialized.sleepStartedAt) : undefined;

        // For SLEEPING sessions: check against MAX_SLEEP_DURATION
        if (serialized.state === 'SLEEPING') {
          const sleepAge = sleepStartedAt
            ? now - sleepStartedAt.getTime()
            : MAX_SLEEP_DURATION + 1;
          if (sleepAge >= MAX_SLEEP_DURATION) continue; // Expired sleep session
        } else {
          // For active sessions: check against 24h timeout
          const sessionAge = now - lastActivity.getTime();
          if (sessionAge >= maxAge) continue;
        }

        const session: ConversationSession = {
          ownerId: serialized.ownerId || serialized.userId, // Fallback for legacy sessions
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
          sleepStartedAt,
          activityState: 'idle', // Always idle on restore (no active streams after restart)
          isOnboarding: serialized.isOnboarding,
        };
        this.sessions.set(serialized.key, session);
        loaded++;
      }

      this.logger.info(
        `Loaded ${loaded} sessions from file (${sessionsArray.length - loaded} expired)`
      );

      return loaded;
    } catch (error) {
      this.logger.error('Failed to load sessions', error);
      return 0;
    }
  }
}
