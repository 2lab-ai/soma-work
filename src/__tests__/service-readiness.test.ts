/**
 * Daemon readiness marker (Task 9 fix round 1, finding I2).
 *
 * The PID lock is acquired at `src/index.ts:121` — before the token manager,
 * before preflight, before the web server, and several seconds before
 * `await app.start()` resolves at `src/index.ts:849`. A controller that waits
 * on the lock therefore declares victory at roughly boot-second one, which is
 * how a green install receipt and a 10-second `KeepAlive` crashloop coexist.
 *
 * This module is the daemon's own answer to "am I actually connected", and it
 * is deliberately a separate pure module rather than a field bolted onto
 * pid-lock: the controller has to read it without importing the daemon, and
 * both sides have to agree on the two filenames without duplicating literals.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LOCK_FILENAME } from '../pid-lock';
import {
  clearDaemonReady,
  clearStaleDaemonReady,
  currentDaemonInstance,
  type DaemonInstance,
  markDaemonReady,
  matchesProcessStart,
  PID_LOCK_FILENAME,
  parsePidLockContent,
  processStartedAtMs,
  publishDaemonReadiness,
  READINESS_PUBLISH_WARNING,
  READY_MARKER_FILENAME,
  readDaemonReady,
  sameDaemonInstance,
} from '../service-readiness';

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-ready-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('filename ownership (M7)', () => {
  it('is the single owner of both daemon-instance filenames', () => {
    expect(PID_LOCK_FILENAME).toBe('soma-work.pid');
    expect(READY_MARKER_FILENAME).toBe('soma-work.ready');
    // pid-lock consumes the same constant instead of holding a private literal.
    expect(LOCK_FILENAME).toBe(PID_LOCK_FILENAME);
  });
});

describe('process-start identity', () => {
  it('derives a start time from now minus uptime, not from "when we happened to write"', () => {
    expect(processStartedAtMs(1_700_000_000_000, 12.5)).toBe(1_700_000_000_000 - 12_500);
  });

  it('describes this process consistently across calls', () => {
    const a = currentDaemonInstance();
    const b = currentDaemonInstance();
    expect(a.pid).toBe(process.pid);
    // Same process ⇒ same identity, within the rounding of `process.uptime()`.
    expect(Math.abs(a.startedAtMs - b.startedAtMs)).toBeLessThanOrEqual(50);
  });
});

describe('pid lock content', () => {
  it('parses "<pid>:<startedAtMs>" into an instance', () => {
    expect(parsePidLockContent('4242:1700000000000')).toEqual({ pid: 4242, startedAtMs: 1_700_000_000_000 });
  });

  it('refuses a legacy bare PID: an instance-less lock cannot be matched to a process', () => {
    expect(parsePidLockContent('4242')).toBeNull();
    expect(parsePidLockContent('nonsense')).toBeNull();
    expect(parsePidLockContent('0:1700000000000')).toBeNull();
  });
});

describe('marker lifecycle', () => {
  const instance: DaemonInstance = { pid: 4242, startedAtMs: 1_700_000_000_000 };

  it('writes an owner-only marker carrying only the instance identity', () => {
    markDaemonReady(dataDir, instance);
    const file = path.join(dataDir, READY_MARKER_FILENAME);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const body = fs.readFileSync(file, 'utf-8');
    expect(JSON.parse(body)).toEqual({ pid: 4242, startedAtMs: 1_700_000_000_000 });
    // Nothing else may ride along.
    expect(Object.keys(JSON.parse(body)).sort()).toEqual(['pid', 'startedAtMs']);
  });

  it('reads back the instance it wrote', () => {
    markDaemonReady(dataDir, instance);
    expect(readDaemonReady(dataDir)).toEqual(instance);
  });

  it('reports no readiness when the marker is absent, empty, or unparseable', () => {
    expect(readDaemonReady(dataDir)).toBeNull();
    fs.writeFileSync(path.join(dataDir, READY_MARKER_FILENAME), '');
    expect(readDaemonReady(dataDir)).toBeNull();
    fs.writeFileSync(path.join(dataDir, READY_MARKER_FILENAME), '{"pid":"nope"}');
    expect(readDaemonReady(dataDir)).toBeNull();
  });

  it('refuses to read a symlinked marker', () => {
    const real = path.join(dataDir, 'elsewhere.json');
    fs.writeFileSync(real, JSON.stringify(instance));
    fs.symlinkSync(real, path.join(dataDir, READY_MARKER_FILENAME));
    expect(readDaemonReady(dataDir)).toBeNull();
  });

  it('clears only a marker this process owns', () => {
    markDaemonReady(dataDir, { pid: process.pid, startedAtMs: processStartedAtMs() });
    clearDaemonReady(dataDir);
    expect(fs.existsSync(path.join(dataDir, READY_MARKER_FILENAME))).toBe(false);

    markDaemonReady(dataDir, instance); // another pid
    clearDaemonReady(dataDir);
    expect(fs.existsSync(path.join(dataDir, READY_MARKER_FILENAME))).toBe(true);
  });

  it('clears unconditionally when asked to drop a stale marker at startup', () => {
    markDaemonReady(dataDir, instance);
    clearDaemonReady(dataDir, { force: true });
    expect(fs.existsSync(path.join(dataDir, READY_MARKER_FILENAME))).toBe(false);
  });
});

describe('sameDaemonInstance', () => {
  it('requires both the PID and the process-start identity to match', () => {
    const a: DaemonInstance = { pid: 4242, startedAtMs: 1_700_000_000_000 };
    expect(sameDaemonInstance(a, { ...a })).toBe(true);
    expect(sameDaemonInstance(a, { pid: 4243, startedAtMs: a.startedAtMs })).toBe(false);
    // The PID-reuse case: same number, different process.
    expect(sameDaemonInstance(a, { pid: 4242, startedAtMs: 1_700_000_999_999 })).toBe(false);
    expect(sameDaemonInstance(a, null)).toBe(false);
    expect(sameDaemonInstance(null, a)).toBe(false);
  });
});

/**
 * Two races the first cut of this module lost.
 *
 * **A losing second startup must not disarm the incumbent.** Clearing the
 * readiness marker before the PID lock is acquired means process B — which is
 * about to discover that A already holds the lock and exit — first erases A's
 * valid "I am connected". A then stays up, unchanged and unaware, while every
 * controller reads it as not-ready and starts tearing it down.
 *
 * **The lock and the marker must name the SAME instance.** `Date.now() -
 * uptime` is recomputed on every call and drifts by a millisecond or two
 * between the lock write at boot-second one and the marker write several
 * seconds later. Two values that differ by 1ms are two different instances to
 * `sameDaemonInstance`, so the daemon would publish readiness that its own lock
 * contradicts and never be seen as running at all.
 */
