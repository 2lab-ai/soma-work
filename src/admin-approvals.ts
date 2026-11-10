/**
 * Admin approvals — the requests that reach the admins by Slack DM (an
 * environment skill run, an MCP tool grant, a new user, a bot-message
 * delete; a devops broker card; a question the model asked for an admin), shown to admins signed in to the dashboard as approval cards and
 * answerable there. An answer on either surface resolves both: the dashboard
 * answer runs the same decision the Slack button runs, which rewrites every
 * admin's DM; a Slack answer drops the card from the dashboard.
 *
 * This module is the registry only. It holds no pending state of its own:
 * each kind registers an adapter that reads its existing request store and
 * answers through the kind's existing decision path.
 */

import type { DecisionFields } from 'somalib/model-commands/session-types';
import { Logger } from './logger';

const logger = new Logger('AdminApprovals');

export type AdminApprovalKind =
  | 'env_skill'
  | 'mcp_grant'
  | 'new_user'
  | 'bot_delete'
  | 'devops_broker'
  /** #1070 — a question the model asked for an admin (`ASK_USER_QUESTION` with `audience: 'admins'`). */
  | 'session_question';

export const ADMIN_APPROVAL_KINDS: readonly AdminApprovalKind[] = [
  'env_skill',
  'mcp_grant',
  'new_user',
  'bot_delete',
  'devops_broker',
  'session_question',
];

export interface AdminApprovalChoice {
  id: string;
  label: string;
  description?: string;
}

/** One pending request, display-ready for an approval card. */
export interface AdminApproval {
  /** `<kind>:<requestId>` */
  id: string;
  kind: AdminApprovalKind;
  /** `question`: pick one of `choices`. `permission`: Approve (`approve`) / Deny (`deny`). */
  card: 'question' | 'permission';
  title: string;
  /**
   * #1131 — one line: what happens if it is approved (for example "`alice`를 사용자로 추가"). The card's main line
   * and the batch confirm sheet's row. Absent: the dashboard shows `title`.
   */
  summary?: string;
  description?: string;
  /** `permission` cards: the tool name the card's icon reads (for example `mcp__github`). */
  tool?: string;
  /** `permission` cards: labelled rows shown as the request's input. */
  rows?: Record<string, string>;
  risk?: 'low' | 'medium' | 'high';
  choices?: AdminApprovalChoice[];
  recommendedId?: string;
  /**
   * `question` cards (#1073): the question's decision lines — what the answer is holding up, what is at stake, whether
   * the choice can be undone. The dashboard draws them with the session view's `decisionLines`. Absent when none.
   */
  decision?: DecisionFields;
  /** Slack user id of whoever asked. */
  requesterId: string;
  /** Where the request was made (env skill / MCP grant). */
  place?: { channel: string; threadTs?: string };
  createdAt: number;
  expiresAt?: number;
  /**
   * `devops_broker` (#1051): each admin's own Slack card, or (`admin: '*'`, for a broker that cannot list its
   * cards) the approvals app's DM for any admin. The card's one choice opens the viewer's link in the browser
   * instead of answering — a devops broker card is decided only in Slack.
   */
  links?: { admin: string; url: string }[];
  /**
   * #1131 — the choice ids that mean approve and deny for this request. Present: it can be selected and decided
   * with others in one pass ({@link answerAdminApprovals}). Absent: it is decided one at a time only (a free question).
   */
  batch?: { approve: string; deny: string };
  /**
   * #1131 — the requester's live wait is over and the request waits in a queue until an admin decides it (the
   * devops broker sets it). The dashboard shows a 대기열 badge and no countdown.
   */
  queued?: boolean;
}

/** A request that ended recently — the card shows who answered and how. */
export interface AdminApprovalResolution {
  id: string;
  outcome: 'approved' | 'denied';
  /** The choice the answer picked. */
  choiceId?: string;
  /** Slack user id of the admin who answered. */
  by?: string;
  via?: 'slack' | 'dashboard';
  at: number;
}

export interface AdminApprovalSnapshot {
  /** Newest first. */
  pending: AdminApproval[];
  /** Ended in the last {@link RESOLVED_WINDOW_MS}, newest first. */
  resolved: AdminApprovalResolution[];
}

export type AdminApprovalAnswer =
  | { ok: true; outcome: 'approved' | 'denied' }
  | {
      ok: false;
      /** `busy`: another answer is still being carried out (a delete in flight) — retry shortly. */
      reason: 'not_found' | 'already_answered' | 'invalid' | 'forbidden' | 'busy';
      resolution?: AdminApprovalResolution;
    };

type MaybePromise<T> = T | Promise<T>;

