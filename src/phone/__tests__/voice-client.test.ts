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

  it('never throws when the service is down, and the failed request does not keep the host busy', async () => {
    let fetches = 0;
    const failing = createVoiceClient(
      { url: 'http://down-voice:9999', voice: 'v', model: 'drama-3', language: 'ko' },
      (async (_url: string, init: RequestInit) => {
        if (++fetches === 1) throw new Error('down');
        return new Response(lazyBody(1, init.signal, { reads: 0, eof: false }), { status: 200 });
      }) as unknown as typeof fetch,
    );
    await expect(failing.warm?.()).resolves.toBeUndefined();
    await failing.warm?.(); // right away: the service is back
    expect(fetches).toBe(2);
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
    stt[0].fail(); // line A's transcription fails …
    await new Promise((r) => setTimeout(r, 0));
    expect(stt).toHaveLength(3); // … is tried once more …
    stt[2].fail(); // … and fails again
    await expect(a).rejects.toThrow('speech-to-text unreachable');
    await lineC.warm?.(); // line B's is still running
    expect(tts).toEqual([]);
    stt[1].answer();
    await b;
    await lineC.warm?.(); // nothing left on the host: wake-ups go out again
    expect(tts).toHaveLength(1);
  });

  it('a transcription whose request fails is tried once more, and the words are not lost', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) throw new Error('connect timeout');
      return new Response(JSON.stringify({ text: '회의실 예약도 부탁드려요', ms: 3 }), { status: 200 });
    }) as unknown as typeof fetch;
    const v = createVoiceClient(
      { url: 'http://retry-voice:9999', voice: 'v', model: 'drama-3', language: 'ko' },
      fetchImpl,
    );
    await expect(v.transcribe(Buffer.alloc(44))).resolves.toEqual({ text: '회의실 예약도 부탁드려요', ms: 3 });
    expect(calls).toBe(2);
  });

  it('an answer whose body stalls after the headers is given up and tried again', async () => {
    let calls = 0;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      calls++;
      if (calls === 1) {
        const body = new ReadableStream({
          start(c) {
            init.signal?.addEventListener('abort', () => c.error(new Error('aborted')));
          },
        });
        return new Response(body, { status: 200 });
      }
      return new Response(JSON.stringify({ text: '회의실 예약도요', ms: 2 }), { status: 200 });
    }) as unknown as typeof fetch;
    vi.useFakeTimers();
    try {
      const v = createVoiceClient(
        { url: 'http://stall-voice:9999', voice: 'v', model: 'drama-3', language: 'ko' },
        fetchImpl,
      );
      const p = v.transcribe(Buffer.alloc(44));
      await vi.advanceTimersByTimeAsync(4_100);
      await expect(p).resolves.toEqual({ text: '회의실 예약도요', ms: 2 });
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an HTTP error is not retried', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response('busy', { status: 503 });
    }) as unknown as typeof fetch;
    const v = createVoiceClient(
      { url: 'http://err-voice:9999', voice: 'v', model: 'drama-3', language: 'ko' },
      fetchImpl,
    );
    await expect(v.transcribe(Buffer.alloc(44))).rejects.toThrow('speech-to-text answered 503');
    expect(calls).toBe(1);
  });

  it('a transcription request that hangs is given up and tried again', async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      signals.push(init.signal as AbortSignal);
      if (signals.length === 1)
        return new Promise((_, fail) => init.signal?.addEventListener('abort', () => fail(new Error('aborted'))));
      return new Response(JSON.stringify({ text: '네', ms: 1 }), { status: 200 });
    }) as unknown as typeof fetch;
    vi.useFakeTimers();
    try {
      const v = createVoiceClient(
        { url: 'http://hang-voice:9999', voice: 'v', model: 'drama-3', language: 'ko' },
        fetchImpl,
      );
      const p = v.transcribe(Buffer.alloc(44));
      await vi.advanceTimersByTimeAsync(3_900);
      expect(signals).toHaveLength(1); // still waiting for the first
      await vi.advanceTimersByTimeAsync(200);
      expect(signals).toHaveLength(2); // given up at 4 s, tried again
      await expect(p).resolves.toEqual({ text: '네', ms: 1 });
    } finally {
      vi.useRealTimers();
    }
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
    const first = wakeSignal;
    await client.warm?.(call.signal); // and it does not keep the host busy: the next one goes out at once
    expect(wakeSignal).not.toBe(first);
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
    vi.setSystemTime(Date.now() + 1_500);
    await lineB.warm?.(); // the engine is busy with it: no wake-up
    expect(tts).toEqual(['정리해 드릴게요.']);
    while (!(await chunks.next()).done) {
      // line A's reply plays out
    }
    vi.setSystemTime(Date.now() + 500);
    await lineB.warm?.(); // audio came out 0.5 s ago: still awake
    expect(tts).toEqual(['정리해 드릴게요.']);
    vi.setSystemTime(Date.now() + 2_000); // then idle for a while
    await lineB.warm?.();
    expect(tts).toEqual(['정리해 드릴게요.', '네']);
  });

  it('skips the wake-up while another line waits for its first audio, and forgets a stream nobody reads', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const tts: string[] = [];
    let headers!: () => void;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const text = JSON.parse(String(init.body)).text;
      tts.push(text);
      if (text === '오늘 일정을 정리해 드릴게요.')
        await new Promise<void>((r) => {
          headers = r;
        }); // a cold engine: no first byte for a while
      return new Response(lazyBody(1, init.signal, { reads: 0, eof: false }), { status: 200 });
    }) as unknown as typeof fetch;
    const cfg = { url: 'http://cold-voice:9999', voice: 'cwon-phone', model: 'drama-3', language: 'ko' };
    const lineA = createVoiceClient(cfg, fetchImpl);
    const lineB = createVoiceClient({ ...cfg, voice: 'karina' }, fetchImpl);
    const reply = lineA.speak('오늘 일정을 정리해 드릴게요.');
    await new Promise((r) => setTimeout(r, 0));
    vi.setSystemTime(Date.now() + 1_500); // 1.5 s and still no audio for line A
    await lineB.warm?.(); // the engine is working on A's reply: no wake-up
    expect(tts).toEqual(['오늘 일정을 정리해 드릴게요.']);
    headers();
    const left = await reply; // line A got its stream but never reads it
    vi.setSystemTime(Date.now() + 31_000); // a synthesis open this long is not counted any more
    await lineB.warm?.();
    expect(tts).toEqual(['오늘 일정을 정리해 드릴게요.', '네']);
    for await (const _ of left.chunks) {
      // drain
    }
  });

  it('a real reply cancels a running wake-up on the same host (it never waits behind one)', async () => {
    let wakeSignal: AbortSignal | undefined;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const text = JSON.parse(String(init.body)).text;
      if (text === '네') wakeSignal = init.signal ?? undefined;
      return new Response(lazyBody(text === '네' ? 0 : 1, init.signal, { reads: 0, eof: false }), { status: 200 });
    }) as unknown as typeof fetch;
    const cfg = { url: 'http://preempt-voice:9999', voice: 'cwon-phone', model: 'drama-3', language: 'ko' };
    const lineA = createVoiceClient(cfg, fetchImpl);
    const lineB = createVoiceClient({ ...cfg, voice: 'karina' }, fetchImpl);
    const wake = lineA.warm?.(); // a slow wake-up
    await new Promise((r) => setTimeout(r, 0));
    expect(wakeSignal?.aborted).toBe(false);
    const reply = await lineB.speak('바로 말씀드릴게요.');
    expect(wakeSignal?.aborted).toBe(true);
    await expect(wake).resolves.toBeUndefined();
    for await (const _ of reply.chunks) {
      // drain
    }
  });

  it('a synthesis aborted before anyone reads it frees the host at once', async () => {
    let fetches = 0;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      fetches++;
      return new Response(lazyBody(1, init.signal, { reads: 0, eof: false }), { status: 200 });
    }) as unknown as typeof fetch;
    const cfg = { url: 'http://cancelled-voice:9999', voice: 'cwon-phone', model: 'drama-3', language: 'ko' };
    const lineA = createVoiceClient(cfg, fetchImpl);
    const lineB = createVoiceClient({ ...cfg, voice: 'karina' }, fetchImpl);
    const bargeIn = new AbortController();
    await lineA.speak('정리해 드릴게요.', bargeIn.signal); // headers in, nobody has read the stream yet
    bargeIn.abort('barge-in');
    await lineB.warm?.(); // nothing is synthesizing any more
    expect(fetches).toBe(2);
  });

  it('a transcription stuck for good stops holding the host after a while', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const tts: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (url.endsWith('/api/stt')) return new Promise<Response>(() => undefined); // never answers
      tts.push(url);
      return new Response(lazyBody(1, init.signal, { reads: 0, eof: false }), { status: 200 });
    }) as unknown as typeof fetch;
    const cfg = { url: 'http://stuck-voice:9999', voice: 'v', model: 'drama-3', language: 'ko' };
    const lineA = createVoiceClient(cfg, fetchImpl);
    const lineB = createVoiceClient({ ...cfg, voice: 'karina' }, fetchImpl);
    void lineA.transcribe(Buffer.alloc(44));
    await new Promise((r) => setTimeout(r, 0));
    vi.setSystemTime(Date.now() + 10_000);
    await lineB.warm?.(); // still counted: no wake-up beside it
    expect(tts).toEqual([]);
    vi.setSystemTime(Date.now() + 25_000); // 35 s: not a live transcription any more
    await lineB.warm?.();
    expect(tts).toHaveLength(1);
  });

  it('a real reply that fails (unreachable or an error answer) does not keep the host busy', async () => {
    const answers: Array<'throw' | 503 | 200> = ['throw', 503, 200, 200];
    const sent: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)).text);
      const a = answers.shift();
      if (a === 'throw') throw new Error('down');
      return new Response(lazyBody(1, init.signal, { reads: 0, eof: false }), { status: a });
    }) as unknown as typeof fetch;
    const cfg = { url: 'http://failing-reply-voice:9999', voice: 'cwon-phone', model: 'drama-3', language: 'ko' };
    const lineA = createVoiceClient(cfg, fetchImpl);
    const lineB = createVoiceClient({ ...cfg, voice: 'karina' }, fetchImpl);
    await expect(lineA.speak('하나')).rejects.toThrow('unreachable');
    await expect(lineA.speak('둘')).rejects.toThrow('answered 503');
    await lineB.warm?.(); // neither failed reply is still counted: the wake-up goes out
    expect(sent).toEqual(['하나', '둘', '네']);
  });
});

