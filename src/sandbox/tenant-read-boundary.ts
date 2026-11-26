/**
 * What a non-admin session may read: its own work area and the code it runs — nothing else of the host.
 *
 * Reads used to be open everywhere except a list of known secrets, so anything the list missed was
 * readable: the service's data (account pool, per-user keys, other users' memory and transcripts), its
 * env and config files, the service user's home (other programs' logins), other users' folders and the
 * shared temp directory. Every session runs as the service's OS user, so file modes do not help.
 *
 * Now reads are closed by default and opened for a short list:
 *
 * - File tools (Read, Grep, Glob, LSP): the CLI's `permissions.blockReadsOutsideWorkingDirectories`
 *   refuses every read outside the working directories (the session folder and `/tmp/{userId}`), in
 *   every permission mode — no allow rule or hook lifts it. `blockReadsExemptPaths` lets through the
 *   plugins and skills the model reads, the speaker's own data directory (memory, own skills,
 *   uploads) and any root the session may write. The CLI's own files for the session (large tool
 *   results) stay readable without an entry.
 * - Sandboxed shell: `sandbox.filesystem.denyRead` closes the places a host keeps data (homes, `/opt`,
 *   the shared temp directories, mounted volumes, the deployment, its data and the CLI's config
 *   directory) and `allowRead`, which wins over `denyRead`, re-opens the session's own roots and the
 *   code a command runs (Homebrew, toolchains in the home directory, the deployment's code, the
 *   plugins). The CLI's temp directory moves into `/tmp/{userId}` (`CLAUDE_CODE_TMPDIR`), so it is
 *   neither shared with other users nor closed.
 *
 * Nothing here re-opens a path an earlier rule denies on purpose (the secret store, logins,
 * environment plugins without a grant): an `allowRead` entry equal to, inside or above one is dropped.
 *
 * The sandbox compares real paths: a denied symbolic link closes every spelling that passes through it
 * (`/tmp` → `/private/tmp`), so the shell lists are written as the OS resolves them. The file tools take
 * each exemption as written, so it is listed in every spelling. Measured on macOS (Seatbelt).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Where a host keeps data, by platform. Real paths; missing ones are skipped. */
const DATA_ROOTS: Readonly<Record<string, readonly string[]>> = {
  darwin: ['/Users', '/Volumes', '/opt', '/private/tmp', '/private/var/folders'],
  linux: ['/home', '/root', '/opt', '/tmp', '/var/tmp', '/mnt', '/media', '/srv'],
};

/** Code a shell runs from inside a data root. */
const CODE_ROOTS: readonly string[] = ['/opt/homebrew', '/home/linuxbrew/.linuxbrew'];

/**
 * Toolchains under the home directory: binaries and their runtimes, no logins and no caches. git
 * cannot start without its global config, so `.gitconfig` is on the list.
 */
export const HOME_TOOLCHAINS: readonly string[] = [
  '.gitconfig',
  '.local/bin',
  '.cargo/bin',
  '.rustup',
  '.bun/bin',
  '.deno/bin',
  '.nvm',
  '.pyenv',
  '.rbenv',
  '.volta',
  '.dotnet',
  '.sdkman/candidates',
  'go/bin',
];

/** The deployment's code, which skill scripts run and require. Everything else in it stays closed. */
export const INSTALL_CODE: readonly string[] = ['dist', 'node_modules', 'packages', 'somalib'];

/**
 * Where files for a user are saved — Slack uploads (file-handler) and thread files the model downloads (slack-mcp):
 * `{dataDir}/{userId}/uploads`, the user's own part of the data directory, which that user's sessions may read and
 * no session may write. Undefined without a usable user id.
 */
export function userUploadsDir(dataDir: string, userId: string | undefined): string | undefined {
  if (!userId || userId.includes('/') || userId.includes('\\') || userId.includes('..')) return undefined;
  return path.join(dataDir, userId, 'uploads');
}

/** The CLI's temp directory inside the user's root: private, and readable by that user's shell only. */
export const CLAUDE_TMP_DIR_NAME = '.claude-tmp';

export interface TenantReadBoundaryInput {
  platform: NodeJS.Platform;
  /** The service user's home directory. */
  home: string;
  /** The temp directory of the bot process (`os.tmpdir()`). */
  tmpdir: string;
  /** Every root the session's shell may write — its working directory, `/tmp/{userId}`, grant roots. Each is readable. */
  writeRoots: readonly string[];
  /** The session's working directory; in a shared thread it lies in the owner's root. */
  workingDirectory?: string;
  /** The directory of `config.json`. Its code is readable; its configuration, data and secrets are not. */
  installDir: string;
  dataDir: string;
  /** The speaker's own directory in the data directory: memory, own skills, uploads. */
  ownDataDir?: string;
  /** The CLI's config directory (`CLAUDE_CONFIG_DIR`, else `~/.claude`): every session's transcripts. */
  claudeConfigDir: string;
  /** `GH_CONFIG_DIR` of the turn: gh in the session's shell reads its login there. Shell only. */
  ghConfigDir?: string;
  /** The plugin roots the CLI loads (`options.plugins`). */
  pluginPaths: readonly string[];
  /** Environment-skill directories the speaker holds a grant for. File tools only. */
  grantedSkillDirs: readonly string[];
  /** Read denies already set on purpose (secret store, logins, environment plugins). Never re-opened. */
  denied: readonly string[];
  /** Test seam. */
  fileSystem?: { exists(p: string): boolean; realpath(p: string): string };
}

