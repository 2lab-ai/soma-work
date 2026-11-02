/**
 * 서버 위스퍼 — the browser's side (epic #737, #739): DICTATION_SERVER_JS run as shipped against fakes.
 *
 *   C1  the worklet averages the microphone down to 16 kHz s16le, 100 ms per chunk
 *   C2  a dictation: microphone → worklet → socket (start first, audio only once the server is ready) → words → stop
 *   C3  failures say why: a refused or missing microphone, no worklet, a server that is not there, a dropped line
 *   C4  status: the server's answer, or why it could not be asked
 *   C5  review (PR #751): stop sends what the worklet still holds before stop; done may say why it ended
 */

import { describe, expect, it, vi } from 'vitest';
import { DICTATION_SERVER_JS } from '../dictation-server-client';

const lastOf = <T>(xs: T[]): T | undefined => xs[xs.length - 1];

type AnyFn = (...a: any[]) => any;
const api = new Function(
  `${DICTATION_SERVER_JS}\nreturn { DICTATION_WORKLET_SRC, dictationServerUrl, dictationServerStatus, dictationServerStart, dictationMicError };`,
)() as Record<string, any>;

describe('C1 — the worklet', () => {
  function runWorklet(rate: number, input: Float32Array) {
    const posted: Int16Array[] = [];
    let Proc: any = null;
    class AudioWorkletProcessor {
      port = { postMessage: (buf: ArrayBuffer) => posted.push(new Int16Array(buf)) };
    }
    new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', api.DICTATION_WORKLET_SRC)(
      AudioWorkletProcessor,
      (_name: string, cls: any) => {
        Proc = cls;
      },
      rate,
    );
    const p = new Proc();
    for (let i = 0; i < input.length; i += 128) expect(p.process([[input.subarray(i, i + 128)]])).toBe(true);
    return posted;
  }

  it.each([48000, 44100])('%i Hz → 16 kHz, 1600 samples (100 ms) per chunk, the level kept', (rate) => {
    // a little over a second: a fractional step (44.1 kHz) lands the 16 000th sample just after the 1 s mark
    const input = new Float32Array(Math.round(rate * 1.01));
    for (let i = 0; i < input.length; i++) input[i] = Math.sin((2 * Math.PI * 300 * i) / rate) * 0.5;
    const out = runWorklet(rate, input);
    expect(out.length).toBe(10);
    expect(out.every((c) => c.length === 1600)).toBe(true);
    const all = Int16Array.from(out.flatMap((c) => Array.from(c)));
    const peak = Math.max(...Array.from(all).map(Math.abs)) / 32768;
    expect(peak).toBeGreaterThan(0.45);
    expect(peak).toBeLessThanOrEqual(0.5);
  });

  it('flush: what is held (less than a chunk) goes out, then flushed', () => {
    const posted: unknown[] = [];
    let Proc: any = null;
    new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', api.DICTATION_WORKLET_SRC)(
      class {
        port: any = { postMessage: (b: unknown) => posted.push(b) };
      },
      (_n: string, c: any) => {
        Proc = c;
      },
      16000,
    );
    const p = new Proc();
    p.process([[new Float32Array(128).fill(0.25)]]);
    p.process([[new Float32Array(128).fill(0.25)]]);
    expect(posted).toEqual([]);
    p.port.onmessage({ data: 'flush' });
    expect(posted.length).toBe(2);
    expect(new Int16Array(posted[0] as ArrayBuffer).length).toBe(256);
    expect(new Int16Array(posted[0] as ArrayBuffer)[0]).toBe(Math.trunc(0.25 * 32767));
    expect(posted[1]).toBe('flushed');
    // nothing held: only flushed
    p.port.onmessage({ data: 'flush' });
    expect(posted[2]).toBe('flushed');
    expect(posted.length).toBe(3);
  });

  it('no input (a stopped track) keeps the node alive and posts nothing', () => {
    const posted: unknown[] = [];
    let Proc: any = null;
    new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', api.DICTATION_WORKLET_SRC)(
      class {
        port = { postMessage: (b: unknown) => posted.push(b) };
      },
      (_n: string, c: any) => {
        Proc = c;
      },
      48000,
    );
    expect(new Proc().process([[]])).toBe(true);
    expect(posted).toEqual([]);
  });
});

