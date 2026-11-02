import type { IncidentRequest } from '../incident-contract';
import type { SdkUsageBaseline, TaskUsage } from '../session-usage-math';
import type { SayPostSwitches } from '../stream-processor';

export interface ProcessedFile {
  path: string;
  name: string;
  mimetype: string;
  isImage: boolean;
  isText: boolean;
  isVideo: boolean;
  isAudio: boolean;
  size: number;
  tempPath?: string;
  /** Slack file id and permalink — the dashboard keeps them with the user turn (user media). */
  slackFileId?: string;
  permalink?: string;
  /** The bot could not fetch the file: over the download cap, or the download failed. `path` is ''. */
  unavailable?: 'too_large' | 'download_failed';
}

export interface ConversationSession {
  channelId: string;
  threadTs?: string;
  /** A task with no Slack thread (#596): `channelId` is '' and its registry key is `task:<taskId>`. */
  slackless?: boolean;
  threadRootTs?: string;
  /**
   * Set once, at session init, from `routeContext.incidentRequest` of a
   * verified Eagle incident request (see `incident-contract.ts`). Its presence
   * makes the session incident-owned: the ingress refuses ordinary traffic in
   * that thread and the runtime restricts the turn. Never set from message
   * text, and deliberately NOT cleared by a session reset — a reset must not
   * become the way to turn a restricted session into an unrestricted one.
   */
  incidentRequest?: IncidentRequest;
  /**
   * `attempt_id` of the incident attempt the HOST observed finish. Written only
   * by the completion path — never by the model, message text, or a command —
   * and cleared when the ingress hands the session to the next attempt. Without
   * it, a retry on the same incident parent is denied.
   */
  incidentAttemptFinishedId?: string;
  actionPanel?: {
    waitingForChoice?: boolean;
    [key: string]: any;
  };
  sourceThread?: {
    channel?: string;
    threadTs?: string;
    [key: string]: any;
  };
  /** SSOT 2026-10-22 T5 — a dashboard model switch waiting for its compact (runtime-only). */
  pendingModelSwitch?: { model: string; nickname: string; requestedAt: number; compactTs?: string; armed?: boolean };
  /** Last per-model SDK running total for `sessionId` (persisted) — see `toTurnUsage`. */
  sdkUsageBaseline?: SdkUsageBaseline;
  /** What the whole task spent (persisted, never reset) — see `creditTaskSpend`. */
  taskUsage?: TaskUsage;
  [key: string]: any;
}

