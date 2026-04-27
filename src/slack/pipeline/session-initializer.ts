import * as fs from 'fs';
import {
  expectedHandoffKind,
  HandoffAbortError,
  isZHandoffWorkflow,
  parseHandoff,
} from 'somalib/model-commands/handoff-parser';
import type { ZHandoffWorkflow } from 'somalib/model-commands/session-types';
import { getAdminUsers } from '../../admin-utils';
import { checkRepoChannelMatch, getAllChannels, getChannel, registerChannel } from '../../channel-registry';
import type { ClaudeHandler } from '../../claude-handler';
import { createConversation, getConversationUrl } from '../../conversation';
import { scheduleLinkDerivedTitleRefresh } from '../../conversation/link-derived-title';
import { getDispatchService } from '../../dispatch-service';
import { Logger } from '../../logger';
import type { ConversationSession, WorkflowType } from '../../types';
import { userSettingsStore } from '../../user-settings-store';
import type { WorkingDirectoryManager } from '../../working-directory-manager';
import { buildChannelRouteBlocks } from '../actions/channel-route-action-handler';
import type { AssistantStatusManager } from '../assistant-status-manager';
import type { ContextWindowManager } from '../context-window-manager';
import { DispatchAbortError } from '../dispatch-abort';
import { MessageFormatter } from '../message-formatter';
import type { MessageValidator } from '../message-validator';
import { LOG_DETAIL, OutputFlag, shouldOutput } from '../output-flags';
import type { ReactionManager } from '../reaction-manager';
import type { RequestCoordinator } from '../request-coordinator';
import type { SlackApiHelper } from '../slack-api-helper';
import { ThreadHeaderBuilder } from '../thread-header-builder';
import type { ThreadPanel } from '../thread-panel';
import { shouldRunLegacyB4Path } from './effective-phase';
import type { MessageEvent, SayFn, SessionInitResult } from './types';

// Timeout for dispatch API call (30 seconds - Agent SDK needs time to start)
const DISPATCH_TIMEOUT_MS = 30000;

/** Session title surface shown when entering via a z handoff entrypoint (#695). */
const HANDOFF_ENTRY_TITLES: Record<ZHandoffWorkflow, string> = {
  'z-plan-to-work': 'z handoff (plan→work)',
  'z-epic-update': 'z handoff (epic update)',
};

// Track in-flight dispatch calls to prevent race conditions
// Maps sessionKey -> Promise that resolves when dispatch completes
const dispatchInFlight: Map<string, Promise<void>> = new Map();

interface SessionInitializerDeps {
  claudeHandler: ClaudeHandler;
  slackApi: SlackApiHelper;
  messageValidator: MessageValidator;
  workingDirManager: WorkingDirectoryManager;
  reactionManager: ReactionManager;
  contextWindowManager: ContextWindowManager;
  requestCoordinator: RequestCoordinator;
  assistantStatusManager?: AssistantStatusManager;
  threadPanel?: ThreadPanel;
}

type ChannelRouteBlockParams = Parameters<typeof buildChannelRouteBlocks>[0];

/**
 * 세션 초기화 및 동시성 제어
 */
export class SessionInitializer {
  private logger = new Logger('SessionInitializer');

  constructor(private deps: SessionInitializerDeps) {}

  /**
   * Transfer sourceWorkingDirs ownership from one session to another.
   * Clears the source session's dirs so its cleanup won't delete them,
   * then re-registers each dir in the target session. Dirs that fail
   * to register are rolled back to the source session for cleanup.
   */
  private transferSourceWorkingDirs(
    sourceSession: ConversationSession,
    targetChannel: string,
    targetThreadTs: string,
  ): void {
    if (!sourceSession.sourceWorkingDirs?.length) return;

    const transferDirs = [...sourceSession.sourceWorkingDirs];
    sourceSession.sourceWorkingDirs = [];

    const failedDirs: string[] = [];
    for (const dir of transferDirs) {
      const ok = this.deps.claudeHandler.addSourceWorkingDir(targetChannel, targetThreadTs, dir);
      if (!ok) {
        this.logger.warn('Failed to re-register sourceWorkingDir in target session', { dir });
        failedDirs.push(dir);
      }
    }
    if (failedDirs.length > 0) {
      sourceSession.sourceWorkingDirs = failedDirs;
    }
  }

