// Secret redaction for the `logs` tool. `docker logs` output goes to the model as text, and services print
// credentials into their logs (an SDK client that logs its options object, a connection URL, a key block), so
// without this every log read copies them into the model context and the session transcript.
//
// The MCP servers do not depend on @soma/common, whose logger owns the daemon's redaction set, and the devops
// broker keeps its own (packages/devops-broker/src/scrub.ts). Its credential shapes are repeated here, plus the
// shapes service logs carry. One `logs` call can return a single 1 MB line, so every pattern is linear: each
// start is pinned by a literal or a lookbehind, and nothing quantified is followed by an overlapping quantifier.
// Values are measured by hand-written scanners, and key matching resumes past every scanned value, so no
// character is scanned twice. Secret context (a key waiting for its value, an open quoted value, an open array or
// object, a key block, a YAML value) is carried from line to line as one {@link LineState}.
//
// Governing rule: when the structure is uncertain, prefer over-redaction — hiding extra log text is cheap, leaking
// a secret is not. So a value under a secret key is kept only when it is exactly a redacted form (the marker, or a
// key block's markers around it); anything else there is redacted whole. Brackets and quotes outrank indentation:
// indentation decides only YAML-style content.

export const REDACTED = '<redacted>';

/**
 * Credential shapes, redacted wherever they appear. Bearer runs first: a key=value value stops at whitespace,
 * so `token: Bearer <credential>` would otherwise lose only the word `Bearer`.
 */
