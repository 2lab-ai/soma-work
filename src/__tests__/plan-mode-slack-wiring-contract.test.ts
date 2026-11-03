/**
 * #853 — plan mode on a Slack session, the wiring in `src/index.ts` (source contract, as
 * `shutdown-followup-contract.test.ts`: importing `index.ts` would boot the bot).
 *
 *   W1 the plan tool saves through the registry by session key, and a Slack session's thread
 *      hears that a plan is waiting (with its link).
 *   W2 시작 / 취소 on a Slack session go to the Slack decider: the plan is sent into the thread as
 *      the decider's instruction (the normal Slack path), "busy" is the request coordinator's.
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
    expect(decider).toMatch(/isBusy: \(key\) => slackHandler\.getRequestCoordinator\(\)\.isRequestActive\(key\)/);
    expect(decider).toMatch(
      /sendPlan: async \(key, text, actorUserId\) =>[\s\S]*injectDashboardMessage\(key, text, undefined, \[\], actorUserId\)/,
    );
    const handler = section('setDashboardTaskPlanHandler(', ');\n');
    expect(handler).toMatch(/slackless === true\s*\?\s*taskPlanDecider\(request\)\s*:\s*slackPlanDecider\(request\)/);
  });
});
