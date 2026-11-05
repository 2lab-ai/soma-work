/**
 * ssot-task: T4 — the dashboard card of a safeguards-halted session says
 * "세이프가드 에러 · 관리자만 재시도" instead of "대기". Run from the shipped
 * template (the harness of dashboard-star-revive-client.test.ts).
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
  'OWNER_BADGE_HUES',
];
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

describe('T4 — a safeguards-halted card names the safeguard error', () => {
  const face = load<{ cardOf: (s: unknown, col: string) => { status: string; statusText?: string } }>(
    CARD_OF_FNS,
    CARD_OF_VARS,
    CARD_ENV,
  );

  it('an idle halted card reads "세이프가드 에러 · 관리자만 재시도", not "대기"', () => {
    const c = face.cardOf(card({ safeguardHalt: { atMs: 1, detail: 'reasoning_extraction' } }), 'idle');
    expect(c.statusText).toBe('세이프가드 에러 · 관리자만 재시도');
    expect(c.status).toBe('waiting');
  });

  it('a card without a halt is unchanged', () => {
    expect(face.cardOf(card(), 'idle').statusText).toBe('대기');
  });
});
