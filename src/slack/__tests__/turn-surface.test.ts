import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantStatusManager } from '../assistant-status-manager';
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

      const ctx = {
        channelId: 'C1',
        threadTs: 't1.0',
        sessionKey: 'C1:t1.0',
        turnId: 'C1:t1.0:1000',
      };
      await surface.begin(ctx);
      await surface.appendText(ctx.turnId, 'hello ');
      await surface.appendText(ctx.turnId, 'world');
      await surface.end(ctx.turnId, 'completed');

      // startStream called once with channel + thread_ts + the U10a plan
      // display mode (Slack defaults to 'timeline'; without this field the
      // native task chunks render as a timeline and no plan card appears).
      expect(client.chat.startStream).toHaveBeenCalledTimes(1);
      expect(client.chat.startStream).toHaveBeenCalledWith({
        channel: 'C1',
        thread_ts: 't1.0',
        task_display_mode: 'plan',
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

      const ctx = {
        channelId: 'D1',
        sessionKey: 'D1:root',
        turnId: 'D1:root:1000',
      };
      await surface.begin(ctx);
      await surface.end(ctx.turnId, 'completed');

      // thread_ts must NOT appear in startStream args — Slack treats its
      // absence as "open a new DM stream at root", which is the intent.
      // (task_display_mode is unconditional — see the U10a test above.)
      expect(client.chat.startStream).toHaveBeenCalledWith({ channel: 'D1', task_display_mode: 'plan' });
    });

    it('appendText is a no-op when startStream returned no ts', async () => {
      const client = makeClient({
        startStream: vi.fn().mockResolvedValue({
          /* no ts */
        }),
      });
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      const ctx = {
        channelId: 'C1',
        threadTs: 't1',
        sessionKey: 'C1:t1',
        turnId: 'C1:t1:1',
      };
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

      const ctx = {
        channelId: 'C1',
        threadTs: 't1',
        sessionKey: 'C1:t1',
        turnId: 'C1:t1:1',
      };
      await surface.begin(ctx);
      await surface.appendText(ctx.turnId, '');
      await surface.end(ctx.turnId, 'completed');

      expect(client.chat.appendStream).not.toHaveBeenCalled();
      expect(client.chat.stopStream).toHaveBeenCalledTimes(1);
    });

    it('appendText drops whitespace-only chunks', async () => {
      const client = makeClient();
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      const ctx = {
        channelId: 'C1',
        threadTs: 't1',
        sessionKey: 'C1:t1',
        turnId: 'C1:t1:1',
      };
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

      const ctx = {
        channelId: 'C1',
        threadTs: 't1',
        sessionKey: 'C1:t1',
        turnId: 'C1:t1:1',
      };
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

      const ctx = {
        channelId: 'C1',
        threadTs: 't1',
        sessionKey: 'C1:t1',
        turnId: 'C1:t1:1',
      };
      await surface.begin(ctx);
      await surface.end(ctx.turnId, 'completed');
      await surface.end(ctx.turnId, 'completed'); // should silently no-op

      expect(client.chat.stopStream).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Tail anchoring — the B1 stream is a thread message the panel must know about
  // -------------------------------------------------------------------------

  describe('thread-post notification', () => {
    it('announces the opened stream so the thread panel can re-anchor below it', async () => {
      const client = makeClient();
      const notifyThreadPost = vi.fn();
      const surface = new TurnSurface({
        slackApi: { getClient: vi.fn().mockReturnValue(client), notifyThreadPost } as any,
      });

      const ctx = { channelId: 'C1', threadTs: 't1.0', sessionKey: 'C1:t1.0', turnId: 'C1:t1.0:1' };
      await surface.begin(ctx);

      expect(notifyThreadPost).toHaveBeenCalledTimes(1);
      expect(notifyThreadPost).toHaveBeenCalledWith({
        channel: 'C1',
        threadTs: 't1.0',
        ts: 'stream-ts-1',
        kind: 'stream',
      });

      // The close APPENDS to that same message — nothing moved, nothing to say.
      await surface.end(ctx.turnId, 'completed');
      expect(notifyThreadPost).toHaveBeenCalledTimes(1);
    });

    it('says nothing when the stream never opened', async () => {
      const client = makeClient({ startStream: vi.fn().mockResolvedValue({}) });
      const notifyThreadPost = vi.fn();
      const surface = new TurnSurface({
        slackApi: { getClient: vi.fn().mockReturnValue(client), notifyThreadPost } as any,
      });

      await surface.begin({ channelId: 'C1', threadTs: 't1.0', sessionKey: 'C1:t1.0', turnId: 'C1:t1.0:1' });

      expect(notifyThreadPost).not.toHaveBeenCalled();
    });

    // Every raw `chat.postMessage` in this file is a message the panel cannot
    // see (it bypasses SlackApiHelper), so each one has to announce itself or
    // the panel silently stops being the last message in the thread.
    it('announces the B2 plan message posted outside the stream, and stays silent on its updates', async () => {
      vi.useFakeTimers();
      try {
        const client = makeClient({ postMessage: vi.fn().mockResolvedValue({ ts: 'plan-ts-adhoc' }) });
        const notifyThreadPost = vi.fn();
        const surface = new TurnSurface({
          slackApi: { getClient: vi.fn().mockReturnValue(client), notifyThreadPost } as any,
        });
        const address: TurnAddress = { channelId: 'C1', threadTs: 't1.0', sessionKey: 'C1:t1.0' };
        const todos = [{ id: '1', content: 'first', status: 'pending', priority: 'high' }];

        // No begin() → no stream → the plan goes out as its own message.
        await surface.renderTasks('ad-hoc-turn', todos as any, address);
        await vi.advanceTimersByTimeAsync(500);

        expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
        expect(notifyThreadPost).toHaveBeenCalledTimes(1);
        expect(notifyThreadPost).toHaveBeenCalledWith({
          channel: 'C1',
          threadTs: 't1.0',
          ts: 'plan-ts-adhoc',
          kind: 'post',
        });

        // A rerender UPDATES that message: nothing moved, nothing to announce.
        await surface.renderTasks('ad-hoc-turn', [
          ...todos,
          { id: '2', content: 'second', status: 'pending', priority: 'high' },
        ] as any);
        await vi.advanceTimersByTimeAsync(500);
        expect(client.chat.update).toHaveBeenCalled();
        expect(notifyThreadPost).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('announces an askUser choice post', async () => {
      const client = makeClient({ postMessage: vi.fn().mockResolvedValue({ ts: 'choice-ts' }) });
      const notifyThreadPost = vi.fn();
      const surface = new TurnSurface({
        slackApi: { getClient: vi.fn().mockReturnValue(client), notifyThreadPost } as any,
      });
      const address: TurnAddress = { channelId: 'C1', threadTs: 't1.0', sessionKey: 'C1:t1.0' };

      await surface.askUser('C1:t1.0:1', { blocks: [{ type: 'section' }] }, 'pick one', address);

      expect(notifyThreadPost).toHaveBeenCalledTimes(1);
      expect(notifyThreadPost).toHaveBeenCalledWith({
        channel: 'C1',
        threadTs: 't1.0',
        ts: 'choice-ts',
        kind: 'post',
      });
    });

    it('says nothing for a DM-root post that has no thread anchor', async () => {
      const client = makeClient({ postMessage: vi.fn().mockResolvedValue({ ts: 'dm-ts' }) });
      const notifyThreadPost = vi.fn();
      const surface = new TurnSurface({
        slackApi: { getClient: vi.fn().mockReturnValue(client), notifyThreadPost } as any,
      });

      await surface.askUser('D1::1', { blocks: [{ type: 'section' }] }, 'pick one', {
        channelId: 'D1',
        sessionKey: 'D1:',
      });

      expect(notifyThreadPost).not.toHaveBeenCalled();
    });

    it('works against a helper that has no hook at all', async () => {
      const client = makeClient();
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      await expect(
        surface.begin({ channelId: 'C1', threadTs: 't1.0', sessionKey: 'C1:t1.0', turnId: 'C1:t1.0:1' }),
      ).resolves.toBeUndefined();
      expect(client.chat.startStream).toHaveBeenCalledTimes(1);
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

      const ctx = {
        channelId: 'C1',
        threadTs: 't1',
        sessionKey: 'C1:t1',
        turnId: 'C1:t1:1',
      };
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

      const ctx = {
        channelId: 'C1',
        threadTs: 't1',
        sessionKey: 'C1:t1',
        turnId: 'C1:t1:1',
      };
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

      const ctx = {
        channelId: 'C1',
        threadTs: 't1',
        sessionKey: 'C1:t1',
        turnId: 'C1:t1:1',
      };
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
      const ctxA = {
        channelId: 'C1',
        threadTs: 't1',
        sessionKey,
        turnId: 'C1:t1:A',
      };
      const ctxB = {
        channelId: 'C1',
        threadTs: 't1',
        sessionKey,
        turnId: 'C1:t1:B',
      };

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

      const ctx = {
        channelId: 'C1',
        threadTs: 't1',
        sessionKey: 'C1:t1',
        turnId: 'C1:t1:1',
      };
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
      const ctxA = {
        channelId: 'C1',
        threadTs: 't1',
        sessionKey,
        turnId: 'C1:t1:A',
      };
      const ctxB = {
        channelId: 'C1',
        threadTs: 't1',
        sessionKey,
        turnId: 'C1:t1:B',
      };

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

      const ctx = {
        channelId: 'C1',
        threadTs: 't1',
        sessionKey: 'C1:t1',
        turnId: 'C1:t1:1',
      };
      await surface.begin(ctx);
      await expect(surface.appendText(ctx.turnId, 'ok')).resolves.toBe(true);
      await surface.end(ctx.turnId, 'completed');
    });

    it('returns false when startStream failed (no streamTs) so caller falls back', async () => {
      const client = makeClient({
        startStream: vi.fn().mockRejectedValue(new Error('slack 500')),
      });
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      const ctx = {
        channelId: 'C1',
        threadTs: 't1',
        sessionKey: 'C1:t1',
        turnId: 'C1:t1:1',
      };
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

      const ctx = {
        channelId: 'C1',
        threadTs: 't1',
        sessionKey: 'C1:t1',
        turnId: 'C1:t1:1',
      };
      await surface.begin(ctx);
      await expect(surface.appendText(ctx.turnId, 'reply')).resolves.toBe(false);
      await surface.end(ctx.turnId, 'completed');
    });
  });

  // -------------------------------------------------------------------------
  // B2 plan block (P2) — renderTasks
  // -------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // B2 task surface (P2, re-pointed by U10a)
  //
  // U10a unified the two progress surfaces: a turn that owns a stream now
  // renders its task list as native `plan_update` / `task_update` chunks
  // INSIDE that stream, so `chat.postMessage` + `chat.update` are no longer
  // part of the contract for those turns. The separate plan message survives
  // ONLY where there is no stream to write into (ad-hoc renderTasks before
  // begin()), and those cases are asserted unchanged below.
  // ---------------------------------------------------------------------------
  describe('renderTasks (PHASE>=2)', () => {
    const todos = [
      { id: '1', content: 'done task', status: 'completed', priority: 'high' },
      {
        id: '2',
        content: 'running task',
        status: 'in_progress',
        priority: 'high',
      },
      {
        id: '3',
        content: 'waiting task',
        status: 'pending',
        priority: 'medium',
      },
    ];

    /** `chat.appendStream` payloads carrying task_update chunks, in call order. */
    const taskAppends = (client: MockClient) =>
      client.chat.appendStream.mock.calls
        .map((call: any[]) => call[0])
        .filter((args: any) => (args?.chunks ?? []).some((c: any) => c.type === 'task_update'));

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('first call writes task chunks onto the turn’s own stream (no separate plan message)', async () => {
      const client = makeClient({
        postMessage: vi.fn().mockResolvedValue({ ts: 'plan-ts-1' }),
      });
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      const ctx = {
        channelId: 'C1',
        threadTs: 't1',
        sessionKey: 'C1:t1',
        turnId: 'C1:t1:1',
      };
      await surface.begin(ctx);
      await expect(surface.renderTasks(ctx.turnId, todos as any)).resolves.toBe(true);
      // Drain the 500ms debounce window.
      await vi.advanceTimersByTimeAsync(500);

      const appends = taskAppends(client);
      expect(appends.length).toBe(1);
      expect(appends[0].channel).toBe('C1');
      expect(appends[0].ts).toBe('stream-ts-1');
      expect(appends[0].chunks[0]).toEqual({ type: 'plan_update', title: 'Tasks (3)' });
      expect(appends[0].chunks.slice(1)).toEqual([
        { type: 'task_update', id: '1', title: 'done task', status: 'complete' },
        { type: 'task_update', id: '2', title: 'running task', status: 'in_progress' },
        { type: 'task_update', id: '3', title: 'waiting task', status: 'pending' },
      ]);
      // U10a: the second surface is gone — neither postMessage nor update.
      expect(client.chat.postMessage).not.toHaveBeenCalled();
      expect(client.chat.update).not.toHaveBeenCalled();

      await surface.end(ctx.turnId, 'completed');
    });

    it('second call reuses the same stream ts; an unchanged snapshot spends no write', async () => {
      const client = makeClient({
        postMessage: vi.fn().mockResolvedValue({ ts: 'plan-ts-1' }),
        update: vi.fn().mockResolvedValue(undefined),
      });
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      const ctx = {
        channelId: 'C1',
        threadTs: 't1',
        sessionKey: 'C1:t1',
        turnId: 'C1:t1:1',
      };
      await surface.begin(ctx);

      await surface.renderTasks(ctx.turnId, todos as any);
      await vi.advanceTimersByTimeAsync(500);
      expect(taskAppends(client).length).toBe(1);

      // Re-rendering the SAME snapshot is a no-op on the wire (TodoWrite
      // re-emits the full list every tick) — the pre-U10a plan message would
      // have burned a chat.update here.
      await surface.renderTasks(ctx.turnId, todos as any);
      await vi.advanceTimersByTimeAsync(500);
      expect(taskAppends(client).length).toBe(1);

      // A real state change writes again — same ts, still one surface.
      const advanced = todos.map((t) => (t.id === '2' ? { ...t, status: 'completed' } : t));
      await surface.renderTasks(ctx.turnId, advanced as any);
      await vi.advanceTimersByTimeAsync(500);

      const appends = taskAppends(client);
      expect(appends.length).toBe(2);
      expect(appends[1].ts).toBe('stream-ts-1');
      expect(appends[1].chunks).toContainEqual({
        type: 'task_update',
        id: '2',
        title: 'running task',
        status: 'complete',
      });
      expect(client.chat.postMessage).not.toHaveBeenCalled();
      expect(client.chat.update).not.toHaveBeenCalled();

      await surface.end(ctx.turnId, 'completed');
    });

    it('5 rapid calls coalesce into 1 trailing stream write (debounce)', async () => {
      const client = makeClient({
        postMessage: vi.fn().mockResolvedValue({ ts: 'plan-ts-1' }),
        update: vi.fn().mockResolvedValue(undefined),
      });
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      const ctx = {
        channelId: 'C1',
        threadTs: 't1',
        sessionKey: 'C1:t1',
        turnId: 'C1:t1:1',
      };
      await surface.begin(ctx);

      // First render — drain debounce so the baseline write is committed.
      await surface.renderTasks(ctx.turnId, todos as any);
      await vi.advanceTimersByTimeAsync(500);
      expect(taskAppends(client).length).toBe(1);

      // 5 rapid renders, each a distinct snapshot (so dedup can't be what
      // collapses them) — only the trailing one reaches Slack.
      for (let i = 0; i < 5; i += 1) {
        const tick = todos.map((t) => (t.id === '3' ? { ...t, content: `waiting task ${i}` } : t));
        await surface.renderTasks(ctx.turnId, tick as any);
      }
      await vi.advanceTimersByTimeAsync(500);

      const appends = taskAppends(client);
      expect(appends.length).toBe(2);
      // The LAST snapshot won (trailing edge), not an earlier tick.
      expect(appends[1].chunks).toContainEqual({
        type: 'task_update',
        id: '3',
        title: 'waiting task 4',
        status: 'pending',
      });
      expect(client.chat.update).not.toHaveBeenCalled();
      expect(client.chat.postMessage).not.toHaveBeenCalled();

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

      const ctx = {
        channelId: 'C1',
        threadTs: 't1',
        sessionKey: 'C1:t1',
        turnId: 'C1:t1:1',
      };
      await surface.begin(ctx);
      await expect(surface.renderTasks(ctx.turnId, [])).resolves.toBe(false);
      await vi.advanceTimersByTimeAsync(500);
      expect(client.chat.postMessage).not.toHaveBeenCalled();
      expect(client.chat.update).not.toHaveBeenCalled();

      await surface.end(ctx.turnId, 'completed');
    });

    it('supersede: the old turn’s task list is finalized (in_progress demoted) so no stale spinner', async () => {
      // The superseded turn's stream message stays in Slack history, so its
      // task list must stop claiming work is in flight. Supersede closes B1
      // AND writes ONE final chunk batch demoting any lingering `in_progress`
      // to `pending` — without it, Slack's native loading indicator keeps
      // spinning forever on the orphaned message ("hang state"). Nothing is
      // deleted: users still see the final task list, just without the
      // misleading spinner.
      const startStream = vi.fn().mockResolvedValueOnce({ ts: 'stream-A' }).mockResolvedValueOnce({ ts: 'stream-B' });
      const client = makeClient({
        startStream,
        postMessage: vi.fn().mockResolvedValue({ ts: 'plan-ts-A' }),
        update: vi.fn().mockResolvedValue(undefined),
      });
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      const sessionKey = 'C1:t1';
      const ctxA = {
        channelId: 'C1',
        threadTs: 't1',
        sessionKey,
        turnId: 'C1:t1:A',
      };
      const ctxB = {
        channelId: 'C1',
        threadTs: 't1',
        sessionKey,
        turnId: 'C1:t1:B',
      };

      await surface.begin(ctxA);
      await surface.renderTasks(ctxA.turnId, todos as any);
      await vi.advanceTimersByTimeAsync(500);
      expect(taskAppends(client).length).toBe(1);

      // Supersede — fail(A) runs synchronously inside begin(B).
      await surface.begin(ctxB);

      // B1 stream for A was stopped (supersede).
      expect(client.chat.stopStream).toHaveBeenCalledTimes(1);
      // A's stream received exactly one finalize write, with no in_progress
      // rows left, and it landed BEFORE the stop.
      const againstA = taskAppends(client).filter((args: any) => args.ts === 'stream-A');
      expect(againstA.length).toBe(2);
      expect(againstA[1].chunks.filter((c: any) => c.status === 'in_progress')).toEqual([]);
      expect(againstA[1].chunks).toContainEqual({
        type: 'task_update',
        id: '2',
        title: 'running task',
        status: 'pending',
      });
      const lastAppendToA = Math.max(...client.chat.appendStream.mock.invocationCallOrder);
      expect(lastAppendToA).toBeLessThan(client.chat.stopStream.mock.invocationCallOrder[0]);
      // No separate plan message was ever created for A.
      expect(client.chat.postMessage).not.toHaveBeenCalled();
      expect(client.chat.update).not.toHaveBeenCalled();

      await surface.end(ctxB.turnId, 'completed');
    });

    it('end(turnId) with ad-hoc entry does not call stopStream (no streamTs)', async () => {
      const client = makeClient({
        postMessage: vi.fn().mockResolvedValue({ ts: 'plan-ts-adhoc' }),
      });
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      const turnId = 'ad-hoc-end-test';
      await surface.renderTasks(turnId, todos as any, {
        channelId: 'C',
        threadTs: 't',
        sessionKey: 'C:t',
      });
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

    describe('end-of-turn finalize (demotes lingering in_progress tasks)', () => {
      it('end("completed") with a lingering in_progress todo writes one final demoted chunk batch before the stream stops', async () => {
        const client = makeClient({
          postMessage: vi.fn().mockResolvedValue({ ts: 'plan-ts-fin' }),
          update: vi.fn().mockResolvedValue(undefined),
        });
        const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

        const ctx = {
          channelId: 'C1',
          threadTs: 't1',
          sessionKey: 'C1:t1',
          turnId: 'C1:t1:fin',
        };
        await surface.begin(ctx);

        // Initial render — native chunks on the turn's own stream.
        await surface.renderTasks(ctx.turnId, todos as any);
        await vi.advanceTimersByTimeAsync(500);
        expect(taskAppends(client).length).toBe(1);
        expect(client.chat.postMessage).not.toHaveBeenCalled();
        expect(client.chat.update).not.toHaveBeenCalled();

        // Turn ends WITHOUT marking the in_progress todo as completed.
        await surface.end(ctx.turnId, 'completed');

        // Exactly ONE final write, on the same stream ts.
        const appends = taskAppends(client);
        expect(appends.length).toBe(2);
        expect(appends[1].channel).toBe('C1');
        expect(appends[1].ts).toBe('stream-ts-1');
        // Every in_progress arm of `todos` should be demoted to `pending`.
        expect(appends[1].chunks.filter((c: any) => c.status === 'in_progress')).toEqual([]);
        // The lingering todo's title is preserved as `pending` so users see WHAT
        // was left unfinished — no ghost spinner, no silent loss of context.
        expect(appends[1].chunks).toContainEqual({
          type: 'task_update',
          id: '2',
          title: 'running task',
          status: 'pending',
        });
        // Slack drops chunks written after the stop, so ordering is part of
        // the contract, not an implementation detail.
        const lastAppend = Math.max(...client.chat.appendStream.mock.invocationCallOrder);
        expect(lastAppend).toBeLessThan(client.chat.stopStream.mock.invocationCallOrder[0]);
      });

      it('end("completed") with all-completed todos does NOT issue an extra write (idempotent)', async () => {
        const allDoneTodos = todos.map((t) => ({ ...t, status: 'completed' }));
        const client = makeClient({
          postMessage: vi.fn().mockResolvedValue({ ts: 'plan-ts-alldone' }),
          update: vi.fn().mockResolvedValue(undefined),
        });
        const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

        const ctx = {
          channelId: 'C1',
          threadTs: 't1',
          sessionKey: 'C1:t1',
          turnId: 'C1:t1:alldone',
        };
        await surface.begin(ctx);
        await surface.renderTasks(ctx.turnId, allDoneTodos as any);
        await vi.advanceTimersByTimeAsync(500);
        expect(taskAppends(client).length).toBe(1);

        await surface.end(ctx.turnId, 'completed');

        // No final demotion render needed when nothing was in_progress.
        expect(taskAppends(client).length).toBe(1);
        expect(client.chat.update).not.toHaveBeenCalled();
        expect(client.chat.postMessage).not.toHaveBeenCalled();
      });

      it('fail() with a lingering in_progress todo also demotes the task list to pending', async () => {
        const client = makeClient({
          postMessage: vi.fn().mockResolvedValue({ ts: 'plan-ts-fail' }),
          update: vi.fn().mockResolvedValue(undefined),
        });
        const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

        const ctx = {
          channelId: 'C1',
          threadTs: 't1',
          sessionKey: 'C1:t1',
          turnId: 'C1:t1:fail',
        };
        await surface.begin(ctx);
        await surface.renderTasks(ctx.turnId, todos as any);
        await vi.advanceTimersByTimeAsync(500);

        await surface.fail(ctx.turnId, new Error('aborted'));

        const appends = taskAppends(client);
        expect(appends.length).toBe(2);
        expect(appends[1].ts).toBe('stream-ts-1');
        expect(appends[1].chunks.filter((c: any) => c.status === 'in_progress')).toEqual([]);
        expect(client.chat.update).not.toHaveBeenCalled();
      });

      it('end() without renderTasks ever called → no task write (nothing to finalize)', async () => {
        const client = makeClient();
        const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

        const ctx = {
          channelId: 'C1',
          threadTs: 't1',
          sessionKey: 'C1:t1',
          turnId: 'C1:t1:bare',
        };
        await surface.begin(ctx);
        // No renderTasks call — no task surface exists.
        await surface.end(ctx.turnId, 'completed');

        expect(client.chat.update).not.toHaveBeenCalled();
        expect(taskAppends(client)).toEqual([]);
      });

      it('supersede (begin B over A with A still in_progress) finalizes A’s tasks before B opens', async () => {
        // Supersede routes through fail(A) — A's task list must still get its
        // demotion write so the old stream message stops showing a spinner
        // before the new turn opens.
        const startStream = vi
          .fn()
          .mockResolvedValueOnce({ ts: 'stream-A2' })
          .mockResolvedValueOnce({ ts: 'stream-B2' });
        const client = makeClient({
          startStream,
          postMessage: vi.fn().mockResolvedValue({ ts: 'plan-ts-A' }),
          update: vi.fn().mockResolvedValue(undefined),
        });
        const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

        const sessionKey = 'C1:t1';
        const ctxA = {
          channelId: 'C1',
          threadTs: 't1',
          sessionKey,
          turnId: 'C1:t1:A2',
        };
        const ctxB = {
          channelId: 'C1',
          threadTs: 't1',
          sessionKey,
          turnId: 'C1:t1:B2',
        };

        await surface.begin(ctxA);
        await surface.renderTasks(ctxA.turnId, todos as any);
        await vi.advanceTimersByTimeAsync(500);

        // Supersede — fail(A) runs synchronously inside begin(B).
        await surface.begin(ctxB);

        const againstA = taskAppends(client).filter((args: any) => args.ts === 'stream-A2');
        expect(againstA.length).toBe(2);
        expect(againstA[1].chunks.filter((c: any) => c.status === 'in_progress')).toEqual([]);
        // The finalize landed on A's stream, never on B's.
        expect(taskAppends(client).filter((args: any) => args.ts === 'stream-B2')).toEqual([]);
        expect(client.chat.update).not.toHaveBeenCalled();

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
      const addr: TurnAddress = {
        channelId: 'C1',
        threadTs: 'thr-1',
        sessionKey: 'C1:thr-1',
      };
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
      await surface.begin({
        channelId: 'C',
        threadTs: 'thr',
        sessionKey: 'C:thr',
        turnId: 'turn-1',
      });
      const addr: TurnAddress = {
        channelId: 'C',
        threadTs: 'thr',
        sessionKey: 'C:thr',
      };
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
      await surface.begin({
        channelId: 'C',
        threadTs: 'thr',
        sessionKey: 'C:thr',
        turnId: 'turn-1',
      });
      const addr: TurnAddress = {
        channelId: 'C',
        threadTs: 'thr',
        sessionKey: 'C:thr',
      };
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
      slackApi.updateMessage = vi.fn().mockRejectedValue({
        data: { error: 'message_not_found' },
        message: 'gone',
      });
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
      await surface.begin({
        channelId: 'C',
        threadTs: 'thr',
        sessionKey: 'C:thr',
        turnId: 'turn-1',
      });
      const addr: TurnAddress = {
        channelId: 'C',
        threadTs: 'thr',
        sessionKey: 'C:thr',
      };
      await surface.askUser('turn-1', { blocks: [] }, 'Q', addr);
      await surface.end('turn-1', 'completed');
      expect(slackApi.updateMessage).not.toHaveBeenCalled();
    });
  });

  describe('native status during pending stream startup', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.clearAllTimers();
      vi.useRealTimers();
    });

    function makeStatusSurface(client: MockClient) {
      let remoteStatus = '';
      const setAssistantStatus = vi.fn(async (_channelId: string, _threadTs: string, status: string) => {
        await Promise.resolve();
        remoteStatus = status;
      });
      const slackApi = Object.assign(makeSlackApi(client), {
        setAssistantStatus,
        setAssistantTitle: vi.fn().mockResolvedValue(undefined),
      });
      const manager = new AssistantStatusManager(slackApi);
      const surface = new TurnSurface({
        slackApi,
        assistantStatusManager: manager,
      });
      return {
        surface,
        manager,
        setAssistantStatus,
        getRemoteStatus: () => remoteStatus,
      };
    }

    it.each([
      ['stopStream', 'end'],
      ['flush', 'end'],
      ['stopStream', 'supersede'],
      ['flush', 'supersede'],
      ['stopStream', 'duplicate'],
      ['flush', 'duplicate'],
    ] as const)('[prereg] pending A %s allows B %s without late startup', async (step, action) => {
      let releaseA: () => void = () => {};
      const pendingA = new Promise<void>((resolve) => {
        releaseA = resolve;
      });
      const client = makeClient();
      const { surface, manager, setAssistantStatus } = makeStatusSurface(client);
      const ctx = { channelId: 'C', threadTs: 'thr', sessionKey: 'C:thr', turnId: 'A' };
      await surface.begin(ctx);
      await vi.advanceTimersByTimeAsync(0);
      if (step === 'stopStream') client.chat.stopStream.mockReturnValueOnce(pendingA);
      else vi.spyOn((surface as any).renderDebouncer, 'flush').mockReturnValueOnce(pendingA);
      const setStatus = vi.spyOn(manager, 'setStatus');
      const bumpEpoch = vi.spyOn(manager, 'bumpEpoch');
      client.chat.startStream.mockClear();
      setAssistantStatus.mockClear();

      let beganB = false;
      const beginningB = surface.begin({ ...ctx, turnId: 'B' }).then(() => {
        beganB = true;
      });
      try {
        // Registration and the legacy epoch belong to B before any cleanup wait.
        expect.soft(surface._getActiveTurnId(ctx.sessionKey)).toBe('B');
        expect.soft(surface._getTurnStateSnapshot('B')).toMatchObject({ closing: false });
        expect.soft(bumpEpoch).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(5_001);
        expect(beganB).toBe(false);
        expect(setStatus).not.toHaveBeenCalled();
        expect(client.chat.startStream).not.toHaveBeenCalled();

        if (action === 'end') await surface.end('B', 'completed');
        else if (action === 'supersede') await surface.begin({ ...ctx, turnId: 'C' });
        else await surface.begin({ ...ctx, turnId: 'B' });

        if (action === 'duplicate') {
          expect.soft(setStatus).not.toHaveBeenCalled();
          expect.soft(client.chat.startStream).not.toHaveBeenCalled();
          expect.soft(bumpEpoch).toHaveBeenCalledTimes(1);
        } else {
          expect.soft(surface._getTurnStateSnapshot('B')).toBeUndefined();
        }

        releaseA();
        await beginningB;
        await vi.advanceTimersByTimeAsync(0);
        const expectedStarts = action === 'end' ? 0 : 1;
        // One live start gets initial status and the post-stream lifecycle refresh.
        expect.soft(setStatus).toHaveBeenCalledTimes(expectedStarts * 2);
        expect.soft(client.chat.startStream).toHaveBeenCalledTimes(expectedStarts);
        expect.soft(setAssistantStatus.mock.calls.filter(([, , text]) => text !== '')).toHaveLength(expectedStarts * 2);
        expect.soft(surface._getTurnStateSnapshot('A')).toBeUndefined();
        if (action === 'duplicate') {
          expect.soft(surface._getActiveTurnId(ctx.sessionKey)).toBe('B');
          expect.soft(surface._getTurnStateSnapshot('B')).toMatchObject({ streamTs: 'stream-ts-1', closing: false });
        } else {
          expect.soft(surface._getTurnStateSnapshot('B')).toBeUndefined();
          expect.soft(surface._getActiveTurnId(ctx.sessionKey)).toBe(action === 'supersede' ? 'C' : undefined);
        }
      } finally {
        releaseA();
        await beginningB;
        await surface.end('B', 'completed');
        await surface.end('C', 'completed');
        setStatus.mockRestore();
        bumpEpoch.mockRestore();
      }
      expect(surface._hasActiveTurn(ctx.sessionKey)).toBe(false);
    });

    it.each([
      'end',
      'fail',
    ] as const)('[review] %s times out waiting for a hung set but preserves eventual remote clear', async (method) => {
      let releaseSet: () => void = () => {};
      const pending = new Promise<void>((resolve) => {
        releaseSet = resolve;
      });
      let remoteStatus = '';
      const setAssistantStatus = vi.fn(async (_channel: string, _thread: string, text: string) => {
        if (text !== '') await pending;
        remoteStatus = text;
      });
      const client = makeClient();
      const slackApi = Object.assign(makeSlackApi(client), {
        setAssistantStatus,
        setAssistantTitle: vi.fn(),
      });
      const manager = new AssistantStatusManager(slackApi);
      const send = vi.fn().mockResolvedValue(undefined);
      const surface = new TurnSurface({
        slackApi,
        assistantStatusManager: manager,
        slackBlockKitChannel: { send },
        isCompletionMarkerActive: () => true,
      });
      const warn = vi.spyOn((surface as any).logger, 'warn');
      const event = {
        category: 'WorkflowComplete' as const,
        userId: 'U',
        channel: 'C',
        threadTs: 'thr',
        durationMs: 1,
      };
      const ctx = {
        channelId: 'C',
        threadTs: 'thr',
        sessionKey: 'C:thr',
        turnId: 'hung-close',
        buildCompletionEvent: async () => event,
      };
      await surface.begin(ctx);
      let closed = false;
      const closing = (
        method === 'end' ? surface.end(ctx.turnId, 'completed') : surface.fail(ctx.turnId, new Error('failed'))
      ).then(() => {
        closed = true;
      });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(closed).toBe(false);
      expect(setAssistantStatus).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect.soft(closed).toBe(true);
      expect.soft(surface._getTurnStateSnapshot(ctx.turnId)).toBeUndefined();
      expect.soft(surface._hasActiveTurn(ctx.sessionKey)).toBe(false);
      expect
        .soft(warn)
        .toHaveBeenCalledWith(expect.stringMatching(/B4.*(timeout|timed out|finish in time)/), expect.any(Object));
      expect.soft(send).toHaveBeenCalledTimes(method === 'end' ? 1 : 0);
      // Timeout only releases the surface waiter, never the manager writer lane.
      await vi.advanceTimersByTimeAsync(40_000);
      expect(setAssistantStatus).toHaveBeenCalledTimes(1);
      releaseSet();
      await vi.advanceTimersByTimeAsync(0);
      await closing;
      expect(remoteStatus).toBe('');
      expect(setAssistantStatus.mock.calls.map(([, , text]) => text)).toEqual(['is thinking...', '']);
      await vi.advanceTimersByTimeAsync(40_000);
      expect(setAssistantStatus).toHaveBeenCalledTimes(2);
    });

    it('[T1] a hung native status request does not delay stream startup or begin completion', async () => {
      const client = makeClient();
      const { surface, setAssistantStatus } = makeStatusSurface(client);
      let releaseStatus: () => void = () => {};
      setAssistantStatus.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseStatus = resolve;
          }),
      );
      const ctx = {
        channelId: 'C',
        threadTs: 'thr',
        sessionKey: 'C:thr',
        turnId: 'hung-status',
      };
      let began = false;
      const beginning = surface.begin(ctx).then(() => {
        began = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect.soft(client.chat.startStream).toHaveBeenCalledTimes(1);
      expect.soft(began).toBe(true);
      releaseStatus();
      await beginning;
      await surface.end(ctx.turnId, 'completed');
    });

    it.each(['end', 'fail'] as const)('[T2] %s clears immediately while stopStream is pending', async (method) => {
      let releaseStop: () => void = () => {};
      const stopPromise = new Promise<void>((resolve) => {
        releaseStop = resolve;
      });
      const client = makeClient({
        stopStream: vi.fn().mockReturnValue(stopPromise),
      });
      const { surface, manager, getRemoteStatus, setAssistantStatus } = makeStatusSurface(client);
      const ctx = {
        channelId: 'C',
        threadTs: 'thr',
        sessionKey: 'C:thr',
        turnId: 'pending-stop',
        statusEpoch: manager.bumpEpoch('C', 'thr'),
      };
      await surface.begin(ctx);
      const closing =
        method === 'end' ? surface.end(ctx.turnId, 'completed') : surface.fail(ctx.turnId, new Error('failure'));
      await manager.setStatus('C', 'thr', 'late work', {
        expectedEpoch: ctx.statusEpoch,
      });
      await vi.advanceTimersByTimeAsync(40_000);
      expect.soft(getRemoteStatus()).toBe('');
      expect.soft(setAssistantStatus.mock.calls.map(([, , status]) => status)).toEqual(['is thinking...', '']);
      releaseStop();
      await closing;
      expect(surface._getTurnStateSnapshot(ctx.turnId)).toBeUndefined();
    });

    it.each([
      ['end', 'flush'],
      ['fail', 'flush'],
      ['end', 'finalize'],
      ['fail', 'finalize'],
    ] as const)('[T2] %s cleans up even when pending %s rejects', async (method, step) => {
      const { surface, getRemoteStatus } = makeStatusSurface(makeClient());
      const ctx = {
        channelId: 'C',
        threadTs: 'thr',
        sessionKey: 'C:thr',
        turnId: 'flush-failure',
      };
      await surface.begin(ctx);
      let rejectFlush: (error: Error) => void = () => {};
      const flushing = new Promise<void>((_resolve, reject) => {
        rejectFlush = reject;
      });
      if (step === 'flush') vi.spyOn((surface as any).renderDebouncer, 'flush').mockReturnValue(flushing);
      // Renamed from `finalizePlanIfNeeded` when the task finalize stopped being
      // plan-message-only (U10a native task chunks); same close-path step.
      else vi.spyOn(surface as any, 'finalizeTasksIfNeeded').mockReturnValue(flushing);
      const closing = (
        method === 'end' ? surface.end(ctx.turnId, 'completed') : surface.fail(ctx.turnId, new Error('failure'))
      ).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(0);
      expect.soft(getRemoteStatus()).toBe('');
      rejectFlush(new Error('flush failed'));
      await closing;
      expect(surface._getTurnStateSnapshot(ctx.turnId)).toBeUndefined();
      expect(surface._hasActiveTurn(ctx.sessionKey)).toBe(false);
    });

    it('[T1] native status starts while startStream is still pending', async () => {
      let releaseStart: (value: { ts: string }) => void = () => {};
      const startPromise = new Promise<{ ts: string }>((resolve) => {
        releaseStart = resolve;
      });
      const client = makeClient({
        startStream: vi.fn().mockReturnValue(startPromise),
      });
      const { surface, setAssistantStatus, getRemoteStatus } = makeStatusSurface(client);
      const ctx = {
        channelId: 'C',
        threadTs: 'thr',
        sessionKey: 'C:thr',
        turnId: 'pending-start',
      };
      const beginning = surface.begin(ctx);

      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(client.chat.startStream).toHaveBeenCalledTimes(1);
        expect.soft(getRemoteStatus()).toBe('is thinking...');
        expect.soft(setAssistantStatus).toHaveBeenCalledWith('C', 'thr', 'is thinking...');
      } finally {
        releaseStart({ ts: 'stream-ts-1' });
        await beginning;
        await surface.end(ctx.turnId, 'completed');
      }
    });

    it('[T1] late rejected startStream after end cannot resurrect native status', async () => {
      let rejectStart: (error: Error) => void = () => {};
      const startPromise = new Promise<{ ts: string }>((_resolve, reject) => {
        rejectStart = reject;
      });
      const client = makeClient({
        startStream: vi.fn().mockReturnValue(startPromise),
      });
      const { surface, setAssistantStatus, getRemoteStatus } = makeStatusSurface(client);
      const ctx = {
        channelId: 'C',
        threadTs: 'thr',
        sessionKey: 'C:thr',
        turnId: 'rejected-start',
      };
      const beginning = surface.begin(ctx);
      await vi.advanceTimersByTimeAsync(0);
      await surface.end(ctx.turnId, 'completed');
      expect(surface._getTurnStateSnapshot(ctx.turnId)).toBeUndefined();
      expect(surface._hasActiveTurn(ctx.sessionKey)).toBe(false);
      expect(getRemoteStatus()).toBe('');
      const callsAfterEnd = setAssistantStatus.mock.calls.length;

      rejectStart(new Error('late startStream failure'));
      await beginning;
      expect.soft(getRemoteStatus()).toBe('');
      expect.soft(setAssistantStatus).toHaveBeenCalledTimes(callsAfterEnd);

      await vi.advanceTimersByTimeAsync(40_000);
      expect.soft(getRemoteStatus()).toBe('');
      expect(setAssistantStatus).toHaveBeenCalledTimes(callsAfterEnd);
    });
  });

  // #689 P4 Part 2/2 — TurnSurface owns B4 native spinner.
  describe('B4 native-status wiring', () => {
    const makeMgr = (enabled: boolean) => ({
      isEnabled: vi.fn().mockReturnValue(enabled),
      bumpEpoch: vi.fn().mockReturnValue(1),
      setStatus: vi.fn().mockResolvedValue(undefined),
      clearStatus: vi.fn().mockResolvedValue(undefined),
    });

    it('begin sets status before startup and refreshes it after stream creation', async () => {
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
        turnId: 't-b4',
      });
      expect(mgr.setStatus).toHaveBeenCalledTimes(2);
      expect(mgr.bumpEpoch).toHaveBeenCalledWith('C', 'thr');
      expect(mgr.setStatus).toHaveBeenCalledWith('C', 'thr', 'is thinking...', {
        expectedEpoch: 1,
      });
    });

    it('end calls clearStatus once', async () => {
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
        turnId: 't-b4-e',
      });
      await surface.end('t-b4-e', 'completed');
      expect(mgr.clearStatus).toHaveBeenCalledTimes(1);
      // Legacy callers receive a turn epoch at begin, shared by set and clear.
      expect(mgr.clearStatus).toHaveBeenCalledWith('C', 'thr', {
        expectedEpoch: 1,
      });
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
      expect(mgr.clearStatus).toHaveBeenCalledWith('C', 'thr', {
        expectedEpoch: 7,
      });
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
      expect(mgr.clearStatus).toHaveBeenCalledWith('C', 'thr', {
        expectedEpoch: 11,
      });
    });

    it('fail calls clearStatus (idempotent — fail twice → 1 call total)', async () => {
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
        turnId: 't-b4-f',
      });
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
      const surface = new TurnSurface({
        slackApi,
        assistantStatusManager: mgr,
      });
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
      const channel = {
        send: vi.fn().mockRejectedValue(new Error('slack down')),
      };
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

  // -------------------------------------------------------------------------
  // A32 — consolidated completion close ("답변 보존 방식")
  //
  // The B5 result blocks + feedback row land on the SAME streamed message at
  // stream close (`chat.stopStream` blocks are APPENDED by Slack), so the
  // original answer is never deleted, overwritten or duplicated. The separate
  // detached `slackBlockKitChannel.send()` card survives only as the fallback
  // for a Slack refusal of the appended blocks, for channels that don't expose
  // the pure block builder, and for the no-stream path.
  // -------------------------------------------------------------------------
  describe('A32 consolidated completion close', () => {
    const COMPLETION_BLOCKS = [{ type: 'section', text: { type: 'mrkdwn', text: '✅ *작업 완료*' } }];

    function makeEvent() {
      return {
        category: 'WorkflowComplete' as const,
        userId: 'U1',
        channel: 'C1',
        threadTs: 't1.0',
        turnId: 'C1:t1.0:a32',
        sessionTitle: 'Session X',
      };
    }

    /** Channel double that DOES expose the A32 optional deps. */
    function makeConsolidatingChannel() {
      return {
        send: vi.fn().mockResolvedValue(undefined),
        buildCompletionBlocks: vi.fn().mockReturnValue({
          blocks: COMPLETION_BLOCKS,
          fallbackText: 'Session X',
          withFeedback: true,
        }),
        protectMessageTs: vi.fn(),
      };
    }

    function makeSurface(client: MockClient, channel: any) {
      return new TurnSurface({
        slackApi: makeSlackApi(client),
        slackBlockKitChannel: channel,
        isCompletionMarkerActive: () => true,
      } as any);
    }

    function makeCtx(turnId: string, evt: ReturnType<typeof makeEvent>) {
      return {
        channelId: 'C1',
        threadTs: 't1.0',
        sessionKey: 'C1:t1.0',
        turnId,
        buildCompletionEvent: () => Promise.resolve(evt),
      };
    }

    it('closes the stream ONCE with chunks:[] + completion blocks + a dismiss-less feedback row, and does not send a second card', async () => {
      const client = makeClient();
      const channel = makeConsolidatingChannel();
      const surface = makeSurface(client, channel);
      const evt = makeEvent();
      const ctx = makeCtx('C1:t1.0:a32-1', evt);

      await surface.begin(ctx as any);
      await surface.end(ctx.turnId, 'completed');

      expect(channel.buildCompletionBlocks).toHaveBeenCalledWith(evt);
      expect(client.chat.stopStream).toHaveBeenCalledTimes(1);
      const payload = client.chat.stopStream.mock.calls[0][0];
      expect(payload.channel).toBe('C1');
      expect(payload.ts).toBe('stream-ts-1');
      expect(payload.chunks).toEqual([]);
      expect(payload.blocks.slice(0, 1)).toEqual(COMPLETION_BLOCKS);

      const feedbackRow = payload.blocks[payload.blocks.length - 1];
      expect(feedbackRow.type).toBe('context_actions');
      expect(feedbackRow.block_id).toBe('turn_feedback_v1:C1:t1.0:a32');
      // No dismiss: deleting the host message would delete the answer.
      expect(feedbackRow.elements).toHaveLength(1);
      expect(feedbackRow.elements[0].type).toBe('feedback_buttons');

      // Single surface — the detached card must NOT also be posted.
      expect(channel.send).not.toHaveBeenCalled();
      expect(client.chat.postMessage).not.toHaveBeenCalled();
    });

    it('never re-sends the streamed answer text on close (append-only close, original preserved)', async () => {
      const client = makeClient();
      const channel = makeConsolidatingChannel();
      const surface = makeSurface(client, channel);
      const ctx = makeCtx('C1:t1.0:a32-2', makeEvent());

      await surface.begin(ctx as any);
      await surface.appendText(ctx.turnId, 'the streamed answer body');
      await surface.end(ctx.turnId, 'completed');

      const payload = client.chat.stopStream.mock.calls[0][0];
      expect(JSON.stringify(payload)).not.toContain('the streamed answer body');
      expect(payload.markdown_text).toBeUndefined();
    });

    it('protects the stream ts instead of tracking it for deletion', async () => {
      const client = makeClient();
      const channel = makeConsolidatingChannel();
      const surface = makeSurface(client, channel);
      const evt = makeEvent();
      const ctx = makeCtx('C1:t1.0:a32-3', evt);

      await surface.begin(ctx as any);
      await surface.end(ctx.turnId, 'completed');

      expect(channel.protectMessageTs).toHaveBeenCalledWith(evt, 'stream-ts-1');
    });

    it('resolves the snapshot BEFORE closing the stream (blocks cannot be appended after stop)', async () => {
      const client = makeClient();
      const channel = makeConsolidatingChannel();
      const surface = makeSurface(client, channel);

      let resolveSnapshot!: (evt: ReturnType<typeof makeEvent> | undefined) => void;
      const snapshotPromise = new Promise<ReturnType<typeof makeEvent> | undefined>((resolve) => {
        resolveSnapshot = resolve;
      });
      const ctx = {
        channelId: 'C1',
        threadTs: 't1.0',
        sessionKey: 'C1:t1.0',
        turnId: 'C1:t1.0:a32-order',
        buildCompletionEvent: () => snapshotPromise,
      };
      await surface.begin(ctx as any);

      const endPromise = surface.end(ctx.turnId, 'completed');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      // Still open: the close is blocked on the snapshot.
      expect(client.chat.stopStream).not.toHaveBeenCalled();

      resolveSnapshot(makeEvent());
      await endPromise;

      expect(client.chat.stopStream).toHaveBeenCalledTimes(1);
      expect(client.chat.stopStream.mock.calls[0][0].blocks).toBeDefined();
    });

    it('snapshot timeout → plain chunks:[] close, no blocks, snapshotResolved=false', async () => {
      vi.useFakeTimers();
      try {
        const client = makeClient();
        const channel = makeConsolidatingChannel();
        const surface = makeSurface(client, channel);

        const ctx = {
          channelId: 'C1',
          threadTs: 't1.0',
          sessionKey: 'C1:t1.0',
          turnId: 'C1:t1.0:a32-timeout',
          buildCompletionEvent: () =>
            new Promise<ReturnType<typeof makeEvent> | undefined>(() => {
              /* never settle */
            }),
        };
        await surface.begin(ctx as any);

        const endPromise = surface.end(ctx.turnId, 'completed');
        await vi.advanceTimersByTimeAsync(3000);
        const result = await endPromise;

        expect(client.chat.stopStream).toHaveBeenCalledTimes(1);
        expect(client.chat.stopStream).toHaveBeenCalledWith({
          channel: 'C1',
          ts: 'stream-ts-1',
          chunks: [],
        });
        expect(channel.send).not.toHaveBeenCalled();
        expect((result as any).snapshotResolved).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('Slack refuses the appended blocks (invalid_blocks) → plain close + detached send() fallback', async () => {
      const slackErr: any = new Error('invalid_blocks');
      slackErr.data = { error: 'invalid_blocks' };
      const client = makeClient({
        stopStream: vi.fn().mockRejectedValueOnce(slackErr).mockResolvedValue(undefined),
      });
      const channel = makeConsolidatingChannel();
      const surface = makeSurface(client, channel);
      const evt = makeEvent();
      const ctx = makeCtx('C1:t1.0:a32-invalid', evt);

      await surface.begin(ctx as any);
      await surface.end(ctx.turnId, 'completed');

      expect(client.chat.stopStream).toHaveBeenCalledTimes(2);
      // Second attempt closes the stream without the rejected blocks.
      expect(client.chat.stopStream).toHaveBeenNthCalledWith(2, {
        channel: 'C1',
        ts: 'stream-ts-1',
        chunks: [],
      });
      expect(channel.send).toHaveBeenCalledTimes(1);
      expect(channel.send).toHaveBeenCalledWith(evt);
    });

    it('streaming_mode_mismatch → plain close + detached send() fallback', async () => {
      const slackErr: any = new Error('streaming_mode_mismatch');
      slackErr.data = { error: 'streaming_mode_mismatch' };
      const client = makeClient({
        stopStream: vi.fn().mockRejectedValueOnce(slackErr).mockResolvedValue(undefined),
      });
      const channel = makeConsolidatingChannel();
      const surface = makeSurface(client, channel);
      const ctx = makeCtx('C1:t1.0:a32-mismatch', makeEvent());

      await surface.begin(ctx as any);
      await surface.end(ctx.turnId, 'completed');

      expect(client.chat.stopStream).toHaveBeenCalledTimes(2);
      expect(channel.send).toHaveBeenCalledTimes(1);
    });

    // An AMBIGUOUS failure (rate limit / transport / 5xx — anything that is NOT
    // a platform refusal of the appended blocks) may still have applied the
    // close server-side. The no-duplicate policy stands (no retry, no detached
    // card), which is exactly why the ts MUST be protected on this path too: if
    // the close DID apply, the answer message now carries the completion card
    // and the tracker's deleteAll sweep would delete the user's answer,
    // breaking the "답변 보존" decision. Protecting a ts whose close never
    // applied is harmless.
    it('ambiguous stopStream failure (ratelimited) → protects the stream ts, no retry, no detached card', async () => {
      const slackErr: any = new Error('ratelimited');
      slackErr.data = { error: 'ratelimited' };
      const client = makeClient({ stopStream: vi.fn().mockRejectedValue(slackErr) });
      const channel = makeConsolidatingChannel();
      const surface = makeSurface(client, channel);
      const evt = makeEvent();
      const ctx = makeCtx('C1:t1.0:a32-ambiguous', evt);

      await surface.begin(ctx as any);
      await surface.end(ctx.turnId, 'completed');

      expect(channel.protectMessageTs).toHaveBeenCalledWith(evt, 'stream-ts-1');
      // No duplicate: neither a second close attempt nor a detached card.
      expect(client.chat.stopStream).toHaveBeenCalledTimes(1);
      expect(channel.send).not.toHaveBeenCalled();
      expect(client.chat.postMessage).not.toHaveBeenCalled();
    });

    it('transport failure with no Slack error code is treated as ambiguous and still protects the ts', async () => {
      const client = makeClient({ stopStream: vi.fn().mockRejectedValue(new Error('socket hang up')) });
      const channel = makeConsolidatingChannel();
      const surface = makeSurface(client, channel);
      const evt = makeEvent();
      const ctx = makeCtx('C1:t1.0:a32-transport', evt);

      await surface.begin(ctx as any);
      await surface.end(ctx.turnId, 'completed');

      expect(channel.protectMessageTs).toHaveBeenCalledWith(evt, 'stream-ts-1');
      expect(client.chat.stopStream).toHaveBeenCalledTimes(1);
      expect(channel.send).not.toHaveBeenCalled();
    });

    it('a REFUSED close does not protect the ts (the detached card owns its own message)', async () => {
      const slackErr: any = new Error('invalid_blocks');
      slackErr.data = { error: 'invalid_blocks' };
      const client = makeClient({
        stopStream: vi.fn().mockRejectedValueOnce(slackErr).mockResolvedValue(undefined),
      });
      const channel = makeConsolidatingChannel();
      const surface = makeSurface(client, channel);
      const ctx = makeCtx('C1:t1.0:a32-refused-noprotect', makeEvent());

      await surface.begin(ctx as any);
      await surface.end(ctx.turnId, 'completed');

      expect(channel.protectMessageTs).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledTimes(1);
    });

    it("end('aborted') closes exactly as before: chunks:[] only, no block build", async () => {
      const client = makeClient();
      const channel = makeConsolidatingChannel();
      const surface = makeSurface(client, channel);
      const ctx = makeCtx('C1:t1.0:a32-abort', makeEvent());

      await surface.begin(ctx as any);
      await surface.end(ctx.turnId, 'aborted');

      expect(client.chat.stopStream).toHaveBeenCalledWith({
        channel: 'C1',
        ts: 'stream-ts-1',
        chunks: [],
      });
      expect(channel.buildCompletionBlocks).not.toHaveBeenCalled();
      expect(channel.send).not.toHaveBeenCalled();
    });

    it('channel without buildCompletionBlocks (legacy double) keeps the detached send path', async () => {
      const client = makeClient();
      const channel = { send: vi.fn().mockResolvedValue(undefined) };
      const surface = makeSurface(client, channel);
      const evt = makeEvent();
      const ctx = makeCtx('C1:t1.0:a32-legacy', evt);

      await surface.begin(ctx as any);
      await surface.end(ctx.turnId, 'completed');

      expect(client.chat.stopStream).toHaveBeenCalledWith({
        channel: 'C1',
        ts: 'stream-ts-1',
        chunks: [],
      });
      expect(channel.send).toHaveBeenCalledWith(evt);
    });

    it('no stream (never began) → detached send() still posts the card', async () => {
      const client = makeClient();
      const channel = makeConsolidatingChannel();
      const surface = makeSurface(client, channel);
      const evt = makeEvent();
      const ctx: TurnAddress & { turnId: string } = {
        channelId: 'C1',
        threadTs: 't1.0',
        sessionKey: 'C1:t1.0',
        turnId: 'C1:t1.0:a32-nostream',
        buildCompletionEvent: () => Promise.resolve(evt),
      } as any;

      // renderTasks creates an ad-hoc turn entry with no streamTs.
      await surface.renderTasks(ctx.turnId, [{ content: 'x', status: 'pending' }] as any, ctx as any);
      await surface.end(ctx.turnId, 'completed');

      expect(client.chat.stopStream).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(evt);
    });

    it('withFeedback false → completion blocks appended without a feedback row', async () => {
      const client = makeClient();
      const channel = makeConsolidatingChannel();
      channel.buildCompletionBlocks.mockReturnValue({
        blocks: COMPLETION_BLOCKS,
        fallbackText: 'Session X',
        withFeedback: false,
      });
      const surface = makeSurface(client, channel);
      const ctx = makeCtx('C1:t1.0:a32-nofb', makeEvent());

      await surface.begin(ctx as any);
      await surface.end(ctx.turnId, 'completed');

      expect(client.chat.stopStream.mock.calls[0][0].blocks).toEqual(COMPLETION_BLOCKS);
    });
  });

  // -------------------------------------------------------------------------
  // A11 — the sticky flag must not swallow a FAILED marker write
  //
  // The flag is set BEFORE the Slack call on purpose (it fences the two entry
  // points that routinely race: the ThreadPanel click and end()'s teardown).
  // But leaving it set after a REJECTED append turns "one marker per turn" into
  // "zero markers, silently": every later attempt short-circuits on the flag and
  // the user's explicit interruption never appears in the transcript.
  // -------------------------------------------------------------------------
  describe('A11 user-interrupted marker — failed write stays retryable', () => {
    it('clears the sticky flag when the append rejects, so the next attempt retries and warns with the Slack code', async () => {
      const slackErr: any = new Error('slack down');
      slackErr.data = { error: 'ratelimited' };
      const client = makeClient({
        appendStream: vi.fn().mockRejectedValueOnce(slackErr).mockResolvedValue(undefined),
      });
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });
      const warnSpy = vi.fn();
      (surface as any).logger.warn = warnSpy;

      const ctx = { channelId: 'C1', threadTs: 't1', sessionKey: 'C1:t1', turnId: 'C1:t1:int-retry' };
      await surface.begin(ctx);

      await expect(surface.markUserInterrupted(ctx.turnId)).resolves.toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        'user-interrupted marker append failed',
        expect.objectContaining({
          turnId: ctx.turnId,
          streamTs: 'stream-ts-1',
          error: expect.objectContaining({ code: 'ratelimited' }),
        }),
      );

      // The loss is recoverable: the flag was rolled back, so the retry lands.
      await expect(surface.markUserInterrupted(ctx.turnId)).resolves.toBe(true);
      expect(client.chat.appendStream).toHaveBeenCalledTimes(2);
      expect(client.chat.appendStream.mock.calls[1][0]).toMatchObject({
        channel: 'C1',
        ts: 'stream-ts-1',
        chunks: [{ type: 'markdown_text', text: 'user-interrupted' }],
      });
    });

    it("a failed append still lets end('user-interrupted') stamp the marker", async () => {
      const client = makeClient({
        appendStream: vi.fn().mockRejectedValueOnce(new Error('transport')).mockResolvedValue(undefined),
      });
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      const ctx = { channelId: 'C1', threadTs: 't1', sessionKey: 'C1:t1', turnId: 'C1:t1:int-end' };
      await surface.begin(ctx);
      await expect(surface.markUserInterrupted(ctx.turnId)).resolves.toBe(false);
      await surface.end(ctx.turnId, 'user-interrupted');

      const markers = client.chat.appendStream.mock.calls.filter(
        (call: any[]) => call[0]?.chunks?.[0]?.text === 'user-interrupted',
      );
      // Two attempts, exactly one of which actually landed.
      expect(markers).toHaveLength(2);
    });

    it('rolls the flag back on the no-stream plain-text fallback too', async () => {
      const client = makeClient({
        startStream: vi.fn().mockRejectedValue(new Error('slack 500')),
        postMessage: vi.fn().mockRejectedValueOnce(new Error('transport')).mockResolvedValue({ ts: 'm1' }),
      });
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      const ctx = { channelId: 'C9', threadTs: 't9', sessionKey: 'C9:t9', turnId: 'C9:t9:int-nostream' };
      await surface.begin(ctx);

      await expect(surface.markUserInterrupted(ctx.turnId)).resolves.toBe(false);
      await expect(surface.markUserInterrupted(ctx.turnId)).resolves.toBe(true);
      expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    });

    it('a SUCCESSFUL marker is still written exactly once', async () => {
      const client = makeClient();
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      const ctx = { channelId: 'C1', threadTs: 't1', sessionKey: 'C1:t1', turnId: 'C1:t1:int-once' };
      await surface.begin(ctx);
      await expect(surface.markUserInterrupted(ctx.turnId)).resolves.toBe(true);
      await expect(surface.markUserInterrupted(ctx.turnId)).resolves.toBe(false);
      await surface.end(ctx.turnId, 'user-interrupted');

      const markers = client.chat.appendStream.mock.calls.filter(
        (call: any[]) => call[0]?.chunks?.[0]?.text === 'user-interrupted',
      );
      expect(markers).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // A11 — the two entry points OVERLAP, so the fence must be the write itself
  //
  // `markUserInterrupted()` (click/abort) and `end('user-interrupted')`
  // (teardown) routinely run concurrently. A boolean fence lets the loser
  // report "already written" and walk on to `stopStream` while the winner's
  // write is still open — if that write then fails, the marker was written
  // ZERO times and the stream is already closed. Sharing the in-flight promise
  // is what makes the loser wait for the real outcome (and retry it).
  // -------------------------------------------------------------------------
  describe('A11 user-interrupted marker — concurrent writers share one in-flight write', () => {
    /** Marker-only append calls, in order. */
    function markerCalls(client: MockClient): any[] {
      return client.chat.appendStream.mock.calls.filter(
        (call: any[]) => call[0]?.chunks?.[0]?.text === 'user-interrupted',
      );
    }

    it('end() joins an in-flight click write and retries it when that write fails', async () => {
      // First marker append hangs until we fail it — that open window is
      // exactly when end() reaches its own marker step.
      let failFirst: ((err: Error) => void) | undefined;
      const firstAttempt = new Promise<void>((_resolve, reject) => {
        failFirst = reject;
      });
      const order: string[] = [];
      let markerAttempts = 0;
      const client = makeClient({
        appendStream: vi.fn(async (args: any) => {
          if (args?.chunks?.[0]?.text !== 'user-interrupted') return undefined;
          markerAttempts += 1;
          if (markerAttempts === 1) return firstAttempt;
          order.push('marker');
          return undefined;
        }),
        stopStream: vi.fn(async () => {
          order.push('stop');
          return undefined;
        }),
      });
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });
      const ctx = { channelId: 'C1', threadTs: 't1', sessionKey: 'C1:t1', turnId: 'C1:t1:int-race' };
      await surface.begin(ctx);

      const click = surface.markUserInterrupted(ctx.turnId);
      const teardown = surface.end(ctx.turnId, 'user-interrupted');
      // Let end() walk its teardown steps and arrive at the marker while the
      // click's append is still open.
      await new Promise((resolve) => setTimeout(resolve, 10));
      failFirst?.(new Error('transport'));
      const [clicked] = await Promise.all([click, teardown]);

      // The click lost its write…
      expect(clicked).toBe(false);
      // …and end() retried it instead of trusting a fence it never verified.
      expect(markerCalls(client)).toHaveLength(2);
      // The retry has to land BEFORE the close, or it lands nowhere.
      expect(order).toEqual(['marker', 'stop']);
    });

    it('a click racing end() appends the marker exactly once when the write succeeds', async () => {
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const client = makeClient({
        appendStream: vi.fn(async (args: any) => {
          if (args?.chunks?.[0]?.text === 'user-interrupted') await gate;
          return undefined;
        }),
      });
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });
      const ctx = { channelId: 'C1', threadTs: 't1', sessionKey: 'C1:t1', turnId: 'C1:t1:int-race-ok' };
      await surface.begin(ctx);

      const click = surface.markUserInterrupted(ctx.turnId);
      const teardown = surface.end(ctx.turnId, 'user-interrupted');
      await new Promise((resolve) => setTimeout(resolve, 10));
      release?.();
      const [clicked] = await Promise.all([click, teardown]);

      expect(clicked).toBe(true);
      expect(markerCalls(client)).toHaveLength(1);
    });

    it('when both attempts fail the loss is warned and the stream still closes', async () => {
      const slackErr: any = new Error('slack down');
      slackErr.data = { error: 'ratelimited' };
      const client = makeClient({
        appendStream: vi.fn(async (args: any) => {
          if (args?.chunks?.[0]?.text === 'user-interrupted') throw slackErr;
          return undefined;
        }),
      });
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });
      const warnSpy = vi.fn();
      (surface as any).logger.warn = warnSpy;

      const ctx = { channelId: 'C1', threadTs: 't1', sessionKey: 'C1:t1', turnId: 'C1:t1:int-both-fail' };
      await surface.begin(ctx);

      await expect(surface.markUserInterrupted(ctx.turnId)).resolves.toBe(false);
      await surface.end(ctx.turnId, 'user-interrupted');

      expect(markerCalls(client)).toHaveLength(2);
      const failWarns = warnSpy.mock.calls.filter((call) => call[0] === 'user-interrupted marker append failed');
      expect(failWarns).toHaveLength(2);
      // A lost marker must not also cost the user their stream close.
      expect(client.chat.stopStream).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // A11 — ONE retry per turn, not one retry per waiter
  //
  // "At most one attempt per call" is not the same guarantee as "at most one
  // retry". When the shared in-flight write resolves `false`, EVERY caller
  // parked on it wakes up and falls through — so three overlapping callers
  // (two ThreadPanel clicks + end()'s teardown) each created their own
  // "single retry", appending the marker up to three times and overwriting
  // each other's slot. The retry budget has to live on the TURN: whoever
  // still sees the failed promise in the slot creates the one retry, everyone
  // else joins it, and the turn spends at most two physical attempts.
  // -------------------------------------------------------------------------
  describe('A11 user-interrupted marker — retry budget is per turn, not per caller', () => {
    /** Marker-only append calls, in order. */
    function markerCalls(client: MockClient): any[] {
      return client.chat.appendStream.mock.calls.filter(
        (call: any[]) => call[0]?.chunks?.[0]?.text === 'user-interrupted',
      );
    }

    it('three concurrent callers share ONE retry when the first write fails (2 appends, marker before stop)', async () => {
      // The first marker append hangs until we fail it — that open window is
      // where both the second click and end() park on the same promise.
      let failFirst: ((err: Error) => void) | undefined;
      const firstAttempt = new Promise<void>((_resolve, reject) => {
        failFirst = reject;
      });
      const order: string[] = [];
      let markerAttempts = 0;
      const client = makeClient({
        appendStream: vi.fn(async (args: any) => {
          if (args?.chunks?.[0]?.text !== 'user-interrupted') return undefined;
          markerAttempts += 1;
          if (markerAttempts === 1) return firstAttempt;
          order.push('marker');
          return undefined;
        }),
        stopStream: vi.fn(async () => {
          order.push('stop');
          return undefined;
        }),
      });
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });
      const ctx = { channelId: 'C1', threadTs: 't1', sessionKey: 'C1:t1', turnId: 'C1:t1:int-fanout' };
      await surface.begin(ctx);

      const clickA = surface.markUserInterrupted(ctx.turnId);
      const clickB = surface.markUserInterrupted(ctx.turnId);
      const teardown = surface.end(ctx.turnId, 'user-interrupted');
      await new Promise((resolve) => setTimeout(resolve, 10));
      failFirst?.(new Error('transport'));
      const [a] = await Promise.all([clickA, clickB, teardown]);

      // The first click owned the write that died.
      expect(a).toBe(false);
      // One failure + one retry — NOT one retry per parked caller.
      expect(markerCalls(client)).toHaveLength(2);
      // The retry still has to land before the close, or it lands nowhere.
      expect(order).toEqual(['marker', 'stop']);
    });

    it('three concurrent callers append exactly one marker when the first write succeeds', async () => {
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const client = makeClient({
        appendStream: vi.fn(async (args: any) => {
          if (args?.chunks?.[0]?.text === 'user-interrupted') await gate;
          return undefined;
        }),
      });
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });
      const ctx = { channelId: 'C1', threadTs: 't1', sessionKey: 'C1:t1', turnId: 'C1:t1:int-fanout-ok' };
      await surface.begin(ctx);

      const clickA = surface.markUserInterrupted(ctx.turnId);
      const clickB = surface.markUserInterrupted(ctx.turnId);
      const teardown = surface.end(ctx.turnId, 'user-interrupted');
      await new Promise((resolve) => setTimeout(resolve, 10));
      release?.();
      const [a, b] = await Promise.all([clickA, clickB, teardown]);

      expect(a).toBe(true);
      expect(b).toBe(false);
      expect(markerCalls(client)).toHaveLength(1);
    });

    it('stops at two physical attempts when both fail, warns the loss, and still closes the stream', async () => {
      const slackErr: any = new Error('slack down');
      slackErr.data = { error: 'ratelimited' };
      const client = makeClient({
        appendStream: vi.fn(async (args: any) => {
          if (args?.chunks?.[0]?.text === 'user-interrupted') throw slackErr;
          return undefined;
        }),
      });
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });
      const warnSpy = vi.fn();
      (surface as any).logger.warn = warnSpy;

      const ctx = { channelId: 'C1', threadTs: 't1', sessionKey: 'C1:t1', turnId: 'C1:t1:int-fanout-fail' };
      await surface.begin(ctx);

      const clickA = surface.markUserInterrupted(ctx.turnId);
      const clickB = surface.markUserInterrupted(ctx.turnId);
      const teardown = surface.end(ctx.turnId, 'user-interrupted');
      const [a, b] = await Promise.all([clickA, clickB, teardown]);

      expect(a).toBe(false);
      expect(b).toBe(false);
      // Two attempts is the whole budget — the third caller must not append.
      expect(markerCalls(client)).toHaveLength(2);
      const failWarns = warnSpy.mock.calls.filter((call) => call[0] === 'user-interrupted marker append failed');
      expect(failWarns).toHaveLength(2);
      // The exhausted caller reports the loss instead of retrying silently.
      expect(warnSpy).toHaveBeenCalledWith(
        'user-interrupted marker retry budget spent — marker lost',
        expect.objectContaining({ turnId: ctx.turnId, attempts: 2 }),
      );
      // A lost marker must not also cost the user their stream close.
      expect(client.chat.stopStream).toHaveBeenCalledTimes(1);
    });
  });
});
