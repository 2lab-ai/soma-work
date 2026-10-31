/**
 * E4 ④b — where a child of an epic works (.prd/19 D4).
 *
 * The host decides, never the child: a fresh `session_*` folder when none is
 * named, or a sub-path of the epic's own folder — resolved through its real
 * location, so `..` or a symlink cannot lead out of the epic's folder (and
 * the owner's `/tmp/<owner>/` root, which `taskDirectoryFor` holds).
 *
 * Two children running at once never share a folder: the same folder, or
 * one holding the other by path segment (`session_1` and `session_10` do
 * not overlap), is refused (`foldersOverlap`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { taskDirectoryFor } from '../agent-runtime/execution-context';

export type ChildFolderErrorCode = 'bad-folder' | 'outside-epic' | 'folder-overlap';

export class ChildFolderError extends Error {
  constructor(
    readonly code: ChildFolderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ChildFolderError';
  }
}

/**
 * A child's folder named relative to its epic's: the real location of
 * `<epic folder>/<folder>`, strictly inside the epic's real folder. A part
 * not created yet is allowed (the caller creates it).
 */
export function resolveChildFolder(ownerId: string, epicDir: string, folder: string): string {
  // An absolute path starts with an empty part, so the part rule refuses it too.
  const parts = folder.split(/[\\/]/);
  if (parts.some((p) => p === '' || p === '.' || p === '..')) {
    throw new ChildFolderError(
      'bad-folder',
      'folder must be a relative path inside the epic’s folder, without . or ..',
    );
  }
  let epicReal: string;
  let real: string;
  try {
    epicReal = taskDirectoryFor(ownerId, epicDir);
    real = taskDirectoryFor(ownerId, path.join(epicDir, folder));
  } catch (error) {
    throw new ChildFolderError('outside-epic', `the folder cannot be used: ${(error as Error).message}`);
  }
  if (!real.startsWith(`${epicReal}/`)) {
    throw new ChildFolderError('outside-epic', 'the folder resolves outside the epic’s folder');
  }
  return real;
}

/** Make a resolved child folder (and its parents) if it is not there yet. */
export function ensureChildFolder(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** The same folder, or one holding the other — compared by whole path segments. */
export function foldersOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}
