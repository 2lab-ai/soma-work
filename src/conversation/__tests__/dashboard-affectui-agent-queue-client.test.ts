/**
 * affectUI Agent Queue → LLM 가용량 · CRON 레인, client half (#444, .prd/affectui/re-agent-queue.md D1–D20).
 * Both sections are @2lab.ai/ui <ui-agent-queue> — the element the inline copy was ported to — one
 * instance with providers only (#capacity-aq), one with the lane only (#cron-aq). Executes the shipped
 * page code cut out of renderDashboardPage()'s template literal and cooked exactly as the browser
 * receives it, with injected fakes: the host contract.
 *
 *   slot      two elements in token wrappers, the script that defines them, no inline copy left
 *   capData   the capacity view (epoch seconds) → providers / accounts / refills, reason keys, tier
 *             labels, the error, the fold; ids that never cross a masked pool's responses (R3)
 *   laneData  the CRON plan → jobs keyed by group key, runs by the strip's glyph rule, runs24h from
 *             the records only, historyCap and recorded:false for the lower bounds, the job note
 *   wiring    the job boxes in their slots, the reconciler's lead cards, one paint per change,
 *             ui-collapse → the page's fold, ui-job-open → the drawer, focus back from the drawer
 *
 * The parity checks run the host's data through the library's own logic (dayRuns, poolState,
 * firstReturn, nextRefill — exported by @2lab.ai/ui). What the element itself draws and does — pills,
 * bars, the 20% line, marks and the account card, roving focus, the timeline, the folded chips, the
 * four numbers, the queue, the strip, the chart, live countdowns and announcements — is owned by the
 * library's suite (src/components/agent-queue/agent-queue.test.ts); the table at the end names the
 * library test that now covers each moved test.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildCapacityView, CAPACITY_LOW_PCT } from '../capacity-view';
import { UI_LIB_FILE, uiLibDistDir } from '../dashboard';

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
/** A page-level `document.addEventListener(type, function(e) {…});`, run against a fake document. */
function docListener(type: string, inject: Record<string, unknown>): (e: unknown) => void {
  const head = `document.addEventListener('${type}', function(e) {`;
  const start = TEMPLATE.indexOf(head);
  if (start < 0) throw new Error(`no document ${type} listener`);
  if (TEMPLATE.indexOf(head, start + 1) >= 0) throw new Error(`${type} listened twice`);
  const src = cook(TEMPLATE.slice(start, TEMPLATE.indexOf('\n});\n', start) + 4));
  let handler: ((e: unknown) => void) | null = null;
  const document = { addEventListener: (_t: string, f: (e: unknown) => void) => (handler = f) };
  const names = Object.keys(inject);
  new Function('document', ...names, src)(document, ...names.map((n) => inject[n]));
  if (!handler) throw new Error('listener not registered');
  return handler;
}

// The library's own logic, for parity. The package root (the entry tsc's node resolution can type;
// '@2lab.ai/ui/agent-queue' is an exports subpath it cannot) defines the element classes at load,
// which needs an HTMLElement to extend — no customElements here, so nothing is registered.
type Lib = Record<string, (...args: any[]) => any> & { LOW_PCT: number };
let lib: Lib;
const hadHTMLElement = 'HTMLElement' in globalThis;
beforeAll(async () => {
  if (!hadHTMLElement) (globalThis as any).HTMLElement = class {};
  lib = (await import('@2lab.ai/ui')) as unknown as Lib;
}, 60_000);
afterAll(() => {
  if (!hadHTMLElement) delete (globalThis as any).HTMLElement;
});

// ── capacity fixture: the real buildCapacityView output (epoch seconds) ──
const NOW_S = 1_800_000_000;
const NOW = NOW_S * 1000;
const H = 3600;
const D = 86400;
const w = (utilization: number, inSecs: number) => ({ utilization, resets_at: NOW_S + inSecs, resets_in_secs: inSecs });
const a = (over: Record<string, unknown>) => ({
  type: 'oauth',
  status: 'ok',
  order: 1,
  blocked: null,
  five_hour: null,
  seven_day: null,
  ...over,
});
// ai4 and ai9 carry no tier: Claude counts them on an assumed Max x20 (operator, 2026-10-26).
const TIERS = {
  'claude:ai1': 'claude-max-20x',
  'claude:ai3': 'claude-max-5x',
  'claude:ai6': 'claude-max-20x',
  'claude:aa': 'claude-max-20x',
  'claude:ab': 'claude-max-20x',
};
const POOL = [
  // usable, the week binds first; its reading is 4 hours old
  a({
    name: 'claude:ai1@c',
    group: 'claude',
    five_hour: w(0.35, 2 * H + 600),
    seven_day: w(0.42, 3 * D),
    last_refresh_ms: NOW - 4 * H * 1000,
  }),
  // 5h ceiling, back at the 5h reset in 80 minutes
  a({
    name: 'claude:ai3@c',
    group: 'claude',
    blocked: '5h 100.0% > 99%',
    five_hour: w(1, 80 * 60),
    seven_day: w(0.7, 4 * D),
  }),
  // a cooldown longer than the throttle: back in 25 minutes (untiered → x20 assumed)
  a({
    name: 'claude:ai4@c',
    group: 'claude',
    status: 'cooldown',
    blocked: 'cooldown',
    cooldown_until: NOW_S + 25 * 60,
    five_hour: w(0.2, 3 * H),
    seven_day: w(0.3, 5 * D),
  }),
  // paused by the operator: held out of the totals
  a({ name: 'claude:ai6@c', group: 'claude', blocked: 'paused', five_hour: w(0, H), seven_day: w(0, D) }),
  // unblocked, no 5h reading (untiered → x20 assumed) · the week spent without a block · no reading at all
  a({ name: 'claude:ai9@c', group: 'claude', seven_day: w(0.2, 2 * D) }),
  a({ name: 'claude:aa@c', group: 'claude', five_hour: w(0.1, H), seven_day: w(1, 2 * D) }),
  a({ name: 'claude:ab@c', group: 'claude' }),
  // Codex: weekly window only; one at its weekly ceiling, one with no tier (left out)
  a({ name: 'codex:ai5@c', group: 'codex', type: 'codex', seven_day: w(0.5, 3 * D + 2 * H) }),
  a({ name: 'codex:ai2@c', group: 'codex', type: 'codex', blocked: '7d 100.0% > 99%', seven_day: w(1, D + 5 * H) }),
  a({ name: 'codex:ai9@c', group: 'codex', type: 'codex', seven_day: w(0, D) }),
];
const view = (accounts: Record<string, unknown>[], atMs = NOW, anonymous = false) =>
  buildCapacityView({ current: null, email_anonymous: anonymous, accounts } as never, TIERS as never, atMs) as any;
