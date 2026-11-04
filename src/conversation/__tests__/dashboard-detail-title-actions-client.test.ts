/**
 * The detail card's title actions (SSOT 2026-11-04, Z): "디테일 작업 카드에 퍼머링크링크랑 전체 문맥 복사 버튼 작게 2개
 * 타이틀 텍스트오른쪽에 포함해줘." — executed from the shipped client code cut out of renderDashboardPage()'s template
 * literal (the harness of dashboard-detail-zones-client.test.ts):
 *
 *   ┌ title bar   <title text> [↗ 퍼머링크] [⧉ 전체 문맥 복사]          ‹ 1/2 ›  ✕
 *
 *   A1  the page: both buttons sit in the title's row, right after the title text, small, with the kit's glyphs
 *   A2  퍼머링크 = the card's deep link (the link the Slack thread head carries): /dashboard/<owner>?session=<key>
 *   A3  the buttons follow the open card (repaintPanelSession): the link's href, no copy without a conversation
 *   A4  a press on 퍼머링크 copies the link (a modified press opens it, as any link does)
 *   A5  a press on 전체 문맥 복사 copies the conversation's export — every turn, as markdown — and says so
 *   A6  the clipboard: a ClipboardItem holding the pending text (Safari keeps the press), then writeText, then a textarea
 *   A7  every Korean string the buttons show has an English entry (en-page catalog)
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));
const EN_PAGE = JSON.parse(
  readFileSync(join(__dirname, '..', '..', '..', 'packages', 'common', 'src', 'i18n-catalog', 'en-page.json'), 'utf-8'),
) as Record<string, string>;

function cook(fragment: string): string {
  if (fragment.includes('`') || fragment.includes('${')) throw new Error('fragment is not a plain template slice');
  return new Function(`return \`${fragment}\`;`)() as string;
}
function clientFn(name: string): string {
  const start = TEMPLATE.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = TEMPLATE.indexOf('\n}\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 2));
}
function load<T>(fns: string[], inject: Record<string, unknown> = {}): T {
  const names = Object.keys(inject);
  const body = `${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}
const PAGE = cook(TEMPLATE.slice(TEMPLATE.indexOf('<body'), TEMPLATE.indexOf('<script>', TEMPLATE.indexOf('<body'))));
const CSS = cook(
  TEMPLATE.slice(TEMPLATE.indexOf('<style>'), TEMPLATE.indexOf('</style>', TEMPLATE.indexOf('<style>'))),
);

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('A1 — the page: two small buttons right after the title text', () => {
  const header = PAGE.slice(
    PAGE.indexOf('<div class="panel-header">'),
    PAGE.indexOf('<ui-deck-nav class="panel-deck"'),
  );

  it('the title row holds the title, then 퍼머링크, then 전체 문맥 복사 — before the deck nav and ✕', () => {
    const row = header.slice(header.indexOf('<div class="panel-title-row">'));
    expect(header.indexOf('<div class="panel-title-row">')).toBeGreaterThan(-1);
    const title = row.indexOf('id="panel-title"');
    const link = row.indexOf('id="panel-permalink"');
    const copy = row.indexOf('id="panel-copy-context"');
    expect(title).toBeGreaterThan(-1);
    expect(link).toBeGreaterThan(title);
    expect(copy).toBeGreaterThan(link);
    // Right of the text, not under it: the subtitle comes after the row.
    expect(header.indexOf('id="panel-title-sub"')).toBeGreaterThan(header.indexOf('id="panel-copy-context"'));
  });

  it('퍼머링크 is a link (an <a> with the kit link glyph), 전체 문맥 복사 a button with the copy glyph; both named', () => {
    const link = header.match(/<a [^>]*id="panel-permalink"[^>]*>(.*?)<\/a>/);
    expect(link).not.toBeNull();
    expect(link?.[0]).toMatch(/aria-label="퍼머링크 복사"/);
    expect(link?.[0]).toMatch(/title="퍼머링크 복사"/);
    expect(link?.[1]).toBe('<i data-ui-icon="external"></i>');
    const copy = header.match(/<button [^>]*id="panel-copy-context"[^>]*>(.*?)<\/button>/);
    expect(copy).not.toBeNull();
    expect(copy?.[0]).toMatch(/type="button"/);
    expect(copy?.[0]).toMatch(/aria-label="전체 문맥 복사"/);
    expect(copy?.[1]).toBe('<i data-ui-icon="copy"></i>');
    // Hidden until a card fills them (no dead link on an empty panel).
    expect(link?.[0]).toMatch(/\shidden[\s>]/);
    expect(copy?.[0]).toMatch(/\shidden[\s>]/);
  });

  it('small: 24px squares with 14px glyphs; the title keeps its width (no flex: 1), so they hug its text', () => {
    const act = CSS.match(/\.panel-title-row > \.panel-title-act \{([^}]*)\}/);
    expect(act).not.toBeNull();
    expect(act?.[1]).toMatch(/width: 24px/);
    expect(act?.[1]).toMatch(/height: 24px/);
    expect(act?.[1]).toMatch(/flex: none/);
    expect(CSS).toMatch(/\.panel-title-row > \.panel-title-act > svg \{ width: 14px; height: 14px; \}/);
    expect(CSS).toMatch(/\.panel-title-row > #panel-title \{[^}]*flex: 0 1 auto/);
    // The kit's .ui-icon-btn is display: inline-grid — the hidden attribute needs its own rule.
    expect(CSS).toMatch(/\.panel-title-row > \.panel-title-act\[hidden\] \{ display: none; \}/);
    // No kit size modifier: .ui-icon-btn.is-sm (28px) would outrank the row's 24px.
    expect(header.match(/id="panel-(permalink|copy-context)"[^>]*/g)?.join(' ')).not.toMatch(/is-sm/);
  });
});

