/**
 * User media (SSOT 2026-10-25) — client half. Executes the shipped page code
 * (cut out of renderDashboardPage()'s template literal, the harness of
 * dashboard-artifacts-client.test.ts).
 *
 *   C1  panel user turn: the files sit ABOVE the instruction text — images as
 *       80px tiles (+N on the 4th past four), other files as cards, a single
 *       image in a fixed box; every tile is a button named by its action
 *   C2  the open card's 지시 row: compact thumbnails, and a files-only
 *       instruction is not "기록된 지시 없음"
 *   C3  the card face: a paperclip count only (no image is fetched on the board) —
 *       a host metric in cardOf's data, drawn by <ui-agent-inbox>
 *   C4  the viewer reuse: an id registered as user media resolves to the media
 *       content route; the viewer (@2lab.ai/ui <ui-artifact-viewer>, D4) pages within
 *       the same instruction; a user's html never gets scripts in it
 *   C5  a file without a kept copy says so and links to Slack (https only)
 *   D4  a non-image attachment is a <ui-file-card variant="row" playable> (a chip in
 *       the compact row): the card draws the glyph, name, meta and the voice note's play
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
function clientFn(name: string): string {
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
  'umRegister',
  'umGet',
  'umUrl',
  'artUrl',
  'artFileItem',
  'artCard',
  'umTile',
  'umGridHtml',
  'umGridItems',
  'mgHydrate',
  'renderUserMedia',
  'umMissingReason',
  'artViewItem',
];
const BASE_VARS = ['ART_KIND_LABEL', '_userMedia', 'UM_GRID_MAX', '_artDocCache'];

type Api = {
  umRegister(cid: string, list: unknown[], turn: unknown): void;
  umGet(cid: string, id: string): any;
  artUrl(cid: string, id: string, download?: boolean): string;
  renderUserMedia(cid: string, list: unknown[], opts?: unknown): string;
  umGridItems(cid: string, ids: string[]): Array<Record<string, string>>;
  mgHydrate(el: unknown): void;
  artFileItem(cid: string, a: unknown): Record<string, unknown>;
  artViewItem(cid: string, a: unknown): Record<string, unknown>;
};

const img = (id: string, name = `${id}.png`) => ({
  id,
  name,
  kind: 'image',
  mime: 'image/png',
  size: 2048,
  stored: true,
});
const pdf = { id: 'P1', name: 'design-guide.pdf', kind: 'pdf', mime: 'application/pdf', size: 2_200_000, stored: true };
const voice = { id: 'V1', name: 'memo.m4a', kind: 'audio', mime: 'audio/mp4', size: 30_000, stored: true };
const remote = {
  id: 'R1',
  name: 'demo.mov',
  kind: 'video',
  mime: 'video/quicktime',
  size: 9_000_000,
  stored: false,
  permalink: 'https://x.slack.com/files/U/F/demo.mov',
};
const turn = { id: 'u1', role: 'user', timestamp: 1792900000000, userName: 'Zhuge' };

describe('C1 — panel user turn: the instruction with its files', () => {
  it('images become one <ui-media-grid> (its 80px tiles named by their action); other files become cards', () => {
    const api = load<Api>(BASE_FNS, BASE_VARS);
    const list = [img('I1', 'login.png'), img('I2'), pdf, voice];
    api.umRegister('c1', list, turn);
    const out = api.renderUserMedia('c1', list);
    expect(out).toContain('class="um-media');
    // D7 (I-09): the pictures are the element's, keyed by the conversation and the stored image ids; its items
    // (id, name, the media route) reach it once it is in the document (mgHydrate, with the file cards).
    expect(out).toContain('<ui-media-grid class="um-grid" lang="ko" max="4" data-art-cid="c1" data-um="I1,I2"></ui-media-grid>');
    expect(out).not.toContain('um-tile');
    expect(api.umGridItems('c1', ['I1', 'I2', 'nope'])).toEqual([
      { id: 'I1', name: 'login.png', url: '/api/dashboard/session/c1/media/I1/content' },
      { id: 'I2', name: 'I2.png', url: '/api/dashboard/session/c1/media/I2/content' },
    ]);
    const grid: Record<string, unknown> = { getAttribute: (k: string) => ({ 'data-art-cid': 'c1', 'data-um': 'I1,I2' })[k] ?? null };
    api.mgHydrate(grid);
    expect(grid.data).toEqual({ items: api.umGridItems('c1', ['I1', 'I2']) });
    const once = grid.data;
    api.mgHydrate(grid); // the same ids: the element is not written again
    expect(grid.data).toBe(once);
    // D4: the other files are <ui-file-card variant="row" playable> in the page's box — the card draws the name,
    // "PDF · 2.1 MB" (artFileItem's size) and the voice note's play toggle; the page keeps no play button.
    expect(out).toMatch(
      /<div class="um-file art-k-pdf"><ui-file-card class="art-card" variant="row" playable lang="ko" data-art-cid="c1" data-art-id="P1"/,
    );
    expect(out).toMatch(
      /<div class="um-file art-k-audio"><ui-file-card class="art-card" variant="row" playable lang="ko" data-art-cid="c1" data-art-id="V1"/,
    );
    expect(api.artFileItem('c1', pdf)).toMatchObject({ name: 'design-guide.pdf', kind: 'pdf', size: 2_200_000 });
    expect(out).not.toContain('data-art-play');
    expect(out).not.toContain('um-open');
    // The compact row (the open card's 지시 row, the pinned row): name chips.
    expect(api.renderUserMedia('c1', [pdf], { compact: true })).toMatch(
      /<div class="um-file art-k-pdf um-file-compact"><ui-file-card class="art-card" variant="chip" playable/,
    );
  });

  it('one image shows on its own in a fixed box (no layout shift) — the element’s default when not compact', () => {
    const api = load<Api>(BASE_FNS, BASE_VARS);
    api.umRegister('c1', [img('S1')], turn);
    const out = api.renderUserMedia('c1', [img('S1')]);
    expect(out).toContain('data-um="S1"');
    expect(out).not.toContain('size="compact"');
  });

  it('more than four images: the element shows four, "+N" on the fourth (max="4"); every id still reaches it', () => {
    const api = load<Api>(BASE_FNS, BASE_VARS);
    const list = ['A', 'B', 'C', 'D', 'E', 'F'].map((x) => img(x));
    api.umRegister('c1', list, turn);
    const out = api.renderUserMedia('c1', list);
    expect(out).toContain('max="4" data-art-cid="c1" data-um="A,B,C,D,E,F"');
    expect(api.umGridItems('c1', ['A', 'B', 'C', 'D', 'E', 'F'])).toHaveLength(6);
  });

  it('a turn’s files go in <ui-conversation>’s media slot (shown above the words); registered for the viewer', () => {
    // D3: the element draws slot media-<id> above the instruction; a files-only turn has no text.
    const turns = clientFn('convTurnsOf');
    expect(turns).toContain("slots.push({ name: 'media-' + id, kind: 'media', list: atts, turn: t });");
    expect(turns).toContain('u.media = true;');
    const slots = clientFn('convSlots');
    expect(slots).toContain('umRegister(cid, sl.list, sl.turn);');
    expect(slots).toContain('renderUserMedia(cid, sl.list)');
  });
});

describe('C2 — open card 지시 row', () => {
  it('shows compact thumbnails, and a files-only instruction reads as "첨부 N개" — not "기록된 지시 없음"', () => {
    const fns = load<{ renderCardIo(s: unknown): string; umRegister: Api['umRegister'] }>(
      [...BASE_FNS, 'ioInstructionHtml', 'renderCardIo'],
      BASE_VARS,
      {
        _ioCache: {
          c2: {
            state: 'ok',
            data: { instruction: { text: '', who: 'Zhuge', attachments: [img('I9'), pdf] }, response: null },
          },
        },
      },
    );
    fns.umRegister('c2', [img('I9'), pdf], turn);
    const out = fns.renderCardIo({ conversationId: 'c2', activityState: 'idle' });
    expect(out).toContain('um-compact');
    expect(out).toContain('<ui-media-grid class="um-grid" lang="ko" size="compact" max="4" data-art-cid="c2" data-um="I9"></ui-media-grid>');
    expect(out).not.toContain('기록된 지시 없음');
    expect(out).toContain('첨부 2개');
  });

  it("fetchCardIo hands the latest user turn's attachments to the row", () => {
    const src = clientFn('fetchCardIo');
    expect(src).toContain('attachments');
    expect(src).toContain('umRegister(');
  });
});

// The face is @2lab.ai/ui <ui-agent-inbox>'s: the page hands it the paperclip as a
// host metric in the card data (cardOf); the element draws and escapes it
// ('draws face extras: lead, owner badge, host metrics, …').
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

describe('C3 — card face: a paperclip count only', () => {
  const { cardOf } = load<{ cardOf(s: unknown, col: string): Record<string, unknown> }>(CARD_OF_FNS, CARD_OF_VARS, {
    dhShow: () => true,
    dhTruncate: () => null,
    currentUserId: 'U1',
    _ownerIndex: null,
    SELF_INSTANCE_NAME: 'inst',
  });
  const face = (over: Record<string, unknown>) => cardOf({ key: 'inst::C3:t3', displayHeadline: 'h', ...over }, 'idle');

  it('shows the count and fetches nothing', () => {
    const c = face({ conversationId: 'c3', userMedia: { count: 3 } });
    expect(c.metrics).toEqual([{ text: '3', glyph: 'attach', title: '지시 첨부 3개', label: '지시 첨부 3개' }]);
    // No image, no media route on the board.
    expect(JSON.stringify(c)).not.toContain('/media/');
    expect(face({ conversationId: 'c3' }).metrics).toBeUndefined();
    expect(face({ conversationId: 'c3', userMedia: { count: 0 } }).metrics).toBeUndefined();
    // A sibling instance's files are not on this disk.
    expect(
      face({ conversationId: 'c3', userMedia: { count: 3 }, environment: { instanceName: 'other' } }).metrics,
    ).toBeUndefined();
  });
});

describe('C4 — viewer reuse', () => {
  it('artUrl routes a registered user-media id to the media route, anything else to artifacts', () => {
    const api = load<Api>(BASE_FNS, BASE_VARS);
    api.umRegister('c4', [img('U1')], turn);
    expect(api.artUrl('c4', 'U1')).toBe('/api/dashboard/session/c4/media/U1/content');
    expect(api.artUrl('c4', 'U1', true)).toBe('/api/dashboard/session/c4/media/U1/content?download=1');
    expect(api.artUrl('c4', 'A1')).toBe('/api/dashboard/session/c4/artifacts/A1/content');
  });

  it('a registered item knows its instruction, so the viewer pages within it', () => {
    const api = load<Api>(BASE_FNS, BASE_VARS);
    api.umRegister('c4', [img('U1'), pdf], turn);
    const a = api.umGet('c4', 'P1');
    expect(a).toMatchObject({ source: 'user_upload', turnId: 'u1', title: '지시 첨부 · Zhuge' });
    const open = clientFn('openArtifactViewer');
    expect(open).toContain('umSiblings(');
  });

  it('artFind falls back to user media', () => {
    expect(clientFn('artFind')).toContain('umGet(');
  });

  it('a user html file never gets scripts in the viewer: the element\'s sandbox="" frame, not the page\'s body', () => {
    const api = load<Api>(BASE_FNS, BASE_VARS);
    const page = {
      id: 'H1',
      name: 'page.html',
      kind: 'html',
      mime: 'text/html',
      size: 10,
      stored: true,
      source: 'user_upload',
    };
    // D6b: the element's own sandbox="" frame from the url (no items[].scripts for an upload); the model's html
    // carries scripts: true — the element's frame runs it (sandbox="allow-scripts", never same-origin).
    expect(api.artViewItem('c4', page)).not.toHaveProperty('scripts');
    expect(api.artViewItem('c4', page)).not.toHaveProperty('text');
    expect(api.artViewItem('c4', { ...page, source: 'slack_upload' })).toMatchObject({ scripts: true });
  });
});

describe('C5 — a file without a kept copy', () => {
  it('is dimmed, says why, and links to Slack only over https', () => {
    const api = load<Api>(BASE_FNS, BASE_VARS);
    const bad = { ...remote, id: 'R2', permalink: 'javascript:alert(1)' };
    api.umRegister('c5', [remote, bad], turn);
    const out = api.renderUserMedia('c5', [remote, bad]);
    expect(out).toContain('is-remote');
    expect(out).not.toContain('javascript:');
    // The card's meta line says so (artFileItem); the viewer's Slack action takes https only (artViewItem).
    expect(api.artFileItem('c5', remote)).toMatchObject({ meta: 'Slack에만 있음' });
    expect(api.artViewItem('c5', remote).actions).toEqual([
      { id: 'slack', label: 'Slack에서 열기', href: 'https://x.slack.com/files/U/F/demo.mov' },
    ]);
    expect(api.artViewItem('c5', bad)).not.toHaveProperty('actions');
  });
});

describe('pinned 지시 첨부 row', () => {
  it('is one collapsed line when the session has media, and nothing when it has none', () => {
    const { renderPanelUserMedia } = load<{
      renderPanelUserMedia(list: unknown[], cid: string, open: boolean): string;
    }>([...BASE_FNS, 'renderPanelUserMedia'], BASE_VARS);
    expect(renderPanelUserMedia([], 'c6', false)).toBe('');
    const list = [
      { ...img('A'), turnId: 'u1', turnTs: 1 },
      { ...pdf, turnId: 'u2', turnTs: 2 },
    ];
    // D4 K-06: the row is <ui-disclosure> (its own aria-expanded on its head): closed, the element without
    // `open` and no region nodes; opened, `open` with the tiles in its region.
    const closed = renderPanelUserMedia(list, 'c6', false);
    expect(closed).toContain('지시 첨부');
    expect(closed).toContain('<ui-disclosure class="panel-um-dc" flush>');
    expect(closed).not.toContain('ui-media-grid');
    const opened = renderPanelUserMedia(list, 'c6', true);
    expect(opened).toContain('<ui-disclosure class="panel-um-dc" flush open>');
    expect(opened).toContain('<ui-media-grid class="um-grid" lang="ko" size="compact" max="4" data-art-cid="c6" data-um="A">');
  });
});

describe('review gate P3 — the viewer says why a user file has no copy', () => {
  it("names the user-media reason, not the artifact one (the item's meta line on the viewer's card)", () => {
    const api = load<Api>(BASE_FNS, BASE_VARS);
    const big = { ...img('B1'), stored: false, unavailable: 'too_large', source: 'user_upload' };
    const video = { ...remote, source: 'user_upload' };
    expect(String(api.artViewItem('c7', big).meta)).toContain('50 MB');
    expect(String(api.artViewItem('c7', big).meta)).not.toContain('100 MB');
    expect(api.artViewItem('c7', big)).not.toHaveProperty('url');
    // A video is downloaded like any file now: without a copy it gets the generic reason, and the Slack action.
    expect(String(api.artViewItem('c7', video).meta)).toContain('사본이 없습니다');
    expect(api.artViewItem('c7', video).actions).toEqual([
      { id: 'slack', label: 'Slack에서 열기', href: 'https://x.slack.com/files/U/F/demo.mov' },
    ]);
  });
});

describe('goal gap — a user video or voice note with a copy plays in the dashboard', () => {
  const fns = () => load<Api>(BASE_FNS, BASE_VARS);

  it("a stored video opens in the viewer as a player on the media route (the element's own <video>)", () => {
    const api = fns();
    const clip = { id: 'VD1', name: 'repro.mp4', kind: 'video', mime: 'video/mp4', size: 4_000_000, stored: true };
    api.umRegister('c8', [clip], turn);
    expect(api.renderUserMedia('c8', [clip])).toContain('data-art-id="VD1"');
    expect(api.artViewItem('c8', clip)).toMatchObject({
      kind: 'video',
      url: '/api/dashboard/session/c8/media/VD1/content',
    });
    // A clip is the element's own body (no scripts, no frame flag of the page's).
    expect(api.artViewItem('c8', clip)).not.toHaveProperty('scripts');
    expect(api.artViewItem('c8', clip)).not.toHaveProperty('frame');
  });

  it("a stored voice note plays in place on its card (<ui-file-card playable>'s toggle)", () => {
    const api = fns();
    const memo = { id: 'AU1', name: 'memo.ogg', kind: 'audio', mime: 'audio/ogg', size: 9000, stored: true };
    api.umRegister('c8', [memo], turn);
    expect(api.renderUserMedia('c8', [memo])).toMatch(
      /<ui-file-card class="art-card" variant="row" playable lang="ko" data-art-cid="c8" data-art-id="AU1"/,
    );
    expect(api.artFileItem('c8', memo)).toMatchObject({
      kind: 'audio',
      url: '/api/dashboard/session/c8/media/AU1/content',
    });
  });
});
