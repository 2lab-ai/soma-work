// @vitest-environment happy-dom
/**
 * The finish's sheet goes where the cards are: inside each <ui-agent-inbox>'s shadow root (@2lab.ai/ui UiElement —
 * a <style> first, then the .ui-root it re-renders). cardFinishPaint runs as shipped against a stand-in element of the
 * same shape.
 */

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
  cardFinishPaint(host: El | null, css: string): void;
  cardFinishSheet(cards: Array<{ key: string; model: string }>): string;
};

/** A host shaped like UiElement: an open shadow root with the element's own <style> and its .ui-root. */
function host(): El {
  const el = doc.createElement('div');
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
    const css = client.cardFinishSheet([{ key: 'C1:1.0', model: 'claude-fable-5' }]);
    client.cardFinishPaint(el, css);
    const root = el.shadowRoot as Root;
    expect(sheets(el)).toHaveLength(1);
    expect(root.lastElementChild?.matches('style[data-card-finish]')).toBe(true);
    expect(root.firstElementChild?.textContent).toContain('.ib-card { border: 1px solid');
    expect(sheets(el)[0].textContent).toBe(css);
    // The element re-renders by replacing .ui-root's content: the sheet stays.
    (root.querySelector('.ui-root') as El).innerHTML = '<ul><li class="ib-card" data-card="C1:1.0"></li></ul>';
    expect(sheets(el)).toHaveLength(1);
  });

  it('rewrites the text only when it changes, and empties it when no card has a finish any more', () => {
    const el = host();
    const a = client.cardFinishSheet([{ key: 'k', model: 'opus' }]);
    client.cardFinishPaint(el, a);
    const style = sheets(el)[0];
    // A mark the paint would overwrite if it wrote: the same text again writes nothing.
    style.textContent = 'untouched';
    client.cardFinishPaint(el, a);
    expect(style.textContent).toBe('untouched');
    const b = client.cardFinishSheet([{ key: 'k', model: 'fable' }]);
    client.cardFinishPaint(el, b);
    expect(style.textContent).toBe(b);
    client.cardFinishPaint(el, '');
    expect(sheets(el)).toHaveLength(1);
    expect(style.textContent).toBe('');
  });

  it('adds nothing to an element without a finished card, or one not yet upgraded (no shadow root)', () => {
    const el = host();
    client.cardFinishPaint(el, '');
    expect(sheets(el)).toHaveLength(0);
    const bare = doc.createElement('ui-agent-inbox');
    expect(() => client.cardFinishPaint(bare, 'li.ib-card {}')).not.toThrow();
    expect(() => client.cardFinishPaint(null, 'li.ib-card {}')).not.toThrow();
  });
});
