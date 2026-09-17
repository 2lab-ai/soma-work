import fs from 'node:fs';
import path from 'node:path';
import type { App } from '@slack/bolt';
import {
  type AuthDecision,
  type DispatcherNotice,
  type DispatchOutcome,
  type DispatchRequest,
  FollowupDispatcher,
  type RunReport,
} from '@soma/slack/followup-dispatcher';
import {
  type FollowupContext,
  type FollowupItem,
  FollowupQueue,
  type FollowupQueueSnapshot,
} from '@soma/slack/followup-queue';
import type { FollowupQueueView } from '@soma/slack/followup-queue-blocks';
import { FollowupQueueStore } from '@soma/slack/followup-queue-store';
import { runWithTimeout } from '@soma/slack/pipeline/stream-executor-cleanup-helpers';
import { HandoffAbortError, isZHandoffWorkflow } from 'somalib/model-commands/handoff-parser';
import { getAdminUsers, isAdminUser } from './admin-utils';
import type { ContinuationHandler, TurnRunnerSurface } from './agent-session';
import { TurnRunner, V1QueryAdapter } from './agent-session';
import type { ClaudeHandler } from './claude-handler';
import { getFollowupQueueCapacity } from './config';
import { FileHandler, type ProcessedFile } from './file-handler';
import { Logger } from './logger';
import { mcpCallTracker } from './mcp-call-tracker';
import type { McpManager } from './mcp-manager';
import { getMetricsEmitter } from './metrics/event-emitter';
import { resolveContextWindow } from './metrics/model-registry';
import type { FollowupQueueMetric, FollowupQueueOperation } from './metrics/types';
import { SlackBlockKitChannel } from './notification-channels/slack-block-kit-channel';
import { SlackDmChannel } from './notification-channels/slack-dm-channel';
import { TelegramChannel } from './notification-channels/telegram-channel';
import { WebhookChannel } from './notification-channels/webhook-channel';
import { buildGoalContinuationPrompt } from './prompt/session-goal-block';
import {
  type ActionHandlerContext,
  ActionHandlers,
  AgentStreamProcessor,
  AssistantStatusManager,
  type CommandDependencies,
  CommandRouter,
  ContextWindowManager,
  EventRouter,
  type EventRouterDeps,
  McpHealthMonitor,
  McpStatusDisplay,
  MessageValidator,
  PendingInstructionConfirmStore,
  ReactionManager,
  RequestCoordinator,
  SessionUiManager,
  SlackApiHelper,
  StatusReporter,
  ThreadPanel,
  TodoDisplayManager,
  ToolEventProcessor,
  ToolTracker,
} from './slack';
import { registerFollowupActions } from './slack/actions/followup-actions';
import { createAssistantContainer } from './slack/assistant-container';
import { buildAutoskillFire } from './slack/autoskill-fire';
import { CommandParser } from './slack/command-parser';
import { CompletionMessageTracker } from './slack/completion-message-tracker';
import { createForkExecutor } from './slack/create-fork-executor';
import { DispatchAbortError, formatDispatchAbortMessage } from './slack/dispatch-abort';
import { resetGoalContinuationOnUserMessage } from './slack/goal-continuation';
import {
  checkAndConsumeBudget,
  formatBudgetExhaustedMessage,
  HandoffBudgetExhaustedError,
} from './slack/handoff-budget';
import { buildCompactHooks } from './slack/hooks/compact-hooks';
import { InputProcessor, type MessageEvent, SessionInitializer, StreamExecutor } from './slack/pipeline';
import { advanceGoalQueue, enqueueOrActivateGoal, formatGoalObjectiveForSlack } from './slack/session-goal';
import { SummaryService } from './slack/summary-service';
import { SummaryTimer } from './slack/summary-timer';
import { normalizeZInvocation, stripZPrefix } from './slack/z/normalize';
import { DmZRespond } from './slack/z/respond';
import { isDmAllowedForNonAdmin } from './slack/z/whitelist';
import { TodoManager } from './todo-manager';
import { TurnNotifier } from './turn-notifier';
import type { ConversationSession, SessionGoal } from './types';
import { userSettingsStore } from './user-settings-store';
import { WorkingDirectoryManager } from './working-directory-manager';

interface SlackPermalinkTarget {
  channelId: string;
  messageTs: string;
  /**
   * Root timestamp of the thread, parsed from the `?thread_ts=` query of a
   * thread permalink. Present when the link points at a message inside a
   * thread (reply or root). Undefined for plain top-level channel messages.
   */
  threadTs?: string;
}

interface DmDeleteActionValue {
  requesterId: string;
  targetChannel: string;
  targetTs: string;
  /** Root ts when the target lives inside a thread (reply or root). */
  threadTs?: string;
}

interface DmDeleteThreadActionValue {
  requesterId: string;
  targetChannel: string;
  threadTs: string;
  /** DM channel + ts of the admin's link message, for success/failure reactions. */
  linkChannel: string;
  linkTs: string;
}

/** States that no longer occupy the queue — excluded from the reported depth. */
const TERMINAL_FOLLOWUP_STATES: readonly string[] = ['resolved', 'failed', 'cancelled'];

/**
 * Recorded as the item's `stateReason` when the author's working directory
 * changed between dispatch authorization and the pipeline's own re-validation.
 * The item is `failed`, not `queued`: it was already `dispatched` when the
 * change was found, so Retry — an explicit user act — is the way back (A13).
 */
const FOLLOWUP_CWD_CHANGED_REASON = '작업 디렉토리가 변경되어 실행하지 않았습니다 (다시 시도하려면 Retry)';

/**
 * Committed item state → the observability operation that state means
 * (`metrics/types.ts:233-241`). Absent entries are deliberate:
 *   - `reserved` is a reservation, NOT a dispatch (labelling it one would
 *     report work that has not started);
 *   - `paused` / `cancelled` are session outcomes, reported as a `snapshot`.
 */
const FOLLOWUP_STATE_OPERATIONS: Readonly<Record<string, FollowupQueueOperation | undefined>> = {
  queued: 'enqueue',
  claimed: 'claim',
  dispatched: 'dispatch',
  resolved: 'resolve',
  failed: 'fail',
  uncertain: 'uncertain',
};

/**
 * Durable sink for the follow-up queue. Structural so a test can hand in an
 * in-memory double instead of touching `DATA_DIR`; production always gets the
 * real {@link FollowupQueueStore}.
 */
export interface FollowupQueueStorePort {
  load(): FollowupQueueSnapshot | undefined;
  save(snapshot: FollowupQueueSnapshot): void;
  readonly recoveryWarning?: string;
}

export interface SlackHandlerOptions {
  /**
   * Follow-up queue store. Defaults to `<DATA_DIR>/followup-queue.json`
   * (`followup-queue-store.ts:263`) — the path is resolved by the store, never
   * here, so `rules/config.md` §절대규칙 2 keeps a single path owner.
   */
  followupQueueStore?: FollowupQueueStorePort;
}

export class SlackHandler {
  private app: App;
  private claudeHandler: ClaudeHandler;
  private logger = new Logger('SlackHandler');
  private workingDirManager: WorkingDirectoryManager;
  private fileHandler: FileHandler;
  private todoManager: TodoManager;
  private mcpManager: McpManager;

  // Modular helpers
  private slackApi: SlackApiHelper;
  private reactionManager: ReactionManager;
  private contextWindowManager: ContextWindowManager;
  private mcpStatusDisplay: McpStatusDisplay;
  private mcpHealthMonitor: McpHealthMonitor;
  private sessionUiManager: SessionUiManager;
  private actionHandlers: ActionHandlers;
  private eventRouter: EventRouter;
  private threadPanel: ThreadPanel;

  // Concurrency and tracking
  private requestCoordinator: RequestCoordinator;
  private toolTracker: ToolTracker;

  // Command routing
  private commandRouter: CommandRouter;

  // Stream and tool processing
  private toolEventProcessor: ToolEventProcessor;

  // Message validation, status reporting, and todo display
  private messageValidator: MessageValidator;
  private statusReporter: StatusReporter;
  private todoDisplayManager: TodoDisplayManager;

  // Native Slack AI spinner
  private assistantStatusManager: AssistantStatusManager;

  // Pipeline components
  private inputProcessor: InputProcessor;
  private sessionInitializer: SessionInitializer;
  private streamExecutor: StreamExecutor;

  // Follow-up queue (`.prd/slack-agent-ui` U3). Optional on purpose: legacy
  // unit tests construct the handler with `{}` for claudeHandler, and without a
  // resolvable session key there is no queue identity — every access below is
  // guarded so those paths keep their exact pre-queue behavior.
  private followupStore?: FollowupQueueStorePort;
  private followupQueue?: FollowupQueue;
  private followupDispatcher?: FollowupDispatcher;
  /**
   * Why the queue could not be loaded. Set = DEGRADED: the queue refuses to
   * enqueue and never renders "empty" (ssot.md:139-141 — an empty render is
   * indistinguishable from "my message vanished"). An idle message still
   * dispatches; nothing is recovered or drained.
   */
  private followupDegradedReason?: string;
  /**
   * The state file could not be read at all (neither live nor `.bak`). Harder
   * than {@link followupDegradedReason}: nothing may be enqueued, because there
   * is no durable place to put it and a receipt would be a lie.
   */
  private followupReadFailed?: boolean;
  /** Bolt's `say` for the run that is being opened, consumed synchronously by the dispatch hook. */
  private followupInitialSay?: Map<string, any>;
  /** Error thrown by the initial dispatch, re-thrown by `handleMessage` to keep Bolt's contract. */
  private followupInitialError?: Map<string, unknown>;
  /** Sessions whose goal driver was suppressed because follow-up work outranks autogoal (§3.6). */
  private followupDeferredGoalSessions?: Set<string>;
  /**
   * Files downloaded for a message that was STEERED into a running turn, keyed
   * by the uuid it was pushed under (06 §3.2/D2). They must survive until the
   * turn settles that uuid — the model reads them from disk at a later tool
   * boundary — so the cleanup hangs off the settlement, not off the enqueue.
   */
  private followupSteerFiles?: Map<string, ProcessedFile[]>;
  /**
   * Items whose "your edit did not reach the queue" notice was already said.
   * One per item: Slack redelivers `message_changed` and a user can keep
   * editing, and repeating the refusal in the thread is noise, not information.
   */
  private followupEditNoticed?: Set<string>;
  /**
   * Live bot-thread migrations. A first mention opens its dispatch slot under
   * the SOURCE thread key, and the pipeline then moves the session into a new
   * work thread and terminates the source session
   * (`session-initializer.ts:1238-1239`). Replies land in the WORK thread, whose
   * key is different — without this mapping they would see `isBusy(work) ===
   * false` and dispatch straight into the running turn.
   */
  private followupMigration?: { bySlot: Map<string, string>; byCanonical: Map<string, string> };
  /**
   * Last COMMITTED item states, per session — the baseline the observability
   * delta is taken against. Written only from the save sink, i.e. only after
   * the store accepted the snapshot, so an observation can never describe a
   * transition the disk rejected.
   */
  private followupObserved?: Map<string, Map<string, string>>;
  /**
   * Set by {@link prepareFollowupShutdown} while the shutdown records its
   * state. Admission gate only — it stops NEW work from entering the host; it
   * never touches a run that is already in flight.
   */
  private followupShutdownPreparing?: boolean;
  /** The startup reconcile has run (or was deliberately skipped) — see {@link reconcileFollowupSessionsOnce}. */
  private followupReconciled?: boolean;
  /** The RESTORED state had something to reconcile — see {@link warnIfReconcileSkipped}. */
  private followupReconcileDebt?: boolean;
  /** The "reconcile never ran" warning was already said once. */
  private followupReconcileWarned?: boolean;
  /** Timing anchors for the two latencies that are actually measurable. */
  private followupTiming?: {
    /** When the previous run settled — the start of a drain's wait. */
    settledAt: Map<string, number>;
    /** When a `Send now` interrupt was signalled. */
    interruptAt: Map<string, number>;
    /**
     * Kind of the run that currently owns the session, from `run-started`,
     * tagged with its `runId`. The id matters: a `Send now` opens its own run
     * while the interrupted one is still unwinding, and that victim's
     * `run-settled` must not erase the live run's kind.
     */
    kind: Map<string, { runId: number; kind: string }>;
  };

  constructor(app: App, claudeHandler: ClaudeHandler, mcpManager: McpManager, options: SlackHandlerOptions = {}) {
    this.app = app;
    this.claudeHandler = claudeHandler;
    this.mcpManager = mcpManager;
    this.workingDirManager = new WorkingDirectoryManager();
    this.fileHandler = new FileHandler();
    this.todoManager = new TodoManager();

    // Initialize modular helpers
    this.slackApi = new SlackApiHelper(app);
    // The ONE place a session stop is observed. `beforeAbort` fires
    // synchronously, before the controller lookup, for every stop-class reason
    // (`request-coordinator.ts:64`) — including a stop on an idle session,
    // which is precisely when the queue must freeze and no abort happens at
    // all. The closure reads the queue as a runtime field: it is built later in
    // this constructor, and a stop cannot occur before then.
    this.requestCoordinator = new RequestCoordinator({
      beforeAbort: (sessionKey, reason) => this.freezeFollowupOnStop(sessionKey, reason),
    });
    this.toolTracker = new ToolTracker();
    this.reactionManager = new ReactionManager(this.slackApi);
    this.contextWindowManager = new ContextWindowManager(this.slackApi);
    this.mcpStatusDisplay = new McpStatusDisplay(this.slackApi, mcpCallTracker);
    this.mcpHealthMonitor = new McpHealthMonitor(this.slackApi, this.mcpManager);
    this.sessionUiManager = new SessionUiManager(claudeHandler, this.slackApi);
    this.sessionUiManager.setReactionManager(this.reactionManager);
    const completionMessageTracker = new CompletionMessageTracker();
    // sessionRegistry is optional in ThreadPanelDeps (legacy tests construct
    // ThreadPanel without it). Guard access here so test mocks that don't
    // implement getSessionRegistry() keep passing.
    const sessionRegistry =
      typeof (this.claudeHandler as any).getSessionRegistry === 'function'
        ? (this.claudeHandler as any).getSessionRegistry()
        : undefined;

    // #689 P4 Part 2/2 — AssistantStatusManager must be constructed BEFORE
    // ThreadPanel so ThreadPanel (→ ThreadSurface chip suppression + TurnSurface
    // B4 spinner writer) receives the same instance that ToolEventProcessor /
    // StreamExecutor / SessionInitializer reference downstream.
    this.assistantStatusManager = new AssistantStatusManager(this.slackApi);

    // Shared SlackBlockKitChannel — both ThreadPanel (→ TurnSurface B5 emit)
    // and TurnNotifier (legacy fan-out) observe the same instance so they
    // share tracker dedup state. Constructing two would split that state.
    const slackBlockKitChannel = new SlackBlockKitChannel(this.slackApi, completionMessageTracker);

    // Queue surface DI. `ThreadSurface` reads both hooks
    // (`thread-surface.ts:144`, `:152`) and `ThreadPanel` forwards its deps
    // object to it verbatim (`thread-panel.ts:93`), so wiring them here makes
    // the Queue block render as soon as the panel's own passthrough lands (U12
    // owns that file). Spread rather than inline keys: `ThreadPanelDeps` does
    // not declare them yet, and an object-literal key would be an excess
    // property. Both closures read live state — never a captured snapshot.
    const followupSurfaceDeps = {
      getFollowupView: (sessionKey: string) => this.getFollowupView(sessionKey),
      getFollowupError: (sessionKey: string) => this.getFollowupError(sessionKey),
    };

    this.threadPanel = new ThreadPanel({
      slackApi: this.slackApi,
      claudeHandler: this.claudeHandler,
      requestCoordinator: this.requestCoordinator,
      todoManager: this.todoManager,
      completionMessageTracker,
      sessionRegistry,
      assistantStatusManager: this.assistantStatusManager,
      slackBlockKitChannel,
      ...followupSurfaceDeps,
    });

    // Command routing
    const commandDeps: CommandDependencies = {
      workingDirManager: this.workingDirManager,
      mcpManager: this.mcpManager,
      claudeHandler: this.claudeHandler,
      sessionUiManager: this.sessionUiManager,
      requestCoordinator: this.requestCoordinator,
      slackApi: this.slackApi,
      reactionManager: this.reactionManager,
      contextWindowManager: this.contextWindowManager,
      // #617: /compact-threshold handler reads/writes compactThreshold.
      userSettingsStore,
    };
    this.commandRouter = new CommandRouter(commandDeps);

    // Message validation, status reporting, and todo display
    this.messageValidator = new MessageValidator(this.workingDirManager, this.claudeHandler);
    this.statusReporter = new StatusReporter(this.slackApi);
    this.todoDisplayManager = new TodoDisplayManager(this.slackApi, this.todoManager, this.reactionManager);
    // Wire todo updates to trigger thread header re-render + plan block render.
    this.todoDisplayManager.setRenderRequestCallback(async (session, sessionKey) => {
      await this.threadPanel?.updatePanel(session as ConversationSession, sessionKey);
    });
    this.todoDisplayManager.setPlanRenderCallback(async (turnId, todos, ctx) => {
      return (await this.threadPanel?.renderTasks(turnId, todos, ctx)) ?? false;
    });

    // Tool processing
    this.toolEventProcessor = new ToolEventProcessor(
      this.toolTracker,
      this.mcpStatusDisplay,
      mcpCallTracker,
      this.assistantStatusManager,
      this.mcpHealthMonitor,
    );
    // Set reaction manager for MCP pending tracking (hourglass emoji)
    this.toolEventProcessor.setReactionManager(this.reactionManager);
    // #664 P2 tool-verbose absorb: route formatted tool results into the B1
    // stream at PHASE>=2. The `\n\n` separator is applied here (caller-side)
    // so TurnSurface.appendText stays a generic B1 write primitive and the
    // tool-event-processor stays decoupled from any UI façade. `appendText`
    // itself returns `false` when the turn has no open stream or is
    // closing — the processor treats that as a fallback signal and reverts
    // to legacy `say`, so tool output is never silently dropped.
    this.toolEventProcessor.setToolResultSink(
      async (turnId, markdown) => (await this.threadPanel?.appendText(turnId, `\n\n${markdown}`)) ?? false,
    );

    // Shared store for deferred user-instruction writes. The SAME instance
    // must be visible to both `ActionHandlers` (button click reader) and
    // `StreamExecutor` (write producer) — PLAN §7.
    const pendingInstructionConfirmStore = new PendingInstructionConfirmStore();
    pendingInstructionConfirmStore.loadForms();

    // ActionHandlers needs context
    const actionContext: ActionHandlerContext = {
      slackApi: this.slackApi,
      claudeHandler: this.claudeHandler,
      sessionManager: this.sessionUiManager,
      messageHandler: this.handleMessage.bind(this),
      reactionManager: this.reactionManager,
      threadPanel: this.threadPanel,
      requestCoordinator: this.requestCoordinator,
      completionMessageTracker,
      mcpManager: this.mcpManager,
      pendingInstructionConfirmStore,
    };
    this.actionHandlers = new ActionHandlers(actionContext);

    // Pipeline components
    this.inputProcessor = new InputProcessor({
      fileHandler: this.fileHandler,
      commandRouter: this.commandRouter,
      // #617 AC3: InputProcessor needs session + slackApi to intercept the
      // user turn when autoCompactPending is set.
      claudeHandler: this.claudeHandler,
      slackApi: this.slackApi,
    });

    this.sessionInitializer = new SessionInitializer({
      claudeHandler: this.claudeHandler,
      slackApi: this.slackApi,
      messageValidator: this.messageValidator,
      workingDirManager: this.workingDirManager,
      reactionManager: this.reactionManager,
      requestCoordinator: this.requestCoordinator,
      contextWindowManager: this.contextWindowManager,
      assistantStatusManager: this.assistantStatusManager,
      threadPanel: this.threadPanel,
    });

    // Wire turn completion notification channels. `slackBlockKitChannel`
    // is the shared instance constructed above.
    const turnNotifier = new TurnNotifier([
      slackBlockKitChannel,
      new SlackDmChannel(this.slackApi, userSettingsStore),
      new WebhookChannel(userSettingsStore),
      new TelegramChannel(userSettingsStore, process.env.TELEGRAM_BOT_TOKEN),
    ]);

    const summaryTimer = new SummaryTimer();
    const forkExecutor = createForkExecutor(this.claudeHandler);
    // Inject slackApi so SummaryService can post the summary as a permanent
    // in-thread message (in addition to editing the volatile surface header).
    const summaryService = new SummaryService(forkExecutor, this.slackApi);

    this.streamExecutor = new StreamExecutor({
      claudeHandler: this.claudeHandler,
      fileHandler: this.fileHandler,
      toolEventProcessor: this.toolEventProcessor,
      statusReporter: this.statusReporter,
      reactionManager: this.reactionManager,
      contextWindowManager: this.contextWindowManager,
      toolTracker: this.toolTracker,
      todoDisplayManager: this.todoDisplayManager,
      actionHandlers: this.actionHandlers,
      requestCoordinator: this.requestCoordinator,
      slackApi: this.slackApi,
      assistantStatusManager: this.assistantStatusManager,
      threadPanel: this.threadPanel,
      turnNotifier,
      summaryTimer,
      completionMessageTracker,
      summaryService,
      // Shared store — same instance ActionHandlers received above. Writer
      // (here) and reader (handleYes/handleNo) must see identical entries.
      pendingInstructionConfirmStore,
      // The SDK's verdict on every message this host steered into a live turn
      // (06 §3.2/§6.6). The executor stamps its own (canonical) session key on
      // the frame, so the queue is addressed with exactly the key the push was
      // made under. Reads the dispatcher as a runtime field: it is built after
      // this constructor line and no turn can run before then.
      onSteerLifecycle: (args: {
        sessionKey: string;
        uuid: string;
        phase: 'started' | 'completed' | 'cancelled' | 'discarded' | 'observed';
      }) => this.settleSteeredFollowup(args),
    });

    // EventRouter for event handling
    const eventRouterDeps: EventRouterDeps = {
      slackApi: this.slackApi,
      claudeHandler: this.claudeHandler,
      sessionManager: this.sessionUiManager,
      actionHandlers: this.actionHandlers,
      commandDeps,
      // D3: editing the Slack message IS the queue's Edit control — there is no
      // edit UI. Routing only; what the edit may change is decided below.
      onMessageEdited: (edit) => this.handleQueuedMessageEdit(edit),
    };
    this.eventRouter = new EventRouter(app, eventRouterDeps, this.handleMessage.bind(this));

    // #617 DI finalisation. These three wires CANNOT run before EventRouter
    // is constructed (cyclic dep) — ClaudeHandler and StreamExecutor need
    // to be able to call back into EventRouter's dispatchPendingUserMessage.

    // 1. StreamExecutor → EventRouter.dispatchPendingUserMessage
    //    Set on an already-constructed instance via a runtime field.
    (this.streamExecutor as any).deps.dispatchPendingUserMessage = (
      ctx: { channel: string; threadTs: string; user: string; ts: string },
      text: string,
      opts?: { compactRedispatch?: boolean },
    ) => this.eventRouter.dispatchPendingUserMessage(ctx, text, opts);

    // 2. ClaudeHandler compact-hook factory. Each call creates a closure
    //    over the session + slack routing context for a single query.
    // Optional-chained so existing tests that mock claudeHandler as {} still work.
    this.claudeHandler.setCompactHookBuilder?.(({ session, channel, threadTs }) =>
      buildCompactHooks({
        session,
        channel,
        threadTs,
        slackApi: this.slackApi,
        eventRouter: this.eventRouter,
      }),
    );

    // #666 P4 Part 1/2 — Register the Bolt Assistant container. Enables the
    // Slack Assistant sidebar + 4 suggested prompts; routes
    // `assistant_thread_started` / `assistant_thread_context_changed` and
    // assistant-thread `message.im` events through this middleware. The
    // `userMessage` handler delegates to `handleMessage` so assistant threads
    // behave identically to a regular DM. Native spinner activation is
    // handled by the assistant status manager.
    app.assistant(
      createAssistantContainer({
        logger: this.logger,
        handleMessage: this.handleMessage.bind(this),
      }),
    );

    this.initializeFollowupQueue(options.followupQueueStore);
  }

