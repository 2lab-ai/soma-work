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

/** The worker: load a model once, then one dictation at a time through the stream policy. */
function workerSource(): string {
  return [
    `import { pipeline, env } from '${TRANSFORMERS_JS_URL}';`,
    'env.allowLocalModels = false;',
    dictationStreamSource(),
    `var asr = null;
var loading = null;
var stream = null;
var generation = 0;
function float32(pcm) {
  var f = new Float32Array(pcm.length);
  for (var i = 0; i < pcm.length; i++) f[i] = pcm[i] / 32768;
  return f;
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
    var gen = ++generation;
    stream = new DictationStream({
      transcribe: function (pcm) {
        return asr(float32(pcm), { language: m.language || 'korean', task: 'transcribe' }).then(function (out) {
          return (out && out.text) || '';
        });
      },
      onText: function (t) {
        if (gen === generation) self.postMessage({ type: 'text', final: t.final, interim: t.interim });
      },
      onError: function (message) {
        self.postMessage({ type: 'warn', message: message });
      },
    });
    return;
  }
  if (m.type === 'pcm' && stream) {
    stream.push(new Int16Array(m.data));
    return;
  }
  if (m.type === 'stop' && stream) {
    var s = stream;
    var g = generation;
    stream = null;
    s.finish().then(function (out) {
      if (g === generation) self.postMessage({ type: 'done', final: out.final });
    });
    return;
  }
  if (m.type === 'abort') {
    generation++;
    stream = null;
  }
};`,
  ].join('\n');
}

export const DICTATION_BROWSER_JS = String.raw`
// The worker's source (dictation-browser-client.ts) and the models (BROWSER_WHISPER_MODELS).
var DICTATION_BROWSER_WORKER_SRC = ${JSON.stringify(workerSource())};
var DICTATION_BROWSER_MODELS = ${JSON.stringify(BROWSER_WHISPER_MODELS)};
var _dictationBrowserWorker = null;
var _dictationBrowserLoaded = '';

// What this browser runs a model on: 'webgpu', 'wasm', or '' (no Worker or WebAssembly — it cannot).
function dictationBrowserDevice(w) {
  if (!w || !w.Worker || typeof WebAssembly === 'undefined') return '';
  return w.navigator && w.navigator.gpu ? 'webgpu' : 'wasm';
}

// The precision per device: half-size encoder and 4-bit decoder on WebGPU (4-bit encoder for the large model),
// 8-bit on WebAssembly.
function dictationBrowserDtype(model, device) {
  if (device === 'webgpu') return { encoder_model: model === 'turbo' ? 'q4' : 'fp16', decoder_model_merged: 'q4' };
  return { encoder_model: 'q8', decoder_model_merged: 'q8' };
}

// The model this device uses: its choice, else 보통 on WebGPU and 작게 on WebAssembly.
function dictationBrowserModel(store, device) {
  var v = typeof dictationBrowserModelChoice === 'function' ? dictationBrowserModelChoice(store) : '';
  return DICTATION_BROWSER_MODELS[v] ? v : device === 'webgpu' ? 'small' : 'base';
}

// One dictation through Whisper in this browser. cb: onProgress(percent) · onReady(label) · onText(final, interim) ·
// onError(code, message) · onDone(final). Returns { stop(), abort() }.
// env (tests): { navigator, Worker, AudioContext, AudioWorkletNode, URL, Blob, localStorage }.
function dictationBrowserStart(cb, env) {
  var w = env || window;
  var device = dictationBrowserDevice(w);
  var c = { ended: false, ready: false, stopping: false, stream: null, ctx: null, node: null, url: '', worker: null };
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
    if (c.worker) c.worker.onmessage = null;
    if (kind === 'done') cb.onDone && cb.onDone(a);
    else cb.onError && cb.onError(a, b);
  }
  if (!device) {
    setTimeout(function () { end('error', 'unsupported', '이 브라우저는 브라우저 위스퍼를 쓸 수 없습니다 (Web Worker·WebAssembly 미지원)'); }, 0);
    return { stop: function () {}, abort: function () {} };
  }
  var nav = w.navigator;
  if (!nav || !nav.mediaDevices || typeof nav.mediaDevices.getUserMedia !== 'function' || !w.AudioContext) {
    setTimeout(function () { end('error', 'unsupported', '이 브라우저는 마이크 스트리밍을 지원하지 않습니다'); }, 0);
    return { stop: function () {}, abort: function () {} };
  }
  var store = null;
  try { store = w.localStorage || null; } catch (e) { store = null; }
  var model = dictationBrowserModel(store, device);
  var info = DICTATION_BROWSER_MODELS[model];
  var label = info.label.split(' — ')[1] + ', ' + (device === 'webgpu' ? 'WebGPU' : 'WebAssembly');
  if (!_dictationBrowserWorker || _dictationBrowserLoaded !== model) {
    if (_dictationBrowserWorker) try { _dictationBrowserWorker.terminate(); } catch (e) {}
    var src = w.URL.createObjectURL(new w.Blob([DICTATION_BROWSER_WORKER_SRC], { type: 'text/javascript' }));
    _dictationBrowserWorker = new w.Worker(src, { type: 'module' });
    _dictationBrowserLoaded = model;
  }
  var worker = _dictationBrowserWorker;
  c.worker = worker;
  var files = {};
  worker.onmessage = function (e) {
    var m = e.data || {};
    if (m.type === 'progress') {
      files[m.file] = { loaded: m.loaded, total: m.total };
      var got = 0;
      var all = 0;
      for (var k in files) { got += files[k].loaded; all += files[k].total; }
      if (all) cb.onProgress && cb.onProgress(Math.min(99, Math.floor((got / all) * 100)));
    } else if (m.type === 'loaded') {
      openMic();
    } else if (m.type === 'text') {
      cb.onText && cb.onText(String(m.final || ''), String(m.interim || ''));
    } else if (m.type === 'done') {
      cb.onText && cb.onText(String(m.final || ''), '');
      end('done', String(m.final || ''));
    } else if (m.type === 'error') {
      _dictationBrowserWorker = null;
      _dictationBrowserLoaded = '';
      try { worker.terminate(); } catch (err) {}
      end('error', 'model', '브라우저 위스퍼 모델을 불러오지 못했습니다 — ' + (m.message || '알 수 없는 오류'));
    }
  };
  worker.onerror = function () {
    _dictationBrowserWorker = null;
    _dictationBrowserLoaded = '';
    end('error', 'model', '브라우저 위스퍼를 시작하지 못했습니다');
  };
  worker.postMessage({ type: 'load', model: info.id, device: device, dtype: dictationBrowserDtype(model, device) });
  function openMic() {
    if (c.ended) return;
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
          worker.postMessage({ type: 'start', language: 'korean' });
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
    // Finish: no more audio; the worker finalizes what it heard and answers done.
    stop: function () {
      if (c.ended || c.stopping) return;
      c.stopping = true;
      if (c.stream) try { c.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
      if (c.ready) worker.postMessage({ type: 'stop' });
      else end('done', '');
    },
    // Drop everything now (the loaded model stays for the next press).
    abort: function () {
      c.stopping = true;
      c.ended = true;
      release();
      worker.onmessage = null;
      try { worker.postMessage({ type: 'abort' }); } catch (e) {}
    },
  };
}
`;
