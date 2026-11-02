/**
 * 브라우저 위스퍼 — Whisper in the page's own browser (epic #737, #740): DICTATION_BROWSER_JS and its worker, run as
 * shipped against fakes (transformers.js' pipeline faked).
 *
 *   B1  the worker: loads the model once (progress forwarded), runs the stream policy, finishes, aborts
 *   B2  the worker's policy is the server's own code (DictationStream's source), so segments settle the same
 *   B3  the page side: runtime and model per device, download progress, microphone → worker, stop → done, failures
 *   B4  ships byte for byte
 */

import { describe, expect, it, vi } from 'vitest';
import { DictationStream, dictationStreamSource } from '../../a2t/dictation-stream';
import { BROWSER_WHISPER_MODELS, DICTATION_BROWSER_JS, TRANSFORMERS_JS_URL } from '../dictation-browser-client';
import { DICTATION_PREF_JS } from '../dictation-pref';
import { DICTATION_SERVER_JS } from '../dictation-server-client';

type AnyFn = (...a: any[]) => any;
const lastOf = (xs: any[]): any => xs[xs.length - 1];
const flush = () => new Promise((r) => setTimeout(r, 0));

const page = new Function(
  `${DICTATION_PREF_JS}\n${DICTATION_SERVER_JS}\n${DICTATION_BROWSER_JS}\nreturn { DICTATION_BROWSER_WORKER_SRC, DICTATION_BROWSER_MODELS, dictationBrowserDevice, dictationBrowserDtype, dictationBrowserModel, dictationBrowserStart, reset: function () { _dictationBrowserWorker = null; _dictationBrowserLoaded = ''; } };`,
)() as Record<string, any>;

function voiced(ms: number): Int16Array {
  const n = Math.round((16000 * ms) / 1000);
  const a = new Int16Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / 16000) * 0.2 * 32767);
  return a;
}

/** The worker's source with its import replaced by a fake transformers.js. */
function runWorker(
  asr: (audio: Float32Array, o: unknown) => Promise<{ text: string }>,
  opts: { failLoad?: boolean } = {},
) {
  const posted: any[] = [];
  const scope: { onmessage: AnyFn | null; postMessage: AnyFn } = {
    onmessage: null,
    postMessage: (m: any) => posted.push(m),
  };
  const loads: any[] = [];
  const pipeline = vi.fn((task: string, model: string, o: any) => {
    loads.push({ task, model, device: o.device, dtype: o.dtype });
    o.progress_callback({ status: 'progress', file: 'encoder_model.onnx', loaded: 50, total: 100 });
    o.progress_callback({ status: 'initiate', file: 'x' });
    return opts.failLoad ? Promise.reject(new Error('404 model')) : Promise.resolve(asr);
  });
  const src = page.DICTATION_BROWSER_WORKER_SRC as string;
  const body = src.replace(/^import \{ pipeline, env \} from '[^']+';$/m, '');
  new Function('self', 'pipeline', 'env', body)(scope, pipeline, {});
  const send = (m: unknown) => scope.onmessage?.({ data: m });
  return { posted, send, loads, pipeline };
}

