/**
 * Dashboard view plans (SSOT 2026-11-01 ④, .prd/20): 1안 · 2안 · 3안 for each of the six surfaces —
 * minimal and advanced × the card face, the open card, the detail card. 1안 is the default; the user's
 * dashboardPlan setting (설정 › 대시보드 › 화면 구성안) picks another. Executes the shipped client code cut
 * out of renderDashboardPage()'s template literal (the harness of dashboard-view-mode-client.test.ts).
 *
 *   P1  the plan table: two modes × three plans, one spec per surface; the setting picks it
 *   P2  the card face follows the plan (faceOf)
 *   P3  the open card follows the plan (renderCardBody's parts)
 *   P4  the detail card follows the plan (data-detail · data-tasks · the task line)
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { viewerScope } from '../__fixtures__/viewer-scope';

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));
const PRD = readFileSync(join(__dirname, '..', '..', '..', '.prd', '20-dashboard-view-plans-spec.md'), 'utf-8');

function cook(fragment: string): string {
  if (fragment.includes('`') || fragment.includes('${')) throw new Error('fragment is not a plain template slice');
  return new Function(`return \`${fragment}\`;`)() as string;
}
function declarationCount(name: string): number {
  const re = new RegExp(`^(?:async function|function|var|let|const) ${name.replace(/[$]/g, '\\$')}\\b`, 'gm');
  return (TEMPLATE.match(re) ?? []).length;
}
function clientFn(name: string): string {
  const n = declarationCount(name);
  if (n > 1) throw new Error(`client ${name} is declared ${n} times`);
  let start = TEMPLATE.indexOf(`\nfunction ${name}(`);
  if (start < 0) start = TEMPLATE.indexOf(`\nasync function ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = TEMPLATE.indexOf('\n}\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 2));
}
/** A one-line `var X = …;`, or a block `var X = {` … `\n};`. */
function clientVar(name: string): string {
  const one = TEMPLATE.match(new RegExp(`^(var ${name} = .*?;)(?:\\s*//.*)?$`, 'm'));
  if (one) return cook(one[1]);
  const start = TEMPLATE.indexOf(`\nvar ${name} = {\n`);
  if (start < 0) throw new Error(`client var ${name} not found`);
  const end = TEMPLATE.indexOf('\n};\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 3));
}
function load<T>(fns: string[], vars: string[], inject: Record<string, unknown> = {}): T {
  ({ fns, inject } = viewerScope(fns, inject));
  const names = Object.keys(inject);
  const setter = '__set: function(n, v) { eval(n + " = v"); }';
  const getter = '__get: function(n) { return eval(n); }';
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\nreturn { ${[...fns, setter, getter].join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}
const PAGE = cook(TEMPLATE.slice(TEMPLATE.indexOf('<body'), TEMPLATE.indexOf('<script>', TEMPLATE.indexOf('<body'))));
const CSS = cook(
  TEMPLATE.slice(TEMPLATE.indexOf('<style>'), TEMPLATE.indexOf('</style>', TEMPLATE.indexOf('<style>'))),
);
const T0 = 1_700_000_000_000;

type Spec = {
  name: string;
  face: { show: string[]; summary: string; arts?: number; kind: boolean; foot: string[] };
  body: { star: boolean; work: string[]; wait: string[]; done: string[] };
  detail: { show: string[]; tasks: string; tasksMax?: number; open: boolean };
};
const plansEnv = () =>
  load<{
    viewPlanFrom(v: unknown): string;
    viewPlanOfSettings(snap: unknown): string | null;
    viewSpec(): Spec;
    detailShows(tok: string): boolean;
    __set(n: string, v: unknown): void;
    __get(n: string): any;
  }>(
    ['viewModeFrom', 'viewPlanFrom', 'viewPlanOfSettings', 'viewSpec', 'detailShows'],
    ['VIEW_PLANS', '_viewMode', '_viewPlan'],
  );

describe('P1 — the plan table: two modes × three plans; the user’s dashboardPlan picks one', () => {
  it('every mode has 1안 · 2안 · 3안, each with a face, an open card and a detail card', () => {
    const env = plansEnv();
    const plans = env.__get('VIEW_PLANS') as Record<string, Record<string, Spec>>;
    expect(Object.keys(plans).sort()).toEqual(['advanced', 'minimal']);
    for (const mode of ['minimal', 'advanced']) {
      expect(Object.keys(plans[mode]).sort()).toEqual(['1', '2', '3']);
      for (const p of ['1', '2', '3']) {
        const s = plans[mode][p];
        expect(s.name, `${mode} ${p}`).toBeTruthy();
        expect(Array.isArray(s.face.show) && Array.isArray(s.face.foot)).toBe(true);
        for (const lane of ['work', 'wait', 'done'] as const) expect(Array.isArray(s.body[lane])).toBe(true);
        expect(['runs', 'list', 'line']).toContain(s.detail.tasks);
        // The .prd names each plan as the table does.
        expect(PRD).toContain(s.name);
      }
    }
  });

  it('1안 unless the value says 2 or 3; the settings snapshot’s dashboardPlan row, or null without one', () => {
    const env = plansEnv();
    expect(env.viewPlanFrom('2')).toBe('2');
    expect(env.viewPlanFrom('3')).toBe('3');
    for (const v of ['1', '', null, undefined, '4', 'advanced', 2])
      expect(env.viewPlanFrom(v)).toBe(v === 2 ? '2' : '1');
    expect(env.viewPlanOfSettings({ settings: [{ key: 'dashboardPlan', value: '3' }] })).toBe('3');
    expect(env.viewPlanOfSettings({ settings: [{ key: 'dashboardMode', value: 'advanced' }] })).toBeNull();
    expect(env.viewPlanOfSettings(null)).toBeNull();
  });

  it('the spec is the mode’s plan; the page starts on 1안 (the default)', () => {
    const env = plansEnv();
    expect(env.__get('_viewPlan')).toBe('1');
    expect(env.viewSpec().name).toBe('결과 우선');
    env.__set('_viewPlan', '3');
    expect(env.viewSpec().name).toBe('한눈에');
    env.__set('_viewMode', 'advanced');
    expect(env.viewSpec().name).toBe('압축');
    env.__set('_viewPlan', '2');
    expect(env.viewSpec().name).toBe('원본');
    env.__set('_viewPlan', '1');
    expect(env.viewSpec().name).toBe('정리');
    expect(env.detailShows('info')).toBe(true);
    env.__set('_viewMode', 'minimal');
    expect(env.detailShows('info')).toBe(false);
    expect(PAGE).toMatch(/<body[^>]*data-view-plan="1"/);
  });

  it('the settings page keeps the dashboard’s device copy of its mode and plan (its first paint after a full reload)', () => {
    const page = readFileSync(join(__dirname, '..', 'settings-page.ts'), 'utf-8');
    expect(page).toContain("var copy = { dashboardMode: 'soma-view-mode', dashboardPlan: 'soma-view-plan' }[key];");
    expect(page).toContain(
      'if (copy) { try { localStorage.setItem(copy, String(r.data.setting.value)); } catch (_e) {} }',
    );
    expect(TEMPLATE).toContain("var VIEW_PLAN_KEY = 'soma-view-plan';");
    expect(TEMPLATE).toContain("var VIEW_MODE_KEY = 'soma-view-mode';");
  });

  it('the first settings load starts after the view mode and plan are set up — the server’s mode applies on a fresh device', () => {
    // A call at script load ran before `var _viewModeSeq = 0;`: it captured undefined, so the answer's mode
    // (undefined !== 0) was never applied — a user who chose 어드밴스드 elsewhere opened in 미니멀.
    expect(TEMPLATE).not.toMatch(/\}\nloadMyDefaults\(\);\n/);
    const call = TEMPLATE.indexOf('\nloadMyDefaults();\n');
    expect(TEMPLATE.indexOf('\nloadMyDefaults();\n', call + 1)).toBe(-1);
    expect(call).toBeGreaterThan(TEMPLATE.indexOf('_viewPlan = readViewPlan();\napplyViewMode();\nsyncBoardScope();'));
    expect(call).toBeGreaterThan(TEMPLATE.indexOf('var _viewModeSeq = 0;'));
    expect(call).toBeGreaterThan(TEMPLATE.indexOf("var _viewPlan = '1';"));
  });

  it('the settings load applies the user’s plan; a return to the tab reads it again', () => {
    const load = clientFn('loadMyDefaults');
    expect(load).toContain('var vp = viewPlanOfSettings(data);');
    expect(load).toContain('if (vp !== null && load === _settingsLoads && vp !== _viewPlan) setViewPlan(vp);');
    // The answer is matched to its load: a later load's answer wins even when an earlier one lands last.
    expect(load.indexOf('var load = ++_settingsLoads;')).toBeLessThan(load.indexOf("await fetch('/api/settings')"));
    // The plan is read before the defaults' acceptance gate (a viewer refused writes still has a plan).
    expect(load.indexOf('viewPlanOfSettings(data)')).toBeLessThan(
      load.indexOf('data.accepted === false) { box.hidden'),
    );
    expect(TEMPLATE).toContain(
      "document.addEventListener('visibilitychange', function() { if (!document.hidden) loadMyDefaults(); });",
    );
    expect(TEMPLATE).toContain(
      "window.addEventListener('pageshow', function(e) { if (e.persisted) loadMyDefaults(); });",
    );
    const set = clientFn('setViewPlan');
    expect(set).toContain('localStorage.setItem(VIEW_PLAN_KEY, next);');
    expect(set).toContain('applyViewMode();');
    expect(set).toContain('if (changed) rerenderForViewMode();');
  });
});

describe('P2 — the card face follows the plan', () => {
  const full = {
    id: 'k',
    title: '대시보드 화면 구성안',
    status: 'running',
    statusText: '실행 중',
    bodyMode: 'slot',
    summary: '원래 제목',
    since: T0,
    elapsedMs: 1000,
    task: { label: '구현', startedAt: T0 },
    badge: { text: 'Zhuge', hue: 1, title: 'Zhuge' },
    star: { on: true, title: '즐겨찾기 해제' },
    agents: { total: 2, running: 1, done: 1, failed: 0, dots: ['done', 'running'] },
    tokens: 6_440_000,
    costUsd: 6.2,
    artifactsCount: 5,
    artifacts: [
      { id: 'a', name: 'a.html', kind: 'html' },
      { id: 'b', name: 'b.png', kind: 'image' },
      { id: 'c', name: 'c.md', kind: 'file' },
      { id: 'd', name: 'd.md', kind: 'file' },
    ],
    steps: { done: 2, total: 4 },
    contextPct: 64,
    contextLevel: 'warn',
    titles: { tokens: '총 토큰 6.4M', cost: 'API 환산 비용', context: 'x' },
    metrics: [
      { text: '2', glyph: 'attach', title: '지시 첨부 2개', label: '지시 첨부 2개' },
      { text: '#700 열림', glyph: 'pr', title: 'PR #700 열림' },
    ],
  };
  const s = { model: 'claude-opus-5-5[1m]' };
  const asking = { ...s, pendingQuestion: { question: '배포할까요?' } };
  const COST = { text: '$6.20', title: 'API 환산 비용\n총 토큰 6.4M' };
  const MODEL = { text: 'Opus 5.5', glyph: 'claude', title: 'claude-opus-5-5[1m]' };
  const PR = full.metrics[1];
  const MEDIA = full.metrics[0];
  const ARTS = { text: '5', glyph: 'file', title: '산출물 5개', label: '산출물 5개' };
  const env = load<{
    faceOf(c: unknown, s: unknown, col: string, f: unknown): Record<string, any>;
    __get(n: string): any;
  }>(
    ['toNum', 'pendingAutoResume', 'cardAsks', 'modelVendorOf', 'modelLabelOf', 'faceFootMetrics', 'faceOf'],
    ['VIEW_PLANS', 'FACE_KEEP', 'FACE_PARTS'],
    { REPRESENTATIVE_MODELS: [{ nickname: 'opus[1m]', model: 'claude-opus-5-5[1m]', label: 'Opus 5.5' }] },
  );
  const plans = env.__get('VIEW_PLANS') as Record<string, Record<string, Spec>>;
  const face = (mode: string, p: string, sess = s, col = 'working') =>
    env.faceOf({ ...full }, sess, col, plans[mode][p].face);

  it('minimal 1안 결과 우선: the task row, three artifacts, the summary only when it asks; PR · cost · model', () => {
    const m = face('minimal', '1');
    expect(m.task).toEqual(full.task);
    expect(m.artifacts.map((a: { id: string }) => a.id)).toEqual(['a', 'b', 'c']);
    expect(m.artifactsCount).toBe(5);
    expect(m.summary).toBeUndefined();
    expect(face('minimal', '1', asking, 'waiting').summary).toBe('원래 제목');
    expect(m.metrics).toEqual([PR, COST, MODEL]);
    for (const gone of ['agents', 'tokens', 'costUsd', 'steps', 'contextPct']) expect(m[gone], gone).toBeUndefined();
    expect(m.lead).toEqual({ glyph: 'task', title: '일반 작업' });
    expect(m.star).toEqual(full.star);
    expect(m.badge).toEqual(full.badge);
  });

  it('minimal 2안 진행 우선: the summary always, the task row and its steps; artifacts as a count, cost · model', () => {
    const m = face('minimal', '2');
    expect(m.summary).toBe('원래 제목');
    expect(m.task).toEqual(full.task);
    expect(m.steps).toEqual(full.steps);
    expect(m.artifacts).toBeUndefined();
    expect(m.metrics).toEqual([ARTS, COST, MODEL]);
  });

  it('minimal 3안 한눈에: title · status · time; the summary only when it asks; cost · model', () => {
    const m = face('minimal', '3');
    for (const gone of ['task', 'artifacts', 'steps', 'summary', 'agents']) expect(m[gone], gone).toBeUndefined();
    expect(m.metrics).toEqual([COST, MODEL]);
    expect(face('minimal', '3', asking, 'waiting').summary).toBe('원래 제목');
  });

  it('advanced 1안 정리: everything, the kind mark instead of ✦, the model at the foot’s end', () => {
    const m = face('advanced', '1');
    for (const kept of ['summary', 'task', 'agents', 'tokens', 'costUsd', 'steps', 'contextPct', 'artifacts'])
      expect(m[kept], kept).toBeDefined();
    expect(m.artifacts).toHaveLength(4);
    expect(m.lead).toEqual({ glyph: 'task', title: '일반 작업' });
    expect(m.metrics).toEqual([MEDIA, PR, MODEL]);
  });

  it('advanced 2안 원본: the face as it was — the full card, ✦ (no lead), attachments · PR', () => {
    expect(face('advanced', '2')).toEqual(full);
  });

  it('advanced 3안 압축: no sub-agent or token rows; the numbers at the foot — artifacts · PR · cost · model', () => {
    const m = face('advanced', '3');
    for (const gone of ['agents', 'tokens', 'costUsd', 'artifacts', 'summary']) expect(m[gone], gone).toBeUndefined();
    for (const kept of ['task', 'steps', 'contextPct']) expect(m[kept], kept).toBeDefined();
    expect(m.metrics).toEqual([ARTS, PR, COST, MODEL]);
  });

  it('what asks: a permission, a goal decision, a waiting question, a retry’s error — never on a closed card', () => {
    const asks = load<{ cardAsks(s: unknown, col: string): boolean }>(['pendingAutoResume', 'cardAsks'], []).cardAsks;
    expect(asks({ pendingPermissions: [{}] }, 'working')).toBe(true);
    expect(asks({ pendingPermissions: [{}] }, 'closed')).toBe(false);
    expect(asks({ pendingGoalDecision: {} }, 'idle')).toBe(true);
    expect(asks({ pendingQuestion: { question: 'q' } }, 'waiting')).toBe(true);
    expect(asks({ pendingQuestion: { question: 'q' } }, 'idle')).toBe(false);
    expect(asks({ autoResume: { reason: '429' }, activityState: 'idle' }, 'working')).toBe(true);
    expect(asks({}, 'working')).toBe(false);
  });

  it('the board draws every face through the plan', () => {
    const fn = clientFn('viewCardOf');
    expect(fn).toContain('c.star = cardStarOf(s, col);');
    expect(fn).toContain('return faceOf(c, s, col, viewSpec().face);');
    expect(declarationCount('minimalCard')).toBe(0);
    expect(declarationCount('MINIMAL_CARD_KEYS')).toBe(0);
  });
});

describe('P3 — the open card follows the plan', () => {
  const STUBS: Record<string, unknown> = {
    dhShow: () => true,
    formatTokens: (n: number) => `${n}`,
    _goalErrors: {},
    safeHref: (u: string) => u,
    getEnvBadgeColor: () => '#000',
    _envCount: () => 1,
    isSiblingSession: () => false,
    renderCardIo: () => '[IO]',
    renderCardArtifacts: () => '[ARTS]',
    renderAgentTree: () => '[AGENTS]',
    renderCardTasks: () => '[TASKS]',
    renderMultiChoiceCard: () => '[MC]',
    renderModelNote: () => '',
    renderModelPicker: () => '[MODEL]',
    renderEffortPicker: () => '[EFFORT]',
    currentUserId: 'U1',
    SELF_INSTANCE_NAME: '',
    READ_ONLY_MSG: 'read only',
  };
  const env = load<{ renderCardBody(s: unknown, col: string, spec?: unknown): string; __get(n: string): any }>(
    [
      'esc',
      'escAttr',
      'escJs',
      'toNum',
      'formatTaskTime',
      'pendingAutoResume',
      'autoResumeLabel',
      'permissionSummary',
      'cardSummary',
      'cardCurrentTask',
      'renderCardResume',
      'taskOutcomeHtml',
      'taskNoticeFailHtml',
      'isBusy',
      'sessionActionsOf',
      'sessionActionHtml',
      'cardGoalLine',
      'acSlotHtml',
      'acQuestionId',
      'acPermissionsHtml',
      'acGoalDecisionHtml',
      'acQuestionHtml',
      'renderCardBody',
    ],
    ['RESUME_SVG', 'GOAL_STATUS_LABELS', 'GOAL_STATUS_TONE', 'GOAL_SVG', 'SESSION_ACTION_TONE', '_busy', 'VIEW_PLANS'],
    STUBS,
  );
  const plans = env.__get('VIEW_PLANS') as Record<string, Record<string, Spec>>;
  const card = (over: Record<string, unknown> = {}) => ({
    key: 'inst::C1:t1',
    conversationId: 'conv-1',
    ownerId: 'U1',
    model: 'claude-opus-5-5[1m]',
    effort: 'high',
    slackThreadUrl: 'https://slack.example/t',
    prShortRef: 'PR-700',
    prUrl: 'https://github.example/pr/700',
    activityState: 'working',
    goal: { current: { objective: '배포', status: 'active' }, queue: [] },
    ...over,
  });
  const body = (mode: string, p: string, col = 'working', over: Record<string, unknown> = {}) =>
    env.renderCardBody(card(over), col, plans[mode][p].body);
  const PARTS = ['[TASKS]', '[AGENTS]', '[IO]', '[ARTS]', 'card-goal-line', 'card-refs', '[MODEL]'];
  const present = (html: string) => PARTS.filter((p) => html.includes(p));

  it('every plan keeps the actions (Stop · Slack) and what asks, first', () => {
    const q = { pendingQuestion: { type: 'user_choice', question: 'Ship it?', choices: [{ id: '1', label: 'Yes' }] } };
    for (const mode of ['minimal', 'advanced'])
      for (const p of ['1', '2', '3']) {
        const html = body(mode, p);
        expect(html, `${mode} ${p}`).toContain('data-action="stop"');
        expect(html, `${mode} ${p}`).toContain('>Slack</a>');
        expect(body(mode, p, 'waiting', q), `${mode} ${p}`).toContain('data-ac-kind="question"');
      }
  });

  it('the face’s star is the one star: no ☆ button in the open card — but in advanced 2안 원본', () => {
    for (const [mode, p] of [
      ['minimal', '1'],
      ['minimal', '2'],
      ['minimal', '3'],
      ['advanced', '1'],
      ['advanced', '3'],
    ])
      expect(body(mode, p), `${mode} ${p}`).not.toContain('data-action="star"');
    expect(body('advanced', '2')).toContain('data-action="star"');
  });

  it('minimal: 1안 the PR/issue links and the model switch; 2안 the task window while it runs; 3안 nothing more', () => {
    expect(present(body('minimal', '1'))).toEqual(['card-refs', '[MODEL]']);
    expect(body('minimal', '1')).toContain('href="https://github.example/pr/700"');
    expect(present(body('minimal', '2'))).toEqual(['[TASKS]']);
    expect(present(body('minimal', '2', 'waiting'))).toEqual(['[TASKS]']);
    expect(present(body('minimal', '2', 'idle'))).toEqual([]);
    expect(present(body('minimal', '3'))).toEqual([]);
  });

  it('advanced: 1안 · 2안 the column’s body as it was; 3안 the controls only (the detail card beside it has the rest)', () => {
    for (const p of ['1', '2']) {
      expect(present(body('advanced', p))).toEqual([
        '[TASKS]',
        '[AGENTS]',
        '[IO]',
        'card-goal-line',
        'card-refs',
        '[MODEL]',
      ]);
      expect(present(body('advanced', p, 'waiting'))).toEqual([
        '[TASKS]',
        '[AGENTS]',
        '[IO]',
        '[ARTS]',
        'card-goal-line',
        'card-refs',
        '[MODEL]',
      ]);
    }
    expect(present(body('advanced', '3'))).toEqual(['card-goal-line', 'card-refs', '[MODEL]']);
    // The order is the plan's: waiting reads the latest exchange first.
    const w = body('advanced', '1', 'waiting');
    expect(w.indexOf('[IO]')).toBeLessThan(w.indexOf('[TASKS]'));
  });

  it('advanced 2안 원본 is the open card as it was, byte for byte, in every column (review, grok P1)', () => {
    const q = { pendingQuestion: { type: 'user_choice', question: 'Ship it?', choices: [{ id: '1', label: 'Yes' }] } };
    for (const [col, over] of [
      ['working', {}],
      ['waiting', q],
      ['idle', { activityState: 'idle' }],
      ['closed', { activityState: 'idle', terminated: true }],
    ] as Array<[string, Record<string, unknown>]>)
      expect(body('advanced', '2', col, over), col).toBe(env.renderCardBody(card(over), col));
  });

  it('no spec (any other caller) is the open card as it was', () => {
    const html = env.renderCardBody(card(), 'working');
    expect(html).toContain('data-action="star"');
    expect(present(html)).toEqual(['[TASKS]', '[AGENTS]', '[IO]', 'card-goal-line', 'card-refs', '[MODEL]']);
    expect(clientFn('paintCardBody')).toContain('var html = renderCardBody(s, col, viewSpec().body);');
  });
});

describe('P4 — the detail card follows the plan', () => {
  const fakeBody = () => {
    const attrs: Record<string, string> = {};
    const props: Record<string, string> = {};
    return {
      attrs,
      props,
      setAttribute: (k: string, v: string) => {
        attrs[k] = v;
      },
      style: {
        setProperty: (k: string, v: string) => {
          props[k] = v;
        },
        removeProperty: (k: string) => {
          delete props[k];
        },
      },
    };
  };

  it('the body says which sections the plan shows and how the tasks read; 자세히 opens with the plan', () => {
    const b = fakeBody();
    const env = load<{ applyViewMode(): void; __set(n: string, v: unknown): void; __get(n: string): any }>(
      ['viewModeFrom', 'viewPlanFrom', 'viewSpec', 'applyViewMode'],
      ['VIEW_PLANS', '_viewMode', '_viewPlan', '_panelDetail'],
      { document: { body: b, getElementById: () => null }, applyPanelDetail: () => {} },
    );
    env.applyViewMode();
    expect(b.attrs['data-view-mode']).toBe('minimal');
    expect(b.attrs['data-view-plan']).toBe('1');
    expect(b.attrs['data-detail']).toBe('');
    expect(b.attrs['data-tasks']).toBe('list');
    expect(b.props['--ptl-max']).toBe('34cqh');
    expect(env.__get('_panelDetail')).toBe(false);
    env.__set('_viewPlan', '2');
    env.applyViewMode();
    expect(b.attrs['data-detail'].split(' ').sort()).toEqual(['controls', 'subtabs']);
    expect(b.props['--ptl-max']).toBe('50cqh');
    env.__set('_viewPlan', '3');
    env.applyViewMode();
    expect(b.attrs['data-tasks']).toBe('line');
    expect(b.props['--ptl-max']).toBeUndefined();
    env.__set('_viewMode', 'advanced');
    env.__set('_viewPlan', '1');
    env.applyViewMode();
    expect(b.attrs['data-detail'].split(' ').sort()).toEqual(
      ['agenthead', 'agenttabs', 'artifacts', 'controls', 'goal', 'info', 'sections', 'subtitle'].sort(),
    );
    expect(b.attrs['data-tasks']).toBe('runs');
    expect(env.__get('_panelDetail')).toBe(true);
    env.__set('_viewPlan', '3');
    env.applyViewMode();
    // 3안 압축: everything is there, folded at first (the old 자세히 off).
    expect(env.__get('_panelDetail')).toBe(false);
  });

  const hides = (tok: string, sel: string) => {
    const re = new RegExp(
      `body:not\\(\\[data-detail~="${tok}"\\]\\) ${sel.replace(/[.*+?^${}()|[\]\\#]/g, '\\$&')}[,\\s{]`,
    );
    return re.test(CSS);
  };

  it('CSS hides the sections the plan leaves out; what needs the user is never in the list', () => {
    for (const [tok, sel] of [
      ['subtitle', '#panel-title-sub'],
      ['info', '#panel-info'],
      ['goal', '#panel-goal'],
      ['artifacts', '#panel-artifacts'],
      ['agenthead', '#panel-agents'],
      ['controls', '#panel-controls'],
    ])
      expect(hides(tok, sel), `${tok} ${sel}`).toBe(true);
    expect(CSS).toContain('body:not([data-detail~="sections"]) .panel-sections::part(list)');
    expect(CSS).toContain('body:not([data-detail~="agenttabs"]):not([data-detail~="subtabs"]) .panel-tabs::part(list)');
    expect(CSS).toContain('body[data-detail~="subtabs"] .slide-panel:not([data-subagents]) .panel-tabs::part(list)');
    expect(CSS).toContain('body:not([data-tasks="runs"]) .panel-tasks { max-height: var(--ptl-max, 34cqh);');
    for (const sel of ['#panel-permission', '#panel-question', '#panel-needs-head', '#panel-status', '#panel-command'])
      expect(CSS, sel).not.toMatch(new RegExp(`data-detail[^{]*${sel}[,\\s{]`));
    // The mode no longer hides detail sections itself — the plan does.
    expect(CSS).not.toMatch(/body\[data-view-mode="minimal"\] #panel-info/);
  });

  it('the tasks paint as the plan says: the runs table, the checklist, or one line', () => {
    const fn = clientFn('repaintPanelTasks');
    expect(fn).toContain('var t = viewSpec().detail.tasks;');
    expect(fn).toContain("if (t === 'list') { renderPanelTaskList(panelAgentTasks()); return; }");
    expect(fn).toContain("if (t === 'line') { renderPanelTaskLine(panelAgentTasks()); return; }");
    expect(fn).toContain(
      'renderPanelTasks(panelAgentTasks(), panelAgentLabel(), panelAgentEarlier(), panelAgentOutside());',
    );
  });

  it('3안’s task line: "작업 done / all · 지금: the running one"; a press opens the checklist under it', () => {
    const container: Record<string, any> = { style: {} };
    const plan: Record<string, any> = {};
    const env = load<{ renderPanelTaskLine(t: unknown[]): void; togglePanelTaskLine(): void; __get(n: string): any }>(
      ['esc', 'renderPanelTaskLine', 'togglePanelTaskLine'],
      ['_panelTaskLineOpen'],
      {
        document: {
          getElementById: (id: string) =>
            id === 'panel-tasks'
              ? container
              : id === 'panel-task-list' && String(container.innerHTML || '').includes('panel-task-list')
                ? plan
                : null,
        },
        morphInnerHtml: (el: Record<string, unknown>, html: string) => {
          el.innerHTML = html;
        },
        taskElData: (el: Record<string, unknown>, d: unknown) => {
          el.data = d;
        },
        panelTaskListData: (t: unknown[]) => ({ title: '', steps: t }),
        repaintPanelTasks: () => env.renderPanelTaskLine(tasks),
      },
    );
    const tasks = [
      { id: 'T1', content: '요구 정리', status: 'completed' },
      { id: 'T2', content: '구현 <b>', status: 'in_progress' },
      { id: 'T3', content: '확인', status: 'pending' },
    ];
    env.renderPanelTaskLine(tasks);
    expect(container.style.display).toBe('');
    expect(container.innerHTML).toContain('작업 1 / 3');
    expect(container.innerHTML).toContain('지금: 구현 &lt;b&gt;');
    expect(container.innerHTML).toContain('aria-expanded="false"');
    // Folded, it controls nothing yet: no aria-controls pointing at a list that is not there (review, fable P3).
    expect(container.innerHTML).not.toContain('aria-controls');
    expect(container.innerHTML).not.toContain('<ui-task-plan');
    env.togglePanelTaskLine();
    expect(container.innerHTML).toContain('aria-expanded="true"');
    expect(container.innerHTML).toContain('aria-controls="panel-task-list"');
    expect(container.innerHTML).toContain('<ui-task-plan class="panel-task-list" id="panel-task-list"');
    expect(plan.data).toEqual({ title: '', steps: tasks });
    env.renderPanelTaskLine([]);
    expect(container.style.display).toBe('none');
    // A new opening starts folded.
    expect(clientFn('resetPanelSections')).toContain('_panelTaskLineOpen = false;');
  });

  it('the agent tabs and the section tabs follow the plan: no strip, no subagent or other section left selected', () => {
    const env = load<{ psecForMode(land: string): string; __set(n: string, v: unknown): void }>(
      ['viewModeFrom', 'viewPlanFrom', 'viewSpec', 'detailShows', 'psecForLanding', 'psecForMode'],
      ['VIEW_PLANS', '_viewMode', '_viewPlan'],
    );
    expect(env.psecForMode('worklog')).toBe('conv');
    env.__set('_viewMode', 'advanced');
    expect(env.psecForMode('worklog')).toBe('log');
    expect(clientFn('openPanel')).toContain(
      "if (!detailShows('agenttabs') && !detailShows('subtabs')) _panelAgent = '';",
    );
    const re = clientFn('rerenderForViewMode');
    expect(re).toContain(
      "if (!detailShows('agenttabs') && !detailShows('subtabs') && _panelAgent) selectPanelAgent('');",
    );
    expect(re).toContain("if (!detailShows('sections') && _psec !== 'conv') selectPanelSection('conv');");
    // 2안's strip shows only with a subagent: the panel says when it has one.
    expect(clientFn('renderPanelTabs')).toContain("panel.toggleAttribute('data-subagents', d.tabs.length > 1);");
  });
});
