/**
 * Tests for the host-side goal completion evaluator.
 *
 * Maps to Test-Matrix scenarios:
 *   - #11 verdict completed=true → status flip path (verdict surfaced)
 *   - #12 verdict completed=false → reason / remaining surfaced
 *   - #13 dispatcher failure / parse failure → throws GoalEvalParseError
 *   - parser tolerance for ```json fences and surrounding prose
 *
 * Status-transition side effects live in the slack-handler / index
 * orchestrator and are covered by their own integration tests; the
 * evaluator's contract is "dispatcher in, verdict out".
 */

import { describe, expect, it, vi } from 'vitest';
import type { SessionGoal } from '../../types';
import {
  __resetGoalEvalPromptCacheForTests,
  applyGoalEvalDispatchFailure,
  applyGoalEvalFailure,
  applyGoalEvalSuccess,
  buildGoalEvalUserPrompt,
  evaluateGoalCompletion,
  GoalEvalParseError,
  parseGoalEvalVerdict,
} from '../goal-completion-evaluator';

function makeGoal(overrides: Partial<SessionGoal> = {}): SessionGoal {
  return {
    objective: 'X',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    createdBy: 'U',
    continuationCount: 3,
    maxContinuations: 10,
    pendingEval: { requestedAt: 5, turnId: 'T' },
    lastEvalReason: 'previous gap',
    evalAttemptCount: 1,
    ...overrides,
  };
}

describe('parseGoalEvalVerdict', () => {
  it('parses a bare JSON object verdict (completed=true)', () => {
    const v = parseGoalEvalVerdict('{"completed": true, "reason": "all tests pass", "remaining": []}');
    expect(v).toEqual({ completed: true, reason: 'all tests pass', remaining: [] });
  });

  it('parses a bare JSON object verdict (completed=false)', () => {
    const v = parseGoalEvalVerdict(
      '{"completed": false, "reason": "PR not merged", "remaining": ["merge PR","await CI"]}',
    );
    expect(v.completed).toBe(false);
    expect(v.reason).toBe('PR not merged');
    expect(v.remaining).toEqual(['merge PR', 'await CI']);
  });

  it('parses inside a ```json fence', () => {
    const v = parseGoalEvalVerdict(
      'Sure, here is the verdict:\n```json\n{"completed":true,"reason":"ok","remaining":[]}\n```\n',
    );
    expect(v.completed).toBe(true);
  });

  it('extracts the first balanced object from surrounding prose', () => {
    const v = parseGoalEvalVerdict('blah blah {"completed":false,"reason":"x","remaining":["y"]} epilogue');
    expect(v.completed).toBe(false);
    expect(v.remaining).toEqual(['y']);
  });

  it('throws GoalEvalParseError on empty string', () => {
    expect(() => parseGoalEvalVerdict('')).toThrowError(GoalEvalParseError);
  });

  it('throws GoalEvalParseError when JSON misses required fields', () => {
    expect(() => parseGoalEvalVerdict('{"completed": true}')).toThrowError(GoalEvalParseError);
  });

  it('throws when remaining is not an array of strings', () => {
    expect(() => parseGoalEvalVerdict('{"completed":true,"reason":"ok","remaining":[1,2,3]}')).toThrowError(
      GoalEvalParseError,
    );
  });

  it('throws when completed is non-boolean', () => {
    expect(() => parseGoalEvalVerdict('{"completed":"yes","reason":"ok","remaining":[]}')).toThrowError(
      GoalEvalParseError,
    );
  });
});

describe('buildGoalEvalUserPrompt', () => {
  it('embeds objective + work summary + evaluation instruction', () => {
    const p = buildGoalEvalUserPrompt('ship the feature', 'all 20 tests pass; PR #999 merged');
    expect(p).toContain('<objective>');
    expect(p).toContain('ship the feature');
    expect(p).toContain('<work-summary>');
    expect(p).toContain('all 20 tests pass; PR #999 merged');
    expect(p).toContain('<evaluation-instruction>');
    expect(p).toContain('Emit ONLY a single JSON object');
  });
});

