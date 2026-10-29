/**
 * Spec 12 (agent tree) §4, rev 2 — dashboard client half. Executes the shipped
 * client code cut out of renderDashboardPage()'s template literal and cooked
 * exactly as the browser receives it (the harness of dashboard-agent-inbox-client.test.ts):
 *
 *   §4.0  one node type: the main agent is the root of the session's agent
 *         tree (agentTreeOf), its status from lifecycle evidence
 *   §4.1  collapsed card: one agents row — status dots + "서브에이전트 N · 실행 r · 실패 f"
 *   §4.2  open card: @2lab.ai/ui <ui-agent-tree>, compact (affectUI review
 *         batch 2) — the host contract: the slot markup, the data the
 *         dashboard maps the session onto (atCardData / atTreeData), the folds
 *         it keeps, the events it answers (ui-select, ui-toggle)
 *   §4.3  panel: a drill-down over the same tree (path · focused node header ·
 *         its subtree as a rich <ui-agent-tree>); the focused node scopes Tasks
 *         and the work log; a parent's log carries each child's live block
 *
 * What the element itself does — the WAI-ARIA tree and its keys, the roving
 * tab stop, focus across a live update, the branch roll-up, the folded badge,
 * the waterfall axis, the ticking times, escaping — is owned by the library's
 * suite (@2lab.ai/ui src/components/agent-tree/agent-tree.test.ts); each
 * moved test below names the library test that now covers it.
 */

