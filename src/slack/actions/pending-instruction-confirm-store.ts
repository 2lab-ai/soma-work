/**
 * Pending-confirm store for user-SSOT instruction writes.
 *
 * When the model issues `UPDATE_SESSION.instructionOperations`, the host
 * intercepts the write (stream-executor §10) and posts a Slack y/n button.
 * This store bridges the two halves of that flow:
 *
 *   1. `stream-executor` calls `set()` with the pending request + the Slack
 *      message coordinates (channel + ts) so the button's message can be
 *      updated later.
 *   2. `InstructionConfirmActionHandler.handleYes` / `handleNo` calls `get()`
 *      via the request id (carried in the action_id), then `delete()` on
 *      success.
 *
 * Invariant: at most **one active pending entry per session**. `set()` is
 * idempotent — passing a new request for an existing sessionKey overwrites
 * the previous entry and returns the evicted record so the caller can
 * `chat.update` it to `[superseded]`.
 *
 * Persistence: mirrors `PendingFormStore` — JSON file under DATA_DIR,
 * 24h TTL, survives restarts.
 */

import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from '../../env-paths';
import { Logger } from '../../logger';
import type { SessionResourceUpdateRequest } from '../../types';

const STORE_FILE = path.join(DATA_DIR, 'pending-instruction-confirms.json');
const CONFIRM_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Sealed 5-op lifecycle vocabulary (#755). Every pending confirm entry
 * carries one of these in `type` so the SessionRegistry tx can build the
 * `lifecycleEvents[]` audit row without re-scanning `request.instructionOperations`.
 */
export type PendingInstructionConfirmType = 'add' | 'link' | 'complete' | 'cancel' | 'rename';

const VALID_PENDING_TYPES: ReadonlySet<PendingInstructionConfirmType> = new Set([
  'add',
  'link',
  'complete',
  'cancel',
  'rename',
]);

/**
 * Actor descriptor matching the sealed `lifecycleEvents[].by` shape.
 * `slack-user` is the only valid producer at the y/n confirm seam — `system`
 * and `migration` are reserved for self-heal / migration audits and never
 * flow through the pending store. `id` is the Slack user-id of the
 * triggering user (snapshotted at queue-time, immune to later turn shifts).
 */
export interface PendingInstructionConfirmBy {
  type: 'slack-user';
  id: string;
}

/**
 * Payload persisted per pending entry. `requestId` is the primary key —
 * mirrored into the Slack action_id so the button click maps back here.
 */
export interface PendingInstructionConfirm {
  /** Unique id (e.g. randomUUID()); also embedded in action_id. */
  requestId: string;
  /** Session lookup key — channel|threadTs, same shape as SessionRegistry. */
  sessionKey: string;
  /** Channel id the confirmation message was posted to. */
  channelId: string;
  /** Thread ts the confirmation message lives under. */
  threadTs: string;
  /**
   * Message ts of the confirmation post. Set asynchronously after `set()`
   * because `chat.postMessage` returns only after the store entry exists;
   * the caller must call `updateMessageTs()` once the post resolves.
   */
  messageTs?: string;
  /** The deferred `UPDATE_SESSION` request payload. */
  request: SessionResourceUpdateRequest;
  /** Creation timestamp (ms). */
  createdAt: number;
  /**
   * Slack user id of the turn initiator at the moment the model queued the
   * write. Snapshotted here so the owner guard survives later mutations of
   * `session.currentInitiatorId` (which would otherwise let a newer turn's
   * initiator approve/reject a proposal raised by someone else). Required —
   * entries missing this field are dropped on rehydrate.
   */
  requesterId: string;
  /**
   * Sealed lifecycle op that produced this entry (#755). Used by the
   * SessionRegistry transaction to build the `lifecycleEvents[]` row when
   * the user clicks y/n. Required.
   */
  type: PendingInstructionConfirmType;
  /**
   * Sealed actor descriptor matching `lifecycleEvents[].by` (#755 / #727).
   * The `id` mirrors `requesterId` at queue-time; carrying both is
   * intentional — `requesterId` is the existing owner-guard anchor and
   * `by` is the audit-log anchor, and we want the two seams independently
   * verifiable on disk.
   */
  by: PendingInstructionConfirmBy;
}

export class PendingInstructionConfirmStore {
  private byRequest: Map<string, PendingInstructionConfirm> = new Map();
  /** Secondary index: sessionKey → requestId. Enforces the "one per session" invariant. */
  private bySession: Map<string, string> = new Map();
  private logger = new Logger('PendingInstructionConfirmStore');

  /**
   * Insert a new pending entry. If the session already has one, the old
   * entry is evicted and returned so the caller can mark its Slack message
   * as `[superseded]`.
   */
  set(entry: PendingInstructionConfirm): PendingInstructionConfirm | undefined {
    let evicted: PendingInstructionConfirm | undefined;
    const existingId = this.bySession.get(entry.sessionKey);
    if (existingId && existingId !== entry.requestId) {
      evicted = this.byRequest.get(existingId);
      this.byRequest.delete(existingId);
    }
    this.byRequest.set(entry.requestId, entry);
    this.bySession.set(entry.sessionKey, entry.requestId);
    this.saveForms();
    return evicted;
  }

  /** Update the messageTs after the Slack post resolves. No-op if gone. */
  updateMessageTs(requestId: string, messageTs: string): void {
    const entry = this.byRequest.get(requestId);
    if (!entry) return;
    entry.messageTs = messageTs;
    this.saveForms();
  }

  get(requestId: string): PendingInstructionConfirm | undefined {
    const entry = this.byRequest.get(requestId);
    if (!entry) return undefined;
    if (this.isExpired(entry)) {
      this.deleteExpired(entry);
      return undefined;
    }
    return entry;
  }

  getBySession(sessionKey: string): PendingInstructionConfirm | undefined {
    const id = this.bySession.get(sessionKey);
    if (!id) return undefined;
    const entry = this.byRequest.get(id);
    if (!entry) return undefined;
    if (this.isExpired(entry)) {
      this.deleteExpired(entry);
      return undefined;
    }
    return entry;
  }

  private isExpired(entry: PendingInstructionConfirm): boolean {
    return Date.now() - (entry.createdAt || 0) > CONFIRM_TTL_MS;
  }

  /** Drop an entry from memory + persist. Used by the runtime TTL sweep. */
  private deleteExpired(entry: PendingInstructionConfirm): void {
    this.byRequest.delete(entry.requestId);
    if (this.bySession.get(entry.sessionKey) === entry.requestId) {
      this.bySession.delete(entry.sessionKey);
    }
    this.saveForms();
    this.logger.debug('Dropped expired pending-instruction confirm', {
      requestId: entry.requestId,
      sessionKey: entry.sessionKey,
      ageMs: Date.now() - (entry.createdAt || 0),
    });
  }

  delete(requestId: string): PendingInstructionConfirm | undefined {
    const entry = this.byRequest.get(requestId);
    if (!entry) return undefined;
    this.byRequest.delete(requestId);
    if (this.bySession.get(entry.sessionKey) === requestId) {
      this.bySession.delete(entry.sessionKey);
    }
    this.saveForms();
    return entry;
  }

  /** Returns a shallow array snapshot — useful for tests. */
  list(): PendingInstructionConfirm[] {
    return Array.from(this.byRequest.values());
  }

  saveForms(): void {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const arr = Array.from(this.byRequest.values());
      fs.writeFileSync(STORE_FILE, JSON.stringify(arr, null, 2));
      this.logger.debug(`Saved ${arr.length} pending-instruction confirms`);
    } catch (err) {
      this.logger.error('Failed to persist pending-instruction confirms', err);
    }
  }

  /**
   * Rehydrate from disk, dropping entries older than `CONFIRM_TTL_MS`.
   * Returns the number of entries restored.
   */
  loadForms(): number {
    if (!fs.existsSync(STORE_FILE)) return 0;
    try {
      const raw = fs.readFileSync(STORE_FILE, 'utf-8');
      const arr: PendingInstructionConfirm[] = JSON.parse(raw);
      let restored = 0;
      for (const entry of arr) {
        if (!entry || typeof entry !== 'object') continue;
        if (!entry.requestId || !entry.sessionKey) continue;
        if (this.isExpired(entry)) continue;
        // Pre-migration entries lack `requesterId`; dropping them here
        // prevents rehydrating a record the owner guard cannot evaluate.
        if (typeof entry.requesterId !== 'string' || entry.requesterId.length === 0) continue;
        // Pre-#755 entries lack the sealed `type` + `by` fields. Treating
        // them as `add` here would silently mis-attribute lifecycle events,
        // so we drop them — the model can re-propose on the next turn and
        // a fresh entry with the sealed shape will be queued.
        if (!VALID_PENDING_TYPES.has(entry.type as PendingInstructionConfirmType)) continue;
        const by = entry.by as PendingInstructionConfirmBy | undefined;
        if (!by || by.type !== 'slack-user' || typeof by.id !== 'string' || by.id.length === 0) continue;
        this.byRequest.set(entry.requestId, entry);
        this.bySession.set(entry.sessionKey, entry.requestId);
        restored += 1;
      }
      this.logger.info(`Loaded ${restored} pending-instruction confirms (${arr.length - restored} expired)`);
      if (restored !== arr.length) this.saveForms();
      return restored;
    } catch (err) {
      this.logger.error('Failed to load pending-instruction confirms', err);
      return 0;
    }
  }
}
