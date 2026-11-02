/**
 * 세션 링크 자동 기록 (SSOT 2026-11-02 goal: "작업 카드에 디폴트로 표시해야 하는 중요한 것: 연결된 이슈(지라 혹은
 * 깃허브 이슈)들과 이슈 상태, 연결된 PR들과 머지 상태, 연결된 위키들").
 *
 * The task card shows the session's linked issues, PRs and wikis (`linkHistory`), but a link used to be recorded only
 * from the first user message, a `session_links` directive or the `link` command — on dev, 2 of the last 55 sessions
 * had one. These find the links a conversation already names, so the host can record them:
 *
 *   - {@link linksInText}: every issue, PR and wiki URL in a text (a user message, an assistant reply) — outside
 *     code (fenced or inline) and quotes, where pasted logs and listings live;
 *   - {@link linksCreatedByTools}: the PR or issue a `gh pr create` / `gh issue create` just made (its output ends
 *     with the new page's URL);
 *   - {@link canonicalLinkUrl}: the one form of a link's URL (`/pull/12/files?x` is `/pull/12`), to compare by.
 *
 * Pure: no I/O.
 */
import type { SessionLink } from './thread-header-builder';

export type CapturedLinkType = 'issue' | 'pr' | 'doc';
/** The host's providers (src/types.ts SessionLink); a GitLab MR and a Notion page are 'unknown'. */
export type CapturedLinkProvider = 'github' | 'jira' | 'confluence' | 'linear' | 'unknown';
export interface CapturedLink extends SessionLink {
  type: CapturedLinkType;
  provider: CapturedLinkProvider;
}

/** At most this many links are taken from one text (a pasted list must not flood the card). */
export const MAX_LINKS_PER_TEXT = 10;

// A URL in plain text, Slack mrkdwn (`<url|label>`, `<url>`) or Markdown (`[label](url)`): stops at white space and
// at the characters those formats wrap a URL in.
const URL_RE = /https?:\/\/[^\s<>|()[\]"'`]+/g;
const TRAILING = new Set(['.', ',', ';', ':', '!', '?', '*', '_', '~']);
/** Longer is not a link anyone pasted: skipped (and keeps every match linear). */
const MAX_URL_LENGTH = 2048;

function trimTrailing(url: string): string {
  let end = url.length;
  while (end > 0 && TRAILING.has(url[end - 1])) end--;
  return url.slice(0, end);
}

// What a text quotes rather than says: fenced code, inline code, and quote lines (Slack sends `>` as `&gt;`).
function prose(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .split('\n')
    .filter((line) => !/^\s*(?:>|&gt;)/.test(line))
    .join('\n');
}

interface Rule {
  re: RegExp;
  type: CapturedLinkType;
  provider: CapturedLinkProvider;
  label: (m: RegExpMatchArray) => string;
}

// Each rule matches a whole URL and gives its canonical form (the match), so `…/pull/12/files` and `…/pull/12` are
// one link.
const RULES: Rule[] = [
  {
    re: /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/,
    type: 'pr',
    provider: 'github',
    label: (m) => `PR #${m[1]}`,
  },
  {
    re: /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/(\d+)/,
    type: 'issue',
    provider: 'github',
    label: (m) => `#${m[1]}`,
  },
  {
    re: /^https:\/\/gitlab\.com\/[\w./-]+?\/-\/merge_requests\/(\d+)/,
    type: 'pr',
    // The host's SessionLink providers are github · jira · confluence · linear · unknown.
    provider: 'unknown',
    label: (m) => `MR !${m[1]}`,
  },
  {
    re: /^https:\/\/[\w-]+\.atlassian\.net\/browse\/([A-Z][A-Z0-9]+-\d+)/,
    type: 'issue',
    provider: 'jira',
    label: (m) => m[1],
  },
  {
    re: /^https:\/\/linear\.app\/[\w-]+\/issue\/([A-Za-z][A-Za-z0-9]+-\d+)/,
    type: 'issue',
    provider: 'linear',
    label: (m) => m[1].toUpperCase(),
  },
  {
    re: /^https:\/\/[\w-]+\.atlassian\.net\/wiki\/spaces\/[^/\s]+\/pages\/\d+(?:\/[^?#\s]*)?/,
    type: 'doc',
    provider: 'confluence',
    label: () => 'Confluence',
  },
  {
    re: /^https:\/\/(?:www\.)?notion\.so\/[^?#\s]+/,
    type: 'doc',
    provider: 'unknown',
    label: () => 'Notion',
  },
];

/** The link a URL names, or undefined when it is not an issue, a PR or a wiki page. */
export function classifyLinkUrl(raw: string): CapturedLink | undefined {
  if (typeof raw !== 'string' || raw.length > MAX_URL_LENGTH) return undefined;
  const url = trimTrailing(raw);
  for (const rule of RULES) {
    const m = url.match(rule.re);
    if (m) return { url: m[0], type: rule.type, provider: rule.provider, label: rule.label(m) };
  }
  return undefined;
}

/** The one form of a link's URL: an issue, PR or wiki URL's canonical form, any other URL as it is. */
export function canonicalLinkUrl(url: string): string {
  return classifyLinkUrl(url)?.url ?? url;
}

/**
 * Every issue, PR and wiki URL a text says (not in code or quotes), in the order they appear, each once — at most
 * {@link MAX_LINKS_PER_TEXT}.
 */
export function linksInText(text: unknown): CapturedLink[] {
  if (typeof text !== 'string' || !text.includes('http')) return [];
  const out: CapturedLink[] = [];
  const seen = new Set<string>();
  for (const m of prose(text).matchAll(URL_RE)) {
    const link = classifyLinkUrl(m[0]);
    if (!link || seen.has(link.url)) continue;
    seen.add(link.url);
    out.push(link);
    if (out.length >= MAX_LINKS_PER_TEXT) break;
  }
  return out;
}

interface ToolResultLike {
  toolUseId?: string;
  toolName?: string;
  result?: unknown;
  isError?: boolean;
}

/** A Bash command that creates a GitHub PR or issue. */
export function isCreateCommand(command: unknown): boolean {
  return typeof command === 'string' && /\bgh\s+(?:pr|issue)\s+create\b/.test(command);
}

function resultText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) {
    return result.map((b) => (b && typeof b === 'object' && typeof b.text === 'string' ? b.text : '')).join('\n');
  }
  return '';
}

/**
 * The PRs and issues a Bash call just created: a call whose command {@link isCreateCommand} (`creates` holds those
 * calls' ids) and whose output's last line is a GitHub PR or issue URL alone — `gh pr create` and `gh issue create`
 * print the new page's URL last. `gh pr view` / `edit` print one too, but do not create.
 */
export function linksCreatedByTools(
  results: ReadonlyArray<ToolResultLike> | undefined,
  creates: ReadonlySet<string>,
): CapturedLink[] {
  const out: CapturedLink[] = [];
  const seen = new Set<string>();
  for (const r of results ?? []) {
    if (!r || r.isError || r.toolName !== 'Bash' || !r.toolUseId || !creates.has(r.toolUseId)) continue;
    const lines = resultText(r.result).trim().split('\n');
    const last = (lines[lines.length - 1] ?? '').trim();
    if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(pull|issues)\/\d+\/?$/.test(last)) continue;
    const link = classifyLinkUrl(last);
    if (!link || seen.has(link.url)) continue;
    seen.add(link.url);
    out.push(link);
  }
  return out;
}
