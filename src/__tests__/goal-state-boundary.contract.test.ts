/**
 * .prd/40 §6 — the goal state boundary. Each rule names the one module that owns a state, and fails when code
 * outside it reads or writes that state directly. The rules land with the PR that moves the state (.prd/40 §4); an
 * exception is listed here with its reason, and a listed exception that is gone fails too, so the list only shrinks.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..');

/**
 * Non-comment lines of a source file, each with the class member or top-level declaration it sits in. A member is a
 * two-space-indented method head inside a class body; inside a top-level function the same indent is a statement.
 */
function membersOf(relPath: string): Array<{ member: string; text: string }> {
  const lines = fs.readFileSync(path.join(ROOT, relPath), 'utf8').split('\n');
  const member =
    /^ {2}(?:(?:private|public|protected|static|async|readonly|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\(/;
  const topLevel =
    /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|^(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*[:=]|^(?:export\s+)?(?:abstract\s+)?(?:class|interface)\s+([A-Za-z_$][\w$]*)/;
  const classHead = /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s/;
  const out: Array<{ member: string; text: string }> = [];
  let current = '(module)';
  let inClass = false;
  for (const text of lines) {
    const top = topLevel.exec(text);
    if (top) {
      current = (top[1] ?? top[2] ?? top[3]) as string;
      inClass = classHead.test(text);
    } else if (text.startsWith('}')) {
      if (inClass) inClass = false;
    } else if (inClass) {
      const m = member.exec(text);
      if (m && !['if', 'for', 'while', 'switch', 'return', 'catch'].includes(m[1])) current = m[1];
    }
    const trimmed = text.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
    out.push({ member: current, text });
  }
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

/** Every `file#member` with a line that matches `pattern`. */
function sitesOf(pattern: RegExp, files: string[]): Set<string> {
  const sites = new Set<string>();
  for (const file of files) {
    for (const { member, text } of membersOf(file)) {
      if (pattern.test(text)) sites.add(`${file}#${member}`);
    }
  }
  return sites;
}

describe('goal state boundary (.prd/40 §6)', () => {
  /**
   * Rule 2 (PR1) — "is a turn running here" is answered by `src/slack/session-occupancy.ts`. The dispatcher slot
   * (`isBusy`, `liveTurnEpoch`) and the request controller (`isRequestActive`) are asked directly only where listed.
   * PR2 moved the goal loop gate and the restart hand-off onto the occupancy; PR8 (loop driver) and PR9 (restart
   * recovery) take the remaining goal rows out.
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
      'src/slack-handler.ts#askGoalStallQuestion': 'stall question round — PR8 (loop driver)',
      'src/slack/goal-loop-controller.ts#GoalLoopRequestCoordinator':
        'the controller port declaration — PR8 (loop driver)',
      'src/slack/goal-loop-controller.ts#handleVerdict': 'verdict re-check before inject — PR8 (loop driver, D15)',
      'src/slack/goal-loop-controller.ts#handleEvalDispatchFailure':
        'safeguard stop of a turn started during the eval — PR8',
    };

    const found = [...sitesOf(DIRECT_ASK, goalScopeFiles())].sort();
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

  /**
   * Rule 3 (PR4, the epoch first) — the goal's intent epoch moves only in `@soma/slack/goal/machine` (`bumpEpoch`, and
   * the create / promote transitions that start a new generation). Inline bumps left the judge retry window behind (X9).
   */
  it('rule 3: the goal epoch is written only in goal/machine and the listed undo', () => {
    const files = [
      ...goalScopeFiles(),
      'src/slack/actions/goal-action-handler.ts',
      'src/slack/commands/goal-handler.ts',
      'src/session-registry.ts',
      'src/conversation/dashboard.ts',
      'packages/slack/src/session-goal.ts',
      'packages/slack/src/pipeline/stream-executor.ts',
    ];
    // The one write outside goal/machine is the cap answer's undo of a failed save, and only as that exact statement
    // (review #1494): any other epoch write in the same function — an inline `+ 1` — is a site like any other.
    const UNDO = /^\s*goal\.epoch = before\.epoch;\s*$/;
    const WRITE = /\bgoal\??\.epoch\s*=[^=]|\bcurrent\.epoch\s*=[^=]|\bepoch:\s*\(.*epoch \?\? 0\) \+ 1/;
    const isWrite = (line: string) => WRITE.test(line) && !UNDO.test(line);
    expect([isWrite('    goal.epoch = before.epoch;'), isWrite('    goal.epoch = (goal.epoch ?? 0) + 1;')]).toEqual([
      false,
      true,
    ]);
    expect([...sitesOf({ test: isWrite } as RegExp, files)]).toEqual([]);
    // …and that undo statement lives only in the cap answer (review #1503): a rollback of the epoch anywhere else would
    // make a stale verdict valid again.
    expect([...sitesOf(UNDO, files)]).toEqual(['src/slack/goal-cap-decision.ts#answerGoalCapDecision']);
  });

  /**
   * Rule 5 (PR5, the goal command and goal buttons first) — a goal change ends through `commitGoalChange`
   * (`src/slack/goal-commit.ts`): epoch, prompt, save, dashboard, drive. The rows left save on their own and move with
   * the surface PR (PR6) — the cap answer keeps its declared order (journal → save → DM rewrite, undo on failure).
   */
  it('rule 5: the goal command and goal buttons save only through goal-commit, except where listed', () => {
    const files = ['src/slack/commands/goal-handler.ts', 'src/slack/actions/goal-action-handler.ts'];
    // A port handed to commitGoalChange (`saveSessions: () => …`) is the commit's own save, not a site (review #1495):
    // a direct save anywhere else in those functions is.
    // The port is exempt only in a function that hands it to commitGoalChange (review #1503).
    const PORT = /^\s*(saveSessions|broadcastSessionUpdate)\s*:\s*\(\)\s*=>/;
    const SAVE_CALL = /\.saveSessions(OrThrow)?\(|\.broadcastSessionUpdate\?*\.?\(/;
    // A port is exempt only inside the argument list of a commitGoalChange call (review #1503): from the call's line
    // until its parentheses close. A port handed to any other helper — even in the same method — is a site.
    // Parentheses are counted on code only (string literals and line comments removed), and the count restarts at
    // every member boundary (review #1504).
    const codeOf = (line: string): string =>
      line.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, "''").replace(/\/\/.*$/, '');
    const saveSitesIn = (rows: Array<{ member: string; text: string }>): string[] => {
      const out = new Set<string>();
      let depth = 0;
      let current = '';
      for (const { member, text } of rows) {
        if (member !== current) {
          current = member;
          depth = 0;
        }
        const code = codeOf(text);
        const at = code.search(/\bcommitGoalChange\(/);
        const inCommit = depth > 0 || at >= 0;
        if (SAVE_CALL.test(code) && !(PORT.test(code) && inCommit)) out.add(member);
        const counted = depth > 0 ? code : at >= 0 ? code.slice(at) : '';
        for (const ch of counted) depth += ch === '(' ? 1 : ch === ')' ? -1 : 0;
        if (depth < 0) depth = 0;
      }
      return [...out];
    };
    expect(
      saveSitesIn([
        { member: 'viaCommit', text: '    commitGoalChange(session, key, { drive }, {' },
        { member: 'viaCommit', text: '      saveSessions: () => this.deps.claudeHandler.saveSessions(),' },
        { member: 'viaCommit', text: '    });' },
        { member: 'commitThenHelper', text: '    commitGoalChange(session, key, { drive }, { kick });' },
        { member: 'commitThenHelper', text: '    otherHelper({' },
        { member: 'commitThenHelper', text: '      saveSessions: () => this.deps.claudeHandler.saveSessions(),' },
        { member: 'commitThenHelper', text: '    });' },
        // A parenthesis in a string or a comment is not syntax: the call still closes, the next member starts at zero.
        { member: 'literalParen', text: "    commitGoalChange(session, 'goal(', { drive }, { kick });" },
        { member: 'afterLiteral', text: '      saveSessions: () => this.deps.claudeHandler.saveSessions(),' },
        { member: 'commentParen', text: '    commitGoalChange(session, key, { drive }, { // 1) persistence ports' },
        { member: 'commentParen', text: '      saveSessions: () => this.deps.claudeHandler.saveSessions(),' },
        { member: 'commentParen', text: '    });' },
        { member: 'portElsewhere', text: '      saveSessions: () => this.deps.claudeHandler.saveSessions(),' },
        { member: 'direct', text: '      this.deps.claudeHandler.saveSessions();' },
      ]),
    ).toEqual(['commitThenHelper', 'afterLiteral', 'portElsewhere', 'direct']);
    const sitesIn = (fileList: string[]): Set<string> =>
      new Set(fileList.flatMap((file) => saveSitesIn(membersOf(file)).map((member) => `${file}#${member}`)));
    const ALLOWED: Record<string, string> = {
      'src/slack/actions/goal-action-handler.ts#answerCapDecision': 'the cap answer declares its own order (D9)',
      'src/slack/actions/goal-action-handler.ts#handleDelete': 'goal-list delete — PR6 (surfaces)',
      'src/slack/commands/goal-handler.ts#setGoal': 'goal <objective> and its opening admit — PR6',
      'src/slack/commands/goal-handler.ts#completeGoal': 'goal done — PR6 (D12)',
      'src/slack/commands/goal-handler.ts#pauseGoal': 'goal pause — PR6',
      'src/slack/commands/goal-handler.ts#resumeGoal': 'goal resume — PR6 (D11)',
    };
    const found = [...sitesIn(files)].sort();
    const unlisted = found.filter((key) => !(key in ALLOWED));
    const gone = Object.keys(ALLOWED).filter((key) => !found.includes(key));
    expect({ unlisted, gone }).toEqual({ unlisted: [], gone: [] });
  });

  /**
   * Rule 6 (PR3) — `SessionGoal` is defined once, in `@soma/slack/goal/model`. `src/types.ts` and
   * `@soma/slack/session-goal` re-export it; the queue helpers' `SessionGoalState` is an alias, not a copy.
   */
  it('rule 6: SessionGoal has one definition', () => {
    const roots = ['src', 'packages/slack/src', 'somalib'];
    const defined: string[] = [];
    /** The SessionGoal-named declarations of a text, the one forwarding alias left out. */
    const declarations = (text: string): string[] =>
      [...text.matchAll(/^export (?:interface|type) (SessionGoal|SessionGoalState)\b(.*)$/gm)]
        .filter(
          (m) =>
            !(m[1] === 'SessionGoalState' && /^\s*=\s*(?:import\('\.\/goal\/model'\)\.)?SessionGoal;\s*$/.test(m[2])),
        )
        .map((m) => m[1]);
    // Review #1493 — a structural alias is a second definition; the forwarding alias is not.
    expect(declarations("export type SessionGoalState = import('./goal/model').SessionGoal;")).toEqual([]);
    expect(declarations('export type SessionGoalState = { goalId: string };')).toEqual(['SessionGoalState']);
    expect(declarations('export type SessionGoal = {\n  goalId: string;\n};')).toEqual(['SessionGoal']);
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules' && entry.name !== 'dist' && entry.name !== '__tests__') walk(rel);
        } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
          const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
          for (const name of declarations(text))
            defined.push(name === 'SessionGoal' ? rel : `${rel} (SessionGoalState copy)`);
        }
      }
    };
    for (const root of roots) if (fs.existsSync(path.join(ROOT, root))) walk(root);
    expect(defined).toEqual(['packages/slack/src/goal/model.ts']);
  });

  /**
   * Rule 4 (PR3, cap question first) — control flow asks `goal/read` (`phaseOf` · `capAskOf`) whether the cap
   * question is open; `goal/machine` owns the session-goal transitions (PR4), the cap round's own transitions move
   * with the commit path (PR5) and the dashboard's projection with the board (PR10).
   */
  it('rule 4: capDmPendingAt is read only by goal/read and the listed transitions', () => {
    const files = [
      ...goalScopeFiles(),
      'src/slack/follow-up-question.ts',
      'src/index.ts',
      'src/slack/commands/goal-handler.ts',
      'packages/slack/src/session-goal.ts',
      'packages/slack/src/pipeline/stream-executor.ts',
      'src/conversation/dashboard.ts',
    ];
    const ALLOWED: Record<string, string> = {
      'src/slack/goal-cap-decision.ts#openGoalCapDecision': 'the open transition — PR5 (goal-commit)',
      'src/slack/goal-cap-decision.ts#answerGoalCapDecision':
        "the answer's snapshot and its undo on a failed save — PR5",
      'src/slack/goal-cap-decision.ts#endDecision': 'the retire transition — PR5 (goal-commit takes the cap answer)',
      'src/slack/goal-cap-decision.ts#retireGoalCapDecision': 'the retire transition — PR5',
      'src/slack/follow-up-question.ts#FollowUpQuestionSession': 'the structural session type the surface accepts',
      'src/conversation/dashboard.ts#goalDecisionToKanban':
        'the board card shows when it was asked — PR10 (goal/board)',
    };
    const found = [...sitesOf(/capDmPendingAt/, files)].sort();
    const unlisted = found.filter((key) => !(key in ALLOWED));
    const gone = Object.keys(ALLOWED).filter((key) => !found.includes(key));
    expect({ unlisted, gone }).toEqual({ unlisted: [], gone: [] });
  });

  /**
   * Rule 1 (PR2) — `activityState` is the card's word. No goal, loop or recovery code takes it as a condition
   * (.prd/39 D1); the loop gate reads `turnHeld` and the owner question. The rows left are not a goal question.
   */
  it('rule 1: activityState is read as a condition only where listed', () => {
    const READ = /\bactivityState\b|getActivityStateByKey/;
    const ALLOWED: Record<string, string> = {
      'src/slack-handler.ts#redeliverRestartCutFollowups':
        "the recovery record's own disk value, for a record from before shouldAutoResume",
      'src/slack-handler.ts#notifyCrashRecovery':
        "the recovery record's disk value: the legacy auto-resume fallback and the notice text",
      'src/slack-handler.ts#applySafeguardGate': 'a halted host turn puts back the working it set — not goal state',
      'src/slack-handler.ts#releaseRecovered': 'writes the display idle — reads it only to report a change',
      'src/slack-handler.ts#releaseStoppedPreparation':
        'D3 keeps it: a stopped preparation puts back its own working, an asking session keeps waiting',
    };
    const found = [...sitesOf(READ, goalScopeFiles())].sort();
    const unlisted = found.filter((key) => !(key in ALLOWED));
    const gone = Object.keys(ALLOWED).filter((key) => !found.includes(key));
    expect({ unlisted, gone }).toEqual({ unlisted: [], gone: [] });
  });

  it('rule 1: the loop gate takes turnHeld and the owner question', () => {
    const evaluator = fs.readFileSync(path.join(ROOT, 'src/slack/goal-completion-evaluator.ts'), 'utf8');
    const gate = evaluator.slice(evaluator.indexOf('export interface GoalIdleDriverState'));
    expect(gate).toContain('turnHeld: boolean;');
    expect(gate).toContain('ownerQuestionOpen: boolean;');
  });
});
