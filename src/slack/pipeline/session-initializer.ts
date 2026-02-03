import { ClaudeHandler } from '../../claude-handler';
import { SlackApiHelper } from '../slack-api-helper';
import { MessageValidator } from '../message-validator';
import { ReactionManager } from '../reaction-manager';
import { ContextWindowManager } from '../context-window-manager';
import { RequestCoordinator } from '../request-coordinator';
import { MessageFormatter } from '../message-formatter';
import { Logger } from '../../logger';
import { MessageEvent, SayFn, SessionInitResult } from './types';
import { getDispatchService } from '../../dispatch-service';
import { ConversationSession } from '../../types';
import { createConversation, getConversationUrl } from '../../conversation';
import { AssistantStatusManager } from '../assistant-status-manager';
import { checkRepoChannelMatch, getChannel } from '../../channel-registry';
import { buildChannelRouteBlocks } from '../actions/channel-route-action-handler';

// Timeout for dispatch API call (30 seconds - Agent SDK needs time to start)
const DISPATCH_TIMEOUT_MS = 30000;

// Track in-flight dispatch calls to prevent race conditions
// Maps sessionKey -> Promise that resolves when dispatch completes
const dispatchInFlight: Map<string, Promise<void>> = new Map();

interface SessionInitializerDeps {
  claudeHandler: ClaudeHandler;
  slackApi: SlackApiHelper;
  messageValidator: MessageValidator;
  reactionManager: ReactionManager;
  contextWindowManager: ContextWindowManager;
  requestCoordinator: RequestCoordinator;
  assistantStatusManager?: AssistantStatusManager;
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
   * @param event - Slack message event
   * @param workingDirectory - Working directory for the session
   * @param effectiveText - Text to use for dispatch (overrides event.text if provided)
   */
  async initialize(
    event: MessageEvent,
    workingDirectory: string,
    effectiveText?: string
  ): Promise<SessionInitResult> {
    const { user, channel, thread_ts, ts, text } = event;
    const threadTs = thread_ts || ts;
    // Use effectiveText for dispatch if provided (e.g., after command parsing)
    const dispatchText = effectiveText ?? text;

    // Get user's display name
    const userName = await this.deps.slackApi.getUserName(user);

    // Session key is based on channel + thread only
    const sessionKey = this.deps.claudeHandler.getSessionKey(channel, threadTs);

    // Store original message info for status reactions and context window tracking
    this.deps.reactionManager.setOriginalMessage(sessionKey, channel, threadTs);
    await this.deps.contextWindowManager.setOriginalMessage(sessionKey, channel, threadTs);

    // Clear lifecycle emojis on any new message (removes stale idle/expired emojis)
    await this.deps.reactionManager.clearSessionLifecycleEmojis(channel, threadTs);

    // Clear any existing completion/waiting reaction when new message arrives
    const currentReaction = this.deps.reactionManager.getCurrentReaction(sessionKey);
    if (currentReaction === 'white_check_mark' || currentReaction === 'raised_hand') {
      this.logger.debug('Clearing stale reaction for new message', { sessionKey, reaction: currentReaction });
      await this.deps.slackApi.removeReaction(channel, threadTs, currentReaction);
      // Reset reaction state so ReactionManager doesn't think it's still set
      this.deps.reactionManager.cleanup(sessionKey);
      this.deps.reactionManager.setOriginalMessage(sessionKey, channel, threadTs);
    }

    // Wake sleeping sessions before proceeding
    if (this.deps.claudeHandler.isSleeping(channel, threadTs)) {
      this.deps.claudeHandler.wakeFromSleep(channel, threadTs);
      // Clear lifecycle emojis (zzz, crescent_moon)
      await this.deps.reactionManager.clearSessionLifecycleEmojis(channel, threadTs);
      this.logger.info('Woke session from sleep', { sessionKey, user: userName });
    }

    // Get or create session
    const existingSession = this.deps.claudeHandler.getSession(channel, threadTs);
    const isNewSession = !existingSession;

    const session = isNewSession
      ? this.deps.claudeHandler.createSession(user, userName, channel, threadTs)
      : existingSession;

    if (isNewSession) {
      this.logger.debug('Creating new session', { sessionKey, owner: userName });

      // Create conversation record and assign ID to session
      try {
        const conversationId = createConversation(channel, threadTs, user, userName);
        session.conversationId = conversationId;

        // Send conversation URL to the thread
        const conversationUrl = getConversationUrl(conversationId);
        await this.deps.slackApi.postMessage(channel, `📝 <${conversationUrl}|View conversation history>`, {
          threadTs,
        });
        this.logger.info('Conversation record created', { conversationId, url: conversationUrl });
      } catch (error) {
        this.logger.error('Failed to create conversation record (non-critical)', error);
      }
    }

    // Dispatch for new sessions OR stuck sessions (e.g., after server restart)
    if (this.deps.claudeHandler.needsDispatch(channel, threadTs)) {
      // Check if dispatch is already in flight for this session (race condition prevention)
      const existingDispatch = dispatchInFlight.get(sessionKey);
      if (existingDispatch) {
        this.logger.debug('Dispatch already in progress, waiting for completion', { sessionKey });
        // Add secondary timeout to prevent infinite hang if existing dispatch never settles
        let waitTimeoutId: ReturnType<typeof setTimeout> | undefined;
        const waitTimeoutPromise = new Promise<void>((_, reject) => {
          waitTimeoutId = setTimeout(() => reject(new Error('Dispatch wait timeout')), DISPATCH_TIMEOUT_MS);
        });
        try {
          await Promise.race([existingDispatch, waitTimeoutPromise]);
        } catch (err) {
          this.logger.warn('Timed out waiting for existing dispatch', { sessionKey, error: (err as Error).message });
          // Fallback: transition to default if still INITIALIZING after timeout
          if (this.deps.claudeHandler.needsDispatch(channel, threadTs)) {
            this.deps.claudeHandler.transitionToMain(channel, threadTs, 'default', 'New Session');
          }
        } finally {
          if (waitTimeoutId) clearTimeout(waitTimeoutId);
        }
      } else if (dispatchText) {
        await this.dispatchWorkflow(channel, threadTs, dispatchText, sessionKey);
      } else {
        // No text available - use default workflow
        this.deps.claudeHandler.transitionToMain(channel, threadTs, 'default', 'New Session');
      }
    } else if (!isNewSession) {
      this.logger.debug('Using existing session', {
        sessionKey,
        sessionId: session.sessionId,
        owner: session.ownerName,
        currentInitiator: session.currentInitiatorName,
        workflow: session.workflow,
      });
    }

    // Check channel-repo routing for PR links after dispatch
    if (isNewSession && session.links?.pr?.url) {
      const routeCheck = checkRepoChannelMatch(session.links.pr.url, channel);

      if (!routeCheck.correct && routeCheck.suggestedChannels.length > 0) {
        // Wrong channel — show advisory with move/stop buttons
        const target = routeCheck.suggestedChannels[0];
        this.logger.info('PR in wrong channel, showing routing advisory', {
          prUrl: session.links.pr.url,
          currentChannel: channel,
          suggestedChannel: target.id,
        });

        // Post advisory first to get its ts for deletion on button click
        const advisoryResult = await this.deps.slackApi.postMessage(channel,
          `🔀 이 repo는 #${target.name} 채널의 작업입니다.`,
          { threadTs }
        );
        const advisoryTs = advisoryResult?.ts || threadTs;

        const { text: advText, blocks } = buildChannelRouteBlocks({
          prUrl: session.links.pr.url,
          targetChannelName: target.name,
          targetChannelId: target.id,
          originalChannel: channel,
          originalTs: advisoryTs,
          userMessage: dispatchText || text || '',
          userId: user,
        });

        // Update advisory with buttons
        if (advisoryTs && advisoryTs !== threadTs) {
          await this.deps.slackApi.updateMessage(channel, advisoryTs, advText, blocks);
        } else {
          await this.deps.slackApi.postMessage(channel, advText, { threadTs, blocks });
        }

        // Don't register AbortController — no stream will run for halted sessions
        return {
          session, sessionKey, isNewSession, userName, workingDirectory,
          abortController: new AbortController(), halted: true,
        };
      } else if (routeCheck.correct) {
        // Correct channel — auto-create bot thread for PR workflow
        const currentChannelInfo = getChannel(channel);
        if (currentChannelInfo) {
          this.logger.info('PR in correct channel, auto-creating bot thread', {
            prUrl: session.links.pr.url,
            channel,
          });

          // Post thread root message (bot owns this message → can update it)
          const prLabel = session.links.pr.label || 'PR';
          const rootText = `⚙️ *${session.title || prLabel}*\n👤 <@${user}> · ${session.links.pr.url}`;
          const rootResult = await this.deps.slackApi.postMessage(channel, rootText);

          if (rootResult?.ts) {
            // Create a NEW session in the bot's thread
            const botSession = this.deps.claudeHandler.createSession(user, userName, channel, rootResult.ts);
            botSession.threadModel = 'bot-initiated';
            botSession.threadRootTs = rootResult.ts;
            botSession.links = session.links;
            botSession.workflow = session.workflow;
            botSession.title = session.title;

            // Transition the bot session to MAIN
            this.deps.claudeHandler.transitionToMain(channel, rootResult.ts, session.workflow || 'default', session.title || 'Session');

            // Terminate the original session (cleanup)
            const origSessionKey = this.deps.claudeHandler.getSessionKey(channel, threadTs);
            this.deps.claudeHandler.terminateSession(origSessionKey);

            // Notify user in original thread
            await this.deps.slackApi.postMessage(channel,
              `🔀 새 스레드에서 작업을 시작합니다 →`,
              { threadTs }
            );

            // Return with the bot session and new threadTs
            const newSessionKey = this.deps.claudeHandler.getSessionKey(channel, rootResult.ts);
            const abortController = this.handleConcurrency(newSessionKey, channel, rootResult.ts, user, userName, botSession);
            this.deps.reactionManager.setOriginalMessage(newSessionKey, channel, rootResult.ts);
            await this.deps.contextWindowManager.setOriginalMessage(newSessionKey, channel, rootResult.ts);

            this.logger.info('Bot-initiated thread created, session migrated', {
              rootTs: rootResult.ts,
              channel,
              newSessionKey,
            });

            return {
              session: botSession,
              sessionKey: newSessionKey,
              isNewSession: true,
              userName,
              workingDirectory,
              abortController,
            };
          }
        }
      }
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
   * Run dispatch for workflow classification
   * Called when session needs re-dispatch (e.g., after /new or /renew)
   * @param channel - Slack channel ID
   * @param threadTs - Thread timestamp
   * @param text - Text to use for classification
   */
  async runDispatch(channel: string, threadTs: string, text: string): Promise<void> {
    const sessionKey = this.deps.claudeHandler.getSessionKey(channel, threadTs);
    if (this.deps.claudeHandler.needsDispatch(channel, threadTs) && text) {
      await this.dispatchWorkflow(channel, threadTs, text, sessionKey);
    } else if (this.deps.claudeHandler.needsDispatch(channel, threadTs)) {
      // No text provided - use default workflow
      this.deps.claudeHandler.transitionToMain(channel, threadTs, 'default', 'Session Reset');
    }
  }

  /**
   * Dispatch to determine workflow based on user message
   * Uses AbortController for proper timeout cancellation
   * Tracks in-flight dispatch to prevent race conditions
   */
  private async dispatchWorkflow(
    channel: string,
    threadTs: string,
    text: string,
    sessionKey: string
  ): Promise<void> {
    // Register dispatch in-flight SYNCHRONOUSLY before any async work
    // This prevents race condition where two messages both pass the check
    let resolveTracking: () => void;
    const trackingPromise = new Promise<void>((resolve) => {
      resolveTracking = resolve;
    });
    dispatchInFlight.set(sessionKey, trackingPromise);

    const startTime = Date.now();
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => {
      const elapsed = Date.now() - startTime;
      this.logger.warn(`⏱️ Dispatch timeout after ${elapsed}ms (limit: ${DISPATCH_TIMEOUT_MS}ms), aborting`, {
        channel,
        threadTs,
        textPreview: text.substring(0, 50),
      });
      abortController.abort();
    }, DISPATCH_TIMEOUT_MS);

    // Track dispatch status message for updating
    let dispatchMessageTs: string | undefined;

    try {
      const dispatchService = getDispatchService();
      const model = dispatchService.getModel();

      // Native spinner during dispatch
      await this.deps.assistantStatusManager?.setStatus(channel, threadTs, 'is analyzing your request...');

      // Add dispatching reaction and post status message
      await this.deps.slackApi.addReaction(channel, threadTs, 'mag'); // 🔍
      const msgResult = await this.deps.slackApi.postMessage(channel, `🔍 _Dispatching... (${model})_`, {
        threadTs,
      });
      dispatchMessageTs = msgResult?.ts;

      this.logger.info('🎯 Starting dispatch classification', {
        channel,
        threadTs,
        textLength: text.length,
        textPreview: text.substring(0, 100),
        timeoutMs: DISPATCH_TIMEOUT_MS,
        model,
        isReady: dispatchService.isReady(),
      });

      const result = await dispatchService.dispatch(text, abortController.signal);

      const elapsed = Date.now() - startTime;
      this.logger.info(`✅ Session workflow set: [${result.workflow}] "${result.title}" (${elapsed}ms)`, {
        channel,
        threadTs,
      });

      // Remove dispatching reaction
      await this.deps.slackApi.removeReaction(channel, threadTs, 'mag');

      // Update dispatch message with workflow result
      if (dispatchMessageTs) {
        await this.deps.slackApi.updateMessage(
          channel,
          dispatchMessageTs,
          `✅ *Workflow:* \`${result.workflow}\` → "${result.title}" _(${elapsed}ms)_`
        );
      }

      // Set thread title in DM history
      await this.deps.assistantStatusManager?.setTitle(channel, threadTs, result.title);

      // Store extracted links on the session
      if (result.links && Object.keys(result.links).length > 0) {
        this.deps.claudeHandler.setSessionLinks(channel, threadTs, result.links);
        this.logger.debug('Stored session links from dispatch', {
          channel, threadTs,
          links: result.links,
        });
      }

      // Transition session to MAIN state with determined workflow
      this.deps.claudeHandler.transitionToMain(channel, threadTs, result.workflow, result.title);
    } catch (error) {
      const elapsed = Date.now() - startTime;
      this.logger.error(`❌ Dispatch failed after ${elapsed}ms, using default workflow`, { error });

      // Remove dispatching reaction
      await this.deps.slackApi.removeReaction(channel, threadTs, 'mag');

      // Update dispatch message with error
      if (dispatchMessageTs) {
        await this.deps.slackApi.updateMessage(
          channel,
          dispatchMessageTs,
          `⚠️ *Workflow:* \`default\` _(dispatch failed after ${elapsed}ms)_`
        );
      }

      // Fallback to default workflow on error
      const fallbackTitle = MessageFormatter.generateSessionTitle(text);
      this.deps.claudeHandler.transitionToMain(channel, threadTs, 'default', fallbackTitle);
    } finally {
      clearTimeout(timeoutId);
      // Clean up the in-flight tracking and resolve waiting promises
      dispatchInFlight.delete(sessionKey);
      resolveTracking!();
    }
  }

  private handleConcurrency(
    sessionKey: string,
    channel: string,
    threadTs: string,
    user: string,
    userName: string,
    session: ConversationSession
  ): AbortController {
    const isRequestActive = this.deps.requestCoordinator.isRequestActive(sessionKey);
    const canInterrupt = this.deps.claudeHandler.canInterrupt(channel, threadTs, user);

    // Handle active request based on interrupt permissions
    if (isRequestActive) {
      if (canInterrupt) {
        this.logger.debug('Cancelling existing request for session', { sessionKey, interruptedBy: userName });
        this.deps.requestCoordinator.abortSession(sessionKey);
      } else {
        this.logger.debug('User cannot interrupt, message will be processed after current response', {
          sessionKey,
          user: userName,
          owner: session.ownerName,
          currentInitiator: session.currentInitiatorName,
        });
      }
    }

    const abortController = new AbortController();
    this.deps.requestCoordinator.setController(sessionKey, abortController);
    this.deps.claudeHandler.updateInitiator(channel, threadTs, user, userName);

    return abortController;
  }
}
