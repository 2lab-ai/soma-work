/**
 * The task card's finish by model (SSOT 2026-11-17): sonnet as before, sol · opus a brighter 2px edge, astra · fable a
 * 2px holo-foil edge on a foil surface. The client half runs as shipped (String.raw), and the page wiring is read from
 * the dashboard template: the theme inputs, the script, and the two paths that refresh it. The sheet's trip into each
 * element's shadow root runs in card-finish-client.dom.test.ts.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CARD_FINISH_CLIENT_JS, CARD_FINISH_CSS } from '../card-finish-client';

type Card = { key: unknown; model?: unknown };
const client = new Function(`${CARD_FINISH_CLIENT_JS}\nreturn { cardFinishOf, cardFinishSheet };`)() as {
  cardFinishOf(model: unknown): '' | 'bright' | 'foil';
  cardFinishSheet(cards: Card[]): string;
};

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));
/** A template slot as the page's source spells it: the dollar-brace, the name, the brace. */
const slot = (name: string) => `\${${name}}`;
function fnBody(name: string): string {
  const start = TEMPLATE.indexOf(`function ${name}(`);
  if (start < 0) return '';
  const end = TEMPLATE.indexOf('\n}\n', start);
  return TEMPLATE.slice(start, end < 0 ? undefined : end);
}

/** The rule blocks whose selector lists exactly these keys (in any order), and the keys a selector lists. */
function keysOf(sel: string): string[] {
  return Array.from(sel.matchAll(/\[data-card="((?:[^"\\]|\\.)*)"\]/g), (m) => m[1]);
}

describe('cardFinishOf — which models get which finish', () => {
  it.each([
    ['claude-sonnet-5-5[1m]', ''],
    ['claude-sonnet-4-6', ''],
    ['sonnet[1m]', ''],
    ['grok-4.7', ''],
    ['claude-haiku-4-5', ''],
    ['gemini-3-pro', ''],
    ['unknown', ''],
    ['', ''],
    [undefined, ''],
    ['claude-opus-5-5[1m]', 'bright'],
    ['claude-opus-4-7', 'bright'],
    ['opus[1m]', 'bright'],
    ['gpt-6.1-sol[1m]', 'bright'],
    ['gpt-5.6-sol', 'bright'],
    ['sol', 'bright'],
    ['gpt-6-astra[1m]', 'foil'],
    ['astra', 'foil'],
    ['claude-fable-5-2[1m]', 'foil'],
    ['claude-fable-5', 'foil'],
    ['Claude-Fable-5[1M]', 'foil'],
  ])('%s → %s', (model, finish) => {
    expect(client.cardFinishOf(model)).toBe(finish);
  });

  it('matches a family only as a whole word — a name that merely contains it keeps the plain card', () => {
    for (const m of ['console-1', 'solar-2', 'gpt-6-astral', 'opusx', 'fabled-1', 'my-solo']) {
      expect(client.cardFinishOf(m)).toBe('');
    }
  });
});