const MAIN = { ...view(POOL), fetchedAtMs: NOW - 12_000 };
const CLAUDE = MAIN.groups.find((g: any) => g.group === 'claude');

type Fns = Record<string, (...args: any[]) => any>;
const CAP_FNS = ['capUnitState', 'capReason', 'capDupNames', 'capAccount', 'capData'];
const capFns = (open = false) =>
  load<Fns>(CAP_FNS, ['CAP_TIERS'], { secIsOpen: (s: string) => s === 'capacity' && open });

describe('slot — two <ui-agent-queue>, each in a token wrapper', () => {
  it('LLM 가용량 sits between the stats strip and the inbox; the CRON lane inside the inbox, above the columns', () => {
    const stats = TEMPLATE.indexOf('<section class="stats" id="stats"');
    const capacity = TEMPLATE.indexOf(
      '<div class="capacity-host ui-tok" id="capacity" hidden><ui-agent-queue id="capacity-aq" lang="ko"></ui-agent-queue></div>',
    );
    const inbox = TEMPLATE.indexOf('<section class="inbox ui-tok" id="inbox"');
    const lane = TEMPLATE.indexOf(
      '<div class="cron-lane ui-tok" id="cron-lane" hidden><ui-agent-queue id="cron-aq" lang="ko"></ui-agent-queue></div>',
    );
    const kanban = TEMPLATE.indexOf('<ui-agent-inbox id="kanban" class="kanban" view="board">');
    expect(stats).toBeGreaterThan(-1);
    expect(capacity).toBeGreaterThan(stats);
    expect(inbox).toBeGreaterThan(capacity);
    expect(lane).toBeGreaterThan(inbox);
    expect(kanban).toBeGreaterThan(lane);
    expect(TEMPLATE.match(/<ui-agent-queue /g)?.length).toBe(2);
  });

  it('the page loads the element from the installed library, and the route serves it', () => {
    expect(TEMPLATE).toContain(
      '<script type="module" src="/dashboard/ui/agent-queue.js?v=${UI_LIB_VERSION}"></script>',
    );
    expect(UI_LIB_FILE.test('agent-queue.js')).toBe(true);
    const dir = uiLibDistDir();
    expect(dir && existsSync(join(dir, 'agent-queue.js'))).toBe(true);
  });

  it('no inline copy is left: renderers, grammar, toggles, live region and their styles are gone', () => {
    for (const name of [
      'renderCapacity',
      'renderCapacitySummary',
      'renderCapacityGroup',
      'capWorkers',
      'capAccountCard',
      'capTimeline',
      'capSelectionAfter',
      'capAnnounceDiff',
      'renderCronTileHead',
      'renderCronLaneHead',
      'renderCronStrip',
      'cronStats',
      'cronQueue',
      'cronRunChart',
      'cronAnnounceDiff',
      'aqPill',
      'aqAnnounce',
      'aqRove',
      'aqWrite',
      'aqToggleCard',
    ])
      expect(TEMPLATE, name).not.toMatch(new RegExp(`function ${name}\\(`));
    for (const id of ['aq-live', 'capacity-view', 'capacity-toggle', 'cron-toggle', 'cron-lane-head', 'cron-groups'])
      expect(TEMPLATE, id).not.toContain(`id="${id}"`);
    for (const sel of [
      '.sec-toggle',
      '.cap-chip',
      '.cap-prov',
      '.aq-mark',
      '.aq-pop',
      '.aq-stats',
      '.cron-tile',
      '.cr-tick',
    ])
      expect(TEMPLATE, sel).not.toContain(`${sel} {`);
    expect(TEMPLATE).not.toContain('data-sec-toggle');
    expect(TEMPLATE).not.toContain('data-cron-group');
    // The board cards' CRON badge and the drawer stay the page's.
    expect(TEMPLATE).toContain('.cron-badge {');
    expect(TEMPLATE).toContain('id="cron-drawer"');
  });
});

