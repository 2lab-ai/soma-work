/**
 * Does a Bash command run ssh, scp or sftp? (policy step 2, the ssh ban — every user since env-access WU2 #1210)
 *
 * soma-lib's `isSshCommand` matches the word anywhere in the text, so it also refused a grep pattern, a commit
 * message or a document written through a heredoc. Since WU2 that refusal reaches admins too. This check asks
 * what the command runs:
 *
 * - It never refuses what `isSshCommand` let through (it starts from that check).
 * - Each simple command is found by a scan that knows quotes, heredocs and `$(…)` / backticks / `<(…)`; every
 *   substitution is checked on its own, since it runs wherever it is written.
 * - A command refuses when it runs ssh, scp or sftp itself, through a wrapper (`sudo`, `env`, `timeout`,
 *   `xargs`, `find -exec`, …), through a shell (`sh -c`, a heredoc fed to a shell), through `eval`, or through
 *   `rsync -e ssh`.
 * - The arguments and heredoc input of a command that only handles data (git, grep, echo, cat, gh, …) do not
 *   count. git that is told to use another ssh command (`GIT_SSH_COMMAND`, `core.sshCommand`) still does.
 * - Any other program — an interpreter, an unknown tool — keeps the old, broad check on its own text: it may
 *   start ssh itself.
 *
 * The ban is a clear message and one more layer, not the boundary: in the OS sandbox ssh has no route out (it
 * does not use the proxy) and no session reads `~/.ssh`. Hosts are reached with server-tools `ssh_exec`.
 */

import { isSshCommand } from 'soma-lib';

