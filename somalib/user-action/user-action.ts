/**
 * User actions — work the agent hands to the human, as opposed to a question
 * it asks them (ASK_USER_QUESTION). The `user-action` MCP server validates and
 * inspects the request; the host stores it on the session and shows it in its
 * own Slack card and dashboard section.
 *
 * Every user action is a short script plus the machine it runs on: "open the
 * page and click X" is not an action the human can run without asking back.
 * The script gets the check the agent's own Bash gets before it runs — the
 * shared dangerous-rule catalog and the irreversible-action reader — plus a
 * syntax check (done by the MCP server, which can spawn a shell), and the
 * result is shown next to the script so the human can judge it before running.
 *
 * Pure module: no I/O. Shared by the MCP server (via `@soma/process-shared`)
 * and the host.
 */
import { DANGEROUS_RULES } from 'soma-lib';
import { irreversibleAction } from '../permission/irreversible';

export const USER_ACTION_LIMITS = {
  titleChars: 80,
  hostChars: 80,
  whyChars: 600,
  expectChars: 300,
  effectsChars: 300,
  /** A script the human can read in one glance and paste in one go. */
  scriptLines: 8,
  scriptChars: 600,
  /** The script as Slack shows it (`&<>` escaped) must fit one section with its heading — it is never cut. */
  scriptShownChars: 2800,
} as const;

/** POSIX shells only: the check (syntax, rules, irreversible actions) reads POSIX shell. */
export const USER_ACTION_SHELLS = ['bash', 'zsh', 'sh'] as const;
export type UserActionShell = (typeof USER_ACTION_SHELLS)[number];

/** What the agent asks the human to do. */
export interface InstructUserRequest {
  /** One line: what the human does. */
  title: string;
  /** The machine (or device) the script runs on — a host name the human recognises. */
  host: string;
  /** Why the human, and not the agent, has to do it. */
  why: string;
  /** The short script to run. */
  script: string;
  shell: UserActionShell;
  /** What the human sees when it worked. */
  expect: string;
  /** What the script changes, in plain words — the agent's own reading, like a Bash `description`. */
  effects: string;
  /** True when skipping it is fine (the work goes on without it). */
  optional: boolean;
}

export type UserActionFindingLevel = 'info' | 'caution' | 'danger';

export interface UserActionFinding {
  /** Stable id: `rule:<id>`, `irreversible:<id>`, `sudo`, `network`, … */
  id: string;
  level: UserActionFindingLevel;
  /** One line, Korean. */
  label: string;
  detail?: string;
}

export interface UserActionSyntaxCheck {
  /** False when no checker could run (the shell is not installed where the check runs). */
  checked: boolean;
  ok: boolean;
  /** The checker that ran, e.g. `bash -n`. */
  tool?: string;
  message?: string;
}

export type UserActionVerdict = 'ok' | 'caution' | 'danger';

export interface UserActionInspection {
  verdict: UserActionVerdict;
  lines: number;
  chars: number;
  /** The programs the script runs, in order, without repeats. */
  commands: string[];
  findings: UserActionFinding[];
  syntax: UserActionSyntaxCheck;
}

export type UserActionStatus = 'pending' | 'done' | 'failed';
export const USER_ACTION_STATUSES: readonly UserActionStatus[] = ['pending', 'done', 'failed'];

/** A user action as the host keeps it on the session. */
export interface UserActionRecord extends InstructUserRequest {
  id: string;
  createdAt: number;
  status: UserActionStatus;
  inspection: UserActionInspection;
  resolvedAt?: number;
  /** Slack user id of whoever marked it done / failed. */
  resolvedBy?: string;
  /** The Slack card's message ts, for rewriting it when the status changes. */
  slackTs?: string;
}

export type UserActionErrorCode = 'INVALID_ARGS' | 'SCRIPT_TOO_LONG' | 'NOT_A_SCRIPT' | 'SECRET_IN_SCRIPT';

export type ValidateInstructUserResult =
  | { ok: true; request: InstructUserRequest }
  | { ok: false; error: { code: UserActionErrorCode; message: string } };

