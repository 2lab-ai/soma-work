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
import { cleanupOwnerOf, createTaskLauncher, listTaskFolders, taskTitleOf } from '../task-launcher';

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

function harness(
  over: {
    canStart?: unknown;
    startStatus?: number;
    cleanupSessions?: () => Array<{ key: string; sourceWorkingDirs?: string[] }>;
  } = {},
) {
  const calls: string[] = [];
  const created: Array<Record<string, unknown>> = [];
  const controller = {
    canStart: vi.fn((ownerId: string, _text?: string) => {
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
    listModels: () => MODELS,
    cleanupSessions: over.cleanupSessions,
  });
  return { launcher, controller, calls, created };
}

/** The models the dialog offers the owner (nickname → id). */
const MODELS = [
  { nickname: 'opus', model: 'claude-opus-5-5[1m]' },
  { nickname: 'fable', model: 'claude-fable-1' },
];

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
    // #640 R1: the dry run sees the instruction, so a command is refused before a task exists.
    expect(h.controller.canStart).toHaveBeenCalledWith(OWNER, REQ.prompt);
  });

  it('a named folder must be an existing directory directly inside the owner’s /tmp root', async () => {
    const h = harness();
    const r = await h.launcher.launch({ ...REQ, folder: EXISTING, model: 'opus' });
    expect(r.status).toBe(200);
    expect(h.created[0]).toMatchObject({ workingDirectory: path.join(ROOT, EXISTING), model: 'claude-opus-5-5[1m]' });
  });

  // #640 R1/R2: the model is a nickname the dialog offers the owner, resolved here —
  // from the model catalog alone, not the Slack-dependent new-task context.
  it.each([
    ['a raw model id', 'claude-opus-5-5[1m]'],
    ['a model not offered', 'haiku'],
  ])('%s is 400 and nothing is created or started', async (_label, model) => {
    const h = harness();
    const r = await h.launcher.launch({ ...REQ, model });
    expect(r).toEqual({ status: 400, body: { error: 'model must be one of the models the dialog offers' } });
    expect(h.calls).not.toContain('fresh');
    expect(h.calls).not.toContain('createTask');
    expect(h.controller.start).not.toHaveBeenCalled();
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

  // #640 R2 (astra P1): a folder another session's cleanup removes (its session_* folder,
  // a clone inside it) would take the task's work with it when that session ends or sleeps.
  it('a named folder another session will clean up is 409, and nothing is created', async () => {
    const owned = path.join(ROOT, EXISTING);
    const h = harness({ cleanupSessions: () => [{ key: 'C1:1700000000.000100', sourceWorkingDirs: [owned] }] });
    const r = await h.launcher.launch({ ...REQ, folder: EXISTING });
    expect(r).toEqual({
      status: 409,
      body: {
        error: `the folder ${EXISTING} belongs to another session, which removes it when it ends — pick another folder or a new one`,
      },
    });
    expect(h.calls).not.toContain('createTask');
    expect(h.controller.start).not.toHaveBeenCalled();
  });

  it('the folder list leaves out folders another session will clean up', () => {
    const owned = path.join(ROOT, EXISTING);
    let snapshots = 0;
    const h = harness({
      cleanupSessions: () => {
        snapshots += 1;
        return [{ key: 'C1:1', sourceWorkingDirs: [owned] }];
      },
    });
    const names = h.launcher.folders(OWNER).map((f) => f.name);
    expect(names).not.toContain(EXISTING);
    expect(snapshots).toBe(1); // one snapshot of the sessions per list, not one per folder (#640 R3)
    expect(
      harness()
        .launcher.folders(OWNER)
        .map((f) => f.name),
    ).toContain(EXISTING);
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

  // #640 R1 (fable P3): a fresh folder made for a task that is then not made is not left behind.
  it('a task that cannot be saved fails the launch: nothing started, and its fresh folder removed', async () => {
    const h = harness();
    const fresh = path.join(ROOT, `${RUN}_fresh_unsaved`);
    const launcher = createTaskLauncher({
      controller: h.controller,
      createTask: () => {
        throw new Error('ENOSPC');
      },
      createFreshDirectory: () => {
        fs.mkdirSync(fresh, { recursive: true });
        return fresh;
      },
    });
    await expect(launcher.launch(REQ)).rejects.toThrow('ENOSPC');
    expect(h.controller.start).not.toHaveBeenCalled();
    expect(fs.existsSync(fresh)).toBe(false);
  });

  it('a fresh folder the containment check refuses is removed, and nothing is created', async () => {
    const h = harness();
    const outsideFresh = path.join(OUTSIDE, 'session_fresh');
    const launcher = createTaskLauncher({
      controller: h.controller,
      createTask: () => {
        throw new Error('must not be called');
      },
      createFreshDirectory: () => {
        fs.mkdirSync(outsideFresh, { recursive: true });
        return outsideFresh;
      },
    });
    const r = await launcher.launch(REQ);
    expect(r.status).toBe(422);
    expect(fs.existsSync(outsideFresh)).toBe(false);
    expect(h.controller.start).not.toHaveBeenCalled();
  });

  it('a named folder is never removed when the task cannot be saved', async () => {
    const h = harness();
    const launcher = createTaskLauncher({
      controller: h.controller,
      createTask: () => {
        throw new Error('ENOSPC');
      },
      createFreshDirectory: () => undefined,
    });
    await expect(launcher.launch({ ...REQ, folder: EXISTING })).rejects.toThrow('ENOSPC');
    expect(fs.existsSync(path.join(ROOT, EXISTING))).toBe(true);
  });
});

// #640 R1 (astra P1): an owner root `/tmp/<owner>` that is itself a link (to
// another user's root, say) is not listed, not created in, and not named into.
describe('an owner root that is a link (#640 R1)', () => {
  const LINKED = `U0T600LNK${process.pid}`;
  const LINKED_ROOT = path.join('/tmp', LINKED);
  const NEW_OWNER = `U0T600NEW${process.pid}`;
  beforeAll(() => {
    fs.mkdirSync(path.join(OUTSIDE, 'their_repo'), { recursive: true });
    fs.rmSync(LINKED_ROOT, { recursive: true, force: true });
    fs.symlinkSync(OUTSIDE, LINKED_ROOT);
  });
  afterAll(() => {
    fs.rmSync(LINKED_ROOT, { force: true });
    fs.rmSync(path.join('/tmp', NEW_OWNER), { recursive: true, force: true });
  });

  it('lists nothing — the folders behind the link are someone else’s', () => {
    expect(fs.readdirSync(LINKED_ROOT)).toContain('their_repo'); // the link does lead somewhere
    expect(listTaskFolders(LINKED)).toEqual([]);
  });

  it('refuses a fresh folder before creating one, and refuses a named folder', async () => {
    const h = harness();
    const fresh = await h.launcher.launch({ ...REQ, ownerId: LINKED });
    expect(fresh.status).toBe(422);
    expect(h.calls).not.toContain('fresh');
    const named = await h.launcher.launch({ ...REQ, ownerId: LINKED, folder: 'their_repo' });
    expect(named.status).toBe(422);
    expect(h.calls).not.toContain('createTask');
    expect(h.controller.start).not.toHaveBeenCalled();
  });

  it('a root that is a file is refused before a fresh folder is made', async () => {
    const fileOwner = `U0T600FILE${process.pid}`;
    const fileRoot = path.join('/tmp', fileOwner);
    fs.writeFileSync(fileRoot, 'not a folder');
    try {
      const h = harness();
      const r = await h.launcher.launch({ ...REQ, ownerId: fileOwner });
      expect(r.status).toBe(422);
      expect(h.calls).not.toContain('fresh');
      expect(listTaskFolders(fileOwner)).toEqual([]);
    } finally {
      fs.rmSync(fileRoot, { force: true });
    }
  });

  it('an owner with no root yet still gets a fresh folder (created as a real directory)', async () => {
    const h = harness();
    const r = await h.launcher.launch({ ...REQ, ownerId: NEW_OWNER });
    expect(h.calls).toContain('fresh');
    expect(r.status).toBe(200);
  });
});

describe('listTaskFolders (#600 ⑥)', () => {
  it('lists the real folders directly in the owner’s root, newest first — no files, links or hidden folders', () => {
    const hidden = path.join(ROOT, `.${RUN}_hidden`);
    fs.mkdirSync(hidden, { recursive: true });
    try {
      const names = listTaskFolders(OWNER).map((f) => f.name);
      expect(names).toContain(EXISTING);
      expect(names).not.toContain(`${RUN}_file`);
      expect(names).not.toContain(`${RUN}_link`);
      expect(names).not.toContain(`.${RUN}_hidden`);
      const mtimes = listTaskFolders(OWNER).map((f) => f.mtimeMs);
      expect([...mtimes].sort((a, b) => b - a)).toEqual(mtimes);
    } finally {
      fs.rmSync(hidden, { recursive: true, force: true });
    }
  });

  it('is capped, and empty for an owner with no root or an unsafe id', () => {
    expect(listTaskFolders(OWNER, 1)).toHaveLength(1);
    expect(listTaskFolders('U0T600NOROOT_' + RUN)).toEqual([]);
    expect(listTaskFolders('../etc')).toEqual([]);
  });
});

describe('cleanupOwnerOf (#640 R2)', () => {
  const sessions = [
    { key: 'C1:1', sourceWorkingDirs: ['/private/tmp/U1/session_a'] },
    { key: 'C2:2', sourceWorkingDirs: ['/tmp/U1/session_b/clone'] },
    { key: 'task:x', sourceWorkingDirs: undefined },
  ];
  it('names the session whose cleanup removes the folder, a part of it, or a folder holding it', () => {
    expect(cleanupOwnerOf('/tmp/U1/session_a', sessions)).toBe('C1:1'); // the same folder (/private/tmp form)
    expect(cleanupOwnerOf('/tmp/U1/session_b', sessions)).toBe('C2:2'); // a clone inside the folder
    expect(cleanupOwnerOf('/tmp/U1/session_a/sub', sessions)).toBe('C1:1'); // inside a cleaned folder
    expect(cleanupOwnerOf('/private/tmp/U1/session_b', sessions)).toBe('C2:2'); // either side in /private/tmp form
  });
  it('is undefined for a folder nobody cleans, and for a mere name prefix', () => {
    expect(cleanupOwnerOf('/tmp/U1/repo', sessions)).toBeUndefined();
    expect(cleanupOwnerOf('/tmp/U1/session_a2', sessions)).toBeUndefined();
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
