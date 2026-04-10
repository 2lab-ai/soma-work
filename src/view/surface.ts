/**
 * ViewSurface — Capability-based view abstraction (Issue #408)
 *
 * Instead of one god interface with optional methods, capabilities are
 * expressed as separate interfaces. Adapters compose only what they support:
 *
 *   SlackViewAdapter    = ViewSurfaceCore & Editable & Threadable & Reactable & HasModals
 *   TelegramViewAdapter = ViewSurfaceCore & Editable
 *   DiscordViewAdapter  = ViewSurfaceCore & Editable & Threadable & Reactable & HasModals
 *   WebViewAdapter      = ViewSurfaceCore & Editable & Threadable & Reactable & HasModals
 *   TuiViewAdapter      = ViewSurfaceCore
 *
 * TypeScript enforces that if an adapter claims Editable, it MUST implement
 * updateMessage/deleteMessage. No more boolean flags that can lie.
 *
 * Runtime capability checking uses `featuresFor(target)` which returns
 * a dynamic FeatureSet per conversation target (not per platform).
 */

import type { ResponseSession } from './response-session.js';
import type {
  ContentBlock,
  ConversationTarget,
  FeatureSet,
  FormSpec,
  MessageHandle,
  Platform,
} from './types.js';

// ─── Core (required for all platforms) ───────────────────────────

/**
 * Minimum surface every platform must implement.
 */
export interface ViewSurfaceCore {
  /** Platform identifier. */
  readonly platform: Platform;

  /**
   * Post a complete message (non-streaming).
   * For simple notifications, errors, status updates.
   */
  postMessage(target: ConversationTarget, blocks: readonly ContentBlock[]): Promise<MessageHandle>;

  /**
   * Begin a progressive response session.
   * Used for agent responses that stream text, update status, and attach files.
   * The returned ResponseSession must be completed or aborted by the caller.
   */
  beginResponse(target: ConversationTarget): ResponseSession;

  /**
   * Query dynamic feature availability for a specific target.
   * Results can vary by channel type, permissions, and context.
   */
  featuresFor(target: ConversationTarget): FeatureSet;
}

// ─── Editable ────────────────────────────────────────────────────

/** Platform supports editing and deleting sent messages. */
export interface Editable {
  /** Update the content of a previously sent message. */
  updateMessage(handle: MessageHandle, blocks: readonly ContentBlock[]): Promise<void>;

  /** Delete a previously sent message. */
  deleteMessage(handle: MessageHandle): Promise<void>;
}

// ─── Threadable ──────────────────────────────────────────────────

/** Platform supports sub-thread/sub-conversation creation. */
export interface Threadable {
  /**
   * Create a new thread/sub-conversation from a root message.
   * Returns a new ConversationTarget scoped to the thread.
   */
  createThread(
    target: ConversationTarget,
    rootBlocks: readonly ContentBlock[],
  ): Promise<ConversationTarget>;
}

// ─── Reactable ───────────────────────────────────────────────────

/** Platform supports emoji reactions on messages. */
export interface Reactable {
  /** Add a reaction to a message. */
  addReaction(handle: MessageHandle, emoji: string): Promise<void>;

  /** Remove a reaction from a message. */
  removeReaction(handle: MessageHandle, emoji: string): Promise<void>;
}

// ─── HasModals ───────────────────────────────────────────────────

/** Platform supports modal dialogs with form inputs. */
export interface HasModals {
  /**
   * Open a modal/dialog with form fields.
   * Returns an opaque form ID for subsequent updates or closing.
   */
  openForm(target: ConversationTarget, form: FormSpec): Promise<string>;

  /** Update an open modal's content. */
  updateForm(formId: string, form: FormSpec): Promise<void>;

  /** Close an open modal. */
  closeForm(formId: string): Promise<void>;
}

// ─── Type Guards ─────────────────────────────────────────────────

/** Check if a surface supports message editing. */
export function isEditable(surface: ViewSurfaceCore): surface is ViewSurfaceCore & Editable {
  return 'updateMessage' in surface && 'deleteMessage' in surface;
}

/** Check if a surface supports threading. */
export function isThreadable(surface: ViewSurfaceCore): surface is ViewSurfaceCore & Threadable {
  return 'createThread' in surface;
}

/** Check if a surface supports reactions. */
export function isReactable(surface: ViewSurfaceCore): surface is ViewSurfaceCore & Reactable {
  return 'addReaction' in surface && 'removeReaction' in surface;
}

/** Check if a surface supports modals. */
export function hasModals(surface: ViewSurfaceCore): surface is ViewSurfaceCore & HasModals {
  return 'openForm' in surface && 'updateForm' in surface && 'closeForm' in surface;
}

// ─── Composite Types ─────────────────────────────────────────────

/** Full-featured adapter (Slack, Discord, Web). */
export type FullViewAdapter = ViewSurfaceCore & Editable & Threadable & Reactable & HasModals;

/** Edit-capable adapter (Telegram). */
export type EditableViewAdapter = ViewSurfaceCore & Editable;

/** Minimal adapter (TUI). */
export type MinimalViewAdapter = ViewSurfaceCore;
