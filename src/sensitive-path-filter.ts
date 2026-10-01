/**
 * Sensitive Path Filter
 *
 * Blocks non-admin users from reading sensitive host files via Claude tools
 * (Read, Bash cat/head/tail, Glob, Grep).
 *
 * Background: Claude Code sandbox restricts file *writes* but has no read
 * restrictions. This means any user can read SSH keys, API tokens, DB
 * passwords, and other secrets from the host filesystem. This module
 * enforces read-side protection at the application layer.
 *
 * Admin users (isAdminUser) bypass all checks.
 */

import * as os from 'os';
import * as path from 'path';

/**
 * The top-level entries of /usr/share/firmlinks: macOS keeps each on the data volume and firmlinks
 * it to the root, so /System/Volumes/Data/Users/x is /Users/x (one inode). The module writes them
 * through the firmlink. Written folded, with DATA_VOLUME, since the rules compare folded keys
 * (foldKey). The nested entries (/System/Library/Caches, /usr/local, ...) hold no table entry.
 */
const DATA_VOLUME = '/system/volumes/data';
const FIRMLINKS: ReadonlyArray<string> = [
  'appleinternal',
  'applications',
  'library',
  'users',
  'volumes',
  'cores',
  'opt',
  'pkg',
  'private',
];

/**
 * The directories macOS keeps in /private and links from the root (`/etc -> private/etc`) that the
 * module writes through their links: /tmp, as the rest of soma-work writes it (normalizeTmpPath),
 * and /etc, which holds /etc/shadow. /var, the third, is not: no table entry lies under it unless
 * HOME does (root's is /var/root).
 */
const PRIVATE_LINKS: ReadonlyArray<string> = ['tmp', 'etc'];

// os.homedir() returns $HOME as it is set, so it is resolved to an absolute path, and written the
// way normalizePath writes checked paths (through the links of normalizeLinks), or the tables
// below could never match them.
const HOME = normalizeLinks(path.resolve(os.homedir()));

/** Directories where any path underneath is blocked. */
const SENSITIVE_DIRECTORIES: ReadonlyArray<string> = [
  path.join(HOME, '.ssh'),
  path.join(HOME, '.gnupg'),
  path.join(HOME, '.config', 'gh'),
  path.join(HOME, '.aws'),
  path.join(HOME, '.docker'),
  path.join(HOME, 'Library', 'Keychains'),
  '/etc/shadow',
];

/** Specific files that are sensitive regardless of directory. */
const SENSITIVE_EXACT_FILES = new Set<string>([
  path.join(HOME, '.gitconfig'),
  path.join(HOME, '.netrc'),
  path.join(HOME, '.npmrc'),
  path.join(HOME, '.claude', 'credentials.json'),
]);

/** Regex patterns for sensitive basenames. */
const SENSITIVE_BASENAME_PATTERNS: ReadonlyArray<RegExp> = [
  /^\.env(\..+)?$/,
  /^credentials\.json$/,
  /^secrets?\.(json|ya?ml|toml)$/,
];

/**
 * Service config files containing secrets. Only specific files are blocked, not the whole directory.
 * Their `.env` files are not listed: SENSITIVE_BASENAME_PATTERNS, checked first, blocks every `.env`.
 */
const SENSITIVE_SERVICE_CONFIGS: ReadonlyArray<{ dir: string; files: ReadonlyArray<string> }> = [
  { dir: '/opt/soma-work', files: ['config.json'] },
  { dir: '/opt/soma', files: ['config.json'] },
];

/** Shell spellings of the home directory; expandHome replaces each of them with HOME. */
const HOME_ALIASES: ReadonlyArray<string> = ['~', '$HOME', `\${HOME}`];

/**
 * What fold writes for each code point other than A-Z that it rewrites. APFS, the macOS default,
 * compares names with Unicode case folding, which folds these into ASCII letters: `.\u00DFh` opens
 * `.ssh` and `.gitcon\uFB01g` opens `.gitconfig`.
 */
