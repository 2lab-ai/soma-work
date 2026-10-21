import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_AUTOSKILLS, UserSettingsStore } from '../user-settings-store';

function makeStore(): UserSettingsStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoskill-test-'));
  return new UserSettingsStore(dir);
}

const U = 'U_AUTOSKILL';

describe('UserSettingsStore — autoskills', () => {
  let store: UserSettingsStore;

  beforeEach(() => {
    store = makeStore();
  });

  it('defaults to an empty list', () => {
    expect(store.getUserAutoskills(U)).toEqual([]);
  });

  it('set + get round-trips', () => {
    store.setUserAutoskills(U, ['using-ssot', 'using-govuk']);
    expect(store.getUserAutoskills(U)).toEqual(['using-ssot', 'using-govuk']);
  });

  it('returns a defensive copy (caller mutation does not leak)', () => {
    store.setUserAutoskills(U, ['a']);
    const got = store.getUserAutoskills(U);
    got.push('b');
    expect(store.getUserAutoskills(U)).toEqual(['a']);
  });

  it('de-dups while preserving order on set', () => {
    store.setUserAutoskills(U, ['a', 'b', 'a', 'c', 'b']);
    expect(store.getUserAutoskills(U)).toEqual(['a', 'b', 'c']);
  });

  it('drops blank / whitespace-only entries', () => {
    store.setUserAutoskills(U, ['a', '', '  ', 'b']);
    expect(store.getUserAutoskills(U)).toEqual(['a', 'b']);
  });

  it('caps at MAX_AUTOSKILLS', () => {
    const many = Array.from({ length: MAX_AUTOSKILLS + 5 }, (_, i) => `skill-${i}`);
    store.setUserAutoskills(U, many);
    expect(store.getUserAutoskills(U)).toHaveLength(MAX_AUTOSKILLS);
  });

  describe('addUserAutoskill', () => {
    it('adds a new skill and returns true', () => {
      expect(store.addUserAutoskill(U, 'a')).toBe(true);
      expect(store.getUserAutoskills(U)).toEqual(['a']);
    });

    it('is a no-op (false) when already present', () => {
      store.setUserAutoskills(U, ['a']);
      expect(store.addUserAutoskill(U, 'a')).toBe(false);
      expect(store.getUserAutoskills(U)).toEqual(['a']);
    });

    it('refuses to add past the cap (false)', () => {
      store.setUserAutoskills(
        U,
        Array.from({ length: MAX_AUTOSKILLS }, (_, i) => `s${i}`),
      );
      expect(store.addUserAutoskill(U, 'overflow')).toBe(false);
      expect(store.getUserAutoskills(U)).toHaveLength(MAX_AUTOSKILLS);
    });
  });

  describe('removeUserAutoskill', () => {
    it('removes a present skill and returns true', () => {
      store.setUserAutoskills(U, ['a', 'b', 'c']);
      expect(store.removeUserAutoskill(U, 'b')).toBe(true);
      expect(store.getUserAutoskills(U)).toEqual(['a', 'c']);
    });

    it('is a no-op (false) when absent', () => {
      store.setUserAutoskills(U, ['a']);
      expect(store.removeUserAutoskill(U, 'zzz')).toBe(false);
      expect(store.getUserAutoskills(U)).toEqual(['a']);
    });
  });

  it('persists across store reloads (same data dir)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoskill-persist-'));
    const s1 = new UserSettingsStore(dir);
    s1.setUserAutoskills(U, ['x', 'y']);
    const s2 = new UserSettingsStore(dir);
    expect(s2.getUserAutoskills(U)).toEqual(['x', 'y']);
  });
});
