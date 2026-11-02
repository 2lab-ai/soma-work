/**
 * Plan mode (SSOT 2026-11-02 — 작업 계획 모드): while a dashboard task's plan is
 * not started, its turns plan; they do not do the work. `evaluateToolPolicy`
 * (step 6c) asks this check about every call of such a turn; a reason denies the
 * call in every permission mode, for admins too (trinity R2, astra P1).
 *
 * Research stays open — reading files (Read, Glob, Grep), the web (WebFetch,
 * WebSearch), read-only shell commands (ls, cat, grep, rg, find, git log/show/diff,
 * gh … view/list), getting the code to read (git clone/fetch into the task folder),
 * read-shaped MCP tools (get_/list_/search_/…_query) and the plan tool itself.
 * Everything else is refused: the native write tools, subagents and workflows
 * (whose own calls would run outside the plan's sight), any tool not on the
 * research allow-list, any shell command this check cannot read as read-only,
 * and any MCP tool not named for a read.
 *
 * Fail-closed by construction (rules/permission.md rule 3): a command is allowed
 * only when every segment of it parses as an allow-listed read; anything the
 * parser does not understand — a substitution, a redirection, a quote that hides
 * a separator — is refused. Pure: no I/O.
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

/** Commands that only read (their write options are refused below). */
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
  'file',
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

/** `git` subcommands that read (or fetch the code to read into the task folder). */
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
  'clone',
  'fetch',
]);

/** `gh <noun> <verb>` pairs that read. `gh api` is checked on its own (GET only). */
const GH_READS: Record<string, readonly string[]> = {
  pr: ['view', 'list', 'diff', 'checks', 'status'],
  issue: ['view', 'list', 'status'],
  repo: ['view', 'list', 'clone'],
  run: ['view', 'list'],
  release: ['view', 'list'],
  search: ['repos', 'issues', 'prs', 'code', 'commits'],
};

