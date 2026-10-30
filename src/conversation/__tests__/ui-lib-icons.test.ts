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
});
