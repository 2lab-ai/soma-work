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

  it('writes the temp directory and the package caches, not the home directory itself', () => {
    expect(profile.allowWrite).toContain(TMP);
    for (const cache of ['.npm', '.cache', 'Library/Caches', '.bun/install/cache', '.cargo/registry']) {
      expect(profile.allowWrite).toContain(path.join(HOME, cache));
    }
    expect(profile.allowWrite).not.toContain(HOME);
    // A directory on the PATH would let a planted binary run outside the sandbox later.
    expect(profile.allowWrite).not.toContain(path.join(HOME, '.bun'));
    expect(profile.allowWrite).not.toContain(path.join(HOME, '.local'));
  });
});

describe('protectedWriteDenyRules', () => {
  const DEPLOY = '/opt/soma/dev';
  const DATA = '/opt/soma/dev/data';

  it('write-denies the whole deployment, the data directory and what runs outside the sandbox', () => {
    const rules = protectedWriteDenyRules({ deployRoot: DEPLOY, dataDir: DATA, home: HOME });
    expect(rules).toEqual(
      expect.arrayContaining([
        `Edit(/${DEPLOY})`,
        `Edit(/${DEPLOY}/**)`,
        `Edit(/${DATA}/**)`,
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

  it('keeps a session working inside the deployment workable: only the files the bot runs are denied', () => {
    const rules = protectedWriteDenyRules({
      deployRoot: DEPLOY,
      dataDir: DATA,
      home: HOME,
      workingDirectory: `${DEPLOY}/workspace/U1`,
    });
    expect(rules).not.toContain(`Edit(/${DEPLOY}/**)`);
    expect(rules).toEqual(
      expect.arrayContaining([
        `Edit(/${DEPLOY}/config.json)`,
        `Edit(/${DEPLOY}/mcp-servers.json)`,
        `Edit(/${DEPLOY}/.env)`,
        `Edit(/${DEPLOY}/dist/**)`,
        `Edit(/${DEPLOY}/node_modules/**)`,
        `Edit(/${DEPLOY}/plugins/**)`,
        `Edit(/${DATA}/**)`,
      ]),
    );
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
