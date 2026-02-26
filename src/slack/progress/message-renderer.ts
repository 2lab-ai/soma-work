/**
 * MessageRenderer — wraps existing tool progress behavior (zero regression).
 *
 * Delegates to ToolEventProcessor, StatusReporter, ReactionManager,
 * AssistantStatusManager. Preserves OutputFlag gating.
 */

import type { ToolEventProcessor, ToolEventContext, ToolUseEvent as TEPToolUseEvent, ToolResultEvent as TEPToolResultEvent } from '../tool-event-processor';
import type { StatusReporter } from '../status-reporter';
import type { ReactionManager } from '../reaction-manager';
import type { AssistantStatusManager } from '../assistant-status-manager';
import type {
  ProgressRenderer,
  RendererStartOptions,
  RendererFinishOptions,
  ToolStartEvent,
  ToolCompleteEvent,
  ProgressStatus,
} from './types';
import { shouldOutput, verboseTag, OutputFlag } from '../output-flags';

// ── Dependencies ────────────────────────────────────────────────────

export interface MessageRendererDeps {
  toolEventProcessor: ToolEventProcessor;
  statusReporter: StatusReporter;
  reactionManager: ReactionManager;
  assistantStatusManager: AssistantStatusManager;
  say: (message: { text: string; thread_ts: string }) => Promise<{ ts?: string }>;
}

// ── Implementation ──────────────────────────────────────────────────

export class MessageRenderer implements ProgressRenderer {
  private channel = '';
  private threadTs = '';
  private sessionKey = '';
  private verbosityMask = 0;
  private statusMessageTs: string | undefined;

  constructor(private deps: MessageRendererDeps) {}

  // ── Helpers ──────────────────────────────────────────────────────

  private isEnabled(flag: number): boolean {
    return shouldOutput(flag, this.verbosityMask);
  }

  private vtag(flag: number): string {
    return verboseTag(flag, this.verbosityMask);
  }

  private get toolEventContext(): ToolEventContext {
    return {
      channel: this.channel,
      threadTs: this.threadTs,
      sessionKey: this.sessionKey,
      say: this.deps.say,
      logVerbosity: this.verbosityMask,
    };
  }

  // ── ProgressRenderer ─────────────────────────────────────────────

  async start(options: RendererStartOptions): Promise<void> {
    this.channel = options.channel;
    this.threadTs = options.threadTs;
    this.sessionKey = options.sessionKey;
    this.verbosityMask = options.verbosityMask;

    // Status message (gated)
    if (this.isEnabled(OutputFlag.STATUS_MESSAGE)) {
      this.statusMessageTs = await this.deps.statusReporter.createStatusMessage(
        this.channel,
        this.threadTs,
        this.sessionKey,
        'thinking',
        this.vtag(OutputFlag.STATUS_MESSAGE)
      );
    }

    // Thinking reaction (gated)
    if (this.isEnabled(OutputFlag.STATUS_REACTION)) {
      await this.deps.reactionManager.updateReaction(
        this.sessionKey,
        this.deps.statusReporter.getStatusEmoji('thinking')
      );
    }

    // Native spinner (gated)
    if (this.isEnabled(OutputFlag.STATUS_SPINNER)) {
      await this.deps.assistantStatusManager.setStatus(
        this.channel,
        this.threadTs,
        'is thinking...'
      );
    }
  }

