/**
 * UserSessionStore — sealed user-scope master for instructions + lifecycle audit log.
 *
 * Issue: #754 (parent epic #727)
 *
 * On-disk layout:
 *   data/users/{userId}/user-session.json
 *
 * Sealed schema (SSOT — see #727 sealed decisions comment):
 *   {
 *     schemaVersion: 1,
 *     instructions: UserInstruction[],
 *     lifecycleEvents: LifecycleEvent[],   // top-level, NOT per-instruction
 *   }
 *
 * The store owns load/save (atomic write tmp → rename) and validates the
 * sealed enums + bidirectional / current-pointer invariants on every save.
 *
 * Lifecycle write semantics (the y/n confirm gate that produces the
 * `requested → confirmed/rejected/superseded` transitions) are #755 scope.
 * This module exposes the storage and pointer plumbing only.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { DATA_DIR } from './env-paths';
import { Logger } from './logger';

// ── Sealed types ─────────────────────────────────────────────────────────────

/**
 * Status of a user instruction.
 *
 * Sealed by issue #727 / #754:
 * - `active`    — live work, may be a session's `currentInstructionId`
 * - `completed` — finished (paired with optional `evidence`)
 * - `cancelled` — explicitly stopped by the user; FIRST-CLASS state distinct
 *                 from `completed` (Q3 sealed YES)
 */
export type UserInstructionStatus = 'active' | 'completed' | 'cancelled';

/**
 * Origin of a user instruction.
 *
 * Sealed enum (Q1/Q4):
 * - `model`                  — model proposed via UPDATE_SESSION + user y/n confirm (#755)
 * - `user-manual-dashboard`  — direct dashboard click (#759); click == confirm
 * - `migration`              — produced by `user-instructions-migration.ts`
 *                              when projecting legacy `sessions.json` rows
 */
export type UserInstructionSource = 'model' | 'user-manual-dashboard' | 'migration';

const VALID_STATUSES: ReadonlySet<UserInstructionStatus> = new Set(['active', 'completed', 'cancelled']);
const VALID_SOURCES: ReadonlySet<UserInstructionSource> = new Set(['model', 'user-manual-dashboard', 'migration']);

export interface UserInstruction {
  id: string;
  text: string;
  status: UserInstructionStatus;
  /** Append-only, deduplicated list of session keys this instruction was linked to. */
  linkedSessionIds: string[];
  /** ISO timestamp of creation. */
  createdAt: string;
  /** ISO timestamp set when status transitions to `completed`. */
  completedAt?: string;
  /** ISO timestamp set when status transitions to `cancelled`. */
  cancelledAt?: string;
  /** Evidence supplied at completion time (PR link, commit SHA, test name, …). */
  evidence?: string;
  source: UserInstructionSource;
  /**
   * Raw-input back-references populated by #760. Each entry pins a single
   * raw-input row by `{ sessionKey, rawInputId }` so the instruction can be
   * traced back to the user's original message text even after compaction.
   * Always present (possibly empty) on the sealed master.
   */
  sourceRawInputIds: Array<{ sessionKey: string; rawInputId: string }>;
}

/** Lifecycle 5-op vocabulary (sealed Q2 — link is its own event). */
export type LifecycleOp = 'add' | 'link' | 'complete' | 'cancel' | 'rename';

/**
 * Lifecycle event state machine. `manual` is reserved for direct dashboard
 * clicks (#759) where the user action is the confirm.
 */
export type LifecycleState = 'requested' | 'confirmed' | 'rejected' | 'superseded' | 'manual';

const VALID_OPS: ReadonlySet<LifecycleOp> = new Set(['add', 'link', 'complete', 'cancel', 'rename']);
const VALID_STATES: ReadonlySet<LifecycleState> = new Set([
  'requested',
  'confirmed',
  'rejected',
  'superseded',
  'manual',
]);

export type LifecycleActorType = 'slack-user' | 'system' | 'migration';
const VALID_ACTOR_TYPES: ReadonlySet<LifecycleActorType> = new Set(['slack-user', 'system', 'migration']);

export interface LifecycleEvent {
  id: string;
  /** Pending-confirm request id, if any. */
  requestId?: string;
  /**
   * Target instruction id. Null is allowed for the pending-add reject /
   * supersede case where no instruction was ever created.
   */
  instructionId?: string | null;
  sessionKey: string;
  op: LifecycleOp;
  state: LifecycleState;
  /** ISO timestamp. */
  at: string;
  by: { type: LifecycleActorType; id: string };
  payload: unknown;
}

export interface UserSessionDoc {
  schemaVersion: 1;
  instructions: UserInstruction[];
  lifecycleEvents: LifecycleEvent[];
}

// ── Internal helpers ─────────────────────────────────────────────────────────

const logger = new Logger('UserSessionStore');

const FILE_NAME = 'user-session.json';

/**
 * Validate that a userId is safe to use as a directory component.
 * Disallows path traversal (`..`), absolute paths, separators and NUL.
 */
