/**
 * Plan mode (SSOT 2026-11-02) — the `plan` host tool (T2 · T4).
 *
 *   P1 rides a task turn whose plan is not started yet — any task (an epic
 *      too); never a started plan's turn, a task without plan mode, a Slack turn.
 *   P2 `plan_submit` takes no identity: the task is the turn's own.
 *   P3 a submission is saved through the host; a refusal comes back with its
 *      code (nothing changed); a failed save says so without its error text.
 *   P4 no host yet: refused.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskExecutionContext } from '../../agent-runtime/execution-context';
import { attachesPlanServer, buildPlanServer, type PlanHost, planTools, setPlanHost } from '../plan-server';
import { TaskPlanError } from '../task-plan';

vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => {
  const actual: any = await original();
  return { ...actual, createSdkMcpServer: vi.fn((config: any) => ({ type: 'sdk', name: config.name, config })) };
});

const ctx = (extra: Record<string, unknown> = {}) =>
  ({
    origin: 'task',
    userId: 'U1',
    isAdmin: false,
    permissionMode: 'legacy',
    sessionKey: 'task:t1',
    taskId: 't1',
    workingDirectory: '/tmp/U1/t',
    planPending: true,
    ...extra,
  }) as unknown as TaskExecutionContext;

const PLAN = { summary: 's', intent: 'i', phases: [{ title: 'p', steps: [{ title: 'x' }] }] };
const parse = (r: any) => JSON.parse(r.content[0].text);

afterEach(() => setPlanHost(undefined));

describe('the plan server (plan mode)', () => {
  it('P1 — rides a task turn whose plan is not started yet', () => {
    expect(attachesPlanServer(ctx())).toBe(true);
    expect(attachesPlanServer(ctx({ kind: 'epic' }))).toBe(true);
    expect(attachesPlanServer(ctx({ planPending: undefined }))).toBe(false);
    expect(attachesPlanServer(ctx({ origin: 'slack' }))).toBe(false);
    expect(attachesPlanServer(undefined)).toBe(false);
    const server: any = buildPlanServer(ctx());
    expect(server.name).toBe('plan');
    expect(server.config.tools.map((t: any) => t.name)).toEqual(['plan_submit']);
  });

  it('P2 — plan_submit takes no identity: the task is the turn’s own', async () => {
    const [submit] = planTools(ctx());
    expect(submit.name).toBe('plan_submit');
    expect(Object.keys(submit.inputSchema).sort()).toEqual(
      ['assumptions', 'intent', 'intents', 'outOfScope', 'phases', 'questions', 'risks', 'ssot', 'summary'].sort(),
    );
    const host: PlanHost = { submitTaskPlan: vi.fn(() => ({ state: 'awaiting', revision: 1, updatedAt: 1 }) as any) };
    setPlanHost(host);
    const ok = await submit.handler(PLAN as any, {});
    expect(host.submitTaskPlan).toHaveBeenCalledWith('t1', PLAN);
    expect(ok.isError).toBeUndefined();
    expect(parse(ok)).toMatchObject({ ok: true, revision: 1, state: 'awaiting' });
    // It tells the model to stop: the owner decides.
    expect(parse(ok).next).toMatch(/턴을 끝/);
  });

  it('P3 — a refusal keeps its code; a failed save hides its error text', async () => {
    const [submit] = planTools(ctx());
    const host: PlanHost = {
      submitTaskPlan: vi.fn(() => {
        throw new TaskPlanError('no-phases', 'a plan has at least one phase');
      }),
    };
    setPlanHost(host);
    const bad = await submit.handler({ ...PLAN, phases: [] } as any, {});
    expect(bad.isError).toBe(true);
    expect(parse(bad)).toMatchObject({ ok: false, code: 'no-phases', error: 'a plan has at least one phase' });
    (host.submitTaskPlan as any).mockImplementationOnce(() => {
      throw new Error('ENOSPC /private/disk/path');
    });
    const failed = await submit.handler(PLAN as any, {});
    expect(parse(failed)).toMatchObject({ ok: false, code: 'not-saved' });
    expect(JSON.stringify(failed.content)).not.toMatch(/ENOSPC|private/);
    (host.submitTaskPlan as any).mockImplementationOnce(() => {
      throw new Error('submitTaskPlan: t1 is not a plan-mode task');
    });
    expect(parse(await submit.handler(PLAN as any, {}))).toMatchObject({ ok: false, code: 'not-a-plan-task' });
  });

  it('P4 — no host yet: refused', async () => {
    const [submit] = planTools(ctx());
    expect(parse(await submit.handler(PLAN as any, {}))).toMatchObject({ ok: false, code: 'not-ready' });
  });
});
