import { escapeSlackMrkdwn } from '@soma/slack/mrkdwn-escape';
import { isAdminUser } from '../../admin-utils';
import type { ClaudeHandler } from '../../claude-handler';
import { getInstructionApprovals } from '../../instruction-approval';
import { Logger } from '../../logger';
import type { ConversationSession, UserChoice, UserChoices } from '../../types';
import { userSettingsStore } from '../../user-settings-store';
import { ChoiceMessageBuilder } from '../choice-message-builder';
import type { CompletionMessageTracker } from '../completion-message-tracker';
import type { SlackApiHelper } from '../slack-api-helper';
import type { ThreadPanel } from '../thread-panel';
import { UserChoiceHandler } from '../user-choice-handler';
import { AnswerNotKeptError } from './answer-not-kept';
import { classifyClick, markClickAsStale } from './click-classifier';
import type { PendingFormStore } from './pending-form-store';
import type { MessageEvent, MessageHandler, PendingChoiceFormData, SayFn } from './types';

/** Sentinel choiceId for custom text input (직접입력) */
const CUSTOM_INPUT_CHOICE_ID = '직접입력';

/** Shown on Slack when the question it answers is already being answered (on the dashboard or another click). */
const ANSWER_IN_PROGRESS_TEXT = '⏳ 이 질문은 이미 답변을 처리하고 있습니다.';

/**
 * #1474 — shown on Slack for a click on a question already answered, while its card still shows the buttons (the
 * answer's edit waits in Slack's line).
 */
const ANSWER_TAKEN_TEXT = '✅ 이 질문은 이미 답변을 받았습니다 — 카드는 곧 갱신됩니다.';

/** #1474 — a legacy card clicked when no question is open on the session: the question it asked was answered. */
const NO_OPEN_QUESTION_TEXT = '✅ 이 질문은 이미 답변되었거나 더 이상 열려 있지 않습니다.';

/** #1474 — how long an answered card or form is remembered: far past any Slack lag the edit could wait in. */
const ANSWERED_MARK_TTL_MS = 6 * 60 * 60 * 1000;

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

/** What a dashboard answer took when it was claimed: its hold on the question, released when the answer returns. */
interface DashboardAnswerClaim {
  hold: AnswerHold;
}

/**
 * #1474 — what an answer took off the session (`ChoiceActionHandler.recordAnswer`), kept so a hand-on that failed can
 * give the question back as it was.
 */