const FOLDED_LETTERS: Readonly<Record<string, string>> = {
  '\u00DF': 'ss',
  '\u017F': 's',
  '\u1E9E': 'ss',
  '\u212A': 'k',
  '\uFB00': 'ff',
  '\uFB01': 'fi',
  '\uFB02': 'fl',
  '\uFB03': 'ffi',
  '\uFB04': 'ffl',
  '\uFB05': 'st',
  '\uFB06': 'st',
};

/** SENSITIVE_DIRECTORIES and SENSITIVE_EXACT_FILES as the rules compare them (foldKey). */
const DIRECTORY_KEYS: ReadonlyArray<string> = SENSITIVE_DIRECTORIES.map(foldKey);
const EXACT_FILE_KEYS: ReadonlySet<string> = new Set(Array.from(SENSITIVE_EXACT_FILES, foldKey));

// Regexes for extracting file paths from bash commands — hoisted to avoid per-call recompilation.
// A captured path may start with a HOME_ALIASES spelling, which expandHome replaces.
// Known limits of this text-level check. Relative paths, and a Glob with a relative base, resolve
// against a working directory this module never sees, so they are checked as written: only the
// basename patterns can match them. `..` is resolved lexically, while after a symbolic link the
// OS climbs from the link's target: the check follows a walk into the sensitive directories, not
// through links outside them, but for the macOS links of normalizeLinks, which it writes through:
// the top-level firmlinks and, of the links into /private, PRIVATE_LINKS.
// `~user/...` is not expanded. A glob's partial segment is not matched against names
// (`~/.ss*/id_rsa` checks HOME). Names are compared case-folded, not Unicode-normalized (every
// sensitive name is ASCII).
// In Bash, HOME is the only variable expanded, and quoting, `$'...'` and `$"..."` included, the
// only other shell rule applied (extractPathsFromCommand). Quotes count as removed even where the
// shell keeps them, so a quoted `~` or `$HOME` still counts as HOME (a `~` written as an escape in
// `$'...'`, `\x7e`, does not). Other variables, command substitution (a `$'...'` inside
// `"$(...)"` stays literal) and paths with white space or control characters are not understood,
// and only the commands below are read. Every word of their arguments is taken as a path but the
// pattern or program of PATTERN_FIRST, found from white-space-separated words: a quoted pattern
// with white space in it (`grep "load .env" docs/`) counts as several words, the first of them
// the pattern. An OS-level read deny list would cover every spelling (getSensitiveReadDenyPaths
// builds one; nothing applies it).
// A read or copy command's arguments run to the next `|`, `;` or `&`; RE_PATH picks every path
// among them, and RE_RELATIVE_ARG every relative one. `\/+`: the shell reads `//` as `/`.
const RE_READ_COMMANDS =
  /\b(cat|head|tail|less|more|bat|xxd|hexdump|strings|base64|nano|vi|vim|code|open|wc|grep|egrep|fgrep|rg|awk|sed|sort|uniq|tac|nl|od|cmp|diff|jq|cp|mv|rsync|scp)\b([^|;&]*)/g;
const RE_PATH = /(?:~|\$HOME|\$\{HOME\})?(?:\/+[\w.\-~]+)+(?:\/+[\w.\-~*]+)?/g;
const RE_INPUT_REDIRECT = /<\s*((?:~|\$HOME|\$\{HOME\})?(?:\/+[\w.\-~]+)+(?:\/+[\w.\-~]+)?)/g;
// `.` sources a file where a command starts: at the start, or after white space or a separator.
const RE_SOURCE_CMD =
  /(?:\bsource|(?<![^\w\s;&|(){}`])\.)\s+((?:~|\$HOME|\$\{HOME\})?(?:\/+[\w.\-~]+)+(?:\/+[\w.\-~]+)?)/g;
// Relative paths, which the patterns above take only from their first `/` (`./.env` as `/.env`),
// or miss when they have none (`.env`). A relative path starts with neither `/`, `~` nor `$`; an
// argument, not with `-` either (a flag), and it may follow a `=` (`--include=.env`).
const RE_RELATIVE_ARG = /(?<![^\s=])[\w.][\w.\-~]*(?:\/+[\w.\-~]+)*/g;
const RE_RELATIVE_REDIRECT = /<\s*([\w.][\w.\-~]*(?:\/+[\w.\-~]+)*)/g;
// Here `.` needs the start, white space or a separator before it: `Done. notes` sources nothing.
const RE_RELATIVE_SOURCE = /(?:\bsource|(?<![^\s;&|(){}`])\.)\s+([\w.][\w.\-~]*(?:\/+[\w.\-~]+)*)/g;
// Changing into a directory is an access to it. RE_RELATIVE_ARG reads the relative ones from the
// arguments RE_CHANGE_DIR_ARGS takes (`cd .env`).
const RE_CHANGE_DIR = /\b(?:cd|pushd)\b[^|;&]*?((?:~|\$HOME|\$\{HOME\})?(?:\/+[\w.\-~]+)+(?:\/+[\w.\-~]+)?)/g;
const RE_CHANGE_DIR_ARGS = /\b(?:cd|pushd)\b([^|;&]*)/g;

