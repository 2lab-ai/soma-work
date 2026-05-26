import { DATA_DIR } from '@soma/common/env-paths';
import { Logger } from '@soma/common/logger';
import * as fs from 'fs';
import * as path from 'path';
import type { SessionResourceUpdateRequest } from '../instruction-confirm-blocks';

let getDataDir: () => string = () => DATA_DIR;

export function setPendingInstructionConfirmStoreDataDirProvider(provider: () => string): void {
  getDataDir = provider;
}

function storeFile(): string {
  return path.join(getDataDir(), 'pending-instruction-confirms.json');
}

const CONFIRM_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Payload persisted per pending entry. `requestId` is the primary key.
 */
export interface PendingInstructionConfirm {
  /** Unique id, also embedded in the Slack action_id. */
  requestId: string;
  /** Session lookup key. */
  sessionKey: string;
  /** Channel id the confirmation message was posted to. */
  channelId: string;
  /** Thread ts the confirmation message lives under. */
  threadTs: string;
  /** Message ts of the confirmation post. */
  messageTs?: string;
  /** The deferred `UPDATE_SESSION` request payload. */
  request: SessionResourceUpdateRequest;
  /** Creation timestamp (ms). */
  createdAt: number;
  /** Slack user id of the turn initiator. */
  requesterId: string;
}

export class PendingInstructionConfirmStore {
  private byRequest: Map<string, PendingInstructionConfirm> = new Map();
  private bySession: Map<string, string> = new Map();
  private logger = new Logger('PendingInstructionConfirmStore');

  /**
   * Insert a new pending entry. If the session already has one, the old entry
   * is evicted and returned so the caller can mark its Slack message stale.
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

  /** Returns a shallow array snapshot for tests. */
  list(): PendingInstructionConfirm[] {
    return Array.from(this.byRequest.values());
  }

  saveForms(): void {
    try {
      fs.mkdirSync(getDataDir(), { recursive: true });
      const arr = Array.from(this.byRequest.values());
      fs.writeFileSync(storeFile(), JSON.stringify(arr, null, 2));
      this.logger.debug(`Saved ${arr.length} pending-instruction confirms`);
    } catch (err) {
      this.logger.error('Failed to persist pending-instruction confirms', err);
    }
  }

  /**
   * Rehydrate from disk, dropping entries older than `CONFIRM_TTL_MS`.
   */
  loadForms(): number {
    const file = storeFile();
    if (!fs.existsSync(file)) return 0;
    try {
      const raw = fs.readFileSync(file, 'utf-8');
      const arr: PendingInstructionConfirm[] = JSON.parse(raw);
      let restored = 0;
      for (const entry of arr) {
        if (!entry || typeof entry !== 'object') continue;
        if (!entry.requestId || !entry.sessionKey) continue;
        if (this.isExpired(entry)) continue;
        if (typeof entry.requesterId !== 'string' || entry.requesterId.length === 0) continue;
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
