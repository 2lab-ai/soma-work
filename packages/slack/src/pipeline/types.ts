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
}

export interface ConversationSession {
  channelId: string;
  threadTs?: string;
  threadRootTs?: string;
  actionPanel?: {
    waitingForChoice?: boolean;
    [key: string]: any;
  };
  sourceThread?: {
    channel?: string;
    threadTs?: string;
    [key: string]: any;
  };
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
  /** Skip dispatch (workflow classification) entirely — transition straight to default workflow */
  skipDispatch?: boolean;
  /** Model override for cron jobs (e.g. "claude-sonnet-4-20250514"). Applied at session creation. */
  modelOverride?: string;
  routeContext?: {
    skipAutoBotThread?: boolean;
    sourceChannel?: string;
    sourceThreadTs?: string;
    /**
     * True only for goal auto-continuation injections. Such a turn must
     * NEVER supersede a live request: if the slot is busy when this event
     * reaches concurrency control, the continuation is dropped (the active
     * turn wins), not aborted. See `GoalLoopController` (M2).
     */
    goalContinuation?: boolean;
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

export type SayFn = (args: {
  text: string;
  thread_ts?: string;
  blocks?: any[];
  attachments?: any[];
}) => Promise<{ ts?: string }>;

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
