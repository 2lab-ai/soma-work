/**
 * The theme on every page (soma-work 830): light · dark · light·mono · dark·mono. The head script runs here as
 * shipped, against a fake page — <html>'s attributes, this browser's storage, the OS scheme and the app bar.
 */
import { describe, expect, it } from 'vitest';
import { PALETTE_STORAGE_KEY, THEME_STORAGE_KEY, themeClientJs } from '../theme-client';

type Listener = (e: unknown) => void;
interface FakeBar {
  id: string;
  data?: Record<string, unknown>;
}
function fakeBar(data: Record<string, unknown> = { brand: { label: 'soma-work' }, theme: 'dark', palette: 'color' }) {
  const bar: FakeBar = { id: 'app-bar', data };
  return bar;
}

interface Page {
  attrs: Record<string, string>;
  store: Map<string, string>;
  bar: FakeBar | null;
  /** The bar's toggle: a bubbling ui-theme-change from `target` (default: the bar) reaches the document. */
  toggle(detail: unknown, target?: { id: string }): void;
  /** The OS switches its scheme (fires the media listener). */
  os(scheme: 'light' | 'dark'): void;
  /** DOMContentLoaded. */
  ready(): void;
  api: {
    somaThemeSet(theme: unknown, palette?: unknown): void;
    somaThemeNow(): { theme: string; palette: string };
  };
}

function page(opts: {
  os: 'light' | 'dark';
  saved?: Record<string, string>;
  bar?: FakeBar | null;
  storageThrows?: boolean;
}): Page {
  const attrs: Record<string, string> = {};
  const store = new Map(Object.entries(opts.saved ?? {}));
  let scheme = opts.os;
  let onOs: Listener | null = null;
  const ready: Array<() => void> = [];
  const onDoc = new Map<string, Listener[]>();
  const bar = opts.bar === undefined ? fakeBar() : opts.bar;
  const deny = () => {
    if (opts.storageThrows) throw new Error('SecurityError');
  };
  const localStorage = {
    getItem: (k: string) => (deny(), store.get(k) ?? null),
    setItem: (k: string, v: string) => (deny(), store.set(k, v)),
    removeItem: (k: string) => (deny(), store.delete(k)),
  };
  const window = {
    matchMedia: (q: string) => ({
      get matches() {
        return q.includes('light') ? scheme === 'light' : scheme === 'dark';
      },
      addEventListener: (_t: string, fn: Listener) => {
        onOs = fn;
      },
    }),
  };
  const document = {
    documentElement: {
      getAttribute: (k: string) => attrs[k] ?? null,
      setAttribute: (k: string, v: string) => {
        attrs[k] = v;
      },
      removeAttribute: (k: string) => {
        delete attrs[k];
      },
    },
    getElementById: (id: string) => (id === 'app-bar' ? bar : null),
    addEventListener: (type: string, fn: Listener) => {
      if (type === 'DOMContentLoaded') ready.push(fn as () => void);
      else onDoc.set(type, [...(onDoc.get(type) ?? []), fn]);
    },
  };
  const api = new Function(
    'window',
    'document',
    'localStorage',
    `${themeClientJs()}\nreturn { somaThemeSet: somaThemeSet, somaThemeNow: somaThemeNow };`,
  )(window, document, localStorage) as Page['api'];
  return {
    attrs,
    store,
    bar,
    api,
    toggle(detail, target) {
      for (const fn of onDoc.get('ui-theme-change') ?? []) fn({ detail, target: target ?? bar });
    },
    os(next) {
      scheme = next;
      onOs?.({ matches: next === 'light' });
    },
    ready() {
      for (const fn of ready) fn();
    },
  };
}

