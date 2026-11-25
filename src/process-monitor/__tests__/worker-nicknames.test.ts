import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_WORKER_NICKNAME,
  parseWorkerNickname,
  setActiveWorkerNicknames,
  WORKER_NICKNAMES_FILE,
  WorkerNicknames,
  workerNameOf,
} from '../worker-nicknames';

describe('WorkerNicknames — the name a work worker is read by', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-nicknames-'));
  });
  afterEach(() => {
    setActiveWorkerNicknames(undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('none by default; a nickname is set, replaced and cleared back to the node id', () => {
    const names = new WorkerNicknames(dir);
    expect(names.nicknameOf('studio-build-01')).toBeUndefined();
    names.set('studio-build-01', 'b01');
    expect(names.nicknameOf('studio-build-01')).toBe('b01');
    names.set('studio-build-01', 'build');
    expect(names.nicknameOf('studio-build-01')).toBe('build');
    names.set('studio-build-01', undefined);
    expect(names.nicknameOf('studio-build-01')).toBeUndefined();
  });

  it('keeps nicknames on disk and reads them back; drops what does not parse', () => {
    new WorkerNicknames(dir).set('node-a', 'a');
    expect(new WorkerNicknames(dir).nicknameOf('node-a')).toBe('a');
    fs.writeFileSync(
      path.join(dir, WORKER_NICKNAMES_FILE),
      JSON.stringify({ version: 1, nicknames: { 'node-a': '', 'node-b': 'b', 'node-c': 7 } }),
    );
    const names = new WorkerNicknames(dir);
    expect(names.nicknameOf('node-a')).toBeUndefined();
    expect(names.nicknameOf('node-b')).toBe('b');
    expect(names.nicknameOf('node-c')).toBeUndefined();
  });

  it('an unreadable file is never taken for an empty one: node ids show and nothing overwrites it', () => {
    const file = path.join(dir, WORKER_NICKNAMES_FILE);
    fs.writeFileSync(file, '{not json');
    const names = new WorkerNicknames(dir);
    expect(names.nicknameOf('node-a')).toBeUndefined();
    expect(() => names.set('node-a', 'a')).toThrow(/unreadable/);
    expect(fs.readFileSync(file, 'utf8')).toBe('{not json');
  });

  it('a node id that names an Object.prototype member is just a node without a nickname', () => {
    const names = new WorkerNicknames(dir);
    expect(names.nicknameOf('constructor')).toBeUndefined();
    expect(names.nicknameOf('__proto__')).toBeUndefined();
  });

  it('parses what the page sends: trimmed, 1–24 characters, no control characters', () => {
    expect(parseWorkerNickname('  m5  ')).toBe('m5');
    expect(parseWorkerNickname('빌드 서버')).toBe('빌드 서버');
    expect(parseWorkerNickname('x'.repeat(MAX_WORKER_NICKNAME))).toBe('x'.repeat(MAX_WORKER_NICKNAME));
    // Characters, not UTF-16 units: 24 emoji fit.
    expect(parseWorkerNickname('🖥'.repeat(MAX_WORKER_NICKNAME))).toBe('🖥'.repeat(MAX_WORKER_NICKNAME));
    for (const bad of ['', '   ', 'x'.repeat(MAX_WORKER_NICKNAME + 1), 'a\nb', 'a\u0007b', 'a b', null, 7, {}]) {
      expect(parseWorkerNickname(bad)).toBeUndefined();
    }
  });

  it('workerNameOf: the active nickname, else the node id', () => {
    expect(workerNameOf('node-a')).toBe('node-a');
    const names = new WorkerNicknames(dir);
    setActiveWorkerNicknames(names);
    expect(workerNameOf('node-a')).toBe('node-a');
    names.set('node-a', 'a');
    expect(workerNameOf('node-a')).toBe('a');
  });
});
