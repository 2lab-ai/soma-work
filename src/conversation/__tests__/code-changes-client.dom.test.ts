// @vitest-environment happy-dom
/**
 * .prd/26 §4 (#1296, #1300 review) — the 변경점 tab's client in a DOM: what an answer that lands late may not do, what a
 * failed file read does next, the viewer's Escape and focus, and that every server string is escaped where it shows.
 *
 *   D1  a list answer for a conversation the panel left, or older than the one shown, changes nothing
 *   D2  a file answer that lands after a newer collect is dropped; a failed one is asked again when reopened
 *   D3  Escape in the viewer stops at the viewer; closing it paints the tab again and focuses the file's row
 *   D4  a patch line, a source label and a folder named `constructor` show as text
 */
import { afterEach, describe, expect, it } from 'vitest';
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
