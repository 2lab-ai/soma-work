/**
 * Interface sound on the dashboard and the settings page (@2lab.ai/ui/sound + sound-cuelume): the speaker beside the
 * theme switch, the choice kept in this browser (`soma-sound`, like `soma-theme`), Cuelume loaded only once sound is
 * on, audio unlocked inside the click that turned it on. The page script runs here as shipped, with a fake page and
 * a fake module loader.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { renderSettingsPage } from '../settings-page';
import { SOUND_STORAGE_KEY, soundClientJs, soundToggleHtml } from '../sound-client';
import { UI_LIB_VERSION, uiLibDistDir } from '../ui-lib';

interface FakeButton {
  attrs: Record<string, string>;
  setAttribute(k: string, v: string): void;
}
function fakePage(saved: string | null) {
  const store = new Map<string, string>();
  if (saved !== null) store.set(SOUND_STORAGE_KEY, saved);
  const rootAttrs: Record<string, string> = {};
  const button: FakeButton = {
    attrs: {},
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
  };
  const ready: Array<() => void> = [];
  const document = {
    documentElement: {
      setAttribute: (k: string, v: string) => {
        rootAttrs[k] = v;
      },
    },
    getElementById: (id: string) => (id === 'sound-toggle' ? button : null),
    addEventListener: (type: string, fn: () => void) => {
      if (type === 'DOMContentLoaded') ready.push(fn);
    },
  };
  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
  const lib = {
    sound: { setSound: vi.fn(), bindSound: vi.fn(), playSound: vi.fn() },
    cuelume: { cuelumeSound: () => {}, unlockSound: vi.fn(async () => true) },
  };
  const imported: string[] = [];
  let fail = false;
  const load = (url: string) => {
    imported.push(url);
    if (fail) return Promise.reject(new Error('offline'));
    return Promise.resolve(url.includes('sound-cuelume') ? lib.cuelume : lib.sound);
  };
  const js = soundClientJs('9.9.9');
  // The one dynamic import in the script goes through the fake loader.
  expect(js.match(/\bimport\(/g)).toHaveLength(1);
  const api = new Function(
    'document',
    'localStorage',
    '__load',
    `${js.replace('import(url)', '__load(url)')}\nreturn { toggleSound, somaSetSound };`,
  )(document, localStorage, load) as {
    toggleSound(): Promise<boolean>;
    somaSetSound(on: boolean, fromClick: boolean): Promise<boolean>;
  };
  return {
    api,
    store,
    rootAttrs,
    button,
    ready,
    lib,
    imported,
    setFail: () => {
      fail = true;
    },
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('the page script (soundClientJs)', () => {
  it('is off for a browser that never chose: nothing loads, the page says off', async () => {
    const p = fakePage(null);
    await tick();
    expect(p.rootAttrs['data-sound']).toBe('off');
    expect(p.imported).toEqual([]);
    for (const fn of p.ready) fn();
    expect(p.button.attrs).toMatchObject({ 'aria-pressed': 'false', 'aria-label': '소리 켜기' });
  });

  it('a saved "on" loads the library (versioned URLs), binds the page and turns sound on — no unlock without a click', async () => {
    const p = fakePage('on');
    expect(p.rootAttrs['data-sound']).toBe('on');
    await tick();
    expect(p.imported).toEqual(['/dashboard/ui/sound.js?v=9.9.9', '/dashboard/ui/sound-cuelume.js?v=9.9.9']);
    expect(p.lib.sound.bindSound).toHaveBeenCalledTimes(1);
    expect(p.lib.sound.setSound).toHaveBeenCalledWith({ player: p.lib.cuelume.cuelumeSound, enabled: true });
    expect(p.lib.cuelume.unlockSound).not.toHaveBeenCalled();
    for (const fn of p.ready) fn();
    expect(p.button.attrs).toMatchObject({ 'aria-pressed': 'true', 'aria-label': '소리 끄기' });
  });

  it('the speaker turns sound on from a click: saved, unlocked in the gesture, one toggle cue; again turns it off', async () => {
    const p = fakePage(null);
    await expect(p.api.toggleSound()).resolves.toBe(true);
    expect(p.store.get(SOUND_STORAGE_KEY)).toBe('on');
    expect(p.button.attrs['aria-pressed']).toBe('true');
    expect(p.lib.sound.setSound).toHaveBeenLastCalledWith({ player: p.lib.cuelume.cuelumeSound, enabled: true });
    expect(p.lib.cuelume.unlockSound).toHaveBeenCalledTimes(1);
    expect(p.lib.sound.playSound).toHaveBeenCalledWith('toggle', { direction: 'forward' });
    await expect(p.api.toggleSound()).resolves.toBe(false);
    expect(p.store.get(SOUND_STORAGE_KEY)).toBe('off');
    expect(p.rootAttrs['data-sound']).toBe('off');
    expect(p.button.attrs).toMatchObject({ 'aria-pressed': 'false', 'aria-label': '소리 켜기' });
    expect(p.lib.sound.setSound).toHaveBeenLastCalledWith({ enabled: false });
    // The modules load once.
    expect(p.imported).toHaveLength(2);
  });

  it('turning it off before it was ever on loads nothing', async () => {
    const p = fakePage(null);
    await expect(p.api.somaSetSound(false, true)).resolves.toBe(false);
    expect(p.imported).toEqual([]);
  });

  it('a library that fails to load never throws: the choice is kept, sound stays silent', async () => {
    const p = fakePage(null);
    p.setFail();
    await expect(p.api.toggleSound()).resolves.toBe(false);
    expect(p.store.get(SOUND_STORAGE_KEY)).toBe('on');
    expect(p.lib.sound.setSound).not.toHaveBeenCalled();
  });

  it('reaches the browser byte for byte: no backtick or ${…} in it', () => {
    const js = soundClientJs(UI_LIB_VERSION);
    expect(js).not.toContain('`');
    expect(js).not.toMatch(/\$\{/);
    expect(js).toContain(`/dashboard/ui/sound-cuelume.js?v=${UI_LIB_VERSION}`);
  });
});

describe('the speaker button', () => {
  it('is a labelled icon toggle with both glyphs from @2lab.ai/ui (sound, sound-off)', () => {
    const html = soundToggleHtml();
    expect(html).toMatch(/^<button type="button" id="sound-toggle"[^>]*onclick="toggleSound\(\)"/);
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('aria-label="소리 켜기"');
    expect(html).toMatch(/<svg [^>]*data-icon="sound" class="ic-sound"/);
    expect(html).toMatch(/<svg [^>]*data-icon="sound-off" class="ic-sound-off"/);
    expect(html.replace(/<[^>]+>/g, '').trim()).toBe('');
  });
});

describe('@2lab.ai/ui ships the sound modules the pages load', () => {
  it('dist/sound.js and dist/sound-cuelume.js exist in the installed package (served by /dashboard/ui/:file)', () => {
    const dir = uiLibDistDir();
    expect(dir).not.toBeNull();
    const sound = readFileSync(join(dir!, 'sound.js'), 'utf8');
    const cuelume = readFileSync(join(dir!, 'sound-cuelume.js'), 'utf8');
    expect(sound).toMatch(/\bsetSound\b/);
    expect(sound).toMatch(/\bbindSound\b/);
    expect(cuelume).toMatch(/\bcuelumeSound\b/);
    expect(cuelume).toMatch(/\bunlockSound\b/);
  });
});

describe('the dashboard', () => {
  const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
  const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));
  const HEAD = TEMPLATE.slice(0, TEMPLATE.indexOf('</head>'));
  const bar = TEMPLATE.match(/<div class="topbar-account">[\s\S]*?\n {4}<\/div>\n/)?.[0] ?? '';

  it('puts the speaker in the account group, right before the theme toggle', () => {
    const speaker = bar.indexOf('id="sound-toggle"');
    const theme = bar.indexOf('id="theme-toggle"');
    expect(speaker).toBeGreaterThan(0);
    expect(theme).toBeGreaterThan(speaker);
    expect(bar).toContain(
      '<button id="sound-toggle" type="button" onclick="toggleSound()" aria-pressed="false" aria-label="소리 켜기" title="인터페이스 소리"><i data-ui-icon="sound" class="ic-sound"></i><i data-ui-icon="sound-off" class="ic-sound-off"></i></button>',
    );
  });

  it('runs the sound script in <head>, so the speaker shows the saved state before paint', () => {
    expect(HEAD).toContain('<script data-sound>${soundClientJs(UI_LIB_VERSION)}</script>');
  });

  it('shows the glyph for the state: off by default, on under data-sound="on"', () => {
    expect(TEMPLATE).toContain(
      '#sound-toggle .ic-sound, :root[data-sound="on"] #sound-toggle .ic-sound-off { display: none; }',
    );
    expect(TEMPLATE).toContain(':root[data-sound="on"] #sound-toggle .ic-sound { display: block; }');
  });
});

describe('the settings page', () => {
  it('has the same speaker before its theme button, and the same script in <head>', () => {
    const html = renderSettingsPage();
    const head = html.slice(0, html.indexOf('</head>'));
    expect(head).toContain(soundClientJs(UI_LIB_VERSION));
    const account = html.slice(html.indexOf('<div class="account">'));
    const speaker = account.indexOf('id="sound-toggle"');
    expect(speaker).toBeGreaterThan(0);
    expect(account.indexOf('class="theme"')).toBeGreaterThan(speaker);
  });
});
