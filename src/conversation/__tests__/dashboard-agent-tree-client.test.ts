/**
 * Spec 12 (agent tree) §4, rev 2 — dashboard client half. Executes the shipped
 * client code cut out of renderDashboardPage()'s template literal and cooked
 * exactly as the browser receives it (the harness of dashboard-agent-inbox-client.test.ts):
 *
 *   §4.0  one node type: the main agent is the root of the session's agent
 *         tree (agentTreeOf), its status from lifecycle evidence
 *   §4.1  collapsed card: one agents row — status dots + "서브에이전트 N · 실행 r · 실패 f"
 *   §4.2  open card: one ARIA tree drawn by one recursive renderer — the same
 *         item and row slots for the root and every subagent, relative levels,
 *         default folding with +N, a cap per parent, one roving tab stop, the
 *         tree keys and click boundaries
 *   §4.3  panel: a drill-down over the same tree (path · focused node header ·
 *         its subtree); the focused node scopes Tasks and the work log; a
 *         parent's log carries each child's live block
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
const AGENT_FNS = [
  ...NODE_FNS,
  'agentCounts',
  'renderCardAgents',
  'cardCurrentTask',
  'renderCardTaskRow',
  'renderAgentTree',
];
const AGENT_VARS = [
  'AN_LIVE_LINE',
  'AGENT_STATUS_LABEL',
  'AGENT_TREE_ROWS',
  'AGENT_DOTS_MAX',
  'AGENTS_SVG',
  'AN_CHEV_SVG',
  '_anOpen',
  '_anAll',
  '_anActive',
];

type Agent = Record<string, unknown>;
type Node = Record<string, any> & { id: string; children: Node[] };
interface AgentUi {
  renderCardAgents(s: unknown): string;
  renderAgentTree(s: unknown, col?: string): string;
  agentSpanAxis(a: Agent[], last: number): { t0: number; t1: number };
  agentSpanStyle(a: Agent, axis: { t0: number; t1: number }): string;
  agentTreeOf(s: unknown, col?: string, extras?: string[]): Node;
  rootStatusOf(s: unknown, col?: string): string;
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

describe('one node type — the main agent is the root of the same recursive tree', () => {
  const KEY = 'inst::C1:t1';
  const NS = 'c|' + KEY;
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
  const liOf = (html: string, id: string) => {
    const at = html.indexOf(`data-agent-open="${id}"`);
    if (at < 0) return '';
    const start = html.lastIndexOf('<li ', at);
    return html.slice(start, html.indexOf('>', at) + 1);
  };

  it('the client has one row renderer: the main-only and subagent-only row functions are gone', () => {
    expect(declarationCount('renderMainAgentRow')).toBe(0);
    expect(declarationCount('renderAgentRow')).toBe(0);
    expect(fnBody('renderAgentTree')).toContain('anTreeHtml(root, root, ctx)');
    expect(fnBody('renderPanelAgents')).toContain('anTreeHtml(root, node, ctx)');
    expect(fnBody('renderPanelAgents')).toContain('renderAgentFocus(node, s)');
    // anTreeHtml draws the anchor itself (card) or its children (panel) — both through renderAgentNode.
    expect(fnBody('anTreeHtml')).toContain('renderAgentNode(anchor, 0, 1, 1, ctx, false)');
    expect(fnBody('renderAgentNodes')).toContain('renderAgentNode(kids[i], d, i + 1, kids.length, ctx');
    expect(fnBody('renderAgentNode')).toContain('renderAgentNodes(node, d + 1, ctx)');
  });

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

  it('root and subagents render through renderAgentNode: same item, same slots, nested groups', () => {
    const html = ui.renderAgentTree(card(), 'working');
    expect(html).toContain('<ul class="an-tree" role="tree"');
    // The root item.
    const root = liOf(html, '');
    expect(root).toContain('class="an is-running is-root"');
    expect(root).toContain('role="treeitem"');
    expect(root).toContain('aria-level="1" aria-setsize="1" aria-posinset="1" aria-expanded="true"');
    // A subagent item: same element, its level and its place among its siblings.
    const explore = liOf(html, 'toolu_explore');
    expect(explore).toContain('class="an is-running"');
    expect(explore).toContain('aria-level="2" aria-setsize="2" aria-posinset="1" aria-expanded="true"');
    const lib = liOf(html, 'toolu_lib');
    expect(lib).toContain('aria-level="2" aria-setsize="2" aria-posinset="2"');
    expect(lib).not.toContain('aria-expanded'); // a leaf has no expanded state
    // The nested subagent sits in its parent's group, one level down.
    const group = html.indexOf('<ul class="an-kids" role="group"', html.indexOf('data-agent-open="toolu_explore"'));
    expect(group).toBeGreaterThan(0);
    expect(html.indexOf('data-agent-open="toolu_nested"')).toBeGreaterThan(group);
    expect(liOf(html, 'toolu_nested')).toContain('aria-level="3" aria-setsize="1" aria-posinset="1"');
    // Every item carries the same row slots — the root included — at the card's compact density (spec 13).
    expect(html.match(/<div class="an-row is-compact">/g)).toHaveLength(4);
    expect(html.match(/<span class="ag-meta"><span class="ag-st">/g)).toHaveLength(4);
  });

  // Spec 13: on the card every row — the root included — has the same compact
  // slots (status in words, time, and one line when live or failed); the detail
  // (tools, tokens, background, description, the waterfall) is the panel's.
  it('the root row carries what a subagent row carries: status in words, time — compact on the card', () => {
    const html = ui.renderAgentTree(card(), 'working');
    const rootRow = html.slice(html.indexOf('<div class="an-row is-compact">'), html.indexOf('<ul class="an-kids"'));
    expect(rootRow).toContain('<span class="ag-type">메인</span>');
    // The card's control strip names the model: the compact root does not say it again.
    expect(rootRow).not.toContain('opus-5-5[1m]');
    expect(rootRow).toContain('<span class="ag-st">실행 중</span>');
    expect(rootRow).toContain('class="card-timer-live" data-leg-started="' + T0 + '"');
    // The face's task row already names #T2: the root does not say it again.
    expect(rootRow).not.toContain('#T2 Build');
    expect(rootRow).not.toContain('툴 7');
    // No waterfall, tools, background or description on the card at all.
    expect(html).not.toContain('ag-span');
    expect(html).not.toContain('class="ag-tools"');
    expect(html).not.toContain('<span class="ag-bg">');
    expect(html).not.toContain('<span class="ag-desc">');
    // A subagent row: id + type, status word, time; a live one says what it does, a failed one why.
    expect(html).toContain('<span class="ag-id">A1</span><span class="ag-type">Explore</span>');
    expect(html).toContain('data-since="' + T0 + '"');
    expect(html).toContain('<span class="ag-sub">#T1 Reading the mapper</span>');
    expect(html).toContain('<span class="ag-st">실패</span>');
    expect(html).toContain('<span class="ag-sub">Nested look</span>');
    // A finished one is just its status and run time.
    expect(html).toContain('4m 2s');
    expect(html).not.toContain('마지막 도구 WebFetch');
  });

  it('each item has one composed accessible name; activation and expansion use data attributes, never inline JS', () => {
    const html = ui.renderAgentTree(card(), 'working');
    // Everything the row shows but the ticking time, which the item names as its description (review r1 astra).
    // Compact density: the name lists the slots the row shows (spec 13).
    expect(liOf(html, 'toolu_explore')).toContain('aria-label="A1 Explore, 실행 중, #T1 Reading the mapper, 하위 1"');
    expect(liOf(html, '')).toContain('aria-label="메인, 실행 중, 하위 3"');
    const describedBy = /aria-describedby="([^"]+)"/.exec(liOf(html, 'toolu_explore'))?.[1] ?? '';
    expect(describedBy).toBe('an-c_7c_inst_3a__3a_C1_3a_t1-ntoolu_5f_explore-t');
    expect(html).toContain(`<span class="ag-time" id="${describedBy}">`);
    expect(html).not.toContain('onclick=');
    // The root is always open: no chevron. A parent below it has one, out of the tab order.
    expect(html).not.toContain('data-an-toggle=""');
    // The chevron is a mouse target only — not focusable, so a click never strands focus on it (review r1 fable).
    expect(html).toContain('<span class="an-chev is-toggle" aria-hidden="true" data-an-toggle="toolu_explore">');
    expect(html).not.toContain('<button type="button" class="an-chev"');
  });

  it('default expansion is relative to the tree: the root and its children are open, deeper parents start folded with +N', () => {
    const m = load<AgentUi>(AGENT_FNS, AGENT_VARS);
    const html = m.renderAgentTree(card({ agents: chain() }), 'working');
    expect(liOf(html, 'a')).toContain('aria-expanded="true"');
    expect(liOf(html, 'b')).toContain('aria-expanded="false"'); // level 3: folded
    expect(html).toContain('data-agent-open="b"');
    expect(html).not.toContain('data-agent-open="c"');
    const bItem = html.slice(html.indexOf('data-agent-open="b"'));
    expect(bItem).toContain('<span class="an-more is-running" title="하위 에이전트 2">+2</span>');
  });

  it('a user toggle overrides the default and is remembered per tree and node', () => {
    const anOpen: Record<string, boolean> = {};
    const m = load<AgentUi>(
      AGENT_FNS,
      AGENT_VARS.filter((v) => v !== '_anOpen'),
      { _anOpen: anOpen },
    );
    anOpen[NS + '|b'] = true;
    const html = m.renderAgentTree(card({ agents: chain() }), 'working');
    expect(html).toContain('data-agent-open="c"');
    expect(liOf(html, 'c')).toContain('aria-expanded="false"');
    anOpen[NS + '|a'] = false;
    const folded = m.renderAgentTree(card({ agents: chain() }), 'working');
    expect(folded).not.toContain('data-agent-open="b"');
    expect(liOf(folded, 'a')).toContain('aria-expanded="false"');
  });

  it('every parent shows at most 6 children, the rest behind its own 전체 N개 보기 — at every level', () => {
    const kids = Array.from({ length: 9 }, (_, i) => ({
      id: `k${i}`,
      n: i + 1,
      status: 'completed',
      startedAt: T0 + i,
    }));
    const grand = Array.from({ length: 8 }, (_, i) => ({
      id: `g${i}`,
      n: 20 + i,
      parentId: 'k0',
      status: 'completed',
      startedAt: T0 + 20 + i,
    }));
    const anAll: Record<string, boolean> = {};
    const m = load<AgentUi>(
      AGENT_FNS,
      AGENT_VARS.filter((v) => v !== '_anAll'),
      { _anAll: anAll },
    );
    const html = m.renderAgentTree(card({ agents: [...kids, ...grand], agentsTotal: 17 }), 'working');
    expect(html.match(/data-agent-open="k\d"/g)).toHaveLength(6);
    expect(html.match(/data-agent-open="g\d"/g)).toHaveLength(6);
    expect(html).toContain('data-an-all=""');
    expect(html).toContain('전체 9개 &rarr; 상세');
    expect(html).toContain('data-an-all="k0"');
    expect(html).toContain('전체 8개 &rarr; 상세');
    // Spec 13: the card is a preview — the rest opens in the panel on that parent, never in place.
    anAll[NS + '|'] = true;
    const all = m.renderAgentTree(card({ agents: [...kids, ...grand], agentsTotal: 17 }), 'working');
    expect(all.match(/data-agent-open="k\d"/g)).toHaveLength(6);
    expect(all).not.toContain('접기');
  });

  it('one roving tab stop per tree — on the active node when visible, else its nearest visible ancestor', () => {
    const anActive: Record<string, string> = {};
    const m = load<AgentUi>(
      AGENT_FNS,
      AGENT_VARS.filter((v) => v !== '_anActive'),
      { _anActive: anActive },
    );
    const stops = (html: string) => (html.match(/<li [^>]*tabindex="0"/g) || []).length;
    let html = m.renderAgentTree(card(), 'working');
    expect(stops(html)).toBe(1);
    expect(liOf(html, '')).toContain('tabindex="0"');
    anActive[NS] = 'toolu_nested';
    html = m.renderAgentTree(card(), 'working');
    expect(stops(html)).toBe(1);
    expect(liOf(html, 'toolu_nested')).toContain('tabindex="0"');
    // The active node is folded away (level 4 under a folded parent): its nearest visible ancestor holds the stop.
    anActive[NS] = 'c';
    html = m.renderAgentTree(card({ agents: chain() }), 'working');
    expect(stops(html)).toBe(1);
    expect(liOf(html, 'b')).toContain('tabindex="0"');
  });

  it('arrow keys follow the tree pattern (APG): move, open / first child, close / parent, Home / End, Enter', () => {
    const k = load<{ anKeyAction(key: string, info: Record<string, boolean>): string }>(['anKeyAction'], []);
    expect(k.anKeyAction('ArrowDown', {})).toBe('next');
    expect(k.anKeyAction('ArrowUp', {})).toBe('prev');
    expect(k.anKeyAction('Home', {})).toBe('first');
    expect(k.anKeyAction('End', {})).toBe('last');
    expect(k.anKeyAction('ArrowRight', { hasKids: true, open: false })).toBe('expand');
    expect(k.anKeyAction('ArrowRight', { hasKids: true, open: true })).toBe('child');
    expect(k.anKeyAction('ArrowRight', {})).toBe('');
    expect(k.anKeyAction('ArrowLeft', { hasKids: true, open: true })).toBe('collapse');
    expect(k.anKeyAction('ArrowLeft', { hasKids: true, open: true, root: true })).toBe('');
    expect(k.anKeyAction('ArrowLeft', { open: false })).toBe('parent');
    expect(k.anKeyAction('Enter', {})).toBe('activate');
    expect(k.anKeyAction(' ', {})).toBe('activate');
    // Wired: one keydown path for the card tree and the panel tree.
    expect(TEMPLATE).toContain('e.target.closest(\'.an-tree [role="treeitem"]\')');
  });

  it("focus kept across a morph finds a parent's 전체 N개 보기 again by its parent, never as the root (review r1 grok)", () => {
    const k = load<{ anItemKey(item: unknown): string }>(['anItemId', 'anItemKey'], []);
    const item = (attrs: Record<string, string>) => ({ getAttribute: (n: string) => (n in attrs ? attrs[n] : null) });
    expect(k.anItemKey(item({ 'data-an-all': 'k0' }))).toBe('a:k0');
    expect(k.anItemKey(item({ 'data-an-all': '' }))).toBe('a:');
    expect(k.anItemKey(item({ 'data-agent-open': '' }))).toBe('n:');
    expect(k.anItemKey(item({ 'data-agent-select': 'toolu_x' }))).toBe('n:toolu_x');
    expect(fnBody('anFocusCapture')).toContain('chain.push(anItemKey(cur));');
    expect(fnBody('anFocusRestore')).toContain('anItemKey(items[i]) === cap.chain[c]');
  });

  it('clicks: the chevron only folds, a row opens that node, the area of its children opens nothing', () => {
    const body = fnBody('anClick');
    const row = body.indexOf("e.target.closest('.an-row')");
    expect(body.indexOf("e.target.closest('[data-an-toggle]')")).toBeGreaterThan(0);
    expect(body.indexOf("e.target.closest('[data-an-toggle]')")).toBeLessThan(row);
    expect(body.indexOf("e.target.closest('[data-an-all]')")).toBeLessThan(row);
    // The card board and the panel share it.
    expect(TEMPLATE).toContain('if (anClick(e, root)) return;');
    expect(TEMPLATE).toContain('if (anClick(e, bar)) return;');
  });

  it('a parent cycle of any length is broken — every agent reachable, the descendant count finite (review r1 astra)', () => {
    const ring = Array.from({ length: 65 }, (_, i) => ({
      id: `r${i}`,
      n: i + 1,
      parentId: `r${(i + 1) % 65}`,
      status: 'completed',
      startedAt: T0 + i,
    }));
    const root = ui.agentTreeOf(card({ agents: ring }), 'working');
    const reached = new Set<string>();
    const walk = (n: Node) => {
      for (const c of n.children) {
        reached.add(c.id);
        walk(c);
      }
    };
    walk(root);
    expect(reached.size).toBe(65);
    const d = load<{ anDesc(n: unknown): { n: number } }>(['anDesc'], []);
    expect(d.anDesc(root).n).toBe(65);
  });

  it("the root's open leg keeps counting while the turn waits on a permission (review r1 astra)", () => {
    const html = ui.renderAgentTree(card({ activityState: 'waiting' }), 'waiting');
    const rootRow = html.slice(html.indexOf('<div class="an-row is-compact">'), html.indexOf('<ul class="an-kids"'));
    expect(rootRow).toContain('<span class="ag-st">입력 대기</span>');
    expect(rootRow).toContain('data-leg-started="' + T0 + '"');
  });

  it('description ids never collide across sessions or nodes — the encoding is reversible (review r2 astra)', () => {
    const k = load<{ anIdPart(v: string): string }>(['anIdPart'], []);
    expect(k.anIdPart('c|dev-a::C1:t')).not.toBe(k.anIdPart('c|dev_a::C1:t'));
    expect(k.anIdPart('a-b')).not.toBe(k.anIdPart('a_b'));
    expect(k.anIdPart('a-b')).not.toContain('-');
  });

  it('a mouse click on 전체 N개 보기 or any focus in a tree takes the tab stop; a chosen drill lands on the header (review r2 astra)', () => {
    // A click on 전체 N개 goes through anActivate, which takes the stop first (spec 13: card → panel, panel → in place).
    expect(fnBody('anClick')).toContain('anActivate(more);');
    expect(fnBody('anActivate')).toContain("_anActive[ns] = 'a:' + allId;");
    expect(TEMPLATE).toContain("document.addEventListener('focusin', function(e) {");
    expect(fnBody('renderPanelAgents')).toContain('var cap = _anScopeChange ? null : anFocusCapture(el);');
    const sel = fnBody('selectPanelAgent');
    expect(sel).toContain('try { renderPanelAgents(); } finally { _anScopeChange = false; }');
    expect(sel.indexOf("document.querySelector('#panel-agents .pa-focus')")).toBeLessThan(
      sel.indexOf(`document.querySelector('#panel-agents .pa-crumb[aria-current="page"]')`),
    );
  });

  it('stop, focus and state move together; keyboard activation hands focus to the panel and back (review r1 astra)', () => {
    const stop = fnBody('anSetStop');
    expect(stop).toContain(`tree.querySelectorAll('[role="treeitem"][tabindex="0"]')`);
    expect(stop).toContain("_anActive[ns] = all !== null ? 'a:' + all : anItemId(to);");
    expect(fnBody('anMoveStop')).toContain('anSetStop(tree, ns, to);');
    expect(fnBody('anFocusRestore')).toContain("anSetStop(tree, tree.getAttribute('data-an-ns') || '', to);");
    expect(fnBody('renderAgentNodes')).toContain("tabindex=\"' + (ctx.stop === allKey ? '0' : '-1') + '\"");
    expect(fnBody('anTreeHtml')).toContain("String(want).indexOf('a:') === 0");
    expect(fnBody('anOnKey')).toContain('anActivate(item, true);');
    expect(fnBody('anActivate')).toContain("document.querySelector('#panel-agents .pa-focus')");
    expect(fnBody('closePanel')).toContain('var back = _anReturnFocus || _panelReturnFocus;');
    // Opened another way (a click, another card): no stale return target (review r2 fable).
    expect(fnBody('openPanel')).toContain('_anReturnFocus = null;');
    expect(fnBody('renderAgentFocus')).toContain('role="group" tabindex="-1" aria-label="');
  });

  it('a poll without the WebSocket repaints the focused node too; the server pushes a main tool count (review r1 astra)', () => {
    // Spec 13: the poll repaints the whole panel (repaintPanelSession → repaintPanelScope).
    expect(fnBody('loadSessions')).toContain('repaintPanelSession();');
    expect(fnBody('repaintPanelSession')).toContain('repaintPanelScope();');
    const index = readFileSync(join(__dirname, '..', '..', 'index.ts'), 'utf-8');
    expect(index).toContain("if (entry.kind === 'tool' && ownerKey) scheduleLiveSessionUpdate(ownerKey);");
  });

  it('the same card renders the same markup (the reconciler leaves it alone)', () => {
    expect(ui.renderAgentTree(card(), 'working')).toBe(ui.renderAgentTree(card(), 'working'));
  });

  it('names agents beyond the card; hostile text is text; no subagents → no tree on the card', () => {
    const html = ui.renderAgentTree(card({ agentsTotal: 7 }), 'working');
    expect(html).toContain('이전 에이전트 4개는 카드 목록 밖');
    const bad = '"><img src=x onerror=alert(1)>';
    const hostile = ui.renderAgentTree(
      card({ agents: [{ id: 'x"y', n: 1, type: bad, description: bad, status: 'running', startedAt: T0 }] }),
      'working',
    );
    expect(hostile).not.toContain('<img');
    expect(hostile).toContain('data-agent-open="x&quot;y"');
    expect(ui.renderAgentTree(card({ agents: [] }), 'working')).toBe('');
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

  it('wiring: openPanel takes the agent, the scope switch repaints Tasks and the log', () => {
    expect(fnBody('openPanel')).toContain("_panelAgent = agentId ? String(agentId) : '';");
    // Spec 13: openPanel goes through the one live path (repaintPanelSession → repaintPanelScope).
    expect(fnBody('openPanel')).toContain('repaintPanelSession();');
    expect(fnBody('repaintPanelScope')).toContain('renderPanelAgents();');
    expect(fnBody('repaintPanelScope')).toContain('repaintPanelTasks();');
    expect(fnBody('selectPanelAgent')).toContain('repaintPanelTasks();');
    expect(fnBody('selectPanelAgent')).toContain('repaintWorkLogScope();');
    // Paired tool results live in their call's card (wlVisible), so they are not rows.
    expect(fnBody('wlRenderList')).toContain('wlBuildRows(wlVisible(state, wlScopeEntries(state.entries)))');
    // Counts what the list shows: a paired result lives in its call's card.
    expect(fnBody('paintWorkLog')).toContain(
      'var scopedCount = wlVisible(state, wlScopeEntries(state.entries)).length;',
    );
    expect(fnBody('paintWorkLog')).toContain("if (!scopedCount) showWorkLogEmpty('이 에이전트의 작업 로그 없음');");
    expect(fnBody('renderCardFace')).toContain('+ renderCardAgents(s)');
    expect(fnBody('renderCardBody')).toContain('const agentsHtml = renderAgentTree(s, col);');
    expect(TEMPLATE).toContain('<div class="panel-agents" id="panel-agents" style="display:none"></div>');
  });
});

describe('panel — drill-down over the same node type (path · focused node · its subtree)', () => {
  const PANEL_FNS = [
    ...NODE_FNS,
    'cardTotalTokens',
    'renderAgentFocus',
    'panelLogOnlyAgents',
    'sessionColOf',
    'renderPanelAgents',
  ];
  function panel(focus: string, s: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const el = { style: {} as Record<string, string>, innerHTML: '' };
    const out = { html: '', writes: 0 };
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
        anFocusCapture: () => null,
        anFocusRestore: () => {},
        _anScopeChange: false,
        morphInnerHtml: (_el: unknown, h: string) => {
          out.writes++;
          out.html = h;
        },
        ...extra,
      },
    );
    return { m, el, out };
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
    expect(out.html).toContain('class="pa-focus is-idle"');
    expect(out.html).toContain('<span class="ag-type">메인</span>');
    expect(out.html).toContain('대기');
    expect(out.html).toContain('툴 2');
    expect(out.html).toContain('task 합계 1200 tok · $0.00');
    expect(out.html).not.toContain('세션 Σ');
    expect(out.html).not.toContain('role="tree"');
    // The root has nothing above it: no path.
    expect(out.html).not.toContain('pa-path');
  });

  it('the path is generated from the chain of the focused node — the root crumb is its label, not a hard-coded button', () => {
    const { m, out } = panel('toolu_nested', card());
    m.renderPanelAgents();
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

  it("the focused node's children are a tree (levels relative to the focused node), all of them shown", () => {
    const kids = Array.from({ length: 9 }, (_, i) => ({
      id: `k${i}`,
      n: 10 + i,
      parentId: 'toolu_explore',
      status: 'completed',
      startedAt: T0 + i,
    }));
    const { m, out } = panel('toolu_explore', card({ agents: [...AGENTS, ...kids] }));
    m.renderPanelAgents();
    expect(out.html).toContain('<ul class="an-tree pa-tree" role="tree"');
    expect(out.html.match(/data-agent-select="k\d"/g)).toHaveLength(9);
    const nested = out.html.slice(out.html.lastIndexOf('<li ', out.html.indexOf('data-agent-select="toolu_nested"')));
    expect(nested).toContain('aria-level="1"');
  });

  it('drilling in opens what was folded below — and a node the user folded stays folded across the drill', () => {
    const atRoot = panel('', card({ agents: chain() }));
    atRoot.m.renderPanelAgents();
    expect(atRoot.out.html).toContain('data-agent-select="b"');
    expect(atRoot.out.html).not.toContain('data-agent-select="c"');
    const intoA = panel('a', card({ agents: chain() }));
    intoA.m.renderPanelAgents();
    expect(intoA.out.html).toContain('data-agent-select="c"');
    const c = intoA.out.html.slice(intoA.out.html.lastIndexOf('<li ', intoA.out.html.indexOf('data-agent-select="c"')));
    expect(c).toContain('aria-level="2"');
    const folded = panel('a', card({ agents: chain() }), { _anOpen: { 'p|k|b': false } });
    folded.m.renderPanelAgents();
    expect(folded.out.html).not.toContain('data-agent-select="c"');
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
  it("a subagent's header shows its own spend — tokens and API-equivalent cost; the SDK context size is never shown", () => {
    const agents = [{ ...AGENTS[0], tokens: 134, spend: SPEND }, AGENTS[1], AGENTS[2]];
    const { m, out } = panel('toolu_explore', card({ agents }));
    m.renderPanelAgents();
    const head = out.html.slice(
      out.html.indexOf('class="pa-focus'),
      out.html.indexOf('</div>', out.html.indexOf('class="pa-sum"')),
    );
    expect(head).toContain('10000 tok · $1.23');
    expect(out.html).not.toContain('134 tok');
  });

  it('every subagent row in the panel tree carries its own spend; an unpriced model reads as an estimate (≈)', () => {
    const lib = { ...AGENTS[2], spend: { ...SPEND, costUsd: 0.5, unpricedModels: ['grok-4.7-build'] } };
    const { m, out } = panel('', card({ agents: [{ ...AGENTS[0], spend: SPEND }, AGENTS[1], lib] }));
    m.renderPanelAgents();
    const row = (id: string) => {
      const at = out.html.indexOf(`data-agent-select="${id}"`);
      return out.html.slice(out.html.lastIndexOf('<li ', at), out.html.indexOf('</li>', at));
    };
    expect(row('toolu_explore')).toContain('10000 tok · $1.23');
    expect(row('toolu_lib')).toContain('10000 tok · ≈$0.50');
    expect(row('toolu_lib')).toContain('grok-4.7-build');
  });

  it('a subagent with estimated calls reads ≈ and says how many calls were estimated (llmux zero usage)', () => {
    const est = { ...AGENTS[2], spend: { ...SPEND, costUsd: 0.5, estimatedCalls: 3 } };
    const { m, out } = panel('', card({ agents: [AGENTS[0], AGENTS[1], est] }));
    m.renderPanelAgents();
    const at = out.html.indexOf('data-agent-select="toolu_lib"');
    const row = out.html.slice(out.html.lastIndexOf('<li ', at), out.html.indexOf('</li>', at));
    expect(row).toContain('10000 tok · ≈$0.50');
    expect(row).toContain('usage가 기록되지 않은 호출 3회는 앞뒤 호출로 추정');
  });

  it('a subagent that started foreground subagents of its own says their calls are in its number', () => {
    const lead = { ...AGENTS[2], spend: { ...SPEND, calls: 9, nestedAgents: 2 } };
    const { m, out } = panel('', card({ agents: [AGENTS[0], AGENTS[1], lead] }));
    m.renderPanelAgents();
    const at = out.html.indexOf('data-agent-select="toolu_lib"');
    const row = out.html.slice(out.html.lastIndexOf('<li ', at), out.html.indexOf('</li>', at));
    expect(row).toContain('트리에 따로 없는 하위 에이전트 2개 포함');
    expect(row).not.toContain('하위 에이전트 제외');
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

  it('the current crumb is styled by the attribute it carries; a lost focus falls back to the tree stop (review r1 fable)', () => {
    expect(TEMPLATE).toContain('.pa-crumb[aria-current="page"] {');
    expect(TEMPLATE).toContain('.pa-crumb:not([aria-current="page"]):hover');
    expect(TEMPLATE).not.toContain('.pa-crumb[aria-current="true"]');
    expect(fnBody('anFocusRestore')).toContain(`el.querySelector('.an-tree [role="treeitem"][tabindex="0"]')`);
    // The header counts every node below; the subtree head counts direct children — different words.
    expect(fnBody('renderAgentFocus')).toContain("'하위 전체 ' + desc.n");
    expect(fnBody('renderPanelAgents')).toContain('하위 에이전트 <b>');
  });

  it('an unchanged panel writes nothing — focus, scroll and spinners survive a live update', () => {
    const { m, out } = panel('toolu_explore', card());
    m.renderPanelAgents();
    m.renderPanelAgents();
    expect(out.writes).toBe(1);
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

  it('nested tree items pair by node id inside their own group — a new grandchild keeps its siblings and their subtrees', () => {
    const item = (id: string, ...kids: FakeNode[]) =>
      h(
        'li',
        { class: 'an is-running', 'data-agent-open': id },
        h('div', { class: 'an-row' }, id),
        ...(kids.length ? [h('ul', { class: 'an-kids', role: 'group' }, ...kids)] : []),
      );
    const live = h('ul', { class: 'an-tree' }, item('', item('a', item('a1')), item('b')));
    const a = live.kids[0].kids[1].kids[0];
    const a1 = a.kids[1].kids[0];
    const b = live.kids[0].kids[1].kids[1];
    morph.domMorph(live, h('ul', { class: 'an-tree' }, item('', item('a', item('a0'), item('a1')), item('b'))));
    expect(live.kids[0].kids[1].kids[0]).toBe(a);
    expect(a.kids[1].kids.map((k) => k.getAttribute('data-agent-open'))).toEqual(['a0', 'a1']);
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
  it('the panel Tasks block writes nothing for the same data and morphs a change (review B r3 astra)', () => {
    let writes = 0;
    const container = { style: {} as Record<string, string> } as Record<string, unknown>;
    const m = load<{ renderPanelTasks(t: unknown, l?: string): void }>(
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
        document: { getElementById: (id: string) => (id === 'panel-tasks' ? container : null) },
        _panelTasksExpanded: false,
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
    m.renderPanelTasks([...tasks, { id: 'T2', content: 'b', status: 'pending' }], 'A1 Explore');
    expect(writes).toBe(2);
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