type PermalinkApi = { panelPermalinkOf: (s: unknown, origin: string, selfInstance?: string) => string };
type ResolveApi = { resolveDeepLinkKey: (ref: string | null, keys: string[], selfInstance: string) => string | null };

describe('A2 — 퍼머링크: the card’s deep link, the one the Slack thread head carries', () => {
  const SELF = 'mac-mini-dev';
  const panelPermalinkOf = (s: unknown, origin: string, selfInstance: string = SELF) =>
    load<PermalinkApi>(['panelPermalinkOf']).panelPermalinkOf(s, origin, selfInstance);
  const env = { instanceName: SELF, port: 3000, host: 'h' };
  const sib = { instanceName: 'oudwood-dev', port: 3001, host: 'o' };
  const ORIGIN = 'https://soma.example';

  it('a live card: /dashboard/<owner>?session=<registry key> — this instance’s prefix (#814) dropped', () => {
    expect(
      panelPermalinkOf({ key: 'mac-mini-dev::work:C1:1700000000.000100', ownerId: 'U1', environment: env }, ORIGIN),
    ).toBe('https://soma.example/dashboard/U1?session=work%3AC1%3A1700000000.000100');
  });

  it('an archived card: the thread’s key — the link keeps opening the thread (its latest archive)', () => {
    expect(
      panelPermalinkOf(
        { key: 'mac-mini-dev::archived_work:C1:1700000000.000100_1762000000000', ownerId: 'U1', environment: env },
        ORIGIN,
      ),
    ).toBe('https://soma.example/dashboard/U1?session=work%3AC1%3A1700000000.000100');
  });

  it('a sibling instance’s card keeps its instance (the same thread may be ours too); its archive wrapper goes', () => {
    expect(panelPermalinkOf({ key: 'oudwood-dev::work:C2:1.2', ownerId: 'U2', environment: sib }, ORIGIN)).toBe(
      'https://soma.example/dashboard/U2?session=oudwood-dev%3A%3Awork%3AC2%3A1.2',
    );
    expect(
      panelPermalinkOf(
        { key: 'oudwood-dev::archived_work:C2:1.2_1762000000000', ownerId: 'U2', environment: sib },
        ORIGIN,
      ),
    ).toBe('https://soma.example/dashboard/U2?session=oudwood-dev%3A%3Awork%3AC2%3A1.2');
  });

  it('no instance wired (no environment — composeSessionKey adds no prefix then): the key as it is', () => {
    expect(panelPermalinkOf({ key: 'work:C3:1.3', ownerId: 'U 3' }, ORIGIN, '')).toBe(
      'https://soma.example/dashboard/U%203?session=work%3AC3%3A1.3',
    );
  });

  it('no owner or no key: no link', () => {
    expect(panelPermalinkOf({ key: 'work:C1:1' }, ORIGIN)).toBe('');
    expect(panelPermalinkOf({ ownerId: 'U1' }, ORIGIN)).toBe('');
    expect(panelPermalinkOf(null, ORIGIN)).toBe('');
  });

  describe('round trip: the copied link opens the same card (the page’s own resolveDeepLinkKey)', () => {
    const refOf = (url: string) => new URL(url).searchParams.get('session');
    const resolve = (ref: string | null, keys: string[]) =>
      load<ResolveApi>(['resolveDeepLinkKey']).resolveDeepLinkKey(ref, keys, SELF);
    const SELF_LIVE = 'mac-mini-dev::work:C1:1.1';
    const SIB_LIVE = 'oudwood-dev::work:C1:1.1'; // the same thread on both instances
    const card = (key: string, e: unknown) => ({ key, ownerId: 'U1', environment: e });

    it('this instance’s card and a sibling’s card on the same thread open themselves, not each other', () => {
      const keys = [SELF_LIVE, SIB_LIVE];
      expect(resolve(refOf(panelPermalinkOf(card(SELF_LIVE, env), ORIGIN)), keys)).toBe(SELF_LIVE);
      expect(resolve(refOf(panelPermalinkOf(card(SIB_LIVE, sib), ORIGIN)), keys)).toBe(SIB_LIVE);
    });

    it('after the session is archived the same link opens its latest archive — on either instance', () => {
      const selfLink = refOf(panelPermalinkOf(card(SELF_LIVE, env), ORIGIN));
      const sibLink = refOf(panelPermalinkOf(card(SIB_LIVE, sib), ORIGIN));
      const keys = [
        'mac-mini-dev::archived_work:C1:1.1_1000',
        'mac-mini-dev::archived_work:C1:1.1_2000',
        'oudwood-dev::archived_work:C1:1.1_1500',
        'oudwood-dev::archived_work:C1:1.1_3000',
      ];
      expect(resolve(selfLink, keys)).toBe('mac-mini-dev::archived_work:C1:1.1_2000');
      expect(resolve(sibLink, keys)).toBe('oudwood-dev::archived_work:C1:1.1_3000');
    });

    it('this instance’s card archived, a sibling’s still live on the same thread: the bare link opens ours', () => {
      const keys = ['mac-mini-dev::archived_work:C1:1.1_2000', SIB_LIVE];
      expect(resolve(refOf(panelPermalinkOf(card(SELF_LIVE, env), ORIGIN)), keys)).toBe(
        'mac-mini-dev::archived_work:C1:1.1_2000',
      );
      // …and the sibling’s own link still opens the sibling’s live card.
      expect(resolve(refOf(panelPermalinkOf(card(SIB_LIVE, sib), ORIGIN)), keys)).toBe(SIB_LIVE);
    });

    it('a bare link (Slack’s) with no archive here still finds the thread’s archive on another instance', () => {
      const keys = ['oudwood-dev::archived_work:C1:1.1_1500'];
      expect(resolve('work:C1:1.1', keys)).toBe('oudwood-dev::archived_work:C1:1.1_1500');
    });

    it('an instance-qualified link never matches an instance whose name only ends the same (dev vs mac-dev)', () => {
      const keys = ['mac-dev::archived_work:C1:1.1_9000', 'dev::archived_work:C1:1.1_1000'];
      expect(resolve('dev::work:C1:1.1', keys)).toBe('dev::archived_work:C1:1.1_1000');
      expect(resolve('dev::work:C1:1.1', ['mac-dev::archived_work:C1:1.1_9000'])).toBeNull();
    });

    it('an archived card’s own link opens that thread’s latest archive', () => {
      const archived = card('oudwood-dev::archived_work:C1:1.1_1500', sib);
      const keys = ['oudwood-dev::archived_work:C1:1.1_1500', 'oudwood-dev::archived_work:C1:1.1_3000'];
      expect(resolve(refOf(panelPermalinkOf(archived, ORIGIN)), keys)).toBe('oudwood-dev::archived_work:C1:1.1_3000');
    });
  });
});

