#!/usr/bin/env node

// devops-tools MCP server — relays the eight devops tools to the broker socket and waits for the
// approval outcome (.prd/16-devops-tools-architecture.md §2, §3, §5.6). It holds no keys and makes no
// policy or approval decision: it checks argument shape, sends one request line, enforces the
// exchange order, and hands the broker's terminal message to the model. stdout is the JSON-RPC
// channel — every log goes to stderr.

import { randomUUID } from 'node:crypto';
import * as net from 'node:net';
import * as path from 'node:path';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { CallToolRequestSchema, type ServerNotification, type ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import {
  advanceExchange,
  BROKER_SOCKET_ENV,
  type BrokerMessage,
  DEFAULT_BROKER_SOCKET_PATH,
  DEVOPS_TOOLS,
  type DevopsRequest,
  type DevopsTool,
  type ErrorMessage,
  type ExchangeState,
  encodeMessage,
  type JsonValue,
  type PendingMessage,
  PROTOCOL_VERSION,
  parseBrokerMessage,
  parseJsonLine,
  parseRequest,
  splitLines,
  type UnverifiedRequesterClaim,
  validateToolArgs,
} from '@soma/process-shared/devops/protocol.js';
import type { ToolDefinition, ToolResult } from '@soma/process-shared/mcp/base-mcp-server.js';
import { BaseMcpServer } from '@soma/process-shared/mcp/base-mcp-server.js';

// ── Constants ─────────────────────────────────────────────

/**
 * Total wait ceiling for one call, before and after `pending`: just under the 360 s per-call timeout
 * the bot gives this server, so the call ends here with a clear message rather than being killed.
 */
export const MAX_WAIT_MS = 355_000;

/**
 * After `pending`, how long past the card's expiresAt the broker has to send its terminal message
 * (it answers `not-approved` or `still-executing` 25 s after expiry). Capped by MAX_WAIT_MS.
 */
export const PENDING_GRACE_MS = 30_000;

/** Only a broker `not-approved` terminal carries this: the broker itself decided nothing will run. */
const RETRY_GUIDANCE = '승인되지 않음 — 다시 요청 가능 (not approved; you may request it again)';
const CHECK_BEFORE_RETRY = 'Check the current state before requesting the same action again.';
const MAX_DETAIL_LENGTH = 200;
const VERSION_HINT =
  'the MCP server and the devops broker speak different protocol versions; they must be deployed together, and retrying will not help';

// ── Tool table ────────────────────────────────────────────

const NO_TOKENS = 'Never ask users for tokens; the broker holds every credential.';
const NEEDS_APPROVAL = 'Needs an admin ✅ on a Slack approval card; the call may wait up to 5 minutes for it.';
const STRUCTURED_GH = 'For org membership or repo collaborator changes use gh_org_member / gh_repo_access, not gh api.';

const ghArgsSchema = {
  type: 'object',
  properties: {
    account: { type: 'string', description: 'Account name from `list` (for example "member" or "org-admin").' },
    args: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      maxItems: 100,
      description: 'gh argv without the leading "gh", e.g. ["pr", "view", "12", "--repo", "example-org/app"].',
    },
  },
  required: ['account', 'args'],
  additionalProperties: false,
};

const leaseProperty = { type: 'string', description: 'Lease id returned by cf_lease_request (32 hex characters).' };

