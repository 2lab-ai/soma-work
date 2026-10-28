import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadDeploySandboxGrant, resolvesToItself, sanitizeDeploySandboxGrant } from '../deploy-sandbox-grant';
import { isForbiddenGrantLocation, isGrantDomain, isGrantPath, isSlackUserId } from '../deploy-sandbox-rules';
import {
  INVALID_DOMAINS,
  INVALID_PATHS,
  INVALID_USERS,
  VALID_DOMAINS,
  VALID_PATHS,
  VALID_USERS,
} from './deploy-sandbox-cases';

const GRANT = {
  users: ['UAPPROVED1'],
  allowedDomains: ['qa.example.test', 'admin.qa.example.test'],
  allowWrite: ['/srv/qa/lock', '/srv/qa/runs'],
};

describe('deploy sandbox rules', () => {
  it.each(VALID_USERS)('accepts the user ID %j', (value) => expect(isSlackUserId(value)).toBe(true));
  it.each(INVALID_USERS)('rejects the user ID %j', (value) => expect(isSlackUserId(value)).toBe(false));

  it.each(VALID_DOMAINS)('accepts the domain %j', (value) => expect(isGrantDomain(value)).toBe(true));
  it.each(INVALID_DOMAINS)('rejects the domain %j', (value) => expect(isGrantDomain(value)).toBe(false));

  it.each(VALID_PATHS)('accepts the path %j', (value) => expect(isGrantPath(value)).toBe(true));
  it.each(INVALID_PATHS)('rejects the path %j', (value) => expect(isGrantPath(value)).toBe(false));

  it.each([undefined, null, 7, ['UAPPROVED1'], { id: 'UAPPROVED1' }])('rejects the non-string %j', (value) => {
    expect(isSlackUserId(value)).toBe(false);
    expect(isGrantDomain(value)).toBe(false);
    expect(isGrantPath(value)).toBe(false);
  });

  // The location rule on its own, below the three-component floor that would
  // otherwise also reject the short cases.
  describe('isForbiddenGrantLocation', () => {
    it.each([
      ['/tmp', 'equal to a forbidden root'],
      ['/private/tmp/qa', 'under a forbidden root'],
      ['/private', 'above a forbidden root (/private/tmp)'],
      ['/', 'above every root'],
      ['/var/lib', 'under /var'],
      ['/Library', 'equal, case as on disk'],
      ['/library/qa', 'under, other case'],
      ['/Users', 'a home root'],
      ['/home', 'a home root'],
      ['/Users/someone', 'a home directory itself'],
      ['/home/someone', 'a home directory itself'],
    ])('refuses %j (%s)', (value) => expect(isForbiddenGrantLocation(value)).toBe(true));

    it.each(['/srv', '/srv/qa', '/Users/someone/qa', '/home/someone/work', '/data/qa'])('allows %j', (value) =>
      expect(isForbiddenGrantLocation(value)).toBe(false));
  });
});

describe('resolvesToItself (runtime symlink check)', () => {
  let base: string;

  beforeEach(() => {
    // Canonical base: on macOS the temp dir itself sits behind /var → /private/var.
    base = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'deploy-sandbox-resolve-'));
    fs.mkdirSync(path.join(base, 'real', 'lock'), { recursive: true });
    fs.mkdirSync(path.join(base, 'other'));
    fs.symlinkSync(path.join(base, 'other'), path.join(base, 'leaf-link'));
    fs.symlinkSync(path.join(base, 'real'), path.join(base, 'parent-link'));
    fs.writeFileSync(path.join(base, 'plain-file'), 'x', 'utf8');
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('accepts an existing directory that names itself', () => {
    expect(resolvesToItself(path.join(base, 'real', 'lock'))).toBe(true);
  });

  it('accepts a missing path whose nearest existing ancestor names itself', () => {
    expect(resolvesToItself(path.join(base, 'real', 'not-yet', 'deeper'))).toBe(true);
  });

  it('refuses a symlink whose target differs', () => {
    expect(resolvesToItself(path.join(base, 'leaf-link'))).toBe(false);
  });

  it('refuses an existing path under a symlinked parent', () => {
    expect(resolvesToItself(path.join(base, 'parent-link', 'lock'))).toBe(false);
  });

  it('refuses a missing path under a symlinked parent', () => {
    expect(resolvesToItself(path.join(base, 'parent-link', 'not-yet'))).toBe(false);
  });

  it('refuses a path that runs through a regular file', () => {
    expect(resolvesToItself(path.join(base, 'plain-file', 'lock'))).toBe(false);
  });

  // realpath answers ENOENT for a symlink whose target is missing, exactly as
  // for an absent path; only lstat tells them apart.
  it('refuses a dangling symlink as the leaf', () => {
    fs.symlinkSync(path.join(base, 'nowhere'), path.join(base, 'real', 'dangling'));
    expect(resolvesToItself(path.join(base, 'real', 'dangling'))).toBe(false);
  });

  it('refuses a path under a dangling symlinked ancestor', () => {
    fs.symlinkSync(path.join(base, 'nowhere-dir'), path.join(base, 'dangling-dir'));
    expect(resolvesToItself(path.join(base, 'dangling-dir', 'sub', 'lock'))).toBe(false);
  });

  it('keeps refusing a dangling symlink after its target is created', () => {
    fs.symlinkSync(path.join(base, 'later-target'), path.join(base, 'later'));
    expect(resolvesToItself(path.join(base, 'later'))).toBe(false);
    expect(resolvesToItself(path.join(base, 'later', 'lock'))).toBe(false);

    fs.mkdirSync(path.join(base, 'later-target'));
    expect(resolvesToItself(path.join(base, 'later'))).toBe(false);
    expect(resolvesToItself(path.join(base, 'later', 'lock'))).toBe(false);
  });
});