export interface MessageEvent {
  user: string;
  channel: string;
  /**
   * Slack workspace/team id of the originating user. Slack populates this
   * for both AppMentionEvent and GenericMessageEvent; missing only on
   * synthetic events (auto-resume, auto-retry, mid-thread injection).
   * Required by `chat.startStream` (`recipient_team_id`) — see
   * `TurnContext.recipientTeamId`.
   */
  team?: string;
  thread_ts?: string;
  ts: string;
  text?: string;
  /** True for auto-resume, auto-retry, and other system-generated messages (not real user input) */
  synthetic?: boolean;
  /**
   * Original message text BEFORE leading inline session directives
   * (`%model <v>` / `%nogoal`) were stripped by the message handler.
   * Replay stashes (channel-route halt advisory `userMessage`, auto-compact
   * `pendingUserText`) must store THIS text so a replayed message re-parses
   * the directives instead of silently losing them. Never used as dispatch
   * text for the current turn.
   */
  inlineDirectiveRawText?: string;
  /** Skip dispatch (workflow classification) entirely — transition straight to default workflow */
  skipDispatch?: boolean;
  /** Model override for cron jobs (e.g. "claude-sonnet-4-20250514"). Applied at session creation. */
  modelOverride?: string;
  /**
   * The cron job behind a scheduled fire (SSOT 2026-10-23 T1). Read only
   * together with `skipDispatch` (see `cron-origin.ts`): a session the fire
   * creates is named after the job and stamped with it.
   */
  cron?: { jobId: string; jobName: string };
  /**
   * Per-task reasoning effort (dashboard "New task", SSOT 2026-10-23 T4).
   * Applied to the session the message lands in, like `modelOverride`; an
   * unknown level is ignored and the user's default stays.
   */
  effortOverride?: string;
  /**
   * Per-task autogoal toggle (dashboard "New task", SSOT 2026-10-23 T6). When
   * set, it decides autogoal for this message instead of the sender's
   * `autoGoalEnabled` setting — in both directions. The setting is unchanged.
   */
  autoGoalOverride?: boolean;
  routeContext?: {
    skipAutoBotThread?: boolean;
    sourceChannel?: string;
    sourceThreadTs?: string;
    /**
     * True only for post-compact deferred replays (codex F2). Such a turn
     * must NEVER supersede a live request: if a real turn grabbed the slot
     * between the finally's isRequestActive check and this event reaching
     * concurrency control, the replay is RE-PARKED on the session queue
     * (the active turn's own finally replays it later), never aborted into.
     */
    compactRedispatch?: boolean;
    /**
     * True for a post-compact replay of a host turn (a synthetic event — goal
     * continuation, resume — the auto-compact intercepted or a compaction
     * parked). The replay runs through the user-message path; this only makes
     * the executor record the turn as soma-work's (`origin.by: 'system'`).
     */
    hostTurn?: boolean;
    /**
     * True only for goal auto-continuation injections. Such a turn must
     * NEVER supersede a live request: if the slot is busy when this event
     * reaches concurrency control, the continuation is dropped (the active
     * turn wins), not aborted. See `GoalLoopController` (M2).
     */
    goalContinuation?: boolean;
    /**
     * True when `text` is a `/z` command's verbatim `continueWithPrompt` (a
     * goal objective) that already went through command routing. The message
     * path dispatches it as the user's words: no second command routing, no
     * inline `%` directives, no `!` abort/steer, always a real turn. Set only
     * by the `/z` consumers (DM branch, app_mention); survives the follow-up
     * queue because stored messages are never rebuilt.
     */
    verbatimPrompt?: boolean;
    /**
     * The opening turn of the goal with this id (always together with
     * `verbatimPrompt`). Set by the host when a goal command or a dashboard
     * goal action starts a goal while it cannot dispatch directly; the message
     * path runs it only while that goal is still the ACTIVE goal — a goal
     * deleted or replaced while its opening turn waited in the follow-up queue
     * never runs. Survives the queue for the same reason as `verbatimPrompt`.
     */
    goalOpeningId?: string;
    /**
     * Present ONLY on a turn the incident ingress itself built after the
     * contract accepted it (`event-router.ts` → `evaluateIncidentIngress`).
     * Internal: it never survives a round-trip through Slack, so a message
     * body cannot forge it. `SessionInitializer` copies it onto the session.
     */
    incidentRequest?: IncidentRequest;
    /**
     * E2 ⑦ — set by the router on an original app_mention whose words are a
     * plain instruction (`isTaskEntryCandidate`): such a mention may become a
     * dashboard task (⑧). Absent everywhere else. Survives the follow-up queue.
     * A hint about the words at mention time: a queued item's text or files
     * may change later, and the host re-checks both when it acts.
     */
    taskEntryCandidate?: boolean;
    /**
     * #767 — set only by the host when the session owner approved this held
     * message once (`instruction-approval.ts`). Internal like
     * `incidentRequest`: it never survives a round-trip through Slack, and the
     * gate re-checks it against the request store (approved, this owner, this
     * sender, this very message) — a made-up id releases nothing. Survives the
     * follow-up queue so a release that had to queue still runs.
     */
    instructionApprovalId?: string;
  };
  files?: Array<{
    id: string;
    name: string;
    mimetype: string;
    filetype: string;
    url_private: string;
    url_private_download: string;
    size: number;
  }>;
}

/** `SayPostSwitches` are set only by the incident conclusion post (see stream-processor.ts). */
export type SayFn = (
  args: {
    text: string;
    thread_ts?: string;
    blocks?: any[];
    attachments?: any[];
  } & SayPostSwitches,
) => Promise<{ ts?: string }>;

export interface InputProcessResult {
  processedFiles: ProcessedFile[];
  text: string | undefined;
  shouldContinue: boolean;
}

export interface SessionInitResult {
  session: ConversationSession;
  sessionKey: string;
  isNewSession: boolean;
  userName: string;
  workingDirectory: string;
  abortController: AbortController;
  /** Set to true when channel routing advisory was shown. Caller should halt. */
  halted?: boolean;
}

export interface StreamExecuteResult {
  success: boolean;
  aborted: boolean;
  messageCount: number;
}
