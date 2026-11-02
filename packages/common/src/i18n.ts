/**
 * Display language (#771) — one value per user: `ko` (the default) or `en`.
 *
 * Keys are the Korean source strings themselves (gettext style): `ko` returns
 * the source unchanged, so a Korean user sees exactly what the code says, and
 * the English catalog maps each source string to its English text. A source
 * string the catalog does not know is shown as written.
 *
 * The language travels with the work, not through every call: the Slack
 * middleware and the dashboard's request hook run their handlers inside
 * `runWithDisplayLang(lang, …)`, and every `t()` / `tr` call under them — on
 * any await — reads it with `currentDisplayLang()`. Outside such a scope
 * (boot, timers the host started itself) it is the default, `ko`.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const HANGUL = /[\u3131-\u318E\uAC00-\uD7A3]/;
const HANGUL_G = /[\u3131-\u318E\uAC00-\uD7A3]/g;

export const DISPLAY_LANGS = ['ko', 'en'] as const;
export type DisplayLang = (typeof DISPLAY_LANGS)[number];
export const DEFAULT_DISPLAY_LANG: DisplayLang = 'ko';

/** The language names people type (`lang en`, `lang 영어`, `lang English`) → the language; anything else → null. */
export function parseDisplayLang(value: unknown): DisplayLang | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (v === 'ko' || v === 'kr' || v === 'ko-kr' || v === 'korean' || v === '한국어' || v === '한글') return 'ko';
  if (v === 'en' || v === 'en-us' || v === 'en-gb' || v === 'english' || v === '영어') return 'en';
  return null;
}

/** A stored value as a language: only `ko` / `en` exactly; anything else (missing, old, typo) is the default. */
export function displayLangOf(value: unknown): DisplayLang {
  return value === 'en' ? 'en' : DEFAULT_DISPLAY_LANG;
}

const scope = new AsyncLocalStorage<{ lang: DisplayLang }>();

/** Run `fn` — and everything it awaits or schedules — in `lang`. */
export function runWithDisplayLang<T>(lang: DisplayLang, fn: () => T): T {
  return scope.run({ lang }, fn);
}

/** The language of the work in progress: the innermost `runWithDisplayLang`, else `ko`. */
export function currentDisplayLang(): DisplayLang {
  return scope.getStore()?.lang ?? DEFAULT_DISPLAY_LANG;
}

/**
 * Change the language of the scope already running — for a request whose user
 * is known only after its scope began (the dashboard learns the signed-in user
 * after the hook that opened the scope). Outside a scope it does nothing.
 */
export function setCurrentDisplayLang(lang: DisplayLang): void {
  const store = scope.getStore();
  if (store) store.lang = lang;
}

// ── Catalogs ──────────────────────────────────────────────────────

const english = new Map<string, string>();

interface Template {
  /** The literal parts around the placeholders (`{0}`, `{1}` … in order of appearance). */
  re: RegExp;
  /** Placeholder numbers in the order they appear in the key. */
  slots: number[];
  /** The literal text on each side of each slot (in order of appearance): '' at the template's edge. */
  around: Array<{ before: string; after: string }>;
  /** The longest literal part — a line without it cannot match. */
  anchor: string;
  /** Total literal length: the most specific template wins. */
  weight: number;
  text: string;
}

const templateByKey = new Map<string, Template>();
let templates: Template[] = [];
/**
 * Clauses the code appends to a finished sentence (`text + ' — 대시보드에서 응답했습니다.'`,
 * `text + ' (대시보드에서 응답)'`): keys that start with a space. Longest first.
 */
let suffixKeys: string[] = [];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function compileTemplate(key: string, text: string): Template | null {
  const parts = key.split(/\{(\d+)\}/);
  if (parts.length < 3) return null;
  const literals: string[] = [];
  const slots: number[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) literals.push(parts[i]);
    else slots.push(Number(parts[i]));
  }
  const weight = literals.reduce((n, l) => n + l.length, 0);
  // A template needs real words of its own: with fewer than two Korean syllables
  // (`{0}일`, `{0}분`) it would match the end of any Korean word (`내일` → `내d`).
  if ((literals.join('').match(HANGUL_G) ?? []).length < 2) return null;
  const anchor = literals.reduce((a, l) => (l.length > a.length ? l : a), '');
  const re = new RegExp(`^${literals.map(escapeRe).join('([\\s\\S]*?)')}$`);
  const around = slots.map((_, i) => ({ before: literals[i], after: literals[i + 1] }));
  return { re, slots, around, anchor, weight, text };
}

