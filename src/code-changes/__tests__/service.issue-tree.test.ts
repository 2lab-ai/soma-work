/**
 * .prd/29 §4 — a collect tells the session's issue tree what it learned: its PRs' titles, states, closing refs and
 * stacks (before the card is pushed), then its GitHub issues not read yet (title, state, parent), the card pushed again.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCodeChangesService, type SessionLike } from '../service';
import { CodeChangesStore } from '../store';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('code-changes service → issue tree', () => {
  it('notes the PR relations, then reads the unchecked issues and notes them', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-tree-'));
    roots.push(dir);
    const session: SessionLike = {
      conversationId: 'conv1',
      startedAt: Date.parse('2026-11-16T00:00:00Z'),
      sessionWorkingDir: '/tmp/x/session_1794756694405_a',
      links: { pr: { url: 'https://github.com/acme/web/pull/3' } },
    };
    const sessions = new Map([['k1', session]]);
    const calls: string[] = [];
    const note = vi.fn((_k: string, entries: ReadonlyArray<{ url: string }>) => {
      calls.push(`note:${entries.map((e) => e.url.split('/').slice(-2).join('/')).join(',')}`);
      return true;
    });
    const pushCard = vi.fn(() => calls.push('push'));
    const fetchIssue = vi.fn(async () => ({ title: 'login', state: 'open' }));
    const svc = createCodeChangesService({
      getSessionByKey: (k) => sessions.get(k),
      allSessions: () => sessions.entries(),
      persist: () => {},
      pushCard,
      store: new CodeChangesStore(dir),
      issueTree: { note, toCheck: () => ['https://github.com/acme/web/issues/9'] },
      fetchIssue,
      collect: {
        listCheckoutDirs: async () => ({ dirs: [] }),
        fetchPullDetail: async () => ({
          html_url: 'https://github.com/acme/web/pull/3',
          number: 3,
          title: 'Fix login',
          state: 'open',
          created_at: '2026-11-16T01:00:00Z',
          head_sha: 'a'.repeat(40),
          base_sha: 'b'.repeat(40),
          base_ref: 'main',
          body: 'Closes #9',
        }),
        fetchPullFiles: async () => ({ files: [], truncated: false }),
        now: () => 7,
      },
      scheduler: { delayMs: 0, minIntervalMs: 0 },
    });
    await svc.refresh('conv1');
    await flush();
    await flush();
    expect(note.mock.calls[0][1]).toEqual([
      {
        kind: 'pr',
        url: 'https://github.com/acme/web/pull/3',
        provider: 'github',
        title: 'Fix login',
        status: 'open',
        rel: { closes: ['https://github.com/acme/web/issues/9'] },
      },
    ]);
    expect(fetchIssue).toHaveBeenCalledWith('acme', 'web', 9);
    expect(note.mock.calls[1][1]).toEqual([
      expect.objectContaining({
        kind: 'issue',
        url: 'https://github.com/acme/web/issues/9',
        title: 'login',
        status: 'open',
      }),
    ]);
    // The PR relations reach the card with the collect's own push; the issues read after it push it again.
    expect(calls).toEqual(['note:pull/3', 'push', 'note:issues/9', 'push']);
  });
});
