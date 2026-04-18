import type { UserChoice, UserChoiceQuestion, UserChoices } from '../types';

export interface ExtractedChoice {
  choice: UserChoice | null;
  choices: UserChoices | null;
  textWithoutChoice: string;
}

function validateRecommendedChoiceId(raw: unknown, opts: { id: string }[]): string | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  return opts.some((o) => o.id === raw) ? raw : undefined;
}

/**
 * JSON 추출 및 파싱 로직
 */
export class UserChoiceExtractor {
  /**
   * Extract UserChoice, UserChoices, or UserChoiceGroup JSON from message text
   * Supports both ```json blocks and raw JSON objects
   */
  static extractUserChoice(text: string): ExtractedChoice {
    const choice: UserChoice | null = null;
    const choices: UserChoices | null = null;
    let textWithoutChoice = text;

    // Try to find JSON in code blocks first
    const jsonBlockPattern = /```json\s*\n?([\s\S]*?)\n?```/g;
    let match;

    while ((match = jsonBlockPattern.exec(text)) !== null) {
      const result = UserChoiceExtractor.parseAndNormalizeChoice(match[1].trim());
      if (result.choice || result.choices) {
        textWithoutChoice = text.replace(match[0], '').trim();
        return { ...result, textWithoutChoice };
      }
    }

    // Try to find raw JSON objects (not in code blocks)
    const jsonStartPattern = /\{\s*"(?:type|question)"\s*:/g;
    let rawMatch;

    while ((rawMatch = jsonStartPattern.exec(text)) !== null) {
      const jsonStr = UserChoiceExtractor.extractBalancedJson(text, rawMatch.index);
      if (jsonStr) {
        const result = UserChoiceExtractor.parseAndNormalizeChoice(jsonStr);
        if (result.choice || result.choices) {
          textWithoutChoice = text.substring(0, rawMatch.index).trim();
          return {
            choice: result.choice,
            choices: result.choices,
            textWithoutChoice,
          };
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
   */
  private static parseAndNormalizeChoice(jsonStr: string): { choice: UserChoice | null; choices: UserChoices | null } {
    try {
      const parsed = JSON.parse(jsonStr);

      // Format 1: UserChoices (multi-question form)
      if (parsed.type === 'user_choices' && Array.isArray(parsed.questions)) {
        const normalizedQuestions: UserChoiceQuestion[] = parsed.questions.map((q: any, idx: number) => {
          const subOpts = Array.isArray(q?.choices) ? q.choices : Array.isArray(q?.options) ? q.options : [];
          return {
            id: typeof q?.id === 'string' && q.id ? q.id : `q${idx + 1}`,
            question: q?.question,
            choices: subOpts,
            context: q?.context,
            recommendedChoiceId: validateRecommendedChoiceId(q?.recommendedChoiceId, subOpts),
          };
        });
        return {
          choice: null,
          choices: {
            type: 'user_choices',
            title: parsed.title,
            description: parsed.description,
            questions: normalizedQuestions,
          },
        };
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
              recommendedChoiceId: validateRecommendedChoiceId(parsed.recommendedChoiceId, opts),
            },
            choices: null,
          };
        }
      }

      // Format 3: UserChoiceGroup (from system.prompt)
      if (parsed.question && Array.isArray(parsed.choices) && (!parsed.type || parsed.type === 'user_choice_group')) {
        const firstChoice = parsed.choices[0];
        if (firstChoice && (firstChoice.type === 'user_choice' || firstChoice.options || firstChoice.choices)) {
          const questions: UserChoiceQuestion[] = parsed.choices.map((c: any, idx: number) => {
            const subOpts = c.options || c.choices || [];
            return {
              id: `q${idx + 1}`,
              question: c.question,
              choices: subOpts,
              context: c.context,
              recommendedChoiceId: validateRecommendedChoiceId(c.recommendedChoiceId, subOpts),
            };
          });

          if (questions.length === 1) {
            return {
              choice: {
                type: 'user_choice',
                question: questions[0].question,
                choices: questions[0].choices,
                context: questions[0].context,
                recommendedChoiceId: questions[0].recommendedChoiceId,
              },
              choices: null,
            };
          }

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
}
