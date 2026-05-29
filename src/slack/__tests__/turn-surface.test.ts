import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TurnAddress, TurnSurface } from '../turn-surface';

/**
 * TurnSurface unit tests (Issue #525, P1).
 *
 * Covers plan §7.1 cases:
 *   - begin → appendText → end order invariant (PHASE>=1)
 *   - fail() always calls stopStream with chunks-mode-compatible payload
 *   - concurrent turn supersede: begin(B) while A in-flight → fail(A)+begin(B)
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
  } as any;
}

function makeClient(overrides?: Partial<MockClient['chat']>): MockClient {
  return {
    chat: {
      startStream: vi.fn().mockResolvedValue({ ts: 'stream-ts-1' }),
      appendStream: vi.fn().mockResolvedValue(undefined),
      stopStream: vi.fn().mockResolvedValue(undefined),
      // P2 additions — renderTasks uses postMessage (first call) + update (subsequent).
      postMessage: vi.fn().mockResolvedValue({ ts: 'plan-ts-default' }),
      update: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    },
  };
}

describe('TurnSurface', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // PHASE>=1: core begin/appendText/end flow
  // -------------------------------------------------------------------------

  describe('PHASE>=1 B1 stream lifecycle', () => {
    it('begin → appendText → end calls start/append/stop in order with chunks', async () => {
      const client = makeClient();
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      const ctx = { channelId: 'C1', threadTs: 't1.0', sessionKey: 'C1:t1.0', turnId: 'C1:t1.0:1000' };
      await surface.begin(ctx);
      await surface.appendText(ctx.turnId, 'hello ');
      await surface.appendText(ctx.turnId, 'world');
      await surface.end(ctx.turnId, 'completed');

      // startStream called once with channel + thread_ts
      expect(client.chat.startStream).toHaveBeenCalledTimes(1);
      expect(client.chat.startStream).toHaveBeenCalledWith({
        channel: 'C1',
        thread_ts: 't1.0',
      });

      // appendStream called twice with chunks-mode payload
      expect(client.chat.appendStream).toHaveBeenCalledTimes(2);
      expect(client.chat.appendStream).toHaveBeenNthCalledWith(1, {
        channel: 'C1',
        ts: 'stream-ts-1',
        chunks: [{ type: 'markdown_text', text: 'hello ' }],
      });
      expect(client.chat.appendStream).toHaveBeenNthCalledWith(2, {
        channel: 'C1',
        ts: 'stream-ts-1',
        chunks: [{ type: 'markdown_text', text: 'world' }],
      });

      // stopStream called once, with chunks-mode symmetry (empty chunks array)
      expect(client.chat.stopStream).toHaveBeenCalledTimes(1);
      expect(client.chat.stopStream).toHaveBeenCalledWith({
        channel: 'C1',
        ts: 'stream-ts-1',
        chunks: [],
      });

      // end() clears per-turn state
      expect(surface._hasActiveTurn(ctx.sessionKey)).toBe(false);
      expect(surface._getTurnStateSnapshot(ctx.turnId)).toBeUndefined();
    });

    // Regression: Slack rejects channel/thread streaming with
    // `missing_recipient_team_id` unless BOTH `recipient_user_id` AND
    // `recipient_team_id` are sent. Sending one alone is treated as a
    // shape error rather than a fallback to assistant-thread mode, so
    // the pair must be forwarded atomically.
    it.each([
      { name: 'both present', uid: 'U1', tid: 'T1', expectAttached: true },
      { name: 'only user', uid: 'U1', tid: undefined, expectAttached: false },
      { name: 'only team', uid: undefined, tid: 'T1', expectAttached: false },
      { name: 'both empty string', uid: '', tid: '', expectAttached: false },
    ])('startStream recipient atomicity: $name', async ({ uid, tid, expectAttached }) => {
      const client = makeClient();
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      const ctx = {
        channelId: 'C1',
        threadTs: 't1.0',
        sessionKey: 'C1:t1.0',
        turnId: `C1:t1.0:${uid}-${tid}`,
        ...(uid !== undefined ? { recipientUserId: uid } : {}),
        ...(tid !== undefined ? { recipientTeamId: tid } : {}),
      };
      await surface.begin(ctx);
      await surface.end(ctx.turnId, 'completed');

      const call = (client.chat.startStream as any).mock.calls[0][0];
      if (expectAttached) {
        expect(call.recipient_user_id).toBe(uid);
        expect(call.recipient_team_id).toBe(tid);
      } else {
        expect(call.recipient_user_id).toBeUndefined();
        expect(call.recipient_team_id).toBeUndefined();
      }
    });

    it('omits thread_ts when TurnContext does not supply one (DM root)', async () => {
      const client = makeClient();
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      const ctx = { channelId: 'D1', sessionKey: 'D1:root', turnId: 'D1:root:1000' };
      await surface.begin(ctx);
      await surface.end(ctx.turnId, 'completed');

      // thread_ts must NOT appear in startStream args — Slack treats its
      // absence as "open a new DM stream at root", which is the intent.
      expect(client.chat.startStream).toHaveBeenCalledWith({ channel: 'D1' });
    });

    it('appendText is a no-op when startStream returned no ts', async () => {
      const client = makeClient({
        startStream: vi.fn().mockResolvedValue({
          /* no ts */
        }),
      });
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      const ctx = { channelId: 'C1', threadTs: 't1', sessionKey: 'C1:t1', turnId: 'C1:t1:1' };
      await surface.begin(ctx);
      await surface.appendText(ctx.turnId, 'should drop');

      // appendStream is never called because we have no streamTs to address
      expect(client.chat.appendStream).not.toHaveBeenCalled();

      // end() is still safe — no streamTs → no stopStream
      await surface.end(ctx.turnId, 'completed');
      expect(client.chat.stopStream).not.toHaveBeenCalled();
      expect(surface._hasActiveTurn(ctx.sessionKey)).toBe(false);
    });

    it('appendText drops empty text without calling appendStream', async () => {
      const client = makeClient();
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      const ctx = { channelId: 'C1', threadTs: 't1', sessionKey: 'C1:t1', turnId: 'C1:t1:1' };
      await surface.begin(ctx);
      await surface.appendText(ctx.turnId, '');
      await surface.end(ctx.turnId, 'completed');

      expect(client.chat.appendStream).not.toHaveBeenCalled();
      expect(client.chat.stopStream).toHaveBeenCalledTimes(1);
    });

    it('appendText drops whitespace-only chunks', async () => {
      const client = makeClient();
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      const ctx = { channelId: 'C1', threadTs: 't1', sessionKey: 'C1:t1', turnId: 'C1:t1:1' };
      await surface.begin(ctx);
      // Whitespace-only chunks would otherwise be billed as chunks and
      // render as empty blobs — match handleTextMessage's `!text.trim()`
      // guard so the B1 surface stays consistent.
      await expect(surface.appendText(ctx.turnId, '   ')).resolves.toBe(false);
      await expect(surface.appendText(ctx.turnId, '\n\n')).resolves.toBe(false);
      await expect(surface.appendText(ctx.turnId, '\t  \n')).resolves.toBe(false);

      expect(client.chat.appendStream).not.toHaveBeenCalled();
      await surface.end(ctx.turnId, 'completed');
    });

    it('appendText is a no-op once the turn is closing', async () => {
      // stopStream delays so we can interleave an appendText while closing=true
      let releaseStop: () => void = () => {};
      const stopPromise = new Promise<void>((resolve) => {
        releaseStop = resolve;
      });
      const client = makeClient({
        stopStream: vi.fn().mockReturnValue(stopPromise),
      });
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      const ctx = { channelId: 'C1', threadTs: 't1', sessionKey: 'C1:t1', turnId: 'C1:t1:1' };
      await surface.begin(ctx);
      const endPromise = surface.end(ctx.turnId, 'completed');
      // end() has set closing=true and is awaiting stopStream — racing append
      await surface.appendText(ctx.turnId, 'late chunk');
      releaseStop();
      await endPromise;

      expect(client.chat.appendStream).not.toHaveBeenCalled();
    });

    it('end() is idempotent — a second call is a no-op', async () => {
      const client = makeClient();
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      const ctx = { channelId: 'C1', threadTs: 't1', sessionKey: 'C1:t1', turnId: 'C1:t1:1' };
      await surface.begin(ctx);
      await surface.end(ctx.turnId, 'completed');
      await surface.end(ctx.turnId, 'completed'); // should silently no-op

      expect(client.chat.stopStream).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // fail() path
  // -------------------------------------------------------------------------

  describe('fail()', () => {
    beforeEach(() => {});

    it('calls stopStream with empty chunks and clears state', async () => {
      const client = makeClient();
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      const ctx = { channelId: 'C1', threadTs: 't1', sessionKey: 'C1:t1', turnId: 'C1:t1:1' };
      await surface.begin(ctx);
      await surface.appendText(ctx.turnId, 'partial');
      await surface.fail(ctx.turnId, new Error('boom'));

      expect(client.chat.stopStream).toHaveBeenCalledTimes(1);
      expect(client.chat.stopStream).toHaveBeenCalledWith({
        channel: 'C1',
        ts: 'stream-ts-1',
        chunks: [],
      });
      expect(surface._hasActiveTurn(ctx.sessionKey)).toBe(false);
    });

    it('on stopStream failure: logs channel + streamTs + Slack error, then clears state (memory-leak prevention > retry)', async () => {
      // Design intent: TurnSurface does NOT retry a failed stopStream. If it
      // kept the TurnState around, a later supersede-driven fail() would hit
      // the `state.closing` fence and silently no-op, so "retry later" never
      // actually happens. Instead we clear the state (no memory leak) and
      // emit enough forensics for an operator to chase the orphaned stream
      // manually. The rollout plan (docs/archive/features/slack-ui/phase1.md §Rollout
      // sequence) monitors `chat.stopStream` errors via these warn fields.
      const warnSpy = vi.fn();
      const slackErr = Object.assign(new Error('slack down'), {
        data: { error: 'streaming_mode_mismatch' },
      });
      const client = makeClient({
        stopStream: vi.fn().mockRejectedValue(slackErr),
      });
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });
      (surface as any).logger.warn = warnSpy;

      const ctx = { channelId: 'C1', threadTs: 't1', sessionKey: 'C1:t1', turnId: 'C1:t1:1' };
      await surface.begin(ctx);
      await expect(surface.fail(ctx.turnId, new Error('upstream'))).resolves.toBeUndefined();

      // State cleared (memory-leak prevention)
      expect(surface._hasActiveTurn(ctx.sessionKey)).toBe(false);

      // Forensics emitted (operator can chase the leaked stream)
      expect(warnSpy).toHaveBeenCalledWith(
        'chat.stopStream failed',
        expect.objectContaining({
          turnId: ctx.turnId,
          channelId: 'C1',
          streamTs: 'stream-ts-1',
          origin: 'fail',
          error: expect.objectContaining({ code: 'streaming_mode_mismatch' }),
        }),
      );
    });

    it('is a no-op when the turn is unknown', async () => {
      const client = makeClient();
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      await surface.fail('never-began', new Error('x'));
      expect(client.chat.stopStream).not.toHaveBeenCalled();
    });

    it('is idempotent under double fail() on the same turn', async () => {
      // The `state.closing` fence at turn-surface.ts:324 must not be bypassed
      // by a second fail() — otherwise a defensive caller pattern (catch +
      // finally both calling fail) would double-close the Slack stream.
      const client = makeClient();
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      const ctx = { channelId: 'C1', threadTs: 't1', sessionKey: 'C1:t1', turnId: 'C1:t1:1' };
      await surface.begin(ctx);
      await surface.fail(ctx.turnId, new Error('first'));
      await surface.fail(ctx.turnId, new Error('second'));

      expect(client.chat.stopStream).toHaveBeenCalledTimes(1);
      expect(surface._hasActiveTurn(ctx.sessionKey)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Concurrent turn supersede
  // -------------------------------------------------------------------------

  describe('concurrent turn supersede', () => {
    beforeEach(() => {});

    it('begin(B) while A in-flight closes A before opening B', async () => {
      const startStream = vi.fn().mockResolvedValueOnce({ ts: 'stream-A' }).mockResolvedValueOnce({ ts: 'stream-B' });
      const client = makeClient({ startStream });
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      const sessionKey = 'C1:t1';
      const ctxA = { channelId: 'C1', threadTs: 't1', sessionKey, turnId: 'C1:t1:A' };
      const ctxB = { channelId: 'C1', threadTs: 't1', sessionKey, turnId: 'C1:t1:B' };

      await surface.begin(ctxA);
      await surface.begin(ctxB);

      // B's startStream must come AFTER A's stopStream (supersede fail(A))
      const startCallOrder = client.chat.startStream.mock.invocationCallOrder;
      const stopCallOrder = client.chat.stopStream.mock.invocationCallOrder;
      expect(startCallOrder.length).toBe(2);
      expect(stopCallOrder.length).toBe(1);
      expect(stopCallOrder[0]).toBeLessThan(startCallOrder[1]);

      // A's stream was the one stopped (ts=stream-A)
      expect(client.chat.stopStream).toHaveBeenCalledWith({
        channel: 'C1',
        ts: 'stream-A',
        chunks: [],
      });

      // Active turn is now B
      expect(surface._getActiveTurnId(sessionKey)).toBe('C1:t1:B');
      expect(surface._getTurnStateSnapshot('C1:t1:A')).toBeUndefined();

      await surface.end(ctxB.turnId, 'completed');
      expect(surface._hasActiveTurn(sessionKey)).toBe(false);
    });

    it('does not supersede when begin() is called again with the same turnId', async () => {
      const startStream = vi.fn().mockResolvedValue({ ts: 'stream-1' });
      const client = makeClient({ startStream });
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      const ctx = { channelId: 'C1', threadTs: 't1', sessionKey: 'C1:t1', turnId: 'C1:t1:1' };
      await surface.begin(ctx);
      await surface.begin(ctx); // duplicate begin() — short-circuits without a second startStream

      // No stopStream (no supersede) AND no second startStream (defensive
      // short-circuit prevents orphaning the first stream handle).
      expect(client.chat.stopStream).not.toHaveBeenCalled();
      expect(client.chat.startStream).toHaveBeenCalledTimes(1);
    });

    it('closes an orphaned stream when supersede cleans up mid-startStream', async () => {
      // Arrange: make A's startStream resolve slowly so supersede can land
      // between `turns.set(A)` and the startStream await settling. B resolves
      // immediately. The race matches the codex-flagged hole in begin().
      let resolveAStart: (v: { ts: string }) => void = () => {};
      const startStream = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<{ ts: string }>((resolve) => {
              resolveAStart = resolve;
            }),
        )
        .mockResolvedValueOnce({ ts: 'stream-B' });
      const client = makeClient({ startStream });
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      const sessionKey = 'C1:t1';
      const ctxA = { channelId: 'C1', threadTs: 't1', sessionKey, turnId: 'C1:t1:A' };
      const ctxB = { channelId: 'C1', threadTs: 't1', sessionKey, turnId: 'C1:t1:B' };

      // Kick off A; don't await — it's still pending on startStream.
      const aPromise = surface.begin(ctxA);

      // B's begin supersedes A (fail(A) runs; A has no streamTs yet → closeStream skipped,
      // TurnState A removed from the map).
      await surface.begin(ctxB);

      // Now A's startStream finally resolves with a ts — but its TurnState is gone.
      resolveAStart({ ts: 'stream-A-orphan' });
      await aPromise;

      // The orphaned stream-A-orphan handle must be closed, else Slack dangles
      // a "typing" indicator and a leaked B1 message.
      expect(client.chat.stopStream).toHaveBeenCalledWith({
        channel: 'C1',
        ts: 'stream-A-orphan',
        chunks: [],
      });
      // B's stream is still active.
      expect(surface._getActiveTurnId(sessionKey)).toBe('C1:t1:B');

      await surface.end(ctxB.turnId, 'completed');
    });
  });

  // -------------------------------------------------------------------------
  // appendText boolean return (graceful fallback signal)
  // -------------------------------------------------------------------------

  describe('appendText return value', () => {
    it('returns true when the chunk is delivered to Slack (PHASE>=1)', async () => {
      const client = makeClient();
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      const ctx = { channelId: 'C1', threadTs: 't1', sessionKey: 'C1:t1', turnId: 'C1:t1:1' };
      await surface.begin(ctx);
      await expect(surface.appendText(ctx.turnId, 'ok')).resolves.toBe(true);
      await surface.end(ctx.turnId, 'completed');
    });

    it('returns false when startStream failed (no streamTs) so caller falls back', async () => {
      const client = makeClient({
        startStream: vi.fn().mockRejectedValue(new Error('slack 500')),
      });
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      const ctx = { channelId: 'C1', threadTs: 't1', sessionKey: 'C1:t1', turnId: 'C1:t1:1' };
      await surface.begin(ctx); // swallows the error, no streamTs recorded

      // appendText detects the missing streamTs and surfaces false so the
      // stream-processor can fall back to `context.say`.
      await expect(surface.appendText(ctx.turnId, 'reply')).resolves.toBe(false);
      expect(client.chat.appendStream).not.toHaveBeenCalled();
    });

    it('returns false when chat.appendStream itself raises', async () => {
      const client = makeClient({
        appendStream: vi.fn().mockRejectedValue(new Error('transient network')),
      });
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      const ctx = { channelId: 'C1', threadTs: 't1', sessionKey: 'C1:t1', turnId: 'C1:t1:1' };
      await surface.begin(ctx);
      await expect(surface.appendText(ctx.turnId, 'reply')).resolves.toBe(false);
      await surface.end(ctx.turnId, 'completed');
    });
  });

  // -------------------------------------------------------------------------
  // B2 plan block (P2) — renderTasks
  // -------------------------------------------------------------------------

  describe('renderTasks (PHASE>=2)', () => {
    const todos = [
      { id: '1', content: 'done task', status: 'completed', priority: 'high' },
      { id: '2', content: 'running task', status: 'in_progress', priority: 'high' },
      { id: '3', content: 'waiting task', status: 'pending', priority: 'medium' },
    ];

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('first call posts a new message and stores planTs on turn state', async () => {
      const client = makeClient({
        postMessage: vi.fn().mockResolvedValue({ ts: 'plan-ts-1' }),
      });
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      const ctx = { channelId: 'C1', threadTs: 't1', sessionKey: 'C1:t1', turnId: 'C1:t1:1' };
      await surface.begin(ctx);
      await expect(surface.renderTasks(ctx.turnId, todos as any)).resolves.toBe(true);
      // Drain the 500ms debounce window.
      await vi.advanceTimersByTimeAsync(500);

      expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
      const postArgs = client.chat.postMessage.mock.calls[0][0];
      expect(postArgs.channel).toBe('C1');
      expect(postArgs.thread_ts).toBe('t1');
      expect(typeof postArgs.text).toBe('string');
      expect(Array.isArray(postArgs.blocks)).toBe(true);
      // chat.update NOT called on first render
      expect(client.chat.update).not.toHaveBeenCalled();

      await surface.end(ctx.turnId, 'completed');
    });

    it('second call uses chat.update with the stored planTs (no second postMessage)', async () => {
      const client = makeClient({
        postMessage: vi.fn().mockResolvedValue({ ts: 'plan-ts-1' }),
        update: vi.fn().mockResolvedValue(undefined),
      });
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      const ctx = { channelId: 'C1', threadTs: 't1', sessionKey: 'C1:t1', turnId: 'C1:t1:1' };
      await surface.begin(ctx);

      await surface.renderTasks(ctx.turnId, todos as any);
      await vi.advanceTimersByTimeAsync(500);
      expect(client.chat.postMessage).toHaveBeenCalledTimes(1);

      await surface.renderTasks(ctx.turnId, todos as any);
      await vi.advanceTimersByTimeAsync(500);

      expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
      expect(client.chat.update).toHaveBeenCalledTimes(1);
      expect(client.chat.update.mock.calls[0][0]).toMatchObject({
        channel: 'C1',
        ts: 'plan-ts-1',
      });

      await surface.end(ctx.turnId, 'completed');
    });

    it('5 rapid calls coalesce into 1 trailing update (debounce)', async () => {
      const client = makeClient({
        postMessage: vi.fn().mockResolvedValue({ ts: 'plan-ts-1' }),
        update: vi.fn().mockResolvedValue(undefined),
      });
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      const ctx = { channelId: 'C1', threadTs: 't1', sessionKey: 'C1:t1', turnId: 'C1:t1:1' };
      await surface.begin(ctx);

      // First render: postMessage — drain debounce so planTs is committed
      await surface.renderTasks(ctx.turnId, todos as any);
      await vi.advanceTimersByTimeAsync(500);
      expect(client.chat.postMessage).toHaveBeenCalledTimes(1);

      // 5 rapid updates — only 1 trailing chat.update call
      for (let i = 0; i < 5; i += 1) {
        await surface.renderTasks(ctx.turnId, todos as any);
      }
      await vi.advanceTimersByTimeAsync(500);
      expect(client.chat.update).toHaveBeenCalledTimes(1);

      await surface.end(ctx.turnId, 'completed');
    });

    it('works with an ad-hoc state entry when begin() was not called (ctx required)', async () => {
      const client = makeClient({
        postMessage: vi.fn().mockResolvedValue({ ts: 'plan-ts-adhoc' }),
      });
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      // No begin() — pass ctx to let renderTasks create an ad-hoc state entry
      const turnId = 'ad-hoc-turn';
      const ctx = { channelId: 'C2', threadTs: 't2', sessionKey: 'C2:t2' };

      await expect(surface.renderTasks(turnId, todos as any, ctx)).resolves.toBe(true);
      await vi.advanceTimersByTimeAsync(500);
      expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
      // streamTs is undefined (no begin() ever ran) — endTurn must not call stopStream
      await surface.end(turnId, 'completed');
      expect(client.chat.stopStream).not.toHaveBeenCalled();
    });

    it('returns false and warns when no ctx provided and no existing turn state', async () => {
      const warnSpy = vi.fn();
      const client = makeClient();
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });
      (surface as any).logger.warn = warnSpy;

      await expect(surface.renderTasks('unknown-turn', todos as any)).resolves.toBe(false);
      await vi.advanceTimersByTimeAsync(500);
      expect(client.chat.postMessage).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith('renderTasks called without ctx and no existing turn', {
        turnId: 'unknown-turn',
      });
    });

    it('returns false when todos is empty (nothing to render, spares a Slack call)', async () => {
      const client = makeClient();
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      const ctx = { channelId: 'C1', threadTs: 't1', sessionKey: 'C1:t1', turnId: 'C1:t1:1' };
      await surface.begin(ctx);
      await expect(surface.renderTasks(ctx.turnId, [])).resolves.toBe(false);
      await vi.advanceTimersByTimeAsync(500);
      expect(client.chat.postMessage).not.toHaveBeenCalled();
      expect(client.chat.update).not.toHaveBeenCalled();

      await surface.end(ctx.turnId, 'completed');
    });

    it('supersede: planTs on the old turn survives but is finalized (in_progress demoted) so no stale spinner', async () => {
      // Under PHASE>=2, the B2 plan message is a separate ts from B1 streamTs.
      // Supersede closes B1 (stream); the planTs Slack message is preserved
      // in history but receives ONE final `chat.update` that demotes any
      // lingering `in_progress` task_cards to `pending`. Without that step,
      // Slack's native loading indicator on `task_card.status='in_progress'`
      // would keep spinning forever on the orphaned plan message ("hang
      // state"). The message itself is intentionally NOT deleted — users
      // still see the final plan, just without the misleading spinner.
      const client = makeClient({
        postMessage: vi.fn().mockResolvedValue({ ts: 'plan-ts-A' }),
        update: vi.fn().mockResolvedValue(undefined),
      });
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      const sessionKey = 'C1:t1';
      const ctxA = { channelId: 'C1', threadTs: 't1', sessionKey, turnId: 'C1:t1:A' };
      const ctxB = { channelId: 'C1', threadTs: 't1', sessionKey, turnId: 'C1:t1:B' };

      await surface.begin(ctxA);
      await surface.renderTasks(ctxA.turnId, todos as any);
      await vi.advanceTimersByTimeAsync(500);
      expect(client.chat.postMessage).toHaveBeenCalledTimes(1);

      // Supersede — fail(A) runs synchronously inside begin(B).
      await surface.begin(ctxB);

      // B1 stream for A was stopped (supersede).
      expect(client.chat.stopStream).toHaveBeenCalledTimes(1);
      // B2 plan for A received exactly one finalize update — same channel +
      // ts, with no `in_progress` task_cards in the rendered blocks.
      const updatesAgainstA = (client.chat.update?.mock.calls ?? []).filter(
        (call: any[]) => call[0]?.ts === 'plan-ts-A',
      );
      expect(updatesAgainstA.length).toBe(1);
      const finalPlanBlock = updatesAgainstA[0][0].blocks?.find((b: any) => b.type === 'plan');
      expect(finalPlanBlock).toBeDefined();
      expect(finalPlanBlock.tasks.filter((tc: any) => tc.status === 'in_progress')).toEqual([]);

      await surface.end(ctxB.turnId, 'completed');
    });

    it('end(turnId) with ad-hoc entry does not call stopStream (no streamTs)', async () => {
      const client = makeClient({
        postMessage: vi.fn().mockResolvedValue({ ts: 'plan-ts-adhoc' }),
      });
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      const turnId = 'ad-hoc-end-test';
      await surface.renderTasks(turnId, todos as any, { channelId: 'C', threadTs: 't', sessionKey: 'C:t' });
      await vi.advanceTimersByTimeAsync(500);
      await surface.end(turnId, 'completed');
      expect(client.chat.stopStream).not.toHaveBeenCalled();
      expect(surface._getTurnStateSnapshot(turnId)).toBeUndefined();
    });

    // ─────────────────────────────────────────────────────────────────────────
    // End-of-turn finalize — kills the stuck `task_card.status='in_progress'`
    // spinner that lingers when the LLM ends a turn without marking its
    // in-progress todo as completed.
    //
    // Reproduces the user-visible "hang state": Slack renders an in_progress
    // task_card with a built-in loading indicator. Because the B2 plan
    // message ts is intentionally preserved across end()/fail() (see
    // turn-surface.ts state.planTs commentary), the loading indicator stays
    // visible forever unless we explicitly demote the card on close.
    // ─────────────────────────────────────────────────────────────────────────

    describe('end-of-turn plan finalize (demotes lingering in_progress task_cards)', () => {
      it('end("completed") with a lingering in_progress todo issues a final chat.update against planTs with demoted statuses', async () => {
        const client = makeClient({
          postMessage: vi.fn().mockResolvedValue({ ts: 'plan-ts-fin' }),
          update: vi.fn().mockResolvedValue(undefined),
        });
        const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

        const ctx = { channelId: 'C1', threadTs: 't1', sessionKey: 'C1:t1', turnId: 'C1:t1:fin' };
        await surface.begin(ctx);

        // Initial render — postMessage commits planTs.
        await surface.renderTasks(ctx.turnId, todos as any);
        await vi.advanceTimersByTimeAsync(500);
        expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
        expect(client.chat.update).not.toHaveBeenCalled();

        // Turn ends WITHOUT marking the in_progress todo as completed.
        await surface.end(ctx.turnId, 'completed');

        // Exactly ONE final chat.update against planTs.
        const planUpdates = client.chat.update.mock.calls.filter((call: any[]) => call[0]?.ts === 'plan-ts-fin');
        expect(planUpdates.length).toBe(1);

        const finalArgs = planUpdates[0][0];
        expect(finalArgs.channel).toBe('C1');
        const finalPlanBlock = finalArgs.blocks?.find((b: any) => b.type === 'plan');
        expect(finalPlanBlock).toBeDefined();
        // Every in_progress arm of `todos` should be demoted to `pending`.
        const inProgressInFinal = finalPlanBlock.tasks.filter((tc: any) => tc.status === 'in_progress');
        expect(inProgressInFinal).toEqual([]);
        // The lingering todo's title is preserved as `pending` so users see WHAT
        // was left unfinished — no ghost spinner, no silent loss of context.
        const demoted = finalPlanBlock.tasks.find((tc: any) => tc.title === 'running task');
        expect(demoted).toBeDefined();
        expect(demoted.status).toBe('pending');
      });

      it('end("completed") with all-completed todos does NOT issue an extra chat.update (idempotent)', async () => {
        const allDoneTodos = todos.map((t) => ({ ...t, status: 'completed' }));
        const client = makeClient({
          postMessage: vi.fn().mockResolvedValue({ ts: 'plan-ts-alldone' }),
          update: vi.fn().mockResolvedValue(undefined),
        });
        const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

        const ctx = { channelId: 'C1', threadTs: 't1', sessionKey: 'C1:t1', turnId: 'C1:t1:alldone' };
        await surface.begin(ctx);
        await surface.renderTasks(ctx.turnId, allDoneTodos as any);
        await vi.advanceTimersByTimeAsync(500);
        expect(client.chat.postMessage).toHaveBeenCalledTimes(1);

        await surface.end(ctx.turnId, 'completed');

        // No final demotion render needed when nothing was in_progress.
        const planUpdates = client.chat.update.mock.calls.filter((call: any[]) => call[0]?.ts === 'plan-ts-alldone');
        expect(planUpdates.length).toBe(0);
      });

      it('fail() with a lingering in_progress todo also demotes the plan block to pending', async () => {
        const client = makeClient({
          postMessage: vi.fn().mockResolvedValue({ ts: 'plan-ts-fail' }),
          update: vi.fn().mockResolvedValue(undefined),
        });
        const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

        const ctx = { channelId: 'C1', threadTs: 't1', sessionKey: 'C1:t1', turnId: 'C1:t1:fail' };
        await surface.begin(ctx);
        await surface.renderTasks(ctx.turnId, todos as any);
        await vi.advanceTimersByTimeAsync(500);

        await surface.fail(ctx.turnId, new Error('aborted'));

        const planUpdates = client.chat.update.mock.calls.filter((call: any[]) => call[0]?.ts === 'plan-ts-fail');
        expect(planUpdates.length).toBe(1);
        const finalPlanBlock = planUpdates[0][0].blocks?.find((b: any) => b.type === 'plan');
        const inProgressInFinal = finalPlanBlock.tasks.filter((tc: any) => tc.status === 'in_progress');
        expect(inProgressInFinal).toEqual([]);
      });

      it('end() without renderTasks ever called → no chat.update (nothing to finalize)', async () => {
        const client = makeClient();
        const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

        const ctx = { channelId: 'C1', threadTs: 't1', sessionKey: 'C1:t1', turnId: 'C1:t1:bare' };
        await surface.begin(ctx);
        // No renderTasks call — no plan message exists.
        await surface.end(ctx.turnId, 'completed');

        expect(client.chat.update).not.toHaveBeenCalled();
      });

      it('supersede (begin B over A with A still in_progress) finalizes A’s plan before B opens', async () => {
        // Supersede routes through fail(A) — A's plan must still get its
        // demotion render so the old plan-ts message stops showing a spinner
        // before the new turn's plan posts.
        const client = makeClient({
          postMessage: vi.fn().mockResolvedValue({ ts: 'plan-ts-A' }),
          update: vi.fn().mockResolvedValue(undefined),
        });
        const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

        const sessionKey = 'C1:t1';
        const ctxA = { channelId: 'C1', threadTs: 't1', sessionKey, turnId: 'C1:t1:A2' };
        const ctxB = { channelId: 'C1', threadTs: 't1', sessionKey, turnId: 'C1:t1:B2' };

        await surface.begin(ctxA);
        await surface.renderTasks(ctxA.turnId, todos as any);
        await vi.advanceTimersByTimeAsync(500);

        // Supersede — fail(A) runs synchronously inside begin(B).
        await surface.begin(ctxB);

        const planUpdatesA = client.chat.update.mock.calls.filter((call: any[]) => call[0]?.ts === 'plan-ts-A');
        expect(planUpdatesA.length).toBe(1);
        const finalPlanBlock = planUpdatesA[0][0].blocks?.find((b: any) => b.type === 'plan');
        const inProgressInFinal = finalPlanBlock.tasks.filter((tc: any) => tc.status === 'in_progress');
        expect(inProgressInFinal).toEqual([]);

        // Clean up B so the test does not leak state.
        await surface.end(ctxB.turnId, 'completed');
      });
    });
  });

  // -------------------------------------------------------------------------
  // B3 choice (P3) — askUser / askUserForm / resolveChoice / resolveMultiChoice
  // -------------------------------------------------------------------------

  describe('TurnSurface — P3 (PHASE>=3) B3 choice', () => {
    beforeEach(() => {});

    function makeSurfaceWithApi(overrides?: Partial<MockClient['chat']>) {
      const client = makeClient(overrides);
      const slackApi = {
        getClient: vi.fn().mockReturnValue(client),
        updateMessage: vi.fn().mockResolvedValue(undefined),
      } as any;
      const surface = new TurnSurface({ slackApi });
      return { surface, client, slackApi };
    }

    it('askUser posts message and returns ts', async () => {
      const { surface, client } = makeSurfaceWithApi({
        postMessage: vi.fn().mockResolvedValue({ ts: 'msg-1' }),
      });
      const addr: TurnAddress = { channelId: 'C1', threadTs: 'thr-1', sessionKey: 'C1:thr-1' };
      const ts = await surface.askUser('turn-1', { blocks: [{ type: 'section' }] }, 'Q?', addr);
      expect(ts).toBe('msg-1');
      expect(client.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C1',
          thread_ts: 'thr-1',
          text: 'Q?',
          blocks: [{ type: 'section' }],
        }),
      );
    });

    it('askUser stamps choiceTs on turn state when turn exists', async () => {
      const { surface } = makeSurfaceWithApi({
        postMessage: vi.fn().mockResolvedValue({ ts: 'msg-stamped' }),
      });
      await surface.begin({ channelId: 'C', threadTs: 'thr', sessionKey: 'C:thr', turnId: 'turn-1' });
      const addr: TurnAddress = { channelId: 'C', threadTs: 'thr', sessionKey: 'C:thr' };
      await surface.askUser('turn-1', { blocks: [] }, 'Q?', addr);
      expect(surface._getChoiceTs('turn-1')).toBe('msg-stamped');
      await surface.end('turn-1', 'completed');
    });

    it('askUser tolerates missing turn state (turn may have ended)', async () => {
      const { surface } = makeSurfaceWithApi({
        postMessage: vi.fn().mockResolvedValue({ ts: 'msg-orphan' }),
      });
      const addr: TurnAddress = { channelId: 'C', sessionKey: 'C:t' };
      // No begin() — askUser should still work.
      await expect(surface.askUser('orphan-turn', { blocks: [] }, 'Q', addr)).resolves.toBe('msg-orphan');
    });

    it('askUser throws when postMessage returns no ts', async () => {
      const { surface } = makeSurfaceWithApi({
        postMessage: vi.fn().mockResolvedValue({}),
      });
      const addr: TurnAddress = { channelId: 'C', sessionKey: 'C:t' };
      await expect(surface.askUser('turn-1', { blocks: [] }, 'Q', addr)).rejects.toThrow();
    });

    it('askUser omits thread_ts when address has none (DM root)', async () => {
      const { surface, client } = makeSurfaceWithApi({
        postMessage: vi.fn().mockResolvedValue({ ts: 'msg-dm' }),
      });
      const addr: TurnAddress = { channelId: 'D1', sessionKey: 'D1:root' };
      await surface.askUser('turn-1', { blocks: [] }, 'Q', addr);
      const postArgs = client.chat.postMessage.mock.calls[0][0];
      expect(postArgs.thread_ts).toBeUndefined();
      expect(postArgs.channel).toBe('D1');
    });

    it('askUserForm posts per chunk and accumulates formTsList', async () => {
      const { surface, client } = makeSurfaceWithApi({
        postMessage: vi.fn().mockResolvedValueOnce({ ts: 'msg-1' }).mockResolvedValueOnce({ ts: 'msg-2' }),
      });
      await surface.begin({ channelId: 'C', threadTs: 'thr', sessionKey: 'C:thr', turnId: 'turn-1' });
      const addr: TurnAddress = { channelId: 'C', threadTs: 'thr', sessionKey: 'C:thr' };
      const ts1 = await surface.askUserForm('turn-1', { blocks: [] }, 'Q1', addr);
      const ts2 = await surface.askUserForm('turn-1', { blocks: [] }, 'Q2', addr);
      expect(ts1).toBe('msg-1');
      expect(ts2).toBe('msg-2');
      expect(surface._getFormTsList('turn-1')).toEqual(['msg-1', 'msg-2']);
      expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    });

    it('askUserForm throws when postMessage returns no ts', async () => {
      const { surface } = makeSurfaceWithApi({
        postMessage: vi.fn().mockResolvedValue({}),
      });
      const addr: TurnAddress = { channelId: 'C', sessionKey: 'C:t' };
      await expect(surface.askUserForm('turn-1', { blocks: [] }, 'Q', addr)).rejects.toThrow();
    });

    it('resolveChoice updates the message via slackApi.updateMessage', async () => {
      const { surface, slackApi } = makeSurfaceWithApi();
      await surface.resolveChoice('C', 'msg-1', 'done', [{ type: 'section' }]);
      expect(slackApi.updateMessage).toHaveBeenCalledWith('C', 'msg-1', 'done', [{ type: 'section' }], []);
    });

    it('resolveChoice swallows message_not_found (idempotent)', async () => {
      const { surface, slackApi } = makeSurfaceWithApi();
      slackApi.updateMessage = vi.fn().mockRejectedValue({ data: { error: 'message_not_found' }, message: 'gone' });
      await expect(surface.resolveChoice('C', 'gone-ts', 'x', [])).resolves.toBeUndefined();
    });

    it('resolveChoice rethrows non-message_not_found errors', async () => {
      const { surface, slackApi } = makeSurfaceWithApi();
      slackApi.updateMessage = vi.fn().mockRejectedValue({ data: { error: 'rate_limited' }, message: 'rl' });
      await expect(surface.resolveChoice('C', 'ts', 'x', [])).rejects.toBeTruthy();
    });

    it('resolveMultiChoice iterates best-effort per ts', async () => {
      const { surface, slackApi } = makeSurfaceWithApi();
      slackApi.updateMessage = vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce({ data: { error: 'message_not_found' } })
        .mockResolvedValueOnce(undefined);
      await surface.resolveMultiChoice('C', ['t1', 't2', 't3'], 'done', []);
      expect(slackApi.updateMessage).toHaveBeenCalledTimes(3);
    });

    it('resolveMultiChoice continues past non-message_not_found errors (best-effort)', async () => {
      const { surface, slackApi } = makeSurfaceWithApi();
      slackApi.updateMessage = vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce({ data: { error: 'rate_limited' } })
        .mockResolvedValueOnce(undefined);
      await surface.resolveMultiChoice('C', ['t1', 't2', 't3'], 'done', []);
      expect(slackApi.updateMessage).toHaveBeenCalledTimes(3);
    });

    it('end() does NOT force-resolve a pending choice (outlives turn)', async () => {
      // Verify no calls to updateMessage from end() path
      const { surface, slackApi } = makeSurfaceWithApi({
        postMessage: vi.fn().mockResolvedValue({ ts: 'msg-1' }),
      });
      slackApi.updateMessage = vi.fn();
      await surface.begin({ channelId: 'C', threadTs: 'thr', sessionKey: 'C:thr', turnId: 'turn-1' });
      const addr: TurnAddress = { channelId: 'C', threadTs: 'thr', sessionKey: 'C:thr' };
      await surface.askUser('turn-1', { blocks: [] }, 'Q', addr);
      await surface.end('turn-1', 'completed');
      expect(slackApi.updateMessage).not.toHaveBeenCalled();
    });
  });

  // #689 P4 Part 2/2 — TurnSurface owns B4 native spinner.
  describe('B4 native-status wiring', () => {
    const makeMgr = (enabled: boolean) => ({
      isEnabled: vi.fn().mockReturnValue(enabled),
      setStatus: vi.fn().mockResolvedValue(undefined),
      clearStatus: vi.fn().mockResolvedValue(undefined),
    });

    it('begin calls setStatus("is thinking...") once', async () => {
      const client = makeClient();
      const mgr = makeMgr(true);
      const surface = new TurnSurface({
        slackApi: makeSlackApi(client),
        assistantStatusManager: mgr as any,
      });
      await surface.begin({ channelId: 'C', threadTs: 'thr', sessionKey: 'C:thr', turnId: 't-b4' });
      expect(mgr.setStatus).toHaveBeenCalledTimes(1);
      expect(mgr.setStatus).toHaveBeenCalledWith('C', 'thr', 'is thinking...');
    });

    it('end calls clearStatus once', async () => {
      const client = makeClient();
      const mgr = makeMgr(true);
      const surface = new TurnSurface({
        slackApi: makeSlackApi(client),
        assistantStatusManager: mgr as any,
      });
      await surface.begin({ channelId: 'C', threadTs: 'thr', sessionKey: 'C:thr', turnId: 't-b4-e' });
      await surface.end('t-b4-e', 'completed');
      expect(mgr.clearStatus).toHaveBeenCalledTimes(1);
      // Issue #688 — third arg is the optional expectedEpoch options bag.
      // When TurnContext omits `statusEpoch` (this test does) end()/fail()
      // pass `undefined`, which `clearStatus` treats as "no epoch guard".
      expect(mgr.clearStatus).toHaveBeenCalledWith('C', 'thr', undefined);
    });

    // Issue #688 — when TurnContext threads a `statusEpoch`, end()/fail()
    // forward it as `expectedEpoch` so a stale close from a superseded
    // turn cannot wipe a spinner set by the newer turn.
    it('statusEpoch: end forwards expectedEpoch to clearStatus', async () => {
      const client = makeClient();
      const mgr = makeMgr(true);
      const surface = new TurnSurface({
        slackApi: makeSlackApi(client),
        assistantStatusManager: mgr as any,
      });
      await surface.begin({
        channelId: 'C',
        threadTs: 'thr',
        sessionKey: 'C:thr',
        turnId: 't-b4-epoch',
        statusEpoch: 7,
      });
      await surface.end('t-b4-epoch', 'completed');
      expect(mgr.clearStatus).toHaveBeenCalledTimes(1);
      expect(mgr.clearStatus).toHaveBeenCalledWith('C', 'thr', { expectedEpoch: 7 });
    });

    it('statusEpoch: fail forwards expectedEpoch to clearStatus', async () => {
      const client = makeClient();
      const mgr = makeMgr(true);
      const surface = new TurnSurface({
        slackApi: makeSlackApi(client),
        assistantStatusManager: mgr as any,
      });
      await surface.begin({
        channelId: 'C',
        threadTs: 'thr',
        sessionKey: 'C:thr',
        turnId: 't-b4-epoch-f',
        statusEpoch: 11,
      });
      await surface.fail('t-b4-epoch-f', new Error('boom'));
      expect(mgr.clearStatus).toHaveBeenCalledTimes(1);
      expect(mgr.clearStatus).toHaveBeenCalledWith('C', 'thr', { expectedEpoch: 11 });
    });

    it('fail calls clearStatus (idempotent — fail twice → 1 call total)', async () => {
      const client = makeClient();
      const mgr = makeMgr(true);
      const surface = new TurnSurface({
        slackApi: makeSlackApi(client),
        assistantStatusManager: mgr as any,
      });
      await surface.begin({ channelId: 'C', threadTs: 'thr', sessionKey: 'C:thr', turnId: 't-b4-f' });
      await surface.fail('t-b4-f', new Error('boom'));
      await surface.fail('t-b4-f', new Error('boom again'));
      expect(mgr.clearStatus).toHaveBeenCalledTimes(1);
    });

    // #700 review P2 — supersede-race integration test. Exercises the
    // actual AssistantStatusManager (not a mock) to prove the epoch guard
    // in `clearStatus` drops a stale fail(A) after begin(B) has already
    // bumped the epoch on the same (channel, threadTs). Regression shield
    // for the scenario the #688 epoch plumbing was designed to prevent.
    it("supersede race: fail(A) with A's old statusEpoch does NOT clear B's spinner", async () => {
      const client = makeClient();
      const setAssistantStatus = vi.fn().mockResolvedValue(undefined);
      const slackApi = {
        getClient: vi.fn().mockReturnValue(client),
        setAssistantStatus,
      } as any;
      const { AssistantStatusManager } = await import('../assistant-status-manager');
      const mgr = new AssistantStatusManager(slackApi);
      const surface = new TurnSurface({ slackApi, assistantStatusManager: mgr });
      let epochB = 0;
      try {
        // Turn A opens at epoch 1
        const epochA = mgr.bumpEpoch('C', 'thr');
        await surface.begin({
          channelId: 'C',
          threadTs: 'thr',
          sessionKey: 'C:thr',
          turnId: 't-A',
          statusEpoch: epochA,
        });

        // Turn B supersedes: bump epoch → begin(B) sets a fresh spinner
        epochB = mgr.bumpEpoch('C', 'thr');
        await surface.begin({
          channelId: 'C',
          threadTs: 'thr',
          sessionKey: 'C:thr',
          turnId: 't-B',
          statusEpoch: epochB,
        });

        // Snapshot calls up to now — B just set its spinner. The
        // regression we're guarding: fail(A) below MUST NOT fire an empty
        // setAssistantStatus('') against this (channel, threadTs).
        const callsBeforeFail = setAssistantStatus.mock.calls.length;

        // A's in-flight path loses the race and fires fail(A) after B has
        // already started. With the #688 epoch guard, mgr.clearStatus
        // drops the stale clear silently.
        await surface.fail('t-A', new Error('superseded'));

        const clearCalls = setAssistantStatus.mock.calls.slice(callsBeforeFail).filter(([, , text]) => text === '');
        expect(clearCalls).toHaveLength(0);

        // Sanity: the initial begin(A) + begin(B) setStatus writes landed.
        expect(callsBeforeFail).toBeGreaterThanOrEqual(2);
      } finally {
        // Drain B's live 20s heartbeat so the test doesn't leak a Node
        // timer into the vitest worker. (A's heartbeat shares the same
        // (channel,threadTs) key — one clearStatus covers both.)
        if (epochB) await mgr.clearStatus('C', 'thr', { expectedEpoch: epochB });
      }
    });
  });

  // -------------------------------------------------------------------------
  // #667 P5 — B5 completion marker absorption
  //
  // TurnSurface becomes the single writer for Slack-thread WorkflowComplete
  // B5 messages at PHASE>=5. The event snapshot is produced by a caller-
  // provided `buildCompletionEvent` closure on TurnContext. The send is
  // gated by `isCompletionMarkerActive` capability closure on deps.
  // -------------------------------------------------------------------------
  describe('B5 completion marker (#667 P5)', () => {
    function makeBlockKitChannel() {
      return { send: vi.fn().mockResolvedValue(undefined) };
    }

    function makeEvent() {
      return {
        category: 'WorkflowComplete' as const,
        userId: 'U1',
        channel: 'C1',
        threadTs: 't1.0',
        sessionTitle: 'Session X',
        durationMs: 1234,
      };
    }

    it("end('completed') + capability active + builder returns event → send called once with the event", async () => {
      const client = makeClient();
      const channel = makeBlockKitChannel();
      const surface = new TurnSurface({
        slackApi: makeSlackApi(client),
        slackBlockKitChannel: channel as any,
        isCompletionMarkerActive: () => true,
      } as any);

      const evt = makeEvent();
      const ctx = {
        channelId: 'C1',
        threadTs: 't1.0',
        sessionKey: 'C1:t1.0',
        turnId: 'C1:t1.0:b5-1',
        buildCompletionEvent: () => Promise.resolve(evt),
      };
      await surface.begin(ctx as any);
      await surface.end(ctx.turnId, 'completed');

      expect(channel.send).toHaveBeenCalledTimes(1);
      expect(channel.send).toHaveBeenCalledWith(evt);
    });

    it("end('completed') + capability active + builder returns undefined → send not called", async () => {
      const client = makeClient();
      const channel = makeBlockKitChannel();
      const surface = new TurnSurface({
        slackApi: makeSlackApi(client),
        slackBlockKitChannel: channel as any,
        isCompletionMarkerActive: () => true,
      } as any);

      const ctx = {
        channelId: 'C1',
        threadTs: 't1.0',
        sessionKey: 'C1:t1.0',
        turnId: 'C1:t1.0:b5-2',
        buildCompletionEvent: () => Promise.resolve(undefined),
      };
      await surface.begin(ctx as any);
      await surface.end(ctx.turnId, 'completed');

      expect(channel.send).not.toHaveBeenCalled();
    });

    it("end('completed') + capability inactive → send not called", async () => {
      const client = makeClient();
      const channel = makeBlockKitChannel();
      const surface = new TurnSurface({
        slackApi: makeSlackApi(client),
        slackBlockKitChannel: channel as any,
        isCompletionMarkerActive: () => false,
      } as any);

      const ctx = {
        channelId: 'C1',
        threadTs: 't1.0',
        sessionKey: 'C1:t1.0',
        turnId: 'C1:t1.0:b5-3',
        buildCompletionEvent: () => Promise.resolve(makeEvent()),
      };
      await surface.begin(ctx as any);
      await surface.end(ctx.turnId, 'completed');

      expect(channel.send).not.toHaveBeenCalled();
    });

    it("end('completed') + no builder on ctx → send not called", async () => {
      const client = makeClient();
      const channel = makeBlockKitChannel();
      const surface = new TurnSurface({
        slackApi: makeSlackApi(client),
        slackBlockKitChannel: channel as any,
        isCompletionMarkerActive: () => true,
      } as any);

      // No `buildCompletionEvent` on ctx.
      const ctx = {
        channelId: 'C1',
        threadTs: 't1.0',
        sessionKey: 'C1:t1.0',
        turnId: 'C1:t1.0:b5-4',
      };
      await surface.begin(ctx as any);
      await surface.end(ctx.turnId, 'completed');

      expect(channel.send).not.toHaveBeenCalled();
    });

    it('fail(err) → send not called (unconditional, regardless of capability)', async () => {
      const client = makeClient();
      const channel = makeBlockKitChannel();
      const surface = new TurnSurface({
        slackApi: makeSlackApi(client),
        slackBlockKitChannel: channel as any,
        isCompletionMarkerActive: () => true,
      } as any);

      const ctx = {
        channelId: 'C1',
        threadTs: 't1.0',
        sessionKey: 'C1:t1.0',
        turnId: 'C1:t1.0:b5-fail',
        buildCompletionEvent: () => Promise.resolve(makeEvent()),
      };
      await surface.begin(ctx as any);
      await surface.fail(ctx.turnId, new Error('boom'));

      expect(channel.send).not.toHaveBeenCalled();
    });

    it("end('aborted') → send not called", async () => {
      const client = makeClient();
      const channel = makeBlockKitChannel();
      const surface = new TurnSurface({
        slackApi: makeSlackApi(client),
        slackBlockKitChannel: channel as any,
        isCompletionMarkerActive: () => true,
      } as any);

      const ctx = {
        channelId: 'C1',
        threadTs: 't1.0',
        sessionKey: 'C1:t1.0',
        turnId: 'C1:t1.0:b5-abort',
        buildCompletionEvent: () => Promise.resolve(makeEvent()),
      };
      await surface.begin(ctx as any);
      await surface.end(ctx.turnId, 'aborted');

      expect(channel.send).not.toHaveBeenCalled();
    });

    it('send throwing does not prevent cleanupTurn (state removed, activeTurn cleared)', async () => {
      const client = makeClient();
      const channel = { send: vi.fn().mockRejectedValue(new Error('slack down')) };
      const surface = new TurnSurface({
        slackApi: makeSlackApi(client),
        slackBlockKitChannel: channel as any,
        isCompletionMarkerActive: () => true,
      } as any);

      const ctx = {
        channelId: 'C1',
        threadTs: 't1.0',
        sessionKey: 'C1:t1.0',
        turnId: 'C1:t1.0:b5-throw',
        buildCompletionEvent: () => Promise.resolve(makeEvent()),
      };
      await surface.begin(ctx as any);
      await surface.end(ctx.turnId, 'completed');

      expect(channel.send).toHaveBeenCalledTimes(1);
      // Cleanup ran — in-memory state removed.
      expect(surface._hasActiveTurn(ctx.sessionKey)).toBe(false);
      expect(surface._getTurnStateSnapshot(ctx.turnId)).toBeUndefined();
    });

    it('PHASE<5 regression: capability returning false (raw<5) → no send (legacy behavior preserved)', async () => {
      const client = makeClient();
      const channel = makeBlockKitChannel();
      const surface = new TurnSurface({
        slackApi: makeSlackApi(client),
        slackBlockKitChannel: channel as any,
        // Capability correctly reports false when raw<5.
        isCompletionMarkerActive: () => false,
      } as any);

      const ctx = {
        channelId: 'C1',
        threadTs: 't1.0',
        sessionKey: 'C1:t1.0',
        turnId: 'C1:t1.0:b5-legacy',
        buildCompletionEvent: () => Promise.resolve(makeEvent()),
      };
      await surface.begin(ctx as any);
      await surface.end(ctx.turnId, 'completed');

      expect(channel.send).not.toHaveBeenCalled();
    });

    // -------------------------------------------------------------------------
    // Issue #720 — P5 B5 race fix (Promise snapshot + await + 3s timeout)
    //
    // PR #711 regressed B5 at PHASE=5 because `TurnSurface.end` read the
    // completion snapshot synchronously while `stream-executor.enrichAndNotify`
    // assigned it asynchronously after `stopStream` had already closed. The
    // fix converts `buildCompletionEvent` to return a Promise, and `end()`
    // `await`s the snapshot (bounded by a 3s timeout). These two regression
    // tests lock in the new contract.
    // -------------------------------------------------------------------------

    it('#720 (d) snapshot resolves AFTER closeStream (delayed by 100ms) → end() awaits → send called with event', async () => {
      const client = makeClient();
      const channel = makeBlockKitChannel();
      const surface = new TurnSurface({
        slackApi: makeSlackApi(client),
        slackBlockKitChannel: channel as any,
        isCompletionMarkerActive: () => true,
      } as any);

      // Simulate stream-executor's snapshot Promise: resolver is held by
      // the "enrich" side; TurnSurface.end must await the pending Promise.
      let resolveSnapshot!: (evt: ReturnType<typeof makeEvent> | undefined) => void;
      const snapshotPromise = new Promise<ReturnType<typeof makeEvent> | undefined>((resolve) => {
        resolveSnapshot = resolve;
      });

      const evt = makeEvent();
      const ctx = {
        channelId: 'C1',
        threadTs: 't1.0',
        sessionKey: 'C1:t1.0',
        turnId: 'C1:t1.0:b5-race-d',
        buildCompletionEvent: () => snapshotPromise,
      };
      await surface.begin(ctx as any);

      // Kick off end() — it should proceed through closeStream + clearStatus,
      // then suspend awaiting `buildCompletionEvent()`.
      let endSettled = false;
      const endPromise = surface.end(ctx.turnId, 'completed').finally(() => {
        endSettled = true;
      });

      // Give microtasks + the mocked stopStream/appendStream chain time to
      // drain so we're parked at the snapshot await.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      // Lock-in: end() MUST still be pending because buildCompletionEvent()
      // hasn't resolved. A naive sync-read implementation would have
      // returned by now — this guard would flag that regression even if
      // `send` was somehow called with the unresolved Promise object.
      expect(endSettled).toBe(false);
      expect(channel.send).not.toHaveBeenCalled();

      // Now the async enrichment completes — snapshot resolves late, and
      // end() must pick it up and post B5.
      setTimeout(() => resolveSnapshot(evt), 0);

      await endPromise;

      expect(endSettled).toBe(true);
      expect(channel.send).toHaveBeenCalledTimes(1);
      expect(channel.send).toHaveBeenCalledWith(evt);
    });

    it('#720 (e) snapshot never resolves → 3s timeout elapses → evt undefined → send not called + warn logged', async () => {
      vi.useFakeTimers();
      try {
        const client = makeClient();
        const channel = makeBlockKitChannel();
        const surface = new TurnSurface({
          slackApi: makeSlackApi(client),
          slackBlockKitChannel: channel as any,
          isCompletionMarkerActive: () => true,
        } as any);

        const loggerWarnSpy = vi.spyOn((surface as any).logger, 'warn');

        // Snapshot Promise never resolves — simulates enrichAndResolve hang.
        const snapshotPromise = new Promise<ReturnType<typeof makeEvent> | undefined>(() => {
          /* never settle */
        });

        const ctx = {
          channelId: 'C1',
          threadTs: 't1.0',
          sessionKey: 'C1:t1.0',
          turnId: 'C1:t1.0:b5-timeout-e',
          buildCompletionEvent: () => snapshotPromise,
        };
        await surface.begin(ctx as any);

        const endPromise = surface.end(ctx.turnId, 'completed');

        // Advance past the 3s timeout — end()'s Promise.race resolves
        // to `undefined` via the timeout branch.
        await vi.advanceTimersByTimeAsync(3000);
        await endPromise;

        expect(channel.send).not.toHaveBeenCalled();

        // Warn logged with the turnId + timeout signature. We don't assert
        // an exact message to avoid coupling to phrasing; the turnId is
        // enough to verify the B5-specific warn fired.
        const b5Warns = loggerWarnSpy.mock.calls.filter((args) =>
          JSON.stringify(args).includes('C1:t1.0:b5-timeout-e'),
        );
        expect(b5Warns.length).toBeGreaterThanOrEqual(1);
      } finally {
        vi.useRealTimers();
      }
    });

    // -------------------------------------------------------------------------
    // Turn-end surface guarantee — C-2 (snapshot-resolved signal)
    //
    // Pre-fix behavior: `end()` returned `Promise<void>`, so a snapshot
    // timeout was indistinguishable from a normal completion to the caller
    // (StreamExecutor). With no signal, StreamExecutor couldn't fire a
    // fallback `turnNotifier.notify()` — the turn ended with no card on
    // any channel (the silent B5 drop).
    //
    // Fix: `end()` returns `{ snapshotResolved: boolean }` so the caller
    // can react to a missed B5 by posting a fallback notify.
    // -------------------------------------------------------------------------

    it('C-2: end() reports snapshotResolved=false when buildCompletionEvent times out', async () => {
      vi.useFakeTimers();
      try {
        const client = makeClient();
        const channel = makeBlockKitChannel();
        const surface = new TurnSurface({
          slackApi: makeSlackApi(client),
          slackBlockKitChannel: channel as any,
          isCompletionMarkerActive: () => true,
        } as any);

        const snapshotPromise = new Promise<ReturnType<typeof makeEvent> | undefined>(() => {
          /* never settle */
        });

        const ctx = {
          channelId: 'C1',
          threadTs: 't1.0',
          sessionKey: 'C1:t1.0',
          turnId: 'C1:t1.0:c2-signal',
          buildCompletionEvent: () => snapshotPromise,
        };
        await surface.begin(ctx as any);

        const endPromise = surface.end(ctx.turnId, 'completed') as unknown as Promise<{
          snapshotResolved: boolean;
        } | void>;

        await vi.advanceTimersByTimeAsync(3000);
        const result = await endPromise;

        // RED gate: pre-fix end() returns `void`.
        expect(result).toBeDefined();
        expect((result as any).snapshotResolved).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('C-2: end() reports snapshotResolved=true when buildCompletionEvent resolves in time', async () => {
      const client = makeClient();
      const channel = makeBlockKitChannel();
      const surface = new TurnSurface({
        slackApi: makeSlackApi(client),
        slackBlockKitChannel: channel as any,
        isCompletionMarkerActive: () => true,
      } as any);

      const evt = makeEvent();
      const ctx = {
        channelId: 'C1',
        threadTs: 't1.0',
        sessionKey: 'C1:t1.0',
        turnId: 'C1:t1.0:c2-resolved',
        buildCompletionEvent: () => Promise.resolve(evt),
      };
      await surface.begin(ctx as any);

      const result = (await surface.end(ctx.turnId, 'completed')) as unknown as {
        snapshotResolved: boolean;
      } | void;

      // RED gate: pre-fix end() returns `void`.
      expect(result).toBeDefined();
      expect((result as any).snapshotResolved).toBe(true);
    });

    it('C-2: end() reports snapshotResolved=true for non-completed reasons (no B5 expected)', async () => {
      // For `reason !== 'completed'`, B5 emit is deliberately skipped. The
      // signal should still resolve to `true` (not a "missed snapshot") so
      // StreamExecutor does NOT post a spurious fallback notify on an
      // aborted turn.
      const client = makeClient();
      const channel = makeBlockKitChannel();
      const surface = new TurnSurface({
        slackApi: makeSlackApi(client),
        slackBlockKitChannel: channel as any,
        isCompletionMarkerActive: () => true,
      } as any);

      const ctx = {
        channelId: 'C1',
        threadTs: 't1.0',
        sessionKey: 'C1:t1.0',
        turnId: 'C1:t1.0:c2-aborted',
        buildCompletionEvent: () => Promise.resolve(makeEvent()),
      };
      await surface.begin(ctx as any);

      const result = (await surface.end(ctx.turnId, 'aborted')) as unknown as {
        snapshotResolved: boolean;
      } | void;

      expect(result).toBeDefined();
      expect((result as any).snapshotResolved).toBe(true);
    });
  });
});
