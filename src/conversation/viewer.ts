/**
 * The conversation viewer pages (M-07 list, M-08 one conversation) — the 0.9.0 "conversation archive page" built
 * from @2lab.ai/ui parts: <ui-app-bar> on top, the conversations as kit `.ui-row` links with <ui-elapsed> times
 * on the left, the open one in <ui-conversation>. Narrow, `/conversations` is the list and `/conversations/:id`
 * the conversation with a back link. The list is plain links (it works without JavaScript).
 *
 * Two things the library does not cover yet are the page's own (research/D5-GAPS.md G5-1, G5-2):
 *   - an answer's raw output is loaded only when asked: a "원본 응답 보기" button in the turn's
 *     `attachments-<id>` slot fetches `/api/conversations/:id/turns/:turnId/raw` and hands the answer to the
 *     element as `markdown` (loading → the element's skeleton; failure → its error with Try again → `ui-retry`);
 *   - choosing turns to export as Markdown: <ui-dialog> with a checklist, `POST /api/conversations/:id/export`
 *     (CSRF, one retry after a token refresh), downloaded as a .md file.
 *
 * Tokens and kit classes are the library's own sheets (tokens.css, ui-kit.css) — no palette here.
 * Client scripts: String.raw, no `${…}` and no backticks (they ship byte for byte); the page data is JSON.
 */
