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
 *   - {@link githubWritesOf} + {@link githubEffectsOf} (#832): the PR or issue a tool call wrote — created, merged or
 *     closed — read from the call's own input and proven by its result, however it was spelled (`gh`, `gh api`,
 *     `curl`, `fetch`, a GitHub MCP tool);
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

function resultText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) {
    return result.map((b) => (b && typeof b === 'object' && typeof b.text === 'string' ? b.text : '')).join('\n');
  }
  if (result && typeof result === 'object') {
    try {
      return JSON.stringify(result);
    } catch {
      return '';
    }
  }
  return '';
}

// ── GitHub writes (#832, epic #831) ─────────────────────────────────────────────────────────────────────────────────
//
// A PR or issue is recorded by the effect of a write, however the call was spelled. A call is a write when its own
// input says so — the operation (POST / PUT / PATCH, `gh pr|issue create|merge|close`, a GitHub MCP create / merge /
// update tool) and the target (`repos/{owner}/{repo}/pulls|issues[/{n}[/merge]]`) — and its result proves it: the object
// for that repo and kind (a JSON `html_url` with its `"number"`, or the URL alone on a line), `"merged": true` /
// `Merged pull request`, `Closed …`. A comment, a review, a label, a read and an error record nothing.

/** What a tool call writes to GitHub, read from its input alone (onToolUse). */
export interface GitHubWrite {
  /** `patch` is a PATCH of a PR or issue: it is a close only when the result shows the state `closed`. */
  op: 'create' | 'merge' | 'close' | 'patch';
  kind: 'pr' | 'issue';
  /** `owner/repo`, lower case — undefined when the call does not name it (`gh pr create` in a checkout). */
  repo?: string;
  number?: number;
}

/** What a write did, proven by its result (onToolResult). */
export interface GitHubEffect {
  op: 'create' | 'merge' | 'close';
  link: CapturedLink;
}

const INTERPRETERS = /^(?:[A-Za-z_]\w*=\S*\s+)*(?:node|nodejs|python3?|bash|sh|zsh|deno|bun|ruby|perl)\b/;
const HEREDOC = /<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/;

/**
 * The shell statements of a command, split at unquoted newlines, `;`, `&&`, `||` and `|`. A heredoc's body is code
 * when an interpreter reads it (`node <<'EOF'`) — then it is one statement of its own — and data otherwise (`cat >
 * body.md <<'EOF'`), dropped: a PR body that describes a POST is not a POST. Quotes are tracked so a `node -e '…'`
 * script stays one statement; `$(…)` nesting is not, which only ever merges statements (never invents a write: the
 * result must still prove it).
 */