describe('B1 — the worker', () => {
  it('imports the pinned transformers.js and carries the stream policy', () => {
    expect(page.DICTATION_BROWSER_WORKER_SRC).toContain(`import { pipeline, env } from '${TRANSFORMERS_JS_URL}';`);
    expect(TRANSFORMERS_JS_URL).toMatch(/@huggingface\/transformers@\d+\.\d+\.\d+$/);
    expect(page.DICTATION_BROWSER_WORKER_SRC).toContain('var DictationStream = ');
  });

  it('loads once (progress forwarded), runs a dictation through the policy, finishes with done', async () => {
    const calls: Array<{ n: number; o: unknown }> = [];
    const w = runWorker(async (audio, o) => {
      calls.push({ n: audio.length, o });
      return { text: '대시보드 새 작업' };
    });
    w.send({ type: 'load', model: 'onnx-community/whisper-base', device: 'webgpu', dtype: { encoder_model: 'fp16' } });
    await flush();
    expect(w.loads).toEqual([
      {
        task: 'automatic-speech-recognition',
        model: 'onnx-community/whisper-base',
        device: 'webgpu',
        dtype: { encoder_model: 'fp16' },
      },
    ]);
    expect(w.posted).toEqual([
      { type: 'progress', file: 'encoder_model.onnx', loaded: 50, total: 100 },
      { type: 'loaded' },
    ]);
    w.send({ type: 'load', model: 'onnx-community/whisper-base', device: 'webgpu' });
    expect(w.pipeline).toHaveBeenCalledTimes(1);
    expect(lastOf(w.posted)).toEqual({ type: 'loaded' });
    w.send({ type: 'start', language: 'korean' });
    for (let i = 0; i < 7; i++) w.send({ type: 'pcm', data: voiced(100).buffer });
    await vi.waitFor(() => expect(w.posted.some((m) => m.type === 'text')).toBe(true));
    expect(calls[0].o).toEqual({ language: 'korean', task: 'transcribe' });
    // float32 in [-1, 1]
    w.send({ type: 'stop' });
    await vi.waitFor(() => expect(lastOf(w.posted)).toEqual({ type: 'done', final: '대시보드 새 작업' }));
  });

  it('a model that fails to load says so, and the next load tries again', async () => {
    const w = runWorker(async () => ({ text: '' }), { failLoad: true });
    w.send({ type: 'load', model: 'x', device: 'wasm' });
    await flush();
    expect(lastOf(w.posted)).toEqual({ type: 'error', message: '404 model' });
    w.send({ type: 'load', model: 'x', device: 'wasm' });
    expect(w.pipeline).toHaveBeenCalledTimes(2);
  });

  it('abort drops what a running dictation would still say', async () => {
    let release: AnyFn = () => {};
    const w = runWorker(() => new Promise((r) => (release = () => r({ text: '늦은 말' }))));
    w.send({ type: 'load', model: 'x', device: 'wasm' });
    await flush();
    w.send({ type: 'start' });
    for (let i = 0; i < 6; i++) w.send({ type: 'pcm', data: voiced(100).buffer });
    w.send({ type: 'abort' });
    release();
    await flush();
    await flush();
    expect(w.posted.filter((m) => m.type === 'text' || m.type === 'done')).toEqual([]);
  });
});

describe('B2 — the worker’s policy is the server’s own code', () => {
  it('the same answers settle into the same text', async () => {
    const Embedded = new Function(`${dictationStreamSource()}; return DictationStream;`)();
    const run = async (Cls: any) => {
      const answers = ['대시보드', '대시보드 새 작업', '대시보드 새 작업 화면에서.'];
      let i = 0;
      const texts: unknown[] = [];
      const s = new Cls({
        transcribe: async () => answers[Math.min(i++, answers.length - 1)],
        onText: (t: unknown) => texts.push(t),
      });
      for (let k = 0; k < 11; k++) {
        s.push(voiced(100));
        await vi.waitFor(() => !s.busy);
      }
      for (let k = 0; k < 10; k++) {
        s.push(new Int16Array(1600));
        await vi.waitFor(() => !s.busy);
      }
      await s.finish();
      return texts;
    };
    const server = await run(DictationStream);
    expect(server.length).toBeGreaterThan(1);
    expect(await run(Embedded)).toEqual(server);
  });
});