import type { ConversationMeta, ConversationRecord, ConversationTurn } from './types';
import { UI_LIB_VERSION, uiIcon, uiLibKitCss, uiLibTokensCss } from './ui-lib';

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** JSON for a `<script type="application/json">` block: no `</script>` can end it early. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Format timestamp for display (the server's words for a time: the text before <ui-elapsed> upgrades, and the
 * conversation's start)
 */
function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('ko-KR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function isoTime(ts: number): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

// ── The page shell: tokens, kit, app bar, theme ──

export const VIEWER_CSS = String.raw`
*,*::before,*::after { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body { display: flex; flex-direction: column; height: 100dvh; background: var(--ui-bg); color: var(--ui-ib-text); font-family: var(--ui-font); font-size: 14px; line-height: 1.45; -webkit-font-smoothing: antialiased; }
/* The bar: <ui-app-bar> draws itself (translucent, one hairline); until it is defined, its height and nothing else. */
.vw-top { position: sticky; top: 0; z-index: 20; flex: none; min-width: 0; }
ui-app-bar:not(:defined) { display: block; height: 56px; }
/* The archive: the list on the left, the open conversation on the right; each scrolls on its own. */
.vw-body { flex: 1; min-height: 0; display: grid; grid-template-columns: 300px minmax(0, 1fr); width: 100%; max-width: 1280px; margin: 0 auto; }
.vw-solo .vw-body { grid-template-columns: minmax(0, 1fr); max-width: 960px; }
.vw-side { display: flex; flex-direction: column; gap: 6px; min-height: 0; overflow: auto; padding: 16px 10px 24px 16px; border-right: 1px solid var(--ui-ib-card-border); }
.vw-side h2 { display: flex; align-items: baseline; gap: 6px; margin: 2px 4px 6px; font-size: 13px; font-weight: 650; letter-spacing: -0.006em; }
.vw-side h2 small { font-size: 12px; font-weight: 500; color: var(--ui-ib-muted); font-variant-numeric: tabular-nums; }
.vw-side ul { display: flex; flex-direction: column; gap: 1px; margin: 0; padding: 0; list-style: none; }
.vw-side .ui-row[aria-current="page"] { background: var(--ui-ib-pill); }
.vw-side .ui-row small { overflow-wrap: anywhere; }
.vw-main { display: flex; flex-direction: column; gap: 12px; min-width: 0; min-height: 0; padding: 16px 20px; }
.vw-main > .ui-empty { margin: auto; }
.vw-head { display: flex; align-items: center; gap: 10px; min-width: 0; }
.vw-title { flex: 1; min-width: 0; }
.vw-title h1 { margin: 0; font-size: 16px; font-weight: 650; letter-spacing: -0.01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vw-meta { margin: 2px 0 0; font-size: 12px; color: var(--ui-ib-muted); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.vw-meta code { font-family: var(--ui-mono); font-size: 11.5px; }
.vw-back { display: none; }
.vw-solo .vw-back { display: inline-grid; }
.vw-main ui-conversation { display: block; flex: 1; min-height: 0; }
/* Until the element is defined, none of its slotted content. */
ui-conversation:not(:defined) > * { display: none; }
/* A user turn's files (slot media-<id>): kept images as thumbnails, other files as links. */
.vw-media { display: flex; flex-wrap: wrap; gap: 6px; }
.att { display: inline-flex; border: 1px solid var(--ui-ib-card-border); border-radius: 10px; overflow: hidden; background: var(--ui-ib-card); color: inherit; text-decoration: none; }
.att-img img { display: block; width: 96px; height: 96px; object-fit: cover; }
.att-file { align-items: center; gap: 8px; max-width: 280px; padding: 6px 10px; font-size: 12.5px; }
.att-file > svg { flex: none; width: 14px; height: 14px; color: var(--ui-ib-muted); }
.att-file > span { display: flex; flex-direction: column; min-width: 0; }
.att-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.att-meta { color: var(--ui-ib-muted); font-size: 11.5px; }
a.att:focus-visible { outline: 2px solid var(--ui-border-focus); outline-offset: 1px; }
@media (hover: hover) and (pointer: fine) { a.att:hover { border-color: var(--ui-ib-muted); } }
/* An answer's raw output on request (slot attachments-<id>). */
.vw-raw { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.vw-raw-note { margin: 0; font-size: 12.5px; color: var(--ui-ib-muted); }
/* Export: the turns to put in the Markdown file. */
.vw-x-bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 0 0 8px; }
#selectedCount { font-size: 12.5px; color: var(--ui-ib-muted); font-variant-numeric: tabular-nums; }
.vw-x-list { margin: 0; padding: 0; list-style: none; border: 1px solid var(--ui-ib-card-border); border-radius: 10px; max-height: min(52dvh, 420px); overflow: auto; }
.vw-x-list li + li { border-top: 1px solid var(--ui-ib-card-border); }
.vw-x-turn { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 10px; align-items: start; padding: 10px 12px; font-size: 13px; cursor: pointer; }
.vw-x-turn input { width: 16px; height: 16px; margin: 2px 0 0; accent-color: var(--ui-accent); cursor: pointer; }
.vw-x-turn input:focus-visible { outline: 2px solid var(--ui-border-focus); outline-offset: 2px; }
.vw-x-turn strong { font-weight: 600; }
.vw-x-turn small { margin-left: 6px; font-size: 12px; color: var(--ui-ib-muted); font-variant-numeric: tabular-nums; }
.vw-x-ex { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ui-ib-text-2); }
#export-error { margin: 10px 0 0; }
#export-error[hidden] { display: none; }
.vw-x-foot { display: flex; justify-content: flex-end; gap: 8px; }
/* Narrow: the list, or the conversation with a back link — one at a time. */
@media (max-width: 720px) {
  .vw-body { grid-template-columns: minmax(0, 1fr); }
  .vw-side { border-right: 0; padding: 12px 12px 24px; }
  body[data-view="detail"] .vw-side, body[data-view="list"] .vw-main { display: none; }
  .vw-back { display: inline-grid; }
  .vw-main { padding: 12px 12px 8px; }
  .vw-x-turn { padding: 12px; }
}
`;

/** The app bar, the theme (the dashboard's soma-theme) and the signed-in account, on both pages. */
export const VIEWER_SHELL_JS = String.raw`
var APP_BAR_NAV = [
  { id: 'dashboard', label: '대시보드', href: '/dashboard', icon: 'board' },
  { id: 'conversations', label: '대화', href: '/conversations', icon: 'chat', current: true },
  { id: 'settings', label: '설정', href: '/dashboard/settings', icon: 'gear' },
];
var _appBarAccount = null; // { name, href, role? } once /auth/me answers
var _csrfToken = '';
function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}
function paintAppBar() {
  var bar = document.getElementById('app-bar');
  if (!bar) return;
  var data = { brand: { label: 'soma-work', mark: true, href: '/dashboard' }, nav: APP_BAR_NAV, navLabel: '주 메뉴', theme: currentTheme() };
  if (_appBarAccount) data.account = _appBarAccount;
  bar.data = data;
}
function setTheme(next) {
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('soma-theme', next); } catch (_e) {}
  paintAppBar();
}
async function refreshCsrfToken() {
  try {
    var res = await fetch('/auth/me');
    if (res.ok) {
      var data = await res.json();
      _csrfToken = data.csrfToken || '';
      if (data.user && data.user.name) {
        _appBarAccount = { name: data.user.name, href: '/login' };
        if (data.isAdmin) _appBarAccount.role = '관리자';
        paintAppBar();
      }
    }
  } catch (_e) {}
}
(function () {
  var bar = document.getElementById('app-bar');
  if (bar) bar.addEventListener('ui-theme-change', function (e) {
    var t = e.detail && e.detail.theme;
    if (t === 'light' || t === 'dark') setTheme(t);
  });
  paintAppBar();
  refreshCsrfToken();
})();
`;

function page(opts: { title: string; view: 'list' | 'detail'; solo?: boolean; body: string; scripts: string }): string {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(opts.title)}</title>
<script data-fouc>
(function(){var t=null;try{t=localStorage.getItem('soma-theme')}catch(_e){}if(t!=='light'&&t!=='dark'){t=window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'}document.documentElement.setAttribute('data-theme',t)})();
</script>
<!-- @2lab.ai/ui: the kit classes (.ui-row, .ui-btn, .ui-empty …) and the tokens (--ui-* on :root and [data-theme]). -->
<style id="ui-kit">
${uiLibKitCss()}
</style>
<style id="ui-tokens">
${uiLibTokensCss()}
</style>
<style>${VIEWER_CSS}</style>
</head>
<body data-view="${opts.view}"${opts.solo ? ' class="vw-solo"' : ''}>
<header class="vw-top"><ui-app-bar id="app-bar" lang="ko"></ui-app-bar></header>
${opts.body}
<script>${VIEWER_SHELL_JS}</script>
${opts.scripts}
<script type="module" src="/dashboard/ui/app-bar.js?v=${UI_LIB_VERSION}"></script>
<script type="module" src="/dashboard/ui/elapsed.js?v=${UI_LIB_VERSION}"></script>
</body>
</html>`;
}

/** Title of a conversation as the list and the head show it. */
function titleOf(c: { title?: string; titleSub?: string }): string {
  return c.title || c.titleSub || '(제목 없음)';
}

/** The conversation list: one `.ui-row` link per conversation, the open one marked. */
function sideList(conversations: ConversationMeta[], openId?: string): string {
  const rows = conversations
    .map((c) => {
      const current = c.id === openId ? ' aria-current="page"' : '';
      const meta = [escapeHtml(c.ownerName || ''), escapeHtml(c.workflow || 'default'), `${c.turnCount}턴`]
        .filter(Boolean)
        .join(' · ');
      return `<li><a class="ui-row" href="/conversations/${encodeURIComponent(c.id)}"${current}>${uiIcon('chat')}<div><strong>${escapeHtml(
        titleOf(c),
      )}</strong><small>${meta} · <ui-elapsed since="${c.updatedAt}" format="ago" lang="ko">${escapeHtml(
        formatTime(c.updatedAt),
      )}</ui-elapsed></small></div></a></li>`;
    })
    .join('');
  const body = conversations.length
    ? `<ul>${rows}</ul>`
    : `<p class="ui-empty">${uiIcon('chat')}<strong>아직 기록된 대화가 없습니다</strong>Slack에서 대화를 시작하면 여기에 쌓입니다.</p>`;
  return `<nav class="vw-side" aria-label="대화 목록">
  <h2>대화 <small>${conversations.length}</small></h2>
  ${body}
</nav>`;
}

/**
 * Render the conversation list page
 */
export function renderConversationListPage(conversations: ConversationMeta[]): string {
  return page({
    title: '대화 — soma-work',
    view: 'list',
    body: `<h1 class="ui-sr-only">대화</h1>
<div class="vw-body">
${sideList(conversations)}
<main class="vw-main">
  <p class="ui-empty">${uiIcon('chat')}<strong>대화를 고르세요</strong>목록에서 대화를 열면 여기에 보입니다.</p>
</main>
</div>`,
    scripts: '',
  });
}

// ── One conversation ──

const KIND_LABEL: Record<string, string> = {
  image: '이미지',
  audio: '오디오',
  video: '비디오',
  html: 'HTML',
  markdown: 'Markdown',
  pdf: 'PDF',
  text: '텍스트',
  file: '파일',
};

function formatBytes(n: number): string {
  if (!(n > 0)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

/**
 * The files a user attached to this turn (user media, SSOT 2026-10-25), in the turn's `media-<id>` slot (the
 * element shows it above the words): kept images as thumbnails that open the copy, other kept files as links to
 * it, a file without a copy as its Slack link (https only) or its name.
 */
function renderTurnAttachments(turn: ConversationTurn, conversationId: string): string {
  const list = Array.isArray(turn.attachments) ? turn.attachments : [];
  if (list.length === 0) return '';
  const base = `/api/dashboard/session/${encodeURIComponent(conversationId)}/media/`;
  const items = list.map((a) => {
    const url = `${base}${encodeURIComponent(a.id)}/content`;
    const meta = [KIND_LABEL[a.kind] || '파일', formatBytes(a.size), a.stored ? '' : 'Slack에만 있음']
      .filter(Boolean)
      .join(' · ');
    const name = escapeHtml(a.name);
    if (a.stored && a.kind === 'image') {
      return `<a class="att att-img" href="${url}" target="_blank" rel="noopener" title="${name}"><img src="${url}" alt="${name}" loading="lazy" decoding="async" width="96" height="96"></a>`;
    }
    const href = a.stored ? url : /^https:\/\//i.test(a.permalink || '') ? (a.permalink as string) : '';
    const body = `${uiIcon(a.kind === 'image' ? 'image' : 'paperclip')}<span><span class="att-name">${name}</span><span class="att-meta">${escapeHtml(meta)}</span></span>`;
    return href
      ? `<a class="att att-file" href="${escapeHtml(href)}" target="_blank" rel="noopener">${body}</a>`
      : `<span class="att att-file">${body}</span>`;
  });
  return `<div slot="media-${escapeHtml(turn.id)}" class="vw-media">${items.join('')}</div>`;
}

/** An answer's raw-output button (slot `attachments-<id>`); over it, until then, the summary stands in. */
function renderRawLoader(turn: ConversationTurn): string {
  const note = turn.summarized && turn.summaryTitle ? '<p class="vw-raw-note">위 내용은 요약입니다.</p>' : '';
  return `<div slot="attachments-${escapeHtml(turn.id)}" class="vw-raw">${note}<button type="button" class="ui-btn is-sm is-quiet" data-raw="${escapeHtml(
    turn.id,
  )}">${uiIcon('file-text')}원본 응답 보기</button></div>`;
}

/**
 * A turn as the page script keeps it; the script hands <ui-conversation> its view of it (viewTurn). An answer's
 * raw output stays on the server until asked for: `summaryState` says what stands in for it meanwhile.
 */
export interface ViewerTurn {
  id: string;
  role: 'user' | 'assistant';
  name?: string;
  at: number;
  text?: string;
  media?: boolean;
  summary?: { title?: string; text?: string };
  summaryState?: 'done' | 'pending' | 'failed';
  responseMs?: number;
}

export function viewerTurns(turns: ConversationTurn[]): ViewerTurn[] {
  return turns.map((t, i) => {
    if (t.role === 'user') {
      const out: ViewerTurn = {
        id: t.id,
        role: 'user',
        name: t.userName || '사용자',
        at: t.timestamp,
        text: t.rawContent || '',
      };
      if (Array.isArray(t.attachments) && t.attachments.length) out.media = true;
      return out;
    }
    const out: ViewerTurn = { id: t.id, role: 'assistant', at: t.timestamp };
    if (t.summarized && t.summaryTitle) {
      out.summary = { title: t.summaryTitle, text: t.summaryBody || '' };
      out.summaryState = 'done';
    } else out.summaryState = t.summarized ? 'failed' : 'pending';
    // The answer is recorded when it is complete: the time since the instruction right before it.
    const prev = turns[i - 1];
    if (prev && prev.role === 'user' && t.timestamp > prev.timestamp) out.responseMs = t.timestamp - prev.timestamp;
    return out;
  });
}

/** The export checklist: every turn, checked (the whole conversation is the usual export). */
function exportList(turns: ConversationTurn[]): string {
  return turns
    .map((t) => {
      const who = t.role === 'user' ? `${t.userName || '사용자'} · 사용자` : '응답';
      const firstLine = (t.rawContent || '').split('\n').find((l) => l.trim()) || '';
      const files = Array.isArray(t.attachments) && t.attachments.length ? `파일 ${t.attachments.length}개` : '';
      const excerpt =
        t.role === 'user'
          ? firstLine.slice(0, 160) || files
          : t.summaryTitle || (t.summarized ? '요약 없음' : '요약 전');
      return `<li><label class="vw-x-turn"><input type="checkbox" class="turn-checkbox" data-turn-id="${escapeHtml(
        t.id,
      )}" checked onchange="updateSelectedCount()"><span><strong>${escapeHtml(who)}</strong><small>${escapeHtml(
        formatTime(t.timestamp),
      )}</small><span class="vw-x-ex">${escapeHtml(excerpt)}</span></span></label></li>`;
    })
    .join('');
}

/**
 * Render a single conversation view page. `conversations` (optional) is the list beside it; without it the page
 * is the conversation alone with a link back to the list.
 */
export function renderConversationViewPage(record: ConversationRecord, conversations?: ConversationMeta[]): string {
  const title = titleOf(record);
  const turns = Array.isArray(record.turns) ? record.turns : [];
  const slotted = turns
    .map((t) => (t.role === 'user' ? renderTurnAttachments(t, record.id) : renderRawLoader(t)))
    .join('');
  const solo = !Array.isArray(conversations);
  const data = { id: record.id, turns: viewerTurns(turns) };
  const created = Number.isFinite(record.createdAt)
    ? ` · <time datetime="${isoTime(record.createdAt)}">${escapeHtml(formatTime(record.createdAt))}</time> 시작`
    : '';
  return page({
    title: `${title} — soma-work`,
    view: 'detail',
    solo,
    body: `<div class="vw-body">
${solo ? '' : sideList(conversations, record.id)}
<main class="vw-main">
  <div class="vw-head">
    <a class="ui-icon-btn vw-back" href="/conversations" aria-label="모든 대화">${uiIcon('chevron-left')}</a>
    <div class="vw-title">
      <h1>${escapeHtml(title)}</h1>
      <p class="vw-meta">${escapeHtml(record.ownerName || '')} · <code>${escapeHtml(record.workflow || 'default')}</code> · ${turns.length}턴${created}</p>
    </div>
    <button type="button" class="ui-btn is-sm" id="export-open" onclick="openExport()"${turns.length ? '' : ' disabled'}>${uiIcon('download')}내보내기</button>
  </div>
  <ui-conversation id="conv" lang="ko">${slotted}</ui-conversation>
  <noscript><p class="ui-notice">대화 내용을 보려면 JavaScript를 켜 주세요.</p></noscript>
</main>
</div>
<ui-dialog id="export-dialog" heading="Markdown으로 내보내기" size="md" lang="ko">
  <div class="vw-x-bar"><button type="button" class="ui-btn is-sm is-quiet" id="selectAllBtn" onclick="toggleSelectAll()">전체 해제</button><span id="selectedCount" role="status">${turns.length}개 선택</span></div>
  <ul class="vw-x-list">${exportList(turns)}</ul>
  <p class="ui-notice" data-tone="fail" id="export-error" role="alert" hidden></p>
  <div slot="footer" class="vw-x-foot"><button type="button" class="ui-btn" onclick="closeExport()">취소</button><button type="button" class="ui-btn is-primary" id="exportBtn" onclick="exportSelected()">${uiIcon(
    'download',
  )}내보내기 (.md)</button></div>
</ui-dialog>`,
    scripts: `<script type="application/json" id="conv-data">${scriptJson(data)}</script>
<script>${VIEWER_CLIENT_JS}</script>
<script type="module" src="/dashboard/ui/conversation.js?v=${UI_LIB_VERSION}"></script>
<script type="module" src="/dashboard/ui/dialog.js?v=${UI_LIB_VERSION}"></script>`,
  });
}

/**
 * Client-side JavaScript for the conversation page: the element's data, the raw output on request, and the export.
 */
export const VIEWER_CLIENT_JS = String.raw`
var _cv = (function () {
  var el = document.getElementById('conv-data');
  try { return JSON.parse((el && el.textContent) || '{}'); } catch (_e) { return {}; }
})();
var CONVERSATION_ID = _cv.id || '';
var _turns = Array.isArray(_cv.turns) ? _cv.turns : [];

// What the element shows of a turn. An answer whose raw output is not loaded yet (no markdown) shows its summary
// (or what became of it) as the answer, with no Raw source — the element would say "no recorded answer" for an
// empty one (G5-2) — and the raw-output button in its attachments slot. Loaded: the answer, Raw = summary + source.
function viewTurn(t) {
  if (t.role !== 'assistant') return t;
  var v = { id: t.id, role: 'assistant', at: t.at };
  if (t.responseMs) v.responseMs = t.responseMs;
  if (typeof t.markdown === 'string') {
    v.markdown = t.markdown;
    if (t.summary) v.summary = t.summary;
    return v;
  }
  var s = t.summary || {};
  v.markdown = t.summaryState === 'done'
    ? '**' + String(s.title || '').trim() + '**' + (s.text ? '\n\n' + String(s.text).trim() : '')
    : t.summaryState === 'failed' ? '*요약하지 못했습니다.*' : '*요약을 만드는 중입니다.*';
  v.source = '';
  v.attachments = true;
  if (t.loading) v.loading = true;
  if (t.error) { v.error = t.error; v.canRetry = true; }
  return v;
}
function paintConversation() {
  var el = document.getElementById('conv');
  if (!el) return;
  el.data = { turns: _turns.map(viewTurn), startText: '대화의 시작', emptyText: '이 대화에는 아직 턴이 없습니다.' };
}
function turnById(id) {
  for (var i = 0; i < _turns.length; i++) if (_turns[i].id === id) return _turns[i];
  return null;
}

// ── 원본 응답 — loaded only when asked (G5-2) ──
// The button in the answer's attachments-<id> slot fetches the raw output; while it is out the element shows the
// answer loading, then the answer itself (markdown, with Raw's summary / source). A failure is the element's
// error with Try again (ui-retry → the same fetch).
async function loadRaw(id) {
  var cur = turnById(id);
  if (!cur || cur.role !== 'assistant' || cur.loading || typeof cur.markdown === 'string') return;
  var t = Object.assign({}, cur, { loading: true });
  delete t.error;
  replaceTurn(t);
  var btn = document.querySelector('[data-raw="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
  if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
  var res = null;
  var data = null;
  try {
    res = await fetch('/api/conversations/' + encodeURIComponent(CONVERSATION_ID) + '/turns/' + encodeURIComponent(id) + '/raw');
    try { data = await res.json(); } catch (_e) {}
  } catch (_e) {}
  var next = Object.assign({}, turnById(id), { loading: false });
  if (res && res.ok && data && typeof data.raw === 'string') {
    next.markdown = data.raw;
    var slot = btn && btn.closest ? btn.closest('[slot]') : null;
    if (slot && slot.parentNode) slot.parentNode.removeChild(slot);
  } else {
    // The element says "답변을 불러오지 못했습니다 (…)" around this: only the cause goes in.
    next.error = res ? 'HTTP ' + res.status : '네트워크 오류';
    if (btn) { btn.disabled = false; btn.removeAttribute('aria-busy'); }
  }
  replaceTurn(next);
}
function replaceTurn(t) {
  for (var i = 0; i < _turns.length; i++) if (_turns[i].id === t.id) _turns[i] = t;
  paintConversation();
}

// ── Export as Markdown — turns chosen in the dialog (G5-1) ──
function exportDialog() { return document.getElementById('export-dialog'); }
function setExportError(text) {
  var el = document.getElementById('export-error');
  if (!el) return;
  el.textContent = text || '';
  el.hidden = !text;
}
// show() / hide() once <ui-dialog> is defined; before that its observed open attribute (read on upgrade).
function openExport() {
  var d = exportDialog();
  if (!d) return;
  setExportError('');
  updateSelectedCount();
  if (typeof d.show === 'function') d.show();
  else d.setAttribute('open', '');
}
function closeExport() {
  var d = exportDialog();
  if (!d) return;
  if (typeof d.hide === 'function') d.hide();
  else d.removeAttribute('open');
}
function updateSelectedCount() {
  var boxes = document.querySelectorAll('.turn-checkbox');
  var checked = document.querySelectorAll('.turn-checkbox:checked');
  var countEl = document.getElementById('selectedCount');
  var exportBtn = document.getElementById('exportBtn');
  var allBtn = document.getElementById('selectAllBtn');
  if (countEl) countEl.textContent = checked.length + '개 선택';
  if (exportBtn) exportBtn.disabled = checked.length === 0;
  if (allBtn) allBtn.textContent = boxes.length && checked.length === boxes.length ? '전체 해제' : '전체 선택';
}
function toggleSelectAll() {
  var checkboxes = document.querySelectorAll('.turn-checkbox');
  var allChecked = Array.from(checkboxes).every(function (cb) { return cb.checked; });
  checkboxes.forEach(function (cb) { cb.checked = !allChecked; });
  updateSelectedCount();
}
async function exportSelected() {
  var checked = document.querySelectorAll('.turn-checkbox:checked');
  var turnIds = Array.from(checked).map(function (cb) { return cb.dataset.turnId; });
  if (!turnIds.length) return;
  var exportBtn = document.getElementById('exportBtn');
  if (exportBtn) { exportBtn.disabled = true; exportBtn.setAttribute('aria-busy', 'true'); }
  setExportError('');
  try {
    var exportUrl = '/api/conversations/' + encodeURIComponent(CONVERSATION_ID) + '/export';
    var exportBody = JSON.stringify({ turnIds: turnIds });
    var headers = function () {
      var h = { 'Content-Type': 'application/json' };
      if (_csrfToken) h['X-CSRF-Token'] = _csrfToken;
      return h;
    };
    var res = await fetch(exportUrl, { method: 'POST', headers: headers(), body: exportBody });
    if (res.status === 403) {
      await refreshCsrfToken();
      res = await fetch(exportUrl, { method: 'POST', headers: headers(), body: exportBody });
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var md = await res.text();
    // Download as file
    var blob = new Blob([md], { type: 'text/markdown' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'conversation-' + CONVERSATION_ID.substring(0, 8) + '.md';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    closeExport();
  } catch (err) {
    setExportError('내보내지 못했습니다: ' + (err && err.message ? err.message : String(err)));
  } finally {
    if (exportBtn) exportBtn.removeAttribute('aria-busy');
    updateSelectedCount();
  }
}

(function () {
  var el = document.getElementById('conv');
  if (el) {
    el.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('[data-raw]') : null;
      if (b && !b.disabled) loadRaw(b.getAttribute('data-raw'));
    });
    el.addEventListener('ui-retry', function (e) {
      var id = e.detail && e.detail.id;
      if (id) loadRaw(id);
    });
  }
  paintConversation();
})();
`;
