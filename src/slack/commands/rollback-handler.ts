/**
 * `rollback` — roll the model's conversation context back to just before one
 * of the owner's inputs (#743). Files are not touched; only what the model
 * remembers. The next turn resumes there.
 *
 *   rollback            list the inputs you can roll back before (numbered)
 *   rollback <n>        roll back to just before input n
 *   rollback cancel     drop a rollback that has not run yet
 *
 * Korean alias: `롤백` (`롤백 3`, `롤백 취소`). The matcher is strict on purpose —
 * "rollback the migration" is an instruction for the model, not this command.
 */

import { getConversation } from '../../conversation/recorder';
import {
  CONTEXT_ROLLBACK_REFUSAL_TEXT,
  cancelContextRollback,
  keptUntilOf,
  requestContextRollback,
  rollbackInputLabel,
  rollbackInputPoints,
} from '../../session/context-rollback';
import { requestGoalStallRollback } from '../goal-stall';
import { recordSessionNotice } from '../session-notice';
import type { CommandContext, CommandDependencies, CommandHandler, CommandResult } from './types';

const ROLLBACK_RE = /^\/?(?:rollback|롤백)(?:\s+(\d{1,3}|cancel|취소|goal))?$/i;

/** How many of the latest inputs the list shows. */
export const ROLLBACK_LIST_MAX = 10;

export class RollbackHandler implements CommandHandler {
  constructor(private deps: CommandDependencies) {}

  canHandle(text: string): boolean {
    return ROLLBACK_RE.test(text.trim());
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { channel, threadTs, user } = ctx;
    const post = (text: string) => this.deps.slackApi.postSystemMessage(channel, text, { threadTs });
    const session = this.deps.claudeHandler.getSession(channel, threadTs);
    if (!session) {
      await post('💡 이 스레드에는 되돌릴 대화가 없습니다.');
      return { handled: true };
    }
    const arg = (ctx.text.trim().match(ROLLBACK_RE)?.[1] ?? '').toLowerCase();

    if (arg === 'cancel' || arg === '취소') {
      if (user !== session.ownerId) {
        await post(`⛔ ${CONTEXT_ROLLBACK_REFUSAL_TEXT['not-owner']}`);
        return { handled: true };
      }
      const had = cancelContextRollback(session);
      if (had) this.deps.claudeHandler.saveSessions();
      await post(had ? '↩️ 예약된 문맥 되돌리기를 취소했습니다.' : '💡 예약된 문맥 되돌리기가 없습니다.');
      return { handled: true };
    }

    if (arg === 'goal') {
      // #745: to where the stalled goal first failed — offered only when the repeated turns did nothing.
      const sessionKey = this.deps.claudeHandler.getSessionKey(channel, threadTs);
      const result = requestGoalStallRollback(session, user, {
        requestActive: this.deps.requestCoordinator.isRequestActive(sessionKey),
      });
      if (!result) {
        await post(
          '💡 되돌릴 goal 실패 지점이 없습니다 (goal이 같은 이유로 멈췄고, 그 사이 한 일이 없을 때만 있습니다).',
        );
        return { handled: true };
      }
      if (!result.ok) {
        await post(`⛔ ${CONTEXT_ROLLBACK_REFUSAL_TEXT[result.reason]}`);
        return { handled: true };
      }
      this.deps.claudeHandler.saveSessions();
      const notice =
        '⏪ 다음 턴부터 모델 문맥을 goal이 처음 실패한 지점으로 되돌립니다 (그 뒤의 반복된 턴이 문맥에서 빠집니다. 파일 변경은 되돌리지 않습니다). 다음 지시를 보내세요.';
      recordSessionNotice(session, notice);
      await post(notice);
      return { handled: true };
    }

    const record = session.conversationId ? await getConversation(session.conversationId) : null;
    const points = rollbackInputPoints(session, record).slice(-ROLLBACK_LIST_MAX);

    if (!arg) {
      if (points.length === 0) {
        await post(
          '💡 되돌릴 수 있는 입력이 없습니다. (첫 입력 이전으로 가려면 `new`, 문맥 압축 이전 지점은 되돌릴 수 없습니다.)',
        );
        return { handled: true };
      }
      const lines = points.map((p, i) => `${i + 1}. ${rollbackInputLabel(p.text)}`);
      const pending = session.pendingRewind ? `\n⏳ 예약됨: ${session.pendingRewind.label}` : '';
      await post(
        `⏪ *문맥 되돌리기* — 번호의 입력 *직전*으로 모델의 대화 문맥을 되돌립니다 (파일은 그대로).\n${lines.join('\n')}\n\n\`rollback <번호>\` 로 실행, \`rollback cancel\` 로 취소.${pending}`,
      );
      return { handled: true };
    }

    const n = Number(arg);
    const point = points[n - 1];
    if (!point) {
      await post(`💡 ${n}번 입력이 없습니다. \`rollback\` 으로 목록을 확인하세요.`);
      return { handled: true };
    }
    const sessionKey = this.deps.claudeHandler.getSessionKey(channel, threadTs);
    const label = `입력 직전: ${rollbackInputLabel(point.text)}`;
    const target = {
      anchor: point.anchor,
      label,
      source: 'input' as const,
      keptUntil: keptUntilOf('input', point.timestamp),
    };
    const result = requestContextRollback(session, target, user, {
      requestActive: this.deps.requestCoordinator.isRequestActive(sessionKey),
    });
    if (!result.ok) {
      await post(`⛔ ${CONTEXT_ROLLBACK_REFUSAL_TEXT[result.reason]}`);
      return { handled: true };
    }
    this.deps.claudeHandler.saveSessions();
    const dropped = points.length - (n - 1);
    const notice = `⏪ 다음 턴부터 모델 문맥을 "${rollbackInputLabel(point.text)}" 입력 직전으로 되돌립니다 (이후 입력 ${dropped}개와 그 작업이 문맥에서 빠집니다. 파일 변경은 되돌리지 않습니다). 다음 지시를 보내세요.`;
    recordSessionNotice(session, notice);
    await post(notice);
    return { handled: true };
  }
}
