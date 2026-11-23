import { EventEmitter } from 'node:events';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerDictationRoutes } from '../../conversation/dictation-routes';
import {
  buildDeepgramUrl,
  createDeepgramDictationBackend,
  createOpenAiDictationBackend,
  type DictationBackend,
  encodePcm16Wav,
  resolveDictationBackend,
} from '../dictation-cloud';
import {
  buildWhisperPrompt,
  DEFAULT_DICTATION_KEYTERMS,
  mergeDictationKeyterms,
  normalizeKeyterms,
} from '../dictation-keyterms';
import { DictationStream } from '../dictation-stream';

class FakeUpstreamWs extends EventEmitter {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 0;
  sent: Array<string | Buffer> = [];
  closed = false;
  constructor(
    public url: string,
    public opts: { headers: Record<string, string> },
  ) {
    super();
  }
  send(data: string | Buffer) {
    this.sent.push(data);
  }
  close(code = 1000, reason = '') {
    this.closed = true;
    this.readyState = 3;
    this.emit('close', code, Buffer.from(reason));
  }
  open() {
    this.readyState = 1;
    this.emit('open');
  }
  recv(obj: object) {
    this.emit('message', Buffer.from(JSON.stringify(obj)));
  }
}

function tonePcm(ms: number): Int16Array {
  const n = Math.round((16000 * ms) / 1000);
  const a = new Int16Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / 16000) * 0.2 * 32767);
  return a;
}

describe('dictation-keyterms', () => {
  it('deduplicates, strips commas/control chars, and respects maxChars', () => {
    const out = normalizeKeyterms(['MCP', 'mcp', 'TypeScript,JS', 'a\nb', 'OAuth'], { maxChars: 30 });
    expect(out).toEqual(['MCP', 'TypeScript JS', 'a b', 'OAuth']);
  });

  it('merges caller terms ahead of defaults without duplicates', () => {
    const merged = mergeDictationKeyterms(['my-repo', 'TypeScript'], ['CustomTerm'], DEFAULT_DICTATION_KEYTERMS);
    expect(merged[0]).toBe('my-repo');
    expect(merged[1]).toBe('TypeScript');
    expect(merged[2]).toBe('CustomTerm');
    expect(merged.filter((t) => t.toLowerCase() === 'typescript')).toHaveLength(1);
  });

  it('buildWhisperPrompt combines keyterms with recent settled tail within budget', () => {
    expect(buildWhisperPrompt(['MCP', 'TypeScript'], '')).toBe('MCP, TypeScript');
    const combined = buildWhisperPrompt(['MCP', 'TypeScript', 'WebSocket'], '이 서버의 웹소켓을 확인해 주세요', 80);
    expect(combined).toContain('MCP');
    expect(combined).toContain('이 서버의 웹소켓을 확인해 주세요');
    expect(combined.length).toBeLessThanOrEqual(80);
  });
});

describe('DictationStream — two-pass & keyterms', () => {
  it('passes keyterms on the very first call and marks final=false on step, final=true on close/finish', async () => {
    const calls: Array<{ prompt: string; final: boolean | undefined }> = [];
    const stream = new DictationStream({
      keyterms: ['soma-work', 'TypeScript', 'MCP'],
      transcribe: async (_pcm, prompt, opts) => {
        calls.push({ prompt, final: opts?.final });
        return 'soma-work MCP 확인';
      },
      onText: () => {},
    });
    for (let t = 0; t < 700; t += 100) {
      stream.push(tonePcm(100));
      await vi.waitFor(() => !stream.busy, { timeout: 200 });
    }
    const done = await stream.finish();
    expect(done.final).toBe('soma-work MCP 확인');
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0].prompt).toContain('soma-work');
    expect(calls[0].final).toBe(false);
    expect(calls[calls.length - 1].final).toBe(true);
  });
});

