/**
 * Instance heartbeat registry — discovery layer for multi-instance dashboard
 * aggregation (#814).
 *
 * Each running soma-work instance writes a small JSON file
 * `<HEARTBEAT_DIR>/<port>.json` and refreshes its `lastSeen` timestamp every
 * few seconds. Other instances on the same machine can read the directory to
 * find sibling instances and call their public API.
 *
 * The directory defaults to `~/.soma/instances` and can be overridden by the
 * `SOMA_INSTANCE_DIR` environment variable (used by tests and by operators
 * who want a non-default location).
 *
 * Stale records (lastSeen older than {@link STALE_THRESHOLD_MS}) are filtered
 * out by {@link readAllInstances} — they're left on disk for the owner
 * process (or the next start on the same port) to overwrite, so a crashed
 * instance is harmless rather than fatal.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Logger } from '../logger';

const logger = new Logger('InstanceRegistry');

/**
 * Records older than this are treated as stale and excluded from
 * {@link readAllInstances}. The 30 s window matches the spec in #814 and
 * gives the heartbeat loop (5 s default) ~6 attempts before a sibling is
 * considered dead.
 */
export const STALE_THRESHOLD_MS = 30_000;

/** Default refresh cadence for {@link startHeartbeatLoop}. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;

export interface HeartbeatPayload {
  /** Listening port — also the filename stem (`<port>.json`). */
  port: number;
  /**
   * Operator-supplied instance label (e.g. `oudwood-dev`). When empty the
   * caller is expected to fall back to `${hostname}:${port}` upstream.
   */
  instanceName: string;
  /** Resolvable hostname (or bind address) for the instance. */
  host: string;
  /** OS process id — used by the aggregator to defend against port reuse. */
  pid: number;
}

export interface InstanceRecord extends HeartbeatPayload {
  /** Epoch ms of the most recent heartbeat write. */
  lastSeen: number;
}

/**
 * Resolve the heartbeat directory.
 *
 * `SOMA_INSTANCE_DIR` wins so tests can pin to a temp dir and operators can
 * relocate the registry without code changes. Otherwise we use
 * `~/.soma/instances`, which lives alongside other soma state under the
 * user's home directory.
 *
 * Resolution happens at call time, not at module load — tests mutate the
 * env var between cases, so caching here would leak state across describes.
 */
function getHeartbeatDir(): string {
  const override = process.env.SOMA_INSTANCE_DIR;
  if (override && override.length > 0) return override;
  return path.join(os.homedir(), '.soma', 'instances');
}

/**
 * Atomically write `<dir>/<port>.json` with mode 0600.
 *
 * Atomicity: we write to a unique temp file in the same directory, then
 * `rename()` over the target. POSIX rename is atomic within a filesystem,
 * so a concurrent reader either sees the previous payload or the new one
 * — never a half-written stream.
 *
 * The 0600 mode is requested on the temp file before rename. The
 * effective bits are subject to the process umask (Node honours the
 * caller's umask for `fs.writeFile`'s `mode`); operators with a
 * non-default umask may see a tighter mode but never a looser one,
 * which is the safe direction. The `instance-registry.test.ts` test
 * pins the expected `0o600` on POSIX hosts and skips the assertion on
 * Windows where POSIX permission bits are not meaningful.
 */
export async function writeHeartbeat(payload: HeartbeatPayload): Promise<void> {
  const dir = getHeartbeatDir();
  await fs.mkdir(dir, { recursive: true });

  const target = path.join(dir, `${payload.port}.json`);
  // Per-process random suffix keeps concurrent writers from clobbering each
  // other's temp files. process.pid alone isn't enough — the heartbeat
  // loop may overlap with itself if the disk is slow.
  const tmp = path.join(dir, `${payload.port}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`);

  const record: InstanceRecord = {
    ...payload,
    lastSeen: Date.now(),
  };

  try {
    await fs.writeFile(tmp, JSON.stringify(record), { mode: 0o600 });
    await fs.rename(tmp, target);
  } catch (err) {
    // Defensive cleanup: if rename failed, the tmp may linger.
    try {
      await fs.unlink(tmp);
    } catch {
      // ignore — tmp may already be gone
    }
    throw err;
  }
}

