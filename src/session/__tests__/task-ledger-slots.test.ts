/**
 * 2026-10-29 T5 — the task list shows the tasks that actually ran, with real
 * numbers. Measured on dev (sessions.json, 949 completed tasks): 93% read
 * "start = end, 툴 0회", because the model writes progress INTO a task's text
 * ("CI on 2e5cb5b → merge" → "CI green → PR #500 merged") and the ledger
 * matched tasks by exact text — every rewrite minted a new, already-completed
 * task with nothing on it, and the task that had done the work read 중단.
 *
 * These tests pin: a rewrite keeps its task (slot matching), the work done
 * while tasks ran (tool calls, subagents' tool calls, tokens, cost) lands on
 * them — split when they ran together, handed to the tasks a list reports done
 * when none was in progress — and all of it survives persistence.
 */

import { describe, expect, it } from 'vitest';
import {
  applyTodoList,
  changesTarget,
  closeTaskList,
  creditTaskUsage,
  emptyTaskLedger,
  ledgerTasks,
  recordAgentToolCall,
  recordToolCall,
  sanitizeTaskLedger,
  type TaskLedger,
  textSimilarity,
} from '../task-ledger';

type Status = 'pending' | 'in_progress' | 'completed';
const todo = (content: string, status: Status = 'pending', activeForm?: string) => ({
  content,
  status,
  ...(activeForm ? { activeForm } : {}),
});

function tools(l: TaskLedger, n: number): void {
  for (let i = 0; i < n; i++) recordToolCall(l);
}

