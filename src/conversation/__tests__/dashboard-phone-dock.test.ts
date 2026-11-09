/**
 * Phone dock (2026-11-09) — under 640px the sections and 새 작업 sit in the thumb zone: @2lab.ai/ui <ui-dock
 * layout="bar" fixed> (보드 · 대화 · 새 작업 · 설정 · 기억, the board's needs-you count on 보드). It replaces the bar's
 * 메뉴 (paintAppBar drops the links) and the floating 새 작업 button there; the board's head is the search with
 * Board | List, then the chips as one row that scrolls sideways.
 *
 * The runtime (390 / 834 / 1180 / 1440, the phone's layout viewport never wider than the screen) is checked in a
 * browser against the real server (the PR's screenshots).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const TEMPLATE = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');

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
function clientVar(name: string): string {
  const start = TEMPLATE.indexOf(`\nvar ${name} = `);
  if (start < 0) throw new Error(`client var ${name} not found`);
  const end = TEMPLATE.indexOf(';\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 2));
}
function load<T>(fns: string[], inject: Record<string, unknown> = {}, extra = ''): T {
  const names = Object.keys(inject);
  const body = `${fns.map(clientFn).join('\n')}\n${extra}\nreturn { ${fns.join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}
/** The body of the first `@media <query> {` block that contains `marker`. */
function mediaBlockWith(query: string, marker: string): string {
  let from = 0;
  for (;;) {
    const at = TEMPLATE.indexOf(`@media ${query} {`, from);
    if (at < 0) return '';
    let depth = 0;
    let i = TEMPLATE.indexOf('{', at);
    const open = i;
    for (; i < TEMPLATE.length; i++) {
      if (TEMPLATE[i] === '{') depth++;
      else if (TEMPLATE[i] === '}' && --depth === 0) break;
    }
    const body = TEMPLATE.slice(open + 1, i);
    if (body.includes(marker)) return body;
    from = i;
  }
}

