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
  const start = TEMPLATE.indexOf(`\nfunction ${name}(`);
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
    const el = {
      style: {} as Record<string, string>,
      get innerHTML() {
        return html;
      },
      set innerHTML(v: string) {
        writes++;
        html = v;
      },
      querySelector: () => null,
    };
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
      },
    );
    m.renderPanelAgents();
    m.renderPanelAgents();
    expect(writes).toBe(1);
    expect(html).toContain('<span>에이전트 3</span>');
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