/**
 * How a reader's options take their arguments, for PATTERN_FIRST: the argument of a `pattern`
 * option is the pattern or program, so every operand is a file (`grep -e PATTERN FILE`); that of a
 * `patternFile` option is a file the pattern or program is read from, a path, and every operand is
 * a file (`grep -f FILE`); that of a `path` option names files read (`--include=GLOB`), a path; and
 * that of a `value` option is skipped (`-m NUM`). A `patternless` option has no argument and makes
 * every operand a file (`rg --files`).
 */
interface OptionTable {
  readonly pattern?: ReadonlyArray<string>;
  readonly patternFile?: ReadonlyArray<string>;
  readonly path?: ReadonlyArray<string>;
  readonly value?: ReadonlyArray<string>;
  readonly patternless?: ReadonlyArray<string>;
}
type OptionKind = keyof OptionTable;
const OPTION_KINDS: ReadonlyArray<OptionKind> = ['pattern', 'patternFile', 'path', 'value', 'patternless'];

const GREP_OPTIONS: OptionTable = {
  pattern: ['-e', '--regexp'],
  patternFile: ['-f', '--file'],
  path: ['--include', '--exclude', '--include-dir', '--exclude-dir', '--include-from', '--exclude-from'],
  value: ['-A', '-B', '-C', '-d', '-D', '-m', '--after-context', '--before-context', '--max-count'],
};

/**
 * The readers whose first operand is a pattern or program, not a file (`grep PATTERN FILE...`),
 * and their options as the GNU, macOS and ripgrep manuals give them. The first operand is not
 * checked unless an option gave the pattern. An option not listed is taken to have no argument:
 * if it has one, that argument is taken for the pattern and the pattern is checked as a file, a
 * block too many but never a file unchecked, as long as every option whose argument gives the
 * pattern or names a file read is listed. So a `value` or `path` option is listed only where GNU
 * and macOS both take a separate argument: not sed's `-i`, whose argument GNU attaches, or `-l`, a
 * flag on macOS. awk on macOS ignores gawk's `-e`, `-E`, `-i` and `-l` (`unknown option -i
 * ignored`), so the last three are `patternFile`, which checks every word after them. jq's `-e` is
 * `--exit-status`.
 */
