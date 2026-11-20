import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Fastify from 'fastify';
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
    identity.setMailboxIdentity({ address: 'soma-work:host-a:dev' });
  });

  afterEach(() => {
    routes.setMailboxRoutesDataDirForTests(null);
    identity.setMailboxIdentity(null);
  });

  async function app() {
    const server = Fastify();
    const auth = async (request: any) => {
      const user = request.headers['x-test-user'];
      request.authContext = user ? { mode: 'oauth_jwt', userId: user } : { mode: 'bearer_header' };
    };
    routes.registerMailboxRoutes(server, auth);
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
      headers: { 'x-test-user': 'U_ADMIN', 'x-admin-mode': 'on' },
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
      headers: { 'x-test-user': 'U_ADMIN', 'x-admin-mode': 'on' },
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
      headers: { 'x-test-user': 'U_ADMIN' },
      payload: { key: 'C0AQ1DWLQSD-1795101652.380729' },
    });
    expect(noMode.statusCode).toBe(403);
    const bad = await server.inject({
      method: 'PUT',
      url: '/api/mailbox/main-session',
      headers: { 'x-test-user': 'U_ADMIN', 'x-admin-mode': 'on' },
      payload: { key: 'dashboard-task-1' },
    });
    expect(bad.statusCode).toBe(400);
  });
});