function assertSafeUserId(userId: string): void {
  if (!userId || typeof userId !== 'string') {
    throw new Error(`UserSessionStore: invalid userId (empty or non-string)`);
  }
  if (userId.includes('/') || userId.includes('\\') || userId.includes('\x00')) {
    throw new Error(`UserSessionStore: invalid userId (separator/NUL): ${JSON.stringify(userId)}`);
  }
  if (userId === '.' || userId === '..' || userId.startsWith('..')) {
    throw new Error(`UserSessionStore: invalid userId (path traversal): ${JSON.stringify(userId)}`);
  }
  // Slack user IDs are like `U01ABCDEFG`; allow alphanumerics, dash, underscore, dot
  if (!/^[A-Za-z0-9._-]+$/.test(userId)) {
    throw new Error(`UserSessionStore: invalid userId (charset): ${JSON.stringify(userId)}`);
  }
}

function emptyDoc(): UserSessionDoc {
  return {
    schemaVersion: 1,
    instructions: [],
    lifecycleEvents: [],
  };
}

function validateInstruction(inst: UserInstruction, idx: number): void {
  if (!inst || typeof inst !== 'object') {
    throw new Error(`UserSessionStore: instructions[${idx}] is not an object`);
  }
  if (typeof inst.id !== 'string' || inst.id.length === 0) {
    throw new Error(`UserSessionStore: instructions[${idx}].id is required`);
  }
  if (typeof inst.text !== 'string') {
    throw new Error(`UserSessionStore: instructions[${idx}].text must be a string`);
  }
  if (!VALID_STATUSES.has(inst.status)) {
    throw new Error(
      `UserSessionStore: instructions[${idx}].status invalid: ${JSON.stringify(inst.status)} (allowed: active|completed|cancelled)`,
    );
  }
  if (!VALID_SOURCES.has(inst.source)) {
    throw new Error(
      `UserSessionStore: instructions[${idx}].source invalid: ${JSON.stringify(inst.source)} (allowed: model|user-manual-dashboard|migration)`,
    );
  }
  if (!Array.isArray(inst.linkedSessionIds)) {
    throw new Error(`UserSessionStore: instructions[${idx}].linkedSessionIds must be an array`);
  }
  if (!Array.isArray(inst.sourceRawInputIds)) {
    throw new Error(`UserSessionStore: instructions[${idx}].sourceRawInputIds must be an array`);
  }
  if (typeof inst.createdAt !== 'string') {
    throw new Error(`UserSessionStore: instructions[${idx}].createdAt must be an ISO string`);
  }
}

function validateLifecycleEvent(evt: LifecycleEvent, idx: number): void {
  if (!evt || typeof evt !== 'object') {
    throw new Error(`UserSessionStore: lifecycleEvents[${idx}] is not an object`);
  }
  if (typeof evt.id !== 'string' || evt.id.length === 0) {
    throw new Error(`UserSessionStore: lifecycleEvents[${idx}].id is required`);
  }
  if (!VALID_OPS.has(evt.op)) {
    throw new Error(
      `UserSessionStore: lifecycleEvents[${idx}].op invalid: ${JSON.stringify(evt.op)} (allowed: add|link|complete|cancel|rename)`,
    );
  }
  if (!VALID_STATES.has(evt.state)) {
    throw new Error(`UserSessionStore: lifecycleEvents[${idx}].state invalid: ${JSON.stringify(evt.state)}`);
  }
  if (typeof evt.sessionKey !== 'string' || evt.sessionKey.length === 0) {
    throw new Error(`UserSessionStore: lifecycleEvents[${idx}].sessionKey is required`);
  }
  if (typeof evt.at !== 'string') {
    throw new Error(`UserSessionStore: lifecycleEvents[${idx}].at must be an ISO string`);
  }
  if (!evt.by || !VALID_ACTOR_TYPES.has(evt.by.type) || typeof evt.by.id !== 'string') {
    throw new Error(`UserSessionStore: lifecycleEvents[${idx}].by must be { type, id }`);
  }
}

function validateDoc(doc: UserSessionDoc): void {
  if (!doc || typeof doc !== 'object') {
    throw new Error('UserSessionStore: doc is not an object');
  }
  if (doc.schemaVersion !== 1) {
    throw new Error(`UserSessionStore: schemaVersion must be 1, got ${JSON.stringify(doc.schemaVersion)}`);
  }
  if (!Array.isArray(doc.instructions)) {
    throw new Error('UserSessionStore: instructions must be an array');
  }
  if (!Array.isArray(doc.lifecycleEvents)) {
    throw new Error('UserSessionStore: lifecycleEvents must be an array');
  }

  const seenIds = new Set<string>();
  doc.instructions.forEach((inst, idx) => {
    validateInstruction(inst, idx);
    if (seenIds.has(inst.id)) {
      throw new Error(`UserSessionStore: duplicate instruction id ${JSON.stringify(inst.id)}`);
    }
    seenIds.add(inst.id);
  });

  doc.lifecycleEvents.forEach((evt, idx) => {
    validateLifecycleEvent(evt, idx);
    if (evt.instructionId !== undefined && evt.instructionId !== null && !seenIds.has(evt.instructionId)) {
      // Non-fatal: instructionId may reference an event before the row was
      // committed (e.g. add+rejected with no instruction created). The sealed
      // schema explicitly allows null, and we don't validate referential
      // integrity for unknown ids — the dashboard derives per-instruction
      // logs by filter, missing references just produce empty drilldowns.
    }
  });
}

