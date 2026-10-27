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
/** Flags whose next argument is inline program text (python -c, node/perl/ruby -e, perl -ne/-pe/-lne, php -r). */
const INLINE_CODE_FLAG = /^-[a-zA-Z]*[cer]$/;
/** Inline code that can run what it reads — keep the warning when any of these appear. */
const EXECUTES_INPUT =
  /\b(?:exec|eval|compile|execfile|system|popen|spawn\w*|fork|subprocess|child_process|shell_exec|passthru|__import__|importlib|runpy|Function)\b|`|\$\(|\bqx\b/;

/** Read one shell word starting at `i` (handles '…', "…" with \-escapes, and bare words). */
function readWord(s: string, i: number): { word: string; end: number } {
  let word = '';
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
        if (s[j] === '\\' && j + 1 < s.length) j++;
        word += s[j];
        j++;
      }
      i = j + 1;
    } else {
      word += c;
      i++;
    }
  }
  return { word, end: i };
}

/**
 * True when the interpreter invoked at `start` (just after its name) reads its
 * PROGRAM from stdin — no inline-code flag, no script operand, or an explicit
 * `-` / `-s` — or runs inline code that can execute input. A shell is never a
 * data reader: `| sh -c '…'` can run stdin (`. /dev/stdin`), so it always warns.
 */
function interpreterRunsInput(command: string, interpreter: string, start: number): boolean {
  if (SHELL.test(interpreter)) return true;
  let i = start;
  for (;;) {
    while (i < command.length && /[ \t]/.test(command[i])) i++;
    if (i >= command.length || /[|;&)\n]/.test(command[i])) return true; // no program given → stdin is the program
    const { word, end } = readWord(command, i);
    i = end;
    if (word === '-' || word === '-s') return true;
    if (INLINE_CODE_FLAG.test(word)) {
      while (i < command.length && /[ \t]/.test(command[i])) i++;
      const code = readWord(command, i).word;
      return EXECUTES_INPUT.test(code);
    }
    if (!word.startsWith('-')) return false; // a script operand: the program is that file, stdin is data
  }
}

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