const TEXT_FIELDS: ReadonlyArray<{ key: keyof InstructUserRequest; max: number; singleLine: boolean }> = [
  { key: 'title', max: USER_ACTION_LIMITS.titleChars, singleLine: true },
  { key: 'host', max: USER_ACTION_LIMITS.hostChars, singleLine: true },
  { key: 'why', max: USER_ACTION_LIMITS.whyChars, singleLine: false },
  { key: 'expect', max: USER_ACTION_LIMITS.expectChars, singleLine: false },
  { key: 'effects', max: USER_ACTION_LIMITS.effectsChars, singleLine: false },
];

/** Credentials that must never be posted to Slack or the dashboard. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/,
  /\bxox[abeprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  // Generic shapes: a JWT, a bearer header, an assignment to a secret-named variable with a literal value.
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\./,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i,
  /\b[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY)[A-Za-z0-9_]*\s*[=:]\s*['"]?(?!\$|~?\/|\.\.?\/)[^\s'"$]{12,}/i,
];

/**
 * An assignment of a literal to a secret-named variable (`PASSWORD='hunter2'`, `export API_KEY="a b c"`), at any
 * length — checked in every posted field, not only the script. Allowed: no value, a reference or substitution the shell
 * expands (`$X`, `${X}`, `$(…)`, a backtick — not inside single quotes, and not `$'…'` / `$"…"`, which are literals), or
 * a path (`/…`, `~/…`, `./…`).
 */
