/**
 * MessagePipeline — Platform-agnostic message handling (Issue #411)
 *
 * Orchestrates the flow:
 *   InputEvent → validate → resolve session → execute agent → respond
 *
 * This is the Controller in MVC terms. It consumes InputEvents from
 * any platform's InputAdapter, uses SessionController for session
 * management, AgentExecutor for agent interaction, and ViewSurfaceCore
 * for response rendering.
 *
 * The pipeline knows nothing about Slack, Telegram, Discord, or any
 * specific platform. Adding a new platform requires only implementing
 * InputAdapter + ViewSurface — the pipeline stays unchanged.
 *
 * Current scope (Phase 4):
 * - Handle message input events
 * - Session lifecycle: create if new, resume if existing
 * - Single-turn agent execution with structured response
 * - Error handling and cleanup
 *
 * Future phases will add:
 * - Command routing (dispatch classification)
 * - Multi-turn continuation
 * - User choice handling
 * - Working directory resolution
 */

import { Logger } from '../logger.js';
import type { InputEvent, MessageInputEvent } from '../view/input.js';
import type { ViewSurfaceCore } from '../view/surface.js';
import type { ConversationTarget } from '../view/types.js';
import { AgentExecutor, type ExecutionOptions, type ExecutionResult } from './agent-executor.js';
import type { AgentProvider, QueryParams } from './agent-provider.js';
import type { SessionController } from './session-controller.js';

// ─── Types ───────────────────────────────────────────────────────

/** Result of processing a single input through the pipeline. */
export interface PipelineResult {
  /** Whether the pipeline completed without errors. */
  readonly success: boolean;
  /** The session key for this conversation. */
  readonly sessionKey: string;
  /** Agent execution result (if agent was invoked). */
  readonly execution?: ExecutionResult;
  /** Reason the pipeline stopped without executing. */
  readonly skipReason?: string;
}

/** Raw channelId/threadTs pair for SessionRegistry.createSession. */
export interface SessionParams {
  readonly channelId: string;
  readonly threadTs?: string;
}

/** Configuration for the MessagePipeline. */
export interface PipelineConfig {
  /** Default working directory for agent execution. */
  readonly defaultWorkingDirectory?: string;
  /** Maximum prompt length. Messages exceeding this are rejected. */
  readonly maxPromptLength?: number;
  /** Callback for pipeline lifecycle events (logging, metrics). */
  readonly onEvent?: PipelineEventHandler;
  /**
   * Platform-specific session key resolver. Falls back to getSessionKey(userId).
   *
   * IMPORTANT: If you provide this, you MUST also provide `resolveSessionParams`
   * so that SessionRegistry.createSession stores under the same key.
   */
  readonly resolveSessionKey?: (target: ConversationTarget) => string;
  /**
   * Extract raw channelId/threadTs from a target for session creation.
   * Must be consistent with resolveSessionKey: the registry's
   * getSessionKey(params.channelId, params.threadTs) must equal
   * resolveSessionKey(target).
   *
   * Defaults to { channelId: target.userId } (no thread).
   */
  readonly resolveSessionParams?: (target: ConversationTarget) => SessionParams;
}

/** Pipeline lifecycle events for monitoring. */
export type PipelineEvent =
  | { type: 'input_received'; input: InputEvent }
  | { type: 'input_validated'; sessionKey: string }
  | { type: 'session_created'; sessionKey: string; isNew: boolean }
  | { type: 'execution_started'; sessionKey: string }
  | { type: 'execution_completed'; sessionKey: string; result: ExecutionResult }
  | { type: 'pipeline_error'; error: Error; sessionKey?: string };

export type PipelineEventHandler = (event: PipelineEvent) => void;

// ─── Implementation ─────────────────────────────────────────────

/** Default max prompt length (100KB). */
const DEFAULT_MAX_PROMPT_LENGTH = 100_000;

export class MessagePipeline {
  private logger = new Logger('MessagePipeline');
  private executor: AgentExecutor;
  private activeSessions = new Map<string, Promise<PipelineResult>>();

  constructor(
    provider: AgentProvider,
    private sessionController: SessionController,
    private config: PipelineConfig = {},
  ) {
    this.executor = new AgentExecutor(provider);
  }

  /**
   * Process a single input event through the pipeline.
   *
   * This is the main entry point. Platform InputAdapters call this
   * method for each normalized input event.
   *
   * @param input - Normalized input event from any platform
   * @param view - View surface for rendering the response
   */
  async handle(input: InputEvent, view: ViewSurfaceCore): Promise<PipelineResult> {
    this.config.onEvent?.({ type: 'input_received', input });

    // Step 1: Validate input
    const validation = this.validateInput(input);
    if (!validation.valid) {
      return { success: false, sessionKey: '', skipReason: validation.reason };
    }

    // Step 2: Resolve session key
    const sessionKey = this.resolveSessionKey(input.target);
    this.config.onEvent?.({ type: 'input_validated', sessionKey });

    // Step 3: Resolve or create session
    const { isNew } = this.ensureSession(input, sessionKey);
    this.config.onEvent?.({ type: 'session_created', sessionKey, isNew });

    // Serialize requests for the same session
    const pending = this.activeSessions.get(sessionKey);
    if (pending) {
      await pending;
    }

    const resultPromise = this.executeForInput(input, view, sessionKey);
    this.activeSessions.set(sessionKey, resultPromise);
    try {
      const result = await resultPromise;
      return result;
    } finally {
      this.activeSessions.delete(sessionKey);
    }
  }

