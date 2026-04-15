import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  checkBashSensitivePaths,
  checkSensitiveGlob,
  checkSensitivePath,
  getSensitiveReadDenyPaths,
} from './sensitive-path-filter';

const HOME = os.homedir();

describe('checkSensitivePath', () => {
  describe('blocks sensitive directories', () => {
    it.each([
      [`${HOME}/.ssh/id_ed25519`, '.ssh private key'],
      [`${HOME}/.ssh/id_rsa`, '.ssh RSA key'],
      [`${HOME}/.ssh/config`, '.ssh config'],
      [`${HOME}/.ssh/known_hosts`, '.ssh known hosts'],
      [`${HOME}/.ssh`, '.ssh directory itself'],
      [`${HOME}/.gnupg/private-keys-v1.d`, '.gnupg private keys'],
      [`${HOME}/.config/gh/hosts.yml`, 'GitHub CLI credentials'],
      [`${HOME}/.aws/credentials`, 'AWS credentials'],
      [`${HOME}/.docker/config.json`, 'Docker config'],
      [`${HOME}/Library/Keychains/login.keychain-db`, 'macOS keychain'],
    ])('blocks: %s (%s)', (filePath) => {
      const result = checkSensitivePath(filePath);
      expect(result.isSensitive).toBe(true);
      expect(result.reason).toBeDefined();
    });
  });

  describe('blocks sensitive exact files', () => {
    it.each([
      [`${HOME}/.gitconfig`, '.gitconfig'],
      [`${HOME}/.netrc`, '.netrc'],
      [`${HOME}/.npmrc`, '.npmrc'],
      [`${HOME}/.claude/credentials.json`, 'Claude credentials'],
    ])('blocks: %s (%s)', (filePath) => {
      const result = checkSensitivePath(filePath);
      expect(result.isSensitive).toBe(true);
    });
  });

  describe('blocks sensitive basenames', () => {
    it.each([
      ['/opt/soma-work/dev/.env', '.env in service dir'],
      ['/some/project/.env', '.env in project'],
      ['/app/.env.local', '.env.local'],
      ['/app/.env.production', '.env.production'],
      ['/app/.env.staging', '.env.staging'],
      ['/app/.env.development', '.env.development'],
    ])('blocks: %s (%s)', (filePath) => {
      const result = checkSensitivePath(filePath);
      expect(result.isSensitive).toBe(true);
    });
  });

  describe('blocks sensitive basename patterns', () => {
    it.each([
      ['/app/credentials.json', 'credentials.json'],
      ['/app/secrets.json', 'secrets.json'],
      ['/app/secret.yaml', 'secret.yaml'],
      ['/app/secrets.toml', 'secrets.toml'],
    ])('blocks: %s (%s)', (filePath) => {
      const result = checkSensitivePath(filePath);
      expect(result.isSensitive).toBe(true);
    });
  });

  describe('blocks service config files', () => {
    it.each([
      ['/opt/soma-work/dev/config.json', 'soma-work dev config'],
      ['/opt/soma-work/prod/config.json', 'soma-work prod config'],
      ['/opt/soma-work/dev/.env', 'soma-work dev env'],
      ['/opt/soma/dev/.env', 'soma dev env'],
    ])('blocks: %s (%s)', (filePath) => {
      const result = checkSensitivePath(filePath);
      expect(result.isSensitive).toBe(true);
    });
  });

  describe('allows safe paths', () => {
    it.each([
      ['/tmp/U094E5L4A15/soma-work_123/src/index.ts', 'user workspace file'],
      ['/tmp/U094E5L4A15/soma-work_123/package.json', 'package.json in workspace'],
      [`${HOME}/projects/my-app/src/config.ts`, 'source code file'],
      ['/usr/local/bin/node', 'system binary'],
      ['/tmp/U094E5L4A15/test.txt', 'user tmp file'],
    ])('allows: %s (%s)', (filePath) => {
      const result = checkSensitivePath(filePath);
      expect(result.isSensitive).toBe(false);
    });
  });

  describe('handles tilde expansion', () => {
    it('blocks ~/.ssh/id_rsa', () => {
      const result = checkSensitivePath('~/.ssh/id_rsa');
      expect(result.isSensitive).toBe(true);
    });

    it('blocks ~/.config/gh/hosts.yml', () => {
      const result = checkSensitivePath('~/.config/gh/hosts.yml');
      expect(result.isSensitive).toBe(true);
    });
  });

  describe('handles edge cases', () => {
    it('returns false for empty path', () => {
      expect(checkSensitivePath('').isSensitive).toBe(false);
    });

    it('handles /private/tmp normalization', () => {
      const result = checkSensitivePath('/private/tmp/U094E5L4A15/test.txt');
      expect(result.isSensitive).toBe(false);
    });
  });
});

