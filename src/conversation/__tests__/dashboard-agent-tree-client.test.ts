/**
 * Spec 12 (agent tree) §4 — dashboard client half. Executes the shipped client
 * code cut out of renderDashboardPage()'s template literal and cooked exactly
 * as the browser receives it (the harness of dashboard-agent-inbox-client.test.ts):
 *
 *   §4.1  collapsed card: one agents row — status dots + "서브에이전트 N · 실행 r · 실패 f"
 *   §4.2  open card: 메인 → subagents tree (nesting, status icon + word, time,
 *         tools, current task) with a waterfall bar on the agent set's time axis
 *   §4.3  panel: the agent the panel shows scopes Tasks and the work log —
 *         main = entries without agentId; a subagent = its own entries plus the
 *         call that started it (지시) and that call's result (결과 / 배경 실행 시작)
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
function load<T>(fns: string[], vars: string[], inject: Record<string, unknown> = {}): T {
  const names = Object.keys(inject);
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}
function fnBody(name: string): string {
  return clientFn(name);
}

const BASE_FNS = ['esc', 'escAttr', 'escJs', 'toNum', 'formatDuration'];
const AGENT_FNS = [
  ...BASE_FNS,
  'agentStatusOf',
  'agentName',
  'agentTreeOrder',
  'agentCounts',
  'renderCardAgents',
  'agentIconHtml',
  'agentTimeHtml',
  'agentActivity',
  'agentSpanAxis',
  'agentSpanStyle',
  'renderAgentRow',
  'renderMainAgentRow',
  'renderAgentTree',
];
const AGENT_VARS = ['AGENT_STATUS_LABEL', 'AGENT_TREE_ROWS', 'AGENT_DOTS_MAX', 'AGENTS_SVG', '_agentTreeOpen'];

type Agent = Record<string, unknown>;
interface AgentUi {
  agentTreeOrder(a: Agent[]): Array<{ agent: Agent; depth: number; isLast: boolean }>;
  renderCardAgents(s: unknown): string;
  renderAgentTree(s: unknown): string;
  agentSpanAxis(a: Agent[], last: number): { t0: number; t1: number };
  agentSpanStyle(a: Agent, axis: { t0: number; t1: number }): string;
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
  lastActivity: new Date(T0 + 300_000).toISOString(),
  tasks: [
    { id: 'T1', content: 'Plan', status: 'completed', toolCalls: 2 },
    { id: 'T2', content: 'Build', status: 'in_progress', toolCalls: 5 },
  ],
  agents: AGENTS,
  agentsTotal: 3,
  ...over,
});

describe('agent tree order (§4.2)', () => {
  it('each agent is followed by the agents it started, with its depth; an unknown parent hangs from main', () => {
    const rows = ui.agentTreeOrder([
      ...AGENTS,
      { id: 'orphan', n: 9, parentId: 'gone', status: 'unknown', startedAt: T0 },
    ]);
    expect(rows.map((r) => [r.agent.id, r.depth, r.isLast])).toEqual([
      ['toolu_explore', 1, false],
      ['toolu_nested', 2, true],
      ['toolu_lib', 1, false],
      ['orphan', 1, true],
    ]);
  });
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

describe('open card tree (§4.2)', () => {
  it('starts with the main agent, then each subagent with its status in words, time, tools and current task', () => {
    const html = ui.renderAgentTree(card());
    expect(html.indexOf('ag-row is-main')).toBeLessThan(html.indexOf('ag-row is-sub'));
    expect(html).toContain('메인 + 3');
    expect(html).toContain('task 1/2');
    expect(html).toContain('<span class="ag-id">A1</span><span class="ag-type">Explore</span></span>');
    expect(html).toContain('<span class="ag-desc">Trace subagent frames</span>');
    expect(html).toContain('<span class="ag-st">실행 중</span>');
    expect(html).toContain('data-since="' + T0 + '"');
    expect(html).toContain('툴 18');
    expect(html).toContain('<span class="ag-bg">배경</span>');
    expect(html).toContain('#T1 Reading the mapper');
    expect(html).toContain('<span class="ag-st">실패</span>');
    expect(html).toContain('<span class="ag-st">완료</span>');
    expect(html).toContain('4m 2s');
    expect(html).toContain('마지막 도구 WebFetch');
    // Nesting depth drives the indent and the tree lines.
    expect(html).toContain('style="--ag-depth:2"');
    // Each row opens the panel on that agent (the main row on the main agent),
    // through a data attribute a delegated handler reads — never inline JS.
    expect(html).toContain('data-agent-open="toolu_nested"');
    expect(html).toContain('data-agent-open=""');
    expect(html).not.toContain('onclick=');
  });

  it('the same card renders the same markup (the reconciler leaves it alone)', () => {
    expect(ui.renderAgentTree(card())).toBe(ui.renderAgentTree(card()));
  });

  it('folds rows over the budget behind 전체 N개 보기, and names agents beyond the card', () => {
    const many = Array.from({ length: 11 }, (_, i) => ({
      id: `a${i}`,
      n: i + 1,
      status: 'completed',
      startedAt: T0 + i,
    }));
    const html = ui.renderAgentTree(card({ agents: many, agentsTotal: 15 }));
    expect(html.match(/ag-row is-sub/g)).toHaveLength(8);
    expect(html).toContain('전체 11개 보기');
    expect(html).toContain('이전 에이전트 4개는 카드 목록 밖');
  });

  it('hostile agent text is text, never markup', () => {
    const bad = '"><img src=x onerror=alert(1)>';
    const html = ui.renderAgentTree(
      card({ agents: [{ id: 'x"y', n: 1, type: bad, description: bad, status: 'running', startedAt: T0 }] }),
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('data-agent-open="x&quot;y"');
  });

  it('no subagents → no tree', () => {
    expect(ui.renderAgentTree(card({ agents: [] }))).toBe('');
  });
});

describe('waterfall time axis (§4.2) — the agent set, not the session', () => {
  it('spans the first start to the last end or the last activity, whichever is later', () => {
    const axis = ui.agentSpanAxis(AGENTS, T0 + 300_000);
    expect(axis).toEqual({ t0: T0, t1: T0 + 300_000 });
    // librarian: 5s → 247s of 300s.
    expect(ui.agentSpanStyle(AGENTS[2], axis)).toBe('left:1.7%;width:80.7%');
    // A running agent reaches the end of the axis.
    expect(ui.agentSpanStyle(AGENTS[0], axis)).toBe('left:0.0%;width:100.0%');
  });
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

  it('rows say 지시 / 결과 / 배경 실행 시작 in a subagent scope; a spawn row elsewhere links to the agent', () => {
    const r = load<{ renderWorkLogEntry(e: unknown): string }>(
      ['esc', 'escAttr', 'decodeSlackEntities', 'renderWorkLogEntry'],
      ['WL_LABELS'],
    );
    expect(r.renderWorkLogEntry({ ...LOG[1], _role: 'spawn' })).toContain('<span class="wl-role">지시</span>');
    expect(r.renderWorkLogEntry({ ...LOG[4], _role: 'result' })).toContain('<span class="wl-role">결과</span>');
    expect(r.renderWorkLogEntry({ ...LOG[4], _role: 'ack' })).toContain('<span class="wl-role">배경 실행 시작</span>');
    const spawn = r.renderWorkLogEntry(LOG[1]);
    expect(spawn).toContain('class="wl-agent-link" tabindex="-1" data-agent="toolu_explore"');
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

  it('an unchanged agent bar is not rewritten — focus and the list scroll survive a live update (review B-P1)', () => {
    let writes = 0;
    let html = '';
    const el = { style: {} as Record<string, string> };
    const m = load<{ renderPanelAgents(): void }>(
      [
        'esc',
        'escAttr',
        'toNum',
        'formatDuration',
        'agentStatusOf',
        'agentName',
        'agentTreeOrder',
        'agentIconHtml',
        'agentTimeHtml',
        'agentActivity',
        'agentSpanAxis',
        'agentSpanStyle',
        'renderAgentRow',
        'renderMainAgentRow',
        'panelLogOnlyAgents',
        'renderPanelAgents',
      ],
      ['AGENT_STATUS_LABEL', 'AGENTS_SVG'],
      {
        document: { getElementById: (id: string) => (id === 'panel-agents' ? el : null), activeElement: null },
        panelSessionKey: 'k',
        _sessionCache: { k: card() },
        _panelAgent: 'toolu_explore',
        _panelAgentListOpen: true,
        _panelAgentIdsShown: {},
        _wl: { entries: [] },
        _panelAgentsHtml: '',
        formatTokens: (n: number) => String(n),
        updateTimersIn: () => {},
        morphInnerHtml: (_el: unknown, h: string) => {
          writes++;
          html = h;
        },
      },
    );
    m.renderPanelAgents();
    m.renderPanelAgents();
    expect(writes).toBe(1);
    expect(html).toContain('<span>에이전트 3</span>');
  });

  it('entries naming an agent the bar does not show — by agentId or agentRef — refresh it, from any paint (review B r2)', () => {
    const m = load<{ wlNamesNewAgent(a: unknown[]): boolean }>(['wlNamesNewAgent'], [], {
      _panelAgentIdsShown: { toolu_known: true },
    });
    const A = (extra: Record<string, unknown>) => ({ entry: E(1, extra), index: 0 });
    expect(m.wlNamesNewAgent([A({ agentRef: 'toolu_new' })])).toBe(true);
    expect(m.wlNamesNewAgent([A({ agentId: 'toolu_new' })])).toBe(true);
    expect(m.wlNamesNewAgent([A({ agentRef: 'toolu_known' }), A({ agentId: 'toolu_known' }), A({})])).toBe(false);
    // Live entries, older pages and recovery merges all paint through paintWorkLog.
    expect(fnBody('paintWorkLog')).toContain('if (wlNamesNewAgent(added)) renderPanelAgents();');
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

  it('wiring: openPanel takes the agent, the scope switch repaints Tasks and the log, task_update only paints main', () => {
    expect(fnBody('openPanel')).toContain("_panelAgent = agentId ? String(agentId) : '';");
    expect(fnBody('openPanel')).toContain('renderPanelAgents();');
    expect(fnBody('openPanel')).toContain('renderPanelTasks(panelAgentTasks(), panelAgentLabel());');
    expect(fnBody('selectPanelAgent')).toContain('renderPanelTasks(panelAgentTasks(), panelAgentLabel());');
    expect(fnBody('selectPanelAgent')).toContain('repaintWorkLogScope();');
    expect(fnBody('wlRenderList')).toContain('wlBuildRows(wlScopeEntries(state.entries))');
    expect(fnBody('paintWorkLog')).toContain('var scopedCount = wlScopeEntries(state.entries).length;');
    expect(fnBody('paintWorkLog')).toContain("if (!scopedCount) showWorkLogEmpty('이 에이전트의 작업 로그 없음');");
    expect(fnBody('connectWs')).toContain('panelSessionKey === msg.sessionKey && !_panelAgent');
    expect(fnBody('renderCardFace')).toContain('+ renderCardAgents(s)');
    expect(fnBody('renderCardBody')).toContain('+ renderAgentTree(s)');
    expect(TEMPLATE).toContain('<div class="panel-agents" id="panel-agents" style="display:none"></div>');
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
      h('button', { class: 'ag-row is-main', 'data-agent-open': '' }, '메인'),
      h(
        'button',
        { class: 'ag-row is-sub is-running', 'data-agent-open': 'toolu_a' },
        h('span', { class: 'ag-icon' }, h('span', { class: 'spinner ag-spinner' })),
        h('span', { class: 'ag-tools' }, tools),
        h('span', { class: 'ag-span' }, h('i', { style: width })),
      ),
      h('button', { class: 'ag-row is-sub is-' + second, 'data-agent-open': 'toolu_b' }, second),
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
    fresh.insertBefore(h('button', { class: 'ag-row is-sub', 'data-agent-open': 'toolu_new' }, 'new'), fresh.kids[2]);
    morph.domMorph(live, fresh);
    expect(live.kids.map((k) => k.getAttribute('data-agent-open'))).toEqual(['', 'toolu_a', 'toolu_new', 'toolu_b']);
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
    expect(live.kids.map((k) => k.getAttribute('data-agent-open'))).toEqual(['', 'toolu_b']);
    expect(live.kids[1]).toBe(b);
  });

  it('a row that leaves while a new one arrives keeps the survivor: [메인, A, B] → [메인, B, C] (review B r3 astra)', () => {
    const live = tree('툴 3', 'w', 'running');
    const b = live.kids[2];
    const fresh = tree('툴 3', 'w', 'running');
    fresh.removeChild(fresh.kids[1]);
    fresh.insertBefore(h('button', { class: 'ag-row is-sub', 'data-agent-open': 'toolu_c' }, 'c'), null);
    morph.domMorph(live, fresh);
    expect(live.kids.map((k) => k.getAttribute('data-agent-open'))).toEqual(['', 'toolu_b', 'toolu_c']);
    expect(live.kids[1]).toBe(b);
  });

  it('a section inserted before others does not shift them onto each other (review B r3 astra)', () => {
    const body = (withSub: boolean) =>
      h(
        'div',
        { class: 'card-body' },
        ...(withSub ? [h('div', { class: 'card-sub' }, 'issue title')] : []),
        h('div', { class: 'card-meta' }, 'meta'),
        h('div', { class: 'ag-tree' }, h('button', { class: 'ag-row is-sub', 'data-agent-open': 'toolu_a' }, 'A')),
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
    expect(fnBody('wlNavRows')).toContain("'.wl-group-head, .wl-row, .wl-agent-link'");
    expect(fnBody('wlSetTabStop')).toContain('.wl-agent-link[tabindex="0"]');
    expect(fnBody('wlEnsureTabStop')).toContain('.wl-agent-link[tabindex="0"]');
    expect(TEMPLATE).toContain("if (isLink && (e.key === 'Enter' || e.key === ' ')) return;");
  });
  it('choosing an agent by keyboard leaves focus on the agent now shown, not on <body> (review B r3)', () => {
    const body = fnBody('selectPanelAgent');
    expect(body).toContain("before.closest('#slide-panel')");
    expect(body).toContain('#panel-agents button.pa-crumb[aria-current="true"]');
  });
  it('the panel Tasks block writes nothing for the same data and morphs a change (review B r3 astra)', () => {
    let writes = 0;
    const container = { style: {} as Record<string, string> } as Record<string, unknown>;
    const m = load<{ renderPanelTasks(t: unknown, l?: string): void }>(
      ['esc', 'renderPanelTaskItem', 'renderPanelTasks'],
      [],
      {
        document: { getElementById: (id: string) => (id === 'panel-tasks' ? container : null) },
        _panelTasksExpanded: false,
        morphInnerHtml: () => {
          writes++;
        },
      },
    );
    const tasks = [{ id: 'T1', content: 'a', status: 'completed' }];
    m.renderPanelTasks(tasks, 'A1 Explore');
    m.renderPanelTasks(tasks, 'A1 Explore');
    expect(writes).toBe(1);
    m.renderPanelTasks([...tasks, { id: 'T2', content: 'b', status: 'pending' }], 'A1 Explore');
    expect(writes).toBe(2);
    expect(fnBody('renderPanelTasks')).not.toContain('container.innerHTML =');
  });
  it('a refused model switch puts the picker back on the session model — also the second time, when the card markup does not change (review B r4 astra)', async () => {
    const select = {
      value: 'sonnet',
      disabled: false,
      selectedIndex: 1,
      options: [{ defaultSelected: true }, { defaultSelected: false }],
      blur() {},
    };
    let refreshed = 0;
    const m = load<{ changeModel(k: string, s: unknown): Promise<void> }>(['modelSwitchNote', 'changeModel'], [], {
      postModelSwitch: async () => ({ ok: false, error: 'rejected' }),
      _modelNotes: {},
      formatTokens: String,
      refreshCard: () => {
        refreshed++; // same markup on the second refusal: the card writes nothing
      },
      loadSessions: () => {},
    });
    await m.changeModel('k', select);
    expect(select.selectedIndex).toBe(0);
    select.selectedIndex = 1;
    await m.changeModel('k', select);
    expect(select.selectedIndex).toBe(0);
    expect(refreshed).toBe(2);
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
