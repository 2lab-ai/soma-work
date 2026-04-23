/**
 * ResponseSession — Structured response rendering abstraction (Issue #408)
 *
 * Replaces the naive `write(delta: string)` streaming model with
 * a structured update protocol that works for both:
 * - Native streaming (Web/TUI via WebSocket/stdout)
 * - Edit-polling (Slack/Telegram/Discord via throttled message edits)
 *
 * Adapters implement this interface to translate structured patches
 * into platform-native rendering operations.
 *
 * Lifecycle:
 *   beginResponse() → appendText/setStatus/replacePart/attachFile → complete() or abort()
 */

import type { ContentBlock, FileData, MessageHandle } from './types.js';

/**
 * A live response session for progressive rendering.
 *
 * Created via `ViewSurfaceCore.beginResponse()`. The controller
 * calls methods on this object as the agent produces output.
 * The adapter batches/debounces/streams these updates to the platform.
 */
export interface ResponseSession {
  /**
   * Append text to the current response.
   * For streaming platforms, this is sent immediately.
   * For edit-polling platforms, this is batched and flushed on a debounce timer.
   */
  appendText(delta: string): void;

  /**
   * Update the agent's processing status.
   * Adapters render this as typing indicators, status bars, reaction emojis, etc.
   *
   * @param phase - Human-readable phase (e.g., '생각 중', 'Tool: Bash')
   * @param detail - Optional structured detail
   */
  setStatus(phase: string, detail?: StatusDetail): void;

  /**
   * Replace a named part of the response.
   * Used for updating tool output, error blocks, code sections, etc.
   *
   * Parts are identified by `partId`. If a part with this ID doesn't exist,
   * it is appended. If it does exist, it is replaced in-place.
   *
   * @param partId - Stable identifier for this replaceable section
   * @param content - New content for this section
   */
  replacePart(partId: string, content: ContentBlock): void;

  /**
   * Attach a file to the response.
   * Some platforms render files inline; others show download links.
   */
  attachFile(file: FileData): void;

  /**
   * Signal successful completion of the response.
   * Adapters perform final rendering (remove typing indicators, add completion reactions, etc.)
   * Returns a handle to the final message for subsequent edits/reactions.
   */
  complete(): Promise<MessageHandle>;

  /**
   * Signal that the response was aborted.
   * Adapters clean up in-progress rendering and optionally show an abort indicator.
   *
   * @param reason - Optional human-readable reason for the abort
   */
  abort(reason?: string): void;
}

/** Optional detail for setStatus(). */
export interface StatusDetail {
  /** Active tool name. */
  readonly tool?: string;
  /** Progress percentage (0-100). */
  readonly progress?: number;
  /** Additional context (e.g., tool arguments summary). */
  readonly context?: string;
}
