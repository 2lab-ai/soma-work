/**
 * affectUI Agent Run → the session detail panel (.prd/affectui/re-agent-run.md,
 * issue #439). Executes the shipped client code cut out of renderDashboardPage()'s
 * template literal, cooked exactly as the browser receives it (the harness of
 * dashboard-three-surfaces-client.test.ts).
 *
 *   plan        = the Tasks section of the focused tab (task view T1.3: folded
 *                 by default; opened — SSOT 2026-10-29 T5 — the tasks that ran
 *                 in the order they started, each row opening its detail, then
 *                 the plan left, the never-run dropped ones folded, the totals):
 *                 markers, rail, announcements (D1–D7)
 *   needs input = a header with a count, approval cards for permission prompts
 *                 and the single-choice question, the keyboard, the answered
 *                 row, the expiry clock (D8–D17)
 *   head        = the status pill, 시작 · 경과 (D18); 세부 = Details (D19)
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { uiLibDistDir } from '../dashboard';
import { uiLibKitCss } from '../ui-lib';

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
function load<T>(fns: string[], vars: string[], inject: Record<string, unknown> = {}, extra: string[] = []): T {
  const names = Object.keys(inject);
  const extraNames = extra.map((src) => /^function (\w+)/.exec(src)?.[1] ?? '').filter(Boolean);
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\n${extra.join('\n')}\nreturn { ${[...fns, ...extraNames].join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}
/** The page markup as served (the template between <body> and the first <script>). */
const PAGE = cook(TEMPLATE.slice(TEMPLATE.indexOf('<body'), TEMPLATE.indexOf('<script>', TEMPLATE.indexOf('<body'))));
/** The page CSS as served. */
const CSS = cook(
  TEMPLATE.slice(TEMPLATE.indexOf('<style>'), TEMPLATE.indexOf('</style>', TEMPLATE.indexOf('<style>'))),
);
const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&middot;/g, '·');

const T0 = 1_700_000_000_000;

type El = {
  innerHTML: string;
  textContent: string;
  hidden: boolean;
  attrs: Record<string, string>;
  style: Record<string, string>;
  _html?: string;
  setAttribute(k: string, v: string): void;
  [k: string]: unknown;
};
function box(over: Record<string, unknown> = {}): El {
  return {
    innerHTML: '',
    textContent: '',
    style: {},
    hidden: false,
    attrs: {},
    setAttribute(k: string, v: string) {
      this.attrs[k] = v;
    },
    ...over,
  } as El;
}

// ── Plan (D1–D7) → the task runs (SSOT 2026-10-29 T5) → @2lab.ai/ui (D3 E-22/E-23) ──
// The open Tasks section is <ui-task-runs> (the tasks that ran) and <ui-task-plan> (the plan left, the
// tasks a new plan dropped before they ran in its earlier fold). Pinned here: the page's half — the
// folded head, the data each element is handed, the older-runs toggle, the sums, the announcements, the
// open rows kept across a new element. The rows, markers, rail, clocks and details are the library's
// (ui/src/components/task-runs/task-runs.test.ts, task-plan/task-plan.test.ts).
type Task = {
  id: string;
  content: string;
  status: string;
  activeForm?: string;
  startedAt?: number;
  firstStartedAt?: number;
  completedAt?: number;
  toolCalls?: number;
  agentToolCalls?: number;
  tokens?: { input?: number; output?: number; cacheRead?: number; cacheCreate?: number; costUsd?: number };
  revisions?: Array<{ at: number; content: string }>;
  mergedIds?: string[];
  shared?: number;
  startEstimated?: boolean;
  dropped?: 'started' | 'unstarted';
  removedAt?: number;
};
type Run = Record<string, any>;
type TaskEl = {
  data?: Record<string, any>;
  sets: number;
  opened: string[];
  setOpen?(id: string, open: boolean): void;
  _trRestored?: boolean;
};
function taskEl(withSetOpen = true): TaskEl {
  let data: Record<string, any> | undefined;
  const el: TaskEl = {
    sets: 0,
    opened: [],
    get data() {
      return data;
    },
    set data(d) {
      el.sets++;
      data = d;
    },
  };
  if (withSetOpen)
    el.setOpen = (id: string, open: boolean) => {
      if (open) el.opened.push(id);
    };
  return el;
}
// `open: false` is the folded default (the head only).
function plan(opts: { expanded?: boolean; open?: boolean; taskOpen?: Record<string, boolean> } = {}) {
  const el = box();
  const runsEl = taskEl();
  const planEl = taskEl();
  let writes = 0;
  type Render = (t: Task[] | null, label?: string, earlier?: Task[], outside?: unknown) => void;
  const m = load<{ renderPanelTasks: Render; taskRunsRestore(el: unknown): void; openRuns(): Record<string, boolean> }>(
    [
      'esc',
      'escAttr',
      'escJs',
      'toNum',
      'formatDuration',
      'formatTokens',
      'agentIconHtml',
      'taskFateOf',
      'taskIdNum',
      'taskRunStart',
      'taskRunEnd',
      'taskRunsOf',
      'taskTokTotal',
      'taskTotalsHtml',
      'planSummaryHtml',
      'taskElData',
      'taskRunsData',
      'taskPlanData',
      'taskRunsRestore',
      'renderPanelTasks',
    ],
    ['AGENT_STATUS_LABEL', 'AGENT_STATUS_TONE', 'TASK_FATE_LABEL', 'PI_CHEV_SVG', 'TASK_RUNS_SHOWN', 'TASK_RUN_STATUS'],
    {
      document: {
        getElementById: (id: string) =>
          id === 'panel-tasks'
            ? el
            : id === 'panel-task-runs' && el.innerHTML.includes('id="panel-task-runs"')
              ? runsEl
              : id === 'panel-task-plan' && el.innerHTML.includes('id="panel-task-plan"')
                ? planEl
                : null,
      },
      _panelTasksOpen: opts.open !== false,
      _panelTasksExpanded: !!opts.expanded,
      _panelTaskOpen: opts.taskOpen ?? {},
      morphInnerHtml: (e: El, h: string) => {
        writes++;
        e.innerHTML = h;
      },
    },
    ['function openRuns() { return _panelTaskOpen; }'],
  );
  const runs = (): Run[] => (el.innerHTML.includes('id="panel-task-runs"') ? (runsEl.data?.runs ?? []) : []);
  const steps = (): Run[] => (el.innerHTML.includes('id="panel-task-plan"') ? (planEl.data?.steps ?? []) : []);
  return {
    el,
    runsEl,
    planEl,
    render: m.renderPanelTasks,
    restore: m.taskRunsRestore,
    writes: () => writes,
    runs,
    steps,
  };
}
const TASKS: Task[] = [
  { id: 'T1', content: 'Read the picker', status: 'completed', startedAt: T0, completedAt: T0 + 120_000, toolCalls: 8 },
  {
    id: 'T2',
    content: 'Render the bars',
    activeForm: 'Rendering the bars',
    status: 'in_progress',
    startedAt: T0 + 120_000,
    toolCalls: 11,
  },
  { id: 'T3', content: 'Open the PR', status: 'pending', toolCalls: 0 },
];
const TOKENS = { input: 1200, output: 300, cacheRead: 40_000, cacheCreate: 2_500, costUsd: 0.4567 };

describe('plan — the Tasks section of the tab: the tasks that ran, in the order they ran (D1–D5, SSOT 2026-10-29 T5, D3 E-22/E-23)', () => {
  it('T1.3: folded by default — the head is the runs in one line (SSOT 2026-10-29 T5), no elements until it is opened', () => {
    const p = plan({ open: false });
    p.render(TASKS);
    const html = p.el.innerHTML;
    expect(html).toContain(
      '<button type="button" class="panel-sec-head panel-tasks-header" aria-expanded="false" onclick="togglePanelTasks()">',
    );
    expect(html).toContain('<span class="ps-sec-title">Tasks</span>');
    // The run in progress (its activeForm), how many ran and completed, what is left of the plan.
    expect(text(html)).toContain('Rendering the bars·실행 2 · 완료 1·남은 1');
    expect(html).not.toContain('panel-tasks-body');
    expect(html).not.toContain('ui-task-');
    // The live region is written folded as well (D7 keeps announcing).
    expect(html).toContain('<span class="ar-vh pl-live" role="status" aria-live="polite"></span>');
    // Nothing ran yet, all ran, a list a new plan dropped before it ran.
    const idle = plan({ open: false });
    idle.render([TASKS[2]]);
    expect(text(idle.el.innerHTML)).toContain('실행 0 · 완료 0·남은 1');
    idle.render([], '', [{ id: 'T0', content: 'x', status: 'pending', dropped: 'unstarted' }]);
    expect(text(idle.el.innerHTML)).toContain('목록 없음·빠짐 1');
    const open = plan();
    open.render(TASKS);
    expect(open.el.innerHTML).toContain(
      'aria-expanded="true" aria-controls="panel-tasks-body" onclick="togglePanelTasks()">',
    );
    // The elements sit in the token wrapper (they read the dashboard tokens resolved).
    expect(open.el.innerHTML).toContain(
      '<div class="panel-tasks-body ui-tok" id="panel-tasks-body"><ui-task-runs class="panel-task-runs" id="panel-task-runs" lang="ko"></ui-task-runs><ui-task-plan class="panel-task-plan" id="panel-task-plan" lang="ko"></ui-task-plan>',
    );
    // Two runs and the one step left of the plan; the head keeps the activeForm while open.
    expect(open.runs()).toHaveLength(2);
    expect(open.steps()).toHaveLength(1);
    expect(open.runsEl.data).toMatchObject({ title: '실행된 태스크', totals: false });
    expect(open.planEl.data).toMatchObject({ title: '남은 계획' });
    expect(open.el.innerHTML).toContain(
      '<span class="ps-sec-now"><span class="spinner ag-spinner" aria-hidden="true"></span>Rendering the bars</span>',
    );
  });

  it('T2: a step that had started and waits again is a paused run (no end, so no clock) — not a step left', () => {
    const p = plan();
    p.render([{ id: 'T7', content: 'Was running', status: 'pending', startedAt: T0, toolCalls: 3 }]);
    expect(p.runs()).toEqual([
      {
        id: 'T7',
        ref: '#T7',
        title: 'Was running',
        status: 'paused',
        startedAt: T0,
        tools: [{ name: '메인', count: 3 }],
        toolCalls: 3,
      },
    ]);
    // No plan left, nothing dropped: no plan element.
    expect(p.el.innerHTML).not.toContain('ui-task-plan');
  });

  it('D1/D2 (SSOT 2026-10-29 T5): the runs by start — not the list order — then the plan left; one status per run', () => {
    const p = plan();
    p.render([TASKS[2], TASKS[1], TASKS[0]]);
    expect(p.runs().map((r) => r.id)).toEqual(['T1', 'T2']);
    expect(p.runs().map((r) => r.status)).toEqual(['done', 'running']);
    expect(p.steps()).toEqual([{ id: 'T3', ref: '#T3', label: 'Open the PR', status: 'pending' }]);
    const html = p.el.innerHTML;
    expect(html.indexOf('<ui-task-runs')).toBeLessThan(html.indexOf('<ui-task-plan'));
  });

  it('D3: the markers, the rail and the clocks are the elements’ — the page has no plan rules left; both modules load', () => {
    expect(CSS).not.toMatch(/\.pl-(list|step|marker|aside|line|chip|sub|fate)\b/);
    expect(CSS).not.toMatch(/\.tr-(row|meta|detail|head|count|revs)\b/);
    expect(CSS).not.toMatch(/\.panel-task-item\b/);
    expect(TEMPLATE).toContain('<script type="module" src="/dashboard/ui/task-runs.js?v=${UI_LIB_VERSION}"></script>');
    expect(TEMPLATE).toContain('<script type="module" src="/dashboard/ui/task-plan.js?v=${UI_LIB_VERSION}"></script>');
  });

  it('D4 (SSOT 2026-10-29 T5): a run carries #id · title, start / end, the main agent’s and the subagents’ tool calls, tokens (cache included) and cost', () => {
    const q = plan();
    q.render([
      {
        id: 'T4',
        content: 'Review',
        status: 'completed',
        startedAt: T0,
        completedAt: T0 + 90_000,
        toolCalls: 8,
        agentToolCalls: 5,
        tokens: TOKENS,
      },
      {
        id: 'T5',
        content: 'Fix',
        status: 'completed',
        startedAt: T0 + 90_000,
        completedAt: T0 + 120_000,
        toolCalls: 4.5,
        agentToolCalls: 2.4,
        shared: 2,
        tokens: TOKENS,
      },
      {
        id: 'T6',
        content: 'Note',
        status: 'completed',
        startedAt: T0 + 120_000,
        completedAt: T0 + 125_000,
        startEstimated: true,
        toolCalls: 1,
        tokens: { input: 100, output: 50, costUsd: 0.001 },
      },
    ]);
    const [a, b, c] = q.runs();
    expect(a).toEqual({
      id: 'T4',
      ref: '#T4',
      title: 'Review',
      status: 'done',
      startedAt: T0,
      endedAt: T0 + 90_000,
      tools: [
        { name: '메인', count: 8 },
        { name: '서브에이전트', count: 5 },
      ],
      toolCalls: 13,
      tokens: { input: 1200, output: 300, cacheRead: 40_000, cacheWrite: 2_500 },
      costUsd: 0.4567,
    });
    // A share of work done together is a whole number on screen (D3-GAPS G5-1: the ≈ is gone).
    expect(b.tools).toEqual([
      { name: '메인', count: 5 },
      { name: '서브에이전트', count: 2 },
    ]);
    expect(b.toolCalls).toBe(7);
    expect(c.tokens).toEqual({ input: 100, output: 50, cacheRead: 0, cacheWrite: 0 });
    expect(c.costUsd).toBe(0.001);
  });

  it('D5: a done run carries its start and end; the active one its first start and no end (the element’s 1 Hz clock) — never the time now', () => {
    const p = plan();
    p.render(TASKS);
    const [done, active] = p.runs();
    expect([done.startedAt, done.endedAt]).toEqual([T0, T0 + 120_000]);
    expect(active.startedAt).toBe(T0 + 120_000);
    expect('endedAt' in active).toBe(false);
    expect(JSON.stringify(p.runsEl.data)).not.toMatch(/"now"/);
    // The same data writes nothing — neither the markup nor the elements' data.
    p.render(TASKS);
    expect(p.writes()).toBe(1);
    expect(p.runsEl.sets).toBe(1);
    expect(p.planEl.sets).toBe(1);
    // A run that went back to waiting and started again counts from when it first started.
    const again = plan();
    again.render([{ id: 'T5', content: 'Again', status: 'in_progress', firstStartedAt: T0, startedAt: T0 + 60_000 }]);
    expect(again.runs()[0].startedAt).toBe(T0);
  });
});

