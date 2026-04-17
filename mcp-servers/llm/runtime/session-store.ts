/**
 * FileSessionStore — JSONL-backed session store with store-wide write serialization.
 *
 * Durability:
 *   - JSONL (one record per line) at ~/.soma-work/llm-sessions.jsonl.
 *   - Every mutation goes through a WriteQueue.run so concurrent callers do not
 *     interleave in-memory mutations with file rewrites.
 *   - atomicRewrite = writeFile(tmp) → fsync → rename(tmp, final). Crash between
 *     writeFile and rename: primary file intact. Crash after rename: new state durable.
 *   - mutateAndPersist snapshots the in-memory state before the mutator runs; if
 *     atomicRewrite throws, the snapshot is restored. Post-condition: memory and
 *     file either both reflect the mutation or both equal the pre-mutation state.
 *
 * Legacy migration:
 *   - On first load, if the legacy `llm-sessions.json` blob exists and the JSONL
 *     file is missing, parse the blob and convert each record via applyLoadRules.
 *   - Top-level JSON parse error → copy to `.bak.corrupt` + start empty.
 *   - Successful migration → write JSONL then rename blob → `.bak`.
 *
 * v8 loader invariants (enforced in applyLoadRules):
 *   status='ready'    requires backendSessionId !== null
 *   status='pending'  requires backendSessionId === null
 *   Missing resolvedConfig → corrupted (no silent `{}` substitution).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StderrLogger } from '../../_shared/stderr-logger.js';
import { WriteQueue } from './write-queue.js';
import type { SessionRecord, SessionStore, SessionStatus } from './types.js';

const DEFAULT_DIR = path.join(os.homedir(), '.soma-work');
const DEFAULT_FILE = 'llm-sessions.jsonl';
const LEGACY_FILE = 'llm-sessions.json';
const MAX_SESSIONS = 50;
const TTL_MS = 24 * 60 * 60 * 1000; // 24h

const logger = new StderrLogger('FileSessionStore');

// ── Load-rule engine ──────────────────────────────────────

interface LoadedRecord {
  record: SessionRecord;
  /** true if the record was coerced (originally malformed); for migration logging. */
  coerced: boolean;
  coerceReason?: string;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Apply v7 migration rules + v8 invariants to a raw record object.
 * Returns null if the record lacks required identity fields (publicId/backend/model)
 * — such records are skipped entirely because they cannot be keyed.
 */
function applyLoadRules(raw: unknown): LoadedRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  if (!isNonEmptyString(r.publicId)) return null;
  if (r.backend !== 'codex' && r.backend !== 'gemini') return null;
  if (!isNonEmptyString(r.model)) return null;

  const createdAt = isNonEmptyString(r.createdAt) ? r.createdAt : nowIso();
  const updatedAt = isNonEmptyString(r.updatedAt) ? r.updatedAt : createdAt;
  const cwd = isNonEmptyString(r.cwd) ? r.cwd : undefined;

  // backendSessionId: legacy recorded '' for missing; normalise to null.
  let backendSessionId: string | null;
  if (r.backendSessionId === null) {
    backendSessionId = null;
  } else if (isNonEmptyString(r.backendSessionId)) {
    backendSessionId = r.backendSessionId;
  } else {
    backendSessionId = null;
  }

  const hasResolvedConfig =
    r.resolvedConfig !== null && typeof r.resolvedConfig === 'object' && !Array.isArray(r.resolvedConfig);
  const resolvedConfig = hasResolvedConfig ? (r.resolvedConfig as Record<string, unknown>) : {};

  let status: SessionStatus;
  let coerced = false;
  let coerceReason: string | undefined;

  const rawStatus = r.status;

  if (!hasResolvedConfig) {
    // No record of the config that spawned the backend session.
    // Cannot resume reliably — mark corrupted.
    status = 'corrupted';
    coerced = true;
    coerceReason = 'legacy-unresumable';
    logger.warn('llm.session.legacy-unresumable', { publicId: r.publicId });
  } else if (rawStatus === undefined) {
    // Legacy default: if resolvedConfig is present, assume 'ready'.
    status = 'ready';
    coerced = true;
    coerceReason = 'legacy-default-ready';
  } else if (rawStatus === 'pending' || rawStatus === 'ready' || rawStatus === 'corrupted') {
    status = rawStatus;
  } else {
    status = 'corrupted';
    coerced = true;
    coerceReason = 'unknown-status';
    logger.warn('llm.session.malformed', { publicId: r.publicId, rawStatus });
  }

  // v8 invariants (apply AFTER previous rules so a coerced 'ready' is still checked).
  if (status === 'ready' && backendSessionId === null) {
    status = 'corrupted';
    coerced = true;
    coerceReason = 'ready-without-bsid';
    logger.warn('llm.session.invariant-violated', {
      publicId: r.publicId,
      reason: 'ready-without-bsid',
    });
  }
  if (status === 'pending' && backendSessionId !== null) {
    status = 'corrupted';
    coerced = true;
    coerceReason = 'pending-with-bsid';
    logger.warn('llm.session.invariant-violated', {
      publicId: r.publicId,
      reason: 'pending-with-bsid',
    });
  }

  const record: SessionRecord = {
    publicId: r.publicId,
    backend: r.backend,
    backendSessionId,
    model: r.model,
    cwd,
    resolvedConfig,
    status,
    createdAt,
    updatedAt,
  };
  return { record, coerced, coerceReason };
}

