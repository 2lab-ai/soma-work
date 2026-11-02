/**
 * Plan mode (SSOT 2026-11-02 — 작업 계획 모드): a dashboard task with the plan
 * toggle on is gated. The model submits a structured plan (`plan_submit`), the
 * owner starts it, cancels it or writes direct input; nothing runs as work
 * before the start. Pure functions over the gate; the registry stores them.
 *
 * ssot-task map: T2 (SSOT + INTENT-FIRST plan) · T3 (four levels) · T4 (start / cancel / direct input).
 */
import { describe, expect, it } from 'vitest';
import {
  applyPlanSubmission,
  checkPlanSubmission,
  decidePlan,
  isPlanPending,
  newPlanGate,
  PLAN_APPROVED_TEXT_MAX,
  planApprovedText,
  planGateTurn,
  sanitizeTaskPlanGate,
  TaskPlanError,
  type TaskPlanGate,
} from '../task-plan';

const NOW = 1_800_000_000_000;

const valid = (extra: Record<string, unknown> = {}) => ({
  summary: '  새 작업에 계획 모드를 넣는다  ',
  intent: '긴 지시가 잘못 읽힌 채 실행되지 않게',
  ssot: ['대시보드 "새 작업"에서 plan 토글 on/off 추가 (디폴트 on)'],
  intents: [{ id: 'I1', text: '실행 전 확인', source: 'SSOT_1' }],
  phases: [
    {
      title: '서버 게이트',
      goal: '승인 전에는 실행하지 않는다',
      steps: [
        { title: '계획 제출 도구', detail: 'plan_submit', deliverable: 'src/task-turn/plan-server.ts', refs: ['T2'] },
        { title: '승인 라우트', refs: ['T4'] },
      ],
    },
    { title: '화면', steps: [{ title: '디테일 카드에 계획' }] },
  ],
  assumptions: ['대시보드 작업만'],
  risks: ['모델이 계획 중에 작업을 시작'],
  outOfScope: ['Slack 채널 작업'],
  questions: ['에픽도 포함?'],
  ...extra,
});

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof TaskPlanError ? e.code : `not TaskPlanError: ${(e as Error).message}`;
  }
  return 'no throw';
};

const gate = (extra: Partial<TaskPlanGate> = {}): TaskPlanGate => ({ ...newPlanGate(NOW), ...extra });

describe('checkPlanSubmission — the four levels (T3)', () => {
  it('keeps every level, trimmed: conclusion · intent → phases → steps → details', () => {
    const plan = checkPlanSubmission(valid());
    expect(plan.summary).toBe('새 작업에 계획 모드를 넣는다');
    expect(plan.intent).toBe('긴 지시가 잘못 읽힌 채 실행되지 않게');
    expect(plan.phases.map((p) => p.title)).toEqual(['서버 게이트', '화면']);
    expect(plan.phases[0].steps.map((s) => s.title)).toEqual(['계획 제출 도구', '승인 라우트']);
    expect(plan.phases[0].steps[0]).toMatchObject({
      detail: 'plan_submit',
      deliverable: 'src/task-turn/plan-server.ts',
      refs: ['T2'],
    });
    expect(plan.intents).toEqual([{ id: 'I1', text: '실행 전 확인', source: 'SSOT_1' }]);
    expect(plan.questions).toEqual(['에픽도 포함?']);
  });

  it('refuses a plan with no conclusion, no phase, or a phase with no step', () => {
    expect(code(() => checkPlanSubmission(valid({ summary: '  ' })))).toBe('bad-summary');
    expect(code(() => checkPlanSubmission(valid({ phases: [] })))).toBe('no-phases');
    expect(code(() => checkPlanSubmission(valid({ phases: [{ title: 'a', steps: [] }] })))).toBe('no-steps');
    expect(code(() => checkPlanSubmission(valid({ phases: [{ title: '', steps: [{ title: 'x' }] }] })))).toBe(
      'bad-title',
    );
    expect(code(() => checkPlanSubmission(null))).toBe('bad-input');
  });

  it('holds every list and text to its bound', () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ title: `p${i}`, steps: [{ title: 's' }] }));
    expect(code(() => checkPlanSubmission(valid({ phases: many })))).toBe('too-many');
    const steps = Array.from({ length: 16 }, (_, i) => ({ title: `s${i}` }));
    expect(code(() => checkPlanSubmission(valid({ phases: [{ title: 'p', steps }] })))).toBe('too-many');
    expect(code(() => checkPlanSubmission(valid({ summary: 'x'.repeat(301) })))).toBe('bad-summary');
    expect(
      code(() =>
        checkPlanSubmission(valid({ phases: [{ title: 'p', steps: [{ title: 's', detail: 'd'.repeat(2001) }] }] })),
      ),
    ).toBe('too-long');
    expect(code(() => checkPlanSubmission(valid({ risks: Array.from({ length: 13 }, () => 'r') })))).toBe('too-many');
  });
});