/**
 * Read all heartbeat files in the registry directory and return non-stale
 * instance records. Bad / non-JSON files are skipped silently (with a
 * warn log) — a corrupt file from a crashed write must not break sibling
 * discovery for the rest of the registry.
 */
export async function readAllInstances(): Promise<InstanceRecord[]> {
  const dir = getHeartbeatDir();
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    logger.warn('Failed to read instance registry directory', { dir, err });
    return [];
  }

  const now = Date.now();
  const out: InstanceRecord[] = [];

  for (const name of entries) {
    // The atomic-write tmp files end in `.tmp` — the `.json` filter
    // already excludes them; we'd only revisit if something started
    // landing tmp suffixes inside `.json` filenames, which the writer
    // contract forbids. Drop the redundant guard.
    if (!name.endsWith('.json')) continue;
    const full = path.join(dir, name);
    let raw: string;
    try {
      raw = await fs.readFile(full, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // ENOENT is benign — the file vanished mid-readdir (heartbeat
      // overwrite race). EACCES / EIO are real and must surface so an
      // operator can fix permissions instead of seeing silently empty
      // sibling discovery.
      if (code !== 'ENOENT') {
        logger.warn('Heartbeat file read failed', { name, code });
      }
      continue;
    }
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      logger.warn('Skipping unparseable heartbeat file', { name });
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    if (typeof parsed.port !== 'number') continue;
    if (typeof parsed.lastSeen !== 'number') continue;
    if (now - parsed.lastSeen > STALE_THRESHOLD_MS) continue;
    out.push({
      port: parsed.port,
      instanceName: typeof parsed.instanceName === 'string' ? parsed.instanceName : '',
      host: typeof parsed.host === 'string' ? parsed.host : '127.0.0.1',
      pid: typeof parsed.pid === 'number' ? parsed.pid : 0,
      lastSeen: parsed.lastSeen,
    });
  }

  return out;
}

/**
 * Delete the heartbeat file for a given port. No-op if it doesn't exist
 * (covers the case where shutdown runs twice or the file was never
 * written successfully).
 */
export async function removeHeartbeat(port: number): Promise<void> {
  const dir = getHeartbeatDir();
  const target = path.join(dir, `${port}.json`);
  try {
    await fs.unlink(target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    logger.warn('Failed to remove heartbeat file', { target, err });
  }
}

/**
 * Start a refresh loop that writes the heartbeat immediately and then again
 * every `intervalMs` (default {@link DEFAULT_HEARTBEAT_INTERVAL_MS}). The
 * returned handle can be passed to `clearInterval` for shutdown cleanup.
 *
 * The immediate write covers the dashboard-aggregator race where
 * `:33000` boots and a user opens its page before the first interval
 * tick has fired.
 */
export function startHeartbeatLoop(
  payload: HeartbeatPayload,
  intervalMs: number = DEFAULT_HEARTBEAT_INTERVAL_MS,
): NodeJS.Timeout {
  // Fire-and-forget the kick-off write — errors are logged but must not
  // block the interval (otherwise a transient mkdir failure would silently
  // disable discovery for the lifetime of the process).
  void writeHeartbeat(payload).catch((err) => {
    logger.warn('Initial heartbeat write failed', err);
  });
  const handle = setInterval(() => {
    void writeHeartbeat(payload).catch((err) => {
      logger.warn('Heartbeat refresh failed', err);
    });
  }, intervalMs);
  // Allow the process to exit even if the interval is still scheduled.
  if (typeof handle.unref === 'function') handle.unref();
  return handle;
}
