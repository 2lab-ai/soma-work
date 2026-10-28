// Stand-in for the Slack Web API in slack-api.test.ts and approval.test.ts: a local HTTP server that
// speaks the four methods the broker uses (conversations.open, chat.postMessage, chat.update,
// reactions.get), keeps the posted messages and their reactions, and records every request. Like Slack,
// reactions.get returns only part of a reaction's `users` unless `full=true` is sent.

const http = require('node:http');

/**
 * @typedef {{ method: string, params: Record<string, unknown>, auth: string | undefined, contentType: string | undefined, at: number, overridden: boolean }} FakeRequest
 * @typedef {{ channel: string, ts: string, text: string, blocks: unknown[] | undefined, threadTs: string | undefined, reactions: Map<string, string[]>, updates: { text: string, blocks: unknown[] | undefined }[] }} FakeMessage
 * @typedef {{ apiBase: string, requests: FakeRequest[], calls(method: string): FakeRequest[],
 *   enqueue(method: string, response: { status?: number, headers?: Record<string, string>, body?: unknown }, when?: (params: Record<string, unknown>) => boolean): void,
 *   cards(channel: string): FakeMessage[], replies(channel: string, threadTs: string): FakeMessage[], allMessages(): FakeMessage[],
 *   react(channel: string, ts: string, name: string, user: string): void, close(): Promise<void> }} FakeSlack
 */

/**
 * @param {{ token: string }} opts
 * @returns {Promise<FakeSlack>}
 */
function startFakeSlack(opts) {
  const token = opts.token;
  /** @type {FakeRequest[]} */
  const requests = [];
  /** @type {{ method: string, when: (params: Record<string, unknown>) => boolean, status: number, headers: Record<string, string>, body: string }[]} */
  const overrides = [];
  /** @type {Map<string, FakeMessage>} */
  const messages = new Map();
  let seq = 0;

  const key = (channel, ts) => `${channel}:${ts}`;

  function parseBody(contentType, raw) {
    if ((contentType || '').startsWith('application/json')) return raw.length > 0 ? JSON.parse(raw) : {};
    return Object.fromEntries(new URLSearchParams(raw));
  }

  function reply(res, status, headers, body) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  }

  function handle(method, params) {
    switch (method) {
      case 'conversations.open': {
        const user = String(params.users || '');
        if (!/^[UW][A-Z0-9]+$/.test(user)) return { ok: false, error: 'user_not_found' };
        return { ok: true, channel: { id: `D${user.slice(1)}` } };
      }
      case 'chat.postMessage': {
        const channel = String(params.channel || '');
        if (channel.length === 0) return { ok: false, error: 'channel_not_found' };
        seq += 1;
        const ts = `1700000000.${String(seq).padStart(6, '0')}`;
        messages.set(key(channel, ts), {
          channel,
          ts,
          text: String(params.text || ''),
          blocks: params.blocks,
          threadTs: params.thread_ts,
          reactions: new Map(),
          updates: [],
        });
        return { ok: true, channel, ts };
      }
      case 'chat.update': {
        const message = messages.get(key(String(params.channel), String(params.ts)));
        if (message === undefined) return { ok: false, error: 'message_not_found' };
        message.updates.push({ text: String(params.text || ''), blocks: params.blocks });
        return { ok: true, channel: message.channel, ts: message.ts };
      }
      case 'reactions.get': {
        const message = messages.get(key(String(params.channel), String(params.timestamp)));
        if (message === undefined) return { ok: false, error: 'message_not_found' };
        const full = params.full === 'true' || params.full === true;
        const reactions = [...message.reactions.entries()].map(([name, users]) => ({
          name,
          users: full ? users : users.slice(0, 1),
          count: users.length,
        }));
        return {
          ok: true,
          type: 'message',
          channel: message.channel,
          message: { type: 'message', ts: message.ts, text: message.text, ...(reactions.length > 0 ? { reactions } : {}) },
        };
      }
      default:
        return { ok: false, error: 'unknown_method' };
    }
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const method = (req.url || '').replace(/^\/+/, '').split('?')[0];
      const raw = Buffer.concat(chunks).toString('utf8');
      let params;
      try {
        params = parseBody(req.headers['content-type'], raw);
      } catch {
        reply(res, 200, {}, { ok: false, error: 'invalid_json' });
        return;
      }
      const record = {
        method,
        params,
        auth: req.headers.authorization,
        contentType: req.headers['content-type'],
        at: performance.now(),
        overridden: false,
      };
      requests.push(record);
      const at = overrides.findIndex((o) => o.method === method && o.when(params));
      if (at >= 0) {
        const [override] = overrides.splice(at, 1);
        record.overridden = true;
        reply(res, override.status, override.headers, override.body);
        return;
      }
      if (req.headers.authorization !== `Bearer ${token}`) {
        reply(res, 200, {}, { ok: false, error: 'invalid_auth' });
        return;
      }
      reply(res, 200, {}, handle(method, params));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
      /** @type {FakeSlack} */
      const fake = {
        apiBase: `http://127.0.0.1:${port}`,
        requests,
        calls: (method) => requests.filter((r) => r.method === method),
        /** Answers the next matching request with this response instead of the normal one. */
        enqueue(method, response, when = () => true) {
          overrides.push({
            method,
            when,
            status: response.status ?? 200,
            headers: response.headers ?? {},
            body: typeof response.body === 'string' ? response.body : JSON.stringify(response.body ?? { ok: true }),
          });
        },
        /** Top-level messages (not thread replies) in a channel, oldest first. */
        cards: (channel) =>
          [...messages.values()].filter((m) => m.channel === channel && m.threadTs === undefined),
        replies: (channel, threadTs) =>
          [...messages.values()].filter((m) => m.channel === channel && m.threadTs === threadTs),
        allMessages: () => [...messages.values()],
        react(channel, ts, name, user) {
          const message = messages.get(key(channel, ts));
          if (message === undefined) throw new Error(`no message ${channel} ${ts}`);
          const users = message.reactions.get(name) || [];
          if (!users.includes(user)) users.push(user);
          message.reactions.set(name, users);
        },
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      };
      resolve(fake);
    });
  });
}

module.exports = { startFakeSlack };