// ── Store ─────────────────────────────────────────────────

export class FileSessionStore implements SessionStore {
  public readonly writeQueue = new WriteQueue();

  private readonly filePath: string;
  private readonly legacyPath: string;
  private records: Map<string, SessionRecord> | null = null;

  constructor(filePath?: string) {
    this.filePath = filePath ?? path.join(DEFAULT_DIR, DEFAULT_FILE);
    this.legacyPath = path.join(path.dirname(this.filePath), LEGACY_FILE);
  }

  // ── Public API ────────────────────────────────────────

  get(publicId: string): SessionRecord | undefined {
    this.ensureLoaded();
    const r = this.records!.get(publicId);
    if (!r) return undefined;
    if (this.isExpired(r)) {
      // Don't mutate here (would require awaiting); expired records silently vanish from reads.
      return undefined;
    }
    return { ...r, resolvedConfig: { ...r.resolvedConfig } };
  }

  async save(record: SessionRecord): Promise<void> {
    this.ensureLoaded();
    return this.mutateAndPersist((recs) => {
      // Enforce the tri-state invariant at the top of every persistence path —
      // update/updateBackendSessionId already do this; save() was the only
      // write gate that silently admitted invariant violations.
      this.assertInvariant(record);
      recs.set(record.publicId, { ...record, resolvedConfig: { ...record.resolvedConfig } });
      this.pruneExcessInPlace(recs);
    });
  }

  async update(publicId: string, patch: Partial<SessionRecord>): Promise<void> {
    this.ensureLoaded();
    return this.mutateAndPersist((recs) => {
      const existing = recs.get(publicId);
      if (!existing) {
        throw new Error(`SessionStore.update: unknown publicId ${publicId}`);
      }
      const merged: SessionRecord = {
        ...existing,
        ...patch,
        // Never lose identity.
        publicId: existing.publicId,
        backend: existing.backend,
        resolvedConfig: patch.resolvedConfig
          ? { ...patch.resolvedConfig }
          : existing.resolvedConfig,
        updatedAt: nowIso(),
      };
      this.assertInvariant(merged);
      recs.set(publicId, merged);
    });
  }

  async updateBackendSessionId(publicId: string, newBackendSessionId: string): Promise<void> {
    this.ensureLoaded();
    return this.mutateAndPersist((recs) => {
      const existing = recs.get(publicId);
      if (!existing) return;
      const merged: SessionRecord = {
        ...existing,
        backendSessionId: newBackendSessionId,
        updatedAt: nowIso(),
      };
      this.assertInvariant(merged);
      recs.set(publicId, merged);
    });
  }

  async touch(publicId: string): Promise<void> {
    this.ensureLoaded();
    return this.mutateAndPersist((recs) => {
      const existing = recs.get(publicId);
      if (!existing) return;
      recs.set(publicId, { ...existing, updatedAt: nowIso() });
    });
  }

  async delete(publicId: string): Promise<void> {
    this.ensureLoaded();
    return this.mutateAndPersist((recs) => {
      recs.delete(publicId);
    });
  }

  async prune(): Promise<void> {
    this.ensureLoaded();
    return this.mutateAndPersist((recs) => {
      const now = Date.now();
      for (const [id, r] of recs) {
        if (this.isExpired(r, now)) recs.delete(id);
      }
    });
  }

  // ── Commit/rollback wrapper ───────────────────────────

  private async mutateAndPersist(
    mutator: (records: Map<string, SessionRecord>) => void,
  ): Promise<void> {
    return this.writeQueue.run(async () => {
      const snapshot = this.cloneRecords(this.records!);
      try {
        mutator(this.records!);
        await this.atomicRewrite();
      } catch (err) {
        // Rollback in-memory state to snapshot.
        this.records = snapshot;
        throw err;
      }
    });
  }

  private cloneRecords(src: Map<string, SessionRecord>): Map<string, SessionRecord> {
    const clone = new Map<string, SessionRecord>();
    for (const [k, v] of src) {
      clone.set(k, { ...v, resolvedConfig: { ...v.resolvedConfig } });
    }
    return clone;
  }