import { existsSync, readFileSync } from 'node:fs';
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
function assertUnique(name: string) {
  const n = declarationCount(name);
  if (n > 1) throw new Error(`client ${name} is declared ${n} times`);
}
function clientFn(name: string): string {
  assertUnique(name);
  let start = TEMPLATE.indexOf(`\nfunction ${name}(`);
  if (start < 0) start = TEMPLATE.indexOf(`\nasync function ${name}(`);
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
/** A top-level `document.addEventListener('<ev>', function(e) { … });` of the page script. */
function clientListener(ev: string): string {
  const at = TEMPLATE.indexOf(`\ndocument.addEventListener('${ev}', function(e) {`);
  if (at < 0) throw new Error(`listener ${ev} not found`);
  return cook(TEMPLATE.slice(at + 1, TEMPLATE.indexOf('\n});', at) + 4));
}
function load<T>(fns: string[], vars: string[], given: Record<string, unknown> = {}): T {
  // The card header config and the token formatter the tree reads (spec 13), unless a test sets its own.
  const inject: Record<string, unknown> = { dhShow: () => true, formatTokens: (n: number) => String(n), ...given };
  const names = Object.keys(inject);
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}
function fnBody(name: string): string {
  return clientFn(name);
}

const BASE_FNS = ['esc', 'escAttr', 'escJs', 'toNum', 'formatDuration'];
// One node type (recursive UI): the main agent is the root node and goes
// through the same functions as every subagent.
const NODE_FNS = [
  ...BASE_FNS,
  'agentStatusOf',
  'agentName',
  'agentIconHtml',
  'agentTimeHtml',
  'agentActivity',
  'pendingAutoResume',
  'rootStatusOf',
  'agentNodeOf',
  'agentTreeOf',
  'anDesc',
  'agentNodeName',
  'agentNodeLine',
  'agentNodeAria',
  'cardTotalTokens',
  'spendTotal',
  'spendText',
  'spendLabel',
  'spendTitle',
];
// The tree as <ui-agent-tree> takes it (affectUI review batch 2).
const TREE_FNS = [
  ...NODE_FNS,
  'atIdOf',
  'atRootReason',
  'atNode',
  'atTreeData',
  'cardCurrentTask',
  'renderCardTaskRow',
  'atCardData',
  'atSlotHtml',
  'atPaint',
  'atHydrate',
  'renderAgentTree',
];
const AGENT_FNS = [...TREE_FNS, 'agentCounts', 'renderCardAgents'];
const AGENT_VARS = [
  'AGENT_STATUS_LABEL',
  'AGENT_DOTS_MAX',
  'AGENTS_SVG',
  'AT_ROOT',
  'AT_STATUS',
  'AT_ROOT_STATUS',
  '_anOpen',
];

type Agent = Record<string, unknown>;
type Node = Record<string, any> & { id: string; children: Node[] };
/** One node as <ui-agent-tree> takes it (AgentTreeNode). */
type TNode = {
  id: string;
  parentId?: string;
  name: string;
  role?: string;
  status: string;
  startedAt?: number;
  endedAt?: number;
  tokens?: number;
  costUsd?: number;
  toolCalls?: number;
  summary?: string;
  reason?: string;
};
type TreeData = { nodes: TNode[]; density: string; title: string; selectedId: null; expanded: string[] };
interface AgentUi {
  renderCardAgents(s: unknown): string;
  renderAgentTree(s: unknown, col?: string): string;
  agentTreeOf(s: unknown, col?: string, extras?: string[]): Node;
  rootStatusOf(s: unknown, col?: string): string;
  atCardData(s: unknown, col: string): TreeData | null;
  atTreeData(anchor: unknown, o: Record<string, unknown>): TreeData;
  atPaint(el: unknown, d: unknown, sig: string): void;
  atHydrate(body: unknown, p: unknown): void;
}
const ui = load<AgentUi>(AGENT_FNS, AGENT_VARS);

const T0 = 1_700_000_000_000;
const AGENTS: Agent[] = [
  {
    id: 'toolu_explore',
    n: 1,
    type: 'Explore',
    description: 'Trace subagent frames',
    status: 'running',
    startedAt: T0,
    toolCalls: 18,
    background: true,
    tasks: [
      { id: 'T1', content: 'Read the mapper', activeForm: 'Reading the mapper', status: 'in_progress', toolCalls: 4 },
    ],
  },
  {
    id: 'toolu_nested',
    n: 3,
    parentId: 'toolu_explore',
    type: 'general-purpose',
    description: 'Nested look',
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
  model: 'claude-opus-5-5[1m]',
  activityState: 'working',
  activeLegStartedAtMs: T0,
  activeAccumulatedMs: 0,
  agentRoot: { toolCalls: 7, lastTool: 'Edit' },
  lastActivity: new Date(T0 + 300_000).toISOString(),
  tasks: [
    { id: 'T1', content: 'Plan', status: 'completed', toolCalls: 2 },
    { id: 'T2', content: 'Build', status: 'in_progress', toolCalls: 5 },
  ],
  agents: AGENTS,
  agentsTotal: 3,
  ...over,
});

describe('collapsed card agents row (§4.1)', () => {
  it('says how many subagents run and failed — in words, the dots are extra', () => {
    const html = ui.renderCardAgents(card());
    expect(html).toContain('class="card-agents"');
    expect(html).toContain('서브에이전트 <b>3</b>');
    expect(html).toContain('실행 1');
    expect(html).toContain('<span class="ca-fail">실패 1</span>');
    expect(html.match(/class="ag-dot /g)).toHaveLength(3);
    expect(html).toContain('ag-dot is-running');
    expect(html).toContain('title="서브에이전트 3, 실행 1, 실패 1"');
  });

  it('caps the dots and counts the agents beyond the card', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ id: `a${i}`, n: i + 1, status: 'completed', startedAt: T0 }));
    const html = ui.renderCardAgents(card({ agents: many, agentsTotal: 12 }));
    expect(html.match(/class="ag-dot /g)).toHaveLength(6);
    expect(html).toContain('+3');
    expect(html).toContain('서브에이전트 <b>12</b>');
    expect(html).not.toContain('실행');
    expect(html).not.toContain('실패');
  });

  it('a card without subagents has no row', () => {
    expect(ui.renderCardAgents(card({ agents: undefined }))).toBe('');
    expect(ui.renderCardAgents(card({ agents: [] }))).toBe('');
  });
});

describe('one node type — the main agent is the root of the session’s agent tree', () => {
  it('agentTreeOf: the session is the root node; subagents hang by parentId, in spawn order', () => {
    const root = ui.agentTreeOf(
      card({
        agents: [
          ...AGENTS,
          { id: 'orphan', n: 9, parentId: 'gone', status: 'unknown', startedAt: T0 },
          { id: 'x', n: 10, parentId: 'y', status: 'completed', startedAt: T0 },
          { id: 'y', n: 11, parentId: 'x', status: 'completed', startedAt: T0 },
        ],
      }),
      'working',
      ['logonly'],
    );
    expect(root).toMatchObject({ id: '', root: true, status: 'running', toolCalls: 7, lastTool: 'Edit' });
    expect(root.children.map((c) => c.id)).toEqual(['toolu_explore', 'toolu_lib', 'orphan', 'x', 'logonly']);
    expect(root.children[0].children.map((c) => c.id)).toEqual(['toolu_nested']);
    // A parent cycle never loses an agent: it is reached once, under the root.
    expect(root.children[3].children.map((c) => c.id)).toEqual(['y']);
    // An agent known only from the log is a node too — status unknown.
    expect(root.children[4]).toMatchObject({ id: 'logonly', status: 'unknown', logOnly: true });
    // Same fields on every node: id, status, toolCalls, tasks, children.
    for (const n of [root, root.children[0], root.children[0].children[0]]) {
      expect(Object.keys(n)).toEqual(expect.arrayContaining(['id', 'status', 'toolCalls', 'children']));
    }
    expect(root.byId.toolu_nested.parentId).toBe('toolu_explore');
    expect(root.byId.toolu_explore.parentId).toBe('');
  });

  it('the root status comes from lifecycle evidence — never "stopped" for a closed card', () => {
    const st = (over: Record<string, unknown>, col: string) => ui.rootStatusOf(card(over), col);
    expect(st({ activityState: 'working' }, 'working')).toBe('running');
    expect(st({ activityState: 'waiting' }, 'waiting')).toBe('waiting');
    expect(st({ activityState: 'idle' }, 'idle')).toBe('idle');
    expect(st({ activityState: 'idle', terminated: false }, 'closed')).toBe('sleeping');
    expect(st({ activityState: 'idle', terminated: true }, 'closed')).toBe('archived');
    // A RUNNING card waiting out an armed retry is not running a turn.
    expect(st({ activityState: 'idle', autoResume: { kind: 'turn-retry', at: T0 } }, 'working')).toBe('resuming');
    // The same order as the card's status line: a waiting card reads waiting even while its activity says working;
    // an archived session off the board is archived whatever column it falls back to (review r1 fable).
    expect(st({ activityState: 'working' }, 'waiting')).toBe('waiting');
    expect(st({ activityState: 'idle', terminated: true }, 'idle')).toBe('archived');
  });
});

describe('the open card’s tree is <ui-agent-tree> (affectUI review batch 2) — the host contract', () => {
  const KEY = 'inst::C1:t1';
  const NS = `c|${KEY}`;
  const chain = (): Agent[] => [
    { id: 'a', n: 1, type: 'Explore', status: 'running', startedAt: T0, toolCalls: 1 },
    { id: 'b', n: 2, parentId: 'a', type: 'general-purpose', status: 'running', startedAt: T0 + 1, toolCalls: 2 },
    { id: 'c', n: 3, parentId: 'b', type: 'librarian', status: 'running', startedAt: T0 + 2, toolCalls: 3 },
    {
      id: 'd',
      n: 4,
      parentId: 'c',
      type: 'Plan',
      status: 'completed',
      startedAt: T0 + 3,
      endedAt: T0 + 9,
      toolCalls: 4,
    },
  ];
  const nodeOf = (d: TreeData | null, id: string) => d?.nodes.find((n) => n.id === id);

  it('replaces the inline renderer: its functions, its state and its CSS are gone', () => {
    for (const gone of [
      'agentNodeRow',
      'renderAgentNode',
      'renderAgentNodes',
      'anTreeHtml',
      'anIsOpen',
      'anCompactLine',
      'anIdPart',
      'anTimeId',
      'anClick',
      'anKeyAction',
      'anOnKey',
      'anActivate',
      'anSetStop',
      'anMoveStop',
      'anFocusCapture',
      'anFocusRestore',
      'anItemId',
      'anItemKey',
      'toggleAgentNode',
      'showAllAgentChildren',
      'anRepaint',
      'openPanelAgent',
      'agentSpanAxis',
      'agentSpanStyle',
      'AGENT_TREE_ROWS',
      'AN_CHEV_SVG',
      'AN_LIVE_LINE',
      '_anAll',
      '_anActive',
      '_anReturnFocus',
      '_anScopeChange',
    ])
      expect(declarationCount(gone), gone).toBe(0);
    const CSS = TEMPLATE.slice(TEMPLATE.indexOf('<style>'), TEMPLATE.indexOf('</style>'));
    for (const rule of [
      '.an-row',
      '.an-kids',
      '.an-chev',
      '.an-all',
      '.ag-span',
      '.ag-head',
      '.pa-kids-head',
      'agSweep',
    ])
      expect(CSS, rule).not.toContain(rule);
    // No tree markup or tree key handling is left in the page script.
    expect(TEMPLATE).not.toContain('data-agent-open');
    expect(TEMPLATE).not.toContain('.an-tree');
  });

  it('the page loads the element as a module script; the installed @2lab.ai/ui carries it and its chunks', async () => {
    // The first import of the dashboard module transforms 21k lines — seconds on a loaded runner, so this test gets 60 s.
    const HEAD = TEMPLATE.slice(0, TEMPLATE.indexOf('<style>'));
    expect(HEAD).toContain(`<script type="module" src="/dashboard/ui/agent-tree.js?v=\${UI_LIB_VERSION}"></script>`);
    const { UI_LIB_FILE, uiLibDistDir } = await import('../dashboard');
    const dir = uiLibDistDir() as string;
    expect(existsSync(join(dir, 'agent-tree.js'))).toBe(true);
    for (const imp of readFileSync(join(dir, 'agent-tree.js'), 'utf-8').match(/from\s*"\.\/([^"]+)"/g) ?? []) {
      const file = /"\.\/([^"]+)"/.exec(imp)?.[1] as string;
      expect(UI_LIB_FILE.test(file), file).toBe(true);
      expect(existsSync(join(dir, file)), file).toBe(true);
    }
  }, 60_000);

  it('the card body carries a slot per session — static markup, so a moving agent never rewrites the body', () => {
    const html = ui.renderAgentTree(card(), 'working');
    expect(html).toBe(
      '<div class="ag-tree ui-tok"><ui-agent-tree lang="ko" data-at-ns="c|inst::C1:t1">' +
        '<span class="at-fallback">에이전트 — 메인 + 3</span></ui-agent-tree></div>',
    );
    // Statuses, tool counts and spend are data, not markup.
    const moved = AGENTS.map((a) => ({ ...a, status: 'completed', toolCalls: 99 }));
    expect(ui.renderAgentTree(card({ agents: moved }), 'working')).toBe(html);
    // Agents beyond the card's bound are named under it; a hostile key is an attribute value; none → no tree.
    expect(ui.renderAgentTree(card({ agentsTotal: 7 }), 'working')).toContain(
      '<div class="ag-more">이전 에이전트 4개는 카드 목록 밖 — 작업 로그에서 볼 수 있어요</div>',
    );
    expect(ui.renderAgentTree(card({ key: 'k"><img src=x>' }), 'working')).toContain(
      'data-at-ns="c|k&quot;&gt;&lt;img src=x&gt;"',
    );
    expect(ui.renderAgentTree(card({ agents: [] }), 'working')).toBe('');
    expect(fnBody('renderCardBody')).toContain('const agentsHtml = renderAgentTree(s, col);');
  });

  it('atCardData: the main agent first, every subagent under the agent that started it, in spawn order — compact', () => {
    const d = ui.atCardData(card(), 'working') as TreeData;
    expect(d).toMatchObject({ density: 'compact', title: '에이전트', selectedId: null });
    expect(d.nodes.map((n) => [n.id, n.parentId ?? ''])).toEqual([
      [':main', ''],
      ['toolu_explore', ':main'],
      ['toolu_nested', 'toolu_explore'],
      ['toolu_lib', ':main'],
    ]);
    // The root: 메인, its tool count, its active time running from the open leg; the face's task row already
    // names #T2, so the root does not say it again (spec 13).
    expect(nodeOf(d, ':main')).toEqual({ id: ':main', name: '메인', status: 'running', toolCalls: 7, startedAt: T0 });
    // A subagent: A<n> type, its brief as the role (background said), what it does now.
    expect(nodeOf(d, 'toolu_explore')).toEqual({
      id: 'toolu_explore',
      parentId: ':main',
      name: 'A1 Explore',
      role: '배경 · Trace subagent frames',
      status: 'running',
      toolCalls: 18,
      startedAt: T0,
      summary: '#T1 Reading the mapper',
    });
    // Finished: its run time is endedAt − startedAt; failed / done / stopped read as the element's words.
    expect(nodeOf(d, 'toolu_lib')).toMatchObject({ status: 'done', startedAt: T0 + 5_000, endedAt: T0 + 247_000 });
    expect(nodeOf(d, 'toolu_nested')).toMatchObject({ status: 'failed', endedAt: T0 + 51_000, role: 'Nested look' });
    const stopped = ui.atCardData(card({ agents: [{ ...AGENTS[2], status: 'stopped' }] }), 'working') as TreeData;
    expect(nodeOf(stopped, 'toolu_lib')?.status).toBe('cancelled');
    // No subagents → no tree on the card.
    expect(ui.atCardData(card({ agents: [] }), 'working')).toBeNull();
  });

  it('why a node needs you or failed sits on it: the main agent’s prompt or question, a subagent’s last report', () => {
    const perm = ui.atCardData(
      card({
        activityState: 'waiting',
        pendingPermissions: [
          { approvalId: 'p1', toolName: 'Bash' },
          { approvalId: 'p2', toolName: 'Edit' },
        ],
      }),
      'waiting',
    );
    expect(nodeOf(perm, ':main')).toMatchObject({ status: 'needs_you', reason: 'Bash 실행 승인 필요 외 1건' });
    const ask = ui.atCardData(card({ activityState: 'waiting', pendingQuestion: { question: 'Ship it?' } }), 'waiting');
    expect(nodeOf(ask, ':main')).toMatchObject({ status: 'needs_you', reason: 'Ship it?' });
    // A failed subagent: what it last reported is the reason (never also its line).
    const failed = ui.atCardData(card({ agents: [{ ...AGENTS[1], summary: '2 tests failed' }] }), 'working');
    expect(nodeOf(failed, 'toolu_nested')).toMatchObject({ status: 'failed', reason: '2 tests failed' });
    expect(nodeOf(failed, 'toolu_nested')).not.toHaveProperty('summary');
    // A running one has no reason.
    expect(nodeOf(ui.atCardData(card(), 'working'), 'toolu_explore')).not.toHaveProperty('reason');
  });

  it("the root's time: the open leg keeps counting while the turn waits on a permission; idle, the active total", () => {
    const waiting = ui.atCardData(card({ activityState: 'waiting', activeAccumulatedMs: 65_000 }), 'waiting');
    expect(nodeOf(waiting, ':main')).toMatchObject({ status: 'needs_you', startedAt: T0 - 65_000 });
    expect(nodeOf(waiting, ':main')).not.toHaveProperty('endedAt');
    const idle = ui.atCardData(
      card({ activityState: 'idle', activeLegStartedAtMs: 0, activeAccumulatedMs: 65_000 }),
      'idle',
    );
    expect(nodeOf(idle, ':main')).toMatchObject({ status: 'waiting', startedAt: 0, endedAt: 65_000 });
    // A resume waits for the system, a closed session is done.
    const resuming = ui.atCardData(
      card({ activityState: 'idle', autoResume: { kind: 'turn-retry', at: T0 } }),
      'working',
    );
    expect(nodeOf(resuming, ':main')?.status).toBe('waiting');
    expect(nodeOf(ui.atCardData(card({ activityState: 'idle' }), 'closed'), ':main')?.status).toBe('done');
  });

  it("spend: a subagent's own (all token kinds, API-equivalent cost); the root's own share of the task total", () => {
    const SPEND = {
      inputTokens: 100,
      outputTokens: 200,
      cacheReadTokens: 9700,
      cacheCreateTokens: 0,
      costUsd: 1.234,
      calls: 5,
    };
    const d = ui.atCardData(
      card({
        agents: [
          { ...AGENTS[0], tokens: 134, spend: SPEND },
          // Calls that reported no usage are not a $0 spend: the node carries none.
          { ...AGENTS[1], spend: { ...SPEND, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 } },
          AGENTS[2],
        ],
        tokenUsage: {
          totalInputTokens: 1000,
          totalOutputTokens: 1000,
          totalCacheReadTokens: 8000,
          totalCacheCreateTokens: 0,
          totalCostUsd: 3.5,
        },
        subagentSpend: {
          agents: 3,
          inputTokens: 100,
          outputTokens: 100,
          cacheReadTokens: 800,
          cacheCreateTokens: 0,
          costUsd: 0.75,
        },
      }),
      'working',
    );
    // Never the SDK's context size (tokens: 134).
    expect(nodeOf(d, 'toolu_explore')).toMatchObject({ tokens: 10_000, costUsd: 1.234 });
    expect(nodeOf(d, 'toolu_nested')).not.toHaveProperty('costUsd');
    expect(nodeOf(d, 'toolu_nested')).not.toHaveProperty('tokens');
    // The task total less the subagents' share: the element adds the branch up again.
    expect(nodeOf(d, ':main')).toMatchObject({ tokens: 9_000, costUsd: 2.75 });
    // Subagent cost estimates above the session total: the root keeps its tokens, never a false $0.
    const over = ui.atCardData(
      card({
        tokenUsage: {
          totalInputTokens: 1000,
          totalOutputTokens: 1000,
          totalCacheReadTokens: 0,
          totalCacheCreateTokens: 0,
          totalCostUsd: 0.5,
        },
        subagentSpend: {
          agents: 3,
          inputTokens: 100,
          outputTokens: 100,
          cacheReadTokens: 0,
          cacheCreateTokens: 0,
          costUsd: 0.75,
        },
      }),
      'working',
    );
    expect(nodeOf(over, ':main')).toMatchObject({ tokens: 1_800 });
    expect(nodeOf(over, ':main')).not.toHaveProperty('costUsd');
  });

  it("the root's line is its current task only while the face's task row does not show it (spec 13)", () => {
    expect(nodeOf(ui.atCardData(card(), 'working'), ':main')).not.toHaveProperty('summary');
    const noTask = card({ tasks: [{ id: 'T1', content: 'Plan', status: 'completed' }] });
    expect(nodeOf(ui.atCardData(noTask, 'working'), ':main')?.summary).toBe('마지막 도구 Edit');
    const hidden = load<AgentUi>(AGENT_FNS, AGENT_VARS, { dhShow: () => false });
    expect(nodeOf(hidden.atCardData(card(), 'working'), ':main')?.summary).toBe('#T2 Build');
  });

  it('folds are the host’s: the root and its children start open, deeper parents folded; a toggle is kept per tree and node', () => {
    const anOpen: Record<string, boolean> = {};
    const m = load<AgentUi>(
      AGENT_FNS,
      AGENT_VARS.filter((v) => v !== '_anOpen'),
      { _anOpen: anOpen },
    );
    expect(m.atCardData(card({ agents: chain() }), 'working')?.expanded).toEqual([':main', 'a']);
    anOpen[`${NS}|b`] = true;
    anOpen[`${NS}|a`] = false;
    expect(m.atCardData(card({ agents: chain() }), 'working')?.expanded).toEqual([':main', 'b']);
    // Another session's tree keeps its own folds.
    expect(m.atCardData(card({ key: 'other', agents: chain() }), 'working')?.expanded).toEqual([':main', 'a']);
  });

  it('a parent cycle of any length is broken — every agent is a node exactly once (review r1 astra)', () => {
    const ring = Array.from({ length: 65 }, (_, i) => ({
      id: `r${i}`,
      n: i + 1,
      parentId: `r${(i + 1) % 65}`,
      status: 'completed',
      startedAt: T0 + i,
    }));
    const d = ui.atCardData(card({ agents: ring }), 'working') as TreeData;
    const ids = d.nodes.map((n) => n.id);
    expect(ids).toHaveLength(66);
    expect(new Set(ids).size).toBe(66);
    for (const n of d.nodes) if (n.parentId) expect(ids).toContain(n.parentId);
    const desc = load<{ anDesc(n: unknown): { n: number } }>(['anDesc'], []);
    expect(desc.anDesc(ui.agentTreeOf(card({ agents: ring }), 'working')).n).toBe(65);
  });

  it('the data travels with the card’s parts: a tree-only change is a change, painted where it changed', () => {
    const parts = load<{
      cardParts(s: unknown, col: string): Record<string, unknown>;
      cardPartsDiffer(el: unknown, p: unknown): boolean;
    }>([...AGENT_FNS, 'cardParts', 'cardPartsDiffer'], AGENT_VARS, {
      cardState: () => 'working',
      renderCardFace: () => 'face',
      renderCardBody: () => 'body',
    });
    const p = parts.cardParts(card(), 'working');
    expect(p.tree).toEqual(ui.atCardData(card(), 'working'));
    expect(p.treeSig).toBe(JSON.stringify(p.tree));
    const el = {
      getAttribute: (n: string) => (n === 'data-col' ? 'working' : 'working'),
      _faceHtml: 'face',
      _bodyHtml: 'body',
      _treeSig: p.treeSig,
    };
    expect(parts.cardPartsDiffer(el, p)).toBe(false);
    const moved = parts.cardParts(card({ agents: [{ ...AGENTS[0], toolCalls: 19 }, AGENTS[1], AGENTS[2]] }), 'working');
    expect(moved.body).toBe(p.body);
    expect(parts.cardPartsDiffer(el, moved)).toBe(true);
    expect(fnBody('applyCardParts')).toContain('atHydrate(el._bodyEl, p);');
    expect(parts.cardParts(card({ agents: [] }), 'working')).toMatchObject({ tree: null, treeSig: '' });
  });

  it('atPaint / atHydrate set the element’s data only where it changed (a push that changes nothing writes nothing)', () => {
    let writes = 0;
    const tree: Record<string, unknown> = {};
    Object.defineProperty(tree, 'data', {
      set() {
        writes++;
      },
    });
    const body = { querySelector: (sel: string) => (sel === 'ui-agent-tree[data-at-ns]' ? tree : null) };
    const d = ui.atCardData(card(), 'working');
    ui.atHydrate(body, { tree: d, treeSig: 'a' });
    ui.atHydrate(body, { tree: d, treeSig: 'a' });
    expect(writes).toBe(1);
    ui.atPaint(tree, d, 'b');
    expect(writes).toBe(2);
    ui.atHydrate(body, { tree: null, treeSig: '' });
    ui.atHydrate({}, { tree: d, treeSig: 'c' });
    expect(writes).toBe(2);
  });

  describe('events: ui-select and ui-toggle', () => {
    const tree = (ns: string) => ({
      tagName: 'UI-AGENT-TREE',
      getAttribute: (n: string) => (n === 'data-at-ns' ? ns : null),
    });
    function listener(ev: string, inject: Record<string, unknown>) {
      const handlers: Array<(e: unknown) => void> = [];
      const doc = {
        addEventListener: (name: string, fn: (e: unknown) => void) => {
          if (name === ev) handlers.push(fn);
        },
        querySelector: inject.querySelector ?? (() => null),
      };
      const names = Object.keys(inject).filter((n) => n !== 'querySelector');
      new Function('document', ...names, `${clientVar('AT_ROOT')}\n${clientListener(ev)}`)(
        doc,
        ...names.map((n) => inject[n]),
      );
      return handlers[0];
    }

    it('card: a picked agent opens the panel on it — the main agent is the panel’s root; by keyboard focus lands there', () => {
      const calls: unknown[][] = [];
      const on = (keyed: boolean) =>
        listener('ui-select', {
          openPanel: (...a: unknown[]) => calls.push(a),
          selectPanelAgent: () => calls.push(['select']),
          _atKeyed: keyed,
        });
      on(false)({ target: tree(NS), detail: { id: 'toolu_explore' } });
      on(true)({ target: tree(NS), detail: { id: ':main' } });
      expect(calls).toEqual([
        [KEY, 'agent', 'toolu_explore', false],
        [KEY, 'agent', '', true],
      ]);
      // openPanel's keyboard landing for 'agent' is the node's header; closing gives focus back to the opener —
      // the tree's host element (its focus() is the tree's tab stop).
      expect(fnBody('focusPanelLanding')).toContain(
        "else if (_panelLand === 'agent') t = document.querySelector('#panel-agents .pa-focus');",
      );
      expect(fnBody('closePanel')).toContain('var back = _panelReturnFocus;');
      // Another element's ui-select is not the tree's.
      on(false)({ target: { tagName: 'UI-OTHER', getAttribute: () => NS }, detail: { id: 'x' } });
      expect(calls).toHaveLength(2);
      // The input modality: a key or a pointer, caught before the element sees it.
      expect(TEMPLATE).toContain("document.addEventListener('keydown', function() { _atKeyed = true; }, true);");
      expect(TEMPLATE).toContain("document.addEventListener('pointerdown', function() { _atKeyed = false; }, true);");
    });

    it('panel: a picked agent is drilled into and its header takes focus (review r2 astra: a chosen drill lands on the header)', () => {
      const calls: unknown[] = [];
      const head = { focus: () => calls.push('focus head') };
      listener('ui-select', {
        openPanel: () => calls.push('open'),
        selectPanelAgent: (id: string) => calls.push(`select ${id}`),
        _atKeyed: false,
        querySelector: (sel: string) => (sel === '#panel-agents .pa-focus' ? head : null),
      })({ target: tree('p|k'), detail: { id: 'toolu_nested' } });
      expect(calls).toEqual(['select toolu_nested', 'focus head']);
    });

    it('ui-toggle: the fold is kept per tree and node, and that tree repaints with it', () => {
      const anOpen: Record<string, boolean> = {};
      const calls: string[] = [];
      const on = listener('ui-toggle', {
        _anOpen: anOpen,
        refreshCard: (k: string) => calls.push(`card ${k}`),
        // SSOT 2026-10-29: the panel's tree is the 에이전트 트리 section tab.
        paintTreeTab: () => calls.push('panel'),
      });
      on({ target: tree(NS), detail: { id: 'b', expanded: true } });
      on({ target: tree('p|k'), detail: { id: 'c', expanded: false } });
      expect(anOpen).toEqual({ [`${NS}|b`]: true, 'p|k|c': false });
      expect(calls).toEqual([`card ${KEY}`, 'panel']);
    });
  });

  // Moved to the library (@2lab.ai/ui src/components/agent-tree/agent-tree.test.ts), which owns them now:
  //   roving tab stop, levels, set sizes          → 'renders a WAI-ARIA tree: levels, set sizes, one tab stop, …'
  //   arrow keys (APG), Home / End, Enter         → 'keyboard: arrows, Home / End, ← / → fold and move, * opens siblings, Enter selects'
  //   clicks: the chevron folds, a row selects    → 'click selects (ui-select, cancelable); …', 'the fold control toggles (ui-toggle); …'
  //   focus kept across a live update             → 'a live update morphs: the focused item stays the same element; …'
  //   +N with the worst status below              → 'the fold control toggles (ui-toggle); folded shows +N with the worst status below …'
  //   compact rows: status word, the live line    → 'compact: rows with status words; the line only on live / failed ones, the reason first'
  //   the waterfall axis (§4.2)                   → 'durations run while open, spans sit on one axis'
  //   description ids never collide               → 'fmtCost, initials and idPart'
  //   hostile text is text                        → 'escapes every host string'
  //   the 1 s clock                               → 'running times tick on one shared timer, stop when nothing runs and on disconnect'
});

