/**
 * Host-side goal completion evaluator.
 *
 * The work model is not allowed to flip `session.goal.status` to
 * `complete` on its own — codex enforces this via the `update_goal`
 * tool which only the runtime can honor, and soma-work has no
 * comparable tool surface. Instead, at every turn end while a goal is
 * active the host forks a clean-context dispatch to the same
 * model+effort and asks for a strict JSON verdict on whether the
 * objective is actually met. Only `completed: true` from the evaluator
 * flips the goal status; `completed: false` drives the next
 * continuation turn.
 *
 * See `docs/goal-command/spec.md` §Completion via Host-Side Eval
 * Model.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Logger } from '../logger';
import type { EffortLevel } from '../user-settings-store';

const logger = new Logger('GoalEval');

/** Strict shape the eval model must emit (single JSON object). */
export interface GoalEvalVerdict {
  completed: boolean;
  reason: string;
  remaining: string[];
}

export interface GoalEvalCallInput {
  objective: string;
  /** Pre-concatenated assistant turn outputs / tool-call summaries / worktree status. */
  workSummary: string;
  /** Model identifier passed straight to the SDK. Must match the work model. */
  model: string;
  /** Reasoning effort passed straight to the SDK. Must match the work model. */
  effort?: EffortLevel;
  /** Optional abort signal so callers can bound the eval. */
  abortController?: AbortController;
  /** Optional cwd override for the SDK process. */
  cwd?: string;
}

/**
 * Pluggable transport so unit tests can drive the evaluator without
 * standing up the real Claude SDK. The production wiring (see
 * `index.ts`) maps this to `ClaudeHandler.dispatchOneShot`.
 */
export type GoalEvalDispatcher = (params: {
  systemPrompt: string;
  userPrompt: string;
  model: string;
  effort?: EffortLevel;
  abortController?: AbortController;
  cwd?: string;
}) => Promise<string>;

/** Load the eval system prompt from disk (kept in `src/prompt/`). */
let cachedSystemPrompt: string | null = null;
export function loadGoalEvalSystemPrompt(): string {
  if (cachedSystemPrompt !== null) return cachedSystemPrompt;
  // Resolve relative to this compiled file. In dev (tsx) `__dirname`
  // points at src/slack; in prod the file is copied into dist/prompt
  // by the build script (see package.json `build` line `cp -r
  // src/prompt dist/`).
  const candidates = [
    path.join(__dirname, '..', 'prompt', 'goal-eval.prompt'),
    path.join(__dirname, '..', '..', 'src', 'prompt', 'goal-eval.prompt'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      cachedSystemPrompt = fs.readFileSync(p, 'utf-8');
      return cachedSystemPrompt;
    }
  }
  throw new Error(`goal-eval.prompt not found in any of: ${candidates.join(', ')}`);
}

/** Test-only cache reset so suites can swap the on-disk prompt. */
export function __resetGoalEvalPromptCacheForTests(): void {
  cachedSystemPrompt = null;
}

export function buildGoalEvalUserPrompt(objective: string, workSummary: string): string {
  return [
    '<objective>',
    objective,
    '</objective>',
    '',
    '<work-summary>',
    workSummary,
    '</work-summary>',
    '',
    '<evaluation-instruction>',
    'For every requirement derivable from the objective, decide whether the work-summary contains direct evidence proving completion.',
    'If evidence is indirect, missing, or weak for any requirement, set completed=false.',
    'Reason must name the specific gap (or the strongest proof when completed=true) in one short paragraph.',
    'Remaining must list the concrete next-step items the work model should close before claiming completion again. Empty array when completed=true.',
    'Emit ONLY a single JSON object: {"completed": boolean, "reason": string, "remaining": string[]}',
    '</evaluation-instruction>',
  ].join('\n');
}

/**
 * Best-effort JSON extractor. The eval system prompt mandates a bare
 * JSON object, but models occasionally wrap output in markdown
 * fences or prose. We try, in order:
 *
 *   1. JSON.parse on the trimmed text.
 *   2. Strip a single ```json … ``` fence.
 *   3. Match the first balanced `{ … }` block from the start.
 *
 * Throws a typed error on failure so callers can surface a
 * predictable `eval failed` outcome instead of crashing the loop.
 */
export class GoalEvalParseError extends Error {
  constructor(
    message: string,
    public readonly raw: string,
  ) {
    super(message);
    this.name = 'GoalEvalParseError';
  }
}

