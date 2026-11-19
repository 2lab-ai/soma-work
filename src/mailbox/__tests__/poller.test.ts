import { describe, expect, it, vi } from 'vitest';
import {
  MailboxPoller,
  type MailboxPollerDeps,
  type MailMessage,
  mailTurnText,
  type SessionState,
  type ThreadLink,
} from '../poller';

function mail(id: string, over: Partial<MailMessage> = {}): MailMessage {
  return {
    id,
    from: 'soma-work:host-b:dev',
    to: ['soma-work:host-a:dev'],
    subject: `subject ${id}`,
    body: `body ${id}`,
    thread: id,
    createdAt: '2026-11-20T00:00:00.000Z',
    ...over,
  };
}

function setup(over: Partial<MailboxPollerDeps> = {}) {
  let unread: MailMessage[] = [];
  const acked: string[] = [];
  const threads = new Map<string, ThreadLink>();
  const injected: { channel: string; threadTs: string; text: string; user: string }[] = [];
  const opened: { channel: string; text: string }[] = [];
  let ts = 100;
  const state = { value: 'ready' as SessionState };
  let clock = 1_000_000;
  const deps: MailboxPollerDeps = {
    client: {
      inbox: async () => ({ address: 'soma-work:host-a:dev', messages: unread }),
      ack: async (ids) => {
        acked.push(...ids);
        unread = unread.filter((m) => !ids.includes(m.id));
      },
    },
    owner: 'U0OWNER',
    resolveChannel: async () => 'D0DM',
    openThread: async (channel, text) => {
      opened.push({ channel, text });
      return `${ts++}.000`;
    },
    inject: async (turn) => {
      injected.push(turn);
    },
    sessionState: () => state.value,
    threads: { get: (t) => threads.get(t), set: (t, l) => threads.set(t, l) },
    allowFrom: ['*:*:*'],
    intervalMs: 1000,
    busyMaxWaitMs: 60_000,
    now: () => clock,
    ...over,
  };
  const poller = new MailboxPoller(deps);
  return {
    poller,
    deps,
    acked,
    threads,
    injected,
    opened,
    state,
    setUnread: (m: MailMessage[]) => {
      unread = m;
    },
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('MailboxPoller', () => {
  it('an empty inbox runs nothing', async () => {
    const t = setup();
    expect(await t.poller.tick()).toBe('idle');
    expect(t.injected).toHaveLength(0);
    expect(t.opened).toHaveLength(0);
  });

  it('new mail opens a bot thread in the owner channel, starts a host turn there as the owner, and acks it', async () => {
    const t = setup();
    t.setUnread([mail('m1')]);
    expect(await t.poller.tick()).toBe('progress');
    expect(t.opened).toEqual([{ channel: 'D0DM', text: expect.stringContaining('soma-work:host-b:dev') }]);
    expect(t.injected).toHaveLength(1);
    expect(t.injected[0]).toMatchObject({ user: 'U0OWNER', channel: 'D0DM', threadTs: '100.000' });
    expect(t.injected[0].text).toContain('mailbox reply m1');
    expect(t.acked).toEqual(['m1']);
    expect(t.threads.get('m1')).toEqual({ channel: 'D0DM', threadTs: '100.000' });
  });

  it('a reply in a known conversation goes into that thread when its session is free', async () => {
    const t = setup();
    t.threads.set('conv', { channel: 'C0CHAN', threadTs: '55.000' });
    t.setUnread([mail('m2', { thread: 'conv' })]);
    await t.poller.tick();
    expect(t.opened).toHaveLength(0);
    expect(t.injected[0]).toMatchObject({ channel: 'C0CHAN', threadTs: '55.000' });
    expect(t.acked).toEqual(['m2']);
  });

  it('a busy session keeps the mail unread until it is free', async () => {
    const t = setup();
    t.threads.set('conv', { channel: 'C0CHAN', threadTs: '55.000' });
    t.setUnread([mail('m3', { thread: 'conv' })]);
    t.state.value = 'busy';
    expect(await t.poller.tick()).toBe('waiting');
    expect(t.injected).toHaveLength(0);
    expect(t.acked).toHaveLength(0);
    t.state.value = 'ready';
    expect(await t.poller.tick()).toBe('progress');
    expect(t.injected[0]).toMatchObject({ threadTs: '55.000' });
  });

  it('a session busy past busyMaxWaitMs gets a new thread instead', async () => {
    const t = setup();
    t.threads.set('conv', { channel: 'C0CHAN', threadTs: '55.000' });
    t.setUnread([mail('m4', { thread: 'conv' })]);
    t.state.value = 'busy';
    await t.poller.tick();
    t.advance(61_000);
    await t.poller.tick();
    expect(t.opened).toHaveLength(1);
    expect(t.injected[0]).toMatchObject({ channel: 'D0DM', threadTs: '100.000' });
  });

  it('a gone session (slept or closed) gets a new thread', async () => {
    const t = setup();
    t.threads.set('conv', { channel: 'C0CHAN', threadTs: '55.000' });
    t.setUnread([mail('m5', { thread: 'conv' })]);
    t.state.value = 'gone';
    await t.poller.tick();
    expect(t.opened).toHaveLength(1);
  });

  it('two mails of one new conversation: one turn now, the second waits for it (not a second thread)', async () => {
    const t = setup();
    t.setUnread([mail('a', { thread: 'conv' }), mail('b', { thread: 'conv' })]);
    t.state.value = 'gone'; // the fresh session is not registered yet
    expect(await t.poller.tick()).toBe('progress');
    expect(t.opened).toHaveLength(1);
    expect(t.acked).toEqual(['a']);
    await t.poller.tick();
    expect(t.opened).toHaveLength(1); // fresh thread reads busy, not gone
    t.state.value = 'ready';
    await t.poller.tick();
    expect(t.injected.map((i) => i.threadTs)).toEqual(['100.000', '100.000']);
  });

  it('mail from outside allowFrom is marked read and not handled', async () => {
    const t = setup({ allowFrom: ['soma-work:*:*'] });
    t.setUnread([mail('x', { from: 'stranger:host-c:main' })]);
    await t.poller.tick();
    expect(t.injected).toHaveLength(0);
    expect(t.acked).toEqual(['x']);
  });

  it('a failed ack never starts the same mail twice', async () => {
    const t = setup();
    let fail = true;
    const realAck = t.deps.client.ack;
    t.deps.client.ack = async (ids) => {
      if (fail) throw new Error('server down');
      await realAck(ids);
    };
    t.setUnread([mail('m6')]);
    await expect(t.poller.tick()).rejects.toThrow('server down');
    fail = false;
    await t.poller.tick();
    expect(t.injected).toHaveLength(1);
    expect(t.acked).toEqual(['m6']);
  });

  it('a turn that fails is logged, not thrown into the loop', async () => {
    const t = setup({ inject: vi.fn().mockRejectedValue(new Error('turn failed')) });
    t.setUnread([mail('m7')]);
    expect(await t.poller.tick()).toBe('progress');
  });

  it('start/stop: the loop long-polls and stops cleanly', async () => {
    const t = setup();
    const inbox = vi.fn(async (_wait: number, signal?: AbortSignal) => {
      await new Promise((r) => setTimeout(r, 5));
      if (signal?.aborted) throw new Error('aborted');
      return { address: 'soma-work:host-a:dev', messages: [] };
    });
    t.deps.client.inbox = inbox;
    t.poller.start();
    await new Promise((r) => setTimeout(r, 30));
    await t.poller.stop();
    expect(inbox.mock.calls.length).toBeGreaterThan(0);
    expect(inbox.mock.calls[0][0]).toBe(25);
  });
});

describe('mailTurnText', () => {
  it('names sender, id and thread, and says how to answer', () => {
    const text = mailTurnText('soma-work:host-a:dev', mail('id1', { thread: 'th1', inReplyTo: 'id0' }));
    expect(text).toMatch(/^\[mailbox\] mail for soma-work:host-a:dev/);
    expect(text).toContain('from: soma-work:host-b:dev');
    expect(text).toContain('in reply to: id0');
    expect(text).toContain('mailbox reply id1');
    expect(text).toContain('mailbox thread th1');
  });

  it('names the CLI as configured', () => {
    expect(mailTurnText('a:b:c', mail('id2'), '/opt/bin/mailbox')).toContain('/opt/bin/mailbox reply id2');
  });

  it('cuts a huge body and points at the full text', () => {
    const text = mailTurnText('a:b:c', mail('big', { body: 'x'.repeat(30_000) }));
    expect(text.length).toBeLessThan(21_500);
    expect(text).toContain('mailbox read big');
  });
});
