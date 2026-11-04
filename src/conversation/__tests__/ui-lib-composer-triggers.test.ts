/**
 * The dashboard's `/` and `$` menus are the installed @2lab.ai/ui `<ui-composer>`'s `data.triggers` (0.27.0): the
 * page serves the package's own build (`ui-lib.ts`), so a version without them makes the menus silently absent —
 * the route answers, the page sets `triggers`, and an older element ignores the key (trinity R1 F1, fable-zhuge).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UI_LIB_VERSION, uiLibDistDir } from '../ui-lib';

describe('installed @2lab.ai/ui draws the composer menus', () => {
  it('is 0.27.0 or later', () => {
    const [major, minor] = decodeURIComponent(UI_LIB_VERSION).split('.').map(Number);
    expect(major > 0 || minor >= 27).toBe(true);
  });

  it('its composer build has the trigger menu (ui-suggest, the menu rows)', () => {
    const dir = uiLibDistDir();
    expect(dir).not.toBeNull();
    const js = readFileSync(join(dir as string, 'composer.js'), 'utf8');
    expect(js).toContain('ui-suggest');
    expect(js).toContain('cp-sg-row');
  });
});
