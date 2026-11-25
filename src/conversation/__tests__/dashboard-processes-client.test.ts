/**
 * The 프로세스 tab and the card's CPU · 메모리 chip — executed from the shipped client code (cut out of
 * renderDashboardPage()'s template literal, as dashboard-detail-zones-client.test.ts does).
 *
 *   P1  the card's foot: no CPU · 메모리 chip any more — the node badge in the head is the one place (2026-11-25)
 *   P2  the tab bar: 프로세스 right of 세부 with the process count; disabled while none lives
 *   P3  the tab: node line, totals, one row per process in tree order; pause · resume only for a manager
 *   P4  the page: the tab's panel exists and its content shows only while the tab is open
 *   P6  the tree: htop guides, folds with subtree totals, CPU levels (≥10% busy, ≥100% hot), where · what per row
 *   P7  the detail: a row opens one process's snapshot (read once, never polled) in a dialog
 *   P8  the card's node badge (@2lab.ai/ui 0.46.0 card.node): the node's name, this task's CPU · memory gauges, no number
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_PRESETS, CARD_CHIPS, DETAIL_TABS, normalizeFace, resolveLayouts } from '../../view-layout';
import { viewerScope } from '../__fixtures__/viewer-scope';
import { VIEW_LAYOUT_CLIENT_JS } from '../view-layout-client';

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));

function cook(fragment: string): string {
  if (fragment.includes('`') || fragment.includes('${')) throw new Error('fragment is not a plain template slice');
  return new Function(`return \`${fragment}\`;`)() as string;
}
function clientFn(name: string): string {
  let start = TEMPLATE.indexOf(`\nfunction ${name}(`);
  if (start < 0) start = TEMPLATE.indexOf(`\nasync function ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = TEMPLATE.indexOf('\n}\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 2));
}
function clientVar(name: string): string {
  const one = TEMPLATE.match(new RegExp(`^(var ${name} = .*?;)(?:\\s*//.*)?$`, 'm'));
  if (!one) throw new Error(`client var ${name} not found`);
  return cook(one[1]);
}
function load<T>(fns: string[], vars: string[], inject: Record<string, unknown> = {}): T {
  ({ fns, inject } = viewerScope(fns, inject));
  const all: Record<string, unknown> = { VIEW_BUILTINS: BUILTIN_PRESETS, ...inject };
  const names = Object.keys(all);
  const setter = '__set: function(n, v) { eval(n + " = v"); }';
  const getter = '__get: function(n) { return eval(n); }';
  const body = `${VIEW_LAYOUT_CLIENT_JS}\n${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')}, faceFootMetrics: faceFootMetrics, ${setter}, ${getter} };`;
  return new Function(...names, body)(...names.map((n) => all[n])) as T;
}
/** The tab's renderer and the pure helpers it calls. */
const TAB_FNS = [
  'toNum',
  'esc',
  'escAttr',
  'procCpuLevel',
  'procCpuCellHtml',
  'procMemCellHtml',
  'procCwdText',
  'procTreeRows',
  'panelProcsHtml',
];
const PAGE = cook(TEMPLATE.slice(TEMPLATE.indexOf('<body'), TEMPLATE.indexOf('<script>', TEMPLATE.indexOf('<body'))));
const CSS = cook(
  TEMPLATE.slice(TEMPLATE.indexOf('<style>'), TEMPLATE.indexOf('</style>', TEMPLATE.indexOf('<style>'))),
);

const usage = (over: Record<string, unknown> = {}) => ({
  nodeId: 'n1',
  cpuCount: 12,
  rootAlive: true,
  processCount: 6,
  stoppedCount: 0,
  cpuPercent: 42.4,
  rssBytes: 1.23e9,
  ...over,
});

type Chip = { text: string; title: string; label?: string; tone?: string } | null;

describe('P1 — the card’s foot has no CPU · 메모리 chip', () => {
  const env = () => load<{ faceFootMetrics: (...a: unknown[]) => Chip[] }>([], []);

  it('the catalog, every built-in face and a saved layout leave it out; a device copy that still has it draws nothing', () => {
    expect(CARD_CHIPS as readonly string[]).not.toContain('proc');
    for (const id of ['1', '2', '3'] as const) {
      for (const mode of ['minimal', 'advanced'] as const) {
        const foot = resolveLayouts(undefined, mode, id).card.foot;
        expect(
          foot.map((c) => c.id),
          `${id}/${mode}`,
        ).not.toContain('proc');
      }
    }
    // A layout saved while the chip existed: the chip goes, the rest keeps its order and state.
    const fb = resolveLayouts(undefined, 'minimal', '1').card;
    const saved = normalizeFace(
      {
        foot: [
          { id: 'cost', on: true },
          { id: 'proc', on: true },
          { id: 'model', on: false },
        ],
      },
      fb,
    ).foot;
    expect(saved.map((c) => c.id)).not.toContain('proc');
    expect(saved.filter((c) => c.id === 'cost' || c.id === 'model')).toEqual([
      { id: 'cost', on: true },
      { id: 'model', on: false },
    ]);
    expect(env().faceFootMetrics({ procUsage: usage() }, '', [{ id: 'proc', on: true }], '', false)).toEqual([]);
  });

  it('cardOf still hands the session’s usage to the face (the node badge reads it)', () => {
    const src = clientFn('cardOf');
    expect(src).toContain('if (s.procUsage) card.procUsage = s.procUsage;');
  });
});

describe('P2 — the tab bar: 프로세스 right of 세부', () => {
  type Tab = { id: string; label: string; count: string; title: string; empty: boolean };
  const env = () =>
    load<{ panelMidTabsOf: (s: unknown, tabs: string[], c: unknown) => Tab[] }>(
      ['toNum', 'panelMidTabsOf'],
      ['MID_TAB_LABEL'],
    );

  it('is in the catalog right after 세부 and on in both modes', () => {
    expect(DETAIL_TABS.indexOf('procs')).toBe(DETAIL_TABS.indexOf('info') + 1);
    for (const mode of ['minimal', 'advanced'] as const) {
      const tabs = resolveLayouts(undefined, mode, '1').detail.tabs;
      expect(tabs.find((t) => t.id === 'procs')?.on).toBe(true);
      const ids = tabs.map((t) => t.id);
      expect(ids.indexOf('procs')).toBeGreaterThan(ids.indexOf('info'));
    }
  });

  it('counts the live processes; a session with none has the tab disabled', () => {
    const [live] = env().panelMidTabsOf({ procUsage: usage() }, ['procs'], {});
    expect(live).toMatchObject({ id: 'procs', label: '프로세스', count: '6', empty: false });
    expect(live.title).toBe('프로세스 6개 · CPU 42% · 메모리 1.2GB');
    const [none] = env().panelMidTabsOf({}, ['procs'], {});
    expect(none).toMatchObject({ count: '', empty: true, title: '살아 있는 프로세스 없음' });
  });
});