// Each check of the absent-path walk on its own, on a stubbed disk: on a real
// disk the lstat check and the final realpath overlap, so either alone would
// hide the other's removal.
describe('resolvesToItself layers (stubbed disk)', () => {
  type Kind = 'dir' | 'symlink' | 'ENOENT' | 'EACCES';

  function stubDisk(realpaths: Record<string, string | 'ENOENT' | 'EACCES'>, kinds: Record<string, Kind>): void {
    const fail = (code: string) => Object.assign(new Error(code), { code });
    vi.spyOn(fs.realpathSync, 'native').mockImplementation(((target: fs.PathLike) => {
      const resolved = realpaths[String(target)] ?? 'ENOENT';
      if (resolved === 'ENOENT' || resolved === 'EACCES') throw fail(resolved);
      return resolved;
    }) as typeof fs.realpathSync.native);
    vi.spyOn(fs, 'lstatSync').mockImplementation(((target: fs.PathLike) => {
      const kind = kinds[String(target)] ?? 'ENOENT';
      if (kind === 'ENOENT' || kind === 'EACCES') throw fail(kind);
      return { isDirectory: () => kind === 'dir', isSymbolicLink: () => kind === 'symlink' } as fs.Stats;
    }) as typeof fs.lstatSync);
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts an absent tail under real directories that resolve to themselves', () => {
    stubDisk({ '/srv/qa/lock': 'ENOENT', '/srv': '/srv' }, { '/srv': 'dir', '/srv/qa': 'ENOENT' });
    expect(resolvesToItself('/srv/qa/lock')).toBe(true);
  });

  it('refuses a symlinked component even when realpath would report it unchanged', () => {
    stubDisk(
      { '/srv/qa/lock': 'ENOENT', '/srv': '/srv', '/srv/qa': '/srv/qa' },
      { '/srv': 'dir', '/srv/qa': 'symlink' },
    );
    expect(resolvesToItself('/srv/qa/lock')).toBe(false);
  });

  it('refuses when the deepest existing directory resolves elsewhere', () => {
    stubDisk({ '/srv/qa/lock': 'ENOENT', '/srv': '/data/srv' }, { '/srv': 'dir', '/srv/qa': 'ENOENT' });
    expect(resolvesToItself('/srv/qa/lock')).toBe(false);
  });

  it('refuses when lstat fails for any reason other than absence', () => {
    stubDisk({ '/srv/qa/lock': 'ENOENT', '/': '/' }, { '/srv': 'EACCES' });
    expect(resolvesToItself('/srv/qa/lock')).toBe(false);
  });

  it('refuses when realpath fails for any reason other than absence, without walking', () => {
    // Only an ENOENT answer may start the walk: here the walk alone would find
    // an absent tail under a clean `/srv` and accept.
    stubDisk({ '/srv/qa/lock': 'EACCES', '/srv': '/srv' }, { '/srv': 'dir', '/srv/qa': 'ENOENT' });
    expect(resolvesToItself('/srv/qa/lock')).toBe(false);
  });
});

