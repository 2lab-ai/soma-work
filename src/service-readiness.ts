/**
 * Daemon instance identity and readiness.
 *
 * ## Why this module exists
 *
 * The PID lock answers "a soma-work process holds this data directory". That is
 * not the question the service manager needs answered. `acquirePidLock` runs at
 * `src/index.ts:121` — before the token manager, before preflight, before the
 * web server, and several seconds before `await app.start()` resolves. A
 * controller that treats the lock as readiness declares victory at roughly
 * boot-second one, which is exactly how a green install receipt and a
 * ten-second `KeepAlive` crashloop end up coexisting.
 *
 * So the daemon publishes a second, narrower fact — *I have connected* — on the
 * far side of `app.start()`, and retracts it on every exit path. Design §5 Step
 * 6 requires "Slack Socket Mode connected state"; this is the daemon's own
 * report of it, which a token probe run from the CLI cannot substitute for (a
 * valid app token says nothing about whether *this* process got a socket).
 *
 * ## Why it is separate from `pid-lock.ts`
 *
 * The controller has to read both facts without importing the daemon, and both
 * sides have to agree on two filenames. A field bolted onto the lock file would
 * force `pid-lock` — which the daemon imports at boot — into the CLI's module
 * graph, and would make the lock's format the controller's problem. Here the
 * two filenames and the two content formats have exactly one owner, and
 * `pid-lock.ts` consumes them like everybody else.
 *
 * ## Instance identity, not just a PID
 *
 * Both files record `{pid, startedAtMs}` where `startedAtMs` is the process's
 * *start* time (`now - uptime`), not the moment the file was written. That one
 * change is what makes PID reuse detectable: a stale lock left by a `SIGKILL`
 * or a power cut names a number the OS is free to hand to an unrelated process,
 * and "the PID is alive" is then true of the wrong process. Comparing the
 * recorded start against the candidate's — or, when the platform cannot report
 * another process's start time, against the machine's boot time — turns that
 * from a coin flip into a refusal.
 *
 * Nothing here carries a credential: the marker holds two integers, and the
 * shape is asserted in tests so a future field cannot smuggle one in.
 */

import { atomicWriteFile } from '@soma/common/atomic-write';
import * as fs from 'fs';
import * as path from 'path';

/** The daemon's single-instance lock, written by `src/pid-lock.ts`. */
export const PID_LOCK_FILENAME = 'soma-work.pid';

/** The daemon's post-`app.start()` readiness marker. */
export const READY_MARKER_FILENAME = 'soma-work.ready';

/** Mode for the readiness marker: owner-only, like every other profile file. */
const READY_MARKER_MODE = 0o600;

/**
 * Which process, and which *run* of it.
 *
 * `startedAtMs` is the discriminator. Two runs of the daemon can share a PID
 * (the OS recycles them); they cannot share a start time.
 */
export interface DaemonInstance {
  pid: number;
  startedAtMs: number;
}

/**
 * This process's start time in epoch milliseconds.
 *
 * `Date.now() - uptime` rather than "the time we wrote the file", so the value
 * is a property of the process and stays comparable no matter when it is
 * recorded. Arguments are injectable so the arithmetic is testable without
 * waiting for wall-clock time to move.
 */
export function processStartedAtMs(now: number = Date.now(), uptimeSeconds: number = process.uptime()): number {
  return now - Math.round(uptimeSeconds * 1000);
}

/**
 * Tolerance for comparing a recorded start against an EXTERNALLY observed one.
 *
 * Sources for another process's start time report seconds, not milliseconds, so
 * an exact comparison would reject a genuine match. This slack applies only to
 * that external check; the lock↔marker comparison stays exact, because both
 * sides are written by this process from one cached value and any drift there
 * is a bug rather than a precision limit.
 */
export const START_IDENTITY_TOLERANCE_MS = 2_000;

/**
 * Memoized so the lock and the readiness marker — written seconds apart during
 * a multi-second boot — record the SAME instance.
 *
 * `Date.now() - uptime` is recomputed on every call and drifts by a millisecond
 * or two across a boot. `sameDaemonInstance` is exact, so an unmemoized
 * identity would have the daemon publish readiness its own lock contradicts,
 * and the controller would never see the service as running.
 */
let cachedInstance: DaemonInstance | null = null;

