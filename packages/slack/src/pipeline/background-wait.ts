/**
 * Background-work resume guard.
 *
 * THE BUG THIS FIXES
 * ------------------
 * The continuation loop advances a session only when a turn produces a
 * `continuation` (model `CONTINUE_SESSION`, or a host renew/onboarding handoff).
 * When the model fires a background task (`Bash({run_in_background:true})`,
 * `Task({run_in_background:true})`, or a `Monitor` watch) and then ends its turn
 * — expecting to be "woken" when that work finishes — NO continuation is
 * produced, so the harness posts "🟢 작업 완료" and goes idle while the work is
 * still running. Multi-step pipelines (e.g. `autoz` build→triage→fix) die after
 * step 1 and never resume.
 *
 * THE SIGNAL (authoritative, not reconstructed)
 * ---------------------------------------------
 * `StreamExecutor` reads `ToolEventProcessor.getLiveBackgroundWork()` at turn
 * end. That signal now comes from `AgentTaskLifecycleTracker`, which is driven
 * by the SDK's authoritative `task_started` / `task_notification` system
 * messages (mapped to neutral `agent_task_lifecycle` events). A task is live
 * from `task_started` until its terminal `task_notification` — no dependence on
 * the model polling `TaskOutput`/`BashOutput`, and no spawn-ack/consumer-result
 * text parsing. This uniformly covers background bash, background subagent
 * `Task`s, and `Monitor` watches.
 *
 * If a turn would otherwise complete (no other continuation, no pending choice,
 * no error) while background work is live, we synthesize a host continuation
 * that re-enters the agent loop so the model can finish its dependent work.
 * That work did not survive the turn (#966): the CLI ends with the turn and
 * stops its background tasks, so the prompt says so, and the caller settles the
 * dead tasks in the tracker (`endBackgroundWorkWithTurn`).
 *
 * RUNAWAY GUARD (non-destructive)
 * -------------------------------
 * A host continuation skips the handoff budget, so we cap consecutive
 * background-wait continuations per session (`getBackgroundWaitCap()`, default
 * 6). On cap exhaustion we do NOT drain the authoritative tracker (that would
 * falsify real state); instead we record the live-set SIGNATURE we gave up on
 * and stop auto-resuming for exactly that set. The guard re-arms automatically
 * when the live set changes (a task settles or a new one starts → new
 * signature). The counter resets whenever a turn ends with zero live work.
 *
 * This module is a PURE decision function so the policy is unit-testable in
 * isolation from the (very heavy) `StreamExecutor.execute` path.
 */

/** Default number of consecutive background-wait continuations per session. */
export const DEFAULT_BACKGROUND_WAIT_MAX_CONTINUATIONS = 6;

/**
 * Resolve the per-session cap from `BACKGROUND_WAIT_MAX_CONTINUATIONS`.
 * Falls back to {@link DEFAULT_BACKGROUND_WAIT_MAX_CONTINUATIONS} for unset,
 * non-numeric, or non-positive values (fail-safe to a sane bound).
 */
export function getBackgroundWaitCap(): number {
  const raw = process.env.BACKGROUND_WAIT_MAX_CONTINUATIONS;
  if (!raw) return DEFAULT_BACKGROUND_WAIT_MAX_CONTINUATIONS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BACKGROUND_WAIT_MAX_CONTINUATIONS;
}

/**
 * Snapshot of background work still live at turn end. Unified across bash /
 * subagent Task / Monitor — the authoritative tracker keys everything by SDK
 * `task_id` and does not distinguish the launch tool.
 */
export interface LiveBackgroundWork {
  /** Number of background tasks still running (started, not yet settled). */
  count: number;
  /** Optional human labels (e.g. task types) for the resume-prompt summary. */
  labels: string[];
  /** Stable signature of the live set (sorted task_ids) for cap suppression. */
  signature: string;
  /** The tasks themselves, for the resume prompt to name (#966). */
  tasks?: Array<{ taskId: string; taskType?: string; outputFile?: string; description?: string }>;
}

/** At most this many stopped tasks are named in the resume prompt. */
const PROMPT_TASKS_MAX = 8;

/** Minimal host continuation shape (matches `somalib` `Continuation`). */
export interface HostContinuation {
  prompt: string;
  origin: 'host';
}

export interface BackgroundWaitDecisionInput {
  /** Live background work observed at turn end (before cleanup drains it). */
  live: LiveBackgroundWork;
  /** Background-wait continuations already emitted for this session. */
  priorWaitCount: number;
  /** Per-session cap (see {@link getBackgroundWaitCap}). */
  cap: number;
  /**
   * Live-set signature we already gave up auto-resuming on (cap was hit for
   * this exact set). Used for NON-destructive suppression: while the live set
   * is unchanged we neither resume nor re-warn.
   */
  suppressedSignature?: string;
  /** Turn is waiting on a user choice — never resume over a pending choice. */
  hasPendingChoice: boolean;
  /** Turn ended in an SDK/result error — do not resume a failed turn. */
  hasError: boolean;
  /**
   * A model/host continuation already won this turn (CONTINUE_SESSION, renew,
   * onboarding). Never override a real continuation with a background-wait.
   */
  hasOtherContinuation: boolean;
}