type El = {
  hidden: boolean;
  attrs: Record<string, string>;
  setAttribute: (n: string, v: string) => void;
  getAttribute: (n: string) => string | null;
  removeAttribute: (n: string) => void;
  href?: string;
};
function el(over: Partial<El> = {}): El {
  const e: El = {
    hidden: true,
    attrs: {},
    setAttribute(n, v) {
      this.attrs[n] = String(v);
      if (n === 'href') this.href = String(v);
    },
    getAttribute(n) {
      return n in this.attrs ? this.attrs[n] : null;
    },
    removeAttribute(n) {
      delete this.attrs[n];
    },
    ...over,
  };
  return e;
}

describe('A3 — the buttons follow the open card', () => {
  const setup = () => {
    const link = el();
    const copy = el();
    const document = {
      getElementById: (id: string) => (id === 'panel-permalink' ? link : id === 'panel-copy-context' ? copy : null),
    };
    const { renderPanelTitleActions } = load<{ renderPanelTitleActions: (s: unknown) => void }>(
      ['panelPermalinkOf', 'renderPanelTitleActions'],
      {
        document,
        location: { origin: 'https://soma.example' },
        SELF_INSTANCE_NAME: 'mac-mini-dev',
        isSiblingSession: (x: any) => !!(x?.environment && x.environment.instanceName !== 'mac-mini-dev'),
      },
    );
    return { link, copy, renderPanelTitleActions };
  };

  it('renderPanelTitleActions: the link’s href and both shown for a recorded card; no copy without a conversation', () => {
    const { link, copy, renderPanelTitleActions } = setup();
    renderPanelTitleActions({ key: 'work:C1:1', ownerId: 'U1', conversationId: 'conv-1' });
    expect(link.attrs.href).toBe('https://soma.example/dashboard/U1?session=work%3AC1%3A1');
    expect(link.hidden).toBe(false);
    expect(copy.hidden).toBe(false);
    renderPanelTitleActions({ key: 'work:C1:2', ownerId: 'U1' });
    expect(link.attrs.href).toBe('https://soma.example/dashboard/U1?session=work%3AC1%3A2');
    expect(copy.hidden).toBe(true);
    renderPanelTitleActions({ key: 'work:C1:3' });
    expect(link.hidden).toBe(true);
  });

  it('a sibling instance’s card (#814): its link, but no 전체 문맥 복사 — its conversation is not on this server', () => {
    const { link, copy, renderPanelTitleActions } = setup();
    renderPanelTitleActions({
      key: 'oudwood-dev::work:C2:1',
      ownerId: 'U1',
      conversationId: 'conv-2',
      environment: { instanceName: 'oudwood-dev' },
    });
    expect(link.hidden).toBe(false);
    expect(link.attrs.href).toBe('https://soma.example/dashboard/U1?session=oudwood-dev%3A%3Awork%3AC2%3A1');
    expect(copy.hidden).toBe(true);
  });

  it('wiring: the panel’s live repaint (every opening and every update) renders them', () => {
    const repaint = clientFn('repaintPanelSession');
    expect(repaint).toMatch(/renderPanelTitleActions\(s\);/);
  });
});