/**
 * Whether a captured value can be what the code put in that slot. A value
 * that splits a Korean word (Hangul right against Hangul literal text) is
 * someone's sentence, not a filled template. At the template's edge the slot
 * is open-ended: Korean there is taken only when it is itself catalog text
 * (a status word), so `원인: {0}` never claims a person's Korean sentence.
 */
function plausibleValue(v: string, side: { before: string; after: string }): boolean {
  if (!v) return true;
  if (side.after && HANGUL.test(side.after[0]) && HANGUL.test(v[v.length - 1])) return false;
  if (side.before && HANGUL.test(side.before[side.before.length - 1]) && HANGUL.test(v[0])) return false;
  if ((!side.before || !side.after) && HANGUL.test(v) && !english.has(v.trim())) return false;
  return true;
}

/**
 * Add English text for source strings. Each package registers its own catalog
 * once, at load; a later entry for the same source string replaces the
 * earlier. Empty text is ignored (the source stays). A key with `{0}`, `{1}` …
 * is also a template: `translateText` matches whole strings and lines against it.
 */
export function registerDisplayCatalog(lang: Exclude<DisplayLang, 'ko'>, entries: Readonly<Record<string, string>>) {
  if (lang !== 'en') return;
  let added = false;
  for (const [source, text] of Object.entries(entries)) {
    if (typeof text !== 'string' || text.length === 0) continue;
    english.set(source, text);
    if (source.startsWith(' ') && HANGUL.test(source) && !source.includes('{')) suffixKeys.push(source);
    const tpl = compileTemplate(source, text);
    if (tpl) {
      templateByKey.set(source, tpl);
      added = true;
    }
  }
  if (added) templates = [...templateByKey.values()].sort((a, b) => b.weight - a.weight);
  suffixKeys = [...new Set(suffixKeys)].sort((a, b) => b.length - a.length);
}

/** Whether the catalog for `lang` has text for this source string (`ko` has every one). */
export function hasDisplayText(source: string, lang: DisplayLang = 'en'): boolean {
  return lang === 'ko' || english.has(source);
}

/** A source string in `lang` (default: the current language). */
export function t(source: string, lang: DisplayLang = currentDisplayLang()): string {
  if (lang === 'ko') return source;
  return english.get(source) ?? source;
}

const templateKeys = new WeakMap<TemplateStringsArray, string>();

/**
 * The catalog key of a template: its literal parts joined by numbered
 * placeholders — `❌ ${name} 실패: ${why}` is `❌ {0} 실패: {1}`. The English
 * text may put the placeholders in any order.
 */
export function templateKey(strings: readonly string[]): string {
  let key = strings[0] ?? '';
  for (let i = 1; i < strings.length; i++) key += `{${i - 1}}${strings[i]}`;
  return key;
}

function keyOf(strings: TemplateStringsArray): string {
  let key = templateKeys.get(strings);
  if (key === undefined) {
    key = templateKey(strings);
    templateKeys.set(strings, key);
  }
  return key;
}

/** The template in `lang`: the translated text with each `{n}` filled, or the template as written. */
export function trIn(lang: DisplayLang, strings: TemplateStringsArray, ...values: unknown[]): string {
  if (lang !== 'ko') {
    const text = english.get(keyOf(strings));
    if (text !== undefined) {
      return text.replace(/\{(\d+)\}/g, (whole, n: string) => {
        const i = Number(n);
        return i < values.length ? String(values[i]) : whole;
      });
    }
  }
  let out = strings[0] ?? '';
  for (let i = 1; i < strings.length; i++) out += String(values[i - 1]) + strings[i];
  return out;
}

/**
 * A template literal in the current language: `` tr`❌ ${name} 실패` `` reads
 * exactly like the untagged literal in Korean and like its catalog text in
 * English.
 */
export function tr(strings: TemplateStringsArray, ...values: unknown[]): string {
  return trIn(currentDisplayLang(), strings, ...values);
}

// ── Text already composed (the output boundary) ───────────────────

function fill(text: string, values: string[]): string {
  return text.replace(/\{(\d+)\}/g, (whole, n: string) => {
    const i = Number(n);
    return i < values.length ? values[i] : whole;
  });
}

