import { LEGACY_RECOMMENDED_SUFFIX_RE } from 'somalib/model-commands/validator';
import type { UserChoice, UserChoiceOption, UserChoices } from '../types';
import type { SessionTheme } from '../user-settings-store';
import { escapeSlackMrkdwn } from './mrkdwn-escape';

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
  // ---------------------------------------------------------------------------
  // Recommended-choice helpers
  // ---------------------------------------------------------------------------

  /** Strip trailing "(Recommended · N/M)" or "(Recommended)" suffix for display. */
  private static stripRecommendedMarker(label: string): string {
    return label.replace(/\s*\(Recommended(?:\s*·[^)]*)?\)\s*$/i, '').trim();
  }

  /**
   * Resolve recommended choiceId: explicit id (if it matches one of the options) > legacy label scan.
   * Returns undefined if neither path yields a match.
   *
   * Public so handler code (hero "Submit All Recommended") can count recommendations
   * across questions without duplicating the legacy-suffix detection logic.
   */
  static resolveRecommendedId(explicitId: string | undefined, options: UserChoiceOption[]): string | undefined {
    if (explicitId && options.some((o) => o.id === explicitId)) {
      return explicitId;
    }
    const legacy = options.find((o) => LEGACY_RECOMMENDED_SUFFIX_RE.test(o.label));
    return legacy?.id;
  }

  /**
   * Partition options into recommended + others while preserving original index
   * (used for emoji numbering so context prose like "Option B" still lines up).
   */
  private static partitionByRecommended(
    options: UserChoiceOption[],
    recommendedId: string | undefined,
  ): {
    recommended: { opt: UserChoiceOption; origIndex: number }[];
    others: { opt: UserChoiceOption; origIndex: number }[];
  } {
    const recommended: { opt: UserChoiceOption; origIndex: number }[] = [];
    const others: { opt: UserChoiceOption; origIndex: number }[] = [];
    options.forEach((opt, idx) => {
      if (recommendedId && opt.id === recommendedId) {
        recommended.push({ opt, origIndex: idx });
      } else {
        others.push({ opt, origIndex: idx });
      }
    });
    return { recommended, others };
  }

  /** Returns opt with its label cleaned (no "(Recommended...)" suffix). */
  private static sanitizeLabel(opt: UserChoiceOption): UserChoiceOption {
    const cleaned = ChoiceMessageBuilder.stripRecommendedMarker(opt.label);
    return cleaned === opt.label ? opt : { ...opt, label: cleaned };
  }

  /**
   * Build the action-area blocks for a single-choice question.
   *
   * When a recommended option is resolved:
   *   [section banner] → [actions: primary solo rec button]
   *     → [divider if others exist] → [actions: other buttons + custom_input]
   *   When ONLY the recommended exists (no others): banner → rec actions → custom_input own row.
   * When no recommended: a single actions block with all buttons + custom_input (legacy behavior).
   */
  private static buildSingleChoiceActionBlocks(choice: UserChoice, sessionKey: string, turnId?: string): any[] {
    const rawOptions = choice.choices.slice(0, 4);
    const recId = ChoiceMessageBuilder.resolveRecommendedId(choice.recommendedChoiceId, rawOptions);
    const sanitized = rawOptions.map((o) => ChoiceMessageBuilder.sanitizeLabel(o));
    const { recommended, others } = ChoiceMessageBuilder.partitionByRecommended(sanitized, recId);

    const blocks: any[] = [];

    if (recommended.length === 0) {
      // Legacy single-row path
      const buttons = sanitized.map((opt, idx) =>
        ChoiceMessageBuilder.buildChoiceButton(opt, idx, sessionKey, choice.question, false, turnId),
      );
      buttons.push(ChoiceMessageBuilder.buildCustomInputButton(sessionKey, choice.question, turnId));
      blocks.push({ type: 'actions', elements: buttons });
      return blocks;
    }

    // Banner section — escape user-controlled label for Slack mrkdwn so content like
    // `<@U123>`, `<!channel>`, or `<url|text>` can't inject mentions/links into the banner.
    const recLabel = escapeSlackMrkdwn(recommended[0].opt.label);
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `⭐ *Recommended — ${recLabel}*`,
      },
    });

    // Solo rec actions row (primary-styled)
    const recButtons = recommended.map(({ opt, origIndex }) =>
      ChoiceMessageBuilder.buildChoiceButton(opt, origIndex, sessionKey, choice.question, true, turnId),
    );
    blocks.push({ type: 'actions', elements: recButtons });

    if (others.length === 0) {
      // Only recommended — custom input on its own actions row
      blocks.push({
        type: 'actions',
        elements: [ChoiceMessageBuilder.buildCustomInputButton(sessionKey, choice.question, turnId)],
      });
      return blocks;
    }

    blocks.push({ type: 'divider' });
    const otherButtons = others.map(({ opt, origIndex }) =>
      ChoiceMessageBuilder.buildChoiceButton(opt, origIndex, sessionKey, choice.question, false, turnId),
    );
    otherButtons.push(ChoiceMessageBuilder.buildCustomInputButton(sessionKey, choice.question, turnId));
    blocks.push({ type: 'actions', elements: otherButtons });

    return blocks;
  }

  /** Build a single choice button (used by both legacy row and recommended-aware row). */
  private static buildChoiceButton(
    opt: UserChoiceOption,
    origIndex: number,
    sessionKey: string,
    question: string,
    isPrimary: boolean,
    turnId?: string,
  ): any {
    const btn: any = {
      type: 'button',
      text: {
        type: 'plain_text',
        text: `${OPTION_EMOJIS[origIndex]} ${opt.label.substring(0, 40)}`,
        emoji: true,
      },
      value: JSON.stringify({
        sessionKey,
        choiceId: opt.id,
        label: opt.label,
        question,
        ...(turnId ? { turnId } : {}),
      }),
      action_id: `user_choice_${opt.id}`,
    };
    if (isPrimary) {
      btn.style = 'primary';
    }
    return btn;
  }

  /**
   * Build Slack attachment for single user choice (Jira-style card UI)
   * Dispatches to themed layout builders based on theme parameter.
   */
  static buildUserChoiceBlocks(
    choice: UserChoice,
    sessionKey: string,
    theme?: SessionTheme,
    turnId?: string,
  ): SlackMessagePayload {
    const resolvedTheme = theme ?? 'default';

    switch (resolvedTheme) {
      case 'compact':
        return ChoiceMessageBuilder.buildThemeCompact(choice, sessionKey, turnId);
      case 'minimal':
        return ChoiceMessageBuilder.buildThemeMinimal(choice, sessionKey, turnId);
      case 'default':
      default:
        return ChoiceMessageBuilder.buildThemeDefault(choice, sessionKey, turnId);
    }
  }

  // ---------------------------------------------------------------------------
  // Helper: build standard action buttons (shared across themes)
  // ---------------------------------------------------------------------------

  private static buildCustomInputButton(sessionKey: string, question: string, turnId?: string): any {
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
        ...(turnId ? { turnId } : {}),
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

  private static buildThemeDefault(choice: UserChoice, sessionKey: string, turnId?: string): SlackMessagePayload {
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

    // Build fields for horizontal layout (2 columns) with number emojis.
    // Reorder so recommended comes first (matches action button order), but preserve origIndex emoji numbering.
    const rawOptions = choice.choices.slice(0, 4);
    const recId = ChoiceMessageBuilder.resolveRecommendedId(choice.recommendedChoiceId, rawOptions);
    const sanitized = rawOptions.map((o) => ChoiceMessageBuilder.sanitizeLabel(o));
    const { recommended, others } = ChoiceMessageBuilder.partitionByRecommended(sanitized, recId);
    const displayOrder = [...recommended, ...others];

    const fields: any[] = displayOrder.map(({ opt, origIndex }) => ({
      type: 'mrkdwn',
      text: opt.description
        ? `${OPTION_EMOJIS[origIndex]} *${opt.label}*\n_${opt.description}_`
        : `${OPTION_EMOJIS[origIndex]} *${opt.label}*`,
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

    attachmentBlocks.push(...ChoiceMessageBuilder.buildSingleChoiceActionBlocks(choice, sessionKey, turnId));

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

  private static buildThemeCompact(choice: UserChoice, sessionKey: string, turnId?: string): SlackMessagePayload {
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

    blocks.push(...ChoiceMessageBuilder.buildSingleChoiceActionBlocks(choice, sessionKey, turnId));

    return ChoiceMessageBuilder.wrapAttachment(blocks);
  }

  // ---------------------------------------------------------------------------
  // Theme: minimal — context question + buttons only
  // Based on former Theme A
  // ---------------------------------------------------------------------------

  private static buildThemeMinimal(choice: UserChoice, sessionKey: string, turnId?: string): SlackMessagePayload {
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

    blocks.push(...ChoiceMessageBuilder.buildSingleChoiceActionBlocks(choice, sessionKey, turnId));

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

    // ── Hero block: "Submit All Recommended" (group-only, recommendedChoiceId-aware) ──
    // Counts questions where resolveRecommendedId returns a real choice id
    // (excluding the custom-input sentinel '직접입력'). Three states:
    //   - N == M  → primary button (one-click submit-all)
    //   - 0 < N < M → blocked button labelled `🔒 추천 부족 (N/M)`
    //   - N == 0  → block omitted
    const heroM = choices.questions.length;
    const heroN = choices.questions.filter((q) => {
      const rid = ChoiceMessageBuilder.resolveRecommendedId(q.recommendedChoiceId, q.choices);
      return rid !== undefined && rid !== '직접입력';
    }).length;

    if (heroN > 0) {
      const heroValue = JSON.stringify({ formId, sessionKey, n: heroN, m: heroM });
      const heroButton =
        heroN === heroM
          ? {
              type: 'button',
              text: { type: 'plain_text', text: '⭐ 추천대로 모두 선택', emoji: true },
              style: 'primary',
              value: heroValue,
              action_id: `submit_all_recommended_${formId}`,
            }
          : {
              type: 'button',
              text: { type: 'plain_text', text: `🔒 추천 부족 (${heroN}/${heroM})`, emoji: true },
              value: heroValue,
              action_id: `submit_all_recommended_blocked_${formId}`,
            };
      attachmentBlocks.push({ type: 'actions', elements: [heroButton] });
    }

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

        // Options with number emojis. Reorder so the recommended option comes first,
        // but keep OPTION_EMOJIS aligned with the original index (so context prose like
        // "Option B" still matches the 2️⃣ emoji).
        const rawOptions = q.choices.slice(0, 4);
        const recId = ChoiceMessageBuilder.resolveRecommendedId(q.recommendedChoiceId, rawOptions);
        const sanitizedOptions = rawOptions.map((o) => ChoiceMessageBuilder.sanitizeLabel(o));
        const { recommended, others } = ChoiceMessageBuilder.partitionByRecommended(sanitizedOptions, recId);
        const displayOrder = [...recommended, ...others];

        const fields: any[] = displayOrder.map(({ opt, origIndex }) => ({
          type: 'mrkdwn',
          text: opt.description
            ? `${OPTION_EMOJIS[origIndex]} *${opt.label}*\n_${opt.description}_`
            : `${OPTION_EMOJIS[origIndex]} *${opt.label}*`,
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

        // Action buttons with number emojis. Recommended first (⭐ prefix + style='primary'),
        // others follow in original order. Kept inline in ONE actions block to preserve
        // the Slack 50-block message cap for multi-form.
        const buttons: any[] = displayOrder.map(({ opt, origIndex }) => {
          const isRec = recommended.length > 0 && opt.id === recommended[0].opt.id;
          const btn: any = {
            type: 'button',
            text: {
              type: 'plain_text',
              text: isRec
                ? `⭐ ${OPTION_EMOJIS[origIndex]} ${opt.label.substring(0, 22)}`
                : `${OPTION_EMOJIS[origIndex]} ${opt.label.substring(0, 22)}`,
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
          };
          if (isRec) {
            btn.style = 'primary';
          }
          return btn;
        });

        // Custom input button (always appended last; preserves the custom_input per-actions-block invariant)
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
