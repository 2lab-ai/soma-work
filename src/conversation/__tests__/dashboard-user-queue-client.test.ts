/**
 * The per-user task queue on the board (client half): the 대기큐 line leads 응답 필요 — each entry its own card
 * (대기중 · n번째, what runs before it, 먼저 진행 / 대기 취소) — and a thread in line is not drawn twice. Executes the
 * shipped client code, cut out of renderDashboardPage()'s template literal and cooked as the browser receives it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));

function cook(fragment: string): string {
  if (fragment.includes('`') || fragment.includes('${')) throw new Error('fragment is not a plain template slice');
  return new Function(`return \`${fragment}\`;`)() as string;
}
function clientFn(name: string, prefix = 'function'): string {
  const start = TEMPLATE.indexOf(`\n${prefix} ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = TEMPLATE.indexOf('\n}\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 2));
}
function load<T>(fns: Array<string | [string, string]>, inject: Record<string, unknown> = {}): T {
  const names = Object.keys(inject);
  const list = fns.map((f) => (Array.isArray(f) ? f : [f, 'function']));
  const body = `${list.map(([n, p]) => clientFn(n, p)).join('\n')}\nreturn { ${list.map(([n]) => n).join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}

const item = (over: Record<string, unknown> = {}) => ({
  key: 'C1:t2',
  entryId: 'q1',
  ownerId: 'U1',
  ownerName: 'Zed',
  channelId: 'C1',
  threadTs: 't2',
  kind: 'request',
  state: 'waiting',
  position: 1,
  preview: '두 번째 일',
  enqueuedAt: 1000,
  limit: 1,
  running: [{ key: 'C1:t1', title: '첫 일' }],
  ...over,
});

describe('uqSplitWaiting', () => {
  const { uqSplitWaiting } = load<any>(['uqSplitWaiting']);

  it('the line keeps its order; a thread in line leaves the 응답 필요 cards', () => {
    const waiting = [{ key: 'C1:t2', userQueue: { entryId: 'q1' } }, { key: 'C1:t9' }];
    const split = uqSplitWaiting([item(), item({ key: 'C1:t3', entryId: 'q2', position: 2 })], waiting, []);
    expect(split.line.map((q: any) => q.entryId)).toEqual(['q1', 'q2']);
    expect(split.needs.map((s: any) => s.key)).toEqual(['C1:t9']);
  });

  it('the owner filter applies to the line too', () => {
    const split = uqSplitWaiting([item(), item({ entryId: 'q2', ownerId: 'U2' })], [], ['U2']);
    expect(split.line.map((q: any) => q.entryId)).toEqual(['q2']);
  });

  it('no line: 응답 필요 is untouched', () => {
    const waiting = [{ key: 'a' }, { key: 'b' }];
    expect(uqSplitWaiting(undefined, waiting, []).needs).toEqual(waiting);
  });
});

describe('uqCardOf', () => {
  // One person's board (currentUserId set): every card is theirs, so no badge — the summary names them.
  const { uqCardOf } = load<any>(['uqCardOf', 'uqCardKey', 'uqSibling'], {
    SELF_INSTANCE_NAME: 'dev',
    currentUserId: 'U1',
  });

  it('first in line: whose it is, that it starts when the running task ends, and both buttons', () => {
    const card = uqCardOf(item(), undefined);
    expect(card).toMatchObject({
      id: 'uq:q1',
      title: '두 번째 일',
      status: 'idle',
      statusText: '대기중 · 1번째',
      since: 1000,
      bodyMode: 'steps',
      primary: { id: 'uq-bypass', label: '먼저 진행' },
      actions: [{ id: 'uq-cancel', label: '대기 취소' }],
    });
    expect(card.summary).toBe('Zed · 다음 차례 — 첫 일 끝나면 바로 시작');
    const details = JSON.stringify(card.details);
    expect(details).toContain('진행 중: 첫 일');
    expect(details).toContain('끝나면 이 작업 시작');
    expect(details).toContain('한 번에 1개');
    expect(details).toContain('먼저 진행: 첫 일을(를) 멈추고 이 작업을 바로 시작');
    expect(details).toContain('멈춘 작업은 이 작업이 끝난 뒤 이어서');
  });

  // a shared dev host (2026-11-24): the second entry read "첫 일 다음" too — as if nothing waited ahead of it.
  it('second in line: what waits right ahead of it, not "next after the running task"', () => {
    const card = uqCardOf(item({ entryId: 'q2', position: 2, ahead: { title: '두 번째 일', count: 1 } }), undefined);
    expect(card.statusText).toBe('대기중 · 2번째');
    expect(card.summary).toBe('Zed · 앞에 1개 먼저 — 바로 앞: 두 번째 일');
    const details = JSON.stringify(card.details);
    expect(details).toContain('끝나면 앞 순서부터');
    expect(details).toContain('앞에서 기다림: 두 번째 일');
    expect(details).not.toContain('끝나면 이 작업 시작');
    const third = uqCardOf(item({ entryId: 'q3', position: 3, ahead: { title: 'B', count: 2 } }), undefined);
    expect(JSON.stringify(third.details)).toContain('앞에서 기다림: B 외 1개');
  });

  // #1413 review: the card names the task 먼저 진행 will stop as the server picked it (the newest unguarded one).
  it('names the task the server marked as the one 먼저 진행 stops', () => {
    const card = uqCardOf(
      item({
        // Board order is not newest-first: the marked one comes second here.
        running: [
          { key: 'C1:b', title: '오래된 작업' },
          { key: 'C1:a', title: '새 작업', stops: true },
        ],
      }),
      undefined,
    );
    expect(JSON.stringify(card.details)).toContain('먼저 진행: 새 작업을(를) 멈추고');
  });

  it('a running task that may not be stopped (a deploy lane): 먼저 진행 is inert and says why', () => {
    const card = uqCardOf(item({ running: [{ key: 'C1:t1', title: '배포', guard: 'deploy:dev2' }] }), undefined);
    expect(card.primary.disabled).toContain('deploy:dev2');
    expect(JSON.stringify(card.details)).toContain('먼저 진행 불가');
  });

  it('the thread’s own title wins when it has a session', () => {
    expect(uqCardOf(item(), { displayHeadline: '로그인 버그' }).title).toBe('로그인 버그');
  });

  it('a stopped task says it carries on; one on its way has no buttons', () => {
    const resume = uqCardOf(item({ kind: 'resume' }), undefined);
    expect(resume.statusText).toBe('이어서 하기 대기 · 1번째');
    expect(resume.summary).toBe('Zed · 멈춘 작업 — 차례가 오면 멈춘 지점부터 이어서');
    const admitted = uqCardOf(item({ state: 'admitted', position: 0 }), undefined);
    expect(admitted.statusText).toBe('시작 중');
    expect(admitted.primary).toBeUndefined();
    expect(admitted.actions).toBeUndefined();
  });

  it('someone who may not act on it sees the buttons inert, with the reason', () => {
    const { uqCardOf: asStranger } = load<any>(['uqCardOf', 'uqCardKey', 'uqSibling'], {
      SELF_INSTANCE_NAME: 'dev',
      currentUserId: 'U1',
      viewerCanManage: () => false,
      OWNER_ONLY_MSG: '소유자나 관리자 모드를 켠 관리자만 할 수 있어요',
    });
    const card = asStranger(item(), undefined);
    expect(card.primary).toMatchObject({
      id: 'uq-bypass',
      disabled: '소유자나 관리자 모드를 켠 관리자만 할 수 있어요',
    });
    expect(card.actions[0]).toMatchObject({
      id: 'uq-cancel',
      disabled: '소유자나 관리자 모드를 켠 관리자만 할 수 있어요',
    });
  });

  it('a sibling instance’s entry shows no buttons here; no limit reads 무제한', () => {
    const card = uqCardOf(item({ environment: { instanceName: 'main' }, limit: null }), undefined);
    expect(card.primary).toBeUndefined();
    expect(JSON.stringify(card.details)).toContain('한 번에 무제한');
  });
});

// Z 2026-11-24: "대기큐에도 누구 대기큐인지도 이름 뱃지" — on the All Users board an entry's card names its owner with the
// same badge the session cards carry: one person, one colour; the viewer's own with the ring.
describe('uqCardOf — the owner badge', () => {
  const hue = vi.fn((id: string) => (id === 'U1' ? 5 : 2));
  const allUsers = (over: Record<string, unknown> = {}) =>
    load<any>(['uqCardOf', 'uqCardKey', 'uqSibling'], {
      SELF_INSTANCE_NAME: 'dev',
      currentUserId: '',
      ownerBadgeHue: hue,
      viewerOwns: () => false,
      ...over,
    }).uqCardOf;

  it('All Users: the badge names the owner in their colour, and the summary does not say the name again', () => {
    const card = allUsers()(item(), undefined);
    expect(card.badge).toEqual({ text: 'Zed', hue: 5, title: 'Zed' });
    expect(hue).toHaveBeenCalledWith('U1');
    expect(card.summary).toBe('다음 차례 — 첫 일 끝나면 바로 시작');
  });

  it('another owner gets their own colour; no name falls back to the id', () => {
    const card = allUsers()(item({ entryId: 'q2', ownerId: 'U2', ownerName: undefined }), undefined);
    expect(card.badge).toEqual({ text: 'U2', hue: 2, title: 'U2' });
  });

  it("the viewer's own entry: the ring (self), and no host title — the element says the name (나)", () => {
    const card = allUsers({ viewerOwns: (x: any) => x && x.ownerId === 'U1' })(item(), undefined);
    expect(card.badge).toEqual({ text: 'Zed', hue: 5, self: true });
  });

  it("one person's board: no badge (every card is theirs), the summary keeps the name", () => {
    const { uqCardOf } = load<any>(['uqCardOf', 'uqCardKey', 'uqSibling'], {
      SELF_INSTANCE_NAME: 'dev',
      currentUserId: 'U1',
      ownerBadgeHue: hue,
    });
    const card = uqCardOf(item(), undefined);
    expect(card.badge).toBeUndefined();
    expect(card.summary).toBe('Zed · 다음 차례 — 첫 일 끝나면 바로 시작');
  });
});

// The board's owner hues count the 대기큐 owners too, so an owner who only waits in line still gets a colour no one else
// on the board has.
describe('boardOwnerIds', () => {
  it("the cached sessions' owners and the line's owners", () => {
    const { boardOwnerIds } = load<any>(['boardOwnerIds']);
    const cache = { a: { ownerId: 'U1' }, b: { ownerName: 'Bo' } };
    expect(boardOwnerIds(cache, [item({ ownerId: 'U3' }), item({ ownerId: undefined, ownerName: 'Kay' })])).toEqual([
      'U1',
      'Bo',
      'U3',
      'Kay',
    ]);
    expect(boardOwnerIds(cache, undefined)).toEqual(['U1', 'Bo']);
  });

  it('renderBoard assigns the hues from it, with the board line', () => {
    expect(TEMPLATE).toContain('_ownerIndex = assignOwnerHues(boardOwnerIds(_sessionCache, board.userQueue));');
  });
});

describe('uqAct', () => {
  it('posts the action to the entry and says what happened', async () => {
    const acPost = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ ok: true, deferred: { sessionKey: 'C1:t1' } }) });
    const dashToast = vi.fn();
    const { uqAct } = load<any>([['uqAct', 'async function'], 'uqSibling'], {
      acPost,
      dashToast,
      acRefusal: vi.fn(),
      SELF_INSTANCE_NAME: null,
      encodeURIComponent,
    });
    await uqAct(item(), 'bypass');
    expect(acPost).toHaveBeenCalledWith('/api/dashboard/user-queue/q1/bypass', '{}');
    expect(dashToast.mock.calls[0][0]).toMatchObject({ title: '먼저 진행합니다', tone: 'success' });
    expect(dashToast.mock.calls[0][0].description).toContain('이어서');
  });

  it('a refusal is shown as a warning', async () => {
    const acPost = vi.fn().mockResolvedValue({ ok: false, status: 409 });
    const dashToast = vi.fn();
    const { uqAct } = load<any>([['uqAct', 'async function'], 'uqSibling'], {
      acPost,
      dashToast,
      acRefusal: vi.fn().mockResolvedValue({ message: 'not-waiting' }),
      SELF_INSTANCE_NAME: null,
      encodeURIComponent,
    });
    await uqAct(item(), 'cancel');
    expect(dashToast.mock.calls[0][0]).toMatchObject({ title: '대기 취소하지 못했어요', tone: 'warning' });
  });
});

describe('renderBoard wiring (source)', () => {
  const render = clientFn('renderBoard');
  it('the 응답 필요 column leads with the 대기큐 group, then 응답 필요', () => {
    expect(render).toContain('uqSplitWaiting(board.userQueue');
    expect(render.indexOf('UQ_GROUP_LINE')).toBeLessThan(render.indexOf('UQ_GROUP_NEEDS'));
    expect(render).toContain('대기큐 · ');
    // A thread that waits in line is not counted as needing an answer.
    expect(render).toContain('return !s.userQueue;');
  });
});

// A WebSocket push repaints the board through mergeSiblingCards (this instance's cards + the siblings' from the last
// poll). The push carries this instance's 대기큐 too: dropping it emptied the line on the first push after a poll.
describe('a pushed board keeps the 대기큐 (mergeSiblingCards)', () => {
  const cols = () => ({ working: [], waiting: [], idle: [], closed: [] });
  const sib = () => item({ key: 'other::C9:t9', entryId: 'q9', environment: { instanceName: 'other' } });
  const merge = (polled: unknown) =>
    load<any>(['mergeSiblingCards', 'isSiblingSession'], { _lastPolledBoard: polled, SELF_INSTANCE_NAME: 'dev' })
      .mergeSiblingCards;

  it("keeps the push's own line, then the siblings' entries from the last poll", () => {
    const polled = { ...cols(), userQueue: [item({ key: 'C1:t0', entryId: 'q0' }), sib()] };
    const out = merge(polled)({ ...cols(), userQueue: [item()] });
    expect(out.userQueue.map((q: any) => q.entryId)).toEqual(['q1', 'q9']);
  });

  it("an emptied line here drops this instance's old entries, never the siblings'", () => {
    const polled = { ...cols(), userQueue: [item({ key: 'C1:t0', entryId: 'q0' }), sib()] };
    expect(merge(polled)(cols()).userQueue.map((q: any) => q.entryId)).toEqual(['q9']);
  });

  it('no line anywhere: the board has none', () => {
    expect(merge(cols())(cols()).userQueue).toBeUndefined();
  });
});

// The board picker (one person's board) filters a push before it paints: the 대기큐 is that person's too.
describe('a pushed board for one person (pushedBoardForUser)', () => {
  const { pushedBoardForUser } = load<any>(['pushedBoardForUser']);

  it("keeps only that person's cards and entries; with no person picked, everything", () => {
    const board = () => ({
      working: [
        { key: 'a', ownerId: 'U1' },
        { key: 'b', ownerId: 'U2' },
      ],
      waiting: [],
      idle: [],
      closed: [],
      userQueue: [item(), item({ entryId: 'q2', ownerId: 'U2' })],
    });
    const mine = pushedBoardForUser(board(), 'U2');
    expect(mine.working.map((s: any) => s.key)).toEqual(['b']);
    expect(mine.userQueue.map((q: any) => q.entryId)).toEqual(['q2']);
    expect(pushedBoardForUser(board(), null).userQueue).toHaveLength(2);
  });
});

describe('the push handler paints through them (source)', () => {
  it('filters for the picked person, then merges the siblings', () => {
    const at = TEMPLATE.indexOf("if (msg.type === 'session_update') {");
    const handler = TEMPLATE.slice(at, TEMPLATE.indexOf('paintPushedBoard(', at) + 60);
    expect(handler).toContain('pushedBoardForUser(msg.board, currentUserId)');
  });
});
