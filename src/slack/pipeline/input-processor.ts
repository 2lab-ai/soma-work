import type { ClaudeHandler } from '../../claude-handler';
import type { FileHandler, ProcessedFile } from '../../file-handler';
import { Logger } from '../../logger';
import type { WorkflowType } from '../../types';
import { userSettingsStore } from '../../user-settings-store';
import type { CommandRouter } from '../commands';
import type { SlackApiHelper } from '../slack-api-helper';
import { InputProcessResult, type MessageEvent, type SayFn } from './types';

interface InputProcessorDeps {
  fileHandler: FileHandler;
  commandRouter: CommandRouter;
  // Compaction Tracking (#617): required by the AC3 auto-compact interception
  // path. Kept optional so pre-#617 tests that construct InputProcessor with
  // only fileHandler + commandRouter keep working.
  claudeHandler?: ClaudeHandler;
  slackApi?: SlackApiHelper;
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
    userSettingsStore.updateUserJiraInfo(user);

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
      session.autoCompactPending = false;
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

    const commandResult = await this.deps.commandRouter.route({
      user,
      channel,
      threadTs,
      text,
      say,
    });

    return {
      handled: commandResult.handled,
      continueWithPrompt: commandResult.continueWithPrompt,
      forceWorkflow: commandResult.forceWorkflow,
    };
  }
}
