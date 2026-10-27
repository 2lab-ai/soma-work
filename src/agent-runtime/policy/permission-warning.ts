/**
 * Auto-mode permission WARNING — the mechanical check that runs after the model
 * allowed a call (SSOT_2 #3: "model이 통과시켜도 기계적인 검사해서 문제가 생기면 …
 * 경고 표시만 출력").
 *
 * In auto mode a dangerous-rule hit no longer asks the user mechanically: the
 * safety classifier (the model) alone decides to ask. When it allows, this
 * module decides whether the user still sees a warning card (Slack thread +
 * dashboard chat). It never changes the decision — it only selects what to show.
 *
 * Input is the rule ids the policy already matched (`ToolPolicyResult.matchedRuleIds`),
 * so a rule the user silenced for the session never warns and no second catalog
 * match runs. One refinement: a pipe into an interpreter that only reads stdin as
 * DATA (`curl … | python3 -c 'json.load(sys.stdin)…'`) is not a problem and does
 * not warn. A pipe whose program comes from stdin (`| sh`, `| python3`, `| python3 -`)
 * or whose inline code can execute what it reads (`exec(`, `eval(`, `subprocess` …)
 * still warns. The refinement is used ONLY here: the classify trigger and the
 * permission card keep the raw catalog, so host and permission child never disagree.
 */

import { overridableRulesByIds } from 'somalib/permission/dangerous-rules';

/** Catalog ids for "pipe into an interpreter" that the data-pipe refinement may drop. */
const PIPE_RULE_IDS: ReadonlySet<string> = new Set([
  'pipe-to-interpreter',
  'pipe-to-path-interpreter',
  'env-wrapped-interpreter',
]);

const SHELL = /^(?:sh|bash|zsh|dash|ksh|csh|tcsh|fish)$/i;
const INTERPRETER = String.raw`(?:sh|bash|zsh|dash|ksh|csh|tcsh|fish|python[23]?(?:\.\d+)?|perl|ruby|node|php)`;
/** `| [path/][env [-opts] ]<interpreter>` — the interpreter name ends at a word boundary. */
const PIPE_TO_INTERPRETER = new RegExp(
  String.raw`\|\s*(?:\S*/)?(?:env\s+(?:-\S+\s+)*)?(${INTERPRETER})(?![\w.-])`,
  'gi',
);
/**
 * The data-reader allowlist. A pipe into an interpreter is treated as a pure
 * DATA pipe only when the interpreter's FIRST argument is its own inline-code
 * flag and that code passes {@link isDataReaderCode}. Anything else — another
 * flag first (`-W x -c`, `-r ./mod.js`, `-m code`), a long flag, `-p`, a script
 * operand, no argument at all — keeps the warning (fail closed).
 */
type InterpreterFamily = 'python' | 'node';
/**
 * Only python `-c` and node `-e` one-liners can be positively recognised as data
 * readers (the measured noise: `| python3 -c '<json parse>'`). perl, ruby and
 * php are too loose to read safely here and always keep the warning.
 */
const INLINE_CODE_FLAGS: Record<InterpreterFamily, RegExp> = {
  python: /^-c$/,
  node: /^-e$/,
};

function interpreterFamily(name: string): InterpreterFamily | null {
  const n = name.toLowerCase();
  if (n.startsWith('python')) return 'python';
  if (n === 'node') return 'node';
  return null;
}

/**
 * Anything in the code that can run, load, write or reach beyond printing what
 * it read. Fail closed: a word on this list in a string or a dict key also keeps
 * the warning — a warning is never a block.
 */