describe('P3 — the tab’s content', () => {
  const env = () =>
    load<{
      panelProcsHtml: (st: unknown, canControl: boolean) => string;
      procsFailText: (s: number, c?: string) => string;
    }>([...TAB_FNS, 'procsFailText'], ['PROC_STATE_LABEL']);
  const body = {
    node: { nodeId: 'n1', cpuCount: 12, cpuBusyPercent: 23, totalMemBytes: 64e9, availableMemBytes: 40e9 },
    session: {
      processCount: 3,
      stoppedCount: 1,
      cpuPercent: 55,
      rssBytes: 1.5e9,
      rootAlive: true,
      processes: [
        {
          pid: 200,
          depth: 0,
          role: 'root',
          state: 'running',
          cpuPercent: 50,
          rssBytes: 1e9,
          name: 'claude',
          command: 'claude --model …',
          startToken: 'Mon Nov 23 10:00:00 2026',
        },
        {
          pid: 300,
          depth: 1,
          role: 'child',
          state: 'stopped',
          cpuPercent: 0,
          rssBytes: 4e6,
          name: 'bash',
          command: 'bash -c npm test',
          startToken: 'Mon Nov 23 10:01:00 2026',
        },
        {
          pid: 400,
          depth: 2,
          role: 'orphan',
          state: 'zombie',
          cpuPercent: 5,
          rssBytes: 0,
          name: 'node <x>',
          command: '<script>',
          startToken: 'Mon Nov 23 10:02:00 2026',
        },
      ],
    },
  };

  it('a manager gets 일시중지 on a running process and 재개 on a paused one, each with the pid and its start time', () => {
    const html = env().panelProcsHtml({ status: 200, body, busy: {} }, true);
    expect(html).toContain('노드 <b>n1</b>');
    expect(html).toContain('코어 12개');
    expect(html).toContain('여유 메모리 40GB / 64GB');
    expect(html).toContain('프로세스 3개');
    expect(html).toContain('일시중지 1개');
    expect(html).toContain('data-proc-op="pause" data-pid="200" data-start="Mon Nov 23 10:00:00 2026"');
    expect(html).toContain('data-proc-op="resume" data-pid="300" data-start="Mon Nov 23 10:01:00 2026"');
    // The Claude Code process itself: its button warns the whole task stops.
    expect(html).toContain('이 작업 전체가 멈춰요');
    // A zombie has nothing to pause.
    expect(html).not.toContain('data-pid="400"');
    // Tree order, each child under its parent with the tree's guide.
    expect(html.indexOf('>claude<')).toBeLessThan(html.indexOf('>bash<'));
    expect(html).toContain('<span class="pp-guide" aria-hidden="true">└─</span>');
  });

  it('a worker with a nickname: the node line reads it, the node id in its title, markup kept as text', () => {
    const named = { ...body, node: { ...body.node, name: '<m5 "a">' } };
    const html = env().panelProcsHtml({ status: 200, body: named, busy: {} }, true);
    expect(html).toContain('노드 <b title="n1">&lt;m5 &quot;a&quot;&gt;</b>');
    // '노드 ' stays its own literal, the one the page catalog translates (review of #1431: '노드 <b' had no entry).
    const catalog = JSON.parse(
      readFileSync(
        join(__dirname, '..', '..', '..', 'packages', 'common', 'src', 'i18n-catalog', 'en-page.json'),
        'utf8',
      ),
    );
    expect(catalog['노드 ']).toBe('Node ');
    expect(TEMPLATE).toContain("nodeBits.push('노드 ' + (node.name ?");
  });

  it('a reader sees the same table with no buttons', () => {
    const html = env().panelProcsHtml({ status: 200, body, busy: {} }, false);
    expect(html).toContain('>bash<');
    expect(html).not.toContain('data-proc-op');
  });

  it('escapes what a process names itself', () => {
    const html = env().panelProcsHtml({ status: 200, body, busy: {} }, true);
    expect(html).not.toContain('<script>');
    expect(html).toContain('node &lt;x&gt;');
  });

  it('a busy row’s button is disabled', () => {
    const html = env().panelProcsHtml({ status: 200, body, busy: { 300: true } }, true);
    expect(html).toMatch(/data-pid="300"[^>]*disabled/);
  });

  it('says why there is no table: loading, none alive, another instance, the monitor off, a failed read', () => {
    const e = env();
    expect(e.panelProcsHtml({ status: 0, body: null }, true)).toContain('읽는 중');
    expect(e.panelProcsHtml({ status: 200, body: { node: body.node, session: null } }, true)).toContain(
      '지금 이 작업의 프로세스는 없어요',
    );
    expect(e.panelProcsHtml({ status: 409 }, true)).toContain('다른 soma-work 인스턴스');
    expect(e.panelProcsHtml({ status: 503 }, true)).toContain('프로세스 모니터가 꺼져 있어요');
    expect(e.panelProcsHtml({ status: -1 }, true)).toContain('연결 오류');
  });

  it('a refused pause reads in the reader’s words', () => {
    const e = env();
    expect(e.procsFailText(409, 'stale')).toContain('프로세스가 바뀌었어요');
    expect(e.procsFailText(404, 'not-found')).toContain('이미 끝났어요');
    expect(e.procsFailText(403)).toContain('작업 소유자나 관리자 모드');
  });
});

describe('P4 — the page', () => {
  it('has the tab’s panel after 세부, shown only while 프로세스 is open', () => {
    expect(PAGE.indexOf('id="panel-procs"')).toBeGreaterThan(PAGE.indexOf('id="panel-info"'));
    expect(CSS).toContain('.slide-panel:not([data-midtab="procs"]) #panel-procs,');
  });

  it('opening the tab paints it; the poll stops itself once the tab or the card closes', () => {
    expect(clientFn('selectPanelMid')).toContain("else if (_panelMid === 'procs') renderPanelProcs();");
    const render = clientFn('renderPanelProcs');
    expect(render).toContain("if (_panelMid !== 'procs' || !panelSessionKey) {");
    expect(render).toContain('clearInterval(_procs.timer);');
  });
});

