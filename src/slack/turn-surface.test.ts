import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../config';
import { type TurnAddress, TurnSurface } from './turn-surface';

/**
 * TurnSurface unit tests (Issue #525, P1).
 *
 * Covers plan §7.1 cases:
 *   - begin → appendText → end order invariant (PHASE>=1)
 *   - fail() always calls stopStream with chunks-mode-compatible payload
 *   - concurrent turn supersede: begin(B) while A in-flight → fail(A)+begin(B)
 *   - PHASE=0 makes all calls a no-op
 *
 * Tests mutate `config.ui.fiveBlockPhase` directly because the value is read
 * per-call inside TurnSurface (see `phase()`), so the mutation takes effect
 * immediately. afterEach restores to the default 0 to keep isolation.
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
  const originalPhase = config.ui.fiveBlockPhase;

  afterEach(() => {
    config.ui.fiveBlockPhase = originalPhase;
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // PHASE>=1: core begin/appendText/end flow
  // -------------------------------------------------------------------------

  describe('PHASE>=1 B1 stream lifecycle', () => {
    beforeEach(() => {
      config.ui.fiveBlockPhase = 1;
    });

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
    beforeEach(() => {
      config.ui.fiveBlockPhase = 1;
    });

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
      // manually. The rollout plan (docs/slack-ui-phase1.md §Rollout
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
    beforeEach(() => {
      config.ui.fiveBlockPhase = 1;
    });

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
      config.ui.fiveBlockPhase = 1;
      const client = makeClient();
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      const ctx = { channelId: 'C1', threadTs: 't1', sessionKey: 'C1:t1', turnId: 'C1:t1:1' };
      await surface.begin(ctx);
      await expect(surface.appendText(ctx.turnId, 'ok')).resolves.toBe(true);
      await surface.end(ctx.turnId, 'completed');
    });

    it('returns false when PHASE<1 so caller takes the legacy path', async () => {
      config.ui.fiveBlockPhase = 0;
      const client = makeClient();
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      await expect(surface.appendText('any', 'hi')).resolves.toBe(false);
      expect(client.chat.appendStream).not.toHaveBeenCalled();
    });

    it('returns false when startStream failed (no streamTs) so caller falls back', async () => {
      config.ui.fiveBlockPhase = 1;
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
      config.ui.fiveBlockPhase = 1;
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
  // PHASE=0 fail-closed behavior
  // -------------------------------------------------------------------------

  describe('PHASE=0 fail-closed to legacy', () => {
    beforeEach(() => {
      config.ui.fiveBlockPhase = 0;
    });

    it('begin/appendText/end/fail all no-op and never touch Slack', async () => {
      const client = makeClient();
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      const ctx = { channelId: 'C1', threadTs: 't1', sessionKey: 'C1:t1', turnId: 'C1:t1:1' };
      await surface.begin(ctx);
      await surface.appendText(ctx.turnId, 'hi');
      await surface.end(ctx.turnId, 'completed');
      await surface.fail(ctx.turnId, new Error('x'));

      expect(client.chat.startStream).not.toHaveBeenCalled();
      expect(client.chat.appendStream).not.toHaveBeenCalled();
      expect(client.chat.stopStream).not.toHaveBeenCalled();
      expect(surface._hasActiveTurn(ctx.sessionKey)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Phase-gated B2/B3 placeholders
  // -------------------------------------------------------------------------

  describe('renderTasks / askUser placeholders', () => {
    it('renderTasks is a no-op below PHASE=2', async () => {
      config.ui.fiveBlockPhase = 1;
      const client = makeClient();
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });
      await expect(surface.renderTasks('any-turn', [{ id: '1' } as any])).resolves.toBe(false);
      // Placeholder must not initiate any Slack traffic in P1
      expect(client.chat.startStream).not.toHaveBeenCalled();
      expect(client.chat.appendStream).not.toHaveBeenCalled();
      expect(client.chat.postMessage).not.toHaveBeenCalled();
    });

    it('askUser returns empty string below PHASE=3', async () => {
      config.ui.fiveBlockPhase = 2;
      const client = makeClient();
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });
      const addr = { channelId: 'C1', threadTs: 't1', sessionKey: 'C1:t1' };
      await expect(surface.askUser('any-turn', { blocks: [] }, 'Q', addr)).resolves.toBe('');
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
      config.ui.fiveBlockPhase = 2;
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

    it('supersede: planTs on the old turn is intentionally orphaned (Slack message survives)', async () => {
      // Under PHASE>=2, the B2 plan message is a separate ts from B1 streamTs.
      // Supersede closes B1 (stream) but leaves B2 (plan) untouched — the
      // Slack message history keeps the final plan state visible to users.
      const client = makeClient({
        postMessage: vi.fn().mockResolvedValue({ ts: 'plan-ts-A' }),
      });
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      const sessionKey = 'C1:t1';
      const ctxA = { channelId: 'C1', threadTs: 't1', sessionKey, turnId: 'C1:t1:A' };
      const ctxB = { channelId: 'C1', threadTs: 't1', sessionKey, turnId: 'C1:t1:B' };

      await surface.begin(ctxA);
      await surface.renderTasks(ctxA.turnId, todos as any);
      await vi.advanceTimersByTimeAsync(500);
      expect(client.chat.postMessage).toHaveBeenCalledTimes(1);

      // Supersede — new turn opens; old plan message is not updated or deleted.
      await surface.begin(ctxB);

      // B1 stream for A was stopped (supersede), but B2 plan was NOT touched.
      expect(client.chat.stopStream).toHaveBeenCalledTimes(1);
      // chat.update against plan-ts-A did NOT fire.
      expect((client.chat.update?.mock.calls ?? []).some((call: any[]) => call[0]?.ts === 'plan-ts-A')).toBe(false);

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

    it('below PHASE=2 returns false and does not call postMessage', async () => {
      config.ui.fiveBlockPhase = 1;
      const client = makeClient();
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      await expect(
        surface.renderTasks('t', todos as any, { channelId: 'C', threadTs: 't', sessionKey: 'C:t' }),
      ).resolves.toBe(false);
      expect(client.chat.postMessage).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // B3 choice (P3) — askUser / askUserForm / resolveChoice / resolveMultiChoice
  // -------------------------------------------------------------------------

  describe('TurnSurface — P3 (PHASE>=3) B3 choice', () => {
    beforeEach(() => {
      config.ui.fiveBlockPhase = 3;
    });

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

    it('askUser returns empty string below PHASE=3', async () => {
      config.ui.fiveBlockPhase = 2;
      const { surface, client } = makeSurfaceWithApi();
      const addr: TurnAddress = { channelId: 'C', sessionKey: 'C:t' };
      const ts = await surface.askUser('turn-1', { blocks: [] }, 'Q?', addr);
      expect(ts).toBe('');
      expect(client.chat.postMessage).not.toHaveBeenCalled();
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

    it('askUserForm returns empty string below PHASE=3', async () => {
      config.ui.fiveBlockPhase = 2;
      const { surface } = makeSurfaceWithApi();
      const addr: TurnAddress = { channelId: 'C', sessionKey: 'C:t' };
      await expect(surface.askUserForm('t', { blocks: [] }, 'Q', addr)).resolves.toBe('');
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

    it('resolveChoice is a no-op below PHASE=3', async () => {
      config.ui.fiveBlockPhase = 2;
      const { surface, slackApi } = makeSurfaceWithApi();
      await surface.resolveChoice('C', 'msg-1', 'done', []);
      expect(slackApi.updateMessage).not.toHaveBeenCalled();
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

    it('resolveMultiChoice is a no-op below PHASE=3', async () => {
      config.ui.fiveBlockPhase = 2;
      const { surface, slackApi } = makeSurfaceWithApi();
      await surface.resolveMultiChoice('C', ['t1', 't2'], 'done', []);
      expect(slackApi.updateMessage).not.toHaveBeenCalled();
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

  // #689 P4 Part 2/2 — TurnSurface owns B4 native spinner at effective PHASE>=4
  describe('PHASE>=4 B4 native-status wiring', () => {
    const makeMgr = (enabled: boolean) => ({
      isEnabled: vi.fn().mockReturnValue(enabled),
      setStatus: vi.fn().mockResolvedValue(undefined),
      clearStatus: vi.fn().mockResolvedValue(undefined),
    });

    // Reset the module-level clamp-once flag so a disabled-mgr test in
    // this block doesn't leak state into subsequent tests. The flag lives
    // in `src/slack/pipeline/effective-phase.ts` and is test-only reset
    // via `__resetClampEmitted`.
    afterEach(async () => {
      const { __resetClampEmitted } = await import('./pipeline/effective-phase');
      __resetClampEmitted();
    });

    it('PHASE=4 + enabled: begin calls setStatus("is thinking...") once', async () => {
      config.ui.fiveBlockPhase = 4;
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

    it('PHASE=4 + enabled: end calls clearStatus once', async () => {
      config.ui.fiveBlockPhase = 4;
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
    it('PHASE=4 + enabled + statusEpoch: end forwards expectedEpoch to clearStatus', async () => {
      config.ui.fiveBlockPhase = 4;
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

    it('PHASE=4 + enabled + statusEpoch: fail forwards expectedEpoch to clearStatus', async () => {
      config.ui.fiveBlockPhase = 4;
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

    it('PHASE=4 + enabled: fail calls clearStatus (idempotent — fail twice → 1 call total)', async () => {
      config.ui.fiveBlockPhase = 4;
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

    it('PHASE=3: begin does NOT call setStatus (B4 gate)', async () => {
      config.ui.fiveBlockPhase = 3;
      const client = makeClient();
      const mgr = makeMgr(true);
      const surface = new TurnSurface({
        slackApi: makeSlackApi(client),
        assistantStatusManager: mgr as any,
      });
      await surface.begin({ channelId: 'C', threadTs: 'thr', sessionKey: 'C:thr', turnId: 't-no-b4' });
      expect(mgr.setStatus).not.toHaveBeenCalled();
    });

    it('PHASE=4 + disabled (clamped to 3): begin does NOT call setStatus', async () => {
      config.ui.fiveBlockPhase = 4;
      const client = makeClient();
      const mgr = makeMgr(false);
      const surface = new TurnSurface({
        slackApi: makeSlackApi(client),
        assistantStatusManager: mgr as any,
      });
      await surface.begin({
        channelId: 'C',
        threadTs: 'thr',
        sessionKey: 'C:thr',
        turnId: 't-b4-clamp',
      });
      expect(mgr.setStatus).not.toHaveBeenCalled();
    });
  });
});
