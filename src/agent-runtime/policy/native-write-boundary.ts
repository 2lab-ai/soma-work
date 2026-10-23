/**
 * Native write boundary — where a session's native file tools may write.
 *
 * The SDK sandbox confines Bash: a sandboxed command writes only the session's
 * working directory and the `allowWrite` roots (`/tmp/{userId}`,
 * `build-stream-options.ts`). The native file tools — `Write`, `Edit`,
 * `NotebookEdit` — run in the SDK process itself, outside that sandbox, so
 * without this check a non-admin session could write any file the bot can:
 * the data directory (every user's memory and settings, the shared project
 * memory), `.env`, the installed code. This module gives those tools the same
 * roots sandboxed Bash has. `evaluateToolPolicy` applies it to non-admins
 * (`ToolPolicyContext.checkNativeWrite`); a session whose sandbox an admin
 * turned off has no boundary, as its Bash has none either.
 *
 * The decision is made on the file system, not on the spelling: the target's
 * deepest existing ancestor is resolved with `realpath` (every symbolic link
 * followed), the missing rest appended, and the result must sit inside a root
 * resolved the same way. A spelling the file system does not resolve the same
 * way (case, Unicode form) fails closed. Refused as well, since a write would
 * land outside a root through them: a `..` segment (the OS climbs it from a
 * symbolic link's target), a dangling symbolic link on the way (a write
 * creates its target), and an existing file with more than one hard link (a
 * write changes every name of it).
 *
 * Residual: the check runs before the SDK writes. A symbolic link swapped into
 * the path between the two — by a concurrent command the session runs inside
 * its own root — is not seen. Closing that needs the write itself confined
 * (the SDK process sandboxed, or a separate OS user), not a check before it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** The native tools that write a file, and the property each names its target with (`sdk-tools.d.ts`). */
export const NATIVE_WRITE_TOOLS: readonly string[] = ['Write', 'Edit', 'NotebookEdit'];

const TARGET_PROPERTY: Readonly<Record<string, string>> = {
  Write: 'file_path',
  Edit: 'file_path',
  NotebookEdit: 'notebook_path',
};

/** A deny reason when the write lands outside the roots, `null` when it lands inside. */
export type NativeWriteCheck = (toolName: string, input: Record<string, unknown>) => string | null;

type Resolved = { ok: true; path: string } | { ok: false; reason: string };

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Where a write to `target` (absolute, lexically normalized) lands: the deepest
 * existing ancestor through `realpath`, then the missing names as written.
 */
function resolveWriteTarget(target: string): Resolved {
  const missing: string[] = [];
  let current = target;
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return { ok: true, path: missing.length ? path.join(real, ...missing.reverse()) : real };
    } catch (error) {
      const code = errorCode(error);
      if (code !== 'ENOENT') {
        // ELOOP, EACCES, ENOTDIR, …: where the write would land is unknown.
        return { ok: false, reason: `cannot resolve ${current} (${code ?? 'error'})` };
      }
    }
    // `current` does not resolve. A name that exists but does not resolve is a
    // dangling symbolic link: a write through it creates the link's target.
    try {
      fs.lstatSync(current);
      return { ok: false, reason: `${current} is a symbolic link to a missing target` };
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        return { ok: false, reason: `cannot inspect ${current} (${errorCode(error) ?? 'error'})` };
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return { ok: false, reason: `nothing of ${target} exists` };
    missing.push(path.basename(current));
    current = parent;
  }
}

function isInside(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/**
 * The boundary for one session: writes must land inside one of `roots`.
 * `cwd` is the directory the SDK resolves a relative target against.
 * Roots are resolved on every call, so a root created after the session
 * started (the working directory, recreated) counts once it exists.
 */
export function createNativeWriteCheck(roots: readonly string[], cwd: string): NativeWriteCheck {
  const shown = roots.length ? roots.join(', ') : '(none)';
  return (toolName, input) => {
    const property = TARGET_PROPERTY[toolName];
    if (!property) return null;
    const raw = input[property];
    if (typeof raw !== 'string' || raw === '') {
      return `${toolName} names no target (${property})`;
    }
    const joined = path.isAbsolute(raw) ? raw : `${cwd}/${raw}`;
    // The OS climbs `..` from a symbolic link's target, `path.resolve` from the
    // link's own name: the two can land in different directories.
    if (joined.split('/').includes('..')) return `${toolName} to ${raw}: a path with \`..\` is not allowed`;
    const target = resolveWriteTarget(path.resolve(joined));
    if (!target.ok) return `${toolName} to ${raw}: ${target.reason}`;
    const insideRoot = roots.some((root) => {
      const resolvedRoot = resolveWriteTarget(path.resolve(root));
      return resolvedRoot.ok && isInside(target.path, resolvedRoot.path);
    });
    if (!insideRoot) {
      return `${toolName} to ${raw} lands outside the session's writable directories (${shown})`;
    }
    try {
      const stat = fs.statSync(target.path);
      if (stat.isFile() && stat.nlink > 1) {
        return `${toolName} to ${raw}: the file has ${stat.nlink} hard links, so writing it changes a file elsewhere`;
      }
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        return `${toolName} to ${raw}: cannot inspect the target (${errorCode(error) ?? 'error'})`;
      }
    }
    return null;
  };
}
