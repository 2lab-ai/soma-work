/**
 * An environment user (`env:<name>`, a server-tools entry's `envUser`) is an admin that runs without a sandbox.
 * Other users reach it through the flows that already exist: another user's skill, and a cron run request.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isAdminUser, resetAdminUsersCache } from '../admin-utils';
import { CONFIG_FILE } from '../env-paths';
import { environmentUserNamed, isEnvironmentUser } from '../env-users';
import { isSandboxOffInEffect } from '../sandbox/admin-sandbox-profile';
import { resolveUserIdentifier } from '../slack/commands/user-identity-resolver';

const CONFIG = {
  'server-tools': {
    permission: { list: 'read' },
    dev2: { envUser: 'env:acme-dev2', ssh: { host: 'dev2' }, skills: ['acme-env:post-deploy'] },
    stage0: { envUser: 'env:acme-stage0', ssh: { host: 's0' } },
    plain: { ssh: { host: 'p' } },
  },
};

function writeConfig(config: unknown): void {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config));
  // loadEnvironments re-reads on an mtime/size change; make each write visible.
  const later = new Date(Date.now() + Math.floor(Math.random() * 100000));
  fs.utimesSync(CONFIG_FILE, later, later);
}

describe('environment users', () => {
  const savedAdmins = process.env.ADMIN_USERS;

  beforeEach(() => {
    process.env.ADMIN_USERS = 'UADMIN';
    resetAdminUsersCache();
    writeConfig(CONFIG);
  });

  afterEach(() => {
    process.env.ADMIN_USERS = savedAdmins;
    resetAdminUsersCache();
    fs.rmSync(CONFIG_FILE, { force: true });
  });

  it('knows the configured environment users, and nothing else', () => {
    expect(isEnvironmentUser('env:acme-dev2')).toBe(true);
    expect(isEnvironmentUser('env:acme-stage0')).toBe(true);
    expect(isEnvironmentUser('env:acme-dev9')).toBe(false);
    expect(isEnvironmentUser('UADMIN')).toBe(false);
    expect(isEnvironmentUser('')).toBe(false);
  });

  it('names an environment user by its label, case-insensitively', () => {
    expect(environmentUserNamed('acme-dev2')).toBe('env:acme-dev2');
    expect(environmentUserNamed('ACME-Stage0')).toBe('env:acme-stage0');
    expect(environmentUserNamed('env:acme-dev2')).toBe('env:acme-dev2');
    expect(environmentUserNamed('acme-dev9')).toBeNull();
    expect(environmentUserNamed('')).toBeNull();
  });

  it('treats an environment user as an admin; a person still needs ADMIN_USERS', () => {
    expect(isAdminUser('env:acme-dev2')).toBe(true);
    expect(isAdminUser('UADMIN')).toBe(true);
    expect(isAdminUser('UPLAIN')).toBe(false);
    // Not configured → not an admin, whatever the shape.
    expect(isAdminUser('env:acme-dev9')).toBe(false);
  });

  it('drops the environment user when its entry leaves config.json', () => {
    expect(isAdminUser('env:acme-stage0')).toBe(true);
    writeConfig({ 'server-tools': { dev2: CONFIG['server-tools'].dev2 } });
    expect(isAdminUser('env:acme-stage0')).toBe(false);
    expect(isAdminUser('env:acme-dev2')).toBe(true);
  });

  it('runs an environment user without a sandbox, on any host', () => {
    expect(isSandboxOffInEffect({ isAdmin: true, requested: false, hostAllows: false, environmentUser: true })).toBe(
      true,
    );
    // A person admin keeps the existing rule.
    expect(isSandboxOffInEffect({ isAdmin: true, requested: true, hostAllows: false })).toBe(false);
    expect(isSandboxOffInEffect({ isAdmin: true, requested: true, hostAllows: true })).toBe(true);
  });

  it('resolves `$acme-dev2:skill` to the environment user before any Slack display name', () => {
    const directory = {
      getAllUsers: () => [{ userId: 'UIMPOSTER', slackName: 'x', slackDisplayName: 'acme-dev2' }],
    };
    expect(resolveUserIdentifier('acme-dev2', directory)).toBe('env:acme-dev2');
    expect(resolveUserIdentifier('env:acme-stage0', directory)).toBe('env:acme-stage0');
    // An unknown environment name still falls through to the directory.
    expect(resolveUserIdentifier('x', directory)).toBe('UIMPOSTER');
  });
});