  /**
   * Build the follow-up queue + dispatcher for THIS handler (`ssot.md:131` —
   * injected service, no global singleton).
   *
   * Load order is the contract: read the file, hand the snapshot to the queue,
   * and only then `recover()` — the store deliberately does not transition
   * states on read (`followup-queue-store.ts:26-29`), so a restart marks
   * `queued`/`reserved` as `paused` and anything that was mid-flight as
   * `uncertain` instead of blind-replaying it (ssot.md:146-150).
   *
   * A load failure is DEGRADED, never "empty": the corrupt file is left
   * untouched (no `save` sink is attached, so nothing overwrites recoverable
   * state), enqueue is refused with a visible reason, and drain never runs. An
   * idle message still dispatches — a broken queue file must not take the bot
   * offline — but it dispatches with no recovery and no autogoal release.
   */
  private initializeFollowupQueue(injected?: FollowupQueueStorePort): void {
    let store: FollowupQueueStorePort | undefined;
    let snapshot: FollowupQueueSnapshot | undefined;
    try {
      store = injected ?? new FollowupQueueStore();
      snapshot = store.load();
      if (store.recoveryWarning) {
        // `.bak` fallback = generation rollback: the newest enqueue is gone and
        // the user already saw its receipt. Carry it as the degraded reason so
        // the surface can say so instead of rendering a smaller queue silently.
        this.followupDegradedReason = `queue restored from backup — ${store.recoveryWarning}`;
        this.logger.warn('Follow-up queue restored from backup', { detail: store.recoveryWarning });
      }
    } catch (error) {
      this.followupDegradedReason = `queue state unreadable — ${(error as Error)?.message ?? String(error)}`;
      this.followupReadFailed = true;
      snapshot = undefined;
      store = undefined;
      this.logger.error('Follow-up queue load failed — running DEGRADED (no enqueue, no drain)', {
        error: (error as Error)?.message ?? String(error),
      });
    }

    const persist = store;
    this.followupStore = store;
    // Baseline the observer on what was LOADED, so restored state is never
    // re-reported as fresh transitions the moment `recover()` commits.
    this.primeFollowupObservation(snapshot);
    this.followupQueue = new FollowupQueue({
      capacity: getFollowupQueueCapacity(),
      snapshot,
      // No sink while unreadable: writing would replace state we could not read.
      save: persist
        ? (next) => {
            // Durable first. `observeCommittedQueue` runs only after the store
            // accepted the write, and the queue swaps memory only if this whole
            // sink returns — so a metric can never describe a transition that
            // was rejected (`followup-queue.ts:564-567`).
            persist.save(next);
            this.observeCommittedQueue(next);
          }
        : undefined,
    });
    if (snapshot) {
      this.followupQueue.recover('process restart');
    }

    this.followupDispatcher = new FollowupDispatcher({
      queue: this.followupQueue,
      dispatch: (request) => this.runFollowupDispatch(request),
      interrupt: ({ sessionKey }) => {
        // Anchor for `interruptLatencyMs`: the request, not the enqueue.
        this.followupTimingMaps().interruptAt.set(sessionKey, Date.now());
        // `Send now` cut. Tagged `user-interrupted` so the executor's abort
        // mapping reports a preserved partial turn, not an error (ssot.md:112).
        // The coordinator keys controllers by the session that is really
        // running, which after a bot-thread migration is the CANONICAL key —
        // aborting the slot key would signal nobody.
        //
        // Deliberately an ABORT and not the SDK's `interruptTurn`, even now
        // that messages are steered into the live turn (06 §3.2): the abort
        // kills the CLI child, so any copy this host pushed into that turn's
        // input channel dies with it and can never be run a second time by the
        // drain that picks the item back up. A graceful interrupt would leave
        // those pushed copies alive in the SDK's queue — the double-delivery
        // §3.2 forbids — and settling them would need a receipt this path has
        // no way to wait for.
        this.requestCoordinator.abortSession(this.canonicalFollowupKey(sessionKey), 'user-interrupted');
      },
      authorizeInterrupt: ({ sessionKey, requestedBy }) => this.authorizeFollowupInterrupt(sessionKey, requestedBy),
      // The item's CONTEXT travels with the message: the enqueue-time working
      // directory is part of what is being authorized, not a detail the
      // execution path may resolve on its own (A30).
      authorizeDispatch: ({ sessionKey, item }) =>
        this.authorizeFollowupDispatch(sessionKey, item.message, item.context),
      notify: (notice) => {
        this.logger.debug('Follow-up dispatcher notice', { type: notice.type, sessionKey: notice.sessionKey });
        this.observeDispatcherNotice(notice);
      },
    });

    this.registerFollowupSessionDeletion();
    // NOT reconciled here: the session registry is loaded AFTER construction
    // (`index.ts:487` constructs, `:510` calls `loadSavedSessions`), so every
    // restored session would look like an orphan and the whole queue — including
    // what `recover()` just marked paused/uncertain — would be cancelled (A16).
    this.noteFollowupReconcileDebt(snapshot);

    // Button wiring. `app.action` is absent in the minimal app doubles some
    // unit tests construct — registration is skipped there rather than
    // crashing the handler, and the skip is logged so it can never pass for
    // "registered".
    if (typeof (this.app as Partial<App>)?.action === 'function') {
      registerFollowupActions(this.app, {
        queue: this.followupQueue,
        dispatcher: this.followupDispatcher,
        // A steered item's cancel has to reach the SDK's own input queue first
        // — the queue alone cannot dequeue the copy the model is about to read.
        cancelSteered: (sessionKey, itemId, expectedEpoch, uuid) =>
          this.cancelSteeredFollowup(sessionKey, itemId, expectedEpoch, uuid),
        getSessionByKey: (sessionKey) => this.claudeHandler?.getSessionByKey?.(sessionKey),
        // The SAME interrupt policy the dispatcher uses for `Send now`
        // (owner / current initiator) — one policy, two call sites.
        canInterrupt: (sessionKey, clicker) => this.authorizeFollowupInterrupt(sessionKey, clicker).allowed,
        refresh: (sessionKey, page) => this.refreshFollowupSurface(sessionKey, page),
        // The host owns the drain loop; the action module never re-enters the
        // dispatcher itself.
        runDrain: (sessionKey) => this.runFollowupDrainLoop(sessionKey).then(() => undefined),
        reportError: (label, error) => {
          this.logger.error('Follow-up action failed', { label, error: (error as Error)?.message ?? String(error) });
        },
      });
    } else {
      this.logger.warn('Follow-up actions NOT registered — app.action unavailable');
    }
  }

  /**
   * Session deletion → visible cancellation (`ssot.md:157-158`).
   *
   * Uses the registry's own pre-delete seam (`session-registry.ts:328`), which
   * fires for BOTH the explicit `terminateSession` path and the sleeping-session
   * expiry sweep, so there is one place instead of one per UI surface. The
   * cancellation is committed synchronously — throwing here makes the registry
   * keep the session, which is the fail-closed behavior we want if the queue
   * cannot record the cancellation.
   *
   * The re-render is detached and uses the session object handed to the
   * callback: by the time it runs, the registry has removed the session and a
   * lookup by key would find nothing.
   */
  private registerFollowupSessionDeletion(): void {
    const registry = (this.claudeHandler as { getSessionRegistry?: () => unknown })?.getSessionRegistry?.() as
      | { setBeforeSessionDelete?: (cb: (key: string, session: ConversationSession, reason: string) => void) => void }
      | undefined;
    if (typeof registry?.setBeforeSessionDelete !== 'function') {
      this.logger.warn('Follow-up cancellation on session delete NOT wired — registry seam unavailable');
      return;
    }

    registry.setBeforeSessionDelete((sessionKey, session, reason) => {
      const queue = this.followupQueue;
      if (!queue) return;
      const pending = queue
        .list(sessionKey)
        .filter((item) => !['resolved', 'failed', 'cancelled'].includes(item.state));
      if (pending.length === 0) return;
      queue.cancelSession(sessionKey, `세션이 종료되었습니다 (${reason})`);
      void this.renderFollowupFor(session, sessionKey).catch((error) => {
        this.logger.warn('Follow-up cancellation render failed', {
          sessionKey,
          error: (error as Error)?.message ?? String(error),
        });
      });
    });
  }

  /**
   * Run the startup reconcile exactly once, from the point where the registry
   * is actually populated ({@link loadSavedSessions}).
   *
   * Idempotent on purpose: a host that loads sessions twice must not get a
   * second sweep, and a host that never loads them must not get a silent
   * no-reconcile — {@link warnIfReconcileSkipped} says so out loud.
   */
  private reconcileFollowupSessionsOnce(): void {
    if (this.followupReconciled) return;
    this.followupReconciled = true;
    this.reconcileFollowupSessions();
  }

  /**
   * Remember that the RESTORED state actually has something to reconcile, so an
   * empty boot (and every unit test that constructs a handler) stays silent.
   */
  private noteFollowupReconcileDebt(snapshot?: FollowupQueueSnapshot): void {
    this.followupReconcileDebt = (snapshot?.sessions ?? []).some((session) =>
      session.items.some((item) => !TERMINAL_FOLLOWUP_STATES.includes(item.state)),
    );
  }

  /**
   * "The reconcile never ran" is otherwise invisible: nothing fails, restored
   * orphans just sit in the queue looking drainable forever.
   *
   * Checked LAZILY, at the admission points that depend on the reconcile having
   * run — never on a timer. The real boot is `new SlackHandler` (`index.ts:487`)
   * → `await getAuthContext()` (network) → `loadSavedSessions()` (`:510`), so
   * any timer fires inside that gap and every restart with pending items would
   * warn falsely. Admission, not the clock, is when an un-reconciled queue
   * becomes harmful. Said exactly once.
   */
  private warnIfReconcileSkipped(): void {
    if (this.followupReconciled || !this.followupReconcileDebt || this.followupReconcileWarned) return;
    this.followupReconcileWarned = true;
    this.logger.warn(
      'Follow-up startup reconcile has NOT run — loadSavedSessions() was not called before work was admitted; restored items are not reconciled against the session registry',
    );
  }

  /**
   * Startup reconcile: a session can die while the process is down (expiry
   * sweep on the next boot, an operator deleting state). Its queued items must
   * not sit there looking drainable — nothing will ever claim them, and a
   * silent purge would be the "my message vanished" failure again. They are
   * CANCELLED with a reason and kept as history; nothing is replayed.
   *
   * Runs only AFTER the registry has loaded — see {@link reconcileFollowupSessionsOnce}.
   */
  private reconcileFollowupSessions(): void {
    const queue = this.followupQueue;
    if (!queue) return;
    const live = this.claudeHandler?.getAllSessions?.();
    if (!live) return; // no registry view (test doubles) — leave state untouched

    const orphans = queue
      .snapshot()
      .sessions.filter(
        (session) =>
          !live.has(session.sessionKey) &&
          session.items.some((item) => !['resolved', 'failed', 'cancelled'].includes(item.state)),
      );
    for (const session of orphans) {
      queue.cancelSession(session.sessionKey, '세션이 없어져 실행할 수 없습니다 (프로세스 재시작 중 종료)');
      this.logger.warn('Follow-up items cancelled — session no longer exists', {
        sessionKey: session.sessionKey,
        items: session.items.length,
      });
    }
  }

  /**
   * Public ingress. Owns exactly two things the pipeline below cannot own:
   * the SYNCHRONOUS busy fence and the untouched capture of the raw message.
   *
   * Everything here down to `runInitial` runs with no `await` in between —
   * that is the whole point. `RequestCoordinator.canStartRequest`
   * (`request-coordinator.ts:173-174`) only says "may start", and the executor
   * releases its slot at the TOP of a cleanup that still has awaits ahead of it
   * (`stream-executor.ts:3702` vs `:3726`), so neither can answer "is this
   * session busy?". The dispatcher's slot can, and it is taken before the first
   * await — two messages arriving in the same tick cannot both dispatch.
   *
   * A follow-up that arrives while a turn runs is parked BEFORE any mutation of
   * the event (reaction, `/z` rewrite, inline directives, file download): the
   * queue stores what the user actually sent (ssot.md:91-92).
   */
  async handleMessage(event: MessageEvent, say: any): Promise<void> {
    // First admission point: restored items are only trustworthy once the
    // startup reconcile has run against the registry.
    this.warnIfReconcileSkipped();

    // Shutdown has begun recording its state: DISPATCHING now would start a
    // turn the process is about to kill. The instruction itself is still
    // parked durably — see below.
    if (this.followupShutdownPreparing) {
      await this.parkDuringShutdownPreparation(event);
      return;
    }

    const sessionKey = this.resolveFollowupSessionKey(event);
    const dispatcher = this.followupDispatcher;

    // No dispatcher / no session identity (legacy mocks, DM cleanup-only
    // handlers) → exactly the pre-queue behavior.
    if (!dispatcher || !sessionKey) {
      await this.processMessage(event, say);
      return;
    }

    // --- synchronous fence: no await until the slot is decided ---
    // A reply in a freshly migrated work thread has a DIFFERENT key from the
    // slot the running turn opened; both are checked, or the reply would slip
    // past the fence and dispatch on top of it.
    const slotKey = this.followupMigration?.byCanonical.get(sessionKey);
    // WHICH key owns the live slot, not just "is one of them busy" — every
    // transaction against the running turn (`Send now`, interrupt) has to be
    // addressed to the key the dispatcher actually holds it under.
    const slotOwner = dispatcher.isBusy(sessionKey)
      ? sessionKey
      : slotKey !== undefined && dispatcher.isBusy(slotKey)
        ? slotKey
        : undefined;
    const busy = slotOwner !== undefined;
    const queueable = this.isQueueableFollowup(event);
    if (busy) {
      if (event.synthetic) {
        // A synthetic continuation must never supersede a live or reserved
        // dispatch, and it is not user input, so it is dropped — not queued
        // (`pipeline/types.ts:64-79`, goalContinuation/compactRedispatch).
        this.logger.info('Synthetic turn blocked — session already dispatching', { sessionKey });
        return;
      }
      // `!{prompt}` = explicit steer. It must still cut the running turn, but
      // through the ONE transaction that knows how to do that safely instead of
      // starting a second execution on top of it.
      const steerPrompt = this.parseSteerPrompt(event);
      if (steerPrompt !== undefined) {
        // Through the SLOT-OWNING key: after a bot-thread migration the reply
        // arrives on the work key while the run is held under the source key,
        // and a steer addressed to the work key would find nothing to cut —
        // it would fall through to a plain enqueue and silently not steer.
        await this.steerFollowup(slotOwner, event, steerPrompt);
        return;
      }
      if (queueable) {
        await this.enqueueFollowup(sessionKey, event, say);
        return;
      }
      // Immediate controls only (`!`, DM cleanup links, commands that answer
      // without starting a turn) keep working live — they cannot supersede the
      // running request. A command that WOULD dispatch was classified queueable.
      await this.processMessage(event, say);
      return;
    }

    if (!queueable && !event.synthetic) {
      // Idle immediate control: no dispatch, so it takes no slot and cannot
      // halt the drain with a "blocked" report for a `help` card.
      await this.processMessage(event, say);
      return;
    }

    // Bolt's `say` cannot ride inside the dispatch request (the dispatcher
    // clones the message as JSON), so it is handed over here. The dispatch hook
    // consumes it synchronously — `runInitial` calls it before its first await
    // (`followup-dispatcher.ts:329`, `:567`) — so this never leaks across runs.
    this.rememberInitialSay(sessionKey, say);
    const started = dispatcher.runInitial(sessionKey, event, this.captureFollowupContext(event));
    // --- end of fence ---

    if (started.status !== 'dispatched') {
      // The say was never consumed — drop it so it cannot leak into a later run.
      this.takeInitialSay(sessionKey);
      if (started.status === 'busy') {
        // Lost the slot inside the same tick: park it instead of racing.
        if (!event.synthetic) {
          await this.enqueueFollowup(sessionKey, event, say);
          return;
        }
        this.logger.info('Synthetic turn dropped — slot taken in the same tick', { sessionKey });
        return;
      }
      // Durable open failed (the turn generation could not be committed). Fail
      // closed: dispatching anyway would run a turn with no generation and no
      // durable transaction behind it.
      const detail = (started as { detail?: string }).detail ?? 'queue transaction failed';
      this.logger.error('Follow-up dispatch could not be opened — message NOT run', { sessionKey, detail });
      await this.slackApi.addReaction(event.channel, event.ts, 'warning');
      await this.slackApi.postSystemMessage(
        event.channel,
        `❌ 실행을 시작하지 못했습니다 — ${detail}\n_저장에 실패해 이 메시지는 실행되지 않았습니다. 다시 보내주세요._`,
        { threadTs: event.thread_ts || event.ts },
      );
      return;
    }

    const report = await started.run.settled;
    // Items parked during a migrating turn were stored under the CANONICAL
    // (work-thread) key, because that is the session that still exists — drain
    // there, not under the source key whose session the pipeline deleted.
    const drainKey = this.canonicalFollowupKey(sessionKey);
    this.releaseFollowupMigration(sessionKey);
    await this.drainFollowups(drainKey, report);

    const failure = this.takeInitialError(sessionKey);
    if (failure) throw failure;
  }

