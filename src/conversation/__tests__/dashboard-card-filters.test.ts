/**
 * SSOT 2026-11-05 — the task board's filters and sort.
 *
 * "지금 작업 카드 필터가 최상단 바에 "모든 사용자나 개별 사용자 선택"만 할수 있게 되어 있는데 개선해줘.
 *  1. 카드에 어떤 레포이고 어떤 채널인지 표기 추가
 *  2. 카드 인박스의 (보관함) (휴면) 오른쪽에 "내 카드만 보기" 추가해줘. 그리고 일반적인 필터를 추가해줘.
 *  - 각각의 유저, 채널, 레포에 대해서 토글 필터
 *  - 소팅 옵션: 처음 작업 시작 시간, 작업이 마지막으로 진행된 시간, asc or desc
 *  - 기타 어떤 필터가 필요할지에 대해서 리서치하고 개선"
 *
 *   F1  the card says its repo and channel (server fields → the face's 레포 · 채널 foot chips, on in every layout)
 *   F2  내 카드만 sits right after 보관함 · 휴면, then 필터 · 정렬 · 검색
 *   F3  사용자 · 채널 · 레포 toggles (OR within a group, AND across groups)
 *   F4  정렬: 처음 시작 · 마지막 진행, 오름 · 내림차순 (starred still first)
 *   F5  the researched extras: 즐겨찾기만 · 연결된 PR · 최근 활동 · 검색
 *
 * The client half executes the shipped page code (cut out of renderDashboardPage()'s template literal and cooked
 * exactly as the browser receives it) and the shared layout script as is.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUILTIN_PRESETS,
  CARD_CHIPS,
  LAYOUT_CATALOG,
  normalizeLayoutDoc,
  PRESET_IDS,
  VIEW_MODES,
} from '../../view-layout';
import { archivedCardClocks, cardWhereOf, githubRepoOf, liveCardClocks, slackTsMs } from '../card-where';
import { VIEW_LAYOUT_CLIENT_JS } from '../view-layout-client';

// ── Server mocks (as dashboard.test.ts) ──
const mockConfig = {
  conversation: {
    summaryModel: 'claude-haiku-4-20250414',
    viewerHost: '127.0.0.1',
    viewerPort: 0,
    viewerUrl: '',
    viewerToken: 'test-token',
  },
  oauth: {
    google: { clientId: '', clientSecret: '' },
    microsoft: { clientId: '', clientSecret: '' },
    jwtSecret: '',
    jwtExpiresIn: 604800,
  },
};
vi.mock('../../config', () => ({ config: mockConfig }));
vi.mock('../../env-paths', () => ({ IS_DEV: true, DATA_DIR: '/tmp/test-data' }));
vi.mock('../recorder', () => ({
  listConversations: vi.fn().mockResolvedValue([]),
  getConversation: vi.fn().mockResolvedValue(null),
  getTurnRawContent: vi.fn().mockResolvedValue(null),
}));
vi.mock('../viewer', () => ({
  renderConversationListPage: vi.fn().mockReturnValue('<html></html>'),
  renderConversationViewPage: vi.fn().mockReturnValue('<html></html>'),
}));
const mockListRecent = vi.fn().mockReturnValue([]);
vi.mock('../../session-archive', () => ({
  getArchiveStore: () => ({ listRecent: mockListRecent }),
}));
const AUTH_HEADER = { Authorization: 'Bearer test-token' };

// ── The page's client code ──
const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));
function cook(fragment: string): string {
  if (fragment.includes('`') || fragment.includes('${')) throw new Error('fragment is not a plain template slice');
  return new Function(`return \`${fragment}\`;`)() as string;
}
function clientFn(name: string): string {
  const start = TEMPLATE.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  return cook(TEMPLATE.slice(start + 1, TEMPLATE.indexOf('\n}\n', start) + 2));
}
function clientVar(name: string): string {
  const m = TEMPLATE.match(new RegExp(`^(var ${name} = .*?;)(?:\\s*//.*)?$`, 'm'));
  if (!m) throw new Error(`client var ${name} not found`);
  return cook(m[1]);
}
function load<T>(fns: string[], vars: string[], inject: Record<string, unknown> = {}, extra: string[] = []): T {
  const names = Object.keys(inject);
  const exported = [...fns, ...extra.map((x) => x.match(/^function (\w+)/)![1])];
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\n${extra.join('\n')}\nreturn { ${exported.join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}

type Card = Record<string, unknown>;
type Filter = {
  users: string[];
  channels: string[];
  repos: string[];
  prs: string[];
  starred: boolean;
  period: string;
  sort: string;
  dir: string;
};
type Board = { working: Card[]; waiting: Card[]; idle: Card[]; closed: Card[] };
type MenuItem = { kind?: string; value?: string; label?: string; checked?: boolean; disabled?: boolean };
type Api = {
  cardRepoOf(s: Card): { key: string; text: string; title: string } | null;
  cardChannelOf(s: Card): { key: string; text: string; title: string };
  cardPrStates(s: Card): string[];
  cardStartedAt(s: Card): number;
  cardProgressAt(s: Card): number;
  boardFilterDefault(): Filter;
  boardFilterFrom(raw: unknown): Filter;
  boardFilterCount(f: Filter): number;
  boardCardPasses(s: Card, f: Filter, query: string, now: number): boolean;
  sortBoardColumn(list: Card[], sort: string, dir: string): Card[];
  boardViewOf(board: Board, f: Filter, query: string, now: number): { board: Board; hidden: number };
  boardFacetOptions(
    board: Board,
    f: Filter,
  ): Record<'users' | 'channels' | 'repos', Array<{ key: string; label: string; count: number }>>;
  boardFilterMenuItems(board: Board, f: Filter, allUsers: boolean, viewer: string): MenuItem[];
  boardSortMenuItems(f: Filter): MenuItem[];
  boardFilterAfter(f: Filter, value: string, checked: boolean): Filter;
  boardMineOn(f: Filter, viewer: string): boolean;
  planDoneGroups(
    done: Array<{ s: Card; col: string }>,
    now: number,
    opened: Record<string, boolean> | null,
    order?: { sort: string; dir: string },
  ): Array<{ key: string; items: Array<{ s: Card }> }>;
};
const FNS = [
  'toNum',
  'cardRepoOf',
  'cardChannelOf',
  'cardPrStates',
  'cardStartedAt',
  'cardProgressAt',
  'cardSearchText',
  'boardFilterDefault',
  'boardFilterFrom',
  'boardFilterCount',
  'boardCardPasses',
  'boardCardTime',
  'sortBoardColumn',
  'boardViewOf',
  'boardFacetOptions',
  'boardFilterMenuItems',
  'boardSortMenuItems',
  'boardFilterAfter',
  'boardMineOn',
  'doneTimeOf',
  'dayKeyOf',
  'doneDayLabel',
  'planDoneGroups',
];
const VARS = ['BOARD_PERIODS', 'BOARD_PR_LABEL', 'BOARD_PERIOD_LABEL', 'BOARD_SORT_LABEL', 'DAY_MS'];
const api = () => load<Api>(FNS, VARS, { STRINGS: { today: '오늘', yesterday: '어제' } });

const H = 3_600_000;
const NOW = Date.parse('2026-11-05T12:00:00Z');
const card = (over: Card = {}): Card => ({
  key: 'k',
  title: '작업',
  displayHeadline: '작업',
  ownerId: 'U1',
  ownerName: 'Alice',
  channelId: 'C1',
  channelName: 'dev',
  repo: '2lab-ai/soma-work',
  lastActivity: new Date(NOW - H).toISOString(),
  startedAt: NOW - 5 * H,
  progressAt: NOW - H,
  ...over,
});
const board = (over: Partial<Board> = {}): Board => ({ working: [], waiting: [], idle: [], closed: [], ...over });

describe('F1 — where the work happens (server)', () => {
  it('githubRepoOf: owner/repo in lower case from a github.com URL; nothing from anything else', () => {
    expect(githubRepoOf('https://github.com/2lab-ai/soma-work/pull/970')).toBe('2lab-ai/soma-work');
    expect(githubRepoOf('https://github.com/2lab-ai/Soma-Work.git')).toBe('2lab-ai/soma-work');
    expect(githubRepoOf('https://github.com/2lab-ai/ui/issues/20#x')).toBe('2lab-ai/ui');
    expect(githubRepoOf('https://example.atlassian.net/browse/PAY-12')).toBeUndefined();
    expect(githubRepoOf('https://github.com/2lab-ai')).toBeUndefined();
    expect(githubRepoOf(undefined)).toBeUndefined();
  });

  it('the repo of its own PR, then its issue, then the newest of the history, then its channel when it maps one', () => {
    const none = () => undefined;
    const pr = { url: 'https://github.com/a/pr-repo/pull/1' };
    const issue = { url: 'https://github.com/a/issue-repo/issues/2' };
    expect(cardWhereOf({ links: { pr, issue } }, none).repo).toBe('a/pr-repo');
    expect(cardWhereOf({ links: { issue } }, none).repo).toBe('a/issue-repo');
    const history = {
      prs: [{ url: 'https://github.com/a/old/pull/1' }, { url: 'https://github.com/a/new/pull/9' }],
      issues: [],
    };
    expect(cardWhereOf({ linkHistory: history }, none).repo).toBe('a/new');
    const one = () => ({ name: 'dev', repos: ['2lab-ai/soma-work'], isPrivate: false });
    expect(cardWhereOf({ channelId: 'C1' }, one)).toEqual({ repo: '2lab-ai/soma-work', channelName: 'dev' });
    // A channel of several repos does not say which.
    const two = () => ({ name: 'mono', repos: ['a/x', 'a/y'], isPrivate: false });
    expect(cardWhereOf({ channelId: 'C1' }, two)).toEqual({ channelName: 'mono' });
    // The work's own PR wins over the channel's repo.
    expect(cardWhereOf({ channelId: 'C1', links: { pr } }, one).repo).toBe('a/pr-repo');
    // A private channel (or one the registry cannot say is public): no name, no channel repo — the board goes to
    // every signed-in viewer. The card's own PR still names its repo (that link is on the card).
    const secret = () => ({ name: 'acquisition-secret', repos: ['a/unannounced'], isPrivate: true });
    expect(cardWhereOf({ channelId: 'C5' }, secret)).toEqual({ channelPrivate: true });
    expect(cardWhereOf({ channelId: 'C5', links: { pr } }, secret)).toEqual({
      channelPrivate: true,
      repo: 'a/pr-repo',
    });
    expect(cardWhereOf({ channelId: 'C5' }, () => ({ name: 'x', repos: ['a/x'] }))).toEqual({ channelPrivate: true });
    // A Jira link, a DM, an unknown channel, a lookup that throws: nothing invented.
    expect(
      cardWhereOf({ channelId: 'D1', links: { issue: { url: 'https://x.atlassian.net/browse/P-1' } } }, none),
    ).toEqual({});
    expect(
      cardWhereOf({ channelId: 'C9' }, () => {
        throw new Error('down');
      }),
    ).toEqual({});
  });

  it('the clocks: started at its start (else its thread), moved at the latest input or change of state', () => {
    expect(slackTsMs('1793870941.429100')).toBe(1793870941429);
    expect(slackTsMs('t1')).toBeUndefined();
    const live = liveCardClocks({
      startedAt: NOW - 5 * H,
      threadTs: '1793870941.429100',
      lastActivity: new Date(NOW - 3 * H),
      activityStateChangedAt: NOW - H,
    });
    expect(live).toEqual({ startedAt: NOW - 5 * H, progressAt: NOW - H });
    expect(liveCardClocks({ threadTs: String((NOW - 4 * H) / 1000), lastActivity: new Date(NOW - 2 * H) })).toEqual({
      startedAt: NOW - 4 * H,
      progressAt: NOW - 2 * H,
    });
    expect(
      archivedCardClocks({
        startedAt: NOW - 9 * H,
        lastActivity: new Date(NOW - 8 * H).toISOString(),
        doneAt: NOW - 7 * H,
      }),
    ).toEqual({
      startedAt: NOW - 9 * H,
      progressAt: NOW - 7 * H,
    });
  });
});

describe('F1 — the board API carries repo · channel · clocks on live and archived cards', () => {
  let startWebServer: any;
  let stopWebServer: any;
  let injectWebServer: any;
  let setDashboardSessionAccessor: any;
  let upsertChannel: any;

  beforeEach(async () => {
    vi.resetModules();
    const webServer = await import('../web-server');
    startWebServer = webServer.startWebServer;
    stopWebServer = webServer.stopWebServer;
    injectWebServer = webServer.injectWebServer;
    setDashboardSessionAccessor = (await import('../dashboard')).setDashboardSessionAccessor;
    upsertChannel = (await import('../../channel-registry')).upsertChannel;
    await startWebServer({ listen: false });
  });
  afterEach(async () => {
    await stopWebServer();
    mockListRecent.mockReturnValue([]);
  });

  it('a live card: its channel name and repo from the registry, its PR repo over the channel, its two clocks', async () => {
    upsertChannel({ id: 'C1', name: 'soma-dev', purpose: 'https://github.com/2lab-ai/soma-work' });
    const sessions = new Map<string, any>();
    sessions.set('C1:1793870941.429100', {
      sessionId: 's1',
      ownerId: 'U1',
      ownerName: 'Alice',
      channelId: 'C1',
      threadTs: '1793870941.429100',
      activityState: 'idle',
      activityStateChangedAt: NOW - H,
      state: 'MAIN',
      lastActivity: new Date(NOW - 2 * H),
    });
    sessions.set('C1:1793870999.000100', {
      sessionId: 's2',
      ownerId: 'U2',
      channelId: 'C1',
      threadTs: '1793870999.000100',
      startedAt: NOW - 6 * H,
      activityState: 'working',
      state: 'MAIN',
      lastActivity: new Date(NOW - 3 * H),
      links: { pr: { url: 'https://github.com/2lab-ai/ui/pull/21', type: 'pr', provider: 'github' } },
    });
    setDashboardSessionAccessor(() => sessions);
    const res = await injectWebServer({ method: 'GET', url: '/api/dashboard/sessions', headers: AUTH_HEADER });
    const b = JSON.parse(res.body).board;
    const idle = b.idle[0];
    expect(idle).toMatchObject({
      channelName: 'soma-dev',
      repo: '2lab-ai/soma-work',
      startedAt: 1793870941429,
      progressAt: NOW - H,
    });
    expect(b.working[0]).toMatchObject({
      channelName: 'soma-dev',
      repo: '2lab-ai/ui',
      startedAt: NOW - 6 * H,
      progressAt: NOW - 3 * H,
    });
  });

  it('an archived card: the same fields from the archive', async () => {
    setDashboardSessionAccessor(() => new Map());
    mockListRecent.mockReturnValue([
      {
        sessionKey: 'C7:1793800000.000100',
        archivedAt: NOW - H,
        archiveReason: 'sleep_expired',
        sessionId: 'sx',
        ownerId: 'U1',
        channelId: 'C7',
        threadTs: '1793800000.000100',
        lastActivity: new Date(NOW - 4 * H).toISOString(),
        doneAt: NOW - 2 * H,
        links: { issue: { url: 'https://github.com/2lab-ai/soma/issues/3', type: 'issue', provider: 'github' } },
      },
    ]);
    const res = await injectWebServer({ method: 'GET', url: '/api/dashboard/sessions', headers: AUTH_HEADER });
    const closed = JSON.parse(res.body).board.closed[0];
    expect(closed).toMatchObject({ repo: '2lab-ai/soma', startedAt: 1793800000000, progressAt: NOW - 2 * H });
    expect(closed.channelName).toBeUndefined();
  });
});

describe('F1 — the face: 레포 · 채널 foot chips, on in every built-in layout', () => {
  it('the catalog has both, never in Slack, and every preset · mode shows them first in its foot', () => {
    expect(CARD_CHIPS.slice(0, 2)).toEqual(['repo', 'channel']);
    const foot = LAYOUT_CATALOG.card.foot as ReadonlyArray<{ id: string; label: string; slack?: false }>;
    expect(foot.find((c) => c.id === 'repo')).toMatchObject({ label: '레포', slack: false });
    expect(foot.find((c) => c.id === 'channel')).toMatchObject({ label: '채널', slack: false });
    for (const p of PRESET_IDS)
      for (const m of VIEW_MODES) {
        const chips = BUILTIN_PRESETS[p][m].card.foot;
        expect(chips.slice(0, 2), `${p} ${m}`).toEqual([
          { id: 'repo', on: true },
          { id: 'channel', on: true },
        ]);
      }
  });

  it('a layout saved before the chips existed gets them, on, at the preset’s place', () => {
    const saved = {
      kind: true,
      star: true,
      owner: true,
      rows: [{ id: 'summary', on: true, opt: 'asks' }],
      foot: ['steps', 'ctx', 'media', 'pr', 'arts', 'cost', 'tokens', 'model'].map((id) => ({ id, on: id === 'cost' })),
    };
    const doc = normalizeLayoutDoc({ v: 1, presets: { '1': { minimal: { card: saved } } } });
    const foot = doc.presets!['1']!.minimal!.card!.foot;
    expect(foot.filter((c) => c.on).map((c) => c.id)).toEqual(['repo', 'channel', 'cost']);
  });

  it('cardOf hands the face its where; faceOf draws the chips in the layout’s order, with the full name as the title', () => {
    const m = api();
    expect(m.cardRepoOf(card())).toEqual({
      key: '2lab-ai/soma-work',
      text: 'soma-work',
      title: '레포: 2lab-ai/soma-work',
    });
    expect(m.cardRepoOf(card({ repo: undefined }))).toBeNull();
    expect(m.cardChannelOf(card())).toEqual({ key: 'c:C1', text: '#dev', title: '채널: #dev' });
    expect(m.cardChannelOf(card({ channelId: 'D9', channelName: undefined }))).toMatchObject({ key: 'dm', text: 'DM' });
    expect(m.cardChannelOf(card({ channelId: '', channelName: undefined }))).toMatchObject({
      key: 'web',
      text: '대시보드',
    });
    expect(m.cardChannelOf(card({ channelId: 'C77', channelName: undefined }))).toMatchObject({
      key: 'c:C77',
      text: '#C77',
    });
    expect(m.cardChannelOf(card({ channelId: 'C5', channelName: undefined, channelPrivate: true }))).toEqual({
      key: 'private',
      text: '비공개 채널',
      title: '채널: 비공개 채널',
    });
    // cardOf: the where it builds (the source, not executed — it reads the whole page).
    const cardOfSrc = clientFn('cardOf');
    expect(cardOfSrc).toContain('card.where = { channel: { text: channelOf.text, title: channelOf.title } }');
    expect(cardOfSrc).toContain('card.where.repo = { text: repoOf.text, title: repoOf.title }');

    const faceOf = new Function(`${VIEW_LAYOUT_CLIENT_JS}\nreturn faceOf;`)() as (
      c: Card,
      model: string,
      face: unknown,
      asks: boolean,
    ) => Card & { metrics?: Array<{ text: string; title?: string }> };
    const full = {
      id: 'k',
      title: 't',
      status: 'done',
      costUsd: 1.5,
      where: {
        repo: { text: 'soma-work', title: '레포: 2lab-ai/soma-work' },
        channel: { text: '#dev', title: '채널: #dev' },
      },
    };
    const face = BUILTIN_PRESETS['1'].minimal.card;
    const out = faceOf(full, 'unknown', face, false);
    expect(out.metrics?.slice(0, 2)).toEqual([
      { text: 'soma-work', title: '레포: 2lab-ai/soma-work', label: '레포: 2lab-ai/soma-work' },
      { text: '#dev', title: '채널: #dev', label: '채널: #dev' },
    ]);
    expect(out).not.toHaveProperty('where');
    const off = { ...face, foot: face.foot.map((c) => (c.id === 'channel' ? { ...c, on: false } : c)) };
    expect(faceOf(full, 'unknown', off, false).metrics?.map((x) => x.text)).toEqual(['soma-work', '$1.50']);
  });
});

describe('F2 — the toolbar: 보관함 · 휴면, then 내 카드만 · 필터 · 정렬 · 검색', () => {
  it('the head wraps at every width: the tools take the row under the trail and wrap there (no overflow at 640–760px)', () => {
    const css = DASHBOARD_TS;
    expect(css).toContain('.inbox-head { display: flex; flex-wrap: wrap;');
    expect(css).toContain(
      '.inbox-tools { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end;',
    );
    expect(css).toContain('flex: 0 1 auto; min-width: 0; margin-left: auto; }');
  });

  it('the controls follow 휴면 in this order, inside the board’s tools', () => {
    const head = TEMPLATE.slice(TEMPLATE.indexOf('id="inbox-tools"'), TEMPLATE.indexOf('id="view-seg"'));
    const order = [
      'id="archives-toggle"',
      'id="sleeping-toggle"',
      'id="mine-toggle"',
      'id="bf-menu"',
      'id="bs-menu"',
      'id="bf-search"',
    ];
    const at = order.map((id) => head.indexOf(id));
    for (const [i, x] of at.entries()) expect(x, order[i]).toBeGreaterThan(-1);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(head).toContain('<span>내 카드만</span>');
    expect(head).toContain('onclick="toggleMineOnly()"');
    expect(head).toMatch(/<ui-menu id="bf-menu"[^>]*><button[^>]*slot="trigger"/);
  });

  it('내 카드만 is the 사용자 filter holding the viewer alone — a press sets it, a second clears it', () => {
    const m = api();
    const f = m.boardFilterDefault();
    expect(m.boardMineOn(f, 'U1')).toBe(false);
    expect(m.boardMineOn({ ...f, users: ['U1'] }, 'U1')).toBe(true);
    expect(m.boardMineOn({ ...f, users: ['U1', 'U2'] }, 'U1')).toBe(false);
    expect(m.boardMineOn({ ...f, users: ['U1'] }, '')).toBe(false);
  });

  // The bar as paintBoardTools leaves it — run with a minimal document.
  const bar = (o: { currentUserId: string; viewer: string; bf: Partial<Filter>; hidden?: number }) => {
    const els: Record<string, any> = {};
    const el = (id: string) =>
      (els[id] ??= {
        id,
        hidden: id === 'mine-toggle' || id === 'bf-count',
        title: '',
        textContent: '',
        attrs: {} as Record<string, string>,
        getAttribute(k: string) {
          return this.attrs[k] ?? null;
        },
        setAttribute(k: string, v: string) {
          this.attrs[k] = String(v);
        },
      });
    const changed: string[] = [];
    const m0 = api();
    const bf = { ...m0.boardFilterDefault(), ...o.bf };
    const m = load<{
      paintBoardTools(b: unknown): void;
      toggleMineOnly(): void;
      state(): Filter;
    }>(
      [...FNS, 'paintBoardTools', 'toggleMineOnly'],
      [...VARS],
      {
        STRINGS: { today: '오늘', yesterday: '어제' },
        document: { getElementById: el },
        setTextIfChanged: (e: { textContent: string }, t: string) => {
          e.textContent = t;
        },
        currentUserId: o.currentUserId,
        _viewerUserId: o.viewer,
        _bf: bf,
        _bfHidden: o.hidden ?? 0,
        boardFilterChanged: () => changed.push('changed'),
      },
      ['function state() { return _bf; }'],
    );
    return { m, els, changed };
  };

  it('the bar: 내 카드만 only on the All Users board for a signed-in viewer, pressed while it is the filter; the count', () => {
    const all = bar({ currentUserId: '', viewer: 'U1', bf: { users: ['U1'], starred: true }, hidden: 4 });
    all.m.paintBoardTools({ working: [card({ ownerId: 'U1' })], waiting: [], idle: [], closed: [] });
    expect(all.els['mine-toggle'].hidden).toBe(false);
    expect(all.els['mine-toggle'].attrs['aria-pressed']).toBe('true');
    expect(all.els['bf-count'].textContent).toBe('2');
    expect(all.els['bf-count'].hidden).toBe(false);
    expect(all.els['bf-trigger'].attrs['aria-pressed']).toBe('true');
    expect(all.els['bf-trigger'].title).toBe('카드 필터 · 적용 중: 2 · 숨긴 카드: 4');
    expect(all.els['bs-label'].textContent).toBe('마지막 진행 ↓');
    expect(all.els['bf-menu'].data.items.some((i: MenuItem) => i.value === 'u:U1' && i.checked)).toBe(true);
    // One user's board: no 내 카드만, and its users choice is neither counted nor offered.
    const one = bar({ currentUserId: 'U2', viewer: 'U1', bf: { users: ['U1'] } });
    one.m.paintBoardTools({ working: [], waiting: [], idle: [], closed: [] });
    expect(one.els['mine-toggle'].hidden).toBe(true);
    expect(one.els['bf-count'].hidden).toBe(true);
    expect(one.els['bf-menu'].data.items.some((i: MenuItem) => i.label === '사용자')).toBe(false);
    // Signed out (a viewer token): no 내 카드만.
    const anon = bar({ currentUserId: '', viewer: '', bf: {} });
    anon.m.paintBoardTools(null);
    expect(anon.els['mine-toggle'].hidden).toBe(true);
  });

  it('a press on 내 카드만 sets the viewer as the only user, a second press clears it', () => {
    const b = bar({ currentUserId: '', viewer: 'U1', bf: { users: ['U2', 'U3'], starred: true } });
    b.m.toggleMineOnly();
    expect(b.m.state()).toMatchObject({ users: ['U1'], starred: true });
    b.m.toggleMineOnly();
    expect(b.m.state().users).toEqual([]);
    expect(b.changed).toEqual(['changed', 'changed']);
  });
});

describe('F3 — 사용자 · 채널 · 레포 toggles', () => {
  const b = board({
    working: [
      card({ key: 'a', ownerId: 'U1', channelId: 'C1', channelName: 'dev', repo: '2lab-ai/soma-work' }),
      card({ key: 'b', ownerId: 'U2', ownerName: 'Bob', channelId: 'C2', channelName: 'ops', repo: '2lab-ai/ui' }),
    ],
    idle: [
      card({ key: 'c', ownerId: 'U2', ownerName: 'Bob', channelId: 'D5', channelName: undefined, repo: undefined }),
    ],
  });
  const keys = (v: { board: Board }) =>
    (['working', 'waiting', 'idle', 'closed'] as const).flatMap((c) => v.board[c].map((s) => s.key));

  it('an empty group passes everything; within a group OR, across groups AND', () => {
    const m = api();
    const f = m.boardFilterDefault();
    expect(keys(m.boardViewOf(b, f, '', NOW))).toEqual(['a', 'b', 'c']);
    expect(keys(m.boardViewOf(b, { ...f, users: ['U2'] }, '', NOW))).toEqual(['b', 'c']);
    expect(keys(m.boardViewOf(b, { ...f, users: ['U1', 'U2'] }, '', NOW))).toEqual(['a', 'b', 'c']);
    expect(keys(m.boardViewOf(b, { ...f, channels: ['c:C1', 'dm'] }, '', NOW))).toEqual(['a', 'c']);
    expect(keys(m.boardViewOf(b, { ...f, repos: ['2lab-ai/ui'] }, '', NOW))).toEqual(['b']);
    const v = m.boardViewOf(b, { ...f, users: ['U2'], channels: ['c:C2'] }, '', NOW);
    expect(keys(v)).toEqual(['b']);
    expect(v.hidden).toBe(2);
  });

  it('an epic’s children are judged one by one: the epic stays for a child that passes, carrying only those', () => {
    const m = api();
    const kidA = card({ key: 'ka', channelId: 'C1', channelName: 'dev' });
    const kidB = card({ key: 'kb', channelId: 'C2', channelName: 'ops' });
    const epic = card({
      key: 'e',
      kind: 'epic',
      channelId: 'C2',
      channelName: 'ops',
      epic: { state: 'running', children: [kidA, kidB] },
    });
    const b2 = board({ working: [epic] });
    const f = { ...m.boardFilterDefault(), channels: ['c:C1'] };
    const v = m.boardViewOf(b2, f, '', NOW) as { board: Board; hidden: number; hiddenCards: Record<string, Card[]> };
    expect(v.board.working.map((s) => s.key)).toEqual(['e']);
    expect((v.board.working[0].epic as { children: Card[] }).children.map((c) => c.key)).toEqual(['ka']);
    expect(v.hidden).toBe(1);
    expect(v.hiddenCards.working.map((c) => c.key)).toEqual(['kb']);
    // The data is not changed (the next render reads it whole).
    expect((epic.epic as { children: Card[] }).children).toHaveLength(2);
    // No child passes and the epic does not: all three are hidden.
    const none = m.boardViewOf(b2, { ...f, channels: ['dm'] }, '', NOW);
    expect(none.board.working).toEqual([]);
    expect(none.hidden).toBe(3);
    // No filter, children already in the board's order: the same objects, untouched.
    expect(m.boardViewOf(b2, m.boardFilterDefault(), '', NOW).board.working[0]).toBe(epic);
    // The children follow the board's order (a copy; the data keeps its plan order).
    const older = card({ key: 'old', startedAt: NOW - 9 * H, progressAt: NOW - 8 * H });
    const newer = card({ key: 'new', startedAt: NOW - 2 * H, progressAt: NOW - H });
    const e2 = card({ key: 'e2', kind: 'epic', epic: { children: [older, newer] } });
    const kidsOf = (dir: string) =>
      (
        m.boardViewOf(board({ working: [e2] }), { ...m.boardFilterDefault(), dir }, '', NOW).board.working[0].epic as {
          children: Card[];
        }
      ).children.map((c) => c.key);
    expect(kidsOf('desc')).toEqual(['new', 'old']);
    expect(kidsOf('asc')).toEqual(['old', 'new']);
    expect((e2.epic as { children: Card[] }).children.map((c) => c.key)).toEqual(['old', 'new']);
  });

  it('the menu offers an epic’s children’s owners · channels · repos too (the filter judges them)', () => {
    const m = api();
    const kid = card({ key: 'k', channelId: 'C9', channelName: 'child-only', repo: 'a/child-repo' });
    const epic = card({ key: 'e', kind: 'epic', epic: { children: [kid] } });
    const o = m.boardFacetOptions(board({ working: [epic] }), m.boardFilterDefault());
    // Equal counts: by label (#child-only before #dev).
    expect(o.channels.map((c) => [c.key, c.count])).toEqual([
      ['c:C9', 1],
      ['c:C1', 1],
    ]);
    expect(o.repos.map((r) => r.key)).toContain('a/child-repo');
    expect(o.users).toEqual([{ key: 'U1', label: 'Alice', count: 2 }]);
  });

  it('a new search ends a deep link’s reveal', () => {
    expect(clientFn('onBoardSearch')).toContain('_revealedKey = null;');
  });

  it('the menu offers every owner · channel · repo on the board with its count (the viewer marked), busiest first', () => {
    const m = api();
    const f = { ...m.boardFilterDefault(), repos: ['gone/repo'] };
    const o = m.boardFacetOptions(b, f);
    expect(o.users).toEqual([
      { key: 'U2', label: 'Bob', count: 2 },
      { key: 'U1', label: 'Alice', count: 1 },
    ]);
    expect(o.channels.map((c) => [c.key, c.label, c.count])).toEqual([
      ['c:C1', '#dev', 1],
      ['c:C2', '#ops', 1],
      ['dm', 'DM', 1],
    ]);
    // A chosen repo the board no longer holds stays, at 0, so it can be unchosen.
    expect(o.repos.map((r) => [r.key, r.count])).toEqual([
      ['2lab-ai/soma-work', 1],
      ['2lab-ai/ui', 1],
      ['gone/repo', 0],
    ]);
    const items = m.boardFilterMenuItems(b, f, true, 'U1');
    const heads = items.filter((i) => i.kind === 'heading').map((i) => i.label);
    expect(heads).toEqual(['보기', '사용자', '채널', '레포', '연결된 PR', '최근 활동']);
    expect(items.find((i) => i.value === 'u:U1')).toMatchObject({
      kind: 'checkbox',
      label: 'Alice (나) · 1',
      checked: false,
    });
    expect(items.find((i) => i.value === 'r:gone/repo')).toMatchObject({ checked: true });
    expect(items[0]).toMatchObject({ value: 'reset', disabled: false });
    // One user's board has no 사용자 group.
    expect(m.boardFilterMenuItems(b, f, false, 'U1').some((i) => i.label === '사용자')).toBe(false);
  });

  it('a menu choice toggles its value; 모두 해제 clears the filters and keeps the order', () => {
    const m = api();
    let f = m.boardFilterDefault();
    f = m.boardFilterAfter(f, 'u:U2', true);
    f = m.boardFilterAfter(f, 'c:dm', true);
    f = m.boardFilterAfter(f, 'r:2lab-ai/ui', true);
    f = m.boardFilterAfter(f, 'd:asc', true);
    expect(f).toMatchObject({ users: ['U2'], channels: ['dm'], repos: ['2lab-ai/ui'], dir: 'asc' });
    expect(m.boardFilterCount(f)).toBe(3);
    f = m.boardFilterAfter(f, 'u:U2', false);
    expect(f.users).toEqual([]);
    f = m.boardFilterAfter(f, 'reset', false);
    expect(f).toEqual({ ...m.boardFilterDefault(), dir: 'asc' });
  });

  it('a stored filter is read back; junk falls back to the default', () => {
    const m = api();
    const ok = {
      users: ['U1'],
      channels: ['dm'],
      repos: ['a/b'],
      prs: ['merged', 'bogus'],
      starred: true,
      period: '7d',
      sort: 'start',
      dir: 'asc',
    };
    expect(m.boardFilterFrom(ok)).toEqual({ ...ok, prs: ['merged'] });
    expect(m.boardFilterFrom({ users: 'U1', period: '1y', sort: 'x', dir: 'up' })).toEqual(m.boardFilterDefault());
    expect(m.boardFilterFrom(null)).toEqual(m.boardFilterDefault());
  });
});

describe('F4 — 정렬: 처음 시작 · 마지막 진행, 오름 · 내림차순', () => {
  const s1 = card({ key: 's1', startedAt: NOW - 9 * H, progressAt: NOW - 1 * H });
  const s2 = card({ key: 's2', startedAt: NOW - 3 * H, progressAt: NOW - 5 * H });
  const s3 = card({ key: 's3', startedAt: NOW - 6 * H, progressAt: NOW - 3 * H, starred: true });

  it('each column by the chosen clock and direction; a starred card still leads', () => {
    const m = api();
    const ks = (l: Card[]) => l.map((s) => s.key);
    expect(ks(m.sortBoardColumn([s1, s2, s3], 'progress', 'desc'))).toEqual(['s3', 's1', 's2']);
    expect(ks(m.sortBoardColumn([s1, s2, s3], 'progress', 'asc'))).toEqual(['s3', 's2', 's1']);
    expect(ks(m.sortBoardColumn([s1, s2, s3], 'start', 'desc'))).toEqual(['s3', 's2', 's1']);
    expect(ks(m.sortBoardColumn([s1, s2, s3], 'start', 'asc'))).toEqual(['s3', 's1', 's2']);
  });

  it('the clocks fall back: the thread’s first message, the latest time the card knows', () => {
    const m = api();
    expect(m.cardStartedAt({ threadTs: '1793870941.429100' })).toBe(1793870941429);
    expect(m.cardStartedAt({ lastActivity: new Date(NOW).toISOString() })).toBe(NOW);
    expect(m.cardProgressAt({ lastActivity: new Date(NOW - 5 * H).toISOString(), doneAt: NOW - 2 * H })).toBe(
      NOW - 2 * H,
    );
  });

  it('DONE: the days and the cards in a day follow the direction; 처음 시작 orders a day by start', () => {
    const m = api();
    const day = Date.parse('2026-11-05T10:00:00');
    const a = { s: card({ key: 'a', doneAt: day, progressAt: day, startedAt: day - 9 * H }), col: 'idle' };
    const b = { s: card({ key: 'b', doneAt: day + H, progressAt: day + H, startedAt: day - H }), col: 'idle' };
    const c = {
      s: card({ key: 'c', doneAt: day - 30 * H, progressAt: day - 30 * H, startedAt: day - 40 * H }),
      col: 'closed',
    };
    const flat = (gs: Array<{ key: string; items: Array<{ s: Card }> }>) =>
      gs.map((g) => g.items.map((i) => i.s.key).join(''));
    const now = day + 2 * H;
    expect(flat(m.planDoneGroups([a, b, c], now, null))).toEqual(['ba', 'c']);
    expect(flat(m.planDoneGroups([a, b, c], now, null, { sort: 'progress', dir: 'desc' }))).toEqual(['ba', 'c']);
    expect(flat(m.planDoneGroups([a, b, c], now, null, { sort: 'progress', dir: 'asc' }))).toEqual(['c', 'ab']);
    expect(flat(m.planDoneGroups([a, b, c], now, null, { sort: 'start', dir: 'desc' }))).toEqual(['ba', 'c']);
    expect(flat(m.planDoneGroups([a, b, c], now, null, { sort: 'start', dir: 'asc' }))).toEqual(['c', 'ab']);
    // A card revived after it finished (its last input moved, its finish did not): 마지막 진행 reads the revival —
    // the same clock RUNNING and NEEDS YOU use; its day is still its finish.
    const revived = { s: card({ key: 'r', doneAt: day - 2 * H, progressAt: day + 1.5 * H }), col: 'idle' };
    expect(flat(m.planDoneGroups([a, b, revived], now, null, { sort: 'progress', dir: 'desc' }))).toEqual(['rba']);
    // No board order (an older caller): newest finish first, as before.
    expect(flat(m.planDoneGroups([a, b, revived], now, null))).toEqual(['bar']);
  });

  it('the 정렬 menu: two radio groups, the current choice checked', () => {
    const m = api();
    const items = m.boardSortMenuItems({ ...m.boardFilterDefault(), sort: 'start', dir: 'asc' });
    expect(items.filter((i) => i.checked).map((i) => i.value)).toEqual(['k:start', 'd:asc']);
    expect(items.map((i) => i.label)).toEqual([
      '정렬 기준',
      '작업이 마지막으로 진행된 시간',
      '작업을 처음 시작한 시간',
      '순서',
      '최근 먼저 (내림차순)',
      '오래된 먼저 (오름차순)',
    ]);
  });
});

describe('F5 — the researched extras: 즐겨찾기만 · 연결된 PR · 최근 활동 · 검색', () => {
  const merged = { kind: 'pr', url: 'https://github.com/a/b/pull/1', text: '#1', tone: 'done' };
  const open = { kind: 'pr', url: 'https://github.com/a/b/pull/2', text: '#2', tone: 'run' };
  const cards = {
    starred: card({ key: 'st', starred: true, progressAt: NOW - 50 * H }),
    merged: card({ key: 'mg', cardLinks: [merged], progressAt: NOW - 2 * H }),
    both: card({ key: 'bo', cardLinks: [merged, open], progressAt: NOW - 200 * H, title: '결제 페이지' }),
    none: card({ key: 'no', progressAt: NOW - 10 * H, ownerName: 'Zhuge' }),
  };

  it('PR states from the links’ tone (any language), else the active PR, else none', () => {
    const m = api();
    expect(m.cardPrStates(cards.both)).toEqual(['merged', 'open']);
    expect(m.cardPrStates(cards.none)).toEqual(['none']);
    expect(m.cardPrStates(card({ prUrl: 'https://github.com/a/b/pull/3', prStatus: 'MERGED' }))).toEqual(['merged']);
    expect(m.cardPrStates(card({ cardLinks: [{ kind: 'pr', tone: 'fail' }] }))).toEqual(['closed']);
  });

  it('each extra narrows the board', () => {
    const m = api();
    const f = m.boardFilterDefault();
    const pass = (g: Partial<Filter>, q = '') =>
      Object.values(cards)
        .filter((s) => m.boardCardPasses(s, { ...f, ...g }, q, NOW))
        .map((s) => s.key);
    expect(pass({ starred: true })).toEqual(['st']);
    expect(pass({ prs: ['merged'] })).toEqual(['mg', 'bo']);
    expect(pass({ prs: ['open'] })).toEqual(['bo']);
    expect(pass({ prs: ['none'] })).toEqual(['st', 'no']);
    expect(pass({ period: '1d' })).toEqual(['mg', 'no']);
    expect(pass({ period: '7d' })).toEqual(['st', 'mg', 'no']);
    // Search: every word, any of the card's words (title, owner, repo, channel, links), any case.
    expect(pass({}, '결제')).toEqual(['bo']);
    expect(pass({}, 'zhuge')).toEqual(['no']);
    expect(pass({}, 'SOMA-WORK #dev')).toEqual(['st', 'mg', 'bo', 'no']);
    expect(pass({}, 'soma nothing-like-this')).toEqual([]);
    // What the face shows: the question it asks, its plan's conclusion, the TL;DR.
    const asks = card({ pendingQuestion: { type: 'user_choice', question: 'dev에 먼저 배포할까요?' } });
    const plan = card({ taskPlan: { state: 'awaiting', revision: 2, summary: '스키마 마이그레이션 계획' } });
    const tldr = card({ esTldr: { lines: ['PR #971 merged'], at: 1 } });
    expect(m.boardCardPasses(asks, f, '배포할까요', NOW)).toBe(true);
    expect(m.boardCardPasses(plan, f, '마이그레이션', NOW)).toBe(true);
    expect(m.boardCardPasses(tldr, f, '#971', NOW)).toBe(true);
  });

  it('the bar’s count: the filters in force (the search is not one)', () => {
    const m = api();
    const f = { ...m.boardFilterDefault(), users: ['U1'], starred: true, prs: ['open', 'none'], period: '7d' };
    expect(m.boardFilterCount(f)).toBe(5);
  });
});

describe('Deep links — a card the filters hide still opens from its link', () => {
  it('boardViewOf lets the revealed key through; openDeepLinkedSession reveals a card the filter hides', () => {
    const m = api();
    const b = board({ working: [card({ key: 'a', ownerId: 'U1' }), card({ key: 'b', ownerId: 'U2' })] });
    const f = { ...m.boardFilterDefault(), users: ['U1'] };
    const keys = (v: { board: Board }) => v.board.working.map((s) => s.key);
    expect(keys(m.boardViewOf(b, f, '', NOW))).toEqual(['a']);
    expect(keys((m as any).boardViewOf(b, f, '', NOW, 'b'))).toEqual(['a', 'b']);
    const open = clientFn('openDeepLinkedSession');
    expect(open).toContain(
      'var hiddenByFilter = !!linked && !boardCardPasses(linked, boardFilterNow(), _bfQuery, Date.now());',
    );
    expect(open).toContain('if ((hiddenByToggle || hiddenByFilter) && _revealedKey !== key) {');
    expect(clientFn('boardFilterView')).toContain(
      'boardViewOf(board, boardFilterNow(), _bfQuery, Date.now(), _revealedKey)',
    );
    // The reader's own filter change ends the reveal (as 보관함 · 휴면 do).
    expect(clientFn('boardFilterChanged')).toContain('_revealedKey = null;');
  });
});

describe('카드 열기 — a launched card the filters hide is revealed, then opened', () => {
  it('ntOpenArrived reveals the launch’s card for this page load and reloads the board', () => {
    const KEY = 'inst::C2:1793870941.429100';
    let loads = 0;
    const m0 = api();
    const mk = (passes: boolean) =>
      load<{ ntOpenArrived(l: unknown): boolean; state(): string | null }>(
        ['resolveDeepLinkKey', 'ntOpenArrived'],
        [],
        {
          _sessionCache: { [KEY]: card({ key: KEY, channelId: 'C2', channelName: 'ops' }) },
          SELF_INSTANCE_NAME: 'inst',
          _cardHost: Object.create(null),
          showArchives: false,
          showSleeping: true,
          _revealedKey: null,
          boardCardPasses: () => passes,
          boardFilterNow: () => ({ ...m0.boardFilterDefault(), channels: ['c:C1'] }),
          _bfQuery: '',
          loadSessions: () => {
            loads++;
          },
        },
        ['function state() { return _revealedKey; }'],
      );
    const hidden = mk(false);
    expect(hidden.ntOpenArrived({ sessionKey: 'C2:1793870941.429100', wantOpen: true })).toBe(false);
    expect(hidden.state()).toBe(KEY);
    expect(loads).toBe(1);
    // A card no filter hides and no toggle hides is simply not on this render yet: nothing to reveal.
    const shown = mk(true);
    expect(shown.ntOpenArrived({ sessionKey: 'C2:1793870941.429100', wantOpen: true })).toBe(false);
    expect(shown.state()).toBeNull();
    expect(loads).toBe(1);
  });
});

describe('Wiring — the board draws the filtered view; the tools follow every render', () => {
  it('renderBoard plans the columns from boardFilterView and repaints the tools; the menus are wired at load', () => {
    const render = clientFn('renderBoard');
    expect(render).toContain('planCronLane(boardFilterView(board),');
    expect(render).toContain('planDoneGroups(plan.done, Date.now(), _doneGroupOpen, { sort: _bf.sort, dir: _bf.dir })');
    expect(render).toContain('paintBoardTools(board);');
    expect(TEMPLATE).toContain('wireBoardTools();\n  paintBoardTools(null);');
  });

  it('one user’s board does not apply the 사용자 filter; the hidden cards count per column, closed ones only when shown', () => {
    const m0 = api();
    const f = { ...m0.boardFilterDefault(), users: ['U1'], starred: true };
    const now = (currentUserId: string) =>
      load<{ boardFilterNow(): Filter }>(
        ['boardFilterDefault', 'boardFilterFrom', 'boardFilterNow'],
        ['BOARD_PERIODS'],
        {
          currentUserId,
          _bf: f,
        },
      ).boardFilterNow();
    expect(now('')).toBe(f);
    expect(now('U2')).toEqual({ ...f, users: [] });
    const counts = load<{ boardHiddenCounts(c: unknown, a: boolean, s: boolean): Record<string, number> }>(
      ['boardHiddenCounts'],
      [],
    ).boardHiddenCounts;
    const hidden = {
      waiting: [card()],
      working: [],
      idle: [card(), card()],
      closed: [card({ terminated: true }), card({ sessionState: 'SLEEPING' })],
    };
    expect(counts(hidden, false, true)).toEqual({ waiting: 1, working: 0, done: 3 });
    expect(counts(hidden, true, false)).toEqual({ waiting: 1, working: 0, done: 3 });
    expect(counts(hidden, true, true)).toEqual({ waiting: 1, working: 0, done: 4 });
    // An epic's sleeping child hidden by the filter in RUNNING: 휴면 hides it anyway when off.
    const kids = { working: [card({ sessionState: 'SLEEPING' })] };
    expect(counts(kids, false, false).working).toBe(0);
    expect(counts(kids, false, true).working).toBe(1);
    // renderBoard: the hint only in a column the filters hid cards from.
    expect(clientFn('renderBoard')).toContain("emptyText: filteredEmpty('waiting')");
  });

  it('a filter another account stored in this browser loses its users when the viewer is known', () => {
    const storage = new Map<string, string>();
    const mk = (bf: Partial<Filter>, stored: string) =>
      load<{ boardFilterViewerKnown(v: string): boolean; state(): Filter }>(
        ['boardFilterDefault', 'boardFilterFrom', 'saveBoardFilter', 'boardFilterViewerKnown'],
        ['BOARD_FILTER_KEY', 'BOARD_PERIODS'],
        {
          localStorage: {
            setItem: (k: string, v: string) => storage.set(k, v),
            getItem: (k: string) => storage.get(k) ?? null,
          },
          _bf: { ...api().boardFilterDefault(), ...bf },
          _bfViewer: stored,
          _viewerUserId: '',
        },
        ['function state() { return _bf; }'],
      );
    const same = mk({ users: ['U1'] }, 'U1');
    expect(same.boardFilterViewerKnown('U1')).toBe(false);
    expect(same.state().users).toEqual(['U1']);
    const other = mk({ users: ['U1'], starred: true }, 'U1');
    expect(other.boardFilterViewerKnown('U9')).toBe(true);
    expect(other.state()).toMatchObject({ users: [], starred: true });
    expect(JSON.parse(storage.get('soma-board-filter')!)).toMatchObject({ users: [], starred: true, viewer: 'U9' });
    // Nothing stored by anyone yet: the first viewer keeps the filter.
    expect(mk({ users: ['U1'] }, '').boardFilterViewerKnown('U1')).toBe(false);
  });
});
