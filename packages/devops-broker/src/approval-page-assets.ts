// The approval page's documents (#1056): fixed strings shipped inside the broker's root-owned code. They carry
// no card data — the script fetches the card from this origin and writes it into the document as text only.
// The script takes the approval id from its own path and reads nothing else from outside: no query string, no
// other window, no storage. The enrol script alone reads the address fragment (the one-time code).

const HEAD = [
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1">',
  '<meta name="color-scheme" content="light dark">',
  '<meta name="robots" content="noindex">',
  '<link rel="stylesheet" href="/assets/page.css">',
].join('');

export const APPROVE_HTML = `<!doctype html>
<html lang="ko"><head>${HEAD}<title>devops 승인</title></head>
<body><main>
<p id="status" class="status" role="status">불러오는 중…</p>
<section id="card" hidden>
<h1 id="header"></h1>
<p id="title" class="title"></p>
<ul id="warnings" class="warnings" hidden></ul>
<h2 id="command-label" hidden>실행할 명령</h2>
<pre id="command" hidden></pre>
<h2>요청 내용</h2>
<dl id="details"></dl>
<p id="meta" class="meta"></p>
<p id="deadline" class="meta"></p>
<div class="actions">
<button id="deny" type="button" class="deny" disabled>거부</button>
<button id="approve" type="button" class="approve" disabled>승인</button>
</div>
<p class="hint">버튼을 누르면 Touch ID(패스키)를 확인합니다. 창이 앞에 온 뒤 1.5초 동안은 버튼이 잠겨 있습니다.</p>
</section>
</main><script src="/assets/approve.js"></script></body></html>
`;

export const ENROLL_HTML = `<!doctype html>
<html lang="ko"><head>${HEAD}<title>devops 승인 — 패스키 등록</title></head>
<body><main>
<h1>패스키 등록</h1>
<p id="status" class="status" role="status">불러오는 중…</p>
<div class="actions"><button id="create" type="button" class="approve" disabled>패스키 만들기</button></div>
<section id="done" hidden>
<h2>이 지문을 터미널에 입력하세요</h2>
<p id="fingerprint" class="fingerprint"></p>
<p class="hint">터미널에 지문을 입력해야 등록이 끝납니다. 입력하기 전에는 아무것도 등록되지 않습니다.</p>
</section>
</main><script src="/assets/enroll.js"></script></body></html>
`;

export const PAGE_CSS = `:root{color-scheme:light dark;--fg:#111;--muted:#666;--bg:#fff;--line:#ddd;--code:#f5f5f5;--warn:#8a4b00;--warn-bg:#fff4e0;--ok:#0a6b2d;--no:#a11}
@media (prefers-color-scheme:dark){:root{--fg:#eee;--muted:#999;--bg:#111;--line:#333;--code:#1c1c1c;--warn:#ffc266;--warn-bg:#2a2010;--ok:#4cc46f;--no:#ff6b6b}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Segoe UI",sans-serif}
main{max-width:520px;margin:0 auto;padding:20px}
h1{font-size:18px;margin:0 0 8px}
h2{font-size:13px;color:var(--muted);margin:18px 0 6px;font-weight:600}
.title{font-size:16px;margin:0 0 12px;overflow-wrap:anywhere}
.status{color:var(--muted);margin:0 0 12px}
.status.warn{color:var(--warn)}
.status.ok{color:var(--ok);font-weight:600}
.status.no{color:var(--no);font-weight:600}
.warnings{margin:0 0 12px;padding:10px 10px 10px 28px;background:var(--warn-bg);color:var(--warn);border-radius:8px}
pre{margin:0;padding:10px;background:var(--code);border-radius:8px;font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
dl{margin:0;display:grid;grid-template-columns:max-content 1fr;gap:4px 12px}
dt{color:var(--muted)}
dd{margin:0;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
.meta{color:var(--muted);font-size:12px;margin:10px 0 0;overflow-wrap:anywhere}
.actions{display:flex;gap:10px;margin:20px 0 8px}
button{flex:1;padding:12px;border-radius:10px;border:1px solid var(--line);background:transparent;color:var(--fg);font:inherit;font-weight:600;cursor:pointer}
button.approve{background:var(--ok);border-color:var(--ok);color:#fff}
button.deny{color:var(--no);border-color:var(--no)}
button:disabled{opacity:.4;cursor:default}
button:focus-visible{outline:2px solid var(--fg);outline-offset:2px}
.hint{color:var(--muted);font-size:12px;margin:0}
.fingerprint{font:600 26px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:1px;margin:8px 0}
`;

const SHARED_JS = `
  function byId(id) { return document.getElementById(id); }
  function fromB64u(text) {
    var b64 = text.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    var raw = atob(b64);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  function toB64u(buffer) {
    var bytes = new Uint8Array(buffer);
    var raw = '';
    for (var i = 0; i < bytes.length; i++) raw += String.fromCharCode(bytes[i]);
    return btoa(raw).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  }
  function api(path, body) {
    return fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error'
    }).then(function (response) {
      return response.json().then(function (json) { return { status: response.status, body: json }; });
    });
  }
  function setStatus(text, tone) {
    var el = byId('status');
    el.textContent = text;
    el.className = 'status' + (tone ? ' ' + tone : '');
  }
`;

