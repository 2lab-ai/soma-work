/**
 * SessionController — Session lifecycle orchestration (Issue #410)
 *
 * Replaces ClaudeHandler's ~40 SessionRegistry proxy methods
 * with a focused controller that owns session lifecycle:
 * - Create / get / terminate sessions
 * - State transitions (INITIALIZING → MAIN → SLEEPING)
 * - Activity state tracking (working / waiting / idle)
 * - Session persistence (save / load)
 *
 * This is a thin facade over SessionRegistry that provides
 * a cleaner API surface for the Controller pipeline (Phase 4).
 */

import { Logger } from '../logger.js';
import type {
  ActivityState,
  ConversationSession,
  SessionLink,
  SessionLinks,
  SessionResourceSnapshot,
  SessionResourceUpdateRequest,
  SessionResourceUpdateResult,
  WorkflowType,
} from '../types.js';

// ─── Types ───────────────────────────────────────────────────────

/**
 * Minimal SessionRegistry interface.
 * Only the methods that SessionController needs to delegate to.
 */
export interface SessionRegistryLike {
  getSessionKey(channelId: string, threadTs?: string): string;
  getSessionKeyWithUser(userId: string, channelId: string, threadTs?: string): string;
  getSession(channelId: string, threadTs?: string): ConversationSession | undefined;
  getSessionWithUser(userId: string, channelId: string, threadTs?: string): ConversationSession | undefined;
  getSessionByKey(sessionKey: string): ConversationSession | undefined;
  findSessionBySourceThread(channel: string, threadTs: string): ConversationSession | undefined;
  getAllSessions(): Map<string, ConversationSession>;
  createSession(
    ownerId: string,
    ownerName: string,
    channelId: string,
    threadTs?: string,
    model?: string,
  ): ConversationSession;
  setSessionTitle(channelId: string, threadTs: string | undefined, title: string): void;
  updateSessionTitle(channelId: string, threadTs: string | undefined, title: string): void;
  terminateSession(sessionKey: string): boolean;
  clearSessionId(channelId: string, threadTs: string | undefined): void;
  resetSessionContext(channelId: string, threadTs: string | undefined): boolean;
  transitionToMain(channelId: string, threadTs: string | undefined, workflow: WorkflowType, title?: string): void;
  needsDispatch(channelId: string, threadTs?: string): boolean;
  isSleeping(channelId: string, threadTs?: string): boolean;
  wakeFromSleep(channelId: string, threadTs?: string): boolean;
  transitionToSleep(channelId: string, threadTs?: string): boolean;
  getSessionWorkflow(channelId: string, threadTs?: string): WorkflowType | undefined;
  setActivityState(channelId: string, threadTs: string | undefined, state: ActivityState): void;
  setActivityStateByKey(sessionKey: string, state: ActivityState): void;
  getActivityState(channelId: string, threadTs?: string): ActivityState | undefined;
  cleanupInactiveSessions(maxAge?: number): Promise<void>;
  saveSessions(): void;
  loadSessions(): number;
  refreshSessionActivityByKey(sessionKey: string): boolean;
  setSessionLink(channelId: string, threadTs: string | undefined, link: SessionLink): void;
  setSessionLinks(channelId: string, threadTs: string | undefined, links: SessionLinks): void;
  getSessionLinks(channelId: string, threadTs?: string): SessionLinks | undefined;
  addSourceWorkingDir(channelId: string, threadTs: string | undefined, dirPath: string): boolean;
  getSessionResourceSnapshot(channelId: string, threadTs?: string): SessionResourceSnapshot;
  updateSessionResources(
    channelId: string,
    threadTs: string | undefined,
    request: SessionResourceUpdateRequest,
  ): SessionResourceUpdateResult;
  addMergeStats?(
    channelId: string,
    threadTs: string | undefined,
    stats: { linesAdded: number; linesDeleted: number },
  ): void;
  setBotThread?(channelId: string, threadTs: string | undefined, rootTs: string): void;
  updateInitiator?(channelId: string, threadTs: string | undefined, initiatorId: string, initiatorName: string): void;
  canInterrupt?(channelId: string, threadTs: string | undefined, userId: string): boolean;
}