const NOT_A_READER = new RegExp(
  [
    '`|__', // backticks (perl/ruby run them), dunder access
    String.raw`\b(?:exec\w*|eval\w*|compile|system|popen\w*|spawn\w*|posix_spawn\w*|fork|subprocess|child_process|shell_exec|passthru|proc_open|qx)\b`,
    String.raw`\b(?:importlib|runpy|ctypes|pty|builtins|getattr|setattr|globals|locals|pickle|marshal|shelve|yaml|code|breakpoint|pdb|Function|vm|run\w*Context|binding|dlopen|[Mm]odule|_load|constructor)\b`,
    String.raw`\b(?:open|write\w*|unlink\w*|remove|rmtree|rename\w*|mkdir\w*|chmod|chown|truncate|socket|fetch|https?|net|request|urlopen)\b`,
    String.raw`(?<![.\w])(?:load|do)\s*[('"]`, // ruby `load 'f'`, perl `do 'f'` (json.load is a method call, not this)
    String.raw`\bimport\s*\(`, // JS dynamic import()
    String.raw`\bprocess\.(?!stdin\b|stdout\b|exit\b)`, // node: only stdin / stdout / exit
    String.raw`\bsys\.(?!stdin\b|stdout\b|stderr\b|argv\b|exit\b)`, // python: only stdio / argv / exit
    String.raw`\b(?:attrgetter|methodcaller|itemgetter|FileIO|modules|_getframe|f_builtins|f_globals|f_locals|vars|type|dir|buffer|raw|fileno)\b`,
  ].join('|'),
);
/** Python modules a data reader may import. */
const PY_READER_MODULES = new Set([
  'json',
  'sys',
  're',
  'csv',
  'collections',
  'itertools',
  'datetime',
  'math',
  'string',
  'textwrap',
  'functools',
  'operator',
  'base64',
  'statistics',
  'pprint',
]);
/**
 * node: the one allowed read is stdin through the literal descriptor 0 —
 * `require('fs').readFileSync(0)` / `fs.readFileSync(0, 'utf8')`, nothing computed.
 */
