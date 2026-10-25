/**
 * SSOT 2026-10-22 — dashboard live surfaces, client half. Executes the shipped
 * card code (cut out of renderDashboardPage()'s template literal and cooked
 * exactly as the browser receives it — the harness of
 * dashboard-agent-inbox-client.test.ts):
 *
 *   T1/T2  collapsed card: total tokens + API-equivalent cost, counted up live
 *   T3     collapsed card: the task in progress — its id, name and running time
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
function load<T>(fns: string[], vars: string[], inject: Record<string, unknown> = {}): T {
  const names = Object.keys(inject);
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}

const SHOW_ALL = {
  dhShow: () => true,
  dhMax: (_f: string, d: number) => d,
  dhTruncate: () => null,
  currentUserId: 'U1',
  // The artifact row has its own suite (dashboard-artifacts-client.test.ts).
  isSiblingSession: () => false,
  artFaceChips: () => '',
  umFaceBadge: () => '',
};
const FACE_FNS = [
  'esc',
  'escAttr',
  'escJs',
  'toNum',
  'formatTokens',
  'formatCount',
  'cardTotalTokens',
  'cardCurrentTask',
  'renderCardTaskRow',
  'agentStatusOf',
  'agentCounts',
  'renderCardAgents',
  'renderCardUsage',
  'formatTaskTime',
  'pendingAutoResume',
  'autoResumeLabel',
  'cardSummary',
  'renderCardStatus',
  'renderOwnerBadge',
  'renderCardFace',
];
const FACE_VARS = [
  'SPARK_SVG',
  'WAIT_SVG',
  'TASKS_SVG',
  'CTX_SVG',
  'RESUME_SVG',
  'AGENT_STATUS_LABEL',
  'AGENT_DOTS_MAX',
  'AGENTS_SVG',
];

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
  const face = load<{ renderCardFace(s: unknown, col: string): string; cardTotalTokens(u: unknown): number }>(
    FACE_FNS,
    FACE_VARS,
    SHOW_ALL,
  );

  it('shows the session total of every token kind and the API-equivalent cost, as count-up targets', () => {
    const html = face.renderCardFace(workingCard(), 'working');
    expect(html).toContain('<span class="cnt" data-cnt="tok" data-to="6500">6,500</span>');
    expect(html).toContain('<span class="cnt" data-cnt="cost" data-to="1.2345">$1.23</span>');
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
    expect(face.renderCardFace(workingCard(), 'idle')).toContain('data-cnt="tok"');
    expect(face.renderCardFace(workingCard(), 'closed')).toContain('data-cnt="cost"');
    expect(face.renderCardFace(workingCard({ tokenUsage: undefined }), 'working')).not.toContain('card-usage');
  });

  it('follows the dashboard header fields: tokens and cost hide independently', () => {
    const noCost = load<{ renderCardFace(s: unknown, col: string): string }>(FACE_FNS, FACE_VARS, {
      ...SHOW_ALL,
      dhShow: (f: string) => f !== 'cost',
    });
    const html = noCost.renderCardFace(workingCard(), 'working');
    expect(html).toContain('data-cnt="tok"');
    expect(html).not.toContain('data-cnt="cost"');
  });

  it('a hostile number renders as a plain number', () => {
    const html = face.renderCardFace(
      workingCard({ tokenUsage: { totalInputTokens: '"><img src=x onerror=alert(1)>', totalCostUsd: 'x' } }),
      'working',
    );
    expect(html).not.toMatch(/onerror|<img/);
    expect(html).toContain('data-to="0"');
  });
});

describe('collapsed card: the task in progress (T3)', () => {
  const face = load<{ renderCardFace(s: unknown, col: string): string }>(FACE_FNS, FACE_VARS, SHOW_ALL);

  it('names the running task with its id and a live elapsed timer', () => {
    const html = face.renderCardFace(workingCard(), 'working');
    expect(html).toContain('<span class="ct-id">#T2</span>');
    expect(html).toContain('<span class="ct-name">Write the parser</span>');
    expect(html).toContain('<span class="ct-time task-elapsed" data-since="61000"></span>');
  });

  it('the summary line no longer repeats the task the task row already shows', () => {
    const html = face.renderCardFace(
      workingCard({ summaryTitle: 'Parser rewrite', displayHeadline: 'Headline' }),
      'working',
    );
    expect(html).toContain('<div class="card-summary">Parser rewrite</div>');
    expect(html.match(/Write the parser/g)).toHaveLength(1);
  });

  it('a waiting card still shows its task; finished cards and cards without a running task show none', () => {
    expect(face.renderCardFace(workingCard(), 'waiting')).toContain('card-task');
    expect(face.renderCardFace(workingCard(), 'idle')).not.toContain('card-task');
    const noneRunning = workingCard({ tasks: [{ id: 'T1', content: 'a', status: 'pending', toolCalls: 0 }] });
    expect(face.renderCardFace(noneRunning, 'working')).not.toContain('card-task');
  });

  it('escapes the task name and id', () => {
    const html = face.renderCardFace(
      workingCard({
        tasks: [
          { id: '<b>', content: '<img src=x onerror=alert(1)>', status: 'in_progress', startedAt: 'x', toolCalls: 0 },
        ],
      }),
      'working',
    );
    expect(html).not.toMatch(/<img|<b>/);
    expect(html).not.toContain('data-since="x"');
  });
});

describe('count-up animation of the usage numbers (T1/T2)', () => {
  function rig(opts: { animate?: boolean; reduce?: boolean } = {}) {
    const frames: Array<(t: number) => void> = [];
    let now = 0;
    const m = load<{
      startCountUp(el: unknown, id: string): void;
      countUpValue(from: number, to: number, p: number): number;
    }>(['toNum', 'formatCount', 'countUpValue', 'startCountUp'], ['COUNT_UP_MS', '_counters'], {
      canAnimate: () => opts.animate !== false,
      reduceMotion: () => !!opts.reduce,
      requestAnimationFrame: (f: (t: number) => void) => frames.push(f),
      cancelAnimationFrame: () => {},
      performance: { now: () => now },
    });
    const el = (to: number, kind = 'tok') => {
      const attrs: Record<string, string> = { 'data-cnt': kind, 'data-to': String(to) };
      return { textContent: '', getAttribute: (k: string) => attrs[k] ?? null };
    };
    const run = (ms: number) => {
      now += ms;
      const f = frames.shift();
      if (f) f(now);
    };
    return { m, el, run, frames };
  }

  it('the first paint shows the value as is; a higher value counts up to it frame by frame', () => {
    const r = rig();
    const a = r.el(1000);
    r.m.startCountUp(a, 'k|tok');
    expect(r.frames).toHaveLength(0);
    const b = r.el(2000);
    r.m.startCountUp(b, 'k|tok');
    expect(b.textContent).toBe('1,000');
    const seen: number[] = [];
    for (let i = 0; i < 40 && r.frames.length; i++) {
      r.run(50);
      seen.push(Number(b.textContent.replace(/,/g, '')));
    }
    expect(seen[seen.length - 1]).toBe(2000);
    expect(seen.every((v, i) => i === 0 || v >= seen[i - 1])).toBe(true);
    expect(seen.some((v) => v > 1000 && v < 2000)).toBe(true);
  });

  it('a new value mid-count continues from the number on screen', () => {
    const r = rig();
    r.m.startCountUp(r.el(0), 'k|tok');
    const b = r.el(1000);
    r.m.startCountUp(b, 'k|tok');
    r.run(300);
    const mid = Number(b.textContent.replace(/,/g, ''));
    const c = r.el(3000);
    r.m.startCountUp(c, 'k|tok');
    expect(Number(c.textContent.replace(/,/g, ''))).toBe(mid);
  });

  it('cost counts in dollars; a lower value and reduced motion jump straight to the value', () => {
    const r = rig();
    r.m.startCountUp(r.el(5, 'cost'), 'k|cost');
    const lower = r.el(2, 'cost');
    r.m.startCountUp(lower, 'k|cost');
    expect(lower.textContent).toBe('$2.00');
    const calm = rig({ reduce: true });
    calm.m.startCountUp(calm.el(1), 'k|tok');
    const up = calm.el(9999);
    calm.m.startCountUp(up, 'k|tok');
    expect(up.textContent).toBe('9,999');
    expect(calm.frames).toHaveLength(0);
  });

  it('eases out: fast first, settling on the target', () => {
    expect(rig().m.countUpValue(0, 100, 0)).toBe(0);
    expect(rig().m.countUpValue(0, 100, 1)).toBe(100);
    expect(rig().m.countUpValue(0, 100, 0.5)).toBeGreaterThan(50);
  });
});

describe('task timeline: ids, elapsed time and tool calls (T7/T8)', () => {
  const tasksOpen: Record<string, boolean> = {};
  const tl = load<{ renderTimeline(s: unknown): string }>(
    ['esc', 'escJs', 'toNum', 'formatDuration', 'renderTaskMeta', 'renderTimelineItem', 'renderTimeline'],
    [],
    { ...SHOW_ALL, _tasksOpen: tasksOpen },
  );

  it('each task shows its id; a completed task its elapsed time and tool calls', () => {
    const html = tl.renderTimeline(workingCard());
    expect(html).toContain('<span class="tl-id">#T1</span>');
    expect(html).toContain('1m 0s');
    expect(html).toContain('툴 7회');
    expect(html).toContain('<span class="task-elapsed" data-since="61000"></span>');
    expect(html).toContain('툴 3회');
    // A pending task has neither time nor tool calls.
    expect(html).toMatch(/#T3<\/span><span class="tl-text">Ship it<\/span><\/li>/);
  });

  it('completed tasks beyond the budget and earlier tasks open on demand', () => {
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
    const closed = tl.renderTimeline(many);
    expect(closed).not.toContain('old plan');
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).toContain('전체 task 보기 (4)');
    tasksOpen[many.key] = true;
    const open = tl.renderTimeline(many);
    for (let i = 1; i <= 8; i++) expect(open).toContain(`#T${i}<`);
    expect(open).toContain('이전 task 1개');
    expect(open).toContain('old plan');
    expect(open).toContain('aria-expanded="true"');
    delete tasksOpen[many.key];
  });

  it('a session with only earlier tasks still offers them', () => {
    const html = tl.renderTimeline(
      workingCard({ tasks: [], earlierTasks: [{ id: 'T9', content: 'x', status: 'completed', toolCalls: 1 }] }),
    );
    expect(html).toContain('전체 task 보기 (1)');
  });
});

describe('panel task rows carry id, elapsed time and tool calls (T7/T8)', () => {
  const { renderPanelTaskItem } = load<{ renderPanelTaskItem(t: unknown): string }>(
    ['esc', 'toNum', 'formatDuration', 'formatTaskTime', 'renderPanelTaskItem'],
    [],
  );
  it('completed: id, duration and tool count', () => {
    const html = renderPanelTaskItem({
      id: 'T4',
      content: 'Build',
      status: 'completed',
      startedAt: 0,
      completedAt: 0,
      toolCalls: 12,
    });
    expect(html).toContain('<span class="task-id">#T4</span>');
    expect(html).toContain('툴 12회');
  });
});

describe('goals: completed goals open with their details (T6)', () => {
  const open: Record<string, boolean> = {};
  const m = load<{ renderCardGoal(s: unknown, col: string, canEdit: boolean): string }>(
    [
      'esc',
      'escAttr',
      'escJs',
      'toNum',
      'formatTokens',
      'formatDuration',
      'formatGoalTime',
      'renderGoalHistory',
      'renderCardGoal',
    ],
    ['GOAL_STATUS_LABELS', '_goalErrors', 'GOAL_VIA_LABELS'],
    { _goalHistoryOpen: open },
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

  it('closed: the head offers the completed goals with their count; no details yet', () => {
    const html = m.renderCardGoal(card(H), 'working', true);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('완료된 goal 2개');
    expect(html).not.toContain('두번째 끝난 goal');
  });

  it('open: every completed goal with when it closed, time spent, tokens, cost, continuations, how and why', () => {
    open['inst::C1:t1'] = true;
    const html = m.renderCardGoal(card(H), 'working', true);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('두번째 끝난 goal');
    expect(html).toContain('10m 0s');
    expect(html).toContain('1.5M tok');
    expect(html).toContain('$3.40');
    expect(html).toContain('이어하기 4회');
    expect(html).toContain('평가 모델 완료');
    expect(html).toContain('모든 요건에 증거가 있다');
    expect(html).toContain('직접 완료');
    // Newest first, as the server sends them.
    expect(html.indexOf('두번째 끝난 goal')).toBeLessThan(html.indexOf('&lt;b&gt;첫&lt;/b&gt;'));
    expect(html).not.toContain('<b>첫');
    delete open['inst::C1:t1'];
  });

  it('a read-only viewer and a closed card can open the history too', () => {
    open['inst::C1:t1'] = true;
    expect(m.renderCardGoal(card(H), 'closed', false)).toContain('두번째 끝난 goal');
    delete open['inst::C1:t1'];
  });

  it('no completed goals: no history control', () => {
    expect(m.renderCardGoal(card([]), 'working', true)).not.toContain('cg-history');
  });
});

describe('work log: every entry, however many (T9)', () => {
  type E = { seq: number; taskId?: string };
  const range = (a: number, b: number): E[] => Array.from({ length: b - a + 1 }, (_, i) => ({ seq: a + i }));
  const wl = load<{
    wlNewState(c: string): any;
    wlLoadLatest(st: any, f: (u: string) => Promise<unknown>, on: (s: any, a: any[]) => void): Promise<string>;
    wlLoadOlder(st: any, f: (u: string) => Promise<unknown>, on: (s: any, a: any[]) => void): Promise<unknown>;
  }>(
    [
      'wlNewState',
      'wlUrl',
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
      'wlLoadOlder',
    ],
    ['WL_BACKFILL_MAX_PAGES'],
  );
  /** The real API: no afterSeq = the latest `size`; afterSeq = the first `size` after it. */
  function server(log: E[], size: number) {
    const calls: Array<string | null> = [];
    const fetchJson = async (url: string) => {
      const q = new URL(url, 'http://h').searchParams.get('afterSeq');
      calls.push(q);
      const rest = q === null ? log : log.filter((e) => e.seq > Number(q));
      return { entries: q === null ? rest.slice(-size) : rest.slice(0, size), hasMore: rest.length > size };
    };
    return { calls, fetchJson };
  }

  it('after the latest window, pages the older entries in until the log is whole', async () => {
    const srv = server(range(1, 1200), 500);
    const st = wl.wlNewState('c');
    const painted: number[] = [];
    const onAdded = (_s: unknown, a: Array<{ entry: E }>) => painted.push(...a.map((x) => x.entry.seq));
    expect(await wl.wlLoadLatest(st, srv.fetchJson, onAdded)).toBe('ok');
    expect(st.entries).toHaveLength(500);
    await wl.wlLoadOlder(st, srv.fetchJson, onAdded);
    expect(st.entries.map((e: E) => e.seq)).toEqual(range(1, 1200).map((e) => e.seq));
    expect(srv.calls).toEqual([null, '0', '500']);
    expect(new Set(painted).size).toBe(1200);
  });

  it('the older pages paint once, after the last page — not a full re-render per page (review P1)', async () => {
    const srv = server(range(1, 5000), 500);
    const st = wl.wlNewState('c');
    let paints = 0;
    await wl.wlLoadLatest(st, srv.fetchJson, () => {});
    await wl.wlLoadOlder(st, srv.fetchJson, () => {
      paints++;
    });
    expect(st.entries).toHaveLength(5000);
    expect(srv.calls.length).toBe(11); // the latest window + 10 forward pages
    expect(paints).toBe(1);
  });

  it('an older page that fails keeps the history pending, so the next try asks again (review F8)', async () => {
    const srv = server(range(1, 1200), 500);
    const st = wl.wlNewState('c');
    await wl.wlLoadLatest(st, srv.fetchJson, () => {});
    await wl.wlLoadOlder(
      st,
      async () => {
        throw Object.assign(new Error('HTTP 500'), { status: 500 });
      },
      () => {},
    );
    expect(st.olderPending).toBe(true);
    await wl.wlLoadOlder(st, srv.fetchJson, () => {});
    expect(st.entries).toHaveLength(1200);
    expect(st.olderPending).toBe(false);
  });

  it('a retry after a partial success resumes where it stopped — no gap is left (review R2-2)', async () => {
    const srv = server(range(1, 1200), 500);
    const st = wl.wlNewState('c');
    await wl.wlLoadLatest(st, srv.fetchJson, () => {});
    let n = 0;
    await wl.wlLoadOlder(
      st,
      async (u: string) => {
        n++;
        if (n === 2) throw Object.assign(new Error('HTTP 500'), { status: 500 });
        return srv.fetchJson(u);
      },
      () => {},
    );
    expect(st.olderPending).toBe(true);
    await wl.wlLoadOlder(st, srv.fetchJson, () => {});
    expect(st.entries.map((e: E) => e.seq)).toEqual(range(1, 1200).map((e) => e.seq));
    expect(st.olderPending).toBe(false);
  });

  it('a log that fits the latest window asks for nothing more', async () => {
    const srv = server(range(1, 40), 500);
    const st = wl.wlNewState('c');
    await wl.wlLoadLatest(st, srv.fetchJson, () => {});
    await wl.wlLoadOlder(st, srv.fetchJson, () => {});
    expect(srv.calls).toEqual([null]);
  });

  it('stops for a closed panel and on 403', async () => {
    const srv = server(range(1, 1200), 500);
    const st = wl.wlNewState('c');
    await wl.wlLoadLatest(st, srv.fetchJson, () => {});
    st.closed = true;
    await wl.wlLoadOlder(st, srv.fetchJson, () => {});
    expect(srv.calls).toEqual([null]);
    const st2 = wl.wlNewState('c');
    await wl.wlLoadLatest(st2, srv.fetchJson, () => {});
    await wl.wlLoadOlder(
      st2,
      async () => {
        throw Object.assign(new Error('HTTP 403'), { status: 403 });
      },
      () => {},
    );
    expect(st2.denied).toBe(true);
  });

  it('recovery no longer stops at 20 pages (10,000 entries)', () => {
    expect(Number(clientVar('WL_BACKFILL_MAX_PAGES').match(/\d+/)?.[0])).toBeGreaterThanOrEqual(1000);
  });
});

