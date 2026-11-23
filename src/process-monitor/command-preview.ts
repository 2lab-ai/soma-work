import { posix } from 'node:path';
import { redactSecrets } from '@soma/common/logger';

/**
 * What the Processes tab may show of a command line — fail-closed.
 *
 * `ps args` joins argv with spaces and does not quote, so argument boundaries are gone: a prompt, an inline JSON config
 * or a passphrase with spaces becomes several tokens, and no parser can tell where such a value ends. So the preview
 * never tries to find the end of a value. It shows the shape of the command and hides every value:
 *   - the program's name;
 *   - flag names (`--model`, `-C`); a value written into a flag (`--x=value`, `-pS3cret`) is cut, and so is anything
 *     after a short flag's first letter (`-uroot` and `-rf` look the same);
 *   - the token right after a flag is cut (it may be that flag's value);
 *   - a flag that takes code, a prompt, a config, a header, a body or a credential (`-c`, `-e`, `-p`,
 *     `--append-system-prompt`, `--mcp-config`, `-H`, `-d`, `-u`, `--token` …) cuts everything after it, to the end of
 *     the line — a value that may hold spaces has no end we can find;
 *   - a `NAME=value` whose name says secret cuts the rest of the line too; any other `NAME=value` shows `NAME=…`;
 *   - a plain word shows only when it is a path (`/work/repo`, `./dist/server.js`): short, containing `/`, not a token
 *     run, URL credentials cut. Any other word — a subcommand, an operand, a positional password — is cut: a word
 *     alone cannot be told apart from a secret.
 * The logger's shaped-token redaction runs over what is left.
 */

const MAX_ARGS = 16;
const MAX_TOTAL = 240;
const CUT = '…';

/** A word that marks a flag or a `NAME=` as carrying a secret. */
const SECRET_WORD = /(token|secret|pass|phrase|pwd|pin|otp|key|auth|credential|cookie|session|bearer|user|login|sign)/i;
/**
 * Flags whose value can be code, a prompt, a config, a header, a request body or a credential — and can hold spaces.
 * Everything after one is cut.
 */
const CUT_REST_FLAG =
  /^(-c|-e|-E|-p|-m|-a|-u|-H|-d|-b|--eval|--print|--command|--mcp-config|--settings|--append-system-prompt|--system-prompt|--prompt|--env|--header|--data[\w-]*|--form|--user|--cookie|--json|--body)$/;
/** A plain argument shown as is: a short word, path or address — no quotes, spaces, braces or `=`. */
const SAFE_WORD = /^[A-Za-z0-9._/@:+,~%-]{1,64}$/;
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/[^\s/:@]*):[^\s/@]*@/gi;
const LONG_TOKEN = /[A-Za-z0-9_\-+/=.]{32,}/g;
const HAS_LONG_TOKEN = /[A-Za-z0-9_\-+/=.]{32,}/;
const MAX_NAME = 60;

const basename = (p: string): string => posix.basename(p) || p;

/** A script argument that is a file: path-like (a `/` or a script extension), with no quotes, spaces or brackets. */
const SCRIPT_FILE = /^(?=[\w./@+-]+$)(?:.*\/.*|.*\.(?:js|mjs|cjs|ts|mts|py|rb|pl|sh|php|lua))$/;
/**
 * Interpreter flags that take inline code, not a script (`python -c`, `node -e`, `perl -e`, `ruby -e`) — in every form:
 * separate (`-c code`), equals (`--eval=code`) or attached (`-cprint(1)`).
 */
const INLINE_CODE_FLAG = /^(-[ceEpm]|--eval|--print)(=|$)|^-[ceEpm]./;
/** Short-flag letters whose value can be code, a prompt, a password, a user, a header or a body. */
const CUT_REST_SHORT = /^-[ceEpmauHdb]/;

/** Split a `ps args` line into argv. ps joins argv with single spaces and does not quote, so this is best effort. */
export function splitArgs(line: string): string[] {
  return line.trim().split(/\s+/).filter(Boolean);
}

