/**
 * Generic tool progress event model and renderer interface.
 *
 * Layer 1 of the Progress abstraction — NO UI/Slack dependency.
 * SDK tool_use/tool_result events are mapped to these generic events
 * by EventMapper, then consumed by a ProgressRenderer implementation.
 */

import type { StatusType } from '../status-reporter';

// ── Progress Status ─────────────────────────────────────────────────

/** Normalized progress status (maps to StatusType for MessageRenderer) */
export type ProgressStatus = StatusType;

// ── Tool Category ───────────────────────────────────────────────────

/** Broad category of a tool, used for icon/status selection */
export type ToolCategory =
  | 'read'       // Read, Glob, Grep
  | 'write'      // Write, Edit, MultiEdit
  | 'execute'    // Bash
  | 'search'     // WebSearch, WebFetch
  | 'mcp'        // mcp__* tools
  | 'subagent'   // Task tool
  | 'other';     // Everything else

// ── Tool Progress Events ────────────────────────────────────────────

/** Base fields shared by all tool progress events */
interface ToolEventBase {
  /** Original tool_use ID from SDK */
  toolUseId: string;
  /** Raw tool name from SDK (e.g. "mcp__github__search") */
  toolName: string;
  /** Broad category for UI treatment */
  category: ToolCategory;
  /** Human-readable display label (e.g. "github → search") */
  displayLabel: string;
  /** Optional parallel batch group ID */
  groupId?: string;
}

/** Emitted when a tool_use event arrives from the stream */
export interface ToolStartEvent extends ToolEventBase {
  type: 'tool_start';
  /** For MCP tools: the parsed server name */
  serverName?: string;
  /** For MCP tools: the parsed tool name within the server */
  serverToolName?: string;
  /** For subagent tools: agent type and summary */
  subagentType?: string;
  subagentLabel?: string;
  /** Raw input parameters (for detail/verbose modes) */
  input?: Record<string, unknown>;
}

/** Emitted when a tool_result event arrives from the stream */
export interface ToolCompleteEvent extends ToolEventBase {
  type: 'tool_complete';
  /** Whether the tool returned an error */
  isError: boolean;
  /** Truncated result text for display */
  resultPreview?: string;
  /** Duration in milliseconds (if tracked) */
  durationMs?: number;
}

/** Union of all tool progress events */
export type ToolProgressEvent = ToolStartEvent | ToolCompleteEvent;

// ── Renderer Start/Finish Options ───────────────────────────────────

export interface RendererStartOptions {
  channel: string;
  threadTs: string;
  sessionKey: string;
  /** Verbosity bitmask controlling output gating */
  verbosityMask: number;
}

export interface RendererFinishOptions {
  /** Final status to display */
  status: ProgressStatus;
  /** Footer text to append (timing, usage, etc.) */
  footerText?: string;
}

// ── Progress Renderer Interface ─────────────────────────────────────

/**
 * Strategy interface for rendering tool progress events.
 *
 * Implementations:
 * - MessageRenderer: delegates to existing ToolEventProcessor, StatusReporter, etc.
 * - StreamingRenderer: uses Slack Thinking Steps (plan/task_card)
 */
export interface ProgressRenderer {
  /**
   * Initialize rendering for a new stream execution.
   * Called before the stream loop begins.
   * (status message creation, reactions, spinner)
   */
  start(options: RendererStartOptions): Promise<void>;

  /**
   * Handle a tool starting execution.
   * Called from onToolUse callback.
   */
  onToolStart(event: ToolStartEvent): Promise<void>;

  /**
   * Handle a tool completing execution.
   * Called from onToolResult callback.
   */
  onToolComplete(event: ToolCompleteEvent): Promise<void>;

  /**
   * Handle text output from the stream.
   * Called when assistant text content arrives.
   */
  onText(text: string): Promise<void>;

  /**
   * Handle thinking/reasoning output from the stream.
   */
  onThinking(text: string): Promise<void>;

  /**
   * Handle a status change (e.g. thinking → working → waiting).
   */
  onStatusChange(status: ProgressStatus): Promise<void>;

  /**
   * Finalize rendering after stream completes successfully.
   * (final status update, clear reactions/spinner)
   */
  finish(options: RendererFinishOptions): Promise<void>;

  /**
   * Abort rendering due to error or cancellation.
   * (error status, cleanup)
   */
  abort(error?: Error): Promise<void>;
}