describe('A4 — a press on 퍼머링크 copies the link', () => {
  const setup = () => {
    const link = el({ hidden: false, href: 'https://soma.example/dashboard/U1?session=work%3AC1%3A1' });
    const copied: unknown[] = [];
    const toasts: Array<Record<string, unknown>> = [];
    const api = load<{ copyPanelPermalink: (e: unknown) => boolean }>(['copyPanelPermalink'], {
      document: { getElementById: (id: string) => (id === 'panel-permalink' ? link : null) },
      copyToClipboard: (t: unknown) => {
        copied.push(t);
        return Promise.resolve(true);
      },
      dashToast: (t: Record<string, unknown>) => toasts.push(t),
    });
    return { api, copied, toasts };
  };

  it('a plain press: no navigation, the link copied, a toast with the link', async () => {
    const { api, copied, toasts } = setup();
    const e = { preventDefault: vi.fn(), button: 0 };
    expect(api.copyPanelPermalink(e)).toBe(false);
    expect(e.preventDefault).toHaveBeenCalled();
    await tick();
    expect(copied).toEqual(['https://soma.example/dashboard/U1?session=work%3AC1%3A1']);
    expect(toasts).toEqual([
      {
        title: '퍼머링크를 복사했어요',
        description: 'https://soma.example/dashboard/U1?session=work%3AC1%3A1',
        tone: 'success',
      },
    ]);
  });

  it('⌘/Ctrl/Shift press: the browser opens the link as usual — nothing copied', async () => {
    const { api, copied } = setup();
    for (const mod of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey']) {
      const e = { preventDefault: vi.fn(), button: 0, [mod]: true };
      expect(api.copyPanelPermalink(e)).toBe(true);
      expect(e.preventDefault).not.toHaveBeenCalled();
    }
    await tick();
    expect(copied).toEqual([]);
  });

  it('a refused clipboard says so, with the link to copy by hand', async () => {
    const link = el({ hidden: false, href: 'https://x/dashboard/U1?session=k' });
    const toasts: Array<Record<string, unknown>> = [];
    const api = load<{ copyPanelPermalink: (e: unknown) => boolean }>(['copyPanelPermalink'], {
      document: { getElementById: () => link },
      copyToClipboard: () => Promise.resolve(false),
      dashToast: (t: Record<string, unknown>) => toasts.push(t),
    });
    api.copyPanelPermalink({ preventDefault() {}, button: 0 });
    await tick();
    expect(toasts).toEqual([
      { title: '퍼머링크를 복사하지 못했어요', description: 'https://x/dashboard/U1?session=k', tone: 'error' },
    ]);
  });
});

