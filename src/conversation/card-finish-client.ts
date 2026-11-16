/**
 * The task card's finish by its model (SSOT 2026-11-17) — the card's edge says which model runs the task:
 *  - sonnet, and every model not named below (grok, haiku, gemini, an id the page does not know): the element's own
 *    card, a 1px border, as before;
 *  - sol · opus: a brighter edge, 2px;
 *  - astra · fable: a 2px holographic-foil edge (the model picker's ultra effort colours) on a faint foil surface,
 *    whose sheen and the edge's glint slide across under a pointer.
 *
 * Where it is drawn: <ui-agent-inbox> (the board, each CRON lane box) draws its cards as
 * `li.ib-card[data-card="<session key>"]` inside its open shadow root, where the page's sheets do not reach, and gives
 * a card no style hook of its own. So the page puts one `<style data-card-finish>` into each element's shadow root —
 * beside the element's own <style>, outside the part it re-renders — whose selectors list the cards of each finish by
 * key (`cardFinishSheet`, written by `cardFinishPaint`, driven by the page's `syncCardFinish`). The inputs that depend
 * on the theme on <html> — light or dark, the mono palette — are custom properties on :root (`CARD_FINISH_CSS`, a page
 * sheet); custom properties inherit into the shadow tree, selectors do not.
 *
 * Specificity: a finished card's selector, `li.ib-card:is([data-card="…"])`, is (0,2,1). It beats the element's
 * plain states — `.ib-card`, `.ib-card[data-status]`, `.ib-card:hover`, the idle card's hover — and loses to its
 * cues: NEEDS YOU (`.is-attention`, (0,3,0) and up) and the epic family's mark (`.is-kin`), so those still recolour
 * the edge while they are on. The 2px edge moves the element's three marks that sit on a 1px border — the NEEDS YOU
 * rail and ring, and an epic child's connector — out by the extra pixel (`CARD_FINISH_EDGE_2PX`).
 *
 * Plain ES5 with no template syntax: it reaches the browser byte for byte (String.raw).
 */
