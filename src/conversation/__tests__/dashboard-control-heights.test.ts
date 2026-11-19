/**
 * One row, one control height (polishing-ui pass, 2026-11-16).
 *
 * The top bar and the board's tools are toolbars. Measured on the real server before this pass (desktop 1440×900):
 * the bar's boxed controls were 24 (kit chips) / 30 (user select) / 32 (새 작업) / 34 (the bar's own icon buttons and
 * account) px, and the board's tools 24 (필터 · 정렬 chips) / 32 (search) / 34 (Board | List track). On a phone
 * (390×844, touch) the bar's chips stayed 24px beside the bar's 44px buttons, and the search was 40px beside the 50px
 * Board | List track (44px options + 3px padding each side).
 *
 * After: desktop 34px everywhere on both rows (the bar's own buttons and the Board | List track); touch 44px (HIG iOS
 * default control) in the bar, and in the board's tools on touch or under 640px, where the search matches the track.
 * The chips' kit hit area (::after, 10px above and below) folds back to the box once the box is the target.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const TEMPLATE = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');

/** The body of the first `@media <query> {` block whose body contains `marker`. */
function mediaBlockWith(query: string, marker: string): string {
  let from = 0;
  for (;;) {
    const start = TEMPLATE.indexOf(`@media ${query} {`, from);
    if (start < 0) throw new Error(`no @media ${query} block contains ${marker}`);
    const end = TEMPLATE.indexOf('\n}\n', start);
    const body = TEMPLATE.slice(start, end);
    if (body.includes(marker)) return body;
    from = end;
  }
}

describe('one row, one control height — the top bar and the board tools', () => {
  it('desktop: the bar’s and the board tools’ chips, select chips and 새 작업 are 34px, 13px text', () => {
    expect(TEMPLATE).toContain(
      ':is(.topbar, .inbox-tools) :is(.ui-chip, select.ui-select-chip) { height: 34px; min-height: 34px; font-size: 13px; }',
    );
    // Padding on the chips only: the select chip keeps the kit's right padding, where its chevron is drawn.
    expect(TEMPLATE).toContain(':is(.topbar, .inbox-tools) .ui-chip { padding-inline: 12px; }');
    // Glyphs: the bar's link glyphs are 14px; its icon buttons' 16px (touch).
    expect(TEMPLATE).toContain(':is(.topbar, .inbox-tools) .ui-chip > svg { width: 14px; height: 14px; }');
    expect(TEMPLATE).toContain(':is(.topbar, .inbox-tools) .td-picker::part(trigger) { min-height: 34px; }');
    expect(TEMPLATE).toContain('.topbar .new-task-btn { min-height: 34px; }');
  });

  it('desktop: the board search is the Board | List track’s 34px', () => {
    expect(TEMPLATE).toMatch(/^\.bf-search \{ flex: 0 1 140px; min-width: 96px; height: 34px;/m);
  });

  it('touch: the bar’s chips are 44px boxes (the bar’s own buttons are 44px on touch), the hit area is the box', () => {
    const touch = mediaBlockWith('(pointer: coarse)', '.topbar :is(.ui-chip, select.ui-select-chip)');
    expect(touch).toContain(
      '.topbar :is(.ui-chip, select.ui-select-chip) { height: 44px; min-height: 44px; font-size: 16px; }',
    );
    expect(touch).toContain('.topbar .ui-chip { min-width: 44px; padding-inline: 14px; justify-content: center; }');
    expect(touch).toContain('.topbar .ui-chip::after { inset: 0; }');
    expect(touch).toContain('.topbar .ui-chip > svg { width: 16px; height: 16px; }');
    expect(touch).toContain('.topbar .td-picker::part(trigger) { min-height: 44px; }');
  });

  it('touch or under 640px: the board tools’ chips are 44px like the select chip beside them', () => {
    const narrow = mediaBlockWith('(max-width: 639px), (pointer: coarse)', '.inbox-tools :is(.ui-chip');
    expect(narrow).toContain(
      '.inbox-tools :is(.ui-chip, select.ui-select-chip) { height: 44px; min-height: 44px; font-size: 16px; }',
    );
    expect(narrow).toContain(
      '.inbox-tools .ui-chip { min-width: 44px; padding-inline: 14px; justify-content: center; }',
    );
    expect(narrow).toContain('.inbox-tools .ui-chip::after { inset: 0; }');
    expect(narrow).toContain('.inbox-tools .ui-chip > svg { width: 16px; height: 16px; }');
    expect(narrow).toContain('.inbox-tools .td-picker::part(trigger) { min-height: 44px; }');
  });

  it('no padding rule of this pass reaches the select chip (its chevron sits in the kit’s right padding)', () => {
    const start = TEMPLATE.indexOf('ONE ROW, ONE HEIGHT');
    const end = TEMPLATE.indexOf('/* ── CRON lane', start);
    // The pass's block must be found: a renamed banner would leave an empty slice that matches nothing.
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = TEMPLATE.slice(start, end);
    expect(block).not.toMatch(/ui-select-chip\)[^{]*\{[^}]*padding/);
  });

  it('touch or under 640px: the search is the Board | List track’s 50px (44px options + 3px padding)', () => {
    const narrow = mediaBlockWith('(max-width: 639px), (pointer: coarse)', '.inbox-tools :is(.ui-chip');
    expect(narrow).toContain('.inbox-tools > .bf-search { height: 50px; }');
    // The phone grid places the search; its height is the rule above alone.
    const phone = mediaBlockWith('(max-width: 639px)', '.inbox-tools > .inbox-chips');
    expect(phone).toContain(
      '.inbox-tools > .bf-search { grid-column: 1; grid-row: 1; width: 100%; max-width: none; font-size: 16px; }',
    );
  });
});