export interface AdminApprovalAdapter {
  kind: AdminApprovalKind;
  /** Pending requests of this kind. Never answers or changes a request (a store may prune expired ones). May read asynchronously. */
  pending(now: number): MaybePromise<AdminApproval[]>;
  /** Requests of this kind that ended at or after `since`. */
  resolved(since: number): MaybePromise<AdminApprovalResolution[]>;
  /**
   * Answer one request as admin `actor` from the dashboard. The decision is
   * taken (and persisted) before this resolves; slower follow-ups (DM rewrites,
   * the requester's notice) may still be running.
   */
  answer(requestId: string, choiceId: string, actor: string): Promise<AdminApprovalAnswer>;
  /**
   * #1131 — answer several requests of this kind in one call (a store that decides them together). The answers
   * are in the same order as `items`, one per item. Absent: {@link answerAdminApprovals} calls `answer` per item.
   */
  answerMany?(items: { requestId: string; choiceId: string }[], actor: string): Promise<AdminApprovalAnswer[]>;
}

/** How long an ended request stays in the snapshot as a resolved row. */
export const RESOLVED_WINDOW_MS = 10 * 60 * 1000;

const adapters = new Map<AdminApprovalKind, AdminApprovalAdapter>();
const listeners = new Set<() => void>();

/** Register (or replace) the adapter of one kind. */
export function registerAdminApprovalAdapter(adapter: AdminApprovalAdapter): void {
  adapters.set(adapter.kind, adapter);
  notifyAdminApprovalsChanged();
}

/** Tests: drop every adapter. */
export function clearAdminApprovalAdapters(): void {
  adapters.clear();
}

export function parseAdminApprovalId(id: string): { kind: AdminApprovalKind; requestId: string } | null {
  const sep = id.indexOf(':');
  if (sep <= 0) return null;
  const kind = id.slice(0, sep) as AdminApprovalKind;
  const requestId = id.slice(sep + 1);
  if (!ADMIN_APPROVAL_KINDS.includes(kind) || !requestId) return null;
  return { kind, requestId };
}

/** Every kind's pending requests and recent resolutions. An adapter that throws (or rejects) is logged and skipped. */
export async function adminApprovalSnapshot(now: number = Date.now()): Promise<AdminApprovalSnapshot> {
  const pending: AdminApproval[] = [];
  const resolved: AdminApprovalResolution[] = [];
  const parts = await Promise.all(
    [...adapters.values()].map(async (adapter) => {
      try {
        return { pending: await adapter.pending(now), resolved: await adapter.resolved(now - RESOLVED_WINDOW_MS) };
      } catch (error) {
        logger.warn('Admin approval adapter failed to list', {
          kind: adapter.kind,
          error: error instanceof Error ? error.message : String(error),
        });
        return { pending: [], resolved: [] };
      }
    }),
  );
  for (const part of parts) {
    pending.push(...part.pending);
    resolved.push(...part.resolved);
  }
  pending.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  resolved.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
  return { pending, resolved };
}

/** Answer one request from the dashboard. Every adapter enforces its own exactly-once rule. */
export async function answerAdminApproval(id: string, choiceId: string, actor: string): Promise<AdminApprovalAnswer> {
  const parsed = parseAdminApprovalId(id);
  const adapter = parsed ? adapters.get(parsed.kind) : undefined;
  if (!parsed || !adapter) return { ok: false, reason: 'not_found' };
  const result = await adapter.answer(parsed.requestId, choiceId, actor);
  if (!result.ok && result.reason === 'already_answered' && !result.resolution) {
    const resolution = (await adapter.resolved(0)).find((r) => r.id === id);
    if (resolution) return { ...result, resolution };
  }
  notifyAdminApprovalsChanged();
  return result;
}

/** #1131 — the most items one {@link answerAdminApprovals} call decides. */
export const MAX_BATCH_ANSWERS = 50;

const FAILED: AdminApprovalAnswer = { ok: false, reason: 'invalid' };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One kind's items of a batch: their places in the input and their request ids. */
interface BatchGroup {
  adapter: AdminApprovalAdapter;
  slots: { index: number; id: string; requestId: string; choiceId: string }[];
}

async function answerGroup(group: BatchGroup, actor: string): Promise<AdminApprovalAnswer[]> {
  const { adapter, slots } = group;
  if (adapter.answerMany) {
    try {
      const answers = await adapter.answerMany(
        slots.map((s) => ({ requestId: s.requestId, choiceId: s.choiceId })),
        actor,
      );
      if (Array.isArray(answers) && answers.length === slots.length) return answers;
      logger.error('Admin approval batch: answerMany returned the wrong number of answers', {
        kind: adapter.kind,
        expected: slots.length,
        got: Array.isArray(answers) ? answers.length : typeof answers,
      });
    } catch (error) {
      logger.error('Admin approval batch: answerMany failed', { kind: adapter.kind, error: errorText(error) });
    }
    return slots.map(() => FAILED);
  }
  // One at a time, in order: an adapter's own exactly-once rule never sees two of its answers at once.
  const answers: AdminApprovalAnswer[] = [];
  for (const slot of slots) {
    try {
      answers.push(await adapter.answer(slot.requestId, slot.choiceId, actor));
    } catch (error) {
      logger.error('Admin approval batch: answer failed', { id: slot.id, error: errorText(error) });
      answers.push(FAILED);
    }
  }
  return answers;
}