describe('evaluateGoalCompletion', () => {
  it('calls the dispatcher with system prompt + user prompt and returns the parsed verdict', async () => {
    __resetGoalEvalPromptCacheForTests();
    const dispatcher = vi.fn(async () => '{"completed":true,"reason":"done","remaining":[]}');
    const v = await evaluateGoalCompletion(
      { objective: 'X', workSummary: 'Y', model: 'claude-sonnet-4-5' },
      dispatcher,
    );
    expect(v.completed).toBe(true);
    expect(dispatcher).toHaveBeenCalledTimes(1);
    const arg = (dispatcher.mock.calls[0] as unknown as [unknown])[0] as {
      model: string;
      systemPrompt: string;
      userPrompt: string;
    };
    expect(arg.model).toBe('claude-sonnet-4-5');
    expect(arg.systemPrompt).toMatch(/goal completion auditor/i);
    expect(arg.userPrompt).toContain('<objective>');
  });

  it('propagates dispatcher rejections (network / timeout)', async () => {
    const dispatcher = vi.fn().mockRejectedValue(new Error('connection reset'));
    await expect(evaluateGoalCompletion({ objective: 'X', workSummary: 'Y', model: 'm' }, dispatcher)).rejects.toThrow(
      'connection reset',
    );
  });

  it('propagates parse failures as GoalEvalParseError', async () => {
    const dispatcher = vi.fn(async () => 'sorry, I cannot comply');
    await expect(
      evaluateGoalCompletion({ objective: 'X', workSummary: 'Y', model: 'm' }, dispatcher),
    ).rejects.toThrowError(GoalEvalParseError);
  });
});

describe('apply* — verdict-to-goal mutations', () => {
  it('11. applyGoalEvalSuccess flips status, stamps audit fields, clears eval state', () => {
    const goal = makeGoal();
    applyGoalEvalSuccess(goal, 'every requirement covered by tests + green CI', 1_234_000);
    expect(goal.status).toBe('complete');
    expect(goal.completedAt).toBe(1_234_000);
    expect(goal.completedBy).toBe('eval-model');
    expect(goal.completedVia).toBe('eval-model');
    expect(goal.pendingEval).toBeUndefined();
    expect(goal.lastEvalReason).toBeUndefined();
    // evalAttemptCount bumped for audit traceability.
    expect(goal.evalAttemptCount).toBe(2);
    expect(goal.updatedAt).toBe(1_234_000);
  });

  it('12. applyGoalEvalFailure keeps status active, stamps lastEvalReason, clears pendingEval', () => {
    const goal = makeGoal();
    applyGoalEvalFailure(goal, 'PR not merged; CI red', 1_234_000);
    expect(goal.status).toBe('active');
    expect(goal.pendingEval).toBeUndefined();
    expect(goal.lastEvalReason).toBe('PR not merged; CI red');
    expect(goal.evalAttemptCount).toBe(2);
    expect(goal.completedAt).toBeUndefined();
    expect(goal.completedBy).toBeUndefined();
    expect(goal.updatedAt).toBe(1_234_000);
  });

  it('13. applyGoalEvalDispatchFailure clears pendingEval but PRESERVES status + lastEvalReason', () => {
    const goal = makeGoal();
    applyGoalEvalDispatchFailure(goal, 1_234_000);
    expect(goal.status).toBe('active');
    expect(goal.pendingEval).toBeUndefined();
    // Pre-existing failure reason from a prior eval cycle must be
    // preserved — the dispatch flake is not a new verdict.
    expect(goal.lastEvalReason).toBe('previous gap');
    // Infra flake is NOT a completed eval attempt.
    expect(goal.evalAttemptCount).toBe(1);
    expect(goal.updatedAt).toBe(1_234_000);
  });

  it('14. eval false → next continuation prompt embeds the reason (chain proof)', async () => {
    // Proof that the failure path produces a usable
    // `lastEvalReason` for the next ralph-loop tick. Driven via
    // the actual buildGoalContinuationPrompt to lock the
    // contract.
    const { buildGoalContinuationPrompt } = await import('../../prompt/session-goal-block');
    const goal = makeGoal();
    applyGoalEvalFailure(goal, 'tests fail in eval suite');
    const prompt = buildGoalContinuationPrompt(goal);
    expect(prompt).toContain('Previous evaluation gap');
    expect(prompt).toContain('tests fail in eval suite');
  });
});
