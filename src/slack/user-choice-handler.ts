/**
 * User choice handling utilities for Slack bot
 */
import { UserChoice, UserChoices, UserChoiceQuestion, UserChoiceGroup } from '../types';

export interface ExtractedChoice {
  choice: UserChoice | null;
  choices: UserChoices | null;
  textWithoutChoice: string;
}

export interface SlackMessagePayload {
  blocks?: any[];
  attachments?: any[];
}

export class UserChoiceHandler {
  /**
   * Extract UserChoice, UserChoices, or UserChoiceGroup JSON from message text
   * Supports both ```json blocks and raw JSON objects
   */
  static extractUserChoice(text: string): ExtractedChoice {
    let choice: UserChoice | null = null;
    let choices: UserChoices | null = null;
    let textWithoutChoice = text;

    // Try to find JSON in code blocks first
    const jsonBlockPattern = /```json\s*\n?([\s\S]*?)\n?```/g;
    let match;

    while ((match = jsonBlockPattern.exec(text)) !== null) {
      const result = this.parseAndNormalizeChoice(match[1].trim());
      if (result.choice || result.choices) {
        textWithoutChoice = text.replace(match[0], '').trim();
        return { ...result, textWithoutChoice };
      }
    }

    // Try to find raw JSON objects (not in code blocks)
    const rawJsonPattern = /(\{[\s\S]*?"(?:type|question|choices)"[\s\S]*?\})\s*$/;
    const rawMatch = text.match(rawJsonPattern);

    if (rawMatch) {
      // Find the balanced JSON object
      const jsonStr = this.extractBalancedJson(text, rawMatch.index || 0);
      if (jsonStr) {
        const result = this.parseAndNormalizeChoice(jsonStr);
        if (result.choice || result.choices) {
          textWithoutChoice = text.substring(0, rawMatch.index).trim();
          return { ...result, textWithoutChoice };
        }
      }
    }

    return { choice, choices, textWithoutChoice };
  }

  /**
   * Extract a balanced JSON object starting from a given position
   */
  private static extractBalancedJson(text: string, startIndex: number): string | null {
    let braceCount = 0;
    let inString = false;
    let escape = false;
    let jsonStart = -1;

    for (let i = startIndex; i < text.length; i++) {
      const char = text[i];

      if (escape) {
        escape = false;
        continue;
      }

      if (char === '\\' && inString) {
        escape = true;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (char === '{') {
        if (braceCount === 0) jsonStart = i;
        braceCount++;
      } else if (char === '}') {
        braceCount--;
        if (braceCount === 0 && jsonStart !== -1) {
          return text.substring(jsonStart, i + 1);
        }
      }
    }

    return null;
  }

  /**
   * Parse JSON and normalize to UserChoice or UserChoices format
   * Handles UserChoiceGroup format from system.prompt
   */
  private static parseAndNormalizeChoice(jsonStr: string): { choice: UserChoice | null; choices: UserChoices | null } {
    try {
      const parsed = JSON.parse(jsonStr);

      // Format 1: UserChoices (multi-question form)
      if (parsed.type === 'user_choices' && Array.isArray(parsed.questions)) {
        return { choice: null, choices: parsed as UserChoices };
      }

      // Format 2: UserChoice (single choice with type field)
      if (parsed.type === 'user_choice') {
        const opts = parsed.choices || parsed.options;
        if (Array.isArray(opts)) {
          return {
            choice: {
              type: 'user_choice',
              question: parsed.question,
              choices: opts,
              context: parsed.context,
            },
            choices: null,
          };
        }
      }

      // Format 3: UserChoiceGroup (from system.prompt)
      // { question: "...", choices: [{ type: "user_choice", ... }] }
      if (parsed.question && Array.isArray(parsed.choices) && !parsed.type) {
        const firstChoice = parsed.choices[0];
        if (firstChoice && (firstChoice.type === 'user_choice' || firstChoice.options || firstChoice.choices)) {
          // Convert UserChoiceGroup to UserChoices for multi-question display
          const questions: UserChoiceQuestion[] = parsed.choices.map((c: any, idx: number) => ({
            id: `q${idx + 1}`,
            question: c.question,
            choices: c.options || c.choices || [],
            context: c.context,
          }));

          // If only one question, return as single choice
          if (questions.length === 1) {
            return {
              choice: {
                type: 'user_choice',
                question: questions[0].question,
                choices: questions[0].choices,
                context: questions[0].context,
              },
              choices: null,
            };
          }

          // Multiple questions - return as UserChoices
          return {
            choice: null,
            choices: {
              type: 'user_choices',
              title: parsed.question,
              description: parsed.context,
              questions,
            },
          };
        }
      }
    } catch {
      // Not valid JSON
    }

    return { choice: null, choices: null };
  }

  /**
   * Build Slack attachment for single user choice (Jira-style card UI)
   */
  static buildUserChoiceBlocks(choice: UserChoice, sessionKey: string): SlackMessagePayload {
    // Use attachment format for card-like appearance with color bar
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
        fields: fields.slice(0, 2), // First row (max 2)
      });

      if (fields.length > 2) {
        attachmentBlocks.push({
          type: 'section',
          fields: fields.slice(2, 4), // Second row
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
          color: '#0052CC', // Blue color bar (like Jira)
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
        // Completed question - show as field
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
        // Question header
        attachmentBlocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*${q.question}*`,
          },
        });

        // Context if provided
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

        // Options as fields (2 columns)
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

        // Action buttons for this question
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

    // Color based on progress
    const color = isComplete ? '#36a64f' : '#0052CC'; // Green when complete, blue otherwise

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