/** Identity of the running process; computed once, then reused verbatim. */
export function currentDaemonInstance(): DaemonInstance {
  if (cachedInstance === null) {
    cachedInstance = Object.freeze({ pid: process.pid, startedAtMs: processStartedAtMs() }) as DaemonInstance;
  }
  return cachedInstance;
}

/** Test-only: forget the cached identity so a case can simulate a fresh process. */
export function resetDaemonInstanceForTests(): void {
  cachedInstance = null;
}

/**
 * Does an externally observed process start match a recorded one?
 *
 * `null` means the platform could not tell us, which is "unknown", not
 * "mismatch" — refusing on unknown would make `stop` unable to stop anything on
 * a machine with no shell-free start-time source.
 */
export function matchesProcessStart(recordedMs: number, observedMs: number | null): boolean {
  if (observedMs === null) return true;
  return Math.abs(observedMs - recordedMs) <= START_IDENTITY_TOLERANCE_MS;
}

export function pidLockPath(dataDir: string): string {
  return path.join(dataDir, PID_LOCK_FILENAME);
}

export function readyMarkerPath(dataDir: string): string {
  return path.join(dataDir, READY_MARKER_FILENAME);
}

/** Lock file body: `<pid>:<startedAtMs>`. */
export function formatPidLockContent(instance: DaemonInstance): string {
  return `${instance.pid}:${instance.startedAtMs}`;
}

const PID_LOCK_PATTERN = /^(\d+):(\d+)$/;

/**
 * Parse a lock file body into an instance.
 *
 * A bare legacy `<pid>` is deliberately rejected: it carries no instance
 * identity, so nothing can distinguish "our daemon" from "whatever now holds
 * that number", and the honest answer for a caller about to send SIGKILL is
 * "unknown", not "probably ours". PIDs 0 and 1 are rejected outright — `kill(0)`
 * addresses the caller's whole process group and `kill(-1)` every process the
 * user may signal.
 */
export function parsePidLockContent(raw: string | null | undefined): DaemonInstance | null {
  if (typeof raw !== 'string') return null;
  const match = PID_LOCK_PATTERN.exec(raw.trim());
  if (match === null) return null;
  const pid = Number.parseInt(match[1], 10);
  const startedAtMs = Number.parseInt(match[2], 10);
  if (!Number.isInteger(pid) || pid <= 1) return null;
  if (!Number.isInteger(startedAtMs) || startedAtMs <= 0) return null;
  return { pid, startedAtMs };
}

/** Readiness marker body: the instance, and nothing else. */
export function formatReadyMarker(instance: DaemonInstance): string {
  return `${JSON.stringify({ pid: instance.pid, startedAtMs: instance.startedAtMs })}\n`;
}

/** Parse a readiness marker body, tolerating every kind of garbage as "not ready". */
export function parseReadyMarker(raw: string | null | undefined): DaemonInstance | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const { pid, startedAtMs } = parsed as Record<string, unknown>;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1) return null;
  if (typeof startedAtMs !== 'number' || !Number.isInteger(startedAtMs) || startedAtMs <= 0) return null;
  return { pid, startedAtMs };
}

/** True when both sides describe the same run of the same process. */
export function sameDaemonInstance(a: DaemonInstance | null, b: DaemonInstance | null): boolean {
  if (a === null || b === null) return false;
  return a.pid === b.pid && a.startedAtMs === b.startedAtMs;
}

/**
 * Publish readiness for `instance`.
 *
 * Call sites: exactly one, immediately after `await app.start()` resolves.
 * Writing it anywhere earlier reintroduces the bug this module exists to close.
 */
export function markDaemonReady(dataDir: string, instance: DaemonInstance = currentDaemonInstance()): void {
  atomicWriteFile(readyMarkerPath(dataDir), formatReadyMarker(instance), {
    mode: READY_MARKER_MODE,
    // Owner-only for a directory this call has to CREATE, but never a chmod of
    // one that already exists. Setup and the service install already guarantee
    // a profile's data root is 0700; readiness is a status publication, not
    // permission repair, and `DATA_DIR` is not always a profile directory.
    dirMode: 0o700,
    tightenExistingDir: false,
    backup: false,
  });
}

/** The one thing a failed readiness publication is allowed to say. */
export const READINESS_PUBLISH_WARNING =
  '[service-readiness] WARN could not publish the daemon readiness marker; the service manager will report this run as not ready.';

/** What {@link publishDaemonReadiness} did. */
export type ReadinessPublishOutcome = 'published' | 'skipped' | 'failed';

