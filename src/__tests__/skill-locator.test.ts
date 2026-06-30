import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Fixed roots so path assertions are deterministic. LOCAL_SKILLS_DIR is derived
// from the module's __dirname at import time, so it is matched by the
// `local/skills` substring rather than an exact absolute path.
vi.mock('../env-paths', () => ({
  DATA_DIR: '/data',
  PLUGINS_DIR: '/plugins',
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
}));

import * as fs from 'node:fs';
import { autoskillExists, listAvailableSkills, resolveAutoskillContent } from '../skill-locator';

function dirent(name: string, isDir = true): any {
  return { name, isDirectory: () => isDir, isFile: () => !isDir };
}

const LOCAL = (p: string) => p.includes('local') && p.includes('skills') && !p.includes('/data/');

describe('resolveAutoskillContent — fallback order', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.clearAllMocks());

  it('user namespace wins over local', () => {
    vi.mocked(fs.existsSync).mockImplementation((p: any) => String(p).includes('/data/U1/skills/using-ssot/'));
    vi.mocked(fs.readFileSync).mockReturnValue('USER BODY' as any);
    const r = resolveAutoskillContent('using-ssot', 'U1');
    expect(r).toEqual({ key: 'user:using-ssot', content: 'USER BODY' });
  });

  it('falls back to local when no user skill', () => {
    vi.mocked(fs.existsSync).mockImplementation((p: any) => LOCAL(String(p)) && String(p).includes('using-ssot'));
    vi.mocked(fs.readFileSync).mockReturnValue('LOCAL BODY' as any);
    const r = resolveAutoskillContent('using-ssot', 'U1');
    expect(r).toEqual({ key: 'local:using-ssot', content: 'LOCAL BODY' });
  });

  it('falls back to a priority plugin (stv)', () => {
    vi.mocked(fs.existsSync).mockImplementation((p: any) => String(p).includes('/plugins/stv/skills/new-task/'));
    vi.mocked(fs.readFileSync).mockReturnValue('STV BODY' as any);
    const r = resolveAutoskillContent('new-task', 'U1');
    expect(r).toEqual({ key: 'stv:new-task', content: 'STV BODY' });
  });

  it('returns null when nothing resolves', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readdirSync).mockReturnValue([] as any);
    expect(resolveAutoskillContent('ghost', 'U1')).toBeNull();
    expect(autoskillExists('ghost', 'U1')).toBe(false);
  });

  it('rejects unsafe names without touching the fs', () => {
    expect(resolveAutoskillContent('../etc/passwd', 'U1')).toBeNull();
  });
});

describe('listAvailableSkills', () => {
  beforeEach(() => vi.clearAllMocks());

  it('aggregates user + local skills, dedups by name (user wins), sorted', () => {
    vi.mocked(fs.readdirSync).mockImplementation((dir: any) => {
      const d = String(dir);
      if (d.includes('/data/U1/skills')) return [dirent('shared'), dirent('my-skill')] as any;
      if (LOCAL(d)) return [dirent('shared'), dirent('using-ssot')] as any;
      if (d === '/plugins') return [] as any;
      return [] as any;
    });
    // Every candidate SKILL.md "exists".
    vi.mocked(fs.existsSync).mockReturnValue(true);

    const list = listAvailableSkills('U1');
    const names = list.map((s) => s.name);
    expect(names).toEqual(['my-skill', 'shared', 'using-ssot']); // sorted, deduped

    const sources = Object.fromEntries(list.map((s) => [s.name, s.source]));
    expect(sources['my-skill']).toBe('user');
    expect(sources.shared).toBe('user'); // user wins the dedup
    expect(sources['using-ssot']).toBe('local');
  });
});
