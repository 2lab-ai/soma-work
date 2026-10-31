/**
 * E4 ④b — a child's folder (.prd/19 D4): a sub-path of the epic's real
 * folder, never out of it; overlap by whole path segments.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChildFolderError, foldersOverlap, resolveChildFolder } from '../epic-child-folder';

const OWNER = `UEPICF${process.pid}`;
const ROOT = `/tmp/${OWNER}`;
const EPIC = `${ROOT}/epic_1`;
const OUTSIDE = `/tmp/${OWNER}_outside`;

beforeAll(() => {
  fs.mkdirSync(`${EPIC}/work/a`, { recursive: true });
  fs.mkdirSync(`${ROOT}/sibling`, { recursive: true });
  fs.mkdirSync(OUTSIDE, { recursive: true });
  fs.symlinkSync(`${ROOT}/sibling`, `${EPIC}/link-out`);
  fs.symlinkSync(OUTSIDE, `${EPIC}/link-far`);
  fs.symlinkSync(`${EPIC}/work`, `${EPIC}/link-in`);
});
afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(OUTSIDE, { recursive: true, force: true });
});

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof ChildFolderError ? e.code : `other: ${(e as Error).message}`;
  }
  return 'no throw';
};

describe('resolveChildFolder (D4)', () => {
  it('a sub-path of the epic’s folder, existing or not yet made', () => {
    expect(resolveChildFolder(OWNER, EPIC, 'work/a')).toBe(`${EPIC}/work/a`);
    expect(resolveChildFolder(OWNER, EPIC, 'new/child')).toBe(`${EPIC}/new/child`);
    // A link that stays inside the epic's folder resolves to where it leads.
    expect(resolveChildFolder(OWNER, EPIC, 'link-in/a')).toBe(`${EPIC}/work/a`);
  });

  it('refuses ., .., an absolute path, an empty part, and the epic’s own folder', () => {
    for (const bad of ['', '.', '..', '../sibling', 'work/../..', '/tmp/x', 'work//a', 'work/./a']) {
      expect(
        code(() => resolveChildFolder(OWNER, EPIC, bad)),
        bad,
      ).toBe('bad-folder');
    }
  });

  it('refuses a link out of the epic’s folder — to a sibling, or out of the owner’s root', () => {
    expect(code(() => resolveChildFolder(OWNER, EPIC, 'link-out'))).toBe('outside-epic');
    expect(code(() => resolveChildFolder(OWNER, EPIC, 'link-out/deeper'))).toBe('outside-epic');
    expect(code(() => resolveChildFolder(OWNER, EPIC, 'link-far'))).toBe('outside-epic');
  });
});

describe('foldersOverlap (D4)', () => {
  it('the same folder, or one holding the other — by whole path segments', () => {
    expect(foldersOverlap('/tmp/U/session_1', '/tmp/U/session_1')).toBe(true);
    expect(foldersOverlap('/tmp/U/session_1', '/tmp/U/session_1/a')).toBe(true);
    expect(foldersOverlap('/tmp/U/session_1/a', '/tmp/U/session_1')).toBe(true);
    expect(foldersOverlap('/tmp/U/session_1', '/tmp/U/session_10')).toBe(false);
    expect(foldersOverlap('/tmp/U/a/b', '/tmp/U/a/c')).toBe(false);
  });
});
