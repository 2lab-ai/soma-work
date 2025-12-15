/**
 * User choice handling utilities for Slack bot
 */
import { UserChoice, UserChoices, UserChoiceQuestion } from '../types';

export interface ExtractedChoice {
  choice: UserChoice | null;
  choices: UserChoices | null;
  textWithoutChoice: string;
}

export class UserChoiceHandler {
  /**
   * Extract UserChoice or UserChoices JSON from message text
   * Looks for ```json blocks containing user_choice or user_choices type
   */
  static extractUserChoice(text: string): ExtractedChoice {
    const jsonBlockPattern = /```json\s*\n?([\s\S]*?)\n?```/g;
    let match;
    let choice: UserChoice | null = null;
    let choices: UserChoices | null = null;
    let textWithoutChoice = text;

    while ((match = jsonBlockPattern.exec(text)) !== null) {
      try {
        const parsed = JSON.parse(match[1].trim());

        // Check for multi-question format first
        if (parsed.type === 'user_choices' && Array.isArray(parsed.questions)) {
          choices = parsed as UserChoices;
          textWithoutChoice = text.replace(match[0], '').trim();
          break;
        }

        // Check for single question format
        if (parsed.type === 'user_choice' && Array.isArray(parsed.choices)) {
          choice = parsed as UserChoice;
          textWithoutChoice = text.replace(match[0], '').trim();
          break;
        }
      } catch {
        // Not valid JSON, continue
      }
    }

    return { choice, choices, textWithoutChoice };
  }

  /**
   * Build Slack blocks for single user choice buttons
   */
  static buildUserChoiceBlocks(choice: UserChoice, sessionKey: string): any[] {
    const blocks: any[] = [];

    // Add question as section
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `🔹 *${choice.question}*`,
      },
    });

    // Add context if provided
    if (choice.context) {
      blocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: choice.context,
          },
        ],
      });
    }

    // Build button elements (max 4 to leave room for custom input)
    const buttons: any[] = choice.choices.slice(0, 4).map((opt) => ({
      type: 'button',
      text: {
        type: 'plain_text',
        text: `${opt.id}. ${opt.label}`.substring(0, 75), // Slack limit
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

    // Add custom input button
    buttons.push({
      type: 'button',
      text: {
        type: 'plain_text',
        text: '✏️ 직접 입력',
        emoji: true,
      },
      style: 'primary',
      value: JSON.stringify({
        sessionKey,
        question: choice.question,
        type: 'single',
      }),
      action_id: 'custom_input_single',
    });

    blocks.push({
      type: 'actions',
      elements: buttons,
    });

    // Add descriptions if any choices have them
    const descriptions = choice.choices
      .filter((opt) => opt.description)
      .map((opt) => `*${opt.id}.* ${opt.description}`)
      .join('\n');

    if (descriptions) {
      blocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: descriptions,
          },
        ],
      });
    }

    return blocks;
  }

  /**
   * Build Slack blocks for multi-question choice form
   */
  static buildMultiChoiceFormBlocks(
    choices: UserChoices,
    formId: string,
    sessionKey: string,
    selections: Record<string, { choiceId: string; label: string }> = {}
  ): any[] {
    const blocks: any[] = [];

    // Header with title
    blocks.push({
      type: 'header',
      text: {
        type: 'plain_text',
        text: choices.title || '📋 선택이 필요합니다',
        emoji: true,
      },
    });

    // Description if provided
    if (choices.description) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: choices.description,
        },
      });
    }

    blocks.push({ type: 'divider' });

    // Build each question
    choices.questions.forEach((q, idx) => {
      const isSelected = !!selections[q.id];
      const selectedChoice = selections[q.id];

      // Question header with selection status
      const questionText = isSelected
        ? `✅ *${idx + 1}. ${q.question}*\n_선택됨: ${selectedChoice.choiceId}. ${selectedChoice.label}_`
        : `🔹 *${idx + 1}. ${q.question}*`;

      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: questionText,
        },
      });

      // Context if provided
      if (q.context && !isSelected) {
        blocks.push({
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: q.context,
            },
          ],
        });
      }

      // Show buttons only if not yet selected
      if (!isSelected) {
        // Max 4 choices to leave room for custom input button
        const buttons: any[] = q.choices.slice(0, 4).map((opt) => ({
          type: 'button',
          text: {
            type: 'plain_text',
            text: `${opt.id}. ${opt.label}`.substring(0, 75),
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

        // Add custom input button
        buttons.push({
          type: 'button',
          text: {
            type: 'plain_text',
            text: '✏️ 직접 입력',
            emoji: true,
          },
          style: 'primary',
          value: JSON.stringify({
            formId,
            sessionKey,
            questionId: q.id,
            question: q.question,
            type: 'multi',
          }),
          action_id: `custom_input_multi_${formId}_${q.id}`,
        });

        blocks.push({
          type: 'actions',
          elements: buttons,
        });

        // Descriptions
        const descriptions = q.choices
          .filter((opt) => opt.description)
          .map((opt) => `*${opt.id}.* ${opt.description}`)
          .join('\n');

        if (descriptions) {
          blocks.push({
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: descriptions,
              },
            ],
          });
        }
      }

      // Add spacing between questions
      if (idx < choices.questions.length - 1) {
        blocks.push({ type: 'divider' });
      }
    });

    // Progress indicator
    const totalQuestions = choices.questions.length;
    const answeredCount = Object.keys(selections).length;
    const progressText = `진행: ${answeredCount}/${totalQuestions}`;

    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: answeredCount === totalQuestions
            ? `✅ *모든 선택 완료!* 잠시 후 자동으로 진행됩니다...`
            : `⏳ ${progressText} - 모든 항목을 선택하면 자동으로 진행됩니다`,
        },
      ],
    });

    return blocks;
  }
}