/** Harmless output plumbing, removed before the redirection check: `2>/dev/null`, `>/dev/null`, `2>&1`. */
const DEV_NULL = /(^|\s)[12]?>\s*\/dev\/null(?=\s|$)|(^|\s)2>&1(?=\s|$)/g;
/** Redirection, substitution, process substitution, expansion, a line continuation: never read-only here. */
const UNREADABLE = /[<>`]|\$\(|\$\{|\\\n/;

function unquote(token: string): string {
  return token.replace(/^['"]|['"]$/g, '');
}

function startsWithAny(token: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => token === p || token.startsWith(`${p}=`) || (p.length === 2 && token.startsWith(p)));
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
  if (
    rest.some((t) =>
      startsWithAny(t, ['--output', '--ext-diff', '--upload-pack', '-u', '--template', '--config', '-c']),
    )
  ) {
    return false;
  }
  if (GIT_READS.has(sub)) return true;
  // List-only forms of the subcommands that also change refs.
  if (sub === 'branch' || sub === 'tag') {
    const listing = [
      '--list',
      '-l',
      '-a',
      '-r',
      '-v',
      '-vv',
      '--all',
      '--remotes',
      '--show-current',
      '--contains',
      '--merged',
    ];
    return (
      rest.every((t) => t.startsWith('-')) &&
      rest.every((t) => listing.includes(t) || t.startsWith('--format') || t.startsWith('--sort'))
    );
  }
  if (sub === 'remote') return rest.length === 0 || rest[0] === '-v' || rest[0] === 'show' || rest[0] === 'get-url';
  if (sub === 'config') return rest.length > 0 && ['--get', '--get-all', '--list', '-l'].includes(rest[0]);
  if (sub === 'worktree' || sub === 'stash') return rest[0] === 'list';
  return false;
}

function ghIsRead(args: string[]): boolean {
  const [noun, verb, ...rest] = args;
  if (noun === 'api') {
    const tail = [verb, ...rest].filter((t): t is string => typeof t === 'string');
    for (let i = 0; i < tail.length; i++) {
      const t = tail[i];
      if (t === '-X' || t === '--method') {
        if ((tail[i + 1] || '').toUpperCase() !== 'GET') return false;
      } else if (t.startsWith('--method=') && t.slice(9).toUpperCase() !== 'GET') return false;
      else if (/^-X./.test(t) && t.slice(2).toUpperCase() !== 'GET') return false;
      // A field or an input body turns the call into a POST.
      if (startsWithAny(t, ['-f', '-F', '--field', '--raw-field', '--input'])) return false;
    }
    return true;
  }
  return !!noun && !!verb && (GH_READS[noun] ?? []).includes(verb);
}

function segmentIsRead(segment: string): boolean {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  const [head, ...args] = tokens.map(unquote);
  if (head.includes('=') || head.includes('/')) return false; // an assignment, or a program by path
  if (head === 'git') return gitIsRead(args);
  if (head === 'gh') return ghIsRead(args);
  if (head === 'rg') return !args.some((t) => t.startsWith('--pre'));
  if (head === 'find') {
    return !args.some((t) =>
      ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls'].includes(t),
    );
  }
  if (head === 'fd') return !args.some((t) => startsWithAny(t, ['-x', '--exec', '-X', '--exec-batch']));
  if (head === 'sort') return !args.some((t) => startsWithAny(t, ['-o', '--output']));
  // `sed -n 'N,Mp' file` only: any other script can write (`w`) or run (`e`) something.
  if (head === 'sed') {
    return (
      args[0] === '-n' && /^\d+(,(\d+|\$))?p$/.test(args[1] ?? '') && args.slice(2).every((t) => !t.startsWith('-'))
    );
  }
  return READ_COMMANDS.has(head);
}

/** A shell command every segment of which is an allow-listed read; false whenever in doubt. */
export function isReadOnlyCommand(command: string): boolean {
  const text = command.replace(DEV_NULL, ' ');
  if (!text.trim() || UNREADABLE.test(text)) return false;
  const segments = text.split(/&&|\|\||;|\||\n/);
  // A lone `&` (background) is left inside a segment after the split: refused.
  if (segments.some((s) => s.includes('&'))) return false;
  return segments.every(segmentIsRead);
}

/** The words of an MCP tool's name part (`mcp__<server>__<tool>` → `<tool>`, split on `_`, `-` and case). */
function mcpToolWords(toolName: string): string[] {
  const parts = toolName.split('__');
  const tool = parts.length >= 3 ? parts.slice(2).join('_') : '';
  return tool
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[_-]+/)
    .filter(Boolean);
}

/** A word that names a change: any of them in the name refuses the tool, whatever verb it starts with. */
const MCP_WRITE_WORDS = new Set([
  'create',
  'update',
  'delete',
  'remove',
  'write',
  'push',
  'merge',
  'send',
  'post',
  'upload',
  'set',
  'add',
  'put',
  'patch',
  'move',
  'rename',
  'edit',
  'replace',
  'close',
  'reopen',
  'approve',
  'commit',
  'deploy',
  'run',
  'exec',
  'execute',
  'kill',
  'cancel',
  'insert',
  'drop',
  'fork',
  'transfer',
  'archive',
  'publish',
  'invite',
  'assign',
  'lock',
  'unlock',
  'star',
  'apply',
  'reset',
  'revert',
  'restore',
  'trigger',
  'dispatch',
  'save',
  'submit',
  'request',
  'grant',
  'revoke',
  'register',
  'start',
  'stop',
  'schedule',
  'enable',
  'disable',
]);
/** A name that starts with one of these (or ends with one of the second set) reads. */
const MCP_READ_FIRST = new Set([
  'get',
  'list',
  'read',
  'search',
  'query',
  'fetch',
  'view',
  'show',
  'describe',
  'lookup',
  'check',
  'count',
  'find',
]);
const MCP_READ_LAST = new Set(['query', 'search', 'list', 'get', 'read', 'logs', 'status']);

/**
 * Step 6c's check: a reason when a planning turn's call would do the work, else
 * null. `mcp__plan__*` — the plan tool — always runs.
 */
export function checkPlanPendingCall(toolName: string, toolInput: Record<string, unknown>): string | null {
  if (toolName === 'Bash') {
    const command = typeof toolInput.command === 'string' ? toolInput.command : '';
    return isReadOnlyCommand(command) ? null : 'a shell command that is not read-only';
  }
  if (toolName.startsWith('mcp__')) {
    if (toolName.startsWith('mcp__plan__')) return null;
    const words = mcpToolWords(toolName);
    const reads =
      words.length > 0 &&
      !words.some((w) => MCP_WRITE_WORDS.has(w)) &&
      (MCP_READ_FIRST.has(words[0]) || MCP_READ_LAST.has(words[words.length - 1]));
    return reads ? null : `${toolName} is not a read`;
  }
  return PLAN_RESEARCH_TOOLS.includes(toolName) ? null : `${toolName || 'this tool'} is not a research tool`;
}
