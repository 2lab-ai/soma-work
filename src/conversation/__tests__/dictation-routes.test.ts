/**
 * 서버 위스퍼 live dictation — the HTTP surface (epic #737, #739), on a real Fastify with @fastify/websocket.
 *
 *   R1  status: whether this server can take a dictation, with which model, or why not
 *   R2  a dictation: start → audio frames → words as they settle → stop → done
 *   R3  refused: not signed in, another site, no Whisper, too many at once, bad frames
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

async function server(whisper: DictationWhisper | null, opts: { signedIn?: boolean } = {}) {
  app = Fastify();
  await app.register(await import('@fastify/websocket'));
  const auth = vi.fn(async (_req: unknown, reply: { code: (n: number) => { send: (b: unknown) => void } }) => {
    if (opts.signedIn === false) reply.code(401).send({ error: 'Unauthorized' });
  });
  registerDictationRoutes(app, auth as never, () => whisper);
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
