/**
 * The owner pill on the detail card (SSOT 2026-11-04, Z):
 *   "1. 작업 카드가 내꺼면 유저 아이디 뱃지에 애니메이션 처리해서 눈에 띄게해줘
 *    2. 디테일 작업 카드에도 우상단에 유저 뱃지 추가해줘."
 * Executed from the shipped client code cut out of renderDashboardPage()'s template literal (the harness of
 * dashboard-detail-title-actions-client.test.ts):
 *
 *   ┌ title bar   <title text> [↗] [⧉]                 (zhuge)  ‹ 1/2 ›  ✕
 *
 *   B1  the page: the pill sits in the header's top row, right of the title block, before the deck nav and ✕
 *   B2  it is the board's badge (the kit's .ui-owner-badge of @2lab.ai/ui ≥ 0.28.0): the board colour, and the
 *       viewer's own orbits (.is-self) — the kit's CSS is on the page
 *   B3  it names the owner in every board mode; the viewer's own says "(나)" (title + screen reader)
 *   B4  it follows the open card (repaintPanelSession) and is written only on change — a rewrite would restart the orbit
 *   B5  every Korean string it shows has an English entry (en-page catalog)
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { viewerScope } from '../__fixtures__/viewer-scope';
import { uiLibKitCss } from '../ui-lib';

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));
const EN_PAGE = JSON.parse(
  readFileSync(join(__dirname, '..', '..', '..', 'packages', 'common', 'src', 'i18n-catalog', 'en-page.json'), 'utf-8'),
) as Record<string, string>;

function cook(fragment: string): string {
  if (fragment.includes('`') || fragment.includes('${')) throw new Error('fragment is not a plain template slice');
  return new Function(`return \`${fragment}\`;`)() as string;
}
function clientFn(name: string): string {
  const start = TEMPLATE.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = TEMPLATE.indexOf('\n}\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 2));
}
function load<T>(fns: string[], inject: Record<string, unknown> = {}): T {
  ({ fns, inject } = viewerScope(fns, inject));
  const names = Object.keys(inject);
  const body = `${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}
const PAGE = cook(TEMPLATE.slice(TEMPLATE.indexOf('<body'), TEMPLATE.indexOf('<script>', TEMPLATE.indexOf('<body'))));
const CSS = cook(
  TEMPLATE.slice(TEMPLATE.indexOf('<style>'), TEMPLATE.indexOf('</style>', TEMPLATE.indexOf('<style>'))),
);

type Owner = { text: string; hue: number; self: boolean; title: string } | null;
interface OwnerMod {
  panelOwnerOf(s: Record<string, unknown> | null): Owner;
  renderPanelOwner(s: Record<string, unknown> | null): void;
}
const ME = 'U_ME';
const HUES: Record<string, number> = { U_ME: 2, U_BOB: 5 };
// `board` — the board filter (currentUserId: '' = All Users); the viewer is the signed-in user, independent of it.
const mod = (board: string, viewer: string, el: unknown = null, raf: unknown = undefined, reduced = false) =>
  load<OwnerMod>(['panelOwnerOf', 'renderPanelOwner', 'ownerBadgeOrbitSync'], {
    currentUserId: board,
    _viewerUserId: viewer,
    ownerBadgeHue: (id: string) => HUES[id] ?? 0,
    document: { getElementById: (id: string) => (id === 'panel-owner' ? el : null), createElement: fakeEl },
    requestAnimationFrame: raf,
    matchMedia: (q: string) => ({ matches: reduced && q === '(prefers-reduced-motion: reduce)' }),
  });

/** Enough of an element for renderPanelOwner: attributes, classList, children, text. */
interface FakeEl {
  hidden: boolean;
  className: string;
  attrs: Record<string, string>;
  classes: Set<string>;
  children: FakeEl[];
  text: string;
  writes: number;
  _sig?: string;
  anims: Array<{ animationName: string; startTime: number | null }>;
  closed?: boolean;
  getAnimations(o: unknown): Array<{ animationName: string; startTime: number | null }>;
  classList: { toggle(c: string, on: boolean): void };
  setAttribute(k: string, v: string): void;
  removeAttribute(k: string): void;
  appendChild(c: FakeEl): void;
  textContent: string;
}
function fakeEl(): FakeEl {
  const el = {
    hidden: true,
    className: '',
    attrs: {} as Record<string, string>,
    classes: new Set<string>(),
    children: [] as FakeEl[],
    text: '',
    writes: 0,
    // A closed drawer draws nothing: no CSS animation exists yet.
    closed: false,
    // The kit's arc (its ::before) and a fade; the arc only while the pill is the viewer's own.
    anims: [] as Array<{ animationName: string; startTime: number | null }>,
    getAnimations(o: unknown) {
      if (!(o && (o as { subtree?: boolean }).subtree) || el.closed) return [];
      if (!el.anims.length)
        el.anims = [
          { animationName: el.classes.has('is-self') ? 'ui-owner-badge-orbit' : 'none', startTime: null },
          { animationName: 'ui-fade-in', startTime: 9 },
        ];
      return el.anims;
    },
    classList: {
      toggle(c: string, on: boolean) {
        if (on) el.classes.add(c);
        else el.classes.delete(c);
      },
    },
    setAttribute(k: string, v: string) {
      el.attrs[k] = v;
    },
    removeAttribute(k: string) {
      delete el.attrs[k];
    },
    appendChild(c: FakeEl) {
      el.children.push(c);
    },
    get textContent(): string {
      return el.text + el.children.map((c) => c.textContent).join('');
    },
    set textContent(v: string) {
      el.writes++;
      el.text = v;
      el.children = [];
    },
  };
  return el as unknown as FakeEl;
}

