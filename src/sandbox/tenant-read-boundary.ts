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
 *   code a command runs (Homebrew's runtime, toolchains in the home directory, the deployment's code,
 *   the plugins). The CLI's temp directory moves into `/tmp/{userId}` (`CLAUDE_CODE_TMPDIR`), so it is
 *   neither shared with other users nor closed.
 *
 * Nothing here re-opens a path an earlier rule denies on purpose (the secret store, logins,
 * environment plugins without a grant): an `allowRead` entry equal to, inside or above one is dropped.
 * A root the session can write is opened only where it really is: one reached through a link (a
 * session folder replaced by a link to another user's folder) is not opened, see `throughLink`.
 *
 * The sandbox compares real paths: a denied symbolic link closes every spelling that passes through it
 * (`/tmp` → `/private/tmp`), so the shell lists are written as the OS resolves them. The file tools take
 * each exemption as written, so it is listed in every spelling. Measured on macOS (Seatbelt).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Where a host keeps data, by platform. Real paths; missing ones are skipped. */
const DATA_ROOTS: Readonly<Record<string, readonly string[]>> = {
  darwin: ['/Users', '/Volumes', '/opt', '/private/tmp', '/private/var/folders', '/private/var/tmp'],
  linux: ['/home', '/root', '/opt', '/tmp', '/var/tmp', '/mnt', '/media', '/srv'],
};

/** macOS links the OS itself keeps at the root: a path through one of them is not a planted link. */
const DARWIN_ROOT_LINKS: Readonly<Record<string, string>> = {
  tmp: '/private/tmp',
  var: '/private/var',
  etc: '/private/etc',
};

/**
 * Code a shell runs from inside a data root, by allow-list: the runtime directories of Homebrew. Its
 * `var` (the data and logs of the services it runs) and the services' config in `etc` stay closed; the
 * tools' own config in `etc` (TLS trust stores, git's and npm's system config …) is open, or they fail.
 * A tool that stops on a closed file there names it in its error: add the file here, not the directory.
 */
const CODE_ROOTS: readonly string[] = ['/opt/homebrew', '/home/linuxbrew/.linuxbrew'];
const CODE_ROOT_RUNTIME: readonly string[] = [
  'bin',
  'sbin',
  'Cellar',
  'Caskroom',
  'Frameworks',
  'opt',
  'lib',
  'libexec',
  'include',
  'share',
  // The tools' own system-wide config in `etc` (git stops without its gitconfig); not the services' config.
  'etc/openssl@1.1',
  'etc/openssl@3',
  'etc/openssl@4',
  'etc/ca-certificates',
  'etc/gitconfig',
  'etc/npmrc',
  'etc/ImageMagick-7',
  'etc/fonts',
  'etc/rustup',
  'etc/clang',
  'etc/wgetrc',
];

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

/**
 * The parent of every non-admin session's CLI temp directory (`CLAUDE_CODE_TMPDIR`): made and kept by the bot,
 * writable by no session, so a session can write inside its own directory but never replace that directory. Short,
 * because the CLI puts sockets in it.
 */
export const CLAUDE_TMP_ROOT = '/tmp/.soma-ct';

export interface TenantReadBoundaryInput {
  platform: NodeJS.Platform;
  /** The service user's home directory. */
  home: string;
  /** The temp directory of the bot process (`os.tmpdir()`). */
  tmpdir: string;
  /** Every root the session's shell may write — its working directory, `/tmp/{userId}`, grant roots. Each is readable. */
  writeRoots: readonly string[];
  /** The directory of `config.json`: its configuration, data and secrets stay closed. */
  installDir: string;
  /** The root of the code the bot runs (the deployment): its code directories are readable, the rest is not. */
  codeRoot: string;
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
  /**
   * Files the session's own tools read and its owner holds — the mailbox client's settings, which `mailbox send` in
   * the owner's session needs. Shell only, and only where they really are.
   */
  ownFiles?: readonly string[];
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
  /** Write roots left out because they are reached through a link. */
  redirected: string[];
}

const realFileSystem = {
  exists: (p: string) => fs.existsSync(p),
  realpath: (p: string) => fs.realpathSync(p),
};

/** `child` is `parent` or lies below it. */
function within(child: string, parent: string): boolean {
  return child === parent || parent === path.sep || child.startsWith(`${parent}${path.sep}`);
}

/**
 * True when `p` exists and the OS resolves it somewhere else than it is written — some part of it is a
 * symbolic link — other than the links macOS keeps at the root (`/tmp`, `/var`, `/etc`). A path that does
 * not exist is not reached through anything yet.
 */
export function throughLink(
  p: string,
  platform: NodeJS.Platform,
  fileSystem: { exists(p: string): boolean; realpath(p: string): string } = realFileSystem,
): boolean {
  const lexical = path.resolve(p);
  if (!fileSystem.exists(lexical)) return false;
  let real: string;
  try {
    real = fileSystem.realpath(lexical);
  } catch {
    return true;
  }
  let expected = lexical;
  if (platform === 'darwin') {
    const first = lexical.split(path.sep)[1] ?? '';
    const target = DARWIN_ROOT_LINKS[first];
    if (target) expected = target + lexical.slice(first.length + 1);
  }
  return real !== expected;
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
    [...dataRoots, input.home, input.tmpdir, input.installDir, input.codeRoot, input.dataDir, input.claudeConfigDir]
      .filter(present)
      .map(real),
  );

  // The session may write its roots, so it may also have replaced one with a link since the last turn.
  const redirected = input.writeRoots.filter((p) => throughLink(p, input.platform, fsx));
  const ownArea = input.writeRoots.filter((p) => !redirected.includes(p));
  const resources = [
    path.join(input.codeRoot, 'dist'),
    ...input.pluginPaths,
    ...(input.ownDataDir ? [input.ownDataDir] : []),
  ];
  const allowRead = unique(
    [
      ...ownArea,
      ...resources,
      ...INSTALL_CODE.map((name) => path.join(input.codeRoot, name)),
      ...CODE_ROOTS.flatMap((root) => CODE_ROOT_RUNTIME.map((name) => path.join(root, name))),
      ...HOME_TOOLCHAINS.map((name) => path.join(input.home, name)),
      path.join(input.claudeConfigDir, 'shell-snapshots'),
      ...(input.ghConfigDir ? [input.ghConfigDir] : []),
      ...(input.ownFiles ?? []).filter((p) => !throughLink(p, input.platform, fsx)),
    ]
      .filter(present)
      .map(real)
      .filter((p) => !reopens(p)),
  );

  const exemptPaths = unique([
    ...[...resources, ...ownArea]
      .filter(present)
      .flatMap(spellings)
      .filter((p) => !reopens(p)),
    // Already checked against the speaker's grants; the policy's environment-skill step still runs. A skill
    // directory that is a link (to anywhere) is not opened.
    ...input.grantedSkillDirs
      .filter(present)
      .filter((p) => !throughLink(p, input.platform, fsx))
      .flatMap(spellings),
  ]).filter((p) => path.isAbsolute(p) && p !== path.parse(p).root);

  return { denyRead, allowRead, exemptPaths, redirected };
}

/**
 * The CLI's temp directory for a non-admin session: `{root}/{userId}` under the bot's own parent
 * (`CLAUDE_TMP_ROOT`). The parent and the directory are each a real directory of the bot's user with mode
 * 0700, checked without following links (`O_NOFOLLOW`, owner and mode through the handle). The session gets
 * write access to its directory only, so it cannot rename or replace it. Returns undefined when no such
 * directory can be had (another OS user holds the parent, a link stands there) — the CLI then keeps its
 * default, whose temp root the session's shell cannot read: the shell fails closed.
 */
export function ensureClaudeTmpDir(userId: string, root: string = CLAUDE_TMP_ROOT): string | undefined {
  if (!userId || userId.includes('/') || userId.includes('\\') || userId.includes('..')) return undefined;
  const dir = path.join(root, userId);
  for (const d of [root, dir]) {
    try {
      fs.mkdirSync(d, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return undefined;
    }
    if (!privateDirectory(d)) return undefined;
  }
  return dir;
}

/** `d` is a real directory (not a link) of this process's user; its mode is set to 0700 through the handle. */
function privateDirectory(d: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(d, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isDirectory() || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) return false;
    fs.fchmodSync(fd, 0o700);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
