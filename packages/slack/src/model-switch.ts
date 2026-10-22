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
 * (`pendingModelSwitch`, runtime-only); the executor applies it at that
 * compact's boundary, or — when the compact turn ends — applies it if the turn
 * compacted after all (boundary callback missed) and cancels it otherwise.
 */

export interface PendingModelSwitch {
  model: string;
  nickname: string;
  requestedAt: number;
}

type SwitchHolder = {
  model?: string;
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

/** Switch now: model, its auto-compact threshold (override dropped), its window. */
export function applyModelSwitch(
  session: SwitchHolder,
  model: string,
  resolveContextWindow: (model?: string) => number,
): void {
  session.model = model;
  session.autoCompactTokens = undefined;
  if (session.usage) session.usage.contextWindow = resolveContextWindow(model);
  session.pendingModelSwitch = undefined;
}

/**
 * At a compact boundary: apply the switch that waited for this compact.
 * An emergency fallback compact that has not restored its original model yet
 * keeps it parked (that restore runs first).
 */
export function applyPendingModelSwitch(
  session: SwitchHolder,
  resolveContextWindow: (model?: string) => number,
  now: number = Date.now(),
): PendingModelSwitch | undefined {
  const pending = session.pendingModelSwitch;
  if (!pending || session.fallbackCompactActive) return undefined;
  if (!(now - pending.requestedAt <= PENDING_MODEL_SWITCH_TTL_MS)) {
    session.pendingModelSwitch = undefined;
    return undefined;
  }
  applyModelSwitch(session, pending.model, resolveContextWindow);
  return pending;
}

/** When a compact turn ends: never leave a switch parked for some later compact. */
export function settlePendingModelSwitch(
  session: SwitchHolder,
  resolveContextWindow: (model?: string) => number,
  now: number = Date.now(),
): 'none' | 'applied' | 'cancelled' {
  if (!session.pendingModelSwitch) return 'none';
  if (session.compactionOccurred && applyPendingModelSwitch(session, resolveContextWindow, now)) return 'applied';
  session.pendingModelSwitch = undefined;
  return 'cancelled';
}
