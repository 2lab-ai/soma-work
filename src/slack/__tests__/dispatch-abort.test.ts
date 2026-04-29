/**
 * Unit tests for safe-stop on dispatch failure (#698).
 *
 * Trace: docs/dispatch-safe-stop/trace.md (v3) §S1 — 6 tests covering
 * DispatchAbortError construction + formatDispatchAbortMessage branch matrix.
 */

import { describe, expect, it } from 'vitest';
import type { HandoffContext } from '../../types';
import { DispatchAbortError, formatDispatchAbortMessage } from '../dispatch-abort';

function makeHandoffContext(overrides: Partial<HandoffContext> = {}): HandoffContext {
  return {
    handoffKind: 'plan-to-work',
    sourceIssueUrl: 'https://github.com/owner/repo/issues/42',
    parentEpicUrl: 'https://github.com/owner/repo/issues/10',
    escapeEligible: false,
    tier: 'medium',
    issueRequiredByUser: true,
    originalRequestExcerpt: null,
    repositoryPolicy: null,
    dependencyGroups: [['t1']],
    perTaskDispatchPayloads: [{ taskId: 't1', prompt: 'do t1' }],
    codexReview: null,
    chainId: 'test-chain-uuid',
    hopBudget: 1,
    ...overrides,
  };
}

describe('DispatchAbortError', () => {
  it('T1.1 carries reason/detail/workflow/elapsedMs/handoffContext; name stable; extends Error', () => {
    const ctx = makeHandoffContext();
    const err = new DispatchAbortError('classifier-failed', 'LLM timeout', 'z-plan-to-work', 1234, ctx);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('DispatchAbortError');
    expect(err.reason).toBe('classifier-failed');
    expect(err.detail).toBe('LLM timeout');
    expect(err.workflow).toBe('z-plan-to-work');
    expect(err.elapsedMs).toBe(1234);
    expect(err.handoffContext).toBe(ctx);
  });

  it('T1.2 message includes reason + workflow + detail', () => {
    const err = new DispatchAbortError('wait-timeout', 'timeout after 30s', undefined, 30000, undefined);
    expect(err.message).toContain('wait-timeout');
    expect(err.message).toContain('classifier'); // workflow=undefined → "classifier" label
    expect(err.message).toContain('timeout after 30s');
  });
});

describe('formatDispatchAbortMessage', () => {
  it('T1.3 reason=classifier-failed with handoffContext → includes sourceIssueUrl + chainId + parentEpicUrl', () => {
    const msg = formatDispatchAbortMessage({
      reason: 'classifier-failed',
      workflow: undefined,
      detail: 'LLM 500',
      elapsedMs: 1500,
      handoffContext: makeHandoffContext({
        sourceIssueUrl: 'https://github.com/owner/repo/issues/99',
        parentEpicUrl: 'https://github.com/owner/repo/issues/50',
        chainId: 'abc-def-123',
      }),
    });
    expect(msg).toContain('Dispatch 실패 — safe-stop');
    expect(msg).toContain('classifier-failed');
    expect(msg).toContain('LLM 500');
    expect(msg).toContain('https://github.com/owner/repo/issues/99');
    expect(msg).toContain('https://github.com/owner/repo/issues/50');
    expect(msg).toContain('abc-def-123');
    expect(msg).toContain('1500ms');
  });

  it('T1.4 reason=wait-timeout without handoffContext → Chain shows "N/A — direct session"; Issue shows "N/A"', () => {
    const msg = formatDispatchAbortMessage({
      reason: 'wait-timeout',
      workflow: undefined,
      detail: 'Dispatch wait timeout',
      elapsedMs: 30000,
      handoffContext: undefined,
    });
    expect(msg).toContain('wait-timeout');
    expect(msg).toContain('N/A — direct session');
    expect(msg).toContain('Issue: N/A');
    expect(msg).toContain('Epic: N/A');
    // classifier label used when workflow is undefined
    expect(msg).toContain('`classifier`');
  });

  it('T1.5 reason=transition-failed with workflow="deploy" → workflow label is "deploy" not "classifier"', () => {
    const msg = formatDispatchAbortMessage({
      reason: 'transition-failed',
      workflow: 'deploy',
      detail: 'session already transitioned',
      elapsedMs: undefined,
      handoffContext: undefined,
    });
    expect(msg).toContain('transition-failed');
    expect(msg).toContain('`deploy`');
    expect(msg).not.toContain('`classifier`');
  });

  it('T1.6 elapsedMs undefined → "Elapsed: unknown"', () => {
    const msg = formatDispatchAbortMessage({
      reason: 'transition-failed',
      workflow: 'pr-review',
      detail: 'failed',
      elapsedMs: undefined,
      handoffContext: undefined,
    });
    expect(msg).toContain('Elapsed: unknown');
  });
});
