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
 * roots sandboxed Bash has.
 *
 * "Those tools" are every native tool of SDK 0.3.284 that writes a local path
 * the call chooses (`sdk-tools.d.ts`): `Write` / `Edit` (`file_path`),
 * `NotebookEdit` (`notebook_path`), `Artifact` `read_asset` (`out_dir`), and the
 * git worktree that `EnterWorktree` (`name`) and `Agent` (`isolation:
 * "worktree"`) create under the repository's `.claude/worktrees/` — a symbolic
 * link there would put the checkout anywhere. `Monitor` runs its command in the
 * same SDK sandbox as Bash. Other tools write nothing local, or only the SDK's
 * own state. `evaluateToolPolicy` applies it to non-admins
 * (`ToolPolicyContext.checkNativeWrite`); a session whose sandbox an admin
 * turned off has no boundary, as its Bash has none either.
 *
 * The decision is made on the file system, not on the spelling: the target's
 * deepest existing ancestor is resolved with `realpath` (every symbolic link
 * followed), the missing rest appended, and the result must sit inside a root.
 * A root is trusted only as far as the session cannot change it: the part of
 * its path at or below a root — the root itself, a working directory inside
 * `/tmp/{userId}` — must hold no symbolic link (the session's own Bash can
 * replace a directory there with one), while the system's links above the
 * roots (`/tmp` → `/private/tmp`) are followed. `realpath` also settles case
 * and Unicode-form spellings the way the file system does. Refused as well, since a write would
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

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The native tools that can write a local path the call chooses (`writeTargets`).
 * The policy asks the boundary about these tools only, and its hook matchers
 * include every one of them (`TOOL_POLICY_MATCHERS`).
 */
export const NATIVE_WRITE_TOOLS: readonly string[] = [
  'Write',
  'Edit',
  'NotebookEdit',
  'Artifact',
  'EnterWorktree',
  'Agent',
];

/** A deny reason when the write lands outside the roots, `null` when it lands inside (or writes nothing local). */
export type NativeWriteCheck = (toolName: string, input: Record<string, unknown>) => string | null;

type Targets = { ok: true; targets: string[] } | { ok: false; reason: string };
type Resolved = { ok: true; path: string } | { ok: false; reason: string };

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function requiredPath(toolName: string, input: Record<string, unknown>, property: string): Targets {
  const raw = input[property];
  return typeof raw === 'string' && raw !== ''
    ? { ok: true, targets: [raw] }
    : { ok: false, reason: `${toolName} names no target (${property})` };
}

/**
 * Where the SDK puts a new git worktree: `<repository root>/.claude/worktrees/<name>`,
 * the repository being the one `cwd` is in. Outside a repository the SDK
 * cannot create one, so nothing is written.
 */
function worktreeTargets(toolName: string, cwd: string, name: unknown): Targets {
  if (name !== undefined && (typeof name !== 'string' || name === '')) {
    return { ok: false, reason: `${toolName} names no usable worktree (name)` };
  }
  const git = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', timeout: 5000 });
  if (git.error)
    return { ok: false, reason: `${toolName}: cannot tell where the worktree goes (${git.error.message})` };
  const root = git.status === 0 ? git.stdout.trim() : '';
  if (!root) return { ok: true, targets: [] };
  return { ok: true, targets: [`${root}/.claude/worktrees/${name ?? 'new-worktree'}`] };
}

/** The local paths a call writes, as the call names them (relative ones against `cwd`). */
function writeTargets(toolName: string, input: Record<string, unknown>, cwd: string): Targets {
  switch (toolName) {
    case 'Write':
    case 'Edit':
      return requiredPath(toolName, input, 'file_path');
    case 'NotebookEdit':
      return requiredPath(toolName, input, 'notebook_path');
    case 'Artifact': {
      // Only `read_asset` saves locally; without `out_dir` it saves into the SDK's own scratchpad.
      if (input.action !== 'read_asset' || input.out_dir === undefined) return { ok: true, targets: [] };
      const dir = requiredPath(toolName, input, 'out_dir');
      return dir.ok ? { ok: true, targets: [`${dir.targets[0]}/asset`] } : dir;
    }
    case 'EnterWorktree':
      // `path` switches into an existing worktree: nothing is created.
      return input.path !== undefined && input.name === undefined
        ? { ok: true, targets: [] }
        : worktreeTargets(toolName, cwd, input.name);
    case 'Agent':
      return input.isolation === 'worktree' ? worktreeTargets(toolName, cwd, undefined) : { ok: true, targets: [] };
    default:
      return { ok: true, targets: [] };
  }
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

/** The ancestors of `p` (absolute, normalized), nearest first, `/` last. */
function ancestors(p: string): string[] {
  const out: string[] = [];
  for (let cur = path.dirname(p); ; cur = path.dirname(cur)) {
    out.push(cur);
    if (cur === path.dirname(cur)) return out;
  }
}

/**
 * Where `root` really is, trusting only what the session cannot change: every
 * component of the root's path that lies at or below one of `roots` (spelled as
 * given) must not be a symbolic link — those directories are writable by the
 * session, so a link there could point the root anywhere. The components above
 * are followed through `realpath`.
 */
function resolveRoot(root: string, roots: readonly string[]): Resolved {
  const lexicalRoots = roots.map((r) => path.resolve(r));
  const writable = (p: string) => lexicalRoots.some((r) => p === r || p.startsWith(`${r}${path.sep}`));
  const self = path.resolve(root);
  for (const component of [self, ...ancestors(self)]) {
    if (!writable(component)) continue;
    try {
      if (fs.lstatSync(component).isSymbolicLink()) {
        return { ok: false, reason: `${component} is a symbolic link` };
      }
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') return { ok: false, reason: `cannot inspect ${component}` };
    }
  }
  return resolveWriteTarget(self);
}

function isInside(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/** Why a write to `raw` would land outside `roots`, or null. */
function checkTarget(
  toolName: string,
  raw: string,
  roots: readonly string[],
  cwd: string,
  shown: string,
): string | null {
  const joined = path.isAbsolute(raw) ? raw : `${cwd}/${raw}`;
  // The OS climbs `..` from a symbolic link's target, `path.resolve` from the
  // link's own name: the two can land in different directories.
  if (joined.split('/').includes('..')) return `${toolName} to ${raw}: a path with \`..\` is not allowed`;
  const target = resolveWriteTarget(path.resolve(joined));
  if (!target.ok) return `${toolName} to ${raw}: ${target.reason}`;
  const insideRoot = roots.some((root) => {
    const resolvedRoot = resolveRoot(root, roots);
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
}

/**
 * The boundary for one call: every local path it writes must land inside one
 * of `roots`. `cwd` is the session's current directory, which the SDK resolves
 * a relative target against and finds the repository of a new worktree from.
 * Roots are resolved on every call, so a root created after the session
 * started (the working directory, recreated) counts once it exists.
 */
export function createNativeWriteCheck(roots: readonly string[], cwd: string): NativeWriteCheck {
  const shown = roots.length ? roots.join(', ') : '(none)';
  return (toolName, input) => {
    const targets = writeTargets(toolName, input, cwd);
    if (!targets.ok) return targets.reason;
    for (const raw of targets.targets) {
      const outside = checkTarget(toolName, raw, roots, cwd, shown);
      if (outside !== null) return outside;
    }
    return null;
  };
}
