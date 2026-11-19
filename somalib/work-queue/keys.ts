/**
 * Work-queue keys (.prd/36 D10). An entry names the work it is for by keys, so a newcomer can see what is already
 * being done: a Jira key (`ABC-1234`, upper-cased) or a GitHub key (`owner/repo#123`, owner and repo lower-cased —
 * issues and pull requests share one number space, so one form covers both). A GitHub issue or pull URL reads as its
 * key. Nothing else enters a queue.
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
