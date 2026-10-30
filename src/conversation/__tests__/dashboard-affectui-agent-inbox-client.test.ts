/**
 * affectUI Agent Inbox → the session board on @2lab.ai/ui <ui-agent-inbox> (.prd/affectui/re-agent-inbox.md §4).
 * Executes the shipped client code cut out of renderDashboardPage()'s template
 * literal, cooked as the browser receives it (the harness of
 * dashboard-three-surfaces-client.test.ts), with injected fakes — no DOM.
 *
 * The host contract: the card each session becomes (cardOf — status, face extras,
 * gates), the board's wording (data.strings), the columns and DONE day groups
 * renderBoard hands the element (closed days as stubs, load, announce counts),
 * the open card's body in its slot (built only while open, #548) and the
 * element's events (ui-toggle, ui-group-toggle, ui-artifact).
 *
 * The element's own behaviour is @2lab.ai/ui's (src/components/agent-inbox/agent-inbox.test.ts):
 *   D1  tones from status ('maps status to tone, extension to glyph, counts to dots')
 *   D5  status in place first, the move 900 ms later ('pure helpers: holds …', 'shows a new status in place
 *       first …', 're-renders on its own when the hold ends', 'moves at once with reduced motion')
 *   D6  polite, coalesced announcement ('announces counts politely …', 'announces the host counts (data.announce)')
 *   D7  Esc closes the open card, focus back on its face — from the slotted body too ('Enter and Space toggle …;
 *       Esc closes …', 'leaves Escape to a text field …', 'bodyMode slot: … keeps Esc')
 *   D8  aria-controls / inert expand region ('opens a card in place on click and says so (ui-toggle)')
 *   D4  the status icon's pop is the element's (agent-inbox.ts update step 8); the library has no test of it yet.
 * Kept here: D10 — one primary button per open card (the body is still the page's); SSOT 2026-10-29
 *   T1/T2: no 작업 로그 button, the actions bar (Stop · Close · Slack) is the body's first row, and
 *   the element's ui-toggle opens / drops the card's detail card (openPanel / deckDrop).
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
// Cut + cooked once per name: the suites load the same functions many times.
const cutCache = new Map<string, string>();
function clientFn(name: string): string {
  const hit = cutCache.get(name);
  if (hit !== undefined) return hit;
  const cut = cutClientFn(name);
  cutCache.set(name, cut);
  return cut;
}
function cutClientFn(name: string): string {
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
/** A multi-line `var NAME = [ … ];` (clientVar only matches one line). */
function clientArrayVar(name: string): string {
  const start = TEMPLATE.indexOf(`\nvar ${name} = [`);
  if (start < 0) throw new Error(`client var ${name} not found`);
  const end = TEMPLATE.indexOf('\n];\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 4));
}
function load<T>(fns: string[], vars: string[], inject: Record<string, unknown> = {}): T {
  inject = { STRINGS: PAGE_STRINGS, ...inject };
  const names = Object.keys(inject);
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}

const T0 = 1_700_000_000_000;
const MIN = 60_000;

// ── D1 — the card the element draws (cardOf): status, extras, wording ──
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
const CARD_OF_VARS = ['PR_STATE_LABEL', 'PR_STATE_TONE', 'AGENT_STATUS_LABEL', 'AGENT_STATUS_TONE', 'OWNER_BADGE_HUES'];
const CARD_ENV = {
  dhShow: () => true,
  dhTruncate: () => null,
  currentUserId: 'U1',
  _ownerIndex: null,
  SELF_INSTANCE_NAME: 'inst',
};
type Card = Record<string, unknown>;
const faceCard = (over: Record<string, unknown> = {}) => ({
  key: 'inst::C1:t1',
  displayHeadline: 'Agent inbox',
  ownerId: 'U1',
  ownerName: 'Z',
  activityState: 'idle',
  activeLegStartedAtMs: 0,
  activeAccumulatedMs: 120_000,
  lastActivity: '2026-10-25T10:00:00.000Z',
  ...over,
});
const mapper = (env: Record<string, unknown> = {}) =>
  load<{ cardOf(s: unknown, col: string): Card }>(CARD_OF_FNS, CARD_OF_VARS, { ...CARD_ENV, ...env });

describe('D1 — the status the element tints: run · wait · done · rest (the tones are the element’s)', () => {
  const { cardOf } = mapper();
  it('waiting → waiting since it started waiting; working → running from the leg plus the time before it', () => {
    expect(cardOf(faceCard({ activityState: 'waiting', waitingSince: T0 }), 'waiting')).toMatchObject({
      status: 'waiting',
      since: T0,
    });
    const run = cardOf(faceCard({ activityState: 'working', activeLegStartedAtMs: T0 }), 'working');
    expect(run).toMatchObject({ status: 'running', since: T0, elapsedMs: 120_000 });
    expect(run.statusText).toBeUndefined();
  });

  it('idle → "Done in <active time>" since it finished; idle without active time → "Idle" in the done tone', () => {
    expect(cardOf(faceCard({ finishedAt: T0 }), 'idle')).toMatchObject({
      status: 'done',
      elapsedMs: 120_000,
      since: T0,
    });
    const idle = cardOf(faceCard({ activeAccumulatedMs: 0 }), 'idle');
    expect(idle).toMatchObject({ status: 'done', statusText: '대기' });
    expect(idle.since).toBeUndefined(); // only the exact finish stamp, never lastActivity
  });

  it('closed → the rest tone, Sleeping or Archived', () => {
    expect(cardOf(faceCard({ sessionState: 'SLEEPING', finishedAt: T0 }), 'closed')).toMatchObject({
      status: 'idle',
      statusText: '휴면',
      since: T0,
    });
    expect(cardOf(faceCard({ terminated: true }), 'closed')).toMatchObject({ status: 'idle', statusText: '보관됨' });
  });

  it('an armed automatic resume in RUNNING waits: the wait tone, its label, no clock; the reason leads the summary', () => {
    const s = faceCard({ autoResume: { kind: 'error-retry', at: T0, attempt: 1, maxAttempts: 3, reason: '429' } });
    const c = cardOf(s, 'working');
    expect(c.status).toBe('waiting');
    expect(String(c.statusText)).toMatch(/자동 재개 · 시도 1\/3$/);
    expect(c.since).toBeUndefined();
    expect(c.summary).toBe('오류: 429');
  });

  it('every card opens to the host body (bodyMode slot): Stop / Close, approval cards, question, tree, goal, model', () => {
    for (const col of ['waiting', 'working', 'idle', 'closed']) expect(cardOf(faceCard(), col).bodyMode).toBe('slot');
  });
});

describe('the face extras the board keeps (cardOf → lead, badge, metrics, titles, context level, file chips)', () => {
  const s = faceCard({
    activityState: 'working',
    activeLegStartedAtMs: T0,
    conversationId: 'conv-1',
    cronJob: { id: 'j1', name: 'nightly' },
    prUrl: 'https://github.com/o/r/pull/12',
    prShortRef: 'PR-12',
    prStatus: 'MERGED',
    prTitle: 'billing',
    userMedia: { count: 2 },
    artifacts: {
      count: 7,
      recent: [
        { id: 'a1', name: 'shot.png', kind: 'image' },
        { id: 'a2', name: 'r.html', kind: 'html' },
        { id: 'a3', name: 'n.md', kind: 'markdown' },
        { id: 'a4', name: 'x.csv', kind: 'text' },
        { id: 'a5', name: 'y.pdf', kind: 'pdf' },
      ],
    },
    tasks: [
      { id: 'T1', content: 'Read', status: 'completed' },
      { id: 'T2', content: 'Write the parser', activeForm: 'Writing', status: 'in_progress', startedAt: T0 },
    ],
    agents: [
      { status: 'completed' },
      { status: 'running' },
      { status: 'stopped' },
      { status: 'failed' },
      { status: 'weird' },
      { status: 'running' },
      { status: 'completed' },
    ],
    agentsTotal: 9,
    tokenUsage: {
      totalInputTokens: 1000,
      totalOutputTokens: 200,
      totalCacheReadTokens: 30_000,
      totalCacheCreateTokens: 500,
      totalCostUsd: 1.25,
      contextUsagePercent: 72.4,
    },
    subagentSpend: { agents: 7 },
    contextTokens: 610_000,
    autoCompactTokens: 750_000,
  });

  it('a cron run leads with the CRON clock, titled with its job; others keep the spark', () => {
    const { cardOf } = mapper();
    expect(cardOf(s, 'working').lead).toEqual({ text: 'CRON', glyph: 'clock', title: '크론 잡: nightly' });
    expect(cardOf(faceCard(), 'idle').lead).toBeUndefined();
  });

  it('the PR state is a word and a tone, the media count a paperclip with its accessible name — text only', () => {
    const { cardOf } = mapper();
    expect(cardOf(s, 'working').metrics).toEqual([
      { text: '2', glyph: 'attach', title: '지시 첨부 2개', label: '지시 첨부 2개' },
      { text: '#12 머지됨', glyph: 'pr', title: 'PR #12 머지됨 — billing', tone: 'done' },
    ]);
    const open = cardOf({ ...s, prStatus: 'open', userMedia: null }, 'working').metrics as Card[];
    expect(open).toEqual([{ text: '#12 열림', glyph: 'pr', title: 'PR #12 열림 — billing', tone: 'run' }]);
    expect(cardOf({ ...s, prStatus: 'weird', userMedia: null }, 'working').metrics).toEqual([
      { text: '#12', glyph: 'pr', title: 'PR #12 — billing' },
    ]);
  });

  it('the task row, sub-agents in spawn order (stopped is a square), tokens · cost with the task-total titles', () => {
    const { cardOf } = mapper();
    const c = cardOf(s, 'working');
    expect(c.task).toEqual({ label: 'Write the parser', id: 'T2', startedAt: T0 });
    expect(c.agents).toEqual({
      total: 9,
      running: 2,
      done: 2,
      failed: 1,
      dots: ['done', 'running', 'stopped', 'failed', 'unknown', 'running'],
    });
    expect(c.tokens).toBe(31_700);
    expect(c.costUsd).toBe(1.25);
    expect((c.titles as Card).tokens).toBe(
      '총 토큰 (task 합계: 메인 + 서브에이전트 7개) — 입력 1.0K · 출력 200 · 캐시 읽기 30.0K · 캐시 쓰기 500',
    );
    expect((c.titles as Card).cost).toBe('API 환산 비용 (task 합계: 메인 + 서브에이전트 7개)');
    // No task row once the session is done; the steps metric stays.
    expect(cardOf(s, 'idle').task).toBeUndefined();
    expect(cardOf(s, 'idle').steps).toEqual({ done: 1, total: 2 });
  });

  it('the context level and tooltip come from the auto-compact point (re-context-window D16)', () => {
    const { cardOf } = mapper();
    const c = cardOf(s, 'working');
    expect(c.contextPct).toBe(72.4);
    expect(c.contextLevel).toBe('warn'); // 610K of 750K ≥ 0.8
    expect((c.titles as Card).context).toBe('컨텍스트 72% · 자동 압축 750K까지 140K');
    expect(cardOf({ ...s, compactPending: true }, 'working').contextLevel).toBe('danger');
    expect(cardOf({ ...s, contextTokens: 0, autoCompactTokens: 0 }, 'working').contextLevel).toBe('warn'); // > 60 band
  });

  it('the newest four files are chip buttons (ui-artifact) with the whole count; none for a sibling instance', () => {
    const { cardOf } = mapper();
    const c = cardOf(s, 'working');
    expect(c.artifactsCount).toBe(7);
    expect(c.artifacts).toEqual([
      { id: 'a1', name: 'shot.png', kind: 'image' },
      { id: 'a2', name: 'r.html', kind: 'html' },
      { id: 'a3', name: 'n.md', kind: 'markdown' },
      { id: 'a4', name: 'x.csv', kind: 'text' },
    ]);
    const sib = cardOf({ ...s, environment: { instanceName: 'other' } }, 'working');
    expect(sib.artifacts).toBeUndefined();
    expect(sib.metrics).toEqual([{ text: '#12 머지됨', glyph: 'pr', title: 'PR #12 머지됨 — billing', tone: 'done' }]);
  });

  it('the header fields gate what the face carries (title, tasks, tokens, cost, context, links)', () => {
    const { cardOf } = mapper({ dhShow: () => false });
    const c = cardOf(s, 'working');
    expect(c.title).toBe('');
    for (const k of ['task', 'steps', 'tokens', 'costUsd', 'contextPct', 'titles']) expect(c[k]).toBeUndefined();
    expect(c.metrics).toEqual([{ text: '2', glyph: 'attach', title: '지시 첨부 2개', label: '지시 첨부 2개' }]);
    expect(mapper({ dhTruncate: () => 5 }).cardOf(s, 'working').title).toBe('Agent');
  });

  it('equal data gives an equal card (the clocks are the element’s tick, not the data)', () => {
    const { cardOf } = mapper();
    expect(JSON.stringify(cardOf(s, 'working'))).toBe(JSON.stringify(cardOf(JSON.parse(JSON.stringify(s)), 'working')));
  });
});

describe('the board’s wording (lang="ko" + data.strings, D2 group 6)', () => {
  const src = TEMPLATE.slice(TEMPLATE.indexOf('var BOARD_STRINGS = {'));
  const strings = new Function(
    'ART_KIND_LABEL',
    'toNum',
    `${cook(src.slice(0, src.indexOf('\n};\n') + 4))}\n${clientFn('fmtRunKo')}\nreturn BOARD_STRINGS;`,
  )({ image: '이미지' }, (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0));
  it('the element’s Korean table (status words, sub-agents, announcement, age); the page’s file chips, clock and no lead', () => {
    // Both boards (the kanban and every CRON lane) speak Korean: the element's own words.
    expect(TEMPLATE).toContain('<ui-agent-inbox id="kanban" class="kanban" view="board" lang="ko"></ui-agent-inbox>');
    expect(TEMPLATE).toContain("el.setAttribute('lang', 'ko');");
    // What the ko table already says is not repeated; the English age (timeAgo) is gone.
    for (const k of ['agents', 'agentsRunning', 'agentsFailed', 'arts', 'announce', 'ago', 'status']) {
      expect(strings[k], k).toBeUndefined();
    }
    expect(strings.artOpen('a.png', 'image')).toBe('이미지 a.png — 크게 보기');
    expect(strings.artOpen('x.bin', 'file')).toBe('파일 x.bin — 크게 보기');
    expect(strings.changed('Deploy', '실행 중')).toBe('');
    // A running card's clock in Korean (was 3m 07s).
    expect(strings.duration(12_000)).toBe('12초');
    expect(strings.duration(187_000)).toBe('3분 07초');
    expect(strings.duration(7_380_000)).toBe('2시간 3분');
  });
});

// load() returns only the named functions: the state seam is a shipped-scope function compiled in the same body.
function loadWithState<T>(fns: string[], vars: string[], inject: Record<string, unknown>, seam: string): T {
  inject = { STRINGS: PAGE_STRINGS, ...inject };
  const names = Object.keys(inject);
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\n${seam}\nreturn { ${[...fns, /^function (\w+)/.exec(seam)?.[1]].join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}

// ── renderBoard → the board element's data (columns, DONE by day, load, announce) ──
type Plan = {
  cols: Array<{
    id: string;
    label: string;
    keys: string[];
    groups?: Array<{ id: string; label: string; open: boolean; keys: string[] }>;
  }>;
  load: string;
  announce: unknown;
};
function boardHarness(opts: { boardLoad?: string; expanded?: string[]; groupOpen?: Record<string, boolean> } = {}) {
  const kanban: {
    _ibPlan?: Plan;
    data?: { columns: Array<Record<string, unknown>>; expanded: string[]; load: string; announce: unknown };
  } = {};
  const inbox = { classList: { toggle: () => {} } };
  const calls = { ensureIo: [] as string[], released: [] as unknown[], deepLink: 0 };
  const expanded = new Set<string>(opts.expanded ?? []);
  const m = loadWithState<{
    renderBoard(board: unknown, partial?: boolean): void;
    state(): { host: Record<string, unknown>; drawn: Record<string, boolean>; data: Record<string, Card> };
  }>(
    [
      'toNum',
      'planDoneColumn',
      'doneTimeOf',
      'dayKeyOf',
      'doneDayLabel',
      'planDoneGroups',
      'isCronCard',
      'cronGroupKey',
      'cronCardTime',
      'planCronLane',
      'cardBodyShown',
      'placeCard',
      'inboxPaint',
      'syncHasCards',
      'renderBoard',
    ],
    ['BOARD_LABELS', '_cardHost', '_cardCol', '_cardData', '_cardDrawn', '_cardClosing', '_boardRenders'],
    {
      document: { getElementById: (id: string) => (id === 'kanban' ? kanban : id === 'inbox' ? inbox : null) },
      _boardLoad: opts.boardLoad ?? 'ready',
      _sessionCache: Object.create(null),
      _acState: {},
      acEvict: () => {},
      _envIndex: null,
      _buildEnvIndex: () => ({}),
      _ownerIndex: null,
      assignOwnerHues: () => ({}),
      _lastBoardData: null,
      _cronJobs: [],
      _cronPlan: null,
      _cronRevealKey: null,
      syncCronLane: () => {},
      cronLaneSlots: () => [],
      paintCronLaneCards: () => {},
      showArchives: false,
      showSleeping: true,
      _revealedKey: null,
      _doneGroupOpen: opts.groupOpen ?? Object.create(null),
      _expanded: expanded,
      BOARD_STRINGS: {},
      cardOf: (s: { key: string }, col: string) => ({ id: s.key, title: s.key, status: col, bodyMode: 'slot' }),
      acPrefetch: () => {},
      releaseCardIoTimer: (cid: unknown) => calls.released.push(cid),
      syncCardBodies: () => {},
      ensureCardIo: (k: string) => calls.ensureIo.push(k),
      renderArchivesToggle: () => {},
      renderSleepingToggle: () => {},
      paintCronDrawer: () => {},
      updateTokenBreakdown: () => {},
      scheduleLayoutRefresh: () => {},
      MOTION: { move: 320 },
      openDeepLinkedSession: () => {
        calls.deepLink++;
      },
    },
    'function state() { return { host: _cardHost, drawn: _cardDrawn, data: _cardData }; }',
  );
  return { m, kanban, calls, expanded };
}

describe('renderBoard → the board element: NEEDS YOU · RUNNING · DONE by finish day (T11/T12)', () => {
  const now = Date.now();
  const s = (key: string, over: Record<string, unknown> = {}) => ({
    key,
    lastActivity: new Date(now).toISOString(),
    ...over,
  });
  const board = () => ({
    waiting: [s('w1'), s('cronw', { cronJob: { id: 'j1', name: 'nightly' } })],
    working: [s('r1'), s('r2')],
    idle: [s('d-today', { doneAt: now - MIN }), s('d-old', { doneAt: now - 5 * 24 * 60 * MIN })],
    closed: [s('z', { doneAt: now - 2 * MIN })],
  });

  it('columns of keys in order, the cron run taken out for its lane; each card drawn with its column', () => {
    const h = boardHarness();
    h.m.renderBoard(board(), false);
    const plan = h.kanban._ibPlan as Plan;
    expect(plan.cols.map((c) => [c.id, c.label, c.keys])).toEqual([
      ['waiting', '응답 필요', ['w1']],
      ['working', '실행 중', ['r1', 'r2']],
      ['done', '완료', []],
    ]);
    const cols = h.kanban.data?.columns ?? [];
    expect((cols[0].cards as Card[]).map((c) => [c.id, c.status])).toEqual([['w1', 'waiting']]);
    expect((cols[1].cards as Card[]).map((c) => c.id)).toEqual(['r1', 'r2']);
  });

  it('DONE is day groups, newest first: Today open; an earlier day closed, its cards counted as stubs, never drawn', () => {
    const h = boardHarness();
    h.m.renderBoard(board(), false);
    const done = (h.kanban.data?.columns ?? [])[2] as {
      groups: Array<{ id: string; label: string; open: boolean; cards: Card[] }>;
    };
    expect(done.groups.map((g) => [g.label, g.open, g.cards.map((c) => c.id)])).toEqual([
      ['오늘', true, ['d-today', 'z']],
      [expect.any(String), false, ['d-old']],
    ]);
    const st = h.m.state();
    expect(st.drawn['d-today']).toBe(true);
    expect(st.drawn['d-old']).toBeUndefined();
    // A stub carries no face — the element only counts it (and reveal can open its day).
    expect(st.data['d-old']).toEqual({ id: 'd-old', title: '', status: 'done', bodyMode: 'slot' });
    expect(st.host['d-old']).toBe(h.kanban);
  });

  it('the reader’s day choice rules (an opened earlier day draws its cards)', () => {
    const old = dayKey(now - 5 * 24 * 60 * MIN);
    const h = boardHarness({ groupOpen: { [old]: true } });
    h.m.renderBoard(board(), false);
    expect(h.m.state().drawn['d-old']).toBe(true);
  });

  it('D6: the announcement counts the data as it came — CRON runs that wait included', () => {
    const h = boardHarness();
    h.m.renderBoard(board(), false);
    expect(h.kanban.data?.announce).toEqual({ needs: 2, running: 2 });
    expect(h.kanban.data?.load).toBe('ready');
  });

  it('a partial paint (under 다시 시도, or while loading) makes no claims: load failed / loading', () => {
    const failed = boardHarness({ boardLoad: 'failed' });
    failed.m.renderBoard(board());
    expect(failed.kanban.data?.load).toBe('failed');
    const loading = boardHarness({ boardLoad: 'loading' });
    loading.m.renderBoard(board());
    expect(loading.kanban.data?.load).toBe('loading');
  });

  it('open cards are passed as expanded (a card that moved elements opens there), refetch their 지시/응답, and close for good when they leave', () => {
    const h = boardHarness({ expanded: ['r1'] });
    h.m.renderBoard(board(), false);
    expect(h.kanban.data?.expanded).toEqual(['r1']);
    expect(h.calls.ensureIo).toEqual(['r1']);
    const b = board();
    b.working = [s('r2')];
    h.m.renderBoard(b, false);
    expect(h.expanded.has('r1')).toBe(false);
    expect(h.calls.deepLink).toBe(2);
  });
});
function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── The open card's body: the host's light DOM in the card's slot (#548: only while open) ──
type FakeEl = {
  tag: string;
  className: string;
  innerHTML: string;
  parentNode: FakeEl | null;
  kids: FakeEl[];
  attrs: Record<string, string>;
  isConnected: boolean;
  setAttribute(n: string, v: string): void;
  getAttribute(n: string): string | null;
  appendChild(k: FakeEl): void;
  removeChild(k: FakeEl): void;
};
function fakeEl(tag: string): FakeEl {
  const el: FakeEl = {
    tag,
    className: '',
    innerHTML: '',
    parentNode: null,
    kids: [],
    attrs: {},
    isConnected: true,
    setAttribute(n, v) {
      this.attrs[n] = v;
    },
    getAttribute(n) {
      return this.attrs[n] ?? null;
    },
    appendChild(k) {
      if (k.parentNode) k.parentNode.removeChild(k);
      this.kids.push(k);
      k.parentNode = this;
    },
    removeChild(k) {
      this.kids = this.kids.filter((x) => x !== k);
      k.parentNode = null;
    },
  };
  return el;
}
function bodyHarness() {
  const host = fakeEl('ui-agent-inbox');
  const lane = fakeEl('ui-agent-inbox');
  const env = {
    _cardHost: Object.create(null) as Record<string, FakeEl>,
    _cardCol: Object.create(null) as Record<string, string>,
    _cardDrawn: Object.create(null) as Record<string, boolean>,
    _sessionCache: Object.create(null) as Record<string, unknown>,
    _expanded: new Set<string>(),
    _cardClosing: Object.create(null) as Record<string, unknown>,
    _cardBodies: Object.create(null) as Record<string, { el: FakeEl; html: string | null }>,
    document: { createElement: fakeEl },
    renderCardBody: (s: { key: string }, col: string) => `<div class="card-body">${s.key}|${col}</div>`,
    isEditingGoal: () => false,
    isPickingModel: () => false,
    captureGoalDraft: () => null,
    restoreGoalDraft: () => {},
    morphInnerHtml: (el: FakeEl, html: string) => {
      el.innerHTML = html;
    },
    updateTimersIn: () => {},
    acHydrate: () => {},
    mpHydrate: () => {},
    atCardData: () => null,
    atHydrate: () => {},
  };
  const m = load<{ paintCardBody(k: string): void; cardBodyShown(k: string): boolean }>(
    ['cardBodyShown', 'paintCardBody'],
    [],
    env,
  );
  const add = (key: string, col = 'waiting', on = host) => {
    env._sessionCache[key] = { key };
    env._cardHost[key] = on;
    env._cardCol[key] = col;
    env._cardDrawn[key] = true;
  };
  return { m, env, host, lane, add };
}

describe('the open card’s body is the host’s, in the card’s slot — built only while open (#548)', () => {
  it('a collapsed card builds no body; opened, a light-DOM div in slot="body:<key>" on the element that draws it', () => {
    const h = bodyHarness();
    h.add('k1');
    h.m.paintCardBody('k1');
    expect(h.host.kids).toHaveLength(0);
    h.env._expanded.add('k1');
    h.m.paintCardBody('k1');
    expect(h.host.kids).toHaveLength(1);
    const b = h.host.kids[0];
    expect(b.attrs).toEqual({ slot: 'body:k1', 'data-session-key': 'k1' });
    expect(b.className).toBe('card-slot');
    expect(b.innerHTML).toBe('<div class="card-body">k1|waiting</div>');
  });

  it('kept while it collapses, let go once closed; a card in a closed DONE day builds none even when open', () => {
    const h = bodyHarness();
    h.add('k1');
    h.env._expanded.add('k1');
    h.m.paintCardBody('k1');
    h.env._expanded.delete('k1');
    h.env._cardClosing.k1 = 1;
    h.m.paintCardBody('k1');
    expect(h.host.kids).toHaveLength(1);
    delete h.env._cardClosing.k1;
    h.m.paintCardBody('k1');
    expect(h.host.kids).toHaveLength(0);
    expect(h.env._cardBodies.k1).toBeUndefined();
    h.env._expanded.add('k1');
    delete h.env._cardDrawn.k1;
    h.m.paintCardBody('k1');
    expect(h.host.kids).toHaveLength(0);
  });

  it('follows its card to another element (board ↔ a CRON job’s) and is rewritten only when its markup changed', () => {
    const h = bodyHarness();
    h.add('k1');
    h.env._expanded.add('k1');
    h.m.paintCardBody('k1');
    const b = h.host.kids[0];
    h.env._cardHost.k1 = h.lane;
    h.m.paintCardBody('k1');
    expect(h.host.kids).toHaveLength(0);
    expect(h.lane.kids).toEqual([b]);
    b.innerHTML = 'kept';
    h.m.paintCardBody('k1');
    expect(b.innerHTML).toBe('kept');
    h.env._cardCol.k1 = 'working';
    h.m.paintCardBody('k1');
    expect(b.innerHTML).toBe('<div class="card-body">k1|working</div>');
  });
});

describe('the element’s events (wireInbox): open / close, a DONE day, a file chip', () => {
  function wired() {
    const handlers: Record<string, (e: unknown) => void> = {};
    const host = {
      _ibPlan: {
        cols: [
          {
            id: 'done',
            label: '완료',
            keys: [],
            groups: [{ id: '2026-10-20', label: '10월 20일 (화)', open: false, keys: ['d1'] }],
          },
        ],
        load: 'ready',
        announce: false,
      },
      data: null as unknown,
      addEventListener: (n: string, fn: (e: unknown) => void) => {
        handlers[n] = fn;
      },
    };
    const calls = {
      io: [] as unknown[][],
      released: [] as unknown[],
      arts: [] as unknown[],
      bodies: [] as string[],
      modal: [] as unknown[][],
      // SSOT 2026-10-29 T2: the card's detail card opens with it and leaves the deck as it folds.
      order: [] as string[],
    };
    const inboxClass = new Set<string>();
    const inbox = {
      classList: {
        toggle: (c: string, on: boolean) => (on ? inboxClass.add(c) : inboxClass.delete(c)),
      },
    };
    const env = {
      document: { getElementById: (id: string) => (id === 'inbox' ? inbox : null) },
      _expanded: new Set<string>(),
      _sessionCache: { k1: { key: 'k1', conversationId: 'c1', artifacts: { count: 1 } }, d1: { key: 'd1' } } as Record<
        string,
        unknown
      >,
      _cardHost: Object.create(null),
      _cardCol: { d1: 'idle' } as Record<string, string>,
      _cardData: Object.create(null),
      _cardDrawn: Object.create(null),
      _doneGroupOpen: Object.create(null),
      BOARD_STRINGS: {},
      isSiblingSession: () => false,
      releaseCardIoTimer: (cid: unknown) => calls.released.push(cid),
      syncCardBody: (k: string) => calls.bodies.push(k),
      syncCardBodies: () => {},
      ensureCardIo: (...a: unknown[]) => calls.io.push(a),
      ensureArtifacts: (cid: unknown) => calls.arts.push(cid),
      scheduleLayoutRefresh: () => {},
      MOTION: { move: 320, expand: 240 },
      cardOf: (s: { key: string }, col: string) => ({ id: s.key, title: s.key, status: col }),
      cardBodyShown: () => false,
      acPrefetch: () => {},
      openArtifactModal: (...a: unknown[]) => calls.modal.push(a),
      openPanel: (...a: unknown[]) => calls.order.push(`openPanel(${a.join(',')})`),
      deckDrop: (...a: unknown[]) => calls.order.push(`deckDrop(${a.join(',')})`),
    };
    const { wireInbox } = load<{ wireInbox(h: unknown): void }>(
      ['placeCard', 'inboxPaint', 'inboxChipOf', 'syncHasCards', 'wireInbox'],
      [],
      env,
    );
    wireInbox(host);
    return { host, handlers, calls, env, inboxClass };
  }

  it('ui-toggle from the element: the open state, the body, the 지시/응답 (forced) and files; closing releases the retry', () => {
    const w = wired();
    w.handlers['ui-toggle']({ target: w.host, detail: { cardId: 'k1', expanded: true } });
    expect(w.env._expanded.has('k1')).toBe(true);
    expect(w.calls.bodies).toEqual(['k1']);
    expect(w.calls.io).toEqual([['k1', true]]);
    expect(w.calls.arts).toEqual(['c1']);
    w.handlers['ui-toggle']({ target: w.host, detail: { cardId: 'k1', expanded: false } });
    expect(w.env._expanded.has('k1')).toBe(false);
    expect(w.calls.released).toEqual(['c1']);
  });

  // SSOT 2026-10-29 T2: an open card always has its detail card beside the board. The element's
  // ui-toggle is the one place a card opens or folds (click, Enter, Escape, reveal), so it is
  // where the detail card follows: opened → openPanel(key) (in front of the deck, with the key
  // alone — Chat, not the 작업 로그 landing); folded → deckDrop(key) (the next one comes forward,
  // or the panel closes). There is no bring-to-front: a click on an open card folds it.
  it('ui-toggle opens the card’s detail card (openPanel, key alone) after its body; folding it drops that from the deck (SSOT 2026-10-29 T2)', () => {
    const w = wired();
    w.handlers['ui-toggle']({ target: w.host, detail: { cardId: 'k1', expanded: true } });
    expect(w.calls.order).toEqual(['openPanel(k1)']);
    // The body and the 지시/응답 come first: the detail card opens on a card that is already drawn.
    expect(w.calls.bodies).toEqual(['k1']);
    expect(w.calls.io).toEqual([['k1', true]]);
    w.handlers['ui-toggle']({ target: w.host, detail: { cardId: 'k1', expanded: false } });
    expect(w.calls.order).toEqual(['openPanel(k1)', 'deckDrop(k1)']);
    // Each card by its own key — a card with no conversation (no 지시/응답, no files) too.
    w.handlers['ui-toggle']({ target: w.host, detail: { cardId: 'd1', expanded: true } });
    w.handlers['ui-toggle']({ target: w.host, detail: { cardId: 'd1', expanded: false } });
    expect(w.calls.order.slice(2)).toEqual(['openPanel(d1)', 'deckDrop(d1)']);
  });

  it('the agent tree’s own ui-toggle inside an open body passes through untouched', () => {
    const w = wired();
    w.handlers['ui-toggle']({ target: { tagName: 'UI-AGENT-TREE' }, detail: { id: 'a1', expanded: true } });
    expect(w.env._expanded.size).toBe(0);
    expect(w.calls.bodies).toEqual([]);
    // …and opens or drops no detail card.
    expect(w.calls.order).toEqual([]);
  });

  it('ui-group-toggle: the reader’s day choice for the page, the day’s cards get their faces before the element draws them', () => {
    const w = wired();
    w.handlers['ui-group-toggle']({ target: w.host, detail: { columnId: 'done', groupId: '2026-10-20', open: true } });
    expect(w.env._doneGroupOpen['2026-10-20']).toBe(true);
    expect(w.env._cardDrawn.d1).toBe(true);
    const data = w.host.data as { columns: Array<{ groups: Array<{ open: boolean; cards: Card[] }> }> };
    expect(data.columns[0].groups[0]).toMatchObject({ open: true, cards: [{ id: 'd1', title: 'd1', status: 'idle' }] });
    // #562 review P3: a board whose only cards were in that closed day gets the phone's bottom room now, not at the next push.
    expect(w.inboxClass.has('has-cards')).toBe(true);
    w.handlers['ui-group-toggle']({ target: w.host, detail: { columnId: 'done', groupId: '2026-10-20', open: false } });
    expect(w.env._cardDrawn.d1).toBeUndefined();
    expect(w.inboxClass.has('has-cards')).toBe(false);
    expect((w.host.data as typeof data).columns[0].groups[0].cards[0]).toEqual({
      id: 'd1',
      title: '',
      status: 'done',
      bodyMode: 'slot',
    });
  });

  // #560 review P2: the element emits ui-artifact on itself, so composedPath()[0] is the host (no
  // tabindex: focus never came back). The chip is found in its shadow root by its key.
  it('ui-artifact opens the viewer on that session’s file, focus returning to the chip in the element’s shadow root', () => {
    const w = wired();
    const chipOf = (key: string) => ({ focus: () => {}, getAttribute: (n: string) => (n === 'data-key' ? key : null) });
    const other = chipOf('art:k1:a6');
    const chip = chipOf('art:k1:a7');
    let asked = '';
    (w.host as Record<string, unknown>).shadowRoot = {
      querySelectorAll: (sel: string) => {
        asked = sel;
        return [other, chip];
      },
    };
    const fire = () =>
      w.handlers['ui-artifact']({
        target: w.host,
        detail: { cardId: 'k1', artifactId: 'a7' },
        composedPath: () => [w.host, { tagName: 'BODY' }], // what the browser gives: the host first
      });
    fire();
    expect(asked).toBe('[data-art]');
    expect(w.calls.modal).toEqual([['c1', 'a7', chip]]);
    // The chip is gone (a re-render): the element itself.
    (w.host as Record<string, unknown>).shadowRoot = { querySelectorAll: () => [other] };
    fire();
    expect(w.calls.modal[1]).toEqual(['c1', 'a7', w.host]);
  });
});

// ── D10 — one primary per open card ──
describe('D10 — one primary button per open card', () => {
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
    renderTimeline: () => '[TASKS]',
    renderMultiChoiceCard: () => '[MC]',
    renderModelNote: () => '',
    renderModelPicker: () => '[MODEL]',
    renderEffortPicker: () => '[EFFORT]',
    effortLabel: (e: string) => e,
    currentUserId: 'U1',
    SELF_INSTANCE_NAME: '',
    READ_ONLY_MSG: 'read only',
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
        'permissionSummary',
        'cardSummary',
        'cardCurrentTask',
        'renderCardResume',
        'isBusy',
        'sessionActionHtml',
        'cardGoalLine',
        // affectUI batch 1: the prompts and the single-choice question are <ui-approval-card> slots.
        'acSlotHtml',
        'acQuestionId',
        'acPermissionsHtml',
        'acQuestionHtml',
        'renderCardBody',
      ],
      [
        'RESUME_SVG',
        'GOAL_STATUS_LABELS',
        'GOAL_STATUS_TONE',
        'GOAL_SVG',
        'SESSION_ACTION_ARIA',
        'SESSION_ACTION_TONE',
        '_busy',
      ],
      { ...STUBS, ...inject },
    ).renderCardBody(s, col);
  const card = (over: Record<string, unknown> = {}) => ({
    key: 'inst::C1:t1',
    conversationId: 'conv-1',
    ownerId: 'U1',
    model: 'claude-opus-5-5[1m]',
    activityState: 'waiting',
    lastActivity: new Date(T0).toISOString(),
    ...over,
  });
  // SSOT 2026-10-29 T2: there is no 작업 로그 button any more — an open card's detail card is
  // always beside the board (ui-toggle → openPanel), so the button had nothing left to open.
  // What was its place is the actions bar (T1): Stop · Close · Trash + Slack, the body's first
  // row, right under the face — one reach from the click that opened the card.
  const ACTIONS_FIRST = '<div class="card-body"><div class="card-actions-bar"><span class="card-actions">';
  const noWorklog = (html: string) => {
    expect(html).not.toContain('작업 로그</button>');
    // …nor any other opener of the work-log landing (openPanel(key, true, …)) on the card.
    expect(html).not.toMatch(/openPanel\([^)]*,true\b/);
    expect(html.startsWith(ACTIONS_FIRST)).toBe(true);
  };
  const question = { type: 'user_choice', question: 'Ship it?', choices: [{ id: '1', label: 'Yes' }] };
  const perm = (requesterId: string) => ({ approvalId: 'ap1', toolName: 'Bash', requesterId });

  it('nothing to answer here: no 작업 로그 and no primary — the actions bar leads the body (SSOT 2026-10-29 T1/T2)', () => {
    for (const col of ['working', 'idle']) {
      const html = body(card({ activityState: col }), col);
      noWorklog(html);
      // Nothing on the card asks for a decision, so nothing is drawn as the primary.
      expect(html, col).not.toContain('btn-primary');
    }
    // The state action itself sits in that first row (a running card offers Stop).
    const running = body(card({ activityState: 'working' }), 'working');
    expect(running.indexOf('data-action="stop"')).toBeGreaterThan(0);
    expect(running.indexOf('data-action="stop"')).toBeLessThan(running.indexOf('</div>'));
  });

  it('my question or my permission prompt: the decision is the only call to action — no 작업 로그 beside it (SSOT 2026-10-29 T2)', () => {
    const asked = body(card({ pendingQuestion: question }), 'waiting');
    noWorklog(asked);
    expect(asked).toContain('data-ac-kind="question"');
    // The actions bar comes before the decision (T1: first row under the face).
    expect(asked.indexOf('card-actions-bar')).toBeLessThan(asked.indexOf('data-ac-kind="question"'));
    const prompted = body(card({ pendingPermissions: [perm('U1')] }), 'working');
    noWorklog(prompted);
  });

  it("someone else's decision (not the owner, not the requester, a sibling instance, a closed card): still no 작업 로그 (SSOT 2026-10-29 T2)", () => {
    noWorklog(body(card({ ownerId: 'U2', pendingQuestion: question }), 'waiting'));
    noWorklog(body(card({ pendingPermissions: [perm('U2')] }), 'working'));
    noWorklog(body(card({ pendingPermissions: [perm('U1')] }), 'closed'));
    const sibling = {
      SELF_INSTANCE_NAME: 'a',
      isSiblingSession: () => true,
    };
    const s = card({ pendingQuestion: question, environment: { instanceName: 'b', host: 'h', port: 1 } });
    const there = body(s, 'waiting', sibling);
    noWorklog(there);
    // A sibling's action is disabled and names the instance to open — still in the first row.
    expect(there).toContain('disabled');
    expect(there.indexOf('→ b</button>')).toBeLessThan(there.indexOf('</span></div>'));
  });

  // affectUI batch 1: the single-choice question is the same <ui-approval-card> as the panel's. Who
  // may answer is the element's canAnswer (acQuestionLock); a locked card draws its answers quiet
  // and says why (library: approval-card.test.ts "canAnswer false / string locks the answers and
  // says why"). The recommended choice's ink is the element's own (choiceOrder / recommendedOf).
  it('the question is an approval card, answerable only by the owner on this instance (astra P1)', () => {
    const rec = {
      type: 'user_choice',
      question: 'Ship it?',
      recommendedChoiceId: '1',
      choices: [
        { id: '1', label: 'Yes' },
        { id: '2', label: 'No' },
      ],
    };
    const slot = (html: string) =>
      /<ui-approval-card lang="ko" data-ac-key="([^"]+)" data-ac-kind="question">/.exec(html)?.[1];
    const lockFor = (viewer: string, sibling: boolean) =>
      load<{ acQuestionLock(s: unknown): string }>(['acQuestionLock'], ['AC_SIBLING'], {
        currentUserId: viewer,
        READ_ONLY_MSG: '읽기 전용 — 내 세션이 아닙니다',
        isSiblingSession: () => sibling,
      }).acQuestionLock;
    // Mine, here: the card answers (SSOT 2026-10-29 T2: there is no 작업 로그 beside it). No
    // second set of choice buttons (the old ones lost their click handler with batch 1).
    const mine = body(card({ pendingQuestion: rec }), 'waiting');
    expect(slot(mine)).toBe('inst::C1:t1');
    expect(mine).not.toContain('data-choice-id');
    noWorklog(mine);
    expect(lockFor('U1', false)(card({ pendingQuestion: rec }))).toBe('');
    // Mine on a sibling instance: the card is there but locked; no 작업 로그 either.
    const sib = { SELF_INSTANCE_NAME: 'a', isSiblingSession: () => true };
    const s = card({ pendingQuestion: rec, environment: { instanceName: 'b', host: 'h', port: 1 } });
    const there = body(s, 'waiting', sib);
    expect(slot(there)).toBe('inst::C1:t1');
    noWorklog(there);
    expect(lockFor('U1', true)(s)).toBe('다른 인스턴스의 세션입니다 — 그 대시보드에서 응답하세요');
    // Someone else's question: locked read-only; no 작업 로그.
    const theirs = body(card({ ownerId: 'U2', pendingQuestion: rec }), 'waiting');
    expect(slot(theirs)).toBe('inst::C1:t1');
    noWorklog(theirs);
    expect(lockFor('U1', false)(card({ ownerId: 'U2', pendingQuestion: rec }))).toBe('읽기 전용 — 내 세션이 아닙니다');
    // Only a waiting card asks.
    expect(slot(body(card({ pendingQuestion: rec, activityState: 'working' }), 'working'))).toBeUndefined();
  });

  it("the multi-question 답변하기 is the primary in the owner's card only (fable P2), never on a sibling instance (astra P1)", () => {
    let sibling = false;
    const { renderMultiChoiceCard } = load<{ renderMultiChoiceCard(s: unknown, f: string): string }>(
      ['esc', 'escJs', 'renderMultiChoiceCard', 'mcFormId'],
      [],
      { _mcState: {}, console, currentUserId: 'U1', isSiblingSession: () => sibling },
    );
    const q = { type: 'user_choices', title: 'Pick', questions: [{ id: 'q1' }] };
    // D3 E-16: the kit's button — ink (is-primary) for the owner on this instance, the plain kit button otherwise.
    expect(renderMultiChoiceCard({ key: 'k', ownerId: 'U1', pendingQuestion: q }, '')).toContain(
      '<button type="button" class="ui-btn is-primary card-mc-go"',
    );
    for (const ownerId of ['U2', undefined]) {
      expect(renderMultiChoiceCard({ key: 'k', ownerId, pendingQuestion: q }, ''), String(ownerId)).toContain(
        '<button type="button" class="ui-btn card-mc-go" onclick=',
      );
    }
    sibling = true;
    expect(renderMultiChoiceCard({ key: 'k', ownerId: 'U1', pendingQuestion: q }, '')).toContain(
      '<button type="button" class="ui-btn card-mc-go" onclick=',
    );
  });
});

