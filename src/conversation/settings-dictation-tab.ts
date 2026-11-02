/**
 * The settings page "받아쓰기" tab (SSOT 2026-11-02, epic #737, #738).
 *
 *   1. "온디바이스 기기 디폴트 STT와 실제 가장 훌륭한 모델(위스퍼) 중 선택 … 기기별 설정을 해당 기기에만 저장 … 서버에
 *      저장하는 설정이 아님" — three engines: the browser's own recogniser (기기 기본), the server's Whisper, Whisper
 *      in this browser. The choice is kept in this browser's storage (dictation-pref.ts) and never sent.
 *   2. "해당 설정에서 현재 기기의 온디바이스 모델에 대한 상세 정보 표시" — what this device's own recogniser is: the
 *      browser and system, where it processes speech, Chrome's on-device model per language (with its download), the
 *      microphone permission, and what a browser model would run on (WebGPU, memory, cores). Browsers do not tell a
 *      page the system recogniser's model name or version; the tab says so instead of guessing.
 *   3. 말해서 시험 — the chosen engine listens for a few seconds: the time to the first word and the words.
 *
 * Client script: String.raw, no `${…}` and no backticks (ships byte for byte). It runs after DICTATION_PREF_JS
 * (dictationEngineChoice · dictationSaveEngine) and uses the page's esc().
 */

export const DICTATION_TAB_HTML = `<div slot="dictation" data-tab="dictation" class="page dic-page" hidden>
  <main class="dic" id="dic-root">
    <p class="intro">받아쓰기에 쓸 음성 인식 엔진을 고릅니다. 고른 값은 이 기기의 이 브라우저에만 저장됩니다. 다른 기기와 서버 설정에는 영향이 없습니다.</p>
    <section class="group" aria-labelledby="h-dic-engine">
      <header><h2 id="h-dic-engine">엔진</h2><p>새 작업과 세션 패널의 받아쓰기가 이 엔진을 씁니다.</p></header>
      <div class="dic-engines" id="dic-engines" role="radiogroup" aria-labelledby="h-dic-engine">
        <label class="dic-engine" data-engine="device">
          <input type="radio" name="dic-engine" value="device">
          <span class="dic-engine-body"><span class="dic-engine-name">기기 기본 음성 인식</span>
          <span class="dic-engine-desc">이 기기·브라우저에 들어 있는 음성 인식기입니다. 따로 내려받을 것이 없고 바로 받아씁니다. 처리 위치는 아래 ‘이 기기의 음성 인식’을 보세요.</span>
          <span class="dic-engine-why" data-why="device" hidden></span></span>
        </label>
        <label class="dic-engine" data-engine="server">
          <input type="radio" name="dic-engine" value="server">
          <span class="dic-engine-body"><span class="dic-engine-name">서버 위스퍼</span>
          <span class="dic-engine-desc">우리 서버의 Whisper large-v3-turbo가 받아씁니다. 기기 성능과 상관없이 한국어 정확도가 가장 높습니다. 음성은 우리 서버로만 갑니다.</span>
          <span class="dic-engine-why" data-why="server" hidden></span></span>
        </label>
        <label class="dic-engine" data-engine="browser">
          <input type="radio" name="dic-engine" value="browser">
          <span class="dic-engine-body"><span class="dic-engine-name">브라우저 위스퍼</span>
          <span class="dic-engine-desc">이 브라우저 안에서 Whisper가 받아씁니다. 음성이 기기 밖으로 나가지 않습니다. 처음 쓸 때 모델을 내려받습니다.</span>
          <span class="dic-engine-why" data-why="browser" hidden></span></span>
        </label>
      </div>
      <p class="dic-note" id="dic-engine-note" role="status" aria-live="polite"></p>
    </section>
    <section class="group" aria-labelledby="h-dic-info">
      <header><h2 id="h-dic-info">이 기기의 음성 인식</h2><p>이 브라우저가 알려 주는 정보입니다.</p></header>
      <dl class="dic-info" id="dic-info"><div class="dic-row"><dt>상태</dt><dd>확인하는 중…</dd></div></dl>
    </section>
    <section class="group" aria-labelledby="h-dic-test">
      <header><h2 id="h-dic-test">말해서 시험</h2><p>고른 엔진으로 8초 동안 듣습니다. 첫 글자가 나오기까지 걸린 시간과 받아쓴 글을 보여 줍니다.</p></header>
      <div class="dic-test">
        <button type="button" class="btn primary" id="dic-test-btn">말해서 시험</button>
        <p class="dic-live" id="dic-test-live" aria-live="polite"></p>
        <p class="dic-result" id="dic-test-result" role="status"></p>
      </div>
    </section>
  </main>
</div>`;

