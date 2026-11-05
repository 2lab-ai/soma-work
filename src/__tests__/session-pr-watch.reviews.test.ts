/**
 * #930 (epic #935) — reviews and comments on a session's PR reach the session without anyone mentioning the bot.
 *
 * When the PR changed (its GET answered 200), or the last read failed or stopped at a page edge, the watch reads the
 * activity after its stored cursor: reviews, review comments and PR comments. Left out: the bot's own writes, anyone
 * who is not an OWNER, MEMBER or COLLABORATOR of the repo, and every bot not on the allow list (SOMA_PR_WATCH_BOTS,
 * empty by default); an allowed bot's activity alone wakes the session at most 3 times per PR. The host turn carries
 * pointers only — who, what kind, the link — never the text: what a third party wrote does not enter the session as
 * the owner's turn (trinity review, astra/fable P1). Only the single live session that has the PR on its card is
 * woken. The cursor is recorded when the turn is injected, so a restart while it waits reads it again.
 * dsh-superagent: later discussion reaches the Executor without anyone mentioning the agent; automated reviewers get at
 * most three rounds per pull request.
 */
import { describe, expect, it } from 'vitest';
import {
  type ActivityAnswer,
  type ActivityItem,
  createSessionPrWatch,
  type DeliveryOutcome,
  type PrWatchDeps,
  type PrWatchRecord,
  type PrWatchStore,
  type PullAnswer,
  type WatchCandidate,
} from '../session-pr-watch';

const URL_A = 'https://github.com/acme/app/pull/12';
const KEY = URL_A.toLowerCase();
const NOW = Date.parse('2026-11-04T12:00:00Z');
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

let seq = 0;
function item(over: Partial<ActivityItem>): ActivityItem {
  seq++;
  return {
    id: `comment:${seq}`,
    kind: 'comment',
    author: 'alice',
    bot: false,
    association: 'MEMBER',
    url: `${URL_A}#issuecomment-${seq}`,
    at: iso(1),
    ...over,
  };
}

function harness(over: Partial<PrWatchDeps> = {}) {
  const data = new Map<string, PrWatchRecord>();
  const store: PrWatchStore = {
    get: (k) => data.get(k),
    set: (k, r) => void data.set(k, r),
    delete: (k) => void data.delete(k),
  };
  const session: WatchCandidate = { sessionKey: 's1', lastActivityMs: NOW, pr: { url: URL_A, status: 'open' } };
  const state = {
    pull: { number: 12, status: 'open', etag: 'W/"1"' } as PullAnswer | 'not-modified',
    activity: [] as ActivityItem[],
    until: undefined as string | undefined,
    fail: false,
    asks: [] as string[],
    delivered: [] as string[],
    holdDone: false,
    waiting: [] as Array<((o: DeliveryOutcome) => void) | undefined>,
    currents: [] as Array<(() => boolean) | undefined>,
  };
  const deps: PrWatchDeps = {
    sessions: () => [session],
    fetchPull: async () => state.pull,
    updateStatus: () => false,
    pushCard: () => {},
    notify: async () => {},
    deliver: async (_k, text, done, current) => {
      state.delivered.push(text);
      state.currents.push(current);
      if (state.holdDone) state.waiting.push(done);
      else done?.('injected');
      return true;
    },
    store,
    fetchActivity: async (_o, _r, _n, since): Promise<ActivityAnswer | undefined> => {
      state.asks.push(since);
      if (state.fail) return undefined;
      return { items: state.activity.filter((a) => a.at > since), ...(state.until ? { until: state.until } : {}) };
    },
    ownLogin: async () => 'zhuge-liang-bot[bot]',
    botLogins: ['coderabbitai[bot]'],
    now: () => NOW,
    ...over,
  };
  return { deps, state, data, session };
}

