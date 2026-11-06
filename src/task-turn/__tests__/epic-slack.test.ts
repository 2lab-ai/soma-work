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
/** The instruction reply under a child's header root (#955): posted at once in the tests that hold the root post. */
const reply = () => Promise.resolve({ ts: '9.95' });

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
        // The owner's word, delegated (as instruct_child's): only the epic's own wake is a host turn.
        routeContext: { skipAutoBotThread: true, verbatimPrompt: true },
      }),
    );
    // The reservation counted before the thread; the start counted in the tree's window.
    expect(w.deps.reserveEpicChild.mock.invocationCallOrder[0]).toBeLessThan(
      w.deps.postMessage.mock.invocationCallOrder[0],
    );
    expect(w.deps.gate.record).toHaveBeenCalledWith(w.epic);
  });

  it('H11 — #955: the child’s thread opens on the thread header panel, as a dashboard or Slack-started task', async () => {
    const w = hostWorld();
    w.epic.ownerName = 'Zhuge';
    await w.host.spawnChild(w.epic, { planNodeId: 'login', instruction: '로그인 고쳐', title: '로그인' });
    const [channel, text, blocks, threadTs] = w.deps.postMessage.mock.calls[0];
    expect([channel, threadTs]).toEqual(['C1', undefined]);
    // The header (ThreadHeaderBuilder, default theme): the node's title, the owner — not the instruction.
    expect(blocks[0]).toMatchObject({ type: 'header', text: { text: '로그인' } });
    expect(JSON.stringify(blocks)).toContain('<@U1>');
    expect(JSON.stringify(blocks)).not.toContain('로그인 고쳐');
    expect(text).toBe('로그인\nZhuge');
  });

  it('H12 — #955: the instruction, with its epic, is the thread’s first reply, before the run', async () => {
    const w = hostWorld();
    await w.host.spawnChild(w.epic, { planNodeId: 'login', instruction: '로그인 고쳐', title: '로그인' });
    expect(w.deps.postMessage).toHaveBeenCalledTimes(2);
    const [channel, , blocks, threadTs] = w.deps.postMessage.mock.calls[1];
    expect([channel, threadTs]).toEqual(['C1', '9.9']);
    expect(JSON.stringify(blocks)).toContain('로그인 고쳐');
    expect(JSON.stringify(blocks)).toContain('로그인 에픽');
    expect(w.deps.postMessage.mock.invocationCallOrder[1]).toBeLessThan(
      w.deps.handleMessage.mock.invocationCallOrder[0],
    );
  });

  it('H13 — #955: the first instruction says its root is the bot’s header, so the child is born bot-initiated', async () => {
    const w = hostWorld();
    await w.host.spawnChild(w.epic, { planNodeId: 'login', instruction: '로그인 고쳐', title: '로그인' });
    expect(w.deps.handleMessage.mock.calls[0][0]).toMatchObject({ thread_ts: '9.9', ts: '9.9', botThreadRoot: true });
  });

  it('H14 — #955: the instruction reply failing does not stop the child', async () => {
    const w = hostWorld({
      postMessage: vi.fn(async (...a: any[]) => {
        if (a[3]) throw new Error('rate_limited');
        return { ts: '9.9' };
      }),
    });
    const r = await w.host.spawnChild(w.epic, { planNodeId: 'login', instruction: '로그인 고쳐', title: '로그인' });
    expect(r).toEqual({ ok: true, childId: 'child-1', started: true });
    expect(w.deps.handleMessage.mock.calls[0][0]).toMatchObject({ text: '로그인 고쳐', botThreadRoot: true });
  });

  it('H15 — #955 review (astra P2): a stalled instruction reply is waited for at most replyTimeoutMs, then the child starts', async () => {
    const w = hostWorld({
      replyTimeoutMs: 10,
      postMessage: vi.fn((...a: any[]) => (a[3] ? new Promise(() => {}) : Promise.resolve({ ts: '9.9' }))),
    });
    const r = await w.host.spawnChild(w.epic, { planNodeId: 'login', instruction: '로그인 고쳐', title: '로그인' });
    expect(r).toEqual({ ok: true, childId: 'child-1', started: true });
    expect(w.deps.handleMessage).toHaveBeenCalledTimes(1);
    expect(w.deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('instruction reply'),
      expect.objectContaining({ childId: 'child-1' }),
    );
  }, 2000);

  it('H6 — parallel spawns (review #872): one child per node while it is made; the ones being made take places', async () => {
    let post!: (v: { ts: string }) => void;
    const w = hostWorld({ postMessage: vi.fn((...a: any[]) => (a[3] ? reply() : new Promise((r) => (post = r)))) });
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

  it('H7 — parallel spawns into one folder (review #872 astra 6): the second is refused while the first is made', async () => {
    const posts: Array<(v: { ts: string }) => void> = [];
    const w = hostWorld({ postMessage: vi.fn((...a: any[]) => (a[3] ? reply() : new Promise((r) => posts.push(r)))) });
    const first = w.host.spawnChild(w.epic, {
      planNodeId: 'login',
      instruction: 'go',
      title: 't',
      workingDirectory: '/tmp/U1/session_e/work',
    });
    expect(
      await w.host.spawnChild(w.epic, {
        planNodeId: 'signup',
        instruction: 'go',
        title: 't',
        workingDirectory: '/tmp/U1/session_e/work/sub',
      }),
    ).toMatchObject({ ok: false, code: 'folder-overlap' });
    // Another folder is fine.
    const other = w.host.spawnChild(w.epic, {
      planNodeId: 'billing',
      instruction: 'go',
      title: 't',
      workingDirectory: '/tmp/U1/session_e/billing',
    });
    expect(posts).toHaveLength(2);
    posts[0]({ ts: '9.9' });
    posts[1]({ ts: '9.8' });
    expect(await first).toMatchObject({ ok: true });
    expect(await other).toMatchObject({ ok: true });
  });

  it('H8 — parallel instructions to idle children (review #872 R2 astra): a child being started holds its place and its folder', async () => {
    let accept!: () => void;
    const c2: any = { taskId: 'c2', ownerId: 'U1', channelId: 'C1', threadTs: '3.0', parentTaskId: 'e1' };
    const w = hostWorld({
      sendToThread: vi.fn((_k: string, _t: string, opts: any) => {
        accept = opts.onAccepted;
        return new Promise(() => {});
      }),
    });
    const first = w.host.instructChild(w.epic, w.child, 'go');
    // Its echo is posting: not running yet, but it is being started.
    expect(w.host.isRunning(w.child)).toBe(true);
    w.host.admit(w.epic, { child: c2 });
    expect(w.deps.gate.refusal).toHaveBeenLastCalledWith(w.epic, { child: c2, making: 1 });
    accept();
    await first;
    expect(w.host.isRunning(w.child)).toBe(false);
    w.host.admit(w.epic, { child: c2 });
    expect(w.deps.gate.refusal).toHaveBeenLastCalledWith(w.epic, { child: c2, making: 0 });
  });

  it('H9 — an idle child in the folder a child being made takes is not started (review #872 R2 astra)', async () => {
    const posts: Array<(v: { ts: string }) => void> = [];
    const w = hostWorld({ postMessage: vi.fn((...a: any[]) => (a[3] ? reply() : new Promise((r) => posts.push(r)))) });
    const making = w.host.spawnChild(w.epic, {
      planNodeId: 'login',
      instruction: 'go',
      title: 't',
      workingDirectory: '/tmp/U1/session_e/svc',
    });
    const idle = { ...w.child, sessionWorkingDir: '/tmp/U1/session_e/svc' };
    expect(await w.host.instructChild(w.epic, idle, 'more')).toMatchObject({
      taken: false,
      reason: expect.stringMatching(/folder/),
    });
    expect(w.deps.sendToThread).not.toHaveBeenCalled();
    // A child in another folder is not held back.
    const other = { ...w.child, sessionWorkingDir: '/tmp/U1/session_e/web' };
    expect(await w.host.instructChild(w.epic, other, 'more')).toMatchObject({ taken: true });
    posts[0]({ ts: '9.9' });
    await making;
  });

  it('H10 — a working child’s queued instruction still being handed over counts in the window (review #872 R2 astra)', async () => {
    const w = hostWorld({ isRunning: vi.fn(() => true), sendToThread: vi.fn(() => new Promise(() => {})) });
    void w.host.instructChild(w.epic, w.child, 'more');
    // Another instruction to the same working child: no running place, but one start in flight.
    w.host.admit(w.epic, { child: w.child });
    expect(w.deps.gate.refusal).toHaveBeenLastCalledWith(w.epic, { child: w.child, pending: 1 });
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
    // The epic's word to its child answers the child's open question (the tool says so): the owner's word.
    expect(idle.deps.sendToThread.mock.calls[0][2].hostTurn).toBeUndefined();
    expect(idle.deps.gate.record).toHaveBeenCalledTimes(1);

    const busy = hostWorld({ isRunning: vi.fn(() => true) });
    expect(await busy.host.instructChild(busy.epic, busy.child, '이것도')).toEqual({ taken: true, queued: true });
    // Queued behind the turn in flight: it will start a turn — counted in the tree's window too (review #872 astra 7).
    expect(busy.deps.gate.record).toHaveBeenCalledTimes(1);

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
      // The epic's own wake is soma-work's word: it answers no question the epic asked its owner (review #872).
      expect.objectContaining({ label: '🧩 자식 작업 소식', hostTurn: true }),
    );
    expect(w.deps.consume.mock.invocationCallOrder[0]).toBeLessThan(w.deps.send.mock.invocationCallOrder[0]);
    for (const [over, epicOver] of [
      [{ isBusy: vi.fn(() => true) }, {}],
      [{}, { plan: { nodes: [], done: { by: 'epic', at: 1 } } }],
      [{}, { epicEvents: [] }],
      [{}, { closing: true }],
    ] as const) {
      const quiet = wakerWorld(over, epicOver);
      quiet.waker.wake('C1-1.0');
      await tick();
      expect(quiet.deps.send).not.toHaveBeenCalled();
    }
  });

  it('W4 — the epic’s chain end settles its wakes, keeping one still being sent (review #872 R2 grok)', async () => {
    const settle = vi.fn();
    const w = wakerWorld({
      settle,
      // The echo is posting: not taken yet.
      send: vi.fn(() => new Promise(() => {})),
    });
    w.waker.wake('C1-1.0');
    await tick();
    expect(w.deps.consume).toHaveBeenCalledWith('C1-1.0', ['c1:a'], 'wake:42');
    w.waker.chainEnded('C1-1.0');
    expect(settle).toHaveBeenCalledWith('C1-1.0', 'wake:42');
    // With nothing being sent, every wake that ran is settled.
    const idle = wakerWorld({ settle: vi.fn(), epicEvents: [] } as any);
    idle.waker.chainEnded('C1-1.0');
    expect(idle.deps.settle).toHaveBeenCalledWith('C1-1.0', undefined);
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
