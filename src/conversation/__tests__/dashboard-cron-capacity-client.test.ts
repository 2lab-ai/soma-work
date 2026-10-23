/**
 * SSOT 2026-10-23 — dashboard client half. Executes the shipped client code
 * cut out of renderDashboardPage()'s template (harness of
 * dashboard-live-surfaces-client.test.ts):
 *
 *   T3   a cron card carries a CRON badge at the left of its head
 *   T4   cron cards leave the three columns for the CRON lane, grouped by job
 *   T5   a job tile: schedule, next run, last-N run strip; drawer rows per run
 *   T7   the capacity rows between the stats strip and the inbox
 *   T9   piecewise time axis (0–24h dense, then days), markers never lost,
 *        empty/low rows lead with the countdown to the first return
 *   T10  markers coloured by subscription tier, with a text label
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));

function cook(fragment: string): string {
  if (fragment.includes('`') || fragment.includes('${')) throw new Error('fragment is not a plain template slice');
  return new Function(`return \`${fragment}\`;`)() as string;
}
function assertUnique(name: string) {
  const re = new RegExp(`^(?:async function|function|var|let|const) ${name}\\b`, 'gm');
  const n = (TEMPLATE.match(re) ?? []).length;
  if (n > 1) throw new Error(`client ${name} is declared ${n} times`);
}
function clientFn(name: string): string {
  assertUnique(name);
  const plain = TEMPLATE.indexOf(`\nfunction ${name}(`);
  const start = plain >= 0 ? plain : TEMPLATE.indexOf(`\nasync function ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = TEMPLATE.indexOf('\n}\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 2));
}
function clientVar(name: string): string {
  assertUnique(name);
  const m = TEMPLATE.match(new RegExp(`^(var ${name} = .*?;)(?:\\s*//.*)?$`, 'm'));
  if (!m) throw new Error(`client var ${name} not found`);
  return cook(m[1]);
}
function load<T>(fns: string[], vars: string[], inject: Record<string, unknown> = {}): T {
  const names = Object.keys(inject);
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}

const SHOW_ALL = {
  dhShow: () => true,
  dhMax: (_f: string, d: number) => d,
  dhTruncate: () => null,
  currentUserId: 'U1',
};
const FACE_FNS = [
  'esc',
  'escAttr',
  'escJs',
  'toNum',
  'formatTokens',
  'formatCount',
  'cardTotalTokens',
  'cardCurrentTask',
  'renderCardTaskRow',
  'renderCardUsage',
  'formatTaskTime',
  'pendingAutoResume',
  'autoResumeLabel',
  'cardSummary',
  'renderCardStatus',
  'renderOwnerBadge',
  'renderCronBadge',
  'renderCardFace',
];
const FACE_VARS = ['SPARK_SVG', 'WAIT_SVG', 'TASKS_SVG', 'CTX_SVG', 'RESUME_SVG', 'CLOCK_SVG'];

function card(over: Record<string, unknown> = {}) {
  return {
    key: 'inst::C1:t1',
    displayHeadline: 'nightly-qa',
    title: 'nightly-qa',
    ownerId: 'U1',
    ownerName: 'Z',
    activityState: 'working',
    activeLegStartedAtMs: 1,
    activeAccumulatedMs: 0,
    lastActivity: '2026-10-23T04:00:30.000Z',
    channelId: 'C1',
    threadTs: 't1',
    ...over,
  };
}

describe('T3 — CRON badge at the left of the card head', () => {
  const face = load<{ renderCardFace: (s: unknown, col: string) => string }>(FACE_FNS, FACE_VARS, SHOW_ALL);

  it('a cron card leads its head with the badge (clock + CRON), job name in the tooltip', () => {
    const html = face.renderCardFace(
      card({ cronJob: { id: 'job-1', name: 'nightly-qa' }, displayHeadline: 'QA pass: orders API' }),
      'working',
    );
    const head = html.slice(0, html.indexOf('</div>'));
    expect(head.indexOf('cron-badge')).toBeGreaterThan(-1);
    expect(head.indexOf('cron-badge')).toBeLessThan(head.indexOf('card-title-text'));
    expect(head).toContain('CRON');
    expect(head).toContain('nightly-qa');
    expect(head).toContain('QA pass: orders API');
  });

  it('a human card keeps the spark and has no badge', () => {
    const html = face.renderCardFace(card(), 'working');
    expect(html).not.toContain('cron-badge');
    expect(html).toContain('card-spark');
  });
});

describe('T4/T5 — planCronLane', () => {
  const lane = load<{
    planCronLane: (board: any, jobs: any[], revealKey?: string) => any;
  }>(['isCronCard', 'cronGroupKey', 'cronCardTime', 'planCronLane'], []);

  const board = () => ({
    working: [card({ key: 'k-run', cronJob: { id: 'job-1', name: 'nightly-qa' } }), card({ key: 'k-human' })],
    waiting: [
      card({
        key: 'k-wait',
        activityState: 'waiting',
        cronJob: { id: 'job-2', name: 'nightly-report' },
        lastActivity: '2026-10-23T01:00:00.000Z',
      }),
    ],
    idle: [
      card({
        key: 'k-old',
        activityState: 'idle',
        cronJob: { id: 'job-1', name: 'nightly-qa' },
        lastActivity: '2026-10-23T03:00:30.000Z',
      }),
    ],
    closed: [],
  });
  const jobs = [
    { id: 'job-1', name: 'nightly-qa', expression: '0 * * * *', nextRunAt: 2, runs: [] },
    { id: 'job-3', name: 'never-ran', expression: '0 9 * * 1-5', nextRunAt: 3, runs: [] },
  ];

  it('removes every cron card from the columns and keeps the human ones', () => {
    const plan = lane.planCronLane(board(), jobs);
    expect(plan.board.working.map((s: any) => s.key)).toEqual(['k-human']);
    expect(plan.board.waiting).toEqual([]);
    expect(plan.board.idle).toEqual([]);
  });

  it('one group per job — runs of the same job together, newest first', () => {
    const plan = lane.planCronLane(board(), jobs);
    const g1 = plan.groups.find((g: any) => g.jobId === 'job-1');
    expect(g1.cards.map((s: any) => s.key)).toEqual(['k-run', 'k-old']);
    expect(g1.job.expression).toBe('0 * * * *');
  });

  it('a job waiting on the user is pinned first and counted', () => {
    const plan = lane.planCronLane(board(), jobs);
    expect(plan.groups[0].jobId).toBe('job-2');
    expect(plan.groups[0].waiting).toBe(true);
    expect(plan.waitingCount).toBe(1);
    expect(plan.runningCount).toBe(1);
  });

  it("a deep-linked older run becomes its job's card", () => {
    const plan = lane.planCronLane(board(), jobs, 'k-old');
    expect(plan.groups.find((g: any) => g.jobId === 'job-1').lead.key).toBe('k-old');
    expect(lane.planCronLane(board(), jobs).groups.find((g: any) => g.jobId === 'job-1').lead.key).toBe('k-run');
  });

  it('a job with no card on the board still gets a tile; a card with no local job is another instance', () => {
    const plan = lane.planCronLane(board(), jobs);
    expect(plan.groups.find((g: any) => g.jobId === 'job-3').cards).toEqual([]);
    expect(plan.groups.find((g: any) => g.jobId === 'job-2').job).toBeNull();
  });
});

describe('T5 — run glyphs and schedule label', () => {
  const fns = load<{
    cronRunGlyph: (run: any) => { cls: string; glyph: string; label: string };
    cronScheduleLabel: (expr: string, nextRunAt: number | null) => string;
  }>(['pad2', 'cronRunGlyph', 'cronScheduleLabel'], []);

  it('every run state has its own glyph — colour is never the only signal', () => {
    expect(fns.cronRunGlyph({ status: 'success', session: { activityState: 'idle' } })).toMatchObject({
      glyph: '✓',
      cls: 'ok',
    });
    expect(fns.cronRunGlyph({ status: 'failed' })).toMatchObject({ glyph: '✗', cls: 'fail' });
    expect(fns.cronRunGlyph({ status: 'success', session: { activityState: 'working', live: true } })).toMatchObject({
      glyph: '●',
      cls: 'run',
    });
    expect(fns.cronRunGlyph({ status: 'success', session: { activityState: 'waiting', live: true } })).toMatchObject({
      glyph: '▲',
      cls: 'wait',
    });
    expect(fns.cronRunGlyph({ status: 'success', executionPath: 'dm' })).toMatchObject({ glyph: '◌', cls: 'none' });
    // A board card no history record backs is never shown as a success.
    expect(fns.cronRunGlyph({ status: 'unrecorded', session: { activityState: 'idle', live: true } })).toMatchObject({
      glyph: '◌',
      cls: 'none',
    });
    // Queued wins over the thread's live state: the entry has not run yet.
    expect(
      fns.cronRunGlyph({
        status: 'queued',
        executionPath: 'busy_queue',
        session: { activityState: 'working', live: true },
      }),
    ).toMatchObject({ glyph: '◌', cls: 'none' });
    expect(fns.cronRunGlyph({ status: 'queued', executionPath: 'busy_queue' })).toMatchObject({
      glyph: '◌',
      cls: 'none',
    });
  });

  it('humanizes the common schedules and falls back to the raw expression', () => {
    expect(fns.cronScheduleLabel('*/15 * * * *', null)).toBe('15분마다');
    expect(fns.cronScheduleLabel('0 * * * *', null)).toBe('매시 정각');
    expect(fns.cronScheduleLabel('30 * * * *', null)).toBe('매시 30분');
    expect(fns.cronScheduleLabel('0 */3 * * *', null)).toBe('3시간마다');
    expect(fns.cronScheduleLabel('0 9 1 * *', null)).toBe('0 9 1 * *');
  });

  it('daily schedules read in the viewer clock (cron is UTC)', () => {
    const next = new Date(2026, 9, 24, 18, 0, 0).getTime(); // local 18:00
    expect(fns.cronScheduleLabel('0 9 * * *', next)).toBe('매일 18:00');
    expect(fns.cronScheduleLabel('0 9 * * 1-5', next)).toBe('평일 18:00');
  });
});

describe('T5 — a run in progress shows before its history record exists', () => {
  const fns = load<{ planCronLane: (b: any, j: any[]) => any; cronGroupRuns: (g: any) => any[] }>(
    ['isCronCard', 'cronGroupKey', 'cronCardTime', 'planCronLane', 'cronCardAsRun', 'cronGroupRuns'],
    [],
  );
  it('merges the live card the history does not reference yet, newest first', () => {
    const board = {
      working: [
        card({
          key: 'k-now',
          cronJob: { id: 'job-1', name: 'nightly-qa' },
          activeLegStartedAtMs: Date.parse('2026-10-23T05:00:10Z'),
        }),
      ],
      waiting: [],
      idle: [],
      closed: [],
    };
    const jobs = [
      {
        id: 'job-1',
        name: 'nightly-qa',
        runs: [
          {
            executedAt: Date.parse('2026-10-23T04:00:04Z'),
            status: 'success',
            executionPath: 'new_thread',
            session: { boardKey: 'k-old' },
          },
        ],
      },
    ];
    const g = fns.planCronLane(board, jobs).groups[0];
    const runs = fns.cronGroupRuns(g);
    expect(runs.map((r: any) => r.session.boardKey)).toEqual(['k-now', 'k-old']);
    expect(runs[0].session).toMatchObject({ activityState: 'working', live: true });
  });
});

describe('T9 — capacity axis and markers', () => {
  const cap = load<{
    capAxisPct: (secondsAhead: number) => number;
    capCountdown: (secs: number) => string;
    capPackMarkers: (markers: any[], nowSec: number) => { placed: any[]; overflow: number };
  }>(['capAxisPct', 'capCountdown', 'capPackMarkers'], ['CAP_STOPS', 'CAP_LANES']);

  it('first 24h is piecewise over 0·1·3·6·12·24h (55% of the width), then days linear to 7d', () => {
    expect(cap.capAxisPct(0)).toBe(0);
    expect(cap.capAxisPct(3600)).toBeCloseTo(11, 5);
    expect(cap.capAxisPct(2 * 3600)).toBeCloseTo(16.5, 5);
    expect(cap.capAxisPct(24 * 3600)).toBeCloseTo(55, 5);
    expect(cap.capAxisPct(4 * 86400)).toBeCloseTo(55 + 45 * (3 / 6), 5);
    expect(cap.capAxisPct(7 * 86400)).toBeCloseTo(100, 5);
  });

  it('clamps the past to now and beyond 7d to the right edge', () => {
    expect(cap.capAxisPct(-50)).toBe(0);
    expect(cap.capAxisPct(30 * 86400)).toBe(100);
  });

  it('countdowns never round a 3h59m down to 3h', () => {
    expect(cap.capCountdown(3 * 3600 + 59 * 60 + 10)).toBe('3h 59m');
    expect(cap.capCountdown(41 * 60)).toBe('41m');
    expect(cap.capCountdown(5 * 86400 + 3 * 3600)).toBe('5d 3h');
    expect(cap.capCountdown(20)).toBe('<1m');
  });

  it('packs colliding markers into lanes, earliest first, and never drops the earliest', () => {
    const now = 1_000_000;
    const ms = [0, 60, 120, 180, 240].map((d, i) => ({ account: `a${i}`, at: now + 3600 + d }));
    const { placed, overflow } = cap.capPackMarkers(ms, now);
    expect(placed[0].m.account).toBe('a0');
    expect(placed[0].lane).toBe(0);
    expect(new Set(placed.map((p: any) => p.lane)).size).toBeGreaterThan(1);
    expect(placed.length + overflow).toBe(5);
  });
});

describe('T7/T9/T10 — capacity rows', () => {
  const NOW_S = 1_800_000_000;
  const view = {
    available: true,
    fetchedAtMs: NOW_S * 1000 - 12_000,
    groups: [
      {
        group: 'claude',
        label: 'Claude',
        availablePct: 75,
        availableAccounts: 3,
        unknownAccounts: 0,
        totalAccounts: 4,
        state: 'ok',
        nextRefill: { account: 'ai7', window: '5h', at: NOW_S + 41 * 60, tier: 'claude-max-20x' },
        markers: [
          { account: 'ai7', window: '5h', at: NOW_S + 41 * 60, gainPct: 62, tier: 'claude-max-20x', returns: false },
          { account: 'ai3', window: '5h', at: NOW_S + 3 * 3600, gainPct: 10, tier: 'claude-max-5x', returns: false },
          { account: 'ai13', window: '7d', at: NOW_S + 5 * 86400, gainPct: 40, returns: false },
        ],
        accounts: [],
      },
      {
        group: 'codex',
        label: 'Codex',
        availablePct: 0,
        availableAccounts: 0,
        unknownAccounts: 0,
        totalAccounts: 4,
        state: 'empty',
        nextReturn: { account: 'ai5', window: '5h', at: NOW_S + 2 * 3600 + 14 * 60, tier: 'chatgpt-pro-500' },
        markers: [
          {
            account: 'ai5',
            window: '5h',
            at: NOW_S + 2 * 3600 + 14 * 60,
            gainPct: 100,
            tier: 'chatgpt-pro-500',
            returns: true,
          },
        ],
        accounts: [],
      },
    ],
  };
  const fns = load<{ renderCapacity: (v: any, nowMs: number) => string }>(
    [
      'esc',
      'escAttr',
      'pad2',
      'capAxisPct',
      'capCountdown',
      'capPackMarkers',
      'capTierClass',
      'capTierLabel',
      'capMarkerGlyph',
      'capClockLabel',
      'renderCapacityAxis',
      'renderCapacityGrid',
      'capEventLine',
      'renderCapacityRow',
      'renderCapacity',
    ],
    ['CAP_STOPS', 'CAP_LANES', 'CAP_TIERS'],
  );
  const html = fns.renderCapacity(view, NOW_S * 1000);

  it('one row per provider with its available %, never called a token count', () => {
    expect(html).toContain('Claude');
    expect(html).toContain('75%');
    expect(html).toContain('잔여');
    expect(html).not.toContain('토큰량');
  });

  it('an empty provider leads with the countdown to the first account back', () => {
    const codex = html.slice(html.indexOf('Codex'));
    expect(codex).toContain('cap-row is-empty');
    expect(codex).toContain('2h 14m');
    expect(codex).toContain('ai5');
  });

  it('markers are coloured by tier class and labelled with the tier text', () => {
    expect(html).toMatch(/cap-mk[^"]*tier-high[^>]*>[^<]*ai7/);
    expect(html).toContain('x20');
    expect(html).toMatch(/cap-mk[^"]*tier-low/);
    expect(html).toMatch(/cap-mk[^"]*tier-none/);
    expect(html).toContain('$500');
  });

  it('every marker states its real time in the tooltip', () => {
    expect(html).toMatch(/title="[^"]*41m[^"]*"/);
  });

  it('labels the axis honestly: hour stops, a marked 24h boundary, then days', () => {
    for (const t of ['1h', '3h', '6h', '12h', '24h', '2d', '7d']) expect(html).toContain(`>${t}<`);
    expect(html).toContain('cap-break');
  });

  it('says how fresh the data is', () => {
    expect(html).toContain('12초 전');
  });

  it('an unavailable view renders the reason, not a blank', () => {
    const off = fns.renderCapacity({ available: false, reason: 'llmux unreachable', groups: [] }, NOW_S * 1000);
    expect(off).toContain('llmux unreachable');
  });
});

describe('page wiring', () => {
  const page = TEMPLATE;
  it('the capacity section sits between the stats strip and the inbox', () => {
    const stats = page.indexOf('<section class="stats" id="stats"');
    const capacity = page.indexOf('<section class="capacity" id="capacity"');
    const inbox = page.indexOf('<section class="inbox" id="inbox"');
    expect(stats).toBeGreaterThan(-1);
    expect(capacity).toBeGreaterThan(stats);
    expect(inbox).toBeGreaterThan(capacity);
  });

  it('the CRON lane sits inside the inbox, above the kanban columns', () => {
    const inbox = page.indexOf('<section class="inbox" id="inbox"');
    const lane = page.indexOf('id="cron-lane"');
    const kanban = page.indexOf('<div class="kanban" id="kanban"');
    expect(lane).toBeGreaterThan(inbox);
    expect(kanban).toBeGreaterThan(lane);
  });

  it('a drawer for a job’s past runs exists and closes on Escape', () => {
    expect(page).toContain('id="cron-drawer"');
    expect(page).toMatch(/Escape[\s\S]{0,200}closeCronDrawer/);
  });

  it('polls capacity and cron on their own cadence and pauses when hidden', () => {
    expect(page).toMatch(/setInterval\(loadCapacity, 60000\)/);
    expect(page).toMatch(/setInterval\(loadCronJobs, 60000\)/);
    expect(page).toContain('document.hidden');
  });
});
