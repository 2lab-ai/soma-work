import { CommandHandler, CommandContext, CommandResult } from './types';

/**
 * Handles the `es` command — triggers immediate executive summary.
 * Trace: docs/turn-summary-lifecycle/trace.md, S4
 */
export class EsHandler implements CommandHandler {
  canHandle(text: string): boolean {
    return /^\/?es$/i.test(text.trim());
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    // For now, return handled with continueWithPrompt that triggers summary
    // The actual SummaryService integration will be wired in the integration phase
    const summaryPrompt = `현재 active issue, pr 각각에 대해 as-is to-be 형태로 리포트
stv:verify를 해주고 active issue, pr을 종합하여 executive summary

다음 유저가 내릴만한 행동을 3개 정도 제시해줘. 각각 복사하기 쉽게 코드 블럭으로 제시`;

    return {
      handled: true,
      continueWithPrompt: summaryPrompt,
    };
  }
}
