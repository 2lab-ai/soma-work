/**
 * UI mode for progress rendering.
 *
 * - 'message': Traditional Slack messages (current behavior, default)
 * - 'agent':   Slack Thinking Steps (plan/task_card) — future
 */
export type UiMode = 'message' | 'agent';

export const DEFAULT_UI_MODE: UiMode = 'message';

export const UI_MODE_NAMES: UiMode[] = ['message', 'agent'];

export function isValidUiMode(value: string): value is UiMode {
  return UI_MODE_NAMES.includes(value as UiMode);
}

/**
 * Resolve the effective UI mode for a session.
 * Priority: session override > user default > global default
 */
export function resolveSessionUiMode(
  sessionUiMode?: UiMode,
  userDefaultUiMode?: UiMode
): UiMode {
  return sessionUiMode ?? userDefaultUiMode ?? DEFAULT_UI_MODE;
}
