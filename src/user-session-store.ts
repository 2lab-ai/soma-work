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
 * - `completed` — finished
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

/**
 * Thrown when the on-disk user-session.json exists but cannot be parsed
 * into a valid sealed document (malformed JSON, root not an object,
 * `instructions` / `lifecycleEvents` not arrays, schema-version drift,
 * referential-integrity violation). The caller decides whether to halt
 * the process or quarantine the file (rename to `.corrupt-{ts}`); the
 * store NEVER overwrites or silently degrades a corrupt file.
 */
export class UserSessionStoreCorruptError extends Error {
  readonly userId: string;
  readonly file: string;
  constructor(message: string, userId: string, file: string) {
    super(message);
    this.name = 'UserSessionStoreCorruptError';
    this.userId = userId;
    this.file = file;
  }
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
  for (const sk of inst.linkedSessionIds) {
    if (typeof sk !== 'string' || sk.length === 0) {
      throw new Error(`UserSessionStore: instructions[${idx}].linkedSessionIds entries must be non-empty strings`);
    }
  }
  if (!Array.isArray(inst.sourceRawInputIds)) {
    throw new Error(`UserSessionStore: instructions[${idx}].sourceRawInputIds must be an array`);
  }
  // Sealed shape: each entry MUST be an object with `sessionKey` + `rawInputId`
  // string fields (Q-array-of-strings was rejected by #727).
  inst.sourceRawInputIds.forEach((entry, j) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(
        `UserSessionStore: instructions[${idx}].sourceRawInputIds[${j}] must be an object { sessionKey, rawInputId }`,
      );
    }
    const e = entry as { sessionKey?: unknown; rawInputId?: unknown };
    if (typeof e.sessionKey !== 'string' || e.sessionKey.length === 0) {
      throw new Error(
        `UserSessionStore: instructions[${idx}].sourceRawInputIds[${j}].sessionKey must be a non-empty string`,
      );
    }
    if (typeof e.rawInputId !== 'string' || e.rawInputId.length === 0) {
      throw new Error(
        `UserSessionStore: instructions[${idx}].sourceRawInputIds[${j}].rawInputId must be a non-empty string`,
      );
    }
  });
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
    // Sealed referential-integrity rule (#727 P1-7): when a lifecycle event
    // points at an instruction, that instruction MUST exist on the same doc.
    // `null` is the legitimate "pending-add rejected/superseded" carve-out
    // and is left alone. The data-model PR is exactly where this invariant
    // is owed (the audit log cannot drift from the instruction list).
    if (evt.instructionId !== undefined && evt.instructionId !== null) {
      if (typeof evt.instructionId !== 'string' || evt.instructionId.length === 0) {
        throw new Error(`UserSessionStore: lifecycleEvents[${idx}].instructionId must be a non-empty string or null`);
      }
      if (!seenIds.has(evt.instructionId)) {
        throw new UserSessionStoreCorruptError(
          `UserSessionStore: lifecycleEvents[${idx}].instructionId ${JSON.stringify(
            evt.instructionId,
          )} does not appear in instructions[]`,
          'unknown',
          'in-memory',
        );
      }
    }
  });
}

// ── Public store ─────────────────────────────────────────────────────────────

