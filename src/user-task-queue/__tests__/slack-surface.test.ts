import { describe, expect, it, vi } from 'vitest';
import type { UserTaskEntry } from '../ledger';
import { queueActionValue, USER_TASK_QUEUE_BYPASS_ACTION_ID, USER_TASK_QUEUE_CANCEL_ACTION_ID } from '../slack-notice';
import { createUserTaskSlackNotifier, handleUserTaskQueueAction, registerUserTaskQueueActions } from '../slack-surface';

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

const entry: UserTaskEntry = {
  id: 'e1',
  userId: 'U1',
  kind: 'request',
  sessionKey: 'C1:2.0',
  channel: 'C1',
  threadTs: '2.0',
  preview: '두 번째 일',
  enqueuedAt: 1,
  state: 'waiting',
};

function api() {
  return {
    postMessage: vi.fn().mockResolvedValue({ ts: '2.5', channel: 'C1' }),
    updateMessage: vi.fn().mockResolvedValue(undefined),
    getPermalink: vi.fn(async (c: string, ts: string) => `https://slack/${c}/${ts}`),
    postEphemeral: vi.fn().mockResolvedValue({}),
  };
}

describe('createUserTaskSlackNotifier', () => {
  it('posts the queued notice in the waiting thread, naming the running thread by link, and remembers it', async () => {
    const slackApi = api();
    const setNotice = vi.fn();
    const notifier = createUserTaskSlackNotifier({
      slackApi,
      queue: () => ({ setNotice, viewFor: () => ({ waiting: [{ state: 'waiting' }] }) as any, entry: () => undefined }),
    });
    notifier.queued(entry, {
      position: 1,
      limit: 1,
      running: [{ sessionKey: 'C1:1.0', channel: 'C1', threadTs: '1.0', title: '첫 일' }],
    });
    await flush();
    expect(slackApi.postMessage).toHaveBeenCalledTimes(1);
    const [channel, text, opts] = slackApi.postMessage.mock.calls[0];
    expect(channel).toBe('C1');
    expect(text).toContain('대기');
    expect(opts.threadTs).toBe('2.0');
    expect(JSON.stringify(opts.blocks)).toContain('<https://slack/C1/1.0|첫 일>');
    expect(setNotice).toHaveBeenCalledWith('e1', { channel: 'C1', ts: '2.5' });
  });

  it('rewrites that notice when the entry starts — even if the post had not finished yet', async () => {
    const slackApi = api();
    let release!: (v: any) => void;
    slackApi.postMessage.mockImplementationOnce(() => new Promise((r) => (release = r)));
    const notifier = createUserTaskSlackNotifier({
      slackApi,
      queue: () => ({ setNotice: vi.fn(), viewFor: () => ({ waiting: [] }) as any, entry: () => undefined }),
    });
    notifier.queued(entry, { position: 1, limit: 1, running: [] });
    notifier.started(entry, 'turn');
    await flush();
    expect(slackApi.updateMessage).not.toHaveBeenCalled();
    release({ ts: '2.5', channel: 'C1' });
    await flush();
    expect(slackApi.updateMessage).toHaveBeenCalledTimes(1);
    expect(slackApi.updateMessage.mock.calls[0].slice(0, 2)).toEqual(['C1', '2.5']);
    expect(slackApi.updateMessage.mock.calls[0][2]).toContain('시작');
  });

  it('deferred: tells the stopped thread which task went first; the first one names what it pushed back', async () => {
    const slackApi = api();
    const notifier = createUserTaskSlackNotifier({
      slackApi,
      queue: () => ({
        setNotice: vi.fn(),
        viewFor: () => ({ waiting: [] }) as any,
        entry: () => ({ ...entry, notice: { channel: 'C1', ts: '2.5' } }),
      }),
    });
    notifier.deferred({ sessionKey: 'C1:1.0', channel: 'C1', threadTs: '1.0', title: '첫 일' }, entry);
    await flush();
    notifier.started(entry, 'bypass');
    await flush();
    const post = slackApi.postMessage.mock.calls.find((c) => c[2]?.threadTs === '1.0');
    expect(post?.[1]).toContain('멈췄습니다');
    expect(JSON.stringify(post?.[2].blocks)).toContain('<https://slack/C1/2.0|두 번째 일>');
    expect(JSON.stringify(slackApi.updateMessage.mock.calls[0][3])).toContain('<https://slack/C1/1.0|첫 일>');
  });

  it('a private request waiting ahead is counted in a public notice, never named or linked', async () => {
    const slackApi = api();
    const notifier = createUserTaskSlackNotifier({
      slackApi,
      isPrivateChannel: (c) => c.startsWith('D'),
      queue: () => ({ setNotice: vi.fn(), viewFor: () => ({ waiting: [] }) as any, entry: () => undefined }),
    });
    notifier.queued(entry, {
      position: 2,
      limit: 1,
      running: [{ sessionKey: 'C1:1.0', channel: 'C1', threadTs: '1.0', title: '첫 일' }],
      ahead: { ...entry, id: 'e0', sessionKey: 'D3:4.0', channel: 'D3', threadTs: '4.0', preview: 'DM의 비밀 요청' },
    });
    await flush();
    const body = JSON.stringify(slackApi.postMessage.mock.calls[0][2].blocks);
    expect(body).toContain('앞에서 기다리는 작업 1개');
    expect(body).toContain('비공개 작업');
    expect(body).not.toContain('DM의 비밀 요청');
    expect(body).not.toContain('https://slack/D3');
  });

  it('a private task is not named in another thread: no title, no link', async () => {
    const slackApi = api();
    const notifier = createUserTaskSlackNotifier({
      slackApi,
      isPrivateChannel: (c) => c.startsWith('D'),
      queue: () => ({ setNotice: vi.fn(), viewFor: () => ({ waiting: [] }) as any, entry: () => undefined }),
    });
    notifier.queued(entry, {
      position: 1,
      limit: 1,
      running: [{ sessionKey: 'D1:1.0', channel: 'D1', threadTs: '1.0', title: '비밀 프로젝트 X' }],
    });
    await flush();
    const body = JSON.stringify(slackApi.postMessage.mock.calls[0][2].blocks);
    expect(body).not.toContain('비밀 프로젝트 X');
    expect(body).not.toContain('https://slack/D1');
    expect(body).toContain('비공개 작업');
    // The stopped public thread is not told what the private request says either.
    notifier.deferred(
      { sessionKey: 'C1:1.0', channel: 'C1', threadTs: '1.0', title: 'public' },
      {
        ...entry,
        channel: 'D2',
        threadTs: '9.0',
        preview: 'DM에서 한 비밀 요청',
      },
    );
    await flush();
    const deferredPost = slackApi.postMessage.mock.calls.find((c) => c[2]?.threadTs === '1.0');
    expect(JSON.stringify(deferredPost?.[2].blocks)).not.toContain('DM에서 한 비밀 요청');
  });

  it('a Slack failure never throws into the queue', async () => {
    const slackApi = api();
    slackApi.postMessage.mockRejectedValue(new Error('rate limited'));
    const notifier = createUserTaskSlackNotifier({ slackApi, queue: () => undefined });
    expect(() => notifier.queued(entry, { position: 1, limit: 1, running: [] })).not.toThrow();
    await flush();
  });
});

