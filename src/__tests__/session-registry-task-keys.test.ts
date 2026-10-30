/**
 * #598 ④a — the registry calls a turn makes, by task key. A Slack-less task
 * (`task:<taskId>`, no channel/thread) cannot be reached through the
 * channel/thread forms: those build a Slack key and throw on an empty channel.
 * Each such call has a by-key form; the channel/thread form is unchanged.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR } = vi.hoisted(() => {
  const p = require('node:path');
  const os = require('node:os');
  return { TEST_DATA_DIR: p.join(os.tmpdir(), `soma-task-keys-test-${process.pid}`) };
});
const { emitGitHubEvent } = vi.hoisted(() => ({ emitGitHubEvent: vi.fn(async (..._args: unknown[]) => {}) }));
vi.mock('../metrics/event-emitter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../metrics/event-emitter')>();
  return {
    ...actual,
    getMetricsEmitter: () => ({
      emitGitHubEvent,
      emitSessionCreated: async () => {},
      emitSessionClosed: async () => {},
      emitSessionSlept: async () => {},
    }),
  };
});
vi.mock('../env-paths', () => ({
  DATA_DIR: TEST_DATA_DIR,
  CONFIG_FILE: '',
  SYSTEM_PROMPT_FILE: '',
  PLUGINS_DIR: '',
  IS_DEV: true,
}));

import { __resetSessionLifecyclePolicyForTests } from '../session-lifecycle-policy';
import { SessionRegistry } from '../session-registry';

const TASK_INPUT = { ownerId: 'U1', ownerName: 'User', workingDirectory: '/work/U1/repo', title: 'T' };

describe('SessionRegistry — turn calls by task key (#598 ④a)', () => {
  beforeEach(() => {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    __resetSessionLifecyclePolicyForTests(path.join(TEST_DATA_DIR, 'session-lifecycle.json'));
  });
  afterEach(() => {
    __resetSessionLifecyclePolicyForTests();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it('clearSessionIdByKey clears a task’s SDK session and its retry markers', () => {
    const reg = new SessionRegistry();
    const task = reg.createTask(TASK_INPUT);
    task.sessionId = 'sdk-1';
    task.errorRetryCount = 2;
    task.pendingRetryAt = Date.now() + 1000;
    reg.clearSessionIdByKey(`task:${task.taskId}`);
    expect(task.sessionId).toBeUndefined();
    expect(task.errorRetryCount).toBe(0);
    expect(task.pendingRetryAt).toBeUndefined();
  });

  it('setSessionLinksByKey links an issue and a PR to a task (the issue metric is keyed by the task key)', () => {
    const reg = new SessionRegistry();
    const task = reg.createTask(TASK_INPUT);
    reg.setSessionLinksByKey(`task:${task.taskId}`, {
      issue: { url: 'https://github.com/o/r/issues/1', type: 'issue', provider: 'github' },
      pr: { url: 'https://github.com/o/r/pull/2', type: 'pr', provider: 'github' },
    } as never);
    expect(task.links?.issue?.url).toBe('https://github.com/o/r/issues/1');
    expect(task.links?.pr?.url).toBe('https://github.com/o/r/pull/2');
    const issueEvents = emitGitHubEvent.mock.calls.filter((c: unknown[]) => c[0] === 'issue_created');
    expect(issueEvents).toHaveLength(1);
    expect(issueEvents[0][3]).toBe(`task:${task.taskId}`);
  });

  it('addMergeStatsByKey adds a merged PR to a task', () => {
    const reg = new SessionRegistry();
    const task = reg.createTask(TASK_INPUT);
    reg.addMergeStatsByKey(`task:${task.taskId}`, 7, 10, 3);
    expect(task.mergeStats?.mergedPRs.map((p) => p.prNumber)).toEqual([7]);
    expect(task.mergeStats?.totalLinesAdded).toBe(10);
  });

  it('addSourceWorkingDirByKey registers a directory for a task', () => {
    const reg = new SessionRegistry();
    const task = reg.createTask(TASK_INPUT);
    const dir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'src-'));
    // Only directories the registry accepts (per-user /tmp roots) register; the call must not throw either way.
    expect(() => reg.addSourceWorkingDirByKey(`task:${task.taskId}`, dir)).not.toThrow();
  });

  it('the channel/thread forms are unchanged for a Slack session', () => {
    const reg = new SessionRegistry();
    const s = reg.createSession('U1', 'User', 'C1', '100.001');
    s.sessionId = 'sdk-9';
    reg.addMergeStats('C1', '100.001', 5, 1, 1);
    reg.clearSessionId('C1', '100.001');
    expect(s.sessionId).toBeUndefined();
    expect(s.mergeStats?.mergedPRs.map((p) => p.prNumber)).toEqual([5]);
  });
});
