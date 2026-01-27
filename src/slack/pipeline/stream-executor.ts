import { ClaudeHandler } from '../../claude-handler';
import { FileHandler, ProcessedFile } from '../../file-handler';
import { userSettingsStore } from '../../user-settings-store';
import { ConversationSession } from '../../types';
import { Logger } from '../../logger';
import {
  StreamProcessor,
  StreamContext,
  StreamCallbacks,
  ToolEventProcessor,
  StatusReporter,
  ReactionManager,
  ToolTracker,
  TodoDisplayManager,
} from '../index';
import { ActionHandlers } from '../actions';
import { RequestCoordinator } from '../request-coordinator';
import { SayFn } from './types';

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
}
