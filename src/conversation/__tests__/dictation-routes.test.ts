/**
 * 서버 위스퍼 live dictation — the HTTP surface (epic #737, #739), on a real Fastify with @fastify/websocket.
 *
 *   R1  status: whether this server can take a dictation, with which model, or why not
 *   R2  a dictation: start → audio frames → words as they settle → stop → done
 *   R3  refused: not signed in, another site, no Whisper, too many at once, bad frames
 *   R4  review (PR #751): a bad message never takes the server down, an unstarted socket lets go, the time limit
 *       still delivers the last words, a failing Whisper says so, audio faster than real time is refused, and a
 *       socket that goes away takes its queued transcriptions with it
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type DictationWhisper, MAX_DICTATIONS, registerDictationRoutes, sameOrigin } from '../dictation-routes';

const lastOf = <T>(xs: T[]): T | undefined => xs[xs.length - 1];

const RATE = 16000;
function tone(ms: number, voiced: boolean): Buffer {
  const n = Math.round((RATE * ms) / 1000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++)
    b.writeInt16LE(voiced ? Math.round(Math.sin((2 * Math.PI * 440 * i) / RATE) * 0.2 * 32767) : 0, i * 2);
  return b;
}

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

async function server(
  whisper: DictationWhisper | null,
  opts: { signedIn?: boolean; startMs?: number; maxMs?: number } = {},
) {
  app = Fastify();
  await app.register(await import('@fastify/websocket'));
  const auth = vi.fn(async (_req: unknown, reply: { code: (n: number) => { send: (b: unknown) => void } }) => {
    if (opts.signedIn === false) reply.code(401).send({ error: 'Unauthorized' });
  });
  registerDictationRoutes(app, auth as never, () => whisper, { startMs: opts.startMs, maxMs: opts.maxMs });
  await app.ready();
  return app;
}

function fakeWhisper(
  answer: (pcm: Int16Array, prompt: string) => string = () => '대시보드 새 작업',
): DictationWhisper & {
  calls: Array<{ samples: number; language: string; prompt: string }>;
} {
  const calls: Array<{ samples: number; language: string; prompt: string }> = [];
  return {
    calls,
    ready: () => true,
    model: () => 'large-v3-turbo',
    why: () => '',
    transcribe: async (pcm, o) => {
      calls.push({ samples: pcm.length, language: o.language, prompt: o.prompt });
      return answer(pcm, o.prompt);
    },
  };
}

type Msg = { type: string; [k: string]: unknown };
async function open(
  a: FastifyInstance,
  headers: Record<string, string> = { host: 'agents.example', origin: 'https://agents.example' },
) {
  const msgs: Msg[] = [];
  let closed: { code: number; reason: string } | null = null;
  const ws = await (a as unknown as { injectWS: Function }).injectWS(
    '/ws/dictation',
    { headers },
    {
      onInit: (s: any) => {
        s.on('message', (d: Buffer) => msgs.push(JSON.parse(String(d))));
        s.on('close', (code: number, reason: Buffer) => {
          closed = { code, reason: String(reason) };
        });
      },
    },
  );
  return { ws, msgs, closed: () => closed };
}

describe('R1 — status', () => {
  it('ready: ok with the model', async () => {
    const a = await server(fakeWhisper());
    const res = await a.inject({ method: 'GET', url: '/api/dictation/status' });
    expect(res.json()).toEqual({ server: { ok: true, model: 'large-v3-turbo' } });
  });

  it('no worker, or one that cannot run: not ok, and why', async () => {
    let a = await server(null);
    expect((await a.inject({ method: 'GET', url: '/api/dictation/status' })).json()).toEqual({
      server: { ok: false, why: '이 서버에는 위스퍼가 없습니다' },
    });
    await a.close();
    const broken = {
      ...fakeWhisper(),
      ready: () => false,
      why: () => '서버 위스퍼를 시작하지 못했습니다 — no module mlx_whisper',
    };
    a = await server(broken);
    expect((await a.inject({ method: 'GET', url: '/api/dictation/status' })).json().server).toEqual({
      ok: false,
      why: '서버 위스퍼를 시작하지 못했습니다 — no module mlx_whisper',
    });
  });

  it('signed in only', async () => {
    const a = await server(fakeWhisper(), { signedIn: false });
    expect((await a.inject({ method: 'GET', url: '/api/dictation/status' })).statusCode).toBe(401);
  });
});

describe('R2 — a dictation', () => {
  it('start → audio → words as they settle → stop → done', async () => {
    const w = fakeWhisper();
    const a = await server(w);
    const c = await open(a);
    c.ws.send(JSON.stringify({ type: 'start', lang: 'ko-KR' }));
    await vi.waitFor(() => expect(c.msgs[0]).toEqual({ type: 'ready', model: 'large-v3-turbo' }));
    for (let i = 0; i < 12; i++) c.ws.send(tone(100, true));
    await vi.waitFor(() => expect(c.msgs.some((m) => m.type === 'text')).toBe(true));
    c.ws.send(JSON.stringify({ type: 'stop' }));
    await vi.waitFor(() => expect(lastOf(c.msgs)).toEqual({ type: 'done', final: '대시보드 새 작업' }));
    // the server closes the socket once done
    await vi.waitFor(() => expect(c.ws.readyState).toBeGreaterThanOrEqual(2));
    expect(w.calls.every((x) => x.language === 'ko')).toBe(true);
    const texts = c.msgs.filter((m) => m.type === 'text');
    expect(lastOf(texts)).toEqual({ type: 'text', final: '대시보드 새 작업', interim: '' });
  });

  it('English when asked', async () => {
    const w = fakeWhisper(() => 'open a new task');
    const a = await server(w);
    const c = await open(a);
    c.ws.send(JSON.stringify({ type: 'start', lang: 'en-US' }));
    for (let i = 0; i < 7; i++) c.ws.send(tone(100, true));
    c.ws.send(JSON.stringify({ type: 'stop' }));
    await vi.waitFor(() => expect(lastOf(c.msgs)?.type).toBe('done'));
    expect(w.calls.length).toBeGreaterThan(0);
    expect(w.calls.every((x) => x.language === 'en')).toBe(true);
  });

  it('silence alone is never sent to Whisper', async () => {
    const w = fakeWhisper(() => '감사합니다.');
    const a = await server(w);
    const c = await open(a);
    c.ws.send(JSON.stringify({ type: 'start' }));
    for (let i = 0; i < 20; i++) c.ws.send(tone(100, false));
    c.ws.send(JSON.stringify({ type: 'stop' }));
    await vi.waitFor(() => expect(lastOf(c.msgs)).toEqual({ type: 'done', final: '' }));
    expect(w.calls).toEqual([]);
  });
});

describe('R3 — refused', () => {
  it('another site’s page', async () => {
    const a = await server(fakeWhisper());
    const c = await open(a, { host: 'agents.example', origin: 'https://evil.example' });
    await vi.waitFor(() => expect(c.msgs[0]).toMatchObject({ type: 'error', code: 'bad-request' }));
    await vi.waitFor(() => expect(c.ws.readyState).toBeGreaterThanOrEqual(2));
  });

  it('no Whisper on this server: unavailable, with why', async () => {
    const a = await server({ ...fakeWhisper(), ready: () => false, why: () => '이 서버에는 위스퍼가 없습니다' });
    const c = await open(a);
    await vi.waitFor(() =>
      expect(c.msgs[0]).toEqual({ type: 'error', code: 'unavailable', message: '이 서버에는 위스퍼가 없습니다' }),
    );
  });

  it(`more than ${MAX_DICTATIONS} at once: busy`, async () => {
    const a = await server(fakeWhisper());
    const held = [];
    for (let i = 0; i < MAX_DICTATIONS; i++) held.push(await open(a));
    const extra = await open(a);
    await vi.waitFor(() => expect(extra.msgs[0]).toMatchObject({ type: 'error', code: 'busy' }));
    // one ends: room again
    held[0].ws.terminate();
    await vi.waitFor(async () => {
      const again = await open(a);
      await vi.waitFor(() => expect(again.msgs.length + 1).toBeGreaterThan(0));
      expect(again.msgs.find((m) => m.type === 'error')).toBeUndefined();
    });
  });

  it('audio before start, an odd-length frame, or a huge frame', async () => {
    const a = await server(fakeWhisper());
    let c = await open(a);
    c.ws.send(tone(100, true));
    await vi.waitFor(() =>
      expect(c.msgs[0]).toMatchObject({ type: 'error', code: 'bad-request', message: 'start first' }),
    );
    c = await open(a);
    c.ws.send(JSON.stringify({ type: 'start' }));
    c.ws.send(Buffer.alloc(3));
    await vi.waitFor(() =>
      expect(lastOf(c.msgs)).toMatchObject({ type: 'error', code: 'bad-request', message: 'bad audio frame' }),
    );
    c = await open(a);
    c.ws.send(JSON.stringify({ type: 'start' }));
    c.ws.send(Buffer.alloc(70 * 1024));
    await vi.waitFor(() => expect(lastOf(c.msgs)).toMatchObject({ type: 'error', code: 'bad-request' }));
  });
});

describe('R4 — review (PR #751)', () => {
  it('a JSON frame that is not an object is a bad request, and the server keeps going', async () => {
    const a = await server(fakeWhisper());
    for (const bad of ['null', '7', '"start"', '[]']) {
      const c = await open(a);
      c.ws.send(bad);
      await vi.waitFor(() => expect(c.msgs[0]).toMatchObject({ type: 'error', code: 'bad-request' }));
      await vi.waitFor(() => expect(c.ws.readyState).toBeGreaterThanOrEqual(2));
    }
    const ok = await open(a);
    ok.ws.send(JSON.stringify({ type: 'start' }));
    await vi.waitFor(() => expect(ok.msgs[0]).toEqual({ type: 'ready', model: 'large-v3-turbo' }));
  });

  it('a socket that never starts lets go of its place', async () => {
    const a = await server(fakeWhisper(), { startMs: 80 });
    const held = [];
    for (let i = 0; i < MAX_DICTATIONS; i++) held.push(await open(a));
    for (const h of held) {
      await vi.waitFor(() => expect(h.msgs[0]).toMatchObject({ type: 'error', code: 'bad-request' }));
      await vi.waitFor(() => expect(h.ws.readyState).toBeGreaterThanOrEqual(2));
    }
    const next = await open(a);
    next.ws.send(JSON.stringify({ type: 'start' }));
    await vi.waitFor(() => expect(next.msgs[0]).toEqual({ type: 'ready', model: 'large-v3-turbo' }));
  });

  it('the time limit finalizes: the last words arrive with done, and why it stopped', async () => {
    const w = fakeWhisper(() => '마지막 말');
    const a = await server(w, { maxMs: 400 });
    const c = await open(a);
    c.ws.send(JSON.stringify({ type: 'start' }));
    for (let i = 0; i < 3; i++) c.ws.send(tone(100, true));
    await vi.waitFor(() => expect(lastOf(c.msgs)?.type).toBe('done'), { timeout: 3000 });
    expect(c.msgs.find((m) => m.type === 'error')).toBeUndefined();
    expect(lastOf(c.msgs)).toEqual({
      type: 'done',
      final: '마지막 말',
      message: '받아쓰기는 한 번에 10분까지입니다 — 다시 누르면 이어서 받아씁니다',
    });
  });

  it('a Whisper that fails after ready: an error the browser shows, and the socket closes', async () => {
    const w = fakeWhisper(() => {
      throw new Error('A2T worker exited');
    });
    const a = await server(w);
    const c = await open(a);
    c.ws.send(JSON.stringify({ type: 'start' }));
    for (let i = 0; i < 8; i++) c.ws.send(tone(100, true));
    await vi.waitFor(() => expect(c.msgs.find((m) => m.type === 'error')).toMatchObject({ code: 'failed' }));
    expect(String(c.msgs.find((m) => m.type === 'error')?.message)).toContain('A2T worker exited');
    await vi.waitFor(() => expect(c.ws.readyState).toBeGreaterThanOrEqual(2));
    expect(c.msgs.find((m) => m.type === 'done')).toBeUndefined();
  });

  it('audio far faster than real time is refused', async () => {
    const a = await server(fakeWhisper());
    const c = await open(a);
    c.ws.send(JSON.stringify({ type: 'start' }));
    for (let i = 0; i < 60; i++) c.ws.send(tone(1000, true)); // a minute of audio at once
    await vi.waitFor(() => expect(lastOf(c.msgs)).toMatchObject({ type: 'error', code: 'bad-request' }));
    await vi.waitFor(() => expect(c.ws.readyState).toBeGreaterThanOrEqual(2));
  });

  it('a socket that goes away drops its queued transcriptions', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const calls: number[] = [];
    const w: DictationWhisper = {
      ...fakeWhisper(),
      transcribe: async (pcm) => {
        calls.push(pcm.length);
        await gate;
        return '말';
      },
    };
    const a = await server(w);
    const c = await open(a);
    c.ws.send(JSON.stringify({ type: 'start' }));
    // speech, a pause (closes a segment), speech, a pause: one transcription runs, more queue behind it
    for (let k = 0; k < 3; k++) {
      for (let i = 0; i < 6; i++) c.ws.send(tone(100, true));
      for (let i = 0; i < 9; i++) c.ws.send(tone(100, false));
    }
    await vi.waitFor(() => expect(calls.length).toBe(1));
    c.ws.terminate();
    await new Promise((r) => setTimeout(r, 50));
    release();
    await new Promise((r) => setTimeout(r, 100));
    expect(calls.length).toBe(1);
  });
});

describe('sameOrigin', () => {
  it('a page of this server, a forwarded host, a configured host, or no browser', () => {
    expect(sameOrigin({ host: 'a.example', origin: 'https://a.example' })).toBe(true);
    expect(sameOrigin({ host: 'localhost:33000', 'x-forwarded-host': 'a.example', origin: 'https://a.example' })).toBe(
      true,
    );
    expect(sameOrigin({ host: 'localhost:33000', origin: 'https://a.example' }, ['a.example'])).toBe(true);
    expect(sameOrigin({ host: 'a.example' })).toBe(true);
    expect(sameOrigin({ host: 'a.example', origin: 'https://b.example' })).toBe(false);
    expect(sameOrigin({ host: 'a.example', origin: 'not a url' })).toBe(false);
  });
});
