import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MetricsEventStore } from './event-store';
import type { MetricsEvent } from './types';

// Contract tests — Scenario 1: MetricsEventStore (JSONL Storage Layer)
// Trace: docs/daily-weekly-report/trace.md

const TEST_DATA_DIR = path.join(__dirname, '../../.test-data-metrics');

function makeEvent(overrides: Partial<MetricsEvent> = {}): MetricsEvent {
  return {
    id: 'test-id-1',
    timestamp: new Date('2026-03-25T10:00:00Z').getTime(),
    eventType: 'session_created',
    userId: 'U123',
    userName: 'TestUser',
    ...overrides,
  };
}

describe('MetricsEventStore', () => {
  let store: MetricsEventStore;

  beforeEach(() => {
    // Clean test directory
    if (fs.existsSync(TEST_DATA_DIR)) {
      fs.rmSync(TEST_DATA_DIR, { recursive: true });
    }
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    store = new MetricsEventStore(TEST_DATA_DIR);
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) {
      fs.rmSync(TEST_DATA_DIR, { recursive: true });
    }
  });

  // Trace: Scenario 1, Section 3a — append writes to correct date-based file
  it('append_writesToCorrectDateFile', async () => {
    const event = makeEvent({ timestamp: new Date('2026-03-25T10:00:00Z').getTime() });
    await store.append(event);

    const filePath = path.join(TEST_DATA_DIR, 'metrics-events-2026-03-25.jsonl');
    expect(fs.existsSync(filePath)).toBe(true);

    const content = fs.readFileSync(filePath, 'utf-8').trim();
    const parsed = JSON.parse(content);
    expect(parsed.id).toBe('test-id-1');
    expect(parsed.eventType).toBe('session_created');
  });

  // Trace: Scenario 1, Section 3b — readRange returns sorted events
  it('readRange_returnsSortedEvents', async () => {
    const event1 = makeEvent({ id: 'e1', timestamp: new Date('2026-03-25T14:00:00Z').getTime() });
    const event2 = makeEvent({ id: 'e2', timestamp: new Date('2026-03-25T08:00:00Z').getTime() });
    await store.append(event1);
    await store.append(event2);

    const events = await store.readRange('2026-03-25', '2026-03-25');
    expect(events).toHaveLength(2);
    expect(events[0].id).toBe('e2'); // earlier timestamp first
    expect(events[1].id).toBe('e1');
  });

  // Trace: Scenario 1, Section 5 — ENOENT: returns empty for missing date
  it('readRange_emptyForMissingDate', async () => {
    const events = await store.readRange('2026-01-01', '2026-01-01');
    expect(events).toEqual([]);
  });

  // Trace: Scenario 1, Section 5 — SyntaxError: skips corrupted lines
  it('readRange_skipsCorruptedLines', async () => {
    const filePath = path.join(TEST_DATA_DIR, 'metrics-events-2026-03-25.jsonl');
    const validEvent = JSON.stringify(makeEvent());
    fs.writeFileSync(filePath, `${validEvent}\n{corrupted json\n${validEvent}\n`);

    const events = await store.readRange('2026-03-25', '2026-03-25');
    expect(events).toHaveLength(2); // 2 valid, 1 skipped
  });

  // Trace: Scenario 1, Section 4 — file created on first write
  it('append_fileCreatedOnFirstWrite', async () => {
    const filePath = path.join(TEST_DATA_DIR, 'metrics-events-2026-03-25.jsonl');
    expect(fs.existsSync(filePath)).toBe(false);

    await store.append(makeEvent());
    expect(fs.existsSync(filePath)).toBe(true);
  });

  // Trace: Scenario 1, Section 3b — multi-day aggregation
  it('readRange_multiDayAggregation', async () => {
    const event1 = makeEvent({ id: 'day1', timestamp: new Date('2026-03-24T10:00:00Z').getTime() });
    const event2 = makeEvent({ id: 'day2', timestamp: new Date('2026-03-25T10:00:00Z').getTime() });
    const event3 = makeEvent({ id: 'day3', timestamp: new Date('2026-03-26T10:00:00Z').getTime() });
    await store.append(event1);
    await store.append(event2);
    await store.append(event3);

    const events = await store.readRange('2026-03-24', '2026-03-26');
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.id)).toEqual(['day1', 'day2', 'day3']);
  });
});
