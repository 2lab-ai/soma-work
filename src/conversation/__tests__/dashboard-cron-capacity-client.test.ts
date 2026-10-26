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

const CAP_VARS = ['CAP_TIERS', 'CAP_CAUSE', 'CAP_WORD', 'CAP_5H', 'CAP_7D'];
const CAP_FNS = [
  'esc',
  'escAttr',
  'pad2',
  'capCountdown',
  'capClockLabel',
  'capFmt1',
  'capGain',
  'capPct',
  'capCount',
  'capNextLine',
  'capDur',
  'capNextEvent',
  'capNextShort',
  'capBarRow',
  'capAssumed',
  'capDisclosure',
  'capAx',
  'capTimeline',
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
  'doneTimeOf',
  'cardAgo',
  'renderCardStatus',
  'renderOwnerBadge',
  'renderCronBadge',
  'ctxLevel',
  'ctxPercent',
  'renderCardPr',
  'renderCardFace',
];
const FACE_VARS = [
  'SPARK_SVG',
  'WAIT_SVG',
  'TASKS_SVG',
  'CTX_SVG',
  'PR_STATE_LABEL',
  'PR_SVG',
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
      a({ name: 'claude:ai6@c', group: 'claude', blocked: 'paused', five_hour: w(0, H), seven_day: w(0, D) }),
      // an untiered Codex account stays out (only Claude assumes x20)
      a({ name: 'codex:ai9@c', group: 'codex', type: 'codex', seven_day: w(0, D) }),
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
  const fns = load<{
    renderCapacity: (v: any, nowMs: number, widthPx?: number) => string;
    renderCapacitySummary: (v: any, nowMs: number) => string;
  }>(CAP_FNS, CAP_VARS);
  const html = fns.renderCapacity(view, NOW_S * 1000, 1200);
  const claude = html.slice(html.indexOf('data-group="claude"'), html.indexOf('data-group="codex"'));
  const codex = html.slice(html.indexOf('data-group="codex"'));

  // Simplified card (user: v2 was unreadable; trinity simple r1): two bars + one timeline.
  it('1 — two bars per provider: 5시간 (지금 쓸 수 있음) and 일주일 (이번 주 남음), each count / total + %', () => {
    expect(claude).toMatch(
      /cap-bar-row is-h5[\s\S]*?5시간<i>지금 쓸 수 있음<\/i>[\s\S]*?<b>0\.5<\/b> \/ 3\.0 계정 <em>17%<\/em>/,
    );
    expect(claude).toMatch(
      /cap-bar-row is-wk[\s\S]*?일주일<i>이번 주 남음<\/i>[\s\S]*?<b>1\.1<\/b> \/ 3\.0 계정 <em>37%<\/em>/,
    );
    expect(claude.indexOf('is-h5')).toBeLessThan(claude.indexOf('cap-bar-row is-wk'));
  });

  it('1 — Codex (no 5h data) has the weekly bar only', () => {
    expect(codex).not.toContain('cap-bar-row is-h5');
    expect(codex).toMatch(/cap-bar-row is-wk[\s\S]*?<b>0\.8<\/b> \/ 1\.4 계정 <em>59%<\/em>/);
  });

  // Trinity mockup v5 (grok P1): two tokens a reader needs — how much, when. The bar's own
  // reset is implied by the bar; the account and the reset name move to the tooltip.
  it('each bar says what raises it next in two tokens; which reset and which account sit in its tooltip', () => {
    expect(claude).toContain('<div class="cap-bar-next" title="5시간 리셋 · ai1">다음 +0.6계정 · 2시간 0분 후</div>');
    expect(claude).toContain('<div class="cap-bar-next" title="일주일 리셋 · ai2">다음 +0.6계정 · 1일 0시간 후</div>');
    expect(claude).not.toMatch(/cap-bar-next"[^>]*>[^<]*\(ai\d+\)/);
  });

  it("a refill that is not the bar's own reset names its cause (a block lifting)", () => {
    const lift = {
      ...view,
      groups: [
        { ...view.groups[0], events: [{ account: 'ai9', cause: 'release', at: NOW_S + H, dNow: 0.5, dWeek: 0 }] },
      ],
    };
    expect(fns.renderCapacity(lift, NOW_S * 1000, 1200)).toContain(
      '<div class="cap-bar-next" title="차단 해제 · ai9">다음 +0.5계정 · 1시간 0분 후 · 차단 해제</div>',
    );
  });

  // Operator, 2026-10-26: untiered Claude accounts count as Max x20, said in the muted
  // line and, folded, on the chip — an assumption is never silent.
  it('an untiered Claude pool is counted as x20 and says so on the card and the chip', () => {
    const untiered = {
      ...buildCapacityView(
        {
          current: null,
          accounts: [
            a({ name: 'claude:ai1@c', group: 'claude', five_hour: w(0.5, 2 * H), seven_day: w(0.5, 3 * D) }),
            a({ name: 'claude:ai2@c', group: 'claude', five_hour: w(0, 2 * H), seven_day: w(0.2, 3 * D) }),
          ],
        } as never,
        {} as never,
        NOW_S * 1000,
      ),
      fetchedAtMs: NOW_S * 1000,
    };
    const card = fns.renderCapacity(untiered, NOW_S * 1000, 1200);
    expect(card).not.toContain('계산 불가');
    expect(card).toMatch(/cap-bar-row is-h5[\s\S]*?<b>1\.3<\/b> \/ 2\.0 계정/);
    expect(card).toContain('2/2 반영 · 티어 미지정 2(x20 가정)');
    const chip = fns.renderCapacitySummary(untiered, NOW_S * 1000);
    expect(chip).toContain('<i class="cap-chip-flag">⚠ x20 가정 2</i>');
    expect(chip).toMatch(/aria-label="Claude [^"]*티어 미지정 2\(x20 가정\)/);
  });

  it('one muted line keeps the denominator honest: counted, blocked, left out and why', () => {
    // "(차단 1 포함)": the blocked accounts are inside the counted ones (trinity mockup v5, fable P2)
    expect(claude).toContain('3/4 반영(차단 1 포함) · 제외 1(보류)');
    expect(codex).toContain('2/3 반영 · 제외 1(티어 미지정)');
  });

  it('2 — one timeline: a 5h reset is a teal ● (label above), a weekly reset a violet ◆ (label below)', () => {
    expect(claude.match(/class="cap-tl"/g)?.length).toBe(1);
    expect(claude).toMatch(/cap-tl-mk is-h5"><circle[\s\S]*?>\+0\.6<\/text>/);
    for (const g of ['0.6', '1.0', '0.3'])
      expect(claude).toMatch(new RegExp(`cap-tl-mk is-wk"><rect[^]*?>\\+${g.replace('.', '\\.')}<\\/text>`));
    expect(claude).toContain('<i class="is-h5">●</i> 5시간 리셋</span>');
    expect(claude).toContain('<i class="is-wk">◆</i> 일주일 리셋');
    // Codex has no 5h window: no ● key at all
    expect(codex).not.toContain('<i class="is-h5">');
  });

  it('with no 5h gain in 7 days the ● key says so instead of a dead key (trinity simple r2, grok)', () => {
    const dry = {
      ...view,
      groups: [{ ...view.groups[0], events: view.groups[0].events.filter((e: any) => e.cause === '7d') }],
    };
    expect(fns.renderCapacity(dry, NOW_S * 1000, 1200)).toContain(
      '<i class="is-h5">●</i> 5시간 리셋 — 7일 안에 늘어날 양 없음</span>',
    );
  });

  it('a 5시간 bar held down by the weekly limit says so, never contradicting the ● key (fable)', () => {
    const bound = {
      ...view,
      groups: [{ ...view.groups[0], events: [{ account: 'ai8', cause: '7d', at: NOW_S + 8 * H, dNow: 1, dWeek: 1 }] }],
    };
    const out = fns.renderCapacity(bound, NOW_S * 1000, 1200);
    expect(out).toContain(
      '<div class="cap-bar-next" title="일주일 리셋 · ai8">일주일 한도에 묶임 · 다음 +1.0계정 · 8시간 0분 후</div>',
    );
    expect(out).toContain('5시간 리셋 — 7일 안에 늘어날 양 없음');
  });

  // Trinity mockup v5 r5 (fable P1): a pool whose 5h resets add only a little (each under the
  // 0.05 marker threshold) is not "nothing" — the key, the bars' next line and the chip
  // tooltip must all say "small", or a screen reader and the chart disagree.
  it('small 5h gains read "+0.1계정 미만" in the ● key, never "늘어날 양 없음"', () => {
    const small = {
      ...view,
      groups: [
        {
          ...view.groups[0],
          events: [
            { account: 'ai1', cause: '5h', at: NOW_S + 4 * H, dNow: 0.01, dWeek: 0 },
            { account: 'ai8', cause: '7d', at: NOW_S + 8 * H, dNow: 1, dWeek: 1 },
          ],
        },
      ],
    };
    const out = fns.renderCapacity(small, NOW_S * 1000, 1200);
    expect(out).toContain('<i class="is-h5">●</i> 5시간 리셋 — 7일 안 +0.1계정 미만</span>');
    expect(out).not.toContain('늘어날 양 없음');
    // r6 (grok P1): one phrase everywhere — chart key, bar line and chip tooltip.
    const chip = fns.renderCapacitySummary(small, NOW_S * 1000);
    expect(chip).toContain('5시간 안엔 +0.1계정 미만');
    expect(chip).not.toContain('소폭');
    expect(out).toContain('7일 안 +0.1계정 미만');
  });

  it('many small 5h gains that add up past 0.05 are named by their sum, the same way everywhere', () => {
    const many = {
      ...view,
      groups: [
        {
          ...view.groups[0],
          // a weekly refill draws the timeline (and its key); the 5h gains are all small
          events: [
            ...[1, 2, 3].map((h) => ({ account: `ai${h}`, cause: '5h', at: NOW_S + h * H, dNow: 0.03, dWeek: 0 })),
            { account: 'ai8', cause: '7d', at: NOW_S + 8 * H, dNow: 0, dWeek: 1 },
          ],
        },
      ],
    };
    const out = fns.renderCapacity(many, NOW_S * 1000, 1200);
    expect(out).toContain('<i class="is-h5">●</i> 5시간 리셋 — 7일 안 +0.1계정</span>');
    expect(out).toContain('7일 안 +0.1계정 회복');
    expect(fns.renderCapacitySummary(many, NOW_S * 1000)).toContain('5시간 안엔 +0.1계정');
  });

  it('a reading over a day old is flagged, not buried in the muted line (fable)', () => {
    const stale = { ...view, groups: [{ ...view.groups[1], oldestRefreshAt: NOW_S - 4 * D }] };
    expect(fns.renderCapacity(stale, NOW_S * 1000, 1200)).toContain('<b class="cap-stale">⚠ 측정 4일 전</b>');
    const hour = { ...view, groups: [{ ...view.groups[1], oldestRefreshAt: NOW_S - 3 * H }] };
    const out = fns.renderCapacity(hour, NOW_S * 1000, 1200);
    expect(out).toContain('측정 3시간 전');
    expect(out).not.toContain('cap-stale');
  });

  it('the v2 clutter is gone: no lanes, unit bar, per-account bars, why line, chips, breakdown or jargon', () => {
    for (const gone of [
      'cap-lane',
      'cap-unitbar',
      'cap-units',
      'cap-why',
      'cap-chip2',
      'cap-decomp',
      'cap-meas',
      '계정분',
      '상한',
      '합계 밖',
    ])
      expect(html).not.toContain(gone);
  });

  it('a narrow card keeps the bars and the timeline', () => {
    const narrow = fns.renderCapacity(view, NOW_S * 1000, 360);
    expect(narrow).toMatch(/class="cap-prov is-\w+ is-narrow"/);
    expect(narrow).toContain('cap-bar-row is-h5');
    expect(narrow).toContain('class="cap-tl"');
    expect(html).not.toContain('is-narrow');
  });

  // Mockup v5: on a phone the label and the value share the first line and the bar takes
  // the card's full width on its own line — never a ~70px stub between them.
  it('a narrow card gives each bar its own full-width line', () => {
    const rule = (sel: string) => {
      const m = DASHBOARD_TS.match(new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`));
      return m ? m[1] : '';
    };
    expect(rule('.cap-prov.is-narrow .cap-bar-row')).toMatch(/grid-template-columns: minmax\(0, 1fr\) auto;/);
    expect(rule('.cap-prov.is-narrow .cap-bar-lbl')).toMatch(/grid-row: 1; grid-column: 1;/);
    expect(rule('.cap-prov.is-narrow .cap-bar-val')).toMatch(/grid-row: 1; grid-column: 2;/);
    expect(rule('.cap-prov.is-narrow .cap-bar')).toMatch(/grid-row: 2; grid-column: 1 \/ -1;/);
    expect(rule('.cap-prov.is-narrow .cap-bar-next')).toMatch(/grid-row: 3; grid-column: 1 \/ -1;/);
    expect(rule('.cap-prov.is-narrow .cap-bar-lbl i')).toMatch(/display: inline;/);
  });

  it('an event whose time has come is part of the bar, not a refill to come', () => {
    const later = fns.renderCapacity(view, (NOW_S + 2 * H + 60) * 1000, 1200);
    const c2 = later.slice(later.indexOf('data-group="claude"'), later.indexOf('data-group="codex"'));
    expect(c2).toMatch(/cap-bar-row is-h5[\s\S]*?<b>1\.1<\/b>/); // 0.5 + ai1's 5h reset +0.6
    expect(c2).not.toContain('title="5시간 리셋 · ai1"');
  });

  it('small gains read "+0.1계정 미만", never "nothing"', () => {
    const tiny = {
      ...view,
      groups: [
        { ...view.groups[1], events: [{ account: 'ai5', cause: '7d', at: NOW_S + D, dNow: 0.03, dWeek: 0.03 }] },
      ],
    };
    expect(fns.renderCapacity(tiny, NOW_S * 1000, 1200)).toContain('7일 안 +0.1계정 미만 회복');
  });

  it('a count that rounds to the total but is not full keeps two decimals; 100% only when full', () => {
    const f = load<{ capPct: (v: number, t: number) => string; capCount: (v: number, t: number) => string }>(
      ['capFmt1', 'capPct', 'capCount'],
      [],
    );
    expect(f.capCount(2.37, 2.4)).toBe('2.37');
    expect(f.capPct(2.37, 2.4)).toBe('99%');
    expect(f.capCount(2.4, 2.4)).toBe('2.4');
    expect(f.capPct(2.4, 2.4)).toBe('100%');
    expect(f.capCount(5.23, 16)).toBe('5.2');
    expect(f.capPct(1, 0)).toBe('—');
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

  it('says how fresh the data is; never calls it a token count', () => {
    expect(html).toContain('12초 전');
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
