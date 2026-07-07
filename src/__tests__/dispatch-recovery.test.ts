import { describe, expect, it } from 'vitest';
import {
  DISPATCH_OVERLOADED_MAX_RETRIES,
  DISPATCH_OVERLOADED_RETRY_DELAY_MS,
  decideDispatchRetry,
  isContextOverflowErrorText,
  isOverloadedErrorText,
  sleepWithAbort,
  textIndicatesPromptTooLongContent,
} from '../dispatch-recovery';
import { resolveContextWindow } from '../metrics/model-registry';

const baseState = {
  overloadedRetries: 0,
  overflowFallbackUsed: false,
  model: 'claude-opus-4-8' as string | undefined,
  aborted: false,
};

describe('isOverloadedErrorText', () => {
  it('matches the Anthropic overloaded_error JSON shape', () => {
    expect(isOverloadedErrorText('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}')).toBe(
      true,
    );
  });

  it('matches raw HTTP-status shapes', () => {
    expect(isOverloadedErrorText('API Error: 529')).toBe(true);
    expect(isOverloadedErrorText('Request failed with status 529')).toBe(true);
    expect(isOverloadedErrorText('Overloaded')).toBe(true);
  });

  it('does not match unrelated errors or embedded digits', () => {
    expect(isOverloadedErrorText('process exited with code 1')).toBe(false);
    expect(isOverloadedErrorText('ENOENT: no such file /tmp/5290/x')).toBe(false);
    expect(isOverloadedErrorText('error 1529 occurred')).toBe(false);
  });
});

describe('isContextOverflowErrorText', () => {
  it('matches the same three signals as StreamExecutor.isContextOverflowError', () => {
    expect(isContextOverflowErrorText('Prompt is too long')).toBe(true);
    expect(isContextOverflowErrorText('the context length exceeded the limit')).toBe(true);
    expect(isContextOverflowErrorText('maximum context length reached')).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isContextOverflowErrorText('overloaded')).toBe(false);
    expect(isContextOverflowErrorText('some other failure')).toBe(false);
  });
});

describe('textIndicatesPromptTooLongContent', () => {
  it('matches a short bare overflow notice (the #1200 field shape)', () => {
    expect(textIndicatesPromptTooLongContent('Prompt is too long')).toBe(true);
    expect(textIndicatesPromptTooLongContent('  Prompt is too long  ')).toBe(true);
  });

  it('never matches prose that merely discusses overflow errors', () => {
    const prose =
      'When the API returns "Prompt is too long" you should compact the session context and retry the request. ' +
      'This typically happens when a single turn pushes the conversation past the model context window budget.';
    expect(prose.length).toBeGreaterThan(160);
    expect(textIndicatesPromptTooLongContent(prose)).toBe(false);
  });

  it('rejects empty and non-string inputs', () => {
    expect(textIndicatesPromptTooLongContent('')).toBe(false);
    expect(textIndicatesPromptTooLongContent(undefined)).toBe(false);
    expect(textIndicatesPromptTooLongContent(42)).toBe(false);
  });
});

describe('decideDispatchRetry — overloaded/529', () => {
  it('waits 30s and retries on an overloaded error', () => {
    const decision = decideDispatchRetry(new Error('API Error: 529 overloaded_error'), { ...baseState });
    expect(decision).toEqual({ kind: 'overloaded-wait', delayMs: DISPATCH_OVERLOADED_RETRY_DELAY_MS });
    expect(DISPATCH_OVERLOADED_RETRY_DELAY_MS).toBe(30_000);
  });

  it('detects overloaded signals that only appear in stderrContent (issue #118 class)', () => {
    const err = Object.assign(new Error('process exited with code 1'), {
      stderrContent: '{"type":"error","error":{"type":"overloaded_error"}}',
    });
    expect(decideDispatchRetry(err, { ...baseState }).kind).toBe('overloaded-wait');
  });

  it('rethrows once the retry budget is exhausted', () => {
    const decision = decideDispatchRetry(new Error('overloaded'), {
      ...baseState,
      overloadedRetries: DISPATCH_OVERLOADED_MAX_RETRIES,
    });
    expect(decision).toEqual({ kind: 'rethrow' });
  });

  it('never retries an aborted dispatch', () => {
    const decision = decideDispatchRetry(new Error('overloaded'), { ...baseState, aborted: true });
    expect(decision).toEqual({ kind: 'rethrow' });
  });
});

describe('decideDispatchRetry — prompt too long', () => {
  it('retries once on a 1M-window fallback model when the failing model is not 1M', () => {
    const decision = decideDispatchRetry(new Error('Prompt is too long'), { ...baseState });
    expect(decision.kind).toBe('overflow-fallback');
    if (decision.kind === 'overflow-fallback') {
      expect(resolveContextWindow(decision.fallbackModel)).toBeGreaterThanOrEqual(1_000_000);
      expect(decision.fallbackModel).not.toBe(baseState.model);
    }
  });

  it('applies to the SDK-default model (undefined) too', () => {
    const decision = decideDispatchRetry(new Error('Prompt is too long'), { ...baseState, model: undefined });
    expect(decision.kind).toBe('overflow-fallback');
  });

  it('rethrows when the failing model already serves a 1M window ([1m] suffix)', () => {
    const decision = decideDispatchRetry(new Error('Prompt is too long'), {
      ...baseState,
      model: 'claude-opus-4-8[1m]',
    });
    expect(decision).toEqual({ kind: 'rethrow' });
  });

  it('rethrows when the failing model is natively 1M (fable-5)', () => {
    const decision = decideDispatchRetry(new Error('Prompt is too long'), {
      ...baseState,
      model: 'claude-fable-5',
    });
    expect(decision).toEqual({ kind: 'rethrow' });
  });

  it('rethrows when the fallback retry was already spent', () => {
    const decision = decideDispatchRetry(new Error('Prompt is too long'), {
      ...baseState,
      overflowFallbackUsed: true,
    });
    expect(decision).toEqual({ kind: 'rethrow' });
  });
});

describe('decideDispatchRetry — pass-through classes', () => {
  it('rethrows unknown errors', () => {
    expect(decideDispatchRetry(new Error('some fatal thing'), { ...baseState })).toEqual({ kind: 'rethrow' });
  });

  it('rethrows UsageLimitDispatchError even if its cap notice mentions overloaded', () => {
    const err = new Error('Claude usage limit hit during one-shot dispatch: server overloaded, resets 9pm');
    err.name = 'UsageLimitDispatchError';
    expect(decideDispatchRetry(err, { ...baseState })).toEqual({ kind: 'rethrow' });
  });

  it('rethrows non-Error values without crashing', () => {
    expect(decideDispatchRetry('string failure', { ...baseState })).toEqual({ kind: 'rethrow' });
    expect(decideDispatchRetry(undefined, { ...baseState })).toEqual({ kind: 'rethrow' });
  });
});

describe('sleepWithAbort', () => {
  it('resolves immediately when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort('pre-aborted');
    const start = Date.now();
    await sleepWithAbort(30_000, ac.signal);
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  it('resolves early when the signal aborts mid-sleep', async () => {
    const ac = new AbortController();
    const start = Date.now();
    setTimeout(() => ac.abort('goal-eval-timeout'), 20);
    await sleepWithAbort(30_000, ac.signal);
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it('completes a plain sleep without a signal', async () => {
    const start = Date.now();
    await sleepWithAbort(20);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });
});
