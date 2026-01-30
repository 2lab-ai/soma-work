import { ClaudeHandler } from '../../claude-handler';
import { FileHandler, ProcessedFile } from '../../file-handler';
import { userSettingsStore } from '../../user-settings-store';
import { ConversationSession, SessionUsage, Continuation } from '../../types';
import { Logger } from '../../logger';
import {
  StreamProcessor,
  StreamContext,
  StreamCallbacks,
  UsageData,
  ToolEventProcessor,
  StatusReporter,
  ReactionManager,
  ContextWindowManager,
  ToolTracker,
  TodoDisplayManager,
  SlackApiHelper,
  AssistantStatusManager,
} from '../index';
import { ActionHandlers } from '../actions';
import { RequestCoordinator } from '../request-coordinator';
import { SayFn, MessageEvent } from './types';
import { recordUserTurn, recordAssistantTurn } from '../../conversation';

/**
 * Result of stream execution
 */
export interface ExecuteResult {
  success: boolean;
  messageCount: number;
  continuation?: Continuation;  // Next action to perform (if any)
}

// Default context window size (200k for Claude models)
const DEFAULT_CONTEXT_WINDOW = 200000;

interface StreamExecutorDeps {
  claudeHandler: ClaudeHandler;
  fileHandler: FileHandler;
  toolEventProcessor: ToolEventProcessor;
  statusReporter: StatusReporter;
  reactionManager: ReactionManager;
  contextWindowManager: ContextWindowManager;
  toolTracker: ToolTracker;
  todoDisplayManager: TodoDisplayManager;
  actionHandlers: ActionHandlers;
  requestCoordinator: RequestCoordinator;
  slackApi: SlackApiHelper;
  assistantStatusManager: AssistantStatusManager;
}

interface StreamExecuteParams {
  session: ConversationSession;
  sessionKey: string;
  userName: string;
  workingDirectory: string;
  abortController: AbortController;
  processedFiles: ProcessedFile[];
  text: string | undefined;
  channel: string;
  threadTs: string;
  user: string;
  say: SayFn;
}

/**
 * 스트림 처리 실행 및 정리
 */
export class StreamExecutor {
  private logger = new Logger('StreamExecutor');

  constructor(private deps: StreamExecutorDeps) {}

  /**
   * 프롬프트 준비
   */
  async preparePrompt(
    text: string | undefined,
    processedFiles: ProcessedFile[],
    userName: string,
    userId: string,
    workingDirectory: string
  ): Promise<string> {
    // Prepare the prompt with file attachments
    let rawPrompt = processedFiles.length > 0
      ? await this.deps.fileHandler.formatFilePrompt(processedFiles, text || '')
      : text || '';

    // Wrap the prompt with speaker tag
    let finalPrompt = `<speaker>${userName}</speaker>\n${rawPrompt}`;

    // Inject user and environment context
    const contextInfo = this.getContextInfo(userId, workingDirectory);
    if (contextInfo) {
      finalPrompt = `${finalPrompt}\n\n${contextInfo}`;
    }

    return finalPrompt;
  }