const PATTERN_FIRST: ReadonlyMap<string, OptionTable> = new Map([
  ['grep', GREP_OPTIONS],
  ['egrep', GREP_OPTIONS],
  ['fgrep', GREP_OPTIONS],
  [
    'rg',
    {
      pattern: ['-e', '--regexp'],
      patternFile: ['-f', '--file'],
      path: ['-g', '--glob', '--iglob', '--ignore-file'],
      value: ['-A', '-B', '-C', '-d', '-E', '-j', '-m', '-M', '-r', '-t', '-T', '--max-count', '--replace', '--type'],
      patternless: ['--files', '--type-list'],
    },
  ],
  ['sed', { pattern: ['-e', '--expression'], patternFile: ['-f', '--file'] }],
  [
    'awk',
    {
      pattern: ['-e', '--source'],
      patternFile: ['-f', '--file', '-E', '--exec', '-i', '--include', '-l', '--load'],
      value: ['-F', '-v', '--field-separator', '--assign'],
    },
  ],
  ['jq', { patternFile: ['-f', '--from-file', '--run-tests'], path: ['-L'], value: ['--indent'] }],
]);
/** The quote and backslash characters the shell removes from a word. */
const QUOTING = /["'\\]/g;
/** White space and the metacharacters `|&;()<>`: unquoted, each ends a word. */
const WORD_END = /[\s|&;()<>]/;
/** A character RE_PATH continues a path with. */
const PATH_CHAR = /[\w.\-~/]/;
/**
 * The numeric escapes of `$'...'` after their backslash: \nnn, 1-3 octal digits, taken modulo 256
 * (`\400` is a NUL); \xHH, 1-2 hex digits; \uHHHH, 1-4; \UHHHHHHHH, 1-8: at most 9 characters.
 */
const ANSI_C_NUMERIC = /^(?:[0-7]{1,3}|x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8})/;
/** The one-letter escapes of `$'...'` and their values. */
const ANSI_C_ESCAPES: ReadonlyMap<string, string> = new Map([
  ['a', '\x07'],
  ['b', '\b'],
  ['e', '\x1b'],
  ['E', '\x1b'],
  ['f', '\f'],
  ['n', '\n'],
  ['r', '\r'],
  ['t', '\t'],
  ['v', '\v'],
  ['\\', '\\'],
  ["'", "'"],
  ['"', '"'],
  ['?', '?'],
]);

export interface SensitivePathResult {
  readonly isSensitive: boolean;
  readonly reason?: string;
}

/** Check if an absolute path points to a sensitive location. */
export function checkSensitivePath(filePath: string): SensitivePathResult {
  const normalized = normalizePath(filePath);

  // The path, then every directory its walk passes through: after a symbolic link, `..` climbs
  // from the link's target (`.aws/link/../../credentials` can read `.aws/credentials`), so a walk
  // that enters a sensitive directory may end anywhere inside it.
  for (const point of [normalized, ...walkPoints(filePath)]) {
    const key = foldKey(point);
    const index = DIRECTORY_KEYS.findIndex((dir) => key === dir || key.startsWith(dir + '/'));
    if (index >= 0) {
      return { isSensitive: true, reason: `Access to ${SENSITIVE_DIRECTORIES[index]}/ is restricted` };
    }
  }

  const key = foldKey(normalized);
  if (EXACT_FILE_KEYS.has(key)) {
    return { isSensitive: true, reason: `Access to ${normalized} is restricted` };
  }

  const basename = path.basename(normalized);
  for (const pattern of SENSITIVE_BASENAME_PATTERNS) {
    if (pattern.test(fold(basename))) {
      return { isSensitive: true, reason: `File ${basename} matches sensitive pattern` };
    }
  }

  // A service config sits in its directory or one directory below it: /opt/soma-work/{,*/}{file}.
  // The table is written folded.
  for (const { dir, files } of SENSITIVE_SERVICE_CONFIGS) {
    if (!key.startsWith(dir + '/')) continue;
    const parts = key.slice(dir.length + 1).split('/');
    if (parts.length <= 2 && files.includes(parts[parts.length - 1])) {
      return { isSensitive: true, reason: `Service config ${normalized} is restricted` };
    }
  }

  return { isSensitive: false };
}

/** Check if a Bash command attempts to read sensitive files. */
export function checkBashSensitivePaths(command: string): SensitivePathResult {
  const paths = extractPathsFromCommand(command);
  for (const p of paths) {
    const result = checkSensitivePath(p);
    if (result.isSensitive) return result;
  }
  return { isSensitive: false };
}