describe('B1 — the page: the owner pill at the top right of the detail card', () => {
  const header = PAGE.slice(
    PAGE.indexOf('<div class="panel-header">'),
    PAGE.indexOf('<ui-status-bar class="panel-status"'),
  );

  it('in the header row after the title block, before the deck nav and ✕; hidden until a card fills it', () => {
    const pill = header.match(/<span [^>]*id="panel-owner"[^>]*><\/span>/);
    expect(pill).not.toBeNull();
    expect(pill?.[0]).toMatch(/class="ui-owner-badge panel-owner"/);
    expect(pill?.[0]).toMatch(/\shidden[\s>]/);
    const at = header.indexOf('id="panel-owner"');
    expect(at).toBeGreaterThan(header.indexOf('id="panel-title-sub"'));
    expect(at).toBeLessThan(header.indexOf('id="panel-deck"'));
    expect(at).toBeLessThan(header.indexOf('class="ui-icon-btn is-bordered panel-close"'));
  });

  it('centred on the deck and ✕, gives way before the title, and [hidden] beats the kit’s inline-block', () => {
    expect(CSS).toContain(
      '.panel-header > .panel-owner { flex: 0 1 auto; min-width: 0; max-inline-size: min(40%, 168px); align-self: center; }',
    );
    expect(CSS).toContain('.panel-header > .panel-owner[hidden] { display: none; }');
  });
});

