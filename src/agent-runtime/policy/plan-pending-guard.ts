/**
 * Plan mode (SSOT 2026-11-02 — 작업 계획 모드): while a dashboard task's plan is
 * not started, its turns plan; they do not do the work. `evaluateToolPolicy`
 * (step 6c) asks this check about every call of such a turn; a reason denies the
 * call in every permission mode, for admins too (trinity R2, astra P1).
 *
 * Research stays open — reading files (Read, Glob, Grep), the web (WebFetch,
 * WebSearch), read-only shell commands (ls, cat, grep, rg, find, git log/show/diff,
 * gh … view/list), getting the code to read (git clone/fetch into the task folder),
 * the exact read MCP tools and the plan tool itself.
 * Everything else is refused: the native write tools, subagents and workflows
 * (whose own calls would run outside the plan's sight), any tool not on the
 * research allow-list, any shell command this check cannot read as read-only,
 * and any MCP tool not on the exact read list.
 *
 * Fail-closed by construction (rules/permission.md rule 3): a command is split
 * and unquoted as the shell would (`lexCommand`), and allowed only when every
 * segment is an allow-listed read; whatever the lexer does not model exactly —
 * an expansion, an escape, a subshell, a redirection — is refused. Pure: no I/O.
 */

/**
 * The native tools a planning turn may call besides Bash (checked as a command): reading, searching,
 * the web, its own to-do list and background-output readers, skills (instructions), MCP resource
 * reads. Every other tool — a writer, a subagent or workflow, a tool that runs a command (`Monitor`),
 * schedules, notifies or triggers, and any tool a future SDK adds — is refused: an allow-list, so a
 * tool nobody listed fails closed. The policy hook of a planning turn sees every tool (catch-all
 * matcher, `build-stream-options.ts`), not only `TOOL_POLICY_MATCHERS`.
 */
export const PLAN_RESEARCH_TOOLS: readonly string[] = [
  'Read',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Skill',
  'TodoWrite',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskUpdate',
  'TaskOutput',
  'BashOutput',
  'TaskStop',
  'KillShell',
  'ToolSearch',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
];

/**
 * Commands that only read, whatever their arguments — none has an option that writes, runs a
 * program or reaches the network (`file -C` writes, `sort -o` writes, `fd -x` runs: not here).
 * A glob among their arguments is fine: whatever names it expands to, they still only read.
 */
const READ_COMMANDS = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'pwd',
  'echo',
  'printf',
  'which',
  'stat',
  'du',
  'df',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'cut',
  'tr',
  'nl',
  'cmp',
  'diff',
  'jq',
  'grep',
  'egrep',
  'fgrep',
  'true',
  'false',
  'test',
  '[',
  'cd',
]);

/** `git` subcommands that read. */
const GIT_READS = new Set([
  'status',
  'log',
  'show',
  'diff',
  'ls-files',
  'ls-tree',
  'grep',
  'blame',
  'rev-parse',
  'describe',
  'shortlog',
  'cat-file',
  'rev-list',
  'merge-base',
  'show-ref',
]);
/** Options of a reading `git` subcommand that write a file, run a program or open a pager program. */
const GIT_READ_REFUSED = [
  '--output',
  '--ext-diff',
  '--textconv',
  '--filters',
  '--open-files-in-pager',
  '-O',
  '--exec',
  '--upload-pack',
  '--receive-pack',
  '--config',
  '--template',
];
/** The only options `git clone` / `git fetch` take here (every other one is refused: -c, -u, --upload-pack, …). */
const GIT_FETCH_OPTIONS = new Set([
  '-q',
  '--quiet',
  '--progress',
  '--no-progress',
  '--depth',
  '--single-branch',
  '--no-single-branch',
  '--no-tags',
  '--tags',
  '--all',
  '--prune',
  '-b',
  '--branch',
  '--sparse',
]);
const GIT_FETCH_VALUED = ['--depth=', '--branch=', '--filter=', '--shallow-since='];

/** `gh <noun> <verb>` pairs that read. `gh api` is checked on its own (GET only). */
const GH_READS: Record<string, readonly string[]> = {
  pr: ['view', 'list', 'diff', 'checks', 'status'],
  issue: ['view', 'list', 'status'],
  repo: ['view', 'list', 'clone'],
  run: ['view', 'list'],
  release: ['view', 'list'],
  search: ['repos', 'issues', 'prs', 'code', 'commits'],
};
/** `gh api` options allowed here; the ones in `GH_API_VALUED` take the next token as their value. */
const GH_API_OPTIONS = new Set(['--paginate', '--slurp', '-i', '--include', '--silent', '--verbose']);
const GH_API_VALUED = new Set(['--jq', '-q', '--cache', '--hostname', '-X', '--method', '-t', '--template']);

/** One shell word after quote removal; `globbed` — it had an unquoted `*`, `?` or `[` (the shell expands it). */
interface Word {
  text: string;
  globbed: boolean;
}

