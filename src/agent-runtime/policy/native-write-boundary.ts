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
 * `NotebookEdit` (`notebook_path`), `Artifact` (`out_dir`: refused outright, as
 * the names saved under it come from the server and a check before the call
 * cannot see them; without it the SDK saves into its own scratchpad), and the
 * git worktree that `EnterWorktree` (`name`) and `Agent` (`isolation:
 * "worktree"`) create under the repository's `.claude/worktrees/` — a symbolic
 * link there would put the checkout anywhere. Also held to the roots: the
 * directory a session's working directory moves to — `EnterWorktree` `path`
 * and an `Agent` `cwd` — because the SDK sandbox lets Bash write the current
 * working directory, so a switch outside the roots would widen what Bash may
 * write. `Monitor` runs its command in the same SDK sandbox as Bash. Other
 * tools write nothing local, or only the SDK's own state. `evaluateToolPolicy` applies it to non-admins
 * (`ToolPolicyContext.checkNativeWrite`); a session whose sandbox an admin
 * turned off has no boundary, as its Bash has none either.
 *
 * A path is read the way the SDK reads it (`expandPath`: white space around it
 * trimmed, `~` and `~/` expanded, then against the working directory), and
 * also as written and in Unicode NFC: every reading must land inside a root.
 *
 * The decision is made on the file system, not on the spelling: the target's
 * deepest existing ancestor is resolved with `realpath` (every symbolic link
 * followed), the missing rest appended, and the result must sit inside a root.
 * A root is trusted only as far as the session cannot change it. Each root is
 * walked from `/` one name at a time, every name replaced by the file system's
 * own spelling, so `/tmp/…` and `/private/tmp/…`, or two spellings of case,
 * come out as one path. A symbolic link on the way is followed only when it
 * lies outside every root (the system's `/tmp` → `/private/tmp`); one at or
 * inside a root — a root's own name, or a directory between `/tmp/{userId}` and
 * a working directory inside it — is one the session's own Bash can put there
 * (the sandbox lets it write a root's own name as well), so the roots cannot be
 * trusted and every write is refused until they are restored. The roots are
 * compared with each other in that one spelling, walked again until they
 * agree. Refused as well, since a write would
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
import * as os from 'node:os';
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
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, reason: `${toolName} names no target (${property})` };
  }
  if (raw.includes('\0')) return { ok: false, reason: `${toolName}: ${property} contains a NUL character` };
  return { ok: true, targets: [raw] };
}

/**
 * Every absolute path a write to `raw` may go to. The SDK reads a path with
 * `expandPath` — trimmed, `~` / `~/` to the home directory, a relative one
 * against the working directory — and may compose it to Unicode NFC; the
 * spelling as written is kept as well. A write is allowed only when all land
 * inside a root, so no reading the SDK might use is left unchecked.
 */
function readings(raw: string, cwd: string): string[] {
  const against = (p: string) => (path.isAbsolute(p) ? p : `${cwd}/${p}`);
  const trimmed = raw.trim();
  const expanded =
    trimmed === '~'
      ? os.homedir()
      : trimmed.startsWith('~/')
        ? path.join(os.homedir(), trimmed.slice(2))
        : against(trimmed);
  const out = new Set<string>();
  for (const p of [against(raw), expanded]) {
    out.add(p);
    out.add(p.normalize('NFC'));
  }
  return [...out];
}

/**
 * Where the SDK puts a new git worktree: `<repository root>/.claude/worktrees/<name>`,
 * the repository being the one `cwd` is in. From a linked worktree that can be
 * the main repository (the one `--git-common-dir` belongs to), so both count.
 * Outside a repository the SDK cannot create one, so nothing is written; when
 * git cannot say, the write is refused.
 */
function worktreeTargets(toolName: string, cwd: string, name: unknown): Targets {
  if (name !== undefined && (typeof name !== 'string' || name === '')) {
    return { ok: false, reason: `${toolName} names no usable worktree (name)` };
  }
  const git = spawnSync('git', ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'], {
    cwd,
    encoding: 'utf8',
    timeout: 5000,
    env: { ...process.env, LC_ALL: 'C' },
  });
  if (git.error)
    return { ok: false, reason: `${toolName}: cannot tell where the worktree goes (${git.error.message})` };
  if (git.status !== 0) {
    return /not a git repository/i.test(git.stderr)
      ? { ok: true, targets: [] }
      : {
          ok: false,
          reason: `${toolName}: cannot tell where the worktree goes (${git.stderr.trim() || `git exit ${git.status}`})`,
        };
  }
  const [top, common] = git.stdout.trim().split('\n');
  const repositories = new Set<string>();
  if (top) repositories.add(top);
  if (common) repositories.add(path.basename(common) === '.git' ? path.dirname(common) : common);
  if (repositories.size === 0) return { ok: false, reason: `${toolName}: cannot tell where the worktree goes` };
  return { ok: true, targets: [...repositories].map((r) => `${r}/.claude/worktrees/${name ?? 'new-worktree'}`) };
}

