import { ClaudeHandler } from '../../claude-handler';
import { SlackApiHelper } from '../slack-api-helper';
import { MessageValidator } from '../message-validator';
import { ReactionManager } from '../reaction-manager';
import { RequestCoordinator } from '../request-coordinator';
import { MessageFormatter } from '../message-formatter';
import { Logger } from '../../logger';
import { MessageEvent, SayFn, SessionInitResult } from './types';
import { getDispatchService } from '../../dispatch-service';

interface SessionInitializerDeps {
  claudeHandler: ClaudeHandler;
  slackApi: SlackApiHelper;
  messageValidator: MessageValidator;
  reactionManager: ReactionManager;
  requestCoordinator: RequestCoordinator;
}

/**
 * 세션 초기화 및 동시성 제어
 */
export class SessionInitializer {
  private logger = new Logger('SessionInitializer');

  constructor(private deps: SessionInitializerDeps) {}

  /**
   * 작업 디렉토리 검증
   */
  async validateWorkingDirectory(
    event: MessageEvent,
    say: SayFn
  ): Promise<{ valid: boolean; workingDirectory?: string }> {
    const { user, channel, thread_ts, ts } = event;

    const cwdValidation = this.deps.messageValidator.validateWorkingDirectory(user, channel, thread_ts);
    if (!cwdValidation.valid) {
      await say({
        text: cwdValidation.errorMessage!,
        thread_ts: thread_ts || ts,
      });
      return { valid: false };
    }

    return { valid: true, workingDirectory: cwdValidation.workingDirectory! };
  }

  /**
   * 세션 초기화 및 동시성 제어
   */
  async initialize(
    event: MessageEvent,
    workingDirectory: string
  ): Promise<SessionInitResult> {
    const { user, channel, thread_ts, ts, text } = event;
    const threadTs = thread_ts || ts;

    // Get user's display name
    const userName = await this.deps.slackApi.getUserName(user);

    // Session key is based on channel + thread only
    const sessionKey = this.deps.claudeHandler.getSessionKey(channel, threadTs);

    // Store original message info for status reactions
    this.deps.reactionManager.setOriginalMessage(sessionKey, channel, threadTs);

    // Get or create session
    const existingSession = this.deps.claudeHandler.getSession(channel, threadTs);
    const isNewSession = !existingSession;

    const session = isNewSession
      ? this.deps.claudeHandler.createSession(user, userName, channel, threadTs)
      : existingSession;

    if (isNewSession) {
      this.logger.debug('Creating new session', { sessionKey, owner: userName });

      // Dispatch to determine workflow (for new sessions)
      if (text) {
        await this.dispatchWorkflow(channel, threadTs, text);
      } else {
        // No text - default workflow
        this.deps.claudeHandler.transitionToMain(channel, threadTs, 'default', 'New Session');
      }
    } else {
      this.logger.debug('Using existing session', {
        sessionKey,
        sessionId: session.sessionId,
        owner: session.ownerName,
        currentInitiator: session.currentInitiatorName,
        workflow: session.workflow,
      });
    }

    // Handle concurrency control
    const abortController = this.handleConcurrency(
      sessionKey,
      channel,
      threadTs,
      user,
      userName,
      session
    );

    return {
      session,
      sessionKey,
      isNewSession,
      userName,
      workingDirectory,
      abortController,
    };
  }

  /**
   * Dispatch to determine workflow based on user message
   */
  private async dispatchWorkflow(
    channel: string,
    threadTs: string,
    text: string
  ): Promise<void> {
    try {
      const dispatchService = getDispatchService();
      this.logger.debug('Dispatching message to determine workflow', {
        channel,
        threadTs,
        textLength: text.length,
      });

      const result = await dispatchService.dispatch(text);

      this.logger.info('Dispatch completed', {
        channel,
        threadTs,
        workflow: result.workflow,
        title: result.title,
      });

      // Transition session to MAIN state with determined workflow
      this.deps.claudeHandler.transitionToMain(channel, threadTs, result.workflow, result.title);
    } catch (error) {
      this.logger.error('Dispatch failed, using default workflow', { error });
      // Fallback to default workflow on error
      const fallbackTitle = MessageFormatter.generateSessionTitle(text);
      this.deps.claudeHandler.transitionToMain(channel, threadTs, 'default', fallbackTitle);
    }
  }

  private handleConcurrency(
    sessionKey: string,
    channel: string,
    threadTs: string,
    user: string,
    userName: string,
    session: any
  ): AbortController {
    // Check if this user can interrupt the current response
    const canInterrupt = this.deps.claudeHandler.canInterrupt(channel, threadTs, user);

    // Cancel existing request only if user can interrupt
    if (this.deps.requestCoordinator.isRequestActive(sessionKey) && canInterrupt) {
      this.logger.debug('Cancelling existing request for session', { sessionKey, interruptedBy: userName });
      this.deps.requestCoordinator.abortSession(sessionKey);
    } else if (this.deps.requestCoordinator.isRequestActive(sessionKey) && !canInterrupt) {
      this.logger.debug('User cannot interrupt, message will be processed after current response', {
        sessionKey,
        user: userName,
        owner: session.ownerName,
        currentInitiator: session.currentInitiatorName,
      });
    }

    const abortController = new AbortController();
    this.deps.requestCoordinator.setController(sessionKey, abortController);

    // Update the current initiator
    this.deps.claudeHandler.updateInitiator(channel, threadTs, user, userName);

    return abortController;
  }
}