  private async atomicRewrite(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.promises.mkdir(dir, { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    const lines: string[] = [];
    for (const r of this.records!.values()) {
      lines.push(JSON.stringify(r));
    }
    const body = lines.length > 0 ? `${lines.join('\n')}\n` : '';
    await fs.promises.writeFile(tmpPath, body, 'utf-8');
    // fsync via open+close for durability.
    const fh = await fs.promises.open(tmpPath, 'r+');
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.promises.rename(tmpPath, this.filePath);
  }

  // ── Invariants & pruning ──────────────────────────────

  private assertInvariant(r: SessionRecord): void {
    if (r.status === 'ready') {
      if (r.backendSessionId === null) {
        throw new Error(`Invariant violated: ready session ${r.publicId} has null backendSessionId`);
      }
      // Empty or whitespace-only IDs would silently corrupt future resumes.
      if (r.backendSessionId.trim() === '') {
        throw new Error(`Invariant violated: ready session ${r.publicId} has blank backendSessionId`);
      }
    }
    if (r.status === 'pending' && r.backendSessionId !== null) {
      throw new Error(`Invariant violated: pending session ${r.publicId} has non-null backendSessionId`);
    }
  }

  private isExpired(r: SessionRecord, now: number = Date.now()): boolean {
    return now - new Date(r.updatedAt).getTime() > TTL_MS;
  }

  private pruneExcessInPlace(recs: Map<string, SessionRecord>): void {
    const now = Date.now();
    for (const [id, r] of recs) {
      if (this.isExpired(r, now)) recs.delete(id);
    }
    if (recs.size > MAX_SESSIONS) {
      const sorted = [...recs.entries()].sort(
        (a, b) => new Date(a[1].updatedAt).getTime() - new Date(b[1].updatedAt).getTime(),
      );
      const toRemove = sorted.length - MAX_SESSIONS;
      for (let i = 0; i < toRemove; i++) {
        recs.delete(sorted[i][0]);
      }
    }
  }

  // ── Load / migrate ────────────────────────────────────

  private ensureLoaded(): void {
    if (this.records !== null) return;
    this.records = new Map();

    const jsonlExists = fs.existsSync(this.filePath);
    const legacyExists = fs.existsSync(this.legacyPath);

    if (jsonlExists) {
      this.loadJsonl();
    } else if (legacyExists) {
      this.migrateFromLegacyBlob();
    }
    // else: fresh start, empty map
  }

  private loadJsonl(): void {
    let body: string;
    try {
      body = fs.readFileSync(this.filePath, 'utf-8');
    } catch (err: any) {
      if (err?.code === 'ENOENT') return;
      throw err;
    }

    const lines = body.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        logger.warn('llm.session.malformed', { kind: 'jsonl-parse', preview: trimmed.slice(0, 80) });
        continue;
      }
      const loaded = applyLoadRules(parsed);
      if (loaded) {
        this.records!.set(loaded.record.publicId, loaded.record);
      } else {
        logger.warn('llm.session.malformed', { kind: 'load-rules-rejected' });
      }
    }
  }

  private migrateFromLegacyBlob(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.legacyPath, 'utf-8');
    } catch {
      return;
    }

    let arr: unknown;
    try {
      arr = JSON.parse(raw);
    } catch {
      // Top-level parse error: back up the corrupt file, start empty.
      const corruptPath = `${this.legacyPath}.bak.corrupt`;
      try {
        fs.copyFileSync(this.legacyPath, corruptPath);
      } catch { /* best-effort */ }
      logger.warn('llm.store.migration.corrupted', { backup: corruptPath });
      return;
    }

    if (!Array.isArray(arr)) {
      logger.warn('llm.store.migration.corrupted', { reason: 'blob-not-array' });
      return;
    }

    let coercedCount = 0;
    for (const raw of arr) {
      const loaded = applyLoadRules(raw);
      if (!loaded) continue;
      if (loaded.coerced) coercedCount++;
      this.records!.set(loaded.record.publicId, loaded.record);
    }

    logger.info('llm.store.migrated', { count: this.records!.size, coerced: coercedCount });

    // Persist the migrated state to JSONL, then rename the legacy blob to .bak.
    // This migration path is pre-WriteQueue (init-time) so we call atomicRewrite synchronously.
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    const lines: string[] = [];
    for (const r of this.records!.values()) {
      lines.push(JSON.stringify(r));
    }
    const body = lines.length > 0 ? `${lines.join('\n')}\n` : '';
    fs.writeFileSync(tmpPath, body, 'utf-8');
    const fd = fs.openSync(tmpPath, 'r+');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, this.filePath);
    try {
      fs.renameSync(this.legacyPath, `${this.legacyPath}.bak`);
    } catch {
      // If .bak already exists from a prior partial run, leave the original blob
      // in place — the JSONL is authoritative, readers will not look at it again.
    }
  }
}