describe('A5 — a press on 전체 문맥 복사 copies every turn as markdown', () => {
  const MD = '# 제목\n> Owner: Zhuge\n\n## 👤 Zhuge\n\n지시\n\n---\n\n## 🤖 Assistant\n\n답\n';
  const setup = (
    responses: Array<{ status: number; body: string }>,
    session: Record<string, unknown> = { key: 'k1', conversationId: 'conv/1' },
    opts: { refreshKeepsToken?: boolean; rotateOnFirstPost?: string } = {},
  ) => {
    const calls: Array<{ url: string; init: Record<string, any> }> = [];
    const copied: string[] = [];
    const toasts: Array<Record<string, unknown>> = [];
    let refreshed = 0;
    const scope: Record<string, unknown> = {
      panelSessionKey: 'k1',
      _sessionCache: { k1: session },
      _csrfToken: 'tok-1',
      fetch: (url: string, init: Record<string, any>) => {
        calls.push({ url, init });
        // Another request's /auth/me refresh lands while this post is in flight.
        if (calls.length === 1 && opts.rotateOnFirstPost) scope._csrfToken = opts.rotateOnFirstPost;
        const r = responses.shift() ?? { status: 500, body: '' };
        return Promise.resolve({
          ok: r.status >= 200 && r.status < 300,
          status: r.status,
          text: () => Promise.resolve(r.body),
          json: () => Promise.resolve(JSON.parse(r.body)),
          clone() {
            return this;
          },
        });
      },
      // refreshCsrfToken swallows a failed /auth/me and leaves the token as it was.
      refreshCsrfToken: () => {
        refreshed++;
        if (!opts.refreshKeepsToken) scope._csrfToken = 'tok-2';
        return Promise.resolve();
      },
      isSiblingSession: (x: any) => !!(x?.environment && x.environment.instanceName !== 'mac-mini-dev'),
      isCsrfRejection: (status: number, data: any) => status === 403 && !!data && data.code === 'csrf_failed',
      copyToClipboard: (p: Promise<string>) =>
        Promise.resolve(p).then((t) => {
          copied.push(t);
          return true;
        }),
      dashToast: (t: Record<string, unknown>) => toasts.push(t),
    };
    // _csrfToken is read live (the refresh rewrites it): the functions see the scope object itself.
    const body = `${['panelContextExportUrl', 'fetchPanelContext', 'copyPanelContext'].map(clientFn).join('\n')}
      return { copyPanelContext: copyPanelContext };`;
    const api = new Function('__scope', `with (__scope) { ${body} }`)(scope) as {
      copyPanelContext: (btn: El) => Promise<void>;
    };
    return { api, calls, copied, toasts, refreshed: () => refreshed };
  };

  it('posts to the conversation’s export (no turnIds = every turn) with the CSRF token, copies it, says so', async () => {
    const h = setup([{ status: 200, body: MD }]);
    const btn = el({ hidden: false });
    await h.api.copyPanelContext(btn);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].url).toBe('/api/conversations/conv%2F1/export');
    expect(h.calls[0].init.method).toBe('POST');
    expect(h.calls[0].init.headers['X-CSRF-Token']).toBe('tok-1');
    expect(h.calls[0].init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(h.calls[0].init.body)).toEqual({ turnIds: [] });
    expect(h.copied).toEqual([MD]);
    expect(h.toasts).toEqual([
      { title: '전체 문맥을 복사했어요', description: '지시와 답변 전부 (마크다운)', tone: 'success' },
    ]);
    expect(btn.getAttribute('aria-busy')).toBeNull();
  });

  it('a stale CSRF token: refresh once and retry with the new one', async () => {
    const h = setup([
      { status: 403, body: JSON.stringify({ code: 'csrf_failed' }) },
      { status: 200, body: MD },
    ]);
    await h.api.copyPanelContext(el({ hidden: false }));
    expect(h.refreshed()).toBe(1);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].init.headers['X-CSRF-Token']).toBe('tok-2');
    expect(h.copied).toEqual([MD]);
  });

  it('a failed export: an error toast, nothing copied, the button free again', async () => {
    const h = setup([{ status: 500, body: '' }]);
    const btn = el({ hidden: false });
    await h.api.copyPanelContext(btn);
    expect(h.copied).toEqual([]);
    expect(h.toasts).toEqual([{ title: '전체 문맥을 복사하지 못했어요', description: 'HTTP 500', tone: 'error' }]);
    expect(btn.getAttribute('aria-busy')).toBeNull();
  });

  it('a press while one is in flight does nothing; a card without a conversation does nothing', async () => {
    const h = setup([{ status: 200, body: MD }]);
    const busy = el({ hidden: false });
    busy.setAttribute('aria-busy', 'true');
    await h.api.copyPanelContext(busy);
    expect(h.calls).toHaveLength(0);
    const none = setup([{ status: 200, body: MD }], { key: 'k1' });
    await none.api.copyPanelContext(el({ hidden: false }));
    expect(none.calls).toHaveLength(0);
    expect(none.toasts).toEqual([]);
  });

  it('a refresh that got no new token does not post the same refused token again', async () => {
    const h = setup([{ status: 403, body: JSON.stringify({ code: 'csrf_failed' }) }], undefined, {
      refreshKeepsToken: true,
    });
    await h.api.copyPanelContext(el({ hidden: false }));
    expect(h.refreshed()).toBe(1);
    expect(h.calls).toHaveLength(1);
    expect(h.toasts).toEqual([{ title: '전체 문맥을 복사하지 못했어요', description: 'HTTP 403', tone: 'error' }]);
  });

  it('the token is compared with the one the refused post carried (another refresh may have landed meanwhile)', async () => {
    const h = setup(
      [
        { status: 403, body: JSON.stringify({ code: 'csrf_failed' }) },
        { status: 200, body: MD },
      ],
      undefined,
      { refreshKeepsToken: true, rotateOnFirstPost: 'tok-B' },
    );
    await h.api.copyPanelContext(el({ hidden: false }));
    expect(h.calls).toHaveLength(2);
    expect(h.calls[0].init.headers['X-CSRF-Token']).toBe('tok-1');
    expect(h.calls[1].init.headers['X-CSRF-Token']).toBe('tok-B');
    expect(h.copied).toEqual([MD]);
  });

  it('a sibling instance’s card: nothing is posted (its conversation lives on that instance)', async () => {
    const h = setup([{ status: 200, body: MD }], {
      key: 'oudwood-dev::work:C2:1',
      conversationId: 'conv-2',
      environment: { instanceName: 'oudwood-dev' },
    });
    await h.api.copyPanelContext(el({ hidden: false }));
    expect(h.calls).toHaveLength(0);
    expect(h.copied).toEqual([]);
  });
});

