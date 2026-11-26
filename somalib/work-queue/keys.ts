/**
 * Work-queue keys (.prd/36 D10). An entry names the work it is for by keys, so a newcomer can see what is already
 * being done: a Jira key (`ABC-1234`, upper-cased) or a GitHub key (`owner/repo#123`, owner and repo lower-cased —
 * issues and pull requests share one number space, so one form covers both). A GitHub issue or pull URL reads as its
 * key. Nothing else enters a queue.
 *
 * Both kinds of queue use these keys (.prd/36 v2): a lane entry names them (`queue_enter`); a person's request is read
 * for them ({@link keysInText}) so the same work sent twice is caught.
 */

/** Keys one entry may carry. */
export const WORK_KEYS_MAX = 50;

const JIRA_RE = /^([A-Za-z][A-Za-z0-9_]*)-([1-9][0-9]*)$/;
const GITHUB_RE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9][0-9]*)$/;
const GITHUB_URL_RE =
  /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(?:issues|pull)\/([1-9][0-9]*)(?:[/?#].*)?$/i;

/** The key's one spelling, or undefined when `raw` is neither a Jira nor a GitHub key. */
export function normalizeWorkKey(raw: string): string | undefined {
  const text = raw.trim();
  const jira = JIRA_RE.exec(text);
  if (jira) return `${jira[1].toUpperCase()}-${jira[2]}`;
  const gh = GITHUB_RE.exec(text) ?? GITHUB_URL_RE.exec(text);
  if (gh) return `${gh[1].toLowerCase()}/${gh[2].toLowerCase()}#${gh[3]}`;
  return undefined;
}

/**
 * A key list as a model sends it: an array, or one string split on commas and spaces. Each key once, in first-seen
 * order; whatever is not a key comes back in `invalid` as written.
 */
export function parseWorkKeys(raw: unknown): { keys: string[]; invalid: string[] } {
  const items: unknown[] = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(/[\s,]+/).filter((s) => s !== '')
      : raw === undefined || raw === null
        ? []
        : [raw];
  const keys: string[] = [];
  const invalid: string[] = [];
  for (const item of items) {
    const key = typeof item === 'string' ? normalizeWorkKey(item) : undefined;
    if (!key) invalid.push(String(item));
    else if (!keys.includes(key)) keys.push(key);
  }
  return { keys, invalid };
}

const GITHUB_URL_IN_TEXT =
  /https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(?:issues|pull)\/([1-9][0-9]*)/gi;
const GITHUB_REF_IN_TEXT = /(?<![A-Za-z0-9_./#-])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9][0-9]*)(?![0-9])/g;
const JIRA_URL_IN_TEXT = /https?:\/\/[A-Za-z0-9.-]+\/browse\/([A-Za-z][A-Za-z0-9_]*-[1-9][0-9]*)/gi;
/**
 * A bare Jira key in prose: upper case only (`abc-1` in a sentence is not a key), a project of 2–10 letters and no
 * digit (`Q4-2026`, `H2-2026`, `R2-3`, `K8S-1` are not keys in prose; a Jira link still carries any project).
 */
const JIRA_BARE_IN_TEXT = /(?<![A-Za-z0-9_/#.-])([A-Z]{2,10})-([1-9][0-9]{0,6})(?![A-Za-z0-9_-])/g;

/**
 * Upper-case tokens that look like a Jira key and never are one (`UTF-8`, `SHA-256`, `CVE-2024-…`, `GPT-5`): a
 * request mentioning them must not read as the same work as another that does.
 */
const NOT_A_PROJECT = new Set([
  'AES',
  'ARM',
  'BASE',
  'CRC',
  'CVE',
  'ECMA',
  'ES',
  'GPT',
  'HTTP',
  'IEEE',
  'IPV',
  'ISBN',
  'ISO',
  'MD',
  'MP',
  'PEP',
  'RFC',
  'RSA',
  'SHA',
  'SSL',
  'TLS',
  'UTF',
  'UUID',
  'WCAG',
  'X',
  'COVID',
  'IE',
  'HDMI',
  'USB',
  'DDR',
  'LTE',
  'BT',
  // Words a plan numbers (review 2026-11-26): `FY-2026`, `WEEK-48`, `PHASE-2`, `SPRINT-12` …
  'FY',
  'WEEK',
  'PHASE',
  'SPRINT',
  'STEP',
  'PART',
  'ROUND',
  'VERSION',
  'PAGE',
  'ITEM',
  'LEVEL',
  'CHAPTER',
  'SECTION',
  'TYPE',
  'NO',
  'NUM',
  'DAY',
  'MONTH',
  'YEAR',
  'TIER',
  'STAGE',
  'GEN',
  'MARK',
  'TEST',
  'CASE',
  'PLAN',
  'TASK',
]);

/**
 * The work keys a person's request names, in first-seen order: GitHub issue/PR links and `owner/repo#123` refs,
 * Jira browse links and bare upper-case Jira keys. At most {@link WORK_KEYS_MAX}. Text without any → `[]` (the
 * request names no work a queue can compare).
 */
export function keysInText(text: string | undefined): string[] {
  if (!text) return [];
  const found: Array<{ at: number; key: string }> = [];
  const add = (at: number, raw: string) => {
    const key = normalizeWorkKey(raw);
    if (key) found.push({ at, key });
  };
  for (const m of text.matchAll(GITHUB_URL_IN_TEXT)) add(m.index ?? 0, `${m[1]}/${m[2]}#${m[3]}`);
  for (const m of text.matchAll(JIRA_URL_IN_TEXT)) add(m.index ?? 0, m[1]);
  // Refs and bare keys outside links (a link's path would read as a ref: `github.com/o/r/pull/1` has no `#`, but a
  // Jira link's key is already taken above).
  const prose = text.replace(/https?:\/\/\S+/g, (url) => ' '.repeat(url.length));
  for (const m of prose.matchAll(GITHUB_REF_IN_TEXT)) add(m.index ?? 0, `${m[1]}/${m[2]}#${m[3]}`);
  for (const m of prose.matchAll(JIRA_BARE_IN_TEXT)) {
    if (!NOT_A_PROJECT.has(m[1])) add(m.index ?? 0, `${m[1]}-${m[2]}`);
  }
  found.sort((a, b) => a.at - b.at);
  const keys: string[] = [];
  for (const { key } of found) {
    if (!keys.includes(key)) keys.push(key);
    if (keys.length >= WORK_KEYS_MAX) break;
  }
  return keys;
}
