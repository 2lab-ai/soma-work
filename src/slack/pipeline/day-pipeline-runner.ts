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
  verifyAttempts: number;
}

export interface PipelineResult {
  completed: boolean;
  phasesCompleted: string[];
  haltedAt?: string;
  haltReason?: string;
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

  /**
   * Execute the full pipeline sequentially.
   * Each phase completes before the next begins.
   * Returns result with completion status.
   *
   * Trace: docs/turn-summary-lifecycle/trace.md, S10
   */
  async run(ctx: PipelineContext, executeStep: (skill: string, args?: string) => Promise<boolean>): Promise<PipelineResult> {
    const result: PipelineResult = { completed: false, phasesCompleted: [] };

    for (const phase of this.phases) {
      for (const step of phase.steps) {
        // Check conditional steps
        if (this.shouldSkipStep(step, ctx)) continue;

        // Handle parallel steps (day2 reviews)
        if (step.parallel && step.parallel.length > 0) {
          const parallelResults = await Promise.allSettled(
            step.parallel.map(s => executeStep(s.skill, s.args))
          );
          const anyFailed = parallelResults.some(r => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value));
          if (anyFailed) {
            result.haltedAt = phase.name;
            result.haltReason = `Parallel step failed in ${phase.name}`;
            return result;
          }
          continue;
        }

        // Handle verify loop
        if (step.skill === 'stv:verify') {
          let passed = false;
          ctx.verifyAttempts = 0;
          while (!passed && !this.isVerifyLoopExceeded(ctx.verifyAttempts)) {
            passed = await executeStep(step.skill, step.args);
            if (!passed) {
              ctx.verifyAttempts++;
              // Re-run do-work to fix issues
              await executeStep('stv:do-work');
            }
          }
          if (!passed) {
            result.haltedAt = phase.name;
            result.haltReason = `Verify loop exceeded max iterations (${ctx.verifyAttempts})`;
            return result;
          }
          continue;
        }

        // Normal step execution
        const success = await executeStep(step.skill, step.args);
        if (!success) {
          result.haltedAt = phase.name;
          result.haltReason = `Step ${step.skill} failed in ${phase.name}`;
          return result;
        }
      }

      result.phasesCompleted.push(phase.name);
    }

    result.completed = true;
    return result;
  }
}
