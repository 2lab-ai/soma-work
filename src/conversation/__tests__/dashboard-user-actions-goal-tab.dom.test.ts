// @vitest-environment happy-dom
/**
 * .prd/28 §3 (review P2 on #1311) — 사용자 할 일 in the 목표 tab, against the page's own CSS rule in a DOM: hidden while
 * the tab is closed or another tab is open, shown while 목표 is open, and always shown in a layout without the 목표 tab.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const RULE = DASHBOARD_TS.split('\n').find((l) => l.includes('#panel-user-actions { display: none !important; }'))!;
const HIDE = RULE.slice(0, RULE.indexOf('{')).trim();

interface Node {
  id: string;
  className: string;
  innerHTML: string;
  setAttribute(k: string, v: string): void;
  removeAttribute(k: string): void;
  matches(sel: string): boolean;
  querySelector(sel: string): Node | null;
}
const dom = globalThis as unknown as { document: { body: Node } };

describe('사용자 할 일 follows the 목표 tab (the page’s CSS rule, matched in a DOM)', () => {
  it('closed → hidden; 목표 open → shown; another tab → hidden; no 목표 tab in the layout → shown', () => {
    expect(HIDE).toBe('body[data-detail~="goaltab"] .slide-panel:not([data-midtab="goal"]) #panel-user-actions');
    const body = dom.document.body;
    body.innerHTML =
      '<div class="slide-panel" id="slide-panel" data-midtab=""><div class="panel-user-actions" id="panel-user-actions"></div></div>';
    const panel = body.querySelector('#slide-panel')!;
    const region = body.querySelector('#panel-user-actions')!;
    body.setAttribute('data-detail', 'agenttabs goaltab sections');
    expect(region.matches(HIDE)).toBe(true);
    panel.setAttribute('data-midtab', 'goal');
    expect(region.matches(HIDE)).toBe(false);
    panel.setAttribute('data-midtab', 'tasks');
    expect(region.matches(HIDE)).toBe(true);
    panel.setAttribute('data-midtab', '');
    body.setAttribute('data-detail', 'agenttabs sections');
    expect(region.matches(HIDE)).toBe(false);
  });
});
