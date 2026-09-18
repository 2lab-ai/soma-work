import { describe, expect, it, vi } from 'vitest';
import { EventRouter, type EventRouterDeps } from '../event-router';

/**
 * `reaction_added` routing (09 §2.2, §5).
 *
 * The queue controls are reactions on the USER's own message now, so a click on
 * one arrives as `reaction_added` and nothing else. This router is the only
 * place that event enters the process.
 *
 * These tests pin the ROUTING only — which events reach the host and in what
 * shape. What the host does with one (which item it is, whether the reactor may
 * steer, whether the state accepts the control) is decided against the real
 * queue in `src/__tests__/slack-handler.followup.test.ts`; re-deciding it here
 * would be a second policy.
 *
 * Two filters are this router's own, because both are about the event and not
 * about the queue:
 *   - the BOT's own reactions. The bot paints the controls itself, so every
 *     `ui_cancel` it adds comes straight back as a `reaction_added` — accepting
 *     one would make the surface press its own buttons.
 *   - reactions that are not queue controls. A 👍 on a queued message must not
 *     cost a queue lookup, let alone an item resolution.
 */

const CHANNEL = 'C-REACT';

type EventListener = (args: { event: any }) => Promise<void>;

function harness(over: Partial<EventRouterDeps> = {}) {
  const events = new Map<string, EventListener>();
  const app = {
    message: vi.fn(),
    event: vi.fn((name: string, listener: EventListener) => {
      events.set(name, listener);
    }),
    command: vi.fn(),
  } as any;

  const onReactionAdded = vi.fn(async () => {});
  const deps = {
    slackApi: {
      getBotUserId: vi.fn().mockResolvedValue('U_BOT'),
      getClient: vi.fn(),
      addReaction: vi.fn().mockResolvedValue(undefined),
    } as any,
    claudeHandler: {
      getSession: vi.fn(),
      findSessionBySourceThread: vi.fn(),
      setExpiryCallbacks: vi.fn(),
      cleanupInactiveSessions: vi.fn(),
      broadcastSessionUpdate: vi.fn(),
    } as any,
    sessionManager: {} as any,
    actionHandlers: { registerHandlers: vi.fn() },
    onReactionAdded,
    isFollowupControlReaction: (name: string) => name === 'ui_send_now' || name === 'ui_cancel',
    ...over,
  } as EventRouterDeps;

  const router = new EventRouter(
    app,
    deps,
    vi.fn(async () => {}),
  );
  // The reaction listener only — `setup()` also installs a 5-minute cleanup
  // interval and the slash surface, neither of which this routing is about.
  (router as any).setupReactionHandlers();

  const listener = events.get('reaction_added');
  if (!listener) throw new Error('no `reaction_added` listener registered');

  return {
    deps,
    onReactionAdded,
    fire: (event: any) => listener({ event }),
  };
}

/** A real `reaction_added` envelope: the reacted message lives under `item`. */
function reactionEvent(over: Record<string, unknown> = {}, itemOver: Record<string, unknown> = {}): any {
  return {
    type: 'reaction_added',
    user: 'U_CLICKER',
    reaction: 'ui_cancel',
    item: { type: 'message', channel: CHANNEL, ts: '1700.000100', ...itemOver },
    item_user: 'U_AUTHOR',
    event_ts: '1700.000900',
    ...over,
  };
}

describe('EventRouter — reaction_added', () => {
  it('routes a control reaction to onReactionAdded with the reacted message coordinates', async () => {
    const h = harness();

    await h.fire(reactionEvent());

    expect(h.onReactionAdded).toHaveBeenCalledTimes(1);
    expect(h.onReactionAdded.mock.calls[0][0]).toEqual({
      channel: CHANNEL,
      // The queue's key is `<channel>:<message ts>` — the envelope's own
      // `event_ts` is when the reaction happened and would match no item.
      ts: '1700.000100',
      reaction: 'ui_cancel',
      user: 'U_CLICKER',
      eventTs: '1700.000900',
    });
  });

  it('ignores the BOT reacting to a message — the bot paints the controls itself', async () => {
    const h = harness();

    await h.fire(reactionEvent({ user: 'U_BOT' }));

    expect(h.onReactionAdded).not.toHaveBeenCalled();
  });

  it('ignores a reaction that is not a queue control', async () => {
    const h = harness();

    await h.fire(reactionEvent({ reaction: '+1' }));

    expect(h.onReactionAdded).not.toHaveBeenCalled();
  });

  it('never asks who the bot is for a reaction it would drop anyway', async () => {
    const h = harness();

    await h.fire(reactionEvent({ reaction: 'eyes' }));

    expect(h.deps.slackApi.getBotUserId).not.toHaveBeenCalled();
  });

  it('ignores a reaction on anything that is not a message (a file, a comment)', async () => {
    const h = harness();

    await h.fire(reactionEvent({}, { type: 'file', file: 'F1' }));

    expect(h.onReactionAdded).not.toHaveBeenCalled();
  });

  it('drops the event when the bot identity cannot be read — it may be the bot itself', async () => {
    const deps = {
      slackApi: {
        getBotUserId: vi.fn().mockRejectedValue(new Error('auth.test failed')),
        getClient: vi.fn(),
      } as any,
    } as Partial<EventRouterDeps>;
    const h = harness(deps);

    await h.fire(reactionEvent());

    expect(h.onReactionAdded).not.toHaveBeenCalled();
  });

  /**
   * The real helper does NOT throw on a failed `auth.test` — it answers `''`
   * (`slack-api-helper.ts` `getBotUserId`). An empty id compares equal to
   * nothing, so a router that only guarded against a throw would forward the
   * bot's own reactions and let the surface answer its own controls.
   */
  it('drops the event when the bot identity comes back empty', async () => {
    const h = harness({
      slackApi: { getBotUserId: vi.fn().mockResolvedValue(''), getClient: vi.fn() } as any,
    } as Partial<EventRouterDeps>);

    await h.fire(reactionEvent());

    expect(h.onReactionAdded).not.toHaveBeenCalled();
  });

  /** …and a bad answer poisons nothing: the next event asks again. */
  it('recovers on the next event after an identity failure', async () => {
    const getBotUserId = vi
      .fn()
      .mockRejectedValueOnce(new Error('auth.test failed'))
      .mockResolvedValueOnce('')
      .mockResolvedValue('U_BOT');
    const h = harness({ slackApi: { getBotUserId, getClient: vi.fn() } as any } as Partial<EventRouterDeps>);

    await h.fire(reactionEvent());
    await h.fire(reactionEvent());
    expect(h.onReactionAdded).not.toHaveBeenCalled();

    await h.fire(reactionEvent());

    expect(h.onReactionAdded).toHaveBeenCalledTimes(1);
  });

  it('forwards nothing when the host declared no control reactions', async () => {
    const h = harness({ isFollowupControlReaction: undefined } as Partial<EventRouterDeps>);

    await h.fire(reactionEvent());

    expect(h.onReactionAdded).not.toHaveBeenCalled();
  });

  it('survives a throwing host hook — a reaction must not break the listener', async () => {
    const onReactionAdded = vi.fn(() => {
      throw new Error('host queue bug');
    });
    const h = harness({ onReactionAdded } as Partial<EventRouterDeps>);

    await expect(h.fire(reactionEvent())).resolves.toBeUndefined();
    expect(onReactionAdded).toHaveBeenCalledTimes(1);
  });

  it('runs without the hook wired at all', async () => {
    const h = harness({ onReactionAdded: undefined } as Partial<EventRouterDeps>);

    await expect(h.fire(reactionEvent())).resolves.toBeUndefined();
  });
});