describe('capData — the capacity view as the element’s providers', () => {
  it('epoch seconds are said once (timeUnit s); the note, the fetch time and the page’s fold ride along', () => {
    const d = capFns(false).capData(MAIN);
    expect(d.timeUnit).toBe('s');
    expect(d.fetchedAt).toBe((NOW - 12_000) / 1000);
    expect(d.capacityNote).toBe('계정 = 최대 플랜 계정 1개 분량 · llmux');
    expect(d.collapsible).toBe(true);
    expect(d.collapsed).toEqual({ capacity: true });
    expect(capFns(true).capData(MAIN).collapsed).toEqual({ capacity: false });
    expect(d.capacityError).toBeUndefined();
    expect(d.providers.map((p: any) => p.id)).toEqual(['claude', 'codex']);
  });

  it('a provider keeps the server’s numbers: both measures only with a 5h window, its counts, its oldest reading', () => {
    const [claude, codex] = capFns().capData(MAIN).providers;
    expect(claude).toMatchObject({
      id: 'claude',
      name: CLAUDE.label,
      source: 'llmux',
      total: CLAUDE.total,
      fiveHour: CLAUDE.now,
      weekly: CLAUDE.week,
      state: CLAUDE.state,
      accountCount: 7,
      countedAccounts: 5,
      excluded: { unknownTier: 0, held: 1, noMeasure: 1 },
      estimated: CLAUDE.estimated,
      unmeasured5h: CLAUDE.unmeasured5h,
      measuredAt: CLAUDE.oldestRefreshAt,
    });
    expect(CLAUDE.oldestRefreshAt).toBeGreaterThan(0);
    expect('fiveHour' in codex).toBe(false);
    expect(codex.weekly).toBe(MAIN.groups[1].week);
  });

  it('events become refills: same time (seconds), cause and account; dNow → fiveHour, dWeek → weekly', () => {
    const [claude] = capFns().capData(MAIN).providers;
    expect(claude.refills).toHaveLength(CLAUDE.events.length);
    CLAUDE.events.forEach((e: any, i: number) => {
      expect(claude.refills[i]).toEqual({
        at: e.at,
        cause: e.cause,
        fiveHour: e.dNow,
        weekly: e.dWeek,
        account: e.account,
      });
    });
  });

  it('each unit is a worker: its state and reason key from its own fields, its tier as a label, in llmux order', () => {
    const [claude, codex] = capFns().capData(MAIN).providers;
    const by = (p: any) => Object.fromEntries(p.accounts.map((x: any) => [x.name, x]));
    const c = by(claude);
    expect(claude.accounts.map((x: any) => x.name)).toEqual(CLAUDE.units.map((u: any) => u.name));
    expect(c.ai1).toMatchObject({ id: 'ai1', state: 'available', binding: '7d', tier: 'Max x20' });
    expect(c.ai1.reason).toBeUndefined();
    expect(c.ai3).toMatchObject({ state: 'limited', reason: '5h', tier: 'Max x5', returnAt: NOW_S + 80 * 60 });
    expect(c.ai4).toMatchObject({
      state: 'limited',
      reason: 'cooldown',
      tier: 'x20',
      tierAssumed: true,
      returnAt: NOW_S + 25 * 60,
    });
    expect(c.ai6).toMatchObject({ state: 'paused', reason: 'paused' });
    expect(c.ai9).toMatchObject({ state: 'unmeasured', tier: 'x20', tierAssumed: true });
    expect(c.aa).toMatchObject({ state: 'spent' });
    expect(c.ab).toMatchObject({ state: 'excluded', reason: 'noMeasure' });
    const x = by(codex);
    expect(x.ai2).toMatchObject({ state: 'limited', reason: 'weekly', tier: 'Pro ($200)' });
    expect(x.ai5).toMatchObject({ state: 'available', tier: 'Pro ($500)' });
    expect(x.ai9).toMatchObject({ state: 'excluded', reason: 'unknownTier' });
    expect(x.ai9.tier).toBeUndefined();
    // the account card's numbers: this account's own 0..1
    expect(c.ai1.fiveHour).toBe(CLAUDE.units.find((u: any) => u.name === 'ai1').now);
  });

  it('every reason llmux can give has a key the element says in Korean; a block it has no word for is 차단', () => {
    const { capReason, capUnitState } = capFns();
    const u = (over: Record<string, unknown>) => ({ counted: true, blocked: false, blocks: {}, now: 0.5, ...over });
    expect(capReason(u({ counted: false, excluded: 'held', held: 'auth' }))).toBe('auth');
    expect(capReason(u({ counted: false, excluded: 'held', held: 'other' }))).toBe('held');
    expect(capReason(u({ blocked: true, blocks: { weekly: true } }))).toBe('weekly');
    expect(capReason(u({ blocked: true, blocks: { scopedUntil: 1 } }))).toBe('model');
    expect(capReason(u({ blocked: true, blocks: {} }))).toBe('차단');
    expect(capReason(u({}))).toBe('');
    expect(capUnitState(u({ counted: false, excluded: 'held' }))).toBe('paused');
    expect(capUnitState(u({ counted: false, excluded: 'unknownTier' }))).toBe('excluded');
  });

  it('parity: the library reads the mapped pool as the server counted it (state, ⏸ first return, next gain, 20% line)', () => {
    const d = lib.normalize(capFns().capData(MAIN));
    const [claude, codex] = d.providers;
    expect(lib.poolState(claude)).toBe(CLAUDE.state);
    expect(lib.poolState(codex)).toBe(MAIN.groups[1].state);
    // the chip's / pill's "⏸ 2 · 24분": the first return among the counted, blocked accounts
    expect(lib.firstReturn(claude)).toBe((NOW_S + 25 * 60) * 1000);
    // the 5시간 bar's "다음 +0.7계정 · 25분 후 · 차단 해제": ai4's cooldown lifting
    const next = lib.nextRefill(claude, 'fiveHour', NOW);
    expect(next).toMatchObject({ at: (NOW_S + 25 * 60) * 1000, cause: 'release', account: 'ai4' });
    expect(lib.LOW_PCT).toBe(CAPACITY_LOW_PCT);
  });

  it('an unreadable view is its reason, in place of the cards', () => {
    const { capData } = capFns();
    const off = capData({ available: false, reason: 'llmux unreachable', fetchedAtMs: NOW, groups: [] });
    expect(off.capacityError).toBe('llmux unreachable');
    expect(off.providers).toBeUndefined();
    expect(capData({ available: false, fetchedAtMs: NOW, groups: [] }).capacityError).toBe('알 수 없는 오류');
  });
});

