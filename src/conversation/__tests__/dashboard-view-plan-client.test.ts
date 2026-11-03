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
 *   P5  미니멀's detail card: the chat is a tab view with the work log (대화 · 작업 로그, SSOT 2026-11-03);
 *       어드밴스드 keeps the whole strip (대화 · 작업 로그 · 에이전트 트리)
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILTIN_PRESETS } from '../../view-layout';
import { viewerScope } from '../__fixtures__/viewer-scope';
import { VIEW_LAYOUT_CLIENT_JS } from '../view-layout-client';

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
/** A one-line `var X = …;`, or a block `var X = {` … `\n};` / `var X = [` … `\n];`. */
function clientVar(name: string): string {
  const one = TEMPLATE.match(new RegExp(`^(var ${name} = .*?;)(?:\\s*//.*)?$`, 'm'));
  if (one) return cook(one[1]);
  for (const [open, close] of [
    ['{', '}'],
    ['[', ']'],
  ]) {
    const start = TEMPLATE.indexOf(`\nvar ${name} = ${open}\n`);
    if (start < 0) continue;
    const end = TEMPLATE.indexOf(`\n${close};\n`, start);
    return cook(TEMPLATE.slice(start + 1, end + 3));
  }
  throw new Error(`client var ${name} not found`);
}
/** A one-time wiring block `(function name() {` … `\n})();`, run where it stands in the page. */
function clientIife(name: string): string {
  const start = TEMPLATE.indexOf(`\n(function ${name}() {\n`);
  if (start < 0) throw new Error(`client block ${name} not found`);
  const end = TEMPLATE.indexOf('\n})();\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 6));
}
/** The page's script as the browser runs it: the shared layout script (view-layout-client.ts) and VIEW_BUILTINS first. */
function load<T>(fns: string[], vars: string[], inject: Record<string, unknown> = {}, iifes: string[] = []): T {
  ({ fns, inject } = viewerScope(fns, inject));
  const all: Record<string, unknown> = { VIEW_BUILTINS: BUILTIN_PRESETS, ...inject };
  const names = Object.keys(all);
  const setter = '__set: function(n, v) { eval(n + " = v"); }';
  const getter = '__get: function(n) { return eval(n); }';
  const body = `${VIEW_LAYOUT_CLIENT_JS}\n${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\n${iifes.map(clientIife).join('\n')}\nreturn { ${[...fns, setter, getter].join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => all[n])) as T;
}
const PAGE = cook(TEMPLATE.slice(TEMPLATE.indexOf('<body'), TEMPLATE.indexOf('<script>', TEMPLATE.indexOf('<body'))));
const CSS = cook(
  TEMPLATE.slice(TEMPLATE.indexOf('<style>'), TEMPLATE.indexOf('</style>', TEMPLATE.indexOf('<style>'))),
);
const T0 = 1_700_000_000_000;

type Spec = {
  name: string;
  face: { rows: Array<{ id: string; on: boolean }>; foot: Array<{ id: string; on: boolean }>; kind: boolean };
  body: { star: boolean; work: string[]; wait: string[]; done: string[] };
  detail: { show: string[]; tasks: string; tasksMax?: number; open: boolean; order: string[] };
};
const B = BUILTIN_PRESETS as unknown as Record<string, Record<string, any>>;
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
    ['_viewMode', '_viewPlan', '_viewLayout'],
  );

describe('P1 — the plan table: two modes × three plans; the user’s dashboardPlan picks one', () => {
  it('every mode has 1안 · 2안 · 3안 (the built-in presets), each with a face, an open card and a detail card', () => {
    const env = plansEnv();
    for (const mode of ['minimal', 'advanced']) {
      env.__set('_viewMode', mode);
      for (const p of ['1', '2', '3']) {
        env.__set('_viewPlan', p);
        const s = env.viewSpec();
        expect(s.name, `${mode} ${p}`).toBe(B[p].name[mode]);
        expect(Array.isArray(s.face.rows) && Array.isArray(s.face.foot)).toBe(true);
        for (const lane of ['work', 'wait', 'done'] as const) expect(Array.isArray(s.body[lane])).toBe(true);
        expect(['runs', 'list', 'line', 'none']).toContain(s.detail.tasks);
        // The .prd names each plan as the table does.
        expect(PRD).toContain(s.name);
      }
    }
  });

  it('the user’s layouts win: a default per surface, an edited preset (.prd/21)', () => {
    const env = plansEnv();
    env.__set('_viewLayout', { v: 1, active: { card: '3', detail: '2' } });
    expect(env.viewSpec().name).toBe('한눈에');
    expect(env.viewSpec().detail.tasksMax).toBe(50);
    env.__set('_viewLayout', {
      v: 1,
      presets: { '1': { minimal: { card: { ...B['1'].minimal.card, kind: false } } } },
    });
    expect(env.viewSpec().face.kind).toBe(false);
    // A broken copy on the device falls back to the built-ins rather than breaking the board.
    env.__set('_viewLayout', { v: 1, presets: { '1': { minimal: { open: { parts: 'x' } } } } });
    expect(env.viewSpec().body.work).toEqual([]);
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
    expect(call).toBeGreaterThan(
      TEMPLATE.indexOf(
        '_viewPlan = readViewPlan();\n_viewLayout = readViewLayout();\napplyViewMode();\nsyncBoardScope();',
      ),
    );
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
  const MODEL_ID = 'claude-opus-5-5[1m]';
  const COST = { text: '$6.20', title: 'API 환산 비용\n총 토큰 6.4M' };
  // #805: the face shows the model as icons — the maker's mark in the model's colour (and the effort gauge when the
  // session has one); the name is the chip's title and accessible name.
  const MODEL = {
    text: '',
    glyph: 'claude',
    color: '#d97757',
    title: 'Opus 5.5\nclaude-opus-5-5[1m]',
    label: '모델 Opus 5.5',
  };
  const PR = full.metrics[1];
  const MEDIA = full.metrics[0];
  const ARTS = { text: '5', glyph: 'file', title: '산출물 5개', label: '산출물 5개' };
  const STEPS = { text: '2/4', glyph: 'tasks', title: '완료한 작업 / 전체' };
  const CTX = { text: '64%', glyph: 'context', title: 'x', tone: 'warn' };
  const faceFn = (
    new Function('REPRESENTATIVE_MODELS', `${VIEW_LAYOUT_CLIENT_JS}\nreturn faceOf;`) as (
      r: unknown,
    ) => (
      c: unknown,
      model: unknown,
      f: unknown,
      asks: boolean,
      effort?: unknown,
      asked?: unknown,
    ) => Record<string, any>
  )([{ nickname: 'opus[1m]', model: 'claude-opus-5-5[1m]', label: 'Opus 5.5' }]);
  const face = (mode: string, p: string, asks = false) => faceFn({ ...full }, MODEL_ID, B[p][mode].card, asks);

  it('minimal 1안 결과 우선: the task row, three artifacts, the summary only when it asks; PR · cost · model', () => {
    const m = face('minimal', '1');
    // 작업 카드의 연결 (SSOT 2026-11-02): the links row after the task in every plan; it carries the PR.
    expect(m.rows).toEqual(['task', 'links', 'artifacts']);
    expect(m.task).toEqual(full.task);
    expect(m.artifacts.map((a: { id: string }) => a.id)).toEqual(['a', 'b', 'c']);
    expect(m.artifactsCount).toBe(5);
    expect(m.summary).toBeUndefined();
    const asking = face('minimal', '1', true);
    expect(asking.summary).toBe('원래 제목');
    expect(asking.rows).toEqual(['summary', 'task', 'links', 'artifacts']);
    expect(m.metrics).toEqual([COST, MODEL]);
    for (const gone of ['agents', 'tokens', 'costUsd', 'steps', 'contextPct']) expect(m[gone], gone).toBeUndefined();
    expect(m.lead).toEqual({ glyph: 'task', title: '일반 작업' });
    expect(m.star).toEqual(full.star);
    expect(m.badge).toEqual(full.badge);
  });

  it('minimal 2안 진행 우선: the summary always, the task row; steps · artifacts n · cost · model at the foot', () => {
    const m = face('minimal', '2');
    expect(m.rows).toEqual(['summary', 'task', 'links']);
    expect(m.summary).toBe('원래 제목');
    expect(m.artifacts).toBeUndefined();
    expect(m.metrics).toEqual([STEPS, ARTS, COST, MODEL]);
  });

  it('minimal 3안 한눈에: title · status · time; the summary only when it asks; cost · model', () => {
    const m = face('minimal', '3');
    expect(m.rows).toEqual(['links']);
    for (const gone of ['task', 'artifacts', 'steps', 'summary', 'agents']) expect(m[gone], gone).toBeUndefined();
    expect(m.metrics).toEqual([COST, MODEL]);
    expect(face('minimal', '3', true).summary).toBe('원래 제목');
  });

  it('advanced 1안 정리: every row, the kind mark instead of ✦, the model at the foot’s end', () => {
    const m = face('advanced', '1');
    expect(m.rows).toEqual(['summary', 'task', 'links', 'agents', 'usage', 'artifacts']);
    for (const kept of ['summary', 'task', 'agents', 'tokens', 'costUsd', 'artifacts'])
      expect(m[kept], kept).toBeDefined();
    expect(m.artifacts).toHaveLength(4);
    expect(m.lead).toEqual({ glyph: 'task', title: '일반 작업' });
    expect(m.metrics).toEqual([STEPS, CTX, MEDIA, MODEL]);
  });

  it('advanced 2안 원본: the face as it was — every row, ✦ (no lead), steps · context · attachments · PR', () => {
    const m = face('advanced', '2');
    expect(m.rows).toEqual(['summary', 'task', 'links', 'agents', 'usage', 'artifacts']);
    expect(m.lead).toBeUndefined();
    expect(m.metrics).toEqual([STEPS, CTX, MEDIA]);
  });

  it("#805 the model chip: icons only — the mark in its maker's colour and the effort gauge; the name as title", () => {
    const m = faceFn({ ...full }, MODEL_ID, B['1'].minimal.card, false, 'xhigh');
    expect(m.metrics[m.metrics.length - 1]).toEqual({
      text: '',
      glyph: 'claude',
      color: '#d97757',
      effort: 'xhigh',
      title: 'Opus 5.5 · 추론 강도 매우 높음\nclaude-opus-5-5[1m]',
      label: '모델 Opus 5.5, 추론 강도 매우 높음',
    });
    // An effort the gauge does not know is left out (the name stays).
    const odd = faceFn({ ...full }, MODEL_ID, B['1'].minimal.card, false, 'turbo');
    expect(odd.metrics[odd.metrics.length - 1]).toEqual(MODEL);
  });

  it('#805 review P1 — the gauge is the level the model runs; the title names the set level when it is capped', () => {
    const m = faceFn({ ...full }, MODEL_ID, B['1'].minimal.card, false, 'high', 'xhigh');
    expect(m.metrics[m.metrics.length - 1]).toEqual({
      ...MODEL,
      effort: 'high',
      title: 'Opus 5.5 · 추론 강도 높음 (설정 매우 높음)\nclaude-opus-5-5[1m]',
      label: '모델 Opus 5.5, 추론 강도 높음 (설정 매우 높음)',
    });
    // Not capped: the set level is the one it runs — said once.
    const same = faceFn({ ...full }, MODEL_ID, B['1'].minimal.card, false, 'high', 'high');
    expect(same.metrics[same.metrics.length - 1].title).toBe('Opus 5.5 · 추론 강도 높음\nclaude-opus-5-5[1m]');
  });

  it("#805 each maker's colour: Claude clay, Gemini blue; OpenAI and Grok the ink; an unknown model none", () => {
    const chip = (id: string) => {
      const m = faceFn({ ...full }, id, B['1'].minimal.card, false, 'high');
      return m.metrics[m.metrics.length - 1];
    };
    // Each maker's own colour (affectUI's agent rows): every Claude model is Claude's clay, Gemini is Google's blue;
    // OpenAI's and xAI's marks are black, so they take the chip's ink (no colour).
    const colours = [
      'claude-opus-5-5[1m]',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
      'fable',
      'gpt-5.5-codex',
      'grok-4',
      'gemini-3-pro',
    ].map((id) => [chip(id).glyph, chip(id).color]);
    expect(colours).toEqual([
      ['claude', '#d97757'],
      ['claude', '#d97757'],
      ['claude', '#d97757'],
      ['claude', '#d97757'],
      ['openai', undefined],
      ['grok', undefined],
      ['gemini', '#4285f4'],
    ]);
    const other = chip('llama-4');
    expect(other.glyph).toBe('model');
    expect(other.color).toBeUndefined();
    expect(other.effort).toBe('high');
  });

  it('advanced 3안 압축: no sub-agent or token rows; the numbers at the foot', () => {
    const m = face('advanced', '3');
    expect(m.rows).toEqual(['task', 'links']);
    for (const gone of ['agents', 'tokens', 'costUsd', 'artifacts', 'summary']) expect(m[gone], gone).toBeUndefined();
    expect(m.metrics).toEqual([STEPS, CTX, ARTS, COST, MODEL]);
  });

  it('a user’s layout: the rows in its order, the head’s switches, a hidden chip gone (.prd/21)', () => {
    const layout = {
      kind: false,
      star: false,
      owner: false,
      rows: [
        { id: 'arts', on: true, opt: '1' },
        { id: 'task', on: true },
        { id: 'usage', on: false },
      ],
      foot: [
        { id: 'model', on: true },
        { id: 'tokens', on: true },
        { id: 'cost', on: false },
      ],
    };
    const m = faceFn({ ...full }, MODEL_ID, layout, false);
    expect(m.rows).toEqual(['artifacts', 'task']);
    expect(m.artifacts).toHaveLength(1);
    expect(m.star).toBeUndefined();
    expect(m.badge).toBeUndefined();
    expect(m.lead).toBeUndefined();
    expect(m.tokens).toBeUndefined();
    expect(m.metrics).toEqual([MODEL, { text: '6.4M 토큰', title: '총 토큰 6.4M' }]);
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
    // #805 review: the gauge draws the level the model runs (effortEffective when it caps the set one); an archive's
    // effort is the owner's default today, not the run's — no gauge.
    expect(fn).toContain("var eff = s.effortFromDefault ? '' : s.effortEffective || s.effort;");
    expect(fn).toContain(
      "return faceOf(c, s.model, viewSpec().face, cardAsks(s, col), eff, s.effortFromDefault ? '' : s.effort);",
    );
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
    mpReadOnlyWhy: () => '',
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
      'taskPlanCardHtml',
      'quickChoicesOf',
      'isBusy',
      'sessionActionsOf',
      'sessionActionHtml',
      'cardGoalLine',
      'acSlotHtml',
      'acQuestionId',
      'acPermissionsHtml',
      'acGoalDecisionHtml',
      'acInstructionApprovalsHtml',
      'acFollowUpHtml',
      'panelFollowUpShown',
      'acQuestionHtml',
      'renderEpicPlan',
      'cardLinksFace',
      'renderCardBody',
    ],
    [
      'CARD_LINK_KIND',
      'CARD_LINK_TONES',
      'RESUME_SVG',
      'GOAL_STATUS_LABELS',
      'GOAL_STATUS_TONE',
      'GOAL_SVG',
      'SESSION_ACTION_TONE',
      '_busy',
    ],
    STUBS,
  );
  const openParts = env.__get('openPartsOf') as (open: unknown, col: string) => string[];
  const bodyOf = (mode: string, p: string) => {
    const o = B[p][mode].open;
    return { star: !!o.star, work: openParts(o, 'working'), wait: openParts(o, 'waiting'), done: openParts(o, 'idle') };
  };
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
    env.renderCardBody(card(over), col, bodyOf(mode, p));
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
    expect(clientFn('paintCardBody')).toContain('var html = renderCardBody(s, col, viewSpec().body, viewSpec().face);');
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
      ['viewModeFrom', 'viewPlanFrom', 'viewSpec', 'orderPanelSurface', 'applyViewMode'],
      ['_viewMode', '_viewPlan', '_viewLayout', '_panelDetail', 'PANEL_SURFACE_PARTS'],
      { document: { body: b, getElementById: () => null }, applyPanelDetail: () => {} },
    );
    env.applyViewMode();
    expect(b.attrs['data-view-mode']).toBe('minimal');
    expect(b.attrs['data-view-plan']).toBe('1');
    // #805 — the detail card names the model (the task card shows it as icons only): its model · effort line stays.
    // SSOT 2026-11-03: the chat is a tab view with the work log (logtab — 대화 · 작업 로그).
    expect(b.attrs['data-detail'].split(' ').sort()).toEqual(['controls', 'logtab']);
    expect(b.attrs['data-tasks']).toBe('list');
    expect(b.props['--ptl-max']).toBe('34cqh');
    expect(env.__get('_panelDetail')).toBe(false);
    env.__set('_viewPlan', '2');
    env.applyViewMode();
    expect(b.attrs['data-detail'].split(' ').sort()).toEqual(['controls', 'logtab', 'subtabs']);
    expect(b.props['--ptl-max']).toBe('50cqh');
    env.__set('_viewPlan', '3');
    env.applyViewMode();
    expect(b.attrs['data-detail'].split(' ').sort()).toEqual(['controls', 'logtab']);
    expect(b.attrs['data-tasks']).toBe('line');
    // The task line's checklist opens up to the same share.
    expect(b.props['--ptl-max']).toBe('34cqh');
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

  it('the detail card’s top sections move in the DOM too, so the separators fall between them as they read (review P3)', () => {
    const b = fakeBody();
    const ids = [
      'panel-info',
      'panel-goal',
      'panel-needs-head',
      'panel-permission',
      'panel-question',
      'panel-needs-status',
      'panel-artifacts',
    ];
    let moves = 0;
    const surf: { children: any[]; appendChild(el: any): void } = {
      children: [],
      appendChild(el: any) {
        moves++;
        this.children.splice(this.children.indexOf(el), 1);
        this.children.push(el);
      },
    };
    const els: Record<string, any> = { 'panel-surface': surf };
    for (const id of ids) surf.children.push((els[id] = { id, parentNode: surf }));
    const env = load<{ applyViewMode(): void; __set(n: string, v: unknown): void }>(
      ['viewModeFrom', 'viewPlanFrom', 'viewSpec', 'orderPanelSurface', 'applyViewMode'],
      ['_viewMode', '_viewPlan', '_viewLayout', '_panelDetail', 'PANEL_SURFACE_PARTS'],
      { document: { body: b, getElementById: (id: string) => els[id] ?? null }, applyPanelDetail: () => {} },
    );
    env.applyViewMode();
    // Already in order: nothing moves (a focused field inside keeps its focus).
    expect(moves).toBe(0);
    const detail = JSON.parse(JSON.stringify(B['1'].minimal.detail));
    const at = (id: string) => detail.top.findIndex((x: { id: string }) => x.id === id);
    const [artifacts] = detail.top.splice(at('artifacts'), 1);
    detail.top.unshift(artifacts);
    env.__set('_viewLayout', { v: 1, presets: { '1': { minimal: { detail } } } });
    env.applyViewMode();
    expect(surf.children.map((e) => e.id)).toEqual([
      'panel-artifacts',
      ...ids.filter((id) => id !== 'panel-artifacts'),
    ]);
    expect(b.props['--o-artifacts']).toBe('1');
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
    // The section strip hides only when the card shows neither the whole strip nor 미니멀's 대화 · 작업 로그.
    expect(CSS).toContain(
      'body:not([data-detail~="sections"]):not([data-detail~="logtab"]) .panel-sections::part(list)',
    );
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
      ['viewModeFrom', 'viewPlanFrom', 'viewSpec', 'detailShows', 'psecForLanding', 'psecShown', 'psecForMode'],
      ['_viewMode', '_viewPlan', '_viewLayout', 'PSEC_ORDER'],
    );
    // 미니멀's strip is 대화 · 작업 로그 (SSOT 2026-11-03): the work log lands on its tab, the tree on the chat.
    expect(env.psecForMode('worklog')).toBe('log');
    expect(env.psecForMode('agent')).toBe('conv');
    env.__set('_viewMode', 'advanced');
    expect(env.psecForMode('worklog')).toBe('log');
    expect(env.psecForMode('agent')).toBe('tree');
    expect(clientFn('openPanel')).toContain(
      "if (!detailShows('agenttabs') && !detailShows('subtabs')) _panelAgent = '';",
    );
    const re = clientFn('rerenderForViewMode');
    expect(re).toContain(
      "if (!detailShows('agenttabs') && !detailShows('subtabs') && _panelAgent) selectPanelAgent('');",
    );
    expect(re).toContain("if (psecShown().indexOf(_psec) < 0) selectPanelSection('conv');");
    expect(re).toContain('else renderPanelSections();');
    // 2안's strip shows only with a subagent: the panel says when it has one.
    expect(clientFn('renderPanelTabs')).toContain("panel.toggleAttribute('data-subagents', d.tabs.length > 1);");
  });
});

describe('P5 — 미니멀’s detail card: the chat is a tab view with the work log (대화 · 작업 로그, SSOT 2026-11-03)', () => {
  const PLANS = ['1', '2', '3'];
  const strip = () => ({ data: undefined as any, _sec: undefined as unknown });
  const ids = (data: { tabs: Array<{ id: string }> }) => data.tabs.map((t) => t.id);
  type Env = {
    applyViewMode(): void;
    psecForMode(land: string): string;
    renderPanelSections(): void;
    rerenderForViewMode(): void;
    __set(n: string, v: unknown): void;
    __get(n: string): any;
  };
  // The detail card's section strip as the page runs it: the plan (viewSpec), the strip's data, a mode switch.
  const sectionsEnv = (el: ReturnType<typeof strip>, calls: string[] = []) => {
    const env = load<Env>(
      [
        'viewModeFrom',
        'viewPlanFrom',
        'viewSpec',
        'detailShows',
        'psecForLanding',
        'psecShown',
        'psecForMode',
        'renderPanelSections',
        'selectPanelSection',
        'rerenderForViewMode',
      ],
      ['_viewMode', '_viewPlan', '_viewLayout', 'PSEC_ORDER', 'PSEC_TABS', '_psec'],
      {
        document: { getElementById: (id: string) => (id === 'panel-sections' ? el : null) },
        renderBoardForLayout: () => {},
        resetPanelSections: () => {},
        repaintPanelSession: () => {},
        repaintPanelTasks: () => {},
        sizePanelSections: () => {},
        selectPanelAgent: (id: string) => calls.push(`agent:${id}`),
        psecClear: (sec: string) => calls.push(`clear:${sec}`),
        paintSection: (sec: string) => calls.push(`paint:${sec}`),
        psecToNewest: () => {},
        panelSessionKey: 's1',
        _panelAgent: '',
      },
    );
    return env;
  };

  it('every minimal plan shows the 대화 · 작업 로그 strip (data-detail logtab); advanced the whole strip (sections)', () => {
    const body = {
      attrs: {} as Record<string, string>,
      setAttribute(k: string, v: string) {
        this.attrs[k] = v;
      },
      style: { setProperty() {}, removeProperty() {} },
    };
    const env = load<Env>(
      ['viewModeFrom', 'viewPlanFrom', 'viewSpec', 'orderPanelSurface', 'applyViewMode'],
      ['_viewMode', '_viewPlan', '_viewLayout', '_panelDetail', 'PANEL_SURFACE_PARTS'],
      { document: { body, getElementById: () => null }, applyPanelDetail: () => {} },
    );
    for (const p of PLANS) {
      env.__set('_viewPlan', p);
      env.__set('_viewMode', 'minimal');
      env.applyViewMode();
      const minimal = body.attrs['data-detail'].split(' ');
      expect(minimal, `minimal ${p}`).toContain('logtab');
      expect(minimal, `minimal ${p}`).not.toContain('sections');
      env.__set('_viewMode', 'advanced');
      env.applyViewMode();
      const advanced = body.attrs['data-detail'].split(' ');
      expect(advanced, `advanced ${p}`).toContain('sections');
      expect(advanced, `advanced ${p}`).not.toContain('logtab');
    }
    // The strip hides only when the card shows neither.
    expect(CSS).toContain(
      'body:not([data-detail~="sections"]):not([data-detail~="logtab"]) .panel-sections::part(list) { display: none; }',
    );
    expect(CSS).not.toContain('body:not([data-detail~="sections"]) .panel-sections::part(list)');
  });

  it('an opening toward the work log lands on 작업 로그; every other opening on the chat (대화 stays the default)', () => {
    const env = sectionsEnv(strip());
    for (const p of PLANS) {
      env.__set('_viewPlan', p);
      env.__set('_viewMode', 'minimal');
      expect(env.psecForMode('worklog'), `minimal ${p}`).toBe('log');
      expect(env.psecForMode('agent'), `minimal ${p}`).toBe('conv');
      expect(env.psecForMode('answer'), `minimal ${p}`).toBe('conv');
      expect(env.psecForMode(''), `minimal ${p}`).toBe('conv');
      env.__set('_viewMode', 'advanced');
      expect(env.psecForMode('worklog'), `advanced ${p}`).toBe('log');
      expect(env.psecForMode('agent'), `advanced ${p}`).toBe('tree');
      expect(env.psecForMode(''), `advanced ${p}`).toBe('conv');
    }
  });

  it('the strip’s tabs are the plan’s: 대화 · 작업 로그 in minimal, 대화 · 작업 로그 · 에이전트 트리 in advanced', () => {
    for (const p of PLANS) {
      const el = strip();
      const env = sectionsEnv(el);
      env.__set('_viewPlan', p);
      env.renderPanelSections();
      expect(ids(el.data), `minimal ${p}`).toEqual(['conv', 'log']);
      expect(el.data.tabs.map((t: { label: string }) => t.label)).toEqual(['대화', '작업 로그']);
      expect(el.data.value).toBe('conv');
      // The same section in another mode is another strip: it draws again.
      env.__set('_viewMode', 'advanced');
      env.renderPanelSections();
      expect(ids(el.data), `advanced ${p}`).toEqual(['conv', 'log', 'tree']);
    }
  });

  it('a switch to minimal with 에이전트 트리 shown brings the chat back; 작업 로그 stays, on the two-tab strip', () => {
    const el = strip();
    const calls: string[] = [];
    const env = sectionsEnv(el, calls);
    env.__set('_viewMode', 'advanced');
    env.__set('_psec', 'tree');
    env.renderPanelSections();
    expect(ids(el.data)).toEqual(['conv', 'log', 'tree']);
    env.__set('_viewMode', 'minimal');
    env.rerenderForViewMode();
    expect(env.__get('_psec')).toBe('conv');
    expect(el.data.value).toBe('conv');
    expect(ids(el.data)).toEqual(['conv', 'log']);
    expect(calls).toContain('paint:conv');
    // 작업 로그 is in both strips: the reader stays on it, and the strip redraws with the mode's tabs.
    env.__set('_viewMode', 'advanced');
    env.__set('_psec', 'log');
    env.renderPanelSections();
    env.__set('_viewMode', 'minimal');
    calls.length = 0;
    env.rerenderForViewMode();
    expect(env.__get('_psec')).toBe('log');
    expect(el.data.value).toBe('log');
    expect(ids(el.data)).toEqual(['conv', 'log']);
    expect(calls.filter((c) => c.startsWith('clear:') || c.startsWith('paint:'))).toEqual([]);
    env.__set('_viewMode', 'advanced');
    env.rerenderForViewMode();
    expect(ids(el.data)).toEqual(['conv', 'log', 'tree']);
  });

  it('a subagent’s 열기 in the work log stays put without an agent strip (no way back to the main agent)', () => {
    const listeners: Record<string, (e: unknown) => void> = {};
    const log = { addEventListener: (type: string, fn: (e: unknown) => void) => (listeners[type] = fn) };
    const opened: string[] = [];
    const env = load<{ __set(n: string, v: unknown): void }>(
      ['viewModeFrom', 'viewPlanFrom', 'viewSpec', 'detailShows', 'panelAgentOpenable'],
      ['_viewMode', '_viewPlan', '_viewLayout'],
      {
        wlEl: () => log,
        window: {},
        _wl: null,
        selectPanelAgent: (id: string) => opened.push(id),
        panelSessionKey: 'k1',
        // A1 is a tab of the agent strip; A9 is in the work log only (panelLogOnlyAgents).
        _sessionCache: { k1: { agents: [{ id: 'A1', n: 1 }] } },
      },
      ['initWorkLog'],
    );
    const open = (id = 'A1') => {
      let prevented = false;
      listeners['ui-open']({ target: log, detail: { id }, preventDefault: () => (prevented = true) });
      return prevented;
    };
    // 1안 · 3안: no agent strip — the 열기 does nothing (and says so to the element: no navigate sound).
    for (const p of ['1', '3']) {
      env.__set('_viewPlan', p);
      expect(open(), `minimal ${p}`).toBe(true);
    }
    expect(opened).toEqual([]);
    // 2안 shows the strip with a subagent; advanced always.
    env.__set('_viewPlan', '2');
    expect(open()).toBe(false);
    // 2안, a log-only agent: no tab of the strip — opening it would hide the strip and strand the reader.
    expect(open('A9')).toBe(true);
    env.__set('_viewMode', 'advanced');
    env.__set('_viewPlan', '1');
    expect(open()).toBe(false);
    // Advanced: the strip is always there (its main tab is the way back), a log-only agent opens too.
    expect(open('A9')).toBe(false);
    expect(opened).toEqual(['A1', 'A1', 'A9']);
  });
});