interface TakenQuestion {
  /** The session's activity clock right after the record: unmoved = no turn started or ended since. */
  recordedAt: ConversationSession['activityStateChangedAt'];
  /** The session's state when the answer came: `idle` for a question recorded on an idle session (a goal decision). */
  activityState: ConversationSession['activityState'];
  /** A chunk answer of a split form: the forms it answered (a give-back returns only these to the record). */
  chunk: string[] | undefined;
  question: NonNullable<ConversationSession['actionPanel']>['pendingQuestion'];
  choice: NonNullable<ConversationSession['actionPanel']>['pendingChoice'];
  openBit: boolean | undefined;
  choiceMessageTs: string | undefined;
  choiceMessageLink: string | undefined;
  choiceBlocks: NonNullable<ConversationSession['actionPanel']>['choiceBlocks'];
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

/**
 * #1474 — nothing on the session waits for an answer: no recorded question, no open bit, no choice record. The record
 * is saved with the session, so this holds across a restart (the remembered answered cards do not).
 */
function nothingOpen(session: ConversationSession): boolean {
  const panel = session.actionPanel;
  return !panel?.pendingQuestion && panel?.waitingForChoice !== true && !panel?.pendingChoice;
}

/**
 * #1070 — an admin answering a question the model asked for admins (`audience: 'admins'`): the answer is the
 * admin's to give, so it is not held for the session owner.
 */
export function isAdminAudienceAnswer(
  session: { actionPanel?: { pendingQuestion?: { type?: string; audience?: string } } },
  userId: string | undefined,
): boolean {
  const q = session.actionPanel?.pendingQuestion;
  return !!userId && q?.type === 'user_choice' && q.audience === 'admins' && isAdminUser(userId);
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
  /**
   * #1474 — the Slack messages and forms of questions already answered (`${sessionKey}|${ts or formId}` → when), for
   * as long as their buttons may still be pressed. The record takes a question off the session at once, but its card
   * loses the buttons only when Slack's line reaches the edit — on a busy host an hour later (#1470). A click in
   * between is a second answer that nothing on the session tells apart any more: a P3 click would read stale and
   * mark the answered card invalid, a legacy click would answer again. Forgotten when the answer is given back.
   */
  private readonly answered = new Map<string, number>();

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

      if (await this.refuseAnswered(sessionKey, channel, userId, messageTs)) return;

      if (channel && messageTs && this.needsOwnerApproval(session, sessionKey, userId)) {
        await this.holdChoiceForOwner({
          userId,
          channel,
          threadTs,
          // Its own ts, not the question's: a second answer (or a second person) is its own held item.
          ts: String(Date.now() / 1000),
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

      // #1474 — a legacy card (no turn on its buttons) answers the question open on the session, or nothing: with no
      // question, bit or record left, the question it asked was answered (the record survives a restart; the
      // remembered cards do not) — a click now would be a second answer (round 3, astra).
      if (session && branch === 'legacy' && nothingOpen(session)) {
        this.logger.info('Legacy choice click refused — no question is open on the session', { sessionKey });
        await this.tellNothingOpen(channel, userId);
        return;
      }

      // Before the first await: the dashboard (or another click) answering this
      // same question right now makes this click a second answer.
      if (session) {
        const heldAnswer = this.holdAnswer(sessionKey, session);
        if (!heldAnswer) {
          this.logger.info('User choice refused — the question is already being answered', { sessionKey });
          if (channel && userId) await this.ctx.slackApi.postEphemeral(channel, userId, ANSWER_IN_PROGRESS_TEXT);
          return;
        }
        hold = { key: sessionKey, value: heldAnswer };
        const completedText = `✅ *${question}*\n선택: *${choiceId}. ${label}*`;
        const completedBlocks = [{ type: 'section', text: { type: 'mrkdwn', text: completedText } }];
        // The messages the card shows the question in — read before the record takes the choice off the session.
        const targets = channel ? this.resolveChoiceSyncMessageTs(sessionKey, messageTs, completionMessageTs) : [];
        // #1474 — recorded, then handed on, then drawn (answerQuestion).
        try {
          await this.answerQuestion({
            session,
            sessionKey,
            channel,
            event: { user: userId, channel, thread_ts: threadTs, ts: messageTs, text: choiceId, questionAnswer: true },
            card: { targets, text: completedText, blocks: completedBlocks },
          });
        } catch (handlerError) {
          this.logger.error('Choice handler failed', { sessionKey, error: handlerError });
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

      if (await this.refuseAnswered(sessionKey, channel, userId, formId, messageTs)) return;

      if (this.needsOwnerApproval(session, sessionKey, userId)) {
        // #767 — someone else may not change the owner's form: the owner would submit their answer as their own.
        if (channel && userId) await this.ctx.slackApi.postEphemeral(channel, userId, FORM_OWNER_ONLY_TEXT);
        return;
      }

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

      if (await this.refuseAnswered(sessionKey, channel, userId, formId, messageTs)) return;

      if (this.needsOwnerApproval(session, sessionKey, userId)) {
        // #767 — someone else may not change the owner's form: the owner would submit their answer as their own.
        if (channel && userId) await this.ctx.slackApi.postEphemeral(channel, userId, FORM_OWNER_ONLY_TEXT);
        return;
      }

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

      if (await this.refuseAnswered(sessionKey, channel, userId, formId, messageTs)) return;

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

  /**
   * The Slack form submit once it holds the form's submitting lock. #1474 — no Slack write comes first: the form is
   * recorded and handed on (`completeMultiChoiceForm` → `answerQuestion`) before any await, and its messages are
   * drawn as answered alongside. The lock (`submitting`) and the hold already refuse a second click.
   */
  private async submitMultiChoiceForm(
    body: any,
    pendingForm: PendingChoiceFormData,
    sessionKey: string,
    channel: string,
    userId: string,
    messageTs: string,
  ): Promise<void> {
    const fallbackThreadTs = pendingForm.threadTs || body.message?.thread_ts || messageTs;
    const sessionForThread = this.ctx.claudeHandler.getSessionByKey(sessionKey);
    const threadTs = this.resolveSessionThreadTs(sessionForThread, fallbackThreadTs);
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

      if (await this.refuseAnswered(sessionKey, channel, userId, formId, messageTs)) return;

      if (this.needsOwnerApproval(session, sessionKey, userId)) {
        // #767 — someone else may not change the owner's form: the owner would submit their answer as their own.
        if (channel && userId) await this.ctx.slackApi.postEphemeral(channel, userId, FORM_OWNER_ONLY_TEXT);
        return;
      }

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
      // #1474 — answered while an earlier edit waited: the rest would draw the answered form open again (round 4, grok).
      if (!this.formStore.get(pendingForm.formId) || this.wasAnswered(pendingForm.sessionKey, pendingForm.formId)) return;
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

    // #1474 — answered while the edits above waited in Slack's line (the dashboard, another chunk's last submit): the
    // form is gone, and attaching it would raise the answered question's open bit again (round 3, astra).
    if (!this.formStore.get(pendingForm.formId) || this.wasAnswered(pendingForm.sessionKey, pendingForm.formId)) return;
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
    const completedBlocks = [{ type: 'section', text: { type: 'mrkdwn', text: completedText } }];

    const sessionKey = pendingForm.sessionKey;
    const session = this.ctx.claudeHandler.getSessionByKey(sessionKey);
    const resolvedThreadTs = this.resolveSessionThreadTs(session, threadTs);

    // P3 (PHASE>=3) — a form split into chunks: each chunk is submitted on its own, and only the LAST one answers
    // the question (codex-flagged: submitting chunk 1 must not end chunks 2..N). This chunk's own message is drawn;
    // while others remain, the record shrinks and the question stays open (#1474: the open bit goes down only when
    // the question is answered).
    const pc = session?.actionPanel?.pendingChoice;
    const chunked = !!pc && pc.kind === 'multi' && pc.turnId === pendingForm.turnId;
    const remainingFormIds = chunked ? pc.formIds.filter((fId) => fId !== pendingForm.formId) : [];
    const remainingChoice = chunked && remainingFormIds.length > 0 ? { ...pc, formIds: remainingFormIds } : undefined;
    const targets = chunked
      ? pendingForm.messageTs
        ? [pendingForm.messageTs]
        : []
      : this.resolveChoiceSyncMessageTs(sessionKey, messageTs, pendingForm.messageTs || messageTs);

    if (!session) {
      this.formStore.delete(pendingForm.formId);
      // Nothing to answer on: the form's messages still lose their buttons.
      for (const targetTs of targets) {
        await this.ctx.slackApi
          .updateMessage(channel, targetTs, '✅ 모든 선택 완료', completedBlocks, [])
          .catch((error: unknown) => this.logger.warn('Failed to update completed form', { targetTs, error }));
      }
      return;
    }

    // #1474 — recorded, then handed on, then drawn (answerQuestion); a failed hand-on gives the question back, and
    // the form with it.
    try {
      await this.answerQuestion({
        session,
        sessionKey,
        channel,
        event: {
          user: userId,
          channel,
          thread_ts: resolvedThreadTs,
          ts: messageTs,
          text: combinedMessage,
          questionAnswer: true,
        },
        remainingChoice,
        chunk: chunked,
        card: { targets, text: '✅ 모든 선택 완료', blocks: completedBlocks },
        forms: [pendingForm],
      });
    } catch (handlerError) {
      this.logger.error('Multi-choice handler failed', { sessionKey, error: handlerError });
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

      if (await this.refuseAnswered(sessionKey, channel, userId, formId, messageTs)) return;

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
    /**
     * #1070 — from the 관리자 승인 card: an admin answering a question asked for admins. `onClaimed` runs once
     * the question is taken for this answer, before the turn it starts (which can run for minutes).
     */
    opts: { adminAnswer?: boolean; onClaimed?: () => void } = {},
  ): Promise<void> {
    const session = this.ctx.claudeHandler.getSessionByKey(sessionKey);
    if (!session) {
      throw new Error('Session not found');
    }
    // Re-checked here, not trusted from the caller: an admin, and the question is the admins' to answer.
    const adminAnswer = opts.adminAnswer === true && isAdminAudienceAnswer(session, userId);
    if (opts.adminAnswer && !adminAnswer) throw new Error('Not an admin question');

    // Guard: only process while the session's question can take an answer
    if (
      !adminAnswer &&
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
        text: choiceId === CUSTOM_INPUT_CHOICE_ID ? label : String(choiceId),
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

    // Validate choiceId against actual pending choices to prevent arbitrary input reaching Claude.
    // #917 — the direct-input sentinel is the question's last option: its label is the user's own answer.
    const pendingQ = session.actionPanel?.pendingQuestion;
    if (choiceId !== CUSTOM_INPUT_CHOICE_ID && pendingQ && pendingQ.type === 'user_choice' && pendingQ.choices) {
      const validIds = pendingQ.choices.map((c: { id: string }) => c.id);
      if (!validIds.includes(choiceId)) {
        this.logger.warn('Dashboard choice rejected — invalid choiceId', { sessionKey, choiceId, validIds });
        throw new Error('Invalid choice ID');
      }
    }

    this.logger.info('Dashboard choice selected', { sessionKey, choiceId, label, userId });
    // Before the first await: a second submission finds the question taken.
    const claim = this.claimDashboardAnswer(session, sessionKey);
    opts.onClaimed?.();
    try {
      await this.sendDashboardChoice(session, sessionKey, choiceId, label, question, userId, adminAnswer);
    } finally {
      this.endAnswerHold(sessionKey, claim.hold);
    }
  }

  /** The dashboard single-choice answer once it holds the question. */
  private async sendDashboardChoice(
    session: ConversationSession,
    sessionKey: string,
    choiceId: string,
    label: string,
    question: string,
    userId: string,
    adminAnswer = false,
  ): Promise<void> {
    // #1070 — an admin's answer runs as the session's owner (their session, their permissions); the thread names
    // the admin who answered. It is the owner's turn, so the owner gate has nothing to hold.
    const turnUser = adminAnswer && session.ownerId ? session.ownerId : userId;
    const via = adminAnswer ? `대시보드 · <@${userId}>` : '대시보드';
    const channel = session.channelId;
    const threadTs = this.resolveSessionThreadTs(session, session.threadTs);
    const choiceMessageTs = session.actionPanel?.choiceMessageTs;
    // #917 — direct input: the user's own words are the turn (not an id), and the thread shows them as such.
    const own = choiceId === CUSTOM_INPUT_CHOICE_ID;
    const answer = own ? label : choiceId;
    // #1070 — the model sees who answered: the owner's turn carries the admin who decided (a Slack-button answer
    // to the same question, from the thread, carries no such line).
    const turnText = adminAnswer ? `${answer}\n\n(관리자 <@${userId}>가 대시보드 관리자 승인에서 답함)` : answer;
    const picked = own
      ? `직접 입력: _${escapeSlackMrkdwn(label.substring(0, 200))}${label.length > 200 ? '...' : ''}_`
      : `선택: *${choiceId}. ${label}*`;

    const completedText = `✅ *${question}*\n${picked} _(${via})_`;
    const completedBlocks = [{ type: 'section', text: { type: 'mrkdwn', text: completedText } }];
    // The card's messages, read before the record takes the choice off the session (the P3 record's own message
    // is among them: its choiceTs is the choice message).
    const pcSingle = session.actionPanel?.pendingChoice;
    const targets = this.resolveChoiceSyncMessageTs(
      sessionKey,
      pcSingle?.kind === 'single' ? pcSingle.choiceTs : choiceMessageTs,
      choiceMessageTs,
    );
    // #1474 — recorded, then handed on, then drawn (answerQuestion); a failed hand-on gives the question back.
    try {
      await this.answerQuestion({
        session,
        sessionKey,
        channel,
        event: {
          user: turnUser,
          channel,
          thread_ts: threadTs,
          ts: String(Date.now() / 1000),
          text: turnText,
          questionAnswer: true,
        },
        card: { targets, text: completedText, blocks: completedBlocks },
      });
    } catch (error) {
      this.logger.error('Error processing dashboard choice', { sessionKey, choiceId, error });
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

    // #1474 — a split form some chunks of which were answered from Slack: only the chunks still open are the question
    // now. Those answered are not asked, checked or sent again (round 4, astra).
    const questions = this.openQuestionsOf(session, pendingQ.questions);
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

      // The form's messages, read before the record takes the choice off the session: the P3 record's chunks (their
      // forms' messages) and the legacy choice message.
      const pcMulti = session.actionPanel?.pendingChoice;
      const choiceMessageTs = session.actionPanel?.choiceMessageTs;
      // A chunk answered from Slack before is drawn already: it is not drawn (nor remembered) again (round 3, astra).
      const targets = this.resolveChoiceSyncMessageTs(sessionKey, choiceMessageTs, choiceMessageTs).filter(
        (ts) => !this.wasAnswered(sessionKey, ts),
      );
      if (pcMulti?.kind === 'multi') {
        for (const fId of pcMulti.formIds) {
          const form = this.formStore.get(fId);
          if (form?.messageTs && !targets.includes(form.messageTs)) targets.push(form.messageTs);
        }
      }
      // The whole question is answered here: every Slack form of it is done (and comes back with a given-back answer).
      const forms = [...this.formStore.getFormsBySession(sessionKey).values()];
      // #1474 — recorded, then handed on, then drawn (answerQuestion); a failed hand-on gives the question back.
      try {
        await this.answerQuestion({
          session,
          sessionKey,
          channel,
          event: {
            user: userId,
            channel,
            thread_ts: threadTs,
            ts: String(Date.now() / 1000),
            text: combinedMessage,
            questionAnswer: true,
          },
          card: { targets, text: dashboardCompletedText, blocks: dashboardCompletedBlocks },
          forms,
        });
      } catch (error) {
        this.logger.error('Error processing dashboard multi-choice', { sessionKey, error });
        throw error;
      }
    } finally {
      this.endAnswerHold(sessionKey, claim.hold);
    }
  }

  /**
   * #1474 — the questions of a multi-choice still to answer: with a P3 record of a split form, those of the chunks it
   * still holds (their forms); otherwise all of them.
   */
  private openQuestionsOf<Q extends { id: string }>(session: ConversationSession, questions: Q[]): Q[] {
    const record = session.actionPanel?.pendingChoice;
    if (record?.kind !== 'multi') return questions;
    const open = new Set<string>();
    for (const formId of record.formIds) {
      const form = this.formStore.get(formId);
      if (!form) return questions; // a form we cannot read: ask everything, as before
      for (const q of form.questions) open.add(q.id);
    }
    const left = questions.filter((q) => open.has(q.id));
    return left.length > 0 ? left : questions;
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
    // #1474 — the record itself (open bit down, question off, `working`) is `answerQuestion`'s, which the caller
    // reaches with no await in between.
    return { hold };
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
  /**
   * #1474 — a typed answer to a single question (직접 입력, `FormActionHandler`): taken like a button's — held,
   * recorded, handed on, then drawn. A question already being answered refuses it.
   */
  async answerWithText(args: {
    sessionKey: string;
    channel: string;
    threadTs: string | undefined;
    messageTs: string;
    userId: string;
    text: string;
    completedText: string;
    completedBlocks: any[];
  }): Promise<void> {
    const { sessionKey, channel, messageTs, userId } = args;
    const session = this.ctx.claudeHandler.getSessionByKey(sessionKey);
    const targets = channel
      ? this.resolveChoiceSyncMessageTs(sessionKey, messageTs, this.resolveChoiceMessageTs(session, messageTs))
      : [];
    if (!session) {
      for (const targetTs of targets) {
        await this.ctx.slackApi
          .updateMessage(channel, targetTs, args.completedText, args.completedBlocks, [])
          .catch((error: unknown) => this.logger.warn('Failed to update choice message', { targetTs, error }));
      }
      return;
    }
    // #1474 — as a legacy button: a typed answer with no question open on the session answers nothing (round 4, fable).
    if (nothingOpen(session)) {
      this.logger.info('Typed answer refused — no question is open on the session', { sessionKey });
      await this.tellNothingOpen(channel, userId);
      return;
    }
    const hold = this.holdAnswer(sessionKey, session);
    if (!hold) {
      this.logger.info('Typed answer refused — the question is already being answered', { sessionKey });
      if (channel && userId) await this.ctx.slackApi.postEphemeral(channel, userId, ANSWER_IN_PROGRESS_TEXT);
      return;
    }
    try {
      await this.answerQuestion({
        session,
        sessionKey,
        channel,
        event: {
          user: userId,
          channel,
          thread_ts: this.resolveSessionThreadTs(session, args.threadTs),
          ts: messageTs,
          text: args.text,
          questionAnswer: true,
        },
        card: { targets, text: args.completedText, blocks: args.completedBlocks },
      });
    } catch (handlerError) {
      this.logger.error('Typed answer failed', { sessionKey, error: handlerError });
    } finally {
      this.endAnswerHold(sessionKey, hold);
    }
  }

  /**
   * #1474 — answer the session's open question: record it, hand it on, then draw it.
   *
   * 1. Record, before any await (`recordAnswer`): the question stops being open and leaves the session, and the
   *    session reads `working`. A turn that asked and ends from here reads it answered, so its run does not settle
   *    `blocked: awaiting user choice` and lock the line again. A chunk of a form whose other chunks are still to
   *    answer keeps the question open (`remainingChoice`). The card's messages and the forms are remembered as
   *    answered (a second click on them is refused) and the forms leave the store.
   * 2. Hand on, at once: the answer goes to the pipeline — into the queue behind a running turn, in the order it was
   *    given, or as the next turn. It does not wait for its Slack edits: Slack's one line ran an hour behind on a busy
   *    host (#1470), and an answer that waited there was in no queue, while the line behind it could move on.
   * 3. Draw: the card's edits start before the hand-on, so they keep their place in Slack's line ahead of what the
   *    answer's turn posts, and are awaited after it. Drawing never changes the session: a question asked after this
   *    answer is never taken down by it.
   *
   * A hand-on that throws gives the question back (`giveBackQuestion`) — with its forms, its card drawn open again
   * behind the answered drawing — and rethrows. A second answer to a card or form already answered is refused at the
   * Slack entries, before their click classification (`refuseAnswered`); the dashboard needs the question on the
   * session (`claimDashboardAnswer`).
   */
  async answerQuestion(args: {
    session: ConversationSession;
    sessionKey: string;
    channel: string | undefined;
    event: MessageEvent;
    /** The card's messages (what is remembered as answered) and how they read once answered. */
    card: { targets: string[]; text: string; blocks: any[] };
    /** The Slack forms this answer takes (they leave the store, and come back if the answer is given back). */
    forms?: PendingChoiceFormData[];
    /** A chunk of a form whose other chunks are still to answer: the choice record that remains open. */
    remainingChoice?: NonNullable<ConversationSession['actionPanel']>['pendingChoice'];
    /** A chunk answer of a split form (the last one too): a give-back returns only its forms to the record. */
    chunk?: boolean;
  }): Promise<void> {
    const forms = args.forms ?? [];
    const marks = [...args.card.targets, ...forms.map((form) => form.formId)];
    const taken = this.recordAnswer(args.session, args.sessionKey, args.remainingChoice);
    if (args.chunk) taken.chunk = forms.map((form) => form.formId);
    const remembered = this.rememberAnswered(args.sessionKey, marks);
    for (const form of forms) this.formStore.delete(form.formId);
    const drawing = this.drawAnswered(
      args.session,
      args.sessionKey,
      args.channel,
      args.card.targets,
      args.card.text,
      args.card.blocks,
    ).catch((error: unknown) =>
      this.logger.warn('Drawing an answered question failed', {
        sessionKey: args.sessionKey,
        error: (error as Error)?.message ?? String(error),
      }),
    );
    try {
      await this.ctx.messageHandler(args.event, this.createSayFn(args.channel as string));
    } catch (error) {
      if (this.giveBackQuestion(args.session, args.sessionKey, taken, error)) {
        this.forgetAnswered(remembered);
        for (const form of forms) {
          if (!this.formStore.get(form.formId)) this.formStore.set(form.formId, { ...form, submitting: false });
        }
        // Not awaited: the question is open again now, while Slack's line may still hold the answered drawing.
        void drawing
          .then(() =>
            this.drawQuestionBack(args.session, args.sessionKey, args.channel, taken, args.card.targets, forms),
          )
          .catch((drawError: unknown) =>
            this.logger.warn('Drawing a given-back question failed', {
              sessionKey: args.sessionKey,
              error: (drawError as Error)?.message ?? String(drawError),
            }),
          );
      }
      throw error;
    }
    await drawing;
  }

  /**
   * #1474 — the record of an answer, synchronously: what the question left on the session is kept (for a give-back)
   * and taken off. A whole answer takes the open bit, the recorded question and the choice record; a form chunk
   * whose other chunks are still to answer only shrinks the record (`remainingChoice`) — the question stays open.
   */
  private recordAnswer(
    session: ConversationSession,
    sessionKey: string,
    remainingChoice?: NonNullable<ConversationSession['actionPanel']>['pendingChoice'],
  ): TakenQuestion {
    const panel = session.actionPanel;
    const taken: TakenQuestion = {
      recordedAt: undefined,
      activityState: session.activityState,
      chunk: undefined,
      question: panel?.pendingQuestion,
      choice: panel?.pendingChoice,
      openBit: panel?.waitingForChoice,
      choiceMessageTs: panel?.choiceMessageTs,
      choiceMessageLink: panel?.choiceMessageLink,
      choiceBlocks: panel?.choiceBlocks,
    };
    if (panel && remainingChoice !== undefined) {
      panel.pendingChoice = remainingChoice;
    } else {
      if (panel) {
        panel.waitingForChoice = false;
        panel.pendingQuestion = undefined;
        panel.pendingChoice = undefined;
        panel.choiceMessageTs = undefined;
        panel.choiceMessageLink = undefined;
        panel.choiceBlocks = undefined;
      }
      this.ctx.claudeHandler.setActivityStateByKey(sessionKey, 'working');
    }
    taken.recordedAt = session.activityStateChangedAt;
    try {
      this.ctx.claudeHandler.getSessionRegistry?.()?.persistAndBroadcast?.(sessionKey);
    } catch (err) {
      this.logger.debug('recordAnswer: persistAndBroadcast failed', {
        sessionKey,
        error: (err as Error)?.message ?? String(err),
      });
    }
    return taken;
  }

  /**
   * #1474 — an answer the pipeline did not take gives its question back as it was — open bit, recorded question,
   * choice record, and the session's state (`waiting`; `idle` for a question recorded on an idle session):
   * - the queue did not keep it (`AnswerNotKeptError`): whatever the turn that asked did meanwhile, the owner's
   *   question is still unanswered;
   * - or nothing moved since the record (the session's activity clock): the dispatch failed before a turn started.
   * A failure after the answer's own turn ran (the clock moved, and no queue refused it) does not offer the used
   * answer again. Nor is anything given back over a newer question the model asked since: that one is open, and
   * this answer was not its answer. True when the question was given back.
   */
  private giveBackQuestion(
    session: ConversationSession,
    sessionKey: string,
    taken: TakenQuestion,
    error: unknown,
  ): boolean {
    const panel = session.actionPanel;
    if (panel?.pendingQuestion !== undefined && panel.pendingQuestion !== taken.question) {
      this.logger.info('Answer not given back — the model asked a newer question since', { sessionKey });
      return false;
    }
    const notKept = error instanceof AnswerNotKeptError;
    const untouched = session.activityStateChangedAt === taken.recordedAt;
    if (!notKept && !untouched) {
      this.logger.info('Answer not given back — a turn already ran on it', {
        sessionKey,
        activityState: session.activityState,
      });
      return false;
    }
    try {
      if (panel) {
        panel.pendingQuestion = taken.question;
        panel.pendingChoice = this.choiceGivenBack(panel.pendingChoice, taken);
        panel.waitingForChoice = taken.openBit;
        panel.choiceMessageTs = taken.choiceMessageTs;
        panel.choiceMessageLink = taken.choiceMessageLink;
        panel.choiceBlocks = taken.choiceBlocks;
      }
      // Waiting on its question again — unless the question was recorded on an idle session (a goal's decision): it
      // was idle, and is again.
      this.ctx.claudeHandler.setActivityStateByKey(sessionKey, taken.activityState === 'idle' ? 'idle' : 'waiting');
      this.ctx.claudeHandler.getSessionRegistry?.()?.persistAndBroadcast?.(sessionKey);
    } catch (rollbackError) {
      this.logger.error('Failed to give an answer back', { sessionKey, rollbackError });
    }
    this.logger.info('Answer given back — the question is open again', {
      sessionKey,
      reason: notKept ? (error as AnswerNotKeptError).reason : 'dispatch failed before a turn started',
    });
    return true;
  }

  /**
   * #1474 — the choice record a give-back leaves. A whole answer's record comes back as it was. A chunk answer
   * returns only its own forms, to the record as it is now: another chunk of the same form answered (or given back)
   * since has changed it, and the snapshot this one took would undo that — two chunks refused together would leave
   * the first one's form open with no record to answer it by (round 3, astra).
   */
  private choiceGivenBack(
    current: NonNullable<ConversationSession['actionPanel']>['pendingChoice'],
    taken: TakenQuestion,
  ): NonNullable<ConversationSession['actionPanel']>['pendingChoice'] {
    const was = taken.choice;
    if (!taken.chunk || was?.kind !== 'multi') return was;
    const stillOpen = current?.kind === 'multi' && current.turnId === was.turnId ? current.formIds : [];
    const open = new Set([...stillOpen, ...taken.chunk]);
    // In the form's order where this answer's snapshot knows it; the rest after.
    return { ...was, formIds: [...new Set([...was.formIds, ...stillOpen])].filter((formId) => open.has(formId)) };
  }

  /**
   * #1474 — draw an answered question: the card's messages lose their buttons, the thread header re-renders from
   * the session as it is now, the turn's completion messages go. Slack only — the session was recorded before.
   */
  private async drawAnswered(
    session: ConversationSession,
    sessionKey: string,
    channel: string | undefined,
    targets: string[],
    completedText: string,
    completedBlocks: any[],
  ): Promise<void> {
    if (!channel) return;
    const edits = targets.map((targetTs) =>
      this.ctx.slackApi
        .updateMessage(channel, targetTs, completedText, completedBlocks, [])
        .catch((error: unknown) => this.logger.warn('Failed to update choice message', { targetTs, error })),
    );
    const header = this.ctx.threadPanel
      ?.updatePanel?.(session, sessionKey)
      .catch((err: unknown) => this.logger.debug('Failed to redraw the thread header', { sessionKey, error: err }));
    this.deleteCompletionMessages(session, sessionKey, channel);
    await Promise.all([...edits, header]);
  }

  /**
   * #1474 — draw a given-back question open again, behind its answered drawing: each form it took gets its buttons
   * (and the selections it had) back; a single question's card is rebuilt from the recorded question, with the P3
   * turn its buttons carried. The thread header re-renders from the session, which holds the question again.
   */
  private async drawQuestionBack(
    session: ConversationSession,
    sessionKey: string,
    channel: string | undefined,
    taken: TakenQuestion,
    targets: string[],
    forms: PendingChoiceFormData[],
  ): Promise<void> {
    if (!channel) return;
    // Answered again (or asked anew) while the answered drawing waited: the card is that answer's to draw now.
    if (session.actionPanel?.pendingQuestion !== taken.question) return;
    if (this.wasAnswered(sessionKey, ...targets, ...forms.map((form) => form.formId))) return;
    const edits: Promise<unknown>[] = [];
    if (forms.length > 0) {
      for (const form of forms) {
        if (!form.messageTs) continue;
        const payload = UserChoiceHandler.buildMultiChoiceFormBlocks(
          { type: 'user_choices', questions: form.questions },
          form.formId,
          sessionKey,
          form.selections,
        );
        edits.push(
          this.ctx.slackApi.updateMessage(
            form.channel || channel,
            form.messageTs,
            '📋 선택이 필요합니다',
            undefined,
            payload.attachments,
          ),
        );
      }
    } else if (taken.question?.type === 'user_choice') {
      const question = taken.question as UserChoice;
      const turnId = taken.choice?.kind === 'single' ? taken.choice.turnId : undefined;
      let theme: Parameters<typeof UserChoiceHandler.buildUserChoiceBlocks>[2];
      try {
        theme = session.ownerId ? userSettingsStore.getUserSessionTheme(session.ownerId) : undefined;
      } catch {
        theme = undefined;
      }
      const payload = UserChoiceHandler.buildUserChoiceBlocks(question, sessionKey, theme, turnId);
      for (const targetTs of targets) {
        edits.push(
          this.ctx.slackApi.updateMessage(
            channel,
            targetTs,
            question.question ?? '선택이 필요합니다',
            payload.blocks,
            payload.attachments ?? [],
          ),
        );
      }
    }
    const header = this.ctx.threadPanel?.updatePanel?.(session, sessionKey);
    const results = await Promise.allSettled([...edits, header]);
    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.warn('Failed to draw a given-back question', { sessionKey, error: result.reason });
      }
    }
  }

  /**
   * #1474 — refuse a click on a card or form this handler already answered: the clicker is told, and nothing else
   * happens — no stale mark over the answered card, no second answer. True when refused. Public for the typed-answer
   * paths (`FormActionHandler`), which run the same click classification.
   */
  async refuseAnswered(
    sessionKey: string | undefined,
    channel: string | undefined,
    userId: string | undefined,
    ...marks: (string | undefined)[]
  ): Promise<boolean> {
    if (!sessionKey || !this.wasAnswered(sessionKey, ...marks)) return false;
    this.logger.info('Click refused — the question was already answered', { sessionKey });
    await this.tellAnswered(channel, userId);
    return true;
  }

  private async tellNothingOpen(channel: string | undefined, userId: string | undefined): Promise<void> {
    if (!channel || !userId) return;
    await this.ctx.slackApi.postEphemeral(channel, userId, NO_OPEN_QUESTION_TEXT).catch(() => undefined);
  }

  private async tellAnswered(channel: string | undefined, userId: string | undefined): Promise<void> {
    if (!channel || !userId) return;
    await this.ctx.slackApi.postEphemeral(channel, userId, ANSWER_TAKEN_TEXT).catch(() => undefined);
  }

  /** #1474 — is any of these cards or forms of the session already answered? (`FormActionHandler` asks too.) */
  isAnswered(sessionKey: string, ...marks: (string | undefined)[]): boolean {
    return this.wasAnswered(sessionKey, ...marks);
  }

  private wasAnswered(sessionKey: string, ...marks: (string | undefined)[]): boolean {
    const now = Date.now();
    return marks.some((mark) => {
      if (!mark) return false;
      const at = this.answered.get(`${sessionKey}|${mark}`);
      return at !== undefined && now - at < ANSWERED_MARK_TTL_MS;
    });
  }

  private rememberAnswered(sessionKey: string, marks: (string | undefined)[]): string[] {
    const now = Date.now();
    // Oldest first (insertion order): drop what has outlived any Slack lag.
    for (const [key, at] of this.answered) {
      if (now - at < ANSWERED_MARK_TTL_MS) break;
      this.answered.delete(key);
    }
    const keys = [...new Set(marks.filter((mark): mark is string => !!mark))].map((mark) => `${sessionKey}|${mark}`);
    for (const key of keys) {
      this.answered.delete(key);
      this.answered.set(key, now);
    }
    return keys;
  }

  private forgetAnswered(keys: string[]): void {
    for (const key of keys) this.answered.delete(key);
  }

  /** Delete the turn's tracked completion messages (S8), never the thread root (the header). Fire-and-forget. */
  private deleteCompletionMessages(session: ConversationSession, sessionKey: string, channel: string): void {
    const threadRootTs = session.threadRootTs;
    this.ctx.completionMessageTracker
      ?.deleteAll(
        sessionKey,
        async (ch, ts) => {
          if (threadRootTs && ts === threadRootTs) {
            this.logger.error('BLOCKED: attempted to delete thread root via completion tracker (answer)', {
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
}
