/**
 * The admin sandbox profile, and the write protection every model session gets
 * (env-access WU2, #1210 — `.prd/25-env-access-architecture.md` §0, §1).
 *
 * Admins run in a sandbox too, a wide one: every network domain, gh's TLS check through trustd,
 * local servers, and the temp directory writable (package caches go to the user's temp directory). What no model writes — admin or not, sandbox on or
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

export interface AdminSandboxProfile {
  /** Added to the sandbox `filesystem.allowWrite`. */
  allowWrite: string[];
  network: { allowedDomains: string[]; allowLocalBinding: true };
  /** macOS: trustd lookups, so gh and other Go tools can check TLS certificates in the sandbox. */
  enableWeakerNetworkIsolation: true;
  /** Added to `settings.permissions.allow`. */
  allowRules: string[];
}

/**
 * No home directory is writable, caches included: the bot runs code from them outside every sandbox
 * (the npm cache holds the MCP servers it starts with `npx -y`). Package caches go to the user's own
 * temp directory instead ({@link sandboxCacheEnv}).
 */
export function adminSandboxProfile(paths: { home: string; tmpdir: string }): AdminSandboxProfile {
  return {
    allowWrite: [paths.tmpdir],
    network: {
      allowedDomains: [...new Set([...DEV_DOMAIN_ALLOWLIST, 'localhost', '127.0.0.1'])],
      allowLocalBinding: true,
    },
    enableWeakerNetworkIsolation: true,
    allowRules: [ADMIN_ALL_DOMAINS_RULE],
  };
}

/**
 * Environment for a sandboxed session: every package cache in the user's own temp directory, where the
 * sandbox lets it write and from where nothing outside the sandbox runs code.
 */
export function sandboxCacheEnv(userTmpDir: string): Record<string, string> {
  const cache = path.join(userTmpDir, '.cache');
  return {
    XDG_CACHE_HOME: cache,
    npm_config_cache: path.join(cache, 'npm'),
    YARN_CACHE_FOLDER: path.join(cache, 'yarn'),
    BUN_INSTALL_CACHE_DIR: path.join(cache, 'bun'),
    PIP_CACHE_DIR: path.join(cache, 'pip'),
    UV_CACHE_DIR: path.join(cache, 'uv'),
    GOCACHE: path.join(cache, 'go-build'),
    GOMODCACHE: path.join(cache, 'go-mod'),
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
 * `Edit` deny rules (they cover Write and NotebookEdit, and the CLI merges their paths into the
 * sandbox `denyWrite`) for every protected root as a whole — the deployment's configuration
 * directory, the running code's root, the bot's own directory, the data and plugin directories, each
 * spelling of each — and the home directory's startup and trust files. No exception for a session
 * working inside a root: what it would write there is code or configuration the bot runs. Absolute
 * (`//`) rule paths.
 */
export function protectedWriteDenyRules(paths: { roots: readonly string[]; home: string }): string[] {
  const edit = (p: string) => `Edit(/${path.normalize(p)})`;
  const tree = (dir: string) => [edit(dir), `Edit(/${path.normalize(dir)}/**)`];
  return [
    ...new Set([
      ...paths.roots.flatMap(tree),
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