describe('a run opens its detail (SSOT 2026-10-29 T5) — the element’s, kept by the page', () => {
  const INIT = TEMPLATE.slice(TEMPLATE.indexOf('(function initPanelTasks() {'));
  const initSrc = cook(INIT.slice(0, INIT.indexOf('\n})();\n') + 6));
  function init(open: Record<string, boolean>) {
    let handler: ((e: unknown) => void) | null = null;
    const host = { addEventListener: (t: string, h: (e: unknown) => void) => t === 'ui-toggle' && (handler = h) };
    const st = { earlier: false };
    new Function(
      'document',
      'window',
      '_panelTaskOpen',
      'taskRunsRestore',
      'state',
      initSrc.replace(/_panelTasksEarlier = /g, 'state.earlier = '),
    )({ getElementById: (id: string) => (id === 'panel-tasks' ? host : null) }, {}, open, () => {}, st);
    return { fire: (tagName: string, detail: unknown) => handler?.({ target: { tagName }, detail }), st };
  }

  it('a row the reader opens or closes is kept (ui-toggle); a new element opens them again (setOpen), once', () => {
    const open: Record<string, boolean> = {};
    const h = init(open);
    h.fire('UI-TASK-RUNS', { id: 'T1', open: true });
    h.fire('UI-TASK-RUNS', { id: 'T2', open: true });
    h.fire('UI-TASK-RUNS', { id: 'T2', open: false });
    expect(open).toEqual({ T1: true });
    // The plan's fold of the tasks dropped before they ran is the page's 실행 전에 계획에서 빠짐 state.
    h.fire('UI-TASK-PLAN', { id: 'earlier-plans', open: true });
    expect(h.st.earlier).toBe(true);
    h.fire('UI-TASK-PLAN', { id: 'earlier-steps', open: false });
    expect(h.st.earlier).toBe(true);

    const p = plan({ taskOpen: { T1: true } });
    p.render(TASKS);
    expect(p.runsEl.opened).toEqual(['T1']);
    p.render([...TASKS, { id: 'T4', content: 'more', status: 'pending' }]);
    expect(p.runsEl.opened).toEqual(['T1']);
    // Not upgraded yet (no setOpen): nothing, and it is still due once the element is defined.
    const bare = taskEl(false);
    p.restore(bare);
    expect(bare._trRestored).toBeUndefined();
  });

  it('the rewrites are its earlier texts (each with its time); no usage record: no tokens, no cost', () => {
    const p = plan();
    p.render([
      {
        id: 'T4',
        content: 'Review the PR',
        status: 'completed',
        startedAt: T0,
        completedAt: T0 + 90_000,
        toolCalls: 4.5,
        shared: 2,
        tokens: TOKENS,
        revisions: [
          { at: T0 + 10_000, content: 'Review' },
          { at: T0 + 20_000, content: 'Review <the> PR' },
        ],
      },
      {
        id: 'T5',
        content: 'Old run',
        status: 'completed',
        startedAt: T0 + 90_000,
        completedAt: T0 + 95_000,
        toolCalls: 1,
      },
    ]);
    const [shared, old] = p.runs();
    expect(shared.revisions).toEqual([
      { at: T0 + 10_000, note: 'Review' },
      { at: T0 + 20_000, note: 'Review <the> PR' },
    ]);
    expect(old.tokens).toBeUndefined();
    expect(old.costUsd).toBeUndefined();
    expect(old.revisions).toBeUndefined();
  });

  it('ids stay unique across the lists (a repeated ledger id gets its place as a suffix)', () => {
    const p = plan();
    p.render([{ id: 'T1', content: 'a', status: 'completed', startedAt: T0, completedAt: T0 + 1 }], '', [
      {
        id: 'T1',
        content: 'b',
        status: 'completed',
        startedAt: T0 + 2,
        completedAt: T0 + 3,
        dropped: 'started',
        removedAt: T0 + 4,
      },
    ]);
    expect(p.runs().map((r) => r.id)).toEqual(['T1', 'T1~1']);
    expect(p.runs().map((r) => r.ref)).toEqual(['#T1', '#T1']);
  });
});

describe('the run list folds past TASK_RUNS_SHOWN; replaced and skipped tasks; the totals (SSOT 2026-10-29 T5, was the D6 plan footer)', () => {
  it('past 12 runs only the newest are handed to the element; the older fold behind one toggle above it: 이전 실행 N개 보기 / 최근 12개만 보기', () => {
    expect(clientVar('TASK_RUNS_SHOWN')).toBe('var TASK_RUNS_SHOWN = 12;');
    const many: Task[] = Array.from({ length: 15 }, (_, i) => ({
      id: `T${i + 1}`,
      content: `run ${i + 1}`,
      status: 'completed',
      startedAt: T0 + i * 1000,
      completedAt: T0 + i * 1000 + 500,
    }));
    const p = plan();
    p.render(many);
    expect(p.runs().map((r) => r.id)).toEqual(many.slice(3).map((t) => t.id));
    expect(p.el.innerHTML).toContain(
      '<div class="panel-tasks-body ui-tok" id="panel-tasks-body"><div class="pl-fold"><button type="button" class="panel-tasks-toggle" onclick="_panelTasksExpanded=true;repaintPanelTasks()"><span class="chev" aria-hidden="true"></span>이전 실행 3개 보기</button></div><ui-task-runs',
    );
    const open = plan({ expanded: true });
    open.render(many);
    expect(open.runs()).toHaveLength(15);
    expect(open.el.innerHTML).toContain(
      '<button type="button" class="panel-tasks-toggle" onclick="_panelTasksExpanded=false;repaintPanelTasks()"><span class="chev is-up" aria-hidden="true"></span>최근 12개만 보기</button>',
    );
    const twelve = plan();
    twelve.render(many.slice(0, 12));
    expect(twelve.runs()).toHaveLength(12);
    expect(twelve.el.innerHTML).not.toContain('pl-fold');
  });

  it('a task a new plan replaced after it ran stays among the runs — dropped, ended when it left; one dropped before it ran is only in the plan’s earlier fold', () => {
    const earlier: Task[] = [
      {
        id: 'T0',
        content: 'old one',
        status: 'completed',
        startedAt: T0 - 300_000,
        completedAt: T0 - 240_000,
        removedAt: T0,
        toolCalls: 2,
      },
      {
        id: 'T8',
        content: 'replaced',
        status: 'in_progress',
        startedAt: T0 - 60_000,
        dropped: 'started',
        removedAt: T0,
        toolCalls: 6,
      },
      { id: 'T9', content: 'never ran', status: 'pending', dropped: 'unstarted', removedAt: T0 },
    ];
    const p = plan();
    p.render([TASKS[1]], '', earlier);
    // The earlier list's runs and the current one, in the order they ran.
    expect(p.runs().map((r) => r.id)).toEqual(['T0', 'T8', 'T2']);
    expect(p.runs()[1]).toMatchObject({ status: 'dropped', startedAt: T0 - 60_000, endedAt: T0, toolCalls: 6 });
    // Never ran: not a run — the plan's earlier fold, dropped; no step left of the current plan.
    expect(p.steps()).toEqual([]);
    expect(p.planEl.data?.earlier).toEqual([
      {
        id: 'skipped',
        title: '실행 전에 계획에서 빠진 태스크',
        steps: [{ id: 'skipped:T9', ref: '#T9', label: 'never ran', status: 'pending', fate: 'dropped' }],
      },
    ]);
    expect(text(p.el.innerHTML)).not.toContain('never ran');
  });

  it('no list at all: the plan element’s empty state (계획, no steps)', () => {
    const p = plan();
    p.render([]);
    expect(p.el.innerHTML).not.toContain('ui-task-runs');
    expect(p.planEl.data).toEqual({ title: '계획', steps: [] });
  });

  it('the foot: 합계 of every run — tool calls (+서브), tokens, cost — and 태스크 밖, the work no task got', () => {
    const p = plan();
    const ran: Task[] = [
      {
        ...TASKS[0],
        toolCalls: 2.5,
        agentToolCalls: 0.2,
        shared: 2,
        tokens: { input: 1000, output: 500, costUsd: 0.05 },
      },
      {
        ...TASKS[1],
        toolCalls: 2.5,
        agentToolCalls: 0.2,
        shared: 2,
        tokens: { input: 3000, cacheRead: 500, costUsd: 0.1 },
      },
      TASKS[2],
    ];
    p.render(ran, '', [], { toolCalls: 0, tokens: { input: 1500, output: 500 } });
    const html = p.el.innerHTML;
    // Shares add up to whole calls (2.5 + 2.5); 0.4 subagent calls are none. The plan left counts nothing.
    expect(html).toContain('<div class="tr-total"><span class="tr-total-k">합계</span>툴 5 · 5.0K tok · $0.15</div>');
    // Work outside every task, tokens alone are enough to show it.
    expect(html).toContain(
      '<div class="tr-total tr-outside"><span class="tr-total-k">태스크 밖</span>툴 0 · 2.0K tok</div>',
    );
    // The foot closes the body, after the runs and the plan (the element's own totals are off: it sees only the newest).
    expect(html.indexOf('class="tr-total"')).toBeGreaterThan(html.indexOf('</ui-task-plan>'));
    expect(html.indexOf('class="tr-total"')).toBeLessThan(html.indexOf('</div><span class="ar-vh pl-live"'));
    p.render([TASKS[0], { ...TASKS[1], agentToolCalls: 7 }], '', [], { toolCalls: 4, agentToolCalls: 2 });
    expect(p.el.innerHTML).toContain('<span class="tr-total-k">합계</span>툴 19 (+서브 7)</div>');
    expect(p.el.innerHTML).toContain('<span class="tr-total-k">태스크 밖</span>툴 4 (+서브 2)');
    // Nothing outside the tasks: no row for it. Nothing ran: no foot at all.
    p.render(TASKS, '', [], null);
    expect(p.el.innerHTML).not.toContain('tr-outside');
    // Nothing ran yet but work was done (before the first list): only the 태스크 밖 row (review R1).
    p.render([TASKS[2]], '', [], { toolCalls: 9 });
    expect(p.el.innerHTML).not.toContain('<span class="tr-total-k">합계</span>');
    expect(p.el.innerHTML).toContain('<span class="tr-total-k">태스크 밖</span>툴 9');
    p.render([TASKS[2]], '', [], null);
    expect(p.el.innerHTML).not.toContain('tr-total');
    // The old plan footer is gone (its phase line is the head now).
    expect(declarationCount('planFootHtml')).toBe(0);
  });
});