export const DEVOPS_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'list',
    description: `List the broker's gh accounts (name and class), Cloudflare environments, and the active Cloudflare leases of this session. Use it to learn valid account and env names. ${NO_TOKENS}`,
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'gh_read',
    description: `Run a read-only gh command with a broker account. Only allowlisted read commands run; anything else returns policy-denied. ${STRUCTURED_GH} ${NO_TOKENS}`,
    inputSchema: ghArgsSchema,
  },
  {
    name: 'gh_write',
    description: `Run an allowlisted gh write command (for example pr create, pr merge, issue comment) with a broker account. ${NEEDS_APPROVAL} ${STRUCTURED_GH} ${NO_TOKENS}`,
    inputSchema: ghArgsSchema,
  },
  {
    name: 'gh_org_member',
    description: `Add a member to the broker's GitHub org, change a member's role, or remove a member (the org is fixed by broker policy). role is required for add and set-role and must be omitted for remove. ${NEEDS_APPROVAL} Use this instead of gh api for membership changes. ${NO_TOKENS}`,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'set-role', 'remove'] },
        user: { type: 'string', description: 'GitHub login.' },
        role: { type: 'string', enum: ['member', 'admin'], description: 'Required for add and set-role only.' },
      },
      required: ['action', 'user'],
      additionalProperties: false,
    },
  },
  {
    name: 'gh_repo_access',
    description: `Grant a user collaborator access to a repository, or revoke it. permission is required for grant and must be omitted for revoke. ${NEEDS_APPROVAL} Use this instead of gh api for collaborator changes. ${NO_TOKENS}`,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['grant', 'revoke'] },
        repo: { type: 'string', description: 'owner/name, e.g. "example-org/app".' },
        user: { type: 'string', description: 'GitHub login.' },
        permission: {
          type: 'string',
          enum: ['pull', 'triage', 'push', 'maintain', 'admin'],
          description: 'Required for grant only.',
        },
      },
      required: ['action', 'repo', 'user'],
      additionalProperties: false,
    },
  },
  {
    name: 'cf_lease_request',
    description: `Request a short-lived Cloudflare API lease for one environment from \`list\`. ${NEEDS_APPROVAL} Returns a lease id, never a token; use it with cf_api and revoke it with cf_lease_revoke when done. ${NO_TOKENS}`,
    inputSchema: {
      type: 'object',
      properties: {
        env: { type: 'string', description: 'Environment name from `list`.' },
        access: { type: 'string', enum: ['read', 'edit'] },
        permissions: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 20,
          description: 'Cloudflare permission groups the environment policy allows.',
        },
        zones: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 20,
          description: 'Zone names, e.g. ["example.com"]; empty for account-level resources.',
        },
        ttl: { type: 'string', description: 'Lifetime like "30m" or "4h" (at most 71h). Omit for the policy default.' },
        reason: { type: 'string', description: 'Why the lease is needed; shown to the admin on the card.' },
      },
      required: ['env', 'access', 'permissions', 'zones', 'reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'cf_api',
    description: `Call the Cloudflare API v4 with an approved lease; the lease is the approval, so no card. Paths outside the lease's environment, zones, access level, or lifetime are refused. ${NO_TOKENS}`,
    inputSchema: {
      type: 'object',
      properties: {
        lease: leaseProperty,
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
        path: {
          type: 'string',
          description: 'Path under the API v4 base, starting with "/", e.g. "/zones/<id>/dns_records".',
        },
        query: { type: 'object', additionalProperties: { type: 'string' }, description: 'Query string parameters.' },
        body: { description: 'JSON request body.' },
      },
      required: ['lease', 'method', 'path'],
      additionalProperties: false,
    },
  },
  {
    name: 'cf_lease_revoke',
    description: `Revoke a Cloudflare lease now (its short-lived token is deleted). Use it when the work is done. ${NO_TOKENS}`,
    inputSchema: {
      type: 'object',
      properties: { lease: leaseProperty },
      required: ['lease'],
      additionalProperties: false,
    },
  },
];

// ── Requester claim ───────────────────────────────────────

type Env = Record<string, string | undefined>;

/** Same shape as the bot's session key (`work:<channel>:<thread|direct>`, src/session-identity.ts). */
export function sessionKeyFor(channel: string, threadTs?: string): string {
  return `work:${channel}:${threadTs || 'direct'}`;
}

/**
 * The Slack user and session the bot started this server for (SLACK_CONTEXT, the JSON the bot also
 * gives mcp-tool-permission). A claim only: the broker never authorizes on it.
 */
export function readRequesterClaim(
  env: Env,
): { ok: true; claim: UnverifiedRequesterClaim } | { ok: false; message: string } {
  const raw = env.SLACK_CONTEXT;
  if (!raw) return { ok: false, message: 'SLACK_CONTEXT is not set; devops-tools runs only inside a Slack session' };
  let context: unknown;
  try {
    context = JSON.parse(raw);
  } catch {
    return { ok: false, message: 'SLACK_CONTEXT is not valid JSON' };
  }
  if (typeof context !== 'object' || context === null) return { ok: false, message: 'SLACK_CONTEXT is not an object' };
  const { user, channel, threadTs } = context as Record<string, unknown>;
  if (typeof user !== 'string' || user.length === 0) return { ok: false, message: 'SLACK_CONTEXT has no user' };
  if (typeof channel !== 'string' || channel.length === 0)
    return { ok: false, message: 'SLACK_CONTEXT has no channel' };
  return {
    ok: true,
    claim: {
      slackUserId: user,
      sessionKey: sessionKeyFor(channel, typeof threadTs === 'string' ? threadTs : undefined),
    },
  };
}

