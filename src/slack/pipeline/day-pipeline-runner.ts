import { Logger } from '../../logger.js';

const logger = new Logger('DayPipelineRunner');

export interface PipelineStep {
  skill: string;
  args?: string;
  condition?: (ctx: PipelineContext) => boolean;
  parallel?: PipelineStep[];
}

export interface DayPhase {
  name: string;
  steps: PipelineStep[];
}

export interface PipelineContext {
  hasIssue: boolean;
  hasPR: boolean;
  isBug: boolean;
  verifyPassCount: number;
}

const MAX_VERIFY_ITERATIONS = 5;

/**
 * Orchestrates sequential day0→day1→day2 pipeline execution.
 * Trace: docs/turn-summary-lifecycle/trace.md, S10
 */
export class DayPipelineRunner {
  private phases: DayPhase[] = [
    {
      name: 'day0',
      steps: [
        { skill: 'stv:debug', condition: (ctx) => ctx.isBug },
        { skill: 'stv:new-task', args: 'bug jira ticket', condition: (ctx) => ctx.isBug },
      ],
    },
    {
      name: 'day1',
      steps: [
        { skill: 'stv:new-task', condition: (ctx) => !ctx.hasIssue },
        { skill: 'stv:do-work' },
        { skill: 'stv:verify' },
      ],
    },
    {
      name: 'day2',
      steps: [
        { skill: 'stv:verify' },
        {
          skill: 'llm-review',
          parallel: [
            { skill: 'llm_chat', args: 'model: codex — code review' },
            { skill: 'llm_chat', args: 'model: codex — test coverage review' },
            { skill: 'llm_chat', args: 'model: gemini — code review' },
            { skill: 'llm_chat', args: 'model: gemini — test coverage review' },
          ],
        },
      ],
    },
  ];

  getPhases(): DayPhase[] {
    return this.phases;
  }

  shouldSkipStep(step: PipelineStep, ctx: PipelineContext): boolean {
    if (!step.condition) return false;
    return !step.condition(ctx);
  }

  isVerifyLoopExceeded(iterations: number): boolean {
    return iterations >= MAX_VERIFY_ITERATIONS;
  }

  static get MAX_VERIFY_ITERATIONS(): number {
    return MAX_VERIFY_ITERATIONS;
  }
}
