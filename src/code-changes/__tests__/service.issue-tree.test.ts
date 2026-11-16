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
        rel: { closes: ['https://github.com/acme/web/issues/9'], base: null },
        onlyIfPresent: true,
      },
    ]);
    expect(fetchIssue).toHaveBeenCalledWith('acme', 'web', 9);
    expect(note.mock.calls[1][1]).toEqual([
      expect.objectContaining({
        kind: 'issue',
        url: 'https://github.com/acme/web/issues/9',
        title: 'login',
        status: 'open',
        onlyIfPresent: true,
      }),
    ]);
    // The PR relations reach the card with the collect's own push; the issues read after it push it again.
    expect(calls).toEqual(['note:pull/3', 'push', 'note:issues/9', 'push']);
  });

  function harness(opts: {
    body?: () => string;
    fetchIssue: (o: string, r: string, n: number) => Promise<{ title?: string; state?: string } | undefined>;
  }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-tree-'));
    roots.push(dir);
    const session: SessionLike = {
      conversationId: 'conv1',
      startedAt: Date.parse('2026-11-16T00:00:00Z'),
      sessionWorkingDir: '/tmp/x/session_1794756694405_a',
      links: { pr: { url: 'https://github.com/acme/web/pull/3' } },
    };
    const sessions = new Map<string, SessionLike>([['k1', session]]);
    const note = vi.fn((_k: string, _entries: ReadonlyArray<{ url: string; rel?: unknown }>) => true);
    const pushCard = vi.fn();
    const fetchPullFiles = vi.fn(async () => ({
      files: [
        { filename: 'a.ts', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: '@@ -1 +1 @@\n+x' },
      ],
      truncated: false,
    }));
    const svc = createCodeChangesService({
      getSessionByKey: (k) => sessions.get(k),
      allSessions: () => sessions.entries(),
      persist: () => {},
      pushCard,
      store: new CodeChangesStore(dir),
      issueTree: { note, toCheck: () => ['https://github.com/acme/web/issues/9'] },
      fetchIssue: opts.fetchIssue,
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
          body: opts.body ? opts.body() : 'Closes #9',
        }),
        fetchPullFiles,
        now: () => 7,
      },
      scheduler: { delayMs: 0, minIntervalMs: 0 },
    });
    return { svc, sessions, session, note, pushCard, fetchPullFiles };
  }

  it('an issue read that lands after the session was replaced (or ended) notes nothing and pushes nothing', async () => {
    let answer!: (v: { title: string; state: string }) => void;
    const fetchIssue = vi.fn(() => new Promise<{ title: string; state: string }>((r) => (answer = r)));
    const h = harness({ fetchIssue });
    await h.svc.refresh('conv1');
    await flush();
    expect(fetchIssue).toHaveBeenCalledTimes(1);
    const notesBefore = h.note.mock.calls.length;
    const pushesBefore = h.pushCard.mock.calls.length;
    h.sessions.set('k1', { ...h.session }); // a new session under the same key
    answer({ title: 'late', state: 'open' });
    await flush();
    await flush();
    expect(h.note.mock.calls.length).toBe(notesBefore);
    expect(h.pushCard.mock.calls.length).toBe(pushesBefore);

    let answer2!: (v: { title: string; state: string }) => void;
    const fetch2 = vi.fn(() => new Promise<{ title: string; state: string }>((r) => (answer2 = r)));
    const ended = harness({ fetchIssue: fetch2 });
    await ended.svc.refresh('conv1');
    await flush();
    const n2 = ended.note.mock.calls.length;
    ended.session.terminated = true;
    answer2({ title: 'late', state: 'open' });
    await flush();
    await flush();
    expect(ended.note.mock.calls.length).toBe(n2);
  });

  it('one batch of issue reads at a time per session: a collect while one is under way does not ask again', async () => {
    let answer!: (v: { title: string; state: string }) => void;
    const fetchIssue = vi.fn(() => new Promise<{ title: string; state: string }>((r) => (answer = r)));
    const h = harness({ fetchIssue });
    await h.svc.refresh('conv1');
    await flush();
    await h.svc.refresh('conv1');
    await flush();
    expect(fetchIssue).toHaveBeenCalledTimes(1);
    answer({ title: 'login', state: 'open' });
    await flush();
    await flush();
    // Done: the next collect may read again.
    await h.svc.refresh('conv1');
    await flush();
    expect(fetchIssue).toHaveBeenCalledTimes(2);
  });

  it('a body edited between collects (same head and base): the files are reused, the closing refs are read again', async () => {
    let body = 'Closes #9';
    const h = harness({ body: () => body, fetchIssue: async () => ({ state: 'open' }) });
    await h.svc.refresh('conv1');
    await flush();
    const prNote = (i: number) =>
      h.note.mock.calls.filter((c) => c[1][0]?.url.includes('/pull/'))[i]?.[1][0] as { rel?: unknown };
    expect(prNote(0).rel).toEqual({ closes: ['https://github.com/acme/web/issues/9'], base: null });
    body = 'A summary.\n\nCloses #10';
    await h.svc.refresh('conv1');
    await flush();
    expect(prNote(1).rel).toEqual({ closes: ['https://github.com/acme/web/issues/10'], base: null });
    body = 'No refs any more.';
    await h.svc.refresh('conv1');
    await flush();
    expect(prNote(2).rel).toEqual({ closes: [], base: null });
    // The files were listed once: the head and base held, so the stored files were reused.
    expect(h.fetchPullFiles).toHaveBeenCalledTimes(1);
  });
});
