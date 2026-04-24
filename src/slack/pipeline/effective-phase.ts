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
      emitUiPhaseClamped({ from: raw, to: 3, reason: 'assistant-status-disabled' });
      clampEmittedOnce = true;
    }
    return 3;
  }
  return raw;
}

/** Test-only: reset the process-wide once-flag so tests do not leak state. */
export function __resetClampEmitted(): void {
  clampEmittedOnce = false;
}