  /**
   * Route and execute based on input type.
   */
  private async executeForInput(input: InputEvent, view: ViewSurfaceCore, sessionKey: string): Promise<PipelineResult> {
    // Route by input type
    switch (input.type) {
      case 'message':
        return this.handleMessage(input, view, sessionKey);

      case 'file_upload':
        // Convert file upload to a message with placeholder text
        return this.handleMessage(
          {
            type: 'message',
            target: input.target,
            text: `[${input.files.length} file(s) uploaded]`,
            files: input.files,
            timestamp: input.timestamp,
          },
          view,
          sessionKey,
        );

      case 'command':
        // Commands will be handled by a CommandRouter in a future phase.
        // For now, treat as a message with the command text.
        return this.handleMessage(
          {
            type: 'message',
            target: input.target,
            text: `/${input.name} ${input.args}`.trim(),
            timestamp: input.timestamp,
          },
          view,
          sessionKey,
        );

      case 'action':
      case 'form_submit':
        // Actions and forms will be handled in a future phase.
        return { success: true, sessionKey, skipReason: 'action_handling_not_yet_implemented' };
    }
  }

  /**
   * Handle a message input: execute agent and stream response.
   */
  private async handleMessage(
    input: MessageInputEvent,
    view: ViewSurfaceCore,
    sessionKey: string,
  ): Promise<PipelineResult> {
    this.config.onEvent?.({ type: 'execution_started', sessionKey });

    let responseSession: import('../view/response-session.js').ResponseSession | undefined;

    try {
      // Begin a progressive response session
      responseSession = view.beginResponse(input.target);

      // Build query params
      const queryParams: QueryParams = {
        prompt: input.text,
        workingDirectory: this.config.defaultWorkingDirectory,
      };

      // Execute agent turn
      const executionOptions: ExecutionOptions = {
        onEvent: (event) => {
          this.logger.debug('Agent event', { sessionKey, type: event.type });
        },
      };

      const result = await this.executor.execute(queryParams, responseSession, executionOptions);
      this.config.onEvent?.({ type: 'execution_completed', sessionKey, result });

      // Update session activity based on result
      if (result.success) {
        this.sessionController.setActivityStateByKey(sessionKey, 'idle');
      }

      return { success: result.success, sessionKey, execution: result };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error('Pipeline execution failed', err);
      this.config.onEvent?.({ type: 'pipeline_error', error: err, sessionKey });

      // Ensure response session is cleaned up
      responseSession?.abort(err.message);

      return { success: false, sessionKey, skipReason: `execution_error: ${err.message}` };
    }
  }

  // ─── Validation ───────────────────────────────────────────────

  private validateInput(input: InputEvent): { valid: boolean; reason?: string } {
    // Must have a target
    if (!input.target) {
      return { valid: false, reason: 'missing_target' };
    }

    // Message/file_upload must have text or files
    if (input.type === 'message') {
      const text = input.text?.trim();
      const hasFiles = input.files && input.files.length > 0;
      if (!text && !hasFiles) {
        return { valid: false, reason: 'empty_message' };
      }

      // Check prompt length
      const maxLength = this.config.maxPromptLength ?? DEFAULT_MAX_PROMPT_LENGTH;
      if (text && text.length > maxLength) {
        return { valid: false, reason: `prompt_too_long: ${text.length} > ${maxLength}` };
      }
    }

    if (input.type === 'file_upload') {
      if (!input.files || input.files.length === 0) {
        return { valid: false, reason: 'empty_file_upload' };
      }
    }

    return { valid: true };
  }

  // ─── Session Resolution ───────────────────────────────────────

  private resolveSessionKey(target: ConversationTarget): string {
    // Use custom resolver if provided (platform-specific)
    if (this.config.resolveSessionKey) {
      return this.config.resolveSessionKey(target);
    }
    // Default: platform-agnostic key using userId
    return this.sessionController.getSessionKey(target.userId);
  }

  private ensureSession(input: InputEvent, sessionKey: string): { isNew: boolean } {
    const existing = this.sessionController.getSessionByKey(sessionKey);
    if (existing) {
      return { isNew: false };
    }

    // Extract raw channelId/threadTs that, when fed to
    // SessionRegistry.getSessionKey(), produce the same sessionKey
    // computed by resolveSessionKey(). This ensures lookup and
    // creation use identical keys.
    const params = this.resolveSessionParams(input.target);
    this.sessionController.createSession(
      input.target.userId,
      input.target.userId, // ownerName — will be enriched by caller
      params.channelId,
      params.threadTs,
    );

    return { isNew: true };
  }

  private resolveSessionParams(target: ConversationTarget): SessionParams {
    if (this.config.resolveSessionParams) {
      return this.config.resolveSessionParams(target);
    }
    return { channelId: target.userId };
  }
}
