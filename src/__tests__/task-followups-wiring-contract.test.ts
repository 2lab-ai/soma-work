/**
 * A dashboard task's follow-up queue (2026-11-03) — the wiring in `src/index.ts`.
 *
 * The bug this pins: the dashboard's word to a working task answered
 * `409 a turn is already running on this task` because the task command
 * handler called `taskController.start` without opting in to the queue. The
 * controller, the dashboard route and the registry each have their own suite;
 * this one checks that the entry point connects them. Source-contract
 * assertions (as `shutdown-followup-contract.test.ts`): importing `index.ts`
 * would boot the whole bot.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8');

/** The source from `from` up to the first `to` after it. */
function section(from: string, to: string): string {
  const start = source.indexOf(from);
  expect(start, `missing: ${from}`).toBeGreaterThan(-1);
  const end = source.indexOf(to, start + from.length);
  expect(end, `missing after ${from}: ${to}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('index.ts — a dashboard task’s follow-up queue is wired', () => {
  it('the dashboard task command handler queues while the task runs', () => {
    const handler = section('setDashboardTaskCommandHandler(', 'setDashboardTaskAnswerHandler(');
    expect(handler).toMatch(/taskController\.start\(\{[^}]*queueWhileRunning: true[^}]*\}\)/);
  });

  it('an approved task instruction queues too (it may land while the task works)', () => {
    const release = section("held.kind === 'task-command'", ': await taskController.answer(');
    expect(release).toMatch(/queueWhileRunning: true/);
  });

  it('the controller saves and pushes every queue change', () => {
    const controller = section('createTaskTurnController({', '\n    });');
    const changed = controller.slice(controller.indexOf('onFollowupsChanged:'));
    expect(changed).toMatch(
      /^onFollowupsChanged: \(key\) => \{\s*claudeHandler\.saveSessions\(\);\s*scheduleLiveSessionUpdate\(key\);/,
    );
  });

  it('the panel’s queue controls on a task go to the controller', () => {
    expect(source).toMatch(/setDashboardTaskQueueHandler\(\(request\) => taskController\.actOnQueue\(request\)\)/);
  });
});
