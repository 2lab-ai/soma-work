/**
 * Unit tests for per-session auto-handoff budget (#697).
 *
 * Trace: docs/handoff-budget/trace.md (v4) §S1 — 10 tests covering
 * `checkAndConsumeBudget` branch matrix, `formatBudgetExhaustedMessage`
 * reason branches, and `HandoffBudgetExhaustedError` class contract.
 */

import { describe, expect, it } from 'vitest';
import type { ConversationSession, HandoffContext } from '../../types';
import {
  checkAndConsumeBudget,
  DEFAULT_AUTO_HANDOFF_BUDGET,
  formatBudgetExhaustedMessage,
  HandoffBudgetExhaustedError,
} from '../handoff-budget';

function makeSession(overrides: Partial<ConversationSession> = {}): ConversationSession {
  return {
    ownerId: 'U1',
    ownerName: 'Tester',
    channelId: 'C1',
    threadTs: 't1',
    isActive: true,
    lastActivity: new Date(),
    workingDirectory: '/tmp/test',
    ...overrides,
  } as ConversationSession;
}

function makeHandoffContext(overrides: Partial<HandoffContext> = {}): HandoffContext {
  return {
    handoffKind: 'plan-to-work',
    sourceIssueUrl: null,
    parentEpicUrl: null,
    escapeEligible: false,
    tier: null,
    issueRequiredByUser: true,
    originalRequestExcerpt: null,
    repositoryPolicy: null,
    dependencyGroups: [],
    perTaskDispatchPayloads: [],
    codexReview: null,
    chainId: 'test-chain-uuid',
    hopBudget: 1,
    ...overrides,
  };
}

describe('checkAndConsumeBudget', () => {
  it('T1.1 session undefined → allowed: false, reason: no-session (fails closed)', () => {
    const result = checkAndConsumeBudget(undefined);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('no-session');
    expect(result.budgetBefore).toBe(0);
    expect(result.budgetAfter).toBe(0);
  });

  it('T1.2 session with autoHandoffBudget=undefined → allowed, decrements to 0 (pre-#697 disk state backfill)', () => {
    const session = makeSession();
    expect(session.autoHandoffBudget).toBeUndefined();
    const result = checkAndConsumeBudget(session);
    expect(result.allowed).toBe(true);
    expect(result.budgetBefore).toBe(DEFAULT_AUTO_HANDOFF_BUDGET);
    expect(result.budgetAfter).toBe(0);
    expect(session.autoHandoffBudget).toBe(0);
  });

  it('T1.3 session with autoHandoffBudget=1 → allowed, decrements to 0', () => {
    const session = makeSession({ autoHandoffBudget: 1 });
    const result = checkAndConsumeBudget(session);
    expect(result.allowed).toBe(true);
    expect(result.budgetBefore).toBe(1);
    expect(result.budgetAfter).toBe(0);
    expect(session.autoHandoffBudget).toBe(0);
  });

  it('T1.4 session with autoHandoffBudget=0 → rejected, reason: exhausted, no mutation', () => {
    const session = makeSession({ autoHandoffBudget: 0 });
    const result = checkAndConsumeBudget(session);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('exhausted');
    expect(result.budgetBefore).toBe(0);
    expect(result.budgetAfter).toBe(0);
    // No mutation on rejection.
    expect(session.autoHandoffBudget).toBe(0);
  });

  it('T1.5 session with autoHandoffBudget=-1 (defensive) → rejected, reason: exhausted, no mutation', () => {
    const session = makeSession({ autoHandoffBudget: -1 });
    const result = checkAndConsumeBudget(session);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('exhausted');
    expect(result.budgetBefore).toBe(-1);
    expect(session.autoHandoffBudget).toBe(-1);
  });

  it('T1.6 repeat call on budget=0 session returns rejected both times, no mutation', () => {
    const session = makeSession({ autoHandoffBudget: 0 });
    const first = checkAndConsumeBudget(session);
    const second = checkAndConsumeBudget(session);
    expect(first.allowed).toBe(false);
    expect(second.allowed).toBe(false);
    expect(session.autoHandoffBudget).toBe(0);
  });
});

describe('formatBudgetExhaustedMessage', () => {
  it('T1.7 reason=exhausted with handoffContext → includes workflow, chainId, budget count', () => {
    const msg = formatBudgetExhaustedMessage({
      reason: 'exhausted',
      attemptedWorkflow: 'z-plan-to-work',
      handoffContext: makeHandoffContext({ chainId: 'abc-123' }),
      budgetBefore: 0,
    });
    expect(msg).toContain('예산 초과');
    expect(msg).toContain('`z-plan-to-work`');
    expect(msg).toContain('`abc-123`');
    expect(msg).toContain('0 / 1 (exhausted)');
  });

  it('T1.8 reason=exhausted without handoffContext → chainId shows "N/A — direct session"', () => {
    const msg = formatBudgetExhaustedMessage({
      reason: 'exhausted',
      attemptedWorkflow: undefined,
      handoffContext: undefined,
      budgetBefore: 0,
    });
    expect(msg).toContain('`default`');
    expect(msg).toContain('N/A — direct session');
  });

  it('T1.9 reason=no-session → invariant-break text, not the exhausted text', () => {
    const msg = formatBudgetExhaustedMessage({
      reason: 'no-session',
      attemptedWorkflow: 'z-epic-update',
      handoffContext: undefined,
      budgetBefore: 0,
    });
    expect(msg).toContain('session 상태 불일치');
    expect(msg).toContain('invariant break');
    expect(msg).toContain('`z-epic-update`');
    // Must not contain the "예산 초과" (exhausted) header.
    expect(msg).not.toContain('예산 초과');
  });
});

describe('HandoffBudgetExhaustedError', () => {
  it('T1.10 carries reason/budgetBefore/attemptedWorkflow/chainId; name is stable; extends Error', () => {
    const err = new HandoffBudgetExhaustedError('exhausted', 0, 'z-plan-to-work', 'chain-uuid');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('HandoffBudgetExhaustedError');
    expect(err.reason).toBe('exhausted');
    expect(err.budgetBefore).toBe(0);
    expect(err.attemptedWorkflow).toBe('z-plan-to-work');
    expect(err.chainId).toBe('chain-uuid');
    expect(err.message).toContain('exhausted');
    expect(err.message).toContain('budget=0');

    // no-session reason path
    const err2 = new HandoffBudgetExhaustedError('no-session', 0, undefined, undefined);
    expect(err2.reason).toBe('no-session');
    expect(err2.attemptedWorkflow).toBeUndefined();
    expect(err2.chainId).toBeUndefined();
  });
});