  /**
   * The message pipeline itself (formerly the body of `handleMessage`).
   *
   * Returns the outcome the dispatcher needs to decide whether the next safe
   * boundary is open: a resolved promise is NOT evidence of success, because
   * `stream-executor.ts:2497` ends every turn in a `finally` — including the
   * failed ones.
   */
  private async processMessage(
    event: MessageEvent,
    say: any,
    options: { turnEpoch?: number; workingDirectory?: string; slotKey?: string } = {},
  ): Promise<DispatchOutcome> {
    const { channel, thread_ts, ts } = event;
    const originalThreadTs = thread_ts || ts;

    if (channel.startsWith('D')) {
      const handledCleanupRequest = await this.handleDmCleanupRequest(event, say);
      if (handledCleanupRequest) {
        return { result: 'blocked', reason: 'dm cleanup request handled' };
      }

      // DM policy (Issue #553):
      //  - Admin:     plain text is allowed — falls through to the normal
      //               pipeline, which opens an inline session and runs the
      //               prompt.
      //  - Non-admin: only safe `/z` topics + naked session/theme/%/help are
      //               allowed. Plain prompts are rejected up-front so the bot
      //               never silently ignores a DM.
      //
      // Gate A runs BEFORE the `/z` dispatch and BEFORE `processFiles`, so
      // rejection does NOT leak 📎-processing messages or acknowledgement
      // reactions into the DM thread.
      if (!isAdminUser(event.user)) {
        const gatedText = (event.text ?? '').trim();
        if (!isDmAllowedForNonAdmin(gatedText)) {
          await this.sendDmNonAdminRejection(event, 'disallowed-input');
          return { result: 'blocked', reason: 'dm input not allowed for non-admin' };
        }
      }

      // `/z …` normalization — admins and non-admins share the same router
      // when the text starts with `/z`. For non-admins, Gate A already
      // verified the topic is in `SAFE_Z_TOPICS`.
      //
      // FIX #1 followup (codex P1): honour `continueWithPrompt` so commands
      // like `/z new write a test` continue into the session pipeline with
      // the captured prompt rather than becoming a silent no-op.
      const dmText = (event.text ?? '').trim();
      if (stripZPrefix(dmText) !== null) {
        const routed = await this.routeDmViaZRouter(event);
        if (routed.terminal) {
          return { result: 'blocked', reason: 'consumed by /z router' };
        }
        if (routed.continueWithPrompt !== undefined) {
          event.text = routed.continueWithPrompt;
        }
        // else: not terminal and no continuation — fall through with original text.
      }
    }

    // Immediately acknowledge the message with eyes emoji
    await this.slackApi.addReaction(channel, ts, 'eyes');

    // Check for abort command: "!" or "!{prompt}"
    const trimmedText = (event.text || '').trim();
    if (trimmedText.startsWith('!')) {
      const sessionKey = this.claudeHandler.getSessionKey(channel, originalThreadTs);
      let aborted: boolean;
      try {
        aborted = this.requestCoordinator.abortSession(sessionKey);
      } catch (error) {
        // Fail-closed stop: the coordinator's pre-abort observer (the queue
        // freeze) could not commit, so NOTHING was aborted
        // (`request-coordinator.ts:208-221`). Reporting a stop here would
        // describe state that does not exist.
        const detail = (error as Error)?.message ?? String(error);
        this.logger.error('Stop refused — queue freeze could not be persisted', { sessionKey, detail });
        await this.slackApi.removeReaction(channel, ts, 'eyes');
        await this.slackApi.addReaction(channel, ts, 'warning');
        await this.slackApi.postSystemMessage(
          channel,
          `❌ 중단하지 못했습니다 — 큐 상태를 저장할 수 없어 중단을 취소했습니다 (${detail})\n` +
            '_실행 중인 턴은 그대로이고, 큐도 그대로입니다._',
          { threadTs: originalThreadTs },
        );
        return { result: 'blocked', reason: `stop refused: ${detail}` };
      }
      const followUpPrompt = trimmedText.slice(1).trim();

      if (followUpPrompt) {
        // "!{prompt}" — abort current request, continue pipeline with new prompt
        if (aborted) {
          this.logger.info('Aborted active request, continuing with new prompt', {
            sessionKey,
            user: event.user,
            prompt: followUpPrompt.substring(0, 100),
          });
        }
        event.text = followUpPrompt;
      } else {
        // "!" only — abort and stop pipeline
        await this.slackApi.removeReaction(channel, ts, 'eyes');
        if (aborted) {
          await this.slackApi.addReaction(channel, ts, 'octagonal_sign');
          this.logger.info('Request aborted by user', { sessionKey, user: event.user });
        } else {
          await this.slackApi.addReaction(channel, ts, 'heavy_multiplication_x');
          this.logger.debug('Abort requested but no active request', { sessionKey, user: event.user });
        }
        // The freeze already happened inside `abortSession`, BEFORE the abort
        // (`beforeAbort`) — there is deliberately no second freeze here: two
        // owners of the same transition is how the two drift apart.
        return { result: 'blocked', reason: 'explicit user abort' };
      }
    }

    // Inline session directives — `%model <v> {instruction}` / `%nogoal {instruction}`.
    // `%model <v> {instruction}` is TWO actions in one message: a session-scoped
    // model change applied FIRST (before autogoal promotion and dispatch — see the
    // apply site after session init below), then the remainder re-enters the
    // pipeline as if it were the message the user sent. `%nogoal {instruction}`
    // suppresses autogoal promotion for this message only. Bare `%model <v>`
    // (no remainder) keeps its existing SessionCommandHandler routing.
    let inlineModel: string | undefined;
    let inlineNoGoal = false;
    if (!event.synthetic) {
      const directives = CommandParser.parseInlineSessionDirectives(event.text || '');
      if (directives) {
        if (directives.remainder === '') {
          // Directive-only message (e.g. bare `%nogoal`) — nothing to run.
          await this.slackApi.removeReaction(channel, ts, 'eyes');
          await this.slackApi.postSystemMessage(
            channel,
            '💡 Usage: `%nogoal <지시>` / `%model <model> <지시>` — 뒤에 지시가 없어 아무것도 실행하지 않았습니다.',
            { threadTs: originalThreadTs },
          );
          return { result: 'blocked', reason: 'directive-only message' };
        }
        if (directives.model) {
          // Cache miss → forced llmux catalog re-fetch + one retry before
          // dropping the instruction.
          const resolved = await userSettingsStore.resolveModelInputWithRefresh(directives.model);
          if (!resolved) {
            // Fail loudly and DROP the instruction — dispatching it on the old
            // model would silently ignore the user's model choice.
            await this.slackApi.removeReaction(channel, ts, 'eyes');
            await this.slackApi.addReaction(channel, ts, 'warning');
            await this.slackApi.postSystemMessage(
              channel,
              `❌ Unknown model \`${directives.model}\` — 지시는 실행되지 않았습니다. \`model list\`로 확인 후 다시 보내세요.`,
              { threadTs: originalThreadTs },
            );
            return { result: 'blocked', reason: `unknown model ${directives.model}` };
          }
          inlineModel = resolved;
        }
        inlineNoGoal = directives.noGoal;
        // Preserve the directive-bearing original for replay stashes
        // (channel-route halt advisory, auto-compact pendingUserText) so a
        // replayed message re-parses the directives instead of losing them.
        event.inlineDirectiveRawText = event.text;
        event.text = directives.remainder;
      }
    }

    // Wrap say function
    const wrappedSay = async (args: any) => {
      const result = await say({
        text: args.text,
        thread_ts: args.thread_ts,
        blocks: args.blocks,
        attachments: args.attachments,
      });
      return { ts: result?.ts };
    };

    // Step 1: Process files and check for content
    const { files: processedFiles, shouldContinue } = await this.inputProcessor.processFiles(event, wrappedSay);
    if (!shouldContinue) {
      // Remove eyes emoji if nothing to process
      await this.slackApi.removeReaction(channel, ts, 'eyes');
      return { result: 'blocked', reason: 'nothing to process' };
    }

    this.logger.debug('Received message from Slack', {
      user: event.user,
      channel,
      thread_ts,
      ts,
      text: event.text ? event.text.substring(0, 100) + (event.text.length > 100 ? '...' : '') : '[no text]',
      fileCount: processedFiles.length,
    });

    // S-autoskill: decide whether a forced `$skill` in THIS message should be
    // deferred (fired after session init / autogoal / autoskill) rather than
    // during routing. True for a fresh-context start: no session yet, or the
    // existing session has no sessionId (already reset). The `new`-reset case
    // (existing session WITH sessionId, reset mid-routing) is forced to defer
    // inside CommandRouter's new-remainder re-route. Synthetic turns never defer.
    const preRouteSession = this.claudeHandler.getSession?.(channel, originalThreadTs);
    const deferSkillFire = !event.synthetic && (!preRouteSession || preRouteSession.sessionId === undefined);

    // Step 2: Route commands
    const { handled, continueWithPrompt, forceWorkflow, setGoalObjective, deferredSkillFire } =
      await this.inputProcessor.routeCommand(event, wrappedSay, { deferSkillFire });
    if (handled && !continueWithPrompt) {
      // Issue #1082 T1 (spec-review P1): the no-session goal+skill split can
      // end here when the skill part errored out (`handled:true`, no prompt —
      // e.g. ambiguous or unresolvable `$skill` ref). No session will be
      // created, so the parsed objective CANNOT be applied — but #1082's
      // whole contract is that a goal never vanishes silently, so announce
      // the drop instead of swallowing it.
      if (setGoalObjective) {
        await this.slackApi.postSystemMessage(
          channel,
          '⚠️ Goal was NOT set — the rest of the message was consumed by a command that could not start a session. Resend `goal <objective>` (optionally with a valid `$skill`).',
          { threadTs: originalThreadTs },
        );
      }
      // Command was handled - replace eyes with zap emoji
      await this.slackApi.removeReaction(channel, ts, 'eyes');
      await this.slackApi.addReaction(channel, ts, 'zap');
      return { result: 'blocked', reason: 'command consumed the message' };
    }

    // Gate B (Issue #553 backstop): non-admin DM input that survived Gate A
    // but was NOT claimed by any command handler must NOT fall through into
    // session init. Covers edge cases like `/z <topic>` remainders that the
    // router rejects silently, or commands that return `handled:false` for
    // non-admin users. Remove the eyes ack before rejecting so the DM looks
    // consistent with the Gate A rejection path.
    if (channel.startsWith('D') && !isAdminUser(event.user) && !handled) {
      await this.slackApi.removeReaction(channel, ts, 'eyes');
      await this.sendDmNonAdminRejection(event, 'unhandled-after-route');
      return { result: 'blocked', reason: 'dm rejected after routing' };
    }

    // If command returned a follow-up prompt (e.g., /new <prompt>), use that instead.
    // Codex P1 review of #555 — `event.text` may be `undefined` (file-only DM,
    // some Slack event shapes). Normalize to an empty string so downstream
    // `sessionInitializer.initialize` / `startWithContinuation` never receive
    // `undefined` and skip text handling silently.
    // Issue #1082 T1: a goal-prefixed FIRST message carries the parsed
    // objective out-of-band — workflow classification must see the RAW
    // objective (not the `goal …` phrasing, and not the goal continuation
    // prompt built later). `continueWithPrompt` still wins when the
    // goal+skill split produced one.
    const effectiveText = continueWithPrompt ?? setGoalObjective ?? event.text ?? '';

    // Step 3: Validate working directory
    const cwdResult = await this.sessionInitializer.validateWorkingDirectory(event, wrappedSay);
    if (!cwdResult.valid) {
      // CWD validation failed - replace eyes with warning emoji
      await this.slackApi.removeReaction(channel, ts, 'eyes');
      await this.slackApi.addReaction(channel, ts, 'warning');
      return { result: 'blocked', reason: 'working directory invalid' };
    }
    // A queued item carries the directory its author was working in
    // (`ssot.md:91`), and it is the ONLY directory this dispatch may use. The
    // re-validation above answers for NOW; if the two disagree the authorized
    // directory is gone, so nothing runs.
    const resolvedCwd = this.resolveDispatchWorkingDirectory(
      cwdResult.workingDirectory as string,
      options.workingDirectory,
    );
    if (!resolvedCwd.ok) {
      // Visible, like every other refusal: the eyes ack must not be left
      // implying a turn is running.
      await this.slackApi.removeReaction(channel, ts, 'eyes');
      await this.slackApi.addReaction(channel, ts, 'warning');
      await this.slackApi.postSystemMessage(
        channel,
        `⚠️ ${resolvedCwd.reason}\n_저장할 때의 작업 디렉토리에서만 실행됩니다._`,
        { threadTs: originalThreadTs },
      );
      return { result: 'error', reason: resolvedCwd.reason };
    }
    const workingDirectory = resolvedCwd.workingDirectory;

    // Issue #698 AD-5.5: pre-declare fallback variables so the outer catch can
    // always post to the right thread, even if `initialize()` throws (in which
    // case sessionResult-derived values are unavailable).
    let activeChannel: string = channel;
    let activeThreadTs: string = originalThreadTs;
    let agentSession: V1QueryAdapter | undefined;

    // Setup owns only the original source thread's epoch. Execution acquires
    // its own epoch, so this cleanup cannot clear a newer turn or a migrated target.
    let setupStatusEpoch: number | undefined;
    const clearSetupStatus = async () => {
      if (setupStatusEpoch === undefined) return;
      const expectedEpoch = setupStatusEpoch;
      setupStatusEpoch = undefined;
      try {
        // Bound the wait, not the queued clear: a pending initial write must
        // not block migration or exit, but its eventual clear must stay attached.
        await runWithTimeout(
          () => this.assistantStatusManager.clearStatus(channel, originalThreadTs, { expectedEpoch }),
          3000,
          { what: `setup assistant status clear for source ${channel}:${originalThreadTs}`, logger: this.logger },
        );
      } catch (error) {
        this.logger.warn('Failed to clear setup assistant status', {
          channelId: channel,
          threadTs: originalThreadTs,
          error: (error as Error)?.message ?? String(error),
        });
      }
    };

    // Step 4: Initialize session (pass effectiveText for proper dispatch after command parsing)
    // NOTE: initialize() is now INSIDE the outer try (widened for #698 so
    // DispatchAbortError thrown from Sites B/D in session-initializer reaches
    // the outer catch arm below).
    try {
      // Queued/non-owner input must not steal an active turn's status. Synthetic
      // turns keep their existing execution-owned status lifecycle.
      const sourceSessionKey = `${channel}:${originalThreadTs}`;
      if (!event.synthetic && !this.requestCoordinator.isRequestActive(sourceSessionKey)) {
        setupStatusEpoch = this.assistantStatusManager.bumpEpoch(channel, originalThreadTs);
        void this.assistantStatusManager
          .setStatus(channel, originalThreadTs, 'is thinking...', {
            expectedEpoch: setupStatusEpoch,
          })
          .catch((error) => {
            this.logger.warn('Failed to set setup assistant status', {
              channelId: channel,
              threadTs: originalThreadTs,
              error: (error as Error)?.message ?? String(error),
            });
          });
      }
      const sessionResult = await this.sessionInitializer.initialize(
        event,
        workingDirectory,
        effectiveText,
        forceWorkflow,
      );

      // Bot-thread migration: the session this dispatch actually runs on is not
      // the one the slot was opened for. Bind the pair NOW — before the first
      // await that could let a work-thread reply in — so the fence sees the
      // running turn from either thread.
      if (options.slotKey && sessionResult.sessionKey && sessionResult.sessionKey !== options.slotKey) {
        this.bindFollowupMigration(options.slotKey, sessionResult.sessionKey);
      }

      // Channel routing check: if session was halted due to wrong channel, stop processing
      if (sessionResult.halted) {
        await this.slackApi.removeReaction(channel, ts, 'eyes');
        // Halted covers the acceptance gate too (`session-initializer.ts:403-440`)
        // — never a success, so the drain stays shut.
        return { result: 'blocked', reason: 'session initialization halted' };
      }

      // Goal ralph-loop reset on real user input. A user message
      // means the cap counter ("how many synthetic turns has the
      // model burned without the user weighing in?") must be
      // zeroed; otherwise a long stretch of user activity could
      // sit just below the cap and then quietly burn through it
      // on the next idle. Mirrors codex
      // `clear_reserved_goal_continuation_turn` invalidation
      // semantics on user input. See
      // `docs/goal-command/spec.md` §Auto-Continuation Loop.
      // Skip for synthetic events — those ARE the ralph-loop
      // turns and self-incrementing the counter inside the
      // continuation driver is the source of truth.
      if (!event.synthetic) {
        // Optional chain: many slack-handler unit tests pass a bare
        // `{}` for claudeHandler, so this method may be missing in
        // mocks. Real ClaudeHandler always exports it (claude-handler.ts:374).
        const fullSession = this.claudeHandler.getSessionByKey?.(sessionResult.sessionKey);
        if (fullSession?.goal) {
          resetGoalContinuationOnUserMessage(fullSession);
          this.claudeHandler.saveSessions();
        }
      }

      activeChannel = sessionResult.session.channelId || channel;
      activeThreadTs = sessionResult.session.threadRootTs || sessionResult.session.threadTs || originalThreadTs;
      if (activeChannel !== channel || activeThreadTs !== originalThreadTs) {
        await clearSetupStatus();
      }

      // Inline `%model` — applied right after session init and BEFORE the
      // goal/autogoal blocks below, so this very turn (including a goal
      // promoted from the remainder) runs on the requested model. Mirrors
      // SessionCommandHandler.setSessionModel: session-scoped, user default
      // unchanged, context window re-anchored to the new model.
      if (inlineModel) {
        const registrySession = this.claudeHandler.getSessionByKey?.(sessionResult.sessionKey);
        const targets = new Set<any>([registrySession, sessionResult.session].filter(Boolean));
        for (const target of targets) {
          target.model = inlineModel;
          if (target.usage) {
            target.usage.contextWindow = resolveContextWindow(inlineModel);
          }
        }
        this.claudeHandler.saveSessions();
        await this.slackApi.postSystemMessage(
          activeChannel,
          `⚡ Session model → *${userSettingsStore.getModelDisplayName(inlineModel)}* (\`${inlineModel}\`)\n_이 세션에만 적용. 유저 기본값은 그대로입니다._`,
          { threadTs: activeThreadTs },
        );
      }

      // Issue #1082 T1: the route carried an objective parsed from a
      // goal-prefixed message that arrived with NO session. Apply it to the
      // freshly created registry session BEFORE dispatch so turn 1 already
      // runs with the goal block (cached system prompt invalidated by the
      // helper), then dispatch the goal continuation prompt — unless the
      // goal+skill split already produced a `continueWithPrompt`, which wins
      // as dispatch text. Note: the user-message goal reset above ran on a
      // goal-less session (this IS the message creating the goal), so the two
      // blocks never act on the same turn.
      let dispatchText = effectiveText;

      // Fresh-context start = a brand-new session OR a `new`-reset (which keeps
      // the session object but clears `sessionId`). Drives autoskill firing and
      // lets autogoal run for a deferred `$skill`. `sessionId` is only assigned
      // later by the SDK stream, so it is undefined for both fresh cases here.
      const freshContextStart = sessionResult.isNewSession || sessionResult.session.sessionId === undefined;

      if (setGoalObjective) {
        const fullSession = this.claudeHandler.getSessionByKey?.(sessionResult.sessionKey);
        if (fullSession) {
          // Centralized activate-vs-queue (T2). At a goal-prefixed FIRST
          // message the session is brand-new so this activates; if a goal is
          // somehow already in flight it queues behind it instead of replacing.
          // S4: honor the per-user max-continuation default on this surface too.
          const applied = enqueueOrActivateGoal(
            fullSession,
            setGoalObjective,
            event.user,
            userSettingsStore.getUserGoalMaxContinuations(event.user),
          );
          this.claudeHandler.saveSessions();
          if (applied.activated) {
            await this.slackApi.postSystemMessage(
              activeChannel,
              `🎯 Goal set: ${formatGoalObjectiveForSlack(setGoalObjective)}\n_Continuing with goal context._`,
              { threadTs: activeThreadTs },
            );
            if (!continueWithPrompt) {
              dispatchText = buildGoalContinuationPrompt(applied.goal as SessionGoal);
            }
          } else {
            await this.slackApi.postSystemMessage(
              activeChannel,
              `📋 Goal queued at position ${applied.position}: ${formatGoalObjectiveForSlack(setGoalObjective)}\n_It will start automatically when the current goal completes._`,
              { threadTs: activeThreadTs },
            );
          }
        } else {
          // Registry lookup miss (mock-only in tests, but a real miss would
          // mean the raw objective dispatches with no goal installed) — keep
          // it diagnosable instead of silently degrading.
          this.logger.warn('setGoalObjective present but registry session not found — goal NOT applied', {
            sessionKey: sessionResult.sessionKey,
          });
        }
      }

      // S2 — Autogoal mode: when the user has autogoal ON and this session has
      // NO goal in flight (no active/paused goal, no queue), the first real
      // instruction is promoted to the session goal automatically and then
      // dispatched as the goal's opening turn. Skips synthetic continuation
      // turns and the goal-prefixed path (already handled via setGoalObjective).
      //
      // A deferred `$skill` (fresh-context start) still runs autogoal: its
      // `continueWithPrompt` is the RAW instruction text (no <invoked_skills>
      // block), so the goal objective stays clean. Other `continueWithPrompt`
      // sources (onboarding/compact/`new <plain>`) keep their original skip.
      if (
        !setGoalObjective &&
        !inlineNoGoal &&
        (!continueWithPrompt || (freshContextStart && !!deferredSkillFire)) &&
        !event.synthetic &&
        effectiveText.trim() !== '' &&
        userSettingsStore.getUserAutoGoalEnabled(event.user)
      ) {
        const fullSession = this.claudeHandler.getSessionByKey?.(sessionResult.sessionKey);
        const inFlight =
          !!fullSession?.goal && (fullSession.goal.status === 'active' || fullSession.goal.status === 'paused');
        if (fullSession && !inFlight && !fullSession.goalQueue?.length) {
          const applied = enqueueOrActivateGoal(
            fullSession,
            effectiveText,
            event.user,
            userSettingsStore.getUserGoalMaxContinuations(event.user),
          );
          this.claudeHandler.saveSessions();
          if (applied.activated) {
            await this.slackApi.postSystemMessage(
              activeChannel,
              `🤖 Autogoal: 이 지시를 goal로 설정했습니다 — ${formatGoalObjectiveForSlack(effectiveText)}`,
              { threadTs: activeThreadTs },
            );
            dispatchText = buildGoalContinuationPrompt(applied.goal as SessionGoal);
          }
        }
      }

      // S-autoskill: on a FRESH-CONTEXT start (new session OR `new` reset),
      // visibly force-fire the user's registered autoskills — the `$skill`
      // equivalent, deliberately NOT a silent system-prompt embed. Runs AFTER
      // the autogoal block (Autogoal banner first, then the autoskill banner)
      // and BEFORE the deferred first-instruction `$skill` below, giving the
      // requested order: autogoal → autoskill → forced `$skill`. Appends the
      // `<invoked_skills>` block to THIS turn's dispatch prompt so the model
      // actually executes the skills. Skips synthetic continuation turns.
      if (freshContextStart && !event.synthetic) {
        try {
          const fire = buildAutoskillFire(event.user, `<@${event.user}>`);
          if (fire) {
            await this.slackApi.postMessage(activeChannel, '', {
              threadTs: activeThreadTs,
              attachments: [{ color: fire.banner.color, text: fire.banner.text }],
            });
            dispatchText = dispatchText ? `${dispatchText}\n\n${fire.invokedBlock}` : fire.invokedBlock;
            this.logger.info('Autoskills force-fired on session start', {
              user: event.user,
              skills: fire.keys,
            });
          }
        } catch (err) {
          // Best-effort — a firing failure must not block the user's turn.
          this.logger.warn('Autoskill firing failed', {
            user: event.user,
            error: (err as Error)?.message ?? String(err),
          });
        }
      }

      // Deferred forced `$skill` (the first-instruction `$skill`, e.g. `new
      // $deploy` or a first message `$deploy`). Fired LAST so its banner shows
      // after the autoskill banner and its `<invoked_skills>` block sits after
      // the autoskill block in the dispatch prompt. Always fired when present —
      // SkillForceHandler already resolved + deferred it, so it must not vanish.
      if (deferredSkillFire) {
        await this.slackApi.postMessage(activeChannel, '', {
          threadTs: activeThreadTs,
          attachments: [{ color: deferredSkillFire.banner.color, text: deferredSkillFire.banner.text }],
        });
        dispatchText = dispatchText
          ? `${dispatchText}\n\n${deferredSkillFire.invokedBlock}`
          : deferredSkillFire.invokedBlock;
        this.logger.info('Deferred forced $skill fired after autoskill', {
          user: event.user,
          skills: deferredSkillFire.keys,
        });
      }

      const hasPendingChoice = sessionResult.session.actionPanel?.waitingForChoice === true;
      if (hasPendingChoice) {
        await this.threadPanel?.clearChoice(sessionResult.sessionKey);
        // Treat direct user message as completing manual input from choice UI.
        this.claudeHandler.setActivityStateByKey(sessionResult.sessionKey, 'working');
      }

      await this.threadPanel?.create(sessionResult.session, sessionResult.sessionKey);

      // Replace eyes with brain emoji - message is being sent to model
      // Skip for first message (creates thread) - model adds emoji via reactionManager
      await this.slackApi.removeReaction(channel, ts, 'eyes');
      if (thread_ts) {
        await this.slackApi.addReaction(channel, ts, 'brain');
      }

      // Step 5: Execute via AgentSession (Phase 3c — Issue #87)
      // For the initial mention (thread migration), activeThreadTs differs from originalThreadTs.
      // For continuation messages in the work thread, both are equal — fall back to persisted sourceThread.
      const sourceThreadTs =
        activeThreadTs !== originalThreadTs ? originalThreadTs : sessionResult.session.sourceThread?.threadTs;
      const sourceChannel = activeChannel !== channel ? channel : sessionResult.session.sourceThread?.channel;

      agentSession = this.createAgentSession(sessionResult, wrappedSay, {
        channel: activeChannel,
        threadTs: activeThreadTs,
        user: event.user,
        // Captured once, here: the generation this dispatch owns. Never re-read
        // from the queue inside a callback — a late write would then compare
        // itself against the epoch of the turn that superseded it and pass (A28).
        turnEpoch: options.turnEpoch,
        // Empty string preserves the typed shape when Slack omits team
        // (synthetic events, mid-thread injection) — chat.startStream
        // then drops both recipient fields together.
        teamId: event.team ?? '',
        mentionTs: ts,
        sourceThreadTs,
        sourceChannel,
        synthetic: event.synthetic,
      });

      const continuationHandler: ContinuationHandler = {
        shouldContinue: (result) => {
          const cont = result.continuation as any;
          if (!cont) return { continue: false };
          return { continue: true, prompt: cont.prompt };
        },
        onResetSession: async (continuation: any) => {
          // Issue #697 — host-enforced auto-handoff budget for model-emitted
          // CONTINUE_SESSION. Host-built continuations (renew/onboarding) are
          // stamped `origin: 'host'` at their stream-executor builders and skip
          // enforcement. Predicate is "anything NOT 'host' enforces" so malformed
          // values (e.g. 'MODEL', 'foo') fail closed instead of silently
          // bypassing the guard (spec AD-3 / AD-13).
          if (continuation.origin !== undefined && continuation.origin !== 'model' && continuation.origin !== 'host') {
            this.logger.warn('Continuation.origin has unexpected value; treating as model-emitted', {
              channelId: activeChannel,
              threadTs: activeThreadTs,
              origin: continuation.origin,
            });
          }
          const shouldEnforceBudget = continuation.origin !== 'host';
          if (shouldEnforceBudget) {
            const currentSession = this.claudeHandler.getSession(activeChannel, activeThreadTs);
            const budget = checkAndConsumeBudget(currentSession);
            if (!budget.allowed) {
              throw new HandoffBudgetExhaustedError(
                // biome-ignore lint/style/noNonNullAssertion: reason is always set when allowed=false
                budget.reason!,
                budget.budgetBefore,
                continuation.forceWorkflow,
                currentSession?.handoffContext?.chainId,
              );
            }
          }

          this.claudeHandler.resetSessionContext(activeChannel, activeThreadTs);
          const dispatchText = continuation.dispatchText || continuation.prompt;
          // Issue #695 — z handoff entrypoints need the full continuation prompt
          // (containing the `<z-handoff>` sentinel) for host-side parsing.
          const handoffPrompt = isZHandoffWorkflow(continuation.forceWorkflow)
            ? (continuation.prompt as string | undefined)
            : undefined;
          await this.sessionInitializer.runDispatch(
            activeChannel,
            activeThreadTs,
            dispatchText,
            continuation.forceWorkflow,
            handoffPrompt,
          );
        },
        refreshSession: () => this.claudeHandler.getSession(activeChannel, activeThreadTs),
      };

      // End of widened try (#698 AD-5.5) — startWithContinuation is the last
      // async step inside the try.
      const turnResult = await agentSession.startWithContinuation(
        dispatchText || '',
        continuationHandler,
        processedFiles,
      );
      return this.classifyTurnOutcome(agentSession, sessionResult, turnResult);
    } catch (error) {
      // Issue #695 — host-level z handoff safe-stop. `SessionInitializer.runDispatch`
      // throws `HandoffAbortError` when a forced z-* workflow cannot be entered
      // (missing/malformed sentinel, type-workflow mismatch, missing session).
      // Emit a user-facing message, mark the session terminated, and skip the
      // recoverable-error retry path so we do not silently drift into default
      // workflow or loop retries on a structurally invalid payload.
      if (error instanceof HandoffAbortError) {
        this.logger.warn('Handoff entrypoint aborted', {
          channelId: activeChannel,
          threadTs: activeThreadTs,
          reason: error.reason,
          detail: error.detail,
          forceWorkflow: error.forceWorkflow,
        });
        try {
          await this.slackApi.postMessage(
            activeChannel,
            `❌ Handoff entrypoint 진입 실패\n` +
              `Workflow: \`${error.forceWorkflow}\`\n` +
              `원인: \`${error.reason}\`${error.detail ? ` — ${error.detail}` : ''}\n` +
              `수동 재시도: \`$z <issue-url>\``,
            { threadTs: activeThreadTs },
          );
        } catch (postErr) {
          this.logger.error('Failed to post handoff-abort message', {
            channelId: activeChannel,
            threadTs: activeThreadTs,
            error: (postErr as Error).message,
          });
        }
        // Full termination (archive + cleanup + delete from registry) rather
        // than just flipping `session.terminated`. A half-reset session left in
        // the Map would otherwise be resurrected on the user's next message in
        // the same thread, defeating the safe-stop.
        const sessionKey = this.claudeHandler.getSessionKey(activeChannel, activeThreadTs);
        const refusal = await this.terminateAfterAbort(sessionKey, activeChannel, activeThreadTs);
        // Safe-stop — skip auto-retry, do not re-throw. The queue must not drain
        // into it either way; a REFUSED teardown is reported as such, never as a
        // completed stop.
        return {
          result: 'error',
          reason: refusal ? `handoff aborted, teardown refused: ${refusal}` : `handoff aborted: ${error.reason}`,
        };
      }
      // Issue #697 — auto-handoff budget soft-stop. `onResetSession` throws
      // `HandoffBudgetExhaustedError` when the session has already used its
      // one-per-session hop (or when the session is missing at the seam —
      // invariant break). Unlike `HandoffAbortError` above, we keep the
      // session alive (soft ceiling) so the user can re-enter manually via
      // `$z <issue-url>`.
      if (error instanceof HandoffBudgetExhaustedError) {
        this.logger.warn('Auto-handoff budget exhausted — CONTINUE_SESSION rejected', {
          channelId: activeChannel,
          threadTs: activeThreadTs,
          reason: error.reason,
          budgetBefore: error.budgetBefore,
          forceWorkflow: error.attemptedWorkflow,
          chainId: error.chainId,
        });
        try {
          // Re-fetch handoffContext from the (still-alive, pre-reset) session
          // for richer context in the rejection message. The throw happened
          // BEFORE `resetSessionContext` could run, so handoffContext is still
          // present if the session was a z-handoff entry.
          const liveSession = this.claudeHandler.getSession(activeChannel, activeThreadTs);
          await this.slackApi.postMessage(
            activeChannel,
            formatBudgetExhaustedMessage({
              reason: error.reason,
              attemptedWorkflow: error.attemptedWorkflow,
              handoffContext: liveSession?.handoffContext,
              budgetBefore: error.budgetBefore,
            }),
            { threadTs: activeThreadTs },
          );
        } catch (postErr) {
          this.logger.error('Failed to post budget-exhausted message', {
            channelId: activeChannel,
            threadTs: activeThreadTs,
            error: (postErr as Error).message,
          });
        }
        // Do NOT call terminateSession — soft ceiling; session stays alive
        // for manual user re-entry. Skip auto-retry — the budget exhaustion
        // is a structural ceiling, not a transient error.
        return { result: 'blocked', reason: `auto-handoff budget exhausted: ${error.reason}` };
      }
      // Issue #698 — safe-stop on dispatch failure. `session-initializer`
      // throws `DispatchAbortError` at four drift sites (classifier catch,
      // in-flight wait-timeout, and two forceWorkflow transitionToMain paths)
      // when session has declared workflow intent (handoffContext or
      // forcedWorkflowHint). Hard stop — terminate session (same as
      // HandoffAbortError #695) but with dispatch-specific message + metadata.
      if (error instanceof DispatchAbortError) {
        this.logger.warn('Dispatch aborted — safe-stop', {
          channelId: activeChannel,
          threadTs: activeThreadTs,
          reason: error.reason,
          workflow: error.workflow,
          detail: error.detail,
          elapsedMs: error.elapsedMs,
          chainId: error.handoffContext?.chainId,
        });
        try {
          await this.slackApi.postMessage(
            activeChannel,
            formatDispatchAbortMessage({
              reason: error.reason,
              workflow: error.workflow,
              detail: error.detail,
              elapsedMs: error.elapsedMs,
              handoffContext: error.handoffContext,
            }),
            { threadTs: activeThreadTs },
          );
        } catch (postErr) {
          this.logger.error('Failed to post dispatch-abort message', {
            channelId: activeChannel,
            threadTs: activeThreadTs,
            error: (postErr as Error).message,
          });
        }
        // Hard stop — same semantics as HandoffAbortError (#695). The dispatch
        // pipeline failed, session state is inconsistent; terminate rather than
        // risk half-initialized drift on next message.
        const sessionKey = this.claudeHandler.getSessionKey(activeChannel, activeThreadTs);
        const refusal = await this.terminateAfterAbort(sessionKey, activeChannel, activeThreadTs);
        // Structural failure — skip auto-retry.
        return {
          result: 'error',
          reason: refusal ? `dispatch aborted, teardown refused: ${refusal}` : `dispatch aborted: ${error.reason}`,
        };
      }
      // Auto-retry on recoverable errors (merged from main — auto-retry on error).
      // Issue #698 AD-5.5: guard against `agentSession` being undefined when
      // `initialize()` throws before agentSession was created.
      if (!agentSession) {
        this.logger.warn('Error in initialize() before agentSession was created; skipping auto-retry', {
          channelId: activeChannel,
          threadTs: activeThreadTs,
          error: (error as Error).message,
        });
        throw error; // propagate — no retry context
      }
      const retryAfterMs = agentSession.getRetryAfterMs();
      if (retryAfterMs) {
        const currentSession = this.claudeHandler.getSession(activeChannel, activeThreadTs);
        const retryCount = currentSession?.errorRetryCount ?? 0;
        this.logger.info('Scheduling auto-retry after recoverable error', {
          channelId: activeChannel,
          threadTs: activeThreadTs,
          retryCount,
          delayMs: retryAfterMs,
        });

        // Schedule retry after delay using autoResumeSession pattern.
        // Store timer handle so session reset can cancel it (Issue #215).
        const errorContext = currentSession?.lastErrorContext;
        const sessionIdAtSchedule = currentSession?.sessionId;
        const timer = setTimeout(() => {
          // Verify session hasn't been reset since retry was scheduled (Issue #215)
          const freshSession = this.claudeHandler.getSession(activeChannel, activeThreadTs);
          if (!freshSession || freshSession.sessionId !== sessionIdAtSchedule) {
            this.logger.info('Skipping stale auto-retry — session was reset', {
              channelId: activeChannel,
              threadTs: activeThreadTs,
            });
            return;
          }
          freshSession.pendingRetryTimer = undefined;
          this.autoResumeSession(
            { channelId: activeChannel, threadTs: activeThreadTs, ownerId: event.user },
            undefined,
            errorContext,
          )
            .then(() => {
              this.logger.info('Error auto-retry completed', {
                channelId: activeChannel,
                threadTs: activeThreadTs,
              });
            })
            .catch((retryError) => {
              this.logger.error('Error auto-retry failed', {
                channelId: activeChannel,
                threadTs: activeThreadTs,
                error: (retryError as Error).message,
              });
            });
        }, retryAfterMs);
        // Store handle for cancellation on session reset
        if (currentSession) {
          currentSession.pendingRetryTimer = timer;
        }
        // Retry scheduled — don't re-throw. The turn did NOT succeed, so this is
        // an `error`: the drain stays halted until the retry (or the user) says
        // otherwise, instead of racing the timer for the same session.
        return { result: 'error', reason: `recoverable error — auto-retry in ${retryAfterMs}ms` };
      }
      throw error; // Non-recoverable error — propagate
    } finally {
      await clearSetupStatus();
    }
  }

