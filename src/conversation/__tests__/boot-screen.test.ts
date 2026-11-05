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

function page(opts: { undefinedEls?: Box[]; noBoot?: boolean; noDefinedSelector?: boolean } = {}) {
  const classes = new Set<string>();
  let attached = true;
  const boot = {
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
    querySelectorAll: (sel: string) => {
      expect(sel).toBe(':not(:defined)');
      if (opts.noDefinedSelector) throw new SyntaxError("':defined' is not a valid selector");
      return undefinedEls.map((b) => ({ getBoundingClientRect: () => b }));
    },
    addEventListener: (type: string, fn: () => void) => {
      if (type === 'DOMContentLoaded') ready.push(fn);
    },
  };
  const window = { innerWidth: 390, innerHeight: 844 };
  const requestAnimationFrame = (fn: () => void) => frames.push(fn);
  const setTimeout = (fn: () => void, ms: number) => timers.push({ at: now + ms, fn });
  new Function('document', 'window', 'requestAnimationFrame', 'setTimeout', bootClientJs())(
    document,
    window,
    requestAnimationFrame,
    setTimeout,
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
  it('the brand mark sits where the bar draws it, resting at the bar pattern', () => {
    expect(html.match(/<rect /g)).toHaveLength(4);
    const css = bootScreenCss();
    expect(css).toContain('.boot-bar { display: flex; align-items: center; gap: 10px; height: 56px; padding: 0 20px;');
    expect(css).toContain('.boot-bar { height: 52px; padding: 0 12px; gap: 8px; }');
    expect(css).toContain('.boot-mark rect:nth-child(3) { opacity: 0.25;');
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