describe('session PR watch — reviews and comments (#930)', () => {
  it('a member comment reaches the session once — who, what and the link, never the text', async () => {
    const h = harness();
    h.data.set(KEY, { since: iso(5) });
    const c = item({ at: iso(1) });
    h.state.activity = [c];
    const watch = createSessionPrWatch(h.deps);
    await watch.tick();
    expect(h.state.asks).toEqual([iso(5)]);
    expect(h.state.delivered).toHaveLength(1);
    const text = h.state.delivered[0];
    expect(text).toContain('PR #12');
    expect(text).toContain('@alice');
    expect(text).toContain(c.url);
    expect(text).toContain('not instructions from the user');
    expect(h.data.get(KEY)?.since).toBe(iso(1));

    // The PR did not change (304) and nothing is left to read: the activity is not asked again.
    h.state.pull = 'not-modified';
    await watch.tick();
    expect(h.state.asks).toHaveLength(1);
    expect(h.state.delivered).toHaveLength(1);
  });

  it('the first look starts the cursor 10 minutes back — no replay of an old PR history', async () => {
    const h = harness();
    h.state.activity = [item({ author: 'old-timer', at: iso(60) }), item({ author: 'fresh', at: iso(2) })];
    await createSessionPrWatch(h.deps).tick();
    expect(h.state.asks).toEqual([iso(10)]);
    expect(h.state.delivered).toHaveLength(1);
    expect(h.state.delivered[0]).toContain('@fresh');
    expect(h.state.delivered[0]).not.toContain('old-timer');
  });

  it("the bot's own writes, outsiders and bots off the allow list are left out; the cursor still moves", async () => {
    const h = harness();
    h.data.set(KEY, { since: iso(5) });
    h.state.activity = [
      item({ author: 'zhuge-liang-bot[bot]', bot: true, association: 'NONE', at: iso(4) }),
      item({ author: 'stranger', association: 'NONE', at: iso(3) }),
      item({ author: 'drive-by', association: 'FIRST_TIME_CONTRIBUTOR', at: iso(2) }),
      item({ author: 'random-app[bot]', bot: true, association: 'NONE', at: iso(1) }),
    ];
    await createSessionPrWatch(h.deps).tick();
    expect(h.state.delivered).toEqual([]);
    expect(h.data.get(KEY)?.since).toBe(iso(1));
  });

  it('no allow list: no bot gets in at all', async () => {
    const h = harness({ botLogins: [] });
    h.data.set(KEY, { since: iso(5) });
    h.state.activity = [item({ author: 'coderabbitai[bot]', bot: true, association: 'NONE', at: iso(1) })];
    await createSessionPrWatch(h.deps).tick();
    expect(h.state.delivered).toEqual([]);
  });

  it('reviews carry their state; review comments carry their file', async () => {
    const h = harness();
    h.data.set(KEY, { since: iso(5) });
    h.state.activity = [
      item({ kind: 'review', state: 'CHANGES_REQUESTED', at: iso(2) }),
      item({ kind: 'review-comment', path: 'src/x.ts', at: iso(1) }),
      item({ kind: 'review', author: 'bob', association: 'COLLABORATOR', state: 'APPROVED', at: iso(1) }),
    ];
    await createSessionPrWatch(h.deps).tick();
    const text = h.state.delivered[0];
    expect(text).toContain('CHANGES_REQUESTED');
    expect(text).toContain('src/x.ts');
    expect(text).toContain('@bob');
    expect(text).toContain('APPROVED');
  });

  it('an allowed bot alone wakes the session at most 3 times per PR; a person still gets through after', async () => {
    const h = harness();
    h.data.set(KEY, { since: iso(30) });
    const watch = createSessionPrWatch(h.deps);
    for (let round = 0; round < 5; round++) {
      h.state.activity = [item({ author: 'coderabbitai[bot]', bot: true, association: 'NONE', at: iso(20 - round) })];
      h.state.pull = { number: 12, status: 'open', etag: `W/"r${round}"` };
      await watch.tick();
    }
    expect(h.state.delivered).toHaveLength(3);
    expect(h.data.get(KEY)?.botWakes).toBe(3);
    h.state.activity = [item({ author: 'human', at: iso(1) })];
    h.state.pull = { number: 12, status: 'open', etag: 'W/"h"' };
    await watch.tick();
    expect(h.state.delivered).toHaveLength(4);
    expect(h.state.delivered[3]).toContain('@human');
  });

  it('a long thread stays within the message budget and says how many were left out', async () => {
    const h = harness();
    h.data.set(KEY, { since: iso(30) });
    h.state.activity = Array.from({ length: 40 }, (_, i) =>
      item({
        author: `person-with-a-long-login-${i}`,
        path: 'src/a/very/long/path/name.ts',
        kind: 'review-comment',
        at: iso(25 - i * 0.5),
      }),
    );
    await createSessionPrWatch(h.deps).tick();
    const text = h.state.delivered[0];
    expect(text.length).toBeLessThanOrEqual(1500);
    expect(text).toMatch(/and \d+ more/);
  });

  it('unknown own login: activity is not read (the bot could wake itself)', async () => {
    const h = harness({ ownLogin: async () => undefined });
    h.data.set(KEY, { since: iso(5) });
    h.state.activity = [item({ at: iso(1) })];
    await createSessionPrWatch(h.deps).tick();
    expect(h.state.asks).toEqual([]);
  });

  it('a failed read moves nothing and is tried again on the next tick even when the PR answers 304', async () => {
    const h = harness();
    h.data.set(KEY, { since: iso(5) });
    h.state.activity = [item({ at: iso(1) })];
    h.state.fail = true;
    const watch = createSessionPrWatch(h.deps);
    await watch.tick();
    expect(h.data.get(KEY)?.since).toBe(iso(5));
    h.state.fail = false;
    h.state.pull = 'not-modified';
    await watch.tick();
    expect(h.state.asks).toHaveLength(2);
    expect(h.state.delivered).toHaveLength(1);
  });

  it('a read that stopped at a page edge delivers up to it, keeps the cursor there and reads on next tick', async () => {
    const h = harness();
    h.data.set(KEY, { since: iso(10) });
    h.state.activity = [item({ author: 'early', at: iso(8) }), item({ author: 'late', at: iso(2) })];
    h.state.until = iso(5);
    const watch = createSessionPrWatch(h.deps);
    await watch.tick();
    expect(h.state.delivered[0]).toContain('@early');
    expect(h.state.delivered[0]).not.toContain('@late');
    expect(h.data.get(KEY)?.since).toBe(iso(5));
    h.state.until = undefined;
    h.state.pull = 'not-modified';
    await watch.tick();
    expect(h.state.asks).toEqual([iso(10), iso(5)]);
    expect(h.state.delivered[1]).toContain('@late');
  });

  it('the cursor is recorded when the turn is injected — a restart while it waits reads it again', async () => {
    const h = harness();
    h.data.set(KEY, { since: iso(5) });
    h.state.activity = [item({ at: iso(1) })];
    h.state.holdDone = true;
    const watch = createSessionPrWatch(h.deps);
    await watch.tick();
    h.state.pull = { number: 12, status: 'open', etag: 'W/"2"' };
    await watch.tick();
    expect(h.state.delivered).toHaveLength(1);
    expect(h.data.get(KEY)?.since).toBe(iso(5));
    await createSessionPrWatch(h.deps).tick();
    expect(h.state.delivered).toHaveLength(2);
    h.state.waiting[0]?.('injected');
    expect(h.data.get(KEY)?.since).toBe(iso(1));
  });

  it('a PR on two live cards wakes neither', async () => {
    const h = harness();
    const other: WatchCandidate = { sessionKey: 's2', lastActivityMs: NOW, pr: { url: URL_A, status: 'open' } };
    const sessions = h.deps.sessions;
    h.deps.sessions = () => [...sessions(), other];
    h.data.set(KEY, { since: iso(5) });
    h.state.activity = [item({ at: iso(1) })];
    await createSessionPrWatch(h.deps).tick();
    expect(h.state.asks).toEqual([]);
    expect(h.state.delivered).toEqual([]);
  });
});

