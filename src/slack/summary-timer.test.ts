import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SummaryTimer } from './summary-timer.js';

describe('SummaryTimer', () => {
  let timer: SummaryTimer;

  beforeEach(() => {
    vi.useFakeTimers();
    timer = new SummaryTimer();
  });

  afterEach(() => {
    timer.cancelAll();
    vi.useRealTimers();
  });

  describe('start()', () => {
    it('sets a timer that fires after DELAY_MS', () => {
      const callback = vi.fn();
      timer.start('session-1', callback);

      expect(timer.has('session-1')).toBe(true);
      expect(callback).not.toHaveBeenCalled();

      vi.advanceTimersByTime(SummaryTimer.DELAY_MS - 1);
      expect(callback).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(callback).toHaveBeenCalledOnce();
      expect(timer.has('session-1')).toBe(false);
    });

    it('resets existing timer when called again for the same session', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      timer.start('session-1', callback1);

      // Advance partway through the first timer
      vi.advanceTimersByTime(100_000);
      expect(callback1).not.toHaveBeenCalled();

      // Reset with a new callback
      timer.start('session-1', callback2);

      // The full original delay passes — first callback should NOT fire
      vi.advanceTimersByTime(100_000);
      expect(callback1).not.toHaveBeenCalled();
      expect(callback2).not.toHaveBeenCalled();

      // Complete the second timer's full delay
      vi.advanceTimersByTime(80_000);
      expect(callback1).not.toHaveBeenCalled();
      expect(callback2).toHaveBeenCalledOnce();
    });
  });

  describe('cancelAll()', () => {
    it('cancels all active timers across sessions', () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      const cb3 = vi.fn();

      timer.start('session-a', cb1);
      timer.start('session-b', cb2);
      timer.start('session-c', cb3);

      expect(timer.has('session-a')).toBe(true);
      expect(timer.has('session-b')).toBe(true);
      expect(timer.has('session-c')).toBe(true);

      timer.cancelAll();

      expect(timer.has('session-a')).toBe(false);
      expect(timer.has('session-b')).toBe(false);
      expect(timer.has('session-c')).toBe(false);

      vi.advanceTimersByTime(SummaryTimer.DELAY_MS + 1000);
      expect(cb1).not.toHaveBeenCalled();
      expect(cb2).not.toHaveBeenCalled();
      expect(cb3).not.toHaveBeenCalled();
    });

    it('cancelAll() is safe when no timers exist', () => {
      expect(() => timer.cancelAll()).not.toThrow();
    });
  });

  describe('callback error handling', () => {
    it('catches sync callback errors without unhandled exception', () => {
      const callback = vi.fn(() => {
        throw new Error('sync kaboom');
      });
      timer.start('session-err', callback);

      // Should not throw
      expect(() => vi.advanceTimersByTime(SummaryTimer.DELAY_MS)).not.toThrow();
      expect(callback).toHaveBeenCalledOnce();
    });

    it('catches async callback rejections without unhandled rejection', () => {
      const callback = vi.fn(async () => {
        throw new Error('async kaboom');
      });
      timer.start('session-err-async', callback);

      // Should not throw
      expect(() => vi.advanceTimersByTime(SummaryTimer.DELAY_MS)).not.toThrow();
      expect(callback).toHaveBeenCalledOnce();
    });
  });

  describe('cancel()', () => {
    it('clears an active timer so the callback never fires', () => {
      const callback = vi.fn();
      timer.start('session-1', callback);

      expect(timer.has('session-1')).toBe(true);

      timer.cancel('session-1');

      expect(timer.has('session-1')).toBe(false);

      vi.advanceTimersByTime(SummaryTimer.DELAY_MS + 1000);
      expect(callback).not.toHaveBeenCalled();
    });

    it('is a no-op when no timer exists for the session', () => {
      // Should not throw
      expect(() => timer.cancel('nonexistent')).not.toThrow();
      expect(timer.has('nonexistent')).toBe(false);
    });
  });
});
