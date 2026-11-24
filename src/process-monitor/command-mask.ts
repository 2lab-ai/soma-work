import { redactSecrets } from '@soma/common/logger';
import { splitArgs } from './command-preview';

/**
 * The full command line for the process detail view — every word, with secret values masked.
 *
 * The Processes table shows an allow-list preview (`command-preview.ts`): a known prefix and nothing else. The detail
 * view is what a person opens on purpose to see what one process really runs (Process Explorer's "Command line"), for
 * the task's owner and admins only, so it shows the whole line and masks what a value can hide a secret in:
 *   - JSON — everything between braces or brackets (`--mcp-config {…}` carries MCP servers' env and headers);
 *   - the value of a flag or `NAME=` whose name says secret (`--token x`, `--api-key=x`, `GITHUB_TOKEN=x`, mysql `-px`);
 *   - an HTTP credential (`Authorization: Bearer x`, `Cookie: x`, `Basic x`);
 *   - a URL's password (`https://user:x@host`) and a secret-named query value (`?token=x`);
 *   - every token shape the logger knows plus common provider keys (GitHub, AWS, Google, npm, JWT, `sk-…`);
 *   - any long high-entropy word (20+ characters mixing upper case, lower case and digits; or 48+ hex digits).
 * The process environment is never read. A secret with no shape after a flag whose name says nothing (`--x hunter2`) is
 * the residual this cannot see; the view is the owner's and admins' only for that reason.
 */

export const MASK = '•••';
const MAX_WORD = 300;
const MAX_LINE = 4000;

/** A flag or variable name that says its value is a secret. */
const SECRET_NAME =
  /(pass(word|wd|phrase)?|secret|token|api[-_]?key|apikey|auth|credential|creds?\b|private[-_]?key|access[-_]?key|cookie|bearer|signature|session[-_]?key|webhook)/i;
/** `--name=value`, `-name=value`. */
const FLAG_WITH_VALUE = /^(-{1,2}[A-Za-z][\w.-]*)=(.*)$/s;
/** `NAME=value` (an environment assignment, `env FOO=bar cmd`). */
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
/** A flag on its own (its value is the next word). */
const FLAG = /^-{1,2}[A-Za-z][\w.-]*$/;
/** mysql-family `-p<password>` (the password attached to the flag). */
const MYSQL_PROGRAM = /^(mysql|mysqldump|mysqladmin|mariadb|mariadb-dump)$/;
/** An HTTP header that carries a credential, as its own word (`Authorization:`) or inline. */
const CREDENTIAL_HEADER =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|private-token):?$/i;
const INLINE_HEADER =
  /\b(authorization|proxy-authorization|cookie|x-api-key|api-key|x-auth-token|private-token)(\s*:\s*)(.+)$/gi;
const AUTH_SCHEME_WORD = /^(bearer|basic|token|digest)$/i;
const INLINE_SCHEME = /\b(bearer|basic)(\s+)\S+/gi;
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^\s/@:]+):[^\s/@]+@/gi;
const SECRET_QUERY =
  /([?&;][^=&\s#]*(?:token|key|secret|sig|signature|password|passwd|auth|credential)[^=&\s#]*=)[^&\s#]+/gi;
/** Provider key shapes the logger does not know. */
const PROVIDER_KEYS: readonly RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{16,}\b/g,
  /\bnpm_[A-Za-z0-9]{30,}\b/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\b(?:sk|rk|pk)_(?:live|test)_[0-9A-Za-z]{10,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
];
/**
 * A run that may be a key: base64/url-safe characters, no `/` — a path's parts are separate runs, so
 * `/opt/homebrew/Cellar/node/26.9.0` is never taken for one; a key with `/` in it still has long parts.
 */
const RUN = /[A-Za-z0-9+=_-]{20,}/g;
const HEX_RUN = /\b[0-9a-fA-F]{48,}\b/g;

/** A run of 20+ key characters that mixes upper case, lower case and digits — a generated key, not a word or a path. */
function highEntropy(run: string): boolean {
  return /[a-z]/.test(run) && /[A-Z]/.test(run) && /[0-9]/.test(run);
}

/** Replace every brace or bracket span — JSON — with `{…}` / `[…]`. An unclosed one runs to the end. */
export function maskJson(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch !== '{' && ch !== '[') {
      out += ch;
      i++;
      continue;
    }
    // `[` inside a word (`arr[0]`, a glob `[ab]`) is not JSON; only a span that opens a word or follows `=`/`:` is.
    const prev = i === 0 ? ' ' : text[i - 1];
    if (ch === '[' && !/[\s=:'"]/.test(prev)) {
      out += ch;
      i++;
      continue;
    }
    let depth = 0;
    let j = i;
    for (; j < text.length; j++) {
      const c = text[j];
      if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') {
        depth--;
        if (depth === 0) break;
      }
    }
    out += ch === '{' ? `{${MASK}}` : `[${MASK}]`;
    i = j + 1;
  }
  return out;
}

