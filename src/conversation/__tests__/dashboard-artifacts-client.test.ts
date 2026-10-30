/**
 * SSOT 2026-10-23 — dashboard artifacts, client half. Executes the shipped page
 * code (cut out of renderDashboardPage()'s template literal and cooked exactly
 * as the browser receives it — the harness of dashboard-live-surfaces-client.test.ts):
 *
 *   T5  collapsed card face: an artifact row the board shows at a glance (cardOf's
 *       artifacts, drawn by <ui-agent-inbox>, a chip opens the viewer);
 *       expanded card: a "산출물" strip of thumbnails, audio playable in place
 *   T6  right panel: a pinned artifact strip, and the files each answer produced
 *   T2  hover → minimap preview (html rendered without scripts, no autoplay)
 *   T3  click → full-size modal (html sandboxed, image, markdown rendered)
 *   T8  html / png / wav: viewable and playable immediately
 *   T1  markdown final answers render as documents, safely
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

const BASE_FNS = [
  'esc',
  'escAttr',
  'escJs',
  'toNum',
  'umGet',
  'umUrl',
  'artUrl',
  'artFormatSize',
  'artKindLabel',
  'artGlyph',
  'artMeta',
  'artFileItem',
  'artCard',
  'artChip',
];
const BASE_VARS = ['ART_KIND_LABEL', 'ART_GLYPH', '_userMedia', 'CARD_ART_TILES'];

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
const CARD_OF_VARS = ['PR_STATE_LABEL', 'PR_STATE_TONE', 'AGENT_STATUS_LABEL', 'AGENT_STATUS_TONE', 'AGENT_STATUS_GLYPH', 'OWNER_BADGE_HUES'];

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
    const { wireInbox } = load<{ wireInbox(h: unknown): void }>(['inboxChipOf', 'wireInbox'], [], {
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
      openArtifactModal: (...args: unknown[]) => opened.push(args),
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
      [...BASE_FNS, 'artSortForDisplay', 'artAudioPlaying', 'artTile', 'artListFor', 'renderCardArtifacts'],
      BASE_VARS,
      { _artCache: cache, _artAudio: { el: null, key: null } },
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
      '<ui-file-card class="art-card" variant="tile" lang="ko" data-art-cid="conv-1" data-art-id="A2"',
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

  it('T8 — an audio tile carries an inline play button; a file without bytes says it is on Slack', () => {
    const out = body({ c: { state: 'ok', list: [wav, bigMov] } }).renderCardArtifacts({
      conversationId: 'c',
      artifacts: { count: 2, recent: [] },
    });
    expect(out).toMatch(/data-art-play="1"[^>]*data-art-id="A3"|data-art-id="A3"[^>]*data-art-play="1"/);
    // The remote file's tile is marked; its card's meta line says 'Slack에만 있음' (artFileItem).
    expect(out).toContain('<div class="art-tile is-remote">');
  });

  it('T8 — a live re-render keeps a playing clip marked playing (the card body is morphed on every push)', () => {
    const playing = (key: string | null, paused: boolean) =>
      load<{ renderCardArtifacts(s: unknown): string }>(
        [...BASE_FNS, 'artSortForDisplay', 'artAudioPlaying', 'artTile', 'artListFor', 'renderCardArtifacts'],
        BASE_VARS,
        { _artCache: { c: { state: 'ok', list: [wav] } }, _artAudio: { el: { paused }, key } },
      ).renderCardArtifacts({ conversationId: 'c', artifacts: { count: 1, recent: [] } });
    const btn = (out: string) => out.match(/<button[^>]*data-art-play="1"[^>]*>/)?.[0] ?? '';
    expect(btn(playing('c|A3', false))).toMatch(/class="art-play is-playing"/);
    expect(btn(playing('c|A3', false))).toContain('aria-pressed="true"');
    expect(btn(playing('c|A3', true))).not.toContain('is-playing');
    expect(btn(playing('other|A3', false))).toContain('aria-pressed="false"');
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
    expect(TEMPLATE).toContain("attributeFilter: ['data-art-v']");
    expect(TEMPLATE).toContain("if (node.matches('ui-file-card[data-art-id]')) fcHydrate(node);");
    expect(TEMPLATE).toContain("document.addEventListener('ui-open', function(e) {");
    expect(TEMPLATE).toContain("openArtifactModal(t.getAttribute('data-art-cid'), t.getAttribute('data-art-id'), t);");
    // Focus goes back to the card's button (the card itself takes no focus).
    expect(TEMPLATE).toContain(
      "var inner = opener && opener.shadowRoot ? opener.shadowRoot.querySelector('button') : null;",
    );
    expect(TEMPLATE).toContain('<script type="module" src="/dashboard/ui/file-card.js?v=${UI_LIB_VERSION}"></script>');
  });
});

describe('T6 — right panel: pinned strip and per-answer attachments', () => {
  const panel = () =>
    load<{
      renderPanelArtifacts(list: unknown[], cid: string): string;
      renderTurnArtifacts(list: unknown[], cid: string, startTs: number, endTs: number): string;
    }>(
      [
        ...BASE_FNS,
        'artSortForDisplay',
        'artAudioPlaying',
        'artTile',
        'artInTurn',
        'renderPanelArtifacts',
        'renderTurnArtifacts',
      ],
      BASE_VARS,
      { _artAudio: { el: null, key: null } },
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
    expect(clientFn('renderTurn')).toContain('renderTurnArtifacts(');
    expect(TEMPLATE).toMatch(/msg\.type === 'artifact_update'/);
  });
});

describe('T2 — hover minimap', () => {
  const peek = () =>
    load<{ renderArtPeekBody(cid: string, a: unknown): string }>([...BASE_FNS, 'renderArtPeekBody'], BASE_VARS);

  it('html renders live but without scripts (sandbox with no tokens)', () => {
    const out = peek().renderArtPeekBody('c', html);
    expect(out).toMatch(/<iframe[^>]*sandbox=""/);
    expect(out).not.toContain('allow-scripts');
    expect(out).toContain('src="/api/dashboard/session/c/artifacts/A1/content"');
  });

  it('png shows the image; wav is playable but never autoplays', () => {
    expect(peek().renderArtPeekBody('c', png)).toMatch(
      /<img[^>]*src="\/api\/dashboard\/session\/c\/artifacts\/A2\/content"/,
    );
    const audio = peek().renderArtPeekBody('c', wav);
    expect(audio).toMatch(/<audio[^>]*controls/);
    expect(audio).not.toContain('autoplay');
  });

  it('a file without stored bytes shows its metadata instead of a broken preview', () => {
    const out = peek().renderArtPeekBody('c', bigMov);
    expect(out).not.toContain('<video');
    expect(out).toContain('huge.mov');
  });

  it('peek element exists and hover is delayed (not instant), dismissable with Escape', () => {
    expect(TEMPLATE).toContain('id="art-peek"');
    expect(TEMPLATE).toMatch(/var ART_PEEK_DELAY_MS = (3|4)\d\d;/);
    expect(clientFn('artHandleKey')).toContain("'Escape'");
  });
});

describe('T3 — full-size modal', () => {
  const modal = () =>
    load<{ renderArtModalBody(cid: string, a: unknown): string }>([...BASE_FNS, 'renderArtModalBody'], BASE_VARS);

  it('html runs sandboxed: scripts only, never same-origin', () => {
    const out = modal().renderArtModalBody('c', html);
    expect(out).toMatch(/<iframe[^>]*sandbox="allow-scripts"/);
    expect(out).not.toContain('allow-same-origin');
  });

  it('png full size, wav plays at once, a big video plays with controls', () => {
    expect(modal().renderArtModalBody('c', png)).toMatch(/<img[^>]*class="art-full-img"/);
    expect(modal().renderArtModalBody('c', wav)).toMatch(
      /<audio[^>]*controls[^>]*autoplay|<audio[^>]*autoplay[^>]*controls/,
    );
    expect(modal().renderArtModalBody('c', { ...bigMov, stored: true })).toMatch(/<video[^>]*controls/);
  });

  it('markdown is fetched and rendered into a document container', () => {
    expect(modal().renderArtModalBody('c', answer)).toContain('data-art-doc="c|A4"');
  });

  it('the dialog exists; Escape in the modal does not also close the slide panel', () => {
    expect(TEMPLATE).toMatch(/<dialog id="art-modal"/);
    // The cron drawer over a docked panel takes Escape first too (SSOT 2026-10-24, trinity R4).
    // SSOT 2026-10-29 T2: what Escape closes is the front detail card (closeDetailCard folds its card too).
    // D1: an element on top (menu, <ui-dialog>, <ui-drawer>) that took the Escape (defaultPrevented) keeps it.
    expect(TEMPLATE).toMatch(
      /if \(e\.key === 'Escape' && !e\.defaultPrevented && panelOpen && !artModalIsOpen\(\) && !_cronDrawerKey\) closeDetailCard\(\);/,
    );
  });
});

describe('T1 — markdown answers render as documents, safely', () => {
  const md = () =>
    load<{ renderMarkdownDoc(src: string): string }>(
      ['esc', 'escAttr', 'safeHref', 'mdInline', 'renderMarkdownDoc'],
      [],
    );

  it('headings, lists, tables, code, quotes, links', () => {
    const out = md().renderMarkdownDoc(
      [
        '# 결과',
        '',
        '배포가 **끝났습니다**. `npm test` 통과.',
        '',
        '- 하나',
        '- 둘',
        '',
        '1. 첫째',
        '2. 둘째',
        '',
        '| 항목 | 상태 |',
        '|---|---|',
        '| 배포 | 완료 |',
        '',
        '> 인용',
        '',
        '```ts',
        'const a = 1 < 2;',
        '```',
        '',
        '[PR](https://github.com/x/y/pull/1)',
      ].join('\n'),
    );
    expect(out).toContain('<h1>결과</h1>');
    expect(out).toContain('<strong>끝났습니다</strong>');
    expect(out).toContain('<code>npm test</code>');
    expect(out).toMatch(/<ul>\s*<li>하나<\/li>\s*<li>둘<\/li>\s*<\/ul>/);
    expect(out).toMatch(/<ol>\s*<li>첫째<\/li>/);
    expect(out).toContain('<table>');
    expect(out).toContain('<th>항목</th>');
    expect(out).toContain('<td>완료</td>');
    expect(out).toContain('<blockquote>');
    expect(out).toContain('const a = 1 &lt; 2;');
    expect(out).toContain('href="https://github.com/x/y/pull/1"');
  });

  it('raw html and javascript: links never come through', () => {
    const out = md().renderMarkdownDoc(
      '<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n<img src=x onerror=alert(1)>',
    );
    expect(out).not.toContain('<script');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('href="javascript');
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

describe('review gate — viewer keys and minimap fetch', () => {
  it('← / → page the viewer, but not while a media control has focus (seeking stays native)', () => {
    const steps: number[] = [];
    const { artHandleKey } = load<{ artHandleKey(e: unknown): void }>(['artHandleKey'], [], {
      artModalIsOpen: () => true,
      artModalStep: (d: number) => steps.push(d),
      hideArtPeek: () => {},
      _artPeek: { anchor: null },
    });
    const ev = (tag: string, key: string) => ({
      key,
      target: { tagName: tag },
      preventDefault() {},
      stopPropagation() {},
    });
    artHandleKey(ev('BUTTON', 'ArrowRight'));
    artHandleKey(ev('AUDIO', 'ArrowRight'));
    artHandleKey(ev('VIDEO', 'ArrowLeft'));
    expect(steps).toEqual([1]);
  });

  it('the minimap asks for the first 64 KB of a text artifact, not the whole file', () => {
    expect(clientFn('fillArtDocs')).toContain("Range: 'bytes=0-65535'");
  });
});