describe('plan announcements (D7)', () => {
  const live = (html: string) =>
    /<span class="ar-vh pl-live" role="status" aria-live="polite">([^<]*)<\/span>/.exec(html)?.[1];

  it('the first render is silent; a step that completes is announced once', () => {
    const p = plan();
    p.render(TASKS);
    expect(live(p.el.innerHTML)).toBe('');
    const next = TASKS.map((t) => (t.id === 'T2' ? { ...t, status: 'completed', completedAt: T0 + 300_000 } : t));
    p.render(next);
    expect(live(p.el.innerHTML)).toBe('T2 완료: Render the bars');
    p.render(next);
    expect(live(p.el.innerHTML)).toBe('');
  });

  it('a list that empties and refills is a fresh baseline (no stale announcement)', () => {
    const p = plan();
    p.render(TASKS);
    p.render([]);
    p.render([{ id: 'T2', content: 'Render the bars', status: 'completed' }]);
    expect(live(p.el.innerHTML)).toBe('');
  });

  it('another scope (a subagent) or a new opening starts a silent baseline', () => {
    const p = plan();
    p.render(TASKS);
    p.render(
      TASKS.map((t) => ({ ...t, status: 'completed' })),
      'A1 Explore',
    );
    expect(live(p.el.innerHTML)).toBe('');
    // openPanel drops the baseline of the previous opening.
    expect(clientFn('openPanel')).toContain('tasksEl._planScope = null;');
  });
});

// ── Needs input (D8–D17) ──
// affectUI batch 1: every prompt and the single-choice question is a <ui-approval-card> (@2lab.ai/ui).
// The dashboard's half, pinned here: the slot markup (keyed by its request), the card's data
// (acPermissionData / acQuestionData), who may answer (canAnswer), the answer path (ui-decide /
// ui-answer → answerPermission / answerChoice → the card's state + a toast), focus and landing around
// the cards. The card's own markup, keyboard, countdown and resolved row are the library's
// (ui/src/components/approval-card/approval-card.test.ts — named where a test moved there).
const PERM = (over: Record<string, unknown> = {}) => ({
  approvalId: 'approval_a1',
  toolName: 'Bash',
  requesterId: 'U1',
  rules: [{ id: 'pipe-to-interpreter', label: 'Pipe to interpreter', description: 'curl | sh' }],
  canDisableRule: true,
  createdAt: T0,
  expiresAt: T0 + 300_000,
  ...over,
});
const SESSION = (over: Record<string, unknown> = {}) => ({
  key: 'inst::C1:t1',
  ownerId: 'U1',
  activityState: 'waiting',
  tasks: [
    { id: 'T1', content: 'Plan', status: 'completed' },
    { id: 'T3', content: 'Run on production', status: 'in_progress' },
  ],
  pendingPermissions: [PERM()],
  ...over,
});
const INPUT = JSON.stringify(
  { command: 'curl https://example.test/<script> | sh', description: 'Install the tool', timeout: 5000 },
  null,
  2,
);
type CardData = Record<string, any>;

function cards(
  opts: { user?: string; details?: Record<string, unknown>; state?: Record<string, unknown>; sibling?: boolean } = {},
) {
  const loads: string[] = [];
  const m = load<{
    acPermissionData(s: unknown, p: unknown): CardData;
    acQuestionData(s: unknown, q: unknown): CardData;
    acQuestionId(q: unknown): string;
    acPermissionsHtml(s: unknown): string;
    acQuestionHtml(s: unknown, q: unknown): string;
  }>(
    [
      'esc',
      'escAttr',
      'toNum',
      'isPermissionRequester',
      'acPermissionLock',
      'acQuestionLock',
      'acDetailDue',
      'acPermissionData',
      'acQuestionId',
      'acQuestionData',
      'acSlotHtml',
      'acPermissionsHtml',
      'acGoalDecisionHtml',
      'acQuestionHtml',
      'stripRecommendedMarker',
      'resolveRecommendedId',
    ],
    ['AC_SIBLING', 'AC_DETAIL_RETRY_MS', 'AC_DETAIL_TRIES'],
    {
      currentUserId: opts.user ?? 'U1',
      READ_ONLY_MSG: '읽기 전용 — 내 세션이 아닙니다',
      isSiblingSession: () => !!opts.sibling,
      _permDetails: opts.details ?? { approval_a1: { input: INPUT, truncated: false } },
      _acState: opts.state ?? {},
      loadPermissionDetail: (_k: string, id: string) => loads.push(id),
    },
  );
  return { ...m, loads };
}

/** answerPermission / answerChoice against one canned server answer (a Response, or a thrown network error). */
function answers(
  res: { ok: boolean; status: number; body?: unknown } | Error,
  cache: Record<string, unknown> = { 'inst::C1:t1': SESSION() },
) {
  const state: Record<string, any> = {};
  const repaints: Array<[string, unknown]> = [];
  const toasts: Array<Record<string, unknown>> = [];
  const posts: Array<[string, unknown]> = [];
  const m = load<{
    answerPermission(k: string, id: string, d: string): Promise<any>;
    answerChoice(k: string, qid: string, c: string): Promise<any>;
    acQuestionId(q: unknown): string;
  }>(
    [
      'acPost',
      'acRefusal',
      'acToolOf',
      'acDrop',
      'stripRecommendedMarker',
      'acQuestionId',
      'answerPermission',
      'answerChoice',
    ],
    ['AC_SENT'],
    {
      _acState: state,
      // What the card and the open panel show is redrawn from the session (acRepaint): record the state then.
      acRepaint: (k: string) => repaints.push([k, JSON.parse(JSON.stringify(state))]),
      dashToast: (t: Record<string, unknown>) => toasts.push(t),
      _csrfToken: 'csrf',
      refreshCsrfToken: async () => {},
      console: { error() {} },
      _sessionCache: cache,
      fetch: async (url: string, init: { body: string }) => {
        posts.push([url, JSON.parse(init.body)]);
        if (res instanceof Error) throw res;
        return { ok: res.ok, status: res.status, json: async () => res.body ?? {} };
      },
    },
  );
  return { ...m, state, repaints, toasts, posts };
}

