/**
 * #855 — one kind of work session: the Slack-less dashboard-task stack is removed, not hidden.
 *
 *   C1 the task-turn stack's modules are gone (controller, executor, runner, receipts, final,
 *      launcher, notice deliverer and ledger, approver, answer, follow-ups, goal loop, the old
 *      epic waker), and so are the Slack package's task-turn helpers and the Slack task entry.
 *      The Slack epic path (#854) stays.
 *   C2 `slackless` is read only where an old record is met: the load-time detector that archives
 *      it and the stored-record types and archive readers (session registry, archive, the board's
 *      closed column). Nothing else names the stack's parts, except a "removed in #855" note.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

const DELETED = [
  'src/task-turn/task-turn-controller.ts',
  'src/task-turn/task-turn-executor.ts',
  'src/task-turn/task-turn-runner.ts',
  'src/task-turn/task-turn-receipts.ts',
  'src/task-turn/task-turn-final.ts',
  'src/task-turn/task-launcher.ts',
  'src/task-turn/task-notice-deliverer.ts',
  'src/task-turn/task-notification-ledger.ts',
  'src/task-turn/task-approver.ts',
  'src/task-turn/task-answer.ts',
  'src/task-turn/task-followups.ts',
  'src/task-turn/task-goal-loop.ts',
  'src/task-turn/epic-wake.ts',
  'src/slack/task-entry.ts',
  'src/slack/z/topics/taskentry-topic.ts',
  'src/slack/commands/taskentry-handler.ts',
  'packages/slack/src/task-turn',
];

const KEPT = [
  'src/task-turn/epic-server.ts',
  'src/task-turn/epic-slack.ts',
  'src/task-turn/epic-tree-gate.ts',
  'src/task-turn/epic-plan.ts',
  'src/task-turn/epic-board.ts',
  'src/task-turn/epic-cost.ts',
  'src/task-turn/epic-child-folder.ts',
  'src/task-turn/plan-server.ts',
  'src/task-turn/task-plan.ts',
  'src/task-turn/task-plan-decision.ts',
  'src/task-turn/task-close.ts',
];

/** Where the stored mark may still be read: the load-time detector, the record types, the archive readers. */
const SLACKLESS_ALLOWED = new Set([
  'src/session-registry.ts',
  'src/session-archive.ts',
  'src/conversation/dashboard.ts',
]);

const STACK_NAMES =
  /TaskTurn|executionContextForTask|taskEntry|slackTaskEntry|originThread|taskFollowups|beginTaskTurn|TaskLauncher|TaskExecutionContext|taskController|task-notice|task-approver|task-answer/;

const SCANNED_ROOTS = ['src', 'packages/slack/src', 'packages/common/src', 'packages/mcp-servers', 'somalib'];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '__tests__') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    // Sources only: a build output beside its source (somalib's `.js` / `.d.ts`) is not one.
    else if (/\.(ts|md|json)$/.test(entry.name) && !/\.(test|d)\.ts$/.test(entry.name)) out.push(full);
  }
  return out;
}

function hits(pattern: RegExp): Array<{ file: string; line: string }> {
  const found: Array<{ file: string; line: string }> = [];
  for (const root of SCANNED_ROOTS) {
    for (const file of sourceFiles(path.join(ROOT, root))) {
      const rel = path.relative(ROOT, file);
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      for (const line of lines) if (pattern.test(line)) found.push({ file: rel, line: line.trim() });
    }
  }
  return found;
}

describe('the dashboard-task stack is removed (#855)', () => {
  it('C1 — its modules are gone; the Slack epic path stays', () => {
    const left = DELETED.filter((p) => fs.existsSync(path.join(ROOT, p)));
    expect(left).toEqual([]);
    const missing = KEPT.filter((p) => !fs.existsSync(path.join(ROOT, p)));
    expect(missing).toEqual([]);
  });

  it('C2 — `slackless` only where an old record is met; nothing else names the stack', () => {
    const slackless = hits(/slackless/).filter((h) => !SLACKLESS_ALLOWED.has(h.file) && !h.line.includes('#855'));
    expect(slackless).toEqual([]);
    const stack = hits(STACK_NAMES).filter((h) => !h.line.includes('#855'));
    expect(stack).toEqual([]);
  });
});
