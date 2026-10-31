/**
 * Interface sound on the dashboard and the settings page (@2lab.ai/ui/sound + sound-cuelume): the speaker beside the
 * theme switch (<ui-app-bar>'s own on both pages), the choice kept in this browser (`soma-sound`, like `soma-theme`),
 * Cuelume loaded only once sound is on, audio unlocked inside the click that turned it on. The page script runs here
 * as shipped, with a fake page and a fake module loader.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { renderSettingsPage } from '../settings-page';
import { SOUND_STORAGE_KEY, soundClientJs } from '../sound-client';
import { UI_LIB_VERSION, uiLibDistDir } from '../ui-lib';

interface FakeButton {
  attrs: Record<string, string>;
  setAttribute(k: string, v: string): void;
}
interface FakeBar {
  data?: Record<string, unknown>;
  on: Map<string, Array<(e: unknown) => void>>;
  addEventListener(type: string, fn: (e: unknown) => void): void;
  fire(type: string, e: unknown): void;
}
function fakeBar(): FakeBar {
  return {
    on: new Map(),
    addEventListener(type, fn) {
      this.on.set(type, [...(this.on.get(type) ?? []), fn]);
    },
    fire(type, e) {
      for (const fn of this.on.get(type) ?? []) fn(e);
    },
  };
}
function fakePage(saved: string | null, bar?: FakeBar) {
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
  const listeners = new Map<string, Array<() => void>>();
  const document = {
    documentElement: {
      setAttribute: (k: string, v: string) => {
        rootAttrs[k] = v;
      },
    },
    getElementById: (id: string) => (id === 'sound-toggle' ? button : id === 'app-bar' ? (bar ?? null) : null),
    addEventListener: (type: string, fn: () => void) => {
      if (type === 'DOMContentLoaded') ready.push(fn);
      else listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    removeEventListener: (type: string, fn: () => void) => {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((f) => f !== fn),
      );
    },
  };
  let readOnly = false;
  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (readOnly) throw new Error('QuotaExceededError');
      store.set(k, v);
    },
  };
  const lib = {
    sound: { setSound: vi.fn(), bindSound: vi.fn(), playSound: vi.fn() },
    cuelume: {
      cuelumeSound: () => {},
      // null: a promise that never settles — WebKit's resume() outside a gesture.
      unlockSound: vi.fn(() => {
        const v = unlocks.shift();
        return v === null ? new Promise<boolean>(() => {}) : Promise.resolve(v ?? true);
      }),
    },
  };
  const imported: string[] = [];
  const unlocks: Array<boolean | null> = [];
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
    `${js.replace('import(url)', '__load(url)')}\nreturn { toggleSound, somaSetSound, somaSoundWarm };`,
  )(document, localStorage, load) as {
    toggleSound(): Promise<boolean>;
    somaSetSound(on: boolean, fromClick: boolean): Promise<boolean>;
    somaSoundWarm(): void;
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
    setReadOnly: () => {
      readOnly = true;
    },
    /** The next unlockSound() calls resolve to these (default true). */
    unlocks,
    /** Fire a page-level event the script listens for (a later pointer press or key). */
    fire: (type: string) => {
      for (const fn of [...(listeners.get(type) ?? [])]) fn();
    },
    listening: (type: string) => (listeners.get(type) ?? []).length,
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
    expect(p.button.attrs).toMatchObject({ 'aria-pressed': 'false' });
  });

  it('a saved "on" loads the library, binds the page and turns sound on — no unlock without a click', async () => {
    const p = fakePage('on');
    expect(p.rootAttrs['data-sound']).toBe('on');
    await tick();
    // sound.js unversioned: the same module the elements import as ./sound.js (one cue queue on the page);
    // the player versioned like the elements' entry files.
    expect(p.imported).toEqual(['/dashboard/ui/sound.js', '/dashboard/ui/sound-cuelume.js?v=9.9.9']);
    expect(p.lib.sound.bindSound).toHaveBeenCalledTimes(1);
    expect(p.lib.sound.setSound).toHaveBeenCalledWith({ player: p.lib.cuelume.cuelumeSound, enabled: true });
    expect(p.lib.cuelume.unlockSound).not.toHaveBeenCalled();
    for (const fn of p.ready) fn();
    expect(p.button.attrs).toMatchObject({ 'aria-pressed': 'true' });
  });

  it('an unwarmed click turns sound on: saved, tried, and the next gesture starts audio (no late cue); again turns it off', async () => {
    const p = fakePage(null);
    await expect(p.api.toggleSound()).resolves.toBe(true);
    expect(p.store.get(SOUND_STORAGE_KEY)).toBe('on');
    expect(p.button.attrs['aria-pressed']).toBe('true');
    expect(p.lib.sound.setSound).toHaveBeenLastCalledWith({ player: p.lib.cuelume.cuelumeSound, enabled: true });
    expect(p.lib.cuelume.unlockSound).toHaveBeenCalledTimes(1);
    // The player arrived after the click's task: no confirming cue now, the next press or key starts audio.
    expect(p.lib.sound.playSound).not.toHaveBeenCalled();
    expect(p.listening('pointerdown')).toBe(1);
    await expect(p.api.toggleSound()).resolves.toBe(false);
    expect(p.store.get(SOUND_STORAGE_KEY)).toBe('off');
    expect(p.rootAttrs['data-sound']).toBe('off');
    expect(p.button.attrs).toMatchObject({ 'aria-pressed': 'false' });
    // The name stays "인터페이스 소리": aria-pressed says the state (a toggle button, not two labels).
    expect(p.button.attrs['aria-label']).toBeUndefined();
    expect(p.lib.sound.setSound).toHaveBeenLastCalledWith({ enabled: false });
    // The modules load once.
    expect(p.imported).toHaveLength(2);
  });

  it('turning it off before it was ever on loads nothing', async () => {
    const p = fakePage(null);
    await expect(p.api.somaSetSound(false, true)).resolves.toBe(false);
    expect(p.imported).toEqual([]);
  });

  it('warmed by the speaker (hover, focus, press), the click unlocks audio and plays its cue in the same task', async () => {
    const p = fakePage(null);
    p.api.somaSoundWarm();
    await tick();
    expect(p.imported).toHaveLength(2);
    // Warming loads and binds, but never turns sound on.
    expect(p.lib.sound.setSound).not.toHaveBeenCalled();
    expect(p.rootAttrs['data-sound']).toBe('off');
    // No await between the click and the unlock: some browsers start audio only inside the gesture.
    const done = p.api.toggleSound();
    expect(p.lib.cuelume.unlockSound).toHaveBeenCalledTimes(1);
    expect(p.lib.sound.setSound).toHaveBeenCalledWith({ player: p.lib.cuelume.cuelumeSound, enabled: true });
    expect(p.lib.sound.playSound).toHaveBeenCalledWith('toggle', { direction: 'forward' });
    await expect(done).resolves.toBe(true);
    p.api.somaSoundWarm();
    await tick();
    expect(p.imported).toHaveLength(2);
  });

  it("<ui-app-bar>'s speaker: warmed on the way to it, its ui-sound-change unlocks in the click's task; the bar sounds the cue", async () => {
    const bar = fakeBar();
    bar.data = { brand: { label: 'soma-work' }, sound: false };
    const p = fakePage(null, bar);
    for (const fn of p.ready) fn();
    // Bound once, at DOMContentLoaded.
    expect(bar.on.get('ui-sound-change')).toHaveLength(1);
    for (const fn of p.ready) fn();
    expect(bar.on.get('ui-sound-change')).toHaveLength(1);
    // Crossing the bar elsewhere loads nothing; heading for the speaker (first target inside .ab-sound) warms.
    const at = (speaker: boolean) => ({
      composedPath: () => [{ closest: (sel: string) => (speaker && sel === '.ab-sound' ? {} : null) }],
    });
    bar.fire('pointerover', at(false));
    await tick();
    expect(p.imported).toEqual([]);
    bar.fire('focusin', at(true));
    await tick();
    expect(p.imported).toHaveLength(2);
    bar.fire('ui-sound-change', { detail: { sound: true } });
    expect(p.lib.cuelume.unlockSound).toHaveBeenCalledTimes(1);
    expect(p.lib.sound.setSound).toHaveBeenCalledWith({ player: p.lib.cuelume.cuelumeSound, enabled: true });
    // The bar plays its own toggle cue once its listeners ran: the page adds none.
    expect(p.lib.sound.playSound).not.toHaveBeenCalled();
    expect(p.store.get(SOUND_STORAGE_KEY)).toBe('on');
    expect(p.rootAttrs['data-sound']).toBe('on');
    // The bar is handed the state, keeping the rest of its data.
    expect(bar.data).toEqual({ brand: { label: 'soma-work' }, sound: true });
    bar.fire('ui-sound-change', { detail: { sound: false } });
    expect(p.lib.sound.setSound).toHaveBeenLastCalledWith({ enabled: false });
    expect(bar.data).toEqual({ brand: { label: 'soma-work' }, sound: false });
    expect(p.store.get(SOUND_STORAGE_KEY)).toBe('off');
  });

  it('turned off while still loading: the load lands on the latest choice (silent, no unlock)', async () => {
    const p = fakePage(null);
    const on = p.api.somaSetSound(true, true);
    const off = p.api.somaSetSound(false, true);
    await expect(on).resolves.toBe(false);
    await expect(off).resolves.toBe(false);
    expect(p.lib.sound.setSound).toHaveBeenLastCalledWith({ enabled: false });
    expect(p.lib.cuelume.unlockSound).not.toHaveBeenCalled();
  });

  it('a library that fails to load never throws; a click that could not turn sound on says off and keeps off', async () => {
    const p = fakePage(null);
    p.setFail();
    await expect(p.api.toggleSound()).resolves.toBe(false);
    expect(p.store.get(SOUND_STORAGE_KEY)).toBe('off');
    expect(p.rootAttrs['data-sound']).toBe('off');
    for (const fn of p.ready) fn();
    expect(p.button.attrs['aria-pressed']).toBe('false');
    expect(p.lib.sound.setSound).not.toHaveBeenCalled();
  });

  it('a saved "on" that fails to load at page load shows off but keeps the choice (the next page tries again)', async () => {
    const p = fakePage(null);
    p.store.set(SOUND_STORAGE_KEY, 'on');
    p.setFail();
    await expect(p.api.somaSetSound(true, false)).resolves.toBe(false);
    expect(p.rootAttrs['data-sound']).toBe('off');
    expect(p.store.get(SOUND_STORAGE_KEY)).toBe('on');
  });

  it('a browser that cannot store the choice still toggles: the state lives in the page', async () => {
    const p = fakePage(null);
    p.setReadOnly();
    await expect(p.api.toggleSound()).resolves.toBe(true);
    await expect(p.api.toggleSound()).resolves.toBe(false);
    expect(p.lib.sound.setSound).toHaveBeenLastCalledWith({ enabled: false });
    expect(p.rootAttrs['data-sound']).toBe('off');
    await expect(p.api.toggleSound()).resolves.toBe(true);
    expect(p.lib.sound.setSound).toHaveBeenLastCalledWith({ player: p.lib.cuelume.cuelumeSound, enabled: true });
  });

  it('audio the click could not start (a slow first load outside the gesture) starts at the next press or key', async () => {
    const p = fakePage(null);
    p.unlocks.push(false);
    await expect(p.api.toggleSound()).resolves.toBe(true);
    await tick();
    expect(p.lib.cuelume.unlockSound).toHaveBeenCalledTimes(1);
    // Not started: no confirming cue into a suspended context; a one-shot unlock waits for the next gesture.
    expect(p.lib.sound.playSound).not.toHaveBeenCalled();
    expect(p.listening('pointerdown')).toBe(1);
    expect(p.listening('keydown')).toBe(1);
    p.fire('keydown');
    expect(p.lib.cuelume.unlockSound).toHaveBeenCalledTimes(2);
    await tick();
    expect(p.listening('pointerdown')).toBe(0);
    expect(p.listening('keydown')).toBe(0);
  });

  it('WebKit: an unlock outside the gesture never settles — the next gestures keep trying until audio runs', async () => {
    const p = fakePage(null);
    p.unlocks.push(null, false);
    await expect(p.api.toggleSound()).resolves.toBe(true);
    await tick();
    // Armed at once, without waiting for an answer that may never come.
    expect(p.listening('pointerdown')).toBe(1);
    // A press that did not start it (false) keeps the listener; the next one (true) starts it and stops listening.
    p.fire('pointerdown');
    await tick();
    expect(p.listening('pointerdown')).toBe(1);
    p.fire('pointerup');
    await tick();
    expect(p.lib.cuelume.unlockSound).toHaveBeenCalledTimes(3);
    expect(p.listening('pointerdown')).toBe(0);
    // No late confirming cue: it would sound on some unrelated later press.
    expect(p.lib.sound.playSound).not.toHaveBeenCalled();
  });

  it('turned off before the next gesture: the waiting unlock does nothing', async () => {
    const p = fakePage(null);
    p.unlocks.push(false);
    await p.api.toggleSound();
    await tick();
    await p.api.toggleSound();
    p.fire('pointerdown');
    expect(p.lib.cuelume.unlockSound).toHaveBeenCalledTimes(1);
  });

  it('reaches the browser byte for byte: no backtick or ${…} in it', () => {
    const js = soundClientJs(UI_LIB_VERSION);
    expect(js).not.toContain('`');
    expect(js).not.toMatch(/\$\{/);
    expect(js).toContain(`/dashboard/ui/sound-cuelume.js?v=${UI_LIB_VERSION}`);
    expect(js).toContain("'/dashboard/ui/sound.js'");
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

  it("the speaker is <ui-app-bar>'s own (before its theme toggle): the page hands it the choice, no button of its own", () => {
    expect(TEMPLATE).not.toContain('id="sound-toggle"');
    expect(TEMPLATE).not.toContain('#sound-toggle');
    const paint = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function paintAppBar()'));
    expect(paint.slice(0, paint.indexOf('\n}\n'))).toContain("sound: typeof _somaOn !== 'undefined' && !!_somaOn,");
  });

  it('runs the sound script in <head>, so the bar gets the saved state with its first data', () => {
    expect(HEAD).toContain('<script data-sound>${soundClientJs(UI_LIB_VERSION)}</script>');
  });
});

describe('the settings page', () => {
  const SETTINGS_TS = readFileSync(join(__dirname, '..', 'settings-page.ts'), 'utf-8');

  it('its own controls (kit .ui-input / .ui-switch in the <ui-setting-row> slots) sound through bindSound: options select, switches toggle, save taps', () => {
    expect(SETTINGS_TS).toContain(
      `'" data-ui-sound="' + soundCue(row, 'select') + '" onchange="onChoice(this)"><span>'`,
    );
    expect(SETTINGS_TS).toContain(
      `'<select class="ui-input" id="f-' + escAttr(row.key) + '" data-key="' + escAttr(row.key) + '" data-ui-sound="' + soundCue(row, 'select') + '"`,
    );
    expect(SETTINGS_TS).toContain(
      `'<label class="ui-switch"><input type="checkbox" role="switch" data-ui-sound="' + soundCue(row, 'toggle') + '"`,
    );
    expect(SETTINGS_TS).toContain(`class="btn primary" data-ui-sound data-key=`);
  });

  it('a setting that asks first stays silent: its change fires before the dialog, so a cancel would still sound', () => {
    const src = SETTINGS_TS.match(/function soundCue\(row, cue\) \{[\s\S]*?\n\}/)?.[0];
    expect(src).toBeDefined();
    const soundCue = new Function(`${src}; return soundCue;`)() as (row: { danger?: boolean }, cue: string) => string;
    expect(soundCue({ danger: true }, 'toggle')).toBe('off');
    expect(soundCue({}, 'toggle')).toBe('toggle');
    expect(soundCue({ danger: false }, 'select')).toBe('select');
  });

  it('the speaker is <ui-app-bar id="app-bar">\'s own, as on the dashboard: the page hands it the choice, no button of its own, the same script in <head>', () => {
    const html = renderSettingsPage();
    const head = html.slice(0, html.indexOf('</head>'));
    // In <head>, before the bar's module: paintAppBar reads the head script's choice (_somaOn) into data.sound.
    expect(head).toContain(soundClientJs(UI_LIB_VERSION));
    // The bar the head script binds at DOMContentLoaded (somaSoundBindBar(document.getElementById('app-bar'))).
    const body = html.slice(html.indexOf('</head>'));
    expect(body).toContain('<ui-app-bar id="app-bar" lang="ko"></ui-app-bar>');
    expect(body).not.toContain('id="sound-toggle"');
    expect(body).not.toContain('toggleSound()');
    expect(html).not.toContain('#sound-toggle');
    expect(html).not.toContain('.topbar .sound');
    const paint = SETTINGS_TS.slice(SETTINGS_TS.indexOf('function paintAppBar()'));
    expect(paint.slice(0, paint.indexOf('\n}\n'))).toContain("sound: typeof _somaOn !== 'undefined' && !!_somaOn,");
  });
});
