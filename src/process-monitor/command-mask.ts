import { redactSecrets } from '@soma/common/logger';
import { splitArgs } from './command-preview';

/**
 * The full command line for the process detail view — every word, with secret values masked.
 *
 * The Processes table shows an allow-list preview (`command-preview.ts`): a known prefix and nothing else. The detail
 * view is what a person opens on purpose to see what one process really runs (Process Explorer's "Command line"), for
 * the task's owner and admins only, so it shows the whole line and masks what a value can hide a secret in:
 *   - JSON — everything between braces or brackets (`--mcp-config {…}` carries MCP servers' env and headers);
 *   - the value of a flag or `NAME=` whose name says secret (`--token x`, `--api-key=x`, `GITHUB_TOKEN=x`, mysql `-px`),
 *     or a program's own credential flag (curl `-u user:x`); on a space-joined `ps` line, a secret flag's value runs to
 *     the next option, since ps lost where the argument ended (`--pass correct horse battery`);
 *   - an HTTP credential (`Authorization: Bearer x`, `Authorization:Bearer x`, `Cookie: x`, `Basic x`);
 *   - a URL's password (`https://user:x@host`) and a secret-named query value (`?token=x`);
 *   - every token shape the logger knows plus common provider keys (GitHub, AWS, Google, npm, JWT, `sk-…`);
 *   - any long high-entropy word (20+ characters mixing upper case, lower case and digits; or 48+ hex digits).
 * The process environment is never read. A secret with no shape after a flag whose name says nothing (`--x hunter2`) is
 * the residual this cannot see; the view is the owner's and admins' only for that reason.
 */

export const MASK = '•••';
const MAX_WORD = 300;
const MAX_LINE = 4000;
/**
 * What the masker reads at most — a word before its regexes, the line before its split: a crafted argument cannot make
 * a pattern work in proportion to its length squared on the daemon's thread. What lies past it is cut, not shown.
 */
const MAX_WORD_INPUT = 2 * MAX_WORD;
const MAX_INPUT = 4 * MAX_LINE;
const MAX_ARGS = 400;

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
/**
 * Flags whose value is a credential for one program only (elsewhere `-u` and `-p` mean other things): curl's
 * `user:password`, sshpass's password. Separate (`-u x`), `=`-joined (`--user=x`) or attached (`-ux`).
 */
const PROGRAM_SECRET_FLAGS: Readonly<Record<string, readonly string[]>> = {
  curl: ['-u', '--user', '-U', '--proxy-user'],
  sshpass: ['-p'],
};
/** Words that run the next word as the command (`env A=1 curl …`, `sudo curl …`). */
const COMMAND_WRAPPERS = new Set(['env', 'sudo', 'nohup', 'exec', 'time', 'nice', 'command', 'xargs']);
/** An HTTP header that carries a credential, as its own word (`Authorization:`) or inline. */
const CREDENTIAL_HEADER =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|private-token):?$/i;
const INLINE_HEADER =
  /\b(authorization|proxy-authorization|cookie|x-api-key|api-key|x-auth-token|private-token)(\s*:\s*)(.+)$/gi;
/**
 * A credential header written into a word, no space after its colon: `Authorization:Bearer`, `Cookie:a=b;`,
 * `--header=Authorization:`, `-HAuthorization:Basic`. No word boundary before the name (`-HAuthorization`).
 */
const HEADER_IN_WORD =
  /(proxy-authorization|authorization|set-cookie|cookie|x-api-key|api-key|x-auth-token|private-token)(\s*:)(.*)$/is;
