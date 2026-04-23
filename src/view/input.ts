/**
 * Input Abstraction — Normalized input events and adapters (Issue #408)
 *
 * Each platform adapter normalizes its native events into InputEvent,
 * a discriminated union that controllers consume platform-agnostically.
 *
 * Key design decisions:
 * - `ack` callback: platforms like Slack/Discord require explicit acknowledgment
 *   within a timeout. The handler receives `ack` and must call it before processing.
 * - `form_submit`: modals/forms are a distinct input type, not a message.
 * - `messageHandle`: for action events, references the message that contains the action.
 * - Discriminated union: controllers can exhaustively switch on `type`.
 */

import type { ConversationTarget, FileData, MessageHandle, Platform } from './types.js';

// ─── Input Events ────────────────────────────────────────────────

/**
 * Discriminated union of all input event types.
 * Controllers handle these without knowing which platform produced them.
 */
export type InputEvent =
  | MessageInputEvent
  | CommandInputEvent
  | ActionInputEvent
  | FormSubmitInputEvent
  | FileUploadInputEvent;

/** User sent a text message (with optional file attachments). */
export interface MessageInputEvent {
  readonly type: 'message';
  readonly target: ConversationTarget;
  readonly text: string;
  readonly files?: readonly FileData[];
  readonly timestamp: number;
}

/** User issued a slash command or bot command. */
export interface CommandInputEvent {
  readonly type: 'command';
  readonly target: ConversationTarget;
  readonly name: string;
  readonly args: string;
  readonly timestamp: number;
}

/** User clicked a button or selected an option from an actions block. */
export interface ActionInputEvent {
  readonly type: 'action';
  readonly target: ConversationTarget;
  /** The action item's `id` from the ActionsBlock. */
  readonly actionId: string;
  /** Selected value (for selects) or action-specific data. */
  readonly value: unknown;
  /** Handle to the message containing the action (for updates). */
  readonly messageHandle?: MessageHandle;
  readonly timestamp: number;
}

/** User submitted a modal/dialog form. */
export interface FormSubmitInputEvent {
  readonly type: 'form_submit';
  readonly target: ConversationTarget;
  /** The form ID returned by `HasModals.openForm()`. */
  readonly formId: string;
  /** Field ID → submitted value mapping. */
  readonly values: Readonly<Record<string, unknown>>;
  readonly timestamp: number;
}

/** User uploaded one or more files without accompanying text. */
export interface FileUploadInputEvent {
  readonly type: 'file_upload';
  readonly target: ConversationTarget;
  readonly files: readonly FileData[];
  readonly timestamp: number;
}

// ─── Input Adapter ───────────────────────────────────────────────

/**
 * Acknowledgment callback.
 *
 * Some platforms (Slack, Discord) require the app to acknowledge
 * receipt of an event within a tight timeout (e.g., 3 seconds).
 * The handler must call `ack()` as early as possible, before
 * starting long-running processing.
 *
 * For platforms without ack requirements (Web, TUI), this is a no-op.
 */
export type AckFn = () => Promise<void>;

/**
 * Handler function for incoming input events.
 * Receives the event and an ack callback.
 */
export type InputHandler = (event: InputEvent, ack: AckFn) => Promise<void>;

/**
 * Input adapter — translates platform-native events into normalized InputEvents.
 *
 * Each platform implements one InputAdapter that:
 * 1. Listens for platform-native events (Slack Socket Mode, Telegram polling, HTTP, stdin)
 * 2. Normalizes them into InputEvent
 * 3. Calls the registered handler
 *
 * Lifecycle: `start()` → handles events → `stop()`
 */
export interface InputAdapter {
  /** Platform this adapter handles. */
  readonly platform: Platform;

  /**
   * Register the input handler.
   * Only one handler is supported. Calling again replaces the previous handler.
   */
  onInput(handler: InputHandler): void;

  /** Start listening for platform events. */
  start(): Promise<void>;

  /** Stop listening and clean up resources. */
  stop(): Promise<void>;
}
