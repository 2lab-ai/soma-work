/**
 * .prd/39 S6 · D14 — the client half of the goal's column (X17, A17). The server places the card (`goalBoard`); the
 * page reads that value instead of recomputing from the display activity: an epic child's column, the root status,
 * the card's status line, and the goal line's chip names the phase (or the hold) instead of the bare status.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { viewerScope } from '../__fixtures__/viewer-scope';

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));

function cook(fragment: string): string {
  if (fragment.includes('`') || fragment.includes('${')) throw new Error('fragment is not a plain template slice');
  return new Function(`return \`${fragment}\`;`)() as string;
}
function clientFn(name: string): string {
  const start = TEMPLATE.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = TEMPLATE.indexOf('\n}\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 2));
}
function clientVar(name: string): string {
  const m = TEMPLATE.match(new RegExp(`^(var ${name} = .*?;)(?:\\s*//.*)?$`, 'm'));
  if (!m) throw new Error(`client var ${name} not found`);
  return cook(m[1]);
}
/** The page's chrome words (STRINGS), as served: the board's Korean words live there (D2 group 6). */
const PAGE_STRINGS = new Function(
  `${cook(TEMPLATE.slice(TEMPLATE.indexOf('var STRINGS = {'), TEMPLATE.indexOf('\n};\n', TEMPLATE.indexOf('var STRINGS = {')) + 3))}\nreturn STRINGS;`,
)();
function load<T>(fns: string[], vars: string[], inject: Record<string, unknown> = {}): T {
  ({ fns, inject } = viewerScope(fns, inject));
  inject = { STRINGS: PAGE_STRINGS, ...inject };
  const names = Object.keys(inject);
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}

// The face is now @2lab.ai/ui <ui-agent-inbox>'s: the page hands it the card
// data (cardOf) — status, statusText and summary as text, escaped by the
// element ('escapes every user and model string'). The open card's resume row
// (renderCardResume) is still the page's.
const CARD_OF_FNS = [
  'toNum',
  'formatTokens',
  'formatTaskTime',
  'permissionSummary',
  'cardSummary',
  'pendingAutoResume',
  'autoResumeLabel',
  'pendingQueueWait',
  'queueWaitLabel',
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
  'cardLinksFace',
  'cardRepoOf',
  'cardChannelOf',
  '_hashStr',
  'ownerBadgeHue',
  'isSiblingSession',
  'cardOf',
];
const CARD_OF_VARS = [
  'PR_STATE_LABEL',
  'CARD_LINK_KIND',
  'CARD_LINK_TONES',
  'PR_STATE_TONE',
  'AGENT_STATUS_LABEL',
  'AGENT_STATUS_TONE',
  'AGENT_STATUS_GLYPH',
  'OWNER_BADGE_HUES',
];

interface Card {
  cardOf(s: unknown, col: string): Record<string, unknown>;
  epicChildCol(c: unknown): string;
  rootStatusOf(s: unknown, col: string): string;
}

const card = load<Card>([...CARD_OF_FNS, 'epicChildCol', 'rootStatusOf'], [...CARD_OF_VARS, 'GOAL_BOARD_LABELS'], {
  dhShow: () => false,
  dhTruncate: () => null,
  currentUserId: 'U1',
  _ownerIndex: null,
  SELF_INSTANCE_NAME: '',
});
const line = load<{ cardGoalLine(s: unknown, col: string, canEdit: boolean): string }>(
  ['esc', 'escAttr', 'escJs', 'toNum', 'cardGoalLine'],
  ['GOAL_STATUS_LABELS', 'GOAL_STATUS_TONE', 'GOAL_PHASE_LABELS', 'GOAL_PHASE_TONE', 'GOAL_SVG'],
);

const idle = (over: Record<string, unknown> = {}) => ({
  key: 'self::C1:t1',
  activityState: 'idle',
  activeAccumulatedMs: 1000,
  ...over,
});

describe('the page reads the goal column the server placed (S6)', () => {
  it('an idle epic child the goal drives reads RUNNING; one the goal asks about reads NEEDS YOU', () => {
    expect(card.epicChildCol(idle({ goalBoard: { col: 'working', why: 'driven' } }))).toBe('working');
    expect(card.epicChildCol(idle({ goalBoard: { col: 'waiting', why: 'cap', at: 5 } }))).toBe('waiting');
    expect(card.epicChildCol(idle())).toBe('idle');
    // The board's own rules first: a sleeping child is closed whatever its goal says.
    expect(card.epicChildCol(idle({ sessionState: 'SLEEPING', goalBoard: { col: 'working', why: 'driven' } }))).toBe(
      'closed',
    );
  });

  it('the root of a card the goal keeps RUNNING reads running, not idle', () => {
    expect(card.rootStatusOf(idle({ goalBoard: { col: 'working', why: 'driven' } }), 'working')).toBe('running');
    expect(card.rootStatusOf(idle(), 'idle')).toBe('idle');
  });

  it('the status line says what the goal does: driven, a turn starting, the cap question, the loop’s stop', () => {
    expect(card.cardOf(idle({ goalBoard: { col: 'working', why: 'driven' } }), 'working').statusText).toBe(
      '목표 이어가는 중',
    );
    expect(card.cardOf(idle({ goalBoard: { col: 'working', why: 'turn' } }), 'working').statusText).toBe('턴 시작 중');
    const cap = card.cardOf(
      idle({ waitingSince: 4242, goalBoard: { col: 'waiting', why: 'cap', at: 4242 } }),
      'waiting',
    );
    expect(cap.status).toBe('waiting');
    expect(cap.statusText).toBe('목표 이어하기 한도 — 계속할까요?');
    expect(cap.since).toBe(4242);
    expect(card.cardOf(idle({ goalBoard: { col: 'waiting', why: 'judge-failed', at: 1 } }), 'waiting').statusText).toBe(
      '목표 멈춤 — 완료 판정 실패',
    );
  });

  it('a card its own turn runs keeps the running face (the goal does not relabel it)', () => {
    const c = card.cardOf(
      idle({ activityState: 'working', activeLegStartedAtMs: 7, goalBoard: { col: 'working', why: 'turn' } }),
      'working',
    );
    expect(c.status).toBe('running');
    expect(c.statusText).toBeUndefined();
  });
});

describe('the goal line names the phase (S3)', () => {
  const goalOf = (current: Record<string, unknown>) =>
    idle({
      goal: {
        current: { goalId: 'g1', objective: '릴리즈', continuationCount: 3, maxContinuations: 10, ...current },
        queue: [],
        paused: [],
        completedCount: 0,
        history: [],
      },
    });
  const chip = (html: string) => /<span class="ui-status cg-status"[^>]*>([^<]*)<\/span>/.exec(html)?.[1];
  const tone = (html: string) => /cg-status" data-tone="([^"]+)"/.exec(html)?.[1];

  it.each([
    [{ status: 'active', phase: { kind: 'running' } }, '진행 중', 'run'],
    [{ status: 'active', phase: { kind: 'opening' } }, '시작 중', 'run'],
    [{ status: 'active', phase: { kind: 'retrying' } }, '판정 재시도', 'wait'],
    [{ status: 'active', phase: { kind: 'asking', why: 'cap' } }, '계속할까요?', 'wait'],
    [{ status: 'active', phase: { kind: 'asking', why: 'stall' } }, '답을 기다림', 'wait'],
    [{ status: 'active', phase: { kind: 'stopped', why: 'person-stopped' } }, '멈춤', 'wait'],
    [{ status: 'active', phase: { kind: 'stopped', why: 'judge-failed' } }, '멈춤 · 판정 실패', 'wait'],
    [{ status: 'paused', phase: { kind: 'hold', why: 'cap-stop' } }, '일시정지', 'wait'],
    // A card from an older server carries no phase: the status word, as before.
    [{ status: 'active' }, '진행 중', 'run'],
  ])('%j → %s', (current, label, t) => {
    const html = line.cardGoalLine(goalOf(current), 'idle', true);
    expect(chip(html)).toBe(label);
    expect(tone(html)).toBe(t);
  });
});