describe('B2 — the board’s badge: the kit’s .ui-owner-badge (@2lab.ai/ui ≥ 0.28.0) is on the page', () => {
  it('the kit sheet the page inlines draws the pill, its eight hues and the orbiting self ring', () => {
    const kit = uiLibKitCss().replace(/\s+/g, ' ');
    expect(kit).toContain('.ui-owner-badge { display: inline-block;');
    for (let h = 1; h < 8; h++) expect(kit).toContain(`.ui-owner-badge[data-hue="${h}"]`);
    expect(kit).toMatch(/\.ui-owner-badge\.is-self::before \{[^}]*animation: ui-owner-badge-orbit/);
    expect(kit).toMatch(/prefers-reduced-motion: reduce\) \{ \.ui-owner-badge\.is-self \{/);
    expect(TEMPLATE).toMatch(/\$\{uiLibKitCss\(\)\}/);
  });
});

describe('B3 — whose card: the owner in every board mode; the viewer’s own orbits and says "(나)"', () => {
  it('names the owner — All Users, the viewer’s own board, someone else’s board', () => {
    for (const board of ['', ME, 'U_BOB']) {
      expect(mod(board, ME).panelOwnerOf({ ownerId: 'U_BOB', ownerName: 'Bob' }), board).toEqual({
        text: 'Bob',
        hue: 5,
        self: false,
        title: 'Bob',
      });
    }
  });

  it('the viewer’s own: self, and the title says "(나)"; a token viewer (no user) owns nothing', () => {
    expect(mod('', ME).panelOwnerOf({ ownerId: ME, ownerName: 'Zhuge' })).toEqual({
      text: 'Zhuge',
      hue: 2,
      self: true,
      title: 'Zhuge (나)',
    });
    expect(mod(ME, ME).panelOwnerOf({ ownerId: ME, ownerName: 'Zhuge' })?.self).toBe(true);
    expect(mod('', '').panelOwnerOf({ ownerId: ME, ownerName: 'Zhuge' })?.self).toBe(false);
  });

  it('falls back to the owner id; no owner, no pill', () => {
    expect(mod('', ME).panelOwnerOf({ ownerId: 'U_BOB' })).toMatchObject({ text: 'U_BOB', hue: 5 });
    expect(mod('', ME).panelOwnerOf({})).toBeNull();
    expect(mod('', ME).panelOwnerOf(null)).toBeNull();
  });
});

describe('B4 — renderPanelOwner: follows the open card, writes only on change', () => {
  it('draws the pill: hue, title, name; the viewer’s own gets .is-self and a screen-reader "(나)"', () => {
    const el = fakeEl();
    const m = mod('', ME, el);
    m.renderPanelOwner({ ownerId: ME, ownerName: 'Zhuge' });
    expect(el.hidden).toBe(false);
    expect(el.attrs['data-hue']).toBe('2');
    expect(el.attrs.title).toBe('Zhuge (나)');
    expect(el.classes.has('is-self')).toBe(true);
    expect(el.text).toBe('Zhuge');
    expect(el.children).toHaveLength(1);
    expect(el.children[0].className).toBe('ui-sr-only');
    expect(el.children[0].textContent).toBe(' (나)');

    // Someone else's card: still, no "(나)".
    m.renderPanelOwner({ ownerId: 'U_BOB', ownerName: 'Bob' });
    expect(el.classes.has('is-self')).toBe(false);
    expect(el.attrs['data-hue']).toBe('5');
    expect(el.attrs.title).toBe('Bob');
    expect(el.textContent).toBe('Bob');
  });

  it('the same owner again (every live repaint) leaves the pill alone — the orbit never restarts', () => {
    const el = fakeEl();
    const m = mod('', ME, el);
    m.renderPanelOwner({ ownerId: ME, ownerName: 'Zhuge', tokens: 1 });
    const writes = el.writes;
    m.renderPanelOwner({ ownerId: ME, ownerName: 'Zhuge', tokens: 2 });
    m.renderPanelOwner({ ownerId: ME, ownerName: 'Zhuge', tokens: 3 });
    expect(el.writes).toBe(writes);
  });

  it('…but puts the arc back on the orbit every time: the drawer restarts it when it shows the pill again', () => {
    const el = fakeEl();
    const m = mod('', ME, el);
    m.renderPanelOwner({ ownerId: ME, ownerName: 'Zhuge' });
    el.anims[0].startTime = 777; // the browser restarted it (the drawer closed and opened)
    m.renderPanelOwner({ ownerId: ME, ownerName: 'Zhuge' });
    expect(el.anims[0].startTime).toBe(0);
  });

  it('a card without an owner hides it and clears what it said', () => {
    const el = fakeEl();
    const m = mod('', ME, el);
    m.renderPanelOwner({ ownerId: ME, ownerName: 'Zhuge' });
    m.renderPanelOwner({});
    expect(el.hidden).toBe(true);
    expect(el.classes.has('is-self')).toBe(false);
    expect(el.textContent).toBe('');
    expect(el.attrs).toEqual({});
  });

  it('a self pill’s arc starts at the timeline origin — in step with the board’s; others and other animations untouched', () => {
    const el = fakeEl();
    const m = mod('', ME, el);
    m.renderPanelOwner({ ownerId: ME, ownerName: 'Zhuge' });
    expect(el.anims.map((a) => a.startTime)).toEqual([0, 9]);
    const bob = fakeEl();
    mod('', ME, bob).renderPanelOwner({ ownerId: 'U_BOB', ownerName: 'Bob' });
    expect(bob.anims).toEqual([]); // never asked: no arc to place
  });

  it('under reduced motion (no arc) it never schedules the retry', () => {
    const el = fakeEl();
    el.closed = true;
    const frames: Array<() => void> = [];
    mod('', ME, el, (cb: () => void) => frames.push(cb), true).renderPanelOwner({ ownerId: ME, ownerName: 'Zhuge' });
    expect(frames).toHaveLength(0);
  });

  it('the live path repaints it: repaintPanelSession (every update, the opening, a viewer change) calls it', () => {
    expect(clientFn('repaintPanelSession')).toMatch(/renderPanelTitleActions\(s\);\n\s*renderPanelOwner\(s\);/);
    expect(clientFn('repaintViewerControls')).toContain('repaintPanelSession();');
  });

  it('a pill the closed drawer does not draw yet (no arc) is synced once more on the next frame — after the opening shows it', () => {
    const el = fakeEl();
    el.closed = true; // the drawer is closed: no CSS animation exists yet
    const frames: Array<() => void> = [];
    const m = mod('', ME, el, (cb: () => void) => frames.push(cb));
    m.renderPanelOwner({ ownerId: ME, ownerName: 'Zhuge' });
    expect(el.anims).toEqual([]);
    expect(frames).toHaveLength(1);
    el.closed = false; // openPanel → panel.show(), in the same task
    frames[0]();
    expect(el.anims.map((a) => a.startTime)).toEqual([0, 9]);
    expect(frames).toHaveLength(1); // once — never a loop while the drawer stays closed
  });
});

describe('B5 — every Korean string the pill shows has an English entry', () => {
  it('panelOwnerOf and renderPanelOwner', () => {
    const src = clientFn('panelOwnerOf') + clientFn('renderPanelOwner') + clientFn('ownerBadgeOrbitSync');
    const strings = [...src.matchAll(/'([^'\n]*[가-힣][^'\n]*)'/g)].map((m) => m[1]);
    expect(strings).toEqual([' (나)', ' (나)']);
    for (const k of strings) expect(EN_PAGE[k], k).toBe(' (you)');
  });
});