describe('theme client — the head script (soma-work 830)', () => {
  it('ships byte for byte: parses, holds no template syntax, keeps the storage keys', () => {
    const js = themeClientJs();
    expect(() => new Function(js)).not.toThrow();
    expect(js).not.toContain('`');
    expect(js).not.toContain('${');
    expect([THEME_STORAGE_KEY, PALETTE_STORAGE_KEY]).toEqual(['soma-theme', 'soma-palette']);
    expect(js).toContain("localStorage.getItem('soma-theme')");
    expect(js).toContain("localStorage.getItem('soma-palette')");
  });

  it('before paint: the OS theme and the colour palette when nothing is stored', () => {
    expect(page({ os: 'light' }).attrs).toEqual({ 'data-theme': 'light' });
    expect(page({ os: 'dark' }).attrs).toEqual({ 'data-theme': 'dark' });
  });

  it('before paint: the stored theme and palette — all four themes', () => {
    const cases: Array<[Record<string, string>, 'light' | 'dark', Record<string, string>]> = [
      [{ 'soma-theme': 'light' }, 'dark', { 'data-theme': 'light' }],
      [{}, 'dark', { 'data-theme': 'dark' }],
      [{ 'soma-palette': 'mono' }, 'light', { 'data-theme': 'light', 'data-palette': 'mono' }],
      [{ 'soma-theme': 'dark', 'soma-palette': 'mono' }, 'light', { 'data-theme': 'dark', 'data-palette': 'mono' }],
    ];
    for (const [saved, os, attrs] of cases) expect(page({ os, saved }).attrs).toEqual(attrs);
  });

  it('a stored value it does not know falls back to the OS theme and the colour palette', () => {
    const p = page({ os: 'light', saved: { 'soma-theme': 'sepia', 'soma-palette': 'neon' } });
    expect(p.attrs).toEqual({ 'data-theme': 'light' });
  });

  it('storage that throws (a locked-down browser) is the OS theme, colour — the page still paints', () => {
    const p = page({ os: 'dark', storageThrows: true });
    expect(p.attrs).toEqual({ 'data-theme': 'dark' });
    expect(() => p.api.somaThemeSet('light', 'mono')).not.toThrow();
    expect(p.attrs).toEqual({ 'data-theme': 'light', 'data-palette': 'mono' });
  });

  it('a choice stores the light / dark only while it differs from the OS, and the palette only while mono', () => {
    const p = page({ os: 'dark' });
    p.api.somaThemeSet('light', 'color');
    expect(Object.fromEntries(p.store)).toEqual({ 'soma-theme': 'light' });
    p.api.somaThemeSet('dark', 'mono');
    expect(Object.fromEntries(p.store)).toEqual({ 'soma-palette': 'mono' });
    expect(p.attrs).toEqual({ 'data-theme': 'dark', 'data-palette': 'mono' });
    p.api.somaThemeSet('light', 'mono');
    expect(Object.fromEntries(p.store)).toEqual({ 'soma-theme': 'light', 'soma-palette': 'mono' });
    p.api.somaThemeSet('dark', 'color');
    expect(Object.fromEntries(p.store)).toEqual({});
    expect(p.attrs).toEqual({ 'data-theme': 'dark' });
    // Nonsense is refused, not stored.
    p.api.somaThemeSet('sepia', 'mono');
    expect(p.attrs).toEqual({ 'data-theme': 'dark' });
  });

  it("the bar's toggle walks the four themes: each ui-theme-change applies, stores and hands the bar its state", () => {
    const p = page({ os: 'light' });
    const steps: Array<{ theme: string; palette: string }> = [
      { theme: 'dark', palette: 'color' },
      { theme: 'light', palette: 'mono' },
      { theme: 'dark', palette: 'mono' },
      { theme: 'light', palette: 'color' },
    ];
    const seen: unknown[] = [];
    for (const step of steps) {
      p.toggle(step);
      seen.push([p.attrs['data-theme'], p.attrs['data-palette'] ?? 'color', p.bar!.data!.theme, p.bar!.data!.palette]);
    }
    expect(seen).toEqual(steps.map((s) => [s.theme, s.palette, s.theme, s.palette]));
    // Back at the OS theme in colour: nothing stored. The bar keeps the rest of its data.
    expect(Object.fromEntries(p.store)).toEqual({});
    expect(p.bar!.data!.brand).toEqual({ label: 'soma-work' });
  });

  it('a bar without palettes (@2lab.ai/ui before 0.25.0) toggles light / dark and keeps the palette', () => {
    const p = page({ os: 'light', saved: { 'soma-palette': 'mono' } });
    p.toggle({ theme: 'dark' });
    expect(p.attrs).toEqual({ 'data-theme': 'dark', 'data-palette': 'mono' });
  });

  it('answers a toggle before DOMContentLoaded (the bar can be clicked while a later module still loads)', () => {
    const p = page({ os: 'light' });
    // No ready(): the listener is the document's, bound by the head script itself.
    p.toggle({ theme: 'dark', palette: 'mono' });
    expect(p.attrs).toEqual({ 'data-theme': 'dark', 'data-palette': 'mono' });
    expect(p.bar!.data).toMatchObject({ theme: 'dark', palette: 'mono' });
    expect(Object.fromEntries(p.store)).toEqual({ 'soma-theme': 'dark', 'soma-palette': 'mono' });
  });

  it('answers only the page bar (#app-bar); a page with no bar (the sign-in pages) is fine', () => {
    const p = page({ os: 'light' });
    p.toggle({ theme: 'dark' }, { id: 'demo-bar' });
    expect(p.attrs).toEqual({ 'data-theme': 'light' });
    const none = page({ os: 'light', bar: null });
    expect(() => none.ready()).not.toThrow();
    none.toggle({ theme: 'dark' }, { id: 'app-bar' });
    expect(none.attrs).toEqual({ 'data-theme': 'dark' });
  });

  it('the OS switching light / dark is followed while nothing is pinned, the palette kept; a pinned theme stays', () => {
    const free = page({ os: 'light', saved: { 'soma-palette': 'mono' } });
    free.os('dark');
    expect(free.attrs).toEqual({ 'data-theme': 'dark', 'data-palette': 'mono' });
    expect(free.bar!.data).toMatchObject({ theme: 'dark', palette: 'mono' });
    const pinned = page({ os: 'light', saved: { 'soma-theme': 'light' } });
    pinned.os('dark');
    expect(pinned.attrs).toEqual({ 'data-theme': 'light' });
  });
});