// ── Broker exchange ───────────────────────────────────────

export type BrokerOutcome =
  | { kind: 'result'; data: JsonValue }
  | { kind: 'error'; error: ErrorMessage }
  /** Rejected here; nothing was sent. */
  | { kind: 'rejected'; message: string }
  /** The connection never opened; nothing was sent. */
  | { kind: 'unreachable'; detail: string }
  | { kind: 'version-mismatch'; detail: string }
  /** Broken exchange after the request may have been sent. */
  | { kind: 'protocol'; detail: string }
  /** `pending` is null when the broker never acknowledged the request. */
  | { kind: 'timeout'; pending: PendingMessage | null; waitedMs: number }
  /** `sent` = the request line had been handed to the socket, so the broker may still act on it. */
  | { kind: 'cancelled'; sent: boolean; pending: PendingMessage | null };

export interface CallBrokerOptions {
  socketPath: string;
  /** Total ceiling from the start of the call. Default MAX_WAIT_MS. */
  maxWaitMs?: number;
  /** Extra wait past the pending card's expiresAt. Default PENDING_GRACE_MS. */
  graceMs?: number;
  signal?: AbortSignal;
  onPending?: (pending: PendingMessage) => void;
}

function clip(text: string): string {
  return text.length > MAX_DETAIL_LENGTH ? `${text.slice(0, MAX_DETAIL_LENGTH)}…` : text;
}

/**
 * One request per connection: write the line, then read at most one `pending` and exactly one
 * terminal message. Every exit path closes the socket. Never retries.
 */
export function callBroker(request: DevopsRequest, options: CallBrokerOptions): Promise<BrokerOutcome> {
  let line: string;
  try {
    line = encodeMessage(request);
  } catch (error) {
    return Promise.resolve({ kind: 'rejected', message: error instanceof Error ? error.message : String(error) });
  }
  if (options.signal?.aborted) return Promise.resolve({ kind: 'cancelled', sent: false, pending: null });

  const maxWaitMs = options.maxWaitMs ?? MAX_WAIT_MS;
  const graceMs = options.graceMs ?? PENDING_GRACE_MS;
  const startedAt = Date.now();

  return new Promise<BrokerOutcome>((resolve) => {
    const socket = net.createConnection({ path: options.socketPath });
    let state: ExchangeState = { requestId: request.id, phase: 'awaiting' };
    let pending: PendingMessage | null = null;
    let buffered = '';
    /** Set when the request line is handed to the connected socket; before that nothing reached the broker. */
    let sent = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (outcome: BrokerOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      socket.destroy();
      resolve(outcome);
    };
    const onAbort = (): void => finish({ kind: 'cancelled', sent, pending });
    const protocolError = (detail: string): void => finish({ kind: 'protocol', detail: clip(detail) });
    const armTimer = (deadline: number): void => {
      clearTimeout(timer);
      timer = setTimeout(
        () =>
          sent
            ? finish({ kind: 'timeout', pending, waitedMs: Date.now() - startedAt })
            : finish({ kind: 'unreachable', detail: `connect timed out at ${options.socketPath}` }),
        Math.max(0, deadline - Date.now()),
      );
    };

    options.signal?.addEventListener('abort', onAbort, { once: true });
    armTimer(startedAt + maxWaitMs);
    socket.setEncoding('utf8');

    socket.on('connect', () => {
      sent = true;
      socket.write(line);
    });

    socket.on('data', (chunk: string) => {
      if (settled) return;
      const split = splitLines(buffered, chunk);
      buffered = split.rest;
      if (split.overflow) return protocolError('broker line too long');
      let terminal: BrokerMessage | null = null;
      for (const text of split.lines) {
        if (state.phase === 'done') return protocolError('message after the exchange ended');
        const json = parseJsonLine(text);
        if (!json.ok) return protocolError(json.message);
        const parsed = parseBrokerMessage(json.value);
        if (!parsed.ok) {
          if (parsed.code === 'version-mismatch')
            return finish({ kind: 'version-mismatch', detail: clip(parsed.message) });
          return protocolError(parsed.message);
        }
        const step = advanceExchange(state, parsed.value);
        if (!step.ok) return protocolError(step.message);
        state = step.state;
        const message = parsed.value;
        if (message.type === 'pending') {
          pending = message;
          armTimer(Math.min(startedAt + maxWaitMs, Date.parse(message.expiresAt) + graceMs));
          try {
            options.onPending?.(message);
          } catch {
            // Progress reporting must not break the exchange.
          }
        } else {
          terminal = message;
        }
      }
      if (terminal === null) return;
      // The first terminal ends the exchange and finish() closes the socket at once. Bytes already in
      // this read after it (a second message above, or a partial line here) are a protocol error;
      // anything the broker writes later is never read. No linger timer: with one request per
      // connection a later byte has nothing to mean, and waiting would only delay the answer.
      if (buffered.length > 0) return protocolError('data after the terminal message');
      if (terminal.type === 'result') return finish({ kind: 'result', data: terminal.data });
      if (terminal.type === 'error') return finish({ kind: 'error', error: terminal });
    });

    socket.on('error', (error: NodeJS.ErrnoException) => {
      const code = error.code ?? error.message;
      if (sent) protocolError(`connection failed: ${code}`);
      else finish({ kind: 'unreachable', detail: `${code} at ${options.socketPath}` });
    });

    socket.on('close', () => protocolError('the broker closed the connection before answering'));
  });
}

