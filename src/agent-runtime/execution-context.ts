/**
 * The execution context a turn runs under (#597, .prd/17 D2 · D3 · D6).
 *
 * Permission decisions read this — the user, whether they are an admin, their
 * permission mode, the session key and the working directory — and nothing the
 * model or a request body supplies. The server builds it from what it already
 * trusts: the Slack-signed event for a Slack turn, the saved task for a
 * Slack-less one. A turn with no context is refused; it never falls back to
 * `bypass` (the old `!slackContext → bypass` default in mcp-config-builder).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { isAdminUser } from '../admin-utils';
import { isSafePathSegment, normalizeTmpPath } from '../path-utils';
import { buildTaskSessionKey } from '../session-identity';
import type { ConversationSession } from '../types';
import { userSettingsStore } from '../user-settings-store';
import type { PermissionMode } from './policy/permission-mode';

export type ExecutionOrigin = 'slack' | 'task';

declare const vouchedByServer: unique symbol;

/**
 * Built once per turn by one of the two factories below — never assembled by
 * hand, never cached across turns (an admin removal or a mode change applies
 * from the next turn). The brand makes "the server built it" a type: a plain
 * object literal is not an ExecutionContext (#613 R1).
 */
export interface ExecutionContext {
  readonly [vouchedByServer]: true;
  readonly origin: ExecutionOrigin;
  readonly userId: string;
  readonly isAdmin: boolean;
  readonly permissionMode: PermissionMode;
  /** The registry key: `work:<channel>:<thread>` (Slack) or `task:<taskId>`. */
  readonly sessionKey: string;
  readonly taskId?: string;
  /** A task's is always set and validated; a Slack turn's is the one the pipeline chose. */
  readonly workingDirectory?: string;
}

/** A Slack-less task's context: its id and its validated directory are always there. */
export interface TaskExecutionContext extends ExecutionContext {
  readonly origin: 'task';
  readonly taskId: string;
  readonly workingDirectory: string;
}

/** A turn was asked to run without a context the server can vouch for. */
export class ExecutionContextMissingError extends Error {
  readonly code = 'EXECUTION_CONTEXT_MISSING';
  constructor(reason: string) {
    super(`Turn refused: no execution context (${reason})`);
    this.name = 'ExecutionContextMissingError';
  }
}

function contextFor(origin: ExecutionOrigin, userId: string, sessionKey: string) {
  return {
    origin,
    userId,
    isAdmin: isAdminUser(userId),
    permissionMode: userSettingsStore.getUserPermissionMode(userId),
    sessionKey,
  };
}

/**
 * A Slack turn: the user is the one the Slack event carries. An empty user is
 * refused — it is exactly the value that used to select `bypass`.
 */
export function executionContextFromSlack(input: {
  user: string;
  sessionKey: string;
  workingDirectory?: string;
}): ExecutionContext {
  if (!input.user) throw new ExecutionContextMissingError('Slack turn with no user');
  return Object.freeze({
    ...contextFor('slack', input.user, input.sessionKey),
    ...(input.workingDirectory ? { workingDirectory: input.workingDirectory } : {}),
  }) as ExecutionContext;
}

/**
 * A Slack-less task: the owner, the task key and the working directory all
 * come from the saved task. The directory must be a task directory inside the
 * owner's `/tmp/<ownerId>/` root (the root the sandbox mounts for writing and
 * the cross-user check guards) — not a channel's repo, not another user's
 * directory, not the root itself (D6).
 */
export function executionContextForTask(session: ConversationSession): TaskExecutionContext {
  if (session.slackless !== true) throw new ExecutionContextMissingError('not a Slack-less task');
  const ownerId = session.ownerId;
  if (!ownerId || !isSafePathSegment(ownerId)) throw new ExecutionContextMissingError('task has no usable owner');
  if (!session.taskId) throw new ExecutionContextMissingError('task has no id');
  let sessionKey: string;
  try {
    sessionKey = buildTaskSessionKey(session.taskId);
  } catch {
    throw new ExecutionContextMissingError('task id is not a valid key');
  }
  const raw = session.workingDirectory;
  if (!raw || !path.isAbsolute(raw)) throw new ExecutionContextMissingError('task has no absolute working directory');
  // Judged by where it really is: a symlink inside the owner's root that leads
  // out of it does not pass (#613 R1).
  const workingDirectory = realDirectory(path.resolve(raw));
  const ownerRoot = `/tmp/${ownerId}`;
  if (!workingDirectory.startsWith(`${ownerRoot}/`)) {
    throw new ExecutionContextMissingError('task working directory is outside the owner’s /tmp root');
  }
  return Object.freeze({
    ...contextFor('task', ownerId, sessionKey),
    origin: 'task',
    taskId: session.taskId,
    workingDirectory,
  }) as TaskExecutionContext;
}

/**
 * Re-check a task's directory right before the turn uses it (#613 R2): it must
 * still resolve to the same place inside the owner's root. A directory swapped
 * for a link out of the root after the context was built is refused.
 */
export function revalidateTaskDirectory(ctx: ExecutionContext): void {
  if (ctx.origin !== 'task' || !ctx.workingDirectory) {
    throw new ExecutionContextMissingError('not a task context with a directory');
  }
  const now = realDirectory(ctx.workingDirectory);
  if (now !== ctx.workingDirectory || !now.startsWith(`/tmp/${ctx.userId}/`)) {
    throw new ExecutionContextMissingError('task working directory moved since its context was built');
  }
}

/**
 * The real location of `p` in its `/tmp` form: symlinks are resolved on the
 * deepest part that exists, and a part not created yet is appended as named.
 * Fail closed (#613 R2): a dangling link, a part that is a regular file, or a
 * location that cannot be resolved has no context.
 */
function realDirectory(p: string): string {
  const pending: string[] = [];
  let existing = p;
  // lstat, not exists: a dangling link exists as a link and must not read as "not created yet".
  while (!lstatOrUndefined(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    pending.unshift(path.basename(existing));
    existing = parent;
  }
  let real: string;
  try {
    real = fs.realpathSync(existing);
  } catch {
    throw new ExecutionContextMissingError('task working directory cannot be resolved');
  }
  if (!fs.statSync(real).isDirectory()) {
    throw new ExecutionContextMissingError('task working directory runs through something that is not a directory');
  }
  return normalizeTmpPath(path.join(real, ...pending));
}

function lstatOrUndefined(p: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(p);
  } catch {
    return undefined;
  }
}
