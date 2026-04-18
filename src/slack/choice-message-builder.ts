import type { UserChoice, UserChoiceOption, UserChoices } from '../types';
import type { SessionTheme } from '../user-settings-store';

export interface SlackMessagePayload {
  blocks?: any[];
  attachments?: any[];
}

// Option number emojis for visual distinction
const OPTION_EMOJIS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'];

interface PartitionedChoice {
  opt: UserChoiceOption;
  origIndex: number;
}
interface PartitionedChoices {
  recommended: PartitionedChoice | null;
  rest: PartitionedChoice[];
}

/**
 * Slack 블록 UI 빌딩 로직
 */
export class ChoiceMessageBuilder {
  /**
   * Build Slack attachment for single user choice (Jira-style card UI)
   * Dispatches to themed layout builders based on theme parameter.
   */
  static buildUserChoiceBlocks(choice: UserChoice, sessionKey: string, theme?: SessionTheme): SlackMessagePayload {
    const resolvedTheme = theme ?? 'default';

    switch (resolvedTheme) {
      case 'compact':
        return ChoiceMessageBuilder.buildThemeCompact(choice, sessionKey);
      case 'minimal':
        return ChoiceMessageBuilder.buildThemeMinimal(choice, sessionKey);
      case 'default':
      default:
        return ChoiceMessageBuilder.buildThemeDefault(choice, sessionKey);
    }
  }

  // ---------------------------------------------------------------------------
  // Helper: build standard action buttons (shared across themes)
  // ---------------------------------------------------------------------------

  private static partition(choices: UserChoiceOption[], recId?: string): PartitionedChoices {
    const all = choices.slice(0, 4).map((opt, i) => ({ opt, origIndex: i }));
    if (!recId) return { recommended: null, rest: all };
    const idx = all.findIndex((e) => e.opt.id === recId);
    if (idx < 0) return { recommended: null, rest: all };
    return { recommended: all[idx], rest: all.filter((_, i) => i !== idx) };
  }

  private static buildChoiceButton(
    entry: PartitionedChoice,
    sessionKey: string,
    question: string,
    opts: { primary?: boolean; labelMaxLen?: number } = {},
  ): any {
    const maxLen = opts.labelMaxLen ?? 25;
    const button: any = {
      type: 'button',
      text: {
        type: 'plain_text',
        text: `${OPTION_EMOJIS[entry.origIndex]} ${entry.opt.label.substring(0, maxLen)}`,
        emoji: true,
      },
      value: JSON.stringify({
        sessionKey,
        choiceId: entry.opt.id,
        label: entry.opt.label,
        question,
      }),
      action_id: `user_choice_${entry.opt.id}`,
    };
    if (opts.primary) button.style = 'primary';
    return button;
  }

