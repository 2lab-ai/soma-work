// Secret redaction for the `logs` tool. `docker logs` output goes to the model as text, and services print
// credentials into their logs (an SDK client that logs its options object, a connection URL, a key block), so
// without this every log read copies them into the model context and the session transcript.
//
// The MCP servers do not depend on @soma/common, whose logger owns the daemon's redaction set, and the devops
// broker keeps its own (packages/devops-broker/src/scrub.ts). Its credential shapes are repeated here, plus the
// shapes service logs carry. One `logs` call can return a single 1 MB line, so every pattern is linear: each
// start is pinned by a literal or a lookbehind, and nothing quantified is followed by an overlapping quantifier.

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
const KEY_BLOCK_BEGIN_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const KEY_BLOCK_END_RE = /-----END [A-Z0-9 ]*PRIVATE KEY-----/;

const BASE64_CHAR_RE = /[A-Za-z0-9+/=]/;

interface ValueSpan {
  from: number;
  to: number;
  quoted: boolean;
}

/** End of the unquoted value starting at `i`. */
function unquotedEnd(line: string, i: number): number {
  let j = i;
  while (j < line.length && !UNQUOTED_END.has(line[j])) j++;
  return j;
}

/**
 * The value starting at `i`, quotes excluded; null for a nested object or array, whose own keys are matched
 * separately. A quoted value without its closing quote runs to the end of the line.
 */
function valueSpan(line: string, i: number): ValueSpan | null {
  const c = line[i];
  if (c === undefined || c === '{' || c === '[') return null;
  if (c === '"' || c === "'") {
    let j = i + 1;
    while (j < line.length && line[j] !== c) j += line[j] === '\\' ? 2 : 1;
    return { from: i + 1, to: Math.min(j, line.length), quoted: true };
  }
  if (c === '\\' && line[i + 1] === '"') {
    // JSON escaped inside a JSON string: the value closes at `\"`. Within it an escaped backslash is four
    // backslashes and an escaped quote three before the quote, so a quote closes the value when the
    // backslashes before it number 1 modulo 4.
    let j = i + 2;
    while (j < line.length) {
      if (line[j] !== '\\') {
        j++;
        continue;
      }
      let k = j;
      while (k < line.length && line[k] === '\\') k++;
      if (line[k] === '"' && (k - j) % 4 === 1) return { from: i + 2, to: k - 1, quoted: true };
      j = k + 1;
    }
    return { from: i + 2, to: line.length, quoted: true };
  }
  return { from: i, to: unquotedEnd(line, i), quoted: false };
}

/** `Basic <credential>` after an Authorization key: the span of the credential, or the whole value. */
function authCredentialSpan(line: string, span: ValueSpan): ValueSpan {
  if (span.quoted || !AUTH_SCHEME_RE.test(line.slice(span.from, span.to))) return span;
  let j = span.to;
  while (line[j] === ' ' || line[j] === '\t') j++;
  if (j === span.to) return span;
  const to = unquotedEnd(line, j);
  return to > j ? { from: j, to, quoted: false } : span;
}

/** Replace the values of secret keys (and SIDs under `sid` keys) in one line. */
function redactKeyValues(line: string): string {
  let out = '';
  let pos = 0;
  KEY_SEP_RE.lastIndex = 0;
  for (let m = KEY_SEP_RE.exec(line); m !== null; m = KEY_SEP_RE.exec(line)) {
    const key = m[1];
    const secretKey = SECRET_KEY_RE.test(key);
    if (!secretKey && !SID_KEY_RE.test(key)) continue;
    let span = valueSpan(line, m.index + m[0].length);
    if (span === null) continue;
    if (secretKey && AUTH_KEY_RE.test(key)) span = authCredentialSpan(line, span);
    const value = line.slice(span.from, span.to);
    if (value.length === 0 || value.startsWith(REDACTED)) continue;
    const redact = secretKey
      ? (span.quoted || !LITERAL_RE.test(value)) && !(DIGITS_RE.test(value) && COUNT_KEY_RE.test(key))
      : ACCOUNT_SID_RE.test(value);
    if (!redact) continue;
    out += line.slice(pos, span.from) + REDACTED;
    pos = span.to;
    KEY_SEP_RE.lastIndex = span.to;
  }
  return out + line.slice(pos);
}

/** Shapes, then URL userinfo, then key/value pairs (see {@link SHAPES} for why the order matters). */
function redactInline(line: string): string {
  let out = line;
  for (const [re, replacement] of SHAPES) out = out.replace(re, replacement);
  out = out.replace(URL_USERINFO_RE, `$1:${REDACTED}@`);
  return redactKeyValues(out);
}

/** The text before an END marker. Base64 glued to the marker is the block's last line, not a log prefix. */
function keepBeforeEnd(prefix: string): string {
  let k = prefix.length;
  while (k > 0 && BASE64_CHAR_RE.test(prefix[k - 1])) k--;
  return k === prefix.length ? prefix : prefix.slice(0, k) + REDACTED;
}

/**
 * Redact common secret shapes in `docker logs` output, line by line: credential shapes, URL passwords, values of
 * secret-named keys and private-key blocks. Key names, markers, line breaks and every other byte stay, so the
 * output reads like the original log. A key block cut off before its END marker is redacted to the end of the
 * output. Idempotent.
 */
export function redactLogSecrets(text: string): string {
  let inKeyBlock = false;
  return text
    .split('\n')
    .map((raw) => {
      const cr = raw.endsWith('\r') ? '\r' : '';
      let rest = cr ? raw.slice(0, -1) : raw;
      let head = '';
      if (inKeyBlock) {
        const end = KEY_BLOCK_END_RE.exec(rest);
        if (end === null) return (rest.length > 0 ? REDACTED : '') + cr;
        head = keepBeforeEnd(rest.slice(0, end.index)) + end[0];
        rest = rest.slice(end.index + end[0].length);
        inKeyBlock = false;
      }
      for (let begin = KEY_BLOCK_BEGIN_RE.exec(rest); begin !== null; begin = KEY_BLOCK_BEGIN_RE.exec(rest)) {
        const afterBegin = begin.index + begin[0].length;
        head += rest.slice(0, afterBegin);
        rest = rest.slice(afterBegin);
        const end = KEY_BLOCK_END_RE.exec(rest);
        if (end === null) {
          head += rest.length > 0 ? REDACTED : '';
          rest = '';
          inKeyBlock = true;
          break;
        }
        head += (end.index > 0 ? REDACTED : '') + end[0];
        rest = rest.slice(end.index + end[0].length);
      }
      return redactInline(head + rest) + cr;
    })
    .join('\n');
}
