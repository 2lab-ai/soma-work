// The broker app's Slack Web API client (.prd/16-devops-tools-architecture.md §5): the four methods an
// approval card needs, over global fetch. The token travels only in the Authorization header; errors carry
// a Slack error code or an HTTP status, never the token, a URL with parameters, or a response body.

export interface SlackApi {
  /** conversations.open → the DM channel id. */
  openDm(userId: string): Promise<string>;
  postMessage(channel: string, msg: { text: string; blocks?: unknown[]; threadTs?: string }): Promise<{ ts: string }>;
  updateMessage(channel: string, ts: string, msg: { text: string; blocks?: unknown[] }): Promise<void>;
  /** reactions.get with `full=true`; reaction names as Slack sends them. */
  getReactions(channel: string, ts: string): Promise<{ name: string; users: string[] }[]>;
}

export class SlackApiError extends Error {
  /** Slack's `error` (e.g. `channel_not_found`), `ratelimited`, `http_<status>`, `network_error`, `timeout`, `invalid_response`, `unknown_error`. */
  readonly code: string;
  /** Present for `ratelimited` when Slack sent a usable Retry-After. */
  readonly retryAfterSeconds?: number;

  constructor(method: string, code: string, retryAfterSeconds?: number) {
    super(`slack ${method}: ${code}`);
    this.name = 'SlackApiError';
    this.code = code;
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }
}

export const DEFAULT_SLACK_API_BASE = 'https://slack.com/api';
const REQUEST_TIMEOUT_MS = 15_000;
/** Slack error codes are short snake_case words; anything else is not echoed. */
const ERROR_CODE_RE = /^[a-z0-9_]{1,64}$/;
const RETRY_AFTER_RE = /^\d{1,6}$/;

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function retryAfter(header: string | null): number | undefined {
  if (header === null || !RETRY_AFTER_RE.test(header.trim())) return undefined;
  return Number(header.trim());
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function createSlackApi(opts: { token: string; fetchImpl?: typeof fetch; apiBase?: string }): SlackApi {
  const token = opts.token;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = (opts.apiBase ?? DEFAULT_SLACK_API_BASE).replace(/\/+$/, '');

  /** JSON bodies for chat.*, form bodies for the rest (some read methods do not take JSON). */
  async function call(method: string, body: Json, encoding: 'json' | 'form'): Promise<Json> {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    let payload: string;
    if (encoding === 'json') {
      headers['content-type'] = 'application/json; charset=utf-8';
      payload = JSON.stringify(body);
    } else {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      const form = new URLSearchParams();
      for (const [key, value] of Object.entries(body)) form.set(key, String(value));
      payload = form.toString();
    }
    let response: Response;
    try {
      response = await fetchImpl(`${base}/${method}`, {
        method: 'POST',
        headers,
        body: payload,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const name = (err as Error | undefined)?.name;
      throw new SlackApiError(method, name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network_error');
    }
    const wait = retryAfter(response.headers.get('retry-after'));
    if (response.status === 429) {
      await response.body?.cancel().catch(() => undefined);
      throw new SlackApiError(method, 'ratelimited', wait);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new SlackApiError(method, `http_${response.status}`);
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new SlackApiError(method, 'invalid_response');
    }
    if (!isRecord(json)) throw new SlackApiError(method, 'invalid_response');
    if (json.ok !== true) {
      const code = typeof json.error === 'string' && ERROR_CODE_RE.test(json.error) ? json.error : 'unknown_error';
      throw new SlackApiError(method, code, code === 'ratelimited' ? wait : undefined);
    }
    return json;
  }

  return {
    async openDm(userId) {
      const json = await call('conversations.open', { users: userId }, 'form');
      const channel = isRecord(json.channel) ? json.channel.id : undefined;
      if (!nonEmptyString(channel)) throw new SlackApiError('conversations.open', 'invalid_response');
      return channel;
    },

    async postMessage(channel, msg) {
      const body: Json = { channel, text: msg.text };
      if (msg.blocks !== undefined) body.blocks = msg.blocks;
      if (msg.threadTs !== undefined) body.thread_ts = msg.threadTs;
      const json = await call('chat.postMessage', body, 'json');
      if (!nonEmptyString(json.ts)) throw new SlackApiError('chat.postMessage', 'invalid_response');
      return { ts: json.ts };
    },

    async updateMessage(channel, ts, msg) {
      const body: Json = { channel, ts, text: msg.text };
      if (msg.blocks !== undefined) body.blocks = msg.blocks;
      await call('chat.update', body, 'json');
    },

    async getReactions(channel, ts) {
      const json = await call('reactions.get', { channel, timestamp: ts, full: 'true' }, 'form');
      const message = json.message;
      if (!isRecord(message)) throw new SlackApiError('reactions.get', 'invalid_response');
      if (message.reactions === undefined) return [];
      if (!Array.isArray(message.reactions)) throw new SlackApiError('reactions.get', 'invalid_response');
      return message.reactions.map((reaction) => {
        if (
          !isRecord(reaction) ||
          typeof reaction.name !== 'string' ||
          !Array.isArray(reaction.users) ||
          !reaction.users.every((user) => typeof user === 'string')
        ) {
          throw new SlackApiError('reactions.get', 'invalid_response');
        }
        return { name: reaction.name, users: [...(reaction.users as string[])] };
      });
    },
  };
}
