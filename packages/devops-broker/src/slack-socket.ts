// The broker app's Socket Mode connection (.prd/16-devops-tools-architecture.md §5): it receives the 승인 / 거부
// button clicks on approval cards. The app-level token travels only in the Authorization header of
// apps.connections.open; the WebSocket URL that call returns carries a one-time ticket and is never logged.
// Every envelope is acknowledged before it is processed (Slack redelivers an unacknowledged one).
// Reactions are still polled, so this connection being down never blocks an approval — it only means a
// button click is not seen until the connection is back, and the reaction path still decides.

import type { ButtonClick } from './approval.js';
import { DEFAULT_SLACK_API_BASE } from './slack-api.js';
import { APPROVE_ACTION_ID, DENY_ACTION_ID } from './slack-card.js';

export interface SocketModeClient {
  /** Stops reconnecting and closes the connection. */
  close(): Promise<void>;
}

/** The part of the WHATWG WebSocket the client uses (Node 22+ has it as a global). */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'close' | 'error', listener: () => void): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

/** apps.connections.open is rate-limited per app: never retry faster than this. */
export const DEFAULT_BACKOFF = Object.freeze({ minMs: 5_000, maxMs: 120_000 });
const OPEN_TIMEOUT_MS = 15_000;
/** An approval id is 16 random bytes in base64url (22 characters). */
const APPROVAL_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const SLACK_ID_RE = /^[A-Z0-9]{2,32}$/;
const MESSAGE_TS_RE = /^\d{1,12}\.\d{1,9}$/;
const ERROR_CODE_RE = /^[a-z0-9_]{1,64}$/;

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOf(value: unknown, re: RegExp): string | undefined {
  return typeof value === 'string' && re.test(value) ? value : undefined;
}

/**
 * The approval button clicks in one interactive payload. Anything that is not a well-formed click on one of
 * the two approval buttons (other payload types, other action ids, malformed ids) is dropped here.
 */
export function parseBlockActions(payload: unknown): ButtonClick[] {
  if (!isRecord(payload) || payload.type !== 'block_actions') return [];
  const user = stringOf(isRecord(payload.user) ? payload.user.id : undefined, SLACK_ID_RE);
  const container = isRecord(payload.container) ? payload.container : {};
  const channel = stringOf(
    container.channel_id ?? (isRecord(payload.channel) ? payload.channel.id : undefined),
    SLACK_ID_RE,
  );
  const messageTs = stringOf(
    container.message_ts ?? (isRecord(payload.message) ? payload.message.ts : undefined),
    MESSAGE_TS_RE,
  );
  if (user === undefined || channel === undefined || messageTs === undefined || !Array.isArray(payload.actions)) {
    return [];
  }
  const clicks: ButtonClick[] = [];
  for (const action of payload.actions) {
    if (!isRecord(action)) continue;
    const kind =
      action.action_id === APPROVE_ACTION_ID ? 'approve' : action.action_id === DENY_ACTION_ID ? 'deny' : undefined;
    const approvalId = stringOf(action.value, APPROVAL_ID_RE);
    if (kind === undefined || approvalId === undefined) continue;
    clicks.push({ approvalId, action: kind, user, channel, messageTs });
  }
  return clicks;
}

class SocketModeError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`apps.connections.open: ${code}`);
    this.name = 'SocketModeError';
    this.code = code;
  }
}

export function startSocketMode(opts: {
  appToken: string;
  onClick(click: ButtonClick): unknown;
  /** Operator log line; never given the token or the connection URL. */
  log(line: string): void;
  fetchImpl?: typeof fetch;
  webSocket?: WebSocketFactory;
  apiBase?: string;
  backoff?: { minMs: number; maxMs: number };
}): SocketModeClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const openSocket: WebSocketFactory = opts.webSocket ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
  const base = (opts.apiBase ?? DEFAULT_SLACK_API_BASE).replace(/\/+$/, '');
  const backoff = opts.backoff ?? DEFAULT_BACKOFF;
  let closed = false;
  let current: WebSocketLike | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;

  async function connectionUrl(): Promise<string> {
    let response: Response;
    try {
      response = await fetchImpl(`${base}/apps.connections.open`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${opts.appToken}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: '',
        signal: AbortSignal.timeout(OPEN_TIMEOUT_MS),
      });
    } catch (err) {
      const name = (err as Error | undefined)?.name;
      throw new SocketModeError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network_error');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new SocketModeError(response.status === 429 ? 'ratelimited' : `http_${response.status}`);
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new SocketModeError('invalid_response');
    }
    if (!isRecord(json)) throw new SocketModeError('invalid_response');
    if (json.ok !== true) {
      throw new SocketModeError(
        typeof json.error === 'string' && ERROR_CODE_RE.test(json.error) ? json.error : 'unknown_error',
      );
    }
    if (typeof json.url !== 'string' || !json.url.startsWith('wss://')) throw new SocketModeError('invalid_response');
    return json.url;
  }

  function retryLater(): void {
    if (closed) return;
    const delay = Math.min(backoff.maxMs, backoff.minMs * 2 ** Math.min(failures, 16));
    failures += 1;
    timer = setTimeout(() => {
      timer = undefined;
      void connect();
    }, delay);
  }

  async function connect(): Promise<void> {
    if (closed) return;
    let url: string;
    try {
      url = await connectionUrl();
    } catch (err) {
      opts.log(
        `socket mode: cannot open a connection (${err instanceof SocketModeError ? err.code : 'error'}); retrying`,
      );
      retryLater();
      return;
    }
    if (closed) return;
    let socket: WebSocketLike;
    try {
      socket = openSocket(url);
    } catch {
      opts.log('socket mode: cannot start the WebSocket; retrying');
      retryLater();
      return;
    }
    current = socket;
    let ended = false;
    const end = (why: string) => {
      if (ended) return;
      ended = true;
      if (current === socket) current = undefined;
      try {
        socket.close();
      } catch {
        // Already closed.
      }
      if (closed) return;
      opts.log(`socket mode: connection ended (${why}); reconnecting`);
      retryLater();
    };
    socket.addEventListener('message', (event) => {
      let message: unknown;
      try {
        message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      } catch {
        return;
      }
      if (!isRecord(message)) return;
      // Acknowledge first: an unacknowledged envelope is redelivered, and a click must not be decided twice.
      if (typeof message.envelope_id === 'string') {
        try {
          socket.send(JSON.stringify({ envelope_id: message.envelope_id }));
        } catch {
          // The close handler reconnects.
        }
      }
      if (message.type === 'hello') {
        failures = 0;
        opts.log('socket mode: connected (approval buttons on)');
        return;
      }
      if (message.type === 'disconnect') {
        const reason =
          typeof message.reason === 'string' && ERROR_CODE_RE.test(message.reason) ? message.reason : 'unknown';
        end(`slack asked to reconnect: ${reason}`);
        return;
      }
      if (message.type !== 'interactive') return;
      for (const click of parseBlockActions(message.payload)) {
        Promise.resolve()
          .then(() => opts.onClick(click))
          .catch(() => undefined);
      }
    });
    socket.addEventListener('close', () => end('closed'));
    socket.addEventListener('error', () => end('error'));
  }

  void connect();
  return {
    async close() {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      const socket = current;
      current = undefined;
      try {
        socket?.close();
      } catch {
        // Already closed.
      }
    },
  };
}