export interface TenantReadBoundary {
  /** Appended to `sandbox.filesystem.denyRead`. */
  denyRead: string[];
  /** `sandbox.filesystem.allowRead`. */
  allowRead: string[];
  /** `settings.permissions.blockReadsExemptPaths`. */
  exemptPaths: string[];
}

const realFileSystem = {
  exists: (p: string) => fs.existsSync(p),
  realpath: (p: string) => fs.realpathSync(p),
};

/** `child` is `parent` or lies below it. */
function within(child: string, parent: string): boolean {
  return child === parent || parent === path.sep || child.startsWith(`${parent}${path.sep}`);
}

export function tenantReadBoundary(input: TenantReadBoundaryInput): TenantReadBoundary {
  const fsx = input.fileSystem ?? realFileSystem;
  const real = (p: string): string => {
    try {
      return fsx.realpath(p);
    } catch {
      return path.resolve(p);
    }
  };
  const spellings = (p: string): string[] => {
    const out = new Set([path.resolve(p), real(p)]);
    // The file tools compare paths as written: `/tmp/x` and `/private/tmp/x` are two spellings on macOS.
    for (const s of [...out]) {
      if (s === '/private/tmp' || s.startsWith('/private/tmp/')) out.add(s.slice('/private'.length));
      else if (input.platform === 'darwin' && (s === '/tmp' || s.startsWith('/tmp/'))) out.add(`/private${s}`);
    }
    return [...out];
  };
  const present = (p: string | undefined): p is string => typeof p === 'string' && p.length > 0 && fsx.exists(p);
  const unique = (list: string[]) => [...new Set(list)];

  const denied = unique(input.denied.flatMap(spellings));
  const reopens = (p: string) => denied.some((d) => within(d, p) || within(p, d));

  const dataRoots = DATA_ROOTS[input.platform] ?? DATA_ROOTS.linux;
  const denyRead = unique(
    [...dataRoots, input.home, input.tmpdir, input.installDir, input.dataDir, input.claudeConfigDir]
      .filter(present)
      .map(real),
  );

  const resources = [
    path.join(input.installDir, 'dist'),
    ...input.pluginPaths,
    ...(input.ownDataDir ? [input.ownDataDir] : []),
  ];
  const ownArea = [...input.writeRoots, ...(input.workingDirectory ? [input.workingDirectory] : [])];
  const allowRead = unique(
    [
      ...ownArea,
      ...resources,
      ...INSTALL_CODE.map((name) => path.join(input.installDir, name)),
      ...CODE_ROOTS,
      ...HOME_TOOLCHAINS.map((name) => path.join(input.home, name)),
      path.join(input.claudeConfigDir, 'shell-snapshots'),
      ...(input.ghConfigDir ? [input.ghConfigDir] : []),
    ]
      .filter(present)
      .map(real)
      .filter((p) => !reopens(p)),
  );

  const exemptPaths = unique([
    ...[...resources, ...input.writeRoots]
      .filter(present)
      .flatMap(spellings)
      .filter((p) => !reopens(p)),
    // Already checked against the speaker's grants; the policy's environment-skill step still runs.
    ...input.grantedSkillDirs.filter(present).flatMap(spellings),
  ]).filter((p) => path.isAbsolute(p) && p !== path.parse(p).root);

  return { denyRead, allowRead, exemptPaths };
}

/**
 * The CLI's temp directory for a non-admin session: `/tmp/{userId}/.claude-tmp`, a private directory
 * of the bot's user. The session's shell may write the user's root, so whatever stands there is
 * checked first: anything but a real directory (a link, a file) is moved aside, and the mode is set to
 * 0700. Returns undefined when the user's root is not there yet, or the directory cannot be made — the
 * CLI then keeps its default.
 */
export function ensureClaudeTmpDir(userRoot: string, now: () => number = Date.now): string | undefined {
  const dir = path.join(userRoot, CLAUDE_TMP_DIR_NAME);
  try {
    if (!fs.statSync(userRoot).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  try {
    let stat: fs.Stats | undefined;
    try {
      stat = fs.lstatSync(dir);
    } catch {
      stat = undefined;
    }
    if (stat && !stat.isDirectory()) {
      fs.renameSync(dir, `${dir}.moved-${now()}`);
      stat = undefined;
    }
    if (!stat) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    return dir;
  } catch {
    return undefined;
  }
}
