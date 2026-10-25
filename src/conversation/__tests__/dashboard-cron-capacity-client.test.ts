/**
 * SSOT 2026-10-23 — dashboard client half. Executes the shipped client code
 * cut out of renderDashboardPage()'s template (harness of
 * dashboard-live-surfaces-client.test.ts):
 *
 *   T3   a cron card carries a CRON badge at the left of its head
 *   T4   cron cards leave the three columns for the CRON lane, grouped by job
 *   T5   a job tile: schedule, next run, last-N run strip; drawer rows per run
 *   T7   the capacity section between the stats strip and the inbox
 *   v2   (2026-10-25) two measures — now (5h ∧ weekly) and this week — in max
 *        accounts' worth + %, and separate 5h / weekly forecast lanes
 *   T10  the subscription tier as a dot plus its text
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCapacityView } from '../capacity-view';

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

const CAP_VARS = ['CAP_TIERS', 'CAP_CAUSE', 'CAP_5H', 'CAP_7D'];
const CAP_FNS = [
  'esc',
  'escAttr',
  'pad2',
  'capCountdown',
  'capClockLabel',
  'capFmt1',
  'capGain',
  'capPct',
  'capNextLine',
  'capWhyLine',
  'capUnitBar',
  'capUnits',
  'capLane',
  'capDecomp',
  'capChips',
  'capRefillList',
  'capAdvance',
  'renderCapacitySummary',
  'renderCapacityGroup',
  'renderCapacity',
];

const SHOW_ALL = {
  dhShow: () => true,
  dhMax: (_f: string, d: number) => d,
  dhTruncate: () => null,
  currentUserId: 'U1',
  // #375 artifact chips on the face — not what these tests read.
  isSiblingSession: () => false,
  artFaceChips: () => '',
  umFaceBadge: () => '',
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
  'agentStatusOf',
  'agentCounts',
  'renderCardAgents',
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
const FACE_VARS = [
  'SPARK_SVG',
  'WAIT_SVG',
  'TASKS_SVG',
  'CTX_SVG',
  'RESUME_SVG',
  'CLOCK_SVG',
  'AGENT_STATUS_LABEL',
  'AGENT_DOTS_MAX',
  'AGENTS_SVG',
];

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
  // trinity round 4 (astra P2): a queue entry is an event, not the run that owns
  // the thread. The first fire is still running (no record until it ends) and a
  // second fire queued behind it: the history holds only the queue entry, and
  // the running fire must still show.
  it('a queue entry does not hide the running fire it waits behind', () => {
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
            executedAt: Date.parse('2026-10-23T05:03:00Z'),
            status: 'queued',
            executionPath: 'busy_queue',
            session: { boardKey: 'k-now', activityState: 'idle', live: false },
          },
        ],
      },
    ];
    const g = fns.planCronLane(board, jobs).groups[0];
    const runs = fns.cronGroupRuns(g);
    expect(runs.map((r: any) => r.status)).toEqual(['queued', 'unrecorded']);
    expect(runs[1].session).toMatchObject({ boardKey: 'k-now', activityState: 'working', live: true });
  });
});

// Capacity v2 (2026-10-25; mockup v4 passed trinity r4): the client renders the
// server's view as-is — built here by the real buildCapacityView, so the two halves
// cannot drift apart.
describe('capacity v2 — two measures and a replayed forecast', () => {
  const NOW_S = 1_800_000_000;
  const H = 3600;
  const D = 86400;
  const w = (utilization: number, inSecs: number) => ({
    utilization,
    resets_at: NOW_S + inSecs,
    resets_in_secs: inSecs,
  });
  const a = (over: Record<string, unknown>) => ({ type: 'oauth', status: 'ok', order: 1, blocked: null, ...over });
  const status = {
    current: null,
    accounts: [
      // 5h caps it: now .1, week .7; its 5h reset at +2h frees +0.6
      a({ name: 'claude:ai1@c', group: 'claude', five_hour: w(0.9, 2 * H), seven_day: w(0.3, 3 * D) }),
      // the week caps it: now .4; the 5h reset at +4h changes nothing (hollow ●)
      a({ name: 'claude:ai2@c', group: 'claude', five_hour: w(0.1, 4 * H), seven_day: w(0.6, D) }),
      // weekly ceiling: back at +2d with a full account
      a({
        name: 'claude:ai3@c',
        group: 'claude',
        blocked: '7d 100.0% > 99%',
        five_hour: w(0, H),
        seven_day: w(1, 2 * D),
      }),
      a({ name: 'claude:ai4@c', group: 'claude', five_hour: w(0, H), seven_day: w(0, D) }),
      a({ name: 'claude:ai6@c', group: 'claude', blocked: 'paused', five_hour: w(0, H), seven_day: w(0, D) }),
      a({ name: 'codex:ai5@c', group: 'codex', type: 'codex', seven_day: w(0.5, 3 * D) }),
      a({ name: 'codex:ai2@c', group: 'codex', type: 'codex', seven_day: w(0.2, 5 * D) }),
    ],
  };
  const tiers = {
    'claude:ai1': 'claude-max-20x',
    'claude:ai2': 'claude-max-20x',
    'claude:ai3': 'claude-max-20x',
    'claude:ai6': 'claude-max-20x',
  };
  const view = {
    ...buildCapacityView(status as never, tiers as never, NOW_S * 1000),
    fetchedAtMs: NOW_S * 1000 - 12_000,
  };
  const fns = load<{ renderCapacity: (v: any, nowMs: number, widthPx?: number) => string }>(CAP_FNS, CAP_VARS);
  const html = fns.renderCapacity(view, NOW_S * 1000, 1200);
  const claude = html.slice(html.indexOf('data-group="claude"'), html.indexOf('data-group="codex"'));
  const codex = html.slice(html.indexOf('data-group="codex"'));

  it('① two measures for Claude — x / total max accounts and %: now (5h ∧ weekly) and this week', () => {
    expect(claude).toMatch(/cap-meas is-now[\s\S]*?>0\.5<[\s\S]*?\/ 3\.0 계정분[\s\S]*?17%/);
    expect(claude).toMatch(/cap-meas is-wk[\s\S]*?>1\.1<[\s\S]*?\/ 3\.0 계정분[\s\S]*?37%/);
    expect(claude).toContain('5h·주간 중 작은 쪽');
  });

  it('① Codex has no 5h window: the weekly measure only', () => {
    expect(codex).not.toContain('cap-meas is-now');
    expect(codex).toMatch(/cap-meas is-wk[\s\S]*?>0\.8<[\s\S]*?\/ 1\.4 계정분/);
  });

  it('① each measure says what raises it next, through which reset', () => {
    expect(claude).toContain('다음 +0.6 · 2h 0m 후');
    expect(claude).toContain('● ai1 5h 리셋');
    expect(claude).toContain('다음 +0.6 · 1d 0h 후');
    expect(claude).toContain('◆ ai2 주간 리셋');
  });

  it('① the why line names the window that caps each usable account', () => {
    expect(claude).toContain('쓸 수 있는 2계정 중 <b>5h가 상한 1</b> · 주간이 상한 1');
    expect(claude).toContain('5h 리셋으로 +0.6계정분');
  });

  it('① a unit bar: one cell per max account, now inside this week', () => {
    expect(claude).toContain('class="cap-unitbar"');
    expect(claude).toMatch(/cap-u-now/);
    expect(codex).not.toMatch(/cap-u-now/);
  });

  it('① exclusions and blocks are counted apart, never silently folded in', () => {
    expect(claude).toContain('주간 한도 1');
    expect(claude).toContain('티어 미지정 1 · 제외');
    expect(claude).toContain('보류 1 · 제외');
  });

  it('② the 5h lane and the weekly lane are separate, each with its own glyph and colour', () => {
    expect(claude).toContain('cap-lane is-5h');
    expect(claude).toContain('cap-lane is-7d');
    expect(claude).toMatch(/cap-l-mk is-5h is-hollow/); // ai2's 5h reset frees nothing
    expect(claude).toMatch(/◆ ai3 x20 \+1\.0/);
    expect(codex).not.toContain('cap-lane is-5h');
  });

  it('② each lane breaks its gain down by cause', () => {
    expect(claude).toContain('<b>+0.6 계정분</b> = ● 5h 리셋 +0.6 (2건, 1건은 변화 없음)');
    expect(claude).toContain('<b>+1.9 계정분</b> = ◆ 주간 리셋 +1.9 (3건)');
  });

  it('the tier is a dot plus its text, not a colour of its own', () => {
    expect(claude).toMatch(/cap-dot tier-high/);
    expect(claude).toContain('x20');
  });

  it('a narrow screen trades the lanes for a "next refills" list with now and week apart', () => {
    const narrow = fns.renderCapacity(view, NOW_S * 1000, 360);
    expect(narrow).not.toContain('cap-lane');
    // one breakpoint: the card that lists refills is the card the CSS stacks
    expect(narrow).toMatch(/class="cap-prov is-\w+ is-narrow"/);
    expect(html).not.toContain('is-narrow');
    expect(narrow).toContain('다음 리필');
    expect(narrow).toMatch(/지금 \+0\.6[\s\S]*?주간 \+0\.6/);
  });

  // PR #417 review gate (fable P1, grok P3): the grid column is the width the charts are drawn at.
  it('the wide grid sizes its first column from the same number the charts use', () => {
    expect(claude).toContain('style="grid-template-columns:470px minmax(0, 1fr)"');
    const mid = fns.renderCapacity(view, NOW_S * 1000, 900);
    expect(mid).toContain('style="grid-template-columns:399px minmax(0, 1fr)"'); // floor((900 − 32) × 0.46)
    expect(mid).toContain('class="cap-unitbar" width="395"'); // leftW − 4
  });

  it('every account gets a per-account cell — a long pool wraps, nothing is dropped', () => {
    const many = {
      current: null,
      accounts: Array.from({ length: 20 }, (_, i) =>
        a({ name: `claude:ac${i}@c`, group: 'claude', five_hour: w(0.1, H), seven_day: w(0.2, D) }),
      ),
    };
    const t20 = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`claude:ac${i}`, 'claude-max-20x']));
    const out = fns.renderCapacity(buildCapacityView(many as never, t20 as never, NOW_S * 1000), NOW_S * 1000, 360);
    const units = out.slice(out.indexOf('class="cap-units"'), out.indexOf('</svg>', out.indexOf('class="cap-units"')));
    for (let i = 0; i < 20; i++) expect(units).toContain(`>ac${i}</text>`);
    expect(units).toMatch(/translate\(0 \d+\)/);
  });

  it('opened lists are keyed so a repaint keeps them open', () => {
    expect(claude).toContain('data-cap-key="claude:events"');
    const paint = TEMPLATE.slice(TEMPLATE.indexOf('\nfunction paintCapacity('));
    expect(paint.slice(0, paint.indexOf('\n}\n'))).toContain('details[data-cap-key][open]');
  });

  // PR #417 review gate (astra): a repaint between fetches folds what is due into the measures.
  it('an event whose time has come is part of "now", not a refill to come', () => {
    const later = fns.renderCapacity(view, (NOW_S + 2 * H + 60) * 1000, 1200);
    const c2 = later.slice(later.indexOf('data-group="claude"'), later.indexOf('data-group="codex"'));
    expect(c2).toMatch(/cap-meas is-now[\s\S]*?>1\.1</); // 0.5 + ai1's 5h reset +0.6
    expect(c2).not.toContain('● ai1 5h 리셋');
  });

  it('a narrow list with only small gains says so instead of "nothing"', () => {
    const tiny = {
      ...view,
      groups: [{ ...view.groups[0], events: [{ account: 'ai1', cause: '5h', at: NOW_S + H, dNow: 0.02, dWeek: 0 }] }],
    };
    const out = fns.renderCapacity(tiny, NOW_S * 1000, 360);
    expect(out).toContain('7일 안엔 +0.1 미만(소폭)');
  });

  it('a long account label is cut to fit its lane chip', () => {
    const long = {
      ...view,
      groups: [
        {
          ...view.groups[0],
          events: [{ account: 'averyveryverylongname@corp.example', cause: '7d', at: NOW_S + D, dNow: 1, dWeek: 1 }],
        },
      ],
    };
    const out = fns.renderCapacity(long, NOW_S * 1000, 1200);
    expect(out).toContain('averyveryvery…');
  });

  it('nothing countable reads "계산 불가", never NaN', () => {
    const none = {
      ...view,
      groups: [
        { ...view.groups[0], total: 0, now: 0, week: 0, countedAccounts: 0, state: 'unknown', events: [], units: [] },
      ],
    };
    const out = fns.renderCapacity(none, NOW_S * 1000, 1200);
    expect(out).toContain('계산 불가');
    expect(out).not.toContain('NaN');
  });

  it('says how fresh the data is and whose clock the times use; never calls it a token count', () => {
    expect(html).toContain('12초 전');
    expect(html).toContain('시각은 보는 사람 기준');
    expect(html).not.toContain('토큰량');
  });

  it('an unavailable view renders the reason, not a blank', () => {
    const off = fns.renderCapacity({ available: false, reason: 'llmux unreachable', groups: [] }, NOW_S * 1000, 1200);
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
