import { CommandHandler, CommandContext, CommandResult } from './types.js';

/**
 * Handles the `autowork` command — starts day-based pipeline.
 * Trace: docs/turn-summary-lifecycle/trace.md, S10, Section 3a
 */
export class DayPipelineHandler implements CommandHandler {
  canHandle(text: string): boolean {
    return /^\/?autowork$/i.test(text.trim());
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    // Pipeline is executed as a continuation prompt that orchestrates skills
    const pipelinePrompt = this.buildPipelinePrompt();
    return {
      handled: true,
      continueWithPrompt: pipelinePrompt,
    };
  }

  private buildPipelinePrompt(): string {
    return `다음을 순차적으로 진행. 각 phase 완료 후 유저 확인을 받아.

## Phase day0 (버그일 경우만)
- stv:debug로 분석
- stv:new-task로 버그 Jira 티켓 생성

## Phase day1
1. Jira 이슈가 없으면 stv:new-task로 생성
2. stv:do-work로 구현
3. PR 생성
4. stv:verify → 실패 시 stv:do-work 반복 (최대 5회)
5. stv:verify 통과 → github-pr 리뷰
6. 리뷰 이슈 있으면 fix/update 워크플로우
7. 문제 없으면 머지

## Phase day2 (작업 완료 후)
1. 작업 내역 리포트 + Jira/PR 링크
2. as-is/to-be 리포트 + stv:verify + executive summary
3. 레드/그린 테스트 검증
4. llm_chat으로 codex, gemini에게 코드+테스트 커버리지 리뷰 (각각 병렬, 총 4개)
5. 리뷰 기반 수정 → stv:debug → Jira 업데이트 → PR → verify 루프 → 머지`;
  }
}
