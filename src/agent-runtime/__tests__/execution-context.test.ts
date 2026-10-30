/**
 * The execution context a turn runs under (#597, .prd/17 D2/D6, T6/T8).
 *
 * The context is built by the server from what it already trusts — the saved
 * task, or the Slack-signed event — never from model input. A task whose
 * owner, id or working directory cannot be vouched for gets no context, and a
 * turn with no context is refused (it never falls back to `bypass`).
 */
import * as fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConversationSession } from '../../types';
import { ExecutionContextMissingError, executionContextForTask, executionContextFromSlack } from '../execution-context';

const TASK_ID = '11111111-2222-4333-8444-555555555555';

function task(overrides: Partial<ConversationSession> = {}): ConversationSession {
  return {
    ownerId: 'U1',
    ownerName: 'Alice',
    userId: 'U1',
    channelId: '',
    slackless: true,
    taskId: TASK_ID,
    workingDirectory: '/tmp/U1/session_1793000000000_ab12cd34',
    isActive: true,
    lastActivity: new Date(),
    state: 'INITIALIZING',
    activityState: 'idle',
    ...overrides,
  } as ConversationSession;
}

describe('executionContextForTask (#597)', () => {
  it('takes the owner, the task key and the saved directory from the task', () => {
    const ctx = executionContextForTask(task());
    expect(ctx).toEqual({
      origin: 'task',
      userId: 'U1',
      isAdmin: false,
      permissionMode: 'auto', // a user with no explicit choice
      sessionKey: `task:${TASK_ID}`,
      taskId: TASK_ID,
      workingDirectory: '/tmp/U1/session_1793000000000_ab12cd34',
    });
  });

  it('is frozen — nothing downstream can swap the user or the directory', () => {
    const ctx = executionContextForTask(task());
    expect(Object.isFrozen(ctx)).toBe(true);
  });

  it('T8 — the owner wins over any other user field on the session', () => {
    const ctx = executionContextForTask(
      task({ userId: 'U2', currentInitiatorId: 'U3' } as Partial<ConversationSession>),
    );
    expect(ctx.userId).toBe('U1');
  });

  it('normalizes a /private/tmp directory to its /tmp form', () => {
    const ctx = executionContextForTask(task({ workingDirectory: '/private/tmp/U1/session_x' }));
    expect(ctx.workingDirectory).toBe('/tmp/U1/session_x');
  });

  it.each([
    ['a Slack session', { slackless: undefined }],
    ['no owner', { ownerId: '' }],
    ['an owner id with a path separator', { ownerId: '../U1' }],
    ['no task id', { taskId: undefined }],
    ['a task id with a separator', { taskId: 'a:b' }],
    ['no working directory', { workingDirectory: undefined }],
    ['a relative directory', { workingDirectory: 'U1/repo' }],
    ['a directory outside the owner’s /tmp root', { workingDirectory: '/work/U1/repo' }],
    ['another user’s directory', { workingDirectory: '/tmp/U2/session_x' }],
    ['a traversal out of the owner’s root', { workingDirectory: '/tmp/U1/../U2/session_x' }],
    ['the owner root itself (no task directory)', { workingDirectory: '/tmp/U1' }],
    ['a sibling that only shares the prefix', { workingDirectory: '/tmp/U10/session_x' }],
  ])('refuses a task with %s', (_label, overrides) => {
    expect(() => executionContextForTask(task(overrides as Partial<ConversationSession>))).toThrow(
      ExecutionContextMissingError,
    );
  });
});

describe('executionContextForTask — symlinks (#613 R1)', () => {
  const OWNER = 'U0EXECCTXOWN';
  const OTHER = 'U0EXECCTXOTH';
  const ownerRoot = `/tmp/${OWNER}`;
  const otherRoot = `/tmp/${OTHER}`;
  beforeEach(() => {
    fs.mkdirSync(`${ownerRoot}/session_real`, { recursive: true });
    fs.mkdirSync(`${otherRoot}/target`, { recursive: true });
    fs.symlinkSync(`${otherRoot}/target`, `${ownerRoot}/session_link`);
  });
  afterEach(() => {
    fs.rmSync(ownerRoot, { recursive: true, force: true });
    fs.rmSync(otherRoot, { recursive: true, force: true });
  });

  it('refuses a task directory that is a symlink out of the owner’s root', () => {
    expect(() =>
      executionContextForTask(task({ ownerId: OWNER, workingDirectory: `${ownerRoot}/session_link` })),
    ).toThrow(ExecutionContextMissingError);
  });

  it('refuses a not-yet-created directory under such a symlink', () => {
    expect(() =>
      executionContextForTask(task({ ownerId: OWNER, workingDirectory: `${ownerRoot}/session_link/sub` })),
    ).toThrow(ExecutionContextMissingError);
  });

  it('refuses a dangling symlink inside the owner’s root (#613 R2)', () => {
    fs.symlinkSync(`${ownerRoot}/nowhere`, `${ownerRoot}/session_dangling`);
    expect(() =>
      executionContextForTask(task({ ownerId: OWNER, workingDirectory: `${ownerRoot}/session_dangling` })),
    ).toThrow(ExecutionContextMissingError);
  });

  it('refuses a path that runs through a regular file (#613 R2)', () => {
    fs.writeFileSync(`${ownerRoot}/afile`, 'x');
    expect(() => executionContextForTask(task({ ownerId: OWNER, workingDirectory: `${ownerRoot}/afile/sub` }))).toThrow(
      ExecutionContextMissingError,
    );
  });

  it('refuses a path it cannot inspect — an unreadable part is not "not created yet" (#613 R3)', () => {
    fs.mkdirSync(`${ownerRoot}/locked`);
    fs.chmodSync(`${ownerRoot}/locked`, 0o000);
    try {
      expect(() =>
        executionContextForTask(task({ ownerId: OWNER, workingDirectory: `${ownerRoot}/locked/sub` })),
      ).toThrow(ExecutionContextMissingError);
    } finally {
      fs.chmodSync(`${ownerRoot}/locked`, 0o700);
    }
  });

  it('accepts a real directory inside the owner’s root, in its /tmp form', () => {
    const ctx = executionContextForTask(task({ ownerId: OWNER, workingDirectory: `${ownerRoot}/session_real` }));
    expect(ctx.workingDirectory).toBe(`${ownerRoot}/session_real`);
  });
});

describe('executionContextFromSlack (#597)', () => {
  it('uses the Slack event user, the thread key and the turn directory', () => {
    const ctx = executionContextFromSlack({
      user: 'U1',
      sessionKey: 'work:C1:100.001',
      workingDirectory: '/tmp/U1/session_x',
    });
    expect(ctx).toMatchObject({
      origin: 'slack',
      userId: 'U1',
      isAdmin: false,
      permissionMode: 'auto',
      sessionKey: 'work:C1:100.001',
      workingDirectory: '/tmp/U1/session_x',
    });
    expect(Object.isFrozen(ctx)).toBe(true);
  });

  it('refuses an empty user — an empty user used to mean bypass (mcp-config-builder)', () => {
    expect(() =>
      executionContextFromSlack({ user: '', sessionKey: 'work:C1:100.001', workingDirectory: '/tmp/x' }),
    ).toThrow(ExecutionContextMissingError);
  });
});
