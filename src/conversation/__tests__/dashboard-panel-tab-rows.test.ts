/**
 * The detail panel has two tab rows, one over the other: the bar (작업 계획 · 목표 · 작업 · … · 사용자 작업 — disclosure
 * buttons, .pm-tab) and the section tabs under it (대화 · 작업 로그 · 변경점 — @2lab.ai/ui <ui-tabs>, the same element as
 * the settings page's tab list: 13px, weight 500, 12px each side). The bar spoke smaller and lighter (12.5px, 400, 8px)
 * and its labels started 6px left of the row under it, so the two rows read as two different widgets.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');

function rule(selector: string): string {
  const start = SRC.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`rule ${selector} not found`);
  return SRC.slice(start + 1, SRC.indexOf('}', start) + 1);
}
const decl = (r: string, prop: string) => (new RegExp(`(?:^|[;{\\s])${prop}:\\s*([^;}]+)`).exec(r)?.[1] ?? '').trim();

describe('detail panel — the bar speaks like the section tabs under it', () => {
  it('a bar tab has the section tab’s size, weight and inset (13px · 500 · 12px)', () => {
    const tab = rule('.pm-tab');
    expect(decl(tab, 'font-size')).toBe('13px');
    expect(decl(tab, 'font-weight')).toBe('500');
    expect(decl(tab, 'padding')).toBe('0 12px');
    // The open one is told by its colour and underline, as a selected section tab is — not by a heavier weight.
    expect(rule('.pm-tab[aria-expanded="true"]')).not.toMatch(/font-weight/);
  });

  it('the bar’s labels start where the section tabs’ labels start', () => {
    expect(decl(rule('.panel-midbar'), 'padding')).toBe(decl(rule('.panel-sections::part(list)'), 'padding'));
  });
});

describe('detail panel — its head buttons are the kit buttons beside them', () => {
  // The head's 중지 · 되돌리기 모드 are <ui-status-bar> buttons; the answer's 복사 under them is a kit button. Measured on
  // dev 2026-11-26 (@2lab.ai/ui 0.51): 30px · 12.5px next to 32px · 13px. @2lab.ai/ui 0.52 draws the bar's buttons at
  // the kit button size; this reads the shipped library so a version that drifts again fails here.
  const UI = join(__dirname, '..', '..', '..', 'node_modules', '@2lab.ai', 'ui', 'dist');
  const block = (css: string, sel: string) => {
    const at = css.indexOf(`\n${sel} {`);
    if (at < 0) throw new Error(`${sel} not found`);
    return css.slice(at, css.indexOf('}', at));
  };
  it('the status bar’s .sb-btn has .ui-btn’s height, padding and type', () => {
    const bar = block(readFileSync(join(UI, 'status-bar.js'), 'utf-8'), '.sb-btn');
    const kit = block(readFileSync(join(UI, 'ui-kit.css'), 'utf-8'), '.ui-btn');
    for (const prop of ['min-height', 'padding', 'font-size', 'font-weight', 'border-radius'])
      expect(decl(bar, prop), prop).toBe(decl(kit, prop));
  });
});
