// @vitest-environment happy-dom
/**
 * The finish's sheet goes where the cards are: inside each <ui-agent-inbox>'s shadow root (@2lab.ai/ui UiElement —
 * a <style> first, then the .ui-root it re-renders). cardFinishPaint runs as shipped against a stand-in element of the
 * same shape; the page's own syncCardFinish · cardFinishHold · refreshCard run as shipped too, cut from the dashboard
 * template, over a card whose model switches while its face stays the same.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CARD_FINISH_CLIENT_JS } from '../card-finish-client';

/** The bits of happy-dom's globals these tests touch (the project's tsconfig has no DOM lib). */
interface El {
  className: string;
  textContent: string | null;
  innerHTML: string;
  localName: string;
  shadowRoot: Root | null;
  firstElementChild: El | null;
  lastElementChild: El | null;
  setAttribute(name: string, value: string): void;
  matches(sel: string): boolean;
  attachShadow(init: { mode: 'open' }): Root;
  append(...nodes: El[]): void;
  querySelector(sel: string): El | null;
}
interface Root {
  firstElementChild: El | null;
  lastElementChild: El | null;
  append(...nodes: El[]): void;
  querySelector(sel: string): El | null;
  querySelectorAll(sel: string): ArrayLike<El>;
}
const doc = (globalThis as unknown as { document: { createElement(tag: string): El; body: El } }).document;

const client = new Function(`${CARD_FINISH_CLIENT_JS}\nreturn { cardFinishPaint, cardFinishSheet };`)() as {
  cardFinishPaint(host: El | null, cards: Array<{ key: string; model: string }>): void;
  cardFinishSheet(cards: Array<{ key: string; model: string }>): string;
};

/** A host shaped like UiElement: an open shadow root with the element's own <style> and its .ui-root. */
function host(tag = 'div'): El {
  const el = doc.createElement(tag);
  const root = el.attachShadow({ mode: 'open' });
  const own = doc.createElement('style');
  own.textContent = '.ib-card { border: 1px solid var(--ib-card-border); }';
  root.append(own);
  const content = doc.createElement('div');
  content.className = 'ui-root';
  root.append(content);
  doc.body.append(el);
  return el;
}
const sheets = (el: El): El[] => Array.from(el.shadowRoot?.querySelectorAll('style[data-card-finish]') ?? []);

describe('cardFinishPaint — the sheet inside the element’s shadow root', () => {
  it('adds one <style data-card-finish> after the element’s own, outside the part it re-renders', () => {
    const el = host();
    const cards = [{ key: 'C1:1.0', model: 'claude-fable-5' }];
    client.cardFinishPaint(el, cards);
    const root = el.shadowRoot as Root;
    expect(sheets(el)).toHaveLength(1);
    expect(root.lastElementChild?.matches('style[data-card-finish]')).toBe(true);
    expect(root.firstElementChild?.textContent).toContain('.ib-card { border: 1px solid');
    expect(sheets(el)[0].textContent).toBe(client.cardFinishSheet(cards));
    // The element re-renders by replacing .ui-root's content: the sheet stays.
    (root.querySelector('.ui-root') as El).innerHTML = '<ul><li class="ib-card" data-card="C1:1.0"></li></ul>';
    expect(sheets(el)).toHaveLength(1);
  });

  it('rebuilds and writes only when the cards’ finishes change, and empties it when none has one any more', () => {
    const el = host();
    client.cardFinishPaint(el, [{ key: 'k', model: 'opus' }]);
    const style = sheets(el)[0];
    // A mark the paint would overwrite if it wrote: the same finishes again — another opus id, a sonnet card added —
    // write nothing.
    style.textContent = 'untouched';
    client.cardFinishPaint(el, [
      { key: 'k', model: 'claude-opus-4-7' },
      { key: 's', model: 'sonnet' },
    ]);
    expect(style.textContent).toBe('untouched');
    const b = [{ key: 'k', model: 'fable' }];
    client.cardFinishPaint(el, b);
    expect(style.textContent).toBe(client.cardFinishSheet(b));
    client.cardFinishPaint(el, [{ key: 'k', model: 'sonnet' }]);
    expect(sheets(el)).toHaveLength(1);
    expect(style.textContent).toBe('');
  });

  it('adds nothing to an element without a finished card, or one not yet upgraded (no shadow root)', () => {
    const el = host();
    client.cardFinishPaint(el, []);
    client.cardFinishPaint(el, [{ key: 's', model: 'sonnet' }]);
    expect(sheets(el)).toHaveLength(0);
    const bare = doc.createElement('ui-agent-inbox');
    expect(() => client.cardFinishPaint(bare, [{ key: 'k', model: 'opus' }])).not.toThrow();
    expect(() => client.cardFinishPaint(null, [{ key: 'k', model: 'opus' }])).not.toThrow();
  });
});

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));
/** A top-level client function as the page ships it (these hold no backslash or template slot). */
function clientFn(name: string): string {
  const start = TEMPLATE.indexOf(`function ${name}(`);
  const end = TEMPLATE.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error(`client function ${name} not found`);
  return TEMPLATE.slice(start, end + 2);
}

