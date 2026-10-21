/**
 * Canonical semantic page ids and how they decompose into a locator.
 *
 * A page id is the string the memory index stores and the system prompt shows
 * the model: `agent/foo`, `sites/danawa`, `concepts/ha`, `project/soma-work`,
 * `project/soma-work/1234`, `cron/daily`. Because the model only ever sees the
 * id, the MEMORY command has to accept it verbatim — so id parsing lives here,
 * dependency-free (pure string work, no fs), and is shared by:
 *   - `hierarchical-memory-store.ts` — the filesystem store
 *   - `catalog.ts` — the model-command layer, which receives that store by
 *     injection and must not import the filesystem itself
 */

/** Semantic page categories addressable by the model. */
export type SemanticPageType = 'agent' | 'sites' | 'concepts' | 'project' | 'cron';

export const SEMANTIC_TYPES: SemanticPageType[] = ['agent', 'sites', 'concepts', 'project', 'cron'];

/** Where a semantic page lives. project/issue/cron use nested locators. */
export interface PageLocator {
  type: SemanticPageType;
  /** agent | sites | concepts page slug */
  slug?: string;
  /** projects/<project>/... */
  project?: string;
  /** projects/<project>/issues/<issue>.md (omit → project-level MEMORY.md) */
  issue?: string;
  /** cron/<routine>/MEMORY.md */
  routine?: string;
}

export function isSemanticPageType(value: unknown): value is SemanticPageType {
  return typeof value === 'string' && (SEMANTIC_TYPES as string[]).includes(value);
}

/** A single path segment safe to join into a filesystem path. */
export function isSafeSegment(s: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(s) && s !== '.' && s !== '..';
}

/** Split an id into non-empty trimmed segments, tolerating stray/edge slashes. */
export function pageIdSegments(id: string): string[] {
  return (id || '')
    .split('/')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Parse a canonical page id into a locator.
 *
 * Throws on anything that is not a real page id — an unknown leading type, a
 * missing name, or an unsafe segment — so a bogus locator can never reach the
 * store's path resolution.
 */
export function parsePageId(id: string): PageLocator {
  const parts = pageIdSegments(id);
  const type = parts[0];
  if (!isSemanticPageType(type)) {
    return failId(id, `must start with ${SEMANTIC_TYPES.join('|')}`);
  }
  const rest = parts.slice(1);
  if (rest.length === 0) return failId(id, `needs a name after \`${type}/\``);
  for (const segment of rest) {
    if (!isSafeSegment(segment)) return failId(id, `has an unsafe segment \`${segment}\``);
  }
  if (type === 'project') {
    if (rest.length > 2) return failId(id, 'is at most `project/<project>/<issue>`');
    return rest.length === 2 ? { type, project: rest[0], issue: rest[1] } : { type, project: rest[0] };
  }
  if (type === 'cron') {
    if (rest.length > 1) return failId(id, 'is `cron/<routine>`');
    return { type, routine: rest[0] };
  }
  if (rest.length > 1) return failId(id, `is \`${type}/<slug>\``);
  return { type, slug: rest[0] };
}

function failId(id: string, why: string): never {
  throw new Error(`invalid memory page id \`${id}\` — it ${why}`);
}
