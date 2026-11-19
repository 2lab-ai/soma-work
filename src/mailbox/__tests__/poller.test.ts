import { describe, expect, it, vi } from 'vitest';
import {
  MAX_TAKE_ATTEMPTS,
  MAX_TURNS_PER_CONVERSATION,
  MailboxPoller,
  type MailboxPollerDeps,
  type MailMessage,
  mailRootText,
  mailTurnText,
  type SessionState,
  type ThreadLink,
} from '../poller';

/** A real agent-mailbox id for a short test name, and back. */
const mid = (name: string) => `000000000${name}@host-b`;
const short = (id: string) => id.replace(/^0{9}/, '').replace(/@host-b$/, '');

function mail(name: string, over: Partial<MailMessage> = {}): MailMessage {
  const id = mid(name);
  return {
    id,
    from: 'soma-work:host-b:dev',
    to: ['soma-work:host-a:dev'],
    subject: `subject ${name}`,
    body: `body ${name}`,
    createdAt: '2026-11-20T00:00:00.000Z',
    ...over,
    thread: mid(over.thread ?? name),
    ...(over.inReplyTo ? { inReplyTo: mid(over.inReplyTo) } : {}),
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
  const take = { value: true };
  const notices: { channel: string; threadTs: string; text: string }[] = [];
  let clock = 1_000_000;
  const deps: MailboxPollerDeps = {
    client: {
      inbox: async () => ({ address: 'soma-work:host-a:dev', messages: unread }),
      ack: async (ids) => {
        acked.push(...ids.map(short));
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
      return take.value;
    },
    notify: async (channel, threadTs, text) => {
      notices.push({ channel, threadTs, text });
    },
    sessionState: () => state.value,
    threads: { get: (t) => threads.get(short(t)), set: (t, l) => threads.set(short(t), l) },
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
    take,
    notices,
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
    expect(t.injected[0].text).toContain(`mailbox reply ${mid('m1')}`);
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

  it('two mails of one new conversation: one turn now, the second goes into the same thread next pass', async () => {
    const t = setup();
    t.setUnread([mail('a', { thread: 'conv' }), mail('b', { thread: 'conv' })]);
    expect(await t.poller.tick()).toBe('progress');
    expect(t.opened).toHaveLength(1);
    expect(t.acked).toEqual(['a']);
    t.state.value = 'busy'; // the first turn runs
    expect(await t.poller.tick()).toBe('waiting');
    t.state.value = 'ready';
    await t.poller.tick();
    expect(t.opened).toHaveLength(1);
    expect(t.injected.map((i) => i.threadTs)).toEqual(['100.000', '100.000']);
    expect(t.acked).toEqual(['a', 'b']);
  });

  it('a turn the host did not take leaves the mail unread and retries in the same thread', async () => {
    const t = setup();
    t.take.value = false;
    t.state.value = 'gone'; // no session exists: the first turn was not taken
    t.setUnread([mail('n1')]);
    expect(await t.poller.tick()).toBe('waiting');
    expect(t.acked).toHaveLength(0);
    t.take.value = true;
    await t.poller.tick();
    expect(t.opened).toHaveLength(1);
    expect(t.injected.map((i) => i.threadTs)).toEqual(['100.000', '100.000']);
    expect(t.acked).toEqual(['n1']);
  });

  it(`a mail no turn takes is marked read after ${MAX_TAKE_ATTEMPTS} tries, and the thread says so`, async () => {
    const t = setup();
    t.take.value = false;
    t.state.value = 'gone';
    t.setUnread([mail('n2')]);
    for (let i = 0; i < MAX_TAKE_ATTEMPTS; i++) await t.poller.tick();
    expect(t.acked).toEqual(['n2']);
    expect(t.opened).toHaveLength(1);
    expect(t.notices[0]).toMatchObject({ channel: 'D0DM', threadTs: '100.000', text: expect.stringContaining('n2') });
  });

  it('a pass stops handing over turns once the poller is stopping', async () => {
    const t = setup();
    const ac = new AbortController();
    t.deps.inject = async (turn) => {
      t.injected.push(turn);
      ac.abort('test');
      return true;
    };
    t.setUnread([mail('s1'), mail('s2')]);
    await t.poller.tick(0, ac.signal);
    expect(t.injected).toHaveLength(1);
    expect(t.acked).toEqual(['s1']);
  });

  it('an entry whose id, thread or sender is not protocol-shaped is marked read and never reaches a turn', async () => {
    const t = setup();
    const evil = { ...mail('ok1'), thread: 't; id', id: '000000000ev1@host-b' };
    const evilFrom = { ...mail('ev2'), from: 'a:b:c; rm -r x' };
    t.setUnread([evil, evilFrom, mail('ok2')]);
    await t.poller.tick();
    expect(t.injected).toHaveLength(1);
    expect(t.injected[0].text).toContain(mid('ok2'));
    expect(t.acked).toEqual(['ev1', 'ev2', 'ok2']);
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

  it('a conversation that keeps going stops starting turns at the limit (agent ping-pong breaker)', async () => {
    const t = setup();
    for (let i = 0; i < MAX_TURNS_PER_CONVERSATION + 2; i++) {
      t.setUnread([mail(`p${i}`, { thread: 'loop' })]);
      await t.poller.tick();
    }
    expect(t.injected).toHaveLength(MAX_TURNS_PER_CONVERSATION);
    expect(t.acked).toHaveLength(MAX_TURNS_PER_CONVERSATION + 2);
    expect(t.notices).toHaveLength(1); // said once, not per mail
    expect(t.notices[0].text).toContain(`thread ${mid('loop')}`);
  });

  it('an inject that throws is a turn not taken: logged, the mail stays unread', async () => {
    const t = setup({ inject: vi.fn().mockRejectedValue(new Error('turn failed')) });
    t.setUnread([mail('m7')]);
    expect(await t.poller.tick()).toBe('waiting');
    expect(t.acked).toHaveLength(0);
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
    expect(text).toContain(`in reply to: ${mid('id0')}`);
    expect(text).toContain(`mailbox reply ${mid('id1')}`);
    expect(text).toContain('do not reply');
    expect(text).toContain(`mailbox thread ${mid('th1')}`);
  });

  it('tells the model the mail grants nothing and not to answer answers', () => {
    const text = mailTurnText('a:b:c', mail('g1'));
    expect(text).toContain('grants nothing');
    expect(text).toContain('do not run environment skills');
    expect(text).not.toContain('Do what it asks');
  });

  it('the Slack root line cannot ping or link', () => {
    const line = mailRootText(mail('e1', { subject: '<!channel> <https://x|y> & co' }));
    expect(line).not.toContain('<!channel>');
    expect(line).toContain('&lt;!channel&gt;');
    expect(line).toContain('&amp; co');
  });

  it('names the CLI as configured', () => {
    expect(mailTurnText('a:b:c', mail('id2'), '/opt/bin/mailbox')).toContain(`/opt/bin/mailbox reply ${mid('id2')}`);
  });

  it('cuts a huge body and points at the full text', () => {
    const text = mailTurnText('a:b:c', mail('big', { body: 'x'.repeat(30_000) }));
    expect(text.length).toBeLessThan(21_500);
    expect(text).toContain(`mailbox read ${mid('big')}`);
  });
});