describe('instance identity is computed once per process', () => {
  it('is stable across wall-clock movement, to the millisecond', async () => {
    const first = currentDaemonInstance();
    // Real elapsed time, the way the daemon's multi-second boot supplies it.
    await new Promise((resolve) => setTimeout(resolve, 60));
    const second = currentDaemonInstance();
    // Identity, not just equality: recomputing `Date.now() - uptime` may agree
    // by luck on one run and differ by a millisecond on the next, and a
    // one-millisecond difference is a different instance to every comparison
    // in this module.
    expect(second).toBe(first);
    expect(sameDaemonInstance(first, second)).toBe(true);
  });

  it('makes the lock and the readiness marker agree exactly', async () => {
    const { acquirePidLock, releasePidLock } = await import('../pid-lock');
    try {
      expect(acquirePidLock(dataDir)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 60));
      markDaemonReady(dataDir);

      const lock = parsePidLockContent(fs.readFileSync(path.join(dataDir, PID_LOCK_FILENAME), 'utf-8'));
      const ready = readDaemonReady(dataDir);
      expect(lock).not.toBeNull();
      expect(sameDaemonInstance(lock, ready)).toBe(true);
    } finally {
      releasePidLock(dataDir);
    }
  });
});

describe('clearStaleDaemonReady', () => {
  it('removes a marker left by a previous, dead run', () => {
    markDaemonReady(dataDir, { pid: 4242, startedAtMs: 1_700_000_000_000 });
    clearStaleDaemonReady(dataDir);
    expect(readDaemonReady(dataDir)).toBeNull();
  });

  it('leaves the incumbent marker alone when it names this very instance', () => {
    markDaemonReady(dataDir);
    const before = readDaemonReady(dataDir);
    clearStaleDaemonReady(dataDir);
    expect(readDaemonReady(dataDir)).toEqual(before);
  });
});