describe('identity — never the (masked) name alone (final review R3)', () => {
  // email_anonymous: llmux masks ai1@corp.example and ai2@corp.example both to "a***".
  const blocked = (order: number) =>
    a({
      name: 'claude:ai1@corp.example',
      group: 'claude',
      order,
      blocked: '5h 100.0% > 99%',
      five_hour: w(1, 40 * 60),
      seven_day: w(0.5, 3 * D),
    });
  const usable = (order: number) =>
    a({ name: 'claude:ai2@corp.example', group: 'claude', order, five_hour: w(0.2, H), seven_day: w(0.1, 3 * D) });
  const ids = (v: any) =>
    capFns()
      .capData(v)
      .providers[0].accounts.map((x: any) => x.id);

  it('a masked pool: each a*** has its own id, tied to this response — the next one matches none of them', () => {
    const r1 = view([blocked(1), usable(2)], NOW, true);
    const r2 = view([blocked(2), usable(1)], NOW + 60_000, true);
    expect(r1.groups[0].units.map((u: any) => u.name)).toEqual(['a***', 'a***']);
    const i1 = ids(r1);
    const i2 = ids(r2);
    expect(new Set(i1).size).toBe(2);
    expect(i1.filter((id: string) => i2.includes(id))).toEqual([]);
    // so the element closes an open card and resets the strip's stop (library: “closes the card when
    // its account leaves the data”) instead of showing the other a***
    expect(JSON.stringify(capFns().capData(r1))).not.toContain('corp.example');
  });

  it('unique names: the id is the name, so the open card and the stop follow the account when the order changes', () => {
    const r1 = view([blocked(1), usable(2)]);
    const r2 = view([blocked(2), usable(1)], NOW + 60_000);
    expect(ids(r1)).toEqual(['ai1', 'ai2']);
    expect(ids(r2)).toEqual(['ai2', 'ai1']);
  });
});

// ── CRON fixture ──
const M = 60_000;
const HR = 3_600_000;
const NOWC = NOW;
const run = (ago: number, over: Record<string, unknown> = {}) => ({
  executedAt: NOWC - ago,
  status: 'success',
  executionPath: 'new_thread',
  ...over,
});
const job = (id: string, name: string, nextIn: number | null, runs: unknown[], over: Record<string, unknown> = {}) => ({
  id,
  name,
  expression: '0 * * * *',
  owner: 'U1',
  channel: 'C1',
  mode: 'default',
  target: 'channel',
  model: 'default',
  nextRunAt: nextIn === null ? null : NOWC + nextIn,
  lastRunAt: null,
  historyCap: 20,
  runs,
  ...over,
});
const JOBS = [
  job('job-qa', 'nightly-qa', 42 * M, [
    run(1 * HR),
    run(2 * HR, { status: 'failed', error: 'staging 502' }),
    run(30 * HR),
  ]),
  job('job-digest', 'morning-digest', 14 * HR, [
    run(22 * M, { session: { headline: 'd', boardKey: 'k-dig', live: true, activityState: 'waiting' } }),
  ]),
  job(
    'job-deps',
    'dependency-audit',
    12 * M,
    [run(15 * M), run(30 * M, { status: 'queued', executionPath: 'busy_queue' }), run(45 * M)],
    { historyCap: 3 },
  ),
  job('job-retro', 'weekly-retro', 6 * 24 * HR, [run(5 * 24 * HR, { executionPath: 'dm' })]),
  job('job-monthly', 'monthly-bill', null, [], { historyCap: undefined }),
];
const card = (key: string, jobId: string | null, name: string, over: Record<string, unknown> = {}) => ({
  key,
  title: name,
  displayHeadline: name,
  cronJob: jobId ? { id: jobId, name } : { name },
  lastActivity: new Date(NOWC - M).toISOString(),
  ...over,
});
const BOARD = {
  working: [card('k-qa', 'job-qa', 'nightly-qa', { activeLegStartedAtMs: NOWC - 4 * M })],
  waiting: [card('k-dig', 'job-digest', 'morning-digest')],
  idle: [card('k-notes', null, 'release-notes', { lastActivity: new Date(NOWC - 3 * HR).toISOString() })],
  closed: [],
};
const LANE_FNS = [
  'isCronCard',
  'cronGroupKey',
  'cronCardTime',
  'planCronLane',
  'cronRunGlyph',
  'cronCardAsRun',
  'cronGroupRuns',
  'cronRunAsAq',
  'cronDayRuns',
  'laneData',
];
const laneFns = (folded = false) => load<Fns>(LANE_FNS, ['CRON_AQ_STATUS'], { cronLaneFolded: () => folded });
const empty = { working: [], waiting: [], idle: [], closed: [] };

