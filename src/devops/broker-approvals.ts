/**
 * devops broker cards in the dashboard's admin approvals (#1051).
 *
 * The broker posts its approval cards to the admins' Slack DMs. This adapter lists the cards the broker is
 * waiting on, so an admin who works in the dashboard sees them. Each card's one choice opens the admin's own
 * Slack card, where the decision is made.
 *
 * It never decides. This process runs as the same OS user as the model, so a decision relayed from here
 * would let the model approve its own request. The broker accepts a decision only from the admin's own
 * reaction or button on its Slack card.
 *
 * On a host without a broker the socket is missing and the kind lists nothing.
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import {
  type AdminRequest,
  DEFAULT_BROKER_SOCKET_PATH,
  encodeMessage,
  PROTOCOL_VERSION,
  parseBrokerMessage,
  parseJsonLine,
  splitLines,
} from '@soma/process-shared/devops/protocol.js';
import type { AdminApproval, AdminApprovalAdapter } from '../admin-approvals';
import { Logger } from '../logger';

const logger = new Logger('DevopsBrokerApprovals');

const LIST_TIMEOUT_MS = 3_000;
/** The admin-approval watch reads every second; the broker is asked at most this often. */
const REFRESH_MS = 5_000;
/** A broker that refuses the op (an older build) or errors is left alone this long: its ledger logs each refusal. */
const BACKOFF_MS = 10 * 60 * 1000;
/** A Slack message link only — a listing that points anywhere else is dropped. */
const SLACK_LINK_RE = /^https:\/\/[a-z0-9-]+\.slack\.com\/archives\/[A-Z0-9]+\/p[0-9]+(?:\?[^\s"'<>]*)?$/;
const APPROVAL_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const SLACK_USER_RE = /^[UW][A-Z0-9]{2,20}$/;

export const OPEN_SLACK_CHOICE = 'open_slack';

/** The broker's `approvals` result, as `approval.ts` `PendingApprovalView` writes it. */
interface BrokerApprovalView {
  approvalId: string;
  tool: string;
  title: string;
  requester: string;
  digestPrefix: string;
  createdAt: string;
  expiresAt: string;
  cards: { admin: string; permalink?: string }[];
}

type CallResult = { ok: true; data: unknown } | { ok: false; unreachable: boolean; message: string };

let requestSeq = 0;

/** One admin op over the broker socket: write one line, read exactly one terminal message. */
export function callBrokerAdmin(socketPath: string, timeoutMs = LIST_TIMEOUT_MS): Promise<CallResult> {
  requestSeq = (requestSeq + 1) % 1_000_000;
  const request: AdminRequest = {
    v: PROTOCOL_VERSION,
    id: `dash-${process.pid}-${requestSeq}`,
    op: 'approvals',
    args: {},
  };
  const line = encodeMessage(request);
  return new Promise((resolve) => {
    const socket = net.createConnection({ path: socketPath });
    let buffered = '';
    let done = false;
    const finish = (result: CallResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ ok: false, unreachable: false, message: 'broker did not answer in time' }),
      timeoutMs,
    );
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(line));
    socket.on('error', (err: NodeJS.ErrnoException) => {
      const unreachable = err.code === 'ENOENT' || err.code === 'ECONNREFUSED' || err.code === 'EACCES';
      finish({ ok: false, unreachable, message: err.code ?? err.message });
    });
    socket.on('close', () => finish({ ok: false, unreachable: false, message: 'broker closed without an answer' }));
    socket.on('data', (chunk: string) => {
      const split = splitLines(buffered, chunk);
      buffered = split.rest;
      if (split.overflow) return finish({ ok: false, unreachable: false, message: 'broker line too long' });
      for (const text of split.lines) {
        const json = parseJsonLine(text);
        if (!json.ok) return finish({ ok: false, unreachable: false, message: json.message });
        const parsed = parseBrokerMessage(json.value);
        if (!parsed.ok) return finish({ ok: false, unreachable: false, message: parsed.message });
        const message = parsed.value;
        if (message.type === 'pending') continue;
        if (message.type === 'error') {
          return finish({ ok: false, unreachable: false, message: `${message.code}: ${message.message}` });
        }
        return finish({ ok: true, data: message.data });
      }
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Only what the dashboard shows: a malformed entry is skipped, never half-rendered. */
function isView(value: unknown): value is BrokerApprovalView {
  if (!isRecord(value)) return false;
  return (
    typeof value.approvalId === 'string' &&
    APPROVAL_ID_RE.test(value.approvalId) &&
    typeof value.tool === 'string' &&
    typeof value.title === 'string' &&
    typeof value.requester === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.expiresAt === 'string' &&
    Array.isArray(value.cards)
  );
}

function linksOf(view: BrokerApprovalView): { admin: string; url: string }[] {
  const out: { admin: string; url: string }[] = [];
  for (const card of view.cards) {
    if (!isRecord(card) || typeof card.admin !== 'string' || !SLACK_USER_RE.test(card.admin)) continue;
    if (typeof card.permalink !== 'string' || card.permalink.length > 2000 || !SLACK_LINK_RE.test(card.permalink))
      continue;
    out.push({ admin: card.admin, url: card.permalink });
  }
  return out;
}

function toApproval(view: BrokerApprovalView): AdminApproval {
  return {
    id: `devops_broker:${view.approvalId}`,
    kind: 'devops_broker',
    card: 'question',
    title: view.title,
    description:
      '승인·거부는 Slack 카드에서 합니다 (요청 내용 전체가 거기 있어요). 대시보드는 모델과 같은 계정으로 돌아서, 여기서 승인하면 모델이 자기 요청을 승인할 수 있기 때문입니다.',
    tool: `devops:${view.tool}`,
    choices: [{ id: OPEN_SLACK_CHOICE, label: '↗ Slack 카드 열기 (거기서 승인·거부)' }],
    recommendedId: OPEN_SLACK_CHOICE,
    links: linksOf(view),
    requesterId: SLACK_USER_RE.test(view.requester) ? view.requester : '',
    createdAt: Date.parse(view.createdAt) || 0,
    expiresAt: Date.parse(view.expiresAt) || undefined,
  };
}

/** `devops-tools.socketPath` from config.json when it is absolute (the MCP server honours the same key). */
export function devopsBrokerSocketPath(configFile: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const section = isRecord(parsed) ? parsed['devops-tools'] : undefined;
    const socketPath = isRecord(section) ? section.socketPath : undefined;
    return typeof socketPath === 'string' && path.isAbsolute(socketPath) ? socketPath : undefined;
  } catch {
    return undefined;
  }
}

export function devopsBrokerAdminApprovalAdapter(
  opts: { socketPath?: string; now?: () => number } = {},
): AdminApprovalAdapter {
  const socketPath = opts.socketPath ?? DEFAULT_BROKER_SOCKET_PATH;
  const clock = opts.now ?? Date.now;
  let warned = false;
  let views: BrokerApprovalView[] = [];
  let nextAskAt = 0;
  let asking: Promise<void> | null = null;

  async function refresh(): Promise<void> {
    const result = await callBrokerAdmin(socketPath);
    if (!result.ok) {
      views = [];
      // No broker on this host is the normal case (ask again later); a refusal backs off and is logged once.
      nextAskAt = clock() + (result.unreachable ? REFRESH_MS : BACKOFF_MS);
      if (!result.unreachable && !warned) {
        warned = true;
        logger.warn('devops broker cards could not be listed; asking again in 10 minutes', { message: result.message });
      }
      return;
    }
    warned = false;
    nextAskAt = clock() + REFRESH_MS;
    const listed = isRecord(result.data) && Array.isArray(result.data.approvals) ? result.data.approvals : [];
    views = listed.filter(isView);
  }

  return {
    kind: 'devops_broker',
    async pending(now) {
      if (clock() >= nextAskAt) {
        asking ??= refresh().finally(() => {
          asking = null;
        });
        await asking;
      }
      return views.filter((view) => (Date.parse(view.expiresAt) || 0) > now).map(toApproval);
    },
    resolved() {
      // Decided in Slack: the card simply leaves the broker's list.
      return [];
    },
    async answer() {
      // The card's one choice opens Slack in the browser; nothing is ever decided from here.
      return { ok: false, reason: 'invalid' };
    },
  };
}
