/**
 * Fun-fact table for `/usage card` — maps token totals to human-scale references.
 * Trace: docs/usage-card/trace.md, Scenario 4
 */

interface FunFactEntry {
  name: string;
  tokens: number;
  emoji?: string;
}

// Approximations — rough token counts (1 token ≈ 4 chars English, less for Korean).
export const FUN_FACTS: ReadonlyArray<FunFactEntry> = [
  { name: 'Fahrenheit 451', tokens: 60_000, emoji: '📕' },
  { name: '해리 포터와 마법사의 돌', tokens: 110_000, emoji: '📘' },
  { name: '반지의 제왕 3부작', tokens: 600_000, emoji: '📚' },
  { name: '대영 백과사전', tokens: 40_000_000, emoji: '📖' },
  { name: '국회도서관 전체 장서', tokens: 50_000_000_000, emoji: '🏛️' },
];

export function pickFunFact(totalTokens: number): string {
  if (totalTokens <= 0) return '아직 첫 문단 분량입니다.';

  // Find largest entry ≤ totalTokens; otherwise fall back to smallest.
  let choice: FunFactEntry = FUN_FACTS[0];
  for (const e of FUN_FACTS) {
    if (e.tokens <= totalTokens) choice = e;
    else break;
  }
  const multiple = totalTokens / choice.tokens;
  const emoji = choice.emoji ?? '';
  if (multiple >= 1) {
    return `${emoji} ~${multiple.toFixed(1)}x ${choice.name} 분량`;
  }
  const fraction = Math.round(multiple * 100);
  return `${emoji} ${choice.name}의 약 ${fraction}% 분량`;
}
