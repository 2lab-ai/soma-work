/**
 * The execution context a turn runs under (#597, .prd/17 D2/D6, T6/T8), and the
 * owner-root check `taskDirectoryFor` (an epic child's folder, #854).
 *
 * The context is built by the server from the Slack-signed event, never from model
 * input; a turn with no context is refused (it never falls back to `bypass`).
 * (#855 — the Slack-less dashboard task's context is gone.)
 */
import * as fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExecutionContextMissingError, executionContextFromSlack, taskDirectoryFor } from '../execution-context';

describe('taskDirectoryFor — a directory inside the owner’s /tmp root (D6)', () => {
  it('normalizes a /private/tmp directory to its /tmp form', () => {
    expect(taskDirectoryFor('U1', '/private/tmp/U1/session_x')).toBe('/tmp/U1/session_x');
  });

  it.each([
    ['no owner', '', '/tmp/U1/session_x'],
    ['an owner id with a path separator', '../U1', '/tmp/U1/session_x'],
    ['no working directory', 'U1', undefined],
    ['a relative directory', 'U1', 'U1/repo'],
    ['a directory outside the owner’s /tmp root', 'U1', '/work/U1/repo'],
    ['another user’s directory', 'U1', '/tmp/U2/session_x'],
    ['a traversal out of the owner’s root', 'U1', '/tmp/U1/../U2/session_x'],
    ['the owner root itself (no directory in it)', 'U1', '/tmp/U1'],
    ['a sibling that only shares the prefix', 'U1', '/tmp/U10/session_x'],
  ])('refuses %s', (_label, ownerId, dir) => {
    expect(() => taskDirectoryFor(ownerId, dir)).toThrow(ExecutionContextMissingError);
  });
});

describe('taskDirectoryFor — symlinks (#613 R1)', () => {
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

  it('refuses a directory that is a symlink out of the owner’s root', () => {
    expect(() => taskDirectoryFor(OWNER, `${ownerRoot}/session_link`)).toThrow(ExecutionContextMissingError);
  });

  it('refuses a not-yet-created directory under such a symlink', () => {
    expect(() => taskDirectoryFor(OWNER, `${ownerRoot}/session_link/sub`)).toThrow(ExecutionContextMissingError);
  });

  it('refuses a dangling symlink inside the owner’s root (#613 R2)', () => {
    fs.symlinkSync(`${ownerRoot}/nowhere`, `${ownerRoot}/session_dangling`);
    expect(() => taskDirectoryFor(OWNER, `${ownerRoot}/session_dangling`)).toThrow(ExecutionContextMissingError);
  });

  it('refuses a path that runs through a regular file (#613 R2)', () => {
    fs.writeFileSync(`${ownerRoot}/afile`, 'x');
    expect(() => taskDirectoryFor(OWNER, `${ownerRoot}/afile/sub`)).toThrow(ExecutionContextMissingError);
  });

  it('refuses a path it cannot inspect — an unreadable part is not "not created yet" (#613 R3)', () => {
    fs.mkdirSync(`${ownerRoot}/locked`);
    fs.chmodSync(`${ownerRoot}/locked`, 0o000);
    try {
      expect(() => taskDirectoryFor(OWNER, `${ownerRoot}/locked/sub`)).toThrow(ExecutionContextMissingError);
    } finally {
      fs.chmodSync(`${ownerRoot}/locked`, 0o700);
    }
  });

  it('accepts a real directory inside the owner’s root, in its /tmp form', () => {
    expect(taskDirectoryFor(OWNER, `${ownerRoot}/session_real`)).toBe(`${ownerRoot}/session_real`);
  });
});

describe('executionContextFromSlack (#597)', () => {
  it('#853 — carries planPending when the session’s plan is not started; none otherwise', () => {
    const planning = executionContextFromSlack({ user: 'U1', sessionKey: 'work:C1:1.1', planPending: true });
    expect((planning as { planPending?: true }).planPending).toBe(true);
    const plain = executionContextFromSlack({ user: 'U1', sessionKey: 'work:C1:1.1' });
    expect((plain as { planPending?: true }).planPending).toBeUndefined();
  });

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