export const CARD_FINISH_CLIENT_JS = String.raw`
// ── The task card's finish by model (card-finish-client.ts) ──
// A model id names its family as a whole word: claude-opus-5-5[1m], gpt-6.1-sol[1m], gpt-6-astra[1m],
// claude-fable-5-2[1m], or a bare nickname (opus[1m]). 'foil' · 'bright' · '' (the element's own card).
var CARD_FINISH_FOIL_RE = /(?:^|[^a-z0-9])(?:fable|astra)(?![a-z0-9])/;
var CARD_FINISH_BRIGHT_RE = /(?:^|[^a-z0-9])(?:opus|sol)(?![a-z0-9])/;
function cardFinishOf(model) {
  var m = String(model || '').toLowerCase();
  if (CARD_FINISH_FOIL_RE.test(m)) return 'foil';
  if (CARD_FINISH_BRIGHT_RE.test(m)) return 'bright';
  return '';
}
// What a finished card reads, on every card so each resolves against its own state: an idle card (the element dims a
// parked card with colour) keeps its dimmed surface and a fainter sheen. The theme's inputs come from :root
// (CARD_FINISH_CSS), their one source.
var CARD_FINISH_CARD_CSS = [
  'li.ib-card {',
  '  --finish-base: var(--ib-card);',
  '  --finish-sheen-a: var(--finish-sheen-a-on);',
  '  --finish-bright: color-mix(in srgb, var(--ib-text) var(--finish-bright-mix), var(--ib-card-border));',
  '  --finish-bright-hover: color-mix(in srgb, var(--ib-text) var(--finish-bright-hover-mix), var(--ib-card-border));',
  '  --finish-bright-idle: color-mix(in srgb, var(--ib-text) var(--finish-bright-idle-mix), var(--ib-card-border));',
  '  --finish-sheen: linear-gradient(115deg,',
  '    color-mix(in srgb, var(--finish-sheen-1) var(--finish-sheen-a), transparent) 0%,',
  '    color-mix(in srgb, var(--finish-sheen-2) var(--finish-sheen-a), transparent) 22%,',
  '    transparent 38%,',
  '    color-mix(in srgb, var(--finish-sheen-3) var(--finish-sheen-a), transparent) 52%,',
  '    color-mix(in srgb, var(--finish-sheen-4) var(--finish-sheen-a), transparent) 70%,',
  '    transparent 84%,',
  '    color-mix(in srgb, var(--finish-sheen-5) var(--finish-sheen-a), transparent) 100%);',
  '}',
  'li.ib-card[data-status="idle"] { --finish-base: var(--ib-card-dim); --finish-sheen-a: var(--finish-sheen-a-idle); }',
].join('\n');
// Each finish's rules; & is the finished cards' selector. Hover only where a pointer hovers (the element's rule).
var CARD_FINISH_RULES = {
  bright: [
    '& { border-width: 2px; border-color: var(--finish-bright); }',
    '@media (hover: hover) and (pointer: fine) { &:hover { border-color: var(--finish-bright-hover); } }',
    // After the hover rule at the same (0,3,1), so an idle card keeps its edge under the pointer — and stays below the
    // epic family's mark (0,4,0), which must recolour it.
    '&[data-status="idle"] { border-color: var(--finish-bright-idle); }',
  ],
  // Four layers: the foil sheen and the card's own surface inside the edge, the glint and the holo foil under it.
  foil: [
    '& { border: 2px solid transparent; background-color: var(--finish-base);'
      + ' background-image: var(--finish-sheen), linear-gradient(var(--finish-base), var(--finish-base)), var(--finish-glint), var(--finish-holo);'
      + ' background-clip: padding-box, padding-box, border-box, border-box;'
      + ' background-origin: border-box; background-repeat: no-repeat;'
      + ' background-size: 250% 250%, 100% 100%, 250% 250%, 100% 100%;'
      + ' background-position: 0% 0%, 0 0, 0% 0%, 0 0;'
      + ' transition: border-color 150ms ease, box-shadow 150ms ease, background-position 900ms var(--ease-out, ease-out); }',
    '@media (hover: hover) and (pointer: fine) { &:hover { border-color: transparent; background-position: 100% 100%, 0 0, 100% 100%, 0 0; } }',
    '@media (prefers-reduced-motion: reduce) { & { transition: border-color 150ms ease, box-shadow 150ms ease; } }',
    '@media (forced-colors: active) { & { border-color: CanvasText; background: Canvas; } }',
  ],
};
// The 2px edge moves the element's marks drawn on its 1px border out by the extra pixel: the NEEDS YOU rail and ring
// (@2lab.ai/ui 0.32.0: left / inset -1px, the rail 11px in) and an epic child's connector (0.37.0: -9px / -1px).
var CARD_FINISH_EDGE_2PX = [
  '&.is-attention:not(.is-open)::before { left: -2px; top: 10px; bottom: 10px; }',
  '&.is-attention:not(.is-open)::after { inset: -2px; }',
  '&.is-tied:not(.is-exiting) > .ib-tie { inset-block: -10px -2px; inset-inline-start: calc(-2px - var(--ib-tie-in) / 2); }',
];
// A key inside a CSS string: a quote and a backslash escaped, a line break dropped (a session key holds neither).
function cardFinishKeyCss(key) {
  return String(key).replace(/[\\"]/g, '\\$&').replace(/[\r\n\f]/g, '');
}
function cardFinishRules(rules, keys) {
  var sel = 'li.ib-card:is(' + keys.map(function(k) { return '[data-card="' + cardFinishKeyCss(k) + '"]'; }).join(', ') + ')';
  return rules.map(function(r) { return r.split('&').join(sel); }).join('\n');
}
// The sheet for these cards ({ key, model } each, keys unique — the page's card map): what a card reads, then the rules of each finish over its cards'
// keys, in key order so the text only changes when a card's finish does. '' when no card has one. The same cards give
// the same string back (the last one kept), so a repeat costs the sort and no rebuild, and a host compares by reference.
var _cardFinishLast = { sig: '', css: '' };
function cardFinishSheet(cards) {
  var by = { bright: [], foil: [] };
  for (var i = 0; i < (cards || []).length; i++) {
    var c = cards[i];
    if (!c || c.key === undefined || c.key === null || c.key === '') continue;
    var f = cardFinishOf(c.model);
    if (f) by[f].push(String(c.key));
  }
  by.bright.sort();
  by.foil.sort();
  var all = by.bright.concat(by.foil);
  if (!all.length) return '';
  var sig = by.bright.join('\n') + '\n\n' + by.foil.join('\n');
  if (sig === _cardFinishLast.sig) return _cardFinishLast.css;
  var out = [CARD_FINISH_CARD_CSS];
  if (by.bright.length) out.push(cardFinishRules(CARD_FINISH_RULES.bright, by.bright));
  if (by.foil.length) out.push(cardFinishRules(CARD_FINISH_RULES.foil, by.foil));
  out.push(cardFinishRules(CARD_FINISH_EDGE_2PX, all));
  _cardFinishLast = { sig: sig, css: out.join('\n') };
  return _cardFinishLast.css;
}
// The sheet into one element's shadow root, after the element's own <style> and outside the .ui-root it re-renders:
// one <style data-card-finish>, written only when its text changes. An element not yet upgraded (no shadow root)
// waits for the next paint.
function cardFinishPaint(host, css) {
  var root = host && host.shadowRoot;
  if (!root) return;
  var el = root.querySelector('style[data-card-finish]');
  if (!el) {
    if (!css) return;
    el = document.createElement('style');
    el.setAttribute('data-card-finish', '');
    root.appendChild(el);
  }
  if (el._finishCss !== css) {
    el.textContent = css;
    el._finishCss = css;
  }
}
`;

