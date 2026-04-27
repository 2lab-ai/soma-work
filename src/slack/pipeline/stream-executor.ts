import { randomUUID } from 'node:crypto';
import { parseModelCommandRunResponse } from 'somalib/model-commands/result-parser';
import type { ModelCommandResult } from '../../agent-session/agent-session-types.js';
import { TurnResultCollector } from '../../agent-session/turn-result-collector.js';
import type { UsageSnapshot } from '../../cct-store/types';
import { getChannelDescription } from '../../channel-description-cache';
import { getChannel } from '../../channel-registry';
import type { ClaudeHandler } from '../../claude-handler';
import {
  fetchClaudeStatus,
  formatStatusForSlack,
  isApiLikeError,
  shouldShowStatusBlock,
} from '../../claude-status-fetcher';
import { config } from '../../config';
import { createConversation, recordAssistantTurn, recordUserTurn } from '../../conversation';
import type { FileHandler, ProcessedFile } from '../../file-handler';
import { Logger, redactAnthropicSecrets } from '../../logger';
import { isMidThreadMention } from '../../mcp-config-builder';
import { getMetricsEmitter } from '../../metrics/event-emitter';
import {
  classifyOneMUnavailable,
  FALLBACK_CONTEXT_WINDOW,
  hasOneMSuffix,
  isOneMContextUnavailableSignal,
  ONE_M_CONTEXT_UNAVAILABLE_CODE,
  type OneMUnavailableKind,
  PRICING_VERSION,
  resolveContextWindow,
  stripOneMSuffix,
} from '../../metrics/model-registry';
import { interceptToolResults } from '../../metrics/tool-result-interceptor';
import { SLACK_BLOCK_KIT_CHANNEL_NAME } from '../../notification-channels/slack-block-kit-channel';
import { checkAndSchedulePendingCompact } from '../../session/compact-threshold-checker';
import { buildCompactionContext, snapshotFromSession } from '../../session/compaction-context-builder';
import { type ActiveTokenInfo, getTokenManager, parseCooldownTime } from '../../token-manager';
import {
  determineTurnCategory,
  type TurnCompletionEvent,
  type TurnNotifier,
  type TurnNotifierNotifyOpts,
} from '../../turn-notifier';
import type {
  Continuation,
  ConversationSession,
  SaveContextResultPayload,
  SessionResourceUpdateRequest,
  SessionUsage,
  UserChoice,
  UserChoices,
} from '../../types';
import { coerceToAvailableModel, userSettingsStore } from '../../user-settings-store';
import type { ActionHandlers } from '../actions';
import { buildMarkerBlocks, SUPERSEDED_TEXT } from '../actions/click-classifier';
import type { PendingInstructionConfirmStore } from '../actions/pending-instruction-confirm-store';
import type { CompletionMessageTracker } from '../completion-message-tracker.js';
import { postCompactCompleteIfNeeded, postCompactStartingIfNeeded } from '../hooks/compact-hooks';
import {
  type AssistantStatusManager,
  type ContextWindowManager,
  type ReactionManager,
  type SlackApiHelper,
  type StatusReporter,
  type StreamCallbacks,
  type StreamContext,
  StreamProcessor,
  type TodoDisplayManager,
  type ToolEventProcessor,
  type ToolTracker,
  type UsageData,
  UserChoiceHandler,
} from '../index';
import {
  buildInstructionConfirmBlocks,
  buildInstructionConfirmFallbackText,
  buildInstructionSupersededBlocks,
} from '../instruction-confirm-blocks';
import { LOG_DETAIL, OutputFlag, shouldOutput, verboseTag } from '../output-flags';
import type { RequestCoordinator } from '../request-coordinator';
import type { SummaryService } from '../summary-service';
import type { SummaryTimer } from '../summary-timer.js';
import type { ThreadPanel, TurnAddress, TurnContext } from '../thread-panel';
import { shouldRunLegacyB4Path } from './effective-phase';
import { isLocalSlashCommand } from './local-slash-command';
import { MessageEvent, type SayFn } from './types';

/**
 * Result of stream execution
 */
export interface ExecuteResult {
  success: boolean;
  messageCount: number;
  continuation?: Continuation; // Next action to perform (if any)
  /** Structured turn result collected by TurnObserver (Issue #42 S3) */
  turnCollector?: TurnResultCollector;
  /** If set, caller should auto-retry after this many ms (recoverable error). */
  retryAfterMs?: number;
}

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
  threadPanel?: ThreadPanel;
  turnNotifier?: TurnNotifier;
  summaryTimer?: SummaryTimer;
  completionMessageTracker?: CompletionMessageTracker;
  summaryService?: SummaryService;
  /**
   * Compaction Tracking (#617): lazy accessor for EventRouter.
   * Late-bound via `setDispatchPendingCompactMessage` so we don't import
   * `EventRouter` here and trigger a cyclic dependency. Called by the
   * `onCompactBoundary` callback to re-dispatch the user message captured
   * by the auto-compact interception path (AC3 end-to-end).
   */
  dispatchPendingUserMessage?: (
    ctx: { channel: string; threadTs: string; user: string; ts: string },
    text: string,
  ) => Promise<void>;
  /**
   * Shared store for deferred `UPDATE_SESSION.instructionOperations`.
   * The stream-executor is the SOLE writer (fires on UPDATE_SESSION tool
   * result); reader/mutator is `InstructionConfirmActionHandler`. Both
   * must receive the SAME instance — wired in `SlackHandler.initialize`
   * and passed to both `StreamExecutor` here and `ActionHandlers`.
   */
  pendingInstructionConfirmStore?: PendingInstructionConfirmStore;
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
  /**
   * Slack workspace/team id of the originating user. Required by
   * `chat.startStream` (channel/thread streaming). Sourced from the
   * Slack message event (`event.team`); empty string when unknown — the
   * stream call then omits both recipient fields together (see
   * `TurnContext.recipientTeamId`).
   */
  teamId?: string;
  say: SayFn;
  mentionTs?: string;
  /** Original thread ts before bot-initiated thread migration */
  sourceThreadTs?: string;
  /** Original channel before channel routing */
  sourceChannel?: string;
  /** True when the prompt originates from a real user message (not auto-resume, continuation, /renew load, etc.) */
  isUserInput?: boolean;
}

/**
 * Narrow per-window percent view (0..100) used by this file's footer and
 * turn-notifier rendering. Derived from {@link UsageSnapshot} by
 * {@link toUsagePercentSnapshot}. Kept local to decouple rendering from
 * the wire-format `UsageSnapshot` (which carries `resetsAt` and utilization
 * in raw 0..1 or 0..100 form).
 */
interface UsagePercentSnapshot {
  fiveHour?: number;
  sevenDay?: number;
}

interface FinalFooterData {
  startedAt: Date;
  durationMs?: number;
  contextUsagePercentBefore?: number;
  contextUsagePercentAfter?: number;
  usageBefore?: UsagePercentSnapshot | null;
  usageAfter?: UsagePercentSnapshot | null;
  toolStats?: RequestToolStats;
}

/**
 * Normalize a UsageWindow's utilization to a 0..100 percent, matching the
 * legacy `ClaudeUsageSnapshot` contract that the footer/notifier expect.
 *
 * #701 — Anthropic's `/api/oauth/usage` endpoint sends raw integer
 * percent. The pre-#701 dual-form split at `raw <= 1.5` silently
 * misinterpreted server value `1` (= 1%) as `100%` (fraction form 1.0).
 * Dropped in favour of a single percent-only path that matches
 * `utilToPctInt` / `isUtilizationFull` in `src/slack/cct/builder.ts`.
 */
export function normalizeUtilizationToPercent(raw: number | undefined): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  const clamped = Math.max(0, Math.min(100, raw));
  return Math.round(clamped * 10) / 10;
}

/**
 * Map slot-keyed {@link UsageSnapshot} to the narrow 0..100-percent shape
 * the Slack footer / turn-notifier already know how to render. Returns
 * `null` when the snapshot has neither window populated.
 */
function toUsagePercentSnapshot(snap: UsageSnapshot | null | undefined): UsagePercentSnapshot | null {
  if (!snap) return null;
  const fiveHour = normalizeUtilizationToPercent(snap.fiveHour?.utilization);
  const sevenDay = normalizeUtilizationToPercent(snap.sevenDay?.utilization);
  if (fiveHour === undefined && sevenDay === undefined) return null;
  const out: UsagePercentSnapshot = {};
  if (fiveHour !== undefined) out.fiveHour = fiveHour;
  if (sevenDay !== undefined) out.sevenDay = sevenDay;
  return out;
}

/** Per-request tool call statistics */
interface ToolStatEntry {
  count: number;
  totalDurationMs: number;
}

interface RequestToolStats {
  [toolName: string]: ToolStatEntry;
}

/**
 * 스트림 처리 실행 및 정리
 */
export class StreamExecutor {
  private logger = new Logger('StreamExecutor');
  /**
   * Per-session AbortController for in-flight summary fork queries.
   * On new user input, abort() is called to cancel the running fork and prevent stale display.
   */
  private summaryAbortControllers = new Map<string, AbortController>();

  constructor(private deps: StreamExecutorDeps) {}

  /**
   * #689 P4 Part 2/2 — legacy native-spinner writer wrapper. At effective
   * PHASE>=4 this is a no-op because `TurnSurface.begin/end` owns the
   * native spinner as the single writer. At PHASE<4 (and at clamped
   * PHASE=4 when `AssistantStatusManager` is disabled) the wrapper
   * forwards to the legacy path so operational behaviour for PHASE<4
   * sessions is unchanged.
   */
  private async legacySetStatus(channel: string, threadTs: string, text: string): Promise<void> {
    const mgr = this.deps.assistantStatusManager;
    if (!shouldRunLegacyB4Path(mgr)) return;
    await mgr.setStatus(channel, threadTs, text);
  }

  private async legacyClearStatus(
    channel: string,
    threadTs: string,
    options?: { expectedEpoch?: number },
  ): Promise<void> {
    const mgr = this.deps.assistantStatusManager;
    if (!shouldRunLegacyB4Path(mgr)) return;
    await mgr.clearStatus(channel, threadTs, options);
  }

  /**
   * Excludes `slack-block-kit` from the WorkflowComplete fan-out when the
   * P5 capability is live, so `TurnSurface.end('completed')` is the single
   * writer of the B5 in-thread marker. Exception path (`handleError`)
   * deliberately does NOT call this — Exceptions fan out to all channels.
   */
  private buildCompletionNotifyOpts(): TurnNotifierNotifyOpts | undefined {
    if (this.deps.threadPanel?.isCompletionMarkerActive() === true) {
      return { excludeChannelNames: [SLACK_BLOCK_KIT_CHANNEL_NAME] };
    }
    return undefined;
  }

  /**
   * 프롬프트 준비
   */
  async preparePrompt(
    text: string | undefined,
    processedFiles: ProcessedFile[],
    userName: string,
    userId: string,
    workingDirectory: string,
    threadTs?: string,
    mentionTs?: string,
  ): Promise<string> {
    // Prepare the prompt with file attachments
    const rawPrompt =
      processedFiles.length > 0 ? await this.deps.fileHandler.formatFilePrompt(processedFiles, text || '') : text || '';

    // Wrap the prompt with speaker tag
    let finalPrompt = `<speaker>${userName}</speaker>\n${rawPrompt}`;

    // Inject user and environment context
    const contextInfo = this.getContextInfo(userId, workingDirectory);
    if (contextInfo) {
      finalPrompt = `${finalPrompt}\n\n${contextInfo}`;
    }

    // Thread context hint — only for mid-thread mentions (mentionTs !== threadTs)
    if (isMidThreadMention({ threadTs, mentionTs })) {
      finalPrompt = `${finalPrompt}\n\n${this.getThreadContextHint()}`;
    }

    return finalPrompt;
  }