describe('external process-start comparison tolerance', () => {
  it('accepts a probe whose precision is coarser than milliseconds', () => {
    // `ps`-style sources report seconds; a same-process match must survive that.
    expect(matchesProcessStart(1_700_000_000_499, 1_700_000_000_000)).toBe(true);
    expect(matchesProcessStart(1_700_000_000_000, 1_700_000_001_000)).toBe(true);
  });

  it('still rejects a genuinely different run', () => {
    expect(matchesProcessStart(1_700_000_000_000, 1_700_000_500_000)).toBe(false);
    expect(matchesProcessStart(1_700_000_000_000, null)).toBe(true); // unknown ⇒ not a refusal on its own
  });

  it('keeps the lock↔ready comparison exact, tolerance or not', () => {
    const a = { pid: 10, startedAtMs: 1_700_000_000_000 };
    expect(sameDaemonInstance(a, { pid: 10, startedAtMs: 1_700_000_000_001 })).toBe(false);
  });
});

/**
 * Publishing readiness must never be able to kill a daemon that has just
 * connected (N3), and must never chmod a directory it does not own (N4).
 *
 * `markDaemonReady` routes through `atomicWriteFile`, which refuses a symlinked
 * ancestor and can fail on EROFS/ENOSPC/EACCES/EDQUOT. Unwrapped, inside the
 * daemon's outer `try`/`catch` whose handler is `process.exit(1)`, that turns a
 * `~/.local/share` symlinked to another volume into a ten-second `KeepAlive`
 * crashloop of a working bot — the exact failure the marker exists to make
 * visible, caused by the marker.
 *
 * And `DATA_DIR` is not always a profile directory: a legacy source-tree run
 * binds it to `<repo>/data`, inside the operator's checkout, which readiness has
 * no business tightening to 0700.
 */
