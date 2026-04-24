/**
 * UI-layer metric emitters — #689 P4 Part 2.
 *
 * These are operational signals (not persistent user-scoped events like
 * `MetricsEventEmitter`). We route through the structured Logger so
 * aggregators can grep the well-known event name.
 */
import { Logger } from '../logger';

const logger = new Logger('UiMetrics');

export interface UiPhaseClampedPayload {
  /** The raw `SOMA_UI_5BLOCK_PHASE` value before clamp. */
  from: number;
  /** The effective phase after clamp (always 3 today). */
  to: number;
  /**
   * Why the clamp fired. `'assistant-status-disabled'` is the canonical
   * reason when `AssistantStatusManager.isEnabled()` returns `false`.
   */
  reason: 'assistant-status-disabled' | string;
}

/**
 * Emit a `soma_ui_5block_phase_clamped` event. Fired at most once per
 * process by `getEffectiveFiveBlockPhase` via its once-flag, so repeated
 * clamp reads do not spam the log.
 */
export function emitUiPhaseClamped(payload: UiPhaseClampedPayload): void {
  logger.warn('soma_ui_5block_phase_clamped', payload);
}
