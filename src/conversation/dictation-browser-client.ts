/**
 * 브라우저 위스퍼 — Whisper in the page's own browser (epic #737, #740). The speech never leaves the device: a Web
 * Worker runs Whisper (transformers.js, ONNX — on WebGPU when the browser has it, else WebAssembly) and the same
 * stream policy as the server (DictationStream's own source, dictation-stream.ts), fed by the same 16 kHz worklet as
 * the server's Whisper (dictation-server-client.ts). The model is downloaded once and kept in the browser's cache.
 *
 * Client script, shipped byte for byte: no backticks and no `${…}` in the shipped text — the worker's source goes in
 * as one JSON string.
 */

import { dictationStreamSource } from '../a2t/dictation-stream';

/** transformers.js, pinned. */
export const TRANSFORMERS_JS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2';

/** The models a device can choose — id, what it is called, and the download on WebGPU / on WebAssembly. */
export const BROWSER_WHISPER_MODELS = {
  base: { id: 'onnx-community/whisper-base', label: '작게 — whisper-base', webgpu: 165, wasm: 77 },
  small: { id: 'onnx-community/whisper-small', label: '보통 — whisper-small', webgpu: 410, wasm: 249 },
  turbo: {
    id: 'onnx-community/whisper-large-v3-turbo',
    label: '크게 — whisper-large-v3-turbo',
    webgpu: 759,
    wasm: 1085,
  },
} as const;

/** The worker: load a model once, then one dictation at a time through the stream policy. Every message about a
 * dictation carries its id, so the page can tell a previous dictation's late words from the current one's. */
function workerSource(): string {
  return [
    `import { pipeline, env } from '${TRANSFORMERS_JS_URL}';`,
    'env.allowLocalModels = false;',
    dictationStreamSource(),
    `var asr = null;
var loading = null;
var stream = null;
var finishing = null;
var current = null;
function float32(pcm) {
  var f = new Float32Array(pcm.length);
  for (var i = 0; i < pcm.length; i++) f[i] = pcm[i] / 32768;
  return f;
}
// One model, one dictation at a time: the one let go stops using it (queued transcriptions skipped).
function drop() {
  if (stream) stream.cancel();
  if (finishing) finishing.cancel();
  stream = null;
  finishing = null;
  current = null;
}
self.onmessage = function (e) {
  var m = e.data || {};
  if (m.type === 'load') {
    if (asr) { self.postMessage({ type: 'loaded' }); return; }
    if (loading) return;
    loading = pipeline('automatic-speech-recognition', m.model, {
      device: m.device,
      dtype: m.dtype,
      progress_callback: function (p) {
        if (p && p.status === 'progress') self.postMessage({ type: 'progress', file: p.file, loaded: p.loaded || 0, total: p.total || 0 });
      },
    }).then(function (p) {
      asr = p;
      self.postMessage({ type: 'loaded' });
    }, function (err) {
      loading = null;
      self.postMessage({ type: 'error', message: String((err && err.message) || err) });
    });
    return;
  }
  if (m.type === 'start') {
    drop();
    var id = m.id;
    current = id;
    stream = new DictationStream({
      transcribe: function (pcm) {
        return asr(float32(pcm), { language: m.language || 'korean', task: 'transcribe' }).then(function (out) {
          return (out && out.text) || '';
        });
      },
      onText: function (t) {
        if (current === id) self.postMessage({ type: 'text', id: id, final: t.final, interim: t.interim });
      },
      // Inference failed (a lost GPU, out of memory): this dictation ends and says so.
      onError: function (message) {
        if (current !== id) return;
        drop();
        self.postMessage({ type: 'failed', id: id, message: message });
      },
    });
    return;
  }
  if (m.type === 'pcm' && stream) {
    stream.push(new Int16Array(m.data));
    return;
  }
  if (m.type === 'stop' && stream && m.id === current) {
    var s = stream;
    var sid = current;
    stream = null;
    finishing = s;
    s.finish().then(function (out) {
      if (current === sid) {
        current = null;
        finishing = null;
        self.postMessage({ type: 'done', id: sid, final: out.final });
      }
    });
    return;
  }
  if (m.type === 'abort' && m.id === current) drop();
};`,
  ].join('\n');
}