describe('a rewritten task is the same task (slot matching)', () => {
  it('keeps the id, start, tool calls when the model writes the result into the text', () => {
    let l = applyTodoList(
      undefined,
      [
        todo(
          'CI on 2e5cb5b (scan ✓, lean-verify running) → merge via pr500-ci-merge.sh',
          'in_progress',
          'Waiting on CI to merge',
        ),
        todo('Deploy dev, live 작업 로그 screenshots', 'pending', 'Deploying to dev'),
      ],
      1_000,
    );
    tools(l, 21);
    l = applyTodoList(
      l,
      [
        todo(
          'CI on 2e5cb5b green (scan, lean-verify, quality-gates) → PR #500 merged b8cdd17',
          'completed',
          'Merging PR #500',
        ),
        todo('Dev deploy: deploy/dev b319bdc, Deploy run all jobs success', 'in_progress', 'Deploying to dev'),
      ],
      60_000,
    );
    const view = ledgerTasks(l);
    const [ci, deploy] = view.current;
    expect(ci.id).toBe('T1');
    expect(ci.status).toBe('completed');
    expect(ci.startedAt).toBe(1_000);
    expect(ci.completedAt).toBe(60_000);
    expect(ci.toolCalls).toBe(21);
    expect(ci.content).toContain('PR #500 merged');
    expect(ci.revisions).toEqual([
      { at: 60_000, content: 'CI on 2e5cb5b (scan ✓, lean-verify running) → merge via pr500-ci-merge.sh' },
    ]);
    // Few shared words (0.17) and the same activeForm: not proof (review R2) — a new task, the
    // waiting one left the plan before it ran.
    expect(deploy.id).toBe('T3');
    expect(deploy.startedAt).toBe(60_000);
    expect(ledgerTasks(l).earlier.map((t) => [t.id, t.dropped])).toEqual([['T2', 'unstarted']]);
  });

  it('the screenshot case: the gate re-run that ran 17 tools is completed, not 중단 next to a 0-tool twin', () => {
    let l = applyTodoList(
      undefined,
      [
        todo('astra 배포 증거 확인 1회(게이트 재실행)', 'in_progress'),
        todo('GitHub 리뷰 게시(라인 코멘트 2건 + APPROVE)·squash 머지'),
        todo('SSOT 성공 증명 게시(Jira PROJ-1234) + 최종 ES 보고 HTML'),
      ],
      1_000,
    );
    tools(l, 17);
    l = applyTodoList(
      l,
      [
        todo('astra 배포 증거 확인 1회(게이트 재실행) — APPROVE, 3/3', 'completed'),
        todo('GitHub 리뷰 게시(라인 코멘트 2건 + APPROVE)·squash 머지 (e28a450)', 'completed'),
        todo('SSOT 성공 증명 게시(Jira PROJ-1234) + 최종 ES 보고 HTML 업로드 + main 배포 확인', 'in_progress'),
      ],
      300_000,
    );
    const view = ledgerTasks(l);
    expect(view.earlier.filter((t) => t.dropped)).toEqual([]);
    expect(view.current.map((t) => [t.id, t.status, Math.round(t.toolCalls)])).toEqual([
      ['T1', 'completed', 17],
      ['T2', 'completed', 0],
      ['T3', 'in_progress', 0],
    ]);
    expect(l.nextSeq).toBe(4);
  });

  it('the same activeForm ranks a match but never stands in for shared words (review R2)', () => {
    // Rewrite with enough shared words and the same activeForm: one task.
    let l = applyTodoList(undefined, [todo('Run the CI suite', 'in_progress', 'Running CI')], 1_000);
    l = applyTodoList(l, [todo('Run the CI suite on main — green', 'completed', 'Running CI')], 2_000);
    expect(ledgerTasks(l).current.map((t) => [t.id, t.startedAt])).toEqual([['T1', 1_000]]);
    // Both still running, the same activeForm, 0.29 of the words (grok R2): two tasks.
    let m = applyTodoList(
      undefined,
      [todo('Fix dashboard card toggle test', 'in_progress', 'Working on tests'), todo('Deploy to dev')],
      1_000,
    );
    for (let i = 0; i < 17; i++) recordToolCall(m);
    m = applyTodoList(
      m,
      [todo('Write dashboard card tests', 'in_progress', 'Working on tests'), todo('Deploy to dev')],
      2_000,
    );
    expect(ledgerTasks(m).current.map((t) => [t.id, t.toolCalls])).toEqual([
      ['T3', 0],
      ['T2', 0],
    ]);
    expect(ledgerTasks(m).earlier.map((t) => [t.id, t.dropped, t.toolCalls])).toEqual([['T1', 'started', 17]]);
  });

  it('a different task in the same slot is still a new task', () => {
    let l = applyTodoList(undefined, [todo('Rebase onto main', 'in_progress')], 1_000);
    l = applyTodoList(l, [todo('Write the release notes', 'in_progress')], 2_000);
    const view = ledgerTasks(l);
    expect(view.current.map((t) => t.id)).toEqual(['T2']);
    expect(view.earlier.map((t) => [t.id, t.dropped])).toEqual([['T1', 'started']]);
  });

  it('a completed task is not reopened by a rewrite — only by its exact text', () => {
    let l = applyTodoList(undefined, [todo('Run the full test suite', 'completed')], 1_000);
    l = applyTodoList(l, [todo('Run the full test suite again', 'in_progress')], 2_000);
    expect(ledgerTasks(l).current.map((t) => t.id)).toEqual(['T2']);
    expect(ledgerTasks(l).earlier.map((t) => [t.id, t.status])).toEqual([['T1', 'completed']]);
  });

  it('keeps the first text and the newest ones when a task is rewritten many times', () => {
    let l = applyTodoList(undefined, [todo('Fix #455 flaky test, attempt v0', 'in_progress', 'Fixing 455')], 1);
    for (let i = 1; i <= 20; i++)
      l = applyTodoList(l, [todo(`Fix #455 flaky test, attempt v${i}`, 'in_progress', 'Fixing 455')], 1 + i);
    const t = ledgerTasks(l).current[0];
    expect(t.id).toBe('T1');
    expect(t.revisions).toHaveLength(12);
    expect(t.revisions?.[0].content).toBe('Fix #455 flaky test, attempt v0');
    expect(t.revisions?.[11].content).toBe('Fix #455 flaky test, attempt v19');
  });

  it('text similarity: shared words, or one text extending the other', () => {
    expect(textSimilarity('a', 'a')).toBe(1);
    expect(
      textSimilarity('GitHub 리뷰 게시·squash 머지', 'GitHub 리뷰 게시·squash 머지 (e28a450)'),
    ).toBeGreaterThanOrEqual(0.9);
    expect(textSimilarity('Rebase onto main', 'Write the release notes')).toBeLessThan(0.2);
  });
});

