/**
 * U8 shutdown integration — what happens when the follow-up queue refuses to
 * freeze while the process is trying to stop.
 *
 * `RequestCoordinator.clearAll()` is fail-closed: it asks the host observer to
 * record the stop BEFORE aborting, and a refusal (durable queue-freeze write
 * failed) throws instead of aborting that session. `index.ts` called it OUTSIDE
 * the shutdown try/catch, so a refusal produced:
 *   1. a rejected `cleanup()` promise from the SIGTERM listener,
 *   2. which lands in the `unhandledRejection` handler,
 *   3. which calls `killAllSync('SIGKILL')` — force-killing the very live
 *      queries whose queue could not be frozen,
 *   4. with `isShuttingDown` stuck `true`, so no later signal can retry.
 *
 * The policy pinned here: a refusal stops the shutdown attempt *before*
 * anything is torn down, logs it, re-arms the guard so a later SIGTERM can try
 * again, and never force-kills the live queries.
 *
 * These are source-contract assertions (same approach as the neighbouring
 * `claude-child-shutdown-contract.test.ts`) because `src/index.ts` calls
 * `start()` at module scope: importing it to execute `cleanup` would boot the
 * whole bot — Slack app, schedulers, PID lock and all. The invariants below are
 * therefore checked structurally, in ORDER, so a refactor that moves the guard
 * or re-orders teardown trips them.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8');

/** The graceful-shutdown closure, from its declaration to the SIGINT wiring. */
function cleanupSection(): string {
  const start = source.indexOf('const cleanup = async () => {');
  const end = source.indexOf("process.on('SIGINT', cleanup)", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('Shutdown vs follow-up queue freeze refusal (U8)', () => {
  it('records the queue state (prepareFollowupShutdown) immediately before clearAll, in the same guarded try', () => {
    const section = cleanupSection();
    const tryOpen = section.lastIndexOf('try {', section.indexOf('clearAll()'));
    const prepare = section.indexOf('slackHandler.prepareFollowupShutdown()');
    const clearAll = section.indexOf('slackHandler.getRequestCoordinator().clearAll()');

    // Prepare freezes the IDLE queues (sessions with no controller are never
    // visited by clearAll) and closes admission, so it has to run first — and
    // inside the same try, because it throws on a store failure exactly like
    // clearAll does.
    expect(prepare).toBeGreaterThan(tryOpen);
    expect(prepare).toBeLessThan(clearAll);
    // Nothing between them: a Slack write or teardown step in that gap would
    // run with admission already closed but sessions not yet aborted.
    const between = section.slice(prepare, clearAll);
    expect(between).not.toContain('await ');
    expect(between).not.toContain('logger.');
  });

  it('guards clearAll() instead of calling it bare outside the try', () => {
    const section = cleanupSection();
    const clearAll = section.indexOf('slackHandler.getRequestCoordinator().clearAll()');
    expect(clearAll).toBeGreaterThan(-1);

    // The nearest enclosing statement before the call must be a `try {`, and a
    // `catch` must follow it before the next teardown step. A bare call would
    // reject `cleanup()` and reach the crash handler's SIGKILL path.
    const tryBefore = section.lastIndexOf('try {', clearAll);
    const catchAfter = section.indexOf('} catch', clearAll);
    const firstTeardown = section.indexOf('stopReportScheduler()');
    expect(tryBefore).toBeGreaterThan(-1);
    expect(catchAfter).toBeGreaterThan(clearAll);
    expect(catchAfter).toBeLessThan(firstTeardown);
  });

  it('a refusal returns BEFORE any teardown, drain, kill or exit', () => {
    const section = cleanupSection();
    const clearAll = section.indexOf('slackHandler.getRequestCoordinator().clearAll()');
    const catchAfter = section.indexOf('} catch', clearAll);
    const refusalReturn = section.indexOf('return;', catchAfter);
    expect(refusalReturn).toBeGreaterThan(catchAfter);

    // Everything destructive lives after the refusal return.
    for (const step of [
      'stopReportScheduler()',
      'slackHandler.notifyShutdown()',
      'getClaudeChildProcessRegistry().drain()',
      'releasePidLock(DATA_DIR)',
      'process.exit(0)',
    ]) {
      const idx = section.indexOf(step);
      expect(idx, `${step} must come after the refusal return`).toBeGreaterThan(refusalReturn);
    }

    // And the refusal branch itself never force-kills: SIGKILL belongs to the
    // crash handlers, which this path must no longer reach.
    const refusalBranch = section.slice(catchAfter, refusalReturn);
    expect(refusalBranch).not.toContain('killAllSync');
    expect(refusalBranch).not.toContain('process.exit');
  });

  it('the refusal is logged as an error with the live-queries consequence', () => {
    const section = cleanupSection();
    const catchAfter = section.indexOf('} catch', section.indexOf('clearAll()'));
    const refusalBranch = section.slice(catchAfter, section.indexOf('return;', catchAfter));

    expect(refusalBranch).toContain('logger.error');

    // Assert on the LOGGED MESSAGE, not the surrounding branch — the operator
    // only ever sees this string.
    const logCall = refusalBranch.slice(refusalBranch.indexOf('logger.error('));
    const message = logCall.slice(logCall.indexOf("'") + 1, logCall.indexOf("',"));

    // `clearAll()` aborts session-by-session, so a mid-sweep refusal leaves a
    // MIX: sessions before it are already stopped, the refused one is still
    // live. The message must say that — an absolute "nothing was torn down"
    // would send the operator hunting for work that is already gone.
    expect(message).toMatch(/queue/i);
    expect(message).toMatch(/still live/i);
    expect(message).toMatch(/already stopped/i);
    expect(message).not.toMatch(/nothing was torn down/i);
    // …and that a retry is expected once the queue store recovers.
    expect(message).toMatch(/retry|재시도/i);
  });

  it('re-arms BOTH flags on refusal: admission first, then the shutdown guard', () => {
    const section = cleanupSection();
    const guardSet = section.indexOf('isShuttingDown = true');
    const catchAfter = section.indexOf('} catch', section.indexOf('clearAll()'));
    const refusalReturn = section.indexOf('return;', catchAfter);
    const cancelPrepare = section.indexOf('slackHandler.cancelFollowupShutdownPreparation()', catchAfter);
    const reArm = section.indexOf('isShuttingDown = false', catchAfter);

    expect(guardSet).toBeGreaterThan(-1);
    // `prepare` may have SUCCEEDED (admission closed) and `clearAll` refused
    // afterwards. Without the cancel the bot would stay up — as this policy
    // intends — but silently refuse every message: a worse outage than the
    // shutdown we just declined.
    expect(cancelPrepare).toBeGreaterThan(catchAfter);
    expect(cancelPrepare).toBeLessThan(reArm);
    expect(reArm).toBeLessThan(refusalReturn);
  });

  it('leaves the signal wiring alone (SIGINT/SIGTERM still run the same cleanup)', () => {
    expect(source).toContain("process.on('SIGINT', cleanup)");
    expect(source).toContain("process.on('SIGTERM', cleanup)");
    // The re-entrancy guard at the top of cleanup is unchanged.
    const section = cleanupSection();
    expect(section.indexOf('if (isShuttingDown) return;')).toBeGreaterThan(-1);
  });
});
