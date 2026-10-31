/**
 * #640 R3 (fable P1) — a dashboard task's folder is the owner's, not the
 * registry's to delete. A task can work in a folder the owner named (#600 ⑥);
 * a session's cleanup (`sourceWorkingDirs`, removed when it ends or sleeps)
 * must never take that folder with it:
 *
 *   - a revived task does not register its working directory for cleanup
 *     (the revive used to register `cwd` unconditionally, as for a Slack
 *     session's own `session_*` folder);
 *   - a task cannot register its own working directory as a source working
 *     dir (a model directive could name it).
 *
 * A clone inside the task's folder is still registered and cleaned, as on Slack.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR, emitter } = vi.hoisted(() => {
  const os2 = require('node:os') as typeof import('node:os');
  const path2 = require('node:path') as typeof import('node:path');
  return {
    TEST_DATA_DIR: path2.join(os2.tmpdir(), `soma-work-task-folder-cleanup-test-${process.pid}`),
    emitter: { emitSessionClosed: async () => {}, emitSessionSlept: async () => {} },
  };
});

vi.mock('../env-paths', () => ({ DATA_DIR: TEST_DATA_DIR }));
vi.mock('../metrics/event-emitter', () => ({ getMetricsEmitter: () => emitter }));

import { __resetSessionLifecyclePolicyForTests } from '../session-lifecycle-policy';
import { SessionRegistry } from '../session-registry';

const OWNER = `U0T640REV${process.pid}`;
const ROOT = path.join('/tmp', OWNER);
const NAMED = path.join(ROOT, 'repo-a');
const TASK_ID = '64064064-0640-4640-8640-640640640640';

beforeEach(() => {
  if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5 });
  fs.mkdirSync(path.join(TEST_DATA_DIR, 'archives'), { recursive: true });
  __resetSessionLifecyclePolicyForTests(path.join(TEST_DATA_DIR, 'session-lifecycle.json'));
  fs.mkdirSync(NAMED, { recursive: true });
  fs.writeFileSync(path.join(NAMED, 'work.txt'), 'the owner’s work');
});
afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

function archivedTask() {
  return {
    archivedAt: Date.now(),
    archiveReason: 'terminated',
    sessionKey: `task:${TASK_ID}`,
    sessionId: 'sdk-task',
    taskId: TASK_ID,
    slackless: true,
    ownerId: OWNER,
    ownerName: 'Owner',
    lastActivity: new Date().toISOString(),
  } as never;
}

describe('a dashboard task’s named folder survives the registry’s cleanup (#640 R3)', () => {
  it('a revived task does not register its folder: closing it again leaves the folder and its files', () => {
    const reg = new SessionRegistry();
    expect(reg.restoreArchivedSession(archivedTask(), NAMED)).toMatchObject({ ok: true });
    const revived = reg.getSessionByKey(`task:${TASK_ID}`)!;
    expect(revived.slackless).toBe(true);
    expect(revived.workingDirectory).toBe(NAMED);
    expect(revived.sourceWorkingDirs ?? []).not.toContain(NAMED);

    expect(reg.terminateSession(`task:${TASK_ID}`)).toBe(true);
    expect(fs.existsSync(path.join(NAMED, 'work.txt'))).toBe(true);
  });

  it('a task cannot register its own folder for cleanup; a clone inside it still can', () => {
    const reg = new SessionRegistry();
    const task = reg.createTask({ ownerId: OWNER, ownerName: 'Owner', workingDirectory: NAMED, title: 't' });
    const key = `task:${task.taskId}`;
    expect(reg.addSourceWorkingDirByKey(key, NAMED)).toBe(false);
    expect(reg.addSourceWorkingDirByKey(key, ROOT)).toBe(false); // the owner's root is never a source dir
    const clone = path.join(NAMED, 'clone');
    fs.mkdirSync(clone, { recursive: true });
    expect(reg.addSourceWorkingDirByKey(key, clone)).toBe(true);

    expect(reg.terminateSession(key)).toBe(true);
    expect(fs.existsSync(path.join(NAMED, 'work.txt'))).toBe(true);
    expect(fs.existsSync(clone)).toBe(false); // a clone is cleaned, as on Slack
  });

  it('a Slack session’s revive still registers its own session folder for cleanup (unchanged)', () => {
    const reg = new SessionRegistry();
    const slackDir = path.join(ROOT, 'session_1793000000000_ab12cd99');
    fs.mkdirSync(slackDir, { recursive: true });
    const outcome = reg.restoreArchivedSession(
      {
        archivedAt: Date.now(),
        archiveReason: 'sleep_expired',
        sessionKey: 'work:C1:640.001',
        sessionId: 'sdk-slack',
        ownerId: OWNER,
        channelId: 'C1',
        threadTs: '640.001',
        lastActivity: new Date().toISOString(),
      } as never,
      slackDir,
    );
    expect(outcome).toMatchObject({ ok: true });
    expect(reg.getSession('C1', '640.001')!.sourceWorkingDirs).toEqual([slackDir]);
  });
});
