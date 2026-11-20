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

const BASE = 'soma-work:host-a:dev';
/** A real agent-mailbox id for a short test name. */
const mid = (name: string) => `000000000${name}@host-b`;
const short = (key: string) =>
  key
    .split('|')[0]
    .replace(/^0{9}/, '')
    .replace(/@host-b$/, '');
/** Session C0OTHER / 2222.000 → its tag. */
const OTHER = { channel: 'C0OTHER', threadTs: '2222.000' };
const OTHER_TAG = 'c0other-2222.000';

function mail(name: string, over: Partial<MailMessage> & { thread?: string; inReplyTo?: string } = {}): MailMessage {
  const id = mid(name);
  const rcpt = over.rcpt ?? BASE;
  return {
    id,
    from: 'soma-work:host-b:dev',
    to: [rcpt],
    subject: `subject ${name}`,
    body: `body ${name}`,
    createdAt: '2026-11-20T00:00:00.000Z',
    ...over,
    rcpt,
    entry: `${id}|${rcpt}`,
    thread: mid(over.thread ?? name),
    ...(over.inReplyTo ? { inReplyTo: mid(over.inReplyTo) } : {}),
  };
}

function setup(over: Partial<MailboxPollerDeps> = {}) {
  let unread: MailMessage[] = [];
  const acked: string[] = [];
  let main: ThreadLink | undefined;
  const owners = new Map<string, string>([
    ['C0OTHER', 'U0OWNER'],
    ['C0MAIN', 'U0OWNER'],
    ['C0OLD', 'U0OWNER'],
    ['C0SOMEONE', 'U0SOMEONE'],
  ]);
  const injected: { channel: string; threadTs: string; text: string; user: string }[] = [];
  const opened: { channel: string; text: string }[] = [];
  const notices: { channel: string; threadTs: string; text: string }[] = [];
  let ts = 100;
  const states = new Map<string, SessionState>();
  const take = { value: true };
  let clock = 1_000_000;
  const deps: MailboxPollerDeps = {
    client: {
      inbox: async () => ({ address: BASE, messages: unread }),
      ack: async (keys) => {
        acked.push(...keys.map(short));
        unread = unread.filter((m) => !keys.includes(m.entry ?? m.id));
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
    sessionState: (channel, threadTs) => states.get(`${channel}-${threadTs}`) ?? 'gone',
    sessionOwner: (channel) => owners.get(channel),
    mainSession: {
      get: () => main,
      set: (link) => {
        main = link;
      },
    },
    allowFrom: ['*:*:*'],
    intervalMs: 1000,
    now: () => clock,
    ...over,
  };
  return {
    poller: new MailboxPoller(deps),
    deps,
    acked,
    injected,
    opened,
    notices,
    take,
    states,
    getMain: () => (main ? { channel: main.channel, threadTs: main.threadTs } : undefined),
    owners,
    setMain: (l: ThreadLink) => {
      main = l;
    },
    setUnread: (m: MailMessage[]) => {
      unread = m;
    },
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('MailboxPoller — routing', () => {
  it('an empty inbox runs nothing', async () => {
    const t = setup();
    expect(await t.poller.tick()).toBe('idle');
    expect(t.injected).toHaveLength(0);
  });

  it('general mail with no main session yet opens a thread, records it as the main session, and acks by copy', async () => {
    const t = setup();
    t.setUnread([mail('g1')]);
    expect(await t.poller.tick()).toBe('progress');
    expect(t.opened).toEqual([{ channel: 'D0DM', text: expect.stringContaining('main mailbox session') }]);
    expect(t.getMain()).toEqual({ channel: 'D0DM', threadTs: '100.000' });
    expect(t.injected[0]).toMatchObject({ user: 'U0OWNER', channel: 'D0DM', threadTs: '100.000' });
    expect(t.injected[0].text).toContain('This is the main session of soma-work:host-a:dev');
    expect(t.injected[0].text).toContain("This session's own address: soma-work:host-a:dev/d0dm-100.000");
    expect(t.acked).toEqual(['g1']);
  });

  it('later general mail goes into the main session when it is free, waits while it is busy', async () => {
    const t = setup();
    t.setMain({ channel: 'C0MAIN', threadTs: '1111.000' });
    t.states.set('C0MAIN-1111.000', 'busy');
    t.setUnread([mail('g2')]);
    expect(await t.poller.tick()).toBe('waiting');
    expect(t.injected).toHaveLength(0);
    t.states.set('C0MAIN-1111.000', 'ready');
    expect(await t.poller.tick()).toBe('progress');
    expect(t.injected[0]).toMatchObject({ channel: 'C0MAIN', threadTs: '1111.000' });
    expect(t.opened).toHaveLength(0);
  });

  it('/main is the main session too', async () => {
    const t = setup();
    t.setMain({ channel: 'C0MAIN', threadTs: '1111.000' });
    t.states.set('C0MAIN-1111.000', 'ready');
    t.setUnread([mail('m1', { rcpt: `${BASE}/main` })]);
    await t.poller.tick();
    expect(t.injected[0]).toMatchObject({ channel: 'C0MAIN', threadTs: '1111.000' });
  });

  it('a main session busy past busyMaxWaitMs: the mail gets a one-off thread and the main session stays', async () => {
    const t = setup({ busyMaxWaitMs: 60_000 });
    t.setMain({ channel: 'C0MAIN', threadTs: '1111.000' });
    t.states.set('C0MAIN-1111.000', 'busy');
    t.setUnread([mail('g3')]);
    await t.poller.tick();
    t.advance(61_000);
    await t.poller.tick();
    expect(t.opened).toHaveLength(1);
    expect(t.injected[0].text).toContain('This thread was opened for this mail');
    expect(t.getMain()).toEqual({ channel: 'C0MAIN', threadTs: '1111.000' });
  });

  it('a main session that slept is tried in place first, then replaced by a new main session', async () => {
    const t = setup();
    t.setMain({ channel: 'C0OLD', threadTs: '1000.000' });
    t.take.value = false; // the sleeping thread does not take it
    t.setUnread([mail('g4')]);
    await t.poller.tick();
    expect(t.injected[0]).toMatchObject({ channel: 'C0OLD' });
    t.take.value = true;
    await t.poller.tick();
    expect(t.opened).toHaveLength(1);
    expect(t.getMain()).toEqual({ channel: 'D0DM', threadTs: '100.000' });
    expect(t.acked).toEqual(['g4']);
  });

  it('session mail goes straight into that session, as the mailbox owner whose session it is, the moment it is free', async () => {
    const t = setup();
    t.states.set('C0OTHER-2222.000', 'busy');
    t.setUnread([mail('s1', { rcpt: `${BASE}/${OTHER_TAG}` })]);
    expect(await t.poller.tick()).toBe('waiting');
    t.states.set('C0OTHER-2222.000', 'ready');
    await t.poller.tick();
    expect(t.injected[0]).toMatchObject({ user: 'U0OWNER', ...OTHER });
    expect(t.injected[0].text).toContain('This mail was addressed to this session.');
    expect(t.injected[0].text).toContain(`mail for ${BASE}/${OTHER_TAG}`);
    expect(t.opened).toHaveLength(0);
    expect(t.acked).toEqual(['s1']);
  });

  it('session mail for a sleeping session is tried in its own thread (wakes it)', async () => {
    const t = setup();
    t.setUnread([mail('s2', { rcpt: `${BASE}/${OTHER_TAG}` })]); // state: gone
    await t.poller.tick();
    expect(t.injected[0]).toMatchObject(OTHER);
    expect(t.acked).toEqual(['s2']);
  });

  it(`session mail its session cannot take after ${MAX_TAKE_ATTEMPTS} tries goes to the main session, saying why`, async () => {
    const t = setup();
    t.setMain({ channel: 'C0MAIN', threadTs: '1111.000' });
    t.states.set('C0MAIN-1111.000', 'ready');
    const refusing = vi.fn(async (turn: { channel: string }) => turn.channel !== 'C0OTHER');
    t.deps.inject = async (turn) => {
      t.injected.push(turn);
      return refusing(turn);
    };
    t.setUnread([mail('s3', { rcpt: `${BASE}/${OTHER_TAG}` })]);
    for (let i = 0; i < MAX_TAKE_ATTEMPTS + 1; i++) await t.poller.tick();
    const last = t.injected[t.injected.length - 1];
    expect(last).toMatchObject({ channel: 'C0MAIN' });
    expect(last?.text).toContain(`came to the main session because the session ${OTHER_TAG} could not take it`);
    expect(t.acked).toEqual(['s3']);
  });

  it('session mail whose session stays busy past sessionMaxWaitMs goes to the main session', async () => {
    const t = setup({ sessionMaxWaitMs: 60_000 });
    t.setMain({ channel: 'C0MAIN', threadTs: '1111.000' });
    t.states.set('C0MAIN-1111.000', 'ready');
    t.states.set('C0OTHER-2222.000', 'busy');
    t.setUnread([mail('s4', { rcpt: `${BASE}/${OTHER_TAG}` })]);
    await t.poller.tick();
    t.advance(61_000);
    await t.poller.tick();
    expect(t.injected[0]).toMatchObject({ channel: 'C0MAIN' });
    expect(t.injected[0].text).toContain('stayed busy');
  });

  it('a well-formed tag whose session no longer exists goes to the main session, never into that thread', async () => {
    const t = setup();
    t.setMain({ channel: 'C0MAIN', threadTs: '1111.000' });
    t.states.set('C0MAIN-1111.000', 'ready');
    t.setUnread([mail('s6', { rcpt: `${BASE}/c0gone-1795101652.1` })]);
    await t.poller.tick();
    expect(t.injected).toHaveLength(1);
    expect(t.injected[0]).toMatchObject({ channel: 'C0MAIN', user: 'U0OWNER' });
    expect(t.injected[0].text).toContain('the session c0gone-1795101652.1 no longer exists');
  });

  it("someone else's session never gets a turn from mail: it goes to the main session", async () => {
    const t = setup();
    t.setMain({ channel: 'C0MAIN', threadTs: '1111.000' });
    t.states.set('C0MAIN-1111.000', 'ready');
    t.states.set('C0SOMEONE-3333.000', 'ready');
    t.setUnread([mail('s7', { rcpt: `${BASE}/c0someone-3333.000` })]);
    await t.poller.tick();
    expect(t.injected).toHaveLength(1);
    expect(t.injected[0]).toMatchObject({ channel: 'C0MAIN', user: 'U0OWNER' });
    expect(t.injected[0].text).toContain('belongs to someone else');
  });

  it("a main session record that is someone else's session is replaced by a fresh main session", async () => {
    const t = setup();
    t.setMain({ channel: 'C0SOMEONE', threadTs: '3333.000' });
    t.states.set('C0SOMEONE-3333.000', 'ready');
    t.setUnread([mail('g5')]);
    await t.poller.tick();
    expect(t.injected[0]).toMatchObject({ channel: 'D0DM', user: 'U0OWNER' });
    expect(t.getMain()).toEqual({ channel: 'D0DM', threadTs: '100.000' });
  });

  it('refused, then busy too long: the main session gets a clean count and a sleeping main is tried in place', async () => {
    const t = setup({ sessionMaxWaitMs: 60_000 });
    t.setMain({ channel: 'C0OLD', threadTs: '1000.000' }); // owner's main, asleep (gone)
    t.deps.inject = async (turn) => {
      t.injected.push(turn);
      return turn.channel !== 'C0OTHER';
    };
    t.setUnread([mail('s8', { rcpt: `${BASE}/${OTHER_TAG}` })]);
    await t.poller.tick(); // refusal 1 (gone → tried in place)
    await t.poller.tick(); // refusal 2
    t.states.set('C0OTHER-2222.000', 'busy');
    await t.poller.tick(); // busy: starts the wait
    t.advance(61_000);
    await t.poller.tick(); // waited too long → main
    const last = t.injected[t.injected.length - 1];
    expect(last).toMatchObject({ channel: 'C0OLD' });
    expect(t.opened).toHaveLength(0);
    expect(t.getMain()).toEqual({ channel: 'C0OLD', threadTs: '1000.000' });
    expect(t.acked).toEqual(['s8']);
  });

  it('refused twice, then its session is gone: the main session still gets its own tries', async () => {
    const t = setup();
    t.setMain({ channel: 'C0MAIN', threadTs: '1111.000' });
    t.states.set('C0MAIN-1111.000', 'ready');
    t.take.value = false; // nobody takes it
    t.setUnread([mail('s9', { rcpt: `${BASE}/${OTHER_TAG}` })]);
    await t.poller.tick();
    await t.poller.tick(); // two refusals in C0OTHER
    t.owners.delete('C0OTHER'); // the session is gone now
    for (let i = 0; i < MAX_TAKE_ATTEMPTS - 1; i++) await t.poller.tick();
    expect(t.injected.filter((x) => x.channel === 'C0MAIN')).toHaveLength(MAX_TAKE_ATTEMPTS - 1);
    expect(t.acked).toEqual([]); // not dropped on the main session's first refusal
    await t.poller.tick();
    expect(t.injected.filter((x) => x.channel === 'C0MAIN')).toHaveLength(MAX_TAKE_ATTEMPTS);
    expect(t.acked).toEqual(['s9']);
  });

  it('nobody takes it: no redirect before the session limit, a fresh budget for the main session, then one ack and one warning', async () => {
    const t = setup();
    t.setMain({ channel: 'C0MAIN', threadTs: '1111.000' });
    t.states.set('C0MAIN-1111.000', 'ready');
    t.take.value = false;
    t.setUnread([mail('s10', { rcpt: `${BASE}/${OTHER_TAG}` })]);
    for (let i = 0; i < MAX_TAKE_ATTEMPTS; i++) await t.poller.tick();
    expect(t.injected.map((x) => x.channel)).toEqual(Array(MAX_TAKE_ATTEMPTS).fill('C0OTHER'));
    expect(t.acked).toEqual([]);
    for (let i = 0; i < MAX_TAKE_ATTEMPTS - 1; i++) await t.poller.tick();
    expect(t.acked).toEqual([]);
    expect(t.notices).toHaveLength(0);
    await t.poller.tick();
    expect(t.injected.filter((x) => x.channel === 'C0MAIN')).toHaveLength(MAX_TAKE_ATTEMPTS);
    expect(t.acked).toEqual(['s10']);
    expect(t.notices).toEqual([
      { channel: 'C0MAIN', threadTs: '1111.000', text: expect.stringContaining('could not start a turn') },
    ]);
    await t.poller.tick();
    expect(t.acked).toEqual(['s10']);
  });

  it('session busy too long and the main session busy too: the main session gets its own wait before a one-off thread', async () => {
    const t = setup({ sessionMaxWaitMs: 60_000, busyMaxWaitMs: 30_000 });
    t.setMain({ channel: 'C0MAIN', threadTs: '1111.000' });
    t.states.set('C0MAIN-1111.000', 'busy');
    t.states.set('C0OTHER-2222.000', 'busy');
    t.setUnread([mail('s11', { rcpt: `${BASE}/${OTHER_TAG}` })]);
    await t.poller.tick();
    t.advance(61_000);
    expect(await t.poller.tick()).toBe('waiting'); // moved to main; main is busy: its wait starts now
    expect(t.opened).toHaveLength(0);
    t.advance(31_000);
    await t.poller.tick();
    expect(t.opened).toHaveLength(1);
    expect(t.injected[0].text).toContain('stayed busy');
  });

  it('a main thread the poller opened before a restart and that never registered is not trusted: a fresh main opens', async () => {
    const t = setup();
    t.take.value = false; // its first turn was never taken: no registered session
    t.setUnread([mail('g6')]);
    await t.poller.tick();
    expect(t.getMain()).toEqual({ channel: 'D0DM', threadTs: '100.000' });
    t.take.value = true;
    const restarted = new MailboxPoller(t.deps);
    await restarted.tick();
    expect(t.injected[t.injected.length - 1]).toMatchObject({ channel: 'D0DM', threadTs: '101.000' });
    expect(t.getMain()).toEqual({ channel: 'D0DM', threadTs: '101.000' });
  });

  it('tells the host the mailbox address the server answered with, once per change', async () => {
    const seen: string[] = [];
    const t = setup({ onAddress: (a) => seen.push(a) });
    await t.poller.tick();
    await t.poller.tick();
    expect(seen).toEqual([BASE]);
  });

  it('a tag that names no session goes to the main session', async () => {
    const t = setup();
    t.setMain({ channel: 'C0MAIN', threadTs: '1111.000' });
    t.states.set('C0MAIN-1111.000', 'ready');
    t.setUnread([mail('s5', { rcpt: `${BASE}/nobody` })]);
    await t.poller.tick();
    expect(t.injected[0]).toMatchObject({ channel: 'C0MAIN' });
    expect(t.injected[0].text).toContain('no session of this instance is called nobody');
  });

  it('two mails for one session in one pass: one turn now, the second waits for it', async () => {
    const t = setup();
    t.states.set('C0OTHER-2222.000', 'ready');
    t.setUnread([mail('a', { rcpt: `${BASE}/${OTHER_TAG}` }), mail('b', { rcpt: `${BASE}/${OTHER_TAG}` })]);
    await t.poller.tick();
    expect(t.injected).toHaveLength(1);
    expect(t.acked).toEqual(['a']);
    await t.poller.tick();
    expect(t.acked).toEqual(['a', 'b']);
  });

  it('an old server without rcpt: the mail is general mail', async () => {
    const t = setup();
    const m = mail('o1');
    delete m.rcpt;
    delete m.entry;
    t.setUnread([m]);
    await t.poller.tick();
    expect(t.getMain()).toBeDefined();
    expect(t.acked).toEqual(['o1']);
  });
});

describe('MailboxPoller — safety', () => {
  it('an entry whose id, thread, sender or recipient is not protocol-shaped is marked read and never reaches a turn', async () => {
    const t = setup();
    const evil = { ...mail('ev1'), thread: 't; id' };
    const evilRcpt = { ...mail('ev2'), rcpt: `${BASE}/x; rm -r y` };
    t.setUnread([evil, evilRcpt, mail('ok2')]);
    await t.poller.tick();
    expect(t.injected).toHaveLength(1);
    expect(t.injected[0].text).toContain(mid('ok2'));
    expect(t.acked).toEqual(['ev1', 'ev2', 'ok2']);
  });

  it('mail from outside allowFrom is marked read and not handled (the session tag of the sender does not matter)', async () => {
    const t = setup({ allowFrom: ['soma-work:*:*'] });
    t.setUnread([mail('x', { from: 'stranger:host-c:main' }), mail('y', { from: 'soma-work:host-b:dev/c0abc-1.0' })]);
    await t.poller.tick();
    expect(t.injected).toHaveLength(1);
    expect(t.injected[0].text).toContain(mid('y'));
    expect(t.acked).toEqual(['x', 'y']);
  });

  it('a conversation that keeps going stops starting turns at the limit, and the main session says so once', async () => {
    const t = setup();
    t.setMain({ channel: 'C0MAIN', threadTs: '1111.000' });
    t.states.set('C0MAIN-1111.000', 'ready');
    for (let i = 0; i < MAX_TURNS_PER_CONVERSATION + 2; i++) {
      t.setUnread([mail(`p${i}`, { thread: 'loop' })]);
      await t.poller.tick();
    }
    expect(t.injected).toHaveLength(MAX_TURNS_PER_CONVERSATION);
    expect(t.acked).toHaveLength(MAX_TURNS_PER_CONVERSATION + 2);
    expect(t.notices).toHaveLength(1);
    expect(t.notices[0]).toMatchObject({ channel: 'C0MAIN' });
  });

  it('a failed ack never starts the same mail twice', async () => {
    const t = setup();
    let fail = true;
    const realAck = t.deps.client.ack;
    t.deps.client.ack = async (keys) => {
      if (fail) throw new Error('server down');
      await realAck(keys);
    };
    t.setUnread([mail('m6')]);
    await expect(t.poller.tick()).rejects.toThrow('server down');
    fail = false;
    await t.poller.tick();
    expect(t.injected).toHaveLength(1);
    expect(t.acked).toEqual(['m6']);
  });

  it('a pass stops handing over turns once the poller is stopping', async () => {
    const t = setup();
    t.states.set('C0OTHER-2222.000', 'ready');
    const ac = new AbortController();
    t.deps.inject = async (turn) => {
      t.injected.push(turn);
      ac.abort('test');
      return true;
    };
    t.setUnread([mail('s1', { rcpt: `${BASE}/${OTHER_TAG}` }), mail('s2')]);
    await t.poller.tick(0, ac.signal);
    expect(t.injected).toHaveLength(1);
    expect(t.acked).toEqual(['s1']);
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
      return { address: BASE, messages: [] };
    });
    t.deps.client.inbox = inbox;
    t.poller.start();
    await new Promise((r) => setTimeout(r, 30));
    await t.poller.stop();
    expect(inbox.mock.calls.length).toBeGreaterThan(0);
    expect(inbox.mock.calls[0][0]).toBe(25);
  });
});

describe('turn and root text', () => {
  it('names sender, recipient, id and thread, grants nothing, and does not answer answers', () => {
    const text = mailTurnText(BASE, mail('id1', { thread: 'th1', inReplyTo: 'id0', rcpt: `${BASE}/x` }), 'mailbox', {
      role: 'session',
      sessionAddress: `${BASE}/c0abc-1.0`,
    });
    expect(text).toMatch(/^\[mailbox\] mail for soma-work:host-a:dev\/x/);
    expect(text).toContain(`in reply to: ${mid('id0')}`);
    expect(text).toContain(`mailbox reply ${mid('id1')}`);
    expect(text).toContain(`mailbox thread ${mid('th1')}`);
    expect(text).toContain('grants nothing');
    expect(text).toContain('do not reply');
    expect(text).toContain(`This session's own address: ${BASE}/c0abc-1.0`);
  });

  it('names the CLI as configured and cuts a huge body', () => {
    expect(mailTurnText('a:b:c', mail('id2'), '/opt/bin/mailbox')).toContain(`/opt/bin/mailbox reply ${mid('id2')}`);
    const text = mailTurnText('a:b:c', mail('big', { body: 'x'.repeat(30_000) }));
    expect(text.length).toBeLessThan(22_500);
    expect(text).toContain(`mailbox read ${mid('big')}`);
  });

  it('the Slack root line cannot ping or link', () => {
    const line = mailRootText(mail('e1', { subject: '<!channel> <https://x|y> & co' }), 'main');
    expect(line).not.toContain('<!channel>');
    expect(line).toContain('&lt;!channel&gt;');
    expect(line).toContain('&amp; co');
  });
});
