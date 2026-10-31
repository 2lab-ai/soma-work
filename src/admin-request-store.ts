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

import { atomicWriteJson } from '@soma/common/atomic-json';
import * as fs from 'fs';
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

function storeFile(): string {
  return path.join(DATA_DIR, 'admin-requests.json');
}

function keyOf(kind: AdminRequestKind, requestId: string): string {
  return `${kind}:${requestId}`;
}

function loadAll(): Record<string, AdminRequest> {
  const file = storeFile();
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, AdminRequest>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    logger.warn('admin-requests.json unreadable — starting empty', error);
    return {};
  }
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
}

/** Start a round for this key: no prompts yet, unanswered. Replaces an earlier round of the same key. */
export function openAdminRequest(input: OpenAdminRequestInput): AdminRequest {
  const now = input.now ?? Date.now();
  const all = loadAll();
  pruneInto(all, now);
  const req: AdminRequest = {
    kind: input.kind,
    requestId: input.requestId,
    requesterId: input.requesterId,
    data: { ...(input.data ?? {}) },
    prompts: [],
    handled: false,
    createdAt: now,
    expiresAt: now + input.ttlMs,
  };
  all[keyOf(input.kind, input.requestId)] = req;
  saveAll(all);
  return req;
}

export function getAdminRequest(
  kind: AdminRequestKind,
  requestId: string,
  now: number = Date.now(),
): AdminRequest | null {
  const req = loadAll()[keyOf(kind, requestId)];
  return req && req.expiresAt > now ? req : null;
}

/** Live requests of one kind (answered ones included until they age out). */
export function listAdminRequests(kind: AdminRequestKind, now: number = Date.now()): AdminRequest[] {
  return Object.values(loadAll()).filter((r) => r.kind === kind && r.expiresAt > now);
}

/**
 * Record where the prompts landed. Returns the request as stored — when it is
 * already handled (answered while the DMs were going out), the caller closes
 * these prompts itself: the answer could not reach them.
 */
export function setAdminRequestPrompts(
  kind: AdminRequestKind,
  requestId: string,
  prompts: AdminRequestPrompt[],
): AdminRequest | null {
  const all = loadAll();
  const req = all[keyOf(kind, requestId)];
  if (!req) return null;
  req.prompts = [...prompts];
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
  let req = all[key];
  if (req && req.expiresAt <= resolution.at) req = undefined as unknown as AdminRequest;
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
  req.expiresAt = Math.max(req.expiresAt, resolution.at + HANDLED_KEEP_MS);
  all[key] = req;
  saveAll(all);
  return req;
}

/** Undo {@link markAdminRequest} — only when the answer's side effect failed and nothing happened. */
export function reopenAdminRequest(kind: AdminRequestKind, requestId: string): void {
  const all = loadAll();
  const req = all[keyOf(kind, requestId)];
  if (!req) return;
  req.handled = false;
  delete req.resolution;
  saveAll(all);
}