/**
 * Splits a command the way the shell would, refusing (null) whatever this check does not model
 * exactly: any `$` (variables, `$(…)`, `$'…'`), a backslash, a backtick, braces (brace expansion),
 * parentheses (subshells), `#` (comments), `!`, `<`, a redirection other than `2>/dev/null`,
 * `>/dev/null` and `2>&1`, a background `&`, an unterminated quote and an empty segment. Quotes are
 * removed as the shell removes them, so `-de'lete'` is the word `-delete`.
 */
function lexCommand(command: string): Word[][] | null {
  const segments: Word[][] = [];
  let words: Word[] = [];
  let text = '';
  let inWord = false;
  let globbed = false;
  let quote: '' | "'" | '"' = '';
  const endWord = () => {
    if (inWord) words.push({ text, globbed });
    text = '';
    inWord = false;
    globbed = false;
  };
  const endSegment = (): boolean => {
    endWord();
    if (words.length === 0) return false;
    segments.push(words);
    words = [];
    return true;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote === "'") {
      if (c === "'") quote = '';
      else text += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = '';
      else if (c === '$' || c === '`' || c === '\\') return null;
      else text += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
      continue;
    }
    if (c === ' ' || c === '\t') {
      endWord();
      continue;
    }
    if (c === '\n' || c === ';') {
      if (!endSegment()) return null;
      continue;
    }
    if (c === '|' || c === '&') {
      const doubled = command[i + 1] === c;
      if (c === '&' && !doubled) return null; // a background job
      if (doubled) i++;
      if (!endSegment()) return null;
      continue;
    }
    if (c === '>') {
      // Only the harmless plumbing: [1|2]>/dev/null and 2>&1, as a word of their own.
      const fd = inWord ? text : '';
      if (inWord && fd !== '1' && fd !== '2') return null;
      const rest = command.slice(i + 1);
      const devNull = /^\s*\/dev\/null(?=[\s;|&]|$)/.exec(rest);
      const dupOut = fd === '2' && /^&1(?=[\s;|&]|$)/.exec(rest);
      const hit = devNull || dupOut;
      if (!hit) return null;
      text = '';
      inWord = false;
      globbed = false;
      i += hit[0].length;
      continue;
    }
    if ('$`\\{}()<#!'.includes(c)) return null;
    if (c === '*' || c === '?' || c === '[') globbed = true;
    text += c;
    inWord = true;
  }
  if (quote) return null;
  if (!endSegment()) return null;
  return segments;
}

/** `t` is option `opt`, or `opt=value`, or (a long `opt`) a longer option it prefixes, or (a short `opt`) `opt` with its value glued on. */
function isOption(t: string, opt: string): boolean {
  if (t === opt || t.startsWith(`${opt}=`)) return true;
  return opt.startsWith('--') ? t.startsWith(opt) : t.startsWith(opt) && t.length > opt.length;
}

