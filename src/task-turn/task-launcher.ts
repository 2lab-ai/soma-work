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
import { isSafePathSegment, normalizeTmpPath } from '../path-utils';
import { buildTaskSessionKey } from '../session-identity';
import type { CreateTaskInput } from '../session-registry';
import type { OriginThread, TaskInputContext } from '../types';
import type { TaskCommandResponse, TaskTurnController } from './task-turn-controller';

export interface TaskLaunchRequest {
  ownerId: string;
  ownerName: string;
  /** The first instruction (already trimmed and bounded by the route). */
  prompt: string;
  /** An existing folder's name directly inside `/tmp/<owner>/`; absent → a fresh folder. */
  folder?: string;
  /** The nickname of a model the dialog offers (`listModels`); absent → the default. */
  model?: string;
  /** E2 ⑧ — a Slack instruction's thread: the task's notices go there (D3). Absent for a dashboard launch. */
  originThread?: OriginThread;
  /** E2 ⑧ — the instruction channel's name, description and repos, copied onto the task (D4). */
  inputContext?: TaskInputContext;
  /** E4 ④a-2 (.prd/19 D12) — make an epic: only for an owner whose `epicTasks` flag is on. */
  kind?: 'epic';
}

export interface TaskLauncherDeps {
  controller: Pick<TaskTurnController, 'canStart' | 'start'>;
  createTask(input: CreateTaskInput): { taskId?: string };
  /** A fresh `session_*` folder under `/tmp/<owner>/` (WorkingDirectoryManager.createSessionBaseDir). */
  createFreshDirectory(ownerId: string): string | undefined;
  /**
   * The models the dialog offers the owner (`offeredNewTaskModels`): a request's
   * model is one of their nicknames, resolved here (#640 R1/R2). Absent → no model is accepted.
   */
  listModels?(ownerId: string): Array<{ nickname: string; model: string }>;
  /**
   * The live sessions' cleanup lists (`sourceWorkingDirs`, removed when a
   * session ends or sleeps). A named folder one of them would remove is
   * refused and not listed (#640 R2); read once per list or launch (#640 R3).
   */
  cleanupSessions?(): Iterable<{ key: string; sourceWorkingDirs?: string[] }>;
  /** E4 ④a-2 — may this owner make epic tasks (`/z epictasks`). Absent → no epic is made. */
  epicTasksEnabled?(ownerId: string): boolean;
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
  if (ownerRootState(ownerId) !== 'ok') return [];
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

/**
 * The session whose cleanup (`sourceWorkingDirs`, removed when it ends or
 * sleeps) would remove `dir`, a part of it, or a folder holding it — compared
 * as `/tmp` paths. Undefined when nobody does (#640 R2).
 */
export function cleanupOwnerOf(
  dir: string,
  sessions: Iterable<{ key: string; sourceWorkingDirs?: string[] }>,
): string | undefined {
  const target = normalizeTmpPath(path.resolve(dir));
  for (const { key, sourceWorkingDirs } of sessions) {
    for (const raw of sourceWorkingDirs ?? []) {
      const owned = normalizeTmpPath(path.resolve(raw));
      if (owned === target || owned.startsWith(`${target}/`) || target.startsWith(`${owned}/`)) return key;
    }
  }
  return undefined;
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
    // Not offered: a folder another session's cleanup would remove (#640 R2).
    folders: (ownerId: string) => {
      const sessions = [...(deps.cleanupSessions?.() ?? [])];
      return listTaskFolders(ownerId).filter((f) => !cleanupOwnerOf(path.join('/tmp', ownerId, f.name), sessions));
    },
    async launch(request: TaskLaunchRequest): Promise<TaskCommandResponse> {
      const { ownerId } = request;
      // E4 ④a-2 — an epic only behind the owner's flag; its first start is a new tree's root.
      const epic = request.kind === 'epic';
      if (epic && deps.epicTasksEnabled?.(ownerId) !== true) {
        return launchRefusal(403, 'epic tasks are off for you — turn them on with `/z epictasks on`');
      }
      const refused = epic
        ? deps.controller.canStart(ownerId, request.prompt, { role: 'root' })
        : deps.controller.canStart(ownerId, request.prompt);
      if (refused) return refused;
      // The model is one the dialog offers, by nickname — never an id from the body (#640 R1).
      let model: string | undefined;
      if (request.model !== undefined) {
        model = deps.listModels?.(ownerId).find((m) => m.nickname === request.model)?.model;
        if (!model) return launchRefusal(400, 'model must be one of the models the dialog offers');
      }
      // The owner's root itself must be a plain folder: a root that is a link
      // would list, create and name inside whatever it leads to (#640 R1).
      const root = ownerRootState(ownerId);
      if (root === 'unsafe')
        return launchRefusal(422, 'your /tmp directory is not a plain folder — a task cannot use it');

      let folder: string;
      let fresh: string | undefined;
      if (request.folder !== undefined) {
        if (!FOLDER_NAME.test(request.folder)) {
          return launchRefusal(422, 'the folder must be the name of a folder in your /tmp directory');
        }
        folder = path.join('/tmp', ownerId, request.folder);
        if (!isExistingTaskFolder(folder))
          return launchRefusal(422, `no folder named ${request.folder} in your /tmp directory`);
      } else {
        fresh = deps.createFreshDirectory(ownerId);
        if (!fresh) return launchRefusal(500, 'a folder for the task could not be created');
        folder = fresh;
      }
      let workingDirectory: string;
      try {
        workingDirectory = taskDirectoryFor(ownerId, folder);
      } catch (error) {
        removeUnusedFolder(fresh);
        return launchRefusal(422, `the task cannot work in that folder: ${(error as Error).message}`);
      }
      // A named folder another session removes when it ends or sleeps would take
      // the task's work with it (#640 R2). A fresh folder is new: nobody owns it.
      if (request.folder !== undefined && cleanupOwnerOf(workingDirectory, deps.cleanupSessions?.() ?? [])) {
        return launchRefusal(
          409,
          `the folder ${request.folder} belongs to another session, which removes it when it ends — pick another folder or a new one`,
        );
      }

      let task: { taskId?: string };
      try {
        task = deps.createTask({
          ownerId,
          ownerName: request.ownerName,
          workingDirectory,
          title: taskTitleOf(request.prompt),
          ...(model ? { model } : {}),
          ...(request.originThread ? { originThread: request.originThread } : {}),
          ...(request.inputContext ? { inputContext: request.inputContext } : {}),
          ...(epic ? { kind: 'epic' as const } : {}),
        });
      } catch (error) {
        // A fresh folder no task was made for is not left behind (#640 R1). A named one is the owner's.
        removeUnusedFolder(fresh);
        throw error;
      }
      if (!task.taskId) throw new Error('createTask returned a task without an id');
      const sessionKey = buildTaskSessionKey(task.taskId);

      // E4 ③ — the first start of a task it just made (a new epic counts against A0's window).
      const started = await deps.controller.start({
        sessionKey,
        text: request.prompt,
        actorUserId: ownerId,
        newTask: true,
      });
      if (started.status === 202) return { status: 200, body: { sessionKey, status: 'running' } };
      return {
        status: 200,
        body: { sessionKey, status: 'not-started', reason: String(started.body.error ?? `status ${started.status}`) },
      };
    },
  };
}

/**
 * The owner's `/tmp/<owner>` root: `ok` — a real directory (not a link) that
 * really is `/tmp/<owner>`; `missing` — not there yet (a fresh folder creates
 * it); `unsafe` — anything else (a link, a file, a root that resolves elsewhere).
 */
function ownerRootState(ownerId: string): 'ok' | 'missing' | 'unsafe' {
  if (!ownerId || !isSafePathSegment(ownerId)) return 'unsafe';
  const root = path.join('/tmp', ownerId);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(root);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unsafe';
  }
  if (!st.isDirectory()) return 'unsafe'; // lstat: a link is not a directory
  try {
    return fs.realpathSync(root) === path.join(fs.realpathSync('/tmp'), ownerId) ? 'ok' : 'unsafe';
  } catch {
    return 'unsafe';
  }
}

/** Remove a fresh folder made for a task that was then not made — only while it is still empty. */
function removeUnusedFolder(dir: string | undefined): void {
  if (!dir) return;
  try {
    fs.rmdirSync(dir);
  } catch {
    // not empty, or gone: leave it
  }
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
