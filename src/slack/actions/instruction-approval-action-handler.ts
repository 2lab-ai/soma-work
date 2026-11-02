/**
 * #767 — the four buttons of the owner's DM for an instruction someone else
 * sent into their work thread: 승인 / 이 세션에서 항상 승인 / 이 사람의 지시 항상
 * 승인 / 거절.
 *
 * The click carries only `{ requestId, decision }`; the request (who asked,
 * which session, which words) is read back from the store, and the store
 * checks the clicker owns the session. The same answer path as the dashboard
 * card: either surface resolves both, and the store rewrites the DM.
 */

import type { InstructionApprovalAnswer, InstructionApprovals } from '../../instruction-approval';
import { Logger } from '../../logger';
import { parseInstructionApprovalAction } from '../instruction-approval-blocks';
import type { RespondFn } from './types';

export interface InstructionApprovalActionContext {
  /** The process-wide store (`getInstructionApprovals`); none before boot wired it. */
  getApprovals(): Pick<InstructionApprovals, 'answer'> | undefined;
}

const REFUSAL_TEXT: Record<Extract<InstructionApprovalAnswer, { ok: false }>['reason'], string> = {
  invalid: '⚠️ 이 버튼을 처리할 수 없습니다.',
  not_found: '⚠️ 이 승인 요청을 찾을 수 없습니다 — 이미 정리되었을 수 있습니다.',
  not_owner: '🚫 이 작업의 소유자만 응답할 수 있습니다.',
  already_answered: 'ℹ️ 이미 응답한 요청입니다.',
  expired: '⌛ 이미 끝난 요청입니다 — 응답 시간이 지났습니다.',
  session_gone: '⌛ 이 작업 세션이 끝나 지시를 실행할 수 없습니다.',
  unavailable: '⚠️ 지금은 처리할 수 없습니다 — 잠시 후 다시 눌러 주세요.',
};

export class InstructionApprovalActionHandler {
  private logger = new Logger('InstructionApprovalActionHandler');

  constructor(private ctx: InstructionApprovalActionContext) {}

  async handleAction(body: any, respond: RespondFn): Promise<void> {
    const parsed = parseInstructionApprovalAction(body);
    if (!parsed) {
      this.logger.warn('instr_approval: unrecognised payload');
      return;
    }
    const approvals = this.ctx.getApprovals();
    if (!approvals) {
      await this.tell(respond, REFUSAL_TEXT.unavailable);
      return;
    }
    const actor = typeof body?.user?.id === 'string' ? body.user.id : undefined;
    const result = approvals.answer({ ...parsed, actor, surface: 'slack' });
    if (result.ok) return;
    this.logger.info('instr_approval: refused', { requestId: parsed.requestId, reason: result.reason, actor });
    await this.tell(respond, REFUSAL_TEXT[result.reason]);
  }

  private async tell(respond: RespondFn, text: string): Promise<void> {
    try {
      await respond({ response_type: 'ephemeral', replace_original: false, text });
    } catch (error) {
      this.logger.warn('instr_approval: could not reply to the click', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