/** A lost race carries the winning resolution, as {@link answerAdminApproval} does — one read per kind. */
async function withResolutions(
  adapter: AdminApprovalAdapter,
  slots: BatchGroup['slots'],
  answers: AdminApprovalAnswer[],
): Promise<AdminApprovalAnswer[]> {
  const lost = (a: AdminApprovalAnswer) => !a.ok && a.reason === 'already_answered' && !a.resolution;
  if (!answers.some(lost)) return answers;
  let resolutions: AdminApprovalResolution[] = [];
  try {
    resolutions = await adapter.resolved(0);
  } catch (error) {
    logger.warn('Admin approval batch: resolution lookup failed', { kind: adapter.kind, error: errorText(error) });
  }
  return answers.map((a, i) => {
    if (!lost(a)) return a;
    const resolution = resolutions.find((r) => r.id === slots[i].id);
    return resolution ? { ...a, resolution } : a;
  });
}

/**
 * #1131 — answer several requests in one pass from the dashboard, as admin `actor`. Items are grouped by kind (in
 * the order each kind first appears); a kind whose adapter has `answerMany` is called once with its items, any
 * other kind's `answer` once per item, in order. A kind that fails gives its own items `invalid` (logged) and
 * never costs another kind its results. The results are in the input order. Throws (and answers nothing) for an
 * empty batch, more than {@link MAX_BATCH_ANSWERS} items, a malformed item, or an id given twice.
 */
export async function answerAdminApprovals(
  items: { id: string; choiceId: string }[],
  actor: string,
): Promise<{ id: string; result: AdminApprovalAnswer }[]> {
  if (!Array.isArray(items) || items.length === 0) throw new RangeError('a batch needs at least one item');
  if (items.length > MAX_BATCH_ANSWERS) throw new RangeError(`a batch takes at most ${MAX_BATCH_ANSWERS} items`);
  const seen = new Set<string>();
  for (const item of items) {
    if (!item || typeof item.id !== 'string' || typeof item.choiceId !== 'string') {
      throw new TypeError('each item needs a string id and choiceId');
    }
    if (seen.has(item.id)) throw new RangeError(`the batch names ${item.id} twice`);
    seen.add(item.id);
  }

  const results: AdminApprovalAnswer[] = items.map(() => ({ ok: false, reason: 'not_found' }));
  const groups = new Map<AdminApprovalKind, BatchGroup>();
  items.forEach((item, index) => {
    const parsed = parseAdminApprovalId(item.id);
    const adapter = parsed ? adapters.get(parsed.kind) : undefined;
    if (!parsed || !adapter) return;
    let group = groups.get(parsed.kind);
    if (!group) {
      group = { adapter, slots: [] };
      groups.set(parsed.kind, group);
    }
    group.slots.push({ index, id: item.id, requestId: parsed.requestId, choiceId: item.choiceId });
  });

  for (const group of groups.values()) {
    const answers = await withResolutions(group.adapter, group.slots, await answerGroup(group, actor));
    group.slots.forEach((slot, i) => {
      results[slot.index] = answers[i];
    });
  }
  notifyAdminApprovalsChanged();
  return items.map((item, i) => ({ id: item.id, result: results[i] }));
}

/** Subscribe to "the requests changed" (an answer here, or a store change the watch saw). */
export function onAdminApprovalsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyAdminApprovalsChanged(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      logger.warn('Admin approval listener failed', error);
    }
  }
}

let watchTimer: ReturnType<typeof setInterval> | null = null;
let lastSignature: string | null = null;
let watchBusy = false;

/**
 * Re-read every kind each `intervalMs` and notify when anything changed. The
 * stores are written from other paths (a Slack click, an MCP child process),
 * so the watch is what makes a request appear on, or leave, the dashboard.
 */
export function startAdminApprovalWatch(intervalMs = 1000): void {
  stopAdminApprovalWatch();
  lastSignature = null;
  const tick = async () => {
    // A slow read (a file store) never overlaps the next tick.
    if (watchBusy) return;
    watchBusy = true;
    try {
      const signature = JSON.stringify(await adminApprovalSnapshot());
      const first = lastSignature === null;
      if (signature === lastSignature) return;
      lastSignature = signature;
      if (!first) notifyAdminApprovalsChanged();
    } catch (error) {
      logger.warn('Admin approval watch tick failed', error);
    } finally {
      watchBusy = false;
    }
  };
  void tick();
  watchTimer = setInterval(() => void tick(), intervalMs);
  watchTimer.unref?.();
}

export function stopAdminApprovalWatch(): void {
  if (watchTimer) clearInterval(watchTimer);
  watchTimer = null;
}