  /**
   * 스트림 실행
   */
  async execute(params: StreamExecuteParams): Promise<ExecuteResult> {
    const {
      session,
      sessionKey,
      userName,
      workingDirectory,
      abortController,
      processedFiles,
      text,
      channel,
      threadTs,
      user,
      say,
    } = params;

    let statusMessageTs: string | undefined;

    try {
      const finalPrompt = await this.preparePrompt(text, processedFiles, userName, user, workingDirectory);

      // Record user turn (fire-and-forget, non-blocking)
      if (session.conversationId && text) {
        recordUserTurn(session.conversationId, text, userName, user);
      }

      this.logger.info('Sending query to Claude Code SDK', {
        prompt: finalPrompt.substring(0, 200) + (finalPrompt.length > 200 ? '...' : ''),
        sessionId: session.sessionId,
        workingDirectory,
        fileCount: processedFiles.length,
        speaker: userName,
        isOwner: session.ownerId === user,
      });

      // Send initial status message
      statusMessageTs = await this.deps.statusReporter.createStatusMessage(
        channel,
        threadTs,
        sessionKey,
        'thinking'
      );

      // Add thinking reaction + native spinner
      await this.deps.reactionManager.updateReaction(
        sessionKey,
        this.deps.statusReporter.getStatusEmoji('thinking')
      );
      await this.deps.assistantStatusManager.setStatus(channel, threadTs, 'is thinking...');

      // Create Slack context for permission prompts
      const slackContext = { channel, threadTs, user };

      // Create stream context
      const streamContext: StreamContext = {
        channel,
        threadTs,
        sessionKey,
        sessionId: session?.sessionId,
        say: async (msg) => {
          const result = await say({
            text: msg.text,
            thread_ts: msg.thread_ts,
            blocks: msg.blocks,
            attachments: msg.attachments,
          });
          return { ts: result?.ts };
        },
      };

      // Create stream callbacks
      const streamCallbacks: StreamCallbacks = {
        onToolUse: async (toolUses, ctx) => {
          if (statusMessageTs) {
            await this.deps.statusReporter.updateStatusDirect(channel, statusMessageTs, 'working');
          }
          await this.deps.reactionManager.updateReaction(
            sessionKey,
            this.deps.statusReporter.getStatusEmoji('working')
          );
          // Native spinner with tool-specific text
          const toolName = toolUses[0]?.name;
          if (toolName) {
            const statusText = this.deps.assistantStatusManager.getToolStatusText(toolName);
            await this.deps.assistantStatusManager.setStatus(channel, threadTs, statusText);
          }
          await this.deps.toolEventProcessor.handleToolUse(toolUses, {
            channel: ctx.channel,
            threadTs: ctx.threadTs,
            sessionKey: ctx.sessionKey,
            say: ctx.say,
          });
        },
        onToolResult: async (toolResults, ctx) => {
          await this.deps.toolEventProcessor.handleToolResult(toolResults, {
            channel: ctx.channel,
            threadTs: ctx.threadTs,
            sessionKey: ctx.sessionKey,
            say: ctx.say,
          });
        },
        onTodoUpdate: async (input, ctx) => {
          await this.deps.todoDisplayManager.handleTodoUpdate(
            input,
            ctx.sessionKey,
            ctx.sessionId,
            ctx.channel,
            ctx.threadTs,
            ctx.say
          );
        },
        onPendingFormCreate: (formId, form) => {
          this.deps.actionHandlers.setPendingForm(formId, form);
        },
        getPendingForm: (formId) => {
          return this.deps.actionHandlers.getPendingForm(formId);
        },
        onInvalidateOldForms: async (sessionKey, newFormId) => {
          await this.deps.actionHandlers.invalidateOldForms(
            sessionKey,
            newFormId,
            this.deps.slackApi
          );
        },
        onUsageUpdate: async (usage: UsageData) => {
          this.updateSessionUsage(session, usage);

          // Update context window emoji
          if (session.usage) {
            const percent = this.deps.contextWindowManager.calculateRemainingPercent(session.usage);
            await this.deps.contextWindowManager.updateContextEmoji(sessionKey, percent);
          }
        },
      };

      // Create and run stream processor
      const processor = new StreamProcessor(streamCallbacks);
      const streamResult = await processor.process(
        this.deps.claudeHandler.streamQuery(finalPrompt, session, abortController, workingDirectory, slackContext),
        streamContext,
        abortController.signal
      );

      if (streamResult.aborted) {
        const abortError = new Error('Request was aborted');
        abortError.name = 'AbortError';
        throw abortError;
      }

      // Update status to completed + clear native spinner
      if (statusMessageTs) {
        await this.deps.statusReporter.updateStatusDirect(channel, statusMessageTs, 'completed');
      }
      await this.deps.reactionManager.updateReaction(
        sessionKey,
        this.deps.statusReporter.getStatusEmoji('completed')
      );
      await this.deps.assistantStatusManager.clearStatus(channel, threadTs);

      // Record assistant turn (fire-and-forget, non-blocking)
      if (session.conversationId && streamResult.collectedText) {
        recordAssistantTurn(session.conversationId, streamResult.collectedText);
      }

      this.logger.info('Completed processing message', {
        sessionKey,
        messageCount: streamResult.messageCount,
      });

      // Clean up temporary files
      if (processedFiles.length > 0) {
        await this.deps.fileHandler.cleanupTempFiles(processedFiles);
      }

      // Handle renew flow if in pending_save state - return continuation instead of recursing
      if (session.renewState === 'pending_save') {
        const continuation = await this.buildRenewContinuation(
          session,
          streamResult.collectedText || '',
          threadTs,
          say
        );
        if (continuation) {
          return { success: true, messageCount: streamResult.messageCount, continuation };
        }
      }

      return { success: true, messageCount: streamResult.messageCount };
    } catch (error: any) {
      await this.handleError(
        error,
        session,
        sessionKey,
        channel,
        threadTs,
        statusMessageTs,
        processedFiles,
        say
      );
      return { success: false, messageCount: 0 };
    } finally {
      this.cleanup(session, sessionKey);
    }
  }

