/**
 * The mono pair on the pages' own sheets (soma-work 830). @2lab.ai/ui ≥ 0.25.0 puts `--ui-chroma` on <html> (1 in
 * light / dark, 0 under data-palette="mono"), aliased here as `--chroma`. In mono a task state shows its colour on a
 * mark only (icon, dot, bar, border) — so in the dashboard's, the settings page's and the task plan's own CSS a state
 * colour mixed into a FILL or a TEXT at a fixed percentage is a bug, and so is a state colour as plain text. Mixes
 * into a border / ring / outline are marks and stay.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = (f: string) => readFileSync(join(__dirname, '..', f), 'utf8');
const PAGES = [
  'dashboard.ts',
  'settings-page.ts',
  'settings-dictation-tab.ts',
  'settings-layout-tab.ts',
  'settings-memory-tab.ts',
  'settings-project-tab.ts',
  'task-plan-html.ts',
  'viewer.ts',
];

// A state colour by any of its names: the page's (--st-*), the library's (--ui-st-*), and the page aliases of one
// (--cw-warn, the task plan's --tp-warn) — wherever it sits in a var() fallback chain.
const STATE = /--(?:ui-)?(?:st-(?:wait|run|done|fail|fail-text)|cw-warn|tp-warn)\b/;
// As text: the same minus st-fail-text, which the mono pair itself turns to ink.
const STATE_TEXT = /--(?:ui-)?(?:st-(?:wait|run|done|fail)(?!-text)|cw-warn|tp-warn)\b/;
// A colour-mix's first operand (a var(), fallbacks included) and its fixed percentage.
const MIX = /color-mix\(in srgb, (var\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)) (\d+(?:\.\d+)?%)/g;
const LINE = /^(border|border-[a-z-]+|box-shadow|outline|outline-color|stroke|--[a-z0-9-]*(line|ring|border|edge))$/;
const MARK = /svg|icon|mark|spark|spin|glyph|dot|tick/;

function offences(source: string): string[] {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const bad: string[] = [];
  // Innermost blocks: a rule inside @media / @supports is read like any other.
  for (const [, selector, body] of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    for (const decl of body.split(';')) {
      const at = decl.indexOf(':');
      if (at < 0) continue;
      const prop = decl.slice(0, at).trim();
      const value = decl.slice(at + 1).trim();
      if (!/^(--)?[a-z][a-z0-9-]*$/.test(prop) || LINE.test(prop)) continue;
      const where = selector.trim().split('\n').pop()?.slice(0, 80);
      const fixedMix = [...value.matchAll(MIX)].some(([, operand]) => STATE.test(operand));
      if (fixedMix) bad.push(`${where} { ${prop}: ${value.slice(0, 90)} }`);
      else if (prop === 'color' && STATE_TEXT.test(value) && !value.includes('calc(') && !MARK.test(selector))
        bad.push(`${where} { color: ${value.slice(0, 90)} } — text in a state colour`);
    }
  }
  return bad;
}

describe('mono pair — the pages keep state colour on marks only (soma-work 830)', () => {
  it('catches a fixed fill, a fixed tint and plain state text; lets borders, icons and --chroma forms through', () => {
    expect(
      offences(':root { /* note */ --tint-x: color-mix(in srgb, var(--st-wait) 8%, var(--surface)); }'),
    ).toHaveLength(1);
    expect(offences('.a { color: color-mix(in srgb, var(--st-done) 70%, var(--text)); }')).toHaveLength(1);
    expect(offences('.a-word { color: var(--st-run); }')).toHaveLength(1);
    expect(offences('.a { background: color-mix(in srgb, var(--ui-st-wait) 18%, transparent); }')).toHaveLength(1);
    expect(offences('.a { color: var(--cw-warn); }')).toHaveLength(1);
    // Inside @media, through a fallback chain, through a page alias (the review's three blind spots).
    expect(
      offences('@media (x) { .a { color: color-mix(in srgb, var(--tp-warn) 75%, var(--tp-text)); } }'),
    ).toHaveLength(1);
    expect(offences('.a { color: var(--ib-run-fg, var(--ui-st-run)); }')).toHaveLength(1);
    expect(
      offences('.a { background: color-mix(in srgb, var(--ib-x, var(--ui-st-wait)) 12%, transparent); }'),
    ).toHaveLength(1);
    // Error text is the mono ink token itself; a --chroma form passes.
    expect(offences('.a { color: var(--st-fail-text); }')).toEqual([]);
    expect(
      offences(
        '.a { color: color-mix(in srgb, var(--ib-run-fg, var(--ui-st-run)) calc(100% * var(--chroma, 1)), var(--text)); }',
      ),
    ).toEqual([]);
    expect(offences('.a { border: 1px solid color-mix(in srgb, var(--st-wait) 40%, var(--border)); }')).toEqual([]);
    expect(offences('.a-icon { color: var(--st-run); }')).toEqual([]);
    expect(
      offences('.a { background: color-mix(in srgb, var(--st-wait) calc(8% * var(--chroma, 1)), var(--surface)); }'),
    ).toEqual([]);
  });

  it.each(PAGES)('%s: no fixed status fill or tint, no plain status text', (file) => {
    expect(offences(SRC(file))).toEqual([]);
  });

  it('the plan card, the pending question and the plan bar keep their status border and lose the wash in mono', () => {
    const dash = SRC('dashboard.ts');
    expect(dash).toContain(
      '--tint-wait-soft: color-mix(in srgb, var(--st-wait) calc(8% * var(--chroma, 1)), var(--surface));',
    );
    expect(dash).toContain('--tint-wait-line: color-mix(in srgb, var(--st-wait) 40%, var(--border));');
    expect(dash).toContain(
      '--tint-wait-fg: color-mix(in srgb, var(--st-wait) calc(70% * var(--chroma, 1)), var(--text));',
    );
    for (const sel of ['.card-body .card-plan {', '.panel-plan-bar {']) {
      const rule = dash.slice(dash.indexOf(sel), dash.indexOf('}', dash.indexOf(sel)));
      expect(rule, sel).toContain('background: var(--tint-wait-soft)');
      expect(rule, sel).toContain('border: 1px solid var(--tint-wait-line)');
    }
    const question = dash.slice(dash.indexOf('.card-question {'), dash.indexOf('}', dash.indexOf('.card-question {')));
    expect(question).toContain('background: var(--tint-wait-soft);');
    expect(question).toContain('border: 1px solid var(--tint-wait-line);');
  });

  it("the task plan's head loses its accent wash in mono (the standalone page, without --chroma, keeps it)", () => {
    expect(SRC('task-plan-html.ts')).toContain(
      'background: color-mix(in srgb, var(--tp-accent) calc(7% * var(--chroma, 1)), var(--tp-card));',
    );
  });
});
