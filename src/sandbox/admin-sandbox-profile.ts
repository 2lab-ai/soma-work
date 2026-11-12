/**
 * The admin sandbox profile, and the write protection every model session gets
 * (env-access WU2, #1210 — `.prd/25-env-access-architecture.md` §0, §1).
 *
 * Admins run in a sandbox too, a wide one: every network domain, gh's TLS check through trustd,
 * local servers, and the package caches writable. What no model writes — admin or not, sandbox on or
 * off — is the deployment (its code, configuration and data: rewriting them runs the model's code as
 * the bot, outside any sandbox) and the files that something outside the sandbox later runs or trusts
 * (launch agents, shell startup files, ssh's authorized keys, git and CLI settings).
 *
 * Pure: callers pass the paths.
 */

import * as path from 'node:path';
import { DEV_DOMAIN_ALLOWLIST } from './dev-domain-allowlist';

/**
 * The permission rule that puts every domain on the sandbox's network allowlist (Claude Code
 * 2.1.186+). It also lets the WebFetch tool fetch any domain — admins could already.
 */
export const ADMIN_ALL_DOMAINS_RULE = 'WebFetch(domain:*)';

/**
 * Package caches under the home directory that installs and builds write. Never a directory on the
 * PATH (`~/.bun/bin`, `~/.local/bin`, `~/.cargo/bin`): a binary planted there would run outside the
 * sandbox later.
 */
const ADMIN_CACHE_DIRS = [
  '.npm',
  '.cache',
  'Library/Caches',
  '.bun/install/cache',
  '.cargo/registry',
  '.cargo/git',
  'go/pkg',
  '.gradle/caches',
  '.m2/repository',
  'Library/pnpm/store',
  '.local/share/pnpm/store',
  '.yarn/berry/cache',
];

export interface AdminSandboxProfile {
  /** Added to the sandbox `filesystem.allowWrite`. */
  allowWrite: string[];
  network: { allowedDomains: string[]; allowLocalBinding: true };
  /** macOS: trustd lookups, so gh and other Go tools can check TLS certificates in the sandbox. */
  enableWeakerNetworkIsolation: true;
  /** Added to `settings.permissions.allow`. */
  allowRules: string[];
}

export function adminSandboxProfile(paths: { home: string; tmpdir: string }): AdminSandboxProfile {
  return {
    allowWrite: [paths.tmpdir, ...ADMIN_CACHE_DIRS.map((dir) => path.join(paths.home, dir))],
    network: {
      allowedDomains: [...new Set([...DEV_DOMAIN_ALLOWLIST, 'localhost', '127.0.0.1'])],
      allowLocalBinding: true,
    },
    enableWeakerNetworkIsolation: true,
    allowRules: [ADMIN_ALL_DOMAINS_RULE],
  };
}

/** Files and directories under the home directory that run, or are trusted, outside the sandbox. */
const HOME_STARTUP_FILES = [
  '.zshrc',
  '.zshenv',
  '.zprofile',
  '.zlogin',
  '.bashrc',
  '.bash_profile',
  '.bash_login',
  '.profile',
  '.gitconfig',
  '.claude/settings.json',
  '.claude/settings.local.json',
];
const HOME_STARTUP_DIRS = ['Library/LaunchAgents', '.ssh', '.config/git', '.config/fish'];

/**
 * The files of a deployment the bot runs or reads as its own, for a session whose working directory
 * lies inside the deployment (where denying the whole of it would deny the session's own work).
 */
const DEPLOY_CRITICAL_FILES = ['config.json', 'mcp-servers.json', '.env', 'package.json', '.system.prompt'];
const DEPLOY_CRITICAL_DIRS = ['dist', 'node_modules', 'packages', 'plugins', 'scripts', 'somalib', 'services'];

function isWithin(p: string, root: string): boolean {
  const relative = path.relative(root, p);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * `Edit` deny rules (they cover Write and NotebookEdit, and the CLI merges their paths into the
 * sandbox `denyWrite`) for the deployment, its data directory, and the home directory's startup and
 * trust files. Absolute (`//`) rule paths. Each of `deployRoot`, `dataDir` and `workingDirectory`
 * may come with its other spellings (a symbolic link and where it points): every spelling of a
 * protected path gets a rule, and the session counts as working inside the deployment when any
 * spelling of its directory lies inside any spelling of the deployment.
 */
export function protectedWriteDenyRules(paths: {
  deployRoot: string | readonly string[];
  dataDir: string | readonly string[];
  home: string;
  workingDirectory?: string | readonly string[];
}): string[] {
  const list = (v: string | readonly string[] | undefined): string[] =>
    v === undefined ? [] : typeof v === 'string' ? [v] : [...v];
  const edit = (p: string) => `Edit(/${path.normalize(p)})`;
  const tree = (dir: string) => [edit(dir), `Edit(/${path.normalize(dir)}/**)`];
  const deployRoots = list(paths.deployRoot);
  const workingInside = list(paths.workingDirectory).some((wd) =>
    deployRoots.some((root) => isWithin(path.resolve(wd), path.resolve(root))),
  );
  const deployRules = deployRoots.flatMap((deploy) =>
    workingInside
      ? [
          ...DEPLOY_CRITICAL_FILES.map((file) => edit(path.join(deploy, file))),
          ...DEPLOY_CRITICAL_DIRS.flatMap((dir) => tree(path.join(deploy, dir))),
        ]
      : tree(deploy),
  );
  return [
    ...new Set([
      ...deployRules,
      ...list(paths.dataDir).flatMap(tree),
      ...HOME_STARTUP_FILES.map((file) => edit(path.join(paths.home, file))),
      ...HOME_STARTUP_DIRS.flatMap((dir) => tree(path.join(paths.home, dir))),
    ]),
  ];
}

/**
 * Credential files under the home directory: ssh keys, the gh login, cloud and registry logins. No model
 * reads them — host commands go through server-tools' `ssh_exec`, which runs outside the sandbox
 * (.prd/25-env-access-architecture.md §1). Not `~/.npmrc` (npm reads it to install) and not the
 * keychain files (the TLS check reads them; keychain items stay behind the keychain service).
 */
const CREDENTIAL_PATHS = [
  '.ssh',
  '.config/gh',
  '.config/gcloud',
  '.aws',
  '.azure',
  '.kube',
  '.docker/config.json',
  '.netrc',
  '.git-credentials',
  '.gnupg',
];

export function credentialPaths(home: string): string[] {
  return CREDENTIAL_PATHS.map((p) => path.join(home, p));
}

/** `Read` deny rules (they cover Grep and Glob) for {@link credentialPaths}, each path and what is under it. */
export function credentialReadDenyRules(home: string): string[] {
  return credentialPaths(home).flatMap((p) => [`Read(/${p})`, `Read(/${p}/**)`]);
}

/**
 * The sandbox is off only for an admin who turned it off, on a host whose operator allows that
 * (`SOMA_SANDBOX_OFF_ALLOWED`). Otherwise the setting is stored but the session stays sandboxed.
 */
export function isSandboxOffInEffect(input: { isAdmin: boolean; requested: boolean; hostAllows: boolean }): boolean {
  return input.isAdmin && input.requested && input.hostAllows;
}
