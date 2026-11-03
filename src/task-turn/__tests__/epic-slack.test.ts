/**
 * #854 — the epic's host on the Slack path, a child's chain end, and the epic's wake.
 *
 *   H1 spawn: the child is counted on the epic, its own thread is made in the epic's channel, and
 *      its first instruction goes there as the owner's — verbatim, no goal, its place under the
 *      epic on the event; `started` once it is taken.
 *   H2 a thread that could not be made takes the reservation back ("nothing changed").
 *   H3 a first instruction the pipeline did not take: the child is made, not started, and says so.
 *   H4 instruct: into the child's thread as the owner's; a working child's word is queued.
 *   O1 a chain's end as the epic hears it (completed / waiting / failed / cancelled / interrupted),
 *      none when nothing ran or the work goes on by itself.
 *   W1 an idle epic with pending ends wakes once: its events delivered to the wake first, then the
 *      fixed wake text into its thread; a busy, done or eventless epic does not.
 *   W2 a wake that was not taken puts the events back and retries once.
 *   W3 the tree's limits refuse a wake: the events stay pending, one retry.
 */
import { describe, expect, it, vi } from 'vitest';
import { chainEndOf, createSlackEpicHost, createSlackEpicWaker, readLatestFinal } from '../epic-slack';

const tick = () => new Promise((r) => setTimeout(r, 0));

function hostWorld(over: Record<string, any> = {}) {
  const epic: any = {
    taskId: 'e1',
    ownerId: 'U1',
    channelId: 'C1',
    threadTs: '1.0',
    title: '로그인 에픽',
    model: 'opus',
    kind: 'epic',
  };
  const child: any = { taskId: 'c1', ownerId: 'U1', channelId: 'C1', threadTs: '2.0', parentTaskId: 'e1' };
  const watchers = new Map<string, () => void>();
  const deps: any = {
    getSessionByTaskId: vi.fn(),
    getChildTasks: vi.fn(() => []),
    setEpicPlan: vi.fn(),
    reserveEpicChild: vi.fn(() => 'child-1'),
    unreserveEpicChild: vi.fn(),
    keyOf: (s: any) => `${s.channelId}-${s.threadTs}`,
    postMessage: vi.fn(async () => ({ ts: '9.9' })),
    onTurnAccepted: vi.fn((channel: string, ts: string, cb: () => void) => {
      watchers.set(`${channel}:${ts}`, cb);
      return () => watchers.delete(`${channel}:${ts}`);
    }),
    // The pipeline takes the message (its turn reaches the model), then the run goes on.
    handleMessage: vi.fn(async (event: any) => {
      watchers.get(`${event.channel}:${event.ts}`)?.();
      await new Promise(() => {});
    }),
    sendToThread: vi.fn(async (_key: string, _text: string, opts: any) => {
      opts.onAccepted();
      await new Promise(() => {});
    }),
    isRunning: vi.fn(() => false),
    readWorkLog: vi.fn(),
    gate: { refusal: vi.fn(() => undefined), record: vi.fn() },
    ensureDirectory: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn() },
    ...over,
  };
  return { epic, child, deps, host: createSlackEpicHost(deps) };
}

