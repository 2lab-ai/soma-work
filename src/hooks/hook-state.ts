/**
 * Hook state — in-memory Map + JSON file persistence.
 * Same pattern as session-registry.ts: temp→rename atomic save with debounce.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { DATA_DIR } from '../env-paths';
import { Logger } from '../logger';

const logger = new Logger('HookState');
const STATE_FILE = path.join(DATA_DIR, 'hook-state.json');
const SAVE_DEBOUNCE_MS = 500;
const STALE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const CALL_LOG_CAP = 1000;

// ── Types ──

export interface CallState {
  toolName: string;
  callId: string;
  startTime: string;
  epoch: number;
  description: string;
}

export interface CallLogEntry {
  callId: string;
  sessionId: string;
  toolName: string;
  description: string;
  startTime: string;
  endTime: string;
  durationMs: number;
  status: string;
}

interface PersistedState {
  pendingCalls: Record<string, CallState[]>;
  callLog: CallLogEntry[];
}

// ── HookState class ──

class HookState {
  private pendingCalls: Map<string, CallState[]> = new Map();
  private callLog: CallLogEntry[] = [];
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private cleanupInitialized = false;

  constructor() {
    this.load();
  }

  // ── Call tracking ──

  recordCallStart(sessionId: string, callState: CallState): void {
    const key = `${sessionId}:${callState.toolName}`;
    const queue = this.pendingCalls.get(key) || [];
    queue.push(callState);
    this.pendingCalls.set(key, queue);
    this.save();
  }

  recordCallEnd(sessionId: string, toolName: string, status: string): CallLogEntry | null {
    const key = `${sessionId}:${toolName}`;
    const queue = this.pendingCalls.get(key);
    if (!queue || queue.length === 0) return null;

    // FIFO: take the oldest pending call
    const call = queue.shift() as CallState;
    if (queue.length === 0) {
      this.pendingCalls.delete(key);
    }

    const endTime = new Date().toISOString();
    const startEpoch = new Date(call.startTime).getTime();
    const endEpoch = Date.now();

    const entry: CallLogEntry = {
      callId: call.callId,
      sessionId,
      toolName,
      description: call.description,
      startTime: call.startTime,
      endTime,
      durationMs: endEpoch - startEpoch,
      status,
    };

    this.callLog.push(entry);

    // Enforce cap
    if (this.callLog.length > CALL_LOG_CAP) {
      this.callLog = this.callLog.slice(-CALL_LOG_CAP);
    }

    this.save();
    return entry;
  }

  getCallLog(sessionId?: string): CallLogEntry[] {
    if (!sessionId) return [...this.callLog];
    return this.callLog.filter((e) => e.sessionId === sessionId);
  }

  // ── Session cleanup ──

  cleanupSession(sessionId: string): void {
    // Remove all pending calls for this session
    for (const key of [...this.pendingCalls.keys()]) {
      if (key.startsWith(`${sessionId}:`)) {
        this.pendingCalls.delete(key);
      }
    }

    this.save();
    logger.debug('Cleaned up session', { sessionId });
  }

  // ── Persistence ──

  save(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.writeFile();
      this.saveTimer = null;
    }, SAVE_DEBOUNCE_MS);
  }

  load(): void {
    try {
      if (!fs.existsSync(STATE_FILE)) return;

      const raw = fs.readFileSync(STATE_FILE, 'utf-8');
      const data: PersistedState = JSON.parse(raw);

      this.pendingCalls = new Map(Object.entries(data.pendingCalls || {}));
      this.callLog = data.callLog || [];

      logger.debug('Loaded hook state', {
        pendingCallKeys: this.pendingCalls.size,
        callLogEntries: this.callLog.length,
      });
    } catch (error) {
      logger.warn('Failed to load hook state, starting fresh', error);
    }
  }

  flushSync(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.writeFile();
  }

  // ── Stale cleanup ──

  cleanupStale(): void {
    const now = Date.now();
    let removed = 0;

    // Clean stale pending calls (by epoch)
    for (const [key, queue] of this.pendingCalls) {
      const filtered = queue.filter((c) => now - c.epoch * 1000 < STALE_TTL_MS);
      removed += queue.length - filtered.length;
      if (filtered.length === 0) {
        this.pendingCalls.delete(key);
      } else if (filtered.length !== queue.length) {
        this.pendingCalls.set(key, filtered);
      }
    }

    if (removed > 0) {
      logger.info(`Cleaned up ${removed} stale hook state entries`);
      this.save();
    }
  }

  startCleanupTimer(): void {
    if (this.cleanupInitialized) return;
    this.cleanupInitialized = true;

    this.cleanupTimer = setInterval(() => {
      this.cleanupStale();
    }, CLEANUP_INTERVAL_MS);

    // Unref so it doesn't keep the process alive
    if (this.cleanupTimer && typeof this.cleanupTimer.unref === 'function') {
      this.cleanupTimer.unref();
    }

    logger.debug('Hook state cleanup timer started');
  }

  // ── Private ──

  private writeFile(): void {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }

      const data: PersistedState = {
        pendingCalls: Object.fromEntries(this.pendingCalls),
        callLog: this.callLog,
      };

      const json = JSON.stringify(data, null, 2);
      const tmpFile = `${STATE_FILE}.tmp.${process.pid}`;

      fs.writeFileSync(tmpFile, json);
      fs.renameSync(tmpFile, STATE_FILE);
    } catch (error) {
      logger.error('Failed to write hook state', error);
    }
  }
}

// Export singleton
export const hookState = new HookState();
