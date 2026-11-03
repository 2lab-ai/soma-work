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

// ── Reading a shell command ──────────────────────────────────────────────────────────────────────────────────────────
//
// A command is read as the shell runs it: statements split at unquoted newlines, `;`, `&&`, `||` and `|`; a command
// substitution (`$(…)`, `` `…` ``) is a statement of its own; what `bash -c`, `sh -c` or `eval` is given is read as
// shell again; what `node -e`, `python3 -c`, `ruby -e`, `perl -e` or `deno eval` is given — or an interpreter reads
// from a heredoc — is code. A heredoc any other command reads is data (`cat > body.md <<'EOF'`) and is dropped: a PR
// body that describes a POST is not a POST. Nesting is read to MAX_NESTING levels; deeper text is not read, which
// only ever loses a write (the turn-end GitHub check, #833, still finds a PR).

interface Statement {
  text: string;
  /** Code an interpreter runs, by language — undefined for shell. */
  code?: CodeLang;
  /** How deeply it was nested (substitution, `bash -c`, heredoc). */
  depth: number;
}

interface Word {
  value: string;
  start: number;
}

/** The language of code an interpreter runs: JavaScript (node, deno, bun), Python, or Ruby / Perl (`#` comments). */
type CodeLang = 'js' | 'py' | 'rb';

const MAX_NESTING = 4;
/** Longer statements are not read (a model-written statement is rarely over a few thousand characters). */
const MAX_STATEMENT_LENGTH = 32_000;
const HEREDOC = /<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/;

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const HTTP_CLIENTS = new Set(['curl', 'wget', 'http', 'https', 'xh']);
const NODE_LIKE = new Set(['node', 'nodejs', 'bun', 'tsx', 'ts-node']);
const PYTHONS = new Set(['python', 'python3']);
const PERL_LIKE = new Set(['ruby', 'perl']);
const SCRIPT = /\.(?:[cm]?js|ts|py|rb|sh)$/;
/** Words before the command that do not run anything themselves. */
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '(']);
/** Commands that run the command after them, and which of their options take a value. */
const WRAPPERS = new Map<string, RegExp>([
  ['env', /^-[uSC]$/],
  ['sudo', /^-[ugpCDhrtUT]$/],
  ['nice', /^-n$/],
  ['timeout', /^-[sk]$/],
  ['exec', /^-a$/],
  ['command', /^$/],
  ['nohup', /^$/],
  ['time', /^$/],
  ['stdbuf', /^$/],
  ['xargs', /^-[InPLdaEs]$/],
]);

/** A statement's words, unquoted, each with where it starts in the statement. */
function wordsOf(text: string): Word[] {
  const out: Word[] = [];
  let value = '';
  let start = -1;
  let quote: '"' | "'" | '' = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === "'") {
      if (c === "'") quote = '';
      else value += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = '';
      else if (c === '\\' && /["\\$`]/.test(text[i + 1] ?? '')) value += text[++i];
      else value += c;
      continue;
    }
    if (c === '\\' && text[i + 1] === '\n') {
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      if (start >= 0) out.push({ value, start });
      value = '';
      start = -1;
      continue;
    }
    if (start < 0) start = i;
    if (c === "'" || c === '"') quote = c;
    else if (c === '\\') value += text[++i] ?? '';
    else value += c;
  }
  if (start >= 0) out.push({ value, start });
  return out;
}

/** Where the command is among a statement's words: after env assignments, keywords and wrappers (`sudo -E`, `timeout 30s`). */
function commandAt(words: Word[]): number {
  let i = 0;
  while (i < words.length) {
    const w = words[i].value;
    if (KEYWORDS.has(w) || /^[A-Za-z_]\w*=/.test(w)) {
      i++;
      continue;
    }
    const takesValue = WRAPPERS.get(w);
    if (!takesValue) break;
    i++;
    while (i < words.length && /^-./.test(words[i].value)) i += takesValue.test(words[i].value) ? 2 : 1;
    if (w === 'timeout' && /^\d+(?:\.\d+)?[smhd]?$/.test(words[i]?.value ?? '')) i++;
  }
  return i;
}