describe('laneData — the CRON plan as the element’s lane', () => {
  it('one job per group, keyed by the group key, with its schedule, its cap and its live state', () => {
    const f = laneFns();
    const d = f.laneData(f.planCronLane(BOARD, JOBS, null));
    expect(d.collapsible).toBe(true);
    expect(d.collapsed).toEqual({ lane: false });
    expect(laneFns(true).laneData(f.planCronLane(BOARD, JOBS, null)).collapsed).toEqual({ lane: true });
    const by = Object.fromEntries(d.lane.jobs.map((j: any) => [j.id, j]));
    expect(Object.keys(by).sort()).toEqual(
      ['id:job-deps', 'id:job-digest', 'id:job-monthly', 'id:job-qa', 'id:job-retro', 'name:release-notes'].sort(),
    );
    expect(by['id:job-digest']).toMatchObject({ name: 'morning-digest', state: 'waiting', nextRunAt: NOWC + 14 * HR });
    expect(by['id:job-qa']).toMatchObject({ state: 'running', expression: '0 * * * *', historyCap: 20 });
    expect(by['id:job-deps']).toMatchObject({ state: 'idle', historyCap: 3 });
    // a job with no cap of its own keeps the store's default (20); no next fire → none given
    expect(by['id:job-monthly'].historyCap).toBe(20);
    expect('nextRunAt' in by['id:job-monthly']).toBe(false);
  });

  it('a group whose job is not on this instance: 잡 정보 없음 with why, and no schedule', () => {
    const f = laneFns();
    const notes = f
      .laneData(f.planCronLane(BOARD, JOBS, null))
      .lane.jobs.find((j: any) => j.id === 'name:release-notes');
    expect(notes.note).toEqual({
      text: '잡 정보 없음',
      title: '이 인스턴스에 없는 잡 — 삭제됐거나 다른 인스턴스의 잡이라 스케줄 정보가 없습니다',
    });
    expect(notes.expression).toBeUndefined();
    expect(notes.historyCap).toBeUndefined();
  });

  it('runs keep the strip’s glyph rule: every state its own status and words; a card with no record is not a record', () => {
    const { cronRunAsAq } = laneFns();
    const live = (activityState: string) => ({ boardKey: 'k', live: true, activityState });
    expect(cronRunAsAq(run(M))).toEqual({ at: NOWC - M, status: 'ok', label: '성공' });
    expect(cronRunAsAq(run(M, { status: 'failed', error: 'staging 502' }))).toEqual({
      at: NOWC - M,
      status: 'failed',
      label: '실패',
      error: 'staging 502',
    });
    expect(cronRunAsAq(run(M, { session: live('working') })).status).toBe('running');
    expect(cronRunAsAq(run(M, { session: live('waiting') })).status).toBe('waiting');
    expect(
      cronRunAsAq(run(M, { status: 'queued', executionPath: 'busy_queue', session: live('working') })),
    ).toMatchObject({
      status: 'unknown',
      label: '대기열에 넣음 (세션 사용 중 — 이후 실행 결과는 기록 없음)',
    });
    expect(cronRunAsAq(run(M, { executionPath: 'dm' }))).toMatchObject({
      status: 'unknown',
      label: 'DM 전송 (세션 없음)',
    });
    expect(cronRunAsAq(run(M, { executionPath: 'thread_reply' }))).toMatchObject({
      status: 'unknown',
      label: '스레드 답글 (세션 없음)',
    });
    const unrecorded = cronRunAsAq({
      executedAt: NOWC - M,
      status: 'unrecorded',
      session: { live: false, activityState: 'idle' },
    });
    expect(unrecorded).toEqual({
      at: NOWC - M,
      status: 'unknown',
      label: '실행 기록 없음 (보드 카드만 있음)',
      recorded: false,
    });
  });

  it('runs24h counts the records only; through the library: 5 records, ≥ from where a capped history starts', () => {
    const f = laneFns();
    const d = f.laneData(f.planCronLane(BOARD, JOBS, null));
    // the strip shows the running qa card before its record exists — never one of the kept records
    const qa = d.lane.jobs.find((j: any) => j.id === 'id:job-qa');
    expect(qa.runs.filter((r: any) => r.recorded === false)).toHaveLength(1);
    expect(d.lane.runs24h.every((r: any) => typeof r.jobId === 'string')).toBe(true);
    const day = lib.dayRuns(d.lane, NOWC);
    // records only: qa 1h ok + 2h failed · deps 15m + 45m ok (the queue entry is not a run) · digest 22m in
    // progress (its turn settled, its session now waits). The running qa card and the other instance's idle
    // card have no record: the first is the 실행 중 tile, the second +미확인.
    expect([day.n, day.ok, day.fail, day.run, day.unknown]).toEqual([5, 3, 1, 1, 1]);
    // dependency-audit keeps 3 records (the queue entry is one) at its cap of 3, the oldest 45m ago
    expect(day.cut).toEqual([{ name: 'dependency-audit', from: NOWC - 45 * M, cap: 3 }]);
    expect(day.cutFrom).toBe(NOWC - 45 * M);
  });

  // #554 review P3: the host must not window runs24h again — the element does, and its ≥ needs every record.
  it('cronDayRuns passes every record, older than 24 hours too: the element applies the window', () => {
    const f = laneFns();
    const old = [job('job-old', 'weekly-report', 30 * M, [run(10 * M), run(3 * 24 * HR), run(30 * 24 * HR)])];
    const runs = f.cronDayRuns(f.planCronLane(empty, old, null));
    expect(runs.map((r: any) => r.at)).toEqual([NOWC - 10 * M, NOWC - 3 * 24 * HR, NOWC - 30 * 24 * HR]);
    // The element counts only the last 24 hours of them.
    expect(lib.dayRuns(f.laneData(f.planCronLane(empty, old, null)).lane, NOWC).n).toBe(1);
    // The intent is pinned where the next reader looks.
    const head = TEMPLATE.slice(0, TEMPLATE.indexOf('\nfunction cronDayRuns('));
    expect(head.slice(head.lastIndexOf('\n\n'))).toContain(
      'Every record goes, not just the last 24 hours: the element applies the window',
    );
  });

  it('a live card with no record is not counted; an idle one is +미확인, never a success (review R1)', () => {
    const f = laneFns();
    const idle = card('k-old', 'job-qa', 'nightly-qa', { lastActivity: new Date(NOWC - 3 * HR).toISOString() });
    const runs = f.cronDayRuns(f.planCronLane({ ...BOARD, idle: [...BOARD.idle, idle] }, JOBS, null));
    const unknown = runs.filter((r: any) => r.status === 'unknown');
    expect(unknown.map((r: any) => r.jobId).sort()).toEqual(['id:job-qa', 'name:release-notes']);
    expect(runs.some((r: any) => r.at === NOWC - 4 * M)).toBe(false); // the running qa card
  });

  it('the 24h counts and the strip agree on every record shape the server emits (trinity R2)', () => {
    const f = laneFns();
    const shape = (session: Record<string, unknown>) => [
      job('job-s', 'shape', 30 * M, [run(10 * M, { session: { headline: 'h', boardKey: 'k-x', ...session } })]),
    ];
    const cases: [Record<string, unknown>, 'ok' | 'run'][] = [
      [{ live: true, activityState: 'idle' }, 'ok'], // injected into a human session
      [{ live: false, activityState: 'idle', earlierInThread: true }, 'ok'], // an earlier run of the thread
      [{ live: true, activityState: 'working' }, 'run'], // its own session still runs
      [{ live: true, activityState: 'waiting' }, 'run'], // its own session waits for a reply
    ];
    for (const [session, kind] of cases) {
      const d = f.laneData(f.planCronLane(empty, shape(session), null));
      const day = lib.dayRuns(d.lane, NOWC);
      expect([day.ok, day.run]).toEqual(kind === 'ok' ? [1, 0] : [0, 1]);
      expect(lib.runKind(d.lane.jobs[0].runs[0].status)).toBe(kind);
    }
  });
});

