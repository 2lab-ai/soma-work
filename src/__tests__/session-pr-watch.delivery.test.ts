/**
 * #929 review (trinity astra P1) — a host turn is injected only into a settled session.
 *
 * `SlackHandler.handleMessage` drops a synthetic turn while the session's dispatch slot is held
 * (slack-handler.ts "Synthetic turn blocked"), and the registry's onIdle callbacks fire when the activity
 * state turns idle — before the finishing turn releases that slot. A CI message queued on onIdle was marked
 * delivered and then silently dropped. `createSettledDelivery` holds the message and injects it only when
 * the session reads 'ready' (idle, no request, no slot), checking again every `retryMs`, one message per
 * settle, up to `maxWaitMs`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSettledDelivery, type DeliveryState } from '../session-pr-watch';

describe('createSettledDelivery (#929)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function harness(initial: DeliveryState) {
    const state = { now: initial as DeliveryState };
    const injected: Array<{ key: string; text: string }> = [];
    const d = createSettledDelivery({
      state: () => state.now,
      inject: async (key, text) => {
        injected.push({ key, text });
      },
      retryMs: 1000,
      maxWaitMs: 10_000,
    });
    return { d, state, injected };
  }

  it('a ready session gets the message now', async () => {
    const h = harness('ready');
    await expect(h.d.deliver('s1', 'hello')).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.injected).toEqual([{ key: 's1', text: 'hello' }]);
  });

  it('a busy session gets it only once it is ready — never while its slot is held', async () => {
    const h = harness('busy');
    await h.d.deliver('s1', 'ci failed');
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.injected).toEqual([]);
    h.state.now = 'ready';
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.injected).toEqual([{ key: 's1', text: 'ci failed' }]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.injected).toHaveLength(1);
  });

  it('two messages: one per settle, in order', async () => {
    const h = harness('busy');
    await h.d.deliver('s1', 'first');
    await h.d.deliver('s1', 'second');
    h.state.now = 'ready';
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.injected.map((i) => i.text)).toEqual(['first']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.injected.map((i) => i.text)).toEqual(['first', 'second']);
  });

  it('a session gone (terminated, no Slack thread) drops its messages; deliver says false when gone at once', async () => {
    const h = harness('gone');
    await expect(h.d.deliver('s1', 'x')).resolves.toBe(false);
    const h2 = harness('busy');
    await h2.d.deliver('s1', 'x');
    h2.state.now = 'gone';
    await vi.advanceTimersByTimeAsync(2000);
    h2.state.now = 'ready';
    await vi.advanceTimersByTimeAsync(2000);
    expect(h2.injected).toEqual([]);
  });

  it('a session busy past maxWaitMs drops the message instead of waking it hours later', async () => {
    const h = harness('busy');
    await h.d.deliver('s1', 'stale');
    await vi.advanceTimersByTimeAsync(11_000);
    h.state.now = 'ready';
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.injected).toEqual([]);
  });

  it('a message no longer current (PR merged, new head, card moved) is dropped as gone, never injected (#929 round 2)', async () => {
    const h = harness('busy');
    let current = true;
    const outcomes: string[] = [];
    await h.d.deliver(
      's1',
      'CI failed on the old head',
      (o) => outcomes.push(o),
      () => current,
    );
    current = false;
    h.state.now = 'ready';
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.injected).toEqual([]);
    expect(outcomes).toEqual(['gone']);
    // Not current at the call: nothing is queued.
    await expect(h.d.deliver('s1', 'x', undefined, () => false)).resolves.toBe(false);
  });

  it('a message both too old and no longer current is dropped as gone, not expired — expired would record it (#929 round 3)', async () => {
    const h = harness('busy');
    let current = true;
    const outcomes: string[] = [];
    await h.d.deliver(
      's1',
      'CI failed on a PR that merged',
      (o) => outcomes.push(o),
      () => current,
    );
    // Still current while it waits; the PR merges in the same interval the wait runs out.
    await vi.advanceTimersByTimeAsync(10_500);
    expect(outcomes).toEqual([]);
    current = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(outcomes).toEqual(['gone']);
  });

  it('stop() ends the retry timer', async () => {
    const h = harness('busy');
    await h.d.deliver('s1', 'x');
    h.d.stop();
    h.state.now = 'ready';
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.injected).toEqual([]);
  });
});

describe('entry point wiring (#929 review)', () => {
  it('the daemon delivers through createSettledDelivery and asks SlackHandler whether a host turn can start', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const index = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf-8');
    expect(index).toContain('createSettledDelivery(');
    expect(index).toContain('slackHandler.isHostTurnFree(');
    expect(index).not.toMatch(/prWatchRegistry\.registerOnIdle/);
    const handler = fs.readFileSync(path.join(__dirname, '..', 'slack-handler.ts'), 'utf-8');
    expect(handler).toMatch(/isHostTurnFree\(channel: string, threadTs\?: string\): boolean/);
  });
});