export const DICTATION_TAB_CSS = String.raw`
/* 받아쓰기 tab: one column of cards (no side nav). */
.dic-page { grid-template-columns: minmax(0, 1fr); max-width: 760px; }
.dic-engines { display: flex; flex-direction: column; }
.dic-engine { display: flex; gap: 12px; align-items: flex-start; padding: 12px 16px; border-top: 1px solid var(--border); cursor: pointer; }
.dic-engine:first-child { border-top: 0; }
.dic-engine input { margin-top: 3px; width: 16px; height: 16px; accent-color: var(--accent); flex: none; }
.dic-engine input:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 2px; }
.dic-engine.is-off { cursor: not-allowed; }
.dic-engine.is-off .dic-engine-name, .dic-engine.is-off .dic-engine-desc { opacity: 0.55; }
.dic-engine-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dic-engine-name { font-size: 14px; font-weight: 600; }
.dic-engine-desc { font-size: 12.5px; color: var(--text-secondary); }
.dic-engine-why { font-size: 12.5px; color: var(--tint-fail-fg); }
.dic-engine-why[hidden], .dic-note:empty { display: none; }
.dic-note { font-size: 12.5px; color: var(--text-secondary); padding: 0 16px 12px; }
.dic-info { margin: 0; }
.dic-row { display: grid; grid-template-columns: 160px minmax(0, 1fr); gap: 12px; padding: 9px 16px; border-top: 1px solid var(--border); font-size: 13px; }
.dic-row:first-child { border-top: 0; }
.dic-row dt { color: var(--text-secondary); }
.dic-row dd { margin: 0; overflow-wrap: anywhere; }
.dic-row dd .btn { margin-left: 8px; min-height: 28px; padding: 3px 10px; font-size: 12px; }
.dic-row .dic-sub { display: block; font-size: 12px; color: var(--text-secondary); margin-top: 2px; }
.dic-test { padding: 14px 16px; display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
.dic-live { font-size: 14px; min-height: 1.4em; overflow-wrap: anywhere; }
.dic-live:empty::before { content: ''; }
.dic-result { font-size: 12.5px; color: var(--text-secondary); }
@media (max-width: 640px) {
  .dic-row { grid-template-columns: minmax(0, 1fr); gap: 2px; }
}
`;