export type BackgroundWaitDecision =
  /** Resume the session with a host continuation; persist `nextWaitCount`. */
  | { action: 'continue'; continuation: HostContinuation; nextWaitCount: number }
  /** No live background work — clear the per-session counter, complete normally. */
  | { action: 'reset' }
  /**
   * Live work but the cap is exhausted — warn once, record `suppressSignature`
   * (NON-destructively), complete. Do NOT drain the authoritative tracker.
   */
  | { action: 'cap-exceeded'; suppressSignature: string }
  /**
   * Guard not applicable: pending choice / error / another continuation won, OR
   * the live set is the already-suppressed one (give-up already happened).
   */
  | { action: 'none' };

/**
 * Render the host prompt that re-enters the agent loop.
 *
 * #966 — the tasks are NOT running any more. This host ends the CLI process
 * with the turn (it closes the input at the turn's end; only live background
 * agents hold a turn open, #257), and the CLI stops its background tasks as it
 * exits (dev 2026-11-05: `bkzs8pdz1 killed` 06:42:17Z, `baxddqx0i stopped`
 * 08:50Z). The prompt used to say the runtime keeps them alive "until it
 * settles", so the model ended its turn again waiting for a report that never
 * came. It now says what happened and how to pick each one up in this turn.
 */
export function buildBackgroundWaitPrompt(live: LiveBackgroundWork, attempt: number, cap: number): string {
  const noun = live.count === 1 ? 'background task' : 'background tasks';
  const labelSuffix = live.labels.length > 0 ? ` (${live.labels.join(', ')})` : '';
  const verb = live.count === 1 ? 'was' : 'were';
  const pronoun = live.count === 1 ? 'it' : 'they';
  const tasks = (live.tasks ?? []).slice(0, PROMPT_TASKS_MAX).map((t) => {
    const type = t.taskType ? ` (${t.taskType})` : '';
    // Model-written: one line, no quotes or backticks, clipped.
    const flat = t.description
      ?.replace(/[\r\n\t]+/g, ' ')
      .replace(/[`"]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const what = flat ? ` ${flat.length > 80 ? `${flat.slice(0, 79)}…` : flat}` : '';
    const out = t.outputFile ? ` — output file: ${t.outputFile}` : '';
    return `- ${t.taskId}${type}${what}${out}`;
  });
  const more =
    (live.tasks?.length ?? 0) > PROMPT_TASKS_MAX
      ? [`- … and ${(live.tasks?.length ?? 0) - PROMPT_TASKS_MAX} more`]
      : [];
  return [
    `[background-work-resume ${attempt}/${cap}]`,
    `You ended your turn while ${live.count} ${noun}${labelSuffix} ${verb} running. In this host a turn's CLI process ends with the turn, so ${pronoun} ${verb} stopped with it and will not report back — no completion notification will come.`,
    ...tasks,
    ...more,
    `Do NOT stop. Pick up what you still need in THIS turn: rerun a stopped command in the foreground, or start it in the background and wait for it before you end the turn (a bounded loop that checks whether it finished). SendMessage to a stopped subagent's agent ID resumes it from its transcript. An output file may hold what a task printed before it stopped.`,
    `Only finish once your task is genuinely done, or emit CONTINUE_SESSION to hand off to the next phase.`,
    `If a stopped process was only meant to run while you worked (a dev server, a watcher) and nothing depends on it, it is fine to finish now.`,
  ].join('\n');
}

/**
 * Pure policy: given the live background snapshot and turn state, decide
 * whether to resume the session, reset the counter, suppress on cap, or do
 * nothing. See module docstring for rationale.
 */
export function decideBackgroundWaitContinuation(input: BackgroundWaitDecisionInput): BackgroundWaitDecision {
  const { live, priorWaitCount, cap, suppressedSignature, hasPendingChoice, hasError, hasOtherContinuation } = input;

  // Never resume over a real continuation, a pending user choice, or an error
  // turn — those have their own, correct terminal handling.
  if (hasOtherContinuation || hasPendingChoice || hasError) return { action: 'none' };

  // Turn ended cleanly with nothing backgrounded → clear the counter and let
  // the session complete. Natural reset for a chain that finally drained.
  if (live.count === 0) return { action: 'reset' };

  // We already gave up auto-resuming on this EXACT live set; while it is
  // unchanged, complete quietly (no re-resume, no repeated warning). A change
  // in the live set yields a different signature and re-arms the guard.
  if (suppressedSignature && live.signature === suppressedSignature) return { action: 'none' };

  // Live work but we have already waited `cap` times for this set — stop
  // auto-waiting. Non-destructive: caller records the signature, does not drain.
  if (priorWaitCount >= cap) return { action: 'cap-exceeded', suppressSignature: live.signature };

  const attempt = priorWaitCount + 1;
  return {
    action: 'continue',
    continuation: { origin: 'host', prompt: buildBackgroundWaitPrompt(live, attempt, cap) },
    nextWaitCount: attempt,
  };
}
