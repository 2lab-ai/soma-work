/**
 * Detect "the work model thinks the goal is complete" signals in an
 * assistant turn's text output. Two paths:
 *
 *   1. The explicit sentinel `<goal-complete-request reason="..."/>`
 *      documented in the continuation prompt. This is the contract.
 *
 *   2. A natural-language safety net for the case where the model
 *      forgets the sentinel but clearly states completion. The
 *      patterns are intentionally narrow — we only match phrases
 *      that mean "I, the assistant, believe the goal is done", not
 *      "the goal is X" descriptive talk.
 *
 * The detector never mutates state. The slack-handler decides what
 * to do with a `pendingEval` request based on the returned signal.
 */

export interface GoalCompletionSignal {
  reason: string;
  /** Which path matched — useful for logs and audit. */
  via: 'sentinel' | 'natural-language';
}

// Single regex covering both the canonical sentinel and the
// reason-omitted variant. `reason` accepts single or double quotes;
// the attribute is optional. `[\s\S]` (not `[^>]`) lets the tag
// span line breaks — the prompt mandates "on its own line" but
// assistants reflow. Capture group 1 = double-quoted reason,
// group 2 = single-quoted reason; both empty when the attribute
// is absent.
const SENTINEL_RE = /<goal-complete-request\b(?:[\s\S]*?\breason\s*=\s*(?:"([^"]*)"|'([^']*)'))?[\s\S]*?\/>/i;

// Cheap prefix gate for the NL safety net. Skips the six-regex
// sweep below for any turn that mentions neither "goal" nor
// "objective" — the overwhelming majority of assistant turns.
const NL_GATE_RE = /\b(?:goal|objective)\b/i;

/** Natural-language patterns. Each must imply the ASSISTANT is
 *  asserting completion (subject = "the goal" / "the objective" +
 *  verb = "appears complete" / "is complete" / "is achieved" /
 *  "has been achieved"). Narrow enough to reject "the goal is to X"
 *  and "I need to make the goal complete". */
const NL_PATTERNS: RegExp[] = [
  /\bthe\s+goal\s+appears\s+complete\b/i,
  /\bthe\s+goal\s+is\s+(?:now\s+)?complete\b/i,
  /\bthe\s+objective\s+appears\s+(?:to\s+be\s+)?(?:complete|achieved|met|finished)\b/i,
  /\bthe\s+objective\s+is\s+(?:now\s+)?(?:complete|achieved|met|finished)\b/i,
  /\bi\s+believe\s+the\s+(?:goal|objective)\s+(?:is|appears)\s+(?:complete|achieved)\b/i,
  /\bthe\s+goal\s+has\s+been\s+(?:fully\s+)?(?:achieved|completed|met)\b/i,
];

export function detectGoalCompletionSignal(assistantText: string): GoalCompletionSignal | undefined {
  if (!assistantText) return undefined;

  const sentinelMatch = assistantText.match(SENTINEL_RE);
  if (sentinelMatch) {
    const reason = (sentinelMatch[1] ?? sentinelMatch[2] ?? '').trim();
    return {
      reason: reason || 'sentinel-emitted (reason omitted)',
      via: 'sentinel',
    };
  }

  if (!NL_GATE_RE.test(assistantText)) return undefined;

  for (const re of NL_PATTERNS) {
    const m = assistantText.match(re);
    if (m) {
      return {
        reason: extractSurroundingSentence(assistantText, m.index ?? 0).slice(0, 600),
        via: 'natural-language',
      };
    }
  }

  return undefined;
}

function extractSurroundingSentence(text: string, idx: number): string {
  // Scan back to nearest sentence boundary or 200 chars, whichever
  // is closer, then forward to next . / ! / ? / newline.
  const start = Math.max(0, text.lastIndexOf('\n', idx - 1) + 1, idx - 200);
  let end = text.length;
  for (const stop of ['\n', '. ', '! ', '? ']) {
    const i = text.indexOf(stop, idx);
    if (i !== -1 && i < end) end = i + stop.length;
  }
  return text.slice(start, end).trim();
}
