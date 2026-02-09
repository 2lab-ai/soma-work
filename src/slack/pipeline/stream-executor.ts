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
import { ActionPanelManager } from '../action-panel-manager';
import { ThreadHeaderBuilder } from '../thread-header-builder';
import { SayFn, MessageEvent } from './types';
import { recordUserTurn, recordAssistantTurn } from '../../conversation';
import { getChannelDescription } from '../../channel-description-cache';

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
  actionPanelManager?: ActionPanelManager;
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

    // Transition to working state
    this.deps.claudeHandler.setActivityState(channel, threadTs, 'working');
    await this.deps.actionPanelManager?.updatePanel(session, sessionKey);

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

      // Create Slack context for permission prompts + channel description for system prompt
      const channelDescription = await getChannelDescription(
        this.deps.slackApi.getClient(),
        channel
      );
      const slackContext = { channel, threadTs, user, channelDescription };

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
        onSessionLinksDetected: async (links) => {
          this.deps.claudeHandler.setSessionLinks(channel, threadTs, links);
          this.logger.info('Session links updated from model directive', {
            sessionKey,
            hasIssue: !!links.issue,
            hasPr: !!links.pr,
            hasDoc: !!links.doc,
          });
        },
        onChannelMessageDetected: async (messageText) => {
          try {
            await this.deps.slackApi.postMessage(channel, messageText, {});
            this.logger.info('Channel root message posted from model directive', {
              sessionKey,
              channel,
              textLength: messageText.length,
            });
          } catch (error) {
            this.logger.error('Failed to post channel root message from model directive', {
              sessionKey,
              channel,
              error: (error as Error).message,
            });
          }
        },
        onUsageUpdate: async (usage: UsageData) => {
          this.updateSessionUsage(session, usage);

          // Update context window emoji
          if (session.usage) {
            const percent = this.deps.contextWindowManager.calculateRemainingPercent(session.usage);
            await this.deps.contextWindowManager.updateContextEmoji(sessionKey, percent);
          }
        },
        onChoiceCreated: async (payload, ctx, sourceMessageTs) => {
          await this.deps.actionPanelManager?.attachChoice(ctx.sessionKey, payload, sourceMessageTs);
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

      // Update status and reaction based on whether user choice is pending
      const finalStatus = streamResult.hasUserChoice ? 'waiting' : 'completed';
      if (statusMessageTs) {
        await this.deps.statusReporter.updateStatusDirect(channel, statusMessageTs, finalStatus);
      }
      await this.deps.reactionManager.updateReaction(
        sessionKey,
        this.deps.statusReporter.getStatusEmoji(finalStatus)
      );
      await this.deps.assistantStatusManager.clearStatus(channel, threadTs);

      // Transition activity state
      this.deps.claudeHandler.setActivityState(
        channel,
        threadTs,
        streamResult.hasUserChoice ? 'waiting' : 'idle'
      );
      await this.deps.actionPanelManager?.updatePanel(session, sessionKey);

      // Record assistant turn (fire-and-forget, non-blocking)
      if (session.conversationId && streamResult.collectedText) {
        recordAssistantTurn(session.conversationId, streamResult.collectedText);
      }

      this.logger.info('Completed processing message', {
        sessionKey,
        messageCount: streamResult.messageCount,
      });

      // Update bot-initiated thread root with status
      if (session.threadModel === 'bot-initiated' && session.threadRootTs) {
        await this.updateThreadRoot(session, channel);
      }

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

      // Handle onboarding completion/skip - transition to real workflow
      if (session.isOnboarding && streamResult.collectedText) {
        const continuation = this.buildOnboardingContinuation(
          session,
          streamResult.collectedText,
          user,
          userName,
          threadTs,
          say
        );
        if (continuation) {
          return { success: true, messageCount: streamResult.messageCount, continuation };
        }
      }

      return { success: true, messageCount: streamResult.messageCount };
    } catch (error: any) {
      const requestAborted = abortController.signal.aborted;
      await this.handleError(
        error,
        session,
        sessionKey,
        channel,
        threadTs,
        statusMessageTs,
        processedFiles,
        say,
        requestAborted
      );
      return { success: false, messageCount: 0 };
    } finally {
      await this.cleanup(session, sessionKey);
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
    say: SayFn,
    requestAborted: boolean = false
  ): Promise<void> {
    // Clear native spinner on any error and reset activity state
    await this.deps.assistantStatusManager.clearStatus(channel, threadTs);
    this.deps.claudeHandler.setActivityState(channel, threadTs, 'idle');

    // Check for context overflow error
    const errorMessage = error.message?.toLowerCase() || '';
    if (
      errorMessage.includes('prompt is too long') ||
      errorMessage.includes('context length exceeded') ||
      errorMessage.includes('maximum context length')
    ) {
      await this.deps.contextWindowManager.handlePromptTooLong(sessionKey);
    }

    const isAbort = requestAborted || this.isAbortLikeError(error);
    if (!isAbort) {
      this.logger.error('Error handling message', error);

      // Only clear session for Claude SDK errors (context overflow, auth, etc.)
      // Preserve session for Slack API errors (invalid_attachments, rate_limited, etc.)
      const isSlackApiError = this.isSlackApiError(error);
      const sessionCleared = !isSlackApiError;

      if (sessionCleared) {
        this.deps.claudeHandler.clearSessionId(channel, threadTs);
        this.logger.info('Session cleared due to non-Slack error', {
          sessionKey,
          errorType: error.name || 'unknown',
        });
      } else {
        this.logger.warn('Slack API error - session preserved', {
          sessionKey,
          errorMessage: error.message,
        });
      }

      if (statusMessageTs) {
        await this.deps.statusReporter.updateStatusDirect(channel, statusMessageTs, 'error');
      }
      await this.deps.reactionManager.updateReaction(
        sessionKey,
        this.deps.statusReporter.getStatusEmoji('error')
      );

      // Notify user with detailed error info
      const errorDetails = this.formatErrorForUser(error, sessionCleared);
      await say({
        text: errorDetails,
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

  private isAbortLikeError(error: any): boolean {
    const name = String(error?.name || '').toLowerCase();
    const message = String(error?.message || '').toLowerCase();

    if (name === 'aborterror') {
      return true;
    }

    return (
      message.includes('aborted by user') ||
      message.includes('process aborted by user') ||
      message.includes('request was aborted') ||
      message.includes('operation was aborted')
    );
  }

  private async cleanup(session: ConversationSession, sessionKey: string): Promise<void> {
    this.deps.requestCoordinator.removeController(sessionKey);
    try {
      await this.deps.actionPanelManager?.updatePanel(session, sessionKey);
    } catch (error) {
      this.logger.debug('Failed to update action panel during cleanup', {
        sessionKey,
        error: (error as Error).message,
      });
    }

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
   * Check if error is a Slack API error (should preserve session)
   * These errors are transient or UI-related, not Claude conversation issues
   */
  private isSlackApiError(error: any): boolean {
    const message = error.message?.toLowerCase() || '';

    // Slack API error patterns
    const slackErrorPatterns = [
      'invalid_attachments',
      'invalid_blocks',
      'rate_limited',
      'channel_not_found',
      'no_permission',
      'not_in_channel',
      'msg_too_long',
      'invalid_arguments',
      'missing_scope',
      'token_revoked',
      'no more than 50 items allowed', // Slack block limit
      'an api error occurred',
    ];

    return slackErrorPatterns.some(pattern => message.includes(pattern));
  }

  /**
   * Format error message for user with detailed info
   * Distinguishes between bot system errors and model errors
   */
  private formatErrorForUser(error: any, sessionCleared: boolean): string {
    const errorType = this.isSlackApiError(error) ? 'Slack API' : 'Claude SDK';
    const errorName = error.name || 'Error';
    const errorMessage = error.message || 'Something went wrong';

    const lines = [
      `❌ *[Bot Error]* ${errorMessage}`,
      '',
      `> *Type:* ${errorType} (${errorName})`,
    ];

    if (sessionCleared) {
      lines.push(`> *Session:* 🔄 초기화됨 - 대화 기록이 리셋되었습니다.`);
      lines.push(`> _다음 메시지부터 새 세션으로 시작됩니다._`);
    } else {
      lines.push(`> *Session:* ✅ 유지됨 - 대화를 계속할 수 있습니다.`);
    }

    return lines.join('\n');
  }

  /**
   * Update the root message of a bot-initiated thread with current status.
   * Shows workflow, activity state, and linked resources.
   */
  private async updateThreadRoot(
    session: ConversationSession,
    channel: string
  ): Promise<void> {
    if (!session.threadRootTs) return;

    try {
      const payload = ThreadHeaderBuilder.fromSession(session);
      await this.deps.slackApi.updateMessage(
        channel,
        session.threadRootTs,
        payload.text,
        payload.blocks,
        payload.attachments
      );
    } catch (error) {
      this.logger.debug('Failed to update thread root', {
        error: (error as Error).message,
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

    const { id, files, path, dir, summary } = saveResult;

    // Try to get save content from files array or fallback to reading from path
    let saveContent: string;

    if (files && files.length > 0) {
      // Preferred: use files array directly
      this.logger.info('Renew save completed, using files array', { id, fileCount: files.length });
      saveContent = files.map((file: { name: string; content: string }) => {
        return `--- ${file.name} ---\n${file.content}`;
      }).join('\n\n');
    } else if (path || dir) {
      // Fallback: try to read from path/dir
      const savePath = path || dir;
      this.logger.info('Renew save completed, attempting file read fallback', { id, savePath });

      try {
        const fs = await import('fs');
        const pathModule = await import('path');

        // Try to read context.md from the save directory
        const contextPath = savePath!.endsWith('.md')
          ? savePath!
          : pathModule.join(savePath!, 'context.md');

        if (fs.existsSync(contextPath)) {
          const content = fs.readFileSync(contextPath, 'utf-8');
          saveContent = `--- context.md ---\n${content}`;
          this.logger.info('Successfully read save file via fallback', { contextPath });
        } else {
          this.logger.warn('Save path does not exist', { contextPath });
          await say({
            text: `⚠️ Save reported success but file not found at: ${contextPath}`,
            thread_ts: threadTs,
          });
          session.renewState = null;
          return undefined;
        }
      } catch (readError) {
        this.logger.warn('Failed to read save file via fallback', { savePath, error: readError });
        await say({
          text: `⚠️ Save reported success but could not read file: ${savePath}`,
          thread_ts: threadTs,
        });
        session.renewState = null;
        return undefined;
      }
    } else {
      // No files and no path - can't proceed
      this.logger.warn('Save succeeded but no files or path returned', { saveResult });
      await say({
        text: '⚠️ Save succeeded but no file content or path was returned.',
        thread_ts: threadTs,
      });
      session.renewState = null;
      return undefined;
    }

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
   * Parse save_result JSON from collected text (lenient parsing)
   * Handles AI output variations:
   * - success: true | status: "saved" | status: "success"
   * - id | save_id
   * - files array or path/dir for fallback
   */
  private parseSaveResult(text: string): {
    success: boolean;
    id?: string;
    dir?: string;
    path?: string;
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
      const raw = parsed.save_result;

      // Normalize the result (lenient parsing)
      // Success detection: success === true OR status === "saved" OR status === "success"
      const success = raw.success === true ||
        raw.status === 'saved' ||
        raw.status === 'success';

      // ID extraction: id OR save_id
      const id = raw.id || raw.save_id;

      // Return normalized result
      return {
        success,
        id,
        dir: raw.dir,
        path: raw.path,
        summary: raw.summary || raw.title,
        files: raw.files,
        error: raw.error,
      };
    } catch (error) {
      this.logger.warn('Failed to parse save_result JSON', { error });
      return null;
    }
  }

  /**
   * Build continuation for onboarding completion/skip
   * When Claude outputs {"onboarding_complete": {...}}, transition to real workflow
   */
  private buildOnboardingContinuation(
    session: ConversationSession,
    collectedText: string,
    userId: string,
    userName: string,
    threadTs: string,
    say: SayFn
  ): Continuation | undefined {
    // Parse onboarding_complete JSON from output
    const result = this.parseOnboardingComplete(collectedText);
    if (!result) {
      return undefined;
    }

    this.logger.info('Onboarding complete detected, building continuation', {
      skipped: result.skipped,
      userMessage: result.user_message?.substring(0, 50),
    });

    // Create user settings record (marks user as onboarded)
    userSettingsStore.ensureUserExists(userId, userName);

    // Clear onboarding flag
    session.isOnboarding = false;

    // If user provided a real task/message, re-dispatch with it
    if (result.user_message) {
      this.logger.info('Onboarding: transitioning to user request', {
        userMessage: result.user_message.substring(0, 100),
      });

      return {
        prompt: result.user_message,
        resetSession: true,
        dispatchText: result.user_message,
      };
    }

    // Onboarding completed without follow-up task - no continuation needed
    return undefined;
  }

  /**
   * Parse onboarding_complete JSON from collected text
   * Expected format: {"onboarding_complete": {"skipped": true/false, "user_message": "..."}}
   */
  private parseOnboardingComplete(text: string): {
    skipped: boolean;
    user_message?: string;
  } | null {
    // Look for {"onboarding_complete": ...} pattern
    const jsonMatch = text.match(/\{"onboarding_complete"\s*:\s*(\{[^}]*\})\}/s);
    if (!jsonMatch) {
      return null;
    }

    try {
      const fullJson = `{"onboarding_complete":${jsonMatch[1]}}`;
      const parsed = JSON.parse(fullJson);
      return parsed.onboarding_complete;
    } catch (error) {
      this.logger.warn('Failed to parse onboarding_complete JSON', { error });
      return null;
    }
  }
}
