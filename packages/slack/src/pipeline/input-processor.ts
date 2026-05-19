import { Logger } from '@soma/common/logger';
import type { WorkflowType } from '../action-panel-builder';
import { CommandParser } from '../command-parser';
import type { MessageEvent, ProcessedFile, SayFn } from './types';

export interface FileHandlerReader {
  downloadAndProcessFiles(files: NonNullable<MessageEvent['files']>): Promise<ProcessedFile[]>;
}

export interface CommandRouteResult {
  handled: boolean;
  continueWithPrompt?: string;
  forceWorkflow?: WorkflowType;
}

export interface CommandRouterReader {
  route(args: {
    user: string;
    channel: string;
    threadTs: string;
    text: string;
    say: SayFn;
    postEphemeral?: (msg: { text: string; blocks?: any[] }) => Promise<void>;
  }): Promise<CommandRouteResult>;
}

export interface AutoCompactSession {
  autoCompactPending?: boolean;
  pendingUserText?: string | null;
  pendingEventContext?: { channel: string; threadTs: string; user: string; ts: string } | null;
}

export interface ClaudeSessionReader {
  getSession(channel: string, threadTs: string): AutoCompactSession | undefined;
}

export interface SlackApiInputProcessor {
  postSystemMessage(channel: string, text: string, opts?: { threadTs?: string }): Promise<unknown>;
  postEphemeral(channel: string, user: string, text: string, threadTs?: string, blocks?: any[]): Promise<unknown>;
}

export interface InputProcessorDeps {
  fileHandler: FileHandlerReader;
  commandRouter: CommandRouterReader;
  // Compaction Tracking (#617): required by the AC3 auto-compact interception
  // path. Kept optional so pre-#617 tests that construct InputProcessor with
  // only fileHandler + commandRouter keep working.
  claudeHandler?: ClaudeSessionReader;
  slackApi?: SlackApiInputProcessor;
}

export interface InputProcessorProviders {
  updateUserJiraInfo?: (userId: string) => void;
}

let inputProcessorProviders: Required<InputProcessorProviders> = {
  updateUserJiraInfo: () => {},
};

export function setInputProcessorProviders(providers: InputProcessorProviders): void {
  inputProcessorProviders = {
    ...inputProcessorProviders,
    ...providers,
  };
}

/**
 * 입력 처리 (파일 다운로드, 명령어 라우팅)
 */
export class InputProcessor {
  private logger = new Logger('InputProcessor');

  constructor(private deps: InputProcessorDeps) {}

  /**
   * 파일 처리 및 입력 검증
   */
  async processFiles(event: MessageEvent, say: SayFn): Promise<{ files: ProcessedFile[]; shouldContinue: boolean }> {
    const { user, thread_ts, ts, files } = event;

    // Update user's Jira info from mapping
    inputProcessorProviders.updateUserJiraInfo(user);

    let processedFiles: ProcessedFile[] = [];
    if (files && files.length > 0) {
      this.logger.info('Processing uploaded files', { count: files.length });
      processedFiles = await this.deps.fileHandler.downloadAndProcessFiles(files);

      if (processedFiles.length > 0) {
        await say({
          text: `📎 Processing ${processedFiles.length} file(s): ${processedFiles.map((f) => f.name).join(', ')}`,
          thread_ts: thread_ts || ts,
        });
      }
    }

    // If no text and no files, nothing to process
    const shouldContinue = !!(event.text || processedFiles.length > 0);

    return { files: processedFiles, shouldContinue };
  }

  /**
   * 명령어 라우팅 체크
   */
  async routeCommand(
    event: MessageEvent,
    say: SayFn,
  ): Promise<{ handled: boolean; continueWithPrompt?: string; forceWorkflow?: WorkflowType }> {
    const { user, channel, thread_ts, ts, text } = event;

    if (!text) {
      return { handled: false };
    }

    // #617 AC3: auto-compact interception. If the previous turn's threshold
    // check flagged the session, swallow the current user message text,
    // post a short notice, and inject `/compact` via the existing
    // continueWithPrompt pipeline (event-router.ts:158-160). The original
    // user text is stashed on the session and re-dispatched by the
    // PostCompact hook / `onCompactBoundary` path — whichever fires first.
    const threadTs = thread_ts || ts;
    const session = this.deps.claudeHandler?.getSession(channel, threadTs);
    if (session?.autoCompactPending) {
      // Atomically consume the pending flag — both branches below treat the
      // pending state as resolved (compaction either runs or is bypassed),
      // and the threshold-checker is idempotent on re-set.
      session.autoCompactPending = false;

      // #952: `new` / `/new` preempts auto-compact. The user is explicitly
      // discarding the conversation, so compacting it first is wasted work
      // (compact output is thrown away on session reset) AND delays the
      // reset by an entire turn. We do NOT stash pendingUserText — there's
      // no conversation to replay after reset.
      if (CommandParser.isNewCommand(text)) {
        this.logger.info('input-processor: new command preempts pending auto-compact', {
          channel,
          threadTs,
          user,
        });
      } else {
        session.pendingUserText = text;
        session.pendingEventContext = { channel, threadTs, user, ts };

        // Notice post is decorative — fire-and-forget so Slack latency cannot
        // delay the `/compact` injection that the pipeline is about to run.
        this.deps.slackApi
          ?.postSystemMessage(channel, '🗜️ Auto-compact 실행 — 원 메시지는 compact 완료 후 재처리됩니다', { threadTs })
          .catch((err) => {
            this.logger.warn('input-processor: pending-compact notice post failed', {
              error: (err as Error)?.message ?? String(err),
            });
          });

        return { handled: true, continueWithPrompt: '/compact' };
      }
    }

    // #716: provide a closed-over postEphemeral so handlers like
    // `dashboard` can reply privately to the requester without leaking
    // credentials to the rest of the channel/thread. Falls back silently
    // if SlackApiHelper isn't injected (tests / minimal pipelines).
    const slackApi = this.deps.slackApi;
    const postEphemeral = slackApi
      ? async (msg: { text: string; blocks?: any[] }) => {
          await slackApi.postEphemeral(channel, user, msg.text, threadTs, msg.blocks);
        }
      : undefined;

    const commandResult = await this.deps.commandRouter.route({
      user,
      channel,
      threadTs,
      text,
      say,
      postEphemeral,
    });

    return {
      handled: commandResult.handled,
      continueWithPrompt: commandResult.continueWithPrompt,
      forceWorkflow: commandResult.forceWorkflow,
    };
  }
}
