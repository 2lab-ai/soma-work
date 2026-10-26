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
const NODE_FNS = [
  ...BASE,
  'agentStatusOf',
  'agentName',
  'agentIconHtml',
  'agentTimeHtml',
  'agentActivity',
  'agentSpanAxis',
  'agentSpanStyle',
  'pendingAutoResume',
  'rootStatusOf',
  'agentNodeOf',
  'agentTreeOf',
  'anDesc',
  'agentNodeName',
  'agentNodeLine',
  'agentNodeAria',
  'spendTotal',
  'spendText',
  'spendLabel',
  'spendTitle',
  'anCompactLine',
  'anIdPart',
  'anTimeId',
  'anIsOpen',
  'agentNodeRow',
  'renderAgentNode',
  'renderAgentNodes',
  'anTreeHtml',
];
const NODE_VARS = [
  'AGENT_STATUS_LABEL',
  'AGENT_TREE_ROWS',
  'AN_CHEV_SVG',
  'AN_LIVE_LINE',
  '_anOpen',
  '_anAll',
  '_anActive',
];

// ── 1. The agent tree at the density of its surface ──
describe('one row renderer, two densities — compact on the card, rich in the panel', () => {
  // One load for the suite (cooking the client is the slow part); the header config is mutable.
  const header: { show: Record<string, boolean> } = { show: {} };
  const treeUi = load<{ renderAgentTree(s: unknown, col: string): string }>(
    [...NODE_FNS, 'cardCurrentTask', 'renderCardTaskRow', 'renderAgentTree'],
    NODE_VARS,
    { formatTokens: (n: number) => `${n}`, dhShow: (k: string) => !!header.show[k] },
  );
  const tree = (s: Record<string, unknown>, col: string, show: Record<string, boolean> = { tasks: true }) => {
    header.show = show;
    return treeUi.renderAgentTree(s, col);
  };
  const itemOf = (html: string, id: string) => {
    const at = html.indexOf(`data-agent-open="${id}"`);
    const start = html.lastIndexOf('<li ', at);
    const next = html.indexOf('<li ', at);
    return html.slice(start, next < 0 ? undefined : next);
  };

  it('a card row is name · status word · time — no tools, tokens, background pill, description or waterfall', () => {
    const html = tree(card(), 'working');
    expect(html).toContain('class="an-row is-compact"');
    expect(html).not.toContain('class="ag-tools"');
    expect(html).not.toContain('class="ag-tok"');
    expect(html).not.toContain('class="ag-bg"');
    expect(html).not.toContain('class="ag-desc"');
    expect(html).not.toContain('class="ag-span"');
    const lib = itemOf(html, 'toolu_lib');
    expect(lib).toContain('<span class="ag-st">완료</span>');
    expect(lib).toContain('4m 2s');
    expect(lib).not.toContain('class="ag-sub"');
  });

  it('a live node adds what it is doing; a failed node adds its description when it reports nothing else', () => {
    const html = tree(card(), 'working');
    expect(itemOf(html, 'toolu_explore')).toContain('<span class="ag-sub">#T1 Reading the mapper</span>');
    // The failed child sits under a folded parent? No — depth 1 is open by default on the card.
    expect(itemOf(html, 'toolu_nested')).toContain('<span class="ag-sub">Check nested spawn frames</span>');
  });

  it("the compact item's accessible name lists the slots it shows — never the tools it does not", () => {
    const html = tree(card(), 'working');
    expect(itemOf(html, 'toolu_explore')).toContain('aria-label="A1 Explore, 실행 중, #T1 Reading the mapper, 하위 1"');
    expect(itemOf(html, 'toolu_lib')).toContain('aria-label="A2 librarian, 완료"');
    expect(html).not.toMatch(/aria-label="[^"]*툴 \d/);
  });

  it("the root's activity line is dropped only while the face's task row shows it", () => {
    const shown = tree(card(), 'working');
    expect(itemOf(shown, '')).not.toContain('class="ag-sub"');
    // No task in progress: the face has no task row, so the root says what it last did.
    const noTask = tree(card({ tasks: [{ id: 'T1', content: 'Plan', status: 'completed' }] }), 'working');
    expect(itemOf(noTask, '')).toContain('<span class="ag-sub">마지막 도구 Edit</span>');
    // The header hides the task row: the root keeps its line.
    const hidden = tree(card(), 'working', {});
    expect(itemOf(hidden, '')).toContain('<span class="ag-sub">#T2 Build</span>');
  });

  it('a parent over the card cap hands the rest to the panel — 전체 N개 → 상세, not an in-card expansion', () => {
    const kids = Array.from({ length: 9 }, (_, i) => ({
      id: `k${i}`,
      n: 10 + i,
      status: 'completed',
      startedAt: T0 + i,
    }));
    const html = tree(card({ agents: kids, agentsTotal: 9 }), 'working');
    expect(html.match(/data-agent-open="k\d"/g)).toHaveLength(6);
    expect(html).toContain('<span class="an-all-text">전체 9개 &rarr; 상세</span>');
    expect(html).toContain('aria-label="전체 9개 — 상세 패널에서 보기"');
    const act = clientFn('anActivate');
    expect(act).toContain("ns.indexOf('c|') === 0");
    expect(act).toContain("openPanel(ns.slice(2), 'agent', allId)");
  });

  it('the panel rows stay rich: tools, tokens, background, description, activity, waterfall', () => {
    const fns = [...NODE_FNS];
    const m = load<{
      anTreeHtml(root: unknown, anchor: unknown, ctx: unknown): string;
      agentTreeOf(s: unknown, c: string): any;
    }>(fns, NODE_VARS, { formatTokens: (n: number) => `${n}` });
    const root = m.agentTreeOf(card(), 'working');
    const ctx = {
      ns: 'p|k',
      act: 'data-agent-select',
      levelBase: 0,
      capFrom: 2,
      withRoot: false,
      density: 'rich',
      axis: { t0: T0, t1: T0 + 300_000 },
    };
    const html = m.anTreeHtml(root, root, ctx);
    expect(html).not.toContain('is-compact');
    expect(html).toContain('<span class="ag-tools" title="툴 호출 수">툴 18</span>');
    // SSOT 2026-10-26 T2 — its own spend (tokens + API-equivalent cost), never the SDK's context size.
    expect(html).toContain('>238000 tok · $0.42</span>');
    expect(html).toContain('<span class="ag-tok" title="이 에이전트 자신의 API 호출 7회 (하위 에이전트 제외)');
    expect(html).toContain('<span class="ag-bg">배경</span>');
    expect(html).toContain('<span class="ag-desc">Trace subagent frames</span>');
    expect(html).toContain('class="ag-span"');
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
    renderPermissionBlock: () => '',
    resolveRecommendedId: () => null,
    stripRecommendedMarker: (l: string) => l,
    choiceDataAttrs: () => '',
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
        'sessionActionHtml',
        'cardGoalLine',
        'renderCardBody',
      ],
      ['RESUME_SVG', 'GOAL_STATUS_LABELS', 'SESSION_ACTION_ARIA', '_busy'],
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
    expect(html).toContain('btn-stop');
  });

  it('needs you: the ask first, then the latest exchange and the evidence (artifacts), then the work', () => {
    const q = { type: 'user_choice', question: 'Ship it?', choices: [{ id: '1', label: 'Yes' }] };
    const html = body(card({ activityState: 'waiting', pendingQuestion: q }), 'waiting');
    const order = ['class="card-question"', '[IO]', '[ARTS]', '[TASKS]', '[AGENTS]'].map((m) => html.indexOf(m));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('btn-close');
  });

  it('a permission prompt heads the body whatever the column; an armed resume heads a running card', () => {
    const perm = body(card(), 'working', { renderPermissionBlock: () => '[PERM]' });
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
    expect(resume).toContain('btn-close');
    expect(resume).not.toContain('btn-stop');
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

  it('the footer is the control strip: model · effort switch (with its pending note), the state action, Slack, 작업 로그', () => {
    const html = body(card(), 'working');
    const foot = html.slice(html.indexOf('class="card-foot-bar"'));
    expect(foot).toContain('[MODEL]');
    // The owner's one trigger carries the level and opens the model · effort menu
    // (.prd/affectui/re-model-picker.md D1); a reader gets the level as text.
    expect(foot).not.toContain('[EFFORT]');
    const read = body(card(), 'working', { currentUserId: 'U2' });
    expect(read.slice(read.indexOf('class="card-foot-bar"'))).toContain('[MODEL][EFFORT]');
    expect(foot).toContain('btn-stop');
    expect(foot).toContain('href="https://slack/x"');
    expect(foot).toContain('>작업 로그</button>');
    // The switch is not the body's first line any more.
    expect(html.indexOf('[MODEL]')).toBeGreaterThan(html.indexOf('[IO]'));
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
      ['esc', 'escAttr', 'escJs', 'toNum', 'formatDuration', 'renderTaskMeta', 'renderTimelineItem', 'renderTimeline'],
      [],
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
    const html = tl({ key: 'k1', tasks, earlierTasks: [{ id: 'T0', content: 'old', status: 'completed' }] });
    expect(html.match(/class="tl-item/g)).toHaveLength(5);
    expect(html).toContain("openPanel('k1','tasks',");
    expect(html).toContain('전체 task 10개 &rarr;');
    expect(html).not.toContain('toggleCardTasks');
    expect(html).not.toContain('tl-earlier');
  });
});

// ── 3. The panel: understand and steer ──
describe('panel header — the session chip and its one action', () => {
  const head = (s: Record<string, unknown>, col: string, inject: Record<string, unknown> = {}) =>
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
        ...inject,
      },
    ).panelHeadHtml(s, col);

  it('a running session: 세션 · 실행 중 (announced), 시작 HH:MM · this turn’s live time, Slack, and Stop', () => {
    const html = head(card(), 'working');
    expect(html).toContain('class="ps-chip is-running"');
    expect(html).toContain('<span class="ps-label">세션</span>');
    expect(html).toContain('<span class="ps-word" role="status">실행 중</span>');
    // re-agent-run D18: the head times this turn from its start; the session's Σ active time is in 세부 (D19).
    expect(html).toContain('시작 ');
    expect(html).toContain('class="card-timer-live" data-leg-started="' + T0 + '" data-accumulated="0"');
    expect(html).toContain('href="https://slack/x"');
    expect(html).toContain('btn-stop');
    // The accessible name keeps the visible label first (WCAG 2.5.3).
    expect(html).toContain('aria-label="Stop — 세션 중지"');
  });

  it('idle → Close, archived → Trash, sleeping → Close; the words follow the root vocabulary', () => {
    expect(head(card({ activityState: 'idle' }), 'idle')).toContain('aria-label="Close — 세션 종료"');
    const archived = head(card({ activityState: 'idle', terminated: true }), 'closed');
    expect(archived).toContain('btn-trash');
    expect(archived).toContain('>보관</span>');
    expect(head(card({ activityState: 'idle' }), 'closed')).toContain('>휴면</span>');
  });

  it('an armed resume says when, which attempt and why', () => {
    const html = head(
      card({
        activityState: 'idle',
        autoResume: { kind: 'error-retry', at: T0, attempt: 2, maxAttempts: 3, reason: '429 rate limit' },
      }),
      'working',
    );
    expect(html).toContain('>재개 대기</span>');
    expect(html).toContain('class="ps-resume" title="429 rate limit"');
    expect(html).toContain('자동 재개 · 시도 2/3');
  });

  it('a reader who does not own it, or a sibling instance, gets a disabled action', () => {
    expect(head(card({ ownerId: 'U9' }), 'working')).toMatch(/btn-stop"[^>]* disabled/);
    const sib = head(card({ environment: { instanceName: 'other', host: 'h', port: 1 } }), 'working', {
      SELF_INSTANCE_NAME: 'me',
    });
    expect(sib).toMatch(/btn-stop" disabled/);
  });
});

describe('세션 정보 — the complete numbers, live, behind one summary line', () => {
  const info = (s: Record<string, unknown>, open: boolean) =>
    load<{ panelInfoHtml(s: unknown, open: boolean): string }>(
      // contextBlockHtml: the context block at the top of the open body (re-context-window D5) — empty without contextParts.
      // panelDetailsHtml: 세부 right after it (re-agent-run D19).
      [
        'esc',
        'escAttr',
        'toNum',
        'ctxLevel',
        'ctxPercent',
        'contextBlockHtml',
        'pendingAutoResume',
        'rootStatusOf',
        'panelDetailsHtml',
        'panelInfoHtml',
      ],
      ['PI_CHEV_SVG'],
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
    expect(src).toContain('renderCardGoal(s, col, canEdit)');
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

  it('the composer input is never inside a morph root; the pickers have their own container beside it', () => {
    const cmd = PAGE.slice(PAGE.indexOf('<div class="panel-command" id="panel-command">'));
    expect(cmd.indexOf('id="panel-controls"')).toBeGreaterThan(0);
    expect(cmd.indexOf('id="panel-controls"')).toBeLessThan(cmd.indexOf('id="cmd-input"'));
    const controls = cmd.slice(
      cmd.indexOf('id="panel-controls"'),
      cmd.indexOf('</div>', cmd.indexOf('id="panel-controls"')),
    );
    expect(controls).not.toContain('cmd-input');
  });

  it('the page: chip in the header; 세션 정보 → goal → permission → question → agents → work log → turns in the scroll area', () => {
    const header = PAGE.slice(PAGE.indexOf('<div class="panel-header">'), PAGE.indexOf('<div class="panel-body"'));
    expect(header).toContain('id="panel-status"');
    const scroll = PAGE.slice(PAGE.indexOf('<div class="panel-scroll" id="panel-scroll">'));
    const ids = [
      'panel-info',
      'panel-goal',
      'panel-permission',
      'panel-question',
      'panel-agents',
      'panel-worklog',
      'panel-turns',
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
  function rig(intent: string, opts: { question?: boolean } = {}) {
    const offsets: Record<string, number> = {
      'panel-info': 0,
      'panel-goal': 80,
      'panel-permission': 300,
      'panel-question': 300,
      'panel-agents': 420,
      'panel-worklog': 700,
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
    const tasks = { scrollTop: 120 };
    const els: Record<string, unknown> = {
      'panel-scroll': scroll,
      'panel-tasks': tasks,
      'panel-goal': section('panel-goal'),
      'panel-agents': section('panel-agents'),
      'panel-worklog': section('panel-worklog'),
      'worklog-toggle': { getBoundingClientRect: (): Rect => ({ top: 0, bottom: 32, height: 32 }) },
      'panel-permission': section('panel-permission', false),
      'panel-question': section('panel-question', !!opts.question),
    };
    const m = load<{ landPanel(): void; state(): { landed: boolean; stick: boolean } }>(
      ['workLogLandingTop', 'scrollPanelToWorkLog', 'landPanel'],
      ['_panelOnQuestion'],
      { document: { getElementById: (id: string) => els[id] ?? null } },
      [
        `var _panelLand = ${JSON.stringify(intent)}; var _panelLanded = false; var _panelStickBottom = false;`,
        'function state() { return { landed: _panelLanded, stick: _panelStickBottom }; }',
      ],
    );
    return { m, scroll, tasks };
  }

  it('관리 → puts the goal section at the top of the scroll area, once — late turns never drag it', () => {
    const r = rig('goal');
    r.m.landPanel();
    expect(r.scroll.scrollTop).toBe(80);
    expect(r.m.state()).toEqual({ landed: true, stick: false });
    r.scroll.scrollTop = 40; // the reader scrolls; the turns arrive and land again
    r.m.landPanel();
    expect(r.scroll.scrollTop).toBe(40);
  });

  it('a tree item / 전체 N개 → 상세 puts the agents section at the top', () => {
    const r = rig('agent');
    r.m.landPanel();
    expect(r.scroll.scrollTop).toBe(420);
  });

  it('전체 task → opens the pinned Tasks box at its head; the scroll area keeps the default landing', () => {
    const r = rig('tasks');
    r.m.landPanel();
    expect(r.tasks.scrollTop).toBe(0);
    expect(r.scroll.scrollTop).toBe(3000); // no blocker: the newest turns
    const ask = rig('tasks', { question: true });
    ask.m.landPanel();
    expect(ask.scroll.scrollTop).toBe(300); // a question waits: it heads the scroll area
  });

  it('true (작업 로그) still lands on the work-log head', () => {
    const r = rig('worklog');
    r.m.landPanel();
    expect(r.scroll.calls.length).toBe(1);
  });
});

describe('focus goes back to whatever opened the panel (executed)', () => {
  it('Escape / × from inside the panel → the opener; gone or inert → the card face; focus elsewhere → untouched', () => {
    const run = (o: { inPanel: boolean; present: boolean; inert?: boolean }) => {
      const focused: string[] = [];
      const panel = { classList: { remove() {} } };
      const doc: Record<string, unknown> = {
        getElementById: (id: string) => (id === 'slide-panel' || id === 'panel-overlay' ? panel : null),
        querySelector: () => null,
      };
      // focus() moves document.activeElement, except into an inert (folded) card.
      const el = (name: string, inert = false) => {
        const node: Record<string, unknown> = {
          focus: () => {
            focused.push(name);
            if (!inert) doc.activeElement = node;
          },
        };
        return node;
      };
      const opener = el('opener', !!o.inert);
      const face = el('face');
      doc.body = { contains: (n: unknown) => (n === opener ? o.present : n === face) };
      doc.activeElement = o.inPanel
        ? { closest: (sel: string) => (sel === '#slide-panel' ? panel : null) }
        : { closest: () => null };
      const m = load<{ closePanel(): void }>(
        ['closePanel'],
        [],
        {
          document: doc,
          layoutBeforeChange: () => {},
          resetWorkLog: () => {},
          _cardEls: { k: { _faceEl: face } },
          __ret: opener,
        },
        [
          'var panelOpen = true, panelSessionKey = "k", panelConvId = null, _panelAgent = "", _panelAgentsHtml = "", _rawLoadedCache = {}, _panelGen = 0;',
          'var _panelTurnsHasMore = false, _panelTurnsLoading = false, _panelTurnsOldestId = null, _panelLand = "", _panelLanded = false;',
          'var _panelStickBottom = false, _panelOnQuestion = false, _anReturnFocus = null, _panelReturnFocus = __ret;',
        ],
      );
      m.closePanel();
      return focused;
    };
    expect(run({ inPanel: true, present: true })).toEqual(['opener']);
    expect(run({ inPanel: true, present: false })).toEqual(['face']); // a folded DONE date dropped it
    expect(run({ inPanel: true, present: true, inert: true })).toEqual(['opener', 'face']); // inside a folded card
    expect(run({ inPanel: false, present: true })).toEqual([]); // the reader already moved on
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
      ['GOAL_STATUS_LABELS', 'GOAL_VIA_LABELS', '_goalHistoryOpen', '_goalErrors', '_busy'],
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
    const el = {
      style: { display: '' },
      _html: 'old',
      _key: 'k',
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
        morphInnerHtml: () => {
          inside = new Set(); // Q1's row (and its focused Delete) is gone
          doc.activeElement = doc.body;
        },
      },
    );
    m.renderPanelGoal();
    expect(doc.activeElement).toBe(el);
    expect(clientFn('openPanel')).toContain('if (!sameSession) (function resetCmdUi()');
  });
});

describe('the composer follows the session live (executed)', () => {
  it('a session closed while the panel shows it disables the composer; an unchanged state writes nothing; a forced pass re-applies', () => {
    const input = { disabled: false, placeholder: '' };
    const btn = { disabled: false };
    const hint = { style: { display: 'none' } };
    const host: Record<string, unknown> = {};
    const els: Record<string, unknown> = {
      'panel-command': host,
      'cmd-input': input,
      'cmd-send': btn,
      'cmd-hint': hint,
    };
    const m = load<{ renderPanelComposer(s: unknown, force?: boolean): void }>(['renderPanelComposer'], [], {
      document: { getElementById: (id: string) => els[id] ?? null },
      currentUserId: 'U1',
      READ_ONLY_MSG: 'read only',
    });
    m.renderPanelComposer({ ownerId: 'U1' }, true);
    expect(input.disabled).toBe(false);
    m.renderPanelComposer({ ownerId: 'U1', terminated: true });
    expect(input.disabled).toBe(true);
    expect(btn.disabled).toBe(true);
    expect(hint.style.display).toBe('');
    // A late send completion re-enabled it by hand: the forced pass puts the closed state back.
    input.disabled = false;
    btn.disabled = false;
    m.renderPanelComposer({ ownerId: 'U1', terminated: true });
    expect(input.disabled).toBe(false); // same mode, no write (an in-flight send keeps its button)
    m.renderPanelComposer({ ownerId: 'U1', terminated: true }, true);
    expect(input.disabled).toBe(true);
    expect(clientFn('sendCommand')).toContain('renderPanelComposer(_sessionCache[sendingSessionKey], true);');
    expect(clientFn('repaintPanelSession')).toContain('renderPanelComposer(s);');
  });
});

describe('the model menu closes on Escape before the panel does (executed)', () => {
  it('Escape in the open menu closes the menu, back on its trigger, and stops there: the panel stays open', () => {
    // The fold toggle is gone (re-model-picker D16): the composer's one trigger opens the menu above it.
    const trigger = {
      attrs: { 'data-mp-key': 'k', 'data-mp-surface': 'panel', 'aria-expanded': 'true' } as Record<string, string>,
      getAttribute(n: string) {
        return this.attrs[n];
      },
      setAttribute(n: string, v: string) {
        this.attrs[n] = v;
      },
      focused: false,
      focus() {
        this.focused = true;
      },
    };
    const menu = { classList: { remove: () => {} }, setAttribute: () => {} };
    const repainted: string[] = [];
    const m = load<{ mpMenuKey(e: unknown): void }>(
      ['mpAnchor', 'mpClose', 'mpMenuKey'],
      ['_mp'],
      {
        document: {
          getElementById: (id: string) => (id === 'mp-menu' ? menu : null),
          querySelectorAll: () => [trigger],
        },
        refreshCard: () => {},
        repaintPanelControlsFor: (k: string) => repainted.push(k),
        clearInterval: () => {},
      },
      ['function mpSet(k, w) { _mp.key = k; _mp.surface = w; }'],
    ) as { mpMenuKey(e: unknown): void; mpSet(k: string, w: string): void };
    m.mpSet('k', 'panel');
    let stopped = false;
    m.mpMenuKey({
      key: 'Escape',
      target: { classList: { contains: () => true } },
      preventDefault() {},
      stopPropagation() {
        stopped = true;
      },
    });
    expect(stopped).toBe(true); // the document's panel Escape never sees it
    expect(trigger.attrs['aria-expanded']).toBe('false');
    expect(trigger.focused).toBe(true);
    expect(repainted).toEqual(['k']); // the controls catch up on what they held while the menu was open
  });

  it('the same-session re-landing leaves a send in flight alone; a send whose session left the board fails closed', () => {
    expect(clientFn('openPanel')).toContain('renderPanelComposer(s, !sameSession);');
    const send = clientFn('sendCommand');
    expect(send).toContain('btn.disabled = true;');
    expect(send).toContain("if (cmdHost) cmdHost._mode = '';");
    const esc = TEMPLATE.slice(TEMPLATE.indexOf("if (e.key === 'Escape' && panelOpen && !artModalIsOpen()"));
    expect(esc.slice(0, 200)).toContain('!artModalIsOpen() && !_cronDrawerKey');
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
    scroll.querySelectorAll = () => [turns];
    const m = load<{ panelLiveAnchor(): unknown; restorePanelLiveAnchor(a: unknown): void }>(
      ['panelScrollAnchor', 'panelLiveAnchor', 'restorePanelLiveAnchor'],
      ['PANEL_LIVE_SECTIONS'],
      {
        document: { getElementById: () => scroll, body: { contains: () => true } },
        _panelStickBottom: false,
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
  it('the main scope lists the earlier task lists under the current one', () => {
    const el = { style: {} as Record<string, string>, _html: '', innerHTML: '' };
    const m = load<{ renderPanelTasks(tasks: unknown[], label: string, earlier: unknown[]): void }>(
      // re-agent-run D1–D7: plan rows (markers, times) and the footer.
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
        document: { getElementById: () => el },
        _panelTasksExpanded: true,
        _panelTasksEarlier: true,
        morphInnerHtml: (e: { innerHTML: string }, h: string) => {
          e.innerHTML = h;
        },
        updateTimersIn: () => {},
      },
    );
    m.renderPanelTasks([{ id: 'T5', content: 'now', status: 'in_progress' }], '', [
      { id: 'T1', content: 'old one', status: 'completed' },
    ]);
    expect(el.innerHTML).toContain('이전 task 1개');
    expect(el.innerHTML).toContain('old one');
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
    expect(clientFn('renderModelPicker')).toContain("isBusy(s.key, 'model')");
    expect(clientFn('renderEffortControl')).toContain("isBusy(s.key, 'effort')");
    expect(clientFn('renderCardGoal')).toContain("isBusy(s.key, 'goal')");
    expect(clientFn('sessionActionHtml')).toContain("isBusy(s.key, 'action')");
  });

  it('a busy action renders disabled and aria-busy, whoever renders it', () => {
    const m = load<{ sessionActionHtml(s: unknown, col: string, where: string): string }>(
      ['esc', 'escAttr', 'escJs', 'toNum', 'pendingAutoResume', 'isBusy', 'sessionActionHtml'],
      ['SESSION_ACTION_ARIA'],
      { _busy: { 'inst::C1:t1|action': true }, currentUserId: 'U1', SELF_INSTANCE_NAME: '', READ_ONLY_MSG: 'ro' },
    );
    const html = m.sessionActionHtml(card(), 'working', 'panel');
    expect(html).toContain('aria-busy="true"');
    expect(html).toMatch(/btn-stop"[^>]* disabled/);
  });

  it('a live repaint keeps the reader where they were reading', () => {
    const src = clientFn('repaintPanelSession');
    expect(src).toContain('panelLiveAnchor()');
    expect(src).toContain('restorePanelLiveAnchor(anchor)');
  });

  it('closing the panel and ending the session are different names', () => {
    const header = PAGE.slice(PAGE.indexOf('<div class="panel-header">'), PAGE.indexOf('<div class="panel-body"'));
    expect(header).toMatch(/class="panel-close"[^>]*aria-label="패널 닫기"/);
  });
});

// ── The collapsed face, audited against the compact tier of the research ──
// (spec 13 §3.7). Kept: headline, why-here line, current task, task count,
// subagent pulse, tokens · cost (the user's T1/T2), artifact chips (T5), owner
// badge, status foot. Added where the research names a triage field the face
// lacked: the outcome (PR number + state), recency on a card that is not
// moving, and the context level as a warning, not just a number.
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
  'doneTimeOf',
  'cardAgo',
  'renderCardStatus',
  'renderOwnerBadge',
  'ctxLevel',
  'ctxPercent',
  'renderCardPr',
  'renderCardFace',
];
const FACE_VARS = [
  'SPARK_SVG',
  'WAIT_SVG',
  'TASKS_SVG',
  'CTX_SVG',
  'RESUME_SVG',
  'PR_STATE_LABEL',
  'PR_SVG',
  'AGENT_STATUS_LABEL',
  'AGENT_DOTS_MAX',
  'AGENTS_SVG',
];
const FACE_ENV = {
  dhShow: () => true,
  dhMax: (_f: string, d: number) => d,
  dhTruncate: () => null,
  currentUserId: 'U1',
  isSiblingSession: () => false,
  artFaceChips: () => '',
  umFaceBadge: () => '',
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
type Face = { renderCardFace(s: unknown, col: string): string; ctxLevel(p: unknown): string };

describe('collapsed face — the outcome: PR number and state, a badge, not a link', () => {
  const face = load<Face>(FACE_FNS, FACE_VARS, FACE_ENV);
  const pr = { prUrl: 'https://github.com/o/r/pull/12', prShortRef: 'PR-12', prTitle: 'feat: surfaces' };

  it('shows the PR number with its state as a word and a class, and the title as a tooltip', () => {
    const html = face.renderCardFace(faceCard({ ...pr, prStatus: 'merged' }), 'closed');
    expect(html).toMatch(/<span class="metric card-pr is-merged" title="PR #12 머지됨 — feat: surfaces">/);
    expect(html).toContain('#12');
    // The face's name is built from its content: a space keeps "#12 머지됨" two words.
    expect(html).toContain('<span class="cpr-state"> 머지됨</span>');
    // The face is one toggle: no link inside it (the open card and 세션 정보 hold the links).
    expect(html).not.toContain('<a ');
  });

  it('each known state has its own class and word', () => {
    expect(face.renderCardFace(faceCard({ ...pr, prStatus: 'open' }), 'idle')).toContain('card-pr is-open');
    expect(face.renderCardFace(faceCard({ ...pr, prStatus: 'draft' }), 'idle')).toContain('> 초안<');
    expect(face.renderCardFace(faceCard({ ...pr, prStatus: 'closed' }), 'idle')).toContain('card-pr is-closed');
  });

  it('the state is a word on screen, never colour alone; the colour follows it', () => {
    // A sighted touch or keyboard reader has no tooltip: the word is not clipped.
    expect(TEMPLATE).toMatch(/\.card-pr \.cpr-state \{[^}]*\}/);
    expect(TEMPLATE).not.toMatch(/\.cpr-state \{[^}]*clip:/);
    expect(TEMPLATE).toMatch(/\.card-metrics \.card-pr\.is-open \{[^}]*var\(--st-run\)/);
    expect(TEMPLATE).toMatch(/\.card-metrics \.card-pr\.is-merged \{[^}]*var\(--st-done\)/);
    expect(TEMPLATE).toMatch(/\.card-metrics \.card-pr\.is-closed \{[^}]*var\(--st-fail-text\)/);
  });

  it('a state in capitals still reads as that state', () => {
    expect(face.renderCardFace(faceCard({ ...pr, prStatus: 'MERGED' }), 'idle')).toContain('card-pr is-merged');
  });

  it('a short ref in another shape is printed escaped', () => {
    const html = face.renderCardFace(faceCard({ ...pr, prShortRef: '<b>x</b>', prStatus: 'open' }), 'idle');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).not.toContain('<b>x</b>');
  });

  it('an unknown or hostile state renders the bare number', () => {
    const html = face.renderCardFace(faceCard({ ...pr, prStatus: '"><img src=x onerror=alert(1)>' }), 'idle');
    expect(html).toContain('<span class="metric card-pr" title="PR #12 — feat: surfaces">');
    expect(html).not.toMatch(/onerror|<img/);
    expect(face.renderCardFace(faceCard(pr), 'idle')).not.toContain('cpr-state');
  });

  it('no PR, or the links field hidden: no badge', () => {
    expect(face.renderCardFace(faceCard(), 'idle')).not.toContain('card-pr');
    const noLinks = load<Face>(FACE_FNS, FACE_VARS, { ...FACE_ENV, dhShow: (f: string) => f !== 'links' });
    expect(noLinks.renderCardFace(faceCard({ ...pr, prStatus: 'open' }), 'idle')).not.toContain('card-pr');
  });

  it('the face click handler leaves the badge to the toggle (nothing to skip) — it is not interactive', () => {
    expect(clientFn('renderCardPr')).not.toMatch(/<a |<button|onclick|tabindex/);
  });
});

describe('collapsed face — recency on a card that is not moving', () => {
  const face = load<Face>(FACE_FNS, FACE_VARS, FACE_ENV);
  const ts = String(Date.parse(LAST));

  const stamp = (t: number | string) => `<span class="st-ago"><span class="rel-time" data-ts="${t}"></span></span>`;
  const DONE = Date.parse(LAST) + 40 * 60_000; // the turn ran 40 minutes after the last instruction
  const WAIT = Date.parse(LAST) + 30 * 60_000; // the question came 30 minutes in

  it('a finished card counts from when its work finished (finishedAt), not from the last instruction', () => {
    // lastActivity moves on user input only: after a 40-minute turn it would overstate by 40 minutes.
    for (const col of ['idle', 'closed']) {
      const html = face.renderCardFace(faceCard({ finishedAt: DONE, doneAt: DONE }), col);
      expect(html, col).toContain(stamp(DONE));
      expect(html, col).not.toContain(`data-ts="${ts}"`);
    }
    // Only an inferred finish (doneAt from lastActivity, a legacy record): no stamp — never a wrong age.
    expect(face.renderCardFace(faceCard({ doneAt: Date.parse(LAST) }), 'idle')).not.toContain('rel-time');
    expect(face.renderCardFace(faceCard(), 'closed')).not.toContain('rel-time');
  });

  it('a waiting card counts from when it started waiting (waitingSince) — without that stamp, nothing', () => {
    expect(face.renderCardFace(faceCard({ waitingSince: WAIT, doneAt: DONE }), 'waiting')).toContain(stamp(WAIT));
    // A wrong number is worse than none on a triage surface: never the last instruction.
    expect(face.renderCardFace(faceCard(), 'waiting')).not.toContain('rel-time');
  });

  it('a running card shows its live timer instead; an armed resume shows its own time', () => {
    expect(
      face.renderCardFace(faceCard({ activityState: 'working', activeLegStartedAtMs: 5 }), 'working'),
    ).not.toContain('rel-time');
    const resume = faceCard({
      autoResume: { kind: 'retry', at: Date.parse(LAST) + 60_000, attempt: 1, maxAttempts: 3, reason: 'rate limit' },
    });
    expect(face.renderCardFace(resume, 'working')).not.toContain('rel-time');
  });

  it('no clock in the markup: an unparsable stamp shows nothing, equal data renders equal HTML', () => {
    expect(face.renderCardFace(faceCard({ finishedAt: 'not a number' }), 'idle')).not.toContain('rel-time');
    expect(face.renderCardFace(faceCard({ waitingSince: 'x' }), 'waiting')).not.toContain('rel-time');
    const done = faceCard({ finishedAt: Date.parse(LAST) });
    expect(face.renderCardFace(done, 'idle')).toBe(face.renderCardFace(done, 'idle'));
  });
});

describe('collapsed face — the context level is a warning, the panel bar uses the same levels', () => {
  const face = load<Face>(FACE_FNS, FACE_VARS, FACE_ENV);
  const ctx = (pct: number) => faceCard({ tokenUsage: { totalInputTokens: 1, contextUsagePercent: pct } });

  it('over 60% amber, over 80% red with the band in the tooltip; below, the plain number', () => {
    expect(face.ctxLevel(12)).toBe('');
    expect(face.ctxLevel(61)).toBe('ctx-warn');
    expect(face.ctxLevel(81)).toBe('ctx-danger');
    expect(face.ctxLevel('x')).toBe('');
    expect(face.renderCardFace(ctx(12), 'idle')).toContain('<span class="metric" title="Context window used">');
    expect(face.renderCardFace(ctx(65), 'idle')).toContain(
      '<span class="metric ctx-warn" title="Context window used">',
    );
    expect(face.renderCardFace(ctx(90), 'idle')).toContain(
      '<span class="metric ctx-danger" title="Context window used — 80% 넘게 찼다">',
    );
  });

  it('red text clears 4.5:1 on the dimmed (sleeping / archived) card too; a crowded metrics row wraps inside the card', () => {
    expect(TEMPLATE).toMatch(/\.card-metrics \.metric\.ctx-danger \{[^}]*var\(--st-fail-text\)/);
    expect(TEMPLATE).toMatch(/\.card-metrics \.card-pr\.is-closed \{[^}]*var\(--st-fail-text\)/);
    expect(TEMPLATE.match(/--st-fail-text: #[0-9a-f]{6};/g)?.length).toBe(2); // dark and light
    expect(TEMPLATE).toMatch(/\.card-metrics \{[^}]*flex-wrap: wrap;[^}]*max-width: 100%;/);
    expect(TEMPLATE).toMatch(/\.card-foot \{[^}]*flex-wrap: wrap;/);
  });

  it('one threshold table for both surfaces', () => {
    // re-context-window D9/D16: the same ctxLevel, given the auto-compact point, on the face, the summary and the block.
    expect(clientFn('panelInfoHtml')).toContain(
      'ctxLevel(ctx, s.contextTokens, s.autoCompactTokens, s.compactPending)',
    );
    expect(clientFn('contextBlockHtml')).toContain('ctxLevel(pct, used, auto, s.compactPending)');
    expect(clientFn('renderCardFace')).toContain(
      'ctxLevel(ctxPct, s.contextTokens, s.autoCompactTokens, s.compactPending)',
    );
    expect(TEMPLATE).toMatch(/\.card-metrics \.metric\.ctx-warn svg \{[^}]*var\(--st-wait\)/);
    expect(TEMPLATE).toMatch(/\.card-metrics \.metric\.ctx-danger \{[^}]*var\(--st-fail-text\)/);
  });
});
