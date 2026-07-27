/**
 * llmux model-catalog overlay (`GET /llmux/models`).
 *
 * Runtime store that makes llmux-served model ids (e.g. `grok-4.5`)
 * selectable — with correct aliases, display names, effort menus, and
 * context windows — WITHOUT touching the static `AVAILABLE_MODELS`
 * allow-list in `user-settings-store.ts` (Issue #656 guard: that list never
 * shrinks; the catalog only ever EXTENDS selection).
 *
 * Layering (must stay acyclic):
 *   model-catalog  ←  user-settings-store   (selection overlay)
 *   model-catalog  ←  metrics/model-registry (context-window overlay)
 *   model-catalog  ←  build-stream-options   (SDK window workaround + effort clamp)
 *
 * This module therefore imports NEITHER user-settings-store NOR
 * model-registry. The llmux fetcher is injected (`setFetcher` at boot in
 * `src/index.ts`, llmux auth mode only) rather than imported, so importing
 * this module never drags in auth-runtime/config — and unit tests can never
 * hit the network or write a snapshot by accident (no fetcher wired ⇒
 * refresh is a no-op).
 *
 * Persistence: `${DATA_DIR}/model-catalog.json`, written atomically
 * (tmp → renameSync, previous file preserved as `.bak`) per rules/config.md.
 * The snapshot is loaded synchronously at module import so importers that
 * coerce persisted model ids at THEIR import time (user-settings-store's
 * constructor-time `loadSettings`) already see the last known catalog.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LlmuxModelEntry } from './auth/llmux-client';
import { DATA_DIR } from './env-paths';
import { Logger } from './logger';

const logger = new Logger('ModelCatalog');

/** Normalized catalog entry (aliases/efforts lowercased, `max_context` → `maxContext`). */
export interface CatalogModel {
  id: string;
  aliases: string[];
  name: string;
  efforts: string[];
  maxContext: number | null;
  group: string;
}

/**
 * Canonical effort ordering used by {@link clampEffortToModel}. Superset of
 * the store's EFFORT_LEVELS (`ultra` exists upstream on some codex tiers).
 */
export const CANONICAL_EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;

const SNAPSHOT_FILE_NAME = 'model-catalog.json';
/** Min gap between two llmux fetch attempts (success or failure). */
const REFRESH_COOLDOWN_MS = 60_000;
/**
 * Min gap between two FORCED fetch attempts. Forced refreshes (admin `model`,
 * unknown-model re-resolution) bypass the normal 60s cooldown but keep this
 * short throttle so repeated typo input / admin spam cannot hammer llmux.
 */
const FORCE_REFRESH_COOLDOWN_MS = 5_000;
/** Stale-while-revalidate TTL for `maybeRefreshInBackground`. */
const REFRESH_TTL_MS = 10 * 60_000;

export type CatalogFetcher = () => Promise<LlmuxModelEntry[]>;

export interface RefreshOptions {
  /**
   * Bypass the normal 60s attempt cooldown (still deduped against in-flight
   * fetches and throttled by {@link FORCE_REFRESH_COOLDOWN_MS} between two
   * forced attempts).
   */
  force?: boolean;
}

export interface RefreshResult {
  ok: boolean;
  /** Entry count after the refresh (current entries on failure/skip). */
  count: number;
  /** True when no fetch was attempted (cooldown, in-flight reuse never sets this, no fetcher). */
  skipped?: boolean;
  error?: string;
}

interface SnapshotShape {
  fetchedAt: number | null;
  models: CatalogModel[];
}

function normalizeEntries(raw: unknown[]): CatalogModel[] {
  const out: CatalogModel[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === 'string' ? e.id.trim() : '';
    if (id.length === 0) continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const aliases = Array.isArray(e.aliases)
      ? e.aliases
          .filter((a): a is string => typeof a === 'string' && a.trim().length > 0)
          .map((a) => a.trim().toLowerCase())
      : [];
    const efforts = Array.isArray(e.efforts)
      ? e.efforts
          .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
          .map((x) => x.trim().toLowerCase())
      : [];
    // Accept both wire (`max_context`) and snapshot (`maxContext`) spellings.
    const rawWindow = e.max_context ?? e.maxContext;
    const maxContext = typeof rawWindow === 'number' && Number.isFinite(rawWindow) && rawWindow > 0 ? rawWindow : null;
    out.push({
      id,
      aliases,
      name: typeof e.name === 'string' && e.name.trim().length > 0 ? e.name.trim() : id,
      efforts,
      maxContext,
      group: typeof e.group === 'string' ? e.group.trim().toLowerCase() : '',
    });
  }
  return out;
}

