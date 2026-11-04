/**
 * The detail card's zones (SSOT 2026-11-03) — executed from the shipped client code cut out of
 * renderDashboardPage()'s template literal (the harness of dashboard-view-plan-client.test.ts):
 *
 *   ┌ title bar   [실행 중] 🕐 1시간 17분 | ● Opus 5.5 | $175 | 235.1M 토큰 | 97 tok/s   Slack ☆ 중지
 *   ├ 입력 필요    approvals · the question · a plan — its own zone, never in a tab
 *   ├ tab bar     목표 2/5 · 작업 1/7 · 에이전트 5 · 산출물 3 · 세부 — every tab closed until pressed
 *   └ bottom      대화 · 작업 로그 (+ 에이전트 트리) and the composer
 *
 *   Z1  the title bar's items after the time are the layout's (detail.head), in its order, each only when known
 *   Z2  the tab bar's tabs are the layout's (detail.tabs) with their counts; empty ones are disabled
 *   Z3  every tab starts closed; a press opens one (its content only then), a second press closes it
 *   Z4  an opening lands on its tab (a goal → 목표, a task → 작업, an agent → 에이전트), else none
 *   Z5  the page: 입력 필요 → the tab bar → the tabs' content; what needs the user is never behind a tab
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BUILTIN_PRESETS } from '../../view-layout';
import { viewerScope } from '../__fixtures__/viewer-scope';
import { VIEW_LAYOUT_CLIENT_JS } from '../view-layout-client';

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));

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
  const body = `${VIEW_LAYOUT_CLIENT_JS}\n${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\nreturn { ${[...fns, setter, getter].join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => all[n])) as T;
}
const PAGE = cook(TEMPLATE.slice(TEMPLATE.indexOf('<body'), TEMPLATE.indexOf('<script>', TEMPLATE.indexOf('<body'))));
const CSS = cook(
  TEMPLATE.slice(TEMPLATE.indexOf('<style>'), TEMPLATE.indexOf('</style>', TEMPLATE.indexOf('<style>'))),
);

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const session = (over: Record<string, unknown> = {}) => ({
  key: 'k1',
  model: 'claude-opus-5-5[1m]',
  ownerName: 'Zhuge',
  workflow: 'zwork',
  activityState: 'working',
  activeAccumulatedMs: 60 * MIN,
  activeLegStartedAtMs: NOW - 17 * MIN,
  sessionOutputTokens: 452_000,
  tokenUsage: {
    totalInputTokens: 1_000_000,
    totalOutputTokens: 452_000,
    totalCacheReadTokens: 233_000_000,
    totalCacheCreateTokens: 648_000,
    totalCostUsd: 175.4,
    contextUsagePercent: 72,
  },
  ...over,
});

describe('Z1 — the title bar: the layout’s items after the time, in its order', () => {
  type M = { id: string; text: string; title: string; tone?: string; mark?: string };
  const env = () =>
    load<{
      panelHeadMetricsOf(s: unknown, col: string, head: string[], now: number): M[];
      panelHeadMetricsHtml(list: M[]): string;
    }>(
      [
        'toNum',
        'esc',
        'escAttr',
        'formatTokens',
        'cardTotalTokens',
        'ctxLevel',
        'ctxPercent',
        'panelActiveMs',
        'panelHeadMetricsOf',
        'panelHeadMetricsHtml',
      ],
      ['PS_SPEED_MIN_MS'],
      {
        rootStatusOf: (s: { activityState: string }) => (s.activityState === 'working' ? 'running' : 'idle'),
        REPRESENTATIVE_MODELS: [{ model: 'claude-opus-5-5[1m]', label: 'Opus 5.5' }],
        PS_MAX_LEG_MS: 30 * MIN,
      },
    );

  it('"● Opus 5.5 | $175 | 235.1M 토큰 | 97 tok/s" — the model, the cost, the tokens and the speed (the built-in head)', () => {
    const m = env().panelHeadMetricsOf(session(), 'working', ['model', 'cost', 'tokens', 'speed'], NOW);
    expect(m.map((x) => x.text)).toEqual(['Opus 5.5', '$175', '235.1M 토큰', '98 tok/s']);
    // The model in its maker's colour, its id in the tooltip; the speed says how it is counted.
    expect(m[0].mark).toBe('#d97757');
    expect(m[0].title).toBe('Opus 5.5\nclaude-opus-5-5[1m]');
    expect(m[3].title).toBe('속도 — 출력 토큰 ÷ 활성 시간 (서브에이전트 · 도구 실행 포함)');
  });

  it('the speed is the output tokens over every turn’s active time — this one’s so far included', () => {
    const e = env();
    // 452,000 output tokens over 60 + 17 minutes of work = 97.8 tok/s.
    expect(e.panelHeadMetricsOf(session(), 'working', ['speed'], NOW)[0].text).toBe('98 tok/s');
    // Idle: the open leg is not counted (the accumulated time is the whole run).
    expect(e.panelHeadMetricsOf(session({ activityState: 'idle' }), 'done', ['speed'], NOW)[0].text).toBe('126 tok/s');
    // Slow work keeps a decimal; under a minute of work there is no speed yet.
    const slow = session({ sessionOutputTokens: 30_000 });
    expect(e.panelHeadMetricsOf(slow, 'working', ['speed'], NOW)[0].text).toBe('6.5 tok/s');
    const fresh = session({ activeAccumulatedMs: 0, activeLegStartedAtMs: NOW - 30_000 });
    expect(e.panelHeadMetricsOf(fresh, 'working', ['speed'], NOW)).toEqual([]);
  });

  it('the speed is the session’s own output over the session’s own time — /new resets both; the task total is not it (review P2)', () => {
    const e = env();
    // After /new: 60 s of work and 6,000 new output tokens, while the task total still holds 100,000 older ones.
    const renewed = session({
      activeAccumulatedMs: 60_000,
      activeLegStartedAtMs: undefined,
      activityState: 'idle',
      sessionOutputTokens: 6_000,
      tokenUsage: { ...session().tokenUsage, totalOutputTokens: 106_000 },
    });
    expect(e.panelHeadMetricsOf(renewed, 'done', ['speed'], NOW)[0].text).toBe('100 tok/s');
    // No session output known (an archived card): no speed.
    expect(e.panelHeadMetricsOf(session({ sessionOutputTokens: undefined }), 'working', ['speed'], NOW)).toEqual([]);
  });

  it('the server sends the session’s output: its usage plus the running turn’s calls; nothing when neither is known', async () => {
    const { sessionOutputTokensOf } = await import('../dashboard');
    expect(sessionOutputTokensOf({ usage: { totalOutputTokens: 4_000 } })).toBe(4_000);
    expect(
      sessionOutputTokensOf({
        usage: { totalOutputTokens: 4_000 },
        liveUsage: { 'm:a': { inputTokens: 10, outputTokens: 500, cacheReadTokens: 0, cacheCreateTokens: 0 } },
      }),
    ).toBe(4_500);
    expect(sessionOutputTokensOf({})).toBeUndefined();
  });

  it('the open turn counts up to the server’s cap on one turn — a turn whose end was never seen does not drag it down (review P1)', () => {
    const e = env();
    // 45 and 90 minutes into one open turn: it counts 30 (60 + 30 = 90 minutes → 452,000 / 5,400 s = 84 tok/s).
    for (const open of [45, 90])
      expect(
        e.panelHeadMetricsOf(session({ activeLegStartedAtMs: NOW - open * MIN }), 'working', ['speed'], NOW)[0].text,
      ).toBe('84 tok/s');
    // The page takes the cap from the server (the same constant the session's active time folds a turn with).
    expect(TEMPLATE).toContain('var PS_MAX_LEG_MS = ${DASHBOARD_MAX_LEG_MS};');
  });

  it('the old 세션 정보 line’s numbers are items too: the context (levelled), the owner, the workflow — in the layout’s order', () => {
    const m = env().panelHeadMetricsOf(session(), 'working', ['workflow', 'ctx', 'owner', 'cost'], NOW);
    expect(m.map((x) => [x.id, x.text])).toEqual([
      ['workflow', 'zwork'],
      ['ctx', '컨텍스트 72%'],
      ['owner', 'Zhuge'],
      ['cost', '$175'],
    ]);
    expect(m[1].tone).toBe('warn');
  });

  it('an item turned off, or not known, is not there; small costs read <$0.01 and $6.20', () => {
    const e = env();
    expect(e.panelHeadMetricsOf(session(), 'working', [], NOW)).toEqual([]);
    const none = session({
      model: 'unknown',
      tokenUsage: undefined,
      sessionOutputTokens: undefined,
      ownerName: '',
      workflow: '',
    });
    expect(
      e.panelHeadMetricsOf(none, 'working', ['model', 'cost', 'tokens', 'speed', 'ctx', 'owner', 'workflow'], NOW),
    ).toEqual([]);
    const cheap = (c: number) =>
      e.panelHeadMetricsOf(
        session({ tokenUsage: { ...session().tokenUsage, totalCostUsd: c } }),
        'working',
        ['cost'],
        NOW,
      )[0].text;
    expect(cheap(0.004)).toBe('<$0.01');
    expect(cheap(6.2)).toBe('$6.20');
  });

  it('the html escapes session text; the mark’s colour is the page’s own constant', () => {
    const e = env();
    const html = e.panelHeadMetricsHtml(
      e.panelHeadMetricsOf(session({ ownerName: '<b>x</b>' }), 'working', ['model', 'owner'], NOW),
    );
    expect(html).toBe(
      '<span class="ps-metrics"><span class="ps-m ps-m-model" title="Opus 5.5\nclaude-opus-5-5[1m]"><span class="ps-mk" aria-hidden="true" style="--mk:#d97757"></span>Opus 5.5</span>' +
        '<span class="ps-m ps-m-owner" title="시작한 사람">&lt;b&gt;x&lt;/b&gt;</span></span>',
    );
    expect(e.panelHeadMetricsHtml([])).toBe('');
  });

  it('the status bar’s slot carries them first, right after the time (the bar draws its slot there)', () => {
    const fn = clientFn('panelHeadNoteHtml');
    expect(fn).toContain(
      'var metrics = panelHeadMetricsHtml(panelHeadMetricsOf(s, col, viewSpec().detail.head, Date.now()));',
    );
    expect(fn).toContain('return metrics + (resume ? \'<span class="ps-resume"');
  });
});

describe('Z2 — the tab bar: the layout’s tabs with their counts', () => {
  type Tab = { id: string; label: string; count: string; title: string; empty: boolean };
  const tabsOf = (s: unknown, tabs: string[], c: Record<string, unknown>) =>
    load<{ panelMidTabsOf(s: unknown, t: string[], c: unknown): Tab[] }>(
      ['toNum', 'panelMidTabsOf'],
      ['MID_TAB_LABEL'],
    ).panelMidTabsOf(s, tabs, c);
  const goal = {
    current: { goalId: 'g2' },
    history: [{ goalId: 'g1' }],
    queue: [{ goalId: 'g3' }, { goalId: 'g4' }, { goalId: 'g5' }],
  };
  const tasks = [
    { id: 'T1', status: 'completed' },
    ...Array.from({ length: 6 }, (_, i) => ({ id: `T${i + 2}`, status: i === 0 ? 'in_progress' : 'pending' })),
  ];
  const agents = Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, n: i + 1 }));

  it('"목표 2/5 · 작업 1/7 · 에이전트 5 · 산출물 3 · 세부", in the layout’s order', () => {
    const t = tabsOf({ goal, agents }, ['goal', 'tasks', 'agents', 'artifacts', 'info'], {
      tasks,
      earlier: 0,
      artifacts: 3,
    });
    expect(t.map((x) => `${x.label} ${x.count}`.trim())).toEqual([
      '목표 2/5',
      '작업 1/7',
      '에이전트 5',
      '산출물 3',
      '세부',
    ]);
    expect(t.every((x) => !x.empty)).toBe(true);
    expect(t[0].title).toBe('목표 — 지난 1 · 지금 1 · 대기 3');
    expect(t[1].title).toBe('작업 — 완료 1 / 전체 7');
    const reordered = tabsOf({ goal, agents }, ['agents', 'goal'], { tasks });
    expect(reordered.map((x) => x.id)).toEqual(['agents', 'goal']);
  });

  it('a tab with nothing in it yet is empty — except 목표 for whoever may add one, and 세부', () => {
    const none = tabsOf({ agents: [] }, ['goal', 'tasks', 'agents', 'artifacts', 'info'], {
      tasks: [],
      earlier: 0,
      artifacts: 0,
    });
    expect(none.map((x) => [x.id, x.empty])).toEqual([
      ['goal', true],
      ['tasks', true],
      ['agents', true],
      ['artifacts', true],
      ['info', false],
    ]);
    const editable = tabsOf({}, ['goal'], { goalEditable: true, tasks: [] });
    expect(editable[0]).toMatchObject({ empty: false, count: '', title: '목표 없음 — 눌러서 추가' });
    // Only earlier plans, or work outside the list (the runs table draws it): the 작업 tab still opens on them.
    expect(tabsOf({}, ['tasks'], { tasks: [], earlier: 2 })[0].empty).toBe(false);
    expect(tabsOf({}, ['tasks'], { tasks: [], earlier: 0, outside: true })[0].empty).toBe(false);
    // An id the page does not know is no tab.
    expect(tabsOf({}, ['nope', 'info'], {}).map((x) => x.id)).toEqual(['info']);
  });
});

describe('Z3 — every tab starts closed; a press opens one, a second press closes it', () => {
  const rig = (tabs = ['goal', 'tasks', 'agents', 'artifacts', 'info']) => {
    const bar: Record<string, any> = { hidden: false, innerHTML: '', addEventListener: vi.fn() };
    const panel: Record<string, any> = {
      attrs: {} as Record<string, string>,
      setAttribute(k: string, v: string) {
        this.attrs[k] = v;
      },
    };
    const painted: string[] = [];
    const spy = (name: string) => () => painted.push(name);
    // The layout's tab list holds every tab; the ones not named are off.
    const detail = {
      ...BUILTIN_PRESETS['1'].advanced.detail,
      tabs: BUILTIN_PRESETS['1'].advanced.detail.tabs.map((t) => ({ ...t, on: tabs.includes(t.id) })),
    };
    const env = load<{
      renderPanelMidbar(): void;
      selectPanelMid(id: string): void;
      __get(n: string): any;
      __set(n: string, v: unknown): void;
    }>(
      [
        'toNum',
        'esc',
        'escAttr',
        'viewModeFrom',
        'viewPlanFrom',
        'viewSpec',
        'panelMidTabsOf',
        'panelMidContext',
        'renderPanelMidbar',
        'selectPanelMid',
      ],
      ['MID_TAB_LABEL', 'MID_TAB_PANEL', '_panelMid', '_viewMode', '_viewPlan'],
      {
        document: {
          getElementById: (id: string) => (id === 'panel-midbar' ? bar : id === 'slide-panel' ? panel : null),
        },
        _viewLayout: { v: 1, presets: { '1': { advanced: { detail } } } },
        panelSessionKey: 'k1',
        panelConvId: 'c1',
        _sessionCache: {
          k1: {
            key: 'k1',
            ownerId: 'U1',
            goal: { current: { goalId: 'g' } },
            agents: [{ id: 'a', n: 1 }],
            artifacts: { count: 2 },
          },
        },
        _artCache: {},
        _umList: {},
        // Phone chrome (SSOT 2026-11-04): a tab press starts the card over — a seam here.
        rdReset: () => {},
        currentUserId: 'U1',
        sessionColOf: () => 'working',
        isSiblingSession: () => false,
        panelAgentTasks: () => [{ id: 'T1', status: 'completed' }],
        panelAgentEarlier: () => [],
        panelAgentOutside: () => null,
        writePanelPart: (el: Record<string, string>, html: string) => {
          el.innerHTML = html;
        },
        renderPanelInfo: spy('info'),
        renderPanelGoal: spy('goal'),
        repaintPanelTasks: spy('tasks'),
        renderPanelArtifactsSection: spy('artifacts'),
        renderPanelTabs: spy('strip'),
        renderPanelAgents: spy('agenthead'),
        sizePanelSections: spy('size'),
        _panelInfoOpen: false,
        _panelTasksOpen: false,
        _panelTasksExpanded: false,
        _panelTaskLineOpen: false,
      },
    );
    env.__set('_viewMode', 'advanced');
    return { env, bar, panel, painted };
  };
  const expanded = (html: string) =>
    [...html.matchAll(/data-mid="(\w+)" aria-expanded="(true|false)"/g)].map((m) => `${m[1]}:${m[2]}`);

  it('the bar draws every tab closed: aria-expanded false, each controlling its content; nothing open on the panel', () => {
    const { env, bar, panel } = rig();
    env.renderPanelMidbar();
    expect(bar.hidden).toBe(false);
    expect(panel.attrs['data-midtab']).toBe('');
    expect(expanded(bar.innerHTML)).toEqual([
      'goal:false',
      'tasks:false',
      'agents:false',
      'artifacts:false',
      'info:false',
    ]);
    expect(bar.innerHTML).toContain('aria-controls="panel-goal"');
    expect(bar.innerHTML).toContain('aria-controls="panel-tasks"');
    expect(bar.innerHTML).toContain('<span class="pm-label">작업</span><span class="pm-count">1/1</span>');
    // Wired once: a press on a tab selects it.
    env.renderPanelMidbar();
    expect(bar.addEventListener).toHaveBeenCalledTimes(1);
  });

  it('a press opens that tab and paints its content; another tab replaces it; a second press closes it', () => {
    const { env, bar, panel, painted } = rig();
    env.renderPanelMidbar();
    env.selectPanelMid('goal');
    expect(panel.attrs['data-midtab']).toBe('goal');
    expect(expanded(bar.innerHTML)[0]).toBe('goal:true');
    expect(painted).toEqual(['goal', 'size']);
    painted.length = 0;
    env.selectPanelMid('tasks');
    expect(panel.attrs['data-midtab']).toBe('tasks');
    expect(expanded(bar.innerHTML).filter((x) => x.endsWith(':true'))).toEqual(['tasks:true']);
    // The 작업 tab opens unfolded: the runs table, the checklist, the task line's list.
    expect([env.__get('_panelTasksOpen'), env.__get('_panelTasksExpanded'), env.__get('_panelTaskLineOpen')]).toEqual([
      true,
      true,
      true,
    ]);
    expect(painted).toEqual(['tasks', 'size']);
    env.selectPanelMid('tasks');
    expect(panel.attrs['data-midtab']).toBe('');
    expect(expanded(bar.innerHTML).every((x) => x.endsWith(':false'))).toBe(true);
  });

  it('세부 opens the full record; 에이전트 the strip and the agent’s head', () => {
    const { env, painted } = rig();
    env.selectPanelMid('info');
    expect(env.__get('_panelInfoOpen')).toBe(true);
    expect(painted).toContain('info');
    painted.length = 0;
    env.selectPanelMid('agents');
    expect(painted).toEqual(['strip', 'agenthead', 'size']);
  });

  it('an open tab the layout no longer has closes; no tabs at all hides the bar', () => {
    const a = rig();
    a.env.selectPanelMid('info');
    expect(a.panel.attrs['data-midtab']).toBe('info');
    const b = rig(['goal']);
    b.env.__set('_panelMid', 'info');
    b.env.renderPanelMidbar();
    expect(b.panel.attrs['data-midtab']).toBe('');
    const c = rig([]);
    c.env.renderPanelMidbar();
    expect(c.bar.hidden).toBe(true);
  });

  it('an empty tab is disabled — no press, out of the Tab order (review P3); the 에이전트 tab controls the strip', () => {
    const { env, bar } = rig();
    env.__set('_sessionCache', { k1: { key: 'k1', ownerId: 'U1', agents: [] } });
    env.renderPanelMidbar();
    expect(bar.innerHTML).toMatch(/data-mid="agents" aria-expanded="false" aria-controls="panel-tabs" disabled/);
    expect(clientFn('renderPanelMidbar')).toContain('if (!b || b.disabled) return;');
  });
});

describe('Z4 — an opening lands on its tab', () => {
  it('a goal → 목표, a task → 작업, an agent → 에이전트; a plain re-landing keeps the reader’s tab, a new opening closes it', () => {
    const open = clientFn('openPanel');
    expect(open).toContain(
      "var midLand = _panelLand === 'goal' ? 'goal' : _panelLand === 'tasks' ? 'tasks' : _panelLand === 'agent' ? 'agents' : _panelLand === 'artifacts' ? 'artifacts' : '';",
    );
    expect(open).toContain("if (midLand) _panelMid = midLand;\n  else if (!sameSession) _panelMid = '';");
    // Before the panel paints (repaintPanelSession → renderPanelMidbar draws the bar with it).
    expect(open.indexOf('var midLand')).toBeLessThan(open.indexOf('repaintPanelSession();'));
    // The open card's 전체 N개 → lands on the 산출물 tab (review P2).
    expect(open).toContain("_panelLand === 'artifacts' ? 'artifacts'");
    expect(clientFn('renderCardArtifacts')).toContain(
      ",\\'artifacts\\',\\'\\',event.detail===0)\">전체 ' + total + '개 &rarr;</button>'",
    );
    expect(clientFn('repaintPanelSession')).toContain('renderPanelMidbar();');
  });
});

describe('Z5 — the page: 입력 필요 → the tab bar → the tabs’ content', () => {
  const at = (needle: string) => {
    const i = PAGE.indexOf(needle);
    if (i < 0) throw new Error(`missing ${needle}`);
    return i;
  };

  it('입력 필요 sits right under the title bar, above the tab bar; the tabs’ content follows the bar', () => {
    expect(at('id="panel-status"')).toBeLessThan(at('id="panel-needs-head"'));
    for (const id of ['panel-permission', 'panel-question', 'panel-plan'])
      expect(at(`id="${id}"`)).toBeLessThan(at('id="panel-midbar"'));
    for (const id of ['panel-goal', 'panel-artifacts', 'panel-info', 'panel-tasks'])
      expect(at(`id="${id}"`)).toBeGreaterThan(at('id="panel-midbar"'));
    expect(PAGE).toContain(
      '<div class="panel-midbar" id="panel-midbar" role="group" aria-label="작업 정보 탭" hidden></div>',
    );
  });

  it('the 목표 tab shows the empty goal editor (the tab is the way to add one — review P2)', () => {
    expect(CSS).not.toContain('.panel-goal.is-empty { display: none');
  });

  it('a file attached to an instruction updates the 산출물 tab’s count (review P2)', () => {
    for (const fn of ['ensureUserMedia', 'umOnTurn'])
      expect(clientFn(fn), fn).toContain('{ renderPanelArtifactsSection(); renderPanelMidbar(); }');
    expect(clientFn('artSettle')).toContain('{ renderPanelArtifactsSection(); renderPanelMidbar(); }');
  });

  it('what needs the user is never behind a tab (no data-midtab rule names it)', () => {
    for (const sel of [
      '#panel-needs-head',
      '#panel-permission',
      '#panel-question',
      '#panel-plan',
      '#panel-status',
      '#panel-command',
    ])
      expect(CSS, sel).not.toMatch(new RegExp(`data-midtab[^{]*${sel}[,\\s{]`));
  });

  it('the agent strip shows with the 에이전트 tab, or while the card looks at a subagent', () => {
    expect(CSS).toContain('.slide-panel:not([data-midtab="agents"]):not([data-agent-scoped]) .panel-tabs::part(list),');
    expect(CSS).toContain('.slide-panel:not([data-midtab="agents"]):not([data-agent-scoped]) #panel-agents,');
  });
});