function literalSecretAssignment(script: string): boolean {
  const assign =
    /(?:^|[\s;&|(])(?:(?:export|readonly|local|declare)\s+(?:-\S+\s+)*)?([A-Za-z_][A-Za-z0-9_]*)=(?=(['"]?)(.?.?.?))/g;
  for (const m of script.matchAll(assign)) {
    if (!/(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY)/i.test(m[1])) continue;
    const head = m[3] ?? '';
    if (head === '' || /^[\s;&|)]/.test(head)) continue; // NAME= (unset)
    // A reference or a substitution — only where the shell expands it.
    if (m[2] !== "'" && (head[0] === '`' || /^\$[A-Za-z_{(0-9@*#?!$-]/.test(head))) continue;
    if (/^(?:\/|~\/|\.\.?\/)/.test(head)) continue; // a path
    if (m[2] && head[0] === m[2]) continue; // NAME='' / NAME=""
    return true;
  }
  return false;
}

const fail = (code: UserActionErrorCode, message: string): ValidateInstructUserResult => ({
  ok: false,
  error: { code, message },
});

/** Lines that run something: not blank, not a comment. */
function codeLines(script: string): string[] {
  return script
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

export function validateInstructUserArgs(args: unknown): ValidateInstructUserResult {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return fail('INVALID_ARGS', 'arguments must be an object');
  }
  const a = args as Record<string, unknown>;
  const out: Partial<Record<keyof InstructUserRequest, string>> = {};
  for (const { key, max, singleLine } of TEXT_FIELDS) {
    const v = a[key];
    if (typeof v !== 'string' || !v.trim()) return fail('INVALID_ARGS', `${key} is required (non-empty string)`);
    const t = v.trim();
    if (t.length > max) return fail('INVALID_ARGS', `${key} is too long: ${t.length} chars (max ${max})`);
    if (singleLine && /[\r\n]/.test(t)) return fail('INVALID_ARGS', `${key} must be one line`);
    out[key] = t;
  }

  const shellRaw = a.shell ?? 'bash';
  if (typeof shellRaw !== 'string' || !(USER_ACTION_SHELLS as readonly string[]).includes(shellRaw)) {
    return fail('INVALID_ARGS', `shell must be one of ${USER_ACTION_SHELLS.join(', ')}`);
  }
  if (a.optional !== undefined && typeof a.optional !== 'boolean') {
    return fail('INVALID_ARGS', 'optional must be a boolean');
  }

  if (typeof a.script !== 'string' || !a.script.trim()) {
    return fail('INVALID_ARGS', 'script is required (non-empty string)');
  }
  const script = a.script.replace(/\r\n?/g, '\n').trim();
  const lines = script.split('\n').length;
  if (lines > USER_ACTION_LIMITS.scriptLines || script.length > USER_ACTION_LIMITS.scriptChars) {
    return fail(
      'SCRIPT_TOO_LONG',
      `script is ${lines} lines / ${script.length} chars (max ${USER_ACTION_LIMITS.scriptLines} lines / ` +
        `${USER_ACTION_LIMITS.scriptChars} chars). Keep it short: put longer logic in a file you prepare, ` +
        'and hand the human the one line that runs it.',
    );
  }
  const shown = script.replace(/&/g, '&amp;').replace(/[<>]/g, '&lt;').length;
  if (shown > USER_ACTION_LIMITS.scriptShownChars) {
    return fail(
      'SCRIPT_TOO_LONG',
      `script is ${shown} chars once escaped for Slack (max ${USER_ACTION_LIMITS.scriptShownChars}) — too many & < > ` +
        'to show it whole; shorten it or put it in a file and hand over the line that runs it',
    );
  }
  if (script.includes('```')) {
    // Slack shows the script in a code fence; a fence inside it would make the shown script differ from the checked one.
    return fail(
      'INVALID_ARGS',
      'script must not contain ``` — the card shows it in a code block; write it another way',
    );
  }
  const code = codeLines(script);
  if (code.length === 0) return fail('NOT_A_SCRIPT', 'script has no command — only comments or blank lines');
  if (/^(?:https?:\/\/|www\.)/i.test(code[0])) {
    return fail(
      'NOT_A_SCRIPT',
      "a URL is not a script — give the command that opens it, e.g. open 'https://…' (macOS) or xdg-open 'https://…'",
    );
  }
  // Every field is posted to Slack and the dashboard: none may carry a credential. The message never repeats it.
  const posted: Array<[string, string]> = [
    ['script', script],
    ...TEXT_FIELDS.map((f) => [f.key, out[f.key] ?? ''] as [string, string]),
  ];
  const leaking = posted.find(
    ([, text]) => literalSecretAssignment(text) || SECRET_PATTERNS.some((re) => re.test(text)),
  );
  if (leaking) {
    return fail(
      'SECRET_IN_SCRIPT',
      `${leaking[0]} contains what looks like a credential; it would be posted to Slack and the dashboard. ` +
        'Leave it out, and have the script read it from where the human keeps it (an env var, a password manager).',
    );
  }

  return {
    ok: true,
    request: {
      title: out.title as string,
      host: out.host as string,
      why: out.why as string,
      script,
      shell: shellRaw as UserActionShell,
      expect: out.expect as string,
      effects: out.effects as string,
      optional: a.optional === true,
    },
  };
}

// ── Inspection ──────────────────────────────────────────────────────────────

/** Words that run the next word as the command. */
const PREFIX = new Set(['sudo', 'command', 'exec', 'nohup', 'time', 'env', 'nice', 'timeout', 'doas', 'caffeinate']);
/** Prefix options that take the next word as their value. */
const PREFIX_VALUE_OPTS: Readonly<Record<string, ReadonlySet<string>>> = {
  sudo: new Set([
    ...['-u', '-g', '-U', '-C', '-h', '-p', '-r', '-t', '-D', '-R', '-T'],
    ...['--user', '--group', '--other-user', '--close-from', '--host', '--prompt', '--role', '--type'],
    ...['--chdir', '--chroot', '--command-timeout', '--login-class'],
  ]),
  doas: new Set(['-u', '-C']),
  env: new Set(['-u', '-C', '-S', '--unset', '--chdir', '--split-string']),
  nice: new Set(['-n', '--adjustment']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
  caffeinate: new Set(['-t', '-w']),
};
const FILE_COMMANDS = new Set(['rm', 'mv', 'cp', 'tee', 'chmod', 'chown', 'ln', 'mkdir', 'touch', 'rmdir', 'install']);
const NETWORK_COMMANDS = new Set(['curl', 'wget', 'scp', 'rsync', 'sftp', 'nc', 'ssh', 'gh', 'git', 'brew', 'npm']);
const REMOTE_CODE: readonly RegExp[] = [
  /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+(?:-\S+\s+)*)?(?:\S*\/)?(?:env\s+)?(?:ba|z|da|k)?sh\b/,
  /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+(?:-\S+\s+)*)?(?:\S*\/)?(?:env\s+)?(?:python3?|node|perl|ruby)\b/,
  /\b(?:ba|z|da|k)?sh\s+(?:-\S+\s+)*<\(\s*(?:curl|wget)\b/,
  /\b(?:ba|z|da|k)?sh\s+(?:-\S+\s+)*-c\s+["']?\$\(\s*(?:curl|wget)\b/,
];
/** Programs that run the code they read from standard input. */
const INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'python', 'python3', 'node', 'perl', 'ruby']);
const HIDDEN_CODE: readonly RegExp[] = [
  /(?:^|[\s;&|(])eval\s/,
  /\bbase64\s+(?:-\S+\s+)*(?:-d|-D|--decode)\b[^\n]*\|\s*(?:\S*\/)?(?:ba|z|da|k)?sh\b/,
];

interface Segment {
  words: string[];
  /** Segments joined by `|` share one pipeline object. */
  pipeline: object;
}

/**
 * Split a script into simple commands (on `;`, `&`, `|`, newlines, parentheses)
 * outside quotes, and collect output-redirection targets. Quotes are kept out
 * of the words so `echo "a; rm -rf /"` stays one `echo`. A command substitution
 * (`$(…)`, backticks — also inside double quotes) is read as commands of its own
 * and leaves the word around it whole: `gui/$(id -u)/svc` is one word, `id` a command.
 */
function scan(script: string, depth = 0): { segments: Segment[]; redirects: string[] } {
  const segments: Segment[] = [];
  const redirects: string[] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: '' | "'" | '"' = '';
  let pendingRedirect = false;
  const heredocs: Array<{ tag: string; stripTabs: boolean; quoted: boolean }> = [];

  const endWord = () => {
    if (!inWord) return;
    if (pendingRedirect) {
      redirects.push(word);
      pendingRedirect = false;
    } else {
      words.push(word);
    }
    word = '';
    inWord = false;
  };
  let pipeline: object = {};
  /** A `|` with no command after it yet: a line break here continues the pipeline (`a |⏎ b`). */
  let pipeOpen = false;
  const endSegment = (pipeOn = false) => {
    endWord();
    const empty = words.length === 0;
    if (!empty) segments.push({ words, pipeline });
    words = [];
    pipeOpen = pipeOn || (empty && pipeOpen);
    if (!pipeOpen) pipeline = {};
  };
  /** Read the substitution whose body starts at `from` and ends at `end` (exclusive); return `end`. */
  const substitute = (from: number, end: number): number => {
    if (depth < 4) {
      const inner = scan(script.slice(from, end), depth + 1);
      segments.push(...inner.segments);
      redirects.push(...inner.redirects);
    }
    word += '$()';
    inWord = true;
    return end;
  };
  /** Read only the command substitutions of `text` (an unquoted heredoc body) as commands. */
  const substitutionsIn = (text: string) => {
    if (depth >= 4) return;
    for (let k = 0; k < text.length; k++) {
      if (text[k] === '\\') {
        k++;
        continue;
      }
      let from = -1;
      let end = -1;
      if (text[k] === '$' && text[k + 1] === '(') {
        from = k + 2;
        let level = 1;
        for (end = from; end < text.length; end++) {
          if (text[end] === '(') level++;
          else if (text[end] === ')' && --level === 0) break;
        }
      } else if (text[k] === '`') {
        from = k + 1;
        end = text.indexOf('`', from);
        if (end < 0) end = text.length;
      }
      if (from < 0) continue;
      const inner = scan(text.slice(from, end), depth + 1);
      segments.push(...inner.segments);
      redirects.push(...inner.redirects);
      k = end;
    }
  };
  /** The index of the `)` closing a `$(` whose body starts at `from` (nesting counted), or the end. */
  const closeParen = (from: number): number => {
    let level = 1;
    for (let j = from; j < script.length; j++) {
      if (script[j] === '(') level++;
      else if (script[j] === ')' && --level === 0) return j;
    }
    return script.length;
  };
  const closeTick = (from: number): number => {
    for (let j = from; j < script.length; j++) {
      if (script[j] === '\\') j++;
      else if (script[j] === '`') return j;
    }
    return script.length;
  };

  for (let i = 0; i < script.length; i++) {
    const c = script[i];
    if (quote !== "'" && c === '$' && script[i + 1] === '(') {
      i = substitute(i + 2, closeParen(i + 2));
      continue;
    }
    if (quote !== "'" && c === '`') {
      i = substitute(i + 1, closeTick(i + 1));
      continue;
    }
    if (quote) {
      if (c === quote) quote = '';
      else if (c === '\\' && quote === '"' && i + 1 < script.length) word += script[++i];
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
      continue;
    }
    if (c === '\\' && i + 1 < script.length) {
      if (script[i + 1] === '\n') {
        i++;
        continue;
      }
      word += script[++i];
      inWord = true;
      continue;
    }
    if (c === '#' && !inWord) {
      while (i + 1 < script.length && script[i + 1] !== '\n') i++;
      continue;
    }
    if (c === '<' && script[i + 1] === '<' && script[i + 2] !== '<') {
      // A heredoc: its body (the lines after this one, up to its tag) is input to the command, not commands.
      const m = /^<<(-?)[ \t]*(['"]?)([A-Za-z_][\w-]*)\2/.exec(script.slice(i));
      if (m) {
        endWord();
        heredocs.push({ tag: m[3], stripTabs: m[1] === '-', quoted: m[2] !== '' });
        i += m[0].length - 1;
        continue;
      }
    }
    if (c === '>') {
      // `2>&1`, `>&2`: a descriptor, not a file.
      const prevDigit = inWord && /^\d$/.test(word);
      if (prevDigit) {
        word = '';
        inWord = false;
      } else endWord();
      if (script[i + 1] === '>') i++;
      if (script[i + 1] === '&') {
        i++;
        while (i + 1 < script.length && /[\d-]/.test(script[i + 1])) i++;
        continue;
      }
      pendingRedirect = true;
      continue;
    }
    if (c === '\n' && heredocs.length) {
      endSegment();
      // Skip each pending heredoc's body, in order, up to the line holding only its tag.
      let j = i + 1;
      for (const doc of heredocs.splice(0)) {
        const bodyStart = j;
        let bodyEnd = script.length;
        while (j < script.length) {
          const next = script.indexOf('\n', j);
          const line = script.slice(j, next < 0 ? script.length : next);
          const lineStart = j;
          j = next < 0 ? script.length : next + 1;
          if ((doc.stripTabs ? line.replace(/^\t+/, '') : line) === doc.tag) {
            bodyEnd = lineStart;
            break;
          }
        }
        // An unquoted tag (`<<EOF`) expands its body: `$(…)` and backticks there run. A quoted one (`<<'EOF'`) does not.
        if (!doc.quoted) substitutionsIn(script.slice(bodyStart, bodyEnd));
      }
      i = j - 1;
      continue;
    }
    if (c === '|' && script[i + 1] !== '|') {
      // A pipe: the next command reads this one's output (`|&` too).
      endSegment(true);
      if (script[i + 1] === '&') i++;
      continue;
    }
    if (c === '|') i++; // `||`
    if (c === ';' || c === '&' || c === '|' || c === '\n' || c === '(' || c === ')') {
      endSegment();
      continue;
    }
    if (/\s/.test(c)) {
      endWord();
      continue;
    }
    word += c;
    inWord = true;
  }
  endSegment();
  return { segments, redirects };
}

/** Shell words that lead into the command after them (`if sudo rm …`, `then echo …`) or close a block (`fi`). */
const LEAD_KEYWORDS = new Set([
  '!',
  '{',
  '}',
  'if',
  'elif',
  'then',
  'else',
  'while',
  'until',
  'do',
  'fi',
  'done',
  'esac',
]);
/** Shell words whose segment is a header, not a command (`for x in a b`, `case $x in`, `select x in …`). */
const HEADER_KEYWORDS = new Set(['for', 'case', 'select', 'function', 'in']);

/** The program a simple command runs: prefixes, keywords, `X=1` assignments and directories dropped. */
function commandOf(words: string[]): { cmd: string; sudo: boolean } | null {
  let i = 0;
  let sudo = false;
  while (i < words.length) {
    const w = words[i];
    const name = w.split('/').pop() ?? w; // `/usr/bin/sudo` is sudo
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) i += 1;
    else if (PREFIX.has(name)) {
      if (name === 'sudo' || name === 'doas') sudo = true;
      const takes = PREFIX_VALUE_OPTS[name];
      i += 1;
      // `sudo -u root …`, `nice -n 10 …`: an option's value is not the command.
      while (i < words.length && words[i].startsWith('-')) i += takes?.has(words[i]) ? 2 : 1;
      if (name === 'timeout' && i < words.length) i += 1; // the duration
    } else if (LEAD_KEYWORDS.has(w)) i += 1;
    else if (HEADER_KEYWORDS.has(w)) return sudo ? { cmd: '', sudo } : null;
    else break;
  }
  const raw = words[i];
  if (!raw) return sudo ? { cmd: '', sudo } : null;
  return { cmd: raw.split('/').pop() ?? raw, sudo };
}

function urlHosts(script: string): string[] {
  return [...new Set(Array.from(script.matchAll(/\bhttps?:\/\/([^\s'"/)?#]+)/gi), (m) => m[1].toLowerCase()))];
}

/**
 * Check a script the way the agent's own Bash is checked before it runs, and
 * say what it touches. `syntax` is the result of a real syntax check (`bash -n`),
 * which needs a process — the caller runs it.
 */
export function inspectUserActionScript(
  script: string,
  shell: UserActionShell,
  syntax: UserActionSyntaxCheck,
): UserActionInspection {
  const findings: UserActionFinding[] = [];
  const add = (f: UserActionFinding) => {
    if (!findings.some((x) => x.id === f.id)) findings.push(f);
  };

  const { segments, redirects } = scan(script);
  const commands: string[] = [];
  let sudo = false;
  const fileCommands: string[] = [];
  const networkCommands: string[] = [];
  for (const seg of segments) {
    const c = commandOf(seg.words);
    if (!c) continue;
    if (c.sudo) sudo = true;
    if (!c.cmd) continue;
    if (!commands.includes(c.cmd)) commands.push(c.cmd);
    if (FILE_COMMANDS.has(c.cmd) && !fileCommands.includes(c.cmd)) fileCommands.push(c.cmd);
    if (c.cmd === 'sed' && seg.words.some((w) => /^-[A-Za-z]*i/.test(w)) && !fileCommands.includes('sed -i')) {
      fileCommands.push('sed -i');
    }
    if (NETWORK_COMMANDS.has(c.cmd) && !networkCommands.includes(c.cmd)) networkCommands.push(c.cmd);
  }

  // Read with line continuations joined, so `curl … \\⏎ | sh` is one line.
  const joined = script.replace(/\\\n/g, ' ');
  const downloadThenRun = segments.some((seg, k) => {
    const c = commandOf(seg.words);
    if (!c || !INTERPRETERS.has(c.cmd)) return false;
    return segments.slice(0, k).some((prev) => {
      if (prev.pipeline !== seg.pipeline) return false;
      const p = commandOf(prev.words);
      return !!p && (p.cmd === 'curl' || p.cmd === 'wget');
    });
  });
  if (downloadThenRun || REMOTE_CODE.some((re) => re.test(joined))) {
    add({
      id: 'remote-code',
      level: 'danger',
      label: '인터넷에서 받은 코드를 바로 실행함',
      detail: '받은 내용을 먼저 열어 보지 않고 셸이나 인터프리터로 넘긴다.',
    });
  }
  if (HIDDEN_CODE.some((re) => re.test(joined))) {
    add({
      id: 'hidden-code',
      level: 'danger',
      label: '읽을 수 없게 감춘 코드를 실행함 (eval · base64)',
      detail: '실행되는 내용이 스크립트에 그대로 보이지 않는다.',
    });
  }

  // The same catalog the agent's own Bash goes through (evaluateToolPolicy → dangerous rules).
  for (const rule of DANGEROUS_RULES) {
    let hit = false;
    try {
      hit = rule.match(script, {});
    } catch {
      hit = false;
    }
    if (hit) {
      add({
        id: `rule:${rule.id}`,
        level: 'caution',
        label: `봇이 실행할 때 승인을 받는 명령: ${rule.label}`,
        detail: rule.description,
      });
    }
  }
  const irreversible = irreversibleAction('Bash', { command: script });
  if (irreversible) {
    add({
      id: `irreversible:${irreversible.id}`,
      level: 'caution',
      label: `되돌릴 수 없음: ${irreversible.label}`,
    });
  }
  // The word anywhere a command can stand — also as an argument (`xargs sudo rm`, `find -exec sudo …`): a false
  // caution costs a second look, a missed sudo a false pass.
  if (sudo || /(?:^|[\s;&|(`'"=/])(?:sudo|doas)(?=\s|$)/m.test(script)) {
    add({ id: 'sudo', level: 'caution', label: '관리자 권한(sudo)으로 실행함', detail: '비밀번호를 물을 수 있다.' });
  }

  const fileTargets = redirects.filter((t) => t && t !== '/dev/null');
  if (fileTargets.length || fileCommands.length) {
    add({
      id: 'writes-files',
      level: 'info',
      label: '파일을 만들거나 바꿈',
      detail: [...fileCommands, ...fileTargets.map((t) => `> ${t}`)].join(', '),
    });
  }
  const hosts = urlHosts(script);
  if (hosts.length || networkCommands.length) {
    add({
      id: 'network',
      level: 'info',
      label: '네트워크에 접속함',
      detail: [...hosts, ...networkCommands.filter((c) => !hosts.length || c !== 'open')].join(', '),
    });
  }

  if (!syntax.checked) {
    add({
      id: 'syntax-unchecked',
      level: 'caution',
      label: '구문 검사를 하지 못함',
      detail: syntax.message ?? `${shell} 검사기가 없다.`,
    });
  } else if (!syntax.ok) {
    add({ id: 'syntax-error', level: 'danger', label: '구문 오류', detail: syntax.message });
  }

  const verdict: UserActionVerdict = findings.some((f) => f.level === 'danger')
    ? 'danger'
    : findings.some((f) => f.level === 'caution')
      ? 'caution'
      : 'ok';

  return {
    verdict,
    lines: script.split('\n').length,
    chars: script.length,
    commands,
    findings,
    syntax,
  };
}

// ── Host-side shape check ───────────────────────────────────────────────────

const isStr = (v: unknown): v is string => typeof v === 'string';
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

function parseInspection(raw: unknown): UserActionInspection | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.verdict !== 'ok' && r.verdict !== 'caution' && r.verdict !== 'danger') return null;
  if (typeof r.lines !== 'number' || typeof r.chars !== 'number' || !isStrArr(r.commands)) return null;
  if (!Array.isArray(r.findings)) return null;
  const findings: UserActionFinding[] = [];
  for (const f of r.findings) {
    if (!f || typeof f !== 'object') return null;
    const x = f as Record<string, unknown>;
    if (!isStr(x.id) || !isStr(x.label)) return null;
    if (x.level !== 'info' && x.level !== 'caution' && x.level !== 'danger') return null;
    findings.push({ id: x.id, level: x.level, label: x.label, ...(isStr(x.detail) ? { detail: x.detail } : {}) });
  }
  const s = r.syntax as Record<string, unknown> | undefined;
  if (!s || typeof s.checked !== 'boolean' || typeof s.ok !== 'boolean') return null;
  return {
    verdict: r.verdict,
    lines: r.lines,
    chars: r.chars,
    commands: [...r.commands],
    findings,
    syntax: {
      checked: s.checked,
      ok: s.ok,
      ...(isStr(s.tool) ? { tool: s.tool } : {}),
      ...(isStr(s.message) ? { message: s.message } : {}),
    },
  };
}

/** A stored or received record, or null when its shape is wrong. Never throws. */
export function parseUserActionRecord(raw: unknown): UserActionRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  for (const k of ['id', 'title', 'host', 'why', 'script', 'expect', 'effects'] as const) {
    if (!isStr(r[k])) return null;
  }
  if (!(USER_ACTION_SHELLS as readonly unknown[]).includes(r.shell)) return null;
  if (typeof r.optional !== 'boolean' || typeof r.createdAt !== 'number') return null;
  if (!(USER_ACTION_STATUSES as readonly unknown[]).includes(r.status)) return null;
  const inspection = parseInspection(r.inspection);
  if (!inspection) return null;
  return {
    id: r.id as string,
    title: r.title as string,
    host: r.host as string,
    why: r.why as string,
    script: r.script as string,
    shell: r.shell as UserActionShell,
    expect: r.expect as string,
    effects: r.effects as string,
    optional: r.optional,
    createdAt: r.createdAt,
    status: r.status as UserActionStatus,
    inspection,
    ...(typeof r.resolvedAt === 'number' ? { resolvedAt: r.resolvedAt } : {}),
    ...(isStr(r.resolvedBy) ? { resolvedBy: r.resolvedBy } : {}),
    ...(isStr(r.slackTs) ? { slackTs: r.slackTs } : {}),
  };
}

// ── Session list ────────────────────────────────────────────────────────────

/** How many user actions a session keeps. Resolved ones are dropped first. */
export const USER_ACTIONS_KEPT = 20;

/** The list with `record` added (or replacing the one with its id), capped at {@link USER_ACTIONS_KEPT}. */
export function appendUserAction(
  list: readonly UserActionRecord[] | undefined,
  record: UserActionRecord,
): UserActionRecord[] {
  const out = (list ?? []).filter((a) => a.id !== record.id);
  out.push(record);
  while (out.length > USER_ACTIONS_KEPT) {
    const resolved = out.findIndex((a) => a.status !== 'pending');
    out.splice(resolved >= 0 ? resolved : 0, 1);
  }
  return out;
}

export type ResolveUserActionResult =
  | { ok: true; list: UserActionRecord[]; action: UserActionRecord }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'already-resolved'; action: UserActionRecord };

/** Mark a pending action done or failed. A resolved action stays as it was answered first. */
export function resolveUserAction(
  list: readonly UserActionRecord[] | undefined,
  id: string,
  status: Exclude<UserActionStatus, 'pending'>,
  by: string,
  at: number,
): ResolveUserActionResult {
  const current = (list ?? []).find((a) => a.id === id);
  if (!current) return { ok: false, reason: 'not-found' };
  if (current.status !== 'pending') return { ok: false, reason: 'already-resolved', action: current };
  const action: UserActionRecord = { ...current, status, resolvedBy: by, resolvedAt: at };
  return { ok: true, action, list: (list ?? []).map((a) => (a.id === id ? action : a)) };
}

/** A persisted list, malformed entries dropped; undefined when nothing valid is left. */
export function restoreUserActions(raw: unknown): UserActionRecord[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const list = raw.map(parseUserActionRecord).filter((a): a is UserActionRecord => a !== null);
  return list.length ? list.slice(-USER_ACTIONS_KEPT) : undefined;
}

// ── Tool result ─────────────────────────────────────────────────────────────

/** The SDK name of the tool, as the host sees it in tool results. */
export const INSTRUCT_USER_TOOL_NAME = 'mcp__user-action__instruct_user';

/**
 * The record inside an `instruct_user` tool result (the MCP text content holding
 * `{ type: 'user_action', ok: true, action }`), or null for a refusal or junk.
 */
export function parseInstructUserToolResult(raw: unknown, depth = 0): UserActionRecord | null {
  if (raw === null || raw === undefined || depth > 4) return null;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t.startsWith('{') || !t.endsWith('}')) return null;
    try {
      return parseInstructUserToolResult(JSON.parse(t), depth + 1);
    } catch {
      return null;
    }
  }
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const found = parseInstructUserToolResult(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.type === 'user_action') return r.ok === true ? parseUserActionRecord(r.action) : null;
  if (Array.isArray(r.content)) return parseInstructUserToolResult(r.content, depth + 1);
  if (typeof r.text === 'string') return parseInstructUserToolResult(r.text, depth + 1);
  return null;
}
