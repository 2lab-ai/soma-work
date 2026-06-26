import type { WebClient } from '@slack/web-api';
import type { ClaudeHandler } from '../../claude-handler';
import { Logger } from '../../logger';
import { validateSessionGoalObjective } from '../../prompt/session-goal-block';
import type { ConversationSession, SessionGoal } from '../../types';
import {
  buildGoalUpdateModal,
  decodeGoalActionValue,
  extractGoalUpdateObjective,
  GOAL_UPDATE_MODAL_BLOCK_ID,
  type GoalActionValue,
} from '../goal-blocks';
import { resumeGoalLoop } from '../goal-loop-resume';
import { deleteGoalById, findGoalById, formatGoalObjectiveForSlack } from '../session-goal';
import type { SlackApiHelper } from '../slack-api-helper';
import type { RespondFn } from './types';

/** Bolt `view_submission` ack shape (see UserSkillEditViewSubmissionHandler). */
export type ViewAck = (response?: {
  response_action?: 'errors' | 'clear' | 'update' | 'push';
  errors?: Record<string, string>;
  view?: any;
}) => Promise<void> | unknown;

interface GoalActionContext {
  slackApi: SlackApiHelper;
  claudeHandler: ClaudeHandler;
}

/**
 * Services the interactive `goal` buttons:
 *   - `goal_delete:<goalId>` — delete one goal; deleting the ACTIVE goal
 *     auto-advances to the next queued goal and kicks the loop (S1).
 *   - `goal_update:<goalId>` — open an edit-box modal pre-filled with the
 *     current objective (S1); the modal submit applies the new objective.
 *   - `goal_continue_dm` / `goal_cancel_dm` — the owner-DM cap decision (S3):
 *     Continue resets the continuation counter and resumes the loop; Cancel
 *     pauses the goal.
 *
 * Owner guard: only the session owner may mutate a goal.
 */
export class GoalActionHandler {
  private logger = new Logger('GoalActionHandler');

  constructor(private ctx: GoalActionContext) {}

  /** Resolve session + decoded value with an owner guard. */
  private resolve(
    body: any,
  ): { value: GoalActionValue; session: ConversationSession; userId: string } | { error: string } {
    const userId = body.user?.id;
    const value = decodeGoalActionValue(body.actions?.[0]?.value);
    if (!userId || !value) return { error: '❌ 요청을 처리할 수 없습니다.' };
    const session = this.ctx.claudeHandler.getSessionByKey(value.sessionKey);
    if (!session) return { error: '❌ 세션을 찾을 수 없습니다. 이미 종료되었을 수 있습니다.' };
    if (session.ownerId !== userId) return { error: '❌ 세션 소유자만 goal을 변경할 수 있습니다.' };
    return { value, session, userId };
  }

  async handleDelete(body: any, respond: RespondFn): Promise<void> {
    try {
      const r = this.resolve(body);
      if ('error' in r) {
        await respond({ response_type: 'ephemeral', replace_original: false, text: r.error });
        return;
      }
      const { value, session } = r;
      const result = deleteGoalById(session, value.goalId);
      if (!result.deleted) {
        await respond({ response_type: 'ephemeral', replace_original: false, text: '⚠️ 이미 삭제된 goal입니다.' });
        return;
      }
      this.ctx.claudeHandler.saveSessions();

      if (result.wasActive && result.promoted) {
        // Auto-advance to the next queued goal and kick the loop for it.
        resumeGoalLoop(value.sessionKey);
        await respond({
          replace_original: true,
          text: `🗑️ 진행중이던 goal을 삭제하고 다음 goal로 진행합니다:\n▶️ ${formatGoalObjectiveForSlack(result.promoted.objective)}`,
        });
        return;
      }
      await respond({
        replace_original: true,
        text: result.wasActive ? '🗑️ 진행중이던 goal을 삭제했습니다. (대기중인 goal 없음)' : '🗑️ goal을 삭제했습니다.',
      });
    } catch (error) {
      this.logger.error('Error processing goal delete', error);
      await respond({
        response_type: 'ephemeral',
        replace_original: false,
        text: '❌ goal 삭제 중 오류가 발생했습니다.',
      }).catch(() => undefined);
    }
  }

  async handleUpdate(body: any, respond: RespondFn, client?: WebClient): Promise<void> {
    try {
      const r = this.resolve(body);
      if ('error' in r) {
        await respond({ response_type: 'ephemeral', replace_original: false, text: r.error });
        return;
      }
      const { value, session } = r;
      const goal = findGoalById(session, value.goalId);
      if (!goal) {
        await respond({ response_type: 'ephemeral', replace_original: false, text: '⚠️ 이미 삭제된 goal입니다.' });
        return;
      }
      const triggerId: string | undefined = body.trigger_id;
      if (!triggerId || !client) {
        this.logger.warn('goal_update: missing trigger_id or client');
        await respond({
          response_type: 'ephemeral',
          replace_original: false,
          text: '❌ 수정 창을 열 수 없습니다. 다시 시도해주세요.',
        });
        return;
      }
      await client.views.open({
        trigger_id: triggerId,
        view: buildGoalUpdateModal({ value, currentObjective: goal.objective }) as any,
      });
    } catch (error) {
      this.logger.error('goal_update: views.open failed', error);
      await respond({
        response_type: 'ephemeral',
        replace_original: false,
        text: '❌ 수정 창을 여는 중 오류가 발생했습니다.',
      }).catch(() => undefined);
    }
  }

