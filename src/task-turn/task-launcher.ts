/**
 * #600 ⑥ — the dashboard's "new task" as a Slack-less task: no Slack root
 * message, a folder the server picks or validates, and a task that is only
 * created when it could start.
 *
 * Order (each step refuses before the next has any effect):
 * 1. a dry run of admission (`canStart`: shutdown, the owner's running task,
 *    the start window) — a refusal creates nothing;
 * 2. the folder: a fresh `session_*` folder, or an existing folder named
 *    directly inside the owner's `/tmp/<owner>/` (a name, never a path);
 * 3. the same containment check the turn's context uses (`taskDirectoryFor`);
 * 4. the task, saved strictly (#596) — a save failure throws;
 * 5. the first instruction, started as the owner. A start refused after the
 *    task exists (a race) keeps the card and reports `not-started`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { taskDirectoryFor } from '../agent-runtime/execution-context';
import { isSafePathSegment } from '../path-utils';
import { buildTaskSessionKey } from '../session-identity';
import type { CreateTaskInput } from '../session-registry';
import type { TaskCommandResponse, TaskTurnController } from './task-turn-controller';

export interface TaskLaunchRequest {
  ownerId: string;
  ownerName: string;
  /** The first instruction (already trimmed and bounded by the route). */
  prompt: string;
  /** An existing folder's name directly inside `/tmp/<owner>/`; absent → a fresh folder. */
  folder?: string;
  model?: string;
}

export interface TaskLauncherDeps {
  controller: Pick<TaskTurnController, 'canStart' | 'start'>;
  createTask(input: CreateTaskInput): { taskId?: string };
  /** A fresh `session_*` folder under `/tmp/<owner>/` (WorkingDirectoryManager.createSessionBaseDir). */
  createFreshDirectory(ownerId: string): string | undefined;
}

export interface TaskLauncher {
  launch(request: TaskLaunchRequest): Promise<TaskCommandResponse>;
  /** The folders the owner may name (`listTaskFolders`). */
  folders(ownerId: string): Array<{ name: string; mtimeMs: number }>;
}

/** A folder name: no separators, no leading dot (so no `.`, `..` or hidden folders). */
const FOLDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const TITLE_MAX = 80;

const MAX_LISTED_FOLDERS = 50;

/**
 * The folders a task of `ownerId` may name: real directories (not links, not
 * hidden) directly inside `/tmp/<owner>/`, newest first, at most `limit`.
 */
export function listTaskFolders(ownerId: string, limit = MAX_LISTED_FOLDERS): Array<{ name: string; mtimeMs: number }> {
  if (!ownerId || !isSafePathSegment(ownerId)) return [];
  const root = path.join('/tmp', ownerId);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const folders: Array<{ name: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !FOLDER_NAME.test(entry.name)) continue;
    try {
      folders.push({ name: entry.name, mtimeMs: fs.statSync(path.join(root, entry.name)).mtimeMs });
    } catch {
      // gone meanwhile
    }
  }
  return folders.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
}

/** The card's first title: the prompt's first non-empty line, cut at 80 characters. */
export function taskTitleOf(prompt: string): string {
  const line = prompt
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return (line ?? '').slice(0, TITLE_MAX);
}

export function createTaskLauncher(deps: TaskLauncherDeps): TaskLauncher {
  const launchRefusal = (status: number, error: string): TaskCommandResponse => ({ status, body: { error } });

  return {
    folders: (ownerId: string) => listTaskFolders(ownerId),
    async launch(request: TaskLaunchRequest): Promise<TaskCommandResponse> {
      const { ownerId } = request;
      const refused = deps.controller.canStart(ownerId);
      if (refused) return refused;

      let folder: string;
      if (request.folder !== undefined) {
        if (!FOLDER_NAME.test(request.folder)) {
          return launchRefusal(422, 'the folder must be the name of a folder in your /tmp directory');
        }
        folder = path.join('/tmp', ownerId, request.folder);
        if (!isExistingTaskFolder(folder))
          return launchRefusal(422, `no folder named ${request.folder} in your /tmp directory`);
      } else {
        const fresh = deps.createFreshDirectory(ownerId);
        if (!fresh) return launchRefusal(500, 'a folder for the task could not be created');
        folder = fresh;
      }
      let workingDirectory: string;
      try {
        workingDirectory = taskDirectoryFor(ownerId, folder);
      } catch (error) {
        return launchRefusal(422, `the task cannot work in that folder: ${(error as Error).message}`);
      }

      const task = deps.createTask({
        ownerId,
        ownerName: request.ownerName,
        workingDirectory,
        title: taskTitleOf(request.prompt),
        ...(request.model ? { model: request.model } : {}),
      });
      if (!task.taskId) throw new Error('createTask returned a task without an id');
      const sessionKey = buildTaskSessionKey(task.taskId);

      const started = await deps.controller.start({ sessionKey, text: request.prompt, actorUserId: ownerId });
      if (started.status === 202) return { status: 200, body: { sessionKey, status: 'running' } };
      return {
        status: 200,
        body: { sessionKey, status: 'not-started', reason: String(started.body.error ?? `status ${started.status}`) },
      };
    },
  };
}

/** An existing directory that is not itself a link (a link is judged by `taskDirectoryFor`'s real path). */
function isExistingTaskFolder(p: string): boolean {
  try {
    const st = fs.lstatSync(p);
    return st.isDirectory() || st.isSymbolicLink();
  } catch {
    return false;
  }
}