// ── D10 — the card's permission prompts (astra P1) ──
// affectUI batch 1: every prompt is its own <ui-approval-card>, bound to its own request; who may answer
// is the element's canAnswer (acPermissionLock). The element draws its own Approve as its primary
// (library: approval-card.test.ts "renders title, risk, rules, the command and Approve / Deny"); the
// old rule that only the first answerable Approve of a card is ink (.is-lead) has no counterpart in
// the element's API, so with two answerable prompts on one card each card has its own primary.
describe('D10 — the open card renders one approval card per prompt; only what this viewer can answer is unlocked', () => {
  const STUBS: Record<string, unknown> = {
    dhShow: () => true,
    formatTokens: (n: number) => `${n}`,
    formatNmSSs: () => '0',
    cardTotalTokens: () => 0,
    _goalErrors: {},
    safeHref: (u: string) => u,
    getEnvBadgeColor: () => '#000',
    _envCount: () => 1,
    renderCardIo: () => '',
    renderCardArtifacts: () => '',
    renderAgentTree: () => '',
    renderTimeline: () => '',
    renderMultiChoiceCard: () => '',
    renderModelNote: () => '',
    renderModelPicker: () => '',
    renderEffortPicker: () => '',
    effortLabel: (e: string) => e,
    SELF_INSTANCE_NAME: '',
    READ_ONLY_MSG: 'read only',
  };
  function client(viewer: string, sibling = false) {
    return load<{
      renderCardBody(s: unknown, col: string): string;
      acPermissionLock(s: unknown, p: unknown): string;
    }>(
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
        'isBusy',
        'sessionActionHtml',
        'cardGoalLine',
        'isPermissionRequester',
        'acPermissionLock',
        'acSlotHtml',
        'acQuestionId',
        'acPermissionsHtml',
        'acQuestionHtml',
        'renderCardBody',
      ],
      [
        'RESUME_SVG',
        'GOAL_STATUS_LABELS',
        'GOAL_STATUS_TONE',
        'GOAL_SVG',
        'SESSION_ACTION_ARIA',
        'SESSION_ACTION_TONE',
        '_busy',
        'AC_SIBLING',
      ],
      { ...STUBS, currentUserId: viewer, isSiblingSession: () => sibling },
    );
  }
  const two = (requester: string) => ({
    key: 'inst::C1:t1',
    ownerId: 'U1',
    model: 'claude-opus-5-5[1m]',
    activityState: 'working',
    pendingPermissions: [
      { approvalId: 'ap1', toolName: 'Bash', requesterId: requester, rules: [] },
      { approvalId: 'ap2', toolName: 'Bash', requesterId: requester, rules: [] },
    ],
  });
  const slots = (html: string) =>
    [
      ...html.matchAll(
        /<div class="ui-tok ac-slot" data-mk="([^"]+)"><ui-approval-card lang="ko" data-ac-key="([^"]+)" data-ac-kind="perm" data-ac-id="([^"]+)">/g,
      ),
    ].map((m) => [m[1], m[2], m[3]]);

  it('two prompts from the same requester: two cards in order, each keyed and bound to its own request', () => {
    const c = client('U1');
    expect(slots(c.renderCardBody(two('U1'), 'working'))).toEqual([
      ['ac|p|ap1', 'inst::C1:t1', 'ap1'],
      ['ac|p|ap2', 'inst::C1:t1', 'ap2'],
    ]);
    const s = two('U1');
    expect(s.pendingPermissions.map((p) => c.acPermissionLock(s, p))).toEqual(['', '']);
  });

  it('a prompt the viewer cannot answer is locked with the reason; the other stays answerable', () => {
    const s = two('U1');
    s.pendingPermissions[0].requesterId = 'U2';
    const c = client('U1');
    expect(slots(c.renderCardBody(s, 'working')).map((x) => x[2])).toEqual(['ap1', 'ap2']);
    expect(s.pendingPermissions.map((p) => c.acPermissionLock(s, p))).toEqual([
      '이 요청의 요청자만 응답할 수 있습니다',
      '',
    ]);
  });

  it('locked for another viewer and on a sibling instance; a closed card shows no prompt', () => {
    const s = two('U1');
    const other = client('U2');
    expect(slots(other.renderCardBody(s, 'working'))).toHaveLength(2);
    expect(s.pendingPermissions.map((p) => other.acPermissionLock(s, p))).toEqual([
      '이 요청의 요청자만 응답할 수 있습니다',
      '이 요청의 요청자만 응답할 수 있습니다',
    ]);
    const sib = client('U1', true);
    expect(s.pendingPermissions.map((p) => sib.acPermissionLock(s, p))).toEqual([
      '다른 인스턴스의 세션입니다 — 그 대시보드에서 응답하세요',
      '다른 인스턴스의 세션입니다 — 그 대시보드에서 응답하세요',
    ]);
    expect(client('U1').renderCardBody(s, 'closed')).not.toContain('ui-approval-card');
  });
});
