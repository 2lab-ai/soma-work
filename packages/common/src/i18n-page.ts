/**
 * Display language for server-rendered pages (#773).
 *
 * The dashboard, the settings page, the conversation viewer and the sign-in
 * pages are one HTML string each, with their client script inline. Their
 * Korean is in four places: HTML text, attribute values, the script's string
 * and template literals, and CSS strings. `scanPage` finds every one of them;
 * `translatePage` swaps each for its English from the page catalog, escaped
 * for where it sits, and leaves everything else byte for byte.
 *
 * A script literal the code compares against (`=== '…'`, `case '…'`,
 * `.indexOf('…')`, an object key, `'…'.length`) is data, not display text:
 * it is marked `skip` and never translated, so the page's logic reads the
 * same words the server sends.
 */

import { currentDisplayLang, type DisplayLang } from './i18n';

const HANGUL = /[\u3131-\u318E\uAC00-\uD7A3]/;

export type PageSegmentKind = 'js' | 'tpl' | 'text' | 'attr' | 'css';

export interface PageSegment {
  kind: PageSegmentKind;
  /** The content's range in the page (quotes excluded; text trimmed). */
  start: number;
  end: number;
  /** The catalog key: script and CSS strings decoded, text and attributes as written. */
  key: string;
  /** The quote around a script string, attribute or CSS string. */
  quote?: string;
  /** A script string inside a double-quoted event attribute (`onclick="…"`). */
  inAttr?: boolean;
  /** The code compares against it — never translated. */
  skip?: boolean;
}

/** Whether a string has Hangul (the only text this layer looks at). */
export function hasHangul(s: string): boolean {
  return HANGUL.test(s);
}

/** A JS string / template literal's source text → its value. */
export function decodeJsString(raw: string): string {
  if (!raw.includes('\\')) return raw;
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = raw[++i];
    if (n === undefined) break;
    switch (n) {
      case 'n':
        out += '\n';
        break;
      case 't':
        out += '\t';
        break;
      case 'r':
        out += '\r';
        break;
      case 'b':
        out += '\b';
        break;
      case 'f':
        out += '\f';
        break;
      case 'v':
        out += '\v';
        break;
      case '0':
        out += '\0';
        break;
      case '\n':
        break;
      case '\r':
        if (raw[i + 1] === '\n') i++;
        break;
      case 'x': {
        const hex = raw.slice(i + 1, i + 3);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          out += String.fromCharCode(Number.parseInt(hex, 16));
          i += 2;
        } else out += 'x';
        break;
      }
      case 'u': {
        if (raw[i + 1] === '{') {
          const close = raw.indexOf('}', i + 2);
          const hex = close > 0 ? raw.slice(i + 2, close) : '';
          if (/^[0-9a-fA-F]{1,6}$/.test(hex)) {
            out += String.fromCodePoint(Number.parseInt(hex, 16));
            i = close;
          } else out += 'u';
        } else {
          const hex = raw.slice(i + 1, i + 5);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            out += String.fromCharCode(Number.parseInt(hex, 16));
            i += 4;
          } else out += 'u';
        }
        break;
      }
      default:
        out += n;
    }
  }
  return out;
}

// Words after which a `/` starts a regex, not a division.
const REGEX_AFTER_WORD = new Set([
  'return',
  'typeof',
  'case',
  'do',
  'else',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'instanceof',
  'yield',
  'await',
]);

// Code right before a literal that makes it data (compared, searched, a key lookup).
const DATA_BEFORE = [
  '===',
  '!==',
  '==',
  '!=',
  'case',
  'indexOf(',
  'lastIndexOf(',
  'includes(',
  'startsWith(',
  'endsWith(',
  'has(',
  'get(',
  'delete(',
  'split(',
  'replace(',
  'replaceAll(',
  'search(',
  'match(',
  'test(',
];

type Prev = '' | 'id' | 'kw' | 'num' | 'str' | 'close' | 'brace' | 'punct';

/**
 * Whether a `<script>` is page text: code is; a JSON data block is the
 * server's data (a conversation's turns) and stays byte for byte — unless it
 * says it carries page labels (`data-i18n`, or the sign-in card's
 * `data-auth-state`, which @2lab.ai/ui writes).
 */