function textResult(text: string, isError: boolean): ToolResult {
  return isError ? { content: [{ type: 'text', text }], isError: true } : { content: [{ type: 'text', text }] };
}

/** What the model sees. Broker results and errors pass through as sent; nothing else is added. */
export function formatOutcome(outcome: BrokerOutcome): ToolResult {
  switch (outcome.kind) {
    case 'result':
      return textResult(JSON.stringify(outcome.data), false);
    case 'error': {
      const { error } = outcome;
      if (error.code === 'not-approved')
        return textResult(`error not-approved (${error.reason}): ${error.message}\n${RETRY_GUIDANCE}`, true);
      if (error.code === 'version-mismatch')
        return textResult(`error version-mismatch: ${error.message} — ${VERSION_HINT}`, true);
      return textResult(`error ${error.code}: ${error.message}`, true);
    }
    case 'rejected':
      return textResult(`error bad-request: ${outcome.message}`, true);
    case 'unreachable':
      return textResult(
        `devops broker is not reachable (${outcome.detail}); it may be stopped or not installed, and nothing was sent`,
        true,
      );
    case 'version-mismatch':
      return textResult(`error version-mismatch: ${outcome.detail} — ${VERSION_HINT}`, true);
    case 'protocol':
      return textResult(
        `devops broker protocol error (${outcome.detail}); the connection was closed and the request's outcome is unknown`,
        true,
      );
    case 'timeout':
      // The broker answers an unanswered card itself (not-approved, 25 s after expiry). Silence past
      // that means its answer was lost or late — the approval may have been used and the action run.
      if (outcome.pending !== null) {
        return textResult(
          `결과 확인 안 됨 — 승인·실행됐을 수 있음. 같은 작업을 다시 요청하기 전에 상태를 먼저 확인할 것 ${cardRef(outcome.pending)}\n` +
            `Outcome unknown: the broker's answer did not arrive before the wait ended, so the approval may have been granted and the action run. ${CHECK_BEFORE_RETRY}`,
          true,
        );
      }
      return textResult(
        `devops broker did not answer within ${Math.round(outcome.waitedMs / 1000)} s; the connection was closed and the request's outcome is unknown`,
        true,
      );
    case 'cancelled':
      if (!outcome.sent) {
        return textResult('devops-tools call cancelled before the request reached the broker; nothing was sent', true);
      }
      return textResult(
        `devops-tools call cancelled after the request was sent; the connection was closed, but the broker may still run it${
          outcome.pending === null ? '' : ` ${cardRef(outcome.pending)}`
        }. ${CHECK_BEFORE_RETRY}`,
        true,
      );
  }
}

