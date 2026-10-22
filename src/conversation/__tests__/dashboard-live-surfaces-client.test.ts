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

const SHOW_ALL = { dhShow: () => true, dhMax: (_f: string, d: number) => d, dhTruncate: () => null, currentUserId: 'U1' };
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
  'renderCardUsage',
  'cardSummary',
  'renderCardStatus',
  'renderOwnerBadge',
  'renderCardFace',
];
const FACE_VARS = ['SPARK_SVG', 'WAIT_SVG', 'TASKS_SVG', 'CTX_SVG'];

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
      { id: 'T2', content: 'Write the parser', activeForm: 'Writing the parser', status: 'in_progress', startedAt: 61_000, toolCalls: 3 },
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
    const html = face.renderCardFace(workingCard({ summaryTitle: 'Parser rewrite', displayHeadline: 'Headline' }), 'working');
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
        tasks: [{ id: '<b>', content: '<img src=x onerror=alert(1)>', status: 'in_progress', startedAt: 'x', toolCalls: 0 }],
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
      earlierTasks: [{ id: 'T0', content: 'old plan', status: 'completed', startedAt: 1, completedAt: 2, toolCalls: 4 }],
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