describe('P5 — executed: the tab polls while open and stops when closed; reads and pauses recover', () => {
  type Env = {
    renderPanelProcs(): void;
    procsControl(op: string, pid: number, start: string): Promise<void>;
    __set(n: string, v: unknown): void;
    __get(n: string): any;
  };
  type Call = { url: string; init?: any };
  const ok = (body: unknown, status = 200) => Promise.resolve({ status, ok: status < 300, json: async () => body });
  const BODY = { node: { nodeId: 'n1', cpuCount: 8 }, session: null };

  function env(answer: (c: Call) => Promise<unknown>) {
    const calls: Call[] = [];
    const toasts: Array<{ title: string }> = [];
    const el = { _wired: false, addEventListener: () => {} };
    const holder: { e?: Env } = {};
    const e = load<Env>(
      [...TAB_FNS, 'procsFailText', 'paintPanelProcs', 'procsFetch', 'procsControl', 'renderPanelProcs'],
      ['PROCS_POLL_MS', 'PROCS_READ_TIMEOUT_MS', 'PROCS_CONTROL_TIMEOUT_MS', '_procs', 'PROC_STATE_LABEL'],
      {
        document: { getElementById: () => el, hidden: false },
        fetch: (url: string, init?: any) => {
          const c = { url, init };
          calls.push(c);
          return answer(c);
        },
        writePanelPart: () => {},
        isSiblingSession: () => false,
        dashToast: (t: { title: string }) => toasts.push(t),
        refreshCsrfToken: async () => holder.e?.__set('_csrfToken', 'fresh'),
        _panelMid: 'procs',
        panelSessionKey: 'k1',
        _sessionCache: { k1: { ownerId: 'U1' }, k2: { ownerId: 'U1' } },
        _csrfToken: 'old',
        currentUserId: 'U1',
      },
    );
    holder.e = e;
    return { e, calls, toasts };
  }
  const gets = (calls: Call[]) => calls.filter((c) => !c.init || !c.init.method);
  afterEach(() => vi.useRealTimers());

  it('reads on open, every 3 s while open; closing stops it; reopening starts exactly one poller', async () => {
    vi.useFakeTimers();
    const { e, calls } = env(() => ok(BODY));
    e.renderPanelProcs();
    await vi.advanceTimersByTimeAsync(0);
    expect(gets(calls)).toHaveLength(1);
    expect(calls[0].url).toBe('/api/dashboard/session/k1/processes');
    await vi.advanceTimersByTimeAsync(6_000);
    expect(gets(calls)).toHaveLength(3);
    e.__set('_panelMid', '');
    await vi.advanceTimersByTimeAsync(9_000);
    expect(gets(calls)).toHaveLength(3);
    e.__set('_panelMid', 'procs');
    e.renderPanelProcs();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(gets(calls)).toHaveLength(5);
  });

  it('a read still pending for one card is aborted when the tab moves to another card, and does not block it', async () => {
    vi.useFakeTimers();
    const { e, calls } = env((c) =>
      c.url.includes('/k1/')
        ? new Promise((_r, reject) => c.init.signal.addEventListener('abort', () => reject(new Error('aborted'))))
        : ok(BODY),
    );
    e.renderPanelProcs();
    e.__set('panelSessionKey', 'k2');
    e.renderPanelProcs();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls[0].init.signal.aborted).toBe(true);
    expect(calls[1].url).toBe('/api/dashboard/session/k2/processes');
    expect(e.__get('_procs').status).toBe(200);
  });

  it('a read that never answers is given up after 10 s; the next poll reads again', async () => {
    vi.useFakeTimers();
    let first = true;
    const { e, calls } = env((c) => {
      if (first) {
        first = false;
        return new Promise((_r, reject) => c.init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
      }
      return ok(BODY);
    });
    e.renderPanelProcs();
    await vi.advanceTimersByTimeAsync(9_000);
    expect(gets(calls)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(gets(calls).length).toBeGreaterThanOrEqual(2);
    expect(e.__get('_procs').pending).toBeNull();
  });

  it('pause: the pid and start time go to the route; a stale CSRF token is refreshed and sent once more, only once', async () => {
    const posts: Call[] = [];
    const { e, toasts } = env((c) => {
      if (!c.init?.method) return ok(BODY);
      posts.push(c);
      return ok({ ok: false }, 403);
    });
    e.__set('_procs', { key: 'k 1', status: 0, body: null, pending: null, again: false, busy: {}, timer: 0 });
    await e.procsControl('pause', 300, 'Mon Nov 23 10:00:00 2026');
    expect(posts).toHaveLength(2);
    expect(posts[0].url).toBe('/api/dashboard/session/k%201/processes/300/pause');
    expect(JSON.parse(posts[0].init.body)).toEqual({ startToken: 'Mon Nov 23 10:00:00 2026' });
    expect(posts[0].init.headers['X-CSRF-Token']).toBe('old');
    expect(posts[1].init.headers['X-CSRF-Token']).toBe('fresh');
    expect(toasts[toasts.length - 1]?.title).toBe('일시중지하지 못했어요');
    expect(e.__get('_procs').busy[300]).toBeUndefined();
  });

  it('a pause that never answers frees its button after 15 s and reads the list instead of sending it again', async () => {
    vi.useFakeTimers();
    const posts: Call[] = [];
    const { e, calls, toasts } = env((c) => {
      if (!c.init?.method) return ok(BODY);
      posts.push(c);
      return new Promise((_r, reject) => c.init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    });
    e.__set('_procs', { key: 'k1', status: 0, body: null, pending: null, again: false, busy: {}, timer: 0 });
    const done = e.procsControl('resume', 300, 'Mon Nov 23 10:00:00 2026');
    expect(e.__get('_procs').busy[300]).toBe(true);
    await vi.advanceTimersByTimeAsync(15_000);
    await done;
    expect(posts).toHaveLength(1);
    expect(e.__get('_procs').busy[300]).toBeUndefined();
    expect(toasts[toasts.length - 1]?.title).toBe('요청을 보내지 못했어요');
    expect(gets(calls)).toHaveLength(1);
  });
});

describe('P6 — the tree: guides, folds, CPU levels, where · what', () => {
  type Row = {
    p: { pid: number };
    guide: string;
    kids: number;
    folded: boolean;
    sub?: { count: number; cpu: number; rss: number };
  };
  const env = () =>
    load<{
      procTreeRows: (l: unknown[], c?: Record<string, boolean>) => Row[];
      procCpuLevel: (p: number) => string;
      procCpuCellHtml: (p: number, total?: boolean) => string;
      procCwdText: (c: string, b: string) => string;
      panelProcsHtml: (st: unknown, canControl: boolean) => string;
    }>(TAB_FNS, ['PROC_STATE_LABEL']);
  const S = 'Mon Nov 23 10:00:00 2026';
  const p = (pid: number, depth: number, extra: Record<string, unknown> = {}) => ({
    pid,
    depth,
    role: depth === 0 ? 'root' : 'child',
    state: 'sleeping',
    cpuPercent: 0,
    rssBytes: 1e6,
    name: `p${pid}`,
    command: '',
    cwd: '',
    startToken: S,
    ...extra,
  });
  // claude 1 ─┬ bash 2 ─┬ node 3
  //           │         └ node 4
  //           └ tsc 5
  const tree = [p(1, 0), p(2, 1), p(3, 2), p(4, 2), p(5, 1)];

  it('draws htop’s guides: ├─ for a child with a later sibling, └─ for the last, │ for an open rail above', () => {
    expect(
      env()
        .procTreeRows(tree)
        .map((r) => [r.p.pid, r.guide, r.kids]),
    ).toEqual([
      [1, '', 4],
      [2, '├─', 2],
      [3, '│ ├─', 0],
      [4, '│ └─', 0],
      [5, '└─', 0],
    ]);
  });

  it('a folded parent hides its subtree and carries its totals (itself included)', () => {
    const rows = env().procTreeRows(
      [
        p(1, 0),
        p(2, 1, { cpuPercent: 5, rssBytes: 1e6 }),
        p(3, 2, { cpuPercent: 120, rssBytes: 2e9 }),
        p(4, 2),
        p(5, 1),
      ],
      { [`2:${S}`]: true },
    );
    expect(rows.map((r) => r.p.pid)).toEqual([1, 2, 5]);
    expect(rows[1]).toMatchObject({ folded: true, kids: 2, sub: { count: 2, cpu: 125, rss: 1e6 + 2e9 + 1e6 } });
  });

  it('CPU levels: under 1% idle, 10% busy, 100% hot — hot says ▲ and its cores in words, not by colour only', () => {
    const e = env();
    expect([0, 0.5, 1, 9.9, 10, 99, 100, 250].map(e.procCpuLevel)).toEqual([
      'idle',
      'idle',
      '',
      '',
      'busy',
      'busy',
      'hot',
      'hot',
    ]);
    const hot = e.procCpuCellHtml(113);
    expect(hot).toContain('is-hot');
    expect(hot).toContain('▲ 113%');
    expect(hot).toContain('1.1코어');
    expect(hot).toContain('width:100%');
    expect(e.procCpuCellHtml(42)).toContain('is-busy');
    expect(e.procCpuCellHtml(42)).toContain('width:42%');
    expect(e.procCpuCellHtml(42)).not.toContain('▲');
    expect(e.procCpuCellHtml(125, true)).toContain('Σ 125%');
  });

  it('a working directory reads relative to the Claude Code process’s folder, else by its last two parts', () => {
    const e = env();
    expect(e.procCwdText('/work/repo', '/work/repo')).toBe('.');
    expect(e.procCwdText('/work/repo/packages/ui', '/work/repo')).toBe('./packages/ui');
    expect(e.procCwdText('/Users/z/other/place/deep', '/work/repo')).toBe('…/place/deep');
    expect(e.procCwdText('/tmp', '/work/repo')).toBe('/tmp');
    expect(e.procCwdText('', '/work/repo')).toBe('');
  });

  it('the table: where and what under each row (owner view), the hot row marked, rows open the snapshot', () => {
    const body = {
      node: { nodeId: 'n1' },
      commands: true,
      session: {
        processCount: 3,
        cpuPercent: 160,
        rssBytes: 4e9,
        rootAlive: true,
        processes: [
          p(1, 0, { name: 'claude', cwd: '/work/repo', command: 'claude --model …', cpuPercent: 40 }),
          p(2, 1, {
            name: 'node tsc',
            cwd: '/work/repo/packages/a',
            command: 'npx tsc …',
            cpuPercent: 113,
            rssBytes: 3e9,
          }),
          p(3, 1, { name: 'git', cwd: '/work/repo', command: 'git status …' }),
        ],
      },
    };
    const html = env().panelProcsHtml({ status: 200, body, busy: {}, collapsed: {} }, true);
    expect(html).toContain('<span class="pp-cpu-sum is-hot">CPU 160%</span>');
    expect(html).toMatch(/<tr class="pp-row is-hot can-open" data-proc-row="2"/);
    expect(html).toContain('title="작업 폴더: /work/repo/packages/a">./packages/a</span>');
    expect(html).toContain('<span class="pp-cmd" title="npx tsc …">npx tsc …</span>');
    expect(html).toContain(`data-proc-open="2" data-start="${S}"`);
    // The root's own folder is shown by its last two parts (its children read relative to it).
    expect(html).toContain('title="작업 폴더: /work/repo">/work/repo</span>');
    // A fold toggle on the parent, with its count.
    expect(html).toContain('data-proc-fold="1"');
    expect(html).toContain('하위 프로세스 2개 접기');
    // A reader who does not see commands: no opener, no where · what rows (the server blanked them).
    const reader = env().panelProcsHtml(
      {
        status: 200,
        body: {
          ...body,
          commands: false,
          session: { ...body.session, processes: body.session.processes.map((x) => ({ ...x, cwd: '', command: '' })) },
        },
        busy: {},
      },
      false,
    );
    expect(reader).not.toContain('data-proc-open');
    expect(reader).not.toContain('can-open');
    expect(reader).not.toContain('pp-where');
    expect(reader).not.toContain('class="pp-cmd"');
    // Its PID and state still read under the row.
    expect(reader).toContain('<span class="pp-pid">2</span><span class="pp-st">대기</span>');
  });

  it('the CSS colours busy amber and hot red, and gives hot rows a tint and a rail', () => {
    expect(CSS).toContain('.pp-cpu.is-busy .pp-v, .pp-cpu-sum.is-busy { color: color-mix(in srgb, var(--st-wait)');
    expect(CSS).toContain('.pp-cpu.is-hot .pp-v, .pp-cpu-sum.is-hot { color: color-mix(in srgb, var(--st-fail)');
    expect(CSS).toContain('.pp-table tr.pp-row.is-hot td { background:');
  });

  it('in high contrast every meter is one solid system colour — the busy and hot rules do not outrank it', () => {
    const forced = CSS.slice(CSS.indexOf('@media (forced-colors: active) {\n  .pp-bar'));
    const rule = forced.slice(0, forced.indexOf('}') + 1);
    for (const sel of ['.pp-bar > i', '.pp-cpu.is-busy .pp-bar > i', '.pp-cpu.is-hot .pp-bar > i']) {
      expect(rule).toContain(sel);
    }
    expect(rule).toContain('background: CanvasText;');
  });
});

describe('P7 — the detail: one process’s snapshot, read once', () => {
  type Env = {
    procsOpenDetail(pid: number, start: string): void;
    procDetailRetake(): void;
    procDetailHtml(st: unknown): string;
    procDetailFailText(s: number, c?: string): string;
    __get(n: string): any;
  };
  const S = 'Mon Nov 23 10:00:00 2026';
  const detail = {
    pid: 2,
    ppid: 1,
    pgid: 1,
    name: 'node tsc',
    role: 'child',
    state: 'running',
    stat: 'R+',
    cpuPercent: 113,
    exe: '/opt/homebrew/bin/node',
    commandLine: 'node /work/repo/node_modules/.bin/tsc --token ••• -p tsconfig.json',
    argvExact: false,
    cwd: '/work/repo',
    user: 'z',
    uid: 501,
    startedAt: new Date(2026, 10, 23, 10, 0, 0).getTime(),
    elapsedSeconds: 125,
    cpuSeconds: 61.5,
    psCpuPercent: 98,
    priority: 31,
    nice: 0,
    threads: 7,
    rssBytes: 3e9,
    memPercent: 4.5,
    vszBytes: 4e11,
    peakRssBytes: null,
    contextSwitches: null,
    io: null,
    fdCount: 14,
    fdByType: { REG: 3, IPv4: 1 },
    files: [{ fd: '5', type: 'REG', name: '/work/repo/tsconfig.json' }],
    filesTruncated: false,
    sockets: [{ fd: '12', proto: 'TCP', local: '*:8764', remote: '', state: 'LISTEN' }],
    socketsTruncated: false,
    ancestors: [{ pid: 1, name: 'claude' }],
    children: [{ pid: 3, name: 'esbuild', cpuPercent: 12, rssBytes: 5e7 }],
    subtree: { processCount: 2, cpuPercent: 125, rssBytes: 3.05e9 },
    takenAt: 1,
    nodeId: 'n1',
    unreadable: ['threads'],
  };

  function env(answer: (url: string, init?: { signal?: AbortSignal }) => Promise<unknown>) {
    const calls: string[] = [];
    const dlg = {
      shown: 0,
      hasAttribute: () => false,
      show() {
        this.shown++;
      },
    };
    const el = { _html: '' };
    const when = { _text: '' };
    const e = load<Env>(
      [
        ...TAB_FNS,
        'procSecondsText',
        'procClockText',
        'procDetailFailText',
        'procDetailHtml',
        'paintProcDetail',
        'procsOpenDetail',
        'procDetailRetake',
      ],
      ['PROC_STATE_LABEL', 'PROCS_CONTROL_TIMEOUT_MS', '_procs', '_procDetail'],
      {
        document: {
          getElementById: (id: string) =>
            id === 'proc-detail-dialog'
              ? dlg
              : id === 'proc-detail-body'
                ? el
                : id === 'proc-detail-when'
                  ? when
                  : null,
        },
        fetch: (url: string, init?: { signal?: AbortSignal }) => {
          calls.push(url);
          return answer(url, init);
        },
        writePanelPart: (target: { _html: string }, html: string) => {
          target._html = html;
        },
        setTextIfChanged: (target: { _text: string }, text: string) => {
          target._text = text;
        },
      },
    );
    return { e, calls, dlg, el, when };
  }

  it('a row’s open reads the process once, with its start time, and paints the dialog — no timer re-reads it', async () => {
    vi.useFakeTimers();
    try {
      const { e, calls, dlg, el } = env(() =>
        Promise.resolve({ status: 200, json: async () => ({ ok: true, detail }) }),
      );
      e.__get('_procs').key = 'C1:t1';
      e.procsOpenDetail(2, S);
      expect(dlg.shown).toBe(1);
      expect(el._html).toContain('읽는 중');
      await vi.runAllTimersAsync();
      expect(calls).toEqual([
        `/api/dashboard/session/${encodeURIComponent('C1:t1')}/processes/2/detail?start=${encodeURIComponent(S)}`,
      ]);
      expect(el._html).toContain('/opt/homebrew/bin/node');
      // Nothing polls the snapshot.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('다시 찍기 reads the same process of the same task once more and repaints — even after the tab moved on', async () => {
    let n = 0;
    const later = { ...detail, cwd: '/work/repo/packages/a', takenAt: new Date(2026, 10, 23, 10, 5, 7).getTime() };
    const { e, calls, el, when } = env(() => {
      n++;
      return Promise.resolve({ status: 200, json: async () => ({ ok: true, detail: n === 1 ? detail : later }) });
    });
    e.__get('_procs').key = 'C1:t1';
    e.procsOpenDetail(2, S);
    await new Promise((r) => setTimeout(r, 0));
    expect(el._html).not.toContain('/work/repo/packages/a');
    // The tab now shows another task; the open snapshot is still the first task's process.
    e.__get('_procs').key = 'C9:t9';
    e.procDetailRetake();
    await new Promise((r) => setTimeout(r, 0));
    const url = `/api/dashboard/session/${encodeURIComponent('C1:t1')}/processes/2/detail?start=${encodeURIComponent(S)}`;
    expect(calls).toEqual([url, url]);
    expect(el._html).toContain('/work/repo/packages/a');
    expect(when._text).toContain('10:05:07');
    expect(when._text).toContain('자동으로 새로 고치지 않아요');
  });

  it('a slow answer for the process opened first never replaces the snapshot of the one opened after it', async () => {
    const pending = new Map<string, (v: unknown) => void>();
    const { e, el } = env(
      (url) =>
        new Promise((resolve) => {
          pending.set(/\/processes\/(\d+)\//.exec(url)?.[1] ?? '', resolve);
        }),
    );
    e.__get('_procs').key = 'C1:t1';
    const b = { ...detail, pid: 3, exe: '/usr/bin/esbuild', takenAt: 2 };
    e.procsOpenDetail(2, S);
    e.procsOpenDetail(3, S);
    pending.get('3')?.({ status: 200, json: async () => ({ ok: true, detail: b }) });
    await new Promise((r) => setTimeout(r, 0));
    expect(el._html).toContain('/usr/bin/esbuild');
    pending.get('2')?.({ status: 200, json: async () => ({ ok: true, detail }) });
    await new Promise((r) => setTimeout(r, 0));
    const shown = e.__get('_procDetail');
    expect(shown.pid).toBe(3);
    expect(shown.body.pid).toBe(3);
    expect(shown.body.takenAt).toBe(2);
    expect(el._html).toContain('/usr/bin/esbuild');
    expect(el._html).not.toContain('/opt/homebrew/bin/node');
  });

  it('while the tab polls the list every 3 s, the open snapshot is never read again nor repainted', async () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      const panel = { _wired: false, _html: '', addEventListener: () => {} };
      const body = { _html: '' };
      const dlg = { hasAttribute: () => false, show() {} };
      const when = { _text: '' };
      // The list the tab polls carries the open process itself, changing every read.
      let polls = 0;
      const listNow = () => {
        polls++;
        const proc = (pid: number, depth: number, extra: Record<string, unknown>) => ({
          pid,
          depth,
          role: depth === 0 ? 'root' : 'child',
          state: 'running',
          rssBytes: 1e8 * polls,
          name: pid === 2 ? 'node tsc' : 'claude',
          command: '',
          startToken: S,
          ...extra,
        });
        return {
          node: { nodeId: 'n1' },
          commands: true,
          session: {
            processCount: 2,
            stoppedCount: 0,
            cpuPercent: 10 * polls,
            rssBytes: 2e8 * polls,
            rootAlive: true,
            processes: [
              proc(1, 0, { cpuPercent: 1, cwd: '/work/repo' }),
              proc(2, 1, { cpuPercent: 37 * polls, cwd: `/work/repo/pkg-${polls}` }),
            ],
          },
        };
      };
      const e = load<Env & { renderPanelProcs(): void }>(
        [
          ...TAB_FNS,
          'procsFailText',
          'paintPanelProcs',
          'procsFetch',
          'renderPanelProcs',
          'procSecondsText',
          'procClockText',
          'procDetailFailText',
          'procDetailHtml',
          'paintProcDetail',
          'procsOpenDetail',
        ],
        [
          'PROCS_POLL_MS',
          'PROCS_READ_TIMEOUT_MS',
          'PROCS_CONTROL_TIMEOUT_MS',
          '_procs',
          '_procDetail',
          'PROC_STATE_LABEL',
        ],
        {
          document: {
            hidden: false,
            getElementById: (id: string) =>
              id === 'panel-procs'
                ? panel
                : id === 'proc-detail-body'
                  ? body
                  : id === 'proc-detail-dialog'
                    ? dlg
                    : id === 'proc-detail-when'
                      ? when
                      : null,
          },
          fetch: (url: string) => {
            calls.push(url);
            const json = url.includes('/detail?') ? { ok: true, detail } : listNow();
            return Promise.resolve({ status: 200, ok: true, json: async () => json });
          },
          writePanelPart: (el: { _html: string }, html: string) => {
            el._html = html;
          },
          setTextIfChanged: (el: { _text: string }, text: string) => {
            el._text = text;
          },
          isSiblingSession: () => false,
          viewerCanManage: () => true,
          _panelMid: 'procs',
          panelSessionKey: 'k1',
          _sessionCache: { k1: { ownerId: 'U1' } },
        },
      );
      e.renderPanelProcs();
      await vi.advanceTimersByTimeAsync(100);
      e.procsOpenDetail(2, S);
      await vi.advanceTimersByTimeAsync(100);
      const first = body._html;
      const footer = when._text;
      expect(first).toContain('/opt/homebrew/bin/node');
      expect(footer).toContain('자동으로 새로 고치지 않아요');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(calls.filter((u) => u.includes('/detail?'))).toHaveLength(1);
      expect(calls.filter((u) => u.endsWith('/processes')).length).toBeGreaterThanOrEqual(3);
      // The table moved on with the live reads (the open process's own row included); the snapshot did not.
      expect(polls).toBeGreaterThanOrEqual(3);
      expect(panel._html).toContain(`pkg-${polls}`);
      expect(body._html).toBe(first);
      expect(body._html).not.toContain('pkg-');
      expect(when._text).toBe(footer);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a click on a row or its name opens that row’s process; a fold or pause click inside the row does not', () => {
    const calls: string[] = [];
    let onClick: ((ev: unknown) => void) | null = null;
    const panel = {
      _wired: false,
      _html: '',
      addEventListener: (_type: string, fn: (ev: unknown) => void) => {
        onClick = fn;
      },
    };
    const control = vi.fn();
    const e = load<Env & { renderPanelProcs(): void }>(
      [
        ...TAB_FNS,
        'procsFailText',
        'paintPanelProcs',
        'procsFetch',
        'renderPanelProcs',
        'procSecondsText',
        'procClockText',
        'procDetailFailText',
        'procDetailHtml',
        'paintProcDetail',
        'procsOpenDetail',
      ],
      [
        'PROCS_POLL_MS',
        'PROCS_READ_TIMEOUT_MS',
        'PROCS_CONTROL_TIMEOUT_MS',
        '_procs',
        '_procDetail',
        'PROC_STATE_LABEL',
      ],
      {
        document: {
          hidden: false,
          getElementById: (id: string) =>
            id === 'panel-procs'
              ? panel
              : id === 'proc-detail-body'
                ? { _html: '' }
                : id === 'proc-detail-dialog'
                  ? { hasAttribute: () => false, show() {} }
                  : null,
        },
        fetch: (url: string) => {
          calls.push(url);
          return new Promise(() => {});
        },
        writePanelPart: () => {},
        setTextIfChanged: () => {},
        isSiblingSession: () => false,
        viewerCanManage: () => true,
        procsControl: control,
        _panelMid: 'procs',
        panelSessionKey: 'k1',
        _sessionCache: { k1: { ownerId: 'U1' } },
      },
    );
    e.renderPanelProcs();
    const node = (attrs: Record<string, string>) => ({
      disabled: false,
      getAttribute: (n: string) => attrs[n] ?? null,
    });
    const click = (hits: Record<string, ReturnType<typeof node>>) =>
      (onClick as unknown as (ev: unknown) => void)({ target: { closest: (sel: string) => hits[sel] ?? null } });
    const details = () => calls.filter((u) => u.includes('/detail?'));
    const row3 = node({ 'data-proc-row': '3', 'data-start': 'T3' });
    // The name's button.
    click({ '[data-proc-open]': node({ 'data-proc-open': '2', 'data-start': S }) });
    expect(details()).toEqual([`/api/dashboard/session/k1/processes/2/detail?start=${encodeURIComponent(S)}`]);
    // Anywhere else on an openable row.
    click({ 'tr.can-open': row3 });
    expect(details()[1]).toBe('/api/dashboard/session/k1/processes/3/detail?start=T3');
    // A fold inside that row folds, and opens nothing.
    click({ '[data-proc-fold]': node({ 'data-proc-fold': '3', 'data-start': 'T3' }), 'tr.can-open': row3 });
    expect(details()).toHaveLength(2);
    expect(e.__get('_procs').collapsed['3:T3']).toBe(true);
    // A pause inside it pauses, and opens nothing.
    click({
      '[data-proc-op]': node({ 'data-proc-op': 'pause', 'data-pid': '3', 'data-start': 'T3' }),
      'tr.can-open': row3,
    });
    expect(details()).toHaveLength(2);
    expect(control).toHaveBeenCalledWith('pause', 3, 'T3');
  });

  it('a body that never arrives after the headers is given up too — read as no answer, not as an HTTP 200', async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      const { e, el } = env((_url, init) => {
        n++;
        if (n === 1) {
          // The headers came in time; the body read is aborted by the timeout.
          return Promise.resolve({
            status: 200,
            json: () =>
              new Promise((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
              }),
          });
        }
        return Promise.resolve({ status: 200, json: async () => ({ ok: true, detail }) });
      });
      e.__get('_procs').key = 'C1:t1';
      e.procsOpenDetail(2, S);
      await vi.advanceTimersByTimeAsync(e.__get('PROCS_CONTROL_TIMEOUT_MS'));
      expect(e.__get('_procDetail').status).toBe(-1);
      expect(el._html).toContain('답하지 않았어요');
      e.procDetailRetake();
      await vi.advanceTimersByTimeAsync(100);
      expect(el._html).toContain('/opt/homebrew/bin/node');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a read that never answers is given up after its timeout and says so; 다시 찍기 then shows the snapshot', async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      const { e, el, calls } = env((_url, init) => {
        n++;
        // The first read hangs until its signal aborts, as fetch does.
        if (n === 1) {
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          });
        }
        return Promise.resolve({ status: 200, json: async () => ({ ok: true, detail }) });
      });
      e.__get('_procs').key = 'C1:t1';
      e.procsOpenDetail(2, S);
      await vi.advanceTimersByTimeAsync(100);
      expect(el._html).toContain('읽는 중');
      await vi.advanceTimersByTimeAsync(e.__get('PROCS_CONTROL_TIMEOUT_MS'));
      expect(el._html).not.toContain('읽는 중');
      expect(el._html).toContain('답하지 않았어요');
      e.procDetailRetake();
      await vi.advanceTimersByTimeAsync(100);
      expect(calls).toHaveLength(2);
      expect(el._html).toContain('/opt/homebrew/bin/node');
    } finally {
      vi.useRealTimers();
    }
  });

  it('the body: image, performance, subtree, files and sockets — the masked command line and its hint', () => {
    const { e } = env(() => new Promise(() => {}));
    const html = e.procDetailHtml({ pid: 2, status: 200, body: detail });
    for (const want of [
      '실행 파일',
      '<code class="px-mono">/opt/homebrew/bin/node</code>',
      '--token ••• -p tsconfig.json',
      '비밀 값(토큰 · 비밀번호 · 인증 헤더 · JSON 설정)은 •••로 가렸어요',
      '인자 경계는 보이지 않아요',
      '<code class="px-mono">/work/repo</code>',
      'uid 501',
      '2026-11-23 10:00:00',
      '2분 5초 전',
      '부모 1',
      'claude <span class="pi-muted">1</span>',
      '▲ CPU 113%',
      '1분 2초',
      '스레드',
      '3.0GB',
      '이 프로세스와 그 아래 2개 · CPU 125%',
      'esbuild',
      '디스크립터 14개',
      'REG 3 · IPv4 1',
      '*:8764',
      'LISTEN',
      '/work/repo/tsconfig.json',
      '운영체제가 주지 않은 항목: threads',
    ]) {
      expect(html, want).toContain(want);
    }
  });

  it('a refusal reads in the reader’s words; nothing open draws nothing', () => {
    const { e } = env(() => new Promise(() => {}));
    expect(e.procDetailHtml({ pid: 0 })).toBe('');
    expect(e.procDetailHtml({ pid: 2, status: 200, body: { ...detail, fdScanPartial: true } })).toContain(
      '디스크립터가 많아 앞의 일부만 살펴봤어요',
    );
    expect(e.procDetailHtml({ pid: 2, status: 0 })).toContain('읽는 중');
    expect(e.procDetailHtml({ pid: 2, status: 409, code: 'stale' })).toContain('다른 프로세스가 됐어요');
    expect(e.procDetailFailText(403)).toContain('작업 소유자와 관리자만');
    expect(e.procDetailFailText(404, 'not-found')).toContain('이미 끝났어요');
    expect(e.procDetailFailText(501, 'unsupported')).toContain('읽을 수 없어요');
    expect(e.procDetailFailText(-1)).toContain('답하지 않았어요');
  });

  it('the page has the dialog, its footer says it is a snapshot, and 다시 찍기 reads again on purpose', () => {
    expect(PAGE).toContain(
      '<ui-dialog id="proc-detail-dialog" class="proc-detail-dialog" heading="프로세스 상세" size="lg" lang="ko">',
    );
    expect(PAGE).toContain('onclick="procDetailRetake()"');
    expect(clientFn('paintProcDetail')).toContain('기준 — 자동으로 새로 고치지 않아요');
    expect(clientFn('renderPanelProcs')).toContain("t.closest('[data-proc-open]') || t.closest('tr.can-open')");
  });
});

