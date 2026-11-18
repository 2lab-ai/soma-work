/**
 * The voice service client (.prd/31-phone-calls-architecture.md §3): `warm()` wakes the speech engine with a
 * one-word synthesis whose audio is thrown away — the engine answers ~0.8 s slower after a few idle seconds.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
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
      { url: 'http://down-voice:9999', voice: 'v', model: 'drama-3', language: 'ko' },
      (async () => {
        throw new Error('down');
      }) as unknown as typeof fetch,
    );
    await expect(failing.warm?.()).resolves.toBeUndefined();
  });

  it('keeps one wake-up in flight, and drops a stalled one when the caller aborts', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let fetches = 0;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      fetches++;
      // The first request stalls (never sends a byte); later ones answer.
      return new Response(lazyBody(fetches === 1 ? 0 : 1, init.signal, { reads: 0, eof: false }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = createVoiceClient(
      { url: 'http://stalled-voice:9999', voice: 'v', model: 'drama-3', language: 'ko' },
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
    vi.setSystemTime(Date.now() + 2_000); // the engine has been idle since
    await client.warm?.(); // and the next one may go out
    expect(fetches).toBe(2);
  });

  it('gives up a stalled wake-up after a few seconds on its own, so later ones can go out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let fetches = 0;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      fetches++;
      return new Response(lazyBody(fetches === 1 ? 0 : 1, init.signal, { reads: 0, eof: false }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = createVoiceClient(
      { url: 'http://deadline-voice:9999', voice: 'v', model: 'drama-3', language: 'ko' },
      fetchImpl,
    );
    const call = new AbortController(); // the call goes on: nobody aborts
    let settled = false;
    const first = Promise.resolve(client.warm?.(call.signal)).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(4_900);
    expect(settled).toBe(false);
    expect(client.warm?.(call.signal)).toBeDefined(); // still the same one in flight
    expect(fetches).toBe(1);
    await vi.advanceTimersByTimeAsync(200); // past the deadline
    await first;
    expect(settled).toBe(true);
    await client.warm?.(call.signal);
    expect(fetches).toBe(2);
  });

  it('skips the wake-up while the same voice host is transcribing, for any line', async () => {
    const tts: string[] = [];
    let answerStt!: () => void;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (url.endsWith('/api/stt')) {
        await new Promise<void>((r) => {
          answerStt = r;
        });
        return new Response(JSON.stringify({ text: '네', ms: 1 }), { status: 200 });
      }
      tts.push(url);
      return new Response(lazyBody(1, init.signal, { reads: 0, eof: false }), { status: 200 });
    }) as unknown as typeof fetch;
    const cfg = { url: 'http://shared-voice:9999', voice: 'v', model: 'drama-3', language: 'ko' };
    const lineA = createVoiceClient(cfg, fetchImpl);
    const lineB = createVoiceClient({ ...cfg, voice: 'karina' }, fetchImpl); // another line: own voice, same host
    const elsewhere = createVoiceClient({ ...cfg, url: 'http://other-voice:9999' }, fetchImpl);
    const heard = lineA.transcribe(Buffer.alloc(44));
    await new Promise((r) => setTimeout(r, 0));
    await lineB.warm?.(); // line A's caller is being transcribed on this host: no wake-up
    expect(tts).toEqual([]);
    await elsewhere.warm?.(); // another host is not busy
    expect(tts).toEqual(['http://other-voice:9999/api/tts/stream']);
    answerStt();
    await expect(heard).resolves.toMatchObject({ text: '네' });
    await lineB.warm?.(); // done: wake-ups go out again
    expect(tts).toHaveLength(2);
  });

  it('counts every transcription on the host: one failing or finishing early does not reopen wake-ups', async () => {
    const tts: string[] = [];
    const stt: Array<{ answer: () => void; fail: () => void }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (url.endsWith('/api/stt')) {
        await new Promise<void>((answer, fail) => {
          stt.push({ answer, fail: () => fail(new Error('reset')) });
        });
        return new Response(JSON.stringify({ text: '네', ms: 1 }), { status: 200 });
      }
      tts.push(url);
      return new Response(lazyBody(1, init.signal, { reads: 0, eof: false }), { status: 200 });
    }) as unknown as typeof fetch;
    const cfg = { url: 'http://counted-voice:9999', voice: 'v', model: 'drama-3', language: 'ko' };
    const lineA = createVoiceClient(cfg, fetchImpl);
    const lineB = createVoiceClient({ ...cfg, voice: 'karina' }, fetchImpl); // another line: own voice, same host
    const lineC = createVoiceClient({ ...cfg, voice: 'kate', token: 't' }, fetchImpl);
    const a = lineA.transcribe(Buffer.alloc(44));
    const b = lineB.transcribe(Buffer.alloc(44));
    await new Promise((r) => setTimeout(r, 0));
    expect(stt).toHaveLength(2);
    stt[0].fail(); // line A's transcription fails
    await expect(a).rejects.toThrow('speech-to-text unreachable');
    await lineC.warm?.(); // line B's is still running
    expect(tts).toEqual([]);
    stt[1].answer();
    await b;
    await lineC.warm?.(); // nothing left on the host: wake-ups go out again
    expect(tts).toHaveLength(1);
  });

  it('a transcription that starts cancels a wake-up already running on the same host', async () => {
    let wakeSignal: AbortSignal | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (url.endsWith('/api/stt')) return new Response(JSON.stringify({ text: '네', ms: 1 }), { status: 200 });
      wakeSignal = init.signal ?? undefined;
      return new Response(lazyBody(0, init.signal, { reads: 0, eof: false }), { status: 200 }); // stalls
    }) as unknown as typeof fetch;
    const cfg = { url: 'http://busy-voice:9999', voice: 'v', model: 'drama-3', language: 'ko' };
    const lineA = createVoiceClient(cfg, fetchImpl);
    const lineB = createVoiceClient({ ...cfg, voice: 'karina' }, fetchImpl); // another line: own voice, same host
    const wake = lineA.warm?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(wakeSignal?.aborted).toBe(false);
    await lineB.transcribe(Buffer.alloc(44)); // the other line's caller goes first
    expect(wakeSignal?.aborted).toBe(true);
    await expect(wake).resolves.toBeUndefined();
  });

  it('does not leave an error answer open: the wake-up request is aborted when it ends', async () => {
    let wakeSignal: AbortSignal | undefined;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      wakeSignal = init.signal ?? undefined;
      // 503 headers, then a body that never ends
      return new Response(lazyBody(0, init.signal, { reads: 0, eof: false }), { status: 503 });
    }) as unknown as typeof fetch;
    const client = createVoiceClient(
      { url: 'http://erroring-voice:9999', voice: 'v', model: 'drama-3', language: 'ko' },
      fetchImpl,
    );
    const call = new AbortController();
    await client.warm?.(call.signal);
    expect(call.signal.aborted).toBe(false); // the call goes on
    expect(wakeSignal?.aborted).toBe(true); // the failed request does not
  });

  it('runs one wake-up per voice host: a second line joins the running one', async () => {
    let fetches = 0;
    let answer!: () => void;
    const fetchImpl = (async () => {
      fetches++;
      await new Promise<void>((r) => {
        answer = r;
      });
      return new Response(lazyBody(1, null, { reads: 0, eof: false }), { status: 200 });
    }) as unknown as typeof fetch;
    const cfg = { url: 'http://joined-voice:9999', voice: 'v', model: 'drama-3', language: 'ko' };
    const lineA = createVoiceClient(cfg, fetchImpl);
    const lineB = createVoiceClient({ ...cfg, voice: 'karina' }, fetchImpl); // another line: own voice, same host
    const a = lineA.warm?.();
    const b = lineB.warm?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(fetches).toBe(1);
    expect(b).toBe(a);
    answer();
    await a;
  });

  it('skips the wake-up while the engine is synthesizing for another line on the same host', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const tts: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      tts.push(JSON.parse(String(init.body)).text);
      return new Response(lazyBody(3, init.signal, { reads: 0, eof: false }), { status: 200 });
    }) as unknown as typeof fetch;
    const cfg = { url: 'http://speaking-voice:9999', voice: 'cwon-phone', model: 'drama-3', language: 'ko' };
    const lineA = createVoiceClient(cfg, fetchImpl);
    const lineB = createVoiceClient({ ...cfg, voice: 'karina' }, fetchImpl);
    const reply = await lineA.speak('정리해 드릴게요.');
    const chunks = reply.chunks[Symbol.asyncIterator]();
    await chunks.next(); // line A's reply is streaming
    vi.setSystemTime(Date.now() + 800);
    await chunks.next(); // a chunk 0.8 s after the request …
    vi.setSystemTime(Date.now() + 800); // … and 1.6 s after it, 0.8 s after the last chunk
    await lineB.warm?.(); // the engine is busy and awake: no wake-up
    expect(tts).toEqual(['정리해 드릴게요.']);
    await chunks.next();
    vi.setSystemTime(Date.now() + 2_000); // then idle for a while
    await lineB.warm?.();
    expect(tts).toEqual(['정리해 드릴게요.', '네']);
  });
});

afterEach(() => {
  vi.useRealTimers();
});
