import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MetricsEventEmitter } from '../event-emitter';
import { __resetMetricsEnsureCache, MetricsEventStore } from '../event-store';
import type { FollowupQueueMetric, MetricsEvent } from '../types';

// U13a — followup queue observability API (observations only, no control).
// Roundtrip through a real MetricsEventStore on a temp dir: emit → JSONL → readRange.

const EVENT_TIMEZONE = process.env.REPORT_TIMEZONE || 'Asia/Seoul';

function dayStr(timestamp: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: EVENT_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(timestamp));
}

const DAY_MS = 24 * 60 * 60 * 1000;

describe('MetricsEventEmitter.emitFollowupQueue', () => {
  let tmpDir: string;
  let store: MetricsEventStore;
  let emitter: MetricsEventEmitter;

  /** Read back every followup_queue event written around now (±1 day covers TZ boundaries). */
  async function readFollowupEvents(): Promise<MetricsEvent[]> {
    const now = Date.now();
    const events = await store.readRange(dayStr(now - DAY_MS), dayStr(now + DAY_MS));
    return events.filter((e) => e.eventType === 'followup_queue');
  }

  beforeEach(() => {
    __resetMetricsEnsureCache();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-followup-metrics-'));
    store = new MetricsEventStore(tmpDir);
    emitter = new MetricsEventEmitter(store);
  });

  afterEach(() => {
    __resetMetricsEnsureCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('enqueue_roundtripsThroughRealStore', async () => {
    const metric: FollowupQueueMetric = {
      operation: 'enqueue',
      depth: 2,
      uncertainCount: 0,
      itemId: 'fu-001',
    };
    await emitter.emitFollowupQueue('C456-123.456', 'U123', 'TestUser', metric);

    const events = await readFollowupEvents();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('followup_queue');
    expect(events[0].userId).toBe('U123');
    expect(events[0].userName).toBe('TestUser');
    expect(events[0].sessionKey).toBe('C456-123.456');
    expect(events[0].metadata).toEqual({
      operation: 'enqueue',
      depth: 2,
      uncertainCount: 0,
      itemId: 'fu-001',
    });
  });

  it('dispatch_preservesExactCountersAndLatencies', async () => {
    await emitter.emitFollowupQueue('C456-123.456', 'U123', 'TestUser', {
      operation: 'dispatch',
      depth: 3,
      uncertainCount: 1,
      itemId: 'fu-002',
      drainLatencyMs: 1234,
      interruptLatencyMs: 56,
      lastProgressAt: 1_757_000_000_000,
    });

    const [event] = await readFollowupEvents();
    expect(event.metadata).toEqual({
      operation: 'dispatch',
      depth: 3,
      uncertainCount: 1,
      itemId: 'fu-002',
      drainLatencyMs: 1234,
      interruptLatencyMs: 56,
      lastProgressAt: 1_757_000_000_000,
    });
    // Exact, not rounded/bucketed
    expect(event.metadata?.drainLatencyMs).toBe(1234);
    expect(event.metadata?.interruptLatencyMs).toBe(56);
    expect(event.metadata?.depth).toBe(3);
  });

  it('reject_preservesReasonCode', async () => {
    await emitter.emitFollowupQueue('C456-123.456', 'U123', 'TestUser', {
      operation: 'reject',
      depth: 1,
      uncertainCount: 0,
      itemId: 'fu-003',
      reason: 'not_original_author',
    });

    const [event] = await readFollowupEvents();
    expect(event.metadata?.reason).toBe('not_original_author');
    expect(event.metadata?.itemId).toBe('fu-003');
  });

  it('metadata_dropsNonWhitelistedFieldsLikeMessageContent', async () => {
    const leaky = {
      operation: 'uncertain',
      depth: 1,
      uncertainCount: 1,
      itemId: 'fu-004',
      text: 'please deploy prod SECRET-PAYLOAD',
      filePath: '/Users/someone/secrets.env',
      cwd: '/Users/someone/repo',
      token: 'xoxb-SECRET-PAYLOAD',
    } as unknown as FollowupQueueMetric;
    await emitter.emitFollowupQueue('C456-123.456', 'U123', 'TestUser', leaky);

    const [event] = await readFollowupEvents();
    expect(event.metadata).toEqual({
      operation: 'uncertain',
      depth: 1,
      uncertainCount: 1,
      itemId: 'fu-004',
    });
    expect(Object.keys(event.metadata ?? {})).not.toContain('text');
    expect(Object.keys(event.metadata ?? {})).not.toContain('cwd');
    expect(JSON.stringify(event)).not.toContain('SECRET-PAYLOAD');
  });

  it('invalidNumerics_clampRequiredCountsAndDropOptionalDurations', async () => {
    await expect(
      emitter.emitFollowupQueue('C456-123.456', 'U123', 'TestUser', {
        operation: 'fail',
        depth: Number.NaN,
        uncertainCount: -3,
        drainLatencyMs: Number.POSITIVE_INFINITY,
        interruptLatencyMs: -1,
        lastProgressAt: Number.NaN,
      }),
    ).resolves.not.toThrow();

    const [event] = await readFollowupEvents();
    expect(event.metadata).toEqual({
      operation: 'fail',
      depth: 0,
      uncertainCount: 0,
    });
  });

  it('allOperations_emitStableEventType', async () => {
    const operations: FollowupQueueMetric['operation'][] = [
      'enqueue',
      'claim',
      'dispatch',
      'resolve',
      'fail',
      'uncertain',
      'reject',
      'snapshot',
    ];
    for (const operation of operations) {
      await emitter.emitFollowupQueue('C456-123.456', 'U123', 'TestUser', {
        operation,
        depth: 0,
        uncertainCount: 0,
      });
    }

    const events = await readFollowupEvents();
    expect(events).toHaveLength(operations.length);
    expect(new Set(events.map((e) => e.eventType))).toEqual(new Set(['followup_queue']));
    expect(new Set(events.map((e) => e.metadata?.operation))).toEqual(new Set(operations));
  });

  it('missingIdentity_defaultsToUnknown', async () => {
    await emitter.emitFollowupQueue(undefined, '', '', {
      operation: 'snapshot',
      depth: 5,
      uncertainCount: 2,
    });

    const [event] = await readFollowupEvents();
    expect(event.userId).toBe('unknown');
    expect(event.userName).toBe('unknown');
    expect(event.sessionKey).toBeUndefined();
    expect(event.metadata).toEqual({ operation: 'snapshot', depth: 5, uncertainCount: 2 });
  });
});
