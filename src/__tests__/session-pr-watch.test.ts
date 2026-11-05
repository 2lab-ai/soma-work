/**
 * #928 (epic #935, closes #644) — a session's PR keeps its card current after the turn ended.
 *
 * A person merging on GitHub after the session's last turn left the card saying 'open' (#644): the turn-end reconcile
 * (#833) and the write receipt (#832) only run inside a turn. The watch reads the current PR of each live session on a
 * timer; a changed state goes on the card, and a merge or a close also gets one thread notice — stored first, so a
 * restart never repeats it. dsh-superagent: a Ticket subscribes to its PR and ends with one notice on merge or close.
 */
import fs from 'node:fs';
import path from 'node:path';
import { canonicalLinkUrl } from '@soma/slack/session-link-capture';
import { describe, expect, it, vi } from 'vitest';
import {
  createSessionPrWatch,
  type PrWatchDeps,
  type PullAnswer,
  pullStatusOf,
  type WatchCandidate,
} from '../session-pr-watch';

const URL_A = 'https://github.com/acme/app/pull/12';
const URL_B = 'https://github.com/acme/app/pull/13';
const URL_C = 'https://github.com/acme/app/pull/14';
const NOW = 1_800_000_000_000;

interface Harness {
  deps: PrWatchDeps;
  sessions: Map<string, WatchCandidate>;
  answers: Map<string, PullAnswer | 'not-modified' | undefined>;
  fetched: Array<{ url: string; etag?: string }>;
  notices: Array<{ sessionKey: string; text: string }>;
  pushed: string[];
}

function harness(initial: WatchCandidate[], over: Partial<PrWatchDeps> = {}): Harness {
  const sessions = new Map(initial.map((s) => [s.sessionKey, s]));
  const answers = new Map<string, PullAnswer | 'not-modified' | undefined>();
  const fetched: Array<{ url: string; etag?: string }> = [];
  const notices: Array<{ sessionKey: string; text: string }> = [];
  const pushed: string[] = [];
  const deps: PrWatchDeps = {
    sessions: () => sessions.values(),
    fetchPull: async (owner, repo, number, etag) => {
      const url = `https://github.com/${owner}/${repo}/pull/${number}`;
      fetched.push({ url, ...(etag ? { etag } : {}) });
      return answers.get(url);
    },
    // Like the registry's 'update': the card's link takes the state (and the change is saved).
    updateStatus: (sessionKey, url, status) => {
      const s = sessions.get(sessionKey);
      if (!s?.pr?.url || canonicalLinkUrl(s.pr.url) !== canonicalLinkUrl(url) || s.pr.status === status) return false;
      s.pr = { ...s.pr, status };
      return true;
    },
    pushCard: (sessionKey) => pushed.push(sessionKey),
    notify: async (sessionKey, text) => {
      notices.push({ sessionKey, text });
    },
    now: () => NOW,
    ...over,
  };
  return { deps, sessions, answers, fetched, notices, pushed };
}

const openPr = (sessionKey: string, url: string, extra: Partial<WatchCandidate> = {}): WatchCandidate => ({
  sessionKey,
  lastActivityMs: NOW - 60_000,
  pr: { url, status: 'open' },
  ...extra,
});

describe('pullStatusOf', () => {
  it('maps GitHub fields to the card states', () => {
    expect(pullStatusOf({ state: 'open', draft: false, merged: false })).toBe('open');
    expect(pullStatusOf({ state: 'open', draft: true, merged: false })).toBe('draft');
    expect(pullStatusOf({ state: 'closed', draft: false, merged: true })).toBe('merged');
    expect(pullStatusOf({ state: 'closed', draft: false, merged: false })).toBe('closed');
    // A merged draft is merged; a closed draft is closed.
    expect(pullStatusOf({ state: 'closed', draft: true, merged: true })).toBe('merged');
    expect(pullStatusOf({ state: 'closed', draft: true, merged: false })).toBe('closed');
  });
});

