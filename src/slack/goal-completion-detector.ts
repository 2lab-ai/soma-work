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

const SENTINEL_RE = /<goal-complete-request\b[^>]*\breason\s*=\s*"([^"]*)"[^>]*\/>/i;
const SENTINEL_NO_REASON_RE = /<goal-complete-request\b[^>]*\/>/i;

/** Heuristic natural-language patterns. Each pattern must imply the
 *  ASSISTANT is asserting completion (subject = "the goal" / "the
 *  objective" + verb = "appears complete" / "is complete" /
 *  "is achieved" / "has been achieved"). Avoid false positives on
 *  "the goal is to X" or "I need to make the goal complete". */
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
    return {
      reason: sentinelMatch[1].trim() || 'sentinel-emitted',
      via: 'sentinel',
    };
  }

  // Sentinel-shaped but missing reason= attribute — still honor it.
  if (SENTINEL_NO_REASON_RE.test(assistantText)) {
    return { reason: 'sentinel-emitted (reason omitted)', via: 'sentinel' };
  }

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