describe('dictation-cloud', () => {
  it('encodePcm16Wav produces a valid 16kHz mono RIFF WAV buffer', () => {
    const pcm = new Int16Array([100, -200, 300, -400]);
    const wav = encodePcm16Wav(pcm, 16000);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(40)).toBe(8);
    expect(wav.readInt16LE(44)).toBe(100);
    expect(wav.readInt16LE(46)).toBe(-200);
  });

  it('buildDeepgramUrl uses Nova-3 multi language and keyterm query parameters', () => {
    const url = new URL(
      buildDeepgramUrl({ model: 'nova-3', language: 'ko', keyterms: ['MCP', 'TypeScript', '한글제외'] }),
    );
    expect(url.searchParams.get('model')).toBe('nova-3');
    expect(url.searchParams.get('language')).toBe('multi');
    expect(url.searchParams.get('endpointing')).toBe('300');
    expect(url.searchParams.getAll('keyterm')).toEqual(['MCP', 'TypeScript']);
  });

  it('Deepgram streaming backend streams PCM, handles interim/final/CloseStream, and resolves done', async () => {
    const sockets: FakeUpstreamWs[] = [];
    const backend = createDeepgramDictationBackend({
      apiKey: 'dg-test-key',
      model: 'nova-3',
      keyterms: ['soma-work'],
      wsFactory: (url, opts) => {
        const ws = new FakeUpstreamWs(url, opts);
        sockets.push(ws);
        return ws as never;
      },
    });
    expect(backend.ready()).toBe(true);
    expect(backend.model()).toBe('deepgram/nova-3');

    const events: string[] = [];
    let finalOut = '';
    const session = backend.createStreamingSession!(
      { language: 'ko', keyterms: ['AU05'] },
      {
        onReady: (m) => events.push(`ready:${m}`),
        onText: (t) => events.push(`text:${t.final}|${t.interim}`),
        onDone: (f) => {
          finalOut = f;
          events.push(`done:${f}`);
        },
        onError: (e) => events.push(`err:${e}`),
      },
    );
    const ws = sockets[0];
    expect(ws.opts.headers.Authorization).toBe('Token dg-test-key');
    expect(ws.url).toContain('keyterm=AU05');
    expect(ws.url).toContain('keyterm=soma-work');

    // Frame sent before open is buffered and flushed on open
    session.push(new Int16Array([1, 2, 3]));
    ws.open();
    expect(events[0]).toBe('ready:deepgram/nova-3');
    expect(Buffer.isBuffer(ws.sent[0])).toBe(true);

    ws.recv({ type: 'Results', is_final: false, channel: { alternatives: [{ transcript: '소마' }] } });
    ws.recv({ type: 'Results', is_final: true, channel: { alternatives: [{ transcript: 'soma-work 테스트' }] } });
    const finishing = session.finish();
    expect(ws.sent[ws.sent.length - 1]).toBe(JSON.stringify({ type: 'CloseStream' }));
    // Trailing utterance after CloseStream is preserved until Metadata arrives
    ws.recv({ type: 'Results', is_final: true, channel: { alternatives: [{ transcript: '마무리' }] } });
    ws.recv({ type: 'Metadata' });
    await finishing;
    expect(finalOut).toBe('soma-work 테스트 마무리');
    expect(events).toContain('text:|소마');
    expect(events).toContain('text:soma-work 테스트|');
  });

  it('Deepgram closes upstream WS on Error frame without leaking socket', () => {
    const sockets: FakeUpstreamWs[] = [];
    const backend = createDeepgramDictationBackend({
      apiKey: 'dg-test-key',
      wsFactory: (url, opts) => {
        const ws = new FakeUpstreamWs(url, opts);
        sockets.push(ws);
        return ws as never;
      },
    });
    const errors: string[] = [];
    backend.createStreamingSession!(
      { language: 'ko', keyterms: [] },
      { onReady: () => {}, onText: () => {}, onDone: () => {}, onError: (e) => errors.push(e) },
    );
    const ws = sockets[0];
    ws.open();
    ws.recv({ type: 'Error', description: 'bad auth sk-secret-fragment' });
    expect(ws.closed).toBe(true);
    expect(errors[0]).not.toContain('sk-secret-fragment');
  });

  it('OpenAI backend posts multipart WAV with model/language/prompt and sanitizes upstream error body', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const form = init?.body as FormData;
      expect(form.get('model')).toBe('gpt-4o-transcribe');
      expect(form.get('language')).toBe('ko');
      expect(form.get('prompt')).toBe('MCP, TypeScript');
      return new Response(JSON.stringify({ text: 'MCP 서버 확인' }), { status: 200 });
    });
    const backend = createOpenAiDictationBackend({
      apiKey: 'sk-test',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(backend.ready()).toBe(true);
    expect(backend.model()).toBe('openai/gpt-4o-transcribe');
    const text = await backend.transcribe(tonePcm(100), { language: 'ko', prompt: 'MCP, TypeScript' });
    expect(text).toBe('MCP 서버 확인');

    const errBackend = createOpenAiDictationBackend({
      apiKey: 'sk-test',
      fetchImpl: (async () =>
        new Response('Incorrect API key provided: sk-leaked-1234', { status: 401 })) as unknown as typeof fetch,
    });
    await expect(errBackend.transcribe(tonePcm(100), { language: 'ko', prompt: '' })).rejects.toThrow('HTTP 401');
    await expect(errBackend.transcribe(tonePcm(100), { language: 'ko', prompt: '' })).rejects.not.toThrow('sk-leaked');
  });

  it('resolveDictationBackend keeps audio local under default auto and prioritizes deepgram > local > openai under auto-cloud', () => {
    const localReady: DictationBackend = {
      ready: () => true,
      model: () => 'large-v3-turbo',
      why: () => '',
      transcribe: async () => '',
    };
    const localDown: DictationBackend = {
      ready: () => false,
      model: () => '',
      why: () => 'no whisper',
      transcribe: async () => '',
    };

    // Default 'auto' never silently uploads audio to cloud even when API keys exist in env
    const rDefault = resolveDictationBackend({
      local: () => localReady,
      env: { DEEPGRAM_API_KEY: 'dg', OPENAI_API_KEY: 'oa' },
    });
    expect(rDefault()?.model()).toBe('large-v3-turbo');

    // Explicit opt-in 'auto-cloud': deepgram > local > openai
    const r1 = resolveDictationBackend({
      config: { provider: 'auto-cloud' },
      local: () => localReady,
      env: { DEEPGRAM_API_KEY: 'dg', OPENAI_API_KEY: 'oa' },
    });
    expect(r1()?.model()).toBe('deepgram/nova-3');

    const r2 = resolveDictationBackend({
      config: { provider: 'auto-cloud' },
      local: () => localReady,
      env: { OPENAI_API_KEY: 'oa' },
    });
    expect(r2()?.model()).toBe('large-v3-turbo');

    const r3 = resolveDictationBackend({
      config: { provider: 'auto-cloud' },
      local: () => localDown,
      env: { OPENAI_API_KEY: 'oa' },
    });
    expect(r3()?.model()).toBe('openai/gpt-4o-transcribe');

    // a2tEnabled: false disables dictation even with cloud keys
    const rOff = resolveDictationBackend({
      config: { provider: 'deepgram' },
      a2tEnabled: false,
      local: () => localReady,
      env: { DEEPGRAM_API_KEY: 'dg' },
    });
    expect(rOff()?.ready()).toBe(false);
  });
});