function env(opts: { gpu?: boolean; worker?: boolean; mic?: Error; stored?: string } = {}) {
  const workers: any[] = [];
  class FakeWorker {
    posted: any[] = [];
    terminated = 0;
    onmessage: AnyFn | null = null;
    onerror: AnyFn | null = null;
    constructor(
      public url: string,
      public o: unknown,
    ) {
      workers.push(this);
    }
    postMessage(m: unknown, transfer?: unknown[]) {
      this.posted.push({ m, transfer });
    }
    terminate() {
      this.terminated++;
    }
    reply(m: unknown) {
      this.onmessage?.({ data: m });
    }
  }
  const tracks = [
    {
      stopped: 0,
      stop() {
        this.stopped++;
      },
    },
  ];
  const nodes: any[] = [];
  class FakeNode {
    port = { onmessage: null as AnyFn | null };
    constructor() {
      nodes.push(this);
    }
    connect() {}
    disconnect() {}
  }
  const store: Record<string, string> = opts.stored ? { 'soma-dictation-browser-model': opts.stored } : {};
  const w = {
    navigator: {
      ...(opts.gpu ? { gpu: {} } : {}),
      mediaDevices: {
        getUserMedia: vi.fn(() => (opts.mic ? Promise.reject(opts.mic) : Promise.resolve({ getTracks: () => tracks }))),
      },
    },
    Worker: opts.worker === false ? undefined : FakeWorker,
    AudioContext: class {
      destination = {};
      audioWorklet = { addModule: async () => undefined };
      createMediaStreamSource() {
        return { connect() {} };
      }
      createGain() {
        return { gain: { value: 1 }, connect() {} };
      }
      resume() {}
      close() {}
    },
    AudioWorkletNode: FakeNode,
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    Blob: class {
      constructor(public parts: unknown[]) {}
    },
    localStorage: { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => (store[k] = v) },
  };
  return { w, workers, nodes, tracks };
}
function callbacks() {
  const got = {
    progress: [] as number[],
    ready: [] as string[],
    text: [] as string[][],
    errors: [] as string[][],
    done: [] as string[],
  };
  return {
    got,
    cb: {
      onProgress: (p: number) => got.progress.push(p),
      onReady: (l: string) => got.ready.push(l),
      onText: (f: string, i: string) => got.text.push([f, i]),
      onError: (c: string, m: string) => got.errors.push([c, m]),
      onDone: (f: string) => got.done.push(f),
    },
  };
}

