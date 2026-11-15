/**
 * .prd/27 §1 — the host side: what a run reads from the session, and that it writes back only while the key still names
 * that session.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCodeChangesService, REFRESH_WAIT_MS, type SessionLike, sessionPrUrls } from '../service';
import { CodeChangesStore } from '../store';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

function setup(
  session: SessionLike & { key?: string },
  collect: Record<string, unknown> = {},
  opts: { noConsumer?: boolean } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-svc-'));
  roots.push(dir);
  const sessions = new Map<string, SessionLike>([['k1', session]]);
  const persist = vi.fn();
  const pushCard = vi.fn();
  const onResult = vi.fn();
  const listCheckoutDirs = vi.fn(async () => ({ dirs: [] as string[] }));
  const svc = createCodeChangesService({
    getSessionByKey: (k) => sessions.get(k),
    allSessions: () => sessions.entries(),
    persist,
    pushCard,
    ...(opts.noConsumer ? {} : { onResult }),
    store: new CodeChangesStore(dir),
    collect: {
      listCheckoutDirs,
      fetchPullDetail: async () => undefined,
      fetchPullFiles: async () => undefined,
      now: () => 7,
      ...collect,
    },
    scheduler: { delayMs: 0, minIntervalMs: 0 },
  });
  return { svc, sessions, persist, pushCard, onResult, listCheckoutDirs, store: new CodeChangesStore(dir) };
}

describe('code-changes service', () => {
  it('sessionPrUrls: the current PR first, then the history newest first, once each', () => {
    expect(
      sessionPrUrls({
        links: { pr: { url: 'https://github.com/a/b/pull/3' } },
        linkHistory: {
          prs: [{ url: 'https://github.com/a/b/pull/1' }, { url: 'https://github.com/a/b/pull/3' }, null],
        },
      }),
    ).toEqual(['https://github.com/a/b/pull/3', 'https://github.com/a/b/pull/1']);
  });

  it('a turn-end snapshot reads the session’s folders and writes its summary, persists, pushes the card', async () => {
    const session: SessionLike = {
      conversationId: 'conv1',
      ownerId: 'U1',
      sessionWorkingDir: '/tmp/U1/session_1794756694405_abc',
    };
    const t = setup(session);
    t.svc.snapshot({ sessionKey: 'k1', workingDirectory: '/tmp/U1/session_1794756694405_abc/repo' });
    await t.svc.scheduler.idle();
    expect(t.listCheckoutDirs).toHaveBeenCalledWith(
      ['/tmp/U1/session_1794756694405_abc', '/tmp/U1/session_1794756694405_abc/repo'],
      expect.any(Number),
    );
    expect(session.codeChanges?.updatedAt).toBe(7);
    expect(t.persist).toHaveBeenCalledWith('k1');
    expect(t.pushCard).toHaveBeenCalledWith('k1');
    expect(t.onResult).toHaveBeenCalledTimes(1);
  });

  it('a session replaced (or terminated) while the run was under way is not written', async () => {
    const session: SessionLike = { conversationId: 'conv1', sessionWorkingDir: '/tmp/x/session_1794756694405_a' };
    const t = setup(session);
    t.listCheckoutDirs.mockImplementation(async () => {
      t.sessions.set('k1', { conversationId: 'conv2', sessionWorkingDir: '/tmp/y' });
      return { dirs: [] };
    });
    t.svc.snapshot({ sessionKey: 'k1' });
    await t.svc.scheduler.idle();
    expect(session.codeChanges).toBeUndefined();
    expect(t.persist).not.toHaveBeenCalled();
  });

  it('a /new between the turn end and the run: the old turn’s folder is not read for the new session', async () => {
    const old: SessionLike = { conversationId: 'conv-old', sessionWorkingDir: '/tmp/x/session_1794756694405_old' };
    const t = setup(old);
    const fresh: SessionLike = { conversationId: 'conv-new', sessionWorkingDir: '/tmp/x/session_1794756694406_new' };
    t.svc.snapshot({ sessionKey: 'k1', session: old, workingDirectory: '/tmp/x/session_1794756694405_old/repo' });
    t.sessions.set('k1', fresh);
    await t.svc.scheduler.idle();
    expect(t.listCheckoutDirs).toHaveBeenCalledWith(['/tmp/x/session_1794756694406_new'], expect.any(Number));
  });

  it('refresh runs now for the live session of a conversation; false when none holds it', async () => {
    const session: SessionLike = { conversationId: 'conv1', sessionWorkingDir: '/tmp/x/session_1794756694405_a' };
    const t = setup(session);
    expect(await t.svc.refresh('conv1')).toBe(true);
    expect(session.codeChanges).toBeDefined();
    expect(await t.svc.refresh('conv-none')).toBe(false);
    session.terminated = true;
    expect(await t.svc.refresh('conv1')).toBe(false);
  });

  it('new commits are marked counted only once the result was handed on; a failed hand-off hands them on again', async () => {
    const sha = 'c'.repeat(40);
    const session: SessionLike = {
      conversationId: 'conv1',
      startedAt: 1,
      sessionWorkingDir: '/tmp/x/session_1794756694405_a',
    };
    const checkoutChanges = vi.fn(async ({ commits }: { commits?: { skip: ReadonlySet<string> } }) => ({
      id: 'c1',
      repo: 'acme/web',
      dir: 'web',
      uncommitted: { files: [], additions: 0, deletions: 0 },
      committed: { files: [], additions: 0, deletions: 0, commits: [] },
      sessionCommits: commits?.skip.has(sha) ? [] : [{ sha, at: 5, additions: 1, deletions: 0 }],
    }));
    const t = setup(session, {
      listCheckoutDirs: async () => ({ dirs: ['/tmp/x/session_1794756694405_a/web'] }),
      checkoutChanges,
    });
    t.onResult.mockImplementationOnce(async () => {
      throw new Error('metrics down');
    });
    expect(await t.svc.refresh('conv1')).toBe(true);
    expect(t.store.read('conv1')?.counted.commits).toEqual([]);
    expect(await t.svc.refresh('conv1')).toBe(true);
    expect(t.onResult.mock.calls[1][2].newCommits.map((c: { sha: string }) => c.sha)).toEqual([sha]);
    expect(t.store.read('conv1')?.counted.commits).toEqual([sha]);
    expect(await t.svc.refresh('conv1')).toBe(true);
    expect(t.onResult.mock.calls[2][2].newCommits).toEqual([]);
  });

  it('turn folders of sessions that ended or were replaced are dropped', async () => {
    const a: SessionLike = { conversationId: 'ca', sessionWorkingDir: '/tmp/x/session_1794756694405_a' };
    const t = setup(a);
    t.svc.snapshot({ sessionKey: 'k1', session: a, workingDirectory: '/tmp/x/session_1794756694405_a/repo' });
    await t.svc.scheduler.idle();
    expect(t.svc.turnDirCount()).toBe(1);
    t.sessions.set('k1', { conversationId: 'cb', sessionWorkingDir: '/tmp/x/session_1794756694406_b' });
    const c: SessionLike = { conversationId: 'cc', sessionWorkingDir: '/tmp/x/session_1794756694407_c' };
    t.sessions.set('k2', c);
    t.svc.snapshot({ sessionKey: 'k2', session: c, workingDirectory: '/tmp/x/session_1794756694407_c/repo' });
    await t.svc.scheduler.idle();
    expect(t.svc.turnDirCount()).toBe(1);
    c.terminated = true;
    t.svc.snapshot({ sessionKey: 'k3' });
    expect(t.svc.turnDirCount()).toBe(0);
  });

  it('with no consumer of the result, nothing is marked counted — a consumer installed later still gets them', async () => {
    const sha = 'e'.repeat(40);
    const session: SessionLike = {
      conversationId: 'conv1',
      startedAt: 1,
      sessionWorkingDir: '/tmp/x/session_1794756694405_a',
    };
    const t = setup(
      session,
      {
        listCheckoutDirs: async () => ({ dirs: ['/tmp/x/session_1794756694405_a/web'] }),
        checkoutChanges: async () => ({
          id: 'c1',
          repo: 'acme/web',
          dir: 'web',
          uncommitted: { files: [], additions: 0, deletions: 0 },
          committed: { files: [], additions: 0, deletions: 0, commits: [] },
          sessionCommits: [{ sha, at: 5, additions: 1, deletions: 0 }],
        }),
      },
      { noConsumer: true },
    );
    expect(await t.svc.refresh('conv1')).toBe(true);
    expect(session.codeChanges).toBeDefined();
    expect(t.store.read('conv1')?.counted.commits).toEqual([]);
  });

  it('refresh answers by its deadline while the collect is held, and the collect still lands afterwards', async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      const session: SessionLike = { conversationId: 'conv1', sessionWorkingDir: '/tmp/x/session_1794756694405_a' };
      const t = setup(session, {
        listCheckoutDirs: async () => {
          await held;
          return { dirs: [] };
        },
      });
      let answered: boolean | undefined;
      void t.svc.refresh('conv1').then((v) => (answered = v));
      await vi.advanceTimersByTimeAsync(REFRESH_WAIT_MS - 1);
      expect(answered).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(answered).toBe(true);
      expect(session.codeChanges).toBeUndefined();
      release();
      await vi.advanceTimersByTimeAsync(0);
      await t.svc.scheduler.idle();
      expect(session.codeChanges?.updatedAt).toBe(7);
    } finally {
      vi.useRealTimers();
    }
  });
});