describe('the gate — submit, decide, sanitize (T2 · T4)', () => {
  it('a submission waits for the owner: drafting → awaiting, revision counts up, a resubmission replaces it', () => {
    const first = applyPlanSubmission(gate(), checkPlanSubmission(valid()), NOW + 1);
    expect(first).toMatchObject({ state: 'awaiting', revision: 1, updatedAt: NOW + 1 });
    expect(first.plan).toMatchObject({ revision: 1, submittedAt: NOW + 1, summary: '새 작업에 계획 모드를 넣는다' });
    const second = applyPlanSubmission(first, checkPlanSubmission(valid({ summary: 'v2' })), NOW + 2);
    expect(second).toMatchObject({ state: 'awaiting', revision: 2 });
    expect(second.plan?.summary).toBe('v2');
  });

  it('refuses a submission once the plan was started or cancelled', () => {
    const plan = checkPlanSubmission(valid());
    expect(code(() => applyPlanSubmission(gate({ state: 'approved', revision: 1 }), plan, NOW))).toBe(
      'already-decided',
    );
    expect(code(() => applyPlanSubmission(gate({ state: 'cancelled', revision: 1 }), plan, NOW))).toBe(
      'already-decided',
    );
  });

  it('시작 approves only the revision the owner saw; 취소 cancels; anything stale is a 409', () => {
    const awaiting = applyPlanSubmission(gate(), checkPlanSubmission(valid()), NOW);
    const started = decidePlan(awaiting, 'start', 1, 'U1', NOW + 5);
    expect(started).toEqual({
      ok: true,
      gate: { ...awaiting, state: 'approved', decidedAt: NOW + 5, decidedBy: 'U1', updatedAt: NOW + 5 },
    });
    expect(decidePlan(awaiting, 'start', 2, 'U1', NOW)).toMatchObject({ ok: false, status: 409 });
    expect(decidePlan(gate(), 'start', 0, 'U1', NOW)).toMatchObject({ ok: false, status: 409 });
    const cancelled = decidePlan(awaiting, 'cancel', 1, 'U1', NOW + 6);
    expect(cancelled).toMatchObject({ ok: true, gate: { state: 'cancelled', decidedBy: 'U1' } });
    // A plan still being written can be cancelled too (nothing to start yet).
    expect(decidePlan(gate(), 'cancel', 0, 'U1', NOW)).toMatchObject({ ok: true, gate: { state: 'cancelled' } });
    if (started.ok) expect(decidePlan(started.gate, 'cancel', 1, 'U1', NOW)).toMatchObject({ ok: false, status: 409 });
  });

  it('pending = anything not started yet', () => {
    expect(isPlanPending(undefined)).toBe(false);
    expect(isPlanPending(gate())).toBe(true);
    expect(isPlanPending(gate({ state: 'awaiting', revision: 1 }))).toBe(true);
    expect(isPlanPending(gate({ state: 'cancelled' }))).toBe(true);
    expect(isPlanPending(gate({ state: 'approved', revision: 1 }))).toBe(false);
  });

  it('a saved gate round-trips; a broken one is dropped or repaired, never invented', () => {
    const awaiting = applyPlanSubmission(gate(), checkPlanSubmission(valid()), NOW);
    expect(sanitizeTaskPlanGate(JSON.parse(JSON.stringify(awaiting)))).toEqual(awaiting);
    expect(sanitizeTaskPlanGate({ state: 'bogus', revision: 1, updatedAt: NOW })).toBeUndefined();
    expect(sanitizeTaskPlanGate('nope')).toBeUndefined();
    // Waiting on a plan it no longer has: back to writing one.
    expect(sanitizeTaskPlanGate({ state: 'awaiting', revision: 3, updatedAt: NOW })).toMatchObject({
      state: 'drafting',
      revision: 3,
    });
  });
});

