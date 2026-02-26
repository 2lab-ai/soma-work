/**
 * StreamProcessor - Handles Claude SDK message stream processing
 * Extracted from slack-handler.ts for-await loop (Phase 4.1)
 */

import { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { Logger } from '../logger';
import { SessionLinks } from '../types';
import {
  ToolFormatter,
  UserChoiceHandler,
  MessageFormatter,
} from './index';
import { SlackMessagePayload } from './choice-message-builder';
import { SessionLinkDirectiveHandler, ChannelMessageDirectiveHandler } from './directives';
import { OutputFlag, shouldOutput as checkOutputFlag, verboseTag, getToolCallRenderMode, getToolResultRenderMode, getThinkingRenderMode, LOG_DETAIL } from './output-flags';

/**
 * Context for stream processing
 */
export interface StreamContext {
  channel: string;
  threadTs: string;
  sessionKey: string;
  sessionId?: string;
  say: SayFunction;
  /** Verbosity bitmask — controls which output types are shown */
  logVerbosity?: number;
}

/**
 * Slack say function type
 */
export type SayFunction = (message: { text: string; thread_ts: string; blocks?: any[]; attachments?: any[] }) => Promise<{ ts?: string }>;

/**
 * Handler for assistant text messages
 */
export interface AssistantTextHandler {
  (content: string, context: StreamContext): Promise<void>;
}

/**
 * Handler for tool use events
 */
export interface ToolUseHandler {
  (toolUse: ToolUseEvent, context: StreamContext): Promise<void>;
}

/**
 * Handler for tool result events
 */
export interface ToolResultHandler {
  (toolResult: ToolResultEvent, context: StreamContext): Promise<void>;
}

/**
 * Handler for todo updates
 */
export interface TodoUpdateHandler {
  (input: any, context: StreamContext): Promise<void>;
}

/**
 * Handler for final result
 */
export interface ResultHandler {
  (result: string, context: StreamContext): Promise<void>;
}

/**
 * Tool use event data
 */
export interface ToolUseEvent {
  id: string;
  name: string;
  input: any;
}

/**
 * Tool result event data
 */
export interface ToolResultEvent {
  toolUseId: string;
  toolName?: string;
  result: any;
  isError?: boolean;
}

/**
 * Pending form data for multi-choice forms
 */
export interface PendingForm {
  formId: string;
  sessionKey: string;
  channel: string;
  threadTs: string;
  messageTs: string;
  questions: any[];
  selections: Record<string, { choiceId: string; label: string }>;
  createdAt: number;
}

/**
 * Compact mode tool call entry for batch-aware in-place updates
 */
export interface CompactToolCallEntry {
  toolName: string;
  input: any;
  status: 'pending' | 'done' | 'error';
  duration?: number | null;
}

/**
 * Usage data extracted from result message
 */
export interface UsageData {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  totalCostUsd: number;
}

export interface FinalResponseFooterParams {
  context: StreamContext;
  usage?: UsageData;
  durationMs?: number;
}

/**
 * Stream processor callbacks
 */
export interface StreamCallbacks {
  onToolUse?: (toolUses: ToolUseEvent[], context: StreamContext) => Promise<void>;
  onToolResult?: (toolResults: ToolResultEvent[], context: StreamContext) => Promise<void>;
  /** Update an existing message in-place (for compact tool call completion) */
  onUpdateMessage?: (channel: string, ts: string, text: string) => Promise<void>;
  onTodoUpdate?: TodoUpdateHandler;
  onStatusUpdate?: (status: 'thinking' | 'working' | 'completed' | 'error' | 'cancelled') => Promise<void>;
  onPendingFormCreate?: (formId: string, form: PendingForm) => void;
  getPendingForm?: (formId: string) => PendingForm | undefined;
  /** Called to invalidate old forms when a new form is created */
  onInvalidateOldForms?: (sessionKey: string, newFormId: string) => Promise<void>;
  /** Called with usage data when stream completes */
  onUsageUpdate?: (usage: UsageData) => void;
  /** Called when model outputs session_links JSON directive */
  onSessionLinksDetected?: (links: SessionLinks, context: StreamContext) => Promise<void>;
  /** Called when model outputs channel_message JSON directive */
  onChannelMessageDetected?: (messageText: string, context: StreamContext) => Promise<void>;
  /** Called when a user choice UI is rendered */
  onChoiceCreated?: (
    payload: SlackMessagePayload,
    context: StreamContext,
    sourceMessageTs?: string
  ) => Promise<void>;
  /** Called before sending the final assistant message to append footer text */
  buildFinalResponseFooter?: (
    params: FinalResponseFooterParams
  ) => Promise<string | undefined> | string | undefined;
}

/**
 * Stream processing result
 */
export interface StreamResult {
  success: boolean;
  messageCount: number;
  aborted: boolean;
  /** All collected text from the response (for renew pattern detection) */
  collectedText?: string;
  /** Usage data from the result message */
  usage?: UsageData;
  /** Whether the response ended with a user choice/form prompt */
  hasUserChoice?: boolean;
}

/**
 * StreamProcessor handles the for-await loop over Claude SDK messages
 */
export class StreamProcessor {
  private logger = new Logger('StreamProcessor');
  private callbacks: StreamCallbacks;
  private _hasUserChoice = false;
  /** Maps message ts → Map<toolUseId, entry> for compact in-place updates (batch-aware) */
  private compactMessageEntries = new Map<string, Map<string, CompactToolCallEntry>>();
  /** Reverse lookup: toolUseId → message ts */
  private toolUseToMessageTs = new Map<string, string>();
  /** Maps Task tool_use_id → input (for correlating TaskOutput with original Task) */
  private pendingTaskInputs = new Map<string, any>();
  /** Maps background task_id → original Task input metadata (for TaskOutput display) */
  private backgroundTaskMeta = new Map<string, { name?: string; subagentLabel?: string; promptPreview?: string }>();

  constructor(callbacks: StreamCallbacks = {}) {
    this.callbacks = callbacks;
  }

  /** Check whether a given output flag is enabled for the stream's verbosity */
  private shouldOutput(flag: number, context: StreamContext): boolean {
    return checkOutputFlag(flag, context.logVerbosity ?? LOG_DETAIL);
  }

  /** Returns verbose category tag prefix (empty string when not verbose) */
  private vtag(flag: number, context: StreamContext): string {
    return verboseTag(flag, context.logVerbosity ?? LOG_DETAIL);
  }

  /**
   * Process the stream of messages from Claude SDK
   */
  async process(
    stream: AsyncIterable<SDKMessage>,
    context: StreamContext,
    abortSignal: AbortSignal
  ): Promise<StreamResult> {
    const currentMessages: string[] = [];
    let lastUsage: UsageData | undefined;
    this._hasUserChoice = false;

    try {
      for await (const message of stream) {
        if (abortSignal.aborted) {
          return { success: true, messageCount: currentMessages.length, aborted: true };
        }

        this.logger.debug('Received message from Claude SDK', {
          type: message.type,
          subtype: 'subtype' in message ? message.subtype : undefined,
        });

        if (message.type === 'assistant') {
          await this.handleAssistantMessage(message, context, currentMessages);
        } else if (message.type === 'user') {
          await this.handleUserMessage(message, context);
        } else if (message.type === 'result') {
          lastUsage = await this.handleResultMessage(message, context, currentMessages);
        }
      }

      // Call usage update callback if we have usage data
      if (lastUsage && this.callbacks.onUsageUpdate) {
        this.callbacks.onUsageUpdate(lastUsage);
      }

      return {
        success: true,
        messageCount: currentMessages.length,
        aborted: false,
        collectedText: currentMessages.join('\n'),
        usage: lastUsage,
        hasUserChoice: this._hasUserChoice,
      };
    } catch (error: any) {
      if (error.name === 'AbortError') {
        return { success: true, messageCount: currentMessages.length, aborted: true };
      }
      throw error;
    }
  }

  /**
   * Handle assistant message (text or tool use)
   */
  private async handleAssistantMessage(
    message: SDKMessage,
    context: StreamContext,
    currentMessages: string[]
  ): Promise<void> {
    if (message.type !== 'assistant') return;

    const content = message.message.content;
    const hasToolUse = content?.some((part: any) => part.type === 'tool_use');

    // Extract and output thinking blocks (compact+)
    await this.handleThinkingContent(content, context);

    if (hasToolUse) {
      await this.handleToolUseMessage(content, context);
    } else {
      await this.handleTextMessage(content, context, currentMessages);
    }
  }

  /**
   * Extract and output thinking/reasoning content from assistant message
   */
  private async handleThinkingContent(content: any[], context: StreamContext): Promise<void> {
    const thinkingMode = getThinkingRenderMode(context.logVerbosity ?? LOG_DETAIL);
    if (thinkingMode === 'hidden') return;

    const thinkingParts = content
      .filter((part: any) => part.type === 'thinking' && part.thinking)
      .map((part: any) => part.thinking as string);

    if (thinkingParts.length === 0) return;

    const thinkingText = thinkingParts.join('\n\n');
    if (!thinkingText.trim()) return;

    const truncated = this.truncateThinking(thinkingText, thinkingMode);
    if (!truncated) return;

    const tag = this.vtag(OutputFlag.THINKING, context);
    await context.say({
      text: `${tag}💭 _${truncated}_`,
      thread_ts: context.threadTs,
    });
  }

  /** Truncate thinking output based on render mode */
  private truncateThinking(text: string, mode: 'compact' | 'detail' | 'verbose'): string | null {
    const lines = text.split('\n').filter((l) => l.trim());
    if (lines.length === 0) return null;

    switch (mode) {
      case 'compact':
        return ToolFormatter.truncateString(lines[0], 200);
      case 'detail':
        return ToolFormatter.truncateString(lines.slice(0, 10).join('\n'), 2000);
      case 'verbose':
        return ToolFormatter.truncateString(text, 3000);
    }
  }

  /**
   * Handle tool use in assistant message
   */
  private async handleToolUseMessage(content: any[], context: StreamContext): Promise<void> {
    // Notify status update
    if (this.callbacks.onStatusUpdate) {
      await this.callbacks.onStatusUpdate('working');
    }

    // Check for TodoWrite tool
    const todoTool = content.find((part: any) =>
      part.type === 'tool_use' && part.name === 'TodoWrite'
    );
    if (todoTool && this.callbacks.onTodoUpdate) {
      await this.callbacks.onTodoUpdate(todoTool.input, context);
    }

    // Track Task tool inputs for TaskOutput correlation
    for (const part of content) {
      if (part.type === 'tool_use' && part.name === 'Task' && part.id) {
        this.pendingTaskInputs.set(part.id, part.input);
      }
    }

    // Enrich TaskOutput inputs with original Task metadata before formatting
    const enrichedContent = content.map((part: any) => {
      if (part.type === 'tool_use' && part.name === 'TaskOutput') {
        return { ...part, input: this.enrichTaskOutputInput(part.input) };
      }
      return part;
    });

    // Format and send tool use messages (render mode dispatch)
    const toolCallMode = getToolCallRenderMode(context.logVerbosity ?? LOG_DETAIL);
    if (toolCallMode !== 'hidden') {
      const toolContent = ToolFormatter.formatToolUse(enrichedContent, toolCallMode);
      if (toolContent) {
        const tag = this.vtag(OutputFlag.TOOL_CALL, context);
        const result = await context.say({
          text: tag + toolContent,
          thread_ts: context.threadTs,
        });
        // Track message ts + tool info for compact mode in-place updates (batch-aware)
        if (toolCallMode === 'compact' && result?.ts) {
          const ts = result.ts;
          if (!this.compactMessageEntries.has(ts)) {
            this.compactMessageEntries.set(ts, new Map());
          }
          const entries = this.compactMessageEntries.get(ts)!;
          for (const part of enrichedContent) {
            if (part.type === 'tool_use' && part.id) {
              entries.set(part.id, {
                toolName: part.name,
                input: part.input,
                status: 'pending',
              });
              this.toolUseToMessageTs.set(part.id, ts);
            }
          }
        }
      }
    }

    // Collect and notify about tool use events
    const toolUses: ToolUseEvent[] = content
      .filter((part: any) => part.type === 'tool_use' && part.id && part.name)
      .map((part: any) => ({
        id: part.id,
        name: part.name,
        input: part.input,
      }));

    for (const toolUse of toolUses) {
      this.logger.debug('Received tool_use', ToolFormatter.buildToolUseLogSummary(
        toolUse.id,
        toolUse.name,
        toolUse.input
      ));
    }

    if (toolUses.length > 0 && this.callbacks.onToolUse) {
      await this.callbacks.onToolUse(toolUses, context);
    }
  }

  /**
   * Handle text content in assistant message
   */
  private async handleTextMessage(
    content: any[],
    context: StreamContext,
    currentMessages: string[]
  ): Promise<void> {
    let textContent = this.extractTextContent(content);
    if (!textContent) return;

    // Extract response directives: session links first, then user choice
    const linkResult = SessionLinkDirectiveHandler.extract(textContent);
    if (linkResult.links) {
      textContent = linkResult.cleanedText;
      if (this.callbacks.onSessionLinksDetected) {
        await this.callbacks.onSessionLinksDetected(linkResult.links, context);
      }
    }

    const channelMessageResult = ChannelMessageDirectiveHandler.extract(textContent);
    if (channelMessageResult.messageText) {
      textContent = channelMessageResult.cleanedText;
      if (this.callbacks.onChannelMessageDetected) {
        await this.callbacks.onChannelMessageDetected(channelMessageResult.messageText, context);
      }
    }

    if (!textContent.trim()) {
      return;
    }

    currentMessages.push(textContent);

    // Check for user choice JSON
    const { choice, choices, textWithoutChoice } = UserChoiceHandler.extractUserChoice(textContent);

    if (choices) {
      this._hasUserChoice = true;
      await this.handleMultiChoiceMessage(choices, textWithoutChoice, context);
    } else if (choice) {
      this._hasUserChoice = true;
      await this.handleSingleChoiceMessage(choice, textWithoutChoice, context);
    } else {
      // Regular message
      const formatted = MessageFormatter.formatMessage(textContent, false);
      await context.say({
        text: this.vtag(OutputFlag.FINAL_RESULT, context) + formatted,
        thread_ts: context.threadTs,
      });
    }
  }

  // Max questions per form to stay under Slack's 50-block limit
  // Calculation: 2 (header) + 6 (per question) × N + 3 (submit) ≤ 50 → N ≤ 7
  private static readonly MAX_QUESTIONS_PER_FORM = 6;

  /**
   * Handle multi-question choice form
   * Automatically splits into multiple forms if questions exceed MAX_QUESTIONS_PER_FORM
   */
  private async handleMultiChoiceMessage(
    choices: any,
    textWithoutChoice: string,
    context: StreamContext
  ): Promise<void> {
    const questions = choices.questions || [];
    const questionCount = questions.length;

    // Log the original model output for debugging
    this.logger.debug('Received multi-choice form from model', {
      questionCount,
      title: choices.title,
      rawChoices: JSON.stringify(choices),
    });

    if (textWithoutChoice) {
      const formatted = MessageFormatter.formatMessage(textWithoutChoice, false);
      await context.say({
        text: formatted,
        thread_ts: context.threadTs,
      });
    }

    // Split questions into chunks if needed
    const chunks: any[][] = [];
    for (let i = 0; i < questionCount; i += StreamProcessor.MAX_QUESTIONS_PER_FORM) {
      chunks.push(questions.slice(i, i + StreamProcessor.MAX_QUESTIONS_PER_FORM));
    }

    if (chunks.length > 1) {
      this.logger.info('Splitting multi-choice form into multiple messages', {
        totalQuestions: questionCount,
        chunkCount: chunks.length,
        questionsPerChunk: chunks.map(c => c.length),
      });
    }

    // Process each chunk as a separate form
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      const chunkQuestions = chunks[chunkIndex];
      const isFirstChunk = chunkIndex === 0;
      const chunkLabel = chunks.length > 1 ? ` (${chunkIndex + 1}/${chunks.length})` : '';

      const chunkChoices = {
        ...choices,
        title: (choices.title || '선택이 필요합니다') + chunkLabel,
        questions: chunkQuestions,
      };

      await this.sendSingleFormChunk(chunkChoices, context, isFirstChunk);
    }
  }

  /**
   * Send a single form chunk (called by handleMultiChoiceMessage)
   */
  private async sendSingleFormChunk(
    choices: any,
    context: StreamContext,
    invalidateOldForms: boolean
  ): Promise<void> {
    const formId = `form_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

    // Create pending form
    if (this.callbacks.onPendingFormCreate) {
      this.callbacks.onPendingFormCreate(formId, {
        formId,
        sessionKey: context.sessionKey,
        channel: context.channel,
        threadTs: context.threadTs,
        messageTs: '',
        questions: choices.questions,
        selections: {},
        createdAt: Date.now(),
      });
    }

    // Invalidate old forms only for the first chunk
    if (invalidateOldForms && this.callbacks.onInvalidateOldForms) {
      await this.callbacks.onInvalidateOldForms(context.sessionKey, formId);
    }

    // Build and send form
    const multiPayload = UserChoiceHandler.buildMultiChoiceFormBlocks(choices, formId, context.sessionKey);

    // Log block count
    const blockCount = multiPayload.attachments?.[0]?.blocks?.length ?? 0;
    this.logger.debug('Built multi-choice form blocks', {
      formId,
      blockCount,
      questionCount: choices.questions?.length,
    });

    try {
      const formResult = await context.say({
        text: choices.title || '📋 선택이 필요합니다',
        ...multiPayload,
        thread_ts: context.threadTs,
      });

      if (this.callbacks.onChoiceCreated) {
        await this.callbacks.onChoiceCreated(multiPayload, context, formResult?.ts);
      }

      // Update form with message timestamp
      if (this.callbacks.getPendingForm && formResult?.ts) {
        const pendingForm = this.callbacks.getPendingForm(formId);
        if (pendingForm) {
          pendingForm.messageTs = formResult.ts;
        }
      }
    } catch (error: any) {
      this.logger.error('Failed to send multi-choice form to Slack', {
        error: error.message,
        blockCount,
        questionCount: choices.questions?.length,
        rawChoices: JSON.stringify(choices),
      });

      // Fallback: send as plain text instead of throwing
      await this.sendChoiceFallback(choices, context, 'multi');
    }
  }

  /**
   * Handle single choice message
   */
  private async handleSingleChoiceMessage(
    choice: any,
    textWithoutChoice: string,
    context: StreamContext
  ): Promise<void> {
    // Log the original model output for debugging
    this.logger.debug('Received single choice from model', {
      question: choice.question,
      choiceCount: choice.choices?.length,
      rawChoice: JSON.stringify(choice),
    });

    if (textWithoutChoice) {
      const formatted = MessageFormatter.formatMessage(textWithoutChoice, false);
      await context.say({
        text: formatted,
        thread_ts: context.threadTs,
      });
    }

    const singlePayload = UserChoiceHandler.buildUserChoiceBlocks(choice, context.sessionKey);

    // Log block count
    const blockCount = singlePayload.attachments?.[0]?.blocks?.length ?? 0;
    this.logger.debug('Built single choice blocks', { blockCount });

    try {
      const choiceResult = await context.say({
        text: choice.question,
        ...singlePayload,
        thread_ts: context.threadTs,
      });

      if (this.callbacks.onChoiceCreated) {
        await this.callbacks.onChoiceCreated(singlePayload, context, choiceResult?.ts);
      }
    } catch (error: any) {
      this.logger.error('Failed to send single choice to Slack', {
        error: error.message,
        blockCount,
        rawChoice: JSON.stringify(choice),
      });

      // Fallback: send as plain text instead of throwing
      await this.sendChoiceFallback(choice, context, 'single');
    }
  }

  /**
   * Send choice as plain text when Slack blocks fail
   */
  private async sendChoiceFallback(
    choice: any,
    context: StreamContext,
    type: 'single' | 'multi'
  ): Promise<void> {
    this.logger.warn('Sending choice as fallback plain text', { type });

    let fallbackText: string;

    if (type === 'multi') {
      // Multi-choice form fallback
      const questions = choice.questions || [];
      const lines = [
        `📋 *${choice.title || '선택이 필요합니다'}*`,
        choice.description ? `_${choice.description}_` : '',
        '',
        ...questions.map((q: any, idx: number) => {
          const optionsList = (q.choices || [])
            .map((opt: any, optIdx: number) => `  ${optIdx + 1}. ${opt.label}${opt.description ? ` - ${opt.description}` : ''}`)
            .join('\n');
          return `*Q${idx + 1}. ${q.question}*\n${optionsList}`;
        }),
        '',
        '_⚠️ 버튼 UI 생성에 실패하여 텍스트로 표시됩니다. 번호로 응답해주세요._',
        '_예: Q1: 1, Q2: 2, Q3: 1_',
      ];
      fallbackText = lines.filter(l => l !== '').join('\n');
    } else {
      // Single choice fallback
      const options = (choice.choices || [])
        .map((opt: any, idx: number) => `${idx + 1}. ${opt.label}${opt.description ? ` - ${opt.description}` : ''}`)
        .join('\n');
      fallbackText = [
        `❓ *${choice.question}*`,
        choice.context ? `_${choice.context}_` : '',
        '',
        options,
        '',
        '_⚠️ 버튼 UI 생성에 실패하여 텍스트로 표시됩니다. 번호로 응답해주세요._',
      ].filter(l => l !== '').join('\n');
    }

    await context.say({
      text: fallbackText,
      thread_ts: context.threadTs,
    });
  }

  /**
   * Handle user message (typically tool results)
   */
  private async handleUserMessage(message: any, context: StreamContext): Promise<void> {
    const content = message.message?.content || message.content;

    this.logger.debug('Processing user message for tool results', {
      hasContent: !!content,
      contentType: typeof content,
      isArray: Array.isArray(content),
    });

    if (!content) return;

    const toolResults = ToolFormatter.extractToolResults(content);

    // Correlate Task results with background task IDs for TaskOutput display
    this.correlateTaskResults(toolResults);

    // Compact mode: update tool call messages in-place (batch-aware)
    const resultMode = getToolResultRenderMode(context.logVerbosity ?? LOG_DETAIL);
    if (resultMode === 'compact' && this.callbacks.onUpdateMessage) {
      // Collect which message ts's need rebuilding
      const affectedTs = new Set<string>();
      for (const tr of toolResults) {
        const ts = this.toolUseToMessageTs.get(tr.toolUseId);
        if (!ts) continue;
        const entries = this.compactMessageEntries.get(ts);
        if (!entries) continue;
        const entry = entries.get(tr.toolUseId);
        if (!entry) continue;

        // Enrich TaskOutput with original Task metadata
        if (entry.toolName === 'TaskOutput') {
          entry.input = this.enrichTaskOutputInput(entry.input);
        }

        entry.status = tr.isError ? 'error' : 'done';
        affectedTs.add(ts);
      }

      // Rebuild and update all affected messages
      for (const ts of affectedTs) {
        await this.rebuildCompactMessage(ts, context.channel);
      }
    }

    if (toolResults.length > 0 && this.callbacks.onToolResult) {
      await this.callbacks.onToolResult(toolResults, context);
    }
  }

  /**
   * Rebuild a compact message from all tracked tool entries for the given ts.
   * Each line shows the correct status icon (⏳/⚪/🟢/🔴) and optional duration.
   */
  private async rebuildCompactMessage(ts: string, channel: string): Promise<void> {
    const entries = this.compactMessageEntries.get(ts);
    if (!entries || !this.callbacks.onUpdateMessage) return;

    const lines: string[] = [];
    for (const [, entry] of entries) {
      if (entry.status === 'done' || entry.status === 'error') {
        lines.push(ToolFormatter.formatOneLineToolComplete(
          entry.toolName, entry.input, entry.status === 'error', entry.duration
        ));
      } else {
        const isAsync = entry.toolName.startsWith('mcp__') || entry.toolName === 'Task';
        const icon = isAsync ? '⏳' : '⚪';
        lines.push(`${icon} ${ToolFormatter.formatOneLineToolUse(entry.toolName, entry.input)}`);
      }
    }

    const text = lines.join('\n');
    await this.callbacks.onUpdateMessage(channel, ts, text);

    // Cleanup fully completed messages
    const allDone = Array.from(entries.values()).every(e => e.status !== 'pending');
    if (allDone) {
      for (const toolUseId of entries.keys()) {
        this.toolUseToMessageTs.delete(toolUseId);
      }
      this.compactMessageEntries.delete(ts);
    }
  }

  /**
   * Update a tool call entry with duration (called by tool-event-processor after MCP completes).
   * Triggers a rebuild of the compact message containing this tool.
   */
  async updateToolCallDuration(toolUseId: string, duration: number | null, channel: string): Promise<void> {
    const ts = this.toolUseToMessageTs.get(toolUseId);
    if (!ts) return;
    const entries = this.compactMessageEntries.get(ts);
    if (!entries) return;
    const entry = entries.get(toolUseId);
    if (!entry) return;

    entry.duration = duration;
    await this.rebuildCompactMessage(ts, channel);
  }

  /**
   * Handle result message (completion)
   * @returns Usage data extracted from the message
   */
  private async handleResultMessage(
    message: any,
    context: StreamContext,
    currentMessages: string[]
  ): Promise<UsageData | undefined> {
    this.logger.info('Received result from Claude SDK', {
      subtype: message.subtype,
      hasResult: message.subtype === 'success' && !!message.result,
      totalCost: message.total_cost_usd,
      duration: message.duration_ms,
    });

    const usage = this.extractUsageData(message);

    if (message.subtype === 'success' && message.result) {
      const finalResult = message.result;
      if (finalResult && !currentMessages.includes(finalResult)) {
        currentMessages.push(finalResult);
        await this.handleFinalResult(finalResult, context, usage, message.duration_ms);
      }
    }

    return usage;
  }

  /**
   * Extract usage data from result message
   * Supports both modelUsage (new SDK) and direct usage field (older API)
   */
  private extractUsageData(message: any): UsageData | undefined {
    // Try modelUsage first (SDK uses camelCase with model names as keys)
    const modelUsageMap = message.modelUsage;
    if (modelUsageMap && typeof modelUsageMap === 'object') {
      const usage = this.aggregateModelUsage(modelUsageMap);
      this.logger.debug('Extracted usage data from modelUsage', {
        ...usage,
        models: Object.keys(modelUsageMap),
      });
      return usage;
    }

    // Fallback: try direct usage field (older API format)
    const directUsage = message.usage;
    if (directUsage) {
      const usage: UsageData = {
        inputTokens: directUsage.input_tokens || 0,
        outputTokens: directUsage.output_tokens || 0,
        cacheReadInputTokens: directUsage.cache_read_input_tokens || 0,
        cacheCreationInputTokens: directUsage.cache_creation_input_tokens || 0,
        totalCostUsd: message.total_cost_usd || 0,
      };
      this.logger.debug('Extracted usage data from direct usage field', usage);
      return usage;
    }

    this.logger.warn('No usage data found in result message', {
      messageKeys: Object.keys(message),
    });
    return undefined;
  }

  /**
   * Aggregate usage across all models in modelUsage map
   */
  private aggregateModelUsage(modelUsageMap: Record<string, any>): UsageData {
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalCacheCreation = 0;
    let totalCost = 0;

    for (const usage of Object.values(modelUsageMap)) {
      if (usage) {
        totalInput += usage.inputTokens || 0;
        totalOutput += usage.outputTokens || 0;
        totalCacheRead += usage.cacheReadInputTokens || 0;
        totalCacheCreation += usage.cacheCreationInputTokens || 0;
        totalCost += usage.costUSD || 0;
      }
    }

    return {
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cacheReadInputTokens: totalCacheRead,
      cacheCreationInputTokens: totalCacheCreation,
      totalCostUsd: totalCost,
    };
  }

  /**
   * Handle final result text
   */
  private async handleFinalResult(
    result: string,
    context: StreamContext,
    usage?: UsageData,
    durationMs?: number
  ): Promise<void> {
    // Extract response directives before user choice
    let processedResult = result;
    const linkResult = SessionLinkDirectiveHandler.extract(processedResult);
    if (linkResult.links) {
      processedResult = linkResult.cleanedText;
      if (this.callbacks.onSessionLinksDetected) {
        await this.callbacks.onSessionLinksDetected(linkResult.links, context);
      }
    }

    const channelMessageResult = ChannelMessageDirectiveHandler.extract(processedResult);
    if (channelMessageResult.messageText) {
      processedResult = channelMessageResult.cleanedText;
      if (this.callbacks.onChannelMessageDetected) {
        await this.callbacks.onChannelMessageDetected(channelMessageResult.messageText, context);
      }
    }

    if (!processedResult.trim()) {
      return;
    }

    let footer: string | undefined;
    if (this.callbacks.buildFinalResponseFooter) {
      footer = await this.callbacks.buildFinalResponseFooter({
        context,
        usage,
        durationMs,
      });
    }

    const combinedResult = footer ? `${processedResult}\n\n${footer}` : processedResult;
    const { choice, choices, textWithoutChoice } = UserChoiceHandler.extractUserChoice(combinedResult);

    if (choices) {
      this._hasUserChoice = true;
      await this.handleMultiChoiceMessage(choices, textWithoutChoice, context);
    } else if (choice) {
      this._hasUserChoice = true;
      await this.handleSingleChoiceMessage(choice, textWithoutChoice, context);
    } else {
      const formatted = MessageFormatter.formatMessage(combinedResult, true);
      await context.say({
        text: this.vtag(OutputFlag.FINAL_RESULT, context) + formatted,
        thread_ts: context.threadTs,
      });
    }
  }

  /**
   * Extract text content from message content array
   */
  private extractTextContent(content: any[]): string | null {
    if (!content) return null;

    const textParts = content
      .filter((part: any) => part.type === 'text')
      .map((part: any) => part.text);

    return textParts.length > 0 ? textParts.join('') : null;
  }

  /**
   * Correlate Task tool results with background task IDs.
   * When a background Task result returns, it contains the task_id.
   * We store the original Task input metadata keyed by task_id for later TaskOutput use.
   */
  private correlateTaskResults(toolResults: ToolResultEvent[]): void {
    for (const tr of toolResults) {
      const taskInput = this.pendingTaskInputs.get(tr.toolUseId);
      if (!taskInput) continue;

      // Extract task_id from the result text (SDK returns it in the result)
      const taskId = this.extractTaskIdFromResult(tr.result);
      if (taskId) {
        const summary = ToolFormatter.getTaskToolSummary(taskInput);
        this.backgroundTaskMeta.set(taskId, {
          name: summary.subagentLabel || summary.subagentType,
          subagentLabel: summary.subagentLabel,
          promptPreview: summary.promptPreview,
        });
      }
      this.pendingTaskInputs.delete(tr.toolUseId);
    }
  }

  /**
   * Extract task_id from a Task tool result.
   * The SDK returns text like "Task started in background. output_file: /path task_id: abc123"
   * or the result may contain structured data.
   */
  private extractTaskIdFromResult(result: any): string | undefined {
    if (!result) return undefined;

    // If result is a string, search for task_id pattern
    if (typeof result === 'string') {
      const match = result.match(/task_id[:\s]+(\S+)/i);
      return match?.[1];
    }

    // If result is an array (common SDK format), search text parts
    if (Array.isArray(result)) {
      for (const part of result) {
        const text = typeof part === 'string' ? part : part?.text;
        if (typeof text === 'string') {
          const match = text.match(/task_id[:\s]+(\S+)/i);
          if (match) return match[1];
        }
      }
    }

    return undefined;
  }

  /**
   * Enrich TaskOutput input with original Task metadata for display.
   * Adds _taskMeta to the input so the formatter can show meaningful info.
   */
  private enrichTaskOutputInput(input: any): any {
    const taskId = input?.task_id;
    if (!taskId) return input;

    const meta = this.backgroundTaskMeta.get(taskId);
    if (!meta) return input;

    return { ...input, _taskMeta: meta };
  }
}
