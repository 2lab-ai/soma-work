/**
 * Does a Bash command run ssh, scp or sftp? (policy step 2, the ssh ban — every user since env-access WU2 #1210)
 *
 * soma-lib's `isSshCommand` matches the word anywhere in the text, so it also refused a grep pattern, a commit
 * message or a document written through a heredoc. Since WU2 that refusal reaches admins too. This check lets a
 * command through only when nothing in it can run the word:
 *
 * - It never refuses what `isSshCommand` let through (it starts from that check).
 * - A scan that knows quotes, `$'…'`, heredocs, comments and `$(…)` / `$((…))` / backticks / `<(…)` / `>(…)` finds
 *   every simple command, including those inside substitutions and inside unquoted heredoc bodies.
 * - ssh, scp or sftp named as a program refuses.
 * - Every other program must only handle the word as data: grep, echo, cat and the like, the git subcommands that
 *   read or record (commit, log, grep …) and the gh groups pr, issue, api, search, run, release, label, workflow.
 *   A heredoc fed to them is data too. git's transport subcommands (push, fetch, pull, clone …) and rsync keep the
 *   old check on their own text.
 * - Anything else — a shell, an interpreter, a wrapper (`sudo`, `env`, `xargs`, `timeout` …), `eval`, sed, awk,
 *   `find -exec`, an unknown program — refuses, because the word is in the text and that program could run it:
 *   from its arguments, from a pipe, from a file written earlier in the same command, or from a fifo.
 * - An assignment that holds the word (`GIT_PAGER='ssh …' git log`, `RSYNC_RSH=ssh rsync`) refuses, and so does a
 *   git `-c` setting that holds it.
 *
 * The ban is a clear message and one more layer, not the boundary: in the OS sandbox ssh has no route out (it
 * does not use the proxy) and no session reads `~/.ssh`. Hosts are reached with server-tools `ssh_exec`.
 */

import { isSshCommand } from 'soma-lib';

const REMOTE_SHELLS = new Set(['ssh', 'scp', 'sftp', 'slogin', 'autossh', 'sshpass']);
/** Reserved words that start a simple command; the program is the next word. */
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'while', 'until', 'do', '!', '{', 'time']);
/** Programs that only read, write or print their arguments and their input: they start no other program. */
const DATA_COMMANDS = new Set([
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'ack',
  'echo',
  'printf',
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'wc',
  'sort',
  'uniq',
  'cut',
  'tr',
  'ls',
  'cd',
  'pwd',
  'mkdir',
  'rmdir',
  'touch',
  'cp',
  'mv',
  'rm',
  'ln',
  'chmod',
  'diff',
  'cmp',
  'jq',
  'yq',
  'test',
  '[',
  '[[',
  'true',
  'false',
  ':',
  'tee',
  'column',
  'base64',
  'file',
  'stat',
  'realpath',
  'readlink',
  'dirname',
  'basename',
  'which',
  'whereis',
  'type',
  'hash',
  'man',
  'whatis',
  'apropos',
  'sleep',
  'date',
  'set',
  'read',
  'fi',
  'done',
  'esac',
  '}',
]);
/** git subcommands that read or record: their arguments are paths, revisions and messages. */
const GIT_DATA = new Set([
  'add',
  'blame',
  'branch',
  'cat-file',
  'checkout',
  'commit',
  'describe',
  'diff',
  'grep',
  'log',
  'ls-files',
  'merge-base',
  'mv',
  'notes',
  'reflog',
  'restore',
  'rev-list',
  'rev-parse',
  'rm',
  'shortlog',
  'show',
  'stash',
  'status',
  'switch',
  'tag',
]);
/** git subcommands that reach a remote: a remote named in their own text (`ssh://…`) runs ssh. */
const GIT_TRANSPORT = new Set(['clone', 'fetch', 'pull', 'push', 'ls-remote', 'remote', 'submodule']);
/** git options before the subcommand that take the next word as their value. */
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env']);
/** gh command groups that only send and print data. */
const GH_DATA = new Set(['pr', 'issue', 'api', 'search', 'run', 'release', 'label', 'workflow', 'status']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;

interface SimpleCommand {
  words: string[];
  raw: string;
  heredocs: string[];
}

interface Scan {
  commands: SimpleCommand[];
  /** Text the scan could not split safely (a heredoc delimiter it cannot read). */
  unreadable: boolean;
}

/** Matching close of `(` at `open` in `src`, skipping quotes; -1 when unbalanced. */
function closingParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') {
      i++;
    } else if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end < 0) return -1;
      i = end;
    } else if (c === '"') {
      for (i++; i < src.length && src[i] !== '"'; i++) if (src[i] === '\\') i++;
    } else if (c === '(') {
      depth++;
    } else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * `$(…)` or `$((…))` with `(` at `open`: the text that runs as commands goes to `subs`. Arithmetic runs only the
 * substitutions inside it. Returns the index of the closing paren.
 */
