/**
 * MetricsEventEmitter — Emits metrics events for session lifecycle, turns, and GitHub operations.
 * Trace: docs/daily-weekly-report/trace.md, Scenarios 2 & 3
 */

import { randomUUID } from 'crypto';
import { Logger } from '../logger';
import { MetricsEventStore } from './event-store';
import type { MetricsEvent, MetricsEventType } from './types';

const logger = new Logger('MetricsEventEmitter');

// Minimal session interface to avoid circular dependency on full ConversationSession
interface SessionLike {
  ownerId: string;
  ownerName?: string;
  channelId: string;
  threadTs?: string;
  workflow?: string;
}

function sessionKeyFrom(session: SessionLike): string {
  return `${session.channelId}-${session.threadTs || 'direct'}`;
}

export class MetricsEventEmitter {
  private store: MetricsEventStore;

  constructor(store: MetricsEventStore) {
    this.store = store;
  }

  /**
   * Build a MetricsEvent from parts.
   */
  private buildEvent(
    eventType: MetricsEventType,
    userId: string,
    userName: string,
    sessionKey?: string,
    metadata?: Record<string, unknown>,
  ): MetricsEvent {
    return {
      id: randomUUID(),
      timestamp: Date.now(),
      eventType,
      userId: userId || 'unknown',
      userName: userName || 'unknown',
      sessionKey,
      metadata,
    };
  }

  /**
   * Emit and append. Fire-and-forget: errors are caught and logged.
   */
  private async emit(event: MetricsEvent): Promise<void> {
    try {
      await this.store.append(event);
      logger.debug(`Emitted ${event.eventType} for user ${event.userName}`);
    } catch (error) {
      // Fire-and-forget: must never block caller
      logger.error(`Failed to emit ${event.eventType}`, error);
    }
  }

  // === Session Lifecycle (Scenario 2) ===

  async emitSessionCreated(session: SessionLike): Promise<void> {
    const event = this.buildEvent(
      'session_created',
      session.ownerId,
      session.ownerName || 'unknown',
      sessionKeyFrom(session),
      { channelId: session.channelId, threadTs: session.threadTs, workflow: session.workflow || 'default' },
    );
    await this.emit(event);
  }

  async emitSessionSlept(session: SessionLike): Promise<void> {
    const event = this.buildEvent(
      'session_slept',
      session.ownerId,
      session.ownerName || 'unknown',
      sessionKeyFrom(session),
      { channelId: session.channelId },
    );
    await this.emit(event);
  }

  async emitSessionClosed(session: SessionLike, sessionKey: string): Promise<void> {
    const event = this.buildEvent('session_closed', session.ownerId, session.ownerName || 'unknown', sessionKey, {
      channelId: session.channelId,
    });
    await this.emit(event);
  }

  // === Turn Tracking (Scenario 3) ===

  async emitTurnUsed(
    conversationId: string,
    userId: string | undefined,
    userName: string | undefined,
    role: 'user' | 'assistant',
  ): Promise<void> {
    const event = this.buildEvent('turn_used', userId || 'unknown', userName || 'unknown', undefined, {
      conversationId,
      role,
    });
    await this.emit(event);
  }

  // === GitHub Events (Scenario 3) ===

  async emitGitHubEvent(
    eventType:
      | 'issue_created'
      | 'pr_created'
      | 'pr_merged'
      | 'commit_created'
      | 'code_lines_added'
      | 'merge_lines_added',
    userId: string,
    userName: string,
    sessionKey: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const event = this.buildEvent(eventType, userId, userName, sessionKey, metadata);
    await this.emit(event);
  }
}

// === Singleton instance ===

let _instance: MetricsEventEmitter | null = null;

export function getMetricsEmitter(): MetricsEventEmitter {
  if (!_instance) {
    _instance = new MetricsEventEmitter(new MetricsEventStore());
  }
  return _instance;
}

export function initMetricsEmitter(store: MetricsEventStore): MetricsEventEmitter {
  _instance = new MetricsEventEmitter(store);
  return _instance;
}
