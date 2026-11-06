/**
 * The dashboard's first screen (#965). Before: on a fresh load or a refresh the closed dialogs' contents (the session
 * lifecycle form, the rollback footer, the new-task form) were drawn in the page for seconds — an undefined custom
 * element draws its light-DOM children in the flow, and the modules define them only after the ~1 MB document is
 * parsed (phone, CPU 4x, measured: painted 0.31 → 3.03 s cold, 0.32 → 0.60 s on a warm refresh). The tests pin:
 *
 *   [T1] every overlay element the page's markup carries is hidden until defined (display: none);
 *   [T2] a first screen shaped like the page is the first child of <body>, and its script lifts it when nothing the
 *        viewport shows is undefined — or at DOMContentLoaded, or at 12 s — then it leaves the DOM.
 *
 * The lift script runs here as shipped (a plain literal), against a fake page — theme-client.test.ts's harness.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BOOT_SCREEN_SLOT, bootClientJs, bootScreenCss, bootScreenHtml, withBootScreen } from '../boot-screen';
import { uiLibDistDir } from '../ui-lib';

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));

interface Box {
  width: number;
  height: number;
  top: number;
  left: number;
  bottom: number;
  right: number;
}
const box = (left: number, top: number, width: number, height: number): Box => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
});

interface Child {
  tagName: string;
  inert: boolean;
  open: boolean;
  nextElementSibling: Child | null;
}

const OPEN_OVERLAY = '.app > ui-drawer[open], .app > ui-dialog[open]';

function page(
  opts: {
    undefinedEls?: Box[];
    noBoot?: boolean;
    noDefinedSelector?: boolean;
    app?: Array<[string, boolean?]> | null;
    width?: number;
    saved?: string | null | 'throws';
  } = {},
) {
  // The .app container as the parser builds it: its children arrive one by one (append).
  const children: Child[] = [];
  const app = {
    get firstElementChild() {
      return children[0] ?? null;
    },
  };
  const append = (tagName: string, inert = false) => {
    const child: Child = { tagName: tagName.toUpperCase(), inert, open: false, nextElementSibling: null };
    if (children.length) children[children.length - 1].nextElementSibling = child;
    children.push(child);
    return child;
  };
  for (const [tag, inert] of opts.app ?? []) append(tag, inert);
  const classes = new Set<string>();
  const attrs: Record<string, string> = {};
  let attached = true;
  const boot = {
    setAttribute: (name: string, value: string) => {
      attrs[name] = value;
    },
    classList: { add: (c: string) => classes.add(c), contains: (c: string) => classes.has(c) },
    get parentNode() {
      return attached ? { removeChild: () => (attached = false) } : null;
    },
  };
  let undefinedEls = opts.undefinedEls ?? [];
  const ready: Array<() => void> = [];
  let frames: Array<() => void> = [];
  let now = 0;
  let timers: Array<{ at: number; fn: () => void }> = [];
  const document = {
    readyState: 'loading',
    getElementById: (id: string) => (id === 'boot' && !opts.noBoot ? boot : null),
    querySelector: (sel: string) => {
      if (sel === OPEN_OVERLAY) return children.find((c) => /^UI-(DRAWER|DIALOG)$/.test(c.tagName) && c.open) ?? null;
      expect(sel).toBe('.app');
      return opts.app === null ? null : app;
    },
    querySelectorAll: (sel: string) => {
      expect(sel).toBe(':not(:defined)');
      if (opts.noDefinedSelector) throw new SyntaxError("':defined' is not a valid selector");
      return undefinedEls.map((b) => ({ getBoundingClientRect: () => b }));
    },
    addEventListener: (type: string, fn: () => void) => {
      if (type === 'DOMContentLoaded') ready.push(fn);
    },
  };
  const window = { innerWidth: opts.width ?? 390, innerHeight: 844 };
  const localStorage = {
    getItem: (key: string) => {
      expect(key).toBe('soma-board-view');
      if (opts.saved === 'throws') throw new Error('SecurityError');
      return opts.saved ?? null;
    },
  };
  const requestAnimationFrame = (fn: () => void) => frames.push(fn);
  const setTimeout = (fn: () => void, ms: number) => timers.push({ at: now + ms, fn });
  new Function('document', 'window', 'requestAnimationFrame', 'setTimeout', 'localStorage', bootClientJs())(
    document,
    window,
    requestAnimationFrame,
    setTimeout,
    localStorage,
  );
  return {
    get out() {
      return classes.has('is-out');
    },
    get attached() {
      return attached;
    },
    /** One painted frame: the callbacks queued before it run. */
    frame(n = 1) {
      for (let i = 0; i < n; i++) {
        const run = frames;
        frames = [];
        for (const fn of run) fn();
      }
    },
    advance(ms: number) {
      now += ms;
      const due = timers.filter((t) => t.at <= now);
      timers = timers.filter((t) => t.at > now);
      for (const t of due) t.fn();
    },
    parsed() {
      document.readyState = 'interactive';
    },
    domContentLoaded() {
      document.readyState = 'interactive';
      for (const fn of ready) fn();
    },
    setUndefined(els: Box[]) {
      undefinedEls = els;
    },
    append,
    /** An overlay child (by tag) opens, as <ui-drawer> / <ui-dialog> reflect it. */
    openOverlay(tag: string) {
      const c = children.find((x) => x.tagName === tag.toUpperCase());
      if (!c) throw new Error(`no ${tag}`);
      c.open = true;
    },
    get view() {
      return attrs['data-view'];
    },
    /** Each .app child as tag:inert. */
    get inert() {
      return children.map((c) => `${c.tagName.toLowerCase()}:${c.inert}`);
    },
  };
}