export const DICTATION_CLIENT_JS = String.raw`
// ── 받아쓰기 tab ──
var _dicLoaded = false;
var _dicInfo = null;
var _dicTest = null;
var DIC_TEST_MS = 8000;
var DIC_LANGS = ['ko-KR', 'en-US'];

// A promise's answer; slow when it takes longer than ms, failed (default: slow) when it rejects.
function dicWithin(p, ms, slow, failed) {
  var bad = arguments.length > 3 ? failed : slow;
  return new Promise(function (resolve) {
    var t = setTimeout(function () { resolve(slow); }, ms);
    Promise.resolve(p).then(
      function (v) { clearTimeout(t); resolve(v); },
      function () { clearTimeout(t); resolve(bad); }
    );
  });
}

// The browser's name and version from its user-agent string (client hints refine the version in dicInfo).
function dicBrowser(nav) {
  var ua = String((nav && nav.userAgent) || '');
  var m;
  if ((m = ua.match(/SamsungBrowser\/([\d.]+)/))) return { name: '삼성 인터넷', version: m[1] };
  if ((m = ua.match(/Edg(?:A|iOS)?\/([\d.]+)/))) return { name: 'Edge', version: m[1] };
  if ((m = ua.match(/(?:Firefox|FxiOS)\/([\d.]+)/))) return { name: 'Firefox', version: m[1] };
  if ((m = ua.match(/CriOS\/([\d.]+)/))) return { name: 'Chrome (iOS)', version: m[1] };
  if ((m = ua.match(/(?:Chrome|Chromium)\/([\d.]+)/))) return { name: 'Chrome', version: m[1] };
  if (/Safari\//.test(ua) && (m = ua.match(/Version\/([\d.]+)/))) return { name: 'Safari', version: m[1] };
  return { name: '알 수 없는 브라우저', version: '' };
}

// The system and its version from the user-agent string. Chromium freezes Android at "Android 10; K" and macOS at
// 10_15_7: those versions are left out here (client hints give the real one in dicInfo).
function dicOs(nav) {
  var ua = String((nav && nav.userAgent) || '');
  var m;
  if ((m = ua.match(/Android ([\d.]+)/))) return { name: 'Android', version: /Android 10; K\)/.test(ua) ? '' : m[1] };
  if ((m = ua.match(/(iPhone|iPad|iPod)[^)]*? OS (\d+(?:_\d+)*)/))) return { name: m[1] === 'iPad' ? 'iPadOS' : 'iOS', version: m[2].replace(/_/g, '.') };
  if (/Macintosh/.test(ua)) return { name: 'macOS', version: '' };
  if (/Windows/.test(ua)) return { name: 'Windows', version: '' };
  if (/CrOS/.test(ua)) return { name: 'ChromeOS', version: '' };
  if (/Linux/.test(ua)) return { name: 'Linux', version: '' };
  return { name: '알 수 없음', version: '' };
}

// Which recogniser the 기기 기본 engine is on this device — the dashboard's split (ntDictationEngine ·
// ntIsAppleSpeech · ntIsAndroid; a test holds them together): 'apple' (Apple's engine — Safari on a Mac, any browser
// on an iPhone or iPad), 'android' (the phone's own speech app), 'chrome' (Chrome's recogniser, which can be asked to
// stay on the device), 'service' (another browser's speech service), 'none' (no recogniser: Firefox) and 'webapp' (an
// iPhone Home Screen web app, which cannot use it).
function dicPath(w) {
  var n = w && w.navigator;
  if (n && n.standalone === true) return 'webapp';
  var Rec = w && (w.SpeechRecognition || w.webkitSpeechRecognition);
  if (!Rec) return 'none';
  var ua = String((n && n.userAgent) || '');
  if (/iPhone|iPad|iPod/.test(ua)) return 'apple';
  if (/Macintosh/.test(ua) && /Safari\//.test(ua) && !/Chrome|Chromium|Edg|Firefox/.test(ua)) return 'apple';
  var ud = n && n.userAgentData;
  if (/Android/i.test(ua) || (ud && /Android/i.test(String(ud.platform || '')))) return 'android';
  if (typeof Rec.available === 'function') return 'chrome';
  return 'service';
}

// A language's on-device model, asked of Chrome's available() (139+): 'available' (on this device), 'downloadable',
// 'downloading', 'unavailable'; 'unknown' where the browser has no such question, 'timeout' when it does not answer.
async function dicLangState(Rec, lang) {
  if (!Rec || typeof Rec.available !== 'function') return 'unknown';
  try {
    var a = await dicWithin(Rec.available({ langs: [lang], processLocally: true }), 1500, 'timeout', 'unknown');
    return typeof a === 'string' ? a : 'unknown';
  } catch (_e) {
    return 'unknown';
  }
}

// The microphone permission: 'granted', 'prompt', 'denied', or 'unknown' (Safari and Samsung Internet may not say).
async function dicMicState(nav) {
  try {
    if (!nav || !nav.permissions || typeof nav.permissions.query !== 'function') return 'unknown';
    var s = await dicWithin(nav.permissions.query({ name: 'microphone' }), 1500, null);
    return (s && s.state) || 'unknown';
  } catch (_e) {
    return 'unknown';
  }
}

// WebGPU — what a browser model would run on: the adapter's vendor and architecture, or none.
async function dicGpu(nav) {
  if (!nav || !nav.gpu || typeof nav.gpu.requestAdapter !== 'function') return { has: false };
  try {
    var a = await dicWithin(nav.gpu.requestAdapter(), 2000, null);
    if (!a) return { has: false };
    var info = a.info || {};
    return { has: true, vendor: String(info.vendor || ''), arch: String(info.architecture || ''), desc: String(info.description || '') };
  } catch (_e) {
    return { has: false };
  }
}

// The client hints a Chromium browser gives on request: the real system version, the phone model, full versions.
async function dicUaHints(nav) {
  var ud = nav && nav.userAgentData;
  if (!ud || typeof ud.getHighEntropyValues !== 'function') return null;
  try {
    return await dicWithin(ud.getHighEntropyValues(['platformVersion', 'model', 'fullVersionList']), 1500, null);
  } catch (_e) {
    return null;
  }
}

// Everything the tab shows about this device, asked of the browser.
async function dicInfo(w) {
  var n = (w && w.navigator) || {};
  var Rec = w && (w.SpeechRecognition || w.webkitSpeechRecognition);
  var info = {
    browser: dicBrowser(n),
    os: dicOs(n),
    model: '',
    path: dicPath(w),
    secure: !!(w && w.isSecureContext),
    langs: {},
    mic: 'unknown',
    gpu: { has: false },
    memory: Number(n.deviceMemory) || 0,
    cores: Number(n.hardwareConcurrency) || 0,
  };
  var hints = await dicUaHints(n);
  if (hints) {
    if (hints.model) info.model = String(hints.model);
    if (hints.platformVersion && (info.os.name === 'Android' || info.os.name === 'macOS')) info.os.version = String(hints.platformVersion);
    var brand = { Chrome: 'Google Chrome', Edge: 'Microsoft Edge', '삼성 인터넷': 'Samsung Internet' }[info.browser.name];
    var list = hints.fullVersionList || [];
    for (var i = 0; i < list.length; i++) if (brand && list[i].brand === brand && list[i].version) info.browser.version = String(list[i].version);
  }
  for (var j = 0; j < DIC_LANGS.length; j++) info.langs[DIC_LANGS[j]] = await dicLangState(Rec, DIC_LANGS[j]);
  info.mic = await dicMicState(n);
  info.gpu = await dicGpu(n);
  return info;
}

// What each engine can do on this device — { ok, why } per engine. The server's and the browser's Whisper are not
// on this build yet (epic #737: #739, #740).
function dicEngines(info) {
  var path = info && info.path;
  var device = { ok: true, why: '' };
  if (path === 'none') device = { ok: false, why: '이 브라우저에는 음성 인식기가 없습니다 — Chrome·Safari·삼성 인터넷에서 열어 주세요' };
  if (path === 'webapp') device = { ok: false, why: '홈 화면에 추가한 웹 앱에서는 쓸 수 없습니다 — Safari에서 열어 주세요' };
  return {
    device: device,
    server: { ok: false, why: '준비 중입니다' },
    browser: { ok: false, why: '준비 중입니다' },
  };
}

// The engine 받아쓰기 uses here: the chosen one when this device can run it, else the browser's own.
function dicEffective(choice, engines) {
  return engines[choice] && engines[choice].ok ? choice : 'device';
}

var DIC_ENGINE_NAMES = { device: '기기 기본 음성 인식', server: '서버 위스퍼', browser: '브라우저 위스퍼' };

// The recogniser and where it processes speech, per path.
function dicPathText(info) {
  var ko = info.langs && info.langs['ko-KR'];
  switch (info.path) {
    case 'apple':
      return { engine: 'Apple 음성 인식 (Safari·WebKit)', where: '언어가 지원하면 이 기기 안에서 처리합니다 (WebKit이 기기 안 처리를 요청)' };
    case 'android':
      return { engine: '이 휴대폰의 음성 인식 앱 (보통 ‘Google 음성 인식 및 합성’)', where: '페이지가 기기 안 처리를 요청할 수 없습니다 — 휴대폰 설정에 따라 Google 서버로 보낼 수 있습니다' };
    case 'chrome':
      return {
        engine: 'Chrome 음성 인식',
        where: ko === 'available' ? '한국어는 이 기기 안에서 처리합니다 (기기용 한국어 모델이 있음)' : '한국어 기기용 모델이 없어 Google 서버로 보냅니다',
      };
    case 'service':
      return { engine: '브라우저의 음성 서비스', where: '기기 밖, 브라우저 회사의 서버에서 처리합니다' };
    case 'webapp':
      return { engine: '쓸 수 없음', where: '홈 화면 웹 앱에서는 iPhone 음성 인식을 쓸 수 없습니다' };
    default:
      return { engine: '없음', where: '이 브라우저에는 음성 인식기가 없습니다 (받아쓰기 대신 음성 녹음을 씁니다)' };
  }
}

var DIC_LANG_NAMES = { 'ko-KR': '한국어', 'en-US': '영어' };
var DIC_LANG_STATES = {
  available: '이 기기에 있음',
  downloadable: '내려받을 수 있음 (Chrome은 처음 묻기 전에도 이렇게 답합니다)',
  downloading: '내려받는 중',
  unavailable: '이 기기에서는 쓸 수 없음',
  timeout: '브라우저가 답하지 않음',
  unknown: '이 브라우저는 알려 주지 않음',
};
var DIC_MIC_STATES = { granted: '허용됨', prompt: '처음 쓸 때 묻습니다', denied: '막힘 — 주소창의 사이트 권한에서 허용해 주세요', unknown: '이 브라우저는 알려 주지 않음' };

// The rows of 이 기기의 음성 인식: [label, value, sub?, installLang?].
function dicInfoRows(info) {
  var p = dicPathText(info);
  var rows = [];
  rows.push(['브라우저', (info.browser.name + ' ' + info.browser.version).trim()]);
  rows.push(['운영체제', (info.os.name + ' ' + (info.os.version || '')).trim() + (info.os.version ? '' : (info.os.name === 'Android' || info.os.name === 'macOS' ? ' (버전은 브라우저가 숨김)' : ''))]);
  if (info.model) rows.push(['기기 모델', info.model]);
  rows.push(['음성 인식기', p.engine, info.path === 'apple' || info.path === 'android' || info.path === 'service' ? '모델 이름·버전·크기는 브라우저가 페이지에 알려 주지 않습니다' : '']);
  rows.push(['처리 위치', p.where]);
  for (var i = 0; i < DIC_LANGS.length; i++) {
    var l = DIC_LANGS[i];
    var s = info.langs[l] || 'unknown';
    rows.push([DIC_LANG_NAMES[l] + ' 기기용 모델', DIC_LANG_STATES[s] || s, '', info.path === 'chrome' && s === 'downloadable' ? l : '']);
  }
  rows.push(['마이크 권한', DIC_MIC_STATES[info.mic] || info.mic]);
  rows.push(['보안 연결 (HTTPS)', info.secure ? '예' : '아니요 — 마이크를 쓸 수 없습니다']);
  rows.push([
    'WebGPU',
    info.gpu.has ? ('있음' + (info.gpu.vendor || info.gpu.arch ? ' — ' + [info.gpu.vendor, info.gpu.arch].filter(Boolean).join(' · ') : '')) : '없음',
    '브라우저 위스퍼가 빠르게 돌려면 필요합니다',
  ]);
  rows.push(['메모리 · 코어', (info.memory ? '약 ' + info.memory + 'GB' : '알 수 없음') + ' · ' + (info.cores ? info.cores + '코어' : '알 수 없음')]);
  return rows;
}

function dicPaintInfo(info) {
  var dl = document.getElementById('dic-info');
  if (!dl) return;
  var rows = dicInfoRows(info);
  var html = '';
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    html += '<div class="dic-row"><dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) +
      (r[3] ? '<button type="button" class="btn" data-dic-install="' + esc(r[3]) + '">내려받기</button>' : '') +
      (r[2] ? '<span class="dic-sub">' + esc(r[2]) + '</span>' : '') + '</dd></div>';
  }
  dl.innerHTML = html;
}

function dicPaintEngines(info) {
  var engines = dicEngines(info);
  var choice = dictationEngineChoice(dicStore());
  var use = dicEffective(choice, engines);
  var inputs = document.querySelectorAll('input[name="dic-engine"]');
  for (var i = 0; i < inputs.length; i++) {
    var id = inputs[i].value;
    var e = engines[id] || { ok: false, why: '' };
    inputs[i].disabled = !e.ok;
    inputs[i].checked = id === use;
    var label = inputs[i].closest ? inputs[i].closest('.dic-engine') : null;
    if (label && label.classList) label.classList.toggle('is-off', !e.ok);
    var why = document.querySelector('[data-why="' + id + '"]');
    if (why) { why.textContent = e.ok ? '' : e.why; why.hidden = e.ok; }
  }
  var note = document.getElementById('dic-engine-note');
  if (note) note.textContent = use !== choice ? '고른 엔진(' + DIC_ENGINE_NAMES[choice] + ')을 이 기기에서 쓸 수 없어 ' + DIC_ENGINE_NAMES[use] + '으로 받아씁니다' : '';
}

function dicStore() {
  try { return window.localStorage; } catch (_e) { return null; }
}

// A choice: kept in this browser only (dictation-pref.ts) — no request.
function dicChoose(v) {
  var note = document.getElementById('dic-engine-note');
  var ok = dictationSaveEngine(dicStore(), v);
  if (note) note.textContent = ok ? DIC_ENGINE_NAMES[v] + '을(를) 이 기기에 저장했습니다' : '이 브라우저가 저장을 막아 고를 수 없습니다 (개인 정보 보호 모드 등)';
}

// Chrome's on-device model for a language: install() in the press (it needs one), then the rows again.
async function dicInstall(lang) {
  var Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Rec || typeof Rec.install !== 'function') return;
  var res = document.getElementById('dic-test-result');
  if (res) res.textContent = DIC_LANG_NAMES[lang] + ' 기기용 모델을 내려받는 중…';
  var ok = await dicWithin(Rec.install({ langs: [lang], processLocally: true }), 120000, false);
  if (res) res.textContent = ok === true ? DIC_LANG_NAMES[lang] + ' 기기용 모델을 내려받았습니다' : DIC_LANG_NAMES[lang] + ' 기기용 모델을 내려받지 못했습니다';
  await loadDictationTab();
}

// ── 말해서 시험 ──
var DIC_ERRORS = {
  'not-allowed': '마이크 권한이 없습니다',
  'service-not-allowed': '이 기기의 음성 인식이 꺼져 있습니다',
  'audio-capture': '마이크를 찾지 못했습니다',
  network: '음성 인식 서비스에 연결하지 못했습니다',
  'no-speech': '말소리가 들리지 않았습니다',
  aborted: '중단됐습니다',
  'language-not-supported': '한국어를 지원하지 않습니다',
};

// The words of a result list: finals, then the words still being heard.
function dicTestText(results) {
  var finals = '';
  var interim = '';
  for (var i = 0; i < results.length; i++) {
    var t = results[i][0] ? String(results[i][0].transcript || '') : '';
    if (results[i].isFinal) finals += t; else interim += t;
  }
  return (finals + interim).trim();
}

// The line under the test: the time to the first word and how long it listened, or why nothing came.
function dicTestSummary(t) {
  var secs = function (ms) { return (Math.round(ms / 100) / 10).toFixed(1) + '초'; };
  if (t.text) return '첫 글자까지 ' + secs(t.first) + ' · ' + secs(t.ended - t.t0) + ' 동안 들음 · ' + DIC_ENGINE_NAMES[t.engine];
  return '글자가 나오지 않았습니다' + (t.err ? ' — ' + (DIC_ERRORS[t.err] || t.err) : '') + ' · ' + DIC_ENGINE_NAMES[t.engine];
}

function dicTestStart() {
  if (_dicTest) return dicTestStop();
  var engine = dicEffective(dictationEngineChoice(dicStore()), dicEngines(_dicInfo || { path: dicPath(window) }));
  var Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
  var live = document.getElementById('dic-test-live');
  var res = document.getElementById('dic-test-result');
  var btn = document.getElementById('dic-test-btn');
  if (engine !== 'device' || !Rec) {
    if (res) res.textContent = '이 기기에서는 시험할 엔진이 없습니다';
    return;
  }
  var t = { engine: engine, rec: new Rec(), t0: Date.now(), first: 0, ended: 0, text: '', err: '' };
  t.rec.lang = 'ko-KR';
  t.rec.interimResults = true;
  t.rec.continuous = false;
  t.rec.maxAlternatives = 1;
  if (_dicInfo && _dicInfo.path === 'chrome' && _dicInfo.langs['ko-KR'] === 'available') t.rec.processLocally = true;
  t.rec.onresult = function (e) {
    var text = dicTestText(e.results);
    if (text && !t.first) t.first = Date.now() - t.t0;
    if (text) t.text = text;
    if (live) live.textContent = t.text;
  };
  t.rec.onerror = function (e) { t.err = (e && e.error) || 'error'; };
  t.rec.onend = function () { dicTestDone(t); };
  _dicTest = t;
  t.timer = setTimeout(function () { try { t.rec.stop(); } catch (_e) {} }, DIC_TEST_MS);
  if (live) live.textContent = '';
  if (res) res.textContent = '듣는 중… 말해 보세요 (8초)';
  if (btn) btn.textContent = '멈추기';
  try {
    t.rec.start();
  } catch (e) {
    t.err = 'not-allowed';
    dicTestDone(t);
  }
}

function dicTestStop() {
  if (_dicTest) try { _dicTest.rec.stop(); } catch (_e) {}
}

function dicTestDone(t) {
  if (_dicTest !== t) return;
  _dicTest = null;
  clearTimeout(t.timer);
  t.ended = Date.now();
  var res = document.getElementById('dic-test-result');
  var btn = document.getElementById('dic-test-btn');
  if (res) res.textContent = dicTestSummary(t);
  if (btn) btn.textContent = '말해서 시험';
}

// The tab, the first time it is shown (and after a download): this device's details, then the engines.
async function loadDictationTab() {
  _dicLoaded = true;
  _dicInfo = await dicInfo(window);
  dicPaintInfo(_dicInfo);
  dicPaintEngines(_dicInfo);
}

function initDictationTab() {
  var root = document.getElementById('dic-root');
  if (!root) return;
  root.addEventListener('change', function (e) {
    var t = e.target;
    if (t && t.name === 'dic-engine' && t.checked) dicChoose(t.value);
  });
  root.addEventListener('click', function (e) {
    var t = e.target;
    var lang = t && t.getAttribute && t.getAttribute('data-dic-install');
    if (lang) { dicInstall(lang); return; }
    if (t && t.id === 'dic-test-btn') dicTestStart();
  });
}
initDictationTab();
`;
