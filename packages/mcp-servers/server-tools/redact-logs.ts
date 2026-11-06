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
// object, a key block) is carried from line to line as one {@link LineState}.

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

/** `Authorization: <scheme> <credential>`: the scheme word stays. */
const AUTH_KEY_RE = /authorization/i;
const AUTH_SCHEME_RE = /^[A-Za-z][A-Za-z0-9-]*$/;

/** An account SID is redacted only as the whole value of a key containing `sid`; the same hex elsewhere stays. */
const SID_KEY_RE = /sid/i;
const ACCOUNT_SID_RE = /^AC[0-9a-f]{32}$/;

/** `input_tokens: 1234` is a count, not a credential. */
const COUNT_KEY_RE = /tokens/i;
const DIGITS_RE = /^[0-9]+$/;

/** Unquoted values that carry no secret: `"passwordRequired": true`. */
const LITERAL_RE = /^(?:true|false|null|undefined|none)$/i;

/** Characters that end an unquoted value. */
const UNQUOTED_END = new Set([' ', '\t', '\r', '\n', '\f', '\v', ',', ';', '&', '"', "'", '}', ']', ')']);

// Private-key block markers. The type word is optional (RSA, EC, OPENSSH, ENCRYPTED, ...).
const KEY_BLOCK_BEGIN_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g;
const KEY_BLOCK_END_RE = /-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

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

/** A secret-named key (or a `sid` key) and the escaping level of its quotes: 1 inside a JSON string. */
interface KeyInfo {
  key: string;
  secret: boolean;
  level: 0 | 1;
}

/** What a line leaves open for the next one. Only one thing can be open at a time. */
type LineState =
  | { kind: 'none' }
  | { kind: 'keyBlock' }
  | { kind: 'key'; info: KeyInfo; needsSeparator: boolean }
  | { kind: 'value'; quote: '"' | "'"; level: 0 | 1 }
  | { kind: 'collection'; depth: number; level: 0 | 1 };

const NONE: LineState = { kind: 'none' };
const KEY_BLOCK: LineState = { kind: 'keyBlock' };

interface ValueSpan {
  from: number;
  to: number;
  quoted: boolean;
  /** The closing quote is not on this line. */
  open: boolean;
  quote: '"' | "'";
  level: 0 | 1;
}

function keyInfo(key: string, level: 0 | 1): KeyInfo | null {
  if (SECRET_KEY_RE.test(key)) return { key, secret: true, level };
  return SID_KEY_RE.test(key) ? { key, secret: false, level } : null;
}

