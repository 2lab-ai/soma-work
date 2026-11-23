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

/** Flags whose next argument is never shown. */
const HIDDEN_VALUE_FLAG =
  /^--?(mcp-config|settings|append-system-prompt|system-prompt|prompt|env|header|password|token|secret|api[-_]?key|auth\w*)$/i;
/** `NAME=value` arguments whose value is never shown. */
const SECRET_NAME = /(token|secret|password|passwd|api[-_]?key|auth|credential|cookie|session)/i;
const LONG_TOKEN = /[A-Za-z0-9_\-+/=.]{32,}/g;

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

/** Split a `ps args` line into argv. ps joins argv with single spaces and does not quote, so this is best effort. */
export function splitArgs(line: string): string[] {
  return line.trim().split(/\s+/).filter(Boolean);
}

/** Program name for the table: the executable's basename, plus the script for an interpreter. */
export function processName(argv: readonly string[]): string {
  if (argv.length === 0) return '?';
  const exe = basename(argv[0]);
  if (/^(node|bun|deno|python[0-9.]*|ruby|perl|sh|bash|zsh)$/.test(exe)) {
    // `sh -c '…'` runs inline text, not a script: the command column shows it.
    if (/^(sh|bash|zsh)$/.test(exe) && argv.includes('-c')) return exe;
    const script = argv.slice(1).find((a) => !a.startsWith('-'));
    if (script && script.length <= MAX_ARG) return `${exe} ${basename(script)}`;
  }
  return exe;
}

function previewArg(arg: string): string {
  if (arg.startsWith('{') || arg.startsWith('[')) return '{…}';
  const eq = arg.indexOf('=');
  if (eq > 0 && SECRET_NAME.test(arg.slice(0, eq))) return `${arg.slice(0, eq + 1)}${CUT}`;
  let out = arg.replace(LONG_TOKEN, CUT);
  if (out.length > MAX_ARG) out = `${out.slice(0, MAX_ARG - 1)}${CUT}`;
  return out;
}

/** A command line safe to show in the dashboard. */
export function commandPreview(argv: readonly string[]): string {
  if (argv.length === 0) return '';
  const parts: string[] = [basename(argv[0])];
  let hideNext = false;
  for (const arg of argv.slice(1, MAX_ARGS + 1)) {
    if (hideNext) {
      parts.push(CUT);
      hideNext = false;
      continue;
    }
    const flag = arg.split('=')[0];
    if (HIDDEN_VALUE_FLAG.test(flag)) {
      // `--token=abc` carries its value inline; `--token abc` in the next argument.
      if (arg.includes('=')) parts.push(`${flag}=${CUT}`);
      else {
        parts.push(arg);
        hideNext = true;
      }
      continue;
    }
    parts.push(previewArg(arg));
  }
  if (argv.length > MAX_ARGS + 1) parts.push(CUT);
  let line = String(redactSecrets(parts.join(' ')));
  if (line.length > MAX_TOTAL) line = `${line.slice(0, MAX_TOTAL - 1)}${CUT}`;
  return line;
}