describe('needs-input header (D8/D9)', () => {
  it('the page: a hidden header right before the permission slot, a live status line, no live region on the cards', () => {
    // D3 E-13: the kit's section head with its count badge (wait tone, the arrival pop).
    const head = PAGE.indexOf(
      '<div class="ui-section-head panel-needs-head" id="panel-needs-head" tabindex="-1" hidden>',
    );
    expect(head).toBeGreaterThan(0);
    expect(head).toBeLessThan(PAGE.indexOf('id="panel-permission"'));
    expect(PAGE).toContain(
      '<h4>입력 필요</h4><span class="ui-count" id="panel-needs-count" data-tone="wait" data-pop></span>',
    );
    expect(PAGE).toContain('<p class="ar-vh" id="panel-needs-status" role="status" aria-live="polite"></p>');
    expect(PAGE).toContain('<div class="panel-permission" id="panel-permission" style="display:none"></div>');
  });

  it('the count is the prompts plus an open question; none hides the header', () => {
    const els: Record<string, El> = { 'panel-needs-head': box({ hidden: true }), 'panel-needs-count': box() };
    const m = load<{ renderPanelNeedsHead(s: unknown): void }>(['panelQuestionShown', 'renderPanelNeedsHead'], [], {
      document: { getElementById: (id: string) => els[id] ?? null },
    });
    const q = { type: 'user_choice', question: '?', choices: [{ id: '1', label: 'a' }] };
    m.renderPanelNeedsHead(
      SESSION({ pendingPermissions: [PERM(), PERM({ approvalId: 'approval_b' })], pendingQuestion: q }),
    );
    expect(els['panel-needs-head'].hidden).toBe(false);
    expect(els['panel-needs-count'].textContent).toBe('3');
    m.renderPanelNeedsHead(SESSION({ pendingPermissions: [], activityState: 'working', pendingQuestion: q }));
    expect(els['panel-needs-head'].hidden).toBe(true);
    // The badge is the kit's (an amber tint in both themes, the pop on arrival, a fade under reduced
    // motion); the page draws none of its own.
    const kit = uiLibKitCss();
    expect(kit).toMatch(/\.ui-count\[data-tone="wait"\] \{[^}]*color-mix\(in srgb, var\(--ui-st-wait\)/);
    expect(kit).toMatch(/\.ui-count\[data-pop\] \{[^}]*animation: ui-count-pop/);
    expect(CSS).not.toMatch(/\.pn-count \{/);
    expect(CSS).not.toContain('@keyframes pn-pop');
  });

  it('landing keeps the header in view (offset by its height); keyboard landing focuses the first open card itself, not a button', () => {
    expect(clientFn('landPanel')).toContain("document.getElementById('panel-needs-head')");
    expect(clientFn('landPanel')).toContain('needsHead.offsetHeight');
    expect(clientFn('focusPanelLanding')).toContain(
      "acFirstOpen(document.getElementById('panel-permission')) || acFirstOpen(document.getElementById('panel-question'))",
    );
    // The first card still waiting on an answer; a resolved row, or a hidden slot, is not a landing.
    // (The element's focus() lands on the card, not a button — UiApprovalCard.focus, "Keyboard landing".)
    const m = load<{ acFirstOpen(r: unknown): unknown }>(['acFirstOpen'], []);
    const root = (els: unknown[], display = '') => ({
      style: { display },
      querySelectorAll: (sel: string) => (sel === 'ui-approval-card' ? els : []),
    });
    const done = { status: 'resolved' };
    const open = { status: 'pending' };
    const failed = { status: 'error' };
    expect(m.acFirstOpen(root([done, open, failed]))).toBe(open);
    expect(m.acFirstOpen(root([done, failed]))).toBe(failed);
    expect(m.acFirstOpen(root([done]))).toBeNull();
    expect(m.acFirstOpen(root([open], 'none'))).toBeNull();
    expect(m.acFirstOpen(null)).toBeNull();
  });
});

describe('permission approval card (D10–D13)', () => {
  it('the slot: one <ui-approval-card lang="ko"> per prompt, keyed by its request, a light-DOM line until it loads', () => {
    const html = cards().acPermissionsHtml(
      SESSION({ pendingPermissions: [PERM(), PERM({ approvalId: 'a"2', toolName: '<b>' })] }),
    );
    expect(html).toBe(
      '<div class="ui-tok ac-slot" data-mk="ac|p|approval_a1"><ui-approval-card lang="ko" data-ac-key="inst::C1:t1" data-ac-kind="perm" data-ac-id="approval_a1"><span class="ac-fallback">Bash 실행 승인 — 응답 대기</span></ui-approval-card></div>' +
        '<div class="ui-tok ac-slot" data-mk="ac|p|a&quot;2"><ui-approval-card lang="ko" data-ac-key="inst::C1:t1" data-ac-kind="perm" data-ac-id="a&quot;2"><span class="ac-fallback">&lt;b&gt; 실행 승인 — 응답 대기</span></ui-approval-card></div>',
    );
    expect(html).not.toContain('onclick=');
    // The tokens reach the element from its wrapper (.ui-tok), never on the element (a custom-property cycle).
    expect(CSS).toMatch(/\.ui-tok \{[^}]*--ui-border: var\(--border\);/);
  });

  it('the data: tool, rules, the requester-only input, times, Explain and disable-rule — the element draws label, icon, title, risk, rows and answers', () => {
    // Library: "renders title, risk, rules, the command and Approve / Deny"; lang="ko" "uses the dashboard wording".
    expect(cards().acPermissionData(SESSION(), PERM())).toEqual({
      kind: 'permission',
      id: 'approval_a1',
      tool: 'Bash',
      canExplain: true,
      canDisableRule: true,
      rules: [{ id: 'pipe-to-interpreter', label: 'Pipe to interpreter', description: 'curl | sh' }],
      createdAt: T0,
      expiresAt: T0 + 300_000,
      input: INPUT,
    });
  });

  it('no matched rule: no rules, no disable-rule answer; no creation time: none passed', () => {
    const d = cards().acPermissionData(SESSION(), PERM({ rules: [], canDisableRule: false, createdAt: 0 }));
    expect(d.rules).toBeUndefined();
    expect(d.canDisableRule).toBe(false);
    expect('createdAt' in d).toBe(false);
  });

  it('a prompt is never attributed to the task in progress (the payload has no task or agent: a subagent may have asked)', () => {
    const c = cards();
    for (const d of [
      c.acPermissionData(SESSION(), PERM()),
      c.acQuestionData(SESSION(), { type: 'user_choice', question: 'q?', choices: [{ id: '1', label: 'a' }] }),
    ]) {
      const json = JSON.stringify(d);
      expect(json).not.toContain('T3');
      expect(json).not.toContain('Run on production');
    }
  });

  it('another viewer: the requester-only line, every answer locked, no fetch; the requester without the detail fetches it', () => {
    // Library: "canAnswer false / string locks the answers and says why".
    const other = cards({ user: 'U2' });
    const d = other.acPermissionData(SESSION(), PERM());
    expect(d.canAnswer).toBe('이 요청의 요청자만 응답할 수 있습니다');
    expect(d.notice).toBe('파라미터는 요청자만 볼 수 있습니다');
    expect(d.input).toBeUndefined();
    expect(other.loads).toEqual([]);
    const sibling = cards({ sibling: true });
    expect(sibling.acPermissionData(SESSION(), PERM())).toMatchObject({
      canAnswer: '다른 인스턴스의 세션입니다 — 그 대시보드에서 응답하세요',
      notice: '파라미터는 그 인스턴스의 대시보드에서 볼 수 있습니다',
    });
    expect(sibling.loads).toEqual([]);
    const mine = cards({ details: {} });
    expect(mine.acPermissionData(SESSION(), PERM())).toMatchObject({ loading: true });
    expect(mine.loads).toEqual(['approval_a1']);
  });

  it('D12: the input goes to the element as written, with its cut-short flag; a failed load is the notice', () => {
    // The rows / shell block / diff are the element's (library: "toPreview: command → shell, old/new_string →
    // diff, other keys → rows, non-JSON text → raw"; "shows the input loading line and a cut input note").
    const cut = cards({ details: { approval_a1: { input: '{"command": "abc', truncated: true } } });
    expect(cut.acPermissionData(SESSION(), PERM())).toMatchObject({ input: '{"command": "abc', truncated: true });
    const failed = cards({ details: { approval_a1: { error: '이미 응답되었거나 만료된 요청입니다' } } });
    const d = failed.acPermissionData(SESSION(), PERM());
    expect(d.notice).toBe('이미 응답되었거나 만료된 요청입니다');
    expect(d.input).toBeUndefined();
    expect(d.canAnswer).toBeUndefined();
  });

  it('D13: the card is a container; narrow cards stack the answers and drop the key hints; hints are never read — the element’s own', () => {
    // The panel's old .ap-* renderer CSS is gone and must not come back: the look is <ui-approval-card>'s.
    expect(CSS).not.toMatch(/\.ap-[a-z]/);
    expect(CSS).not.toMatch(/@container \(max-width: (379|319)px\)/);
    // The installed element carries it (ui/src/components/approval-card/styles.ts: "Narrow cards: the answers
    // share a full-width row and the key hints go"; the key hints are aria-hidden and drop on touch).
    const dist = readFileSync(join(uiLibDistDir() as string, 'approval-card.js'), 'utf-8');
    expect(dist).toContain('container: ac / inline-size;');
    expect(dist).toMatch(
      /@container ac \(max-width: 400px\) \{\s*\.ac-actions \{ flex: 1 1 100%;[^}]*\}[^@]*\.ac-kbd \{ display: none; \}/,
    );
    expect(dist).toMatch(/@media \(hover: none\) \{\s*\.ac-kbd \{ display: none; \}/);
    expect(dist).toContain('class="ac-kbd" aria-hidden="true"');
  });
});

describe('approval keyboard (D14) — the element’s own', () => {
  // ⌘↵ / Ctrl+↵ approve (a question: submit), Esc from one of the card's controls denies, Esc on the card
  // itself reaches the page; a locked card answers nothing. All on the element's shadow root (library:
  // "⌘/Ctrl+Enter approves; Esc from a button denies", "arrows move the choice; Enter on an option submits
  // it", "canAnswer false / string locks the answers and says why"). The dashboard's part: no key handler of
  // its own on the cards, the lock it passes, and the page's Escape that closes the panel.
  it('no dashboard key handler on the cards; the lock that gates the keys is passed per viewer', () => {
    expect(declarationCount('apKeydown')).toBe(0);
    expect(TEMPLATE).not.toContain("addEventListener('keydown', apKeydown)");
    expect(cards().acPermissionData(SESSION(), PERM()).canAnswer).toBeUndefined();
    expect(cards({ user: 'U2' }).acPermissionData(SESSION(), PERM()).canAnswer).toBeTruthy();
    expect(cards().acQuestionData(SESSION({ ownerId: 'U2' }), { question: 'q?', choices: [] }).canAnswer).toBe(
      '읽기 전용 — 내 세션이 아닙니다',
    );
  });

  it('Esc end to end: one the card handled (stopped in its shadow root) never reaches the page; one it let through closes the detail card (SSOT 2026-10-29 T2) — the panel with it — and denies nothing', () => {
    // The page's document-level keydown handler (Escape closes the open detail card), cooked as served.
    const start = TEMPLATE.indexOf(
      "document.addEventListener('keydown', function(e) {\n  // Escape in the artifact viewer",
    );
    expect(start).toBeGreaterThan(0);
    const fnStart = TEMPLATE.indexOf('function(e) {', start);
    const fnText = cook(TEMPLATE.slice(fnStart, TEMPLATE.indexOf('\n});', fnStart) + 2));
    expect(fnText).not.toMatch(/answerPermission|ui-decide/);
    // SSOT 2026-10-29 T2: ✕, the backdrop and Escape close the detail card — which folds its board
    // card too (an open card always has its detail card) — not the bare panel.
    expect(fnText).toContain('closeDetailCard()');
    expect(fnText).not.toContain('closePanel()');
    const KEY = 'inst::C1:t1';
    let closes = 0;
    const folds: string[] = [];
    const deck = [KEY];
    const inject: Record<string, unknown> = {
      panelOpen: true,
      panelSessionKey: KEY,
      _panelControlsOpen: false,
      artViewerIsOpen: () => false,
      _cronDrawerKey: null,
      _deck: deck,
      _sessionCache: { [KEY]: {} },
      _expanded: new Set([KEY]),
      folds,
      closePanel: () => closes++,
      openPanel: () => {
        throw new Error('no other detail card waits in the deck');
      },
      renderDeckNav: () => {},
      togglePanelControls: () => {},
      window: { matchMedia: () => ({ matches: false }) },
      document: { querySelector: () => null },
    };
    // The real closeDetailCard, cardFaceOf and the deck it leaves. The board card is a
    // <ui-agent-inbox> card: closeDetailCard folds it the way a reader does, by clicking its face
    // in the element's shadow root; the element answers with ui-toggle (expanded: false), whose
    // handler (wireInbox) is cut down here to what a fold does to the deck.
    const face = {
      click: () => {
        folds.push(KEY);
        (inject._expanded as Set<string>).delete(KEY);
        deckDropRef(KEY);
      },
    };
    const li = { getAttribute: (n: string) => (n === 'data-card' ? KEY : null), querySelector: () => face };
    inject._cardHost = { [KEY]: { shadowRoot: { querySelectorAll: () => [li] } } };
    let deckDropRef: (k: string) => void = () => {};
    inject.__setDrop = (f: (k: string) => void) => {
      deckDropRef = f;
    };
    const body = [
      clientFn('closeDetailCard'),
      clientFn('cardFaceOf'),
      clientFn('deckDrop'),
      clientFn('deckNextAfter'),
      clientFn('deckRemove'),
      '__setDrop(deckDrop);',
      `return ${fnText}`,
    ].join('\n');
    const onDocument = new Function(...Object.keys(inject), body)(...Object.values(inject)) as (e: unknown) => void;
    // Bubbling: the element's shadow-root listener first, then the document's — unless it stopped the event.
    const dispatch = (stoppedByCard: boolean) => {
      if (!stoppedByCard) onDocument({ key: 'Escape', target: {}, preventDefault() {}, defaultPrevented: false });
    };
    dispatch(true); // Esc on Deny / Approve: the card denied and stopped it
    expect(closes).toBe(0);
    expect(folds).toEqual([]);
    dispatch(false); // Esc on the card itself (the keyboard landing): its detail card closes
    expect(folds).toEqual([KEY]); // the board card folds with it (its face clicked once)
    expect(deck).toEqual([]);
    expect(closes).toBe(1); // it was the only detail card: the panel closes — once, not again after the fold
  });
});

describe('after an answer (D15)', () => {
  it('the card becomes one resolved row per answer: the outcome the dashboard sets for each decision', async () => {
    // The row itself is the element's (library: "resolved: a row with the answer"; lang="ko" "uses the
    // dashboard wording").
    const want: Record<string, Record<string, unknown>> = {
      approve: { outcome: 'approved' },
      deny: { outcome: 'denied' },
      explain: { outcome: 'explained' },
      approve_disable_rule: { outcome: 'approved', ruleDisabled: true },
    };
    for (const [decision, end] of Object.entries(want)) {
      const a = answers({ ok: true, status: 200 });
      const st = await a.answerPermission('inst::C1:t1', 'approval_a1', decision);
      expect(st, decision).toMatchObject({ status: 'resolved', ...end });
      expect(st.ruleDisabled, decision).toBe(end.ruleDisabled);
      expect(a.posts, decision).toEqual([
        ['/api/dashboard/session/inst%3A%3AC1%3At1/permission', { approvalId: 'approval_a1', decision }],
      ]);
      // The card's data carries it.
      expect(cards({ state: a.state }).acPermissionData(SESSION(), PERM()).state, decision).toEqual(st);
    }
  });

  it('answerPermission: sending, then the outcome — card and panel redrawn each time, one toast; a second answer sends nothing', async () => {
    const a = answers({ ok: true, status: 200 });
    await a.answerPermission('inst::C1:t1', 'approval_a1', 'deny');
    expect(a.repaints.map(([k, s]) => [k, (s as Record<string, any>)['inst::C1:t1']['p|approval_a1'].status])).toEqual([
      ['inst::C1:t1', 'sending'],
      ['inst::C1:t1', 'resolved'],
    ]);
    // Per session (PR #536 review P1): the state lives under the session that asked.
    expect(a.repaints[0][1]).toEqual({ 'inst::C1:t1': { 'p|approval_a1': { status: 'sending', decision: 'deny' } } });
    expect(a.toasts).toEqual([{ title: '거부를 보냈어요', description: 'Bash', tone: 'success' }]);
    expect(clientFn('acRepaint')).toContain('refreshCard(key);');
    expect(clientFn('acRepaint')).toContain('renderPanelPermission(s);');
    // Answered (or in flight): another press — this tab or the card face — sends nothing.
    expect(await a.answerPermission('inst::C1:t1', 'approval_a1', 'approve')).toMatchObject({ outcome: 'denied' });
    expect(a.posts).toHaveLength(1);
    // The panel's status line says new prompts only; the answer is said by its card and the toast.
    expect(clientFn('renderPanelPermission')).not.toContain('AC_SENT');
  });

  it('a refusal stays on the card: the server’s reason; Retry unless the request is gone (404) or answered elsewhere (409)', async () => {
    const cases: Array<[{ ok: boolean; status: number; body?: unknown } | Error, Record<string, unknown>]> = [
      [
        { ok: false, status: 409, body: { error: 'Permission request was already answered' } },
        { message: 'Permission request was already answered', retry: false },
      ],
      [
        { ok: false, status: 404, body: {} },
        { message: '응답을 보내지 못했어요 (HTTP 404)', retry: false },
      ],
      [
        { ok: false, status: 500, body: { error: 'boom' } },
        { message: 'boom', retry: true },
      ],
      [new Error('down'), { message: '네트워크 오류 — 다시 시도하세요', retry: true }],
    ];
    for (const [res, want] of cases) {
      const a = answers(res);
      expect(await a.answerPermission('inst::C1:t1', 'approval_a1', 'approve')).toEqual({ status: 'error', ...want });
      expect(a.toasts).toEqual([]);
      // The card's Retry sends the last answer again (library: "an error offers Retry, which sends the last
      // answer again"): an errored card is answerable again here.
      await a.answerPermission('inst::C1:t1', 'approval_a1', 'approve');
      expect(a.posts).toHaveLength(2);
    }
  });

  it('a prompt that arrives while the panel is open is announced; the first render of an opening is not', () => {
    const els: Record<string, El> = { 'panel-permission': box() };
    const said: string[] = [];
    const m = load<{ renderPanelPermission(s: unknown): void }>(['renderPanelPermission'], [], {
      document: { getElementById: (id: string) => els[id] ?? null, activeElement: null },
      acGoalDecisionHtml: () => '',
      acPermissionsHtml: (s: { pendingPermissions: Array<{ approvalId: string }> }) =>
        s.pendingPermissions.map((p) => `<${p.approvalId}>`).join(''),
      acHydrate: () => {},
      morphInnerHtml: () => {},
      apSafeFocus: () => {},
      apAnnounce: (t: string) => said.push(t),
      renderPanelNeedsHead: () => {},
    });
    m.renderPanelPermission(SESSION());
    expect(said).toEqual([]);
    m.renderPanelPermission(
      SESSION({ pendingPermissions: [PERM(), PERM({ approvalId: 'approval_b', toolName: 'Edit' })] }),
    );
    expect(said).toEqual(['승인 요청 — Edit']);
    expect(clientFn('openPanel')).toContain('permEl._seenKey = null;');
  });
});

// A tiny element tree with just what domMorph, focus and closest/querySelector touch.
class Node {
  nodeType = 1;
  tagName: string;
  attrs: Map<string, string>;
  kids: Node[] = [];
  parentNode: Node | null = null;
  style: Record<string, string> = {};
  get innerHTML() {
    return '';
  }
  set innerHTML(v: string) {
    if (v === '') for (const k of [...this.kids]) this.removeChild(k);
  }
  constructor(tag: string, attrs: Record<string, string> = {}, kids: Node[] = []) {
    this.tagName = tag;
    this.attrs = new Map(Object.entries(attrs));
    for (const k of kids) this.appendChild(k);
  }
  get attributes() {
    return [...this.attrs].map(([name, value]) => ({ name, value }));
  }
  get id() {
    return this.attrs.get('id') ?? '';
  }
  getAttribute(n: string) {
    return this.attrs.has(n) ? (this.attrs.get(n) as string) : null;
  }
  hasAttribute(n: string) {
    return this.attrs.has(n);
  }
  setAttribute(n: string, v: string) {
    this.attrs.set(n, String(v));
  }
  removeAttribute(n: string) {
    this.attrs.delete(n);
  }
  get firstChild() {
    return this.kids[0] ?? null;
  }
  get nextSibling(): Node | null {
    const sib = this.parentNode?.kids ?? [];
    return sib[sib.indexOf(this) + 1] ?? null;
  }
  appendChild(k: Node) {
    return this.insertBefore(k, null);
  }
  insertBefore(k: Node, ref: Node | null) {
    k.parentNode?.removeChild(k);
    k.parentNode = this;
    const i = ref ? this.kids.indexOf(ref) : -1;
    if (i < 0) this.kids.push(k);
    else this.kids.splice(i, 0, k);
    return k;
  }
  removeChild(k: Node) {
    this.kids.splice(this.kids.indexOf(k), 1);
    k.parentNode = null;
    return k;
  }
  contains(n: unknown) {
    for (let c = n as Node | null; c; c = c.parentNode) if (c === this) return true;
    return false;
  }
  matches(sel: string) {
    return sel.startsWith('.')
      ? (this.attrs.get('class') ?? '').split(' ').includes(sel.slice(1))
      : this.tagName === sel.toUpperCase();
  }
  closest(sel: string) {
    for (let c: Node | null = this; c; c = c.parentNode) if (c.matches(sel)) return c;
    return null;
  }
  querySelectorAll(sel: string): Node[] {
    return this.kids.flatMap((k) => [...(k.matches(sel) ? [k] : []), ...k.querySelectorAll(sel)]);
  }
  querySelector(sel: string) {
    return this.querySelectorAll(sel)[0] ?? null;
  }
  focus() {
    focused = this;
  }
}
/** document.activeElement: focus inside a card's shadow root reads as the card (the host). */
let focused: Node | null = null;
/** A prompt's slot as acSlotHtml writes it: the keyed wrapper and the element bound to its request. */
const SLOT = (id: string, keyed = true) =>
  new Node('DIV', { class: 'ui-tok ac-slot', ...(keyed ? { 'data-mk': `ac|p|${id}` } : {}) }, [
    new Node('UI-APPROVAL-CARD', {
      lang: 'ko',
      'data-ac-key': 'inst::C1:t1',
      'data-ac-kind': 'perm',
      'data-ac-id': id,
    }),
  ]);

describe('live repaint never rebinds an answer to another request (D14, review R1 P1)', () => {
  const morph = load<{ domMorphChildren(a: Node, b: Node): void }>(
    ['domKeyOf', 'domKeyLater', 'domMorph', 'domMorphChildren'],
    [],
  );

  it('each card is keyed by its request in data-mk, and answers only that request', () => {
    const html = cards().acPermissionsHtml(SESSION());
    expect(html).toContain('<div class="ui-tok ac-slot" data-mk="ac|p|approval_a1">');
    expect(html).toContain('data-ac-id="approval_a1"');
    const q = cards().acQuestionHtml(SESSION(), {
      type: 'user_choice',
      question: 'q?',
      choices: [{ id: '1', label: 'a' }],
    });
    expect(q).toContain('data-mk="ac|q|[&quot;q?&quot;,[[&quot;1&quot;,&quot;a&quot;,&quot;&quot;]]]"');
    // ui-decide carries the card's own data id; the listener answers that id under the card's own key.
    expect(TEMPLATE).toContain(
      "answerPermission(el.getAttribute('data-ac-key'), String(e.detail.id), String(e.detail.decision));",
    );
  });

  it('A and B pending, A goes: A’s card (focused) leaves the page; B keeps its own element (unkeyed it would be rebound)', () => {
    const live = new Node('DIV', { id: 'panel-permission' }, [SLOT('A'), SLOT('B')]);
    const [cardA, cardB] = live.querySelectorAll('ui-approval-card');
    morph.domMorphChildren(live, new Node('DIV', {}, [SLOT('B')]));
    expect(live.contains(cardA)).toBe(false);
    expect(live.querySelector('ui-approval-card')).toBe(cardB);
    expect(cardB.getAttribute('data-ac-id')).toBe('B');
    // Without the keys A's element — its focus, an answer in flight — would now stand for B: the bug this pins.
    const old = new Node('DIV', {}, [SLOT('A', false), SLOT('B', false)]);
    const oldA = old.querySelector('ui-approval-card') as Node;
    morph.domMorphChildren(old, new Node('DIV', {}, [SLOT('B', false)]));
    expect(old.contains(oldA) && oldA.getAttribute('data-ac-id')).toBe('B');
  });

  function panel(next: Node[], headHidden = false) {
    const container = new Node('DIV', { id: 'panel-permission', class: 'panel-permission' }, [SLOT('A'), SLOT('B')]);
    const head = new Node('DIV', { id: 'panel-needs-head', class: 'panel-needs-head' });
    (head as unknown as { hidden: boolean }).hidden = headHidden;
    const title = new Node('H3', { id: 'panel-title' });
    const root = new Node('DIV', {}, [title, head, container]);
    const body = new Node('BODY');
    const byId: Record<string, Node> = {
      'panel-permission': container,
      'panel-needs-head': head,
      'panel-title': title,
    };
    const document = {
      getElementById: (id: string) => byId[id] ?? null,
      get activeElement() {
        return focused && root.contains(focused) ? focused : body;
      },
    };
    const m = load<{ renderPanelPermission(s: unknown): void }>(['renderPanelPermission', 'apSafeFocus'], [], {
      document,
      acGoalDecisionHtml: () => '',
      acPermissionsHtml: (s: { pendingPermissions: Array<{ approvalId: string }> }) =>
        s.pendingPermissions.map((p) => p.approvalId).join(','),
      acHydrate: () => {},
      morphInnerHtml: (el: Node, _html: string) => morph.domMorphChildren(el, new Node('DIV', {}, next)),
      apAnnounce: () => {},
      renderPanelNeedsHead: () => {},
    });
    return { m, container, head, title };
  }

  it('focus in A’s card, A goes: focus moves to the 입력 필요 head — no card, so no key answers anything', () => {
    const p = panel([SLOT('B')]);
    focused = p.container.querySelectorAll('ui-approval-card')[0];
    p.m.renderPanelPermission(SESSION({ pendingPermissions: [PERM({ approvalId: 'B' })] }));
    expect(focused).toBe(p.head);
    expect(focused?.closest('ui-approval-card')).toBeNull();
  });

  it('nothing left to answer: the panel title; A answered but still listed: focus stays in A’s own card (its row)', () => {
    const gone = panel([], true);
    focused = gone.container.querySelectorAll('ui-approval-card')[0];
    gone.m.renderPanelPermission(SESSION({ pendingPermissions: [] }));
    expect(focused).toBe(gone.title);
    // A resolved on this page, the push not here yet: A's slot stays, so A's element (now its resolved row)
    // keeps focus — inside it the element moves focus to the row (library core/element.test.ts "restores focus
    // after updated() …, else to focusFallback()"); a second answer there is refused (D15).
    const kept = panel([SLOT('A'), SLOT('B')]);
    const cardA = kept.container.querySelectorAll('ui-approval-card')[0];
    focused = cardA;
    kept.m.renderPanelPermission(
      SESSION({ pendingPermissions: [PERM({ approvalId: 'A' }), PERM({ approvalId: 'B' })] }),
    );
    expect(focused).toBe(cardA);
    expect(cardA.getAttribute('data-ac-id')).toBe('A');
  });
});

describe('a question rewritten in place is another card (review R2 P1)', () => {
  const morph = load<{ domMorphChildren(a: Node, b: Node): void }>(
    ['domKeyOf', 'domKeyLater', 'domMorph', 'domMorphChildren'],
    [],
  );
  const Q = (label1: string, desc1 = '') => ({
    type: 'user_choice',
    question: 'Run the migration?',
    choices: [
      { id: '1', label: label1, ...(desc1 ? { description: desc1 } : {}) },
      { id: '2', label: 'Stop' },
    ],
    recommendedChoiceId: '1',
  });
  /** The slot as the shipped markup keys it, as fake nodes. */
  const tree = (html: string) =>
    new Node('DIV', { class: 'ui-tok ac-slot', 'data-mk': /data-mk="([^"]*)"/.exec(html)?.[1] ?? '' }, [
      new Node('UI-APPROVAL-CARD', { 'data-ac-kind': 'question' }),
    ]);

  it('the key holds the whole meaning: a changed label or description is another key; nothing else collides', () => {
    const c = cards();
    const key = (q: unknown) => c.acQuestionId(q);
    const base = key(Q('백업 대기'));
    expect(key(Q('백업 대기'))).toBe(base);
    expect(key(Q('운영 반영'))).not.toBe(base);
    expect(key(Q('백업 대기', '02:00 이후'))).not.toBe(base);
    // Joining with a separator would collide here; the serialization does not.
    expect(key({ ...Q('a|b'), question: 'x' })).not.toBe(key({ ...Q('b'), question: 'x|a' }));
    expect(declarationCount('apHash')).toBe(0);
    // The slot's key and the card's id are that key.
    expect(c.acQuestionHtml(SESSION(), Q('백업 대기'))).toContain(`data-mk="ac|${base.replace(/"/g, '&quot;')}"`);
    expect(c.acQuestionData(SESSION(), Q('백업 대기')).id).toBe(base);
  });

  it('same text, same ids, choice 1 relabelled: the focused card leaves, focus goes to the head, its late answer sends nothing', async () => {
    const c = cards();
    const before = tree(c.acQuestionHtml(SESSION(), Q('백업 대기')));
    const after = tree(c.acQuestionHtml(SESSION(), Q('운영 반영')));
    const container = new Node('DIV', { id: 'panel-question', class: 'panel-question' }, [before]);
    const head = new Node('DIV', { id: 'panel-needs-head', class: 'panel-needs-head' });
    (head as unknown as { hidden: boolean }).hidden = false;
    const title = new Node('H3', { id: 'panel-title' });
    const root = new Node('DIV', {}, [title, head, container]);
    const body = new Node('BODY');
    const byId: Record<string, Node> = { 'panel-question': container, 'panel-needs-head': head, 'panel-title': title };
    const document = {
      getElementById: (id: string) => byId[id] ?? null,
      get activeElement() {
        return focused && root.contains(focused) ? focused : body;
      },
    };
    let next = after;
    const m = load<{ renderPanelQuestion(s: unknown): void }>(['renderPanelQuestion', 'apSafeFocus'], [], {
      document,
      acQuestionHtml: () => `<${next.getAttribute('data-mk')}>`,
      acHydrate: () => {},
      morphInnerHtml: (el: Node) => morph.domMorphChildren(el, new Node('DIV', {}, [next])),
      renderMultiChoicePanel: () => {},
      renderPanelNeedsHead: () => {},
    });
    // The same meaning again keeps the focused element (focus stays where the reader is).
    const cardBefore = container.querySelector('ui-approval-card') as Node;
    focused = cardBefore;
    next = tree(c.acQuestionHtml(SESSION(), Q('백업 대기')));
    m.renderPanelQuestion(SESSION({ pendingQuestion: Q('백업 대기') }));
    expect(focused).toBe(cardBefore);
    // Rewritten in place: the old card is gone, never rebound to the new meaning.
    next = after;
    m.renderPanelQuestion(SESSION({ pendingQuestion: Q('운영 반영') }));
    expect(container.contains(cardBefore)).toBe(false);
    expect(focused).toBe(head);
    // The old card's answer, if it still lands (ui-answer carries the old id), is dropped: no request.
    const a = answers({ ok: true, status: 200 }, { 'inst::C1:t1': SESSION({ pendingQuestion: Q('운영 반영') }) });
    expect(await a.answerChoice('inst::C1:t1', c.acQuestionId(Q('백업 대기')), '1')).toBeNull();
    expect(a.posts).toEqual([]);
    expect(await a.answerChoice('inst::C1:t1', c.acQuestionId(Q('운영 반영')), '1')).toMatchObject({
      status: 'resolved',
      outcome: 'answered',
      choiceId: '1',
    });
    expect(a.posts).toEqual([
      [
        '/api/dashboard/session/inst%3A%3AC1%3At1/answer-choice',
        { choiceId: '1', label: '운영 반영', question: 'Run the migration?' },
      ],
    ]);
  });
});

// PR #536 review P1: a single-choice question has no request id — its card id is its content. The answer
// state must belong to the session that asked it, and leave when that session no longer asks it: another
// session's identical question, or the same question asked again later, is a new request.
describe('an answer’s state belongs to its session and leaves with its request (PR #536 review P1)', () => {
  const Q = () => ({
    type: 'user_choice',
    question: '계속할까요?',
    choices: [
      { id: '1', label: '예' },
      { id: '2', label: '아니오' },
    ],
  });
  const S = (key: string, over: Record<string, unknown> = {}) =>
    SESSION({ key, pendingPermissions: [], pendingQuestion: Q(), ...over });
  function rig(cache: Record<string, unknown>, extra: string[] = [], hold?: { release?: () => void }) {
    const state: Record<string, any> = {};
    const posts: Array<[string, unknown]> = [];
    const m = load<{
      acQuestionId(q: unknown): string;
      acQuestionData(s: unknown, q: unknown): CardData;
      acPermissionData(s: unknown, p: unknown): CardData;
      answerChoice(k: string, qid: string, c: string): Promise<any>;
      answerPermission(k: string, id: string, d: string): Promise<any>;
      acEvict(k: string, s: unknown): void;
    }>(
      [
        'toNum',
        'isPermissionRequester',
        'acPermissionLock',
        'acQuestionLock',
        'acQuestionId',
        'acQuestionData',
        'acDetailDue',
        'acPermissionData',
        'stripRecommendedMarker',
        'resolveRecommendedId',
        'acPost',
        'acRefusal',
        'acToolOf',
        'acDrop',
        'answerChoice',
        'answerPermission',
        ...extra,
      ],
      ['AC_SENT', 'AC_SIBLING', 'AC_DETAIL_RETRY_MS', 'AC_DETAIL_TRIES'],
      {
        _acState: state,
        _sessionCache: cache,
        _permDetails: { approval_a1: { input: '{}', truncated: false } },
        loadPermissionDetail: () => {},
        currentUserId: 'U1',
        isSiblingSession: () => false,
        acRepaint: () => {},
        dashToast: () => {},
        _csrfToken: 'csrf',
        refreshCsrfToken: async () => {},
        console: { error() {} },
        fetch: async (url: string, init: { body: string }) => {
          posts.push([url, JSON.parse(init.body)]);
          if (hold) await new Promise<void>((r) => (hold.release = r));
          return { ok: true, status: 200, json: async () => ({}) };
        },
      },
    );
    return { ...m, state, posts };
  }

  it('two sessions ask the same question: answering A leaves B unanswered, and B’s answer is sent', async () => {
    const cache: Record<string, any> = { A: S('A'), B: S('B') };
    const r = rig(cache);
    const qid = r.acQuestionId(Q());
    expect(r.acQuestionId(cache.B.pendingQuestion)).toBe(qid); // the content is the id: the same in both
    expect(await r.answerChoice('A', qid, '1')).toMatchObject({ status: 'resolved', choiceId: '1' });
    expect(r.acQuestionData(cache.A, cache.A.pendingQuestion).state).toMatchObject({ status: 'resolved' });
    expect(r.acQuestionData(cache.B, cache.B.pendingQuestion).state).toBeUndefined();
    expect(await r.answerChoice('B', qid, '2')).toMatchObject({ status: 'resolved', choiceId: '2' });
    expect(r.posts.map((p) => p[0])).toEqual([
      '/api/dashboard/session/A/answer-choice',
      '/api/dashboard/session/B/answer-choice',
    ]);
  });

  it('the same session asks the same question again after the first was answered and cleared: a new, unanswered card', async () => {
    const cache: Record<string, any> = { A: S('A') };
    const r = rig(cache, ['acEvict']);
    const qid = r.acQuestionId(Q());
    await r.answerChoice('A', qid, '1');
    // The push after the answer: the session works again, no question.
    cache.A = S('A', { activityState: 'working', pendingQuestion: undefined });
    r.acEvict('A', cache.A);
    // Later the same question again.
    cache.A = S('A');
    r.acEvict('A', cache.A);
    expect(r.acQuestionData(cache.A, cache.A.pendingQuestion).state).toBeUndefined();
    expect(await r.answerChoice('A', qid, '2')).toMatchObject({ status: 'resolved', choiceId: '2' });
    expect(r.posts).toHaveLength(2);
  });

  it('eviction on a push: a question replaced or gone, a prompt that left, a session off the board; what is still asked keeps its state', async () => {
    const cache: Record<string, any> = { A: S('A', { pendingPermissions: [PERM()] }), B: S('B') };
    const r = rig(cache, ['acEvict']);
    const qid = r.acQuestionId(Q());
    await r.answerPermission('A', 'approval_a1', 'deny');
    await r.answerChoice('A', qid, '1');
    await r.answerChoice('B', qid, '1');
    // A push that changes nothing A asks: both of A's states stay.
    r.acEvict('A', cache.A);
    expect(r.acPermissionData(cache.A, PERM()).state).toMatchObject({ outcome: 'denied' });
    expect(r.acQuestionData(cache.A, cache.A.pendingQuestion).state).toMatchObject({ status: 'resolved' });
    // The prompt left and the question was replaced: both go; B is untouched.
    const other = { ...Q(), question: '다른 질문?' };
    cache.A = S('A', { pendingPermissions: [], pendingQuestion: other });
    r.acEvict('A', cache.A);
    expect(r.acPermissionData(cache.A, PERM()).state).toBeUndefined();
    expect(r.acQuestionData(cache.A, Q()).state).toBeUndefined();
    expect(r.acQuestionData(cache.B, cache.B.pendingQuestion).state).toMatchObject({ status: 'resolved' });
    // A session no longer on the board: all of its states go.
    r.acEvict('B', undefined);
    expect(r.acQuestionData(cache.B, cache.B.pendingQuestion).state).toBeUndefined();
    expect(Object.keys(r.state).filter((k) => Object.keys(r.state[k] ?? {}).length)).toEqual([]);
    // Both push paths run it: the board (every session it holds, or drops) and a single-session update.
    expect(clientFn('renderBoard')).toMatch(/for \(var \w+ in _acState\) acEvict\(\w+, _sessionCache\[\w+\]\);/);
    expect(clientFn('connectWs')).toContain('acEvict(updatedKey, msg.session);');
  });

  it('an answer that lands after the push removed its question is not kept (it would answer the next identical question)', async () => {
    const cache: Record<string, any> = { A: S('A') };
    const hold: { release?: () => void } = {};
    const r = rig(cache, ['acEvict'], hold);
    const qid = r.acQuestionId(Q());
    const sent = r.answerChoice('A', qid, '1');
    await Promise.resolve();
    // The server took it and pushed the session without the question before the POST returned.
    cache.A = S('A', { activityState: 'working', pendingQuestion: undefined });
    r.acEvict('A', cache.A);
    hold.release?.();
    expect(await sent).toMatchObject({ status: 'resolved' });
    cache.A = S('A');
    r.acEvict('A', cache.A);
    expect(r.acQuestionData(cache.A, cache.A.pendingQuestion).state).toBeUndefined();
  });
});

describe('a refused panel choice is drawn again from the session (review R1 P2)', () => {
  it('the card keeps its choices and says why, with Retry; card and panel are redrawn from the session; no toast', async () => {
    const q = {
      type: 'user_choice',
      question: 'Deploy?',
      choices: [
        { id: '1', label: 'auto' },
        { id: '2', label: 'manual (Recommended)' },
      ],
    };
    const a = answers(
      { ok: false, status: 500, body: { error: 'boom' } },
      { 'inst::C1:t1': SESSION({ pendingQuestion: q }) },
    );
    const qid = a.acQuestionId(q);
    expect(await a.answerChoice('inst::C1:t1', qid, '2')).toEqual({ status: 'error', message: 'boom', retry: true });
    expect(a.posts[0][1]).toEqual({ choiceId: '2', label: 'manual', question: 'Deploy?' });
    expect(a.repaints.map((r) => r[0])).toEqual(['inst::C1:t1', 'inst::C1:t1']);
    expect(clientFn('acRepaint')).toContain('renderPanelQuestion(s);');
    expect(a.toasts).toEqual([]);
    // The card's data is redrawn from the session (no label written into a button): the same choices.
    expect(cards({ state: a.state }).acQuestionData(SESSION({ pendingQuestion: q }), q)).toMatchObject({
      choices: [
        { id: '1', label: '1. auto' },
        { id: '2', label: '2. manual' },
      ],
      state: { status: 'error', message: 'boom', retry: true },
    });
    // Retry (the card re-emits ui-answer) sends it again.
    await a.answerChoice('inst::C1:t1', qid, '2');
    expect(a.posts).toHaveLength(2);
    expect(declarationCount('apRepaintQuestion')).toBe(0);
  });
});

describe('expiry clock (D16)', () => {
  it('the dashboard passes expiresAt (and createdAt); the countdown, the warning and the Expired row are the element’s', () => {
    // Library: "counts down to expiresAt, then emits ui-expire and shows Expired; the timer stops on
    // disconnect"; "past expiresAt nobody can answer, even while hovered; ui-expire still fires (review P2)";
    // "a failed answer that runs out of time becomes the Expired row (review P3)".
    const d = cards().acPermissionData(SESSION(), PERM());
    expect(d.expiresAt).toBe(T0 + 300_000);
    expect(d.createdAt).toBe(T0);
    const none = cards().acPermissionData(SESSION(), PERM({ expiresAt: 0, createdAt: undefined }));
    expect('expiresAt' in none || 'createdAt' in none).toBe(false);
    // The page's 1 Hz tick no longer draws an expiry of its own.
    expect(clientFn('updateTimersIn')).not.toContain('ap-expires');
  });
});

describe('question card (D17)', () => {
  const Q = {
    type: 'user_choice',
    question: 'The dry run on staging passed.\nRun the migration on production now?',
    choices: [
      { id: 'run', label: 'Run on production', description: 'Applies 0042' },
      { id: 'wait', label: 'Wait for the backup' },
    ],
    recommendedChoiceId: 'wait',
  };

  it('the same element: the whole question, the choices as they read before ("id. label"), the recommended one named', () => {
    // The order (recommended first, preselected) is the element's (library: "lists the recommended choice first
    // and preselected; Submit sends it"); line breaks in the title kept (ApprovalQuestionData.question).
    const c = cards();
    expect(c.acQuestionData(SESSION(), Q)).toEqual({
      kind: 'question',
      id: c.acQuestionId(Q),
      question: 'The dry run on staging passed.\nRun the migration on production now?',
      choices: [
        { id: 'run', label: 'run. Run on production', description: 'Applies 0042' },
        { id: 'wait', label: 'wait. Wait for the backup' },
      ],
      allowOther: false,
      recommendedId: 'wait',
    });
    // A legacy "(Recommended)" label: recommended, the marker stripped.
    const legacy = {
      question: 'Go?',
      choices: [
        { id: '1', label: 'Yes (Recommended)' },
        { id: '2', label: 'No' },
      ],
    };
    expect(c.acQuestionData(SESSION(), legacy)).toMatchObject({
      recommendedId: '1',
      choices: [
        { id: '1', label: '1. Yes' },
        { id: '2', label: '2. No' },
      ],
    });
    // The slot: kind question, the question as its light-DOM line (escaped).
    expect(c.acQuestionHtml(SESSION(), { ...legacy, question: '<b>Go?</b>' })).toContain(
      'data-ac-kind="question"><span class="ac-fallback">질문 — &lt;b&gt;Go?&lt;/b&gt;</span>',
    );
  });

  it('the panel writes the card only when it changed (focus stays) and sets its data every time; the multi-question form is untouched', () => {
    const els: Record<string, El> = { 'panel-question': box() };
    let writes = 0;
    let hydrated = 0;
    let multi = 0;
    const m = load<{ renderPanelQuestion(s: unknown): void }>(['renderPanelQuestion'], [], {
      document: { getElementById: (id: string) => els[id] ?? null },
      acQuestionHtml: () => '<div class="ac-slot"></div>',
      acHydrate: () => hydrated++,
      morphInnerHtml: () => {
        writes++;
      },
      renderMultiChoicePanel: () => multi++,
      renderPanelNeedsHead: () => {},
    });
    const s = SESSION({ pendingQuestion: Q });
    m.renderPanelQuestion(s);
    m.renderPanelQuestion(s);
    expect(writes).toBe(1);
    expect(hydrated).toBe(2);
    expect(els['panel-question'].attrs['data-ap']).toBe('card');
    m.renderPanelQuestion(
      SESSION({ pendingQuestion: { type: 'user_choices', question: 'x', questions: [{ id: 'q1' }] } }),
    );
    expect(multi).toBe(1);
    expect(els['panel-question'].attrs['data-ap']).toBe('form');
  });
});

// ── Head and Details (D18–D19) ──
const CARD = (over: Record<string, unknown> = {}) => ({
  key: 'inst::C1:t1',
  conversationId: 'conv-1',
  ownerId: 'U1',
  ownerName: 'Zhuge',
  workflow: 'zwork',
  model: 'claude-opus-5-5[1m]',
  activityState: 'working',
  activeLegStartedAtMs: T0,
  activeAccumulatedMs: 65_000,
  agentRoot: { toolCalls: 7 },
  agents: [
    { id: 'a1', toolCalls: 3 },
    { id: 'a2', toolCalls: 4 },
  ],
  agentsTotal: 2,
  lastActivity: new Date(T0).toISOString(),
  tokenUsage: {
    totalInputTokens: 1_200_000,
    totalOutputTokens: 91_000,
    totalCacheReadTokens: 8_000_000,
    totalCacheCreateTokens: 300_000,
    totalCostUsd: 12.4,
    contextUsagePercent: 31,
  },
  environment: { instanceName: 'mac-mini', host: 'h', port: 1 },
  slackThreadUrl: 'https://slack/x',
  ...over,
});

// D3 E-08: the head is <ui-status-bar> (its chip, its clock, its buttons); the page hands it data.
describe('panel head (D18) — <ui-status-bar>', () => {
  const head = (s: Record<string, unknown>, col: string) =>
    load<{ panelHeadData(s: unknown, col: string): Record<string, unknown> }>(
      ['toNum', 'pendingAutoResume', 'rootStatusOf', 'isBusy', 'sessionActionsOf', 'panelHeadData'],
      ['AGENT_STATUS_LABEL', 'PS_BAR_STATUS', '_busy'],
      { currentUserId: 'U1', SELF_INSTANCE_NAME: '', READ_ONLY_MSG: 'read only' },
    ).panelHeadData(s, col);

  it('running: the running chip, 시작 HH:MM · the elapsed time of this turn (the bar ticks it), Stop', () => {
    const d = head(CARD(), 'working');
    expect(d).toMatchObject({ status: 'running', words: { running: '실행 중' }, startedAt: T0 });
    expect(d.activeMs).toBeUndefined();
    expect(d.actions).toContainEqual({ id: 'stop', label: 'Stop', tone: 'danger', icon: 'stop' });
  });

  it('not running: the total active time (the bar labels it 활성)', () => {
    const d = head(CARD({ activityState: 'idle' }), 'idle');
    expect(d).toMatchObject({ status: 'idle', activeMs: 65_000 });
    expect(d.startedAt).toBeUndefined();
  });

  it('the chip is the bar’s (icon + word in the st-* tones) — the page draws no chip of its own', () => {
    expect(CSS).not.toMatch(/\.ps-chip \{/);
    expect(CSS).not.toMatch(/\.ps-icon \{/);
    expect(PAGE).toContain('<ui-status-bar class="panel-status" id="panel-status" lang="ko"></ui-status-bar>');
  });

  it('D4 g1: sleeping and archived are the bar’s idle state with the page’s word (the element draws the tone and glyph)', () => {
    expect(head(CARD({ activityState: 'idle' }), 'closed')).toMatchObject({ status: 'idle', words: { idle: '휴면' } });
    expect(head(CARD({ activityState: 'idle', terminated: true }), 'closed')).toMatchObject({
      status: 'idle',
      words: { idle: '보관' },
    });
  });
});

describe('세부 — Details inside 세션 정보 (D19)', () => {
  const details = (s: Record<string, unknown>) =>
    load<{ panelDetailsHtml(s: unknown): string }>(
      ['esc', 'toNum', 'pendingAutoResume', 'rootStatusOf', 'panelDetailsHtml'],
      [],
    ).panelDetailsHtml(s);
  const row = (html: string, label: string) => new RegExp(`<div><dt>${label}</dt><dd>(.*?)</dd></div>`).exec(html)?.[1];

  it('에이전트 · 시작한 사람 · 도구 호출 · 비용 · 활성 시간 · 워크플로 · 환경', () => {
    const html = details(CARD());
    // D3 E-10: the kit's fact list.
    expect(html.startsWith('<dl class="ui-dl pi-details">')).toBe(true);
    expect(row(html, '에이전트')).toBe('opus-5-5[1m]');
    expect(row(html, '시작한 사람')).toBe('Zhuge');
    expect(row(html, '도구 호출')).toBe('<span title="메인 7 · 서브에이전트 7">14</span>');
    expect(row(html, '비용')).toBe('$12.40');
    expect(row(html, '활성 시간')).toBe(
      `<span class="card-timer-live" data-leg-started="${T0}" data-accumulated="65000"></span>`,
    );
    expect(row(html, '워크플로')).toBe('zwork');
    expect(text(row(html, '환경') ?? '')).toBe('mac-mini h:1');
  });

  it('more subagents than the card carries: a lower bound; an idle session: no live leg; no record: no count', () => {
    expect(row(details(CARD({ agentsTotal: 5 })), '도구 호출')).toContain('>14+</span>');
    expect(row(details(CARD({ activityState: 'idle' })), '활성 시간')).toContain(
      'data-leg-started="0" data-accumulated="65000"',
    );
    expect(row(details(CARD({ agentRoot: undefined, agents: undefined })), '도구 호출')).toBeUndefined();
    // The head's status (rootStatusOf): a waiting session's leg counts, as on the chip.
    expect(row(details(CARD({ activityState: 'waiting' })), '활성 시간')).toContain(`data-leg-started="${T0}"`);
    expect(clientFn('panelDetailsHtml')).toContain('var st = rootStatusOf(s, col);');
    expect(clientFn('renderPanelInfo')).toContain('panelInfoHtml(s, _panelInfoOpen, sessionColOf(panelSessionKey))');
  });

  it('panelInfoHtml: the open body is context block → 세부 → token grid → thread; the grid keeps only token kinds', () => {
    const info = load<{ panelInfoHtml(s: unknown, open: boolean): string }>(
      [
        'esc',
        'escAttr',
        'toNum',
        'ctxLevel',
        'ctxPercent',
        'pendingAutoResume',
        'rootStatusOf',
        'panelDetailsHtml',
        'panelInfoHtml',
      ],
      ['PI_CHEV_SVG'],
      {
        formatTokens: (n: number) => `${n}`,
        formatNmSSs: (n: number) => `${n}ms`,
        cardTotalTokens: () => 1,
        safeHref: (u: string) => u,
        // The context block (<ui-context-window>'s slot) is pinned by its own suite; here it only has to sit first in the body.
        cwSlotHtml: () => '<div class="ui-tok cw-slot"><ui-context-window lang="ko"></ui-context-window></div>',
      },
    ).panelInfoHtml;
    const open = info(CARD(), true);
    const grid = /<dl class="ui-dl pi-grid">[\s\S]*?<\/dl>/.exec(open)?.[0] ?? '';
    for (const gone of ['소유자', '워크플로', '환경', '비용']) expect(grid, gone).not.toContain(gone);
    for (const kept of ['입력', '출력', '캐시 읽기', '캐시 쓰기']) expect(grid, kept).toContain(kept);
    const at = (needle: string) => open.indexOf(needle);
    // The context block (<ui-context-window>) — first in the body.
    const context = at('class="ui-tok cw-slot"');
    const order = [
      at('class="pi-body"'),
      context,
      at('<dl class="ui-dl pi-details">'),
      at('<dl class="ui-dl pi-grid">'),
      at('class="pi-thread"'),
    ];
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The collapsed summary is unchanged (spec 13).
    const sum = info(CARD(), false);
    expect(sum).not.toContain('pi-details');
    expect(sum.slice(sum.indexOf('class="pi-sum"'), sum.indexOf('</button>'))).toContain('$12.40');
  });
});

describe('template hygiene', () => {
  it('each new client name is declared once; the replaced renderers are gone; the new CSS adds no colour tokens', () => {
    for (const name of [
      // SSOT 2026-10-29 T5: the task runs (they replace the plan footer and the earlier-plan groups);
      // D3 E-22/E-23: drawn by <ui-task-runs> / <ui-task-plan> from this data.
      'taskRunsOf',
      'taskIdNum',
      'taskRunStart',
      'taskRunEnd',
      'taskTokTotal',
      'taskTotalsHtml',
      'taskElData',
      'taskRunsData',
      'taskPlanData',
      'taskRunsRestore',
      'TASK_RUN_STATUS',
      'panelAgentOutside',
      'TASK_RUNS_SHOWN',
      '_panelTaskOpen',
      // SSOT 2026-10-29 T2: Escape closes the detail card.
      'closeDetailCard',
      'renderPanelNeedsHead',
      'panelQuestionShown',
      'apAnnounce',
      'apSafeFocus',
      'panelDetailsHtml',
      // affectUI batch 1: <ui-approval-card>
      'acPermissionLock',
      'acQuestionLock',
      'acDetailDue',
      'acPermissionData',
      'acQuestionId',
      'acQuestionData',
      'acSlotHtml',
      'acPermissionsHtml',
      'acGoalDecisionHtml',
      'acQuestionHtml',
      'acHydrate',
      'acRepaint',
      'acFirstOpen',
      'acEvict',
      'acDrop',
      'acPost',
      'acRefusal',
      'answerPermission',
      'answerChoice',
      '_acState',
      'AC_SENT',
      'AC_SIBLING',
      // D3 E-08 / E-05: the head and the deck nav are elements fed from these.
      'sessionActionsOf',
      'panelHeadData',
      'panelHeadNoteHtml',
      'onPanelHeadAction',
      'PS_BAR_STATUS',
      'onDeckPage',
    ]) {
      expect(declarationCount(name), name).toBe(1);
    }
    for (const gone of [
      // SSOT 2026-10-29 T5: the plan footer and the earlier-plan groups gave way to the task runs.
      'planFootHtml',
      'planEarlierCounts',
      'planEarlierGroups',
      'planEarlierHtml',
      // D3 E-22/E-23: the rows, markers and details are the elements'.
      'renderPanelTaskItem',
      'renderTaskRun',
      'taskRunDetailHtml',
      'toggleTaskRun',
      'taskRunNumbers',
      'taskSkippedHtml',
      'formatTaskClock',
      'formatTaskStamp',
      'taskCount',
      'renderPermissionBlock',
      'apDetails',
      'apPermissionCardHtml',
      'apQuestionCardHtml',
      'apKeydown',
      'apRepaintQuestion',
      'repaintPermission',
      '_permAnswered',
      '_permNotes',
      'PERM_DECISIONS',
      'AP_KBD_APPROVE',
      'AP_ANSWERED',
      'AP_SENT',
      // D3 E-08 / E-05: the chip row and the deck's own ‹ › stepping are the elements'.
      'panelHeadHtml',
      'SESSION_ACTION_ARIA',
      'deckGo',
      'deckStep',
    ]) {
      expect(declarationCount(gone), gone).toBe(0);
      expect(TEMPLATE, gone).not.toMatch(new RegExp(`\\b${gone}\\(`));
    }
    // SSOT 2026-10-29 T5: the task runs' CSS (.tr-*) too.
    const ours = CSS.split('\n').filter((l) => /^\s*\.(pl|ap|pn|ac|tr)-|^\s*\.pi-details|^\s*\.ar-vh/.test(l));
    // D3: only the sums (.tr-total*) are the page's now.
    expect(ours.filter((l) => /^\s*\.tr-/.test(l)).every((l) => /^\s*\.tr-total/.test(l))).toBe(true);
    // D3 E-10 / E-13: 세부 is the kit's .ui-dl and the count the kit's .ui-count — no .pi-details / .pn-* rules.
    expect(ours.filter((l) => /^\s*\.(pi-details|pn-)/.test(l))).toEqual([]);
    expect(ours.length).toBeGreaterThan(3);
    for (const l of ours) expect(l, l).not.toMatch(/--[a-z-]+\s*:/);
  });
});
