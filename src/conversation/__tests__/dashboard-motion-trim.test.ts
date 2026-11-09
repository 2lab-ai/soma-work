/**
 * Motion trim (2026-11-10): the local `remove-animations` / `animation-performance` skills, run against the dashboard.
 * The executed checks (runLayoutCheck and the deck slide skip under a key) live in dashboard-responsive and
 * dashboard-three-surfaces-client. These pin the CSS.
 * - The detail panel scrolls without smooth behaviour: every programmatic scroll there asks for 'instant', and a
 *   focus move should not glide.
 * - The compaction bar has no width transition: its tick rewrites the bar, so the transition never ran.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));

function clientFn(name: string): string {
  const start = TEMPLATE.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const line = TEMPLATE.indexOf('\n', start + 1);
  const end = TEMPLATE.slice(start + 1, line)
    .trimEnd()
    .endsWith('}')
    ? line
    : TEMPLATE.indexOf('\n}\n', start) + 2;
  return TEMPLATE.slice(start + 1, end);
}

describe('dashboard motion trim', () => {
  it('"a key just did it" is the last input being a key within 600ms — typing, then a resize or a push, still glides', () => {
    const keyedNow = (atKeyed: boolean, keyAt: number) =>
      new Function('_atKeyed', '_keyAt', 'KEYED_MS', `${clientFn('keyedNow')}\nreturn keyedNow();`)(
        atKeyed,
        keyAt,
        600,
      ) as boolean;
    expect(keyedNow(true, Date.now())).toBe(true);
    expect(keyedNow(true, Date.now() - 5_000)).toBe(false);
    expect(keyedNow(false, Date.now())).toBe(false);
    expect(TEMPLATE).toContain(
      "document.addEventListener('keydown', function(e) { if (isActingKey(e) && (!e.repeat || keyOnDeckNav(e))) _keyAt = Date.now(); }, true);",
    );
    expect(TEMPLATE).toMatch(/^var KEYED_MS = 600;$/m);
  });

  it('a held key counts once, except ←/→ held on the deck nav — every repeat there switches a card', () => {
    const onNav = new Function(`${clientFn('keyOnDeckNav')}\nreturn keyOnDeckNav;`)() as (e: unknown) => boolean;
    const el = (tagName: string) => ({ tagName });
    expect(onNav({ composedPath: () => [el('BUTTON'), el('UI-DECK-NAV'), el('DIV')] })).toBe(true);
    expect(onNav({ composedPath: () => [el('UI-AGENT-INBOX'), el('BODY')] })).toBe(false);
    expect(onNav({})).toBe(false);
  });

  it('only a key that acts counts: Esc anywhere; Enter, Space and the arrows outside a text field; never typing', () => {
    const acting = new Function(`${clientFn('isActingKey')}\nreturn isActingKey;`)() as (e: unknown) => boolean;
    const on = (tagName: string, isContentEditable = false) => ({ tagName, isContentEditable });
    expect(acting({ key: 'Enter', target: on('DIV') })).toBe(true);
    expect(acting({ key: 'ArrowRight', target: on('UI-DECK-NAV') })).toBe(true);
    expect(acting({ key: 'Escape', target: on('TEXTAREA') })).toBe(true);
    expect(acting({ key: 'Enter', target: on('TEXTAREA') })).toBe(false);
    expect(acting({ key: 'ArrowLeft', target: on('INPUT') })).toBe(false);
    expect(acting({ key: ' ', target: on('DIV', true) })).toBe(false);
    expect(acting({ key: 'a', target: on('DIV') })).toBe(false);
    expect(acting({ key: 'n', ctrlKey: true, target: on('BODY') })).toBe(false);
    // A field inside a shadow root (a <ui-composer>'s textarea): the document sees the host; the path's first is the field.
    const host = on('UI-COMPOSER');
    expect(acting({ key: ' ', target: host, composedPath: () => [on('TEXTAREA'), host] })).toBe(false);
    expect(acting({ key: 'Enter', target: host, composedPath: () => [host] })).toBe(true);
  });

  it('the detail panel has no smooth scrolling; its corrections stay instant', () => {
    expect(TEMPLATE).toContain('.panel-scroll { flex: 1 1 auto; overflow-y: auto; min-height: 0; }');
    expect(TEMPLATE).not.toMatch(/\.panel-scroll \{[^}]*scroll-behavior/);
    expect(TEMPLATE).toContain("scrollEl.scrollTo({ top: scrollEl.scrollTop + d, behavior: 'instant' });");
  });

  it('the compaction bar steps with its tick (the tick rewrites it, so a width transition never ran)', () => {
    expect(TEMPLATE).toContain(
      '.cp-bar > i { display: block; height: 100%; border-radius: inherit; background: var(--accent); }',
    );
    expect(TEMPLATE).toContain('if (cslot) cslot.innerHTML = cpProgressHtml(');
    expect(TEMPLATE).not.toMatch(/transition: width 1s linear/);
  });

  it('runLayoutCheck and the deck switch skip their motion when a key just did it', () => {
    expect(TEMPLATE).toContain('var keyed = keyedNow();\n  var animate = canAnimate() && !keyed;');
    expect(TEMPLATE).toContain('if (keyed) { _layoutShiftUntil = 0; measureLayout(); return; }');
    expect(TEMPLATE).toContain(
      'if (dir && keyedNow()) deckStop(panel);\n  else if (dir && !reduceMotion()) deckSlide(panel, dir);',
    );
    expect(TEMPLATE).toMatch(/^var DECK_SLIDE_MS = 200;$/m);
  });
});
