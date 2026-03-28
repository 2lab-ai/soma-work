import { describe, it, expect } from 'vitest';
import { DayPipelineHandler } from '../commands/day-pipeline-handler';
import { DayPipelineRunner } from './day-pipeline-runner';

// Trace: docs/turn-summary-lifecycle/trace.md

describe('DayPipelineHandler', () => {
  const handler = new DayPipelineHandler();

  // Trace: S10, Section 3a
  it('canHandle() matches "autowork"', () => {
    expect(handler.canHandle('autowork')).toBe(true);
  });

  it('canHandle() matches "/autowork"', () => {
    expect(handler.canHandle('/autowork')).toBe(true);
  });

  it('canHandle() matches case-insensitively', () => {
    expect(handler.canHandle('AUTOWORK')).toBe(true);
    expect(handler.canHandle('/Autowork')).toBe(true);
  });

  it('canHandle() does NOT match "autowork something"', () => {
    expect(handler.canHandle('autowork something')).toBe(false);
  });

  it('canHandle() does NOT match unrelated commands', () => {
    expect(handler.canHandle('help')).toBe(false);
    expect(handler.canHandle('/do-work')).toBe(false);
  });

  it('execute() returns handled with continueWithPrompt', async () => {
    const ctx = {
      user: 'U123',
      channel: 'C123',
      threadTs: '123.456',
      text: 'autowork',
      say: async () => ({}),
    };
    const result = await handler.execute(ctx);
    expect(result.handled).toBe(true);
    expect(result.continueWithPrompt).toBeDefined();
    expect(result.continueWithPrompt).toContain('Phase day0');
    expect(result.continueWithPrompt).toContain('Phase day1');
    expect(result.continueWithPrompt).toContain('Phase day2');
  });
});

describe('DayPipelineRunner', () => {
  const runner = new DayPipelineRunner();

  // Trace: S10, Section 3b
  it('has 3 phases (day0, day1, day2)', () => {
    const phases = runner.getPhases();
    expect(phases).toHaveLength(3);
    expect(phases.map((p) => p.name)).toEqual(['day0', 'day1', 'day2']);
  });

  // Trace: S10, Section 3d Step 1
  it('day1 skips new-task if hasIssue is true', () => {
    const phases = runner.getPhases();
    const day1 = phases.find((p) => p.name === 'day1')!;
    const newTaskStep = day1.steps.find((s) => s.skill === 'stv:new-task')!;

    const ctxWithIssue = { hasIssue: true, hasPR: false, isBug: false, verifyPassCount: 0 };
    expect(runner.shouldSkipStep(newTaskStep, ctxWithIssue)).toBe(true);

    const ctxWithoutIssue = { hasIssue: false, hasPR: false, isBug: false, verifyPassCount: 0 };
    expect(runner.shouldSkipStep(newTaskStep, ctxWithoutIssue)).toBe(false);
  });

  // Trace: S10, Section 3d Step 4
  it('verify loop halts after 5 max iterations', () => {
    expect(runner.isVerifyLoopExceeded(4)).toBe(false);
    expect(runner.isVerifyLoopExceeded(5)).toBe(true);
    expect(runner.isVerifyLoopExceeded(6)).toBe(true);
    expect(DayPipelineRunner.MAX_VERIFY_ITERATIONS).toBe(5);
  });

  // Trace: S10, Section 3c
  it('day0 steps are conditional on isBug', () => {
    const phases = runner.getPhases();
    const day0 = phases.find((p) => p.name === 'day0')!;

    const bugCtx = { hasIssue: false, hasPR: false, isBug: true, verifyPassCount: 0 };
    const noBugCtx = { hasIssue: false, hasPR: false, isBug: false, verifyPassCount: 0 };

    for (const step of day0.steps) {
      expect(runner.shouldSkipStep(step, bugCtx)).toBe(false);
      expect(runner.shouldSkipStep(step, noBugCtx)).toBe(true);
    }
  });

  // Trace: S10, Section 3e Step 4
  it('day2 has parallel review steps (4 total)', () => {
    const phases = runner.getPhases();
    const day2 = phases.find((p) => p.name === 'day2')!;
    const reviewStep = day2.steps.find((s) => s.parallel !== undefined)!;

    expect(reviewStep).toBeDefined();
    expect(reviewStep.parallel).toHaveLength(4);
    expect(reviewStep.parallel!.map((s) => s.skill)).toEqual([
      'llm_chat',
      'llm_chat',
      'llm_chat',
      'llm_chat',
    ]);
  });

  it('unconditional steps are not skipped', () => {
    const phases = runner.getPhases();
    const day1 = phases.find((p) => p.name === 'day1')!;
    const doWorkStep = day1.steps.find((s) => s.skill === 'stv:do-work')!;

    const ctx = { hasIssue: false, hasPR: false, isBug: false, verifyPassCount: 0 };
    expect(runner.shouldSkipStep(doWorkStep, ctx)).toBe(false);
  });
});