describe('the epic host on the Slack path (#854)', () => {
  it('H1 — spawn: counted, its own thread in the epic’s channel, the instruction as the owner’s; started once taken', async () => {
    const w = hostWorld();
    const r = await w.host.spawnChild(w.epic, {
      planNodeId: 'login',
      instruction: '로그인 고쳐',
      title: '로그인',
      workingDirectory: '/tmp/U1/session_e/work',
    });
    expect(r).toEqual({ ok: true, childId: 'child-1', started: true });
    expect(w.deps.reserveEpicChild).toHaveBeenCalledWith('e1', 'login');
    expect(w.deps.postMessage).toHaveBeenCalledWith('C1', expect.stringContaining('로그인'), expect.any(Array));
    expect(w.deps.handleMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        user: 'U1',
        channel: 'C1',
        thread_ts: '9.9',
        ts: '9.9',
        text: '로그인 고쳐',
        modelOverride: 'opus',
        autoGoalOverride: false,
        epicChild: { taskId: 'child-1', parentTaskId: 'e1', planNodeId: 'login', title: '로그인' },
        workingDirectoryOverride: '/tmp/U1/session_e/work',
        // The epic's words, not the owner's (review #872 astra): a host turn — it answers no open
        // question, revises no plan, and is recorded as soma-work's, as the task path's host start was.
        routeContext: { skipAutoBotThread: true, verbatimPrompt: true, hostTurn: true },
      }),
    );
    // The reservation counted before the thread; the start counted in the tree's window.
    expect(w.deps.reserveEpicChild.mock.invocationCallOrder[0]).toBeLessThan(
      w.deps.postMessage.mock.invocationCallOrder[0],
    );
    expect(w.deps.gate.record).toHaveBeenCalledWith(w.epic);
  });

  it('H6 — parallel spawns (review #872): one child per node while it is made; the ones being made take places', async () => {
    let post!: (v: { ts: string }) => void;
    const w = hostWorld({ postMessage: vi.fn(() => new Promise((r) => (post = r))) });
    const first = w.host.spawnChild(w.epic, { planNodeId: 'login', instruction: 'go', title: 't' });
    // The same node again while its thread is being made: refused, nothing reserved twice.
    expect(await w.host.spawnChild(w.epic, { planNodeId: 'login', instruction: 'go', title: 't' })).toMatchObject({
      ok: false,
      code: 'spawn-in-flight',
    });
    expect(w.deps.reserveEpicChild).toHaveBeenCalledTimes(1);
    // Another node's admission counts the child being made.
    w.host.admit(w.epic, { newChild: true });
    expect(w.deps.gate.refusal).toHaveBeenLastCalledWith(w.epic, { newChild: true, making: 1 });
    post({ ts: '9.9' });
    await first;
    w.host.admit(w.epic, { newChild: true });
    expect(w.deps.gate.refusal).toHaveBeenLastCalledWith(w.epic, { newChild: true, making: 0 });
  });

  it('H2 — a thread that could not be made takes the reservation back', async () => {
    const w = hostWorld({ postMessage: vi.fn(async () => undefined) });
    const r = await w.host.spawnChild(w.epic, { planNodeId: 'login', instruction: 'go', title: 't' });
    expect(r).toMatchObject({ ok: false, code: 'no-thread' });
    expect(w.deps.unreserveEpicChild).toHaveBeenCalledWith('e1', 'child-1');
    expect(w.deps.handleMessage).not.toHaveBeenCalled();
    const unsaved = hostWorld({
      reserveEpicChild: vi.fn(() => {
        throw new Error('disk');
      }),
    });
    expect(
      await unsaved.host.spawnChild(unsaved.epic, { planNodeId: 'login', instruction: 'go', title: 't' }),
    ).toMatchObject({
      ok: false,
      code: 'not-saved',
    });
    expect(unsaved.deps.postMessage).not.toHaveBeenCalled();
  });

  it('H3 — a first instruction the pipeline did not take: made, not started, and it says so', async () => {
    const w = hostWorld({ handleMessage: vi.fn(async () => undefined) });
    const r = await w.host.spawnChild(w.epic, { planNodeId: 'login', instruction: 'go', title: 't' });
    expect(r).toMatchObject({
      ok: true,
      childId: 'child-1',
      started: false,
      reason: expect.stringMatching(/did not start/),
    });
    // Review #872 (grok P1): a bind that failed after the thread was posted would leak the id and eat the 7-child cap.
    expect(w.deps.unreserveEpicChild).toHaveBeenCalledWith('e1', 'child-1');
    expect(w.deps.gate.record).not.toHaveBeenCalled();
  });

  it('H4 — instruct: into the child’s thread as the owner’s; a working child’s word is queued, a taken one is not refused', async () => {
    const idle = hostWorld();
    expect(await idle.host.instructChild(idle.epic, idle.child, '테스트 추가')).toEqual({ taken: true, queued: false });
    expect(idle.deps.sendToThread).toHaveBeenCalledWith(
      'C1-2.0',
      '테스트 추가',
      expect.objectContaining({ label: '🧩 에픽의 지시' }),
    );
    expect(idle.deps.gate.record).toHaveBeenCalledTimes(1);

    const busy = hostWorld({ isRunning: vi.fn(() => true) });
    expect(await busy.host.instructChild(busy.epic, busy.child, '이것도')).toEqual({ taken: true, queued: true });
    // Queued behind the turn in flight: no new start in the tree's window.
    expect(busy.deps.gate.record).not.toHaveBeenCalled();

    const lost = hostWorld({ sendToThread: vi.fn(async () => undefined) });
    expect(await lost.host.instructChild(lost.epic, lost.child, 'go')).toMatchObject({ taken: false });
    // Nothing ran: no start counted in the tree's window.
    expect(lost.deps.gate.record).not.toHaveBeenCalled();
  });

  it('H5 — a child’s last answer is its work log’s last main-agent final', async () => {
    const readWorkLog = vi.fn(async () => ({
      entries: [
        { seq: 1, kind: 'final', text: '첫 답', turnId: 't1' },
        { seq: 2, kind: 'final', text: '서브에이전트', turnId: 't2', agentId: 'a' },
        { seq: 3, kind: 'final', text: '마지막 답', turnId: 't3', rawBytes: 9000 },
        { seq: 4, kind: 'tool', text: 'x', turnId: 't3' },
      ],
      hasMore: false,
    }));
    expect(await readLatestFinal(readWorkLog as any, 'conv')).toEqual({ text: '마지막 답', clipped: true });
  });
});

