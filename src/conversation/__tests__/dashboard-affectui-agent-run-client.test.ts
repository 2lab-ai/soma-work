/**
 * affectUI Agent Run → the session detail panel (.prd/affectui/re-agent-run.md,
 * issue #439). Executes the shipped client code cut out of renderDashboardPage()'s
 * template literal, cooked exactly as the browser receives it (the harness of
 * dashboard-three-surfaces-client.test.ts).
 *
 *   plan        = the pinned Tasks as a plan: original order, markers, rail,
 *                 a footer with the phase, announcements (D1–D7)
 *   needs input = a header with a count, approval cards for permission prompts
 *                 and the single-choice question, the keyboard, the answered
 *                 row, the expiry clock (D8–D17)
 *   head        = the status pill, 시작 · 경과 (D18); 세부 = Details (D19)
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
};
function plan(opts: { expanded?: boolean; earlier?: boolean } = {}) {
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
      'renderPanelTaskItem',
      'planFootHtml',
      'renderPanelTasks',
    ],
    ['AGENT_STATUS_LABEL'],
    {
      document: { getElementById: (id: string) => (id === 'panel-tasks' ? el : null) },
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

describe('plan — the pinned Tasks in their own order (D1–D5)', () => {
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

  it('the earlier lists keep their toggle and use the same rows, without the rail', () => {
    const p = plan({ earlier: true });
    p.render([TASKS[1]], '', [{ id: 'T0', content: 'old one', status: 'completed' }]);
    expect(p.el.innerHTML).toContain('이전 task 1개');
    expect(p.el.innerHTML).toContain('<ol class="pl-list pl-earlier" aria-label="이전 task">');
    expect(p.el.innerHTML).toContain('old one');
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

function cards(
  opts: { user?: string; details?: Record<string, unknown>; answered?: Record<string, string>; sibling?: boolean } = {},
) {
  const loads: string[] = [];
  const m = load<{
    apPermissionCardHtml(s: unknown, p: unknown): string;
    apQuestionCardHtml(s: unknown, q: unknown): string;
    apDetails(d: unknown): { desc: string; html: string };
  }>(
    [
      'esc',
      'escAttr',
      'toNum',
      'formatTaskTime',
      'agentIconHtml',
      'isPermissionRequester',
      'apDetails',
      'apPermissionCardHtml',
      'choiceDataAttrs',
      'stripRecommendedMarker',
      'resolveRecommendedId',
      'apHash',
      'apQuestionCardHtml',
    ],
    ['AP_ANSWERED'],
    {
      currentUserId: opts.user ?? 'U1',
      isSiblingSession: () => !!opts.sibling,
      _permDetails: opts.details ?? { approval_a1: { input: INPUT, truncated: false } },
      _permNotes: {},
      _permAnswered: opts.answered ?? {},
      loadPermissionDetail: (_k: string, id: string) => loads.push(id),
      AP_KBD_APPROVE: '⌘↵',
    },
  );
  return { ...m, loads };
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

  it('landing keeps the header in view (offset by its height); keyboard landing focuses the card, not a button', () => {
    expect(clientFn('landPanel')).toContain("document.getElementById('panel-needs-head')");
    expect(clientFn('landPanel')).toContain('needsHead.offsetHeight');
    expect(clientFn('focusPanelLanding')).toContain(
      "'#panel-permission .ap-card:not(.is-resolved), #panel-question .ap-card",
    );
  });
});

describe('permission approval card (D10–D13)', () => {
  it('label · icon · title · description · rule pill · details · rules · the four answers', () => {
    const c = cards();
    const html = c.apPermissionCardHtml(SESSION(), PERM());
    expect(html).toContain(
      '<div class="ap-card perm-request" role="group" tabindex="-1" data-ap-kind="perm" data-approval-id="approval_a1"',
    );
    expect(html).toContain('aria-labelledby="ap-t-approval_a1"');
    // The context line says only what the prompt proves: the tool and when it asked (D10).
    expect(html).toMatch(/<div class="ap-label">Bash &middot; [^<]+ 요청<\/div>/);
    expect(html).toContain('<div class="ap-title" id="ap-t-approval_a1">Bash 실행 승인</div>');
    expect(html).toContain('id="ap-d-approval_a1"');
    expect(text(html)).toContain('Install the tool');
    expect(html).toContain(
      '<span class="ap-pill" data-kind="rule">위험<span class="ap-pill-word"> 규칙</span> 1</span>',
    );
    expect(html).toContain('<code>pipe-to-interpreter</code>');
    const decisions = [...html.matchAll(/data-perm-decision="([a-z_]+)"/g)].map((m) => m[1]);
    expect(decisions).toEqual(['explain', 'approve_disable_rule', 'deny', 'approve']);
    expect(html).toContain(
      'data-perm-key="inst::C1:t1" data-perm-id="approval_a1" data-perm-decision="approve" data-kbd="⌘↵" aria-keyshortcuts="Meta+Enter Control+Enter"',
    );
    expect(html).toContain('data-perm-decision="deny" data-kbd="Esc" aria-keyshortcuts="Escape"');
    expect(html).not.toMatch(/<button[^>]* disabled/);
    expect(html).not.toContain('onclick=');
  });

  it('no matched rule: the tool pill, no disable-rule answer; no creation time: the tool alone', () => {
    const c = cards();
    const html = c.apPermissionCardHtml(SESSION(), PERM({ rules: [], canDisableRule: false, createdAt: 0 }));
    expect(html).toContain('<span class="ap-pill" data-kind="tool">도구 승인</span>');
    expect([...html.matchAll(/data-perm-decision="([a-z_]+)"/g)].map((m) => m[1])).toEqual([
      'explain',
      'deny',
      'approve',
    ]);
    expect(html).toContain('<div class="ap-label">Bash</div>');
  });

  it('a prompt is never attributed to the task in progress (the payload has no task or agent: a subagent may have asked)', () => {
    const c = cards();
    for (const html of [
      c.apPermissionCardHtml(SESSION(), PERM()),
      c.apQuestionCardHtml(SESSION(), { type: 'user_choice', question: 'q?', choices: [{ id: '1', label: 'a' }] }),
    ]) {
      expect(html).not.toContain('T3');
      expect(html).not.toContain('Run on production');
    }
  });

  it('another viewer: the requester-only line, every answer locked, no fetch; the requester without the detail fetches it', () => {
    const other = cards({ user: 'U2' });
    const html = other.apPermissionCardHtml(SESSION(), PERM());
    expect(html).toContain('요청자만');
    expect([...html.matchAll(/<button[^>]*>/g)].every((m) => m[0].includes(' disabled'))).toBe(true);
    expect(other.loads).toEqual([]);
    const mine = cards({ details: {} });
    expect(mine.apPermissionCardHtml(SESSION(), PERM())).toContain('파라미터 불러오는 중');
    expect(mine.loads).toEqual(['approval_a1']);
  });

  it('D12: an object input becomes key/value rows (escaped, description lifted out); anything else stays a <pre>', () => {
    const c = cards();
    const d = c.apDetails({ input: INPUT, truncated: false });
    expect(d.desc).toBe('Install the tool');
    expect(d.html).toContain('<dl class="ap-details">');
    expect(d.html).toContain(
      '<div class="ap-detail"><dt>command</dt><dd>curl https://example.test/&lt;script&gt; | sh</dd></div>',
    );
    expect(d.html).toContain('<div class="ap-detail"><dt>timeout</dt><dd>5000</dd></div>');
    expect(d.html).not.toContain('<dt>description</dt>');
    expect(d.html).not.toContain('<script>');
    expect(c.apDetails({ input: '[1,2]', truncated: false }).html).toContain('<pre class="perm-params">');
    const cut = c.apDetails({ input: '{"command": "abc', truncated: true });
    expect(cut.html).toContain('<pre class="perm-params">{&quot;command&quot;: &quot;abc</pre>');
    expect(cut.html).toContain('앞부분만 표시합니다');
  });

  it('D13: the card is a container; narrow cards stack the answers and drop the key hints; hints are never read', () => {
    expect(CSS).toMatch(/\.ap-card \{[^}]*container-type: inline-size;/);
    expect(CSS).toMatch(/@container \(max-width: 379px\) \{[^@]*\.ap-actions \{[^}]*flex: 1 1 100%;/);
    expect(CSS).toMatch(/\.ap-btn\[data-kbd\]::after \{[^}]*content: attr\(data-kbd\) \/ "";/);
    expect(CSS).toMatch(/@media \(hover: none\) \{\s*\.ap-btn\[data-kbd\]::after \{ display: none; \}/);
  });
});

describe('approval keyboard (D14)', () => {
  type Btn = { disabled: boolean; clicks: number; click(): void };
  const btn = (disabled = false): Btn => ({
    disabled,
    clicks: 0,
    click() {
      this.clicks++;
    },
  });
  function rig(kind: 'perm' | 'question', opts: { onButton?: boolean; disabled?: boolean; rec?: boolean } = {}) {
    const approve = btn(!!opts.disabled);
    const deny = btn(!!opts.disabled);
    const rec = opts.rec === false ? null : btn();
    const card = {
      getAttribute: (k: string) => (k === 'data-ap-kind' ? kind : null),
      querySelector: (sel: string) =>
        sel === '.ap-approve' ? approve : sel === '.ap-deny' ? deny : sel === '.ap-rec' ? rec : null,
      contains: () => true,
    };
    const focused = { tag: 'BUTTON' };
    const target = {
      closest: (sel: string) => (sel === '.ap-card' ? card : sel === 'button' && opts.onButton ? focused : null),
    };
    const m = load<{ apKeydown(e: unknown): void }>(['apKeydown'], []);
    const press = (key: string, mods: { meta?: boolean; ctrl?: boolean } = {}) => {
      const e = {
        key,
        metaKey: !!mods.meta,
        ctrlKey: !!mods.ctrl,
        target,
        defaultPrevented: false,
        prevented: false,
        stopped: false,
        preventDefault() {
          this.prevented = true;
        },
        stopPropagation() {
          this.stopped = true;
        },
      };
      m.apKeydown(e);
      return e;
    };
    return { approve, deny, rec, press };
  }

  it('⌘↵ / Ctrl+↵ anywhere in the card approves and keeps the panel open', () => {
    const r = rig('perm');
    const e = r.press('Enter', { meta: true });
    expect(r.approve.clicks).toBe(1);
    expect(e.prevented && e.stopped).toBe(true);
    r.press('Enter', { ctrl: true });
    expect(r.approve.clicks).toBe(2);
    r.press('Enter');
    expect(r.approve.clicks).toBe(2);
  });

  it('Esc denies only from one of the card buttons; on the card itself it closes the panel as before', () => {
    const onCard = rig('perm');
    const e = onCard.press('Escape');
    expect(onCard.deny.clicks).toBe(0);
    expect(e.stopped).toBe(false);
    const onBtn = rig('perm', { onButton: true });
    expect(onBtn.press('Escape').stopped).toBe(true);
    expect(onBtn.deny.clicks).toBe(1);
  });

  it('locked answers ignore the keys; a question takes ⌘↵ only for its recommended choice, never Esc', () => {
    const locked = rig('perm', { disabled: true, onButton: true });
    expect(locked.press('Enter', { meta: true }).stopped).toBe(false);
    expect(locked.press('Escape').stopped).toBe(false);
    expect(locked.approve.clicks + locked.deny.clicks).toBe(0);
    const q = rig('question', { onButton: true });
    q.press('Enter', { meta: true });
    expect(q.rec?.clicks).toBe(1);
    expect(q.press('Escape').stopped).toBe(false);
    const none = rig('question', { rec: false });
    expect(none.press('Enter', { meta: true }).stopped).toBe(false);
  });

  it('Esc end to end: from a card button it denies and the document handler never closes the panel; from the card itself the panel closes', () => {
    // The page's document-level keydown handler (Escape closes the panel), cooked as served.
    const start = TEMPLATE.indexOf(
      "document.addEventListener('keydown', function(e) {\n  // Escape in the artifact viewer",
    );
    expect(start).toBeGreaterThan(0);
    const fnStart = TEMPLATE.indexOf('function(e) {', start);
    const fnText = cook(TEMPLATE.slice(fnStart, TEMPLATE.indexOf('\n});', fnStart) + 2));
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
    // Bubbling: the slot's listener first (element level), then the document's — unless stopped.
    const dispatch = (r: ReturnType<typeof rig>) => {
      const e = r.press('Escape');
      if (!e.stopped) onDocument(e);
      return e;
    };
    const onBtn = rig('perm', { onButton: true });
    const e1 = dispatch(onBtn);
    expect(onBtn.deny.clicks).toBe(1);
    expect(e1.prevented && e1.stopped).toBe(true);
    expect(closes).toBe(0);
    const onCard = rig('perm');
    dispatch(onCard);
    expect(onCard.deny.clicks).toBe(0);
    expect(closes).toBe(1);
  });

  it('both slots listen before the document (whose Escape closes the panel)', () => {
    expect(TEMPLATE).toContain("['panel-permission', 'panel-question'].forEach(function(id) {");
    expect(TEMPLATE).toContain("el.addEventListener('keydown', apKeydown);");
  });
});

describe('after an answer (D15)', () => {
  it('the card becomes one resolved row per answer', () => {
    const words: Record<string, string> = {
      approve: '승인함',
      deny: '거부함',
      explain: '설명 요청함',
      approve_disable_rule: '승인함 · 규칙 끔',
    };
    const answered: Record<string, string> = {};
    const c = cards({ answered });
    for (const [decision, word] of Object.entries(words)) {
      answered.approval_a1 = decision;
      const html = c.apPermissionCardHtml(SESSION(), PERM());
      expect(html, decision).toContain('<div class="ap-card perm-request is-resolved"');
      expect(html, decision).toContain(`<div class="ap-resolved" data-decision="${decision}">`);
      expect(html, decision).toContain(`<span class="ap-row-status">${word}</span>`);
      expect(html, decision).not.toContain('방금');
      expect(html, decision).not.toContain('data-perm-decision');
    }
  });

  it('answerPermission records the answer and repaints the panel only; the panel announces it once', () => {
    const src = clientFn('answerPermission');
    expect(src).toContain('_permAnswered[approvalId] = decision;');
    expect(src).toContain(
      'if (panelOpen && panelSessionKey === key && _sessionCache[key]) renderPanelPermission(_sessionCache[key]);',
    );
    const els: Record<string, El> = { 'panel-permission': box(), 'panel-needs-status': box() };
    const said: string[] = [];
    const answered: Record<string, string> = {};
    const m = load<{ renderPanelPermission(s: unknown): void }>(['renderPanelPermission'], ['AP_SENT'], {
      document: { getElementById: (id: string) => els[id] ?? null, activeElement: null },
      _permAnswered: answered,
      apPermissionCardHtml: (_s: unknown, p: { approvalId: string }) =>
        `<div data-approval-id="${p.approvalId}"></div>`,
      morphInnerHtml: (e: El, h: string) => {
        e.innerHTML = h;
      },
      updateTimersIn: () => {},
      apAnnounce: (t: string) => said.push(t),
      renderPanelNeedsHead: () => {},
    });
    m.renderPanelPermission(SESSION()); // the open panel's baseline
    answered.approval_a1 = 'deny'; // answerPermission succeeded
    m.renderPanelPermission(SESSION());
    m.renderPanelPermission(SESSION());
    expect(said).toEqual(['거부를 보냈습니다 — Bash']);
    // Reopened (openPanel drops the baseline) while the prompt is still pending: not said again.
    els['panel-permission']._seenKey = null;
    m.renderPanelPermission(SESSION());
    expect(said).toEqual(['거부를 보냈습니다 — Bash']);
  });

  it('a prompt that arrives while the panel is open is announced; the first render of an opening is not', () => {
    const els: Record<string, El> = { 'panel-permission': box() };
    const said: string[] = [];
    const m = load<{ renderPanelPermission(s: unknown): void }>(['renderPanelPermission'], ['AP_SENT'], {
      document: { getElementById: (id: string) => els[id] ?? null, activeElement: null },
      _permAnswered: {},
      apPermissionCardHtml: () => '<div></div>',
      morphInnerHtml: () => {},
      updateTimersIn: () => {},
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
  click() {
    clicks.push(`${this.getAttribute('data-perm-id')}:${this.getAttribute('data-perm-decision')}`);
  }
}
let focused: Node | null = null;
let clicks: string[] = [];
const BTN = (id: string, d: string, keyed: boolean) =>
  new Node('BUTTON', {
    class: `btn-perm ap-btn ap-${d === 'approve' ? 'primary ap-approve' : 'quiet ap-deny'}`,
    'data-perm-id': id,
    'data-perm-decision': d,
    ...(keyed ? { 'data-mk': `ap|${id}|${d}` } : {}),
  });
const APCARD = (id: string, keyed = true) =>
  new Node(
    'DIV',
    {
      class: 'ap-card perm-request',
      'data-approval-id': id,
      'data-ap-kind': 'perm',
      ...(keyed ? { 'data-mk': `ap|${id}` } : {}),
    },
    [new Node('DIV', { class: 'ap-actions' }, [BTN(id, 'deny', keyed), BTN(id, 'approve', keyed)])],
  );

describe('live repaint never rebinds an answer to another request (D14, review R1 P1)', () => {
  const morph = load<{ domMorphChildren(a: Node, b: Node): void }>(
    ['domKeyOf', 'domKeyLater', 'domMorph', 'domMorphChildren'],
    [],
  );

  it('the card and every answer carry their request in data-mk', () => {
    const html = cards().apPermissionCardHtml(SESSION(), PERM());
    expect(html).toContain('data-mk="ap|approval_a1"');
    for (const d of ['explain', 'approve_disable_rule', 'deny', 'approve'])
      expect(html).toContain(`data-mk="ap|approval_a1|${d}"`);
    const q = cards().apQuestionCardHtml(SESSION(), {
      type: 'user_choice',
      question: 'q?',
      choices: [{ id: '1', label: 'a' }],
    });
    expect(q).toMatch(/<div class="ap-card ap-question"[^>]* data-mk="q\|[0-9a-z]+"/);
    expect(q).toMatch(/data-mk="q\|[0-9a-z]+\|1"/);
  });

  it('A and B pending, A goes: A’s focused Approve leaves the page; B keeps its own node (unkeyed it would be rebound)', () => {
    const live = new Node('DIV', { id: 'panel-permission' }, [APCARD('A'), APCARD('B')]);
    const approveA = live.querySelectorAll('.ap-approve')[0];
    const approveB = live.querySelectorAll('.ap-approve')[1];
    morph.domMorphChildren(live, new Node('DIV', {}, [APCARD('B')]));
    expect(live.contains(approveA)).toBe(false);
    expect(live.querySelector('.ap-approve')).toBe(approveB);
    // Without the keys the same Approve node would now answer B — the bug this pins.
    const old = new Node('DIV', {}, [APCARD('A', false), APCARD('B', false)]);
    const oldA = old.querySelector('.ap-approve') as Node;
    morph.domMorphChildren(old, new Node('DIV', {}, [APCARD('B', false)]));
    expect(old.contains(oldA) && oldA.getAttribute('data-perm-id')).toBe('B');
  });

  function panel(next: Node[], headHidden = false) {
    const container = new Node('DIV', { id: 'panel-permission', class: 'panel-permission' }, [
      APCARD('A'),
      APCARD('B'),
    ]);
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
    const m = load<{ renderPanelPermission(s: unknown): void; apKeydown(e: unknown): void }>(
      ['renderPanelPermission', 'apSafeFocus', 'apKeydown'],
      ['AP_SENT'],
      {
        document,
        _permAnswered: {},
        apPermissionCardHtml: (_s: unknown, p: { approvalId: string }) => p.approvalId,
        morphInnerHtml: (el: Node, _html: string) => morph.domMorphChildren(el, new Node('DIV', {}, next)),
        updateTimersIn: () => {},
        apAnnounce: () => {},
        renderPanelNeedsHead: () => {},
      },
    );
    return { m, container, head, title };
  }
  const press = (m: { apKeydown(e: unknown): void }) => {
    const e = {
      key: 'Enter',
      metaKey: true,
      ctrlKey: false,
      target: focused,
      defaultPrevented: false,
      stopped: false,
      preventDefault() {},
      stopPropagation() {
        this.stopped = true;
      },
    };
    m.apKeydown(e);
    return e;
  };

  it('focus on A’s Approve, A goes: focus moves to the 입력 필요 head (no answer), and ⌘↵ sends nothing', () => {
    clicks = [];
    const p = panel([APCARD('B')]);
    focused = p.container.querySelectorAll('.ap-approve')[0];
    p.m.renderPanelPermission(SESSION({ pendingPermissions: [PERM({ approvalId: 'B' })] }));
    expect(focused).toBe(p.head);
    expect(focused?.tagName).not.toBe('BUTTON');
    expect(press(p.m).stopped).toBe(false);
    expect(clicks).toEqual([]);
  });

  it('nothing left to answer: the panel title; A answered (its resolved row): A’s card itself, where ⌘↵ answers nothing', () => {
    clicks = [];
    const gone = panel([], true);
    focused = gone.container.querySelectorAll('.ap-approve')[0];
    gone.m.renderPanelPermission(SESSION({ pendingPermissions: [] }));
    expect(focused).toBe(gone.title);
    const RESOLVED = new Node(
      'DIV',
      { class: 'ap-card perm-request is-resolved', 'data-approval-id': 'A', 'data-ap-kind': 'perm', 'data-mk': 'ap|A' },
      [new Node('DIV', { class: 'ap-resolved' })],
    );
    const done = panel([RESOLVED, APCARD('B')]);
    focused = done.container.querySelectorAll('.ap-approve')[0];
    done.m.renderPanelPermission(
      SESSION({ pendingPermissions: [PERM({ approvalId: 'A' }), PERM({ approvalId: 'B' })] }),
    );
    expect(focused?.getAttribute('data-approval-id')).toBe('A');
    expect(focused?.tagName).toBe('DIV');
    press(done.m);
    expect(clicks).toEqual([]);
  });
});

describe('a flattened panel choice is drawn again (review R1 P2)', () => {
  it('answerChoice’s three label write-backs redraw the panel card from the session (cache dropped)', () => {
    const src = clientFn('answerChoice');
    expect(src.match(/apRepaintQuestion\(btnEl, key\);/g)?.length).toBe(3);
    const host = { _html: '<cached>' };
    let painted = 0;
    const m = load<{ apRepaintQuestion(b: unknown, k: string): void }>(['apRepaintQuestion'], [], {
      panelOpen: true,
      panelSessionKey: 'k1',
      _sessionCache: { k1: { key: 'k1' } },
      renderPanelQuestion: () => painted++,
    });
    m.apRepaintQuestion({ closest: (sel: string) => (sel === '#panel-question' ? host : null) }, 'k1');
    expect(host._html).toBe('');
    expect(painted).toBe(1);
    m.apRepaintQuestion({ closest: () => null }, 'k1'); // a card face button: not the panel's
    expect(painted).toBe(1);
  });
});

describe('expiry clock (D16)', () => {
  it('counts down from expiresAt, stops at 0:00 and warns in the last minute', () => {
    const html = cards().apPermissionCardHtml(SESSION(), PERM());
    expect(html).toContain(`<span class="ap-expires" data-until="${T0 + 300_000}" aria-hidden="true"></span>`);
    expect(html).toContain('id="ap-x-approval_a1"');
    const make = (until: number) => {
      const cls: Record<string, boolean> = {};
      return {
        dataset: { until: String(until) },
        textContent: '',
        classList: { toggle: (c: string, on: boolean) => (cls[c] = on) },
        cls,
      };
    };
    const now = Date.now();
    const els = [make(now + 252_000), make(now - 5_000), make(now + 45_000)];
    const root = { querySelectorAll: (sel: string) => (sel === '.ap-expires' ? els : []) };
    const m = load<{ updateTimersIn(r: unknown): void }>(['formatNmSSs', 'formatDuration', 'updateTimersIn'], [], {
      timeAgo: () => '',
    });
    m.updateTimersIn(root);
    expect(els.map((e) => e.textContent)).toEqual(['만료까지 4:12', '만료까지 0:00', '만료까지 0:45']);
    expect(els.map((e) => e.cls['is-low'])).toEqual([false, true, true]);
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

  it('the same frame: the whole question as the title, the recommended choice first and primary, the answer attributes kept', () => {
    const html = cards().apQuestionCardHtml(SESSION(), Q);
    expect(html).toContain(
      '<div class="ap-card ap-question" role="group" tabindex="-1" data-ap-kind="question" data-mk="q|',
    );
    expect(html).not.toContain('ap-label');
    expect(html).toContain(
      '<div class="ap-title" id="ap-q-title">The dry run on staging passed.\nRun the migration on production now?</div>',
    );
    expect(html).toContain('<span class="ap-pill" data-kind="question">질문</span>');
    expect(html).toContain('<div class="panel-question-choices ap-choices">');
    const ids = [...html.matchAll(/data-choice-id="(\w+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(['wait', 'run']);
    expect(html).toContain(
      '<button type="button" class="btn-choice ap-choice ap-rec" data-choice-key="inst::C1:t1" data-choice-id="wait"',
    );
    expect(html).toContain('<span class="ap-choice-desc">Applies 0042</span>');
    expect(CSS).toMatch(/\.ap-question \.ap-title \{[^}]*white-space: pre-line;/);
  });

  it('the panel writes the card only when it changed (focus stays); the multi-question form is untouched', () => {
    const els: Record<string, El> = { 'panel-question': box() };
    let writes = 0;
    let multi = 0;
    const m = load<{ renderPanelQuestion(s: unknown): void }>(['renderPanelQuestion'], [], {
      document: { getElementById: (id: string) => els[id] ?? null },
      apQuestionCardHtml: () => '<div class="ap-card"></div>',
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
      ['esc', 'escAttr', 'toNum', 'ctxLevel', 'pendingAutoResume', 'rootStatusOf', 'panelDetailsHtml', 'panelInfoHtml'],
      ['PI_CHEV_SVG'],
      {
        formatTokens: (n: number) => `${n}`,
        formatNmSSs: (n: number) => `${n}ms`,
        cardTotalTokens: () => 1,
        safeHref: (u: string) => u,
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
  it('each new client name is declared once; the new CSS adds no colour tokens', () => {
    for (const name of [
      'renderPanelTaskItem',
      'planFootHtml',
      'renderPanelNeedsHead',
      'panelQuestionShown',
      'apDetails',
      'apPermissionCardHtml',
      'apQuestionCardHtml',
      'apAnnounce',
      'apKeydown',
      'apSafeFocus',
      'apHash',
      'apRepaintQuestion',
      'panelDetailsHtml',
      '_permAnswered',
      'AP_KBD_APPROVE',
      'AP_ANSWERED',
      'AP_SENT',
    ]) {
      expect(declarationCount(name), name).toBe(1);
    }
    const ours = CSS.split('\n').filter((l) => /^\s*\.(pl|ap|pn)-|^\s*\.pi-details|^\s*\.ar-vh/.test(l));
    expect(ours.length).toBeGreaterThan(10);
    for (const l of ours) expect(l, l).not.toMatch(/--[a-z-]+\s*:/);
  });
});
