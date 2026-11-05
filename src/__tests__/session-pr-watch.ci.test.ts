/**
 * #929 (epic #935) — a CI failure on a session's PR reaches the session without anyone saying "CI 봐줘".
 *
 * The watch (#928) also reads the check runs of the PR's head commit. When they all finish and one failed, the
 * session gets one host message naming the failed jobs (an idle session is woken, a busy one gets it when it settles —
 * that is `deliver`'s job). A later head that passes after a failure gets one "passed" message. The record is written
 * when the turn is injected, so a restart while it waits queues it again; a message that waited past a merge, a new
 * head or a card that moved on is dropped. With no usable store nothing is delivered.
 * dsh-superagent: a Subscription fans the PR's CI changes out to its Ticket, and they wake the Executor.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type ChecksAnswer,
  checksConclusionOf,
  createFilePrWatchStore,
  createSessionPrWatch,
  type PrWatchDeps,
  type PrWatchRecord,
  type PrWatchStore,
  type PullAnswer,
  type WatchCandidate,
} from '../session-pr-watch';

const URL_A = 'https://github.com/acme/app/pull/12';
const NOW = 1_800_000_000_000;

function memoryStore(): PrWatchStore & { data: Map<string, PrWatchRecord> } {
  const data = new Map<string, PrWatchRecord>();
  return {
    data,
    get: (k) => data.get(k),
    set: (k, r) => void data.set(k, r),
    delete: (k) => void data.delete(k),
  };
}

function harness(over: Partial<PrWatchDeps> = {}) {
  const session: WatchCandidate = { sessionKey: 's1', lastActivityMs: NOW, pr: { url: URL_A, status: 'open' } };
  const state = {
    pull: { number: 12, status: 'open', headSha: 'aaa1111' } as PullAnswer,
    checks: undefined as ChecksAnswer | 'not-modified' | undefined,
    checkAsks: [] as Array<{ sha: string; etag?: string }>,
    delivered: [] as Array<{ sessionKey: string; text: string }>,
    store: memoryStore(),
    holdDone: false,
    waiting: [] as Array<((outcome: 'injected' | 'expired' | 'gone') => void) | undefined>,
    currents: [] as Array<(() => boolean) | undefined>,
  };
  const deps: PrWatchDeps = {
    sessions: () => [session],
    fetchPull: async () => state.pull,
    updateStatus: (_k, _u, status) => {
      if (session.pr?.status === status) return false;
      session.pr = { ...session.pr, status };
      return true;
    },
    pushCard: () => {},
    notify: async () => {},
    fetchChecks: async (_o, _r, sha, etag) => {
      state.checkAsks.push({ sha, ...(etag ? { etag } : {}) });
      return state.checks;
    },
    // Injected at once (a settled session); `holdDone` keeps the message waiting instead.
    deliver: async (sessionKey, text, done, current) => {
      state.delivered.push({ sessionKey, text });
      state.currents.push(current);
      if (state.holdDone) state.waiting.push(done);
      else done?.('injected');
      return true;
    },
    store: state.store,
    now: () => NOW,
    ...over,
  };
  return { deps, state, session };
}

describe('checksConclusionOf', () => {
  it('pending until every run completed; failure names the failed runs; success otherwise', () => {
    expect(checksConclusionOf([])).toEqual({ conclusion: 'pending', failed: [] });
    expect(
      checksConclusionOf([
        { name: 'lint', status: 'completed', conclusion: 'failure' },
        { name: 'test', status: 'in_progress', conclusion: null },
      ]),
    ).toEqual({ conclusion: 'pending', failed: [] });
    expect(
      checksConclusionOf([
        { name: 'lint', status: 'completed', conclusion: 'failure' },
        { name: 'test', status: 'completed', conclusion: 'timed_out' },
        { name: 'scan', status: 'completed', conclusion: 'success' },
        { name: 'docs', status: 'completed', conclusion: 'skipped' },
      ]),
    ).toEqual({ conclusion: 'failure', failed: ['lint', 'test'] });
    expect(
      checksConclusionOf([
        { name: 'scan', status: 'completed', conclusion: 'success' },
        { name: 'docs', status: 'completed', conclusion: 'neutral' },
      ]),
    ).toEqual({ conclusion: 'success', failed: [] });
    expect(checksConclusionOf([{ name: 'gate', status: 'completed', conclusion: 'cancelled' }])).toEqual({
      conclusion: 'failure',
      failed: ['gate'],
    });
  });
});

describe('session PR watch — CI (#929)', () => {
  it('a failed head reaches the session once, naming the failed jobs and the checks link', async () => {
    const h = harness();
    h.state.checks = { conclusion: 'failure', failed: ['quality-gates', 'lean-verify'], etag: 'W/"c1"' };
    const watch = createSessionPrWatch(h.deps);
    await watch.tick();
    expect(h.state.delivered).toHaveLength(1);
    const msg = h.state.delivered[0];
    expect(msg.sessionKey).toBe('s1');
    expect(msg.text).toContain('CI failed on PR #12');
    expect(msg.text).toContain('aaa1111');
    expect(msg.text).toContain('quality-gates');
    expect(msg.text).toContain('lean-verify');
    expect(msg.text).toContain(`${URL_A}/checks`);
    expect(msg.text).toContain('not the user');
    expect(msg.text.length).toBeLessThanOrEqual(600);
    expect(h.state.store.data.get(URL_A.toLowerCase())).toEqual({ ciSha: 'aaa1111', ciConclusion: 'failure' });

    // Same head, same answer: nothing more — and the checks are not asked again for a finished head.
    await watch.tick();
    expect(h.state.delivered).toHaveLength(1);
    expect(h.state.checkAsks).toHaveLength(1);
  });

  it('pending checks deliver nothing and record nothing; the ETag goes out on the next ask', async () => {
    const h = harness();
    h.state.checks = { conclusion: 'pending', failed: [], etag: 'W/"p"' };
    const watch = createSessionPrWatch(h.deps);
    await watch.tick();
    h.state.checks = 'not-modified';
    await watch.tick();
    expect(h.state.delivered).toEqual([]);
    expect(h.state.store.data.size).toBe(0);
    expect(h.state.checkAsks).toEqual([{ sha: 'aaa1111' }, { sha: 'aaa1111', etag: 'W/"p"' }]);
  });

  it('a pass with no failure before it is recorded silently', async () => {
    const h = harness();
    h.state.checks = { conclusion: 'success', failed: [] };
    await createSessionPrWatch(h.deps).tick();
    expect(h.state.delivered).toEqual([]);
    expect(h.state.store.data.get(URL_A.toLowerCase())).toEqual({ ciSha: 'aaa1111', ciConclusion: 'success' });
  });

  it('a new head that passes after a failure tells the session once', async () => {
    const h = harness();
    h.state.checks = { conclusion: 'failure', failed: ['lint'] };
    const watch = createSessionPrWatch(h.deps);
    await watch.tick();
    h.state.pull = { number: 12, status: 'open', headSha: 'bbb2222' };
    h.state.checks = { conclusion: 'success', failed: [] };
    await watch.tick();
    await watch.tick();
    expect(h.state.delivered).toHaveLength(2);
    expect(h.state.delivered[1].text).toContain('CI passed on PR #12');
    expect(h.state.delivered[1].text).toContain('bbb2222');
    expect(h.state.delivered[1].text).toContain('after an earlier failure');
  });

  it('a restart reads the store: the same failed head is not delivered again', async () => {
    const h = harness();
    h.state.checks = { conclusion: 'failure', failed: ['lint'] };
    await createSessionPrWatch(h.deps).tick();
    await createSessionPrWatch(h.deps).tick();
    expect(h.state.delivered).toHaveLength(1);
  });

  it('no usable store: CI is not asked about and nothing is delivered (card updates still run)', async () => {
    const h = harness({ store: undefined });
    h.state.checks = { conclusion: 'failure', failed: ['lint'] };
    await createSessionPrWatch(h.deps).tick();
    expect(h.state.checkAsks).toEqual([]);
    expect(h.state.delivered).toEqual([]);
  });

  it('a merged PR is not asked about CI, and its record is dropped', async () => {
    const h = harness();
    h.state.store.data.set(URL_A.toLowerCase(), { ciSha: 'aaa1111', ciConclusion: 'failure' });
    h.state.pull = { number: 12, status: 'merged', headSha: 'aaa1111' };
    await createSessionPrWatch(h.deps).tick();
    expect(h.state.checkAsks).toEqual([]);
    expect(h.state.store.data.has(URL_A.toLowerCase())).toBe(false);
  });

  it('a failing deliver never throws out of the tick', async () => {
    const h = harness({
      deliver: async () => {
        throw new Error('slack down');
      },
    });
    h.state.checks = { conclusion: 'failure', failed: ['lint'] };
    await expect(createSessionPrWatch(h.deps).tick()).resolves.toBeUndefined();
  });

  it('the record is written when the turn is injected — a restart while it waits queues it again (#929 review)', async () => {
    const h = harness();
    h.state.holdDone = true;
    h.state.checks = { conclusion: 'failure', failed: ['lint'] };
    const watch = createSessionPrWatch(h.deps);
    await watch.tick();
    expect(h.state.delivered).toHaveLength(1);
    expect(h.state.store.data.size).toBe(0);
    // Still waiting: the next tick does not queue a second copy.
    await watch.tick();
    expect(h.state.delivered).toHaveLength(1);
    // A restart before it was injected: the head is untold, so the new process queues it again.
    await createSessionPrWatch(h.deps).tick();
    expect(h.state.delivered).toHaveLength(2);
    // Injected now: recorded, and nothing more.
    h.state.waiting[0]?.('injected');
    expect(h.state.store.data.get(URL_A.toLowerCase())).toEqual({ ciSha: 'aaa1111', ciConclusion: 'failure' });
  });

  it('a session gone before the turn ran leaves the head untold', async () => {
    const h = harness();
    h.state.holdDone = true;
    h.state.checks = { conclusion: 'failure', failed: ['lint'] };
    const watch = createSessionPrWatch(h.deps);
    await watch.tick();
    h.state.waiting[0]?.('gone');
    expect(h.state.store.data.size).toBe(0);
    await watch.tick();
    expect(h.state.delivered).toHaveLength(2);
  });

  it('a waiting message stops being current when the head moves on — the new head is asked instead (#929 round 2)', async () => {
    const h = harness();
    h.state.holdDone = true;
    h.state.checks = { conclusion: 'failure', failed: ['lint'] };
    const watch = createSessionPrWatch(h.deps);
    await watch.tick();
    const current = h.state.currents[0];
    expect(current?.()).toBe(true);
    h.state.pull = { number: 12, status: 'open', headSha: 'bbb2222' };
    h.state.checks = { conclusion: 'pending', failed: [] };
    await watch.tick();
    expect(current?.()).toBe(false);
    expect(h.state.checkAsks.map((a) => a.sha)).toEqual(['aaa1111', 'bbb2222']);
  });

  it('a waiting message stops being current when the PR merges; dropping it does not bring the record back', async () => {
    const h = harness();
    h.state.holdDone = true;
    h.state.checks = { conclusion: 'failure', failed: ['lint'] };
    const watch = createSessionPrWatch(h.deps);
    await watch.tick();
    h.state.pull = { number: 12, status: 'merged', headSha: 'aaa1111' };
    await watch.tick();
    expect(h.state.currents[0]?.()).toBe(false);
    h.state.waiting[0]?.('gone');
    expect(h.state.store.data.size).toBe(0);
  });

  it('a waiting message stops being current when the session card moves to another PR', async () => {
    const h = harness();
    h.state.holdDone = true;
    h.state.checks = { conclusion: 'failure', failed: ['lint'] };
    const watch = createSessionPrWatch(h.deps);
    await watch.tick();
    h.session.pr = { url: 'https://github.com/acme/app/pull/99', status: 'open' };
    await watch.tick();
    expect(h.state.currents[0]?.()).toBe(false);
  });

  it('current() asks the live sessions, not the last scan: a card moved, a second owner, or sessions that cannot be read (#929 round 3)', async () => {
    const h = harness();
    h.state.holdDone = true;
    h.state.checks = { conclusion: 'failure', failed: ['lint'] };
    const sessions = h.deps.sessions;
    await createSessionPrWatch(h.deps).tick();
    const current = h.state.currents[0];
    expect(current?.()).toBe(true);
    // A second live session takes the same PR on its card — no tick in between: no clear owner.
    const other: WatchCandidate = { sessionKey: 's2', lastActivityMs: NOW, pr: { url: URL_A, status: 'open' } };
    h.deps.sessions = () => [...sessions(), other];
    expect(current?.()).toBe(false);
    h.deps.sessions = sessions;
    expect(current?.()).toBe(true);
    // The card moves to another PR — no tick in between.
    const pr = h.session.pr;
    h.session.pr = { url: 'https://github.com/acme/app/pull/99', status: 'open' };
    expect(current?.()).toBe(false);
    h.session.pr = pr;
    // The sessions cannot be read: closed, not open.
    h.deps.sessions = () => {
      throw new Error('registry busy');
    };
    expect(current?.()).toBe(false);
  });

  it('a PR on two live cards wakes neither (no clear owner) — #929 review', async () => {
    const h = harness();
    const other: WatchCandidate = { sessionKey: 's2', lastActivityMs: NOW, pr: { url: URL_A, status: 'open' } };
    const sessions = h.deps.sessions;
    h.deps.sessions = () => [...sessions(), other];
    h.state.checks = { conclusion: 'failure', failed: ['lint'] };
    await createSessionPrWatch(h.deps).tick();
    expect(h.state.delivered).toEqual([]);
    expect(h.state.checkAsks).toEqual([]);
  });

  it('many failed jobs stay within the message budget', async () => {
    const h = harness();
    h.state.checks = { conclusion: 'failure', failed: Array.from({ length: 80 }, (_, i) => `job-number-${i}`) };
    await createSessionPrWatch(h.deps).tick();
    expect(h.state.delivered[0].text.length).toBeLessThanOrEqual(600);
  });
});

describe('createFilePrWatchStore (#929)', () => {
  it('keeps records across instances in one atomic JSON file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-watch-store-'));
    const file = path.join(dir, 'pr-watch.json');
    const a = createFilePrWatchStore(file);
    expect(a).toBeDefined();
    a?.set('k', { ciSha: 'x', ciConclusion: 'failure' });
    const b = createFilePrWatchStore(file);
    expect(b?.get('k')).toEqual({ ciSha: 'x', ciConclusion: 'failure' });
    b?.delete('k');
    expect(createFilePrWatchStore(file)?.get('k')).toBeUndefined();
  });

  it('an unreadable store is undefined (the caller delivers nothing), never an empty one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-watch-store-'));
    const file = path.join(dir, 'pr-watch.json');
    fs.writeFileSync(file, '{not json');
    expect(createFilePrWatchStore(file, () => {})).toBeUndefined();
  });
});

describe('entry point wiring (#929)', () => {
  it('the daemon gives the watch the check-run reader, a delivery path and the store', () => {
    const index = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf-8');
    expect(index).toContain('fetchChecks: fetchGitHubCheckRuns');
    // The record is written only in `done`, and `current` drops a stale message — a wrapper that drops either re-sends
    // the same CI message every restart or tells a merged PR to fix its CI.
    expect(index).toContain(
      'deliver: (sessionKey, text, done, current) => delivery.deliver(sessionKey, text, done, current)',
    );
    expect(index).toContain("createFilePrWatchStore(path.join(DATA_DIR, 'pr-watch.json')");
  });
});
