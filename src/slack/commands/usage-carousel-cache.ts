// Trace: docs/usage-card-dark/trace.md, Scenario 7
//
// TabCache — in-memory LRU cache for the usage-card carousel's per-message
// tab file IDs. One entry per posted card message (keyed by `messageTs`),
// carrying the pre-rendered PNG file IDs + owner + absolute expiry.
//
// Why it exists: `usage_card_tab` block_actions need the file IDs to
// rebuild `chat.update` blocks when the user clicks a tab. Re-rendering on
// every click would defeat the point of pre-rendering all tabs upfront.
//
// Semantics:
// - TTL: lazy — `get()` checks `expiresAt` and purges on miss.
// - LRU cap (default 500): overflow evicts the oldest Map entry.
// - Move-to-end on `get()` hit, so frequently touched entries stay.
// - Opportunistic eviction on `set()`: scan first 10 entries and drop any
//   already expired. Keeps memory bounded under heavy churn without an
//   expensive full scan.
//
// TabId source: re-export from `usage-render/types` so the cache and the
// rest of the carousel share one definition. Adding a new tab (e.g. 'models')
// only requires changing the source type.

import type { TabId } from '../../metrics/usage-render/types';

export type { TabId } from '../../metrics/usage-render/types';

export interface TabCacheEntry {
  fileIds: Record<TabId, string>;
  userId: string;
  /** Absolute epoch ms when the entry expires. */
  expiresAt: number;
}

export interface TabCacheOptions {
  /** Max entries retained before LRU eviction. Default 500. */
  cap?: number;
  /** Time source; injected for tests. Default `() => Date.now()`. */
  now?: () => number;
}

const DEFAULT_CAP = 500;
const OPPORTUNISTIC_SCAN_LIMIT = 10;

export class TabCache {
  private readonly store = new Map<string, TabCacheEntry>();
  private readonly cap: number;
  private readonly now: () => number;

  constructor(opts: TabCacheOptions = {}) {
    this.cap = opts.cap ?? DEFAULT_CAP;
    this.now = opts.now ?? (() => Date.now());
  }

  set(messageTs: string, entry: TabCacheEntry): void {
    const now = this.now();

    // Opportunistic eviction — scan first N entries, drop expired.
    let scanned = 0;
    for (const [key, existing] of this.store) {
      if (scanned++ >= OPPORTUNISTIC_SCAN_LIMIT) break;
      if (existing.expiresAt <= now) {
        this.store.delete(key);
      }
    }

    // Re-set of same key: delete first so reinsertion moves it to the end.
    if (this.store.has(messageTs)) {
      this.store.delete(messageTs);
    } else if (this.store.size >= this.cap) {
      // At-cap LRU eviction — oldest (first) key.
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }

    this.store.set(messageTs, entry);
  }

  get(messageTs: string): TabCacheEntry | undefined {
    const entry = this.store.get(messageTs);
    if (entry === undefined) return undefined;

    // Lazy TTL purge.
    if (this.now() >= entry.expiresAt) {
      this.store.delete(messageTs);
      return undefined;
    }

    // Move-to-end: delete + reinsert preserves insertion order semantics
    // so this entry becomes the most-recently-used.
    this.store.delete(messageTs);
    this.store.set(messageTs, entry);
    return entry;
  }

  size(): number {
    return this.store.size;
  }
}

/**
 * Process-wide singleton used by the default UsageHandler wiring. Tests
 * and alternate call sites can build their own `new TabCache()` and inject
 * it via `UsageHandlerOverrides`.
 */
export const defaultTabCache: TabCache = new TabCache();