  async handleUpdateSubmit(ack: ViewAck, body: any, _client?: WebClient): Promise<void> {
    try {
      const view = body?.view;
      const value = decodeGoalActionValue(view?.private_metadata);
      const userId = body?.user?.id;
      if (!value || !userId) {
        await ack({
          response_action: 'errors',
          errors: { [GOAL_UPDATE_MODAL_BLOCK_ID]: '메타데이터가 손상되어 저장할 수 없습니다.' },
        });
        return;
      }
      const session = this.ctx.claudeHandler.getSessionByKey(value.sessionKey);
      if (!session) {
        await ack({ response_action: 'errors', errors: { [GOAL_UPDATE_MODAL_BLOCK_ID]: '세션을 찾을 수 없습니다.' } });
        return;
      }
      if (session.ownerId !== userId) {
        await ack({ response_action: 'errors', errors: { [GOAL_UPDATE_MODAL_BLOCK_ID]: '권한이 없는 사용자입니다.' } });
        return;
      }
      const goal = findGoalById(session, value.goalId) as SessionGoal | undefined;
      if (!goal) {
        await ack({ response_action: 'errors', errors: { [GOAL_UPDATE_MODAL_BLOCK_ID]: '이미 삭제된 goal입니다.' } });
        return;
      }
      const raw = extractGoalUpdateObjective(view);
      const objective = (raw ?? '').trim();
      const validationError = validateSessionGoalObjective(objective);
      if (validationError) {
        await ack({ response_action: 'errors', errors: { [GOAL_UPDATE_MODAL_BLOCK_ID]: validationError } });
        return;
      }

      goal.objective = objective;
      goal.updatedAt = Date.now();
      // Bump the intent epoch so an in-flight completion eval for the OLD
      // objective resolves into a discard (M1). Drop the cached system prompt
      // so the new objective is injected into the next turn.
      goal.epoch = (goal.epoch ?? 0) + 1;
      session.systemPrompt = undefined;
      this.ctx.claudeHandler.saveSessions();

      await ack({ response_action: 'clear' });

      // If this is the active goal, re-drive the loop against the new objective.
      if (session.goal?.goalId === goal.goalId && goal.status === 'active') {
        resumeGoalLoop(value.sessionKey);
      }
      if (value.channel) {
        await this.ctx.slackApi
          .postSystemMessage(value.channel, `✏️ Goal 업데이트됨: ${formatGoalObjectiveForSlack(objective)}`, {
            threadTs: value.threadTs,
          })
          .catch(() => undefined);
      }
    } catch (error) {
      this.logger.error('Error processing goal update submission', error);
      await Promise.resolve(
        ack({
          response_action: 'errors',
          errors: { [GOAL_UPDATE_MODAL_BLOCK_ID]: '예상치 못한 오류로 저장에 실패했습니다.' },
        }),
      ).catch(() => undefined);
    }
  }

  async handleContinueDm(body: any, respond: RespondFn): Promise<void> {
    try {
      const value = decodeGoalActionValue(body.actions?.[0]?.value);
      const userId = body.user?.id;
      if (!value || !userId) {
        await respond({ response_type: 'ephemeral', replace_original: false, text: '❌ 요청을 처리할 수 없습니다.' });
        return;
      }
      const session = this.ctx.claudeHandler.getSessionByKey(value.sessionKey);
      const goal = session ? (findGoalById(session, value.goalId) as SessionGoal | undefined) : undefined;
      // DM is sent to the goal owner (createdBy); only they may answer.
      if (!session || !goal || goal.createdBy !== userId) {
        await respond({
          response_type: 'ephemeral',
          replace_original: false,
          text: '❌ goal 소유자만 응답할 수 있습니다.',
        });
        return;
      }
      goal.continuationCount = 0;
      goal.capDmPendingAt = undefined;
      goal.status = 'active';
      goal.updatedAt = Date.now();
      this.ctx.claudeHandler.saveSessions();
      resumeGoalLoop(value.sessionKey);
      await respond({ replace_original: true, text: '✅ goal을 계속 진행합니다.' });
    } catch (error) {
      this.logger.error('Error processing goal continue DM', error);
      await respond({
        response_type: 'ephemeral',
        replace_original: false,
        text: '❌ 처리 중 오류가 발생했습니다.',
      }).catch(() => undefined);
    }
  }

  async handleCancelDm(body: any, respond: RespondFn): Promise<void> {
    try {
      const value = decodeGoalActionValue(body.actions?.[0]?.value);
      const userId = body.user?.id;
      if (!value || !userId) {
        await respond({ response_type: 'ephemeral', replace_original: false, text: '❌ 요청을 처리할 수 없습니다.' });
        return;
      }
      const session = this.ctx.claudeHandler.getSessionByKey(value.sessionKey);
      const goal = session ? (findGoalById(session, value.goalId) as SessionGoal | undefined) : undefined;
      if (!session || !goal || goal.createdBy !== userId) {
        await respond({
          response_type: 'ephemeral',
          replace_original: false,
          text: '❌ goal 소유자만 응답할 수 있습니다.',
        });
        return;
      }
      goal.status = 'paused';
      goal.capDmPendingAt = undefined;
      goal.updatedAt = Date.now();
      this.ctx.claudeHandler.saveSessions();
      await respond({
        replace_original: true,
        text: '🛑 goal을 중단했습니다. (`goal resume`으로 다시 시작할 수 있습니다.)',
      });
    } catch (error) {
      this.logger.error('Error processing goal cancel DM', error);
      await respond({
        response_type: 'ephemeral',
        replace_original: false,
        text: '❌ 처리 중 오류가 발생했습니다.',
      }).catch(() => undefined);
    }
  }
}