/** End of the unquoted value starting at `i`. */
function unquotedEnd(line: string, i: number): number {
  let j = i;
  while (j < line.length && !UNQUOTED_END.has(line[j])) j++;
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

/** The scalar value starting at `i`, quotes excluded. */
function valueSpan(line: string, i: number): ValueSpan {
  const c = line[i];
  if (c === '"' || c === "'") {
    const close = quoteClose(line, i + 1, c, 0);
    return { from: i + 1, to: close < 0 ? line.length : close, quoted: true, open: close < 0, quote: c, level: 0 };
  }
  if (c === '\\' && line[i + 1] === '"') {
    const close = quoteClose(line, i + 2, '"', 1);
    return { from: i + 2, to: close < 0 ? line.length : close, quoted: true, open: close < 0, quote: '"', level: 1 };
  }
  return { from: i, to: unquotedEnd(line, i), quoted: false, open: false, quote: '"', level: 0 };
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

/** `Basic <credential>` after an Authorization key: the span of the credential, or the whole value. */
function authCredentialSpan(line: string, span: ValueSpan): ValueSpan {
  if (span.quoted || !AUTH_SCHEME_RE.test(line.slice(span.from, span.to))) return span;
  let j = span.to;
  while (line[j] === ' ' || line[j] === '\t') j++;
  if (j === span.to) return span;
  const to = unquotedEnd(line, j);
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
    const next: LineState = scan.closed ? NONE : { kind: 'collection', depth: scan.depth, level: info.level };
    return { end: scan.end, redact: { from: at, to: scan.end }, next };
  }
  let span = valueSpan(line, at);
  if (info.secret && AUTH_KEY_RE.test(info.key)) span = authCredentialSpan(line, span);
  const value = line.slice(span.from, span.to);
  const keep: Taken = { end: span.to, redact: null, next: NONE };
  if (value.startsWith(REDACTED)) return keep;
  if (!info.secret) return ACCOUNT_SID_RE.test(value) ? { ...keep, redact: span } : keep;
  if (value.length === 0 && !span.open) return keep;
  if (!span.quoted && LITERAL_RE.test(value)) return keep;
  if (DIGITS_RE.test(value) && COUNT_KEY_RE.test(info.key)) return keep;
  const next: LineState = span.open ? { kind: 'value', quote: span.quote, level: span.level } : NONE;
  return { end: span.to, redact: span, next };
}

/** Replace `[from, to)` with the marker; an empty span gets none. */
function marked(line: string, pos: number, redact: { from: number; to: number }): string {
  return line.slice(pos, redact.from) + (redact.to > redact.from ? REDACTED : '');
}

interface Redacted {
  text: string;
  next: LineState;
}

/** Replace the values of secret keys (and SIDs under `sid` keys) in one line. */
function redactKeyValues(line: string): Redacted {
  let out = '';
  let pos = 0;
  KEY_SEP_RE.lastIndex = 0;
  for (let m = KEY_SEP_RE.exec(line); m !== null; m = KEY_SEP_RE.exec(line)) {
    const info = keyInfo(m[1], m[0].includes('\\"') ? 1 : 0);
    if (info === null) continue;
    const at = m.index + m[0].length;
    if (at === line.length) return { text: out + line.slice(pos), next: { kind: 'key', info, needsSeparator: false } };
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
  const info = trailing === null ? null : keyInfo(trailing[2], 0);
  return { text, next: info === null ? NONE : { kind: 'key', info, needsSeparator: true } };
}

/** Shapes, then URL userinfo, then key/value pairs (see {@link SHAPES} for why the order matters). */
function redactInline(line: string): Redacted {
  let out = line;
  for (const [re, replacement] of SHAPES) out = out.replace(re, replacement);
  out = out.replace(URL_USERINFO_RE, `$1:${REDACTED}@`);
  return redactKeyValues(out);
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

/** A line (or the rest of one) with nothing open from the line before. */
function redactFresh(text: string): Redacted {
  const blocks = redactKeyBlocks(text);
  const inline = redactInline(blocks.text);
  return { text: inline.text, next: blocks.open ? KEY_BLOCK : inline.next };
}

/** How the line's content continues what the previous line left open. `rest` is null when it is all consumed. */
interface Continued {
  lead: string;
  rest: number | null;
  next: LineState;
}

function continueState(body: string, state: LineState): Continued {
  const whole = (next: LineState): Continued => ({ lead: body.length > 0 ? REDACTED : '', rest: null, next });
  switch (state.kind) {
    case 'none':
      return { lead: '', rest: 0, next: NONE };
    case 'keyBlock': {
      // Only Docker's prefix is kept before END: anything else on the line is the block's last line.
      KEY_BLOCK_END_RE.lastIndex = 0;
      const end = KEY_BLOCK_END_RE.exec(body);
      if (end === null) return whole(state);
      return { lead: (end.index > 0 ? REDACTED : '') + end[0], rest: end.index + end[0].length, next: NONE };
    }
    case 'value': {
      const close = quoteClose(body, 0, state.quote, state.level);
      if (close < 0) return whole(state);
      return { lead: close > 0 ? REDACTED : '', rest: close, next: NONE };
    }
    case 'collection': {
      const scan = scanCollection(body, 0, state.depth, state.level);
      if (!scan.closed) return whole({ ...state, depth: scan.depth });
      return { lead: scan.end > 0 ? REDACTED : '', rest: scan.end, next: NONE };
    }
    case 'key': {
      // Blank lines do not count; the first line with content either carries the value or ends the wait.
      let i = 0;
      while (body[i] === ' ' || body[i] === '\t') i++;
      if (i === body.length) return { lead: body, rest: null, next: state };
      if (state.needsSeparator) {
        SEPARATOR_RE.lastIndex = i;
        const sep = SEPARATOR_RE.exec(body);
        if (sep === null) return { lead: '', rest: 0, next: NONE };
        i += sep[0].length;
        if (i === body.length) return { lead: body, rest: null, next: { ...state, needsSeparator: false } };
      }
      const taken = takeValue(body, i, state.info);
      if (taken.redact === null) return { lead: '', rest: 0, next: NONE };
      const lead = marked(body, 0, taken.redact);
      if (taken.next.kind !== 'none') return { lead, rest: null, next: taken.next };
      return { lead, rest: taken.redact.to, next: NONE };
    }
  }
}

function redactLine(line: string, state: LineState): Redacted {
  const prefix = DOCKER_PREFIX_RE.exec(line)?.[0] ?? '';
  const body = line.slice(prefix.length);
  const cont = continueState(body, state);
  if (cont.rest === null) return { text: prefix + cont.lead, next: cont.next };
  const fresh = redactFresh(body.slice(cont.rest));
  return { text: prefix + cont.lead + fresh.text, next: fresh.next };
}

/**
 * Redact common secret shapes in `docker logs` output: credential shapes, URL passwords, values of secret-named
 * keys (whole arrays and objects included) and private-key blocks. Key names, markers, Docker's line prefixes,
 * line breaks and every other byte stay, so the output reads like the original log. A value, collection or key
 * block that continues onto later lines is redacted there too, to the end of the output if it never closes; a
 * secret key whose value is not on its line waits for the next line with content. One pass, linear in the
 * output's length. Idempotent.
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
