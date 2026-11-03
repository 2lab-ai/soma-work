/**
 * The execution context a turn runs under (#597, .prd/17 D2 · D3 · D6).
 *
 * Permission decisions read this — the user, whether they are an admin, their
 * permission mode, the session key and the working directory — and nothing the
 * model or a request body supplies. The server builds it from what it already
 * trusts: the Slack-signed event. A turn with no context is refused; it never
 * falls back to `bypass` (the old `!slackContext → bypass` default in
 * mcp-config-builder). Every turn is a Slack turn since #855 (the Slack-less
 * dashboard task and its context are gone).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { isAdminUser } from '../admin-utils';
import { isSafePathSegment, normalizeTmpPath } from '../path-utils';
import { userSettingsStore } from '../user-settings-store';
import type { PermissionMode } from './policy/permission-mode';

export type ExecutionOrigin = 'slack';

declare const vouchedByServer: unique symbol;

/**
 * Built once per turn by the factory below — never assembled by
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
  /** The registry key: `work:<channel>:<thread>`. */
  readonly sessionKey: string;
  /** The one the pipeline chose for the turn. */
  readonly workingDirectory?: string;
  /**
   * Plan mode (SSOT 2026-11-02; any session since #853) — the session's plan is not started yet:
   * the turn plans instead of working (the `plan` server attaches; step 6c refuses the work).
   */
  readonly planPending?: true;
  /**
   * #854 — a Slack turn of an epic (not a child: depth 1): the epic's task id. The `epic`
   * server attaches on it, and its tools act on this epic only — never on an argument.
   */
  readonly epicTaskId?: string;
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
  /** #853 — the session's plan is not started yet (`isPlanPending(session.taskPlan)`). */
  planPending?: boolean;
  /** #854 — the session is an epic (not a child): its task id. */
  epicTaskId?: string;
}): ExecutionContext {
  if (!input.user) throw new ExecutionContextMissingError('Slack turn with no user');
  return Object.freeze({
    ...contextFor('slack', input.user, input.sessionKey),
    ...(input.workingDirectory ? { workingDirectory: input.workingDirectory } : {}),
    ...(input.planPending === true ? { planPending: true as const } : {}),
    ...(input.epicTaskId ? { epicTaskId: input.epicTaskId } : {}),
  }) as ExecutionContext;
}

/**
 * Where work of `ownerId` may run: the real location of `raw`, which must be
 * absolute and strictly inside the owner's `/tmp/<ownerId>/` root (D6). An epic
 * child's folder is checked with it (`epic-child-folder.ts`, and the Slack
 * session initializer's placed folder, #854).
 */
export function taskDirectoryFor(ownerId: string, raw: string | undefined): string {
  if (!ownerId || !isSafePathSegment(ownerId)) throw new ExecutionContextMissingError('task has no usable owner');
  if (!raw || !path.isAbsolute(raw)) throw new ExecutionContextMissingError('task has no absolute working directory');
  // Judged by where it really is: a symlink inside the owner's root that leads
  // out of it does not pass (#613 R1).
  const workingDirectory = realDirectory(path.resolve(raw));
  if (!workingDirectory.startsWith(`/tmp/${ownerId}/`)) {
    throw new ExecutionContextMissingError('task working directory is outside the owner’s /tmp root');
  }
  return workingDirectory;
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
  } catch (error) {
    // Only "no such entry" means not created yet; a part that cannot be
    // inspected (EACCES, EIO, ELOOP, ENOTDIR…) has no context (#613 R3).
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
    throw new ExecutionContextMissingError('task working directory cannot be inspected');
  }
}