  /**
   * AgentSession factory — V1QueryAdapter를 세션 컨텍스트로 조립 (Issue #87, Phase 3c)
   */
  private createAgentSession(
    sessionResult: any,
    say: any,
    context: {
      channel: string;
      threadTs: string;
      user: string;
      /**
       * Slack workspace/team id of the originating user. Required by
       * `chat.startStream` (channel/thread streaming) — without it Slack
       * returns `missing_recipient_team_id` and the B1 stream is silently
       * dropped. Sourced from the message event (`event.team`); empty
       * string is tolerated (stream falls back to omitting both recipient
       * fields together).
       */
      teamId: string;
      mentionTs: string;
      sourceThreadTs?: string;
      sourceChannel?: string;
      synthetic?: boolean;
      /**
       * Turn generation this dispatch owns (`ssot.md:116-120`, A28). Captured
       * from the dispatch request and passed down verbatim — the surface
       * compares it against the queue's CURRENT generation and drops writes
       * from a superseded turn. Undefined = legacy caller, no fence.
       */
      turnEpoch?: number;
    },
  ): V1QueryAdapter {
    // Captured once, at construction. Re-reading the queue inside these
    // callbacks would defeat the fence: a late `finish()` from the old turn
    // would compare the NEW generation against itself and be allowed to
    // repaint the new turn's surface.
    const expectedTurnEpoch = context.turnEpoch;

    // TurnRunnerSurface adapter: ThreadPanel → TurnRunnerSurface
    const turnRunnerSurface: TurnRunnerSurface = {
      setStatus: async (session, sessionKey, patch) => {
        await this.threadPanel?.setStatus(session, sessionKey, patch, { expectedTurnEpoch });
      },
      finalizeOnEndTurn: async (session, sessionKey, endTurnInfo, hasPendingChoice) => {
        await this.threadPanel?.finalizeOnEndTurn(session, sessionKey, endTurnInfo, hasPendingChoice, {
          expectedTurnEpoch,
        });
      },
      onAssistantTurnComplete: async (session, sessionKey, assistantMessages) => {
        this.handleAssistantTurnCompleteForGoal(session, sessionKey, assistantMessages);
      },
    };

    const turnRunner = new TurnRunner({
      threadSurface: turnRunnerSurface,
      session: sessionResult.session,
      sessionKey: sessionResult.sessionKey,
    });

    const executeParams = {
      session: sessionResult.session,
      sessionKey: sessionResult.sessionKey,
      userName: sessionResult.userName,
      workingDirectory: sessionResult.workingDirectory,
      abortController: sessionResult.abortController,
      processedFiles: [],
      channel: context.channel,
      threadTs: context.threadTs,
      user: context.user,
      teamId: context.teamId,
      say,
      mentionTs: context.mentionTs,
      sourceThreadTs: context.sourceThreadTs,
      sourceChannel: context.sourceChannel,
      isUserInput: !context.synthetic,
      // Same captured token, for the executor's own late-write fence.
      followupTurnEpoch: expectedTurnEpoch,
    };

    return new V1QueryAdapter({
      streamExecutor: this.streamExecutor,
      executeParams,
      turnRunner,
      // Follow-up yield seam (U4a). Asked only at a fully settled, healthy turn
      // boundary (`v1-query-adapter.ts:219-241`): if user work is queued, the
      // continuation loop ends here so the host can start it as a NEW user
      // dispatch — ahead of autogoal (§3.6) and without injecting text into a
      // running adapter.
      shouldYieldToFollowup: () => this.followupDispatcher?.shouldYield(sessionResult.sessionKey) === true,
    });
  }

  /**
   * Install the goal turn-settled handler (wired in `index.ts`). Fired
   * once per assistant turn end while a goal is active — AFTER the turn
   * has released its request-coordinator slot — so the driver can run
   * the completion eval without racing/superseding the work turn.
   */
  setGoalTurnSettledHandler(handler: (sessionKey: string) => void): void {
    this.goalTurnSettledHandler = handler;
  }
  private goalTurnSettledHandler?: (sessionKey: string) => void;

  /**
   * Post-turn hook fired by the TurnRunner surface. While a goal is
   * `active`, this stashes the turn's assistant text on the session and
   * then triggers the goal driver (eval + maybe continuation).
   *
   * CRITICAL — the trigger point: `onAssistantTurnComplete` fires from
   * `TurnRunner.finish()`, which runs AFTER `StreamExecutor.execute()`
   * has returned and its `finally` has called `removeController` (slot
   * released). The earlier idle-after-drain hook fired ~1s too early —
   * from inside `setActivityState('idle')`, BEFORE the slot was released
   * — so `shouldRunGoalIdleDriver` always saw `requestActive === true`
   * and silently bailed; the eval never ran. Triggering here guarantees
   * the slot is free, so the gate passes and the eval reliably fires.
   *
   * The driver itself still re-checks `isRequestActive` before INJECTING
   * a continuation, so it can never supersede a live/fresh turn (the
   * PROJ-4695 spin). See `docs/goal-command/spec.md` §Auto-Continuation.
   */
  private handleAssistantTurnCompleteForGoal(
    session: ConversationSession,
    sessionKey: string,
    assistantMessages: string[],
  ): void {
    const goal = session.goal;
    if (!goal || goal.status !== 'active') return;

    // codex review round 2/3 #2: only credit this turn's output to the goal if
    // the live goal is STILL the one that owned the turn LEG (same goalId +
    // intent epoch). An Update (epoch bump) or active-goal Delete (goalId swap)
    // mid-turn invalidates the evidence. We key off `activeLegGoalId` /
    // `activeLegGoalEpoch`, which `SessionRegistry.beginTurn` re-captures for
    // EVERY leg — so this is correct even when one `startWithContinuation` call
    // runs multiple adapter turns in a `continue()` loop (a single
    // dispatch-time snapshot would only cover the first leg). A missing leg id
    // (no goal was active at leg start, or beginTurn never ran in a unit test)
    // preserves the original always-stash behavior. We still fire the driver
    // either way: its own M1 epoch guard drives a correct fresh eval.
    const legGoalId = session.activeLegGoalId;
    const legGoalEpoch = session.activeLegGoalEpoch;
    const goalChanged =
      legGoalId !== undefined && (legGoalId !== goal.goalId || (legGoalEpoch ?? 0) !== (goal.epoch ?? 0));

    if (goalChanged) {
      this.logger.info('Goal changed during turn — skipping stale evidence stash', { sessionKey });
    } else {
      const turnText = assistantMessages.join('\n\n');
      // Runtime-only stash — the driver reads this first as the work-summary
      // evidence for the completion eval.
      session.goalLastTurnText = turnText;
      // Persisted, bounded mirror (S8) so an eval that first runs after a
      // restart still has real evidence instead of an empty stash. Persisted
      // via the `goal` serializer; the runtime stash above takes precedence.
      goal.lastAssistantTurnSummary = turnText.slice(0, 16_000);
      this.claudeHandler.saveSessions();
    }
    // §3.6 priority: a human follow-up goes before the next autogoal turn. The
    // evidence stash above still happens — only the DRIVER is held back — so a
    // deferred eval later runs on the real turn text, not on nothing. Released
    // once, by `drainFollowups`, when the queue is empty at a safe boundary.
    if (this.shouldDeferGoalDriver(sessionKey)) {
      (this.followupDeferredGoalSessions ??= new Set<string>()).add(sessionKey);
      this.logger.info('Goal driver deferred — follow-up queue outranks autogoal', { sessionKey });
      return;
    }

    this.logger.debug('Goal turn settled — triggering goal driver', { sessionKey });
    this.goalTurnSettledHandler?.(sessionKey);
  }