/** Check if a glob pattern targets a sensitive directory. */
export function checkSensitiveGlob(pattern: string, basePath?: string): SensitivePathResult {
  // path.resolve resolves `..` lexically; written after its base, the pattern keeps its walk
  // through the base, where a symbolic link makes `..` climb from the link's target.
  const spellings = basePath
    ? [path.resolve(basePath, pattern), pattern.startsWith('/') ? pattern : `${basePath}/${pattern}`]
    : [pattern];
  for (const spelling of spellings) {
    // The text before the first glob metacharacter, and the directory the glob lists: that text
    // cut back to its last `/`, since a partial segment is a pattern (`.ssh/..*` lists .ssh).
    const concrete = spelling.split(/[*?{}[\]]/)[0];
    for (const dir of [concrete.replace(/\/+$/, ''), concrete.slice(0, concrete.lastIndexOf('/') + 1)]) {
      const result = checkSensitivePath(dir);
      if (result.isSensitive) return result;
    }
  }
  return { isSensitive: false };
}

function collectMatches(pattern: RegExp, text: string): string[] {
  return Array.from(text.matchAll(pattern), (m) => m[1]).filter(Boolean);
}

function extractPathsFromCommand(command: string): string[] {
  // The command is read four ways and every path any reading shows is checked, so each reading
  // only adds paths: as written, where a path stops at a quote or backslash; with every quote and
  // backslash removed, as the shell removes them before it opens a file (`"$HOME/.env"`,
  // `~/.s""sh`, `~/.s\sh`), even where it keeps them; and with `$'...'` decoded (decodeQuoting),
  // once with a NUL ending the `$'...'`, as in bash, and once ending the word, as in zsh.
  const readings = new Set([
    command,
    command.replace(QUOTING, ''),
    decodeQuoting(command, false),
    decodeQuoting(command, true),
  ]);
  const paths: string[] = [];
  for (const text of readings) {
    for (const [, reader, args] of text.matchAll(RE_READ_COMMANDS)) {
      const options = PATTERN_FIRST.get(reader);
      for (const words of options ? fileWords(args.split(/\s+/).filter(Boolean), options) : [args]) {
        paths.push(...(words.match(RE_PATH) ?? []));
        paths.push(...(words.match(RE_RELATIVE_ARG) ?? []));
      }
    }
    paths.push(...collectMatches(RE_INPUT_REDIRECT, text));
    paths.push(...collectMatches(RE_RELATIVE_REDIRECT, text));
    paths.push(...collectMatches(RE_SOURCE_CMD, text));
    paths.push(...collectMatches(RE_RELATIVE_SOURCE, text));
    paths.push(...collectMatches(RE_CHANGE_DIR, text));
    for (const args of collectMatches(RE_CHANGE_DIR_ARGS, text)) {
      paths.push(...(args.match(RE_RELATIVE_ARG) ?? []));
    }
  }
  return paths;
}

/**
 * The words among a PATTERN_FIRST reader's arguments that may name files: every operand but the
 * pattern, the first one unless an option gave the pattern, and the argument of every option that
 * names a file. Option words are kept too, for a path attached with `=` (`--include=.env`), but not
 * one that gives the pattern (`--regexp=.env`). `--` ends the options.
 */
function fileWords(words: ReadonlyArray<string>, options: OptionTable): string[] {
  const files: string[] = [];
  let patternGiven = false;
  let optionsEnded = false;
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (optionsEnded || word === '-' || !word.startsWith('-')) {
      if (patternGiven) files.push(word);
      patternGiven = true;
    } else if (word === '--') {
      optionsEnded = true;
    } else {
      const { kind, argument } = readOption(word, options);
      if (kind !== 'pattern') files.push(word);
      if (kind === 'pattern' || kind === 'patternFile' || kind === 'patternless') patternGiven = true;
      if (kind === undefined || kind === 'patternless') continue;
      let value = argument;
      if (value === undefined) {
        i += 1;
        value = words[i];
      }
      if (value !== undefined && (kind === 'patternFile' || kind === 'path')) files.push(value);
    }
  }
  return files;
}

/**
 * The kind of an option word and the argument attached to it: `--name=argument`, or the rest of a
 * cluster of short options after the first one that takes an argument (`-rne`, `-fFILE`, `-A3`). A
 * long option may be abbreviated, as GNU allows: a word that begins a listed name giving the pattern
 * or naming a file counts as `patternFile` when it may name a file, which checks every word after it.
 */
