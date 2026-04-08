import type { ClaudeHandler } from '../../claude-handler';
import { Logger } from '../../logger';
import type { UserChoices } from '../../types';
import type { CompletionMessageTracker } from '../completion-message-tracker';
import type { SlackApiHelper } from '../slack-api-helper';
import type { ThreadPanel } from '../thread-panel';
import { UserChoiceHandler } from '../user-choice-handler';
import type { PendingFormStore } from './pending-form-store';
import type { MessageHandler, PendingChoiceFormData, SayFn } from './types';

/** Sentinel choiceId for custom text input (직접입력) */
const CUSTOM_INPUT_CHOICE_ID = '직접입력';

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

  constructor(
    private ctx: ChoiceActionContext,
    private formStore: PendingFormStore,
  ) {}

  async handleUserChoice(body: any): Promise<void> {
    try {
      const action = body.actions[0];
      const valueData = JSON.parse(action.value);
      const { sessionKey, choiceId, label, question } = valueData;
      const userId = body.user?.id;
      const channel = body.channel?.id;
      const messageTs = body.message?.ts;
      const fallbackThreadTs = body.message?.thread_ts || messageTs;
      const session = this.ctx.claudeHandler.getSessionByKey(sessionKey);
      const threadTs = this.resolveSessionThreadTs(session, fallbackThreadTs);
      const completionMessageTs = this.resolveChoiceMessageTs(session, messageTs);

      this.logger.info('User choice selected', { sessionKey, choiceId, label, userId });

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
        this.ctx.threadPanel?.clearChoice(sessionKey).catch(() => {});
      }

      // 세션 확인 및 메시지 처리
      if (session) {
        await this.ctx.threadPanel?.clearChoice(sessionKey);
        // Clear pending question from session (dashboard sync)
        if (session.actionPanel) {
          session.actionPanel.pendingQuestion = undefined;
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
        const say = this.createSayFn(channel);
        await this.ctx.messageHandler(
          { user: userId, channel, thread_ts: threadTs, ts: messageTs, text: choiceId },
          say,
        );
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
    }
  }

  async handleMultiChoice(body: any): Promise<void> {
    try {
      const action = body.actions[0];
      const valueData = JSON.parse(action.value);
      const { formId, sessionKey, questionId, choiceId, label } = valueData;
      const userId = body.user?.id;
      const channel = body.channel?.id;
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
      const { formId, questionId } = valueData;
      const userId = body.user?.id;
      const channel = body.channel?.id;
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
      const channel = body.channel?.id;
      const messageTs = body.message?.ts;

      this.logger.info('Form submit requested', { formId, userId });

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
      this.ctx.threadPanel?.clearChoice(sessionKey).catch(() => {});

      const fallbackThreadTs = pendingForm.threadTs || body.message?.thread_ts || messageTs;
      const session = this.ctx.claudeHandler.getSessionByKey(sessionKey);
      const threadTs = this.resolveSessionThreadTs(session, fallbackThreadTs);

      // 제출 처리
      await this.completeMultiChoiceForm(pendingForm, userId, channel, threadTs, messageTs);
    } catch (error) {
      this.logger.error('Error processing form submit', error);
    }
  }

  /**
   * Handle form reset - clear all selections
   */
  async handleFormReset(body: any): Promise<void> {
    try {
      const action = body.actions[0];
      const valueData = JSON.parse(action.value);
      const { formId } = valueData;
      const userId = body.user?.id;
      const channel = body.channel?.id;
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

    this.formStore.delete(pendingForm.formId);

    const completionMessageTs = pendingForm.messageTs || messageTs;

    // 완료 UI 업데이트 (모든 동기화 대상에 대해)
    const completedBlocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `✅ *모든 선택 완료*\n\n${responses.map((r, i) => `${i + 1}. ${r}`).join('\n')}`,
        },
      },
    ];

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
    const session = this.ctx.claudeHandler.getSessionByKey(pendingForm.sessionKey);
    const resolvedThreadTs = this.resolveSessionThreadTs(session, threadTs);
    if (session) {
      await this.ctx.threadPanel?.clearChoice(pendingForm.sessionKey);
      // Clear pending question from session (dashboard sync)
      if (session.actionPanel) {
        session.actionPanel.pendingQuestion = undefined;
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
      const say = this.createSayFn(channel);
      await this.ctx.messageHandler(
        { user: userId, channel, thread_ts: resolvedThreadTs, ts: messageTs, text: combinedMessage },
        say,
      );
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

    // Guard: only process if session is actually waiting for a choice
    if (session.activityState !== 'waiting') {
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

    const channel = session.channelId;
    const threadTs = this.resolveSessionThreadTs(session, session.threadTs);
    const choiceMessageTs = session.actionPanel?.choiceMessageTs;

    this.logger.info('Dashboard choice selected', { sessionKey, choiceId, label, userId });

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

      // Transition waiting → working
      this.ctx.claudeHandler.setActivityStateByKey(sessionKey, 'working');

      // Send choiceId as user message to Claude
      const say = this.createSayFn(channel);
      await this.ctx.messageHandler(
        { user: userId, channel, thread_ts: threadTs, ts: String(Date.now() / 1000), text: choiceId },
        say,
      );
    } catch (error) {
      // Rollback: restore waiting state so the user can retry from dashboard or Slack.
      // pendingQuestion is already cleared but activityState must not stay 'working' without a Claude stream.
      this.logger.error('Error processing dashboard choice', { sessionKey, choiceId, error });
      try {
        this.ctx.claudeHandler.setActivityStateByKey(sessionKey, 'waiting');
      } catch (rollbackError) {
        this.logger.error('Failed to rollback activity state after dashboard choice error', {
          sessionKey,
          rollbackError,
        });
      }
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

    if (session.activityState !== 'waiting') {
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

    // Save pendingQuestion for rollback in case messageHandler fails
    const savedPendingQuestion = session.actionPanel?.pendingQuestion;

    try {
      // Build combined response text (same format as Slack form submission)
      const responses = questions.map((q: { id: string; question: string }) => {
        const sel = selections[q.id];
        if (sel.choiceId === CUSTOM_INPUT_CHOICE_ID) {
          return `${q.question}: (직접입력) ${sel.label}`;
        }
        return `${q.question}: ${sel.choiceId}. ${sel.label}`;
      });
      const combinedMessage = responses.join('\n');

      // Update Slack form messages with completion
      const completedBlocks = [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `✅ *모든 선택 완료* _(대시보드)_\n${responses.map((r: string, i: number) => `${i + 1}. ${r}`).join('\n')}`,
          },
        },
      ];

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

      // Transition waiting → working
      this.ctx.claudeHandler.setActivityStateByKey(sessionKey, 'working');

      // Send combined response to Claude
      const say = this.createSayFn(channel);
      await this.ctx.messageHandler(
        { user: userId, channel, thread_ts: threadTs, ts: String(Date.now() / 1000), text: combinedMessage },
        say,
      );
    } catch (error) {
      this.logger.error('Error processing dashboard multi-choice', { sessionKey, error });
      try {
        // Restore pendingQuestion so user can retry from dashboard or Slack
        if (session.actionPanel && savedPendingQuestion) {
          session.actionPanel.pendingQuestion = savedPendingQuestion;
        }
        this.ctx.claudeHandler.setActivityStateByKey(sessionKey, 'waiting');
      } catch (rollbackError) {
        this.logger.error('Failed to rollback activity state after dashboard multi-choice error', {
          sessionKey,
          rollbackError,
        });
      }
      throw error;
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
}
