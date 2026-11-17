/**
 * .prd/31-phone-calls-architecture.md §5 — the dashboard's phone call API: the cards of a conversation, one call,
 * and a call with no conversation (an inbound call). A call's words are a person's: the conversation's owner, the
 * call's requester and admins read them; anyone else gets 403 (or 404 where existence itself is not theirs).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../recorder', () => ({
  getConversation: async (id: string) => (id === 'conv-1' ? { id, ownerId: 'U_OWNER' } : null),
}));

import { type PhoneCallRecord, PhoneCallStore } from '../../phone/call-store';
import { registerPhoneRoutes } from '../phone-routes';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-routes-'));
const store = new PhoneCallStore(dir);
const rec = (over: Partial<PhoneCallRecord>): PhoneCallRecord => ({
  id: 'CA1',
  env: 'e',
  direction: 'outbound',
  ourNumber: '07000000000',
  peerNumber: '01000000000',
  title: 't',
  status: 'ended',
  createdAt: 1,
  requester: 'U_REQ',
  conversationId: 'conv-1',
  transcript: [{ role: 'peer', text: '네', at: 1 }],
  work: [{ kind: 'event', at: 1, text: 'x' }],
  ...over,
});

const server = Fastify();
// The test's auth: x-user / x-admin headers stand in for the dashboard session.
const auth = async (request: FastifyRequest, _reply: FastifyReply) => {
  (request as FastifyRequest & { authContext?: unknown }).authContext = {
    userId: request.headers['x-user'],
    isAdmin: request.headers['x-admin'] === '1',
  };
};

beforeAll(async () => {
  store.create(rec({}));
  store.create(rec({ id: 'CA2', requester: 'U_OTHER', createdAt: 2 }));
  store.create(rec({ id: 'IN1', direction: 'inbound', conversationId: undefined, requester: 'U_LINE_OWNER' }));
  await registerPhoneRoutes(server, auth, () => store);
  await server.ready();
});
afterAll(async () => {
  await server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const get = (url: string, user?: string, admin = false) =>
  server.inject({
    method: 'GET',
    url,
    headers: { ...(user ? { 'x-user': user } : {}), ...(admin ? { 'x-admin': '1' } : {}) },
  });

describe('GET /api/dashboard/session/:conversationId/phone-calls', () => {
  it('the owner sees every call of the conversation as cards (no work log), no-store', async () => {
    const res = await get('/api/dashboard/session/conv-1/phone-calls', 'U_OWNER');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const { calls } = res.json();
    expect(calls.map((c: { id: string }) => c.id)).toEqual(['CA2', 'CA1']);
    expect(calls[0].work).toBeUndefined();
    expect(calls[0].tail).toHaveLength(1);
  });

  it('a requester sees only their own calls; a stranger none', async () => {
    expect(
      (await get('/api/dashboard/session/conv-1/phone-calls', 'U_REQ')).json().calls.map((c: { id: string }) => c.id),
    ).toEqual(['CA1']);
    expect((await get('/api/dashboard/session/conv-1/phone-calls', 'U_STRANGER')).json().calls).toEqual([]);
    expect((await get('/api/dashboard/session/conv-1/phone-calls', 'U_STRANGER', true)).json().calls).toHaveLength(2);
  });

  it('an unknown conversation is 404', async () => {
    expect((await get('/api/dashboard/session/nope/phone-calls', 'U_OWNER')).statusCode).toBe(404);
  });
});

describe('GET one call', () => {
  it('the whole record for the owner, 403 for a stranger, 404 for a call of another conversation', async () => {
    const ok = await get('/api/dashboard/session/conv-1/phone-calls/CA1', 'U_OWNER');
    expect(ok.statusCode).toBe(200);
    expect(ok.json().call.work).toHaveLength(1);
    expect((await get('/api/dashboard/session/conv-1/phone-calls/CA1', 'U_STRANGER')).statusCode).toBe(403);
    expect((await get('/api/dashboard/session/conv-1/phone-calls/IN1', 'U_OWNER')).statusCode).toBe(404);
    expect((await get('/api/dashboard/session/conv-1/phone-calls/..%2Fx', 'U_OWNER')).statusCode).toBe(400);
  });

  it('a call by id: its requester and admins; anyone else is told it does not exist', async () => {
    expect((await get('/api/dashboard/phone-calls/IN1', 'U_LINE_OWNER')).statusCode).toBe(200);
    expect((await get('/api/dashboard/phone-calls/IN1', 'U_X', true)).statusCode).toBe(200);
    expect((await get('/api/dashboard/phone-calls/IN1', 'U_X')).statusCode).toBe(404);
    // A conversation's call: its owner too.
    expect((await get('/api/dashboard/phone-calls/CA2', 'U_OWNER')).statusCode).toBe(200);
    expect((await get('/api/dashboard/phone-calls/NOPE', 'U_OWNER')).statusCode).toBe(404);
  });
});
