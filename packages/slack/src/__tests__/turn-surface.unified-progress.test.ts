import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskListBlockBuilder, type Todo } from '../task-list-block-builder';
import { TurnSurface } from '../turn-surface';

/**
 * U10a — native task/plan stream integration (+ A11 interruption marker).
 *
 * Before U10a the turn had TWO progress surfaces: the B1 stream message
 * (text chunks) and a separate B2 `chat.postMessage` plan card. Slack's
 * streaming API can render the task list *inside* the stream message when the
 * stream is opened with `task_display_mode: 'plan'` and fed
 * `plan_update` / `task_update` chunks, so the second message is redundant
 * noise the user has to reconcile against the first.
 *
 * These tests lock the unified contract:
 *   - `chat.startStream` opts into plan display
 *   - task snapshots ride the EXISTING stream ts as chunks — no postMessage
 *   - text + tasks share one ts and cannot reorder
 *   - unchanged snapshots don't spend a write
 *   - the end-of-turn `in_progress` → `pending` demotion happens on the
 *     native surface too, and strictly before `chat.stopStream`
 *   - an explicit Slack rejection (not a transport blip) falls back to the
 *     legacy plan message without losing tasks or the text stream
 *   - a task update that arrives after the turn closed writes nothing
 *   - A11: `user-interrupted` is stamped on the turn's OWN surface, once
 */

