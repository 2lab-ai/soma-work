/**
 * SSOT 2026-10-23 — dashboard client half. Executes the shipped client code
 * cut out of renderDashboardPage()'s template (harness of
 * dashboard-live-surfaces-client.test.ts):
 *
 *   T3   a cron card carries a CRON badge at the left of its head (cardOf's lead;
 *        <ui-agent-inbox> draws it)
 *   T4   cron cards leave the three columns for the CRON lane, grouped by job
 *   T5   run glyphs and schedule words (the lane's strip and the drawer rows)
 *   T7   the capacity section between the stats strip and the inbox
 *
 * The capacity cards (v2 two measures, the forecast timeline, T10 tiers) and the
 * lane's tiles are @2lab.ai/ui <ui-agent-queue> since the agent-queue swap: the
 * library's suite owns how they are drawn ('<ui-agent-queue> capacity' / 'lane'),
 * and dashboard-affectui-agent-queue-client.test.ts pins what the page hands it
 * (capData from the real buildCapacityView, laneData from planCronLane).
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

// The card face is @2lab.ai/ui <ui-agent-inbox>'s: the page hands it the card
// data (cardOf). Where the lead sits and how it is drawn is the element's
// ('draws face extras: lead, owner badge, host metrics, titles, context level,
// artifact count and chip buttons').
const CARD_ENV = {
  dhShow: () => true,
  dhTruncate: () => null,
  currentUserId: 'U1',
  _ownerIndex: null,
  SELF_INSTANCE_NAME: 'inst',
};
const CARD_OF_FNS = [
  'toNum',
  'formatTokens',
  'formatTaskTime',
  'permissionSummary',
  'cardSummary',
  'pendingAutoResume',
  'autoResumeLabel',
  'cardCurrentTask',
  'cardTaskRow',
  'agentStatusOf',
  'agentCounts',
  'agentDotOf',
  'cardTotalTokens',
  'ctxLevel',
  'ctxPercent',
  'cardCtxTitle',
  'cardPrMetric',
  '_hashStr',
  'ownerBadgeHue',
  'isSiblingSession',
  'cardOf',
];
const CARD_OF_VARS = ['PR_STATE_LABEL', 'PR_STATE_TONE', 'AGENT_STATUS_LABEL', 'AGENT_STATUS_TONE', 'OWNER_BADGE_HUES'];

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
  const face = load<{ cardOf: (s: unknown, col: string) => Record<string, unknown> }>(
    CARD_OF_FNS,
    CARD_OF_VARS,
    CARD_ENV,
  );

  it('a cron card leads its head with the badge (clock + CRON), job name in the tooltip', () => {
    const c = face.cardOf(
      card({ cronJob: { id: 'job-1', name: 'nightly-qa' }, displayHeadline: 'QA pass: orders API' }),
      'working',
    );
    expect(c.lead).toEqual({ text: 'CRON', glyph: 'clock', title: '크론 잡: nightly-qa' });
    expect(c.title).toBe('QA pass: orders API');
  });

  it('a human card keeps the spark and has no badge', () => {
    // No lead: the element draws its default spark.
    expect(face.cardOf(card(), 'working').lead).toBeUndefined();
    expect(face.cardOf(card({ cronJob: { id: 'job-1' } }), 'working').lead).toBeUndefined();
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

describe('page wiring', () => {
  const page = TEMPLATE;
  it('the capacity section sits between the stats strip and the inbox', () => {
    const stats = page.indexOf('<section class="stats" id="stats"');
    const capacity = page.indexOf(
      '<div class="capacity-host ui-tok" id="capacity" hidden><ui-agent-queue id="capacity-aq"',
    );
    const inbox = page.indexOf('<section class="inbox ui-tok" id="inbox"');
    expect(stats).toBeGreaterThan(-1);
    expect(capacity).toBeGreaterThan(stats);
    expect(inbox).toBeGreaterThan(capacity);
  });

  it('the CRON lane sits inside the inbox, above the board element', () => {
    const inbox = page.indexOf('<section class="inbox ui-tok" id="inbox"');
    const lane = page.indexOf('<div class="cron-lane ui-tok" id="cron-lane" hidden><ui-agent-queue id="cron-aq"');
    const kanban = page.indexOf('<ui-agent-inbox id="kanban" class="kanban" view="board">');
    expect(inbox).toBeGreaterThan(-1);
    expect(lane).toBeGreaterThan(inbox);
    expect(kanban).toBeGreaterThan(lane);
  });

  it('a drawer for a job’s past runs exists and closes on Escape', () => {
    expect(page).toContain('id="cron-drawer"');
    expect(page).toContain(
      "if (d) d.addEventListener('ui-close', function(e) { e.preventDefault(); closeCronDrawer(); });",
    );
  });

  it('polls capacity and cron on their own cadence and pauses when hidden', () => {
    expect(page).toMatch(/setInterval\(loadCapacity, 60000\)/);
    expect(page).toMatch(/setInterval\(loadCronJobs, 60000\)/);
    expect(page).toContain('document.hidden');
  });
});
