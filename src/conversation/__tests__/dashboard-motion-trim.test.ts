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

describe('dashboard motion trim', () => {
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

  it('runLayoutCheck and the deck switch skip their motion when a key was the last input', () => {
    expect(TEMPLATE).toContain('var animate = canAnimate() && !_atKeyed;');
    expect(TEMPLATE).toContain('if (dir && !reduceMotion() && !_atKeyed) deckSlide(panel, dir);');
    expect(TEMPLATE).toMatch(/^var DECK_SLIDE_MS = 200;$/m);
  });
});