interface MockClient {
  chat: {
    startStream: ReturnType<typeof vi.fn>;
    appendStream: ReturnType<typeof vi.fn>;
    stopStream: ReturnType<typeof vi.fn>;
    postMessage: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
}

function makeSlackApi(client: MockClient) {
  return {
    getClient: vi.fn().mockReturnValue(client),
    updateMessage: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function makeClient(overrides?: Partial<MockClient['chat']>): MockClient {
  return {
    chat: {
      startStream: vi.fn().mockResolvedValue({ ts: 'stream-ts-1' }),
      appendStream: vi.fn().mockResolvedValue(undefined),
      stopStream: vi.fn().mockResolvedValue(undefined),
      postMessage: vi.fn().mockResolvedValue({ ts: 'plan-ts-default' }),
      update: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    },
  };
}

const TODOS: Todo[] = [
  { id: '1', content: 'done task', status: 'completed', priority: 'high' },
  { id: '2', content: 'running task', status: 'in_progress', priority: 'high' },
  { id: '3', content: 'waiting task', status: 'pending', priority: 'medium' },
];

/** All `chat.appendStream` payloads that carried at least one task_update. */
function taskAppends(client: MockClient): any[] {
  return client.chat.appendStream.mock.calls
    .map((call: any[]) => call[0])
    .filter((args: any) => (args?.chunks ?? []).some((c: any) => c.type === 'task_update'));
}

/** Poll a predicate on REAL timers (used by the write-ordering test). */
async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil: condition never became true');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** All `chat.appendStream` payloads that carried a markdown_text chunk. */
function textAppends(client: MockClient): any[] {
  return client.chat.appendStream.mock.calls
    .map((call: any[]) => call[0])
    .filter((args: any) => (args?.chunks ?? []).some((c: any) => c.type === 'markdown_text'));
}

describe('TaskListBlockBuilder.buildTaskChunks (U10a chunk payload)', () => {
  it('maps effective status onto the Slack task_update enum and titles each row', () => {
    const { title, tasks } = TaskListBlockBuilder.buildTaskChunks(TODOS);

    expect(title).toBe('Tasks (3)');
    expect(tasks).toEqual([
      { type: 'task_update', id: '1', title: 'done task', status: 'complete' },
      { type: 'task_update', id: '2', title: 'running task', status: 'in_progress' },
      { type: 'task_update', id: '3', title: 'waiting task', status: 'pending' },
    ]);
  });

  it('final=true demotes in_progress to pending and never promotes to complete', () => {
    const { tasks } = TaskListBlockBuilder.buildTaskChunks(TODOS, true);

    expect(tasks.filter((t) => t.status === 'in_progress')).toEqual([]);
    // The unfinished row stays visible as pending — demote, never promote.
    expect(tasks.find((t) => t.id === '2')?.status).toBe('pending');
    expect(tasks.filter((t) => t.status === 'complete').map((t) => t.id)).toEqual(['1']);
  });

  it('blocked (pending with an unmet dependency) collapses to pending, matching the plan card', () => {
    const blockedTodos: Todo[] = [
      { id: 'a', content: 'first', status: 'pending', priority: 'high' },
      { id: 'b', content: 'second', status: 'pending', priority: 'high', dependencies: ['a'] },
    ];
    const { tasks } = TaskListBlockBuilder.buildTaskChunks(blockedTodos);
    expect(tasks.map((t) => t.status)).toEqual(['pending', 'pending']);
  });

  it('truncates only the displayed title and does not mutate the source todos', () => {
    const long = 'x'.repeat(200);
    const source: Todo[] = [{ id: 'long', content: long, status: 'pending', priority: 'low' }];
    const { tasks } = TaskListBlockBuilder.buildTaskChunks(source);

    expect(tasks[0].title.length).toBeLessThan(long.length);
    expect(tasks[0].title.endsWith('…')).toBe(true);
    // Raw snapshot preserved for every other consumer.
    expect(source[0].content).toBe(long);
    expect(source[0].status).toBe('pending');
  });

  it('falls back to a positional id when the todo has none (stable chunk identity)', () => {
    const { tasks } = TaskListBlockBuilder.buildTaskChunks([
      { id: '', content: 'no id', status: 'pending', priority: 'low' },
    ] as Todo[]);
    expect(tasks[0].id).toBe('todo-1');
  });

  it('returns an empty payload for an empty snapshot', () => {
    expect(TaskListBlockBuilder.buildTaskChunks([])).toEqual({ title: '', tasks: [] });
  });

  // Review round 1: the chunk path capped titles at 80 while the plan card
  // emitted raw content, so one todo could appear under two different names
  // depending on which surface rendered it (and which surface the user was
  // looking at after a fallback). Both now go through one display builder.
  it('plan card and stream chunk show the SAME title for the same todo', () => {
    const long = `${'y'.repeat(120)} tail`;
    const source: Todo[] = [
      { id: 'a', content: long, status: 'in_progress', priority: 'high' },
      { id: 'b', content: 'short one', status: 'pending', priority: 'low' },
    ];

    const { tasks } = TaskListBlockBuilder.buildTaskChunks(source);
    const { blocks } = TaskListBlockBuilder.buildPlanTasks(source);
    const cards = blocks.find((b: any) => b.type === 'plan').tasks;

    expect(cards.map((c: any) => c.title)).toEqual(tasks.map((t) => t.title));
    expect(tasks[0].title.endsWith('…')).toBe(true);
    // Source content is untouched on both paths.
    expect(source[0].content).toBe(long);
  });
});

describe('TurnSurface — U10a native task stream', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('stream opening', () => {
    it("startStream requests task_display_mode 'plan' so task chunks render as a plan card", async () => {
      const client = makeClient();
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      const ctx = { channelId: 'C1', threadTs: 't1', sessionKey: 'C1:t1', turnId: 'C1:t1:mode' };
      await surface.begin(ctx);
      await surface.end(ctx.turnId, 'completed');

      expect(client.chat.startStream).toHaveBeenCalledTimes(1);
      expect(client.chat.startStream.mock.calls[0][0]).toMatchObject({
        channel: 'C1',
        thread_ts: 't1',
        task_display_mode: 'plan',
      });
    });
  });

  describe('task rendering on an existing stream', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('sends task chunks on the open stream instead of posting a B2 plan message', async () => {
      const client = makeClient();
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      const ctx = { channelId: 'C1', threadTs: 't1', sessionKey: 'C1:t1', turnId: 'C1:t1:native' };
      await surface.begin(ctx);
      await expect(surface.renderTasks(ctx.turnId, TODOS)).resolves.toBe(true);
      await vi.advanceTimersByTimeAsync(500);

      // No second message — the whole point of U10a.
      expect(client.chat.postMessage).not.toHaveBeenCalled();
      expect(client.chat.update).not.toHaveBeenCalled();

      const appends = taskAppends(client);
      expect(appends.length).toBe(1);
      expect(appends[0]).toMatchObject({ channel: 'C1', ts: 'stream-ts-1' });
      // plan_update carries the title, task_update rows carry the statuses —
      // plan title first so the card header exists before its rows.
      expect(appends[0].chunks[0]).toEqual({ type: 'plan_update', title: 'Tasks (3)' });
      expect(appends[0].chunks.slice(1)).toEqual([
        { type: 'task_update', id: '1', title: 'done task', status: 'complete' },
        { type: 'task_update', id: '2', title: 'running task', status: 'in_progress' },
        { type: 'task_update', id: '3', title: 'waiting task', status: 'pending' },
      ]);

      await surface.end(ctx.turnId, 'completed');
    });

    it('text and tasks share ONE ts (single surface, no mixed top-level markdown_text)', async () => {
      const client = makeClient();
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      const ctx = { channelId: 'C1', threadTs: 't1', sessionKey: 'C1:t1', turnId: 'C1:t1:mixed' };
      await surface.begin(ctx);
      await surface.appendText(ctx.turnId, 'thinking…');
      await surface.renderTasks(ctx.turnId, TODOS);
      await vi.advanceTimersByTimeAsync(500);
      await surface.appendText(ctx.turnId, 'answer');
      await surface.end(ctx.turnId, 'completed');

      const allAppends = client.chat.appendStream.mock.calls.map((c: any[]) => c[0]);
      expect(allAppends.length).toBeGreaterThanOrEqual(3);
      for (const args of allAppends) {
        expect(args.ts).toBe('stream-ts-1');
        // chunks mode only — a top-level markdown_text alongside chunks is
        // rejected by Slack (streaming_mode_mismatch).
        expect(args.markdown_text).toBeUndefined();
        expect(Array.isArray(args.chunks)).toBe(true);
      }
      expect(client.chat.postMessage).not.toHaveBeenCalled();
      expect(client.chat.stopStream).toHaveBeenCalledWith({ channel: 'C1', ts: 'stream-ts-1', chunks: [] });
    });

    it('an unchanged todos snapshot does not spend a second write', async () => {
      const client = makeClient();
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      const ctx = { channelId: 'C1', threadTs: 't1', sessionKey: 'C1:t1', turnId: 'C1:t1:dedup' };
      await surface.begin(ctx);

      await surface.renderTasks(ctx.turnId, TODOS);
      await vi.advanceTimersByTimeAsync(500);
      // Same snapshot again (TodoWrite re-emits the full list on every tick),
      // in a separate debounce window so the debouncer cannot mask it.
      await surface.renderTasks(ctx.turnId, [...TODOS]);
      await vi.advanceTimersByTimeAsync(500);
      await surface.renderTasks(ctx.turnId, [...TODOS]);
      await vi.advanceTimersByTimeAsync(500);

      expect(taskAppends(client).length).toBe(1);
      expect(client.chat.postMessage).not.toHaveBeenCalled();

      // A real change still writes.
      const advanced = TODOS.map((t) => (t.id === '2' ? { ...t, status: 'completed' as const } : t));
      await surface.renderTasks(ctx.turnId, advanced);
      await vi.advanceTimersByTimeAsync(500);
      expect(taskAppends(client).length).toBe(2);

      await surface.end(ctx.turnId, 'completed');
    });

    it('writes are serialized: task chunks, text and stopStream never reorder', async () => {
      // Real timers here: the assertion needs the debounced render to be
      // genuinely IN FLIGHT (parked inside Slack) before the racing text
      // append is issued, and a fake-timer advance cannot be suspended
      // mid-callback without deadlocking on the gate below.
      vi.useRealTimers();

      // Slow the first append so a naive implementation would let the later
      // text chunk (and then stopStream) overtake it.
      let releaseFirst: () => void = () => {};
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let appendCount = 0;
      const client = makeClient({
        appendStream: vi.fn().mockImplementation(async () => {
          appendCount += 1;
          if (appendCount === 1) await firstGate;
          return undefined;
        }),
      });
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      const ctx = { channelId: 'C1', threadTs: 't1', sessionKey: 'C1:t1', turnId: 'C1:t1:order' };
      await surface.begin(ctx);

      // Kick off a slow task render, let it reach Slack (where it hangs on
      // the gate), then issue a text append + close without awaiting it.
      await surface.renderTasks(ctx.turnId, TODOS);
      await waitUntil(() => client.chat.appendStream.mock.calls.length === 1);

      const textPromise = surface.appendText(ctx.turnId, 'streamed answer');
      releaseFirst();
      await textPromise;
      await surface.end(ctx.turnId, 'completed');

      const appendOrder = client.chat.appendStream.mock.invocationCallOrder;
      const stopOrder = client.chat.stopStream.mock.invocationCallOrder;
      // Task chunk first (it was enqueued first), text after, stop last.
      expect(client.chat.appendStream.mock.calls[0][0].chunks[0].type).toBe('plan_update');
      expect(appendOrder[0]).toBeLessThan(appendOrder[1]);
      expect(Math.max(...appendOrder)).toBeLessThan(stopOrder[0]);
    });

    it('final demotion lands on the native surface BEFORE stopStream', async () => {
      const client = makeClient();
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      const ctx = { channelId: 'C1', threadTs: 't1', sessionKey: 'C1:t1', turnId: 'C1:t1:final' };
      await surface.begin(ctx);
      await surface.renderTasks(ctx.turnId, TODOS);
      await vi.advanceTimersByTimeAsync(500);

      // Turn ends while todo #2 is still in_progress.
      await surface.end(ctx.turnId, 'completed');

      const appends = taskAppends(client);
      expect(appends.length).toBe(2);
      const finalChunks = appends[1].chunks;
      expect(finalChunks.filter((c: any) => c.status === 'in_progress')).toEqual([]);
      expect(finalChunks.find((c: any) => c.id === '2')).toMatchObject({ status: 'pending' });
      // …and it must precede the close, or Slack drops it.
      const lastAppendOrder = Math.max(...client.chat.appendStream.mock.invocationCallOrder);
      expect(lastAppendOrder).toBeLessThan(client.chat.stopStream.mock.invocationCallOrder[0]);
      // Still no B2 message anywhere on the turn.
      expect(client.chat.postMessage).not.toHaveBeenCalled();
    });

    it('all-terminal todos need no finalize write on close', async () => {
      const client = makeClient();
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      const done = TODOS.map((t) => ({ ...t, status: 'completed' as const }));
      const ctx = { channelId: 'C1', threadTs: 't1', sessionKey: 'C1:t1', turnId: 'C1:t1:alldone' };
      await surface.begin(ctx);
      await surface.renderTasks(ctx.turnId, done);
      await vi.advanceTimersByTimeAsync(500);
      await surface.end(ctx.turnId, 'completed');

      expect(taskAppends(client).length).toBe(1);
    });

    it('fail()/supersede also demotes the native task list', async () => {
      const client = makeClient({
        startStream: vi.fn().mockResolvedValueOnce({ ts: 'stream-A' }).mockResolvedValueOnce({ ts: 'stream-B' }),
      });
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      const sessionKey = 'C1:t1';
      const ctxA = { channelId: 'C1', threadTs: 't1', sessionKey, turnId: 'C1:t1:A' };
      const ctxB = { channelId: 'C1', threadTs: 't1', sessionKey, turnId: 'C1:t1:B' };

      await surface.begin(ctxA);
      await surface.renderTasks(ctxA.turnId, TODOS);
      await vi.advanceTimersByTimeAsync(500);
      await surface.begin(ctxB);

      const againstA = taskAppends(client).filter((args) => args.ts === 'stream-A');
      expect(againstA.length).toBe(2);
      expect(againstA[1].chunks.filter((c: any) => c.status === 'in_progress')).toEqual([]);

      await surface.end(ctxB.turnId, 'completed');
    });

    it('a task update arriving after the turn closed writes nothing and opens no new surface', async () => {
      const client = makeClient();
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      const ctx = { channelId: 'C1', threadTs: 't1', sessionKey: 'C1:t1', turnId: 'C1:t1:late' };
      await surface.begin(ctx);
      await surface.renderTasks(ctx.turnId, TODOS);
      await vi.advanceTimersByTimeAsync(500);
      await surface.end(ctx.turnId, 'completed');

      const appendsBefore = client.chat.appendStream.mock.calls.length;
      const stopsBefore = client.chat.stopStream.mock.calls.length;

      // Late TodoWrite for the finished turn — with ctx, so the pre-U10a
      // ad-hoc path would have posted a brand new plan message.
      await expect(
        surface.renderTasks(ctx.turnId, TODOS, { channelId: 'C1', threadTs: 't1', sessionKey: 'C1:t1' }),
      ).resolves.toBe(false);
      await vi.advanceTimersByTimeAsync(500);

      expect(client.chat.postMessage).not.toHaveBeenCalled();
      expect(client.chat.appendStream.mock.calls.length).toBe(appendsBefore);
      expect(client.chat.stopStream.mock.calls.length).toBe(stopsBefore);
      expect(surface._getTurnStateSnapshot(ctx.turnId)).toBeUndefined();
    });

    it('a late task update is never redirected onto the session’s newer turn', async () => {
      const client = makeClient({
        startStream: vi.fn().mockResolvedValueOnce({ ts: 'stream-A' }).mockResolvedValueOnce({ ts: 'stream-B' }),
      });
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      const sessionKey = 'C1:t1';
      const ctxA = { channelId: 'C1', threadTs: 't1', sessionKey, turnId: 'C1:t1:oldA' };
      const ctxB = { channelId: 'C1', threadTs: 't1', sessionKey, turnId: 'C1:t1:newB' };

      await surface.begin(ctxA);
      await surface.begin(ctxB); // supersede closes A
      client.chat.appendStream.mockClear();

      await expect(
        surface.renderTasks(ctxA.turnId, TODOS, { channelId: 'C1', threadTs: 't1', sessionKey }),
      ).resolves.toBe(false);
      await vi.advanceTimersByTimeAsync(500);

      expect(client.chat.appendStream).not.toHaveBeenCalled();
      expect(client.chat.postMessage).not.toHaveBeenCalled();

      await surface.end(ctxB.turnId, 'completed');
    });

    it('renderTasks before begin() (no stream) keeps the legacy plan-message path', async () => {
      const client = makeClient({ postMessage: vi.fn().mockResolvedValue({ ts: 'plan-ts-adhoc' }) });
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      await expect(
        surface.renderTasks('adhoc-turn', TODOS, { channelId: 'C2', threadTs: 't2', sessionKey: 'C2:t2' }),
      ).resolves.toBe(true);
      await vi.advanceTimersByTimeAsync(500);

      expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
      const planBlock = client.chat.postMessage.mock.calls[0][0].blocks.find((b: any) => b.type === 'plan');
      expect(planBlock.tasks.length).toBe(3);
      expect(client.chat.appendStream).not.toHaveBeenCalled();

      await surface.end('adhoc-turn', 'completed');
    });
  });

  describe('native-unsupported fallback', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    /** appendStream that rejects ONLY task chunks with an explicit Slack error. */
    function rejectTaskChunks(code: string) {
      return vi.fn().mockImplementation(async (args: any) => {
        if ((args?.chunks ?? []).some((c: any) => c.type === 'task_update')) {
          throw Object.assign(new Error('nope'), { data: { error: code } });
        }
        return undefined;
      });
    }

    it('explicit rejection falls back to the plan message with the tasks intact, and keeps the text stream alive', async () => {
      const client = makeClient({
        appendStream: rejectTaskChunks('invalid_blocks'),
        postMessage: vi.fn().mockResolvedValue({ ts: 'plan-ts-fb' }),
      });
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });
      const warnSpy = vi.fn();
      (surface as any).logger.warn = warnSpy;

      const ctx = { channelId: 'C1', threadTs: 't1', sessionKey: 'C1:t1', turnId: 'C1:t1:fb' };
      await surface.begin(ctx);
      await surface.renderTasks(ctx.turnId, TODOS);
      await vi.advanceTimersByTimeAsync(500);

      // Tasks stayed visible — as a plan card, with every row preserved.
      expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
      const planBlock = client.chat.postMessage.mock.calls[0][0].blocks.find((b: any) => b.type === 'plan');
      expect(planBlock.tasks.map((t: any) => t.title)).toEqual(['done task', 'running task', 'waiting task']);
      // Operators get told, not silently degraded.
      expect(warnSpy.mock.calls.some(([msg]) => String(msg).includes('native task chunks rejected'))).toBe(true);

      // Text streaming must NOT be disabled by a task-chunk rejection.
      await expect(surface.appendText(ctx.turnId, 'still streaming')).resolves.toBe(true);
      expect(textAppends(client).length).toBe(1);

      // Subsequent renders go straight to the plan message (chat.update),
      // without re-probing the refused native surface.
      const appendsAfterFallback = client.chat.appendStream.mock.calls.length;
      const advanced = TODOS.map((t) => (t.id === '2' ? { ...t, status: 'completed' as const } : t));
      await surface.renderTasks(ctx.turnId, advanced);
      await vi.advanceTimersByTimeAsync(500);
      expect(client.chat.update).toHaveBeenCalledTimes(1);
      expect(client.chat.appendStream.mock.calls.length).toBe(appendsAfterFallback);
      expect(client.chat.postMessage).toHaveBeenCalledTimes(1);

      await surface.end(ctx.turnId, 'completed');
      // Final demotion still lands — on the fallback surface.
      const planUpdates = client.chat.update.mock.calls.filter((c: any[]) => c[0]?.ts === 'plan-ts-fb');
      expect(planUpdates.length).toBeGreaterThanOrEqual(1);
    });

    it('an ambiguous transport failure does NOT post a duplicate plan message', async () => {
      // No Slack error code → the write may well have been applied. Posting
      // a plan card now would show the same task list twice.
      const client = makeClient({
        appendStream: vi.fn().mockImplementation(async (args: any) => {
          if ((args?.chunks ?? []).some((c: any) => c.type === 'task_update')) {
            throw new Error('socket hang up');
          }
          return undefined;
        }),
      });
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      const ctx = { channelId: 'C1', threadTs: 't1', sessionKey: 'C1:t1', turnId: 'C1:t1:amb' };
      await surface.begin(ctx);
      await surface.renderTasks(ctx.turnId, TODOS);
      await vi.advanceTimersByTimeAsync(500);

      expect(client.chat.postMessage).not.toHaveBeenCalled();
      expect(client.chat.update).not.toHaveBeenCalled();

      // Next render retries the same chunk ids on the same stream (Slack
      // merges by id) rather than opening a second surface.
      await surface.renderTasks(ctx.turnId, TODOS);
      await vi.advanceTimersByTimeAsync(500);
      expect(taskAppends(client).length).toBe(2);
      expect(client.chat.postMessage).not.toHaveBeenCalled();

      await surface.end(ctx.turnId, 'completed');
    });

    it('a rate-limited task write is treated as ambiguous (no duplicate surface)', async () => {
      const client = makeClient({ appendStream: rejectTaskChunks('ratelimited') });
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      const ctx = { channelId: 'C1', threadTs: 't1', sessionKey: 'C1:t1', turnId: 'C1:t1:rl' };
      await surface.begin(ctx);
      await surface.renderTasks(ctx.turnId, TODOS);
      await vi.advanceTimersByTimeAsync(500);

      expect(client.chat.postMessage).not.toHaveBeenCalled();
      await surface.end(ctx.turnId, 'completed');
    });

    // ─────────────────────────────────────────────────────────────────────
    // Review round 1 — REAL @slack/web-api error shapes.
    //
    // The SDK stamps `err.code` on pure transport failures
    // (`WebAPIRequestError`, `WebAPIHTTPError`, `WebAPIRateLimitedError`)
    // and those objects carry NO `data.error`; only `WebAPIPlatformError`
    // — an actual 200-OK body saying "I refused this" — does. Classifying
    // off `err.code` therefore read every socket hang-up as a rejection and
    // posted a duplicate plan card for a write that may well have landed.
    // ─────────────────────────────────────────────────────────────────────
    /** `err.code` set, `data` absent — exactly what the SDK throws. */
    function sdkTransportError(code: string, extra?: Record<string, unknown>) {
      return Object.assign(new Error(code), { code, ...extra });
    }

    it.each([
      {
        name: 'RequestError (socket)',
        err: () => sdkTransportError('slack_webapi_request_error', { original: new Error('ECONNRESET') }),
      },
      {
        name: 'HTTPError (5xx)',
        err: () =>
          sdkTransportError('slack_webapi_http_error', { statusCode: 503, statusMessage: 'Service Unavailable' }),
      },
      { name: 'RateLimitedError', err: () => sdkTransportError('slack_webapi_rate_limited_error', { retryAfter: 30 }) },
    ])('real SDK transport error $name → no fallback post and native stays enabled', async ({ err }) => {
      const thrown = err();
      const client = makeClient({
        appendStream: vi.fn().mockImplementation(async (args: any) => {
          if ((args?.chunks ?? []).some((c: any) => c.type === 'task_update')) throw thrown;
          return undefined;
        }),
      });
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      const ctx = { channelId: 'C1', threadTs: 't1', sessionKey: 'C1:t1', turnId: `C1:t1:${(thrown as any).code}` };
      await surface.begin(ctx);
      await surface.renderTasks(ctx.turnId, TODOS);
      await vi.advanceTimersByTimeAsync(500);

      // The write may have been applied server-side → never a second surface.
      expect(client.chat.postMessage).not.toHaveBeenCalled();
      expect(client.chat.update).not.toHaveBeenCalled();

      // And native must NOT be stickily disabled: the next render retries on
      // the stream rather than permanently degrading the turn.
      const advanced = TODOS.map((t) => (t.id === '2' ? { ...t, status: 'completed' as const } : t));
      await surface.renderTasks(ctx.turnId, advanced);
      await vi.advanceTimersByTimeAsync(500);
      expect(taskAppends(client).length).toBe(2);
      expect(client.chat.postMessage).not.toHaveBeenCalled();

      await surface.end(ctx.turnId, 'completed');
    });

    it('a real PlatformError (data.error) is still an explicit rejection → falls back', async () => {
      // WebAPIPlatformError shape: BOTH a transport-looking `code` AND the
      // platform body. The body is what decides.
      const platformErr = Object.assign(new Error('invalid_blocks'), {
        code: 'slack_webapi_platform_error',
        data: { ok: false, error: 'invalid_blocks' },
      });
      const client = makeClient({
        appendStream: vi.fn().mockImplementation(async (args: any) => {
          if ((args?.chunks ?? []).some((c: any) => c.type === 'task_update')) throw platformErr;
          return undefined;
        }),
        postMessage: vi.fn().mockResolvedValue({ ts: 'plan-ts-plat' }),
      });
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      const ctx = { channelId: 'C1', threadTs: 't1', sessionKey: 'C1:t1', turnId: 'C1:t1:plat' };
      await surface.begin(ctx);
      await surface.renderTasks(ctx.turnId, TODOS);
      await vi.advanceTimersByTimeAsync(500);

      expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
      const planBlock = client.chat.postMessage.mock.calls[0][0].blocks.find((b: any) => b.type === 'plan');
      expect(planBlock.tasks.length).toBe(3);

      await surface.end(ctx.turnId, 'completed');
    });

    it('a platform rate-limit body (data.error=ratelimited) stays ambiguous → no fallback', async () => {
      const client = makeClient({ appendStream: rejectTaskChunks('ratelimited') });
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      const ctx = { channelId: 'C1', threadTs: 't1', sessionKey: 'C1:t1', turnId: 'C1:t1:plat-rl' };
      await surface.begin(ctx);
      await surface.renderTasks(ctx.turnId, TODOS);
      await vi.advanceTimersByTimeAsync(500);

      expect(client.chat.postMessage).not.toHaveBeenCalled();
      // Not stickily disabled either.
      const advanced = TODOS.map((t) => (t.id === '3' ? { ...t, status: 'in_progress' as const } : t));
      await surface.renderTasks(ctx.turnId, advanced);
      await vi.advanceTimersByTimeAsync(500);
      expect(taskAppends(client).length).toBe(2);

      await surface.end(ctx.turnId, 'completed');
    });

    // ─────────────────────────────────────────────────────────────────────
    // Review round 1 — the close-only finalize must never invent a surface.
    // ─────────────────────────────────────────────────────────────────────
    it('a failed final demotion at close posts NO brand-new plan message', async () => {
      // Renders succeed natively for the whole turn; only the final
      // demotion write (during end()) is rejected. Pre-fix this fell through
      // to the plan path and, with no planTs, posted a fresh task card at
      // the exact moment the turn died.
      let seenTaskWrites = 0;
      const client = makeClient({
        appendStream: vi.fn().mockImplementation(async (args: any) => {
          if ((args?.chunks ?? []).some((c: any) => c.type === 'task_update')) {
            seenTaskWrites += 1;
            if (seenTaskWrites > 1) {
              throw Object.assign(new Error('nope'), {
                code: 'slack_webapi_platform_error',
                data: { ok: false, error: 'invalid_blocks' },
              });
            }
          }
          return undefined;
        }),
        postMessage: vi.fn().mockResolvedValue({ ts: 'plan-ts-should-not-exist' }),
      });
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });
      const warnSpy = vi.fn();
      (surface as any).logger.warn = warnSpy;

      const ctx = { channelId: 'C1', threadTs: 't1', sessionKey: 'C1:t1', turnId: 'C1:t1:closefail' };
      await surface.begin(ctx);
      await surface.renderTasks(ctx.turnId, TODOS);
      await vi.advanceTimersByTimeAsync(500);
      expect(taskAppends(client).length).toBe(1);

      await surface.end(ctx.turnId, 'completed');

      // No phantom card, no rewritten history — and never a fabricated
      // "all done" state.
      expect(client.chat.postMessage).not.toHaveBeenCalled();
      expect(client.chat.update).not.toHaveBeenCalled();
      // The failure is visible to operators instead.
      expect(warnSpy.mock.calls.some(([msg]) => String(msg).includes('no new plan message posted at close'))).toBe(
        true,
      );
      // The turn still closed cleanly.
      expect(client.chat.stopStream).toHaveBeenCalledTimes(1);
      expect(surface._getTurnStateSnapshot(ctx.turnId)).toBeUndefined();
    });

    it('a failed final demotion still UPDATES an existing plan message (fallback turns keep finalizing)', async () => {
      // Same failure, but this turn had already fallen back to a plan
      // message earlier. Updating an existing ts is not a new surface, so it
      // must still happen — otherwise fallback turns keep a stuck spinner.
      const client = makeClient({
        appendStream: rejectTaskChunks('invalid_blocks'),
        postMessage: vi.fn().mockResolvedValue({ ts: 'plan-ts-existing' }),
        update: vi.fn().mockResolvedValue(undefined),
      });
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      const ctx = { channelId: 'C1', threadTs: 't1', sessionKey: 'C1:t1', turnId: 'C1:t1:closeupd' };
      await surface.begin(ctx);
      await surface.renderTasks(ctx.turnId, TODOS);
      await vi.advanceTimersByTimeAsync(500);
      expect(client.chat.postMessage).toHaveBeenCalledTimes(1);

      await surface.end(ctx.turnId, 'completed');

      const updates = client.chat.update.mock.calls.filter((c: any[]) => c[0]?.ts === 'plan-ts-existing');
      expect(updates.length).toBe(1);
      const planBlock = updates[0][0].blocks.find((b: any) => b.type === 'plan');
      expect(planBlock.tasks.filter((t: any) => t.status === 'in_progress')).toEqual([]);
      expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    });
  });
});

