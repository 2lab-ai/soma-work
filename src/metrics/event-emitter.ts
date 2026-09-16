/**
 * MetricsEventEmitter — Emits metrics events for session lifecycle, turns, and GitHub operations.
 * Trace: docs/archive/features/daily-weekly-report/trace.md, Scenarios 2 & 3
 */

import { randomUUID } from 'crypto';
import { Logger } from '../logger';
import { buildWorkSessionKey } from '../session-identity';
import { MetricsEventStore } from './event-store';
import type { FollowupQueueMetric, MetricsEvent, MetricsEventType, TokenUsageMetadata } from './types';

const logger = new Logger('MetricsEventEmitter');

/**
 * Required counter: finite and non-negative, else 0.
 * Best-effort like the rest of the emitter — a bad reading must not drop the event.
 */
function sanitizeCount(value: number, field: string): number {
  if (Number.isFinite(value) && value >= 0) return value;
  logger.warn(`followup_queue: invalid ${field} (${value}) — clamped to 0`);
  return 0;
}

/** Optional duration/timestamp: kept only when finite and non-negative, else omitted. */
function sanitizeOptionalMs(value: number | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (Number.isFinite(value) && value >= 0) return value;
  logger.warn(`followup_queue: invalid ${field} (${value}) — omitted`);
  return undefined;
}

// Minimal session interface to avoid circular dependency on full ConversationSession
interface SessionLike {
  ownerId: string;
  ownerName?: string;
  channelId: string;
  threadTs?: string;
  workflow?: string;
}

function sessionKeyFrom(session: SessionLike): string {
  return buildWorkSessionKey(session.channelId, session.threadTs);
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

  // === Token Usage Tracking ===

  async emitTokenUsage(userId: string, userName: string, metadata: TokenUsageMetadata): Promise<void> {
    const event = this.buildEvent(
      'token_usage',
      userId,
      userName,
      metadata.sessionKey,
      metadata as unknown as Record<string, unknown>,
    );
    await this.emit(event);
  }

  // === Followup Queue Observability (U13a) ===

  /**
   * Emit a followup-queue observation. Observations only — never a control path.
   *
   * Metadata is built from a fixed whitelist, so callers cannot leak message
   * text / file paths / cwd / credentials by attaching extra properties. The
   * original author identity is whatever the host passes as userId/userName.
   */
  async emitFollowupQueue(
    sessionKey: string | undefined,
    userId: string,
    userName: string,
    metric: FollowupQueueMetric,
  ): Promise<void> {
    const metadata: Record<string, unknown> = {
      operation: metric.operation,
      depth: sanitizeCount(metric.depth, 'depth'),
      uncertainCount: sanitizeCount(metric.uncertainCount, 'uncertainCount'),
    };
    if (typeof metric.itemId === 'string' && metric.itemId) metadata.itemId = metric.itemId;
    if (typeof metric.reason === 'string' && metric.reason) metadata.reason = metric.reason;

    const drainLatencyMs = sanitizeOptionalMs(metric.drainLatencyMs, 'drainLatencyMs');
    if (drainLatencyMs !== undefined) metadata.drainLatencyMs = drainLatencyMs;
    const interruptLatencyMs = sanitizeOptionalMs(metric.interruptLatencyMs, 'interruptLatencyMs');
    if (interruptLatencyMs !== undefined) metadata.interruptLatencyMs = interruptLatencyMs;
    const lastProgressAt = sanitizeOptionalMs(metric.lastProgressAt, 'lastProgressAt');
    if (lastProgressAt !== undefined) metadata.lastProgressAt = lastProgressAt;

    const event = this.buildEvent('followup_queue', userId, userName, sessionKey, metadata);
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

function initMetricsEmitter(store: MetricsEventStore): MetricsEventEmitter {
  _instance = new MetricsEventEmitter(store);
  return _instance;
}