/**
 * Publish readiness from the daemon — and never take the daemon down doing it.
 *
 * Two rules, both learned the hard way:
 *
 * **1. Only a profile-supervised run publishes.** The marker is a contract with
 * the service manager, and the service manager only exists for installed
 * profiles. A legacy source-tree run binds `DATA_DIR` to `<repo>/data`, inside
 * the operator's checkout; writing a status file there — and creating that
 * directory if it is missing — is not this function's business. The gate is the
 * fixed `SOMA_DATA_DIR` the LaunchAgent sets, and it must RESOLVE to the
 * canonical `DATA_DIR` the daemon actually uses, so a mismatch means "not the
 * profile runtime" rather than "close enough".
 *
 * **2. A write failure is a warning, not an exit.** The call site sits inside
 * the daemon's outer `try`/`catch`, whose handler is `process.exit(1)`, on the
 * far side of `await app.start()`. `atomicWriteFile` refuses a symlinked
 * ancestor (a `~/.local/share` pointed at another volume) and can fail on
 * EROFS/ENOSPC/EACCES/EDQUOT — none of which say anything about the Slack
 * socket that just connected. Unwrapped, that turns a working bot into a
 * ten-second `KeepAlive` crashloop: the precise failure the marker was
 * introduced to make visible, now caused by the marker. So the daemon keeps
 * running, the controller times out on readiness, and the operator gets
 * `not-live` — a legible failure with the bot still answering.
 *
 * The warning carries no path, no errno, and no exception text: this runs on a
 * machine where the log is the thing an operator pastes into an issue.
 */
export function publishDaemonReadiness(options: {
  /** The canonical `DATA_DIR` the daemon is using. */
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  warn?: (message: string) => void;
  instance?: DaemonInstance;
}): ReadinessPublishOutcome {
  const env = options.env ?? process.env;
  const fixed = env.SOMA_DATA_DIR?.trim();
  if (!fixed) return 'skipped';
  if (path.resolve(fixed) !== path.resolve(options.dataDir)) return 'skipped';

  try {
    markDaemonReady(options.dataDir, options.instance ?? currentDaemonInstance());
    return 'published';
  } catch {
    (options.warn ?? ((message: string) => console.warn(message)))(READINESS_PUBLISH_WARNING);
    return 'failed';
  }
}

/**
 * Retract readiness published by THIS process.
 *
 * Ownership-checked for the same reason `releasePidLock` is: a dying instance
 * must not clear a marker a successor has already published.
 *
 * Synchronous and exception-free by construction: it runs inside `process.on
 * ('exit')`, where an async call would never complete and a throw would mask
 * the real exit reason.
 *
 * `force` exists for one caller — {@link clearStaleDaemonReady} — and is not
 * part of the daemon's exit path. Startup must never force-clear before it owns
 * the PID lock: a second process that is about to lose the lock race would
 * erase the running daemon's valid readiness on its way out, leaving a healthy
 * service that every controller reads as dead.
 */
export function clearDaemonReady(dataDir: string, opts: { force?: boolean } = {}): void {
  const marker = readyMarkerPath(dataDir);
  try {
    if (opts.force !== true) {
      const existing = readDaemonReady(dataDir);
      if (existing === null || existing.pid !== process.pid) return;
    }
    fs.unlinkSync(marker);
  } catch {
    // Already gone, or never written. Nothing actionable on an exit path.
  }
}

/**
 * Drop a readiness marker that does not describe this instance.
 *
 * Call this only AFTER the PID lock has been acquired: holding the lock is what
 * makes "the marker is not mine" mean "the marker is stale" rather than "the
 * marker belongs to the daemon that beat me to it".
 */
export function clearStaleDaemonReady(dataDir: string): void {
  const existing = readDaemonReady(dataDir);
  if (existing === null) return;
  if (sameDaemonInstance(existing, currentDaemonInstance())) return;
  clearDaemonReady(dataDir, { force: true });
}

/** Read the readiness marker. A symlinked marker is "not ready", never followed. */
export function readDaemonReady(dataDir: string): DaemonInstance | null {
  const marker = readyMarkerPath(dataDir);
  try {
    if (fs.lstatSync(marker).isSymbolicLink()) return null;
    return parseReadyMarker(fs.readFileSync(marker, 'utf-8'));
  } catch {
    return null;
  }
}
