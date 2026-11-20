import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMainSessionStore, targetFromSessionKey } from '../main-session';
import {
  mailboxEnvFor,
  sessionFromTag,
  sessionMailAddress,
  sessionMailTag,
  setMailboxIdentity,
  tagOf,
} from '../session-address';

afterEach(() => setMailboxIdentity(null));

describe('session tags', () => {
  it('a Slack session maps to a lower-case tag and back without a table', () => {
    expect(sessionMailTag('C0AQ1DWLQSD', '1795101652.380729')).toBe('c0aq1dwlqsd-1795101652.380729');
    expect(sessionFromTag('c0aq1dwlqsd-1795101652.380729')).toEqual({
      channel: 'C0AQ1DWLQSD',
      threadTs: '1795101652.380729',
    });
    expect(sessionFromTag('d0dm-100.000')).toEqual({ channel: 'D0DM', threadTs: '100.000' });
  });

  it('no thread, or a malformed tag, is no session', () => {
    expect(sessionMailTag('C0AQ1DWLQSD', undefined)).toBeUndefined();
    expect(sessionMailTag('', '1.0')).toBeUndefined();
    expect(sessionFromTag('main')).toBeUndefined();
    expect(sessionFromTag('x0abc-1.0')).toBeUndefined();
    expect(sessionFromTag('c0abc-notats')).toBeUndefined();
    expect(tagOf('a:b:c/main')).toBe('main');
    expect(tagOf('a:b:c')).toBeUndefined();
  });

  it('agent shells get the session address only when the instance reads mail and the turn has a thread', () => {
    expect(mailboxEnvFor({ channel: 'C0AQ1DWLQSD', threadTs: '1.000001' })).toEqual({});
    setMailboxIdentity({ address: 'soma-work:host-a:dev' });
    expect(mailboxEnvFor({ channel: 'C0AQ1DWLQSD', threadTs: '1795101652.380729' })).toEqual({
      MAILBOX_ADDRESS: 'soma-work:host-a:dev/c0aq1dwlqsd-1795101652.380729',
    });
    expect(mailboxEnvFor({ channel: '', threadTs: undefined })).toEqual({});
    expect(mailboxEnvFor(undefined)).toEqual({});
    setMailboxIdentity({ address: 'soma-work:host-a:dev', clientFile: '/srv/mbx/client.json' });
    expect(mailboxEnvFor({ channel: 'C0X1', threadTs: '1795101652.1' })).toEqual({
      MAILBOX_ADDRESS: 'soma-work:host-a:dev/c0x1-1795101652.1',
      MAILBOX_CONFIG: '/srv/mbx/client.json',
    });
    expect(sessionMailAddress('C0X1', '1795101652.1')).toBe('soma-work:host-a:dev/c0x1-1795101652.1');
  });
});

describe('main session store', () => {
  it('records, reads back across instances, clears, and refuses a target that is not a Slack thread', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbx-main-'));
    const a = createMainSessionStore(dir);
    expect(a.get()).toBeUndefined();
    a.set({ channel: 'C0MAIN', threadTs: '1111.000' }, 'U0ADMIN');
    const b = createMainSessionStore(dir);
    expect(b.get()).toMatchObject({ channel: 'C0MAIN', threadTs: '1111.000', setBy: 'U0ADMIN' });
    b.clear();
    expect(a.get()).toBeUndefined();
    expect(() => a.set({ channel: 'nope', threadTs: '1' }, 'U0ADMIN')).toThrow();
  });

  it('a dashboard session key is a target', () => {
    expect(targetFromSessionKey('C0AQ1DWLQSD-1795101652.380729')).toEqual({
      channel: 'C0AQ1DWLQSD',
      threadTs: '1795101652.380729',
    });
    expect(targetFromSessionKey('dashboard-task-1')).toBeUndefined();
  });
});
