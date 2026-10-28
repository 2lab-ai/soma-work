// Output scrubbing for broker-run commands (.prd/16-devops-tools-architecture.md §7). This is the output-path
// defense; what gh may send out is bounded by the argv schema in gh-policy (§4). The broker cannot depend on
// @soma/common, so this is its own pattern set.

export const REDACTED = '<redacted>';

/** Encoded forms are only matched for secrets at least this long — shorter ones would hit unrelated text. */
const MIN_ENCODED_SECRET_LENGTH = 8;

/** A cut-off tail is redacted only when this much of a secret form survives — shorter tails carry no secret. */
const MIN_PARTIAL_LENGTH = 4;

/** Credential shapes redacted whether or not the caller knows the value. No lookarounds: see {@link scrub}. */
const SHAPES: ReadonlyArray<readonly [RegExp, string]> = [
  [/gh[opsur]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/github_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/cf[au]t_[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/xox[abpre]-[A-Za-z0-9-]{10,}/g, REDACTED],
  // RFC 6750 b64token; `<` is outside the set, so `Bearer <redacted>` never matches again.
  [/Bearer[ \t]+[A-Za-z0-9._~+/-]+=*/g, `Bearer ${REDACTED}`],
];

/** A credential-shape prefix at the very end of a cut-off stream. */
const PARTIAL_SHAPE_TAIL = /(?:gh[opsur]_|github_pat_|cf[au]t_|xox[abpre]-)[A-Za-z0-9_-]*$/;

/**
 * How far back {@link PARTIAL_SHAPE_TAIL} looks. A cut shape with a 20+ character body is already a full
 * {@link SHAPES} match, so the tail is never longer than this; the bound also keeps the `$`-anchored scan
 * linear on adversarial output.
 */
const PARTIAL_SHAPE_WINDOW = 64;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * base64 / base64url text that encodes `bytes` wherever they sit in a larger blob. A blob places the secret
 * at byte offset 0, 1 or 2 of a 3-byte group; for each, keep only the characters whose 6 bits all come from
 * the secret — those appear verbatim in any blob with that alignment.
 */
function base64Forms(bytes: Buffer): string[] {
  const forms: string[] = [];
  for (const alphabet of ['base64', 'base64url'] as const) {
    const whole = bytes.toString(alphabet);
    forms.push(whole, whole.replace(/=+$/, ''));
    for (const offset of [0, 1, 2]) {
      const encoded = Buffer.concat([Buffer.alloc(offset), bytes]).toString(alphabet);
      const start = Math.ceil((offset * 8) / 6);
      const end = Math.floor(((offset + bytes.length) * 8) / 6);
      forms.push(encoded.slice(start, end));
    }
  }
  return forms;
}

/** One character of a secret: itself, or its UTF-8 bytes as `%XX` escapes (upper-case hex here). */
interface SecretUnit {
  literal: string;
  escaped: string;
}

function secretUnits(secret: string): SecretUnit[] {
  return [...secret].map((literal) => ({
    literal,
    escaped: [...Buffer.from(literal, 'utf8')].map((b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join(''),
  }));
}

/** `F` -> `[Ff]`; digits and `%` as they are. */
function caseFreeHex(escaped: string): string {
  return escaped.replace(/[A-F]/g, (d) => `[${d}${d.toLowerCase()}]`);
}

/**
 * Matches the secret with each character either literal or percent-escaped in any hex case — fully,
 * partially, or not at all encoded. One alternation per character and no nested quantifier, so a failed
 * attempt costs at most one step per character.
 */
function percentPattern(units: readonly SecretUnit[]): string {
  return units.map((u) => `(?:${escapeRegExp(u.literal)}|${caseFreeHex(u.escaped)})`).join('');
}

/** Everything one `scrub` call matches, built once per call. */
interface Matchers {
  /** Known values, longest first, then the marker; null when there are no secrets. */
  known: RegExp | null;
  /** Literal forms whose cut-off prefix {@link scrubTruncated} redacts. */
  literalForms: string[];
  /** Secrets (>= 8 chars) whose cut-off, possibly escaped prefix {@link scrubTruncated} redacts. */
  escapable: SecretUnit[][];
}

function buildMatchers(secrets: readonly string[]): Matchers {
  const unique = new Set(secrets.filter((secret) => typeof secret === 'string' && secret.length > 0));
  const literalForms = new Set<string>();
  const escapable: SecretUnit[][] = [];
  // [regex source, shortest text it can match]: sorting on the latter keeps longer secrets first.
  const alternatives: Array<[string, number]> = [];
  for (const secret of unique) {
    literalForms.add(secret);
    if (secret.length < MIN_ENCODED_SECRET_LENGTH) {
      alternatives.push([escapeRegExp(secret), secret.length]);
      continue;
    }
    const units = secretUnits(secret);
    escapable.push(units);
    alternatives.push([percentPattern(units), secret.length]);
    for (const form of base64Forms(Buffer.from(secret, 'utf8'))) {
      if (form.length === 0 || literalForms.has(form)) continue;
      literalForms.add(form);
      alternatives.push([escapeRegExp(form), form.length]);
    }
  }
  if (alternatives.length === 0) return { known: null, literalForms: [], escapable: [] };
  alternatives.sort((a, b) => b[1] - a[1]);
  // The marker is the last alternative so an existing `<redacted>` is consumed whole: a secret that happens
  // to be a substring of the marker cannot re-match inside it.
  const source = [...alternatives.map(([alt]) => alt), escapeRegExp(REDACTED)].join('|');
  return { known: new RegExp(source, 'g'), literalForms: [...literalForms], escapable };
}

function scrubWith(text: string, matchers: Matchers): string {
  let out = text;
  if (matchers.known) out = out.replace(matchers.known, REDACTED);
  // Shapes after known values: a shape that ran into a known secret would leave the secret's tail behind.
  for (const [re, replacement] of SHAPES) out = out.replace(re, replacement);
  return out;
}

/** Whether `text` from `start` to its end is a proper prefix of some (partly) escaped spelling of `units`. */
function isEscapedPrefix(text: string, start: number, units: readonly SecretUnit[]): boolean {
  const failed = new Set<number>();
  const walk = (i: number, j: number): boolean => {
    if (j === text.length) return true;
    if (i === units.length) return false;
    const key = i * (text.length + 1) + j;
    if (failed.has(key)) return false;
    const { literal, escaped } = units[i];
    const rest = text.length - j;
    const lit = text.slice(j, j + literal.length);
    if (rest < literal.length ? literal.startsWith(lit) : lit === literal && walk(i + 1, j + literal.length)) {
      return true;
    }
    const esc = text.slice(j, j + escaped.length).toUpperCase();
    if (rest < escaped.length ? escaped.startsWith(esc) : esc === escaped && walk(i + 1, j + escaped.length)) {
      return true;
    }
    failed.add(key);
    return false;
  };
  return walk(0, start);
}

/** {@link scrub} and {@link scrubTruncated} with the secrets' patterns compiled once. */
export interface Scrubber {
  scrub(text: string): string;
  scrubTruncated(text: string): string;
}

/** Trailing partial secret, encoding or credential shape: the index where it starts, or `out.length`. */
function partialTailStart(out: string, matchers: Matchers): number {
  let cut = out.length;
  for (const form of matchers.literalForms) {
    for (let k = Math.min(form.length - 1, out.length); k >= MIN_PARTIAL_LENGTH; k--) {
      if (out.endsWith(form.slice(0, k))) {
        cut = Math.min(cut, out.length - k);
        break;
      }
    }
  }
  for (const units of matchers.escapable) {
    // The longest spelling escapes every character; earliest start first = longest surviving tail.
    const longest = units.reduce((n, u) => n + u.escaped.length, 0);
    for (let start = Math.max(0, out.length - longest); start <= out.length - MIN_PARTIAL_LENGTH; start++) {
      if (start < cut && isEscapedPrefix(out, start, units)) {
        cut = start;
        break;
      }
    }
  }
  const windowStart = Math.max(0, out.length - PARTIAL_SHAPE_WINDOW);
  const shape = PARTIAL_SHAPE_TAIL.exec(out.slice(windowStart));
  if (shape) cut = Math.min(cut, windowStart + shape.index);
  return cut;
}

/**
 * Compile `secrets` once for many texts — one per response, not one per string. The secrets are copied at
 * creation; the scrubber holds no per-call state (`String#replace` restarts a global regex at 0).
 */
export function createScrubber(secrets: readonly string[]): Scrubber {
  const matchers = buildMatchers([...secrets]);
  return {
    scrub: (text) => scrubWith(text, matchers),
    scrubTruncated: (text) => {
      const out = scrubWith(text, matchers);
      const cut = partialTailStart(out, matchers);
      return cut === out.length ? out : `${out.slice(0, cut)}${REDACTED}`;
    },
  };
}

/**
 * Replace every occurrence of each non-empty secret with `<redacted>` — plus, when the secret is at least
 * 8 characters, its base64 and base64url encodings and any spelling with some or all characters as `%XX`
 * escapes (either hex case) — then every credential shape gh, Cloudflare or
 * Slack issue. Pure and idempotent: no pattern can match across or inside a marker, so a second pass finds
 * nothing the first one left. Compiles the secrets on every call; use {@link createScrubber} for many texts.
 */
export function scrub(text: string, secrets: readonly string[]): string {
  return createScrubber(secrets).scrub(text);
}

/**
 * {@link scrub} for a stream cut at a size cap: a secret, encoding or credential shape straddling the cut
 * leaves its first characters at the very end, where no full-length pattern can see them.
 */
export function scrubTruncated(text: string, secrets: readonly string[]): string {
  return createScrubber(secrets).scrubTruncated(text);
}