describe('createVoiceClient().speak — speed', () => {
  const pcm = (ms: number) => {
    const n = Math.round((44100 * ms) / 1000);
    const b = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 180 * i) / 44100) * 9000), i * 2);
    return b;
  };
  const fetchWith = (body: Buffer) =>
    (async () =>
      new Response(new Uint8Array(body), {
        status: 200,
        headers: { 'x-soma-voice-sample-rate': '44100' },
      })) as unknown as typeof fetch;
  async function all(s: { chunks: AsyncIterable<Buffer> }): Promise<Buffer> {
    const parts: Buffer[] = [];
    for await (const c of s.chunks) parts.push(c);
    return Buffer.concat(parts);
  }

  it('speaks 1.5x faster when the line asks for it, and untouched without it', async () => {
    const body = pcm(3000);
    const cfg = { url: 'http://speed-voice:9999', voice: 'v', model: 'drama-3', language: 'ko' };
    const plain = await all(await createVoiceClient(cfg, fetchWith(body)).speak('네'));
    expect(plain.equals(body)).toBe(true);
    const fast = await createVoiceClient({ ...cfg, speed: 1.5 }, fetchWith(body)).speak('네');
    expect(fast.sampleRate).toBe(44100);
    const out = await all(fast);
    expect(out.length / 2 / 44100).toBeGreaterThan(2 * 0.97);
    expect(out.length / 2 / 44100).toBeLessThan(2 * 1.03);
  });

  it('hands sped-up audio on while the stream is still open (it does not wait for the end)', async () => {
    let push!: (b: Uint8Array) => void;
    let close!: () => void;
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        push = (b) => ctrl.enqueue(b);
        close = () => ctrl.close();
      },
    });
    const fetchImpl = (async () =>
      new Response(body, { status: 200, headers: { 'x-soma-voice-sample-rate': '44100' } })) as unknown as typeof fetch;
    const s = await createVoiceClient(
      { url: 'http://open-voice:9999', voice: 'v', model: 'drama-3', language: 'ko', speed: 1.5 },
      fetchImpl,
    ).speak('네');
    const it = s.chunks[Symbol.asyncIterator]();
    push(new Uint8Array(pcm(500))); // half a second, far more than the stretcher looks ahead
    const first = await it.next();
    expect(first.done).toBe(false);
    expect((first.value as Buffer).length).toBeGreaterThan(0);
    close();
    let rest = 0;
    for (let r = await it.next(); !r.done; r = await it.next()) rest += (r.value as Buffer).length;
    const total = ((first.value as Buffer).length + rest) / 2 / 44100;
    expect(total).toBeGreaterThan((0.5 / 1.5) * 0.9);
    expect(total).toBeLessThan((0.5 / 1.5) * 1.1);
  });

  it('plays a stream with a malformed sample rate at its own speed rather than hanging', async () => {
    const body = pcm(200);
    const fetchImpl = (async () =>
      new Response(new Uint8Array(body), {
        status: 200,
        headers: { 'x-soma-voice-sample-rate': '1' },
      })) as unknown as typeof fetch;
    const s = await createVoiceClient(
      { url: 'http://odd-voice:9999', voice: 'v', model: 'drama-3', language: 'ko', speed: 1.5 },
      fetchImpl,
    ).speak('네');
    expect((await all(s)).equals(body)).toBe(true);
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createVoiceClient().claim — one job at a time on the voice host', () => {
  const cfg = { url: 'http://lease-host:9999', voice: 'v', model: 'drama-3', language: 'ko', token: 't0k' };
  type Seen = { url: string; method: string; headers: Record<string, string>; body?: string };
  function host(answer: (s: Seen) => Response) {
    const seen: Seen[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const s: Seen = {
        url,
        method: init.method ?? 'GET',
        headers: { ...(init.headers as Record<string, string>) },
        body: typeof init.body === 'string' ? init.body : undefined,
      };
      seen.push(s);
      return answer(s);
    }) as unknown as typeof fetch;
    return { seen, fetchImpl };
  }

  it('held: every request of the call carries the lease; renew and release send it too', async () => {
    const { seen, fetchImpl } = host((s) => {
      if (s.url.endsWith('/api/lease') && s.method === 'POST') return Response.json({ token: 'L1', owner: 'phone' });
      if (s.url.endsWith('/api/stt')) return Response.json({ text: '네', ms: 5 });
      if (s.url.endsWith('/api/tts/stream')) return new Response(new Uint8Array([0, 0]), { status: 200 });
      return new Response(null, { status: s.method === 'DELETE' ? 204 : 200 });
    });
    const claim = await createVoiceClient(cfg, fetchImpl).claim?.('phone:dev:outbound');
    expect(claim?.kind).toBe('held');
    if (claim?.kind !== 'held') return;
    expect(JSON.parse(String(seen[0].body))).toEqual({ owner: 'phone:dev:outbound', ttl_ms: 30_000 });
    expect(seen[0].headers.authorization).toBe('Bearer t0k');
    await claim.voice.transcribe(Buffer.alloc(10));
    const s = await claim.voice.speak('안녕');
    for await (const _ of s.chunks) {
      // drained
    }
    expect(await claim.renew()).toBe(true);
    await claim.release();
    expect(seen.slice(1).map((r) => `${r.method} ${r.url.replace('http://lease-host:9999', '')}`)).toEqual([
      'POST /api/stt',
      'POST /api/tts/stream',
      'POST /api/lease/renew',
      'DELETE /api/lease',
    ]);
    for (const r of seen.slice(1)) {
      expect(r.headers['x-soma-voice-lease']).toBe('L1');
      expect(r.headers.authorization).toBe('Bearer t0k');
    }
  });

  it('busy when the host answers 409 (with who holds it), cannot be reached, or errors', async () => {
    const busy = host(() => Response.json({ error: 'busy', holder: 'voicechat', in_flight: 0 }, { status: 409 }));
    expect(await createVoiceClient(cfg, busy.fetchImpl).claim?.('phone')).toEqual({
      kind: 'busy',
      reason: 'busy with voicechat',
    });
    const queued = host(() => Response.json({ error: 'busy', holder: null, in_flight: 2 }, { status: 409 }));
    expect(await createVoiceClient(cfg, queued.fetchImpl).claim?.('phone')).toEqual({ kind: 'busy', reason: 'busy' });
    const down = createVoiceClient(cfg, (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch);
    expect(await down.claim?.('phone')).toMatchObject({ kind: 'busy', reason: expect.stringContaining('unreachable') });
    const broken = host(() => new Response('boom', { status: 500 }));
    expect(await createVoiceClient(cfg, broken.fetchImpl).claim?.('phone')).toMatchObject({ kind: 'busy' });
  });

  it('shared when the host has no leases (an older service answers 404): the call goes on as before', async () => {
    const old = host(() => new Response('not found', { status: 404 }));
    expect(await createVoiceClient(cfg, old.fetchImpl).claim?.('phone')).toEqual({ kind: 'shared' });
  });

  it('a lease lost while someone else took the host: renew is false; renew and release never throw', async () => {
    let up = true;
    let claims = 0;
    const { fetchImpl } = host((s) => {
      if (!up) throw new Error('down');
      if (s.url.endsWith('/api/lease') && s.method === 'POST')
        return ++claims === 1
          ? Response.json({ token: 'L2', owner: 'p' })
          : Response.json({ error: 'busy', holder: 'voicechat' }, { status: 409 });
      return Response.json({ error: 'lease is not held' }, { status: 404 });
    });
    const claim = await createVoiceClient(cfg, fetchImpl).claim?.('phone');
    if (claim?.kind !== 'held') throw new Error('not held');
    expect(await claim.renew()).toBe(false); // 404, and the host is busy again: not taken back
    expect(claims).toBe(2);
    up = false;
    expect(await claim.renew()).toBe(false);
    await expect(claim.release()).resolves.toBeUndefined();
  });

  it('a lease the host lost (it restarted) is taken again, and the call carries the new token from then on', async () => {
    let n = 0;
    let known = 'L1';
    const { seen, fetchImpl } = host((s) => {
      if (s.url.endsWith('/api/lease') && s.method === 'POST') {
        known = `L${++n}`;
        return Response.json({ token: known, owner: 'p' });
      }
      if (s.url.endsWith('/api/lease/renew'))
        return s.headers['x-soma-voice-lease'] === known
          ? Response.json({ token: known })
          : Response.json({ error: 'lease is not held' }, { status: 404 });
      return Response.json({ text: '네', ms: 1 });
    });
    const claim = await createVoiceClient(cfg, fetchImpl).claim?.('phone:dev:inbound');
    if (claim?.kind !== 'held') throw new Error('not held');
    known = 'gone'; // the host restarted: it knows no lease
    expect(await claim.renew()).toBe(true);
    await claim.voice.transcribe(Buffer.alloc(10));
    const last = seen[seen.length - 1];
    expect(last.url).toContain('/api/stt');
    expect(last.headers['x-soma-voice-lease']).toBe('L2');
    expect(JSON.parse(String(seen.find((r, i) => i > 0 && r.url.endsWith('/api/lease'))?.body))).toMatchObject({
      owner: 'phone:dev:inbound',
    });
  });

  it('a renewal in flight when the call ends does not take the host again behind the release', async () => {
    let claims = 0;
    let letRenewAnswer!: () => void;
    const renewGate = new Promise<void>((r) => {
      letRenewAnswer = r;
    });
    const { seen, fetchImpl } = host((s) => {
      if (s.url.endsWith('/api/lease') && s.method === 'POST') return Response.json({ token: `L${++claims}` });
      return Response.json({}, { status: s.method === 'DELETE' ? 204 : 200 });
    });
    const slow = (async (url: string, init: RequestInit) => {
      if (url.endsWith('/api/lease/renew')) {
        await renewGate; // the release overtakes it: the host no longer knows the lease
        return Response.json({ error: 'lease is not held' }, { status: 404 });
      }
      return fetchImpl(url, init);
    }) as unknown as typeof fetch;
    const claim = await createVoiceClient(cfg, slow).claim?.('phone');
    if (claim?.kind !== 'held') throw new Error('not held');
    const renewing = claim.renew();
    await claim.release();
    letRenewAnswer();
    expect(await renewing).toBe(false);
    expect(claims).toBe(1); // never taken again
    expect(seen.filter((r) => r.method === 'DELETE')).toHaveLength(1);
  });

  it('a lease answer that is JSON null is busy, not a crash', async () => {
    const nul = host(() => new Response('null', { status: 200, headers: { 'content-type': 'application/json' } }));
    expect(await createVoiceClient(cfg, nul.fetchImpl).claim?.('phone')).toMatchObject({ kind: 'busy' });
    const nul409 = host(() => new Response('null', { status: 409 }));
    expect(await createVoiceClient(cfg, nul409.fetchImpl).claim?.('phone')).toEqual({ kind: 'busy', reason: 'busy' });
  });

  it('a host that never answers: claim is busy, renew false and release settled by the 3 s bound', async () => {
    let held = false;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (!held && url.endsWith('/api/lease') && init.method === 'POST') {
        held = true;
        return Response.json({ token: 'L1' });
      }
      return new Promise<Response>((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    }) as unknown as typeof fetch;
    const client = createVoiceClient(cfg, fetchImpl);
    const claim = await client.claim?.('phone');
    if (claim?.kind !== 'held') throw new Error('not held');
    const t0 = Date.now();
    const [again, renewed, released] = await Promise.all([client.claim?.('phone'), claim.renew(), claim.release()]);
    const ms = Date.now() - t0;
    expect(again).toMatchObject({ kind: 'busy', reason: expect.stringContaining('unreachable') });
    expect(renewed).toBe(false);
    expect(released).toBeUndefined();
    expect(ms).toBeGreaterThanOrEqual(2_900);
    expect(ms).toBeLessThan(5_000);
  }, 10_000);
});