export class UserSessionStore {
  private dataDir: string;
  /**
   * Per-userId in-memory cache of the parsed doc. Populated on `load()` and
   * invalidated on `save()`. Returned as a structured clone (`structuredClone`)
   * so callers cannot mutate cached state by reference. The cache is
   * intentionally process-local: the only writer to a user's
   * `user-session.json` is THIS process — `pid-lock` enforces single-instance
   * boot, and the file is updated atomically (tmp → rename). External
   * mutation (admin script, manual edit) requires a process restart, which
   * matches the existing operational contract.
   */
  private cache: Map<string, UserSessionDoc> = new Map();

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
   *
   * Throws `UserSessionStoreCorruptError` when an existing file cannot be
   * parsed or fails sealed schema/invariant checks. The caller decides
   * whether to halt the process or quarantine the file. Crucially the store
   * NEVER overwrites a malformed-but-existing file by silently substituting
   * `[]` (data-loss path) — that backfill is reserved for the missing-file
   * path only.
   *
   * Performance seam (#755): a per-userId in-memory cache is used so the
   * hot read path (per-turn `listActiveInstructions`/`findInstruction`) does
   * not re-read disk on every call. The cache is invalidated on `save()`.
   */
  load(userId: string): UserSessionDoc {
    const file = this.filePath(userId);
    const cached = this.cache.get(userId);
    if (cached) {
      return structuredClone(cached);
    }
    if (!fs.existsSync(file)) {
      // Missing-file path — fresh skeleton. Do NOT cache; absent users are
      // common in tests and the cost of computing emptyDoc() is trivial,
      // while caching empty docs would mask filesystem state changes
      // (e.g. an admin running migrate after a user's first save).
      return emptyDoc();
    }
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch (err) {
      logger.error('Failed to read user-session doc', { userId, error: err });
      throw err;
    }
    let parsed: UserSessionDoc;
    try {
      parsed = JSON.parse(raw) as UserSessionDoc;
    } catch (err) {
      throw new UserSessionStoreCorruptError(
        `UserSessionStore: ${file} is not valid JSON: ${(err as Error).message}`,
        userId,
        file,
      );
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new UserSessionStoreCorruptError(`UserSessionStore: ${file} root must be an object`, userId, file);
    }
    // Sealed contract: an existing file with malformed array fields is
    // CORRUPT, not a state we silently smooth over. Replacing them with `[]`
    // and continuing would let the next save() overwrite real on-disk data
    // with an empty doc — a catastrophic data-loss path.
    if (!Array.isArray((parsed as Partial<UserSessionDoc>).instructions)) {
      throw new UserSessionStoreCorruptError(`UserSessionStore: ${file} 'instructions' is not an array`, userId, file);
    }
    if (!Array.isArray((parsed as Partial<UserSessionDoc>).lifecycleEvents)) {
      throw new UserSessionStoreCorruptError(
        `UserSessionStore: ${file} 'lifecycleEvents' is not an array`,
        userId,
        file,
      );
    }
    try {
      validateDoc(parsed);
    } catch (err) {
      if (err instanceof UserSessionStoreCorruptError) {
        // Re-stamp the userId/file fields (validateDoc has no doc-context).
        throw new UserSessionStoreCorruptError((err as Error).message, userId, file);
      }
      throw new UserSessionStoreCorruptError((err as Error).message, userId, file);
    }
    this.cache.set(userId, structuredClone(parsed));
    return parsed;
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
      // Invalidate cache: we don't know if the on-disk state matches our
      // in-memory copy after a partial failure. Force the next load() to
      // re-read.
      this.cache.delete(userId);
      throw err;
    }
    // Refresh cache to reflect the just-written state.
    this.cache.set(userId, structuredClone(doc));
  }

  /**
   * Test/admin helper — drop the per-userId cache so a subsequent `load()`
   * re-reads from disk. Production code does NOT need this (the only writer
   * to user-session.json is this process, and `save()` keeps the cache in
   * sync); it exists for tests that mutate disk out-of-band.
   */
  invalidateCache(userId?: string): void {
    if (userId === undefined) {
      this.cache.clear();
    } else {
      this.cache.delete(userId);
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
   * Validate a session-side `currentInstructionId` against the user's doc.
   *
   * Returns the input `currentInstructionId` when it resolves to an `active`
   * instruction on the doc OR when it is null/undefined (normal state).
   *
   * Returns `null` (with a `state: 'rejected'` lifecycle audit appended to
   * `doc.lifecycleEvents`) when the pointer points at a completed,
   * cancelled, or non-existent instruction. The doc is mutated in place so
   * the caller can persist the audit row through the normal save() path.
   *
   * Used by SessionRegistry on both `save` (defensive — block writes that
   * would breach the invariant) and `load` (self-heal on disk drift).
   */
  assertSessionPointer(
    doc: UserSessionDoc,
    sessionKey: string,
    currentInstructionId: string | null | undefined,
    opts?: { now?: () => string; reason?: 'on-save' | 'on-load' },
  ): string | null {
    if (currentInstructionId === null || currentInstructionId === undefined) {
      return null;
    }
    const inst = doc.instructions.find((i) => i.id === currentInstructionId);
    let badReason: string | null = null;
    if (!inst) {
      badReason = 'unknown';
    } else if (inst.status === 'completed') {
      badReason = 'completed';
    } else if (inst.status === 'cancelled') {
      badReason = 'cancelled';
    }
    if (!badReason) {
      return currentInstructionId;
    }
    const now = (opts?.now ?? (() => new Date().toISOString()))();
    const auditId = `pointer-rejected_${sessionKey}_${currentInstructionId}_${now}`;
    // Append a rejected lifecycle audit row. We deliberately set
    // instructionId to null because the pointer is being severed; the
    // payload carries the original id for forensic drilldown.
    doc.lifecycleEvents.push({
      id: auditId,
      instructionId: null,
      sessionKey,
      op: 'link',
      state: 'rejected',
      at: now,
      by: { type: 'system', id: 'session-registry' },
      payload: {
        kind: 'pointer-invariant-violation',
        reason: badReason,
        rejectedInstructionId: currentInstructionId,
        when: opts?.reason ?? 'on-save',
      },
    });
    logger.warn('Session pointer rejected — invariant violation', {
      sessionKey,
      currentInstructionId,
      reason: badReason,
      when: opts?.reason ?? 'on-save',
    });
    return null;
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