export function parseGoalEvalVerdict(raw: string): GoalEvalVerdict {
  if (!raw || !raw.trim()) {
    throw new GoalEvalParseError('Empty eval response', raw);
  }
  const trimmed = raw.trim();

  const attempts: string[] = [];
  attempts.push(trimmed);

  // Strip ```json … ``` fence if present.
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (fenceMatch?.[1]) attempts.push(fenceMatch[1].trim());

  // First balanced top-level object.
  const braceMatch = trimmed.match(/\{[\s\S]*\}/);
  if (braceMatch?.[0] && !attempts.includes(braceMatch[0])) attempts.push(braceMatch[0]);

  let lastErr: unknown;
  for (const candidate of attempts) {
    try {
      const parsed = JSON.parse(candidate);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof parsed.completed === 'boolean' &&
        typeof parsed.reason === 'string' &&
        Array.isArray(parsed.remaining) &&
        parsed.remaining.every((r: unknown) => typeof r === 'string')
      ) {
        return {
          completed: parsed.completed,
          reason: parsed.reason,
          remaining: parsed.remaining,
        };
      }
      lastErr = new GoalEvalParseError('Eval response missing required fields or wrong types', candidate);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof GoalEvalParseError
    ? lastErr
    : new GoalEvalParseError(`Eval response not parseable as JSON: ${(lastErr as Error)?.message}`, raw);
}

/**
 * Run a full eval cycle. Returns the parsed verdict or throws —
 * callers translate exceptions into `pendingEval` cleanup + a host
 * notice ("eval failed — manual `goal done` or `goal blocked`
 * required").
 */
export async function evaluateGoalCompletion(
  input: GoalEvalCallInput,
  dispatcher: GoalEvalDispatcher,
): Promise<GoalEvalVerdict> {
  const systemPrompt = loadGoalEvalSystemPrompt();
  const userPrompt = buildGoalEvalUserPrompt(input.objective, input.workSummary);

  logger.info('Running goal completion eval', {
    model: input.model,
    effort: input.effort,
    objectiveChars: input.objective.length,
    summaryChars: input.workSummary.length,
  });

  const raw = await dispatcher({
    systemPrompt,
    userPrompt,
    model: input.model,
    effort: input.effort,
    abortController: input.abortController,
    cwd: input.cwd,
  });

  const verdict = parseGoalEvalVerdict(raw);
  logger.info('Goal eval verdict', {
    completed: verdict.completed,
    reasonPreview: verdict.reason.slice(0, 120),
    remainingCount: verdict.remaining.length,
  });
  return verdict;
}

/**
 * Apply an eval verdict (success path) to a `SessionGoal`. Pure
 * mutation — caller persists. Spec H.3 `completed === true` branch.
 *
 * Sets status=`complete`, audit fields (`completedAt`, `completedBy`,
 * `completedVia`), clears all eval state, and bumps the
 * `evalAttemptCount` for audit traceability.
 */
export function applyGoalEvalSuccess(goal: import('../types').SessionGoal, now: number = Date.now()): void {
  // `completedVia: 'eval-model'` is the discriminator; `completedBy`
  // stays undefined on this path so it can keep meaning "the Slack
  // userId who closed the goal" for `goal done`. The eval reason is
  // surfaced in the Slack notice by the orchestrator — pinning it
  // on the goal would re-inject the approval text if the goal were
  // ever re-opened.
  goal.status = 'complete';
  goal.completedAt = now;
  goal.completedBy = undefined;
  goal.completedVia = 'eval-model';
  goal.pendingEval = undefined;
  goal.lastEvalReason = undefined;
  goal.evalAttemptCount = (goal.evalAttemptCount ?? 0) + 1;
  goal.updatedAt = now;
}

/**
 * Apply an eval verdict (failure path). Spec H.3 `completed === false`
 * branch — status stays `active`, the reason becomes the next
 * continuation's `lastEvalReason`, and the ralph loop resumes on
 * the next idle.
 */
export function applyGoalEvalFailure(
  goal: import('../types').SessionGoal,
  reason: string,
  now: number = Date.now(),
): void {
  goal.pendingEval = undefined;
  goal.lastEvalReason = reason;
  goal.evalAttemptCount = (goal.evalAttemptCount ?? 0) + 1;
  goal.updatedAt = now;
}

/**
 * Apply an eval failure (dispatcher / parse error). Spec H.3
 * `호출 실패 / 타임아웃 / JSON 파싱 실패` branch — clears
 * `pendingEval` so the ralph loop can resume, but does NOT mutate
 * status (the host operator must intervene with `goal done` /
 * `goal blocked`).
 */
export function applyGoalEvalDispatchFailure(goal: import('../types').SessionGoal, now: number = Date.now()): void {
  goal.pendingEval = undefined;
  goal.updatedAt = now;
  // Intentionally NOT bumping evalAttemptCount — that counter
  // tracks completed eval cycles, not infrastructure flakes.
}
