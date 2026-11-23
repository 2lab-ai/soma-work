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
  const { uqCardOf } = load<any>(['uqCardOf', 'uqCardKey', 'uqSibling'], { SELF_INSTANCE_NAME: 'dev' });

  it('a waiting request: 대기중 · n번째, what runs before it, and both buttons', () => {
    const card = uqCardOf(item({ position: 2 }), undefined);
    expect(card).toMatchObject({
      id: 'uq:q1',
      title: '두 번째 일',
      status: 'idle',
      statusText: '대기중 · 2번째',
      since: 1000,
      bodyMode: 'steps',
      primary: { id: 'uq-bypass', label: '먼저 진행' },
      actions: [{ id: 'uq-cancel', label: '대기 취소' }],
    });
    expect(card.summary).toContain('동시 1개');
    expect(card.summary).toContain('첫 일 다음');
    expect(JSON.stringify(card.details)).toContain('진행 중: 첫 일');
    expect(JSON.stringify(card.details)).toContain('멈춘 작업은 끝난 뒤 이어서');
  });

  it('the thread’s own title wins when it has a session', () => {
    expect(uqCardOf(item(), { displayHeadline: '로그인 버그' }).title).toBe('로그인 버그');
  });

  it('a stopped task says it carries on; one on its way has no buttons', () => {
    const resume = uqCardOf(item({ kind: 'resume' }), undefined);
    expect(resume.statusText).toBe('이어서 하기 대기 · 1번째');
    const admitted = uqCardOf(item({ state: 'admitted', position: 0 }), undefined);
    expect(admitted.statusText).toBe('시작 중');
    expect(admitted.primary).toBeUndefined();
    expect(admitted.actions).toBeUndefined();
  });

  it('someone who may not act on it sees the buttons inert, with the reason', () => {
    const { uqCardOf: asStranger } = load<any>(['uqCardOf', 'uqCardKey', 'uqSibling'], {
      SELF_INSTANCE_NAME: 'dev',
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
    expect(card.summary).toContain('무제한');
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
