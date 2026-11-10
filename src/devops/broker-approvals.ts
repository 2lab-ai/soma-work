/**
 * devops broker cards in the dashboard's admin approvals (#1051, #1129).
 *
 * The broker posts its approval cards to the admins' Slack DMs. This adapter lists the cards the broker is
 * waiting on, so an admin who works in the dashboard sees them, with the card's own lines.
 *
 * Whether the dashboard may decide a card is the broker's call, from its root-owned policy
 * (`dashboardDecisions`): the listing marks each card `decidable`. A decidable card is an approve / deny card
 * that can be decided with others in one pass; the answer goes to the broker's `decide` op, bound to the card
 * number (digest prefix) the admin saw. This process runs as the same OS user as the model, so with that switch
 * on the model's user can decide those cards too — the operator's recorded trade-off (#1127). Any other card's one
 * choice opens the admin's own Slack card, where the decision is made.
 *
 * A broker older than the `approvals` op refuses the listing. Then the cards come from the records the
 * devops-tools MCP server keeps while it waits on one (`PENDING_DIR_ENV`), and the choice opens the
 * approvals app's DM (`devops-tools.approvalsAppUrl`), so a broker upgrade (root) is not needed first.
 * Those records are written by the model's OS user: the card says so and points at the Slack card.
 *
 * On a host without a broker the socket is missing and the kind lists nothing.
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import {
  type AdminRequest,
  DEFAULT_BROKER_SOCKET_PATH,
  DEVOPS_TOOLS,
  encodeMessage,
  type PendingCardRecord,
  PROTOCOL_VERSION,
  parseBrokerMessage,
  parseJsonLine,
  splitLines,
} from '@soma/process-shared/devops/protocol.js';
import type {
  AdminApproval,
  AdminApprovalAdapter,
  AdminApprovalAnswer,
  AdminApprovalResolution,
} from '../admin-approvals';
import { Logger } from '../logger';

const logger = new Logger('DevopsBrokerApprovals');

const LIST_TIMEOUT_MS = 3_000;
/** A `decide` of up to 50 cards writes each decision to disk and the ledger before it answers. */
const DECIDE_TIMEOUT_MS = 15_000;
/** Dashboard decisions are remembered this long, for the resolved rows. */
const RESOLVED_KEEP_MS = 10 * 60 * 1000;
export const APPROVE_CHOICE = 'approve';
export const DENY_CHOICE = 'deny';
/** The admin-approval watch reads every second; the broker is asked at most this often. */
const REFRESH_MS = 5_000;
/** A broker that refuses the op (an older build) or errors is left alone this long: its ledger logs each refusal. */
const BACKOFF_MS = 10 * 60 * 1000;
/** A Slack message link only — a listing that points anywhere else is dropped. */
const SLACK_LINK_RE = /^https:\/\/[a-z0-9-]+\.slack\.com\/archives\/[A-Z0-9]+\/p[0-9]+(?:\?[^\s"'<>]*)?$/;
const APPROVAL_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const SLACK_USER_RE = /^[UW][A-Z0-9]{2,20}$/;
/** The approvals app's DM in Slack (`devops-tools.approvalsAppUrl`). */
const APP_LINK_RE = /^https:\/\/[a-z0-9-]+\.slack\.com\/app_redirect\?app=A[A-Z0-9]{2,20}(?:&team=T[A-Z0-9]{2,20})?$/;
/** `<approvalId>.<requestId>.json`, as the MCP server names them. */
const RECORD_FILE_RE = /^[A-Za-z0-9_-]{8,64}\.[A-Za-z0-9_-]{1,64}\.json$/;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DIGEST_PREFIX_RE = /^[0-9a-f]{12}$/;
const MAX_RECORDS = 50;
const MAX_RECORD_BYTES = 4096;
/** A record this long past its card's deadline is removed: the MCP server that wrote it died before it could. */
const PRUNE_AFTER_MS = 60 * 60 * 1000;

export const OPEN_SLACK_CHOICE = 'open_slack';
/** `links[].admin` of a link any admin may open (the approvals app's DM). */
export const ANY_ADMIN = '*';

/** The MCP server's card records, under the bot's data directory (mcp-config-builder sets the env). */
export function devopsPendingDir(dataDir: string): string {
  return path.join(dataDir, 'devops-pending');
}

/** The broker's `approvals` result, as `approval.ts` `PendingApprovalView` writes it (#1129 fields optional: an older broker). */
interface BrokerApprovalView {
  approvalId: string;
  tool: string;
  title: string;
  requester: string;
  digestPrefix: string;
  createdAt: string;
  expiresAt: string;
  cards: { admin: string; permalink?: string }[];
  details?: { label: string; value: string }[];
  argv?: string[];
  warnings?: string[];
  queued?: boolean;
  queuedUntil?: string;
  liveUntil?: string;
  decidable?: boolean;
}

type DecideOutcome = {
  approvalId: string;
  outcome: 'accepted' | 'refused';
  reason?: string;
};

export type CallResult = { ok: true; data: unknown } | { ok: false; unreachable: boolean; message: string };

let requestSeq = 0;

/** An admin op and its arguments, as `AdminRequest` types them. */
export type BrokerAdminCall = Pick<AdminRequest, 'op' | 'args'>;

/** One admin op over the broker socket: write one line, read exactly one terminal message. */
export function callBrokerAdmin(
  socketPath: string,
  call: BrokerAdminCall = { op: 'approvals', args: {} },
  timeoutMs = LIST_TIMEOUT_MS,
): Promise<CallResult> {
  requestSeq = (requestSeq + 1) % 1_000_000;
  const request = {
    v: PROTOCOL_VERSION,
    id: `dash-${process.pid}-${requestSeq}`,
    ...call,
  } as AdminRequest;
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

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const isDetails = (value: unknown): value is { label: string; value: string }[] =>
  Array.isArray(value) &&
  value.every((item) => isRecord(item) && typeof item.label === 'string' && typeof item.value === 'string');

/** Only what the dashboard shows: a malformed entry is skipped, never half-rendered. */
function isView(value: unknown): value is BrokerApprovalView {
  if (!isRecord(value)) return false;
  return (
    typeof value.approvalId === 'string' &&
    APPROVAL_ID_RE.test(value.approvalId) &&
    typeof value.tool === 'string' &&
    typeof value.title === 'string' &&
    typeof value.requester === 'string' &&
    typeof value.digestPrefix === 'string' &&
    DIGEST_PREFIX_RE.test(value.digestPrefix) &&
    typeof value.createdAt === 'string' &&
    typeof value.expiresAt === 'string' &&
    Array.isArray(value.cards) &&
    (value.details === undefined || isDetails(value.details)) &&
    (value.argv === undefined || isStringList(value.argv)) &&
    (value.warnings === undefined || isStringList(value.warnings)) &&
    (value.queued === undefined || typeof value.queued === 'boolean') &&
    (value.queuedUntil === undefined || typeof value.queuedUntil === 'string') &&
    (value.decidable === undefined || typeof value.decidable === 'boolean')
  );
}

/** How much an approval can do: org and repo access, merges and edit leases are high; other writes medium. */
export function brokerCardRisk(
  view: Pick<BrokerApprovalView, 'tool' | 'title' | 'argv' | 'warnings'>,
): 'medium' | 'high' {
  if (view.tool === 'gh_org_member' || view.tool === 'gh_repo_access') return 'high';
  if (view.tool === 'gh_write') {
    const merge = (view.argv?.[0] === 'pr' && view.argv?.[1] === 'merge') || view.title.includes('머지');
    return merge || (view.warnings ?? []).length > 0 ? 'high' : 'medium';
  }
  if (view.tool === 'cf_lease_request') {
    return (view.warnings ?? []).some((w) => w.includes('변경 권한')) ? 'high' : 'medium';
  }
  return 'medium';
}

const MAX_ROW_VALUE = 2_000;

function clipRow(text: string): string {
  return text.length > MAX_ROW_VALUE ? `${text.slice(0, MAX_ROW_VALUE - 1)}…` : text;
}

/** The Slack card's lines as labelled rows: details, the gh command, the warnings, the card number. */
function cardRows(view: BrokerApprovalView): Record<string, string> {
  const rows: Record<string, string> = {};
  const used = new Set<string>();
  const put = (label: string, value: string) => {
    let key = label;
    for (let n = 2; used.has(key); n++) key = `${label} (${n})`;
    used.add(key);
    rows[key] = clipRow(value);
  };
  for (const d of view.details ?? []) put(d.label, d.value);
  if (view.argv !== undefined && view.argv.length > 0)
    put('명령', `gh ${view.argv.map((a) => JSON.stringify(a)).join(' ')}`);
  if ((view.warnings ?? []).length > 0) put('주의', (view.warnings ?? []).join(' · '));
  put('카드 번호', view.digestPrefix);
  return rows;
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

/** The card's own end: the queue's end when it is queued (or the broker has a queue), else its expiry. */
function cardEnd(view: BrokerApprovalView): number | undefined {
  return Date.parse(view.queuedUntil ?? view.expiresAt) || undefined;
}

/** #1129 — a card the broker lets the dashboard decide: approve / deny, batchable, bound to its card number. */
function toDecidableApproval(view: BrokerApprovalView): AdminApproval {
  const queued = view.queued === true;
  return {
    id: `devops_broker:${view.approvalId}`,
    kind: 'devops_broker',
    card: 'permission',
    title: view.title,
    summary: view.title,
    description: queued
      ? `요청자는 더 기다리지 않습니다. 승인하면 브로커가 그때 실행하고 결과를 요청한 세션으로 보냅니다. Slack 카드 ${view.digestPrefix}와 같은 요청입니다.`
      : `요청자가 응답을 기다리는 중입니다. Slack 카드 ${view.digestPrefix}와 같은 요청이고, 어느 쪽에서 결정해도 같습니다.`,
    tool: `devops:${view.tool}`,
    rows: cardRows(view),
    risk: brokerCardRisk(view),
    batch: { approve: APPROVE_CHOICE, deny: DENY_CHOICE },
    ...(queued ? { queued: true } : {}),
    links: linksOf(view),
    requesterId: SLACK_USER_RE.test(view.requester) ? view.requester : '',
    createdAt: Date.parse(view.createdAt) || 0,
    expiresAt: cardEnd(view),
  };
}

function toApproval(view: BrokerApprovalView): AdminApproval {
  if (view.decidable === true) return toDecidableApproval(view);
  return {
    id: `devops_broker:${view.approvalId}`,
    kind: 'devops_broker',
    card: 'question',
    title: view.title,
    description:
      '승인·거부는 Slack 카드에서 합니다 (요청 내용 전체가 거기 있어요). 대시보드는 모델과 같은 계정으로 돌아서, 여기서 승인하면 모델이 자기 요청을 승인할 수 있기 때문입니다.',
    tool: `devops:${view.tool}`,
    summary: view.title,
    risk: brokerCardRisk(view),
    ...(view.queued === true ? { queued: true } : {}),
    ...(view.details !== undefined ? { rows: cardRows(view) } : {}),
    choices: [{ id: OPEN_SLACK_CHOICE, label: '↗ Slack 카드 열기 (거기서 승인·거부)' }],
    recommendedId: OPEN_SLACK_CHOICE,
    links: linksOf(view),
    requesterId: SLACK_USER_RE.test(view.requester) ? view.requester : '',
    createdAt: Date.parse(view.createdAt) || 0,
    expiresAt: cardEnd(view),
  };
}

function isCardRecord(value: unknown): value is PendingCardRecord {
  if (!isRecord(value)) return false;
  return (
    value.v === PROTOCOL_VERSION &&
    typeof value.approvalId === 'string' &&
    APPROVAL_ID_RE.test(value.approvalId) &&
    typeof value.requestId === 'string' &&
    REQUEST_ID_RE.test(value.requestId) &&
    typeof value.pid === 'number' &&
    Number.isInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.tool === 'string' &&
    (DEVOPS_TOOLS as readonly string[]).includes(value.tool) &&
    typeof value.digestPrefix === 'string' &&
    DIGEST_PREFIX_RE.test(value.digestPrefix) &&
    typeof value.requester === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.expiresAt === 'string' &&
    !Number.isNaN(Date.parse(value.expiresAt))
  );
}

/** Whether the MCP server that wrote a record still runs (same OS user, so a signal-0 probe answers). */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** One record file: a regular file of at most MAX_RECORD_BYTES, never through a link, never blocking on a FIFO. */
function readRecordFile(file: string): unknown {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) return null;
    const buffer = Buffer.alloc(stat.size);
    const read = fs.readSync(fd, buffer, 0, stat.size, 0);
    return JSON.parse(buffer.subarray(0, read).toString('utf8'));
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The MCP server's records of the cards it waits on, one per card. A malformed one is skipped; one whose
 * process is gone, or long past its deadline, is removed.
 */
function readCardRecords(dir: string, now: number): PendingCardRecord[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const byCard = new Map<string, PendingCardRecord>();
  for (const name of names.filter((n) => RECORD_FILE_RE.test(n)).slice(0, MAX_RECORDS)) {
    const file = path.join(dir, name);
    try {
      const record = readRecordFile(file);
      if (!isCardRecord(record) || `${record.approvalId}.${record.requestId}.json` !== name) continue;
      if (Date.parse(record.expiresAt) + PRUNE_AFTER_MS < now || !processAlive(record.pid)) {
        fs.rmSync(file, { force: true });
        continue;
      }
      const seen = byCard.get(record.approvalId);
      if (!seen || record.createdAt < seen.createdAt) byCard.set(record.approvalId, record);
    } catch {
      // Being written or removed right now, or not a plain file: the next read sees it settled.
    }
  }
  return [...byCard.values()];
}

function recordToApproval(record: PendingCardRecord, appUrl: string | undefined): AdminApproval {
  return {
    id: `devops_broker:${record.approvalId}`,
    kind: 'devops_broker',
    card: 'question',
    title: `devops 승인 대기 — ${record.tool} (카드 ${record.digestPrefix})`,
    description:
      '요청 내용과 승인·거부는 Slack 승인 앱 DM에 있는 같은 번호의 카드에서 확인하고 결정합니다. 이 항목은 봇이 남긴 대기 표시일 뿐이라 내용이 맞는지 보장하지 않습니다. 대시보드는 모델과 같은 계정으로 돌기 때문에 여기서는 결정하지 않습니다.',
    tool: `devops:${record.tool}`,
    choices: [{ id: OPEN_SLACK_CHOICE, label: '↗ Slack 승인 앱 열기 (거기서 승인·거부)' }],
    recommendedId: OPEN_SLACK_CHOICE,
    links: appUrl ? [{ admin: ANY_ADMIN, url: appUrl }] : [],
    requesterId: SLACK_USER_RE.test(record.requester) ? record.requester : '',
    createdAt: Date.parse(record.createdAt) || 0,
    expiresAt: Date.parse(record.expiresAt) || undefined,
  };
}

function devopsSection(configFile: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const section = isRecord(parsed) ? parsed['devops-tools'] : undefined;
    return isRecord(section) ? section : undefined;
  } catch {
    return undefined;
  }
}

/** `devops-tools.socketPath` from config.json when it is absolute (the MCP server honours the same key). */
export function devopsBrokerSocketPath(configFile: string): string | undefined {
  const socketPath = devopsSection(configFile)?.socketPath;
  return typeof socketPath === 'string' && path.isAbsolute(socketPath) ? socketPath : undefined;
}

/** `devops-tools.approvalsAppUrl` from config.json: the approvals app's DM, `https://<team>.slack.com/app_redirect?app=A…`. */
export function devopsApprovalsAppUrl(configFile: string): string | undefined {
  const url = devopsSection(configFile)?.approvalsAppUrl;
  return typeof url === 'string' && APP_LINK_RE.test(url) ? url : undefined;
}

export function devopsBrokerAdminApprovalAdapter(
  opts: { socketPath?: string; pendingDir?: string; approvalsAppUrl?: string; now?: () => number } = {},
): AdminApprovalAdapter {
  const socketPath = opts.socketPath ?? DEFAULT_BROKER_SOCKET_PATH;
  const appUrl = opts.approvalsAppUrl && APP_LINK_RE.test(opts.approvalsAppUrl) ? opts.approvalsAppUrl : undefined;
  const clock = opts.now ?? Date.now;
  let warned = false;
  /** The broker's own listing, or null while it cannot list (an older build, an error, no broker). */
  let views: BrokerApprovalView[] | null = null;
  let records: PendingCardRecord[] = [];
  let nextReadAt = 0;
  let nextAskAt = 0;
  let asking: Promise<void> | null = null;

  async function askBroker(): Promise<void> {
    const result = await callBrokerAdmin(socketPath);
    if (!result.ok) {
      views = null;
      // No broker on this host is the normal case (ask again later); a refusal backs off and is logged once.
      nextAskAt = clock() + (result.unreachable ? REFRESH_MS : BACKOFF_MS);
      if (!result.unreachable && !warned) {
        warned = true;
        logger.warn(
          'devops broker cards could not be listed; using the MCP server records, asking again in 10 minutes',
          {
            message: result.message,
          },
        );
      }
      return;
    }
    warned = false;
    nextAskAt = clock() + REFRESH_MS;
    const listed = isRecord(result.data) && Array.isArray(result.data.approvals) ? result.data.approvals : [];
    views = listed.filter(isView);
  }

  async function refresh(now: number): Promise<void> {
    if (clock() >= nextAskAt) await askBroker();
    // Read (and prune) the records even while the broker lists: they are shown only when it cannot.
    records = opts.pendingDir ? readCardRecords(opts.pendingDir, now) : [];
    nextReadAt = clock() + REFRESH_MS;
  }

  /** Dashboard decisions this process sent and the broker accepted, for the resolved rows. */
  let resolutions: AdminApprovalResolution[] = [];

  function refusal(reason: string | undefined): AdminApprovalAnswer {
    switch (reason) {
      case 'not-pending':
        return { ok: false, reason: 'already_answered' };
      case 'not-admin':
      case 'dashboard-decisions-off':
      case 'tool-not-allowed':
        return { ok: false, reason: 'forbidden' };
      case 'closed':
        return { ok: false, reason: 'busy' };
      default:
        // digest-mismatch (the card changed under the admin), failed, or an answer this build does not know.
        return { ok: false, reason: 'invalid' };
    }
  }

  async function decide(
    items: { requestId: string; choiceId: string }[],
    actor: string,
  ): Promise<AdminApprovalAnswer[]> {
    const answers: (AdminApprovalAnswer | undefined)[] = items.map(() => undefined);
    const decisions: { approvalId: string; digestPrefix: string; action: 'approve' | 'deny' }[] = [];
    const slots: number[] = [];
    items.forEach((item, i) => {
      const action = item.choiceId === APPROVE_CHOICE ? 'approve' : item.choiceId === DENY_CHOICE ? 'deny' : null;
      // The card number the admin saw: the listing this process last showed. A card not in it was never shown.
      // No broker listing (an older broker: the MCP server's records) or `open_slack`: nothing to decide here.
      if (views === null || action === null) {
        answers[i] = { ok: false, reason: 'invalid' };
        return;
      }
      const view = views.find((v) => v.approvalId === item.requestId);
      if (view === undefined) {
        answers[i] = { ok: false, reason: 'not_found' };
        return;
      }
      if (view.decidable !== true) {
        answers[i] = { ok: false, reason: 'forbidden' };
        return;
      }
      decisions.push({ approvalId: view.approvalId, digestPrefix: view.digestPrefix, action });
      slots.push(i);
    });
    if (decisions.length > 0) {
      const result = await callBrokerAdmin(socketPath, { op: 'decide', args: { decisions, actor } }, DECIDE_TIMEOUT_MS);
      const outcomes: DecideOutcome[] =
        result.ok && isRecord(result.data) && Array.isArray(result.data.outcomes)
          ? (result.data.outcomes as DecideOutcome[])
          : [];
      if (!result.ok) logger.warn('devops broker decide failed', { message: result.message });
      const at = clock();
      decisions.forEach((d, k) => {
        const outcome = outcomes.find((o) => isRecord(o) && o.approvalId === d.approvalId);
        const i = slots[k];
        if (!result.ok) {
          answers[i] = { ok: false, reason: 'busy' };
        } else if (outcome?.outcome === 'accepted') {
          const verdict = d.action === 'approve' ? 'approved' : 'denied';
          answers[i] = { ok: true, outcome: verdict };
          resolutions.push({
            id: `devops_broker:${d.approvalId}`,
            outcome: verdict,
            choiceId: d.action,
            by: actor,
            via: 'dashboard',
            at,
          });
        } else {
          answers[i] = refusal(outcome?.reason);
        }
      });
      // The decided cards leave the broker's list: read it again on the next look.
      nextReadAt = 0;
      nextAskAt = 0;
    }
    return answers.map((a) => a ?? { ok: false, reason: 'invalid' });
  }

  return {
    kind: 'devops_broker',
    async pending(now) {
      if (clock() >= nextReadAt) {
        asking ??= refresh(now).finally(() => {
          asking = null;
        });
        await asking;
      }
      if (views === null) {
        return records.filter((r) => Date.parse(r.expiresAt) > now).map((r) => recordToApproval(r, appUrl));
      }
      return views.filter((view) => (cardEnd(view) ?? 0) > now).map(toApproval);
    },
    resolved(since) {
      // A Slack decision: the card simply leaves the broker's list. A dashboard one is remembered here a while.
      resolutions = resolutions.filter((r) => r.at >= clock() - RESOLVED_KEEP_MS);
      return resolutions.filter((r) => r.at >= since);
    },
    async answer(requestId, choiceId, actor) {
      // `open_slack` opens Slack in the browser (the client does it); only a decidable card is answered here.
      const [answer] = await decide([{ requestId, choiceId }], actor);
      return answer;
    },
    answerMany: (items, actor) => decide(items, actor),
  };
}
