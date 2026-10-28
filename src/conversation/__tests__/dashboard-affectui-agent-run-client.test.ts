/**
 * affectUI Agent Run → the session detail panel (.prd/affectui/re-agent-run.md,
 * issue #439). Executes the shipped client code cut out of renderDashboardPage()'s
 * template literal, cooked exactly as the browser receives it (the harness of
 * dashboard-three-surfaces-client.test.ts).
 *
 *   plan        = the Tasks section of the focused tab (task view T1.3: folded
 *                 by default; opened, a plan): original order, markers, rail,
 *                 a footer with the phase, announcements (D1–D7)
 *   needs input = a header with a count, approval cards for permission prompts
 *                 and the single-choice question, the keyboard, the answered
 *                 row, the expiry clock (D8–D17)
 *   head        = the status pill, 시작 · 경과 (D18); 세부 = Details (D19)
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { uiLibDistDir } from '../dashboard';

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
const CSS = cook(TEMPLATE.slice(TEMPLATE.indexOf('<style>'), TEMPLATE.indexOf('</style>')));
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

// ── Plan (D1–D7) ──
type Task = {
  id: string;
  content: string;
  status: string;
  activeForm?: string;
  startedAt?: number;
  completedAt?: number;
  toolCalls?: number;
  dropped?: 'started' | 'unstarted';
  removedAt?: number;
};
// The plan steps live in the opened Tasks section (task view T1.3) — D1–D7 are
// pinned there; `open: false` is the folded default (the head only).
function plan(opts: { expanded?: boolean; earlier?: boolean; open?: boolean } = {}) {
  const el = box();
  let writes = 0;
  const m = load<{ renderPanelTasks(t: Task[] | null, label?: string, earlier?: Task[]): void }>(
    [
      'esc',
      'escAttr',
      'toNum',
      'formatDuration',
      'formatTaskTime',
      'agentIconHtml',
      'taskFateOf',
      'renderPanelTaskItem',
      'planFootHtml',
      'planSummaryHtml',
      'planEarlierCounts',
      'planEarlierGroups',
      'planEarlierHtml',
      'renderPanelTasks',
    ],
    ['AGENT_STATUS_LABEL', 'TASK_FATE_LABEL', 'TASK_PAUSE_SVG', 'TASK_STOP_SVG', 'TASK_SKIP_SVG', 'PI_CHEV_SVG'],
    {
      document: { getElementById: (id: string) => (id === 'panel-tasks' ? el : null) },
      _panelTasksOpen: opts.open !== false,
      _panelTasksExpanded: !!opts.expanded,
      _panelTasksEarlier: !!opts.earlier,
      morphInnerHtml: (e: El, h: string) => {
        writes++;
        e.innerHTML = h;
      },
      updateTimersIn: () => {},
    },
  );
  return { el, render: m.renderPanelTasks, writes: () => writes };
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
const rows = (html: string) =>
  [...html.matchAll(/<li class="panel-task-item pl-step[^"]*"[^>]*>[\s\S]*?<\/li>/g)].map((m) => m[0]);

describe('plan — the Tasks section of the tab, in its own order (D1–D5)', () => {
  it('T1.3: folded by default — the head is the plan in one line, no steps until it is opened', () => {
    const p = plan({ open: false });
    p.render(TASKS);
    const html = p.el.innerHTML;
    expect(html).toContain(
      '<button type="button" class="panel-sec-head panel-tasks-header" aria-expanded="false" onclick="togglePanelTasks()">',
    );
    expect(html).toContain('<span class="ps-sec-title">Tasks</span>');
    // The step in progress (its activeForm) and done/total.
    expect(text(html)).toContain('Rendering the bars·1/3');
    expect(html).not.toContain('panel-tasks-body');
    expect(rows(html)).toHaveLength(0);
    // The live region is written folded as well (D7 keeps announcing).
    expect(html).toContain('<span class="ar-vh pl-live" role="status" aria-live="polite"></span>');
    const open = plan();
    open.render(TASKS);
    expect(open.el.innerHTML).toContain(
      'aria-expanded="true" aria-controls="panel-tasks-body" onclick="togglePanelTasks()">',
    );
    expect(open.el.innerHTML).toContain('<div class="panel-tasks-body" id="panel-tasks-body">');
    expect(rows(open.el.innerHTML)).toHaveLength(3);
  });

  it('T2: a pending step that had started reads 멈춤 (paused), not 대기', () => {
    const p = plan();
    p.render([{ id: 'T7', content: 'Was running', status: 'pending', startedAt: T0, toolCalls: 3 }]);
    const [r] = rows(p.el.innerHTML);
    expect(r).toContain('data-step="paused"');
    expect(r).toContain('pl-step paused');
    expect(r).toContain('<span class="pl-fate">멈춤</span>');
    expect(r).toContain('<span class="ar-vh">, 멈춤</span>');
    expect(r).not.toContain('aria-current');
  });

  it('D1/D2: original order, one marker per state, the active step is the current one', () => {
    const p = plan();
    p.render([TASKS[2], TASKS[0], TASKS[1]]);
    const html = p.el.innerHTML;
    expect(html).toContain('<ol class="pl-list" aria-label="계획 단계">');
    const r = rows(html);
    expect(r.map((x) => /data-step="(\w+)"/.exec(x)?.[1])).toEqual(['pending', 'done', 'active']);
    expect(r[0]).toContain('<span class="pl-marker" aria-hidden="true"></span>');
    expect(r[1]).toMatch(/<span class="pl-marker" aria-hidden="true"><svg/);
    expect(r[2]).toContain('<span class="pl-marker" aria-hidden="true"><span class="spinner ag-spinner"');
    expect(r.filter((x) => x.includes('aria-current="step"'))).toHaveLength(1);
    expect(r[2]).toContain('aria-current="step"');
    // Every row says its state to a screen reader.
    expect(r.map((x) => /<span class="ar-vh">, ([^<]+)<\/span>/.exec(x)?.[1])).toEqual(['대기', '완료', '진행 중']);
  });

  it('D3: the rail joins the markers; the segment under a done step fills', () => {
    expect(CSS).toMatch(/\.pl-list > \.pl-step:not\(:last-child\)::before \{[^}]*width: 1px;/);
    expect(CSS).toMatch(
      /\.pl-list > \.pl-step:not\(:last-child\)::after \{[^}]*transform: scaleY\(0\);[^}]*transition: transform var\(--dur-move\) var\(--ease-out\);/,
    );
    expect(CSS).toMatch(/\.pl-list > \.pl-step\[data-step="done"\]:not\(:last-child\)::after \{[^}]*transform: none;/);
    expect(CSS).toMatch(/\.pl-earlier > \.pl-step::before, \.pl-earlier > \.pl-step::after \{ content: none; \}/);
  });

  it('D4: id, title and tool chip on one line; the active step adds its activeForm', () => {
    const p = plan();
    p.render(TASKS);
    const r = rows(p.el.innerHTML);
    expect(r[0]).toContain(
      '<span class="task-id">#T1</span><span class="task-text">Read the picker</span><span class="pl-chip">툴 8회</span>',
    );
    expect(r[1]).toContain('<span class="pl-sub">Rendering the bars</span>');
    expect(r[0]).not.toContain('pl-sub');
    expect(r[2]).not.toContain('pl-chip'); // pending: no tool count yet
    const same = plan();
    same.render([{ id: 'T9', content: 'Same', activeForm: 'Same', status: 'in_progress', startedAt: T0 }]);
    expect(same.el.innerHTML).not.toContain('pl-sub');
  });

  it('D5: a done step shows its duration; the active one a 1 Hz clock, no Date.now() in the markup', () => {
    const p = plan();
    p.render(TASKS);
    const r = rows(p.el.innerHTML);
    expect(r[0]).toContain('<span class="pl-aside">2m 0s</span>');
    expect(r[1]).toContain(
      `<span class="pl-aside"><span class="task-elapsed" data-since="${T0 + 120_000}"></span></span>`,
    );
    expect(r[2]).toContain('<span class="pl-aside"></span>');
    // The same data writes nothing.
    p.render(TASKS);
    expect(p.writes()).toBe(1);
  });
});

describe('plan footer — the phase from the steps (D6)', () => {
  it('running: 실행 중 · done/total and the elapsed time since the first start', () => {
    const p = plan();
    p.render(
      TASKS.concat([
        { id: 'T4', content: 'a', status: 'pending' },
        { id: 'T5', content: 'b', status: 'pending' },
      ]),
    );
    const foot = /<div class="pl-foot"[\s\S]*?<\/div>/.exec(p.el.innerHTML)?.[0] ?? '';
    expect(foot).toContain('data-phase="running"');
    expect(text(foot)).toContain('실행 중 · 1/5');
    expect(foot).toContain(
      `<span class="pl-foot-time" aria-hidden="true"><span class="task-elapsed" data-since="${T0}"></span></span>`,
    );
  });

  it('all done: 완료 · N/N and the static total; otherwise 대기 · d/N with no clock', () => {
    const done = plan();
    done.render([
      { id: 'T1', content: 'a', status: 'completed', startedAt: T0, completedAt: T0 + 60_000 },
      { id: 'T2', content: 'b', status: 'completed', startedAt: T0 + 60_000, completedAt: T0 + 540_000 },
    ]);
    const f1 = /<div class="pl-foot"[\s\S]*?<\/div>/.exec(done.el.innerHTML)?.[0] ?? '';
    expect(f1).toContain('data-phase="completed"');
    expect(text(f1)).toContain('완료 · 2/2');
    expect(f1).toContain('<span class="pl-foot-time" aria-hidden="true">9m 0s</span>');
    const idle = plan();
    idle.render([TASKS[0], TASKS[2], { id: 'T4', content: 'c', status: 'pending' }]);
    const f2 = /<div class="pl-foot"[\s\S]*?<\/div>/.exec(idle.el.innerHTML)?.[0] ?? '';
    expect(f2).toContain('data-phase="idle"');
    expect(text(f2)).toContain('대기 · 1/3');
    expect(f2).not.toContain('pl-foot-time');
    expect(CSS).toMatch(/\.pl-foot \{[^}]*position: sticky;[^}]*bottom: 0;/);
  });

  it('more than three done: the earliest fold behind one toggle, in place', () => {
    const many: Task[] = [1, 2, 3, 4, 5].map((n) => ({ id: `T${n}`, content: `done ${n}`, status: 'completed' }));
    many.push({ id: 'T6', content: 'now', status: 'in_progress' });
    const p = plan();
    p.render(many);
    const html = p.el.innerHTML;
    expect(rows(html).map((x) => /#(T\d)/.exec(x)?.[1])).toEqual(['T3', 'T4', 'T5', 'T6']);
    expect(html.indexOf('Show 2 more completed')).toBeGreaterThan(-1);
    expect(html.indexOf('Show 2 more completed')).toBeLessThan(html.indexOf('#T3'));
    const open = plan({ expanded: true });
    open.render(many);
    expect(rows(open.el.innerHTML)).toHaveLength(6);
    expect(open.el.innerHTML).toContain('Hide completed');
  });

  it('the earlier plans keep their toggle (counts by fate) and use the same rows, without the rail', () => {
    const folded = plan();
    folded.render([TASKS[1]], '', [{ id: 'T0', content: 'old one', status: 'completed' }]);
    expect(folded.el.innerHTML).toContain('이전 계획 <span class="pl-earlier-counts">완료 1</span>');
    expect(folded.el.innerHTML).toContain('aria-expanded="false"');
    expect(folded.el.innerHTML).not.toContain('old one');
    const p = plan({ earlier: true });
    p.render([TASKS[1]], '', [{ id: 'T0', content: 'old one', status: 'completed' }]);
    expect(p.el.innerHTML).toContain('이전 계획 <span class="pl-earlier-counts">완료 1</span>');
    // A ledger entry without removedAt is grouped as 이전 기록.
    expect(p.el.innerHTML).toContain(
      '<div class="pl-earlier-group"><div class="pl-earlier-when">이전 기록</div><ol class="pl-list pl-earlier" aria-label="이전 기록">',
    );
    expect(p.el.innerHTML).toContain('old one');
    // One group per replacement, newest first; dropped vs never-run by fate.
    const at = T0 + 600_000;
    const g = plan({ earlier: true });
    g.render([TASKS[1]], '', [
      { id: 'T0', content: 'old one', status: 'completed' },
      { id: 'T8', content: 'stopped', status: 'in_progress', startedAt: T0, dropped: 'started', removedAt: at },
      { id: 'T9', content: 'never ran', status: 'pending', dropped: 'unstarted', removedAt: at },
    ]);
    const html = g.el.innerHTML;
    expect(html).toContain('<span class="pl-earlier-counts">완료 1 &middot; 중단 1 &middot; 실행 안 됨 1</span>');
    const when = new Date(at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
    expect(html.indexOf(`${when} 새 계획으로 교체`)).toBeGreaterThan(-1);
    expect(html.indexOf(`${when} 새 계획으로 교체`)).toBeLessThan(html.indexOf('이전 기록'));
    expect(html).toContain('data-step="dropped"');
    expect(html).toContain('data-step="skipped"');
  });
});

describe('plan announcements (D7)', () => {
  const live = (html: string) =>
    /<span class="ar-vh pl-live" role="status" aria-live="polite">([^<]*)<\/span>/.exec(html)?.[1];

  it('the first render is silent; a step that completes is announced once; its marker pops', () => {
    const p = plan();
    p.render(TASKS);
    expect(live(p.el.innerHTML)).toBe('');
    const next = TASKS.map((t) => (t.id === 'T2' ? { ...t, status: 'completed', completedAt: T0 + 300_000 } : t));
    p.render(next);
    expect(live(p.el.innerHTML)).toBe('T2 완료: Render the bars');
    expect(rows(p.el.innerHTML)[1]).toContain('pl-step completed pl-pop');
    p.render(next);
    expect(live(p.el.innerHTML)).toBe('');
    expect(p.el.innerHTML).not.toContain('pl-pop');
    expect(CSS).toMatch(
      /\.pl-step\.pl-pop \.pl-marker > \* \{ animation: pl-pop var\(--dur-move\) var\(--ease-out\) both; \}/,
    );
  });

  it('a list that empties and refills is a fresh baseline (no stale announcement)', () => {
    const p = plan();
    p.render(TASKS);
    p.render([]);
    p.render([{ id: 'T2', content: 'Render the bars', status: 'completed' }]);
    expect(live(p.el.innerHTML)).toBe('');
    expect(p.el.innerHTML).not.toContain('pl-pop');
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
      'acPermissionData',
      'acQuestionId',
      'acQuestionData',
      'acSlotHtml',
      'acPermissionsHtml',
      'acQuestionHtml',
      'stripRecommendedMarker',
      'resolveRecommendedId',
    ],
    ['AC_SIBLING'],
    {
      currentUserId: opts.user ?? 'U1',
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
    ['acPost', 'acRefusal', 'acToolOf', 'stripRecommendedMarker', 'acQuestionId', 'answerPermission', 'answerChoice'],
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
    const head = PAGE.indexOf('<div class="panel-needs-head" id="panel-needs-head" tabindex="-1" hidden>');
    expect(head).toBeGreaterThan(0);
    expect(head).toBeLessThan(PAGE.indexOf('id="panel-permission"'));
    expect(PAGE).toContain(
      '<span class="pn-title">입력 필요</span><span class="pn-count" id="panel-needs-count"></span>',
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
    expect(CSS).toMatch(/\.pn-count \{[^}]*animation: pn-pop var\(--dur-move\) var\(--ease-out\) both;/);
    // The badge reads in both themes: ink on an amber tint, no hard-coded colour.
    const badge = /\.pn-count \{[^}]*\}/.exec(CSS)?.[0] ?? '';
    expect(badge).toContain('color: var(--text);');
    expect(badge).toContain('background: color-mix(in srgb, var(--st-wait) 24%, transparent);');
    expect(badge).not.toMatch(/#[0-9a-f]{3,6}\b/i);
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
    expect(CSS).toMatch(/\.wl-toolcall, \.ui-tok \{[^}]*--ui-border: var\(--border\);/);
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

  it('Esc end to end: one the card handled (stopped in its shadow root) never reaches the page; one it let through closes the panel and denies nothing', () => {
    // The page's document-level keydown handler (Escape closes the panel), cooked as served.
    const start = TEMPLATE.indexOf(
      "document.addEventListener('keydown', function(e) {\n  // Escape in the artifact viewer",
    );
    expect(start).toBeGreaterThan(0);
    const fnStart = TEMPLATE.indexOf('function(e) {', start);
    const fnText = cook(TEMPLATE.slice(fnStart, TEMPLATE.indexOf('\n});', fnStart) + 2));
    expect(fnText).not.toMatch(/answerPermission|ui-decide/);
    let closes = 0;
    const inject: Record<string, unknown> = {
      panelOpen: true,
      _panelControlsOpen: false,
      artModalIsOpen: () => false,
      _cronDrawerKey: null,
      closePanel: () => closes++,
      togglePanelControls: () => {},
      window: { matchMedia: () => ({ matches: false }) },
      document: { querySelector: () => null },
    };
    const onDocument = new Function(...Object.keys(inject), `return ${fnText}`)(...Object.values(inject)) as (
      e: unknown,
    ) => void;
    // Bubbling: the element's shadow-root listener first, then the document's — unless it stopped the event.
    const dispatch = (stoppedByCard: boolean) => {
      if (!stoppedByCard) onDocument({ key: 'Escape', target: {}, preventDefault() {}, defaultPrevented: false });
    };
    dispatch(true); // Esc on Deny / Approve: the card denied and stopped it
    expect(closes).toBe(0);
    dispatch(false); // Esc on the card itself (the keyboard landing): the panel closes
    expect(closes).toBe(1);
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
    expect(a.repaints.map(([k, s]) => [k, (s as Record<string, any>)['p|approval_a1'].status])).toEqual([
      ['inst::C1:t1', 'sending'],
      ['inst::C1:t1', 'resolved'],
    ]);
    expect(a.repaints[0][1]).toEqual({ 'p|approval_a1': { status: 'sending', decision: 'deny' } });
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

describe('panel head (D18)', () => {
  const head = (s: Record<string, unknown>, col: string) =>
    load<{ panelHeadHtml(s: unknown, col: string): string }>(
      [
        'esc',
        'escAttr',
        'escJs',
        'toNum',
        'formatTaskTime',
        'pendingAutoResume',
        'autoResumeLabel',
        'rootStatusOf',
        'agentIconHtml',
        'isBusy',
        'sessionActionHtml',
        'panelHeadHtml',
      ],
      ['AGENT_STATUS_LABEL', 'SESSION_ACTION_ARIA', '_busy'],
      {
        currentUserId: 'U1',
        SELF_INSTANCE_NAME: '',
        READ_ONLY_MSG: 'read only',
        safeHref: (u: string) => u,
        isSiblingSession: () => false,
      },
    ).panelHeadHtml(s, col);

  it('running: the pill, 시작 HH:MM · the elapsed time of this turn, Stop', () => {
    const html = head(CARD(), 'working');
    expect(html).toContain('class="ps-chip is-running"');
    expect(html).toContain('<span class="ps-time" title="이번 턴 시작 · 경과">');
    expect(text(html)).toContain('시작 ');
    expect(html).toContain(`<span class="card-timer-live" data-leg-started="${T0}" data-accumulated="0"></span>`);
    expect(html).toContain('aria-label="Stop — 세션 중지"');
  });

  it('not running: the total active time, labelled', () => {
    const html = head(CARD({ activityState: 'idle' }), 'idle');
    expect(html).toContain(
      '<span class="ps-time" title="활성 시간">활성 <span class="card-timer-live" data-leg-started="0" data-accumulated="65000"></span></span>',
    );
    expect(text(html)).not.toContain('시작 ');
  });

  it('the chip is a tinted pill (markup unchanged)', () => {
    expect(CSS).toMatch(
      /\.ps-chip \{[^}]*border-radius: 99px;[^}]*background: color-mix\(in srgb, var\(--ag-c\) 13%, transparent\);[^}]*border: 0;/,
    );
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
    expect(html.startsWith('<dl class="pi-details">')).toBe(true);
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
        // #441's context block is pinned by its own suite; here it only has to sit first in the body.
        contextBlockHtml: () => '<section class="cw" aria-label="컨텍스트"></section>',
      },
    ).panelInfoHtml;
    const open = info(CARD(), true);
    const grid = /<dl class="pi-grid">[\s\S]*?<\/dl>/.exec(open)?.[0] ?? '';
    for (const gone of ['소유자', '워크플로', '환경', '비용']) expect(grid, gone).not.toContain(gone);
    for (const kept of ['입력', '출력', '캐시 읽기', '캐시 쓰기']) expect(grid, kept).toContain(kept);
    const at = (needle: string) => open.indexOf(needle);
    // The context block: this branch's .pi-ctx, or #441's .cw once it lands — first in the body either way.
    const context = at('class="cw') >= 0 ? at('class="cw') : at('class="pi-ctx"');
    const order = [
      at('class="pi-body"'),
      context,
      at('<dl class="pi-details">'),
      at('<dl class="pi-grid">'),
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
      'renderPanelTaskItem',
      'planFootHtml',
      'renderPanelNeedsHead',
      'panelQuestionShown',
      'apAnnounce',
      'apSafeFocus',
      'panelDetailsHtml',
      // affectUI batch 1: <ui-approval-card>
      'acPermissionLock',
      'acQuestionLock',
      'acPermissionData',
      'acQuestionId',
      'acQuestionData',
      'acSlotHtml',
      'acPermissionsHtml',
      'acQuestionHtml',
      'acHydrate',
      'acRepaint',
      'acFirstOpen',
      'acPost',
      'acRefusal',
      'answerPermission',
      'answerChoice',
      '_acState',
      'AC_SENT',
      'AC_SIBLING',
    ]) {
      expect(declarationCount(name), name).toBe(1);
    }
    for (const gone of [
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
    ]) {
      expect(declarationCount(gone), gone).toBe(0);
      expect(TEMPLATE, gone).not.toMatch(new RegExp(`\\b${gone}\\(`));
    }
    const ours = CSS.split('\n').filter((l) => /^\s*\.(pl|ap|pn|ac)-|^\s*\.pi-details|^\s*\.ar-vh/.test(l));
    expect(ours.length).toBeGreaterThan(10);
    for (const l of ours) expect(l, l).not.toMatch(/--[a-z-]+\s*:/);
  });
});
