/**
 * Admin requests without a store of their own (#622 new user, #623 bot-message
 * delete): where each admin's DM prompt landed and how the request ended, so an
 * answer from either surface (a Slack button, the dashboard) can rewrite every
 * copy, refuse a second answer, and show who answered.
 *
 * Persisted to `DATA_DIR/admin-requests.json` (a click may come after a
 * restart), keyed `<kind>:<requestId>`. Opening a request again for the same
 * key starts a fresh round (a denied user who asks again). Writes are
 * synchronous: a check-and-mark in one process cannot interleave.
 */

import { atomicWriteJson, readJsonWithBackup } from '@soma/common/atomic-json';
import * as path from 'path';
import { DATA_DIR } from './env-paths';
import { Logger } from './logger';

const logger = new Logger('AdminRequestStore');

export type AdminRequestKind = 'new_user' | 'bot_delete';

export interface AdminRequestPrompt {
  channel: string;
  ts: string;
}

export interface AdminRequestResolution {
  /** Slack user id of the admin who answered. */
  by: string;
  choiceId: string;
  outcome: 'approved' | 'denied';
  via: 'slack' | 'dashboard';
  at: number;
  /**
   * `false` while the answer's side effect is still running (a bot-message
   * delete): the request is claimed, not yet decided. Absent = settled.
   */
  settled?: boolean;
}

export interface AdminRequest {
  kind: AdminRequestKind;
  requestId: string;
  requesterId: string;
  /** Kind-specific fields (strings only). */
  data: Record<string, string>;
  prompts: AdminRequestPrompt[];
  handled: boolean;
  resolution?: AdminRequestResolution;
  createdAt: number;
  expiresAt: number;
}

/** A handled request stays this long (the dashboard's resolved row, a late click's "already answered"). */
const HANDLED_KEEP_MS = 24 * 60 * 60 * 1000;

/**
 * Claims whose side effect is running in this process right now. Every answer
 * runs in the main process, so a claim held here is being carried out; an
 * unsettled claim NOT in this set was left by a process that died — its side
 * effect may or may not have happened, so it is an orphan to reconcile (redo
 * the side effect), never an unanswered request.
 */
const liveClaims = new Set<string>();

/** Whether this process is carrying out the claim on this request right now. */
export function isClaimLive(kind: AdminRequestKind, requestId: string): boolean {
  return liveClaims.has(keyOf(kind, requestId));
}

/** Take over an orphaned claim (a dead process's) to carry it out here. False if it is live already. */
export function adoptOrphanedClaim(kind: AdminRequestKind, requestId: string): boolean {
  const key = keyOf(kind, requestId);
  if (liveClaims.has(key)) return false;
  liveClaims.add(key);
  return true;
}

/**
 * Stop carrying out a claim here without deciding it: its side effect's
 * outcome is unknown, so it stays claimed (an orphan) for a redo.
 */
export function releaseLiveClaim(kind: AdminRequestKind, requestId: string): void {
  liveClaims.delete(keyOf(kind, requestId));
}

/** The request as it stands at `now` (expired → null). */
function current(req: AdminRequest | undefined, now: number): AdminRequest | null {
  if (!req || req.expiresAt <= now) return null;
  return req;
}

function storeFile(): string {
  return path.join(DATA_DIR, 'admin-requests.json');
}

function keyOf(kind: AdminRequestKind, requestId: string): string {
  return `${kind}:${requestId}`;
}

function validateAll(raw: unknown): Record<string, AdminRequest> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object');
  const out: Record<string, AdminRequest> = {};
  for (const [key, r] of Object.entries(raw as Record<string, AdminRequest>)) {
    if (r && typeof r.requestId === 'string' && typeof r.kind === 'string' && Array.isArray(r.prompts)) out[key] = r;
  }
  return out;
}

/**
 * The store as it is now. A damaged live file falls back to its `.bak`; when
 * neither is usable this throws — forgetting which requests were answered
 * would let a stale button act again.
 */
function loadAll(): Record<string, AdminRequest> {
  return (
    readJsonWithBackup(storeFile(), validateAll, { warn: (message) => logger.warn(message) }) ??
    ({} as Record<string, AdminRequest>)
  );
}

function saveAll(all: Record<string, AdminRequest>): void {
  atomicWriteJson(storeFile(), all);
}

function pruneInto(all: Record<string, AdminRequest>, now: number): boolean {
  let changed = false;
  for (const [key, req] of Object.entries(all)) {
    if (req.expiresAt <= now) {
      delete all[key];
      changed = true;
    }
  }
  return changed;
}

export interface OpenAdminRequestInput {
  kind: AdminRequestKind;
  requestId: string;
  requesterId: string;
  data?: Record<string, string>;
  ttlMs: number;
  now?: number;
  /** An answered round this returns true for is kept, not replaced (e.g. an approved delete). */
  keepAnswered?: (round: AdminRequest) => boolean;
  /**
   * Always start a new round, even over an unanswered one (a new user's fresh
   * ask: an earlier round's buttons must not decide it). Its `createdAt` is
   * strictly later than the round it replaces.
   */
  fresh?: boolean;
}

/**
 * Start a round for this key. An unanswered round of the same key is kept (its
 * DM copies stay on record and are rewritten with the answer); an answered one
 * is replaced by a fresh round (a denied user who asks again) unless
 * `keepAnswered` keeps it — the caller then sees `handled` and asks no one.
 */