function dollarParen(src: string, open: number, subs: string[]): number {
  const close = closingParen(src, open);
  if (close < 0) {
    subs.push(src.slice(open + 1));
    return src.length;
  }
  // `$((1+2))` is arithmetic: the inner `(` closes right before the outer one. `$((cmd) )` is a subshell.
  if (src[open + 1] === '(' && closingParen(src, open + 1) === close - 1) {
    expansions(src.slice(open + 2, close - 1), subs);
  } else {
    subs.push(src.slice(open + 1, close));
  }
  return close;
}

/** Substitutions in text the shell expands but does not split into commands (an unquoted heredoc, arithmetic). */
function expansions(text: string, subs: string[]): void {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') {
      i++;
    } else if (text[i] === '$' && text[i + 1] === '(') {
      i = dollarParen(text, i + 1, subs);
    } else if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      subs.push(text.slice(i + 1, end < 0 ? text.length : end));
      i = end < 0 ? text.length : end;
    }
  }
}

/** A heredoc delimiter word starting at `at`: its text with quotes removed, whether it was quoted, where it ends. */
function delimiterWord(src: string, at: number): { delim: string; quoted: boolean; end: number } {
  let delim = '';
  let quoted = false;
  let i = at;
  for (; i < src.length && !/[\s;&|<>()]/.test(src[i]); i++) {
    const c = src[i];
    if (c === "'" || c === '"') {
      quoted = true;
      const end = src.indexOf(c, i + 1);
      delim += src.slice(i + 1, end < 0 ? src.length : end);
      i = end < 0 ? src.length : end;
    } else if (c === '\\') {
      quoted = true;
      delim += src[i + 1] ?? '';
      i++;
    } else {
      delim += c;
    }
  }
  return { delim, quoted, end: i };
}

