/**
 * #599 ⑤ — a dashboard answer to a Slack-less task's open question, turned into
 * the next instruction's text exactly as the Slack path builds it
 * (`src/slack/actions/choice-action-handler.ts`): a single choice is its id; a
 * form is one `question: id. label` line per question, a custom input
 * `question: (직접입력) text`. Pure: a refusal touches nothing.
 */
import { ChoiceMessageBuilder } from '@soma/slack/choice-message-builder';

export type TaskAnswer =
  | { kind: 'single'; choiceId: string }
  | { kind: 'multi'; selections: Record<string, { choiceId: string; label: string }> }
  | { kind: 'recommended' };

export type TaskAnswerText = { ok: true; text: string } | { ok: false; status: 409 | 422; error: string };

/** The Slack form's "type your own" choice id (`choice-action-handler.ts`). */
export const CUSTOM_INPUT_CHOICE_ID = '직접입력';

interface Choice {
  id: string;
  label: string;
}
interface FormQuestion {
  id: string;
  question: string;
  choices?: Choice[];
  recommendedChoiceId?: string;
}

export function buildTaskAnswerText(question: unknown, answer: TaskAnswer): TaskAnswerText {
  const q = (question ?? {}) as { type?: string; choices?: Choice[]; questions?: FormQuestion[] };
  if (answer.kind === 'single') {
    if (q.type !== 'user_choice') return changed();
    if (!(q.choices ?? []).some((c) => c.id === answer.choiceId)) return invalid('Invalid choice ID');
    return { ok: true, text: answer.choiceId };
  }
  if (q.type !== 'user_choices' || !q.questions?.length) return changed();
  let selections: Record<string, { choiceId: string; label: string }>;
  if (answer.kind === 'recommended') {
    selections = {};
    for (const fq of q.questions) {
      const choices = fq.choices ?? [];
      const id = ChoiceMessageBuilder.resolveRecommendedId(fq.recommendedChoiceId, choices);
      const choice = id ? choices.find((c) => c.id === id) : undefined;
      if (!choice) return invalid('Recommendations incomplete');
      selections[fq.id] = { choiceId: choice.id, label: choice.label };
    }
  } else {
    selections = answer.selections;
  }
  const lines: string[] = [];
  for (const fq of q.questions) {
    const sel = selections[fq.id];
    if (!sel?.choiceId || !sel.label) return invalid(`Missing answer for question: ${fq.id}`);
    if (sel.choiceId === CUSTOM_INPUT_CHOICE_ID) {
      lines.push(`${fq.question}: (직접입력) ${sel.label}`);
      continue;
    }
    if (!(fq.choices ?? []).some((c) => c.id === sel.choiceId)) return invalid('Invalid choice ID');
    lines.push(`${fq.question}: ${sel.choiceId}. ${sel.label}`);
  }
  return { ok: true, text: lines.join('\n') };
}

function changed(): TaskAnswerText {
  return { ok: false, status: 409, error: 'the question has changed — reload' };
}

function invalid(error: string): TaskAnswerText {
  return { ok: false, status: 422, error };
}