// ─── Implementation ─────────────────────────────────────────────

export class SessionController {
  private logger = new Logger('SessionController');

  constructor(private registry: SessionRegistryLike) {}

  /** Get the underlying registry for legacy code compatibility. */
  getRegistry(): SessionRegistryLike {
    return this.registry;
  }

  // ─── Session Lookup ────────────────────────────────────────

  getSessionKey(channelId: string, threadTs?: string): string {
    return this.registry.getSessionKey(channelId, threadTs);
  }

  getSession(channelId: string, threadTs?: string): ConversationSession | undefined {
    return this.registry.getSession(channelId, threadTs);
  }

  getSessionByKey(key: string): ConversationSession | undefined {
    return this.registry.getSessionByKey(key);
  }

  getAllSessions(): Map<string, ConversationSession> {
    return this.registry.getAllSessions();
  }

  // ─── Session Lifecycle ─────────────────────────────────────

  createSession(
    ownerId: string,
    ownerName: string,
    channelId: string,
    threadTs?: string,
    model?: string,
  ): ConversationSession {
    this.logger.info('Creating session', { ownerId, channelId, threadTs });
    return this.registry.createSession(ownerId, ownerName, channelId, threadTs, model);
  }

  terminateSession(sessionKey: string): boolean {
    this.logger.info('Terminating session', { sessionKey });
    return this.registry.terminateSession(sessionKey);
  }

  resetSessionContext(channelId: string, threadTs?: string): boolean {
    return this.registry.resetSessionContext(channelId, threadTs);
  }

  // ─── State Transitions ────────────────────────────────────

  transitionToMain(channelId: string, threadTs: string | undefined, workflow: WorkflowType, title?: string): void {
    this.registry.transitionToMain(channelId, threadTs, workflow, title);
  }

  transitionToSleep(channelId: string, threadTs?: string): boolean {
    return this.registry.transitionToSleep(channelId, threadTs);
  }

  wakeFromSleep(channelId: string, threadTs?: string): boolean {
    return this.registry.wakeFromSleep(channelId, threadTs);
  }

  needsDispatch(channelId: string, threadTs?: string): boolean {
    return this.registry.needsDispatch(channelId, threadTs);
  }

  // ─── Activity State ────────────────────────────────────────

  setActivityState(channelId: string, threadTs: string | undefined, state: ActivityState): void {
    this.registry.setActivityState(channelId, threadTs, state);
  }

  setActivityStateByKey(sessionKey: string, state: ActivityState): void {
    this.registry.setActivityStateByKey(sessionKey, state);
  }

  getActivityState(channelId: string, threadTs?: string): ActivityState | undefined {
    return this.registry.getActivityState(channelId, threadTs);
  }

  // ─── Session Metadata ─────────────────────────────────────

  setSessionTitle(channelId: string, threadTs: string | undefined, title: string): void {
    this.registry.setSessionTitle(channelId, threadTs, title);
  }

  setSessionLink(channelId: string, threadTs: string | undefined, link: SessionLink): void {
    this.registry.setSessionLink(channelId, threadTs, link);
  }

  getSessionLinks(channelId: string, threadTs?: string): SessionLinks | undefined {
    return this.registry.getSessionLinks(channelId, threadTs);
  }

  // ─── Persistence ──────────────────────────────────────────

  saveSessions(): void {
    this.registry.saveSessions();
  }

  loadSessions(): number {
    return this.registry.loadSessions();
  }

  async cleanupInactiveSessions(maxAge?: number): Promise<void> {
    await this.registry.cleanupInactiveSessions(maxAge);
  }
}
