/**
 * #835 (epic #831) — the daily leak report: bot-authored, non-deploy PRs and issues opened in the last 24 hours, against
 * the links on every task card. On 3 November 2026 the figure was 9 of 15.
 *
 *   K1  computeLinkLeakReport: each bot item is on a card or missed; one on cards but not its creator's is a wrong card;
 *       counts per creating session ('unknown' when no write effect named one); URLs compare canonically
 *   K2  cardUrlsOf: a card's links and history, canonical, each once
 *   K3  shouldAlert / zeroStreak: no alert before a baseline week; then only above the week's median; the run of
 *       zero-miss days (the epic's "3 days in a row")
 *   K4  formatLinkLeakReport: the figure, every missed and wrong-card item by number, the streak, the alert line
 *   K5  fetchBotItems: GitHub search for the App's items since a time; deploy PRs (base or head deploy/*) dropped;
 *       a failed query is undefined
 *   K6  LinkLeakReporter: once a day at the configured hour, records the day's figures (atomic state) and posts;
 *       a failed post is retried next minute; runNow reports without recording
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type BotItem,
  cardUrlsOf,
  computeLinkLeakReport,
  fetchBotItems,
  formatLinkLeakReport,
  LinkLeakReporter,
  shouldAlert,
  zeroStreak,
} from '../link-leak-report';

const pr = (repo: string, n: number, createdAt = '2026-11-03T01:00:00Z'): BotItem => ({
  url: `https://github.com/${repo}/pull/${n}`,
  kind: 'pr',
  repo,
  number: n,
  title: `PR ${n}`,
  createdAt,
});
const issue = (repo: string, n: number): BotItem => ({
  url: `https://github.com/${repo}/issues/${n}`,
  kind: 'issue',
  repo,
  number: n,
  createdAt: '2026-11-03T01:00:00Z',
});
const card = (sessionKey: string, prs: string[], issues: string[] = [], current?: string) => ({
  sessionKey,
  title: `card ${sessionKey}`,
  links: current ? { pr: { url: current } } : {},
  linkHistory: { prs: prs.map((url) => ({ url })), issues: issues.map((url) => ({ url })), docs: [] },
});

describe('link leak report (#835)', () => {
  it('K1 — on a card, missed, or on the wrong card; counted per creating session', () => {
    const items = [
      pr('2lab-ai/soma-work', 823),
      pr('2lab-ai/soma-work', 824),
      pr('2lab-ai/ui', 17),
      issue('2lab-ai/soma-work', 831),
      pr('2lab-ai/soma-work', 900),
    ];
    const cards = [
      card(
        'S1',
        ['https://github.com/2lab-ai/soma-work/pull/823/files'],
        ['https://github.com/2lab-ai/soma-work/issues/831'],
      ),
      // #824 was made by S1 but sits only on S2's card.
      card('S2', [], [], 'https://github.com/2lab-ai/soma-work/pull/824'),
    ];
    const creators = new Map([
      ['https://github.com/2lab-ai/soma-work/pull/823', 'S1'],
      ['https://github.com/2lab-ai/soma-work/pull/824', 'S1'],
      ['https://github.com/2lab-ai/ui/pull/17', 'S1'],
    ]);
    const r = computeLinkLeakReport(items, cards, creators);
    expect(r.total).toBe(5);
    expect(r.onCard).toBe(3);
    expect(r.missed.map((i) => i.url)).toEqual([
      'https://github.com/2lab-ai/ui/pull/17',
      'https://github.com/2lab-ai/soma-work/pull/900',
    ]);
    expect(r.wrongCard).toEqual([{ item: items[1], creator: 'S1', cards: ['S2'] }]);
    expect(r.bySession).toEqual([
      { sessionKey: 'S1', missed: 1, wrong: 1 },
      { sessionKey: 'unknown', missed: 1, wrong: 0 },
    ]);
  });

  it('K2 — a card URL set: current and history, canonical, each once', () => {
    expect(
      cardUrlsOf({
        links: {
          pr: { url: 'https://github.com/a/b/pull/1/files?x' },
          issue: { url: 'https://github.com/a/b/issues/2' },
        },
        linkHistory: {
          prs: [{ url: 'https://github.com/a/b/pull/1' }, null, { url: 7 }] as never,
          issues: [],
          docs: [],
        },
      }).sort(),
    ).toEqual(['https://github.com/a/b/issues/2', 'https://github.com/a/b/pull/1']);
    expect(cardUrlsOf(undefined)).toEqual([]);
  });

  it('K3 — no alert before a baseline week; then above the median; the zero-miss streak', () => {
    const day = (d: number, missed: number) => ({
      date: `2026-11-${String(d).padStart(2, '0')}`,
      total: 10,
      missed,
      wrong: 0,
    });
    const week = [3, 1, 2, 9, 2, 0, 1].map((m, i) => day(i + 1, m));
    expect(shouldAlert(week.slice(0, 6), day(7, 50))).toBe(false);
    // median of [3,1,2,9,2,0,1] = 2
    expect(shouldAlert(week, day(8, 2))).toBe(false);
    expect(shouldAlert(week, day(8, 3))).toBe(true);
    expect(zeroStreak([...week, day(8, 0), day(9, 0)])).toBe(2);
    expect(zeroStreak([day(1, 0), day(2, 1)])).toBe(0);
  });

  it('K4 — the message names the figure, each item by number, the streak and the alert', () => {
    const r = computeLinkLeakReport(
      [pr('2lab-ai/soma-work', 823), pr('2lab-ai/ui', 17)],
      [card('S1', ['https://github.com/2lab-ai/soma-work/pull/823'])],
      new Map([['https://github.com/2lab-ai/ui/pull/17', 'S9']]),
    );
    const { text, blocks } = formatLinkLeakReport(r, { date: '2026-11-03', alert: true, streak: 0, baselineDays: 8 });
    expect(text).toContain('1 of 2');
    const body = JSON.stringify(blocks);
    expect(body).toContain('2lab-ai/ui#17');
    expect(body).toContain('S9');
    expect(body).toContain(':rotating_light:');
    const quiet = formatLinkLeakReport(computeLinkLeakReport([], [], new Map()), {
      date: '2026-11-04',
      alert: false,
      streak: 3,
      baselineDays: 2,
    });
    expect(quiet.text).toContain('0 of 0');
    expect(JSON.stringify(quiet.blocks)).toContain('3');
    expect(JSON.stringify(quiet.blocks)).not.toContain(':rotating_light:');
  });

  it('K5 — GitHub search for the App items since a time; deploy PRs dropped; a failure is undefined', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes('/search/issues')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                html_url: 'https://github.com/a/b/pull/5',
                number: 5,
                title: 'feat',
                created_at: '2026-11-03T01:00:00Z',
                pull_request: {},
              },
              {
                html_url: 'https://github.com/a/b/pull/6',
                number: 6,
                title: 'deploy',
                created_at: '2026-11-03T02:00:00Z',
                pull_request: {},
              },
              {
                html_url: 'https://github.com/a/b/issues/7',
                number: 7,
                title: 'bug',
                created_at: '2026-11-03T03:00:00Z',
              },
            ],
          }),
        };
      }
      const n = Number(url.split('/').pop());
      return {
        ok: true,
        json: async () => ({
          base: { ref: n === 6 ? 'deploy/dev' : 'main' },
          head: { ref: n === 6 ? 'main' : 'feat/x' },
        }),
      };
    });
    const items = await fetchBotItems({
      token: 't',
      botLogin: 'zhuge-liang-bot',
      sinceIso: '2026-11-02T03:00:00Z',
      fetchImpl: fetchImpl as never,
    });
    expect(decodeURIComponent(calls[0])).toContain('author:app/zhuge-liang-bot created:>=2026-11-02T03:00:00Z');
    expect(items?.map((i) => [i.kind, i.repo, i.number])).toEqual([
      ['pr', 'a/b', 5],
      ['issue', 'a/b', 7],
    ]);
    const failing = vi.fn(async () => ({ ok: false, json: async () => ({}) }));
    expect(
      await fetchBotItems({ token: 't', botLogin: 'x', sinceIso: 'y', fetchImpl: failing as never }),
    ).toBeUndefined();
  });

  describe('K6 — LinkLeakReporter', () => {
    const dirs: string[] = [];
    afterEach(() => {
      for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
    });

    function setup(over: Partial<ConstructorParameters<typeof LinkLeakReporter>[0]> = {}) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leak-'));
      dirs.push(dir);
      let now = Date.parse('2026-11-03T00:00:00Z'); // 09:00 Asia/Seoul
      const published: string[] = [];
      const deps = {
        collectItems: vi.fn(async () => [pr('a/b', 1), pr('a/b', 2)]),
        collectCards: vi.fn(() => [card('S1', ['https://github.com/a/b/pull/1'])]),
        collectCreators: vi.fn(async () => new Map<string, string>()),
        publish: vi.fn(async (text: string) => {
          published.push(text);
          return true;
        }),
        statePath: path.join(dir, 'link-leak-report.json'),
        timezone: 'Asia/Seoul',
        hour: 9,
        now: () => now,
        ...over,
      };
      return { deps, reporter: new LinkLeakReporter(deps), published, setNow: (ms: number) => (now = ms), dir };
    }

    it('posts once a day at the hour, records the figures, retries a failed post', async () => {
      const publish = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
      const s = setup({ publish });
      await s.reporter.tick();
      expect(publish).toHaveBeenCalledTimes(1);
      // The failed post is not recorded: the next minute retries.
      expect(fs.existsSync(s.deps.statePath)).toBe(false);
      await s.reporter.tick();
      expect(publish).toHaveBeenCalledTimes(2);
      const state = JSON.parse(fs.readFileSync(s.deps.statePath, 'utf8'));
      expect(state.lastRunDate).toBe('2026-11-03');
      expect(state.history).toEqual([{ date: '2026-11-03', total: 2, missed: 1, wrong: 0 }]);
      // Same day: nothing more.
      await s.reporter.tick();
      expect(publish).toHaveBeenCalledTimes(2);
      // Another hour of the next day: not yet.
      s.setNow(Date.parse('2026-11-03T23:00:00Z')); // 08:00 next day in Seoul
      await s.reporter.tick();
      expect(publish).toHaveBeenCalledTimes(2);
    });

    it('a failed GitHub query posts nothing and records nothing; runNow reports without recording', async () => {
      const s = setup({ collectItems: vi.fn(async () => undefined) });
      await s.reporter.tick();
      expect(s.deps.publish).not.toHaveBeenCalled();
      const s2 = setup();
      const now = await s2.reporter.runNow();
      expect(now?.text).toContain('1 of 2');
      expect(fs.existsSync(s2.deps.statePath)).toBe(false);
    });
  });
});