  private static buildRecommendedBannerSection(rec: PartitionedChoice): any {
    const descLine = rec.opt.description ? `\n_${rec.opt.description}_` : '';
    return {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `⭐ *Recommended* — *${rec.opt.label}*${descLine}`,
      },
    };
  }

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
  // Theme: default (Classic) — section + divider + fields 2-col + actions
  // Based on former Theme D
  // ---------------------------------------------------------------------------

  private static buildThemeDefault(choice: UserChoice, sessionKey: string): SlackMessagePayload {
    const attachmentBlocks: any[] = [];

    // Title with emoji
    attachmentBlocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `❓ *${choice.question}*`,
      },
    });

    // Context (if provided, trimmed — renderer-level defense against whitespace-only)
    const defaultCtx = choice.context?.trim();
    if (defaultCtx) {
      attachmentBlocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `💡 ${defaultCtx}`,
          },
        ],
      });
    }

    attachmentBlocks.push({ type: 'divider' });

    const partition = ChoiceMessageBuilder.partition(choice.choices, choice.recommendedChoiceId);
    const hasRecommended = !!partition.recommended;

    // Build fields for horizontal layout (2 columns) with number emojis
    // When a recommended choice is present, exclude it from fields (banner covers it).
    const fieldEntries = hasRecommended ? partition.rest : [...partition.rest];
    const fields: any[] = fieldEntries.map((entry) => ({
      type: 'mrkdwn',
      text: entry.opt.description
        ? `${OPTION_EMOJIS[entry.origIndex]} *${entry.opt.label}*\n_${entry.opt.description}_`
        : `${OPTION_EMOJIS[entry.origIndex]} *${entry.opt.label}*`,
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

    if (hasRecommended && partition.recommended) {
      // Banner + solo primary actions + divider
      attachmentBlocks.push(ChoiceMessageBuilder.buildRecommendedBannerSection(partition.recommended));
      attachmentBlocks.push({
        type: 'actions',
        elements: [
          ChoiceMessageBuilder.buildChoiceButton(partition.recommended, sessionKey, choice.question, {
            primary: true,
          }),
        ],
      });
      attachmentBlocks.push({ type: 'divider' });

      // Remaining buttons (preserving original ordinals) + custom input
      const restButtons: any[] = partition.rest.map((entry) =>
        ChoiceMessageBuilder.buildChoiceButton(entry, sessionKey, choice.question),
      );
      restButtons.push({
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
        elements: restButtons,
      });
    } else {
      // Original layout (no recommended)
      const options = choice.choices.slice(0, 4);
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
    }

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
  // Theme: compact — section question + actions with labeled buttons
  // Based on former Theme C
  // ---------------------------------------------------------------------------

  private static buildThemeCompact(choice: UserChoice, sessionKey: string): SlackMessagePayload {
    const blocks: any[] = [];

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `❓ *${choice.question}*`,
      },
    });

    // Context (if provided, trimmed — renderer-level defense against whitespace-only)
    const compactCtx = choice.context?.trim();
    if (compactCtx) {
      blocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `💡 ${compactCtx}`,
          },
        ],
      });
    }

    const partition = ChoiceMessageBuilder.partition(choice.choices, choice.recommendedChoiceId);
    if (partition.recommended) {
      blocks.push(ChoiceMessageBuilder.buildRecommendedBannerSection(partition.recommended));
      blocks.push({
        type: 'actions',
        elements: [
          ChoiceMessageBuilder.buildChoiceButton(partition.recommended, sessionKey, choice.question, {
            primary: true,
          }),
        ],
      });
      blocks.push({ type: 'divider' });

      const restButtons = partition.rest.map((entry) =>
        ChoiceMessageBuilder.buildChoiceButton(entry, sessionKey, choice.question),
      );
      restButtons.push(ChoiceMessageBuilder.buildCustomInputButton(sessionKey, choice.question));
      blocks.push({
        type: 'actions',
        elements: restButtons,
      });
    } else {
      const buttons = ChoiceMessageBuilder.buildOptionButtons(choice, sessionKey);
      buttons.push(ChoiceMessageBuilder.buildCustomInputButton(sessionKey, choice.question));

      blocks.push({
        type: 'actions',
        elements: buttons,
      });
    }

    return ChoiceMessageBuilder.wrapAttachment(blocks);
  }

  // ---------------------------------------------------------------------------
  // Theme: minimal — context question + buttons only
  // Based on former Theme A
  // ---------------------------------------------------------------------------

  private static buildThemeMinimal(choice: UserChoice, sessionKey: string): SlackMessagePayload {
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

    // Context (if provided, trimmed — renderer-level defense against whitespace-only)
    const minimalCtx = choice.context?.trim();
    if (minimalCtx) {
      blocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `💡 ${minimalCtx}`,
          },
        ],
      });
    }

    const partition = ChoiceMessageBuilder.partition(choice.choices, choice.recommendedChoiceId);
    if (partition.recommended) {
      blocks.push(ChoiceMessageBuilder.buildRecommendedBannerSection(partition.recommended));
      blocks.push({
        type: 'actions',
        elements: [
          ChoiceMessageBuilder.buildChoiceButton(partition.recommended, sessionKey, choice.question, {
            primary: true,
          }),
        ],
      });
      blocks.push({ type: 'divider' });

      const restButtons = partition.rest.map((entry) =>
        ChoiceMessageBuilder.buildChoiceButton(entry, sessionKey, choice.question),
      );
      restButtons.push(ChoiceMessageBuilder.buildCustomInputButton(sessionKey, choice.question));
      blocks.push({
        type: 'actions',
        elements: restButtons,
      });
    } else {
      const buttons = ChoiceMessageBuilder.buildOptionButtons(choice, sessionKey);
      buttons.push(ChoiceMessageBuilder.buildCustomInputButton(sessionKey, choice.question));

      blocks.push({
        type: 'actions',
        elements: buttons,
      });
    }

    return ChoiceMessageBuilder.wrapAttachment(blocks);
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
    selections: Record<string, { choiceId: string; label: string }> = {},
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
    const progressBar = ChoiceMessageBuilder.buildProgressBar(answeredCount, totalQuestions);
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

        const partition = ChoiceMessageBuilder.partition(q.choices, q.recommendedChoiceId);
        const hasRecommended = !!partition.recommended;

        // Options fields (exclude recommended when present)
        const fieldEntries = hasRecommended ? partition.rest : [...partition.rest];
        const fields: any[] = fieldEntries.map((entry) => ({
          type: 'mrkdwn',
          text: entry.opt.description
            ? `${OPTION_EMOJIS[entry.origIndex]} *${entry.opt.label}*\n_${entry.opt.description}_`
            : `${OPTION_EMOJIS[entry.origIndex]} *${entry.opt.label}*`,
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

        const makeMultiButton = (entry: PartitionedChoice, primary: boolean): any => {
          const button: any = {
            type: 'button',
            text: {
              type: 'plain_text',
              text: `${OPTION_EMOJIS[entry.origIndex]} ${entry.opt.label.substring(0, 22)}`,
              emoji: true,
            },
            value: JSON.stringify({
              formId,
              sessionKey,
              questionId: q.id,
              choiceId: entry.opt.id,
              label: entry.opt.label,
            }),
            action_id: `multi_choice_${formId}_${q.id}_${entry.opt.id}`,
          };
          if (primary) button.style = 'primary';
          return button;
        };

        if (hasRecommended && partition.recommended) {
          // Banner
          attachmentBlocks.push(ChoiceMessageBuilder.buildRecommendedBannerSection(partition.recommended));
          // Solo primary action for recommended
          attachmentBlocks.push({
            type: 'actions',
            elements: [makeMultiButton(partition.recommended, true)],
          });
          attachmentBlocks.push({ type: 'divider' });

          // Remaining buttons + custom input
          const restButtons: any[] = partition.rest.map((entry) => makeMultiButton(entry, false));
          restButtons.push({
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
            elements: restButtons,
          });
        } else {
          // Original layout (no recommended)
          const options = q.choices.slice(0, 4);
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
