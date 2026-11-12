/**
 * Does a Bash command run ssh, scp or sftp? (policy step 2, the ssh ban — every user since env-access WU2 #1210)
 *
 * soma-lib's `isSshCommand` matches the word anywhere in the text, so it also refused a grep pattern, a commit
 * message or a document written through a heredoc. Since WU2 that refusal reaches admins too. This check lets a
 * command through only when nothing in it can run the word:
 *
 * - It never refuses what `isSshCommand` let through (it starts from that check).
 * - A recursive scan finds every simple command, including those inside `$(…)`, `$((…))`, `${…}`, backticks
 *   (nested ones too), `(…)`, `<(…)`, `>(…)` and the substitutions of unquoted heredoc bodies. It knows quotes,
 *   `$'…'`, heredocs and comments, so a `)` inside them does not end a substitution.
 * - ssh, scp or sftp named as a program refuses.
 * - Every other program must only handle the word as data, and be named bare (`./cat` could be anything): grep,
 *   echo, cat and the like (not with an option that names a program to run, such as `rg --pre`); the git
 *   subcommands that read or record (commit, log, grep …); the gh groups pr, issue, api, search, run, release,
 *   label, workflow and status. A heredoc fed to them is data too. git's transport subcommands (push, fetch, pull,
 *   clone …) and rsync keep the old check on their own text.
 * - Anything else — a shell, an interpreter, a wrapper (`sudo`, `env`, `xargs`, `timeout` …), `eval`, sed, awk,
 *   `find -exec`, an unknown program — refuses, because the word is in the text and that program could run it:
 *   from its arguments, from a pipe, from a file written earlier in the same command, or from a fifo.
 * - An environment set in front of a program refuses (`GIT_PAGER=… git log`, `RSYNC_RSH=… rsync`,
 *   `RIPGREP_CONFIG_PATH=… rg`), and so does an assignment that holds the word or sets `PATH`, and a git global
 *   option that holds the word. An expansion where a program could be named — a git setting, the arguments of
 *   a data program with a run option, `find`'s arguments — is unknown, so it refuses too. Two exceptions:
 *   harmless settings in front of a program (`LC_ALL=C grep …`, see PLAIN_ENVIRONMENT), and `$HOME`, `$TMPDIR`
 *   when the command does not name them otherwise (absolute paths the bot set: never an option). `read` and
 *   `printf -v`, which set variables, are not data commands.
 *
 * Not covered, as with a command split in two: a data program that reads configuration an earlier part of the
 * same command wrote (`… >> .git/config; git log`).
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
  'man',
  'whatis',
  'apropos',
  'sleep',
  'date',
  'set',
  'fi',
  'done',
  'esac',
  '}',
]);
/** Options of a data program that name a program for it to run: long forms, and letters of short bundles. */
const EXEC_OPTIONS: Record<string, { long: readonly string[]; short: string }> = {
  rg: { long: ['--pre', '--hostname-bin'], short: '' },
  ag: { long: ['--pager'], short: '' },
  ack: { long: ['--pager'], short: '' },
  man: { long: ['--pager', '--html'], short: 'PH' },
  sort: { long: ['--compress-program'], short: '' },
  'git grep': { long: ['--open-files-in-pager'], short: 'O' },
};
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
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/;
/**
 * Settings that change how a program prints, locks or signs, never which program it runs: locale, time zone,
 * color and terminal size, git identity and locking, gh prompts. Any other name in front of a program could
 * select one (`GIT_PAGER`, `PAGER`, `EDITOR`, `RIPGREP_CONFIG_PATH`, `LD_PRELOAD` …), so this is a short allow
 * list rather than a deny list.
 */
const PLAIN_ENVIRONMENT =
  /^(LC_[A-Z]+|LANG|LANGUAGE|TZ|NO_COLOR|FORCE_COLOR|CLICOLOR|CLICOLOR_FORCE|COLUMNS|LINES|CI|GIT_OPTIONAL_LOCKS|GIT_TERMINAL_PROMPT|GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL|DATE)|GH_PROMPT_DISABLED|GH_NO_UPDATE_NOTIFIER)$/;
/** Nesting this deep is not a command anyone types: refuse rather than guess. */
const MAX_DEPTH = 8;
/** Stands in a word for an expansion (`$x`, `$(…)`, backticks): a program named through one is unknown. */
const EXPANDED = '\u0000';

interface SimpleCommand {
  words: string[];
  raw: string;
  heredocs: string[];
}

interface PendingHeredoc {
  delim: string;
  quoted: boolean;
  stripTabs: boolean;
  owner: SimpleCommand;
}

