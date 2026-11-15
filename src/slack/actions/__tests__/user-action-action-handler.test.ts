import { inspectUserActionScript, type UserActionRecord } from 'somalib/user-action/user-action';
import { describe, expect, it, vi } from 'vitest';
import type { ConversationSession } from '../../../types';
import { USER_ACTION_DONE_ACTION_ID, USER_ACTION_FAILED_ACTION_ID } from '../../user-action-card';
import { setUserActionNotifier } from '../../user-action-host';
import {
  USER_ACTION_ALREADY_TEXT,
  USER_ACTION_NOT_DELIVERED_TEXT,
  USER_ACTION_OWNER_ONLY_TEXT,
  UserActionActionHandler,
} from '../user-action-action-handler';

function action(): UserActionRecord {
  const script = "open 'https://example.com/verify'";
  return {
    id: 'ua_1',
    title: '인증 페이지 열기',
    host: 'owner-mac',
    why: '소유자 본인만 할 수 있다.',
    script,
    shell: 'bash',
    expect: '페이지가 열린다',
    effects: '페이지를 연다.',
    optional: false,
    createdAt: 1,
    status: 'pending',
    slackTs: '111.222',
    inspection: inspectUserActionScript(script, 'bash', { checked: true, ok: true, tool: 'bash -n' }),
  };
}

function setup(mayAnswer = true) {
  const session = {
    ownerId: 'U_OWNER',
    channelId: 'C1',
    threadTs: '1.0',
    userActions: [action()],
  } as unknown as ConversationSession;
  const deps = {
    slackApi: {
      postMessage: vi.fn(async () => ({ ts: 'm' })),
      updateMessage: vi.fn(async () => undefined),
      postEphemeral: vi.fn(async () => undefined),
    },
    getSessionByKey: vi.fn(() => session),
    persistAndBroadcast: vi.fn(),
    mayAnswer: vi.fn(() => mayAnswer),
    messageHandler: vi.fn(async () => undefined),
    now: () => 77,
  };
  return { session, deps, handler: new UserActionActionHandler(deps) };
}

const click = (actionId: string, user = 'U_OWNER') => ({
  user: { id: user },
  channel: { id: 'C1' },
  message: { ts: '111.222', thread_ts: '1.0' },
  actions: [{ action_id: actionId, value: JSON.stringify({ sessionKey: 'work:C1:1.0', id: 'ua_1' }) }],
});

describe('UserActionActionHandler', () => {
  it('done: marks it, rewrites the card, and tells the agent in the thread', async () => {
    const { session, deps, handler } = setup();
    await handler.handleResolve(click(USER_ACTION_DONE_ACTION_ID), vi.fn());
    expect(session.userActions?.[0]).toMatchObject({ status: 'done', resolvedBy: 'U_OWNER', resolvedAt: 77 });
    expect(deps.slackApi.updateMessage).toHaveBeenCalledTimes(1);
    expect(deps.messageHandler).toHaveBeenCalledTimes(1);
    const [event] = deps.messageHandler.mock.calls[0] as any[];
    expect(event).toMatchObject({ user: 'U_OWNER', channel: 'C1', thread_ts: '1.0' });
    expect(event.text).toContain('사용자 작업 완료');
    expect(event.text).toContain('[user-action ua_1]');
  });

  it('failed: the agent is told it did not work', async () => {
    const { session, deps, handler } = setup();
    await handler.handleResolve(click(USER_ACTION_FAILED_ACTION_ID), vi.fn());
    expect(session.userActions?.[0].status).toBe('failed');
    expect((deps.messageHandler.mock.calls[0] as any[])[0].text).toContain('안 됨');
  });

  it('someone who may not speak for the session changes nothing and is told why', async () => {
    const { session, deps, handler } = setup(false);
    await handler.handleResolve(click(USER_ACTION_DONE_ACTION_ID, 'U_OTHER'), vi.fn());
    expect(session.userActions?.[0].status).toBe('pending');
    expect(deps.messageHandler).not.toHaveBeenCalled();
    expect(deps.slackApi.postEphemeral).toHaveBeenCalledWith('C1', 'U_OTHER', USER_ACTION_OWNER_ONLY_TEXT);
  });

  it('when the message path throws, the task goes back to pending and the clicker is told to press again', async () => {
    const { session, deps, handler } = setup();
    deps.messageHandler.mockRejectedValueOnce(new Error('pipeline down'));
    await handler.handleResolve(click(USER_ACTION_DONE_ACTION_ID), vi.fn());
    expect(session.userActions?.[0].status).toBe('pending');
    expect(deps.slackApi.postEphemeral).toHaveBeenCalledWith('C1', 'U_OWNER', USER_ACTION_NOT_DELIVERED_TEXT);
    await handler.handleResolve(click(USER_ACTION_DONE_ACTION_ID), vi.fn());
    expect(session.userActions?.[0].status).toBe('done');
    expect(deps.messageHandler).toHaveBeenCalledTimes(2);
  });

  it('with the host notifier set, the click uses it (its acceptance decides), not the bare message path', async () => {
    const { session, deps, handler } = setup();
    const notifier = vi.fn(async () => false);
    setUserActionNotifier(notifier);
    try {
      await handler.handleResolve(click(USER_ACTION_DONE_ACTION_ID), vi.fn());
    } finally {
      setUserActionNotifier(undefined);
    }
    expect(notifier).toHaveBeenCalledWith('work:C1:1.0', expect.stringContaining('사용자 작업 완료'), 'U_OWNER');
    expect(deps.messageHandler).not.toHaveBeenCalled();
    expect(session.userActions?.[0].status).toBe('pending');
    expect(deps.slackApi.postEphemeral).toHaveBeenCalledWith('C1', 'U_OWNER', USER_ACTION_NOT_DELIVERED_TEXT);
  });

  it('a second click does not tell the agent twice', async () => {
    const { deps, handler } = setup();
    await handler.handleResolve(click(USER_ACTION_DONE_ACTION_ID), vi.fn());
    await handler.handleResolve(click(USER_ACTION_FAILED_ACTION_ID), vi.fn());
    expect(deps.messageHandler).toHaveBeenCalledTimes(1);
    expect(deps.slackApi.postEphemeral).toHaveBeenCalledWith('C1', 'U_OWNER', USER_ACTION_ALREADY_TEXT);
  });
});