describe('[T1] overlays the page carries are hidden until defined', () => {
  // The page sheet (its first plain <style>, comments out) and its rules that hide a selector list outright.
  const open = TEMPLATE.indexOf('<style>\n');
  const sheet = TEMPLATE.slice(open, TEMPLATE.indexOf('</style>', open)).replace(/\/\*[\s\S]*?\*\//g, '');
  const hiding = Array.from(sheet.matchAll(/([^{}]+)\{\s*display:\s*none;\s*\}/g), (m) =>
    m[1].split(',').map((s) => s.trim()),
  ).flat();
  const overlays = ['ui-dialog', 'ui-drawer', 'ui-hovercard', 'ui-artifact-viewer'];

  it.each(overlays)('<%s> is in the markup and the sheet hides it until defined', (tag) => {
    expect(TEMPLATE).toMatch(new RegExp(`<${tag}[\\s>]`));
    expect(hiding).toContain(`${tag}:not(:defined)`);
  });
});

describe('[T2] the first screen is wired first in <body>, its rules after the kit sheet', () => {
  it('the body opens with the slot, and the rendered page fills it', () => {
    const body = TEMPLATE.slice(TEMPLATE.indexOf('<body '));
    const head = body.slice(body.indexOf('>') + 1, body.indexOf('<div class="app">')).trim();
    expect(head).toBe(BOOT_SCREEN_SLOT);
    expect(TEMPLATE).toContain('return withBootScreen(fillUiIcons(`<!DOCTYPE html>');
  });
  it('the slot takes the layer, then its script — tagged, so the page script stays the only bare <script>', () => {
    const page = withBootScreen(`<body>\n${BOOT_SCREEN_SLOT}\n<div class="app"></div>\n<script>app()</script></body>`);
    expect(
      page.startsWith(`<body>\n${bootScreenHtml()}\n<script data-boot>${bootClientJs()}</script>\n<div class="app">`),
    ).toBe(true);
    expect(page.match(/<script>([\s\S]*?)<\/script>/)?.[1]).toBe('app()');
  });
  it('its rules come after the kit sheet (.ui-skeleton) inside <head>', () => {
    const kit = TEMPLATE.indexOf(`\${uiLibKitCss()}`);
    const css = TEMPLATE.indexOf(`\${bootScreenCss()}`);
    expect(kit).toBeGreaterThan(0);
    expect(css).toBeGreaterThan(kit);
    expect(css).toBeLessThan(TEMPLATE.indexOf('</head>'));
  });
});

describe('[T2] the layer is the page in outline', () => {
  const html = bootScreenHtml();
  it('is hidden from assistive tech and carries no words to translate', () => {
    expect(html).toMatch(/^<div class="boot" id="boot" aria-hidden="true">/);
    expect(html).not.toMatch(/[가-힣]/);
  });
  it('draws the board skeleton the kit draws: three columns, 2 · 3 · 2 cards', () => {
    const cols = html.split('class="boot-col"').slice(1);
    expect(cols.map((c) => c.split('class="boot-card"').length - 1)).toEqual([2, 3, 2]);
  });
  it('the brand mark rests at the bar pattern (where it stands: [T7])', () => {
    expect(html.match(/<rect /g)).toHaveLength(4);
    expect(bootScreenCss()).toContain('.boot-mark rect:nth-child(3) { opacity: 0.25;');
  });
  it('a fast load sees still blocks: the pulse waits 500 ms, the mark 1 s; reduced motion stills the mark', () => {
    const css = bootScreenCss();
    expect(css).toContain('.boot .ui-skeleton { animation-delay: calc(500ms + var(--i, 0) * 120ms); }');
    expect(css).toContain('.boot-mark rect { animation: boot-mark 1.6s ease-in-out 1s infinite; }');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.boot-mark rect \{ animation: none; \}/);
  });
  it('without script it still goes, at 15 s', () => {
    expect(bootScreenCss()).toContain('animation: boot-gone 0s linear 15s forwards;');
  });
});

