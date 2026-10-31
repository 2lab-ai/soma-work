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
 *       content route; the viewer pages within the same instruction; html never
 *       gets scripts in the viewer
 *   C5  a file without a kept copy says so and links to Slack (https only)
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
  'artFormatSize',
  'artKindLabel',
  'artGlyph',
  'artMeta',
  'umMiddleName',
  'umTile',
  'renderUserMedia',
  'umMissingReason',
];
const BASE_VARS = ['ART_KIND_LABEL', 'ART_GLYPH', '_userMedia', 'UM_GRID_MAX'];

type Api = {
  umRegister(cid: string, list: unknown[], turn: unknown): void;
  umGet(cid: string, id: string): any;
  artUrl(cid: string, id: string, download?: boolean): string;
  renderUserMedia(cid: string, list: unknown[], opts?: unknown): string;
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
  it('images become 80px tiles named by their action; other files become cards', () => {
    const api = load<Api>(BASE_FNS, BASE_VARS);
    const list = [img('I1', 'login.png'), img('I2'), pdf, voice];
    api.umRegister('c1', list, turn);
    const out = api.renderUserMedia('c1', list);
    expect(out).toContain('class="um-media');
    expect((out.match(/class="um-tile um-img/g) ?? []).length).toBe(2);
    expect(out).toContain('/api/dashboard/session/c1/media/I1/content');
    expect(out).toContain('loading="lazy"');
    // A button named by what it does — the image itself carries no alt from its file name.
    expect(out).toMatch(/aria-label="이미지 열기 1\/4: login\.png"/);
    expect(out).toContain('alt=""');
    expect(out).toContain('design-guide.pdf');
    expect(out).toContain('PDF · 2.1 MB');
    expect(out).toContain('data-art-play="1"'); // the voice note plays in place
  });

  it('one image shows on its own in a fixed box (no layout shift)', () => {
    const api = load<Api>(BASE_FNS, BASE_VARS);
    api.umRegister('c1', [img('S1')], turn);
    const out = api.renderUserMedia('c1', [img('S1')]);
    expect(out).toContain('um-single');
  });

  it('more than four images: four tiles, "+N" on the fourth, which still opens the viewer', () => {
    const api = load<Api>(BASE_FNS, BASE_VARS);
    const list = ['A', 'B', 'C', 'D', 'E', 'F'].map((x) => img(x));
    api.umRegister('c1', list, turn);
    const out = api.renderUserMedia('c1', list);
    expect((out.match(/class="um-tile um-img/g) ?? []).length).toBe(4);
    expect(out).toContain('+2');
    expect(out).toMatch(/data-art-id="D"[^>]*aria-label="[^"]*외 2개/);
  });

  it('renderTurn puts the files before the instruction text, and a files-only turn has no empty text block', () => {
    const src = clientFn('renderTurn');
    const userBranch = src.slice(src.indexOf("if (t.role === 'user')"), src.indexOf('} else {'));
    expect(userBranch).toContain('renderUserMedia(');
    expect(userBranch.indexOf('renderUserMedia(')).toBeLessThan(userBranch.indexOf('turn-content'));
    expect(userBranch).toContain('umRegister(');
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
    expect(out).toContain('/api/dashboard/session/c2/media/I9/content');
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
const CARD_OF_VARS = ['PR_STATE_LABEL', 'PR_STATE_TONE', 'AGENT_STATUS_LABEL', 'AGENT_STATUS_TONE', 'OWNER_BADGE_HUES'];

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
    const open = clientFn('openArtifactModal');
    expect(open).toContain('umSiblings(');
  });

  it('artFind falls back to user media', () => {
    expect(clientFn('artFind')).toContain('umGet(');
  });

  it('a user html file never gets scripts in the viewer', () => {
    const { renderArtModalBody } = load<{ renderArtModalBody(cid: string, a: unknown): string }>(
      [...BASE_FNS, 'renderArtModalBody'],
      BASE_VARS,
    );
    const page = {
      id: 'H1',
      name: 'page.html',
      kind: 'html',
      mime: 'text/html',
      size: 10,
      stored: true,
      source: 'user_upload',
    };
    const out = renderArtModalBody('c4', page);
    expect(out).toContain('sandbox=""');
    expect(out).not.toContain('allow-scripts');
  });
});

describe('C5 — a file without a kept copy', () => {
  it('is dimmed, says why, and links to Slack only over https', () => {
    const api = load<Api>(BASE_FNS, BASE_VARS);
    const bad = { ...remote, id: 'R2', permalink: 'javascript:alert(1)' };
    api.umRegister('c5', [remote, bad], turn);
    const out = api.renderUserMedia('c5', [remote, bad]);
    expect(out).toContain('is-remote');
    expect(out).toContain('Slack에만 있음');
    expect(out).not.toContain('javascript:');
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
    const closed = renderPanelUserMedia(list, 'c6', false);
    expect(closed).toContain('지시 첨부');
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).not.toContain('um-tile');
    const opened = renderPanelUserMedia(list, 'c6', true);
    expect(opened).toContain('aria-expanded="true"');
    expect(opened).toContain('um-tile');
  });
});

describe('review gate P3 — the viewer says why a user file has no copy', () => {
  it('names the user-media reason, not the artifact one', () => {
    const { renderArtModalBody } = load<{ renderArtModalBody(cid: string, a: unknown): string }>(
      [...BASE_FNS, 'renderArtModalBody'],
      BASE_VARS,
    );
    const big = { ...img('B1'), stored: false, unavailable: 'too_large', source: 'user_upload' };
    const video = { ...remote, source: 'user_upload' };
    expect(renderArtModalBody('c7', big)).toContain('50 MB');
    expect(renderArtModalBody('c7', big)).not.toContain('100 MB');
    // A video is downloaded like any file now: without a copy it gets the generic reason.
    expect(renderArtModalBody('c7', video)).toContain('사본이 없습니다');
    expect(renderArtModalBody('c7', video)).toContain('href="https://x.slack.com/files/U/F/demo.mov"');
  });
});

describe('goal gap — a user video or voice note with a copy plays in the dashboard', () => {
  const fns = () =>
    load<{
      renderArtModalBody(cid: string, a: unknown): string;
      umRegister: Api['umRegister'];
      renderUserMedia: Api['renderUserMedia'];
    }>([...BASE_FNS, 'renderArtModalBody'], BASE_VARS);

  it('a stored video opens in the viewer as a player on the media route', () => {
    const api = fns();
    const clip = { id: 'VD1', name: 'repro.mp4', kind: 'video', mime: 'video/mp4', size: 4_000_000, stored: true };
    api.umRegister('c8', [clip], turn);
    expect(api.renderUserMedia('c8', [clip])).toContain('data-art-id="VD1"');
    const body = api.renderArtModalBody('c8', clip);
    expect(body).toMatch(
      /<video class="art-full-video" controls[^>]*src="\/api\/dashboard\/session\/c8\/media\/VD1\/content"/,
    );
  });

  it('a stored voice note plays in place on its tile', () => {
    const api = fns();
    const memo = { id: 'AU1', name: 'memo.ogg', kind: 'audio', mime: 'audio/ogg', size: 9000, stored: true };
    api.umRegister('c8', [memo], turn);
    expect(api.renderUserMedia('c8', [memo])).toMatch(/data-art-play="1" data-art-cid="c8" data-art-id="AU1"/);
  });
});
