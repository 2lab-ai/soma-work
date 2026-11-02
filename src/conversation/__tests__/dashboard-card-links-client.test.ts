/**
 * 작업 카드의 연결 (SSOT 2026-11-02 goal: "작업 카드에 디폴트로 표시해야 하는 중요한 것: 연결된 이슈(지라 혹은 깃허브
 * 이슈)들과 이슈 상태, 연결된 PR들과 머지 상태, 연결된 위키들") — the board's client. Executes the shipped client code
 * cut out of renderDashboardPage()'s template literal.
 *
 *   C1  cardLinksFace: the board's cardLinks as @2lab.ai/ui card.links (reference, state, tone, a tooltip that says
 *       what it is); none when ui.dashboardheader hides links
 *   C2  every built-in face (1 · 2 · 3안 × minimal · advanced) shows the links row, right after the task, and no PR
 *       chip (the row has the PR and its state); a layout that turns the row off has none
 *   C3  the open card's refs list the same pages with their states
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILTIN_PRESETS } from '../../view-layout';
import { viewerScope } from '../__fixtures__/viewer-scope';
import { VIEW_LAYOUT_CLIENT_JS } from '../view-layout-client';

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));

function cook(fragment: string): string {
  if (fragment.includes('`') || fragment.includes('${')) throw new Error('fragment is not a plain template slice');
  return new Function(`return \`${fragment}\`;`)() as string;
}
function declarationCount(name: string): number {
  const re = new RegExp(`^(?:async function|function|var|let|const) ${name.replace(/[$]/g, '\\$')}\\b`, 'gm');
  return (TEMPLATE.match(re) ?? []).length;
}
function clientFn(name: string): string {
  const n = declarationCount(name);
  if (n > 1) throw new Error(`client ${name} is declared ${n} times`);
  let start = TEMPLATE.indexOf(`\nfunction ${name}(`);
  if (start < 0) start = TEMPLATE.indexOf(`\nasync function ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = TEMPLATE.indexOf('\n}\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 2));
}
/** A one-line `var X = …;`, or a block `var X = {` … `\n};`. */
function clientVar(name: string): string {
  const one = TEMPLATE.match(new RegExp(`^(var ${name} = .*?;)(?:\\s*//.*)?$`, 'm'));
  if (one) return cook(one[1]);
  const start = TEMPLATE.indexOf(`\nvar ${name} = {\n`);
  if (start < 0) throw new Error(`client var ${name} not found`);
  const end = TEMPLATE.indexOf('\n};\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 3));
}
/** The page's script as the browser runs it: the shared layout script (view-layout-client.ts) and VIEW_BUILTINS first. */
function load<T>(fns: string[], vars: string[], inject: Record<string, unknown> = {}): T {
  ({ fns, inject } = viewerScope(fns, inject));
  const all: Record<string, unknown> = { VIEW_BUILTINS: BUILTIN_PRESETS, ...inject };
  const names = Object.keys(all);
  const setter = '__set: function(n, v) { eval(n + " = v"); }';
  const getter = '__get: function(n) { return eval(n); }';
  const body = `${VIEW_LAYOUT_CLIENT_JS}\n${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\nreturn { ${[...fns, setter, getter].join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => all[n])) as T;
}

const LINKS = [
  {
    kind: 'issue',
    url: 'https://acme.atlassian.net/browse/PROJ-12',
    text: 'PROJ-12',
    title: '결제 폼',
    status: 'In Progress',
    tone: 'run',
  },
  { kind: 'issue', url: 'https://github.com/acme/app/issues/41', text: '#41', status: '닫힘', tone: 'done' },
  {
    kind: 'pr',
    url: 'https://github.com/acme/app/pull/733',
    text: '#733',
    title: 'feat: 결제 폼',
    status: '머지됨',
    tone: 'done',
  },
  { kind: 'wiki', url: 'https://acme.atlassian.net/wiki/spaces/ENG/pages/1/Design', text: 'Design' },
];
const env = (show = true) =>
  load<{ cardLinksFace(s: unknown): any[]; __get(n: string): any }>(
    ['cardLinksFace'],
    ['CARD_LINK_KIND', 'CARD_LINK_TONES'],
    { dhShow: (k: string) => (k === 'links' ? show : true) },
  );

describe('C1 — the board’s links as the card’s', () => {
  it('reference, state and tone; a tooltip that says what each is', () => {
    const out = env().cardLinksFace({ cardLinks: LINKS });
    expect(out).toEqual([
      {
        kind: 'issue',
        href: LINKS[0].url,
        text: 'PROJ-12',
        status: 'In Progress',
        tone: 'run',
        title: '이슈 PROJ-12 — 결제 폼 · In Progress',
      },
      { kind: 'issue', href: LINKS[1].url, text: '#41', status: '닫힘', tone: 'done', title: '이슈 #41 · 닫힘' },
      {
        kind: 'pr',
        href: LINKS[2].url,
        text: '#733',
        status: '머지됨',
        tone: 'done',
        title: 'PR #733 — feat: 결제 폼 · 머지됨',
      },
      { kind: 'wiki', href: LINKS[3].url, text: 'Design', title: '위키 Design' },
    ]);
  });

  it('none when the server hides links (ui.dashboardheader); a bad entry is skipped', () => {
    expect(env(false).cardLinksFace({ cardLinks: LINKS })).toEqual([]);
    expect(env().cardLinksFace({ cardLinks: [{ kind: 'nope', url: 'x', text: 'y' }, null, LINKS[2]] })).toHaveLength(1);
    expect(env().cardLinksFace({})).toEqual([]);
  });
});

describe('C2 — every built-in face shows the links row by default', () => {
  const full = {
    id: 'c1',
    title: '결제 폼',
    status: 'running',
    task: { label: '검증 추가' },
    summary: '왜',
    links: env().cardLinksFace({ cardLinks: LINKS }),
    metrics: [{ text: '#733 머지됨', glyph: 'pr' }],
    costUsd: 6.2,
  };
  it('right after the task, with every page; no PR chip', () => {
    const e = env();
    for (const p of ['1', '2', '3'] as const)
      for (const m of ['minimal', 'advanced'] as const) {
        const face = e.__get('faceOf')(full, 'claude-opus-5-5[1m]', BUILTIN_PRESETS[p][m].card, false);
        const rows: string[] = face.rows;
        expect(rows, `${p} ${m}`).toContain('links');
        if (rows.includes('task')) expect(rows.indexOf('links'), `${p} ${m}`).toBe(rows.indexOf('task') + 1);
        expect(face.links, `${p} ${m}`).toHaveLength(4);
        expect(
          (face.metrics || []).some((x: { glyph?: string }) => x.glyph === 'pr'),
          `${p} ${m}`,
        ).toBe(false);
      }
  });

  it('a layout that turns the row off has no links', () => {
    const face = BUILTIN_PRESETS['1'].minimal.card;
    const off = { ...face, rows: face.rows.map((r) => (r.id === 'links' ? { ...r, on: false } : r)) };
    const out = env().__get('faceOf')(full, 'm', off, false);
    expect(out.rows).not.toContain('links');
    expect(out.links).toBeUndefined();
  });
});

describe('C3 — the open card’s refs', () => {
  it('list the same pages with their states (the old short refs only when the board sent none)', () => {
    const fn = clientFn('renderCardBody');
    expect(fn).toContain('const refLinks = cardLinksFace(s);');
    expect(fn).toContain('<span class="card-ref-st"');
    expect(fn).toContain("if (!refLinks.length && dhShow('links') && s.issueShortRef && s.issueUrl) {");
  });
});
