/**
 * Dashboard view mode (SSOT 2026-11-01): 미니멀 by default, 어드밴스드 on the top
 * bar's toggle, saved per user. Executes the shipped client code cut out of
 * renderDashboardPage()'s template literal, cooked exactly as the browser
 * receives it (the harness of dashboard-task-view-client.test.ts).
 *
 *   T1  the detail card's 자세히 chip is gone — the mode is the one switch
 *   T2  the top bar's right end carries the 어드밴스드 toggle (off by default);
 *       the choice is the user's dashboardMode setting, the device's copy only
 *       for the first paint and a viewer without a Slack user
 *   T3  minimal: a card face keeps what matters (title · status · time · the
 *       task in progress · what it asks); the open card keeps its actions and
 *       what needs the user
 *   T4  minimal: the detail card is a task list and the chat — its top part is
 *       the header and what needs the user; the page's extras step aside
 *   T5  advanced: everything the page showed, every section open (the old 자세히)
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
const CSS = cook(
  TEMPLATE.slice(TEMPLATE.indexOf('<style>'), TEMPLATE.indexOf('</style>', TEMPLATE.indexOf('<style>'))),
);
const T0 = 1_700_000_000_000;

describe('T1 — the detail card has no 자세히 chip; the view mode is the one switch', () => {
  it('no chip, no per-device detail key, no toggle function', () => {
    expect(PAGE).not.toContain('panel-detail-toggle');
    expect(TEMPLATE).not.toContain('soma-panel-detail');
    expect(declarationCount('togglePanelDetail')).toBe(0);
    expect(declarationCount('readPanelDetail')).toBe(0);
  });

  it('the detail sections follow the mode: advanced is the old 자세히 on', () => {
    const fn = clientFn('applyViewMode');
    expect(fn).toContain("_panelDetail = _viewMode === 'advanced';");
    expect(fn).toContain('applyPanelDetail();');
  });
});

describe('T2 — the top bar carries the 어드밴스드 toggle, saved per user', () => {
  it('a button that behaves like a toggle, in the bar’s right-end actions, off by default', () => {
    const bar = PAGE.slice(PAGE.indexOf('<ui-app-bar id="app-bar"'), PAGE.indexOf('</ui-app-bar>'));
    const btn = bar.match(/<button[^>]*id="view-mode-toggle"[^>]*>[\s\S]*?<\/button>/);
    expect(btn, 'the toggle is in <ui-app-bar>').not.toBeNull();
    expect(btn![0]).toContain('slot="actions"');
    expect(btn![0]).toContain('aria-pressed="false"');
    expect(btn![0]).toContain('onclick="toggleViewMode()"');
    expect(btn![0]).toContain('어드밴스드');
    // Right end: after 새 작업, the bar's other action.
    expect(bar.indexOf('id="view-mode-toggle"')).toBeGreaterThan(bar.indexOf('id="new-task-btn"'));
  });

  it('the mode is minimal unless the value says advanced', () => {
    const env = load<{ viewModeFrom(v: unknown): string }>(['viewModeFrom'], []);
    expect(env.viewModeFrom('advanced')).toBe('advanced');
    for (const v of ['minimal', null, undefined, '', 'detail', true, 1]) expect(env.viewModeFrom(v)).toBe('minimal');
    expect(TEMPLATE).toMatch(/^var _viewMode = 'minimal';/m);
  });

  it("the server's row wins over the device's copy; no row (a viewer without a Slack user) keeps the device's", () => {
    const env = load<{ viewModeOfSettings(snapshot: unknown): string | null }>(
      ['viewModeFrom', 'viewModeOfSettings'],
      [],
    );
    const snap = (value: unknown) => ({
      settings: [
        { key: 'defaultModel', value: 'opus' },
        { key: 'dashboardMode', value },
      ],
    });
    expect(env.viewModeOfSettings(snap('advanced'))).toBe('advanced');
    expect(env.viewModeOfSettings(snap('minimal'))).toBe('minimal');
    expect(env.viewModeOfSettings(snap('weird'))).toBe('minimal');
    expect(env.viewModeOfSettings({ settings: [{ key: 'defaultModel', value: 'opus' }] })).toBeNull();
    expect(env.viewModeOfSettings(null)).toBeNull();
  });

  it('the toggle flips the mode, keeps the device copy, and saves the user’s setting when there is a Slack user', async () => {
    const calls: unknown[] = [];
    const stored: Record<string, string> = {};
    const env = load<{ toggleViewMode(): Promise<void>; __set(n: string, v: unknown): void }>(
      ['viewModeFrom', 'isAdvanced', 'setViewMode', 'toggleViewMode'],
      ['VIEW_MODE_KEY', '_viewMode', '_viewModeOnServer'],
      {
        localStorage: { setItem: (k: string, v: string) => (stored[k] = v) },
        applyViewMode: () => calls.push('apply'),
        rerenderForViewMode: () => calls.push('rerender'),
        patchSetting: async (k: string, v: unknown) => {
          calls.push(['patch', k, v]);
          return { ok: true };
        },
        console,
      },
    );
    // A viewer without a Slack user: the device only.
    await env.toggleViewMode();
    expect(calls).toEqual(['apply', 'rerender']);
    expect(Object.values(stored)).toEqual(['advanced']);
    // A signed-in Slack user: the server keeps it.
    calls.length = 0;
    env.__set('_viewModeOnServer', true);
    await env.toggleViewMode();
    expect(calls).toEqual(['apply', 'rerender', ['patch', 'dashboardMode', 'minimal']]);
    expect(Object.values(stored)).toEqual(['minimal']);
  });

  it('the settings load applies the user’s mode before the defaults’ acceptance gate', () => {
    const fn = clientFn('loadMyDefaults');
    const at = fn.indexOf('viewModeOfSettings(data)');
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(fn.indexOf('data.accepted === false'));
  });

  it('the first paint is the device copy, then the server answers', () => {
    expect(TEMPLATE).toMatch(/^_viewMode = readViewMode\(\);\napplyViewMode\(\);/m);
  });
});

describe('T3 — minimal: a card shows what matters', () => {
  const full = {
    id: 'k',
    title: '대시보드 미니멀 모드',
    status: 'running',
    statusText: '실행 중',
    bodyMode: 'slot',
    summary: '질문',
    since: T0,
    elapsedMs: 1000,
    task: { label: '구현', startedAt: T0 },
    lead: { text: '★' },
    badge: { text: 'Zhuge', hue: 1, title: 'Zhuge' },
    agents: { total: 2, running: 1, done: 1, failed: 0, dots: ['done', 'running'] },
    tokens: 6_440_000,
    costUsd: 6.2,
    artifactsCount: 2,
    artifacts: [{ id: 'a', name: 'x.html', kind: 'html' }],
    steps: { done: 2, total: 4 },
    contextPct: 64,
    contextLevel: 'warn',
    titles: { tokens: 't', cost: 'c', context: 'x' },
    metrics: [{ text: '#700 열림', glyph: 'pr' }],
  };

  it('the face keeps title · status · time · the task in progress · the summary · lead · owner', () => {
    const env = load<{ minimalCard(c: unknown): Record<string, unknown> }>(['minimalCard'], ['MINIMAL_CARD_KEYS']);
    const m = env.minimalCard(full);
    expect(Object.keys(m).sort()).toEqual(
      [
        'badge',
        'bodyMode',
        'elapsedMs',
        'id',
        'lead',
        'since',
        'status',
        'statusText',
        'summary',
        'task',
        'title',
      ].sort(),
    );
    expect(m.task).toEqual(full.task);
    // Absent fields stay absent (no undefined keys for the element to read).
    expect(Object.keys(env.minimalCard({ id: 'k', title: 't', status: 'done', bodyMode: 'slot' }))).toEqual([
      'id',
      'title',
      'status',
      'bodyMode',
    ]);
  });

  it('the board maps through the mode: advanced is the full card', () => {
    const cardOf = () => ({ ...full });
    const env = load<{
      viewCardOf(s: unknown, col: string): Record<string, unknown>;
      __set(n: string, v: unknown): void;
    }>(['viewModeFrom', 'isAdvanced', 'minimalCard', 'viewCardOf'], ['MINIMAL_CARD_KEYS', '_viewMode'], { cardOf });
    expect(env.viewCardOf({}, 'working').costUsd).toBeUndefined();
    env.__set('_viewMode', 'advanced');
    expect(env.viewCardOf({}, 'working').costUsd).toBe(6.2);
    // Both board paths draw through it: the full render and the single-card refresh.
    expect(clientFn('placeCard')).toContain('_cardData[s.key] = viewCardOf(s, col);');
    expect(clientFn('refreshCard')).toContain("var c = viewCardOf(s, _cardCol[key] || 'idle');");
  });

  const STUBS: Record<string, unknown> = {
    dhShow: () => true,
    formatTokens: (n: number) => `${n}`,
    formatNmSSs: () => '0',
    cardTotalTokens: () => 0,
    _goalErrors: {},
    safeHref: (u: string) => u,
    getEnvBadgeColor: () => '#000',
    _envCount: () => 1,
    isSiblingSession: () => false,
    renderCardIo: () => '[IO]',
    renderCardArtifacts: () => '[ARTS]',
    renderAgentTree: () => '[AGENTS]',
    renderCardTasks: () => '[TASKS]',
    renderMultiChoiceCard: () => '[MC]',
    renderModelNote: () => '',
    renderModelPicker: () => '[MODEL]',
    renderEffortPicker: () => '[EFFORT]',
    effortLabel: (e: string) => e,
    currentUserId: 'U1',
    SELF_INSTANCE_NAME: '',
    READ_ONLY_MSG: 'read only',
  };
  const body = (s: Record<string, unknown>, col: string, minimal: boolean) =>
    load<{ renderCardBody(s: unknown, col: string, minimal?: boolean): string }>(
      [
        'esc',
        'escAttr',
        'escJs',
        'toNum',
        'formatTaskTime',
        'pendingAutoResume',
        'autoResumeLabel',
        'permissionSummary',
        'cardSummary',
        'cardCurrentTask',
        'renderCardResume',
        'taskOutcomeHtml',
        'taskNoticeFailHtml',
        'isBusy',
        'sessionActionsOf',
        'sessionActionHtml',
        'cardGoalLine',
        'acSlotHtml',
        'acQuestionId',
        'acPermissionsHtml',
        'acGoalDecisionHtml',
        'acQuestionHtml',
        'renderCardBody',
      ],
      ['RESUME_SVG', 'GOAL_STATUS_LABELS', 'GOAL_STATUS_TONE', 'GOAL_SVG', 'SESSION_ACTION_TONE', '_busy'],
      STUBS,
    ).renderCardBody(s, col, minimal);
  const card = (over: Record<string, unknown> = {}) => ({
    key: 'inst::C1:t1',
    conversationId: 'conv-1',
    ownerId: 'U1',
    model: 'claude-opus-5-5[1m]',
    effort: 'high',
    slackThreadUrl: 'https://slack.example/t',
    activityState: 'working',
    lastActivity: new Date(T0).toISOString(),
    ...over,
  });

  it('the open card keeps its actions (Stop · Slack) and what it asks; the rest is the detail card’s', () => {
    const working = body(card(), 'working', true);
    expect(working).toContain('card-actions-bar');
    expect(working).toContain('data-action="stop"');
    expect(working).toContain('>Slack</a>');
    for (const gone of ['[TASKS]', '[AGENTS]', '[IO]', '[MODEL]', 'card-foot-bar']) expect(working).not.toContain(gone);
    const question = { type: 'user_choice', question: 'Ship it?', choices: [{ id: '1', label: 'Yes' }] };
    const asked = body(card({ pendingQuestion: question }), 'waiting', true);
    expect(asked).toContain('data-ac-kind="question"');
    for (const gone of ['[TASKS]', '[AGENTS]', '[IO]', '[ARTS]']) expect(asked).not.toContain(gone);
    const prompted = body(
      card({ pendingPermissions: [{ approvalId: 'ap1', toolName: 'Bash', requesterId: 'U1' }] }),
      'working',
      true,
    );
    expect(prompted).toContain('data-ac-kind="perm"');
  });

  it('advanced (no flag) is the card body as it was', () => {
    const html = body(card(), 'working', false);
    for (const kept of ['[TASKS]', '[AGENTS]', '[IO]', '[MODEL]', 'card-foot-bar']) expect(html).toContain(kept);
    expect(clientFn('paintCardBody')).toContain('var html = renderCardBody(s, col, !isAdvanced());');
  });
});

describe('T4 — minimal: the detail card is the task list and the chat', () => {
  it('the task list is the whole current list as one checklist — no runs table, no folds, no tool counts', () => {
    const env = load<{ panelTaskListData(tasks: unknown[]): { title: string; steps: Array<Record<string, unknown>> } }>(
      ['toNum', 'taskFateOf', 'cardTaskStep', 'panelTaskListData'],
      ['CARD_TASK_STATUS'],
      { panelSessionKey: '', _sessionCache: {}, _panelAgent: '' },
    );
    const d = env.panelTaskListData([
      { id: 'T1', content: '요구 정리', status: 'completed', startedAt: T0, completedAt: T0 + 60_000, toolCalls: 6 },
      { id: 'T2', content: '구현', status: 'in_progress', startedAt: T0 + 60_000, toolCalls: 3 },
      { id: 'T3', content: '확인', status: 'pending' },
    ]);
    expect(d.title).toBe('');
    expect(d.steps.map((s) => s.label)).toEqual(['요구 정리', '구현', '확인']);
    expect(d.steps.map((s) => s.status)).toEqual(['done', 'running', 'pending']);
    for (const s of d.steps) expect(s.toolCalls).toBeUndefined();
  });

  it('the tasks paint through the mode: minimal → the checklist, advanced → the full Tasks section', () => {
    const fn = clientFn('repaintPanelTasks');
    expect(fn).toContain('if (!isAdvanced())');
    expect(fn).toContain('renderPanelTaskList(panelAgentTasks());');
    expect(fn).toContain(
      'renderPanelTasks(panelAgentTasks(), panelAgentLabel(), panelAgentEarlier(), panelAgentOutside());',
    );
    const list = clientFn('renderPanelTaskList');
    expect(list).toContain('<ui-task-plan class="panel-task-list" id="panel-task-list" lang="ko" flush foot="none">');
    expect(list).toContain('작업 목록');
    // No list yet: no row — the chat gets the space.
    expect(list).toContain("container.style.display = list.length ? '' : 'none';");
  });

  it('an opening in minimal mode lands on the chat of the main agent', () => {
    const env = load<{ psecForMode(land: string): string; __set(n: string, v: unknown): void }>(
      ['viewModeFrom', 'isAdvanced', 'psecForLanding', 'psecForMode'],
      ['_viewMode'],
    );
    expect(env.psecForMode('worklog')).toBe('conv');
    expect(env.psecForMode('agent')).toBe('conv');
    env.__set('_viewMode', 'advanced');
    expect(env.psecForMode('worklog')).toBe('log');
    expect(env.psecForMode('agent')).toBe('tree');
    expect(clientFn('openPanel')).toContain('_psec = psecForMode(_panelLand);');
    // Switching to minimal with a subagent or another section shown brings the main agent's chat back.
    const re = clientFn('rerenderForViewMode');
    expect(re).toContain("if (_panelAgent) selectPanelAgent('');");
    expect(re).toContain("if (_psec !== 'conv') selectPanelSection('conv');");
    expect(re).toContain('renderBoardForLayout();');
  });

  const minimalRule = (sel: string) =>
    new RegExp(`body\\[data-view-mode="minimal"\\] ${sel.replace(/[.*+?^${}()|[\]\\#]/g, '\\$&')}[,\\s{]`);

  it('the page’s extras step aside: stats, capacity, the CRON lane, the defaults, the user picker, admin write mode', () => {
    for (const sel of ['#stats', '#capacity', '#cron-lane', '#topbar-defaults', '#user-select', '#admin-mode-toggle'])
      expect(CSS, sel).toMatch(minimalRule(sel));
  });

  it('the detail card’s top keeps the header and what needs the user; info · goal · artifacts · tabs · model go', () => {
    for (const sel of [
      '#panel-title-sub',
      '#panel-info',
      '#panel-goal',
      '#panel-artifacts',
      '#panel-agents',
      '#panel-controls',
    ])
      expect(CSS, sel).toMatch(minimalRule(sel));
    expect(CSS).toMatch(/body\[data-view-mode="minimal"\] \.panel-tabs::part\(list\)/);
    expect(CSS).toMatch(/body\[data-view-mode="minimal"\] \.panel-sections::part\(list\)/);
    // What needs the user is never hidden by the mode.
    for (const sel of ['#panel-permission', '#panel-question', '#panel-needs-head', '#panel-status', '#pc-composer'])
      expect(CSS, sel).not.toMatch(minimalRule(sel));
  });
});