/** Scan state over one text: the position and what was found. */
class Parser {
  i = 0;
  readonly commands: SimpleCommand[] = [];
  unreadable = false;
  /** `src` is the text scanned now; `root` is the whole command. */
  constructor(
    readonly src: string,
    readonly root: string = src,
  ) {}
}

/**
 * `$HOME` and `$TMPDIR` hold absolute paths without spaces that the bot set, so they can never become an option
 * or a program name — unless the command itself sets them (`HOME=…`, `read HOME`, `export HOME`), which any other
 * mention of the name in the command is taken to mean, quotes and backslashes removed (`H\OME`). `$PWD` is not
 * trusted: `cd` changes it, and bash splits it unquoted.
 */
const TRUSTED_VARIABLES = new Set(['HOME', 'TMPDIR']);

function trustedVariable(root: string, name: string): boolean {
  if (!TRUSTED_VARIABLES.has(name)) return false;
  const plain = root.replace(/[\\'"]/g, '');
  const mentions = plain.match(new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`, 'g'))?.length ?? 0;
  const expansions = root.match(new RegExp(`\\$\\{?${name}(?![A-Za-z0-9_])`, 'g'))?.length ?? 0;
  return mentions === expansions;
}

/** Commands in a separate text (a backtick body, an expanded heredoc body, arithmetic), merged into `p`. */
function scanText(p: Parser, text: string, depth: number, expandOnly: boolean): void {
  if (depth > MAX_DEPTH) {
    p.unreadable = true;
    return;
  }
  const q = new Parser(text, p.root);
  if (expandOnly) expansions(q, depth);
  else list(q, false, depth);
  p.commands.push(...q.commands);
  p.unreadable ||= q.unreadable;
}

/** Text the shell expands but does not split into commands: only its substitutions run. */
function expansions(p: Parser, depth: number): void {
  for (; p.i < p.src.length; p.i++) {
    const c = p.src[p.i];
    if (c === '\\') p.i++;
    else if (c === '$') dollar(p, depth);
    else if (c === '`') backtick(p, depth);
  }
}

/** Index of the `)` matching the `(` at `open`, counting parens only; -1 when unbalanced. */
function matchingParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

/**
 * At `$`: a substitution (`$(…)`, arithmetic `$((…))`, `${…}`) is scanned for the commands it runs; `p.i` ends
 * on its last character. Returns what stands for it in the word: `EXPANDED`, since its value is not known here.
 */
function dollar(p: Parser, depth: number): string {
  const src = p.src;
  const open = p.i + 1;
  if (src[open] === '(') {
    // `$((1+2))` is arithmetic: the inner `(` closes right before the outer one. `$((cmd) )` is a subshell.
    const close = matchingParen(src, open);
    if (src[open + 1] === '(' && close > 0 && matchingParen(src, open + 1) === close - 1) {
      scanText(p, src.slice(open + 2, close - 1), depth + 1, true);
      p.i = close;
      return EXPANDED;
    }
    p.i = open + 1;
    list(p, true, depth + 1);
    return EXPANDED;
  }
  if (src[open] === '{') {
    // `${x:-$(cmd)}`: the braces hold text, and maybe substitutions; a `)` in them is not a close.
    let level = 0;
    let j = open;
    for (; j < src.length; j++) {
      const c = src[j];
      // A `'` here is a quote outside double quotes and a letter inside them: not read here.
      if (c === "'") p.unreadable = true;
      else if (c === '\\') j++;
      else if (c === '{') level++;
      else if (c === '}' && --level === 0) break;
    }
    if (j >= src.length) {
      p.unreadable = true;
      p.i = src.length;
      return '';
    }
    const inner = src.slice(open + 1, j);
    scanText(p, inner, depth + 1, true);
    p.i = j;
    return trustedVariable(p.root, inner) ? `$${inner}` : EXPANDED;
  }
  // `$x`, `$1`, `$@`: a parameter. Its name is read on by the caller.
  const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(open))?.[0] ?? '';
  return trustedVariable(p.root, name) ? '$' : EXPANDED;
}

/**
 * At a backtick: its body, with `` \` `` `\\` `\$` unescaped, is scanned as commands. `p.i` ends on the close.
 * Returns what stands for it in the word.
 */
function backtick(p: Parser, depth: number): string {
  const src = p.src;
  let inner = '';
  let j = p.i + 1;
  for (; j < src.length && src[j] !== '`'; j++) {
    if (src[j] === '\\' && (src[j + 1] === '`' || src[j + 1] === '\\' || src[j + 1] === '$')) {
      inner += src[j + 1];
      j++;
    } else {
      inner += src[j];
    }
  }
  scanText(p, inner, depth + 1, false);
  p.i = j;
  return EXPANDED;
}

/** A heredoc delimiter word starting at `at`: its text with quotes removed, whether it was quoted, where it ends. */
function delimiterWord(src: string, at: number): { delim: string; quoted: boolean; end: number } {
  let delim = '';
  let quoted = false;
  let i = at;
  for (; i < src.length && !/[\s;&|<>()]/.test(src[i]); i++) {
    const c = src[i];
    const ansi = c === '$' && src[i + 1] === "'";
    const locale = c === '$' && src[i + 1] === '"';
    if (c === "'" || ansi) {
      // `'EOF'` is `EOF`, and so is `$'EOF'`; with escapes in `$'…'`, the text is not read here.
      const open = ansi ? i + 1 : i;
      const end = src.indexOf("'", open + 1);
      const text = src.slice(open + 1, end < 0 ? src.length : end);
      if (ansi && text.includes('\\')) return { delim: '', quoted: true, end: i };
      quoted = true;
      delim += text;
      i = end < 0 ? src.length : end;
    } else if (c === '"' || locale) {
      // In double quotes a backslash escapes only `\`, `$`, a backtick and `"`; with a newline it joins lines.
      quoted = true;
      let j = (locale ? i + 1 : i) + 1;
      for (; j < src.length && src[j] !== '"'; j++) {
        if (src[j] === '\\' && src[j + 1] === '\n') {
          j++;
        } else if (src[j] === '\\' && '\\$`"'.includes(src[j + 1] ?? 'x')) {
          delim += src[j + 1];
          j++;
        } else {
          delim += src[j];
        }
      }
      i = j;
    } else if (c === '\\' && src[i + 1] === '\n') {
      // A line continuation: the word goes on after it.
      i++;
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

/**
 * Scan a command list from `p.i`. With `closed`, stop on the `)` that closes it (`p.i` ends there); otherwise run
 * to the end of the text.
 */
function list(p: Parser, closed: boolean, depth: number): void {
  const src = p.src;
  if (depth > MAX_DEPTH) {
    p.unreadable = true;
    p.i = src.length;
    return;
  }
  let current: SimpleCommand = { words: [], raw: '', heredocs: [] };
  let word = '';
  let inWord = false;
  let rawStart = p.i;
  // The next word is a redirection's target (`> file`, `<<< text`), not an argument or the program.
  let target = false;
  // Heredocs of this list, whose bodies start after its next newline. A newline inside a nested substitution is
  // that substitution's own: the shell reads it before the outer heredoc's body.
  const pending: PendingHeredoc[] = [];

  const endWord = () => {
    if (inWord) {
      if (target) target = false;
      else current.words.push(word);
    }
    word = '';
    inWord = false;
  };
  /** At a redirection operator: a number right before it is its file descriptor; the next word is its target. */
  const redirection = () => {
    if (inWord && /^\d+$/.test(word)) {
      word = '';
      inWord = false;
    }
    endWord();
    target = true;
  };
  const endCommand = (at: number) => {
    endWord();
    target = false;
    current.raw = src.slice(rawStart, at);
    if (current.words.length > 0 || current.heredocs.length > 0) p.commands.push(current);
    current = { words: [], raw: '', heredocs: [] };
    rawStart = at + 1;
  };

  for (; p.i < src.length; p.i++) {
    const c = src[p.i];
    if (c === '\\') {
      if (src[p.i + 1] !== '\n') {
        word += src[p.i + 1] ?? '';
        inWord = true;
      }
      p.i++;
    } else if (c === "'") {
      const end = src.indexOf("'", p.i + 1);
      word += src.slice(p.i + 1, end < 0 ? src.length : end);
      inWord = true;
      p.i = end < 0 ? src.length : end;
    } else if (c === '$' && src[p.i + 1] === "'") {
      // `$'…'`: a backslash escapes the closing quote.
      let j = p.i + 2;
      for (; j < src.length && src[j] !== "'"; j++) {
        if (src[j] === '\\') j++;
        word += src[j] ?? '';
      }
      inWord = true;
      p.i = j;
    } else if (c === '"') {
      inWord = true;
      for (p.i++; p.i < src.length && src[p.i] !== '"'; p.i++) {
        const d = src[p.i];
        if (d === '\\') {
          word += src[p.i + 1] ?? '';
          p.i++;
        } else if (d === '$') {
          word += dollar(p, depth);
        } else if (d === '`') {
          word += backtick(p, depth);
        } else {
          word += d;
        }
      }
    } else if (c === '$') {
      inWord = true;
      word += dollar(p, depth);
    } else if (c === '`') {
      inWord = true;
      word += backtick(p, depth);
    } else if ((c === '<' || c === '>') && src[p.i + 1] === '(') {
      // Process substitution runs its commands wherever it is written. As a redirection's target it is the target.
      endWord();
      target = false;
      p.i += 2;
      list(p, true, depth + 1);
    } else if (c === '<' && src[p.i + 1] === '<' && src[p.i + 2] === '<') {
      // `<<< text`: the text is input.
      redirection();
      p.i += 2;
    } else if (c === '<' && src[p.i + 1] === '<') {
      if (inWord && /^\d+$/.test(word)) {
        word = '';
        inWord = false;
      }
      endWord();
      let j = p.i + 2;
      const stripTabs = src[j] === '-';
      if (stripTabs) j++;
      while (src[j] === ' ' || src[j] === '\t') j++;
      const { delim, quoted, end } = delimiterWord(src, j);
      if (delim === '') p.unreadable = true;
      else pending.push({ delim, quoted, stripTabs, owner: current });
      p.i = end - 1;
    } else if (c === '#' && !inWord) {
      const end = src.indexOf('\n', p.i);
      p.i = (end < 0 ? src.length : end) - 1;
    } else if (c === '\n') {
      endCommand(p.i);
      // Heredoc bodies start on the next line. They are input to the command that named them, not commands; an
      // unquoted delimiter still expands the substitutions in them.
      let pos = p.i + 1;
      for (const h of pending.splice(0)) {
        const body: string[] = [];
        while (pos < src.length) {
          let nl = src.indexOf('\n', pos);
          let line = src.slice(pos, nl < 0 ? src.length : nl);
          // In an unquoted heredoc a backslash at the end of a line joins it to the next, before the delimiter
          // is looked for (`EO\` + `F` ends it).
          while (!h.quoted && nl >= 0 && /(^|[^\\])(\\\\)*\\$/.test(line)) {
            const next = src.indexOf('\n', nl + 1);
            line = line.slice(0, -1) + src.slice(nl + 1, next < 0 ? src.length : next);
            nl = next;
          }
          pos = nl < 0 ? src.length : nl + 1;
          if ((h.stripTabs ? line.replace(/^\t+/, '') : line) === h.delim) break;
          body.push(line);
        }
        const text = body.join('\n');
        h.owner.heredocs.push(text);
        if (!h.quoted) scanText(p, text, depth + 1, true);
        if (!p.commands.includes(h.owner)) p.commands.push(h.owner);
      }
      p.i = pos - 1;
      rawStart = pos;
    } else if ((c === '<' || c === '>') && (src[p.i + 1] === '&' || src[p.i + 1] === '|')) {
      // `2>&1`, `<&3`, `>|`: a redirection, not a separator.
      redirection();
      p.i++;
    } else if (c === '&' && src[p.i + 1] === '>') {
      // `&>`, `&>>`: a redirection, not a separator.
      redirection();
      p.i += src[p.i + 2] === '>' ? 2 : 1;
    } else if (c === '<' || c === '>') {
      // `>`, `>>`, `<`, `<>`: one operator, one target.
      redirection();
      if (src[p.i + 1] === '>') p.i++;
    } else if (c === '(') {
      // A subshell: its commands are scanned to the matching `)`.
      endCommand(p.i);
      p.i++;
      list(p, true, depth + 1);
      rawStart = p.i + 1;
    } else if (c === ')') {
      endCommand(p.i);
      if (closed) return;
    } else if (c === ';' || c === '&' || c === '|') {
      endCommand(p.i);
    } else if (c === ' ' || c === '\t') {
      endWord();
    } else {
      word += c;
      inWord = true;
    }
  }
  endCommand(src.length);
  // A heredoc whose line never ended (no newline after its command): its body is missing, nothing to add.
}

function base(word: string): string {
  return word.slice(word.lastIndexOf('/') + 1);
}

/** Does any argument name a program for this data program to run (`rg --pre x`, `git grep -nO'x'`)? */
function namesProgram(program: string, args: readonly string[]): boolean {
  const options = EXEC_OPTIONS[program];
  if (!options) return false;
  return args.some(
    (a) =>
      // An expansion could become any option (`rg $(printf -- '--pre=…')`).
      a.includes(EXPANDED) ||
      options.long.some((o) => a === o || a.startsWith(`${o}=`)) ||
      (options.short !== '' && /^-[^-]/.test(a) && [...a.slice(1)].some((ch) => options.short.includes(ch))),
  );
}

type Verdict = 'data' | 'own-text' | 'may-run';

function gitVerdict(args: readonly string[]): Verdict {
  let k = 0;
  for (; k < args.length && args[k].startsWith('-'); k++) {
    const option = args[k];
    // `-c alias.x='!ssh …'`, `-cdiff.external=…`, `--config-env=…`: a setting that names it may run it.
    // An expansion could hold anything (`-c diff.external="$(printf …)"`).
    if (isSshCommand(option) || option.includes(EXPANDED)) return 'may-run';
    if (GIT_VALUE_OPTIONS.has(option)) {
      const value = args[k + 1] ?? '';
      if ((option === '-c' || option === '--config-env') && (isSshCommand(value) || value.includes(EXPANDED))) {
        return 'may-run';
      }
      k++;
    }
  }
  const sub = args[k];
  if (sub === undefined) return 'data';
  if (GIT_TRANSPORT.has(sub)) return 'own-text';
  if (!GIT_DATA.has(sub)) return 'may-run';
  return namesProgram(`git ${sub}`, args.slice(k + 1)) ? 'may-run' : 'data';
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
  let environment = false;
  for (;;) {
    const assignment = words.length > 0 ? ASSIGNMENT.exec(words[0]) : null;
    if (assignment) {
      // `x='ssh …'` may be run later as `$x`; a new `PATH` changes what every bare name runs.
      if (assignment[1] === 'PATH' || isSshCommand(words[0])) return 'may-run';
      if (!PLAIN_ENVIRONMENT.test(assignment[1]) || words[0].includes(EXPANDED)) environment = true;
      words = words.slice(1);
    } else if (words.length > 0 && KEYWORDS.has(words[0])) {
      words = words.slice(1);
    } else {
      break;
    }
  }
  if (words.length === 0) return 'data';
  const program = words[0];
  const args = words.slice(1);
  if (REMOTE_SHELLS.has(base(program))) return 'runs';
  // An environment set for one program can make a data program run another (`GIT_PAGER=…`, `PAGER=…`,
  // `RIPGREP_CONFIG_PATH=…`), whatever the value says.
  if (environment) return 'may-run';
  // A path (`./cat`) can name any program, and so can an expansion (`$(printf …)echo`); only a bare name means
  // the one on PATH.
  if (program.includes('/') || program.includes(EXPANDED)) return 'may-run';
  if (program === '[[' || program === '[') {
    // zsh runs `if [[ … ]] cmd`: words after the closing bracket are a command.
    const close = args.indexOf(program === '[[' ? ']]' : ']');
    return close >= 0 && close < args.length - 1 ? 'may-run' : 'data';
  }
  // zsh closes a brace group at a bare `}` and reads on (`{ echo a } always { cmd }`).
  const brace = args.indexOf('}');
  if (brace >= 0 && brace < args.length - 1) return 'may-run';
  // `printf -v NAME` sets a variable, possibly one trusted above; `read` is not a data command for the same reason.
  if (program === 'printf' && args.some((a) => a.startsWith('-v'))) return 'may-run';
  if (DATA_COMMANDS.has(program)) return namesProgram(program, args) ? 'may-run' : 'data';
  if (program === 'git') return gitVerdict(args);
  if (program === 'gh') return ghVerdict(args);
  if (program === 'rsync') return 'own-text';
  // `command -v ssh` looks a program up; it runs nothing.
  if (program === 'command' && (args[0] === '-v' || args[0] === '-V')) return 'data';
  if (program === 'find') {
    // An expansion could become `-exec`.
    const runs = (w: string) =>
      w === '-exec' || w === '-execdir' || w === '-ok' || w === '-okdir' || w.includes(EXPANDED);
    return args.some(runs) ? 'may-run' : 'data';
  }
  return 'may-run';
}

/** True when the Bash command runs ssh, scp or sftp, or could (see the file header). */
export function isRemoteShellCommand(command: string): boolean {
  if (!isSshCommand(command)) return false;
  const p = new Parser(command);
  list(p, false, 0);
  if (p.unreadable) return true;
  return p.commands.some((cmd) => {
    const v = verdict(cmd);
    if (v === 'own-text') return isSshCommand(cmd.raw) || cmd.heredocs.some((h) => isSshCommand(h));
    // The text names it (checked above) and this program could run it.
    return v === 'runs' || v === 'may-run';
  });
}