function nameOf(word: string | undefined): string {
  return (
    (word ?? '')
      .replace(/^[({]+/, '')
      .split('/')
      .pop() ?? ''
  );
}

function langOf(name: string): CodeLang | undefined {
  if (NODE_LIKE.has(name) || name === 'deno') return 'js';
  if (PYTHONS.has(name)) return 'py';
  if (PERL_LIKE.has(name)) return 'rb';
  return undefined;
}

/** What a statement's command runs: a request (`send`), shell (`bash -c`, `eval`), or code (`node -e`). */
type Run = { send: true } | { shell: string } | { code: string; lang: CodeLang } | undefined;
const SEND: Run = { send: true };

function runOf(words: Word[], at: number): Run {
  const name = nameOf(words[at]?.value);
  if (name === 'gh') return words[at + 1]?.value === 'api' ? SEND : undefined;
  if (HTTP_CLIENTS.has(name) || name === 'npx') return SEND;
  if (name === 'eval')
    return {
      shell: words
        .slice(at + 1)
        .map((w) => w.value)
        .join(' '),
    };
  if (SHELLS.has(name)) {
    for (let k = at + 1; k < words.length; k++) {
      const v = words[k].value;
      if (/^[-+]o$/.test(v)) k++;
      else if (/^-[A-Za-z]*c[A-Za-z]*$/.test(v)) return { shell: words[k + 1]?.value ?? '' };
      else if (!/^[-+]/.test(v)) return SEND; // a script file: what it sends is not visible, its arguments are
    }
    return undefined; // reads its script from stdin
  }
  const lang = langOf(name);
  const inline =
    name === 'deno'
      ? /^eval$/
      : lang === 'js'
        ? /^(?:-e|--eval|-p|--print)$/
        : lang === 'py'
          ? /^-[A-Za-z]*c$/
          : lang === 'rb'
            ? /^-[A-Za-z]*[eE]$/
            : undefined;
  if (lang && inline) {
    for (let k = at + 1; k < words.length; k++) {
      const v = words[k].value;
      if (inline.test(v)) return { code: words[k + 1]?.value ?? '', lang };
      if (!v.startsWith('-')) return SEND; // a script or a module
    }
    return undefined; // reads its program from stdin
  }
  return SCRIPT.test(name) ? SEND : undefined;
}

/** How a heredoc's body is read, from the command that reads it: shell, code, or data (undefined). */
function heredocKind(head: string): 'shell' | CodeLang | undefined {
  const sub = Math.max(head.lastIndexOf('$(') >= 0 ? head.lastIndexOf('$(') + 2 : 0, head.lastIndexOf('`') + 1);
  const last =
    head
      .slice(sub)
      .split(/&&|\|\||[;|]/)
      .pop() ?? '';
  const words = wordsOf(last);
  const at = commandAt(words);
  const name = nameOf(words[at]?.value);
  // Only a command that reads its program from stdin runs the body; `node render.cjs <<'EOF'` reads data.
  if (runOf(words, at) !== undefined) return undefined;
  return SHELLS.has(name) ? 'shell' : langOf(name);
}

/** The closing backtick of a substitution opened before `from`, or -1. */
function closingBacktick(text: string, from: number): number {
  for (let j = from; j < text.length; j++) {
    if (text[j] === '\\') j++;
    else if (text[j] === '`') return j;
  }
  return -1;
}

/**
 * Splits `text` from `from` into statements, appended to `out`. Inside a substitution (`inSub`) it stops at the
 * unmatched `)` and returns the index after it. Linear: every character is read once per level, and levels are capped.
 */
function splitShell(text: string, from: number, inSub: boolean, depth: number, out: Statement[]): number {
  let cur = '';
  let quote: '"' | "'" | '' = '';
  let parens = 0;
  let backticks = true;
  const flush = () => {
    if (cur.trim()) out.push({ text: cur, depth });
    cur = '';
  };
  let i = from;
  while (i < text.length) {
    const c = text[i];
    if (quote === "'") {
      if (c === "'") quote = '';
      cur += c;
      i++;
      continue;
    }
    if (c === '\\') {
      cur += c + (text[i + 1] ?? '');
      i += 2;
      continue;
    }
    // A command substitution runs its command, inside double quotes too: it is read as statements of its own.
    if (c === '$' && text[i + 1] === '(') {
      if (depth < MAX_NESTING) {
        i = splitShell(text, i + 2, true, depth + 1, out);
        cur += '$(…)';
      } else {
        cur += '$(';
        parens++;
        i += 2;
      }
      continue;
    }
    if (c === '`' && backticks) {
      const end = closingBacktick(text, i + 1);
      if (end < 0) {
        backticks = false;
        cur += c;
        i++;
        continue;
      }
      if (depth < MAX_NESTING) splitShell(text.slice(i + 1, end), 0, false, depth + 1, out);
      cur += '`…`';
      i = end + 1;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = '';
      cur += c;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      i++;
      continue;
    }
    // A comment runs to the end of the line: what it says is not run.
    if (c === '#' && (cur === '' || /\s/.test(text[i - 1] ?? ''))) {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (inSub && c === ')') {
      if (parens === 0) {
        flush();
        return i + 1;
      }
      parens--;
    } else if (inSub && c === '(') {
      parens++;
    }
    const two = text.slice(i, i + 2);
    if (c === '\n' || c === ';' || two === '&&' || two === '||' || c === '|') {
      flush();
      i += two === '&&' || two === '||' ? 2 : 1;
      continue;
    }
    cur += c;
    i++;
  }
  flush();
  return i;
}

/** The statements of a shell command; a heredoc's body is read as shell, code or data by the command reading it. */
function shellStatements(command: string, depth: number, out: Statement[] = []): Statement[] {
  const lines = command.split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    kept.push(line);
    const m = line.match(HEREDOC);
    if (!m || line.includes('<<<')) continue;
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== m[2]) body.push(lines[j++]);
    const kind = heredocKind(line.slice(0, m.index));
    if (kind === 'shell') {
      if (depth < MAX_NESTING) shellStatements(body.join('\n'), depth + 1, out);
    } else if (kind) out.push({ text: body.join('\n'), code: kind, depth: depth + 1 });
    i = j;
  }
  splitShell(kept.join('\n'), 0, false, depth, out);
  return out;
}

// ── Reading a request ────────────────────────────────────────────────────────────────────────────────────────────────

// `repos/{owner}/{repo}/pulls|issues[/{n}[/merge]]` — as an api.github.com URL or a bare path (`gh api repos/…`, a
// `POST /repos/…` helper). Any other suffix (`/comments`, `/reviews`, `/labels`, `/files`) is not a target.
const ENDPOINT =
  /(?:api\.github\.com\/|(?<![\w./-]))\/?repos\/([\w.-]+)\/([\w.-]+)\/(pulls|issues)(?:\/(\d+)(?:\/(merge))?)?(?![\w/-])/g;
/** How a shell command names its method: a curl / gh flag, a `METHOD /repos` helper argument. */
const METHOD_TOKENS: RegExp[] = [
  /(?:^|\s)(?:-X|--request|--method)\s*(?:=\s*)?['"]?(GET|POST|PUT|PATCH|DELETE)\b/gi,
  /\bmethod\s*[:=]\s*['"`](GET|POST|PUT|PATCH|DELETE)['"`]/gi,
  /(?:^|[\s"'`])(GET|POST|PUT|PATCH|DELETE)\s+['"]?(?=\/?repos\/)/g,
];
const CURL_DATA = /(?:^|\s)(?:-d|--data(?:-raw|-binary|-urlencode)?|--json|-F|--form)(?=\s|=|$|@)/;
const GH_API_FIELDS = /(?:^|\s)(?:-f|-F|--field|--raw-field|--input)(?=\s|=)/;
const GH_CLI = /^[({]*(?:[^\s/]*\/)*gh\s+(pr|issue)\s+(create|merge|close)\b([^\n]*)/;
const REPO_FLAG =
  /(?:^|\s)(?:-R|--repo)(?:\s+|=)['"]?(?:https:\/\/)?(?:github\.com\/)?([\w.-]+\/[\w.-]+?)(?:\.git)?['"]?(?=\s|$)/;
const ISSUE_OR_PR_URL = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/(\d+)/;

interface MethodToken {
  at: number;
  verb: string;
}

/** Every method token of a statement, scanned once (not once per endpoint). */
function methodTokens(statement: string): MethodToken[] {
  const out: MethodToken[] = [];
  for (const re of METHOD_TOKENS) {
    re.lastIndex = 0;
    for (const m of statement.matchAll(re)) out.push({ at: m.index ?? 0, verb: m[1].toUpperCase() });
  }
  return out;
}

function verbOf(statement: string, tokens: MethodToken[], at: number): string {
  let best: { verb: string; dist: number } | undefined;
  for (const t of tokens) {
    const dist = Math.abs(t.at - at);
    if (!best || dist < best.dist) best = { verb: t.verb, dist };
  }
  if (best) return best.verb;
  if (/\bcurl\b/.test(statement) && CURL_DATA.test(statement) && !/(?:^|\s)(?:-G|--get)\b/.test(statement)) {
    return 'POST';
  }
  if (/\bgh\s+api\b/.test(statement) && GH_API_FIELDS.test(statement)) return 'POST';
  return 'GET';
}

/** `gh pr|issue create|merge|close …`, read from the command word on. */
function ghCliWrite(command: string): GitHubWrite | undefined {
  const m = command.match(GH_CLI);
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

/** The PR and issue writes a shell request names: an endpoint and the method nearest to it. */
function apiWrites(statement: string): GitHubWrite[] {
  const tokens = methodTokens(statement);
  const out: GitHubWrite[] = [];
  ENDPOINT.lastIndex = 0;
  for (const m of statement.matchAll(ENDPOINT)) {
    const w = writeOf(m, verbOf(statement, tokens, m.index ?? 0));
    if (w) out.push(w);
  }
  return out;
}

// ── Reading code ─────────────────────────────────────────────────────────────────────────────────────────────────────
//
// Code sends only through a call, so only a call counts — never data that spells a request: `{ method: "POST", url }`,
// `const method = "POST"`, or a string that prints one (`console.log('fetch(…, { method: "POST" })')`). The code is
// lexed for its language — strings, comments and regex literals are masked — and a request is read from the direct
// arguments (not a nested call, array or callback) of a sending call found in the code itself: `fetch(…)`,
// `request(…)` (`octokit.request("POST /repos/…")`, `https.request({ path, method })`), `urlopen(…)` /
// `Request(…, method=…)`, `requests.post(…)`, `axios(…)`. A shell command the code runs as its first argument
// (`execSync("curl …")`, `os.system(…)`, `subprocess.run("gh …", shell=True)`) is read as shell. A URL held in a
// variable is not followed (a miss, which the turn-end GitHub check backs).

interface CodeString {
  start: number;
  end: number;
  value: string;
}

interface Lexed {
  /** The code with every string's content and every comment blanked; same length, same positions. */
  masked: string;
  /** The string literals, in order. */
  strings: CodeString[];
}

/** Words after which a `/` starts a regex literal, not a division. */
const BEFORE_REGEX = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
  'if',
  'unless',
  'when',
  'and',
  'or',
  'not',
]);

/** Longer `/…/` runs are not read as a regex literal (they are rare; the bound keeps the lexer linear). */
const MAX_REGEX_LENGTH = 256;

/** The end (exclusive) of a regex literal whose opening `/` is at `at`, or -1 when it is not one (a newline first). */
function regexEnd(code: string, at: number): number {
  let inClass = false;
  const limit = Math.min(code.length, at + MAX_REGEX_LENGTH);
  for (let j = at + 1; j < limit; j++) {
    const c = code[j];
    if (c === '\n') return -1;
    if (c === '\\') j++;
    else if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      let end = j + 1;
      while (end < code.length && /[A-Za-z]/.test(code[end])) end++;
      return end;
    }
  }
  return -1;
}

/**
 * Whether the `/` at `at` opens a regex literal, given the last code character and word before it. After an operator,
 * an opening bracket, a keyword or at the start, JS reads a regex. After an operand (a name, a number, `)`, `]`, a
 * string — on the same line or the line before) JS reads a division, so it is masked only when a division could not
 * compile: no space after the `/`, and the would-be closing `/` (and flags) followed by `.name`, `)`, `,`, `;`, `]`,
 * `}` or the end. `x /re/ y` and `(0)/re/+0` divide — a call between the slashes runs.
 */
function isRegexAt(code: string, at: number, last: string, word: string): boolean {
  if (last === '' || /[(,=:[!&|?{};+\-*\/%<>~^]/.test(last) || BEFORE_REGEX.has(word)) return true;
  if (/\s/.test(code[at + 1] ?? ' ')) return false;
  const end = regexEnd(code, at);
  if (end < 0) return false;
  let j = end;
  while (j < code.length && /\s/.test(code[j])) j++;
  return j >= code.length || /[),;\]}]/.test(code[j]) || (code[j] === '.' && /[A-Za-z_$]/.test(code[j + 1] ?? ''));
}

function lexCode(code: string, lang: CodeLang): Lexed {
  const masked: string[] = [];
  const strings: CodeString[] = [];
  const n = code.length;
  // What came last in code (not a string, a comment or space): decides whether a `/` divides or opens a regex.
  let last = '';
  let word = '';
  let i = 0;
  const blank = (stop: number) => {
    for (; i < stop; i++) masked.push(code[i] === '\n' ? '\n' : ' ');
  };
  while (i < n) {
    const c = code[i];
    const lineComment = lang === 'js' ? c === '/' && code[i + 1] === '/' : c === '#';
    if (lineComment) {
      const nl = code.indexOf('\n', i);
      blank(nl < 0 ? n : nl);
      continue;
    }
    if (lang === 'js' && c === '/' && code[i + 1] === '*') {
      const close = code.indexOf('*/', i + 2);
      blank(close < 0 ? n : close + 2);
      continue;
    }
    // A regex literal (JS, Ruby) — where JS reads one, or where a division could not compile (see isRegexAt).
    if (c === '/' && lang !== 'py' && isRegexAt(code, i, last, word)) {
      const end = regexEnd(code, i);
      if (end > 0) {
        masked.push('/');
        i++;
        blank(end - 1);
        masked.push(' ');
        i = end;
        last = ')';
        word = '';
        continue;
      }
    }
    if (c === '"' || c === "'" || (lang === 'js' && c === '`')) {
      const close = lang === 'py' && code.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      let j = i + close.length;
      let value = '';
      while (j < n && !code.startsWith(close, j)) {
        if (code[j] === '\\') {
          value += code[j + 1] ?? '';
          j += 2;
        } else {
          value += code[j];
          j++;
        }
      }
      const stop = Math.min(n, j + close.length);
      strings.push({ start: i, end: stop, value });
      masked.push(c);
      for (let k = i + 1; k < stop - 1; k++) masked.push(' ');
      if (stop - i > 1) masked.push(c);
      i = stop;
      last = ')';
      word = '';
      continue;
    }
    masked.push(c);
    i++;
    if (/\s/.test(c)) continue;
    if (/[\w$]/.test(c)) word = /[\w$]/.test(last) ? word + c : c;
    else word = '';
    last = c;
  }
  return { masked: masked.join(''), strings };
}

/** The first string literal starting at or after `at`, by binary search. */
function firstStringFrom(strings: CodeString[], at: number): number {
  let lo = 0;
  let hi = strings.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (strings[mid].start < at) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const VERBS = /^(GET|POST|PUT|PATCH|DELETE)$/i;
/**
 * A sending call, found in masked code (so never inside a string, a comment or a regex literal): an HTTP call, or a
 * call that runs a shell command — `execSync` / `exec` (bare or on `child_process`), `os.system`, `subprocess.run`.
 */
const SENDING_CALL =
  /(?:(child_process|cp|subprocess|os)\.|(\.)|(?<![\w$]))(execSync|execFileSync|spawnSync|exec|system|popen|run|call|check_output|check_call|getoutput|Popen)\s*\(|\b(fetch|request|urlopen|Request|axios|(?:requests|axios|got|ky|httpx|superagent)\.(?:get|post|put|patch|delete|request))\s*\(/g;
const MAX_CALLS = 64;
const MAX_CALL_LENGTH = 8000;

/**
 * Whether a shell-running call is the real one: `execSync` on anything (`require("child_process").execSync`), `exec`
 * bare or on `child_process`, `os.system`, `subprocess.run` — not `re.exec(…)` or a bare `run(…)`.
 */
function runsShell(receiver: string | undefined, dotted: boolean, name: string): boolean {
  if (/^(?:execSync|execFileSync|spawnSync)$/.test(name)) return true;
  if (name === 'exec') return receiver ? /^(?:child_process|cp)$/.test(receiver) : !dotted;
  if (/^(?:system|popen)$/.test(name)) return receiver === 'os';
  return receiver === 'subprocess';
}

interface CallArg extends CodeString {
  /** Directly in the call's argument list (or its options object) — not inside a nested call, array or object. */
  direct: boolean;
}

/**
 * The string arguments of the call opened at `open`, in order, and where it ends — one bounded walk of the masked
 * code, tracking nesting so a string inside a nested call (`JSON.stringify({…})`) or a callback is not direct.
 */
function callArgs(lexed: Lexed, open: number): { args: CallArg[]; end: number } {
  const { masked, strings } = lexed;
  const args: CallArg[] = [];
  let k = firstStringFrom(strings, open);
  let parens = 0;
  let braces = 0;
  let brackets = 0;
  const limit = Math.min(masked.length, open + MAX_CALL_LENGTH);
  for (let j = open; j < limit; j++) {
    if (k < strings.length && strings[k].start === j) {
      args.push({ ...strings[k], direct: parens === 1 && braces <= 1 && brackets === 0 });
      j = strings[k].end - 1;
      k++;
      continue;
    }
    const c = masked[j];
    if (c === '(') parens++;
    else if (c === ')' && --parens === 0) return { args, end: j };
    else if (c === '{') braces++;
    else if (c === '}') braces--;
    else if (c === '[') brackets++;
    else if (c === ']') brackets--;
  }
  return { args, end: limit };
}

/** The method a call names directly: `method: "POST"`, `method="POST"`, `"method": "POST"`. */
function methodOf(masked: string, args: CallArg[], open: number): string | undefined {
  for (let k = 0; k < args.length; k++) {
    const s = args[k];
    if (!s.direct || !VERBS.test(s.value)) continue;
    const keyed = /\bmethod\s*[:=]\s*$/.test(masked.slice(Math.max(open, s.start - 40), s.start));
    const quotedKey =
      k > 0 && args[k - 1].value === 'method' && /^\s*:\s*$/.test(masked.slice(args[k - 1].end, s.start));
    if (keyed || quotedKey) return s.value.toUpperCase();
  }
  return undefined;
}

/** The PR and issue write an endpoint names under a method. */
function writeOf(m: RegExpMatchArray, verb: string): GitHubWrite | undefined {
  const repo = `${m[1]}/${m[2]}`.toLowerCase();
  const kind = m[3] === 'pulls' ? 'pr' : 'issue';
  const number = m[4] ? Number(m[4]) : undefined;
  if (!number && verb === 'POST') return { op: 'create', kind, repo };
  if (number && m[5] === 'merge' && kind === 'pr' && verb === 'PUT') return { op: 'merge', kind, repo, number };
  if (number && !m[5] && verb === 'PATCH') return { op: 'patch', kind, repo, number };
  return undefined;
}

/** The writes of code: the requests its sending calls make, and the shell commands it runs. */
function codeWrites(code: string, lang: CodeLang, depth: number, out: GitHubWrite[]): void {
  if (code.length > MAX_STATEMENT_LENGTH) return;
  const lexed = lexCode(code, lang);
  const { masked } = lexed;
  let calls = 0;
  SENDING_CALL.lastIndex = 0;
  for (const m of masked.matchAll(SENDING_CALL)) {
    if (++calls > MAX_CALLS) break;
    const open = (m.index ?? 0) + m[0].length - 1;
    const { args } = callArgs(lexed, open);
    const first = args[0];
    const leadsWithString = first !== undefined && /^\(\s*[frbuFRBU]{0,2}$/.test(masked.slice(open, first.start));
    if (m[3]) {
      // A shell command the code runs: its first argument, a string.
      if (runsShell(m[1], m[2] === '.', m[3]) && leadsWithString && depth < MAX_NESTING) {
        shellWrites(first.value, depth + 1, out);
      }
      continue;
    }
    const name = m[4];
    // `octokit.request("POST /repos/…")`, `requests.request("POST", url)`
    const leading = leadsWithString ? first.value.match(/^(GET|POST|PUT|PATCH|DELETE)(?:\s+\/?repos\/|$)/i) : null;
    const named = name.match(/\.(get|post|put|patch|delete)$/)?.[1];
    const verb = (named ?? leading?.[1] ?? methodOf(masked, args, open) ?? 'GET').toUpperCase();
    for (const s of args) {
      if (!s.direct) continue;
      ENDPOINT.lastIndex = 0;
      for (const e of s.value.matchAll(ENDPOINT)) {
        const w = writeOf(e, verb);
        if (w) out.push(w);
      }
    }
  }
}

/** The writes of a shell command, statement by statement; nested shell and code are read the same way. */
function shellWrites(command: string, depth: number, out: GitHubWrite[]): void {
  for (const st of shellStatements(command, depth)) {
    if (st.text.length > MAX_STATEMENT_LENGTH) {
      // Too long to read whole (an inline PR body): `gh pr create` is still read from its head.
      if (!st.code) {
        const head = st.text.slice(0, 2000);
        const words = wordsOf(head);
        const at = commandAt(words);
        const cli = at < words.length ? ghCliWrite(head.slice(words[at].start)) : undefined;
        if (cli) out.push(cli);
      }
      continue;
    }
    if (st.code) {
      codeWrites(st.text, st.code, st.depth, out);
      continue;
    }
    const words = wordsOf(st.text);
    const at = commandAt(words);
    if (at >= words.length) continue;
    const cli = ghCliWrite(st.text.slice(words[at].start));
    if (cli) out.push(cli);
    const run = runOf(words, at);
    if (!run) continue;
    if ('send' in run) out.push(...apiWrites(st.text));
    else if (st.depth < MAX_NESTING) {
      if ('shell' in run) shellWrites(run.shell, st.depth + 1, out);
      else codeWrites(run.code, run.lang, st.depth + 1, out);
    }
  }
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
  shellWrites(fields.command, 0, out);
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
const JSON_NUMBER = /"number"\s*:\s*(\d+)(?!\d)/g;

function objectsIn(text: string): FoundObject[] {
  const found: Array<FoundObject & { at: number }> = [];
  const numbers = new Set([...text.matchAll(JSON_NUMBER)].map((m) => Number(m[1])));
  for (const re of [JSON_HTML_URL, LONE_URL]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const number = Number(m[5]);
      if (re === JSON_HTML_URL && !numbers.has(number)) continue;
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
