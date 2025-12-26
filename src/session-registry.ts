/**
 * SessionRegistry - Manages conversation sessions and persistence
 * Extracted from claude-handler.ts (Phase 5.1)
 */

import { ConversationSession } from './types';
import { Logger } from './logger';
import { userSettingsStore } from './user-settings-store';
import * as path from 'path';
import * as fs from 'fs';

// Session persistence file path
const DATA_DIR = path.join(process.cwd(), 'data');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

// Default session timeout: 24 hours
const DEFAULT_SESSION_TIMEOUT = 24 * 60 * 60 * 1000;

// Session expiry warning intervals in milliseconds (from session expiry time)
const WARNING_INTERVALS = [
  10 * 60 * 1000, // 10 minutes
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
    };

    this.sessions.set(this.getSessionKey(channelId, threadTs), session);
    return session;
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
    if (!session) {
      return true; // No session, so anyone can start
    }
    // Owner can always interrupt
    if (session.ownerId === userId) {
      return true;
    }
    // Current initiator can interrupt
    if (session.currentInitiatorId === userId) {
      return true;
    }
    return false;
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
   */
  async cleanupInactiveSessions(maxAge: number = DEFAULT_SESSION_TIMEOUT): Promise<void> {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, session] of this.sessions.entries()) {
      const sessionAge = now - session.lastActivity.getTime();
      const timeUntilExpiry = maxAge - sessionAge;

      // Check if session should be expired
      if (timeUntilExpiry <= 0) {
        // Send expiry message before cleaning up
        if (this.expiryCallbacks) {
          try {
            await this.expiryCallbacks.onExpiry(session);
          } catch (error) {
            this.logger.error('Failed to send session expiry message', error);
          }
        }
        this.sessions.delete(key);
        cleaned++;
        continue;
      }

      // Check if we should send a warning
      if (this.expiryCallbacks) {
        await this.checkAndSendWarning(key, session, timeUntilExpiry);
      }
    }

    if (cleaned > 0) {
      this.logger.info(`Cleaned up ${cleaned} inactive sessions`);
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
        }
        break; // Only send the most urgent applicable warning
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
        const sessionAge = now - lastActivity.getTime();

        // Only restore sessions that haven't expired
        if (sessionAge < maxAge) {
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
          };
          this.sessions.set(serialized.key, session);
          loaded++;
        }
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