function cardRef(pending: PendingMessage): string {
  return `(approval ${pending.approvalId}, card ${pending.digestPrefix})`;
}

// ── Tool runner ───────────────────────────────────────────

export interface RunToolOptions extends Omit<CallBrokerOptions, 'socketPath'> {
  /** Defaults to process.env; read for SLACK_CONTEXT and SOMA_DEVOPS_BROKER_SOCKET only. */
  env?: Env;
  /** Overrides SOMA_DEVOPS_BROKER_SOCKET. */
  socketPath?: string;
}

function isDevopsTool(name: string): name is DevopsTool {
  return (DEVOPS_TOOLS as readonly string[]).includes(name);
}

/** Validates locally (nothing is sent on failure), then relays one request to the broker. */
export async function runDevopsTool(name: string, rawArgs: unknown, options: RunToolOptions = {}): Promise<ToolResult> {
  if (!isDevopsTool(name)) return formatOutcome({ kind: 'rejected', message: `unknown tool ${JSON.stringify(name)}` });
  const args = rawArgs ?? {};
  const checked = validateToolArgs(name, args);
  if (!checked.ok) return formatOutcome({ kind: 'rejected', message: checked.message });

  const env = options.env ?? process.env;
  const requester = readRequesterClaim(env);
  if (!requester.ok) return formatOutcome({ kind: 'rejected', message: requester.message });

  const request = { v: PROTOCOL_VERSION, id: randomUUID(), tool: name, args, claimedRequester: requester.claim };
  // The broker runs the same parser; checking here keeps a request it would refuse off the socket.
  const parsed = parseRequest(request);
  if (!parsed.ok) return formatOutcome({ kind: 'rejected', message: parsed.message });

  const { env: _env, socketPath, ...callOptions } = options;
  const outcome = await callBroker(parsed.value, {
    ...callOptions,
    socketPath: socketPath || env[BROKER_SOCKET_ENV] || DEFAULT_BROKER_SOCKET_PATH,
  });
  return formatOutcome(outcome);
}

// ── MCP server ────────────────────────────────────────────

type CallExtra = Pick<RequestHandlerExtra<ServerRequest, ServerNotification>, 'signal' | '_meta' | 'sendNotification'>;

export class DevopsToolsMCPServer extends BaseMcpServer {
  constructor(private readonly options: Omit<RunToolOptions, 'signal' | 'onPending'> = {}) {
    super('devops-tools');
    // Replaces the base dispatcher so a call can see its cancellation signal and progress token.
    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { name, arguments: args } = request.params;
      this.logger.debug(`Tool call: ${name}`);
      try {
        return await this.callTool(name, args, extra);
      } catch (error) {
        return this.formatError(name, error);
      }
    });
  }

  defineTools(): ToolDefinition[] {
    return DEVOPS_TOOL_DEFINITIONS;
  }

  async handleTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    return runDevopsTool(name, args, this.options);
  }

  async callTool(name: string, args: unknown, extra: CallExtra): Promise<ToolResult> {
    const progressToken = extra._meta?.progressToken;
    return runDevopsTool(name, args, {
      ...this.options,
      signal: extra.signal,
      onPending: (pending) => {
        this.logger.info('Waiting for admin approval', {
          tool: name,
          approvalId: pending.approvalId,
          expiresAt: pending.expiresAt,
        });
        if (progressToken === undefined) return;
        extra
          .sendNotification({
            method: 'notifications/progress',
            params: {
              progressToken,
              progress: 0,
              message: `waiting for an admin ✅ on Slack card ${pending.digestPrefix} (expires ${pending.expiresAt})`,
            },
          })
          .catch(() => {});
      },
    });
  }
}

const invokedDirectly =
  require.main === module ||
  ['devops-tools-mcp-server.ts', 'devops-tools-mcp-server.js'].includes(path.basename(process.argv[1] ?? ''));

async function main(): Promise<void> {
  await new DevopsToolsMCPServer().run();
}

if (invokedDirectly) {
  main().catch((error) => {
    console.error('devops-tools MCP server error:', error);
    process.stderr.write('', () => process.exit(1));
  });
}