describe('P8 — the card’s node badge (card.node)', () => {
  type Node = {
    text: string;
    title: string;
    cpu?: number;
    mem?: number;
    load?: number;
    level?: string;
    label?: string;
  } | null;
  // 18 cores, 137 GB: one core's share of the memory is 7.6 GB.
  const u = (over: Record<string, unknown> = {}) =>
    usage({ nodeId: 'build-box.local', cpuCount: 18, nodeMemBytes: 137e9, cpuPercent: 113, rssBytes: 3.3e9, ...over });
  const fns = () =>
    new Function('VIEW_BUILTINS', `${VIEW_LAYOUT_CLIENT_JS}\nreturn { nodeBadgeOf: nodeBadgeOf, faceOf: faceOf };`)(
      BUILTIN_PRESETS,
    ) as { nodeBadgeOf: (u: unknown) => Node; faceOf: (...a: unknown[]) => Record<string, unknown> };

  it('names the node; its two gauges are this task’s CPU (full at one core) and memory (full at one core’s share)', () => {
    const b = fns().nodeBadgeOf(u()) as NonNullable<Node>;
    expect(b.text).toBe('build-box');
    expect(b.cpu).toBe(100);
    expect(b.mem).toBeCloseTo((3.3e9 / (137e9 / 18)) * 100, 6);
    // No number before the name: the level alone — over one core is hot (a red ring), from 10% busy.
    expect(b).not.toHaveProperty('load');
    expect(b.level).toBe('hot');
    expect(fns().nodeBadgeOf(u({ cpuPercent: 42.4 }))).toMatchObject({ cpu: 42.4, level: 'busy' });
    expect(fns().nodeBadgeOf(u({ cpuPercent: 0.7 }))).toMatchObject({ cpu: 0.7, level: '' });
    // Said in words, never as the node's load.
    expect(b.label).toBe('노드 build-box.local, 이 작업 CPU 113%, 메모리 3.3GB');
    expect(b.title).toContain('노드 build-box.local · 코어 18개 · 메모리 137GB');
    expect(b.title).toContain('이 작업 CPU 113% — 계급장 가득 = 100% (코어 1개)');
    expect(b.title).toContain('메모리 3.3GB — 계급장 가득 = 7.6GB (노드 메모리 ÷ 코어 수)');
    expect(b.title).not.toContain('노드 CPU');
  });

  it('a worker with a nickname (settings 작업 워커): the badge reads it; the node id stays in the label and title', () => {
    const b = fns().nodeBadgeOf(u({ nodeName: 'm5' })) as NonNullable<Node>;
    expect(b.text).toBe('m5');
    expect(b.label).toBe('노드 m5 (build-box.local), 이 작업 CPU 113%, 메모리 3.3GB');
    expect(b.title).toContain('노드 m5 (build-box.local) · 코어 18개');
    // A nickname is shown as set (no host-part cut at a dot), at most 12 characters like any name.
    expect(fns().nodeBadgeOf(u({ nodeName: 'rack.2' }))?.text).toBe('rack.2');
    expect(fns().nodeBadgeOf(u({ nodeName: 'a-very-long-nickname' }))?.text).toBe('a-very-long…');
    // Cut by characters: twelve emoji never leave half a surrogate pair before the ellipsis.
    const emoji = fns().nodeBadgeOf(u({ nodeName: '🖥'.repeat(13) }))?.text ?? '';
    expect(emoji).toBe(`${'🖥'.repeat(11)}…`);
  });

  it('no memory gauge without the node’s size; none at all while nothing of the task lives', () => {
    const f = fns();
    const old = f.nodeBadgeOf(u({ nodeMemBytes: undefined })) as NonNullable<Node>;
    expect(old.mem).toBeUndefined();
    expect(old.title).toContain('메모리 3.3GB');
    expect(f.nodeBadgeOf(u({ nodeId: 'a-very-long-node-name' }))?.text).toBe('a-very-long…');
    expect(f.nodeBadgeOf(undefined)).toBeNull();
    expect(f.nodeBadgeOf(u({ processCount: 0 }))).toBeNull();
    // On every face (one-line cards too: the element draws it in the head); none without a live process.
    expect(f.faceOf({ title: 'x', procUsage: u() }, '', { rows: [], foot: [] }).node).toMatchObject({
      text: 'build-box',
    });
    expect(f.faceOf({ title: 'x' }, '', { rows: [], foot: [] }).node).toBeUndefined();
  });

  it('a paused process and the CPU cap are in its title', () => {
    const b = fns().nodeBadgeOf(u({ stoppedCount: 2, cpuCapPercent: 100, throttling: true })) as NonNullable<Node>;
    expect(b.title).toContain('일시중지 2개');
    expect(b.title).toContain('CPU 한도 100% — 넘어서 맞추는 중');
    expect((fns().nodeBadgeOf(u()) as NonNullable<Node>).title).not.toContain('CPU 한도');
  });
});

