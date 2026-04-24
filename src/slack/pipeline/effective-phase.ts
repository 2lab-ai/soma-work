/**
 * Effective 5-block phase with runtime clamp — #689 P4 Part 2.
 *
 * The raw phase is `config.ui.fiveBlockPhase` (0..5). When the caller runs
 * a B4-aware surface (`TurnSurface`, `ThreadSurface` chip, `stream-executor`
 * legacy wrapper) the effective phase is clamped to 3 if the
 * `AssistantStatusManager` has already been disabled — because at that
 * point every native `setStatus`/`clearStatus` becomes a no-op and the
 * user-visible feedback must fall back to the Phase-3-style inline chip.
 *
 * The clamp metric fires exactly once per process via the module-level
 * `clampEmittedOnce` flag. `__resetClampEmitted` is test-only.
 */
import { config } from '../../config';
import { emitUiPhaseClamped } from '../../metrics/ui-metrics';
import type { AssistantStatusManager } from '../assistant-status-manager';

let clampEmittedOnce = false;

/**
 * Resolve the effective 5-block phase for a B4-aware consumer.
 *
 * `raw >= 4 && !statusManager.isEnabled()` → clamp to 3 + emit once-flag
 * metric. Otherwise the raw value is returned unchanged.
 */
export function getEffectiveFiveBlockPhase(statusManager: AssistantStatusManager): number {
  const raw = config.ui.fiveBlockPhase;
  if (raw >= 4 && !statusManager.isEnabled()) {
    if (!clampEmittedOnce) {
      // Set the once-flag BEFORE the metric emit so a logger throw here
      // cannot (a) violate the once-guarantee by leaving the flag false
      // and re-emitting forever, nor (b) bubble through the callers of
      // this helper and defeat the graceful-degradation return below.
      clampEmittedOnce = true;
      try {
        emitUiPhaseClamped({ from: raw, to: 3, reason: 'assistant-status-disabled' });
      } catch {
        // Metric emit is best-effort; never disrupt the clamp return.
      }
    }
    return 3;
  }
  return raw;
}

/**
 * True iff the legacy (PHASE<4) B4 path should run for this manager — i.e.
 * the manager exists AND effective phase is below 4. At PHASE>=4 with an
 * enabled manager TurnSurface owns the native B4 surface, so legacy
 * setStatus/setTitle/clearStatus callsites must short-circuit.
 *
 * Centralizing the predicate also pulls the `mgr && ...` null-check out of
 * every callsite — the dispatch / tool-event / per-turn paths read uniform.
 */
export function shouldRunLegacyB4Path(statusManager: AssistantStatusManager | null | undefined): boolean {
  return !!statusManager && getEffectiveFiveBlockPhase(statusManager) < 4;
}

/** Test-only: reset the process-wide once-flag so tests do not leak state. */
export function __resetClampEmitted(): void {
  clampEmittedOnce = false;
}
