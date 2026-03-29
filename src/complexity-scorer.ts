/**
 * Complexity Scoring Engine
 *
 * Scores user input complexity across lexical and structural dimensions.
 * Pure function — no LLM calls, no I/O. Fast and deterministic.
 *
 * Tiers:
 *   LOW    (0–4)  — simple queries, formatting, lookups
 *   MEDIUM (5–9)  — standard implementation, refactoring
 *   HIGH   (10+)  — architecture, complex reasoning, multi-system changes
 *
 * @see https://github.com/2lab-ai/soma-work/issues/164
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ComplexityTier = 'LOW' | 'MEDIUM' | 'HIGH';

export interface ComplexitySignal {
  /** Which dimension produced this signal */
  category: 'lexical' | 'structural';
  /** Machine-readable signal name */
  name: string;
  /** Human-readable description */
  description: string;
  /** Points contributed (can be negative) */
  points: number;
}

export interface ComplexityResult {
  /** Raw score (floor = 0) */
  score: number;
  /** Tier derived from score */
  tier: ComplexityTier;
  /** All signals that fired */
  signals: ComplexitySignal[];
}

// ---------------------------------------------------------------------------
// Keyword sets (Korean + English)
// ---------------------------------------------------------------------------

const ARCHITECTURE_KEYWORDS = [
  '아키텍처', '설계', '마이그레이션', '리팩토링', '리팩터링',
  'architecture', 'design', 'migration', 'refactor', 'refactoring',
  '마이크로서비스', 'microservice', 'monorepo',
];

const DEBUG_KEYWORDS = [
  '에러', '버그', '크래시', '오류', '장애', '실패',
  'error', 'bug', 'crash', 'exception', 'failure', 'broken',
];

const SIMPLICITY_KEYWORDS = [
  '간단히', '간단하게', '조회', '확인', '알려줘', '뭐야',
  'simple', 'simply', 'just', 'quick', 'briefly',
];

const CROSS_FILE_KEYWORDS = [
  '여러 파일', 'cross-cutting', 'cross-file', '전반적',
  '여러 모듈', '다수의 파일', 'multiple files', 'across files',
];

const SYSTEM_WIDE_KEYWORDS = [
  '전체 시스템', '전역', '시스템 전체', '전체적',
  'system-wide', 'global', 'entire system', 'all modules',
];

const IRREVERSIBILITY_KEYWORDS = [
  '되돌리기 어려', '롤백 불가', '비가역', '파괴적',
  'irreversible', 'destructive', 'cannot rollback', 'breaking change',
];

