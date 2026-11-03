/**
 * #853 — plan mode on a Slack session, the wiring in `src/index.ts` (source contract, as
 * `shutdown-followup-contract.test.ts`: importing `index.ts` would boot the bot).
 *
 *   W1 the plan tool saves through the registry by session key, and a Slack session's thread
 *      hears that a plan is waiting (with its link).
 *   W2 시작 / 취소 on a Slack session go to the Slack decider: the plan is sent into the thread as
 *      the decider's instruction (the normal Slack path), verbatim, and 시작 answers once the
 *      message is taken (`onAccepted`) — not after the whole turn (review #858).
 *   W3 the injection watches the message it sends and forgets the waiter once the run settles.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8');

function section(from: string, to: string): string {
  const start = source.indexOf(from);
  expect(start, `missing: ${from}`).toBeGreaterThan(-1);
  const end = source.indexOf(to, start + from.length);
  expect(end, `missing after ${from}: ${to}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('index.ts — plan mode on every session (#853)', () => {
  it('W1 — the plan tool saves by session key and tells a Slack thread that a plan waits', () => {
    const host = section('setPlanHost({', '\n    });');
    expect(host).toMatch(/submitPlan: \(sessionKey, input\) =>/);
    expect(host).toMatch(/getSessionRegistry\(\)\.submitSessionPlan\(sessionKey, input\)/);
    expect(host).toMatch(/notifyPlanWaiting\(/);
  });

  it('W2 — 시작 / 취소 on a Slack session go to the Slack decider, wired to the Slack path', () => {
    const decider = section('createSlackPlanDecider({', '\n    });');
    expect(decider).toMatch(
      /setPlanGate: \(key, gate\) => claudeHandler\.getSessionRegistry\(\)\.setSessionPlanGate\(key, gate\)/,
    );
    expect(decider).not.toMatch(/isBusy/);
    expect(decider).toMatch(
      /sendPlan: \(key, text, actorUserId\) =>[\s\S]*injectDashboardMessage\(key, text, undefined, \[\], actorUserId, undefined, \{\s*onAccepted: \(\) => resolve\(true\),\s*verbatim: true,\s*\}\)\.then\(\s*\(\) => resolve\(false\)/,
    );
    // #855 — one kind of work session: every plan is a Slack session's.
    const handler = section('setDashboardTaskPlanHandler(', ');\n');
    expect(handler).toMatch(/\(request\) => slackPlanDecider\(request\)/);
    expect(source).not.toMatch(/taskPlanDecider/);
  });

  it('W3 — the injection watches the message it sends, verbatim on request, and forgets the waiter', () => {
    const inject = section('const injectDashboardMessage = async (', 'setDashboardCommandHandler(');
    expect(inject).toMatch(
      /const unwatch = extra\.onAccepted\s*\?\s*slackHandler\.onTurnAccepted\(session\.channelId, ts, extra\.onAccepted\)\s*:\s*undefined;/,
    );
    // Verbatim on request; a host turn too when the host says so (#854 — an epic's wake or instruction).
    expect(inject).toMatch(
      /\.\.\.\(extra\.verbatim\s*\?\s*\{ routeContext: \{ verbatimPrompt: true, \.\.\.\(extra\.hostTurn \? \{ hostTurn: true \} : \{\}\) \} \}\s*:\s*\{\}\)/,
    );
    expect(inject).toMatch(/\} finally \{\s*unwatch\?\.\(\);\s*\}/);
  });
});
