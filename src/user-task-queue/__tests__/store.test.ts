import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyLedger } from '../ledger';
import {
  createUserTaskQueueStore,
  parseTaskLimitSetting,
  USER_TASK_LIMITS_FILE,
  USER_TASK_QUEUE_FILE,
  UserTaskLimits,
} from '../store';
import { UNLIMITED } from '../user-task-queue';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'utq-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('createUserTaskQueueStore', () => {
  it('a new store loads nothing; a saved ledger loads back', () => {
    const store = createUserTaskQueueStore(dir);
    expect(store.load()).toBeUndefined();
    const ledger = {
      ...emptyLedger(),
      entries: [
        {
          id: 'a',
          userId: 'U1',
          kind: 'request' as const,
          sessionKey: 'C1:1',
          channel: 'C1',
          threadTs: '1',
          preview: 'p',
          enqueuedAt: 1,
          state: 'waiting' as const,
        },
      ],
    };
    store.save(ledger);
    expect(createUserTaskQueueStore(dir).load()).toEqual(ledger);
  });

  it('an unreadable file is never taken for empty, and is not overwritten', () => {
    const file = path.join(dir, USER_TASK_QUEUE_FILE);
    fs.writeFileSync(file, '{ not json');
    const store = createUserTaskQueueStore(dir);
    expect(store.load()).toBeUndefined();
    store.save(emptyLedger());
    expect(fs.readFileSync(file, 'utf-8')).toBe('{ not json');
  });
});

describe('UserTaskLimits', () => {
  const isAdmin = (u: string) => u === 'UADMIN';

  it('defaults: 1 for a person, no limit for an admin', () => {
    const limits = new UserTaskLimits(dir, isAdmin);
    expect(limits.limitFor('U1')).toBe(1);
    expect(limits.limitFor('UADMIN')).toBe(UNLIMITED);
    expect(limits.settingFor('U1')).toBeUndefined();
  });

  it('an admin setting wins, survives a restart, and clears back to the default', () => {
    const limits = new UserTaskLimits(dir, isAdmin);
    limits.set('U1', 3);
    limits.set('UADMIN', 2);
    limits.set('U2', 'unlimited');
    const again = new UserTaskLimits(dir, isAdmin);
    expect(again.limitFor('U1')).toBe(3);
    expect(again.limitFor('UADMIN')).toBe(2);
    expect(again.limitFor('U2')).toBe(UNLIMITED);
    again.set('U1', undefined);
    expect(new UserTaskLimits(dir, isAdmin).limitFor('U1')).toBe(1);
    expect(again.all()).toEqual({ UADMIN: 2, U2: 'unlimited' });
  });

  it('refuses to overwrite a limits file it could not read', () => {
    const file = path.join(dir, USER_TASK_LIMITS_FILE);
    fs.writeFileSync(file, 'garbage');
    const limits = new UserTaskLimits(dir, isAdmin);
    expect(limits.limitFor('U1')).toBe(1);
    expect(() => limits.set('U1', 2)).toThrow(/unreadable/);
    expect(fs.readFileSync(file, 'utf-8')).toBe('garbage');
  });

  it('the knob sends 1..10 or unlimited; nothing else is a limit', () => {
    expect(parseTaskLimitSetting(1)).toBe(1);
    expect(parseTaskLimitSetting(10)).toBe(10);
    expect(parseTaskLimitSetting('unlimited')).toBe('unlimited');
    for (const bad of [0, 11, 1.5, -1, '2', null, undefined, {}]) expect(parseTaskLimitSetting(bad)).toBeUndefined();
  });
});