  private async handleError(
    error: any,
    session: ConversationSession,
    sessionKey: string,
    channel: string,
    threadTs: string,
    statusMessageTs: string | undefined,
    processedFiles: ProcessedFile[],
    say: SayFn
  ): Promise<void> {
    // Clear native spinner on any error
    await this.deps.assistantStatusManager.clearStatus(channel, threadTs);

    // Check for context overflow error
    const errorMessage = error.message?.toLowerCase() || '';
    if (
      errorMessage.includes('prompt is too long') ||
      errorMessage.includes('context length exceeded') ||
      errorMessage.includes('maximum context length')
    ) {
      await this.deps.contextWindowManager.handlePromptTooLong(sessionKey);
    }

    if (error.name !== 'AbortError') {
      // Clear sessionId only on actual errors (not abort)
      // AbortError preserves session history for conversation continuity
      this.deps.claudeHandler.clearSessionId(channel, threadTs);

      this.logger.error('Error handling message', error);

      if (statusMessageTs) {
        await this.deps.statusReporter.updateStatusDirect(channel, statusMessageTs, 'error');
      }
      await this.deps.reactionManager.updateReaction(
        sessionKey,
        this.deps.statusReporter.getStatusEmoji('error')
      );

      await say({
        text: `Error: ${error.message || 'Something went wrong'}`,
        thread_ts: threadTs,
      });
    } else {
      // AbortError - preserve session history for conversation continuity
      this.logger.debug('Request was aborted, preserving session history', { sessionKey });

      if (statusMessageTs) {
        await this.deps.statusReporter.updateStatusDirect(channel, statusMessageTs, 'cancelled');
      }
      await this.deps.reactionManager.updateReaction(
        sessionKey,
        this.deps.statusReporter.getStatusEmoji('cancelled')
      );
    }

    // Clean up temporary files
    if (processedFiles.length > 0) {
      await this.deps.fileHandler.cleanupTempFiles(processedFiles);
    }
  }

  private cleanup(session: ConversationSession, sessionKey: string): void {
    this.deps.requestCoordinator.removeController(sessionKey);

    // Schedule cleanup for todo tracking
    if (session?.sessionId) {
      this.deps.toolTracker.scheduleCleanup(5 * 60 * 1000, () => {
        this.deps.todoDisplayManager.cleanupSession(session.sessionId!);
        this.deps.todoDisplayManager.cleanup(sessionKey);
        this.deps.reactionManager.cleanup(sessionKey);
        this.deps.contextWindowManager.cleanup(sessionKey);
        this.deps.statusReporter.cleanup(sessionKey);
      });
    }
  }

  /**
   * Build context info including user info and environment
   */
  private getContextInfo(userId: string, workingDirectory: string): string {
    const settings = userSettingsStore.getUserSettings(userId);
    const slackName = settings?.slackName;
    const jiraName = userSettingsStore.getUserJiraName(userId);
    const jiraAccountId = userSettingsStore.getUserJiraAccountId(userId);

    const contextItems: string[] = [];

    // User context
    if (slackName) contextItems.push(`  <slack-name>${slackName}</slack-name>`);
    if (jiraName) contextItems.push(`  <jira-name>${jiraName}</jira-name>`);
    if (jiraAccountId) contextItems.push(`  <jira-account-id>${jiraAccountId}</jira-account-id>`);

    // Environment context - always include cwd and timestamp
    contextItems.push(`  <cwd>${workingDirectory}</cwd>`);
    contextItems.push(`  <timestamp>${new Date().toISOString()}</timestamp>`);

    return ['<context>', ...contextItems, '</context>'].join('\n');
  }