const AUTH_SCHEME_WORD = /^(bearer|basic|token|digest)$/i;
/** A word that opens a URL (where a header's unquoted value ends). */
const URL_START = /^[a-z][a-z0-9+.-]*:\/\//i;
const INLINE_SCHEME = /\b(bearer|basic)(\s+)\S+/gi;
/** `scheme://user:password@` — the user may be empty (`redis://:password@host`). */
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^\s/@:]*):[^\s/@]+@/gi;
/** A shell word that separates commands (a `bash -c` line is read word by word). */
const SHELL_SEPARATOR = /^(;|&&|\|\||\||&)$/;
/** A query parameter (`?name=value`, `&name=value`): masked when its name says secret. Bounded name, linear scan. */
const QUERY_PARAM = /([?&;])([^=&\s#?;]{1,64})=([^&\s#;]*)/g;
const SECRET_QUERY_NAME = /token|key|secret|sig|signature|password|passwd|auth|credential/i;
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

/**
 * Replace every brace or bracket span — JSON — with `{…}` / `[…]`. A delimiter inside a JSON string (`"}"`, an escaped
 * quote) does not end the span. An unclosed span, or an unclosed string, runs to the end.
 */
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
    let inString = false;
    let escaped = false;
    let j = i;
    for (; j < text.length; j++) {
      const c = text[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === '{' || c === '[') depth++;
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
  let w = String(redactSecrets(word.length > MAX_WORD_INPUT ? word.slice(0, MAX_WORD_INPUT) : word));
  for (const re of PROVIDER_KEYS) w = w.replace(re, MASK);
  w = w
    .replace(INLINE_HEADER, (_m, name: string, sep: string) => `${name}${sep}${MASK}`)
    .replace(INLINE_SCHEME, (_m, scheme: string, sp: string) => `${scheme}${sp}${MASK}`)
    .replace(URL_PASSWORD, (_m, head: string) => `${head}:${MASK}@`)
    .replace(QUERY_PARAM, (m, sep: string, name: string) =>
      SECRET_QUERY_NAME.test(name) ? `${sep}${name}=${MASK}` : m,
    )
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
  const words = input.exact
    ? input.argv.slice(0, MAX_ARGS).map((a) => maskJson(a.length > MAX_INPUT ? a.slice(0, MAX_INPUT) : a))
    : splitArgs(maskJson(input.argv.join(' ').slice(0, MAX_INPUT))).slice(0, MAX_ARGS);
  if (words.length === 0) return '';
  // The program of the command a word belongs to: the first word, or the first after a shell separator
  // (`cd /w && curl -u …`), past `env`/`sudo` and `NAME=value` prefixes.
  let program = '';
  let expectCmd = true;
  const out: string[] = [];
  // The value after a secret flag, a credential header or an auth scheme word: one word — or, when it opens with a
  // quote, every word up to the one that closes it (`--cookie "a=b; sid=x"`, `"--password=a b"`). Some values run on
  // (`runOn`) to the next flag, URL or shell separator: a header's (`-H Cookie: a=b; sid=x https://…`, its scheme
  // `Bearer` left in view), and a secret flag's on a space-joined `ps` line, which has lost the argument's bounds
  // (`--pass correct horse battery staple`).
  let value: { header: boolean; closing: string; schemeSeen: boolean; runOn: boolean } | null = null;
  // A secret flag's value when it is not quoted: one argument in exact argv; on a joined line, up to the next option.
  const flagValue = (closing: string) => ({ header: false, closing, schemeSeen: true, runOn: !input.exact });
  for (const raw of words) {
    const atCmd = expectCmd;
    expectCmd = SHELL_SEPARATOR.test(raw) || /[;&|]$/.test(raw);
    if (value) {
      const bare = raw.replace(/^["']/, '');
      if (
        !value.closing &&
        (SHELL_SEPARATOR.test(raw) || (value.runOn && (raw.startsWith('-') || URL_START.test(bare))))
      ) {
        value = null;
      } else {
        if (value.header && !value.schemeSeen && AUTH_SCHEME_WORD.test(bare.replace(/["']$/, ''))) {
          value.schemeSeen = true;
          out.push(raw);
          continue;
        }
        const opens = !value.closing && /^["']/.test(raw) ? raw[0] : '';
        const closing = value.closing || opens;
        const ends = closing !== '' && raw.length > (opens ? 1 : 0) && raw.endsWith(closing);
        out.push(`${opens}${MASK}${ends ? closing : ''}`);
        // A word that ends a shell command (`abc;`) ends an unquoted flag value too — not a header's (`a=b; sid=x`).
        if (ends || (!closing && (!value.runOn || (!value.header && /[;&|]$/.test(raw))))) value = null;
        else if (opens) value.closing = opens;
        continue;
      }
    }
    // ps keeps the quotes a shell command line had (`-H "Authorization: Bearer x"`): a word is matched without its
    // opening quote, and keeps it.
    const lead = /^["']/.test(raw) ? raw[0] : '';
    const word = lead ? raw.slice(1) : raw;
    // The word's own opening quote closes in it (`"--password=x"`), or the value runs on to its close.
    const leadClosed = lead !== '' && word.length > 0 && word.endsWith(lead);
    /** The quote a secret value is still inside after this word: the word's own, else one opening the value. */
    const openQuote = (v: string): string => {
      if (lead) return leadClosed ? '' : lead;
      return /^["']/.test(v) && !(v.length > 1 && v.endsWith(v[0])) ? v[0] : '';
    };
    if (atCmd && !expectCmd) {
      const base = (word.split('/').pop() ?? '').toLowerCase();
      if (COMMAND_WRAPPERS.has(base) || ASSIGNMENT.test(word) || word.startsWith('-')) expectCmd = true;
      else program = base;
    }
    const flag = FLAG_WITH_VALUE.exec(word);
    if (flag && SECRET_NAME.test(flag[1])) {
      out.push(`${lead}${flag[1]}=${MASK}${leadClosed ? lead : ''}`);
      // `--cookie="a=b; sid=x"`, `"--password=two words"`: the quoted value runs on to its close; unquoted on a
      // joined line, up to the next option — unless the word ended a shell command.
      const q = openQuote(flag[2]);
      if (q) value = flagValue(q);
      else if (!leadClosed && !input.exact && !/[;&|]$/.test(word)) value = flagValue('');
      continue;
    }
    const assignment = !flag && ASSIGNMENT.exec(word);
    if (assignment && SECRET_NAME.test(assignment[1])) {
      out.push(`${lead}${assignment[1]}=${MASK}${leadClosed ? lead : ''}`);
      // Only a quote carries an assignment's value on: what follows `TOKEN=x` is the command it is for.
      const q = openQuote(assignment[2]);
      if (q) value = { header: false, closing: q, schemeSeen: true, runOn: false };
      continue;
    }
    // Not a secret flag or variable as a whole: an exact argument with spaces in it is a command of its own
    // (`bash -c 'client --password=x; …'`), masked as one line, word by word, then quoted back.
    if (input.exact && /\s/.test(raw)) {
      out.push(quoted(maskCommandLine({ argv: [raw], exact: false })));
      continue;
    }
    if (MYSQL_PROGRAM.test(program) && /^-p.+/.test(word)) {
      out.push(`${lead}-p${MASK}`);
      continue;
    }
    const own = PROGRAM_SECRET_FLAGS[program];
    if (own) {
      // One word: `user:password`, a password.
      if (own.includes(word)) {
        out.push(raw);
        value = { header: false, closing: '', schemeSeen: true, runOn: false };
        continue;
      }
      const joinedFlag = own.find((f) => f.startsWith('--') && word.startsWith(`${f}=`));
      if (joinedFlag) {
        out.push(`${lead}${joinedFlag}=${MASK}`);
        continue;
      }
      const attached = own.find((f) => !f.startsWith('--') && word.length > f.length && word.startsWith(f));
      if (attached) {
        out.push(`${lead}${attached}${MASK}`);
        continue;
      }
    }
    if (CREDENTIAL_HEADER.test(word)) {
      out.push(raw);
      value = { header: true, closing: lead, schemeSeen: false, runOn: true };
      continue;
    }
    const inWord = HEADER_IN_WORD.exec(word);
    if (inWord) {
      // The scheme stays in view (`Authorization:Bearer`), anything else after the colon is the value. Unless the
      // word's own quote closes it, the value runs on into the next words, like a header's value after a space.
      const closed = lead !== '' && word.endsWith(lead);
      const after = closed ? inWord[3].slice(0, -1) : inWord[3];
      const scheme = AUTH_SCHEME_WORD.test(after);
      const head = word.slice(0, inWord.index);
      const shown = after === '' || scheme ? after : MASK;
      out.push(`${lead}${head ? maskWord(head) : ''}${inWord[1]}${inWord[2]}${shown}${closed ? lead : ''}`);
      if (!closed) value = { header: true, closing: lead, schemeSeen: after !== '', runOn: true };
      continue;
    }
    if (FLAG.test(word) && SECRET_NAME.test(word)) {
      out.push(raw);
      value = flagValue('');
      continue;
    }
    if (AUTH_SCHEME_WORD.test(word)) {
      out.push(raw);
      value = { header: false, closing: '', schemeSeen: true, runOn: false };
      continue;
    }
    out.push(input.exact ? quoted(maskWord(raw)) : maskWord(raw));
  }
  const line = out.join(' ');
  return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE - 1)}…` : line;
}
