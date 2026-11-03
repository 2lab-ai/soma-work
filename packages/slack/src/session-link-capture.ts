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
  /**
   * `patch` is a PATCH of a PR or issue: it is a close only when the result shows the state `closed`. `read` is a
   * request that writes nothing (a GET, `gh pr view`): it proves nothing, but makes a create beside it in the same call
   * ambiguous — its object could be what the result shows.
   */
  op: 'create' | 'merge' | 'close' | 'patch' | 'read';
  kind: 'pr' | 'issue';
  /** `owner/repo`, lower case — undefined when the call does not name it (`gh pr create` in a checkout). */
  repo?: string;
  number?: number;
  /** `cli`: written by `gh pr|issue create|merge|close`, whose output is gh's own line or URL — never a projection. */
  via?: 'cli';
}

/** What a write did, proven by its result (onToolResult). */
export interface GitHubEffect {
  op: 'create' | 'merge' | 'close';
  link: CapturedLink;
  /** The call whose result proposed it — GitHub confirms it against that call's window and input (src/github-receipt). */
  toolUseId?: string;
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
  /** The command may not run it (a branch, the right of `||`, after `exit`): its writes are not read. */
  uncertain?: true;
}

interface Word {
  value: string;
  start: number;
}

/** The language of code an interpreter runs: JavaScript (node, deno, bun), Python, or Ruby / Perl (`#` comments). */
type CodeLang = 'js' | 'py' | 'rb';

const MAX_NESTING = 4;
/** At most this many writes are read from one tool call. */
const MAX_WRITES = 256;
/** Longer statements are not read (a model-written statement is rarely over a few thousand characters). */
const MAX_STATEMENT_LENGTH = 32_000;
const HEREDOC = /<<(-?)\s*\\?(['"]?)([A-Za-z_][\w-]*)\2/;
/** Every `<<` on a line (not `<<<`). */
const HEREDOC_OPS = /(?<!<)<<(?!<)/g;

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
]);

