import { UserChoice, UserChoices } from '../types';

export interface SlackMessagePayload {
  blocks?: any[];
  attachments?: any[];
}

// Option number emojis for visual distinction
const OPTION_EMOJIS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'];

/**
 * Slack 블록 UI 빌딩 로직
 */
export class ChoiceMessageBuilder {
  /**
   * Build Slack attachment for single user choice (Jira-style card UI)
   */
  static buildUserChoiceBlocks(choice: UserChoice, sessionKey: string): SlackMessagePayload {
    const attachmentBlocks: any[] = [];

    // Title with emoji
    attachmentBlocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `❓ *${choice.question}*`,
      },
    });

    // Context if provided
    if (choice.context) {
      attachmentBlocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `💡 ${choice.context}`,
          },
        ],
      });
    }

    // Build fields for horizontal layout (2 columns) with number emojis
    const options = choice.choices.slice(0, 4);
    const fields: any[] = options.map((opt, idx) => ({
      type: 'mrkdwn',
      text: opt.description
        ? `${OPTION_EMOJIS[idx]} *${opt.label}*\n_${opt.description}_`
        : `${OPTION_EMOJIS[idx]} *${opt.label}*`,
    }));

    if (fields.length > 0) {
      attachmentBlocks.push({
        type: 'section',
        fields: fields.slice(0, 2),
      });

      if (fields.length > 2) {
        attachmentBlocks.push({
          type: 'section',
          fields: fields.slice(2, 4),
        });
      }
    }

    // Action buttons
    const buttons: any[] = options.map((opt, idx) => ({
      type: 'button',
      text: {
        type: 'plain_text',
        text: `${OPTION_EMOJIS[idx]} ${opt.label.substring(0, 25)}`,
        emoji: true,
      },
      value: JSON.stringify({
        sessionKey,
        choiceId: opt.id,
        label: opt.label,
        question: choice.question,
      }),
      action_id: `user_choice_${opt.id}`,
    }));

    // Custom input button
    buttons.push({
      type: 'button',
      text: {
        type: 'plain_text',
        text: '✏️ 직접 입력',
        emoji: true,
      },
      value: JSON.stringify({
        sessionKey,
        question: choice.question,
        type: 'single',
      }),
      action_id: 'custom_input_single',
    });

    attachmentBlocks.push({
      type: 'actions',
      elements: buttons,
    });

    return {
      attachments: [
        {
          color: '#0052CC',
          blocks: attachmentBlocks,
        },
      ],
    };
  }

  /**
   * Build Slack attachment for multi-question choice form (Jira-style card UI)
   * Enhanced with:
   * - Edit button for selected choices (reselect)
   * - Final submit button when all questions answered
   * - Better visual hierarchy with emojis
   */
  static buildMultiChoiceFormBlocks(
    choices: UserChoices,
    formId: string,
    sessionKey: string,
    selections: Record<string, { choiceId: string; label: string }> = {}
  ): SlackMessagePayload {
    const attachmentBlocks: any[] = [];

    // Progress calculation
    const totalQuestions = choices.questions.length;
    const answeredCount = Object.keys(selections).length;
    const isComplete = answeredCount === totalQuestions;

    // Header with emoji
    attachmentBlocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `📋 *${choices.title || '선택이 필요합니다'}*`,
      },
    });

    // Progress bar and description
    const progressBar = this.buildProgressBar(answeredCount, totalQuestions);
    const progressText = isComplete ? '✅ 모두 완료!' : `${answeredCount}/${totalQuestions} 완료`;

    const contextElements: any[] = [
      {
        type: 'mrkdwn',
        text: `${progressBar}  *${progressText}*`,
      },
    ];

    if (choices.description) {
      contextElements.push({
        type: 'mrkdwn',
        text: `  │  _${choices.description}_`,
      });
    }

    attachmentBlocks.push({
      type: 'context',
      elements: contextElements,
    });

    // Build each question
    choices.questions.forEach((q, idx) => {
      const isSelected = !!selections[q.id];
      const selectedChoice = selections[q.id];
      const questionNumber = idx + 1;

      attachmentBlocks.push({ type: 'divider' });

      if (isSelected) {
        // Selected question: show checkmark + answer + edit button
        attachmentBlocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `✅ *Q${questionNumber}. ${q.question}*`,
          },
          accessory: {
            type: 'button',
            text: {
              type: 'plain_text',
              text: '🔄 변경',
              emoji: true,
            },
            value: JSON.stringify({
              formId,
              sessionKey,
              questionId: q.id,
            }),
            action_id: `edit_choice_${formId}_${q.id}`,
          },
        });

        // Show selected answer
        attachmentBlocks.push({
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `➜ *${selectedChoice.label}*`,
            },
          ],
        });
      } else {
        // Unselected question: show full options
        attachmentBlocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `❓ *Q${questionNumber}. ${q.question}*`,
          },
        });

        if (q.context) {
          attachmentBlocks.push({
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `💡 ${q.context}`,
              },
            ],
          });
        }

        // Options with number emojis
        const options = q.choices.slice(0, 4);
        const fields: any[] = options.map((opt, optIdx) => ({
          type: 'mrkdwn',
          text: opt.description
            ? `${OPTION_EMOJIS[optIdx]} *${opt.label}*\n_${opt.description}_`
            : `${OPTION_EMOJIS[optIdx]} *${opt.label}*`,
        }));

        if (fields.length > 0) {
          attachmentBlocks.push({
            type: 'section',
            fields: fields.slice(0, 2),
          });

          if (fields.length > 2) {
            attachmentBlocks.push({
              type: 'section',
              fields: fields.slice(2, 4),
            });
          }
        }

        // Action buttons with number emojis
        const buttons: any[] = options.map((opt, optIdx) => ({
          type: 'button',
          text: {
            type: 'plain_text',
            text: `${OPTION_EMOJIS[optIdx]} ${opt.label.substring(0, 22)}`,
            emoji: true,
          },
          value: JSON.stringify({
            formId,
            sessionKey,
            questionId: q.id,
            choiceId: opt.id,
            label: opt.label,
          }),
          action_id: `multi_choice_${formId}_${q.id}_${opt.id}`,
        }));

        // Custom input button
        buttons.push({
          type: 'button',
          text: {
            type: 'plain_text',
            text: '✏️ 직접 입력',
            emoji: true,
          },
          value: JSON.stringify({
            formId,
            sessionKey,
            questionId: q.id,
            question: q.question,
            type: 'multi',
          }),
          action_id: `custom_input_multi_${formId}_${q.id}`,
        });

        attachmentBlocks.push({
          type: 'actions',
          elements: buttons,
        });
      }
    });

    // Submit/Reset buttons when complete (instead of auto-submit)
    if (isComplete) {
      attachmentBlocks.push({ type: 'divider' });

      attachmentBlocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '🎉 *모든 선택이 완료되었습니다!*\n_제출 전에 위 선택을 변경할 수 있습니다._',
        },
      });

      attachmentBlocks.push({
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: '🚀 제출하기',
              emoji: true,
            },
            style: 'primary',
            value: JSON.stringify({
              formId,
              sessionKey,
            }),
            action_id: `submit_form_${formId}`,
          },
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: '🗑️ 모두 초기화',
              emoji: true,
            },
            style: 'danger',
            value: JSON.stringify({
              formId,
              sessionKey,
            }),
            action_id: `reset_form_${formId}`,
            confirm: {
              title: {
                type: 'plain_text',
                text: '초기화 확인',
              },
              text: {
                type: 'mrkdwn',
                text: '모든 선택을 초기화하시겠습니까?',
              },
              confirm: {
                type: 'plain_text',
                text: '초기화',
              },
              deny: {
                type: 'plain_text',
                text: '취소',
              },
            },
          },
        ],
      });
    }

    // Color based on state: blue (in progress), green (complete & ready to submit)
    const color = isComplete ? '#36a64f' : '#0052CC';

    return {
      attachments: [
        {
          color,
          blocks: attachmentBlocks,
        },
      ],
    };
  }

  /**
   * Build a visual progress bar
   */
  private static buildProgressBar(current: number, total: number): string {
    const filled = current;
    const empty = total - current;
    const filledChar = '●';
    const emptyChar = '○';
    return filledChar.repeat(filled) + emptyChar.repeat(empty);
  }
}
