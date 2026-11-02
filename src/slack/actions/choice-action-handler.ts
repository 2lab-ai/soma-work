import type { ClaudeHandler } from '../../claude-handler';
import { getInstructionApprovals } from '../../instruction-approval';
import { Logger } from '../../logger';
import type { ConversationSession, UserChoices } from '../../types';
import { ChoiceMessageBuilder } from '../choice-message-builder';
import type { CompletionMessageTracker } from '../completion-message-tracker';
import type { SlackApiHelper } from '../slack-api-helper';
import type { ThreadPanel } from '../thread-panel';
import { UserChoiceHandler } from '../user-choice-handler';
import { classifyClick, markClickAsStale } from './click-classifier';
import type { PendingFormStore } from './pending-form-store';
import type { MessageHandler, PendingChoiceFormData, SayFn } from './types';

/** Sentinel choiceId for custom text input (직접입력) */
const CUSTOM_INPUT_CHOICE_ID = '직접입력';

/** Shown on Slack when the question it answers is already being answered (on the dashboard or another click). */
const ANSWER_IN_PROGRESS_TEXT = '⏳ 이 질문은 이미 답변을 처리하고 있습니다.';

/** #767 — a single choice from someone who is not the owner waits for the owner's approval. */
const CHOICE_HELD_FOR_OWNER_TEXT = '⏳ 이 작업의 소유자가 승인하면 답이 전달됩니다 — 소유자에게 승인을 요청했습니다.';
/** #767 — a multi-question form is answered by the owner (or someone they approved) only. */
const FORM_OWNER_ONLY_TEXT =
  '🚫 이 질문은 작업 소유자(또는 소유자가 승인한 사람)만 답할 수 있습니다. 답을 스레드에 메시지로 남기면 소유자에게 승인을 요청합니다.';
export const FORM_OWNER_ONLY_ERROR = 'Only the task owner may answer this form';

/**
 * The question an answer is being given for: the session's recorded question
 * and its P3 choice record, by identity. A newer question is a new object, so
 * a hold never blocks an answer to the question asked after it.
 */
interface AnswerHold {
  question: unknown;
  choice: unknown;
  /** A Slack form chunk's hold: two chunks of one form answer different questions of it. */
  formId?: string;
}

/** What a dashboard answer took when it was claimed — what its rollback checks against. */
interface DashboardAnswerClaim {
  /** The cross-surface hold on the question. */
  hold: AnswerHold;
  /** The question the answer was for. */
  question: NonNullable<ConversationSession['actionPanel']>['pendingQuestion'];
  /** The `working` transition the claim made. */
  claimedAt: ConversationSession['activityStateChangedAt'];
}

/**
 * Can a dashboard answer reach this session's question now?
 *
 * While the session waits on it, yes. An idle session that still records the
 * question it asked — of the kind being answered — yes too: no turn runs, so
 * the answer starts the next one. The card shows such a question whenever
 * something else makes it read NEEDS YOU, most often the goal's cap decision
 * (`goalDecisionToKanban`), and refusing the answer then left the user only
 * "keep going", which ran the goal over the question (SSOT 2026-11-02). While
 * a turn runs, no: the answer would land on top of it.
 */
export function isAnswerableFromDashboard(
  session: { activityState?: string; actionPanel?: { pendingQuestion?: { type?: string } } },
  kind: 'user_choice' | 'user_choices',
): boolean {
  if (session.activityState === 'waiting') return true;
  return (session.activityState ?? 'idle') === 'idle' && session.actionPanel?.pendingQuestion?.type === kind;
}

interface ChoiceActionContext {
  slackApi: SlackApiHelper;
  claudeHandler: ClaudeHandler;
  messageHandler: MessageHandler;
  threadPanel?: ThreadPanel;
  completionMessageTracker?: CompletionMessageTracker;
}

/**
 * 사용자 선택 액션 핸들러
 */
export class ChoiceActionHandler {
  private logger = new Logger('ChoiceActionHandler');
  /**
   * One answer per question across Slack and the dashboard: the question each
   * session is being answered for right now. Both surfaces run in this one
   * handler instance, and a hold is taken synchronously before the first await.
   */
  private readonly answering = new Map<string, Set<AnswerHold>>();

  constructor(
    private ctx: ChoiceActionContext,
    private formStore: PendingFormStore,
  ) {}

  /**
   * #767 — an answer from someone who is not the session's owner (nor
   * approved for it) is an instruction like any other: it waits for the
   * owner's approval. Checked BEFORE the question is consumed, so a held
   * answer leaves the question open for the owner.
   */
  private needsOwnerApproval(session: ConversationSession | undefined, sessionKey: string, userId?: string): boolean {
    const approvals = getInstructionApprovals();
    if (!approvals || !session || !userId) return false;
    return !approvals.allows({ sessionKey, session, senderId: userId });
  }

  /** A single choice from someone else: handed to the message gate (it holds it), the question untouched. */
  private async holdChoiceForOwner(args: {
    userId: string;
    channel: string;
    threadTs?: string;
    ts: string;
    text: string;
    tellClicker: boolean;
  }): Promise<void> {
    const say = this.createSayFn(args.channel);
    await this.ctx.messageHandler(
      { user: args.userId, channel: args.channel, thread_ts: args.threadTs, ts: args.ts, text: args.text },
      say,
    );
    if (args.tellClicker) {
      await this.ctx.slackApi
        .postEphemeral(args.channel, args.userId, CHOICE_HELD_FOR_OWNER_TEXT)
        .catch(() => undefined);
    }
  }

  async handleUserChoice(body: any): Promise<void> {
    let hold: { key: string; value: AnswerHold } | undefined;
    try {
      const action = body.actions[0];
      const valueData = JSON.parse(action.value);
      const { sessionKey, choiceId, label, question, turnId: payloadTurnId } = valueData;
      const userId = body.user?.id;
      const session = this.ctx.claudeHandler.getSessionByKey(sessionKey);
      const channel = body.channel?.id || session?.channelId;
      const messageTs = body.message?.ts;
      const fallbackThreadTs = body.message?.thread_ts || messageTs;
      const threadTs = this.resolveSessionThreadTs(session, fallbackThreadTs);
      const completionMessageTs = this.resolveChoiceMessageTs(session, messageTs);

      this.logger.info('User choice selected', { sessionKey, choiceId, label, userId });

      if (channel && messageTs && this.needsOwnerApproval(session, sessionKey, userId)) {
        await this.holdChoiceForOwner({
          userId,
          channel,
          threadTs,
          ts: messageTs,
          text: String(choiceId),
          tellClicker: true,
        });
        return;
      }

      const branch = classifyClick(this.ctx.claudeHandler, { sessionKey, payloadTurnId, messageTs });

      if (branch === 'stale') {
        this.logger.info('User choice click classified as stale — marking and returning', {
          sessionKey,
          payloadTurnId,
          messageTs,
        });
        if (channel && messageTs) {
          await markClickAsStale(this.ctx.slackApi, this.logger, channel, messageTs, sessionKey);
        }
        return;
      }

      // Before the first await: the dashboard (or another click) answering this
      // same question right now makes this click a second answer.
      if (session) {
        const taken = this.holdAnswer(sessionKey, session);
        if (!taken) {
          this.logger.info('User choice refused — the question is already being answered', { sessionKey });
          if (channel && userId) await this.ctx.slackApi.postEphemeral(channel, userId, ANSWER_IN_PROGRESS_TEXT);
          return;
        }
        hold = { key: sessionKey, value: taken };
      }

      if (branch === 'p3' && session && channel) {
        const completedText = `✅ *${question}*\n선택: *${choiceId}. ${label}*`;
        const completedBlocks = [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: completedText },
          },
        ];
        const resolved = await this.ctx.threadPanel
          ?.resolveChoice(session, sessionKey, channel, completedText, completedBlocks)
          .catch((err) => {
            this.logger.warn('resolveChoice threw — falling back to legacy path', {
              sessionKey,
              error: (err as Error)?.message ?? String(err),
            });
            return false;
          });
        if (resolved) {
          await this.afterP3Resolve(session, sessionKey, channel);
          try {
            const say = this.createSayFn(channel);
            await this.ctx.messageHandler(
              { user: userId, channel, thread_ts: threadTs, ts: messageTs, text: choiceId },
              say,
            );
          } catch (handlerError) {
            this.logger.error('Choice handler failed (P3), rolling back to waiting', {
              sessionKey,
              error: handlerError,
            });
            try {
              this.ctx.claudeHandler.setActivityStateByKey(sessionKey, 'waiting');
            } catch (rollbackError) {
              this.logger.error('Failed to rollback activity state', { sessionKey, rollbackError });
            }
          }
          return;
        }
        // resolve returned false (unexpected under PHASE>=3 + matching pc) → fall through to legacy.
      }

