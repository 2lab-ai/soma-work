export interface AssistantStatusReader {
  isEnabled(): boolean;
}

export interface UiPhaseClampedEvent {
  from: number;
  to: number;
  reason: 'assistant-status-disabled';
}

let clampEmittedOnce = false;
let getFiveBlockPhase: () => number = () => Number(process.env.SOMA_UI_5BLOCK_PHASE || 0);
let emitPhaseClamped: (event: UiPhaseClampedEvent) => void = () => {};

export function configureEffectivePhase(options: {
  getFiveBlockPhase?: () => number;
  emitUiPhaseClamped?: (event: UiPhaseClampedEvent) => void;
}): void {
  if (options.getFiveBlockPhase) getFiveBlockPhase = options.getFiveBlockPhase;
  if (options.emitUiPhaseClamped) emitPhaseClamped = options.emitUiPhaseClamped;
}

/**
 * Resolve the effective 5-block phase for a B4-aware consumer.
 */
export function getEffectiveFiveBlockPhase(statusManager: AssistantStatusReader): number {
  const raw = getFiveBlockPhase();
  if (raw >= 4 && !statusManager.isEnabled()) {
    if (!clampEmittedOnce) {
      clampEmittedOnce = true;
      try {
        emitPhaseClamped({ from: raw, to: 3, reason: 'assistant-status-disabled' });
      } catch {
        // Metric emit is best-effort; never disrupt the clamp return.
      }
    }
    return 3;
  }
  return raw;
}

/**
 * True iff the legacy (PHASE<4) B4 path should run for this manager.
 */
export function shouldRunLegacyB4Path(statusManager: AssistantStatusReader | null | undefined): boolean {
  return !!statusManager && getEffectiveFiveBlockPhase(statusManager) < 4;
}

/** Test-only: reset the process-wide once-flag so tests do not leak state. */
export function __resetClampEmitted(): void {
  clampEmittedOnce = false;
}
