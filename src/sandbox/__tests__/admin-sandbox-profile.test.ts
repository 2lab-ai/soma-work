/**
 * The admin sandbox profile and the write protection every session gets (env-access WU2, #1210).
 *
 * Admins run in a sandbox too — a wide one — and no model, admin or not, writes the deployment or a
 * file that something outside the sandbox later runs (`.prd/25-env-access-architecture.md` §0, §1).
 */

import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ADMIN_ALL_DOMAINS_RULE,
  adminSandboxProfile,
  credentialPaths,
  credentialReadDenyRules,
  isSandboxOffInEffect,
  protectedWriteDenyRules,
  sandboxCacheEnv,
} from '../admin-sandbox-profile';
import { DEV_DOMAIN_ALLOWLIST } from '../dev-domain-allowlist';

const HOME = '/Users/owner';
const TMP = '/private/var/folders/xy/T';

describe('adminSandboxProfile', () => {
  const profile = adminSandboxProfile({ home: HOME, tmpdir: TMP });

  it('opens the network: every domain, the dev list, localhost, local binding, gh TLS through trustd', () => {
    expect(profile.allowRules).toEqual([ADMIN_ALL_DOMAINS_RULE]);
    expect(ADMIN_ALL_DOMAINS_RULE).toBe('WebFetch(domain:*)');
    expect(profile.network.allowedDomains).toEqual(expect.arrayContaining([...DEV_DOMAIN_ALLOWLIST]));
    expect(profile.network.allowedDomains).toEqual(expect.arrayContaining(['localhost', '127.0.0.1']));
    expect(profile.network.allowLocalBinding).toBe(true);
    expect(profile.enableWeakerNetworkIsolation).toBe(true);
  });

  it('writes the temp directory only: no home cache the bot also runs code from (astra R1)', () => {
    // The npm cache holds the MCP servers the bot launches with `npx -y`, outside every sandbox.
    expect(profile.allowWrite).toEqual([TMP]);
  });
});

describe('sandboxCacheEnv', () => {
  it("points every package cache at the user's own temp directory", () => {
    const env = sandboxCacheEnv('/tmp/U1');
    expect(env.npm_config_cache).toBe('/tmp/U1/.cache/npm');
    expect(env.XDG_CACHE_HOME).toBe('/tmp/U1/.cache');
    // pnpm reads npm_config_* too: its store goes there instead of failing on the home one (grok R2).
    expect(env.npm_config_store_dir).toBe('/tmp/U1/.cache/pnpm-store');
    for (const key of [
      'BUN_INSTALL_CACHE_DIR',
      'PIP_CACHE_DIR',
      'UV_CACHE_DIR',
      'GOCACHE',
      'GOMODCACHE',
      'YARN_CACHE_FOLDER',
    ]) {
      expect(env[key], key).toMatch(/^\/tmp\/U1\/\.cache\//);
    }
  });
});

describe('protectedWriteDenyRules', () => {
  it('write-denies every protected root as a whole, and the files the home directory runs or trusts', () => {
    const rules = protectedWriteDenyRules({
      roots: ['/opt/soma/dev', '/opt/soma/dev/data', '/srv/soma-runtime'],
      home: HOME,
    });
    expect(rules).toEqual(
      expect.arrayContaining([
        'Edit(//opt/soma/dev)',
        'Edit(//opt/soma/dev/**)',
        'Edit(//opt/soma/dev/data/**)',
        'Edit(//srv/soma-runtime/**)',
        `Edit(/${HOME}/Library/LaunchAgents/**)`,
        `Edit(/${HOME}/.ssh/**)`,
        `Edit(/${HOME}/.zshrc)`,
        `Edit(/${HOME}/.bash_profile)`,
        `Edit(/${HOME}/.profile)`,
        `Edit(/${HOME}/.gitconfig)`,
        `Edit(/${HOME}/.claude/settings.json)`,
      ]),
    );
    expect(rules.every((rule) => rule.startsWith('Edit(//'))).toBe(true);
  });

  it('has no exception for a session working inside a root: its source and configuration run as the bot (astra R1)', () => {
    const rules = protectedWriteDenyRules({ roots: ['/opt/soma/dev'], home: HOME });
    expect(rules).toContain('Edit(//opt/soma/dev/**)');
    expect(rules).not.toContain('Edit(//opt/soma/dev/config.json)');
  });
});

describe('isSandboxOffInEffect', () => {
  it('turns the sandbox off only for an admin who asked, on a host that allows it', () => {
    const base = { isAdmin: true, requested: true, hostAllows: true };
    expect(isSandboxOffInEffect(base)).toBe(true);
    expect(isSandboxOffInEffect({ ...base, hostAllows: false })).toBe(false);
    expect(isSandboxOffInEffect({ ...base, requested: false })).toBe(false);
    expect(isSandboxOffInEffect({ ...base, isAdmin: false })).toBe(false);
  });
});

describe('credential files (env-access WU2, #1210): no model reads a key, a token or a login', () => {
  it('names the ssh keys, gh, cloud and registry logins under the home directory', () => {
    const paths = credentialPaths(HOME);
    for (const p of ['.ssh', '.config/gh', '.aws', '.netrc', '.git-credentials', '.docker/config.json', '.kube']) {
      expect(paths).toContain(path.join(HOME, p));
    }
    // npm reads its own ~/.npmrc for installs; the keychain files are read by the TLS check.
    expect(paths).not.toContain(path.join(HOME, '.npmrc'));
    expect(paths).not.toContain(path.join(HOME, 'Library/Keychains'));
  });

  it('turns them into Read deny rules for the file tools, the path and everything under it', () => {
    const rules = credentialReadDenyRules(HOME);
    expect(rules).toEqual(
      expect.arrayContaining([`Read(/${HOME}/.ssh)`, `Read(/${HOME}/.ssh/**)`, `Read(/${HOME}/.aws/**)`]),
    );
    expect(rules.every((rule) => rule.startsWith('Read(//'))).toBe(true);
  });
});
