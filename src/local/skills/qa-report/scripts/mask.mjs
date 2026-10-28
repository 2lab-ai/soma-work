#!/usr/bin/env node
/**
 * Secret masker shared by qa-report (report build) and qa-issue (before any
 * tracker comment or JSON write). Node built-ins only.
 *
 * Contract:
 *   import { mask } from './mask.mjs';  mask(value) → { value, count }
 *   node mask.mjs < in > out            (stdin JSON or text → masked, same format, on stdout; count on
 *                                        stderr; exit 2 when stdin is unreadable or not UTF-8)
 *
 * Masked to `***`:
 *   - the value of any sensitive key, whatever its type (string, number, array, object),
 *     in objects and in JSON text — including JSON serialized inside a string, at any depth,
 *     and JSON embedded in plain text (fenced, quoted, comment-prefixed); a quoted sensitive key whose
 *     fragment does not parse still has its value masked (fail closed);
 *   - Authorization / Cookie / Set-Cookie / token-ish `X-…` header lines, and Bearer/Basic credentials;
 *   - query and form parameters whose name ends in token / key / secret / sig / passw…;
 *   - JWT-shaped strings.
 * JSON text keeps every byte that is not masked (no re-serialization, so large integers survive).
 * Already-masked values are left alone and not counted again, so masking twice is a no-op.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SENSITIVE_KEY =
  /authorization|cookie|csrf|xsrf|passw|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|session[-_]?id|credential|signature/i;
const SENS = String.raw`(?:authorization|cookie|csrf|xsrf|passw|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|session[-_]?id|credential|signature)`;
const STARS = '***';

const isWs = (c) => c === 32 || c === 9 || c === 10 || c === 13;

/** Index just past the JSON string token that opens at `i`. */
function stringEnd(t, i) {
  let j = i + 1;
  while (j < t.length) {
    const c = t.charCodeAt(j);
    if (c === 92) j += 2;
    else if (c === 34) return j + 1;
    else j++;
  }
  return t.length;
}

/** Index just past the JSON value that starts at `k`. */
function valueEnd(t, k) {
  const c = t[k];
  if (c === '"') return stringEnd(t, k);
  if (c === '{' || c === '[') {
    let depth = 0;
    let j = k;
    while (j < t.length) {
      const d = t[j];
      if (d === '"') {
        j = stringEnd(t, j);
        continue;
      }
      if (d === '{' || d === '[') depth++;
      else if (d === '}' || d === ']') {
        depth--;
        if (depth === 0) return j + 1;
      }
      j++;
    }
    return t.length;
  }
  let j = k;
  while (j < t.length && !/[,}\]\s]/.test(t[j])) j++;
  return j;
}

/** Mask valid JSON text in place: sensitive-key values become "***", string values are masked recursively. */
function maskJsonText(t, st) {
  let out = '';
  let i = 0;
  while (i < t.length) {
    if (t[i] !== '"') {
      out += t[i++];
      continue;
    }
    const end = stringEnd(t, i);
    const tok = t.slice(i, end);
    let j = end;
    while (j < t.length && isWs(t.charCodeAt(j))) j++;
    if (t[j] === ':') {
      out += t.slice(i, j + 1);
      i = j + 1;
      if (SENSITIVE_KEY.test(JSON.parse(tok))) {
        let k = i;
        while (k < t.length && isWs(t.charCodeAt(k))) k++;
        const vEnd = valueEnd(t, k);
        if (t.slice(k, vEnd) !== `"${STARS}"`) st.count++;
        out += `${t.slice(i, k)}"${STARS}"`;
        i = vEnd;
      }
      continue;
    }
    const raw = JSON.parse(tok);
    const masked = maskString(raw, st);
    out += masked === raw ? tok : JSON.stringify(masked);
    i = end;
  }
  return out;
}

/** Index just past the balanced container opening at `i`, or -1 when it never closes. */
function containerEnd(t, i) {
  let depth = 0;
  let j = i;
  while (j < t.length) {
    const d = t[j];
    if (d === '"') {
      j = stringEnd(t, j);
      continue;
    }
    if (d === '{' || d === '[') depth++;
    else if (d === '}' || d === ']') {
      depth--;
      if (depth === 0) return j + 1;
    }
    j++;
  }
  return -1;
}

function parsesTo(text, type) {
  try {
    const v = JSON.parse(text);
    return type === 'object' ? v !== null && typeof v === 'object' : typeof v === type;
  } catch {
    return false;
  }
}

// A quoted sensitive key followed by a colon, with or without backslash-escaped quotes.
const HAS_SENS_KEY = new RegExp(String.raw`\\*"[^"\n]*${SENS}[^"\n]*\\*"\s*:`, 'i');
const KEY_RULE = new RegExp(String.raw`"[^"\\\n]*${SENS}[^"\\\n]*"\s*:\s*`, 'gi');
const KEY_RULE_ESC = new RegExp(String.raw`\\"[^"\\\n]*${SENS}[^"\\\n]*\\"\s*:\s*`, 'gi');