  // ---------------------------------------------------------------------------
  // Follow-up queue host (`.prd/slack-agent-ui` §3) — ingress, dispatch, drain.
  // ---------------------------------------------------------------------------

  /** The queue service, for the action handler wired in the next unit. */
  getFollowupQueue(): FollowupQueue | undefined {
    return this.followupQueue;
  }

  /** The dispatcher (`Send now`, drain, busy state), for the next unit's button handler. */
  getFollowupDispatcher(): FollowupDispatcher | undefined {
    return this.followupDispatcher;
  }

  /**
   * What the surface renders. The queue's own snapshot IS the view
   * (`followup-queue-blocks.ts:86-101` accepts a session snapshot structurally),
   * so nothing is re-derived here — a second derivation is a second truth.
   */
  getFollowupView(sessionKey: string): FollowupQueueView | undefined {
    const queue = this.followupQueue;
    if (!queue) return undefined;
    return queue.snapshot().sessions.find((session) => session.sessionKey === sessionKey);
  }

  /** Why the queue view is untrustworthy right now (DEGRADED), else `undefined`. */
  getFollowupError(_sessionKey: string): string | undefined {
    return this.followupDegradedReason;
  }

  /** Refresh the Queue block for a live session key. */
  private async refreshFollowupSurface(sessionKey: string, page?: number): Promise<void> {
    const session = this.claudeHandler?.getSessionByKey?.(sessionKey);
    if (!session) return;
    await this.renderFollowupFor(session, sessionKey, page);
  }

  /**
   * Render the Queue for a session object the caller already holds. Deletion
   * needs this: the registry drops the session before the render runs, so a
   * key lookup would silently find nothing and the user would never see the
   * cancellation.
   */
  private async renderFollowupFor(session: ConversationSession, sessionKey: string, page?: number): Promise<void> {
    const panel = this.threadPanel as
      | (ThreadPanel & { updateFollowup?: (s: ConversationSession, k: string, page?: number) => Promise<void> })
      | undefined;
    try {
      if (typeof panel?.updateFollowup === 'function') {
        await panel.updateFollowup(session, sessionKey, page);
      } else {
        await panel?.updatePanel?.(session, sessionKey);
      }
    } catch (error) {
      // A surface write failure must not lose the item — it is already durable.
      this.logger.warn('Follow-up surface refresh failed', {
        sessionKey,
        error: (error as Error)?.message ?? String(error),
      });
    }
  }

