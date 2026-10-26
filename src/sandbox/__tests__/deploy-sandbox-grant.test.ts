import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadDeploySandboxGrant, sanitizeDeploySandboxGrant } from '../deploy-sandbox-grant';
import { isGrantDomain, isGrantPath, isSlackUserId } from '../deploy-sandbox-rules';
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
  allowedDomains: ['qa.example.test', '*.qa.example.test'],
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
      allowedDomains: ['qa.example.test', 'https://qa.example.test', '10.0.0.1', 'qa.example.test'],
      allowWrite: ['/srv/qa/lock', '/tmp/qa', '/srv/qa/../lock', '/'],
    });

    expect(result.grant).toEqual({
      users: ['UAPPROVED1'],
      allowedDomains: ['qa.example.test'],
      allowWrite: ['/srv/qa/lock'],
    });
    expect(result.dropped).toEqual({ users: 2, domains: 2, paths: 3 });
    expect(result.malformed).toBe(false);
  });

  it('counts a list that is not an array as one dropped entry', () => {
    const result = sanitizeDeploySandboxGrant({ users: 'UAPPROVED1', allowedDomains: [], allowWrite: ['/srv/qa'] });
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
    expect(sanitizeDeploySandboxGrant({ users: ['UAPPROVED1'], allowWrite: ['/srv/qa'] }).grant).toEqual({
      users: ['UAPPROVED1'],
      allowedDomains: [],
      allowWrite: ['/srv/qa'],
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
  // Strictly increasing whole-second mtimes: a coarse-mtime filesystem can give
  // two quick writes the same stamp, which is exactly what the cache keys on.
  let clock = Math.floor(Date.now() / 1000) - 10_000;

  function makeConfig(content: unknown): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-sandbox-grant-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'config.json');
    writeConfig(file, content);
    return file;
  }

  function writeConfig(file: string, content: unknown, mtime = ++clock): void {
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
    fs.utimesSync(file, mtime, mtime);
  }

  function makeLogger() {
    return { warn: vi.fn() };
  }

  afterEach(() => {
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
        allowWrite: ['/srv/qa/lock', '/tmp/leaked'],
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

  it('caches by mtime: an unchanged file is not re-read, and the warning is not repeated', () => {
    const logger = makeLogger();
    const readSpy = vi.spyOn(fs, 'readFileSync');
    try {
      const file = makeConfig({ deploySandbox: { ...GRANT, users: ['UAPPROVED1', 'BAD'] } });
      const reads = () => readSpy.mock.calls.filter(([target]) => target === file).length;
      const stamp = fs.statSync(file).mtimeMs;
      expect(loadDeploySandboxGrant(file, logger)?.users).toEqual(['UAPPROVED1']);
      expect(loadDeploySandboxGrant(file, logger)?.users).toEqual(['UAPPROVED1']);
      expect(reads()).toBe(1);

      // Rewritten in place with the same mtime and size (same inode): the cache
      // cannot tell, so it is not re-read and the warning is not repeated.
      writeConfig(file, { deploySandbox: { ...GRANT, users: ['WAPPROVED2', 'BAD'] } }, stamp / 1000);
      expect(loadDeploySandboxGrant(file, logger)?.users).toEqual(['UAPPROVED1']);
      expect(reads()).toBe(1);
      expect(logger.warn).toHaveBeenCalledTimes(1);

      // A new mtime → re-read.
      writeConfig(file, { deploySandbox: { ...GRANT, users: ['WAPPROVED2', 'BAD'] } });
      expect(loadDeploySandboxGrant(file, logger)?.users).toEqual(['WAPPROVED2']);
      expect(reads()).toBe(2);
    } finally {
      readSpy.mockRestore();
    }
  });

  it('re-reads a same-mtime rewrite that changed the size or the inode', () => {
    const file = makeConfig({ deploySandbox: GRANT });
    const stamp = fs.statSync(file).mtimeMs / 1000;
    expect(loadDeploySandboxGrant(file, makeLogger())?.users).toEqual(['UAPPROVED1']);

    writeConfig(file, { deploySandbox: { ...GRANT, users: ['WAPPROVED2', 'UAPPROVED1'] } }, stamp);
    expect(loadDeploySandboxGrant(file, makeLogger())?.users).toEqual(['WAPPROVED2', 'UAPPROVED1']);

    // Same size and mtime, new inode — what the deploy writer's rename produces.
    const tmp = `${file}.next`;
    fs.writeFileSync(tmp, JSON.stringify({ deploySandbox: { ...GRANT, users: ['UAPPROVED1', 'WAPPROVED2'] } }));
    fs.utimesSync(tmp, stamp, stamp);
    fs.renameSync(tmp, file);
    expect(loadDeploySandboxGrant(file, makeLogger())?.users).toEqual(['UAPPROVED1', 'WAPPROVED2']);
  });

  it('sees a removed key on the next mtime (a deploy that revokes the grant)', () => {
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

  it('answers per file when more than one config.json is read', () => {
    const first = makeConfig({ deploySandbox: GRANT });
    const second = makeConfig({ deploySandbox: { ...GRANT, users: ['WAPPROVED2'] } });

    expect(loadDeploySandboxGrant(first, makeLogger())?.users).toEqual(['UAPPROVED1']);
    expect(loadDeploySandboxGrant(second, makeLogger())?.users).toEqual(['WAPPROVED2']);
    expect(loadDeploySandboxGrant(first, makeLogger())?.users).toEqual(['UAPPROVED1']);
  });
});
