import { afterEach, describe, expect, it } from 'vitest';
import type { ButtonClick } from './approval.js';
import { APPROVE_ACTION_ID, DENY_ACTION_ID } from './slack-card.js';
import { parseBlockActions, type SocketModeClient, startSocketMode, type WebSocketLike } from './slack-socket.js';

// Socket Mode for the approval buttons (.prd/16-devops-tools-architecture.md §5): only well-formed clicks on the
// two approval buttons reach the approvals, every envelope is acknowledged before it is handled, the connection
// comes back after Slack asks to reconnect, and neither the app token nor the connection URL is ever logged.

const APP_TOKEN = ['xapp', '1', 'A000FAKE', 'not', 'real'].join('-');
const WSS = 'wss://wss-primary.slack.example/link/?ticket=secret-ticket-value&app_id=A000FAKE';
const APPROVAL_ID = 'AbCdEfGhIjKlMnOpQrStUv';

function payload(overrides: Record<string, unknown> = {}, action: Record<string, unknown> = {}) {
  return {
    type: 'block_actions',
    user: { id: 'U000ADMIN' },
    container: { type: 'message', channel_id: 'D000ADMIN', message_ts: '1793173373.682229' },
    actions: [{ action_id: APPROVE_ACTION_ID, value: APPROVAL_ID, ...action }],
    ...overrides,
  };
}

describe('parseBlockActions', () => {
  it('reads an approve and a deny click', () => {
    expect(parseBlockActions(payload())).toEqual([
      {
        approvalId: APPROVAL_ID,
        action: 'approve',
        user: 'U000ADMIN',
        channel: 'D000ADMIN',
        messageTs: '1793173373.682229',
      },
    ]);
    expect(parseBlockActions(payload({}, { action_id: DENY_ACTION_ID }))[0].action).toBe('deny');
  });

  it('falls back to channel.id and message.ts when the container lacks them', () => {
    const clicks = parseBlockActions(
      payload({ container: {}, channel: { id: 'D000ADMIN' }, message: { ts: '1793173373.682229' } }),
    );
    expect(clicks).toHaveLength(1);
  });

  it.each([
    ['another payload type', payload({ type: 'view_submission' })],
    ['another action id', payload({}, { action_id: 'something_else' })],
    ['a malformed approval id', payload({}, { value: 'not-an-id' })],
    ['an approval id with a path in it', payload({}, { value: '../../../../../../aaaa' })],
    ['no user', payload({ user: undefined })],
    ['a malformed user id', payload({ user: { id: '<@U000ADMIN>' } })],
    ['no message ts', payload({ container: { channel_id: 'D000ADMIN' } })],
    ['no actions', payload({ actions: undefined })],
    ['not an object', 'block_actions'],
  ])('drops %s', (_what, input) => {
    expect(parseBlockActions(input)).toEqual([]);
  });
});

class FakeSocket implements WebSocketLike {
  sent: string[] = [];
  closed = false;
  private listeners: Record<string, ((event: { data: unknown }) => void)[]> = {};

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
  addEventListener(type: string, listener: (event: { data: unknown }) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }
  emit(type: string, data?: unknown): void {
    for (const listener of this.listeners[type] ?? []) listener({ data });
  }
  receive(message: unknown): void {
    this.emit('message', JSON.stringify(message));
  }
}

async function waitFor<T>(fn: () => T | undefined | false, what: string, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

let client: SocketModeClient | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

function harness(opens: (Response | Error)[] = []) {
  const sockets: FakeSocket[] = [];
  const urls: string[] = [];
  const fetchCalls: { url: string; auth: string | null }[] = [];
  const clicks: ButtonClick[] = [];
  const logs: string[] = [];
  const order: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    fetchCalls.push({ url, auth: new Headers(init?.headers).get('authorization') });
    const next = opens.shift();
    if (next instanceof Error) throw next;
    return next ?? new Response(JSON.stringify({ ok: true, url: WSS }), { status: 200 });
  }) as typeof fetch;
  client = startSocketMode({
    appToken: APP_TOKEN,
    onClick: (click) => {
      order.push('click');
      clicks.push(click);
    },
    log: (line) => logs.push(line),
    fetchImpl,
    webSocket: (url) => {
      urls.push(url);
      const socket = new FakeSocket();
      const send = socket.send.bind(socket);
      socket.send = (data: string) => {
        order.push('ack');
        send(data);
      };
      sockets.push(socket);
      return socket;
    },
    apiBase: 'https://slack.example/api',
    backoff: { minMs: 5, maxMs: 20 },
  });
  return { sockets, urls, fetchCalls, clicks, logs, order };
}