/** Every simple command in shell text, those inside substitutions and expanded heredoc bodies included. */
function scan(src: string, depth = 0): Scan {
  const commands: SimpleCommand[] = [];
  const subs: string[] = [];
  let unreadable = false;
  let current: SimpleCommand = { words: [], raw: '', heredocs: [] };
  let word = '';
  let inWord = false;
  let rawStart = 0;
  const pending: { delim: string; quoted: boolean; stripTabs: boolean; owner: SimpleCommand }[] = [];

  const endWord = () => {
    if (inWord) current.words.push(word);
    word = '';
    inWord = false;
  };
  const endCommand = (at: number) => {
    endWord();
    current.raw = src.slice(rawStart, at);
    if (current.words.length > 0 || current.heredocs.length > 0) commands.push(current);
    current = { words: [], raw: '', heredocs: [] };
    rawStart = at + 1;
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') {
      if (src[i + 1] !== '\n') {
        word += src[i + 1] ?? '';
        inWord = true;
      }
      i++;
    } else if (c === "'") {
      const end = src.indexOf("'", i + 1);
      word += src.slice(i + 1, end < 0 ? src.length : end);
      inWord = true;
      i = end < 0 ? src.length : end;
    } else if (c === '$' && src[i + 1] === "'") {
      // `$'…'`: a backslash escapes the closing quote.
      let j = i + 2;
      for (; j < src.length && src[j] !== "'"; j++) {
        if (src[j] === '\\') j++;
        word += src[j] ?? '';
      }
      inWord = true;
      i = j;
    } else if (c === '"') {
      inWord = true;
      for (i++; i < src.length && src[i] !== '"'; i++) {
        if (src[i] === '\\') {
          word += src[i + 1] ?? '';
          i++;
        } else if (src[i] === '$' && src[i + 1] === '(') {
          i = dollarParen(src, i + 1, subs);
        } else if (src[i] === '`') {
          const end = src.indexOf('`', i + 1);
          subs.push(src.slice(i + 1, end < 0 ? src.length : end));
          i = end < 0 ? src.length : end;
        } else {
          word += src[i];
        }
      }
    } else if (c === '$' && src[i + 1] === '(') {
      inWord = true;
      i = dollarParen(src, i + 1, subs);
    } else if (c === '`') {
      const end = src.indexOf('`', i + 1);
      subs.push(src.slice(i + 1, end < 0 ? src.length : end));
      inWord = true;
      i = end < 0 ? src.length : end;
    } else if ((c === '<' || c === '>') && src[i + 1] === '(') {
      // Process substitution runs its commands wherever it is written.
      endWord();
      const close = closingParen(src, i + 1);
      subs.push(src.slice(i + 2, close < 0 ? src.length : close));
      i = close < 0 ? src.length : close;
    } else if (c === '<' && src[i + 1] === '<' && src[i + 2] !== '<') {
      endWord();
      let j = i + 2;
      const stripTabs = src[j] === '-';
      if (stripTabs) j++;
      while (src[j] === ' ' || src[j] === '\t') j++;
      const { delim, quoted, end } = delimiterWord(src, j);
      if (delim === '') unreadable = true;
      else pending.push({ delim, quoted, stripTabs, owner: current });
      i = end - 1;
    } else if (c === '#' && !inWord) {
      const end = src.indexOf('\n', i);
      i = (end < 0 ? src.length : end) - 1;
    } else if (c === '\n') {
      endCommand(i);
      // Heredoc bodies start on the next line. They are input to the command that named them, not commands; an
      // unquoted delimiter still expands the substitutions in them.
      let pos = i + 1;
      for (const h of pending.splice(0)) {
        const body: string[] = [];
        while (pos < src.length) {
          const nl = src.indexOf('\n', pos);
          const line = src.slice(pos, nl < 0 ? src.length : nl);
          pos = nl < 0 ? src.length : nl + 1;
          if ((h.stripTabs ? line.replace(/^\t+/, '') : line) === h.delim) break;
          body.push(line);
        }
        const text = body.join('\n');
        h.owner.heredocs.push(text);
        if (!h.quoted) expansions(text, subs);
        if (!commands.includes(h.owner)) commands.push(h.owner);
      }
      i = pos - 1;
      rawStart = pos;
    } else if ((c === '<' || c === '>') && (src[i + 1] === '&' || src[i + 1] === '|')) {
      // `2>&1`, `<&3`, `>|`: a redirection, not a separator.
      endWord();
      i++;
    } else if (c === '&' && src[i + 1] === '>') {
      // `&>`, `&>>`: a redirection, not a separator.
      endWord();
    } else if (c === ';' || c === '&' || c === '|' || c === '(' || c === ')') {
      endCommand(i);
    } else if (c === ' ' || c === '\t' || c === '<' || c === '>') {
      endWord();
    } else {
      word += c;
      inWord = true;
    }
  }
  endCommand(src.length);
  // A heredoc whose line never ended (no newline after its command): its body is missing, nothing to add.

  // Nesting this deep is not a command anyone types: refuse rather than guess.
  if (depth > 8 && subs.length > 0) return { commands, unreadable: true };
  for (const sub of subs) {
    const inner = scan(sub, depth + 1);
    commands.push(...inner.commands);
    unreadable ||= inner.unreadable;
  }
  return { commands, unreadable };
}