function scansScript(openTag: string): boolean {
  const type = /\btype\s*=\s*["']([^"']*)["']/i.exec(openTag)?.[1]?.trim().toLowerCase() ?? '';
  if (type === '' || type === 'module' || type === 'text/javascript' || type === 'application/javascript') return true;
  return /\bdata-i18n\b|\bdata-auth-state\b/i.test(openTag);
}

class PageScanner {
  readonly segments: PageSegment[] = [];
  constructor(private readonly s: string) {}

  scan(): PageSegment[] {
    const s = this.s;
    const n = s.length;
    let i = 0;
    while (i < n) {
      const lt = s.indexOf('<', i);
      const textEnd = lt < 0 ? n : lt;
      if (textEnd > i) this.text(i, textEnd);
      if (lt < 0) break;
      if (s.startsWith('<!--', lt)) {
        const e = s.indexOf('-->', lt + 4);
        i = e < 0 ? n : e + 3;
        continue;
      }
      const m = /^<(\/?)([A-Za-z][\w:-]*)/.exec(s.slice(lt, lt + 80));
      if (!m) {
        i = lt + 1;
        continue;
      }
      const tagEnd = this.tag(lt + m[0].length, n);
      const name = m[2].toLowerCase();
      if (!m[1] && (name === 'script' || name === 'style')) {
        const close = this.findClose(name, tagEnd);
        if (name === 'script') {
          if (scansScript(s.slice(lt, tagEnd))) this.js(tagEnd, close, false, false);
        } else this.css(tagEnd, close);
        i = close;
        continue;
      }
      i = tagEnd;
    }
    return this.segments;
  }

  private findClose(name: string, from: number): number {
    const re = new RegExp(`</${name}`, 'ig');
    re.lastIndex = from;
    const m = re.exec(this.s);
    return m ? m.index : this.s.length;
  }

  private push(seg: PageSegment): void {
    if (hasHangul(seg.key)) this.segments.push(seg);
  }

  private text(a: number, b: number): void {
    const raw = this.s.slice(a, b);
    if (!hasHangul(raw)) return;
    const lead = raw.length - raw.trimStart().length;
    const trail = raw.length - raw.trimEnd().length;
    this.push({ kind: 'text', start: a + lead, end: b - trail, key: raw.trim() });
  }

  /** A start tag's attributes (from after its name) → the index after its `>`. */
  private tag(i: number, n: number): number {
    const s = this.s;
    let attrName = '';
    while (i < n) {
      const c = s[i];
      if (c === '>') return i + 1;
      if (c === '"' || c === "'") {
        const close = s.indexOf(c, i + 1);
        const end = close < 0 ? n : close;
        if (/^on[a-z]+$/i.test(attrName) && c === '"') this.js(i + 1, end, false, true);
        else {
          const raw = s.slice(i + 1, end);
          this.push({ kind: 'attr', start: i + 1, end, key: raw, quote: c });
        }
        attrName = '';
        i = end + 1;
        continue;
      }
      if (/[A-Za-z_:-]/.test(c)) {
        let j = i;
        while (j < n && /[\w:.-]/.test(s[j])) j++;
        attrName = s.slice(i, j);
        i = j;
        continue;
      }
      if (c !== '=' && !/\s/.test(c)) attrName = '';
      i++;
    }
    return n;
  }

  private css(a: number, b: number): void {
    const s = this.s;
    let i = a;
    while (i < b) {
      const c = s[i];
      if (c === '/' && s[i + 1] === '*') {
        const e = s.indexOf('*/', i + 2);
        i = e < 0 || e >= b ? b : e + 2;
        continue;
      }
      if (c === '"' || c === "'") {
        const end = this.stringEnd(i, c, b);
        const raw = s.slice(i + 1, end - 1);
        this.push({ kind: 'css', start: i + 1, end: end - 1, key: decodeJsString(raw), quote: c });
        i = end;
        continue;
      }
      i++;
    }
  }