/** The local paths a call writes, as the call names them (relative ones against `cwd`). */
function writeTargets(toolName: string, input: Record<string, unknown>, cwd: string): Targets {
  switch (toolName) {
    case 'Write':
    case 'Edit':
      return requiredPath(toolName, input, 'file_path');
    case 'NotebookEdit':
      return requiredPath(toolName, input, 'notebook_path');
    case 'Artifact':
      // `read_asset`, `read_file` and `read_db` save under `out_dir` names the server
      // picks (asset id + extension, published path, collection / document id): a
      // check before the call cannot see them, so `out_dir` is refused for every
      // action. Without it the SDK saves into its own scratchpad.
      return input.out_dir === undefined
        ? { ok: true, targets: [] }
        : {
            ok: false,
            reason:
              'Artifact cannot save to out_dir in this session: omit out_dir, the file is saved in the scratchpad, where Read can open it',
          };
    case 'EnterWorktree':
      // `path` switches into an existing worktree: nothing is created, but the session's
      // working directory moves there, and sandboxed Bash writes its working directory.
      return input.path !== undefined && input.name === undefined
        ? requiredPath(toolName, input, 'path')
        : worktreeTargets(toolName, cwd, input.name);
    case 'Agent': {
      // `cwd` (in the CLI's schema; the public 0.3.284 one omits it) is the subagent's
      // working directory, which its sandboxed Bash writes, as above.
      const targets: string[] = [];
      for (const part of [
        input.cwd === undefined ? null : requiredPath(toolName, input, 'cwd'),
        input.isolation === 'worktree' ? worktreeTargets(toolName, cwd, undefined) : null,
      ]) {
        if (part === null) continue;
        if (!part.ok) return part;
        targets.push(...part.targets);
      }
      return { ok: true, targets };
    }
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

function isInside(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/** Symbolic links followed in one walk before giving up, as the OS does (ELOOP). */
const MAX_LINKS = 40;

/**
 * Where `root` really is, trusting only what the session cannot change. The
 * path is walked from `/` one name at a time, the way the OS resolves it, each
 * existing name replaced by the file system's own spelling (`realpath` of a
 * path with no symbolic link left in it changes only case and Unicode form). A
 * symbolic link is followed only when it lies outside every root in `known`
 * (their canonical forms); one at or inside a root — the session's own Bash
 * could have put it there — refuses the root. So does a root that is itself a
 * symbolic link. A missing rest is appended as named.
 */
function canonicalRoot(root: string, known: readonly string[]): Resolved {
  const self = path.resolve(root);
  try {
    if (fs.lstatSync(self).isSymbolicLink()) return { ok: false, reason: `${self} is a symbolic link` };
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') return { ok: false, reason: `cannot inspect ${self}` };
  }
  const pending = self.split(path.sep).filter(Boolean);
  let current: string = path.sep;
  let links = 0;
  while (pending.length > 0) {
    const name = pending.shift() as string;
    if (name === '.') continue;
    if (name === '..') {
      current = path.dirname(current);
      continue;
    }
    const next = path.join(current, name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(next);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return { ok: true, path: path.join(next, ...pending) };
      return { ok: false, reason: `cannot inspect ${next} (${errorCode(error) ?? 'error'})` };
    }
    if (stat.isSymbolicLink()) {
      if (known.some((r) => isInside(next, r))) {
        return { ok: false, reason: `${next} is a symbolic link at or inside a writable directory` };
      }
      if (++links > MAX_LINKS) return { ok: false, reason: `too many symbolic links in ${self}` };
      let target: string;
      try {
        target = fs.readlinkSync(next);
      } catch (error) {
        return { ok: false, reason: `cannot read ${next} (${errorCode(error) ?? 'error'})` };
      }
      pending.unshift(...target.split(path.sep).filter(Boolean));
      if (path.isAbsolute(target)) current = path.sep;
      continue;
    }
    try {
      current = fs.realpathSync.native(next);
    } catch (error) {
      return { ok: false, reason: `cannot resolve ${next} (${errorCode(error) ?? 'error'})` };
    }
  }
  return { ok: true, path: current };
}

type Roots = { ok: true; paths: string[] } | { ok: false; reason: string };

/**
 * The roots in one spelling. Whether a link lies inside a root is asked of the
 * roots' canonical forms, which this computes: so each round walks every root
 * against the previous round's forms, until a round changes nothing. A root
 * that cannot be trusted makes none of them trusted: where it really is, and so
 * which links inside it the session made, is no longer known.
 */
function canonicalRoots(roots: readonly string[]): Roots {
  let known: string[] = [];
  for (let round = 0; round <= roots.length + 1; round++) {
    const paths: string[] = [];
    for (const root of roots) {
      const resolved = canonicalRoot(root, known);
      if (!resolved.ok) return resolved;
      paths.push(resolved.path);
    }
    if (round > 0 && paths.every((p, i) => p === known[i])) return { ok: true, paths };
    known = paths;
  }
  return { ok: false, reason: 'they do not settle on one place' };
}

/** Why a write to `raw` would land outside the roots, or null. */
function checkTarget(
  toolName: string,
  raw: string,
  roots: readonly string[],
  cwd: string,
  shown: string,
): string | null {
  for (const joined of readings(raw, cwd)) {
    const outside = checkReading(toolName, raw, joined, roots, shown);
    if (outside !== null) return outside;
  }
  return null;
}

/** Why a write to `joined` (one reading of `raw`, absolute) would land outside the roots, or null. */
function checkReading(
  toolName: string,
  raw: string,
  joined: string,
  roots: readonly string[],
  shown: string,
): string | null {
  // The OS climbs `..` from a symbolic link's target, `path.resolve` from the
  // link's own name: the two can land in different directories.
  if (joined.split('/').includes('..')) return `${toolName} to ${raw}: a path with \`..\` is not allowed`;
  const target = resolveWriteTarget(path.resolve(joined));
  if (!target.ok) return `${toolName} to ${raw}: ${target.reason}`;
  const insideRoot = roots.some((root) => isInside(target.path, root));
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
    if (targets.targets.length === 0) return null;
    const canonical = canonicalRoots(roots);
    if (!canonical.ok) {
      return `${toolName}: the session's writable directories (${shown}) cannot be trusted — ${canonical.reason}; no native write is allowed until they are restored`;
    }
    for (const raw of targets.targets) {
      const outside = checkTarget(toolName, raw, canonical.paths, cwd, shown);
      if (outside !== null) return outside;
    }
    return null;
  };
}