function matchTemplate(s: string, depth: number): string | null {
  for (const tpl of templates) {
    if (!s.includes(tpl.anchor)) continue;
    const m = tpl.re.exec(s);
    if (!m) continue;
    const captured = tpl.slots.map((_, i) => m[i + 1] ?? '');
    if (!captured.every((v, i) => plausibleValue(v, tpl.around[i]))) continue;
    const values: string[] = [];
    let swallowed = false;
    tpl.slots.forEach((slot, i) => {
      const v = captured[i];
      const t = depth < 2 && HANGUL.test(v) ? translateUnit(v, depth + 1) : null;
      if (depth < 2 && t === null && HANGUL.test(v) && SEPARATORS.some((sep) => v.includes(sep))) swallowed = true;
      values[slot] = t ?? v;
    });
    // A slot that ran across a separator into Korean it cannot place may have taken other units' words
    // (`<{0}|대시보드에서 보기>` over `<url|작업 스레드>  ·  <url|대시보드에서 보기>`). Give the line to the
    // part-by-part pass only when every part is wholly the bot's; a person's text with a separator in it
    // (a title `리뷰 · 수정`, even `응답 · 작업 중`) keeps the template — their words stay as written.
    if (swallowed && partsAreBotText(s)) continue;
    return fill(tpl.text, values);
  }
  return null;
}

/**
 * Whether some separator splits `s` into parts that are each wholly the bot's: an exact key, or a
 * template whose slots hold no Korean (translated without filling, so a person's words in a slot —
 * even words the catalog happens to know — leave Korean behind and fail the test).
 */
function partsAreBotText(s: string): boolean {
  return SEPARATORS.some((sep) => {
    if (!s.includes(sep)) return false;
    const parts = s.split(sep).filter((p) => HANGUL.test(p));
    return (
      parts.length > 0 &&
      parts.every((p) => {
        const t = translateUnit(p.trim(), 2);
        return t !== null && !HANGUL.test(t);
      })
    );
  });
}

function translateUnit(s: string, depth: number): string | null {
  const hit = english.get(s);
  if (hit !== undefined) return hit;
  return matchTemplate(s, depth);
}

const SEPARATORS = [' · ', ' | ', ' — ', ' • '];

function translateLine(line: string): string {
  if (!HANGUL.test(line)) return line;
  const whole = translateUnit(line, 0);
  if (whole !== null) return whole;
  const inner = line.trim();
  if (inner !== line) {
    const t = translateUnit(inner, 0);
    if (t !== null) return line.replace(inner, () => t);
  }
  // A sentence the catalog knows with a clause the code appended: both halves must be the catalog's.
  for (const suffix of suffixKeys) {
    if (line.length <= suffix.length || !line.endsWith(suffix)) continue;
    const head = translateUnit(line.slice(0, -suffix.length), 0);
    if (head !== null) return head + (english.get(suffix) as string);
  }
  for (const sep of SEPARATORS) {
    if (!line.includes(sep)) continue;
    let changed = false;
    const parts = line.split(sep).map((p) => {
      const t = HANGUL.test(p) ? translateUnit(p.trim(), 0) : null;
      if (t === null) return p;
      changed = true;
      return p.replace(p.trim(), () => t);
    });
    if (changed) return parts.join(sep);
  }
  return line;
}

/**
 * A reply with the `<display-lang>` tag it echoed at its end removed (#772). The tag is the host's note
 * to the model at the bottom of a conversation's first prompt; a model that copies it into its answer
 * must not show it to anyone. Only a trailing tag goes — the tag quoted inside a reply stays (in backticks
 * it is never trailing). Known cost: prose that itself ends with the bare tag loses it.
 */
export function stripEchoedDisplayLangTag(text: string): string {
  return text.replace(/(?:\s*<display-lang>[a-z]{2}<\/display-lang>)+\s*$/, '');
}

/**
 * A string already put together — a Slack message, a server error — in
 * `lang`: the whole string if the catalog has it (exactly, or as a `{n}`
 * template), else line by line, else the parts between ` · `-style
 * separators. What the catalog does not know (a title, a user's words, the
 * model's answer) stays as written. `ko` is always the input.
 */
export function translateText(text: string, lang: DisplayLang = currentDisplayLang()): string {
  if (lang === 'ko' || !text || !HANGUL.test(text)) return text;
  const whole = translateUnit(text, 0);
  if (whole !== null) return whole;
  if (!text.includes('\n')) return translateLine(text);
  return text
    .split('\n')
    .map((line) => translateLine(line))
    .join('\n');
}