describe('cardFinishSheet — one sheet for every drawn card', () => {
  it('is empty when no card has a finish (sonnet keeps the element’s own card)', () => {
    expect(client.cardFinishSheet([])).toBe('');
    expect(
      client.cardFinishSheet([
        { key: 'a', model: 'claude-sonnet-5-5[1m]' },
        { key: 'b', model: 'grok-4.7' },
      ]),
    ).toBe('');
  });

  it('gives sol · opus a brighter 2px edge and astra · fable a 2px foil edge with the foil surface', () => {
    const css = client.cardFinishSheet([
      { key: 's1', model: 'claude-sonnet-5-5[1m]' },
      { key: 'o1', model: 'claude-opus-5-5[1m]' },
      { key: 'l1', model: 'gpt-6.1-sol[1m]' },
      { key: 'a1', model: 'gpt-6-astra[1m]' },
      { key: 'f1', model: 'claude-fable-5-2[1m]' },
    ]);
    const rules = css.split('\n');
    const bright = rules.find((r) => r.includes('border-width: 2px; border-color: var(--finish-bright);')) ?? '';
    expect(keysOf(bright)).toEqual(['l1', 'o1']);
    const foil = rules.find((r) => r.includes('border: 2px solid transparent;')) ?? '';
    expect(keysOf(foil)).toEqual(['a1', 'f1']);
    expect(foil).toContain(
      'background-image: var(--finish-sheen), linear-gradient(var(--finish-base), var(--finish-base)), var(--finish-glint), var(--finish-holo);',
    );
    expect(foil).toContain('background-clip: padding-box, padding-box, border-box, border-box;');
    // The sonnet card is in no rule.
    expect(css).not.toContain('"s1"');
    // Both 2px finishes move the element's 1px-border marks out by a pixel.
    const rail = rules.find((r) => r.includes('.is-attention:not(.is-open)::before')) ?? '';
    expect(keysOf(rail)).toEqual(['l1', 'o1', 'a1', 'f1']);
    expect(rail).toContain('left: -2px; top: 10px; bottom: 10px;');
    expect(rules.some((r) => r.includes('.is-attention:not(.is-open)::after { inset: -2px; }'))).toBe(true);
    expect(rules.some((r) => r.includes('> .ib-tie { inset-block: -10px -2px;'))).toBe(true);
  });

  it('beats the element’s plain states but not its cues (NEEDS YOU, the epic family)', () => {
    const css = client.cardFinishSheet([{ key: 'o1', model: 'claude-opus-5-5[1m]' }]);
    // li.ib-card:is([data-card]) is (0,2,1): above .ib-card[data-status] and .ib-card:hover (0,2,0), below
    // .ib-card.is-attention:not(.is-open) (0,3,0).
    expect(css).toContain('\nli.ib-card:is([data-card="o1"]) { border-width: 2px;');
    expect(css).not.toContain('!important');
    expect(css).not.toMatch(/is-attention:not\(\.is-open\)\s*\{/);
    expect(css).not.toContain('is-kin');
  });

  it('keeps hover where a pointer hovers, stills the sheen under reduced motion, and yields to forced colours', () => {
    const css = client.cardFinishSheet([
      { key: 'f1', model: 'claude-fable-5' },
      { key: 'o1', model: 'opus' },
    ]);
    expect(css).toContain(
      '@media (hover: hover) and (pointer: fine) { li.ib-card:is([data-card="f1"]):hover { border-color: transparent; background-position: 100% 100%, 0 0, 100% 100%, 0 0; } }',
    );
    expect(css).toContain(
      '@media (hover: hover) and (pointer: fine) { li.ib-card:is([data-card="o1"]):hover { border-color: var(--finish-bright-hover); } }',
    );
    expect(css).toContain(
      '@media (prefers-reduced-motion: reduce) { li.ib-card:is([data-card="f1"]) { transition: border-color 150ms ease, box-shadow 150ms ease; } }',
    );
    expect(css).toContain(
      '@media (forced-colors: active) { li.ib-card:is([data-card="f1"]) { border-color: CanvasText; background: Canvas; } }',
    );
  });

  it('is the same text whatever order the cards come in, and lists a key once', () => {
    const a = client.cardFinishSheet([
      { key: 'b', model: 'opus' },
      { key: 'a', model: 'opus' },
      { key: 'c', model: 'fable' },
    ]);
    const b = client.cardFinishSheet([
      { key: 'c', model: 'fable' },
      { key: 'a', model: 'opus' },
      { key: 'b', model: 'opus' },
      { key: 'a', model: 'opus' },
    ]);
    expect(a).toBe(b);
    expect(keysOf(a.split('\n').find((r) => r.includes('border-width: 2px')) ?? '')).toEqual(['a', 'b']);
  });

  it('escapes a key inside the CSS string — a quote or a backslash cannot end the selector', () => {
    const css = client.cardFinishSheet([
      { key: 'x"] , body { color: red } [a="', model: 'opus' },
      { key: 'y\\z', model: 'opus' },
    ]);
    expect(css).toContain('[data-card="x\\"] , body { color: red } [a=\\""]');
    expect(css).toContain('[data-card="y\\\\z"]');
    expect(css).not.toContain('[data-card="x"]');
  });

  it('skips cards without a key', () => {
    expect(
      client.cardFinishSheet([
        { key: '', model: 'opus' },
        { key: null, model: 'fable' },
      ]),
    ).toBe('');
  });
});

describe('the finish’s values — themes, mono, an idle card', () => {
  it('puts the theme’s inputs on :root — dark by default, softer in light, chrome (no hue) in mono', () => {
    expect(CARD_FINISH_CSS).toContain(':root {');
    expect(CARD_FINISH_CSS).toContain(':root[data-theme="light"] {');
    const mono = CARD_FINISH_CSS.slice(CARD_FINISH_CSS.indexOf(':root[data-palette="mono"] {'));
    expect(mono).toContain('--finish-holo: linear-gradient(105deg, var(--ib-muted) 0%, var(--ib-text) 24%');
    expect(mono).not.toMatch(/var\(--(purple|accent|green|yellow|orange|red)\)/);
    // Selectors do not cross into the element's shadow root; only inherited custom properties do.
    expect(CARD_FINISH_CSS).not.toContain('li.ib-card');
  });

  it('uses the model picker’s ultra-foil hues for the edge (each 78% toward the ink)', () => {
    for (const hue of ['purple', 'accent', 'green', 'yellow', 'orange', 'red']) {
      expect(CARD_FINISH_CSS).toContain(`color-mix(in srgb, var(--${hue}) 78%, var(--ib-text))`);
    }
  });

  it('leads the sheet with what a card reads; an idle card keeps its dimmed surface and a fainter sheen', () => {
    const css = client.cardFinishSheet([{ key: 'f1', model: 'fable' }]);
    expect(css.startsWith('li.ib-card {\n  --finish-base: var(--ib-card);')).toBe(true);
    expect(css).toContain(
      'li.ib-card[data-status="idle"] { --finish-base: var(--ib-card-dim); --finish-sheen-a: var(--finish-sheen-a-idle, 5%); }',
    );
    // The theme sets only the inputs, never the per-card values the idle rule sets.
    expect(CARD_FINISH_CSS).not.toMatch(/--finish-sheen-a:|--finish-base:/);
  });

  it('is plain text for the browser: no template syntax, no backtick', () => {
    expect(CARD_FINISH_CLIENT_JS).not.toContain('`');
    expect(CARD_FINISH_CLIENT_JS).not.toContain('${');
    expect(CARD_FINISH_CSS).not.toContain('${');
  });
});

describe('the dashboard draws it', () => {
  it('ships the script, the values and the sheet the page rewrites', () => {
    expect(DASHBOARD_TS).toContain("import { CARD_FINISH_CLIENT_JS, CARD_FINISH_CSS } from './card-finish-client';");
    expect(TEMPLATE).toContain(slot('CARD_FINISH_CLIENT_JS'));
    expect(TEMPLATE).toContain(`<style id="card-finish-css">\n${slot('CARD_FINISH_CSS')}\n</style>`);
  });

  it('syncCardFinish lists every drawn card with its model and paints every board element', () => {
    const body = fnBody('syncCardFinish');
    expect(body).toContain(
      'if (_cardDrawn[k] && _sessionCache[k]) cards.push({ key: k, model: _sessionCache[k].model });',
    );
    expect(body).toContain("var hosts = document.querySelectorAll('ui-agent-inbox');");
    expect(body).toContain('cardFinishPaint(hosts[i], css);');
    // A paint before the element was defined found no shadow root: once it is, the sheet goes in.
    expect(TEMPLATE).toContain("customElements.whenDefined('ui-agent-inbox').then(function() { syncCardFinish(); });");
  });

  it('refreshes after every paint and after a card’s own update (a model switch the face may not show)', () => {
    expect(fnBody('inboxPaint')).toContain("if (typeof syncCardFinish === 'function') syncCardFinish();");
    expect(fnBody('refreshCard')).toContain("if (typeof syncCardFinish === 'function') syncCardFinish();");
  });
});