const NODE_STDIN_READ =
  /(?:\brequire\s*\(\s*['"](?:node:)?fs['"]\s*\)|\bfs)\s*\.\s*readFileSync\s*\(\s*0\s*(?:,\s*['"][\w-]+['"]\s*)?\)/g;
/** node: computed or global property access can reach anything (`globalThis["ev"+"al"]`, `this[k]`). */
const NODE_COMPUTED_ACCESS = /\b(?:globalThis|global|this|self|Reflect|Proxy)\b|\[(?!\s*\d+\s*\])/;

/** Escapes and unusual whitespace can spell a name the scan cannot see (`ev\u0061l`, `import\f…`, `\`-newline). */
const OPAQUE_SYNTAX = /\\(?:u|x|N|\r?\n)|[\f\v]/;

function isDataReaderCode(family: InterpreterFamily, rawCode: string): boolean {
  if (rawCode.trim().length === 0) return false;
  if (OPAQUE_SYNTAX.test(rawCode)) return false;
  // Python reads identifiers in NFKC (`ｅｖａｌ` is `eval`): scan what it will see.
  const code = rawCode.normalize('NFKC');
  // `sys.stdout.write` / `process.stdout.write` only print.
  const scanned = code.replace(/\b(?:sys\.|process\.)?stdout\.write\b/g, 'print');
  if (NOT_A_READER.test(scanned)) return false;
  if (family === 'python') {
    // One line at a time: an import list never spans a newline (`[ \t]`, not `\s`).
    for (const m of code.matchAll(/\bimport[ \t]+([\w., \t]+)/g)) {
      const names = m[1].split(',').map((n) => n.trim().split(/[ \t]+/)[0]);
      if (names.some((n) => !PY_READER_MODULES.has(n))) return false;
    }
    for (const m of code.matchAll(/\bfrom[ \t]+([\w.]+)[ \t]+import\b/g)) {
      if (!PY_READER_MODULES.has(m[1])) return false;
    }
  } else if (family === 'node') {
    const rest = code.replace(NODE_STDIN_READ, 'STDIN');
    // After the one allowed stdin read, no require, fs or *Sync call may remain,
    // and nothing may be reached through a computed or global property.
    if (/\brequire\b|\bfs\b|\w+Sync\b/.test(rest) || NODE_COMPUTED_ACCESS.test(rest)) return false;
  }
  return true;
}

/**
 * Read one shell word starting at `i` (handles '…', "…" with \-escapes, and bare
 * words). `expands` is true when a `$` or backtick sits outside single quotes —
 * the shell substitutes it, so the code the interpreter runs is not what we read.
 */
function readWord(s: string, i: number): { word: string; end: number; expands: boolean } {
  let word = '';
  let expands = false;
  while (i < s.length && !/\s|[|;&()]/.test(s[i])) {
    const c = s[i];
    if (c === "'") {
      const close = s.indexOf("'", i + 1);
      const stop = close < 0 ? s.length : close;
      word += s.slice(i + 1, stop);
      i = stop + 1;
    } else if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') {
        if (s[j] === '\\' && j + 1 < s.length) {
          // Inside "…" a backslash-newline is a line continuation: both vanish.
          if (s[j + 1] === '\n') {
            j += 2;
            continue;
          }
          // Otherwise bash drops the backslash only before $ ` " \ ; anywhere
          // else it stays (so `\u0061` reaches the interpreter as written).
          if (!/[$`"\\]/.test(s[j + 1])) word += '\\';
          j++;
        } else if (s[j] === '$' || s[j] === '`') expands = true;
        word += s[j];
        j++;
      }
      i = j + 1;
    } else {
      if (c === '$' || c === '`') expands = true;
      word += c;
      i++;
    }
  }
  return { word, end: i, expands };
}

/**
 * True unless the interpreter invoked at `start` (just after its name) is
 * positively a data reader (see the allowlist above). A shell is never a data
 * reader (`| sh -c '…'` can run stdin via `. /dev/stdin`).
 */
function interpreterRunsInput(command: string, interpreter: string, start: number): boolean {
  if (SHELL.test(interpreter)) return true;
  const family = interpreterFamily(interpreter);
  if (!family) return true;
  let i = start;
  while (i < command.length && /[ \t]/.test(command[i])) i++;
  if (i >= command.length || /[|;&)\n]/.test(command[i])) return true;
  const flag = readWord(command, i);
  if (!INLINE_CODE_FLAGS[family].test(flag.word)) return true;
  i = flag.end;
  while (i < command.length && /[ \t]/.test(command[i])) i++;
  const code = readWord(command, i);
  if (code.expands || !isDataReaderCode(family, code.word)) return true;
  // Only a silenced stderr may follow the reader: a second argument or code
  // fragment, a file redirect, another pipe stage or another command (`;`, `&&`,
  // `||`, `&`, newline) is not something this check understands.
  return !ONLY_STDERR_REDIRECTS.test(command.slice(code.end));
}

/** `2>/dev/null` and `2>&1`, any number of times, and nothing else. */
const ONLY_STDERR_REDIRECTS = /^(?:\s*2>\s*(?:\/dev\/null|&1))*\s*$/;

/** True when every `| interpreter` in the command only reads stdin as data. */
function onlyDataPipes(command: string): boolean {
  PIPE_TO_INTERPRETER.lastIndex = 0;
  let found = false;
  for (let m = PIPE_TO_INTERPRETER.exec(command); m !== null; m = PIPE_TO_INTERPRETER.exec(command)) {
    found = true;
    if (interpreterRunsInput(command, m[1], m.index + m[0].length)) return false;
  }
  return found;
}

/**
 * Rule ids the warning card shows for a model-allowed call. Empty → no warning.
 * `matchedRuleIds` comes from the policy (already filtered by the session's
 * disabled rules); order is preserved.
 */
export function permissionWarningRuleIds(command: string, matchedRuleIds: readonly string[]): string[] {
  if (matchedRuleIds.length === 0) return [];
  const dropPipes = matchedRuleIds.some((id) => PIPE_RULE_IDS.has(id)) && onlyDataPipes(command);
  return matchedRuleIds.filter((id) => !(dropPipes && PIPE_RULE_IDS.has(id)));
}

export interface PermissionWarningRule {
  id: string;
  label: string;
  description: string;
}

/** Catalog text for the ids, as the Slack and dashboard cards show it. */
export function permissionWarningRules(ids: readonly string[]): PermissionWarningRule[] {
  return overridableRulesByIds([...ids]).map((r) => ({ id: r.id, label: r.label, description: r.description }));
}

/**
 * Show the same command + rule set once per session per window, so an agent
 * retrying one command does not stack identical cards.
 */
export function createPermissionWarningDeduper(opts: { windowMs: number; now?: () => number }) {
  const now = opts.now ?? Date.now;
  const seen = new Map<string, number>();
  return {
    shouldWarn(sessionKey: string, command: string, ruleIds: readonly string[]): boolean {
      const t = now();
      for (const [key, at] of seen) if (t - at > opts.windowMs) seen.delete(key);
      const key = JSON.stringify([sessionKey, command, [...ruleIds].sort()]);
      if (seen.has(key)) return false;
      seen.set(key, t);
      return true;
    },
  };
}

/** What the host publishes when a model-allowed call still trips the mechanical check. */
export interface PermissionWarningEvent {
  /** Slack user the session acts for. */
  user: string;
  channel: string;
  threadTs?: string;
  /** Dashboard conversation the warning is recorded into (absent → Slack only). */
  conversationId?: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  command: string;
  rules: PermissionWarningRule[];
  /** The classifier's reason for allowing the call. */
  reason: string;
}