export const DICTATION_BROWSER_JS = String.raw`
// The worker's source (dictation-browser-client.ts) and the models (BROWSER_WHISPER_MODELS).
var DICTATION_BROWSER_WORKER_SRC = ${JSON.stringify(workerSource())};
var DICTATION_BROWSER_MODELS = ${JSON.stringify(BROWSER_WHISPER_MODELS)};
// The worker kept between presses, the model and runtime it holds ('small@webgpu'), and its source's blob URL.
var _dictationBrowserWorker = null;
var _dictationBrowserLoaded = '';
var _dictationBrowserUrl = '';
// WebGPU failed to load a model on this page: WebAssembly from then on.
var _dictationBrowserNoGpu = false;
var _dictationBrowserSeq = 0;

// What this browser offers to run a model on: 'webgpu', 'wasm', or '' (no Worker or WebAssembly — it cannot).
function dictationBrowserDevice(w) {
  if (!w || !w.Worker || typeof WebAssembly === 'undefined') return '';
  return w.navigator && w.navigator.gpu ? 'webgpu' : 'wasm';
}

// What it really runs on: WebGPU only with an adapter (and whether that does half precision), else WebAssembly.
// Resolves { device, f16 }.
async function dictationBrowserRuntime(w) {
  var d = dictationBrowserDevice(w);
  if (!d) return { device: '', f16: false };
  var gpu = w.navigator && w.navigator.gpu;
  if (d !== 'webgpu' || _dictationBrowserNoGpu || !gpu || typeof gpu.requestAdapter !== 'function') return { device: 'wasm', f16: false };
  try {
    var a = await gpu.requestAdapter();
    if (!a) return { device: 'wasm', f16: false };
    return { device: 'webgpu', f16: !!(a.features && typeof a.features.has === 'function' && a.features.has('shader-f16')) };
  } catch (e) {
    return { device: 'wasm', f16: false };
  }
}

// The precision per runtime: on WebGPU a half-size encoder where the GPU does half precision (full size where it
// does not; 4-bit for the large model) and a 4-bit decoder; 8-bit on WebAssembly.
function dictationBrowserDtype(model, device, f16) {
  if (device === 'webgpu') return { encoder_model: model === 'turbo' ? 'q4' : f16 === false ? 'fp32' : 'fp16', decoder_model_merged: 'q4' };
  return { encoder_model: 'q8', decoder_model_merged: 'q8' };
}

// The model this device uses: its choice, else 보통 on WebGPU and 작게 on WebAssembly.
function dictationBrowserModel(store, device) {
  var v = typeof dictationBrowserModelChoice === 'function' ? dictationBrowserModelChoice(store) : '';
  return DICTATION_BROWSER_MODELS[v] ? v : device === 'webgpu' ? 'small' : 'base';
}

// Let go of the kept worker (it failed, or another model is wanted): the next press starts a fresh one.
function dictationBrowserDrop(w) {
  var old = _dictationBrowserWorker;
  var url = _dictationBrowserUrl;
  _dictationBrowserWorker = null;
  _dictationBrowserLoaded = '';
  _dictationBrowserUrl = '';
  if (old) try { old.onmessage = null; old.onerror = null; old.terminate(); } catch (e) {}
  if (url && w && w.URL) try { w.URL.revokeObjectURL(url); } catch (e) {}
}

// One dictation through Whisper in this browser. cb: onProgress(percent) · onReady(label) · onText(final, interim) ·
// onError(code, message) · onDone(final). Returns { stop(), abort() }.
// env (tests): { navigator, Worker, AudioContext, AudioWorkletNode, URL, Blob, localStorage }.
function dictationBrowserStart(cb, env) {
  var w = env || window;
  var id = ++_dictationBrowserSeq;
  var c = { ended: false, ready: false, stopping: false, stream: null, ctx: null, node: null, url: '', worker: null, retried: false };
  function release() {
    if (c.stream) try { c.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    if (c.node) try { c.node.port.onmessage = null; c.node.disconnect(); } catch (e) {}
    if (c.ctx) try { c.ctx.close(); } catch (e) {}
    if (c.url) try { w.URL.revokeObjectURL(c.url); } catch (e) {}
    c.stream = null;
    c.node = null;
    c.ctx = null;
  }
  function end(kind, a, b) {
    if (c.ended) return;
    c.ended = true;
    release();
    if (c.worker) {
      if (c.worker.onmessage === c.onmessage) c.worker.onmessage = null;
      if (kind !== 'done') try { c.worker.postMessage({ type: 'abort', id: id }); } catch (e) {}
    }
    if (kind === 'done') cb.onDone && cb.onDone(a);
    else cb.onError && cb.onError(a, b);
  }
  function later(code, message) {
    setTimeout(function () { end('error', code, message); }, 0);
    return { stop: function () {}, abort: function () { c.ended = true; } };
  }
  if (!dictationBrowserDevice(w)) return later('unsupported', '이 브라우저는 브라우저 위스퍼를 쓸 수 없습니다 (Web Worker·WebAssembly 미지원)');
  var nav = w.navigator;
  if (!nav || !nav.mediaDevices || typeof nav.mediaDevices.getUserMedia !== 'function' || !w.AudioContext) {
    return later('unsupported', '이 브라우저는 마이크 스트리밍을 지원하지 않습니다');
  }
  var store = null;
  try { store = w.localStorage || null; } catch (e) { store = null; }
  dictationBrowserRuntime(w).then(function (rt) {
    if (!c.ended) boot(rt.device, rt.f16);
  });
  function boot(device, f16) {
    var model = dictationBrowserModel(store, device);
    var info = DICTATION_BROWSER_MODELS[model];
    var label = info.label.split(' — ')[1] + ', ' + (device === 'webgpu' ? 'WebGPU' : 'WebAssembly');
    var key = model + '@' + device;
    try {
      if (!_dictationBrowserWorker || _dictationBrowserLoaded !== key) {
        dictationBrowserDrop(w);
        var url = w.URL.createObjectURL(new w.Blob([DICTATION_BROWSER_WORKER_SRC], { type: 'text/javascript' }));
        _dictationBrowserUrl = url;
        _dictationBrowserWorker = new w.Worker(url, { type: 'module' });
        _dictationBrowserLoaded = key;
      }
    } catch (e) {
      dictationBrowserDrop(w);
      return end('error', 'unsupported', '브라우저 위스퍼를 시작하지 못했습니다 — 이 브라우저가 Worker를 만들지 못했습니다');
    }
    var worker = _dictationBrowserWorker;
    c.worker = worker;
    var files = {};
    c.onmessage = function (e) {
      var m = e.data || {};
      // A previous dictation's late words (posted before it was let go) are not this one's.
      if (m.id !== undefined && m.id !== id) return;
      if (m.type === 'progress') {
        files[m.file] = { loaded: m.loaded, total: m.total };
        var got = 0;
        var all = 0;
        for (var k in files) { got += files[k].loaded; all += files[k].total; }
        if (all) cb.onProgress && cb.onProgress(Math.min(99, Math.floor((got / all) * 100)));
      } else if (m.type === 'loaded') {
        openMic(label);
      } else if (m.type === 'text') {
        cb.onText && cb.onText(String(m.final || ''), String(m.interim || ''));
      } else if (m.type === 'done') {
        cb.onText && cb.onText(String(m.final || ''), '');
        end('done', String(m.final || ''));
      } else if (m.type === 'failed') {
        dictationBrowserDrop(w);
        end('error', 'failed', '브라우저 위스퍼가 받아쓰지 못했습니다 — ' + (m.message || '알 수 없는 오류'));
      } else if (m.type === 'error') {
        dictationBrowserDrop(w);
        // WebGPU that cannot run the model (no adapter after all, a precision it lacks): once more on WebAssembly.
        if (device === 'webgpu' && !c.retried) {
          c.retried = true;
          _dictationBrowserNoGpu = true;
          return boot('wasm', false);
        }
        end('error', 'model', '브라우저 위스퍼 모델을 불러오지 못했습니다 — ' + (m.message || '알 수 없는 오류'));
      }
    };
    worker.onmessage = c.onmessage;
    worker.onerror = function () {
      dictationBrowserDrop(w);
      end('error', 'model', '브라우저 위스퍼를 시작하지 못했습니다');
    };
    worker.postMessage({ type: 'load', model: info.id, device: device, dtype: dictationBrowserDtype(model, device, f16) });
  }
  function openMic(label) {
    if (c.ended || c.stream) return;
    var worker = c.worker;
    nav.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }).then(
      function (stream) {
        if (c.ended) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
        c.stream = stream;
        var ctx = new w.AudioContext();
        c.ctx = ctx;
        if (!ctx.audioWorklet || !w.AudioWorkletNode) return end('error', 'unsupported', '이 브라우저는 브라우저 위스퍼를 쓸 수 없습니다 (AudioWorklet 미지원)');
        c.url = w.URL.createObjectURL(new w.Blob([DICTATION_WORKLET_SRC], { type: 'application/javascript' }));
        return ctx.audioWorklet.addModule(c.url).then(function () {
          if (c.ended) return;
          var node = new w.AudioWorkletNode(ctx, 'soma-pcm16', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
          c.node = node;
          ctx.createMediaStreamSource(stream).connect(node);
          var mute = ctx.createGain();
          mute.gain.value = 0;
          node.connect(mute);
          mute.connect(ctx.destination);
          if (ctx.resume) ctx.resume();
          worker.postMessage({ type: 'start', id: id, language: 'korean' });
          node.port.onmessage = function (ev) {
            if (!c.stopping && !c.ended) worker.postMessage({ type: 'pcm', data: ev.data }, [ev.data]);
          };
          c.ready = true;
          cb.onReady && cb.onReady(label);
        });
      },
      function (e) {
        var why = dictationMicError(e);
        end('error', why.code, why.message);
      }
    ).then(null, function () {
      end('error', 'unsupported', '브라우저 위스퍼를 시작하지 못했습니다');
    });
  }
  return {
    // Finish: no more audio; what the worklet still holds goes to the worker, then stop — it finalizes what it heard
    // and answers done.
    stop: function () {
      if (c.ended || c.stopping) return;
      c.stopping = true;
      if (c.stream) try { c.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
      var worker = c.worker;
      if (!c.ready || !worker) return end('done', '');
      var sent = false;
      function send() {
        if (sent || c.ended) return;
        sent = true;
        worker.postMessage({ type: 'stop', id: id });
      }
      var node = c.node;
      if (!node) return send();
      node.port.onmessage = function (ev) {
        if (typeof ev.data === 'string') {
          if (ev.data === 'flushed') send();
        } else if (!sent && !c.ended) worker.postMessage({ type: 'pcm', data: ev.data }, [ev.data]);
      };
      try { node.port.postMessage('flush'); } catch (err) { return send(); }
      setTimeout(send, 300);
    },
    // Drop everything now (the loaded model stays for the next press).
    abort: function () {
      if (c.ended) return;
      c.stopping = true;
      c.ended = true;
      release();
      if (c.worker) {
        if (c.worker.onmessage === c.onmessage) c.worker.onmessage = null;
        try { c.worker.postMessage({ type: 'abort', id: id }); } catch (e) {}
      }
    },
  };
}
`;
