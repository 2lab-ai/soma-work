/**
 * Server-side pending permission-request store.
 *
 * When A tries to use B's skill without permission, a request is recorded here
 * and a prompt with 3 buttons is posted to B. The buttons carry ONLY the
 * `requestId`; the authoritative request data is read back from this store so a
 * forged/replayed button payload can't fabricate a grant (codex review).
 *
 * Persisted (a click may arrive minutes later, possibly after a restart) to
 * `DATA_DIR/skill-perm-requests.json`, keyed by requestId. Requests dedupe by
 * (owner, skill, requester, operation) while unhandled+unexpired, and are
 * marked `handled` once a grant is processed to prevent replay.
 *
 * Environment-skill requests (owner {@link ENV_SKILL_GRANT_OWNER}, approved by
 * any admin) share the store. They dedupe per thread as well, since an admin's
 * "1회" grant and the re-dispatch both belong to the asking thread, and they
 * record where each admin's prompt was posted so the handler can close them all.
 */
import { randomUUID } from 'node:crypto';
import { atomicWriteJson } from '@soma/common/atomic-json';
import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from './env-paths';
import { Logger } from './logger';
import { ENV_SKILL_GRANT_OWNER } from './user-skill-grants-store';

const logger = new Logger('SkillPermissionRequestStore');

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/** Which cross-user operation A is asking B to permit. */
export type PermissionOperation = 'invoke' | 'view' | 'copy';

export interface PermissionRequest {
  requestId: string;
  operation: PermissionOperation;
  requesterId: string; // A
  ownerId: string; // B
  skillName: string;
  channel: string;
  threadTs?: string;
  /** Original message text — replayed via messageHandler to fulfill `invoke`. */
  originalText?: string;
  /** Environment-skill requests: the admin prompts posted for this request (one per admin DM). */
  prompts?: PromptRef[];
  /** How the request was answered (set with `handled`): who, which choice, from where. */
  resolution?: RequestResolution;
  createdAt: number;
  expiresAt: number;
  handled: boolean;
}

/** How a handled request was answered. */
export interface RequestResolution {
  /** Slack user id of whoever answered. */
  by: string;
  /** The button / choice the answer picked. */
  choiceId: string;
  outcome: 'approved' | 'denied';
  via: 'slack' | 'dashboard';
  at: number;
}

/** Where one permission prompt was posted. */
export interface PromptRef {
  channel: string;
  ts: string;
}

/** A request as `createPermissionRequest` returns it: `reused` = an identical unhandled ask already existed. */
export type CreatedPermissionRequest = PermissionRequest & { reused: boolean };

export interface CreatePermissionRequestInput {
  operation: PermissionOperation;
  requesterId: string;
  ownerId: string;
  skillName: string;
  channel: string;
  threadTs?: string;
  originalText?: string;
  /** Override TTL (tests). */
  ttlMs?: number;
}

function storeFile(): string {
  return path.join(DATA_DIR, 'skill-perm-requests.json');
}

function loadAll(): Record<string, PermissionRequest> {
  const file = storeFile();
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, PermissionRequest>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveAll(all: Record<string, PermissionRequest>): void {
  atomicWriteJson(storeFile(), all);
}

function isLive(req: PermissionRequest, now: number): boolean {
  return req.expiresAt > now;
}

/** Drop expired entries; returns the pruned map (caller decides whether to save). */
function prune(
  all: Record<string, PermissionRequest>,
  now: number,
): { map: Record<string, PermissionRequest>; changed: boolean } {
  let changed = false;
  for (const [id, req] of Object.entries(all)) {
    if (!isLive(req, now)) {
      delete all[id];
      changed = true;
    }
  }
  return { map: all, changed };
}

/**
 * Create (or reuse) a pending request. Dedupes against an existing unhandled,
 * unexpired request for the same (owner, skill, requester, operation) so a
 * re-dispatch after a partial grant doesn't re-prompt B. Environment-skill
 * requests also match on (channel, thread).
 */
export function createPermissionRequest(input: CreatePermissionRequestInput): CreatedPermissionRequest {
  const now = Date.now();
  const all = loadAll();
  prune(all, now);

  for (const req of Object.values(all)) {
    if (
      !req.handled &&
      isLive(req, now) &&
      req.ownerId === input.ownerId &&
      req.requesterId === input.requesterId &&
      req.skillName === input.skillName &&
      req.operation === input.operation &&
      (input.ownerId !== ENV_SKILL_GRANT_OWNER || (req.channel === input.channel && req.threadTs === input.threadTs))
    ) {
      saveAll(all); // persist any pruning
      return { ...req, reused: true };
    }
  }

  const req: PermissionRequest = {
    requestId: randomUUID(),
    operation: input.operation,
    requesterId: input.requesterId,
    ownerId: input.ownerId,
    skillName: input.skillName,
    channel: input.channel,
    threadTs: input.threadTs,
    originalText: input.originalText,
    createdAt: now,
    expiresAt: now + (input.ttlMs ?? DEFAULT_TTL_MS),
    handled: false,
  };
  all[req.requestId] = req;
  saveAll(all);
  logger.info('Created permission request', {
    requestId: req.requestId,
    operation: req.operation,
    ownerId: req.ownerId,
    requesterId: req.requesterId,
    skillName: req.skillName,
  });
  return { ...req, reused: false };
}

/** Read a request by id, or null when missing/expired. */
export function getPermissionRequest(requestId: string): PermissionRequest | null {
  const now = Date.now();
  const all = loadAll();
  const req = all[requestId];
  if (!req || !isLive(req, now)) return null;
  return req;
}

/** Mark a request handled (replay guard), with how it was answered when known. No-op if missing. */
export function markRequestHandled(requestId: string, resolution?: RequestResolution): void {
  const all = loadAll();
  const req = all[requestId];
  if (!req) return;
  req.handled = true;
  if (resolution) req.resolution = resolution;
  saveAll(all);
}

/** Every live request (handled ones included) — read only, for the dashboard's admin approvals. */
export function listPermissionRequests(): PermissionRequest[] {
  const now = Date.now();
  return Object.values(loadAll()).filter((req) => isLive(req, now));
}

/** Record where the prompts of a request were posted (environment-skill admin DMs). No-op if missing. */
export function setRequestPrompts(requestId: string, prompts: PromptRef[]): PermissionRequest | null {
  const all = loadAll();
  const req = all[requestId];
  if (!req) return null;
  req.prompts = prompts;
  saveAll(all);
  return req;
}