describe('panel scope (§4.3)', () => {
  const E = (seq: number, extra: Record<string, unknown> = {}) => ({
    seq,
    ts: 0,
    kind: 'tool',
    text: `e${seq}`,
    ...extra,
  });
  const LOG = [
    E(1, { kind: 'instruction', text: 'go' }),
    E(2, { tool: 'Agent', agentRef: 'toolu_explore', taskId: 'T2', taskTitle: 'Build' }),
    E(3, { tool: 'Grep', agentId: 'toolu_explore', taskId: 'T1', taskTitle: 'Read the mapper' }),
    E(4, { kind: 'tool_result', tool: 'Grep', agentId: 'toolu_explore', ok: true }),
    E(5, { kind: 'tool_result', tool: 'Agent', agentRef: 'toolu_explore', ok: true, taskId: 'T2' }),
    E(6, { tool: 'Bash', taskId: 'T2', taskTitle: 'Build' }),
  ];
  function scope(agent: string, cardAgents: Agent[] = AGENTS) {
    const m = load<{ wlScopeEntries(e: unknown[]): any[] }>(
      ['agentStatusOf', 'panelAgentOf', 'wlScopeEntry', 'wlScopeEntries'],
      ['AGENT_STATUS_LABEL'],
      {
        _panelAgent: agent,
        panelSessionKey: 'k',
        _sessionCache: { k: { agents: cardAgents } },
      },
    );
    return m.wlScopeEntries(LOG);
  }

  it("the main agent's scope holds only entries without an agentId — the spawn call included", () => {
    expect(scope('').map((e) => e.seq)).toEqual([1, 2, 5, 6]);
  });

  it("a subagent's scope: its own entries, plus its spawn (지시) and result outside any task", () => {
    const fg = scope('toolu_explore', [{ ...AGENTS[0], background: false }]);
    expect(fg.map((e) => [e.seq, e._role ?? '', e.taskId ?? ''])).toEqual([
      [2, 'spawn', ''],
      [3, '', 'T1'],
      [4, '', ''],
      [5, 'result', ''],
    ]);
    // A background agent's spawn result only acknowledges the start.
    expect(scope('toolu_explore').find((e) => e.seq === 5)?._role).toBe('ack');
    // The stored entries are never rewritten.
    expect(LOG[1]).toHaveProperty('taskId', 'T2');
  });

  it('rows say 지시 / 결과 / 배경 실행 시작 in a subagent scope', () => {
    const r = load<{ renderWorkLogEntry(e: unknown): string }>(
      [...NODE_FNS, 'decodeSlackEntities', 'wlChildBlock', 'wlToolSummary', 'renderWorkLogEntry'],
      [...AGENT_VARS, 'WL_LABELS'],
      { panelSessionKey: 'k', _sessionCache: { k: card() } },
    );
    expect(r.renderWorkLogEntry({ ...LOG[1], _role: 'spawn' })).toContain('<span class="wl-role">지시</span>');
    expect(r.renderWorkLogEntry({ ...LOG[4], _role: 'result' })).toContain('<span class="wl-role">결과</span>');
    expect(r.renderWorkLogEntry({ ...LOG[4], _role: 'ack' })).toContain('<span class="wl-role">배경 실행 시작</span>');
    expect(r.renderWorkLogEntry({ ...LOG[1], _role: 'spawn' })).not.toContain('wl-agent-link');
    expect(r.renderWorkLogEntry(LOG[4])).not.toContain('wl-agent-link');
  });

  it('a failed background spawn result is not labelled a background start (review B-P2)', () => {
    const failed = { ...LOG[4], ok: false };
    const m = load<{ wlScopeEntries(e: unknown[]): any[] }>(
      ['agentStatusOf', 'panelAgentOf', 'wlScopeEntry', 'wlScopeEntries'],
      ['AGENT_STATUS_LABEL'],
      {
        _panelAgent: 'toolu_explore',
        panelSessionKey: 'k',
        _sessionCache: { k: { agents: AGENTS } },
      },
    );
    expect(m.wlScopeEntries([failed]).map((e) => e._role)).toEqual(['result']);
  });

  it('agents known only from the log (their own entries or a spawn/result) are listed (review B-P2)', () => {
    const m = load<{ panelLogOnlyAgents(s: unknown): string[] }>(['panelLogOnlyAgents'], [], {
      _wl: {
        entries: [E(1, { agentId: 'onlyOwn' }), E(2, { agentRef: 'onlyRef' }), E(3, { agentRef: 'toolu_explore' })],
      },
    });
    expect(m.panelLogOnlyAgents({ agents: AGENTS })).toEqual(['onlyOwn', 'onlyRef']);
  });

  it('entries naming an agent the bar does not show — by agentId or agentRef — refresh it, from any paint (review B r2)', () => {
    const m = load<{ wlNamesNewAgent(a: unknown[]): boolean }>(['wlNamesNewAgent'], [], {
      _panelAgentIdsShown: { toolu_known: true },
    });
    const A = (extra: Record<string, unknown>) => ({ entry: E(1, extra), index: 0 });
    expect(m.wlNamesNewAgent([A({ agentRef: 'toolu_new' })])).toBe(true);
    expect(m.wlNamesNewAgent([A({ agentId: 'toolu_new' })])).toBe(true);
    expect(m.wlNamesNewAgent([A({ agentRef: 'toolu_known' }), A({ agentId: 'toolu_known' }), A({})])).toBe(false);
    // Live entries, older pages and recovery merges all paint through paintWorkLog — whichever
    // section tab is shown (SSOT 2026-10-29: the bar, and the 에이전트 트리 tab when it is the one shown).
    const paint = fnBody('paintWorkLog');
    expect(paint).toMatch(/if \(wlNamesNewAgent\(added\)\) \{\s*renderPanelAgents\(\);\s*if \(_psec === 'tree'\) paintTreeTab\(\);/);
    expect(paint.indexOf('wlNamesNewAgent(added)')).toBeLessThan(paint.indexOf("if (_psec !== 'log' || !list || !box)"));
  });

  it('closing the panel forgets the agent bar it last wrote (review B r2)', () => {
    expect(fnBody('closePanel')).toContain("_panelAgentsHtml = '';");
  });

  it('a log from before attribution that started subagents is flagged, an attributed one is not', () => {
    const m = load<{ wlLegacyMixed(e: unknown[]): boolean }>(['wlLegacyMixed'], []);
    expect(m.wlLegacyMixed([E(1, { tool: 'Agent' }), E(2, { tool: 'Grep' })])).toBe(true);
    expect(m.wlLegacyMixed([E(1, { tool: 'Agent', attributed: true })])).toBe(false);
    expect(m.wlLegacyMixed([E(1, { tool: 'Grep' })])).toBe(false);
  });

  it("the panel's tasks follow the chosen agent", () => {
    const m = load<{ panelAgentTasks(): unknown; panelAgentLabel(): string }>(
      ['toNum', 'agentName', 'panelAgentOf', 'panelAgentTasks', 'panelAgentLabel'],
      [],
      { panelSessionKey: 'k', _sessionCache: { k: card() }, _panelAgent: 'toolu_explore' },
    );
    expect(m.panelAgentTasks()).toEqual(AGENTS[0].tasks);
    expect(m.panelAgentLabel()).toBe('A1 Explore');
    const main = load<{ panelAgentTasks(): unknown; panelAgentLabel(): string }>(
      ['toNum', 'agentName', 'panelAgentOf', 'panelAgentTasks', 'panelAgentLabel'],
      [],
      { panelSessionKey: 'k', _sessionCache: { k: card() }, _panelAgent: '' },
    );
    expect(main.panelAgentTasks()).toEqual(card().tasks);
    expect(main.panelAgentLabel()).toBe('');
  });

  it('wiring: openPanel takes the agent, the scope switch repaints Tasks and the section shown', () => {
    expect(fnBody('openPanel')).toContain("_panelAgent = agentId ? String(agentId) : '';");
    // Spec 13: openPanel goes through the one live path (repaintPanelSession → repaintPanelScope).
    expect(fnBody('openPanel')).toContain('repaintPanelSession();');
    expect(fnBody('repaintPanelScope')).toContain('renderPanelAgents();');
    expect(fnBody('repaintPanelScope')).toContain('repaintPanelTasks();');
    expect(fnBody('selectPanelAgent')).toContain('repaintPanelTasks();');
    // SSOT 2026-10-29: the section tab shown stays and is painted again for the new scope.
    expect(fnBody('selectPanelAgent')).toContain('selectPanelSection(_psec);');
    expect(fnBody('paintLogTab')).toContain('wlRenderList(st, list);');
    // Paired tool results live in their call's card (wlVisible), so they are not rows.
    expect(fnBody('wlRenderList')).toContain('wlBuildRows(wlVisible(state, wlScopeEntries(state.entries)))');
    // This agent's log empty (entries of others only): the empty line, on a live paint and on a tab paint.
    expect(fnBody('paintWorkLog')).toContain(
      "if (!wlScopeEntries(state.entries).length) showWorkLogEmpty('이 에이전트의 작업 로그 없음');",
    );
    expect(fnBody('paintLogTab')).toContain(
      "if (!wlScopeEntries(st.entries).length) showWorkLogEmpty('이 에이전트의 작업 로그 없음');",
    );
    // The pill counts what the list shows: a paired result lives in its call's card.
    expect(fnBody('paintWorkLog')).toContain('wlVisible(state, wlScopeEntries(added.map(');
    expect(fnBody('renderCardFace')).toContain('+ renderCardAgents(s)');
    expect(fnBody('renderCardBody')).toContain('const agentsHtml = renderAgentTree(s, col);');
    expect(TEMPLATE).toContain('<div class="panel-agents" id="panel-agents" style="display:none"></div>');
  });
});

describe('panel — the path · the focused node, and the 에이전트 트리 tab over the same node type', () => {
  const PANEL_FNS = [
    ...NODE_FNS,
    'renderAgentFocus',
    'panelLogOnlyAgents',
    'sessionColOf',
    'atIdOf',
    'atRootReason',
    'atNode',
    'atTreeData',
    'atSlotHtml',
    'atPaint',
    'renderPanelAgents',
  ];
  function panel(focus: string, s: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    // Task view T1.6: #panel-agents carries is-main while the Main tab is focused.
    const classes = new Set<string>();
    const out = { html: '', writes: 0, sets: 0, data: null as TreeData | null };
    // The subtree's element: the data it was given, how often.
    const tree: Record<string, unknown> = {};
    Object.defineProperty(tree, 'data', {
      set(v: TreeData) {
        out.sets++;
        out.data = v;
      },
    });
    const el = {
      style: {} as Record<string, string>,
      innerHTML: '',
      classes,
      classList: {
        toggle(c: string, on: boolean) {
          if (on) classes.add(c);
          else classes.delete(c);
        },
      },
      querySelector: (sel: string) => (sel === 'ui-agent-tree' && out.html.includes('<ui-agent-tree') ? tree : null),
    };
    const m = load<{ renderPanelAgents(): void }>(
      PANEL_FNS,
      AGENT_VARS.filter((v) => !(v in extra)),
      {
        document: { getElementById: (id: string) => (id === 'panel-agents' ? el : null), activeElement: null },
        panelSessionKey: 'k',
        _sessionCache: { k: s },
        _lastBoardData: { working: [s] },
        _panelAgent: focus,
        _panelAgentIdsShown: {},
        _wl: { entries: [] },
        _panelAgentsHtml: '',
        formatTokens: (n: number) => String(n),
        updateTimersIn: () => {},
        morphInnerHtml: (_el: unknown, h: string) => {
          out.writes++;
          out.html = h;
        },
        ...extra,
      },
    );
    return { m, el, out };
  }
  // The 에이전트 트리 section tab (SSOT 2026-10-29): the session's whole tree — the main agent at its
  // root, the focused agent selected — windowed to the newest agents (atWindowOf).
  const TAB_FNS = [
    ...NODE_FNS,
    'panelLogOnlyAgents',
    'sessionColOf',
    'atIdOf',
    'atRootReason',
    'atNode',
    'atTreeData',
    'atSlotHtml',
    'atPaint',
    'atWindowOf',
    'writePanelPart',
    'paintTreeTab',
    'showMoreTree',
  ];
  function treeTab(focus: string, s: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const out = {
      html: '',
      writes: 0,
      sets: 0,
      data: null as TreeData | null,
      appended: [] as unknown[][],
      kept: [] as number[],
      filled: 0,
    };
    const tree: Record<string, unknown> = {};
    Object.defineProperty(tree, 'data', {
      set(v: TreeData) {
        out.sets++;
        out.data = v;
      },
    });
    const host: Record<string, unknown> = {
      querySelector: (sel: string) => (sel === 'ui-agent-tree' && out.html.includes('<ui-agent-tree') ? tree : null),
    };
    const box = { scrollHeight: 2000, scrollTop: 400, clientHeight: 500 };
    const m = load<{ paintTreeTab(): void; showMoreTree(): void }>(
      TAB_FNS,
      AGENT_VARS.filter((v) => !(v in extra)),
      {
        document: { getElementById: (id: string) => (id === 'panel-tree' ? host : null), activeElement: null },
        panelSessionKey: 'k',
        _sessionCache: { k: s },
        _lastBoardData: { working: [s] },
        _panelAgent: focus,
        _wl: { entries: [] },
        _psec: 'tree',
        _treeWindow: 20,
        _treeMaxN: null,
        AT_PANEL_WINDOW: 20,
        psecBox: () => box,
        psecAtBottom: () => true,
        psecSyncControls: () => {},
        psecOnAppended: (n: number, pinned: boolean) => out.appended.push([n, pinned]),
        psecKeepPlace: (_b: unknown, fromBottom: number) => out.kept.push(fromBottom),
        psecAfterRender: (_el: unknown, fn: () => void) => fn(),
        psecMaybeFill: () => {
          out.filled++;
        },
        updateTimersIn: () => {},
        morphInnerHtml: (_el: unknown, h: string) => {
          out.writes++;
          out.html = h;
        },
        ...extra,
      },
    );
    return { m, host, box, out };
  }
  const chain = (): Agent[] => [
    { id: 'a', n: 1, type: 'Explore', status: 'running', startedAt: T0, toolCalls: 1 },
    { id: 'b', n: 2, parentId: 'a', type: 'general-purpose', status: 'running', startedAt: T0 + 1, toolCalls: 2 },
    { id: 'c', n: 3, parentId: 'b', type: 'librarian', status: 'running', startedAt: T0 + 2, toolCalls: 3 },
    {
      id: 'd',
      n: 4,
      parentId: 'c',
      type: 'Plan',
      status: 'completed',
      startedAt: T0 + 3,
      endedAt: T0 + 9,
      toolCalls: 4,
    },
  ];

  it('a session without subagents still shows its main agent as a node: status, active time, tools, session Σ', () => {
    const s = card({
      agents: undefined,
      agentsTotal: undefined,
      activityState: 'idle',
      activeLegStartedAtMs: 0,
      activeAccumulatedMs: 65_000,
      agentRoot: { toolCalls: 2 },
      tokenUsage: {
        totalInputTokens: 1000,
        totalOutputTokens: 200,
        totalCacheReadTokens: 0,
        totalCacheCreateTokens: 0,
      },
    });
    const { m, el, out } = panel('', s, { _lastBoardData: { idle: [s] } });
    m.renderPanelAgents();
    expect(el.style.display).toBe('');
    expect(el.classes.has('is-main')).toBe(true);
    expect(out.html).toContain('class="pa-focus is-idle"');
    expect(out.html).toContain('<span class="ag-type">메인</span>');
    expect(out.html).toContain('대기');
    expect(out.html).toContain('툴 2');
    expect(out.html).toContain('task 합계 1200 tok · $0.00');
    expect(out.html).not.toContain('세션 Σ');
    // Nothing below it: no subtree element.
    expect(out.html).not.toContain('ui-agent-tree');
    expect(out.sets).toBe(0);
    // The root has nothing above it: no path.
    expect(out.html).not.toContain('pa-path');
  });

  it('the path is generated from the chain of the focused node — the root crumb is its label, not a hard-coded button', () => {
    const { m, el, out } = panel('toolu_nested', card());
    m.renderPanelAgents();
    // A subagent's tab: its own header is not the main agent's detail.
    expect(el.classes.has('is-main')).toBe(false);
    const path = out.html.slice(out.html.indexOf('<nav class="pa-path"'), out.html.indexOf('</nav>'));
    expect(path.indexOf('data-agent-select="">메인</button>')).toBeGreaterThan(0);
    expect(path.indexOf('data-agent-select="toolu_explore">A1 Explore</button>')).toBeGreaterThan(path.indexOf('메인'));
    expect(path).toContain('aria-current="page" data-agent-select="toolu_nested">A3 general-purpose</button>');
    // The focused subagent's header: the same slots the root's has.
    expect(out.html).toContain('class="pa-focus is-failed"');
    expect(out.html).toContain('실패');
    expect(out.html).toContain('툴 3');
    expect(out.html).toContain('41s');
  });

  it('the 에이전트 트리 tab is a rich <ui-agent-tree>: the main agent at its root, every agent below it, the focused one selected', () => {
    const kids = Array.from({ length: 9 }, (_, i) => ({
      id: `k${i}`,
      n: 10 + i,
      parentId: 'toolu_explore',
      status: 'completed',
      startedAt: T0 + i,
    }));
    const { m, host, out } = treeTab('toolu_explore', card({ agents: [...AGENTS, ...kids] }));
    m.paintTreeTab();
    expect(out.html).toBe(
      '<div class="pa-tree ui-tok"><ui-agent-tree lang="ko" data-at-ns="p|k"><span class="at-fallback">에이전트 트리</span></ui-agent-tree></div>',
    );
    // The element's bar is the tree's head (its title, counts and branch cost).
    expect(out.data).toMatchObject({ density: 'rich', title: '에이전트 트리', selectedId: 'toolu_explore' });
    const ids = out.data?.nodes.map((n) => n.id) ?? [];
    expect(ids[0]).toBe(':main');
    expect([...ids].sort()).toEqual([':main', 'toolu_explore', 'toolu_nested', 'toolu_lib', ...kids.map((k) => k.id)].sort());
    expect(out.data?.nodes.find((n) => n.id === 'k0')?.parentId).toBe('toolu_explore');
    // 12 agents: all of them fit the window — nothing waits above.
    expect(host._hidden).toBe(0);
    // The Main tab focused: the root is the one selected.
    const main = treeTab('', card());
    main.m.paintTreeTab();
    expect(main.out.data?.selectedId).toBe(':main');
    // A session without subagents: a line, no element.
    const none = treeTab('', card({ agents: undefined, agentsTotal: undefined }));
    none.m.paintTreeTab();
    expect(none.out.html).toBe('<p class="psec-empty">이 세션에는 하위 에이전트가 없습니다</p>');
    expect(none.host._tree).toBeNull();
    expect(none.out.sets).toBe(0);
    // Another section shown: the tab paints nothing (it is painted from its data when opened).
    const away = treeTab('', card(), { _psec: 'conv' });
    away.m.paintTreeTab();
    expect(away.out.writes).toBe(0);
  });

  it('every branch is open by default — and a node the user folded stays folded, whichever agent is focused', () => {
    const open = treeTab('', card({ agents: chain() }));
    open.m.paintTreeTab();
    expect(open.out.data?.nodes.map((n) => [n.id, n.parentId ?? ''])).toEqual([
      [':main', ''],
      ['a', ':main'],
      ['b', 'a'],
      ['c', 'b'],
      ['d', 'c'],
    ]);
    expect(open.out.data?.expanded).toEqual([':main', 'a', 'b', 'c']);
    const folded = treeTab('c', card({ agents: chain() }), { _anOpen: { 'p|k|b': false } });
    folded.m.paintTreeTab();
    expect(folded.out.data?.expanded).toEqual([':main', 'a', 'c']);
    expect(folded.out.data?.selectedId).toBe('c');
  });

  it('atWindowOf: the newest n agents by spawn order, the ancestors that connect them, the focused one; what waits above', () => {
    const w = load<{
      atWindowOf(
        anchor: unknown,
        n: number,
        pin: string | null,
        after: number | null,
      ): { keep: Record<string, boolean>; hidden: number; maxN: number; newer: number };
    }>(['toNum', 'atWindowOf'], []);
    type W = { id: string; n?: number; children: W[] };
    const nd = (id: string, n: number | undefined, children: W[] = []): W => ({ id, n, children });
    // main → a(1) → b(2) → c(5); main → d(3); main → e(4); main → log-only x (no spawn number: the oldest).
    const root = nd('', undefined, [nd('a', 1, [nd('b', 2, [nd('c', 5)])]), nd('d', 3), nd('e', 4), nd('x', undefined)]);
    const two = w.atWindowOf(root, 2, null, null);
    expect(Object.keys(two.keep).sort()).toEqual(['a', 'b', 'c', 'e']);
    expect(two).toMatchObject({ hidden: 2, maxN: 5, newer: 0 });
    // The focused agent stays in view though it is older than the window.
    expect(Object.keys(w.atWindowOf(root, 2, 'd', null).keep).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    // One step up shows more; past the oldest, everything (the log-only agent last).
    expect(w.atWindowOf(root, 4, null, null).hidden).toBe(1);
    expect(w.atWindowOf(root, 40, null, null)).toMatchObject({ hidden: 0 });
    // Live arrivals: how many are newer than the newest the tree last showed.
    expect(w.atWindowOf(root, 2, null, 3).newer).toBe(2);
  });

  it('a big tree opens on its newest 20 agents; scrolling up shows 20 more, the reader keeping their place; a live arrival is counted', () => {
    // 60 agents in a 3-level tree: 5 leads, 15 under them, 40 under those.
    const agents: Agent[] = Array.from({ length: 60 }, (_, i) => {
      const n = i + 1;
      const parentId = n <= 5 ? undefined : n <= 20 ? `g${((n - 6) % 5) + 1}` : `g${((n - 21) % 15) + 6}`;
      return { id: `g${n}`, n, parentId, type: 'Explore', status: 'completed', startedAt: T0 + n };
    });
    const s = card({ agents });
    const r = treeTab('', s, { psecAtBottom: () => false });
    r.m.paintTreeTab();
    const ids = (r.out.data?.nodes ?? []).map((n) => n.id);
    // The newest 20 (g41…g60) and what connects them to the root: ≤ 25 tree nodes.
    for (let n = 41; n <= 60; n++) expect(ids).toContain(`g${n}`);
    expect(ids).not.toContain('g40');
    expect(ids.length).toBeLessThanOrEqual(1 + 20 + 15 + 5);
    expect(r.host._hidden).toBe(60 - (ids.length - 1));
    // Scroll up: 20 more, the reader's place measured from the bottom of the box (kept before and after render).
    const before = ids.length;
    r.m.showMoreTree();
    const more = (r.out.data?.nodes ?? []).map((n) => n.id);
    for (let n = 21; n <= 60; n++) expect(more).toContain(`g${n}`);
    expect(more.length).toBeGreaterThan(before);
    expect(r.out.kept).toEqual([2000 - 400, 2000 - 400]);
    expect(r.out.filled).toBe(1);
    expect(r.host._growing).toBe(false);
    // The markup is the same element: the step is data only.
    expect(r.out.writes).toBe(1);
    // A new agent while the reader reads higher: their place stays and the pill counts it.
    agents.push({ id: 'g61', n: 61, parentId: 'g60', type: 'Plan', status: 'running', startedAt: T0 + 61 });
    r.m.paintTreeTab();
    expect(r.out.appended).toEqual([[1, false]]);
  });

  // RED (SSOT T2/T3) — what a subagent spent (its own API calls: tokens and
  // API-equivalent cost), never the SDK's context size; the root is the task total.
  const SPEND = {
    inputTokens: 100,
    outputTokens: 200,
    cacheReadTokens: 9700,
    cacheCreateTokens: 0,
    costUsd: 1.234,
    calls: 5,
  };
  const head = (html: string) =>
    html.slice(html.indexOf('class="pa-focus'), html.indexOf('</div>', html.indexOf('class="pa-sum"')));
  it("a subagent's header shows its own spend — tokens and API-equivalent cost; the SDK context size is never shown", () => {
    const agents = [{ ...AGENTS[0], tokens: 134, spend: SPEND }, AGENTS[1], AGENTS[2]];
    const { m, out } = panel('toolu_explore', card({ agents }));
    m.renderPanelAgents();
    expect(head(out.html)).toContain('10000 tok · $1.23');
    expect(out.html).not.toContain('134 tok');
  });

  it('every subagent node in the panel tree carries its own spend; the header says when it is an estimate (≈)', () => {
    const lib = { ...AGENTS[2], spend: { ...SPEND, costUsd: 0.5, unpricedModels: ['grok-4.7-build'] } };
    const root = treeTab('', card({ agents: [{ ...AGENTS[0], spend: SPEND }, AGENTS[1], lib] }));
    root.m.paintTreeTab();
    const nodes = root.out.data?.nodes ?? [];
    expect(nodes.find((n) => n.id === 'toolu_explore')).toMatchObject({ tokens: 10_000, costUsd: 1.234 });
    expect(nodes.find((n) => n.id === 'toolu_lib')).toMatchObject({ tokens: 10_000, costUsd: 0.5 });
    // The element shows the amount; ≈ and the per-kind breakdown are the focused node's header.
    const focused = panel('toolu_lib', card({ agents: [AGENTS[0], AGENTS[1], lib] }));
    focused.m.renderPanelAgents();
    expect(head(focused.out.html)).toContain('10000 tok · ≈$0.50');
    expect(head(focused.out.html)).toContain('grok-4.7-build');
  });

  it('a subagent with estimated calls reads ≈ and says how many calls were estimated (llmux zero usage)', () => {
    const est = { ...AGENTS[2], spend: { ...SPEND, costUsd: 0.5, estimatedCalls: 3 } };
    const { m, out } = panel('toolu_lib', card({ agents: [AGENTS[0], AGENTS[1], est] }));
    m.renderPanelAgents();
    expect(head(out.html)).toContain('10000 tok · ≈$0.50');
    expect(head(out.html)).toContain('usage가 기록되지 않은 호출 3회는 앞뒤 호출로 추정');
  });

  it('a subagent that started foreground subagents of its own says their calls are in its number', () => {
    const lead = { ...AGENTS[2], spend: { ...SPEND, calls: 9, nestedAgents: 2 } };
    const { m, out } = panel('toolu_lib', card({ agents: [AGENTS[0], AGENTS[1], lead] }));
    m.renderPanelAgents();
    expect(head(out.html)).toContain('트리에 따로 없는 하위 에이전트 2개 포함');
    expect(head(out.html)).not.toContain('하위 에이전트 제외');
  });

  it('the root marks the subagents’ share ≈ when any of it is estimated', () => {
    const s = card({
      tokenUsage: {
        totalInputTokens: 1000,
        totalOutputTokens: 1000,
        totalCacheReadTokens: 8000,
        totalCacheCreateTokens: 0,
        totalCostUsd: 3.5,
      },
      subagentSpend: {
        agents: 3,
        inputTokens: 100,
        outputTokens: 100,
        cacheReadTokens: 800,
        cacheCreateTokens: 0,
        costUsd: 0.75,
        estimated: true,
      },
    });
    const { m, out } = panel('', s);
    m.renderPanelAgents();
    expect(out.html).toContain('서브 3개 1000 tok · ≈$0.75');
  });

  it('the root header is the task total — main and every subagent — with the subagents’ share beside it', () => {
    const s = card({
      tokenUsage: {
        totalInputTokens: 1000,
        totalOutputTokens: 1000,
        totalCacheReadTokens: 8000,
        totalCacheCreateTokens: 0,
        totalCostUsd: 3.5,
      },
      subagentSpend: {
        agents: 3,
        inputTokens: 100,
        outputTokens: 100,
        cacheReadTokens: 800,
        cacheCreateTokens: 0,
        costUsd: 0.75,
      },
    });
    const { m, out } = panel('', s);
    m.renderPanelAgents();
    expect(out.html).toContain('task 합계 10000 tok · $3.50');
    expect(out.html).toContain('서브 3개 1000 tok · $0.75');
  });

  it('the current crumb is styled by the attribute it carries (review r1 fable)', () => {
    expect(TEMPLATE).toContain('.pa-crumb[aria-current="page"] {');
    expect(TEMPLATE).toContain('.pa-crumb:not([aria-current="page"]):hover');
    expect(TEMPLATE).not.toContain('.pa-crumb[aria-current="true"]');
    // The header counts every node below; the subtree's bar counts its agents — different words.
    expect(fnBody('renderAgentFocus')).toContain("'하위 전체 ' + desc.n");
  });

  it('an unchanged panel writes nothing — the crumbs, the tree’s focus and its spinners survive a live update', () => {
    const { m, out } = panel('toolu_explore', card());
    m.renderPanelAgents();
    m.renderPanelAgents();
    expect(out.writes).toBe(1);
    // The 에이전트 트리 tab alike: the same markup and data write nothing.
    const t = treeTab('toolu_explore', card());
    t.m.paintTreeTab();
    t.m.paintTreeTab();
    expect(t.out.writes).toBe(1);
    expect(t.out.sets).toBe(1);
  });

  it('a live change to the tree is data only: the markup stays, the element is given the new nodes', () => {
    const s = card({ agents: [...AGENTS] });
    const { m, out } = treeTab('toolu_explore', s);
    m.paintTreeTab();
    (s.agents as Agent[])[1] = { ...AGENTS[1], status: 'completed', toolCalls: 9 };
    m.paintTreeTab();
    expect(out.writes).toBe(1);
    expect(out.sets).toBe(2);
    expect(out.data?.nodes.find((n) => n.id === 'toolu_nested')).toMatchObject({ status: 'done', toolCalls: 9 });
    // No new agent: nothing is counted on the pill.
    expect(out.appended).toEqual([]);
  });

  it('live updates repaint the focused node whatever it is — no main-only or subagent-only gate', () => {
    const ws = fnBody('connectWs');
    expect(ws).not.toContain('!_panelAgent');
    expect(ws).not.toContain('renderPanelTasks(msg.tasks');
    // session_update, sessionUpdated and task_update repaint the whole panel (spec 13), which runs the node scope.
    expect(ws.match(/repaintPanelSession\(\);/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(fnBody('repaintPanelSession')).toContain('repaintPanelScope();');
    const r = fnBody('repaintPanelScope');
    expect(r).toContain('renderPanelAgents();');
    expect(r).toContain('repaintPanelTasks();');
    expect(r).toContain('wlRefreshGroupHeads();');
    expect(r).toContain('wlRefreshChildBlocks();');
  });
});

// Not a tree: one child's live block beside the call that started it (status, time, tools, what it does,
// 열기) — so it keeps its own renderer, wlChildBlock, over the same node model.
describe('work log — a child is one live block at the point it was started', () => {
  const ENTRY_FNS = [...NODE_FNS, 'decodeSlackEntities', 'wlChildBlock', 'wlToolSummary', 'renderWorkLogEntry'];
  const spawn = { seq: 2, ts: 0, kind: 'tool', tool: 'Agent', text: 'Agent {}', agentRef: 'toolu_explore' };
  const r = (agents: Agent[] = AGENTS) =>
    load<{ renderWorkLogEntry(e: unknown): string }>(ENTRY_FNS, [...AGENT_VARS, 'WL_LABELS'], {
      panelSessionKey: 'k',
      _sessionCache: { k: card({ agents }) },
    });

  it("the spawn row carries the child's block — status, time, tools, current task, 열기 — beside the row, not inside it", () => {
    const html = r().renderWorkLogEntry(spawn);
    expect(html).toContain(
      'class="wl-agent-link wl-child is-running" tabindex="-1" data-agent="toolu_explore" data-agent-block="toolu_explore"',
    );
    expect(html).toContain('<span class="ag-st">실행 중</span>');
    expect(html).toContain('툴 18');
    expect(html).toContain('#T1 Reading the mapper');
    expect(html).toContain('열기 &rarr;');
    expect(html).toContain('aria-label="A1 Explore 열기 — 실행 중, 툴 18"');
    // The call itself is a tool call card; the child's block sits beside it, never inside it.
    const cardEnd = html.indexOf('</ui-tool-call-card>');
    expect(cardEnd).toBeGreaterThan(0);
    expect(html.indexOf('wl-agent-link')).toBeGreaterThan(cardEnd);
  });

  it('a block whose agent has not arrived yet reads 확인 불가 (it morphs when the agent does)', () => {
    const html = r([]).renderWorkLogEntry({ ...spawn, agentRef: 'toolu_ghost' });
    expect(html).toContain('data-agent-block="toolu_ghost"');
    expect(html).toContain('확인 불가');
  });

  it('a live update morphs each visible block in place and keeps its roving stop', () => {
    const body = fnBody('wlRefreshChildBlocks');
    expect(body).toContain('[data-agent-block]');
    expect(body).toContain('if (el._html === html) continue;');
    expect(body).toContain("fresh.setAttribute('tabindex', el.getAttribute('tabindex') || '-1');");
    expect(body).toContain('domMorph(el, fresh);');
    expect(body).toContain('updateTimersIn(el);');
  });
});

// A just-enough DOM for domMorph: element/text nodes, attributes, sibling links.
class FakeNode {
  nodeType: number;
  tagName: string;
  nodeValue: string | null;
  // Live form state (what the user changed; attributes hold only the defaults).
  value = '';
  checked = false;
  selectedIndex = -1;
  attrs: Array<{ name: string; value: string }> = [];
  kids: FakeNode[] = [];
  parent: FakeNode | null = null;
  constructor(tag: string | null, text: string | null = null) {
    this.nodeType = tag ? 1 : 3;
    this.tagName = tag ? tag.toUpperCase() : '';
    this.nodeValue = tag ? null : text;
  }
  get attributes() {
    return this.attrs;
  }
  get id() {
    return this.getAttribute('id') ?? '';
  }
  getAttribute(n: string) {
    return this.attrs.find((a) => a.name === n)?.value ?? null;
  }
  hasAttribute(n: string) {
    return this.attrs.some((a) => a.name === n);
  }
  setAttribute(n: string, v: string) {
    const a = this.attrs.find((x) => x.name === n);
    if (a) a.value = v;
    else this.attrs.push({ name: n, value: v });
  }
  removeAttribute(n: string) {
    this.attrs = this.attrs.filter((a) => a.name !== n);
  }
  get firstChild() {
    return this.kids[0] ?? null;
  }
  get nextSibling(): FakeNode | null {
    if (!this.parent) return null;
    return this.parent.kids[this.parent.kids.indexOf(this) + 1] ?? null;
  }
  insertBefore(n: FakeNode, ref: FakeNode | null) {
    if (n.parent) n.parent.kids.splice(n.parent.kids.indexOf(n), 1);
    n.parent = this;
    const i = ref ? this.kids.indexOf(ref) : -1;
    if (i < 0) this.kids.push(n);
    else this.kids.splice(i, 0, n);
    return n;
  }
  removeChild(n: FakeNode) {
    this.kids.splice(this.kids.indexOf(n), 1);
    n.parent = null;
    return n;
  }
}
function h(tag: string, attrs: Record<string, string>, ...kids: Array<FakeNode | string>): FakeNode {
  const n = new FakeNode(tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  for (const k of kids) n.insertBefore(typeof k === 'string' ? new FakeNode(null, k) : k, null);
  return n;
}
const morph = load<{ domMorph(a: FakeNode, b: FakeNode): void }>(
  ['domKeyOf', 'domKeyLater', 'domMorph', 'domMorphChildren'],
  [],
);

describe('live morph (review B r2) — a live update keeps the nodes that did not move', () => {
  const tree = (tools: string, width: string, second: string) =>
    h(
      'div',
      { class: 'ag-tree' },
      h('button', { class: 'ag-row is-main', 'data-mk': '' }, '메인'),
      h(
        'button',
        { class: 'ag-row is-sub is-running', 'data-mk': 'toolu_a' },
        h('span', { class: 'ag-icon' }, h('span', { class: 'spinner ag-spinner' })),
        h('span', { class: 'ag-tools' }, tools),
        h('span', { class: 'ag-span' }, h('i', { style: width })),
      ),
      h('button', { class: 'ag-row is-sub is-' + second, 'data-mk': 'toolu_b' }, second),
    );

  it('a tool count and the waterfall move in place — the row, its spinner and its bar are the same nodes', () => {
    const live = tree('툴 3', 'left:0%;width:40%', 'running');
    const row = live.kids[1];
    const spinner = row.kids[0].kids[0];
    const bar = row.kids[2].kids[0];
    morph.domMorph(live, tree('툴 4', 'left:0%;width:52%', 'completed'));
    expect(live.kids[1]).toBe(row);
    expect(row.kids[0].kids[0]).toBe(spinner);
    expect(row.kids[2].kids[0]).toBe(bar);
    expect(bar.getAttribute('style')).toBe('left:0%;width:52%');
    expect(row.kids[1].kids[0].nodeValue).toBe('툴 4');
    expect(live.kids[2].getAttribute('class')).toBe('ag-row is-sub is-completed');
    expect(live.kids[2].kids[0].nodeValue).toBe('completed');
  });

  it('rows pair by agent, not by position — a new agent between two keeps the second row', () => {
    const live = tree('툴 3', 'w', 'running');
    const b = live.kids[2];
    const fresh = tree('툴 3', 'w', 'running');
    fresh.insertBefore(h('button', { class: 'ag-row is-sub', 'data-mk': 'toolu_new' }, 'new'), fresh.kids[2]);
    morph.domMorph(live, fresh);
    expect(live.kids.map((k) => k.getAttribute('data-mk'))).toEqual(['', 'toolu_a', 'toolu_new', 'toolu_b']);
    expect(live.kids[3]).toBe(b);
  });

  it('attributes the fresh markup drops are removed (aria-current, hidden)', () => {
    const live = h(
      'div',
      { id: 'pa-list', hidden: '' },
      h('button', { 'data-agent-select': 'x', 'aria-current': 'true' }, 'x'),
    );
    const btn = live.kids[0];
    morph.domMorph(live, h('div', { id: 'pa-list' }, h('button', { 'data-agent-select': 'x' }, 'x')));
    expect(live.hasAttribute('hidden')).toBe(false);
    expect(live.kids[0]).toBe(btn);
    expect(btn.hasAttribute('aria-current')).toBe(false);
  });

  it('an agent row that leaves from the middle goes; the row after it keeps its node (review B r3)', () => {
    const live = tree('툴 3', 'w', 'running');
    const b = live.kids[2];
    const fresh = tree('툴 3', 'w', 'running');
    fresh.removeChild(fresh.kids[1]);
    morph.domMorph(live, fresh);
    expect(live.kids.map((k) => k.getAttribute('data-mk'))).toEqual(['', 'toolu_b']);
    expect(live.kids[1]).toBe(b);
  });

  it('a row that leaves while a new one arrives keeps the survivor: [메인, A, B] → [메인, B, C] (review B r3 astra)', () => {
    const live = tree('툴 3', 'w', 'running');
    const b = live.kids[2];
    const fresh = tree('툴 3', 'w', 'running');
    fresh.removeChild(fresh.kids[1]);
    fresh.insertBefore(h('button', { class: 'ag-row is-sub', 'data-mk': 'toolu_c' }, 'c'), null);
    morph.domMorph(live, fresh);
    expect(live.kids.map((k) => k.getAttribute('data-mk'))).toEqual(['', 'toolu_b', 'toolu_c']);
    expect(live.kids[1]).toBe(b);
  });

  it('a section inserted before others does not shift them onto each other (review B r3 astra)', () => {
    const body = (withSub: boolean) =>
      h(
        'div',
        { class: 'card-body' },
        ...(withSub ? [h('div', { class: 'card-sub' }, 'issue title')] : []),
        h('div', { class: 'card-meta' }, 'meta'),
        h('div', { class: 'ag-tree' }, h('button', { class: 'ag-row is-sub', 'data-mk': 'toolu_a' }, 'A')),
      );
    const live = body(false);
    const meta = live.kids[0];
    const agTree = live.kids[1];
    const row = agTree.kids[0];
    morph.domMorph(live, body(true));
    expect(live.kids.map((k) => k.getAttribute('class'))).toEqual(['card-sub', 'card-meta', 'ag-tree']);
    expect(live.kids[1]).toBe(meta);
    expect(live.kids[2]).toBe(agTree);
    expect(agTree.kids[0]).toBe(row);
  });

  it('form state follows the fresh markup — a model picker the server rejected shows the session model again (review B r3 astra)', () => {
    const live = h(
      'select',
      { class: 'model-pick' },
      h('option', { value: 'opus' }, 'Opus'),
      h('option', { value: 'sonnet' }, 'Sonnet'),
    );
    live.selectedIndex = 1; // the user picked Sonnet; the change was rejected
    const fresh = h(
      'select',
      { class: 'model-pick' },
      h('option', { value: 'opus' }, 'Opus'),
      h('option', { value: 'sonnet' }, 'Sonnet'),
    );
    fresh.selectedIndex = 0; // the session is still on Opus
    morph.domMorph(live, fresh);
    expect(live.selectedIndex).toBe(0);
    const box = h('input', { type: 'checkbox' });
    box.checked = true;
    const freshBox = h('input', { type: 'checkbox' });
    morph.domMorph(box, freshBox);
    expect(box.checked).toBe(false);
    const field = h('input', { class: 'x' });
    field.value = 'typed';
    morph.domMorph(field, h('input', { class: 'x' }));
    expect(field.value).toBe('');
  });

  it('nested keyed records pair inside their own group — a new grandchild keeps its siblings and their subtrees', () => {
    const item = (id: string, ...kids: FakeNode[]) =>
      h(
        'li',
        { class: 'an is-running', 'data-mk': id },
        h('div', { class: 'an-row' }, id),
        ...(kids.length ? [h('ul', { class: 'an-kids', role: 'group' }, ...kids)] : []),
      );
    const live = h('ul', { class: 'an-tree' }, item('', item('a', item('a1')), item('b')));
    const a = live.kids[0].kids[1].kids[0];
    const a1 = a.kids[1].kids[0];
    const b = live.kids[0].kids[1].kids[1];
    morph.domMorph(live, h('ul', { class: 'an-tree' }, item('', item('a', item('a0'), item('a1')), item('b'))));
    expect(live.kids[0].kids[1].kids[0]).toBe(a);
    expect(a.kids[1].kids.map((k) => k.getAttribute('data-mk'))).toEqual(['a0', 'a1']);
    expect(a.kids[1].kids[1]).toBe(a1);
    expect(live.kids[0].kids[1].kids[1]).toBe(b);
  });

  it('a removed agent row goes; the rest stay', () => {
    const live = tree('툴 3', 'w', 'running');
    const a = live.kids[1];
    const fresh = tree('툴 3', 'w', 'running');
    fresh.removeChild(fresh.kids[2]);
    morph.domMorph(live, fresh);
    expect(live.kids.length).toBe(2);
    expect(live.kids[1]).toBe(a);
  });
});

describe('keyboard (review B r2) — 서브에이전트 열기 is a stop on the arrow path', () => {
  it('the arrow rows include the link, the tab stop can sit on it, and Enter on it is left to the button', () => {
    expect(fnBody('wlNavRows')).toContain("'.wl-group-head, .wl-row, .wl-agent-link, ui-tool-call-card.wl-card'");
    // One stop selector for both (rows, heads, links and tool call cards).
    expect(TEMPLATE).toMatch(
      /var WL_STOP_SEL = '[^']*\.wl-agent-link\[tabindex="0"\][^']*ui-tool-call-card\[data-stop="1"\]';/,
    );
    expect(fnBody('wlSetTabStop')).toContain('list.querySelectorAll(WL_STOP_SEL)');
    expect(fnBody('wlEnsureTabStop')).toContain('list.querySelector(WL_STOP_SEL)');
    expect(TEMPLATE).toContain("if (isLink && (e.key === 'Enter' || e.key === ' ')) return;");
  });
  it('choosing an agent by keyboard leaves focus on the agent now shown, not on <body> (review B r3)', () => {
    const body = fnBody('selectPanelAgent');
    expect(body).toContain("before.closest('#slide-panel')");
    expect(body).toContain('#panel-agents .pa-crumb[aria-current="page"]');
  });
  it('the panel Tasks block writes nothing for the same data and morphs a change — folded or open (review B r3 astra)', () => {
    // Task view T1.3: the Tasks section is folded by default (the head alone);
    // opened, the plan (re-agent-run D1–D7: rows, markers, times, the footer).
    for (const open of [false, true]) {
      let writes = 0;
      const container = { style: {} as Record<string, string> } as Record<string, unknown>;
      const m = load<{ renderPanelTasks(t: unknown, l?: string): void }>(
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
          document: { getElementById: (id: string) => (id === 'panel-tasks' ? container : null) },
          _panelTasksOpen: open,
          _panelTasksExpanded: false,
          _panelTasksEarlier: false,
          morphInnerHtml: () => {
            writes++;
          },
          updateTimersIn: () => {},
        },
      );
      const tasks = [{ id: 'T1', content: 'a', status: 'completed' }];
      m.renderPanelTasks(tasks, 'A1 Explore');
      m.renderPanelTasks(tasks, 'A1 Explore');
      expect(writes).toBe(1);
      // A new step changes the folded head (1/1 → 1/2) as well as the open plan.
      m.renderPanelTasks([...tasks, { id: 'T2', content: 'b', status: 'pending' }], 'A1 Explore');
      expect(writes).toBe(2);
    }
    expect(fnBody('renderPanelTasks')).not.toContain('container.innerHTML =');
  });
  it('a refused model switch leaves nothing to put back — also the second time, when the card markup does not change (review B r4 astra)', async () => {
    // The menu picks by value (.prd/affectui/re-model-picker.md D11): no control keeps the refused
    // model, so the card shows the session's model again by re-rendering from the session.
    const notes: Record<string, { text: string; error: boolean }> = {};
    let refreshed = 0;
    const m = load<{ changeModel(k: string, n: string): Promise<void>; isBusy(k: string, op: string): boolean }>(
      ['isBusy', 'setBusy', 'modelSwitchNote', 'changeModel'],
      ['_busy'],
      {
        repaintPanelControlsFor: () => {},
        postModelSwitch: async () => ({ ok: false, error: 'rejected' }),
        _modelNotes: notes,
        formatTokens: String,
        refreshCard: () => {
          refreshed++; // same markup on the second refusal: the card writes nothing
        },
        loadSessions: () => {},
      },
    );
    await m.changeModel('k', 'sonnet[1m]');
    expect(notes.k).toEqual({ text: 'rejected', error: true });
    await m.changeModel('k', 'sonnet[1m]');
    expect(m.isBusy('k', 'model')).toBe(false);
    // Each switch repaints the card as it starts (busy, spec 13) and as it settles.
    expect(refreshed).toBe(4);
  });
  it('a group head is morphed, not replaced, and skipped when its markup is unchanged', () => {
    const body = fnBody('wlRefreshGroupHead');
    expect(body).toContain('if (head._html === html) return;');
    expect(body).toContain('domMorph(head, fresh);');
    expect(body).not.toContain('replaceChild');
  });
  it('a changed card body is morphed into place, not rewritten', () => {
    const body = fnBody('applyCardParts');
    expect(body).toContain('morphInnerHtml(el._bodyEl, p.body);');
    expect(body).not.toContain('_bodyEl.innerHTML =');
  });
});

describe('task total on the face and in 세션 정보 (SSOT T3)', () => {
  const u = {
    totalInputTokens: 1000,
    totalOutputTokens: 1000,
    totalCacheReadTokens: 8000,
    totalCacheCreateTokens: 0,
    totalCostUsd: 3.5,
  };
  const sub = {
    agents: 2,
    inputTokens: 100,
    outputTokens: 100,
    cacheReadTokens: 800,
    cacheCreateTokens: 0,
    costUsd: 0.75,
  };

  it('the face total says it is the whole task — main and subagents — and when it is partial', () => {
    const f = load<{ renderCardUsage(s: unknown): string }>(
      ['esc', 'escAttr', 'toNum', 'cardTotalTokens', 'spendTotal', 'spendText', 'renderCardUsage'],
      [],
      { formatCount: (_k: string, n: number) => String(n) },
    );
    const whole = f.renderCardUsage({ tokenUsage: u, subagentSpend: sub });
    expect(whole).toContain('메인 + 서브에이전트 2개');
    expect(whole).not.toContain('부분 합계');
    expect(f.renderCardUsage({ tokenUsage: { ...u, partialSince: 1_700_000_000_000 } })).toContain('부분 합계');
  });

  it('세션 정보 lists the subagents’ share and, for a partial total, since when it counts', () => {
    // The token grid's rows; 세부 (cost) and the context block are their own renderers.
    const f = load<{ panelInfoHtml(s: unknown, open: boolean): string }>(
      ['esc', 'escAttr', 'toNum', 'cardTotalTokens', 'spendTotal', 'spendText', 'ctxLevel', 'panelInfoHtml'],
      ['PI_CHEV_SVG'],
      {
        formatNmSSs: () => '0s',
        safeHref: (h: string) => h,
        ctxPercent: (n: number) => String(n),
        panelDetailsHtml: () => '',
        contextBlockHtml: () => '',
      },
    );
    const open = f.panelInfoHtml({ tokenUsage: u, subagentSpend: sub, lastActivity: new Date().toISOString() }, true);
    expect(open).toContain('<dt>누적 입력</dt><dd>1000</dd>');
    expect(open).toContain('<dt>서브에이전트</dt><dd>2개 · 1000 tok · $0.75</dd>');
    expect(open).not.toContain('집계 시작');
    const partial = f.panelInfoHtml(
      { tokenUsage: { ...u, partialSince: 1_700_000_000_000 }, lastActivity: new Date().toISOString() },
      true,
    );
    expect(partial).toContain('<dt>집계 시작</dt>');
    expect(partial).toContain('data-ts="1700000000000"');
  });
});