// ── fakes for the DOM-touching glue ──
type FakeEl = {
  id?: string;
  hidden: boolean;
  className: string;
  children: FakeEl[];
  parentNode: FakeEl | null;
  attrs: Record<string, string>;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
  [k: string]: unknown;
};
function fakeEl(id?: string): FakeEl {
  return {
    id,
    hidden: false,
    className: '',
    children: [],
    parentNode: null,
    attrs: {},
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
    getAttribute(k) {
      return this.attrs[k] ?? null;
    },
    appendChild(c) {
      if (c.parentNode) c.parentNode.removeChild(c);
      this.children.push(c);
      c.parentNode = this;
      return c;
    },
    removeChild(c) {
      this.children = this.children.filter((x) => x !== c);
      c.parentNode = null;
      return c;
    },
  };
}

describe('wiring — the lane’s job boxes, the paint, the fold, the drawer', () => {
  function lane(folded = false) {
    const els: Record<string, FakeEl> = { 'cron-lane': fakeEl('cron-lane'), 'cron-aq': fakeEl('cron-aq') };
    const document = { getElementById: (id: string) => els[id] ?? null, createElement: () => fakeEl() };
    const later: Array<() => void> = [];
    const aqPaint = vi.fn();
    const f = load<Fns>(
      [...LANE_FNS, 'laneSig', 'syncCronLane', 'cronLaneSlots'],
      ['CRON_AQ_STATUS', '_cronGroupEls', '_cronJobsRev'],
      {
        cronLaneFolded: () => folded,
        document,
        aqPaint,
        MOTION: { fade: 180 },
        setTimeout: (fn: () => void) => later.push(fn),
      },
    );
    return { f, els, aqPaint, later };
  }

  it('each job group has one box in its job’s slot, kept across renders; a group that goes, goes after its fade', () => {
    const { f, els, aqPaint, later } = lane();
    const p1 = f.planCronLane(BOARD, JOBS, null);
    f.syncCronLane(p1);
    const el = els['cron-aq'];
    expect(els['cron-lane'].hidden).toBe(false);
    expect(el.children.map((c) => c.getAttribute('slot')).sort()).toEqual(
      p1.groups.map((g: any) => `job:${g.key}`).sort(),
    );
    expect(el.children.every((c) => c.className === 'cards cron-cards')).toBe(true);
    expect(aqPaint).toHaveBeenLastCalledWith(el, f.laneData(p1));
    const qaBox = el.children.find((c) => c.getAttribute('slot') === 'job:id:job-qa');
    // next render: the same box; the other instance's group is gone
    const p2 = f.planCronLane({ ...BOARD, idle: [] }, JOBS, null);
    f.syncCronLane(p2);
    expect(el.children.find((c) => c.getAttribute('slot') === 'job:id:job-qa')).toBe(qaBox);
    expect(el.children.some((c) => c.getAttribute('slot') === 'job:name:release-notes')).toBe(true);
    later.forEach((fn) => fn());
    expect(el.children.some((c) => c.getAttribute('slot') === 'job:name:release-notes')).toBe(false);
    f.syncCronLane(f.planCronLane(empty, [], null));
    expect(els['cron-lane'].hidden).toBe(true);
  });

  it('the reconciler puts each job’s lead card in its box; folded, only the jobs that wait for a reply keep theirs', () => {
    const open = lane(false);
    const p = open.f.planCronLane(BOARD, JOBS, null);
    open.f.syncCronLane(p);
    const slots = open.f.cronLaneSlots(p);
    const box = (key: string) => open.els['cron-aq'].children.find((c) => c.getAttribute('slot') === `job:${key}`);
    const qa = slots[p.groups.findIndex((g: any) => g.key === 'id:job-qa')];
    expect(qa.container).toBe(box('id:job-qa'));
    expect(qa.items.map((i: any) => i.s.key)).toEqual(['k-qa']);
    const shut = lane(true);
    const ps = shut.f.planCronLane(BOARD, JOBS, null);
    shut.f.syncCronLane(ps);
    const shown = shut.f.cronLaneSlots(ps).flatMap((s: any) => s.items.map((i: any) => i.s.key));
    expect(shown).toEqual(['k-dig']);
  });

  // #554 review P3: every board render used to build the lane and JSON.stringify all of it.
  it('the lane is rebuilt only when what it is made of changed — a jobs fetch, a card, the fold — or a minute on', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOWC);
    try {
      let folded = false;
      const els: Record<string, FakeEl> = { 'cron-lane': fakeEl('cron-lane'), 'cron-aq': fakeEl('cron-aq') };
      const aqPaint = vi.fn();
      const f = load<Fns>(
        [...LANE_FNS, 'laneSig', 'syncCronLane', 'loadCronJobs'],
        ['CRON_AQ_STATUS', '_cronGroupEls', '_cronJobs', '_cronJobsRev'],
        {
          cronLaneFolded: () => folded,
          document: { getElementById: (id: string) => els[id] ?? null, createElement: () => fakeEl(), hidden: false },
          aqPaint,
          MOTION: { fade: 180 },
          setTimeout: () => {},
          fetch: async () => ({ ok: true, json: async () => ({ jobs: JOBS }) }),
          currentUserId: 'U1',
          _lastBoardData: null,
          renderBoard: () => {},
        },
      );
      const plan = (board = BOARD) => f.planCronLane(board, JOBS, null);
      f.syncCronLane(plan());
      expect(aqPaint).toHaveBeenCalledTimes(1);
      // The next board render (a push elsewhere on the board): a new plan with the same lane — nothing built.
      f.syncCronLane(plan());
      expect(aqPaint).toHaveBeenCalledTimes(1);
      // A cron card moves column.
      const moved = { ...BOARD, working: [], waiting: [...BOARD.waiting, ...BOARD.working] };
      f.syncCronLane(plan(moved));
      expect(aqPaint).toHaveBeenCalledTimes(2);
      expect(aqPaint).toHaveBeenLastCalledWith(els['cron-aq'], f.laneData(plan(moved)));
      // A jobs fetch (its records, schedules and caps): a new revision.
      await f.loadCronJobs();
      f.syncCronLane(plan(moved));
      expect(aqPaint).toHaveBeenCalledTimes(3);
      // The fold.
      folded = true;
      f.syncCronLane(plan(moved));
      expect(aqPaint).toHaveBeenCalledTimes(4);
      // A minute on: the 24-hour window slides.
      vi.setSystemTime(NOWC + 60_000);
      f.syncCronLane(plan(moved));
      expect(aqPaint).toHaveBeenCalledTimes(5);
      expect(clientFn('laneSig')).not.toContain('JSON.stringify');
    } finally {
      vi.useRealTimers();
    }
  });

  it('an element is handed its data only when it changed, or once a minute; rendered at once', () => {
    let now = NOWC;
    const { aqPaint } = load<Fns>(['aqPaint'], [], { Date: { now: () => now } });
    const el: any = { renderNow: vi.fn() };
    expect(aqPaint(el, { a: 1 })).toBe(true);
    expect(el.data).toEqual({ a: 1 });
    expect(el.renderNow).toHaveBeenCalledTimes(1);
    expect(aqPaint(el, { a: 1 })).toBe(false);
    expect(aqPaint(el, { a: 2 })).toBe(true);
    now += 60_000;
    expect(aqPaint(el, { a: 2 })).toBe(true);
    expect(el.renderNow).toHaveBeenCalledTimes(3);
    // before the module has defined the element: data only (it moves through the setter on upgrade)
    const early: any = {};
    expect(aqPaint(early, { a: 1 })).toBe(true);
    expect(early.data).toEqual({ a: 1 });
  });

  it('paintCapacity: hidden on an auth-mode deployment; else the mapped view, and the fold it used', () => {
    const els: Record<string, any> = { capacity: { hidden: true }, 'capacity-aq': {} };
    const paints: unknown[] = [];
    const mk = (v: unknown) =>
      new Function(
        'document',
        'secIsOpen',
        'aqPaint',
        'capData',
        `var _capacityView = ${JSON.stringify(v)}; var _capFoldApplied = null;\n${clientFn('paintCapacity')}\npaintCapacity(); return _capFoldApplied;`,
      )(
        { getElementById: (id: string) => els[id], hidden: false },
        () => false,
        (_el: unknown, d: unknown) => paints.push(d),
        (x: any) => ({ mapped: x.available }),
      );
    expect(mk({ available: false, reason: 'auth mode — no llmux', groups: [] })).toBe(null);
    expect(els.capacity.hidden).toBe(true);
    expect(paints).toEqual([]);
    expect(mk({ available: true, groups: [] })).toBe(true);
    expect(els.capacity.hidden).toBe(false);
    expect(paints).toEqual([{ mapped: true }]);
    // the loader only fetches and paints: selection, focus and announcements are the element's
    const loader = clientFn('loadCapacity');
    expect(loader).toContain('_capacityView = data.capacity || null;');
    expect(loader).toContain('paintCapacity();');
  });

  it('ui-collapse: the page decides — cancelled, and toggled only when the press asks for a change', () => {
    const toggleSection = vi.fn();
    let open = { capacity: false, cron: true } as Record<string, boolean>;
    const on = docListener('ui-collapse', { secIsOpen: (s: string) => open[s], toggleSection });
    const ev = (id: string, collapsed: boolean) => ({
      target: { id },
      detail: { section: 'x', collapsed },
      preventDefault: vi.fn(),
    });
    const unfold = ev('capacity-aq', false);
    on(unfold);
    expect(unfold.preventDefault).toHaveBeenCalled();
    expect(toggleSection).toHaveBeenLastCalledWith('capacity');
    on(ev('cron-aq', true));
    expect(toggleSection).toHaveBeenLastCalledWith('cron');
    open = { capacity: true, cron: false };
    toggleSection.mockClear();
    on(ev('cron-aq', true)); // already folded
    const other = ev('model-picker', true);
    on(other);
    expect(toggleSection).not.toHaveBeenCalled();
    expect(other.preventDefault).not.toHaveBeenCalled();
  });

  it('the fold reaches the elements: capacity repaints when its fold changed; a CRON change asks for a board render', () => {
    const paintCapacity = vi.fn();
    let capOpen = false;
    let cronOpen = true;
    const body = `var _capFoldApplied = true; var _cronFoldApplied = null;\n${clientFn('applySectionState')}\nreturn applySectionState;`;
    const apply = new Function('secIsOpen', 'cronLaneFolded', 'paintCapacity', body)(
      (s: string) => (s === 'capacity' ? capOpen : cronOpen),
      () => !cronOpen,
      paintCapacity,
    );
    expect(apply()).toBe(false); // the first CRON state is the baseline
    expect(paintCapacity).not.toHaveBeenCalled();
    capOpen = true;
    cronOpen = false;
    expect(apply()).toBe(true);
    expect(paintCapacity).toHaveBeenCalledTimes(1);
    const toggle = clientFn('toggleSection');
    expect(toggle.indexOf('layoutBeforeChange()')).toBeLessThan(toggle.indexOf('applySectionState()'));
    expect(toggle).toContain('if (applySectionState()) renderBoardForLayout();');
  });

  it('ui-job-open from the lane opens its job’s drawer (the job id is the group key)', () => {
    const openCronDrawer = vi.fn();
    const on = docListener('ui-job-open', { openCronDrawer });
    on({ target: { id: 'cron-aq' }, detail: { jobId: 'id:job-qa' } });
    expect(openCronDrawer).toHaveBeenCalledWith('id:job-qa');
    on({ target: { id: 'capacity-aq' }, detail: { jobId: 'x' } });
    expect(openCronDrawer).toHaveBeenCalledTimes(1);
  });

  it('closing the drawer returns focus inside the element — to the same control, or its re-rendered twin by data-key', () => {
    const focus = vi.fn();
    const twinFocus = vi.fn();
    const btn: any = { isConnected: true, focus, getAttribute: (k: string) => (k === 'data-key' ? 'runs-abc' : null) };
    const twin: any = { isConnected: true, focus: twinFocus, getAttribute: () => 'runs-abc' };
    const shadowRoot: any = { activeElement: btn, querySelectorAll: () => [twin] };
    const host: any = { shadowRoot, getAttribute: () => null };
    // D1 (C-05): the drawer is @2lab.ai/ui <ui-drawer> — the page opens and closes it with show() / hide().
    const drawer = fakeEl('cron-drawer') as any;
    drawer.show = vi.fn();
    drawer.hide = vi.fn();
    const els: Record<string, any> = { 'cron-drawer': drawer };
    const document = { activeElement: host, getElementById: (id: string) => els[id] };
    const f = load<Fns>(['openCronDrawer', 'closeCronDrawer'], ['_cronDrawerReturnFocus'], {
      document,
      paintCronDrawer: () => {},
      _cronDrawerKey: null,
    });
    f.openCronDrawer('id:job-qa');
    expect(drawer.show).toHaveBeenCalledTimes(1);
    f.closeCronDrawer();
    expect(drawer.hide).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);
    // a lane render while the drawer was open replaced the control
    f.openCronDrawer('id:job-qa');
    btn.isConnected = false;
    f.closeCronDrawer();
    expect(twinFocus).toHaveBeenCalledTimes(1);
  });

  it('D20 — the drawer stays the page’s: rows per run, Escape closes it, its countdown rides the page tick', () => {
    expect(clientFn('renderCronRunRow')).toContain('data-cron-open');
    expect(clientFn('paintCronDrawer')).toContain('cronGroupRuns(g)');
    // Escape, the scrim and ✕ are the element's ui-close, answered by the page's own close (focus return).
    expect(TEMPLATE).toContain("if (d) d.addEventListener('ui-close', function(e) { e.preventDefault(); closeCronDrawer(); });");
    const tick = clientFn('aqTick');
    expect(tick).toContain("getElementById('cron-drawer')");
    expect(tick).not.toContain("getElementById('capacity')");
    expect(clientFn('renderCronDrawerMeta')).toContain('aqTime(j.nextRunAt');
  });
});