const TEST_KEYWORDS = [
  '테스트', 'test', 'spec', '검증', 'verify', 'vitest', 'jest',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countWords(text: string): number {
  // Split on whitespace, filter empties
  return text.split(/\s+/).filter(Boolean).length;
}

function countMatches(text: string, keywords: string[]): number {
  const lower = text.toLowerCase();
  return keywords.filter((kw) => lower.includes(kw.toLowerCase())).length;
}

function hasAny(text: string, keywords: string[]): boolean {
  return countMatches(text, keywords) > 0;
}

/** Count file-path-like tokens (e.g. src/foo.ts, ./bar/baz.js) */
function countFilePaths(text: string): number {
  const pattern = /(?:^|\s|,)(\.{0,2}\/)?[\w./-]+\.\w{1,5}(?=\s|,|$)/gm;
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

/** Count fenced code blocks */
function countCodeBlocks(text: string): number {
  const matches = text.match(/```/g);
  // Each code block has opening + closing = 2 backtick fences
  return matches ? Math.floor(matches.length / 2) : 0;
}

/** Count numbered list items (1. 2. 3. …) */
function countNumberedItems(text: string): number {
  const matches = text.match(/^\s*\d+[.)]\s/gm);
  return matches ? matches.length : 0;
}

/** Count bullet list items (- or * at line start) */
function countBulletItems(text: string): number {
  const matches = text.match(/^\s*[-*]\s/gm);
  return matches ? matches.length : 0;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function collectLexicalSignals(text: string): ComplexitySignal[] {
  const signals: ComplexitySignal[] = [];
  const wordCount = countWords(text);

  // Word count signals
  if (wordCount > 500) {
    signals.push({
      category: 'lexical',
      name: 'very_long_message',
      description: `Message has ${wordCount} words (>500)`,
      points: 3,
    });
  } else if (wordCount > 200) {
    signals.push({
      category: 'lexical',
      name: 'long_message',
      description: `Message has ${wordCount} words (>200)`,
      points: 2,
    });
  }

  // Architecture keywords
  const archCount = countMatches(text, ARCHITECTURE_KEYWORDS);
  if (archCount > 0) {
    signals.push({
      category: 'lexical',
      name: 'architecture_keywords',
      description: `Found ${archCount} architecture keyword(s)`,
      points: 3,
    });
  }

  // Debug keywords
  const debugCount = countMatches(text, DEBUG_KEYWORDS);
  if (debugCount > 0) {
    signals.push({
      category: 'lexical',
      name: 'debug_keywords',
      description: `Found ${debugCount} debug keyword(s)`,
      points: 2,
    });
  }

  // Simplicity keywords (negative)
  const simpleCount = countMatches(text, SIMPLICITY_KEYWORDS);
  if (simpleCount > 0) {
    signals.push({
      category: 'lexical',
      name: 'simplicity_keywords',
      description: `Found ${simpleCount} simplicity keyword(s)`,
      points: -2,
    });
  }

  // Multiple file paths
  const filePaths = countFilePaths(text);
  if (filePaths >= 3) {
    signals.push({
      category: 'lexical',
      name: 'multiple_file_paths',
      description: `Found ${filePaths} file paths (≥3)`,
      points: 2,
    });
  }

  // Multiple code blocks
  const codeBlocks = countCodeBlocks(text);
  if (codeBlocks >= 2) {
    signals.push({
      category: 'lexical',
      name: 'multiple_code_blocks',
      description: `Found ${codeBlocks} code blocks (≥2)`,
      points: 1,
    });
  }

  return signals;
}

function collectStructuralSignals(text: string): ComplexitySignal[] {
  const signals: ComplexitySignal[] = [];

  // Subtask counting (numbered + bullet)
  const numbered = countNumberedItems(text);
  const bullets = countBulletItems(text);
  const subtasks = numbered + bullets;

  if (subtasks >= 6) {
    signals.push({
      category: 'structural',
      name: 'many_subtasks',
      description: `Found ${subtasks} subtasks (≥6)`,
      points: 4,
    });
  } else if (subtasks >= 2) {
    signals.push({
      category: 'structural',
      name: 'subtasks',
      description: `Found ${subtasks} subtasks (2–5)`,
      points: 2,
    });
  }

  // Cross-file change
  if (hasAny(text, CROSS_FILE_KEYWORDS)) {
    signals.push({
      category: 'structural',
      name: 'cross_file_change',
      description: 'Cross-file change indicators detected',
      points: 2,
    });
  }

  // Test required
  if (hasAny(text, TEST_KEYWORDS)) {
    signals.push({
      category: 'structural',
      name: 'test_required',
      description: 'Test requirement mentioned',
      points: 1,
    });
  }

  // Irreversibility
  if (hasAny(text, IRREVERSIBILITY_KEYWORDS)) {
    signals.push({
      category: 'structural',
      name: 'irreversible',
      description: 'Irreversible / hard-to-rollback change indicated',
      points: 2,
    });
  }

  // System-wide impact
  if (hasAny(text, SYSTEM_WIDE_KEYWORDS)) {
    signals.push({
      category: 'structural',
      name: 'system_wide_impact',
      description: 'System-wide impact indicated',
      points: 3,
    });
  }

  return signals;
}

function tierFromScore(score: number): ComplexityTier {
  if (score >= 10) return 'HIGH';
  if (score >= 5) return 'MEDIUM';
  return 'LOW';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Score the complexity of a user message.
 *
 * Pure function — deterministic, no side effects, no LLM calls.
 * Runs in < 1ms for typical messages.
 */
export function scoreComplexity(text: string): ComplexityResult {
  const signals = [
    ...collectLexicalSignals(text),
    ...collectStructuralSignals(text),
  ];

  const rawScore = signals.reduce((sum, s) => sum + s.points, 0);
  const score = Math.max(0, rawScore); // floor at 0

  return {
    score,
    tier: tierFromScore(score),
    signals,
  };
}