describe('[T2] the layer lifts when the viewport shows nothing undefined', () => {
  const bar = box(0, 0, 390, 52);
  it('stays while the document is parsed, even with nothing undefined yet', () => {
    const p = page();
    p.frame(5);
    expect(p.out).toBe(false);
  });
  it('parsed, a visible undefined element holds it; once defined, it lifts a frame later', () => {
    const p = page({ undefinedEls: [bar] });
    p.parsed();
    p.frame(5);
    expect(p.out).toBe(false);
    p.setUndefined([]);
    p.frame();
    expect(p.out).toBe(false); // the real page paints one frame under the layer first
    p.frame();
    expect(p.out).toBe(true);
  });
  it('an undefined element with no box (a closed dialog, a hidden section) or below the fold does not hold it', () => {
    const p = page({ undefinedEls: [box(0, 0, 0, 0), box(0, 900, 390, 60), box(400, 0, 300, 50)] });
    p.parsed();
    p.frame(2);
    expect(p.out).toBe(true);
  });
  it('an empty board (a box with no height yet) holds it', () => {
    const p = page({ undefinedEls: [box(12, 188, 366, 0)] });
    p.parsed();
    p.frame(3);
    expect(p.out).toBe(false);
  });
  it('DOMContentLoaded lifts it even when an element never gets defined (its module failed)', () => {
    const p = page({ undefinedEls: [bar] });
    p.domContentLoaded();
    p.frame();
    expect(p.out).toBe(true);
  });
  it('12 s lifts it with nothing else (a module request that never answers holds DOMContentLoaded)', () => {
    const p = page({ undefinedEls: [bar] });
    p.advance(11999);
    expect(p.out).toBe(false);
    p.advance(1);
    expect(p.out).toBe(true);
  });
  it('it leaves the DOM 400 ms after the fade starts; a second lift is no-op', () => {
    const p = page();
    p.domContentLoaded();
    p.frame();
    expect(p.out).toBe(true);
    p.advance(399);
    expect(p.attached).toBe(true);
    p.advance(1);
    expect(p.attached).toBe(false);
    p.advance(12000); // the 12 s timer fires on a removed layer
    expect(p.attached).toBe(false);
  });
  it('a browser without :defined lifts it once parsed', () => {
    const p = page({ noDefinedSelector: true });
    p.parsed();
    p.frame(2);
    expect(p.out).toBe(true);
  });
  it('a page without the layer runs the script without error', () => {
    expect(() => page({ noBoot: true })).not.toThrow();
  });
});