export function openAdminRequest(input: OpenAdminRequestInput): AdminRequest {
  const now = input.now ?? Date.now();
  const all = loadAll();
  pruneInto(all, now);
  const key = keyOf(input.kind, input.requestId);
  const open = current(all[key], now);
  if (open?.handled && input.keepAnswered?.(open)) return open;
  if (open && !open.handled && !input.fresh) {
    open.data = { ...open.data, ...(input.data ?? {}) };
    open.expiresAt = Math.max(open.expiresAt, now + input.ttlMs);
    all[key] = open;
    saveAll(all);
    return open;
  }
  const req: AdminRequest = {
    kind: input.kind,
    requestId: input.requestId,
    requesterId: input.requesterId,
    data: { ...(input.data ?? {}) },
    prompts: [],
    handled: false,
    // Strictly after any earlier round of this key: a round id is never reused.
    createdAt: Math.max(now, (all[key]?.createdAt ?? 0) + 1),
    expiresAt: now + input.ttlMs,
  };
  all[key] = req;
  saveAll(all);
  return req;
}

export function getAdminRequest(
  kind: AdminRequestKind,
  requestId: string,
  now: number = Date.now(),
): AdminRequest | null {
  return current(loadAll()[keyOf(kind, requestId)], now);
}

/** Live requests of one kind (answered ones included until they age out). */
export function listAdminRequests(kind: AdminRequestKind, now: number = Date.now()): AdminRequest[] {
  return Object.values(loadAll())
    .filter((r) => r.kind === kind)
    .map((r) => current(r, now))
    .filter((r): r is AdminRequest => r !== null);
}

/** Unsettled claims nobody in this process is carrying out (left by a process that died). */
export function listOrphanedClaims(kind: AdminRequestKind, now: number = Date.now()): AdminRequest[] {
  return listAdminRequests(kind, now).filter(
    (r) => r.handled && r.resolution?.settled === false && !liveClaims.has(keyOf(kind, r.requestId)),
  );
}

/**
 * Record where (more) prompts landed — added to the copies already on record.
 * Returns the request as stored — when it is already handled (answered while
 * the DMs were going out), the caller closes these prompts itself: the answer
 * could not reach them.
 */
export function setAdminRequestPrompts(
  kind: AdminRequestKind,
  requestId: string,
  prompts: AdminRequestPrompt[],
): AdminRequest | null {
  const all = loadAll();
  const req = all[keyOf(kind, requestId)];
  if (!req) return null;
  const known = new Set(req.prompts.map((p) => `${p.channel}/${p.ts}`));
  req.prompts = [...req.prompts, ...prompts.filter((p) => !known.has(`${p.channel}/${p.ts}`))];
  saveAll(all);
  return req;
}

/**
 * Mark a request answered — exactly once. `null` when it was already answered
 * (or does not exist and `create` is not given). `create` records a request the
 * store never saw (a prompt sent before this store existed), so even that one
 * is answered only once.
 */
export function markAdminRequest(
  kind: AdminRequestKind,
  requestId: string,
  resolution: AdminRequestResolution,
  create?: { requesterId: string; data?: Record<string, string> },
): AdminRequest | null {
  const all = loadAll();
  const key = keyOf(kind, requestId);
  let req = current(all[key], resolution.at) ?? undefined;
  if (!req) {
    if (!create) return null;
    req = {
      kind,
      requestId,
      requesterId: create.requesterId,
      data: { ...(create.data ?? {}) },
      prompts: [],
      handled: false,
      createdAt: resolution.at,
      expiresAt: resolution.at + HANDLED_KEEP_MS,
    };
  }
  if (req.handled) return null;
  req.handled = true;
  req.resolution = resolution;
  if (resolution.settled === false) liveClaims.add(key);
  req.expiresAt = Math.max(req.expiresAt, resolution.at + HANDLED_KEEP_MS);
  all[key] = req;
  saveAll(all);
  return req;
}

/**
 * The claimed answer's side effect succeeded: it is now the decision. Only if
 * that answer is still the one on record. Returns the settled request.
 */
export function settleAdminRequest(
  kind: AdminRequestKind,
  requestId: string,
  answered: AdminRequestResolution,
): AdminRequest | null {
  const all = loadAll();
  const req = all[keyOf(kind, requestId)];
  const r = req?.resolution;
  liveClaims.delete(keyOf(kind, requestId));
  if (!req || !req.handled || !r || r.at !== answered.at || r.by !== answered.by || r.via !== answered.via) return null;
  delete r.settled;
  saveAll(all);
  return req;
}

/**
 * Undo {@link markAdminRequest} — only when the answer's side effect failed and
 * nothing happened, and only if that answer is still the one on record (a
 * later round, or its answer, is never erased). Returns whether it reopened.
 */
export function reopenAdminRequest(
  kind: AdminRequestKind,
  requestId: string,
  answered: AdminRequestResolution,
): boolean {
  const all = loadAll();
  const req = all[keyOf(kind, requestId)];
  const r = req?.resolution;
  liveClaims.delete(keyOf(kind, requestId));
  if (!req || !req.handled || !r || r.at !== answered.at || r.by !== answered.by || r.via !== answered.via)
    return false;
  req.handled = false;
  delete req.resolution;
  saveAll(all);
  return true;
}
