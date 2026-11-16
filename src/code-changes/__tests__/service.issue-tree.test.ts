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
    const calls: string[] = [];
    const fetchIssue = vi.fn(async () => ({ title: 'login', state: 'open' }));
    const { svc, note, pushCard } = harness({ fetchIssue });
    note.mockImplementation((_k, entries) => {
      calls.push(`note:${entries.map((e) => e.url.split('/').slice(-2).join('/')).join(',')}`);
      return true;
    });
    pushCard.mockImplementation(() => calls.push('push'));
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
        relReadAt: 7, // when this collect's reads began (its clock)
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
    merged?: boolean;
    now?: () => number;
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
    const fetchPullDetail = vi.fn(async () => ({
      html_url: 'https://github.com/acme/web/pull/3',
      number: 3,
      title: 'Fix login',
      state: opts.merged ? 'closed' : 'open',
      ...(opts.merged ? { merged: true, merged_at: '2026-11-16T02:00:00Z' } : {}),
      created_at: '2026-11-16T01:00:00Z',
      head_sha: 'a'.repeat(40),
      base_sha: 'b'.repeat(40),
      base_ref: 'main',
      body: opts.body ? opts.body() : 'Closes #9',
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
        fetchPullDetail,
        fetchPullFiles,
        now: opts.now ?? (() => 7),
      },
      scheduler: { delayMs: 0, minIntervalMs: 0 },
    });
    return { svc, sessions, session, note, pushCard, fetchPullFiles, fetchPullDetail };
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

  it('a merged PR reused from the store replays its relations with its own older read time', async () => {
    let clock = 100;
    const h = harness({ merged: true, now: () => clock++, fetchIssue: async () => ({ state: 'open' }) });
    await h.svc.refresh('conv1');
    await flush();
    const prNotes = () => h.note.mock.calls.filter((c) => c[1][0]?.url.includes('/pull/')).map((c) => c[1][0]);
    const first = prNotes()[0] as { relReadAt?: number };
    expect(prNotes()[0]).toMatchObject({ status: 'merged', rel: { closes: ['https://github.com/acme/web/issues/9'] } });
    expect(first.relReadAt).toBeGreaterThanOrEqual(100); // when its detail read began, in this collect
    const reads = h.fetchPullDetail.mock.calls.length;
    const secondStart = clock; // the second collect begins at or after this
    await h.svc.refresh('conv1');
    await flush();
    // Not read again (merged, files whole): its relations come again, with the time of the read behind them — older
    // than this collect, so a newer read of the same relation (the reconciler's) is not replaced; a node recreated
    // since gets them back.
    expect(h.fetchPullDetail.mock.calls.length).toBe(reads);
    const second = prNotes()[1] as { relReadAt?: number; rel?: unknown };
    expect(second.rel).toEqual({ closes: ['https://github.com/acme/web/issues/9'], base: null });
    expect(second.relReadAt).toBeLessThan(secondStart);
    expect(second.relReadAt).toBe(first.relReadAt); // the original read's start, not a later stamp
  });

  it('a rejected issue read is that issue’s failed read; a batch that throws still frees the session', async () => {
    const fetchIssue = vi
      .fn<(o: string, r: string, n: number) => Promise<{ title?: string; state?: string } | undefined>>()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue({ title: 'login', state: 'open' });
    const h = harness({ fetchIssue });
    const issueNotes = () => h.note.mock.calls.filter((c) => c[1].some((e) => e.url.includes('/issues/')));
    await h.svc.refresh('conv1');
    await flush();
    await flush();
    // The rejection is noted as a failed read (stamped, so the next pass reads the others first).
    expect(issueNotes()[0][1]).toEqual([expect.objectContaining({ triedAt: expect.any(Number), onlyIfPresent: true })]);
    // The tree write throws once: the batch ends, and the session is free for the next collect.
    let threw = false;
    h.note.mockImplementation((_k, entries) => {
      if (!threw && entries.some((e) => e.url.includes('/issues/'))) {
        threw = true;
        throw new Error('disk full');
      }
      return true;
    });
    await h.svc.refresh('conv1');
    await flush();
    await flush();
    expect(threw).toBe(true);
    const pushes = h.pushCard.mock.calls.length;
    await h.svc.refresh('conv1');
    await flush();
    await flush();
    expect(fetchIssue).toHaveBeenCalledTimes(3);
    const notes = issueNotes();
    expect(notes[notes.length - 1][1]).toEqual([expect.objectContaining({ title: 'login' })]);
    expect(h.pushCard.mock.calls.length).toBeGreaterThan(pushes + 1);
  });

  it('a session that replaced the old one under its key reads its issues even while the old one’s batch is out', async () => {
    const answers: Array<(v: { title: string; state: string }) => void> = [];
    const fetchIssue = vi.fn(() => new Promise<{ title: string; state: string }>((r) => answers.push(r)));
    const h = harness({ fetchIssue });
    await h.svc.refresh('conv1');
    await flush();
    expect(fetchIssue).toHaveBeenCalledTimes(1);
    const fresh = { ...h.session };
    h.sessions.set('k1', fresh); // /new under the same key
    await h.svc.refresh('conv1');
    await flush();
    expect(fetchIssue).toHaveBeenCalledTimes(2);
    const issueNotes = () => h.note.mock.calls.filter((c) => c[1].some((e) => e.url.includes('/issues/'))).length;
    const before = issueNotes();
    answers[0]({ title: 'old', state: 'open' }); // the old session's answer: dropped
    await flush();
    await flush();
    expect(issueNotes()).toBe(before);
    // The old batch did not free the new session's guard: a collect now asks nothing while the new batch is out.
    await h.svc.refresh('conv1');
    await flush();
    expect(fetchIssue).toHaveBeenCalledTimes(2);
    answers[1]({ title: 'new', state: 'open' }); // the new session's: noted
    await flush();
    await flush();
    expect(issueNotes()).toBe(before + 1);
  });

  it('a PR tree write that fails does not stop the collect: the card is pushed and the issues are still read', async () => {
    const fetchIssue = vi.fn(async () => ({ title: 'login', state: 'open' }));
    const h = harness({ fetchIssue });
    h.note.mockImplementation((_k, entries) => {
      if (entries.some((e) => e.url.includes('/pull/'))) throw new Error('disk full');
      return true;
    });
    await h.svc.refresh('conv1');
    await flush();
    await flush();
    expect(h.pushCard).toHaveBeenCalled();
    expect(fetchIssue).toHaveBeenCalledWith('acme', 'web', 9);
  });
});
