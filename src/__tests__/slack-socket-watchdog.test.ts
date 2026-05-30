import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startSlackSocketWatchdog } from '../slack-socket-watchdog';

type UnhealthyReason = 'reconnect-storm' | 'stale-inbound' | 'unrecoverable-start';

function makeClient(): EventEmitter {
  return new EventEmitter();
}

describe('startSlackSocketWatchdog', () => {
  let now = 0;
  const advance = (ms: number): void => {
    now += ms;
  };

  beforeEach(() => {
    now = 1_000_000;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('trips reconnect-storm after N consecutive reconnects', () => {
    const client = makeClient();
    const reasons: UnhealthyReason[] = [];

    startSlackSocketWatchdog({
      client,
      reconnectStormThreshold: 3,
      stalenessMs: 60_000,
      checkIntervalMs: 30_000,
      onUnhealthy: (r) => reasons.push(r),
      now: () => now,
    });

    client.emit('connected');
    client.emit('reconnecting');
    client.emit('reconnecting');
    expect(reasons).toEqual([]);
    client.emit('reconnecting');
    expect(reasons).toEqual(['reconnect-storm']);
  });

  it('resets the reconnect counter on a healthy connected event', () => {
    const client = makeClient();
    const reasons: UnhealthyReason[] = [];

    startSlackSocketWatchdog({
      client,
      reconnectStormThreshold: 3,
      stalenessMs: 60_000,
      checkIntervalMs: 30_000,
      onUnhealthy: (r) => reasons.push(r),
      now: () => now,
    });

    client.emit('connected');
    client.emit('reconnecting');
    client.emit('reconnecting');
    client.emit('connected'); // healthy recovery
    client.emit('reconnecting');
    client.emit('reconnecting');
    expect(reasons).toEqual([]);
  });

  it('trips stale-inbound after stalenessMs while not Connected', () => {
    const client = makeClient();
    const reasons: UnhealthyReason[] = [];

    startSlackSocketWatchdog({
      client,
      reconnectStormThreshold: 99,
      stalenessMs: 5 * 60_000,
      checkIntervalMs: 30_000,
      onUnhealthy: (r) => reasons.push(r),
      now: () => now,
    });

    client.emit('connected');
    client.emit('slack_event', {});
    // Reconnecting flips socketConnected=false so staleness is now armed.
    client.emit('reconnecting');

    advance(6 * 60_000);
    vi.advanceTimersByTime(30_000);

    expect(reasons).toEqual(['stale-inbound']);
  });

  it('suppresses stale-inbound while the socket is Connected', () => {
    // Quiet channels on a healthy socket are not a symptom. Staleness only
    // counts while the connection itself is also down.
    const client = makeClient();
    const reasons: UnhealthyReason[] = [];

    startSlackSocketWatchdog({
      client,
      reconnectStormThreshold: 99,
      stalenessMs: 5 * 60_000,
      checkIntervalMs: 30_000,
      onUnhealthy: (r) => reasons.push(r),
      now: () => now,
    });

    client.emit('connected');
    advance(60 * 60_000);
    vi.advanceTimersByTime(30_000);

    expect(reasons).toEqual([]);
  });

  it('does not trip stale-inbound on a healthy-but-quiet socket wired post-connect', () => {
    // Production repro: the watchdog is wired AFTER `app.start()` resolves,
    // so it never observes the socket's first `connected` event. Without
    // `initiallyConnected: true`, `socketConnected` stays false on a perfectly
    // healthy socket and stale-inbound fires every `stalenessMs`, restart-
    // looping the process. No `connected`/`reconnecting` events arrive here —
    // exactly the stable-socket case.
    const client = makeClient();
    const reasons: UnhealthyReason[] = [];

    startSlackSocketWatchdog({
      client,
      reconnectStormThreshold: 99,
      stalenessMs: 5 * 60_000,
      checkIntervalMs: 30_000,
      initiallyConnected: true,
      onUnhealthy: (r) => reasons.push(r),
      now: () => now,
    });

    // No inbound events, socket stays up (no reconnecting). Quiet for an hour.
    advance(60 * 60_000);
    vi.advanceTimersByTime(30_000);

    expect(reasons).toEqual([]);
  });

  it('trips unrecoverable-start immediately on unable_to_socket_mode_start', () => {
    const client = makeClient();
    const reasons: UnhealthyReason[] = [];

    startSlackSocketWatchdog({
      client,
      reconnectStormThreshold: 99,
      stalenessMs: 5 * 60_000,
      checkIntervalMs: 30_000,
      onUnhealthy: (r) => reasons.push(r),
      now: () => now,
    });

    client.emit('unable_to_socket_mode_start', new Error('boom'));
    expect(reasons).toEqual(['unrecoverable-start']);
  });

  it('slack_event resets the staleness clock', () => {
    const client = makeClient();
    const reasons: UnhealthyReason[] = [];

    startSlackSocketWatchdog({
      client,
      reconnectStormThreshold: 99,
      stalenessMs: 5 * 60_000,
      checkIntervalMs: 30_000,
      onUnhealthy: (r) => reasons.push(r),
      now: () => now,
    });

    client.emit('reconnecting'); // not Connected — staleness is armed
    for (let i = 0; i < 10; i++) {
      advance(2 * 60_000);
      client.emit('slack_event', {});
      vi.advanceTimersByTime(30_000);
    }
    expect(reasons).toEqual([]);
  });

  it('does not re-fire after the first trip', () => {
    // First-trip-wins: the host's `process.exit(1)` is async, so the
    // watchdog must not flood the log between trip and exit.
    const client = makeClient();
    const reasons: UnhealthyReason[] = [];

    startSlackSocketWatchdog({
      client,
      reconnectStormThreshold: 2,
      stalenessMs: 60_000,
      checkIntervalMs: 30_000,
      onUnhealthy: (r) => reasons.push(r),
      now: () => now,
    });

    client.emit('reconnecting');
    client.emit('reconnecting'); // trips
    client.emit('reconnecting');
    client.emit('reconnecting');
    advance(5 * 60_000);
    vi.advanceTimersByTime(30_000);

    expect(reasons).toEqual(['reconnect-storm']);
  });

  it('stop() removes listeners and cancels the periodic check', () => {
    const client = makeClient();
    const reasons: UnhealthyReason[] = [];

    const handle = startSlackSocketWatchdog({
      client,
      reconnectStormThreshold: 3,
      stalenessMs: 60_000,
      checkIntervalMs: 30_000,
      onUnhealthy: (r) => reasons.push(r),
      now: () => now,
    });

    handle.stop();

    client.emit('reconnecting');
    client.emit('reconnecting');
    client.emit('reconnecting');
    expect(reasons).toEqual([]);

    advance(120_000);
    vi.advanceTimersByTime(30_000);
    expect(reasons).toEqual([]);
  });
});