describe('B3 — the page side', () => {
  it('runtime: WebGPU, WebAssembly, or none', () => {
    expect(page.dictationBrowserDevice({ Worker: () => {}, navigator: { gpu: {} } })).toBe('webgpu');
    expect(page.dictationBrowserDevice({ Worker: () => {}, navigator: {} })).toBe('wasm');
    expect(page.dictationBrowserDevice({ navigator: {} })).toBe('');
  });

  it('the model: the device’s choice, else 보통 on WebGPU and 작게 on WebAssembly; the precision per runtime', () => {
    const store = (v: string | null) => ({ getItem: () => v });
    expect(page.dictationBrowserModel(store(null), 'webgpu')).toBe('small');
    expect(page.dictationBrowserModel(store(null), 'wasm')).toBe('base');
    expect(page.dictationBrowserModel(store('turbo'), 'wasm')).toBe('turbo');
    expect(page.dictationBrowserModel(store('xl'), 'webgpu')).toBe('small');
    expect(page.dictationBrowserDtype('small', 'webgpu')).toEqual({
      encoder_model: 'fp16',
      decoder_model_merged: 'q4',
    });
    expect(page.dictationBrowserDtype('turbo', 'webgpu')).toEqual({ encoder_model: 'q4', decoder_model_merged: 'q4' });
    expect(page.dictationBrowserDtype('base', 'wasm')).toEqual({ encoder_model: 'q8', decoder_model_merged: 'q8' });
    expect(Object.keys(page.DICTATION_BROWSER_MODELS)).toEqual(Object.keys(BROWSER_WHISPER_MODELS));
  });

  it('download progress, then the microphone streams to the worker, then stop → done', async () => {
    page.reset();
    const e = env({ gpu: true });
    const { got, cb } = callbacks();
    const c = page.dictationBrowserStart(cb, e.w);
    const wk = e.workers[0];
    expect(wk.o).toEqual({ type: 'module' });
    expect(wk.posted[0].m).toEqual({
      type: 'load',
      model: 'onnx-community/whisper-small',
      device: 'webgpu',
      dtype: { encoder_model: 'fp16', decoder_model_merged: 'q4' },
    });
    wk.reply({ type: 'progress', file: 'a', loaded: 30, total: 100 });
    wk.reply({ type: 'progress', file: 'b', loaded: 0, total: 300 });
    expect(got.progress).toEqual([30, 7]);
    wk.reply({ type: 'loaded' });
    await flush();
    await flush();
    expect(e.w.navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(lastOf(wk.posted).m).toEqual({ type: 'start', language: 'korean' });
    expect(got.ready).toEqual(['whisper-small, WebGPU']);
    const chunk = new Int16Array(1600).buffer;
    e.nodes[0].port.onmessage({ data: chunk });
    expect(lastOf(wk.posted)).toEqual({ m: { type: 'pcm', data: chunk }, transfer: [chunk] });
    wk.reply({ type: 'text', final: '대시보드', interim: '새 작업' });
    expect(got.text).toEqual([['대시보드', '새 작업']]);
    c.stop();
    expect(e.tracks[0].stopped).toBe(1);
    expect(lastOf(wk.posted).m).toEqual({ type: 'stop' });
    wk.reply({ type: 'done', final: '대시보드 새 작업' });
    expect(got.done).toEqual(['대시보드 새 작업']);
    // the model stays loaded for the next press: same worker, no new download
    const again = page.dictationBrowserStart(callbacks().cb, e.w);
    expect(e.workers.length).toBe(1);
    again.abort();
  });

  it('another model chosen: a fresh worker', () => {
    page.reset();
    const e = env({ gpu: true });
    page.dictationBrowserStart(callbacks().cb, e.w).abort();
    const e2 = env({ gpu: true, stored: 'base' });
    page.dictationBrowserStart(callbacks().cb, e2.w);
    expect(e2.workers.length).toBe(1);
    expect(e2.workers[0].posted[0].m.model).toBe('onnx-community/whisper-base');
  });

  it('a model that cannot load: an error to act on, and the next press starts a fresh worker', async () => {
    page.reset();
    const e = env({ gpu: true });
    const { got, cb } = callbacks();
    page.dictationBrowserStart(cb, e.w);
    e.workers[0].reply({ type: 'error', message: 'out of memory' });
    expect(got.errors).toEqual([['model', '브라우저 위스퍼 모델을 불러오지 못했습니다 — out of memory']]);
    expect(e.workers[0].terminated).toBe(1);
    page.dictationBrowserStart(callbacks().cb, e.w);
    expect(e.workers.length).toBe(2);
  });

  it('a refused microphone, or no Worker at all', async () => {
    page.reset();
    const e = env({ gpu: true, mic: Object.assign(new Error('x'), { name: 'NotAllowedError' }) });
    const { got, cb } = callbacks();
    page.dictationBrowserStart(cb, e.w);
    e.workers[0].reply({ type: 'loaded' });
    await flush();
    await flush();
    expect(got.errors[0][0]).toBe('not-allowed');
    const none = callbacks();
    page.dictationBrowserStart(none.cb, env({ worker: false }).w);
    await flush();
    expect(none.got.errors[0][0]).toBe('unsupported');
  });

  it('abort before the model is in: nothing is reported later', async () => {
    page.reset();
    const e = env();
    const { got, cb } = callbacks();
    const c = page.dictationBrowserStart(cb, e.w);
    c.abort();
    e.workers[0].reply?.({ type: 'loaded' });
    await flush();
    expect(e.w.navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(got.errors).toEqual([]);
  });
});

describe('B4 — ships byte for byte', () => {
  it('no template syntax in the shipped text', () => {
    expect(DICTATION_BROWSER_JS).not.toContain('`');
    expect(DICTATION_BROWSER_JS).not.toContain('${');
  });
});