describe('a chain end as its epic hears it (#854)', () => {
  it('O1 — completed / waiting / failed / cancelled / interrupted; none when nothing ran', () => {
    expect(chainEndOf({ result: 'safe' })).toEqual({ outcome: 'completed' });
    expect(chainEndOf({ result: 'blocked', reason: 'awaiting user choice' })).toEqual({ outcome: 'waiting' });
    expect(chainEndOf({ result: 'error', reason: 'boom' })).toEqual({ outcome: 'failed', reason: 'boom' });
    expect(chainEndOf({ result: 'interrupted', reason: 'user-stop' })).toEqual({
      outcome: 'cancelled',
      reason: 'user-stop',
    });
    expect(chainEndOf({ result: 'interrupted', reason: 'shutdown' })).toEqual({
      outcome: 'interrupted',
      reason: 'shutdown',
    });
    expect(chainEndOf({ result: 'interrupted', reason: 'auto-compact' })).toBeUndefined();
    expect(chainEndOf({ result: 'blocked', reason: 'directive-only message' })).toBeUndefined();
    // Review #872 (fable P2-1): a turn that ran and then hit the handoff ceiling stopped — its epic hears it.
    expect(chainEndOf({ result: 'blocked', reason: 'auto-handoff budget exhausted: limit 3' })).toEqual({
      outcome: 'failed',
      reason: 'auto-handoff budget exhausted: limit 3',
    });
    expect(chainEndOf({ result: 'denied', reason: 'x' } as any)).toBeUndefined();
  });
});

describe('the Slack epic waker (#854)', () => {
  const pending = (id: string) => ({
    id,
    childTaskId: 'c1',
    planNodeId: 'login',
    outcome: 'completed',
    at: 1,
    state: 'pending',
  });

  function wakerWorld(over: Record<string, any> = {}, epicOver: Record<string, any> = {}) {
    const epic: any = { taskId: 'e1', ownerId: 'U1', kind: 'epic', epicEvents: [pending('c1:a')], ...epicOver };
    const deps: any = {
      getSession: vi.fn(() => epic),
      isBusy: vi.fn(() => false),
      gate: { refusal: vi.fn(() => undefined), record: vi.fn() },
      consume: vi.fn(),
      release: vi.fn(),
      send: vi.fn(async (_k: string, _t: string, opts: any) => {
        opts.onAccepted();
        await new Promise(() => {});
      }),
      logger: { info: vi.fn(), warn: vi.fn() },
      now: () => 42,
      retryMs: 10,
      ...over,
    };
    return { epic, deps, waker: createSlackEpicWaker(deps) };
  }

  it('W1 — an idle epic with pending ends wakes once: delivered first, then the fixed text into its thread', async () => {
    const w = wakerWorld();
    w.waker.wake('C1-1.0');
    await tick();
    expect(w.deps.consume).toHaveBeenCalledWith('C1-1.0', ['c1:a'], 'wake:42');
    expect(w.deps.send).toHaveBeenCalledWith(
      'C1-1.0',
      'Epic wake: 1 event — login:finished. Read details with child_status.',
      expect.objectContaining({ label: '🧩 자식 작업 소식' }),
    );
    expect(w.deps.consume.mock.invocationCallOrder[0]).toBeLessThan(w.deps.send.mock.invocationCallOrder[0]);
    for (const [over, epicOver] of [
      [{ isBusy: vi.fn(() => true) }, {}],
      [{}, { plan: { nodes: [], done: { by: 'epic', at: 1 } } }],
      [{}, { epicEvents: [] }],
      [{}, { slackless: true }],
      [{}, { closing: true }],
    ] as const) {
      const quiet = wakerWorld(over, epicOver);
      quiet.waker.wake('C1-1.0');
      await tick();
      expect(quiet.deps.send).not.toHaveBeenCalled();
    }
  });

  it('W2 — a wake that was not taken puts the events back and retries once', async () => {
    const send = vi.fn(async () => undefined);
    const w = wakerWorld({ send });
    w.waker.wake('C1-1.0');
    await tick();
    await tick();
    expect(w.deps.release).toHaveBeenCalledWith('C1-1.0', 'wake:42');
    await new Promise((r) => setTimeout(r, 30));
    expect(send).toHaveBeenCalledTimes(2);
    await new Promise((r) => setTimeout(r, 30));
    // The retry's own failure arms nothing more.
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('W3 — the tree’s limits refuse a wake: nothing delivered, nothing sent, one retry', async () => {
    const refusal = vi.fn(() => 'this epic reached its cost limit ($50)');
    const w = wakerWorld({ gate: { refusal, record: vi.fn() } });
    w.waker.wake('C1-1.0');
    await tick();
    expect(w.deps.consume).not.toHaveBeenCalled();
    expect(w.deps.send).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 30));
    expect(refusal).toHaveBeenCalledTimes(2);
  });
});
