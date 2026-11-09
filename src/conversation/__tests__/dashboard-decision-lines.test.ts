/**
 * #1073 — decision lines on the dashboard (Plannotator Inbox P2, epic #1076).
 *
 * SSOT (issue #1073 Done): the Slack card and the dashboard session view show the same lines in the same order. The
 * dashboard projection (whitelist 2) dropped every unknown key — and the single question's `context` too.
 *
 *   D1 projection: a single question carries its context and the four decision fields; each group question its own.
 *   D2 projection: only the four known fields, only their own types (nothing else of the stored question leaks).
 *   D3 client decisionLines(q, md): the lines, in Slack's order; md bolds the irreversible label.
 *   D4 single question card (<ui-approval-card> description): context, then the lines.
 *   D5 multi form (<ui-choice-form> question context, markdown): context, a blank line, then the lines.
 *   D6 no fields → the card data is exactly as before (single: description is the context alone, or absent).
 *   D7 an irreversible question is never answered by one press on the card face (quick choices off).
 *   D8 Slack and the dashboard: same lines, same order, same words (Slack's *bold* = the page's **bold** / plain).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChoiceMessageBuilder } from '../../slack/choice-message-builder';
import type { UserChoice } from '../../types';
import { viewerScope } from '../__fixtures__/viewer-scope';

const mockConfig = {
  conversation: {
    summaryModel: 'claude-haiku-4-20250414',
    viewerHost: '127.0.0.1',
    viewerPort: 0,
    viewerUrl: '',
    viewerToken: 'test-token',
  },
  oauth: {
    google: { clientId: '', clientSecret: '' },
    microsoft: { clientId: '', clientSecret: '' },
    jwtSecret: '',
    jwtExpiresIn: 604800,
  },
};

vi.mock('../../config', () => ({ config: mockConfig }));
vi.mock('../../env-paths', () => ({ IS_DEV: true, DATA_DIR: '/tmp/test-data' }));
vi.mock('../recorder', () => ({
  listConversations: vi.fn().mockResolvedValue([]),
  getConversation: vi.fn().mockResolvedValue(null),
  getTurnRawContent: vi.fn().mockResolvedValue(null),
}));
vi.mock('../viewer', () => ({
  renderConversationListPage: vi.fn().mockReturnValue('<html></html>'),
  renderConversationViewPage: vi.fn().mockReturnValue('<html></html>'),
}));
vi.mock('../../session-archive', () => ({
  getArchiveStore: () => ({ listRecent: vi.fn().mockReturnValue([]) }),
}));

const AUTH_HEADER = { Authorization: 'Bearer test-token' };

const CHOICES = [
  { id: '1', label: '지금 돌린다' },
  { id: '2', label: '내일 돌린다' },
  { id: '3', label: '돌리지 않는다' },
];
const LINES = {
  blockedWork: 'PR #42 배포',
  stakes: '사용자 테이블 2만 행',
  reversible: false,
  reversibleWhy: '컬럼을 지우면 백업에서만 되살릴 수 있다',
};

// ── D1/D2 — the projection ──

// The first import of the web server compiles dashboard.ts (large): give it room on a loaded runner.
describe('D1/D2 — /api/dashboard/sessions projects the decision fields', { timeout: 60_000 }, () => {
  let startWebServer: any;
  let stopWebServer: any;
  let injectWebServer: any;
  let setDashboardSessionAccessor: any;

  beforeEach(async () => {
    vi.resetModules();
    const webServer = await import('../web-server');
    startWebServer = webServer.startWebServer;
    stopWebServer = webServer.stopWebServer;
    injectWebServer = webServer.injectWebServer;
    setDashboardSessionAccessor = (await import('../dashboard')).setDashboardSessionAccessor;
    await startWebServer({ listen: false });
  }, 120_000);
  afterEach(async () => {
    await stopWebServer?.();
  });

  const board = async (pendingQuestion: unknown) => {
    const sessions = new Map<string, any>();
    sessions.set('C1:t1', {
      sessionId: 's1',
      title: 'Ask',
      ownerId: 'U1',
      ownerName: 'Alice',
      channelId: 'C1',
      activityState: 'waiting',
      lastActivity: new Date(),
      actionPanel: { pendingQuestion },
    });
    setDashboardSessionAccessor(() => sessions);
    const res = await injectWebServer({ method: 'GET', url: '/api/dashboard/sessions', headers: AUTH_HEADER });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body).board.waiting[0].pendingQuestion;
  };

  it('D1 single: context and the four fields reach the card', async () => {
    const pq = await board({
      type: 'user_choice',
      question: '[small] 돌릴까요?',
      context: '스키마가 바뀌었습니다.',
      recommendedChoiceId: '1',
      choices: CHOICES,
      ...LINES,
    });
    expect(pq).toMatchObject({ type: 'user_choice', context: '스키마가 바뀌었습니다.', ...LINES });
  });

  it('D1 group: each question carries its own fields', async () => {
    const pq = await board({
      type: 'user_choices',
      title: '[medium] 두 가지',
      questions: [
        { id: 'q1', question: 'A?', choices: CHOICES, blockedWork: '릴리스', reversible: true },
        { id: 'q2', question: 'B?', choices: CHOICES, stakes: '변경 기록' },
      ],
    });
    expect(pq.questions[0]).toMatchObject({ blockedWork: '릴리스', reversible: true });
    expect(pq.questions[0].stakes).toBeUndefined();
    expect(pq.questions[1]).toMatchObject({ stakes: '변경 기록' });
  });

  it('D2 only the four known fields, only their own types', async () => {
    const pq = await board({
      type: 'user_choice',
      question: 'Q?',
      choices: CHOICES,
      blockedWork: 7,
      stakes: '돈',
      reversible: 'maybe',
      reversibleWhy: '이유',
      secret: 'do not project',
    });
    expect(pq.stakes).toBe('돈');
    expect('blockedWork' in pq).toBe(false);
    expect('reversible' in pq).toBe(false);
    expect('reversibleWhy' in pq).toBe(false);
    expect('secret' in pq).toBe(false);
  });

  it('D6 no fields: the single projection is as before, plus its context', async () => {
    const pq = await board({
      type: 'user_choice',
      question: 'Q?',
      context: 'c',
      recommendedChoiceId: '1',
      choices: CHOICES,
    });
    expect(Object.keys(pq).sort()).toEqual(['choices', 'context', 'question', 'recommendedChoiceId', 'type']);
    const bare = await board({ type: 'user_choice', question: 'Q?', choices: CHOICES });
    expect(Object.keys(bare).sort()).toEqual(['choices', 'question', 'type']);
  });
});

// ── Client — the shipped functions, cut out of renderDashboardPage()'s template ──

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));

function cook(fragment: string): string {
  if (fragment.includes('`') || fragment.includes('${')) throw new Error('fragment is not a plain template slice');
  return new Function(`return \`${fragment}\`;`)() as string;
}
function clientFn(name: string): string {
  const start = TEMPLATE.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  return cook(TEMPLATE.slice(start + 1, TEMPLATE.indexOf('\n}\n', start) + 2));
}
function clientVar(name: string): string {
  const m = TEMPLATE.match(new RegExp(`^(var ${name} = .*?;)(?:\\s*//.*)?$`, 'm'));
  if (!m) throw new Error(`client var ${name} not found`);
  return cook(m[1]);
}
function load<T>(fns: string[], vars: string[], inject: Record<string, unknown> = {}): T {
  ({ fns, inject } = viewerScope(fns, inject));
  const names = Object.keys(inject);
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}

const INJECT = {
  currentUserId: 'U1',
  READ_ONLY_MSG: '읽기 전용 — 내 세션이 아닙니다',
  isSiblingSession: () => false,
  _acState: {},
  STRINGS: { mcCustomPlaceholder: '직접 입력' },
};
const BASE_FNS = [
  'esc',
  'escAttr',
  'acQuestionLock',
  'acQuestionId',
  'decisionLines',
  'stripRecommendedMarker',
  'resolveRecommendedId',
];
const SESSION = (q: unknown) => ({ key: 'inst::C1:t1', ownerId: 'U1', activityState: 'waiting', pendingQuestion: q });

type Client = {
  decisionLines(q: unknown, md?: boolean): string[];
  acQuestionData(s: unknown, q: unknown): Record<string, any>;
  mcFormData(s: unknown, q: unknown): Record<string, any>;
  quickChoicesOf(q: unknown): unknown;
};
const client = () =>
  load<Client>(
    [...BASE_FNS, 'acQuestionData', 'mcFormId', 'mcStateOf', 'mcFormData', 'openMdFence', 'quickChoicesOf'],
    ['AC_SIBLING', 'MC_CUSTOM_ID', '_mcState'],
    INJECT,
  );

describe('D3 — decisionLines(q, md)', () => {
  it('the lines in order: blocked work, stakes, reversibility', () => {
    expect(client().decisionLines(LINES)).toEqual([
      '🚧 막힌 작업 — PR #42 배포',
      '⚖️ 걸린 것 — 사용자 테이블 2만 행',
      '⚠️ 되돌릴 수 없음 — 컬럼을 지우면 백업에서만 되살릴 수 있다',
    ]);
  });

  it('md: the irreversible label is bold; the rest are the same words', () => {
    expect(client().decisionLines(LINES, true)).toEqual([
      '🚧 막힌 작업 — PR #42 배포',
      '⚖️ 걸린 것 — 사용자 테이블 2만 행',
      '⚠️ **되돌릴 수 없음** — 컬럼을 지우면 백업에서만 되살릴 수 있다',
    ]);
  });

  it('only what is given; a reversible choice is a quiet line; junk renders nothing', () => {
    const c = client();
    expect(c.decisionLines({ reversible: true })).toEqual(['↩️ 되돌릴 수 있음']);
    expect(c.decisionLines({ reversible: true, reversibleWhy: 'git revert' })).toEqual([
      '↩️ 되돌릴 수 있음 — git revert',
    ]);
    expect(c.decisionLines({ reversible: false }, true)).toEqual(['⚠️ **되돌릴 수 없음**']);
    expect(c.decisionLines({ blockedWork: '  ', stakes: 3, reversible: 'no' })).toEqual([]);
    expect(c.decisionLines(undefined)).toEqual([]);
  });
});

describe('D4/D6 — the single question card', () => {
  const Q = { type: 'user_choice', question: '[small] 돌릴까요?', recommendedChoiceId: '1', choices: CHOICES };

  it('D4 description: the context, then the lines', () => {
    const d = client().acQuestionData(SESSION(Q), { ...Q, context: '스키마가 바뀌었습니다.', ...LINES });
    expect(d.description).toBe(
      [
        '스키마가 바뀌었습니다.',
        '🚧 막힌 작업 — PR #42 배포',
        '⚖️ 걸린 것 — 사용자 테이블 2만 행',
        '⚠️ 되돌릴 수 없음 — 컬럼을 지우면 백업에서만 되살릴 수 있다',
      ].join('\n'),
    );
  });

  it('D4 no context: the lines alone', () => {
    expect(client().acQuestionData(SESSION(Q), { ...Q, stakes: '돈' }).description).toBe('⚖️ 걸린 것 — 돈');
  });

  it('D6 the context alone (the bug: it was dropped); none at all → no description', () => {
    const c = client();
    expect(c.acQuestionData(SESSION(Q), { ...Q, context: 'c' }).description).toBe('c');
    expect('description' in c.acQuestionData(SESSION(Q), Q)).toBe(false);
  });

  // Review R1 P1 (astra): the lines are part of the question's meaning — a question rewritten in place with other
  // stakes or another verdict is another card, never the old one's answer state.
  it('identity: other decision lines → another card; the same lines → the same card; none → the key as before', () => {
    const c = client();
    const lined = c.acQuestionData(SESSION(Q), { ...Q, ...LINES }).id;
    expect(lined).not.toBe(c.acQuestionData(SESSION(Q), Q).id);
    expect(c.acQuestionData(SESSION(Q), { ...Q, ...LINES, reversible: true }).id).not.toBe(lined);
    expect(c.acQuestionData(SESSION(Q), { ...Q, ...LINES }).id).toBe(lined);
    expect(c.acQuestionData(SESSION(Q), Q).id).toBe(
      `q|${JSON.stringify([Q.question, Q.choices.map((x) => [x.id, x.label, ''])])}`,
    );
    // Review R2 P3 (fable): keyed on the raw fields, not the rendered labels (which the display language rewrites).
    expect(lined).toContain('PR #42 배포');
    expect(lined).not.toContain('막힌 작업');
  });
});

describe('D5/D6 — the multi-question form', () => {
  const G = {
    type: 'user_choices',
    title: '[medium] 두 가지',
    questions: [
      {
        id: 'q1',
        question: 'A?',
        context: '맥락',
        choices: CHOICES,
        blockedWork: '릴리스',
        reversible: false,
        reversibleWhy: '태그 공개',
      },
      { id: 'q2', question: 'B?', choices: CHOICES, stakes: '변경 기록' },
      { id: 'q3', question: 'C?', context: '그대로', choices: CHOICES },
    ],
  };

  it('D5 context (markdown): the context, a blank line, then the lines; lines alone without one', () => {
    const d = client().mcFormData(SESSION(G), G);
    expect(d.questions[0].context).toBe('맥락\n\n🚧 막힌 작업 — 릴리스\n⚠️ **되돌릴 수 없음** — 태그 공개');
    expect(d.questions[1].context).toBe('⚖️ 걸린 것 — 변경 기록');
  });

  // Review R1 P1 (astra): an unclosed code fence in the model's context must not swallow the lines (and the warning).
  it('D5 an unclosed code fence in the context is closed before the lines', () => {
    const fence = '\u0060\u0060\u0060';
    const q = { ...G, questions: [{ ...G.questions[0], context: `맥락\n${fence}\ncode never closed` }] };
    expect(client().mcFormData(SESSION(q), q).questions[0].context).toBe(
      `맥락\n${fence}\ncode never closed\n${fence}\n\n🚧 막힌 작업 — 릴리스\n⚠️ **되돌릴 수 없음** — 태그 공개`,
    );
    const closed = { ...G, questions: [{ ...G.questions[0], context: `a\n${fence}\nx\n${fence}` }] };
    expect(client().mcFormData(SESSION(closed), closed).questions[0].context).toBe(
      `a\n${fence}\nx\n${fence}\n\n🚧 막힌 작업 — 릴리스\n⚠️ **되돌릴 수 없음** — 태그 공개`,
    );
    // Without lines the context is left exactly as the model wrote it.
    const plain = { ...G, questions: [{ id: 'q1', question: 'A?', choices: CHOICES, context: `x\n${fence}` }] };
    expect(client().mcFormData(SESSION(plain), plain).questions[0].context).toBe(`x\n${fence}`);
  });

  it('form identity: a question whose lines change starts the form clean; none → the id as before', () => {
    const c = load<{ mcFormId(s: unknown, q: unknown): string }>([...BASE_FNS, 'mcFormId'], [], INJECT);
    const changed = { ...G, questions: [{ ...G.questions[0], reversible: true }, G.questions[1], G.questions[2]] };
    expect(c.mcFormId(SESSION(G), changed)).not.toBe(c.mcFormId(SESSION(G), G));
    const bare = { ...G, questions: G.questions.map((x) => ({ id: x.id, question: x.question, choices: x.choices })) };
    expect(c.mcFormId(SESSION(bare), bare)).toBe(
      `mc|inst::C1:t1|${JSON.stringify([G.title, G.questions.map((x) => [x.id, x.question])])}`,
    );
  });

  // Review (bot, tests P2): what the form shows, not only the string it is handed — the element renders `context`
  // with @2lab.ai/ui answerMarkdown.
  it('D5 rendered: separate lines, the irreversible label bold, an HTML-like value shown as text', async () => {
    const g = globalThis as Record<string, unknown>;
    if (!g.HTMLElement) g.HTMLElement = class {};
    if (!g.customElements) g.customElements = { define() {}, get() {} };
    // @ts-expect-error — the package maps only `server` in typesVersions; this repo's moduleResolution is `node`.
    const { answerMarkdown } = (await import('@2lab.ai/ui/ai-answer')) as unknown as {
      answerMarkdown(md: string): string;
    };
    const q = {
      ...G,
      questions: [{ ...G.questions[0], blockedWork: '<em>production</em>', stakes: '돈', reversibleWhy: '태그 공개' }],
    };
    const html = answerMarkdown(client().mcFormData(SESSION(q), q).questions[0].context);
    expect(html).toContain('🚧 막힌 작업 — &lt;em&gt;production&lt;/em&gt;<br>⚖️ 걸린 것 — 돈<br>');
    expect(html).toContain('⚠️ <strong>되돌릴 수 없음</strong> — 태그 공개');
    expect(html).not.toContain('<em>production</em>');
  });

  // Review R2 P1 (astra) / P3 (fable): every fence the renderer opens — ~~~, a longer run of backticks, an info
  // string — is closed with its own run; a fence the renderer already closed (it closes on any line that starts with
  // the run) gets nothing appended.
  it.each([
    ['~~~ left open', 'ctx\n~~~\ncode', 'ctx\n~~~\ncode\n~~~'],
    ['four backticks, a three-backtick line inside', 'ctx\n````\n```\ncode', 'ctx\n````\n```\ncode\n````'],
    ['an info string', 'ctx\n```js\nconst a = 1;', 'ctx\n```js\nconst a = 1;\n```'],
    ['closed by a line that starts with the run', 'ctx\n```\ncode\n``` done', 'ctx\n```\ncode\n``` done'],
    ['indented four spaces is not a fence', 'ctx\n    ```\ncode', 'ctx\n    ```\ncode'],
    ['~~~ inside ``` is code', 'ctx\n```\n~~~\ncode', 'ctx\n```\n~~~\ncode\n```'],
  ])('D5 rendered fence: %s', async (_name, context, expected) => {
    const g = globalThis as Record<string, unknown>;
    if (!g.HTMLElement) g.HTMLElement = class {};
    if (!g.customElements) g.customElements = { define() {}, get() {} };
    // @ts-expect-error — the package maps only `server` in typesVersions; this repo's moduleResolution is `node`.
    const { answerMarkdown } = (await import('@2lab.ai/ui/ai-answer')) as unknown as {
      answerMarkdown(md: string): string;
    };
    const tick = (x: string) => x.replace(/```/g, '\u0060\u0060\u0060');
    const q = { ...G, questions: [{ ...G.questions[0], context: tick(context) }] };
    const out = client().mcFormData(SESSION(q), q).questions[0].context as string;
    expect(out).toBe(`${tick(expected)}\n\n🚧 막힌 작업 — 릴리스\n⚠️ **되돌릴 수 없음** — 태그 공개`);
    expect(answerMarkdown(out)).toContain('⚠️ <strong>되돌릴 수 없음</strong> — 태그 공개');
  });

  it('D6 a question without fields keeps its context as is, or none', () => {
    const d = client().mcFormData(SESSION(G), G);
    expect(d.questions[2].context).toBe('그대로');
    const bare = { ...G, questions: [{ id: 'q1', question: 'A?', choices: CHOICES }] };
    expect('context' in client().mcFormData(SESSION(bare), bare).questions[0]).toBe(false);
  });
});

describe('D7 — a question with decision lines is not answered by one press on the card face', () => {
  const SHORT = {
    type: 'user_choice',
    question: 'Q?',
    choices: [
      { id: '1', label: '예' },
      { id: '2', label: '아니오' },
      { id: '3', label: '보류' },
    ],
  };

  it('quick choices are off when any line shows, on otherwise', () => {
    const c = client();
    expect(c.quickChoicesOf({ ...SHORT, reversible: false })).toBeNull();
    expect(c.quickChoicesOf({ ...SHORT, reversible: true })).toBeNull();
    expect(c.quickChoicesOf({ ...SHORT, blockedWork: '배포' })).toBeNull();
    expect(c.quickChoicesOf({ ...SHORT, stakes: '돈' })).toBeNull();
    expect(c.quickChoicesOf({ ...SHORT, stakes: '   ' })).not.toBeNull();
    expect(c.quickChoicesOf(SHORT)).not.toBeNull();
  });
});

describe('D8 — Slack and the dashboard: same lines, same order', () => {
  const slackLines = (q: Record<string, unknown>): string[] => {
    const blocks = ChoiceMessageBuilder.buildUserChoiceBlocks(
      { type: 'user_choice', question: 'Q?', choices: CHOICES, ...q } as UserChoice,
      'k',
    ).attachments![0].blocks as any[];
    const b = blocks.find((x) => x.type === 'context' && /^(🚧|⚖️|⚠️|↩️) /.test(x.elements?.[0]?.text ?? ''));
    return b ? String(b.elements[0].text).split('\n') : [];
  };

  it.each([
    ['all four', LINES],
    ['stakes + reversible', { stakes: '돈', reversible: true, reversibleWhy: 'revert' }],
    ['irreversible, no why', { blockedWork: '배포', reversible: false }],
    ['none', {}],
  ])('%s', (_name, fields) => {
    const c = client();
    const slack = slackLines(fields);
    expect(slack.map((l) => l.replace(/\*(되돌릴 수 없음)\*/, '$1'))).toEqual(c.decisionLines(fields));
    expect(slack.map((l) => l.replace(/\*(되돌릴 수 없음)\*/, '**$1**'))).toEqual(c.decisionLines(fields, true));
  });
});
