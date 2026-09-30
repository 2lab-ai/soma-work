import { describe, expect, it, vi } from 'vitest';
import { EventRouter, type EventRouterDeps } from '../event-router';

/**
 * `message_changed` routing (06 §3.4 D3, §6.5).
 *
 * Edit has no UI of its own: editing the Slack message IS the edit, so the
 * queue can only learn about it from the `message_changed` event. Today that
 * event is dropped twice over — the bot guard at the top of the `message`
 * listener rejects it (the top level carries no `user`; the author lives in
 * `event.message`), and neither remaining branch matches its subtype.
 *
 * These tests pin the ROUTING only. What the host does with an edit (which item
 * it belongs to, whether it is still editable) is the host's decision, tested
 * against the real queue in `src/__tests__/slack-handler.followup.test.ts` —
 * re-deciding it here would be a second policy.
 */

const CHANNEL = 'C-EDIT';
const THREAD = '1700.000000';

type EventListener = (args: { event: any; say: any }) => Promise<void>;

function harness(over: Partial<EventRouterDeps> = {}) {
  const events = new Map<string, EventListener>();
  const app = {
    message: vi.fn(),
    event: vi.fn((name: string, listener: EventListener) => {
      events.set(name, listener);
    }),
    command: vi.fn(),
  } as any;

  const messageHandler = vi.fn(async () => {});
  const onMessageEdited = vi.fn(async () => {});
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
    onMessageEdited,
    ...over,
  } as EventRouterDeps;

  const router = new EventRouter(app, deps, messageHandler);
  // The message listeners only — `setup()` also installs a 5-minute cleanup
  // interval and the slash surface, neither of which this routing is about.
  (router as any).setupMessageHandlers();

  const listener = events.get('message');
  if (!listener) throw new Error('no `message` listener registered');

  return {
    router,
    messageHandler,
    onMessageEdited,
    fire: (event: any) => listener({ event, say: vi.fn() }),
  };
}

/** A real `message_changed` envelope: the author and the text live one level down. */
function editEvent(over: Record<string, unknown> = {}, messageOver: Record<string, unknown> = {}): any {
  return {
    type: 'message',
    subtype: 'message_changed',
    channel: CHANNEL,
    ts: '1700.000900',
    message: {
      type: 'message',
      user: 'U_AUTHOR',
      ts: '1700.000100',
      thread_ts: THREAD,
      text: '배포 상태 말고 로그 보여줘',
      edited: { user: 'U_AUTHOR', ts: '1700.000900' },
      ...messageOver,
    },
    previous_message: { user: 'U_AUTHOR', ts: '1700.000100', thread_ts: THREAD, text: '배포 상태 알려줘' },
    ...over,
  };
}

describe('EventRouter — message_changed', () => {
  it('routes a thread message edit to onMessageEdited with the EDITED message ts and text', async () => {
    const h = harness();

    await h.fire(editEvent());

    expect(h.onMessageEdited).toHaveBeenCalledTimes(1);
    expect(h.onMessageEdited.mock.calls[0][0]).toEqual({
      channel: CHANNEL,
      // The queue's dedup key is `<channel>:<original ts>` — the envelope's own
      // `ts` is the edit's timestamp and would match no item.
      ts: '1700.000100',
      threadTs: THREAD,
      user: 'U_AUTHOR',
      text: '배포 상태 말고 로그 보여줘',
    });
  });

  it('never re-runs the edited message as a new turn', async () => {
    const h = harness();

    await h.fire(editEvent());

    expect(h.messageHandler).not.toHaveBeenCalled();
  });

  it('ignores an edit outside a thread — there is no session queue to edit', async () => {
    const h = harness();

    await h.fire(editEvent({}, { thread_ts: undefined }));

    expect(h.onMessageEdited).not.toHaveBeenCalled();
  });

  it('ignores an edit of a bot message', async () => {
    const h = harness();

    await h.fire(editEvent({}, { user: undefined, bot_id: 'B1' }));

    expect(h.onMessageEdited).not.toHaveBeenCalled();
  });

  it('ignores an edit whose message carries a bot_id even with a user field', async () => {
    const h = harness();

    await h.fire(editEvent({}, { bot_id: 'B1' }));

    expect(h.onMessageEdited).not.toHaveBeenCalled();
  });

  it('treats a missing text as empty rather than dropping the edit', async () => {
    const h = harness();

    await h.fire(editEvent({}, { text: undefined }));

    expect(h.onMessageEdited.mock.calls[0][0]).toMatchObject({ text: '' });
  });

  it('survives a throwing host hook — an edit must not break the message listener', async () => {
    const onMessageEdited = vi.fn(() => {
      throw new Error('host queue bug');
    });
    const h = harness({ onMessageEdited } as Partial<EventRouterDeps>);

    await expect(h.fire(editEvent())).resolves.toBeUndefined();
    expect(onMessageEdited).toHaveBeenCalledTimes(1);
  });

  it('runs without the hook wired at all', async () => {
    const h = harness({ onMessageEdited: undefined } as Partial<EventRouterDeps>);

    await expect(h.fire(editEvent())).resolves.toBeUndefined();
    expect(h.messageHandler).not.toHaveBeenCalled();
  });

  it('does not treat an ordinary new thread message as an edit', async () => {
    const h = harness();

    await h.fire({
      type: 'message',
      channel: CHANNEL,
      user: 'U_AUTHOR',
      ts: '1700.000200',
      thread_ts: THREAD,
      text: '새 메시지',
    });

    expect(h.onMessageEdited).not.toHaveBeenCalled();
  });
});
