/**
 * Dashboard task view (SSOT 2026-10-27): the session panel as a task view.
 * Executes the shipped client code cut out of renderDashboardPage()'s template
 * literal, cooked exactly as the browser receives it (the harness of
 * dashboard-three-surfaces-client.test.ts).
 *
 *   T1   the panel: a common surface on top (세션 정보 · 입력 필요 · 산출물),
 *        agent tabs below it (Main always first), and per tab Tasks (folded) ·
 *        작업 로그 (folded) · 지시와 답변 (open)
 *   T1.4 an answer reads as the answer itself; the raw record sits at its foot
 *   T1.5 a multiline composer with images, files and voice
 *   T1.6 minimal by default; 자세히 opens every detail
 *   T2   Tasks tell what happened to a task a later list dropped:
 *        완료 · 교체됨 (it had run — SSOT 2026-10-29 T5, was 중단) · 실행 안 됨
 *        (it never ran) — never running
 *   SSOT 2026-10-29 T5  the Tasks section lists the tasks that ran (start,
 *        end, tool calls, tokens; a row opens its detail), then the plan left,
 *        the never-run dropped ones folded, and the totals
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

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
/** A client var whose value spans lines (`var X = {` … `\n};`). */
function clientBlockVar(name: string): string {
  const start = TEMPLATE.indexOf(`\nvar ${name} = {`);
  if (start < 0) throw new Error(`client var ${name} not found`);
  return cook(TEMPLATE.slice(start + 1, TEMPLATE.indexOf('\n};', start) + 3));
}
function load<T>(fns: string[], vars: string[], inject: Record<string, unknown> = {}): T {
  const names = Object.keys(inject);
  const setter = '__set: function(n, v) { eval(n + " = v"); }';
  const varSrc = (v: string) => (TEMPLATE.includes(`\nvar ${v} = {\n`) ? clientBlockVar(v) : clientVar(v));
  const body = `${vars.map(varSrc).join('\n')}\n${fns.map(clientFn).join('\n')}\nreturn { ${[...fns, setter].join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}
/** The page markup as served (the template between <body> and the first <script>). */
const PAGE = cook(TEMPLATE.slice(TEMPLATE.indexOf('<body'), TEMPLATE.indexOf('<script>', TEMPLATE.indexOf('<body'))));
const CSS = cook(
  TEMPLATE.slice(TEMPLATE.indexOf('<style>'), TEMPLATE.indexOf('</style>', TEMPLATE.indexOf('<style>'))),
);

const T0 = 1_700_000_000_000;
const BASE_FNS = ['esc', 'escAttr', 'toNum', 'formatDuration', 'formatTaskTime', 'agentIconHtml'];
const BASE_VARS = [
  'AGENT_STATUS_LABEL',
  'AGENT_STATUS_TONE',
  'TASK_FATE_LABEL',
  'TASK_PAUSE_SVG',
  'TASK_STOP_SVG',
  'TASK_SKIP_SVG',
  'PI_CHEV_SVG',
];

type Task = Record<string, unknown>;
const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&middot;/g, '·');

// ── T2 — what a later list did to a task ──
describe('T2 · a dropped task never reads as running or waiting', () => {
  const plan = load<{
    taskFateOf(t: Task): string;
    renderPanelTaskItem(t: Task, pop?: boolean): string;
    renderTaskMeta(t: Task): string;
  }>([...BASE_FNS, 'taskFateOf', 'renderPanelTaskItem', 'renderTaskMeta'], BASE_VARS);

  it('names every fate: done · running · paused · waiting · replaced (dropped after it ran) · not run (dropped before)', () => {
    expect(plan.taskFateOf({ status: 'completed' })).toBe('done');
    expect(plan.taskFateOf({ status: 'in_progress', startedAt: T0 })).toBe('active');
    expect(plan.taskFateOf({ status: 'pending', startedAt: T0 })).toBe('paused');
    expect(plan.taskFateOf({ status: 'pending' })).toBe('pending');
    expect(plan.taskFateOf({ status: 'in_progress', startedAt: T0, dropped: 'started' })).toBe('dropped');
    expect(plan.taskFateOf({ status: 'pending', dropped: 'unstarted' })).toBe('skipped');
  });

  // SSOT 2026-10-29 T5: a task a new plan replaced after it ran reads 교체됨 (was 중단) — it
  // was not stopped, a new list took its place, and its work stays counted on it.
  it('a task a new plan replaced while it ran reads 교체됨 (SSOT 2026-10-29 T5) with no spinner and no live clock', () => {
    const html = plan.renderPanelTaskItem({
      id: 'T2',
      content: 'RED 테스트',
      status: 'in_progress',
      startedAt: T0,
      removedAt: T0 + 90_000,
      toolCalls: 3,
      dropped: 'started',
    });
    expect(html).toContain('data-step="dropped"');
    expect(html).toContain('<span class="pl-fate">교체됨</span>');
    expect(html).not.toContain('중단');
    expect(html).not.toContain('task-elapsed');
    expect(html).not.toContain('spinner');
    expect(html).not.toContain('aria-current');
    expect(html).toContain('1m 30s');
  });

  it('a task dropped before it ran reads 실행 안 됨, never 대기', () => {
    const html = plan.renderPanelTaskItem({
      id: 'T3',
      content: '구현',
      status: 'pending',
      toolCalls: 0,
      dropped: 'unstarted',
    });
    expect(html).toContain('data-step="skipped"');
    expect(html).toContain('실행 안 됨');
    expect(html).not.toContain('대기');
  });

  it('a task the session stopped on reads 멈춤 (it had started), not 대기', () => {
    const html = plan.renderPanelTaskItem({
      id: 'T4',
      content: '검증',
      status: 'pending',
      startedAt: T0,
      toolCalls: 2,
    });
    expect(html).toContain('data-step="paused"');
    expect(html).toContain('멈춤');
    expect(html).not.toContain('task-elapsed');
  });

  it('the work-log group head of a replaced task carries no live clock and reads 교체됨 (SSOT 2026-10-29 T5)', () => {
    const meta = plan.renderTaskMeta({
      status: 'in_progress',
      startedAt: T0,
      removedAt: T0 + 5000,
      toolCalls: 1,
      dropped: 'started',
    });
    expect(meta).not.toContain('task-elapsed');
    expect(meta).toContain('교체됨 5s');
    expect(meta).not.toContain('중단');
  });
});

// ── SSOT 2026-10-29 T5 — the tasks that ran, in the order they ran ──
// The model rewrites its list as it goes, so "the list" is not what happened. The
// Tasks section reads the whole ledger (the current list and the earlier ones) as
// runs — every task that ran, whatever became of it — then the plan left, then the
// tasks a new plan dropped before they ran (never work).
describe('SSOT 2026-10-29 T5 · taskRunsOf: the runs, the plan left and the skipped', () => {
  const m = load<{
    taskRunsOf(current: Task[] | null, earlier: Task[] | null): { ran: Task[]; plan: Task[]; skipped: Task[] };
    taskRunStart(t: Task): number;
    taskIdNum(t: Task): number;
  }>(['toNum', 'taskFateOf', 'taskIdNum', 'taskRunStart', 'taskRunsOf'], []);
  const ids = (ts: Task[]) => ts.map((t) => t.id);

  it('done, running, paused and replaced tasks are runs, oldest start first; never-started ones are the plan; never-run dropped ones are skipped', () => {
    const r = m.taskRunsOf(
      [
        { id: 'T5', status: 'in_progress', startedAt: T0 + 60_000 },
        { id: 'T6', status: 'pending' },
        { id: 'T8', status: 'completed', startedAt: T0, completedAt: T0 + 30_000 },
        { id: 'T9', status: 'pending', startedAt: T0 + 10_000 }, // paused: it had started
        { id: 'T7', status: 'pending' },
      ],
      [
        { id: 'T4', status: 'pending', dropped: 'unstarted', removedAt: T0 - 30_000 },
        { id: 'T2', status: 'in_progress', startedAt: T0 - 90_000, dropped: 'started', removedAt: T0 - 30_000 },
        { id: 'T1', status: 'completed', startedAt: T0 - 200_000, completedAt: T0 - 100_000, removedAt: T0 - 30_000 },
        { id: 'T3', status: 'pending', dropped: 'unstarted', removedAt: T0 - 30_000 },
      ],
    );
    // Current and earlier lists mix: the order is when each ran, not which list held it.
    expect(ids(r.ran)).toEqual(['T1', 'T2', 'T8', 'T9', 'T5']);
    // The plan left has not run (no start to sort by): it keeps the list's order.
    expect(ids(r.plan)).toEqual(['T6', 'T7']);
    expect(ids(r.skipped)).toEqual(['T4', 'T3']);
    expect(m.taskRunsOf(null, null)).toEqual({ ran: [], plan: [], skipped: [] });
  });

  it('a run starts at its first start (kept when it went back to waiting), else its start, its completion, or when it left the list', () => {
    expect(m.taskRunStart({ firstStartedAt: T0, startedAt: T0 + 5000 })).toBe(T0);
    expect(m.taskRunStart({ startedAt: T0 + 5000 })).toBe(T0 + 5000);
    expect(m.taskRunStart({ completedAt: T0 + 900 })).toBe(T0 + 900);
    expect(m.taskRunStart({ removedAt: T0 + 1200 })).toBe(T0 + 1200);
    // A task restarted later still sits where it first ran.
    const r = m.taskRunsOf(
      [
        { id: 'T2', status: 'in_progress', firstStartedAt: T0, startedAt: T0 + 5000 },
        { id: 'T1', status: 'completed', startedAt: T0 + 1000, completedAt: T0 + 2000 },
      ],
      [],
    );
    expect(ids(r.ran)).toEqual(['T2', 'T1']);
  });

  it('a task that went back to waiting with only its first start kept is paused — it ran, so it is a run, not the plan left (review R1)', () => {
    // The ledger clears startedAt when a task goes back to pending and keeps firstStartedAt.
    const r = m.taskRunsOf([{ id: 'T3', content: 'c', status: 'pending', firstStartedAt: T0, toolCalls: 2 }], []);
    expect(ids(r.ran)).toEqual(['T3']);
    expect(r.plan).toEqual([]);
    expect(m.taskRunStart(r.ran[0])).toBe(T0);
    // Never started at all: the plan left.
    expect(ids(m.taskRunsOf([{ id: 'T4', content: 'd', status: 'pending' }], []).plan)).toEqual(['T4']);
  });

  it('runs that started at the same moment go by id number — T9 before T10, not by text', () => {
    expect(m.taskIdNum({ id: 'T10' })).toBe(10);
    expect(m.taskIdNum({ id: 'x' })).toBe(0);
    const r = m.taskRunsOf(
      [
        { id: 'T10', status: 'completed', startedAt: T0, completedAt: T0 + 1 },
        { id: 'T9', status: 'completed', startedAt: T0, completedAt: T0 + 1 },
      ],
      [],
    );
    expect(ids(r.ran)).toEqual(['T9', 'T10']);
  });
});

describe('SSOT 2026-10-29 T5 · the panel Tasks section: what ran, the plan left, the skipped folded, the totals', () => {
  function container() {
    return {
      style: { display: '' },
      _html: '',
      innerHTML: '',
      _planScope: null as unknown,
      _planSeen: null as unknown,
    };
  }
  const el = container();
  // toggleTaskRun repaints through repaintPanelTasks (the focused agent's lists): here, this test's lists.
  let repaint = () => {};
  const env = load<{
    renderPanelTasks(tasks: Task[] | undefined, scope: string, earlier: Task[], outside?: unknown): void;
    toggleTaskRun(id: string): void;
    formatTaskClock(ts: number): string;
    formatTaskStamp(ts: number): string;
    __set(n: string, v: unknown): void;
  }>(
    [
      ...BASE_FNS,
      'escJs',
      'formatTokens',
      'taskFateOf',
      'renderPanelTaskItem',
      'taskIdNum',
      'taskRunStart',
      'taskRunEnd',
      'taskRunsOf',
      'taskTokTotal',
      'formatTaskClock',
      'formatTaskStamp',
      'taskCount',
      'taskRunNumbers',
      'toggleTaskRun',
      'renderTaskRun',
      'taskRunDetailHtml',
      'taskSkippedHtml',
      'taskTotalsHtml',
      'planSummaryHtml',
      'renderPanelTasks',
    ],
    [...BASE_VARS, '_panelTasksOpen', '_panelTasksExpanded', '_panelTasksEarlier', 'TASK_RUNS_SHOWN', '_panelTaskOpen'],
    {
      document: { getElementById: (id: string) => (id === 'panel-tasks' ? el : null) },
      morphInnerHtml: (target: { innerHTML: string }, html: string) => {
        target.innerHTML = html;
      },
      updateTimersIn: () => {},
      repaintPanelTasks: () => repaint(),
    },
  );
  const current: Task[] = [
    {
      id: 'T5',
      content: 'ledger 수정',
      activeForm: 'ledger 수정 중',
      status: 'in_progress',
      startedAt: T0 + 60_000,
      toolCalls: 2,
      tokens: { input: 2000, output: 500, cacheRead: 1000, cacheCreate: 0, costUsd: 0.1 },
    },
    { id: 'T6', content: '화면 수정', status: 'pending', toolCalls: 0 },
    {
      id: 'T8',
      content: '정리',
      status: 'completed',
      startedAt: T0,
      completedAt: T0 + 30_000,
      toolCalls: 1,
      agentToolCalls: 3,
      tokens: { input: 1000, output: 500, cacheRead: 0, cacheCreate: 0, costUsd: 0.05 },
    },
  ];
  const earlier: Task[] = [
    { id: 'T4', content: 'PR', status: 'pending', dropped: 'unstarted', removedAt: T0 - 30_000 },
    { id: 'T3', content: '구현', status: 'pending', dropped: 'unstarted', removedAt: T0 - 30_000 },
    {
      id: 'T2',
      content: 'RED',
      status: 'in_progress',
      startedAt: T0 - 90_000,
      dropped: 'started',
      removedAt: T0 - 30_000,
      toolCalls: 4,
    },
    {
      id: 'T1',
      content: '조사',
      status: 'completed',
      startedAt: T0 - 200_000,
      completedAt: T0 - 100_000,
      removedAt: T0 - 30_000,
      toolCalls: 5,
    },
  ];
  // A row ends with its aside (an open detail may hold a nested list).
  const runRows = (html: string) =>
    [
      ...html.matchAll(
        /<li class="panel-task-item pl-step tr-run[^"]*"[^>]*>[\s\S]*?<span class="pl-aside">(?:<span class="task-elapsed"[^>]*><\/span>|[^<]*)<\/span><\/li>/g,
      ),
    ].map((m) => m[0]);
  const runIds = (html: string) => runRows(html).map((x) => /<span class="task-id">#(T\d+)<\/span>/.exec(x)?.[1]);
  const open = (o: { earlier?: boolean } = {}) => {
    env.__set('_panelTasksOpen', true);
    env.__set('_panelTasksExpanded', false);
    env.__set('_panelTasksEarlier', !!o.earlier);
    env.__set('_panelTaskOpen', Object.create(null));
  };

  it('folds by default: one head — the running step, 실행 N · 완료 d, 남은 p, 빠짐 s — no list', () => {
    env.__set('_panelTasksOpen', false);
    env.renderPanelTasks(current, '', earlier);
    expect(el.innerHTML).toContain('aria-expanded="false"');
    expect(el.innerHTML).toContain(
      '<span class="ps-sec-now"><span class="spinner ag-spinner" aria-hidden="true"></span>ledger 수정 중</span>',
    );
    // Four ran (two completed), one is left of the plan, two were dropped before they ran.
    expect(text(el.innerHTML)).toContain('ledger 수정 중·실행 4 · 완료 2·남은 1·빠짐 2');
    expect(el.innerHTML).not.toContain('pl-list');
    // No list at all: 목록 없음 (still counting what a new plan dropped).
    env.renderPanelTasks([], '', []);
    expect(text(el.innerHTML)).toContain('목록 없음');
    env.renderPanelTasks([], '', earlier.slice(0, 2));
    expect(text(el.innerHTML)).toContain('목록 없음·빠짐 2');
  });

  it('opened: 실행된 태스크 in the order they started, then 남은 계획, then the skipped toggle, then the totals', () => {
    open();
    env.renderPanelTasks(current, '', earlier);
    const html = el.innerHTML;
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain(
      '<div class="tr-head">실행된 태스크 <span class="tr-count">4</span></div><ol class="pl-list tr-list" aria-label="실행된 태스크">',
    );
    expect(runIds(html)).toEqual(['T1', 'T2', 'T8', 'T5']);
    expect(html).toContain(
      '<div class="tr-head">남은 계획 <span class="tr-count">1</span></div><ol class="pl-list tr-plan" aria-label="남은 계획">',
    );
    const at = ['pl-list tr-list', 'pl-list tr-plan', '실행 전에 계획에서 빠짐', 'class="tr-total"'].map((n) =>
      html.indexOf(n),
    );
    expect(at.every((i) => i > -1)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // The plan left is the plan step it was (renderPanelTaskItem): waiting, no clock, no tools yet.
    const plan = html.slice(html.indexOf('class="pl-list tr-plan"'), html.indexOf('</ol>', html.indexOf('tr-plan')));
    expect(plan).toContain('data-step="pending"');
    expect(plan).toContain('#T6');
    // Only the running task spins and is the current step.
    expect(html.match(/data-step="active"/g)?.length).toBe(1);
    expect(html.match(/aria-current="step"/g)?.length).toBe(1);
  });

  it('a task a new plan replaced after it ran is a run: 교체됨, its tools and how long it ran — never a clock', () => {
    open();
    env.renderPanelTasks(current, '', earlier);
    const t2 = runRows(el.innerHTML).find((r) => r.includes('#T2')) ?? '';
    expect(t2).toContain('data-step="dropped"');
    expect(t2).toContain('<span class="task-text">RED</span><span class="pl-fate">교체됨</span>');
    expect(t2).toContain('<span class="ar-vh">, 교체됨</span>');
    expect(t2).toContain(
      `<span class="tr-meta">${env.formatTaskClock(T0 - 90_000)} → ${env.formatTaskClock(T0 - 30_000)}<span class="pi-dot" aria-hidden="true">&middot;</span>툴 4 · 토큰 기록 없음</span>`,
    );
    expect(t2).toContain('<span class="pl-aside">1m 0s</span>');
    expect(t2).not.toContain('task-elapsed');
    expect(t2).not.toContain('spinner');
  });

  it('a task a new plan dropped before it ran is never a run: it waits behind 실행 전에 계획에서 빠짐 N', () => {
    open();
    env.renderPanelTasks(current, '', earlier);
    expect(runIds(el.innerHTML)).not.toContain('T3');
    expect(runIds(el.innerHTML)).not.toContain('T4');
    expect(el.innerHTML).toContain(
      '<button type="button" class="panel-tasks-toggle panel-tasks-earlier-toggle" aria-expanded="false" onclick="_panelTasksEarlier=!_panelTasksEarlier;repaintPanelTasks()"><span class="chev" aria-hidden="true"></span>실행 전에 계획에서 빠짐 <span class="pl-earlier-counts">2</span></button>',
    );
    expect(el.innerHTML).not.toContain('#T3');
    open({ earlier: true });
    env.renderPanelTasks(current, '', earlier);
    const skipped = el.innerHTML.slice(el.innerHTML.indexOf('<ol class="pl-list pl-earlier"'));
    expect(skipped).toMatch(/^<ol class="pl-list pl-earlier" aria-label="실행 전에 계획에서 빠진 태스크">/);
    expect(skipped.match(/data-step="skipped"/g)?.length).toBe(2);
    expect(skipped.indexOf('#T4')).toBeLessThan(skipped.indexOf('#T3'));
    expect(runIds(el.innerHTML)).toEqual(['T1', 'T2', 'T8', 'T5']);
  });

  it("the row is a button: its onclick toggleTaskRun('T2') opens the run's detail under it, and closes it again", () => {
    open();
    repaint = () => env.renderPanelTasks(current, '', earlier);
    repaint();
    const row = runRows(el.innerHTML).find((r) => r.includes('#T2')) ?? '';
    const onclick = /<button type="button" class="tr-row" aria-expanded="false" onclick="([^"]+)">/.exec(row)?.[1];
    expect(onclick).toBe("toggleTaskRun('T2')");
    new Function('toggleTaskRun', onclick ?? '')(env.toggleTaskRun);
    const opened = runRows(el.innerHTML).find((r) => r.includes('#T2')) ?? '';
    expect(opened).toContain('pl-step tr-run dropped is-open');
    expect(opened).toContain('<button type="button" class="tr-row" aria-expanded="true"');
    expect(opened).toContain(
      `<dl class="tr-detail"><dt>시작</dt><dd>${env.formatTaskStamp(T0 - 90_000)}</dd>` +
        `<dt>종료</dt><dd>${env.formatTaskStamp(T0 - 30_000)} (새 계획으로 교체)</dd>` +
        '<dt>소요</dt><dd>1m 0s</dd><dt>도구</dt><dd>메인 4회</dd>' +
        '<dt>토큰</dt><dd>기록 없음 (태스크별 집계 이전에 실행됨)</dd></dl>',
    );
    // Only that run opened.
    expect(el.innerHTML.match(/class="tr-detail"/g)?.length).toBe(1);
    new Function('toggleTaskRun', onclick ?? '')(env.toggleTaskRun);
    expect(el.innerHTML).not.toContain('tr-detail');
    repaint = () => {};
  });

  it('an opened run’s detail is keyed by task id, so it never carries to another session or another agent’s tab', () => {
    // T1 of one session (or of one subagent) is not T1 of another: both reset the open map.
    const open = clientFn('openPanel');
    expect(open).toMatch(/if \(!sameSession\) \{[^}]*_panelTaskOpen = Object\.create\(null\);/);
    expect(clientFn('selectPanelAgent')).toContain('if (next !== _panelAgent) _panelTaskOpen = Object.create(null);');
  });

  it('the totals: 합계 sums every run (tools, +서브, tokens, cost); 태스크 밖 is the work no task got', () => {
    open();
    const outside = { toolCalls: 3, agentToolCalls: 1, tokens: { input: 800, output: 200 } };
    env.renderPanelTasks(current, '', earlier, outside);
    // 5 + 4 + 1 + 2 tools, T8's 3 subagent calls; tokens 1.5K + 3.5K, $0.05 + $0.10 (the runs that recorded them).
    expect(el.innerHTML).toContain(
      '<div class="tr-total"><span class="tr-total-k">합계</span>툴 12 (+서브 3) · 5.0K tok · $0.15</div>',
    );
    expect(el.innerHTML).toContain(
      '<div class="tr-total tr-outside"><span class="tr-total-k">태스크 밖</span>툴 3 (+서브 1) · 1.0K tok</div>',
    );
    // Nothing outside the tasks: no 태스크 밖 row.
    env.renderPanelTasks(current, '', earlier, { toolCalls: 0, tokens: {} });
    expect(el.innerHTML).not.toContain('tr-outside');
    // No run recorded tokens: the tools alone.
    env.renderPanelTasks(
      [{ id: 'T1', content: 'a', status: 'completed', startedAt: T0, completedAt: T0 + 1, toolCalls: 2 }],
      '',
      [],
    );
    expect(el.innerHTML).toContain('<div class="tr-total"><span class="tr-total-k">합계</span>툴 2</div>');
    // Nothing ran yet: no totals.
    env.renderPanelTasks([{ id: 'T1', content: 'a', status: 'pending' }], '', []);
    expect(el.innerHTML).not.toContain('tr-total');
    expect(el.innerHTML).not.toContain('실행된 태스크');
    env.renderPanelTasks([], '', []);
    expect(el.innerHTML).toContain('<div class="panel-tasks-empty">아직 작업 목록이 없습니다</div>');
  });
});

describe('T2 · a subagent tab shows its own earlier plans too', () => {
  it('panelAgentEarlier reads the focused subagent', () => {
    const s = {
      earlierTasks: [{ id: 'T1' }],
      agents: [{ id: 'toolu_a', n: 1, earlierTasks: [{ id: 'T9', dropped: 'unstarted' }] }],
    };
    const env = load<{ panelAgentEarlier(): Task[]; __set(n: string, v: unknown): void }>(
      ['panelAgentOf', 'panelAgentEarlier'],
      [],
      { panelSessionKey: 'k', _sessionCache: { k: s }, _panelAgent: 'toolu_a' },
    );
    expect(env.panelAgentEarlier()).toEqual([{ id: 'T9', dropped: 'unstarted' }]);
    env.__set('_panelAgent', '');
    expect(env.panelAgentEarlier()).toEqual([{ id: 'T1' }]);
  });
});

// ── T1 — the panel layout ──
describe('T1 · the panel: a common surface, agent tabs, three sections per tab', () => {
  // The panel's open tag carries the detail deck's depth now (SSOT 2026-10-29 T2: data-deck).
  const panel = PAGE.slice(PAGE.indexOf('<div class="slide-panel" id="slide-panel"'), PAGE.indexOf('<!-- New task'));
  const at = (needle: string) => {
    const i = panel.indexOf(needle);
    if (i < 0) throw new Error(`missing ${needle}`);
    return i;
  };

  it('T1.6 · the head carries the 자세히 switch, off by default', () => {
    const head = panel.slice(at('<div class="panel-header">'), at('<div class="panel-body"'));
    expect(head).toMatch(
      /<button type="button" class="panel-detail-toggle" id="panel-detail-toggle" aria-pressed="false"/,
    );
    expect(head).toContain('자세히');
  });

  it('T1.1 · the surface holds 세션 정보 · 입력 필요 · 산출물, above the tabs', () => {
    const surface = at('<section class="panel-surface" id="panel-surface"');
    expect(at('id="panel-info"')).toBeGreaterThan(surface);
    expect(at('id="panel-needs-head"')).toBeGreaterThan(at('id="panel-info"'));
    expect(at('id="panel-permission"')).toBeGreaterThan(at('id="panel-needs-head"'));
    expect(at('id="panel-question"')).toBeGreaterThan(at('id="panel-permission"'));
    expect(at('id="panel-artifacts"')).toBeGreaterThan(at('id="panel-question"'));
    expect(at('id="panel-tabs"')).toBeGreaterThan(at('id="panel-artifacts"'));
  });

  it('T1.2/T1.3 · the tab list, then one tab panel: Tasks, then the section tabs Chat · 작업 로그 · 에이전트 트리 (SSOT 2026-10-29 T6)', () => {
    expect(panel).toMatch(/<div class="panel-tabs" id="panel-tabs" role="tablist" aria-label="에이전트"/);
    const tabpanel = at('id="panel-tabpanel"');
    expect(panel).toMatch(/<section class="panel-tabpanel" id="panel-tabpanel" role="tabpanel"/);
    expect(tabpanel).toBeGreaterThan(at('id="panel-tabs"'));
    expect(at('id="panel-tasks"')).toBeGreaterThan(tabpanel);
    expect(panel).toMatch(
      /<div class="panel-sections" id="panel-sections" role="tablist" aria-label="섹션" aria-orientation="horizontal">/,
    );
    expect(at('id="panel-sections"')).toBeGreaterThan(at('id="panel-tasks"'));
    // The tabs in order, each controlling its own tab panel (its own scroll box). SSOT 2026-10-29 T6:
    // Chat (지시와 답변) first, then 작업 로그, and 에이전트 트리 at the strip's right end.
    expect(at('id="psec-tab-conv"')).toBeGreaterThan(at('id="panel-sections"'));
    expect(at('id="psec-tab-log"')).toBeGreaterThan(at('id="psec-tab-conv"'));
    expect(at('id="psec-tab-tree"')).toBeGreaterThan(at('id="psec-tab-log"'));
    expect(panel).toContain('title="지시와 답변">Chat</button>');
    expect(panel).toContain('class="psec-tab psec-tab-tree" role="tab" id="psec-tab-tree"');
    for (const sec of ['tree', 'log', 'conv']) {
      expect(panel).toMatch(
        new RegExp(`id="psec-tab-${sec}" data-sec="${sec}" aria-selected="(true|false)" aria-controls="psec-${sec}"`),
      );
    }
    expect(panel).toMatch(
      /<div class="psec" id="psec-tree" role="tabpanel" aria-labelledby="psec-tab-tree" tabindex="0"/,
    );
    // D3: 작업 로그 is <ui-work-log>'s own scroll box (its viewport is the tab stop).
    expect(panel).toContain(
      '<div class="psec psec-el ui-tok" id="psec-log" role="tabpanel" aria-labelledby="psec-tab-log" hidden>',
    );
    // D3 E-25: 지시와 답변's box is <ui-conversation>'s own scroller (its viewport is the one tab stop).
    expect(panel).toContain(
      '<div class="psec psec-el ui-tok" id="psec-conv" role="tabpanel" aria-labelledby="psec-tab-conv">',
    );
    expect(at('id="psec-tree"')).toBeGreaterThan(at('id="panel-sections-body"'));
    expect(at('id="worklog-list"')).toBeGreaterThan(at('id="psec-log"'));
    expect(at('id="panel-conv"')).toBeGreaterThan(at('id="psec-conv"'));
    expect(panel).not.toContain('id="panel-turns"');
    // Chat (지시와 답변) is the default tab: selected, the one tab stop, its panel the one shown.
    expect(panel).toContain(
      'id="psec-tab-conv" data-sec="conv" aria-selected="true" aria-controls="psec-conv" tabindex="0"',
    );
    expect(panel).toContain(
      'id="psec-tab-log" data-sec="log" aria-selected="false" aria-controls="psec-log" tabindex="-1"',
    );
    expect(panel).toMatch(/id="psec-log" role="tabpanel"[^>]* hidden>/);
    expect(panel).toMatch(/id="psec-conv" role="tabpanel"[^>]*>\s*<ui-conversation /);
    // No disclosure heads for these sections any more.
    expect(panel).not.toMatch(/id="(conv|worklog)-toggle"/);
  });

  it('T1.2 · the tab list sticks while the conversation scrolls, Main sticks at its left', () => {
    expect(CSS).toMatch(/\.panel-tabs \{[^}]*position: sticky;[^}]*top: 0;/);
    expect(CSS).toMatch(/\.panel-tab\.is-main \{[^}]*position: sticky;[^}]*left: 0;/);
  });

  it('T1.6 · minimal by default: the agent path only with 자세히; the subtree is the 에이전트 트리 tab', () => {
    expect(CSS).toMatch(/\.slide-panel:not\(\.is-detail\) \.pa-bar/);
    // The tree is a section tab of its own now: never hidden by the minimal view, never capped.
    expect(CSS).not.toMatch(/\.slide-panel:not\(\.is-detail\) \.pa-tree/);
    expect(CSS).toContain('.pa-tree { display: block; }');
    expect(PAGE).toContain('<div class="psec-body panel-tree" id="panel-tree"></div>');
  });
});

describe('T1.2 · the agent tabs', () => {
  const env = load<{ panelTabsHtml(s: unknown, active: string): string }>(
    [...BASE_FNS, 'agentStatusOf', 'agentName', 'panelTabsHtml'],
    BASE_VARS,
  );
  const s = {
    model: 'claude-opus-5-5',
    activityState: 'working',
    agents: [
      { id: 'toolu_b', n: 2, type: 'Plan', status: 'completed', startedAt: T0 + 10 },
      { id: 'toolu_a', n: 1, type: 'Explore', status: 'running', startedAt: T0 },
    ],
  };

  it('Main is always the first tab, the subagents follow in spawn order', () => {
    const html = env.panelTabsHtml(s, '');
    const ids = [...html.matchAll(/data-agent-tab="([^"]*)"/g)].map((m) => m[1]);
    expect(ids).toEqual(['', 'toolu_a', 'toolu_b']);
    expect(html).toMatch(/class="panel-tab is-main[^"]*"[^>]*role="tab"/);
    expect(html).toContain('Main');
    expect(html).toContain('A1');
    expect(html).toContain('Explore');
  });

  it('one tab is selected and holds the tab stop', () => {
    const html = env.panelTabsHtml(s, 'toolu_b');
    expect(html.match(/aria-selected="true"/g)?.length).toBe(1);
    expect(html.match(/tabindex="0"/g)?.length).toBe(1);
    expect(html).toMatch(
      /data-agent-tab="toolu_b"[^>]*aria-selected="true"|aria-selected="true"[^>]*data-agent-tab="toolu_b"/,
    );
  });

  it('a session with no subagent still shows Main', () => {
    const html = env.panelTabsHtml({ model: 'x' }, '');
    expect(html).toContain('data-agent-tab=""');
    expect(html).toContain('aria-selected="true"');
  });
});

// ── T1.4 — the answer first, the raw record at its foot ──
describe('T1.4 · an assistant turn reads as its answer; Raw sits at the bottom (<ui-conversation>)', () => {
  it('the turn hands the element its answer (loading until fetched) and the summary for Raw — never a closed disclosure', () => {
    const src = clientFn('convTurnsOf');
    // The answer is the turn's face: markdown once loaded, loading before.
    expect(src).toContain('a.markdown = raw;');
    expect(src).toContain('else a.loading = true;');
    // Raw (요약 · 원문) is the element's, at the turn's foot: the summary and the source it is handed.
    expect(src).toContain('if (sum.title || sum.text) a.summary = sum;');
    expect(clientFn('convSummaryOf')).toContain('t.summaryBody');
    expect(TEMPLATE).not.toContain('답변 전문');
  });
});

// ── T1.5 — the composer ──
describe('T1.5 · the steering composer: multiline, images, files, voice', () => {
  const cmd = PAGE.slice(PAGE.indexOf('<div class="panel-command" id="panel-command">'), PAGE.indexOf('<!-- New task'));

  // Dashboard batch 2: the field is <ui-agent-steering>'s (multiline, grows with its text); the page's tools sit in
  // its slot="tools" and the chips, the recorder and the error in slot="attachments".
  it('is <ui-agent-steering> with the attach / image / mic tools in its field', () => {
    expect(cmd).toContain('<ui-agent-steering id="cmd-steer" lang="ko">');
    expect(cmd).not.toMatch(/<textarea|id="cmd-input"|id="cmd-send"/);
    const tools = cmd.slice(cmd.indexOf('<span slot="tools" class="pc-tools">'), cmd.indexOf('</ui-agent-steering>'));
    expect(tools).toContain('id="pc-attach"');
    expect(tools).toContain('id="pc-mic"');
    const top = cmd.slice(cmd.indexOf('<div slot="attachments" class="pc-top">'), cmd.indexOf('<span slot="tools"'));
    expect(top).toContain('id="pc-attachments"');
    expect(top).toContain('id="pc-recorder"');
    expect(top).toContain('id="pc-error"');
    expect(cmd).toContain('id="pc-attach"');
    expect(cmd).toContain('id="pc-image"');
    expect(cmd).toMatch(/id="pc-mic"[^>]*aria-pressed="false"/);
    expect(cmd).toContain('id="pc-attachments"');
    expect(cmd).toContain('id="pc-recorder"');
    expect(cmd).toMatch(/<input type="file" id="pc-file-input" multiple hidden/);
    expect(cmd).toMatch(/<input type="file" id="pc-image-input" accept="image\/\*"/);
    // Model · effort sit above the composer.
    expect(cmd.indexOf('id="panel-controls"')).toBeLessThan(cmd.indexOf('id="cmd-steer"'));
  });

  const pc = load<{
    pcCommandBody(message: string, files: Array<Record<string, unknown>>): unknown;
    pcCanSend(message: string, files: unknown[]): boolean;
  }>(['pcCommandBody', 'pcCanSend'], []);

  // Enter sends, Shift+Enter breaks the line, an IME composition (한글, keyCode 229) never sends, a phone's Enter is a
  // line break: the element's own keys now — @2lab.ai/ui agent-steering.test.ts "steerEnterAction: IME-safe, Shift
  // and touch make a new line, ⌘/Ctrl steers only while running" and "Shift+Enter, IME composition and keyCode 229
  // never send". The page keeps no key handler of its own.
  it('the page has no key handler of its own on the composer', () => {
    expect(TEMPLATE).not.toMatch(/function pcKeydown\(|function pcEnterAction\(|function pcAutosize\(/);
  });

  it('the body carries the files as base64 attachments; a files-only send is allowed', () => {
    expect(
      pc.pcCommandBody('hi\nthere', [{ name: 'a.png', mimetype: 'image/png', data: 'QUJD', size: 3, url: 'blob:x' }]),
    ).toEqual({
      message: 'hi\nthere',
      attachments: [{ name: 'a.png', mimetype: 'image/png', data: 'QUJD' }],
    });
    expect(pc.pcCommandBody('hi', [])).toEqual({ message: 'hi' });
    expect(pc.pcCanSend('', [{}])).toBe(true);
    expect(pc.pcCanSend('  ', [])).toBe(false);
    expect(pc.pcCanSend('x', [])).toBe(true);
  });
});

describe('T1.6 · 자세히 is a saved per-device choice, off unless saved on', () => {
  const env = load<{ panelDetailFrom(saved: unknown): boolean }>(['panelDetailFrom'], []);
  it('reads the saved value', () => {
    expect(env.panelDetailFrom('1')).toBe(true);
    expect(env.panelDetailFrom('0')).toBe(false);
    expect(env.panelDetailFrom(null)).toBe(false);
  });
});

// ── review r1 (trinity astra P1/P2, fable P2) ──
describe('review r1 · a subagent tab never shows a background start acknowledgement as its answer', () => {
  const env = load<{
    agentConvEntries(entries: unknown[], id: string, background?: boolean): { spawn: unknown; result: unknown };
  }>(['agentConvEntries'], []);
  const log = [
    { seq: 1, kind: 'tool', tool: 'Agent', agentRef: 'a1' },
    { seq: 2, kind: 'tool_result', tool: 'Agent', ok: true, agentRef: 'a1', text: 'Async agent launched' },
  ];
  it('foreground: the result is the answer; background: no answer from the ack (a failed spawn still is one)', () => {
    expect(env.agentConvEntries(log, 'a1', false).result).toEqual(log[1]);
    expect(env.agentConvEntries(log, 'a1', true).result).toBeNull();
    const failed = [log[0], { ...log[1], ok: false }];
    expect(env.agentConvEntries(failed, 'a1', true).result).toEqual(failed[1]);
  });
});

describe('review r1 · a recording belongs to the card it was started for', () => {
  type Rec = Record<string, unknown>;
  function harness() {
    const added: string[] = [];
    const env = load<{
      pcRecCurrent(gen: number, key: string): boolean;
      pcFinishRecording(state: Rec): void;
      __set(n: string, v: unknown): void;
    }>(['pcRecCurrent', 'pcFinishRecording'], [], {
      _pcRecGen: 0,
      panelSessionKey: 'A',
      panelOpen: true,
      Blob: class {
        constructor(
          public parts: unknown[],
          public opts: unknown,
        ) {}
      },
      ntStamp: () => 'stamp',
      ntExtForMime: () => 'm4a',
      pcAddBlob: (_b: unknown, name: string) => added.push(name),
    });
    return { env, added };
  }
  const state = (o: Rec = {}) => ({
    keep: true,
    finished: false,
    chunks: [1],
    mime: 'audio/mp4',
    started: 0,
    stoppedAt: 2000,
    gen: 0,
    key: 'A',
    resolve: () => {},
    ...o,
  });

  it('files the voice note on the card it was recorded for', () => {
    const { env, added } = harness();
    env.pcFinishRecording(state());
    expect(added).toEqual(['voice-stamp.m4a']);
  });
  it('a recorder that stops after the panel moved to another card, or closed, attaches nothing', () => {
    const moved = harness();
    moved.env.__set('panelSessionKey', 'B');
    moved.env.pcFinishRecording(state());
    expect(moved.added).toEqual([]);
    const closed = harness();
    closed.env.__set('panelOpen', false);
    closed.env.pcFinishRecording(state());
    expect(closed.added).toEqual([]);
    const reset = harness();
    reset.env.__set('_pcRecGen', 1);
    reset.env.pcFinishRecording(state());
    expect(reset.added).toEqual([]);
  });
  it('the send waits on the recording itself — the done promise settles either way', () => {
    const { env } = harness();
    let settled = 0;
    env.__set('panelSessionKey', 'B');
    env.pcFinishRecording(state({ resolve: () => settled++ }));
    expect(settled).toBe(1);
  });
  it('closing the panel resets the composer (mic, files) and stops watching answers', () => {
    const close = TEMPLATE.slice(
      TEMPLATE.indexOf('\nfunction closePanel('),
      TEMPLATE.indexOf('\n}\n', TEMPLATE.indexOf('\nfunction closePanel(')),
    );
    expect(close).toContain('pcReset();');
    expect(close).toMatch(/_ansIo\.disconnect\(\)/);
    const reset = TEMPLATE.slice(
      TEMPLATE.indexOf('\nfunction pcReset('),
      TEMPLATE.indexOf('\n}\n', TEMPLATE.indexOf('\nfunction pcReset(')),
    );
    expect(reset).toContain('_pcRecGen++');
  });
});

describe('review r1 · one send at a time; a failed multiline send retries without inline JS', () => {
  const send = TEMPLATE.slice(
    TEMPLATE.indexOf('\nasync function sendCommand('),
    TEMPLATE.indexOf('\n}\n', TEMPLATE.indexOf('\nasync function sendCommand(')),
  );
  const submit = TEMPLATE.slice(
    TEMPLATE.indexOf('\nfunction pcOnSubmit('),
    TEMPLATE.indexOf('\n}\n', TEMPLATE.indexOf('\nfunction pcOnSubmit(')),
  );
  it('a second press while the first reads its files sends nothing (the note stays in the field)', () => {
    expect(submit).toMatch(
      /if \(!panelSessionKey \|\| _pcSending \|\| !host \|\| host\._mode !== 'open'\) \{\s*e\.preventDefault\(\);/,
    );
    expect(send.indexOf('_pcSending = true')).toBeLessThan(send.indexOf('await '));
  });
  it("a failed send retries through the element (its row's Retry re-emits ui-submit), never an inline handler", () => {
    expect(send).toContain("el.setItemState(ref, 'failed', why.trim());");
    expect(TEMPLATE).not.toMatch(/function sendRetry\(|class="cmd-retry"/);
  });
});

// ── ztrace (Hook 4) S3 — a subagent tab opened before its work log arrived ──
describe('ztrace S3 · a subagent tab fills its instruction and result when the work log arrives', () => {
  it('painting work-log entries re-renders the focused subagent conversation', () => {
    const start = TEMPLATE.indexOf('\nfunction paintWorkLog(');
    const body = TEMPLATE.slice(start, TEMPLATE.indexOf('\n}\n', start));
    expect(body).toMatch(/if \(_panelAgent\) renderAgentConv\(\);/);
  });
});

describe('browser receipt · a section landing is not undone by the layout coordinator', () => {
  it('the landing scroll starts a new panel scroll generation (a stale layout anchor no longer applies)', () => {
    const start = TEMPLATE.indexOf('\nfunction landPanel(');
    const body = TEMPLATE.slice(start, TEMPLATE.indexOf('\n}\n', start));
    const branch = body.slice(
      body.indexOf("_panelLand === 'goal' || _panelLand === 'agent' || _panelLand === 'tasks'"),
    );
    expect(branch.indexOf('_panelScrollGen++')).toBeGreaterThan(-1);
    expect(branch.indexOf('_panelScrollGen++')).toBeLessThan(branch.indexOf('scrollEl.scrollTo({ top: target'));
  });
});

// ── #488 (review P2/P3, closed in this PR) ──
describe('#488 · a voice note that is not filed in time stops the send instead of dropping it', () => {
  const send = TEMPLATE.slice(
    TEMPLATE.indexOf('\nasync function sendCommand('),
    TEMPLATE.indexOf('\n}\n', TEMPLATE.indexOf('\nasync function sendCommand(')),
  );
  it('a recording that does not settle within the wait aborts with a message; text and chips stay', () => {
    expect(send).toMatch(/if \(!filed\) \{[^}]*pcSetError\([^}]*pcGiveBack\(el, ref, msg, sendingSessionKey\);/);
    // Nothing is posted before it: the command route is reached only after the wait.
    expect(send.indexOf('if (!filed)')).toBeLessThan(send.indexOf('acPost('));
  });
});

describe('#488 · a subagent raw that failed to load is tried again later', () => {
  const fn = TEMPLATE.slice(
    TEMPLATE.indexOf('\nfunction agentConvRawOf('),
    TEMPLATE.indexOf('\n}\n', TEMPLATE.indexOf('\nfunction agentConvRawOf(')),
  );
  it('a transient failure forgets its cache entry after a delay (no retry storm)', () => {
    expect(fn).toMatch(/setTimeout\(/);
    expect(fn).toMatch(/delete _agentConvRaw\[key\]/);
  });
});

describe('#488 · answers replaced in the list are no longer observed', () => {
  it('a turn the element rebuilt (its node replaced) or dropped is unobserved on the next watch', () => {
    const watched: unknown[] = [];
    const dropped: unknown[] = [];
    class IO {
      observe(n: unknown) {
        watched.push(n);
      }
      unobserve(n: unknown) {
        dropped.push(n);
      }
    }
    const old = { isConnected: true };
    const fresh = { isConnected: true };
    let node: Record<string, unknown> = old;
    const el = { data: { turns: [{ id: 't2', loading: true }] }, turnElement: () => node };
    const m = load<{ convWatchAnswers(el: unknown): void }>(['convWatchAnswers'], ['_ansIo'], {
      IntersectionObserver: IO,
      _psec: 'conv',
      _panelAgent: '',
      _panelTurnsCid: 'c',
      panelConvId: 'c',
      convLoadAnswer: () => {},
    });
    m.convWatchAnswers(el);
    old.isConnected = false; // the element replaced the turn's node (its summary landed)
    node = fresh;
    m.convWatchAnswers(el);
    expect(watched).toEqual([old, fresh]);
    expect(dropped).toEqual([old]);
  });
});

describe('#488 · every landing scroll starts a new panel scroll generation', () => {
  const land = TEMPLATE.slice(
    TEMPLATE.indexOf('\nfunction landPanel('),
    TEMPLATE.indexOf('\n}\n', TEMPLATE.indexOf('\nfunction landPanel(')),
  );
  it('the question landing and the section-tabs landing (작업 로그 included) bump it too', () => {
    const calls = land.split('scrollEl.scrollTo(');
    expect(calls.length - 1).toBe(3); // the section landing, the question, the section tabs
    for (let i = 0; i < calls.length - 1; i++) expect(calls[i].slice(-200)).toContain('_panelScrollGen++');
    // 작업 로그 has no landing of its own: it is the section tab the opening selects.
    expect(TEMPLATE).not.toContain('function scrollPanelToWorkLog(');
  });
});

describe('#488 r4 (astra) · a send right after a recording timed out still waits for that recording', () => {
  const send = TEMPLATE.slice(
    TEMPLATE.indexOf('\nasync function sendCommand('),
    TEMPLATE.indexOf('\n}\n', TEMPLATE.indexOf('\nasync function sendCommand(')),
  );
  const stop = TEMPLATE.slice(
    TEMPLATE.indexOf('\nfunction pcStopRecording('),
    TEMPLATE.indexOf('\n}\n', TEMPLATE.indexOf('\nfunction pcStopRecording(')),
  );
  const reset = TEMPLATE.slice(
    TEMPLATE.indexOf('\nfunction pcReset('),
    TEMPLATE.indexOf('\n}\n', TEMPLATE.indexOf('\nfunction pcReset(')),
  );
  it('a stopping recording stays pending (_pcFiling) until filed; every send waits on it; a reset forgets it', () => {
    expect(stop).toMatch(/_pcFiling = state\.done/);
    expect(send).toMatch(/var filing = _pcRec \? pcStopRecording\(true\) : _pcFiling;/);
    expect(reset).toMatch(/_pcFiling = null/);
    // r4 (fable P3): a dropped recording (keep = false, a reset) leaves nothing for the next send to wait on.
    expect(stop).toMatch(/if \(keep\) \{\s*_pcFiling = state\.done;/);
  });
});

describe('T1.1 / T1.6 · an opening lands with the section tabs in view: the top, or the tabs under the agent tabs', () => {
  type Rect = { top: number; bottom: number; height: number };
  /** The default landing (no section intent, no question), minimal or 자세히; the section box ends at boxBottom (content px). */
  function rig(detail: boolean, boxBottom = 560, intent = '') {
    const scroll = {
      scrollTop: 0,
      scrollHeight: 2400,
      clientHeight: 600,
      calls: [] as number[],
      getBoundingClientRect: (): Rect => ({ top: 100, bottom: 700, height: 600 }),
      scrollTo(o: { top: number }) {
        this.scrollTop = o.top;
        this.calls.push(o.top);
      },
    };
    const at = (y: number, h: number) => ({
      getBoundingClientRect: (): Rect => ({
        top: 100 + y - scroll.scrollTop,
        bottom: 100 + y + h - scroll.scrollTop,
        height: h,
      }),
    });
    const hidden = {
      style: { display: 'none' },
      getBoundingClientRect: (): Rect => ({ top: 0, bottom: 0, height: 0 }),
    };
    const els: Record<string, unknown> = {
      'panel-scroll': scroll,
      'panel-permission': hidden,
      'panel-question': hidden,
      'panel-needs-head': { hidden: true, offsetHeight: 0 },
      'panel-sections': at(boxBottom - 300, 40),
      'panel-sections-body': at(boxBottom - 260, 260),
      'panel-tabs': { offsetHeight: 44 },
    };
    const m = load<{ landPanel(): void; __set(n: string, v: unknown): void }>(['psecLandingTop', 'landPanel'], [], {
      document: { getElementById: (id: string) => els[id] ?? null },
    });
    m.__set('_panelLand', intent);
    m.__set('_panelLanded', false);
    m.__set('_panelLandAt', null);
    m.__set('_panelOnQuestion', false);
    m.__set('_panelScrollGen', 0);
    m.__set('_panelDetail', detail);
    return { m, scroll };
  }

  it('the section box ends in view: lands at 0; a later landing (the turns arrived) leaves a reader who scrolled', () => {
    const r = rig(false);
    r.scroll.scrollTop = 900; // where the previous content left it
    r.m.landPanel();
    expect(r.scroll.scrollTop).toBe(0);
    r.m.landPanel(); // the turns arrive: still the top
    expect(r.scroll.calls).toEqual([0, 0]);
    r.scroll.scrollTop = 350; // the reader scrolls down
    r.m.landPanel();
    expect(r.scroll.scrollTop).toBe(350);
  });

  it('a tall surface pushes the box past the view: the section tabs land right under the sticky agent tabs', () => {
    const r = rig(false, 1400); // the tabs at 1100, the box ends at 1400 (view 600)
    r.m.landPanel();
    expect(r.scroll.scrollTop).toBe(1100 - 44);
  });

  it('자세히 lands the same way — the newest turns are at the bottom of the section box, not of the panel', () => {
    const r = rig(true);
    r.m.landPanel();
    expect(r.scroll.scrollTop).toBe(0);
    expect(r.scroll.calls).not.toContain(2400);
  });

  it('작업 로그 / ?session= land the same way, on the 작업 로그 tab (never on the question)', () => {
    const r = rig(false, 1400, 'worklog');
    r.m.landPanel();
    expect(r.scroll.scrollTop).toBe(1056);
  });

  it('the landing never holds the panel at its bottom (the section box holds its own newest)', () => {
    const land = TEMPLATE.slice(
      TEMPLATE.indexOf('\nfunction landPanel('),
      TEMPLATE.indexOf('\n}\n', TEMPLATE.indexOf('\nfunction landPanel(')),
    );
    expect(land).not.toContain('scrollEl.scrollHeight');
    expect(TEMPLATE).not.toContain('_panelStickBottom');
    const m = load<{ psecLandingTop(secTop: number, boxBottom: number, view: number, under: number): number }>(
      ['psecLandingTop'],
      [],
    );
    expect(m.psecLandingTop(300, 560, 600, 44)).toBe(0); // the box ends in view: the top
    expect(m.psecLandingTop(1100, 1400, 600, 44)).toBe(1056); // else the tabs under the agent tabs
    expect(m.psecLandingTop(20, 900, 600, 44)).toBe(0); // never above the top
  });
});

describe('T1.3 / SSOT 2026-10-29 · 지시와 답변 opens on its latest turns; scrolling up loads the ones before', () => {
  // D3 E-25: the box, its top row (이전 항목 불러오기 / busy / 대화의 시작), the sentinel and the kept place are
  // <ui-conversation>'s <ui-log-scroller> (the library's suite owns them); the page hands it hasMore / loading and
  // answers its ui-load-older with the existing loader.
  it('the element’s top row follows the page’s paging state; the page’s own controls stay out of 지시와 답변', () => {
    const paint = clientFn('convPaint');
    expect(paint).toContain('hasMore: !!_panelTurnsHasMore,');
    expect(paint).toContain("loading: msg === 'loading' || !!_panelTurnsLoading,");
    expect(paint).toContain("startText: '대화의 시작',");
    const m = load<{ psecOlderState(sec: string): string }>(['psecOlderState'], ['PSEC_EL'], {});
    expect(m.psecOlderState('conv')).toBe('');
  });

  it('the markup: the element in the conv box, no page-drawn control or marker there; no turn hidden by CSS', () => {
    expect(PAGE).toMatch(
      /<div class="psec psec-el ui-tok" id="psec-conv"[^>]*>\s*<ui-conversation class="panel-conv" id="panel-conv" lang="ko"><\/ui-conversation>\s*<\/div>/,
    );
    expect(PAGE).not.toContain('data-sec="conv" hidden>이전 대화 불러오기');
    expect(CSS).not.toContain('#panel-turns:not(.is-all)');
    expect(CSS).not.toContain('.conv-earlier');
    expect(CSS).toMatch(/\.psec\.psec-el \{ overflow: hidden;/);
  });

  it('minimal shows the artifacts as one row of name chips; 자세히 keeps the thumbnails', () => {
    // D2: the chips are the file cards' chip variant — minimal (자세히 off) is chips, 자세히 thumbnails; 자세히
    // re-chooses it (applyPanelDetail → syncPanelArtVariant). This row only lays them out.
    expect(TEMPLATE).toContain("return !_panelDetail || (h > 0 && h <= ART_PANEL_SHORT_PX) ? 'chip' : 'tile';");
    expect(TEMPLATE).toMatch(/function applyPanelDetail\(\) \{[\s\S]*?syncPanelArtVariant\(\);\n\}/);
    expect(TEMPLATE).toContain('renderPanelArtifacts(list, cid, artPanelVariant())');
    expect(CSS).toContain('.slide-panel:not(.is-detail) .panel-artifacts { display: flex;');
  });

  it('every opening loads the latest 20 turns; each older page is the 20 before the oldest held', () => {
    expect(TEMPLATE).toMatch(/^var PANEL_TURNS_PAGE = 20;/m);
    const open = TEMPLATE.slice(
      TEMPLATE.indexOf('\nfunction openPanel('),
      TEMPLATE.indexOf('\n}\n', TEMPLATE.indexOf('\nfunction openPanel(')),
    );
    expect(open).toContain('_panelTurnsList = [];');
    expect(open).toContain('loadPanelTurns(true);');
    expect(clientFn('loadPanelTurns')).toContain("'?limit=' + PANEL_TURNS_PAGE)");
    const more = clientFn('loadMorePanelTurns');
    expect(more).toContain("'?limit=' + PANEL_TURNS_PAGE + '&before=' + encodeURIComponent(requestOldestId)");
    // The page goes in above the reader through the data: the element prepends it and keeps the rows they were on.
    expect(more).toContain('_panelTurnsList = turns.concat(_panelTurnsList);');
    expect(more).not.toContain('insertAdjacentHTML');
  });

  it('a page is due only for a reader who scrolled up near the top — or a box too short to scroll; never on a landing', () => {
    const m = load<{ psecPageDue(top: number, sh: number, ch: number, armed: boolean): boolean }>(['psecPageDue'], []);
    expect(m.psecPageDue(4000, 4600, 600, false)).toBe(false); // landed at the newest
    expect(m.psecPageDue(300, 4600, 600, false)).toBe(false); // near the top, but no reader scrolled
    expect(m.psecPageDue(300, 4600, 600, true)).toBe(true); // the reader scrolled up within one box height
    expect(m.psecPageDue(601, 4600, 600, true)).toBe(false); // more than one box height away
    expect(m.psecPageDue(0, 500, 600, false)).toBe(true); // too short to scroll: fill it
    expect(m.psecPageDue(0, 0, 0, true)).toBe(false); // a hidden box (no height) loads nothing
  });

  it("the reader's rows stay put while what is above them settles: no native scroll anchoring, the page holds the rows it read last (browser receipt)", () => {
    // Native anchoring and the page's own correction fought: a late answer above moved the reader by its height.
    expect(CSS).toMatch(/\n\.psec \{[^}]*overflow-anchor: none;/);
    const init = TEMPLATE.slice(TEMPLATE.indexOf('(function initPanelSections() {'));
    const body = init.slice(0, init.indexOf('\n})();'));
    // A reader's scroll reads the rows in view once a frame (not at the newest: that is pinned).
    expect(body).toMatch(/if \(!_psecPin && !box\._capture\) \{[\s\S]*?box\._anchor = psecViewAnchor\(box\);/);
    // A reader acting on a row (an entry's detail, a Raw) is not held against.
    expect(body).toContain("['pointerdown', 'keydown'].forEach(function(type) {");
    expect(body).toContain('box.addEventListener(type, function() { box._anchor = null; }, { passive: true });');
    // Any size change: pinned → the newest; else the held rows back in place (no time limit).
    expect(body).toContain('if (_psecPin) psecSetTop(box, box.scrollHeight);');
    expect(body).toContain('else if (box._anchor) psecRestoreAnchor(box, box._anchor);');
    expect(TEMPLATE).not.toContain('_anchorUntil');
  });
});

describe('browser receipt · a section landing cut short by a short body lands once the body grows', () => {
  it('the scroll area ResizeObserver tries a pending goal / agent / tasks landing again', () => {
    const init = TEMPLATE.slice(
      TEMPLATE.indexOf('(function initPanelScrollHandler()'),
      TEMPLATE.indexOf('})();', TEMPLATE.indexOf('(function initPanelScrollHandler()')),
    );
    const ro = init.slice(init.indexOf('new ResizeObserver('));
    expect(ro).toMatch(
      /else if \(panelOpen && !_panelLanded && \(_panelLand === 'goal' \|\| _panelLand === 'agent' \|\| _panelLand === 'tasks'\)\) landPanel\(\);/,
    );
  });
});

describe('T1.6 · HIG: outside a list the 자세히 toggle is a button that behaves like a toggle, not a switch', () => {
  it('a pressed-state button whose background changes — no switch knob in the panel head', () => {
    expect(PAGE).toMatch(
      /<button type="button" class="panel-detail-toggle" id="panel-detail-toggle" aria-pressed="false"[^>]*><i data-ui-icon="list" class="pdt-icon"><\/i>/,
    );
    expect(PAGE).not.toContain('pdt-switch');
    // Tone pass P2: "pressed" is the neutral chip (--ib-pill, a --ib-muted edge), not an accent fill —
    // the accent is for links, focus and progress only.
    expect(CSS).toMatch(
      /\.panel-detail-toggle\[aria-pressed="true"\] \{ background: var\(--ib-pill\); border-color: var\(--ib-muted\); color: var\(--text\); \}/,
    );
  });
});

describe('browser receipt · a section landing is held while the panel settles, until the reader acts', () => {
  type Rect = { top: number; bottom: number; height: number };
  function rig(goalAt: number, scrollTop: number) {
    const scroll = {
      scrollTop,
      scrollHeight: 1000,
      clientHeight: 600,
      calls: [] as number[],
      getBoundingClientRect: (): Rect => ({ top: 100, bottom: 700, height: 600 }),
      scrollTo(o: { top: number }) {
        this.scrollTop = o.top;
        this.calls.push(o.top);
      },
    };
    const goal = {
      style: { display: '' },
      getBoundingClientRect: (): Rect => {
        const top = 100 + goalAt - scroll.scrollTop;
        return { top, bottom: top + 80, height: 80 };
      },
    };
    const m = load<{ holdPanelLanding(): void; __set(n: string, v: unknown): void }>(['holdPanelLanding'], [], {
      document: {
        getElementById: (id: string) => (id === 'panel-scroll' ? scroll : id === 'panel-goal' ? goal : null),
      },
    });
    m.__set('_panelLand', 'goal');
    m.__set('_panelScrollGen', 0);
    m.__set('_panelHold', true);
    m.__set('_panelHoldUntil', Number.POSITIVE_INFINITY);
    return { m, scroll };
  }

  it('the panel moved the landed goal (a re-render, the browser anchoring): it goes back to the top', () => {
    const r = rig(104, 77);
    r.m.holdPanelLanding();
    expect(r.scroll.scrollTop).toBe(104);
  });

  it('in place, or as far as the body allows: nothing moves', () => {
    const r = rig(104, 104);
    r.m.holdPanelLanding();
    expect(r.scroll.calls).toEqual([]);
    const end = rig(900, 400); // the goal cannot reach the top: the end is the landing
    end.m.holdPanelLanding();
    expect(end.scroll.calls).toEqual([]);
  });

  it('wiring: landed → held; a scroll or a resize while held puts it back; any reader input lets go; each opening and closing resets', () => {
    const land = TEMPLATE.slice(
      TEMPLATE.indexOf('\nfunction landPanel('),
      TEMPLATE.indexOf('\n}\n', TEMPLATE.indexOf('\nfunction landPanel(')),
    );
    expect(land).toContain('_panelHold = _panelLanded;');
    const init = TEMPLATE.slice(
      TEMPLATE.indexOf('(function initPanelScrollHandler()'),
      TEMPLATE.indexOf('})();', TEMPLATE.indexOf('(function initPanelScrollHandler()')),
    );
    // The scroll handler and the resize observer both put a held landing back.
    expect(init.split('if (_panelHold && panelOpen) holdPanelLanding();').length - 1).toBe(2);
    expect(init.slice(init.indexOf('new ResizeObserver('))).toContain(
      'if (_panelHold && panelOpen) holdPanelLanding();',
    );
    expect(init).toContain('panel.addEventListener(type, function() { _panelHold = false; }');
    const open = TEMPLATE.slice(
      TEMPLATE.indexOf('\nfunction openPanel('),
      TEMPLATE.indexOf('\n}\n', TEMPLATE.indexOf('\nfunction openPanel(')),
    );
    expect(open).toContain('_panelHold = false;');
    const close = TEMPLATE.slice(
      TEMPLATE.indexOf('\nfunction closePanel('),
      TEMPLATE.indexOf('\n}\n', TEMPLATE.indexOf('\nfunction closePanel(')),
    );
    expect(close).toContain('_panelHold = false;');
  });
});

describe('R7 review (fable P2/P3) · the 이전 대화 control belongs to the main conversation; the hold is a settle window', () => {
  it("a subagent tab never offers the main conversation's older turns", () => {
    // The element is handed the subagent's two turns with no hasMore, and refuses a page while one is shown.
    expect(clientFn('renderAgentConv')).not.toContain('hasMore: true');
    const init = TEMPLATE.slice(TEMPLATE.indexOf('(function initConversation() {'));
    expect(init.slice(0, init.indexOf('})();'))).toContain(
      'if (_panelAgent || !_panelTurnsHasMore || _panelTurnsLoading) {',
    );
  });

  it('switching agent tabs and replacing the turns re-paint the element', () => {
    const sel = TEMPLATE.slice(
      TEMPLATE.indexOf('\nfunction selectPanelAgent('),
      TEMPLATE.indexOf('\n}\n', TEMPLATE.indexOf('\nfunction selectPanelAgent(')),
    );
    expect(sel).toContain('selectPanelSection(_psec);');
    const paint = TEMPLATE.slice(
      TEMPLATE.indexOf('\nfunction paintSection('),
      TEMPLATE.indexOf('\n}\n', TEMPLATE.indexOf('\nfunction paintSection(')),
    );
    expect(paint).toContain("if (sec === 'conv') convPaint();");
    // The turns arriving (or failing) paint it again.
    expect(clientFn('loadPanelTurns').split('convPaint();').length - 1).toBeGreaterThanOrEqual(2);
  });

  it('the hold lets go after the settle window, and a mouse press lets go at once', () => {
    type Rect = { top: number; bottom: number; height: number };
    const scroll = {
      scrollTop: 77,
      scrollHeight: 1000,
      clientHeight: 600,
      calls: [] as number[],
      getBoundingClientRect: (): Rect => ({ top: 100, bottom: 700, height: 600 }),
      scrollTo(o: { top: number }) {
        this.scrollTop = o.top;
        this.calls.push(o.top);
      },
    };
    const goal = {
      style: { display: '' },
      getBoundingClientRect: (): Rect => ({ top: 100 + 104 - scroll.scrollTop, bottom: 0, height: 80 }),
    };
    const m = load<{ holdPanelLanding(): void; __set(n: string, v: unknown): void; __get(): boolean }>(
      ['holdPanelLanding'],
      [],
      {
        document: {
          getElementById: (id: string) => (id === 'panel-scroll' ? scroll : id === 'panel-goal' ? goal : null),
        },
      },
    );
    m.__set('_panelLand', 'goal');
    m.__set('_panelScrollGen', 0);
    m.__set('_panelHold', true);
    m.__set('_panelHoldUntil', Date.now() - 1); // the panel settled a while ago: the reader's place now
    m.holdPanelLanding();
    expect(scroll.calls).toEqual([]);
    const init = TEMPLATE.slice(
      TEMPLATE.indexOf('(function initPanelScrollHandler()'),
      TEMPLATE.indexOf('})();', TEMPLATE.indexOf('(function initPanelScrollHandler()')),
    );
    expect(init).toContain("['pointerdown', 'mousedown', 'keydown', 'wheel', 'touchstart']");
    const land = TEMPLATE.slice(
      TEMPLATE.indexOf('\nfunction landPanel('),
      TEMPLATE.indexOf('\n}\n', TEMPLATE.indexOf('\nfunction landPanel(')),
    );
    expect(land).toMatch(/_panelHoldUntil = Date\.now\(\) \+ 3000;/);
  });
});

describe('R7 review (astra P2) · a panel read at its top stays at its top through a layout shift', () => {
  type Rect = { top: number; bottom: number; height: number };
  function rig(scrollTop: number) {
    const row = {
      isConnected: true,
      top: 300,
      getBoundingClientRect(): Rect {
        return { top: this.top - scroll.scrollTop, bottom: 0, height: 40 };
      },
    };
    const scroll = {
      scrollTop,
      calls: [] as number[],
      getBoundingClientRect: (): Rect => ({ top: 0, bottom: 600, height: 600 }),
      scrollTo(o: { top: number }) {
        this.scrollTop = o.top;
        this.calls.push(o.top);
      },
    };
    const m = load<{
      capturePanelAnchor(): unknown;
      restorePanelAnchor(a: unknown): void;
      __set(n: string, v: unknown): void;
    }>(['capturePanelAnchor', 'restorePanelAnchor'], [], {
      document: { getElementById: (id: string) => (id === 'panel-scroll' ? scroll : null) },
      panelScrollAnchor: () => ({ el: row, top: row.getBoundingClientRect().top }),
    });
    m.__set('panelOpen', true);
    m.__set('_panelScrollGen', 0);
    return { m, scroll, row };
  }

  it('at the top: the reflow (a narrower window grows the rows above) does not push the surface away', () => {
    const r = rig(0);
    const a = r.m.capturePanelAnchor();
    r.row.top = 332; // the rows above the anchor grew by 32px
    r.m.restorePanelAnchor(a);
    expect(r.scroll.scrollTop).toBe(0);
  });

  it('below the top: the row the reader was on keeps its place, as before', () => {
    const r = rig(200);
    const a = r.m.capturePanelAnchor();
    r.row.top = 332;
    r.m.restorePanelAnchor(a);
    expect(r.scroll.scrollTop).toBe(232);
  });
});

describe('R8 review (fable P3) · input symmetry and a short body read at its top', () => {
  it('a mouse press also starts a new panel scroll generation (as it lets go of the hold)', () => {
    const gen = TEMPLATE.slice(
      TEMPLATE.lastIndexOf(
        'forEach(function(type) {\n      panel.addEventListener(type, function() { _panelScrollGen++; }',
      ) - 80,
    );
    expect(gen.slice(0, 200)).toContain("['pointerdown', 'mousedown', 'keydown', 'wheel', 'touchstart']");
  });

  it('a new turn goes into the data; the element follows a reader at the newest (else counts it on its pill); one’s own instruction goes to it', () => {
    type T = { role: string; id?: string };
    const run = (o: { own?: boolean; shown?: string; agent?: string } = {}) => {
      const list: T[] = [{ role: 'user', id: 'a' }];
      const calls: string[] = [];
      const el = { scrollToLatest: () => calls.push('latest') };
      const m = load<{ appendTurnToPanel(t: T, own?: boolean, replaceId?: string): void }>(
        ['ptUpsert', 'appendTurnToPanel'],
        [],
        {
          _panelTurnsList: list,
          _panelTurnsMsg: '',
          _psec: o.shown ?? 'conv',
          _panelAgent: o.agent ?? '',
          convPaint: () => calls.push('paint'),
          convEl: () => el,
        },
      );
      m.appendTurnToPanel({ role: 'user', id: 'b' }, o.own);
      m.appendTurnToPanel({ role: 'assistant', id: 'b' }); // the same id: in place
      return { ids: list.map((t) => `${t.role}:${t.id}`), calls };
    };
    expect(run()).toEqual({ ids: ['user:a', 'assistant:b'], calls: ['paint', 'paint'] });
    expect(run({ own: true }).calls).toEqual(['paint', 'latest', 'paint']);
    // 지시와 답변 not shown (another section, a subagent's tab): data only, nothing painted.
    expect(run({ shown: 'log' })).toEqual({ ids: ['user:a', 'assistant:b'], calls: [] });
    expect(run({ agent: 'a1' }).calls).toEqual([]);
  });
});

describe('T1.5 · the session model sits above the steering input — on a phone too', () => {
  it('markup: model · effort come before the composer', () => {
    expect(PAGE.indexOf('id="panel-controls"')).toBeGreaterThan(-1);
    expect(PAGE.indexOf('id="panel-controls"')).toBeLessThan(PAGE.indexOf('id="cmd-steer"'));
  });

  // Dashboard batch 2: the tools moved into <ui-agent-steering>'s field (slot="tools") and Send is the element's,
  // so the narrow layout no longer re-orders a row of its own — model · effort on the first line, the composer under it.
  it('narrow: model · effort on the first line, the composer (tools in its field) on the line under it', () => {
    expect(CSS).toContain('.panel-command .panel-controls { min-width: 0; max-width: 100%; }');
    expect(CSS).toContain('.panel-command .pc-steer-wrap { flex-basis: 100%; }');
    expect(CSS).not.toContain('.panel-command .panel-controls { padding: 0; flex: 0 1 auto; max-width: 42%; }');
    expect(CSS).not.toMatch(/\.btn-send|\.panel-command textarea|\.panel-command-row|\.cmd-hint/);
  });
});

describe('a phone held sideways (short docked screen) keeps a reading area', () => {
  // SSOT 2026-10-29 T3: the top bar is always on screen (sticky), so a short docked drawer no
  // longer takes the full height over it — it stays under the bar like any docked drawer.
  it('a short docked drawer stays under the sticky top bar (SSOT 2026-10-29 T3); the subtitle steps aside unless 자세히', () => {
    expect(CSS).not.toContain('@media (min-width: 840px) and (max-height: 560px) {');
    expect(CSS).not.toMatch(
      /\.slide-panel \{ top: var\(--pv-t, 0px\); height: var\(--pv-h, 100dvh\); z-index: 102; \}/,
    );
    expect(CSS).toMatch(/\n\.topbar \{[^}]*position: sticky;\s*top: 0;/);
    expect(CSS).toMatch(
      /@media \(max-height: 560px\) \{\s*\.slide-panel:not\(\.is-detail\) #panel-title-sub \{ display: none !important; \}/,
    );
  });
});
