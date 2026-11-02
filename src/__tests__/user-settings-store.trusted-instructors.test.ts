import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { MAX_TRUSTED_INSTRUCTORS, UserSettingsStore } from '../user-settings-store';

/**
 * #767 T4 — "해당 사람의 지시 항상 승인 (개인 설정에서 항상 승인할 유저 정보 리스트로
 * 설정에서 저장하고 대시보드 설정에서 삭제할 수 있어야함)": the owner's list of
 * people whose instructions run in the owner's work threads without asking.
 */

function makeStore(dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uss-trusted-'))): {
  store: UserSettingsStore;
  dir: string;
} {
  return { store: new UserSettingsStore(dir), dir };
}

describe('UserSettingsStore — trusted instructors (#767)', () => {
  it('is empty by default', () => {
    const { store } = makeStore();
    expect(store.getUserTrustedInstructors('U_OWNER')).toEqual([]);
    expect(store.isUserTrustedInstructor('U_OWNER', 'U_OTHER')).toBe(false);
  });

  it('adds a person once, with their name and when, and saves it', () => {
    const { store, dir } = makeStore();
    expect(store.addUserTrustedInstructor('U_OWNER', { userId: 'U_OTHER', name: 'Other' })).toBe(true);
    expect(store.addUserTrustedInstructor('U_OWNER', { userId: 'U_OTHER', name: 'Other again' })).toBe(false);
    const list = store.getUserTrustedInstructors('U_OWNER');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ userId: 'U_OTHER', name: 'Other' });
    expect(typeof list[0].addedAt).toBe('number');
    expect(store.isUserTrustedInstructor('U_OWNER', 'U_OTHER')).toBe(true);
    // Per owner: someone else's list is untouched.
    expect(store.isUserTrustedInstructor('U_SOMEONE', 'U_OTHER')).toBe(false);
    // It survives a restart.
    const { store: reloaded } = makeStore(dir);
    expect(reloaded.isUserTrustedInstructor('U_OWNER', 'U_OTHER')).toBe(true);
  });

  it('removes people by replacing the list (the dashboard settings write)', () => {
    const { store } = makeStore();
    store.addUserTrustedInstructor('U_OWNER', { userId: 'U_A', name: 'A' });
    store.addUserTrustedInstructor('U_OWNER', { userId: 'U_B', name: 'B' });
    store.setUserTrustedInstructors(
      'U_OWNER',
      store.getUserTrustedInstructors('U_OWNER').filter((e) => e.userId !== 'U_A'),
    );
    expect(store.getUserTrustedInstructors('U_OWNER').map((e) => e.userId)).toEqual(['U_B']);
    expect(store.isUserTrustedInstructor('U_OWNER', 'U_A')).toBe(false);
  });

  it('never lists the owner themself, drops malformed entries and caps the list', () => {
    const { store } = makeStore();
    expect(store.addUserTrustedInstructor('U_OWNER', { userId: 'U_OWNER' })).toBe(false);
    store.setUserTrustedInstructors('U_OWNER', [
      { userId: 'U_A', addedAt: 1 },
      { userId: '', addedAt: 2 } as any,
      { userId: 'U_A', addedAt: 3 },
      null as any,
    ]);
    expect(store.getUserTrustedInstructors('U_OWNER').map((e) => e.userId)).toEqual(['U_A']);
    for (let i = 0; i < MAX_TRUSTED_INSTRUCTORS + 5; i++)
      store.addUserTrustedInstructor('U_OWNER', { userId: `U_${i}` });
    expect(store.getUserTrustedInstructors('U_OWNER').length).toBe(MAX_TRUSTED_INSTRUCTORS);
  });
});