describe('[T5 #969] the page under the layer takes no keyboard focus while it is up', () => {
  const APP: Array<[string, boolean?]> = [['header'], ['div'], ['ui-drawer'], ['p'], ['button'], ['ui-dialog']];
  it('every in-flow child of .app goes inert on the first frame; the overlays (drawers, dialogs) never do', () => {
    const p = page({ app: APP });
    expect(p.inert.every((c) => c.endsWith(':false'))).toBe(true);
    p.frame();
    expect(p.inert).toEqual(['header:true', 'div:true', 'ui-drawer:false', 'p:true', 'button:true', 'ui-dialog:false']);
  });
  it('a child the parser adds later goes inert on the next frame', () => {
    const p = page({ app: [['header']] });
    p.frame();
    p.append('div');
    p.frame();
    expect(p.inert).toEqual(['header:true', 'div:true']);
  });
  it.each([
    [
      'the viewport is drawn',
      (p: ReturnType<typeof page>) => {
        p.parsed();
        p.frame(2);
      },
    ],
    [
      'DOMContentLoaded',
      (p: ReturnType<typeof page>) => {
        p.domContentLoaded();
        p.frame();
      },
    ],
    ['12 s', (p: ReturnType<typeof page>) => p.advance(12000)],
  ])('lifting on %s gives every child its focus back', (_name, liftNow) => {
    const p = page({ app: APP, undefinedEls: [] });
    p.frame();
    expect(p.inert[0]).toBe('header:true');
    liftNow(p);
    expect(p.out).toBe(true);
    expect(p.inert.every((c) => c.endsWith(':false'))).toBe(true);
  });
  it('an overlay that opens during boot (a deep link docks its drawer under the layer) lifts it that frame', () => {
    const p = page({ app: APP, undefinedEls: [box(0, 0, 390, 52)] });
    p.frame();
    expect(p.out).toBe(false);
    p.openOverlay('ui-drawer');
    p.frame();
    expect(p.out).toBe(true);
    expect(p.inert.every((c) => c.endsWith(':false'))).toBe(true);
  });
  it('a dialog that opens during boot (Ctrl+N) lifts it too', () => {
    const p = page({ app: APP, undefinedEls: [box(0, 0, 390, 52)] });
    p.frame();
    p.openOverlay('ui-dialog');
    p.frame();
    expect(p.out).toBe(true);
  });
  it('a child the page made inert itself stays inert after the lift', () => {
    const p = page({ app: [['header'], ['div', true]] });
    p.frame();
    p.domContentLoaded();
    p.frame();
    expect(p.inert).toEqual(['header:false', 'div:true']);
  });
  it('no .app yet (or at all): nothing to hold, no error', () => {
    const p = page({ app: null });
    expect(() => p.frame(3)).not.toThrow();
    p.domContentLoaded();
    expect(() => p.frame()).not.toThrow();
    expect(p.out).toBe(true);
  });
});

/** The block that opens at `marker` (an at-rule head ending in `{`), up to its matching `}`. */
/** Every block that opens at `marker` (an at-rule head ending in `{`), each up to its matching `}`. */
function blocks(css: string, marker: string): string[] {
  const out: string[] = [];
  for (let start = css.indexOf(marker); start >= 0; start = css.indexOf(marker, start + 1)) {
    let depth = 0;
    for (let i = start + marker.length - 1; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) {
        out.push(css.slice(start + marker.length, i));
        break;
      }
    }
  }
  if (!out.length) throw new Error(`marker not found: ${marker}`);
  return out;
}

/**
 * The value of `prop` in the first rule whose selector is exactly `selector` — at the top level, or (with `from`) in
 * the first block opened by `from` that has that rule. Throws when there is no such rule or property.
 */