function base(word: string): string {
  return word.slice(word.lastIndexOf('/') + 1);
}

type Verdict = 'data' | 'own-text' | 'may-run';

function gitVerdict(args: readonly string[]): Verdict {
  let k = 0;
  for (; k < args.length && args[k].startsWith('-'); k++) {
    const option = args[k];
    const [name, inline] = option.includes('=') ? [option.slice(0, option.indexOf('=')), option] : [option, ''];
    // `-c alias.x='!ssh …'`, `-c core.pager=…`, `-c core.sshCommand=…`: a setting that names it runs it.
    if ((name === '-c' || name === '--config-env') && isSshCommand(inline || (args[k + 1] ?? ''))) return 'may-run';
    if (GIT_VALUE_OPTIONS.has(name) && !inline) k++;
  }
  const sub = args[k];
  const rest = args.slice(k + 1);
  if (sub === undefined) return 'data';
  if (GIT_TRANSPORT.has(sub)) return 'own-text';
  if (!GIT_DATA.has(sub)) return 'may-run';
  // `git grep -O<pager>` opens the matches in a program it names.
  if (sub === 'grep' && rest.some((w) => w.startsWith('-O') || w.startsWith('--open-files-in-pager'))) {
    return 'may-run';
  }
  return 'data';
}

function ghVerdict(args: readonly string[]): Verdict {
  let k = 0;
  for (; k < args.length && args[k].startsWith('-'); k++) {
    if ((args[k] === '-R' || args[k] === '--repo') && k + 1 < args.length) k++;
  }
  return GH_DATA.has(args[k] ?? '') ? 'data' : 'may-run';
}

/** What one simple command does with the word, once assignments and reserved words are taken off its front. */
function verdict(cmd: SimpleCommand): Verdict | 'runs' {
  let words = cmd.words;
  for (;;) {
    if (words.length > 0 && ASSIGNMENT.test(words[0])) {
      // `GIT_PAGER='ssh …' git log`, `RSYNC_RSH=ssh rsync`, `x='ssh …'`: an environment that names it may run it.
      if (isSshCommand(words[0])) return 'may-run';
      words = words.slice(1);
    } else if (words.length > 0 && KEYWORDS.has(words[0])) {
      words = words.slice(1);
    } else {
      break;
    }
  }
  if (words.length === 0) return 'data';
  const name = base(words[0]);
  const args = words.slice(1);
  if (REMOTE_SHELLS.has(name)) return 'runs';
  if (DATA_COMMANDS.has(name)) return 'data';
  if (name === 'git') return gitVerdict(args);
  if (name === 'gh') return ghVerdict(args);
  if (name === 'rsync') return 'own-text';
  // `command -v ssh` looks a program up; it runs nothing.
  if (name === 'command' && (args[0] === '-v' || args[0] === '-V')) return 'data';
  if (name === 'find') {
    return args.some((w) => w === '-exec' || w === '-execdir' || w === '-ok' || w === '-okdir') ? 'may-run' : 'data';
  }
  return 'may-run';
}

/** True when the Bash command runs ssh, scp or sftp, or could (see the file header). */
export function isRemoteShellCommand(command: string): boolean {
  if (!isSshCommand(command)) return false;
  const { commands, unreadable } = scan(command);
  if (unreadable) return true;
  return commands.some((cmd) => {
    const v = verdict(cmd);
    if (v === 'own-text') return isSshCommand(cmd.raw) || cmd.heredocs.some((h) => isSshCommand(h));
    // The text names it (checked above) and this program could run it.
    return v === 'runs' || v === 'may-run';
  });
}
