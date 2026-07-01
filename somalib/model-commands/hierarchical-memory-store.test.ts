/**
 * Tests for the hierarchical (taxonomy-based) memory store.
 * Covers: semantic page CRUD across all categories, project→issue nesting,
 * episodic append, index/search, L1 location + legacy migration, and TAXONOMY
 * seeding.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HierarchicalMemoryFileStore,
  l1FilePath,
  legacyL1FilePath,
  migrateLegacyL1,
  memoryRoot,
} from './hierarchical-memory-store';

describe('HierarchicalMemoryFileStore', () => {
  let dataDir: string;
  let store: HierarchicalMemoryFileStore;
  const user = 'U_test_user';

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hier-memory-'));
    store = new HierarchicalMemoryFileStore(dataDir);
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('creates and reads an agent page with frontmatter + Current + History', () => {
    const res = store.upsertPage(user, { type: 'agent', slug: 'build-system' }, {
      title: 'Build system',
      aliases: ['build', 'bun'],
      current: 'Repo builds with bun.',
      historyEntry: 'Confirmed bun build.',
    });
    expect(res.ok).toBe(true);
    expect(res.id).toBe('agent/build-system');

    const onDisk = fs.readFileSync(path.join(memoryRoot(dataDir, user), 'agent', 'build-system.md'), 'utf-8');
    expect(onDisk).toContain('type: agent');
    expect(onDisk).toContain('## Current');
    expect(onDisk).toContain('Repo builds with bun.');
    expect(onDisk).toContain('## History');

    const page = store.getPage(user, { type: 'agent', slug: 'build-system' });
    expect(page?.title).toBe('Build system');
    expect(page?.aliases).toEqual(['build', 'bun']);
    expect(page?.current).toBe('Repo builds with bun.');
    expect(page?.history[0]).toContain('Confirmed bun build.');
  });

  it('updates Current and prepends History across upserts', () => {
    store.upsertPage(user, { type: 'agent', slug: 'p' }, { current: 'v1', historyEntry: 'first' });
    store.upsertPage(user, { type: 'agent', slug: 'p' }, { current: 'v2', historyEntry: 'second' });
    const page = store.getPage(user, { type: 'agent', slug: 'p' });
    expect(page?.current).toBe('v2');
    expect(page?.history[0]).toContain('second');
    expect(page?.history[1]).toContain('first');
  });

  it('stores project and project→issue pages at the right paths', () => {
    store.upsertPage(user, { type: 'project', project: 'soma-work' }, { current: 'Project notes' });
    store.upsertPage(user, { type: 'project', project: 'soma-work', issue: '1234' }, { current: 'Issue spec' });

    expect(fs.existsSync(path.join(memoryRoot(dataDir, user), 'projects', 'soma-work', 'MEMORY.md'))).toBe(true);
    expect(fs.existsSync(path.join(memoryRoot(dataDir, user), 'projects', 'soma-work', 'issues', '1234.md'))).toBe(true);

    expect(store.getPage(user, { type: 'project', project: 'soma-work' })?.current).toBe('Project notes');
    expect(store.getPage(user, { type: 'project', project: 'soma-work', issue: '1234' })?.current).toBe('Issue spec');
  });

  it('stores cron routine pages', () => {
    store.upsertPage(user, { type: 'cron', routine: 'daily-digest' }, { current: 'Runs at 9am.' });
    expect(fs.existsSync(path.join(memoryRoot(dataDir, user), 'cron', 'daily-digest', 'MEMORY.md'))).toBe(true);
    expect(store.getPage(user, { type: 'cron', routine: 'daily-digest' })?.current).toBe('Runs at 9am.');
  });

  it('appends episodic observations grouped by date', () => {
    const res = store.appendEpisodic(user, 'First observation', '2026-06-30');
    expect(res.ok).toBe(true);
    store.appendEpisodic(user, 'Second observation', '2026-06-30');
    const text = store.readEpisodic(user, '2026-06-30');
    expect(text).toContain('# 2026-06-30');
    expect(text).toContain('First observation');
    expect(text).toContain('Second observation');
    expect(store.recentEpisodicDates(user, 5)).toContain('2026-06-30');
  });

  it('writes the day header exactly once across many appends (race-safe)', () => {
    for (let i = 0; i < 5; i++) store.appendEpisodic(user, `obs ${i}`, '2026-06-30');
    const text = store.readEpisodic(user, '2026-06-30');
    expect(text.match(/^# 2026-06-30$/gm)?.length).toBe(1);
    for (let i = 0; i < 5; i++) expect(text).toContain(`obs ${i}`);
  });

  it('builds an index and searches by id/title/alias', () => {
    store.upsertPage(user, { type: 'agent', slug: 'build-system' }, { title: 'Build system', aliases: ['bun'] });
    store.upsertPage(user, { type: 'sites', slug: 'danawa' }, { title: 'Danawa price aggregator' });

    const index = store.readIndex(user);
    expect(index.entries.map((e) => e.id).sort()).toEqual(['agent/build-system', 'sites/danawa']);

    expect(store.search(user, 'bun').map((e) => e.id)).toEqual(['agent/build-system']);
    expect(store.search(user, 'price').map((e) => e.id)).toEqual(['sites/danawa']);
    expect(store.search(user, 'danawa').map((e) => e.id)).toEqual(['sites/danawa']);
  });

  it('removes a page and drops it from the index', () => {
    store.upsertPage(user, { type: 'concepts', slug: 'x' }, { current: 'c' });
    expect(store.search(user, 'x').length).toBe(1);
    const res = store.removePage(user, { type: 'concepts', slug: 'x' });
    expect(res.ok).toBe(true);
    expect(store.getPage(user, { type: 'concepts', slug: 'x' })).toBeNull();
    expect(store.readIndex(user).entries.length).toBe(0);
  });

  it('seeds TAXONOMY.md on first write only', () => {
    const taxPath = path.join(memoryRoot(dataDir, user), 'TAXONOMY.md');
    expect(fs.existsSync(taxPath)).toBe(false);
    store.appendEpisodic(user, 'obs');
    expect(fs.existsSync(taxPath)).toBe(true);
    const edited = '# Custom taxonomy';
    fs.writeFileSync(taxPath, edited, 'utf-8');
    store.upsertPage(user, { type: 'agent', slug: 'a' }, { current: 'c' });
    expect(fs.readFileSync(taxPath, 'utf-8')).toBe(edited); // not overwritten
  });

  it('rejects unsafe path segments', () => {
    expect(() => store.upsertPage(user, { type: 'agent', slug: '../escape' }, { current: 'x' })).toThrow();
    expect(() => store.upsertPage(user, { type: 'project', project: '../x', issue: 'y' }, {})).toThrow();
  });

  describe('L1 path + legacy migration', () => {
    it('resolves L1 under memory/', () => {
      expect(l1FilePath(dataDir, user, 'memory')).toBe(path.join(dataDir, user, 'memory', 'MEMORY.md'));
      expect(l1FilePath(dataDir, user, 'user')).toBe(path.join(dataDir, user, 'memory', 'USER.md'));
    });

    it('moves a legacy root-level L1 file into memory/ and DELETES the legacy file', () => {
      const legacy = legacyL1FilePath(dataDir, user, 'memory');
      fs.mkdirSync(path.dirname(legacy), { recursive: true });
      fs.writeFileSync(legacy, 'legacy memory content', 'utf-8');

      const migrated = migrateLegacyL1(dataDir, user, 'memory');
      expect(migrated).toBe(true);
      expect(fs.readFileSync(l1FilePath(dataDir, user, 'memory'), 'utf-8')).toBe('legacy memory content');
      // one-way migration: legacy root file removed so the two never coexist
      expect(fs.existsSync(legacy)).toBe(false);

      // idempotent: legacy gone → cheap no-op
      expect(migrateLegacyL1(dataDir, user, 'memory')).toBe(false);
    });

    it('deletes a stale legacy file when the new file already exists (resolves "mixed" state)', () => {
      const legacy = legacyL1FilePath(dataDir, user, 'user');
      const newPath = l1FilePath(dataDir, user, 'user');
      fs.mkdirSync(path.dirname(legacy), { recursive: true });
      fs.mkdirSync(path.dirname(newPath), { recursive: true });
      fs.writeFileSync(legacy, 'stale legacy profile', 'utf-8');
      fs.writeFileSync(newPath, 'current profile', 'utf-8');

      const migrated = migrateLegacyL1(dataDir, user, 'user');
      expect(migrated).toBe(true);
      // new is authoritative; legacy removed
      expect(fs.readFileSync(newPath, 'utf-8')).toBe('current profile');
      expect(fs.existsSync(legacy)).toBe(false);
    });

    it('preserves legacy content when the new file exists but is empty', () => {
      const legacy = legacyL1FilePath(dataDir, user, 'memory');
      const newPath = l1FilePath(dataDir, user, 'memory');
      fs.mkdirSync(path.dirname(legacy), { recursive: true });
      fs.mkdirSync(path.dirname(newPath), { recursive: true });
      fs.writeFileSync(legacy, 'real legacy content', 'utf-8');
      fs.writeFileSync(newPath, '   \n', 'utf-8'); // empty placeholder

      migrateLegacyL1(dataDir, user, 'memory');
      expect(fs.readFileSync(newPath, 'utf-8')).toBe('real legacy content');
      expect(fs.existsSync(legacy)).toBe(false);
    });

    it('does not migrate when no legacy file exists', () => {
      expect(migrateLegacyL1(dataDir, user, 'user')).toBe(false);
    });
  });
});
