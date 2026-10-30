/**
 * Task star + revive (SSOT 2026-10-30) — the page half, run from the shipped
 * template (no copies; each function is cut out of renderDashboardPage()'s
 * template literal and evaluated as the browser receives it).
 *
 *   T1.3 the card leads with ★; the open card and the panel head carry the
 *        Star toggle (owner only)
 *   T2   a starred card sits on top: a pinned group above DONE's days, and a
 *        starred cron run stays on the board instead of the CRON lane
 *   T4.3 a sleeping or archived card offers 살리기
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

type Item = { s: Record<string, unknown>; col: string };
type Group = { key: string; label: string; open: boolean; items: Item[] };

const NOW = new Date(2026, 9, 30, 12, 0, 0).getTime();
const DAY = 24 * 60 * 60 * 1000;

describe('T2.2 — DONE: starred cards in a pinned group above the days', () => {
  const m = load<{ planDoneGroups(done: Item[], now: number, opened: Record<string, boolean>): Group[] }>(
    ['toNum', 'doneTimeOf', 'dayKeyOf', 'doneDayLabel', 'planDoneGroups'],
    [],
  );

  it('a starred card leaves its finish day for the pinned group, which comes first and starts open', () => {
    const done: Item[] = [
      { s: { key: 'a', doneAt: NOW - 60_000 }, col: 'idle' },
      { s: { key: 'old-star', doneAt: NOW - 20 * DAY, starred: true }, col: 'idle' },
      { s: { key: 'b', doneAt: NOW - DAY }, col: 'idle' },
      { s: { key: 'new-star', doneAt: NOW - 2 * DAY, starred: true }, col: 'idle' },
    ];
    const groups = m.planDoneGroups(done, NOW, Object.create(null));
    expect(groups[0].key).toBe('starred');
    expect(groups[0].open).toBe(true);
    expect(groups[0].label).toContain('★');
    expect(groups[0].items.map((it) => it.s.key)).toEqual(['new-star', 'old-star']);
    const rest = groups.slice(1).flatMap((g) => g.items.map((it) => it.s.key));
    expect(rest).toEqual(['a', 'b']);
  });

  it("the reader's fold of the pinned group holds", () => {
    const done: Item[] = [{ s: { key: 's', doneAt: NOW, starred: true }, col: 'idle' }];
    expect(m.planDoneGroups(done, NOW, { starred: false })[0].open).toBe(false);
  });

  it('no starred card, no pinned group', () => {
    const groups = m.planDoneGroups([{ s: { key: 'a', doneAt: NOW }, col: 'idle' }], NOW, Object.create(null));
    expect(groups.map((g) => g.key)).not.toContain('starred');
  });
});

describe('T2 — a starred cron run stays on the board, not in the CRON lane', () => {
  const m = load<{
    planCronLane(
      board: Record<string, unknown[]>,
      jobs: unknown[],
      reveal: string | null,
    ): { board: Record<string, Array<{ key: string }>> };
  }>(['isCronCard', 'cronGroupKey', 'cronCardTime', 'planCronLane'], []);

  it('keeps it in its column', () => {
    const run = (key: string, starred?: boolean) => ({
      key,
      cronJob: { id: 'j1', name: 'nightly' },
      lastActivity: '2026-10-30T00:00:00Z',
      ...(starred ? { starred } : {}),
    });
    const plan = m.planCronLane(
      { working: [], waiting: [], idle: [run('pinned', true), run('plain')], closed: [] },
      [],
      null,
    );
    expect(plan.board.idle.map((s) => s.key)).toEqual(['pinned']);
  });
});

// The card face (cardOf) — the harness of dashboard-cron-capacity-client.test.ts.
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
const CARD_OF_VARS = ['PR_STATE_LABEL', 'PR_STATE_TONE', 'AGENT_STATUS_LABEL', 'OWNER_BADGE_HUES'];
function card(over: Record<string, unknown> = {}) {
  return {
    key: 'inst::C1:t1',
    displayHeadline: 'task',
    title: 'task',
    ownerId: 'U1',
    ownerName: 'Z',
    activityState: 'idle',
    lastActivity: '2026-10-23T04:00:30.000Z',
    channelId: 'C1',
    threadTs: 't1',
    ...over,
  };
}

describe('T1.3 — the card leads with ★', () => {
  const face = load<{
    cardOf: (s: unknown, col: string) => { lead?: { text: string; title?: string; glyph?: string } };
  }>(CARD_OF_FNS, CARD_OF_VARS, CARD_ENV);

  it('a starred card leads with ★, an ordinary one keeps the spark', () => {
    expect(face.cardOf(card({ starred: true }), 'idle').lead?.text).toBe('★');
    expect(face.cardOf(card(), 'idle').lead).toBeUndefined();
  });

  it('a starred cron run reads ★ CRON', () => {
    const lead = face.cardOf(card({ starred: true, cronJob: { id: 'j', name: 'nightly' } }), 'idle').lead;
    expect(lead?.text).toBe('★ CRON');
    expect(lead?.title).toContain('nightly');
  });
});

describe('T1.3 / T4.3 — Star and 살리기 on the open card and in the panel head', () => {
  const m = load<{ sessionActionHtml(s: unknown, col: string, where: string): string }>(
    ['esc', 'escAttr', 'escJs', 'toNum', 'pendingAutoResume', 'isBusy', 'sessionActionsOf', 'sessionActionHtml'],
    ['SESSION_ACTION_TONE'],
    { _busy: Object.create(null), currentUserId: 'U1', SELF_INSTANCE_NAME: '', READ_ONLY_MSG: 'ro' },
  );
  const s = (over: Record<string, unknown> = {}) => ({ key: 'C1:t1', ownerId: 'U1', sessionState: 'MAIN', ...over });

  it('the owner gets a Star toggle that says whether it is on', () => {
    const off = m.sessionActionHtml(s(), 'idle', 'card');
    expect(off).toContain('data-action="star"');
    expect(off).toContain('aria-pressed="false"');
    expect(off).toContain("doStar('C1:t1',true)");
    const on = m.sessionActionHtml(s({ starred: true }), 'idle', 'panel');
    expect(on).toContain('aria-pressed="true"');
    expect(on).toContain("doStar('C1:t1',false)");
  });

  it('someone else reads the star but cannot press it', () => {
    const html = m.sessionActionHtml(s({ ownerId: 'U2', starred: true }), 'idle', 'card');
    expect(html).toMatch(/data-action="star"[^>]* disabled/);
  });

  it('a sleeping or archived card offers 살리기; a live one does not', () => {
    expect(m.sessionActionHtml(s({ sessionState: 'SLEEPING' }), 'closed', 'card')).toContain("doRevive('C1:t1')");
    expect(m.sessionActionHtml(s({ terminated: true, sessionState: 'TERMINATED' }), 'closed', 'panel')).toContain(
      '살리기',
    );
    expect(m.sessionActionHtml(s(), 'idle', 'card')).not.toContain('doRevive(');
    expect(m.sessionActionHtml(s(), 'working', 'card')).not.toContain('doRevive(');
  });

  it('a sibling instance’s card gets no star and no revive here', () => {
    const sib = load<{ sessionActionHtml(s: unknown, col: string, where: string): string }>(
      ['esc', 'escAttr', 'escJs', 'toNum', 'pendingAutoResume', 'isBusy', 'sessionActionsOf', 'sessionActionHtml'],
      ['SESSION_ACTION_TONE'],
      { _busy: Object.create(null), currentUserId: 'U1', SELF_INSTANCE_NAME: 'me', READ_ONLY_MSG: 'ro' },
    );
    const html = sib.sessionActionHtml(
      s({ environment: { instanceName: 'other', host: 'h', port: 1 }, sessionState: 'SLEEPING' }),
      'closed',
      'card',
    );
    expect(html).not.toContain('doStar(');
    expect(html).not.toContain('doRevive(');
  });
});

describe('T4.3 / T5 — the page follows a revived archive to its live key', () => {
  it('doStar / doRevive post to the routes and follow the key the server answers with', () => {
    const star = clientFn('doStar');
    const revive = clientFn('doRevive');
    expect(star).toContain("'/star'");
    expect(revive).toContain("'/revive'");
    const life = clientFn('doLifeAction');
    expect(life).toContain('followSessionKey(key, body.key)');
    const follow = clientFn('followSessionKey');
    expect(follow).toContain('openPanel(newKey');
  });
});
