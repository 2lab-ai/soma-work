/**
 * Where the daemon publishes and retracts its readiness (I2).
 *
 * `src/index.ts` cannot be imported in a unit test — it is a 1200-line module
 * that opens Slack sockets, a web server, and a PID lock at import time — so
 * this pins the seam by asserting the ORDER of the calls in the production
 * source. That is weaker than executing it and is disclosed as such in the
 * report; what it does buy is the one property that matters and that a
 * behavioural test of `service-readiness.ts` alone cannot reach: the marker is
 * written only on the far side of `await app.start()`, and every exit path
 * drops it.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf-8');

/** Byte offset of `needle`, asserted unique so a rename cannot silently pass. */
function offsetOf(needle: string): number {
  const first = SOURCE.indexOf(needle);
  expect(first, `expected to find ${JSON.stringify(needle)} in src/index.ts`).toBeGreaterThanOrEqual(0);
  expect(SOURCE.indexOf(needle, first + 1), `expected ${JSON.stringify(needle)} to be unique`).toBe(-1);
  return first;
}

describe('daemon readiness seam in src/index.ts', () => {
  it('publishes readiness only after the Slack socket is connected', () => {
    const appStart = offsetOf('await app.start();');
    const mark = offsetOf('publishDaemonReadiness({ dataDir: DATA_DIR');
    expect(mark).toBeGreaterThan(appStart);
  });

  it('publishes through the non-throwing wrapper, never the raw writer', () => {
    // `markDaemonReady` throws on a symlinked ancestor or a full disk, and this
    // call site sits inside a `catch` that calls `process.exit(1)`.
    expect(SOURCE).not.toContain('markDaemonReady(');
  });

  it('retracts readiness on the process-exit path that also releases the lock', () => {
    // The `exit` handler is the one path #1003 proved covers every exit,
    // including the watchdog trip and the crash handlers.
    const handler = SOURCE.slice(offsetOf("process.on('exit', () => {"));
    const body = handler.slice(0, handler.indexOf('});'));
    expect(body).toContain('releasePidLock(DATA_DIR)');
    expect(body).toContain('clearDaemonReady(DATA_DIR)');
  });

  it('retracts readiness on the signal cleanup path too', () => {
    const cleanup = SOURCE.slice(offsetOf('const cleanup = async () => {'));
    const body = cleanup.slice(0, cleanup.indexOf("process.on('SIGINT', cleanup)"));
    expect(body).toContain('clearDaemonReady(DATA_DIR)');
  });
});

describe('startup ordering race (coordinator correction 1)', () => {
  it('clears a stale marker only AFTER the lock is owned, never before', () => {
    const acquire = offsetOf('if (!acquirePidLock(DATA_DIR))');
    const clearStale = offsetOf('clearStaleDaemonReady(DATA_DIR)');
    // A losing second startup must exit at the lock without having touched the
    // incumbent's readiness.
    expect(clearStale).toBeGreaterThan(acquire);
  });

  it('never force-clears readiness from the daemon at all', () => {
    // `clearStaleDaemonReady` owns the ownership check; a force-clear reached
    // from here is the race, whatever it is guarded by.
    expect(SOURCE).not.toContain('clearDaemonReady(DATA_DIR, { force');
  });
});
