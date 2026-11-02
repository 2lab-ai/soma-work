/**
 * SSOT 2026-10-23 — dashboard artifacts, client half. Executes the shipped page
 * code (cut out of renderDashboardPage()'s template literal and cooked exactly
 * as the browser receives it — the harness of dashboard-live-surfaces-client.test.ts):
 *
 *   T5  collapsed card face: an artifact row the board shows at a glance (cardOf's
 *       artifacts, drawn by <ui-agent-inbox>, a chip opens the viewer);
 *       expanded card: a "산출물" strip of thumbnails, audio playable in place
 *   T6  right panel: a pinned artifact strip, and the files each answer produced
 *   T2  hover → a peek: @2lab.ai/ui <ui-hovercard> (D4 I-05), one card for every tile; its inside is the
 *       library's peekHtml (D6b, 0.12.0) over the page's item — a document's head fetched by the page
 *   T3  click → the viewer: @2lab.ai/ui <ui-artifact-viewer tiles="none"> (D4 I-06 / I-07) opened over the
 *       page's own cards with open(items, index, opener); the page hands it the items (url, kind word, the
 *       Slack action, a document's text, scripts for the model's HTML, frame for a stored PDF — D6b, 0.12.0)
 *   T8  html / png / wav: viewable at once; audio plays in place on its <ui-file-card playable>
 *   T1  markdown final answers are the viewer's document (the library's renderer; the page keeps none)
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));

function cook(fragment: string): string {
  if (fragment.includes('`') || fragment.includes('${')) throw new Error('fragment is not a plain template slice');
  return new Function(`return \`${fragment}\`;`)() as string;
}
function assertUnique(name: string) {
  const re = new RegExp(`^(?:async function|function|var|let|const) ${name}\\b`, 'gm');
  const n = (TEMPLATE.match(re) ?? []).length;
  if (n > 1) throw new Error(`client ${name} is declared ${n} times`);
}
// Cut + cooked once per name: the suites load the same functions many times.
const cutCache = new Map<string, string>();
function clientFn(name: string): string {
  const hit = cutCache.get(name);
  if (hit !== undefined) return hit;
  const cut = cutClientFn(name);
  cutCache.set(name, cut);
  return cut;
}
function cutClientFn(name: string): string {
  assertUnique(name);
  const plain = TEMPLATE.indexOf(`\nfunction ${name}(`);
  const start = plain >= 0 ? plain : TEMPLATE.indexOf(`\nasync function ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = TEMPLATE.indexOf('\n}\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 2));
}
function clientVar(name: string): string {
  assertUnique(name);
  const m = TEMPLATE.match(new RegExp(`^(var ${name} = .*?;)(?:\\s*//.*)?$`, 'm'));
  if (!m) throw new Error(`client var ${name} not found`);
  return cook(m[1]);
}
/** The page's chrome words (STRINGS), as served: the board's Korean words live there (D2 group 6). */
const PAGE_STRINGS = new Function(
  `${cook(TEMPLATE.slice(TEMPLATE.indexOf('var STRINGS = {'), TEMPLATE.indexOf('\n};\n', TEMPLATE.indexOf('var STRINGS = {')) + 3))}\nreturn STRINGS;`,
)();
function load<T>(fns: string[], vars: string[], inject: Record<string, unknown> = {}): T {
  inject = { STRINGS: PAGE_STRINGS, ...inject };
  const names = Object.keys(inject);
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}

const BASE_FNS = ['esc', 'escAttr', 'escJs', 'toNum', 'umGet', 'umUrl', 'artUrl', 'artFileItem', 'artCard', 'artChip'];
const BASE_VARS = ['ART_KIND_LABEL', '_userMedia', 'CARD_ART_TILES'];

type Art = Record<string, unknown>;
const html: Art = {
  id: 'A1',
  kind: 'html',
  name: 'report.html',
  mime: 'text/html',
  size: 48211,
  stored: true,
  source: 'slack_upload',
  createdAt: 1792733000000,
};
const png: Art = {
  id: 'A2',
  kind: 'image',
  name: 'chart.png',
  mime: 'image/png',
  size: 2048,
  stored: true,
  source: 'slack_upload',
  createdAt: 1792733001000,
};
const wav: Art = {
  id: 'A3',
  kind: 'audio',
  name: 'voice.wav',
  mime: 'audio/wav',
  size: 88200,
  stored: true,
  source: 'slack_upload',
  createdAt: 1792733002000,
};
const answer: Art = {
  id: 'A4',
  kind: 'markdown',
  name: '배포 결과',
  mime: 'text/markdown',
  size: 300,
  stored: true,
  source: 'final_answer',
  createdAt: 1792733003000,
  excerpt: '배포 결과',
};
const bigMov: Art = {
  id: 'A5',
  kind: 'video',
  name: 'huge.mov',
  mime: 'video/quicktime',
  size: 9e9,
  stored: false,
  source: 'slack_upload',
  createdAt: 1792733004000,
  permalink: 'https://example.slack.com/files/U/F5/huge.mov',
};

// The collapsed face is @2lab.ai/ui <ui-agent-inbox>'s: the page hands it the
// newest files and the whole count in the card data (cardOf); the element draws
// the chips, the "+N" and their accessible names ('draws face extras: lead,
// owner badge, host metrics, titles, context level, artifact count and chip
// buttons') and sends ui-artifact for a chip, which the page opens in the viewer.
const CARD_OF_FNS = [
  'toNum',
  'formatTokens',
  'formatTaskTime',
  'permissionSummary',
  'cardSummary',
  'pendingAutoResume',
  'autoResumeLabel',
  'cardCurrentTask',
  'cardTaskRow',
  'agentStatusOf',
  'agentCounts',
  'agentDotOf',
  'cardTotalTokens',
  'ctxLevel',
  'ctxPercent',
  'cardCtxTitle',
  'cardPrMetric',
  '_hashStr',
  'ownerBadgeHue',
  'isSiblingSession',
  'cardOf',
];
const CARD_OF_VARS = [
  'PR_STATE_LABEL',
  'PR_STATE_TONE',
  'AGENT_STATUS_LABEL',
  'AGENT_STATUS_TONE',
  'AGENT_STATUS_GLYPH',
  'OWNER_BADGE_HUES',
];

describe('T5 — collapsed card face: artifacts visible on the board itself', () => {
  const { cardOf } = load<{ cardOf(s: unknown, col: string): Record<string, unknown> }>(CARD_OF_FNS, CARD_OF_VARS, {
    dhShow: () => true,
    dhTruncate: () => null,
    currentUserId: 'U1',
    _ownerIndex: null,
    SELF_INSTANCE_NAME: 'inst',
  });
  const face = (over: Record<string, unknown>) => cardOf({ key: 'inst::C1:t1', displayHeadline: 'h', ...over }, 'idle');

  it('a card with artifacts gets a row of chips with the count; none → nothing', () => {
    const c = face({
      conversationId: 'conv-1',
      artifacts: { count: 6, files: 5, answers: 1, recent: [html, png, wav, answer, bigMov] },
    });
    // The newest four, by id, name and kind; the element shows "+2" from the count.
    expect(c.artifactsCount).toBe(6);
    expect(c.artifacts).toEqual([
      { id: 'A1', name: 'report.html', kind: 'html' },
      { id: 'A2', name: 'chart.png', kind: 'image' },
      { id: 'A3', name: 'voice.wav', kind: 'audio' },
      { id: 'A4', name: '배포 결과', kind: 'markdown' },
    ]);
    // The face never pulls full images: no content route on the board (thumbnails start in the open body).
    expect(JSON.stringify(c)).not.toContain('/artifacts/');
    expect(face({ conversationId: 'c', artifacts: undefined }).artifacts).toBeUndefined();
    expect(face({ conversationId: undefined, artifacts: { count: 1, recent: [html] } }).artifacts).toBeUndefined();
    expect(face({ conversationId: 'c', artifacts: { count: 0, recent: [] } }).artifactsCount).toBeUndefined();
  });

  it('chip text is plain text (the element escapes it)', () => {
    // Not escaped here, so never escaped twice: the element's
    // 'escapes every host string of the face extras and groups' owns the escaping.
    const name = '<img src=x onerror=alert(1)>.html';
    const c = face({ conversationId: 'c', artifacts: { count: 1, recent: [{ ...html, name }] } });
    expect(c.artifacts).toEqual([{ id: 'A1', name, kind: 'html' }]);
  });

  it('a chip opens the viewer (ui-artifact); opening the card fetches the list; renderCardBody shows the strip', () => {
    type Listener = (e: unknown) => void;
    const on: Record<string, Listener> = {};
    const host = {
      addEventListener: (type: string, fn: Listener) => {
        on[type] = fn;
      },
    };
    const opened: unknown[][] = [];
    const fetched: string[] = [];
    const panels: string[] = [];
    const s = { key: 'k1', conversationId: 'conv-1', artifacts: { count: 1, recent: [png] } };
    const { wireInbox } = load<{ wireInbox(h: unknown): void }>(['inboxChipOf', 'wireInbox'], ['_quietOpen'], {
      _expanded: new Set<string>(),
      _sessionCache: { k1: s },
      _doneGroupOpen: {},
      _cardCol: {},
      _cardDrawn: {},
      MOTION: { expand: 240, move: 320 },
      releaseCardIoTimer: () => {},
      syncCardBody: () => {},
      syncCardBodies: () => {},
      ensureCardIo: () => {},
      isSiblingSession: () => false,
      ensureArtifacts: (cid: string) => fetched.push(cid),
      scheduleLayoutRefresh: () => {},
      placeCard: () => {},
      inboxPaint: () => {},
      openArtifactViewer: (...args: unknown[]) => opened.push(args),
      // SSOT 2026-10-29 T2: the opened card's detail card opens with it (covered in
      // dashboard-affectui-agent-inbox-client.test.ts) — a chip opens the viewer, never that.
      openPanel: (k: string) => panels.push(k),
      deckDrop: () => {},
    });
    wireInbox(host);
    const chip = { focus() {}, getAttribute: (n: string) => (n === 'data-key' ? 'art:k1:A2' : null) };
    (host as Record<string, unknown>).shadowRoot = { querySelectorAll: () => [chip] };
    // The element emits on itself: the browser's path starts at the host, the chip is in its shadow root.
    on['ui-artifact']({ target: host, detail: { cardId: 'k1', artifactId: 'A2' }, composedPath: () => [host] });
    // The chip is the opener focus returns to.
    expect(opened).toEqual([['conv-1', 'A2', chip]]);
    // An event from inside the open body (not the element's own) is not a chip.
    on['ui-artifact']({ target: {}, detail: { cardId: 'k1', artifactId: 'A2' } });
    expect(opened).toHaveLength(1);
    expect(panels).toEqual([]);
    on['ui-toggle']({ target: host, detail: { cardId: 'k1', expanded: true } });
    expect(fetched).toEqual(['conv-1']);
    expect(panels).toEqual(['k1']);
    expect(clientFn('renderCardBody')).toContain('renderCardArtifacts(s)');
  });
});

describe('T5 — expanded card: the 산출물 strip', () => {
  const body = (cache: Record<string, unknown> = {}) =>
    load<{ renderCardArtifacts(s: unknown): string }>(
      [...BASE_FNS, 'artSortForDisplay', 'artTile', 'artListFor', 'renderCardArtifacts'],
      BASE_VARS,
      { _artCache: cache },
    );

  it('lists the full cached list: files newest first, then answers; image tiles are real thumbnails', () => {
    const out = body({ 'conv-1': { state: 'ok', list: [html, answer, png, wav] } }).renderCardArtifacts({
      conversationId: 'conv-1',
      artifacts: { count: 4, recent: [wav] },
    });
    expect(out).toContain('산출물');
    expect(out).toContain('4');
    const order = ['A3', 'A2', 'A1', 'A4'].map((id) => out.indexOf(`data-art-id="${id}"`));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // D2 (I-01..I-03): each tile is @2lab.ai/ui <ui-file-card>, keyed for the page's hydration; the element draws
    // the thumbnail (an image's url), the kind's glyph and wash, the name and the meta.
    expect(out).toContain(
      '<ui-file-card class="art-card" variant="tile" playable lang="ko" data-art-cid="conv-1" data-art-id="A2"',
    );
    expect(out).not.toContain('<img');
  });

  it('D2 — the file a card is handed: name, kind, size, time; a stored file has its url (the thumbnail of an image)', () => {
    const m = body();
    const api = m as unknown as { artFileItem(cid: string, a: Art): Record<string, unknown> };
    expect(api.artFileItem('conv-1', png)).toEqual({
      id: 'A2',
      name: 'chart.png',
      kind: 'image',
      size: 2048,
      time: 1792733001000,
      url: '/api/dashboard/session/conv-1/artifacts/A2/content',
    });
    // Only Slack has the bytes: no url (no thumbnail, no open / download), and the card says so.
    expect(api.artFileItem('c', bigMov)).toMatchObject({ id: 'A5', meta: 'Slack에만 있음' });
    expect(api.artFileItem('c', bigMov)).not.toHaveProperty('url');
  });

  it('T8 — every tile is playable: the card draws the play / pause toggle on audio (one clip at a time); a file without bytes says it is on Slack', () => {
    const out = body({ c: { state: 'ok', list: [wav, bigMov] } }).renderCardArtifacts({
      conversationId: 'c',
      artifacts: { count: 2, recent: [] },
    });
    // D4 (I-01 / T8): the element's `playable` — the page keeps no play button, no shared <audio>, no marking.
    expect(out).toMatch(
      /<ui-file-card class="art-card" variant="tile" playable lang="ko" data-art-cid="c" data-art-id="A3"/,
    );
    expect(out).not.toContain('data-art-play');
    for (const gone of [
      'function toggleArtAudio(',
      'function artAudioMark(',
      'function artAudioPlaying(',
      'var _artAudio',
    ]) {
      expect(TEMPLATE, gone).not.toContain(gone);
    }
    expect(TEMPLATE).not.toMatch(/\.art-play\b/);
    // The remote file's tile is marked; its card's meta line says 'Slack에만 있음' (artFileItem).
    expect(out).toContain('<div class="art-tile is-remote">');
  });

  it('before the list loads, the summary shows; with no artifacts the section is absent', () => {
    const out = body().renderCardArtifacts({ conversationId: 'c', artifacts: { count: 1, recent: [png] } });
    expect(out).toContain('data-art-id="A2"');
    expect(body().renderCardArtifacts({ conversationId: 'c' })).toBe('');
  });
});

describe('D2 — the tiles and chips are @2lab.ai/ui <ui-file-card>, answered by the page', () => {
  it('fcHydrate hands a keyed card its file once per change; an unknown file is left alone', () => {
    const files: Record<string, Art> = { A2: png };
    const m = load<{ fcHydrate(el: unknown): void }>(
      ['fcHydrate', 'artFileItem', 'artUrl', 'umGet', 'umUrl', 'toNum'],
      ['_userMedia'],
      { artFind: (_cid: string, id: string) => files[id] ?? null },
    );
    let sets = 0;
    let data: unknown;
    const el = {
      getAttribute: (k: string) => ({ 'data-art-cid': 'c', 'data-art-id': 'A2' })[k] ?? null,
      set data(v: unknown) {
        sets++;
        data = v;
      },
      get data() {
        return data;
      },
    };
    m.fcHydrate(el);
    m.fcHydrate(el);
    expect(sets).toBe(1);
    expect(data).toMatchObject({ id: 'A2', kind: 'image', url: '/api/dashboard/session/c/artifacts/A2/content' });
    files.A2 = { ...png, size: 4096 };
    m.fcHydrate(el);
    expect(sets).toBe(2);
    const stray = { getAttribute: (k: string) => (k === 'data-art-id' ? 'nope' : 'c'), data: undefined };
    m.fcHydrate(stray);
    expect(stray.data).toBeUndefined();
  });

  it('every card in the document is hydrated (added, or its data-art-v changed); ui-open opens the viewer at it', () => {
    // D7 (I-09): the same observer hands <ui-media-grid data-um> its pictures (and again when its ids change).
    expect(TEMPLATE).toContain("attributeFilter: ['data-art-v', 'data-um']");
    expect(TEMPLATE).toContain("var FC_HYDRATE_SEL = 'ui-file-card[data-art-id], ui-media-grid[data-um]';");
    expect(TEMPLATE).toContain('if (node.matches(FC_HYDRATE_SEL)) fcHydrate(node);');
    expect(TEMPLATE).toContain(
      "} else if (t.localName === 'ui-media-grid' && t.hasAttribute('data-art-cid') && e.detail && e.detail.id) {",
    );
    expect(TEMPLATE).toContain("document.addEventListener('ui-open', function(e) {");
    expect(TEMPLATE).toContain("openArtifactViewer(t.getAttribute('data-art-cid'), t.getAttribute('data-art-id'), t);");
    // The card is the viewer's opener: focus comes back to it (0.10.0 card.focus() reaches its button itself).
    expect(clientFn('openArtifactViewer')).toContain(
      "v.open(artViewerItems(cid, list), at, opener && typeof opener.focus === 'function' ? opener : null);",
    );
    expect(TEMPLATE).not.toContain("opener.shadowRoot.querySelector('button')");
    for (const mod of ['file-card', 'hovercard', 'artifact-viewer']) {
      expect(TEMPLATE).toContain(`<script type="module" src="/dashboard/ui/${mod}.js?v=\${UI_LIB_VERSION}"></script>`);
    }
  });
});

describe('T6 — right panel: pinned strip and per-answer attachments', () => {
  const panel = () =>
    load<{
      renderPanelArtifacts(list: unknown[], cid: string): string;
      renderTurnArtifacts(list: unknown[], cid: string, startTs: number, endTs: number): string;
    }>(
      [...BASE_FNS, 'artSortForDisplay', 'artTile', 'artInTurn', 'renderPanelArtifacts', 'renderTurnArtifacts'],
      BASE_VARS,
    );

  it('the strip has a count header and every artifact', () => {
    const out = panel().renderPanelArtifacts([html, png, wav, answer], 'conv-9');
    expect(out).toContain('산출물');
    expect(out).toContain('art-count');
    for (const id of ['A1', 'A2', 'A3', 'A4']) expect(out).toContain(`data-art-id="${id}"`);
    expect(panel().renderPanelArtifacts([], 'conv-9')).toBe('');
  });

  it('an answer turn shows the files its turn produced — matched by the turn start, not by guesswork', () => {
    const inTurn = { ...png, turnStartedAt: 1000, createdAt: 1500 };
    const otherTurn = { ...html, turnStartedAt: 5000, createdAt: 5200 };
    const out = panel().renderTurnArtifacts([inTurn, otherTurn], 'c', 900, 2000);
    expect(out).toContain('data-art-id="A2"');
    expect(out).not.toContain('data-art-id="A1"');
    expect(panel().renderTurnArtifacts([otherTurn], 'c', 900, 2000)).toBe('');
  });

  it('panel markup, turn hook and live push are wired', () => {
    expect(TEMPLATE).toContain('id="panel-artifacts"');
    // D3: an answer's files are <ui-conversation>'s attachments-<turn id> slot, filled by the page (convSlots);
    // D6b (D3 G1-2): a system turn's files its media-<turn id> slot.
    expect(clientFn('convTurnsOf')).toContain(
      "slots.push({ name: 'attachments-' + id, kind: 'arts', list: mine, start: start, end: ts });",
    );
    expect(clientFn('convTurnsOf')).toContain(
      "slots.push({ name: 'media-' + id, kind: 'media', list: atts, turn: t });",
    );
    expect(clientFn('convSlots')).toContain('renderTurnArtifacts(sl.list, cid, sl.start, sl.end)');
    expect(TEMPLATE).toMatch(/msg\.type === 'artifact_update'/);
  });
});

type FakeEl = {
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
};
const fakeEl = (attrs: Record<string, string>): FakeEl => ({
  getAttribute: (k) => attrs[k] ?? null,
  hasAttribute: (k) => k in attrs,
});
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('T2 — hover peek: @2lab.ai/ui <ui-hovercard>, one card for every tile; its inside the library’s peekHtml (D4 I-05, D6b)', () => {
  type Item = Record<string, unknown>;
  /** The library's peek as the page reaches it (window.uiPeek): what it was handed, in one tag. */
  const uiPeek = {
    html: (item: Item, lang: string) =>
      `<peek ${item.id} ${lang}${item.scripts ? ' scripts' : ''}${item.text != null ? ' text' : ''}${item.head != null ? ' head' : ''}>`,
    kind: (item: Item) => `k:${item.kind}`,
  };
  const peek = (docs: Record<string, string> = {}, extra: Record<string, unknown> = {}) =>
    load<{
      artPeekItem(cid: string, a: Art): Item;
      artPeekHtml(item: Item, p: typeof uiPeek): string;
      onArtPeekOpen(e: unknown): void;
    }>(
      [...BASE_FNS, 'umMissingReason', 'artViewItem', 'artIsDoc', 'artPeekItem', 'artPeekHtml', 'onArtPeekOpen'],
      BASE_VARS,
      {
        _artDocCache: docs,
        window: { uiPeek },
        ...extra,
      },
    );

  it('is one element whose `for` reaches every trigger: file cards, the face chips in the inbox, user image tiles', () => {
    expect(TEMPLATE).toContain(
      '<ui-hovercard id="art-peek" for="ui-file-card[data-art-id], .ib-chip[data-art], .mg-tile[data-mk]" width="360"></ui-hovercard>',
    );
    // The element owns the hover intent, the grace, the swap, keyboard focus, Esc, a press, the scroll-away and
    // the placement: the page keeps no timers, no positioning and no listeners of its own for the peek — and, since
    // 0.12.0, no renderer and no rules for its inside (D4 G5-3).
    for (const gone of [
      'ART_PEEK_DELAY_MS',
      'ART_PEEK_CLOSE_MS',
      'function showArtPeek(',
      'function hideArtPeek(',
      'function artHandleKey(',
      'var _artPeek',
      'role="tooltip"',
      'function renderArtPeekBody(',
      'function artPeekFillDoc(',
      'ART_PEEK_LINES',
      '.art-peek-media',
      '.art-peek-foot',
      'art-doc-loading',
      'ART_GLYPH',
      'function artGlyph(',
      'function artMeta(',
      'function artKindLabel(',
      'function artFormatSize(',
    ]) {
      expect(TEMPLATE, gone).not.toContain(gone);
    }
    expect(TEMPLATE).not.toMatch(/\.art-peek \{/);
    expect(TEMPLATE).toContain('#art-peek { --ui-hovercard-z: 1000; }');
    expect(TEMPLATE).toContain("peek.addEventListener('ui-open', onArtPeekOpen);");
    expect(TEMPLATE).toContain("peek.addEventListener('ui-closed', onArtPeekClosed);");
  });

  it('the library’s peekHtml and its sheet reach the page through one module, in place before <ui-hovercard> is defined', () => {
    const bridge = TEMPLATE.indexOf(
      "import { peekHtml, peekPageCss } from '/dashboard/ui/artifact-viewer.js?v=${UI_LIB_VERSION}';",
    );
    expect(bridge).toBeGreaterThan(-1);
    expect(TEMPLATE).toContain("import { fileItemKind } from '/dashboard/ui/file-card.js?v=${UI_LIB_VERSION}';");
    expect(TEMPLATE).toContain('sheet.textContent = peekPageCss;');
    expect(TEMPLATE).toContain('window.uiPeek = { html: peekHtml, kind: fileItemKind };');
    // Modules run in document order: the bridge sits before the hovercard's own tag.
    expect(bridge).toBeLessThan(TEMPLATE.indexOf('<script type="module" src="/dashboard/ui/hovercard.js'));
    // The page adds the press (the media opens the viewer) and the markdown head's rules under the element's classes
    // — the artifact-viewer entry exports no mdDocCss (D6-GAPS); no .md-doc rule of the page's.
    expect(TEMPLATE).toContain('#art-peek .av-pk-media { cursor: zoom-in; }');
    expect(TEMPLATE).toContain("e.target.closest('#art-peek .av-pk-media')");
    expect(TEMPLATE).toMatch(/#art-peek \.av-pk-doc code \{/);
  });

  it('resolves the trigger to its file: a keyed card / tile, or a face chip by its data-key through the session', () => {
    const files: Record<string, Art> = { A1: html, A2: png };
    const { artPeekTarget } = load<{ artPeekTarget(t: unknown): { cid: string; a: Art } | null }>(
      ['artPeekTarget'],
      [],
      {
        artFind: (cid: string, id: string) => (cid === 'conv-1' ? (files[id] ?? null) : null),
        _sessionCache: { 'inst::work:C1:1.2': { conversationId: 'conv-1' } },
      },
    );
    expect(artPeekTarget(fakeEl({ 'data-art-cid': 'conv-1', 'data-art-id': 'A2' }))).toEqual({ cid: 'conv-1', a: png });
    // The inbox's chip: data-art is the file, data-key "art:<session key>:<file>" names the session (keys carry ':').
    expect(artPeekTarget(fakeEl({ 'data-art': 'A1', 'data-key': 'art:inst::work:C1:1.2:A1' }))).toEqual({
      cid: 'conv-1',
      a: html,
    });
    expect(artPeekTarget(fakeEl({ 'data-art': 'A1', 'data-key': 'art:unknown:A1' }))).toBeNull();
    // D7 (I-09): a tile in <ui-media-grid>'s shadow root — the grid (its host) carries the conversation, the tile its id.
    const grid = fakeEl({ 'data-art-cid': 'conv-1' });
    const tile = {
      ...fakeEl({ 'data-mk': 'A2' }),
      classList: { contains: (c: string) => c === 'mg-tile' },
      getRootNode: () => ({ host: grid }),
    };
    expect(artPeekTarget(tile)).toEqual({ cid: 'conv-1', a: png });
    expect(artPeekTarget(fakeEl({ 'data-art-cid': 'conv-1', 'data-art-id': 'nope' }))).toBeNull();
    expect(artPeekTarget(null)).toBeNull();
  });

  it('the item the peek is handed is the viewer’s (url, kind word, scripts for the model’s html) under the kind’s tint; a document carries its text, else the head in hand', () => {
    const p = peek({ 'c|A4|head': '# 결과' });
    expect(p.artPeekItem('c', png)).toMatchObject({
      id: 'A2',
      kind: 'image',
      url: '/api/dashboard/session/c/artifacts/A2/content',
    });
    expect(p.artPeekItem('c', html)).toMatchObject({ scripts: true });
    expect(p.artPeekItem('c', { ...html, source: 'user_upload' })).not.toHaveProperty('scripts');
    // The head cached by the peek's own fetch; the whole text once the viewer fetched it (then no head).
    expect(p.artPeekItem('c', answer)).toMatchObject({ kindLabel: '답변', head: '# 결과' });
    expect(p.artPeekItem('c', answer)).not.toHaveProperty('text');
    const whole = peek({ 'c|A4': '# 결과\n\n배포 완료', 'c|A4|head': '# 결과' });
    expect(whole.artPeekItem('c', answer)).toMatchObject({ text: '# 결과\n\n배포 완료' });
    expect(whole.artPeekItem('c', answer)).not.toHaveProperty('head');
    // Not a document, or no copy here: no head at all.
    expect(peek({ 'c|A5|head': 'x' }).artPeekItem('c', bigMov)).not.toHaveProperty('head');
    // The wrapper carries the kind the library resolves (its tints key on [data-kind]).
    expect(p.artPeekHtml(p.artPeekItem('c', png), uiPeek)).toBe(
      '<div class="art-peek" data-kind="k:image"><peek A2 ko></div>',
    );
  });

  it('ui-open fills the card with the library’s peek for the trigger; a document’s head is fetched once and the card refilled while it still shows that file; an unknown file (or no library yet) refuses the card', async () => {
    const docs: Record<string, string> = {};
    const asked: string[] = [];
    let settle: (() => void) | null = null;
    let trigger: FakeEl | null = null;
    const p = peek(docs, {
      artPeekTarget: (t: FakeEl | null) => {
        const id = t ? t.getAttribute('data-art-id') : null;
        return id === 'A2' ? { cid: 'c', a: png } : id === 'A4' ? { cid: 'c', a: answer } : null;
      },
      artDocHead: (cid: string, id: string) => {
        asked.push(`${cid}|${id}`);
        return new Promise<void>((r) => {
          settle = () => {
            docs['c|A4|head'] = '# 결과';
            r();
          };
        });
      },
    });
    const card = {
      innerHTML: '',
      get trigger() {
        return trigger;
      },
    };
    let prevented = 0;
    const ev = (t: FakeEl) => ({ target: card, detail: { trigger: t }, preventDefault: () => prevented++ });
    trigger = fakeEl({ 'data-art-id': 'A2' });
    p.onArtPeekOpen(ev(trigger));
    expect(card.innerHTML).toBe('<div class="art-peek" data-kind="k:image"><peek A2 ko></div>');
    expect(asked).toEqual([]);
    // A document without its head: the glyph card now, the head once it lands.
    trigger = fakeEl({ 'data-art-id': 'A4' });
    p.onArtPeekOpen(ev(trigger));
    expect(card.innerHTML).toBe('<div class="art-peek" data-kind="k:markdown"><peek A4 ko></div>');
    expect(asked).toEqual(['c|A4']);
    (settle as unknown as () => void)();
    await flush();
    expect(card.innerHTML).toBe('<div class="art-peek" data-kind="k:markdown"><peek A4 ko head></div>');
    // The head in hand: no second fetch.
    p.onArtPeekOpen(ev(trigger));
    expect(asked).toEqual(['c|A4']);
    expect(card.innerHTML).toBe('<div class="art-peek" data-kind="k:markdown"><peek A4 ko head></div>');
    // The pointer moved on before the head landed: the card shows the other file, untouched by the late head.
    delete docs['c|A4|head'];
    p.onArtPeekOpen(ev(trigger));
    expect(asked).toEqual(['c|A4', 'c|A4']);
    trigger = fakeEl({ 'data-art-id': 'A2' });
    p.onArtPeekOpen(ev(trigger));
    (settle as unknown as () => void)();
    await flush();
    expect(card.innerHTML).toBe('<div class="art-peek" data-kind="k:image"><peek A2 ko></div>');
    // Refused: a file the page does not know, and the library's peek not yet reached.
    p.onArtPeekOpen(ev(fakeEl({ 'data-art-id': 'nope' })));
    expect(prevented).toBe(1);
    peek(docs, { artPeekTarget: () => ({ cid: 'c', a: png }), window: {} }).onArtPeekOpen(ev(trigger));
    expect(prevented).toBe(2);
    // ui-closed drops the preview (a playing clip, the iframe).
    expect(clientFn('onArtPeekClosed')).toContain("e.target.innerHTML = '';");
  });

  it('a document’s head: the first 64 KB over a Range request, one request however many ask, the whole text when in hand; a failed fetch is asked again', async () => {
    const docs: Record<string, string> = {};
    const pending: Record<string, unknown> = {};
    const calls: Array<{ url: string; range: string | undefined }> = [];
    let reply: { ok: boolean; text: () => Promise<string> } = { ok: true, text: async () => 'head text' };
    const m = load<{
      artDocHead(cid: string, id: string): Promise<string>;
      artDocText(cid: string, id: string): Promise<string>;
    }>(['artDocFetch', 'artDocText', 'artDocHead'], [], {
      _artDocCache: docs,
      _artDocPending: pending,
      artUrl: (cid: string, id: string) => `/u/${cid}/${id}`,
      fetch: (url: string, init?: { headers?: Record<string, string> }) => {
        calls.push({ url, range: init?.headers?.Range });
        return Promise.resolve(reply);
      },
    });
    const [a, b] = await Promise.all([m.artDocHead('c', 'A4'), m.artDocHead('c', 'A4')]);
    expect([a, b]).toEqual(['head text', 'head text']);
    expect(calls).toEqual([{ url: '/u/c/A4', range: 'bytes=0-65535' }]);
    expect(docs['c|A4|head']).toBe('head text');
    expect(pending).toEqual({});
    // The whole text in hand (the viewer fetched it): no request at all; the viewer's own fetch has no range.
    docs['c|A9'] = 'whole';
    expect(await m.artDocHead('c', 'A9')).toBe('whole');
    expect(await m.artDocText('c', 'A9')).toBe('whole');
    expect(calls).toHaveLength(1);
    await m.artDocText('c', 'A4');
    expect(calls[1]).toEqual({ url: '/u/c/A4', range: undefined });
    expect(docs['c|A4']).toBe('head text');
    // A failure is not kept: the next asker fetches again.
    reply = { ok: false, text: async () => '' };
    await expect(m.artDocHead('c', 'A5')).rejects.toThrow('HTTP');
    expect(pending).toEqual({});
    reply = { ok: true, text: async () => 'x'.repeat(70000) };
    expect((await m.artDocHead('c', 'A5')).length).toBe(65536);
    expect(calls.filter((c) => c.url === '/u/c/A5')).toHaveLength(2);
    // The viewer's cap is 2 MB (the test above keeps the shipped number pinned).
    expect(clientFn('artDocText')).toContain('2000000');
  });
});

describe('T3 — the viewer: @2lab.ai/ui <ui-artifact-viewer tiles="none"> over the page\'s own cards (D4 I-06 / I-07)', () => {
  const api = (docs: Record<string, string> = {}) =>
    load<{
      artViewItem(cid: string, a: Art): Record<string, unknown>;
    }>([...BASE_FNS, 'umMissingReason', 'artViewItem'], BASE_VARS, { _artDocCache: docs });

  it('is one element with no tiles of its own; the page keeps no dialog, no body renderer, no keys', () => {
    expect(TEMPLATE).toContain('<ui-artifact-viewer id="art-viewer" tiles="none" lang="ko"></ui-artifact-viewer>');
    for (const gone of [
      '<dialog id="art-modal"',
      'function renderArtModalBody(',
      'function renderArtModal(',
      'function artModalStep(',
      'function closeArtifactModal(',
      'function artModalClosed(',
      'function openArtifactModal(',
      'function dialogCloseSoftly(',
      'function dialogKeep(',
      'var _artModal',
    ]) {
      expect(TEMPLATE, gone).not.toContain(gone);
    }
    expect(TEMPLATE).not.toMatch(/\.art-modal\b|\.art-full-(img|imgwrap|audio|video|meta|doc)\b/);
  });

  it('the item the viewer pages: url, size, time; a final answer keeps its kind word 답변; a document carries its text once fetched', () => {
    expect(api().artViewItem('c', png)).toEqual({
      id: 'A2',
      name: 'chart.png',
      kind: 'image',
      size: 2048,
      time: 1792733001000,
      url: '/api/dashboard/session/c/artifacts/A2/content',
    });
    expect(api().artViewItem('c', answer)).toMatchObject({ id: 'A4', kind: 'markdown', kindLabel: '답변' });
    expect(api().artViewItem('c', answer)).not.toHaveProperty('text');
    expect(api({ 'c|A4': '# 결과\n\n배포 완료' }).artViewItem('c', answer)).toMatchObject({
      text: '# 결과\n\n배포 완료',
    });
  });

  it('a file only Slack has: no url, why, and the Slack permalink as the viewer action (https only)', () => {
    const item = api().artViewItem('c', bigMov);
    expect(item).not.toHaveProperty('url');
    expect(item.meta).toContain('사본이 없습니다');
    expect(item.actions).toEqual([
      { id: 'slack', label: 'Slack에서 열기', href: 'https://example.slack.com/files/U/F5/huge.mov' },
    ]);
    expect(api().artViewItem('c', { ...bigMov, permalink: 'javascript:alert(1)' })).not.toHaveProperty('actions');
    // A stored file with a permalink gets the action beside the element's 새 탭 / 다운로드.
    expect(
      api().artViewItem('c', { ...png, permalink: 'https://example.slack.com/files/U/F2/chart.png' }).actions,
    ).toHaveLength(1);
  });

  it("D6b (0.12.0, D4 G5-1 / G5-2): the model's html runs its scripts in the element's frame (items[].scripts — never a user's upload); a stored pdf is framed (items[].frame); the page slots no body", () => {
    expect(api().artViewItem('c', html)).toMatchObject({ scripts: true });
    expect(api().artViewItem('c', { ...html, source: 'user_upload' })).not.toHaveProperty('scripts');
    expect(api().artViewItem('c', { ...html, stored: false })).not.toHaveProperty('scripts');
    // Only the page's own route (same origin) is vouched for: a stored PDF; one only Slack has is the calm card.
    expect(api().artViewItem('c', { id: 'P', name: 'a.pdf', kind: 'pdf', stored: true })).toMatchObject({
      frame: true,
      url: '/api/dashboard/session/c/artifacts/P/content',
    });
    expect(api().artViewItem('c', { id: 'P', name: 'a.pdf', kind: 'pdf', stored: false })).not.toHaveProperty('frame');
    for (const a of [png, wav, answer, bigMov, { ...bigMov, stored: true }]) {
      expect(api().artViewItem('c', a)).not.toHaveProperty('scripts');
      expect(api().artViewItem('c', a)).not.toHaveProperty('frame');
    }
    // No slot, no page body, no rules for it; the viewer is listened to on ui-view alone (nothing to put in before
    // a body renders) and let go of on ui-closed — every close, after the exit (D4 G5-4), not the person's ui-close
    // with a timer of the page's.
    for (const gone of [
      'function artViewerPreview(',
      'function artViewerSlot(',
      'slot="preview"',
      '.art-viewer-preview',
      'art-full-frame',
      'ui-before-view',
      "viewer.addEventListener('ui-close'",
      '}, 240);',
    ]) {
      expect(TEMPLATE, gone).not.toContain(gone);
    }
    expect(TEMPLATE).toContain("viewer.addEventListener('ui-view', function(e) { syncArtViewer(e.detail); });");
    expect(TEMPLATE).toContain("viewer.addEventListener('ui-closed', function() {");
    expect(TEMPLATE).toContain("if (!artViewerIsOpen()) _artViewer = { cid: null, scope: 'conversation', list: [] };");
    expect(clientFn('openArtifactViewer')).not.toContain('artViewerSlot');
  });

  it('P2: a document shown before its text is here is fetched once (the request under way is shared) and the list handed back with it', async () => {
    const docs: Record<string, string> = {};
    const pending: Record<string, unknown> = {};
    const calls: string[] = [];
    let settle: (() => void) | null = null;
    const viewer = { index: 0, data: null as unknown };
    const m = load<{ syncArtViewer(d: { id: string } | null): void }>(
      [
        ...BASE_FNS,
        'umMissingReason',
        'artViewItem',
        'artViewerItems',
        'artIsDoc',
        'artDocFetch',
        'artDocText',
        'syncArtViewer',
      ],
      BASE_VARS,
      {
        _artDocCache: docs,
        _artDocPending: pending,
        _artViewer: { cid: 'c', scope: 'conversation', list: [answer, png] },
        artViewerEl: () => viewer,
        artViewerIsOpen: () => viewer.index >= 0,
        fetch: (url: string) => {
          calls.push(url);
          return new Promise((r) => {
            settle = () => r({ ok: true, text: async () => '# 결과' });
          });
        },
      },
    );
    // Two notices for the same file (a step away and back before the text lands): one request.
    m.syncArtViewer({ id: 'A4' });
    m.syncArtViewer({ id: 'A4' });
    expect(calls).toEqual(['/api/dashboard/session/c/artifacts/A4/content']);
    expect(viewer.data).toBeNull();
    (settle as unknown as () => void)();
    await flush();
    await flush();
    expect((viewer.data as { items: Array<{ id: string; text?: string }> }).items.map((i) => [i.id, i.text])).toEqual([
      ['A4', '# 결과'],
      ['A2', undefined],
    ]);
    // In hand now: nothing to fetch. An image: nothing to fetch. A closed viewer: nothing handed back.
    viewer.data = null;
    m.syncArtViewer({ id: 'A4' });
    m.syncArtViewer({ id: 'A2' });
    m.syncArtViewer(null);
    expect(calls).toHaveLength(1);
    expect(viewer.data).toBeNull();
  });

  it('opens over the conversation (files newest first, then answers) at the file, with the opener; a file not yet listed joins; the list is fetched', () => {
    const opened: unknown[] = [];
    const fetched: string[] = [];
    const paused: number[] = [];
    const viewer = {
      index: -1,
      open: (...a: unknown[]) => {
        opened.push(a);
      },
    };
    const run = (cache: Record<string, unknown>, id: string, opener: unknown = { focus() {} }) => {
      const m = load<{ openArtifactViewer(cid: string, id: string, opener: unknown): void }>(
        [
          ...BASE_FNS,
          'umSiblings',
          'umMissingReason',
          'artSortForDisplay',
          'artViewItem',
          'artViewerItems',
          'openArtifactViewer',
        ],
        [...BASE_VARS, '_artDocCache', '_artViewer'],
        {
          artViewerEl: () => viewer,
          _artCache: cache,
          artFind: (_cid: string, fid: string) => ({ A1: html, A2: png, A9: { ...wav, id: 'A9' } })[fid] ?? null,
          ensureArtifacts: (cid: string) => fetched.push(cid),
          pauseArtCards: () => paused.push(1),
        },
      );
      m.openArtifactViewer('c', id, opener);
    };
    const opener = { focus() {} };
    run({ c: { state: 'ok', list: [html, answer, png] } }, 'A2', opener);
    expect(opened).toHaveLength(1);
    const [items, at, who] = opened[0] as [Array<{ id: string; scripts?: boolean }>, number, unknown];
    expect(items.map((i) => i.id)).toEqual(['A2', 'A1', 'A4']);
    // The model's page goes in with its scripts flag: the element's own frame runs it (nothing slotted first).
    expect(items.map((i) => i.scripts)).toEqual([undefined, true, undefined]);
    expect(at).toBe(0);
    expect(who).toBe(opener);
    expect(fetched).toEqual([]);
    expect(paused).toEqual([1]);
    // Not in the cached list (a face chip before the fetch): it joins the page list; the full list is fetched.
    run({ c: { state: 'loading', list: [html] } }, 'A9');
    expect((opened[1] as [Array<{ id: string }>])[0].map((i) => i.id)).toEqual(['A9', 'A1']);
    expect(fetched).toEqual(['c']);
    // An opener that cannot take focus is not handed over.
    run({ c: { state: 'ok', list: [png] } }, 'A2', {});
    expect((opened[2] as unknown[])[2]).toBeNull();
    // Nothing the page knows: no open.
    run({}, 'zzz');
    expect(opened).toHaveLength(3);
  });

  it('Escape in the viewer does not also close the slide panel', () => {
    // The cron drawer over a docked panel takes Escape first too (SSOT 2026-10-24, trinity R4).
    // SSOT 2026-10-29 T2: what Escape closes is the front detail card (closeDetailCard folds its card too).
    // D1: an element on top (menu, <ui-dialog>, <ui-drawer>) that took the Escape (defaultPrevented) keeps it;
    // D4: the viewer's own <ui-dialog> is one of them, and artViewerIsOpen() reads the element's index.
    expect(TEMPLATE).toMatch(
      /if \(e\.key === 'Escape' && !e\.defaultPrevented && panelOpen && !artViewerIsOpen\(\) && !_cronDrawerKey\) closeDetailCard\(\);/,
    );
    expect(clientFn('artViewerIsOpen')).toContain("typeof v.index === 'number' && v.index >= 0");
    // N (the New task key) does nothing while the viewer is up.
    expect(clientFn('ntIsTypingTarget')).toContain(
      "document.querySelector('dialog[open], ui-dialog[open]') || artViewerIsOpen()",
    );
  });
});

describe("T1 — markdown answers are the viewer's document: one renderer, the library's", () => {
  it('the page keeps no markdown renderer or document styles of its own for artifacts', () => {
    for (const gone of ['function renderMarkdownDoc(', 'function mdInline(', 'function fillArtDocs(']) {
      expect(TEMPLATE, gone).not.toContain(gone);
    }
    expect(TEMPLATE).not.toMatch(/\.md-doc\b/);
    expect(TEMPLATE).not.toMatch(/\.art-text\b/);
  });
});

describe('T5/T6 — a new artifact reaches the open card and panel at once (review gate P1)', () => {
  function live(cache: Record<string, unknown>, opts: { expanded?: string[]; panelConvId?: string | null } = {}) {
    const fetched: Array<[string, boolean]> = [];
    const settled: string[] = [];
    const fns = load<{ onArtifactUpdate(cid: string, a: unknown): void }>(['onArtifactUpdate'], [], {
      _artCache: cache,
      _expanded: new Set(opts.expanded ?? []),
      _sessionCache: { k1: { conversationId: 'c1' }, k2: { conversationId: 'c2' } },
      panelOpen: !!opts.panelConvId,
      panelConvId: opts.panelConvId ?? null,
      ensureArtifacts: (cid: string, force: boolean) => {
        fetched.push([cid, force]);
        return Promise.resolve([]);
      },
      artSettle: (cid: string) => settled.push(cid),
    });
    return { ...fns, fetched, settled };
  }

  it('a card opened before its first artifact fetches the full list when one lands', () => {
    const t = live({}, { expanded: ['k1'] });
    t.onArtifactUpdate('c1', png);
    expect(t.fetched).toEqual([['c1', true]]);
  });

  it('a cached list merges the new artifact and re-renders; an unrelated conversation fetches nothing', () => {
    const cache: Record<string, { state: string; list: Art[] }> = { c1: { state: 'ok', list: [html] } };
    const t = live(cache, { expanded: ['k1'] });
    t.onArtifactUpdate('c1', png);
    expect(cache.c1.list.map((a) => a.id)).toEqual(['A1', 'A2']);
    expect(t.settled).toEqual(['c1']);
    const idle = live({}, { expanded: ['k2'] });
    idle.onArtifactUpdate('c1', png);
    expect(idle.fetched).toEqual([]);
  });

  it('the open panel fetches too', () => {
    const t = live({}, { panelConvId: 'c1' });
    t.onArtifactUpdate('c1', png);
    expect(t.fetched).toEqual([['c1', true]]);
  });
});

describe('review gate — the open viewer follows the list', () => {
  function settle(scope: string, cache: Record<string, unknown>) {
    const fake: { data?: { items: unknown[] } } = {};
    const live = { cid: 'c1', scope, list: [] as unknown[] };
    const { artSettle } = load<{ artSettle(cid: string): void }>(['toNum', 'artSettle', 'artSortForDisplay'], [], {
      _expanded: new Set<string>(),
      _sessionCache: {},
      refreshCard: () => {},
      panelOpen: false,
      panelConvId: null,
      renderPanelArtifactsSection: () => {},
      _artCache: cache,
      _artViewer: live,
      artViewerIsOpen: () => true,
      artViewerEl: () => fake,
      artViewerItems: (_cid: string, list: Art[]) => list.map((a) => a.id),
    });
    artSettle('c1');
    return { fake, live };
  }

  it('a new list (a push, the fetch after a face chip opened it) is handed to the viewer, sorted; the element keeps the shown file', () => {
    const { fake, live } = settle('conversation', { c1: { state: 'ok', list: [answer, html, png] } });
    expect(fake.data).toEqual({ items: ['A2', 'A1', 'A4'] });
    expect((live.list as Art[]).map((a) => a.id)).toEqual(['A2', 'A1', 'A4']);
  });

  it("an instruction's attachments are not the conversation's list: left alone", () => {
    const { fake } = settle('attachments', { c1: { state: 'ok', list: [png] } });
    expect(fake.data).toBeUndefined();
  });
});