describe('session PR watch (#928)', () => {
  it('a merge after the turn: the card says merged, the thread gets one notice, the watch stops (#644)', async () => {
    const h = harness([openPr('s1', URL_A)]);
    h.answers.set(URL_A, { number: 12, status: 'merged', etag: 'W/"1"' });
    const watch = createSessionPrWatch(h.deps);

    await watch.tick();
    expect(h.sessions.get('s1')?.pr?.status).toBe('merged');
    expect(h.pushed).toEqual(['s1']);
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0].sessionKey).toBe('s1');
    expect(h.notices[0].text).toContain('PR #12');
    expect(h.notices[0].text).toContain('머지됨');
    expect(h.notices[0].text).toContain(URL_A);

    // Merged is final: the next tick does not even ask.
    await watch.tick();
    expect(h.fetched).toHaveLength(1);
    expect(h.notices).toHaveLength(1);
  });

  it('a close without a merge says so, once', async () => {
    const h = harness([openPr('s1', URL_A)]);
    h.answers.set(URL_A, { number: 12, status: 'closed' });
    const watch = createSessionPrWatch(h.deps);
    await watch.tick();
    await watch.tick();
    expect(h.sessions.get('s1')?.pr?.status).toBe('closed');
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0].text).toContain('머지 없이 닫힘');
  });

  it('a restart does not repeat the notice: the state was stored before it was posted', async () => {
    const h = harness([openPr('s1', URL_A)]);
    h.answers.set(URL_A, { number: 12, status: 'merged' });
    await createSessionPrWatch(h.deps).tick();
    // A new process reads the stored card ('merged') — a fresh watch has nothing to do.
    const again = createSessionPrWatch(h.deps);
    await again.tick();
    expect(h.fetched).toHaveLength(1);
    expect(h.notices).toHaveLength(1);
  });

  it('draft → open is a card change without a notice', async () => {
    const h = harness([openPr('s1', URL_A, { pr: { url: URL_A, status: 'draft' } })]);
    h.answers.set(URL_A, { number: 12, status: 'open' });
    await createSessionPrWatch(h.deps).tick();
    expect(h.sessions.get('s1')?.pr?.status).toBe('open');
    expect(h.pushed).toEqual(['s1']);
    expect(h.notices).toHaveLength(0);
  });

  it('an unchanged PR changes nothing; the next ask carries the ETag and a 304 changes nothing', async () => {
    const h = harness([openPr('s1', URL_A)]);
    h.answers.set(URL_A, { number: 12, status: 'open', etag: 'W/"abc"' });
    const watch = createSessionPrWatch(h.deps);
    await watch.tick();
    h.answers.set(URL_A, 'not-modified');
    await watch.tick();
    expect(h.fetched).toEqual([{ url: URL_A }, { url: URL_A, etag: 'W/"abc"' }]);
    expect(h.pushed).toEqual([]);
    expect(h.notices).toEqual([]);
  });

  it('a 304 still applies a state the card missed earlier', async () => {
    // First answer: merged, but the card update failed (the link was being rewritten) — no notice then.
    let refuse = true;
    const h = harness([openPr('s1', URL_A)]);
    const update = h.deps.updateStatus;
    h.deps.updateStatus = (k, u, st) => (refuse ? false : update(k, u, st));
    h.answers.set(URL_A, { number: 12, status: 'merged', etag: 'W/"m"' });
    const watch = createSessionPrWatch(h.deps);
    await watch.tick();
    expect(h.notices).toHaveLength(0);
    refuse = false;
    h.answers.set(URL_A, 'not-modified');
    await watch.tick();
    expect(h.sessions.get('s1')?.pr?.status).toBe('merged');
    expect(h.notices).toHaveLength(1);
  });

  it('a failed ask changes nothing and never throws', async () => {
    const h = harness([openPr('s1', URL_A)], {
      fetchPull: async () => {
        throw new Error('boom');
      },
    });
    await expect(createSessionPrWatch(h.deps).tick()).resolves.toBeUndefined();
    expect(h.notices).toEqual([]);
    const h2 = harness([openPr('s1', URL_A)]);
    h2.answers.set(URL_A, undefined);
    await createSessionPrWatch(h2.deps).tick();
    expect(h2.notices).toEqual([]);
    expect(h2.sessions.get('s1')?.pr?.status).toBe('open');
  });

  it('a failed notice does not undo the card', async () => {
    const h = harness([openPr('s1', URL_A)], {
      notify: async () => {
        throw new Error('slack down');
      },
    });
    h.answers.set(URL_A, { number: 12, status: 'merged' });
    await expect(createSessionPrWatch(h.deps).tick()).resolves.toBeUndefined();
    expect(h.sessions.get('s1')?.pr?.status).toBe('merged');
  });

  it('watches only live, recent sessions with an open PR on the card', async () => {
    const h = harness([
      openPr('terminated', URL_A, { terminated: true }),
      openPr('stale', URL_A, { lastActivityMs: NOW - 15 * 24 * 3600_000 }),
      { sessionKey: 'no-pr', lastActivityMs: NOW },
      openPr('issue-url', 'https://github.com/acme/app/issues/5'),
      openPr('merged', URL_A, { pr: { url: URL_A, status: 'merged' } }),
      openPr('closed', URL_A, { pr: { url: URL_A, status: 'closed' } }),
      openPr('live', URL_B),
    ]);
    h.answers.set(URL_B, { number: 13, status: 'open' });
    await createSessionPrWatch(h.deps).tick();
    expect(h.fetched.map((f) => f.url)).toEqual([URL_B]);
  });

  it('a card link with no state yet is asked about, and takes the state without a notice when open', async () => {
    const h = harness([openPr('s1', URL_A, { pr: { url: URL_A } })]);
    h.answers.set(URL_A, { number: 12, status: 'open' });
    await createSessionPrWatch(h.deps).tick();
    expect(h.sessions.get('s1')?.pr?.status).toBe('open');
    expect(h.notices).toEqual([]);
  });

  it('two sessions on the same PR: one ask, each card changes, each thread is told', async () => {
    const h = harness([openPr('s1', URL_A), openPr('s2', `${URL_A}/files`)]);
    h.answers.set(URL_A, { number: 12, status: 'merged' });
    await createSessionPrWatch(h.deps).tick();
    expect(h.fetched).toHaveLength(1);
    expect(h.notices.map((n) => n.sessionKey).sort()).toEqual(['s1', 's2']);
  });

  it('at most maxPerTick asks per tick, the least recently asked first', async () => {
    const h = harness([openPr('a', URL_A), openPr('b', URL_B), openPr('c', URL_C)], { maxPerTick: 2 });
    for (const [u, n] of [
      [URL_A, 12],
      [URL_B, 13],
      [URL_C, 14],
    ] as const)
      h.answers.set(u, { number: n, status: 'open' });
    const watch = createSessionPrWatch(h.deps);
    await watch.tick();
    expect(h.fetched.map((f) => f.url)).toEqual([URL_A, URL_B]);
    await watch.tick();
    expect(h.fetched.map((f) => f.url).slice(2, 3)).toEqual([URL_C]);
  });

  it('start/stop: the timer ticks, and a tick still running is not started twice', async () => {
    vi.useFakeTimers();
    try {
      let release: () => void = () => {};
      const h = harness([openPr('s1', URL_A)], {
        fetchPull: (owner, repo, number) => {
          h.fetched.push({ url: `https://github.com/${owner}/${repo}/pull/${number}` });
          return new Promise((resolve) => {
            release = () => resolve({ number, status: 'open' });
          });
        },
      });
      const watch = createSessionPrWatch(h.deps);
      watch.start(1000);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.fetched).toHaveLength(1);
      release();
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.fetched).toHaveLength(2);
      watch.stop();
      release();
      await vi.advanceTimersByTimeAsync(5000);
      expect(h.fetched).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('entry point wiring (#928)', () => {
  it('the daemon starts the watch after Slack is up and stops it on shutdown', () => {
    const index = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf-8');
    expect(index).toContain('createSessionPrWatch(');
    expect(index).toMatch(/sessionPrWatch\??\.start\(/);
    expect(index).toMatch(/sessionPrWatch\??\.stop\(\)/);
  });
});

describe('display language (#928)', () => {
  it('the notices have English catalog text', async () => {
    const { registerDisplayCatalog, trIn } = await import('@soma/common/i18n');
    // The English catalog src/index.ts loads (`@soma/common/i18n-en`).
    const catalog = path.join(__dirname, '..', '..', 'packages', 'common', 'src', 'i18n-catalog', 'en-text.json');
    registerDisplayCatalog('en', JSON.parse(fs.readFileSync(catalog, 'utf-8')));
    const merged = ['🟣 PR #', ' 머지됨 — ', ''] as unknown as TemplateStringsArray;
    const closed = ['🔴 PR #', ' 머지 없이 닫힘 — ', ''] as unknown as TemplateStringsArray;
    expect(trIn('en', merged, 12, URL_A)).toBe(`🟣 PR #12 merged — ${URL_A}`);
    expect(trIn('en', closed, 12, URL_A)).toBe(`🔴 PR #12 closed without merging — ${URL_A}`);
  });
});
