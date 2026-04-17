/**
 * ChildRegistry — durable record of spawned backend child PIDs.
 *
 * Purpose:
 *   Our own process may crash after spawning a codex/gemini MCP child. Without
 *   a record on disk, the orphaned child keeps running. On next boot we read
 *   this file and reap orphans before binding handlers.
 *
 * Durability:
 *   JSONL at ~/.soma-work/llm-children.jsonl. Every append/remove goes through
 *   a WriteQueue.run (store-wide serialization) and a mutateAndPersist with
 *   snapshot rollback on atomicRewrite failure.
 *
 * PID-reuse safety (v8 — D29):
 *   At spawn we capture `ps -o lstart=,args= -p <pid>` to get:
 *     - startTimeToken: human-readable start-time line (unique per process lifetime)
 *     - cmdFingerprint: sha256(first 12 hex) of the args line
 *   At reap, before sending any signal, we re-run ps and compare. If the PID is
 *   alive but fingerprint mismatches, the PID has been reused by an unrelated
 *   process — drop the record, send nothing. Log llm.orphan.pid-reused.
 *
 * Reap invariant (D24):
 *   A record is removed from the file iff kill(pid, 0) confirms the process gone.
 *   Still-alive children after SIGKILL+2s are persisted with reapAttempts++ so the
 *   next boot can retry. reapAttempts > 10 → llm.orphan.unkillable (keep record).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { StderrLogger } from '../../_shared/stderr-logger.js';
import { WriteQueue } from './write-queue.js';
import type { Backend } from './types.js';

const DEFAULT_DIR = path.join(os.homedir(), '.soma-work');
const DEFAULT_FILE = 'llm-children.jsonl';

const logger = new StderrLogger('ChildRegistry');

export interface ChildRecord {
  pid: number;
  backend: Backend;
  spawnedAt: string;
  startTimeToken: string;
  cmdFingerprint: string;
  reapAttempts?: number;
  lastReapAt?: string;
}

export interface Fingerprint {
  startTimeToken: string;
  cmdFingerprint: string;
}

// ── Fingerprint capture ───────────────────────────────────

/**
 * Capture start-time + command-line fingerprint for a PID via `ps`.
 * Returns null on ps absence/error/unexpected output (caller falls back to
 * plain PID-based reap).
 *
 * Uses `execFileSync` (no shell) with a tight 2s timeout.
 */
export function captureFingerprint(pid: number): Fingerprint | null {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=,args=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!out) return null;
    // `ps -o lstart=,args=` emits start-time followed by args on ONE line.
    // lstart on macOS/Linux is always 24 chars: "Fri Apr 18 10:23:45 2026"
    // Be defensive: take first 24 chars if ≥25; else split on last space pair.
    const line = out.split('\n')[0];
    if (line.length < 25) return null;
    const startTimeToken = line.slice(0, 24);
    const argsLine = line.slice(24).trim();
    if (!argsLine) return null;
    const cmdFingerprint = crypto.createHash('sha256').update(argsLine).digest('hex').slice(0, 12);
    return { startTimeToken, cmdFingerprint };
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

/**
 * Poll kill(pid, 0) until it throws (process gone) or maxMs elapses.
 * Returns true iff confirmed dead.
 */
export async function pollUntilDead(pid: number, maxMs: number): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await sleep(100);
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── Store ─────────────────────────────────────────────────

export interface ChildRegistryDeps {
  /** Test seam: override PID fingerprint capture. Defaults to the real `ps`-backed impl. */
  captureFingerprint?: (pid: number) => Fingerprint | null;
}

export class ChildRegistry {
  public readonly writeQueue = new WriteQueue();

  private readonly filePath: string;
  private readonly captureFingerprint: (pid: number) => Fingerprint | null;
  private records: ChildRecord[] = [];
  private loaded = false;

  constructor(filePath?: string, deps: ChildRegistryDeps = {}) {
    this.filePath = filePath ?? path.join(DEFAULT_DIR, DEFAULT_FILE);
    this.captureFingerprint = deps.captureFingerprint ?? captureFingerprint;
  }

  /**
   * Append a record for a freshly spawned child. Captures the PID fingerprint
   * immediately so a later orphan reap can verify the PID has not been reused.
   */
  async append(pid: number, backend: Backend): Promise<void> {
    this.ensureLoaded();
    const fp = this.captureFingerprint(pid);
    if (!fp) {
      logger.warn('llm.fingerprint.unavailable', { pid, phase: 'append' });
    }
    const rec: ChildRecord = {
      pid,
      backend,
      spawnedAt: new Date().toISOString(),
      startTimeToken: fp?.startTimeToken ?? '',
      cmdFingerprint: fp?.cmdFingerprint ?? '',
    };
    await this.mutateAndPersist((recs) => {
      recs.push(rec);
    });
  }

  async remove(pid: number): Promise<void> {
    this.ensureLoaded();
    await this.mutateAndPersist((recs) => {
      const idx = recs.findIndex((r) => r.pid === pid);
      if (idx >= 0) recs.splice(idx, 1);
    });
  }

