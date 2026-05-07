/**
 * Core View Types — MVC Phase 1 (Issue #408)
 *
 * Platform-agnostic types for multi-platform view abstraction.
 * Supports: Slack, Telegram, Discord, Web Dashboard, TUI.
 *
 * Design principles:
 * - Opaque references: platform-specific identifiers are never typed as string fields
 * - Discriminated unions: content blocks use `type` discriminant for exhaustive matching
 * - No platform leakage: all platform-specific data stays behind `unknown` refs
 */

// ─── Platform ────────────────────────────────────────────────────

/** Supported platform identifiers. */
export type Platform = 'slack' | 'telegram' | 'discord' | 'web' | 'tui';

// ─── Conversation Target ─────────────────────────────────────────

/**
 * Platform-agnostic conversation address.
 *
 * `ref` is an opaque, platform-specific identifier. Examples:
 * - Slack:    `{ channel: string; thread_ts?: string }`
 * - Telegram: `{ chatId: number; messageThreadId?: number }`
 * - Discord:  `{ guildId: string; channelId: string; threadId?: string }`
 * - Web:      `{ sessionId: string }`
 * - TUI:      `{ pid: number }`
 *
 * Controllers never inspect `ref` — they pass it through to ViewSurface methods.
 */
export interface ConversationTarget {
  readonly platform: Platform;
  /** Opaque platform-specific address. */
  readonly ref: unknown;
  /** User who initiated or owns this conversation. */
  readonly userId: string;
}

// ─── Message Handle ──────────────────────────────────────────────

/**
 * Handle to a sent message, used for edits, deletions, and reactions.
 *
 * Like ConversationTarget, `ref` is opaque and platform-specific:
 * - Slack:    `{ channel: string; ts: string }`
 * - Telegram: `{ chatId: number; messageId: number }`
 * - Discord:  `{ channelId: string; messageId: string }`
 * - Web:      `{ messageId: string }`
 * - TUI:      never produced (TUI doesn't support message editing)
 */
export interface MessageHandle {
  readonly platform: Platform;
  /** Opaque platform-specific message reference. */
  readonly ref: unknown;
}

// ─── Content Blocks ──────────────────────────────────────────────

/**
 * Discriminated union of content blocks.
 * Controllers compose arrays of these to build messages.
 * ViewSurface adapters render them into platform-native formats.
 */
export type ContentBlock = TextBlock | AttachmentBlock | ActionsBlock | StatusBlock | FormBlock;

/** Plain or formatted text. */
export interface TextBlock {
  readonly type: 'text';
  /** The text content. */
  readonly text: string;
  /** Rendering hint. Adapters convert markdown/code to platform-native format. */
  readonly format?: 'plain' | 'markdown' | 'code';
  /** Language hint for `format: 'code'`. */
  readonly language?: string;
}

/** File or binary attachment. */
export interface AttachmentBlock {
  readonly type: 'attachment';
  readonly name: string;
  readonly data: Buffer | string;
  readonly mimeType: string;
  /** Optional size in bytes (informational). */
  readonly size?: number;
}

/** Interactive action buttons. */
export interface ActionsBlock {
  readonly type: 'actions';
  readonly items: readonly ActionItem[];
}

/** Single interactive action (button/option). */
export interface ActionItem {
  /** Unique identifier for this action within the message. */
  readonly id: string;
  /** Display label. */
  readonly label: string;
  /** Visual style hint. */
  readonly style?: 'primary' | 'danger' | 'default';
  /** Optional description shown below or beside the label. */
  readonly description?: string;
}

/** Agent processing status indicator. */
export interface StatusBlock {
  readonly type: 'status';
  /** Human-readable phase name (e.g., '생각 중', 'Running tool'). */
  readonly phase: string;
  /** Active tool name, if any. */
  readonly tool?: string;
  /** Progress percentage (0-100), if deterministic. */
  readonly progress?: number;
}

/** Form with input fields (for modals, inline forms, etc.). */
export interface FormBlock {
  readonly type: 'form';
  /** Form fields. */
  readonly fields: readonly FormField[];
  /** Submit button label. */
  readonly submitLabel?: string;
  /** Optional form title (used in modal contexts). */
  readonly title?: string;
}

/** Single form input field. */
export interface FormField {
  /** Unique field identifier. */
  readonly id: string;
  /** Input type. */
  readonly fieldType: 'text' | 'textarea' | 'select' | 'multiselect' | 'toggle';
  /** Display label. */
  readonly label: string;
  /** Options for select/multiselect fields. */
  readonly options?: readonly FormFieldOption[];
  /** Default value. */
  readonly defaultValue?: string;
  /** Whether this field is required for submission. */
  readonly required?: boolean;
  /** Placeholder text. */
  readonly placeholder?: string;
}

/** Option within a select/multiselect field. */
export interface FormFieldOption {
  readonly value: string;
  readonly label: string;
}

// ─── File Data ───────────────────────────────────────────────────

/** File data for uploads and attachments. */
export interface FileData {
  readonly name: string;
  readonly data: Buffer | string;
  readonly mimeType: string;
  readonly size?: number;
}

// ─── Feature Set ─────────────────────────────────────────────────

/**
 * Dynamic feature availability for a specific conversation target.
 *
 * Unlike static boolean flags on the adapter, this is queried per-target
 * because capabilities can vary by channel type, permissions, or context.
 * For example, Discord ephemeral messages are only available in interaction responses.
 */
export interface FeatureSet {
  /** Can edit previously sent messages. */
  readonly canEdit: boolean;
  /** Can create sub-threads/conversations. */
  readonly canThread: boolean;
  /** Can add emoji reactions. */
  readonly canReact: boolean;
  /** Can open modal dialogs/forms. */
  readonly canModal: boolean;
  /** Can upload files. */
  readonly canUploadFile: boolean;
  /** Can send messages visible only to a specific user. */
  readonly canEphemeral: boolean;
  /** Maximum message text length (0 = unlimited). */
  readonly maxMessageLength: number;
  /** Maximum file upload size in bytes (0 = unlimited). */
  readonly maxFileSize: number;
}

/**
 * Form specification for modal/dialog rendering.
 * Separate from FormBlock because modals have additional metadata
 * (title, submit actions, cancel behavior).
 */
export interface FormSpec {
  /** Modal/dialog title. */
  readonly title: string;
  /** Form fields. */
  readonly fields: readonly FormField[];
  /** Submit button label. */
  readonly submitLabel?: string;
  /** Cancel button label (if supported by platform). */
  readonly cancelLabel?: string;
  /** Action buttons shown alongside submit. */
  readonly actions?: readonly ActionItem[];
}
