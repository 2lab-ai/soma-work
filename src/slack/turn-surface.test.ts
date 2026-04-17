import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../config';
import { TurnSurface } from './turn-surface';

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

    it('swallows stopStream errors and still clears state', async () => {
      const client = makeClient({
        stopStream: vi.fn().mockRejectedValue(new Error('slack down')),
      });
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      const ctx = { channelId: 'C1', threadTs: 't1', sessionKey: 'C1:t1', turnId: 'C1:t1:1' };
      await surface.begin(ctx);
      await expect(surface.fail(ctx.turnId, new Error('upstream'))).resolves.toBeUndefined();
      expect(surface._hasActiveTurn(ctx.sessionKey)).toBe(false);
    });

    it('is a no-op when the turn is unknown', async () => {
      const client = makeClient();
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });

      await surface.fail('never-began', new Error('x'));
      expect(client.chat.stopStream).not.toHaveBeenCalled();
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
      await surface.begin(ctx); // idempotent — same turnId, no supersede

      // No stopStream (no supersede) — both starts hit the same turnId slot
      expect(client.chat.stopStream).not.toHaveBeenCalled();
      expect(client.chat.startStream).toHaveBeenCalledTimes(2);
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
      await expect(surface.renderTasks('any-turn', [{ id: '1' }])).resolves.toBeUndefined();
      // Placeholder must not initiate any Slack traffic in P1
      expect(client.chat.startStream).not.toHaveBeenCalled();
      expect(client.chat.appendStream).not.toHaveBeenCalled();
    });

    it('askUser returns empty string below PHASE=3', async () => {
      config.ui.fiveBlockPhase = 2;
      const client = makeClient();
      const surface = new TurnSurface({ slackApi: makeSlackApi(client) });
      await expect(surface.askUser('any-turn', { x: 1 })).resolves.toBe('');
    });
  });
});