export const APPROVE_JS = `(function () {
  'use strict';
${SHARED_JS}
  var match = /^\\/a\\/([A-Za-z0-9_-]{8,64})$/.exec(location.pathname);
  var id = match ? match[1] : '';
  var ARM_MS = 1500;
  var armed = false;
  var armTimer = 0;
  var busy = false;
  var done = false;
  var challenges = null;
  var deadlineAt = 0;
  var clockSkew = 0;

  function setButtons() {
    var on = armed && !busy && !done && !!challenges;
    byId('approve').disabled = !on;
    byId('deny').disabled = !on;
  }
  function disarm() {
    armed = false;
    clearTimeout(armTimer);
    setButtons();
  }
  // The buttons work only after this window has been in front, untouched, for a moment: a window that
  // appears under the pointer cannot collect a click meant for something else.
  function arm() {
    disarm();
    if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
    armTimer = setTimeout(function () { armed = true; setButtons(); }, ARM_MS);
  }
  function finish(text, tone) {
    done = true;
    challenges = null;
    byId('card').hidden = true;
    setStatus(text, tone);
    setButtons();
  }
  function line(parent, tag, text) {
    var el = document.createElement(tag);
    el.textContent = text;
    parent.appendChild(el);
    return el;
  }
  function shown(token) {
    return /^[A-Za-z0-9_.\\/=+,#@%-]+$/.test(token) ? token : JSON.stringify(token);
  }
  function render(card) {
    byId('header').textContent = card.header;
    byId('title').textContent = card.title;
    var warnings = byId('warnings');
    warnings.textContent = '';
    for (var i = 0; i < card.warnings.length; i++) line(warnings, 'li', card.warnings[i]);
    warnings.hidden = card.warnings.length === 0;
    var hasCommand = Array.isArray(card.argv) && card.argv.length > 0;
    byId('command-label').hidden = !hasCommand;
    byId('command').hidden = !hasCommand;
    byId('command').textContent = hasCommand ? 'gh ' + card.argv.map(shown).join(' ') : '';
    var details = byId('details');
    details.textContent = '';
    for (var j = 0; j < card.details.length; j++) {
      line(details, 'dt', card.details[j].label);
      line(details, 'dd', card.details[j].value);
    }
    line(details, 'dt', '세션(자칭)');
    line(details, 'dd', card.sessionKey);
    byId('meta').textContent = '요청자(자칭·미검증) ' + card.requester + ' · 승인 ID ' + card.approvalId + ' · digest ' + card.digestPrefix;
    deadlineAt = Date.parse(card.expiresAt);
    clockSkew = Date.parse(card.now) - Date.now();
    byId('card').hidden = false;
    setStatus('요청 내용을 확인하고 결정하세요.', '');
    tick();
  }
  function tick() {
    if (done || !deadlineAt) return;
    var left = Math.floor((deadlineAt - (Date.now() + clockSkew)) / 1000);
    if (left <= 0) return finish('응답 시간이 지났습니다. 이 요청은 만료됐습니다.', 'no');
    byId('deadline').textContent = '남은 시간 ' + Math.floor(left / 60) + '분 ' + (left % 60) + '초';
  }
  function loadChallenges() {
    return api('/api/challenge', { approvalId: id }).then(function (reply) {
      if (done) return;
      if (reply.status === 200) challenges = reply.body;
      else if (reply.status === 404) finish('이 요청은 이미 결정됐거나 만료됐습니다.', '');
      else if (reply.body && reply.body.error === 'no-passkey') {
        challenges = null;
        setStatus('등록된 패스키가 없습니다. 운영자에게 패스키 등록을 요청하세요.', 'warn');
      } else challenges = null;
      setButtons();
    });
  }
  var RESULT = {
    approved: ['승인했습니다. 이 창은 닫아도 됩니다.', 'ok'],
    denied: ['거부했습니다. 이 창은 닫아도 됩니다.', 'no'],
    expired: ['응답 시간이 지나 승인되지 않았습니다.', 'no'],
    cancelled: ['요청이 취소돼 실행되지 않았습니다.', 'no']
  };
  function decide(action) {
    if (!armed || busy || done || !challenges) return;
    var used = challenges;
    var challenge = used[action];
    challenges = null;
    busy = true;
    setButtons();
    setStatus('Touch ID(패스키)를 확인하는 중…', '');
    navigator.credentials.get({
      publicKey: {
        challenge: fromB64u(challenge),
        rpId: used.rpId,
        allowCredentials: used.credentialIds.map(function (c) { return { type: 'public-key', id: fromB64u(c) }; }),
        userVerification: 'required',
        timeout: used.timeoutMs
      }
    }).then(function (credential) {
      return api('/api/decide', {
        approvalId: id,
        action: action,
        challenge: challenge,
        credentialId: credential.id,
        clientDataJSON: toB64u(credential.response.clientDataJSON),
        authenticatorData: toB64u(credential.response.authenticatorData),
        signature: toB64u(credential.response.signature)
      });
    }).then(function (reply) {
      busy = false;
      if (reply.status === 200 && RESULT[reply.body.result]) {
        finish(RESULT[reply.body.result][0], RESULT[reply.body.result][1]);
        setTimeout(function () { window.close(); }, 1500);
        return;
      }
      if (reply.status === 404) return finish('이 요청은 이미 결정됐거나 만료됐습니다.', '');
      setStatus('결정이 반영되지 않았습니다. 다시 시도하세요.', 'warn');
      return loadChallenges();
    }).catch(function () {
      busy = false;
      if (done) return;
      setStatus('패스키 확인을 취소했거나 실패했습니다. 다시 시도하세요.', 'warn');
      return loadChallenges();
    }).then(setButtons);
  }

  if (!id || !window.PublicKeyCredential) {
    setStatus(id ? '이 브라우저는 패스키를 지원하지 않습니다.' : '잘못된 주소입니다.', 'warn');
    return;
  }
  byId('approve').addEventListener('click', function () { decide('approve'); });
  byId('deny').addEventListener('click', function () { decide('deny'); });
  window.addEventListener('focus', arm);
  window.addEventListener('blur', disarm);
  document.addEventListener('visibilitychange', arm);
  api('/api/card/' + id).then(function (reply) {
    if (reply.status !== 200) return finish('이 요청은 이미 결정됐거나 만료됐습니다.', '');
    render(reply.body);
    setInterval(tick, 1000);
    // A challenge lasts two minutes: keep a fresh pair ready so a click goes straight to the passkey prompt.
    setInterval(function () { if (!busy && !done) loadChallenges(); }, 60000);
    arm();
    return loadChallenges();
  }).catch(function () {
    setStatus('브로커에 연결하지 못했습니다. 창을 닫고 다시 여세요.', 'warn');
  });
})();
`;

