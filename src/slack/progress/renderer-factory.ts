/**
 * Factory for creating the appropriate ProgressRenderer based on session settings.
 *
 * Currently only produces MessageRenderer (default).
 * StreamingRenderer will be added when Phase D/E are implemented.
 */

import type { ProgressRenderer } from './types';
import { MessageRenderer, type MessageRendererDeps } from './message-renderer';
import type { UiMode } from './ui-mode';

export interface CreateRendererOptions {
  uiMode: UiMode;
  deps: MessageRendererDeps;
}

/**
 * Create the appropriate renderer for the current session.
 *
 * - 'message' → MessageRenderer (current behavior, default)
 * - 'agent'   → StreamingRenderer (future, falls back to MessageRenderer)
 */
export function createRenderer(options: CreateRendererOptions): ProgressRenderer {
  // For now, always return MessageRenderer.
  // When StreamingRenderer is implemented (Phase E), this will switch on uiMode.
  // if (options.uiMode === 'agent') {
  //   return new StreamingRenderer(options.deps);
  // }
  return new MessageRenderer(options.deps);
}