describe('planGateTurn — the notice a pending task turn carries (T2 · T4)', () => {
  it('no gate, or a started plan: no notice, the gate is unchanged', () => {
    expect(planGateTurn(undefined, NOW)).toEqual({ notice: undefined, gate: undefined });
    const approved = gate({ state: 'approved', revision: 1 });
    expect(planGateTurn(approved, NOW)).toEqual({ notice: undefined, gate: approved });
  });

  it('the first plan: SSOT + intent-first, no work, plan_submit, then end the turn', () => {
    const { notice, gate: next } = planGateTurn(gate(), NOW);
    expect(notice).toContain('<task-plan-mode');
    expect(notice).toContain('zworkflow:using-ssot');
    expect(notice).toContain('zworkflow:using-intentfirst');
    expect(notice).toContain('mcp__plan__plan_submit');
    expect(notice).toMatch(/작업을 시작하지 않는다/);
    // using-intentfirst proceeds without waiting; plan mode overrides it.
    expect(notice).toMatch(/기다리지 않고 선진행/);
    expect(next?.state).toBe('drafting');
  });

  it('direct input on a waiting plan: revise v2 and resubmit — the gate goes back to drafting', () => {
    const awaiting = gate({ state: 'awaiting', revision: 2 });
    const { notice, gate: next } = planGateTurn(awaiting, NOW + 1);
    expect(notice).toContain('v2');
    expect(notice).toMatch(/직접 입력/);
    expect(notice).toContain('mcp__plan__plan_submit');
    expect(next).toMatchObject({ state: 'drafting', revision: 2, updatedAt: NOW + 1 });
  });

  it('an instruction after a cancel plans afresh', () => {
    const { notice, gate: next } = planGateTurn(gate({ state: 'cancelled', revision: 1 }), NOW + 1);
    expect(notice).toContain('zworkflow:using-ssot');
    expect(next).toMatchObject({ state: 'drafting', revision: 1 });
  });
});

describe('planApprovedText — the instruction 시작 sends (T4)', () => {
  it('names the revision and who started it, and carries the plan from conclusion to details', () => {
    const plan = applyPlanSubmission(gate(), checkPlanSubmission(valid()), NOW).plan;
    const text = planApprovedText(plan!, 'U1');
    expect(text).toContain('v1');
    expect(text).toContain('<@U1>');
    expect(text).toContain('새 작업에 계획 모드를 넣는다');
    const order = ['서버 게이트', '계획 제출 도구', 'plan_submit', '화면', '디테일 카드에 계획'].map((s) =>
      text.indexOf(s),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('stays within the instruction bound however long the plan is', () => {
    const huge = checkPlanSubmission(
      valid({
        phases: Array.from({ length: 10 }, (_, p) => ({
          title: `phase ${p}`,
          steps: Array.from({ length: 15 }, (_, s) => ({ title: `step ${s}`, detail: 'd'.repeat(2000) })),
        })),
      }),
    );
    const plan = applyPlanSubmission(gate(), huge, NOW).plan!;
    expect(planApprovedText(plan, 'U1').length).toBeLessThanOrEqual(PLAN_APPROVED_TEXT_MAX);
  });
});
