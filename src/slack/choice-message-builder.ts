import { UserChoice, UserChoices } from '../types';
import { SessionTheme } from '../user-settings-store';

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
   * Dispatches to themed layout builders based on theme parameter.
   */
  static buildUserChoiceBlocks(choice: UserChoice, sessionKey: string, theme?: SessionTheme): SlackMessagePayload {
    const resolvedTheme = theme ?? 'A';

    switch (resolvedTheme) {
      case 'A': return this.buildThemeA(choice, sessionKey);
      case 'B': return this.buildThemeB(choice, sessionKey);
      case 'C': return this.buildThemeC(choice, sessionKey);
      case 'D': return this.buildThemeD(choice, sessionKey);
      case 'E': return this.buildThemeE(choice, sessionKey);
      case 'F': return this.buildThemeF(choice, sessionKey);
      case 'G': return this.buildThemeG(choice, sessionKey);
      case 'H': return this.buildThemeH(choice, sessionKey);
      case 'I': return this.buildThemeI(choice, sessionKey);
      case 'J': return this.buildThemeJ(choice, sessionKey);
      case 'K': return this.buildThemeK(choice, sessionKey);
      case 'L': return this.buildThemeL(choice, sessionKey);
      default: return this.buildThemeA(choice, sessionKey);
    }
  }

  // ---------------------------------------------------------------------------
  // Helper: build standard action buttons (shared across themes)
  // ---------------------------------------------------------------------------

  private static buildOptionButtons(choice: UserChoice, sessionKey: string): any[] {
    const options = choice.choices.slice(0, 4);
    return options.map((opt, idx) => ({
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
  }

  private static buildCustomInputButton(sessionKey: string, question: string): any {
    return {
      type: 'button',
      text: {
        type: 'plain_text',
        text: '✏️ 직접 입력',
        emoji: true,
      },
      value: JSON.stringify({
        sessionKey,
        question,
        type: 'single',
      }),
      action_id: 'custom_input_single',
    };
  }

  private static wrapAttachment(blocks: any[]): SlackMessagePayload {
    return {
      attachments: [
        {
          color: '#0052CC',
          blocks,
        },
      ],
    };
  }

  // ---------------------------------------------------------------------------
  // Theme A: Minimal — context question + buttons only
  // ---------------------------------------------------------------------------

  private static buildThemeA(choice: UserChoice, sessionKey: string): SlackMessagePayload {
    const blocks: any[] = [];

    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `❓ ${choice.question}`,
        },
      ],
    });

    const buttons = this.buildOptionButtons(choice, sessionKey);
    buttons.push(this.buildCustomInputButton(sessionKey, choice.question));

    blocks.push({
      type: 'actions',
      elements: buttons,
    });

    return this.wrapAttachment(blocks);
  }

  // ---------------------------------------------------------------------------
  // Theme B: One-Liner — context question with context + emoji-numbered buttons
  // ---------------------------------------------------------------------------

  private static buildThemeB(choice: UserChoice, sessionKey: string): SlackMessagePayload {
    const blocks: any[] = [];

    const contextText = choice.context
      ? `❓ ${choice.question} · (${choice.context})`
      : `❓ ${choice.question}`;

    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: contextText,
        },
      ],
    });

    const buttons = this.buildOptionButtons(choice, sessionKey);
    buttons.push(this.buildCustomInputButton(sessionKey, choice.question));

    blocks.push({
      type: 'actions',
      elements: buttons,
    });

    return this.wrapAttachment(blocks);
  }

  // ---------------------------------------------------------------------------
  // Theme C: Compact — section question + actions
  // ---------------------------------------------------------------------------

  private static buildThemeC(choice: UserChoice, sessionKey: string): SlackMessagePayload {
    const blocks: any[] = [];

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `❓ *${choice.question}*`,
      },
    });

    const buttons = this.buildOptionButtons(choice, sessionKey);
    buttons.push(this.buildCustomInputButton(sessionKey, choice.question));

    blocks.push({
      type: 'actions',
      elements: buttons,
    });

    return this.wrapAttachment(blocks);
  }

  // ---------------------------------------------------------------------------
  // Theme D: Classic — CURRENT implementation (section + context + fields 2-col + actions)
  // ---------------------------------------------------------------------------

  private static buildThemeD(choice: UserChoice, sessionKey: string): SlackMessagePayload {
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

  // ---------------------------------------------------------------------------
  // Theme E: Dashboard — section + context + fields + first button primary
  // ---------------------------------------------------------------------------

  private static buildThemeE(choice: UserChoice, sessionKey: string): SlackMessagePayload {
    const blocks: any[] = [];

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `❓ *${choice.question}*`,
      },
    });

    if (choice.context) {
      blocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `💡 ${choice.context}`,
          },
        ],
      });
    }

    // Fields 2-col with emoji + descriptions
    const options = choice.choices.slice(0, 4);
    const fields: any[] = options.map((opt, idx) => ({
      type: 'mrkdwn',
      text: opt.description
        ? `${OPTION_EMOJIS[idx]} *${opt.label}*\n_${opt.description}_`
        : `${OPTION_EMOJIS[idx]} *${opt.label}*`,
    }));

    if (fields.length > 0) {
      blocks.push({
        type: 'section',
        fields: fields.slice(0, 2),
      });

      if (fields.length > 2) {
        blocks.push({
          type: 'section',
          fields: fields.slice(2, 4),
        });
      }
    }

    // Action buttons — first button is primary
    const buttons = this.buildOptionButtons(choice, sessionKey);
    if (buttons.length > 0) {
      buttons[0].style = 'primary';
    }
    buttons.push(this.buildCustomInputButton(sessionKey, choice.question));

    blocks.push({
      type: 'actions',
      elements: buttons,
    });

    return this.wrapAttachment(blocks);
  }

  // ---------------------------------------------------------------------------
  // Theme F: Status Bar — section with emphasis + context + emoji-prefixed buttons
  // ---------------------------------------------------------------------------

  private static buildThemeF(choice: UserChoice, sessionKey: string): SlackMessagePayload {
    const blocks: any[] = [];

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `🟠 *결정 필요* — ${choice.question}`,
      },
    });

    if (choice.context) {
      blocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `💡 ${choice.context}`,
          },
        ],
      });
    }

    const STATUS_EMOJIS = ['✅', '⚡', '🚪', '🔧'];
    const options = choice.choices.slice(0, 4);
    const buttons: any[] = options.map((opt, idx) => ({
      type: 'button',
      text: {
        type: 'plain_text',
        text: `${STATUS_EMOJIS[idx] || '▪️'} ${opt.label.substring(0, 25)}`,
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

    buttons.push(this.buildCustomInputButton(sessionKey, choice.question));

    blocks.push({
      type: 'actions',
      elements: buttons,
    });

    return this.wrapAttachment(blocks);
  }

  // ---------------------------------------------------------------------------
  // Theme G: Rich Card — each option as its own section with accessory button
  // ---------------------------------------------------------------------------

  private static buildThemeG(choice: UserChoice, sessionKey: string): SlackMessagePayload {
    const blocks: any[] = [];

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `❓ *${choice.question}*`,
      },
    });

    if (choice.context) {
      blocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `💡 ${choice.context}`,
          },
        ],
      });
    }

    const options = choice.choices.slice(0, 4);
    options.forEach((opt, idx) => {
      const sectionText = opt.description
        ? `${OPTION_EMOJIS[idx]} *${opt.label}*\n_${opt.description}_`
        : `${OPTION_EMOJIS[idx]} *${opt.label}*`;

      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: sectionText,
        },
        accessory: {
          type: 'button',
          text: {
            type: 'plain_text',
            text: '선택',
            emoji: true,
          },
          value: JSON.stringify({
            sessionKey,
            choiceId: opt.id,
            label: opt.label,
            question: choice.question,
          }),
          action_id: `user_choice_${opt.id}`,
        },
      });
    });

    // Only custom input button in actions
    blocks.push({
      type: 'actions',
      elements: [this.buildCustomInputButton(sessionKey, choice.question)],
    });

    return this.wrapAttachment(blocks);
  }

  // ---------------------------------------------------------------------------
  // Theme H: Table — section + numbered fields + numbered buttons
  // ---------------------------------------------------------------------------

  private static buildThemeH(choice: UserChoice, sessionKey: string): SlackMessagePayload {
    const blocks: any[] = [];

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `❓ *${choice.question}*`,
      },
    });

    const options = choice.choices.slice(0, 4);
    const fields: any[] = options.map((opt, idx) => ({
      type: 'mrkdwn',
      text: opt.description
        ? `${idx + 1}. ${opt.label}\n_${opt.description}_`
        : `${idx + 1}. ${opt.label}`,
    }));

    if (fields.length > 0) {
      blocks.push({
        type: 'section',
        fields,
      });
    }

    // Numbered buttons
    const buttons: any[] = options.map((opt, idx) => ({
      type: 'button',
      text: {
        type: 'plain_text',
        text: `${idx + 1}`,
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

    buttons.push(this.buildCustomInputButton(sessionKey, choice.question));

    blocks.push({
      type: 'actions',
      elements: buttons,
    });

    return this.wrapAttachment(blocks);
  }

  // ---------------------------------------------------------------------------
  // Theme I: Kanban — question section + divider + option contexts + actions
  // ---------------------------------------------------------------------------

  private static buildThemeI(choice: UserChoice, sessionKey: string): SlackMessagePayload {
    const blocks: any[] = [];

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `❓ *${choice.question}*`,
      },
    });

    blocks.push({ type: 'divider' });

    const options = choice.choices.slice(0, 4);
    options.forEach((opt, idx) => {
      const contextText = opt.description
        ? `${OPTION_EMOJIS[idx]} *${opt.label}* — _${opt.description}_`
        : `${OPTION_EMOJIS[idx]} *${opt.label}*`;

      blocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: contextText,
          },
        ],
      });
    });

    const buttons = this.buildOptionButtons(choice, sessionKey);
    buttons.push(this.buildCustomInputButton(sessionKey, choice.question));

    blocks.push({
      type: 'actions',
      elements: buttons,
    });

    return this.wrapAttachment(blocks);
  }

  // ---------------------------------------------------------------------------
  // Theme J: Timeline — time context + section + actions
  // ---------------------------------------------------------------------------

  private static buildThemeJ(choice: UserChoice, sessionKey: string): SlackMessagePayload {
    const blocks: any[] = [];

    const now = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });

    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `🕐 ${now}`,
        },
      ],
    });

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `❓ *${choice.question}*`,
      },
    });

    const buttons = this.buildOptionButtons(choice, sessionKey);
    buttons.push(this.buildCustomInputButton(sessionKey, choice.question));

    blocks.push({
      type: 'actions',
      elements: buttons,
    });

    return this.wrapAttachment(blocks);
  }

  // ---------------------------------------------------------------------------
  // Theme K: Progress — section + recommended highlight + first button primary
  // ---------------------------------------------------------------------------

  private static buildThemeK(choice: UserChoice, sessionKey: string): SlackMessagePayload {
    const blocks: any[] = [];

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `❓ *${choice.question}*`,
      },
    });

    if (choice.choices.length > 0) {
      blocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: '⭐ 첫 번째 옵션이 권장됩니다',
          },
        ],
      });
    }

    const buttons = this.buildOptionButtons(choice, sessionKey);
    if (buttons.length > 0) {
      buttons[0].style = 'primary';
    }
    buttons.push(this.buildCustomInputButton(sessionKey, choice.question));

    blocks.push({
      type: 'actions',
      elements: buttons,
    });

    return this.wrapAttachment(blocks);
  }

  // ---------------------------------------------------------------------------
  // Theme L: Notification — blockquote section + actions
  // ---------------------------------------------------------------------------

  private static buildThemeL(choice: UserChoice, sessionKey: string): SlackMessagePayload {
    const blocks: any[] = [];

    let sectionText = `> ❓ *${choice.question}*`;
    if (choice.context) {
      sectionText += `\n> 💡 _${choice.context}_`;
    }

    const options = choice.choices.slice(0, 4);
    if (options.length > 0) {
      const optionsList = options
        .map((opt, idx) => `> ${OPTION_EMOJIS[idx]} ${opt.label}`)
        .join('\n');
      sectionText += `\n${optionsList}`;
    }

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: sectionText,
      },
    });

    const buttons = this.buildOptionButtons(choice, sessionKey);
    buttons.push(this.buildCustomInputButton(sessionKey, choice.question));

    blocks.push({
      type: 'actions',
      elements: buttons,
    });

    return this.wrapAttachment(blocks);
  }

  // ===========================================================================
  // Multi-choice form (unchanged)
  // ===========================================================================

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
