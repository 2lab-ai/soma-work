/**
 * Server-side pending `cron run` permission-request store.
 *
 * When A asks to fire B's cron job on demand, the request is recorded here and
 * a 3-button prompt is DM'd to B. The buttons carry ONLY the `requestId`; the
 * authoritative request data is read back from this store, so a forged or
 * replayed button payload cannot fabricate a grant (same threat model as
 * `skill-permission-request-store`).
 *
 * Persisted (a click may arrive minutes later, possibly after a restart) to
 * `DATA_DIR/cron-run-requests.json`, keyed by requestId. Requests dedupe by
 * (owner, jobName, requester) while unhandled + unexpired, and are marked
 * `handled` once a grant/denial is processed to prevent replay.
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from './env-paths';
import { Logger } from './logger';

const logger = new Logger('CronRunRequestStore');

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export interface CronRunRequest {
  requestId: string;
  /** A — the user who asked to fire the job. */
  requesterId: string;
  /** B — the cron job owner, the only user who may grant. */
  ownerId: string;
  /**
   * Immutable job id. Consent belongs to the JOB: the owner may rename it (or
   * create a new job reusing the name) between the ask and the click, and the
   * approval must still land on the job they were asked about.
   */
  jobId: string;
  /** Name at ask time — display only; never the authority for resolution. */
  jobName: string;
  /** Where A asked from — the run result is reported back there. */
  channel: string;
  threadTs?: string;
  createdAt: number;
  expiresAt: number;
  handled: boolean;
}

export interface CreateCronRunRequestInput {
  requesterId: string;
  ownerId: string;
  jobId: string;
  jobName: string;
  channel: string;
  threadTs?: string;
  /** Override TTL (tests). */
  ttlMs?: number;
}

function storeFile(): string {
  return path.join(DATA_DIR, 'cron-run-requests.json');
}

function loadAll(): Record<string, CronRunRequest> {
  const file = storeFile();
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, CronRunRequest>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveAll(all: Record<string, CronRunRequest>): void {
  const file = storeFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(all, null, 2), 'utf-8');
}

function isLive(req: CronRunRequest, now: number): boolean {
  return req.expiresAt > now;
}

/** Drop expired entries in place. */
function prune(all: Record<string, CronRunRequest>, now: number): void {
  for (const [id, req] of Object.entries(all)) {
    if (!isLive(req, now)) delete all[id];
  }
}

/**
 * Create (or reuse) a pending request for (owner, jobName, requester).
 *
 * `reused: true` means an unhandled, unexpired ask already exists — the caller
 * MUST NOT deliver a second prompt, otherwise `cron run` in a loop becomes a
 * DM-bombing tool aimed at the owner. The reused request's channel/threadTs are
 * refreshed to the latest ask so the result is reported where the requester is
 * actually waiting, not in the room they asked from hours ago.
 */
export function createCronRunRequest(input: CreateCronRunRequestInput): CronRunRequest & { reused: boolean } {
  const now = Date.now();
  const all = loadAll();
  prune(all, now);

  for (const req of Object.values(all)) {
    if (
      !req.handled &&
      isLive(req, now) &&
      req.ownerId === input.ownerId &&
      req.requesterId === input.requesterId &&
      req.jobId === input.jobId
    ) {
      req.channel = input.channel;
      req.threadTs = input.threadTs;
      saveAll(all);
      return { ...req, reused: true };
    }
  }

  const req: CronRunRequest = {
    requestId: randomUUID(),
    requesterId: input.requesterId,
    ownerId: input.ownerId,
    jobId: input.jobId,
    jobName: input.jobName,
    channel: input.channel,
    threadTs: input.threadTs,
    createdAt: now,
    expiresAt: now + (input.ttlMs ?? DEFAULT_TTL_MS),
    handled: false,
  };
  all[req.requestId] = req;
  saveAll(all);
  logger.info('Created cron run request', {
    requestId: req.requestId,
    ownerId: req.ownerId,
    requesterId: req.requesterId,
    jobName: req.jobName,
  });
  return { ...req, reused: false };
}

/** Read a request by id, or null when missing/expired. */
export function getCronRunRequest(requestId: string): CronRunRequest | null {
  const now = Date.now();
  const req = loadAll()[requestId];
  if (!req || !isLive(req, now)) return null;
  return req;
}

/** Mark a request handled (replay guard). No-op if missing. */
export function markCronRunRequestHandled(requestId: string): void {
  const all = loadAll();
  const req = all[requestId];
  if (!req) return;
  req.handled = true;
  saveAll(all);
}