describe('work lands on the tasks that ran', () => {
  it('tasks in progress together share the work evenly, marked shared', () => {
    const l = applyTodoList(
      undefined,
      [todo('#438 agent-inbox', 'in_progress'), todo('#439 agent-run', 'in_progress')],
      1_000,
    );
    tools(l, 4);
    creditTaskUsage(
      l,
      'm:1',
      { inputTokens: 100, outputTokens: 50, cacheReadTokens: 1_000, cacheCreateTokens: 10 },
      0.2,
    );
    const [a, b] = ledgerTasks(l).current;
    expect([a.toolCalls, b.toolCalls]).toEqual([2, 2]);
    expect(a.tokens).toEqual({ input: 50, output: 25, cacheRead: 500, cacheCreate: 5, costUsd: 0.1 });
    expect(b.tokens).toEqual(a.tokens);
    expect([a.shared, b.shared]).toEqual([2, 2]);
  });

  it('a subagent’s tool calls count on the main task in progress, apart from its own', () => {
    const l = applyTodoList(undefined, [todo('Review gate', 'in_progress')], 1_000);
    tools(l, 1);
    recordAgentToolCall(l);
    recordAgentToolCall(l);
    const t = ledgerTasks(l).current[0];
    expect([t.toolCalls, t.agentToolCalls]).toEqual([1, 2]);
  });

  it('a re-reported call replaces its credit, on the tasks that first got it', () => {
    let l = applyTodoList(undefined, [todo('A', 'in_progress')], 1_000);
    creditTaskUsage(l, 'm:x', { inputTokens: 10, outputTokens: 1 }, 0.01);
    l = applyTodoList(l, [todo('A', 'completed'), todo('B', 'in_progress')], 2_000);
    // The same message, reported again with its final output count.
    creditTaskUsage(l, 'm:x', { inputTokens: 10, outputTokens: 40 }, 0.04);
    const [a, b] = ledgerTasks(l).current;
    expect(a.tokens?.output).toBe(40);
    expect(a.tokens?.costUsd).toBeCloseTo(0.04);
    expect(b.tokens?.output).toBe(0);
  });

  it('a task reported done without ever being in progress gets the window: estimated start and the idle work', () => {
    let l = applyTodoList(undefined, [todo('Read the code'), todo('Write the fix')], 1_000);
    tools(l, 6); // nothing in progress: held
    creditTaskUsage(l, 'm:1', { inputTokens: 40, outputTokens: 20 }, 0.06);
    l = applyTodoList(l, [todo('Read the code', 'completed'), todo('Write the fix', 'completed')], 9_000);
    const [read, fix] = ledgerTasks(l).current;
    for (const t of [read, fix]) {
      expect(t.startedAt).toBe(1_000);
      expect(t.startEstimated).toBe(true);
      expect(t.completedAt).toBe(9_000);
      expect(t.toolCalls).toBe(3);
      expect(t.tokens).toMatchObject({ input: 20, output: 10 });
      expect(t.shared).toBe(2);
    }
    expect(ledgerTasks(l).outside).toBeUndefined();
  });

  it('idle work no task claimed is reported as outside any task', () => {
    let l = applyTodoList(undefined, [todo('A')], 1_000);
    tools(l, 3);
    l = applyTodoList(l, [todo('A', 'in_progress')], 2_000);
    expect(ledgerTasks(l).outside?.toolCalls).toBe(3);
    expect(ledgerTasks(l).current[0].toolCalls).toBe(0);
  });

  it('a call re-reported after the session started over is not counted twice (fable R2 P3)', () => {
    let l = applyTodoList(undefined, [todo('A', 'in_progress')], 1_000);
    creditTaskUsage(l, 'm:1', { outputTokens: 40 }, 0);
    l = closeTaskList(l, 2_000)!;
    creditTaskUsage(l, 'm:1', { outputTokens: 40 }, 0); // the same message, reported again
    const view = ledgerTasks(l);
    expect(view.earlier[0].tokens?.output).toBe(40);
    expect(view.outside).toBeUndefined();
  });

  it('a session that starts over moves its unclaimed work outside', () => {
    let l = applyTodoList(undefined, [todo('A')], 1_000);
    tools(l, 2);
    l = closeTaskList(l, 5_000)!;
    expect(ledgerTasks(l).outside?.toolCalls).toBe(2);
    expect(l.idle).toBeUndefined();
  });
});

describe('persistence', () => {
  it('a saved ledger restores revisions, numbers and windows; runtime call credits are not restored', () => {
    let l = applyTodoList(undefined, [todo('Ship it v1', 'in_progress', 'Shipping'), todo('B', 'in_progress')], 1_000);
    tools(l, 3);
    recordAgentToolCall(l);
    creditTaskUsage(l, 'm:1', { inputTokens: 10, outputTokens: 4, cacheReadTokens: 100, cacheCreateTokens: 2 }, 0.5);
    l = applyTodoList(l, [todo('Ship it v1 — done', 'completed', 'Shipping'), todo('C')], 4_000);
    tools(l, 1);
    const restored = sanitizeTaskLedger(JSON.parse(JSON.stringify(l)))!;
    expect(Object.keys(JSON.parse(JSON.stringify(l)))).not.toContain('calls'); // runtime only — never serialized
    expect(restored.updatedAt).toBe(4_000);
    expect(restored.idle?.toolCalls).toBe(1);
    const ship = ledgerTasks(restored).current[0];
    expect(ship).toMatchObject({
      id: 'T1',
      toolCalls: 1.5,
      agentToolCalls: 0.5,
      shared: 2,
      tokens: { input: 5, output: 2, cacheRead: 50, cacheCreate: 1, costUsd: 0.25 },
      revisions: [{ at: 4_000, content: 'Ship it v1' }],
    });
  });

  it('a task saved before per-task usage reads unknown tokens, not 0', () => {
    const legacy = sanitizeTaskLedger({
      nextSeq: 2,
      current: ['T1'],
      tasks: [{ id: 'T1', content: 'old', status: 'completed', startedAt: 1, completedAt: 1, toolCalls: 0 }],
    })!;
    expect(ledgerTasks(legacy).current[0].tokens).toBeUndefined();
  });
});

