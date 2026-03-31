import type { FileHandler, ProcessedFile } from '../../file-handler';
import { Logger } from '../../logger';
import type { WorkflowType } from '../../types';
import { userSettingsStore } from '../../user-settings-store';
import type { CommandRouter } from '../commands';
import { InputProcessResult, type MessageEvent, type SayFn } from './types';

interface InputProcessorDeps {
  fileHandler: FileHandler;
  commandRouter: CommandRouter;
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

    const commandResult = await this.deps.commandRouter.route({
      user,
      channel,
      threadTs: thread_ts || ts,
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
