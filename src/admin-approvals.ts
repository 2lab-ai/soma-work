/**
 * Admin approvals — the requests that reach the admins by Slack DM (an
 * environment skill run, an MCP tool grant, a new user, a bot-message
 * delete), shown to admins signed in to the dashboard as approval cards and
 * answerable there. An answer on either surface resolves both: the dashboard
 * answer runs the same decision the Slack button runs, which rewrites every
 * admin's DM; a Slack answer drops the card from the dashboard.
 *
 * This module is the registry only. It holds no pending state of its own:
 * each kind registers an adapter that reads its existing request store and
 * answers through the kind's existing decision path.
 */

import { Logger } from './logger';

const logger = new Logger('AdminApprovals');

export type AdminApprovalKind = 'env_skill' | 'mcp_grant' | 'new_user' | 'bot_delete';

export const ADMIN_APPROVAL_KINDS: readonly AdminApprovalKind[] = ['env_skill', 'mcp_grant', 'new_user', 'bot_delete'];

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
  description?: string;
  /** `permission` cards: the tool name the card's icon reads (for example `mcp__github`). */
  tool?: string;
  /** `permission` cards: labelled rows shown as the request's input. */
  rows?: Record<string, string>;
  risk?: 'low' | 'medium' | 'high';
  choices?: AdminApprovalChoice[];
  recommendedId?: string;
  /** Slack user id of whoever asked. */
  requesterId: string;
  /** Where the request was made (env skill / MCP grant). */
  place?: { channel: string; threadTs?: string };
  createdAt: number;
  expiresAt?: number;
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
      reason: 'not_found' | 'already_answered' | 'invalid' | 'forbidden';
      resolution?: AdminApprovalResolution;
    };

type MaybePromise<T> = T | Promise<T>;

export interface AdminApprovalAdapter {
  kind: AdminApprovalKind;
  /** Pending requests of this kind. Reads only — never writes the store. May read asynchronously (a file store). */
  pending(now: number): MaybePromise<AdminApproval[]>;
  /** Requests of this kind that ended at or after `since`. */
  resolved(since: number): MaybePromise<AdminApprovalResolution[]>;
  /**
   * Answer one request as admin `actor` from the dashboard. The decision is
   * taken (and persisted) before this resolves; slower follow-ups (DM rewrites,
   * the requester's notice) may still be running.
   */
  answer(requestId: string, choiceId: string, actor: string): Promise<AdminApprovalAnswer>;
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