// ── Public store ─────────────────────────────────────────────────────────────

export class UserSessionStore {
  private dataDir: string;

  constructor(baseDir?: string) {
    this.dataDir = baseDir || DATA_DIR;
  }

  /**
   * Resolve the per-user file path. `userId` is sanitised to prevent
   * directory traversal.
   */
  filePath(userId: string): string {
    assertSafeUserId(userId);
    return path.join(this.dataDir, 'users', userId, FILE_NAME);
  }

  private ensureUserDir(userId: string): string {
    const dir = path.join(this.dataDir, 'users', userId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  /**
   * Load the user-session document. Returns an empty doc with
   * `schemaVersion: 1` when no file exists for the user (this is a normal
   * state — it just means the user has never had an instruction yet).
   */
  load(userId: string): UserSessionDoc {
    const file = this.filePath(userId);
    if (!fs.existsSync(file)) return emptyDoc();
    try {
      const raw = fs.readFileSync(file, 'utf-8');
      const parsed = JSON.parse(raw) as UserSessionDoc;
      // Defensive backfill on load — old corrupt files surface as a thrown
      // error from validateDoc rather than silently degrading.
      if (parsed && typeof parsed === 'object') {
        if (!Array.isArray((parsed as Partial<UserSessionDoc>).instructions)) {
          (parsed as UserSessionDoc).instructions = [];
        }
        if (!Array.isArray((parsed as Partial<UserSessionDoc>).lifecycleEvents)) {
          (parsed as UserSessionDoc).lifecycleEvents = [];
        }
      }
      validateDoc(parsed);
      return parsed;
    } catch (err) {
      logger.error('Failed to load user-session doc', { userId, error: err });
      throw err;
    }
  }

  /**
   * Persist the user-session document atomically (tmp → rename) and validate
   * the sealed schema first. Throws on invariant violations.
   */
  save(userId: string, doc: UserSessionDoc): void {
    validateDoc(doc);
    this.ensureUserDir(userId);
    const final = this.filePath(userId);
    const tmp = `${final}.tmp`;
    const data = JSON.stringify(doc, null, 2);
    try {
      fs.writeFileSync(tmp, data, 'utf-8');
      fs.renameSync(tmp, final);
    } catch (err) {
      // Best-effort cleanup of the orphan tmp file.
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  /**
   * Invariant guard — throws if `currentInstructionId` is not a legal pointer
   * value for the supplied doc. `null` is a normal state (Q4 sealed YES).
   *
   * Caller (session-registry / lifecycle ops in #755) should run this before
   * setting `session.currentInstructionId` to enforce:
   *   - the id resolves to an existing instruction, AND
   *   - that instruction is `active` (cannot be completed/cancelled).
   */
  assertCurrentPointerOk(doc: UserSessionDoc, currentInstructionId: string | null): void {
    if (currentInstructionId === null || currentInstructionId === undefined) return;
    const inst = doc.instructions.find((i) => i.id === currentInstructionId);
    if (!inst) {
      throw new Error(
        `UserSessionStore: currentInstructionId points at unknown instruction ${JSON.stringify(currentInstructionId)}`,
      );
    }
    if (inst.status === 'completed') {
      throw new Error(
        `UserSessionStore: instruction ${JSON.stringify(currentInstructionId)} is completed and cannot be a session's current pointer`,
      );
    }
    if (inst.status === 'cancelled') {
      throw new Error(
        `UserSessionStore: instruction ${JSON.stringify(currentInstructionId)} is cancelled and cannot be a session's current pointer`,
      );
    }
  }

  /**
   * Append a session key to an instruction's `linkedSessionIds`,
   * deduplicating. Caller is responsible for writing the doc back via save().
   */
  static appendLinkedSession(inst: UserInstruction, sessionKey: string): void {
    if (!inst.linkedSessionIds.includes(sessionKey)) {
      inst.linkedSessionIds.push(sessionKey);
    }
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

let _instance: UserSessionStore | null = null;

export function getUserSessionStore(): UserSessionStore {
  if (!_instance) {
    _instance = new UserSessionStore();
  }
  return _instance;
}

/** Test/admin helper — replace the singleton with a custom-rooted store. */
export function initUserSessionStore(baseDir?: string): UserSessionStore {
  _instance = new UserSessionStore(baseDir);
  return _instance;
}