function readOption(word: string, options: OptionTable): { kind?: OptionKind; argument?: string } {
  const kindOf = (name: string) => OPTION_KINDS.find((kind) => options[kind]?.includes(name));
  if (word.startsWith('--')) {
    const eq = word.indexOf('=');
    const name = eq < 0 ? word : word.slice(0, eq);
    const argument = eq < 0 ? undefined : word.slice(eq + 1);
    const begun = (kind: OptionKind) => options[kind]?.some((listed) => listed.startsWith(name)) ?? false;
    let kind = kindOf(name);
    if (kind === undefined && name.length > 2) {
      if (begun('patternFile') || begun('path')) kind = 'patternFile';
      else if (begun('pattern')) kind = 'pattern';
    }
    return { kind, argument };
  }
  for (let j = 1; j < word.length; j += 1) {
    const kind = kindOf(`-${word[j]}`);
    if (kind !== undefined) return { kind, argument: j + 1 < word.length ? word.slice(j + 1) : undefined };
  }
  return {};
}

/**
 * The command with its quoting read as the shell reads it, quote and backslash characters then
 * removed: each `$'...'` outside quotes becomes its value (decodeAnsiC) and `$"..."` is read as
 * `"..."`. With nulEndsWord, a NUL in a `$'...'` drops the rest of its word, up to the next unquoted
 * white space or metacharacter, as zsh does; otherwise it ends only the `$'...'`, as bash does. The
 * shell never expands a quoted `~`, so a decoded `~` starting a path is written `/~`, a directory
 * named `~`: `$'\x7e/.ssh/id_rsa'` is checked as `/~/.ssh/id_rsa`, not as a file in HOME.
 */
function decodeQuoting(command: string, nulEndsWord: boolean): string {
  let text = '';
  let quote = '';
  let dropping = false;
  const keep = (chars: string) => {
    if (!dropping) text += chars.replace(QUOTING, '');
  };
  for (let i = 0; i < command.length; ) {
    const c = command[i];
    if (quote === "'") {
      if (c === "'") quote = '';
      keep(c);
      i += 1;
    } else if (c === '\\') {
      keep(command.slice(i, i + 2));
      i += 2;
    } else if (quote === '"') {
      if (c === '"') quote = '';
      keep(c);
      i += 1;
    } else if (command.startsWith('$$', i)) {
      // The shell's process ID: the `$` after it does not start a `$'` or `$"`.
      keep('$$');
      i += 2;
    } else if (command.startsWith('$"', i)) {
      quote = '"';
      i += 2;
    } else if (command.startsWith("$'", i)) {
      let end = i + 2;
      while (end < command.length && command[end] !== "'") end += command[end] === '\\' ? 2 : 1;
      const { value, nul } = decodeAnsiC(command.slice(i + 2, end));
      for (const ch of value) keep(ch === '~' && !PATH_CHAR.test(text.slice(-1)) ? '/~' : ch);
      if (nul && nulEndsWord) dropping = true;
      i = end + 1;
    } else {
      if (c === "'" || c === '"') quote = c;
      else if (WORD_END.test(c)) dropping = false;
      keep(c);
      i += 1;
    }
  }
  return text;
}

/**
 * The value bash gives the body of a `$'...'`, up to the first NUL, and whether one cut it short.
 * An escape bash does not know keeps its backslash (`\z` stays `\z`).
 */
function decodeAnsiC(body: string): { value: string; nul: boolean } {
  let value = '';
  for (let i = 0; i < body.length; ) {
    let ch = body[i];
    let next = i + 1;
    if (ch === '\\' && i + 1 < body.length) {
      const letter = body[i + 1];
      const simple = ANSI_C_ESCAPES.get(letter);
      const digits = ANSI_C_NUMERIC.exec(body.slice(i + 1, i + 10))?.[0];
      next = i + 2;
      if (simple !== undefined) {
        ch = simple;
      } else if (digits) {
        const code = letter <= '7' ? parseInt(digits, 8) & 0xff : parseInt(digits.slice(1), 16);
        ch = code <= 0x10ffff ? String.fromCodePoint(code) : body.slice(i, i + 1 + digits.length);
        next = i + 1 + digits.length;
      } else if (letter === 'c' && i + 2 < body.length) {
        // \cX: the control character of X.
        ch = String.fromCharCode(body[i + 2] === '?' ? 0x7f : body[i + 2].toUpperCase().charCodeAt(0) & 0x1f);
        next = i + 3;
      } else {
        ch = body.slice(i, i + 2);
      }
    }
    if (ch === '\0') return { value, nul: true };
    value += ch;
    i = next;
  }
  return { value, nul: false };
}

