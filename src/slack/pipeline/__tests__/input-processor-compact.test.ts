/**
 * #617 AC3 end-to-end — InputProcessor auto-compact interception.
 *
 * When `session.autoCompactPending === true`:
 *   1. The current user message text is swallowed and stashed on the session.
 *   2. A notice is posted to the thread via slackApi.postSystemMessage.
 *   3. `/compact` is injected via the `continueWithPrompt` pipeline
 *      (event-router.ts:158-160 consumes this).
 *   4. The session carries `pendingUserText` + `pendingEventContext` for
 *      the PostCompact / compact_boundary path to re-dispatch on completion.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../user-settings-store', () => ({
  userSettingsStore: {
    updateUserJiraInfo: vi.fn(),
  },
}));

import type { ConversationSession } from '../../../types';
import { InputProcessor } from '../input-processor';
import type { MessageEvent } from '../types';

function makeSession(overrides: Partial<ConversationSession> = {}): ConversationSession {
  return {
    channelId: 'C1',
    threadTs: 'T1',
    compactionCount: 0,
    compactEpoch: 0,
    compactPostedByEpoch: {},
    compactionRehydratedByEpoch: {},
    preCompactUsagePct: null,
    lastKnownUsagePct: null,
    autoCompactPending: false,
    pendingUserText: null,
    pendingEventContext: null,
    ...overrides,
  } as ConversationSession;
}

describe('InputProcessor auto-compact interception (#617 AC3)', () => {
  let processor: InputProcessor;
  let session: ConversationSession;
  let getSession: ReturnType<typeof vi.fn>;
  let postSystemMessage: ReturnType<typeof vi.fn>;
  let commandRouterRoute: ReturnType<typeof vi.fn>;

  const makeEvent = (text: string): MessageEvent =>
    ({
      type: 'message',
      channel: 'C1',
      thread_ts: 'T1',
      user: 'U1',
      ts: '171.0',
      text,
    }) as unknown as MessageEvent;

  beforeEach(() => {
    session = makeSession({ autoCompactPending: true });
    getSession = vi.fn().mockReturnValue(session);
    postSystemMessage = vi.fn().mockResolvedValue(undefined);
    commandRouterRoute = vi.fn().mockResolvedValue({ handled: false });

    processor = new InputProcessor({
      fileHandler: {} as any,
      commandRouter: { route: commandRouterRoute } as any,
      claudeHandler: { getSession } as any,
      slackApi: { postSystemMessage } as any,
    });
  });

  it('AC3: autoCompactPending=true → swallows text, stashes pendingUserText, returns /compact', async () => {
    const event = makeEvent('original user message');
    const say = vi.fn().mockResolvedValue({ ts: 'ts1' });

    const result = await processor.routeCommand(event, say as any);

    expect(result.handled).toBe(true);
    expect(result.continueWithPrompt).toBe('/compact');
    expect(session.autoCompactPending).toBe(false); // atomically cleared
    expect(session.pendingUserText).toBe('original user message');
    expect(session.pendingEventContext).toEqual({
      channel: 'C1',
      threadTs: 'T1',
      user: 'U1',
      ts: '171.0',
    });
    // Notice posted — user sees what's happening.
    expect(postSystemMessage).toHaveBeenCalledWith('C1', expect.stringContaining('Auto-compact'), { threadTs: 'T1' });
    // CommandRouter must NOT be asked to route this turn.
    expect(commandRouterRoute).not.toHaveBeenCalled();
  });

  it('AC3: autoCompactPending=false → falls through to commandRouter normally', async () => {
    session.autoCompactPending = false;
    commandRouterRoute.mockResolvedValueOnce({ handled: false });

    const event = makeEvent('hello world');
    const say = vi.fn();
    const result = await processor.routeCommand(event, say as any);

    expect(result.handled).toBe(false);
    expect(commandRouterRoute).toHaveBeenCalledTimes(1);
    expect(session.pendingUserText).toBeNull();
  });

  it('AC3: uses thread_ts||ts as threadTs (top-level message in thread-less DM)', async () => {
    session.autoCompactPending = true;
    const event = {
      type: 'message',
      channel: 'C1',
      thread_ts: undefined,
      user: 'U1',
      ts: '171.7',
      text: 'top-level',
    } as unknown as MessageEvent;
    const say = vi.fn();

    await processor.routeCommand(event, say as any);

    expect(session.pendingEventContext?.threadTs).toBe('171.7'); // falls back to ts
    expect(postSystemMessage).toHaveBeenCalledWith('C1', expect.stringContaining('Auto-compact'), {
      threadTs: '171.7',
    });
  });

  it('AC3: slackApi.postSystemMessage failure does NOT block /compact injection', async () => {
    session.autoCompactPending = true;
    postSystemMessage.mockRejectedValueOnce(new Error('slack down'));

    const event = makeEvent('user msg');
    const say = vi.fn();
    const result = await processor.routeCommand(event, say as any);

    // /compact injection must still happen even if the notice fails.
    expect(result.handled).toBe(true);
    expect(result.continueWithPrompt).toBe('/compact');
    expect(session.pendingUserText).toBe('user msg');
  });

  it('AC3: empty text → no interception (fast path returns {handled:false})', async () => {
    session.autoCompactPending = true;
    const event = makeEvent('');
    const say = vi.fn();
    const result = await processor.routeCommand(event, say as any);

    expect(result.handled).toBe(false);
    // autoCompactPending must remain true — next real turn will still compact.
    expect(session.autoCompactPending).toBe(true);
    expect(session.pendingUserText).toBeNull();
  });

  it('AC3: second turn while session still marked — pendingUserText should only be set once (idempotent)', async () => {
    session.autoCompactPending = true;
    const event1 = makeEvent('first message');
    const say = vi.fn();
    const result1 = await processor.routeCommand(event1, say as any);
    expect(result1.handled).toBe(true);
    expect(session.pendingUserText).toBe('first message');
    // After atomic clear, pending flag is false; next turn is NOT intercepted.
    const event2 = makeEvent('second message');
    commandRouterRoute.mockResolvedValueOnce({ handled: false });
    const result2 = await processor.routeCommand(event2, say as any);
    expect(result2.handled).toBe(false); // normal routing
    expect(session.pendingUserText).toBe('first message'); // not overwritten
  });

  // #952: `new` / `/new` must preempt auto-compact. The user is explicitly
  // discarding the conversation, so compacting it first is wasted work AND
  // delays the session reset by an entire turn.
  describe('new command preempts auto-compact (#952)', () => {
    it.each([
      'new',
      '/new',
      'NEW',
      '/NEW',
      'new some prompt',
      '/new with args',
    ])('autoCompactPending=true + text=%s → bypasses compact, clears pending, routes new normally', async (text) => {
      session.autoCompactPending = true;
      commandRouterRoute.mockResolvedValueOnce({ handled: true });

      const event = makeEvent(text);
      const say = vi.fn();
      const result = await processor.routeCommand(event, say as any);

      // /compact must NOT be injected.
      expect(result.continueWithPrompt).not.toBe('/compact');
      // Pending flag is cleared so the next turn isn't intercepted either.
      expect(session.autoCompactPending).toBe(false);
      // Original text is NOT stashed — `new` discards context, no replay.
      expect(session.pendingUserText).toBeNull();
      expect(session.pendingEventContext).toBeNull();
      // Notice is NOT posted — compaction isn't happening.
      expect(postSystemMessage).not.toHaveBeenCalled();
      // Command router IS invoked so the `new` handler runs.
      // The raw text (including leading `/`) is forwarded verbatim so
      // NewHandler.canHandle / parseNewCommand still see the original.
      expect(commandRouterRoute).toHaveBeenCalledTimes(1);
      expect(commandRouterRoute).toHaveBeenCalledWith(expect.objectContaining({ text }));
    });

    it('autoCompactPending=false + text=new → normal routing (no regression)', async () => {
      session.autoCompactPending = false;
      commandRouterRoute.mockResolvedValueOnce({ handled: true });

      const event = makeEvent('new');
      const say = vi.fn();
      const result = await processor.routeCommand(event, say as any);

      expect(result.handled).toBe(true);
      expect(result.continueWithPrompt).toBeUndefined();
      expect(commandRouterRoute).toHaveBeenCalledTimes(1);
    });

    // Substrings that contain "new" but are NOT the /new command — must follow
    // the standard interception path and get /compact-stashed like any other
    // message text.
    it.each([
      'newline thoughts',
      'renew',
      'renew the cert',
    ])('text=%s does NOT preempt — standard /compact interception still fires', async (text) => {
      session.autoCompactPending = true;
      const event = makeEvent(text);
      const say = vi.fn();
      const result = await processor.routeCommand(event, say as any);

      expect(result.handled).toBe(true);
      expect(result.continueWithPrompt).toBe('/compact');
      expect(session.pendingUserText).toBe(text);
    });
  });
});
