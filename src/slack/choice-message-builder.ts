import { UserChoice, UserChoices } from '../types';

export interface SlackMessagePayload {
  blocks?: any[];
  attachments?: any[];
}

/**
 * Slack 블록 UI 빌딩 로직
 */
export class ChoiceMessageBuilder {
  /**
   * Build Slack attachment for single user choice (Jira-style card UI)
   */
  static buildUserChoiceBlocks(choice: UserChoice, sessionKey: string): SlackMessagePayload {
    const attachmentBlocks: any[] = [];

    // Title
    attachmentBlocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${choice.question}*`,
      },
    });

    // Context if provided
    if (choice.context) {
      attachmentBlocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: choice.context,
          },
        ],
      });
    }

    // Build fields for horizontal layout (2 columns)
    const options = choice.choices.slice(0, 4);
    const fields: any[] = options.map((opt) => ({
      type: 'mrkdwn',
      text: opt.description
        ? `*${opt.label}*\n${opt.description}`
        : `*${opt.label}*`,
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
    const buttons: any[] = options.map((opt) => ({
      type: 'button',
      text: {
        type: 'plain_text',
        text: opt.label.substring(0, 30),
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
        text: '직접 입력',
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

    // Header with title
    attachmentBlocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${choices.title || '선택이 필요합니다'}*`,
      },
    });

    // Progress and description context
    const contextElements: any[] = [
      {
        type: 'mrkdwn',
        text: `${this.buildProgressBar(answeredCount, totalQuestions)}  *${answeredCount}/${totalQuestions}*`,
      },
    ];

    if (choices.description) {
      contextElements.push({
        type: 'mrkdwn',
        text: `  |  ${choices.description}`,
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

      attachmentBlocks.push({ type: 'divider' });

      if (isSelected) {
        attachmentBlocks.push({
          type: 'section',
          fields: [
            {
              type: 'mrkdwn',
              text: `~${q.question}~`,
            },
            {
              type: 'mrkdwn',
              text: `*${selectedChoice.label}*`,
            },
          ],
        });
      } else {
        attachmentBlocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*${q.question}*`,
          },
        });

        if (q.context) {
          attachmentBlocks.push({
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: q.context,
              },
            ],
          });
        }

        const options = q.choices.slice(0, 4);
        const fields: any[] = options.map((opt) => ({
          type: 'mrkdwn',
          text: opt.description
            ? `*${opt.label}*\n${opt.description}`
            : `*${opt.label}*`,
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

        const buttons: any[] = options.map((opt) => ({
          type: 'button',
          text: {
            type: 'plain_text',
            text: opt.label.substring(0, 30),
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

        buttons.push({
          type: 'button',
          text: {
            type: 'plain_text',
            text: '직접 입력',
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

    // Completion message
    if (isComplete) {
      attachmentBlocks.push({ type: 'divider' });
      attachmentBlocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '✓ *모든 선택 완료* — 진행 중...',
        },
      });
    }

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