const REMOTE_SHELLS = new Set(['ssh', 'scp', 'sftp', 'slogin', 'autossh', 'sshpass']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'fish', 'csh', 'tcsh']);
/** Words that run the rest of the simple command as a command. */
const WRAPPERS = new Set([
  'sudo',
  'doas',
  'env',
  'command',
  'exec',
  'nohup',
  'time',
  'nice',
  'ionice',
  'timeout',
  'gtimeout',
  'stdbuf',
  'caffeinate',
  'unbuffer',
  'builtin',
  'xargs',
  'watch',
  'setsid',
  'if',
  'then',
  'else',
  'elif',
  'while',
  'until',
  'do',
  '!',
  '{',
]);
/** Options of a wrapper that take the next word as their value. */
const OPTION_VALUES: Record<string, ReadonlySet<string>> = {
  sudo: new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U']),
  env: new Set(['-u', '-C', '-S']),
  nice: new Set(['-n']),
  ionice: new Set(['-c', '-n']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
  gtimeout: new Set(['-s', '-k', '--signal', '--kill-after']),
  xargs: new Set(['-n', '-I', '-L', '-P', '-d', '-E', '-s', '-a']),
  watch: new Set(['-n', '-d']),
};
/** Commands that only read, write or print their arguments and their input: they start no other program. */
const DATA_COMMANDS = new Set([
  'git',
  'gh',
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
]);
/** git told to use another ssh command runs it. */
const GIT_REMOTE_SHELL = /\bGIT_SSH(?:_COMMAND)?\s*=|core\.sshCommand/i;
const RSYNC_REMOTE_SHELL = /(?:^|\s)(?:-e\s*|--rsh[=\s]\s*)['"]?[^\s'"]*\bssh\b/i;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

interface SimpleCommand {
  words: string[];
  raw: string;
  heredocs: string[];
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

/** Split shell text into simple commands; substitutions (which run wherever they are written) go to `subs`. */
function scan(src: string, subs: string[]): SimpleCommand[] {
  const commands: SimpleCommand[] = [];
  let current: SimpleCommand = { words: [], raw: '', heredocs: [] };
  let word = '';
  let inWord = false;
  let rawStart = 0;
  const pendingHeredocs: { delim: string; stripTabs: boolean; owner: SimpleCommand }[] = [];

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
  const substitution = (open: number): number => {
    const close = closingParen(src, open);
    if (close < 0) {
      subs.push(src.slice(open + 1));
      return src.length;
    }
    subs.push(src.slice(open + 1, close));
    return close;
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') {
      if (src[i + 1] === '\n') {
        i++;
        continue;
      }
      word += src[i + 1] ?? '';
      inWord = true;
      i++;
    } else if (c === "'") {
      const end = src.indexOf("'", i + 1);
      word += src.slice(i + 1, end < 0 ? src.length : end);
      inWord = true;
      i = end < 0 ? src.length : end;
    } else if (c === '"') {
      inWord = true;
      for (i++; i < src.length && src[i] !== '"'; i++) {
        if (src[i] === '\\') {
          word += src[i + 1] ?? '';
          i++;
        } else if (src[i] === '$' && src[i + 1] === '(' && src[i + 2] !== '(') {
          i = substitution(i + 1);
        } else if (src[i] === '`') {
          const end = src.indexOf('`', i + 1);
          subs.push(src.slice(i + 1, end < 0 ? src.length : end));
          i = end < 0 ? src.length : end;
        } else {
          word += src[i];
        }
      }
    } else if (c === '$' && src[i + 1] === '(' && src[i + 2] !== '(') {
      inWord = true;
      i = substitution(i + 1);
    } else if (c === '`') {
      const end = src.indexOf('`', i + 1);
      subs.push(src.slice(i + 1, end < 0 ? src.length : end));
      inWord = true;
      i = end < 0 ? src.length : end;
    } else if ((c === '<' || c === '>') && src[i + 1] === '(') {
      i = substitution(i + 1);
    } else if (c === '<' && src[i + 1] === '<' && src[i + 2] !== '<') {
      endWord();
      let j = i + 2;
      const stripTabs = src[j] === '-';
      if (stripTabs) j++;
      while (src[j] === ' ' || src[j] === '\t') j++;
      const m = /^(['"]?)([A-Za-z0-9_.-]+)\1/.exec(src.slice(j).replace(/^\\/, ''));
      if (m) {
        pendingHeredocs.push({ delim: m[2], stripTabs, owner: current });
        i = j + m[0].length + (src[j] === '\\' ? 1 : 0) - 1;
      } else {
        i = j - 1;
      }
    } else if (c === '#' && !inWord) {
      const end = src.indexOf('\n', i);
      i = (end < 0 ? src.length : end) - 1;
    } else if (c === '\n') {
      endCommand(i);
      // Heredoc bodies start on the next line; they are input to the command that named them, not commands.
      let pos = i + 1;
      for (const h of pendingHeredocs.splice(0)) {
        const body: string[] = [];
        while (pos < src.length) {
          const nl = src.indexOf('\n', pos);
          const line = src.slice(pos, nl < 0 ? src.length : nl);
          pos = nl < 0 ? src.length : nl + 1;
          if ((h.stripTabs ? line.replace(/^\t+/, '') : line) === h.delim) break;
          body.push(line);
        }
        h.owner.heredocs.push(body.join('\n'));
        if (!commands.includes(h.owner)) commands.push(h.owner);
      }
      i = pos - 1;
      rawStart = pos;
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
  return commands;
}

function base(word: string): string {
  return word.slice(word.lastIndexOf('/') + 1);
}

/** The words of a simple command once assignments and wrappers (and their options) are taken off. */
function unwrap(words: readonly string[]): string[] | 'lookup' {
  let rest = [...words];
  for (;;) {
    while (rest.length > 0 && ASSIGNMENT.test(rest[0])) rest = rest.slice(1);
    const head = rest[0];
    if (head === undefined || !WRAPPERS.has(base(head))) return rest;
    const wrapper = base(head);
    rest = rest.slice(1);
    const takesValue = OPTION_VALUES[wrapper];
    while (rest.length > 0 && (rest[0].startsWith('-') || ASSIGNMENT.test(rest[0]))) {
      // `command -v ssh` looks a program up; it runs nothing.
      if (wrapper === 'command' && (rest[0] === '-v' || rest[0] === '-V')) return 'lookup';
      const option = rest[0];
      rest = rest.slice(1);
      if (takesValue?.has(option) && rest.length > 0) rest = rest.slice(1);
    }
    // `timeout 5 cmd`, `nice 10 cmd`: a leading duration or number is the wrapper's.
    if (
      (wrapper === 'timeout' || wrapper === 'gtimeout' || wrapper === 'nice') &&
      /^[\d.]+[smhd]?$/.test(rest[0] ?? '')
    ) {
      rest = rest.slice(1);
    }
  }
}

function commandRuns(cmd: SimpleCommand, depth: number): boolean {
  const words = unwrap(cmd.words);
  if (words === 'lookup') return false;
  const name = base(words[0] ?? '');
  if (REMOTE_SHELLS.has(name)) return true;
  if (name === 'rsync') return RSYNC_REMOTE_SHELL.test(cmd.raw);
  if (name === 'eval') return check(words.slice(1).join(' '), depth + 1);
  if (name === 'find') {
    const at = words.findIndex((w) => w === '-exec' || w === '-execdir' || w === '-ok' || w === '-okdir');
    return at >= 0 && check(words.slice(at + 1).join(' '), depth + 1);
  }
  if (SHELLS.has(name)) {
    const c = words.findIndex((w, k) => k > 0 && /^-[a-z]*c[a-z]*$/.test(w));
    if (c >= 0) return check(words[c + 1] ?? '', depth + 1);
    if (cmd.heredocs.length > 0) return cmd.heredocs.some((h) => check(h, depth + 1));
    return isSshCommand(cmd.raw);
  }
  if (name === 'git') return GIT_REMOTE_SHELL.test(cmd.raw) && isSshCommand(cmd.raw);
  if (DATA_COMMANDS.has(name)) return false;
  // An interpreter or an unknown program: the old check on its own text and input.
  return isSshCommand(cmd.raw) || cmd.heredocs.some((h) => isSshCommand(h));
}

function check(src: string, depth: number): boolean {
  if (!isSshCommand(src)) return false;
  // Nesting this deep is not a command anyone types: refuse rather than guess.
  if (depth > 8) return true;
  const subs: string[] = [];
  const commands = scan(src, subs);
  return commands.some((cmd) => commandRuns(cmd, depth)) || subs.some((s) => check(s, depth + 1));
}

/** True when the Bash command runs ssh, scp or sftp (see the file header). */
export function isRemoteShellCommand(command: string): boolean {
  return check(command, 0);
}