/** Plain text: mask every embedded JSON container, and every JSON string literal that holds JSON, as JSON. */
function maskFragments(s, st) {
  let out = '';
  let from = 0;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '{' || c === '[') {
      const end = containerEnd(s, i);
      if (end > 0 && parsesTo(s.slice(i, end), 'object')) {
        out += s.slice(from, i) + maskJsonText(s.slice(i, end), st);
        i = from = end;
        continue;
      }
    } else if (c === '"' && (s[i + 1] === '{' || s[i + 1] === '[')) {
      const end = stringEnd(s, i);
      const tok = s.slice(i, end);
      if (parsesTo(tok, 'string')) {
        const raw = JSON.parse(tok);
        const masked = maskString(raw, st);
        out += s.slice(from, i) + (masked === raw ? tok : JSON.stringify(masked));
        i = from = end;
        continue;
      }
    }
    i++;
  }
  return out + s.slice(from);
}

/** Fail closed: whatever follows a quoted sensitive key is masked, parseable or not. */
function maskByKeyRule(s, st) {
  let out = '';
  let from = 0;
  for (const [re, esc] of [
    [KEY_RULE, false],
    [KEY_RULE_ESC, true],
  ]) {
    out = '';
    from = 0;
    re.lastIndex = 0;
    let m = re.exec(s);
    while (m) {
      const k = m.index + m[0].length;
      if (k < s.length) {
        const end = esc ? escapedValueEnd(s, k) : valueEnd(s, k);
        const to = esc ? `\\"${STARS}\\"` : `"${STARS}"`;
        if (s.slice(k, end) !== to) st.count++;
        out += s.slice(from, k) + to;
        from = end;
        re.lastIndex = Math.max(end, k + 1);
      }
      m = re.exec(s);
    }
    s = out + s.slice(from);
  }
  return s;
}

/** End of a value whose quotes are backslash-escaped. Unclosed values run to the end of the line (fail closed). */
function escapedValueEnd(t, k) {
  const eol = t.indexOf('\n', k) === -1 ? t.length : t.indexOf('\n', k);
  if (t.startsWith('\\"', k)) {
    const close = t.indexOf('\\"', k + 2);
    return close === -1 || close > eol ? eol : close + 2;
  }
  if (t[k] === '{' || t[k] === '[') {
    let depth = 0;
    for (let j = k; j < eol; j++) {
      if (t[j] === '{' || t[j] === '[') depth++;
      else if (t[j] === '}' || t[j] === ']') {
        depth--;
        if (depth === 0) return j + 1;
      }
    }
    return eol;
  }
  let j = k;
  while (j < eol && !/[,}\]\s\\]/.test(t[j])) j++;
  return j;
}

// A Bearer/Basic credential: has a digit or token punctuation, or is long — so prose like "Basic authentication" stays.
const tokenLike = (v) => /[0-9_~+/=-]|\.[A-Za-z0-9]/.test(v) || v.length >= 20;

const PATTERNS = [
  // header lines
  [/^(\s*(?:proxy-)?(?:authorization|cookie|set-cookie|x-[\w-]*(?:token|csrf|xsrf|key|secret|session)[\w-]*)\s*:[ \t]*)(\S.*)$/gim, (m, k, v) => [k, v, STARS]],
  // bearer / basic credentials anywhere
  [/(\b(?:Bearer|Basic)\s+)([A-Za-z0-9._~+/=-]{7,}[A-Za-z0-9_~+/=-])/g, (m, k, v) => [k, v, tokenLike(v) ? STARS : v]],
  // query and form parameters
  [/((?:^|[?&;\s])[\w.[\]-]*(?:token|key|secret|sig|passw\w*|csrf|xsrf)=)([^&#\s"'\\]+)/gim, (m, k, v) => [k, v, STARS]],
  // JWT shapes
  [/()(eyJ[\w-]+\.[\w-]+\.[\w-]+)/g, (m, k, v) => [k, v, STARS]],
];

function maskString(s, st) {
  if (s.startsWith('data:image/')) return s;
  const t = s.trimStart();
  if ((t[0] === '{' || t[0] === '[') && parsesTo(s, 'object')) return maskJsonText(s, st);
  let out = s;
  if (HAS_SENS_KEY.test(out)) out = maskByKeyRule(maskFragments(out, st), st);
  for (const [re, split] of PATTERNS) {
    out = out.replace(re, (...args) => {
      const [k, v, to] = split(...args);
      if (v === to || v === STARS) return k + v;
      st.count++;
      return k + to;
    });
  }
  return out;
}

function maskAny(v, st) {
  if (typeof v === 'string') return maskString(v, st);
  if (Array.isArray(v)) return v.map((x) => maskAny(x, st));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (SENSITIVE_KEY.test(k)) {
        if (x !== STARS) st.count++;
        out[k] = STARS;
      } else out[k] = maskAny(x, st);
    }
    return out;
  }
  return v;
}

/** Mask secrets in any JSON-like value or text. Returns the masked copy and how many values were masked. */
export function mask(value) {
  const st = { count: 0 };
  return { value: maskAny(value, st), count: st.count };
}

function isMain() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  let input;
  try {
    input = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(0));
  } catch {
    process.stderr.write('mask: unreadable input (stdin must be UTF-8 text)\n');
    process.exit(2);
  }
  const { value, count } = mask(input);
  process.stdout.write(value);
  process.stderr.write(`mask: ${count} value(s) masked\n`);
}
