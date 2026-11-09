/**
 * Phone feel (2026-11-10) — the local `mobile-native` skill applied to the dashboard: the fixes that separate a website
 * from an installed app. No grey tap flash, taps that fire at once, labels a long press does not select, fields that do
 * not zoom the page, the app height that tracks the URL bar, no pull-to-refresh behind the live board, and the
 * browser chrome in the page's own colour (theme-color, every page through the shared theme script).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { themeClientJs } from '../theme-client';

const TEMPLATE = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');

describe('the dashboard page CSS — mobile-native', () => {
  it('§2 no tap highlight, set once on html', () => {
    expect(TEMPLATE).toMatch(/^html \{ -webkit-tap-highlight-color: transparent; \}$/m);
  });

  it('§5 every control fires its tap at once (no double-tap-zoom wait)', () => {
    expect(TEMPLATE).toContain(
      ':is(button, a, summary, label, select, [role="button"], [role="tab"], [role="switch"], ui-dock, ui-segmented) { touch-action: manipulation; }',
    );
  });

  it('§8 a long press on a control selects nothing; content stays selectable (no body-wide rule)', () => {
    expect(TEMPLATE).toContain(
      ':is(button, [role="tab"], .ui-chip, .ui-btn, .ui-icon-btn, .ui-fab):not(a[href]) { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }',
    );
    expect(TEMPLATE).not.toMatch(/body[^{]*\{[^}]*user-select: none/);
  });

  it('§4 every page field is 16px on a touch screen, a tablet included; zoom is never disabled', () => {
    expect(TEMPLATE).toMatch(
      /@media \(pointer: coarse\) \{\n {2}:is\(input:not\(\[type="checkbox"\], \[type="radio"\], \[type="range"\], \[type="color"\]\), textarea, select\) \{ font-size: 16px !important; \}\n\}/,
    );
    expect(TEMPLATE).not.toMatch(/user-scalable=no|maximum-scale=1/);
  });

  it('§3 the app height tracks the URL bar (dvh after the vh fallback)', () => {
    expect(TEMPLATE).toContain('.app { display: flex; flex-direction: column; min-height: 100vh; min-height: 100dvh;');
  });

  it('§6 no pull-to-refresh or page bounce behind the live board', () => {
    expect(TEMPLATE).toMatch(/html,body \{[^}]*overscroll-behavior-y: none;/);
  });
});

describe('theme-color follows the theme as drawn — mobile-native §10 (the shared theme script)', () => {
  function page(bg: string) {
    const metas: Array<{ attrs: Record<string, string> }> = [];
    const ready: Array<() => void> = [];
    const timers: Array<() => void> = [];
    const attrs: Record<string, string> = {};
    const el = () => {
      const node = {
        attrs: {} as Record<string, string>,
        setAttribute(k: string, v: string) {
          node.attrs[k] = v;
        },
        getAttribute(k: string) {
          return node.attrs[k] ?? null;
        },
      };
      return node;
    };
    const body = { style: {} };
    let colour = bg;
    const document = {
      documentElement: {
        getAttribute: (k: string) => attrs[k] ?? null,
        setAttribute: (k: string, v: string) => {
          attrs[k] = v;
        },
        removeAttribute: (k: string) => {
          delete attrs[k];
        },
      },
      body: null as unknown,
      head: { appendChild: (m: { attrs: Record<string, string> }) => metas.push(m) },
      getElementById: () => null,
      querySelector: (sel: string) =>
        sel === 'meta[name="theme-color"]' ? (metas.find((m) => m.attrs.name === 'theme-color') ?? null) : null,
      createElement: () => el(),
      addEventListener: (type: string, fn: () => void) => {
        if (type === 'DOMContentLoaded') ready.push(fn);
      },
    };
    const window = { matchMedia: () => ({ matches: false, addEventListener() {} }) };
    const localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    const getComputedStyle = () => ({ backgroundColor: colour });
    const setTimeout = (fn: () => void) => timers.push(fn);
    const api = new Function(
      'window',
      'document',
      'localStorage',
      'getComputedStyle',
      'setTimeout',
      `${themeClientJs()}\nreturn { somaThemeSet: somaThemeSet };`,
    )(window, document, localStorage, getComputedStyle, setTimeout) as { somaThemeSet(t: string, p: string): void };
    return {
      metas,
      api,
      load() {
        document.body = body;
        for (const fn of ready) fn();
      },
      paint(next: string) {
        colour = next;
      },
      settle() {
        for (const fn of timers.splice(0)) fn();
      },
    };
  }

  it('before <body> it waits; at DOMContentLoaded it writes the page colour into one theme-color meta', () => {
    const p = page('rgb(28, 28, 31)');
    expect(p.metas).toHaveLength(0);
    p.load();
    expect(p.metas).toHaveLength(1);
    expect(p.metas[0].attrs).toEqual({ name: 'theme-color', content: 'rgb(28, 28, 31)' });
  });

  it('a theme switch moves it to the new colour once the transition settles, in the same meta', () => {
    const p = page('rgb(28, 28, 31)');
    p.load();
    p.api.somaThemeSet('light', 'color');
    p.paint('rgb(247, 247, 247)');
    p.settle();
    expect(p.metas).toHaveLength(1);
    expect(p.metas[0].attrs.content).toBe('rgb(247, 247, 247)');
  });

  it('a transparent page leaves it alone', () => {
    const p = page('rgba(0, 0, 0, 0)');
    p.load();
    expect(p.metas).toHaveLength(0);
  });
});
