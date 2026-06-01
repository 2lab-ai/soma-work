/**
 * Background-work resume guard (issue: harness drops sessions with live
 * background work).
 *
 * THE BUG THIS FIXES
 * ------------------
 * The continuation loop (`v1-query-adapter.ts`) advances a session only when
 * the turn produces a `continuation` (a model-emitted `CONTINUE_SESSION` or a
 * host-built renew/onboarding handoff). When the model fires a background bash
 * (`Bash({run_in_background:true})`) or a background subagent
 * (`Task({run_in_background:true})`) and then ends its turn — expecting to be
 * "woken" when that work finishes — NO continuation is produced. The harness
 * therefore posts "🟢 작업 완료" and goes idle while the work is still running.
 * Multi-step pipelines (e.g. `autoz` build→triage→fix) die after step 1 and
 * never resume.
 *
 * THE FIX
 * -------
 * `StreamExecutor` already owns `ToolEventProcessor`, whose
 * `BackgroundBashRegistry` / `BackgroundTaskRegistry` track exactly the
 * background entries that are STILL LIVE at turn end (an entry is removed when
 * its `tool_result` arrives; whatever remains at turn end is still running).
 * If a turn would otherwise complete (no other continuation, no pending user
 * choice, no error) while background work is live, we synthesize a host
 * continuation that re-enters the agent loop and instructs the model to block
 * on the background work and continue. This reuses the existing, tested
 * continuation machinery (same path as renew/onboarding).
 *
 * RUNAWAY GUARD
 * -------------
 * A host continuation skips the handoff budget, so an unbounded re-emit could
 * loop forever if the model keeps backgrounding without ever draining. We cap
 * the number of consecutive background-wait continuations per session
 * (`getBackgroundWaitCap()`, default 6, overridable via
 * `BACKGROUND_WAIT_MAX_CONTINUATIONS`). The counter resets whenever a turn
 * ends with zero live background work. On cap exhaustion we stop auto-waiting,
 * warn the user, and complete normally.
 *
 * This module is a PURE decision function so the policy is unit-testable in
 * isolation from the (very heavy) `StreamExecutor.execute` path.
 *
 * KNOWN LIMITATIONS
 * -----------------
 * - The intermediate "🟢 작업 완료" card is still posted on a resume turn (the
 *   notify rail runs before the guard). This matches every other intermediate
 *   continuation turn today (renew, model CONTINUE_SESSION handoffs); the guard
 *   restores the missing *resume*, not the card label. Making the label honest
 *   is a separate change (TurnCategory union + completion-message-tracker copy).
 * - Background bash is sessionKey-scoped so it survives across resume turns;
 *   background `Task`s are turnId-scoped (#794), so a Task still running after a
 *   full resume turn drops out of the next turn's live snapshot and the chain
 *   may end early for tasks. Bash (the long-build case) is fully covered.
 * - If the model disobeys the "block until done" instruction and polls-then-
 *   ends without re-backgrounding, the next turn's snapshot is empty and the
 *   session completes. The prompt steers hard toward blocking (the SDK pattern).
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

/** Snapshot of background work still live at turn end. */
export interface LiveBackgroundWork {
  /** Count of `Bash({run_in_background:true})` commands still running. */
  bashCount: number;
  /** Labels of `Task({run_in_background:true})` subagents still running. */
  taskLabels: string[];
}

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
  /** Live background work but the cap is exhausted — warn, clear counter, complete. */
  | { action: 'cap-exceeded' }
  /** Guard not applicable (pending choice / error / another continuation won). */
  | { action: 'none' };

/**
 * Render the host prompt that re-enters the agent loop and tells the model to
 * block on its live background work and continue. Numbered `attempt/cap` so
 * the model (and logs) can see the wait depth.
 */
export function buildBackgroundWaitPrompt(live: LiveBackgroundWork, attempt: number, cap: number): string {
  const parts: string[] = [];
  if (live.bashCount > 0) {
    parts.push(`${live.bashCount} background shell command${live.bashCount === 1 ? '' : 's'}`);
  }
  if (live.taskLabels.length > 0) {
    parts.push(
      `${live.taskLabels.length} background subagent task${live.taskLabels.length === 1 ? '' : 's'} (${live.taskLabels.join(', ')})`,
    );
  }
  const summary = parts.join(' and ');
  return [
    `[background-work-resume ${attempt}/${cap}]`,
    `You ended your turn while ${summary} ${live.bashCount + live.taskLabels.length === 1 ? 'was' : 'were'} still running, so the session was about to be marked complete with the work unfinished.`,
    `Do NOT stop. Block on the background work now — use the Monitor tool (or BashOutput for shell commands) to wait until each one actually finishes, read its output, then continue the remaining steps of your task in THIS turn.`,
    `Only finish once the background work is consumed and your task is genuinely done, or emit CONTINUE_SESSION to hand off to the next phase.`,
    `If a background process is intentionally long-lived and you truly have no dependent work left, it is fine to finish now.`,
  ].join('\n');
}

/**
 * Pure policy: given the live background snapshot and turn state, decide
 * whether to resume the session, reset the counter, stop on cap, or do
 * nothing. See module docstring for rationale.
 */
export function decideBackgroundWaitContinuation(input: BackgroundWaitDecisionInput): BackgroundWaitDecision {
  const { live, priorWaitCount, cap, hasPendingChoice, hasError, hasOtherContinuation } = input;

  // Never resume over a real continuation, a pending user choice, or an error
  // turn — those have their own, correct terminal handling.
  if (hasOtherContinuation || hasPendingChoice || hasError) return { action: 'none' };

  const liveCount = live.bashCount + live.taskLabels.length;
  // Turn ended cleanly with nothing backgrounded → clear the counter and let
  // the session complete. This is also the natural reset for a wait chain that
  // finally drained.
  if (liveCount === 0) return { action: 'reset' };

  // Background work is live but we have already waited `cap` times — stop
  // auto-waiting so a perpetually-re-backgrounding model can't loop forever.
  if (priorWaitCount >= cap) return { action: 'cap-exceeded' };

  const attempt = priorWaitCount + 1;
  return {
    action: 'continue',
    continuation: { origin: 'host', prompt: buildBackgroundWaitPrompt(live, attempt, cap) },
    nextWaitCount: attempt,
  };
}
