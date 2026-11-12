/**
 * Files the Claude Code CLI loads when a session starts (env-access, #1242).
 *
 * Sessions run with `settingSources: ['project']`. At every start the CLI reads the project settings in the
 * session directory, and the project MCP config in that directory and the directories above it. Both can name
 * commands, and the CLI runs them itself, outside the sandbox. The session directory and the user's temp
 * directory are sandbox write roots, so a model must neither leave such a file there nor reach one through a
 * link.
 *
 * Two layers, both here:
 * - before every start, `guardSessionStartFiles` moves any such file into a quarantine under `DATA_DIR`, which
 *   no model writes. If a file cannot be moved, it throws and the session does not start (fail closed).
 * - while the session runs, `sessionStartFileDenyRules` refuses the file tools the same paths (the CLI also
 *   adds them to the sandbox's denyWrite).
 *
 * The host itself never writes these files into a session directory. Settings above the session directory are
 * not touched: that can be the operator's home directory, and the CLI does not load project settings from there.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Project settings the CLI reads from the session directory. */
const SETTINGS_FILES = ['settings.json', 'settings.local.json'] as const;
/** Project MCP config the CLI looks for in the session directory and the directories above it. */
const MCP_FILE = '.mcp.json';

export class SessionStartFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionStartFileError';
  }
}

export interface MovedStartFile {
  from: string;
  to: string;
}

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

function lexists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** The path as written and as the OS resolves it, through its deepest existing ancestor. */
function spellings(p: string): string[] {
  const resolved = path.resolve(p);
  let existing = resolved;
  const rest: string[] = [];
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) {
    rest.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  let real = resolved;
  try {
    real = path.join(fs.realpathSync(existing), ...rest);
  } catch {
    // keep the written spelling only
  }
  return [...new Set([resolved, real])];
}

function isWithin(dir: string, root: string): boolean {
  return dir === root || dir.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/** The session directory and each directory above it that is still inside a write root, in every spelling. */
function mcpDirs(cwd: string, writeRoots: readonly string[]): string[] {
  const roots = writeRoots.flatMap(spellings);
  const dirs: string[] = [];
  for (const start of spellings(cwd)) {
    for (let dir = start; ; dir = path.dirname(dir)) {
      if (!roots.some((root) => isWithin(dir, root))) break;
      dirs.push(dir);
      if (path.dirname(dir) === dir) break;
    }
  }
  return [...new Set(dirs)];
}

/** Every start file path the guard and the deny rules cover, in every spelling. */
function startFilePaths(cwd: string, writeRoots: readonly string[]): { claudeDirs: string[]; files: string[] } {
  const cwds = spellings(cwd);
  const claudeDirs = cwds.map((c) => path.join(c, '.claude'));
  const settings = claudeDirs.flatMap((d) => SETTINGS_FILES.map((f) => path.join(d, f)));
  const mcp = mcpDirs(cwd, writeRoots).map((d) => path.join(d, MCP_FILE));
  return { claudeDirs, files: [...settings, ...mcp] };
}

/** `Edit` deny rules for the start files: Write, Edit and NotebookEdit are refused, and the sandbox's denyWrite. */
export function sessionStartFileDenyRules(input: { cwd: string; writeRoots: readonly string[] }): string[] {
  const { files } = startFilePaths(input.cwd, input.writeRoots);
  return [...new Set(files.map((f) => `Edit(/${f})`))];
}

/** The same entry seen through two spellings is moved once. */
function identity(p: string): string {
  try {
    return path.join(fs.realpathSync(path.dirname(p)), path.basename(p));
  } catch {
    return p;
  }
}

function moveAside(from: string, runDir: string): string {
  const to = path.join(runDir, from);
  try {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    try {
      fs.renameSync(from, to);
    } catch (err) {
      if (errCode(err) !== 'EXDEV') throw err;
      const stat = fs.lstatSync(from);
      if (stat.isSymbolicLink()) {
        fs.writeFileSync(`${to}.symlink`, fs.readlinkSync(from));
        fs.unlinkSync(from);
        return `${to}.symlink`;
      }
      if (stat.isDirectory()) {
        fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
        fs.rmSync(from, { recursive: true, force: true });
      } else {
        fs.copyFileSync(from, to);
        fs.unlinkSync(from);
      }
    }
  } catch (err) {
    throw new SessionStartFileError(
      `could not move ${from} out of the session (${errCode(err) ?? 'error'}); the session was not started`,
    );
  }
  if (lexists(from)) {
    throw new SessionStartFileError(`${from} is still in place after the move; the session was not started`);
  }
  return to;
}

/**
 * Move every start file out of the session before the CLI starts. Returns what was moved (empty when nothing
 * was there). Throws `SessionStartFileError` when a file cannot be moved: the caller must not start the CLI.
 */
export function guardSessionStartFiles(input: {
  cwd: string;
  /** The directories a model session may write: the session directory, the user's temp directory, … */
  writeRoots: readonly string[];
  /** Where moved files go; must be outside every write root (a directory under DATA_DIR). */
  quarantineDir: string;
  now?: () => Date;
}): MovedStartFile[] {
  const { claudeDirs, files } = startFilePaths(input.cwd, input.writeRoots);
  const targets: string[] = [];
  const seen = new Set<string>();
  const add = (p: string) => {
    const id = identity(p);
    if (seen.has(id)) return;
    seen.add(id);
    targets.push(p);
  };
  // A linked .claude is moved itself; what it points at is not touched, and nothing is read through it.
  const linkedClaude = claudeDirs.filter((d) => {
    try {
      return fs.lstatSync(d).isSymbolicLink();
    } catch {
      return false;
    }
  });
  for (const d of linkedClaude) add(d);
  for (const f of files) {
    if (linkedClaude.some((d) => f.startsWith(d + path.sep))) continue;
    if (lexists(f)) add(f);
  }
  if (targets.length === 0) return [];

  const stamp = (input.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '-');
  const runDir = path.join(input.quarantineDir, `${stamp}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  return targets.map((from) => ({ from, to: moveAside(from, runDir) }));
}
