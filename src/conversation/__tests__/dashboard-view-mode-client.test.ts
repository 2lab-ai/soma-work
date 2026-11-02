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
import { BUILTIN_PRESETS } from '../../view-layout';
import { viewerScope } from '../__fixtures__/viewer-scope';
import { VIEW_LAYOUT_CLIENT_JS } from '../view-layout-client';

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
/** A one-line `var X = …;`, or a block `var X = {` … `\n};` (VIEW_PLANS). */
function clientVar(name: string): string {
  const m = TEMPLATE.match(new RegExp(`^(var ${name} = .*?;)(?:\\s*//.*)?$`, 'm'));
  if (m) return cook(m[1]);
  const start = TEMPLATE.indexOf(`\nvar ${name} = {\n`);
  if (start < 0) throw new Error(`client var ${name} not found`);
  return cook(TEMPLATE.slice(start + 1, TEMPLATE.indexOf('\n};\n', start) + 3));
}
function load<T>(fns: string[], vars: string[], inject: Record<string, unknown> = {}): T {
  ({ fns, inject } = viewerScope(fns, inject));
  // The page's script as the browser runs it: the shared layout script (view-layout-client.ts) and VIEW_BUILTINS first.
  const all: Record<string, unknown> = { VIEW_BUILTINS: BUILTIN_PRESETS, ...inject };
  const names = Object.keys(all);
  const setter = '__set: function(n, v) { eval(n + " = v"); }';
  const getter = '__get: function(n) { return eval(n); }';
  const body = `${VIEW_LAYOUT_CLIENT_JS}\n${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\nreturn { ${[...fns, setter, getter].join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => all[n])) as T;
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

  it('the detail sections follow the mode’s plan: advanced 1안 · 2안 are the old 자세히 on (.prd/20)', () => {
    const fn = clientFn('applyViewMode');
    expect(fn).toContain('_panelDetail = !!spec.detail.open;');
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
    let saveOk = true;
    const env = load<{ toggleViewMode(): Promise<void>; __set(n: string, v: unknown): void }>(
      ['viewModeFrom', 'isAdvanced', 'setViewMode', 'saveViewMode', 'toggleViewMode'],
      [
        'VIEW_MODE_KEY',
        '_viewMode',
        '_viewModeOnServer',
        '_viewModeChosen',
        '_viewModeSaving',
        '_viewModeResave',
        '_viewModeSeq',
      ],
      {
        localStorage: { setItem: (k: string, v: string) => (stored[k] = v) },
        applyViewMode: () => calls.push('apply'),
        rerenderForViewMode: () => calls.push('rerender'),
        patchSetting: async (k: string, v: unknown) => {
          calls.push(['patch', k, v]);
          return saveOk ? { ok: true } : { ok: false, error: 'HTTP 500' };
        },
        dashToast: (t: { title: string; tone: string }) => calls.push(['toast', t.title, t.tone]),
        console,
      },
    );
    // Before the settings answer (or a viewer without a Slack user): the device only — the choice is marked
    // so the settings answer keeps it and saves it.
    await env.toggleViewMode();
    expect(calls).toEqual(['apply', 'rerender']);
    expect(Object.values(stored)).toEqual(['advanced']);
    // A signed-in Slack user: the server keeps it.
    calls.length = 0;
    env.__set('_viewModeOnServer', true);
    await env.toggleViewMode();
    expect(calls).toEqual(['apply', 'rerender', ['patch', 'dashboardMode', 'minimal']]);
    expect(Object.values(stored)).toEqual(['minimal']);
    // A save that fails says so (review R1, fable P3) — the page keeps the choice on this device.
    calls.length = 0;
    saveOk = false;
    await env.toggleViewMode();
    expect(calls).toEqual([
      'apply',
      'rerender',
      ['patch', 'dashboardMode', 'advanced'],
      ['toast', '화면 모드를 저장하지 못했어요', 'error'],
    ]);
  });

  it('a toggle before the settings answer is kept and saved, not undone by the answer (review R1, fable P2)', () => {
    const toggle = clientFn('toggleViewMode');
    expect(toggle).toContain('if (!_viewModeOnServer) { _viewModeChosen = true; return; }');
    const load = clientFn('loadMyDefaults');
    const chosen = load.indexOf('if (_viewModeChosen) {');
    expect(chosen).toBeGreaterThan(-1);
    expect(load.indexOf('if (_viewModeOnServer && vm !== _viewMode) saveViewMode();')).toBeGreaterThan(chosen);
    expect(load.indexOf('} else if (seq === _viewModeSeq')).toBeGreaterThan(chosen);
  });

  it('the settings load applies the user’s mode before the defaults’ acceptance gate', () => {
    const fn = clientFn('loadMyDefaults');
    const at = fn.indexOf('viewModeOfSettings(data)');
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(fn.indexOf('data.accepted === false'));
  });

  it('the first paint is the device copy, then the server answers', () => {
    expect(TEMPLATE).toMatch(
      /^_viewMode = readViewMode\(\);\n_viewPlan = readViewPlan\(\);\n_viewLayout = readViewLayout\(\);\napplyViewMode\(\);/m,
    );
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

  // The default plan (.prd/20 §5.1, 1안 결과 우선) is what minimal means until the user picks another.
  const faces = load<{
    cardAsks(s: unknown, col: string): boolean;
    viewSpec(): any;
    __get(n: string): any;
  }>(
    ['toNum', 'pendingAutoResume', 'cardAsks', 'viewModeFrom', 'viewPlanFrom', 'viewSpec'],
    ['_viewMode', '_viewPlan', '_viewLayout'],
    { REPRESENTATIVE_MODELS: [] },
  );
  const minimalFace = (c: unknown, sess: unknown = {}, col = 'working') =>
    faces.__get('faceOf')(c, (sess as { model?: string }).model, faces.viewSpec().face, faces.cardAsks(sess, col));

  it('the face keeps title · status · time · the task in progress · the links · lead · owner · artifacts; the summary when it asks; the foot is cost · model', () => {
    const m = minimalFace(full);
    expect(Object.keys(m).sort()).toEqual(
      [
        'artifacts',
        'artifactsCount',
        'badge',
        'bodyMode',
        'elapsedMs',
        'id',
        'lead',
        'metrics',
        'rows',
        'since',
        'status',
        'statusText',
        'task',
        'title',
        'titles',
      ].sort(),
    );
    expect(m.task).toEqual(full.task);
    // What the card asks is the summary; otherwise it would be the title once more (.prd/20 G2).
    expect(minimalFace(full, { pendingQuestion: { question: '질문' } }, 'waiting').summary).toBe('질문');
    // The foot's right end: the price. The PR (the outcome, .prd/20 G3) is in the links row now, with the issues
    // and wikis and their states (작업 카드의 연결, SSOT 2026-11-02) — not a chip as well.
    expect(m.metrics).toEqual([{ text: '$6.20', title: 'c\nt' }]);
    // Absent fields stay absent (no undefined keys for the element to read); a plain task gets its mark.
    expect(minimalFace({ id: 'k', title: 't', status: 'done', bodyMode: 'slot' })).toEqual({
      id: 'k',
      title: 't',
      status: 'done',
      bodyMode: 'slot',
      // The layout's rows by name; a row without its data draws nothing (the element skips it).
      rows: ['task', 'links', 'artifacts'],
      lead: { glyph: 'task', title: '일반 작업' },
    });
  });

  it('the board maps through the mode’s plan: advanced keeps the full card', () => {
    const cardOf = () => ({ ...full });
    const env = load<{
      viewCardOf(s: unknown, col: string): Record<string, unknown>;
      __set(n: string, v: unknown): void;
    }>(
      ['viewModeFrom', 'viewPlanFrom', 'viewSpec', 'toNum', 'pendingAutoResume', 'cardAsks', 'viewCardOf'],
      ['_viewMode', '_viewPlan', '_viewLayout'],
      { cardOf, REPRESENTATIVE_MODELS: [], cardStarOf: () => ({ on: false }) },
    );
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
    load<{ renderCardBody(s: unknown, col: string, spec?: unknown): string }>(
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
        'renderEpicPlan',
        'cardLinksFace',
        'renderCardBody',
      ],
      [
        'CARD_LINK_KIND',
        'CARD_LINK_TONES',
        'RESUME_SVG',
        'GOAL_STATUS_LABELS',
        'GOAL_STATUS_TONE',
        'GOAL_SVG',
        'SESSION_ACTION_TONE',
        '_busy',
      ],
      STUBS,
      // minimal: the leanest plan (3안) — the actions and what asks, nothing more (.prd/20 §5.1).
    ).renderCardBody(s, col, minimal ? { star: false, work: [], wait: [], done: [] } : undefined);
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

  it('no spec is the card body as it was', () => {
    const html = body(card(), 'working', false);
    for (const kept of ['[TASKS]', '[AGENTS]', '[IO]', '[MODEL]', 'card-foot-bar']) expect(html).toContain(kept);
    expect(clientFn('paintCardBody')).toContain('var html = renderCardBody(s, col, viewSpec().body);');
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

  it('the tasks paint through the plan: minimal 1안 → the checklist, advanced → the full Tasks section', () => {
    const fn = clientFn('repaintPanelTasks');
    expect(fn).toContain("if (t === 'list') { renderPanelTaskList(panelAgentTasks()); return; }");
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
      ['viewModeFrom', 'viewPlanFrom', 'viewSpec', 'detailShows', 'psecForLanding', 'psecForMode'],
      ['_viewMode', '_viewPlan', '_viewLayout'],
    );
    expect(env.psecForMode('worklog')).toBe('conv');
    expect(env.psecForMode('agent')).toBe('conv');
    env.__set('_viewMode', 'advanced');
    expect(env.psecForMode('worklog')).toBe('log');
    expect(env.psecForMode('agent')).toBe('tree');
    expect(clientFn('openPanel')).toContain('_psec = psecForMode(_panelLand);');
    // …and on the main agent: minimal has no agent tab strip to lead back from a subagent (review R1, grok P1).
    const open = clientFn('openPanel');
    const agentAt = open.indexOf("_panelAgent = agentId ? String(agentId) : '';");
    expect(agentAt).toBeGreaterThan(-1);
    expect(open.indexOf("if (!detailShows('agenttabs') && !detailShows('subtabs')) _panelAgent = '';")).toBeGreaterThan(
      agentAt,
    );
    // Switching to minimal with a subagent or another section shown brings the main agent's chat back.
    const re = clientFn('rerenderForViewMode');
    expect(re).toContain(
      "if (!detailShows('agenttabs') && !detailShows('subtabs') && _panelAgent) selectPanelAgent('');",
    );
    expect(re).toContain("if (!detailShows('sections') && _psec !== 'conv') selectPanelSection('conv');");
    expect(re).toContain('renderBoardForLayout();');
  });

  const minimalRule = (sel: string) =>
    new RegExp(`body\\[data-view-mode="minimal"\\] ${sel.replace(/[.*+?^${}()|[\]\\#]/g, '\\$&')}[,\\s{]`);

  it('the page’s extras step aside: stats, capacity, the CRON lane, the defaults, the user picker, admin write mode', () => {
    for (const sel of ['#stats', '#capacity', '#cron-lane', '#topbar-defaults'])
      expect(CSS, sel).toMatch(minimalRule(sel));
  });

  it('the detail card’s top keeps the header and what needs the user; info · goal · artifacts · tabs · model go (1안)', () => {
    // The layout says which sections show (detailSpecOf → body[data-detail]); minimal 1안 shows none of them.
    const env = load<{ viewSpec(): any }>(
      ['viewModeFrom', 'viewPlanFrom', 'viewSpec'],
      ['_viewMode', '_viewPlan', '_viewLayout'],
    );
    expect(env.viewSpec().detail.show).toEqual([]);
    for (const [tok, sel] of [
      ['subtitle', '#panel-title-sub'],
      ['info', '#panel-info'],
      ['goal', '#panel-goal'],
      ['artifacts', '#panel-artifacts'],
      ['agenthead', '#panel-agents'],
      ['controls', '#panel-controls'],
    ])
      expect(CSS, sel).toContain(`body:not([data-detail~="${tok}"]) ${sel}`);
    expect(CSS).toContain('.panel-tabs::part(list)');
    expect(CSS).toContain('body:not([data-detail~="sections"]) .panel-sections::part(list)');
    // What needs the user is never hidden by the mode or the plan.
    for (const sel of ['#panel-permission', '#panel-question', '#panel-needs-head', '#panel-status', '#pc-composer']) {
      expect(CSS, sel).not.toMatch(minimalRule(sel));
      expect(CSS, sel).not.toContain(`]) ${sel}`);
    }
  });
});

describe('T5 — minimal keeps every session that needs the user in reach (review R1)', () => {
  const cron = (key: string, activityState: string) => ({
    key,
    activityState,
    cronJob: { id: 'j1', name: 'nightly' },
    lastActivity: new Date(T0).toISOString(),
  });
  const board = () => ({
    waiting: [cron('cw', 'waiting')],
    working: [cron('cr', 'working')],
    idle: [cron('ci', 'idle')],
    closed: [],
  });
  const env = load<{ planCronLane(b: unknown, jobs: unknown[], reveal: string | null, live?: boolean): any }>(
    ['isCronCard', 'cronGroupKey', 'cronCardTime', 'planCronLane'],
    [],
  );
  const keys = (arr: Array<{ key: string }>) => arr.map((x) => x.key);

  it('minimal hides the CRON lane, so a cron run that waits or runs stays on the board (fable P1)', () => {
    const live = env.planCronLane(board(), [], null, true);
    expect(keys(live.board.waiting)).toEqual(['cw']);
    expect(keys(live.board.working)).toEqual(['cr']);
    expect(keys(live.board.idle)).toEqual([]);
    expect(live.groups[0].cards.map((c: { key: string }) => c.key)).toEqual(['ci']);
    // 어드밴스드: every cron run is the lane's, as before.
    const lane = env.planCronLane(board(), [], null);
    expect(keys(lane.board.waiting)).toEqual([]);
    expect(keys(lane.board.working)).toEqual([]);
    expect(clientFn('renderBoard')).toContain('planCronLane(board, _cronJobs, _cronRevealKey, !isAdvanced());');
  });

  it('the picker hides only on the viewer’s own board — elsewhere the owner acts after picking themselves (astra P1)', () => {
    expect(CSS).toContain('body[data-view-mode="minimal"][data-board-mine] #user-select,');
    expect(CSS).not.toMatch(/body\[data-view-mode="minimal"\] #user-select[,\s{]/);
    const attrs: Record<string, boolean> = {};
    const env = load<{ syncBoardScope(): void; __set(n: string, v: unknown): void }>(['syncBoardScope'], [], {
      currentUserId: '',
      _viewerUserId: 'U1',
      document: { body: { toggleAttribute: (n: string, on: boolean) => (attrs[n] = on) } },
    });
    env.syncBoardScope(); // All Users (/dashboard)
    expect(attrs['data-board-mine']).toBe(false);
    env.__set('currentUserId', 'U2'); // another user's board
    env.syncBoardScope();
    expect(attrs['data-board-mine']).toBe(false);
    env.__set('currentUserId', 'U1'); // the viewer's own board
    env.syncBoardScope();
    expect(attrs['data-board-mine']).toBe(true);
    env.__set('_viewerUserId', ''); // a viewer without a Slack user owns no board
    env.syncBoardScope();
    expect(attrs['data-board-mine']).toBe(false);
    // Every scope change says it: picking a user, learning who the viewer is, and the first paint.
    expect(clientFn('selectUser')).toContain('syncBoardScope();');
    expect(clientFn('_applyUserPill')).toContain('syncBoardScope();');
    expect(TEMPLATE).toMatch(/^applyViewMode\(\);\nsyncBoardScope\(\);/m);
  });

  it('admin write mode is never hidden by the mode — answering an admin approval needs it on (fable P2, astra R1)', () => {
    expect(CSS).not.toMatch(/body\[data-view-mode="minimal"\][^{]*#admin-mode-toggle/);
    expect(clientFn('adminApprovalLock')).toContain("return '관리자 모드를 켜면 응답할 수 있습니다';");
  });

  it('saves run one at a time and the last switch is the one saved (astra R1)', async () => {
    const patches: Array<{ v: unknown; done: (r: unknown) => void }> = [];
    const env = load<{ toggleViewMode(): Promise<void>; __set(n: string, v: unknown): void }>(
      ['viewModeFrom', 'isAdvanced', 'setViewMode', 'saveViewMode', 'toggleViewMode'],
      [
        'VIEW_MODE_KEY',
        '_viewMode',
        '_viewModeOnServer',
        '_viewModeChosen',
        '_viewModeSaving',
        '_viewModeResave',
        '_viewModeSeq',
      ],
      {
        localStorage: { setItem: () => {} },
        applyViewMode: () => {},
        rerenderForViewMode: () => {},
        patchSetting: (_k: string, v: unknown) => new Promise((done) => patches.push({ v, done })),
        dashToast: () => {},
        console,
      },
    );
    env.__set('_viewModeOnServer', true);
    const flush = () => new Promise((r) => setTimeout(r, 0));
    const first = env.toggleViewMode(); // advanced — saving
    void env.toggleViewMode(); // minimal — waits
    void env.toggleViewMode(); // advanced — waits
    expect(patches.map((p) => p.v)).toEqual(['advanced']);
    patches[0].done({ ok: true });
    await flush();
    // One more write, with the latest choice — never a stale one landing last.
    expect(patches.map((p) => p.v)).toEqual(['advanced', 'advanced']);
    patches[1].done({ ok: true });
    await first;
    expect(patches).toHaveLength(2);
  });

  it('a settings answer asked for before a switch, or landing during a save, is not applied (astra R1)', () => {
    expect(clientFn('toggleViewMode')).toContain('_viewModeSeq++;');
    const loadFn = clientFn('loadMyDefaults');
    expect(loadFn.indexOf('var seq = _viewModeSeq;')).toBeGreaterThan(-1);
    expect(loadFn.indexOf('var seq = _viewModeSeq;')).toBeLessThan(loadFn.indexOf("await fetch('/api/settings')"));
    expect(loadFn).toContain('} else if (seq === _viewModeSeq && !_viewModeSaving && vm !== _viewMode) {');
  });
});

// SSOT 2026-11-01 (second instruction) — the minimal card's foot names the cost and the model with its vendor's
// mark, a line of artifacts, the star is a toggle on the card, and an epic and a plain task show their marks.
describe('T7–T10 — minimal card: cost · model · artifacts, the star toggle, the kind marks', () => {
  const full = {
    id: 'k',
    title: 't',
    status: 'running',
    bodyMode: 'slot',
    tokens: 6_440_000,
    costUsd: 6.2,
    titles: { cost: 'API 환산 비용 (작업 합계)' },
    artifactsCount: 2,
    artifacts: [{ id: 'a', name: 'x.html', kind: 'html' }],
    star: { on: false, title: '즐겨찾기' },
    metrics: [{ text: '#700 열림', glyph: 'pr' }],
    contextPct: 64,
  };
  const env0 = load<{
    viewSpec(): any;
    __get(n: string): any;
  }>(
    ['toNum', 'pendingAutoResume', 'cardAsks', 'viewModeFrom', 'viewPlanFrom', 'viewSpec'],
    ['_viewMode', '_viewPlan', '_viewLayout'],
    { REPRESENTATIVE_MODELS: [{ nickname: 'opus[1m]', model: 'claude-opus-5-5[1m]', label: 'Opus 5.5' }] },
  );
  // minimalCard was the minimal face; it is the default plan's face now (.prd/20 §5.1, 1안). The cost and model
  // cases read the foot's price and model alone (faceFootMetrics: cost · model).
  const env = {
    modelVendorOf: (m: unknown): string => env0.__get('modelVendorOf')(m),
    modelLabelOf: (m: unknown): string => env0.__get('modelLabelOf')(m),
    minimalCard: (c: unknown, sess: { model?: string } = {}): Record<string, any> => {
      const m = env0.__get('faceOf')(c, sess.model, env0.viewSpec().face, false);
      const priced = env0.__get('faceFootMetrics')(c, sess.model, [
        { id: 'cost', on: true },
        { id: 'model', on: true },
      ]);
      return { ...m, metrics: priced.length ? priced : undefined };
    },
  };

  it('T7 — the foot’s right end: the cost, then the model with its vendor’s mark', () => {
    const m = env.minimalCard(full, { model: 'claude-opus-5-5[1m]' });
    expect(m.metrics).toEqual([
      { text: '$6.20', title: 'API 환산 비용 (작업 합계)' },
      { text: 'Opus 5.5', glyph: 'claude', title: 'claude-opus-5-5[1m]' },
    ]);
    // No tokens line, no context, no PR — the price and the model only.
    expect(m.tokens).toBeUndefined();
    expect(m.costUsd).toBeUndefined();
    expect(m.contextPct).toBeUndefined();
    // No cost known: the model alone; no model: the cost alone.
    expect(env.minimalCard({ ...full, costUsd: undefined }, { model: 'grok-4.6' }).metrics).toEqual([
      { text: 'grok-4.6', glyph: 'grok', title: 'grok-4.6' },
    ]);
    expect(env.minimalCard(full, {}).metrics).toEqual([{ text: '$6.20', title: 'API 환산 비용 (작업 합계)' }]);
    // The server's placeholder for a model it does not know is no model name (review: fable P2).
    expect(env.minimalCard(full, { model: 'unknown' }).metrics).toEqual([
      { text: '$6.20', title: 'API 환산 비용 (작업 합계)' },
    ]);
    // A cost under a cent never reads $0.00 (review, grok P3); past $100 no cents.
    expect(env.minimalCard({ ...full, costUsd: 0.004 }, {}).metrics[0].text).toBe('<$0.01');
    expect(env.minimalCard({ ...full, costUsd: 123.4 }, {}).metrics[0].text).toBe('$123');
  });

  it('T7 — the vendor from the model id: claude · openai · grok · gemini · any other', () => {
    expect(env.modelVendorOf('claude-opus-5-5[1m]')).toBe('claude');
    expect(env.modelVendorOf('claude-fable-5')).toBe('claude');
    expect(env.modelVendorOf('sonnet')).toBe('claude');
    expect(env.modelVendorOf('gpt-5.5')).toBe('openai');
    expect(env.modelVendorOf('o3-pro')).toBe('openai');
    expect(env.modelVendorOf('codex-mini')).toBe('openai');
    expect(env.modelVendorOf('grok-4.6')).toBe('grok');
    expect(env.modelVendorOf('gemini-3-pro')).toBe('gemini');
    expect(env.modelVendorOf('astra')).toBe('model');
    expect(env.modelVendorOf(undefined)).toBe('model');
    // The name: the representative label, else the id without the claude- prefix and its date.
    expect(env.modelLabelOf('claude-opus-5-5[1m]')).toBe('Opus 5.5');
    expect(env.modelLabelOf('claude-sonnet-4-5-20250929')).toBe('sonnet-4-5');
    expect(env.modelLabelOf('claude-sonnet-4-5-20250929[1m]')).toBe('sonnet-4-5[1m]');
    expect(env.modelLabelOf('gpt-5.5')).toBe('gpt-5.5');
  });

  it('T8 — a line of artifacts stays on the minimal face', () => {
    const m = env.minimalCard(full, {});
    expect(m.artifacts).toEqual(full.artifacts);
    expect(m.artifactsCount).toBe(2);
  });

  it('T9 — the star toggle stays on the minimal face', () => {
    expect(env.minimalCard(full, {}).star).toEqual({ on: false, title: '즐겨찾기' });
  });

  it('T10 — a plain task leads with the task mark; an epic, a child, a cron run keep their own lead', () => {
    expect(env.minimalCard(full, {}).lead).toEqual({ glyph: 'task', title: '일반 작업' });
    const epic = { ...full, lead: { text: 'EPIC', glyph: 'epic', title: '에픽 — 실행 중' } };
    expect(env.minimalCard(epic, {}).lead).toEqual(epic.lead);
    // cardOf: an epic's lead is the epic mark.
    expect(clientFn('cardOf')).toContain("card.lead = { text: 'EPIC', glyph: 'epic', title: '에픽 — ' + epicLabel };");
  });
});

describe('T9 — the star on every card face is a toggle (SSOT 2026-11-01, "별 표시가 태스크 카드에서 그대로 토글 버튼")', () => {
  const env = load<{ cardStarOf(s: unknown, col: string): Record<string, unknown> }>(['cardStarOf'], [], {
    sessionActionsOf: (s: { ownerId?: string; starred?: boolean; sib?: boolean }) =>
      s.sib
        ? [{ id: 'stop', sibling: true, lock: 'other instance' }]
        : [
            {
              id: 'star',
              pressed: s.starred === true,
              lock: s.ownerId === 'U1' ? '' : 'read only',
              busy: false,
              tip: s.starred ? '즐겨찾기 해제' : '즐겨찾기',
            },
          ],
    STRINGS: { siblingLock: () => 'open it on other' },
  });

  it('the owner’s star is a live toggle; anyone else sees its state, inert, with the reason', () => {
    expect(env.cardStarOf({ ownerId: 'U1', starred: true }, 'idle')).toEqual({ on: true, title: '즐겨찾기 해제' });
    expect(env.cardStarOf({ ownerId: 'U1' }, 'idle')).toEqual({ on: false, title: '즐겨찾기' });
    expect(env.cardStarOf({ ownerId: 'U2', starred: true }, 'idle')).toEqual({
      on: true,
      title: '즐겨찾기 해제',
      disabled: 'read only',
    });
    expect(env.cardStarOf({ ownerId: 'U1', starred: true, sib: true, environment: {} }, 'idle')).toEqual({
      on: true,
      disabled: 'open it on other',
    });
  });

  it('cardOf puts the toggle on the face (no ★ in the lead any more), and the board answers ui-star with doStar', () => {
    expect(clientFn('viewCardOf')).toContain('c.star = cardStarOf(s, col);');
    expect(clientFn('cardOf')).not.toContain("'\\u2605 ' + card.lead.text");
    const wire = clientFn('wireInbox');
    expect(wire).toContain("host.addEventListener('ui-star', function(e) {");
    expect(wire).toContain('doStar(String(e.detail.cardId), !!e.detail.starred);');
  });
});