  /**
   * 작업 디렉토리 검증
   */
  async validateWorkingDirectory(
    event: MessageEvent,
    say: SayFn,
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
    effectiveText?: string,
    forceWorkflow?: WorkflowType,
  ): Promise<SessionInitResult> {
    const { user, channel, thread_ts, ts, text } = event;
    const threadTs = thread_ts || ts;
    // Use effectiveText for dispatch if provided (e.g., after command parsing)
    const dispatchText = effectiveText ?? text;
    const skipAutoBotThread = event.routeContext?.skipAutoBotThread === true;
    // Whether the mention originated from inside an existing thread (thread_ts exists).
    // Used for sourceThread data linking — NOT for UX decisions.
    // New sessions always get "new conversation" UX regardless of origin.
    const hasSourceThread = thread_ts !== undefined;

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
      ? this.deps.claudeHandler.createSession(user, userName, channel, threadTs, event.modelOverride)
      : existingSession;

    // Apply model override to existing sessions too (cron may inject into idle session)
    if (!isNewSession && event.modelOverride && session.model !== event.modelOverride) {
      session.model = event.modelOverride;
      this.logger.info('Applied cron model override to existing session', { sessionKey, model: event.modelOverride });
    }

    if (isNewSession) {
      this.logger.debug('Creating new session', { sessionKey, owner: userName });

      // Create session-unique working directory for isolation
      const sessionDir = this.deps.workingDirManager.createSessionBaseDir(user);
      if (sessionDir) {
        session.sessionWorkingDir = sessionDir;
        // Auto-register for cleanup on session end
        const registered = this.deps.claudeHandler.addSourceWorkingDir(channel, threadTs, sessionDir);
        if (registered) {
          this.logger.info('Session working directory created', { sessionKey, sessionDir });
        } else {
          // Registration failed -- remove orphan directory to prevent disk leak
          this.logger.warn('Failed to register session dir for cleanup, removing orphan', { sessionKey, sessionDir });
          try {
            fs.rmSync(sessionDir, { recursive: true, force: true });
          } catch (rmErr) {
            this.logger.error('Failed to remove orphan session dir', { sessionDir, error: rmErr });
          }
          session.sessionWorkingDir = undefined;
        }
      } else {
        this.logger.warn('Failed to create session working directory, falling back to shared user dir', {
          sessionKey,
          user,
          workingDirectory,
        });
      }

      // Create conversation record and assign ID to session
      try {
        const conversationId = createConversation(channel, threadTs, user, userName);
        session.conversationId = conversationId;

        // Always show conversation URL — it's essential for session review
        const conversationUrl = getConversationUrl(conversationId);
        const convLinkResult = await this.deps.slackApi.postMessage(channel, `📝 <${conversationUrl}|대화 기록 보기>`, {
          threadTs,
        });
        if (convLinkResult?.ts) {
          (session.sourceThreadCleanupTs ??= []).push(convLinkResult.ts);
        }
        this.logger.info('Conversation record created', { conversationId, url: conversationUrl });
      } catch (error) {
        this.logger.error('Failed to create conversation record (non-critical)', error);
      }

      // User acceptance gate + first-time detection
      const userSettings = userSettingsStore.getUserSettings(user);
      if (!userSettings) {
        // New user: create pending record + notify admins
        this.logger.info('New user detected, creating pending record', { sessionKey, user, userName });
        userSettingsStore.createPendingUser(user, userName);
        await this.deps.slackApi.postMessage(channel, '⏳ 승인 대기 중입니다. 관리자에게 요청이 전달되었습니다.', {
          threadTs,
        });
        await this.notifyAdminsNewUser(user, userName);
        // Terminate the just-created session so next message also triggers gate
        this.deps.claudeHandler.terminateSession(sessionKey);
        return {
          session,
          sessionKey,
          isNewSession,
          userName,
          workingDirectory,
          abortController: new AbortController(),
          halted: true,
        };
      }
      if (!userSettings.accepted) {
        // Existing pending user re-messaging
        this.logger.debug('Pending user re-message blocked', { sessionKey, user });
        await this.deps.slackApi.postMessage(channel, '⏳ 아직 승인 대기 중입니다. 관리자의 승인을 기다려주세요.', {
          threadTs,
        });
        this.deps.claudeHandler.terminateSession(sessionKey);
        return {
          session,
          sessionKey,
          isNewSession,
          userName,
          workingDirectory,
          abortController: new AbortController(),
          halted: true,
        };
      }
    }

    // Determine effective working directory: prefer session-unique dir over fixed user dir
    // Guard: if sessionWorkingDir was cleaned up (e.g. macOS /tmp/ cleanup after sleep),
    // recreate it so the SDK spawn doesn't fail with ENOENT on a stale CWD.
    if (session.sessionWorkingDir && !fs.existsSync(session.sessionWorkingDir)) {
      this.logger.warn('Session working directory missing (likely cleaned by OS), recreating', {
        sessionKey,
        missingDir: session.sessionWorkingDir,
      });
      try {
        fs.mkdirSync(session.sessionWorkingDir, { recursive: true });
        this.logger.info('Recreated session working directory', {
          sessionKey,
          directory: session.sessionWorkingDir,
        });
      } catch (mkdirErr) {
        this.logger.error('Failed to recreate session working directory, falling back to user dir', {
          sessionKey,
          directory: session.sessionWorkingDir,
          error: mkdirErr,
        });
        session.sessionWorkingDir = undefined;
      }
    }
    const effectiveWorkingDir = session.sessionWorkingDir || workingDirectory;

    // Dispatch for new sessions OR stuck sessions (e.g., after server restart)
    // Skip dispatch if onboarding was triggered (already transitioned)
    // skipDispatch: explicit flag to bypass workflow classification (cron, auto-resume, etc.)
    if (event.skipDispatch && this.deps.claudeHandler.needsDispatch(channel, threadTs)) {
      this.logger.info('skipDispatch — bypassing workflow classification, using default', { sessionKey });
      this.deps.claudeHandler.transitionToMain(channel, threadTs, 'default', 'Direct (skipDispatch)');
    } else if (this.deps.claudeHandler.needsDispatch(channel, threadTs)) {
      if (forceWorkflow) {
        if (forceWorkflow === 'onboarding') {
          session.isOnboarding = true;
        } else {
          session.isOnboarding = false;
        }

        this.logger.info('Forcing session workflow from command', {
          sessionKey,
          workflow: forceWorkflow,
        });
        // Issue #698 Site D: check transitionToMain return value. `false` means
        // session missing OR already transitioned (race loss); both are legitimate
        // safe-stop conditions for forceWorkflow paths per spec AD-4.
        const ok = this.deps.claudeHandler.transitionToMain(
          channel,
          threadTs,
          forceWorkflow,
          forceWorkflow === 'onboarding' ? 'Onboarding' : 'New Session',
        );
        if (!ok) {
          throw new DispatchAbortError(
            'transition-failed',
            'transitionToMain returned false for initialize forceWorkflow branch (session missing or already transitioned)',
            forceWorkflow,
            undefined,
            session.handoffContext,
          );
        }
      } else {
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
            // Issue #698 Site B: if session has declared workflow intent via
            // handoffContext (#695), drifting to default would silently lose
            // the handoff. Throw DispatchAbortError instead; otherwise keep
            // existing default-drift (spec §Done: "일반 dispatch 실패 경로는
            // 기존과 동일 동작").
            if (this.deps.claudeHandler.needsDispatch(channel, threadTs)) {
              if (session.handoffContext !== undefined) {
                // waitTimeoutId cleared in finally even after throw
                throw new DispatchAbortError(
                  'wait-timeout',
                  (err as Error).message,
                  undefined,
                  DISPATCH_TIMEOUT_MS,
                  session.handoffContext,
                );
              }
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
    // Only route for PR-specific workflows — default workflow (plain mention/command) skips routing
    const PR_ROUTABLE_WORKFLOWS = new Set(['pr-review', 'pr-fix-and-update', 'pr-docs-confluence']);
    const prUrl = session.links?.pr?.url;
    // Skip channel routing for synthetic events that were already routed (e.g., after "현재 채널에서 진행")
    const shouldRoute =
      isNewSession && !!prUrl && PR_ROUTABLE_WORKFLOWS.has(session.workflow || '') && !skipAutoBotThread;

    this.logger.info('🔀 Channel routing check', {
      isNewSession,
      hasLinks: !!session.links,
      hasPrLink: !!session.links?.pr?.url,
      prUrl: session.links?.pr?.url || '(none)',
      channel,
      threadTs,
      skipAutoBotThread,
      workflow: session.workflow,
      shouldRoute,
      sessionState: session.state,
    });

    if (shouldRoute && prUrl) {
      // Fallback: if current channel isn't in the registry (missed by scanChannels),
      // register it on-the-fly via conversations.info before checking repo-channel match.
      if (!getChannel(channel)) {
        this.logger.info('🔀 Channel not in registry, registering on-the-fly', { channel });
        await registerChannel(this.deps.slackApi.getClient(), channel);
      }

      const routeCheck = checkRepoChannelMatch(prUrl, channel);

      this.logger.info('🔀 Channel routing result', {
        correct: routeCheck.correct,
        reason: routeCheck.reason,
        suggestedCount: routeCheck.suggestedChannels.length,
        suggestedChannels: routeCheck.suggestedChannels.map((ch) => ({ id: ch.id, name: ch.name })),
      });

      if (!routeCheck.correct && routeCheck.suggestedChannels.length > 0) {
        // Wrong channel — show advisory with move/stop buttons
        const target = routeCheck.suggestedChannels[0];
        this.logger.info('🔀 PR in wrong channel, showing routing advisory', {
          prUrl,
          currentChannel: channel,
          suggestedChannel: target.id,
          suggestedChannelName: target.name,
        });

        const routeBlockParams = {
          prUrl,
          targetChannelName: target.name,
          targetChannelId: target.id,
          originalChannel: channel,
          originalTs: threadTs,
          originalThreadTs: threadTs,
          userMessage: dispatchText || text || '',
          userId: user,
          advisoryEphemeral: false,
          allowStay: true,
          // Carry init-clutter ts into the button payload so cleanup survives restarts
          // and the original session being terminated (#516).
          cleanupTs: session.sourceThreadCleanupTs ? [...session.sourceThreadCleanupTs] : undefined,
        };
        await this.postRouteAdvisory(channel, threadTs, routeBlockParams);

        this.logger.info('🔀 Session halted — waiting for user to choose Move or Stop', {
          sessionKey,
          channel,
          threadTs,
        });

        // Don't register AbortController — no stream will run for halted sessions
        return {
          session,
          sessionKey,
          isNewSession,
          userName,
          workingDirectory,
          abortController: new AbortController(),
          halted: true,
        };
      } else if (!routeCheck.correct && routeCheck.reason === 'no_mapping') {
        const defaultRouteChannel = this.resolveDefaultRouteChannel(channel);
        const currentChannelInfo = getChannel(channel);
        const targetChannelId = defaultRouteChannel?.id || channel;
        const targetChannelName = defaultRouteChannel?.name || currentChannelInfo?.name || '현재 채널';
        const hasDefaultRoute = !!defaultRouteChannel;

        this.logger.info('🔀 Repo channel mapping missing, showing fallback advisory', {
          prUrl,
          currentChannel: channel,
          currentChannelName: currentChannelInfo?.name,
          hasDefaultRoute,
          defaultRouteChannelId: defaultRouteChannel?.id,
          defaultRouteChannelName: defaultRouteChannel?.name,
        });

        const routeBlockParams: ChannelRouteBlockParams = {
          prUrl,
          targetChannelName,
          targetChannelId,
          originalChannel: channel,
          originalTs: threadTs,
          originalThreadTs: threadTs,
          userMessage: dispatchText || text || '',
          userId: user,
          advisoryEphemeral: false,
          allowStay: true,
          allowMove: hasDefaultRoute,
          moveButtonText: hasDefaultRoute ? '기본 채널로 이동' : undefined,
          messageText: hasDefaultRoute
            ? `이 repo와 매핑된 채널을 찾지 못했습니다. 기본 채널 #${targetChannelName}로 이동하거나 현재 채널에서 진행할 수 있습니다.`
            : '이 repo와 매핑된 채널을 찾지 못했습니다. 현재 채널에서 진행할까요?',
          sectionText: hasDefaultRoute
            ? `⚠️ 이 repo와 매핑된 채널을 찾지 못했습니다.\n기본 채널 <#${targetChannelId}>로 이동하거나 현재 채널에서 진행할 수 있습니다.`
            : '⚠️ 이 repo와 매핑된 채널을 찾지 못했습니다.\n현재 채널에서 진행할까요?',
          // Carry init-clutter ts into the button payload (#516).
          cleanupTs: session.sourceThreadCleanupTs ? [...session.sourceThreadCleanupTs] : undefined,
        };

        await this.postRouteAdvisory(channel, threadTs, routeBlockParams);

        this.logger.info('🔀 Session halted — waiting for fallback route choice', {
          sessionKey,
          channel,
          threadTs,
          hasDefaultRoute,
        });

        return {
          session,
          sessionKey,
          isNewSession,
          userName,
          workingDirectory,
          abortController: new AbortController(),
          halted: true,
        };
      } else if (routeCheck.correct) {
        if (skipAutoBotThread) {
          this.logger.info('🔀 Skipping auto bot thread creation (routed move)', {
            prUrl,
            channel,
            threadTs,
          });
        } else {
          // Correct channel — create bot-owned thread header and migrate session
          const migrated = await this.createBotInitiatedThread(
            session,
            channel,
            threadTs,
            user,
            userName,
            effectiveWorkingDir,
            hasSourceThread,
          );
          if (migrated) {
            return migrated;
          }
        }
      }
    } else if (isNewSession) {
      this.logger.debug('🔀 Channel routing skipped', {
        isNewSession,
        hasPrLink: !!session.links?.pr?.url,
        workflow: session.workflow,
        reason: !session.links?.pr?.url ? 'no PR link' : `workflow '${session.workflow}' not routable`,
      });
      if (!skipAutoBotThread) {
        const migrated = await this.createBotInitiatedThread(
          session,
          channel,
          threadTs,
          user,
          userName,
          effectiveWorkingDir,
          hasSourceThread,
        );
        if (migrated) {
          return migrated;
        }
      }
    }

    // Handle concurrency control
    const abortController = this.handleConcurrency(sessionKey, channel, threadTs, user, userName, session);

    return {
      session,
      sessionKey,
      isNewSession,
      userName,
      workingDirectory: effectiveWorkingDir,
      abortController,
    };
  }

  /**
   * Run dispatch for workflow classification
   * Called when session needs re-dispatch (e.g., after /new or /renew)
   * @param channel - Slack channel ID
   * @param threadTs - Thread timestamp
   * @param text - Text to use for dispatch classification (typically a short
   *   handle like an issue URL; NOT the full `<z-handoff>` prompt body)
   * @param forceWorkflow - If set, skips classification and transitions
   *   directly to the given workflow
   * @param handoffPrompt - Full continuation prompt body for sentinel parsing.
   *   Required when `forceWorkflow` is one of the z-handoff entrypoints
   *   (`z-plan-to-work` / `z-epic-update`); ignored otherwise. Issue #695.
   * @throws HandoffAbortError when `forceWorkflow` is a z-handoff entrypoint
   *   and the sentinel is missing, malformed, or does not match the expected
   *   type for the requested workflow. Caught by `SlackHandler` (safe-stop).
   */
  async runDispatch(
    channel: string,
    threadTs: string,
    text: string,
    forceWorkflow?: WorkflowType,
    handoffPrompt?: string,
  ): Promise<void> {
    const sessionKey = this.deps.claudeHandler.getSessionKey(channel, threadTs);

    // Issue #695 — host-level enforcement of z session handoff entrypoints.
    // Failure throws `HandoffAbortError`, which `SlackHandler` catches to emit
    // a user-facing safe-stop message and short-circuit the retry path.
    if (isZHandoffWorkflow(forceWorkflow) && this.deps.claudeHandler.needsDispatch(channel, threadTs)) {
      if (!handoffPrompt) {
        throw new HandoffAbortError(
          'no-sentinel',
          'runDispatch received no handoffPrompt for forced z-* workflow',
          forceWorkflow,
        );
      }
      const parsed = parseHandoff(handoffPrompt);
      if (!parsed.ok) {
        throw new HandoffAbortError(parsed.reason, parsed.detail, forceWorkflow);
      }
      const expected = expectedHandoffKind(forceWorkflow);
      if (parsed.context.handoffKind !== expected) {
        throw new HandoffAbortError(
          'type-workflow-mismatch',
          `expected <z-handoff type="${expected}">, got type="${parsed.context.handoffKind}"`,
          forceWorkflow,
        );
      }
      const session = this.deps.claudeHandler.getSession(channel, threadTs);
      if (!session) {
        throw new HandoffAbortError('host-policy', 'session not found at handoff entry', forceWorkflow);
      }
      session.handoffContext = parsed.context;
      this.logger.info('Handoff entrypoint entered', {
        sessionKey,
        workflow: forceWorkflow,
        handoffKind: parsed.context.handoffKind,
        chainId: parsed.context.chainId,
        hopBudget: parsed.context.hopBudget,
      });
      // transitionToMain persists the session via SessionRegistry.saveSessions,
      // so no explicit save is needed here for handoffContext to hit disk.
      this.deps.claudeHandler.transitionToMain(channel, threadTs, forceWorkflow, HANDOFF_ENTRY_TITLES[forceWorkflow]);
      return;
    }

    if (forceWorkflow && this.deps.claudeHandler.needsDispatch(channel, threadTs)) {
      this.logger.info('Forcing workflow during re-dispatch', {
        sessionKey,
        workflow: forceWorkflow,
      });
      // Issue #698 Site C: check transitionToMain return value. Same semantics
      // as Site D — `false` is legitimate safe-stop for forceWorkflow paths.
      const ok = this.deps.claudeHandler.transitionToMain(
        channel,
        threadTs,
        forceWorkflow,
        forceWorkflow === 'onboarding' ? 'Onboarding' : 'Session Reset',
      );
      if (!ok) {
        const currentSession = this.deps.claudeHandler.getSession(channel, threadTs);
        throw new DispatchAbortError(
          'transition-failed',
          'transitionToMain returned false for runDispatch forceWorkflow branch (session missing or already transitioned)',
          forceWorkflow,
          undefined,
          currentSession?.handoffContext,
        );
      }
      return;
    }

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
    sessionKey: string,
    forcedWorkflowHint?: WorkflowType,
  ): Promise<void> {
    // Register dispatch in-flight SYNCHRONOUSLY before any async work
    // This prevents race condition where two messages both pass the check
    let resolveTracking: () => void;
    const trackingPromise = new Promise<void>((resolve) => {
      resolveTracking = resolve;
    });
    dispatchInFlight.set(sessionKey, trackingPromise);

    // Issue #688 — capture dispatch-scoped epoch. Any clearStatus call
    // emitted by this dispatch (including fallback / failure paths) must
    // carry `expectedEpoch: dispatchEpoch` so a stale clear from an
    // aborted prior turn cannot nuke a newer spinner on the same thread.
    const dispatchEpoch = this.deps.assistantStatusManager?.bumpEpoch(channel, threadTs) ?? 0;

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
    const updateDispatchPanel = async (phase: string, state: 'working' | 'idle'): Promise<void> => {
      const dispatchSession = this.deps.claudeHandler.getSession(channel, threadTs);
      if (!dispatchSession) {
        return;
      }

      this.deps.claudeHandler.setActivityState(channel, threadTs, state);
      // Do not create panel during dispatch for fresh sessions.
      // Rendering starts once SlackHandler calls ensurePanel.
      if (!dispatchSession.actionPanel?.messageTs) {
        return;
      }
      dispatchSession.actionPanel.agentPhase = phase;
      dispatchSession.actionPanel.activeTool = state === 'working' ? 'dispatch' : undefined;
      dispatchSession.actionPanel.statusUpdatedAt = Date.now();
      await this.deps.threadPanel?.updatePanel(dispatchSession, sessionKey);
    };

    try {
      const dispatchService = getDispatchService();
      const model = dispatchService.getModel();

      // Native spinner during dispatch — legacy-only; TurnSurface.begin owns
      // the "is thinking..." spinner at effective PHASE>=4 (#689 P4 Part 2).
      if (shouldRunLegacyB4Path(this.deps.assistantStatusManager)) {
        await this.deps.assistantStatusManager?.setStatus(channel, threadTs, 'is analyzing your request...');
      }
      await updateDispatchPanel('워크플로우 분석 중', 'working');

      // Add dispatching reaction and post status message
      await this.deps.slackApi.addReaction(channel, threadTs, 'mag'); // 🔍
      const msgResult = await this.deps.slackApi.postMessage(channel, `🔍 _Dispatching... (${model})_`, {
        threadTs,
      });
      dispatchMessageTs = msgResult?.ts;
      if (dispatchMessageTs) {
        // Track for source-thread cleanup on mid-thread migration / channel-route.
        // Model replies are never tracked here, so they survive migration.
        const dispatchSessionForTs = this.deps.claudeHandler.getSession(channel, threadTs);
        if (dispatchSessionForTs) {
          (dispatchSessionForTs.sourceThreadCleanupTs ??= []).push(dispatchMessageTs);
        }
      }

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
      const complexityTag = result.complexity ? ` complexity=${result.complexity.score}/${result.complexity.tier}` : '';
      this.logger.info(
        `✅ Session workflow set: [${result.workflow}] "${result.title}" (${elapsed}ms)${complexityTag}`,
        {
          channel,
          threadTs,
          complexity: result.complexity ? { score: result.complexity.score, tier: result.complexity.tier } : undefined,
        },
      );

      // Remove dispatching reaction
      await this.deps.slackApi.removeReaction(channel, threadTs, 'mag');

      // Update dispatch message with workflow result
      if (dispatchMessageTs) {
        await this.deps.slackApi.updateMessage(
          channel,
          dispatchMessageTs,
          `✅ *Workflow:* \`${result.workflow}\` → "${result.title}" _(${elapsed}ms)_`,
        );
      }

      // Set thread title in DM history — legacy-only; at effective PHASE>=4
      // the native Assistant UI owns thread titles (TurnSurface title-write
      // is tracked for a follow-up — docs/slack-ui-phase4.md §Out of scope).
      if (shouldRunLegacyB4Path(this.deps.assistantStatusManager)) {
        await this.deps.assistantStatusManager?.setTitle(channel, threadTs, result.title);
      }

      // Store extracted links on the session
      if (result.links && Object.keys(result.links).length > 0) {
        this.deps.claudeHandler.setSessionLinks(channel, threadTs, result.links);
        this.logger.info('🔗 Stored session links from dispatch', {
          channel,
          threadTs,
          links: result.links,
          hasPrLink: !!result.links.pr,
          prUrl: result.links.pr?.url,
        });

        scheduleLinkDerivedTitleRefresh(this.deps.claudeHandler, channel, threadTs, 'dispatch-entry');
      } else {
        this.logger.info('🔗 No links extracted from dispatch', {
          channel,
          threadTs,
          textPreview: text.substring(0, 100),
        });
      }

      // Transition session to MAIN state with determined workflow
      this.deps.claudeHandler.transitionToMain(channel, threadTs, result.workflow, result.title);
      await updateDispatchPanel('사용자 액션 대기', 'idle');
    } catch (error) {
      const elapsed = Date.now() - startTime;
      this.logger.error(`❌ Dispatch failed after ${elapsed}ms`, { error });

      // Issue #698 AD-2: activation check — safe-stop when session has
      // handoffContext (entered via #695 z-handoff) OR caller passed
      // forcedWorkflowHint. Otherwise preserve existing default-drift
      // behavior per spec §Done ("일반 dispatch 실패 경로는 기존과 동일 동작").
      const session = this.deps.claudeHandler.getSession(channel, threadTs);
      const shouldSafeStop = session?.handoffContext !== undefined || forcedWorkflowHint !== undefined;

      // AD-4.5: best-effort cleanup — inner try/catch so a rejected Slack API
      // call can't mask the DispatchAbortError throw.
      const bestEffort = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
        try {
          await fn();
        } catch (cleanupErr) {
          this.logger.warn(`Dispatch-abort cleanup failed: ${label}`, {
            channel,
            threadTs,
            error: (cleanupErr as Error).message,
          });
        }
      };

      await bestEffort('removeReaction', () => this.deps.slackApi.removeReaction(channel, threadTs, 'mag'));

      // AD-5.1: safe-stop branch uses distinct panel message; default-drift
      // branch keeps existing text for backward compat.
      if (dispatchMessageTs) {
        if (shouldSafeStop) {
          await bestEffort('updateMessage-safeStop', () =>
            this.deps.slackApi.updateMessage(
              channel,
              dispatchMessageTs!,
              `🚫 Dispatch 실패 — safe-stop (#698) _(${elapsed}ms)_`,
            ),
          );
        } else {
          await bestEffort('updateMessage-default', () =>
            this.deps.slackApi.updateMessage(
              channel,
              dispatchMessageTs!,
              `⚠️ *Workflow:* \`default\` _(dispatch failed after ${elapsed}ms)_`,
            ),
          );
        }
      }

      if (shouldSafeStop) {
        // Clear spinner before throw (best-effort). Epoch-guarded + PHASE-gated
        // same as default path below.
        if (shouldRunLegacyB4Path(this.deps.assistantStatusManager)) {
          await bestEffort('clearStatus-safeStop', () =>
            this.deps.assistantStatusManager!.clearStatus(channel, threadTs, {
              expectedEpoch: dispatchEpoch,
            }),
          );
        }
        // Map AbortError (DISPATCH_TIMEOUT_MS fired) to classifier-timeout;
        // any other thrown error is classifier-failed.
        const err = error as Error;
        const reason = err.name === 'AbortError' ? 'classifier-timeout' : 'classifier-failed';
        throw new DispatchAbortError(reason, err.message, forcedWorkflowHint, elapsed, session?.handoffContext);
      }

      // Default drift (UNCHANGED behavior per spec §Done "일반 dispatch 실패
      // 경로는 기존과 동일 동작"). Same transitionToMain + panel update as before.
      const fallbackTitle = MessageFormatter.generateSessionTitle(text);
      this.deps.claudeHandler.transitionToMain(channel, threadTs, 'default', fallbackTitle);
      await updateDispatchPanel('기본 워크플로우로 전환', 'idle');

      // Tear down the dispatch spinner. Epoch-guarded (#688) so a stale
      // clear from a superseded dispatch can't kill a newer turn's spinner;
      // PHASE-gated (#689 P4) so we don't race TurnSurface at PHASE>=4.
      if (shouldRunLegacyB4Path(this.deps.assistantStatusManager)) {
        await this.deps.assistantStatusManager?.clearStatus(channel, threadTs, {
          expectedEpoch: dispatchEpoch,
        });
      }
    } finally {
      clearTimeout(timeoutId);
      // Clean up the in-flight tracking and resolve waiting promises
      dispatchInFlight.delete(sessionKey);
      resolveTracking!();
    }
  }

  private resolveDefaultRouteChannel(currentChannel: string): { id: string; name: string } | undefined {
    const configured = process.env.DEFAULT_UPDATE_CHANNEL?.trim();
    if (!configured) {
      return undefined;
    }

    const channels = getAllChannels();
    const isChannelId = /^[CG][A-Z0-9]+$/i.test(configured);
    const normalizedName = configured.replace(/^#/, '').toLowerCase();
    const resolved = isChannelId
      ? channels.find((ch) => ch.id === configured)
      : channels.find((ch) => ch.name.toLowerCase() === normalizedName);

    if (!resolved || resolved.id === currentChannel) {
      return undefined;
    }

    return {
      id: resolved.id,
      name: resolved.name || normalizedName,
    };
  }

  private async createBotInitiatedThread(
    session: ConversationSession,
    channel: string,
    threadTs: string,
    user: string,
    userName: string,
    workingDirectory: string,
    hasSourceThread: boolean = false,
  ): Promise<SessionInitResult | undefined> {
    const headerPayload = ThreadHeaderBuilder.build({
      title: session.title || session.links?.pr?.label || session.links?.issue?.label,
      workflow: session.workflow || 'default',
      ownerName: session.ownerName,
      ownerId: session.ownerId,
      links: session.links,
      theme: userSettingsStore.getUserSessionTheme(user),
    });

    this.logger.debug('🧵 Posting bot thread root message', {
      channel,
      rootText: headerPayload.text.substring(0, 100),
      workflow: session.workflow,
    });

    const rootResult = await this.deps.slackApi.postMessage(channel, headerPayload.text, {
      attachments: headerPayload.attachments,
      blocks: headerPayload.blocks,
    });

    if (!rootResult?.ts) {
      this.logger.warn('🧵 Failed to post bot thread root - no ts returned', { channel });
      return undefined;
    }

    const botSession = this.deps.claudeHandler.createSession(user, userName, channel, rootResult.ts, session.model);
    botSession.threadModel = 'bot-initiated';
    botSession.threadRootTs = rootResult.ts;
    botSession.links = session.links;
    botSession.workflow = session.workflow;
    botSession.title = session.title;
    botSession.conversationId = session.conversationId;
    botSession.isOnboarding = session.isOnboarding;
    botSession.workingDirectory = session.workingDirectory;
    botSession.activityState = session.activityState;
    botSession.sessionWorkingDir = session.sessionWorkingDir;
    // Store source thread for context linking (data concern only — UX is always "new conversation")
    if (hasSourceThread) {
      botSession.sourceThread = { channel, threadTs };
    }

    // Transfer sourceWorkingDirs ownership to bot session before terminating original.
    // This prevents the original session's cleanup from deleting the session working directory.
    this.transferSourceWorkingDirs(session, channel, rootResult.ts);

    this.deps.claudeHandler.transitionToMain(
      channel,
      rootResult.ts,
      session.workflow || 'default',
      session.title || 'Session',
    );

    const origSessionKey = this.deps.claudeHandler.getSessionKey(channel, threadTs);
    this.deps.claudeHandler.terminateSession(origSessionKey);

    // 1. Clean up only the init clutter we posted (dispatch status, conversation-history link).
    //    Deleting all bot-authored messages here would also wipe prior model replies
    //    from an existing thread (#516). The session object is the ORIGINAL session,
    //    captured above; its sourceThreadCleanupTs holds exactly the ts to remove.
    for (const cleanupTs of session.sourceThreadCleanupTs || []) {
      try {
        await this.deps.slackApi.deleteMessage(channel, cleanupTs);
      } catch (error) {
        this.logger.debug('Failed to delete source-thread cleanup message', { channel, cleanupTs, error });
      }
    }

    // 2. Unified redirect — same UX whether from channel or thread.
    // Previously, thread-originating mentions got a rich retention card (📋) while
    // channel mentions got a simple redirect (🧵). This confused users who accidentally
    // posted in a thread (Slack UX: thread panel, accidental reply) but expected channel behavior.
    // Now all new sessions show consistent redirect. Source thread context is preserved
    // via sourceThread linking — completion summaries still post back on PR merge/close.
    if (shouldOutput(OutputFlag.SYSTEM, session.logVerbosity ?? LOG_DETAIL)) {
      await this.deps.slackApi.postMessage(channel, '🧵 새 스레드에서 작업을 시작합니다 →', { threadTs });
      const oldThreadPermalink = await this.deps.slackApi.getPermalink(channel, threadTs);
      await this.postMigratedContextSummary(channel, rootResult.ts, oldThreadPermalink, session);
    }

    const newSessionKey = this.deps.claudeHandler.getSessionKey(channel, rootResult.ts);
    const abortController = this.handleConcurrency(newSessionKey, channel, rootResult.ts, user, userName, botSession);
    this.deps.reactionManager.setOriginalMessage(newSessionKey, channel, rootResult.ts);
    await this.deps.contextWindowManager.setOriginalMessage(newSessionKey, channel, rootResult.ts);

    this.logger.info('🧵 Bot-initiated thread created, session migrated', {
      channel,
      rootTs: rootResult.ts,
      origSessionKey,
      newSessionKey,
      workflow: botSession.workflow,
      title: botSession.title,
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

  private async postMigratedContextSummary(
    channel: string,
    newThreadTs: string,
    oldThreadPermalink: string | null,
    session: ConversationSession,
  ): Promise<void> {
    const lines: string[] = ['📎 기존 대화 컨텍스트를 새 스레드로 복사했습니다.'];

    if (oldThreadPermalink) {
      lines.push(`• 이전 스레드: <${oldThreadPermalink}|열기>`);
    }

    if (session.conversationId) {
      const conversationUrl = getConversationUrl(session.conversationId);
      lines.push(`• 대화 기록: <${conversationUrl}|View conversation history>`);
    }

    if (session.links?.issue?.url) {
      lines.push(`• 이슈: <${session.links.issue.url}|${session.links.issue.label || 'Issue'}>`);
    }

    if (session.links?.pr?.url) {
      lines.push(`• PR: <${session.links.pr.url}|${session.links.pr.label || 'PR'}>`);
    }

    if (session.links?.doc?.url) {
      lines.push(`• 문서: <${session.links.doc.url}|${session.links.doc.label || 'Doc'}>`);
    }

    if (lines.length <= 1) {
      return;
    }

    await this.deps.slackApi.postMessage(channel, lines.join('\n'), {
      threadTs: newThreadTs,
    });
  }

  private async postRouteAdvisory(
    channel: string,
    threadTs: string,
    routeBlockParams: ChannelRouteBlockParams,
  ): Promise<void> {
    const { text: advisoryText, blocks } = buildChannelRouteBlocks(routeBlockParams);
    this.logger.info('🔀 Posting channel route advisory (public)', {
      channel,
      threadTs,
      targetChannel: routeBlockParams.targetChannelId,
      targetChannelName: routeBlockParams.targetChannelName,
      allowMove: routeBlockParams.allowMove !== false,
    });

    this.logger.debug('🔀 Route blocks built', {
      hasBlocks: blocks.length,
      routeBlockParams: {
        ...routeBlockParams,
        userMessage: routeBlockParams.userMessage.substring(0, 50),
      },
    });

    const advisoryResult = await this.deps.slackApi.postMessage(channel, advisoryText, { blocks });
    if (advisoryResult?.ts) {
      const updatedBlocks = buildChannelRouteBlocks({
        ...routeBlockParams,
        advisoryTs: advisoryResult.ts,
      }).blocks;
      await this.deps.slackApi.updateMessage(channel, advisoryResult.ts, advisoryText, updatedBlocks);
    }
  }

  private handleConcurrency(
    sessionKey: string,
    channel: string,
    threadTs: string,
    user: string,
    userName: string,
    session: ConversationSession,
  ): AbortController {
    const isRequestActive = this.deps.requestCoordinator.isRequestActive(sessionKey);
    const canInterrupt = this.deps.claudeHandler.canInterrupt(channel, threadTs, user);

    // Handle active request based on interrupt permissions
    if (isRequestActive) {
      if (canInterrupt) {
        this.logger.debug('Cancelling existing request for session', { sessionKey, interruptedBy: userName });
        this.deps.requestCoordinator.abortSession(sessionKey);
        // Issue #688 — per-(channel, threadTs) epoch bump so any stale
        // clearStatus from the aborted turn (arriving after the new turn
        // has set its spinner) becomes a no-op via expectedEpoch guard.
        this.deps.assistantStatusManager?.bumpEpoch(channel, threadTs);
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

  /**
   * Send admin DM notifications with Accept/Deny buttons for a new user.
   */
  private async notifyAdminsNewUser(userId: string, userName: string): Promise<void> {
    const adminUsers = getAdminUsers();
    if (adminUsers.size === 0) {
      this.logger.warn('No admin users configured, cannot notify about new user', { userId });
      return;
    }

    const blocks = [
      {
        type: 'section' as const,
        text: {
          type: 'mrkdwn' as const,
          text: `🆕 *New User Request*\n<@${userId}>${userName ? ` (${userName})` : ''} wants to use the bot`,
        },
      },
      {
        type: 'actions' as const,
        block_id: 'user_acceptance',
        elements: [
          {
            type: 'button' as const,
            text: { type: 'plain_text' as const, text: 'Accept' },
            action_id: 'accept_user',
            value: userId,
            style: 'primary' as const,
          },
          {
            type: 'button' as const,
            text: { type: 'plain_text' as const, text: 'Deny' },
            action_id: 'deny_user',
            value: userId,
            style: 'danger' as const,
          },
        ],
      },
    ];

    for (const adminId of adminUsers) {
      try {
        await this.deps.slackApi.postMessage(adminId, `New user access request from <@${userId}>`, { blocks });
      } catch (error) {
        this.logger.error('Failed to send admin notification', { adminId, userId, error });
      }
    }
  }
}