describe('dictation-routes — native streaming session & client keyterms', () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it('routes binary PCM to native streaming backend and finishes cleanly on stop', async () => {
    let seenKeyterms: readonly string[] = [];
    let pushed = 0;
    const backend: DictationBackend = {
      ready: () => true,
      model: () => 'deepgram/nova-3',
      why: () => '',
      transcribe: async () => '',
      createStreamingSession: ({ keyterms }, cb) => {
        seenKeyterms = keyterms;
        queueMicrotask(() => cb.onReady('deepgram/nova-3'));
        return {
          backlog: 0,
          push: (pcm) => {
            pushed += pcm.length;
            cb.onText({ final: 'AU05 받아쓰기', interim: '' });
          },
          finish: async () => {
            cb.onDone('AU05 받아쓰기 완료');
          },
          cancel: () => {},
        };
      },
    };

    app = Fastify();
    await app.register(await import('@fastify/websocket'));
    registerDictationRoutes(
      app,
      async () => {},
      () => backend,
    );
    await app.ready();

    const msgs: Array<Record<string, unknown>> = [];
    const ws = await (app as unknown as { injectWS: Function }).injectWS(
      '/ws/dictation',
      { headers: { host: 'agents.example', origin: 'https://agents.example' } },
      { onInit: (s: any) => s.on('message', (d: Buffer) => msgs.push(JSON.parse(String(d)))) },
    );
    ws.send(JSON.stringify({ type: 'start', lang: 'ko-KR', keyterms: ['open-au05'] }));
    await vi.waitFor(() => expect(msgs[0]).toEqual({ type: 'ready', model: 'deepgram/nova-3' }));
    ws.send(Buffer.alloc(3200));
    await vi.waitFor(() => expect(msgs.some((m) => m.type === 'text')).toBe(true));
    ws.send(JSON.stringify({ type: 'stop' }));
    await vi.waitFor(() => expect(msgs[msgs.length - 1]).toEqual({ type: 'done', final: 'AU05 받아쓰기 완료' }));
    expect(pushed).toBe(1600);
    expect(seenKeyterms).toContain('open-au05');
    expect(seenKeyterms).toContain('TypeScript');
  });
});