  /** Index after the closing quote (or the line end of an unclosed string). */
  private stringEnd(i: number, q: string, b: number): number {
    const s = this.s;
    let j = i + 1;
    while (j < b) {
      const c = s[j];
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === q) return j + 1;
      if (c === '\n' && q !== '`') return j;
      j++;
    }
    return b;
  }

  private isData(qStart: number, qEnd: number): boolean {
    const s = this.s;
    let a = qStart - 1;
    while (a >= 0 && /\s/.test(s[a])) a--;
    const before = s.slice(Math.max(0, a - 15), a + 1);
    for (const d of DATA_BEFORE) {
      if (before.endsWith(d)) {
        // `case` must be the word, not the end of an identifier (`showcase`).
        if (d === 'case' && /[\w$]/.test(s[a - 4] ?? '')) continue;
        return true;
      }
    }
    let z = qEnd;
    while (z < s.length && /[ \t]/.test(s[z])) z++;
    const after = s.slice(z, z + 4);
    if (/^(===|!==|==|!=)/.test(after) || s.startsWith('.length', z)) return true;
    // An object key: `{ '…': x }` / `, '…': x` (a ternary branch `? '…' :` is not).
    if (after.startsWith(':') && (s[a] === '{' || s[a] === ',')) return true;
    return false;
  }

  /**
   * Tokenize script in [a, b): find its strings and template chunks. With
   * `untilBrace`, stop after the `}` closing a template `${`. Returns where it stopped.
   */
  private js(a: number, b: number, untilBrace: boolean, inAttr: boolean): number {
    const s = this.s;
    let i = a;
    let prev: Prev = '';
    let depth = 0;
    while (i < b) {
      const c = s[i];
      if (c === ' ' || c === '\n' || c === '\t' || c === '\r') {
        i++;
        continue;
      }
      if (c === '/' && s[i + 1] === '/') {
        const e = s.indexOf('\n', i);
        i = e < 0 || e >= b ? b : e;
        continue;
      }
      if (c === '/' && s[i + 1] === '*') {
        const e = s.indexOf('*/', i + 2);
        i = e < 0 || e >= b ? b : e + 2;
        continue;
      }
      if (c === "'" || c === '"') {
        const end = this.stringEnd(i, c, b);
        const raw = s.slice(i + 1, end - 1);
        if (hasHangul(raw) || raw.includes('\\u')) {
          const key = decodeJsString(raw);
          this.push({
            kind: 'js',
            start: i + 1,
            end: end - 1,
            key,
            quote: c,
            ...(inAttr ? { inAttr } : {}),
            ...(this.isData(i, end) ? { skip: true } : {}),
          });
        }
        i = end;
        prev = 'str';
        continue;
      }
      if (c === '`') {
        i = this.template(i + 1, b, inAttr);
        prev = 'str';
        continue;
      }
      if (c === '/') {
        if (prev === '' || prev === 'kw' || prev === 'punct' || prev === 'brace') {
          const end = this.regexEnd(i, b);
          if (end > 0) {
            i = end;
            prev = 'str';
            continue;
          }
        }
        i++;
        prev = 'punct';
        continue;
      }
      if (/[A-Za-z_$]/.test(c)) {
        let j = i + 1;
        while (j < b && /[\w$]/.test(s[j])) j++;
        prev = REGEX_AFTER_WORD.has(s.slice(i, j)) ? 'kw' : 'id';
        i = j;
        continue;
      }
      if (/[0-9]/.test(c)) {
        let j = i + 1;
        while (j < b && /[\w.]/.test(s[j])) j++;
        prev = 'num';
        i = j;
        continue;
      }
      if (c === '{') depth++;
      if (c === '}') {
        if (depth === 0 && untilBrace) return i + 1;
        depth--;
        prev = 'brace';
        i++;
        continue;
      }
      prev = c === ')' || c === ']' ? 'close' : 'punct';
      i++;
    }
    return b;
  }

  /** A template literal from after its backtick → the index after its closing backtick. */
  private template(i: number, b: number, inAttr: boolean): number {
    const s = this.s;
    let chunk = i;
    const flush = (end: number) => {
      const raw = s.slice(chunk, end);
      if (hasHangul(raw) || raw.includes('\\u'))
        this.push({ kind: 'tpl', start: chunk, end, key: decodeJsString(raw), ...(inAttr ? { inAttr } : {}) });
    };
    while (i < b) {
      const c = s[i];
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '`') {
        flush(i);
        return i + 1;
      }
      if (c === '$' && s[i + 1] === '{') {
        flush(i);
        i = this.js(i + 2, b, true, inAttr);
        chunk = i;
        continue;
      }
      i++;
    }
    flush(b);
    return b;
  }

  /** A regex literal starting at `/` → the index after its flags, or -1 when it is not one (no close on the line). */
  private regexEnd(i: number, b: number): number {
    const s = this.s;
    let j = i + 1;
    let inClass = false;
    while (j < b) {
      const c = s[j];
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === '\n') return -1;
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) {
        j++;
        while (j < b && /[a-z]/i.test(s[j])) j++;
        return j;
      }
      j++;
    }
    return -1;
  }
}

