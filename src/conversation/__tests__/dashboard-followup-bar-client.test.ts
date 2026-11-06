/**
 * #983 (SSOT 2026-11-06) — the follow-up bar on the dashboard's task card, client half.
 *
 * "이렇게 열려 있는 이슈가 있는 작업 카드에 처리 못한 신규 이슈나 PR을 아주 눈에 띄게 해줘. 작업 카드 타이틀바 밑에
 *  "followup 바"를 만들고 이렇게 남은 이슈당 한줄씩 그레이디엔트 텍스트 스타일로 출력해줘. (tl;dr 상단 우측에 x로
 *  dismiss하는 것처럼 이것들은 클릭시 dismiss하게 해줘. (해당 이슈를 모달 다이얼로그로 embed로 출력해서 볼수
 *  있도록해줘. (아티팩트 뷰처럼)"
 *
 *   F1 (T1/T2) the card hands @2lab.ai/ui its `followups`: every issue and PR link still open (cardLinks[].open), on a
 *      card that stopped — done (idle) or waiting on the user; never while it runs, never asleep or archived
 *   F2 (T2) the user's face layout (faceOf) keeps them whatever rows it picked
 *   F3 (T3) a follow-up seen in the modal stays gone in this browser — until it closes (a reopen shows it again)
 *   F4 (T4) the modal is the artifact viewer: one markdown page per follow-up of the card, the clicked one first in
 *      view, its body and comments as markdown, "GitHub에서 열기"; seen = its page loaded, recorded when it closes
 *
 * Executes the shipped page code (cut out of renderDashboardPage()'s template literal, cooked as the browser gets it).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { VIEW_LAYOUT_CLIENT_JS } from '../view-layout-client';

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
function load<T>(fns: string[], vars: string[], inject: Record<string, unknown> = {}): T {
  const names = Object.keys(inject);
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')}, state: function() { return _fuViewer; } };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}
function memStorage(seed: Record<string, string> = {}) {
  const m = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    dump: () => Object.fromEntries(m),
  };
}

const KEY = 'inst::C1:t1';
const I918 = 'https://github.com/2lab-ai/soma-work/issues/918';
const P951 = 'https://github.com/2lab-ai/soma-work/pull/951';
const P926 = 'https://github.com/2lab-ai/soma-work/pull/926';
const JIRA = 'https://acme.atlassian.net/browse/PROJ-12';
const WIKI = 'https://acme.atlassian.net/wiki/spaces/ENG/pages/1/Design';
const LINKS = [
  { kind: 'issue', url: I918, text: '#918', title: 'Phone chrome follow-ups', status: '열림', tone: 'run', open: true },
  { kind: 'pr', url: P926, text: '#926', status: '머지됨', tone: 'done' },
  { kind: 'wiki', url: WIKI, text: 'Design' },
  { kind: 'pr', url: P951, text: '#951', title: 'Keep the tab bar', status: '초안', open: true },
  { kind: 'issue', url: JIRA, text: 'PROJ-12', status: 'In Progress', tone: 'run', open: true },
];
const sess = (over: Record<string, unknown> = {}) => ({ key: KEY, cardLinks: LINKS, ...over });

const FNS = [
  'toNum',
  'followupGoneLoad',
  'followupGoneSave',
  'followupReconcile',
  'cardFollowupsOf',
  'followupDoc',
  'fuViewerItems',
  'openFollowupViewer',
  'fuLoad',
  'fuRender',
  'fuSeenBy',
  'onFuViewerView',
  'onFuViewerClose',
  'onFuViewerClosed',
];
const VARS = [
  'FOLLOWUP_GONE_KEY',
  'FOLLOWUP_GONE_MAX',
  '_followupGone',
  '_fuViewer',
  '_fuGen',
  'FU_STATE_WORD',
  'FU_REASON',
];

type F = { id: string; kind: string; text: string; title?: string; status?: string; href: string };
type Api = {
  followupReconcile(s: unknown): void;
  cardFollowupsOf(s: unknown, col: string): F[];
  followupDoc(f: F, res: unknown): string;
  openFollowupViewer(key: string, url: string, opener: unknown): void;
  onFuViewerView(detail: { id: string }): void;
  onFuViewerClose(): void;
  onFuViewerClosed(): void;
  state(): { key: string | null; opened: string | null; docs: Record<string, unknown> };
};

function harness(
  opts: {
    storage?: ReturnType<typeof memStorage>;
    fetch?: (url: string) => Promise<unknown>;
    session?: unknown;
    col?: string;
    sibling?: boolean;
  } = {},
) {
  const storage = opts.storage ?? memStorage();
  const refreshed: string[] = [];
  const viewer = { open: vi.fn(), data: undefined as unknown, index: -1 };
  const fetchFn = vi.fn(
    opts.fetch ??
      (async (url: string) => ({
        ok: true,
        status: 200,
        json: async () => ({
          url: decodeURIComponent(url.split('url=')[1]),
          kind: 'issue',
          text: '#918',
          full: true,
          embed: {
            kind: 'issue',
            title: 'Phone chrome follow-ups',
            state: 'open',
            author: 'zhuge-liang-bot[bot]',
            createdAt: '2026-11-05T05:00:00Z',
            labels: ['P2'],
            body: '- keep the tab bar\n- <img src=x onerror=alert(1)>',
            comments: [{ author: 'z', createdAt: '2026-11-05T06:00:00Z', body: 'LGTM' }],
            commentsTotal: 3,
          },
        }),
      })),
  );
  const m = load<Api>(FNS, VARS, {
    localStorage: storage,
    _sessionCache: { [KEY]: opts.session ?? sess() },
    _cardCol: { [KEY]: opts.col ?? 'idle' },
    refreshCard: (k: string) => refreshed.push(k),
    isSiblingSession: () => opts.sibling === true,
    fetch: fetchFn,
    document: { getElementById: (id: string) => (id === 'fu-viewer' ? viewer : null) },
  });
  return { m, storage, refreshed, viewer, fetchFn };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('F1 — the card hands the element its follow-ups', () => {
  it('done or waiting: every issue and PR still open, in the card’s link order; never a wiki, merged or closed', () => {
    const { m } = harness();
    for (const col of ['idle', 'waiting']) {
      expect(m.cardFollowupsOf(sess(), col)).toEqual([
        { id: I918, kind: 'issue', text: '#918', title: 'Phone chrome follow-ups', status: '열림', href: I918 },
        { id: P951, kind: 'pr', text: '#951', title: 'Keep the tab bar', status: '초안', href: P951 },
        { id: JIRA, kind: 'issue', text: 'PROJ-12', status: 'In Progress', href: JIRA },
      ]);
    }
  });

  it('running, asleep or archived: none; a card without links: none', () => {
    const { m } = harness();
    expect(m.cardFollowupsOf(sess(), 'working')).toEqual([]);
    expect(m.cardFollowupsOf(sess(), 'closed')).toEqual([]);
    expect(m.cardFollowupsOf(sess({ cardLinks: undefined }), 'idle')).toEqual([]);
    expect(m.cardFollowupsOf(null, 'idle')).toEqual([]);
  });
});

describe('F2 — the face layout keeps them whatever rows it picked', () => {
  it('faceOf passes followups through, with or without rows', () => {
    const faceOf = new Function(`${VIEW_LAYOUT_CLIENT_JS}\nreturn faceOf;`)() as (
      c: unknown,
      model: unknown,
      face: unknown,
    ) => { followups?: unknown; rows: string[] };
    const fu = [{ id: I918, kind: 'issue', text: '#918', href: I918 }];
    const card = { id: KEY, title: 'x', status: 'done', followups: fu, summary: 's' };
    expect(faceOf(card, '', { rows: [], foot: [] }).followups).toEqual(fu);
    expect(faceOf(card, '', { rows: [{ id: 'summary', on: true }], foot: [] }).followups).toEqual(fu);
    expect(faceOf({ ...card, followups: [] }, '', { rows: [], foot: [] }).followups).toBeUndefined();
  });

  it('viewCardOf hands them to the face (the board wiring)', () => {
    const src = clientFn('viewCardOf');
    expect(src).toContain('cardFollowupsOf(s, col)');
    expect(src).toMatch(/c\.followups = fu/);
  });
});

describe('F4 — the modal: the artifact viewer, one markdown page per follow-up', () => {
  it('opens at the clicked follow-up over all of the card’s, loads its page by the card and the URL', async () => {
    const { m, viewer, fetchFn } = harness();
    const opener = { focus() {} };
    m.openFollowupViewer(KEY, P951, opener);
    expect(viewer.open).toHaveBeenCalledTimes(1);
    const [items, at, back] = viewer.open.mock.calls[0];
    expect(items.map((i: { id: string }) => i.id)).toEqual([I918, P951, JIRA]);
    expect(at).toBe(1);
    expect(back).toBe(opener);
    expect(items[1]).toMatchObject({ kind: 'markdown', name: '#951 · Keep the tab bar' });
    expect(items[1].actions).toEqual([{ id: 'page', label: 'GitHub에서 열기', href: P951 }]);
    expect(items[2].actions).toEqual([{ id: 'page', label: '새 탭에서 열기', href: JIRA }]);
    expect(items[1].text).toContain('불러오는 중…');
    expect(fetchFn).toHaveBeenCalledWith(
      `/api/dashboard/session/${encodeURIComponent(KEY)}/link-embed?url=${encodeURIComponent(P951)}`,
      { credentials: 'same-origin' },
    );
    await flush();
    await flush();
    const after = (viewer.data as { items: Array<{ id: string; text: string }> }).items;
    expect(after[1].text).toContain('- keep the tab bar');
  });

  it('the page: reference and title, state · kind · author · date, labels, body, the newest comments', () => {
    const { m } = harness();
    const f = { id: I918, kind: 'issue', text: '#918', title: 'Phone chrome follow-ups', status: '열림', href: I918 };
    const doc = m.followupDoc(f, {
      full: true,
      embed: {
        kind: 'issue',
        title: 'Phone chrome follow-ups',
        state: 'open',
        author: 'bot',
        createdAt: '2026-11-05T05:00:00Z',
        labels: ['P2', 'ui'],
        body: 'Body text',
        comments: [{ author: 'z', createdAt: '2026-11-05T06:00:00Z', body: 'LGTM' }],
        commentsTotal: 3,
      },
    });
    const lines = doc.split('\n');
    expect(lines[0]).toBe('# #918 Phone chrome follow-ups');
    expect(lines[1]).toContain('**열림**');
    expect(lines[1]).toContain('이슈');
    expect(lines[1]).toContain('bot');
    expect(doc).toContain('라벨: P2, ui');
    expect(doc).toContain('Body text');
    expect(doc).toContain('## 댓글 (1 / 3)');
    expect(doc).toContain('LGTM');
    // Not the owner: the card's words and why; no body.
    const stub = m.followupDoc(f, { full: false, reason: 'owner-only' });
    expect(stub).toContain('# #918 Phone chrome follow-ups');
    expect(stub).toContain('**열림**');
    expect(stub).toContain('본문과 댓글은 이 작업의 주인과 관리자만 볼 수 있습니다.');
    expect(m.followupDoc(f, 'error')).toContain('내용을 불러오지 못했습니다. GitHub에서 열어 보세요.');
    expect(
      m.followupDoc(
        { ...f, kind: 'pr' },
        { full: true, embed: { kind: 'pr', state: 'merged', labels: [], body: '', comments: [], commentsTotal: 0 } },
      ),
    ).toContain('**머지됨** · PR');
  });

  it('paging to another follow-up loads its page once', async () => {
    const { m, fetchFn } = harness();
    m.openFollowupViewer(KEY, I918, null);
    await flush();
    m.onFuViewerView({ id: P951 });
    m.onFuViewerView({ id: P951 });
    await flush();
    expect(fetchFn.mock.calls.map((c) => decodeURIComponent(String(c[0]).split('url=')[1]))).toEqual([I918, P951]);
  });
});

describe('F3 — seen in the modal, gone from the bar in this browser; closed or merged brings it back on reopen', () => {
  it('closing after its page loaded records the clicked one only; the card redraws without it', async () => {
    const h = harness();
    h.m.openFollowupViewer(KEY, I918, null);
    await flush();
    await flush();
    h.m.onFuViewerView({ id: P951 });
    await flush();
    await flush();
    h.m.onFuViewerClosed();
    expect(h.refreshed).toEqual([KEY]);
    expect(h.m.cardFollowupsOf(sess(), 'idle').map((f) => f.id)).toEqual([P951, JIRA]);
    const saved = JSON.parse(h.storage.dump()['soma-dash-followup-gone']);
    expect(Object.keys(saved)).toEqual([`${KEY}\n${I918}`]);
    expect(h.m.state().key).toBeNull();
  });

  it('closed before its page came back, or its page failed: nothing recorded', async () => {
    const slow = harness({ fetch: () => new Promise(() => {}) });
    slow.m.openFollowupViewer(KEY, I918, null);
    slow.m.onFuViewerClosed();
    expect(slow.refreshed).toEqual([]);
    expect(slow.storage.dump()['soma-dash-followup-gone']).toBeUndefined();
    const down = harness({ fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
    down.m.openFollowupViewer(KEY, I918, null);
    await flush();
    await flush();
    down.m.onFuViewerClosed();
    expect(down.storage.dump()['soma-dash-followup-gone']).toBeUndefined();
    expect(down.m.cardFollowupsOf(sess(), 'idle').map((f) => f.id)).toContain(I918);
  });

  it('a seen follow-up that closed loses its record, so a reopen shows it again', () => {
    const storage = memStorage({ 'soma-dash-followup-gone': JSON.stringify({ [`${KEY}\n${I918}`]: 1 }) });
    const h = harness({ storage });
    expect(h.m.cardFollowupsOf(sess(), 'idle').map((f) => f.id)).toEqual([P951, JIRA]);
    const closed = LINKS.map((l) => (l.url === I918 ? { ...l, status: '닫힘', tone: 'done', open: undefined } : l));
    expect(h.m.cardFollowupsOf(sess({ cardLinks: closed }), 'idle').map((f) => f.id)).toEqual([P951, JIRA]);
    expect(JSON.parse(storage.dump()['soma-dash-followup-gone'])).toEqual({});
    expect(h.m.cardFollowupsOf(sess(), 'idle').map((f) => f.id)).toEqual([I918, P951, JIRA]);
  });
});

describe('the board wiring — a pressed line is the viewer’s opener', () => {
  it('inboxFollowupOf finds the line of that follow-up inside that card, never another card’s', () => {
    const find = new Function(`${clientFn('inboxFollowupOf')}\nreturn inboxFollowupOf;`)() as (
      host: unknown,
      cardId: string,
      id: string,
    ) => unknown;
    const line = (card: string, id: string) => ({
      getAttribute: (a: string) => (a === 'data-followup' ? id : null),
      closest: () => ({ getAttribute: () => card }),
    });
    const mine = line('a', 'b:c');
    const host = { shadowRoot: { querySelectorAll: () => [line('a:b', 'c'), mine] } };
    expect(find(host, 'a', 'b:c')).toBe(mine);
    expect(find(host, 'a', 'c')).toBeNull();
    expect(find({}, 'a', 'b:c')).toBeNull();
    const wire = clientFn('wireInbox');
    expect(wire).toContain("host.addEventListener('ui-followup'");
    expect(wire).toContain(
      'openFollowupViewer(cardId, String(e.detail.id), inboxFollowupOf(host, cardId, String(e.detail.id)) || host)',
    );
  });
});

// Review (astra-zhuge, PR #990): a failed or partial page never dismisses; a request from an earlier opening never
// lands; a sibling's page is drawn; follow-ups past the 20-chip window; a close seen while the card runs.
const answer = (body: unknown) => async () => ({ ok: true, status: 200, json: async () => body });
const settle = async () => {
  for (let i = 0; i < 4; i++) await flush();
};

describe('review — what counts as seen', () => {
  it('a 200 with reason "unavailable" leaves the line (nothing came back to read)', async () => {
    const h = harness({
      fetch: answer({ url: I918, kind: 'issue', text: '#918', full: false, reason: 'unavailable' }),
    });
    h.m.openFollowupViewer(KEY, I918, null);
    await settle();
    h.m.onFuViewerClosed();
    expect(h.storage.dump()['soma-dash-followup-gone']).toBeUndefined();
    expect(h.refreshed).toEqual([]);
  });

  it('the card’s words and why (owner-only, private-repo, unsupported) count as seen', async () => {
    for (const reason of ['owner-only', 'private-repo', 'unsupported']) {
      const h = harness({ fetch: answer({ url: I918, kind: 'issue', text: '#918', full: false, reason }) });
      h.m.openFollowupViewer(KEY, I918, null);
      await settle();
      h.m.onFuViewerClosed();
      expect(Object.keys(JSON.parse(h.storage.dump()['soma-dash-followup-gone']))).toEqual([`${KEY}\n${I918}`]);
    }
  });

  it('comments that did not load: said on the page, and the line stays', async () => {
    const h = harness({
      fetch: answer({
        url: I918,
        kind: 'issue',
        text: '#918',
        full: true,
        embed: {
          kind: 'issue',
          state: 'open',
          labels: [],
          body: 'B',
          comments: [],
          commentsTotal: 7,
          commentsError: true,
        },
      }),
    });
    h.m.openFollowupViewer(KEY, I918, null);
    await settle();
    const items = (h.viewer.data as { items: Array<{ text: string }> }).items;
    expect(items[0].text).toContain('댓글을 불러오지 못했습니다. GitHub에서 확인하세요.');
    h.m.onFuViewerClosed();
    expect(h.storage.dump()['soma-dash-followup-gone']).toBeUndefined();
  });

  it('the private-repo page says why', () => {
    const { m } = harness();
    const f = { id: I918, kind: 'issue', text: '#918', title: 'T', status: '열림', href: I918 };
    expect(m.followupDoc(f, { full: false, reason: 'private-repo' })).toContain(
      '비공개 저장소의 본문과 댓글은 관리자만 볼 수 있습니다.',
    );
  });
});

describe('review — one opening, one set of answers', () => {
  it('an answer from an earlier opening of the same card never lands in a later one', async () => {
    const resolvers: Array<(v: unknown) => void> = [];
    const h = harness({ fetch: () => new Promise((r) => resolvers.push(r)) });
    h.m.openFollowupViewer(KEY, I918, null);
    h.m.onFuViewerClosed();
    h.m.openFollowupViewer(KEY, I918, null);
    // The first opening's answer comes back now: unavailable.
    resolvers[0]({ ok: true, status: 200, json: async () => ({ full: false, reason: 'unavailable' }) });
    await settle();
    expect(h.m.state().docs[I918]).toBeNull();
    resolvers[1]({
      ok: true,
      status: 200,
      json: async () => ({
        full: true,
        embed: { kind: 'issue', state: 'open', labels: [], body: 'fresh', comments: [], commentsTotal: 0 },
      }),
    });
    await settle();
    expect((h.viewer.data as { items: Array<{ text: string }> }).items[0].text).toContain('fresh');
  });

  it('an answer that comes back while the viewer closes does not count', async () => {
    let resolve: (v: unknown) => void = () => {};
    const h = harness({ fetch: () => new Promise((r) => (resolve = r)) });
    h.m.openFollowupViewer(KEY, I918, null);
    h.m.onFuViewerClose();
    resolve({
      ok: true,
      status: 200,
      json: async () => ({
        full: true,
        embed: { kind: 'issue', labels: [], body: 'x', comments: [], commentsTotal: 0 },
      }),
    });
    await settle();
    h.m.onFuViewerClosed();
    expect(h.storage.dump()['soma-dash-followup-gone']).toBeUndefined();
  });

  it('a sibling instance’s card: its page says why at once (no fetch) and counts as seen', () => {
    const h = harness({ sibling: true });
    h.m.openFollowupViewer(KEY, I918, null);
    expect(h.fetchFn).not.toHaveBeenCalled();
    const items = (h.viewer.data as { items: Array<{ text: string }> }).items;
    expect(items[0].text).toContain('이 페이지는 대시보드에서 내용을 보여 줄 수 없습니다.');
    h.m.onFuViewerClosed();
    expect(Object.keys(JSON.parse(h.storage.dump()['soma-dash-followup-gone']))).toEqual([`${KEY}\n${I918}`]);
  });
});

describe('review — the bar reads every open link; a close is seen in any column', () => {
  it('followupLinks (every open issue and PR, past the 20 chips) wins over the chips', () => {
    const { m } = harness();
    const OLD = 'https://github.com/2lab-ai/soma-work/issues/700';
    const chips = Array.from({ length: 20 }, (_, i) => ({
      kind: 'issue',
      url: `https://github.com/2lab-ai/soma-work/issues/${800 + i}`,
      text: `#${800 + i}`,
      status: '닫힘',
    }));
    const s = sess({
      cardLinks: chips,
      followupLinks: [{ kind: 'issue', url: OLD, text: '#700', status: '열림', open: true }],
    });
    expect(m.cardFollowupsOf(s, 'idle').map((f) => f.id)).toEqual([OLD]);
  });

  it('a seen follow-up that closes while its card runs loses its record then', () => {
    const storage = memStorage({ 'soma-dash-followup-gone': JSON.stringify({ [`${KEY}\n${I918}`]: 1 }) });
    const h = harness({ storage });
    const closed = LINKS.map((l) => (l.url === I918 ? { ...l, status: '닫힘', tone: 'done', open: undefined } : l));
    expect(h.m.cardFollowupsOf(sess({ cardLinks: closed }), 'working')).toEqual([]);
    expect(JSON.parse(storage.dump()['soma-dash-followup-gone'])).toEqual({});
  });
});

describe('review round 2 — reconcile from the whole board, past the chips', () => {
  it('followupSettled (every closed or merged link) clears a record the chips no longer show', () => {
    const OLD = 'https://github.com/2lab-ai/soma-work/issues/700';
    const storage = memStorage({
      'soma-dash-followup-gone': JSON.stringify({ [`${KEY}\n${OLD}`]: 1, [`${KEY}\n${I918}`]: 2 }),
    });
    const h = harness({ storage });
    h.m.followupReconcile(sess({ followupSettled: [OLD] }));
    expect(Object.keys(JSON.parse(storage.dump()['soma-dash-followup-gone']))).toEqual([`${KEY}\n${I918}`]);
  });

  it('renderBoard reconciles every session it caches (filtered and collapsed cards too), guarded for harnesses', () => {
    const src = clientFn('renderBoard');
    expect(src).toContain("if (typeof followupReconcile === 'function') followupReconcile(arr[i0]);");
    const ws = TEMPLATE.slice(
      TEMPLATE.indexOf("msg.type === 'sessionUpdated'"),
      TEMPLATE.indexOf("msg.type === 'sessionUpdated'") + 1200,
    );
    expect(cook(ws.replace(/`/g, ''))).toContain(
      "if (typeof followupReconcile === 'function') followupReconcile(msg.session);",
    );
  });
});

describe('review round 3 — an epic’s children are reconciled where they are cached', () => {
  it('renderBoard’s child loop and applyEpicPush both reconcile each child', () => {
    const board = clientFn('renderBoard');
    expect(board).toContain("if (typeof followupReconcile === 'function') followupReconcile(kids[k0]);");
    const push = clientFn('applyEpicPush');
    expect(push).toContain("if (typeof followupReconcile === 'function') followupReconcile(children[i]);");
  });

  it('a hidden child’s close → reopen: its record goes on the close, so the reopen shows it', () => {
    const CHILD = 'inst::C1:child';
    const storage = memStorage({ 'soma-dash-followup-gone': JSON.stringify({ [`${CHILD}\n${I918}`]: 1 }) });
    const h = harness({ storage });
    h.m.followupReconcile({ key: CHILD, followupSettled: [I918] });
    expect(JSON.parse(storage.dump()['soma-dash-followup-gone'])).toEqual({});
    const reopened = { key: CHILD, cardLinks: LINKS, followupLinks: LINKS.filter((l) => l.open) };
    expect(h.m.cardFollowupsOf(reopened, 'idle').map((f) => f.id)).toContain(I918);
  });
});
