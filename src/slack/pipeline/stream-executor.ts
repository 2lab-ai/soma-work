import { ClaudeHandler } from '../../claude-handler';
import { FileHandler, ProcessedFile } from '../../file-handler';
import { userSettingsStore } from '../../user-settings-store';
import { ConversationSession, SessionUsage } from '../../types';
import { Logger } from '../../logger';
import {
  StreamProcessor,
  StreamContext,
  StreamCallbacks,
  UsageData,
  ToolEventProcessor,
  StatusReporter,
  ReactionManager,
  ToolTracker,
  TodoDisplayManager,
  SlackApiHelper,
} from '../index';
import { ActionHandlers } from '../actions';
import { RequestCoordinator } from '../request-coordinator';
import { SayFn, MessageEvent } from './types';

/**
 * Function type for handleMessage callback (used in renew flow)
 */
export type HandleMessageFn = (event: MessageEvent, say: any) => Promise<void>;

// Default context window size (200k for Claude models)
const DEFAULT_CONTEXT_WINDOW = 200000;

interface StreamExecutorDeps {
  claudeHandler: ClaudeHandler;
  fileHandler: FileHandler;
  toolEventProcessor: ToolEventProcessor;
  statusReporter: StatusReporter;
  reactionManager: ReactionManager;
  toolTracker: ToolTracker;
  todoDisplayManager: TodoDisplayManager;
  actionHandlers: ActionHandlers;
  requestCoordinator: RequestCoordinator;
  slackApi: SlackApiHelper;
  /** Optional: handleMessage function for renew flow recursion */
  handleMessage?: HandleMessageFn;
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
    userId: string
  ): Promise<string> {
    // Prepare the prompt with file attachments
    let rawPrompt = processedFiles.length > 0
      ? await this.deps.fileHandler.formatFilePrompt(processedFiles, text || '')
      : text || '';

    // Wrap the prompt with speaker tag
    let finalPrompt = `<speaker>${userName}</speaker>\n${rawPrompt}`;

    // Inject user info
    const userInfo = this.getUserInfoContext(userId);
    if (userInfo) {
      finalPrompt = `${finalPrompt}\n\n${userInfo}`;
    }

    return finalPrompt;
  }

  /**
   * 스트림 실행
   */
  async execute(params: StreamExecuteParams): Promise<{ success: boolean; messageCount: number }> {
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
      const finalPrompt = await this.preparePrompt(text, processedFiles, userName, user);

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

      // Add thinking reaction
      await this.deps.reactionManager.updateReaction(
        sessionKey,
        this.deps.statusReporter.getStatusEmoji('thinking')
      );

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
        onUsageUpdate: (usage: UsageData) => {
          this.updateSessionUsage(session, usage);
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

      // Update status to completed
      if (statusMessageTs) {
        await this.deps.statusReporter.updateStatusDirect(channel, statusMessageTs, 'completed');
      }
      await this.deps.reactionManager.updateReaction(
        sessionKey,
        this.deps.statusReporter.getStatusEmoji('completed')
      );

      this.logger.info('Completed processing message', {
        sessionKey,
        messageCount: streamResult.messageCount,
      });

      // Clean up temporary files
      if (processedFiles.length > 0) {
        await this.deps.fileHandler.cleanupTempFiles(processedFiles);
      }

      // Handle renew flow if in pending_save state
      if (session.renewState === 'pending_save') {
        await this.handleRenewSaveComplete(
          session,
          streamResult.collectedText || '',
          channel,
          threadTs,
          user,
          userName,
          workingDirectory,
          say
        );
      } else if (session.renewState === 'pending_load') {
        // Load completed, clear renew state
        session.renewState = null;
        session.savedWorkflow = undefined;
        this.logger.info('Renew flow completed', { sessionKey });
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
    // Clear sessionId on error
    this.deps.claudeHandler.clearSessionId(channel, threadTs);

    if (error.name !== 'AbortError') {
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
      this.logger.debug('Request was aborted', { sessionKey });

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
        this.deps.statusReporter.cleanup(sessionKey);
      });
    }
  }

  private getUserInfoContext(userId: string): string | null {
    const jiraName = userSettingsStore.getUserJiraName(userId);
    const jiraAccountId = userSettingsStore.getUserJiraAccountId(userId);
    const settings = userSettingsStore.getUserSettings(userId);
    const slackName = settings?.slackName;

    if (!jiraName && !slackName) {
      return null;
    }

    const lines: string[] = ['<user-context>'];
    if (slackName) {
      lines.push(`  <slack-name>${slackName}</slack-name>`);
    }
    if (jiraName) {
      lines.push(`  <jira-name>${jiraName}</jira-name>`);
    }
    if (jiraAccountId) {
      lines.push(`  <jira-account-id>${jiraAccountId}</jira-account-id>`);
    }
    lines.push('</user-context>');

    return lines.join('\n');
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
   * Handle renew flow after save completes
   */
  private async handleRenewSaveComplete(
    session: ConversationSession,
    collectedText: string,
    channel: string,
    threadTs: string,
    user: string,
    userName: string,
    workingDirectory: string,
    say: SayFn
  ): Promise<void> {
    // Check for "Saved to:" pattern in response
    const savedToMatch = collectedText.match(/Saved to:\s*(.+)/i);

    if (!savedToMatch) {
      // Save failed or skill not available
      this.logger.warn('Renew save did not find "Saved to:" pattern', {
        channel,
        threadTs,
        textLength: collectedText.length,
      });
      await say({
        text: '⚠️ Save did not complete as expected. Renew cancelled.\n_The `/save` skill may not be available._',
        thread_ts: threadTs,
      });
      session.renewState = null;
      session.savedWorkflow = undefined;
      return;
    }

    const savePath = savedToMatch[1].trim();
    this.logger.info('Renew save completed', { savePath });

    // Reset session context
    const savedWorkflow = session.savedWorkflow;
    this.deps.claudeHandler.resetSessionContext(channel, threadTs);

    // Restore workflow and set pending_load state
    const currentSession = this.deps.claudeHandler.getSession(channel, threadTs);
    if (currentSession) {
      currentSession.workflow = savedWorkflow;
      currentSession.renewState = 'pending_load';
    }

    await say({
      text: '✅ Context saved. Resetting session and reloading...',
      thread_ts: threadTs,
    });

    // Check if handleMessage is available for recursion
    if (!this.deps.handleMessage) {
      this.logger.warn('handleMessage not available for renew load step');
      await say({
        text: '⚠️ Could not automatically reload context. Use `/load` to restore manually.',
        thread_ts: threadTs,
      });
      if (currentSession) {
        currentSession.renewState = null;
        currentSession.savedWorkflow = undefined;
      }
      return;
    }

    // Create a synthetic event for /load
    const loadEvent: MessageEvent = {
      user,
      channel,
      thread_ts: threadTs,
      ts: Date.now().toString(),
      text: '/load',
    };

    // Create a wrapped say function
    const wrappedSay = async (args: any) => {
      const result = await say({
        text: args.text,
        thread_ts: args.thread_ts,
        blocks: args.blocks,
        attachments: args.attachments,
      });
      return { ts: result?.ts };
    };

    // Recursively call handleMessage with /load
    await this.deps.handleMessage(loadEvent, wrappedSay);
  }
}
