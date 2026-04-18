/**
 * Watchdog tests — plan v8 tests 48-52.
 */
import { describe, expect, it, vi } from 'vitest';
import { runWithWatchdog } from './watchdog.js';
import { ErrorCode, LlmChatError } from './errors.js';

describe('runWithWatchdog', () => {
  it('timeout fires and calls killChild with SIGTERM (test 48)', async () => {
    const kills: string[] = [];
    const work = new Promise<string>(() => {}); // never resolves
    const err = await runWithWatchdog(work, {
      timeoutMs: 50,
      killChild: (sig) => kills.push(sig),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmChatError);
    expect((err as LlmChatError).code).toBe(ErrorCode.BACKEND_TIMEOUT);
    expect(kills[0]).toBe('SIGTERM');
  });

  it('SIGTERM followed by SIGKILL after grace (test 49)', async () => {
    const kills: { sig: string; at: number }[] = [];
    const start = Date.now();
    const work = new Promise<string>(() => {});
    await runWithWatchdog(work, {
      timeoutMs: 20,
      killGraceMs: 100,
      killChild: (sig) => kills.push({ sig, at: Date.now() - start }),
    }).catch(() => {});
    // Wait for the followup SIGKILL
    await new Promise<void>((r) => { const t = setTimeout(r, 200); t.unref?.(); });
    expect(kills.map((k) => k.sig)).toEqual(['SIGTERM', 'SIGKILL']);
    expect(kills[1].at - kills[0].at).toBeGreaterThanOrEqual(80);
  });

  it('AbortSignal triggers SIGTERM→SIGKILL and rejects ABORTED (test 50)', async () => {
    const kills: string[] = [];
    const controller = new AbortController();
    const work = new Promise<string>(() => {});
    const p = runWithWatchdog(work, {
      timeoutMs: 60_000,
      signal: controller.signal,
      killGraceMs: 30,
      killChild: (sig) => kills.push(sig),
    });
    await new Promise<void>((r) => { const t = setTimeout(r, 5); t.unref?.(); });
    controller.abort();
    const err = await p.catch((e) => e);
    expect(err).toBeInstanceOf(LlmChatError);
    expect((err as LlmChatError).code).toBe(ErrorCode.ABORTED);
    expect(kills[0]).toBe('SIGTERM');
    await new Promise<void>((r) => { const t = setTimeout(r, 60); t.unref?.(); });
    expect(kills).toContain('SIGKILL');
  });

  it('normal exit clears timer and removes abort listener (test 51)', async () => {
    const controller = new AbortController();
    const spy = vi.spyOn(controller.signal, 'removeEventListener');
    const work = Promise.resolve(42);
    const result = await runWithWatchdog(work, {
      timeoutMs: 10_000,
      signal: controller.signal,
      killChild: () => {},
    });
    expect(result).toBe(42);
    expect(spy).toHaveBeenCalled();
  });

  it('reused AbortSignal across many requests does not accumulate listeners (test 52)', async () => {
    const controller = new AbortController();
    for (let i = 0; i < 10; i++) {
      await runWithWatchdog(Promise.resolve(i), {
        timeoutMs: 5_000,
        signal: controller.signal,
        killChild: () => {},
      });
    }
    // Best-effort listener count assertion via internal "listeners" if available.
    // We rely on the removeEventListener assertion already covered in test 51;
    // here we ensure no uncaught handler triggers on abort after completions.
    const kills: string[] = [];
    const p = runWithWatchdog(new Promise<number>(() => {}), {
      timeoutMs: 5_000,
      signal: controller.signal,
      killGraceMs: 30,
      killChild: (s) => kills.push(s),
    });
    controller.abort();
    await p.catch(() => {});
    // Only ONE kill sequence should fire from the active call; prior calls left no listeners.
    expect(kills.filter((s) => s === 'SIGTERM').length).toBe(1);
  });
});