describe('sanitizeDeploySandboxGrant', () => {
  it('keeps a valid grant as is', () => {
    expect(sanitizeDeploySandboxGrant(GRANT)).toEqual({
      grant: GRANT,
      dropped: { users: 0, domains: 0, paths: 0 },
      malformed: false,
    });
  });

  it('is no grant when the key is absent', () => {
    expect(sanitizeDeploySandboxGrant(undefined)).toEqual({
      grant: null,
      dropped: { users: 0, domains: 0, paths: 0 },
      malformed: false,
    });
  });

  it.each([null, 'UAPPROVED1', ['UAPPROVED1'], 3])('is no grant, flagged malformed, for the value %j', (raw) => {
    const result = sanitizeDeploySandboxGrant(raw);
    expect(result.grant).toBeNull();
    expect(result.malformed).toBe(true);
  });

  it('drops invalid entries, counting each list separately, and dedupes the rest', () => {
    const result = sanitizeDeploySandboxGrant({
      users: ['UAPPROVED1', 'uapproved1', 'UAPPROVED1', 42],
      allowedDomains: ['qa.example.test', 'https://qa.example.test', '*.qa.example.test', 'qa.example.test'],
      allowWrite: ['/srv/qa/lock', '/tmp/qa/lock', '/srv/qa', '/private'],
    });

    expect(result.grant).toEqual({
      users: ['UAPPROVED1'],
      allowedDomains: ['qa.example.test'],
      allowWrite: ['/srv/qa/lock'],
    });
    expect(result.dropped).toEqual({ users: 2, domains: 2, paths: 3 });
    expect(result.malformed).toBe(false);
  });

  it('drops a lexically valid path the runtime check refuses, and asks only about those', () => {
    const pathResolves = vi.fn((target: string) => target !== '/srv/qa/runs');
    const result = sanitizeDeploySandboxGrant(
      { ...GRANT, allowWrite: ['/srv/qa/lock', '/srv/qa/runs', '/tmp/qa/lock'] },
      { pathResolves },
    );

    expect(result.grant?.allowWrite).toEqual(['/srv/qa/lock']);
    expect(result.dropped.paths).toBe(2);
    expect(pathResolves.mock.calls.map(([target]) => target)).toEqual(['/srv/qa/lock', '/srv/qa/runs']);
  });

  it('counts a list that is not an array as one dropped entry', () => {
    const result = sanitizeDeploySandboxGrant({
      users: 'UAPPROVED1',
      allowedDomains: [],
      allowWrite: ['/srv/qa/state'],
    });
    expect(result.grant).toBeNull();
    expect(result.dropped.users).toBe(1);
  });

  it('is no grant when no user survives validation', () => {
    expect(sanitizeDeploySandboxGrant({ ...GRANT, users: ['nobody'] }).grant).toBeNull();
  });

  it('is no grant when there is nothing to grant', () => {
    expect(sanitizeDeploySandboxGrant({ users: ['UAPPROVED1'], allowedDomains: [], allowWrite: [] }).grant).toBeNull();
  });

  it('keeps a grant with only paths or only domains', () => {
    expect(sanitizeDeploySandboxGrant({ users: ['UAPPROVED1'], allowWrite: ['/srv/qa/state'] }).grant).toEqual({
      users: ['UAPPROVED1'],
      allowedDomains: [],
      allowWrite: ['/srv/qa/state'],
    });
    expect(sanitizeDeploySandboxGrant({ users: ['UAPPROVED1'], allowedDomains: ['qa.example.test'] }).grant).toEqual({
      users: ['UAPPROVED1'],
      allowedDomains: ['qa.example.test'],
      allowWrite: [],
    });
  });
});