// ---------------------------------------------------------------------------
// A11 — explicit user-interruption marker
// ---------------------------------------------------------------------------

describe('TurnSurface — A11 user-interrupted marker', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('markUserInterrupted appends the literal marker to the turn’s own stream, with no error decoration', async () => {
    const client = makeClient();
    const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

    const ctx = { channelId: 'C1', threadTs: 't1', sessionKey: 'C1:t1', turnId: 'C1:t1:int' };
    await surface.begin(ctx);
    await expect(surface.markUserInterrupted(ctx.turnId)).resolves.toBe(true);

    const appends = textAppends(client);
    expect(appends.length).toBe(1);
    expect(appends[0]).toMatchObject({ channel: 'C1', ts: 'stream-ts-1' });
    expect(appends[0].chunks).toEqual([{ type: 'markdown_text', text: 'user-interrupted' }]);

    await surface.end(ctx.turnId, 'user-interrupted');
  });

  it('is sticky: repeated calls and a following end("user-interrupted") stamp exactly one marker', async () => {
    const client = makeClient();
    const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

    const ctx = { channelId: 'C1', threadTs: 't1', sessionKey: 'C1:t1', turnId: 'C1:t1:int2' };
    await surface.begin(ctx);
    await expect(surface.markUserInterrupted(ctx.turnId)).resolves.toBe(true);
    await expect(surface.markUserInterrupted(ctx.turnId)).resolves.toBe(false);
    await surface.end(ctx.turnId, 'user-interrupted');

    const markers = textAppends(client).filter((a) => a.chunks[0].text === 'user-interrupted');
    expect(markers.length).toBe(1);
  });

  it('end("user-interrupted") alone stamps the marker before stopStream', async () => {
    const client = makeClient();
    const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

    const ctx = { channelId: 'C1', threadTs: 't1', sessionKey: 'C1:t1', turnId: 'C1:t1:int3' };
    await surface.begin(ctx);
    await surface.appendText(ctx.turnId, 'partial answer');
    await surface.end(ctx.turnId, 'user-interrupted');

    const markers = textAppends(client).filter((a) => a.chunks[0].text === 'user-interrupted');
    expect(markers.length).toBe(1);
    const lastAppend = Math.max(...client.chat.appendStream.mock.invocationCallOrder);
    expect(lastAppend).toBeLessThan(client.chat.stopStream.mock.invocationCallOrder[0]);
  });

  it('generic fail() and supersede do NOT stamp the marker', async () => {
    const client = makeClient({
      startStream: vi.fn().mockResolvedValueOnce({ ts: 'stream-A' }).mockResolvedValueOnce({ ts: 'stream-B' }),
    });
    const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

    const sessionKey = 'C1:t1';
    await surface.begin({ channelId: 'C1', threadTs: 't1', sessionKey, turnId: 'C1:t1:failA' });
    await surface.begin({ channelId: 'C1', threadTs: 't1', sessionKey, turnId: 'C1:t1:failB' }); // supersede
    await surface.fail('C1:t1:failB', new Error('boom'));

    expect(textAppends(client).filter((a) => a.chunks[0].text === 'user-interrupted')).toEqual([]);
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  it('end("aborted") does not stamp the marker', async () => {
    const client = makeClient();
    const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

    const ctx = { channelId: 'C1', threadTs: 't1', sessionKey: 'C1:t1', turnId: 'C1:t1:abort' };
    await surface.begin(ctx);
    await surface.end(ctx.turnId, 'aborted');

    expect(textAppends(client)).toEqual([]);
  });

  it('with no stream, falls back to a plain post in the turn’s OWN channel/thread', async () => {
    const client = makeClient({ startStream: vi.fn().mockRejectedValue(new Error('slack 500')) });
    const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

    const ctx = { channelId: 'C9', threadTs: 't9', sessionKey: 'C9:t9', turnId: 'C9:t9:nostream' };
    await surface.begin(ctx);
    await expect(surface.markUserInterrupted(ctx.turnId)).resolves.toBe(true);

    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(client.chat.postMessage.mock.calls[0][0]).toMatchObject({
      channel: 'C9',
      thread_ts: 't9',
      text: 'user-interrupted',
    });
    expect(client.chat.appendStream).not.toHaveBeenCalled();

    await surface.end(ctx.turnId, 'user-interrupted');
    // Still exactly one marker — the sticky flag survives the close path.
    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
  });

  it('an interrupted OLD turn never writes onto the newer turn’s stream', async () => {
    const client = makeClient({
      startStream: vi.fn().mockResolvedValueOnce({ ts: 'stream-old' }).mockResolvedValueOnce({ ts: 'stream-new' }),
    });
    const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

    const sessionKey = 'C1:t1';
    const ctxOld = { channelId: 'C1', threadTs: 't1', sessionKey, turnId: 'C1:t1:old' };
    const ctxNew = { channelId: 'C1', threadTs: 't1', sessionKey, turnId: 'C1:t1:new' };

    await surface.begin(ctxOld);
    await surface.begin(ctxNew); // supersede — old state is gone
    client.chat.appendStream.mockClear();
    client.chat.postMessage.mockClear();

    // The stop click for the old turn arrives late.
    await expect(surface.markUserInterrupted(ctxOld.turnId)).resolves.toBe(false);

    expect(client.chat.appendStream).not.toHaveBeenCalled();
    expect(client.chat.postMessage).not.toHaveBeenCalled();

    await surface.end(ctxNew.turnId, 'completed');
  });

  it('B5 completion marker stays completed-only: end("user-interrupted") emits nothing', async () => {
    const client = makeClient();
    const channel = { send: vi.fn().mockResolvedValue(undefined) };
    const surface = new TurnSurface({
      slackApi: makeSlackApi(client),
      slackBlockKitChannel: channel as any,
      isCompletionMarkerActive: () => true,
    });

    const ctx = {
      channelId: 'C1',
      threadTs: 't1',
      sessionKey: 'C1:t1',
      turnId: 'C1:t1:b5-int',
      buildCompletionEvent: () =>
        Promise.resolve({
          category: 'WorkflowComplete' as const,
          userId: 'U1',
          channel: 'C1',
          threadTs: 't1',
        }),
    };
    await surface.begin(ctx as any);
    const result = await surface.end(ctx.turnId, 'user-interrupted');

    expect(channel.send).not.toHaveBeenCalled();
    // No B5 was expected → no fallback notify should be triggered either.
    expect(result.snapshotResolved).toBe(true);
  });
});
