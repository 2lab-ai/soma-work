/**
 * Tests for the user-facing text interface of hierarchical memory
 * (the Slack `memory pages|page|search|episodic|note|rmpage|help` surface).
 * Binds the in-process store singleton to a temp DATA_DIR via env-paths mock.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR } = vi.hoisted(() => {
  const os2 = require('node:os');
  const path2 = require('node:path');
  return { TEST_DATA_DIR: path2.join(os2.tmpdir(), `soma-hier-mem-display-${process.pid}`) };
});

vi.mock('../env-paths', () => ({ DATA_DIR: TEST_DATA_DIR }));

import {
  addUserNote,
  formatEpisodicForDisplay,
  formatMemoryHelp,
  formatPageForDisplay,
  formatPagesForDisplay,
  formatSearchForDisplay,
  hierarchicalMemoryStore,
  removeUserPage,
} from '../hierarchical-memory';

const user = 'U_display';

describe('hierarchical memory — user text interface', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  });
  afterEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it('formats an empty memory with guidance', () => {
    const out = formatPagesForDisplay(user);
    expect(out).toContain('비어있습니다');
    expect(out).toContain('memory help');
  });

  it('lists pages grouped by type after upsert', () => {
    hierarchicalMemoryStore.upsertPage(user, { type: 'agent', slug: 'build' }, { title: 'Build', current: 'bun' });
    hierarchicalMemoryStore.upsertPage(
      user,
      { type: 'project', project: 'soma', issue: '1' },
      { title: 'Issue 1', current: 'spec' },
    );
    const out = formatPagesForDisplay(user);
    expect(out).toContain('agent/build');
    expect(out).toContain('project/soma/1');
    expect(out).toContain('2개 페이지');
  });

  it('shows a page with Current + History', () => {
    hierarchicalMemoryStore.upsertPage(
      user,
      { type: 'agent', slug: 'build' },
      { title: 'Build', current: 'builds with bun', historyEntry: 'confirmed' },
    );
    const out = formatPageForDisplay(user, 'agent/build');
    expect(out).toContain('builds with bun');
    expect(out).toContain('Current');
    expect(out).toContain('History');
    expect(out).toContain('confirmed');
  });

  it('reports a missing page for an unknown or malformed id', () => {
    expect(formatPageForDisplay(user, 'agent/nope')).toContain('찾을 수 없');
    expect(formatPageForDisplay(user, 'notavalidid')).toContain('찾을 수 없');
  });

  it('searches pages', () => {
    hierarchicalMemoryStore.upsertPage(user, { type: 'sites', slug: 'danawa' }, { title: 'Danawa price' });
    expect(formatSearchForDisplay(user, 'price')).toContain('sites/danawa');
    expect(formatSearchForDisplay(user, 'zzz')).toContain('결과 없음');
  });

  it('adds and reads episodic notes', () => {
    const res = addUserNote(user, 'a user note');
    expect(res.ok).toBe(true);
    const today = new Date().toISOString().slice(0, 10);
    expect(formatEpisodicForDisplay(user, today)).toContain('a user note');
    expect(formatEpisodicForDisplay(user, '2000-01-01')).toContain('기록 없음');
    expect(formatEpisodicForDisplay(user, 'bad-date')).toContain('YYYY-MM-DD');
  });

  it('removes a page', () => {
    hierarchicalMemoryStore.upsertPage(user, { type: 'concepts', slug: 'x' }, { current: 'c' });
    expect(removeUserPage(user, 'concepts/x').ok).toBe(true);
    expect(formatPageForDisplay(user, 'concepts/x')).toContain('찾을 수 없');
    expect(removeUserPage(user, 'concepts/x').ok).toBe(false); // already gone
  });

  it('help lists both L1 and hierarchical verbs', () => {
    const help = formatMemoryHelp();
    expect(help).toContain('memory pages');
    expect(help).toContain('memory note');
    expect(help).toContain('memory save');
  });
});