  /**
   * Reap orphans left behind by a prior crashed instance. Called exactly once
   * at boot, AFTER acquiring the pidfile lock.
   */
  async replayAndReap(): Promise<void> {
    this.ensureLoaded();
    const candidates = [...this.records];
    const survivors: ChildRecord[] = [];

    for (const rec of candidates) {
      if (!isAlive(rec.pid)) {
        logger.info('llm.orphan.dead-on-boot', { pid: rec.pid, backend: rec.backend });
        continue;
      }

      // PID reuse check — only if we have a stored fingerprint to compare.
      if (rec.startTimeToken && rec.cmdFingerprint) {
        const current = this.captureFingerprint(rec.pid);
        if (current) {
          if (
            current.startTimeToken !== rec.startTimeToken ||
            current.cmdFingerprint !== rec.cmdFingerprint
          ) {
            logger.warn('llm.orphan.pid-reused', {
              pid: rec.pid,
              stored: {
                startTimeToken: rec.startTimeToken,
                cmdFingerprint: rec.cmdFingerprint,
              },
              current,
            });
            // Drop the record: the PID is now an unrelated process.
            continue;
          }
        } else {
          logger.warn('llm.fingerprint.unavailable', { pid: rec.pid, phase: 'reap' });
          // Fall through — plain PID-based reap is the best we have.
        }
      }

      // SIGTERM, poll 5s.
      try { process.kill(rec.pid, 'SIGTERM'); } catch { /* possibly raced */ }
      let dead = await pollUntilDead(rec.pid, 5_000);

      if (!dead) {
        try { process.kill(rec.pid, 'SIGKILL'); } catch { /* ignore */ }
        dead = await pollUntilDead(rec.pid, 2_000);
      }

      if (dead) {
        logger.warn('llm.orphan.reaped', {
          pid: rec.pid,
          backend: rec.backend,
          attempts: (rec.reapAttempts ?? 0) + 1,
        });
        continue;
      }

      // Still alive after SIGKILL+2s — persist for next-boot retry.
      const attempts = (rec.reapAttempts ?? 0) + 1;
      const next: ChildRecord = {
        ...rec,
        reapAttempts: attempts,
        lastReapAt: new Date().toISOString(),
      };
      survivors.push(next);
      if (attempts > 10) {
        logger.error('llm.orphan.unkillable', {
          pid: rec.pid,
          backend: rec.backend,
          attempts,
        });
      } else {
        logger.error('llm.orphan.reap-failed', {
          pid: rec.pid,
          backend: rec.backend,
          attempts,
        });
      }
    }

    await this.mutateAndPersist((recs) => {
      recs.splice(0, recs.length, ...survivors);
    });
  }

  /**
   * Called during graceful shutdown. Terminates any still-live children
   * recorded here (in case the runtime did not remove them).
   */
  async shutdownAll(): Promise<void> {
    this.ensureLoaded();
    const live = this.records.filter((r) => isAlive(r.pid));
    for (const r of live) {
      try { process.kill(r.pid, 'SIGTERM'); } catch { /* ignore */ }
    }
    await Promise.all(live.map((r) => pollUntilDead(r.pid, 3_000)));
    for (const r of live) {
      if (isAlive(r.pid)) {
        try { process.kill(r.pid, 'SIGKILL'); } catch { /* ignore */ }
      }
    }
    await this.mutateAndPersist((recs) => {
      const still = recs.filter((r) => isAlive(r.pid));
      recs.splice(0, recs.length, ...still);
    });
  }

  /** Test seam: snapshot of current in-memory records. */
  getRecords(): ChildRecord[] {
    this.ensureLoaded();
    return this.records.map((r) => ({ ...r }));
  }

  // ── Internal ──────────────────────────────────────────

  private async mutateAndPersist(mutator: (recs: ChildRecord[]) => void): Promise<void> {
    return this.writeQueue.run(async () => {
      const snapshot = this.records.map((r) => ({ ...r }));
      try {
        mutator(this.records);
        await this.atomicRewrite();
      } catch (err) {
        this.records = snapshot;
        throw err;
      }
    });
  }

  private async atomicRewrite(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.promises.mkdir(dir, { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    const lines = this.records.map((r) => JSON.stringify(r));
    const body = lines.length > 0 ? `${lines.join('\n')}\n` : '';
    await fs.promises.writeFile(tmpPath, body, 'utf-8');
    const fh = await fs.promises.open(tmpPath, 'r+');
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.promises.rename(tmpPath, this.filePath);
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    let body: string;
    try {
      body = fs.readFileSync(this.filePath, 'utf-8');
    } catch (err: any) {
      if (err?.code === 'ENOENT') return;
      // Best-effort: if readable at all, treat as empty and log.
      logger.warn('llm.child-registry.read-failed', { message: String(err?.message ?? err) });
      return;
    }
    const lines = body.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (
          parsed &&
          typeof parsed.pid === 'number' &&
          (parsed.backend === 'codex' || parsed.backend === 'gemini') &&
          typeof parsed.spawnedAt === 'string'
        ) {
          this.records.push({
            pid: parsed.pid,
            backend: parsed.backend,
            spawnedAt: parsed.spawnedAt,
            startTimeToken: typeof parsed.startTimeToken === 'string' ? parsed.startTimeToken : '',
            cmdFingerprint: typeof parsed.cmdFingerprint === 'string' ? parsed.cmdFingerprint : '',
            reapAttempts: typeof parsed.reapAttempts === 'number' ? parsed.reapAttempts : undefined,
            lastReapAt: typeof parsed.lastReapAt === 'string' ? parsed.lastReapAt : undefined,
          });
        }
      } catch {
        logger.warn('llm.child-registry.malformed', { preview: trimmed.slice(0, 80) });
      }
    }
  }
}