  /**
   * Update session usage data from stream result
   */
  private updateSessionUsage(session: ConversationSession, usage: UsageData): void {
    if (!session.usage) {
      session.usage = {
        // Current context (overwritten each request)
        currentInputTokens: 0,
        currentOutputTokens: 0,
        currentCacheReadTokens: 0,
        currentCacheCreateTokens: 0,
        contextWindow: DEFAULT_CONTEXT_WINDOW,
        // Cumulative totals
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCostUsd: 0,
        lastUpdated: Date.now(),
      };
    }

    // Update current context (overwrite - this is the current context window usage)
    // Context window = input (history + new message) + output (current response)
    session.usage.currentInputTokens = usage.inputTokens;
    session.usage.currentOutputTokens = usage.outputTokens;
    session.usage.currentCacheReadTokens = usage.cacheReadInputTokens;
    session.usage.currentCacheCreateTokens = usage.cacheCreationInputTokens;

    // Accumulate totals
    session.usage.totalInputTokens += usage.inputTokens;
    session.usage.totalOutputTokens += usage.outputTokens;
    session.usage.totalCostUsd += usage.totalCostUsd;
    session.usage.lastUpdated = Date.now();

    this.logger.debug('Updated session usage', {
      currentContext: session.usage.currentInputTokens + session.usage.currentOutputTokens,
      totalInput: session.usage.totalInputTokens,
      totalOutput: session.usage.totalOutputTokens,
      totalCostUsd: session.usage.totalCostUsd,
    });
  }

  /**
   * Build continuation for renew flow after save completes
   * Returns Continuation object instead of recursively calling execute()
   */
  private async buildRenewContinuation(
    session: ConversationSession,
    collectedText: string,
    threadTs: string,
    say: SayFn
  ): Promise<Continuation | undefined> {
    // Parse JSON result from save output
    const saveResult = this.parseSaveResult(collectedText);

    if (!saveResult) {
      this.logger.warn('Renew save did not find save_result JSON', {
        textLength: collectedText.length,
      });
      await say({
        text: '⚠️ Save did not complete as expected. Renew cancelled.\n_The `/save` skill may not be available or did not output structured result._',
        thread_ts: threadTs,
      });
      session.renewState = null;
      return undefined;
    }

    if (!saveResult.success) {
      this.logger.warn('Save reported failure', { error: saveResult.error });
      await say({
        text: `⚠️ Save failed: ${saveResult.error || 'Unknown error'}`,
        thread_ts: threadTs,
      });
      session.renewState = null;
      return undefined;
    }

    const { id, files } = saveResult;

    if (!files || files.length === 0) {
      this.logger.warn('Save succeeded but no files returned');
      await say({
        text: '⚠️ Save succeeded but no file content was returned.',
        thread_ts: threadTs,
      });
      session.renewState = null;
      return undefined;
    }

    this.logger.info('Renew save completed, building continuation', { id, fileCount: files.length });

    // Build save content from files array
    const saveContent = files.map((file: { name: string; content: string }) => {
      return `--- ${file.name} ---\n${file.content}`;
    }).join('\n\n');

    // Get user message if provided with /renew command
    const userMessage = session.renewUserMessage;

    // Notify in current thread
    await say({
      text: `✅ *Context saved!* (ID: \`${id}\`)\n\n` +
        `🔄 *Session Reset & Re-dispatch*\n` +
        `• 이전 세션 컨텍스트 초기화됨\n` +
        `• 워크플로우 재분류 후 load 실행...` +
        (userMessage ? `\n• 지시사항: "${userMessage}"` : ''),
      thread_ts: threadTs,
    });

    // Generate the load prompt with optional user instruction
    const userInstruction = userMessage
      ? `\n\nAfter loading the context, execute this user instruction:\n<user-instruction>${userMessage}</user-instruction>`
      : '\n\nContinue with that context. If unsure what to do next, call \'oracle\' agent for guidance.';

    const loadPrompt = `Use 'local:load' skill with this saved context:
<save>
${saveContent}
</save>
${userInstruction}`;

    // Clear renew state and user message
    session.renewState = null;
    session.renewUserMessage = undefined;

    this.logger.info('Renew: returning continuation for load', { id, hasUserMessage: !!userMessage });

    // Return continuation - handleMessage loop will reset session and execute
    // dispatchText is the user's message for workflow classification (not the full load prompt)
    return {
      prompt: loadPrompt,
      resetSession: true,
      dispatchText: userMessage || undefined,
    };
  }

  /**
   * Parse save_result JSON from collected text
   */
  private parseSaveResult(text: string): {
    success: boolean;
    id?: string;
    dir?: string;
    summary?: string;
    files?: Array<{ name: string; content: string }>;
    error?: string;
  } | null {
    // Look for {"save_result": ...} pattern - handle nested JSON with files array
    const jsonMatch = text.match(/\{"save_result"\s*:\s*(\{.*\})\}/s);
    if (!jsonMatch) {
      return null;
    }

    try {
      const fullJson = `{"save_result":${jsonMatch[1]}}`;
      const parsed = JSON.parse(fullJson);
      return parsed.save_result;
    } catch (error) {
      this.logger.warn('Failed to parse save_result JSON', { error });
      return null;
    }
  }
}