/** A path starting with a HOME_ALIASES spelling, alone or before `/`, with HOME in its place. */
function expandHome(filePath: string): string {
  for (const alias of HOME_ALIASES) {
    if (filePath === alias || filePath.startsWith(alias + '/')) return HOME + filePath.slice(alias.length);
  }
  return filePath;
}

function normalizePath(filePath: string): string {
  return resolvePath(expandHome(filePath));
}

function resolvePath(expanded: string): string {
  // Resolve `.`, `..` and empty segments of an absolute path (`..` at the root stays there), so
  // every spelling of a path is checked as that path. This runs before the link mapping:
  // resolving after it would let `//private/tmp/x` through as `/private/tmp/x`, unmapped.
  const resolved = expanded.startsWith('/') ? path.posix.normalize(expanded) : expanded;
  return normalizeLinks(resolved).replace(/\/+$/, '');
}

/**
 * A path written through the macOS links it starts with: `/system/volumes/data/<firmlink>` as
 * `/<firmlink>`, then `/private/tmp` and `/private/etc` as `/tmp` and `/etc`, so
 * `/system/volumes/data/private/etc/x` is `/etc/x`. FIRMLINKS are written folded, so they match
 * the folded keys (foldKey) whatever the case of the path.
 */
function normalizeLinks(filePath: string): string {
  return dropLinkPrefix(dropLinkPrefix(filePath, DATA_VOLUME, FIRMLINKS), '/private', PRIVATE_LINKS);
}

/**
 * A path at or below `${prefix}/${name}` for one of `names`, without `prefix`. Any other path, a
 * false prefix such as `/private/etcetera` included, is returned unchanged.
 */
function dropLinkPrefix(filePath: string, prefix: string, names: ReadonlyArray<string>): string {
  for (const name of names) {
    const target = `${prefix}/${name}`;
    if (filePath === target || filePath.startsWith(`${target}/`)) return filePath.slice(prefix.length);
  }
  return filePath;
}

/** Where the walk of a path is after each of its segments, normalized. */
function walkPoints(filePath: string): string[] {
  const segments = expandHome(filePath).split('/');
  return segments.map((_, i) => resolvePath(segments.slice(0, i + 1).join('/')));
}

/** A path with A-Z and the FOLDED_LETTERS code points written as the ASCII letters they fold to. */
function fold(text: string): string {
  return text.replace(/[A-Z\u00DF\u017F\u1E9E\u212A\uFB00-\uFB06]/g, (c) => FOLDED_LETTERS[c] ?? c.toLowerCase());
}

/**
 * A normalized path as the rules compare it: folded, since APFS compares names without regard to
 * case, and written through the links of normalizeLinks again, since folding can spell them
 * (`/PRIVATE/etc`, `/System/Volumes/Data/Users`).
 */
function foldKey(normalized: string): string {
  return normalizeLinks(fold(normalized));
}

/**
 * Sensitive paths for sandbox read.denyOnly configuration.
 * Concrete paths (not wildcards) for non-admin user sandbox restriction.
 */
export function getSensitiveReadDenyPaths(): string[] {
  return [
    ...SENSITIVE_DIRECTORIES,
    ...Array.from(SENSITIVE_EXACT_FILES),
    '/opt/soma-work/dev/.env',
    '/opt/soma-work/prod/.env',
    '/opt/soma-work/dev/config.json',
    '/opt/soma-work/prod/config.json',
    '/opt/soma/dev/.env',
    '/opt/soma/prod/.env',
  ];
}
