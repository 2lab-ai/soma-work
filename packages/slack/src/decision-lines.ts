/**
 * #1073 — decision lines on a question card (Plannotator Inbox P2, epic #1076).
 *
 * A question may say what its answer is holding up, what is at stake, and whether the choice can be undone (and
 * why), so the person can answer from the card alone. Most questions carry none of this, and then nothing here adds a
 * block — the card is byte-identical to one without the feature.
 *
 * On Slack the lines are ONE context block (the 50-block message cap: a multi form chunk of 6 questions stays at 45),
 * one mrkdwn element, one line per field, always in this order:
 *
 *   🚧 막힌 작업 — <blockedWork>
 *   ⚖️ 걸린 것 — <stakes>
 *   ⚠️ *되돌릴 수 없음* — <reversibleWhy>     (reversible: false)
 *   ↩️ 되돌릴 수 있음 — <reversibleWhy>       (reversible: true)
 *
 * ` — ` is one of the display translator's separators, so an English reader gets the label in English even when the
 * model wrote the value in Korean (en-text.json has the bare labels). The dashboard's client `decisionLines(q, md)`
 * renders the same words in the same order (dashboard-decision-lines.test.ts D8 holds the two together).
 *
 * The normalizer mirrors somalib's `normalizeDecisionFields` (the validator and the dashboard projection use that
 * one); this package does not import somalib, so it keeps its own copy for the no-tool path (the fenced-JSON
 * extractor) and as the renderer's own defense. src/__tests__/decision-fields-parity.test.ts holds both to one table.
 */

import { escapeSlackMrkdwn } from './mrkdwn-escape';

/** The decision lines of a question. All optional. */
export interface DecisionFields {
  /** The work this answer is holding up. */
  blockedWork?: string;
  /** What is at stake in the choice. */
  stakes?: string;
  /** Whether the choice can be undone (`false` is shown prominently). */
  reversible?: boolean;
  /** Why it can or cannot be undone. Kept only with `reversible`. */
  reversibleWhy?: string;
}

/** A decision line's longest value: one line; three escaped lines stay under Slack's 3000-char text limit. */
export const DECISION_LINE_MAX_CHARS = 160;

/**
 * The decision fields of a raw question: text is one line (whitespace runs and line breaks become one space, ends
 * trimmed) of at most {@link DECISION_LINE_MAX_CHARS} code points (cut with '…'); blank or non-string text is dropped.
 * `reversible` is a boolean, or the strings true/false/yes/no; anything else is dropped and the why with it.
 * Idempotent. Returns only the fields that are present.
 */
export function normalizeDecisionFields(raw: unknown): DecisionFields {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const out: DecisionFields = {};
  const blockedWork = lineText(r.blockedWork);
  if (blockedWork) out.blockedWork = blockedWork;
  const stakes = lineText(r.stakes);
  if (stakes) out.stakes = stakes;
  const reversible = reversibleOf(r.reversible);
  if (reversible !== undefined) {
    out.reversible = reversible;
    const why = lineText(r.reversibleWhy);
    if (why) out.reversibleWhy = why;
  }
  return out;
}

function lineText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const line = value.replace(/\s+/g, ' ').trim();
  if (!line) return undefined;
  const chars = Array.from(line);
  return chars.length > DECISION_LINE_MAX_CHARS ? `${chars.slice(0, DECISION_LINE_MAX_CHARS - 1).join('')}…` : line;
}

function reversibleOf(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const word = value.trim().toLowerCase();
  if (word === 'true' || word === 'yes') return true;
  if (word === 'false' || word === 'no') return false;
  return undefined;
}

/** The lines as Slack mrkdwn, in order: model text escaped (no mention or link injection), the irreversible label bold. */
export function decisionLinesMrkdwn(question: unknown): string[] {
  const f = normalizeDecisionFields(question);
  const lines: string[] = [];
  if (f.blockedWork) lines.push(`🚧 막힌 작업 — ${escapeSlackMrkdwn(f.blockedWork)}`);
  if (f.stakes) lines.push(`⚖️ 걸린 것 — ${escapeSlackMrkdwn(f.stakes)}`);
  if (f.reversible !== undefined) {
    const label = f.reversible ? '↩️ 되돌릴 수 있음' : '⚠️ *되돌릴 수 없음*';
    lines.push(f.reversibleWhy ? `${label} — ${escapeSlackMrkdwn(f.reversibleWhy)}` : label);
  }
  return lines;
}

/** The question's decision lines as one context block, or null when it has none (then the card is unchanged). */
export function buildDecisionLinesBlock(
  question: unknown,
): { type: 'context'; elements: Array<{ type: 'mrkdwn'; text: string }> } | null {
  const lines = decisionLinesMrkdwn(question);
  if (lines.length === 0) return null;
  return { type: 'context', elements: [{ type: 'mrkdwn', text: lines.join('\n') }] };
}