      // 선택 메시지 업데이트 (모든 동기화 대상에 대해)
      // Immediately replace buttons to prevent double-click on other options
      if (channel) {
        const completedBlocks = [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `✅ *${question}*\n선택: *${choiceId}. ${label}*`,
            },
          },
        ];
        const targetTimestamps = this.resolveChoiceSyncMessageTs(sessionKey, messageTs, completionMessageTs);
        await Promise.all(
          targetTimestamps.map((targetTs) =>
            this.ctx.slackApi
              .updateMessage(
                channel,
                targetTs,
                `✅ *${question}*\n선택: *${choiceId}. ${label}*`,
                completedBlocks,
                [], // 기존 attachments(버튼) 제거
              )
              .catch((error: unknown) => this.logger.warn('Failed to update choice message', { targetTs, error })),
          ),
        );
        // Clear action panel choice immediately (thread header buttons)
        this.ctx.threadPanel
          ?.clearChoice(sessionKey)
          .catch((err: unknown) =>
            this.logger.debug('Failed to clear choice panel (user choice)', { sessionKey, error: err }),
          );
      }

      // 세션 확인 및 메시지 처리
      if (session) {
        // clearChoice already fired above (line 75); only clear pending question here
        // Clear pending question from session (dashboard sync)
        if (session.actionPanel) {
          session.actionPanel.pendingQuestion = undefined;
        }
        // pendingQuestion clear must persist+broadcast so dashboard restart
        // doesn't restore a stale question.
        try {
          this.ctx.claudeHandler.getSessionRegistry?.()?.persistAndBroadcast?.(sessionKey);
        } catch (err) {
          this.logger.debug('handleUserChoice: persistAndBroadcast failed', {
            sessionKey,
            error: (err as Error)?.message ?? String(err),
          });
        }
        // Delete tracked completion messages on choice selection (S8)
        if (channel) {
          const threadRootTs = session.threadRootTs;
          this.ctx.completionMessageTracker
            ?.deleteAll(
              sessionKey,
              async (ch, ts) => {
                // Defense-in-depth: never delete the thread root message (header)
                if (threadRootTs && ts === threadRootTs) {
                  this.logger.error('BLOCKED: attempted to delete thread root via completion tracker (choice)', {
                    sessionKey,
                    ts,
                    threadRootTs,
                  });
                  return;
                }
                try {
                  await this.ctx.slackApi.deleteMessage(ch, ts);
                } catch {}
              },
              channel,
            )
            .catch(() => {});
        }
        // Transition waiting→working when user responds to a choice
        this.ctx.claudeHandler.setActivityStateByKey(sessionKey, 'working');
        try {
          const say = this.createSayFn(channel);
          await this.ctx.messageHandler(
            { user: userId, channel, thread_ts: threadTs, ts: messageTs, text: choiceId },
            say,
          );
        } catch (handlerError) {
          this.logger.error('Choice handler failed, rolling back to waiting', { sessionKey, error: handlerError });
          try {
            this.ctx.claudeHandler.setActivityStateByKey(sessionKey, 'waiting');
          } catch (rollbackError) {
            this.logger.error('Failed to rollback activity state', { sessionKey, rollbackError });
          }
        }
      } else {
        this.logger.warn('Session not found for user choice', { sessionKey });
        await this.ctx.slackApi.postEphemeral(
          channel,
          userId,
          '❌ 세션을 찾을 수 없습니다. 대화가 만료되었을 수 있습니다.',
        );
      }
    } catch (error) {
      this.logger.error('Error processing user choice', error);
    } finally {
      if (hold) this.endAnswerHold(hold.key, hold.value);
    }
  }

  async handleMultiChoice(body: any): Promise<void> {
    try {
      const action = body.actions[0];
      const valueData = JSON.parse(action.value);
      const { formId, sessionKey, questionId, choiceId, label } = valueData;
      const userId = body.user?.id;
      const session = sessionKey ? this.ctx.claudeHandler.getSessionByKey(sessionKey) : undefined;
      const channel = body.channel?.id || session?.channelId;
      const messageTs = body.message?.ts;

      this.logger.info('Multi-choice selection', { formId, questionId, choiceId, label, userId });

      const pendingForm = this.formStore.get(formId);
      if (!pendingForm) {
        this.logger.warn('Pending form not found', { formId });
        await this.ctx.slackApi.postEphemeral(
          channel,
          userId,
          '❌ 폼을 찾을 수 없습니다. 시간이 만료되었을 수 있습니다.',
        );
        return;
      }

      // P3 (PHASE>=3) stale-click check. For multi, payload turnId comes from
      // the PendingFormStore entry (button values don't carry turnId for
      // multi — turnId lives on the form record).
      const branch = classifyClick(this.ctx.claudeHandler, {
        sessionKey,
        payloadTurnId: pendingForm.turnId,
        formId,
      });
      if (branch === 'stale') {
        this.logger.info('Multi-choice click classified as stale — marking and returning', {
          sessionKey,
          formId,
          questionId,
        });
        if (channel && messageTs) {
          await markClickAsStale(this.ctx.slackApi, this.logger, channel, messageTs, sessionKey);
        }
        return;
      }

      // 선택 저장
      pendingForm.selections[questionId] = { choiceId, label };

      // 폼 UI 업데이트 (자동 제출 없음 - Submit 버튼으로 제출)
      await this.updateFormUI(pendingForm, channel, messageTs);
    } catch (error) {
      this.logger.error('Error processing multi-choice selection', error);
    }
  }

  /**
   * Handle edit choice - clear selection for a question and show options again
   */
  async handleEditChoice(body: any): Promise<void> {
    try {
      const action = body.actions[0];
      const valueData = JSON.parse(action.value);
      const { formId, questionId, sessionKey } = valueData;
      const userId = body.user?.id;
      const session = sessionKey ? this.ctx.claudeHandler.getSessionByKey(sessionKey) : undefined;
      const channel = body.channel?.id || session?.channelId;
      const messageTs = body.message?.ts;

      this.logger.info('Edit choice requested', { formId, questionId, userId });

      const pendingForm = this.formStore.get(formId);
      if (!pendingForm) {
        this.logger.warn('Pending form not found for edit', { formId });
        await this.ctx.slackApi.postEphemeral(
          channel,
          userId,
          '❌ 폼을 찾을 수 없습니다. 시간이 만료되었을 수 있습니다.',
        );
        return;
      }

      // 선택 취소
      delete pendingForm.selections[questionId];

      // UI 업데이트
      await this.updateFormUI(pendingForm, channel, messageTs);
    } catch (error) {
      this.logger.error('Error processing edit choice', error);
    }
  }

  /**
   * Handle form submit - send all selections to Claude
   */
  async handleFormSubmit(body: any): Promise<void> {
    try {
      const action = body.actions[0];
      const valueData = JSON.parse(action.value);
      const { formId, sessionKey } = valueData;
      const userId = body.user?.id;
      const session = sessionKey ? this.ctx.claudeHandler.getSessionByKey(sessionKey) : undefined;
      const channel = body.channel?.id || session?.channelId;
      const messageTs = body.message?.ts;

      this.logger.info('Form submit requested', { formId, userId });

      if (this.needsOwnerApproval(session, sessionKey, userId)) {
        if (channel && userId) await this.ctx.slackApi.postEphemeral(channel, userId, FORM_OWNER_ONLY_TEXT);
        return;
      }

      const pendingForm = this.formStore.get(formId);
      if (!pendingForm) {
        this.logger.warn('Pending form not found for submit', { formId });
        await this.ctx.slackApi.postEphemeral(
          channel,
          userId,
          '❌ 폼을 찾을 수 없습니다. 시간이 만료되었을 수 있습니다.',
        );
        return;
      }

      // P3 (PHASE>=3) stale-click guard for the submit button.
      const branch = classifyClick(this.ctx.claudeHandler, {
        sessionKey,
        payloadTurnId: pendingForm.turnId,
        formId,
      });
      if (branch === 'stale') {
        this.logger.info('Form submit click classified as stale — marking and returning', {
          sessionKey,
          formId,
        });
        if (channel && messageTs) {
          await markClickAsStale(this.ctx.slackApi, this.logger, channel, messageTs, sessionKey);
        }
        return;
      }

      // The dashboard answering this question right now, or this form already
      // submitting (a second click), makes this submit a second answer.
      if (pendingForm.submitting || (session && this.questionTaken(sessionKey, session, formId))) {
        this.logger.info('Form submit refused — the question is already being answered', { sessionKey, formId });
        await this.ctx.slackApi.postEphemeral(channel, userId, ANSWER_IN_PROGRESS_TEXT);
        return;
      }

      // 모든 질문이 선택되었는지 확인
      const totalQuestions = pendingForm.questions.length;
      const answeredCount = Object.keys(pendingForm.selections).length;

      if (answeredCount !== totalQuestions) {
        await this.ctx.slackApi.postEphemeral(
          channel,
          userId,
          `❌ 아직 ${totalQuestions - answeredCount}개의 질문에 답변하지 않았습니다.`,
        );
        return;
      }

      // Before the first await: this chunk holds the question — a dashboard
      // answer to it (and a second click on this form) is refused until the
      // submit returns, past its dispatch, though the form store entry is
      // deleted on the way. Another chunk of the same form still submits.
      const hold = session ? this.holdAnswer(sessionKey, session, formId) : undefined;
      pendingForm.submitting = true;
      try {
        await this.submitMultiChoiceForm(body, pendingForm, sessionKey, channel, userId, messageTs);
      } finally {
        if (hold) this.endAnswerHold(sessionKey, hold);
        const stillOpen = this.formStore.get(formId);
        if (stillOpen) stillOpen.submitting = false;
      }
    } catch (error) {
      this.logger.error('Error processing form submit', error);
    }
  }

  /** The Slack form submit once it holds the form's submitting lock. */
  private async submitMultiChoiceForm(
    body: any,
    pendingForm: PendingChoiceFormData,
    sessionKey: string,
    channel: string,
    userId: string,
    messageTs: string,
  ): Promise<void> {
    // ── Immediately replace form with "submitting" indicator ──
    // Slack buttons cannot be disabled; replace the entire message to prevent further clicks
    if (channel && messageTs) {
      const submittingBlocks = [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: '⏳ *제출 처리 중...*' },
        },
      ];
      const immediateTargets = this.resolveChoiceSyncMessageTs(sessionKey, messageTs, pendingForm.messageTs);
      await Promise.all(
        immediateTargets.map((ts) =>
          this.ctx.slackApi
            .updateMessage(channel, ts, '⏳ 제출 처리 중...', submittingBlocks, [])
            .catch((err: unknown) => this.logger.debug('Failed to show submitting state', { ts, error: err })),
        ),
      );
    }
    // Clear action panel choice immediately (thread header buttons)
    this.ctx.threadPanel
      ?.clearChoice(sessionKey)
      .catch((err: unknown) =>
        this.logger.debug('Failed to clear choice panel (form submit)', { sessionKey, error: err }),
      );

    const fallbackThreadTs = pendingForm.threadTs || body.message?.thread_ts || messageTs;
    const sessionForThread = this.ctx.claudeHandler.getSessionByKey(sessionKey);
    const threadTs = this.resolveSessionThreadTs(sessionForThread, fallbackThreadTs);

    // 제출 처리
    await this.completeMultiChoiceForm(pendingForm, userId, channel, threadTs, messageTs);
  }

  /**
   * Handle form reset - clear all selections
   */
  async handleFormReset(body: any): Promise<void> {
    try {
      const action = body.actions[0];
      const valueData = JSON.parse(action.value);
      const { formId, sessionKey } = valueData;
      const userId = body.user?.id;
      const session = sessionKey ? this.ctx.claudeHandler.getSessionByKey(sessionKey) : undefined;
      const channel = body.channel?.id || session?.channelId;
      const messageTs = body.message?.ts;

      this.logger.info('Form reset requested', { formId, userId });

      const pendingForm = this.formStore.get(formId);
      if (!pendingForm) {
        this.logger.warn('Pending form not found for reset', { formId });
        await this.ctx.slackApi.postEphemeral(
          channel,
          userId,
          '❌ 폼을 찾을 수 없습니다. 시간이 만료되었을 수 있습니다.',
        );
        return;
      }

      // 모든 선택 초기화
      pendingForm.selections = {};

      // UI 업데이트
      await this.updateFormUI(pendingForm, channel, messageTs);

      await this.ctx.slackApi.postEphemeral(channel, userId, '🗑️ 모든 선택이 초기화되었습니다.');
    } catch (error) {
      this.logger.error('Error processing form reset', error);
    }
  }

  /**
   * Update form UI with current selections
   */
  private async updateFormUI(pendingForm: PendingChoiceFormData, channel: string, messageTs: string): Promise<void> {
    const choicesData: UserChoices = {
      type: 'user_choices',
      questions: pendingForm.questions,
    };

    const updatedPayload = UserChoiceHandler.buildMultiChoiceFormBlocks(
      choicesData,
      pendingForm.formId,
      pendingForm.sessionKey,
      pendingForm.selections,
    );

    const targetMessageTs = this.resolveChoiceSyncMessageTs(pendingForm.sessionKey, messageTs, pendingForm.messageTs);
    for (const targetTs of targetMessageTs) {
      try {
        await this.ctx.slackApi.updateMessage(
          channel,
          targetTs,
          '📋 선택이 필요합니다',
          undefined,
          updatedPayload.attachments,
        );
      } catch (error) {
        this.logger.warn('Failed to update form UI', { targetTs, error });
      }
    }

    await this.ctx.threadPanel?.attachChoice(pendingForm.sessionKey, updatedPayload, pendingForm.messageTs);
  }

  async completeMultiChoiceForm(
    pendingForm: PendingChoiceFormData,
    userId: string,
    channel: string,
    threadTs: string | undefined,
    messageTs: string,
  ): Promise<void> {
    this.logger.info('All multi-choice selections complete', {
      formId: pendingForm.formId,
      selections: pendingForm.selections,
    });

    const responses = pendingForm.questions.map((q) => {
      const sel = pendingForm.selections[q.id];
      if (sel.choiceId === CUSTOM_INPUT_CHOICE_ID) {
        return `${q.question}: (직접입력) ${sel.label}`;
      }
      return `${q.question}: ${sel.choiceId}. ${sel.label}`;
    });
    const combinedMessage = responses.join('\n');

    const completedText = `✅ *모든 선택 완료*\n\n${responses.map((r, i) => `${i + 1}. ${r}`).join('\n')}`;
    const completedBlocks = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: completedText },
      },
    ];

    const session = this.ctx.claudeHandler.getSessionByKey(pendingForm.sessionKey);
    const resolvedThreadTs = this.resolveSessionThreadTs(session, threadTs);

    // P3 (PHASE>=3) — submit is per-chunk (handleFormSubmit only validates
    // the submitted form's questions). Resolve only THIS chunk's messageTs
    // in place. Remove this chunk's formId from pendingChoice.formIds; only
    // when the last chunk is submitted does pendingChoice fully clear.
    // Other chunks remain live so the user can answer them independently
    // (matches legacy per-chunk semantics; prevents codex-flagged bug where
    // submitting chunk 1 would clear chunks 2..N as "completed" while they
    // were still unanswered).
    const pc = session?.actionPanel?.pendingChoice;
    const canUseP3 =
      !!session && !!this.ctx.threadPanel && !!pc && pc.kind === 'multi' && pc.turnId === pendingForm.turnId;

    if (canUseP3 && session && channel && pc && pendingForm.messageTs) {
      // Slack update: mark ONLY this chunk's message done.
      try {
        await this.ctx.slackApi.updateMessage(channel, pendingForm.messageTs, '✅ 모든 선택 완료', completedBlocks, []);
      } catch (err) {
        this.logger.warn('P3 per-chunk resolve: updateMessage failed', {
          sessionKey: pendingForm.sessionKey,
          formId: pendingForm.formId,
          error: (err as Error)?.message ?? String(err),
        });
      }

      // Remove this chunk from pendingChoice.formIds (and the formStore entry).
      this.formStore.delete(pendingForm.formId);
      const remainingFormIds = pc.formIds.filter((fId) => fId !== pendingForm.formId);
      if (session.actionPanel) {
        if (remainingFormIds.length === 0) {
          // Last chunk submitted — clear the whole pending record.
          session.actionPanel.pendingChoice = undefined;
          session.actionPanel.choiceMessageTs = undefined;
          session.actionPanel.choiceMessageLink = undefined;
          session.actionPanel.waitingForChoice = false;
          session.actionPanel.choiceBlocks = undefined;
        } else {
          // Chunks still outstanding — shrink formIds, keep pendingChoice live.
          session.actionPanel.pendingChoice = {
            ...pc,
            formIds: remainingFormIds,
          };
        }
      }

      // afterP3Resolve handles the single persistAndBroadcast for both the
      // formIds shrink/clear above and the pendingQuestion clear below.
      await this.afterP3Resolve(session, pendingForm.sessionKey, channel);
      try {
        const say = this.createSayFn(channel);
        await this.ctx.messageHandler(
          { user: userId, channel, thread_ts: resolvedThreadTs, ts: messageTs, text: combinedMessage },
          say,
        );
      } catch (handlerError) {
        this.logger.error('Multi-choice handler failed (P3), rolling back to waiting', {
          sessionKey: pendingForm.sessionKey,
          error: handlerError,
        });
        try {
          this.ctx.claudeHandler.setActivityStateByKey(pendingForm.sessionKey, 'waiting');
        } catch (rollbackError) {
          this.logger.error('Failed to rollback activity state', {
            sessionKey: pendingForm.sessionKey,
            rollbackError,
          });
        }
      }
      return;
    }

    this.formStore.delete(pendingForm.formId);

    const completionMessageTs = pendingForm.messageTs || messageTs;

    const targetTimestamps = this.resolveChoiceSyncMessageTs(pendingForm.sessionKey, messageTs, completionMessageTs);
    for (const targetTs of targetTimestamps) {
      try {
        await this.ctx.slackApi.updateMessage(
          channel,
          targetTs,
          '✅ 모든 선택 완료',
          completedBlocks,
          [], // 기존 attachments(버튼 폼) 제거
        );
      } catch (error) {
        this.logger.warn('Failed to update completed form', { targetTs, error });
      }
    }

    // Claude에 전송
    if (session) {
      // clearChoice already fired in handleFormSubmit; only clear pending question here
      if (session.actionPanel) {
        session.actionPanel.pendingQuestion = undefined;
      }
      // pendingQuestion clear must persist+broadcast (dashboard restart parity).
      try {
        this.ctx.claudeHandler.getSessionRegistry?.()?.persistAndBroadcast?.(pendingForm.sessionKey);
      } catch (err) {
        this.logger.debug('completeMultiChoiceForm: persistAndBroadcast failed', {
          sessionKey: pendingForm.sessionKey,
          error: (err as Error)?.message ?? String(err),
        });
      }
      // Delete tracked completion messages on form submission (S8)
      if (channel) {
        const formThreadRootTs = session.threadRootTs;
        this.ctx.completionMessageTracker
          ?.deleteAll(
            pendingForm.sessionKey,
            async (ch, ts) => {
              // Defense-in-depth: never delete the thread root message (header)
              if (formThreadRootTs && ts === formThreadRootTs) {
                this.logger.error('BLOCKED: attempted to delete thread root via completion tracker (form)', {
                  sessionKey: pendingForm.sessionKey,
                  ts,
                  threadRootTs: formThreadRootTs,
                });
                return;
              }
              try {
                await this.ctx.slackApi.deleteMessage(ch, ts);
              } catch {}
            },
            channel,
          )
          .catch(() => {});
      }
      // Transition waiting→working when user submits form
      this.ctx.claudeHandler.setActivityStateByKey(pendingForm.sessionKey, 'working');
      try {
        const say = this.createSayFn(channel);
        await this.ctx.messageHandler(
          { user: userId, channel, thread_ts: resolvedThreadTs, ts: messageTs, text: combinedMessage },
          say,
        );
      } catch (handlerError) {
        this.logger.error('Multi-choice handler failed, rolling back to waiting', {
          sessionKey: pendingForm.sessionKey,
          error: handlerError,
        });
        try {
          this.ctx.claudeHandler.setActivityStateByKey(pendingForm.sessionKey, 'waiting');
        } catch (rollbackError) {
          this.logger.error('Failed to rollback activity state', {
            sessionKey: pendingForm.sessionKey,
            rollbackError,
          });
        }
      }
    } else {
      this.logger.warn('Session not found for multi-choice completion', { sessionKey: pendingForm.sessionKey });
      await this.ctx.slackApi.postEphemeral(
        channel,
        userId,
        '❌ 세션을 찾을 수 없습니다. 대화가 만료되었을 수 있습니다.',
      );
    }
  }

  /**
   * Hero "Submit All Recommended" button click (Slack).
   *
   * Behavior matrix (driven by N/M counts encoded in the button value):
   *   - blocked variant (action_id contains `_blocked_`) → ephemeral notice, no submit
   *   - active variant + all questions have a recommendation → fill missing selections
   *     (preserving any existing user picks) and call completeMultiChoiceForm
   *   - active variant + partial recommendations → fill what we can, update UI, ask user
   *     to finish the rest manually
   *
   * Lock relies on synchronous `formStore.set` of `submitting=true` BEFORE the await
   * boundary inside completeMultiChoiceForm; do not refactor formStore.set to async
   * without revisiting the cross-surface (Slack ↔ dashboard) race.
   */
  async handleSubmitAllRecommended(body: any): Promise<void> {
    try {
      const action = body.actions?.[0];
      if (!action || typeof action.value !== 'string') {
        this.logger.warn('Hero submit-all-recommended: missing action payload');
        return;
      }
      const valueData = JSON.parse(action.value);
      const { formId, sessionKey, n: heroN, m: heroM } = valueData;
      const userId = body.user?.id;
      const session = sessionKey ? this.ctx.claudeHandler.getSessionByKey(sessionKey) : undefined;
      const channel = body.channel?.id || session?.channelId;
      const messageTs = body.message?.ts;
      const isBlocked = typeof action.action_id === 'string' && action.action_id.includes('_blocked_');

      if (this.needsOwnerApproval(session, sessionKey, userId)) {
        if (channel && userId) await this.ctx.slackApi.postEphemeral(channel, userId, FORM_OWNER_ONLY_TEXT);
        return;
      }

      if (isBlocked) {
        this.logger.info('hero_recommended_blocked', {
          surface: 'slack',
          n: heroN,
          m: heroM,
          sessionKey,
          formId,
        });
        if (channel && userId) {
          await this.ctx.slackApi.postEphemeral(
            channel,
            userId,
            `🔒 추천이 ${heroN}/${heroM}개만 있어 일괄 처리 불가. 직접 선택해주세요.`,
          );
        }
        return;
      }

      this.logger.info('hero_recommended_clicked', {
        surface: 'slack',
        n: heroN,
        m: heroM,
        sessionKey,
        formId,
      });

      // Cross-surface lock part 1: session activityState gate
      if (session && session.activityState !== 'waiting') {
        if (channel && userId) {
          await this.ctx.slackApi.postEphemeral(channel, userId, '⚠️ 세션이 응답 대기 중이 아닙니다.');
        }
        return;
      }

      const pendingForm = this.formStore.get(formId);
      if (!pendingForm) {
        if (channel && userId) {
          await this.ctx.slackApi.postEphemeral(
            channel,
            userId,
            '❌ 폼을 찾을 수 없습니다. 시간이 만료되었을 수 있습니다.',
          );
        }
        return;
      }

      if (pendingForm.submitting) {
        if (channel && userId) {
          await this.ctx.slackApi.postEphemeral(channel, userId, '⏳ 이미 제출 처리 중입니다.');
        }
        return;
      }

      // The dashboard answering this question right now makes this a second answer.
      if (session && this.questionTaken(sessionKey, session, formId)) {
        if (channel && userId) await this.ctx.slackApi.postEphemeral(channel, userId, ANSWER_IN_PROGRESS_TEXT);
        return;
      }

      // P3 (PHASE>=3) stale-click guard for the hero button.
      const heroBranch = classifyClick(this.ctx.claudeHandler, {
        sessionKey,
        payloadTurnId: pendingForm.turnId,
        formId,
      });
      if (heroBranch === 'stale') {
        this.logger.info('Hero submit-all click classified as stale — marking and returning', {
          sessionKey,
          formId,
        });
        if (channel && messageTs) {
          await markClickAsStale(this.ctx.slackApi, this.logger, channel, messageTs, sessionKey);
        }
        return;
      }

      // Partial-fill loop: preserve existing user selections, fill only unanswered+recommended.
      for (const q of pendingForm.questions) {
        if (pendingForm.selections[q.id]) continue;
        const rid = ChoiceMessageBuilder.resolveRecommendedId(q.recommendedChoiceId, q.choices);
        if (!rid || rid === CUSTOM_INPUT_CHOICE_ID) continue;
        const choice = q.choices.find((c) => c.id === rid);
        if (!choice) continue;
        pendingForm.selections[q.id] = { choiceId: choice.id, label: choice.label };
      }

      const answeredCount = Object.keys(pendingForm.selections).length;
      const totalCount = pendingForm.questions.length;

      if (answeredCount === totalCount) {
        // Held until the submit returns, as a form submit's chunk hold is.
        const hold = session ? this.holdAnswer(sessionKey, session, formId) : undefined;
        try {
          pendingForm.submitting = true;
          this.formStore.set(formId, pendingForm);
          const fallbackThreadTs = pendingForm.threadTs || body.message?.thread_ts || messageTs;
          const sessionForThread = this.ctx.claudeHandler.getSessionByKey(sessionKey);
          const threadTs = this.resolveSessionThreadTs(sessionForThread, fallbackThreadTs);
          await this.completeMultiChoiceForm(pendingForm, userId, channel, threadTs, messageTs);
        } catch (error) {
          // Reset submitting so user can retry. Form may have been deleted by complete()
          // on the success path — guard the read.
          const stillExists = this.formStore.get(formId);
          if (stillExists) {
            stillExists.submitting = false;
            this.formStore.set(formId, stillExists);
          }
          throw error;
        } finally {
          if (hold) this.endAnswerHold(sessionKey, hold);
        }
      } else {
        // Partial fill: refresh UI, then nudge user.
        await this.updateFormUI(pendingForm, channel, messageTs);
        if (channel && userId) {
          await this.ctx.slackApi.postEphemeral(
            channel,
            userId,
            `✏️ ${totalCount - answeredCount}개는 직접 선택해주세요.`,
          );
        }
      }
    } catch (error) {
      this.logger.error('Error processing hero submit-all-recommended', error);
    }
  }

  /**
   * Hero "Submit All Recommended" from dashboard.
   *
   * Dashboard variant only allows full-recommendations submission (the dashboard UI
   * disables the button when N < M). Cross-surface lock: refuses if any Slack form
   * for this session is mid-submit.
   */
  async handleSubmitRecommendedFromDashboard(sessionKey: string, userId: string): Promise<void> {
    const session = this.ctx.claudeHandler.getSessionByKey(sessionKey);
    if (!session) {
      throw new Error('Session not found');
    }
    if (this.needsOwnerApproval(session, sessionKey, userId)) throw new Error(FORM_OWNER_ONLY_ERROR);
    if (!isAnswerableFromDashboard(session, 'user_choices')) {
      throw new Error('Session is not waiting for a choice');
    }

    const pendingQ = session.actionPanel?.pendingQuestion;
    if (!pendingQ || pendingQ.type !== 'user_choices' || !pendingQ.questions) {
      throw new Error('Session has no pending multi-choice question');
    }

    // Cross-surface lock: any in-flight Slack form for this session blocks.
    const sessionForms = this.formStore.getFormsBySession(sessionKey);
    for (const [, f] of sessionForms) {
      if (f.submitting) {
        throw new Error('Submission in progress');
      }
    }

    // Build selections from per-question recommendations.
    const selections: Record<string, { choiceId: string; label: string }> = {};
    let validCount = 0;
    for (const q of pendingQ.questions) {
      const rid = ChoiceMessageBuilder.resolveRecommendedId(q.recommendedChoiceId, q.choices);
      if (!rid || rid === CUSTOM_INPUT_CHOICE_ID) continue;
      const choice = q.choices.find((c: { id: string; label: string }) => c.id === rid);
      if (!choice) continue;
      selections[q.id] = { choiceId: choice.id, label: choice.label };
      validCount++;
    }

    if (validCount === 0) {
      throw new Error('No recommendation available');
    }
    if (validCount !== pendingQ.questions.length) {
      // Dashboard surface only supports full-fill (the blocked button is disabled client-side).
      throw new Error('Recommendations incomplete');
    }

    this.logger.info('hero_recommended_clicked', {
      surface: 'dashboard',
      n: validCount,
      m: pendingQ.questions.length,
      sessionKey,
    });

    // Reuse the existing dashboard multi-choice flow (validation, UI cleanup, Claude dispatch).
    await this.handleMultiChoiceFromDashboard(sessionKey, selections, userId);
  }

  /**
   * Handle choice selection from the dashboard (same logic as Slack button click).
   * Updates Slack messages, clears thread header, transitions state, and sends choice to Claude.
   */
  async handleChoiceFromDashboard(
    sessionKey: string,
    choiceId: string,
    label: string,
    question: string,
    userId: string,
  ): Promise<void> {
    const session = this.ctx.claudeHandler.getSessionByKey(sessionKey);
    if (!session) {
      throw new Error('Session not found');
    }

    // Guard: only process while the session's question can take an answer
    if (
      isAnswerableFromDashboard(session, 'user_choice') &&
      session.channelId &&
      this.needsOwnerApproval(session, sessionKey, userId)
    ) {
      // #767 — held for the owner like the Slack button; the question stays open.
      await this.holdChoiceForOwner({
        userId,
        channel: session.channelId,
        threadTs: session.threadRootTs || session.threadTs,
        ts: String(Date.now() / 1000),
        text: String(choiceId),
        tellClicker: false,
      });
      return;
    }
    if (!isAnswerableFromDashboard(session, 'user_choice')) {
      this.logger.warn('Dashboard choice ignored — session not in waiting state', {
        sessionKey,
        activityState: session.activityState,
        choiceId,
      });
      throw new Error('Session is not waiting for a choice');
    }

    // Validate choiceId against actual pending choices to prevent arbitrary input reaching Claude
    const pendingQ = session.actionPanel?.pendingQuestion;
    if (pendingQ && pendingQ.type === 'user_choice' && pendingQ.choices) {
      const validIds = pendingQ.choices.map((c: { id: string }) => c.id);
      if (!validIds.includes(choiceId)) {
        this.logger.warn('Dashboard choice rejected — invalid choiceId', { sessionKey, choiceId, validIds });
        throw new Error('Invalid choice ID');
      }
    }

    this.logger.info('Dashboard choice selected', { sessionKey, choiceId, label, userId });
    // Before the first await: a second submission finds the question taken.
    const claim = this.claimDashboardAnswer(session, sessionKey);
    try {
      await this.sendDashboardChoice(session, sessionKey, claim, choiceId, label, question, userId);
    } finally {
      this.endAnswerHold(sessionKey, claim.hold);
    }
  }

  /** The dashboard single-choice answer once it holds the question. */
  private async sendDashboardChoice(
    session: ConversationSession,
    sessionKey: string,
    claim: DashboardAnswerClaim,
    choiceId: string,
    label: string,
    question: string,
    userId: string,
  ): Promise<void> {
    const channel = session.channelId;
    const threadTs = this.resolveSessionThreadTs(session, session.threadTs);
    const choiceMessageTs = session.actionPanel?.choiceMessageTs;

    // P3 (PHASE>=3) — when a pendingChoice exists, route through resolveChoice.
    // Dashboard payloads don't carry turnId, but pc.turnId always matches itself,
    // so the classifier returns 'p3' whenever pc exists under PHASE>=3.
    const pcSingle = session.actionPanel?.pendingChoice;
    const canUseDashboardP3 = !!this.ctx.threadPanel && !!pcSingle && pcSingle.kind === 'single';
    if (canUseDashboardP3 && channel) {
      const completedText = `✅ *${question}*\n선택: *${choiceId}. ${label}* _(대시보드)_`;
      const completedBlocks = [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: completedText },
        },
      ];
      const resolved = await this.ctx
        .threadPanel!.resolveChoice(session, sessionKey, channel, completedText, completedBlocks)
        .catch((err) => {
          this.logger.warn('resolveChoice (dashboard) threw — falling back to legacy path', {
            sessionKey,
            error: (err as Error)?.message ?? String(err),
          });
          return false;
        });
      if (resolved) {
        try {
          await this.afterP3Resolve(session, sessionKey, channel);
          const say = this.createSayFn(channel);
          await this.ctx.messageHandler(
            { user: userId, channel, thread_ts: threadTs, ts: String(Date.now() / 1000), text: choiceId },
            say,
          );
        } catch (error) {
          this.logger.error('Error processing dashboard choice (P3)', { sessionKey, choiceId, error });
          this.releaseDashboardAnswer(session, sessionKey, claim);
          throw error;
        }
        return;
      }
      // Fall through to legacy path.
    }

    try {
      // Update Slack choice messages with selection confirmation
      const completedBlocks = [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `✅ *${question}*\n선택: *${choiceId}. ${label}* _(대시보드)_`,
          },
        },
      ];
      const targetTimestamps = this.resolveChoiceSyncMessageTs(sessionKey, choiceMessageTs, choiceMessageTs);
      for (const targetTs of targetTimestamps) {
        try {
          await this.ctx.slackApi.updateMessage(
            channel,
            targetTs,
            `✅ *${question}*\n선택: *${choiceId}. ${label}* (대시보드)`,
            completedBlocks,
            [],
          );
        } catch (error) {
          this.logger.warn('Failed to update choice message from dashboard', { targetTs, error });
        }
      }

      // Clear thread header choice + pending question
      await this.ctx.threadPanel?.clearChoice(sessionKey);
      if (session.actionPanel) {
        session.actionPanel.pendingQuestion = undefined;
      }
      try {
        this.ctx.claudeHandler.getSessionRegistry?.()?.persistAndBroadcast?.(sessionKey);
      } catch (err) {
        this.logger.debug('handleChoiceFromDashboard: persistAndBroadcast failed', {
          sessionKey,
          error: (err as Error)?.message ?? String(err),
        });
      }

      // Delete tracked completion messages
      if (channel) {
        const threadRootTs = session.threadRootTs;
        this.ctx.completionMessageTracker
          ?.deleteAll(
            sessionKey,
            async (ch, ts) => {
              if (threadRootTs && ts === threadRootTs) {
                this.logger.error(
                  'BLOCKED: attempted to delete thread root via completion tracker (dashboard choice)',
                  {
                    sessionKey,
                    ts,
                    threadRootTs,
                  },
                );
                return;
              }
              try {
                await this.ctx.slackApi.deleteMessage(ch, ts);
              } catch (deleteError) {
                this.logger.warn('Failed to delete completion message (dashboard choice)', {
                  sessionKey,
                  ts,
                  error: deleteError,
                });
              }
            },
            channel,
          )
          .catch((deleteAllError) => {
            this.logger.warn('Failed to delete all completion messages (dashboard choice)', {
              sessionKey,
              error: deleteAllError,
            });
          });
      }

      // The session is already `working` (the claim above).
      // Send choiceId as user message to Claude
      const say = this.createSayFn(channel);
      await this.ctx.messageHandler(
        { user: userId, channel, thread_ts: threadTs, ts: String(Date.now() / 1000), text: choiceId },
        say,
      );
    } catch (error) {
      this.logger.error('Error processing dashboard choice', { sessionKey, choiceId, error });
      this.releaseDashboardAnswer(session, sessionKey, claim);
      throw error;
    }
  }

  /**
   * Handle multi-choice form submission from the dashboard.
   * Validates all selections, builds combined response, updates Slack, and sends to Claude.
   */
  async handleMultiChoiceFromDashboard(
    sessionKey: string,
    selections: Record<string, { choiceId: string; label: string }>,
    userId: string,
  ): Promise<void> {
    const session = this.ctx.claudeHandler.getSessionByKey(sessionKey);
    if (!session) {
      throw new Error('Session not found');
    }
    if (this.needsOwnerApproval(session, sessionKey, userId)) throw new Error(FORM_OWNER_ONLY_ERROR);

    if (!isAnswerableFromDashboard(session, 'user_choices')) {
      this.logger.warn('Dashboard multi-choice ignored — session not in waiting state', {
        sessionKey,
        activityState: session.activityState,
      });
      throw new Error('Session is not waiting for a choice');
    }

    const pendingQ = session.actionPanel?.pendingQuestion;
    if (!pendingQ || pendingQ.type !== 'user_choices' || !pendingQ.questions) {
      throw new Error('Session has no pending multi-choice question');
    }

    // Validate all questions are answered
    const questions = pendingQ.questions;
    for (const q of questions) {
      const sel = selections[q.id];
      if (!sel || !sel.choiceId || !sel.label) {
        throw new Error(`Missing answer for question: ${q.id}`);
      }
      // Validate choiceId against actual choices (skip for custom input)
      if (sel.choiceId !== CUSTOM_INPUT_CHOICE_ID) {
        const validIds = q.choices.map((c: { id: string }) => c.id);
        if (!validIds.includes(sel.choiceId)) {
          this.logger.warn('Dashboard multi-choice rejected — invalid choiceId', {
            sessionKey,
            questionId: q.id,
            choiceId: sel.choiceId,
            validIds,
          });
          throw new Error('Invalid choice ID');
        }
      }
    }

    const channel = session.channelId;
    const threadTs = this.resolveSessionThreadTs(session, session.threadTs);

    this.logger.info('Dashboard multi-choice submitted', {
      sessionKey,
      selectionCount: Object.keys(selections).length,
      questionIds: Object.keys(selections),
      userId,
    });

    // A Slack form of this question submitting right now makes this a second answer.
    for (const [, form] of this.formStore.getFormsBySession(sessionKey)) {
      if (form.submitting) throw new Error('Session is not waiting for a choice');
    }

    // Before the first await: a second submission finds the question taken.
    const claim = this.claimDashboardAnswer(session, sessionKey);
    try {
      // Build combined response text once (shared between P3 + legacy paths)
      const responses = questions.map((q: { id: string; question: string }) => {
        const sel = selections[q.id];
        if (sel.choiceId === CUSTOM_INPUT_CHOICE_ID) {
          return `${q.question}: (직접입력) ${sel.label}`;
        }
        return `${q.question}: ${sel.choiceId}. ${sel.label}`;
      });
      const combinedMessage = responses.join('\n');
      const dashboardCompletedText = `✅ *모든 선택 완료* _(대시보드)_\n${responses.map((r: string, i: number) => `${i + 1}. ${r}`).join('\n')}`;
      const dashboardCompletedBlocks = [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: dashboardCompletedText },
        },
      ];

      // P3 (PHASE>=3) — route through resolveMultiChoice when pendingChoice is
      // a multi record. Dashboard payloads don't carry turnId, but pc.turnId
      // always matches itself.
      const pcMulti = session.actionPanel?.pendingChoice;
      const canUseDashboardMultiP3 = !!this.ctx.threadPanel && !!pcMulti && pcMulti.kind === 'multi';
      if (canUseDashboardMultiP3 && channel) {
        const tsList: string[] = [];
        for (const fId of pcMulti!.formIds) {
          const form = this.formStore.get(fId);
          if (form?.messageTs) tsList.push(form.messageTs);
        }
        const resolved = await this.ctx
          .threadPanel!.resolveMultiChoice(
            session,
            sessionKey,
            channel,
            tsList,
            dashboardCompletedText,
            dashboardCompletedBlocks,
          )
          .catch((err) => {
            this.logger.warn('resolveMultiChoice (dashboard) threw — falling back to legacy', {
              sessionKey,
              error: (err as Error)?.message ?? String(err),
            });
            return false;
          });
        if (resolved) {
          // Invalidate any pending Slack forms for this session
          const sessionForms = this.formStore.getFormsBySession(sessionKey);
          for (const [formId] of sessionForms) {
            this.formStore.delete(formId);
          }
          try {
            await this.afterP3Resolve(session, sessionKey, channel);
            const say = this.createSayFn(channel);
            await this.ctx.messageHandler(
              { user: userId, channel, thread_ts: threadTs, ts: String(Date.now() / 1000), text: combinedMessage },
              say,
            );
          } catch (error) {
            this.logger.error('Error processing dashboard multi-choice (P3)', { sessionKey, error });
            this.releaseDashboardAnswer(session, sessionKey, claim);
            throw error;
          }
          return;
        }
        // Fall through to legacy path.
      }

      try {
        // Update Slack form messages with completion
        const completedBlocks = dashboardCompletedBlocks;

        // Try to update the Slack form message(s)
        const choiceMessageTs = session.actionPanel?.choiceMessageTs;
        const targetTimestamps = this.resolveChoiceSyncMessageTs(sessionKey, choiceMessageTs, choiceMessageTs);
        for (const targetTs of targetTimestamps) {
          try {
            await this.ctx.slackApi.updateMessage(
              channel,
              targetTs,
              `✅ 모든 선택 완료 (대시보드)\n${responses.join('\n')}`,
              completedBlocks,
              [],
            );
          } catch (error) {
            this.logger.warn('Failed to update multi-choice message from dashboard', { targetTs, error });
          }
        }

        // Clear thread header (non-critical — don't abort submission on failure)
        try {
          await this.ctx.threadPanel?.clearChoice(sessionKey);
        } catch (clearError) {
          this.logger.warn('Failed to clear thread panel choice (dashboard multi-choice)', {
            sessionKey,
            error: clearError,
          });
        }
        if (session.actionPanel) {
          session.actionPanel.pendingQuestion = undefined;
        }
        try {
          this.ctx.claudeHandler.getSessionRegistry?.()?.persistAndBroadcast?.(sessionKey);
        } catch (err) {
          this.logger.debug('handleMultiChoiceFromDashboard: persistAndBroadcast failed', {
            sessionKey,
            error: (err as Error)?.message ?? String(err),
          });
        }

        // Delete tracked completion messages
        if (channel) {
          const threadRootTs = session.threadRootTs;
          this.ctx.completionMessageTracker
            ?.deleteAll(
              sessionKey,
              async (ch, ts) => {
                if (threadRootTs && ts === threadRootTs) {
                  this.logger.error(
                    'BLOCKED: attempted to delete thread root via completion tracker (dashboard multi-choice)',
                    { sessionKey, ts, threadRootTs },
                  );
                  return;
                }
                try {
                  await this.ctx.slackApi.deleteMessage(ch, ts);
                } catch (deleteError) {
                  this.logger.warn('Failed to delete completion message (dashboard multi-choice)', {
                    sessionKey,
                    ts,
                    error: deleteError,
                  });
                }
              },
              channel,
            )
            .catch((deleteAllError) => {
              this.logger.warn('Failed to delete all completion messages (dashboard multi-choice)', {
                sessionKey,
                error: deleteAllError,
              });
            });
        }

        // Invalidate any pending Slack forms for this session
        const sessionForms = this.formStore.getFormsBySession(sessionKey);
        for (const [formId] of sessionForms) {
          this.formStore.delete(formId);
        }

        // The session is already `working` (the claim above).
        // Send combined response to Claude
        const say = this.createSayFn(channel);
        await this.ctx.messageHandler(
          { user: userId, channel, thread_ts: threadTs, ts: String(Date.now() / 1000), text: combinedMessage },
          say,
        );
      } catch (error) {
        this.logger.error('Error processing dashboard multi-choice', { sessionKey, error });
        this.releaseDashboardAnswer(session, sessionKey, claim);
        throw error;
      }
    } finally {
      this.endAnswerHold(sessionKey, claim.hold);
    }
  }

  /**
   * Take a dashboard answer: the session moves to `working` before the
   * handler's first await, so a second submission of the same question —
   * a double click, or the card and the recommended button together — finds
   * it taken and is refused, instead of both answers running.
   */
  private claimDashboardAnswer(session: ConversationSession, sessionKey: string): DashboardAnswerClaim {
    // The dashboard answers only the question it shows: a recorded one, not
    // already being answered (by a Slack click, a form, or another submission).
    const hold = session.actionPanel?.pendingQuestion ? this.holdAnswer(sessionKey, session) : undefined;
    if (!hold) {
      this.logger.info('Dashboard answer refused — no question to answer, or it is already being answered', {
        sessionKey,
      });
      throw new Error('Session is not waiting for a choice');
    }
    this.ctx.claudeHandler.setActivityStateByKey(sessionKey, 'working');
    return { hold, question: session.actionPanel?.pendingQuestion, claimedAt: session.activityStateChangedAt };
  }

  /**
   * Is the session's current question being answered right now — by anything
   * that is not another chunk of the same Slack form (`formId`)?
   */
  private questionTaken(sessionKey: string, session: ConversationSession, formId?: string): boolean {
    const holds = this.answering.get(sessionKey);
    if (!holds) return false;
    const panel = session.actionPanel;
    for (const held of holds) {
      const sameQuestion =
        (held.question !== undefined && held.question === panel?.pendingQuestion) ||
        (held.choice !== undefined && held.choice === panel?.pendingChoice);
      if (!sameQuestion) continue;
      if (formId !== undefined && held.formId !== undefined && held.formId !== formId) continue;
      return true;
    }
    return false;
  }

  /**
   * Take a hold on the session's current question; undefined when it is
   * already taken. Held until the answer's handler returns — past its dispatch
   * handoff, whatever its Slack cleanup deletes on the way.
   */
  private holdAnswer(sessionKey: string, session: ConversationSession, formId?: string): AnswerHold | undefined {
    if (this.questionTaken(sessionKey, session, formId)) return undefined;
    const hold: AnswerHold = {
      question: session.actionPanel?.pendingQuestion,
      choice: session.actionPanel?.pendingChoice,
      ...(formId !== undefined ? { formId } : {}),
    };
    const holds = this.answering.get(sessionKey) ?? new Set<AnswerHold>();
    holds.add(hold);
    this.answering.set(sessionKey, holds);
    return hold;
  }

  private endAnswerHold(sessionKey: string, hold: AnswerHold): void {
    const holds = this.answering.get(sessionKey);
    if (!holds) return;
    holds.delete(hold);
    if (holds.size === 0) this.answering.delete(sessionKey);
  }

  /**
   * Give a dashboard answer back after its send failed: the question returns,
   * the session waits on it again, and both are saved so a restart keeps them.
   *
   * Only while nothing moved past the answer. A turn that ran on it moves the
   * session off the claim's `working` (its end settles idle or waiting, and a
   * later turn's start is a new transition); a newer recorded question means
   * the model asked again. Either way the answer was used, and offering it
   * again would run it twice — the newer state stays.
   */
  private releaseDashboardAnswer(session: ConversationSession, sessionKey: string, claim: DashboardAnswerClaim): void {
    const panel = session.actionPanel;
    const untouched = session.activityState === 'working' && session.activityStateChangedAt === claim.claimedAt;
    const newerQuestion = panel?.pendingQuestion !== undefined && panel.pendingQuestion !== claim.question;
    if (!untouched || newerQuestion) {
      this.logger.info('Dashboard answer not given back — a turn already ran on it', {
        sessionKey,
        activityState: session.activityState,
        newerQuestion,
      });
      return;
    }
    try {
      if (panel && claim.question) panel.pendingQuestion = claim.question;
      this.ctx.claudeHandler.setActivityStateByKey(sessionKey, 'waiting');
      this.ctx.claudeHandler.getSessionRegistry?.()?.persistAndBroadcast?.(sessionKey);
    } catch (rollbackError) {
      this.logger.error('Failed to give a dashboard answer back', { sessionKey, rollbackError });
    }
  }

  private createSayFn(channel: string): SayFn {
    return async (args: any) => {
      const msgArgs = typeof args === 'string' ? { text: args } : args;
      return this.ctx.slackApi.postMessage(channel, msgArgs.text, {
        threadTs: msgArgs.thread_ts,
        blocks: msgArgs.blocks,
        attachments: msgArgs.attachments,
      });
    };
  }

  private resolveSessionThreadTs(session: any, fallbackThreadTs: string | undefined): string | undefined {
    return session?.threadRootTs || session?.threadTs || fallbackThreadTs;
  }

  private resolveChoiceMessageTs(session: any, fallbackMessageTs: string | undefined): string | undefined {
    return session?.actionPanel?.choiceMessageTs || fallbackMessageTs;
  }

  private resolveChoiceSyncMessageTs(
    sessionKey: string,
    sourceMessageTs: string | undefined,
    threadMessageTs: string | undefined,
  ): string[] {
    const session = this.ctx.claudeHandler.getSessionByKey(sessionKey);
    const targets = new Set<string>();

    if (sourceMessageTs) {
      targets.add(sourceMessageTs);
    }
    if (threadMessageTs) {
      targets.add(threadMessageTs);
    }
    if (session?.actionPanel?.choiceMessageTs) {
      targets.add(session.actionPanel.choiceMessageTs);
    }

    return [...targets];
  }

  /**
   * Common "click resolved" terminus (P3 single + multi path). Clears the
   * pendingQuestion, persists+broadcasts, transitions waiting→working, then
   * deletes tracked completion messages. Caller dispatches to messageHandler
   * after this returns.
   */
  private async afterP3Resolve(session: any, sessionKey: string, channel: string | undefined): Promise<void> {
    if (session.actionPanel) {
      session.actionPanel.pendingQuestion = undefined;
    }
    try {
      this.ctx.claudeHandler.getSessionRegistry?.()?.persistAndBroadcast?.(sessionKey);
    } catch (err) {
      this.logger.debug('afterP3Resolve: persistAndBroadcast failed', {
        sessionKey,
        error: (err as Error)?.message ?? String(err),
      });
    }
    if (channel) {
      const threadRootTs = session.threadRootTs;
      this.ctx.completionMessageTracker
        ?.deleteAll(
          sessionKey,
          async (ch, ts) => {
            if (threadRootTs && ts === threadRootTs) {
              this.logger.error('BLOCKED: attempted to delete thread root via completion tracker (P3 choice)', {
                sessionKey,
                ts,
                threadRootTs,
              });
              return;
            }
            try {
              await this.ctx.slackApi.deleteMessage(ch, ts);
            } catch {}
          },
          channel,
        )
        .catch(() => {});
    }
    this.ctx.claudeHandler.setActivityStateByKey(sessionKey, 'working');
  }
}
