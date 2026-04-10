/**
 * View Module — Multi-platform view abstraction (Issue #408)
 *
 * Barrel export for all view types, interfaces, and utilities.
 *
 * Usage:
 *   import { ViewSurfaceCore, ConversationTarget, ContentBlock } from './view';
 *   import type { ResponseSession, InputEvent } from './view';
 */

// Core types
export type {
  ActionItem,
  AttachmentBlock,
  ContentBlock,
  ConversationTarget,
  FeatureSet,
  FileData,
  FormBlock,
  FormField,
  FormFieldOption,
  FormSpec,
  MessageHandle,
  Platform,
  StatusBlock,
  TextBlock,
} from './types.js';

// Response session
export type { ResponseSession, StatusDetail } from './response-session.js';

// View surface hierarchy
export type {
  Editable,
  EditableViewAdapter,
  FullViewAdapter,
  HasModals,
  MinimalViewAdapter,
  Reactable,
  Threadable,
  ViewSurfaceCore,
} from './surface.js';

export { hasModals, isEditable, isReactable, isThreadable } from './surface.js';

// Input
export type {
  AckFn,
  ActionInputEvent,
  CommandInputEvent,
  FileUploadInputEvent,
  FormSubmitInputEvent,
  InputAdapter,
  InputEvent,
  InputHandler,
  MessageInputEvent,
} from './input.js';
