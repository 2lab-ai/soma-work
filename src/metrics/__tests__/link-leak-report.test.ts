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
 *   K7  creatorsOf / creatorDays: the creator is the first session that recorded a PR; the metrics days read cover
 *       the window whatever the report timezone
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type BotItem,
  cardUrlsOf,
  computeLinkLeakReport,
  creatorDays,
  creatorsOf,
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

  it('K4 — a long list keeps whole lines, each block within Slack’s limit, and lists every item (review P3; round 3)', () => {
    const many = Array.from({ length: 200 }, (_, i) => pr('2lab-ai/soma-work', 1000 + i));
    const { blocks } = formatLinkLeakReport(computeLinkLeakReport(many, [], new Map()), {
      date: '2026-11-03',
      alert: false,
      streak: 0,
      baselineDays: 1,
    });
    const lists = blocks.slice(1).filter((b) => b.type === 'section');
    expect(lists.length).toBeGreaterThan(1);
    expect(blocks.length).toBeLessThanOrEqual(50);
    const lines = lists.flatMap((b) => {
      expect((b.text.text as string).length).toBeLessThanOrEqual(3000);
      return (b.text.text as string).split('\n').filter((l) => l.startsWith('• '));
    });
    expect(lines).toHaveLength(200);
    for (const line of lines) expect(line).toMatch(/^• <https:\/\/github\.com\/[^>]+>/);
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
    // Every page is read.
    const pages = vi.fn(async (url: string) => {
      if (url.includes('/search/issues')) {
        const page = Number(new URL(url).searchParams.get('page'));
        const items = Array.from({ length: page === 1 ? 100 : 30 }, (_, i) => ({
          html_url: `https://github.com/a/b/issues/${page * 1000 + i}`,
          number: page * 1000 + i,
          created_at: '2026-11-03T01:00:00Z',
        }));
        return { ok: true, json: async () => ({ total_count: 130, items }) };
      }
      return { ok: true, json: async () => ({}) };
    });
    const all = await fetchBotItems({ token: 't', botLogin: 'x', sinceIso: 'y', fetchImpl: pages as never });
    expect(all).toHaveLength(130);
    expect(pages).toHaveBeenCalledTimes(2);
    const failing = vi.fn(async () => ({ ok: false, json: async () => ({}) }));
    expect(
      await fetchBotItems({ token: 't', botLogin: 'x', sinceIso: 'y', fetchImpl: failing as never }),
    ).toBeUndefined();
  });

  it('K3 — a day with no bot item is no evidence: it neither counts toward nor breaks the streak (review P2-1)', () => {
    const day = (d: number, total: number, missed: number) => ({
      date: `2026-11-${String(d).padStart(2, '0')}`,
      total,
      missed,
      wrong: 0,
    });
    expect(zeroStreak([day(1, 0, 0), day(2, 0, 0), day(3, 0, 0)])).toBe(0);
    expect(zeroStreak([day(1, 5, 1), day(2, 4, 0), day(3, 0, 0), day(4, 6, 0)])).toBe(2);
  });

  it('K7 — the creator is the first session that recorded the PR, not a later one that read it (review P1-1)', () => {
    const since = Date.parse('2026-11-02T00:00:00Z');
    const ev = (sessionKey: string, url: string, at: string) => ({
      eventType: 'pr_created',
      sessionKey,
      timestamp: Date.parse(at),
      metadata: { prUrl: url, proven: true },
    });
    const creators = creatorsOf(
      [
        ev('S0', 'https://github.com/a/b/pull/1', '2026-11-01T23:00:00Z'), // before the window
        ev('S1', 'https://github.com/a/b/pull/824', '2026-11-02T01:00:00Z'),
        ev('S2', 'https://github.com/a/b/pull/824/files', '2026-11-02T03:00:00Z'),
        { eventType: 'pr_merged', sessionKey: 'S3', timestamp: Date.parse('2026-11-02T00:30:00Z'), metadata: {} },
      ],
      since,
    );
    expect([...creators]).toEqual([['https://github.com/a/b/pull/824', 'S1']]);
  });

  it('K7 — the metrics days read cover the report window in any timezone (review P2-2)', () => {
    // 02:30 in Seoul on 4 November is 17:30 UTC on 3 November: the Seoul partition 2026-11-04 must be read.
    const now = Date.parse('2026-11-03T17:30:00Z');
    const [from, to] = creatorDays(now - 24 * 60 * 60 * 1000, now);
    expect(from <= '2026-11-01').toBe(true);
    expect(to >= '2026-11-04').toBe(true);
  });

  it('K5 — whole seconds in the query; one unreadable PR does not void the day; an incomplete search fails (review P1-2, P2-3, P2-4, P2-5)', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes('/search/issues')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            total_count: 2,
            items: [
              { html_url: 'https://github.com/a/b/pull/8', created_at: '2026-11-03T01:00:00Z', pull_request: {} },
              { html_url: 'https://github.com/a/b/pull/9', created_at: '2026-11-03T02:00:00Z', pull_request: {} },
            ],
          }),
        };
      }
      return url.endsWith('/8')
        ? { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) }
        : { ok: true, status: 200, json: async () => ({ base: { ref: 'main' }, head: { ref: 'feat/y' } }) };
    });
    const items = await fetchBotItems({
      token: 't',
      botLogin: 'bot',
      sinceIso: '2026-11-02T03:00:00.123Z',
      fetchImpl: fetchImpl as never,
    });
    expect(decodeURIComponent(calls[0])).toContain('created:>=2026-11-02T03:00:00Z');
    // Round 3: the unreadable PR is counted and flagged (K8), not dropped.
    expect(items?.map((i) => i.number)).toEqual([8, 9]);
    const incomplete = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ incomplete_results: true, total_count: 1, items: [] }),
    }));
    expect(
      await fetchBotItems({ token: 't', botLogin: 'x', sinceIso: 'y', fetchImpl: incomplete as never }),
    ).toBeUndefined();
  });

  describe('K8 — review round 3 (astra-zhuge)', () => {
    it('a PR whose details cannot be read is counted, flagged, and named in the post — never a clean day (P1)', async () => {
      const fetchImpl = vi.fn(async (url: string) => {
        if (url.includes('/search/issues')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              total_count: 2,
              items: [
                { html_url: 'https://github.com/a/b/pull/8', created_at: '2026-11-03T01:00:00Z', pull_request: {} },
                { html_url: 'https://github.com/a/b/pull/9', created_at: '2026-11-03T02:00:00Z', pull_request: {} },
              ],
            }),
          };
        }
        return url.endsWith('/8')
          ? { ok: false, status: 503, json: async () => ({ message: 'unavailable' }) }
          : { ok: true, status: 200, json: async () => ({ base: { ref: 'main' }, head: { ref: 'feat/y' } }) };
      });
      const items = await fetchBotItems({ token: 't', botLogin: 'bot', sinceIso: 'x', fetchImpl: fetchImpl as never });
      expect(items?.map((i) => [i.number, i.unverified ?? false])).toEqual([
        [8, true],
        [9, false],
      ]);
      const report = computeLinkLeakReport(items ?? [], [card('S1', ['https://github.com/a/b/pull/9'])], new Map());
      expect([report.total, report.missed.length]).toEqual([2, 1]);
      const text = formatLinkLeakReport(report, { date: '2026-11-03', alert: false, streak: 0, baselineDays: 7 })
        .blocks.map((b) => b.text?.text ?? '')
        .join('\n');
      expect(text).toContain('could not be read');
    });

    it('only a proven create names the creator; an unproven pr_created leaves it unknown (P1)', () => {
      const since = 0;
      const ev = (sessionKey: string, proven: boolean, at: number) => ({
        eventType: 'pr_created',
        sessionKey,
        timestamp: at,
        metadata: { prUrl: 'https://github.com/a/b/pull/5', ...(proven ? { proven: true } : {}) },
      });
      // B only read the PR (an old-style pr_created with no proof), A created it.
      expect([...creatorsOf([ev('B', false, 1), ev('A', true, 2)], since)]).toEqual([
        ['https://github.com/a/b/pull/5', 'A'],
      ]);
      expect([...creatorsOf([ev('B', false, 1)], since)]).toEqual([]);
    });

    it('every missed item is listed, across as many blocks as it takes (P2)', () => {
      const many = Array.from({ length: 40 }, (_, i) => ({ ...pr('a/b', 100 + i), title: 'x'.repeat(200) }));
      const report = computeLinkLeakReport(many, [], new Map());
      const text = formatLinkLeakReport(report, { date: '2026-11-03', alert: false, streak: 0, baselineDays: 7 })
        .blocks.map((b) => b.text?.text ?? '')
        .join('\n');
      for (let i = 0; i < 40; i++) expect(text).toContain(`a/b#${100 + i}>`);
      expect(text).not.toContain('more');
    });

    it('a search past GitHub’s 1,000-result ceiling fails instead of looking complete (P2)', async () => {
      const full = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          total_count: 1001,
          items: Array.from({ length: 100 }, (_, i) => ({
            html_url: `https://github.com/a/b/issues/${i}`,
            created_at: '2026-11-03T01:00:00Z',
          })),
        }),
      }));
      expect(
        await fetchBotItems({ token: 't', botLogin: 'x', sinceIso: 'y', fetchImpl: full as never }),
      ).toBeUndefined();
    });

    it('a GitHub title cannot mention anyone or add a link (P2)', () => {
      const report = computeLinkLeakReport(
        [{ ...pr('a/b', 7), title: '<!channel> <@U123> <https://evil|x> & co' }],
        [],
        new Map(),
      );
      const text = formatLinkLeakReport(report, { date: '2026-11-03', alert: false, streak: 0, baselineDays: 7 })
        .blocks.map((b) => b.text?.text ?? '')
        .join('\n');
      expect(text).not.toContain('<!channel>');
      expect(text).not.toContain('<@U123>');
      expect(text).toContain('&lt;!channel&gt;');
      expect(text).toContain('<https://github.com/a/b/pull/7|a/b#7>');
    });

    it('a day without a report breaks the streak; a measured day with no items does not (P2)', () => {
      const d = (date: string, total: number, missed: number) => ({ date, total, missed, wrong: 0 });
      expect(zeroStreak([d('2026-11-01', 3, 0), d('2026-11-02', 3, 0), d('2026-11-04', 3, 0)])).toBe(1);
      expect(zeroStreak([d('2026-11-01', 3, 0), d('2026-11-02', 0, 0), d('2026-11-03', 3, 0)])).toBe(2);
    });

    it('the baseline median counts only days with bot items (fable P3)', () => {
      const d = (n: number, total: number, missed: number) => ({
        date: `2026-11-${String(n).padStart(2, '0')}`,
        total,
        missed,
        wrong: 0,
      });
      const quiet = [d(1, 0, 0), d(2, 0, 0), d(3, 0, 0), d(4, 0, 0), d(5, 5, 2), d(6, 5, 2), d(7, 5, 2)];
      // Only 3 measured days: not a baseline yet.
      expect(shouldAlert(quiet, d(8, 5, 1))).toBe(false);
    });
  });

  it('K6 — a live state older than its .bak is not trusted: the newer copy wins, no re-post (astra P2)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leak-state-'));
    try {
      const statePath = path.join(dir, 'link-leak-report.json');
      const day = (date: string) => ({ date, total: 1, missed: 0, wrong: 0 });
      fs.writeFileSync(statePath, JSON.stringify({ lastRunDate: '2026-11-02', history: [day('2026-11-02')] }));
      fs.writeFileSync(
        `${statePath}.bak`,
        JSON.stringify({ lastRunDate: '2026-11-03', history: [day('2026-11-02'), day('2026-11-03')] }),
      );
      const publish = vi.fn(async () => true);
      const reporter = new LinkLeakReporter({
        collectItems: vi.fn(async () => [pr('a/b', 1)]),
        collectCards: () => [],
        collectCreators: async () => new Map(),
        publish,
        statePath,
        timezone: 'Asia/Seoul',
        hour: 9,
        now: () => Date.parse('2026-11-03T00:30:00Z'),
      });
      await reporter.tick();
      expect(publish).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('K9 — review round 4 (astra-zhuge)', () => {
    it('every item is named up to the collector’s 1,000: long titles fall back to compact lines (P2)', () => {
      const many = Array.from({ length: 1000 }, (_, i) => ({
        ...pr('2lab-ai/soma-work', 10_000 + i),
        title: 'x'.repeat(200),
      }));
      const sessions = Array.from({ length: 40 }, (_, i) => `S${i}`);
      const creators = new Map(many.map((m, i) => [m.url, sessions[i % 40]] as const));
      const { blocks } = formatLinkLeakReport(computeLinkLeakReport(many, [], creators), {
        date: '2026-11-03',
        alert: false,
        streak: 0,
        baselineDays: 7,
      });
      expect(blocks.length).toBeLessThanOrEqual(50);
      const text = blocks.map((b) => b.text?.text ?? '').join('\n');
      for (let i = 0; i < 1000; i++) expect(text).toContain(`soma-work#${10_000 + i}>`);
      expect(text).not.toMatch(/and \d+ more/);
      for (const b of blocks) expect((b.text?.text ?? '').length).toBeLessThanOrEqual(3000);
    });

    it('the baseline notice counts days with bot items, as the alert does (P3)', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leak-base-'));
      try {
        const statePath = path.join(dir, 'link-leak-report.json');
        const d = (n: number, total: number) => ({ date: `2026-10-${20 + n}`, total, missed: 0, wrong: 0 });
        const history = [d(1, 0), d(2, 0), d(3, 0), d(4, 0), d(5, 3), d(6, 3), d(7, 3)];
        fs.writeFileSync(statePath, JSON.stringify({ lastRunDate: '2026-10-27', history }));
        const reporter = new LinkLeakReporter({
          collectItems: vi.fn(async () => [pr('a/b', 1)]),
          collectCards: () => [],
          collectCreators: async () => new Map(),
          publish: vi.fn(async () => true),
          statePath,
          timezone: 'Asia/Seoul',
          hour: 9,
          now: () => Date.parse('2026-11-03T00:30:00Z'),
        });
        const now = await reporter.runNow();
        expect(now?.blocks[0].text.text).toContain('Baseline: day 3 of 7');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
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
      // The failed post is not recorded; the retry waits 15 minutes.
      expect(fs.existsSync(s.deps.statePath)).toBe(false);
      await s.reporter.tick();
      expect(publish).toHaveBeenCalledTimes(1);
      s.setNow(Date.parse('2026-11-03T00:15:00Z'));
      await s.reporter.tick();
      expect(publish).toHaveBeenCalledTimes(2);
      const state = JSON.parse(fs.readFileSync(s.deps.statePath, 'utf8'));
      expect(state.lastRunDate).toBe('2026-11-03');
      expect(state.history).toEqual([{ date: '2026-11-03', total: 2, missed: 1, wrong: 0 }]);
      // Same day: nothing more. A broken state file falls back to its .bak (review P2).
      await s.reporter.tick();
      fs.writeFileSync(s.deps.statePath, '{broken');
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
      // The next try waits 15 minutes, not one (review P1).
      await s.reporter.tick();
      expect(s.deps.collectItems).toHaveBeenCalledTimes(1);
      s.setNow(Date.parse('2026-11-03T00:16:00Z'));
      await s.reporter.tick();
      expect(s.deps.collectItems).toHaveBeenCalledTimes(2);
      const s2 = setup();
      const now = await s2.reporter.runNow();
      expect(now?.text).toContain('1 of 2');
      expect(fs.existsSync(s2.deps.statePath)).toBe(false);
    });
  });
});