class ModelCatalog {
  private entries: CatalogModel[] = [];
  private byId = new Map<string, CatalogModel>();
  private byAlias = new Map<string, CatalogModel>();
  private fetchedAt: number | null = null;
  private lastAttemptAt = 0;
  private lastForcedAttemptAt = 0;
  private inFlight: Promise<RefreshResult> | null = null;
  private fetcher: CatalogFetcher | null = null;
  private snapshotPathOverride: string | null = null;

  private snapshotFile(): string {
    return this.snapshotPathOverride ?? path.join(DATA_DIR, SNAPSHOT_FILE_NAME);
  }

  private setEntries(entries: CatalogModel[]): void {
    this.entries = entries;
    this.byId = new Map(entries.map((m) => [m.id.toLowerCase(), m]));
    this.byAlias = new Map();
    for (const m of entries) {
      for (const alias of m.aliases) {
        if (!this.byAlias.has(alias)) this.byAlias.set(alias, m);
      }
    }
  }

  /**
   * Inject the llmux fetch implementation (boot-time, llmux auth mode only).
   * Without a fetcher every refresh is a safe no-op — the catalog then only
   * serves whatever the on-disk snapshot provided.
   */
  setFetcher(fetcher: CatalogFetcher | null): void {
    this.fetcher = fetcher;
  }

  // ---------------------------------------------------------------- accessors

  getModels(): CatalogModel[] {
    return [...this.entries];
  }

  getById(id: string): CatalogModel | null {
    if (typeof id !== 'string') return null;
    return this.byId.get(id.trim().toLowerCase()) ?? null;
  }

  /** Case-insensitive id match, then alias match → canonical id (or null). */
  resolveInput(input: string): string | null {
    if (typeof input !== 'string') return null;
    const normalized = input.trim().toLowerCase();
    if (normalized.length === 0) return null;
    const byId = this.byId.get(normalized);
    if (byId) return byId.id;
    const byAlias = this.byAlias.get(normalized);
    return byAlias ? byAlias.id : null;
  }

  getDisplayName(id: string): string | null {
    return this.getById(id)?.name ?? null;
  }

  getEffortsFor(id: string): string[] | null {
    const m = this.getById(id);
    return m ? [...m.efforts] : null;
  }

  getContextWindowFor(id: string): number | null {
    return this.getById(id)?.maxContext ?? null;
  }

  getGroupFor(id: string): string | null {
    const m = this.getById(id);
    return m && m.group.length > 0 ? m.group : null;
  }

  getFetchedAt(): number | null {
    return this.fetchedAt;
  }

  // ------------------------------------------------------------- persistence

  /**
   * Load the snapshot from disk. Parse failures WARN (never throw) and fall
   * back to `${file}.bak` per rules/config.md — a corrupt live file must not
   * silently zero the catalog.
   */
  loadSnapshotSync(): void {
    const file = this.snapshotFile();
    for (const candidate of [file, `${file}.bak`]) {
      try {
        if (!fs.existsSync(candidate)) continue;
        const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as Partial<SnapshotShape>;
        if (!Array.isArray(parsed?.models)) {
          logger.warn(`model-catalog snapshot has no models array, ignoring: ${candidate}`);
          continue;
        }
        this.setEntries(normalizeEntries(parsed.models));
        this.fetchedAt = typeof parsed.fetchedAt === 'number' ? parsed.fetchedAt : null;
        logger.info(`Loaded model-catalog snapshot (${this.entries.length} models) from ${candidate}`);
        return;
      } catch (error) {
        logger.warn(`Failed to load model-catalog snapshot ${candidate}: ${(error as Error).message}`);
      }
    }
  }

