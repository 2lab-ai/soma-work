/**
 * affectUI review batch 1 → the dashboard's toasts and usage breakdown (the approval card has its
 * own suites: dashboard-affectui-agent-run-client / dashboard-permission-client). Executes the shipped
 * client code cut out of renderDashboardPage()'s template literal, cooked as the browser receives it
 * (the harness of dashboard-affectui-agent-run-client.test.ts), with injected fakes — no DOM.
 *
 *   <ui-toaster>            dashToaster / dashToast (queue until defined, actions), ui-action /
 *                           ui-dismiss, doAction (Stop / Close / Trash), ntOnLaunched (task launch)
 *   <ui-compact-breakdown>  usageBreakdownData (by model for everyone, by user for admins),
 *                           paintUsageBreakdown, the ui-change view switch
 *   the page                the module scripts, the served library files
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UI_LIB_FILE, uiLibDistDir } from '../dashboard';

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));

function cook(fragment: string): string {
  if (fragment.includes('`') || fragment.includes('${')) throw new Error('fragment is not a plain template slice');
  return new Function(`return \`${fragment}\`;`)() as string;
}
function declarationCount(name: string): number {
  const re = new RegExp(`^(?:async function|function|var|let|const) ${name.replace(/[$]/g, '\\$')}\\b`, 'gm');
  return (TEMPLATE.match(re) ?? []).length;
}
function clientFn(name: string): string {
  const n = declarationCount(name);
  if (n > 1) throw new Error(`client ${name} is declared ${n} times`);
  let start = TEMPLATE.indexOf(`\nfunction ${name}(`);
  if (start < 0) start = TEMPLATE.indexOf(`\nasync function ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = TEMPLATE.indexOf('\n}\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 2));
}
function clientVar(name: string): string {
  const m = TEMPLATE.match(new RegExp(`^(var ${name} = .*?;)(?:\\s*//.*)?$`, 'm'));
  if (!m) throw new Error(`client var ${name} not found`);
  return cook(m[1]);
}
/** A top-level `document.addEventListener('<ev>', function(e) { … });` of the page script. */
// The page's document-level listener for ev — the one whose body names `needle` when the page has several
// (D3 group 3 added <ui-choice-form>'s ui-change listener above the usage breakdown's).
function clientListener(ev: string, needle = ''): string {
  const head = `\ndocument.addEventListener('${ev}', function(e) {`;
  for (let at = TEMPLATE.indexOf(head); at >= 0; at = TEMPLATE.indexOf(head, at + 1)) {
    const src = TEMPLATE.slice(at + 1, TEMPLATE.indexOf('\n});', at) + 4);
    if (src.includes(needle)) return cook(src);
  }
  throw new Error(`listener ${ev} (${needle}) not found`);
}
function load<T>(fns: string[], vars: string[], inject: Record<string, unknown> = {}, extra: string[] = []): T {
  const names = Object.keys(inject);
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\n${extra.join('\n')}\nreturn { ${fns.join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}
const PAGE = cook(TEMPLATE.slice(TEMPLATE.indexOf('<body'), TEMPLATE.indexOf('<script>', TEMPLATE.indexOf('<body'))));
const HEAD = TEMPLATE.slice(0, TEMPLATE.indexOf('<style>'));

type Listener = (e: unknown) => void;
type Toast = { title: string; description?: string; tone?: string; action?: { id: string; label?: string } } & Record<
  string,
  unknown
>;

/** A fake page for the toaster: one body, getElementById, createElement, the document's listeners. */
function toastPage(opts: { defined?: boolean } = {}) {
  const byId: Record<string, any> = {};
  const listeners: Record<string, Listener[]> = {};
  const shown: Toast[] = [];
  let whenDefined: (() => void) | null = null;
  const make = (tag: string) => {
    const el: any = {
      tagName: tag.toUpperCase(),
      attrs: {} as Record<string, string>,
      style: {},
      kids: [] as any[],
      className: '',
      setAttribute(k: string, v: string) {
        this.attrs[k] = v;
      },
      appendChild(k: any) {
        this.kids.push(k);
        if (k.id) byId[k.id] = k;
        for (const g of k.kids ?? []) if (g.id) byId[g.id] = g;
        return k;
      },
    };
    let id = '';
    Object.defineProperty(el, 'id', {
      get: () => id,
      set: (v: string) => {
        id = v;
      },
    });
    return el;
  };
  const body = make('body');
  const define = (t: any) => {
    t.show = (input: Toast) => {
      shown.push(input);
      return `t${shown.length}`;
    };
  };
  const document = {
    body,
    getElementById: (id: string) => byId[id] ?? null,
    createElement: (tag: string) => {
      const el = make(tag);
      if (tag === 'ui-toaster' && opts.defined !== false) define(el);
      return el;
    },
    addEventListener: (ev: string, fn: Listener) => (listeners[ev] ??= []).push(fn),
  };
  const customElements = {
    whenDefined: (tag: string) =>
      new Promise<void>((resolve) => {
        if (tag === 'ui-toaster') whenDefined = resolve;
      }),
  };
  const m = load<{
    dashToaster(): any;
    dashToast(input: Toast, onAction?: (actionId: string) => void): string;
  }>(
    ['dashToaster', 'dashToast'],
    ['_dashToastQ', '_dashToastAct'],
    { document, window: { customElements }, customElements },
    [clientListener('ui-action'), clientListener('ui-dismiss')],
  );
  const fire = (ev: string, target: unknown, detail: unknown) => {
    for (const fn of listeners[ev] ?? []) fn({ target, detail });
  };
  return {
    m,
    body,
    shown,
    fire,
    toaster: () => byId['dash-toaster'],
    async upgrade() {
      define(byId['dash-toaster']);
      whenDefined?.();
      await Promise.resolve();
    },
  };
}

describe('<ui-toaster> — one page stack for what an action did', () => {
  it('the toaster: one <ui-toaster lang="ko" id="dash-toaster"> in a token wrapper (.ui-tok, display: contents), made once', () => {
    const p = toastPage();
    const t = p.m.dashToaster();
    expect(t.tagName).toBe('UI-TOASTER');
    expect(t.id).toBe('dash-toaster');
    expect(t.attrs.lang).toBe('ko');
    expect(p.body.kids).toHaveLength(1);
    const wrap = p.body.kids[0];
    expect(wrap.className).toBe('ui-tok');
    expect(wrap.style.display).toBe('contents');
    expect(p.m.dashToaster()).toBe(t);
    expect(p.body.kids).toHaveLength(1);
  });

  it('dashToast shows the input as given; its action runs the callback with the action id; a dismissed toast forgets it', () => {
    const p = toastPage();
    const acted: string[] = [];
    const id = p.m.dashToast({ title: '중지 실패', tone: 'error', action: { id: 'retry' } }, (a) => acted.push(a));
    expect(id).toBe('t1');
    expect(p.shown).toEqual([{ title: '중지 실패', tone: 'error', action: { id: 'retry' } }]);
    // Another element's ui-action is not the toaster's.
    p.fire('ui-action', { id: 'usage-cb' }, { id: 't1', actionId: 'retry' });
    expect(acted).toEqual([]);
    p.fire('ui-action', p.toaster(), { id: 't1', actionId: 'retry' });
    expect(acted).toEqual(['retry']);
    p.fire('ui-dismiss', p.toaster(), { id: 't1' });
    p.fire('ui-action', p.toaster(), { id: 't1', actionId: 'retry' });
    expect(acted).toEqual(['retry']);
  });

  it('before the library module has run, toasts wait and show in order once <ui-toaster> is defined', async () => {
    const p = toastPage({ defined: false });
    const acted: string[] = [];
    expect(p.m.dashToast({ title: 'a' })).toBe('');
    p.m.dashToast({ title: 'b', action: { id: 'open' } }, (x) => acted.push(x));
    expect(p.shown).toEqual([]);
    await p.upgrade();
    expect(p.shown.map((t) => t.title)).toEqual(['a', 'b']);
    p.fire('ui-action', p.toaster(), { id: 't2', actionId: 'open' });
    expect(acted).toEqual(['open']);
  });

  it('the page script calls no alert() and keeps no one-off toast of its own', () => {
    expect(TEMPLATE).not.toMatch(/\balert\(/);
    // The new-task launch's own toast (#nt-toast, its CSS and keyframes, ntShowToast) is gone for good.
    expect(PAGE).not.toContain('nt-toast');
    expect(TEMPLATE).not.toMatch(/\.nt-toast\b|nt-toast-in|ntShowToast|_ntLastLaunch|_ntToastTimer/);
  });
});

describe('doAction — Stop / Close / Trash say how they went (they failed silently before)', () => {
  function rig(res: { ok: boolean; status: number } | Error) {
    const toasts: Array<[Toast, ((a: string) => void) | undefined]> = [];
    const calls: string[] = [];
    const fetchImpl = async (url: string) => {
      calls.push(url);
      if (res instanceof Error) throw res;
      return res;
    };
    const m = load<{ doAction(k: string, a: string): Promise<void> }>(['doAction'], ['DA_LABEL', 'DA_DONE'], {
      fetch: fetchImpl,
      dashToast: (t: Toast, fn?: (a: string) => void) => toasts.push([t, fn]),
      isBusy: () => false,
      setBusy: () => {},
      refreshCard: () => {},
      renderPanelHead: () => {},
      loadSessions: () => {},
      refreshCsrfToken: async () => {},
      panelOpen: false,
      panelSessionKey: null,
      _csrfToken: 'c',
      _sessionCache: { k1: { key: 'k1', title: '배포 작업' } },
      console: { error() {} },
    });
    return { run: (a: string) => m.doAction('k1', a), toasts, calls };
  }

  it('success: a success toast naming the session', async () => {
    const r = rig({ ok: true, status: 200 });
    await r.run('stop');
    expect(r.toasts.map((t) => t[0])).toEqual([
      { title: '세션을 중지했어요', description: '배포 작업', tone: 'success' },
    ]);
  });

  it('a refusal or a network error: an error toast with Retry, which runs the same action again', async () => {
    const r = rig({ ok: false, status: 500 });
    await r.run('trash');
    expect(r.toasts[0][0]).toEqual({
      title: '휴지통으로 이동 실패',
      description: 'HTTP 500 · 배포 작업',
      tone: 'error',
      action: { id: 'retry' },
    });
    expect(r.calls).toEqual(['/api/dashboard/session/k1/trash']);
    await r.toasts[0][1]?.('retry');
    expect(r.calls).toEqual(['/api/dashboard/session/k1/trash', '/api/dashboard/session/k1/trash']);
    const n = rig(new Error('offline'));
    await n.run('close');
    expect(n.toasts[0][0]).toMatchObject({ title: '닫기 실패', description: '네트워크 오류', tone: 'error' });
  });
});

describe('ntOnLaunched — a launched task is a toast with 카드 열기 and the Slack link', () => {
  function launch() {
    const toasts: Array<[Toast, (() => void) | undefined]> = [];
    const opened: unknown[] = [];
    const cleared: number[] = [];
    const m = load<{ ntOnLaunched(d: unknown): void }>(['ntOnLaunched', 'ntLaunchToast', 'ntStateAfterLaunch'], [], {
      dashToast: (t: Toast, fn?: () => void) => toasts.push([t, fn]),
      ntOpenLaunched: (d: unknown) => opened.push(d),
      _ntRequestId: '',
      ntNewRequestId: () => 'r2',
      // D2: the next task starts clean — <ui-composer id="nt-composer"> is cleared (text, files, recording).
      ntEl: (id: string) => (id === 'nt-composer' ? { clear: () => cleared.push(1) } : null),
      _ntValue: null,
      _ntState: {},
      ntDefaultState: () => ({}),
      _ntCtx: { channels: [{ id: 'C1', name: 'dev' }] },
      localStorage: { removeItem() {} },
      NT_DRAFT_KEY: 'k',
      ntSetStatus: () => {},
      ntRender: () => {},
      closeNewTask: () => {},
      loadSessions: () => {},
      setTimeout: () => 0,
    });
    return { run: m.ntOnLaunched, toasts, opened, cleared };
  }

  it('running vs queued, the channel name, the card action, the link only when there is one, 12 s on screen', () => {
    const l = launch();
    const first = { status: 'running', channel: 'C1', permalink: 'https://slack.test/p1', sessionKey: 'k1' };
    const second = { status: 'queued', channel: 'C9', sessionKey: 'k2' };
    l.run(first);
    l.run(second);
    expect(l.cleared).toHaveLength(2);
    expect(l.toasts.map((t) => t[0])).toEqual([
      {
        title: '작업을 시작했어요',
        description: '#dev',
        tone: 'success',
        action: { id: 'open', label: '카드 열기' },
        duration: 12000,
        link: { label: 'Slack에서 보기', href: 'https://slack.test/p1' },
      },
      {
        title: '작업을 접수했어요',
        description: '#C9',
        tone: 'success',
        action: { id: 'open', label: '카드 열기' },
        duration: 12000,
      },
    ]);
    // Each toast's 카드 열기 opens its own launch, not the latest one.
    l.toasts[0][1]?.();
    expect(l.opened).toEqual([first]);
    expect(clientFn('ntOpenLaunched')).toContain('var key = launch && launch.sessionKey;');
  });

  // #640 R1 (astra P2): a dashboard task created but not started keeps its instruction —
  // the composer is not cleared (its text) and the toast says so.
  it('a dashboard task that did not start keeps the composer and says why', () => {
    const l = launch();
    l.run({ sessionKey: 'task:x', status: 'not-started', reason: 'busy' });
    expect(l.cleared).toHaveLength(0);
    expect(l.toasts[0][0]).toMatchObject({ title: '작업을 만들었지만 아직 시작하지 못했어요', tone: 'warning' });
    l.run({ sessionKey: 'task:y', status: 'running' });
    expect(l.cleared).toHaveLength(1);
    expect(l.toasts[1][0]).toMatchObject({ title: '대시보드 작업을 시작했어요' });
  });
});

describe('<ui-compact-breakdown> — where the usage goes: by model for everyone, by user for admins', () => {
  const REPORT = {
    totals: {
      totalCostUsd: 3.5,
      byModel: {
        'claude-opus-5-5': { inputTokens: 1000, outputTokens: 200, costUsd: 3 },
        'claude-haiku-4': { inputTokens: 5000, outputTokens: 100, costUsd: 0.5 },
      },
    },
    byUser: { U1: { userName: 'Zhuge', totalCostUsd: 2.5 }, U2: { totalCostUsd: 1 } },
  };
  const data = load<{ usageBreakdownData(r: unknown, view: string, admin: boolean): Record<string, any> }>(
    ['toNum', 'usageBreakdownData'],
    ['USAGE_VIEWS'],
  ).usageBreakdownData;

  it('everyone: spend or tokens by model, with the view switch (cost · tokens)', () => {
    const cost = data(REPORT, 'cost', false);
    expect(cost).toEqual({
      title: '사용량',
      unit: 'usd',
      options: [
        { id: 'cost', label: '모델별 비용' },
        { id: 'tokens', label: '모델별 토큰' },
      ],
      value: 'cost',
      optionsLabel: '보기',
      maxRows: 5,
      parts: [
        { key: 'claude-opus-5-5', label: 'claude-opus-5-5', value: 3 },
        { key: 'claude-haiku-4', label: 'claude-haiku-4', value: 0.5 },
      ],
      emptyText: '이 기간에는 사용량이 없어요',
    });
    const tokens = data(REPORT, 'tokens', false);
    expect(tokens.unit).toBe('tokens');
    expect(tokens.parts.map((p: { value: number }) => p.value)).toEqual([1200, 5100]);
  });

  it('a non-admin never gets the by-user view, even asked for it; an admin gets spend by user', () => {
    const asked = data(REPORT, 'user', false);
    expect(asked.value).toBe('cost');
    expect(asked.options.map((o: { id: string }) => o.id)).toEqual(['cost', 'tokens']);
    expect(asked.parts[0].key).toBe('claude-opus-5-5');
    const admin = data(REPORT, 'user', true);
    expect(admin.options.map((o: { id: string }) => o.id)).toEqual(['cost', 'tokens', 'user']);
    expect(admin.unit).toBe('usd');
    expect(admin.parts).toEqual([
      { key: 'U1', label: 'Zhuge', value: 2.5 },
      { key: 'U2', label: 'U2', value: 1 },
    ]);
    // What the server strips for a non-admin (byUser {}) reads as an empty breakdown, not an error.
    expect(data({ ...REPORT, byUser: {} }, 'user', true).parts).toEqual([]);
  });

  it('no report: the error line; an empty period: no parts (the element says emptyText)', () => {
    expect(data(null, 'cost', false).error).toBe('사용량을 불러오지 못했어요');
    expect(data({ totals: { byModel: {} } }, 'cost', false).parts).toEqual([]);
  });

  it('paintUsageBreakdown sets the data only when it changed; the view switch (ui-change on #usage-cb) repaints; the admin flag repaints', () => {
    const el: Record<string, unknown> = { id: 'usage-cb' };
    let sets = 0;
    Object.defineProperty(el, 'data', {
      get: () => undefined,
      set: () => {
        sets++;
      },
    });
    const listeners: Record<string, Listener> = {};
    const env: Record<string, unknown> = {
      document: {
        getElementById: (id: string) => (id === 'usage-cb' ? el : null),
        addEventListener: (ev: string, fn: Listener) => (listeners[ev] = fn),
      },
      _viewerIsAdmin: false,
      setStripFigure: () => {}, // 토큰 · 비용 go to <ui-stat-strip> (D2)
      paintStatsStrip: () => {},
      formatTokens: String,
    };
    const m = load<{ paintUsage(r: unknown): void; paintUsageBreakdown(): void }>(
      ['toNum', 'usageBreakdownData', 'paintUsageBreakdown', 'paintUsage'],
      ['_usageView', '_usageReport', 'USAGE_VIEWS'],
      env,
      [clientListener('ui-change', 'usage-cb')],
    );
    m.paintUsage(REPORT);
    m.paintUsage(REPORT);
    expect(sets).toBe(1);
    listeners['ui-change']({ target: el, detail: { value: 'tokens' } });
    expect(sets).toBe(2);
    listeners['ui-change']({ target: { id: 'other' }, detail: { value: 'cost' } });
    expect(sets).toBe(2);
    expect(clientFn('_applyUserPill')).toContain('paintUsageBreakdown();');
  });

  it('the page: the breakdown in the stats detail, in a token wrapper', () => {
    const detail = PAGE.slice(PAGE.indexOf('<div class="stats-detail" id="stats-detail">'));
    expect(
      detail.indexOf(
        '<div class="ui-tok usage-cb-wrap"><ui-compact-breakdown id="usage-cb" lang="ko"></ui-compact-breakdown></div>',
      ),
    ).toBeGreaterThan(0);
    expect(detail.indexOf('usage-cb')).toBeLessThan(detail.indexOf('id="stats-grid"'));
  });
});

describe('the batch-1 elements are served from the dashboard origin', () => {
  it('the page loads each element as a module script next to tool-call-card.js', () => {
    for (const f of ['tool-call-card', 'approval-card', 'toaster', 'compact-breakdown'])
      expect(HEAD).toContain(`<script type="module" src="/dashboard/ui/${f}.js?v=\${UI_LIB_VERSION}"></script>`);
  });

  it('the installed @2lab.ai/ui carries each element file and its chunks (flat names the route serves)', () => {
    const dir = uiLibDistDir();
    expect(dir).toBeTruthy();
    for (const f of ['approval-card.js', 'toaster.js', 'compact-breakdown.js']) {
      expect(existsSync(join(dir as string, f)), f).toBe(true);
      const imports = readFileSync(join(dir as string, f), 'utf-8').match(/from\s*"\.\/([^"]+)"/g) ?? [];
      for (const imp of imports) {
        const file = /"\.\/([^"]+)"/.exec(imp)?.[1] as string;
        expect(UI_LIB_FILE.test(file), file).toBe(true);
        expect(existsSync(join(dir as string, file)), file).toBe(true);
      }
    }
  });
});
