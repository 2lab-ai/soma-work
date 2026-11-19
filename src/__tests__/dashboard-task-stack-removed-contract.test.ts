/**
 * #855 — one kind of work session: the Slack-less dashboard-task stack is removed, not hidden.
 *
 *   C1 the task-turn stack's modules are gone (controller, executor, runner, receipts, final,
 *      launcher, notice deliverer and ledger, approver, answer, follow-ups, goal loop, the old
 *      epic waker), and so are the Slack package's task-turn helpers and the Slack task entry.
 *      The Slack epic path (#854) stays.
 *
 * Among the removed modules are input recognisers — the `taskentry on|off` command
 * (`taskentry-handler.ts`), the `/z taskentry` topic and the Slack task entry — so this is the
 * guard that they do not come back. (A stored `slackless` record is guarded by behaviour in
 * session-registry-dashboard-task-archive.test.ts.)
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

describe('the dashboard-task stack is removed (#855)', () => {
  it('C1 — its modules are gone; the Slack epic path stays', () => {
    const left = DELETED.filter((p) => fs.existsSync(path.join(ROOT, p)));
    expect(left).toEqual([]);
    const missing = KEPT.filter((p) => !fs.existsSync(path.join(ROOT, p)));
    expect(missing).toEqual([]);
  });
});
