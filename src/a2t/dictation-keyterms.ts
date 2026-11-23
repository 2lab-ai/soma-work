/**
 * Developer & workspace vocabulary keyterms for live dictation (inspired by Claude Code's voice keyterm biasing).
 *
 * Supplies ASCII/Unicode domain terms to:
 *   - streaming ASR engines (Deepgram Nova-3 `keyterm` query params)
 *   - Whisper `initial_prompt` (combining keyterms + recent settled transcript tail within Whisper's prompt window)
 */

/** Curated software engineering & agent-workflow terms frequently mixed into Korean/English dictation. */
export const DEFAULT_DICTATION_KEYTERMS: readonly string[] = [
  'soma-work',
  'TypeScript',
  'JavaScript',
  'WebSocket',
  'MCP',
  'GitHub',
  'Pull Request',
  'PR',
  'OAuth',
  'worktree',
  'subagent',
  'codebase',
  'webhook',
  'gRPC',
  'dotfiles',
  'symlink',
  'grep',
  'regex',
  'localhost',
  'Fastify',
  'API',
  'CLI',
  'Docker',
  'Kubernetes',
  'Slack',
  'Jira',
  'deploy',
  'merge',
  'rebase',
  'commit',
  'branch',
  'CI/CD',
  'Linux',
  'macOS',
  'Wayland',
  'Whisper',
  'AU05',
  'VS Code',
  'IDE',
  'webview',
  'IntelliSense',
];

const MAX_KEYTERMS_TOTAL_CHARS = 1024;
const MAX_SINGLE_KEYTERM_CHARS = 48;
const MAX_RAW_KEYTERM_SCAN_CHARS = 128;
const DEFAULT_WHISPER_PROMPT_CHARS = 220;

function stripControlChars(s: string, asciiOnly: boolean): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (asciiOnly) {
      out += code >= 0x20 && code <= 0x7e ? s[i] : ' ';
    } else {
      out += code < 0x20 || code === 0x7f ? ' ' : s[i];
    }
  }
  return out;
}

/**
 * Sanitize, deduplicate, and bound a list of dictation keyterms.
 * Strips commas and control characters so terms remain safe for both HTTP query params and Whisper prompts.
 */
export function normalizeKeyterms(
  terms: readonly string[],
  opts: { maxChars?: number; maxCount?: number; asciiOnly?: boolean } = {},
): string[] {
  const maxChars = opts.maxChars ?? MAX_KEYTERMS_TOTAL_CHARS;
  const maxCount = opts.maxCount ?? 64;
  const asciiOnly = opts.asciiOnly ?? false;
  const seen = new Set<string>();
  const out: string[] = [];
  let used = 0;

  for (const raw of terms) {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_RAW_KEYTERM_SCAN_CHARS) continue;
    const cleaned = stripControlChars(raw.replace(/,/g, ' '), asciiOnly).replace(/\s+/g, ' ').trim();
    if (!cleaned || cleaned.length > MAX_SINGLE_KEYTERM_CHARS) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    const cost = cleaned.length + (out.length > 0 ? 2 : 0);
    if (used + cost > maxChars || out.length >= maxCount) break;
    seen.add(key);
    out.push(cleaned);
    used += cost;
  }
  return out;
}

/**
 * Merge client/config/default keyterms, prioritizing caller-provided terms first (repo, branch, session title)
 * followed by configured terms and built-in developer defaults.
 */
export function mergeDictationKeyterms(...groups: Array<readonly string[] | undefined | null>): string[] {
  const combined: string[] = [];
  for (const g of groups) {
    if (!g) continue;
    for (const term of g) combined.push(term);
  }
  return normalizeKeyterms(combined);
}

/**
 * Build a Whisper `initial_prompt` combining domain keyterms and the tail of already-settled transcript text.
 * Keeps total length within `maxChars` (default 220) without slicing a keyterm mid-word.
 */
export function buildWhisperPrompt(
  keyterms: readonly string[],
  settledTail: string,
  maxChars = DEFAULT_WHISPER_PROMPT_CHARS,
): string {
  const tail = String(settledTail || '').trim();
  const cleanTerms = normalizeKeyterms(keyterms, { maxChars: Math.max(0, maxChars) });
  if (cleanTerms.length === 0) return tail.slice(-maxChars);
  if (!tail) return cleanTerms.join(', ');

  // Reserve up to half the prompt budget (at least 100 chars when maxChars >= 160) for recent spoken context.
  const tailBudget = Math.min(tail.length, Math.max(Math.min(100, maxChars), Math.floor(maxChars * 0.55)));
  const tailPart = tail.slice(-tailBudget).trim();
  const keyBudget = maxChars - tailPart.length - 2; // ". " separator
  if (keyBudget < 12) return tailPart;

  const picked: string[] = [];
  let used = 0;
  for (const t of cleanTerms) {
    const cost = t.length + (picked.length > 0 ? 2 : 0);
    if (used + cost > keyBudget) break;
    picked.push(t);
    used += cost;
  }
  return picked.length ? `${picked.join(', ')}. ${tailPart}` : tailPart;
}