describe('loadDeploySandboxGrant', () => {
  const tempDirs: string[] = [];

  function makeConfig(content: unknown): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-sandbox-grant-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'config.json');
    writeConfig(file, content);
    return file;
  }

  function writeConfig(file: string, content: unknown): void {
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  }

  function makeLogger() {
    return { warn: vi.fn() };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads the grant from config.json#deploySandbox', () => {
    const file = makeConfig({ plugin: {}, deploySandbox: GRANT });
    expect(loadDeploySandboxGrant(file, makeLogger())).toEqual(GRANT);
  });

  it('is no grant without a config file path', () => {
    expect(loadDeploySandboxGrant('', makeLogger())).toBeNull();
    expect(loadDeploySandboxGrant(undefined, makeLogger())).toBeNull();
  });

  it('is no grant, silently, when config.json is missing', () => {
    const logger = makeLogger();
    expect(loadDeploySandboxGrant(path.join(os.tmpdir(), 'deploy-sandbox-grant-missing', 'config.json'), logger)).toBe(
      null,
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('is no grant, silently, when the key is missing', () => {
    const logger = makeLogger();
    expect(loadDeploySandboxGrant(makeConfig({ plugin: {} }), logger)).toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('is no grant, with one warning, when config.json is not JSON', () => {
    const logger = makeLogger();
    expect(loadDeploySandboxGrant(makeConfig('{ "deploySandbox": '), logger)).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('is no grant, with one warning, when config.json cannot be read', () => {
    const logger = makeLogger();
    const file = makeConfig({ deploySandbox: GRANT });
    fs.rmSync(file);
    fs.mkdirSync(file);
    expect(loadDeploySandboxGrant(file, logger)).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('is no grant, with one warning, when the key is not an object', () => {
    const logger = makeLogger();
    expect(loadDeploySandboxGrant(makeConfig({ deploySandbox: ['UAPPROVED1'] }), logger)).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('drops invalid entries with one warning that states counts only', () => {
    const logger = makeLogger();
    const file = makeConfig({
      deploySandbox: {
        users: ['UAPPROVED1', 'uleaked1'],
        allowedDomains: ['qa.example.test', 'https://leaked.example.test'],
        allowWrite: ['/srv/qa/lock', '/tmp/leaked/x'],
      },
    });

    expect(loadDeploySandboxGrant(file, logger)).toEqual({
      users: ['UAPPROVED1'],
      allowedDomains: ['qa.example.test'],
      allowWrite: ['/srv/qa/lock'],
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [message, data] = logger.warn.mock.calls[0];
    expect(data).toEqual({ users: 1, domains: 1, paths: 1 });
    const logged = JSON.stringify([message, data]);
    for (const leaked of ['UAPPROVED1', 'uleaked1', 'leaked.example', 'qa.example', '/srv/qa', '/tmp', file]) {
      expect(logged).not.toContain(leaked);
    }
  });

  it('drops a configured path that resolves elsewhere: a symlink, or under a symlinked parent', () => {
    const native = fs.realpathSync.native;
    const lstat = fs.lstatSync;
    const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    // A fake `/srv`: `/srv/qa` is a symlink to another directory, so
    // `/srv/qa/lock` resolves elsewhere and `/srv/qa/runs` (absent) sits under a
    // symlinked parent; `/srv/ok/lock` is absent under a real `/srv`.
    const realpaths: Record<string, string | null> = {
      '/srv/qa/lock': '/data/qa/lock',
      '/srv/qa/runs': null,
      '/srv/ok/lock': null,
      '/srv': '/srv',
    };
    const kinds: Record<string, 'dir' | 'symlink' | null> = {
      '/srv': 'dir',
      '/srv/qa': 'symlink',
      '/srv/ok': null,
    };
    vi.spyOn(fs.realpathSync, 'native').mockImplementation(((target: fs.PathLike) => {
      const key = String(target);
      if (!(key in realpaths)) return native(target);
      const resolved = realpaths[key];
      if (resolved === null) throw enoent();
      return resolved;
    }) as typeof fs.realpathSync.native);
    vi.spyOn(fs, 'lstatSync').mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
      const key = String(target);
      if (!(key in kinds)) return (lstat as (...args: unknown[]) => fs.Stats)(target, ...rest);
      const kind = kinds[key];
      if (kind === null) throw enoent();
      return { isDirectory: () => kind === 'dir', isSymbolicLink: () => kind === 'symlink' } as fs.Stats;
    }) as typeof fs.lstatSync);

    const logger = makeLogger();
    const file = makeConfig({
      deploySandbox: { ...GRANT, allowWrite: ['/srv/qa/lock', '/srv/qa/runs', '/srv/ok/lock'] },
    });

    expect(loadDeploySandboxGrant(file, logger)?.allowWrite).toEqual(['/srv/ok/lock']);
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { users: 0, domains: 0, paths: 2 });
  });

  it('reads config.json on every call: an in-place edit is seen on the next call', () => {
    const file = makeConfig({ deploySandbox: { ...GRANT, users: ['UAPPROVED1'] } });
    const stamp = Math.floor(Date.now() / 1000) - 60;
    fs.utimesSync(file, stamp, stamp);
    const before = fs.statSync(file);
    expect(loadDeploySandboxGrant(file, makeLogger())?.users).toEqual(['UAPPROVED1']);

    // Same size, same inode, same mtime — invisible to any stat-keyed cache.
    writeConfig(file, { deploySandbox: { ...GRANT, users: ['WAPPROVED2'] } });
    fs.utimesSync(file, stamp, stamp);
    const after = fs.statSync(file);
    expect([after.size, after.ino, after.mtimeMs]).toEqual([before.size, before.ino, before.mtimeMs]);

    expect(loadDeploySandboxGrant(file, makeLogger())?.users).toEqual(['WAPPROVED2']);
  });

  it('sees a removed key on the next call (a deploy that revokes the grant)', () => {
    const file = makeConfig({ deploySandbox: GRANT });
    expect(loadDeploySandboxGrant(file, makeLogger())).toEqual(GRANT);

    writeConfig(file, { plugin: {} });
    expect(loadDeploySandboxGrant(file, makeLogger())).toBeNull();
  });

  it('sees config.json disappear and come back', () => {
    const file = makeConfig({ deploySandbox: GRANT });
    expect(loadDeploySandboxGrant(file, makeLogger())).toEqual(GRANT);

    fs.rmSync(file);
    expect(loadDeploySandboxGrant(file, makeLogger())).toBeNull();

    writeConfig(file, { deploySandbox: { ...GRANT, users: ['WAPPROVED2'] } });
    expect(loadDeploySandboxGrant(file, makeLogger())?.users).toEqual(['WAPPROVED2']);
  });
});