describe('review R1 — two tasks are never made one without the words saying so', () => {
  it('position and a generic activeForm alone never make two tasks one (grok P0)', () => {
    let l = applyTodoList(
      undefined,
      [todo('Rebase onto main', 'in_progress', 'Working'), todo('Fix the flaky test', 'pending', 'Working')],
      1_000,
    );
    tools(l, 40);
    // The new task at index 0 shares Rebase's slot and its (generic) activeForm — no word.
    l = applyTodoList(
      l,
      [
        todo('Rewrite the auth middleware', 'in_progress', 'Working'),
        todo('Fix the flaky test harness', 'in_progress', 'Working'),
      ],
      2_000,
    );
    const view = ledgerTasks(l);
    const rebase = view.earlier.find((t) => t.content === 'Rebase onto main');
    expect(rebase?.toolCalls).toBe(40);
    expect(rebase?.dropped).toBe('started');
    expect(view.current.map((t) => [t.content, t.toolCalls])).toEqual([
      ['Rewrite the auth middleware', 0],
      ['Fix the flaky test harness', 0],
    ]);
  });

  it('two siblings are two tasks: the one the list dropped keeps its own run (astra R1 P1-1)', () => {
    let l = applyTodoList(
      undefined,
      [todo('Implement login API', 'in_progress'), todo('Implement logout API', 'in_progress')],
      1_000,
    );
    tools(l, 10);
    l = applyTodoList(l, [todo('Implement login API — done', 'completed')], 9_000);
    const view = ledgerTasks(l);
    expect(view.current.map((t) => [t.id, t.status, t.toolCalls])).toEqual([['T1', 'completed', 5]]);
    expect(view.earlier.map((t) => [t.id, t.content, t.dropped, t.toolCalls])).toEqual([
      ['T2', 'Implement logout API', 'started', 5],
    ]);
  });

  it('a running task is not put back to waiting under new words (fable R1 S1)', () => {
    let l = applyTodoList(
      undefined,
      [todo('Fix dashboard card toggle test', 'in_progress'), todo('Deploy to dev')],
      1_000,
    );
    tools(l, 17);
    l = applyTodoList(l, [todo('Write dashboard card tests'), todo('Deploy to dev')], 2_000);
    const view = ledgerTasks(l);
    expect(view.current.map((t) => [t.id, t.toolCalls, t.firstStartedAt])).toEqual([
      ['T3', 0, undefined],
      ['T2', 0, undefined],
    ]);
    expect(view.earlier.map((t) => [t.id, t.dropped, t.toolCalls])).toEqual([['T1', 'started', 17]]);
  });

  it('an unstarted task the list dropped stays 실행 안 됨 — no fake rewrite on another (fable R1 S2b)', () => {
    let l = applyTodoList(undefined, [todo('Fix card toggle test', 'in_progress'), todo('Fix card deck test')], 1_000);
    tools(l, 10);
    l = applyTodoList(l, [todo('Fix card toggle test — done', 'completed')], 2_000);
    const view = ledgerTasks(l);
    expect(view.current[0].revisions).toEqual([{ at: 2_000, content: 'Fix card toggle test' }]);
    expect(view.earlier.map((t) => [t.content, t.dropped])).toEqual([['Fix card deck test', 'unstarted']]);
  });

  it('work before the first list is held, then handed to what the first list reports done (fable R1 P2)', () => {
    let l: TaskLedger | undefined = emptyTaskLedger(1_000);
    tools(l, 4);
    creditTaskUsage(l, 'm:e', { inputTokens: 30 }, 0.03);
    expect(ledgerTasks(l).outside?.toolCalls).toBe(4); // visible while it waits
    l = applyTodoList(l, [todo('Explore the code', 'completed'), todo('Fix it', 'in_progress')], 5_000);
    const [explore, fix] = ledgerTasks(l).current;
    expect([explore.toolCalls, explore.tokens?.input, explore.startedAt, explore.startEstimated]).toEqual([
      4,
      30,
      1_000,
      true,
    ]);
    expect(fix.toolCalls).toBe(0);
    expect(ledgerTasks(l).outside).toBeUndefined();
  });

  it('a credit on the new ledger never changes the old one (fable R1 P3)', () => {
    const a = applyTodoList(undefined, [todo('A', 'in_progress')], 1_000);
    creditTaskUsage(a, 'm:1', { outputTokens: 10 }, 0);
    const b = applyTodoList(a, [todo('A', 'in_progress')], 2_000);
    creditTaskUsage(b, 'm:2', { outputTokens: 5 }, 0);
    expect(ledgerTasks(a).current[0].tokens?.output).toBe(10);
    expect(ledgerTasks(b).current[0].tokens?.output).toBe(15);
  });

  it('usage after the last task completed shows as outside any task (astra R1 P1-3)', () => {
    let l = applyTodoList(undefined, [todo('A', 'in_progress')], 1_000);
    creditTaskUsage(l, 'm:1', { outputTokens: 100 }, 0);
    l = applyTodoList(l, [todo('A', 'completed')], 2_000);
    creditTaskUsage(l, 'm:2', { outputTokens: 500 }, 0); // the final answer
    const restored = sanitizeTaskLedger(JSON.parse(JSON.stringify(l)))!;
    expect(ledgerTasks(restored).current[0].tokens?.output).toBe(100);
    expect(ledgerTasks(restored).outside?.tokens.output).toBe(500);
  });

  it('another target is another task, however alike the words (astra R2 P1)', () => {
    const pairs: Array<[string, string]> = [
      ['Fix #455', 'Fix #456'],
      ['Deploy to dev', 'Deploy to prod'],
      ['Implement login API', 'Implement logout API'],
      ['Review PR #450 and fix the findings', 'Review PR #451 and fix the findings'],
    ];
    for (const [from, to] of pairs) {
      let l = applyTodoList(undefined, [todo(from, 'in_progress')], 1_000);
      tools(l, 17);
      l = applyTodoList(l, [todo(to, 'in_progress')], 2_000);
      const view = ledgerTasks(l);
      expect(view.current.map((t) => [t.content, t.toolCalls])).toEqual([[to, 0]]);
      expect(view.earlier.map((t) => [t.content, t.dropped, t.toolCalls])).toEqual([[from, 'started', 17]]);
    }
    // Review R3: a ref with punctuation, and one environment for another in a long text.
    const r3: Array<[string, string]> = [
      ['Review and merge PR #450.', 'Review and merge PR #451.'],
      ['Deploy the dashboard to dev and verify', 'Deploy the dashboard to prod and verify'],
      ['Deploy to development, then smoke test', 'Deploy to production, then smoke test'],
    ];
    for (const [from, to] of r3) {
      let l = applyTodoList(undefined, [todo(from, 'in_progress')], 1_000);
      tools(l, 17);
      l = applyTodoList(l, [todo(to, 'completed')], 2_000);
      const view = ledgerTasks(l);
      expect(view.current.map((t) => [t.content, t.toolCalls])).toEqual([[to, 0]]);
      expect(view.earlier.map((t) => [t.content, t.dropped, t.toolCalls])).toEqual([[from, 'started', 17]]);
    }
    // The same env under another name, or several envs, is no target change.
    expect(changesTarget('Deploy to dev', 'Deploy to development — green')).toBe(false);
    expect(changesTarget('Deploy dev and prod', 'Deploy dev and prod — done')).toBe(false);
    expect(changesTarget('Merge PR #450.', 'Merge PR #450 (squash a1b2c3d)')).toBe(false);
    // New words for the same target are still a rewrite.
    expect(changesTarget('Fix #455', 'Fix #455 — merged (a1b2c3d)')).toBe(false);
    expect(changesTarget('Final report', 'Report')).toBe(false);
    expect(
      changesTarget('T1.3 Serve via authenticated artifact route', 'T1.3 Serve via authenticated media route'),
    ).toBe(false);
  });

  it('a call re-reported lower takes the credit back down (grok P2 — the delta is signed)', () => {
    const l = applyTodoList(undefined, [todo('A', 'in_progress')], 1_000);
    creditTaskUsage(l, 'm:z', { outputTokens: 40 }, 0);
    creditTaskUsage(l, 'm:z', { outputTokens: 10 }, 0);
    creditTaskUsage(l, 'm:z', { outputTokens: 12 }, 0);
    expect(ledgerTasks(l).current[0].tokens?.output).toBe(12);
  });
});