/*
 * Moved tests → the library suite that now owns the behaviour
 * (@2lab.ai/ui src/components/agent-queue/agent-queue.test.ts, 0.4.2):
 *
 *   D1  two sections, static live region ............ 'announces state changes once, never the first data',
 *                                                      'writes the live region as text only'
 *   D2  pill · D8 provider head pill ................. 'draws the provider card: head, disclosure, two bars, marks, timeline',
 *                                                      'says all limited, counts down to the first return and shades the timeline'
 *   D3  live countdown, "곧" never "곧 후", s vs ms .... 'floors time left and never says “in soon”',
 *                                                      'renders the same countdown from seconds and from milliseconds',
 *                                                      'ticks countdowns in place once a second, without re-rendering'
 *   D4  one polite sentence (capacity, lane) ......... 'builds announcement sentences from data changes'
 *   D5–D7 tokens, motion, container queries .......... styles.ts (--aq-warn-text, reduced motion, @container aqlane/aqcap)
 *   D9  the 20% line ................................. 'draws the provider card…' (+ LOW_PCT parity above)
 *   D10 account marks · narrow fold .................. 'folds the usable accounts into one mark when narrow, with a list card'
 *   D11 the account card ............................. 'emits ui-account-open and opens the account card; Esc closes and refocuses the mark',
 *                                                      'closes the card from its close button, a second press, and an outside click'
 *   D10–D12 identity / new response (R3) ............. 'closes the card when its account leaves the data' (+ identity tests above)
 *   D12 roving focus ................................. 'roves the account marks with one tab stop; arrows, Home and End',
 *                                                      'keeps the roving stop across a re-render'
 *   D13 all-blocked stretch .......................... 'says all limited, counts down to the first return and shades the timeline'
 *   D14 folded chip · ⏸ marker · ⚠ flags .............. 'collapsed capacity: the head and one chip per provider — measures, ⏸ limited · first return, ⚠ flags'
 *   D15 lane head pills · D16 four numbers ........... 'draws four stats, the queue, job cards and a 24-hour chart'
 *   D16 lower bounds with runs24h .................... 'keeps the lower bounds when runs24h supplies the counts (the kept records decide)',
 *                                                      'never counts a run shown before its record exists toward historyCap'
 *   D17 the next-fire queue, +N, empty ............... 'shows +N past four queued jobs', 'says so when nothing is scheduled'
 *   D18 the tile counts down live .................... 'ticks countdowns in place once a second, without re-rendering'
 *   D19 24 hours of runs, hatch, sentence ............ 'marks lower bounds and hatches the truncated stretch'
 *   R1  names, errors, labels are text ............... 'escapes every host-written string, in text and in attributes'
 *   other instance's job (잡 정보 없음) ............... 'draws a job note after the name, escaped, with its tooltip'
 *   folded lane: only the waiting jobs ............... 'collapsed lane: the head and only the jobs waiting for a reply — no stats, queue or chart'
 *   the fold toggle (펼치기 / 접기) ................... 'collapsible: the toggle in each head says what a press does and sends a cancelable ui-collapse',
 *                                                      'speaks Korean when folded: 펼치기 / 접기 and the dashboard’s chip words'
 *   the lead card under its tile ..................... 'per-job slot: the host’s live card sits under its tile and survives every re-render',
 *                                                      'per-job slot: a slotted card does not swallow Esc or keep the account card open on a press'
 *   D20 the drawer stays the page's .................. above ('D20 — the drawer stays the page’s')
 */