describe('A6 — the clipboard', () => {
  type ClipApi = { copyToClipboard: (t: unknown, host?: unknown) => Promise<boolean> };

  it('ClipboardItem holding the pending text: write() is called in the press, before the text arrives', async () => {
    const writes: unknown[] = [];
    class ClipboardItem {
      constructor(public items: Record<string, Promise<Blob>>) {}
    }
    let resolveText: (t: string) => void = () => {};
    const pending = new Promise<string>((r) => {
      resolveText = r;
    });
    const navigator = {
      clipboard: {
        write: (items: unknown[]) => {
          writes.push(items[0]);
          return (items[0] as ClipboardItem).items['text/plain'].then(() => undefined);
        },
        writeText: vi.fn(),
      },
    };
    const { copyToClipboard } = load<ClipApi>(['copyToClipboard', 'copyViaTextarea'], {
      navigator,
      window: { ClipboardItem },
      ClipboardItem,
      Blob,
      document: {},
    });
    const done = copyToClipboard(pending);
    expect(writes).toHaveLength(1); // synchronously, inside the press
    resolveText('hello');
    await expect(done).resolves.toBe(true);
    const blob = await (writes[0] as ClipboardItem).items['text/plain'];
    expect(await blob.text()).toBe('hello');
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('write() refused (no activation, an older engine): writeText once the text is there, before the textarea', async () => {
    class ClipboardItem {
      constructor(public items: Record<string, Promise<Blob>>) {}
    }
    const writeText = vi.fn(() => Promise.resolve());
    const document = { createElement: vi.fn(), execCommand: vi.fn(() => true), body: { appendChild: vi.fn() } };
    const { copyToClipboard } = load<ClipApi>(['copyToClipboard', 'copyViaTextarea'], {
      navigator: { clipboard: { write: () => Promise.reject(new Error('NotAllowedError')), writeText } },
      window: { ClipboardItem },
      ClipboardItem,
      Blob,
      document,
    });
    await expect(copyToClipboard(Promise.resolve('late'))).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('late');
    expect(document.execCommand).not.toHaveBeenCalled();
  });

  it('no ClipboardItem: writeText once the text is there', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    const { copyToClipboard } = load<ClipApi>(['copyToClipboard', 'copyViaTextarea'], {
      navigator: { clipboard: { writeText } },
      window: {},
      ClipboardItem: undefined,
      Blob,
      document: {},
    });
    await expect(copyToClipboard(Promise.resolve('abc'))).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('abc');
  });

  it('no Clipboard API (plain http): a hidden textarea next to the pressed button and execCommand copy', async () => {
    const appended: any[] = [];
    const host = { appendChild: (n: any) => appended.push(n) };
    const ta: any = { style: {}, setAttribute: vi.fn(), select: vi.fn(), remove: vi.fn(), value: '' };
    const document = { createElement: vi.fn(() => ta), execCommand: vi.fn(() => true), body: { appendChild: vi.fn() } };
    const { copyToClipboard } = load<ClipApi>(['copyToClipboard', 'copyViaTextarea'], {
      navigator: {},
      window: {},
      ClipboardItem: undefined,
      Blob,
      document,
    });
    await expect(copyToClipboard('plain', host)).resolves.toBe(true);
    expect(appended).toEqual([ta]);
    expect(ta.value).toBe('plain');
    expect(document.execCommand).toHaveBeenCalledWith('copy');
    expect(ta.remove).toHaveBeenCalled();
    // Inside the drawer, not on <body>: a modal drawer makes everything outside it inert.
    expect(document.body.appendChild).not.toHaveBeenCalled();
  });

  it('a text that never arrives rejects (the caller says it failed)', async () => {
    const { copyToClipboard } = load<ClipApi>(['copyToClipboard', 'copyViaTextarea'], {
      navigator: { clipboard: { writeText: vi.fn(() => Promise.resolve()) } },
      window: {},
      ClipboardItem: undefined,
      Blob,
      document: {},
    });
    await expect(copyToClipboard(Promise.reject(new Error('HTTP 404')))).rejects.toThrow('HTTP 404');
  });
});

describe('A7 — every Korean string the buttons show reads in English too', () => {
  it.each([
    '퍼머링크 복사',
    '전체 문맥 복사',
    '퍼머링크를 복사했어요',
    '퍼머링크를 복사하지 못했어요',
    '전체 문맥을 복사했어요',
    '전체 문맥을 복사하지 못했어요',
    '지시와 답변 전부 (마크다운)',
    '클립보드에 쓰지 못했어요',
  ])('%s', (ko) => {
    expect(TEMPLATE).toContain(ko);
    expect(EN_PAGE[ko]).toBeTruthy();
    expect(EN_PAGE[ko]).not.toMatch(/[가-힣]/);
  });
});
