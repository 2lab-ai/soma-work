import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fillUiIcons, uiIcon } from '../ui-lib';

// The server draws @2lab.ai/ui's glyphs from the package's glyph table without running the module; this pins
// that the markup is exactly the library's own icon() for every name and every option the pages use.
describe('uiIcon — the library glyph table, read as data', () => {
  it('matches @2lab.ai/ui icon() for every glyph and alias, with and without options', async () => {
    // The library's ESM subpath export (vitest resolves it; the server's commonjs tsc setup has no type path to it).
    const spec = '@2lab.ai/ui/icons';
    const lib = (await import(/* @vite-ignore */ spec)) as unknown as {
      icon: (name: string, opts?: Record<string, unknown>) => string;
      ICON_NAMES: string[];
      ICON_ALIASES: Record<string, string>;
    };
    const names = [...lib.ICON_NAMES, ...Object.keys(lib.ICON_ALIASES)];
    expect(names.length).toBeGreaterThan(40);
    for (const name of names) {
      expect(uiIcon(name)).toBe(lib.icon(name));
      const opts = { size: 14, stroke: 2, class: 'a "b"', label: 'Close <now>' };
      expect(uiIcon(name, opts)).toBe(lib.icon(name, opts));
    }
  });

  it('an unknown name draws nothing, and a page slot for it stays empty', () => {
    expect(uiIcon('no-such-glyph')).toBe('');
    expect(fillUiIcons('<i data-ui-icon="no-such-glyph"></i>')).toBe('');
    expect(fillUiIcons('<i data-ui-icon="close" class="x"></i>')).toContain('data-icon="close" class="x"');
  });

  it('every icon slot the dashboard names is in the installed set — the D1 inline glyphs included (D4 g1)', () => {
    const src = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf8');
    const names = new Set(Array.from(src.matchAll(/data-ui-icon="([a-z][a-z0-9-]*)"/g), (m) => m[1]));
    // D4 g5: the tiles' play / pause toggle is <ui-file-card playable>'s own — the page no longer names `play`;
    // D3 moved the task rows' pause / ban / minus (<ui-task-plan>), the avatars' bot / gear (<ui-conversation>) and
    // the deck's chevrons (<ui-deck-nav>) into the elements, so the page names none of those either.
    for (const n of ['archive', 'dot', 'circle-dashed', 'moon']) expect(names).toContain(n);
    for (const n of ['play', 'pause', 'ban', 'bot', 'gear']) expect(names).not.toContain(n);
    for (const n of names) expect(uiIcon(n), n).not.toBe('');
  });
});
