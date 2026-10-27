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
 *        완료 · 중단 (it had run) · 실행 안 됨 (it never ran) — never running
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
function load<T>(fns: string[], vars: string[], inject: Record<string, unknown> = {}): T {
  const names = Object.keys(inject);
  const setter = '__set: function(n, v) { eval(n + " = v"); }';
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\nreturn { ${[...fns, setter].join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}
/** The page markup as served (the template between <body> and the first <script>). */
const PAGE = cook(TEMPLATE.slice(TEMPLATE.indexOf('<body'), TEMPLATE.indexOf('<script>', TEMPLATE.indexOf('<body'))));
const CSS = cook(TEMPLATE.slice(TEMPLATE.indexOf('<style>'), TEMPLATE.indexOf('</style>')));

const T0 = 1_700_000_000_000;
const BASE_FNS = ['esc', 'escAttr', 'toNum', 'formatDuration', 'formatTaskTime', 'agentIconHtml'];
const BASE_VARS = [
  'AGENT_STATUS_LABEL',
  'TASK_FATE_LABEL',
  'TASK_PAUSE_SVG',
  'TASK_STOP_SVG',
  'TASK_SKIP_SVG',
  'PI_CHEV_SVG',
];

type Task = Record<string, unknown>;

// ── T2 — what a later list did to a task ──
describe('T2 · a dropped task never reads as running or waiting', () => {
  const plan = load<{
    taskFateOf(t: Task): string;
    renderPanelTaskItem(t: Task, pop?: boolean): string;
    renderTaskMeta(t: Task): string;
    planEarlierCounts(earlier: Task[]): { done: number; dropped: number; skipped: number };
    planEarlierGroups(earlier: Task[]): Array<{ at: number; tasks: Task[] }>;
  }>(
    [...BASE_FNS, 'taskFateOf', 'renderPanelTaskItem', 'renderTaskMeta', 'planEarlierCounts', 'planEarlierGroups'],
    BASE_VARS,
  );

  it('names every fate: done · running · paused · waiting · stopped (dropped after it ran) · not run (dropped before)', () => {
    expect(plan.taskFateOf({ status: 'completed' })).toBe('done');
    expect(plan.taskFateOf({ status: 'in_progress', startedAt: T0 })).toBe('active');
    expect(plan.taskFateOf({ status: 'pending', startedAt: T0 })).toBe('paused');
    expect(plan.taskFateOf({ status: 'pending' })).toBe('pending');
    expect(plan.taskFateOf({ status: 'in_progress', startedAt: T0, dropped: 'started' })).toBe('dropped');
    expect(plan.taskFateOf({ status: 'pending', dropped: 'unstarted' })).toBe('skipped');
  });

  it('a task dropped while it ran reads 중단 with no spinner and no live clock', () => {
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
    expect(html).toContain('중단');
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

  it('the work-log group head of a dropped task carries no live clock', () => {
    const meta = plan.renderTaskMeta({
      status: 'in_progress',
      startedAt: T0,
      removedAt: T0 + 5000,
      toolCalls: 1,
      dropped: 'started',
    });
    expect(meta).not.toContain('task-elapsed');
    expect(meta).toContain('중단');
  });

  it('counts the earlier plans by fate and groups them by the moment a new plan replaced them', () => {
    const earlier: Task[] = [
      { id: 'T7', content: 'g', status: 'pending', dropped: 'unstarted', removedAt: T0 + 2000 },
      { id: 'T6', content: 'f', status: 'completed', removedAt: T0 + 2000 },
      { id: 'T3', content: 'c', status: 'pending', dropped: 'unstarted', removedAt: T0 + 1000 },
      { id: 'T2', content: 'b', status: 'in_progress', startedAt: T0, dropped: 'started', removedAt: T0 + 1000 },
      { id: 'T1', content: 'a', status: 'completed', removedAt: T0 + 1000 },
      { id: 'T0', content: 'legacy', status: 'pending', dropped: 'unstarted' },
    ];
    expect(plan.planEarlierCounts(earlier)).toEqual({ done: 2, dropped: 1, skipped: 3 });
    const groups = plan.planEarlierGroups(earlier);
    expect(groups.map((g) => [g.at, g.tasks.map((t) => t.id)])).toEqual([
      [T0 + 2000, ['T7', 'T6']],
      [T0 + 1000, ['T3', 'T2', 'T1']],
      [0, ['T0']],
    ]);
  });
});

describe('T2 · the panel Tasks section: earlier plans folded with their counts', () => {
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
  const env = load<{
    renderPanelTasks(tasks: Task[] | undefined, scope: string, earlier: Task[]): void;
    __set(n: string, v: unknown): void;
  }>(
    [
      ...BASE_FNS,
      'taskFateOf',
      'renderPanelTaskItem',
      'planEarlierCounts',
      'planEarlierGroups',
      'planEarlierHtml',
      'planSummaryHtml',
      'planFootHtml',
      'renderPanelTasks',
    ],
    [...BASE_VARS, '_panelTasksOpen', '_panelTasksExpanded', '_panelTasksEarlier'],
    {
      document: { getElementById: (id: string) => (id === 'panel-tasks' ? el : null) },
      morphInnerHtml: (target: { innerHTML: string }, html: string) => {
        target.innerHTML = html;
      },
      updateTimersIn: () => {},
    },
  );
  const current: Task[] = [
    {
      id: 'T5',
      content: 'ledger 수정',
      activeForm: 'ledger 수정 중',
      status: 'in_progress',
      startedAt: T0,
      toolCalls: 2,
    },
    { id: 'T6', content: '화면 수정', status: 'pending', toolCalls: 0 },
    { id: 'T8', content: '정리', status: 'completed', startedAt: T0, completedAt: T0 + 1000, toolCalls: 1 },
  ];
  const earlier: Task[] = [
    { id: 'T4', content: 'PR', status: 'pending', dropped: 'unstarted', removedAt: T0 + 500 },
    { id: 'T3', content: '구현', status: 'pending', dropped: 'unstarted', removedAt: T0 + 500 },
    { id: 'T2', content: 'RED', status: 'in_progress', startedAt: T0, dropped: 'started', removedAt: T0 + 500 },
    { id: 'T1', content: '조사', status: 'completed', startedAt: T0, completedAt: T0 + 100, removedAt: T0 + 500 },
  ];

  it('folds by default: one head with the running step and done/total — no step list', () => {
    env.__set('_panelTasksOpen', false);
    env.renderPanelTasks(current, '', earlier);
    expect(el.innerHTML).toContain('aria-expanded="false"');
    expect(el.innerHTML).toContain('ledger 수정 중');
    expect(el.innerHTML).toContain('1/3');
    expect(el.innerHTML).not.toContain('class="pl-list"');
  });

  it('opened: the steps, then 이전 계획 with its counts — the dropped ones folded until asked', () => {
    env.__set('_panelTasksOpen', true);
    env.__set('_panelTasksEarlier', false);
    env.renderPanelTasks(current, '', earlier);
    expect(el.innerHTML).toContain('aria-expanded="true"');
    expect(el.innerHTML).toContain('class="pl-list"');
    expect(el.innerHTML).toContain('이전 계획');
    expect(el.innerHTML).toContain('완료 1');
    expect(el.innerHTML).toContain('중단 1');
    expect(el.innerHTML).toContain('실행 안 됨 2');
    expect(el.innerHTML).not.toContain('pl-earlier-group');
    env.__set('_panelTasksEarlier', true);
    env.renderPanelTasks(current, '', earlier);
    expect(el.innerHTML).toContain('pl-earlier-group');
    expect(el.innerHTML).toContain('새 계획으로 교체');
    // Only the running step of the current list spins.
    expect(el.innerHTML.match(/data-step="active"/g)?.length).toBe(1);
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
  const panel = PAGE.slice(PAGE.indexOf('<div class="slide-panel" id="slide-panel">'), PAGE.indexOf('<!-- New task'));
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

  it('T1.2/T1.3 · the tab list, then one tab panel: Tasks · 작업 로그 · 지시와 답변, in that order', () => {
    expect(panel).toMatch(/<div class="panel-tabs" id="panel-tabs" role="tablist" aria-label="에이전트"/);
    const tabpanel = at('id="panel-tabpanel"');
    expect(panel).toMatch(/<section class="panel-tabpanel" id="panel-tabpanel" role="tabpanel"/);
    expect(tabpanel).toBeGreaterThan(at('id="panel-tabs"'));
    expect(at('id="panel-tasks"')).toBeGreaterThan(tabpanel);
    expect(at('id="panel-worklog"')).toBeGreaterThan(at('id="panel-tasks"'));
    expect(at('id="panel-conv"')).toBeGreaterThan(at('id="panel-worklog"'));
    expect(at('id="panel-turns"')).toBeGreaterThan(at('id="panel-conv"'));
    // 지시와 답변 opens by default; 작업 로그 stays folded.
    expect(panel).toMatch(/id="conv-toggle" aria-expanded="true"/);
    expect(panel).toMatch(/id="worklog-toggle" aria-expanded="false"/);
  });

  it('T1.2 · the tab list sticks while the conversation scrolls, Main sticks at its left', () => {
    expect(CSS).toMatch(/\.panel-tabs \{[^}]*position: sticky;[^}]*top: 0;/);
    expect(CSS).toMatch(/\.panel-tab\.is-main \{[^}]*position: sticky;[^}]*left: 0;/);
  });

  it('T1.6 · minimal by default: the agent path and subtree only with 자세히', () => {
    expect(CSS).toMatch(/\.slide-panel:not\(\.is-detail\) \.pa-bar/);
    expect(CSS).toMatch(/\.slide-panel:not\(\.is-detail\) \.pa-tree/);
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
describe('T1.4 · an assistant turn reads as its answer; Raw sits at the bottom', () => {
  const env = load<{ renderTurn(t: unknown, i?: number, arr?: unknown[], convId?: string): string }>(
    ['esc', 'escAttr', 'escJs', 'toNum', 'decodeSlackEntities', 'ansStateHtml', 'renderTurn'],
    [],
    {
      panelConvId: 'conv-1',
      _artCache: {},
      umRegister: () => {},
      renderUserMedia: () => '',
      renderTurnArtifacts: () => '',
    },
  );
  const html = env.renderTurn(
    { id: 't2', role: 'assistant', timestamp: T0, summaryTitle: '요약 제목', summaryBody: '요약 본문' },
    0,
    [],
    'conv-1',
  );

  it('the answer card is shown by default (not behind a closed disclosure)', () => {
    expect(html).toContain('<div class="turn-answer" data-conv="conv-1" data-turn="t2">');
    const answer = html.indexOf('class="turn-answer"');
    const raw = html.indexOf('<details class="turn-raw"');
    expect(answer).toBeGreaterThan(-1);
    expect(raw).toBeGreaterThan(answer);
  });

  it('Raw holds the summary and the source — at the foot of the turn', () => {
    const raw = html.slice(html.indexOf('<details class="turn-raw"'));
    expect(raw).toContain('Raw');
    expect(raw).toContain('요약 본문');
    expect(raw).toContain('turn-raw-src');
    expect(html).not.toContain('답변 전문');
  });
});

// ── T1.5 — the composer ──
describe('T1.5 · the steering composer: multiline, images, files, voice', () => {
  const cmd = PAGE.slice(PAGE.indexOf('<div class="panel-command" id="panel-command">'), PAGE.indexOf('<!-- New task'));

  it('is a textarea with attach / image / mic tools beside it', () => {
    expect(cmd).toMatch(/<textarea id="cmd-input"/);
    expect(cmd).not.toMatch(/<input type="text" id="cmd-input"/);
    expect(cmd).toContain('id="pc-attach"');
    expect(cmd).toContain('id="pc-image"');
    expect(cmd).toMatch(/id="pc-mic"[^>]*aria-pressed="false"/);
    expect(cmd).toContain('id="pc-attachments"');
    expect(cmd).toContain('id="pc-recorder"');
    expect(cmd).toMatch(/<input type="file" id="pc-file-input" multiple hidden/);
    expect(cmd).toMatch(/<input type="file" id="pc-image-input" accept="image\/\*"/);
    // Model · effort sit above the composer.
    expect(cmd.indexOf('id="panel-controls"')).toBeLessThan(cmd.indexOf('id="cmd-input"'));
  });

  const pc = load<{
    pcEnterAction(e: Record<string, unknown>, touch: boolean): string;
    pcCommandBody(message: string, files: Array<Record<string, unknown>>): unknown;
    pcCanSend(message: string, files: unknown[]): boolean;
  }>(['pcEnterAction', 'pcCommandBody', 'pcCanSend'], []);

  it('Enter sends, Shift+Enter breaks the line, an IME composition (한글) never sends', () => {
    expect(pc.pcEnterAction({ key: 'Enter' }, false)).toBe('send');
    expect(pc.pcEnterAction({ key: 'Enter', shiftKey: true }, false)).toBe('newline');
    expect(pc.pcEnterAction({ key: 'Enter', isComposing: true }, false)).toBe('none');
    expect(pc.pcEnterAction({ key: 'Enter', keyCode: 229 }, false)).toBe('none');
    expect(pc.pcEnterAction({ key: 'Enter', metaKey: true }, true)).toBe('send');
    // On a phone Enter is a line break; the send button sends.
    expect(pc.pcEnterAction({ key: 'Enter' }, true)).toBe('newline');
    expect(pc.pcEnterAction({ key: 'a' }, false)).toBe('none');
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