/** Every Korean string of a page, in order. */
export function scanPage(html: string): PageSegment[] {
  return new PageScanner(html).scan();
}

// ── Page catalog ──────────────────────────────────────────────────

const pageEnglish = new Map<string, string>();

/**
 * Add English for page strings (keys as `scanPage` gives them). A later entry
 * for a key replaces the earlier.
 *
 * A key may carry the code right before it — `key@@<context>` (see
 * `segmentContext`) — for a fragment whose English depends on where it sits
 * (`'일'` is "days" as a unit and nothing after a date's day). Such an entry
 * wins over the plain key there. Any entry may be empty: the fragment drops out.
 */
export function registerPageCatalog(entries: Readonly<Record<string, string>>): void {
  for (const [key, text] of Object.entries(entries)) {
    // Empty is a real answer here: a Korean counter suffix (`'개'`) that English does without.
    if (typeof text === 'string') pageEnglish.set(key, text);
  }
  pageCache.clear();
}

export const CONTEXT_MARK = '@@';
const CONTEXT_CHARS = 24;

/** The code right before a segment (its opening quote excluded), whitespace collapsed — a catalog key's `@@` part. */
export function segmentContext(html: string, seg: PageSegment): string {
  const open = seg.kind === 'text' ? seg.start : seg.start - 1;
  return html
    .slice(Math.max(0, open - CONTEXT_CHARS), Math.max(0, open))
    .replace(/\s+/g, ' ')
    .trim();
}

/** The English for one page key, or undefined. */
export function pageText(key: string): string | undefined {
  return pageEnglish.get(key);
}

function escapeFor(seg: PageSegment, text: string): string {
  switch (seg.kind) {
    case 'js':
    case 'css': {
      let out = text
        .replace(/\\/g, '\\\\')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
      if (seg.quote) out = out.split(seg.quote).join(`\\${seg.quote}`);
      out = out.replace(/<\//g, '<\\/');
      if (seg.inAttr) out = out.replace(/"/g, '&quot;');
      return out;
    }
    case 'tpl': {
      let out = text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${').replace(/<\//g, '<\\/');
      if (seg.inAttr) out = out.replace(/"/g, '&quot;');
      return out;
    }
    case 'attr':
      return seg.quote === "'" ? text.replace(/'/g, '&#39;') : text.replace(/"/g, '&quot;');
    case 'text':
      return text.replace(/</g, '&lt;');
  }
}

const pageCache = new Map<string, string>();
const PAGE_CACHE_MAX = 6;

/**
 * The page in `lang`: every catalog string swapped for its English, the
 * elements' `lang="ko"` and the document's `<html lang>` set to the language.
 * `ko` is the page unchanged. A string the catalog lacks stays Korean.
 */
export function translatePage(html: string, lang: DisplayLang = currentDisplayLang()): string {
  if (lang === 'ko') return html;
  const hit = pageCache.get(html);
  if (hit !== undefined) return hit;
  const segs = scanPage(html);
  let out = '';
  let at = 0;
  for (const seg of segs) {
    if (seg.skip) continue;
    const text = pageEnglish.get(`${seg.key}${CONTEXT_MARK}${segmentContext(html, seg)}`) ?? pageEnglish.get(seg.key);
    if (text === undefined) continue;
    out += html.slice(at, seg.start) + escapeFor(seg, text);
    at = seg.end;
  }
  out += html.slice(at);
  out = out.replace(/(<[a-z][\w-]*\b[^<>]*?\s)lang="ko"/g, `$1lang="${lang}"`);
  if (pageCache.size >= PAGE_CACHE_MAX) pageCache.delete(pageCache.keys().next().value as string);
  pageCache.set(html, out);
  return out;
}