  async onToolStart(event: ToolStartEvent): Promise<void> {
    // Update status message → working
    if (this.isEnabled(OutputFlag.STATUS_MESSAGE) && this.statusMessageTs) {
      await this.deps.statusReporter.updateStatusDirect(
        this.channel,
        this.statusMessageTs,
        'working',
        this.vtag(OutputFlag.STATUS_MESSAGE)
      );
    }

    // Update reaction → working
    if (this.isEnabled(OutputFlag.STATUS_REACTION)) {
      await this.deps.reactionManager.updateReaction(
        this.sessionKey,
        this.deps.statusReporter.getStatusEmoji('working')
      );
    }

    // Native spinner with tool-specific text
    if (this.isEnabled(OutputFlag.STATUS_SPINNER)) {
      const statusText = this.deps.assistantStatusManager.getToolStatusText(
        event.toolName,
        event.serverName
      );
      await this.deps.assistantStatusManager.setStatus(
        this.channel,
        this.threadTs,
        statusText
      );
    }

    // Delegate to ToolEventProcessor (handles MCP tracking, subagent tracking, etc.)
    const tepEvent: TEPToolUseEvent = {
      id: event.toolUseId,
      name: event.toolName,
      input: event.input,
    };
    await this.deps.toolEventProcessor.handleToolUse(
      [tepEvent],
      this.toolEventContext
    );
  }

  async onToolComplete(event: ToolCompleteEvent): Promise<void> {
    // Delegate to ToolEventProcessor (handles MCP tracking end, result formatting, etc.)
    const tepResult: TEPToolResultEvent = {
      toolUseId: event.toolUseId,
      toolName: event.toolName,
      result: event.resultPreview,
      isError: event.isError,
    };
    await this.deps.toolEventProcessor.handleToolResult(
      [tepResult],
      this.toolEventContext
    );
  }

  async onText(_text: string): Promise<void> {
    // Text output is handled by StreamProcessor.say() directly — pass-through
  }

  async onThinking(_text: string): Promise<void> {
    // Thinking output is handled by StreamProcessor.handleThinkingContent() — pass-through
  }

  async onStatusChange(status: ProgressStatus): Promise<void> {
    if (this.isEnabled(OutputFlag.STATUS_MESSAGE) && this.statusMessageTs) {
      await this.deps.statusReporter.updateStatusDirect(
        this.channel,
        this.statusMessageTs,
        status,
        this.vtag(OutputFlag.STATUS_MESSAGE)
      );
    }
    if (this.isEnabled(OutputFlag.STATUS_REACTION)) {
      await this.deps.reactionManager.updateReaction(
        this.sessionKey,
        this.deps.statusReporter.getStatusEmoji(status)
      );
    }
  }

  async finish(options: RendererFinishOptions): Promise<void> {
    const { status } = options;

    // Final status message update
    if (this.isEnabled(OutputFlag.STATUS_MESSAGE) && this.statusMessageTs) {
      await this.deps.statusReporter.updateStatusDirect(
        this.channel,
        this.statusMessageTs,
        status,
        this.vtag(OutputFlag.STATUS_MESSAGE)
      );
    }

    // Final reaction update
    if (this.isEnabled(OutputFlag.STATUS_REACTION)) {
      await this.deps.reactionManager.updateReaction(
        this.sessionKey,
        this.deps.statusReporter.getStatusEmoji(status)
      );
    }

    // Clear native spinner
    if (this.isEnabled(OutputFlag.STATUS_SPINNER)) {
      await this.deps.assistantStatusManager.clearStatus(this.channel, this.threadTs);
    }
  }

  async abort(_error?: Error): Promise<void> {
    // Error status message
    if (this.isEnabled(OutputFlag.STATUS_MESSAGE) && this.statusMessageTs) {
      await this.deps.statusReporter.updateStatusDirect(
        this.channel,
        this.statusMessageTs,
        'error',
        this.vtag(OutputFlag.STATUS_MESSAGE)
      );
    }

    // Error reaction
    if (this.isEnabled(OutputFlag.STATUS_REACTION)) {
      await this.deps.reactionManager.updateReaction(
        this.sessionKey,
        this.deps.statusReporter.getStatusEmoji('error')
      );
    }

    // Clear native spinner
    if (this.isEnabled(OutputFlag.STATUS_SPINNER)) {
      await this.deps.assistantStatusManager.clearStatus(this.channel, this.threadTs);
    }
  }

  /** Expose status message ts for StreamExecutor's final status update */
  getStatusMessageTs(): string | undefined {
    return this.statusMessageTs;
  }
}