function gitIsRead(args: string[]): boolean {
  let i = 0;
  // Global options that only change where or how it reads.
  while (i < args.length && args[i].startsWith('-')) {
    const opt = args[i];
    if (opt === '-C') i += 2;
    else if (opt === '--no-pager' || opt === '-P' || opt === '--no-optional-locks') i += 1;
    else return false; // -c, --config-env, --exec-path, … can make git run a program
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (!sub) return false;
  if (GIT_READS.has(sub)) {
    return !rest.some((t) => GIT_READ_REFUSED.some((opt) => isOption(t, opt)) || /^-[A-Za-z]*O/.test(t));
  }
  if (sub === 'clone' || sub === 'fetch') {
    // A transport helper (`ext::…`, `fd::…`) runs a command: refused, as is any option not listed.
    return rest.every((t) =>
      t.startsWith('-') ? GIT_FETCH_OPTIONS.has(t) || GIT_FETCH_VALUED.some((v) => t.startsWith(v)) : !t.includes('::'),
    );
  }
  // List-only forms of the subcommands that also change refs.
  if (sub === 'branch' || sub === 'tag') {
    const listing = ['--list', '-l', '-a', '-r', '-v', '-vv', '--all', '--remotes', '--show-current'];
    return rest.every((t) => listing.includes(t) || t.startsWith('--format=') || t.startsWith('--sort='));
  }
  if (sub === 'remote') {
    return rest.length === 0 || (rest.length === 1 && rest[0] === '-v') || (rest[0] === 'get-url' && rest.length === 2);
  }
  if (sub === 'config') {
    const reads = ['--get', '--get-all', '--list', '-l'];
    const scopes = ['--global', '--local', '--system', '--show-origin', '--name-only', '-z'];
    return (
      rest.some((t) => reads.includes(t)) &&
      rest.every((t) => !t.startsWith('-') || reads.includes(t) || scopes.includes(t))
    );
  }
  if (sub === 'worktree' || sub === 'stash') return rest.length === 1 && rest[0] === 'list';
  return false;
}

function ghIsRead(args: string[]): boolean {
  // `--` hands the rest to another program (`gh repo clone … -- <git options>`).
  if (args.includes('--')) return false;
  const [noun, verb, ...rest] = args;
  if (noun === 'api') {
    const tail = [verb, ...rest].filter((t): t is string => typeof t === 'string');
    for (let i = 0; i < tail.length; i++) {
      const t = tail[i];
      if (!t.startsWith('-')) continue;
      if (GH_API_VALUED.has(t)) {
        const value = tail[i + 1] ?? '';
        if ((t === '-X' || t === '--method') && value.toUpperCase() !== 'GET') return false;
        i++;
        continue;
      }
      if (t.startsWith('--method=')) {
        if (t.slice(9).toUpperCase() !== 'GET') return false;
        continue;
      }
      if (t.toUpperCase() === '-XGET' || t.startsWith('--jq=') || t.startsWith('--cache=')) continue;
      if (!GH_API_OPTIONS.has(t)) return false; // -f / -F / --field / --input (a body: POST), -H, clusters, …
    }
    return true;
  }
  return !!noun && !!verb && (GH_READS[noun] ?? []).includes(verb);
}

function segmentIsRead(words: Word[]): boolean {
  const [head, ...rest] = words;
  if (!head || head.globbed || head.text.includes('/') || head.text.includes('=')) return false; // a program by path, an assignment
  const name = head.text;
  const args = rest.map((w) => w.text);
  // These read their arguments as options too: a glob could expand to one (a cloned file named `-delete`).
  const globbed = rest.some((w) => w.globbed);
  if (name === 'git') return !globbed && gitIsRead(args);
  if (name === 'gh') return !globbed && ghIsRead(args);
  if (name === 'rg') return !globbed && !args.some((t) => t.startsWith('--pre'));
  if (name === 'find') {
    const acts = ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fls'];
    return !globbed && !args.some((t) => acts.some((a) => t.startsWith(a)));
  }
  // `sed -n 'N,Mp' file…` only: any other script can write (`w`) or run (`e`) something.
  if (name === 'sed') {
    return (
      !globbed &&
      args[0] === '-n' &&
      /^\d+(,(\d+|\$))?p$/.test(args[1] ?? '') &&
      args.slice(2).every((t) => !t.startsWith('-'))
    );
  }
  return READ_COMMANDS.has(name);
}

/** A shell command every segment of which is an allow-listed read; false whenever in doubt. */
export function isReadOnlyCommand(command: string): boolean {
  const segments = lexCommand(command);
  return segments !== null && segments.every(segmentIsRead);
}

/**
 * The MCP tools a planning turn may call: the plan tool and tools whose whole contract is a read,
 * by exact name — a read-shaped name proves nothing (`redis_query` takes `GEORADIUS … STORE`, a
 * write; trinity R3, astra P1). Any other MCP tool waits for 시작.
 */
export const PLAN_READ_MCP_TOOLS: readonly string[] = [
  'mcp__plan__plan_submit',
  'mcp__github__get_file_contents',
  'mcp__github__search_code',
  'mcp__github__search_repositories',
  'mcp__github__search_issues',
  'mcp__github__search_users',
  'mcp__github__get_issue',
  'mcp__github__get_pull_request',
  'mcp__github__get_pull_request_files',
  'mcp__github__get_pull_request_comments',
  'mcp__github__get_pull_request_reviews',
  'mcp__github__get_pull_request_status',
  'mcp__github__list_commits',
  'mcp__github__list_issues',
  'mcp__github__list_pull_requests',
  'mcp__filesystem__read_file',
  'mcp__filesystem__read_text_file',
  'mcp__filesystem__read_media_file',
  'mcp__filesystem__read_multiple_files',
  'mcp__filesystem__list_directory',
  'mcp__filesystem__list_directory_with_sizes',
  'mcp__filesystem__directory_tree',
  'mcp__filesystem__search_files',
  'mcp__filesystem__get_file_info',
  'mcp__filesystem__list_allowed_directories',
  'mcp__model-command__list',
];

/**
 * Step 6c's check: a reason when a planning turn's call would do the work, else
 * null. The plan tool (`mcp__plan__plan_submit`) always runs.
 */
export function checkPlanPendingCall(toolName: string, toolInput: Record<string, unknown>): string | null {
  if (toolName === 'Bash') {
    const command = typeof toolInput.command === 'string' ? toolInput.command : '';
    return isReadOnlyCommand(command) ? null : 'a shell command that is not read-only';
  }
  if (toolName.startsWith('mcp__')) {
    return PLAN_READ_MCP_TOOLS.includes(toolName) ? null : `${toolName} is not one of the read tools`;
  }
  return PLAN_RESEARCH_TOOLS.includes(toolName) ? null : `${toolName || 'this tool'} is not a research tool`;
}