describe('P9 — the CPU cap on the task', () => {
  it('the tab says the cap, and while it holds the tree; a held row is tagged 한도, not 일시중지', () => {
    const e = load<{ panelProcsHtml: (st: unknown, c: boolean) => string }>(TAB_FNS, ['PROC_STATE_LABEL']);
    const p = (pid: number, depth: number, extra: Record<string, unknown> = {}) => ({
      pid,
      depth,
      role: depth === 0 ? 'root' : 'child',
      state: 'running',
      cpuPercent: 0,
      rssBytes: 1e6,
      name: `p${pid}`,
      startToken: 'S',
      ...extra,
    });
    const body = (throttling: boolean) => ({
      node: { nodeId: 'n1' },
      session: {
        processCount: 2,
        cpuPercent: 98,
        rssBytes: 2e6,
        rootAlive: true,
        cpuCapPercent: 100,
        throttling,
        processes: [p(1, 0), p(2, 1, { cpuPercent: 95, throttled: throttling })],
      },
    });
    const on = e.panelProcsHtml({ status: 200, body: body(true), busy: {} }, true);
    expect(on).toContain('CPU 한도 100% · 맞추는 중</span>');
    expect(on).toContain('<span class="pp-cap is-on"');
    expect(on).toContain('>한도</span>');
    expect(on).not.toContain('일시중지 1개');
    const off = e.panelProcsHtml({ status: 200, body: body(false), busy: {} }, true);
    expect(off).toContain('CPU 한도 100%</span>');
    expect(off).not.toContain('>한도</span>');
  });
});