/**
 * The theme's inputs, on :root (a page sheet): every value that depends on <html>'s data-theme / data-palette, read
 * inherited inside the element's shadow root. Dark is the default; light mixes less ink into the brighter edge and has
 * a softer sheen. The holo stops are the effort picker's ultra foil (@2lab.ai/ui core/effort: each hue 78% toward the
 * ink, 105deg). Mono keeps colour for the task states only, so its foil is chrome: ink and grey bands, no hue.
 */
export const CARD_FINISH_CSS = `
:root {
  --finish-bright-mix: 50%;
  --finish-bright-hover-mix: 70%;
  --finish-bright-idle-mix: 30%;
  --finish-sheen-a-on: 9%;
  --finish-sheen-a-idle: 5%;
  --finish-sheen-1: var(--purple);
  --finish-sheen-2: var(--accent);
  --finish-sheen-3: var(--green);
  --finish-sheen-4: var(--yellow);
  --finish-sheen-5: var(--red);
  --finish-glint-a: 55%;
  --finish-glint: linear-gradient(115deg, transparent 32%,
    color-mix(in srgb, #fff var(--finish-glint-a), transparent) 44%, transparent 56%);
  --finish-holo: linear-gradient(105deg,
    color-mix(in srgb, var(--purple) 78%, var(--ib-text)) 0%,
    color-mix(in srgb, var(--accent) 78%, var(--ib-text)) 17%,
    color-mix(in srgb, var(--green) 78%, var(--ib-text)) 33%,
    color-mix(in srgb, var(--yellow) 78%, var(--ib-text)) 50%,
    color-mix(in srgb, var(--orange) 78%, var(--ib-text)) 67%,
    color-mix(in srgb, var(--red) 78%, var(--ib-text)) 83%,
    color-mix(in srgb, var(--purple) 78%, var(--ib-text)) 100%);
}
:root[data-theme="light"] {
  --finish-bright-mix: 34%;
  --finish-bright-hover-mix: 52%;
  --finish-bright-idle-mix: 20%;
  --finish-sheen-a-on: 7%;
  --finish-sheen-a-idle: 4%;
  --finish-glint-a: 70%;
}
:root[data-palette="mono"] {
  --finish-sheen-a-on: 5%;
  --finish-sheen-a-idle: 3%;
  --finish-sheen-1: var(--ib-text);
  --finish-sheen-2: var(--ib-muted);
  --finish-sheen-3: var(--ib-text);
  --finish-sheen-4: var(--ib-muted);
  --finish-sheen-5: var(--ib-text);
  --finish-holo: linear-gradient(105deg, var(--ib-muted) 0%, var(--ib-text) 24%, var(--ib-card-border) 46%,
    var(--ib-text) 68%, var(--ib-muted) 100%);
}
`;
