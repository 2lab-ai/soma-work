// @vitest-environment happy-dom
/**
 * .prd/26 §4 (#1296, #1300 review) — the 변경점 tab's client in a DOM: what an answer that lands late may not do, what a
 * failed file read does next, the viewer's Escape and focus, and that every server string is escaped where it shows.
 *
 *   D1  a list answer for a conversation the panel left, or older than the one shown, changes nothing
 *   D2  a file answer that lands after a newer collect is dropped; a failed one is asked again when reopened
 *   D3  Escape in the viewer stops at the viewer; closing it paints the tab again and focuses the file's row
 *   D4  a patch line, a source label and a folder named `constructor` show as text
 *   D11 the issue tree (.prd/29): a click on a node's fold button hides its subtree and focus lands on the button drawn
 *       in its place; the head folds the whole tree the same way
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CODE_CHANGES_JS } from '../code-changes-client';

/** The bits of happy-dom's globals these tests touch (the project's tsconfig has no DOM lib). */
interface El {
  innerHTML: string;
  textContent: string | null;
  isConnected: boolean;
  getAttribute(name: string): string | null;
  querySelector(sel: string): El | null;
  querySelectorAll(sel: string): ArrayLike<El>;
  dispatchEvent(e: unknown): boolean;
  close(): void;
  click(): void;
  open?: boolean;
}
const dom = globalThis as unknown as {
  document: {
    body: El;
    activeElement: unknown;
    getElementById(id: string): El | null;
    querySelectorAll(sel: string): ArrayLike<El>;
    addEventListener(type: string, fn: (e: { key: string }) => void): void;
  };
  KeyboardEvent: new (type: string, init: object) => unknown;
  Event: new (type: string) => unknown;
};
const byId = (id: string) => dom.document.getElementById(id)!;
const rowOf = (key: string) =>
  Array.from(dom.document.querySelectorAll('[data-chg-file]')).find((r) => r.getAttribute('data-chg-file') === key)!;

type Api = {
  chgOpen: (cid: string) => void;
  chgLoad: (cid: string, refresh: boolean) => Promise<void>;
  chgOpenViewer: (key: string, opener?: El) => void;
  chgNoteCard: (cid: string, at: number) => void;
  chgViewerOpen: () => boolean;
  chgStep: (delta: number) => void;
  state: () => Record<string, any>;
};

/** A fetch whose answers the test hands out, in any order. */
function controlledFetch() {
  const calls: Array<{ url: string; resolve: (body: unknown) => void; fail: () => void }> = [];
  const fetchFn = (url: string) =>
    new Promise((resolve, reject) => {
      calls.push({
        url,
        resolve: (body) => resolve({ ok: true, status: 200, json: async () => body }),
        fail: () => reject(new Error('network')),
      });
    });
  return { calls, fetchFn };
}