type Page = {
  sync(): void;
  hold(on: boolean): void;
  refresh(key: string): void;
  stale(key: string): boolean;
  card(key: string, model: string, host: El): void;
  setModel(key: string, model: string): void;
  repaints(): number;
};
function page(): Page {
  return new Function(
    `${CARD_FINISH_CLIENT_JS}
var _cardData = {}, _cardDrawn = {}, _sessionCache = {}, _cardHost = {}, _cardCol = {};
var _repaints = 0;
function viewCardOf(s) { return { id: s.key, title: s.title }; }
function inboxPaint() { _repaints++; syncCardFinish(); }
function paintCardBody() {}
var _cardFinishHeld = false;
var _cardFinishDirty = false;
var _cardFinishGen = 0;
var _cardFinishSeen = Object.create(null);
${clientFn('cardFinishHold')}
${clientFn('syncCardFinish')}
${clientFn('cardFinishStale')}
${clientFn('refreshCard')}
return {
  sync: syncCardFinish,
  hold: cardFinishHold,
  refresh: refreshCard,
  stale: cardFinishStale,
  card: function(key, model, host) {
    _sessionCache[key] = { key: key, title: 'T', model: model };
    _cardData[key] = viewCardOf(_sessionCache[key]);
    _cardDrawn[key] = true;
    _cardHost[key] = host;
  },
  setModel: function(key, model) { _sessionCache[key].model = model; },
  repaints: function() { return _repaints; },
};`,
  )() as Page;
}
const inbox = () => host('ui-agent-inbox');
const sheetOf = (el: El) => sheets(el)[0]?.textContent ?? '';

describe('the page’s sync — a model switch on a card whose face stays the same', () => {
  it('refreshCard repaints nothing but moves the card to its new finish, on every board element', () => {
    const board = inbox();
    const lane = inbox();
    const p = page();
    p.card('C:1', 'claude-sonnet-5-5[1m]', board);
    p.sync();
    expect(sheets(board)).toHaveLength(0);

    // A push that changes nothing the finish reads costs no board-wide pass.
    expect(p.stale('C:1')).toBe(false);
    p.setModel('C:1', 'claude-sonnet-4-6');
    expect(p.stale('C:1')).toBe(false);

    p.setModel('C:1', 'claude-fable-5-2[1m]');
    expect(p.stale('C:1')).toBe(true);
    p.refresh('C:1');
    expect(p.stale('C:1')).toBe(false);
    expect(p.repaints()).toBe(0);
    expect(sheetOf(board)).toContain('li.ib-card:is([data-card="C:1"]) { border: 2px solid transparent;');
    // The lane box draws none of the board's cards: it gets no sheet for them.
    expect(sheets(lane)).toHaveLength(0);

    // A card the lane draws is the lane's alone.
    p.card('C:L', 'claude-opus-5-5[1m]', lane);
    p.sync();
    expect(sheetOf(lane)).toContain('li.ib-card:is([data-card="C:L"]) { border-width: 2px;');
    expect(sheetOf(lane)).not.toContain('"C:1"');
    expect(sheetOf(board)).not.toContain('"C:L"');

    p.setModel('C:1', 'claude-opus-5-5[1m]');
    p.refresh('C:1');
    expect(sheetOf(board)).toContain('li.ib-card:is([data-card="C:1"]) { border-width: 2px;');
    expect(sheetOf(board)).not.toContain('border: 2px solid transparent;');

    p.setModel('C:1', 'claude-sonnet-5-5[1m]');
    p.refresh('C:1');
    expect(sheetOf(board)).toBe('');
  });

  it('a held render writes once, at the release; a render that throws lets go on the next microtask', async () => {
    const board = inbox();
    const p = page();
    p.card('C:2', 'opus', board);
    p.hold(true);
    p.sync();
    p.sync();
    expect(sheets(board)).toHaveLength(0);
    p.hold(false);
    expect(sheetOf(board)).toContain('[data-card="C:2"]');
    await Promise.resolve(); // the first hold's let-go runs and finds nothing held

    // An earlier hold's pending let-go never releases a later hold: between the two let-goes the later hold still
    // holds (without the generation the earlier one would release it and write the foil there).
    p.hold(true); // A — its let-go queued first
    p.hold(false);
    let between = '';
    Promise.resolve().then(() => {
      between = sheetOf(board);
    });
    p.hold(true); // B — its let-go queued after the check above
    p.setModel('C:2', 'fable');
    p.sync();
    await Promise.resolve();
    await Promise.resolve();
    expect(between).toContain('[data-card="C:2"]');
    expect(between).not.toContain('border: 2px solid transparent;');
    expect(sheetOf(board)).toContain('li.ib-card:is([data-card="C:2"]) { border: 2px solid transparent;');
    p.setModel('C:2', 'opus');
    p.sync();
    expect(sheetOf(board)).not.toContain('border: 2px solid transparent;');

    p.hold(true);
    p.setModel('C:2', 'fable');
    p.sync(); // the render "throws" here: no release
    expect(sheetOf(board)).not.toContain('border: 2px solid transparent;');
    await Promise.resolve();
    expect(sheetOf(board)).toContain('li.ib-card:is([data-card="C:2"]) { border: 2px solid transparent;');
  });
});