function env(opts: { mic?: 'ok' | Error; worklet?: boolean; flush?: boolean } = {}) {
  const tracks = [
    {
      stopped: 0,
      stop() {
        this.stopped++;
      },
    },
  ];
  const sockets: any[] = [];
  const nodes: any[] = [];
  class FakeWS {
    static OPEN = 1;
    readyState = 0;
    sent: unknown[] = [];
    binaryType = '';
    onopen: AnyFn | null = null;
    onmessage: AnyFn | null = null;
    onclose: AnyFn | null = null;
    constructor(public url: string) {
      sockets.push(this);
    }
    send(d: unknown) {
      this.sent.push(d);
    }
    close() {
      this.readyState = 3;
    }
    open() {
      this.readyState = 1;
      this.onopen?.();
    }
    msg(m: object) {
      this.onmessage?.({ data: JSON.stringify(m) });
    }
  }
  class FakeNode {
    port: { onmessage: AnyFn | null; postMessage?: AnyFn } = opts.flush
      ? { onmessage: null, postMessage: vi.fn() }
      : { onmessage: null };
    connected: unknown[] = [];
    constructor(
      public ctx: unknown,
      public name: string,
    ) {
      nodes.push(this);
    }
    connect(n: unknown) {
      this.connected.push(n);
    }
    disconnect() {}
  }
  const ctxs: any[] = [];
  class FakeCtx {
    closed = 0;
    destination = {};
    audioWorklet = opts.worklet === false ? undefined : { addModule: vi.fn(async () => undefined) };
    constructor() {
      ctxs.push(this);
    }
    createMediaStreamSource() {
      return { connect: vi.fn() };
    }
    createGain() {
      return { gain: { value: 1 }, connect: vi.fn() };
    }
    resume() {}
    close() {
      this.closed++;
    }
  }
  const w = {
    navigator: {
      mediaDevices: {
        getUserMedia: vi.fn(() =>
          opts.mic instanceof Error ? Promise.reject(opts.mic) : Promise.resolve({ getTracks: () => tracks }),
        ),
      },
    },
    WebSocket: FakeWS,
    AudioContext: FakeCtx,
    AudioWorkletNode: opts.worklet === false ? undefined : FakeNode,
    URL: { createObjectURL: () => 'blob:worklet', revokeObjectURL: vi.fn() },
    Blob: class {
      constructor(public parts: unknown[]) {}
    },
    location: { protocol: 'https:', host: 'agents.example' },
  };
  return { w, tracks, sockets, nodes, ctxs };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
function callbacks() {
  const got = { ready: [] as string[], text: [] as string[][], errors: [] as string[][], done: [] as string[] };
  return {
    got,
    cb: {
      onReady: (m: string) => got.ready.push(m),
      onText: (f: string, i: string) => got.text.push([f, i]),
      onError: (c: string, m: string) => got.errors.push([c, m]),
      onDone: (f: string, why?: string) => got.done.push(why ? `${f}|${why}` : f),
    },
  };
}

describe('C2 — a dictation', () => {
  it('start first, audio only once ready, words as they settle, then stop → done', async () => {
    const e = env();
    const { got, cb } = callbacks();
    const c = api.dictationServerStart(cb, e.w);
    await flush();
    await flush();
    const gum = (e.w.navigator.mediaDevices.getUserMedia.mock.calls[0] as unknown[])[0];
    expect(gum).toEqual({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const ws = e.sockets[0];
    expect(ws.url).toBe('wss://agents.example/ws/dictation');
    expect(ws.binaryType).toBe('arraybuffer');
    ws.open();
    expect(ws.sent).toEqual([JSON.stringify({ type: 'start', lang: 'ko-KR' })]);
    const node = e.nodes[0];
    expect(node.name).toBe('soma-pcm16');
    const chunk = new Int16Array(1600).buffer;
    node.port.onmessage({ data: chunk }); // before ready: dropped
    expect(ws.sent.length).toBe(1);
    ws.msg({ type: 'ready', model: 'large-v3-turbo' });
    expect(got.ready).toEqual(['large-v3-turbo']);
    node.port.onmessage({ data: chunk });
    expect(ws.sent[1]).toBe(chunk);
    ws.msg({ type: 'text', final: '대시보드', interim: '새 작업' });
    expect(got.text).toEqual([['대시보드', '새 작업']]);
    c.stop();
    expect(e.tracks[0].stopped).toBe(1);
    expect(lastOf(ws.sent)).toBe(JSON.stringify({ type: 'stop' }));
    node.port.onmessage({ data: chunk }); // after stop: not sent
    expect(lastOf(ws.sent)).toBe(JSON.stringify({ type: 'stop' }));
    ws.msg({ type: 'done', final: '대시보드 새 작업' });
    expect(lastOf(got.text)).toEqual(['대시보드 새 작업', '']);
    expect(got.done).toEqual(['대시보드 새 작업']);
    expect(e.ctxs[0].closed).toBe(1);
    ws.onclose?.(); // the server closes after done: no error
    expect(got.errors).toEqual([]);
  });

  it('abort drops everything at once, and nothing is reported after', async () => {
    const e = env();
    const { got, cb } = callbacks();
    const c = api.dictationServerStart(cb, e.w);
    await flush();
    await flush();
    e.sockets[0].open();
    e.sockets[0].msg({ type: 'ready' });
    c.abort();
    expect(e.tracks[0].stopped).toBe(1);
    expect(e.sockets[0].readyState).toBe(3);
    e.sockets[0].onclose?.();
    expect(got.errors).toEqual([]);
  });
});

describe('C5 — review (PR #751)', () => {
  async function ready(e: ReturnType<typeof env>, cb: any) {
    const c = api.dictationServerStart(cb, e.w);
    await flush();
    await flush();
    e.sockets[0].open();
    e.sockets[0].msg({ type: 'ready', model: 'large-v3-turbo' });
    return c;
  }

  it('stop: the worklet’s last partial chunk goes out before stop', async () => {
    const e = env({ flush: true });
    const { cb } = callbacks();
    const c = await ready(e, cb);
    const ws = e.sockets[0];
    const node = e.nodes[0];
    c.stop();
    expect(e.tracks[0].stopped).toBe(1);
    expect(node.port.postMessage).toHaveBeenCalledWith('flush');
    expect(ws.sent).not.toContain(JSON.stringify({ type: 'stop' }));
    const tail = new Int16Array(480).buffer;
    node.port.onmessage({ data: tail });
    node.port.onmessage({ data: 'flushed' });
    expect(ws.sent.slice(-2)).toEqual([tail, JSON.stringify({ type: 'stop' })]);
    node.port.onmessage({ data: new Int16Array(10).buffer }); // after stop: nothing more
    expect(lastOf(ws.sent)).toBe(JSON.stringify({ type: 'stop' }));
  });

  it('stop: a worklet that never answers the flush does not hold the stop', async () => {
    vi.useFakeTimers();
    try {
      const e = env({ flush: true });
      const { cb } = callbacks();
      const c = api.dictationServerStart(cb, e.w);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      e.sockets[0].open();
      e.sockets[0].msg({ type: 'ready' });
      c.stop();
      expect(e.sockets[0].sent).not.toContain(JSON.stringify({ type: 'stop' }));
      // a worklet that is merely slow (a busy audio thread) still gets its tail out: the fallback waits a second
      await vi.advanceTimersByTimeAsync(400);
      expect(e.sockets[0].sent).not.toContain(JSON.stringify({ type: 'stop' }));
      await vi.advanceTimersByTimeAsync(700);
      expect(lastOf(e.sockets[0].sent)).toBe(JSON.stringify({ type: 'stop' }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('done with a message: the words and why it ended', async () => {
    const e = env();
    const { got, cb } = callbacks();
    await ready(e, cb);
    e.sockets[0].msg({ type: 'done', final: '마지막 말', message: '받아쓰기는 한 번에 10분까지입니다' });
    expect(got.done).toEqual(['마지막 말|받아쓰기는 한 번에 10분까지입니다']);
    expect(got.errors).toEqual([]);
  });
});

describe('C3 — failures say why', () => {
  it.each([
    ['NotAllowedError', 'not-allowed', '마이크 권한이 없어'],
    ['NotFoundError', 'audio-capture', '마이크를 찾지 못했습니다'],
    ['NotReadableError', 'audio-capture', '다른 앱이 마이크를 쓰고 있습니다'],
  ])('%s', async (name, code, words) => {
    const e = env({ mic: Object.assign(new Error('x'), { name }) });
    const { got, cb } = callbacks();
    api.dictationServerStart(cb, e.w);
    await flush();
    await flush();
    expect(got.errors[0][0]).toBe(code);
    expect(got.errors[0][1]).toContain(words);
    expect(e.sockets.length).toBe(0);
  });

  it('no AudioWorklet: unsupported, and the microphone is let go', async () => {
    const e = env({ worklet: false });
    const { got, cb } = callbacks();
    api.dictationServerStart(cb, e.w);
    await flush();
    await flush();
    expect(got.errors[0][0]).toBe('unsupported');
    expect(e.tracks[0].stopped).toBe(1);
  });

  it('no microphone streaming at all: unsupported', async () => {
    const { got, cb } = callbacks();
    api.dictationServerStart(cb, { navigator: {}, location: { protocol: 'https:', host: 'x' } });
    await flush();
    expect(got.errors[0][0]).toBe('unsupported');
  });

  it('the server refuses or is not there: its words, or unavailable before ready; closed after', async () => {
    let e = env();
    let k = callbacks();
    api.dictationServerStart(k.cb, e.w);
    await flush();
    await flush();
    e.sockets[0].open();
    e.sockets[0].msg({ type: 'error', code: 'busy', message: '바쁩니다' });
    expect(k.got.errors).toEqual([['busy', '바쁩니다']]);

    e = env();
    k = callbacks();
    api.dictationServerStart(k.cb, e.w);
    await flush();
    await flush();
    e.sockets[0].onclose();
    expect(k.got.errors[0][0]).toBe('unavailable');

    e = env();
    k = callbacks();
    api.dictationServerStart(k.cb, e.w);
    await flush();
    await flush();
    e.sockets[0].open();
    e.sockets[0].msg({ type: 'ready' });
    e.sockets[0].onclose();
    expect(k.got.errors[0][0]).toBe('closed');
    expect(e.tracks[0].stopped).toBe(1);
  });
});

describe('C4 — status', () => {
  it('the server’s answer', async () => {
    const f = vi.fn(async () => ({ ok: true, json: async () => ({ server: { ok: true, model: 'large-v3-turbo' } }) }));
    expect(await api.dictationServerStatus(f)).toEqual({ ok: true, model: 'large-v3-turbo' });
    expect(f).toHaveBeenCalledWith('/api/dictation/status', { credentials: 'same-origin' });
  });

  it('or why it could not be asked', async () => {
    expect(await api.dictationServerStatus(async () => ({ ok: false }))).toEqual({
      ok: false,
      why: '서버에 연결하지 못했습니다',
    });
    expect(
      await api.dictationServerStatus(async () => {
        throw new Error('offline');
      }),
    ).toEqual({ ok: false, why: '서버에 연결하지 못했습니다' });
    expect((await api.dictationServerStatus(async () => ({ ok: true, json: async () => ({}) }))).ok).toBe(false);
  });

  it('ws on http, wss on https', () => {
    expect(api.dictationServerUrl({ protocol: 'http:', host: 'localhost:33000' })).toBe(
      'ws://localhost:33000/ws/dictation',
    );
    expect(api.dictationServerUrl({ protocol: 'https:', host: 'a.example' })).toBe('wss://a.example/ws/dictation');
  });

  it('ships byte for byte', () => {
    expect(DICTATION_SERVER_JS).not.toContain('`');
    expect(DICTATION_SERVER_JS).not.toContain('${');
  });
});