describe('work log folds under the task each entry was made in (T10)', () => {
  const m = load<{
    wlBuildRows(entries: unknown[]): Array<{ entry?: any; group?: any }>;
    renderWorkLogGroup(group: unknown, open: boolean, task: unknown): string;
  }>(
    [
      'esc',
      'escAttr',
      'toNum',
      'formatDuration',
      'decodeSlackEntities',
      'renderTaskMeta',
      'renderWorkLogEntry',
      'wlGroupOf',
      'wlBuildRows',
      'renderWorkLogGroupHead',
      'renderWorkLogGroup',
    ],
    ['WL_LABELS'],
  );
  const E = (seq: number, taskId?: string, taskTitle?: string, kind = 'tool') => ({
    seq,
    ts: 0,
    kind,
    text: `e${seq}`,
    ...(taskId ? { taskId, taskTitle } : {}),
  });

  it('entries of one task gather under it, at its first entry; entries outside any task stay in line', () => {
    const rows = m.wlBuildRows([
      E(1, undefined, undefined, 'instruction'),
      E(2, 'T1', 'Explore'),
      E(3, 'T1', 'Explore'),
      E(4, 'T2', 'Build'),
      E(5, undefined, undefined, 'final'),
      E(6, 'T1', 'Explore again'),
    ]);
    expect(
      rows.map((r) =>
        r.entry ? r.entry.seq : `${r.group.taskId}:${r.group.entries.map((e: any) => e.seq).join(',')}`,
      ),
    ).toEqual([1, 'T1:2,3,6', 'T2:4', 5]);
    // The group is titled by its latest entry.
    expect(rows[1].group.title).toBe('Explore again');
  });

  it('a group renders as a header button (id, title, count, task time / tools) over its entries', () => {
    const html = m.renderWorkLogGroup(
      { taskId: 'T1', title: 'Explore', entries: [E(2, 'T1', 'Explore'), E(3, 'T1', 'Explore')] },
      false,
      { id: 'T1', content: 'Explore', status: 'completed', startedAt: 1000, completedAt: 61_000, toolCalls: 2 },
    );
    expect(html).toContain('<div class="wl-group" data-task-id="T1">');
    expect(html).toContain('role="button"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('#T1');
    expect(html).toContain('<span class="wl-g-count">2</span>');
    expect(html).toContain('1m 0s');
    expect(html).toContain('툴 2회');
    // A closed group holds no entry nodes until it is opened (review P1: DOM size).
    expect(html).toContain('<div class="wl-group-body" hidden></div>');
    expect(html).not.toContain('data-seq="2"');
    const open = m.renderWorkLogGroup(
      { taskId: 'T1', title: 'Explore', entries: [E(2, 'T1', 'Explore'), E(3, 'T1', 'Explore')] },
      true,
      null,
    );
    expect(open).toContain('data-seq="2"');
    expect(open).toContain('data-seq="3"');
    expect(m.renderWorkLogGroup({ taskId: 'T1', title: 'x', entries: [] }, true, null)).toContain(
      '<div class="wl-group-body" data-filled="1">',
    );
  });

  it('escapes task ids and titles', () => {
    const html = m.renderWorkLogGroup({ taskId: '"><img src=x>', title: '<script>', entries: [] }, true, null);
    expect(html).not.toMatch(/<img|<script/);
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
      ['Today', ['today-late', 'today-early']],
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
    renderModelNote(s: unknown): string;
    modelSwitchNote(r: unknown): { text: string; error: boolean };
  }>(
    ['esc', 'escAttr', 'escJs', 'toNum', 'formatTokens', 'renderModelPicker', 'renderModelNote', 'modelSwitchNote'],
    [],
    {
      REPRESENTATIVE_MODELS: MODELS,
      _modelNotes: notes,
    },
  );
  const s = (over: Record<string, unknown> = {}) => ({
    key: 'inst::C1:t1',
    model: 'claude-opus-5-5[1m]',
    contextTokens: 500_000,
    ...over,
  });

  it('offers exactly the six representative models, the current one selected', () => {
    const html = m.renderModelPicker(s(), true, 'opus-5-5[1m]');
    const values = [...html.matchAll(/<option value="([^"]*)"/g)].map((x) => x[1]);
    expect(values).toEqual(['opus[1m]', 'fable[1m]', 'sonnet[1m]', 'sol[1m]', 'astra[1m]', 'grok[1m]']);
    expect(html).toMatch(/<option value="opus\[1m\]" selected>/);
    expect(html).toContain('aria-label="모델 변경"');
    expect(html).toContain('onchange="changeModel(\'inst::C1:t1\',this)"');
  });

  it('shows each model’s auto-compact threshold; a target below the context says it compacts first', () => {
    const html = m.renderModelPicker(s(), true, 'opus');
    expect(html).toContain('grok[1m] · autocompact 450.0K · compact 후 전환');
    expect(html).toContain('fable[1m] · autocompact 750.0K<');
    // The current model never says so.
    expect(html).not.toContain('opus[1m] · autocompact 750.0K · compact');
  });

  it('a model outside the list is shown as the current, unselectable entry', () => {
    const html = m.renderModelPicker(s({ model: 'claude-haiku-4-5-20251001' }), true, 'haiku-4-5');
    expect(html).toContain('<option value="" selected disabled>haiku-4-5</option>');
  });

  it('read-only viewers see the model name, no control; a waiting switch disables the control and says so', () => {
    expect(m.renderModelPicker(s(), false, 'opus-5-5[1m]')).toBe('<span class="cb-model-name">opus-5-5[1m]</span>');
    expect(m.renderModelPicker(s({ pendingModel: 'grok[1m]' }), true, 'opus')).toContain(
      '<select class="cb-model-select" aria-label="모델 변경" disabled',
    );
    expect(m.renderModelNote(s({ pendingModel: 'grok[1m]' }))).toContain('compact 후 grok[1m](으)로 전환합니다');
  });

  it('says what the switch did', () => {
    expect(
      m.modelSwitchNote({ ok: true, result: { status: 'switched', nickname: 'grok[1m]', autoCompactTokens: 450_000 } })
        .text,
    ).toBe('grok[1m](으)로 전환 · autocompact 450.0K');
    expect(
      m.modelSwitchNote({
        ok: true,
        result: { status: 'compacting', nickname: 'grok[1m]', autoCompactTokens: 450_000 },
      }).text,
    ).toContain('compact한 뒤 전환');
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
