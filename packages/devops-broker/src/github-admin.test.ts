import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createGithubAdmin, GithubAdminError } from './github-admin.js';

const TOKEN = 'test-admin-token-0001';

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let server: http.Server | undefined;

afterEach(async () => {
  if (server !== undefined) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
});

async function fakeGithub(
  respond: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
): Promise<{ apiBase: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      respond(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { apiBase: `http://127.0.0.1:${port}`, seen };
}

function json(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

describe('createGithubAdmin', () => {
  it('sets an org membership with a PUT carrying the role and the GitHub headers', async () => {
    const { apiBase, seen } = await fakeGithub((_req, res) => json(res, 200, { state: 'pending', role: 'member' }));
    const result = await createGithubAdmin({ apiBase }).setMembership(TOKEN, 'example-org', 'alice', 'member');
    expect(result).toEqual({ status: 200, body: '{"state":"pending","role":"member"}', truncated: false });
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe('PUT');
    expect(seen[0].url).toBe('/orgs/example-org/memberships/alice');
    expect(JSON.parse(seen[0].body)).toEqual({ role: 'member' });
    expect(seen[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(seen[0].headers.accept).toBe('application/vnd.github+json');
    expect(seen[0].headers['x-github-api-version']).toBe('2022-11-28');
    expect(seen[0].headers['user-agent']).toBeTruthy();
  });

  it('removes a membership and maps the collaborator calls', async () => {
    const { apiBase, seen } = await fakeGithub((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    const admin = createGithubAdmin({ apiBase });
    await expect(admin.removeMembership(TOKEN, 'example-org', 'alice')).resolves.toMatchObject({ status: 204 });
    await admin.addCollaborator(TOKEN, 'example-org', 'app.web', 'alice', 'triage');
    await admin.removeCollaborator(TOKEN, 'example-org', 'app.web', 'alice');
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      'DELETE /orgs/example-org/memberships/alice',
      'PUT /repos/example-org/app.web/collaborators/alice',
      'DELETE /repos/example-org/app.web/collaborators/alice',
    ]);
    expect(JSON.parse(seen[1].body)).toEqual({ permission: 'triage' });
    expect(seen[0].body).toBe('');
  });

  it('returns an error status with its body instead of throwing', async () => {
    const { apiBase } = await fakeGithub((_req, res) => json(res, 422, { message: 'Validation Failed' }));
    const result = await createGithubAdmin({ apiBase }).setMembership(TOKEN, 'example-org', 'alice', 'admin');
    expect(result.status).toBe(422);
    expect(result.body).toContain('Validation Failed');
  });

  it('scrubs the token from the body and caps it at 64 KB', async () => {
    const { apiBase } = await fakeGithub((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`echo ${TOKEN} ${'x'.repeat(200 * 1024)}`);
    });
    const result = await createGithubAdmin({ apiBase }).setMembership(TOKEN, 'example-org', 'alice', 'member');
    expect(result.body).not.toContain(TOKEN);
    expect(result.body).toContain('<redacted>');
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.body)).toBeLessThanOrEqual(64 * 1024 + 16);
  });

  it('does not follow a redirect (a write is never re-sent elsewhere)', async () => {
    const { apiBase, seen } = await fakeGithub((_req, res) => {
      res.writeHead(307, { location: '/repositories/1/collaborators/alice' });
      res.end();
    });
    const result = await createGithubAdmin({ apiBase }).addCollaborator(TOKEN, 'example-org', 'app', 'alice', 'push');
    expect(result.status).toBe(307);
    expect(seen).toHaveLength(1);
  });

  it('turns a connection lost after the request was sent into result-unknown, sent exactly once', async () => {
    const { apiBase, seen } = await fakeGithub((req) => {
      req.socket.destroy();
    });
    const error = await createGithubAdmin({ apiBase })
      .removeCollaborator(TOKEN, 'example-org', 'app', 'alice')
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(GithubAdminError);
    expect((error as GithubAdminError).code).toBe('result-unknown');
    expect((error as Error).message).not.toContain(TOKEN);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(seen).toHaveLength(1);
  });

  it('turns a timeout into result-unknown', async () => {
    const { apiBase, seen } = await fakeGithub(() => {
      // never answers
    });
    const error = await createGithubAdmin({ apiBase, timeoutMs: 100 })
      .setMembership(TOKEN, 'example-org', 'alice', 'member')
      .catch((err: unknown) => err);
    expect((error as GithubAdminError).code).toBe('result-unknown');
    expect(seen).toHaveLength(1);
  });

  it('turns a refused connection (nothing sent) into upstream-error', async () => {
    const { apiBase } = await fakeGithub(() => {});
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
    const error = await createGithubAdmin({ apiBase })
      .setMembership(TOKEN, 'example-org', 'alice', 'member')
      .catch((err: unknown) => err);
    expect((error as GithubAdminError).code).toBe('upstream-error');
  });

  it('reads an org membership: role and state, or not a member on 404', async () => {
    const { apiBase, seen } = await fakeGithub((req, res) => {
      if (req.url === '/orgs/example-org/memberships/alice') json(res, 200, { state: 'active', role: 'admin' });
      else json(res, 404, { message: 'Not Found' });
    });
    const admin = createGithubAdmin({ apiBase });
    await expect(admin.getMembership(TOKEN, 'example-org', 'alice')).resolves.toEqual({
      member: true,
      role: 'admin',
      state: 'active',
    });
    await expect(admin.getMembership(TOKEN, 'example-org', 'bob')).resolves.toEqual({ member: false });
    expect(seen.map((s) => s.method)).toEqual(['GET', 'GET']);
    expect(seen[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(seen[0].body).toBe('');
  });

  it('reads a collaborator permission in the PUT vocabulary, or not a collaborator', async () => {
    const answers: Record<string, [number, unknown]> = {
      '/repos/example-org/app/collaborators/alice/permission': [200, { permission: 'write', role_name: 'write' }],
      '/repos/example-org/app/collaborators/bob/permission': [200, { permission: 'read', role_name: 'triage' }],
      '/repos/example-org/app/collaborators/carol/permission': [200, { permission: 'none', role_name: 'none' }],
    };
    const { apiBase } = await fakeGithub((req, res) => {
      const answer = answers[req.url ?? ''];
      if (answer === undefined) json(res, 404, { message: 'Not Found' });
      else json(res, answer[0], answer[1]);
    });
    const admin = createGithubAdmin({ apiBase });
    await expect(admin.getCollaboratorPermission(TOKEN, 'example-org', 'app', 'alice')).resolves.toEqual({
      collaborator: true,
      permission: 'push',
    });
    await expect(admin.getCollaboratorPermission(TOKEN, 'example-org', 'app', 'bob')).resolves.toEqual({
      collaborator: true,
      permission: 'triage',
    });
    await expect(admin.getCollaboratorPermission(TOKEN, 'example-org', 'app', 'carol')).resolves.toEqual({
      collaborator: false,
    });
    await expect(admin.getCollaboratorPermission(TOKEN, 'example-org', 'app', 'dave')).resolves.toEqual({
      collaborator: false,
    });
  });

  it.each([
    ['an error status', (res: http.ServerResponse) => json(res, 502, { message: 'Bad Gateway' })],
    ['an unreadable body', (res: http.ServerResponse) => json(res, 200, { role: 'admin\n<@U000ADMIN>' })],
    ['a lost connection', (_res: http.ServerResponse, req: http.IncomingMessage) => req.socket.destroy()],
  ])('turns %s on a read into upstream-error', async (_what, respond) => {
    const { apiBase } = await fakeGithub((req, res) => respond(res, req));
    const error = await createGithubAdmin({ apiBase })
      .getMembership(TOKEN, 'example-org', 'alice')
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(GithubAdminError);
    expect((error as GithubAdminError).code).toBe('upstream-error');
  });

  it('merges a pull request once with PUT …/pulls/{n}/merge and the pinned sha', async () => {
    const { apiBase, seen } = await fakeGithub((_req, res) =>
      json(res, 200, { sha: 'd'.repeat(40), merged: true, message: 'Pull Request successfully merged' }),
    );
    const result = await createGithubAdmin({ apiBase }).mergePullRequest(TOKEN, 'example-org', 'app', 7, {
      sha: 'c'.repeat(40),
      method: 'squash',
      title: 'Ship it',
      message: 'notes',
    });
    expect(result.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(`${seen[0].method} ${seen[0].url}`).toBe('PUT /repos/example-org/app/pulls/7/merge');
    expect(JSON.parse(seen[0].body)).toEqual({
      sha: 'c'.repeat(40),
      merge_method: 'squash',
      commit_title: 'Ship it',
      commit_message: 'notes',
    });
  });

  it('leaves out the commit title and message when not given, and returns a 409 as is', async () => {
    const { apiBase, seen } = await fakeGithub((_req, res) => json(res, 409, { message: 'Head branch was modified' }));
    const result = await createGithubAdmin({ apiBase }).mergePullRequest(TOKEN, 'example-org', 'app', 7, {
      sha: 'c'.repeat(40),
      method: 'merge',
    });
    expect(result.status).toBe(409);
    expect(result.body).toContain('Head branch was modified');
    expect(JSON.parse(seen[0].body)).toEqual({ sha: 'c'.repeat(40), merge_method: 'merge' });
  });

  it('turns a merge whose connection was lost into result-unknown, sent exactly once', async () => {
    const { apiBase, seen } = await fakeGithub((req) => req.socket.destroy());
    const error = await createGithubAdmin({ apiBase })
      .mergePullRequest(TOKEN, 'example-org', 'app', 7, { sha: 'c'.repeat(40), method: 'rebase' })
      .catch((err: unknown) => err);
    expect((error as GithubAdminError).code).toBe('result-unknown');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(seen).toHaveLength(1);
  });

  it.each([
    [{ sha: 'c'.repeat(39), method: 'squash' }],
    [{ sha: 'c'.repeat(40), method: 'fast-forward' }],
  ])('refuses merge options %j before sending anything', async (options) => {
    const admin = createGithubAdmin({ apiBase: 'http://127.0.0.1:9' });
    await expect(
      admin.mergePullRequest(TOKEN, 'example-org', 'app', 7, options as { sha: string; method: 'squash' }),
    ).rejects.toThrow(/github-admin/);
    await expect(
      admin.mergePullRequest(TOKEN, 'example-org', 'app', 0, { sha: 'c'.repeat(40), method: 'squash' }),
    ).rejects.toThrow(/github-admin/);
  });

  it('reads a pull request: merged and its merge commit', async () => {
    const { apiBase, seen } = await fakeGithub((_req, res) =>
      json(res, 200, { number: 7, state: 'closed', merged: true, merge_commit_sha: 'e'.repeat(40) }),
    );
    await expect(createGithubAdmin({ apiBase }).getPullRequest(TOKEN, 'example-org', 'app', 7)).resolves.toEqual({
      merged: true,
      mergeCommitSha: 'e'.repeat(40),
      state: 'closed',
    });
    expect(`${seen[0].method} ${seen[0].url}`).toBe('GET /repos/example-org/app/pulls/7');
  });

  it('turns a missing pull request on a read into upstream-error', async () => {
    const { apiBase } = await fakeGithub((_req, res) => json(res, 404, { message: 'Not Found' }));
    const error = await createGithubAdmin({ apiBase })
      .getPullRequest(TOKEN, 'example-org', 'app', 7)
      .catch((err: unknown) => err);
    expect((error as GithubAdminError).code).toBe('upstream-error');
  });

  it.each([
    ['org', () => createGithubAdmin({ apiBase: 'http://127.0.0.1:9' }).removeMembership(TOKEN, 'a/b', 'alice')],
    ['user', () => createGithubAdmin({ apiBase: 'http://127.0.0.1:9' }).removeMembership(TOKEN, 'example-org', '..')],
    [
      'repo',
      () =>
        createGithubAdmin({ apiBase: 'http://127.0.0.1:9' }).removeCollaborator(TOKEN, 'example-org', '..', 'alice'),
    ],
  ])('refuses a malformed %s before sending anything', async (_what, call) => {
    await expect(call()).rejects.toThrow(/github-admin/);
  });
});
