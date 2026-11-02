/**
 * Plan mode (SSOT 2026-11-02) — step 6c of `evaluateToolPolicy`: a dashboard task
 * whose plan is not started researches; it does not do the work. The check is
 * mode- and admin-independent (bypass and admins included), like the devops-secret
 * step — "no work before 시작" is the owner's contract, not a privilege (trinity R2, astra P1).
 *
 * ssot-task map: T2 (the model plans) · T4 (the work starts on 시작).
 */
import { describe, expect, it } from 'vitest';
import { checkPlanPendingCall } from '../policy/plan-pending-guard';
import { evaluateToolPolicy, PLAN_PENDING_DENY_MESSAGE, type ToolPolicyContext } from '../policy/tool-policy';

const USER = 'U0PLANNER01';
const FILE = `/tmp/${USER}/task/src/index.ts`;

function ctx(over: Partial<ToolPolicyContext> = {}): ToolPolicyContext {
  return {
    user: USER,
    isAdmin: false,
    mode: 'bypass',
    aborted: false,
    isDangerousRuleDisabled: () => false,
    handoffContext: undefined,
    checkMcpToolPermission: () => null,
    checkEnvSkillPermission: () => null,
    ...over,
  };
}
const planning = (over: Partial<ToolPolicyContext> = {}) => ctx({ checkPlanPending: checkPlanPendingCall, ...over });

describe('evaluateToolPolicy — step 6c, a plan not started', () => {
  it('without the check nothing changes: bypass allows Write and any Bash', () => {
    expect(evaluateToolPolicy('Write', { file_path: FILE, content: 'x' }, ctx()).decision).toBe('allow');
    expect(evaluateToolPolicy('Bash', { command: 'git push' }, ctx()).decision).toBe('allow');
  });

  it('refuses the work in every mode, for admins too, and tells the model why', () => {
    for (const mode of ['bypass', 'auto', 'legacy'] as const) {
      for (const isAdmin of [false, true]) {
        for (const [tool, input] of [
          ['Write', { file_path: FILE, content: 'x' }],
          ['Edit', { file_path: FILE, old_string: 'a', new_string: 'b' }],
          ['Agent', { description: 'd', prompt: 'p' }],
          ['Bash', { command: 'git commit -am wip' }],
          ['mcp__github__create_pull_request', {}],
        ] as const) {
          const r = evaluateToolPolicy(tool, input, planning({ mode, isAdmin }));
          expect(r.decision, `${mode}/${isAdmin}/${tool}`).toBe('deny');
          expect(r.reason.startsWith('plan-pending: ')).toBe(true);
          expect(r.denyMessage).toBe(PLAN_PENDING_DENY_MESSAGE);
        }
      }
    }
  });

  it('lets research through to the mode tier as before', () => {
    expect(evaluateToolPolicy('Read', { file_path: FILE }, planning()).decision).toBe('allow');
    expect(evaluateToolPolicy('Grep', { pattern: 'x' }, planning()).decision).toBe('allow');
    expect(evaluateToolPolicy('Bash', { command: 'git log --oneline -5' }, planning()).decision).toBe('allow');
    expect(evaluateToolPolicy('mcp__plan__plan_submit', {}, planning()).decision).toBe('pass');
    expect(evaluateToolPolicy('Bash', { command: 'ls' }, planning({ mode: 'legacy' })).decision).toBe('pass');
  });

  it('an earlier deny still wins (abort, devops secret)', () => {
    expect(evaluateToolPolicy('Bash', { command: 'ls' }, planning({ aborted: true })).reason).toMatch(/^abort-guard/);
    expect(evaluateToolPolicy('Bash', { command: 'gh auth token' }, planning()).reason).toMatch(/^devops-secret/);
  });
});