function decl(css: string, selector: string, prop: string, from = ''): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = new RegExp(`(?:^|[{}\\n])\\s*${esc}\\s*\\{([^}]*)\\}`);
  const scopes = from ? blocks(css, from) : [css];
  for (const scope of scopes) {
    const m = scope.match(rule);
    if (!m) continue;
    const v = m[1].match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+?)\\s*(?:;|$)`));
    if (!v) throw new Error(`${prop} not in ${selector}`);
    return v[1];
  }
  throw new Error(`rule not found: ${selector}${from ? ` in ${from}` : ''}`);
}

describe('[T7 #969] the layer stands where the page and the kit draw: their numbers, not a copy', () => {
  const dist = uiLibDistDir() as string;
  const bar = readFileSync(join(dist, 'app-bar.js'), 'utf8');
  const inbox = readFileSync(join(dist, 'agent-inbox.js'), 'utf8');
  const open = TEMPLATE.indexOf('<style>\n');
  const sheet = TEMPLATE.slice(open, TEMPLATE.indexOf('</style>', open));
  const boot = bootScreenCss();
  const PHONE = '@media (max-width: 639px) {';

  it('the bar: the kit app bar height, gap and padding; on a phone too', () => {
    expect(decl(boot, '.boot-bar', 'height')).toBe(decl(bar, ':host', 'height'));
    expect(decl(boot, '.boot-bar', 'gap')).toBe(decl(bar, '.ab-bar', 'gap'));
    expect(decl(boot, '.boot-bar', 'padding')).toBe(decl(bar, '.ab-bar', 'padding'));
    expect(decl(boot, '.boot-bar', 'height', PHONE)).toBe(decl(bar, ':host', 'height', PHONE));
    expect(decl(boot, '.boot-bar', 'gap', PHONE)).toBe(decl(bar, '.ab-bar', 'gap', PHONE));
    expect(decl(boot, '.boot-bar', 'padding', PHONE)).toBe(decl(bar, '.ab-bar', 'padding', PHONE));
    expect(decl(boot, '.boot-brand', 'gap')).toBe(decl(bar, '.ab-brand', 'gap'));
  });
  it('the main column and the board head: the page sheet', () => {
    expect(decl(boot, '.boot-main', 'max-width')).toBe(decl(sheet, '.main', 'max-width'));
    expect(decl(boot, '.boot-main', 'padding')).toBe(decl(sheet, '.main', 'padding'));
    expect(decl(boot, '.boot-main', 'padding', PHONE)).toBe(decl(sheet, '.main', 'padding', PHONE));
    expect(decl(boot, '.boot-head', 'margin')).toBe(decl(sheet, '.inbox-head', 'margin'));
    expect(decl(boot, '.boot-head', 'margin-bottom', PHONE)).toBe(decl(sheet, '.inbox-head', 'margin-bottom', PHONE));
  });
  it('the board: the kit columns, column head and skeleton card', () => {
    expect(decl(boot, '.boot-board', 'gap')).toBe(decl(inbox, '.ib-board', 'gap'));
    expect(decl(boot, '.boot-col', 'padding')).toBe(decl(inbox, '.ib-col', 'padding'));
    expect(decl(boot, '.boot-col', 'border-radius')).toBe(decl(inbox, '.ib-col', 'border-radius'));
    expect(decl(boot, '.boot-col-head', 'padding')).toBe(decl(inbox, '.ib-col-head', 'padding'));
    expect(decl(boot, '.boot-col-head', 'min-height')).toBe(decl(inbox, '.ib-col-head', 'min-height'));
    for (const p of ['padding', 'gap', 'border-radius']) {
      expect(decl(boot, '.boot-card', p)).toBe(decl(inbox, '.ib-skel-card', p));
    }
    for (const [b, k] of [
      ['.boot .boot-title', '.ib-sk-title'],
      ['.boot .boot-meta', '.ib-sk-meta'],
      ['.boot .boot-pill', '.ib-sk-pill'],
    ]) {
      expect(decl(boot, b, 'height')).toBe(decl(inbox, k, 'height'));
      expect(decl(boot, b, 'width')).toBe(decl(inbox, k, 'width'));
    }
  });
  it('the list view and the narrow board: the kit rules, at the kit breakpoint', () => {
    expect(decl(boot, '.boot[data-view="list"] .boot-board', 'grid-template-columns')).toBe(
      decl(inbox, '.ib[data-view="list"] .ib-board', 'grid-template-columns'),
    );
    const narrow = inbox.match(/@container ib (\(max-width: \d+px\)) \{\s*\.ib:not\(\[data-view="list"\]\) \.ib-board/);
    expect(narrow).not.toBeNull();
    const at = `@container boot ${narrow?.[1]} {`;
    expect(decl(boot, '.boot:not([data-view="list"]) .boot-board', 'grid-template-columns', at)).toBe(
      decl(
        inbox,
        '.ib:not([data-view="list"]) .ib-board',
        'grid-template-columns',
        `@container ib ${narrow?.[1]} {`,
      ).replace('var(--ib-cols, 3)', '3'),
    );
    // The kit measures the board's own box (.ib, a container); the layer measures the main column's content box —
    // the same width, as the board fills the main column.
    expect(decl(inbox, '.ib', 'container')).toBe('ib / inline-size');
    expect(decl(boot, '.boot-main', 'container')).toBe('boot / inline-size');
  });
});

/** The page's own client function, cut out of renderDashboardPage's template (a plain slice: no backticks, no ${}). */
function pageFn(name: string): (...args: unknown[]) => unknown {
  const start = TEMPLATE.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const src = TEMPLATE.slice(start + 1, TEMPLATE.indexOf('\n}\n', start) + 2);
  if (src.includes('`') || src.includes('${')) throw new Error('not a plain template slice');
  return new Function(`${src}; return ${name};`)() as (...args: unknown[]) => unknown;
}

describe('[T7 #969] the layer draws the board in the view the page will choose', () => {
  const defaultBoardView = pageFn('defaultBoardView');
  const widths = [320, 390, 639, 640, 1024, 1280];
  const saves: Array<string | null> = [null, 'board', 'list', 'columns'];
  it.each(
    widths.flatMap((w) => saves.map((v) => [w, v] as const)),
  )("width %i, saved %s: the page's defaultBoardView", (width, saved) => {
    const p = page({ width, saved });
    expect(p.view).toBe(defaultBoardView(width, saved));
  });
  it('storage that throws: the width decides, as the page (savedBoardView → null)', () => {
    expect(page({ width: 390, saved: 'throws' }).view).toBe(defaultBoardView(390, null));
    expect(page({ width: 1280, saved: 'throws' }).view).toBe(defaultBoardView(1280, null));
  });
});
