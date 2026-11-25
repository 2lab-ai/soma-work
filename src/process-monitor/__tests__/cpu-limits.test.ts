import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '../../logger';
import { DEFAULT_CPU_CAP, parseCpuCapSetting, USER_CPU_LIMITS_FILE, UserCpuLimits } from '../cpu-limits';

describe('UserCpuLimits — the CPU cap on one of a person’s tasks', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpu-limits-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const isAdmin = (id: string) => id === 'U_ADMIN';

  it('100% (one core) by default, none for an admin; a setting wins either way', () => {
    const caps = new UserCpuLimits(dir, isAdmin);
    expect(DEFAULT_CPU_CAP).toBe(100);
    expect(caps.capFor('U1')).toBe(100);
    expect(caps.capFor('U_ADMIN')).toBeNull();
    caps.set('U1', 400);
    caps.set('U_ADMIN', 200);
    expect(caps.capFor('U1')).toBe(400);
    expect(caps.capFor('U_ADMIN')).toBe(200);
    caps.set('U1', 'unlimited');
    expect(caps.capFor('U1')).toBeNull();
    caps.set('U1', undefined);
    expect(caps.capFor('U1')).toBe(100);
    expect(caps.settingFor('U1')).toBeUndefined();
  });

  it('keeps settings on disk and reads them back; drops what does not parse', () => {
    new UserCpuLimits(dir, isAdmin).set('U1', 200);
    expect(new UserCpuLimits(dir, isAdmin).capFor('U1')).toBe(200);
    fs.writeFileSync(
      path.join(dir, USER_CPU_LIMITS_FILE),
      JSON.stringify({ version: 1, limits: { U1: 'lots', U2: 800 } }),
    );
    const caps = new UserCpuLimits(dir, isAdmin);
    expect(caps.capFor('U1')).toBe(100);
    expect(caps.capFor('U2')).toBe(800);
  });

  it('says which people’s saved caps it could not read (a valid file with a bad entry is not silent)', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      fs.writeFileSync(
        path.join(dir, USER_CPU_LIMITS_FILE),
        JSON.stringify({ version: 1, limits: { U1: 'lots', U2: 800, U3: 7 } }),
      );
      const caps = new UserCpuLimits(dir, isAdmin);
      expect(caps.capFor('U2')).toBe(800);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('could not read'),
        expect.objectContaining({ userIds: ['U1', 'U3'] }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('a save that fails keeps the cap that is enforced', () => {
    const caps = new UserCpuLimits(dir, isAdmin);
    caps.set('U1', 200);
    // The data directory goes read-only: the write fails.
    fs.chmodSync(dir, 0o500);
    try {
      expect(() => caps.set('U1', 400)).toThrow();
      expect(caps.capFor('U1')).toBe(200);
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  });

  it('an unreadable file is never taken for an empty one: defaults apply and nothing overwrites it', () => {
    const file = path.join(dir, USER_CPU_LIMITS_FILE);
    fs.writeFileSync(file, '{not json');
    const caps = new UserCpuLimits(dir, isAdmin);
    expect(caps.capFor('U1')).toBe(100);
    expect(() => caps.set('U1', 200)).toThrow(/unreadable/);
    expect(fs.readFileSync(file, 'utf8')).toBe('{not json');
  });

  it('parses what the page sends: an integer percent 25–6400 or unlimited', () => {
    expect([25, 100, 6400, 'unlimited'].map(parseCpuCapSetting)).toEqual([25, 100, 6400, 'unlimited']);
    expect([24, 6401, 50.5, '100', null, true].map(parseCpuCapSetting)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });
});