describe('startSocketMode', () => {
  it('opens the connection with the app token in the Authorization header and connects to the returned URL', async () => {
    const h = harness();
    const socket = await waitFor(() => h.sockets[0], 'socket');
    expect(h.fetchCalls[0]).toEqual({
      url: 'https://slack.example/api/apps.connections.open',
      auth: `Bearer ${APP_TOKEN}`,
    });
    expect(h.urls).toEqual([WSS]);
    socket.receive({ type: 'hello' });
    expect(h.logs.join('\n')).toContain('connected');
  });

  it('acknowledges an envelope before handing its click to the approvals', async () => {
    const h = harness();
    const socket = await waitFor(() => h.sockets[0], 'socket');
    socket.receive({ envelope_id: 'env-1', type: 'interactive', payload: payload() });
    await waitFor(() => h.clicks.length > 0, 'click');
    expect(socket.sent).toEqual([JSON.stringify({ envelope_id: 'env-1' })]);
    expect(h.order).toEqual(['ack', 'click']);
    expect(h.clicks[0]).toMatchObject({ approvalId: APPROVAL_ID, action: 'approve', user: 'U000ADMIN' });
  });

  it('acknowledges but ignores other envelopes', async () => {
    const h = harness();
    const socket = await waitFor(() => h.sockets[0], 'socket');
    socket.receive({ envelope_id: 'env-2', type: 'events_api', payload: { event: { type: 'message' } } });
    socket.receive({ envelope_id: 'env-3', type: 'interactive', payload: payload({}, { action_id: 'other' }) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(socket.sent).toHaveLength(2);
    expect(h.clicks).toEqual([]);
  });

  it('reconnects when Slack asks to, and after the socket closes', async () => {
    const h = harness();
    const first = await waitFor(() => h.sockets[0], 'first socket');
    first.receive({ type: 'disconnect', reason: 'refresh_requested' });
    expect(first.closed).toBe(true);
    const second = await waitFor(() => h.sockets[1], 'second socket');
    second.emit('close');
    await waitFor(() => h.sockets[2], 'third socket');
    expect(h.fetchCalls).toHaveLength(3);
  });

  it('retries a failed apps.connections.open with backoff and logs only the error code', async () => {
    const h = harness([
      new Response(JSON.stringify({ ok: false, error: 'invalid_auth' }), { status: 200 }),
      new TypeError('fetch failed'),
      new Response('', { status: 429 }),
    ]);
    await waitFor(() => h.sockets[0], 'socket after three failures');
    const text = h.logs.join('\n');
    expect(text).toContain('invalid_auth');
    expect(text).toContain('network_error');
    expect(text).toContain('ratelimited');
  });

  it('never logs the app token or the connection URL', async () => {
    const h = harness([new Response(JSON.stringify({ ok: false, error: APP_TOKEN }), { status: 200 })]);
    const socket = await waitFor(() => h.sockets[0], 'socket');
    socket.receive({ type: 'hello' });
    socket.receive({ type: 'disconnect', reason: WSS });
    await waitFor(() => h.sockets[1], 'reconnect');
    const text = h.logs.join('\n');
    expect(text).not.toContain(APP_TOKEN);
    expect(text).not.toContain('secret-ticket-value');
    expect(text).not.toContain('wss://');
  });

  it('refuses a connection URL that is not wss', async () => {
    const h = harness([new Response(JSON.stringify({ ok: true, url: 'http://plain.example/' }), { status: 200 })]);
    await waitFor(() => h.sockets[0], 'socket after the bad URL');
    expect(h.urls).toEqual([WSS]);
    expect(h.logs.join('\n')).toContain('invalid_response');
  });

  it('waits for Slack Retry-After on a 429 even when the local backoff is shorter', async () => {
    const started = Date.now();
    const h = harness([new Response('', { status: 429, headers: { 'retry-after': '1' } })]);
    await waitFor(() => h.sockets[0], 'socket after the 429', 4000);
    expect(h.fetchCalls).toHaveLength(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
    expect(h.logs.join('\n')).toContain('ratelimited');
  });

  it('aborts an apps.connections.open still in flight on close and opens no socket', async () => {
    let aborted = false;
    const sockets: FakeSocket[] = [];
    client = startSocketMode({
      appToken: APP_TOKEN,
      onClick: () => undefined,
      log: () => undefined,
      fetchImpl: ((_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        })) as typeof fetch,
      webSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      backoff: { minMs: 5, maxMs: 20 },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await client.close();
    expect(aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sockets).toEqual([]);
  });

  it('dispatches nothing after close, even a click that was already received', async () => {
    const h = harness();
    const socket = await waitFor(() => h.sockets[0], 'socket');
    socket.receive({ envelope_id: 'env-q', type: 'interactive', payload: payload() });
    await client?.close();
    socket.receive({ envelope_id: 'env-late', type: 'interactive', payload: payload() });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.clicks).toEqual([]);
  });

  it('waits for a click already being handled before close resolves', async () => {
    let finished = false;
    const sockets: FakeSocket[] = [];
    client = startSocketMode({
      appToken: APP_TOKEN,
      onClick: () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            finished = true;
            resolve();
          }, 50),
        ),
      log: () => undefined,
      fetchImpl: (async () => new Response(JSON.stringify({ ok: true, url: WSS }), { status: 200 })) as typeof fetch,
      webSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      backoff: { minMs: 5, maxMs: 20 },
    });
    const socket = await waitFor(() => sockets[0], 'socket');
    socket.receive({ envelope_id: 'env-w', type: 'interactive', payload: payload() });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await client.close();
    expect(finished).toBe(true);
  });

  it('stops reconnecting after close', async () => {
    const h = harness();
    const socket = await waitFor(() => h.sockets[0], 'socket');
    await client?.close();
    expect(socket.closed).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.sockets).toHaveLength(1);
  });
});