describe('the queued notice buttons', () => {
  const body = (actionId: string, user = 'U1') => ({
    user: { id: user },
    channel: { id: 'C1' },
    message: { thread_ts: '2.0' },
    actions: [{ action_id: actionId, value: queueActionValue('e1') }],
  });

  it('먼저 진행 → bypass as the clicker; 대기 취소 → cancel', async () => {
    const queue = { bypass: vi.fn(() => ({ ok: true as const })), cancel: vi.fn(() => ({ ok: true as const })) };
    const deps = { queue: () => queue, isAdmin: () => false, slackApi: { postEphemeral: vi.fn() } };
    await handleUserTaskQueueAction('bypass', body(USER_TASK_QUEUE_BYPASS_ACTION_ID), deps);
    await handleUserTaskQueueAction('cancel', body(USER_TASK_QUEUE_CANCEL_ACTION_ID), deps);
    expect(queue.bypass).toHaveBeenCalledWith('e1', 'U1', { admin: false });
    expect(queue.cancel).toHaveBeenCalledWith('e1', 'U1', { admin: false });
  });

  it('a refused click is told why, only to the clicker', async () => {
    const queue = { bypass: vi.fn(() => ({ ok: false as const, reason: 'forbidden' as const })), cancel: vi.fn() };
    const postEphemeral = vi.fn().mockResolvedValue({});
    await handleUserTaskQueueAction('bypass', body(USER_TASK_QUEUE_BYPASS_ACTION_ID, 'U2'), {
      queue: () => queue as any,
      isAdmin: () => false,
      slackApi: { postEphemeral },
    });
    expect(postEphemeral).toHaveBeenCalledWith('C1', 'U2', expect.stringContaining('관리자'), '2.0');
  });

  it('registers both buttons and acks them', async () => {
    const handlers = new Map<string, (args: any) => Promise<void>>();
    const app = { action: (id: string, fn: any) => handlers.set(id, fn) } as any;
    const queue = { bypass: vi.fn(() => ({ ok: true as const })), cancel: vi.fn(() => ({ ok: true as const })) };
    registerUserTaskQueueActions(app, { queue: () => queue, isAdmin: () => true, slackApi: {} });
    expect([...handlers.keys()].sort()).toEqual(
      [USER_TASK_QUEUE_BYPASS_ACTION_ID, USER_TASK_QUEUE_CANCEL_ACTION_ID].sort(),
    );
    const ack = vi.fn();
    await handlers.get(USER_TASK_QUEUE_BYPASS_ACTION_ID)?.({ ack, body: body(USER_TASK_QUEUE_BYPASS_ACTION_ID) });
    expect(ack).toHaveBeenCalled();
    expect(queue.bypass).toHaveBeenCalledWith('e1', 'U1', { admin: true });
  });
});