function load(fetchFn: unknown): Api {
  dom.document.body.innerHTML = '<div id="panel-changes"></div>';
  const fn = new Function(
    'fetch',
    `${CODE_CHANGES_JS}
    return { chgOpen, chgLoad, chgOpenViewer, chgNoteCard, chgViewerOpen, chgStep, state: function() { return _chg; } };`,
  );
  return fn(fetchFn) as Api;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function doc(updatedAt: number, path = 'src/a.ts') {
  return {
    version: 1,
    conversationId: 'c1',
    updatedAt,
    checkouts: [
      {
        id: 'k1',
        repo: 'acme/web',
        dir: 'web',
        uncommitted: { files: [{ path, status: 'modified', additions: 1, deletions: 1 }], additions: 1, deletions: 1 },
        committed: { files: [], additions: 0, deletions: 0, commits: [] },
      },
    ],
    prs: [],
    counted: { commits: [] },
  };
}

afterEach(() => {
  dom.document.body.innerHTML = '';
});

describe('the 변경점 client in a DOM (#1300 review)', () => {
  it('D1 — a late answer for another conversation, or an older collect, changes nothing', async () => {
    const f = controlledFetch();
    const api = load(f.fetchFn);
    api.chgOpen('c1');
    api.chgOpen('c2');
    // c1's stored list lands after the panel moved to c2.
    f.calls[0].resolve({ doc: doc(100) });
    await flush();
    expect(api.state().cid).toBe('c2');
    expect(api.state().doc).toBeNull();
    // Two loads of c2: the newer lands first, the older after it.
    f.calls[1].resolve({ doc: { ...doc(300), conversationId: 'c2' } });
    await flush();
    const older = api.chgLoad('c2', false);
    const newer = api.chgLoad('c2', true);
    const n = f.calls.length;
    f.calls[n - 1].resolve({ doc: { ...doc(500, 'src/new.ts'), conversationId: 'c2' } });
    await newer;
    f.calls[n - 2].resolve({ doc: { ...doc(400, 'src/old.ts'), conversationId: 'c2' } });
    await older;
    expect(api.state().doc.updatedAt).toBe(500);
    expect(byId('panel-changes').innerHTML).toContain('new.ts');
    expect(byId('panel-changes').innerHTML).not.toContain('old.ts');
  });

  it('D2 — a file answer from before a newer collect is dropped; a failed read is asked again on reopen', async () => {
    const f = controlledFetch();
    const api = load(f.fetchFn);
    api.chgOpen('c1');
    f.calls[0].resolve({ doc: doc(100) });
    await flush();
    const key = 'f:acme/web\nsrc/a.ts';
    api.chgOpenViewer(key);
    const fileCall = f.calls.find((c) => c.url.includes('/changes/file'))!;
    expect(fileCall).toBeDefined();
    // A newer collect lands while the file read is out: the cache is for the new collect now.
    const reload = api.chgLoad('c1', false);
    f.calls[f.calls.length - 1].resolve({ doc: doc(200) });
    await reload;
    await flush();
    fileCall.resolve({
      sources: [{ layer: 'uncommitted', label: 'web', file: { path: 'src/a.ts', patch: '@@ -1 +1 @@\n-OLD\n+OLD' } }],
    });
    await flush();
    expect(byId('chg-v-main').innerHTML).not.toContain('OLD');
    // The new collect's read fails: shown, then asked again when the file is opened again.
    const second = f.calls.filter((c) => c.url.includes('/changes/file'));
    expect(second.length).toBe(2);
    second[1].fail();
    await flush();
    expect(api.state().files[key]).toBe('error');
    byId('chg-viewer').close();
    api.chgOpenViewer(key);
    expect(f.calls.filter((c) => c.url.includes('/changes/file')).length).toBe(3);
  });

  it('D3 — Escape stops at the viewer; closing it paints the tab and focuses the file row', async () => {
    const f = controlledFetch();
    const api = load(f.fetchFn);
    let pageSawEscape = false;
    dom.document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') pageSawEscape = true;
    });
    api.chgOpen('c1');
    f.calls[0].resolve({ doc: doc(100) });
    await flush();
    const key = 'f:acme/web\nsrc/a.ts';
    const row = rowOf(key);
    api.chgOpenViewer(key, row);
    const dialog = byId('chg-viewer');
    dialog.dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(pageSawEscape).toBe(false);
    // The viewer folded a folder of the tab meanwhile: closing paints the tab as it is now.
    api.state().closed['r:acme/web/src'] = true;
    dialog.close();
    dialog.dispatchEvent(new dom.Event('close'));
    const panel = byId('panel-changes');
    expect(panel.querySelector('[data-chg-dir="r:acme/web/src"]')!.getAttribute('aria-expanded')).toBe('false');
    // The tab was painted again, so the opener is gone; the file's row is folded away, so nothing old takes focus.
    expect(row.isConnected).toBe(false);
    // Unfolded and opened again from the new row: closing returns focus to that file's row.
    api.state().closed['r:acme/web/src'] = false;
    const again = rowOf(key);
    api.chgOpenViewer(key, again);
    dialog.close();
    dialog.dispatchEvent(new dom.Event('close'));
    const now = rowOf(key);
    expect(dom.document.activeElement).toBe(now);
  });

  it('D4 — a patch line, a source label and a folder named constructor show as text', async () => {
    const f = controlledFetch();
    const api = load(f.fetchFn);
    api.chgOpen('c1');
    f.calls[0].resolve({ doc: doc(100, 'constructor/__proto__/x.ts') });
    await flush();
    const panel = byId('panel-changes');
    expect(panel.textContent).toContain('constructor/__proto__');
    const key = 'f:acme/web\nconstructor/__proto__/x.ts';
    api.chgOpenViewer(key);
    const fileCall = f.calls.find((c) => c.url.includes('/changes/file'))!;
    fileCall.resolve({
      sources: [
        {
          layer: 'uncommitted',
          label: '<b>web</b>',
          file: { path: 'x.ts', additions: 1, deletions: 0, patch: '@@ -0,0 +1 @@\n+<img src=x onerror=alert(1)>' },
        },
      ],
    });
    await flush();
    const main = byId('chg-v-main');
    expect(main.querySelector('img')).toBeNull();
    expect(main.querySelector('b b')).toBeNull();
    expect(main.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(main.textContent).toContain('<b>web</b>');
  });

  it('D5 — a mode-only change says so instead of "too large"', async () => {
    const f = controlledFetch();
    const api = load(f.fetchFn);
    api.chgOpen('c1');
    f.calls[0].resolve({ doc: doc(100) });
    await flush();
    api.chgOpenViewer('f:acme/web\nsrc/a.ts');
    f.calls
      .find((c) => c.url.includes('/changes/file'))!
      .resolve({
        sources: [
          {
            layer: 'uncommitted',
            label: 'web',
            file: { path: 'src/a.ts', additions: 0, deletions: 0, modeChange: '100644 → 100755' },
          },
        ],
      });
    await flush();
    const main = byId('chg-v-main').textContent!;
    expect(main).toContain('실행 권한이 바뀜 · 100644 → 100755');
    expect(main).not.toContain('너무 커서');
  });

  it('D6 — folding a folder in the viewer keeps focus in it; the page sees the viewer open', async () => {
    const f = controlledFetch();
    const api = load(f.fetchFn);
    api.chgOpen('c1');
    f.calls[0].resolve({ doc: doc(100) });
    await flush();
    const key = 'f:acme/web\nsrc/a.ts';
    api.chgOpenViewer(key);
    const dialog = byId('chg-viewer');
    // The viewer's clicks go through its own handler (wired on the dialog).
    const folder = Array.from(byId('chg-v-tree').querySelectorAll('[data-chg-dir]'))[0];
    const folderKey = folder.getAttribute('data-chg-dir');
    folder.click();
    const active = dom.document.activeElement as El;
    expect(active.getAttribute('data-chg-dir')).toBe(folderKey);
    expect(api.chgViewerOpen()).toBe(dialog.open !== false);
  });

  it('D7 — a late empty answer never clears what is shown; after a 403 a card push asks nothing', async () => {
    const f = controlledFetch();
    const api = load(f.fetchFn);
    api.chgOpen('c1');
    f.calls[0].resolve({ doc: doc(100) });
    await flush();
    const late = api.chgLoad('c1', false);
    f.calls[f.calls.length - 1].resolve({ doc: null });
    await late;
    expect(api.state().doc.updatedAt).toBe(100);
    const f2 = controlledFetch();
    const api2 = load(f2.fetchFn);
    api2.chgOpen('c2');
    f2.calls[0].resolve({ denied: true });
    await flush();
    // (the denied shape comes from a 403; the test hands it over directly)
    api2.state().state = 'denied';
    const before = f2.calls.length;
    api2.chgNoteCard('c2', 999);
    expect(f2.calls.length).toBe(before);
  });

  it('D8 — a file answer from a newer collect than the list reads the list again', async () => {
    const f = controlledFetch();
    const api = load(f.fetchFn);
    api.chgOpen('c1');
    f.calls[0].resolve({ doc: doc(100) });
    await flush();
    api.chgOpenViewer('f:acme/web\nsrc/a.ts');
    const fileCall = f.calls.find((c) => c.url.includes('/changes/file'))!;
    const lists = () => f.calls.filter((c) => !c.url.includes('/changes/file') && !c.url.includes('refresh=1')).length;
    const before = lists();
    fileCall.resolve({
      updatedAt: 200,
      sources: [{ layer: 'uncommitted', label: 'web', file: { path: 'src/a.ts', patch: '@@ -1 +1 @@\n-x\n+NEW' } }],
    });
    await flush();
    expect(lists()).toBe(before + 1);
    expect(byId('chg-v-main').innerHTML).not.toContain('NEW');
  });

  it('D9 — a failed file read is asked again when the viewer steps back onto it', async () => {
    const f = controlledFetch();
    const api = load(f.fetchFn);
    const two = doc(100);
    two.checkouts[0].uncommitted.files.push({ path: 'src/b.ts', status: 'modified', additions: 1, deletions: 1 });
    api.chgOpen('c1');
    f.calls[0].resolve({ doc: two });
    await flush();
    api.chgOpenViewer('f:acme/web\nsrc/a.ts');
    f.calls.filter((c) => c.url.includes('/changes/file'))[0].fail();
    await flush();
    api.chgStep(1);
    api.chgStep(-1);
    const reads = f.calls.filter((c) => c.url.includes('path=src%2Fa.ts'));
    expect(reads.length).toBe(2);
  });

  it('D10 — the viewer shows only the sources of its scope; a rename without an edit says no content changed', async () => {
    const f = controlledFetch();
    const api = load(f.fetchFn);
    const d = doc(100);
    (d as Record<string, unknown>).prs = [
      {
        id: 'acme/web#5',
        url: 'https://github.com/acme/web/pull/5',
        repo: 'acme/web',
        number: 5,
        state: 'open',
        files: [{ path: 'src/a.ts', status: 'modified', additions: 1, deletions: 0 }],
      },
    ];
    api.chgOpen('c1');
    f.calls[0].resolve({ doc: d });
    await flush();
    api.state().scope = 'pr:acme/web#5';
    api.chgOpenViewer('f:acme/web\nsrc/a.ts');
    f.calls
      .find((c) => c.url.includes('/changes/file'))!
      .resolve({
        sources: [
          {
            layer: 'uncommitted',
            label: 'web',
            file: { path: 'src/a.ts', additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n+LOCAL' },
          },
          {
            layer: 'pr',
            label: '#5',
            prNumber: 5,
            file: { path: 'src/a.ts', status: 'renamed', oldPath: 'src/z.ts', additions: 0, deletions: 0 },
          },
        ],
      });
    await flush();
    const main = byId('chg-v-main').textContent!;
    expect(main).not.toContain('LOCAL');
    expect(main).toContain('내용 변경 없음');
  });
});

describe('the viewer’s two modes — a panel beside the card, or the full screen (.prd/28 §4)', () => {
  const g = globalThis as unknown as {
    window?: object;
    localStorage: {
      getItem(k: string): string | null;
      setItem(k: string, v: string): void;
      removeItem(k: string): void;
    };
    document: {
      documentElement: { style: { setProperty(k: string, v: string): void } };
      createElement(t: string): any;
    };
  };
  const setWidth = (w: number) =>
    Object.defineProperty(g.window ?? globalThis, 'innerWidth', { value: w, configurable: true, writable: true });
  const A = 'f:acme/web\nsrc/a.ts';
  const B = 'f:acme/web\nsrc/b.ts';
  type ModeApi = Api & { chgCloseViewer: () => void; chgSyncViewerMode: () => void; chgWire: () => void };
  // This test DOM has no Web Storage: a small one stands in (the device keeps the full-screen choice there).
  const kept = new Map<string, string>();
  g.localStorage = {
    getItem: (k) => (kept.has(k) ? (kept.get(k) as string) : null),
    setItem: (k, v) => void kept.set(k, String(v)),
    removeItem: (k) => void kept.delete(k),
  };
  async function opened(width: number, docked = true) {
    const f = controlledFetch();
    dom.document.body.innerHTML = '<div id="panel-changes"></div>';
    const api = new Function(
      'fetch',
      `${CODE_CHANGES_JS}
      return { chgOpen, chgLoad, chgOpenViewer, chgNoteCard, chgViewerOpen, chgStep, chgCloseViewer, chgSyncViewerMode,
        chgWire, state: function() { return _chg; } };`,
    )(f.fetchFn) as ModeApi;
    setWidth(width);
    g.document.documentElement.style.setProperty('--panel-w', '440px');
    const card = g.document.createElement('div');
    card.id = 'slide-panel';
    if (docked) card.setAttribute('open', '');
    (dom.document.body as unknown as { appendChild(n: unknown): void }).appendChild(card);
    api.chgOpen('c1');
    const two = doc(100);
    two.checkouts[0].uncommitted.files.push({ path: 'src/b.ts', status: 'modified', additions: 2, deletions: 0 });
    f.calls[0].resolve({ doc: two });
    await flush();
    // The page wires the tab's clicks once (initPanelSections → chgWire).
    api.chgWire();
    return api;
  }
  const viewer = () => byId('chg-viewer') as El & { hasAttribute(n: string): boolean };
  // Which way the dialog opened (review P2): show() leaves the card usable, showModal() makes the rest inert — the
  // test DOM sets \`open\` for both, so the calls are what tell them apart.
  const proto = (globalThis as unknown as { HTMLDialogElement: { prototype: object } }).HTMLDialogElement.prototype;
  const shown: string[] = [];
  const spies = [
    vi.spyOn(proto as { show(): void }, 'show').mockImplementation(function (
      this: El & { setAttribute(k: string, v: string): void },
    ) {
      shown.push('show');
      this.setAttribute('open', '');
    }),
    vi.spyOn(proto as { showModal(): void }, 'showModal').mockImplementation(function (
      this: El & { setAttribute(k: string, v: string): void },
    ) {
      shown.push('showModal');
      this.setAttribute('open', '');
    }),
  ];
  beforeEach(() => {
    shown.length = 0;
  });
  afterEach(() => {
    g.localStorage.removeItem('soma-chg-viewer');
  });
  afterAll(() => {
    for (const sp of spies) sp.mockRestore();
  });

  it('M1 — beside a docked card with room on its left: a panel (not modal); the tab marks the file; another row switches it', async () => {
    const api = await opened(1440);
    api.chgOpenViewer(A, rowOf(A));
    expect(viewer().getAttribute('data-mode')).toBe('panel');
    expect(viewer().open).toBe(true);
    expect(shown).toEqual(['show']);
    expect(rowOf(A).getAttribute('aria-current')).toBe('true');
    rowOf(B).click();
    expect(api.state().viewer.key).toBe(B);
    expect(viewer().open).toBe(true);
    // Switched in place: no second opening.
    expect(shown).toEqual(['show']);
    expect(byId('chg-v-title').textContent).toContain('src/b.ts');
    expect(rowOf(B).getAttribute('aria-current')).toBe('true');
    expect(rowOf(A).getAttribute('aria-current')).toBeNull();
    expect(dom.document.activeElement).toBe(rowOf(B));
  });

  it('M2 — Escape closes the panel only, wherever focus is: the card sees it handled, focus goes back to the row', async () => {
    const api = await opened(1440);
    api.chgOpenViewer(A, rowOf(A));
    let cardSaw = false;
    const page = (e: { key: string; defaultPrevented?: boolean }) => {
      if (e.key === 'Escape' && !e.defaultPrevented) cardSaw = true;
    };
    dom.document.addEventListener('keydown', page);
    rowOf(A).dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(api.chgViewerOpen()).toBe(false);
    expect(cardSaw).toBe(false);
    expect(dom.document.activeElement).toBe(rowOf(A));
    // With the viewer closed the next Escape is the card's again.
    rowOf(A).dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(cardSaw).toBe(true);
  });

  it('M3 — no room on the left (1024 beside a 440 card) or no docked card: the full screen, with no "패널로"', async () => {
    const api = await opened(1024);
    api.chgOpenViewer(A, rowOf(A));
    expect(viewer().getAttribute('data-mode')).toBe('full');
    expect(shown).toEqual(['showModal']);
    expect(viewer().hasAttribute('data-fits')).toBe(false);
    api.chgCloseViewer();
    const closed = await opened(1440, false);
    closed.chgOpenViewer(A, rowOf(A));
    expect(viewer().getAttribute('data-mode')).toBe('full');
  });

  it('M4 — "전체 화면" moves the same file to the full screen and remembers it; "패널로" goes back and forgets', async () => {
    const api = await opened(1440);
    api.chgOpenViewer(A, rowOf(A));
    viewer().querySelector('[data-chg-v="full"]')!.click();
    expect(viewer().getAttribute('data-mode')).toBe('full');
    expect(viewer().open).toBe(true);
    expect(shown).toEqual(['show', 'showModal']);
    expect(api.state().viewer.key).toBe(A);
    expect(g.localStorage.getItem('soma-chg-viewer')).toBe('full');
    api.chgCloseViewer();
    api.chgOpenViewer(A, rowOf(A));
    expect(viewer().getAttribute('data-mode')).toBe('full');
    expect(viewer().hasAttribute('data-fits')).toBe(true);
    viewer().querySelector('[data-chg-v="panel"]')!.click();
    expect(viewer().getAttribute('data-mode')).toBe('panel');
    expect(viewer().open).toBe(true);
    expect(shown.slice(-2)).toEqual(['showModal', 'show']);
    expect(g.localStorage.getItem('soma-chg-viewer')).toBeNull();
  });

  it('M5 — the window narrows under the panel: the same file goes full screen; it widens: back to the panel', async () => {
    const api = await opened(1440);
    api.chgOpenViewer(A, rowOf(A));
    setWidth(1000);
    api.chgSyncViewerMode();
    expect(viewer().getAttribute('data-mode')).toBe('full');
    expect(viewer().open).toBe(true);
    expect(api.state().viewer.key).toBe(A);
    setWidth(1440);
    api.chgSyncViewerMode();
    expect(viewer().getAttribute('data-mode')).toBe('panel');
    expect(viewer().open).toBe(true);
    expect(shown).toEqual(['show', 'showModal', 'show']);
  });

  it('M7 — a newer collect while a file is shown (each turn end): the file and its scroll stay until the new read lands', async () => {
    // Independent review #6: the panel stays open while the session works, so every collect used to blank it to
    // "불러오는 중…" and jump to the top.
    const f = controlledFetch();
    dom.document.body.innerHTML = '<div id="panel-changes"></div>';
    const api = new Function(
      'fetch',
      `${CODE_CHANGES_JS}
      return { chgOpen, chgLoad, chgOpenViewer, chgNoteCard, chgViewerOpen, chgStep, state: function() { return _chg; } };`,
    )(f.fetchFn) as Api;
    const two = (at: number) => {
      const d = doc(at);
      d.checkouts[0].uncommitted.files.push({ path: 'src/b.ts', status: 'modified', additions: 2, deletions: 0 });
      return d;
    };
    api.chgOpen('c1');
    f.calls[0].resolve({ doc: two(100) });
    await flush();
    api.chgOpenViewer(A);
    const src = (text: string) => ({
      updatedAt: 100,
      sources: [{ layer: 'uncommitted', label: 'web', file: { path: 'src/a.ts', patch: `@@ -1 +1 @@\n-x\n+${text}` } }],
    });
    f.calls.find((c) => c.url.includes('/changes/file'))!.resolve(src('OLD'));
    await flush();
    const main = byId('chg-v-main') as El & { scrollTop: number };
    expect(main.innerHTML).toContain('OLD');
    main.scrollTop = 120;
    api.chgNoteCard('c1', 200);
    f.calls[f.calls.length - 1].resolve({ doc: two(200) });
    await flush();
    // The list moved on: the shown file stays (not "불러오는 중…") while its new read is out.
    expect(main.innerHTML).toContain('OLD');
    expect(main.innerHTML).not.toContain('불러오는 중');
    const again = f.calls.filter((c) => c.url.includes('/changes/file'));
    expect(again).toHaveLength(2);
    again[1].resolve({ ...src('NEW'), updatedAt: 200 });
    await flush();
    expect(main.innerHTML).toContain('NEW');
    expect(main.scrollTop).toBe(120);
    // Another file starts at its top — read for the first time, and again once it is cached (review P2).
    api.chgStep(1);
    expect(api.state().viewer.key).toBe(B);
    expect(main.scrollTop).toBe(0);
    f.calls
      .filter((c) => c.url.includes('/changes/file') && c.url.includes('b.ts'))[0]
      .resolve({
        updatedAt: 200,
        sources: [{ layer: 'uncommitted', label: 'web', file: { path: 'src/b.ts', patch: '@@ -1 +1 @@\n-y\n+B' } }],
      });
    await flush();
    api.chgStep(1);
    expect(api.state().viewer.key).toBe(A);
    main.scrollTop = 90;
    api.chgStep(1);
    expect(main.innerHTML).toContain('+</span>B');
    expect(main.scrollTop).toBe(0);
  });

  it('M8 — the same path in another session never shows the last session’s patch while its read is out (review P1)', async () => {
    const api = await opened(1440);
    api.chgOpenViewer(A, rowOf(A));
    // c1's file is shown…
    const main = byId('chg-v-main');
    (main as unknown as { _chgShown: boolean })._chgShown = true;
    main.innerHTML = '<div>c1 PATCH</div>';
    (main as unknown as { _chgFor: string })._chgFor = `c1\n${A}`;
    api.chgCloseViewer();
    // …the card turns to c2, which has the same repo and path.
    api.chgOpen('c2');
    api.state().doc = { ...doc(300), conversationId: 'c2' };
    api.state().state = 'ok';
    api.chgOpenViewer(A, rowOf(A));
    expect(main.innerHTML).not.toContain('c1 PATCH');
    expect(main.innerHTML).toContain('불러오는 중');
  });

  it('M9 — mode switches whose close events arrive later (as in a browser) keep the file and the panel; a real close cleans up', async () => {
    const dialogProto = proto as { close(this: El & { removeAttribute(k: string): void; open?: boolean }): void };
    const realClose = vi.spyOn(dialogProto, 'close').mockImplementation(function (
      this: El & { removeAttribute(k: string): void; open?: boolean; dispatchEvent(e: unknown): boolean },
    ) {
      const was = this.open;
      this.removeAttribute('open');
      if (was) setTimeout(() => this.dispatchEvent(new dom.Event('close')), 0);
    });
    try {
      const api = await opened(1440);
      api.chgOpenViewer(A, rowOf(A));
      viewer().querySelector('[data-chg-v="full"]')!.click();
      viewer().querySelector('[data-chg-v="panel"]')!.click();
      // Both switches' close events are still queued here.
      expect(viewer().getAttribute('data-mode')).toBe('panel');
      await flush();
      expect(viewer().open).toBe(true);
      expect(viewer().getAttribute('data-mode')).toBe('panel');
      expect(api.state().viewer.key).toBe(A);
      expect(rowOf(A).getAttribute('aria-current')).toBe('true');
      // A real close: its (queued) event clears the viewer and puts focus back on the row.
      api.chgCloseViewer();
      await flush();
      expect(api.state().viewer).toBeNull();
      expect(rowOf(A).getAttribute('aria-current')).toBeNull();
      expect(dom.document.activeElement).toBe(rowOf(A));
    } finally {
      realClose.mockRestore();
    }
  });

  it('M10 — storage that refuses writes never undoes the chosen mode (review P2)', async () => {
    const api = await opened(1440);
    const saved = g.localStorage.setItem;
    g.localStorage.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    try {
      api.chgOpenViewer(A, rowOf(A));
      viewer().querySelector('[data-chg-v="full"]')!.click();
      expect(viewer().getAttribute('data-mode')).toBe('full');
      // The card's width changes: the page's choice stands.
      api.chgSyncViewerMode();
      expect(viewer().getAttribute('data-mode')).toBe('full');
    } finally {
      g.localStorage.setItem = saved;
    }
  });

  it('M6 — the card turns to another session, or closes (chgCloseViewer): the viewer closes', async () => {
    const api = await opened(1440);
    api.chgOpenViewer(A, rowOf(A));
    api.chgOpen('c2');
    expect(api.chgViewerOpen()).toBe(false);
    expect(api.state().viewer).toBeNull();
  });
});

describe('the 변경점 issue tree in a DOM (.prd/29 §6)', () => {
  const GH = 'https://github.com/acme/web';
  const nid = (p: string) => `${GH}/${p}`.toLowerCase();
  const VIEW = {
    nodes: [
      {
        id: nid('issues/10'),
        kind: 'issue',
        source: 'github',
        url: `${GH}/issues/10`,
        label: '#10',
        title: 'EPIC',
        placed: 'default',
      },
      {
        id: nid('issues/11'),
        kind: 'issue',
        source: 'github',
        url: `${GH}/issues/11`,
        label: '#11',
        title: 'collector',
        parent: nid('issues/10'),
        placed: 'model',
      },
      {
        id: nid('pull/7'),
        kind: 'pr',
        source: 'github',
        url: `${GH}/pull/7`,
        parent: nid('issues/11'),
        placed: 'closes',
      },
    ],
  };
  function loadWithTree(fetchFn: unknown) {
    dom.document.body.innerHTML = '<div id="panel-changes"></div>';
    const fn = new Function(
      'fetch',
      'view',
      `var _sessionCache = { k1: { issueTree: view } }; var panelSessionKey = 'k1';
      ${CODE_CHANGES_JS}
      return { chgOpen: chgOpen, chgWire: chgWire };`,
    );
    return fn(fetchFn, VIEW) as { chgOpen: (cid: string) => void; chgWire: () => void };
  }
  const rows = () =>
    Array.from(byId('panel-changes').querySelectorAll('.chg-inode')).map((r) => r.getAttribute('data-chg-node'));
  const toggle = (key: string) =>
    Array.from(byId('panel-changes').querySelectorAll('[data-chg-itree]')).find(
      (b) => b.getAttribute('data-chg-itree') === key,
    ) as (El & { focus(): void }) | undefined;

  it('D11 — a node’s fold button hides its subtree, focus stays on it; the head folds the whole tree', async () => {
    const f = controlledFetch();
    const api = loadWithTree(f.fetchFn);
    api.chgWire(); // as the page does once the panel is there
    api.chgOpen('c1');
    const pr7 = {
      id: 'acme/web#7',
      url: `${GH}/pull/7`,
      repo: 'acme/web',
      number: 7,
      title: 'PR 7',
      state: 'merged',
      additions: 3,
      deletions: 1,
      changedFiles: 1,
      files: [],
    };
    f.calls[0].resolve({ doc: { ...doc(100), prs: [pr7] } });
    await flush();
    expect(rows()).toEqual([nid('issues/10'), nid('issues/11'), nid('pull/7')]);
    // A real click on the rendered button, as a browser sends it (the panel's own delegated handler).
    const epic = toggle(nid('issues/10'))!;
    epic.focus();
    epic.click();
    expect(rows()).toEqual([nid('issues/10')]);
    const after = dom.document.activeElement as El;
    expect(after.getAttribute('data-chg-itree')).toBe(nid('issues/10'));
    expect(after.getAttribute('aria-expanded')).toBe('false');
    expect(after).not.toBe(epic); // the tab was painted again: focus moved to the new button
    toggle(nid('issues/10'))!.click();
    expect(rows()).toEqual([nid('issues/10'), nid('issues/11'), nid('pull/7')]);
    // The head: the whole tree folds, focus stays on the head.
    toggle('*')!.click();
    expect(rows()).toEqual([]);
    expect((dom.document.activeElement as El).getAttribute('data-chg-itree')).toBe('*');
    toggle('*')!.click();
    expect(rows()).toHaveLength(3);
  });
});