/** Program name for the table: the executable's basename, plus the script for an interpreter. */
export function processName(argv: readonly string[]): string {
  if (argv.length === 0) return '?';
  const exe = basename(argv[0]);
  let name = exe;
  if (/^(node|bun|deno|python[0-9.]*|ruby|perl|sh|bash|zsh)$/.test(exe)) {
    // Inline code (`sh -c '…'`, `python -c '…'`, `node -e '…'`) is not a script: the name stays the interpreter.
    // `-` (or `--` then nothing) is a script read from stdin: its next argument is data, not a file.
    if (!argv.slice(1).some((a) => INLINE_CODE_FLAG.test(a) || a === '-')) {
      const script = argv.slice(1).find((a) => !a.startsWith('-'));
      if (script && SCRIPT_FILE.test(script)) name = `${exe} ${basename(script)}`;
    }
  }
  name = String(redactSecrets(name)).replace(LONG_TOKEN, CUT);
  return name.length > MAX_NAME ? `${name.slice(0, MAX_NAME - 1)}${CUT}` : name;
}

/** A command line safe to show in the dashboard (see the module comment for what is shown). */
export function commandPreview(argv: readonly string[]): string {
  if (argv.length === 0) return '';
  const parts: string[] = [basename(argv[0])];
  const cut = () => {
    if (parts[parts.length - 1] !== CUT) parts.push(CUT);
  };
  // afterFlag: the token after a bare flag may be its value. inValue: a value was written into the previous flag
  // (`--x=a b c`, `-pa b c`) and ps may have split it — every following plain word is cut until the next flag.
  let afterFlag = false;
  let inValue = false;
  let shown = 0;
  for (const arg of argv.slice(1)) {
    if (shown >= MAX_ARGS) {
      cut();
      break;
    }
    shown++;
    if (arg.startsWith('-') && arg.length > 1) {
      inValue = false;
      const short = !arg.startsWith('--');
      const eq = arg.indexOf('=');
      // A short flag's name is its letter: `-pS3cret`, `-uroot`, `-rf` and `-p` are all `-p` / `-u` / `-r` here.
      const name = short ? arg.slice(0, 2) : eq > 0 ? arg.slice(0, eq) : arg;
      if (
        (short ? CUT_REST_SHORT.test(name) : CUT_REST_FLAG.test(name)) ||
        SECRET_WORD.test(short ? arg.slice(1) : name.replace(/^-+/, ''))
      ) {
        parts.push(name);
        cut();
        break;
      }
      if (short && arg.length > 2) {
        // More after the letter — a value attached (`-n5`) or bundled flags (`-rf`), which ps cannot tell apart.
        parts.push(`${name}${CUT}`);
        afterFlag = false;
        inValue = true;
      } else if (eq > 0) {
        parts.push(`${name}=${CUT}`);
        afterFlag = false;
        inValue = true;
      } else {
        parts.push(name);
        afterFlag = true;
      }
      continue;
    }
    if (inValue) {
      cut();
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(arg.slice(0, eq))) {
      if (SECRET_WORD.test(arg.slice(0, eq))) {
        parts.push(`${arg.slice(0, eq)}=`);
        cut();
        break;
      }
      parts.push(`${arg.slice(0, eq)}=${CUT}`);
      afterFlag = false;
      continue;
    }
    if (afterFlag) {
      // May be the previous flag's value.
      cut();
      afterFlag = false;
      continue;
    }
    const word = arg.replace(URL_CREDENTIALS, `$1:${CUT}@`);
    if (word.includes('/') && SAFE_WORD.test(word.replace(CUT, '')) && !HAS_LONG_TOKEN.test(word)) parts.push(word);
    else cut();
  }
  let line = String(redactSecrets(parts.join(' ')));
  if (line.length > MAX_TOTAL) line = `${line.slice(0, MAX_TOTAL - 1)}${CUT}`;
  return line;
}
