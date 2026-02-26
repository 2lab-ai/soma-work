/**
 * Progress rendering abstraction for tool execution events.
 *
 * Generic event model + Strategy-pattern renderers.
 */

// Types & interfaces
export type {
  ProgressStatus,
  ToolCategory,
  ToolStartEvent,
  ToolCompleteEvent,
  ToolProgressEvent,
  RendererStartOptions,
  RendererFinishOptions,
  ProgressRenderer,
} from './types';

// UI mode
export type { UiMode } from './ui-mode';
export { DEFAULT_UI_MODE, UI_MODE_NAMES, isValidUiMode } from './ui-mode';

// Event mapper (SDK events → generic events)
export { mapToolUses, mapToolResults } from './event-mapper';

// Renderers
export { MessageRenderer } from './message-renderer';
export type { MessageRendererDeps } from './message-renderer';

// Factory
export { createRenderer, type CreateRendererOptions } from './renderer-factory';
