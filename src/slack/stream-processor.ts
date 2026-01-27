/**
 * StreamProcessor - Handles Claude SDK message stream processing
 * Extracted from slack-handler.ts for-await loop (Phase 4.1)
 */

import { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { Logger } from '../logger';
import {
  ToolFormatter,
  UserChoiceHandler,
  MessageFormatter,
} from './index';

/**
 * Context for stream processing
 */
export interface StreamContext {
  channel: string;
  threadTs: string;
  sessionKey: string;
  sessionId?: string;
  say: SayFunction;
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
 * Usage data extracted from result message
 */
export interface UsageData {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  totalCostUsd: number;
}

/**
 * Stream processor callbacks
 */
export interface StreamCallbacks {
  onToolUse?: (toolUses: ToolUseEvent[], context: StreamContext) => Promise<void>;
  onToolResult?: (toolResults: ToolResultEvent[], context: StreamContext) => Promise<void>;
  onTodoUpdate?: TodoUpdateHandler;
  onStatusUpdate?: (status: 'thinking' | 'working' | 'completed' | 'error' | 'cancelled') => Promise<void>;
  onPendingFormCreate?: (formId: string, form: PendingForm) => void;
  getPendingForm?: (formId: string) => PendingForm | undefined;
  /** Called with usage data when stream completes */
  onUsageUpdate?: (usage: UsageData) => void;
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
}

/**
 * StreamProcessor handles the for-await loop over Claude SDK messages
 */
export class StreamProcessor {
  private logger = new Logger('StreamProcessor');
  private callbacks: StreamCallbacks;

  constructor(callbacks: StreamCallbacks = {}) {
    this.callbacks = callbacks;
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

    try {
      for await (const message of stream) {
        if (abortSignal.aborted) {
          return { success: true, messageCount: currentMessages.length, aborted: true };
        }

        this.logger.debug('Received message from Claude SDK', {
          type: message.type,
          subtype: (message as any).subtype,
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

    if (hasToolUse) {
      await this.handleToolUseMessage(content, context);
    } else {
      await this.handleTextMessage(content, context, currentMessages);
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

    // Format and send tool use messages
    const toolContent = ToolFormatter.formatToolUse(content);
    if (toolContent) {
      await context.say({
        text: toolContent,
        thread_ts: context.threadTs,
      });
    }

    // Collect tool use events
    const toolUses: ToolUseEvent[] = [];
    for (const part of content) {
      if (part.type === 'tool_use' && part.id && part.name) {
        toolUses.push({
          id: part.id,
          name: part.name,
          input: part.input,
        });
      }
    }

    // Notify about tool uses
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
    const textContent = this.extractTextContent(content);
    if (!textContent) return;

    currentMessages.push(textContent);

    // Check for user choice JSON
    const { choice, choices, textWithoutChoice } = UserChoiceHandler.extractUserChoice(textContent);

    if (choices) {
      await this.handleMultiChoiceMessage(choices, textWithoutChoice, context);
    } else if (choice) {
      await this.handleSingleChoiceMessage(choice, textWithoutChoice, context);
    } else {
      // Regular message
      const formatted = MessageFormatter.formatMessage(textContent, false);
      await context.say({
        text: formatted,
        thread_ts: context.threadTs,
      });
    }
  }

  /**
   * Handle multi-question choice form
   */
  private async handleMultiChoiceMessage(
    choices: any,
    textWithoutChoice: string,
    context: StreamContext
  ): Promise<void> {
    if (textWithoutChoice) {
      const formatted = MessageFormatter.formatMessage(textWithoutChoice, false);
      await context.say({
        text: formatted,
        thread_ts: context.threadTs,
      });
    }

    const formId = `form_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

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

    // Build and send form
    const multiPayload = UserChoiceHandler.buildMultiChoiceFormBlocks(choices, formId, context.sessionKey);
    const formResult = await context.say({
      text: choices.title || '📋 선택이 필요합니다',
      ...multiPayload,
      thread_ts: context.threadTs,
    });

    // Update form with message timestamp
    if (this.callbacks.getPendingForm && formResult?.ts) {
      const pendingForm = this.callbacks.getPendingForm(formId);
      if (pendingForm) {
        pendingForm.messageTs = formResult.ts;
      }
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
    if (textWithoutChoice) {
      const formatted = MessageFormatter.formatMessage(textWithoutChoice, false);
      await context.say({
        text: formatted,
        thread_ts: context.threadTs,
      });
    }

    const singlePayload = UserChoiceHandler.buildUserChoiceBlocks(choice, context.sessionKey);
    await context.say({
      text: choice.question,
      ...singlePayload,
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

    if (toolResults.length > 0 && this.callbacks.onToolResult) {
      await this.callbacks.onToolResult(toolResults, context);
    }
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

    if (message.subtype === 'success' && message.result) {
      const finalResult = message.result;
      if (finalResult && !currentMessages.includes(finalResult)) {
        currentMessages.push(finalResult);
        await this.handleFinalResult(finalResult, context);
      }
    }

    // Extract usage data from result message
    // SDK uses camelCase: modelUsage (object with model names as keys)
    // Each model's usage has camelCase fields: inputTokens, outputTokens, etc.
    const modelUsageMap = message.modelUsage;
    if (modelUsageMap && typeof modelUsageMap === 'object') {
      // Sum up usage across all models (usually just one)
      let totalInput = 0;
      let totalOutput = 0;
      let totalCacheRead = 0;
      let totalCacheCreation = 0;
      let totalCost = 0;

      for (const modelName of Object.keys(modelUsageMap)) {
        const usage = modelUsageMap[modelName];
        if (usage) {
          totalInput += usage.inputTokens || 0;
          totalOutput += usage.outputTokens || 0;
          totalCacheRead += usage.cacheReadInputTokens || 0;
          totalCacheCreation += usage.cacheCreationInputTokens || 0;
          totalCost += usage.costUSD || 0;
        }
      }

      this.logger.debug('Extracted usage data from modelUsage', {
        inputTokens: totalInput,
        outputTokens: totalOutput,
        cacheRead: totalCacheRead,
        cacheCreation: totalCacheCreation,
        totalCost,
        models: Object.keys(modelUsageMap),
      });

      return {
        inputTokens: totalInput,
        outputTokens: totalOutput,
        cacheReadInputTokens: totalCacheRead,
        cacheCreationInputTokens: totalCacheCreation,
        totalCostUsd: totalCost,
      };
    }

    // Fallback: try direct usage field (older API format)
    const directUsage = message.usage;
    if (directUsage) {
      this.logger.debug('Extracted usage data from direct usage field', {
        inputTokens: directUsage.input_tokens,
        outputTokens: directUsage.output_tokens,
      });
      return {
        inputTokens: directUsage.input_tokens || 0,
        outputTokens: directUsage.output_tokens || 0,
        cacheReadInputTokens: directUsage.cache_read_input_tokens || 0,
        cacheCreationInputTokens: directUsage.cache_creation_input_tokens || 0,
        totalCostUsd: message.total_cost_usd || 0,
      };
    }

    this.logger.warn('No usage data found in result message', {
      messageKeys: Object.keys(message),
    });

    return undefined;
  }

  /**
   * Handle final result text
   */
  private async handleFinalResult(result: string, context: StreamContext): Promise<void> {
    const { choice, choices, textWithoutChoice } = UserChoiceHandler.extractUserChoice(result);

    if (choices) {
      await this.handleMultiChoiceMessage(choices, textWithoutChoice, context);
    } else if (choice) {
      await this.handleSingleChoiceMessage(choice, textWithoutChoice, context);
    } else {
      const formatted = MessageFormatter.formatMessage(result, true);
      await context.say({
        text: formatted,
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
}
