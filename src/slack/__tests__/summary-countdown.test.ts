/**
 * Tests for the countdown indicator shown on the thread surface during the
 * pre-summary wait window.
 *
 * Behavior:
 * - Default wait window: 5 minutes (overridable via SUMMARY_DELAY_MS env).
 * - Countdown ticks: every 1 minute (overridable via
 *   SUMMARY_COUNTDOWN_INTERVAL_MS env). First tick fires immediately (t=0)
 *   so the user sees the countdown right away — MCP-completion style.
 * - Countdown text: "Executive Summary in {N}m {S}s" + a short note that the
 *   prompt cache resets when this fires (the 5-minute wait window is also
 *   roughly the Anthropic prompt-cache TTL).
 * - Cancel paths: timer cancel must also clear the countdown interval, so a
 *   new user message stops both the final fire AND further countdown ticks.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SummaryService, type SummarySessionInfo } from '../summary-service.js';
import { SummaryTimer } from '../summary-timer.js';

describe('SummaryTimer — countdown tick callback', () => {
  let timer: SummaryTimer;

  beforeEach(() => {
    vi.useFakeTimers();
    timer = new SummaryTimer();
  });

  afterEach(() => {
    timer.cancelAll();
    vi.useRealTimers();
  });

  it('exposes a static COUNTDOWN_INTERVAL_MS (default 60 000ms / 1 minute)', () => {
    // Default 1-minute cadence per Z's spec ("1분마다 업데이트").
    expect(SummaryTimer.COUNTDOWN_INTERVAL_MS).toBeTypeOf('number');
    expect(SummaryTimer.COUNTDOWN_INTERVAL_MS).toBeGreaterThan(0);
  });

  it('defaults DELAY_MS to 5 minutes (300 000ms)', () => {
    // Default 5-minute wait per Z's spec ("대기시간 5분으로 해주고").
    // This is also the Anthropic prompt-cache TTL boundary.
    expect(SummaryTimer.DELAY_MS).toBe(300_000);
  });

  it('fires the tick callback immediately at t=0 with the full remaining time', () => {
    const cb = vi.fn();
    const tick = vi.fn();
    timer.start('s', cb, tick);

    // Immediate tick on registration so the user sees the countdown right
    // away rather than waiting one full interval for the first signal.
    expect(tick).toHaveBeenCalledTimes(1);
    const firstRemaining = tick.mock.calls[0][0] as number;
    expect(firstRemaining).toBeGreaterThanOrEqual(SummaryTimer.DELAY_MS - 50);
    expect(firstRemaining).toBeLessThanOrEqual(SummaryTimer.DELAY_MS);
  });

  it('fires the tick callback again at every COUNTDOWN_INTERVAL_MS step', () => {
    const cb = vi.fn();
    const tick = vi.fn();
    timer.start('s', cb, tick);

    // After one interval: 2nd tick.
    vi.advanceTimersByTime(SummaryTimer.COUNTDOWN_INTERVAL_MS);
    expect(tick).toHaveBeenCalledTimes(2);
    const secondRemaining = tick.mock.calls[1][0] as number;
    expect(secondRemaining).toBeLessThan(SummaryTimer.DELAY_MS);
    expect(secondRemaining).toBeGreaterThan(0);

    // After another interval: 3rd tick.
    vi.advanceTimersByTime(SummaryTimer.COUNTDOWN_INTERVAL_MS);
    expect(tick).toHaveBeenCalledTimes(3);
  });

  it('stops ticking once the main timer fires', () => {
    const cb = vi.fn();
    const tick = vi.fn();
    timer.start('s', cb, tick);

    // Advance past the full delay — main callback fires.
    vi.advanceTimersByTime(SummaryTimer.DELAY_MS + 1);
    expect(cb).toHaveBeenCalledTimes(1);

    const ticksAtFire = tick.mock.calls.length;

    // Further time passes — no more ticks.
    vi.advanceTimersByTime(SummaryTimer.COUNTDOWN_INTERVAL_MS * 3);
    expect(tick).toHaveBeenCalledTimes(ticksAtFire);
  });

  it('cancel() clears BOTH the firing timeout AND the countdown interval', () => {
    const cb = vi.fn();
    const tick = vi.fn();
    timer.start('s', cb, tick);

    // One immediate tick fired.
    expect(tick).toHaveBeenCalledTimes(1);

    timer.cancel('s');

    // Long after cancellation — no more ticks, no fire.
    vi.advanceTimersByTime(SummaryTimer.DELAY_MS * 2);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(cb).not.toHaveBeenCalled();
    expect(timer.has('s')).toBe(false);
  });

  it('cancelAll() clears intervals across multiple sessions', () => {
    const t1 = vi.fn();
    const t2 = vi.fn();
    timer.start('a', vi.fn(), t1);
    timer.start('b', vi.fn(), t2);

    expect(t1).toHaveBeenCalledTimes(1);
    expect(t2).toHaveBeenCalledTimes(1);

    timer.cancelAll();

    vi.advanceTimersByTime(SummaryTimer.DELAY_MS * 2);
    expect(t1).toHaveBeenCalledTimes(1);
    expect(t2).toHaveBeenCalledTimes(1);
  });

  it('a thrown tick callback does not kill the interval (still fires later ticks)', () => {
    const cb = vi.fn();
    let firstCall = true;
    const tick = vi.fn(() => {
      if (firstCall) {
        firstCall = false;
        throw new Error('tick boom');
      }
    });

    expect(() => timer.start('s', cb, tick)).not.toThrow();

    expect(tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(SummaryTimer.COUNTDOWN_INTERVAL_MS);
    // Interval survived the throw — second tick fired.
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('omitting the tick parameter is allowed (no interval armed)', () => {
    const cb = vi.fn();
    // Legacy 2-argument signature must still work for callers that don't
    // care about the countdown.
    expect(() => timer.start('s', cb)).not.toThrow();
    vi.advanceTimersByTime(SummaryTimer.DELAY_MS + 1);
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('SummaryService.displayCountdownOnThread()', () => {
  function makeSession(): SummarySessionInfo {
    return { isActive: true, actionPanel: {} };
  }

  it('writes a countdown block to actionPanel.summaryBlocks', () => {
    const service = new SummaryService();
    const session = makeSession();

    service.displayCountdownOnThread(session, 300_000);

    expect(session.actionPanel!.summaryBlocks).toBeDefined();
    expect(Array.isArray(session.actionPanel!.summaryBlocks)).toBe(true);
    expect(session.actionPanel!.summaryBlocks!.length).toBeGreaterThan(0);
  });

  it('block text includes the remaining time formatted as "{m}m {s}s"', () => {
    const service = new SummaryService();
    const session = makeSession();

    service.displayCountdownOnThread(session, 4 * 60_000 + 30_000); // 4m 30s
    const block = session.actionPanel!.summaryBlocks![1]; // [0]=divider, [1]=section
    const text = block.text.text as string;

    expect(text).toMatch(/Executive Summary/i);
    expect(text).toMatch(/4m\s*30s/);
  });

  it('block text omits seconds when remaining time is a whole-minute value', () => {
    const service = new SummaryService();
    const session = makeSession();

    service.displayCountdownOnThread(session, 5 * 60_000); // exactly 5m
    const text = (session.actionPanel!.summaryBlocks![1] as any).text.text as string;

    expect(text).toMatch(/\b5m\b/);
    // Should not include a hanging "0s".
    expect(text).not.toMatch(/0s/);
  });

  it('block text shows seconds-only when <1 minute remains', () => {
    const service = new SummaryService();
    const session = makeSession();

    service.displayCountdownOnThread(session, 25_000); // 25s
    const text = (session.actionPanel!.summaryBlocks![1] as any).text.text as string;

    expect(text).toMatch(/\b25s\b/);
    expect(text).not.toMatch(/\b0m\b/);
  });

  it('block text includes the prompt-cache reset notice', () => {
    // Z's hard requirement: "5분이 지나면 프롬프트 캐시가 리셋된다는 알림 짧게 같이 써줘".
    // The notice must appear in the countdown block so the user sees the
    // cache-reset implication of waiting out the window.
    const service = new SummaryService();
    const session = makeSession();

    service.displayCountdownOnThread(session, 300_000);
    const text = (session.actionPanel!.summaryBlocks![1] as any).text.text as string;

    expect(text.toLowerCase()).toMatch(/prompt[ -]?cache|cache reset/);
  });

  it('uses a divider + section block pair (same shape as the final summary)', () => {
    const service = new SummaryService();
    const session = makeSession();

    service.displayCountdownOnThread(session, 200_000);
    const blocks = session.actionPanel!.summaryBlocks!;

    expect(blocks[0]).toEqual({ type: 'divider' });
    expect(blocks[1]).toMatchObject({
      type: 'section',
      text: { type: 'mrkdwn' },
    });
  });

  it('subsequent ticks produce DIFFERENT block text (defeats thread-surface renderKey short-circuit)', () => {
    // thread-surface.ts has a renderKey short-circuit at line 529 — identical
    // blocks across renders are skipped to save Slack API calls. The countdown
    // text MUST change every tick so the surface actually updates.
    const service = new SummaryService();
    const session = makeSession();

    service.displayCountdownOnThread(session, 300_000);
    const firstText = (session.actionPanel!.summaryBlocks![1] as any).text.text as string;

    service.displayCountdownOnThread(session, 240_000);
    const secondText = (session.actionPanel!.summaryBlocks![1] as any).text.text as string;

    expect(secondText).not.toBe(firstText);
  });

  it('no-op when actionPanel is missing (defensive — does not throw)', () => {
    const service = new SummaryService();
    const session: SummarySessionInfo = { isActive: true };

    expect(() => service.displayCountdownOnThread(session, 100_000)).not.toThrow();
  });

  it('a later displayOnThread() with the real summary overwrites the countdown blocks', () => {
    // Single field, two writers: countdown first, then real summary on fire.
    const service = new SummaryService();
    const session = makeSession();

    service.displayCountdownOnThread(session, 60_000);
    const countdownBlocks = session.actionPanel!.summaryBlocks!;
    expect((countdownBlocks[1] as any).text.text as string).toMatch(/Executive Summary in/);

    service.displayOnThread(session, 'Final real summary body');
    const finalBlocks = session.actionPanel!.summaryBlocks!;
    const finalText = (finalBlocks[1] as any).text.text as string;
    expect(finalText).toContain('Final real summary body');
    expect(finalText).not.toMatch(/Executive Summary in \d+m/);
  });

  it('clearDisplay() wipes the countdown blocks (same field as the real summary)', () => {
    const service = new SummaryService();
    const session = makeSession();

    service.displayCountdownOnThread(session, 60_000);
    expect(session.actionPanel!.summaryBlocks).toBeDefined();

    service.clearDisplay(session);
    expect(session.actionPanel!.summaryBlocks).toBeUndefined();
  });
});
