/**
 * #1074 — artifact versions: when an upload is the same artifact again.
 *
 * One rule for both sides that need it: the daemon's artifact store (which
 * records the version) and slack-mcp (which says the version in the upload's
 * comment before the store has seen the upload). The store is the record; the
 * comment applies the same rule to the same index.
 *
 * The same artifact = the same session (one index per conversation) and the
 * same key:
 *   1. the key the model gave (`artifact_key`)              → `key:<key>`
 *   2. a link's URL                                         → `url:<url>`
 *   3. else the file name with only its time stamps removed → `name:<name>`
 *      (an exact match — nothing fuzzier; a name that is only a time stamp stays whole)
 *
 * Within a key, an upload whose content hash equals the latest version's is not
 * a new version ("no changes"); any other upload is the next version.
 */

/** The fields of a recorded artifact this module reads (a subset of `SessionArtifact`). */
export interface ArtifactVersionRow {
  id: string;
  name?: string;
  /** `link` — keyed by its URL; any other kind by its name (an upload's `url` is where it is served, not what it is). */
  kind?: string;
  url?: string;
  source?: string;
  key?: string;
  version?: number;
  sha256?: string;
}

export interface ArtifactVersionPlan {
  key: string;
  /** The version this upload is — or, when `unchanged`, the version it equals. */
  version: number;
  /** The latest earlier version of the key. */
  previous?: ArtifactVersionRow;
  /** true: differs from `previous`; false: the same content; null: no previous version, or a hash is unknown. */
  changed: boolean | null;
  /** The same content as the latest version: no new version. */
  unchanged: boolean;
}

/** Versions of one key whose bytes are kept; older ones keep their row and Slack link only. */
export const MAX_KEPT_VERSIONS = 10;
export const MAX_ARTIFACT_KEY_LENGTH = 200;

const SEP = '[-_. ]';
const two = (s: string | undefined, max: number) => s === undefined || (Number(s) >= 0 && Number(s) <= max);
const date = (y: string, m: string, d: string) =>
  /^(19|20)\d\d$/.test(y) && Number(m) >= 1 && Number(m) <= 12 && Number(d) >= 1 && Number(d) <= 31;
const time = (h?: string, mi?: string, s?: string) => two(h, 23) && two(mi, 59) && two(s, 59);

/** Time-stamp shapes, longest first; each is checked as a real date / time before it is removed. */
const STAMPS: Array<[RegExp, (...g: string[]) => boolean]> = [
  // 2026-11-09T18-47-15 · 2026-11-09 18:47 · 2026-11-09_184715 (+ .123 / Z)
  [
    /(?<!\d)(\d{4})-(\d{2})-(\d{2})[T_ -](\d{2})[:.-]?(\d{2})(?:[:.-]?(\d{2}))?(?:\.\d{1,3})?Z?(?!\d)/g,
    (y, m, d, h, mi, s) => date(y, m, d) && time(h, mi, s),
  ],
  // 20261109-184715 · 20261109T184715 · 20261109184715 · 20261109-1847
  [
    /(?<!\d)(\d{4})(\d{2})(\d{2})[T_-]?(\d{2})(\d{2})(\d{2})?(?!\d)/g,
    (y, m, d, h, mi, s) => date(y, m, d) && time(h, mi, s),
  ],
  // 2026-11-09
  [/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g, (y, m, d) => date(y, m, d)],
  // 20261109
  [/(?<!\d)(\d{4})(\d{2})(\d{2})(?!\d)/g, (y, m, d) => date(y, m, d)],
  // epoch milliseconds / seconds (2017 – 2033)
  [/(?<!\d)(1[5-9]\d{11}|1[5-9]\d{8})(?!\d)/g, () => true],
];

/** The file name with its time stamps removed; the name itself when nothing else would be left. */
export function stripNameTimestamps(name: string): string {
  const dot = name.lastIndexOf('.');
  const hasExt = dot > 0 && dot < name.length - 1;
  const stem = hasExt ? name.slice(0, dot) : name;
  const ext = hasExt ? name.slice(dot) : '';
  let out = stem;
  for (const [re, valid] of STAMPS) {
    out = out.replace(re, (match: string, ...groups: unknown[]) =>
      valid(...(groups.slice(0, 6) as string[])) ? '\u0000' : match,
    );
  }
  if (!out.includes('\u0000')) return name;
  out = out
    .replace(new RegExp(`${SEP}*\\u0000${SEP}*`, 'g'), (m) => {
      const lead = m.match(new RegExp(`^${SEP}`));
      return lead ? lead[0] : '';
    })
    .replace(new RegExp(`^${SEP}+|${SEP}+$`, 'g'), '');
  return out ? `${out}${ext}` : name;
}

/** A model-given key as stored: trimmed, spaces collapsed, capped; '' when none. */
export function normalizeArtifactKey(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().replace(/\s+/g, ' ').slice(0, MAX_ARTIFACT_KEY_LENGTH);
}

/** The key an artifact is grouped by (see the module comment). */
export function artifactKeyFor(input: { key?: unknown; name?: string; url?: string }): string {
  const given = normalizeArtifactKey(input.key);
  if (given) return `key:${given}`;
  if (typeof input.url === 'string' && input.url) return `url:${input.url}`;
  return `name:${stripNameTimestamps(String(input.name || 'file'))}`;
}

export function isSha256Hex(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
}

/** The highest version recorded under `key`. */
export function latestOfKey<T extends ArtifactVersionRow>(rows: readonly T[], key: string): T | undefined {
  let best: T | undefined;
  for (const r of rows) {
    if (r.key === key && (best === undefined || (r.version ?? 0) >= (best.version ?? 0))) best = r;
  }
  return best;
}

/** The version an upload of `key` with content `sha256` becomes, given the rows already recorded. */
export function planArtifactVersion(
  rows: readonly ArtifactVersionRow[],
  key: string,
  sha256: string | undefined,
): ArtifactVersionPlan {
  const previous = latestOfKey(rows, key);
  if (!previous) return { key, version: 1, changed: null, unchanged: false };
  const prevVersion = previous.version ?? 1;
  const known = isSha256Hex(sha256) && isSha256Hex(previous.sha256);
  if (known && previous.sha256 === sha256) {
    return { key, version: prevVersion, previous, changed: false, unchanged: true };
  }
  return { key, version: prevVersion + 1, previous, changed: known ? true : null, unchanged: false };
}

/**
 * Give rows recorded before versions existed a key (from their name or URL) and a
 * version (recording order within the key). `rows` is in recording order and is
 * changed in place; a hidden final answer gets neither.
 */
export function assignArtifactVersions<T extends ArtifactVersionRow>(rows: T[]): T[] {
  const top = new Map<string, number>();
  for (const r of rows) {
    if (r.source === 'final_answer') continue;
    if (!r.key) r.key = artifactKeyFor({ name: r.name, url: r.kind === 'link' ? r.url : undefined });
    if (!(typeof r.version === 'number' && Number.isSafeInteger(r.version) && r.version > 0)) {
      r.version = (top.get(r.key) ?? 0) + 1;
    }
    top.set(r.key, Math.max(top.get(r.key) ?? 0, r.version));
  }
  return rows;
}
