/**
 * #600 ⑥ — the dashboard's "new task" makes a Slack-less task: no Slack root
 * message, a server-chosen folder inside the owner's `/tmp/<owner>/`, created
 * only after a dry run of admission says it can start, then started with the
 * first instruction as its owner.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ExecutionContextMissingError, taskDirectoryFor } from '../../agent-runtime/execution-context';
import { createTaskLauncher, taskTitleOf } from '../task-launcher';

const OWNER = 'U0T600OWNER';
const ROOT = `/tmp/${OWNER}`;
const RUN = `t600_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
const EXISTING = `${RUN}_repo`;
const OUTSIDE = `/tmp/${OWNER}_other_${RUN}`;

beforeAll(() => {
  fs.mkdirSync(path.join(ROOT, EXISTING), { recursive: true });
  fs.mkdirSync(OUTSIDE, { recursive: true });
  fs.symlinkSync(OUTSIDE, path.join(ROOT, `${RUN}_link`));
  fs.writeFileSync(path.join(ROOT, `${RUN}_file`), 'x');
});
afterAll(() => {
  for (const name of [EXISTING, `${RUN}_link`, `${RUN}_file`, `${RUN}_fresh`]) {
    fs.rmSync(path.join(ROOT, name), { recursive: true, force: true });
  }
  fs.rmSync(OUTSIDE, { recursive: true, force: true });
});

const TASK_ID = '60060060-0600-4600-8600-600600600600';

function harness(over: { canStart?: unknown; startStatus?: number } = {}) {
  const calls: string[] = [];
  const created: Array<Record<string, unknown>> = [];
  const controller = {
    canStart: vi.fn((ownerId: string) => {
      calls.push(`canStart:${ownerId}`);
      return (over.canStart ?? null) as { status: number; body: { error: string } } | null;
    }),
    start: vi.fn(async (req: { sessionKey: string; text: string; actorUserId: string }) => {
      calls.push(`start:${req.sessionKey}:${req.actorUserId}`);
      const status = over.startStatus ?? 202;
      return status === 202
        ? { status, body: { ok: true } }
        : { status, body: { error: 'one dashboard task runs at a time — wait for it to finish' } };
    }),
  };
  const launcher = createTaskLauncher({
    controller,
    createTask: (input) => {
      calls.push('createTask');
      created.push(input as unknown as Record<string, unknown>);
      return { taskId: TASK_ID };
    },
    createFreshDirectory: (ownerId) => {
      calls.push('fresh');
      const dir = path.join('/tmp', ownerId, `${RUN}_fresh`);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },
  });
  return { launcher, controller, calls, created };
}

const REQ = { ownerId: OWNER, ownerName: 'Owner', prompt: 'Fix the flaky test\nand explain why' };

describe('createTaskLauncher (#600 ⑥)', () => {
  it('no folder: a fresh folder, the task created with it, then started as its owner with the prompt', async () => {
    const h = harness();
    const r = await h.launcher.launch(REQ);
    expect(r).toEqual({ status: 200, body: { sessionKey: `task:${TASK_ID}`, status: 'running' } });
    expect(h.calls).toEqual([`canStart:${OWNER}`, 'fresh', 'createTask', `start:task:${TASK_ID}:${OWNER}`]);
    expect(h.created[0]).toMatchObject({
      ownerId: OWNER,
      ownerName: 'Owner',
      workingDirectory: path.join(ROOT, `${RUN}_fresh`),
      title: 'Fix the flaky test',
    });
    expect(h.controller.start).toHaveBeenCalledWith({
      sessionKey: `task:${TASK_ID}`,
      text: REQ.prompt,
      actorUserId: OWNER,
    });
  });

  it('a named folder must be an existing directory directly inside the owner’s /tmp root', async () => {
    const h = harness();
    const r = await h.launcher.launch({ ...REQ, folder: EXISTING, model: 'opus' });
    expect(r.status).toBe(200);
    expect(h.created[0]).toMatchObject({ workingDirectory: path.join(ROOT, EXISTING), model: 'opus' });
  });

  it.each([
    ['a path, not a name', `${EXISTING}/sub`],
    ['a parent step', '..'],
    ['a hidden or dot name', '.'],
    ['a missing folder', `${RUN}_missing`],
    ['a file', `${RUN}_file`],
    ['a link out of the root', `${RUN}_link`],
  ])('%s is 422 and nothing is created or started', async (_label, folder) => {
    const h = harness();
    const r = await h.launcher.launch({ ...REQ, folder });
    expect(r.status).toBe(422);
    expect(h.calls).not.toContain('createTask');
    expect(h.controller.start).not.toHaveBeenCalled();
  });

  it('a dry run that refuses (the owner’s other task runs) creates nothing', async () => {
    const h = harness({ canStart: { status: 429, body: { error: 'one dashboard task runs at a time' } } });
    const r = await h.launcher.launch(REQ);
    expect(r).toEqual({ status: 429, body: { error: 'one dashboard task runs at a time' } });
    expect(h.calls).toEqual([`canStart:${OWNER}`]);
  });

  it('a start refused after the task exists (a race) keeps the card and says it did not start', async () => {
    const h = harness({ startStatus: 429 });
    const r = await h.launcher.launch(REQ);
    expect(r).toEqual({
      status: 200,
      body: {
        sessionKey: `task:${TASK_ID}`,
        status: 'not-started',
        reason: 'one dashboard task runs at a time — wait for it to finish',
      },
    });
  });

  it('a task that cannot be saved fails the launch (nothing started)', async () => {
    const h = harness();
    const launcher = createTaskLauncher({
      controller: h.controller,
      createTask: () => {
        throw new Error('ENOSPC');
      },
      createFreshDirectory: () => path.join(ROOT, EXISTING),
    });
    await expect(launcher.launch(REQ)).rejects.toThrow('ENOSPC');
    expect(h.controller.start).not.toHaveBeenCalled();
  });
});

describe('taskTitleOf', () => {
  it('is the first non-empty line, cut at 80 characters', () => {
    expect(taskTitleOf('\n  Fix it  \nmore')).toBe('Fix it');
    expect(taskTitleOf('x'.repeat(200))).toHaveLength(80);
  });
});

describe('taskDirectoryFor (#600 ⑥ — shared with executionContextForTask)', () => {
  it('returns the real directory inside the owner’s root', () => {
    expect(taskDirectoryFor(OWNER, path.join(ROOT, EXISTING))).toBe(path.join(ROOT, EXISTING));
  });
  it('refuses the root itself, a relative path, and a link out of the root', () => {
    expect(() => taskDirectoryFor(OWNER, ROOT)).toThrow(ExecutionContextMissingError);
    expect(() => taskDirectoryFor(OWNER, EXISTING)).toThrow(ExecutionContextMissingError);
    expect(() => taskDirectoryFor(OWNER, path.join(ROOT, `${RUN}_link`))).toThrow(ExecutionContextMissingError);
  });
});
