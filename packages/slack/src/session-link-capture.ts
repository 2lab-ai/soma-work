/**
 * 세션 링크 자동 기록 (SSOT 2026-11-02 goal: "작업 카드에 디폴트로 표시해야 하는 중요한 것: 연결된 이슈(지라 혹은
 * 깃허브 이슈)들과 이슈 상태, 연결된 PR들과 머지 상태, 연결된 위키들").
 *
 * The task card shows the session's linked issues, PRs and wikis (`linkHistory`), but a link used to be recorded only
 * from the first user message, a `session_links` directive or the `link` command — on dev, 2 of the last 55 sessions
 * had one. These find the links a conversation already names, so the host can record them:
 *
 *   - {@link linksInText}: every issue, PR and wiki URL in a text (a user message, an assistant reply);
 *   - {@link linksCreatedByTools}: the PR or issue a `gh pr create` / `gh issue create` just made (its output ends
 *     with the new page's URL).
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
const TRAILING = /[.,;:!?*_~]+$/;

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
  const url = raw.replace(TRAILING, '');
  for (const rule of RULES) {
    const m = url.match(rule.re);
    if (m) return { url: m[0], type: rule.type, provider: rule.provider, label: rule.label(m) };
  }
  return undefined;
}

/** Every issue, PR and wiki URL in a text, in the order they appear, each once — at most {@link MAX_LINKS_PER_TEXT}. */
export function linksInText(text: unknown): CapturedLink[] {
  if (typeof text !== 'string' || !text.includes('http')) return [];
  const out: CapturedLink[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(URL_RE)) {
    const link = classifyLinkUrl(m[0]);
    if (!link || seen.has(link.url)) continue;
    seen.add(link.url);
    out.push(link);
    if (out.length >= MAX_LINKS_PER_TEXT) break;
  }
  return out;
}

interface ToolResultLike {
  toolName?: string;
  result?: unknown;
  isError?: boolean;
}

function resultText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) {
    return result.map((b) => (b && typeof b === 'object' && typeof b.text === 'string' ? b.text : '')).join('\n');
  }
  return '';
}

/**
 * The PRs and issues a Bash call just created: `gh pr create` and `gh issue create` print the new page's URL as their
 * last line. Only a GitHub PR or issue URL alone on the last line counts — a listing or a log naming PRs does not.
 */
export function linksCreatedByTools(results: ReadonlyArray<ToolResultLike> | undefined): CapturedLink[] {
  const out: CapturedLink[] = [];
  const seen = new Set<string>();
  for (const r of results ?? []) {
    if (!r || r.isError || r.toolName !== 'Bash') continue;
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