  /**
   * Session identity for the queue, or `undefined` when there is none.
   *
   * Synchronous and defensive: many unit tests construct the handler with `{}`
   * for `claudeHandler`, and a handler with no session key simply has no queue —
   * it runs the pre-queue pipeline unchanged rather than crashing.
   */
  private resolveFollowupSessionKey(event: MessageEvent): string | undefined {
    if (typeof this.claudeHandler?.getSessionKey !== 'function') return undefined;
    try {
      return this.claudeHandler.getSessionKey(event.channel, event.thread_ts || event.ts) || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Does this message need the dispatch slot (queue it while busy) or is it an
   * IMMEDIATE control that answers without starting a turn (run it live)?
   *
   * Side-effect free by construction: it only asks `CommandRouter.classifyText`
   * (the same handler instances `routeCommand` would use) and the permalink
   * parser. Nothing here answers the user — a status question like
   * "진행중인거 알려줘?" is an instruction and goes into the queue; the harness
   * answering it instead would be the answer-and-consume path §3.1 forbids.
   *
   * A command that carries a prompt (`new <prompt>`, `goal <objective>`,
   * `$skill …`) is NOT an immediate control: it would dispatch, and dispatching
   * live means superseding the running turn.
   */
  private isQueueableFollowup(event: MessageEvent): boolean {
    if (event.synthetic) return false;
    const text = (event.text ?? '').trim();
    if (!text && !event.files?.length) return false;

    // Bare `!` is an immediate stop: it answers, aborts and consumes, so it
    // runs live. `!{prompt}` is NOT immediate — it starts a turn, so it needs
    // the slot like any other instruction (while busy it takes the steer path).
    if (text.startsWith('!')) return text.slice(1).trim().length > 0;

    // Host-generated replays: they carry their own concurrency contract
    // (`pipeline/types.ts:64-79`) and are not the user's follow-up.
    if (event.routeContext?.compactRedispatch || event.routeContext?.goalContinuation) return false;

    // DM admin cleanup links are a control action on Slack messages, not a prompt.
    if (event.channel.startsWith('D')) {
      if (this.extractSlackPermalinkTarget(event)) return false;
      // Non-admin DM input is gated and rejected up front (`processMessage`
      // Gate A). The gate must run BEFORE anything is accepted into the queue,
      // so this classification refuses to park it in the first place.
      if (!isAdminUser(event.user)) return false;
    }

    if (!text) return true; // file-only message — a real turn
    const classification = this.commandRouter?.classifyText?.(text, event.user);
    return classification !== 'control';
  }

  /**
   * Remember that the live slot `slotKey` is really running session
   * `canonicalKey` (bot-thread migration). Both directions are stored: the
   * fence looks up canonical → slot, the drain looks up slot → canonical.
   */
  private bindFollowupMigration(slotKey: string, canonicalKey: string): void {
    const maps = (this.followupMigration ??= { bySlot: new Map(), byCanonical: new Map() });
    maps.bySlot.set(slotKey, canonicalKey);
    maps.byCanonical.set(canonicalKey, slotKey);
    this.logger.info('Follow-up fence bound across bot-thread migration', { slotKey, canonicalKey });
  }

  /**
   * The key of the session that is really running behind a dispatch slot.
   * Identity for every ordinary turn; the work-thread key while a bot-thread
   * migration is bound. Everything that addresses the SESSION (registry lookup,
   * abort) goes through here; everything that addresses the QUEUE SLOT keeps
   * using the slot key.
   */
  private canonicalFollowupKey(slotKey: string): string {
    return this.followupMigration?.bySlot.get(slotKey) ?? slotKey;
  }

  /** Drop the mapping once the migrating run is over — later turns key on the work thread directly. */
  private releaseFollowupMigration(slotKey: string): void {
    const canonical = this.followupMigration?.bySlot.get(slotKey);
    if (canonical === undefined) return;
    this.followupMigration?.bySlot.delete(slotKey);
    this.followupMigration?.byCanonical.delete(canonical);
  }

  /**
   * The instruction behind an explicit steer, using the EXISTING `!` parsing
   * (`processMessage`'s abort branch: everything after the leading `!`).
   * `undefined` for anything that is not a steer, including a bare `!`.
   */
  private parseSteerPrompt(event: MessageEvent): string | undefined {
    if (event.synthetic) return undefined;
    const text = (event.text ?? '').trim();
    if (!text.startsWith('!')) return undefined;
    const prompt = text.slice(1).trim();
    return prompt.length > 0 ? prompt : undefined;
  }

  /**
   * `!{prompt}` while a turn is running — the user's own "cancel this and do
   * that instead".
   *
   * It runs through the `Send now` transaction rather than the old
   * abort-then-continue path, because that path aborted and then started a
   * SECOND execution immediately: the abort is only a signal, and the executor's
   * cleanup still has awaits ahead of it (`stream-executor.ts:3702` vs `:3726`),
   * so the replacement turn began while the old one was still unwinding. The
   * dispatcher instead reserves BEFORE aborting, waits for the interrupted run's
   * own promise to settle, re-checks the reservation, authorizes the ORIGINAL
   * author, and only then dispatches (`followup-dispatcher.ts:399-529`).
   *
   * The stored item carries the PARSED prompt, i.e. exactly what the existing
   * `!` parsing produces — nothing is rewritten beyond that, and the replay can
   * no longer re-enter the abort branch and steer itself.
   *
   * A refusal (not the owner / not the initiator) is NOT an abort: the live turn
   * keeps running and the instruction stays queued with a visible reason (A13).
   *
   * `sessionKey` is the key that OWNS THE SLOT — after a bot-thread migration
   * that is the source key, not the work-thread key the reply arrived on. The
   * whole transaction (enqueue, `sendNow`, interrupt) has to stay on it, or the
   * dispatcher would not see the victim and a second turn would overlap.
   */
  private async steerFollowup(sessionKey: string, event: MessageEvent, prompt: string): Promise<void> {
    const queue = this.followupQueue;
    const dispatcher = this.followupDispatcher;
    const threadTs = event.thread_ts || event.ts;

    if (!queue || !dispatcher || this.followupReadFailed) {
      await this.slackApi.addReaction(event.channel, event.ts, 'warning');
      await this.slackApi.postSystemMessage(
        event.channel,
        `⚠️ 큐를 사용할 수 없어 중단·재지시를 처리하지 못했습니다 — ${this.followupDegradedReason ?? 'queue unavailable'}`,
        { threadTs },
      );
      return;
    }

    // Durable first: the steer is a stored instruction before anything is cut,
    // so an interrupt can never leave the user with no message and no turn.
    // Author, files and routing context are the original event's.
    const steerEvent: MessageEvent = { ...event, text: prompt };
    let enqueued: ReturnType<FollowupQueue['enqueue']>;
    try {
      enqueued = queue.enqueue(sessionKey, steerEvent, this.captureFollowupContext(event));
    } catch (error) {
      const detail = (error as Error)?.message ?? String(error);
      this.logger.error('Steer enqueue failed — nothing interrupted', { sessionKey, error: detail });
      this.emitFollowupMetric(sessionKey, event.user, {
        operation: 'reject',
        ...this.followupCounts(sessionKey),
        reason: 'persist_failed',
      });
      await this.slackApi.addReaction(event.channel, event.ts, 'warning');
      await this.slackApi.postSystemMessage(
        event.channel,
        `❌ 저장에 실패해 중단·재지시를 실행하지 않았습니다 — ${detail}\n_실행 중인 턴은 그대로입니다._`,
        { threadTs },
      );
      return;
    }

    if (enqueued.status === 'capacity') {
      this.emitFollowupMetric(sessionKey, event.user, {
        operation: 'reject',
        depth: enqueued.pending,
        uncertainCount: this.followupCounts(sessionKey).uncertainCount,
        reason: 'capacity',
      });
      await this.slackApi.addReaction(event.channel, event.ts, 'warning');
      await this.slackApi.postSystemMessage(
        event.channel,
        `⚠️ 큐가 가득 찼습니다 (${enqueued.pending}/${enqueued.capacity}) — 중단·재지시를 실행하지 않았습니다.`,
        { threadTs },
      );
      return;
    }

    const item = enqueued.item;
    // NO await between the enqueue and the cut. A surface refresh here is an
    // await the settling turn's drain can claim this very item in, after which
    // `sendNow` reports a stale rejection and the user is told "중단하지 못했다,
    // 큐에 남아 있다" about an item that is already running. The surface is
    // refreshed once below, with the state the transaction actually left.
    const result = await dispatcher.sendNow(
      sessionKey,
      item.id,
      item.epoch,
      event.user,
      queue.getTurnEpoch(sessionKey),
    );
    await this.refreshFollowupSurface(sessionKey);
    if (result.status === 'rejected') {
      this.logger.info('Steer rejected — live turn untouched', {
        sessionKey,
        itemId: item.id,
        reason: result.reason,
      });
      await this.slackApi.addReaction(event.channel, event.ts, 'warning');
      await this.slackApi.postSystemMessage(
        event.channel,
        `⚠️ 지금 실행 중인 턴을 중단하지 못했습니다 — ${result.detail}\n` +
          '_요청하신 지시는 큐에 그대로 남아 있고, 다음 안전 경계에서 실행됩니다._',
        { threadTs },
      );
      // No second refresh: the one above already rendered the rejected state,
      // and the two Slack writes since then changed no queue state.
      return;
    }

    const report = await result.run.settled;
    await this.refreshFollowupSurface(sessionKey);
    // Same rule as the initial dispatch (`handleMessage`): items parked during a
    // migrating turn live under the CANONICAL key, so the drain happens there.
    const drainKey = this.canonicalFollowupKey(sessionKey);
    this.releaseFollowupMigration(sessionKey);
    await this.drainFollowups(drainKey, report);
  }

  // ---------------------------------------------------------------- metrics
  // Observation only. Nothing in this section may change queue behavior: an
  // emitter failure is logged and dropped, and no queue operation depends on a
  // metric having been recorded.

  private followupTimingMaps(): NonNullable<SlackHandler['followupTiming']> {
    return (this.followupTiming ??= { settledAt: new Map(), interruptAt: new Map(), kind: new Map() });
  }

  /** Seed the delta baseline from loaded state so a restore is not reported as new work. */
  private primeFollowupObservation(snapshot?: FollowupQueueSnapshot): void {
    const observed = (this.followupObserved ??= new Map());
    observed.clear();
    for (const session of snapshot?.sessions ?? []) {
      observed.set(session.sessionKey, new Map(session.items.map((item) => [item.id, item.state])));
    }
  }

  /**
   * Derive queue observability from COMMITTED state (U13b).
   *
   * Why the save sink and not the call sites: the call sites know their
   * intent, the sink knows what actually happened. An intent-shaped metric
   * would report a claim the queue refused, or a dispatch the disk rejected.
   * Everything here is read off the snapshot that was just persisted — never
   * from `this.followupQueue`, whose memory has not been swapped yet.
   *
   * Denials are NOT derived here (a rollback looks like an ordinary return to
   * `queued`); they come from the dispatcher's `item-denied` notice, so one
   * rejection produces one event.
   */
  private observeCommittedQueue(snapshot: FollowupQueueSnapshot): void {
    try {
      const observed = (this.followupObserved ??= new Map());
      for (const session of snapshot.sessions) {
        const previous = observed.get(session.sessionKey) ?? new Map<string, string>();
        const current = new Map(session.items.map((item) => [item.id, item.state]));
        observed.set(session.sessionKey, current);

        const depth = session.items.filter((item) => !TERMINAL_FOLLOWUP_STATES.includes(item.state)).length;
        const uncertainCount = session.items.filter((item) => item.state === 'uncertain').length;
        let sawParkedTransition = false;

        for (const item of session.items) {
          const before = previous.get(item.id);
          if (before === item.state) continue;

          const operation = FOLLOWUP_STATE_OPERATIONS[item.state];
          if (!operation) {
            // `reserved` is a reservation, not a dispatch; `paused`/`cancelled`
            // are session-level outcomes. They are reported as one `snapshot`
            // per committed batch rather than invented per-item operations.
            if (item.state === 'paused' || item.state === 'cancelled') sawParkedTransition = true;
            continue;
          }
          // A return to `queued` from a reservation/claim is a denial rollback —
          // the notice path owns it, so it is not double-counted here.
          if (item.state === 'queued' && before !== undefined) continue;

          this.emitFollowupMetric(session.sessionKey, item.message?.user, {
            operation,
            depth,
            uncertainCount,
            itemId: item.id,
            ...this.followupLatencyFor(session.sessionKey, operation),
            ...this.followupProgressFor(session.sessionKey),
          });
        }

        if (sawParkedTransition) {
          this.emitFollowupMetric(session.sessionKey, undefined, {
            operation: 'snapshot',
            depth,
            uncertainCount,
            ...this.followupProgressFor(session.sessionKey),
          });
        }
      }
    } catch (error) {
      // Observation must never break the transaction that produced it.
      this.logger.debug('Follow-up observation failed', { error: (error as Error)?.message ?? String(error) });
    }
  }

  /** Dispatcher notices that carry facts the committed snapshot cannot show. */
  private observeDispatcherNotice(notice: DispatcherNotice): void {
    const timing = this.followupTimingMaps();
    if (notice.type === 'run-started') {
      // Which kind of run is opening decides which latency the next `dispatch`
      // transition may legitimately carry.
      timing.kind.set(notice.sessionKey, { runId: notice.runId, kind: notice.kind });
      return;
    }
    if (notice.type === 'run-settled') {
      // Anchor for the NEXT drain's wait: the boundary opened here.
      timing.settledAt.set(notice.sessionKey, Date.now());
      // Only the run that claimed the session clears it — an interrupted
      // victim settles AFTER its successor opened, and must not erase it.
      if (timing.kind.get(notice.sessionKey)?.runId === notice.report.runId) {
        timing.kind.delete(notice.sessionKey);
      }
      return;
    }
    if (notice.type === 'item-denied') {
      this.emitFollowupMetric(notice.sessionKey, this.followupItemAuthor(notice.sessionKey, notice.itemId), {
        operation: 'reject',
        ...this.followupCounts(notice.sessionKey),
        itemId: notice.itemId,
        // Stable code, never the underlying detail string.
        reason: notice.stage === 'interrupt' ? 'interrupt_denied' : 'dispatch_denied',
      });
    }
  }

  /** Depth/uncertain read from live memory, for events raised outside the save sink. */
  private followupCounts(sessionKey: string): { depth: number; uncertainCount: number } {
    const items = this.followupQueue?.list(sessionKey) ?? [];
    return {
      depth: items.filter((item) => !TERMINAL_FOLLOWUP_STATES.includes(item.state)).length,
      uncertainCount: items.filter((item) => item.state === 'uncertain').length,
    };
  }

  private followupItemAuthor(sessionKey: string, itemId: string): string | undefined {
    return this.followupQueue?.get(sessionKey, itemId)?.message?.user;
  }

  /**
   * The two latencies that are actually measured, consumed once each.
   *
   * Neither is inferred from `enqueuedAt`: how long an item WAITED is not how
   * long the system TOOK. A drain is measured from the previous turn settling
   * to this item's dispatch; a `Send now` from the interrupt request to the
   * replacement dispatch. When the anchor is missing the field is absent —
   * never zero, never guessed.
   */
  private followupLatencyFor(
    sessionKey: string,
    operation: FollowupQueueOperation,
  ): { drainLatencyMs?: number; interruptLatencyMs?: number } {
    if (operation !== 'dispatch') return {};
    const timing = this.followupTimingMaps();
    const kind = timing.kind.get(sessionKey)?.kind;
    const now = Date.now();

    if (kind === 'send-now') {
      const start = timing.interruptAt.get(sessionKey);
      timing.interruptAt.delete(sessionKey);
      return start === undefined ? {} : { interruptLatencyMs: Math.max(0, now - start) };
    }
    if (kind === 'drain') {
      const start = timing.settledAt.get(sessionKey);
      return start === undefined ? {} : { drainLatencyMs: Math.max(0, now - start) };
    }
    return {};
  }

  /**
   * Real progress timestamp, straight from the surface's own record (U9,
   * `thread-surface.ts:409-410`). Read through a local structural type: the
   * field lives on the surface's view of the panel and `ActionPanelState`
   * (`src/types.ts`) is not mine to extend. Absent → the field is omitted, not
   * substituted with "now".
   */
  private followupProgressFor(sessionKey: string): { lastProgressAt?: number } {
    const panel = this.claudeHandler?.getSessionByKey?.(sessionKey)?.actionPanel as
      | { lastProgressAt?: number }
      | undefined;
    return typeof panel?.lastProgressAt === 'number' ? { lastProgressAt: panel.lastProgressAt } : {};
  }

  /**
   * Fire-and-forget emit. The author is the ORIGINAL item author; the display
   * name comes from already-cached settings only — an observation must not make
   * a network call, and must never carry message text, files or a cwd.
   */
  private emitFollowupMetric(sessionKey: string, authorId: string | undefined, metric: FollowupQueueMetric): void {
    try {
      const userId = authorId ?? this.claudeHandler?.getSessionByKey?.(sessionKey)?.ownerId ?? 'unknown';
      const userName =
        userSettingsStore.getUserSettings?.(userId)?.slackDisplayName ??
        this.claudeHandler?.getSessionByKey?.(sessionKey)?.ownerName ??
        userId;
      getMetricsEmitter()
        .emitFollowupQueue(sessionKey, userId, userName, metric)
        .catch((error) => this.logger.debug('metrics emit failed', error));
    } catch (error) {
      this.logger.debug('metrics emit failed', { error: (error as Error)?.message ?? String(error) });
    }
  }

  /** Execution context captured at enqueue time (`ssot.md:91`), never re-derived at dispatch. */
  private captureFollowupContext(event: MessageEvent): { workingDirectory?: string } {
    const validation = this.messageValidator?.validateWorkingDirectory?.(
      event.user,
      event.channel,
      event.thread_ts || event.ts,
    );
    return validation?.valid ? { workingDirectory: validation.workingDirectory } : {};
  }

  /**
   * Park a follow-up and post its receipt — in that order. `enqueue` commits to
   * disk BEFORE memory (`followup-queue.ts:564-567`), so a thrown save leaves
   * the queue untouched and the user gets an explicit failure instead of a
   * receipt for an item nobody stored (ssot.md:89).
   */
  private async enqueueFollowup(sessionKey: string, event: MessageEvent, say: any): Promise<void> {
    const queue = this.followupQueue;
    const threadTs = event.thread_ts || event.ts;

    if (!queue || this.followupReadFailed) {
      // Fail closed: no durable place to put it, so do not claim to have it and
      // do not dispatch it into the running turn either.
      this.emitFollowupMetric(sessionKey, event.user, {
        operation: 'reject',
        ...this.followupCounts(sessionKey),
        reason: 'queue_degraded',
      });
      await this.slackApi.addReaction(event.channel, event.ts, 'warning');
      await this.slackApi.postSystemMessage(
        event.channel,
        `⚠️ 큐를 사용할 수 없어 이 메시지를 보관하지 못했습니다 — ${this.followupDegradedReason ?? 'queue unavailable'}\n` +
          '_실행 중인 턴이 끝난 뒤 다시 보내주세요._',
        { threadTs },
      );
      return;
    }

    let result: ReturnType<FollowupQueue['enqueue']>;
    try {
      result = queue.enqueue(sessionKey, event, this.captureFollowupContext(event));
    } catch (error) {
      const detail = (error as Error)?.message ?? String(error);
      this.logger.error('Follow-up enqueue failed — message NOT stored', { sessionKey, error: detail });
      // Coded reason only: the raw store error can carry a path.
      this.emitFollowupMetric(sessionKey, event.user, {
        operation: 'reject',
        ...this.followupCounts(sessionKey),
        reason: 'persist_failed',
      });
      await this.slackApi.addReaction(event.channel, event.ts, 'warning');
      await this.slackApi.postSystemMessage(
        event.channel,
        `❌ 큐 저장에 실패해 이 메시지를 보관하지 못했습니다 — ${detail}\n_다시 보내주세요._`,
        { threadTs },
      );
      return;
    }

    if (result.status === 'capacity') {
      // Visible rejection, never a silent drop (ssot.md:95).
      this.emitFollowupMetric(sessionKey, event.user, {
        operation: 'reject',
        depth: result.pending,
        uncertainCount: this.followupCounts(sessionKey).uncertainCount,
        reason: 'capacity',
      });
      await this.slackApi.addReaction(event.channel, event.ts, 'warning');
      await this.slackApi.postSystemMessage(
        event.channel,
        `⚠️ 큐가 가득 찼습니다 (${result.pending}/${result.capacity}) — 이 메시지는 보관되지 않았습니다.`,
        { threadTs },
      );
      return;
    }

    if (result.status === 'duplicate') {
      // Slack redelivery of an event already parked — one item, one receipt.
      this.logger.debug('Follow-up duplicate event ignored', { sessionKey, itemId: result.item.id });
      return;
    }

    await this.slackApi.addReaction(event.channel, event.ts, 'inbox_tray');
    // The receipt must describe the state the item is actually in. A frozen
    // session (explicit stop / restart) does NOT auto-drain, so promising
    // "runs when the current turn ends" would be a false receipt: only an
    // explicit Resume releases it (A29 — a denial and a pause never share a
    // sentence, and neither does a queued item in a frozen session).
    const frozen = queue.freezeReason(sessionKey);
    const halted = this.followupDispatcher?.drainHalt(sessionKey);
    // D1: the default is to hand the message to the turn that is already
    // running instead of making the user wait for it. Not while frozen or
    // halted — there the item is explicitly parked, and steering it would run
    // the very instruction the pause exists to hold back.
    const steered = frozen || halted ? false : await this.trySteerFollowup(sessionKey, event, result.item, say);
    // Counted AFTER the steer: a steered message is no longer waiting on the
    // queue, it is waiting on the model.
    const position = queue.list(sessionKey).filter((item) => item.state === 'queued').length;
    let text: string;
    if (frozen) {
      text =
        `📥 Queue에 보관했습니다 (대기 ${position}건). ⏸️ 큐가 멈춰 있어 자동으로 실행되지 않습니다 — ${frozen}\n` +
        '_`Resume`을 눌러야 다시 실행됩니다._';
    } else if (halted) {
      text =
        `📥 Queue에 보관했습니다 (대기 ${position}건). ⏸️ 자동 실행이 중단된 상태입니다 — ${halted.detail}\n` +
        '_원인을 해소하고 다시 시작해야 실행됩니다._';
    } else if (steered) {
      text =
        `📥 Queue에 넣고 실행 중인 턴에 전달했습니다 (대기 ${position}건) — 모델이 다음 툴 호출 경계에서 읽습니다. ` +
        '취소·즉시 실행은 스레드 맨 아래 패널에서.';
    } else {
      // One line: the controls used to be described here, but they now live in
      // the panel pinned at the tail of the thread — the receipt only has to
      // say "stored, N waiting" and point at where the buttons actually are.
      text = `📥 Queue에 넣었습니다 (대기 ${position}건) — 실행·취소는 스레드 맨 아래 패널에서.`;
    }
    await this.slackApi.postSystemMessage(event.channel, text, { threadTs });
    await this.refreshFollowupSurface(sessionKey);
  }

  /**
   * Auto-steering (06 §3.2, D1/D2): push the just-parked message into the turn
   * that is already running, so the model reads it at its next tool-call
   * boundary instead of at the next dispatch.
   *
   * Runs AFTER the durable enqueue on purpose. Everything in here — the file
   * download, the prompt formatting, the push — is best effort: the item is
   * already stored, so every failure below is answered with the ordinary
   * "stored, N waiting" receipt and the ordinary drain. Returning `false` is
   * therefore never a loss, only a slower delivery.
   *
   * `not-busy` is the common rejection and not an error (no live turn to steer
   * into); `invalid-state` usually means a drain claimed the item between the
   * enqueue and here, which is equally fine — it is running either way.
   */
  private async trySteerFollowup(
    sessionKey: string,
    event: MessageEvent,
    item: FollowupItem,
    say: any,
  ): Promise<boolean> {
    const dispatcher = this.followupDispatcher;
    if (!dispatcher) return false;
    // A handler whose ClaudeHandler has no steering seam (legacy unit doubles)
    // must keep its exact pre-steering behavior — including the queue epochs,
    // which a steer+rollback would bump.
    if (typeof this.claudeHandler?.steerTurn !== 'function') return false;

    let files: ProcessedFile[] = [];
    try {
      let text = (event.text ?? '').trim();
      if (event.files?.length) {
        // D2: attachments steer too. The files are downloaded here rather than
        // at dispatch, and the model reads them from the paths the prompt
        // carries (`file-handler.ts:289`) — no base64 travels through the SDK.
        const processed = await this.inputProcessor.processFiles(event, say);
        files = processed?.files ?? [];
        text = await this.fileHandler.formatFilePrompt(files, text);
      }
      if (!text) return false;

      const steered = dispatcher.steer(sessionKey, item.id, item.epoch, (uuid) =>
        // The steering registry is keyed by the session that is really running,
        // which after a bot-thread migration is the CANONICAL key.
        this.claudeHandler.steerTurn(this.canonicalFollowupKey(sessionKey), { uuid, text }),
      );
      if (steered.status !== 'steered') {
        this.logger.debug('Follow-up not steered — left for the drain', {
          sessionKey,
          itemId: item.id,
          reason: steered.reason,
        });
        await this.cleanupSteerFiles(files);
        return false;
      }
      // Kept until the SDK settles this uuid: the model may open them later in
      // the same turn, so deleting them now would break the message we just
      // delivered.
      if (files.length > 0) (this.followupSteerFiles ??= new Map()).set(steered.uuid, files);
      return true;
    } catch (error) {
      this.logger.warn('Follow-up steer failed — item stays queued', {
        sessionKey,
        itemId: item.id,
        error: (error as Error)?.message ?? String(error),
      });
      await this.cleanupSteerFiles(files);
      return false;
    }
  }

  /**
   * The SDK's verdict on a steered message (06 §6.6), arriving as a
   * `steer_lifecycle` frame of the turn that holds it.
   *
   * `started`/`observed` settle nothing — the message is in the SDK's hands and
   * this host has no transition for "in progress". `completed` is the only
   * consumption receipt; `discarded`/`cancelled` mean the model never acted on
   * it, so the item goes back to `queued` at its original seq and the ordinary
   * drain owns it again (S3).
   *
   * Nothing in here may fail the turn: a bookkeeping error is the host's
   * problem, not the user's answer.
   */
  private async settleSteeredFollowup(args: {
    sessionKey: string;
    uuid: string;
    phase: 'started' | 'completed' | 'cancelled' | 'discarded' | 'observed';
  }): Promise<void> {
    const { sessionKey, uuid, phase } = args;
    if (phase === 'started' || phase === 'observed') return;
    const dispatcher = this.followupDispatcher;
    if (!dispatcher) return;

    try {
      const settled =
        phase === 'completed'
          ? dispatcher.markConsumed(sessionKey, uuid)
          : dispatcher.unsteer(
              sessionKey,
              uuid,
              phase === 'cancelled' ? '취소됨' : '모델이 읽기 전에 턴이 끝나 큐로 되돌림',
            );
      if (!settled.ok) {
        // A receipt for an item this queue no longer holds (already settled,
        // frozen, restarted). Reported, never invented into a transition.
        this.logger.debug('Steer settlement had nothing to record', {
          sessionKey,
          uuid,
          phase,
          reason: settled.reason,
        });
      }
      await this.cleanupSteerFiles(this.takeSteerFiles(uuid));
      await this.refreshFollowupSurface(sessionKey);
    } catch (error) {
      this.logger.warn('Steer settlement failed', {
        sessionKey,
        uuid,
        phase,
        error: (error as Error)?.message ?? String(error),
      });
    }
  }

  /**
   * Cancel of a `steered` item (06 §3.4). The SDK owns the copy the model is
   * about to read, so the order is load-bearing: ask the SDK FIRST, and only
   * write `cancelled` once it confirmed the withdrawal.
   *
   * A `false` from the SDK is not a failure — it means the message already left
   * the SDK's queue, i.e. the model has it. The honest row for that is
   * `consumed` history, so the item is settled that way and the caller says
   * "already delivered" instead of claiming a cancel that did not happen.
   */
  private async cancelSteeredFollowup(
    sessionKey: string,
    itemId: string,
    expectedEpoch: number,
    uuid: string,
  ): Promise<'cancelled' | 'already-delivered' | 'failed'> {
    const queue = this.followupQueue;
    const dispatcher = this.followupDispatcher;
    if (!queue || !dispatcher) return 'failed';

    let withdrawn: boolean;
    try {
      withdrawn = await this.claudeHandler.cancelSteeredMessage(this.canonicalFollowupKey(sessionKey), uuid);
    } catch (error) {
      this.logger.warn('Steered cancel could not reach the SDK', {
        sessionKey,
        itemId,
        error: (error as Error)?.message ?? String(error),
      });
      return 'failed';
    }

    try {
      if (!withdrawn) {
        dispatcher.markConsumed(sessionKey, uuid);
        await this.cleanupSteerFiles(this.takeSteerFiles(uuid));
        return 'already-delivered';
      }
      const cancelled = queue.cancelSteered(sessionKey, itemId, expectedEpoch, '사용자가 취소');
      if (!cancelled.ok) {
        // The SDK dropped it but our row moved on (a settlement raced the
        // click). Say "failed" rather than repaint a cancel we did not record.
        this.logger.info('Steered cancel not recorded', { sessionKey, itemId, reason: cancelled.reason });
        return 'failed';
      }
      await this.cleanupSteerFiles(this.takeSteerFiles(uuid));
      return 'cancelled';
    } catch (error) {
      this.logger.warn('Steered cancel could not be recorded', {
        sessionKey,
        itemId,
        error: (error as Error)?.message ?? String(error),
      });
      return 'failed';
    }
  }

  /**
   * The user edited their own Slack message (D3, §3.4). A `queued` item takes
   * the new text; anything already handed over keeps the text that was handed
   * over, and says so once.
   *
   * Silence is deliberate for an edit that matches no item (the overwhelming
   * case: every ordinary message edit in every thread) and for a terminal one —
   * announcing "this edit did nothing" on a message that ran hours ago would be
   * noise about a queue the user is no longer looking at.
   */
  private async handleQueuedMessageEdit(edit: {
    channel: string;
    ts: string;
    threadTs: string;
    user: string;
    text: string;
  }): Promise<void> {
    const queue = this.followupQueue;
    if (!queue || typeof this.claudeHandler?.getSessionKey !== 'function') return;
    const sessionKey = this.claudeHandler.getSessionKey(edit.channel, edit.threadTs);
    if (!sessionKey) return;

    // `eventKey` is the queue's own identity for the Slack message (A3), so the
    // edit needs no separate index.
    const eventKey = `${edit.channel}:${edit.ts}`;
    const item = queue.list(sessionKey).find((candidate) => candidate.eventKey === eventKey);
    if (!item) return;

    if (item.state === 'queued') {
      const result = queue.editQueued(sessionKey, item.id, item.epoch, edit.text);
      if (!result.ok) {
        this.logger.debug('Queued item edit refused', { sessionKey, itemId: item.id, reason: result.reason });
        return;
      }
      await this.refreshFollowupSurface(sessionKey);
      return;
    }

    if (['resolved', 'failed', 'cancelled'].includes(item.state)) return;

    const noticed = (this.followupEditNoticed ??= new Set());
    if (noticed.has(item.id)) return;
    noticed.add(item.id);
    await this.slackApi.postSystemMessage(edit.channel, '✏️ 이미 전달·실행된 메시지라 편집이 큐에 반영되지 않습니다.', {
      threadTs: edit.threadTs,
    });
  }

  /** Forget the files a uuid owned, handing them to the caller to delete. */
  private takeSteerFiles(uuid: string): ProcessedFile[] {
    const files = this.followupSteerFiles?.get(uuid) ?? [];
    this.followupSteerFiles?.delete(uuid);
    return files;
  }

  /** Best effort: a temp file left behind is a disk problem, never a user-visible one. */
  private async cleanupSteerFiles(files: ProcessedFile[]): Promise<void> {
    if (files.length === 0) return;
    try {
      await this.fileHandler.cleanupTempFiles(files);
    } catch (error) {
      this.logger.debug('Steered file cleanup failed', { error: (error as Error)?.message ?? String(error) });
    }
  }

  /**
   * A message that arrives while the shutdown is recording its state.
   *
   * It must not DISPATCH (the process is about to be killed), but dropping it
   * is the "my message vanished" failure this whole feature exists to remove —
   * and a refusal that lives only in Slack is a drop: both writes below are
   * best-effort and the teardown can race them, after which nothing remains.
   *
   * So the instruction is made DURABLE FIRST. `enqueue` commits to disk before
   * memory (`followup-queue.ts:583-586`) and does not refuse a frozen session;
   * it does not have to, because a `queued` item there cannot drain
   * (`claimNext` → `frozen`, `:349`) and the next boot's `recover()` maps
   * queued → `paused` (`:515`). So a parked item can never auto-run: only an
   * explicit Resume releases it — exactly what the notice promises.
   *
   * Nothing here throws out of `handleMessage`: each Slack write is attempted
   * and its outcome captured, and a park that could NOT happen is logged at
   * error together with those outcomes — when the message was stored nowhere
   * and both writes failed, that log is its only surviving trace.
   */
  private async parkDuringShutdownPreparation(event: MessageEvent): Promise<void> {
    const threadTs = event.thread_ts || event.ts;
    const queue = this.followupQueue;
    const sessionKey = this.resolveFollowupSessionKey(event);

    // Immediate controls (bare `!`, DM cleanup links, `help`) are not parked:
    // they answer instead of starting a turn, so there is nothing to replay.
    let parked = false;
    let parkFailure: string | undefined;
    if (this.isQueueableFollowup(event)) {
      if (!queue || this.followupReadFailed || !sessionKey) {
        parkFailure = sessionKey
          ? (this.followupDegradedReason ?? 'follow-up queue unavailable')
          : 'no session identity for this thread';
      } else {
        try {
          const result = queue.enqueue(sessionKey, event, this.captureFollowupContext(event));
          // A Slack redelivery of an already-parked event is durable too.
          parked = result.status === 'queued' || result.status === 'duplicate';
          if (!parked) parkFailure = `queue refused the item (${result.status})`;
        } catch (error) {
          parkFailure = (error as Error)?.message ?? String(error);
        }
      }
    }

    if (parked) {
      this.logger.info('Message parked during shutdown preparation — stored, not run', {
        sessionKey,
        channel: event.channel,
        ts: event.ts,
      });
    } else {
      this.logger.warn('Message refused — shutdown preparation in progress', {
        channel: event.channel,
        ts: event.ts,
      });
    }

    const attempt = async (what: string, write: () => Promise<unknown>): Promise<string> => {
      try {
        await write();
        return 'ok';
      } catch (error) {
        const detail = (error as Error)?.message ?? String(error);
        this.logger.debug(`Shutdown ${what} failed`, { error: detail });
        return detail;
      }
    };

    const reaction = await attempt('reaction', () =>
      this.slackApi.addReaction(event.channel, event.ts, parked ? 'inbox_tray' : 'warning'),
    );
    const notice = await attempt('notice', () =>
      this.slackApi.postSystemMessage(
        event.channel,
        parked
          ? '📥 재시작 준비 중이라 지금 실행하지 못했습니다 — Queue에 보관했습니다. 재시작 후 Queue에서 `Resume`을 눌러주세요.'
          : '⚠️ 재시작 준비 중이라 이 메시지를 받지 못했습니다 — 잠시 후 다시 보내주세요.',
        { threadTs },
      ),
    );

    if (parkFailure) {
      this.logger.error('Message NOT stored during shutdown preparation', {
        sessionKey,
        channel: event.channel,
        ts: event.ts,
        parkFailure,
        reaction,
        notice,
      });
    }
  }

  /**
   * The dispatcher's one real execution hook. Rebuilds a fresh USER dispatch
   * from the stored message — same author, text, files and routing context
   * (A30/§3.3). Nothing is marked synthetic: a queued message IS user input,
   * and `isUserInput:false` would strip it of that status downstream
   * (`v1-query-adapter.ts:166-195`).
   */
  private async runFollowupDispatch(request: DispatchRequest): Promise<DispatchOutcome> {
    const say = this.takeInitialSay(request.sessionKey) ?? this.createFollowupSay(request.message);
    // The dispatcher hands over a JSON clone, so mutating it inside the
    // pipeline (inline directives, `/z` rewrite) cannot touch queue state.
    const event = request.message as MessageEvent;
    try {
      return await this.processMessage(event, say, {
        turnEpoch: request.turnEpoch,
        workingDirectory: request.context?.workingDirectory,
        slotKey: request.sessionKey,
      });
    } catch (error) {
      if (request.kind === 'initial') {
        // Preserve the pre-queue contract: a non-recoverable initial dispatch
        // error propagates out of `handleMessage` to Bolt.
        this.rememberInitialError(request.sessionKey, error);
      } else {
        this.logger.error('Follow-up dispatch threw', {
          sessionKey: request.sessionKey,
          itemId: request.item?.id,
          error: (error as Error)?.message ?? String(error),
        });
      }
      return { result: 'error', reason: (error as Error)?.message ?? String(error) };
    }
  }

  /** `say` for a drained item: its own thread, reconstructed from the stored message. */
  private createFollowupSay(message: MessageEvent): (args: any) => Promise<{ ts?: string }> {
    const threadTs = message.thread_ts || message.ts;
    return async (args: any) => {
      const result = await this.slackApi.postMessage(message.channel, args?.text ?? '', {
        threadTs: args?.thread_ts ?? threadTs,
        blocks: args?.blocks,
        attachments: args?.attachments,
      });
      return { ts: (result as { ts?: string } | undefined)?.ts };
    };
  }

  private rememberInitialSay(sessionKey: string, say: any): void {
    (this.followupInitialSay ??= new Map<string, any>()).set(sessionKey, say);
  }

  private takeInitialSay(sessionKey: string): any | undefined {
    const say = this.followupInitialSay?.get(sessionKey);
    this.followupInitialSay?.delete(sessionKey);
    return say;
  }

  private rememberInitialError(sessionKey: string, error: unknown): void {
    (this.followupInitialError ??= new Map<string, unknown>()).set(sessionKey, error);
  }

  private takeInitialError(sessionKey: string): unknown | undefined {
    const error = this.followupInitialError?.get(sessionKey);
    this.followupInitialError?.delete(sessionKey);
    return error;
  }

  /**
   * Drain at the safe boundary: the turn is fully settled (its teardown is what
   * resolved `settled`) and the queue outranks autogoal (§3.2/§3.6).
   *
   * Only a `safe` report opens the boundary — `report.canDrain` is the
   * dispatcher's word for "this turn actually finished healthy", not "the
   * promise resolved". A frozen queue, a halted drain or a denied item stops
   * the loop; none of them is retried here (A16).
   */
  private async drainFollowups(sessionKey: string, report: RunReport): Promise<void> {
    const last = report.canDrain ? await this.runFollowupDrainLoop(sessionKey) : undefined;
    this.releaseDeferredGoalDriver(sessionKey, last ?? report);
  }

  /**
   * Drain until the queue is empty or the boundary closes. Also the entry point
   * the action handlers use after a `Send now` / `Resume` — they never re-enter
   * the dispatcher themselves.
   */
  private async runFollowupDrainLoop(sessionKey: string): Promise<RunReport | undefined> {
    // The other admission point: a drain is exactly the thing that would run a
    // restored item nobody reconciled.
    this.warnIfReconcileSkipped();
    const dispatcher = this.followupDispatcher;
    if (!dispatcher) return undefined;
    // No automatic work once the shutdown started recording state.
    if (!this.followupAdmission().allowed) {
      this.logger.info('Drain skipped — shutdown preparation in progress', { sessionKey });
      return undefined;
    }

    let last: RunReport | undefined;
    for (;;) {
      const drained = await dispatcher.drainNext(sessionKey);
      if (drained.status === 'denied' || drained.status === 'aborted') {
        await this.postFollowupNotice(
          sessionKey,
          `⚠️ 큐 항목을 실행하지 못했습니다 — ${drained.detail}\n_항목은 큐에 그대로 남아 있습니다._`,
        );
        await this.refreshFollowupSurface(sessionKey);
        break;
      }
      if (drained.status !== 'dispatched') break;
      last = await drained.run.settled;
      await this.refreshFollowupSurface(sessionKey);
      if (!last.canDrain) break;
    }
    return last;
  }

  /** Hold the autogoal driver while any follow-up work or stop-state is outstanding (§3.6). */
  private shouldDeferGoalDriver(sessionKey: string): boolean {
    const queue = this.followupQueue;
    const dispatcher = this.followupDispatcher;
    if (!queue || !dispatcher) return false;
    if (queue.freezeReason(sessionKey)) return true;
    if (dispatcher.drainHalt(sessionKey)) return true;
    return queue
      .list(sessionKey)
      .some((item) => item.state === 'queued' || item.state === 'reserved' || item.state === 'claimed');
  }

  /**
   * Release the deferred driver ONCE, and only when the boundary is actually
   * clear: the last run was safe, nothing is left queued, and the session is
   * neither frozen nor halted. Anything else keeps the deferral — an autogoal
   * turn started on top of pending user work is exactly the inversion §3.6
   * forbids.
   */
  private releaseDeferredGoalDriver(sessionKey: string, report: RunReport): void {
    if (!this.followupDeferredGoalSessions?.has(sessionKey)) return;
    if (!report.canDrain) return;
    if (this.shouldDeferGoalDriver(sessionKey)) return;

    this.followupDeferredGoalSessions.delete(sessionKey);
    this.logger.info('Follow-up queue empty — releasing deferred goal driver', { sessionKey });
    this.goalTurnSettledHandler?.(sessionKey);
  }

  /**
   * Click-time `Send now` check — the EXISTING interrupt policy, unchanged:
   * owner or current initiator (`session-registry.ts:1221-1224` via
   * `claude-handler.ts:460-461`). The clicker is an authorization subject only;
   * no session field is rewritten with their identity (A30).
   */
  private authorizeFollowupInterrupt(sessionKey: string, requestedBy: string): AuthDecision {
    const admission = this.followupAdmission();
    if (!admission.allowed) return admission;
    // A slot key is not necessarily a session key: after a migration the source
    // session is gone, and looking it up would refuse every steer with
    // "session not found" instead of asking the session that is running.
    const session = this.claudeHandler?.getSessionByKey?.(this.canonicalFollowupKey(sessionKey));
    if (!session) return { allowed: false, reason: 'session not found' };
    const threadTs = session.threadRootTs || session.threadTs;
    const allowed = this.claudeHandler?.canInterrupt?.(session.channelId, threadTs, requestedBy) === true;
    return allowed ? { allowed: true } : { allowed: false, reason: `<@${requestedBy}> cannot interrupt this session` };
  }

  /**
   * Dispatch-time check on the ORIGINAL author (§3.4).
   *
   * `SessionInitializer` runs the acceptance gate only for a NEW session
   * (`session-initializer.ts:403-440`), so a queued item riding an existing
   * session would never be re-checked. It is re-checked here — and a denial
   * only returns the item to `queued` with a reason; it never terminates the
   * session other people are sharing.
   */
  private authorizeFollowupDispatch(
    sessionKey: string,
    message: MessageEvent,
    context?: FollowupContext,
  ): AuthDecision {
    const entry = this.followupAdmission();
    if (!entry.allowed) return entry;
    const author = message?.user;
    if (!author) return { allowed: false, reason: 'queued item has no author' };
    if (!userSettingsStore.isUserAccepted(author)) {
      return { allowed: false, reason: `<@${author}> 승인 대기 상태라 실행할 수 없습니다` };
    }
    const validation = this.messageValidator?.validateWorkingDirectory?.(
      author,
      message.channel,
      message.thread_ts || message.ts,
    );
    if (validation && validation.valid === false) {
      return { allowed: false, reason: validation.errorMessage ?? 'working directory unavailable' };
    }
    // The item is dispatched with the context captured at enqueue (A30), so
    // that context is what has to be authorized NOW. "It still exists on disk"
    // is not authorization: a directory the author moved out of — or lost
    // access to — would otherwise keep executing queued work. A mismatch is a
    // denial, which leaves the item queued with a visible reason (A13); it is
    // never silently rewritten to the current directory.
    const captured = context?.workingDirectory;
    if (captured !== undefined && validation !== undefined && validation.workingDirectory !== captured) {
      this.logger.warn('Follow-up dispatch denied — working directory changed since enqueue', { sessionKey });
      return {
        allowed: false,
        reason: '작업 디렉토리가 변경되어 실행하지 않았습니다 — 저장할 때의 디렉토리에서만 실행됩니다',
      };
    }
    // Re-checked at RETURN: this decision is consumed asynchronously by the
    // dispatcher, and a shutdown may have begun while it was being made. A
    // stale "yes" would start a turn the process is about to kill.
    return this.followupAdmission();
  }

  /**
   * Is the host admitting new follow-up work at all?
   *
   * One predicate, used by every admission point: the dispatcher's
   * `authorizeInterrupt` (`Send now`, checked BEFORE it reserves or aborts)
   * and `authorizeDispatch`, the action module's `canInterrupt` (Resume /
   * Retry, checked before any mutation), and the drain loop. Read-only paths —
   * rendering, pagination, refresh — never consult it, so a stopping bot still
   * shows the truth.
   *
   * A denial is explicit and shaped like every other denial: the item keeps its
   * place, nothing is cancelled, and nothing pretends to have succeeded.
   */
  private followupAdmission(): AuthDecision {
    if (!this.followupShutdownPreparing) return { allowed: true };
    return { allowed: false, reason: '서버 종료 준비 중이라 새 실행을 받지 않습니다 (shutdown in progress)' };
  }

  /**
   * What the finished turn actually proved.
   *
   * `startWithContinuation` resolving is not evidence: `stream-executor.ts:2497`
   * ends every turn in a `finally`, and a handled failure is wrapped in a
   * fallback result whose `endTurn.reason` is `end_turn`
   * (`v1-query-adapter.ts:223-247`). `getLastTurnSucceeded()` is the only local
   * signal that separates the two.
   */
  private classifyTurnOutcome(agentSession: V1QueryAdapter, sessionResult: any, turnResult: any): DispatchOutcome {
    const signal = sessionResult?.abortController?.signal;
    if (signal?.aborted === true) {
      return { result: 'interrupted', reason: String(signal.reason ?? 'aborted') };
    }

    const pendingChoice =
      turnResult?.hasPendingChoice === true || sessionResult?.session?.actionPanel?.waitingForChoice === true;
    if (pendingChoice) {
      // The session belongs to the user until they answer (§3.2 ASK pause).
      return { result: 'blocked', reason: 'awaiting user choice' };
    }

    // Legacy mocks return a bare object from `createAgentSession`; with no
    // accessor there is no evidence of failure, so the pre-queue behavior
    // (continue as before) is preserved.
    const succeeded =
      typeof agentSession?.getLastTurnSucceeded === 'function' ? agentSession.getLastTurnSucceeded() : undefined;
    if (succeeded === false) return { result: 'error', reason: 'turn ended without success' };

    return { result: 'safe' };
  }

  /**
   * Working directory for THIS dispatch — or a refusal.
   *
   * `authorizeFollowupDispatch` compares the captured directory against the
   * author's current one and denies a mismatch, but that check is SYNCHRONOUS
   * and this one runs several awaits later, off `sessionInitializer`'s own
   * re-validation. Between the two the author can `cwd` elsewhere, so the
   * agreement the gate established is a time-of-check fact, not a
   * time-of-use one.
   *
   * Running the newest validated directory here would execute the stored
   * instruction somewhere nobody authorized — the exact failure the gate
   * exists to prevent, reached one await later. So a mismatch REFUSES
   * (`ssot.md:91`, A30). The item is already `dispatched` at this point, so
   * the honest landing is `failed` + Retry (A13), which is what an `error`
   * outcome records (`followup-dispatcher.ts:761-766`); rolling back to
   * `queued` from inside the run is not this layer's transaction.
   *
   * The cwd configuration is still never written — a replayed turn must not
   * move the session.
   */
  private resolveDispatchWorkingDirectory(
    validated: string,
    preferred?: string,
  ): { ok: true; workingDirectory: string } | { ok: false; reason: string } {
    if (preferred && preferred !== validated) {
      this.logger.warn('Working directory changed between authorization and dispatch — NOT running', {
        preferred,
        validated,
      });
      return { ok: false, reason: FOLLOWUP_CWD_CHANGED_REASON };
    }
    return { ok: true, workingDirectory: validated };
  }

  /**
   * `RequestCoordinator.beforeAbort` observer — the single owner of "a stop
   * freezes the queue" (§3.5). Reached for `user-stop` / `session-close` /
   * `shutdown` only; `user-interrupted` (`Send now`) and `supersede` never get
   * here, because freezing there would strand the very item the user is
   * advancing.
   *
   * Deliberately WITHOUT a try/catch: a failed durable write must propagate, so
   * the coordinator performs no abort at all. Swallowing it would abort the turn
   * and then pretend the queue was frozen — the user would see a stopped
   * session whose queue keeps draining.
   *
   * `queue.freeze` maps each item honestly: queued/reserved/claimed → `paused`,
   * but an item that was actually RUNNING → `uncertain` (its side effects are
   * unknown; calling it paused would be a lie — `followup-queue.ts:160-165`).
   */
  private freezeFollowupOnStop(sessionKey: string, reason: string): void {
    const queue = this.followupQueue;
    // Before the queue exists (this observer is installed earlier in the
    // constructor) or with an unreadable backing store, there is nothing
    // durable to record — and writing over state we could not read would
    // destroy it.
    if (!queue || this.followupReadFailed) return;

    const pending = queue.list(sessionKey).filter((item) => !['resolved', 'failed', 'cancelled'].includes(item.state));
    if (pending.length === 0) return;

    queue.freeze(sessionKey, `실행이 중단되었습니다 (${reason})`);
    this.logger.info('Follow-up queue frozen by session stop', { sessionKey, reason, items: pending.length });

    // Detached: the caller is inside a synchronous abort path, and the surface
    // write must not delay or fail the stop. Uses the captured session because
    // a `session-close` stop may remove it moments later.
    const session = this.claudeHandler?.getSessionByKey?.(sessionKey);
    if (!session) return;
    void this.renderFollowupFor(session, sessionKey).catch((error) => {
      this.logger.warn('Follow-up freeze render failed', {
        sessionKey,
        error: (error as Error)?.message ?? String(error),
      });
    });
  }

  /**
   * Safe-stop teardown after an abort. `terminateSession` can REFUSE: the
   * registry's pre-delete observer is fail-closed, so if this session's
   * follow-up cancellation could not be persisted the session is deliberately
   * RETAINED and the call throws. Reporting "stopped" in that case would be a
   * lie about state that still exists, so the refusal is surfaced in-thread and
   * handed back to the caller. Returns the refusal detail, or `undefined` when
   * the session really was torn down.
   */
  private async terminateAfterAbort(
    sessionKey: string,
    channel: string,
    threadTs: string,
  ): Promise<string | undefined> {
    try {
      this.claudeHandler.terminateSession(sessionKey);
      return undefined;
    } catch (error) {
      const detail = (error as Error)?.message ?? String(error);
      this.logger.error('Session teardown REFUSED after abort — session retained', { sessionKey, detail });
      try {
        await this.slackApi.postMessage(
          channel,
          `⚠️ 세션 정리를 완료하지 못했습니다 — ${detail}\n_세션은 그대로 남아 있습니다. 큐 항목도 정리되지 않았습니다._`,
          { threadTs },
        );
      } catch {
        // Best effort — the refusal is already logged and returned.
      }
      return detail;
    }
  }

  private async postFollowupNotice(sessionKey: string, text: string): Promise<void> {
    const session = this.claudeHandler?.getSessionByKey?.(sessionKey);
    if (!session?.channelId) return;
    try {
      await this.slackApi.postSystemMessage(session.channelId, text, {
        threadTs: session.threadRootTs || session.threadTs,
      });
    } catch (error) {
      this.logger.warn('Follow-up notice post failed', {
        sessionKey,
        error: (error as Error)?.message ?? String(error),
      });
    }
  }

  /**
   * FIX #1 (PR #509): route DM `/z …` through ZRouter with `source='dm'` and
   * a `DmZRespond` (chat.postMessage + chat.update).
   *
   * Return shape (codex P1 followup):
   *  - `terminal: true` — the router fully consumed the invocation (tombstone
   *    card, help card, forbidden notice, error ephemeral, or a command that
   *    returned `handled:true` with no continuation). Caller must return.
   *  - `terminal: false, continueWithPrompt: string` — the command captured
   *    a follow-up prompt (e.g. `/z new write a test`); caller should
   *    substitute `event.text` with the prompt and continue the pipeline.
   *  - `terminal: false, continueWithPrompt: undefined` — the router did not
   *    handle the message (unknown `/z` remainder, or internal failure);
   *    caller should fall through to the legacy pipeline unchanged.
   */
  private async routeDmViaZRouter(event: MessageEvent): Promise<{ terminal: boolean; continueWithPrompt?: string }> {
    const zRouter = this.eventRouter.getZRouter();
    if (!zRouter) {
      this.logger.warn('routeDmViaZRouter: zRouter not initialized; falling through');
      return { terminal: false };
    }
    try {
      const respond = new DmZRespond({
        client: this.slackApi.getClient(),
        channel: event.channel,
      });
      const inv = normalizeZInvocation({
        source: 'dm',
        text: event.text ?? '',
        userId: event.user,
        channelId: event.channel,
        teamId: (event as any).team ?? '',
        threadTs: event.thread_ts ?? event.ts,
        respond,
      });
      const result = await zRouter.dispatch(inv);

      // Error path: show failure notice and terminate.
      if (!result.handled && result.error) {
        this.logger.error('ZRouter.dispatch (dm) returned error', {
          error: result.error,
          user: event.user,
          channel: event.channel,
        });
        await respond.send({ text: `⚠️ 명령 실행 실패: ${result.error}` });
        return { terminal: true };
      }

      // Continuation path: caller must continue with the captured prompt.
      if (result.continueWithPrompt !== undefined) {
        return { terminal: false, continueWithPrompt: result.continueWithPrompt };
      }

      // Handled (card / tombstone / passthrough that finished itself) → terminal.
      if (result.handled) {
        return { terminal: true };
      }

      // Unhandled, no error, no continuation → fall through to legacy pipeline.
      return { terminal: false };
    } catch (err: any) {
      this.logger.error('routeDmViaZRouter failed', {
        err: err?.message,
        user: event.user,
        channel: event.channel,
      });
      return { terminal: false };
    }
  }

  /**
   * Issue #553 — reject a non-admin DM input with an ephemeral guide and an
   * `heavy_multiplication_x` reaction so the user can tell the bot saw the
   * message and refused it (distinct from the old silent-drop and from the
   * `no_entry` reaction used elsewhere for "seen but no session").
   *
   * `reason` is logged to distinguish the two rejection call sites (Gate A
   * upfront vs. Gate B backstop) — useful when triaging which grammar a user
   * tried that slipped past the allowlist.
   */
  private async sendDmNonAdminRejection(
    event: MessageEvent,
    reason: 'disallowed-input' | 'unhandled-after-route',
  ): Promise<void> {
    this.logger.info('DM plain text from non-admin rejected', {
      user: event.user,
      channel: event.channel,
      reason,
      textPreview: (event.text ?? '').slice(0, 50),
    });

    const guide =
      'DM에서는 관리자만 평문 프롬프트를 사용할 수 있습니다.\n' +
      '사용 가능한 명령어:\n' +
      '• `/z help` — 전체 도움말\n' +
      '• `sessions` / `sessions public` — 세션 목록\n' +
      '• `theme set <name>` — 테마 설정\n' +
      '• `%model <v>`, `%verbosity <v>`, `%effort <v>` — 세션 설정\n' +
      '• `%model <v> <지시>` / `%nogoal <지시>` — 인라인 모델 변경 / autogoal 미적용 지시\n' +
      '• `/z persona`, `/z model`, `/z notify` 등';

    // Wrap each Slack surface independently so one failure cannot kill the
    // other. `SlackApiHelper.postEphemeral` re-throws on failure (slack-api-
    // helper.ts:484) — that bubble was the live vector that re-created
    // Issue #553's silent drop. `addReaction` today swallows internally and
    // returns false, so its wrapper is defensive: against future contract
    // changes and against direct-mock injection (see T19 regression test).
    try {
      await this.slackApi.postEphemeral(event.channel, event.user, guide, event.thread_ts ?? event.ts);
    } catch (err: any) {
      this.logger.warn('Failed to post non-admin rejection guide', {
        user: event.user,
        channel: event.channel,
        err: err?.message,
      });
    }
    try {
      await this.slackApi.addReaction(event.channel, event.ts, 'heavy_multiplication_x');
    } catch (err: any) {
      this.logger.warn('Failed to add non-admin rejection reaction', {
        user: event.user,
        channel: event.channel,
        err: err?.message,
      });
    }
  }

  private async handleDmCleanupRequest(event: MessageEvent, say: any): Promise<boolean> {
    const target = this.extractSlackPermalinkTarget(event);
    if (!target) {
      return false;
    }

    // A thread reply (the `p…` ts differs from the thread root in `?thread_ts=`)
    // is NOT returned by conversations.history, so it must be looked up through
    // conversations.replies. This was the source of the "no response" bug.
    const isThreadReply = !!target.threadTs && target.threadTs !== target.messageTs;

    const targetMessage = isThreadReply
      ? await this.slackApi.getThreadMessage(target.channelId, target.threadTs as string, target.messageTs)
      : await this.slackApi.getMessage(target.channelId, target.messageTs);

    if (!targetMessage) {
      // Previously this silently returned true (no reaction, no message) — the
      // exact "no response" symptom for thread links. At minimum, tell the
      // admin the instruction could not be fulfilled with an [x] marker.
      this.logger.info('DM cleanup target not found', target);
      if (isAdminUser(event.user)) {
        await this.markDmCleanupFailed(event);
      }
      return true;
    }

    const botUserId = await this.slackApi.getBotUserId();
    const isBotMessage = targetMessage.user === botUserId || !!targetMessage.bot_id;
    if (!isBotMessage) {
      return false;
    }

    // Admin users can delete bot messages directly
    if (isAdminUser(event.user)) {
      // A channel thread ROOT link would wipe the entire thread, so confirm
      // with the admin before doing anything destructive.
      if (!isThreadReply && this.isThreadRoot(targetMessage)) {
        await this.sendThreadDeleteConfirmation(event, target, say);
        return true;
      }

      try {
        await this.slackApi.deleteMessage(target.channelId, target.messageTs);

        // That message may have been a live session's thread anchor.
        // `isThreadRoot()` above only recognises roots that already have replies,
        // so a freshly posted bot thread card falls through to here and is
        // deleted outright. The session would survive with a threadTs pointing at
        // nothing — and Slack silently reroutes posts against a dead thread_ts to
        // the channel, so its later expiry/sleep notices would go out publicly.
        // Match on channel + ts against the registry rather than guessing from
        // message shape, and let the session die with its thread. Runs only after
        // the delete actually succeeded, so a failed delete never orphans a
        // session whose thread is still standing.
        this.terminateSessionAnchoredTo(target.channelId, target.messageTs);

        await this.slackApi.addReaction(event.channel, event.ts, 'white_check_mark');
        this.logger.info('Admin deleted bot message via DM', {
          adminId: event.user,
          targetChannel: target.channelId,
          targetTs: target.messageTs,
          threadTs: target.threadTs,
        });
      } catch (error) {
        this.logger.warn('Admin DM cleanup failed', {
          adminId: event.user,
          targetChannel: target.channelId,
          targetTs: target.messageTs,
          error,
        });
        await this.markDmCleanupFailed(event);
      }
      return true;
    }

    // Non-admin users: send delete request to admins for approval
    await this.sendAdminDeleteApproval(event, target, say);
    return true;
  }

  /** A message is a thread root when it has at least one reply hanging off it. */
  private isThreadRoot(message: any): boolean {
    const replyCount = typeof message?.reply_count === 'number' ? message.reply_count : 0;
    return replyCount > 0;
  }

  /**
   * End the session anchored to `(channel, ts)`, if one is.
   *
   * The lookup is the check: a session key is built from channel + thread ts, so
   * it only resolves when this exact message IS some session's thread anchor.
   * Any other message resolves to a key nothing is stored under and this is a
   * no-op. Deliberately keyed on both values — a thread ts is unique only within
   * its own channel. Never throws; deleting the message is the admin's actual
   * request and must not fail because of bookkeeping.
   */
  private terminateSessionAnchoredTo(channel: string, ts: string): void {
    try {
      const sessionKey = this.claudeHandler.getSessionKey(channel, ts);
      if (this.claudeHandler.terminateSession(sessionKey)) {
        this.logger.info('Terminated session whose thread root was deleted', { channel, ts, sessionKey });
      }
    } catch (error) {
      this.logger.warn('Failed to terminate session for deleted thread root', { channel, ts, error });
    }
  }

  /**
   * Mark the admin's link message with an [x] reaction when a deletion request
   * could not be fulfilled (target not found, or delete API failed).
   */
  private async markDmCleanupFailed(event: MessageEvent): Promise<void> {
    try {
      await this.slackApi.addReaction(event.channel, event.ts, 'x');
    } catch (err: any) {
      this.logger.warn('Failed to add DM cleanup failure reaction', {
        channel: event.channel,
        ts: event.ts,
        err: err?.message,
      });
    }
  }

  /**
   * The link points at a channel thread root. Deleting it removes the whole
   * thread, so ask the admin to confirm with a Yes/No prompt before acting.
   */
  private async sendThreadDeleteConfirmation(
    event: MessageEvent,
    target: SlackPermalinkTarget,
    say: any,
  ): Promise<void> {
    const value: DmDeleteThreadActionValue = {
      requesterId: event.user,
      targetChannel: target.channelId,
      threadTs: target.messageTs,
      linkChannel: event.channel,
      linkTs: event.ts,
    };
    await say({
      text: '이 링크는 스레드 루트입니다. 스레드 전체를 삭제하시겠습니까?',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '이 링크는 *채널 스레드의 루트* 글입니다.\n스레드 전체(루트 + 봇이 쓴 답글 전부)를 삭제하시겠습니까?',
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              action_id: 'dm_delete_thread_cancel',
              text: { type: 'plain_text', text: 'No', emoji: true },
              value: JSON.stringify(value),
            },
            {
              type: 'button',
              action_id: 'dm_delete_thread_confirm',
              text: { type: 'plain_text', text: 'Yes', emoji: true },
              style: 'danger',
              value: JSON.stringify(value),
            },
          ],
        },
      ],
    });
    this.logger.info('Sent thread-delete confirmation to admin', {
      adminId: event.user,
      targetChannel: target.channelId,
      threadTs: target.messageTs,
    });
  }

  /**
   * Send a delete approval request to admin users via DM.
   * Non-admin users cannot delete bot messages directly.
   */
  private async sendAdminDeleteApproval(event: MessageEvent, target: SlackPermalinkTarget, say: any): Promise<void> {
    const adminUserIds = getAdminUsers();
    if (adminUserIds.size === 0) {
      this.logger.warn('No admin users configured for DM delete approval');
      await say({ text: '⚠️ 어드민이 설정되어 있지 않아 삭제 요청을 보낼 수 없습니다.' });
      return;
    }

    const value: DmDeleteActionValue = {
      requesterId: event.user,
      targetChannel: target.channelId,
      targetTs: target.messageTs,
    };

    const permalink = `https://slack.com/archives/${target.channelId}/p${target.messageTs.replace('.', '')}`;

    // Notify each admin
    let notified = 0;
    for (const adminId of adminUserIds) {
      try {
        const adminDmChannel = await this.slackApi.openDmChannel(adminId);
        await this.slackApi.postMessage(adminDmChannel, '봇 메시지 삭제 요청', {
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `<@${event.user}>님이 봇 메시지 삭제를 요청했습니다.\n<${permalink}|메시지 보기>`,
              },
            },
            {
              type: 'actions',
              elements: [
                {
                  type: 'button',
                  action_id: 'dm_delete_reject',
                  text: { type: 'plain_text', text: '거절', emoji: true },
                  value: JSON.stringify(value),
                },
                {
                  type: 'button',
                  action_id: 'dm_delete_approve',
                  text: { type: 'plain_text', text: '승인', emoji: true },
                  style: 'danger',
                  value: JSON.stringify(value),
                },
              ],
            },
          ],
        });
        notified++;
      } catch (error) {
        this.logger.warn('Failed to send delete approval request to admin', { adminId, error });
      }
    }

    if (notified > 0) {
      await say({ text: '📨 어드민에게 삭제 요청을 보냈습니다. 승인 후 삭제됩니다.' });
      this.logger.info('DM cleanup approval sent to admins', {
        requesterId: event.user,
        targetChannel: target.channelId,
        targetTs: target.messageTs,
        adminsNotified: notified,
      });
    } else {
      await say({ text: '⚠️ 어드민에게 삭제 요청을 보내지 못했습니다.' });
    }
  }

  private extractSlackPermalinkTarget(event: MessageEvent): SlackPermalinkTarget | null {
    const sources: string[] = [];
    if (event.text) {
      sources.push(event.text);
    }

    const rawBlocks = (event as any).blocks;
    if (rawBlocks) {
      sources.push(JSON.stringify(rawBlocks));
    }

    const rawAttachments = (event as any).attachments;
    if (rawAttachments) {
      sources.push(JSON.stringify(rawAttachments));
    }

    for (const source of sources) {
      const match = source.match(/https?:\/\/[^\s>|]*slack\.com\/archives\/([A-Z0-9]+)\/p(\d{10,})(?:\?([^\s>|]*))?/i);
      if (!match) {
        continue;
      }

      const channelId = match[1];
      const rawTs = match[2];
      if (rawTs.length <= 6) {
        continue;
      }

      const messageTs = `${rawTs.slice(0, rawTs.length - 6)}.${rawTs.slice(-6)}`;

      // Thread permalinks carry the thread root in `?thread_ts=`. Slack may
      // HTML-encode the URL inside blocks/attachments (`&amp;`), so accept both.
      let threadTs: string | undefined;
      const query = match[3];
      if (query) {
        const threadMatch = query.match(/thread_ts=(\d+\.\d+)/);
        if (threadMatch) {
          threadTs = threadMatch[1];
        }
      }

      return { channelId, messageTs, threadTs };
    }

    return null;
  }

  /**
   * Setup all event handlers via EventRouter
   */
  setupEventHandlers(): void {
    this.eventRouter.setup();
  }

  /**
   * Notify all active sessions about server shutdown
   */
  async notifyShutdown(): Promise<void> {
    await this.sessionUiManager.notifyShutdown();
  }

  /**
   * Record the follow-up side of a shutdown, BEFORE
   * `RequestCoordinator.clearAll()` runs.
   *
   * Why it has to exist: `clearAll` iterates `activeControllers`
   * (`request-coordinator.ts:258-262`), so a session that is merely *waiting* —
   * queued items, nobody running — is never visited and its `beforeAbort`
   * observer never fires. Those are exactly the sessions whose items would come
   * back looking drainable after the restart.
   *
   * It does NOT freeze anything itself: every session is stopped through
   * `abortSession(key, 'shutdown')`, i.e. through the same single freeze owner
   * as any other stop. Two implementations of "a stop freezes the queue" is how
   * the two drift apart.
   *
   * Fail-loud and fail-closed: a store failure propagates, the caller must NOT
   * proceed with the shutdown, and admission is restored so a failed attempt
   * cannot strand the bot in a state where it accepts nothing.
   */
  prepareFollowupShutdown(): void {
    // Set first: from here on the host admits no new work, so nothing can be
    // parked or dispatched into a session we are in the middle of stopping.
    this.followupShutdownPreparing = true;
    try {
      const queue = this.followupQueue;
      if (!queue) return;

      const pending = queue
        .snapshot()
        .sessions.filter((session) => session.items.some((item) => !TERMINAL_FOLLOWUP_STATES.includes(item.state)));

      for (const session of pending) {
        // The observer decides what each item becomes: waiting → `paused`,
        // actually running → `uncertain` (`followup-queue.ts:160-165`).
        this.requestCoordinator.abortSession(session.sessionKey, 'shutdown');
      }
      this.logger.info('Follow-up queue prepared for shutdown', { sessions: pending.length });
    } catch (error) {
      this.followupShutdownPreparing = false;
      this.logger.error('Follow-up shutdown preparation FAILED — shutdown must not proceed', {
        error: (error as Error)?.message ?? String(error),
      });
      throw error;
    }
  }

  /**
   * Undo the admission block of {@link prepareFollowupShutdown} when the
   * shutdown does NOT proceed.
   *
   * `prepareFollowupShutdown` can only reset the flag for its OWN failure; a
   * later step in the shutdown chain (`clearAll`, or anything the caller runs
   * after it) can refuse too, and the process then stays up with a host that
   * accepts nothing. The shutdown caller therefore calls this from its catch,
   * for ANY refusal.
   *
   * It deliberately does NOT resume the queue: the freeze already recorded is a
   * true fact about a stop that happened, and only an explicit user Resume
   * releases paused items (A27). This restores admission, not state.
   */
  cancelFollowupShutdownPreparation(): void {
    if (!this.followupShutdownPreparing) return;
    this.followupShutdownPreparing = false;
    this.logger.warn('Follow-up shutdown preparation cancelled — admitting work again (queue stays frozen)');
  }

  /**
   * Load saved sessions from file.
   *
   * Also the only place the follow-up startup reconcile may run: it compares
   * restored queue state against the session registry, and the registry only
   * exists once this call returns (A16).
   */
  loadSavedSessions(): number {
    const count = this.claudeHandler.loadSessions();
    this.reconcileFollowupSessionsOnce();
    return count;
  }

  /**
   * Notify users whose sessions were interrupted by a crash/restart.
   * Should be called after loadSavedSessions() and after Slack app starts.
   */
  /** Resume prompt sent to model for auto-resuming interrupted sessions.
   *  Loaded from src/prompt/restart.prompt at class-load time for easy editing. */
  private static readonly AUTO_RESUME_PROMPT = (() => {
    try {
      return fs.readFileSync(path.join(__dirname, 'prompt', 'restart.prompt'), 'utf-8').trimEnd();
    } catch {
      // Fallback in case the file is missing (e.g. in test environments)
      return (
        '서비스가 재시작되어 이전 작업이 중단되었다. 아래 순서로 작업을 이어가라:\n' +
        '1. mcp__slack-mcp__get_thread_messages (offset: 0, limit: 50)으로 이 스레드의 전체 대화를 먼저 읽어라.\n' +
        '2. 유저가 마지막으로 요청한 작업이 무엇인지 파악하라.\n' +
        '3. 네가 마지막으로 어디까지 진행했는지 확인하라 (git status, 파일 상태 등).\n' +
        '4. 중단된 지점부터 작업을 이어서 완료하라.\n' +
        '5. 만약 작업 상태를 파악할 수 없으면, 유저에게 현재 상황을 설명하고 다음 단계를 물어라.'
      );
    }
  })();

  /** Delay between processing crash-recovered sessions (ms) */
  private static readonly CRASH_RECOVERY_DELAY_MS = 2000;

  async notifyCrashRecovery(): Promise<number> {
    const recovered = this.claudeHandler.getCrashRecoveredSessions();
    if (recovered.length === 0) return 0;

    let notified = 0;
    let autoResumed = 0;
    for (let i = 0; i < recovered.length; i++) {
      const session = recovered[i];
      // Use the authoritative auto-resume decision captured at shutdown
      // (`wasWorkingAtShutdown`, surfaced as `shouldAutoResume` by
      // `loadSessions`) instead of the persisted `activityState`, which can
      // be stale because the working-state transition does not always reach
      // disk. `shouldAutoResume` is set on every `CrashRecoveredSession`
      // record produced by `loadSessions` — for legacy callers that omit it
      // (the marker is non-typed `unknown` from arbitrary disk JSON) we fall
      // back to `activityState === 'working'`.
      const isWorking =
        typeof session.shouldAutoResume === 'boolean' ? session.shouldAutoResume : session.activityState === 'working';

      // Post notification message and capture its ts for use as synthetic event anchor
      let notificationTs: string | undefined;
      try {
        const notificationText = isWorking
          ? `⚠️ 서비스가 재시작되었습니다. 이전 작업(${session.activityState})이 중단되었을 수 있습니다. 자동으로 재개합니다...`
          : `⚠️ 서비스가 재시작되었습니다. 이전 작업(${session.activityState})이 중단되었을 수 있습니다. 다시 시도해주세요.`;

        const result = await this.app.client.chat.postMessage({
          channel: session.channelId,
          thread_ts: session.threadTs,
          text: notificationText,
        });
        notificationTs = result.ts as string | undefined;
        notified++;
      } catch (error) {
        this.logger.warn('Failed to send crash recovery notification', {
          channel: session.channelId,
          threadTs: session.threadTs,
          error: (error as Error).message,
        });
        // Skip auto-resume if notification failed — channel is likely inaccessible
        if (i < recovered.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, SlackHandler.CRASH_RECOVERY_DELAY_MS));
        }
        continue;
      }

      // T1 no-double-resume: a session with an ACTIVE goal is resumed by the
      // goal loop (`resumeActiveGoals`), which re-enters the ralph loop with
      // the goal continuation prompt. Skipping the generic auto-resume here
      // avoids firing two competing turns into the same thread.
      const liveGoalForRecovery = this.claudeHandler.getSessionByKey?.(session.sessionKey)?.goal;
      if (liveGoalForRecovery?.status === 'active') {
        this.logger.info('Skipping generic auto-resume — active goal will be resumed by the goal loop', {
          channelId: session.channelId,
          threadTs: session.threadTs,
        });
        if (i < recovered.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, SlackHandler.CRASH_RECOVERY_DELAY_MS));
        }
        continue;
      }

      // Auto-resume sessions that were actively working (model mid-execution)
      // IMPORTANT: Fire-and-forget — do NOT await handleMessage.
      // handleMessage triggers Claude SDK streaming which takes minutes.
      // Awaiting would block the loop and prevent other sessions from resuming.
      if (isWorking) {
        this.logger.info('Auto-resuming working session', {
          channelId: session.channelId,
          threadTs: session.threadTs,
          ownerId: session.ownerId,
        });
        this.autoResumeSession(session, notificationTs)
          .then(() => {
            this.logger.info('Auto-resume completed', {
              channelId: session.channelId,
              threadTs: session.threadTs,
            });
          })
          .catch((error) => {
            this.logger.error('Auto-resume failed', {
              channelId: session.channelId,
              threadTs: session.threadTs,
              error: (error as Error).message,
            });
          });
        autoResumed++;
      }

      // Delay between sessions to avoid overwhelming the system
      if (i < recovered.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, SlackHandler.CRASH_RECOVERY_DELAY_MS));
      }
    }

    this.claudeHandler.clearCrashRecoveredSessions();
    // Clear shutdown-recovery markers from live sessions so we don't replay
    // the restart notification on the NEXT restart. We do this once, after
    // the batch, instead of per-session, to keep the per-session loop hot.
    let cleared = 0;
    for (const r of recovered) {
      const live = this.claudeHandler.getSessionByKey(r.sessionKey);
      if (live?.shutdownNotificationSent) {
        live.shutdownNotificationSent = false;
        live.wasWorkingAtShutdown = false;
        live.shutdownNotifiedAt = undefined;
        cleared++;
      }
    }
    if (cleared > 0) {
      // Persist the cleared markers so a fast follow-up restart (no new
      // session activity in between) doesn't resurrect them.
      this.claudeHandler.saveSessions();
    }
    this.logger.info(
      `Sent crash recovery notifications to ${notified}/${recovered.length} sessions, auto-resumed ${autoResumed}`,
    );
    return notified;
  }

  /**
   * T1 — resume unfinished goals after a service restart.
   *
   * When the process restarts mid-goal the goal IS persisted and reloaded,
   * but nothing re-enters the auto-continuation ("ralph") loop — so the goal
   * silently stalls. This scans ALL live sessions (not just the
   * crash-recovered set: a goal session that was idle between continuations at
   * shutdown is not flagged as crash-recovered) and, for every session whose
   * `goal.status === 'active'`, re-triggers the goal loop so the goal is
   * driven to completion.
   *
   * The trigger is `goalTurnSettledHandler` — the same idle-settle entry the
   * normal loop uses. The controller runs the completion eval first (against
   * the persisted `goal.lastAssistantTurnSummary` evidence), then either
   * completes, advances the queue, or injects the next continuation. All of
   * its guards (epoch, cap, never-supersede, per-session serialization) apply,
   * so a redundant trigger is safe.
   *
   * A persisted `activityState` of `working`/`waiting` is stale after a
   * restart (no turn is actually running) and would block the idle-driver
   * gate, so it is forced to `idle` first. Must be called AFTER the goal loop
   * controller is wired (`setGoalTurnSettledHandler`). Returns the count
   * resumed.
   */
  resumeActiveGoals(): number {
    const handler = this.goalTurnSettledHandler;
    if (!handler) {
      this.logger.warn('resumeActiveGoals called before goal loop was wired — skipping');
      return 0;
    }
    let resumed = 0;
    let forcedIdle = 0;
    let repaired = 0;
    for (const [sessionKey, session] of this.claudeHandler.getAllSessions()) {
      // Repair a stranded queue (defense for the eval-complete crash window):
      // if the current goal is genuinely closed (completed) or absent but goals
      // are still queued, promote the next one so the queue can't be orphaned.
      // A `paused` current goal with a queue is VALID T2 state — never advance
      // past it (that would archive the paused goal and skip it).
      const currentStatus = session.goal?.status;
      const stranded = (!session.goal || currentStatus === 'complete') && (session.goalQueue?.length ?? 0) > 0;
      if (stranded) {
        const promoted = advanceGoalQueue(session);
        if (promoted) {
          repaired++;
          this.logger.info('Repaired stranded goal queue after restart — promoted next goal', {
            sessionKey,
            objectivePreview: promoted.objective.slice(0, 120),
          });
        }
      }
      if (session.goal?.status !== 'active') continue;
      if (session.activityState !== 'idle') {
        // Recovery: treat a stale persisted working/waiting state as idle.
        session.activityState = 'idle';
        forcedIdle++;
      }
      this.logger.info('Resuming active goal after restart', {
        sessionKey,
        objectivePreview: session.goal.objective.slice(0, 120),
        queued: session.goalQueue?.length ?? 0,
      });
      try {
        handler(sessionKey);
        resumed++;
      } catch (error) {
        this.logger.error('Failed to resume active goal after restart', {
          sessionKey,
          error: (error as Error).message,
        });
      }
    }
    if (forcedIdle > 0 || repaired > 0) this.claudeHandler.saveSessions();
    if (resumed > 0 || repaired > 0) {
      this.logger.info(`Resumed ${resumed} active goal(s) after restart (repaired ${repaired} stranded queue(s))`);
    }
    return resumed;
  }

  /**
   * Auto-resume an interrupted session by sending a synthetic message
   * through the existing handleMessage pipeline.
   */
  private async autoResumeSession(
    session: { channelId: string; threadTs?: string; ownerId: string; title?: string; workflow?: string },
    notificationTs?: string,
    errorContext?: string,
  ): Promise<void> {
    // Use the notification message's ts so that handleMessage's reaction calls
    // (eyes emoji etc.) target a real Slack message instead of a fabricated timestamp.

    // Build context-rich prompt so the model knows WHAT it was doing, not just HOW to resume.
    const contextParts: string[] = [];
    if (session.title) contextParts.push(`세션 제목: ${session.title}`);
    if (session.workflow && session.workflow !== 'default') contextParts.push(`워크플로우: ${session.workflow}`);
    if (errorContext) contextParts.push(`⚠️ 이전 시도 중 오류 발생: ${errorContext}`);

    const resumePrompt =
      contextParts.length > 0
        ? `${SlackHandler.AUTO_RESUME_PROMPT}\n\n--- 중단 시점 컨텍스트 ---\n${contextParts.join('\n')}`
        : SlackHandler.AUTO_RESUME_PROMPT;

    const syntheticEvent: MessageEvent = {
      user: session.ownerId,
      channel: session.channelId,
      thread_ts: session.threadTs,
      ts: notificationTs || `${Date.now() / 1000}`,
      text: resumePrompt,
      synthetic: true,
      skipDispatch: true,
    };

    // Real say — posts to Slack. noopSay silently discarded all bot output.
    const realSay = async (args: any) => {
      const text = typeof args === 'string' ? args : args?.text;
      const result = await this.app.client.chat.postMessage({
        channel: session.channelId,
        text: text || ' ',
        thread_ts: typeof args === 'string' ? session.threadTs : args?.thread_ts || session.threadTs,
        blocks: typeof args === 'string' ? undefined : args?.blocks,
        attachments: typeof args === 'string' ? undefined : args?.attachments,
      });
      return { ts: result.ts as string | undefined };
    };

    await this.handleMessage(syntheticEvent, realSay);
  }

  /**
   * Save sessions to file before shutdown
   */
  saveSessions(): void {
    this.claudeHandler.saveSessions();
  }

  /**
   * Load pending forms from file
   */
  loadPendingForms(): number {
    return this.actionHandlers.loadPendingForms();
  }

  /**
   * Save pending forms to file before shutdown
   */
  savePendingForms(): void {
    this.actionHandlers.savePendingForms();
  }

  /** Expose SlackApiHelper for workspace URL initialization */
  getSlackApi(): SlackApiHelper {
    return this.slackApi;
  }

  /** Expose request coordinator for dashboard stop handler */
  getRequestCoordinator(): RequestCoordinator {
    return this.requestCoordinator;
  }

  /** Expose todo manager for dashboard task accessor */
  getTodoManager(): TodoManager {
    return this.todoManager;
  }

  /** Handle choice answer from dashboard — delegates to ChoiceActionHandler for full Slack UI cleanup */
  async handleDashboardChoiceAnswer(
    sessionKey: string,
    choiceId: string,
    label: string,
    question: string,
  ): Promise<void> {
    const session = this.claudeHandler.getSessionByKey(sessionKey);
    if (!session) {
      throw new Error('Session not found');
    }
    await this.actionHandlers.handleDashboardChoiceAnswer(sessionKey, choiceId, label, question, session.ownerId);
  }

  /** Handle multi-choice form submission from dashboard */
  async handleDashboardMultiChoiceAnswer(
    sessionKey: string,
    selections: Record<string, { choiceId: string; label: string }>,
  ): Promise<void> {
    const session = this.claudeHandler.getSessionByKey(sessionKey);
    if (!session) {
      throw new Error('Session not found');
    }
    await this.actionHandlers.handleDashboardMultiChoiceAnswer(sessionKey, selections, session.ownerId);
  }

  /** Handle hero "Submit All Recommended" from dashboard (group-only one-click) */
  async handleDashboardSubmitRecommended(sessionKey: string): Promise<void> {
    const session = this.claudeHandler.getSessionByKey(sessionKey);
    if (!session) {
      throw new Error('Session not found');
    }
    await this.actionHandlers.handleDashboardSubmitRecommended(sessionKey, session.ownerId);
  }

  /** Request re-render of the Slack thread header (e.g. after title change) */
  requestThreadSurfaceRender(session: ConversationSession): void {
    if (!this.threadPanel) {
      this.logger.debug('threadPanel not initialised — skipping surface render', {
        channelId: session.channelId,
        threadTs: session.threadTs,
      });
      return;
    }
    this.threadPanel.updateHeader(session).catch((err) => {
      this.logger.warn('Failed to re-render thread surface after title update', {
        error: err,
        channelId: session.channelId,
        threadTs: session.threadTs,
      });
    });
  }
}
