/**
 * In-process binding of the hierarchical (taxonomy-based) memory store.
 *
 * Wraps the dependency-free engine from somalib with:
 *   - the host `DATA_DIR`
 *   - prompt-cache invalidation on page mutations (the semantic index is
 *     injected into the system prompt, so a page write must drop cached
 *     prompt snapshots for that user — same contract as user-memory-store.ts)
 *   - the compact semantic-index renderer used at session start
 *
 * Registered with the model-command catalog in `src/index.ts`.
 */
import {
  HierarchicalMemoryFileStore,
  type MemoryIndexEntry,
  type PageLocator,
  type SemanticPage,
} from 'somalib/model-commands/hierarchical-memory-store';
import { DATA_DIR } from './env-paths';
import { Logger } from './logger';
import { createPromptInvalidator } from './prompt-cache-invalidation';

const logger = new Logger('HierarchicalMemory');

const invalidator = createPromptInvalidator(logger, 'HierMemory');
export const setHierarchicalMemoryPromptInvalidationHook = invalidator.setHook;

/** Engine subclass that fires prompt invalidation on prompt-affecting writes. */
class HostHierarchicalMemoryStore extends HierarchicalMemoryFileStore {
  upsertPage(user: string, loc: PageLocator, fields: Parameters<HierarchicalMemoryFileStore['upsertPage']>[2]) {
    const result = super.upsertPage(user, loc, fields);
    if (result.ok) invalidator.fire(user);
    return result;
  }

  removePage(user: string, loc: PageLocator) {
    const result = super.removePage(user, loc);
    if (result.ok) invalidator.fire(user);
    return result;
  }
}

export const hierarchicalMemoryStore = new HostHierarchicalMemoryStore(DATA_DIR);

const TYPE_LABELS: Record<string, string> = {
  agent: 'agent',
  sites: 'sites',
  concepts: 'concepts',
  project: 'projects',
  cron: 'cron',
};

/**
 * Render a compact index of the user's semantic memory pages for the system
 * prompt. Lists ids + titles + aliases only (not page bodies) so the model
 * knows what durable knowledge exists and can fetch a page on demand with the
 * MEMORY command (op=page_get). Returns '' when the user has no pages.
 */
export function formatSemanticIndexForPrompt(userId: string): string {
  let entries: MemoryIndexEntry[];
  try {
    entries = hierarchicalMemoryStore.readIndex(userId).entries;
  } catch {
    return '';
  }
  if (entries.length === 0) return '';

  const byType = new Map<string, MemoryIndexEntry[]>();
  for (const e of entries) {
    const list = byType.get(e.type) ?? [];
    list.push(e);
    byType.set(e.type, list);
  }

  const lines: string[] = [
    '══════════════════════════════════════════════',
    `MEMORY INDEX (${entries.length} semantic pages — fetch with MEMORY op=page_get)`,
    '══════════════════════════════════════════════',
  ];
  for (const type of ['agent', 'sites', 'concepts', 'project', 'cron']) {
    const list = byType.get(type);
    if (!list || list.length === 0) continue;
    lines.push(`▸ ${TYPE_LABELS[type] ?? type}`);
    for (const e of list) {
      const aliases = e.aliases.length > 0 ? ` (aka ${e.aliases.join(', ')})` : '';
      lines.push(`  - ${e.id} — ${e.title}${aliases}`);
    }
  }
  return lines.join('\n');
}

/** Today + recent episodic file dates, for optional prompt hinting. */
export function recentEpisodicDates(userId: string, limit = 3): string[] {
  try {
    return hierarchicalMemoryStore.recentEpisodicDates(userId, limit);
  } catch {
    return [];
  }
}

export type { MemoryIndexEntry, PageLocator, SemanticPage };
