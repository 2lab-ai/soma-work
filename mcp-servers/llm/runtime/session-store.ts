/**
 * FileSessionStore — Durable JSON-file-backed session store.
 *
 * Stores sessions as a single JSON file at ~/.soma-work/llm-sessions.json.
 * Designed for the MCP server's serialized tool-call model (sync I/O is fine).
 *
 * @see Issue #333 — Durable Session Store
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SessionRecord, SessionStore } from './types.js';

const DEFAULT_DIR = path.join(os.homedir(), '.soma-work');
const DEFAULT_FILE = 'llm-sessions.json';
const MAX_SESSIONS = 50;
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export class FileSessionStore implements SessionStore {
  private readonly filePath: string;
  private records: Map<string, SessionRecord> | null = null; // lazy-loaded

  constructor(filePath?: string) {
    this.filePath = filePath ?? path.join(DEFAULT_DIR, DEFAULT_FILE);
  }

  get(publicId: string): SessionRecord | undefined {
    this.ensureLoaded();
    const record = this.records!.get(publicId);
    if (!record) return undefined;
    // Check TTL
    if (this.isExpired(record)) {
      this.records!.delete(publicId);
      this.flush();
      return undefined;
    }
    return record;
  }

  save(record: SessionRecord): void {
    this.ensureLoaded();
    this.records!.set(record.publicId, record);
    this.pruneExcess();
    this.flush();
  }

  updateBackendSessionId(publicId: string, newBackendSessionId: string): void {
    this.ensureLoaded();
    const record = this.records!.get(publicId);
    if (!record) return;
    record.backendSessionId = newBackendSessionId;
    record.updatedAt = new Date().toISOString();
    this.flush();
  }

  delete(publicId: string): void {
    this.ensureLoaded();
    this.records!.delete(publicId);
    this.flush();
  }

  prune(): void {
    this.ensureLoaded();
    const now = Date.now();
    let changed = false;
    for (const [id, record] of this.records!) {
      if (this.isExpired(record, now)) {
        this.records!.delete(id);
        changed = true;
      }
    }
    if (changed) this.flush();
  }

  // ── Internal ──────────────────────────────────────────────

  private isExpired(record: SessionRecord, now: number = Date.now()): boolean {
    return now - new Date(record.updatedAt).getTime() > TTL_MS;
  }

  private ensureLoaded(): void {
    if (this.records !== null) return;
    this.records = new Map();
    try {
      const data = fs.readFileSync(this.filePath, 'utf-8');
      const arr: SessionRecord[] = JSON.parse(data);
      if (Array.isArray(arr)) {
        for (const r of arr) {
          this.records.set(r.publicId, r);
        }
      }
    } catch {
      // File doesn't exist or is corrupt — start fresh
    }
  }

  /** Remove expired, then trim to MAX_SESSIONS (oldest first). */
  private pruneExcess(): void {
    const now = Date.now();
    // Remove expired
    for (const [id, record] of this.records!) {
      if (this.isExpired(record, now)) {
        this.records!.delete(id);
      }
    }
    // Trim oldest if over limit
    if (this.records!.size > MAX_SESSIONS) {
      const sorted = [...this.records!.entries()].sort(
        (a, b) => new Date(a[1].updatedAt).getTime() - new Date(b[1].updatedAt).getTime(),
      );
      const toRemove = sorted.length - MAX_SESSIONS;
      for (let i = 0; i < toRemove; i++) {
        this.records!.delete(sorted[i][0]);
      }
    }
  }

  /** Atomic write: write to .tmp, then rename. */
  private flush(): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = this.filePath + '.tmp';
    const arr = [...this.records!.values()];
    fs.writeFileSync(tmpPath, JSON.stringify(arr, null, 2), 'utf-8');
    fs.renameSync(tmpPath, this.filePath);
  }
}
