/**
 * Spec 13 — three surfaces of one agentic task, each with its own job
 * (.prd/13-dashboard-three-surfaces-spec.md). Executes the shipped client code
 * cut out of renderDashboardPage()'s template literal, cooked exactly as the
 * browser receives it (the harness of dashboard-agent-tree-client.test.ts).
 *
 *   face      = triage ("does it need me, is it moving") — audited against the
 *               compact tier (§3.7): PR badge, recency, context level added
 *   expanded  = settle it here: sections keyed on the card's state, never the
 *               face's data again, the agent tree at compact density
 *   panel     = understand and steer: a status chip with the session's one
 *               action, 세션 정보 (live), the goal editor, the rich agent tree,
 *               model · effort beside the composer, intent-based landing
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pageTokenAliases, uiLibTokensCss } from '../ui-lib';

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
/** The page's chrome words (STRINGS), as served: the board's Korean words live there (D2 group 6). */
const PAGE_STRINGS = new Function(
  `${cook(TEMPLATE.slice(TEMPLATE.indexOf('var STRINGS = {'), TEMPLATE.indexOf('\n};\n', TEMPLATE.indexOf('var STRINGS = {')) + 3))}\nreturn STRINGS;`,
)();
function load<T>(fns: string[], vars: string[], inject: Record<string, unknown> = {}, extra: string[] = []): T {
  inject = { STRINGS: PAGE_STRINGS, ...inject };
  const names = Object.keys(inject);
  const extraNames = extra.map((src) => /^function (\w+)/.exec(src)?.[1] ?? '').filter(Boolean);
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\n${extra.join('\n')}\nreturn { ${[...fns, ...extraNames].join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}
/** The page markup as served (the template between <body> and the first <script>). */
const PAGE = cook(TEMPLATE.slice(TEMPLATE.indexOf('<body'), TEMPLATE.indexOf('<script>', TEMPLATE.indexOf('<body'))));

const T0 = 1_700_000_000_000;
type Agent = Record<string, unknown>;
const AGENTS: Agent[] = [
  {
    id: 'toolu_explore',
    n: 1,
    type: 'Explore',
    description: 'Trace subagent frames',
    status: 'running',
    startedAt: T0,
    toolCalls: 18,
    tokens: 238000,
    spend: {
      inputTokens: 1000,
      outputTokens: 2000,
      cacheReadTokens: 235000,
      cacheCreateTokens: 0,
      costUsd: 0.42,
      calls: 7,
    },
    background: true,
    tasks: [{ id: 'T1', content: 'Read the mapper', activeForm: 'Reading the mapper', status: 'in_progress' }],
  },
  {
    id: 'toolu_nested',
    n: 3,
    parentId: 'toolu_explore',
    type: 'general-purpose',
    description: 'Check nested spawn frames',
    status: 'failed',
    startedAt: T0 + 10_000,
    endedAt: T0 + 51_000,
    toolCalls: 3,
  },
  {
    id: 'toolu_lib',
    n: 2,
    type: 'librarian',
    description: 'Prior art',
    status: 'completed',
    startedAt: T0 + 5_000,
    endedAt: T0 + 247_000,
    durationMs: 242_000,
    toolCalls: 31,
    lastTool: 'WebFetch',
  },
];
const card = (over: Record<string, unknown> = {}) => ({
  key: 'inst::C1:t1',
  conversationId: 'conv-1',
  ownerId: 'U1',
  ownerName: 'Zhuge',
  workflow: 'zwork',
  model: 'claude-opus-5-5[1m]',
  effort: 'high',
  activityState: 'working',
  activeLegStartedAtMs: T0,
  activeAccumulatedMs: 65_000,
  agentRoot: { toolCalls: 7, lastTool: 'Edit' },
  lastActivity: new Date(T0 + 300_000).toISOString(),
  tokenUsage: {
    totalInputTokens: 1_200_000,
    totalOutputTokens: 91_000,
    totalCacheReadTokens: 8_000_000,
    totalCacheCreateTokens: 300_000,
    totalCostUsd: 12.4,
    contextUsagePercent: 31,
  },
  autoCompactTokens: 750_000,
  threadTotalActiveMs: 720_000,
  compactionCount: 2,
  threadSessionCount: 3,
  mergeStats: { totalLinesAdded: 120, totalLinesDeleted: 30 },
  issueUrl: 'https://x/PROJ-1',
  issueShortRef: 'PROJ-1',
  issueLabel: 'PROJ-1',
  issueTitle: 'Dashboard surfaces',
  prUrl: 'https://x/pr/12',
  prShortRef: 'PR #12',
  prLabel: 'PR #12',
  prTitle: 'Split the surfaces',
  slackThreadUrl: 'https://slack/x',
  tasks: [
    { id: 'T1', content: 'Plan', status: 'completed', toolCalls: 2, startedAt: T0, completedAt: T0 + 60_000 },
    { id: 'T2', content: 'Build', status: 'in_progress', toolCalls: 5, startedAt: T0 + 60_000 },
    { id: 'T3', content: 'Ship', status: 'pending' },
  ],
  agents: AGENTS,
  agentsTotal: 3,
  artifacts: { count: 6, recent: [] },
  goal: {
    current: {
      goalId: 'g1',
      objective: 'Split the three surfaces',
      status: 'active',
      continuationCount: 2,
      maxContinuations: 10,
    },
    queue: [{ goalId: 'g2', objective: 'Deploy to dev' }],
    completedCount: 1,
    history: [{ goalId: 'g0', objective: 'Recursive tree', completedAt: T0 - 1000, completedVia: 'eval-model' }],
  },
  ...over,
});

const BASE = ['esc', 'escAttr', 'escJs', 'toNum', 'formatDuration'];
// The session's agent tree as @2lab.ai/ui <ui-agent-tree> takes it (affectUI review batch 2).
const TREE_FNS = [
  ...BASE,
  'agentStatusOf',
  'agentName',
  'agentActivity',
  'pendingAutoResume',
  'rootStatusOf',
  'agentNodeOf',
  'agentTreeOf',
  'agentNodeName',
  'cardTotalTokens',
  'spendTotal',
  'atIdOf',
  'atRootReason',
  'atNode',
  'atTreeData',
  'cardCurrentTask',
  'cardTaskRow',
  'atCardData',
];
const TREE_VARS = [
  'AGENT_STATUS_LABEL',
  'AGENT_STATUS_TONE',
  'AGENT_STATUS_GLYPH',
  'AT_ROOT',
  'AT_STATUS',
  'AT_ROOT_STATUS',
  '_anOpen',
];
type TreeNode = Record<string, unknown> & { id: string; status: string };
type TreeData = { nodes: TreeNode[]; density: string; title: string; expanded: string[] };

// ── 1. The agent tree at the density of its surface ──
describe('one tree element, two densities — compact on the card, rich in the panel', () => {
  // One load for the suite (cooking the client is the slow part); the header config is mutable.
  const header: { show: Record<string, boolean> } = { show: {} };
  const treeUi = load<{
    atCardData(s: unknown, col: string): TreeData | null;
    atTreeData(anchor: unknown, o: Record<string, unknown>): TreeData;
    agentTreeOf(s: unknown, col: string): unknown;
  }>(TREE_FNS, TREE_VARS, { formatTokens: (n: number) => `${n}`, dhShow: (k: string) => !!header.show[k] });
  const tree = (s: Record<string, unknown>, col: string, show: Record<string, boolean> = { tasks: true }) => {
    header.show = show;
    return treeUi.atCardData(s, col) as TreeData;
  };
  const nodeOf = (d: TreeData, id: string) => d.nodes.find((n) => n.id === id) as TreeNode;

  it('the card is compact: a row per agent — name, status word, time, cost; the element draws no waterfall there', () => {
    const d = tree(card(), 'working');
    expect(d.density).toBe('compact');
    expect(d.title).toBe('에이전트');
    // The data a compact row reads (library: 'compact: rows with status words; the line only on live / failed ones').
    expect(nodeOf(d, 'toolu_lib')).toMatchObject({
      name: 'A2 librarian',
      status: 'done',
      startedAt: T0 + 5_000,
      endedAt: T0 + 247_000,
    });
    expect(TEMPLATE).toContain('.ag-tree > ui-agent-tree { max-height: 420px; overflow-y: auto;');
  });

  it('a live node says what it is doing; a failed node carries what it last reported as its reason', () => {
    const d = tree(card({ agents: [AGENTS[0], { ...AGENTS[1], summary: 'frames were empty' }, AGENTS[2]] }), 'working');
    expect(nodeOf(d, 'toolu_explore').summary).toBe('#T1 Reading the mapper');
    expect(nodeOf(d, 'toolu_nested')).toMatchObject({
      status: 'failed',
      reason: 'frames were empty',
      role: 'Check nested spawn frames',
    });
  });

  it("the root's activity line is dropped only while the face's task row shows it", () => {
    expect(nodeOf(tree(card(), 'working'), ':main')).not.toHaveProperty('summary');
    // No task in progress: the face has no task row, so the root says what it last did.
    const noTask = tree(card({ tasks: [{ id: 'T1', content: 'Plan', status: 'completed' }] }), 'working');
    expect(nodeOf(noTask, ':main').summary).toBe('마지막 도구 Edit');
    // The header hides the task row: the root keeps its line.
    expect(nodeOf(tree(card(), 'working', {}), ':main').summary).toBe('#T2 Build');
  });

  it('a wide fan-out stays a card: every child is a node, the frame scrolls (no in-card cap, no 전체 N개 → 상세)', () => {
    const kids = Array.from({ length: 9 }, (_, i) => ({
      id: `k${i}`,
      n: 10 + i,
      status: 'completed',
      startedAt: T0 + i,
    }));
    const d = tree(card({ agents: kids, agentsTotal: 9 }), 'working');
    expect(d.nodes.filter((n) => /^k\d$/.test(n.id))).toHaveLength(9);
    expect(declarationCount('AGENT_TREE_ROWS')).toBe(0);
  });

  it('the panel tree (the 에이전트 트리 section tab) is rich — a card per agent with its spend, its brief and the waterfall on one axis', () => {
    const root = treeUi.agentTreeOf(card(), 'working');
    const d = treeUi.atTreeData(root, {
      s: card(),
      ns: 'p|k',
      withRoot: true,
      openDepth: 64,
      density: 'rich',
      title: '에이전트 트리',
    });
    expect(d.density).toBe('rich');
    // SSOT 2026-10-26 T2 — its own spend: every token kind it was billed for and the API-equivalent cost.
    expect(nodeOf(d, 'toolu_explore')).toMatchObject({ tokens: 238_000, costUsd: 0.42, toolCalls: 18 });
    expect(nodeOf(d, 'toolu_explore').role).toBe('배경 · Trace subagent frames');
    // The waterfall needs every node's start (and end, when it ended) — the element puts them on one axis
    // (library: 'rich: cards with pill, summary, reason on needs_you / failed, branch cost, time and the waterfall').
    expect(nodeOf(d, 'toolu_nested')).toMatchObject({ startedAt: T0 + 10_000, endedAt: T0 + 51_000 });
    // SSOT 2026-10-29: the tree is its own section tab (paintTreeTab), no longer under the agent's header.
    expect(clientFn('paintTreeTab')).toContain("density: 'rich', title: '에이전트 트리'");
    expect(clientFn('renderPanelAgents')).not.toContain('atTreeData(');
  });
});

// ── 2. The expanded body: settle it here, keyed on the card's state ──
describe('expanded body — face + delta, sections keyed on state', () => {
  const STUBS: Record<string, unknown> = {
    dhShow: () => true,
    formatTokens: (n: number) => `${n}`,
    formatNmSSs: () => '0',
    safeHref: (u: string) => u,
    getEnvBadgeColor: () => '#000',
    _envCount: () => 1,
    isSiblingSession: () => false,
    renderCardIo: () => '[IO]',
    renderCardArtifacts: () => '[ARTS]',
    renderAgentTree: () => '[AGENTS]',
    renderTimeline: () => '[TASKS]',
    // affectUI batch 1: the prompts and the single-choice question are <ui-approval-card> slots.
    acPermissionsHtml: () => '',
    acGoalDecisionHtml: () => '',
    acQuestionHtml: () => '[Q]',
    renderMultiChoiceCard: () => '[MC]',
    renderModelNote: () => '',
    renderModelPicker: () => '[MODEL]',
    renderEffortPicker: () => '[EFFORT]',
    cardTotalTokens: () => 9_591_000,
    effortLabel: (e: string) => e,
    currentUserId: 'U1',
    SELF_INSTANCE_NAME: '',
    READ_ONLY_MSG: 'read only',
    _goalErrors: {},
  };
  const body = (s: Record<string, unknown>, col: string, inject: Record<string, unknown> = {}) =>
    load<{ renderCardBody(s: unknown, col: string): string }>(
      [
        'esc',
        'escAttr',
        'escJs',
        'toNum',
        'formatTaskTime',
        'pendingAutoResume',
        'autoResumeLabel',
        'cardSummary',
        'cardCurrentTask',
        'renderCardResume',
        'isBusy',
        'sessionActionsOf',
        'sessionActionHtml',
        'cardGoalLine',
        'renderCardBody',
      ],
      ['RESUME_SVG', 'GOAL_STATUS_LABELS', 'GOAL_STATUS_TONE', 'GOAL_SVG', 'SESSION_ACTION_TONE', '_busy'],
      { ...STUBS, ...inject },
    ).renderCardBody(s, col);

  it('never repeats the face: no tokens, cost, context bar, thread timers, merge, owner/workflow/last-activity meta, subtitles', () => {
    const html = body(card(), 'working');
    for (const gone of [
      'card-tokens',
      'class="cost"',
      'context-bar',
      'card-timer-total',
      'card-timer-compactions',
      'card-timer-sessions',
      'card-merge',
      'class="card-meta"',
      'meta-owner',
      'rel-time',
      'card-subtitle',
      '대화 기록',
    ]) {
      expect(html, gone).not.toContain(gone);
    }
  });

  it('running: tasks window → agents → latest exchange → goal line → refs → footer; no artifacts (the face chips suffice)', () => {
    const html = body(card(), 'working');
    const order = [
      '[TASKS]',
      '[AGENTS]',
      '[IO]',
      'class="card-goal-line"',
      'class="card-refs"',
      'class="card-foot-bar"',
    ].map((m) => html.indexOf(m));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).not.toContain('[ARTS]');
    expect(html).toContain('data-action="stop"');
  });

  it('needs you: the ask first, then the latest exchange and the evidence (artifacts), then the work', () => {
    const q = { type: 'user_choice', question: 'Ship it?', choices: [{ id: '1', label: 'Yes' }] };
    const html = body(card({ activityState: 'waiting', pendingQuestion: q }), 'waiting');
    const order = ['[Q]', '[IO]', '[ARTS]', '[TASKS]', '[AGENTS]'].map((m) => html.indexOf(m));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('data-action="close"');
  });

  it('a permission prompt heads the body whatever the column; an armed resume heads a running card', () => {
    const perm = body(card(), 'working', { acPermissionsHtml: () => '[PERM]' });
    expect(perm.indexOf('[PERM]')).toBeGreaterThanOrEqual(0);
    expect(perm.indexOf('[PERM]')).toBeLessThan(perm.indexOf('[TASKS]'));
    const resume = body(
      card({
        activityState: 'idle',
        autoResume: { kind: 'error-retry', at: T0, attempt: 1, maxAttempts: 3, reason: '429' },
      }),
      'working',
    );
    expect(resume.indexOf('class="card-resume"')).toBeLessThan(resume.indexOf('[TASKS]'));
    expect(resume).toContain('data-action="close"');
    expect(resume).not.toContain('data-action="stop"');
  });

  it('done (idle / closed): the outcome — latest exchange, artifacts, agents, goal — no task window', () => {
    for (const col of ['idle', 'closed']) {
      const html = body(card({ activityState: 'idle' }), col);
      expect(html, col).not.toContain('[TASKS]');
      const order = ['[IO]', '[ARTS]', '[AGENTS]', 'class="card-goal-line"'].map((m) => html.indexOf(m));
      expect(
        order.every((i) => i >= 0),
        col,
      ).toBe(true);
      expect(
        [...order].sort((a, b) => a - b),
        col,
      ).toEqual(order);
    }
  });

  // SSOT 2026-10-29 T1: the session's actions (Stop · Close · Trash) and Slack moved from the
  // foot to the first row under the face — one reach from the click that opened the card,
  // never under a long body. The foot keeps the model · effort switch alone. T2: no 작업 로그.
  it('the actions bar is the first row — the state action and Slack; the foot is the model · effort switch alone (SSOT 2026-10-29 T1)', () => {
    const html = body(card(), 'working');
    expect(html.startsWith('<div class="card-body"><div class="card-actions-bar"><span class="card-actions">')).toBe(
      true,
    );
    const bar = html.slice(0, html.indexOf('</span></div>') + '</span></div>'.length);
    expect(bar).toContain('data-action="stop"');
    expect(bar).toContain('href="https://slack/x"');
    // The bar is above the work: the task window, the agents, the latest exchange.
    expect(html.indexOf('data-action="stop"')).toBeLessThan(html.indexOf('[TASKS]'));
    expect(html).not.toContain('작업 로그</button>');
    const foot = html.slice(html.indexOf('class="card-foot-bar"'));
    expect(foot).toBe('class="card-foot-bar"><span class="cfb-model">[MODEL]</span></div></div>');
    // The owner's one trigger carries the level and opens the model · effort menu
    // (.prd/affectui/re-model-picker.md D1); a reader gets the level as text.
    expect(foot).not.toContain('[EFFORT]');
    const read = body(card(), 'working', { currentUserId: 'U2' });
    expect(read.slice(read.indexOf('class="card-foot-bar"'))).toContain('[MODEL][EFFORT]');
    // A reader's state action is in the bar too (disabled, read-only), never in the foot.
    expect(read.slice(read.indexOf('class="card-foot-bar"'))).not.toContain('data-action="stop"');
    // The switch is not the body's first line.
    expect(html.indexOf('[MODEL]')).toBeGreaterThan(html.indexOf('[IO]'));
  });

  it('no model to show: no foot bar at all — the pending note alone follows (SSOT 2026-10-29 T1)', () => {
    // A reader with the model field hidden (ui.dashboardheader) and no effort gets no switch.
    const html = body(card({ effort: undefined }), 'working', {
      currentUserId: 'U2',
      dhShow: (f: string) => f !== 'model',
      renderModelNote: () => '[NOTE]',
    });
    expect(html).not.toContain('card-foot-bar');
    expect(html.endsWith('[NOTE]</div>')).toBe(true);
    // The actions bar is still first.
    expect(html.startsWith('<div class="card-body"><div class="card-actions-bar">')).toBe(true);
  });

  it("refs are the short ids only — the titled links are the panel's", () => {
    const html = body(card(), 'working');
    const refs = html.slice(
      html.indexOf('class="card-refs"'),
      html.indexOf('</div>', html.indexOf('class="card-refs"')),
    );
    expect(refs).toContain('>PROJ-1</a>');
    expect(refs).toContain('>PR #12</a>');
    // The issue title is a tooltip at most — never the link's text.
    expect(refs).not.toContain('>Dashboard surfaces');
  });

  it('the goal is one line that points at its home in the panel — the editor is not on the card', () => {
    const html = body(card(), 'working');
    expect(html).not.toContain('cg-add');
    const line = html.slice(html.indexOf('class="card-goal-line"'));
    expect(line).toContain('Split the three surfaces');
    expect(line).toContain('진행 중');
    expect(line).toContain('2/10');
    expect(line).toContain('대기 1');
    expect(line).toContain("openPanel('inst::C1:t1','goal',");
    expect(line).toContain('관리 &rarr;');
    // No goal yet: the owner of a live session gets the way to add one.
    const none = body(card({ goal: undefined }), 'working');
    expect(none).toContain('goal 추가 &rarr;');
    // A reader who cannot edit sees the line and 보기, never 관리.
    const ro = body(card({ ownerId: 'U9' }), 'working');
    expect(ro).toContain('보기 &rarr;');
    expect(ro).not.toContain('관리 &rarr;');
  });
});

describe('task window on the card — the full ledger is the panel', () => {
  const tl = (s: Record<string, unknown>) =>
    load<{ renderTimeline(s: unknown): string }>(
      [
        'esc',
        'escAttr',
        'escJs',
        'toNum',
        'formatDuration',
        'taskFateOf',
        'renderTaskMeta',
        'renderTimelineItem',
        'renderTimeline',
      ],
      ['TASK_FATE_LABEL'],
      {
        dhShow: () => true,
        dhMax: (_k: string, d: number) => d,
      },
    ).renderTimeline(s);

  it('shows the window and opens the panel Tasks for everything else (earlier lists included)', () => {
    const tasks = Array.from({ length: 9 }, (_, i) => ({
      id: `T${i + 1}`,
      content: `t${i + 1}`,
      status: i < 6 ? 'completed' : i === 6 ? 'in_progress' : 'pending',
    }));
    const html = tl({
      key: 'k1',
      tasks,
      earlierTasks: [
        { id: 'T0', content: 'old', status: 'completed' },
        // Task view T2: a step a new plan dropped before it ran was never work — not counted.
        { id: 'Tx', content: 'never ran', status: 'pending', dropped: 'unstarted' },
      ],
    });
    expect(html.match(/class="tl-item/g)).toHaveLength(5);
    expect(html).toContain("openPanel('k1','tasks',");
    expect(html).toContain('전체 task 10개 &rarr;');
    expect(html).not.toContain('toggleCardTasks');
    expect(html).not.toContain('tl-earlier');
    // Only skipped earlier steps and no current list: nothing to open.
    expect(tl({ key: 'k1', tasks: [], earlierTasks: [{ id: 'Tx', content: 'x', dropped: 'unstarted' }] })).toBe('');
  });
});

// ── 3. The panel: understand and steer ──
// D3 E-08: the head is <ui-status-bar>; the page hands it data (panelHeadData) and an armed
// resume as a note in its slot (panelHeadNoteHtml), and answers its ui-action (onPanelHeadAction).
type BarData = {
  status: string;
  words: Record<string, string>;
  startedAt?: number;
  activeMs?: number;
  link?: { id: string; href: string; label: string };
  actions: Array<{
    id: string;
    label: string;
    tone?: string;
    icon?: string;
    disabled?: string | boolean;
    busy?: boolean;
  }>;
};
describe('panel header — <ui-status-bar>: the session status, its time and its actions', () => {
  const page = (inject: Record<string, unknown> = {}) =>
    load<{ panelHeadData(s: unknown, col: string): BarData; panelHeadNoteHtml(s: unknown, col: string): string }>(
      [
        'esc',
        'escAttr',
        'escJs',
        'toNum',
        'formatTaskTime',
        'pendingAutoResume',
        'autoResumeLabel',
        'rootStatusOf',
        'isBusy',
        'sessionActionsOf',
        'panelHeadData',
        'panelHeadNoteHtml',
      ],
      ['AGENT_STATUS_LABEL', 'PS_BAR_STATUS'],
      {
        currentUserId: 'U1',
        SELF_INSTANCE_NAME: '',
        READ_ONLY_MSG: 'read only',
        _busy: Object.create(null),
        ...inject,
      },
    );
  const head = (s: Record<string, unknown>, col: string, inject: Record<string, unknown> = {}) =>
    page(inject).panelHeadData(s, col);

  it('a running session: 실행 중, this turn’s start (the bar ticks its elapsed time), Slack, and Stop (two presses)', () => {
    const d = head(card(), 'working');
    expect(d.status).toBe('running');
    expect(d.words.running).toBe('실행 중');
    // re-agent-run D18: the head times this turn from its start; the session's Σ active time is in 세부 (D19).
    expect(d.startedAt).toBe(T0);
    expect(d.activeMs).toBeUndefined();
    expect(d.link).toEqual({ id: 'slack', href: 'https://slack/x', label: 'Slack' });
    const stop = d.actions.find((a) => a.id === 'stop');
    expect(stop).toMatchObject({ label: 'Stop', tone: 'danger', icon: 'stop' });
    expect(stop?.disabled).toBeUndefined();
    expect(d.actions.map((a) => a.id)).toEqual(['star', 'stop']);
  });

  it('not running: the session’s total active time instead of a clock', () => {
    const d = head(card({ activityState: 'idle' }), 'idle');
    expect(d.startedAt).toBeUndefined();
    expect(d.activeMs).toBe(65_000);
  });

  it('idle → Close, archived → Trash, sleeping → Close; the words follow the root vocabulary', () => {
    const idle = head(card({ activityState: 'idle' }), 'idle');
    expect(idle.status).toBe('idle');
    expect(idle.words.idle).toBe('대기');
    expect(idle.actions.map((a) => a.id)).toEqual(['star', 'close']);
    expect(idle.actions[1].tone).toBeUndefined();
    const archived = head(card({ activityState: 'idle', terminated: true }), 'closed');
    expect(archived.actions.map((a) => a.id)).toEqual(['star', 'revive', 'trash']);
    expect(archived.words.idle).toBe('보관');
    const sleeping = head(card({ activityState: 'idle' }), 'closed');
    expect(sleeping.words.idle).toBe('휴면');
    expect(sleeping.actions.map((a) => a.id)).toEqual(['star', 'revive', 'close']);
  });

  it('an armed resume reads 재개 대기 and says when, which attempt and why in the bar’s slot', () => {
    const s = card({
      activityState: 'idle',
      autoResume: { kind: 'error-retry', at: T0, attempt: 2, maxAttempts: 3, reason: '429 rate limit' },
    });
    const m = page();
    const d = m.panelHeadData(s, 'working');
    expect(d.status).toBe('waiting');
    expect(d.words.waiting).toBe('재개 대기');
    expect(d.startedAt).toBeUndefined();
    expect(d.actions.map((a) => a.id)).toEqual(['star', 'close']);
    const note = m.panelHeadNoteHtml(s, 'working');
    expect(note).toContain('class="ps-resume" title="429 rate limit"');
    expect(note).toContain('자동 재개 · 시도 2/3');
    expect(m.panelHeadNoteHtml(card(), 'working')).toBe('');
  });

  it('a reader who does not own it, or a sibling instance, gets a locked action that says why', () => {
    const ro = head(card({ ownerId: 'U9' }), 'working');
    for (const a of ro.actions) expect(a.disabled, a.id).toBe('read only');
    const sib = head(card({ environment: { instanceName: 'other', host: 'h', port: 1 } }), 'working', {
      SELF_INSTANCE_NAME: 'me',
    });
    expect(sib.actions).toHaveLength(1);
    expect(sib.actions[0].label).toBe('Stop \u2192 other');
    expect(sib.actions[0].disabled).toBe('Open other (h:1) to act on this session');
    expect(sib.actions[0].tone).toBeUndefined();
  });

  it('a write in flight is busy in the bar (Stop / Close / Trash; Star and 살리기 together)', () => {
    const d = head(card(), 'working', { _busy: { 'inst::C1:t1|action': true, 'inst::C1:t1|life': true } });
    for (const a of d.actions) expect(a.busy, a.id).toBe(true);
  });

  it('the page wires the bar: one listener, the session it was drawn for, the Slack link left to the browser', () => {
    const src = clientFn('renderPanelHead');
    expect(src).toContain("el.addEventListener('ui-action', onPanelHeadAction)");
    expect(src).toContain('el._key = key;');
    // Equal data is not handed again: an armed Stop and its pending busy survive live repaints.
    expect(src).toContain('if (el._sig === sig) return;');
    const on = clientFn('onPanelHeadAction');
    expect(on).toContain("id === 'slack'");
    expect(on).toContain('doStar(key, s.starred !== true)');
    expect(on).toContain('doRevive(key)');
    expect(on).toContain('doAction(key, id)');
    expect(PAGE).toContain('<ui-status-bar class="panel-status" id="panel-status" lang="ko"></ui-status-bar>');
    expect(TEMPLATE).toContain('<script type="module" src="/dashboard/ui/status-bar.js?v=');
    expect(TEMPLATE).not.toMatch(/\.ps-(row|chip|label|word|time|clock|dot|actions|slack) /);
    expect(TEMPLATE).not.toMatch(/\.panel-status:empty/);
  });
});

describe('세션 정보 — the complete numbers, live, behind one summary line', () => {
  const info = (s: Record<string, unknown>, open: boolean) =>
    load<{ panelInfoHtml(s: unknown, open: boolean): string }>(
      // cwSlotHtml: the context block (<ui-context-window>) at the top of the open body (re-context-window D5) — empty without contextParts.
      // panelDetailsHtml: 세부 right after it (re-agent-run D19).
      [
        'esc',
        'escAttr',
        'toNum',
        'ctxLevel',
        'ctxPercent',
        'cwSlotHtml',
        'pendingAutoResume',
        'rootStatusOf',
        'panelDetailsHtml',
        'panelInfoHtml',
      ],
      ['PI_CHEV_SVG', '_cw'],
      {
        formatTokens: (n: number) => `${n}`,
        formatNmSSs: (n: number) => `${n}ms`,
        cardTotalTokens: () => 9_591_000,
        safeHref: (u: string) => u,
      },
    ).panelInfoHtml(s, open);

  it('collapsed: owner · workflow · tokens · cost · context · last activity (live), and the links stay in view', () => {
    const html = info(card(), false);
    expect(html).toContain('aria-expanded="false"');
    const sum = html.slice(html.indexOf('class="pi-sum"'), html.indexOf('</button>'));
    for (const want of ['Zhuge', 'zwork', '9591000 tok', '$12.40', 'ctx 31%', 'class="rel-time"'])
      expect(sum, want).toContain(want);
    expect(html).toContain('PROJ-1 &mdash; Dashboard surfaces');
    expect(html).toContain('PR #12 &mdash; Split the surfaces');
    expect(html).toContain('href="/conversations/conv-1"');
    expect(html).not.toContain('class="pi-body"');
  });

  // re-context-window D5/D17/D18: the 4px bar and its "autocompact" line gave way to the context block
  // (dashboard-affectui-context-window-client.test.ts); the token rows say they are session totals.
  it('open: every token kind (cumulative), cost, Σ · compactions · sessions, merge — no old context bar', () => {
    const html = info(card(), true);
    expect(html).toContain('aria-expanded="true"');
    const b = html.slice(html.indexOf('class="pi-body"'));
    for (const want of [
      '입력',
      '1200000',
      '출력',
      '91000',
      '캐시 읽기',
      '8000000',
      '캐시 쓰기',
      '300000',
      '$12.40',
      '누적 입력',
      '720000ms',
      '압축 2',
      '세션 3',
      '+120 / -30',
    ]) {
      expect(b, want).toContain(want);
    }
    expect(b).not.toContain('context-bar');
  });
});

describe('panel goal — the full editor moved here, its draft safe across live updates', () => {
  it('renders the shared goal component (current, queue, history, add) into #panel-goal with the card gates', () => {
    const src = clientFn('renderPanelGoal');
    expect(src).toContain("document.getElementById('panel-goal')");
    expect(src).toContain('renderCardGoal(s, col, canEdit, _panelGoalOpen)');
    expect(src).toContain('isEditingGoal(el)');
    expect(src).toContain('captureGoalDraft(el)');
    expect(src).toContain('restoreGoalDraft(el, draft)');
    expect(src).toMatch(/canEdit = isOwner && !isSiblingSession\(s\)/);
  });

  it('goal writes re-render the panel goal (not only the card) and read the live form from it', () => {
    expect(clientFn('setGoalError')).toContain('renderPanelGoal()');
    // The 완료된 goal toggle lives in the panel now: it must repaint the panel's goal.
    expect(clientFn('toggleGoalHistory')).toContain('renderPanelGoal()');
    // After the await, only this session's form — never another session's draft.
    expect(clientFn('addGoalFromCard')).toContain(
      "panelSessionKey === key ? document.getElementById('panel-goal') : null",
    );
    expect(clientFn('addGoalFromCard')).toContain("document.getElementById('panel-goal')");
    expect(clientFn('goalInputBlur')).toContain('renderPanelGoal()');
  });
});

describe('one live path for the whole panel', () => {
  it('repaintPanelSession writes the head, 세션 정보, goal, controls and the node scope', () => {
    const src = clientFn('repaintPanelSession');
    for (const call of [
      'renderPanelHead();',
      'renderPanelInfo();',
      'renderPanelGoal();',
      'renderPanelControls(',
      'repaintPanelScope();',
    ]) {
      expect(src, call).toContain(call);
    }
  });

  it('every update path calls it: session_update, sessionUpdated, the poll; openPanel too (no one-off innerHTML)', () => {
    const ws = clientFn('connectWs');
    expect(ws.match(/repaintPanelSession\(\);/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(clientFn('loadSessions')).toContain('repaintPanelSession();');
    const open = clientFn('openPanel');
    expect(open).toContain('repaintPanelSession();');
    expect(open).not.toContain("getElementById('panel-meta')");
    expect(open).not.toContain("getElementById('panel-tokens')");
  });

  it('the composer is never inside a morph root; the pickers have their own container beside it', () => {
    // Batch 2: the composer is <ui-agent-steering id="cmd-steer"> — it patches its own field in place
    // (library: agent-steering.test.ts "a host update never re-creates the field (IME composition and
    // caret survive)"); the page only sets its data, never morphs around it.
    const cmd = PAGE.slice(PAGE.indexOf('<div class="panel-command" id="panel-command">'));
    expect(cmd.indexOf('id="panel-controls"')).toBeGreaterThan(0);
    expect(cmd.indexOf('id="panel-controls"')).toBeLessThan(
      cmd.indexOf('<ui-agent-steering id="cmd-steer" lang="ko">'),
    );
    const controls = cmd.slice(
      cmd.indexOf('id="panel-controls"'),
      cmd.indexOf('</div>', cmd.indexOf('id="panel-controls"')),
    );
    expect(controls).not.toContain('cmd-steer');
    expect(PAGE).not.toContain('id="cmd-input"');
    expect(clientFn('renderPanelComposer')).not.toMatch(/morphInnerHtml|innerHTML/);
  });

  it('the page: chip in the header; 세션 정보 → goal → permission → question → agents → section tabs (트리 · 작업 로그 · 지시와 답변) in the scroll area', () => {
    const header = PAGE.slice(PAGE.indexOf('<div class="panel-header">'), PAGE.indexOf('<div class="panel-body"'));
    expect(header).toContain('id="panel-status"');
    const scroll = PAGE.slice(PAGE.indexOf('<div class="panel-scroll" id="panel-scroll">'));
    const ids = [
      'panel-info',
      'panel-goal',
      'panel-permission',
      'panel-question',
      'panel-agents',
      'panel-sections',
      'psec-tree',
      'psec-log',
      'worklog-list',
      'psec-conv',
      'panel-conv',
    ];
    const at = ids.map((id) => scroll.indexOf(`id="${id}"`));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    for (const gone of ['id="panel-meta"', 'id="panel-links"', 'id="panel-tokens"']) expect(PAGE).not.toContain(gone);
  });
});

describe('landing follows the opening intent (executed)', () => {
  type Rect = { top: number; bottom: number; height: number };
  /** A scroll area at y=100, 400px tall, and the sections inside it at fixed content offsets. */
  function rig(
    intent: string,
    opts: { question?: boolean; tasksHidden?: boolean; tabs?: number; detail?: boolean } = {},
  ) {
    const offsets: Record<string, number> = {
      'panel-info': 0,
      'panel-goal': 80,
      'panel-permission': 300,
      'panel-question': 300,
      'panel-agents': 420,
      'panel-tasks': 560,
      'panel-sections': 700,
    };
    const scroll = {
      scrollTop: 900,
      scrollHeight: 3000,
      clientHeight: 400,
      calls: [] as number[],
      getBoundingClientRect: (): Rect => ({ top: 100, bottom: 500, height: 400 }),
      scrollTo(o: { top: number }) {
        this.scrollTop = o.top;
        this.calls.push(o.top);
      },
    };
    const section = (id: string, shown = true) => ({
      id,
      style: { display: shown ? '' : 'none' },
      getBoundingClientRect: (): Rect => {
        const top = 100 + offsets[id] - scroll.scrollTop;
        return { top, bottom: top + 60, height: 60 };
      },
    });
    const tasks = section('panel-tasks', !opts.tasksHidden);
    const els: Record<string, unknown> = {
      'panel-scroll': scroll,
      'panel-tasks': tasks,
      'panel-tabs': opts.tabs === undefined ? null : { offsetHeight: opts.tabs },
      'panel-goal': section('panel-goal'),
      'panel-agents': section('panel-agents'),
      'panel-sections': section('panel-sections'),
      // The section box under the tabs: 260px, ending past the 400px view.
      'panel-sections-body': {
        getBoundingClientRect: (): Rect => {
          const top = 100 + 740 - scroll.scrollTop;
          return { top, bottom: top + 260, height: 260 };
        },
      },
      'panel-permission': section('panel-permission', false),
      'panel-question': section('panel-question', !!opts.question),
    };
    const m = load<{ landPanel(): void; state(): { landed: boolean } }>(
      ['psecLandingTop', 'landPanel'],
      ['_panelOnQuestion'],
      { document: { getElementById: (id: string) => els[id] ?? null } },
      [
        `var _panelLand = ${JSON.stringify(intent)}; var _panelLanded = false; var _panelLandAt = null; var _panelScrollGen = 0; var _panelDetail = ${!!opts.detail};`,
        'function state() { return { landed: _panelLanded }; }',
      ],
    );
    return { m, scroll, tasks };
  }

  it('관리 → puts the goal section at the top of the scroll area, once — late turns never drag it', () => {
    const r = rig('goal');
    r.m.landPanel();
    expect(r.scroll.scrollTop).toBe(80);
    expect(r.m.state()).toEqual({ landed: true });
    r.scroll.scrollTop = 40; // the reader scrolls; the turns arrive and land again
    r.m.landPanel();
    expect(r.scroll.scrollTop).toBe(40);
  });

  it('a tree item / 전체 N개 → 상세 puts the agents section at the top', () => {
    const r = rig('agent');
    r.m.landPanel();
    expect(r.scroll.scrollTop).toBe(420);
  });

  it('전체 task → puts the (unfolded) Tasks section at the top of the scroll area, under the sticky agent tabs, once', () => {
    // Task view: Tasks are no longer pinned outside the scroll area — they sit in the
    // focused agent's tab, so a tasks opening lands like 관리 → / 상세 does.
    const r = rig('tasks', { tabs: 40 });
    r.m.landPanel();
    expect(r.scroll.scrollTop).toBe(560 - 40);
    expect(r.scroll.calls).toEqual([520]);
    expect(r.m.state()).toEqual({ landed: true });
    r.scroll.scrollTop = 40; // the reader scrolls; the turns arrive and land again
    r.m.landPanel();
    expect(r.scroll.scrollTop).toBe(40);
    // The reader asked for the plan: a waiting question does not take the landing.
    const ask = rig('tasks', { question: true, tabs: 40 });
    ask.m.landPanel();
    expect(ask.scroll.scrollTop).toBe(520);
    // No Tasks shown: the default landing — a question first, else the section tabs
    // in view (SSOT 2026-10-29: the box does not end in this 400px view, so the tabs
    // come to the top), 자세히 alike — the newest turns are the box's own bottom.
    const none = rig('tasks', { tasksHidden: true });
    none.m.landPanel();
    expect(none.scroll.scrollTop).toBe(700);
    expect(none.m.state()).toEqual({ landed: false });
    const noneDetail = rig('tasks', { tasksHidden: true, detail: true });
    noneDetail.m.landPanel();
    expect(noneDetail.scroll.scrollTop).toBe(700);
    expect(noneDetail.scroll.calls).not.toContain(3000);
    const noneAsk = rig('tasks', { tasksHidden: true, question: true });
    noneAsk.m.landPanel();
    expect(noneAsk.scroll.scrollTop).toBe(300);
  });

  it('true (작업 로그) lands with the section tabs in view (its tab is the one shown) — a waiting question does not take it', () => {
    const r = rig('worklog');
    r.m.landPanel();
    expect(r.scroll.calls).toEqual([700]);
    const ask = rig('worklog', { question: true });
    ask.m.landPanel();
    expect(ask.scroll.calls).toEqual([700]);
  });
});

describe('focus goes back to whatever opened the panel (executed)', () => {
  // The card face is the element's now (its focus is its own: 'Enter and Space toggle the focused card; Esc
  // closes it and returns focus to its face'); an opener that is gone hands focus to the session's open card —
  // its 작업 로그 button in the card's slot body — else the board heading.
  it('Escape / × from inside the panel → the opener; gone or inert → the open card’s 작업 로그, else the heading; focus elsewhere → untouched', () => {
    const run = (o: { inPanel: boolean; present: boolean; inert?: boolean; cardOpen?: boolean }) => {
      const focused: string[] = [];
      const panel = { classList: { remove() {} } };
      // focus() moves document.activeElement, except into an inert (folded) card.
      const el = (name: string, inert = false) => {
        const node: Record<string, unknown> = {
          focus: () => {
            focused.push(name);
            if (!inert) doc.activeElement = node;
          },
          hasAttribute: () => true,
          setAttribute: () => {},
        };
        return node;
      };
      const heading = el('heading');
      const doc: Record<string, unknown> = {
        getElementById: (id: string) => (id === 'slide-panel' || id === 'panel-overlay' ? panel : null),
        querySelector: (sel: string) => (sel === '.board-title, h1, h2' ? heading : null),
      };
      const opener = el('opener', !!o.inert);
      const log = el('worklog');
      const body = {
        isConnected: true,
        querySelector: (sel: string) => (sel === '[data-card-worklog]' ? log : null),
      };
      doc.body = { contains: (n: unknown) => (n === opener ? o.present : true) };
      doc.activeElement = o.inPanel
        ? { closest: (sel: string) => (sel === '#slide-panel' ? panel : null) }
        : { closest: () => null };
      const m = load<{ closePanel(): void; deckNow(): string[] }>(
        // SSOT 2026-10-29 T2: closing the panel takes its session's detail card out of the deck.
        ['deckRemove', 'closePanel'],
        [],
        {
          document: doc,
          // The deck's ‹ n / m › and peeking edges (the deck suite runs renderDeckNav).
          renderDeckNav: () => {},
          layoutBeforeChange: () => {},
          resetWorkLog: () => {},
          _cardBodies: o.cardOpen === false ? {} : { k: { el: body } },
          __ret: opener,
          // Task view: a closing panel releases the composer and the answer observer.
          pcReset: () => {},
          _ansIo: null,
          // SSOT 2026-10-29: a closed panel holds no section nodes and no pill.
          psecClear: () => {},
          psecSetNew: () => {},
        },
        [
          'var panelOpen = true, panelSessionKey = "k", panelConvId = null, _panelAgent = "", _panelAgentsHtml = "", _rawLoadedCache = {}, _panelGen = 0;',
          'var _panelTurnsHasMore = false, _panelTurnsLoading = false, _panelTurnsOldestId = null, _panelLand = "", _panelLanded = false;',
          'var _panelTurnsList = [], _panelTurnsMsg = "", PSEC_ORDER = ["conv", "log", "tree"], _panelHold = false;',
          'var _panelOnQuestion = false, _panelReturnFocus = __ret;',
          'var _deck = ["j", "k"];',
          'function deckNow() { return _deck.slice(); }',
        ],
      );
      m.closePanel();
      expect(m.deckNow()).toEqual(['j']);
      return focused;
    };
    expect(run({ inPanel: true, present: true })).toEqual(['opener']);
    expect(run({ inPanel: true, present: false })).toEqual(['worklog']); // a folded DONE date dropped it
    expect(run({ inPanel: true, present: true, inert: true })).toEqual(['opener', 'worklog']); // inside a folded card
    expect(run({ inPanel: true, present: false, cardOpen: false })).toEqual(['heading']); // the card is closed
    expect(run({ inPanel: false, present: true })).toEqual([]); // the reader already moved on
  });
});

// SSOT 2026-10-29 T2 — the detail deck: an open card always has its detail card beside the
// board. The board card is a <ui-agent-inbox> card: the element owns click / Enter / Escape and
// says so with ui-toggle; wireInbox answers it — opened → openPanel(key) (in front of the deck),
// folded → deckDrop(key) (the next one comes to the front, or the panel closes). ✕ / the overlay
// / Escape close the front detail card by folding its card the way a reader does: a click on its
// face (cardFaceOf, in the element's shadow root). ‹ › go round the deck.
describe('the detail deck — open cards and their detail cards move together (SSOT 2026-10-29 T2)', () => {
  const pure = load<{
    deckNextAfter(deck: string[], key: string): string | null;
  }>(['deckNextAfter'], []);

  it('deckNextAfter (pure): the next card, else the one before; null when it was the last', () => {
    const deck = ['a', 'b', 'c'];
    expect(pure.deckNextAfter(deck, 'a')).toBe('b');
    expect(pure.deckNextAfter(deck, 'b')).toBe('c');
    expect(pure.deckNextAfter(deck, 'c')).toBe('b');
    expect(pure.deckNextAfter(['a'], 'a')).toBeNull();
    // A key that is not in the deck: the newest card; an empty deck: none.
    expect(pure.deckNextAfter(deck, 'x')).toBe('c');
    expect(pure.deckNextAfter([], 'x')).toBeNull();
    expect(deck).toEqual(['a', 'b', 'c']); // it never changes the deck
  });

  // The real wireInbox, cardFaceOf, closeDetailCard and deck functions against a fake board
  // element: its cards are <li class="ib-card" data-card> in a shadow root, each with a face
  // (.ib-face[role="button"]) whose click toggles the card and fires ui-toggle, as the element
  // does. openPanel / closePanel are cut down to their deck and panel-state lines (pinned against
  // the shipped source below).
  type Deck = {
    wireInbox(host: unknown): void;
    onDeckPage(e: unknown): void;
    deckDrop(key: string): void;
    closeDetailCard(): void;
    cardFaceOf(key: string): unknown;
    openPanel(key: string): void;
    state(): { deck: string[]; front: string | null; open: boolean; expanded: string[] };
  };
  const world = (keys = ['A', 'B', 'C']) => {
    const log: string[] = [];
    const nav: number[] = [];
    const clicked: string[] = [];
    const handlers: Record<string, (e: unknown) => void> = {};
    const elOpen = new Set<string>(); // the element's own open state
    const host: Record<string, unknown> = {
      addEventListener: (n: string, fn: (e: unknown) => void) => {
        handlers[n] = fn;
      },
    };
    const toggle = (key: string) => {
      const expanded = !elOpen.has(key);
      if (expanded) elOpen.add(key);
      else elOpen.delete(key);
      handlers['ui-toggle']({ target: host, detail: { cardId: key, expanded } });
    };
    const faceOf = (key: string) => ({
      click: () => {
        clicked.push(key);
        toggle(key);
      },
    });
    const li = (key: string) => ({
      getAttribute: (n: string) => (n === 'data-card' ? key : null),
      querySelector: (sel: string) => (sel === '.ib-face[role="button"]' ? faceOf(key) : null),
    });
    host.shadowRoot = { querySelectorAll: (sel: string) => (sel === 'li.ib-card[data-card]' ? keys.map(li) : []) };
    const cache: Record<string, unknown> = {};
    const cardHost: Record<string, unknown> = {};
    for (const k of keys) {
      cache[k] = { key: k };
      cardHost[k] = host;
    }
    const m = load<Deck>(
      [
        'deckAdd',
        'deckRemove',
        'deckNextAfter',
        'onDeckPage',
        'deckDrop',
        'cardFaceOf',
        'closeDetailCard',
        'wireInbox',
      ],
      ['_deck'],
      {
        log,
        _sessionCache: cache,
        _cardHost: cardHost,
        _doneGroupOpen: {},
        _cardCol: {},
        _cardDrawn: {},
        MOTION: { expand: 240, move: 320 },
        releaseCardIoTimer: () => {},
        syncCardBody: () => {},
        syncCardBodies: () => {},
        ensureCardIo: () => {},
        ensureArtifacts: () => {},
        isSiblingSession: () => false,
        scheduleLayoutRefresh: () => {},
        placeCard: () => {},
        inboxPaint: () => {},
        openArtifactViewer: () => {},
        renderDeckNav: (dir: number) => nav.push(dir),
      },
      [
        'var panelOpen = false, panelSessionKey = null, _expanded = new Set();',
        "function openPanel(k) { if (!_sessionCache[k]) return; log.push('open ' + k); deckAdd(k); panelOpen = true; panelSessionKey = k; }",
        "function closePanel() { log.push('close'); if (panelSessionKey) deckRemove(panelSessionKey); panelOpen = false; panelSessionKey = null; }",
        'function state() { return { deck: _deck.slice(), front: panelSessionKey, open: panelOpen, expanded: Array.from(_expanded) }; }',
      ],
    );
    m.wireInbox(host);
    // <ui-deck-nav>'s ui-page (D3 E-05): the place it moved to, in the deck it was drawn for (renderDeckNav
    // hands it the keys with the data); the element steps and wraps round itself (its wrap attribute).
    const page = (index: number, keys = m.state().deck) =>
      m.onDeckPage({ currentTarget: { _keys: keys }, detail: { index, from: 0 } });
    return { m, log, nav, clicked, toggle, cache, cardHost, host, page };
  };

  it('ui-toggle: opening a card opens its detail card in front; the deck keeps the opening order', () => {
    const w = world();
    w.toggle('A');
    expect(w.m.state()).toEqual({ deck: ['A'], front: 'A', open: true, expanded: ['A'] });
    w.toggle('B');
    expect(w.m.state()).toEqual({ deck: ['A', 'B'], front: 'B', open: true, expanded: ['A', 'B'] });
    expect(w.log).toEqual(['open A', 'open B']);
  });

  it('ui-toggle: folding the front card brings the next detail card forward; the last one closes the panel', () => {
    const w = world();
    w.toggle('A');
    w.toggle('B');
    w.toggle('B'); // B folds: A comes back to the front
    expect(w.m.state()).toEqual({ deck: ['A'], front: 'A', open: true, expanded: ['A'] });
    w.toggle('A'); // the last one: the panel closes
    expect(w.m.state()).toEqual({ deck: [], front: null, open: false, expanded: [] });
    expect(w.log).toEqual(['open A', 'open B', 'open A', 'close']);
  });

  it('a click on an open card whose detail card waits behind another folds it — no bring-to-front; the front one stays', () => {
    const w = world();
    w.toggle('A');
    w.toggle('B'); // B in front, A's detail card behind it
    w.toggle('A'); // the element folds A: its detail card only leaves the deck
    expect(w.m.state()).toEqual({ deck: ['B'], front: 'B', open: true, expanded: ['B'] });
    expect(w.log).toEqual(['open A', 'open B']);
    expect(w.nav).toEqual([0]); // the deck's ‹ n / m › repaint
  });

  it('closeDetailCard (✕ / overlay / Escape): clicks the front card’s face (cardFaceOf) — the element folds it, the next detail card comes forward', () => {
    const w = world();
    w.toggle('A');
    w.toggle('B');
    w.m.closeDetailCard();
    expect(w.clicked).toEqual(['B']); // folded the way a reader does, on the element
    expect(w.m.state()).toEqual({ deck: ['A'], front: 'A', open: true, expanded: ['A'] });
    w.m.closeDetailCard();
    expect(w.clicked).toEqual(['B', 'A']);
    expect(w.m.state()).toEqual({ deck: [], front: null, open: false, expanded: [] });
    // The fold's own ui-toggle already dropped it: the panel closed once, nothing dropped twice.
    expect(w.log).toEqual(['open A', 'open B', 'open A', 'close']);
  });

  it('closeDetailCard on a detail card whose card is folded (an agent link, the cron drawer) or not on any element: it just leaves the deck', () => {
    const w = world();
    w.toggle('A');
    w.m.openPanel('C'); // opened from elsewhere — its card stays folded
    expect(w.m.state()).toEqual({ deck: ['A', 'C'], front: 'C', open: true, expanded: ['A'] });
    w.m.closeDetailCard();
    expect(w.clicked).toEqual([]); // no card to fold
    expect(w.m.state()).toEqual({ deck: ['A'], front: 'A', open: true, expanded: ['A'] });
    // Open, but its element is gone (moved, not drawn yet): no face to click — the detail card still leaves.
    delete w.cardHost.A;
    w.m.closeDetailCard();
    expect(w.clicked).toEqual([]);
    expect(w.m.state()).toMatchObject({ deck: [], front: null, open: false });
    // Nothing in front: closeDetailCard is closePanel.
    const e = world();
    e.m.closeDetailCard();
    expect(e.log).toEqual(['close']);
  });

  it('cardFaceOf: the face of that key’s card in its element’s shadow root; null without an element, a shadow root or the card', () => {
    const w = world();
    expect(w.m.cardFaceOf('B')).toMatchObject({ click: expect.any(Function) });
    (w.m.cardFaceOf('B') as { click(): void }).click();
    expect(w.clicked).toEqual(['B']);
    expect(w.m.cardFaceOf('X')).toBeNull(); // no element holds it
    w.cardHost.X = w.host; // an element that does not draw it
    expect(w.m.cardFaceOf('X')).toBeNull();
    w.cardHost.Y = {}; // not upgraded yet: no shadow root
    expect(w.m.cardFaceOf('Y')).toBeNull();
  });

  it('deckDrop: a session gone from the board since it joined the deck is never the next front card', () => {
    const w = world();
    w.toggle('A');
    w.toggle('B');
    w.toggle('C');
    w.page(1); // B in front, C behind it
    expect(w.m.state().front).toBe('B');
    delete w.cache.C; // C left the board
    w.toggle('B'); // B folds: its next would be C — gone, so A comes forward
    expect(w.m.state()).toMatchObject({ deck: ['A'], front: 'A' });
  });

  it('ui-page: ‹ › (round the end — the element wraps) bring the card at that place in the deck to the front', () => {
    const w = world();
    for (const k of ['A', 'B', 'C']) w.toggle(k);
    expect(w.m.state().front).toBe('C');
    w.page(0); // › from the last: round to the first
    expect(w.m.state().front).toBe('A');
    w.page(2); // ‹ from the first: round to the last
    expect(w.m.state().front).toBe('C');
    w.page(1);
    expect(w.m.state().front).toBe('B');
    // Going round never changes the deck or which cards are open.
    expect(w.m.state()).toMatchObject({ deck: ['A', 'B', 'C'], expanded: ['A', 'B', 'C'] });
    // The front card again, a place past the end, or a session gone since the nav was drawn: nothing opens.
    const opened = w.log.length;
    w.page(1);
    w.page(7);
    delete w.cache.A;
    w.page(0);
    expect(w.log).toHaveLength(opened);
    expect(PAGE).toContain('<ui-deck-nav class="panel-deck" id="panel-deck" lang="ko" wrap hidden></ui-deck-nav>');
    expect(TEMPLATE).toContain('<script type="module" src="/dashboard/ui/deck-nav.js?v=');
  });

  it('the shipped openPanel / closePanel / wireInbox / Escape / cron drawer do their part of the deck', () => {
    const open = clientFn('openPanel');
    // In the deck before anything else of the opening; the nav painted once it is open.
    expect(open).toContain('deckAdd(sessionKey);');
    expect(open.indexOf('deckAdd(sessionKey);')).toBeLessThan(open.indexOf('panelSessionKey = sessionKey;'));
    expect(open).toContain('renderDeckNav(deckDir);');
    expect(open.indexOf('renderDeckNav(deckDir);')).toBeGreaterThan(open.indexOf('panelOpen = true;'));
    const close = clientFn('closePanel');
    expect(close).toContain('if (closingKey) deckRemove(closingKey);');
    expect(close).toContain('renderDeckNav(0);');
    // The element's toggle is the one place a card opens or folds — no bring-to-front there.
    const wire = clientFn('wireInbox');
    expect(wire).toContain('openPanel(key);');
    expect(wire).toContain('deckDrop(key);');
    expect(wire).not.toContain('panelSessionKey');
    // Escape (outside the viewer and the cron drawer) closes the front detail card, folding its card.
    expect(TEMPLATE).toContain(
      // D1 (C-05): <ui-drawer> takes the key (preventDefault) before the page's listener; the panel leaves it be.
      "if (e.key === 'Escape' && !e.defaultPrevented && panelOpen && !artViewerIsOpen() && !_cronDrawerKey) closeDetailCard();",
    );
    // A cron run opens its session's detail card on its default (Chat), not on the 작업 로그.
    expect(TEMPLATE).toContain('closeCronDrawer(function() { openPanel(k); }); }');
    expect(TEMPLATE).not.toContain('closeCronDrawer(); openPanel(k, true);');
  });

  it('renderDeckNav: ‹ n / m › only with two or more; the edges of up to two cards behind; gone sessions leave the deck', () => {
    const els: Record<string, Record<string, unknown>> = {};
    const attrs: Record<string, string> = {};
    // The deck switch is WAAPI (P6), not a keyframe class: each of the header and the body gets an
    // additive translate (so a second switch retargets from where it is drawn) and an opacity fade.
    const slides: Array<{ part: string; frames: Array<Record<string, unknown>>; opts: Record<string, unknown> }> = [];
    const part = (name: string) => ({
      animate: (frames: Array<Record<string, unknown>>, opts: Record<string, unknown>) => {
        slides.push({ part: name, frames, opts });
        return { playState: 'running', cancel: () => {} };
      },
    });
    const parts = [part('header'), part('body')];
    let selector = '';
    els['slide-panel'] = {
      setAttribute: (n: string, v: string) => {
        attrs[n] = v;
      },
      querySelectorAll: (sel: string) => {
        selector = sel;
        return parts;
      },
    };
    const listeners: string[] = [];
    els['panel-deck'] = { addEventListener: (n: string) => listeners.push(n) };
    const rig = (deck: string[], front: string) =>
      load<{ renderDeckNav(dir: number): void; deckNow(): string[] }>(
        ['renderDeckNav', 'onDeckPage', 'deckSlide'],
        ['DECK_SLIDE_MS'],
        {
          document: { getElementById: (id: string) => els[id] ?? null },
          getComputedStyle: () => ({ opacity: '0.6' }),
          reduceMotion: () => false,
          _sessionCache: {
            A: { displayHeadline: 'Alpha' },
            B: { summaryTitle: 'Beta' },
            C: { title: 'Gamma' },
          },
        },
        [
          `var _deck = ${JSON.stringify(deck)}, panelOpen = true, panelSessionKey = ${JSON.stringify(front)};`,
          'function deckNow() { return _deck.slice(); }',
        ],
      );
    const r = rig(['A', 'gone', 'B', 'C'], 'B');
    r.renderDeckNav(1);
    expect(r.deckNow()).toEqual(['A', 'B', 'C']);
    expect(attrs['data-deck']).toBe('2');
    expect(els['panel-deck'].hidden).toBe(false);
    // <ui-deck-nav> draws ‹ 2 / 3 › and titles its buttons 이전: Alpha / 다음: Gamma from these.
    expect(els['panel-deck'].data).toEqual({
      count: 3,
      index: 1,
      titles: ['Alpha', 'Beta', 'Gamma'],
      label: '열린 작업 카드',
    });
    expect(els['panel-deck']._keys).toEqual(['A', 'B', 'C']);
    const handed = els['panel-deck'].data;
    r.renderDeckNav(0);
    expect(els['panel-deck'].data).toBe(handed); // the same deck is not handed again
    expect(listeners).toEqual(['ui-page']); // one listener, however often it paints
    expect(selector).toBe('.panel-header, .panel-body');
    expect(slides.map((x) => x.part)).toEqual(['header', 'header', 'body', 'body']);
    const [move, fade] = slides;
    expect(move.frames).toEqual([{ transform: 'translateX(18px)' }, { transform: 'translateX(0)' }]);
    expect(move.opts).toMatchObject({ duration: 320, composite: 'add', easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
    expect(fade.frames).toEqual([{ opacity: 0.35 }, { opacity: 1 }]);
    // A second switch the other way while the first still runs: it slides from the left, and the
    // fade carries on from the opacity drawn now rather than restarting at 0.35.
    r.renderDeckNav(-1);
    expect(slides[4].frames[0]).toEqual({ transform: 'translateX(-18px)' });
    expect(slides[5].frames).toEqual([{ opacity: 0.6 }, { opacity: 1 }]);
    // One card: no nav, no edges, no slide.
    const one = rig(['A'], 'A');
    one.renderDeckNav(0);
    expect(attrs['data-deck']).toBe('0');
    expect(els['panel-deck'].hidden).toBe(true);
    expect(slides).toHaveLength(8);
    // No keyframe slide left in the CSS.
    expect(TEMPLATE).not.toContain('@keyframes deck-in');
  });
});

describe('a goal add in flight is busy until its form is settled (executed)', () => {
  it('busy while sent; the latch releases only after the sent text left the form — no double send', async () => {
    let release: (v: { ok: boolean; error: string }) => void = () => {};
    const posts: string[] = [];
    const input = {
      value: 'ship it',
      blurred: false,
      blur() {
        this.blurred = true;
      },
      form: null as unknown,
    };
    const btn = { disabled: false };
    const form = { querySelector: (sel: string) => (sel === '.cg-add-input' ? input : btn) };
    input.form = form;
    const host = { querySelector: () => input };
    const m = load<{ addGoalFromCard(k: string, f: unknown): Promise<void>; isBusy(k: string, op: string): boolean }>(
      ['isBusy', 'setBusy', 'addGoalFromCard'],
      ['_busy', '_goalAdding'],
      {
        document: { getElementById: (id: string) => (id === 'panel-goal' ? host : null) },
        postGoalAction: (_k: string, p: { objective: string }) => {
          posts.push(p.objective);
          return new Promise((r) => (release = r));
        },
        setGoalError: () => {},
        loadSessions: () => {},
        panelSessionKey: 'k',
      },
    );
    const sent = m.addGoalFromCard('k', form);
    expect(m.isBusy('k', 'goal')).toBe(true);
    await m.addGoalFromCard('k', form); // a second Enter while the first is in flight
    expect(posts).toEqual(['ship it']);
    release({ ok: true, error: '' });
    await sent;
    expect(input.value).toBe('');
    expect(input.blurred).toBe(true);
    expect(m.isBusy('k', 'goal')).toBe(false);
  });
});

describe('one write in flight per session and operation, whichever surface asks (executed, deferred requests)', () => {
  it('a second model switch while the first is pending is refused; the peer surface shows busy at once; busy clears on settle', async () => {
    // The menu picks by value (re-model-picker D11): nothing to put back on a refusal, the surfaces re-render.
    let release: (v: { ok: boolean; error: string }) => void = () => {};
    const posts: string[] = [];
    const peerRepaints: boolean[] = [];
    const m = load<{ changeModel(k: string, n: string): Promise<void>; isBusy(k: string, op: string): boolean }>(
      ['isBusy', 'setBusy', 'modelSwitchNote', 'changeModel'],
      ['_busy'],
      {
        postModelSwitch: (_k: string, nick: string) => {
          posts.push(nick);
          return new Promise((r) => (release = r));
        },
        _modelNotes: {},
        formatTokens: String,
        refreshCard: () => {},
        repaintPanelControlsFor: () => peerRepaints.push(m.isBusy('k', 'model')),
        loadSessions: () => {},
      },
    );
    const first = m.changeModel('k', 'sonnet');
    expect(peerRepaints).toEqual([true]); // the panel's picker repainted busy before the request settles
    await m.changeModel('k', 'fable'); // the docked panel's menu, while the card's switch is pending
    expect(posts).toEqual(['sonnet']);
    release({ ok: true, error: '' });
    await first;
    expect(m.isBusy('k', 'model')).toBe(false);
  });

  it('a goal add while a goal delete is pending is refused — add and delete share the goal lock', async () => {
    let release: (v: { ok: boolean; error: string }) => void = () => {};
    const posts: string[] = [];
    const input = { value: 'next goal', blur() {}, form: null as unknown };
    const form = { querySelector: (sel: string) => (sel === '.cg-add-input' ? input : { disabled: false }) };
    const m = load<{
      goalAction(k: string, p: unknown, b: unknown): Promise<void>;
      addGoalFromCard(k: string, f: unknown): Promise<void>;
    }>(['isBusy', 'setBusy', 'goalAction', 'addGoalFromCard'], ['_busy', '_goalAdding'], {
      document: { getElementById: () => null },
      postGoalAction: (_k: string, p: { action: string }) => {
        posts.push(p.action);
        return new Promise((r) => (release = r));
      },
      setGoalError: () => {},
      loadSessions: () => {},
      panelSessionKey: 'k',
    });
    const del = m.goalAction('k', { action: 'delete', goalId: 'g1', expect: 'current' }, null);
    await m.addGoalFromCard('k', form);
    expect(posts).toEqual(['delete']);
    release({ ok: true, error: '' });
    await del;
  });
});

describe('a live goal update never rebinds a focused control to another goal (executed)', () => {
  it('each goal row carries its goal id as the morph key; rows of different goals never pair', () => {
    const m = load<{ domKeyOf(n: unknown): string }>(['domKeyOf'], []);
    const el = (attrs: Record<string, string>) => ({
      nodeType: 1,
      tagName: 'LI',
      id: '',
      getAttribute: (a: string) => (a in attrs ? attrs[a] : null),
    });
    expect(m.domKeyOf(el({ 'data-mk': 'queued:q1' }))).not.toBe(m.domKeyOf(el({ 'data-mk': 'queued:q2' })));
    expect(m.domKeyOf(el({ 'data-mk': 'queued:q1' }))).toBe(m.domKeyOf(el({ 'data-mk': 'queued:q1' })));
    const goal = load<{ renderCardGoal(s: unknown, col: string, canEdit: boolean): string }>(
      [
        'esc',
        'escAttr',
        'escJs',
        'toNum',
        'formatTokens',
        'formatDuration',
        'formatGoalTime',
        'renderGoalHistory',
        'isBusy',
        'renderCardGoal',
      ],
      [
        'GOAL_STATUS_LABELS',
        'GOAL_STATUS_TONE',
        'GOAL_SVG',
        'GOAL_VIA_LABELS',
        '_goalHistoryOpen',
        '_goalErrors',
        '_busy',
      ],
    );
    const html = goal.renderCardGoal(card(), 'working', true);
    expect(html).toContain('data-mk="goal:g1"');
    expect(html).toContain('<li data-mk="queued:g2">');
  });
});

describe('focus inside the goal section after its goal left (executed)', () => {
  it("a focused control whose goal left lands focus on the section — never on another goal's control", () => {
    const btn = { id: 'del-q1' };
    let inside = new Set<unknown>([btn]);
    const doc: Record<string, unknown> = { activeElement: btn, body: {} };
    const classes = new Set<string>(['is-empty']);
    const el = {
      style: { display: '' },
      _html: 'old',
      _key: 'k',
      // Task view T1.6: a session without a goal marks the section empty (자세히 shows it).
      classList: { toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)) },
      contains: (n: unknown) => inside.has(n),
      focus: () => {
        doc.activeElement = el;
      },
      querySelector: () => null,
    };
    (doc as { getElementById: (id: string) => unknown }).getElementById = (id: string) =>
      id === 'panel-goal' ? el : null;
    const m = load<{ renderPanelGoal(): void }>(
      ['isEditingGoal', 'captureGoalDraft', 'restoreGoalDraft', 'renderPanelGoal'],
      [],
      {
        document: doc,
        panelSessionKey: 'k',
        _sessionCache: { k: card() },
        sessionColOf: () => 'working',
        currentUserId: 'U1',
        isSiblingSession: () => false,
        renderCardGoal: () => 'new',
        _panelGoalOpen: false, // SSOT 2026-10-29: the objective's fold
        syncGoalMore: () => {},
        morphInnerHtml: () => {
          inside = new Set(); // Q1's row (and its focused Delete) is gone
          doc.activeElement = doc.body;
        },
      },
    );
    m.renderPanelGoal();
    expect(doc.activeElement).toBe(el);
    expect(classes.has('is-empty')).toBe(false); // the session has a current goal
    // A card switch starts the composer clean: a fresh <ui-agent-steering> with a fresh composer (no text, no files).
    expect(clientFn('openPanel')).toMatch(/if \(!sameSession\) \{\s*pcFreshSteer\(\);\s*\/\//);
  });
});

describe('the composer follows the session live (executed)', () => {
  // Batch 2: the composer is <ui-agent-steering>. The page passes the mode as data — canAct (the owner),
  // disabled (the session ended), running — and the element draws the field off with its own words
  // (library: agent-steering.test.ts "read-only (canAct: false): the list shows, no buttons, the field is
  // off", "disabled: the session ended", lang="ko" "uses the dashboard / Slack wording").
  it('a session closed while the panel shows it turns the composer off; an unchanged state writes nothing; a forced pass re-applies', () => {
    const writes: Array<Record<string, unknown>> = [];
    const el: Record<string, unknown> = {};
    Object.defineProperty(el, 'data', {
      get: () => writes[writes.length - 1],
      set: (d: Record<string, unknown>) => writes.push(d),
    });
    const host: Record<string, unknown> = {};
    // D4 E-30: the field, tools and files are the slotted <ui-composer>'s — the steering turns it off with its own
    // field (library: agent-steering.test.ts 'read-only or ended: the composer is off with the steering’s words').
    const els: Record<string, unknown> = { 'panel-command': host, 'cmd-steer': el };
    let resets = 0;
    const m = load<{ renderPanelComposer(s: unknown, force?: boolean): void }>(
      ['renderPanelComposer', 'pcModeOf', 'steeringData'],
      ['STEER_STATE'],
      {
        document: { getElementById: (id: string) => els[id] ?? null },
        currentUserId: 'U1',
        pcReset: () => {
          resets++;
        },
      },
    );
    const last = () => writes[writes.length - 1];
    m.renderPanelComposer({ ownerId: 'U1', activityState: 'working' }, true);
    expect(last()).toEqual({ running: true, canAct: true, disabled: false, items: [] });
    expect(resets).toBe(0);
    m.renderPanelComposer({ ownerId: 'U1', terminated: true });
    expect(last()).toMatchObject({ running: false, disabled: true, canAct: true });
    expect(resets).toBe(1); // the files and any recording were for the open session
    // The same state again writes nothing (the field's text and an IME composition are the element's).
    const n = writes.length;
    m.renderPanelComposer({ ownerId: 'U1', terminated: true });
    expect(writes.length).toBe(n);
    // A forced pass re-applies.
    m.renderPanelComposer({ ownerId: 'U1', terminated: true }, true);
    expect(writes.length).toBe(n + 1);
    // Someone else's session: read-only — the queue shows, nothing can be done (like Stop).
    m.renderPanelComposer({ ownerId: 'U2', activityState: 'working' });
    expect(last()).toMatchObject({ canAct: false, disabled: false });
    m.renderPanelComposer({ activityState: 'working' }); // no ownerId: fail closed
    expect(last()).toMatchObject({ canAct: false });
    expect(clientFn('repaintPanelSession')).toContain('renderPanelComposer(s);');
  });
});

describe('the model menu closes on Escape before the panel does (executed)', () => {
  it('Escape in the open menu closes it, back on its trigger, and stops there; the controls then catch up', () => {
    // The menu is <ui-model-picker>: its Escape closes onto the trigger and stops inside the element, so the
    // document's panel Escape never sees it — owned by the library's 'Esc closes, returns focus to the trigger
    // and stops there' (@2lab.ai/ui model-picker.test.ts). The host half: the close repaints what it held.
    const repainted: string[] = [];
    const m = load<{ mpOnOpenChange(e: unknown): void }>(['mpOnOpenChange'], [], {
      refreshCard: () => {},
      repaintPanelControlsFor: (k: string) => repainted.push(k),
    });
    const picker = { tagName: 'UI-MODEL-PICKER', getAttribute: (n: string) => (n === 'data-mp-key' ? 'k' : null) };
    m.mpOnOpenChange({ target: picker, detail: { open: false } });
    expect(repainted).toEqual(['k']); // the controls catch up on what they held while the menu was open
    // Held while its own session's menu is open (a menu of another session is closed: model-picker client test).
    expect(clientFn('renderPanelControls')).toContain("var held = el.querySelector('ui-model-picker[open]');");
    expect(clientFn('renderPanelControls')).toContain('if (!held) {');
  });

  it('the same-session re-landing leaves a send in flight alone; a send whose session left the board fails closed', () => {
    expect(clientFn('openPanel')).toContain('renderPanelComposer(s, !sameSession);');
    const send = clientFn('sendCommand');
    expect(send).toContain('el.data = Object.assign({}, el.data, { disabled: true });');
    expect(send).toContain("if (cmdHost) cmdHost._mode = '';");
    const esc = TEMPLATE.slice(
      TEMPLATE.indexOf("if (e.key === 'Escape' && !e.defaultPrevented && panelOpen && !artViewerIsOpen()"),
    );
    expect(esc.slice(0, 200)).toContain('!artViewerIsOpen() && !_cronDrawerKey');
  });
});

describe('a live repaint keeps the reader where they were reading (executed)', () => {
  it('a section above the reader grows: the scroll area moves by the same amount; reading a live section: untouched', () => {
    let grow = 0;
    const scroll: any = {
      scrollTop: 500,
      calls: [] as number[],
      getBoundingClientRect: () => ({ top: 100 }),
      scrollTo(o: { top: number }) {
        this.scrollTop = o.top;
        this.calls.push(o.top);
      },
    };
    const kid = (id: string, top: number, h: number) => ({
      id,
      getBoundingClientRect: () => {
        const t = 100 + top + (id === 'panel-info' ? 0 : grow) - scroll.scrollTop;
        return { top: t, bottom: t + h + (id === 'panel-info' ? grow : 0), height: h };
      },
    });
    const info = kid('panel-info', 0, 200);
    const turns = kid('panel-turns', 200, 2000);
    scroll.children = [info, turns];
    // Task view: the live sections are read from the surface and the tab panel; the anchor from the turns.
    scroll.querySelectorAll = (sel: string) => (sel.includes('#panel-surface') ? [info, turns] : [turns]);
    const m = load<{ panelLiveAnchor(): unknown; restorePanelLiveAnchor(a: unknown): void }>(
      ['panelScrollAnchor', 'panelLiveAnchor', 'restorePanelLiveAnchor'],
      ['PANEL_LIVE_SECTIONS'],
      {
        document: { getElementById: () => scroll, body: { contains: () => true } },
      },
    );
    const a = m.panelLiveAnchor();
    expect(a).not.toBeNull();
    grow = 120; // 세션 정보 opened above the turns the reader is on
    m.restorePanelLiveAnchor(a);
    expect(scroll.scrollTop).toBe(620);
    // Reading 세션 정보 itself: no anchor, nothing moves.
    scroll.scrollTop = 50;
    expect(m.panelLiveAnchor()).toBeNull();
  });
});

describe('panel Tasks — the whole ledger, earlier lists included', () => {
  // SSOT 2026-10-29 T5: the earlier lists are not a separate "이전 계획" block any more. Every
  // task that ran — the current list's and the earlier lists' alike — is one run in the order
  // it ran; a task a new plan dropped before it ran folds under 실행 전에 계획에서 빠짐.
  // D3 E-22/E-23: opened, the runs are <ui-task-runs>' data and the plan left <ui-task-plan>'s.
  const rig = (open: boolean) => {
    const el = { style: {} as Record<string, string>, _html: '', innerHTML: '' };
    const runsEl: { data?: Record<string, any> } = {};
    const planEl: { data?: Record<string, any> } = {};
    const m = load<{ renderPanelTasks(tasks: unknown[], label: string, earlier: unknown[]): void }>(
      [
        'esc',
        'escAttr',
        'escJs',
        'toNum',
        'formatDuration',
        'formatTaskTime',
        'agentIconHtml',
        'taskFateOf',
        'taskIdNum',
        'taskRunStart',
        'taskRunEnd',
        'taskTokTotal',
        'taskRunsOf',
        'taskTotalsHtml',
        'taskElData',
        'taskRunsData',
        'taskPlanData',
        'taskRunsRestore',
        'planSummaryHtml',
        'renderPanelTasks',
      ],
      [
        'AGENT_STATUS_LABEL',
        'AGENT_STATUS_TONE',
        'AGENT_STATUS_GLYPH',
        'TASK_FATE_LABEL',
        'PI_CHEV_SVG',
        'TASK_RUNS_SHOWN',
        'TASK_RUN_STATUS',
        '_panelTaskOpen',
      ],
      {
        document: {
          getElementById: (id: string) =>
            id === 'panel-task-runs'
              ? el.innerHTML.includes(id)
                ? runsEl
                : null
              : id === 'panel-task-plan'
                ? el.innerHTML.includes(id)
                  ? planEl
                  : null
                : el,
        },
        _panelTasksOpen: open,
        _panelTasksExpanded: true,
        _panelTasksEarlier: true,
        formatTokens: String,
        morphInnerHtml: (e: { innerHTML: string }, h: string) => {
          e.innerHTML = h;
        },
      },
    );
    m.renderPanelTasks(
      [{ id: 'T5', content: 'now', activeForm: 'Doing it now', status: 'in_progress', startedAt: T0 + 120_000 }],
      '',
      [
        { id: 'T1', content: 'old one', status: 'completed', startedAt: T0, completedAt: T0 + 60_000, toolCalls: 4 },
        { id: 'T2', content: 'never ran', status: 'pending', dropped: 'unstarted' },
      ],
    );
    return { innerHTML: el.innerHTML, runs: runsEl.data, plan: planEl.data };
  };

  it('folded by default (task view T1.3): one head — the runs in one line, no rows (SSOT 2026-10-29 T5)', () => {
    const { innerHTML: html } = rig(false);
    expect(html).toContain(
      '<button type="button" class="panel-sec-head panel-tasks-header" aria-expanded="false" onclick="togglePanelTasks()">',
    );
    // What runs now, then how many ran and completed (the earlier list's run counts), then
    // how many a new plan dropped before they ran.
    expect(html).toContain('Doing it now');
    expect(html).toContain('실행 2 · 완료 1');
    expect(html).toContain('빠짐 1');
    expect(html).not.toContain('남은');
    expect(html).not.toContain('이전 계획');
    expect(html).not.toContain('panel-tasks-body');
    expect(html).not.toContain('old one');
  });

  it("opened, the earlier list's run is among the runs in start order; the never-run task sits in the plan's earlier fold (SSOT 2026-10-29 T5)", () => {
    const r = rig(true);
    const html = r.innerHTML;
    expect(html).toContain('aria-expanded="true" aria-controls="panel-tasks-body"');
    expect(html).toContain('<div class="panel-tasks-body ui-tok" id="panel-tasks-body">');
    // The earlier list's completed task ran first: it comes first.
    expect(r.runs?.runs.map((x: { title: string }) => x.title)).toEqual(['old one', 'now']);
    // Nothing of the plan is left to run; the never-run task is the plan's earlier fold, dropped.
    expect(r.plan?.steps).toEqual([]);
    expect(r.plan?.earlier[0].steps).toEqual([
      { id: 'skipped:T2', ref: '#T2', label: 'never ran', status: 'pending', fate: 'dropped' },
    ]);
    expect(JSON.stringify(r.runs)).not.toContain('never ran');
    // The foot sums the runs.
    expect(html).toContain('<div class="tr-total"><span class="tr-total-k">합계</span>툴 4</div>');
    expect(html).not.toContain('이전 계획');
  });
});

describe('root focus header in the panel', () => {
  it("the root's status and time are the chip's (still in its accessible name); a subagent keeps its own", () => {
    const src = clientFn('renderAgentFocus');
    expect(src).toContain('if (!node.root) {');
  });
});

describe('interaction state survives live renders on both surfaces', () => {
  it('a write in flight is one busy flag per session and operation, read by every renderer', () => {
    expect(TEMPLATE).toMatch(/^var _busy = Object\.create\(null\);/m);
    const busy = load<{
      isBusy(key: string, op: string): boolean;
      setBusy(key: string, op: string, on: boolean): void;
    }>(['isBusy', 'setBusy'], ['_busy']);
    expect(busy.isBusy('k', 'model')).toBe(false);
    busy.setBusy('k', 'model', true);
    expect(busy.isBusy('k', 'model')).toBe(true);
    expect(busy.isBusy('k', 'effort')).toBe(false);
    busy.setBusy('k', 'model', false);
    expect(busy.isBusy('k', 'model')).toBe(false);
    // Each writer marks it, each renderer reads it.
    expect(clientFn('changeModel')).toContain("setBusy(key, 'model', true)");
    expect(clientFn('changeEffort')).toContain("setBusy(key, 'effort', true)");
    expect(clientFn('goalAction')).toContain("setBusy(key, 'goal', true)");
    expect(clientFn('doAction')).toContain("setBusy(key, 'action', true)");
    expect(clientFn('mpData')).toContain("isBusy(s.key, 'model')");
    expect(clientFn('mpData')).toContain("isBusy(s.key, 'effort')");
    expect(clientFn('renderCardGoal')).toContain("isBusy(s.key, 'goal')");
    expect(clientFn('sessionActionsOf')).toContain("isBusy(s.key, 'action')");
  });

  it('a busy action renders disabled and aria-busy, whoever renders it', () => {
    const m = load<{ sessionActionHtml(s: unknown, col: string, where: string): string }>(
      ['esc', 'escAttr', 'escJs', 'toNum', 'pendingAutoResume', 'isBusy', 'sessionActionsOf', 'sessionActionHtml'],
      ['SESSION_ACTION_TONE'],
      { _busy: { 'inst::C1:t1|action': true }, currentUserId: 'U1', SELF_INSTANCE_NAME: '', READ_ONLY_MSG: 'ro' },
    );
    const html = m.sessionActionHtml(card(), 'working', 'panel');
    expect(html).toContain('aria-busy="true"');
    expect(html).toMatch(/data-action="stop"[^>]* disabled/);
  });

  it('a live repaint keeps the reader where they were reading', () => {
    const src = clientFn('repaintPanelSession');
    expect(src).toContain('panelLiveAnchor()');
    expect(src).toContain('restorePanelLiveAnchor(anchor)');
  });

  it('closing the panel and ending the session are different names', () => {
    const header = PAGE.slice(PAGE.indexOf('<div class="panel-header">'), PAGE.indexOf('<div class="panel-body"'));
    // SSOT 2026-10-29 T2: ✕ closes this session's detail card (and folds its card) — not "the panel".
    expect(header).toMatch(
      /class="ui-icon-btn is-bordered panel-close"[^>]*aria-label="작업 카드 닫기"[^>]*onclick="closeDetailCard\(\)"/,
    );
    expect(header).not.toContain('onclick="closePanel()"');
    // The overlay (the sheet's backdrop) does the same.
    expect(PAGE).toContain('<div class="slide-panel-overlay" id="panel-overlay" onclick="closeDetailCard()"></div>');
  });
});

// ── The collapsed face, audited against the compact tier of the research ──
// (spec 13 §3.7). Kept: headline, why-here line, current task, task count,
// subagent pulse, tokens · cost (the user's T1/T2), artifact chips (T5), owner
// badge, status foot. Added where the research names a triage field the face
// lacked: the outcome (PR number + state), recency on a card that is not
// moving, and the context level as a warning, not just a number.
// The face is @2lab.ai/ui <ui-agent-inbox>'s now: the page hands it the card
// data (cardOf), text only; the element draws, tints and escapes it ('draws face
// extras: lead, owner badge, host metrics, titles, context level, artifact count
// and chip buttons', 'escapes every host string of the face extras and groups').
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
const FACE_ENV = {
  dhShow: () => true,
  dhTruncate: () => null,
  currentUserId: 'U1',
  _ownerIndex: null,
  SELF_INSTANCE_NAME: 'inst',
};
const LAST = '2026-10-25T10:00:00.000Z';
const faceCard = (over: Record<string, unknown> = {}) => ({
  key: 'inst::C1:t1',
  displayHeadline: 'Three surfaces',
  ownerId: 'U1',
  ownerName: 'Z',
  activityState: 'idle',
  activeLegStartedAtMs: 0,
  activeAccumulatedMs: 120_000,
  lastActivity: LAST,
  tokenUsage: { totalInputTokens: 10, totalOutputTokens: 5, totalCostUsd: 0.1, contextUsagePercent: 12 },
  ...over,
});
type FaceCard = Record<string, unknown> & { metrics?: Array<Record<string, unknown>>; titles?: Record<string, string> };
type Face = { cardOf(s: unknown, col: string): FaceCard; ctxLevel(p: unknown): string };

describe('collapsed face — the outcome: PR number and state, a badge, not a link', () => {
  const face = load<Face>(CARD_OF_FNS, CARD_OF_VARS, FACE_ENV);
  const pr = { prUrl: 'https://github.com/o/r/pull/12', prShortRef: 'PR-12', prTitle: 'feat: surfaces' };
  const prOf = (over: Record<string, unknown>, col = 'idle') =>
    (face.cardOf(faceCard({ ...pr, ...over }), col).metrics ?? []).find((m) => m.glyph === 'pr');

  it('shows the PR number with its state as a word and a tone, and the title as a tooltip', () => {
    const c = face.cardOf(faceCard({ ...pr, prStatus: 'merged' }), 'closed');
    // A space keeps "#12 머지됨" two words.
    expect(c.metrics).toEqual([
      { text: '#12 머지됨', glyph: 'pr', title: 'PR #12 머지됨 — feat: surfaces', tone: 'done' },
    ]);
    // The face is one toggle: no link inside it (the open card and 세션 정보 hold the links).
    expect(JSON.stringify(c)).not.toContain('github.com');
  });

  it('each known state has its own tone and word', () => {
    expect(prOf({ prStatus: 'open' })).toMatchObject({ text: '#12 열림', tone: 'run' });
    expect(prOf({ prStatus: 'draft' })?.text).toBe('#12 초안');
    expect(prOf({ prStatus: 'draft' })?.tone).toBeUndefined();
    expect(prOf({ prStatus: 'closed' })).toMatchObject({ text: '#12 닫힘', tone: 'fail' });
  });

  it('the state is a word on screen, never colour alone; the colour follows it', () => {
    // Every tone comes with its word in the metric's text (the element colours it by data-tone).
    for (const st of ['open', 'draft', 'merged', 'closed']) {
      const m = prOf({ prStatus: st });
      expect(m?.text, st).toMatch(/^#12 \S+$/);
    }
  });

  it('a state in capitals still reads as that state', () => {
    expect(prOf({ prStatus: 'MERGED' })).toMatchObject({ text: '#12 머지됨', tone: 'done' });
  });

  it('a short ref in another shape is carried whole, as text (the element escapes it)', () => {
    expect(prOf({ prShortRef: '<b>x</b>', prStatus: 'open' })).toMatchObject({
      text: '<b>x</b> 열림',
      title: 'PR <b>x</b> 열림 — feat: surfaces',
    });
  });

  it('an unknown or hostile state renders the bare number', () => {
    const m = prOf({ prStatus: '"><img src=x onerror=alert(1)>' });
    expect(m).toEqual({ text: '#12', glyph: 'pr', title: 'PR #12 — feat: surfaces' });
    expect(prOf({})).toEqual({ text: '#12', glyph: 'pr', title: 'PR #12 — feat: surfaces' });
  });

  it('no PR, or the links field hidden: no badge', () => {
    expect(face.cardOf(faceCard(), 'idle').metrics).toBeUndefined();
    const noLinks = load<Face>(CARD_OF_FNS, CARD_OF_VARS, { ...FACE_ENV, dhShow: (f: string) => f !== 'links' });
    expect(noLinks.cardOf(faceCard({ ...pr, prStatus: 'open' }), 'idle').metrics).toBeUndefined();
  });

  it('the face click handler leaves the badge to the toggle (nothing to skip) — it is not interactive', () => {
    expect(clientFn('cardPrMetric')).not.toMatch(/<a |<button|onclick|tabindex|href/);
  });
});

describe('collapsed face — recency on a card that is not moving', () => {
  const face = load<Face>(CARD_OF_FNS, CARD_OF_VARS, FACE_ENV);
  const DONE = Date.parse(LAST) + 40 * 60_000; // the turn ran 40 minutes after the last instruction
  const WAIT = Date.parse(LAST) + 30 * 60_000; // the question came 30 minutes in

  it('a finished card counts from when its work finished (finishedAt), not from the last instruction', () => {
    // lastActivity moves on user input only: after a 40-minute turn it would overstate by 40 minutes.
    for (const col of ['idle', 'closed']) {
      expect(face.cardOf(faceCard({ finishedAt: DONE, doneAt: DONE }), col).since, col).toBe(DONE);
    }
    // Only an inferred finish (doneAt from lastActivity, a legacy record): no stamp — never a wrong age.
    expect(face.cardOf(faceCard({ doneAt: Date.parse(LAST) }), 'idle').since).toBeUndefined();
    expect(face.cardOf(faceCard(), 'closed').since).toBeUndefined();
  });

  it('a waiting card counts from when it started waiting (waitingSince) — without that stamp, nothing', () => {
    expect(face.cardOf(faceCard({ waitingSince: WAIT, doneAt: DONE }), 'waiting').since).toBe(WAIT);
    // A wrong number is worse than none on a triage surface: never the last instruction.
    expect(face.cardOf(faceCard(), 'waiting').since).toBeUndefined();
  });

  it('a running card shows its live timer instead; an armed resume shows its own time', () => {
    // The running clock counts from the leg's start (the element's 'Running · 3m 49s').
    expect(face.cardOf(faceCard({ activityState: 'working', activeLegStartedAtMs: 5 }), 'working')).toMatchObject({
      status: 'running',
      since: 5,
    });
    const resume = faceCard({
      autoResume: { kind: 'retry', at: Date.parse(LAST) + 60_000, attempt: 1, maxAttempts: 3, reason: 'rate limit' },
    });
    const c = face.cardOf(resume, 'working');
    expect(c.status).toBe('waiting');
    expect(String(c.statusText)).toMatch(/자동 재개 · 시도 1\/3$/);
    expect(c.since).toBeUndefined();
  });

  it('no clock in the data: an unparsable stamp shows nothing, equal data gives an equal card', () => {
    expect(face.cardOf(faceCard({ finishedAt: 'not a number' }), 'idle').since).toBeUndefined();
    expect(face.cardOf(faceCard({ waitingSince: 'x' }), 'waiting').since).toBeUndefined();
    const done = faceCard({ finishedAt: Date.parse(LAST) });
    expect(JSON.stringify(face.cardOf(done, 'idle'))).toBe(JSON.stringify(face.cardOf(done, 'idle')));
  });
});

describe('collapsed face — the context level is a warning, the panel bar uses the same levels', () => {
  const face = load<Face>(CARD_OF_FNS, CARD_OF_VARS, FACE_ENV);
  const ctx = (pct: number) =>
    face.cardOf(faceCard({ tokenUsage: { totalInputTokens: 1, contextUsagePercent: pct } }), 'idle');

  it('over 60% amber, over 80% red with the band in the tooltip; below, the plain number', () => {
    expect(face.ctxLevel(12)).toBe('');
    expect(face.ctxLevel(61)).toBe('ctx-warn');
    expect(face.ctxLevel(81)).toBe('ctx-danger');
    expect(face.ctxLevel('x')).toBe('');
    expect(ctx(12)).toMatchObject({ contextPct: 12, contextLevel: '', titles: { context: 'Context window used' } });
    expect(ctx(65)).toMatchObject({ contextLevel: 'warn', titles: { context: 'Context window used' } });
    expect(ctx(90)).toMatchObject({
      contextLevel: 'danger',
      titles: { context: 'Context window used — 80% 넘게 찼다' },
    });
  });

  it('red text clears 4.5:1 on the dimmed (sleeping / archived) card too; a crowded metrics row wraps inside the card', () => {
    // The page keeps the red text token (dark and light) and hands it to the element through the
    // token wrapper; the element's styles colour the danger metric with it and wrap its metrics row
    // ('draws face extras: … context level …' checks the level; the layout is its styles.ts).
    // Tone pass P10: the token is @2lab.ai/ui's (tokens.css, dark and light), aliased by the page.
    expect(uiLibTokensCss()).toMatch(/\[data-theme="light"\] \{[^}]*--ui-st-fail-text: #[0-9a-f]{6};/);
    expect(uiLibTokensCss()).toMatch(/\[data-theme="dark"\] \{[^}]*--ui-st-fail-text: #[0-9a-f]{6};/);
    expect(pageTokenAliases()).toContain('--st-fail-text: var(--ui-st-fail-text);');
    expect(TEMPLATE).toMatch(/\.ui-tok \{[^}]*--ui-st-fail-text: var\(--st-fail-text\);/);
    expect(TEMPLATE).toContain('<section class="inbox ui-tok" id="inbox"');
  });

  it('one threshold table for both surfaces', () => {
    // re-context-window D9/D16: the same ctxLevel, given the auto-compact point, on the face and the summary; the
    // block (<ui-context-window>) measures the same table (library context-window.test.ts "measures the level against the auto-compact point").
    expect(clientFn('panelInfoHtml')).toContain(
      'ctxLevel(ctx, s.contextTokens, s.autoCompactTokens, s.compactPending)',
    );
    expect(clientFn('cardOf')).toContain('ctxLevel(ctxPct, s.contextTokens, s.autoCompactTokens, s.compactPending)');
  });
});
