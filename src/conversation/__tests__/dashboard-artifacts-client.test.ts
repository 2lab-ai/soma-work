/**
 * SSOT 2026-10-23 — dashboard artifacts, client half. Executes the shipped page
 * code (cut out of renderDashboardPage()'s template literal and cooked exactly
 * as the browser receives it — the harness of dashboard-live-surfaces-client.test.ts):
 *
 *   T5  collapsed card face: an artifact row the board shows at a glance;
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
function load<T>(fns: string[], vars: string[], inject: Record<string, unknown> = {}): T {
  const names = Object.keys(inject);
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}

const BASE_FNS = [
  'esc',
  'escAttr',
  'escJs',
  'toNum',
  'artUrl',
  'artFormatSize',
  'artKindLabel',
  'artGlyph',
  'artMeta',
  'artChip',
];
const BASE_VARS = ['ART_KIND_LABEL', 'ART_GLYPH'];

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

describe('T5 — collapsed card face: artifacts visible on the board itself', () => {
  const face = () => load<{ artFaceChips(s: unknown): string }>([...BASE_FNS, 'artFaceChips'], BASE_VARS);

  it('a card with artifacts gets a row of chips with the count; none → nothing', () => {
    const out = face().artFaceChips({
      conversationId: 'conv-1',
      artifacts: { count: 6, files: 5, answers: 1, recent: [html, png, wav, answer] },
    });
    expect(out).toContain('class="card-arts"');
    expect(out).toContain('data-art-cid="conv-1"');
    for (const id of ['A1', 'A2', 'A3', 'A4']) expect(out).toContain(`data-art-id="${id}"`);
    expect(out).toContain('+2');
    expect(out).toContain('report.html');
    // The face never pulls full images: glyph chips only (thumbnails start in the expanded body).
    expect(out).not.toContain('<img');
    expect(face().artFaceChips({ conversationId: 'c', artifacts: undefined })).toBe('');
    expect(face().artFaceChips({ conversationId: undefined, artifacts: { count: 1, recent: [html] } })).toBe('');
  });

  it('chip text is escaped', () => {
    const out = face().artFaceChips({
      conversationId: 'c',
      artifacts: { count: 1, recent: [{ ...html, name: '<img src=x onerror=alert(1)>.html' }] },
    });
    expect(out).not.toContain('<img src=x');
    expect(out).toContain('&lt;img src=x');
  });

  it('renderCardFace shows the row; renderCardBody shows the strip', () => {
    const faceSrc = clientFn('renderCardFace');
    expect(faceSrc).toContain('artFaceChips(s)');
    const bodySrc = clientFn('renderCardBody');
    expect(bodySrc).toContain('renderCardArtifacts(s)');
  });
});

describe('T5 — expanded card: the 산출물 strip', () => {
  const body = (cache: Record<string, unknown> = {}) =>
    load<{ renderCardArtifacts(s: unknown): string }>(
      [...BASE_FNS, 'artSortForDisplay', 'artThumb', 'artTile', 'artListFor', 'renderCardArtifacts'],
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
    expect(out).toContain('<img');
    expect(out).toContain('src="/api/dashboard/session/conv-1/artifacts/A2/content"');
  });

  it('T8 — an audio tile carries an inline play button; a file without bytes says it is on Slack', () => {
    const out = body({ c: { state: 'ok', list: [wav, bigMov] } }).renderCardArtifacts({
      conversationId: 'c',
      artifacts: { count: 2, recent: [] },
    });
    expect(out).toMatch(/data-art-play="1"[^>]*data-art-id="A3"|data-art-id="A3"[^>]*data-art-play="1"/);
    expect(out).toContain('Slack');
  });

  it('before the list loads, the summary shows; with no artifacts the section is absent', () => {
    const out = body().renderCardArtifacts({ conversationId: 'c', artifacts: { count: 1, recent: [png] } });
    expect(out).toContain('data-art-id="A2"');
    expect(body().renderCardArtifacts({ conversationId: 'c' })).toBe('');
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
        'artThumb',
        'artTile',
        'artInTurn',
        'renderPanelArtifacts',
        'renderTurnArtifacts',
      ],
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
    expect(TEMPLATE).toMatch(/if \(e\.key === 'Escape' && panelOpen && !artModalIsOpen\(\)\) closePanel\(\);/);
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
