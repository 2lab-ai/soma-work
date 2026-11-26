/**
 * #1474 — the card says whether the model waits on its owner, or the owner answered and the answer is on its way.
 *
 * 2026-11-26: the model asked a question and kept working (a run held open by background work). The card switched
 * to 응답 필요 as if the session had stopped for its owner, and after the owner answered it read plain running while
 * the answer sat in the follow-up queue behind another message for 18 minutes. The owner could not tell a stopped
 * session from a working one, nor an answer the model has from one it does not.
 *
 *   작업 중 · 응답 필요       — a question is open and a turn still holds the session. The card stays in 응답 필요:
 *                               the question is the owner's to answer, and a busy slot never hides it.
 *   답변 접수 · 모델 전달 대기 — the owner's answer waits in the queue, or was handed into the running turn without a
 *                               read receipt.
 *   (plain running)            — the model read it (the queue's read receipt), or it runs as its own turn.
 *
 * Executes the shipped client code cut out of renderDashboardPage()'s template (the harness of
 * dashboard-affectui-agent-inbox-client.test.ts); `cardOf`'s status helpers come in through viewerScope
 * (CARD_STATE_FNS), as they do for every harness that loads `cardOf`.
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
function declarationCount(name: string): number {
  const re = new RegExp(`^(?:async function|function|var|let|const) ${name.replace(/[$]/g, '\\$')}\\b`, 'gm');
  return (TEMPLATE.match(re) ?? []).length;
}
// Cut + cooked once per name: the suites load the same functions many times.
const cutCache = new Map<string, string>();
function clientFn(name: string): string {
  const hit = cutCache.get(name);
  if (hit !== undefined) return hit;
  const cut = cutClientFn(name);
  cutCache.set(name, cut);
  return cut;
}
function cutClientFn(name: string): string {
  const n = declarationCount(name);
  if (n > 1) throw new Error(`client ${name} is declared ${n} times`);
  let start = TEMPLATE.indexOf(`\nfunction ${name}(`);
  if (start < 0) start = TEMPLATE.indexOf(`\nasync function ${name}(`);
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

const CARD_OF_FNS = [
  'toNum',
  'formatTokens',
  'formatTaskTime',
  'permissionSummary',
  'cardSummary',
  'pendingAutoResume',
  'pendingQueueWait',
  'autoResumeLabel',
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
const CARD_ENV = {
  dhShow: () => true,
  dhTruncate: () => null,
  currentUserId: 'U1',
  _ownerIndex: null,
  SELF_INSTANCE_NAME: 'inst',
};

const T0 = 1_700_000_000_000;
type Card = Record<string, unknown>;
const faceCard = (over: Record<string, unknown> = {}) => ({
  key: 'inst::C1:t1',
  displayHeadline: 'Agent inbox',
  ownerId: 'U1',
  ownerName: 'Z',
  activityState: 'idle',
  activeLegStartedAtMs: 0,
  activeAccumulatedMs: 120_000,
  lastActivity: '2026-10-25T10:00:00.000Z',
  ...over,
});
const mapper = (env: Record<string, unknown> = {}) =>
  load<{ cardOf(s: unknown, col: string): Card }>(CARD_OF_FNS, CARD_OF_VARS, { ...CARD_ENV, ...env });

const QUESTION = { type: 'user_choice', question: '어떻게 할까요?', choices: [{ id: '1', label: '진행' }] };
const answerRow = (state: string, over: Record<string, unknown> = {}) => ({
  id: `C1:t1#${state}`,
  text: '1',
  files: [],
  enqueuedAt: T0,
  state,
  epoch: 1,
  editable: false,
  answer: true,
  ...over,
});

describe('a question open while the run still works (#1474)', () => {
  const { cardOf } = mapper();

  it('reads 작업 중 · 응답 필요 in 응답 필요, the wait tone and its clock kept', () => {
    const c = cardOf(
      faceCard({ activityState: 'waiting', pendingQuestion: QUESTION, turnBusy: true, waitingSince: T0 }),
      'waiting',
    );
    expect(c).toMatchObject({ status: 'waiting', statusText: '작업 중 · 응답 필요', since: T0 });
  });

  it('a question with no turn holding the session is the plain wait: the session waits on its owner', () => {
    const c = cardOf(faceCard({ activityState: 'waiting', pendingQuestion: QUESTION, waitingSince: T0 }), 'waiting');
    expect(c.status).toBe('waiting');
    expect(c.statusText).toBeUndefined();
  });

  it('a wait with no question (a permission prompt) is not said to need an answer to a question', () => {
    const c = cardOf(faceCard({ activityState: 'waiting', turnBusy: true, waitingSince: T0 }), 'waiting');
    expect(c.statusText).toBeUndefined();
  });
});

describe('an answer on its way to the model (#1474)', () => {
  const { cardOf } = mapper();
  const working = (items: unknown[]) =>
    faceCard({ activityState: 'working', activeLegStartedAtMs: T0, followups: { turnEpoch: 1, items } });

  it.each([
    'queued',
    'paused',
    'steered',
    'reserved',
    'claimed',
    'dispatched',
  ])('an answer row %s reads 답변 접수 · 모델 전달 대기 — the model does not have it yet', (state) => {
    const c = cardOf(working([answerRow(state)]), 'working');
    expect(c).toMatchObject({ status: 'running', statusText: '답변 접수 · 모델 전달 대기', since: T0 });
  });

  it('read by the model (it left the list for settled) or failed: plain running, no claim it is on its way', () => {
    expect(cardOf(working([]), 'working').statusText).toBeUndefined();
    expect(cardOf(working([answerRow('failed')]), 'working').statusText).toBeUndefined();
    expect(cardOf(working([answerRow('uncertain')]), 'working').statusText).toBeUndefined();
  });

  it("an instruction (not an answer) in the queue is the queue chip's to show, not the card's", () => {
    expect(cardOf(working([answerRow('queued', { answer: undefined })]), 'working').statusText).toBeUndefined();
  });
});
