import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../admin-utils', () => ({ isAdminUser: (id: string) => id === 'U_ADMIN' }));

/** The main-session routes behind the 비밀-tab gate: admin signed in with Slack, admin mode for a change. */
describe('mailbox main-session routes', () => {
  let dir: string;
  let routes: typeof import('../mailbox-routes');
  let identity: typeof import('../../mailbox/session-address');

  beforeEach(async () => {
    vi.resetModules();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbox-routes-'));
    routes = await import('../mailbox-routes');
    identity = await import('../../mailbox/session-address');
    routes.setMailboxRoutesDataDirForTests(dir);
    identity.setMailboxIdentity({ address: 'soma-work:host-a:dev', owner: 'U_ADMIN' });
    // A live session is a channel AND a thread: one shared channel holds the owner's, someone else's, and no session.
    const live = new Map([
      ['C0AQ1DWLQSD-1795101652.380729', 'U_ADMIN'],
      ['C0SHARED-1795101652.1', 'U_ADMIN'],
      ['C0SHARED-1795101652.2', 'U_SOMEONE'],
    ]);
    routes.setMailboxRoutesSessionOwner((channel, threadTs) => live.get(`${channel}-${threadTs}`));
  });

  afterEach(() => {
    routes.setMailboxRoutesDataDirForTests(null);
    routes.setMailboxRoutesSessionOwner(null);
    identity.setMailboxIdentity(null);
  });

  async function app() {
    const server = Fastify();
    const auth = async (request: any) => {
      const user = request.headers['x-test-user'];
      request.authContext = user ? { mode: 'oauth_jwt', userId: user } : { mode: 'bearer_header' };
    };
    const csrf = async (request: FastifyRequest, reply: FastifyReply) => {
      if (request.headers['x-csrf-token'] !== 'good') reply.status(403).send({ error: 'csrf' });
    };
    routes.registerMailboxRoutes(server, auth, csrf);
    await server.ready();
    return server;
  }

  it('an admin reads it, sets it in admin mode, and clears it', async () => {
    const server = await app();
    const empty = await server.inject({
      method: 'GET',
      url: '/api/mailbox/main-session',
      headers: { 'x-test-user': 'U_ADMIN' },
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ address: 'soma-work:host-a:dev', main: null });

    const set = await server.inject({
      method: 'PUT',
      url: '/api/mailbox/main-session',
      headers: { 'x-test-user': 'U_ADMIN', 'x-admin-mode': 'on', 'x-csrf-token': 'good' },
      payload: { key: 'C0AQ1DWLQSD-1795101652.380729' },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json().main).toMatchObject({
      key: 'C0AQ1DWLQSD-1795101652.380729',
      mailAddress: 'soma-work:host-a:dev/c0aq1dwlqsd-1795101652.380729',
      setBy: 'U_ADMIN',
    });
    const again = await server.inject({
      method: 'GET',
      url: '/api/mailbox/main-session',
      headers: { 'x-test-user': 'U_ADMIN' },
    });
    expect(again.json().main.channel).toBe('C0AQ1DWLQSD');

    const cleared = await server.inject({
      method: 'DELETE',
      url: '/api/mailbox/main-session',
      headers: { 'x-test-user': 'U_ADMIN', 'x-admin-mode': 'on', 'x-csrf-token': 'good' },
    });
    expect(cleared.json().main).toBeNull();
  });

  it('refuses a non-admin, the viewer token, a change without admin mode, and a key that is not a Slack thread', async () => {
    const server = await app();
    expect(
      (
        await server.inject({
          method: 'GET',
          url: '/api/mailbox/main-session',
          headers: { 'x-test-user': 'U_SOMEONE' },
        })
      ).statusCode,
    ).toBe(403);
    expect((await server.inject({ method: 'GET', url: '/api/mailbox/main-session' })).statusCode).toBe(403);
    const noMode = await server.inject({
      method: 'PUT',
      url: '/api/mailbox/main-session',
      headers: { 'x-test-user': 'U_ADMIN', 'x-csrf-token': 'good' },
      payload: { key: 'C0AQ1DWLQSD-1795101652.380729' },
    });
    expect(noMode.statusCode).toBe(403);
    const bad = await server.inject({
      method: 'PUT',
      url: '/api/mailbox/main-session',
      headers: { 'x-test-user': 'U_ADMIN', 'x-admin-mode': 'on', 'x-csrf-token': 'good' },
      payload: { key: 'dashboard-task-1' },
    });
    expect(bad.statusCode).toBe(400);
    const missing = await server.inject({
      method: 'PUT',
      url: '/api/mailbox/main-session',
      headers: { 'x-test-user': 'U_ADMIN', 'x-admin-mode': 'on', 'x-csrf-token': 'good' },
      payload: { key: 'C0SHARED-1795101652.3' },
    });
    expect(missing.statusCode).toBe(404);
    const someoneElse = await server.inject({
      method: 'PUT',
      url: '/api/mailbox/main-session',
      headers: { 'x-test-user': 'U_ADMIN', 'x-admin-mode': 'on', 'x-csrf-token': 'good' },
      payload: { key: 'C0SHARED-1795101652.2' },
    });
    expect(someoneElse.statusCode).toBe(403);
    const ownInShared = await server.inject({
      method: 'PUT',
      url: '/api/mailbox/main-session',
      headers: { 'x-test-user': 'U_ADMIN', 'x-admin-mode': 'on', 'x-csrf-token': 'good' },
      payload: { key: 'C0SHARED-1795101652.1' },
    });
    expect(ownInShared.statusCode).toBe(200);
  });

  it('a change without a valid CSRF token is refused and leaves the main session as it was', async () => {
    const server = await app();
    const admin = { 'x-test-user': 'U_ADMIN', 'x-admin-mode': 'on' };
    const set = (token?: string) =>
      server.inject({
        method: 'PUT',
        url: '/api/mailbox/main-session',
        headers: token ? { ...admin, 'x-csrf-token': token } : admin,
        payload: { key: 'C0AQ1DWLQSD-1795101652.380729' },
      });
    expect((await set()).statusCode).toBe(403);
    expect((await set('bad')).statusCode).toBe(403);
    const read = async () =>
      (
        await server.inject({ method: 'GET', url: '/api/mailbox/main-session', headers: { 'x-test-user': 'U_ADMIN' } })
      ).json().main;
    expect(await read()).toBeNull();
    expect((await set('good')).statusCode).toBe(200);
    const del = await server.inject({ method: 'DELETE', url: '/api/mailbox/main-session', headers: admin });
    expect(del.statusCode).toBe(403);
    expect((await read())?.channel).toBe('C0AQ1DWLQSD');
  });
});