  /**
   * Thread awareness prompt for sessions started from a thread mention.
   * Guides the model to use get_thread_messages / download_thread_file
   * to understand the conversation context before acting.
   */
  private getThreadContextHint(): string {
    return `<thread-awareness>
이 세션은 기존 Slack 스레드에서 멘션되어 시작되었습니다.
유저의 요청을 이해하기 위해 스레드의 이전 대화를 확인해야 할 수 있습니다.

사용 가능한 도구:
- get_thread_messages: 스레드 메시지를 offset/limit으로 조회 (offset 0 = root message, offset 1 = 첫 번째 reply). 멘션 근처 메시지는 before/after 파라미터로도 접근 가능.
- download_thread_file: 스레드 메시지의 첨부 파일 다운로드 → Read 도구로 확인

먼저 get_thread_messages로 멘션 이전 대화를 읽고, 유저가 "여기 내용"이라고 지칭하는 것이 무엇인지 파악하세요.
특히 root message(offset 0)에 첨부된 파일이나 이미지가 있는지 반드시 확인하세요 — 유저가 참조하는 핵심 자료가 thread 시작 메시지에 있는 경우가 많습니다.
긴 스레드의 경우, 멘션 근처 컨텍스트는 before/after 파라미터로 효율적으로 조회할 수 있습니다.
Read 가능한 파일(텍스트, 코드, PDF, 이미지 등)이 첨부된 메시지가 있으면 download_thread_file로 다운로드한 후 Read 도구로 내용을 확인하세요.

이미지 파일(jpg, png, gif, webp 등)도 download_thread_file로 다운로드한 후 Read 도구로 직접 볼 수 있습니다. Claude는 이미지를 네이티브로 읽을 수 있습니다.
오디오/비디오 파일만 다운로드가 차단됩니다 — 파일 이름과 메타데이터만 참조하세요.
</thread-awareness>`;
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

    // Issue #688 — capture per-turn status epoch. Every clearStatus call
    // emitted by this execute() carries `expectedEpoch: epoch` so that a
    // stale clear from a previous (aborted) turn cannot kill a newer
    // spinner set by a subsequent turn on the same (channel, threadTs).
    // Must be function-scope (not a class field) so concurrent executions
    // on different threads don't clobber each other.
    const epoch = this.deps.assistantStatusManager.bumpEpoch(channel, threadTs);

    // Cancel summary timer on new user input
    // Trace: docs/turn-summary-lifecycle/trace.md, S2
    if (this.deps.summaryTimer) {
      this.deps.summaryTimer.cancel(params.sessionKey);
    }

    // Abort any in-flight summary fork to prevent stale summary from repopulating after clearDisplay.
    // This is the key fix for the race: timer cancel only prevents new fires, but an already-running
    // fork must be explicitly aborted so its result is discarded.
    const pendingAbort = this.summaryAbortControllers.get(params.sessionKey);
    if (pendingAbort) {
      pendingAbort.abort();
      this.summaryAbortControllers.delete(params.sessionKey);
    }

    // Clear any displayed summary on new user input
    if (this.deps.summaryService) {
      this.deps.summaryService.clearDisplay(session as any);
    }

    // Delete tracked completion messages on new user input
    // Trace: docs/turn-summary-lifecycle/trace.md, S7
    if (this.deps.completionMessageTracker) {
      const threadRootTs = session.threadRootTs;
      this.deps.completionMessageTracker
        .deleteAll(
          params.sessionKey,
          async (ch, ts) => {
            // Defense-in-depth: never delete the thread root message (header)
            if (threadRootTs && ts === threadRootTs) {
              this.logger.error('BLOCKED: attempted to delete thread root via completion tracker', {
                sessionKey: params.sessionKey,
                ts,
                threadRootTs,
              });
              return;
            }
            try {
              await this.deps.slackApi.deleteMessage(ch, ts);
            } catch {}
          },
          params.channel,
        )
        .catch(() => {});
    }

    let toolChoicePending = false;
    let toolContinuation: Continuation | undefined;
    const requestStartedAt = new Date();
    const contextUsagePercentBefore = this.getCurrentContextUsagePercent(session.usage);
    // W3-B: slot-keyed usage fetch — identify the active slot at query-start
    // so the keyId stays stable even if another session rotates mid-turn.
    const activeSlotSnapshot = getTokenManager().getActiveToken();
    const usageBeforePromise: Promise<UsagePercentSnapshot | null> = activeSlotSnapshot
      ? getTokenManager()
          .fetchAndStoreUsage(activeSlotSnapshot.keyId)
          .then((snap) => toUsagePercentSnapshot(snap))
          .catch(() => null)
      : Promise.resolve(null);

    // Issue #525 P1: per-turn identity for the 5-block UI façade. Computed
    // BEFORE any try/catch so the finally block can call endTurn() even if
    // preparePrompt/query-setup throws. TurnSurface.end is idempotent and
    // gated on SOMA_UI_5BLOCK_PHASE>=1 — PHASE=0 deployments see no change.
    //
    // `randomUUID()` suffix guards against same-millisecond re-entry on the
    // same sessionKey. Without it, `${sessionKey}:${ms}` would collide and
    // the supersede branch in TurnSurface.begin (which compares prior vs new
    // turnId) would silently skip — leaving the second turn without an open
    // B1 stream.
    const turnId = `${sessionKey}:${requestStartedAt.getTime()}:${randomUUID()}`;

    // P5 B5 marker snapshot.
    //
    //   - `snapshotPromise` is built once here and handed to TurnContext.
    //   - `resolveSnapshot` is called EXACTLY ONCE: with the enriched event
    //     on the `.then` rail, or with `undefined` on the `.catch` rail.
    //   - Abort / 1M-fallback / supersede paths never reach either rail.
    //     The Promise stays pending; the turnContext is GC'd when `execute()`
    //     returns, so there's no leak. TurnSurface only `await`s it when
    //     `reason === 'completed'`, so pending is harmless on abort paths.
    //
    // There is intentionally NO `finally` safety-net resolve (codex P1-1):
    // a `finally → resolveSnapshot(undefined)` would race the `.then` rail
    // and could lock in an undefined snapshot even when enrichment succeeded.
    // The 3s timeout in TurnSurface.end is the single safety net.
    let resolveSnapshot!: (evt: TurnCompletionEvent | undefined) => void;
    const snapshotPromise = new Promise<TurnCompletionEvent | undefined>((resolve) => {
      resolveSnapshot = resolve;
    });
    const buildCompletionEvent = (): Promise<TurnCompletionEvent | undefined> => snapshotPromise;

    const turnContext: TurnContext = {
      channelId: channel,
      threadTs: threadTs || undefined,
      sessionKey,
      turnId,
      // Issue #688 — thread the per-turn epoch through TurnContext so
      // TurnSurface.end()/fail() can pass it as `expectedEpoch` to
      // clearStatus, mirroring the caller-owns-epoch pattern used by the
      // explicit clearStatus calls below (e.g. lines ~1035, 1116, 1349).
      statusEpoch: epoch,
      // `chat.startStream` rejects channel/thread streams without BOTH
      // recipient_user_id and recipient_team_id (`missing_recipient_team_id`).
      // We treat empty strings as "not available" so the stream call falls
      // back to omitting both fields together — never sending a partial pair.
      recipientUserId: user || undefined,
      recipientTeamId: params.teamId || undefined,
      buildCompletionEvent,
    };
    await this.deps.threadPanel?.beginTurn(turnContext);

    // Dashboard v2.1 — turn timer: mark active-leg start and broadcast so
    // the live 1s tick picks up the new leg without waiting for any other
    // session event. Guarded so failures never break the turn.
    try {
      this.deps.claudeHandler.getSessionRegistry().beginTurn(session);
      this.deps.claudeHandler.getSessionRegistry().broadcastSessionUpdate();
    } catch (err) {
      this.logger.debug('stream-executor: beginTurn timer hook failed', {
        turnId,
        error: (err as Error)?.message ?? String(err),
      });
    }

    // W3-B: `activeSlotSnapshot` above captured the slot at query-start, so
    // rate-limit rotation on error can use the stable keyId/name even if
    // another session has already rotated the active slot.

    // Issue #42 S3: TurnResultCollector — 턴 결과 구조화 수집
    const turnCollector = new TurnResultCollector();

    // Verbosity filtering — read from session dynamically so mid-stream $verbosity changes apply
    const getVerbosity = () => session.logVerbosity ?? LOG_DETAIL;
    const isOutputEnabled = (flag: number) => shouldOutput(flag, getVerbosity());
    const vtag = (flag: number) => verboseTag(flag, getVerbosity());

    // Per-request tool statistics
    const toolStats: RequestToolStats = {};
    const toolStartTimes = new Map<string, number>();

    // Track latest response message ts for shortcut link
    let latestResponseTs: string | undefined;

    // Transition to working state
    this.deps.claudeHandler.setActivityState(channel, threadTs, 'working');
    await this.updateRuntimeStatus(session, sessionKey, {
      agentPhase: '생각 중',
      activeTool: undefined,
      waitingForChoice: false,
    });

    try {
      // #617 followup: Claude Agent SDK only recognizes local slash commands
      // (/compact, /clear, /model, etc.) when the prompt STARTS with the /cmd
      // token. preparePrompt wraps the text with <speaker>…</speaker> and a
      // trailing <context>…</context>, which pushes the slash off the first
      // character and makes the SDK treat `/compact` as a plain LLM message
      // instead of invoking compaction. Detect the exact local-command form
      // and pass it through raw. This also repairs the auto-compact
      // (#617 AC3) path: event-router injects '/compact' as continueWithPrompt,
      // so without this bypass the threshold-triggered compaction would also
      // be silently no-op'd.
      const trimmedText = (text ?? '').trim();
      const isSlashCommand = isLocalSlashCommand(trimmedText);

      let finalPrompt: string;
      if (isSlashCommand) {
        finalPrompt = trimmedText;
        this.logger.info('Bypassing preparePrompt for SDK local slash command', {
          sessionKey,
          command: trimmedText.split(/\s/)[0],
        });
      } else {
        finalPrompt = await this.preparePrompt(
          text,
          processedFiles,
          userName,
          user,
          workingDirectory,
          threadTs,
          params.mentionTs,
        );
      }

      // #196: Inject compaction context if SDK auto-compacted during previous turn.
      // Skip injection for local slash commands — prefixing `<compaction-context>`
      // would break SDK recognition of the leading `/cmd`. The session flag is
      // still cleared so we don't inject stale context into the next real turn.
      if (session.compactionOccurred) {
        if (!isSlashCommand) {
          const compactionCtx = buildCompactionContext(snapshotFromSession(session));
          if (compactionCtx) {
            finalPrompt = `${compactionCtx}\n\n${finalPrompt}`;
            this.logger.info('Injected compaction preservation context', { sessionKey });
          }
        } else {
          this.logger.info('Skipping compaction context injection for local slash command', {
            sessionKey,
          });
        }
        session.compactionOccurred = false;
      }

      // PLAN §7 — if the user rejected the previous instruction write via
      // the `n` button, inject a one-shot rejection notice so the assistant
      // sees it was dropped and can reconsider. Runtime-only flag; cleared
      // here so it never fires twice.
      if (session.pendingInstructionRejection) {
        if (!isSlashCommand) {
          const opCount = session.pendingInstructionRejection.request.instructionOperations?.length ?? 0;
          const notice = `<user-instruction-write-rejected>\nThe user rejected your previous proposal to update session.instructions (${opCount} operation${opCount === 1 ? '' : 's'}). Do not retry that exact proposal; re-evaluate whether the write is still warranted, and if so propose a different variation.\n</user-instruction-write-rejected>`;
          finalPrompt = `${notice}\n\n${finalPrompt}`;
          this.logger.info('Injected user-instruction-write-rejected notice', {
            sessionKey,
            opCount,
          });
        }
        session.pendingInstructionRejection = undefined;
      }

      // Record user turn (fire-and-forget, non-blocking)
      // Auto-create conversation if session lost its conversationId (e.g., after restart backfill miss)
      if (!session.conversationId && text && channel) {
        try {
          session.conversationId = createConversation(channel, session.threadTs || '', user, userName);
          this.logger.info('Auto-created conversation for session missing conversationId', {
            sessionKey,
            conversationId: session.conversationId,
          });
        } catch (err) {
          this.logger.error('Failed to auto-create conversation', err);
        }
      }
      if (session.conversationId && text) {
        recordUserTurn(session.conversationId, text, userName, user);
      }

      // Store user instruction for SSOT tracking (only real user input, not auto-resume/continuation/renew)
      // followUpInstructions is capped to prevent unbounded memory growth.
      const MAX_FOLLOW_UP_INSTRUCTIONS = 50;
      if (session && text && params.isUserInput !== false) {
        if (!session.initialInstruction) {
          session.initialInstruction = text;
        } else {
          // Always record subsequent turns as follow-ups (even if text matches initial).
          // The first turn is not duplicated because session-initializer sets initialInstruction
          // before stream-executor runs, so this branch is only reached from the 2nd turn onward.
          if (!session.followUpInstructions) {
            session.followUpInstructions = [];
          }
          if (session.followUpInstructions.length >= MAX_FOLLOW_UP_INSTRUCTIONS) {
            session.followUpInstructions.shift();
          }
          session.followUpInstructions.push({
            timestamp: Date.now(),
            text,
            speaker: userName,
          });
        }
      }

      this.logger.info('Sending query to Claude Code SDK', {
        prompt: finalPrompt.substring(0, 200) + (finalPrompt.length > 200 ? '...' : ''),
        sessionId: session.sessionId,
        workingDirectory,
        fileCount: processedFiles.length,
        speaker: userName,
        isOwner: session.ownerId === user,
      });

      // Auto-fetch user profile (email + displayName) from Slack if not cached
      // Uses strict === undefined to distinguish "never fetched" from "fetched but no email scope"
      if (userSettingsStore.getUserEmail(user) === undefined) {
        try {
          const profile = await this.deps.slackApi.getUserProfile(user);
          // Store email or empty sentinel to prevent re-fetching when scope is missing
          userSettingsStore.setUserEmail(user, profile.email ?? '');
          if (profile.displayName && profile.displayName !== user) {
            userSettingsStore.ensureUserExists(user, profile.displayName);
          }
        } catch (e) {
          this.logger.debug('Failed to fetch user profile from Slack', { user, error: e });
        }
      }

      // Fast-fail: block model invocation when user email is not configured.
      // Placed BEFORE spinner/reaction to avoid dangling UI state on early return.
      const resolvedEmail = userSettingsStore.getUserEmail(user);
      if (!resolvedEmail) {
        await say({
          text: `⚠️ *이메일이 설정되지 않았습니다.*\n\n이 기능을 사용하려면 이메일 설정이 필요합니다.\n\`set email <your-email>\` 명령으로 이메일을 설정해주세요.\n\n예시: \`set email you@company.com\``,
          thread_ts: threadTs,
        });
        this.logger.warn('Blocked model invocation: user email not configured', { user });
        return { success: false, messageCount: 0 };
      }

      // Add thinking reaction + native spinner (gated by verbosity)
      // (Status message removed — progress is now shown in ThreadSurface)
      if (isOutputEnabled(OutputFlag.STATUS_REACTION)) {
        await this.deps.reactionManager.updateReaction(sessionKey, this.deps.statusReporter.getStatusEmoji('thinking'));
      }
      if (isOutputEnabled(OutputFlag.STATUS_SPINNER)) {
        await this.legacySetStatus(channel, threadTs, 'is thinking...');
      }

      // Create Slack context for permission prompts + channel description for system prompt
      const channelDescription = await getChannelDescription(this.deps.slackApi.getClient(), channel);
      // Fetch structured repo info from channel registry (parsed from channel description)
      const channelInfo = getChannel(channel);
      const slackContext = {
        channel,
        threadTs,
        mentionTs: params.mentionTs,
        user,
        channelDescription,
        sourceThreadTs: params.sourceThreadTs,
        sourceChannel: params.sourceChannel,
        repos: channelInfo?.repos,
        confluenceUrl: channelInfo?.confluenceUrl,
      };

      // Create stream context — logVerbosity/showThinking are getters so mid-stream changes apply
      const streamContext: StreamContext = {
        channel,
        threadTs,
        sessionKey,
        sessionId: session?.sessionId,
        botUserId: await this.deps.slackApi.getBotUserId(),
        // Issue #525 P1: surface the per-turn id + ThreadPanel façade to the
        // stream processor so it can route text chunks into the B1 stream.
        // The façade is always populated (StreamExecutor receives it from
        // session initialization); PHASE-gating lives inside
        // `threadPanel.isTurnSurfaceActive()` so the stream-processor branch
        // is a single conditional: PHASE=0 → legacy `say()`, PHASE>=1 →
        // `appendText()` with graceful fallback on `false` return.
        turnId,
        threadPanel: this.deps.threadPanel,
        get logVerbosity() {
          return session.logVerbosity ?? LOG_DETAIL;
        },
        get showThinking() {
          return session.showThinking ?? userSettingsStore.getUserShowThinking(user);
        },
        say: async (msg) => {
          const result = await say({
            text: msg.text,
            thread_ts: msg.thread_ts,
            blocks: msg.blocks,
            attachments: msg.attachments,
          });
          if (result?.ts) {
            latestResponseTs = result.ts;
          }
          return { ts: result?.ts };
        },
      };

      // Create stream callbacks
      const streamCallbacks: StreamCallbacks = {
        onToolUse: async (toolUses, ctx) => {
          // Ghost Session Fix #99: self-terminate if session was terminated while streaming
          if (session.terminated) {
            abortController.abort();
            return;
          }
          if (isOutputEnabled(OutputFlag.STATUS_REACTION)) {
            await this.deps.reactionManager.updateReaction(
              sessionKey,
              this.deps.statusReporter.getStatusEmoji('working'),
            );
          }
          // Native spinner with tool-specific text
          if (isOutputEnabled(OutputFlag.STATUS_SPINNER)) {
            const toolName = toolUses[0]?.name;
            if (toolName) {
              // Issue #688 — Bash uses a thunk descriptor so the heartbeat
              // tick can recompute the text from the live background-bash
              // counter (e.g. switch to "waiting on background shell..."
              // when a run_in_background call is in-flight). Non-Bash
              // tools keep the simple static path.
              if (toolName === 'Bash') {
                const statusManager = this.deps.assistantStatusManager;
                // PHASE>=4: TurnSurface is the single B4 writer — same gate
                // as `legacySetStatus` (line 237) and the non-Bash branch.
                if (shouldRunLegacyB4Path(statusManager)) {
                  await statusManager.setStatus(channel, threadTs, () =>
                    statusManager.buildBashStatus(channel, threadTs),
                  );
                }
              } else {
                const statusText = this.deps.assistantStatusManager.getToolStatusText(toolName);
                await this.legacySetStatus(channel, threadTs, statusText);
              }
            }
          }
          const toolName = toolUses[0]?.name;
          await this.updateRuntimeStatus(session, ctx.sessionKey, {
            agentPhase: toolName ? '도구 실행 중' : '작업 중',
            activeTool: toolName,
          });
          // Track tool start times for per-request stats
          for (const tu of toolUses) {
            toolStartTimes.set(tu.id, Date.now());
          }
          await this.deps.toolEventProcessor.handleToolUse(toolUses, {
            channel: ctx.channel,
            threadTs: ctx.threadTs,
            sessionKey: ctx.sessionKey,
            say: ctx.say,
            logVerbosity: getVerbosity(),
            // #664 P2 absorb: carry the turnId so tool-event-processor's
            // PHASE>=2 sink path can route verbose output into the B1
            // stream bound to this request.
            turnId,
          });
          // Issue #42 S3: observer — 도구 시작 이벤트 수집
          for (const tu of toolUses) {
            turnCollector.onToolStart(tu.name, tu.id);
          }
          turnCollector.onPhaseChange('도구 실행 중');
        },
        onToolResult: async (toolResults, ctx) => {
          // Ghost Session Fix #99: self-terminate if session was terminated while streaming
          if (session.terminated) {
            abortController.abort();
            return;
          }
          // Accumulate per-request tool stats
          for (const tr of toolResults) {
            const name = tr.toolName || 'unknown';
            const startTime = toolStartTimes.get(tr.toolUseId);
            const duration = startTime ? Date.now() - startTime : 0;
            toolStartTimes.delete(tr.toolUseId);
            if (!toolStats[name]) {
              toolStats[name] = { count: 0, totalDurationMs: 0 };
            }
            toolStats[name].count++;
            toolStats[name].totalDurationMs += duration;
          }
          await this.updateRuntimeStatus(session, ctx.sessionKey, {
            agentPhase: '결과 반영 중',
            activeTool: undefined,
          });
          await this.deps.toolEventProcessor.handleToolResult(toolResults, {
            channel: ctx.channel,
            threadTs: ctx.threadTs,
            sessionKey: ctx.sessionKey,
            say: ctx.say,
            logVerbosity: getVerbosity(),
            // #664 P2 absorb: same turnId as the matching tool_use event,
            // so sink-side lookups stay on one B1 stream handle.
            turnId,
          });
          // Metrics: detect git/gh commands in Bash output (fire-and-forget)
          interceptToolResults(
            toolResults,
            session.ownerId,
            session.ownerName || 'unknown',
            ctx.sessionKey,
            // Callback to record merge stats into session
            (_sessionKey, prNumber, linesAdded, linesDeleted) => {
              this.deps.claudeHandler.addMergeStats(ctx.channel, ctx.threadTs, prNumber, linesAdded, linesDeleted);
            },
          );
          const commandResult = await this.handleModelCommandToolResults(toolResults, session, ctx);
          if (commandResult.hasPendingChoice) {
            toolChoicePending = true;
          }
          if (commandResult.continuation) {
            toolContinuation = commandResult.continuation;
          }
          // Issue #42 S3: observer — 도구 종료 + model-command 결과 수집
          // duration은 위 루프(367-377)에서 이미 계산·삭제되었으므로 toolStats에서 역산
          for (const tr of toolResults) {
            const name = tr.toolName || 'unknown';
            const stats = toolStats[name];
            // 직전 루프에서 계산된 duration을 collector의 자체 startTime fallback으로 위임
            turnCollector.onToolEnd(name, tr.toolUseId);
          }
          turnCollector.onPhaseChange('결과 반영 중');
          if (commandResult.modelCommandResults) {
            for (const mcr of commandResult.modelCommandResults) {
              turnCollector.onModelCommandResult(mcr);
            }
          }
        },
        onTodoUpdate: async (input, ctx) => {
          // Task list is part of thread header — always update regardless of verbosity.
          // The TODO_UPDATE flag only gates the legacy standalone message inside handleTodoUpdate.
          await this.deps.todoDisplayManager.handleTodoUpdate(
            input,
            ctx.sessionKey,
            ctx.sessionId,
            ctx.channel,
            ctx.threadTs,
            ctx.say,
            getVerbosity(),
            session,
            turnId,
            {
              channelId: turnContext.channelId,
              threadTs: turnContext.threadTs,
              sessionKey: turnContext.sessionKey,
            },
          );
        },
        onPendingFormCreate: (formId, form) => {
          this.deps.actionHandlers.setPendingForm(formId, form);
        },
        getPendingForm: (formId) => {
          return this.deps.actionHandlers.getPendingForm(formId);
        },
        onInvalidateOldForms: async (sessionKey, newFormId) => {
          await this.deps.actionHandlers.invalidateOldForms(sessionKey, newFormId, this.deps.slackApi);
        },
        onUpdateMessage: async (ch, ts, text) => {
          await this.updateToolCallMessage(ch, ts, text);
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
        onSourceWorkingDirDetected: async (dirPath) => {
          try {
            const added = this.deps.claudeHandler.addSourceWorkingDir(channel, threadTs, dirPath);
            if (added) {
              this.logger.info('Source working dir directive processed', {
                sessionKey,
                dirPath,
              });
            } else {
              this.logger.warn('Source working dir directive rejected', {
                sessionKey,
                dirPath,
              });
            }
          } catch (error) {
            this.logger.error('Failed to process source working dir directive', {
              sessionKey,
              dirPath,
              error: error instanceof Error ? error.stack || error.message : String(error),
            });
          }
        },
        onUsageUpdate: async (usage: UsageData) => {
          this.updateSessionUsage(session, usage);

          // Update context window emoji
          if (session.usage && isOutputEnabled(OutputFlag.CONTEXT_EMOJI)) {
            const percent = this.deps.contextWindowManager.calculateRemainingPercent(session.usage);
            await this.deps.contextWindowManager.updateContextEmoji(sessionKey, percent);
          }

          // Keep action panel context percentage in sync with latest usage.
          try {
            await this.deps.threadPanel?.updatePanel(session, sessionKey);
          } catch (error) {
            this.logger.debug('Failed to update action panel from usage callback', {
              sessionKey,
              error: (error as Error).message,
            });
          }
        },
        onChoiceCreated: async (payload, ctx, sourceMessageTs) => {
          await this.updateRuntimeStatus(session, ctx.sessionKey, {
            agentPhase: '입력 대기',
            activeTool: undefined,
            waitingForChoice: true,
          });
          await this.deps.threadPanel?.attachChoice(ctx.sessionKey, payload, sourceMessageTs);
          // Issue #42 S3: observer — 선택 대기 상태 수집
          turnCollector.onPhaseChange('입력 대기');
        },
        // #196: Compaction-Aware Context Preservation
        // #617: END-signal dedupe + pendingUserText re-dispatch
        // #617 followup: capture SDK-authoritative pre/post token counts from
        // `compact_metadata` so the "complete" message can report real
        // percentages (the heuristic `lastKnownUsagePct` is only refreshed
        // at turn-end and is stale between PreCompact and PostCompact).
        onCompactBoundary: (metadata) => {
          session.compactionOccurred = true;
          // Dashboard v2.1 — bump compaction counter. Guarded so any failure
          // in the dashboard/broadcast path cannot interrupt compaction.
          try {
            session.compactionCount = (session.compactionCount || 0) + 1;
            this.deps.claudeHandler.getSessionRegistry().broadcastSessionUpdate();
          } catch (err) {
            this.logger.debug('compactionCount bump failed', {
              error: (err as Error)?.message ?? String(err),
            });
          }

          // Capture SDK compact_metadata — shape per SDKCompactBoundaryMessage:
          //   { trigger: 'manual'|'auto', pre_tokens: number,
          //     post_tokens?: number, duration_ms?: number }
          // We store raw tokens + trigger + duration on the session so the
          // completion message can show the full picture (pre%, post%,
          // token counts, trigger, wall time) regardless of whether a
          // turn-end usage sample has arrived between pre- and post-compact.
          if (metadata && typeof metadata === 'object') {
            const m = metadata as {
              trigger?: 'manual' | 'auto';
              pre_tokens?: number;
              post_tokens?: number;
              duration_ms?: number;
            };
            if (typeof m.pre_tokens === 'number') session.compactPreTokens = m.pre_tokens;
            if (typeof m.post_tokens === 'number') session.compactPostTokens = m.post_tokens;
            if (m.trigger === 'manual' || m.trigger === 'auto') session.compactTrigger = m.trigger;
            if (typeof m.duration_ms === 'number') session.compactDurationMs = m.duration_ms;

            // Mirror token counts into usagePct fields so the "was ~X% → now ~Y%"
            // message shows real numbers instead of `?` even on the very first
            // compaction of a session (before any turn-end usage sample).
            const contextWindow = resolveContextWindow(session.model);
            if (contextWindow > 0) {
              if (typeof m.pre_tokens === 'number') {
                session.preCompactUsagePct = Math.max(
                  0,
                  Math.min(100, Math.round((m.pre_tokens / contextWindow) * 100)),
                );
              }
              if (typeof m.post_tokens === 'number') {
                session.lastKnownUsagePct = Math.max(
                  0,
                  Math.min(100, Math.round((m.post_tokens / contextWindow) * 100)),
                );
              }
            }
          }

          this.logger.info('Compaction flag set — context will be re-injected on next prompt', {
            sessionKey,
            preTokens: session.compactPreTokens ?? null,
            postTokens: session.compactPostTokens ?? null,
            trigger: session.compactTrigger ?? null,
            durationMs: session.compactDurationMs ?? null,
            preCompactUsagePct: session.preCompactUsagePct ?? null,
            lastKnownUsagePct: session.lastKnownUsagePct ?? null,
          });

          // #617 AC5 fallback + AC3 end-to-end pending re-dispatch. Fire-and-forget
          // so a Slack failure cannot block the SDK stream callback chain. Wrap
          // the shared helper's own EventRouter dispatch as a narrow adapter —
          // the StreamExecutor's `dispatchPendingUserMessage` dep is the wiring
          // target here (not the EventRouter itself).
          void (async () => {
            try {
              await postCompactCompleteIfNeeded(
                {
                  session,
                  channel,
                  threadTs,
                  slackApi: this.deps.slackApi,
                  eventRouter: this.deps.dispatchPendingUserMessage
                    ? ({ dispatchPendingUserMessage: this.deps.dispatchPendingUserMessage } as any)
                    : undefined,
                },
                // `onCompactBoundary` is the authoritative metadata source —
                // post immediately; no grace window needed (trace.md Fix 2).
                { source: 'on-compact-boundary' },
              );
            } catch (err) {
              this.logger.warn('onCompactBoundary: post-compact path failed', {
                sessionKey,
                error: (err as Error)?.message ?? String(err),
              });
            }
          })();
        },
        onStatusUpdate: async (status: string) => {
          if (status === 'compacting') {
            // Context compaction start — always visible regardless of verbosity
            await this.legacySetStatus(channel, threadTs, '🗜️ 컨텍스트 압축 시작...');
            // #617 AC4 fallback: if the SDK PreCompact hook never fires
            // (older SDK or edge case), the `compacting` status still
            // guarantees a thread-visible "starting" post. Epoch dedupe in
            // the helper ensures the primary hook + this fallback cannot
            // double-post. Fire-and-forget so Slack latency doesn't block
            // the SDK status callback.
            void (async () => {
              try {
                await postCompactStartingIfNeeded(
                  { session, channel, threadTs, slackApi: this.deps.slackApi },
                  'unknown (fallback)',
                );
              } catch (err) {
                this.logger.warn('onStatusUpdate(compacting): fallback post failed', {
                  sessionKey,
                  error: (err as Error)?.message ?? String(err),
                });
              }
            })();
          } else if (status === 'compact_done') {
            // Context compaction end — always visible regardless of verbosity
            await this.legacySetStatus(channel, threadTs, '✅ 컨텍스트 압축 완료');
          } else if (status === 'working') {
            if (isOutputEnabled(OutputFlag.STATUS_REACTION)) {
              await this.deps.reactionManager.updateReaction(
                sessionKey,
                this.deps.statusReporter.getStatusEmoji('working'),
              );
            }
            if (isOutputEnabled(OutputFlag.STATUS_SPINNER)) {
              // Issue #688 — empty-string setStatus previously triggered the
              // heartbeat to re-send `''` every 20s (ghost spinner). The
              // manager now reroutes setStatus('') to clearStatus, but
              // calling clearStatus explicitly here makes intent clear and
              // carries the epoch guard so a stale call doesn't race.
              await this.legacyClearStatus(channel, threadTs, {
                expectedEpoch: epoch,
              });
            }
          }
        },
        buildFinalResponseFooter: async ({ usage, durationMs }) => {
          if (!isOutputEnabled(OutputFlag.SESSION_FOOTER)) return undefined;

          const usageAfter = activeSlotSnapshot
            ? await getTokenManager()
                .fetchAndStoreUsage(activeSlotSnapshot.keyId)
                .then((snap) => toUsagePercentSnapshot(snap))
                .catch(() => null)
            : null;
          const usageBefore = await usageBeforePromise;

          const footer = this.buildFinalResponseFooter({
            startedAt: requestStartedAt,
            durationMs,
            contextUsagePercentBefore,
            contextUsagePercentAfter: this.getContextUsagePercentFromResult(
              usage,
              session.usage?.contextWindow ?? FALLBACK_CONTEXT_WINDOW,
            ),
            usageBefore,
            usageAfter,
            toolStats: Object.keys(toolStats).length > 0 ? toolStats : undefined,
          });
          const tag = vtag(OutputFlag.SESSION_FOOTER);
          return tag ? `${tag}${footer}` : footer;
        },
      };

      // Create and run stream processor
      const processor = new StreamProcessor(streamCallbacks);

      // Wire compact duration callback: tool-event-processor → stream-processor
      this.deps.toolEventProcessor.setCompactDurationCallback((toolUseId, duration, ch) =>
        processor.updateToolCallDuration(toolUseId, duration, ch),
      );

      const streamResult = await processor.process(
        this.deps.claudeHandler.streamQuery(finalPrompt, session, abortController, workingDirectory, slackContext),
        streamContext,
        abortController.signal,
      );

      if (streamResult.aborted) {
        const abortError = new Error('Request was aborted');
        abortError.name = 'AbortError';
        throw abortError;
      }

      // Issue #42 S3: observer — endTurn 이벤트 + 텍스트 수집 + continuation/choice 동기화
      if (streamResult.endTurnInfo) {
        turnCollector.onEndTurn(streamResult.endTurnInfo);
      }
      if (streamResult.collectedText) {
        turnCollector.onText(streamResult.collectedText);
      }
      if (toolContinuation) {
        turnCollector.setContinuation(toolContinuation);
      }

      // Issue #122 followup: treat SDK result errors as failures
      const hasSdkError = !!streamResult.sdkResultError;

      // Update reaction based on whether user choice is pending
      const hasPendingChoice = Boolean(streamResult.hasUserChoice || toolChoicePending);
      const finalStatus = hasSdkError ? 'error' : hasPendingChoice ? 'waiting' : 'completed';
      if (isOutputEnabled(OutputFlag.STATUS_REACTION)) {
        await this.deps.reactionManager.updateReaction(
          sessionKey,
          this.deps.statusReporter.getStatusEmoji(finalStatus),
        );
      }
      // Always clear status regardless of verbosity — heartbeat timer must be stopped
      // to prevent leaked intervals when verbosity changes mid-stream.
      // Issue #688 — guarded by this turn's epoch so a stale call from a
      // previous aborted turn cannot nuke a newer spinner.
      await this.legacyClearStatus(channel, threadTs, {
        expectedEpoch: epoch,
      });

      // Transition activity state
      // Issue #391: Skip idle transition when continuation exists — next turn starts immediately,
      // so transitioning to idle would cause dashboard to briefly flicker to "대기" column.
      const hasContinuation = Boolean(toolContinuation);
      if (!hasContinuation) {
        this.deps.claudeHandler.setActivityState(channel, threadTs, hasPendingChoice ? 'waiting' : 'idle');
        await this.updateRuntimeStatus(session, sessionKey, {
          agentPhase: hasPendingChoice ? '입력 대기' : '사용자 액션 대기',
          activeTool: undefined,
          waitingForChoice: hasPendingChoice,
        });
      }

      // Update action panel with turn summary and latest response permalink
      await this.updateActionPanelTurnMeta(session, channel, requestStartedAt, toolStats, latestResponseTs);

      // Record assistant turn (fire-and-forget, non-blocking)
      if (session.conversationId && streamResult.collectedText) {
        recordAssistantTurn(session.conversationId, streamResult.collectedText);
      }

      // Issue #122: Surface SDK result errors to user (errors[] from SDKResultError)
      if (streamResult.sdkResultError) {
        const { subtype, errors, numTurns } = streamResult.sdkResultError;
        const escMrkdwn = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const errorLines = [`⚠️ *[SDK Result Error]* ${escMrkdwn(subtype)}`, `> *Turns:* ${numTurns ?? 'unknown'}`];
        if (errors.length > 0) {
          const capped = errors.slice(0, 5).map((e) => {
            const escaped = escMrkdwn(e);
            return escaped.length > 200 ? `${escaped.slice(0, 197)}...` : escaped;
          });
          errorLines.push(...capped.map((e) => `> • ${e}`));
          if (errors.length > 5) {
            errorLines.push(`> _...and ${errors.length - 5} more errors_`);
          }
        } else {
          errorLines.push(`> _No error details provided by SDK_`);
        }
        await say({ text: errorLines.join('\n'), thread_ts: threadTs });
      }

      // Reset error retry counts and error context on success (skip if SDK reported an error)
      if (!hasSdkError) {
        session.errorRetryCount = 0;
        session.fileAccessRetryCount = 0;
        session.lastErrorContext = undefined;
      }

      this.logger.info('Completed processing message', {
        sessionKey,
        messageCount: streamResult.messageCount,
      });

      // Fire turn completion notification (fire-and-forget)
      // Trace: docs/turn-notification/trace.md, Scenario 1, Section 3a
      // Trace: docs/rich-turn-notification/trace.md, Scenario 2
      //
      // Issue #720 — event construction is lifted OUTSIDE the
      // `if (this.deps.turnNotifier)` guard so a capability-active B5 emit
      // (`TurnSurface.end → snapshotPromise`) fires even when no
      // turnNotifier is wired (harness / tests / misconfigured DI).
      // Codex P1-2 decoupling requirement: event construction is independent
      // of turnNotifier presence.
      const category = determineTurnCategory({
        hasPendingChoice,
        isError: hasSdkError,
      });
      const durationMs = Date.now() - requestStartedAt.getTime();

      // Build the enriched event. Returns the event on success; throws on
      // any failure inside the enrichment pipeline (usage HTTP, etc.).
      const enrichAndResolve = async (): Promise<TurnCompletionEvent> => {
        const usageBefore = await usageBeforePromise;
        const usageAfter = activeSlotSnapshot
          ? await getTokenManager()
              .fetchAndStoreUsage(activeSlotSnapshot.keyId)
              .then((snap) => toUsagePercentSnapshot(snap))
              .catch(() => null)
          : null;
        const contextWindow = session.usage?.contextWindow ?? FALLBACK_CONTEXT_WINDOW;
        const contextUsagePercentAfter = this.getCurrentContextUsagePercent(session.usage);
        const contextUsageTokens = session.usage
          ? session.usage.currentInputTokens +
            session.usage.currentOutputTokens +
            (session.usage.currentCacheReadTokens ?? 0) +
            (session.usage.currentCacheCreateTokens ?? 0)
          : undefined;

        const finalEnrichedEvent: TurnCompletionEvent = {
          category,
          userId: session.ownerId || user,
          channel,
          threadTs,
          sessionTitle: session.title,
          durationMs,
          // Rich fields
          persona: userSettingsStore.getUserPersona(session.ownerId || user),
          model: session.model || userSettingsStore.getUserDefaultModel(session.ownerId || user),
          // Show effective effort (SDK defaults to 'high' when unset, matching getUserDefaultEffort)
          effort: session.effort ?? userSettingsStore.getUserDefaultEffort(session.ownerId || user),
          startedAt: requestStartedAt,
          contextUsagePercent: contextUsagePercentAfter,
          contextUsageDelta:
            typeof contextUsagePercentAfter === 'number'
              ? contextUsagePercentAfter - (contextUsagePercentBefore ?? 0)
              : undefined,
          contextUsageTokens,
          contextWindowSize: contextWindow,
          fiveHourUsage: usageAfter?.fiveHour,
          fiveHourDelta:
            typeof usageAfter?.fiveHour === 'number' && typeof usageBefore?.fiveHour === 'number'
              ? Math.round(usageAfter.fiveHour - usageBefore.fiveHour)
              : undefined,
          sevenDayUsage: usageAfter?.sevenDay,
          sevenDayDelta:
            typeof usageAfter?.sevenDay === 'number' && typeof usageBefore?.sevenDay === 'number'
              ? Math.round(usageAfter.sevenDay - usageBefore.sevenDay)
              : undefined,
          toolStats: Object.keys(toolStats).length > 0 ? toolStats : undefined,
        };

        return finalEnrichedEvent;
      };

      // Single chain, two exclusive rails:
      //   `.then` — resolves the snapshot with the event (B5 SSOT), then
      //     conditionally calls turnNotifier.notify. Notify is wrapped in
      //     its own try/catch so a notifier throw stays on the enrich-
      //     success side — it cannot propagate into the outer `.catch` and
      //     produce a second `resolveSnapshot(undefined)` call that races
      //     the first. The second resolve would be a Promise no-op, but
      //     the log would be misleading ("Turn completion enrichment
      //     failed" when enrichment had succeeded).
      //   `.catch` — enrichment-only failures (usageBefore / fetchAndStoreUsage
      //     HTTP failures, etc.). Resolves the snapshot with `undefined` so
      //     TurnSurface.end's `await` unblocks with no B5 emit.
      // resolveSnapshot fires exactly once either way. No `finally` safety-
      // net resolve — that would race the `.then` rail and lock in a
      // `undefined` snapshot (codex P1-1).
      enrichAndResolve()
        .then((evt) => {
          resolveSnapshot(evt);
          if (this.deps.turnNotifier) {
            try {
              // P5 exclusion — `buildCompletionNotifyOpts()` returns undefined
              // when capability is inactive, so the notify call is shape-
              // identical to pre-P5 on the legacy path.
              const notifyOpts = this.buildCompletionNotifyOpts();
              this.deps.turnNotifier.notify(evt, notifyOpts);
            } catch (err: unknown) {
              // Notifier throws are their own failure mode — logged with a
              // distinct message so operators can triage "enrich failed" vs
              // "notify threw" from the log alone.
              this.logger.warn('TurnNotifier.notify threw', {
                sessionKey,
                turnId,
                error: (err as { message?: string })?.message ?? String(err),
              });
            }
          }
        })
        .catch((err: unknown) => {
          resolveSnapshot(undefined);
          this.logger.warn('Turn completion enrichment failed', {
            sessionKey,
            turnId,
            stage: 'enrich',
            error: (err as { message?: string })?.message ?? String(err),
          });
        });

      // Start summary timer for non-error completions (fire-and-forget)
      // Trace: docs/turn-summary-lifecycle/trace.md, S1
      if (this.deps.turnNotifier && this.deps.summaryTimer && category !== 'Exception') {
        this.deps.summaryTimer.start(sessionKey, () => this.onSummaryTimerFire(session, sessionKey));
      }

      // Completion message tracking moved to SlackBlockKitChannel.send()
      // which tracks the actual posted notification message ts. Previously
      // tracked threadTs here, which for bot-initiated threads is the
      // surface/header message — causing header deletion on next input.

      // Update bot-initiated thread root with status
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
          say,
        );
        if (continuation) {
          turnCollector.setContinuation(continuation);
          return { success: true, messageCount: streamResult.messageCount, continuation, turnCollector };
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
          say,
        );
        if (continuation) {
          turnCollector.setContinuation(continuation);
          return { success: true, messageCount: streamResult.messageCount, continuation, turnCollector };
        }
      }

      if (toolContinuation) {
        return {
          success: true,
          messageCount: streamResult.messageCount,
          continuation: toolContinuation,
          turnCollector,
        };
      }

      return { success: true, messageCount: streamResult.messageCount, turnCollector };
    } catch (error: any) {
      const requestAborted = abortController.signal.aborted;
      // Issue #525 P1: close the B1 stream before handleError posts the
      // error block — otherwise the stream would linger until finally and
      // race with the error message rendering. PHASE=0 → no-op.
      //
      // Swallow any throw from the cleanup call so the original `error` still
      // reaches handleError(): losing the error message to the user is worse
      // than losing the stream-close log line.
      try {
        if (requestAborted) {
          await this.deps.threadPanel?.endTurn(turnId, 'aborted');
        } else {
          await this.deps.threadPanel?.failTurn(turnId, error as Error);
        }
      } catch (cleanupErr) {
        this.logger.warn('stream-executor: B1 close after catch failed', {
          turnId,
          requestAborted,
          cleanupError: (cleanupErr as Error)?.message ?? String(cleanupErr),
        });
      }
      // Dashboard v2.1 — turn timer: fold the active leg into the accumulator
      // on the error path (try/finally cannot guarantee it because we still
      // want the finally branch to be idempotent when the catch branch closes).
      try {
        this.deps.claudeHandler.getSessionRegistry().endTurn(session);
        this.deps.claudeHandler.getSessionRegistry().broadcastSessionUpdate();
      } catch (err) {
        this.logger.debug('stream-executor: endTurn timer hook (catch) failed', {
          turnId,
          error: (err as Error)?.message ?? String(err),
        });
      }
      const retryAfterMs = await this.handleError(
        error,
        session,
        sessionKey,
        channel,
        threadTs,
        processedFiles,
        say,
        requestAborted,
        activeSlotSnapshot,
        epoch,
      );
      return { success: false, messageCount: 0, retryAfterMs };
    } finally {
      // Issue #688 — defense-in-depth status clear on every exit path.
      // The success and error branches above already clear with the
      // same epoch guard; the manager is idempotent, and the guard
      // means this call is a no-op if a newer turn has already bumped
      // past `epoch`. Covers early-return paths that might skip the
      // normal success/error clears.
      try {
        await this.legacyClearStatus(channel, threadTs, {
          expectedEpoch: epoch,
        });
      } catch (err) {
        this.logger.debug('stream-executor: finally clearStatus failed', {
          turnId,
          error: (err as Error)?.message ?? String(err),
        });
      }
      // Idempotent: if end/fail already ran (catch or early-return path
      // inside try), TurnSurface state is cleared and this is a no-op.
      // Covers success-path exits via return from the try block.
      //
      // Swallow any throw so `cleanup()` below still runs — session cleanup
      // is critical for correctness (stale per-session state would leak).
      try {
        await this.deps.threadPanel?.endTurn(turnId, 'completed');
      } catch (cleanupErr) {
        this.logger.warn('stream-executor: B1 close in finally failed', {
          turnId,
          cleanupError: (cleanupErr as Error)?.message ?? String(cleanupErr),
        });
      }
      // #617 AC3: threshold check at turn-end. Must run AFTER endTurn so
      // session.usage reflects the just-completed turn. Fire-and-forget —
      // the helper sets `session.autoCompactPending=true` synchronously
      // before the Slack post, so the next user turn sees the flag
      // immediately; the decorative post must not block cleanup.
      void checkAndSchedulePendingCompact({
        session,
        userId: user,
        channel,
        threadTs,
        userSettings: userSettingsStore,
        slackApi: this.deps.slackApi,
        logger: this.logger,
      }).catch((err) => {
        this.logger.warn('stream-executor: compact threshold check failed', {
          turnId,
          error: (err as Error)?.message ?? String(err),
        });
      });
      // Dashboard v2.1 — turn timer: idempotent fold. If the catch branch
      // already ran endTurn, activeLegStartedAtMs is undefined and this is
      // a no-op. Guarantees the accumulator is correct on every exit path.
      try {
        this.deps.claudeHandler.getSessionRegistry().endTurn(session);
        this.deps.claudeHandler.getSessionRegistry().broadcastSessionUpdate();
      } catch (err) {
        this.logger.debug('stream-executor: endTurn timer hook (finally) failed', {
          turnId,
          error: (err as Error)?.message ?? String(err),
        });
      }
      await this.cleanup(session, sessionKey, abortController);
    }
  }

  /** Max auto-retries per error sequence before giving up */
  private static readonly MAX_ERROR_RETRIES = 3;
  /** Delay in ms before auto-retry on recoverable errors */
  private static readonly ERROR_RETRY_DELAY_MS = 30_000;
  /**
   * Delay in ms before auto-retry after a 1M→bare fallback (Issue #661).
   * Short — the retry is the fallback for a cold-start mistake, not a backoff.
   */
  private static readonly ONE_M_FALLBACK_RETRY_DELAY_MS = 500;
  /** Max SDK-details tail length (chars) surfaced in formatted error messages. */
  private static readonly SDK_DETAILS_MAX_CHARS = 500;

  /**
   * Handle execution errors. Returns retryAfterMs if the error is recoverable
   * and retry budget remains, so the caller can schedule an auto-retry.
   */
  private async handleError(
    error: any,
    session: ConversationSession,
    sessionKey: string,
    channel: string,
    threadTs: string,
    processedFiles: ProcessedFile[],
    say: SayFn,
    requestAborted: boolean = false,
    activeSlotAtQueryStart: ActiveTokenInfo | null = null,
    expectedEpoch?: number,
  ): Promise<number | undefined> {
    // Clear native spinner on any error and reset activity state.
    // Issue #688 — guard with the caller's captured epoch so a stale
    // error-path clear from a previous turn cannot kill a newer spinner.
    // Wrap the clear: a throw here must not skip the downstream
    // reaction-update + user-facing `say(errorDetails)` ~240 lines below.
    try {
      await this.legacyClearStatus(channel, threadTs, expectedEpoch !== undefined ? { expectedEpoch } : undefined);
    } catch (err) {
      this.logger.debug('handleError: legacyClearStatus failed — continuing error notification', {
        sessionKey,
        error: (err as Error)?.message ?? String(err),
      });
    }
    this.deps.claudeHandler.setActivityState(channel, threadTs, 'idle');

    // Check for context overflow error
    if (this.isContextOverflowError(error)) {
      await this.deps.contextWindowManager.handlePromptTooLong(sessionKey);
    }

    const isAbort = requestAborted || this.isAbortLikeError(error);

    // Fire Exception notification only for real errors, not abort/cancel.
    // Issue #661 — suppress on 1M-unavailable fallback: the turn is auto-
    // recoverable, not a user-facing exception.
    // Trace: docs/turn-notification/trace.md, Scenario 1, Section 3a — Exception path
    if (this.deps.turnNotifier && !isAbort && !this.isOneMContextUnavailableError(error)) {
      this.deps.turnNotifier
        .notify({
          category: 'Exception',
          userId: session.ownerId || '',
          channel,
          threadTs,
          sessionTitle: session.title,
          message: error?.message,
          durationMs: 0,
        })
        .catch((err) => this.logger.warn('Exception notification failed', { error: err?.message }));
    }

    let retryAfterMs: number | undefined;

    if (!isAbort) {
      this.logger.error('Error handling message', error);

      // Start status page fetch in parallel (non-blocking, 3s timeout)
      // Trace: docs/api-error-status/trace.md, Scenario 5, Section 3a
      const statusPromise = isApiLikeError(error) ? fetchClaudeStatus().catch(() => null) : Promise.resolve(null);

      await this.updateRuntimeStatus(session, sessionKey, {
        agentPhase: '오류 발생',
        activeTool: undefined,
        waitingForChoice: false,
      });

      // Clear session only when current conversation context is no longer reusable.
      // Transient errors (Slack API, rate-limit, process exit) should preserve session.
      const sessionCleared = this.shouldClearSessionOnError(error);

      if (sessionCleared) {
        this.deps.claudeHandler.clearSessionId(channel, threadTs);

        if (this.isImageProcessingError(error)) {
          this.logger.warn('Session cleared due to image processing error', {
            sessionKey,
            errorMessage: error.message,
          });
        } else {
          this.logger.info('Session cleared due to non-recoverable error', {
            sessionKey,
            errorType: error.name || 'unknown',
          });
        }
      } else if (this.isOneMContextUnavailableError(error)) {
        // Issue #661 — session-scoped fallback when the 1M variant is unusable.
        //
        // Policy: pin `session.model` to the bare model for THIS session only.
        // The user's persisted default is intentionally NOT touched; if they
        // want a permanent switch, they run `/z model <bareTarget>` themselves
        // (the formatter surfaces the exact command).
        //
        // Source of truth: `error.attemptedModel` — the model the SDK actually
        // tried on this turn. `session.model` is NOT authoritative because
        //   (a) legacy-restored sessions can have `session.model === undefined`
        //       (see session-registry hydration), and the next turn would then
        //       rehydrate `[1m]` from the user default and loop forever.
        //   (b) a concurrent `/z model` change could have mutated `session.model`
        //       between the SDK call and the error surfacing, so stripping the
        //       post-mutation value strips the wrong model.
        //
        // Behavior matrix (attempted has `[1m]`):
        //   session.model === undefined      → pin to bare, retry
        //   session.model has `[1m]`         → pin to bare, retry
        //   session.model already bare       → leave alone, NO retry (defensive)
        // If `attemptedModel` is missing or already bare, `sessionChanged`
        // stays false and we fall through without scheduling a retry — the
        // matcher gate upstream should already have rejected this, but the
        // invariant is belt-and-suspenders.
        const userId = session.ownerId || '';
        const previousSessionModel = session.model;
        const attemptedModelRaw = String((error as any).attemptedModel ?? '');
        const attemptedHasOneM = attemptedModelRaw !== '' && hasOneMSuffix(attemptedModelRaw);
        const bareFromAttempted = attemptedHasOneM ? stripOneMSuffix(attemptedModelRaw) : '';

        const shouldPinSessionModel =
          attemptedHasOneM && (previousSessionModel === undefined || hasOneMSuffix(String(previousSessionModel)));

        if (shouldPinSessionModel && bareFromAttempted) {
          session.model = coerceToAvailableModel(bareFromAttempted) as typeof session.model;
        }

        const sessionChanged = shouldPinSessionModel;
        // Formatter needs a concrete model name even on the no-op branch; if
        // attemptedModel is missing, fall back to whatever the (already-bare)
        // session.model is.
        const bareTargetInput = bareFromAttempted || stripOneMSuffix(String(previousSessionModel ?? ''));
        const kind = classifyOneMUnavailable(
          `${String((error as any).message ?? '')} ${String((error as any).stderrContent ?? '')}`,
        );
        (error as any).oneMFallbackInfo = {
          sessionChanged,
          bareTarget: coerceToAvailableModel(bareTargetInput),
          kind,
        };

        if (sessionChanged) {
          // Clear stale state so the next turn starts clean on the bare model.
          session.lastErrorContext = undefined;
          session.fileAccessRetryCount = 0;
          retryAfterMs = StreamExecutor.ONE_M_FALLBACK_RETRY_DELAY_MS;
          this.logger.info('1M fallback triggered (session-only)', {
            sessionKey,
            userId,
            from: attemptedModelRaw,
            sessionFrom: previousSessionModel,
            sessionTo: bareFromAttempted,
            kind,
          });
        } else {
          // Defensive no-strip: matcher fired but nothing actionable (attempted
          // missing/bare, or session already bare). No retry — the formatter
          // surfaces "추가 변경 없음" so the user knows why.
          this.logger.warn('1M fallback matcher fired but no session change applied', {
            sessionKey,
            userId,
            from: attemptedModelRaw,
            sessionModel: previousSessionModel,
            kind,
          });
        }
      } else if (this.isFileAccessBlockedError(error)) {
        // File access blocked: preserve session and inject error context so the
        // model can adapt its approach on retry instead of repeating the same action.
        const blockedPath = this.extractBlockedPath(error);
        const errorContext = blockedPath
          ? `파일 접근이 차단되었습니다: ${blockedPath}. 해당 파일에 접근하지 말고 다른 방법으로 계속 진행하세요.`
          : `파일 접근이 차단되었습니다. 접근이 차단된 파일은 시도하지 말고 다른 방법으로 계속 진행하세요.`;

        session.lastErrorContext = errorContext;

        this.logger.warn('File access blocked - session preserved with error context for intelligent retry', {
          sessionKey,
          blockedPath,
          errorMessage: error.message,
        });

        // Use isolated counter so prior rate-limit/transient errors don't consume file-access budget
        const fileRetryCount = session.fileAccessRetryCount ?? 0;
        if (fileRetryCount < StreamExecutor.MAX_ERROR_RETRIES) {
          session.fileAccessRetryCount = fileRetryCount + 1;
          retryAfterMs = StreamExecutor.FILE_ACCESS_RETRY_DELAY_MS;
          this.logger.info('Scheduling file-access-blocked retry with error context', {
            sessionKey,
            attempt: fileRetryCount + 1,
            delayMs: retryAfterMs,
          });
        } else {
          this.logger.warn('File access retry budget exhausted', { sessionKey, retryCount: fileRetryCount });
          session.fileAccessRetryCount = 0;
          session.lastErrorContext = undefined;
        }
      } else {
        const isRecoverable = this.isRecoverableClaudeSdkError(error);
        this.logger.warn(
          isRecoverable
            ? 'Recoverable error - session preserved'
            : 'Unknown error - session preserved (default policy)',
          {
            sessionKey,
            errorMessage: error.message,
          },
        );

        // Clear stale file-access state — this is a different error class now,
        // so the model should not receive outdated "avoid file X" guidance,
        // and the file-access retry budget should restart fresh if it recurs.
        session.lastErrorContext = undefined;
        session.fileAccessRetryCount = 0;

        // Auto-rotate token on rate limit (pass query-start slot for CAS safety)
        if (this.isRateLimitError(error)) {
          await this.tryRotateToken(error, activeSlotAtQueryStart);
        }

        // Auto-retry only for known recoverable errors.
        // Unknown errors are preserved but not auto-retried — the user
        // decides whether to continue or `/reset`.
        if (isRecoverable) {
          const retryCount = session.errorRetryCount ?? 0;
          if (retryCount < StreamExecutor.MAX_ERROR_RETRIES) {
            session.errorRetryCount = retryCount + 1;
            retryAfterMs = StreamExecutor.ERROR_RETRY_DELAY_MS;
            this.logger.info('Scheduling auto-retry on recoverable error', {
              sessionKey,
              attempt: retryCount + 1,
              maxRetries: StreamExecutor.MAX_ERROR_RETRIES,
              delayMs: retryAfterMs,
            });
          } else {
            this.logger.warn('Auto-retry budget exhausted', {
              sessionKey,
              retryCount,
            });
            // Reset for next error sequence
            session.errorRetryCount = 0;
          }
        } else {
          // Unknown errors: reset retry budget so a subsequent recoverable
          // error starts fresh (not with a partially consumed budget).
          session.errorRetryCount = 0;
        }
      }

      await this.deps.reactionManager.updateReaction(sessionKey, this.deps.statusReporter.getStatusEmoji('error'));

      // Notify user with detailed error info + Claude service status
      // Trace: docs/api-error-status/trace.md, Scenario 5, Section 3c
      const statusInfo = await statusPromise;
      const retryAttempt = retryAfterMs
        ? this.isFileAccessBlockedError(error)
          ? (session.fileAccessRetryCount ?? 0)
          : (session.errorRetryCount ?? 0)
        : undefined;
      const errorDetails = this.formatErrorForUser(error, sessionCleared, statusInfo, retryAttempt);
      await say({
        text: errorDetails,
        thread_ts: threadTs,
      });
    } else {
      // AbortError - preserve session history for conversation continuity
      this.logger.debug('Request was aborted, preserving session history', { sessionKey });
      await this.updateRuntimeStatus(session, sessionKey, {
        agentPhase: '요청 취소됨',
        activeTool: undefined,
        waitingForChoice: false,
      });

      await this.deps.reactionManager.updateReaction(sessionKey, this.deps.statusReporter.getStatusEmoji('cancelled'));
    }

    // Clean up temporary files
    if (processedFiles.length > 0) {
      await this.deps.fileHandler.cleanupTempFiles(processedFiles);
    }

    return retryAfterMs;
  }

  private async updateToolCallMessage(channel: string, ts: string, text: string): Promise<void> {
    try {
      await this.deps.slackApi.updateMessage(channel, ts, text);
    } catch (error) {
      this.logger.debug('Failed to update tool call message', {
        ts,
        error: (error as Error).message,
      });
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
      message.includes('operation aborted') // covers "Operation aborted" and "operation was aborted"
    );
  }

  private shouldClearSessionOnError(error: any): boolean {
    if (this.isSlackApiError(error)) {
      return false;
    }

    // Issue #661 — 1M context unavailable: the session's prior history is
    // still valid on the bare model, so keep it. Checked early so a message
    // containing both "1m" markers and e.g. "could not process image" can't
    // misroute into the image branch. (In practice the signals are disjoint,
    // but the precedence here encodes intent.)
    if (this.isOneMContextUnavailableError(error)) {
      return false;
    }

    // Image processing errors MUST be checked before recoverability.
    // A poisoned image in session history makes every retry fail identically,
    // so even if the error message also matches a "recoverable" pattern
    // (e.g. "timed out" + "could not process image"), we must clear the session.
    if (this.isImageProcessingError(error)) {
      return true;
    }

    if (this.isContextOverflowError(error)) {
      return true;
    }

    // Issue #118: Check invalid-resume BEFORE recoverable, because
    // "process exited with code 1" (recoverable) may wrap "No conversation found" (non-recoverable).
    // More specific patterns must take precedence over broad ones.
    if (this.isInvalidResumeSessionError(error)) {
      return true;
    }

    if (this.isFileAccessBlockedError(error)) {
      return false;
    }

    if (this.isRecoverableClaudeSdkError(error)) {
      return false;
    }

    // Default: preserve session. Unknown errors keep the session alive
    // so the user can continue the conversation or manually reset via
    // `/reset`. If the session is truly broken, the bot will detect it
    // on the next turn (isInvalidResumeSessionError). Unknown errors
    // are NOT auto-retried — only known recoverable patterns get retries.
    return false;
  }

  private isContextOverflowError(error: any): boolean {
    const message = String(error?.message || '').toLowerCase();

    return (
      message.includes('prompt is too long') ||
      message.includes('context length exceeded') ||
      message.includes('maximum context length')
    );
  }

  /**
   * Detect API 400 errors caused by unprocessable image content in the
   * conversation context.  Once an image that the API cannot handle is part
   * of the session history, every subsequent request will fail with the same
   * error, so the session must be cleared.
   */
  private isImageProcessingError(error: any): boolean {
    const message = String(error?.message || '').toLowerCase();
    const stderr = String(error?.stderrContent || '').toLowerCase();
    const combined = `${message} ${stderr}`;

    return (
      combined.includes('could not process image') ||
      combined.includes('invalid image format') ||
      combined.includes('invalid image content') ||
      combined.includes('image too large') ||
      combined.includes('unsupported image format')
    );
  }

  /**
   * Issue #661 — Detect "1M context unavailable for this account" errors.
   *
   * Matcher gate (both branches must individually qualify; no broad string
   * match — see `isOneMContextUnavailableSignal` for the narrow signal check):
   *   1. `error.code === 'ONE_M_CONTEXT_UNAVAILABLE'` — the claude-handler
   *      `maybeThrowOneMUnavailable` helper set this when it converted the
   *      SDK's assistant message into a throw. Fast path.
   *   2. OR `hasOneMSuffix(error.attemptedModel)` — defensive path for
   *      third-party call sites that may surface the same error without the
   *      code set (e.g., a future SDK change that throws directly). Requires
   *      `attemptedModel` to end with `[1m]` so we never downgrade a bare
   *      model's generic failure.
   *
   * The signal text is only examined for branch 2 (message + stderr combined).
   * Branch 1 trusts the code — if the code is set, the producer already did
   * the text matching.
   */
  private isOneMContextUnavailableError(error: any): boolean {
    if (!error) return false;
    if (error.code === ONE_M_CONTEXT_UNAVAILABLE_CODE) return true;
    const attempted = String(error.attemptedModel ?? '');
    if (!attempted || !hasOneMSuffix(attempted)) return false;
    const combined = `${String(error.message ?? '')} ${String(error.stderrContent ?? '')}`;
    return isOneMContextUnavailableSignal(combined);
  }

  private isRecoverableClaudeSdkError(error: any): boolean {
    // Issue #118: Check both message AND stderrContent (rate-limit/transient
    // errors often appear only in stderr while message is "process exited with code 1")
    const message = String(error?.message || '').toLowerCase();
    const stderr = String(error?.stderrContent || '').toLowerCase();
    const combined = `${message} ${stderr}`;

    const recoverablePatterns = [
      "you've hit your limit",
      'out of extra usage',
      'rate limit',
      'too many requests',
      '429',
      'process exited with code',
      'temporarily unavailable',
      'service unavailable',
      'overloaded',
      'timed out',
      'timeout',
      'network error',
      'connection reset',
      'ecconnreset',
      'econnreset',
      'etimedout',
      'eai_again',
    ];

    return recoverablePatterns.some((pattern) => combined.includes(pattern));
  }

  private isRateLimitError(error: any): boolean {
    // Check both error.message AND stderr content (rate limit text often
    // appears in stderr while error.message is just "process exited with code 1")
    const message = String(error?.message || '').toLowerCase();
    const stderr = String(error?.stderrContent || '').toLowerCase();
    const combined = `${message} ${stderr}`;
    return (
      combined.includes("you've hit your limit") ||
      combined.includes('out of extra usage') ||
      combined.includes('rate limit') ||
      combined.includes('too many requests') ||
      combined.includes('429')
    );
  }

  /**
   * Attempt to rotate to the next available slot on rate limit.
   * Uses the CCT-store's CAS-safe `rotateOnRateLimit` which records the
   * cooldown on the slot that was active at the time the rate-limit was
   * observed (which is why we pin the slot at query-start rather than
   * reading the active slot at error time).
   *
   * NOTE: This is the FALLBACK path — triggered only by stderr/error-string
   * pattern match (`isRateLimitError`). The Claude CLI spawns a subprocess
   * and the SDK surfaces only its stdout/stderr here, so this file has no
   * access to the raw HTTP response headers of the Anthropic API call. The
   * primary `parseRateLimitHeaders` path runs inside `oauth/usage.ts` +
   * TokenManager.fetchAndStoreUsage, which persist hints on the slot.
   *
   * TODO: when the Claude Code SDK exposes response headers from the
   * streaming API call back to embedders, wire `parseRateLimitHeaders`
   * here and trigger rotation with `source: 'response_header'` BEFORE
   * the string-match catch-block sees the error.
   *
   * @param error The error object (may contain stderrContent with rate limit details)
   * @param activeSlotAtQueryStart Slot captured at query-start for CAS safety
   */
  private async tryRotateToken(error: any, activeSlotAtQueryStart: ActiveTokenInfo | null): Promise<void> {
    // Parse cooldown from both error message and stderr content.
    const errorText = `${error?.message || ''} ${error?.stderrContent || ''}`;
    const parsedCooldown = parseCooldownTime(errorText);
    const cooldownMinutes = parsedCooldown
      ? Math.max(1, Math.round((parsedCooldown.getTime() - Date.now()) / 60_000))
      : 60; // default 1 hour

    const reason = `stream-executor rate-limit${
      activeSlotAtQueryStart ? ` on slot=${activeSlotAtQueryStart.name}` : ''
    }`;

    const rotated = await getTokenManager().rotateOnRateLimit(reason, {
      source: 'error_string',
      cooldownMinutes,
    });

    if (rotated) {
      this.logger.info(
        'CCT slot auto-rotated',
        redactAnthropicSecrets({ newSlot: rotated.name, newKeyId: rotated.keyId }) as Record<string, unknown>,
      );
    } else {
      this.logger.warn('CCT rotateOnRateLimit: no eligible replacement slot', {
        rateLimitedSlot: activeSlotAtQueryStart?.name,
        cooldownMinutes,
      });
    }
  }

  private isInvalidResumeSessionError(error: any): boolean {
    // Issue #118: Check both message AND stderrContent — SDK may wrap the real
    // cause in stderr while message is just "process exited with code 1"
    const message = String(error?.message || '').toLowerCase();
    const stderr = String(error?.stderrContent || '').toLowerCase();
    const combined = `${message} ${stderr}`;

    const invalidSessionPatterns = [
      'no conversation found', // Issue #118: exact SDK error message
      'conversation not found',
      'session not found',
      'cannot resume',
      'invalid resume',
      'resume session',
    ];

    return invalidSessionPatterns.some((pattern) => combined.includes(pattern));
  }

  /**
   * Detect provider sandbox errors where file access is blocked by the SDK.
   * These are NOT fatal — the model can adapt by trying alternative approaches.
   * Instead of crashing, we preserve the session and inject error context so the
   * model knows which file/resource is inaccessible.
   */
  private isFileAccessBlockedError(error: any): boolean {
    const message = String(error?.message || '').toLowerCase();
    const stderr = String(error?.stderrContent || '').toLowerCase();
    const combined = `${message} ${stderr}`;

    return (
      combined.includes('file access blocked') ||
      (combined.includes('permission denied') && combined.includes('normalizedprovidererror'))
    );
  }

  /**
   * Extract the blocked resource path from a file access error message.
   * Supports both "File access blocked: /path" and "permission denied for /path" patterns.
   */
  private extractBlockedPath(error: any): string | undefined {
    const message = String(error?.message || '');
    const stderr = String(error?.stderrContent || '');
    const combined = `${message}\n${stderr}`;

    // Try "File access blocked: /path/to/file" first
    const fileAccessMatch = combined.match(/file access blocked:\s*(.+?)(?:\n|$)/i);
    if (fileAccessMatch?.[1]?.trim()) {
      return fileAccessMatch[1].trim();
    }

    // Fallback: "permission denied for /path" or "permission denied: /path"
    const permissionMatch = combined.match(/permission denied[:\s]+(?:for\s+)?(\/.+?)(?:\n|$)/i);
    return permissionMatch?.[1]?.trim();
  }

  /** Retry delay for file-access-blocked errors (shorter than rate-limit retries) */
  private static readonly FILE_ACCESS_RETRY_DELAY_MS = 5_000;

  /**
   * Summary timer callback — executes fork query and renders result to thread panel.
   * Extracted as a named method so it can be tested independently.
   */
  private async onSummaryTimerFire(session: ConversationSession, sessionKey: string): Promise<void> {
    if (!this.deps.summaryService) return;

    // Create AbortController for this fork — stored so new user input can abort it.
    const abortController = new AbortController();
    this.summaryAbortControllers.set(sessionKey, abortController);

    try {
      const summaryText = await this.deps.summaryService.execute(session as any, abortController.signal);

      // CAS cleanup: only remove if this controller is still the active one for this session.
      // Prevents a slow summary A from deleting a newer summary B's controller.
      if (this.summaryAbortControllers.get(sessionKey) === abortController) {
        this.summaryAbortControllers.delete(sessionKey);
      }

      if (summaryText) {
        this.deps.summaryService.displayOnThread(session as any, summaryText);
        // Trigger re-render so the summary blocks appear in the Slack thread header.
        // Without this, summaryBlocks sit in memory but the message is never updated.
        await this.deps.threadPanel?.updatePanel(session, sessionKey);
      }
    } catch (err: any) {
      if (this.summaryAbortControllers.get(sessionKey) === abortController) {
        this.summaryAbortControllers.delete(sessionKey);
      }
      if (abortController.signal.aborted) {
        this.logger.info('Summary fork aborted by new user input', { sessionKey });
        return;
      }
      this.logger.warn('Summary timer callback failed', { error: err?.message });
    }
  }

  private async cleanup(
    session: ConversationSession,
    sessionKey: string,
    abortController?: AbortController,
  ): Promise<void> {
    // Ghost Session Fix #99: CAS guard — only remove if this request's controller is still registered
    this.deps.requestCoordinator.removeController(sessionKey, abortController);

    // Abort and clean up any in-flight summary fork for this session
    const pendingSummaryAbort = this.summaryAbortControllers.get(sessionKey);
    if (pendingSummaryAbort) {
      pendingSummaryAbort.abort();
      this.summaryAbortControllers.delete(sessionKey);
    }

    // Cleanup active MCP status tracking to prevent stuck timers
    this.deps.toolEventProcessor.cleanup(sessionKey);

    try {
      await this.deps.threadPanel?.updatePanel(session, sessionKey);
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
      'msg_blocks_too_long',
      'invalid_arguments',
      'missing_scope',
      'token_revoked',
      'no more than 50 items allowed', // Slack block limit
      'an api error occurred',
    ];

    return slackErrorPatterns.some((pattern) => message.includes(pattern));
  }

  /**
   * Sanitize + truncate `error.stderrContent` and push a `> *SDK Details:*`
   * block onto `lines`. No-op when stderrContent is missing/empty.
   *
   * Factored out of `formatErrorForUser` (Issue #661) so both the normal
   * formatter branches and the new 1M-fallback branch share the exact same
   * redaction/truncation logic — avoids drift if the sanitizer changes.
   * Trace: Issue #122 original sanitization rules are preserved byte-for-byte.
   */
  private appendSdkDetails(lines: string[], error: any): void {
    if (!error?.stderrContent) return;
    const raw = String(error.stderrContent);
    // Strip ANSI escape codes and mask non-Anthropic credentials locally;
    // Anthropic tokens (sk-ant-{oat01,ort01,api03,admin01}-...) are handled
    // by the shared `redactAnthropicSecrets` helper from logger.ts so every
    // log path masks them the same way (W3-B consolidation).
    const nonAnthropicSanitized = raw
      .replace(/[\x1B\x9B](?:\[[0-9;]*[a-zA-Z]|\].*?(?:\x07|\x1B\\)|\([A-Z])/g, '') // strip ANSI
      .replace(/(?:authorization|bearer)[=:\s]+\S+(?:\s+\S+)?/gi, '[REDACTED]') // auth headers ("Bearer <token>")
      .replace(/(?:oauth|token|key|secret|password|credential)[=:\s]+\S+/gi, '[REDACTED]')
      .replace(/\bxox[bpras]-[a-zA-Z0-9-]+/g, '[REDACTED]') // Slack tokens
      .replace(/\bgh[pus]_[a-zA-Z0-9]+/g, '[REDACTED]') // GitHub PATs
      .replace(/\bgithub_pat_[a-zA-Z0-9_]+/g, '[REDACTED]'); // GitHub fine-grained PATs
    const sanitized = redactAnthropicSecrets(nonAnthropicSanitized) as string;
    // Take last SDK_DETAILS_MAX_CHARS chars to keep message manageable
    const max = StreamExecutor.SDK_DETAILS_MAX_CHARS;
    const truncated = sanitized.length > max ? `…${sanitized.slice(-max)}` : sanitized;
    lines.push(`> *SDK Details:*`);
    lines.push(`> \`\`\`${truncated.trim()}\`\`\``);
  }

  /**
   * Format error message for user with detailed info
   * Distinguishes between bot system errors and model errors
   */
  private formatErrorForUser(
    error: any,
    sessionCleared: boolean,
    statusInfo?: import('../../claude-status-fetcher').ClaudeStatusInfo | null,
    retryAttempt?: number,
  ): string {
    // Issue #661 — top-priority branch for 1M-context auto-fallback.
    // Reads `oneMFallbackInfo` (set by the handleError 1M branch) so the
    // wording matches what actually happened on this turn:
    //   - `sessionChanged=true`  → pinned bare for THIS session, retry scheduled
    //   - `sessionChanged=false` → no retry (already bare / nothing to strip)
    //   - `kind='auth'`          → auth-mode incompatibility; bill fix is wrong
    //   - `kind='entitlement'`   → account lacks 1M; Extra Usage/upgrade is right
    if (this.isOneMContextUnavailableError(error)) {
      const info = (error as any).oneMFallbackInfo as
        | { sessionChanged: boolean; bareTarget: string; kind?: OneMUnavailableKind }
        | undefined;
      const bareTarget = info?.bareTarget || 'bare model';
      const kind: OneMUnavailableKind = info?.kind ?? 'entitlement';
      const lines: string[] = [`ℹ️ *[1M context 미지원]* 자동 폴백을 수행했습니다.`, ''];

      lines.push(`> *Type:* Claude SDK (OneMContextUnavailable)`);
      if (info?.sessionChanged) {
        // Retry WILL happen — say so, and explain the pin.
        lines.push(`> *Session:* ✅ 유지됨 - bare 모델로 자동 재시도합니다.`);
        if (kind === 'auth') {
          lines.push(`> *원인:* 현재 인증 방식은 long-context 베타 헤더와 호환되지 않습니다.`);
        } else {
          lines.push(`> *원인:* 현재 계정은 1M context 확장을 사용할 수 없습니다.`);
        }
        lines.push(
          `> *조치:* 이번 세션 모델을 \`${bareTarget}\`로 자동 전환했습니다. (기본값 설정은 변경되지 않습니다)`,
        );
      } else {
        // No retry scheduled — do NOT promise one. Tell the user the session
        // is still on its current model and explain why nothing changed.
        lines.push(`> *Session:* ✅ 유지됨 - 자동 재시도 없음 (이미 bare 모델).`);
        lines.push(`> *원인:* 이미 bare 모델 사용 중 — 추가 변경 없음.`);
      }

      // Remediation hint — match the error class so we don't send
      // auth-mode failures to billing.
      if (kind === 'auth') {
        lines.push(`> _\`[1m]\` 변형을 계속 쓰려면 운영자에게 인증 구성(토큰 종류/CCT 슬롯) 점검을 요청하세요._`);
      } else {
        lines.push(`> _\`[1m]\` 변형을 계속 쓰려면 Claude Extra Usage를 활성화하거나 요금제를 업그레이드하세요._`);
      }
      // Permanent-change hint always targets the actual bare model — not a
      // hardcoded alias that could resolve to a different model family.
      lines.push(`> _기본값을 영구 변경하려면 \`/z model ${bareTarget}\`를 실행하세요._`);

      // Share the same SDK Details block so the raw signal is visible for
      // debugging even on the fallback path.
      this.appendSdkDetails(lines, error);

      // Preserve service-status parity with the other branches.
      if (shouldShowStatusBlock(statusInfo ?? null)) {
        lines.push('');
        lines.push(formatStatusForSlack(statusInfo ?? null));
      }

      return lines.join('\n');
    }

    const errorType = this.isSlackApiError(error) ? 'Slack API' : 'Claude SDK';
    const errorName = error.name || 'Error';
    const errorMessage = error.message || 'Something went wrong';

    const lines = [`❌ *[Bot Error]* ${errorMessage}`, '', `> *Type:* ${errorType} (${errorName})`];

    if (sessionCleared) {
      lines.push(`> *Session:* 🔄 초기화됨 - 대화 기록이 리셋되었습니다.`);
      if (this.isImageProcessingError(error)) {
        const combined = `${String(error?.message || '')} ${String(error?.stderrContent || '')}`.toLowerCase();
        if (combined.includes('image too large')) {
          lines.push(`> *원인:* 이미지가 너무 큽니다. API에서 처리할 수 있는 크기를 초과했습니다.`);
          lines.push(`> _이미지 크기를 줄이거나 텍스트로 내용을 설명해 주세요._`);
        } else {
          lines.push(
            `> *원인:* 이미지를 처리할 수 없습니다. 해당 이미지는 API에서 지원하지 않는 형식이거나 손상되었을 수 있습니다.`,
          );
          lines.push(`> _이미지 대신 텍스트로 내용을 설명해 주세요._`);
        }
      } else {
        lines.push(`> _다음 메시지부터 새 세션으로 시작됩니다._`);
      }
    } else if (this.isFileAccessBlockedError(error)) {
      const blockedPath = this.extractBlockedPath(error);
      const willRetry = retryAttempt !== undefined && retryAttempt > 0;
      lines.push(`> *Session:* ✅ 유지됨${willRetry ? ' - 다른 방법으로 자동 재시도합니다.' : ''}`);
      lines.push(`> *원인:* 파일 접근이 SDK 샌드박스에 의해 차단되었습니다.`);
      if (blockedPath) {
        lines.push(`> *차단된 경로:* \`${blockedPath}\``);
      }
      if (willRetry) {
        lines.push(`> _모델에게 에러를 전달하여 대안 경로로 계속 진행합니다._`);
      } else {
        lines.push(`> _자동 재시도 횟수를 초과했습니다. 메시지를 보내면 계속할 수 있습니다._`);
      }
    } else {
      lines.push(`> *Session:* ✅ 유지됨 - 대화를 계속할 수 있습니다.`);
      // For unknown (non-recoverable-pattern) errors preserved by default,
      // hint the user that they can manually reset if things look broken.
      if (!this.isRecoverableClaudeSdkError(error) && !this.isSlackApiError(error)) {
        lines.push(`> _문제가 계속되면 \`/reset\` 으로 세션을 초기화할 수 있습니다._`);
      }
    }

    // Issue #122: Append SDK stderr details so users can see the actual error cause
    this.appendSdkDetails(lines, error);

    // Append slot rotation info if rate limit triggered rotation
    if (this.isRateLimitError(error) && getTokenManager().listTokens().length > 1) {
      const active = getTokenManager().getActiveToken();
      if (active) {
        lines.push(`> 🔄 Token auto-rotated → *${active.name}*`);
      }
    }

    // Append auto-retry info
    if (retryAttempt !== undefined && retryAttempt > 0) {
      const delayMs = this.isFileAccessBlockedError(error)
        ? StreamExecutor.FILE_ACCESS_RETRY_DELAY_MS
        : StreamExecutor.ERROR_RETRY_DELAY_MS;
      const delaySec = delayMs / 1000;
      lines.push(`> ⏳ ${delaySec}초후 작업을 재개합니다. (시도 ${retryAttempt}/${StreamExecutor.MAX_ERROR_RETRIES})`);
    }

    // Append Claude service status when there's an actual issue OR active incidents
    // Fix: Bug 5 — extracted to shouldShowStatusBlock() for testability
    // Trace: docs/status-fetcher-hardening/trace.md, S3
    if (shouldShowStatusBlock(statusInfo ?? null)) {
      lines.push('');
      lines.push(formatStatusForSlack(statusInfo ?? null));
    }

    return lines.join('\n');
  }

  private async updateRuntimeStatus(
    session: ConversationSession,
    sessionKey: string,
    patch: {
      agentPhase?: string;
      activeTool?: string;
      waitingForChoice?: boolean;
    },
  ): Promise<void> {
    await this.deps.threadPanel?.setStatus(session, sessionKey, patch);
  }

  /**
   * Write turn duration, tool-call count, and latest response permalink into
   * session.actionPanel so the panel builder can surface them.
   */
  private async updateActionPanelTurnMeta(
    session: ConversationSession,
    channel: string,
    requestStartedAt: Date,
    toolStats: RequestToolStats,
    latestResponseTs: string | undefined,
  ): Promise<void> {
    if (!session.actionPanel) return;

    const elapsedMs = Date.now() - requestStartedAt.getTime();
    const totalToolCalls = Object.values(toolStats).reduce((sum, s) => sum + s.count, 0);
    const elapsedText = this.formatElapsed(elapsedMs);
    session.actionPanel.turnSummary =
      totalToolCalls > 0 ? `⏱ ${elapsedText} · 🛠 ${totalToolCalls}` : `⏱ ${elapsedText}`;

    if (latestResponseTs) {
      session.actionPanel.latestResponseTs = latestResponseTs;
      const permalink = await this.deps.slackApi.getPermalink(channel, latestResponseTs).catch(() => null);
      if (permalink) {
        session.actionPanel.latestResponseLink = permalink;
      }
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
    const persona = userSettingsStore.getUserPersona(userId);
    const defaultModel = userSettingsStore.getUserDefaultModel(userId);
    const bypassPermission = userSettingsStore.getUserBypassPermission(userId);

    const contextItems: string[] = [];

    // User context
    if (slackName) contextItems.push(`  <slack-name>${slackName}</slack-name>`);
    if (jiraName) contextItems.push(`  <jira-name>${jiraName}</jira-name>`);
    if (jiraAccountId) contextItems.push(`  <jira-account-id>${jiraAccountId}</jira-account-id>`);
    contextItems.push(`  <user-persona>${persona}</user-persona>`);
    contextItems.push(`  <user-default-model>${defaultModel}</user-default-model>`);
    contextItems.push(`  <user-bypass-permission>${bypassPermission ? 'on' : 'off'}</user-bypass-permission>`);

    // User rating - model self-awareness of user satisfaction
    const rating = userSettingsStore.getUserRating(userId);
    contextItems.push(`  <your_rating>${rating}</your_rating>`);

    // Rating change notification (injected once after user changes rating)
    const pendingChange = userSettingsStore.consumePendingRatingChange(userId);
    if (pendingChange) {
      const direction = pendingChange.to > pendingChange.from ? 'up' : 'down';
      contextItems.push(
        `  <rating_change>${pendingChange.from}→${pendingChange.to} (user rated you ${direction})</rating_change>`,
      );
    }

    // Environment context - always include cwd and timestamp
    contextItems.push(`  <cwd>${workingDirectory}</cwd>`);
    contextItems.push(`  <timestamp>${new Date().toISOString()}</timestamp>`);

    return ['<context>', ...contextItems, '</context>'].join('\n');
  }

  private getCurrentContextUsagePercent(usage?: SessionUsage): number | undefined {
    if (!usage || usage.contextWindow <= 0) {
      return undefined;
    }

    const usedTokens =
      usage.currentInputTokens +
      usage.currentOutputTokens +
      (usage.currentCacheReadTokens ?? 0) +
      (usage.currentCacheCreateTokens ?? 0);
    const percent = (usedTokens / usage.contextWindow) * 100;
    return Math.max(0, Math.min(100, Math.round(percent * 10) / 10));
  }

  private getContextUsagePercentFromResult(usage: UsageData | undefined, contextWindow: number): number | undefined {
    if (!usage || contextWindow <= 0) {
      return undefined;
    }

    const usedTokens =
      usage.inputTokens +
      usage.outputTokens +
      (usage.cacheReadInputTokens ?? 0) +
      (usage.cacheCreationInputTokens ?? 0);
    const percent = (usedTokens / contextWindow) * 100;
    return Math.max(0, Math.min(100, Math.round(percent * 10) / 10));
  }

  private buildFinalResponseFooter(data: FinalFooterData): string | undefined {
    const lines: string[] = [];
    const endedAt =
      typeof data.durationMs === 'number' ? new Date(data.startedAt.getTime() + data.durationMs) : new Date();

    lines.push(
      `⏰ ${this.formatClock(data.startedAt)} → ${this.formatClock(endedAt)} (${this.formatElapsed(endedAt.getTime() - data.startedAt.getTime())})`,
    );

    if (typeof data.contextUsagePercentAfter === 'number') {
      const contextAfter = data.contextUsagePercentAfter;
      const contextDelta =
        typeof data.contextUsagePercentBefore === 'number' ? contextAfter - data.contextUsagePercentBefore : undefined;
      const contextDeltaText = this.formatSignedDelta(contextDelta, 1);
      const contextDeltaSuffix = contextDeltaText ? ` ${contextDeltaText}` : '';
      lines.push(`Ctx ${this.renderBar(contextAfter)} ${contextAfter.toFixed(1)}%${contextDeltaSuffix}`);
    }

    const fiveHour = data.usageAfter?.fiveHour;
    const sevenDay = data.usageAfter?.sevenDay;
    const fiveHourDelta =
      typeof fiveHour === 'number' && typeof data.usageBefore?.fiveHour === 'number'
        ? Math.round(fiveHour - data.usageBefore.fiveHour)
        : undefined;
    const sevenDayDelta =
      typeof sevenDay === 'number' && typeof data.usageBefore?.sevenDay === 'number'
        ? Math.round(sevenDay - data.usageBefore.sevenDay)
        : undefined;

    const fiveHourPercent = this.formatPercent(fiveHour);
    const sevenDayPercent = this.formatPercent(sevenDay);
    const fiveHourDeltaText = this.formatSignedDelta(fiveHourDelta, 0) ?? '--';
    const sevenDayDeltaText = this.formatSignedDelta(sevenDayDelta, 0) ?? '--';

    lines.push(
      `5h  ${this.renderBar(fiveHour ?? 0)} ${fiveHourPercent} ${fiveHourDeltaText}  ` +
        `7d ${this.renderBar(sevenDay ?? 0, 8)} ${sevenDayPercent} ${sevenDayDeltaText}`,
    );

    // Per-request tool statistics
    if (data.toolStats) {
      const toolLine = this.formatToolStats(data.toolStats);
      if (toolLine) {
        lines.push(toolLine);
      }
    }

    if (lines.length === 0) {
      return undefined;
    }

    return ['```', ...lines, '```'].join('\n');
  }

  private formatClock(date: Date): string {
    return date.toLocaleTimeString('ko-KR', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });
  }

  private formatElapsed(durationMs: number): string {
    const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }

  private renderBar(percent: number, width: number = 14): string {
    const clamped = Math.max(0, Math.min(100, percent));
    const filled = Math.round((clamped / 100) * width);
    return '▓'.repeat(filled) + '░'.repeat(width - filled);
  }

  private formatPercent(percent?: number): string {
    if (typeof percent !== 'number' || !Number.isFinite(percent)) {
      return '--%';
    }

    return `${String(Math.round(percent)).padStart(3)}%`;
  }

  /** Format per-request tool stats as compact line: "🛠 Edit×3 Bash×2 Read×5" */
  private formatToolStats(stats: RequestToolStats): string | undefined {
    const entries = Object.entries(stats).sort((a, b) => b[1].count - a[1].count);
    if (entries.length === 0) return undefined;

    const totalCalls = entries.reduce((sum, [, s]) => sum + s.count, 0);
    const parts = entries.slice(0, 6).map(([name, s]) => {
      const shortName = name.startsWith('mcp__') ? name.split('__').slice(1, 3).join(':') : name;
      return `${shortName}×${s.count}`;
    });
    if (entries.length > 6) {
      parts.push(`+${entries.length - 6}`);
    }

    return `🛠 ${totalCalls} calls: ${parts.join(' ')}`;
  }

  private formatSignedDelta(delta: number | undefined, decimals: number): string | undefined {
    if (typeof delta !== 'number' || !Number.isFinite(delta)) {
      return undefined;
    }

    const sign = delta >= 0 ? '+' : '';
    return decimals > 0 ? `${sign}${delta.toFixed(decimals)}` : `${sign}${Math.round(delta)}`;
  }

  /**
   * Update session usage data from stream result.
   *
   * Context window size is dynamically set from the SDK's
   * `ModelUsage.contextWindow` when available, replacing the old
   * hardcoded 200k default. This correctly handles Opus 4.6 (1M),
   * Sonnet 4.6 (1M), and any future model sizes.
   */
  private updateSessionUsage(session: ConversationSession, usage: UsageData): void {
    if (!session.usage) {
      session.usage = {
        // Current context (overwritten each request)
        currentInputTokens: 0,
        currentOutputTokens: 0,
        currentCacheReadTokens: 0,
        currentCacheCreateTokens: 0,
        contextWindow: FALLBACK_CONTEXT_WINDOW,
        // Cumulative totals
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheCreateTokens: 0,
        totalCostUsd: 0,
        lastUpdated: Date.now(),
      };
    }

    // Update model name on session (useful for display)
    if (usage.modelName && !session.model) {
      session.model = usage.modelName;
    }

    // Dynamically update context window:
    // Take max(SDK value, model lookup) because SDK often reports the BASE
    // window (200k) even when the 1M beta is active.
    //
    // Precedence: session.model first, usage.modelName second. The SDK strips
    // the `[1m]` suffix before reporting usage.modelName, so if the user
    // selected `claude-opus-4-7[1m]` we must read `session.model` to keep the
    // suffix and drive resolveContextWindow() to 1M.
    const sdkWindow = usage.contextWindow && usage.contextWindow > 0 ? usage.contextWindow : 0;
    const modelName = session.model ?? usage.modelName;
    const lookupWindow = resolveContextWindow(modelName);
    const resolved = Math.max(sdkWindow, lookupWindow);
    if (resolved > 0) {
      session.usage.contextWindow = resolved;
    }

    // Update current context window state.
    // Prefer per-turn usage from the LAST assistant message (actual context occupancy)
    // over the billing aggregate (which sums ALL API calls in the agent loop).
    //
    // Why: An agent loop with 10 tool calls accumulates ~10× the actual context
    // in cacheRead alone. The per-turn value from BetaMessage.usage reflects the
    // real context window state at the end of the loop.
    const hasPerTurn = usage.lastTurnInputTokens !== undefined;
    session.usage.currentInputTokens = hasPerTurn ? usage.lastTurnInputTokens! : usage.inputTokens;
    session.usage.currentOutputTokens = hasPerTurn ? usage.lastTurnOutputTokens! : usage.outputTokens;
    session.usage.currentCacheReadTokens = hasPerTurn ? usage.lastTurnCacheReadTokens! : usage.cacheReadInputTokens;
    session.usage.currentCacheCreateTokens = hasPerTurn
      ? usage.lastTurnCacheCreateTokens!
      : usage.cacheCreationInputTokens;

    // Accumulate totals (billing-oriented: use aggregate values, not per-turn)
    session.usage.totalInputTokens += usage.inputTokens;
    session.usage.totalOutputTokens += usage.outputTokens;
    session.usage.totalCacheReadTokens += usage.cacheReadInputTokens;
    session.usage.totalCacheCreateTokens += usage.cacheCreationInputTokens;
    session.usage.totalCostUsd += usage.totalCostUsd;
    session.usage.lastUpdated = Date.now();

    const contextUsed =
      session.usage.currentInputTokens +
      session.usage.currentCacheReadTokens +
      session.usage.currentCacheCreateTokens +
      session.usage.currentOutputTokens;
    this.logger.debug('Updated session usage', {
      currentContext: contextUsed,
      contextWindow: session.usage.contextWindow,
      contextWindowSource: usage.contextWindow ? 'sdk' : session.model ? 'model-lookup' : 'fallback',
      usageSource: hasPerTurn ? 'per-turn' : 'aggregate-fallback',
      totalInput: session.usage.totalInputTokens,
      totalOutput: session.usage.totalOutputTokens,
      totalCostUsd: session.usage.totalCostUsd,
    });

    // Per-turn data is the source of truth for live context display. If it is
    // missing, the aggregate path overstates context usage (sums ALL API calls
    // in the agent loop). Log a warning so the gap is observable in ops.
    if (!hasPerTurn) {
      this.logger.warn(
        'Session context usage derived from aggregate fallback (per-turn tokens missing) — displayed context may overstate actual window occupancy',
        {
          conversationId: session.conversationId,
          model: usage.modelName || session.model,
          currentContext: contextUsed,
          contextWindow: session.usage.contextWindow,
        },
      );
    }

    // Emit token_usage event for persistent tracking (fire-and-forget)
    this.emitTokenUsageEvent(session, usage);
  }

  /**
   * Emit token_usage metrics event for persistent JSONL tracking.
   * Fire-and-forget — errors are logged but never block the caller.
   */
  private emitTokenUsageEvent(session: ConversationSession, usage: UsageData): void {
    try {
      const emitter = getMetricsEmitter();
      const sessionKey = `${session.channelId}-${session.threadTs || 'direct'}`;
      // Must come from StreamProcessor where the cost was actually determined.
      // Re-deriving from `usage.totalCostUsd > 0` flips the label for any
      // calculated non-zero cost (which the SDK did not actually report).
      // Default to 'calculated' when absent — do not claim SDK provenance we
      // can't verify.
      const costSource: 'sdk' | 'calculated' = usage.costSource ?? 'calculated';
      emitter
        .emitTokenUsage(session.ownerId, session.ownerName || 'unknown', {
          sessionKey,
          conversationId: session.conversationId,
          model: usage.modelName || session.model || 'unknown',
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadInputTokens: usage.cacheReadInputTokens,
          cacheCreationInputTokens: usage.cacheCreationInputTokens,
          costUsd: usage.totalCostUsd,
          modelBreakdown: usage.modelBreakdown,
          costSource,
          pricingVersion: PRICING_VERSION,
        })
        .catch((err) => {
          this.logger.debug('Failed to emit token_usage event (async)', {
            error: (err as Error).message,
          });
        });
    } catch (error) {
      this.logger.debug('Failed to emit token_usage event', {
        error: (error as Error).message,
      });
    }
  }

  private async handleModelCommandToolResults(
    toolResults: Array<{ toolUseId: string; toolName?: string; result: any; isError?: boolean }>,
    session: ConversationSession,
    context: StreamContext,
  ): Promise<{ hasPendingChoice: boolean; continuation?: Continuation; modelCommandResults?: ModelCommandResult[] }> {
    let hasPendingChoice = false;
    let continuation: Continuation | undefined;
    const modelCommandResults: ModelCommandResult[] = [];

    // Collect ASK_USER_QUESTION results instead of rendering inline to avoid
    // rapid-fire Slack API calls that hit rate limits when multiple questions
    // are issued in a single turn.
    const pendingQuestions: Array<UserChoice | UserChoices> = [];

    for (const toolResult of toolResults) {
      if (toolResult.toolName !== 'mcp__model-command__run') {
        continue;
      }

      const parsed = parseModelCommandRunResponse(toolResult.result);
      if (!parsed) {
        this.logger.warn('Failed to parse model-command tool result', {
          sessionKey: context.sessionKey,
          toolUseId: toolResult.toolUseId,
        });
        continue;
      }

      if (!parsed.ok) {
        this.logger.warn('model-command run returned error', {
          sessionKey: context.sessionKey,
          commandId: parsed.commandId,
          error: parsed.error,
        });
        // Issue #42 S3: 에러도 수집
        modelCommandResults.push({ commandId: parsed.commandId, ok: false, error: parsed.error });
        continue;
      }

      // Issue #42 S3: 성공 결과 수집
      modelCommandResults.push({ commandId: parsed.commandId, ok: true, payload: parsed.payload });

      if (parsed.commandId === 'ASK_USER_QUESTION') {
        pendingQuestions.push(parsed.payload.question);
        hasPendingChoice = true;
        continue;
      }

      if (parsed.commandId === 'SAVE_CONTEXT_RESULT') {
        if (session.renewState !== 'pending_save') {
          this.logger.warn('Ignoring SAVE_CONTEXT_RESULT outside pending_save renew state', {
            sessionKey: context.sessionKey,
            renewState: session.renewState ?? null,
            id: parsed.payload.saveResult.id || parsed.payload.saveResult.save_id,
          });
          continue;
        }

        session.renewSaveResult = parsed.payload.saveResult;
        this.logger.info('Captured SAVE_CONTEXT_RESULT from model-command', {
          sessionKey: context.sessionKey,
          success: parsed.payload.saveResult.success,
          status: parsed.payload.saveResult.status,
          id: parsed.payload.saveResult.id || parsed.payload.saveResult.save_id,
        });
        continue;
      }

      if (parsed.commandId === 'CONTINUE_SESSION') {
        // Issue #697: stamp `origin: 'model'` on model-emitted continuations
        // so `slack-handler.onResetSession` can distinguish them from
        // host-built continuations (renew/onboarding — stamped 'host' below)
        // for auto-handoff budget enforcement. The spread-then-override pattern
        // also strips any origin value a misbehaving model may have supplied
        // in the payload (host authority on this field).
        continuation = { ...parsed.payload.continuation, origin: 'model' };
        this.logger.info('Captured CONTINUE_SESSION from model-command', {
          sessionKey: context.sessionKey,
          resetSession: continuation.resetSession === true,
          forceWorkflow: continuation.forceWorkflow,
          origin: 'model',
          dispatchTextPreview: continuation.dispatchText?.slice(0, 120),
        });
        continue;
      }

      if (parsed.commandId === 'UPDATE_SESSION') {
        const request = parsed.payload.request as SessionResourceUpdateRequest;

        const hasResourceOps = request.operations && request.operations.length > 0;
        const hasInstructionOps = request.instructionOperations && request.instructionOperations.length > 0;
        let operationsOk = true;

        // Resource operations (issues/prs/docs) apply immediately. Instruction
        // operations are GATED — see PLAN §7 — the user must click y/n
        // before we call `updateSessionResources` for them. So we split the
        // request: apply resource ops now, defer instruction ops to the
        // PendingInstructionConfirmStore.
        if (hasResourceOps) {
          const resourceOnly: SessionResourceUpdateRequest = {
            expectedSequence: request.expectedSequence,
            operations: request.operations,
            // Deliberately OMIT instructionOperations.
          };
          const updateResult = this.deps.claudeHandler.updateSessionResources(
            context.channel,
            context.threadTs,
            resourceOnly,
          );
          if (!updateResult.ok) {
            operationsOk = false;
            this.logger.warn('Failed to apply UPDATE_SESSION resource ops on host', {
              sessionKey: context.sessionKey,
              reason: updateResult.reason,
              error: updateResult.error,
              mismatch: updateResult.sequenceMismatch,
            });
            await context.say({
              text: `⚠️ Session update could not be applied on host (${updateResult.reason || 'UNKNOWN'}).`,
              thread_ts: context.threadTs,
            });
          } else {
            this.logger.info('Applied UPDATE_SESSION resource ops on host', {
              sessionKey: context.sessionKey,
              sequence: updateResult.snapshot.sequence,
              issueCount: updateResult.snapshot.issues.length,
              prCount: updateResult.snapshot.prs.length,
              docCount: updateResult.snapshot.docs.length,
            });
          }
        }

        if (hasInstructionOps) {
          await this.interceptInstructionOperationsForConfirm(request, session, context);
        }

        // Apply title update only if no operations or operations succeeded
        const titleUpdate = (parsed.payload as Record<string, unknown>).title as string | undefined;
        if (titleUpdate && operationsOk) {
          this.deps.claudeHandler.updateSessionTitle(context.channel, context.threadTs, titleUpdate);
          this.logger.info('Applied session title update from UPDATE_SESSION', {
            sessionKey: context.sessionKey,
            title: titleUpdate,
          });
        }
      }
    }

    // Render collected ASK_USER_QUESTION results after the loop.
    // When multiple questions arrive in one turn, only render the last one
    // to avoid Slack API rate limiting from rapid chat.postMessage calls.
    if (pendingQuestions.length > 0) {
      if (pendingQuestions.length > 1) {
        this.logger.warn('Multiple ASK_USER_QUESTION in single turn — rendering last only', {
          sessionKey: context.sessionKey,
          totalQuestions: pendingQuestions.length,
          skipped: pendingQuestions.length - 1,
        });
      }
      const lastQuestion = pendingQuestions[pendingQuestions.length - 1];
      // P3 (PHASE>=3): stream-executor threads its per-turn `turnId` into the
      // ASK render so button payloads + PendingFormStore entries carry the
      // same identity as `pendingChoice.turnId`. `context.turnId` is populated
      // by stream-executor's `execute()` for every turn.
      await this.renderAskUserQuestionFromCommand(context.turnId, lastQuestion, session, context);
    }

    return { hasPendingChoice, continuation, modelCommandResults };
  }

  /**
   * Defer `request.instructionOperations` into the PendingInstructionConfirm
   * store and post a Slack y/n button. If a prior pending entry for the same
   * session exists, update its message to `[superseded]` and evict it.
   *
   * NOTE: if the shared store is not wired (e.g. in minimal test harnesses)
   * we fall through silently — the model will still see its write reported
   * as pending in the UPDATE_SESSION payload, but no confirmation UI will
   * appear. This mirrors the defensive no-op pattern used elsewhere in this
   * file (see `dispatchPendingUserMessage` lazy check).
   */
  private async interceptInstructionOperationsForConfirm(
    request: SessionResourceUpdateRequest,
    session: ConversationSession,
    context: StreamContext,
  ): Promise<void> {
    const store = this.deps.pendingInstructionConfirmStore;
    if (!store) {
      this.logger.warn('pendingInstructionConfirmStore not wired — instruction write dropped', {
        sessionKey: context.sessionKey,
        ops: request.instructionOperations?.length,
      });
      return;
    }

    const requestId = randomUUID();
    const requestForStore: SessionResourceUpdateRequest = {
      // Strip expectedSequence so the later commit doesn't race against
      // unrelated resource sequence bumps that may happen while the user
      // ponders the button.
      operations: [],
      instructionOperations: request.instructionOperations,
    };

    // Snapshot the turn initiator (or fall back to the session owner when
    // no initiator is set yet — e.g. first turn). This is frozen into the
    // store so the handler can evaluate the owner guard against the user
    // who actually triggered this write, immune to later turn shifts.
    const requesterId = session.currentInitiatorId || session.ownerId;

    const evicted = store.set({
      requestId,
      sessionKey: context.sessionKey,
      channelId: context.channel,
      threadTs: context.threadTs,
      request: requestForStore,
      createdAt: Date.now(),
      requesterId,
    });

    // Supersede any prior pending message for this session.
    if (evicted?.messageTs) {
      try {
        await this.deps.slackApi.updateMessage(
          evicted.channelId,
          evicted.messageTs,
          '⚠️ [superseded] — a newer instruction proposal replaced this one.',
          buildInstructionSupersededBlocks(evicted.request),
        );
      } catch (err) {
        this.logger.warn('Failed to update superseded confirm message', {
          sessionKey: context.sessionKey,
          evictedRequestId: evicted.requestId,
          err,
        });
      }
    }

    const blocks = buildInstructionConfirmBlocks(requestForStore, requestId);
    const fallback = buildInstructionConfirmFallbackText(requestForStore);
    try {
      const post = await this.deps.slackApi.postMessage(context.channel, fallback, {
        threadTs: context.threadTs,
        blocks,
        unfurlLinks: false,
        unfurlMedia: false,
      });
      if (post.ts) {
        store.updateMessageTs(requestId, post.ts);
      } else {
        this.logger.warn('Confirm post returned no ts', {
          sessionKey: context.sessionKey,
          requestId,
        });
      }
    } catch (err) {
      this.logger.error('Failed to post instruction-confirm message', {
        sessionKey: context.sessionKey,
        requestId,
        err,
      });
      // Best-effort cleanup — if the post fails there's nothing for the user
      // to click, so remove the dangling store entry.
      store.delete(requestId);
    }

    this.logger.info('Deferred instructionOperations for user y/n confirm', {
      sessionKey: context.sessionKey,
      requestId,
      opCount: request.instructionOperations?.length ?? 0,
      supersededPrior: !!evicted,
      sessionId: session.sessionId,
    });
  }

  private async renderAskUserQuestionFromCommand(
    turnId: string | undefined,
    question: UserChoice | UserChoices,
    session: ConversationSession,
    context: StreamContext,
  ): Promise<void> {
    try {
      if (question.type === 'user_choices') {
        await this.renderMultiChoiceFromCommand(turnId, question, context);
      } else {
        await this.renderSingleChoiceFromCommand(turnId, question, context);
      }
    } catch (error) {
      // If both primary render AND fallback fail (e.g. Slack rate limit),
      // ensure we still transition to waiting state so the user can retry.
      this.logger.warn('ASK_USER_QUESTION render failed completely', {
        sessionKey: context.sessionKey,
        error: (error as Error).message,
      });
    }

    // Store raw question data on session for dashboard access (before setActivityState triggers broadcast)
    if (session.actionPanel) {
      session.actionPanel.pendingQuestion = question;
    } else {
      session.actionPanel = { pendingQuestion: question };
    }

    this.deps.claudeHandler.setActivityState(context.channel, context.threadTs, 'waiting');
    await this.updateRuntimeStatus(session, context.sessionKey, {
      agentPhase: '입력 대기',
      activeTool: undefined,
      waitingForChoice: true,
    });

    // P3 (parity fix) — pendingQuestion was historically in-memory only. With
    // P3's pendingChoice living on the session + broadcast to the dashboard,
    // we must also persist pendingQuestion so a dashboard restart restores
    // the question context. setActivityState persists on idle only; force a
    // broadcast+save here regardless of PHASE so dashboard subscribers see
    // the new pendingQuestion immediately.
    try {
      this.deps.claudeHandler.getSessionRegistry?.().persistAndBroadcast?.(context.sessionKey);
    } catch (err) {
      this.logger.debug('renderAskUserQuestionFromCommand: persistAndBroadcast failed', {
        sessionKey: context.sessionKey,
        error: (err as Error)?.message ?? String(err),
      });
    }
  }

  /**
   * P3 (PHASE>=3) defensive prelude — clear any prior pendingChoice on the
   * session before opening a new ask. Prevents split-brain between Slack UI
   * and `pendingChoice` when a prior post succeeded but the resolve signal
   * was lost (e.g. process restart, Slack click dropped).
   *
   * For `multi` priors: best-effort rewrite each prior chunk message to
   * "⏱️ 새 질문으로 대체되었습니다." and delete PendingFormStore entries.
   * For `single` priors: only clears session state (no Slack rewrite — the
   * new ask replaces the visible message itself).
   *
   * No-op under PHASE<3 or when no prior `pendingChoice` exists.
   */
  private async supersedePriorPendingChoice(
    session: ConversationSession,
    sessionKey: string,
    channel: string,
  ): Promise<void> {
    if (config.ui.fiveBlockPhase < 3) return;
    const prior = session.actionPanel?.pendingChoice;
    if (!prior) return;

    if (prior.kind === 'multi' && prior.formIds.length > 0) {
      // Prior chunks are independent Slack messages — rewrite in parallel.
      await Promise.allSettled(
        prior.formIds.map(async (formId) => {
          const pendingForm = this.deps.actionHandlers.getPendingForm(formId);
          if (pendingForm?.messageTs) {
            await this.deps.slackApi
              .updateMessage(channel, pendingForm.messageTs, SUPERSEDED_TEXT, buildMarkerBlocks(SUPERSEDED_TEXT), [])
              .catch((err) =>
                this.logger.warn('supersedePriorPendingChoice: rewrite failed', {
                  sessionKey,
                  formId,
                  error: (err as Error)?.message ?? String(err),
                }),
              );
          }
          this.deps.actionHandlers.deletePendingForm(formId);
        }),
      );
    }

    if (session.actionPanel) {
      session.actionPanel.pendingChoice = undefined;
      session.actionPanel.choiceMessageTs = undefined;
      session.actionPanel.choiceMessageLink = undefined;
      session.actionPanel.waitingForChoice = false;
    }
    try {
      this.deps.claudeHandler.getSessionRegistry?.().persistAndBroadcast?.(sessionKey);
    } catch (err) {
      this.logger.debug('supersedePriorPendingChoice: persistAndBroadcast failed', {
        sessionKey,
        error: (err as Error)?.message ?? String(err),
      });
    }
  }

  private async renderSingleChoiceFromCommand(
    turnId: string | undefined,
    question: UserChoice,
    context: StreamContext,
  ): Promise<void> {
    const session = this.deps.claudeHandler.getSessionByKey(context.sessionKey);

    // P3 (PHASE>=3) — route through ThreadPanel.askUser so pendingChoice state
    // is written synchronously with the posted ts. Falls through to the legacy
    // context.say path when PHASE<3, threadPanel is missing, or askUser reports
    // phase-disabled (e.g. test harness mock).
    if (config.ui.fiveBlockPhase >= 3 && session && this.deps.threadPanel && turnId) {
      await this.supersedePriorPendingChoice(session, context.sessionKey, context.channel);

      const theme = userSettingsStore.getUserSessionTheme(session.ownerId);
      const payload = UserChoiceHandler.buildUserChoiceBlocks(question, context.sessionKey, theme, turnId);

      const address: TurnAddress = {
        channelId: context.channel,
        threadTs: context.threadTs,
        sessionKey: context.sessionKey,
      };
      const result = await this.deps.threadPanel.askUser(
        turnId,
        question,
        payload,
        question.question ?? '선택이 필요합니다',
        address,
        session,
        context.sessionKey,
      );

      if (result.ok) {
        // ThreadPanel.askUser synchronously wrote pendingChoice + persistAndBroadcast.
        return;
      }
      if (result.reason === 'post-failed') {
        await this.sendCommandChoiceFallback(question, context);
        return;
      }
      // phase-disabled → fall through to legacy path below.
    }

    // Legacy path (PHASE<3 or P3 fell through). Byte-identical pre-flip
    // output: no `turnId` threaded through `buildUserChoiceBlocks`.
    const theme = session ? userSettingsStore.getUserSessionTheme(session.ownerId) : undefined;
    const payload = UserChoiceHandler.buildUserChoiceBlocks(question, context.sessionKey, theme);
    try {
      const result = await context.say({
        text: question.question,
        ...payload,
        thread_ts: context.threadTs,
      });

      await this.deps.threadPanel?.attachChoice(context.sessionKey, payload, result?.ts);
    } catch (error) {
      this.logger.warn('Failed to render command-driven single choice blocks', {
        sessionKey: context.sessionKey,
        error: (error as Error).message,
      });
      await this.sendCommandChoiceFallback(question, context);
    }
  }

  private async renderMultiChoiceFromCommand(
    turnId: string | undefined,
    question: UserChoices,
    context: StreamContext,
  ): Promise<void> {
    const maxQuestionsPerForm = 6;
    const chunks: UserChoices[] = [];
    for (let index = 0; index < question.questions.length; index += maxQuestionsPerForm) {
      const chunkQuestions = question.questions.slice(index, index + maxQuestionsPerForm);
      const chunkLabel =
        question.questions.length > maxQuestionsPerForm
          ? ` (${Math.floor(index / maxQuestionsPerForm) + 1}/${Math.ceil(question.questions.length / maxQuestionsPerForm)})`
          : '';

      chunks.push({
        ...question,
        title: `${question.title || '선택이 필요합니다'}${chunkLabel}`,
        questions: chunkQuestions,
      });
    }

    const session = this.deps.claudeHandler.getSessionByKey(context.sessionKey);

    // P3 (PHASE>=3): pre-allocate formIds + persist (with turnId) before any
    // Slack round-trip so a mid-flight click finds the live form entry.
    if (config.ui.fiveBlockPhase >= 3 && session && this.deps.threadPanel && turnId) {
      await this.supersedePriorPendingChoice(session, context.sessionKey, context.channel);

      const formIds: string[] = [];
      for (const chunk of chunks) {
        const formId = `form_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
        formIds.push(formId);
        this.deps.actionHandlers.setPendingForm(formId, {
          formId,
          sessionKey: context.sessionKey,
          channel: context.channel,
          threadTs: context.threadTs,
          messageTs: '',
          questions: chunk.questions,
          selections: {},
          createdAt: Date.now(),
          turnId,
        });
      }
      if (formIds.length > 0) {
        await this.deps.actionHandlers.invalidateOldForms(context.sessionKey, formIds[0], this.deps.slackApi);
      }

      const chunkPayloads = chunks.map((chunk, i) => ({
        builtPayload: UserChoiceHandler.buildMultiChoiceFormBlocks(chunk, formIds[i], context.sessionKey),
        text: chunk.title || '📋 선택이 필요합니다',
      }));

      const address: TurnAddress = {
        channelId: context.channel,
        threadTs: context.threadTs,
        sessionKey: context.sessionKey,
      };
      const result = await this.deps.threadPanel.askUserForm(
        turnId,
        chunkPayloads,
        formIds,
        question,
        address,
        session,
        context.sessionKey,
      );

      if (result.ok) {
        // Back-fill messageTs on each pending form. Use setPendingForm (not
        // in-place mutation) so a concurrent save-to-disk sees the new ts.
        for (let i = 0; i < result.allTs.length; i++) {
          const fId = formIds[i];
          const pending = this.deps.actionHandlers.getPendingForm(fId);
          if (pending) {
            this.deps.actionHandlers.setPendingForm(fId, { ...pending, messageTs: result.allTs[i] });
          }
        }
        return;
      }
      if (result.reason === 'post-failed') {
        for (const fId of formIds) {
          this.deps.actionHandlers.deletePendingForm(fId);
        }
        await this.sendCommandChoiceFallback(question, context);
        return;
      }
      // phase-disabled → fall through to legacy path (cleanup pre-allocated forms).
      for (const fId of formIds) {
        this.deps.actionHandlers.deletePendingForm(fId);
      }
    }

    // Legacy path (PHASE<3 or P3 fell through).
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const formId = `form_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

      this.deps.actionHandlers.setPendingForm(formId, {
        formId,
        sessionKey: context.sessionKey,
        channel: context.channel,
        threadTs: context.threadTs,
        messageTs: '',
        questions: chunk.questions,
        selections: {},
        createdAt: Date.now(),
      });

      if (index === 0) {
        await this.deps.actionHandlers.invalidateOldForms(context.sessionKey, formId, this.deps.slackApi);
      }

      const payload = UserChoiceHandler.buildMultiChoiceFormBlocks(chunk, formId, context.sessionKey);
      try {
        const result = await context.say({
          text: chunk.title || '📋 선택이 필요합니다',
          ...payload,
          thread_ts: context.threadTs,
        });

        if (result?.ts) {
          // Persist messageTs via setPendingForm so restart can resolve the form.
          const pending = this.deps.actionHandlers.getPendingForm(formId);
          if (pending) {
            this.deps.actionHandlers.setPendingForm(formId, { ...pending, messageTs: result.ts });
          }
        }

        await this.deps.threadPanel?.attachChoice(context.sessionKey, payload, result?.ts);
      } catch (error) {
        this.logger.warn('Failed to render command-driven multi choice blocks', {
          sessionKey: context.sessionKey,
          error: (error as Error).message,
        });
        this.deps.actionHandlers.deletePendingForm(formId);
        await this.sendCommandChoiceFallback(question, context);
        return;
      }
    }
  }

  private async sendCommandChoiceFallback(question: UserChoice | UserChoices, context: StreamContext): Promise<void> {
    let fallbackText = '';

    if (question.type === 'user_choices') {
      const lines = [
        `📋 *${question.title || '선택이 필요합니다'}*`,
        question.description ? `_${question.description}_` : '',
        '',
        ...question.questions.map((entry, index) => {
          const options = (entry.choices || [])
            .map((option, optionIndex) => {
              return `  ${optionIndex + 1}. ${option.label}${option.description ? ` - ${option.description}` : ''}`;
            })
            .join('\n');
          return `*Q${index + 1}. ${entry.question}*\n${options}`;
        }),
        '',
        '_⚠️ 버튼 UI 생성에 실패하여 텍스트로 표시됩니다. 번호로 응답해주세요._',
      ];
      fallbackText = lines.filter((line) => line !== '').join('\n');
    } else {
      const options = (question.choices || [])
        .map((option, index) => {
          return `${index + 1}. ${option.label}${option.description ? ` - ${option.description}` : ''}`;
        })
        .join('\n');
      fallbackText = [
        `❓ *${question.question}*`,
        question.context ? `_${question.context}_` : '',
        '',
        options,
        '',
        '_⚠️ 버튼 UI 생성에 실패하여 텍스트로 표시됩니다. 번호로 응답해주세요._',
      ]
        .filter((line) => line !== '')
        .join('\n');
    }

    try {
      await context.say({
        text: fallbackText,
        thread_ts: context.threadTs,
      });
    } catch (error) {
      this.logger.warn('Choice fallback say() also failed', {
        sessionKey: context.sessionKey,
        error: (error as Error).message,
      });
    }
  }

  /**
   * Build continuation for renew flow after save completes
   * Returns Continuation object instead of recursively calling execute()
   */
  private async buildRenewContinuation(
    session: ConversationSession,
    collectedText: string,
    threadTs: string,
    say: SayFn,
  ): Promise<Continuation | undefined> {
    // Prefer tool-driven save result, then fall back to text parsing.
    const saveResult = this.normalizeSaveResultPayload(session.renewSaveResult) || this.parseSaveResult(collectedText);
    session.renewSaveResult = undefined;

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
      saveContent = files
        .map((file: { name: string; content: string }) => {
          return `--- ${file.name} ---\n${file.content}`;
        })
        .join('\n\n');
    } else if (path || dir) {
      // Fallback: try to read from path/dir
      const savePath = path || dir;
      this.logger.info('Renew save completed, attempting file read fallback', { id, savePath });

      try {
        const fs = await import('fs');
        const pathModule = await import('path');

        // Resolve relative paths against session working directory
        const sessionDir = session.sessionWorkingDir || session.workingDirectory;
        let resolvedPath = savePath!;

        // If path is relative and no sessionDir to resolve against, reject it
        if (!pathModule.isAbsolute(resolvedPath) && !sessionDir) {
          this.logger.warn('Cannot resolve relative save path without session directory', { savePath });
          await say({
            text: '⚠️ Cannot resolve save path (no session directory). Renew cancelled.',
            thread_ts: threadTs,
          });
          session.renewState = null;
          return undefined;
        }

        if (!pathModule.isAbsolute(resolvedPath) && sessionDir) {
          resolvedPath = pathModule.join(sessionDir, resolvedPath);
          this.logger.info('Resolved relative save path', { original: savePath, resolved: resolvedPath, sessionDir });
        }

        // Security: ensure resolved path stays within session directory (prevent path traversal)
        // Append path.sep to prevent sibling-prefix bypass (e.g., /tmp/session vs /tmp/session-evil)
        const canonicalPath = pathModule.resolve(resolvedPath);
        const resolvedSessionDir = pathModule.resolve(sessionDir!);
        if (
          sessionDir &&
          canonicalPath !== resolvedSessionDir &&
          !canonicalPath.startsWith(resolvedSessionDir + pathModule.sep)
        ) {
          this.logger.warn('Save path traversal blocked', { resolvedPath: canonicalPath, sessionDir });
          await say({
            text: '⚠️ Save path is outside session directory. Renew cancelled.',
            thread_ts: threadTs,
          });
          session.renewState = null;
          return undefined;
        }

        // Try to read context.md from the save directory
        const contextPath = canonicalPath.endsWith('.md')
          ? canonicalPath
          : pathModule.join(canonicalPath, 'context.md');

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
      // Last resort: scan session's .claude/omc/tasks/save/ for the most recent save
      const sessionDir = session.sessionWorkingDir || session.workingDirectory;
      const scannedContent = sessionDir ? this.scanForLatestSave(sessionDir, id) : null;

      if (scannedContent) {
        this.logger.info('Renew: found save via directory scan', { sessionDir, id });
        saveContent = scannedContent;
      } else {
        // No files, no path, no scannable save - can't proceed
        this.logger.warn('Save succeeded but no files or path returned and directory scan failed', {
          saveResult,
          sessionDir,
        });
        await say({
          text: '⚠️ Save succeeded but no file content or path was returned.',
          thread_ts: threadTs,
        });
        session.renewState = null;
        return undefined;
      }
    }

    // Get user message if provided with /renew command
    const userMessage = session.renewUserMessage;

    // Clear renew state BEFORE any notification I/O to prevent stuck state if say() rejects
    session.renewState = null;
    session.renewUserMessage = undefined;

    // Notify in current thread (non-critical — state already cleaned up)
    try {
      await say({
        text:
          `✅ *Context saved!* (ID: \`${id}\`)\n\n` +
          `🔄 *Session Reset & Re-dispatch*\n` +
          `• 이전 세션 컨텍스트 초기화됨\n` +
          `• 워크플로우 재분류 후 load 실행...` +
          (userMessage ? `\n• 지시사항: "${userMessage}"` : ''),
        thread_ts: threadTs,
      });
    } catch (notifyError) {
      this.logger.warn('Renew: notification failed (non-blocking)', { notifyError });
    }

    // Generate the load prompt with optional user instruction
    const userInstruction = userMessage
      ? `\n\nAfter loading the context, execute this user instruction:\n<user-instruction>${userMessage}</user-instruction>`
      : "\n\nContinue with that context. If unsure what to do next, call 'oracle' agent for guidance.";

    const loadPrompt = `Use 'local:load' skill with this saved context:
<save>
${saveContent}
</save>
${userInstruction}`;

    this.logger.info('Renew: returning continuation for load', { id, hasUserMessage: !!userMessage });

    // Return continuation - handleMessage loop will reset session and execute
    // dispatchText is the user's message for workflow classification (not the full load prompt)
    return {
      prompt: loadPrompt,
      resetSession: true,
      dispatchText: userMessage || undefined,
      // Issue #697: host-built continuation — skip auto-handoff budget enforcement.
      origin: 'host',
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
    // Strategy 1: Look for {"save_result": ...} JSON pattern
    const jsonMatch = text.match(/\{"save_result"\s*:\s*(\{.*\})\}/s);
    if (jsonMatch) {
      try {
        const fullJson = `{"save_result":${jsonMatch[1]}}`;
        const parsed = JSON.parse(fullJson);
        return this.normalizeSaveResultPayload(parsed.save_result);
      } catch (error) {
        this.logger.warn('Failed to parse save_result JSON', { error });
      }
    }

    // Strategy 2: Parse natural "Saved to: <path>" output from save skill
    // Matches patterns like:
    //   Saved to: .claude/omc/tasks/save/20260329_180000/context.md
    //   Save with: /load 20260329_180000
    const savedToMatch = text.match(/Saved to:\s*(\S+)/i);
    if (savedToMatch) {
      const savedPath = savedToMatch[1];
      // Extract ID from path (timestamp-based directory name)
      const idMatch = savedPath.match(/save\/(\d{8}_\d{6})/);
      const id = idMatch ? idMatch[1] : undefined;
      // Determine dir from path (strip filename if it ends with .md)
      const pathModule = require('path') as typeof import('path');
      const dir = savedPath.endsWith('.md') ? pathModule.dirname(savedPath) : savedPath;

      this.logger.info('Parsed save result from text output', { savedPath, id, dir });
      return {
        success: true,
        id,
        dir,
        path: savedPath,
      };
    }

    return null;
  }

  private normalizeSaveResultPayload(raw: SaveContextResultPayload | undefined): {
    success: boolean;
    id?: string;
    dir?: string;
    path?: string;
    summary?: string;
    files?: Array<{ name: string; content: string }>;
    error?: string;
  } | null {
    if (!raw || typeof raw !== 'object') {
      return null;
    }

    const success = raw.success === true || raw.status === 'saved' || raw.status === 'success';

    return {
      success,
      id: raw.id || raw.save_id,
      dir: raw.dir,
      path: raw.path,
      summary: raw.summary || raw.title,
      files: raw.files,
      error: raw.error,
    };
  }

  /**
   * Scan session's .claude/omc/tasks/save/ directory for a save.
   * If saveId is provided, only matches that exact directory.
   * Otherwise falls back to most recent (newest timestamp-based ID).
   * Returns formatted content string or null if nothing found.
   */
  private scanForLatestSave(sessionDir: string, saveId?: string): string | null {
    try {
      const fs = require('fs') as typeof import('fs');
      const pathModule = require('path') as typeof import('path');

      const saveRoot = pathModule.join(sessionDir, '.claude', 'omc', 'tasks', 'save');
      if (!fs.existsSync(saveRoot)) {
        return null;
      }

      // If we have a specific save ID, try that first (and only)
      if (saveId) {
        const contextPath = pathModule.join(saveRoot, saveId, 'context.md');
        if (fs.existsSync(contextPath)) {
          const content = fs.readFileSync(contextPath, 'utf-8');
          this.logger.info('scanForLatestSave: found exact save by id', { saveId, contextPath });
          return `--- context.md ---\n${content}`;
        }
        // Fail closed: explicit saveId was given but not found — do not fall back to newest
        this.logger.warn('scanForLatestSave: explicit save id not found, failing closed', { saveId });
        return null;
      }

      // Fallback (no saveId): list save directories sorted descending (newest first)
      const entries = fs
        .readdirSync(saveRoot, { withFileTypes: true })
        .filter((d: { isDirectory: () => boolean }) => d.isDirectory())
        .map((d: { name: string }) => d.name)
        .sort()
        .reverse();

      for (const entry of entries) {
        const contextPath = pathModule.join(saveRoot, entry, 'context.md');
        if (fs.existsSync(contextPath)) {
          const content = fs.readFileSync(contextPath, 'utf-8');
          this.logger.info('scanForLatestSave: found save', { entry, contextPath });
          return `--- context.md ---\n${content}`;
        }
      }

      return null;
    } catch (error) {
      this.logger.warn('scanForLatestSave failed', { sessionDir, error });
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
    say: SayFn,
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
        // Issue #697: host-built continuation — skip auto-handoff budget enforcement.
        origin: 'host',
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
