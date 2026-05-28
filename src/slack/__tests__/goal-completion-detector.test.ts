/**
 * Tests for the goal-completion sentinel detector. Two paths:
 *
 *   1. Explicit `<goal-complete-request reason="..."/>` sentinel — the
 *      contract surface.
 *   2. Natural-language safety net for cases where the model forgets
 *      the sentinel but unambiguously asserts completion.
 *
 * Covers Test-Matrix #10, #19 from `goal-redo-prompt.md`.
 */

import { describe, expect, it } from 'vitest';
import { detectGoalCompletionSignal } from '../goal-completion-detector';

describe('goal-completion-detector / sentinel path', () => {
  it('returns undefined when no signal is present', () => {
    expect(detectGoalCompletionSignal('working on it, more to do')).toBeUndefined();
    expect(detectGoalCompletionSignal('')).toBeUndefined();
    expect(detectGoalCompletionSignal('the goal is to ship the feature')).toBeUndefined();
  });

  it('matches the canonical sentinel and extracts the reason', () => {
    const signal = detectGoalCompletionSignal(
      'Some prose.\n<goal-complete-request reason="all 20 tests pass and PR merged"/>\nMore prose.',
    );
    expect(signal).toBeDefined();
    expect(signal?.via).toBe('sentinel');
    expect(signal?.reason).toBe('all 20 tests pass and PR merged');
  });

  it('matches sentinel with reason omitted (returns placeholder string)', () => {
    const signal = detectGoalCompletionSignal('done.\n<goal-complete-request />');
    expect(signal?.via).toBe('sentinel');
    expect(signal?.reason).toMatch(/sentinel-emitted/);
  });

  it('matches sentinel with extra attributes', () => {
    const signal = detectGoalCompletionSignal('<goal-complete-request priority="high" reason="x"/>');
    expect(signal?.via).toBe('sentinel');
    expect(signal?.reason).toBe('x');
  });
});

describe('goal-completion-detector / natural-language safety net', () => {
  it('matches "the goal appears complete"', () => {
    const signal = detectGoalCompletionSignal(
      'After running the suite, the goal appears complete. Awaiting your call.',
    );
    expect(signal?.via).toBe('natural-language');
    expect(signal?.reason).toContain('appears complete');
  });

  it('matches "the objective is achieved"', () => {
    const signal = detectGoalCompletionSignal('I believe the objective is achieved.');
    expect(signal?.via).toBe('natural-language');
  });

  it('matches "the goal has been fully achieved"', () => {
    const signal = detectGoalCompletionSignal('At this point the goal has been fully achieved.');
    expect(signal?.via).toBe('natural-language');
  });

  it('does NOT trigger on descriptive "the goal is to X"', () => {
    expect(detectGoalCompletionSignal('the goal is to ship the feature next sprint')).toBeUndefined();
  });

  it('does NOT trigger on "I need to make the goal complete"', () => {
    // The phrase has "the goal" and "complete" but is forward-looking,
    // not a completion assertion. The narrow patterns must reject it.
    expect(detectGoalCompletionSignal('I need to make the goal complete by Friday')).toBeUndefined();
  });

  it('sentinel takes priority over natural-language', () => {
    const text = 'the goal is now complete and additionally <goal-complete-request reason="sentinel wins"/>';
    const signal = detectGoalCompletionSignal(text);
    expect(signal?.via).toBe('sentinel');
    expect(signal?.reason).toBe('sentinel wins');
  });
});
