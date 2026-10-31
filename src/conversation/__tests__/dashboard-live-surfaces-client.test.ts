/**
 * SSOT 2026-10-22 — dashboard live surfaces, client half. Executes the shipped
 * card code (cut out of renderDashboardPage()'s template literal and cooked
 * exactly as the browser receives it — the harness of
 * dashboard-agent-inbox-client.test.ts):
 *
 *   T1/T2  collapsed card: total tokens + API-equivalent cost, counted up live
 *   T3     collapsed card: the task in progress — its id, name and running time
 *          (the collapsed card is <ui-agent-inbox>'s; the page hands it cardOf's data)
 *   T7/T8  task timeline / panel: task ids, elapsed time and tool calls of
 *          completed tasks, earlier tasks on demand
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
function assertUnique(name: string) {
  const re = new RegExp(`^(?:async function|function|var|let|const) ${name}\\b`, 'gm');
  const n = (TEMPLATE.match(re) ?? []).length;
  if (n > 1) throw new Error(`client ${name} is declared ${n} times`);
}
function clientFn(name: string): string {
  assertUnique(name);
  const plain = TEMPLATE.indexOf(`\nfunction ${name}(`);
  const start = plain >= 0 ? plain : TEMPLATE.indexOf(`\nasync function ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = TEMPLATE.indexOf('\n}\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 2));
}
function clientVar(name: string): string {
  assertUnique(name);
  const m = TEMPLATE.match(new RegExp(`^(var ${name} = .*?;)(?:\\s*//.*)?$`, 'm'));
  if (!m) throw new Error(`client var ${name} not found`);
  return cook(m[1]);
}
/** The page's chrome words (STRINGS), as served: the board's Korean words live there (D2 group 6). */
const PAGE_STRINGS = new Function(
  `${cook(TEMPLATE.slice(TEMPLATE.indexOf('var STRINGS = {'), TEMPLATE.indexOf('\n};\n', TEMPLATE.indexOf('var STRINGS = {')) + 3))}\nreturn STRINGS;`,
)();
function load<T>(fns: string[], vars: string[], inject: Record<string, unknown> = {}): T {
  inject = { STRINGS: PAGE_STRINGS, ...inject };
  const names = Object.keys(inject);
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}

const SHOW_ALL = {
  dhShow: () => true,
  dhMax: (_f: string, d: number) => d,
  dhTruncate: () => null,
  currentUserId: 'U1',
};
// The collapsed face is @2lab.ai/ui <ui-agent-inbox>'s: the page hands it the
// card data (cardOf), text and numbers only; the element draws, escapes, ticks
// and counts it up ('renders the face: task, sub-agents, tokens · cost, files,
// status tag with a live clock, metrics', 'escapes every user and model string').
const CARD_ENV = { ...SHOW_ALL, _ownerIndex: null, SELF_INSTANCE_NAME: 'inst' };
const CARD_OF_FNS = [
  'toNum',
  'formatTokens',
  'formatTaskTime',
  'permissionSummary',
  'cardSummary',
  'pendingAutoResume',
  'autoResumeLabel',
  'cardCurrentTask',
  'cardTaskRow',
  'agentStatusOf',
  'agentCounts',
  'agentDotOf',
  'cardTotalTokens',
  'ctxLevel',
  'ctxPercent',
  'cardCtxTitle',
  'cardPrMetric',
  '_hashStr',
  'ownerBadgeHue',
  'isSiblingSession',
  'cardOf',
];
const CARD_OF_VARS = [
  'PR_STATE_LABEL',
  'PR_STATE_TONE',
  'AGENT_STATUS_LABEL',
  'AGENT_STATUS_TONE',
  'AGENT_STATUS_GLYPH',
  'OWNER_BADGE_HUES',
];
type Face = { cardOf(s: unknown, col: string): Record<string, unknown>; cardTotalTokens(u: unknown): number };

function workingCard(over: Record<string, unknown> = {}) {
  return {
    key: 'inst::C1:t1',
    displayHeadline: 'Dashboard work',
    summaryTitle: 'Dashboard work',
    ownerId: 'U1',
    ownerName: 'Z',
    activeLegStartedAtMs: 5000,
    activeAccumulatedMs: 0,
    tokenUsage: {
      totalInputTokens: 1000,
      totalOutputTokens: 200,
      totalCacheReadTokens: 5000,
      totalCacheCreateTokens: 300,
      totalCostUsd: 1.2345,
      contextUsagePercent: 12,
    },
    tasks: [
      { id: 'T1', content: 'Explore code', status: 'completed', startedAt: 1000, completedAt: 61_000, toolCalls: 7 },
      {
        id: 'T2',
        content: 'Write the parser',
        activeForm: 'Writing the parser',
        status: 'in_progress',
        startedAt: 61_000,
        toolCalls: 3,
      },
      { id: 'T3', content: 'Ship it', status: 'pending', toolCalls: 0 },
    ],
    ...over,
  };
}

describe('collapsed card: total tokens and cost (T1/T2)', () => {
  const face = load<Face>(CARD_OF_FNS, CARD_OF_VARS, CARD_ENV);

  it('shows the session total of every token kind and the API-equivalent cost, as count-up targets', () => {
    const c = face.cardOf(workingCard(), 'working');
    // The numbers the element counts up to; it formats them ("6,500", "$1.23").
    expect(c.tokens).toBe(6500);
    expect(c.costUsd).toBe(1.2345);
  });

  it('total = input + output + cache read + cache write', () => {
    expect(
      face.cardTotalTokens({
        totalInputTokens: 1,
        totalOutputTokens: 2,
        totalCacheReadTokens: 3,
        totalCacheCreateTokens: 4,
      }),
    ).toBe(10);
    expect(face.cardTotalTokens(undefined)).toBe(0);
  });

  it('every column shows it, also a finished card; a card without usage shows no usage row', () => {
    expect(face.cardOf(workingCard(), 'idle').tokens).toBe(6500);
    expect(face.cardOf(workingCard(), 'closed').costUsd).toBe(1.2345);
    const none = face.cardOf(workingCard({ tokenUsage: undefined }), 'working');
    expect(none.tokens).toBeUndefined();
    expect(none.costUsd).toBeUndefined();
  });

  it('follows the dashboard header fields: tokens and cost hide independently', () => {
    const noCost = load<Face>(CARD_OF_FNS, CARD_OF_VARS, { ...CARD_ENV, dhShow: (f: string) => f !== 'cost' });
    const c = noCost.cardOf(workingCard(), 'working');
    expect(c.tokens).toBe(6500);
    expect(c.costUsd).toBeUndefined();
    const noTokens = load<Face>(CARD_OF_FNS, CARD_OF_VARS, { ...CARD_ENV, dhShow: (f: string) => f !== 'tokens' });
    const d = noTokens.cardOf(workingCard(), 'working');
    expect(d.tokens).toBeUndefined();
    expect(d.costUsd).toBe(1.2345);
  });

  it('a hostile number renders as a plain number', () => {
    const c = face.cardOf(
      workingCard({ tokenUsage: { totalInputTokens: '"><img src=x onerror=alert(1)>', totalCostUsd: 'x' } }),
      'working',
    );
    expect(c.tokens).toBe(0);
    expect(c.costUsd).toBe(0);
    expect(JSON.stringify(c)).not.toMatch(/onerror|<img/);
  });
});

describe('collapsed card: the task in progress (T3)', () => {
  const face = load<Face>(CARD_OF_FNS, CARD_OF_VARS, CARD_ENV);

  it('names the running task with its id and a live elapsed timer', () => {
    // The element ticks the timer from startedAt.
    expect(face.cardOf(workingCard(), 'working').task).toEqual({
      label: 'Write the parser',
      id: 'T2',
      startedAt: 61_000,
    });
  });

  it('the summary line no longer repeats the task the task row already shows', () => {
    const c = face.cardOf(workingCard({ summaryTitle: 'Parser rewrite', displayHeadline: 'Headline' }), 'working');
    expect(c.summary).toBe('Parser rewrite');
    expect(JSON.stringify(c).match(/Write the parser/g)).toHaveLength(1);
  });

  it('a waiting card still shows its task; finished cards and cards without a running task show none', () => {
    expect(face.cardOf(workingCard(), 'waiting').task).toBeDefined();
    expect(face.cardOf(workingCard(), 'idle').task).toBeUndefined();
    const noneRunning = workingCard({ tasks: [{ id: 'T1', content: 'a', status: 'pending', toolCalls: 0 }] });
    expect(face.cardOf(noneRunning, 'working').task).toBeUndefined();
  });

  it('the task name and id are text for the element to escape; a start time that is not a number is dropped', () => {
    const c = face.cardOf(
      workingCard({
        tasks: [
          { id: '<b>', content: '<img src=x onerror=alert(1)>', status: 'in_progress', startedAt: 'x', toolCalls: 0 },
        ],
      }),
      'working',
    );
    expect(c.task).toEqual({ label: '<img src=x onerror=alert(1)>', id: '<b>' });
  });
});

// Count-up of the usage numbers (T1/T2) is the element's (agent-inbox.ts #countUp, 900 ms ease-out, none
// with reduced motion) — the library's 'renders the face: task, sub-agents, tokens · cost, …' owns the usage
// row; the count-up itself has no library test yet.

describe('live times are <ui-elapsed> (D7 K-03)', () => {
  it('the page loads @2lab.ai/ui/elapsed; its own tick keeps only the cron countdown — no clock loop, no Date.now() in markup', () => {
    expect(TEMPLATE).toContain('<script type="module" src="/dashboard/ui/elapsed.js?v=${UI_LIB_VERSION}"></script>');
    expect(TEMPLATE).toContain('function updateTimers() { aqTick(); }');
    for (const gone of [
      'updateTimersIn',
      'card-timer-live',
      'rel-time',
      'task-elapsed',
      'data-leg-started',
      'function timeAgo',
    ])
      expect(TEMPLATE, gone).not.toContain(gone);
    const h = load<{
      elapsedHtml(since: number, title?: string): string;
      activeTimeHtml(leg: number, acc: number, title?: string): string;
      agoHtml(at: number): string;
    }>(['esc', 'escAttr', 'toNum', 'formatDuration', 'formatNmSSs', 'elapsedHtml', 'activeTimeHtml', 'agoHtml'], []);
    expect(h.elapsedHtml(61000, '활성 시간')).toBe(
      '<ui-elapsed since="61000" lang="ko" title="활성 시간"></ui-elapsed>',
    );
    expect(h.agoHtml(1700000000000)).toBe('<ui-elapsed since="1700000000000" format="ago" lang="ko"></ui-elapsed>');
    // A leg under way: since = its start less what ran before it; closed: the settled total in the page's words.
    expect(h.activeTimeHtml(1700000000000, 65000)).toBe('<ui-elapsed since="1699999935000" lang="ko"></ui-elapsed>');
    expect(h.activeTimeHtml(0, 65000, '활성 시간')).toBe('<span title="활성 시간">1분 05초</span>');
    expect(h.elapsedHtml(Number.NaN)).not.toContain('NaN');
  });
});

describe('task timeline: ids, elapsed time and tool calls (T7/T8)', () => {
  // Task view T2: the meta and the 전체 task count read each task's fate.
  const tl = load<{ renderTimeline(s: unknown): string }>(
    [
      'esc',
      'escAttr',
      'escJs',
      'toNum',
      'formatDuration',
      'taskFateOf',
      'elapsedHtml',
      'renderTaskMeta',
      'renderTimelineItem',
      'renderTimeline',
    ],
    ['TASK_FATE_LABEL'],
    { ...SHOW_ALL },
  );

  it('each task shows its id; a completed task its elapsed time and tool calls', () => {
    const html = tl.renderTimeline(workingCard());
    expect(html).toContain('<span class="tl-id">#T1</span>');
    expect(html).toContain('1분 00초');
    expect(html).toContain('툴 7회');
    // D7 K-03: the running task's live time is <ui-elapsed> (its own tick), never a page clock.
    expect(html).toContain('<ui-elapsed since="61000" lang="ko"></ui-elapsed>');
    expect(html).toContain('툴 3회');
    // A pending task has neither time nor tool calls.
    expect(html).toMatch(/#T3<\/span><span class="tl-text">Ship it<\/span><\/li>/);
  });

  // Spec 13: the open card is a window; every task of the list and the earlier
  // lists are the panel's Tasks — 전체 task N개 → opens them there (T7 reachability kept).
  it('completed tasks beyond the budget and earlier tasks are one click away, in the panel', () => {
    const many = workingCard({
      tasks: Array.from({ length: 8 }, (_, i) => ({
        id: `T${i + 1}`,
        content: `task ${i + 1}`,
        status: 'completed',
        startedAt: 1000,
        completedAt: 2000,
        toolCalls: i,
      })),
      earlierTasks: [
        { id: 'T0', content: 'old plan', status: 'completed', startedAt: 1, completedAt: 2, toolCalls: 4 },
      ],
    });
    const html = tl.renderTimeline(many);
    expect(html).not.toContain('old plan');
    expect(html).toContain('전체 task 9개 &rarr;');
    expect(html).toContain("openPanel('" + many.key + "','tasks',");
  });

  it('a session with only earlier tasks still offers them', () => {
    const html = tl.renderTimeline(
      workingCard({ tasks: [], earlierTasks: [{ id: 'T9', content: 'x', status: 'completed', toolCalls: 1 }] }),
    );
    expect(html).toContain('전체 task 1개 &rarr;');
  });

  it('task view T2: earlier steps a new plan dropped before they ran are not counted; one that ran is', () => {
    const skipped = { id: 'T8', content: 'never ran', status: 'pending', dropped: 'unstarted', removedAt: 9000 };
    const stopped = {
      id: 'T9',
      content: 'stopped',
      status: 'in_progress',
      dropped: 'started',
      startedAt: 1000,
      removedAt: 9000,
      toolCalls: 2,
    };
    expect(tl.renderTimeline(workingCard({ earlierTasks: [skipped, stopped] }))).toContain('전체 task 4개 &rarr;');
    // Only never-run steps behind an empty list: nothing to open.
    expect(tl.renderTimeline(workingCard({ tasks: [], earlierTasks: [skipped] }))).toBe('');
  });

  it('task view T2: a paused step says 멈춤 with its tools and never ticks; the pending one stays bare', () => {
    const html = tl.renderTimeline(
      workingCard({
        tasks: [
          { id: 'T1', content: 'Was running', status: 'pending', startedAt: 1000, toolCalls: 4 },
          { id: 'T2', content: 'Next', status: 'pending' },
        ],
      }),
    );
    expect(html).toContain(
      '<span class="tl-time">멈춤 &middot; <span class="tl-tools" title="툴 호출 수">툴 4회</span></span>',
    );
    expect(html).not.toContain('<ui-elapsed');
    expect(html).toMatch(/#T2<\/span><span class="tl-text">Next<\/span><\/li>/);
  });
});

// D3 E-22/E-23: a panel task is a <ui-task-runs> run (or a <ui-task-plan> step); the page hands it the id,
// the times and the tool calls — the element draws the duration, the chip and the status word.
describe('panel task runs carry id, times and tool calls (T7/T8)', () => {
  const { taskRunsData, taskPlanData, taskRunsOf } = load<{
    taskRunsData(ran: unknown[]): Array<Record<string, any>>;
    taskPlanData(runs: unknown): Record<string, any>;
    taskRunsOf(current: unknown[], earlier?: unknown[]): unknown;
  }>(
    ['toNum', 'taskFateOf', 'taskIdNum', 'taskRunStart', 'taskRunEnd', 'taskRunsOf', 'taskRunsData', 'taskPlanData'],
    ['TASK_RUN_STATUS'],
  );
  it('completed: id, start and end, tool count', () => {
    const [run] = taskRunsData([
      { id: 'T4', content: 'Build', status: 'completed', startedAt: 5, completedAt: 9, toolCalls: 12 },
    ]);
    expect(run).toMatchObject({
      id: 'T4',
      ref: '#T4',
      title: 'Build',
      status: 'done',
      startedAt: 5,
      endedAt: 9,
      toolCalls: 12,
    });
  });
  it('D6b (D3-GAPS G5-1): a share (ran together with other tasks) or an inferred start reads ≈ (approx) with a note saying why', () => {
    const run = (over: Record<string, unknown>) =>
      taskRunsData([
        { id: 'T1', content: 'a', status: 'completed', startedAt: 1, completedAt: 2, toolCalls: 2.5, ...over },
      ])[0];
    expect(run({ shared: 2 })).toMatchObject({
      approx: true,
      notes: [{ label: '분배', value: '2개 태스크가 함께 진행 — 수치는 그 몫(1/2)' }],
    });
    expect(run({ startEstimated: true })).toMatchObject({
      approx: true,
      notes: [{ label: '시작', value: '진행 중 표시 없이 완료 — 직전 목록의 시각', approx: true }],
    });
    expect(run({ shared: 3, startEstimated: true }).notes).toHaveLength(2);
    const plain = run({ shared: 1 });
    expect(plain.approx).toBeUndefined();
    expect(plain.notes).toBeUndefined();
  });
  it('task view T2: a step a later plan dropped after it ran keeps its tools and time; one that never ran has neither', () => {
    const [dropped] = taskRunsData([
      {
        id: 'T5',
        content: 'Stopped',
        status: 'in_progress',
        dropped: 'started',
        startedAt: 1000,
        removedAt: 61_000,
        toolCalls: 6,
      },
    ]);
    // SSOT 2026-10-29 T5: a task a new plan replaced after it ran is dropped (교체됨), its work stays on it —
    // never running, its time from its start to when it left.
    expect(dropped).toMatchObject({ status: 'dropped', startedAt: 1000, endedAt: 61_000, toolCalls: 6 });
    const runs = taskRunsOf(
      [],
      [{ id: 'T6', content: 'Never ran', status: 'pending', dropped: 'unstarted', toolCalls: 0 }],
    );
    const plan = taskPlanData(runs);
    expect(plan.steps).toEqual([]);
    expect(plan.earlier[0].steps).toEqual([
      { id: 'skipped:T6', ref: '#T6', label: 'Never ran', status: 'pending', fate: 'dropped' },
    ]);
    // A plan step carries no tool count (nothing ran).
    expect('toolCalls' in plan.earlier[0].steps[0]).toBe(false);
  });
});

describe('goals: completed goals with their details (T6) — what the page hands <ui-goal-card>', () => {
  const m = load<{
    goalCardData(
      s: unknown,
      canEdit: boolean,
    ): {
      history: Array<{
        id: string;
        objective: string;
        status: string;
        endedAt?: number;
        meta?: string[];
        note?: string;
      }>;
    };
  }>(
    ['toNum', 'formatTokens', 'formatDuration', 'goalPastItem', 'goalCardData'],
    ['GOAL_VIA_LABELS', 'GOAL_OBJECTIVE_MAX', 'GOAL_ACTIONS', '_goalErrors', '_goalBusy'],
  );
  const card = (history: unknown[], over: Record<string, unknown> = {}) => ({
    key: 'inst::C1:t1',
    terminated: false,
    goal: {
      current: { goalId: 'g9', objective: '지금 goal', status: 'active', continuationCount: 1, maxContinuations: 10 },
      queue: [],
      completedCount: history.length,
      history,
    },
    ...over,
  });
  const H = [
    {
      goalId: 'g2',
      objective: '두번째 끝난 goal',
      createdAt: Date.parse('2026-10-21T01:00:00Z'),
      completedAt: Date.parse('2026-10-21T01:12:00Z'),
      completedVia: 'eval-model',
      completionReason: '모든 요건에 증거가 있다',
      activeMsUsed: 600_000,
      tokens: 1_500_000,
      costUsd: 3.4,
      continuationCount: 4,
    },
    { goalId: 'g1', objective: '<b>첫</b>', completedVia: 'user', completionReason: 'user' },
  ];

  it('every completed goal with when it closed, time spent, tokens, cost, continuations, how and why — the element folds them under 지난 목표', () => {
    const { history } = m.goalCardData(card(H), true);
    expect(history).toEqual([
      {
        id: 'g2',
        objective: '두번째 끝난 goal',
        status: 'complete',
        endedAt: Date.parse('2026-10-21T01:12:00Z'),
        meta: ['소요 10분 00초', '1.5M 토큰', '$3.40', '이어하기 4회', '평가 모델 완료'],
        note: '모든 요건에 증거가 있다',
      },
      // Newest first, as the server sends them; the text goes as written (the element escapes it).
      { id: 'g1', objective: '<b>첫</b>', status: 'complete', meta: ['직접 완료'] },
    ]);
  });

  it('a read-only viewer gets the history too (the element shows it without controls)', () => {
    expect(m.goalCardData(card(H), false).history).toHaveLength(2);
  });

  it('no completed goals: an empty history (the element draws no fold)', () => {
    expect(m.goalCardData(card([]), true).history).toEqual([]);
  });
});

describe('work log: the latest window on opening, older pages as the reader scrolls up (SSOT 2026-10-29; was T9 "every entry")', () => {
  type E = { seq: number; taskId?: string };
  const range = (a: number, b: number): E[] => Array.from({ length: b - a + 1 }, (_, i) => ({ seq: a + i }));
  const wl = load<{
    wlNewState(c: string): any;
    wlLatestUrl(c: string): string;
    wlOlderUrl(c: string, beforeSeq: number): string;
    wlLoadLatest(st: any, f: (u: string) => Promise<unknown>, on: (s: any, a: any[]) => void): Promise<string>;
    wlLoadOlderPage(st: any, f: (u: string) => Promise<unknown>, on: (s: any, a: any[]) => void): Promise<unknown>;
  }>(
    [
      'wlNewState',
      'wlUrl',
      'wlLatestUrl',
      'wlOlderUrl',
      'wlValidSeq',
      'wlMerge',
      'wlPageMaxSeq',
      'wlAdvance',
      'wlConfirm',
      'wlHasGap',
      'wlStatusOf',
      'wlDeny',
      'wlLoadLatest',
      'wlOnLive',
      'wlRecover',
      'wlLoadOlderPage',
    ],
    ['WL_BACKFILL_MAX_PAGES', 'WL_PAGE', 'WL_OLDER_EMPTY_MAX'],
  );
  /** The real API: no cursor = the latest `limit`; beforeSeq = the last `limit` before it; afterSeq = the first after it. */
  function server(log: E[]) {
    const calls: string[] = [];
    const fetchJson = async (url: string) => {
      const q = new URL(url, 'http://h').searchParams;
      calls.push(q.toString());
      const limit = Number(q.get('limit') || 500);
      if (q.has('beforeSeq')) {
        const before = log.filter((e) => e.seq < Number(q.get('beforeSeq')));
        return { entries: before.slice(-limit), hasMore: before.length > limit };
      }
      const after = q.has('afterSeq') ? log.filter((e) => e.seq > Number(q.get('afterSeq'))) : log;
      return {
        entries: q.has('afterSeq') ? after.slice(0, limit) : after.slice(-limit),
        hasMore: after.length > limit,
      };
    };
    return { calls, fetchJson };
  }

  it('the URLs: the latest WL_PAGE (100), and the WL_PAGE before a seq', () => {
    expect(Number(clientVar('WL_PAGE').match(/\d+/)?.[0])).toBe(100);
    expect(wl.wlLatestUrl('c/1')).toBe('/api/dashboard/session/c%2F1/worklog?limit=100');
    expect(wl.wlOlderUrl('c1', 784)).toBe('/api/dashboard/session/c1/worklog?beforeSeq=784&limit=100');
  });

  it('an opening loads the latest 100 entries and nothing else — never the whole history', async () => {
    const srv = server(range(1, 1200));
    const st = wl.wlNewState('c');
    expect(await wl.wlLoadLatest(st, srv.fetchJson, () => {})).toBe('ok');
    expect(st.entries.map((e: E) => e.seq)).toEqual(range(1101, 1200).map((e) => e.seq));
    expect(st.olderPending).toBe(true); // older entries exist: the reader may page back
    expect(srv.calls).toEqual(['limit=100']);
  });

  it('each older page is the 100 before the oldest held, merged by seq and painted once — down to the start', async () => {
    const srv = server(range(1, 1200));
    const st = wl.wlNewState('c');
    await wl.wlLoadLatest(st, srv.fetchJson, () => {});
    let paints = 0;
    const onAdded = (_s: unknown, a: Array<{ entry: E; index: number }>) => {
      paints++;
      expect(a[0].index).toBe(0); // older entries go in above
    };
    expect(await wl.wlLoadOlderPage(st, srv.fetchJson, onAdded)).toBe('ok');
    expect(st.entries[0].seq).toBe(1001);
    expect(srv.calls[1]).toBe('beforeSeq=1101&limit=100');
    while (st.olderPending) await wl.wlLoadOlderPage(st, srv.fetchJson, onAdded);
    expect(st.entries.map((e: E) => e.seq)).toEqual(range(1, 1200).map((e) => e.seq));
    expect(paints).toBe(11);
    expect(srv.calls).toHaveLength(12);
    // At the start: nothing more is asked.
    await wl.wlLoadOlderPage(st, srv.fetchJson, onAdded);
    expect(srv.calls).toHaveLength(12);
  });

  it('one page at a time: a second ask while one is in flight shares it', async () => {
    const srv = server(range(1, 1200));
    const st = wl.wlNewState('c');
    await wl.wlLoadLatest(st, srv.fetchJson, () => {});
    const a = wl.wlLoadOlderPage(st, srv.fetchJson, () => {});
    const b = wl.wlLoadOlderPage(st, srv.fetchJson, () => {});
    expect(b).toBe(a);
    await a;
    expect(srv.calls).toEqual(['limit=100', 'beforeSeq=1101&limit=100']);
    expect(st.olderLoading).toBeNull();
  });

  it('a page that fails keeps the older entries pending; the next try asks the same page (no gap)', async () => {
    const srv = server(range(1, 1200));
    const st = wl.wlNewState('c');
    await wl.wlLoadLatest(st, srv.fetchJson, () => {});
    const r = await wl.wlLoadOlderPage(
      st,
      async () => {
        throw Object.assign(new Error('HTTP 500'), { status: 500 });
      },
      () => {},
    );
    expect(r).toBe('error');
    expect(st.olderPending).toBe(true);
    await wl.wlLoadOlderPage(st, srv.fetchJson, () => {});
    expect(srv.calls[1]).toBe('beforeSeq=1101&limit=100');
    expect(st.entries.map((e: E) => e.seq)).toEqual(range(1001, 1200).map((e) => e.seq));
  });

  it('a log that fits the latest window asks for nothing more', async () => {
    const srv = server(range(1, 40));
    const st = wl.wlNewState('c');
    await wl.wlLoadLatest(st, srv.fetchJson, () => {});
    expect(st.olderPending).toBe(false);
    await wl.wlLoadOlderPage(st, srv.fetchJson, () => {});
    expect(srv.calls).toEqual(['limit=100']);
  });

  it('a server that keeps saying hasMore but brings nothing older ends the paging after 3 such pages in a row', async () => {
    const st = wl.wlNewState('c');
    const calls: string[] = [];
    const stuck = async (url: string) => {
      calls.push(url);
      return { entries: calls.length === 1 ? range(901, 1000) : [], hasMore: true };
    };
    await wl.wlLoadLatest(st, stuck, () => {});
    expect(await wl.wlLoadOlderPage(st, stuck, () => {})).toBe('empty');
    expect(st.olderPending).toBe(true);
    await wl.wlLoadOlderPage(st, stuck, () => {});
    await wl.wlLoadOlderPage(st, stuck, () => {});
    expect(st.olderPending).toBe(false);
    await wl.wlLoadOlderPage(st, stuck, () => {});
    expect(calls).toHaveLength(4);
    // The same page each time: the cursor did not move.
    expect(new Set(calls.slice(1)).size).toBe(1);
  });

  // #542 review P3: the server stops a beforeSeq scan at its byte budget inside a long run of
  // non-entry lines with an empty page and hasMore: true — that is not the start of the log.
  it('an empty older page that says hasMore (a budget stop) keeps the paging: the same page is asked again', async () => {
    const st = wl.wlNewState('c');
    const calls: string[] = [];
    let budgetStops = 1;
    const srv = async (url: string) => {
      const q = new URL(url, 'http://h').searchParams;
      calls.push(q.toString());
      if (!q.has('beforeSeq')) return { entries: range(901, 1000), hasMore: true };
      if (budgetStops-- > 0) return { entries: [], hasMore: true };
      return { entries: range(801, 900), hasMore: true };
    };
    await wl.wlLoadLatest(st, srv, () => {});
    await wl.wlLoadOlderPage(st, srv, () => {});
    expect(st.olderPending).toBe(true);
    expect(await wl.wlLoadOlderPage(st, srv, () => {})).toBe('ok');
    expect(calls.slice(1)).toEqual(['beforeSeq=901&limit=100', 'beforeSeq=901&limit=100']);
    expect(st.entries[0].seq).toBe(801);
    // A page that brings entries starts the count again.
    expect(st.olderEmpty).toBe(0);
    expect(st.olderPending).toBe(true);
  });

  // #562 review P3: past a run of non-entry lines longer than one scan budget the server's search
  // lands after the run every time; its byte cursor (nextBeforeOffset) is what gets the next page through.
  it("an empty page's byte cursor is sent with the next page and moves it on, until entries come", async () => {
    const st = wl.wlNewState('c');
    const calls: string[] = [];
    const cursors = [9_000_000, 1_000_000];
    const srv = async (url: string) => {
      const q = new URL(url, 'http://h').searchParams;
      calls.push(q.toString());
      if (!q.has('beforeSeq')) return { entries: range(901, 1000), hasMore: true };
      const next = cursors.shift();
      if (next !== undefined) return { entries: [], hasMore: true, nextBeforeOffset: next };
      return { entries: range(801, 900), hasMore: true };
    };
    await wl.wlLoadLatest(st, srv, () => {});
    expect(await wl.wlLoadOlderPage(st, srv, () => {})).toBe('empty');
    expect(await wl.wlLoadOlderPage(st, srv, () => {})).toBe('empty');
    // Two empty pages, but each moved the cursor: they do not count towards the stop.
    expect(st.olderPending).toBe(true);
    expect(await wl.wlLoadOlderPage(st, srv, () => {})).toBe('ok');
    expect(calls.slice(1)).toEqual([
      'beforeSeq=901&limit=100',
      'beforeSeq=901&limit=100&beforeOffset=9000000',
      'beforeSeq=901&limit=100&beforeOffset=1000000',
    ]);
    expect(st.entries[0].seq).toBe(801);
    // Entries came without a cursor: the next page searches from the oldest held again.
    expect(st.olderOffset).toBeUndefined();
  });

  it('a cursor that does not move counts as an empty page (a server repeating one cannot spin the paging)', async () => {
    const st = wl.wlNewState('c');
    const calls: string[] = [];
    const srv = async (url: string) => {
      const q = new URL(url, 'http://h').searchParams;
      calls.push(q.toString());
      if (!q.has('beforeSeq')) return { entries: range(901, 1000), hasMore: true };
      return { entries: [], hasMore: true, nextBeforeOffset: 5000 };
    };
    await wl.wlLoadLatest(st, srv, () => {});
    for (let i = 0; i < 6; i++) await wl.wlLoadOlderPage(st, srv, () => {});
    expect(st.olderPending).toBe(false);
    // The first stop set the cursor; the next 3 repeated it.
    expect(calls).toHaveLength(5);
  });

  it('the older-page URL carries a byte cursor only when given one', () => {
    expect(wl.wlOlderUrl('c1', 784)).toBe('/api/dashboard/session/c1/worklog?beforeSeq=784&limit=100');
    expect((wl as any).wlOlderUrl('c1', 784, 4096)).toBe(
      '/api/dashboard/session/c1/worklog?beforeSeq=784&limit=100&beforeOffset=4096',
    );
  });

  it('stops for a closed panel and on 403', async () => {
    const srv = server(range(1, 1200));
    const st = wl.wlNewState('c');
    await wl.wlLoadLatest(st, srv.fetchJson, () => {});
    st.closed = true;
    await wl.wlLoadOlderPage(st, srv.fetchJson, () => {});
    expect(srv.calls).toEqual(['limit=100']);
    const st2 = wl.wlNewState('c');
    await wl.wlLoadLatest(st2, srv.fetchJson, () => {});
    await wl.wlLoadOlderPage(
      st2,
      async () => {
        throw Object.assign(new Error('HTTP 403'), { status: 403 });
      },
      () => {},
    );
    expect(st2.denied).toBe(true);
  });

  // #542 review P3: a subagent tab looking for its spawn call walks back a bounded number of pages.
  it('a subagent tab seeks its spawn call back at most WL_SEEK_MAX_PAGES (20) pages — also for an agent the bar does not know', () => {
    let pages = 0;
    const seek = load<{ wlSeekAgentSpawn(st: any, a: any, id: string): void }>(
      ['wlSeekAgentSpawn'],
      ['WL_SEEK_MAX_PAGES'],
      {
        toNum: (v: unknown) => Number(v) || 0,
        loadOlderWorkLog: () => {
          pages++;
        },
      },
    );
    const st = { olderPending: true, olderLoading: null, entries: [{ seq: 90_000, ts: 1_000 }] };
    // A log-only agent (panelAgentOf null: no start time, so no floor) used to page to the start of the log.
    for (let i = 0; i < 50; i++) seek.wlSeekAgentSpawn(st, null, 'toolu_logonly');
    expect(pages).toBe(20);
    // Another agent's tab has its own walk.
    for (let i = 0; i < 50; i++) seek.wlSeekAgentSpawn(st, null, 'toolu_other');
    expect(pages).toBe(40);
    // A known agent still stops once the window reaches back past its start.
    const known = { olderPending: true, olderLoading: null, entries: [{ seq: 5, ts: 1_000 }] };
    seek.wlSeekAgentSpawn(known, { startedAt: 100_000 }, 'toolu_known');
    expect(pages).toBe(40);
    // Nothing while a page is in flight or nothing older exists.
    seek.wlSeekAgentSpawn({ ...st, olderLoading: Promise.resolve() }, null, 'toolu_x');
    seek.wlSeekAgentSpawn({ ...st, olderPending: false }, null, 'toolu_x');
    expect(pages).toBe(40);
    expect(clientFn('renderAgentConv')).toContain('wlSeekAgentSpawn(_wl, a, _panelAgent);');
  });

  it('recovery no longer stops at 20 pages (10,000 entries)', () => {
    expect(Number(clientVar('WL_BACKFILL_MAX_PAGES').match(/\d+/)?.[0])).toBeGreaterThanOrEqual(1000);
  });
});

describe('work log folds under the task each entry was made in (T10; <ui-work-log> groups)', () => {
  type Group = {
    id: string;
    ref?: string;
    title?: string;
    open?: boolean;
    count?: number;
    headless?: boolean;
    meta?: unknown[];
    entries: Array<{ id: string }>;
  };
  const groupsOf = (entries: unknown[], tasks: Record<string, unknown> = {}, st: Record<string, unknown> = {}) =>
    load<{ wlGroupsOf(st: unknown, entries: unknown[]): Group[] }>(['wlGroupOf', 'wlGroupOpen', 'wlGroupsOf'], [], {
      wlTaskMeta: (t: Record<string, unknown>) =>
        t.toolCalls === undefined ? [] : [{ label: '툴', value: `${t.toolCalls}회` }],
      wlTaskInfo: (id: string) => tasks[id] ?? null,
      wlEntryOf: (_st: unknown, e: { seq: number; kind: string; text: string }) => ({
        id: String(e.seq),
        kind: e.kind,
        text: e.text,
      }),
    }).wlGroupsOf({ entries, ...st }, entries);
  const E = (seq: number, taskId?: string, taskTitle?: string, kind = 'tool') => ({
    seq,
    ts: 0,
    kind,
    text: `e${seq}`,
    ...(taskId ? { taskId, taskTitle } : {}),
  });

  it('entries of one task gather under it, at its first entry; entries outside any task are headless runs in line (D3-GAPS G2-2)', () => {
    const g = groupsOf(
      [
        E(1, undefined, undefined, 'instruction'),
        E(2, 'T1', 'Explore'),
        E(3, 'T1', 'Explore'),
        E(4, 'T2', 'Build'),
        E(5, undefined, undefined, 'final'),
        E(6, 'T1', 'Explore again'),
      ],
      {},
      { groupOpen: { 'task:T1': true } },
    );
    expect(g.map((x) => `${x.id}:${x.entries.map((e) => e.id).join(',')}`)).toEqual([
      'run:1:1',
      'task:T1:2,3,6',
      'task:T2:',
      'run:5:5',
    ]);
    // The group is titled by its latest entry (no ledger task, so no meta); the newest task is open at first sight.
    expect(g[1]).toMatchObject({ ref: '#T1', title: 'Explore again', count: 3, open: true });
    expect(g[1].meta).toBeUndefined();
    expect(g[2]).toMatchObject({ ref: '#T2', title: 'Build', count: 1, open: false });
    // A run outside any task: no head (nothing to title, count, fold or open) — its entries always in line.
    expect(g[0]).toEqual({
      id: 'run:1',
      at: 0,
      headless: true,
      entries: [{ id: '1', kind: 'instruction', text: 'e1' }],
    });
    expect(g[3]).toEqual({ id: 'run:5', at: 0, headless: true, entries: [{ id: '5', kind: 'final', text: 'e5' }] });
  });

  it('a group head: #id, the ledger’s title and meta, the count; a folded group holds no entries until it is opened (DOM size)', () => {
    const tasks = { T1: { id: 'T1', content: 'Explore (ledger)', status: 'completed', toolCalls: 2 } };
    const closed = groupsOf([E(2, 'T1', 'Explore'), E(3, 'T1', 'Explore'), E(4, 'T2', 'Build')], tasks);
    expect(closed[0]).toEqual({
      id: 'task:T1',
      at: 0,
      ref: '#T1',
      title: 'Explore (ledger)',
      meta: [{ label: '툴', value: '2회' }],
      open: false,
      count: 2,
      entries: [],
    });
    const open = groupsOf([E(2, 'T1', 'Explore'), E(3, 'T1', 'Explore')], tasks, { groupOpen: { 'task:T1': true } });
    expect(open[0].entries.map((e) => e.id)).toEqual(['2', '3']);
  });

  it('task ids and titles are data (the element escapes them)', () => {
    const g = groupsOf([E(2, '"><img src=x>', '<script>')]);
    expect(g[0]).toMatchObject({ id: 'task:"><img src=x>', ref: '#"><img src=x>', title: '<script>' });
  });
});

describe('DONE grouped by the day the work finished (T11/T12)', () => {
  const m = load<{
    planDoneGroups(
      done: Array<{ s: any; col: string }>,
      now: number,
      opened: Record<string, boolean>,
    ): Array<{ key: string; label: string; open: boolean; items: Array<{ s: any; col: string }> }>;
    doneTimeOf(s: unknown): number;
  }>(['toNum', 'doneTimeOf', 'dayKeyOf', 'doneDayLabel', 'planDoneGroups'], []);
  // Local wall-clock times: the groups follow the viewer's calendar.
  const NOW = new Date(2026, 9, 22, 15, 0).getTime();
  const at = (d: number, h: number) => new Date(2026, 9, d, h, 0).getTime();
  const item = (key: string, doneAt: number | undefined, extra: Record<string, unknown> = {}) => ({
    s: { key, doneAt, lastActivity: new Date(at(1, 0)).toISOString(), ...extra },
    col: 'idle',
  });
  const done = [
    item('older-2', at(19, 9)),
    item('today-early', at(22, 1)),
    item('yesterday', at(21, 23)),
    item('today-late', at(22, 14)),
    item('older-1', at(20, 10)),
    item('older-1b', at(20, 18)),
  ];

  it('groups by finish day — Today, 어제, then each earlier day — newest first, cards newest first', () => {
    const g = m.planDoneGroups(done, NOW, {});
    expect(g.map((x) => [x.label, x.items.map((i) => i.s.key)])).toEqual([
      ['오늘', ['today-late', 'today-early']],
      ['어제', ['yesterday']],
      [expect.stringContaining('10월 20일'), ['older-1b', 'older-1']],
      [expect.stringContaining('10월 19일'), ['older-2']],
    ]);
    expect(g.map((x) => x.key)).toEqual(['2026-10-22', '2026-10-21', '2026-10-20', '2026-10-19']);
  });

  it('Today and 어제 start open; earlier days start closed', () => {
    expect(m.planDoneGroups(done, NOW, {}).map((x) => x.open)).toEqual([true, true, false, false]);
  });

  it('the reader’s choice wins over the default, both ways', () => {
    const g = m.planDoneGroups(done, NOW, { '2026-10-20': true, '2026-10-22': false });
    expect(g.map((x) => x.open)).toEqual([false, true, true, false]);
  });

  it('a card without a finish time falls back to its last activity', () => {
    const s = { key: 'x', lastActivity: new Date(at(21, 8)).toISOString() };
    expect(m.doneTimeOf(s)).toBe(at(21, 8));
    const g = m.planDoneGroups([{ s, col: 'closed' }], NOW, {});
    expect(g.map((x) => x.label)).toEqual(['어제']);
  });

  it('a day of another year names the year', () => {
    const g = m.planDoneGroups([item('last-year', new Date(2025, 11, 31, 10).getTime())], NOW, {});
    expect(g[0].label).toContain('2025');
  });

  it('no cards, no groups', () => {
    expect(m.planDoneGroups([], NOW, {})).toEqual([]);
  });
});

describe('model switch on the open card (T4/T5)', () => {
  // The <select> became the model menu (.prd/affectui/re-model-picker.md D1/D3), now @2lab.ai/ui
  // <ui-model-picker>: the dashboard hands it the same six models (mpData) and the context; the element
  // draws the rows and the "compact 후 전환" rule ('marks a row whose auto-compact point is below the
  // context as switching after compaction' in the library's model-picker.test.ts).
  const MODELS = [
    { nickname: 'opus[1m]', model: 'claude-opus-5-5[1m]', autoCompactTokens: 750_000 },
    { nickname: 'fable[1m]', model: 'claude-fable-5-1[1m]', autoCompactTokens: 750_000 },
    { nickname: 'sonnet[1m]', model: 'claude-sonnet-4-6[1m]', autoCompactTokens: 750_000 },
    { nickname: 'sol[1m]', model: 'gpt-5.6-sol[1m]', autoCompactTokens: 600_000 },
    { nickname: 'astra[1m]', model: 'gpt-6-astra[1m]', autoCompactTokens: 600_000 },
    { nickname: 'grok[1m]', model: 'grok-4.6', autoCompactTokens: 450_000 },
  ];
  const notes: Record<string, unknown> = {};
  const m = load<{
    renderModelPicker(s: unknown, canSwitch: boolean, short: string): string;
    mpData(s: unknown): {
      models: Array<{ id: string; autoCompactAt: number }>;
      value: { model: string };
      contextTokens: number;
      busy: { model: unknown };
    };
    renderModelNote(s: unknown, picker?: boolean): string;
    modelSwitchNote(r: unknown): { text: string; error: boolean };
  }>(
    [
      'esc',
      'escAttr',
      'toNum',
      'formatTokens',
      'isBusy',
      'mpShort',
      'mpEffortLevels',
      'mpData',
      'renderModelPicker',
      'renderModelNote',
      'modelSwitchNote',
    ],
    ['_busy'],
    {
      REPRESENTATIVE_MODELS: MODELS,
      EFFORT_LEVELS: ['low', 'medium', 'high', 'xhigh', 'max'],
      _modelNotes: notes,
    },
  );
  const s = (over: Record<string, unknown> = {}) => ({
    key: 'inst::C1:t1',
    model: 'claude-opus-5-5[1m]',
    contextTokens: 500_000,
    ...over,
  });

  it('offers exactly the six representative models, the current one the value', () => {
    const d = m.mpData(s());
    expect(d.models.map((x) => x.id)).toEqual([
      'opus[1m]',
      'fable[1m]',
      'sonnet[1m]',
      'sol[1m]',
      'astra[1m]',
      'grok[1m]',
    ]);
    expect(d.value.model).toBe('opus[1m]');
    const trigger = m.renderModelPicker(s(), true, 'opus-5-5[1m]');
    expect(trigger).toContain('<ui-model-picker lang="ko" data-mp-key="inst::C1:t1" data-mp-surface="card">');
    expect(trigger).not.toContain('onclick');
  });

  it('hands over each model’s auto-compact threshold and the context it is measured against', () => {
    const d = m.mpData(s());
    expect(d.models.find((x) => x.id === 'grok[1m]')?.autoCompactAt).toBe(450_000);
    expect(d.contextTokens).toBe(500_000);
  });

  it('a model outside the list is the value by its short id (the element’s current, unselectable entry)', () => {
    expect(m.mpData(s({ model: 'claude-haiku-4-5-20251001' })).value.model).toBe('haiku-4-5');
  });

  it('read-only viewers see the model name, no control; a waiting switch locks the list and says so', () => {
    expect(m.renderModelPicker(s(), false, 'opus-5-5[1m]')).toBe('<span class="cb-model-name">opus-5-5[1m]</span>');
    expect(m.mpData(s({ pendingModel: 'grok[1m]' })).busy.model).toBe('compact 후 grok[1m](으)로 전환 대기 중');
    expect(m.renderModelNote(s({ pendingModel: 'grok[1m]' }))).toContain('compact 후 grok[1m](으)로 전환합니다');
  });

  it('says what the switch did', () => {
    expect(
      m.modelSwitchNote({ ok: true, result: { status: 'switched', nickname: 'grok[1m]', autoCompactTokens: 450_000 } })
        .text,
    ).toBe('grok[1m](으)로 전환 · 자동 압축 450.0K');
    expect(
      m.modelSwitchNote({
        ok: true,
        result: { status: 'compacting', nickname: 'grok[1m]', autoCompactTokens: 450_000 },
      }).text,
    ).toContain('압축한 뒤 전환');
    expect(m.modelSwitchNote({ ok: false, error: '먼저 compact' })).toEqual({ text: '먼저 compact', error: true });
  });
});

describe('a DONE day toggle re-renders from the latest card data (review F9)', () => {
  it('a targeted card push lands in the last board', () => {
    const board = { working: [{ key: 'a', v: 100 }], waiting: [], idle: [{ key: 'b', v: 1 }], closed: [] };
    const m = load<{ patchLastBoard(s: unknown): void }>(['patchLastBoard'], [], { _lastBoardData: board });
    m.patchLastBoard({ key: 'a', v: 200 });
    expect(board.working[0]).toEqual({ key: 'a', v: 200 });
    m.patchLastBoard({ key: 'zz', v: 1 });
    expect(board.idle).toEqual([{ key: 'b', v: 1 }]);
  });
});
