/**
 * 서버 위스퍼 — the browser's side of a live dictation through the server's Whisper (epic #737, #739).
 *
 * The microphone (getUserMedia, echo cancellation and noise suppression on) goes through an AudioWorklet that
 * averages it down to 16 kHz mono s16le and posts 100 ms chunks; they stream over /ws/dictation (dictation-routes.ts),
 * and the server answers with the words as they settle. Shared by the dashboard (its composers' 받아쓰기) and the
 * settings page (말해서 시험).
 *
 * Client script: String.raw, no `${…}` and no backticks (ships byte for byte).
 */

export const DICTATION_SERVER_JS = String.raw`
// The worklet: the microphone at the context's rate, averaged down to 16 kHz, as s16le chunks of 100 ms. Sent
// 'flush', it posts what it holds (less than a chunk — the last syllable) and then 'flushed'.
var DICTATION_WORKLET_SRC = "class SomaPcm16 extends AudioWorkletProcessor {" +
  "constructor() { super(); this.step = sampleRate / 16000; this.acc = 0; this.sum = 0; this.cnt = 0; this.out = new Int16Array(1600); this.n = 0;" +
  "var me = this; this.port.onmessage = function (e) { if (e.data !== 'flush') return;" +
  "if (me.n) me.port.postMessage(me.out.slice(0, me.n).buffer); me.n = 0; me.port.postMessage('flushed'); }; }" +
  "process(inputs) { var ch = inputs[0] && inputs[0][0]; if (!ch) return true;" +
  "for (var i = 0; i < ch.length; i++) { this.sum += ch[i]; this.cnt++; this.acc += 1;" +
  "if (this.acc >= this.step) { this.acc -= this.step; var v = this.sum / this.cnt; this.sum = 0; this.cnt = 0;" +
  "v = v < -1 ? -1 : v > 1 ? 1 : v; this.out[this.n++] = v < 0 ? v * 32768 : v * 32767;" +
  "if (this.n === this.out.length) { this.port.postMessage(this.out.buffer, [this.out.buffer]); this.out = new Int16Array(1600); this.n = 0; } } }" +
  "return true; } }" +
  "registerProcessor('soma-pcm16', SomaPcm16);";

// The socket's address on this page's origin.
function dictationServerUrl(loc) {
  return (loc.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + loc.host + '/ws/dictation';
}

// Whether this server can take a live dictation: { ok, model } or { ok: false, why }.
async function dictationServerStatus(fetchFn) {
  var f = fetchFn || (typeof fetch === 'function' ? fetch : null);
  if (!f) return { ok: false, why: '서버에 물어볼 수 없습니다' };
  try {
    var r = await f('/api/dictation/status', { credentials: 'same-origin' });
    if (!r || !r.ok) return { ok: false, why: '서버에 연결하지 못했습니다' };
    var j = await r.json();
    var s = j && j.server;
    return s && typeof s.ok === 'boolean' ? s : { ok: false, why: '서버가 알 수 없는 답을 했습니다' };
  } catch (e) {
    return { ok: false, why: '서버에 연결하지 못했습니다' };
  }
}

// The words for a microphone the browser refused or could not open.
function dictationMicError(e) {
  var n = e && e.name;
  if (n === 'NotAllowedError' || n === 'SecurityError') return { code: 'not-allowed', message: '마이크 권한이 없어 받아쓸 수 없습니다 — 주소창의 사이트 권한에서 마이크를 허용해 주세요' };
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return { code: 'audio-capture', message: '마이크를 찾지 못했습니다 — 마이크를 연결하거나 다른 앱이 쓰고 있는지 확인해 주세요' };
  if (n === 'NotReadableError') return { code: 'audio-capture', message: '마이크를 열 수 없습니다 — 다른 앱이 마이크를 쓰고 있습니다' };
  return { code: 'audio-capture', message: '마이크를 열지 못했습니다' };
}

// One dictation through the server's Whisper. cb: onReady(model) · onText(final, interim) · onError(code, message) ·
// onDone(final, why — set when the server ended it, e.g. the time limit). Returns { stop() — finish: the server finalizes what it heard, abort() — drop everything now }.
// env (tests): { navigator, WebSocket, AudioContext, AudioWorkletNode, URL, Blob, location }.
function dictationServerStart(cb, env) {
  var w = env || window;
  var c = { ws: null, ctx: null, stream: null, node: null, url: '', ended: false, ready: false, stopping: false };
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
    if (c.ws) try { c.ws.close(); } catch (e) {}
    if (kind === 'done') cb.onDone && cb.onDone(a, b || '');
    else cb.onError && cb.onError(a, b);
  }
  var nav = w.navigator;
  if (!nav || !nav.mediaDevices || typeof nav.mediaDevices.getUserMedia !== 'function' || !w.WebSocket || !w.AudioContext) {
    setTimeout(function () { end('error', 'unsupported', '이 브라우저는 서버 위스퍼를 쓸 수 없습니다 (마이크 스트리밍 미지원)'); }, 0);
    return { stop: function () {}, abort: function () {} };
  }
  nav.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }).then(
    function (stream) {
      if (c.ended) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
      c.stream = stream;
      var ctx = new w.AudioContext();
      c.ctx = ctx;
      if (!ctx.audioWorklet || !w.AudioWorkletNode) return end('error', 'unsupported', '이 브라우저는 서버 위스퍼를 쓸 수 없습니다 (AudioWorklet 미지원)');
      c.url = w.URL.createObjectURL(new w.Blob([DICTATION_WORKLET_SRC], { type: 'application/javascript' }));
      return ctx.audioWorklet.addModule(c.url).then(function () {
        if (c.ended) return;
        var node = new w.AudioWorkletNode(ctx, 'soma-pcm16', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
        c.node = node;
        ctx.createMediaStreamSource(stream).connect(node);
        // Pulled by the destination through a silent gain (nothing is played).
        var mute = ctx.createGain();
        mute.gain.value = 0;
        node.connect(mute);
        mute.connect(ctx.destination);
        if (ctx.resume) ctx.resume();
        var ws = new w.WebSocket(dictationServerUrl(w.location));
        ws.binaryType = 'arraybuffer';
        c.ws = ws;
        node.port.onmessage = function (e) {
          if (c.ready && !c.stopping && ws.readyState === 1) ws.send(e.data);
        };
        ws.onopen = function () {
          ws.send(JSON.stringify({ type: 'start', lang: 'ko-KR' }));
        };
        ws.onmessage = function (e) {
          var m = null;
          try { m = JSON.parse(String(e.data)); } catch (err) { return; }
          if (!m) return;
          if (m.type === 'ready') {
            c.ready = true;
            cb.onReady && cb.onReady(m.model || '');
          } else if (m.type === 'text') {
            cb.onText && cb.onText(String(m.final || ''), String(m.interim || ''));
          } else if (m.type === 'done') {
            cb.onText && cb.onText(String(m.final || ''), '');
            end('done', String(m.final || ''), String(m.message || ''));
          } else if (m.type === 'error') {
            end('error', m.code || 'error', m.message || '서버 위스퍼가 받아쓰지 못했습니다');
          }
        };
        ws.onclose = function () {
          end('error', c.ready ? 'closed' : 'unavailable', c.ready ? '서버 위스퍼 연결이 끊겼습니다 — 다시 누르면 이어서 받아씁니다' : '서버 위스퍼에 연결하지 못했습니다');
        };
      });
    },
    function (e) {
      var why = dictationMicError(e);
      end('error', why.code, why.message);
    }
  ).then(null, function () {
    end('error', 'unsupported', '서버 위스퍼를 시작하지 못했습니다');
  });
  return {
    // Finish: no more audio; what the worklet still holds goes out, then stop — the server finalizes what it heard
    // and answers done.
    stop: function () {
      if (c.ended || c.stopping) return;
      c.stopping = true;
      if (c.stream) try { c.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
      var ws = c.ws;
      if (!ws || ws.readyState !== 1 || !c.ready) return end('done', '');
      var sent = false;
      function send() {
        if (sent || c.ended) return;
        sent = true;
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'stop' }));
      }
      var node = c.node;
      if (!node) return send();
      node.port.onmessage = function (e) {
        if (typeof e.data === 'string') {
          if (e.data === 'flushed') send();
        } else if (!sent && ws.readyState === 1) ws.send(e.data);
      };
      try { node.port.postMessage('flush'); } catch (err) { return send(); }
      // A worklet that never answers (a suspended context) does not hold the stop; a merely busy one answers well
      // within a second (one render quantum is 3 ms).
      setTimeout(send, 1000);
    },
    // Drop everything now.
    abort: function () {
      c.stopping = true;
      c.ended = true;
      release();
      if (c.ws) try { c.ws.close(); } catch (e) {}
    },
  };
}
`;
