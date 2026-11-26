/**
 * .prd/40 §6 — the goal state boundary. Each rule names the one module that owns a state, and fails when code
 * outside it reads or writes that state directly. The rules land with the PR that moves the state (.prd/40 §4); an
 * exception is listed here with its reason, and a listed exception that is gone fails too, so the list only shrinks.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..');

/** Non-comment lines of a source file, each with the class member or top-level function it sits in. */
function membersOf(relPath: string): Array<{ member: string; line: number; text: string }> {
  const lines = fs.readFileSync(path.join(ROOT, relPath), 'utf8').split('\n');
  const member =
    /^ {2}(?:(?:private|public|protected|static|async|readonly|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\(/;
  const topLevel =
    /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|^(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=|^(?:export\s+)?(?:abstract\s+)?(?:class|interface)\s+([A-Za-z_$][\w$]*)/;
  const out: Array<{ member: string; line: number; text: string }> = [];
  let current = '(module)';
  lines.forEach((text, i) => {
    const m = member.exec(text);
    if (m) current = m[1];
    else {
      const t = topLevel.exec(text);
      if (t) current = (t[1] ?? t[2] ?? t[3]) as string;
    }
    const trimmed = text.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
    out.push({ member: current, line: i + 1, text });
  });
  return out;
}

function goalScopeFiles(): string[] {
  const slackDir = path.join(ROOT, 'src', 'slack');
  const goalFiles = fs
    .readdirSync(slackDir)
    .filter((f) => /^goal-.*\.ts$/.test(f))
    .map((f) => `src/slack/${f}`);
  return ['src/slack-handler.ts', ...goalFiles.sort()];
}

/** `file#member` → the lines in it that match `pattern`. */
function sitesOf(pattern: RegExp, files: string[]): Map<string, number[]> {
  const sites = new Map<string, number[]>();
  for (const file of files) {
    for (const { member, line, text } of membersOf(file)) {
      if (!pattern.test(text)) continue;
      const key = `${file}#${member}`;
      sites.set(key, [...(sites.get(key) ?? []), line]);
    }
  }
  return sites;
}

describe('goal state boundary (.prd/40 §6)', () => {
  /**
   * Rule 2 (PR1) — "is a turn running here" is answered by `src/slack/session-occupancy.ts`. The dispatcher slot
   * (`isBusy`, `liveTurnEpoch`) and the request controller (`isRequestActive`) are asked directly only where listed.
   * PR2 swaps the goal loop gate onto `turnHeld`; PR8 (loop driver) and PR9 (restart recovery) take their rows out.
   */
  it('rule 2: the slot and the request controller are asked directly only where listed', () => {
    const DIRECT_ASK = /\.isBusy\(|isRequestActive\(|liveTurnEpoch\(/;
    const ALLOWED: Record<string, string> = {
      // The occupancy's own inputs, and ports handed to modules outside the goal scope.
      'src/slack-handler.ts#constructor':
        'wires SessionOccupancy deps (slot, epoch, controller) and the safeguard-halt port (stops a running request)',
      // Dispatcher internals: which key holds the slot and which run generation — addressing, not "is a turn running".
      'src/slack-handler.ts#steerFollowupsWaitingForOpen': 'pins the steer to the run generation it was read under',
      'src/slack-handler.ts#handQueuedFollowupsToLiveTurn':
        'resolves the key the live slot is held under, and its epoch',
      'src/slack-handler.ts#handleMessage': 'resolves the slot owner key a follow-up is queued or steered against',
      'src/slack-handler.ts#trySteerFollowup': 'addresses the steer to the slot key and run generation it pinned',
      'src/slack-handler.ts#recordReadSteer': 'stamps the read receipt with the live run generation',
      'src/slack-handler.ts#releaseReadSteers': 'drops read receipts of an earlier run generation',
      'src/slack-handler.ts#onFollowupInputReopened': 'reads the run generation whose input reopened',
      'src/slack-handler.ts#sweepSteerBucketsIfIdle': 'steer buckets are swept only with no slot on either key',
      // Outside the goal state: status, safeguard, follow-up question, rollback, user-task release.
      'src/slack-handler.ts#processMessage': 'assistant status epoch is bumped only when no request owns the thread',
      'src/slack-handler.ts#applySafeguardGate': 'a halted host turn puts back a stale working with no request',
      'src/slack-handler.ts#noteChainSettled': 'user-task release and the follow-up question wait for the slot',
      'src/slack-handler.ts#resumeAfterAutoCompactStop':
        'a non-goal auto-compact resume yields to a run holding the slot',
      'src/slack-handler.ts#askFollowUpQuestion': 'the follow-up question port (request, loop acting, host wait)',
      'src/slack-handler.ts#getContextRollbackPoints': 'rollback reads whether a request runs',
      'src/slack-handler.ts#handleContextRollback': 'rollback refuses while a request runs',
      'src/slack-handler.ts#releaseStoppedPreparation':
        'D3 keeps it: a stopped preparation puts back working only with no request',
      // Goal loop and restart recovery — removed by the PR named.
      'src/slack-handler.ts#drainIdleRestartRequeued': 'restart requeue drain — PR9 (restart recovery)',
      'src/slack-handler.ts#handBackFailedRestartResume': 'restart hand-off — PR9 (restart recovery, D3)',
      'src/slack-handler.ts#askGoalStallQuestion': 'stall question round — PR8 (loop driver)',
      'src/slack/goal-loop-controller.ts#isRequestActive': 'the controller port declaration — PR8 (loop driver)',
      'src/slack/goal-loop-controller.ts#runOnce': 'the loop gate — PR2 (turnHeld + owner question)',
      'src/slack/goal-loop-controller.ts#handleVerdict': 'verdict re-check before inject — PR8 (loop driver, D15)',
      'src/slack/goal-loop-controller.ts#handleEvalDispatchFailure':
        'safeguard stop of a turn started during the eval — PR8',
    };

    const found = [...sitesOf(DIRECT_ASK, goalScopeFiles()).keys()].sort();
    const unlisted = found.filter((key) => !(key in ALLOWED));
    const gone = Object.keys(ALLOWED).filter((key) => !found.includes(key));
    expect({ unlisted, gone }).toEqual({ unlisted: [], gone: [] });
  });

  it('rule 2: the host answers "is the turn free" and "is the slot held" through the occupancy', () => {
    const handler = membersOf('src/slack-handler.ts');
    const body = (name: string) =>
      handler
        .filter((l) => l.member === name)
        .map((l) => l.text)
        .join('\n');
    expect(body('isHostTurnFree')).toContain('this.occupancy.runPhase(');
    expect(body('isFollowupSlotHeld')).toContain('this.occupancy.slotHeld(');
    expect(body('isFollowupTurnBusy')).toContain('this.occupancy.slotHeld(');
  });

  it.todo('rule 1 (PR2): no goal, loop or recovery code reads activityState as a condition');
  it.todo('rule 3 (PR4–5): only goal/machine.ts writes goal status, phase fields, counters and epoch');
  it.todo('rule 4 (PR3): control flow reads those fields through goal/read.ts (phaseOf, placeOf)');
  it.todo('rule 5 (PR5): only goal-commit.ts saves and broadcasts after a goal change');
  it.todo('rule 6 (PR3): SessionGoal is defined once, in goal/model.ts');
});