describe('entry point wiring (#930)', () => {
  it('the daemon gives the watch the activity reader, the App login and the bot allow list', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const index = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf-8');
    expect(index).toContain('fetchActivity: fetchGitHubPullActivity');
    expect(index).toMatch(/ownLogin: async \(\) =>/);
    expect(index).toContain('botLogins: config.github.prWatchBots');
  });
});

describe('session PR watch — reviews and comments, round 2 (#930)', () => {
  it('a change seen while the last activity message waits is read once that message lands — not lost behind the ETag', async () => {
    const h = harness();
    h.state.holdDone = true;
    h.data.set(KEY, { since: iso(10) });
    h.state.activity = [item({ author: 'alice', at: iso(5) })];
    const watch = createSessionPrWatch(h.deps);
    await watch.tick();
    expect(h.state.delivered).toHaveLength(1);
    // Bob comments while Alice's message waits: the PR answers 200 with a new ETag.
    h.state.activity.push(item({ author: 'bob', association: 'COLLABORATOR', at: iso(2) }));
    h.state.pull = { number: 12, status: 'open', etag: 'W/"2"' };
    await watch.tick();
    expect(h.state.delivered).toHaveLength(1);
    h.state.waiting[0]?.('injected');
    // Only 304s from now on: Bob's comment is still read.
    h.state.pull = 'not-modified';
    h.state.holdDone = false;
    await watch.tick();
    expect(h.state.delivered).toHaveLength(2);
    expect(h.state.delivered[1]).toContain('@bob');
    expect(h.state.delivered[1]).not.toContain('@alice');
  });

  it("the bot's own login unknown at first: the changed PR is read once it is known, even on a 304 — asked again only every 10 minutes (#930 round 3)", async () => {
    let login: string | undefined;
    let t = NOW;
    let loginAsks = 0;
    const h = harness({
      now: () => t,
      ownLogin: async () => {
        loginAsks++;
        return login;
      },
    });
    h.data.set(KEY, { since: iso(10) });
    h.state.activity = [item({ at: iso(2) })];
    const watch = createSessionPrWatch(h.deps);
    await watch.tick();
    expect(h.state.asks).toEqual([]);
    login = 'zhuge-liang-bot[bot]';
    h.state.pull = 'not-modified';
    // A failed login read is not repeated every tick (GET /app warns on each failure).
    await watch.tick();
    expect(loginAsks).toBe(1);
    expect(h.state.delivered).toEqual([]);
    t = NOW + 10 * 60_000 + 1;
    await watch.tick();
    expect(loginAsks).toBe(2);
    expect(h.state.delivered).toHaveLength(1);
    // Known now: not asked again.
    t += 60_000;
    await watch.tick();
    expect(loginAsks).toBe(2);
  });

  it('an allowed bot that comes with a person does not use up a bot round; bot-only activity does', async () => {
    const h = harness();
    h.data.set(KEY, { since: iso(30), botWakes: 2 });
    h.state.activity = [
      item({ author: 'coderabbitai[bot]', bot: true, association: 'NONE', at: iso(20) }),
      item({ author: 'alice', at: iso(19) }),
    ];
    const watch = createSessionPrWatch(h.deps);
    await watch.tick();
    expect(h.state.delivered[0]).toContain('@coderabbitai[bot]');
    expect(h.data.get(KEY)?.botWakes).toBe(2);
    h.state.activity.push(item({ author: 'coderabbitai[bot]', bot: true, association: 'NONE', at: iso(10) }));
    h.state.pull = { number: 12, status: 'open', etag: 'W/"2"' };
    await watch.tick();
    expect(h.state.delivered).toHaveLength(2);
    expect(h.data.get(KEY)?.botWakes).toBe(3);
  });

  it('a waiting activity message stops being current when the PR merges or leaves the card', async () => {
    const h = harness();
    h.state.holdDone = true;
    h.data.set(KEY, { since: iso(10) });
    h.state.activity = [item({ at: iso(2) })];
    const watch = createSessionPrWatch(h.deps);
    await watch.tick();
    const current = h.state.currents[0];
    expect(current?.()).toBe(true);
    h.session.pr = { url: 'https://github.com/acme/app/pull/99', status: 'open' };
    await watch.tick();
    expect(current?.()).toBe(false);
  });

  it('an activity message dropped before it ran is read again, even on a 304 (#930 round 3)', async () => {
    const h = harness();
    h.state.holdDone = true;
    h.data.set(KEY, { since: iso(10) });
    h.state.activity = [item({ at: iso(2) })];
    const watch = createSessionPrWatch(h.deps);
    await watch.tick();
    expect(h.state.delivered).toHaveLength(1);
    // Dropped (the card moved away and back while it waited): not recorded, and remembered as unread.
    h.state.waiting[0]?.('gone');
    expect(h.data.get(KEY)?.since).toBe(iso(10));
    h.state.pull = 'not-modified';
    h.state.holdDone = false;
    await watch.tick();
    expect(h.state.delivered).toHaveLength(2);
    expect(h.data.get(KEY)?.since).toBe(iso(2));
  });

  it('a waiting activity message asks the live sessions who owns the PR — no tick in between (#930 round 3)', async () => {
    const h = harness();
    h.state.holdDone = true;
    h.data.set(KEY, { since: iso(10) });
    h.state.activity = [item({ at: iso(2) })];
    const sessions = h.deps.sessions;
    await createSessionPrWatch(h.deps).tick();
    const current = h.state.currents[0];
    expect(current?.()).toBe(true);
    const other: WatchCandidate = { sessionKey: 's2', lastActivityMs: NOW, pr: { url: URL_A, status: 'open' } };
    h.deps.sessions = () => [...sessions(), other];
    expect(current?.()).toBe(false);
  });
});
