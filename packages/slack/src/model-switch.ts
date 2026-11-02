/**
 * Dashboard model switch (SSOT 2026-10-22 T4/T5) — the session-state half,
 * shared by the host (an immediate switch) and the stream executor (a switch
 * that waited for a compact).
 *
 * A switch makes the new model's auto-compact threshold the session's: a
 * session override (`/autocompact <n>`) is dropped, so the threshold resolver
 * falls back to the model's own (e.g. grok-4.6 → 450k), and the context window
 * is re-anchored to the new model.
 *
 * When the context already holds more than the target model's threshold, the
 * host compacts on the CURRENT model first and parks the switch on the session
 * (`pendingModelSwitch`, runtime-only) with the ts of the `compact --yes`
 * message it sent. The compact turn of THAT message arms it
 * (`armPendingModelSwitch`); the executor applies an armed switch at the
 * compact's boundary, or — when that compact turn ends — applies it if the
 * turn compacted after all (boundary callback missed) and cancels it
 * otherwise. Any other compact (an auto-compact, one the user typed) leaves
 * the switch waiting for its own.
 */

export interface PendingModelSwitch {
  model: string;
  nickname: string;
  requestedAt: number;
  /** Slack ts of the `compact --yes` message the switch dispatched (set once it is sent). */
  compactTs?: string;
  /** The compact turn running now is that message's. */
  armed?: boolean;
  /** The session's effort once the switch lands — set when the target does not run the session's level. */
  effort?: string;
}

type SwitchHolder = {
  model?: string;
  effort?: string;
  autoCompactTokens?: number | null;
  usage?: { contextWindow?: number };
  pendingModelSwitch?: PendingModelSwitch;
  fallbackCompactActive?: boolean;
  compactionOccurred?: boolean;
};

/**
 * A parked switch older than this is not applied to whatever compact comes
 * next — the compact it asked for has long been and gone (failed, swallowed,
 * restarted); it is dropped instead.
 */
export const PENDING_MODEL_SWITCH_TTL_MS = 30 * 60 * 1000;

/**
 * The parked switch while it still counts — undefined once its TTL ran out
 * (the compact it waited for was queued and never came, or was swallowed).
 */
export function livePendingModelSwitch(
  session: Pick<SwitchHolder, 'pendingModelSwitch'>,
  now: number = Date.now(),
): PendingModelSwitch | undefined {
  const pending = session.pendingModelSwitch;
  if (!pending) return undefined;
  return now - pending.requestedAt <= PENDING_MODEL_SWITCH_TTL_MS ? pending : undefined;
}

/**
 * A compact turn starts: arm the parked switch when this turn runs the
 * message the switch dispatched (`messageTs` = the turn's Slack message ts).
 */
export function armPendingModelSwitch(
  session: Pick<SwitchHolder, 'pendingModelSwitch'>,
  messageTs: string | undefined,
): boolean {
  const pending = session.pendingModelSwitch;
  if (!pending || pending.compactTs === undefined || messageTs === undefined || pending.compactTs !== messageTs) {
    return false;
  }
  pending.armed = true;
  return true;
}

/**
 * Switch now: model, its auto-compact threshold (override dropped), its window
 * — and the effort the target runs when it does not run the session's level.
 */
export function applyModelSwitch(
  session: SwitchHolder,
  model: string,
  resolveContextWindow: (model?: string) => number,
  effort?: string,
): void {
  session.model = model;
  if (effort) session.effort = effort;
  session.autoCompactTokens = undefined;
  if (session.usage) session.usage.contextWindow = resolveContextWindow(model);
  session.pendingModelSwitch = undefined;
}

/**
 * At a compact boundary: apply the switch that waited for this compact (armed
 * by this turn — another compact's boundary leaves it waiting). An emergency
 * fallback compact that has not restored its original model yet keeps it
 * parked (that restore runs first).
 */
export function applyPendingModelSwitch(
  session: SwitchHolder,
  resolveContextWindow: (model?: string) => number,
  now: number = Date.now(),
): PendingModelSwitch | undefined {
  if (!session.pendingModelSwitch?.armed || session.fallbackCompactActive) return undefined;
  const pending = livePendingModelSwitch(session, now);
  if (!pending) {
    session.pendingModelSwitch = undefined;
    return undefined;
  }
  applyModelSwitch(session, pending.model, resolveContextWindow, pending.effort);
  return pending;
}

/**
 * When the compact turn the switch waited for ends: never leave it parked for
 * some later compact. Another compact turn's end leaves it alone.
 */
export function settlePendingModelSwitch(
  session: SwitchHolder,
  resolveContextWindow: (model?: string) => number,
  now: number = Date.now(),
): 'none' | 'applied' | 'cancelled' {
  if (!session.pendingModelSwitch?.armed) return 'none';
  if (session.compactionOccurred && applyPendingModelSwitch(session, resolveContextWindow, now)) return 'applied';
  session.pendingModelSwitch = undefined;
  return 'cancelled';
}