describe('checkBashSensitivePaths', () => {
  describe('blocks reading sensitive files', () => {
    it.each([
      [`cat ${HOME}/.ssh/id_ed25519`, 'cat SSH key'],
      [`head -1 ${HOME}/.ssh/config`, 'head SSH config'],
      [`tail ${HOME}/.gitconfig`, 'tail gitconfig'],
      [`cat /opt/soma-work/dev/.env`, 'cat service env'],
      [`less ${HOME}/.ssh/id_rsa`, 'less SSH key'],
      [`base64 ${HOME}/.ssh/id_ed25519`, 'base64 encode SSH key'],
      [`strings ${HOME}/.ssh/id_rsa`, 'strings SSH key'],
      [`cat ${HOME}/.config/gh/hosts.yml`, 'cat GitHub token'],
    ])('blocks: %s (%s)', (command) => {
      const result = checkBashSensitivePaths(command);
      expect(result.isSensitive).toBe(true);
    });
  });

  describe('blocks copy from sensitive sources', () => {
    it.each([
      [`cp ${HOME}/.ssh/id_ed25519 /tmp/stolen`, 'cp SSH key'],
      [`cp ${HOME}/.gitconfig /tmp/leak`, 'cp gitconfig'],
    ])('blocks: %s (%s)', (command) => {
      const result = checkBashSensitivePaths(command);
      expect(result.isSensitive).toBe(true);
    });
  });

  describe('allows safe commands', () => {
    it.each([
      ['ls /tmp/U094E5L4A15/', 'ls user tmp'],
      ['cat /tmp/U094E5L4A15/soma-work/src/index.ts', 'cat workspace file'],
      ['git status', 'git status'],
      ['npm install', 'npm install'],
      ['echo hello', 'echo'],
      ['pwd', 'pwd'],
    ])('allows: %s (%s)', (command) => {
      const result = checkBashSensitivePaths(command);
      expect(result.isSensitive).toBe(false);
    });
  });
});

describe('checkSensitiveGlob', () => {
  it('blocks glob in .ssh directory', () => {
    const result = checkSensitiveGlob('*', `${HOME}/.ssh`);
    expect(result.isSensitive).toBe(true);
  });

  it('blocks glob pattern targeting .ssh', () => {
    const result = checkSensitiveGlob(`${HOME}/.ssh/*`);
    expect(result.isSensitive).toBe(true);
  });

  it('blocks glob in .config/gh', () => {
    const result = checkSensitiveGlob('*.yml', `${HOME}/.config/gh`);
    expect(result.isSensitive).toBe(true);
  });

  it('allows glob in user workspace', () => {
    const result = checkSensitiveGlob('**/*.ts', '/tmp/U094E5L4A15/soma-work');
    expect(result.isSensitive).toBe(false);
  });
});

describe('getSensitiveReadDenyPaths', () => {
  it('returns non-empty list', () => {
    const paths = getSensitiveReadDenyPaths();
    expect(paths.length).toBeGreaterThan(0);
  });

  it('includes .ssh directory', () => {
    const paths = getSensitiveReadDenyPaths();
    expect(paths).toContain(path.join(HOME, '.ssh'));
  });

  it('includes service .env files', () => {
    const paths = getSensitiveReadDenyPaths();
    expect(paths).toContain('/opt/soma-work/dev/.env');
  });
});
