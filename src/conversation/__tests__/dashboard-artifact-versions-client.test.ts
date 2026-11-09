/**
 * #1074 — the same artifact uploaded again, on the dashboard (client half; the harness of
 * dashboard-artifacts-client.test.ts — the shipped page code, cooked as the browser receives it):
 *
 *   T2  the lists show one entry per artifact — its latest version — with "판 N · 이전 판 이후 바뀜"
 *   T4  the viewer opens the earlier versions (이전 판 열기) and the line diff with the last one (이전 판과 비교)
 *       through the session's API; an answer's row still shows the version its turn made
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
  'artVersionLabel',
  'artVerBadge',
  'artFileItem',
  'artCard',
  'artChip',
];
const BASE_VARS = ['ART_KIND_LABEL', '_userMedia', 'CARD_ART_TILES'];

type Art = Record<string, unknown>;
const v1: Art = {
  id: 'R1',
  kind: 'html',
  name: 'html-report-20261109-100000.html',
  stored: true,
  source: 'slack_upload',
  createdAt: 1000,
  key: 'name:html-report.html',
  version: 1,
  turnStartedAt: 900,
};
const v2: Art = {
  ...v1,
  id: 'R2',
  name: 'html-report-20261109-110000.html',
  createdAt: 2000,
  version: 2,
  changed: true,
  turnStartedAt: 1900,
};
const png: Art = {
  id: 'P1',
  kind: 'image',
  name: 'chart.png',
  stored: true,
  source: 'slack_upload',
  createdAt: 1500,
  key: 'name:chart.png',
  version: 1,
};
const legacy: Art = { id: 'L1', kind: 'file', name: 'old.zip', stored: false, source: 'slack_upload', createdAt: 500 };

describe('#1074 T2 — one entry per artifact, its latest version, with the version said', () => {
  const api = (cache: Record<string, unknown> = {}) =>
    load<{
      artLatestOnly(list: Art[]): Art[];
      artVersionLabel(a: Art): string;
      artFileItem(cid: string, a: Art): Record<string, unknown>;
      renderPanelArtifacts(list: Art[], cid: string, variant?: string): string;
      renderCardArtifacts(s: unknown): string;
      renderTurnArtifacts(list: Art[], cid: string, startTs: number, endTs: number): string;
    }>(
      [
        ...BASE_FNS,
        'artSortForDisplay',
        'artLatestOnly',
        'artTile',
        'artListFor',
        'artInTurn',
        'renderPanelArtifacts',
        'renderCardArtifacts',
        'renderTurnArtifacts',
      ],
      BASE_VARS,
      { _artCache: cache },
    );

  it('keeps the highest version of each key, newest first; a row without a key is its own', () => {
    expect(
      api()
        .artLatestOnly([v2, png, v1, legacy])
        .map((a) => a.id),
    ).toEqual(['R2', 'P1', 'L1']);
    expect(
      api()
        .artLatestOnly([v1, v2])
        .map((a) => a.id),
    ).toEqual(['R2']);
  });

  it('the label: nothing for a first version, "판 N · 이전 판 이후 바뀜" when changed, "판 N" when unknown', () => {
    expect(api().artVersionLabel(v1)).toBe('');
    expect(api().artVersionLabel(v2)).toBe('판 2 · 이전 판 이후 바뀜');
    expect(api().artVersionLabel({ ...v2, changed: undefined })).toBe('판 2');
    expect(api().artFileItem('c', v2).meta).toBe('판 2 · 이전 판 이후 바뀜');
    expect(api().artFileItem('c', v1)).not.toHaveProperty('meta');
    expect(api().artFileItem('c', { ...v2, stored: false }).meta).toBe('Slack에만 있음 · 판 2 · 이전 판 이후 바뀜');
  });

  it('the panel strip lists the report once (its version 2, with its pill) and counts artifacts, not uploads', () => {
    const out = api().renderPanelArtifacts([v1, png, v2], 'c', 'chip');
    expect(out).toContain('<span class="art-count">2</span>');
    expect(out).toContain('data-art-id="R2"');
    expect(out).not.toContain('data-art-id="R1"');
    expect(out).toContain('<span class="art-ver" title="판 2 · 이전 판 이후 바뀜">판 2</span>');
    // The card's data signature carries the version: a new version re-hands the card its file.
    expect(out).toMatch(/data-art-v="[^"]*\|2\|1"/);
  });

  it('the open card counts one artifact for two uploads of it', () => {
    const out = api({ c: { state: 'ok', list: [v1, v2] } }).renderCardArtifacts({
      conversationId: 'c',
      artifacts: { count: 1, recent: [v2] },
    });
    expect(out).toContain('<span class="art-count">1</span>');
    expect(out).not.toContain('data-art-id="R1"');
  });

  it("an answer's row shows the version its own turn made", () => {
    const out = api().renderTurnArtifacts([v1, v2], 'c', 800, 1200);
    expect(out).toContain('data-art-id="R1"');
    expect(out).not.toContain('data-art-id="R2"');
    const later = api().renderTurnArtifacts([v1, v2], 'c', 1800, 2500);
    expect(later).toContain('<span class="art-ver-wrap">');
  });
});

describe('#1074 T4 — the viewer opens the earlier versions and the line diff', () => {
  const viewerApi = (inject: Record<string, unknown> = {}) =>
    load<{
      artViewItem(cid: string, a: Art): Record<string, unknown>;
      artVersionsOf(cid: string, a: Art): Art[];
      artDiffItem(a: Art, d: unknown): Record<string, unknown>;
      openArtifactViewer(cid: string, id: string, opener: unknown): void;
      artOpenPrevious(cid: string, a: Art): Promise<void>;
      artOpenDiff(cid: string, a: Art): Promise<void>;
      onArtViewerAction(e: unknown): void;
    }>(
      [
        ...BASE_FNS,
        'umSiblings',
        'umMissingReason',
        'artSafeUrl',
        'artSortForDisplay',
        'artViewerPages',
        'artLatestOnly',
        'artViewItem',
        'artViewerItems',
        'artVersionsOf',
        'artDiffItem',
        'openArtifactViewer',
        'artOpenPrevious',
        'artOpenDiff',
        'onArtViewerAction',
      ],
      [...BASE_VARS, '_artDocCache', '_artVerRows'],
      inject,
    );

  it('a later version carries 이전 판 열기, a source also 이전 판과 비교; a first version neither', () => {
    const m = viewerApi();
    expect(m.artViewItem('c', v2).actions).toEqual([
      { id: 'ver-prev', label: '이전 판 열기' },
      { id: 'ver-diff', label: '이전 판과 비교' },
    ]);
    expect(m.artViewItem('c', v2).meta).toBe('판 2 · 이전 판 이후 바뀜');
    expect(m.artViewItem('c', { ...png, version: 3 }).actions).toEqual([{ id: 'ver-prev', label: '이전 판 열기' }]);
    expect(m.artViewItem('c', v1)).not.toHaveProperty('actions');
  });

  it('the conversation pages through latest versions; an earlier version opens over its own versions', () => {
    const opened: unknown[][] = [];
    const viewer = { index: -1, open: (...a: unknown[]) => opened.push(a) };
    const state = { _artViewer: { cid: null, scope: 'conversation', list: [] as Art[] } };
    const m = viewerApi({
      artViewerEl: () => viewer,
      _artCache: { c: { state: 'ok', list: [v1, png, v2] } },
      artFind: (_cid: string, id: string) => ({ R1: v1, R2: v2, P1: png })[id] ?? null,
      ensureArtifacts: () => {},
      pauseArtCards: () => {},
      get _artViewer() {
        return state._artViewer;
      },
    });
    m.openArtifactViewer('c', 'R2', null);
    expect((opened[0][0] as Array<{ id: string }>).map((i) => i.id)).toEqual(['R2', 'P1']);
    m.openArtifactViewer('c', 'R1', null);
    expect((opened[1][0] as Array<{ id: string }>).map((i) => i.id)).toEqual(['R2', 'R1']);
    expect(opened[1][1]).toBe(1);
  });

  it('이전 판 열기 fetches the versions from the session API and shows the one before', async () => {
    const urls: string[] = [];
    const opened: unknown[][] = [];
    const viewer = { index: 0, open: (...a: unknown[]) => opened.push(a) };
    const held: Record<string, unknown> = Object.create(null);
    const g = globalThis as { fetch?: unknown };
    const prevFetch = g.fetch;
    g.fetch = (u: string) => {
      urls.push(u);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ key: v2.key, versions: [v2, v1] }) });
    };
    try {
      const m = viewerApi({
        artViewerEl: () => viewer,
        artViewerIsOpen: () => true,
        _artCache: {},
        _artVerRows: held,
        _artViewer: { cid: 'c', scope: 'conversation', list: [v2] },
      });
      await m.artOpenPrevious('c', v2);
      expect(urls).toEqual(['/api/dashboard/session/c/artifacts/R2/versions']);
      const [items, at] = opened[0] as [Array<{ id: string }>, number];
      expect(items.map((i) => i.id)).toEqual(['R2', 'R1']);
      expect(at).toBe(1);
    } finally {
      g.fetch = prevFetch;
    }
  });

  it('이전 판과 비교 shows the line diff as a text page; a refusal says why', async () => {
    const opened: unknown[][] = [];
    const viewer = { index: 0, open: (...a: unknown[]) => opened.push(a) };
    const g = globalThis as { fetch?: unknown };
    const prevFetch = g.fetch;
    let reply: unknown = {
      ok: true,
      json: () =>
        Promise.resolve({
          from: { id: 'R1', version: 1 },
          to: { id: 'R2', version: 2 },
          text: '@@ -1,1 +1,1 @@\n-<p>old</p>\n+<p>new</p>',
          added: 1,
          removed: 1,
          truncated: false,
        }),
    };
    g.fetch = () => Promise.resolve(reply);
    try {
      const m = viewerApi({
        artViewerEl: () => viewer,
        artViewerIsOpen: () => true,
        _artViewer: { cid: 'c', scope: 'conversation', list: [v2] },
      });
      await m.artOpenDiff('c', v2);
      const [items] = opened[0] as [Array<Record<string, string>>];
      expect(items[0]).toMatchObject({
        id: 'diff:R2',
        kind: 'text',
        name: 'html-report-20261109-110000.html · 판 1 → 판 2',
      });
      expect(items[0].text).toBe('--- 판 1\n+++ 판 2\n@@ -1,1 +1,1 @@\n-<p>old</p>\n+<p>new</p>');
      reply = { ok: false, json: () => Promise.resolve({ error: 'not_text' }) };
      await m.artOpenDiff('c', v2);
      expect((opened[1][0] as Array<Record<string, string>>)[0].text).toContain('비교할 수 없습니다');
    } finally {
      g.fetch = prevFetch;
    }
    expect(
      viewerApi().artDiffItem(v2, { from: { version: 1 }, to: { version: 2 }, text: '', truncated: false }).text,
    ).toBe('두 판의 내용이 같습니다.');
  });

  it('the viewer action routes to them; another element or a file the page does not know does nothing', () => {
    const viewer = { id: 'art-viewer' };
    const calls: string[] = [];
    const m = viewerApi({
      artViewerEl: () => viewer,
      _artViewer: { cid: 'c', scope: 'conversation', list: [] },
      artFind: (_cid: string, id: string) => (id === 'R2' ? v2 : null),
    });
    // The wired functions are this harness's own: watch them through fetch.
    const g = globalThis as { fetch?: unknown };
    const prevFetch = g.fetch;
    g.fetch = (u: string) => {
      calls.push(u);
      return new Promise(() => {});
    };
    try {
      m.onArtViewerAction({ target: viewer, detail: { action: 'ver-prev', id: 'R2', extra: true } });
      m.onArtViewerAction({ target: viewer, detail: { action: 'ver-diff', id: 'R2', extra: true } });
      m.onArtViewerAction({ target: {}, detail: { action: 'ver-prev', id: 'R2', extra: true } });
      m.onArtViewerAction({ target: viewer, detail: { action: 'ver-prev', id: 'NOPE', extra: true } });
      m.onArtViewerAction({ target: viewer, detail: { action: 'open', id: 'R2' } });
    } finally {
      g.fetch = prevFetch;
    }
    expect(calls).toEqual([
      '/api/dashboard/session/c/artifacts/R2/versions',
      '/api/dashboard/session/c/artifacts/R2/diff',
    ]);
    expect(TEMPLATE).toContain("document.addEventListener('ui-action', onArtViewerAction);");
  });
});