describe('publishDaemonReadiness (N3/N4)', () => {
  const profileEnv = () => ({ SOMA_DATA_DIR: dataDir });

  it('publishes for a profile-supervised runtime', () => {
    const warnings: string[] = [];
    const outcome = publishDaemonReadiness({ dataDir, env: profileEnv(), warn: (m) => warnings.push(m) });
    expect(outcome).toBe('published');
    expect(readDaemonReady(dataDir)).toEqual(currentDaemonInstance());
    expect(warnings).toEqual([]);
  });

  it('writes nothing for a source-tree run, where DATA_DIR is a checkout directory', () => {
    const outcome = publishDaemonReadiness({ dataDir, env: {}, warn: () => {} });
    expect(outcome).toBe('skipped');
    expect(fs.existsSync(path.join(dataDir, READY_MARKER_FILENAME))).toBe(false);
  });

  it('writes nothing when SOMA_DATA_DIR does not resolve to the canonical DATA_DIR', () => {
    const outcome = publishDaemonReadiness({ dataDir, env: { SOMA_DATA_DIR: path.join(dataDir, 'elsewhere') } });
    expect(outcome).toBe('skipped');
    expect(fs.existsSync(path.join(dataDir, READY_MARKER_FILENAME))).toBe(false);
  });

  it('accepts a non-normalised SOMA_DATA_DIR that resolves to the same directory', () => {
    const outcome = publishDaemonReadiness({ dataDir: `${dataDir}/`, env: { SOMA_DATA_DIR: `${dataDir}/./` } });
    expect(outcome).toBe('published');
  });

  it('never throws when the marker cannot be written, and warns exactly once', () => {
    // A symlinked data directory: `acquirePidLock` does not care, `atomicWriteFile` does.
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-ready-real-'));
    const linked = path.join(dataDir, 'linked');
    fs.symlinkSync(real, linked);
    const warnings: string[] = [];
    try {
      const outcome = publishDaemonReadiness({
        dataDir: linked,
        env: { SOMA_DATA_DIR: linked },
        warn: (m) => warnings.push(m),
      });
      expect(outcome).toBe('failed');
      expect(warnings.length).toBe(1);
    } finally {
      fs.rmSync(real, { recursive: true, force: true });
    }
  });

  it('warns with a fixed message that carries no path, no errno, and no value', () => {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-ready-real2-'));
    const linked = path.join(dataDir, 'linked2');
    fs.symlinkSync(real, linked);
    const warnings: string[] = [];
    try {
      publishDaemonReadiness({ dataDir: linked, env: { SOMA_DATA_DIR: linked }, warn: (m) => warnings.push(m) });
      const message = warnings[0] ?? '';
      expect(message).toBe(READINESS_PUBLISH_WARNING);
      expect(message).not.toContain(linked);
      expect(message).not.toContain(real);
      expect(message).not.toMatch(/E[A-Z]{3,}/);
      expect(message).not.toContain('symlink');
    } finally {
      fs.rmSync(real, { recursive: true, force: true });
    }
  });

  it('does not tighten a data directory it did not create (N4)', () => {
    const loose = path.join(dataDir, 'loose');
    fs.mkdirSync(loose, { mode: 0o755 });
    fs.chmodSync(loose, 0o755);
    markDaemonReady(loose, { pid: 4242, startedAtMs: 1_700_000_000_000 });
    expect(fs.statSync(loose).mode & 0o777).toBe(0o755);
    expect(fs.statSync(path.join(loose, READY_MARKER_FILENAME)).mode & 0o777).toBe(0o600);
  });
});

/**
 * A stale lock that happens to name the PID the new daemon just received.
 *
 * `acquirePidLock` treated `parsed.pid === process.pid` as re-entrancy and
 * returned without rewriting, so the lock kept the OLD instance while the
 * marker published the NEW one — and `sameDaemonInstance` is exact, so the
 * controller's readiness gate could never be satisfied for a daemon that was
 * perfectly healthy.
 */
describe('acquirePidLock instance identity (N6)', () => {
  it('rewrites a stale lock that names this PID with a different instance', async () => {
    const { acquirePidLock, releasePidLock } = await import('../pid-lock');
    const lockPath = path.join(dataDir, PID_LOCK_FILENAME);
    fs.writeFileSync(lockPath, `${process.pid}:1700000000000`);
    try {
      expect(acquirePidLock(dataDir)).toBe(true);
      const parsed = parsePidLockContent(fs.readFileSync(lockPath, 'utf-8'));
      expect(parsed).toEqual(currentDaemonInstance());
      // And the marker the daemon publishes agrees with it, which is the whole point.
      markDaemonReady(dataDir);
      expect(sameDaemonInstance(parsed, readDaemonReady(dataDir))).toBe(true);
    } finally {
      releasePidLock(dataDir);
    }
  });

  it('leaves an exact-match lock byte-identical', async () => {
    const { acquirePidLock, releasePidLock } = await import('../pid-lock');
    const lockPath = path.join(dataDir, PID_LOCK_FILENAME);
    try {
      expect(acquirePidLock(dataDir)).toBe(true);
      const first = fs.readFileSync(lockPath, 'utf-8');
      expect(acquirePidLock(dataDir)).toBe(true);
      expect(fs.readFileSync(lockPath, 'utf-8')).toBe(first);
    } finally {
      releasePidLock(dataDir);
    }
  });
});