  /** Atomic snapshot write: tmp → rename, previous file kept as `.bak`. Never throws. */
  private saveSnapshot(): void {
    const file = this.snapshotFile();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const payload: SnapshotShape = { fetchedAt: this.fetchedAt, models: this.entries };
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
      if (fs.existsSync(file)) {
        fs.copyFileSync(file, `${file}.bak`);
      }
      fs.renameSync(tmp, file);
      logger.debug(`Saved model-catalog snapshot (${this.entries.length} models)`);
    } catch (error) {
      logger.warn(`Failed to save model-catalog snapshot: ${(error as Error).message}`);
    }
  }

  // ------------------------------------------------------------------ refresh

  /**
   * Fetch the catalog from llmux. Success replaces entries + persists the
   * snapshot; failure WARNs and keeps the current entries (never downgrade).
   * In-flight calls are deduped; attempts are rate-limited by a 60s cooldown.
   *
   * `opts.force` (admin `model` refresh, unknown-model re-resolution) bypasses
   * the 60s cooldown; two forced attempts are still ≥ 5s apart
   * ({@link FORCE_REFRESH_COOLDOWN_MS}) so bad input cannot hammer llmux.
   */
  refresh(fetchImpl?: CatalogFetcher, opts?: RefreshOptions): Promise<RefreshResult> {
    if (this.inFlight) return this.inFlight;

    const fetcher = fetchImpl ?? this.fetcher;
    if (!fetcher) {
      return Promise.resolve({ ok: false, count: this.entries.length, skipped: true, error: 'no fetcher wired' });
    }
    const now = Date.now();
    if (opts?.force) {
      if (now - this.lastForcedAttemptAt < FORCE_REFRESH_COOLDOWN_MS) {
        return Promise.resolve({ ok: false, count: this.entries.length, skipped: true, error: 'force cooldown' });
      }
      this.lastForcedAttemptAt = now;
    } else if (now - this.lastAttemptAt < REFRESH_COOLDOWN_MS) {
      return Promise.resolve({ ok: false, count: this.entries.length, skipped: true, error: 'cooldown' });
    }
    this.lastAttemptAt = now;

    this.inFlight = (async (): Promise<RefreshResult> => {
      try {
        const models = await fetcher();
        this.setEntries(normalizeEntries(models));
        this.fetchedAt = Date.now();
        this.saveSnapshot();
        logger.info(`Refreshed llmux model catalog (${this.entries.length} models)`);
        return { ok: true, count: this.entries.length };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`llmux model catalog refresh failed (keeping ${this.entries.length} known models): ${message}`);
        return { ok: false, count: this.entries.length, error: message };
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  /**
   * Fire-and-forget refresh when the catalog is stale (> 10 min TTL).
   * All errors are swallowed — callers (e.g. `/z model` card render) must
   * never block or fail on catalog freshness.
   */
  maybeRefreshInBackground(fetchImpl?: CatalogFetcher): void {
    if (this.fetchedAt !== null && Date.now() - this.fetchedAt < REFRESH_TTL_MS) return;
    if (!fetchImpl && !this.fetcher) return;
    void this.refresh(fetchImpl).catch(() => {
      /* refresh never rejects, defensive */
    });
  }

  // --------------------------------------------------------------- test hooks

  /** TEST ONLY — reset all runtime state (entries, timestamps, fetcher). */
  __testReset(): void {
    this.setEntries([]);
    this.fetchedAt = null;
    this.lastAttemptAt = 0;
    this.lastForcedAttemptAt = 0;
    this.inFlight = null;
    this.fetcher = null;
  }

  /**
   * TEST ONLY — seed entries directly (raw llmux wire shape). Marks the
   * catalog fresh (`fetchedAt = now`) so background refresh stays quiet.
   */
  __testSeed(entries: Array<Partial<LlmuxModelEntry>>): void {
    this.setEntries(normalizeEntries(entries));
    this.fetchedAt = Date.now();
  }

  /** TEST ONLY — redirect the snapshot file (null restores the DATA_DIR default). */
  setSnapshotPathForTests(filePath: string | null): void {
    this.snapshotPathOverride = filePath;
  }
}

export const modelCatalog = new ModelCatalog();
// Load the last-known catalog BEFORE any importer runs its own import-time
// model coercion (user-settings-store's constructor loads user settings at
// module import; without this, persisted catalog models would be coerced to
// DEFAULT_MODEL on every restart that beats the first llmux fetch).
modelCatalog.loadSnapshotSync();

/**
 * Clamp `effort` to what the catalog says `modelId` supports.
 *
 * - Model unknown to the catalog, or catalog efforts empty → `effort` as-is.
 * - `effort` included in the model's menu → unchanged.
 * - Otherwise → the highest supported effort that is ≤ the requested one on
 *   {@link CANONICAL_EFFORT_ORDER}; if nothing lower exists, the lowest
 *   supported effort. (grok: xhigh→high, max→high, low→low.)
 *
 * Pure read over catalog state — never mutates session/user settings.
 */
export function clampEffortToModel(modelId: string, effort: string): string {
  const supported = modelCatalog.getEffortsFor(modelId);
  if (!supported || supported.length === 0) return effort;
  const normalized = effort.trim().toLowerCase();
  if (supported.includes(normalized)) return normalized === effort ? effort : normalized;

  const order = CANONICAL_EFFORT_ORDER as readonly string[];
  const requestedIdx = order.indexOf(normalized);
  if (requestedIdx === -1) return effort;

  const ranked = supported.filter((e) => order.includes(e)).sort((a, b) => order.indexOf(a) - order.indexOf(b));
  if (ranked.length === 0) return effort;
  for (let i = requestedIdx; i >= 0; i--) {
    const candidate = order[i];
    if (ranked.includes(candidate)) return candidate;
  }
  return ranked[0];
}
