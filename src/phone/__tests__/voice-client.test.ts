/**
 * The voice service client (.prd/31-phone-calls-architecture.md §3): `warm()` wakes the speech engine with a
 * one-word synthesis whose audio is thrown away — the engine answers ~0.8 s slower after a few idle seconds.
 */
import { describe, expect, it } from 'vitest';
import { createVoiceClient } from '../voice-client';

/** A streaming body that hands out chunks only when read (no eager pull), and errors when the request aborts. */
function lazyBody(chunks: number, signal: AbortSignal | null | undefined, state: { reads: number; eof: boolean }) {
  return new ReadableStream<Uint8Array>(
    {
      start(ctrl) {
        signal?.addEventListener('abort', () => ctrl.error(signal.reason));
      },
      pull(ctrl) {
        if (state.reads >= chunks) return new Promise<void>(() => undefined); // stalls after `chunks` reads
        state.reads++;
        ctrl.enqueue(new Uint8Array([1, 2, 3, 4]));
        if (state.reads === chunks && chunks > 0) {
          state.eof = true;
          ctrl.close();
        }
      },
    },
    { highWaterMark: 0 },
  );
}

describe('createVoiceClient().warm', () => {
  it('sends one tiny streaming synthesis in the call voice and reads it to the end before resolving', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const state = { reads: 0, eof: false };
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(lazyBody(3, init.signal, state), { status: 200 });
    }) as unknown as typeof fetch;
    const client = createVoiceClient(
      { url: 'http://voice-host:9999/', voice: 'cwon-phone', model: 'drama-3', language: 'ko' },
      fetchImpl,
    );
    await client.warm?.();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://voice-host:9999/api/tts/stream');
    expect(calls[0].body).toMatchObject({ voice: 'cwon-phone', model: 'drama-3', format: 'pcm' });
    expect(String((calls[0].body as { text: string }).text).length).toBeLessThanOrEqual(2);
    expect(state).toEqual({ reads: 3, eof: true });
  });

  it('never throws when the service is down', async () => {
    const failing = createVoiceClient(
      { url: 'http://voice-host:9999', voice: 'v', model: 'drama-3', language: 'ko' },
      (async () => {
        throw new Error('down');
      }) as unknown as typeof fetch,
    );
    await expect(failing.warm?.()).resolves.toBeUndefined();
  });

  it('keeps one wake-up in flight, and drops a stalled one when the caller aborts', async () => {
    let fetches = 0;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      fetches++;
      // The first request stalls (never sends a byte); later ones answer.
      return new Response(lazyBody(fetches === 1 ? 0 : 1, init.signal, { reads: 0, eof: false }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = createVoiceClient(
      { url: 'http://voice-host:9999', voice: 'v', model: 'drama-3', language: 'ko' },
      fetchImpl,
    );
    const ended = new AbortController();
    const first = client.warm?.(ended.signal);
    const second = client.warm?.(ended.signal); // the first one still runs: no second request
    await new Promise((r) => setTimeout(r, 0));
    expect(fetches).toBe(1);
    expect(second).toBe(first);
    ended.abort('call-ended'); // the call is over: the stalled wake-up ends with it
    await expect(first).resolves.toBeUndefined();
    await client.warm?.(); // and the next one may go out
    expect(fetches).toBe(2);
  });
});