/** Mask the shapes a single word can carry a secret in (see the module comment). */
function maskWord(word: string): string {
  let w = String(redactSecrets(word));
  for (const re of PROVIDER_KEYS) w = w.replace(re, MASK);
  w = w
    .replace(INLINE_HEADER, (_m, name: string, sep: string) => `${name}${sep}${MASK}`)
    .replace(INLINE_SCHEME, (_m, scheme: string, sp: string) => `${scheme}${sp}${MASK}`)
    .replace(URL_PASSWORD, (_m, head: string) => `${head}:${MASK}@`)
    .replace(SECRET_QUERY, (_m, head: string) => `${head}${MASK}`)
    .replace(HEX_RUN, MASK)
    .replace(RUN, (run) => (highEntropy(run) ? MASK : run));
  return w.length > MAX_WORD ? `${w.slice(0, MAX_WORD - 1)}…` : w;
}

/** Quote a word that holds a space, so exact argv reads back as the arguments it was. */
const quoted = (w: string): string => (/\s/.test(w) ? `'${w.replace(/'/g, `'\\''`)}'` : w);

/**
 * The masked command line. `exact`: `argv` is the real argument vector (Linux `/proc/<pid>/cmdline`), words with spaces
 * are quoted; otherwise it is one `ps args` line (macOS), which has no argument boundaries.
 */
export function maskCommandLine(input: { readonly argv: readonly string[]; readonly exact: boolean }): string {
  const words = input.exact ? input.argv.map(maskJson) : splitArgs(maskJson(input.argv.join(' ')));
  if (words.length === 0) return '';
  const program = (words[0].split('/').pop() ?? '').toLowerCase();
  const out: string[] = [];
  let maskNext = 0;
  for (const raw of words) {
    if (maskNext > 0) {
      maskNext--;
      // `Authorization: Bearer x` — the scheme stays, its value goes.
      if (AUTH_SCHEME_WORD.test(raw)) {
        out.push(raw);
        maskNext = 1;
      } else out.push(MASK);
      continue;
    }
    const flag = FLAG_WITH_VALUE.exec(raw);
    if (flag && SECRET_NAME.test(flag[1])) {
      out.push(`${flag[1]}=${MASK}`);
      continue;
    }
    const assignment = !flag && ASSIGNMENT.exec(raw);
    if (assignment && SECRET_NAME.test(assignment[1])) {
      out.push(`${assignment[1]}=${MASK}`);
      continue;
    }
    if (MYSQL_PROGRAM.test(program) && /^-p.+/.test(raw)) {
      out.push(`-p${MASK}`);
      continue;
    }
    if ((FLAG.test(raw) && SECRET_NAME.test(raw)) || CREDENTIAL_HEADER.test(raw) || AUTH_SCHEME_WORD.test(raw)) {
      out.push(raw);
      maskNext = 1;
      continue;
    }
    out.push(input.exact ? quoted(maskWord(raw)) : maskWord(raw));
  }
  const line = out.join(' ');
  return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE - 1)}…` : line;
}