export const ENROLL_JS = `(function () {
  'use strict';
${SHARED_JS}
  // The one-time code is the address fragment the operator's terminal printed. It is read once and removed
  // from the address bar and the history entry.
  var code = location.hash.slice(1);
  history.replaceState(null, '', location.pathname);
  var options = null;
  var busy = false;

  function refuse(text) {
    options = null;
    byId('create').disabled = true;
    setStatus(text, 'warn');
  }
  var REFUSED = {
    'bad-code': '등록 주소가 잘못됐거나 만료됐습니다. 터미널에서 등록을 다시 시작하세요.',
    'already-submitted': '이 주소로 이미 패스키가 제출됐습니다. 본인이 한 일이 아니라면 터미널에서 Enter를 눌러 취소하세요.'
  };
  function create() {
    if (busy || !options) return;
    busy = true;
    byId('create').disabled = true;
    var used = options;
    options = null;
    navigator.credentials.create({
      publicKey: {
        challenge: fromB64u(used.challenge),
        rp: used.rp,
        user: { id: fromB64u(used.user.id), name: used.user.name, displayName: used.user.displayName },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
        attestation: 'none',
        excludeCredentials: used.excludeCredentials.map(function (c) { return { type: 'public-key', id: fromB64u(c) }; }),
        timeout: used.timeoutMs
      }
    }).then(function (credential) {
      return api('/api/enroll/finish', {
        code: code,
        clientDataJSON: toB64u(credential.response.clientDataJSON),
        authenticatorData: toB64u(credential.response.getAuthenticatorData())
      });
    }).then(function (reply) {
      if (reply.status !== 200) return refuse(REFUSED[reply.body.error] || '패스키가 거부됐습니다. 터미널에서 등록을 다시 시작하세요.');
      byId('fingerprint').textContent = reply.body.fingerprint;
      byId('done').hidden = false;
      setStatus('패스키를 만들었습니다. 아직 등록되지 않았습니다.', '');
    }).catch(function () {
      busy = false;
      setStatus('패스키 만들기를 취소했거나 실패했습니다. 다시 누르세요.', 'warn');
      return load();
    });
  }
  function load() {
    return api('/api/enroll/options', { code: code }).then(function (reply) {
      if (reply.status !== 200) return refuse(REFUSED[reply.body.error] || '등록을 시작할 수 없습니다.');
      options = reply.body;
      byId('create').disabled = false;
      setStatus('아래 버튼을 눌러 이 컴퓨터에 패스키를 만드세요.', '');
    });
  }

  if (!window.PublicKeyCredential) return refuse('이 브라우저는 패스키를 지원하지 않습니다.');
  if (!code) return refuse('주소에 등록 코드가 없습니다. 터미널에 출력된 주소 전체를 여세요.');
  byId('create').addEventListener('click', create);
  load().catch(function () { refuse('브로커에 연결하지 못했습니다.'); });
})();
`;
