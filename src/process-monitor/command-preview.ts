import { posix } from 'node:path';
import { redactSecrets } from '@soma/common/logger';

/**
 * What the Processes tab may show of a command line.
 *
 * A raw argv can carry secrets: the Agent SDK passes `--mcp-config` as inline
 * JSON with each MCP server's env, and a model can run `FOO_TOKEN=… cmd`. So the
 * preview keeps the shape of the command (program, flags, short values) and cuts
 * everything that could be a value nobody should see:
 *   - the value after a flag whose name says secret, config or prompt;
 *   - `NAME=value` where NAME says secret;
 *   - any JSON-looking argument, any argument longer than {@link MAX_ARG};
 *   - any 32+ character run of token characters;
 * then runs the logger's shaped-token redaction over the result.
 */

const MAX_ARGS = 16;
const MAX_ARG = 80;
const MAX_TOTAL = 240;
const CUT = '…';

/**
 * Flags whose value can span several ps tokens (ps joins argv with spaces and does not quote): inline JSON, prompts,
 * headers. Everything after one is cut up to the next `--flag`.
 */
const SPAN_FLAG = /^--?(mcp-config|settings|append-system-prompt|system-prompt|prompt|env|header|H|data|d)$/;
/** A word that marks a value as secret — in a flag's name (`--access-token`), a `NAME=` or a header name. */
const SECRET_WORD =
  /(token|secret|passw|pwd|api[-_]?key|apikey|auth|credential|cookie|session|bearer|private[-_]?key)/i;
/** Short flags whose next token (or attached value) is commonly a password: mysql `-p`, redis-cli `-a`. */
const SHORT_SECRET = /^-(p|a)$/;
const SHORT_SECRET_ATTACHED = /^-p\S+$/;
/** Auth schemes whose next token is the credential (`Authorization: Bearer …`). */
const AUTH_SCHEME = /^(bearer|basic|token|digest)$/i;
/** A header name that carries a credential (`X-Api-Key:`, `Authorization:`). */
const SECRET_HEADER = /^[A-Za-z0-9-]*:$/;
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/[^\s/:@]*):[^\s/@]*@/gi;
const LONG_TOKEN = /[A-Za-z0-9_\-+/=.]{32,}/g;

const basename = (p: string): string => posix.basename(p) || p;

/** A script argument that is a file, not inline code: a path-like word with no quotes, spaces or brackets. */
const SCRIPT_FILE = /^[\w./@+-]+$/;
/** Interpreter flags whose next argument is inline code, not a script (`python -c`, `node -e`, `perl -e`, `ruby -e`). */
const INLINE_CODE_FLAG = /^(-c|-e|-E|-p|--eval|--print|-m)$/;
const MAX_NAME = 60;

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
    // Inline code (`sh -c '…'`, `python -c '…'`, `node -e '…'`) is not a script: the name stays the interpreter, and
    // the code shows (redacted) on the command line only.
    if (!argv.slice(1).some((a) => INLINE_CODE_FLAG.test(a))) {
      const script = argv.slice(1).find((a) => !a.startsWith('-'));
      if (script && SCRIPT_FILE.test(script)) name = `${exe} ${basename(script)}`;
    }
  }
  name = String(redactSecrets(name)).replace(LONG_TOKEN, CUT);
  return name.length > MAX_NAME ? `${name.slice(0, MAX_NAME - 1)}${CUT}` : name;
}

function previewArg(arg: string): string {
  const eq = arg.indexOf('=');
  if (eq > 0 && SECRET_WORD.test(arg.slice(0, eq))) return `${arg.slice(0, eq + 1)}${CUT}`;
  let out = arg.replace(URL_CREDENTIALS, `$1:${CUT}@`).replace(LONG_TOKEN, CUT);
  if (out.length > MAX_ARG) out = `${out.slice(0, MAX_ARG - 1)}${CUT}`;
  return out;
}

/** A command line safe to show in the dashboard. */
export function commandPreview(argv: readonly string[]): string {
  if (argv.length === 0) return '';
  const parts: string[] = [basename(argv[0])];
  // 'next': hide the next token; 'span': hide every token up to the next `--flag`.
  let hide: 'none' | 'next' | 'span' = 'none';
  let shown = 0;
  for (const arg of argv.slice(1)) {
    if (hide === 'span') {
      if (!arg.startsWith('--')) continue;
      hide = 'none';
    } else if (hide === 'next') {
      parts.push(CUT);
      hide = 'none';
      continue;
    }
    if (shown >= MAX_ARGS) {
      parts.push(CUT);
      break;
    }
    shown++;
    const flag = arg.split('=')[0];
    const isFlag = arg.startsWith('-');
    if (isFlag && (SPAN_FLAG.test(flag) || SECRET_WORD.test(flag.replace(/^-+/, '')))) {
      if (arg.includes('=')) parts.push(`${flag}=${CUT}`);
      else {
        // ps flattened argv: a quoted multiword value is several tokens now — cut all of them, up to the next flag.
        parts.push(arg, CUT);
        hide = 'span';
      }
      continue;
    }
    if (SHORT_SECRET_ATTACHED.test(arg)) {
      parts.push(`-p${CUT}`);
      continue;
    }
    if (SHORT_SECRET.test(arg) || AUTH_SCHEME.test(arg) || (SECRET_HEADER.test(arg) && SECRET_WORD.test(arg))) {
      parts.push(arg);
      hide = 'next';
      continue;
    }
    if (arg.startsWith('{') || arg.startsWith('[')) {
      // Inline JSON: its spaces split it into many tokens — cut it whole, up to the next --flag.
      parts.push('{…}');
      hide = 'span';
      continue;
    }
    parts.push(previewArg(arg));
  }
  let line = String(redactSecrets(parts.join(' ')));
  if (line.length > MAX_TOTAL) line = `${line.slice(0, MAX_TOTAL - 1)}${CUT}`;
  return line;
}