const SHAPES: ReadonlyArray<readonly [RegExp, string]> = [
  // RFC 6750 b64token; `<` is outside the set, so `Bearer <redacted>` never matches again.
  [/(Bearer|bearer|BEARER)[ \t]+[A-Za-z0-9._~+/-]+=*/g, `$1 ${REDACTED}`],
  [/gh[opsur]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/github_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/cf[au]t_[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/xox[abpre]-[A-Za-z0-9-]{10,}/g, REDACTED],
  // Email-provider API key: `SG.` and two dot-separated segments.
  [/SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, REDACTED],
  // JWT. `eyJ` is itself in the segment alphabet, so without the lookbehind every `eyJ` inside one long run
  // would start a fresh scan of the rest of it.
  [/(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
];

/**
 * `scheme://user:password@` — the password goes, the user stays. The password runs to the last `@` before the
 * path, so an unescaped `@` inside it is still covered; quotes and `<>` end it, so it cannot reach into the next
 * JSON field and `user:<redacted>@` does not match again.
 */
const URL_USERINFO_RE = /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s:@/"'<>]*):[^\s/"'<>]+@/g;

/**
 * A key and its separator: `key=`, `key: `, `"key": `, `\"key\":` (JSON escaped inside a JSON string),
 * `"key" => ` (Ruby/PHP hashes; `=>` before `=`, or the value would start at `>`), `[key] => ` (PHP print_r)
 * and `user[key]=` (form fields).
 */
const KEY_SEP_RE = /(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]+)(?:\\?["']|\])?[ \t]*(?:=>|[:=])[ \t]*/g;

/** Key names (case-insensitive substring) whose value is a secret. */
const SECRET_KEY_RE = /token|secret|passw(?:or)?d|api[_-]?key|private[_-]?key|connection[_-]?string|authorization/i;

/**
 * `<scheme> <credential>`: the scheme word stays. After an Authorization key any word is a scheme; after another
 * secret key only the common ones are (`token: Bearer <credential>`), so a two-word password is not split.
 */
const AUTH_KEY_RE = /authorization/i;
/**
 * HTTP auth header names (`Authorization`, `Proxy-Authorization`, `WWW-Authenticate`, `Proxy-Authenticate`, ...).
 * After `:` their parameters are quoted (`Digest username="u", response="..."`), so the value is the whole rest
 * of the line, quotes included; only the scheme word stays.
 */
const AUTH_HEADER_KEY_RE = /(?:^|-)(?:authorization|authenticate)$/i;
const AUTH_SCHEME_RE = /^[A-Za-z][A-Za-z0-9-]*$/;
const KNOWN_SCHEME_RE = /^(?:bearer|basic|token|bot|digest|apikey)$/i;

/** An account SID is redacted only as the whole value of a key containing `sid`; the same hex elsewhere stays. */
const SID_KEY_RE = /sid/i;
const ACCOUNT_SID_RE = /^AC[0-9a-f]{32}$/;

/** `input_tokens: 1234` is a count, not a credential. */
const COUNT_KEY_RE = /tokens/i;
const DIGITS_RE = /^[0-9]+$/;

/** Unquoted values that carry no secret: `"passwordRequired": true`. */
const LITERAL_RE = /^(?:true|false|null|undefined|none)$/i;

/** Characters that end an unquoted value after `=`, `=>` or `[key] =`. */
const UNQUOTED_END = new Set([' ', '\t', '\r', '\n', '\f', '\v', ',', ';', '&', '"', "'", '}', ']', ')']);

const KEY_CHAR_RE = /[A-Za-z0-9_.-]/;

/** Trimmed off the end of an unquoted value after `:` (closing punctuation of the structure around it). */
const COLON_VALUE_TAIL = new Set([' ', '\t', '\f', '\v', ',', '}', ']', ')', "'", '\\']);

// Private-key block markers. The type word is optional (RSA, EC, OPENSSH, ENCRYPTED, ...).
const KEY_BLOCK_BEGIN_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g;
const KEY_BLOCK_END_RE = /-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
/** A value the key-block scanner already redacted: its markers around the marker, nothing else. */
const REDACTED_KEY_BLOCK_RE = new RegExp(
  `^-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?:${REDACTED})?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----)?$`,
);

/** A YAML block-scalar indicator ending its line (`|`, `>`, `|-`, `>+`, `|2`, an optional comment): text follows. */
const BLOCK_SCALAR_RE = /[|>](?:[1-9][+-]?|[+-][1-9]?)?[ \t]*(?:#.*)?$/y;

/** `user: svc` — a line opening with its own key: the waiting key above it had no value. */
const SIBLING_KEY_RE = /["']?[A-Za-z0-9_.-]+["']?[ \t]*:(?:[ \t]|$)/y;

/** What may follow a quoted scalar alone on its line: `"abc"`, `"abc",`, `"abc"}`. */
const CLOSING_TAIL_RE = /^[ \t,\]}]*$/;

/**
 * The prefix Docker itself writes before a log line: the `--timestamps` stamp and, in `docker service logs`, the
 * `<task>@<node>    | ` context (either order). It is the only text kept on a line whose content is redacted
 * because a value or key block runs through it.
 */
const TIMESTAMP_PREFIX = String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}) `;
const SWARM_PREFIX = String.raw`[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+ *\| `;
const DOCKER_PREFIX_RE = new RegExp(`^(?:${TIMESTAMP_PREFIX})?(?:${SWARM_PREFIX})?(?:${TIMESTAMP_PREFIX})?`);

/** A quoted secret key alone at the end of a line (`{"AuthToken"`): its separator may open the next line. */
const TRAILING_QUOTED_KEY_RE = /(?:^|[{,])[ \t]*(["'])([A-Za-z0-9_.-]+)\1[ \t]*$/;

/** The separator a waiting quoted key gets on its next line. */
const SEPARATOR_RE = /(?:=>|[:=])[ \t]*/y;

/**
 * A secret-named key (or a `sid` key), the escaping level of its quotes (1 inside a JSON string) and whether its
 * separator is `:` — YAML and prose style, where an unquoted value is the rest of the line, not one token.
 */
interface KeyInfo {
  key: string;
  secret: boolean;
  level: 0 | 1;
  colon: boolean;
}

/**
 * What a line leaves open for the next one. Only one thing can be open at a time. `column` is where a waiting key
 * starts on its line (after Docker's prefix); a `block` is the YAML value under such a key: every line indented
 * deeper than `column` — and, for a `sequence`, every `- ` item at `column` itself. `resume` is the state an open
 * key block, value or collection returns to when it closes (a YAML value it interrupted).
 */
type LineState =
  | { kind: 'none' }
  | { kind: 'keyBlock'; resume: LineState }
  | { kind: 'key'; info: KeyInfo; needsSeparator: boolean; column: number }
  | { kind: 'block'; column: number; sequence: boolean }
  | { kind: 'value'; quote: '"' | "'"; level: 0 | 1; resume: LineState }
  | { kind: 'collection'; depth: number; level: 0 | 1; resume: LineState };

const NONE: LineState = { kind: 'none' };
const KEY_BLOCK: LineState = { kind: 'keyBlock', resume: NONE };

interface ValueSpan {
  from: number;
  to: number;
  quoted: boolean;
  /** The closing quote is not on this line. */
  open: boolean;
  quote: '"' | "'";
  level: 0 | 1;
}

function keyInfo(key: string, level: 0 | 1, colon: boolean): KeyInfo | null {
  if (SECRET_KEY_RE.test(key) || AUTH_HEADER_KEY_RE.test(key)) return { key, secret: true, level, colon };
  return SID_KEY_RE.test(key) ? { key, secret: false, level, colon } : null;
}

/** End of the unquoted value starting at `i`. */
function unquotedEnd(line: string, i: number): number {
  let j = i;
  while (j < line.length && !UNQUOTED_END.has(line[j])) j++;
  return j;
}

/**
 * Whether a `key:` field opens at `k` (after a comma): spaces, then a bare, quoted or `\"`-quoted key and a colon.
 * The text it reads has no comma, so the checks from successive commas never overlap.
 */
function fieldAt(line: string, k: number): boolean {
  let j = k;
  while (line[j] === ' ' || line[j] === '\t') j++;
  const escaped = line[j] === '\\';
  if (escaped) j++;
  const quote = line[j] === '"' || line[j] === "'" ? line[j] : '';
  if (escaped && quote === '') return false;
  if (quote !== '') j++;
  const keyStart = j;
  while (j < line.length && KEY_CHAR_RE.test(line[j])) j++;
  if (j === keyStart) return false;
  if (escaped && line[j++] !== '\\') return false;
  if (quote !== '' && line[j++] !== quote) return false;
  while (line[j] === ' ' || line[j] === '\t') j++;
  return line[j] === ':';
}

/**
 * End of the unquoted value after `:` starting at `i`: the rest of the line, up to an unescaped double quote (the
 * end of a JSON string around it) or a comma that opens another `key:` field, less trailing closing punctuation.
 */
function colonValueEnd(line: string, i: number): number {
  let j = i;
  while (j < line.length && line[j] !== '"' && !(line[j] === ',' && fieldAt(line, j + 1))) j++;
  while (j > i && COLON_VALUE_TAIL.has(line[j - 1])) j--;
  return j;
}

/**
 * Index where the quoted value scanned from `from` ends, or -1 if it runs past the line. At level 0 a backslash
 * escapes the next character. At level 1 (JSON escaped inside a JSON string) the value closes at `\"`: within it
 * an escaped backslash is four backslashes and an escaped quote three, so a quote closes it when the backslashes
 * before it number 1 modulo 4 — and an unescaped quote is the enclosing string ending, which cuts the value off.
 */
function quoteClose(line: string, from: number, quote: string, level: 0 | 1): number {
  if (level === 0) {
    for (let j = from; j < line.length; j += line[j] === '\\' ? 2 : 1) if (line[j] === quote) return j;
    return -1;
  }
  let j = from;
  while (j < line.length) {
    if (line[j] === '"') return j;
    if (line[j] !== '\\') {
      j++;
      continue;
    }
    let k = j;
    while (k < line.length && line[k] === '\\') k++;
    if (line[k] === '"' && (k - j) % 4 === 1) return k - 1;
    if (line[k] === '"' && (k - j) % 2 === 0) return k;
    j = k + 1;
  }
  return -1;
}

/** The scalar value starting at `i`, quotes excluded; unquoted, it ends per the key's separator. */
function valueSpan(line: string, i: number, colon: boolean): ValueSpan {
  const c = line[i];
  if (c === '"' || c === "'") {
    const close = quoteClose(line, i + 1, c, 0);
    return { from: i + 1, to: close < 0 ? line.length : close, quoted: true, open: close < 0, quote: c, level: 0 };
  }
  if (c === '\\' && line[i + 1] === '"') {
    const close = quoteClose(line, i + 2, '"', 1);
    return { from: i + 2, to: close < 0 ? line.length : close, quoted: true, open: close < 0, quote: '"', level: 1 };
  }
  const to = colon ? colonValueEnd(line, i) : unquotedEnd(line, i);
  return { from: i, to, quoted: false, open: false, quote: '"', level: 0 };
}

interface CollectionScan {
  /** Index just past the closing bracket, or where an enclosing JSON string ends; the line's end if open. */
  end: number;
  closed: boolean;
  depth: number;
}

/**
 * Scan an array or object from `from` at bracket depth `depth`, skipping brackets inside strings. A string ends
 * at the end of its line at the latest, so a stray quote cannot keep the collection open past its real close.
 * At level 1 strings are delimited by `\"` (see {@link quoteClose}) and an unescaped quote ends the collection.
 */
function scanCollection(line: string, from: number, depth: number, level: 0 | 1): CollectionScan {
  let quote = '';
  let j = from;
  while (j < line.length) {
    const c = line[j];
    if (level === 0 && quote !== '') {
      if (c === quote) quote = '';
      j += c === '\\' ? 2 : 1;
      continue;
    }
    if (level === 0 && (c === '"' || c === "'")) {
      quote = c;
    } else if (level === 1 && c === '"') {
      return { end: j, closed: true, depth: 0 };
    } else if (level === 1 && c === '\\') {
      let k = j;
      while (k < line.length && line[k] === '\\') k++;
      const run = k - j;
      if (line[k] !== '"') {
        j = k;
        continue;
      }
      if (run % 2 === 0) return { end: k, closed: true, depth: 0 };
      if (quote === '' || run % 4 === 1) quote = quote === '' ? '"' : '';
      j = k + 1;
      continue;
    } else if (quote === '' && (c === '[' || c === '{')) {
      depth++;
    } else if (quote === '' && (c === ']' || c === '}')) {
      depth--;
      if (depth === 0) return { end: j + 1, closed: true, depth: 0 };
    }
    j++;
  }
  return { end: line.length, closed: false, depth };
}

/**
 * `Basic <credential>`: the span of the credential when the value opens with a `scheme` word, else the value.
 * After `:` the credential is the rest of the value; after `=` it is the next token.
 */
function credentialSpan(line: string, span: ValueSpan, scheme: RegExp, colon: boolean): ValueSpan {
  if (span.quoted) return span;
  const wordEnd = Math.min(unquotedEnd(line, span.from), span.to);
  if (!scheme.test(line.slice(span.from, wordEnd))) return span;
  let j = wordEnd;
  while (line[j] === ' ' || line[j] === '\t') j++;
  if (j === wordEnd) return span;
  const to = colon ? span.to : unquotedEnd(line, j);
  return to > j ? { ...span, from: j, to } : span;
}

interface Taken {
  /** End of the scanned value: key matching resumes here, so no character is scanned twice. */
  end: number;
  /** The span to replace with the marker, or null to keep the value. */
  redact: { from: number; to: number } | null;
  /** What the value leaves open when it runs past the line. */
  next: LineState;
}

/** The value of key `info` starting at `at`: a whole array or object under a secret key, else a scalar. */
function takeValue(line: string, at: number, info: KeyInfo): Taken {
  const c = line[at];
  if (c === '[' || c === '{') {
    // Under a `sid` key only the SID itself is redacted; the collection's own keys are matched as usual.
    if (!info.secret) return { end: at, redact: null, next: NONE };
    const scan = scanCollection(line, at, 0, info.level);
    if (!scan.closed) {
      const next: LineState = { kind: 'collection', depth: scan.depth, level: info.level, resume: NONE };
      return { end: scan.end, redact: { from: at, to: scan.end }, next };
    }
    // After `:` the value is the rest of the line, as for a scalar: text after the brackets goes with them.
    const to = info.colon ? Math.max(scan.end, colonValueEnd(line, scan.end)) : scan.end;
    return { end: to, redact: { from: at, to }, next: NONE };
  }
  let span = valueSpan(line, at, info.colon);
  if (info.colon && !span.quoted && AUTH_HEADER_KEY_RE.test(info.key)) {
    if (!LITERAL_RE.test(line.slice(span.from, span.to))) span = headerCredentialSpan(line, at);
  } else if (info.secret) {
    span = credentialSpan(line, span, AUTH_KEY_RE.test(info.key) ? AUTH_SCHEME_RE : KNOWN_SCHEME_RE, info.colon);
  }
  const value = line.slice(span.from, span.to);
  const keep: Taken = { end: span.to, redact: null, next: NONE };
  if (isRedactedForm(value)) return keep;
  if (!info.secret) return ACCOUNT_SID_RE.test(value) ? { ...keep, redact: span } : keep;
  if (value.length === 0 && !span.open) return keep;
  if (!span.quoted && LITERAL_RE.test(value)) return keep;
  if (DIGITS_RE.test(value) && COUNT_KEY_RE.test(info.key)) return keep;
  const next: LineState = span.open ? { kind: 'value', quote: span.quote, level: span.level, resume: NONE } : NONE;
  return { end: span.to, redact: span, next };
}

/** An auth header's value from `at`: the rest of the line after its scheme word (or all of it, with none). */
function headerCredentialSpan(line: string, at: number): ValueSpan {
  const wordEnd = unquotedEnd(line, at);
  let from = at;
  if (wordEnd > at && AUTH_SCHEME_RE.test(line.slice(at, wordEnd))) {
    let j = wordEnd;
    while (line[j] === ' ' || line[j] === '\t') j++;
    if (j > wordEnd && j < line.length) from = j;
  }
  return { from, to: line.length, quoted: false, open: false, quote: '"', level: 0 };
}

/** Exactly a redacted form: the marker, or a key block's markers around it. A marker followed by more is not. */
function isRedactedForm(value: string): boolean {
  return value === REDACTED || REDACTED_KEY_BLOCK_RE.test(value);
}

/** A YAML comment (`#` after whitespace) at `i`: no value, and no content of one. */
function isComment(line: string, i: number): boolean {
  return line[i] === '#' && (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t');
}

/** Replace `[from, to)` with the marker; an empty span gets none. */
function marked(line: string, pos: number, redact: { from: number; to: number }): string {
  return line.slice(pos, redact.from) + (redact.to > redact.from ? REDACTED : '');
}

interface Redacted {
  text: string;
  next: LineState;
}

/** Where the key at `index` starts, its opening quote included. */
function keyColumn(line: string, index: number): number {
  let col = index;
  if (line[col - 1] === '"' || line[col - 1] === "'") col--;
  if (line[col - 1] === '\\') col--;
  return col;
}

/**
 * Replace the values of secret keys (and SIDs under `sid` keys) in one line. `base` is where `line` starts after
 * Docker's prefix, so a waiting key's column is measured on the whole line.
 */
function redactKeyValues(line: string, base: number): Redacted {
  let out = '';
  let pos = 0;
  KEY_SEP_RE.lastIndex = 0;
  for (let m = KEY_SEP_RE.exec(line); m !== null; m = KEY_SEP_RE.exec(line)) {
    const info = keyInfo(m[1], m[0].includes('\\"') ? 1 : 0, m[0].includes(':'));
    if (info === null) continue;
    const at = m.index + m[0].length;
    const column = base + keyColumn(line, m.index);
    const waiting: LineState = { kind: 'key', info, needsSeparator: false, column };
    if (at === line.length) return { text: out + line.slice(pos), next: waiting };
    // A comment is no value, and it goes too: `token: #A1B2` may be a value written after a space.
    if (isComment(line, at)) return { text: out + line.slice(pos, at) + REDACTED, next: waiting };
    BLOCK_SCALAR_RE.lastIndex = at;
    if (info.secret && BLOCK_SCALAR_RE.test(line)) {
      return { text: out + line.slice(pos), next: { kind: 'block', column, sequence: false } };
    }
    const taken = takeValue(line, at, info);
    if (taken.redact !== null) {
      out += marked(line, pos, taken.redact);
      pos = taken.redact.to;
    }
    if (taken.next.kind !== 'none') return { text: out + line.slice(pos), next: taken.next };
    KEY_SEP_RE.lastIndex = taken.end;
  }
  const text = out + line.slice(pos);
  const trailing = TRAILING_QUOTED_KEY_RE.exec(line);
  const info = trailing === null ? null : keyInfo(trailing[2], 0, true);
  if (trailing === null || info === null) return { text, next: NONE };
  const column = base + trailing.index + trailing[0].indexOf(trailing[1]);
  return { text, next: { kind: 'key', info, needsSeparator: true, column } };
}

/** Credential shapes and URL passwords, wherever they are (see {@link SHAPES} for the order). */
function redactShapes(line: string): string {
  let out = line;
  for (const [re, replacement] of SHAPES) out = out.replace(re, replacement);
  return out.replace(URL_USERINFO_RE, `$1:${REDACTED}@`);
}

/** Shapes, then key/value pairs. */
function redactInline(line: string, base: number): Redacted {
  return redactKeyValues(redactShapes(line), base);
}

/** Key blocks that open on this line: everything between the markers goes, and an unclosed one stays open. */
function redactKeyBlocks(line: string): { text: string; open: boolean } {
  let out = '';
  let pos = 0;
  KEY_BLOCK_BEGIN_RE.lastIndex = 0;
  for (let begin = KEY_BLOCK_BEGIN_RE.exec(line); begin !== null; begin = KEY_BLOCK_BEGIN_RE.exec(line)) {
    const afterBegin = begin.index + begin[0].length;
    KEY_BLOCK_END_RE.lastIndex = afterBegin;
    const end = KEY_BLOCK_END_RE.exec(line);
    if (end === null) {
      return { text: out + line.slice(pos, afterBegin) + (afterBegin < line.length ? REDACTED : ''), open: true };
    }
    out += line.slice(pos, afterBegin) + (end.index > afterBegin ? REDACTED : '') + end[0];
    pos = end.index + end[0].length;
    KEY_BLOCK_BEGIN_RE.lastIndex = pos;
  }
  return { text: out + line.slice(pos), open: false };
}

/** A line (or the rest of one, starting at `base`) with nothing open from the line before. */
function redactFresh(text: string, base: number): Redacted {
  const blocks = redactKeyBlocks(text);
  const inline = redactInline(blocks.text, base);
  return { text: inline.text, next: blocks.open ? KEY_BLOCK : inline.next };
}

/**
 * How a line continues what the previous line left open: `lead` is its output so far, and `rest` (starting at
 * `base` in the line) still needs a fresh pass — null when the open state consumed the whole line. `next` is the
 * state after the line unless the fresh pass opens one of its own.
 */
interface Continued {
  lead: string;
  rest: string | null;
  base: number;
  next: LineState;
}

function consumed(lead: string, next: LineState): Continued {
  return { lead, rest: null, base: 0, next };
}

function restOf(body: string, lead: string, from: number): Continued {
  return { lead, rest: body.slice(from), base: from, next: NONE };
}

function indentOf(body: string): number {
  let i = 0;
  while (body[i] === ' ' || body[i] === '\t') i++;
  return i;
}

/** A YAML sequence item (`- x`, or a bare `-`) at `i`. */
function isItem(body: string, i: number): boolean {
  return body[i] === '-' && (i + 1 === body.length || body[i + 1] === ' ' || body[i + 1] === '\t');
}

/**
 * One line of a YAML value under a secret key: indentation and `- ` markers stay, the content goes. A quoted
 * scalar alone on the line keeps its quotes and closing punctuation. A key block, flow collection or quoted value
 * left open here is followed by its own state past any dedent, which then resumes this value.
 */
function blockLine(body: string, indent: number, state: LineState): Continued {
  let i = indent;
  while (isItem(body, i)) {
    i++;
    while (body[i] === ' ' || body[i] === '\t') i++;
  }
  if (i === body.length || (body.length - i === REDACTED.length && body.startsWith(REDACTED, i))) {
    return consumed(body, state);
  }
  const kept = body.slice(0, i);
  KEY_BLOCK_BEGIN_RE.lastIndex = i;
  const begin = KEY_BLOCK_BEGIN_RE.exec(body);
  if (begin !== null) {
    KEY_BLOCK_END_RE.lastIndex = begin.index + begin[0].length;
    if (KEY_BLOCK_END_RE.exec(body) === null) return consumed(kept + REDACTED, { kind: 'keyBlock', resume: state });
  }
  const c = body[i];
  if (c === '[' || c === '{') {
    const scan = scanCollection(body, i, 0, 0);
    if (!scan.closed) {
      return consumed(kept + REDACTED, { kind: 'collection', depth: scan.depth, level: 0, resume: state });
    }
  } else if (c === '"' || c === "'") {
    const close = quoteClose(body, i + 1, c, 0);
    if (close < 0) return consumed(kept + REDACTED, { kind: 'value', quote: c, level: 0, resume: state });
    if (CLOSING_TAIL_RE.test(body.slice(close + 1))) {
      const value = body.slice(i + 1, close);
      const inner = value.length === 0 || value === REDACTED ? value : REDACTED;
      return consumed(kept + c + inner + body.slice(close), state);
    }
  }
  return consumed(kept + REDACTED, state);
}

/**
 * The value of a waiting key on a later line, at `i`. Key blocks and credential shapes are found first: a BEGIN
 * marker is the value and opens key-block state, and a shape is redacted whole before the value is measured.
 */
function waitingValue(body: string, i: number, info: KeyInfo): Continued {
  const blocks = redactKeyBlocks(body);
  if (blocks.open) return consumed(redactInline(blocks.text, 0).text, KEY_BLOCK);
  const text = redactShapes(blocks.text);
  const taken = takeValue(text, i, info);
  if (taken.redact === null) return restOf(text, '', 0);
  const lead = marked(text, 0, taken.redact);
  if (taken.next.kind !== 'none') return consumed(lead, taken.next);
  return restOf(text, lead, taken.redact.to);
}

function continueState(body: string, state: LineState): Continued {
  const whole = (next: LineState): Continued => consumed(body.length > 0 ? REDACTED : '', next);
  switch (state.kind) {
    case 'none':
      return restOf(body, '', 0);
    case 'keyBlock': {
      // Only Docker's prefix is kept before END: anything else on the line is the block's last line.
      KEY_BLOCK_END_RE.lastIndex = 0;
      const end = KEY_BLOCK_END_RE.exec(body);
      if (end === null) return whole(state);
      return {
        ...restOf(body, (end.index > 0 ? REDACTED : '') + end[0], end.index + end[0].length),
        next: state.resume,
      };
    }
    case 'value': {
      const close = quoteClose(body, 0, state.quote, state.level);
      if (close < 0) return whole(state);
      return { ...restOf(body, close > 0 ? REDACTED : '', close), next: state.resume };
    }
    case 'collection': {
      const scan = scanCollection(body, 0, state.depth, state.level);
      if (!scan.closed) return whole({ ...state, depth: scan.depth });
      return { ...restOf(body, scan.end > 0 ? REDACTED : '', scan.end), next: state.resume };
    }
    case 'block': {
      // Blank and comment lines stay inside the value; a line at the key's column or shallower ends it.
      const indent = indentOf(body);
      if (indent === body.length) return consumed(body, state);
      if (isComment(body, indent)) return consumed(body.slice(0, indent) + REDACTED, state);
      if (indent > state.column || (state.sequence && indent === state.column && isItem(body, indent))) {
        return blockLine(body, indent, state);
      }
      return restOf(body, '', 0);
    }
    case 'key': {
      // Blank and comment lines do not count. A value opening with a bracket or quote is followed by its structure,
      // whatever its indentation. Otherwise a deeper-indented line (or a `- ` item at the key's column) opens a YAML
      // value, and the first other line with content carries the value or, opening with its own key, ends the wait.
      let i = indentOf(body);
      if (i === body.length) return consumed(body, state);
      if (isComment(body, i)) return consumed(body.slice(0, i) + REDACTED, state);
      const structured = body[i] === '[' || body[i] === '{' || body[i] === '"' || body[i] === "'";
      if (!state.needsSeparator && !structured) {
        if (i > state.column) return blockLine(body, i, { kind: 'block', column: state.column, sequence: false });
        if (i === state.column && isItem(body, i)) {
          return blockLine(body, i, { kind: 'block', column: state.column, sequence: true });
        }
        SIBLING_KEY_RE.lastIndex = i;
        if (SIBLING_KEY_RE.test(body)) return restOf(body, '', 0);
      } else if (state.needsSeparator) {
        SEPARATOR_RE.lastIndex = i;
        const sep = SEPARATOR_RE.exec(body);
        if (sep === null) return restOf(body, '', 0);
        i += sep[0].length;
        const info = { ...state.info, colon: sep[0].includes(':') };
        if (i === body.length) return consumed(body, { ...state, info, needsSeparator: false });
        return waitingValue(body, i, info);
      }
      return waitingValue(body, i, state.info);
    }
  }
}

function redactLine(line: string, state: LineState): Redacted {
  const prefix = DOCKER_PREFIX_RE.exec(line)?.[0] ?? '';
  const body = line.slice(prefix.length);
  const cont = continueState(body, state);
  if (cont.rest === null) return { text: prefix + cont.lead, next: cont.next };
  const fresh = redactFresh(cont.rest, cont.base);
  return { text: prefix + cont.lead + fresh.text, next: fresh.next.kind === 'none' ? cont.next : fresh.next };
}

/**
 * Redact common secret shapes in `docker logs` output: credential shapes, URL passwords, values of secret-named
 * keys (whole arrays and objects included) and private-key blocks. Key names, markers, Docker's line prefixes,
 * line breaks and every other byte stay, so the output reads like the original log. A value, collection or key
 * block that continues onto later lines is redacted there too, to the end of the output if it never closes; a
 * secret key whose value is not on its line takes the next line with content, or — indented deeper, or a `- `
 * list at its own indent, or after a block-scalar indicator — every line of that YAML value. One pass, linear in
 * the output's length. Idempotent.
 */
export function redactLogSecrets(text: string): string {
  let state: LineState = NONE;
  return text
    .split('\n')
    .map((raw) => {
      const cr = raw.endsWith('\r') ? '\r' : '';
      const line = redactLine(cr ? raw.slice(0, -1) : raw, state);
      state = line.next;
      return line.text + cr;
    })
    .join('\n');
}