function shellStatements(command: string): string[] {
  const lines = command.split('\n');
  const kept: string[] = [];
  const code: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    kept.push(line);
    const m = line.match(HEREDOC);
    if (!m || line.includes('<<<')) continue;
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== m[2]) body.push(lines[j++]);
    const head =
      line
        .slice(0, m.index)
        .split(/&&|\|\||[;|]/)
        .pop() ?? '';
    if (INTERPRETERS.test(head.trim())) code.push(body.join('\n'));
    i = j;
  }
  const out: string[] = [...code];
  let cur = '';
  let quote: '"' | "'" | '' = '';
  const text = kept.join('\n');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\' && quote === '"') {
        cur += c + (text[i + 1] ?? '');
        i++;
        continue;
      }
      if (c === quote) quote = '';
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === '\\') {
      cur += c + (text[i + 1] ?? '');
      i++;
      continue;
    }
    const two = text.slice(i, i + 2);
    if (c === '\n' || c === ';' || two === '&&' || two === '||' || c === '|') {
      if (cur.trim()) out.push(cur);
      cur = '';
      if (two === '&&' || two === '||') i++;
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

// `repos/{owner}/{repo}/pulls|issues[/{n}[/merge]]` — as an api.github.com URL or a bare path (`gh api repos/…`, a
// `POST /repos/…` helper). Any other suffix (`/comments`, `/reviews`, `/labels`, `/files`) is not a target.
const ENDPOINT =
  /(?:api\.github\.com\/|(?<![\w./-]))\/?repos\/([\w.-]+)\/([\w.-]+)\/(pulls|issues)(?:\/(\d+)(?:\/(merge))?)?(?![\w/-])/g;
const METHOD_TOKENS: RegExp[] = [
  /(?:^|\s)(?:-X|--request|--method)(?:\s*=?\s*)['"]?(GET|POST|PUT|PATCH|DELETE)\b/gi,
  /\bmethod\s*[:=]\s*['"`](GET|POST|PUT|PATCH|DELETE)['"`]/gi,
  /(?:^|[\s"'`])(GET|POST|PUT|PATCH|DELETE)\s+['"]?(?=\/?repos\/)/g,
  /\b(?:requests|axios|got|ky|httpx)\.(get|post|put|patch|delete)\s*\(/gi,
];
const CURL_DATA = /(?:^|\s)(?:-d|--data(?:-raw|-binary|-urlencode)?|--json|-F|--form)(?=\s|=|$|@)/;
const GH_API_FIELDS = /(?:^|\s)(?:-f|-F|--field|--raw-field|--input)(?=\s|=)/;
// `gh` as the statement's command (after env assignments, `$(`, or a wrapper), not a word in an echo.
const GH_CLI =
  /(?:^|\$\(|`)\s*(?:[A-Za-z_]\w*=\S*\s+)*(?:(?:command|exec|env|nohup|time|timeout\s+\S+)\s+)*gh\s+(pr|issue)\s+(create|merge|close)\b([^\n]*)/;
const REPO_FLAG =
  /(?:^|\s)(?:-R|--repo)(?:\s+|=)['"]?(?:https:\/\/)?(?:github\.com\/)?([\w.-]+\/[\w.-]+?)(?:\.git)?['"]?(?=\s|$)/;
const ISSUE_OR_PR_URL = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/(\d+)/;

function verbOf(statement: string, at: number): string {
  let best: { verb: string; dist: number } | undefined;
  for (const re of METHOD_TOKENS) {
    re.lastIndex = 0;
    for (const m of statement.matchAll(re)) {
      const dist = Math.abs((m.index ?? 0) - at);
      if (!best || dist < best.dist) best = { verb: m[1].toUpperCase(), dist };
    }
  }
  if (best) return best.verb;
  if (/\bcurl\b/.test(statement) && CURL_DATA.test(statement) && !/(?:^|\s)(?:-G|--get)\b/.test(statement)) {
    return 'POST';
  }
  if (/\bgh\s+api\b/.test(statement) && GH_API_FIELDS.test(statement)) return 'POST';
  return 'GET';
}

function ghCliWrite(statement: string): GitHubWrite | undefined {
  const m = statement.match(GH_CLI);
  if (!m) return undefined;
  const kind = m[1] === 'pr' ? 'pr' : 'issue';
  const action = m[2] as 'create' | 'merge' | 'close';
  const args = m[3] ?? '';
  let repo = args.match(REPO_FLAG)?.[1]?.toLowerCase();
  let number: number | undefined;
  if (action !== 'create') {
    const first = args.trim().split(/\s+/)[0] ?? '';
    const url = first.match(ISSUE_OR_PR_URL);
    if (url) {
      repo = `${url[1]}/${url[2]}`.toLowerCase();
      number = Number(url[4]);
    } else if (/^#?\d+$/.test(first)) {
      number = Number(first.replace('#', ''));
    }
  }
  return { op: action, kind, ...(repo ? { repo } : {}), ...(number ? { number } : {}) };
}

function apiWrites(statement: string): GitHubWrite[] {
  const out: GitHubWrite[] = [];
  ENDPOINT.lastIndex = 0;
  for (const m of statement.matchAll(ENDPOINT)) {
    const verb = verbOf(statement, m.index ?? 0);
    const repo = `${m[1]}/${m[2]}`.toLowerCase();
    const kind = m[3] === 'pulls' ? 'pr' : 'issue';
    const number = m[4] ? Number(m[4]) : undefined;
    if (!number && verb === 'POST') out.push({ op: 'create', kind, repo });
    else if (number && m[5] === 'merge' && kind === 'pr' && verb === 'PUT')
      out.push({ op: 'merge', kind, repo, number });
    else if (number && !m[5] && verb === 'PATCH') out.push({ op: 'patch', kind, repo, number });
  }
  return out;
}

// GitHub MCP tools (`mcp__github__…`, or a plugin's `…__github__…`).
const MCP_TOOL =
  /(?:^|__)github__(create_pull_request|create_issue|merge_pull_request|update_issue|update_pull_request)$/;

function mcpWrite(toolName: string, input: Record<string, unknown>): GitHubWrite | undefined {
  const m = toolName.match(MCP_TOOL);
  if (!m || typeof input.owner !== 'string' || typeof input.repo !== 'string') return undefined;
  const repo = `${input.owner}/${input.repo}`.toLowerCase();
  const num = Number(input.pull_number ?? input.issue_number ?? input.number);
  const number = Number.isInteger(num) && num > 0 ? num : undefined;
  switch (m[1]) {
    case 'create_pull_request':
      return { op: 'create', kind: 'pr', repo };
    case 'create_issue':
      return { op: 'create', kind: 'issue', repo };
    case 'merge_pull_request':
      return number ? { op: 'merge', kind: 'pr', repo, number } : undefined;
    default:
      return number && input.state === 'closed'
        ? { op: 'close', kind: m[1] === 'update_issue' ? 'issue' : 'pr', repo, number }
        : undefined;
  }
}

/** The GitHub PR and issue writes a tool call makes, read from its input alone. Pure; never throws. */
export function githubWritesOf(toolName: unknown, input: unknown): GitHubWrite[] {
  if (typeof toolName !== 'string' || !input || typeof input !== 'object') return [];
  const fields = input as Record<string, unknown>;
  if (toolName !== 'Bash') {
    const w = mcpWrite(toolName, fields);
    return w ? [w] : [];
  }
  if (
    typeof fields.command !== 'string' ||
    !/\bgh\b|github|repos\//.test(fields.command) ||
    fields.command.length > 200_000
  ) {
    return [];
  }
  const out: GitHubWrite[] = [];
  for (const statement of shellStatements(fields.command)) {
    const cli = ghCliWrite(statement);
    if (cli) out.push(cli);
    out.push(...apiWrites(statement));
  }
  return out;
}

interface FoundObject {
  repo: string;
  kind: 'pr' | 'issue';
  number: number;
  url: string;
}

const JSON_HTML_URL = /"html_url"\s*:\s*"(https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/(\d+))"/g;
const LONE_URL = /^[ \t]*(https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/(\d+))\/?[ \t]*$/gm;

/** The PRs and issues a result holds as objects: a JSON `html_url` with its `"number"`, or a URL alone on a line. */
function objectsIn(text: string): FoundObject[] {
  const found: Array<FoundObject & { at: number }> = [];
  for (const re of [JSON_HTML_URL, LONE_URL]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const number = Number(m[5]);
      if (re === JSON_HTML_URL && !new RegExp(`"number"\\s*:\\s*${number}(?!\\d)`).test(text)) continue;
      found.push({
        at: m.index ?? 0,
        repo: `${m[2]}/${m[3]}`.toLowerCase(),
        kind: m[4] === 'pull' ? 'pr' : 'issue',
        number,
        url: m[1],
      });
    }
  }
  return found.sort((a, b) => a.at - b.at);
}

const MERGED_TEXT = /\bmerged\s+pull\s+request\s+(?:([\w.-]+\/[\w.-]+))?#(\d+)/i;
const CLOSED_TEXT = /\bclosed\s+(pull\s+request|issue)\s+(?:([\w.-]+\/[\w.-]+))?#(\d+)/i;

function linkOf(repo: string, kind: 'pr' | 'issue', number: number): CapturedLink | undefined {
  return classifyLinkUrl(`https://github.com/${repo}/${kind === 'pr' ? 'pull' : 'issues'}/${number}`);
}

function effectOf(w: GitHubWrite, text: string, taken: Set<string>): GitHubEffect | undefined {
  if (w.op === 'create') {
    const hit = objectsIn(text).find(
      (o) => o.kind === w.kind && (!w.repo || o.repo === w.repo) && !taken.has(o.url.toLowerCase()),
    );
    if (!hit) return undefined;
    taken.add(hit.url.toLowerCase());
    const link = classifyLinkUrl(hit.url);
    return link ? { op: 'create', link } : undefined;
  }
  if (w.op === 'merge') {
    const said = text.match(MERGED_TEXT);
    if (!said && !/"merged"\s*:\s*true\b/.test(text)) return undefined;
    const repo = w.repo ?? said?.[1]?.toLowerCase();
    const number = w.number ?? (said ? Number(said[2]) : undefined);
    const link = repo && number ? linkOf(repo, 'pr', number) : undefined;
    return link ? { op: 'merge', link } : undefined;
  }
  if (w.op === 'patch') {
    if (!/"state"\s*:\s*"closed"/.test(text) || !w.repo || !w.number) return undefined;
    const proven = objectsIn(text).some((o) => o.repo === w.repo && o.number === w.number && o.kind === w.kind);
    const link = proven ? linkOf(w.repo, w.kind, w.number) : undefined;
    return link ? { op: 'close', link } : undefined;
  }
  // close: gh's own line (`✓ Closed issue a/b#30 (…)`), or an MCP update's object with the state `closed`.
  const said = text.match(CLOSED_TEXT);
  const saidKind = said ? (/pull/i.test(said[1]) ? 'pr' : 'issue') : undefined;
  const byText = said && saidKind === w.kind;
  const byObject = /"state"\s*:\s*"closed"/.test(text);
  if (!byText && !byObject) return undefined;
  const repo = w.repo ?? (byText ? said?.[2]?.toLowerCase() : undefined);
  const number = w.number ?? (byText ? Number(said?.[3]) : undefined);
  const link = repo && number ? linkOf(repo, w.kind, number) : undefined;
  return link ? { op: 'close', link } : undefined;
}

/**
 * What the writes of a batch of tool results did: each result whose call {@link githubWritesOf} found writes for
 * (`writes` maps a tool-use id to them), and which is not an error, proves each write or not. Every tool counts — a
 * subagent's and an MCP tool's included. Each effect once, in order.
 */
export function githubEffectsOf(
  results: ReadonlyArray<ToolResultLike> | undefined,
  writes: ReadonlyMap<string, ReadonlyArray<GitHubWrite>>,
): GitHubEffect[] {
  const out: GitHubEffect[] = [];
  const seen = new Set<string>();
  for (const r of results ?? []) {
    if (!r || r.isError || !r.toolUseId) continue;
    const ws = writes.get(r.toolUseId);
    if (!ws || ws.length === 0) continue;
    const text = resultText(r.result);
    if (!text) continue;
    const taken = new Set<string>();
    for (const w of ws) {
      const effect = effectOf(w, text, taken);
      if (!effect) continue;
      const key = `${effect.op} ${effect.link.url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(effect);
    }
  }
  return out;
}