describe('the dock element', () => {
  it('loads the library’s dock and places it after the floating button, hidden from 640px', () => {
    expect(TEMPLATE).toContain('<script type="module" src="/dashboard/ui/dock.js?v=${UI_LIB_VERSION}"></script>');
    expect(TEMPLATE).toContain('<ui-dock id="phone-dock" class="phone-dock" layout="bar" fixed lang="ko"></ui-dock>');
    expect(TEMPLATE.indexOf('id="phone-dock"')).toBeGreaterThan(TEMPLATE.indexOf('id="new-task-fab"'));
    expect(TEMPLATE).toMatch(/^\.phone-dock \{ display: none; \}$/m);
  });

  it('under 640px: the dock shows and the FAB goes; the last card clears the dock through the board’s own clearance', () => {
    const phone = mediaBlockWith('(max-width: 639px)', '.phone-dock { display: block; }');
    expect(phone).toContain('.phone-dock { display: block; }');
    expect(phone).toContain('.new-task-fab.ui-fab { display: none !important; }');
    // 600–639px: the toaster's wide placement is bottom right — its offset clears the dock (under 600px it is top-centre).
    expect(phone).toContain(
      'ui-toaster { --ts-offset: calc(var(--ui-dock-h, 60px) + 12px + env(safe-area-inset-bottom, 0px)); }',
    );
    // No page-wide padding (a short board would scroll by the dock's height, and it would stack on the board's own
    // clearance): the board with cards clears exactly the dock — 60px + the home indicator.
    expect(phone).not.toMatch(/body \{ padding-bottom/);
    expect(mediaBlockWith('(max-width: 639px)', '.inbox.has-cards')).toContain(
      '.inbox.has-cards { padding-bottom: calc(60px + env(safe-area-inset-bottom, 0px)); }',
    );
  });

  it('the dock’s breakpoint is narrow only: a phone held sideways keeps the bar’s 메뉴 and its height', () => {
    expect(clientVar('DOCK_MQ').trim()).toBe("var DOCK_MQ = '(max-width: 639px)';");
    expect(clientVar('PHONE_MQ')).toContain('(max-height: 560px)');
  });
});

describe('paintPhoneDock — 보드 first, then the bar’s links, 새 작업 raised between them', () => {
  type Dock = { data: { label: string; items: Array<Record<string, unknown>>; action: Record<string, unknown> } };
  const NAV = clientVar('APP_BAR_NAV');
  function paint(user: string, needs: number): Dock {
    const dock = {} as Dock;
    const m = load<{ paintPhoneDock(): void }>(
      ['paintPhoneDock'],
      { document: { getElementById: (id: string) => (id === 'phone-dock' ? dock : null) } },
      `${NAV}\nvar currentUserId = ${JSON.stringify(user)};\nvar _dockNeeds = ${needs};`,
    );
    m.paintPhoneDock();
    return dock;
  }

  it('the board is this page, current, with the needs-you count; the links are the bar’s own', () => {
    const d = paint('U123', 2).data;
    expect(d.label).toBe('주 메뉴');
    expect(d.action).toEqual({ id: 'new-task', label: '새 작업', icon: 'plus' });
    expect(d.items.map((i) => i.id)).toEqual(['board', 'conversations', 'settings', 'memory']);
    expect(d.items[0]).toMatchObject({
      label: '보드',
      href: '/dashboard/U123',
      current: true,
      badge: 2,
      icon: 'board',
    });
    expect(d.items[1]).toMatchObject({ label: '대화', href: '/conversations', icon: 'chat' });
    expect(d.items.slice(1).every((i) => !i.current)).toBe(true);
  });

  it('the All Users board is /dashboard; a user id is encoded into the path', () => {
    expect(paint('', 0).data.items[0]!.href).toBe('/dashboard');
    expect(paint('a/b', 0).data.items[0]!.href).toBe('/dashboard/a%2Fb');
  });
});

describe('syncDockNeeds — the board’s announce count becomes the dock’s badge', () => {
  it('repaints only when the count changes; a negative or missing count is none', () => {
    let paints = 0;
    const m = load<{ syncDockNeeds(n: number): void; needs(): number }>(
      ['syncDockNeeds'],
      { paintPhoneDock: () => paints++ },
      'var _dockNeeds = 0;\nfunction needs() { return _dockNeeds; }',
    );
    m.syncDockNeeds(3);
    m.syncDockNeeds(3);
    expect(paints).toBe(1);
    m.syncDockNeeds(-1);
    expect(paints).toBe(2);
    m.syncDockNeeds(Number.NaN);
    expect(paints).toBe(2);
  });

  it('renderBoard hands it the same count it announces, after the element is painted', () => {
    const render = clientFn('renderBoard');
    const paint = render.indexOf('inboxPaint(kb);');
    // A partial board (painted under a failed first load) publishes no count.
    const sync = render.indexOf(
      "if (typeof syncDockNeeds === 'function') syncDockNeeds(partial ? 0 : kb.data.announce.needs);",
    );
    expect(sync).toBeGreaterThan(paint);
  });

  it('a board switch repaints the dock (보드 is that board’s address)', () => {
    const sel = clientFn('selectUser');
    expect(sel.indexOf("if (typeof paintPhoneDock === 'function') paintPhoneDock();")).toBeGreaterThan(
      sel.indexOf('paintTrail();'),
    );
  });
});

describe('the app bar drops its links under 640px (the dock has them)', () => {
  function bar(phone: boolean) {
    const el = {} as { data: { nav: unknown[] } };
    const m = load<{ paintAppBar(): void }>(
      ['paintAppBar'],
      {
        document: { getElementById: (id: string) => (id === 'app-bar' ? el : null) },
        dockOn: () => phone,
        somaThemeNow: () => ({ theme: 'light', palette: 'color', design: null }),
        SOMA_DESIGNS: [],
      },
      `${clientVar('APP_BAR_NAV')}\nvar APP_BAR_TOOLBAR_AT = 1280;\nvar _appBarStatus = {};\nvar _appBarAccount = null;`,
    );
    m.paintAppBar();
    return el.data;
  }
  it('no links (so no 메뉴) on a phone, all three from 640px', () => {
    expect(bar(true).nav).toEqual([]);
    expect(bar(false).nav.map((l) => (l as { id: string }).id)).toEqual(['conversations', 'settings', 'memory']);
  });
  it('the bar is painted again when the breakpoint flips', () => {
    expect(TEMPLATE).toContain(
      "if (typeof _dockMq.addEventListener === 'function') _dockMq.addEventListener('change', paintAppBar);",
    );
  });
});

describe('the board’s head on a phone: the search with Board | List, then the chips in one sideways row', () => {
  it('the chips are one box (a kit scroll row that bleeds to the edge); the search and the view switch follow it', () => {
    const head = TEMPLATE.slice(TEMPLATE.indexOf('id="inbox-tools"'), TEMPLATE.indexOf('id="view-seg"'));
    expect(head).toContain('<div class="inbox-chips ui-scroll-row is-bleed" id="inbox-chips">');
    const chips = head.slice(head.indexOf('id="inbox-chips"'), head.indexOf('id="bf-search"'));
    for (const id of ['archives-toggle', 'sleeping-toggle', 'mine-toggle', 'bf-menu', 'bs-menu', 'lifecycle-btn'])
      expect(chips, id).toContain(`id="${id}"`);
    expect(head.indexOf('id="bf-search"')).toBeGreaterThan(head.indexOf('</div>', head.indexOf('id="lifecycle-btn"')));
  });

  it('from 640px the box is display: contents — one flex line with the tools, as before', () => {
    expect(TEMPLATE).toMatch(/^\.inbox-chips \{ display: contents; \}$/m);
  });

  it('under 640px: a two-line grid — the search fills the first line beside Board | List, the chips the second; no trail', () => {
    const phone = mediaBlockWith('(max-width: 639px)', '.inbox-tools > .inbox-chips');
    expect(phone).toContain('.inbox-head > .crumbs { display: none; }');
    expect(phone).toContain(
      '.inbox-tools { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 8px;',
    );
    // 16px: iOS zooms into a smaller field.
    expect(phone).toContain(
      '.inbox-tools > .bf-search { grid-column: 1; grid-row: 1; width: 100%; max-width: none; height: 40px; font-size: 16px; }',
    );
    expect(phone).toContain('.inbox-tools > .view-seg { grid-column: 2; grid-row: 1; }');
    expect(phone).toContain(
      '.inbox-tools > .inbox-chips { --ui-bleed: 12px; grid-column: 1 / -1; grid-row: 2; display: flex;',
    );
    expect(phone).toContain('.inbox-chips > .topbar-scope { display: flex; flex: none; flex-wrap: nowrap;');
  });

  it('a phone held sideways (no dock, chips box display: contents) keeps the scope group’s growing, wrapping line', () => {
    expect(TEMPLATE).toContain(
      '.inbox-tools > .topbar-scope, .inbox-chips > .topbar-scope { flex: 1 1 auto; flex-wrap: wrap; margin-right: auto; }',
    );
  });

  it('the bar is painted again once the dock knows the breakpoint (its first paint ran before _dockMq was set)', () => {
    const start = TEMPLATE.indexOf('(function initPhoneDock() {');
    const body = TEMPLATE.slice(start, TEMPLATE.indexOf('\n})();', start));
    expect(body.lastIndexOf('paintAppBar();')).toBeGreaterThan(body.indexOf('_dockMq.addEventListener'));
    expect(TEMPLATE.indexOf('var _dockMq')).toBeLessThan(start);
  });

  it('the scope group goes into the chips row on a phone', () => {
    expect(clientFn('syncPhoneScope')).toContain(
      "var tools = document.getElementById('inbox-chips') || document.getElementById('inbox-tools');",
    );
  });
});