/** A statement's words, unquoted, each with where it starts in the statement. */
function wordsOf(text: string): Word[] {
  const out: Word[] = [];
  let value = '';
  let start = -1;
  let quote: '"' | "'" | 'a' | '' = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === "'") {
      if (c === "'") quote = '';
      else value += c;
      continue;
    }
    if (quote === 'a') {
      if (c === '\\') value += text[++i] ?? '';
      else if (c === "'") quote = '';
      else value += c;
      continue;
    }
    if (c === '$' && text[i + 1] === "'") {
      if (start < 0) start = i;
      quote = 'a';
      i++;
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
    // `arr=( a b c )`: the array's words are data, up to its closing parenthesis.
    if (/^[A-Za-z_]\w*\+?=\(/.test(w)) {
      while (i < words.length && !words[i].value.includes(')')) i++;
      i++;
      continue;
    }
    if (KEYWORDS.has(w) || /^[A-Za-z_]\w*=/.test(w)) {
      i++;
      continue;
    }
    const takesValue = WRAPPERS.get(w);
    if (!takesValue) break;
    // `env -S 'cmd …'` splits a string into a command line the words do not show: not read.
    if (w === 'env' && words.slice(i + 1).some((x) => /^-[A-Za-z]*S|^--split-string/.test(x.value)))
      return words.length;
    // `command -v gh …`, `-pv`: a lookup — any option to `command` is not read.
    if (w === 'command' && /^-/.test(words[i + 1]?.value ?? '')) return words.length;
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
    // `-c` with only harmless letters (`-lc`, `-ec`, `-euxc`); any other option (`-n`, `-o noexec`, `--help`) is not
    // read; a script file sends what is not visible (its arguments are not read); none reads its script from stdin.
    const v = words[at + 1]?.value;
    if (v === undefined) return undefined;
    if (/^-[eluxa]*c[eluxa]*$/.test(v)) return { shell: words[at + 2]?.value ?? '' };
    return /^[-+]/.test(v) ? undefined : SEND;
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
  // Only the interpreter alone (or with `-`) reads its program from the heredoc; with any option (`bash -n`,
  // `node render.cjs`) the body is data.
  const rest = words.slice(at + 1).map((w) => w.value);
  if (rest.length > 1 || (rest.length === 1 && rest[0] !== '-')) return undefined;
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

/** Words that make a shell level control flow: which of its statements run is not read. */
const CONTROL_WORDS =
  /^(?:if|then|else|elif|fi|while|until|for|do|done|case|esac|select|function|exit|return|exec|trap|break|continue|source|\.|coproc|!)$/;

function firstWordOf(text: string): string {
  // A bounded prefix: asked for a statement still being read, too (linear overall).
  return text.trimStart().slice(0, 64).split(/\s/)[0] ?? '';
}

/**
 * Splits `text` from `from` into statements, appended to `out`. Inside a substitution (`inSub`) it stops at the
 * unmatched `)` and returns the index after it. Linear: every character is read once per level, and levels are capped.
 *
 * Each statement is marked `uncertain` when the command may not run it: a body of `if` / `while` / `for` / `case`
 * (the condition of an `if` / `while` runs), the right side of `||`, anything after `exit` / `return` / `exec`, the
 * right side of `&&` after a statement that can fail — unless that chain is the command's last, whose exit status the
 * tool result reports. A substitution inherits its statement's mark. A write in an uncertain statement is not read.
 */
function splitShell(
  text: string,
  from: number,
  inSub: boolean,
  depth: number,
  out: Statement[],
  inherited = false,
  top = false,
): number {
  const first = out.length;
  // Control flow anywhere at this level — a keyword, `||`, `&`, a group, a function, exit / set — makes every statement
  // at this level (and below) uncertain: which ones run is not read.
  let complex = false;
  let cur = '';
  // The statement's first characters, kept apart: a substitution asks for its statement's first word while the
  // statement grows — reading `cur` itself each time would be quadratic.
  let head = '';
  // …and its last characters, for the same reason (the array check at every `(`).
  let tail = '';
  const add = (piece: string) => {
    cur += piece;
    if (head.length < 64) head += piece.slice(0, 64 - head.length);
    tail = (tail + piece.slice(-64)).slice(-64);
  };
  // `a`: inside `$'…'` (ANSI-C quoting: backslash escapes, no expansion).
  let quote: '"' | "'" | 'a' | '' = '';
  // Inside `${…}`: a substitution there runs only if the expansion needs it (`${x:-$(cmd)}`) — uncertain.
  let braceParam = 0;
  // Inside a function definition's body: it runs only when called — uncertain.
  let parens = 0;
  let backticks = true;
  let after: string | undefined;
  let pipeAnd = false;
  let pipeOr = false;
  /** This level's statements, for the last-chain exemption. */
  const mine: Array<{ st: Statement; after: string | undefined; andOnly: boolean }> = [];
  const contextOf = (_t: string): { uncertain: boolean; andOnly: boolean } => {
    // After `&&` a statement runs only if everything before it in the chain succeeded.
    const andOnly = after === '|' ? pipeAnd : after === '&&';
    // The right of `||` runs only if the left failed: never read (and a pipeline it starts shares that).
    const orRight = after === '|' ? pipeOr : after === '||';
    return { uncertain: inherited || andOnly || orRight, andOnly: andOnly && !orRight };
  };
  const flush = (next: string | undefined) => {
    const t = cur;
    cur = '';
    head = '';
    tail = '';
    if (next === '&') complex = true;
    if (!t.trim()) {
      // `a &&\n b`: the newline continues the list — the pending operator stays.
      if (after !== '&&' && after !== '||' && after !== '|') after = next ?? after;
      return;
    }
    const ctx = contextOf(t);
    const st: Statement = { text: t, depth, ...(ctx.uncertain ? { uncertain: true } : {}) };
    out.push(st);
    mine.push({ st, after, andOnly: ctx.andOnly });
    // A group (`{ …; }`, `( … )`) runs what it holds; a branch, a loop, a function or a jump does not say what runs.
    // `… || exit 1` at the top level is the one jump that is plain: it runs only when the left failed, and then the tool
    // result fails too. Not `exit 0` (a success that skips the rest), not inside a nested script (the outer status masks it).
    const w = firstWordOf(t.replace(/^[\s{(]+/, ''));
    // 3. `exit 256` wraps to 0: a failing status is 1–255.
    const code = t.match(/^\s*exit(?:\s+(\d+))?\s*$/);
    const failExit = top && after === '||' && !!code && (code[1] === undefined || Number(code[1]) % 256 !== 0);
    if ((CONTROL_WORDS.test(w) && !failExit) || /^[\s{(]*[\w-]+\s*\(\s*\)/.test(t)) complex = true;
    if (next !== '|') {
      pipeAnd = false;
      pipeOr = false;
    } else if (after !== '|') {
      pipeAnd = ctx.andOnly;
      pipeOr = after === '||';
    }
    // `set -n` / `set -o noexec` stops execution; other `set` options (`-e`, `-u`, `-x`, `-o pipefail`) do not.
    if (w === 'set' && (!top || /(?:^|\s)(?:-[A-Za-z]*n[A-Za-z]*|-o\s+noexec|\+[A-Za-z]+)(?:\s|$)/.test(t)))
      complex = true;
    after = next;
  };
  const finish = () => {
    if (complex) {
      for (let k = first; k < out.length; k++) out[k].uncertain = true;
      return;
    }
    // The top-level command's last `&&` chain: a successful tool result says it ran to the end. (A nested script's or
    // a substitution's status is not the tool's, so it gets no such pass.)
    if (!top) return;
    for (let k = mine.length - 1; k >= 0; k--) {
      const m = mine[k];
      if (m.andOnly && !inherited) delete m.st.uncertain;
      if (m.after !== '&&' && m.after !== '|') break;
    }
  };
  let i = from;
  while (i < text.length) {
    const c = text[i];
    if (quote === "'") {
      if (c === "'") quote = '';
      add(c);
      i++;
      continue;
    }
    if (quote === 'a') {
      if (c === '\\') {
        add(c + (text[i + 1] ?? ''));
        i += 2;
        continue;
      }
      if (c === "'") quote = '';
      add(c);
      i++;
      continue;
    }
    if (c === '$' && text[i + 1] === "'" && quote === '') {
      quote = 'a';
      add("$'");
      i += 2;
      continue;
    }
    if (c === '$' && text[i + 1] === '{') {
      braceParam++;
      add('${');
      i += 2;
      continue;
    }
    if (c === '}' && braceParam > 0) {
      braceParam--;
      add(c);
      i++;
      continue;
    }
    // An array assignment `name=( … )` holds words, not commands, across lines too.
    if (c === '(' && quote === '' && /[A-Za-z_]\w*\+?=$/.test(tail)) {
      const close = text.indexOf(')', i);
      const stop = close < 0 ? text.length : close + 1;
      add(text.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === '\\') {
      add(c + (text[i + 1] ?? ''));
      i += 2;
      continue;
    }
    // A command substitution runs its command, inside double quotes too: it is read as statements of its own.
    if (c === '$' && text[i + 1] === '(') {
      if (depth < MAX_NESTING) {
        i = splitShell(
          text,
          i + 2,
          true,
          depth + 1,
          out,
          inherited || braceParam > 0 || contextOf(head || 'x').uncertain,
        );
        add('$(…)');
      } else {
        add('$(');
        parens++;
        i += 2;
      }
      continue;
    }
    if (c === '`' && backticks) {
      const end = closingBacktick(text, i + 1);
      if (end < 0) {
        backticks = false;
        add(c);
        i++;
        continue;
      }
      if (depth < MAX_NESTING) {
        splitShell(
          text.slice(i + 1, end),
          0,
          false,
          depth + 1,
          out,
          inherited || braceParam > 0 || contextOf(head || 'x').uncertain,
        );
      }
      add('`…`');
      i = end + 1;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = '';
      add(c);
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      add(c);
      i++;
      continue;
    }
    // A comment runs to the end of the line: what it says is not run.
    if (c === '#' && (head === '' || /\s/.test(text[i - 1] ?? ''))) {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    // A `( … )` subshell where a word starts (`( … )`, `time ( … )`, `! ( … )`): an exit or `set` inside it stops only
    // the subshell, which the level's status does not show. Not `$(`, `<(`, `>(`, `=(` (read above), not `f ()`.
    // After a word too (`time(`, a glued keyword) and after `{` (`{( … )}`): bash reads either as a subshell.
    if (c === '(' && /^$|[\s;&|!{\w]$/.test(tail.slice(-1))) {
      let j = i + 1;
      while (text[j] === ' ' || text[j] === '\t') j++;
      if (text[j] !== ')') complex = true;
    }
    if (inSub && c === ')') {
      if (parens === 0) {
        flush(undefined);
        finish();
        return i + 1;
      }
      parens--;
    } else if (inSub && c === '(') {
      parens++;
    }
    const two = text.slice(i, i + 2);
    // A lone `&` (not `&&`, `>&`, `&>`, `<&`) runs the command in the background: a separator.
    if (c === '&' && two !== '&&' && !/[<>&]/.test(text[i - 1] ?? '') && text[i + 1] !== '>') {
      flush('&');
      i++;
      continue;
    }
    if (c === '\n' || c === ';' || two === '&&' || two === '||' || c === '|') {
      flush(two === '&&' || two === '||' ? two : c === '|' ? '|' : ';');
      i += two === '&&' || two === '||' ? 2 : 1;
      continue;
    }
    add(c);
    i++;
  }
  flush(undefined);
  finish();
  return i;
}

/**
 * The statements of a shell command; a heredoc's body is read as shell, code or data by the command reading it. A
 * heredoc body is uncertain when any statement of the command is (its head's own context is not tracked).
 */
function shellStatements(command: string, depth: number, out: Statement[] = [], inherited = false): Statement[] {
  const lines = command.split('\n');
  const kept: string[] = [];
  const bodies: Statement[] = [];
  // The quote state at each line's start, carried across lines (a quoted commit message spans several).
  let quote: '"' | "'" | '' = '';
  /** Where in `line` the unquoted `<<` operators are; the quote state after the line. */
  const unquotedOps = (line: string): number[] => {
    const at: number[] = [];
    for (let k = 0; k < line.length; k++) {
      const c = line[k];
      if (quote === "'") {
        if (c === "'") quote = '';
      } else if (quote === '"') {
        if (c === '\\') k++;
        else if (c === '"') quote = '';
      } else if (c === '\\') k++;
      else if (c === "'" || c === '"') quote = c;
      else if (c === '<' && line[k + 1] === '<' && line[k - 1] !== '<' && line[k + 2] !== '<') {
        at.push(k);
        k++;
      }
    }
    return at;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    kept.push(line);
    HEREDOC_OPS.lastIndex = 0;
    const any = HEREDOC_OPS.test(line);
    const ops = unquotedOps(line);
    if (!any) continue;
    if (ops.length === 0) continue; // every `<<` on the line is inside quotes: data
    const m = line.match(HEREDOC);
    // A heredoc the line grammar cannot place — two on a line, or a delimiter it does not read (`<<'END HERE'`) —
    // leaves the whole command unread.
    if (!m || ops.length !== 1 || m.index !== ops[0]) return out;
    const before = line.slice(0, m.index);
    const strip = m[1] === '-';
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length && (strip ? lines[j].replace(/^\t+/, '') : lines[j]) !== m[3]) body.push(lines[j++]);
    // Another redirection on the head line replaces the heredoc as the program's input: its body is data.
    const rest = line.slice((m.index ?? 0) + m[0].length);
    const redirected = /(?<![<>])<(?!<)|<\(/.test(before.replace(/<<.*/, '')) || /(?<![<>])<(?!<)/.test(rest);
    const kind = redirected ? undefined : heredocKind(before);
    if (kind === 'shell') {
      if (depth < MAX_NESTING) shellStatements(body.join('\n'), depth + 1, bodies, inherited);
    } else if (kind) bodies.push({ text: body.join('\n'), code: kind, depth: depth + 1 });
    i = j;
  }
  const split: Statement[] = [];
  splitShell(kept.join('\n'), 0, false, depth, split, inherited, depth === 0 && !inherited);
  const unsure = inherited || split.some((s) => s.uncertain);
  for (const b of bodies) out.push(unsure ? { ...b, uncertain: true } : b);
  out.push(...split);
  return out;
}

// ── Reading a request ────────────────────────────────────────────────────────────────────────────────────────────────

const GH_CLI = /^[({]*(?:[^\s/]*\/)*gh\s+(pr|issue)\s+(create|merge|close)\b([^\n]*)/;
const REPO_FLAG =
  /(?:^|\s)(?:-R|--repo)(?:\s+|=)['"]?(?:https:\/\/)?(?:github\.com\/)?([\w.-]+\/[\w.-]+?)(?:\.git)?['"]?(?=\s|$)/;
const ISSUE_OR_PR_URL = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/(\d+)/;

const GH_CLI_READ = /^[({]*(?:[^\s/]*\/)*gh\s+(pr|issue)\s+([a-z-]+)\b([^\n]*)/;

/** `gh pr view` / `list` / `checks` / …: a read of that kind, in the repo `-R` names (any repo when none). */
function ghCliRead(command: string): GitHubWrite | undefined {
  const m = command.match(GH_CLI_READ);
  if (!m || /^(?:create|merge|close)$/.test(m[2])) return undefined;
  const repo = (m[3] ?? '').match(REPO_FLAG)?.[1]?.toLowerCase();
  return { op: 'read', kind: m[1] === 'pr' ? 'pr' : 'issue', ...(repo ? { repo } : {}) };
}

/** `gh pr|issue create|merge|close …`, read from the command word on. */
function ghCliWrite(command: string): GitHubWrite | undefined {
  const m = command.match(GH_CLI);
  if (!m) return undefined;
  // `--help` / `-h` prints help, `--dry-run` prints what it would create (the body verbatim), `--web` / `-w` opens a
  // browser: nothing is written.
  // Read outside quotes: `--title "add a --dry-run flag"` is a title, not the flag (fable-zhuge, round 18).
  const unquoted = (m[3] ?? '').replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
  if (/(?:^|\s)(?:--help|-h|--dry-run|--web|-w)(?==|\s|$)/.test(unquoted))
    return { op: 'read', kind: m[1] === 'pr' ? 'pr' : 'issue' };
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
  return { op: action, kind, ...(repo ? { repo } : {}), ...(number ? { number } : {}), via: 'cli' };
}

/**
 * What a known HTTP client's options mean, as far as a write goes. Anything not listed — an option the grammar does
 * not know — makes the whole command unread: a miss, never a guess. `bail` marks options that make the command
 * several requests (`--next`).
 */
type OptionRole = 'flag' | 'value' | 'data' | 'method' | 'get' | 'head' | 'url' | 'host' | 'bail';
interface ClientSpec {
  short: Record<string, OptionRole>;
  long: Record<string, OptionRole>;
}

const roles = (role: OptionRole, names: string): Record<string, OptionRole> =>
  Object.fromEntries(
    names
      .split(/\s+/)
      .filter(Boolean)
      .map((n) => [n, role]),
  );

const CLIENTS: Record<string, ClientSpec> = {
  curl: {
    short: {
      ...roles('flag', 's S L k i v f N q g Z 0 1 2 3 4 6 j J O R # l n B p'),
      ...roles('value', 'H u A e b c o w T x E r m y Y z C U Q t'),
      K: 'bail',
      G: 'get',
      I: 'head',
      d: 'data',
      F: 'data',
      X: 'method',
      ':': 'bail',
    },
    long: {
      ...roles(
        'flag',
        '--silent --show-error --location --location-trusted --insecure --include --verbose --fail --fail-with-body --fail-early --compressed --http1.0 --http1.1 --http2 --http2-prior-knowledge --http3 --globoff --no-progress-meter --progress-bar --no-buffer --raw --remote-name --remote-header-name --create-dirs --no-keepalive --tcp-nodelay --ipv4 --ipv6 --disable --path-as-is --no-sessionid --ssl --ssl-reqd --tlsv1.2 --tlsv1.3 --netrc --netrc-optional --no-alpn --no-npn --styled-output --no-styled-output --trace-time --junk-session-cookies --remote-time --anyauth --basic --digest --ntlm --negotiate',
      ),
      ...roles(
        'value',
        '--header --user --user-agent --referer --cookie --cookie-jar --output --write-out --upload-file --url-query --proxy --proxy-user --proxy-header --cert --key --cacert --capath --range --max-time --connect-timeout --retry --retry-delay --retry-max-time --oauth2-bearer --max-redirs --resolve --connect-to --interface --limit-rate --stderr --trace --trace-ascii --dump-header --etag-save --etag-compare --variable --max-filesize --speed-limit --speed-time --keepalive-time --dns-servers --proto --proto-redir --noproxy --unix-socket --aws-sigv4',
      ),
      ...roles('data', '--data --data-raw --data-binary --data-urlencode --data-ascii --json --form --form-string'),
      '--request': 'method',
      '--get': 'get',
      '--head': 'head',
      '--url': 'url',
      '--next': 'bail',
      '--config': 'bail',
    },
  },
  gh: {
    short: { i: 'flag', H: 'value', q: 'value', t: 'value', p: 'value', f: 'data', F: 'data', X: 'method' },
    long: {
      ...roles('flag', '--include --paginate --silent --verbose --slurp'),
      ...roles('value', '--header --jq --template --cache --preview'),
      '--hostname': 'host',
      ...roles('data', '--field --raw-field --input'),
      '--method': 'method',
    },
  },
  wget: {
    // wget's `-X` excludes directories; its method is only `--method`.
    short: { ...roles('flag', 'q c v N S'), ...roles('value', 'O o a U t T P X D I e') },
    long: {
      ...roles(
        'flag',
        '--quiet --verbose --no-verbose --continue --timestamping --server-response --no-check-certificate --content-on-error',
      ),
      ...roles('value', '--header --user-agent --output-document --output-file --tries --timeout --directory-prefix'),
      ...roles('data', '--post-data --post-file --body-data --body-file'),
      '--method': 'method',
    },
  },
};

/** What a client command asks, read by its options: its destinations and its method — or unread. */
interface ClientRequest {
  destinations: Word[];
  method: string;
}

/**
 * Reads a curl / gh api / wget command the way the client's own option parser does: a short option bundle is read
 * letter by letter (`-sGd x`: flags, then GET, then a data option taking the next word or the rest of the bundle), a
 * long option takes `=value` or the next word, and every option's value is consumed — so a `-X POST` or `-d` spelled
 * inside a header or another option's value is that value, not an option. The method is the last one given; else HEAD
 * for `-I` / `--head`, GET for `-G` / `--get`, POST when data is sent, GET otherwise. Unknown options, `--next`, and a
 * method word that is not a method leave the command unread.
 */
function readClient(words: Word[], at: number, name: string): ClientRequest | undefined {
  const spec = CLIENTS[name];
  if (!spec) return undefined;
  const destinations: Word[] = [];
  let method: string | undefined;
  let get = false;
  let head = false;
  let data = false;
  const take = (role: OptionRole, value: string | undefined, word: Word | undefined): boolean => {
    if (role === 'bail') return false;
    if (role === 'get') get = true;
    else if (role === 'head') head = true;
    else if (role === 'data') data = true;
    else if (role === 'method') {
      if (value === undefined || !METHOD_WORD.test(value)) return false;
      method = value.toUpperCase();
    } else if (role === 'url' && word) destinations.push(word);
    else if (role === 'host') return value === 'github.com';
    return true;
  };
  const takesValue = (role: OptionRole) =>
    role === 'value' || role === 'data' || role === 'method' || role === 'url' || role === 'host';
  // gh: `gh api <endpoint>` — the subcommand is not a destination.
  let k = at + 1;
  if (name === 'gh') {
    if (words[k]?.value !== 'api') return undefined;
    k++;
  }
  for (; k < words.length; k++) {
    const v = words[k].value;
    if (v === '--') {
      destinations.push(...words.slice(k + 1));
      break;
    }
    if (v.startsWith('--')) {
      const eq = v.indexOf('=');
      const opt = eq < 0 ? v : v.slice(0, eq);
      const role = spec.long[opt];
      if (!role) return undefined;
      if (!takesValue(role)) {
        if (eq >= 0 || !take(role, undefined, undefined)) return undefined;
        continue;
      }
      const value = eq >= 0 ? v.slice(eq + 1) : words[++k]?.value;
      const word = eq >= 0 ? { value: v.slice(eq + 1), start: words[k].start + eq + 1 } : words[k];
      if (!take(role, value, word)) return undefined;
      continue;
    }
    if (v.startsWith('-') && v.length > 1) {
      // A bundle, letter by letter: an option taking a value takes the rest of the bundle, or the next word.
      for (let c = 1; c < v.length; c++) {
        const role = spec.short[v[c]];
        if (!role) return undefined;
        if (!takesValue(role)) {
          if (!take(role, undefined, undefined)) return undefined;
          continue;
        }
        const rest = v.slice(c + 1);
        const value = rest || words[++k]?.value;
        if (!take(role, value, rest ? undefined : words[k])) return undefined;
        break;
      }
      continue;
    }
    // A redirection (`2>&1`, `> out.json`, `< p.json`, `<<'EOF'`, `<<<`) is the shell's: skip it and a detached target.
    const redirect = v.match(/^[0-9]*(?:<<<|<<-?|<>|>>|>\||&>>|&>|>&|<&|[<>])(.*)$/);
    if (redirect) {
      if (redirect[1] === '') k++;
      continue;
    }
    // A bare variable (`"$EXTRA"`) may expand to options (`-XGET`) or a destination: the command is unread.
    if (v.includes('$')) return undefined;
    destinations.push(words[k]);
  }
  return { destinations, method: method ?? (head ? 'HEAD' : get ? 'GET' : data ? 'POST' : 'GET') };
}

/** httpie (`http`, `https`, `xh`): an explicit method, then the URL. Options or an implied method leave it unread. */
function readHttpie(words: Word[], at: number): ClientRequest | undefined {
  const rest = words.slice(at + 1);
  if (rest.some((w) => w.value.startsWith('-'))) return undefined;
  const [verb, url] = rest;
  if (!verb || !url || !METHOD_WORD.test(verb.value) || !VERBS.test(verb.value)) return undefined;
  return { destinations: [url], method: verb.value.toUpperCase() };
}

/** The PR and issue writes a shell request names. */
/**
 * Whether a command holds an unquoted `$` expansion (`-H $HEADER`, `$(…)`): the shell splits it into words — options,
 * values, destinations — the parser cannot see, so a client command with one is not read. `"$T"` stays one word.
 */
function unquotedExpansion(text: string): boolean {
  let quote: '"' | "'" | '' = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === "'") {
      if (c === "'") quote = '';
    } else if (quote === '"') {
      if (c === '\\') i++;
      else if (c === '"') quote = '';
      // `"$@"` and `"${arr[@]}"` expand to several words even when quoted.
      else if (c === '$' && /^\$(?:@|\{@\}|\{!?[A-Za-z_]\w*\[@\]\})/.test(text.slice(i, i + 72))) return true;
    } else if (c === '\\') i++;
    else if (c === "'" || c === '"') quote = c;
    else if (c === '$' || c === '`') return true;
  }
  return false;
}

function apiWrites(words: Word[], at: number): GitHubWrite[] {
  const name = nameOf(words[at]?.value);
  const requests =
    name in CLIENTS
      ? [readClient(words, at, name)]
      : name === 'http' || name === 'https' || name === 'xh'
        ? [readHttpie(words, at)]
        : []; // a script: what it sends is not visible, and its arguments prove nothing
  const out: GitHubWrite[] = [];
  for (const r of requests) {
    if (!r) continue;
    for (const d of r.destinations) {
      // Any other destination is still a request whose output is in the result: marked as a read of its repo (any
      // repo when the URL names none).
      const repo = d.value.match(/^(?:(?:https?:\/\/)?api\.github\.com\/|\/)?repos\/([\w.-]+)\/([\w.-]+)(?:[/?#]|$)/);
      out.push(
        writeAt(d.value, r.method) ?? {
          op: 'read',
          kind: 'pr',
          ...(repo ? { repo: `${repo[1]}/${repo[2]}`.toLowerCase() } : {}),
        },
      );
    }
  }
  return out;
}

// ── Reading code ─────────────────────────────────────────────────────────────────────────────────────────────────────
//
// Code sends only through a call, so only a call counts — never data that spells a request: `{ method: "POST", url }`,
// `const method = "POST"`, or a string that prints one (`console.log('fetch(…, { method: "POST" })')`). The code is
// lexed for its language — strings, comments and regex literals are masked — and read by a fixed grammar of calls
// (codeWrites). Precision first: a request outside it is a miss, which the turn-end GitHub check (#833) backs.

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

/**
 * Regex scanning per line is bounded: past it, the rest of the line is masked — a miss, never a guess — so a long or
 * pathological line stays linear and a long regex literal is never read as code.
 */
const REGEX_BUDGET = 4096;

/**
 * Where a regex literal opening at `at` ends (exclusive, flags included), scanning to `limit`: `end` -1 when none on
 * the line; `cut` when the scan stopped at the budget, not at the line's end.
 */
function regexScan(code: string, at: number, limit: number): { end: number; scanned: number; cut: boolean } {
  let inClass = false;
  for (let j = at + 1; j < limit; j++) {
    const c = code[j];
    if (c === '\n') return { end: -1, scanned: j - at, cut: false };
    if (c === '\\') j++;
    else if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      let end = j + 1;
      while (end < code.length && /[A-Za-z]/.test(code[end])) end++;
      return { end, scanned: j - at, cut: false };
    }
  }
  return { end: -1, scanned: limit - at, cut: limit < code.length && code[limit] !== '\n' };
}

/**
 * Whether the `/` at `at` opens a regex literal (ending at `end`, -1 when none), given the last code character and
 * word before it. After an operator, an opening bracket, a keyword or at the start, JS reads a regex. After an operand
 * (a name, a number, `)`, `]`, a string — on the same line or the line before) JS reads a division, so it is masked
 * only when a division could not compile: no space after the `/`, and the would-be closing `/` (and flags) followed by
 * `.name`, `)`, `,`, `;`, `]`, `}` or the end. `x /re/ y` and `(0)/re/+0` divide — a call between the slashes runs.
 */
function isRegexAt(code: string, at: number, last: string, word: string, end: number): boolean {
  if (end < 0) return false;
  if (last === '' || /[(,=:[!&|?{};+\-*/%<>~^]/.test(last) || BEFORE_REGEX.has(word)) return true;
  if (/\s/.test(code[at + 1] ?? ' ')) return false;
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
  let lineEnd = -1;
  let budget = REGEX_BUDGET;
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
    if (c === '/' && lang !== 'py') {
      if (i >= lineEnd) {
        const nl = code.indexOf('\n', i);
        lineEnd = nl < 0 ? n : nl;
        budget = REGEX_BUDGET;
      }
      const scan = regexScan(code, i, Math.min(lineEnd, i + budget));
      budget -= scan.scanned;
      if (scan.cut) {
        blank(lineEnd);
        continue;
      }
      const end = scan.end;
      if (isRegexAt(code, i, last, word, end)) {
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
/** Any HTTP method token: an explicit method outside VERBS (HEAD, OPTIONS) is a request that writes nothing. */
const METHOD_WORD = /^[A-Za-z]+$/;
/** Every call in masked code, with its receiver chain: `child_process.execSync(`, `requests.post(`, `fetch(`. */
const CALL = /(?<![\w$])((?:[A-Za-z_$][\w$]*\.)*)([A-Za-z_$][\w$]*)\s*\(/g;
const MAX_CALLS = 512;
/** The module a client name is bound from when the code imports it with `require` / `import()`. */
const CLIENT_MODULES: Record<string, string> = {
  axios: 'axios',
  got: 'got',
  ky: 'ky',
  superagent: 'superagent',
  https: 'https',
  http: 'http',
  child_process: 'child_process',
  cp: 'child_process',
  execSync: 'child_process',
  exec: 'child_process',
};
const MAX_CALL_LENGTH = 8000;

/**
 * The whole of a destination: an api.github.com URL or a bare `/repos/…` path, from its start — never an endpoint
 * spelled inside another URL's query, a template, or a longer path.
 */
const DESTINATION =
  /^(?:(?:https?:\/\/)?api\.github\.com\/|\/)?repos\/([\w.-]+)\/([\w.-]+)\/(pulls|issues)(?:\/(\d+)(?:\/(merge))?)?\/?(?:[?#][^\s]*)?$/;
/** A code client's destination is an absolute URL: a bare path means another host (or the page's own). */
const ABSOLUTE = /^https:\/\/api\.github\.com\//;

/** One argument or one object property value, as the grammar reads it. */
type Value =
  | { kind: 'string'; value: string }
  | { kind: 'object'; props: Map<string, Value>; open: boolean }
  | { kind: 'request'; args: Arg[] }
  | { kind: 'other'; text: string };

interface Arg {
  /** A Python keyword argument's name (`url=`, `method=`, `shell=`). */
  kw?: string;
  value: Value;
}

/** The literal at exactly [from, to) of masked code: a whole string (Python prefixes allowed), else undefined. */
function stringAt(lexed: Lexed, from: number, to: number): string | undefined {
  const k = firstStringFrom(lexed.strings, from);
  const s = lexed.strings[k];
  if (!s) return undefined;
  if (!/^[frbuFRBU]{0,2}$/.test(lexed.masked.slice(from, s.start).trim())) return undefined;
  if (lexed.masked.slice(s.end, to).trim() !== '') return undefined;
  // A template with an interpolation is not a literal.
  if (lexed.masked[s.start] === '`' && s.value.includes('${')) return undefined;
  return s.value;
}

/**
 * The top-level pieces of masked code between `from` and `to`, split at commas outside brackets and strings (the
 * lexer blanked string contents, so their commas are gone).
 */
function piecesOf(masked: string, from: number, to: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let depth = 0;
  let start = from;
  for (let j = from; j < to; j++) {
    const c = masked[j];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      out.push([start, j]);
      start = j + 1;
    }
  }
  if (masked.slice(start, to).trim() !== '') out.push([start, to]);
  return out;
}

/** The index of the bracket closing the one at `open`, in masked code (bounded); -1 when not found. */
function closing(masked: string, open: number): number {
  let depth = 0;
  const limit = Math.min(masked.length, open + MAX_CALL_LENGTH);
  for (let j = open; j < limit; j++) {
    const c = masked[j];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if ((c === ')' || c === ']' || c === '}') && --depth === 0) return j;
  }
  return -1;
}

function trimmed(masked: string, from: number, to: number): [number, number] {
  while (from < to && /\s/.test(masked[from])) from++;
  while (to > from && /\s/.test(masked[to - 1])) to--;
  return [from, to];
}

/** What a piece of code is, as far as a request goes: a string literal, an object literal, a `Request(…)`, or other. */
function valueAt(lexed: Lexed, from: number, to: number, depth = 0): Value {
  const { masked } = lexed;
  [from, to] = trimmed(masked, from, to);
  const str = stringAt(lexed, from, to);
  if (str !== undefined) return { kind: 'string', value: str };
  if (depth < 3 && masked[from] === '{' && closing(masked, from) === to - 1) {
    const props = new Map<string, Value>();
    let open = false;
    for (const [a, b] of piecesOf(masked, from + 1, to - 1)) {
      const [x, y] = trimmed(masked, a, b);
      const piece = masked.slice(x, y);
      // A spread, a computed key or a shorthand property makes the object's contents unknown.
      if (piece.startsWith('...') || piece.startsWith('[')) {
        open = true;
        continue;
      }
      const colon = piece.search(/:/);
      if (colon < 0) {
        open = true;
        continue;
      }
      const rawKey = piece.slice(0, colon).trim();
      const key = /^[A-Za-z_$][\w$]*$/.test(rawKey) ? rawKey : stringAt(lexed, x, x + colon);
      if (key === undefined) {
        open = true;
        continue;
      }
      // A key given twice: which one wins is the language's business — unknown here.
      if (props.has(key)) open = true;
      props.set(key, valueAt(lexed, x + colon + 1, y, depth + 1));
    }
    return { kind: 'object', props, open };
  }
  const req = masked.slice(from, to).match(/^(?:new\s+)?(?:[A-Za-z_$][\w$]*\.)*Request\s*\(/);
  if (depth < 3 && req) {
    const open = from + req[0].length - 1;
    if (closing(masked, open) === to - 1) return { kind: 'request', args: argsOf(lexed, open, depth + 1) ?? [] };
  }
  return { kind: 'other', text: masked.slice(from, to) };
}

/** The arguments of the call whose `(` is at `open`; undefined when the call does not close within the bound. */
function argsOf(lexed: Lexed, open: number, depth = 0): Arg[] | undefined {
  const end = closing(lexed.masked, open);
  if (end < 0) return undefined;
  return piecesOf(lexed.masked, open + 1, end).map(([a, b]) => {
    const kw = lexed.masked.slice(a, b).match(/^\s*([A-Za-z_]\w*)\s*=(?!=)/);
    return kw
      ? { kw: kw[1], value: valueAt(lexed, a + kw[0].length, b, depth) }
      : { value: valueAt(lexed, a, b, depth) };
  });
}

const positional = (args: Arg[]) => args.filter((a) => !a.kw);
const keyword = (args: Arg[], name: string) => args.find((a) => a.kw === name)?.value;
const str = (v: Value | undefined) => (v?.kind === 'string' ? v.value : undefined);

/** A method value: a literal verb; `null` when given but not a literal (unknown); undefined when not given. */
function methodValue(v: Value | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  const s = str(v);
  return s !== undefined && METHOD_WORD.test(s) ? s.toUpperCase() : null;
}

/** The PR and issue write a whole destination names under a method. */
function writeAt(dest: string | undefined, verb: string | null | undefined, absolute = false): GitHubWrite | undefined {
  if (absolute && !ABSOLUTE.test(dest ?? '')) return undefined;
  const m = dest?.match(DESTINATION);
  if (!m) return undefined;
  const w = verb ? writeOf(m, verb) : undefined;
  return w ?? { op: 'read', kind: m[3] === 'pulls' ? 'pr' : 'issue', repo: `${m[1]}/${m[2]}`.toLowerCase() };
}

/** `fetch(url[, init])` / `fetch(new Request(url[, init]))`: the init object's single literal `method`, else GET. */
function fetchWrite(args: Arg[]): GitHubWrite | undefined {
  const pos = positional(args);
  if (pos.length === 0 || pos.length > 2 || pos.length !== args.length) return undefined;
  let [target, init] = [pos[0].value, pos[1]?.value];
  if (target.kind === 'request') {
    // The sender's own init overrides the Request's: read a Request only as fetch's sole argument.
    if (init !== undefined) return undefined;
    const inner = positional(target.args);
    if (inner.length === 0 || inner.length > 2) return undefined;
    [target, init] = [inner[0].value, inner[1]?.value];
  }
  if (init !== undefined && (init.kind !== 'object' || init.open)) return undefined;
  const method = init?.kind === 'object' ? methodValue(init.props.get('method')) : undefined;
  return writeAt(str(target), method === undefined ? 'GET' : method, true);
}

/** Whether a `data` argument sends a body: given, and not `None` (unknown values are not read as a body). */
function sendsData(v: Value | undefined): boolean | undefined {
  if (v === undefined) return false;
  if (v.kind === 'other') return v.text.trim() === 'None' ? false : undefined;
  return true;
}

/** `urlopen(url[, data])` / `urlopen(Request(url, data=…, method=…))`: POST when data is given, unless a method is. */
function urlopenWrite(args: Arg[]): GitHubWrite | undefined {
  const target = args[0]?.value;
  if (!target || args[0].kw) return undefined;
  if (target.kind === 'request') {
    if (args.length > 1) return undefined;
    const inner = target.args;
    const url = str(positional(inner)[0]?.value ?? keyword(inner, 'url'));
    const method = methodValue(keyword(inner, 'method'));
    return writeAt(
      url,
      method === undefined
        ? sendsData(positional(inner)[1]?.value ?? keyword(inner, 'data'))
          ? 'POST'
          : 'GET'
        : method,
      true,
    );
  }
  return writeAt(str(target), sendsData(positional(args)[1]?.value ?? keyword(args, 'data')) ? 'POST' : 'GET', true);
}

/** `requests.post(url, …)` / `requests.post(url=url, …)` / `requests.request("POST", url)` (also httpx). */
function requestsWrite(name: string, args: Arg[]): GitHubWrite | undefined {
  const pos = positional(args);
  if (name === 'request') {
    const method = methodValue(pos[0]?.value ?? keyword(args, 'method'));
    return writeAt(str(pos[1]?.value ?? keyword(args, 'url')), method, true);
  }
  return writeAt(str(pos[0]?.value ?? keyword(args, 'url')), name.toUpperCase(), true);
}

/** `axios.post(url, …)`, `axios(config)`, `axios(url, config)`, `axios.request(config)`. */
function axiosWrite(name: string, args: Arg[]): GitHubWrite | undefined {
  const pos = positional(args);
  if (pos.length !== args.length || pos.length === 0) return undefined;
  if (name !== 'axios' && name !== 'request') return writeAt(str(pos[0].value), name.toUpperCase(), true);
  const [a, b] = [pos[0].value, pos[1]?.value];
  const config = a.kind === 'object' ? a : b;
  if (config && (config.kind !== 'object' || config.open)) return undefined;
  if (a.kind === 'object' && pos.length > 1) return undefined;
  const url = a.kind === 'string' ? a.value : config?.kind === 'object' ? str(config.props.get('url')) : undefined;
  const method = config?.kind === 'object' ? methodValue(config.props.get('method')) : undefined;
  return writeAt(url, method === undefined ? 'GET' : method, true);
}

/** `https.request({ hostname: "api.github.com", path, method }, …)` or `https.request(url, { method }, …)`. */
function nodeRequestWrite(args: Arg[]): GitHubWrite | undefined {
  const [a, b] = [args[0]?.value, args[1]?.value];
  if (a?.kind === 'object') {
    if (a.open) return undefined;
    const host = str(a.props.get('hostname') ?? a.props.get('host'));
    if (host !== 'api.github.com') return undefined;
    const method = methodValue(a.props.get('method'));
    return writeAt(str(a.props.get('path')), method === undefined ? 'GET' : method);
  }
  if (a?.kind === 'string' && (b === undefined || (b.kind === 'object' && !b.open))) {
    if (
      b?.kind === 'object' &&
      ['host', 'hostname', 'path', 'port', 'protocol', 'socketPath'].some((k) => b.props.has(k))
    ) {
      return undefined;
    }
    const method = b?.kind === 'object' ? methodValue(b.props.get('method')) : undefined;
    return writeAt(a.value, method === undefined ? 'GET' : method, true);
  }
  return undefined;
}

/** `octokit.request("POST /repos/…", …)`: the route string names both. */
function routeWrite(args: Arg[]): GitHubWrite | undefined {
  const m = str(args[0]?.value)?.match(/^([A-Za-z]+)\s+(\S+)$/);
  return m ? writeAt(m[2], m[1].toUpperCase()) : undefined;
}

/**
 * The shell command a call runs, when it runs one through a shell: `execSync(cmd)` / `exec(cmd)` (child_process),
 * `os.system(cmd)` / `os.popen(cmd)`, `subprocess.getoutput(cmd)`, and `subprocess.run(cmd, shell=True)` and kin.
 * `execFileSync` / `spawnSync` / a `subprocess` call without `shell=True` run a program, not a shell line.
 */
function shellLineOf(chain: string, name: string, args: Arg[], dotted: boolean): string | undefined {
  const first = args[0] && !args[0].kw ? str(args[0].value) : undefined;
  if (first === undefined) return undefined;
  // `execSync` is child_process's by name, on any receiver (`require("child_process").execSync`); `exec` only bare or
  // on child_process (`re.exec(…)` is a regex).
  if (name === 'execSync') return first;
  if (name === 'exec' && ((!dotted && chain === '') || /^(?:child_process|cp)\.$/.test(chain))) return first;
  if (chain === 'os.' && (name === 'system' || name === 'popen')) return first;
  if (chain === 'subprocess.' && (name === 'getoutput' || name === 'getstatusoutput')) return first;
  if (chain === 'subprocess.' && /^(?:run|call|check_call|check_output|Popen)$/.test(name)) {
    const shell = args.find((a) => a.kw === 'shell')?.value;
    return shell?.kind === 'other' && shell.text.trim() === 'True' ? first : undefined;
  }
  return undefined;
}

/**
 * Whether the Node request created by the call at `at` (its `(` at `open`) is ended — chained (`https.request(…).end()`)
 * or through the variable it is assigned to (`const r = https.request(…); … r.end()`). Created and never ended (or
 * destroyed), it sends nothing.
 */
function endsRequest(masked: string, at: number, open: number, certain: (at: number) => boolean): boolean {
  const close = closing(masked, open);
  if (close < 0) return false;
  if (/^\s*\.end\s*\(/.test(masked.slice(close + 1, close + 64))) return true;
  const bound = masked.slice(Math.max(0, at - 80), at).match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/);
  if (!bound) return false;
  const v = bound[1];
  // Destroyed or aborted anywhere, or re-bound to something else: what it sends is not certain.
  if (new RegExp(`\\b${v}\\.(?:destroy|abort)\\s*\\(`).test(masked)) return false;
  if ((masked.match(new RegExp(`(?<![.\\w$])${v}\\s*=(?!=)`, 'g')) ?? []).length > 1) return false;
  // An `r.end(…)` that itself certainly runs (not in a branch, a callback or after an exit).
  for (const m of masked.slice(close).matchAll(new RegExp(`\\b${v}\\.end\\s*\\(`, 'g'))) {
    if (certain(close + (m.index ?? 0))) return true;
  }
  return false;
}

/**
 * Whether a call at a position of masked code certainly runs when the program runs: at the top level — not inside a
 * function, a block, another call's arguments, an arrow function, a condition (`if`, `&&`, `||`, `?`), a lambda, or
 * an indented Python block. Anything else may never run: not read.
 */
function certainCalls(masked: string, lang: CodeLang): (at: number) => boolean {
  // Brace depth only: a call in another call's arguments or in a list runs (arguments are evaluated first); a call in
  // a block or an object does not certainly run. Conditions inside parentheses are caught by the prefix.
  const depth = new Int32Array(masked.length + 1);
  let d = 0;
  for (let j = 0; j < masked.length; j++) {
    depth[j] = d;
    const c = masked[j];
    if (c === '{') d++;
    else if (c === '}' && d > 0) d--;
  }
  depth[masked.length] = d;
  // Parenthesis / bracket depth: the expression a call sits in, and a JS `for (…;…;…)` header's `;`.
  const pdepth = new Int32Array(masked.length + 1);
  // Python joins physical lines inside `(`, `[` and `{`: its logical line ends only at depth 0 of all three.
  const ldepth = new Int32Array(masked.length + 1);
  let q = 0;
  let l = 0;
  for (let j = 0; j < masked.length; j++) {
    pdepth[j] = q;
    ldepth[j] = l;
    const c = masked[j];
    if (c === '(' || c === '[') q++;
    else if ((c === ')' || c === ']') && q > 0) q--;
    if (c === '(' || c === '[' || c === '{') l++;
    else if ((c === ')' || c === ']' || c === '}') && l > 0) l--;
  }
  pdepth[masked.length] = q;
  ldepth[masked.length] = l;
  const js = /=>|&&|\|\||\?|\b(?:if|else|while|for|do|switch|case|function|return|catch|yield)\b/;
  const py = /\b(?:lambda|if|else|elif|and|or|while|for|def|class|return|yield|except|try)\b/;
  // Code after an exit or a throw may never run.
  const stop = masked.search(/\b(?:process\.exit|process\.kill|throw|sys\.exit|os\._exit|exit|quit)\b/);
  return (at: number) => {
    if (depth[at] !== 0 || (stop >= 0 && stop < at)) return false;
    // A JS statement runs to `;` or a brace outside parentheses (a condition on the line before, or a `for (…;…;…)`
    // header, still governs it); Python's to the end of its logical line (a trailing `\` or an open bracket or brace
    // joins the next physical line).
    let k = at - 1;
    if (lang === 'py') {
      while (k >= 0 && !(masked[k] === '\n' && masked[k - 1] !== '\\' && ldepth[k] === 0)) k--;
    } else {
      while (k >= 0 && !(/[;{}]/.test(masked[k]) && pdepth[k] === 0)) k--;
    }
    const prefix = masked.slice(k + 1, at);
    if (lang === 'py') {
      // An indented logical line is inside a block.
      const line = k + 1;
      if (/[ \t]/.test(masked[line] ?? '')) return false;
      // A ternary (`x if c else y`), a comprehension or a generator (`(post(u) for u in [])`) anywhere on the logical
      // line — or anywhere in the bracketed expression that holds the call.
      let end = at;
      while (end < masked.length && !(masked[end] === '\n' && masked[end - 1] !== '\\' && ldepth[end] === 0)) end++;
      if (/\b(?:if|else|for|lambda|while)\b/.test(masked.slice(line, end))) return false;
      if (pdepth[at] > 0) {
        let open = at - 1;
        while (open >= 0 && pdepth[open] > 0) open--;
        const close = open >= 0 ? closing(masked, open) : -1;
        const span = masked.slice(Math.max(0, open), close < 0 ? masked.length : close + 1);
        if (/\b(?:if|else|for|lambda|while|async)\b/.test(span)) return false;
      }
      return !py.test(prefix);
    }
    return !js.test(prefix);
  };
}

/**
 * The writes of code — only through calls in a fixed grammar, each with a literal destination that is a whole
 * argument (or a whole property): `fetch`, `urlopen`, `requests` / `httpx`, `axios`, `got` / `ky` / `superagent`,
 * `https.request`, an Octokit route, and the shell lines a call runs. Anything outside it — a destination or method in
 * a variable, a template, a concatenation, a spread — is not read: a miss, which the turn-end GitHub check backs.
 */
function codeWrites(code: string, lang: CodeLang, depth: number, out: GitHubWrite[]): void {
  // Ruby and Perl quote in ways the lexer does not know (`%q{…}`, `q{…}`): their code is not read.
  if (code.length > MAX_STATEMENT_LENGTH || lang === 'rb') return;
  const lexed = lexCode(code, lang);
  const { masked } = lexed;
  const certain = certainCalls(masked, lang);
  let calls = 0;
  CALL.lastIndex = 0;
  for (const m of masked.matchAll(CALL)) {
    if (++calls > MAX_CALLS) break;
    const chain = m[1];
    const name = m[2];
    const open = (m.index ?? 0) + m[0].length - 1;
    const known =
      name === 'fetch' ||
      name === 'urlopen' ||
      name === 'axios' ||
      name === 'request' ||
      /^(?:execSync|exec|system|popen|getoutput|getstatusoutput|run|call|check_call|check_output|Popen)$/.test(name) ||
      /^(?:requests|httpx|axios|got|ky|superagent)\.$/.test(chain);
    if (!known || !certain(m.index ?? 0)) continue;
    // A sender the code defines itself (`const fetch = …`, `requests = Mock()`, `import x as fetch`) is not the client.
    const root = (chain.split('.')[0] || name).replace(/[^\w$]/g, '');
    // `const axios = require("axios")` / `= await import("axios")` binds the client itself — only that module, nothing
    // chained after it; any other binding shadows it.
    const clientModule = CLIENT_MODULES[root];
    // (The module name is a string — blanked in masked code — so it is read from the code at the same position.)
    // `require("axios")`, `require("axios").default`, `require("child_process").execSync` for `execSync`.
    const ownModule = clientModule
      ? new RegExp(
          `^\\s*(?:require|await\\s+import)\\s*\\(\\s*["'\`](?:node:)?${clientModule}["'\`]\\s*\\)(?:\\.default|\\.${root})?(?:\\s*;|\\s*$|[ \\t]*\\n(?!\\s*(?:[.([\`+\\-*/%<>=!&|^?,:]|in\\b|instanceof\\b)))`,
        )
      : undefined;
    const rebinds = [...masked.matchAll(new RegExp(`\\b${root}\\s*=(?!=)`, 'g'))].some(
      (b) => !ownModule?.test(code.slice((b.index ?? 0) + b[0].length)),
    );
    const defines = new RegExp(`\\b(?:function|class|def)\\s+${root}\\b`).test(masked) || rebinds;
    const alias = new RegExp(`\\bas\\s+${root}\\b`);
    const knownAlias = new RegExp(`\\bimport\\s+(?:urllib\\.request|requests|httpx|subprocess|os)\\s+as\\s+${root}\\b`);
    if (defines || (alias.test(masked) && !knownAlias.test(masked))) continue;
    const args = argsOf(lexed, open);
    if (!args) continue;
    const dotted = (m.index ?? 0) > 0 && masked[(m.index ?? 0) - 1] === '.';
    const line = shellLineOf(chain, name, args, dotted);
    if (line !== undefined) {
      if (depth < MAX_NESTING) shellWrites(line, depth + 1, out);
      continue;
    }
    let w: GitHubWrite | undefined;
    if (name === 'fetch' && /^(?:|window\.|globalThis\.|self\.)$/.test(chain)) w = fetchWrite(args);
    else if (name === 'urlopen') w = urlopenWrite(args);
    else if (/^(?:requests|httpx)\.$/.test(chain) && /^(?:get|post|put|patch|delete|request)$/.test(name))
      w = requestsWrite(name, args);
    else if (
      (chain === '' && name === 'axios') ||
      (chain === 'axios.' && /^(?:get|post|put|patch|delete|request)$/.test(name))
    )
      w = axiosWrite(name, args);
    else if (/^(?:got|ky|superagent)\.$/.test(chain) && /^(?:get|post|put|patch|delete)$/.test(name))
      w = writeAt(str(positional(args)[0]?.value), name.toUpperCase(), true);
    else if ((chain === 'https.' || chain === 'http.') && name === 'request')
      // A Node request is sent when it is ended (`.end()`): without one, nothing goes out.
      w = endsRequest(masked, m.index ?? 0, open, certain) ? nodeRequestWrite(args) : { op: 'read', kind: 'pr' };
    else if (name === 'request') w = routeWrite(args);
    // A request the grammar does not read as a GitHub write still printed something: mark it, so a receipt in the
    // same call is not taken from its output.
    out.push(w ?? { op: 'read', kind: 'pr' });
  }
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

/** The writes of a shell command, statement by statement; nested shell and code are read the same way. */
function shellWrites(command: string, depth: number, out: GitHubWrite[]): void {
  for (const st of shellStatements(command, depth)) {
    if (st.uncertain) continue;
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
    const cli = ghCliWrite(st.text.slice(words[at].start)) ?? ghCliRead(st.text.slice(words[at].start));
    if (cli) out.push(cli);
    const run = runOf(words, at);
    if (!run) continue;
    if ('send' in run) out.push(...(unquotedExpansion(st.text.slice(words[at].start)) ? [] : apiWrites(words, at)));
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
  // A primitive only: `Number()` of an object with a broken `toString` throws (astra-zhuge P2).
  const raw = input.pull_number ?? input.issue_number ?? input.number;
  const num = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : Number.NaN;
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
  // A model-written command makes a handful; a bound keeps one pathological call cheap to prove.
  return out.slice(0, MAX_WRITES);
}

interface FoundObject {
  repo: string;
  kind: 'pr' | 'issue';
  number: number;
  url: string;
  /** `json`: a top-level document with its own number; `line`: a URL alone on a line (any output's text could hold it). */
  source: 'json' | 'line';
}

const ISSUE_OR_PR_HTML = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/(\d+)$/;
const LONE_URL = /^[ \t]*(https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/(\d+))\/?[ \t]*$/gm;
/** gh's own success lines, read only at the start of a line — never inside a title or a JSON body. */
const MERGED_LINE =
  /^[ \t]*(?:✓[ \t]+)?(?:(?:squashed|rebased)[ \t]+and[ \t]+)?merged[ \t]+pull[ \t]+request[ \t]+(?:([\w.-]+\/[\w.-]+))?#(\d+)/gim;
const CLOSED_LINE = /^[ \t]*(?:✓[ \t]+)?closed[ \t]+(pull[ \t]+request|issue)[ \t]+(?:([\w.-]+\/[\w.-]+))?#(\d+)/gim;
const MAX_DOCUMENTS = 512;

interface Said {
  repo?: string;
  number: number;
  kind: 'pr' | 'issue';
}

/**
 * One result, read once: the top-level JSON objects it prints (each a whole document — a line or a pretty-printed
 * block — never an object nested in another or an array element), the PR and issue objects among them and the URLs
 * alone on a line (in order), and the merges and closes gh's own lines say happened.
 */
interface ResultIndex {
  text: string;
  docs: Array<Record<string, unknown>>;
  objects: FoundObject[];
  merged: Said[];
  closed: Said[];
}

/** The end (exclusive) of the JSON value opening at `from`, by bracket count outside strings; -1 when unclosed. */
function jsonEnd(text: string, from: number): number {
  let depth = 0;
  let inString = false;
  for (let j = from; j < text.length; j++) {
    const c = text[j];
    if (inString) {
      if (c === '\\') j++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{' || c === '[') depth++;
    else if ((c === '}' || c === ']') && --depth === 0) return j + 1;
  }
  return -1;
}

/** The top-level JSON documents of a result that start a line, and where each starts. Linear: each is read once. */
function documentsIn(text: string): { docs: Array<{ at: number; value: unknown }>; complete: boolean } {
  const out: Array<{ at: number; value: unknown }> = [];
  let i = 0;
  while (i < text.length && out.length < MAX_DOCUMENTS) {
    const nl = text.indexOf('\n', i);
    const lineEnd = nl < 0 ? text.length : nl;
    let s = i;
    while (s < lineEnd && (text[s] === ' ' || text[s] === '\t')) s++;
    if (text[s] === '{' || text[s] === '[') {
      const end = jsonEnd(text, s);
      // Unclosed: what follows may be inside it (a truncated listing's elements) — no document after it is read.
      if (end < 0) return { docs: out, complete: false };
      try {
        out.push({ at: s, value: JSON.parse(text.slice(s, end)) });
        i = end;
        continue;
      } catch {
        // Not JSON as a whole: its lines may still be inside it — stop here too.
        return { docs: out, complete: false };
      }
    }
    i = lineEnd + 1;
  }
  return { docs: out, complete: i >= text.length };
}

function indexResult(text: string): ResultIndex {
  const docs: Array<Record<string, unknown>> = [];
  const found: Array<FoundObject & { at: number }> = [];
  const read = documentsIn(text);
  for (const d of read.docs) {
    // An array is a listing, never the object a write returns: its elements prove nothing.
    if (!d.value || typeof d.value !== 'object' || Array.isArray(d.value)) continue;
    const o = d.value as Record<string, unknown>;
    docs.push(o);
    const m = typeof o.html_url === 'string' ? o.html_url.match(ISSUE_OR_PR_HTML) : null;
    // The object's own number and URL agree: one object, not a URL and a number from different places.
    if (m && o.number === Number(m[4])) {
      found.push({
        at: d.at,
        repo: `${m[1]}/${m[2]}`.toLowerCase(),
        kind: m[3] === 'pull' ? 'pr' : 'issue',
        number: Number(m[4]),
        url: o.html_url as string,
        source: 'json',
      });
    }
  }
  if (!read.complete) {
    docs.length = 0;
    found.length = 0;
  }
  LONE_URL.lastIndex = 0;
  for (const m of text.matchAll(LONE_URL)) {
    found.push({
      at: m.index ?? 0,
      repo: `${m[2]}/${m[3]}`.toLowerCase(),
      kind: m[4] === 'pull' ? 'pr' : 'issue',
      number: Number(m[5]),
      url: m[1],
      source: 'line',
    });
  }
  MERGED_LINE.lastIndex = 0;
  CLOSED_LINE.lastIndex = 0;
  return {
    text,
    docs,
    objects: found.sort((a, b) => a.at - b.at),
    merged: [...text.matchAll(MERGED_LINE)].map((m) => ({
      repo: m[1]?.toLowerCase(),
      number: Number(m[2]),
      kind: 'pr',
    })),
    closed: [...text.matchAll(CLOSED_LINE)].map((m) => ({
      repo: m[2]?.toLowerCase(),
      number: Number(m[3]),
      kind: /pull/i.test(m[1]) ? 'pr' : 'issue',
    })),
  };
}

/**
 * The state the result gives the PR or issue object itself — every top-level object with its `html_url` agreeing.
 * Two documents that disagree (a GET and a PATCH) give no state. A merged PR is never `closed` here.
 */
function stateOf(idx: ResultIndex, repo: string, kind: 'pr' | 'issue', number: number): string | undefined {
  const url = linkOf(repo, kind, number)?.url.toLowerCase();
  const states = new Set<string>();
  for (const d of idx.docs) {
    if (typeof d.html_url !== 'string' || d.html_url.toLowerCase() !== url || typeof d.state !== 'string') continue;
    states.add(
      kind === 'pr' && (d.merged === true || (typeof d.merged_at === 'string' && d.merged_at)) ? 'merged' : d.state,
    );
  }
  return states.size === 1 ? [...states][0] : undefined;
}

/** The said merge or close this write is: the one naming its number (and repo), or — when it names none — the first. */
function saidFor(w: GitHubWrite, said: Said[]): Said | undefined {
  return said.find(
    (x) =>
      x.kind === w.kind &&
      (w.number === undefined || x.number === w.number) &&
      (!w.repo || !x.repo || x.repo === w.repo),
  );
}

function linkOf(repo: string, kind: 'pr' | 'issue', number: number): CapturedLink | undefined {
  return classifyLinkUrl(`https://github.com/${repo}/${kind === 'pr' ? 'pull' : 'issues'}/${number}`);
}

/**
 * The creates of one call, proven together: per kind, the PR or issue objects the result holds (in order) must be
 * exactly as many as the creates, and pair with them repo for repo. Any other count — a read of the same repo beside a
 * create, a listing, a failed create — is ambiguous and proves none. gh's "already exists" (a failed create that
 * prints the existing PR's URL) proves none.
 */
/** Whether a merge or close is proven by gh's own line naming it (not by a REST response document). */
function gh(w: GitHubWrite, idx: ResultIndex): boolean {
  return !!saidFor(w, w.op === 'merge' ? idx.merged : idx.closed);
}

function createEffects(ws: ReadonlyArray<GitHubWrite>, idx: ResultIndex): GitHubEffect[] {
  // gh's failed create prints the existing PR's URL after "already exists".
  if (/^(?![ \t]*[{"[])[^\n]*already exists/im.test(idx.text)) return [];

  const out: GitHubEffect[] = [];
  for (const kind of ['pr', 'issue'] as const) {
    const creates = ws.filter((w) => w.op === 'create' && w.kind === kind);
    if (creates.length === 0) continue;
    // Only creates of this kind may share the call with them: any other request to the repo makes them ambiguous.
    // Any other request in the call — a read or a PATCH, of any repo — could have printed the object (a body, a --jq
    // projection): only creates and gh merges / closes may share the call with them.
    if (ws.some((o) => o.op !== 'create' && !((o.op === 'merge' || o.op === 'close') && o.via === 'cli'))) continue;
    const seen = new Set<string>();
    const objects = idx.objects.filter((o) => {
      const key = o.url.toLowerCase();
      if (o.kind !== kind || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (objects.length !== creates.length) continue;
    if (creates.some((w, i) => w.repo && w.repo !== objects[i].repo)) continue;
    for (const o of objects) {
      const link = classifyLinkUrl(o.url);
      if (link) out.push({ op: 'create', link });
    }
  }
  return out;
}

function effectOf(w: GitHubWrite, idx: ResultIndex, sameOp: number): GitHubEffect | undefined {
  if (w.op === 'merge') {
    // gh's line names the PR: it proves only that one. A REST merge response — `{ sha, merged: true, message:
    // "Pull Request successfully merged" }`, no PR identity of its own — proves the write only when the call made a
    // single merge and printed a single such response.
    const said = idx.merged.length > 0 ? saidFor(w, idx.merged) : undefined;
    if (idx.merged.length > 0 && !said) return undefined;
    const responses = idx.docs.filter(
      (d) =>
        d.merged === true &&
        typeof d.sha === 'string' &&
        typeof d.message === 'string' &&
        /successfully merged/i.test(d.message) &&
        d.html_url === undefined &&
        d.number === undefined,
    );
    if (!said && !(sameOp === 1 && w.repo && w.number && responses.length === 1)) return undefined;
    const repo = w.repo ?? said?.repo;
    const number = w.number ?? said?.number;
    const link = repo && number ? linkOf(repo, 'pr', number) : undefined;
    return link ? { op: 'merge', link } : undefined;
  }
  if (w.op === 'patch') {
    if (!w.repo || !w.number || stateOf(idx, w.repo, w.kind, w.number) !== 'closed') return undefined;
    const link = linkOf(w.repo, w.kind, w.number);
    return link ? { op: 'close', link } : undefined;
  }
  if (w.op !== 'close') return undefined;
  // close: gh's own line (`✓ Closed issue a/b#30 (…)`) naming this target, or an MCP update's object, closed.
  const said = saidFor(w, idx.closed);
  const byObject = !said && !!w.repo && !!w.number && stateOf(idx, w.repo, w.kind, w.number) === 'closed';
  if (!said && !byObject) return undefined;
  const repo = w.repo ?? said?.repo;
  const number = w.number ?? said?.number;
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
  const add = (effect: GitHubEffect | undefined) => {
    if (!effect) return;
    const key = `${effect.op} ${effect.link.url}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(effect);
  };
  for (const r of results ?? []) {
    if (!r || r.isError || !r.toolUseId) continue;
    const ws = writes.get(r.toolUseId);
    if (!ws || ws.length === 0) continue;
    const text = resultText(r.result);
    if (!text) continue;
    const idx = indexResult(text);
    for (const e of createEffects(ws, idx)) add({ ...e, toolUseId: r.toolUseId });
    const merges = ws.filter((x) => x.op === 'merge').length;
    for (const w of ws) {
      if (w.op === 'create' || w.op === 'read') continue;
      // A merge, close or PATCH is proven only when it is the call's only request: gh's lines and a merge response
      // carry no identity another request's output (any repo — a quoted body, a projection) could not imitate.
      const onlyCreates = ws.every((o) => o === w || o.op === 'create');
      if (ws.some((o) => o !== w) && !(onlyCreates && w.via === 'cli' && gh(w, idx))) continue;
      const e = effectOf(w, idx, w.op === 'merge' ? merges : 0);
      add(e && { ...e, toolUseId: r.toolUseId });
    }
  }
  return out;
}
