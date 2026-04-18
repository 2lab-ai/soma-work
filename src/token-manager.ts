/**
 * TokenManager — slotId-keyed pool of Claude Code credentials backed by
 * the CctStore.
 *
 * Responsibilities:
 *   - Maintain the registry of slots (setup_token or oauth_credentials).
 *   - Select the active slot; surface its fresh access token through
 *     `acquireLease()`. Callers forward the lease's token to the Claude
 *     Agent SDK per-call via `buildQueryEnv(lease)` → `options.env`.
 *     TokenManager NEVER writes to `process.env.CLAUDE_CODE_OAUTH_TOKEN`.
 *   - Rotate on rate-limit and manual requests, skipping tombstoned /
 *     revoked / cooling / refresh_failed slots.
 *   - Manage leases (replaces refcount): acquire / heartbeat / release,
 *     with a background reaper sweeping expired leases.
 *   - Refresh OAuth credentials proactively (7 h before expiry) with
 *     in-process `Map<slotId, Promise<string>>` dedupe and cross-process
 *     serialisation via `store.withLock`.
 *   - Fetch and persist usage snapshots with 429 backoff, 401-then-refresh
 *     retry, and 403 → authState=revoked transitions.
 *
 * Lock ordering (STRICT):
 *   The ONLY cross-process lock is `cct-store.lock`, obtained via
 *   `CctStore.withLock(fn)` or `CctStore.save(...)`. Refresh-token
 *   and usage-cache serialisation is achieved by the combination of
 *   in-process dedupe maps (`Map<slotId, Promise>`) and the single
 *   store lock — we deliberately avoid a second lockfile to keep the
 *   lock ordering trivial: caller → store lock → done. HTTP calls are
 *   made OUTSIDE the store lock; we re-acquire the lock only to persist
 *   results.
 */

import { promises as fsPromises } from 'node:fs';
import * as path from 'node:path';
import { ulid } from 'ulid';
import type {
  AuthState,
  CctStoreSnapshot,
  Lease,
  OAuthCredentials,
  OAuthCredentialsSlot,
  RateLimitSource,
  SetupTokenSlot,
  SlotState,
  TokenSlot,
  UsageSnapshot,
} from './cct-store';
import { CctStore, defaultCctStorePath } from './cct-store';
import { Logger, redactAnthropicSecrets } from './logger';
import { OAuthRefreshError, refreshClaudeCredentials } from './oauth/refresher';
import { hasRequiredScopes, missingScopes } from './oauth/scope-check';
import { fetchUsage, UsageFetchError, usageBackoffForFailureCount } from './oauth/usage';

const logger = new Logger('TokenManager');

// Default timings
const DEFAULT_LEASE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const REFRESH_BUFFER_MS = 7 * 60 * 60 * 1000; // 7 hours
const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000; // 60 minutes
const DEFAULT_REAPER_INTERVAL_MS = 30 * 1000; // 30 seconds
// Anthropic's shortest rate-limit bucket is 5h. If a stale `rateLimitedAt`
// survives past this window with no cooldownUntil to close it, treat it as
// stale and refresh on the next hint — prevents indefinite stickiness.
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 60 * 1000;

/** Month abbreviation → 0-based month index — preserved for legacy cooldown-string parsing. */
const MONTH_MAP: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

/**
 * Parse cooldown reset time from rate-limit error messages (preserved
 * from the legacy TokenManager so consumers can continue to use it).
 *
 * Supported formats:
 *   - 5-hour limit:  "resets 7pm",  "resets 7:30pm"
 *   - Weekly limit:  "resets Apr 7, 7pm (Asia/Seoul)"
 */
export function parseCooldownTime(message: string): Date | null {
  const match = message.match(
    /resets?\s+(?:(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i,
  );
  if (!match) return null;
  const monthStr = match[1];
  const dayStr = match[2];
  let hours = parseInt(match[3], 10);
  const minutes = match[4] ? parseInt(match[4], 10) : 0;
  const period = match[5].toLowerCase();
  if (period === 'pm' && hours < 12) hours += 12;
  if (period === 'am' && hours === 12) hours = 0;

  const now = new Date();
  const cooldown = new Date(now);
  cooldown.setHours(hours, minutes, 0, 0);
  if (monthStr && dayStr) {
    const monthIndex = MONTH_MAP[monthStr.toLowerCase()];
    if (monthIndex !== undefined) {
      cooldown.setMonth(monthIndex, parseInt(dayStr, 10));
      if (cooldown <= now) cooldown.setFullYear(cooldown.getFullYear() + 1);
    }
  } else {
    if (cooldown <= now) cooldown.setDate(cooldown.getDate() + 1);
  }
  return cooldown;
}

// ── Types exposed to consumers ─────────────────────────────────

export interface TokenSummary {
  readonly slotId: string;
  readonly name: string;
  readonly kind: TokenSlot['kind'];
  readonly status: string;
}

export interface ActiveTokenInfo {
  readonly slotId: string;
  readonly name: string;
  readonly kind: TokenSlot['kind'];
  /** Private CLAUDE_CONFIG_DIR for oauth_credentials slots (schema v2). */
  readonly configDir?: string;
}

export interface AddSetupTokenInput {
  name: string;
  kind: 'setup_token';
  value: string;
}

export interface AddOAuthCredentialsInput {
  name: string;
  kind: 'oauth_credentials';
  credentials: OAuthCredentials;
  acknowledgedConsumerTosRisk: true;
}

export type AddSlotInput = AddSetupTokenInput | AddOAuthCredentialsInput;

/**
 * The result of {@link TokenManager.acquireLease} — a bundle of everything
 * a caller needs to spawn a Claude CLI call against the picked slot:
 * the lease identifier (for release/heartbeat), the slot identity, the
 * fresh access token, and the optional per-slot `configDir`.
 */
export interface AcquiredLease {
  readonly leaseId: string;
  readonly slotId: string;
  readonly name: string;
  readonly kind: 'setup_token' | 'oauth_credentials';
  readonly accessToken: string;
  readonly configDir?: string;
}

/**
 * Thrown by {@link TokenManager.acquireLease} when every retry attempt
 * observed the picked slot disappearing or transitioning to an
 * ineligible state mid-flight.
 */
export class NoEligibleSlotError extends Error {
  constructor(message: string = 'acquireLease: no eligible slot after retries') {
    super(message);
    this.name = 'NoEligibleSlotError';
  }
}

export interface RotateOnRateLimitOptions {
  source: RateLimitSource;
  rateLimitedAt?: string;
  cooldownMinutes?: number;
}

export interface TokenManagerInitOptions {
  startReaper?: boolean;
  reaperIntervalMs?: number;
}

// ── Utility: mask a token for safe display ─────────────────────

function maskToken(value: string): string {
  if (value.length <= 33) return value;
  return `${value.slice(0, 20)}...${value.slice(-10)}`;
}

/** Resolve ${VAR_NAME} references from process.env */
function resolveEnvRef(value: string): string {
  const match = value.match(/^\$\{(\w+)\}$/);
  if (match) {
    const resolved = process.env[match[1]];
    if (resolved) return resolved;
  }
  return value;
}

// ── Slot helpers ───────────────────────────────────────────────

function isEligible(state: SlotState | undefined, nowMs: number): boolean {
  if (!state) return true;
  if (state.tombstoned) return false;
  if (state.authState === 'revoked' || state.authState === 'refresh_failed') return false;
  if (state.cooldownUntil) {
    const untilMs = new Date(state.cooldownUntil).getTime();
    if (Number.isFinite(untilMs) && untilMs > nowMs) return false;
  }
  return true;
}

function deriveStatus(state: SlotState | undefined, nowMs: number): string {
  if (!state) return 'healthy';
  const tags: string[] = [];
  if (state.tombstoned) tags.push('tombstoned');
  if (state.authState !== 'healthy') tags.push(state.authState);
  if (state.cooldownUntil) {
    const untilMs = new Date(state.cooldownUntil).getTime();
    if (untilMs > nowMs) tags.push('cooling');
  }
  if (state.activeLeases.length > 0) tags.push(`leases:${state.activeLeases.length}`);
  return tags.length === 0 ? 'healthy' : tags.join(',');
}

function resolveActiveTokenValue(slot: TokenSlot): string {
  if (slot.kind === 'setup_token') return slot.value;
  return slot.credentials.accessToken;
}

/**
 * Best-effort rm-rf of a per-slot `configDir`. ENOENT is silent (the dir
 * was already cleaned up — no-op); other errors log a warning but never
 * throw so lifecycle mutations stay resilient to filesystem quirks.
 */
async function removeConfigDirBestEffort(dir: string): Promise<void> {
  try {
    await fsPromises.rm(dir, { recursive: true, force: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') return;
    logger.warn(`configDir rm-rf failed for ${dir}`, err);
  }
}

// ── TokenManager class ─────────────────────────────────────────

export class TokenManager {
  private readonly store: CctStore;
  private readonly refreshInFlight: Map<string, Promise<string>> = new Map();
  private reaperTimer: NodeJS.Timeout | null = null;
  private reaperIntervalMs = DEFAULT_REAPER_INTERVAL_MS;
  private initPromise: Promise<void> | null = null;
  /** Resolves once `init()` finishes its first pass (load + legacy seed). */
  public readonly cooldownsRestored: Promise<void>;
  private cooldownsRestoredResolve!: () => void;

  constructor(store: CctStore) {
    this.store = store;
    this.cooldownsRestored = new Promise<void>((resolve) => {
      this.cooldownsRestoredResolve = resolve;
    });
  }

  /**
   * Load the store, run the legacy migrator (triggered implicitly by
   * `store.load()`), seed from env if needed, and optionally start the
   * lease reaper. Safe to call multiple times — subsequent calls await
   * the original init.
   */
  async init(opts: TokenManagerInitOptions = {}): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.doInit(opts);
    }
    await this.initPromise;
  }

  private async doInit(opts: TokenManagerInitOptions): Promise<void> {
    // 1. Before any store call, preserve legacy cooldowns by name — the
    //    store's migrator will rename the legacy file on first load(),
    //    but if the registry is still empty at that point any entries
    //    become "orphans". We capture them here so we can re-apply them
    //    to matching slot names after env seeding.
    const legacyCooldownsByName = await this.peekLegacyCooldownsByName();

    // 1a. Persist any v1→v2 schema upgrade exactly once, before any further
    //     mutate (which would otherwise race with the upgrade). This also
    //     provisions each oauth slot's private CLAUDE_CONFIG_DIR.
    try {
      await this.store.upgradeIfNeeded();
    } catch (err) {
      logger.warn('upgradeIfNeeded failed (continuing with v1-on-disk shape)', err);
    }

    // 2. load() runs legacy-cooldowns migration inside cct-store. Since
    //    the file on disk may be empty/missing, this is safe.
    const snap = await this.store.load();

    // 3. Seed from env if registry is empty and seeding is not disabled
    const envSeedingDisabled = process.env.SOMA_CCT_DISABLE_ENV_SEED === 'true';
    if (snap.registry.slots.length === 0 && !envSeedingDisabled) {
      await this.seedFromEnv();
    }

    // 4. If we captured legacy cooldowns before seeding, re-apply them
    //    now that the slots exist.
    if (legacyCooldownsByName.size > 0) {
      await this.store.mutate((s) => {
        for (const slot of s.registry.slots) {
          const until = legacyCooldownsByName.get(slot.name);
          if (!until) continue;
          const prev = s.state[slot.slotId] ?? { authState: 'healthy' as AuthState, activeLeases: [] };
          s.state[slot.slotId] = { ...prev, cooldownUntil: until };
        }
      });
    }

    // 5. Re-read; ensure activeSlotId + process.env reflect an actual slot
    await this.ensureActiveSlot();

    // 6. Optional reaper
    if (opts.startReaper) {
      this.reaperIntervalMs = opts.reaperIntervalMs ?? DEFAULT_REAPER_INTERVAL_MS;
      this.startReaperTimer();
    }

    await this.refreshCache();
    this.cooldownsRestoredResolve();
  }

  /**
   * Peek at the legacy `token-cooldowns.json` file (if present) BEFORE
   * calling `store.load()` for the first time — because the store's
   * migrator will consume and rename the file on first load, losing any
   * matches against slots that don't yet exist.
   */
  private async peekLegacyCooldownsByName(): Promise<Map<string, string>> {
    const filePath = this.store.getFilePath();
    const dir = path.dirname(filePath);
    if (!dir) return new Map();
    const legacyPath = path.join(dir, 'token-cooldowns.json');
    try {
      const raw = await fsPromises.readFile(legacyPath, 'utf8');
      const parsed = JSON.parse(raw) as {
        entries?: Array<{ name?: unknown; cooldownUntil?: unknown }>;
        cooldowns?: Record<string, { until?: unknown } | undefined>;
      };
      const out = new Map<string, string>();
      if (Array.isArray(parsed.entries)) {
        for (const entry of parsed.entries) {
          if (entry && typeof entry.name === 'string' && typeof entry.cooldownUntil === 'string') {
            out.set(entry.name, entry.cooldownUntil);
          }
        }
      }
      if (parsed.cooldowns && typeof parsed.cooldowns === 'object') {
        for (const [name, value] of Object.entries(parsed.cooldowns)) {
          if (value && typeof value.until === 'string') {
            out.set(name, value.until);
          }
        }
      }
      return out;
    } catch {
      return new Map();
    }
  }

  /**
   * Parse `CLAUDE_CODE_OAUTH_TOKEN_LIST` / `CLAUDE_CODE_OAUTH_TOKEN` and
   * append setup_token slots. Only called when the registry is empty.
   */
  private async seedFromEnv(): Promise<void> {
    const list = process.env.CLAUDE_CODE_OAUTH_TOKEN_LIST;
    const single = process.env.CLAUDE_CODE_OAUTH_TOKEN;

    if (list) {
      const entries = list
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      if (entries.length === 0) return;

      const parsed: Array<{ name: string; value: string }> = entries.map((entry, i) => {
        // Accept both `name:value` (new spec) and `name=value` (legacy).
        const sep = ((): number => {
          const ci = entry.indexOf(':');
          const ei = entry.indexOf('=');
          if (ci === -1) return ei;
          if (ei === -1) return ci;
          return Math.min(ci, ei);
        })();
        if (sep > 0) {
          const name = entry.slice(0, sep);
          const rawValue = entry.slice(sep + 1);
          return { name, value: resolveEnvRef(rawValue) };
        }
        return { name: `cct${i + 1}`, value: resolveEnvRef(entry) };
      });

      for (const { name, value } of parsed) {
        await this.addSlot({ name, kind: 'setup_token', value });
      }
      logger.info(`TokenManager: seeded ${parsed.length} slots from CLAUDE_CODE_OAUTH_TOKEN_LIST`);
      return;
    }

    if (single) {
      await this.addSlot({ name: 'legacy', kind: 'setup_token', value: single });
      logger.info('TokenManager: seeded 1 slot from CLAUDE_CODE_OAUTH_TOKEN');
    }
  }

  /**
   * Ensure activeSlotId is set to a real slot. If the current active slot is
   * ineligible, we pick the next healthy one.
   *
   * The active token is NOT mirrored to `process.env` — consumers obtain the
   * token per-call via `acquireLease().accessToken` and pass it to the Agent
   * SDK through `options.env` (see `src/auth/query-env-builder.ts`). This
   * avoids a cross-tenant race where concurrent dispatches clobber each
   * other's `CLAUDE_CODE_OAUTH_TOKEN`.
   */
  private async ensureActiveSlot(): Promise<void> {
    await this.store.mutate((snap) => {
      if (snap.registry.slots.length === 0) {
        delete snap.registry.activeSlotId;
        return;
      }
      const now = Date.now();
      const currentId = snap.registry.activeSlotId;
      const currentSlot = currentId ? snap.registry.slots.find((s) => s.slotId === currentId) : undefined;
      if (!currentSlot || !isEligible(snap.state[currentSlot.slotId], now)) {
        // Prefer first healthy; else first slot.
        const preferred =
          snap.registry.slots.find((s) => isEligible(snap.state[s.slotId], now)) ?? snap.registry.slots[0];
        snap.registry.activeSlotId = preferred.slotId;
      }
    });
  }

  private getActiveSlotFromSnap(snap: CctStoreSnapshot): TokenSlot | null {
    const id = snap.registry.activeSlotId;
    if (!id) return null;
    return snap.registry.slots.find((s) => s.slotId === id) ?? null;
  }

  // ── Public API ────────────────────────────────────────────

  listTokens(): TokenSummary[] {
    // Synchronous read: we trust the most recent snapshot we saw via
    // store.load(). For a fully authoritative read consumers can call
    // `store.load()` directly — but listTokens is used for display only.
    // Implemented as an async read exposed synchronously via a promise
    // cache would complicate the API; instead, consumers that need a
    // fresh view should `await tm.init()` before calling.
    // For simplicity we perform a blocking read via a cached snapshot.
    return this.loadCachedSync();
  }

  /**
   * Public, authoritative read of the persisted CCT store snapshot.
   *
   * Prefer this over duck-typing `(tm as any).store.load()` at call sites
   * that need the full {@link CctStoreSnapshot} (registry + per-slot state).
   */
  async getSnapshot(): Promise<CctStoreSnapshot> {
    return this.store.load();
  }

  /** Cached synchronous summary — refreshed on each write-through API. */
  private cachedSummary: TokenSummary[] = [];
  private cachedActive: ActiveTokenInfo | null = null;

  private loadCachedSync(): TokenSummary[] {
    return this.cachedSummary;
  }

  private async refreshCache(): Promise<void> {
    const snap = await this.store.load();
    const now = Date.now();
    this.cachedSummary = snap.registry.slots.map((s) => ({
      slotId: s.slotId,
      name: s.name,
      kind: s.kind,
      status: deriveStatus(snap.state[s.slotId], now),
    }));
    const active = this.getActiveSlotFromSnap(snap);
    if (active) {
      this.cachedActive = {
        slotId: active.slotId,
        name: active.name,
        kind: active.kind,
        configDir: active.kind === 'oauth_credentials' ? active.configDir : undefined,
      };
    } else {
      this.cachedActive = null;
    }
  }

  getActiveToken(): ActiveTokenInfo | null {
    return this.cachedActive;
  }

  async applyToken(slotId: string): Promise<void> {
    await this.store.mutate((snap) => {
      const slot = snap.registry.slots.find((s) => s.slotId === slotId);
      if (!slot) throw new Error(`applyToken: unknown slotId ${slotId}`);
      snap.registry.activeSlotId = slotId;
    });
    const snap = await this.store.load();
    const slot = this.getActiveSlotFromSnap(snap);
    if (slot) {
      logger.info(
        `applyToken: active=${slot.name} (${maskToken(resolveActiveTokenValue(slot))})`,
        redactAnthropicSecrets({ slotId, name: slot.name }) as Record<string, unknown>,
      );
    }
    await this.refreshCache();
  }

  async rotateToNext(): Promise<{ slotId: string; name: string } | null> {
    const result = await this.store.mutate<{ slotId: string; name: string } | null>((snap) => {
      if (snap.registry.slots.length <= 1) return null;
      const now = Date.now();
      const currentIndex = snap.registry.slots.findIndex((s) => s.slotId === snap.registry.activeSlotId);
      const startIndex = currentIndex >= 0 ? currentIndex : 0;
      const len = snap.registry.slots.length;
      for (let i = 1; i < len; i++) {
        const idx = (startIndex + i) % len;
        const candidate = snap.registry.slots[idx];
        if (isEligible(snap.state[candidate.slotId], now)) {
          snap.registry.activeSlotId = candidate.slotId;
          return { slotId: candidate.slotId, name: candidate.name };
        }
      }
      return null;
    });
    if (result) {
      await this.refreshCache();
    }
    return result;
  }

  async rotateOnRateLimit(
    reason?: string,
    opts?: RotateOnRateLimitOptions,
  ): Promise<{ slotId: string; name: string } | null> {
    const effectiveOpts: RotateOnRateLimitOptions = opts ?? { source: 'manual' };
    const source = effectiveOpts.source;
    const cooldownMs = (effectiveOpts.cooldownMinutes ?? DEFAULT_COOLDOWN_MS / 60_000) * 60_000;
    const nowIso = new Date().toISOString();
    const nowMs = Date.now();
    const cooldownUntilIso = new Date(nowMs + cooldownMs).toISOString();

    const rotated = await this.store.mutate<{ slotId: string; name: string } | null>((snap) => {
      const currentId = snap.registry.activeSlotId;
      if (!currentId) return null;
      const state = snap.state[currentId] ?? { authState: 'healthy' as AuthState, activeLeases: [] };
      // rate-limit timestamp hygiene: overwrite if previous window has
      // expired (no cooldownUntil or cooldownUntil has passed), OR if the
      // existing `rateLimitedAt` has aged past RATE_LIMIT_WINDOW_MS (5h)
      // without a cooldown closing it — prevents a stale timestamp from
      // sticking forever when the cooldown field is absent.
      const prevUntilMs = state.cooldownUntil ? new Date(state.cooldownUntil).getTime() : 0;
      const prevRateLimitedAtMs = state.rateLimitedAt ? new Date(state.rateLimitedAt).getTime() : 0;
      const windowOpen =
        !state.rateLimitedAt ||
        (prevUntilMs > 0 && prevUntilMs <= nowMs) ||
        nowMs - prevRateLimitedAtMs > RATE_LIMIT_WINDOW_MS;
      if (windowOpen) {
        state.rateLimitedAt = effectiveOpts.rateLimitedAt ?? nowIso;
        state.rateLimitSource = source;
      }
      state.cooldownUntil = cooldownUntilIso;
      snap.state[currentId] = state;

      // rotate to next eligible
      if (snap.registry.slots.length > 1) {
        const currentIndex = snap.registry.slots.findIndex((s) => s.slotId === currentId);
        const startIndex = currentIndex >= 0 ? currentIndex : 0;
        const len = snap.registry.slots.length;
        for (let i = 1; i < len; i++) {
          const idx = (startIndex + i) % len;
          const candidate = snap.registry.slots[idx];
          if (isEligible(snap.state[candidate.slotId], nowMs)) {
            snap.registry.activeSlotId = candidate.slotId;
            return { slotId: candidate.slotId, name: candidate.name };
          }
        }
      }
      return null;
    });

    await this.refreshCache();
    logger.info(
      `rotateOnRateLimit: ${reason ?? '(no reason)'} source=${source} rotated=${rotated ? rotated.name : 'none'}`,
    );
    return rotated;
  }

  async recordRateLimitHint(slotId: string, source: RateLimitSource, cooldownUntil?: string): Promise<void> {
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    await this.store.mutate((snap) => {
      const state = snap.state[slotId] ?? { authState: 'healthy' as AuthState, activeLeases: [] };
      const prevUntilMs = state.cooldownUntil ? new Date(state.cooldownUntil).getTime() : 0;
      const prevRateLimitedAtMs = state.rateLimitedAt ? new Date(state.rateLimitedAt).getTime() : 0;
      const windowOpen =
        !state.rateLimitedAt ||
        (prevUntilMs > 0 && prevUntilMs <= nowMs) ||
        nowMs - prevRateLimitedAtMs > RATE_LIMIT_WINDOW_MS;
      if (windowOpen) {
        state.rateLimitedAt = nowIso;
        state.rateLimitSource = source;
      }
      if (cooldownUntil !== undefined) state.cooldownUntil = cooldownUntil;
      snap.state[slotId] = state;
    });
    await this.refreshCache();
  }

  async clearRateLimitFlag(slotId: string): Promise<void> {
    await this.store.mutate((snap) => {
      const state = snap.state[slotId];
      if (!state) return;
      delete state.rateLimitedAt;
      delete state.rateLimitSource;
      delete state.cooldownUntil;
    });
    await this.refreshCache();
  }

  // ── Leases ────────────────────────────────────────────────

  /**
   * Pick an eligible slot, append a {@link Lease} in a single CAS, and
   * return everything the caller needs to dispatch a Claude CLI call:
   * `leaseId`, the slot identity, a fresh access token (refreshed outside
   * the store lock for oauth_credentials slots), and the per-slot
   * `configDir` when present.
   *
   * Retry loop: after the mutate commits we re-validate the picked slot —
   * if the slot has since been removed / tombstoned / revoked (race with
   * `removeSlot` or `markAuthState`), we release the stale lease and try
   * again. `MAX_RETRIES = 3` by design: one normal pick + two revalidation
   * retries.
   *
   * Refresh-errors (401/403/network) bubble WITHOUT a retry — preserves the
   * existing semantics where a refresh failure is a client-visible error.
   */
  async acquireLease(ownerTag: string, ttlMs: number = DEFAULT_LEASE_TTL_MS): Promise<AcquiredLease> {
    const MAX_RETRIES = 3;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const leaseId = ulid();
      const acquiredAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + ttlMs).toISOString();
      const lease: Lease = { leaseId, ownerTag, acquiredAt, expiresAt };

      interface Allocated {
        slotId: string;
        name: string;
        kind: 'setup_token' | 'oauth_credentials';
        configDir?: string;
        staticToken?: string;
      }

      const allocated: Allocated = await this.store.mutate<Allocated>((snap) => {
        if (snap.registry.slots.length === 0) {
          throw new Error('acquireLease: no slots available');
        }
        const now = Date.now();
        const activeId = snap.registry.activeSlotId;
        const activeSlot = activeId ? snap.registry.slots.find((s) => s.slotId === activeId) : undefined;
        let picked: TokenSlot;
        if (activeSlot && isEligible(snap.state[activeSlot.slotId], now)) {
          picked = activeSlot;
        } else {
          const candidate = snap.registry.slots.find((s) => isEligible(snap.state[s.slotId], now));
          if (!candidate) {
            throw new Error('acquireLease: no healthy slot available');
          }
          picked = candidate;
          snap.registry.activeSlotId = candidate.slotId;
        }
        const state = snap.state[picked.slotId] ?? { authState: 'healthy' as AuthState, activeLeases: [] };
        state.activeLeases = [...state.activeLeases, lease];
        snap.state[picked.slotId] = state;
        const out: Allocated = {
          slotId: picked.slotId,
          name: picked.name,
          kind: picked.kind,
          configDir: picked.kind === 'oauth_credentials' ? picked.configDir : undefined,
          staticToken: picked.kind === 'setup_token' ? picked.value : undefined,
        };
        return out;
      });

      // Resolve the fresh access token OUTSIDE the store lock so HTTP
      // calls can't starve other writers.
      let accessToken: string;
      if (allocated.kind === 'oauth_credentials') {
        accessToken = await this.getValidAccessToken(allocated.slotId);
      } else {
        accessToken = allocated.staticToken ?? '';
      }

      // Re-validate: if the slot was tombstoned/removed/revoked while we
      // were refreshing (or between the mutate and the re-check), drop the
      // stale lease and retry. This is the race the 3-retry loop closes —
      // `removeSlot` can tombstone between our pick and our caller's use.
      const snap = await this.store.load();
      const st = snap.registry.slots.find((s) => s.slotId === allocated.slotId);
      const slotState = snap.state[allocated.slotId];
      const stillEligible = !!st && !slotState?.tombstoned && slotState?.authState !== 'revoked';
      if (stillEligible) {
        await this.refreshCache();
        logger.debug(`acquireLease ${leaseId} on ${allocated.slotId} (ownerTag=${ownerTag})`);
        return {
          leaseId,
          slotId: allocated.slotId,
          name: allocated.name,
          kind: allocated.kind,
          accessToken,
          configDir: allocated.configDir,
        };
      }

      // Slot disappeared / transitioned mid-flight — release the stale
      // lease (best-effort) and try again.
      await this.releaseLease(leaseId).catch((relErr) => {
        logger.warn('acquireLease: stale-lease release failed', relErr);
      });
    }

    throw new NoEligibleSlotError('acquireLease: no eligible slot after retries');
  }

  async heartbeatLease(leaseId: string): Promise<void> {
    const nowMs = Date.now();
    const found = await this.store.mutate((snap) => {
      for (const [slotId, state] of Object.entries(snap.state)) {
        const idx = state.activeLeases.findIndex((l) => l.leaseId === leaseId);
        if (idx >= 0) {
          const lease = state.activeLeases[idx];
          const expiresMs = new Date(lease.expiresAt).getTime();
          if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) {
            return false;
          }
          // Extend by the same TTL the lease originally had (approximation: reuse the default).
          const originalTtl = Math.max(DEFAULT_LEASE_TTL_MS, expiresMs - new Date(lease.acquiredAt).getTime());
          const nextExpires = new Date(nowMs + originalTtl).toISOString();
          state.activeLeases[idx] = { ...lease, expiresAt: nextExpires };
          snap.state[slotId] = state;
          return true;
        }
      }
      return false;
    });
    if (!found) {
      throw new Error(`heartbeatLease: unknown or expired lease ${leaseId}`);
    }
  }

  async releaseLease(leaseId: string): Promise<void> {
    await this.store.mutate((snap) => {
      for (const [slotId, state] of Object.entries(snap.state)) {
        const next = state.activeLeases.filter((l) => l.leaseId !== leaseId);
        if (next.length !== state.activeLeases.length) {
          snap.state[slotId] = { ...state, activeLeases: next };
          return;
        }
      }
    });
    await this.refreshCache();
  }

  async reapExpiredLeases(): Promise<void> {
    const nowMs = Date.now();
    // Collect configDirs of oauth slots that get fully reaped so we can
    // clean them up on disk after the mutate commits.
    const reapedConfigDirs: string[] = [];
    await this.store.mutate((snap) => {
      for (const [slotId, state] of Object.entries(snap.state)) {
        const kept = state.activeLeases.filter((l) => new Date(l.expiresAt).getTime() > nowMs);
        if (kept.length !== state.activeLeases.length) {
          snap.state[slotId] = { ...state, activeLeases: kept };
        }
      }
      // After trimming, fully remove tombstoned-with-no-leases slots.
      const survivors: TokenSlot[] = [];
      for (const slot of snap.registry.slots) {
        const state = snap.state[slot.slotId];
        if (state?.tombstoned && state.activeLeases.length === 0) {
          if (slot.kind === 'oauth_credentials' && slot.configDir) {
            reapedConfigDirs.push(slot.configDir);
          }
          delete snap.state[slot.slotId];
          if (snap.registry.activeSlotId === slot.slotId) {
            delete snap.registry.activeSlotId;
          }
          continue;
        }
        survivors.push(slot);
      }
      snap.registry.slots = survivors;
    });
    // self-heal active if we just removed the active slot
    await this.ensureActiveSlot();
    await this.refreshCache();
    // Best-effort dir cleanup AFTER the mutate commits — ENOENT is silent,
    // other errors warn but do not throw.
    for (const dir of reapedConfigDirs) {
      await removeConfigDirBestEffort(dir);
    }
  }

  private startReaperTimer(): void {
    if (this.reaperTimer) return;
    this.reaperTimer = setInterval(() => {
      this.reapExpiredLeases().catch((err) => {
        logger.warn('reaper failed', err);
      });
    }, this.reaperIntervalMs);
    // allow Node to exit in tests
    if (typeof this.reaperTimer.unref === 'function') {
      this.reaperTimer.unref();
    }
  }

  stop(): void {
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }
  }

  // ── Slot CRUD ─────────────────────────────────────────────

  async addSlot(input: AddSlotInput): Promise<TokenSlot> {
    const slotId = ulid();
    const createdAt = new Date().toISOString();
    let newSlot: TokenSlot;
    let provisionedConfigDir: string | null = null;

    if (input.kind === 'setup_token') {
      const slot: SetupTokenSlot = {
        slotId,
        name: input.name,
        kind: 'setup_token',
        value: input.value,
        createdAt,
      };
      newSlot = slot;
    } else {
      if (!hasRequiredScopes(input.credentials.scopes)) {
        const missing = missingScopes(input.credentials.scopes);
        throw new Error(`addSlot: oauth_credentials missing required scope(s): ${missing.join(', ')}`);
      }
      if (input.acknowledgedConsumerTosRisk !== true) {
        throw new Error('addSlot: oauth_credentials requires acknowledgedConsumerTosRisk=true');
      }
      // Pre-compute + provision the per-slot config dir BEFORE the mutate
      // so the persisted snapshot always references a dir that exists on
      // disk. If the mutate subsequently fails we rm the dir (orphan cleanup).
      const configDir = path.join(this.store.dataDir(), 'cct-store.dirs', slotId);
      await fsPromises.mkdir(configDir, { recursive: true, mode: 0o700 });
      provisionedConfigDir = configDir;

      const slot: OAuthCredentialsSlot = {
        slotId,
        name: input.name,
        kind: 'oauth_credentials',
        credentials: input.credentials,
        createdAt,
        acknowledgedConsumerTosRisk: true,
        configDir,
      };
      newSlot = slot;
    }

    try {
      await this.store.mutate((snap) => {
        // CAS-protect name uniqueness: re-check inside the mutate callback so
        // two parallel `addSlot` calls for the same name can't both succeed —
        // the `CctStore.mutate` retry loop will re-run the loser's callback
        // against the winner's persisted snapshot, where the guard now trips.
        if (snap.registry.slots.some((s) => s.name === newSlot.name)) {
          throw new Error(`NAME_IN_USE:${newSlot.name}`);
        }
        snap.registry.slots.push(newSlot);
        snap.state[newSlot.slotId] = { authState: 'healthy', activeLeases: [] };
        if (!snap.registry.activeSlotId) {
          snap.registry.activeSlotId = newSlot.slotId;
        }
      });
    } catch (err) {
      // Orphan-cleanup: the dir on disk has no corresponding persisted
      // slot — remove it (best-effort; a failure to clean up is not fatal).
      if (provisionedConfigDir) {
        await fsPromises.rm(provisionedConfigDir, { recursive: true, force: true }).catch((cleanupErr) => {
          logger.warn('addSlot: orphan configDir cleanup failed', cleanupErr);
        });
      }
      throw err;
    }
    await this.refreshCache();
    logger.info(
      `addSlot: ${newSlot.name} kind=${newSlot.kind} slotId=${newSlot.slotId}`,
      redactAnthropicSecrets({ slotId: newSlot.slotId, name: newSlot.name }) as Record<string, unknown>,
    );
    return newSlot;
  }

  async renameSlot(slotId: string, newName: string): Promise<void> {
    await this.store.mutate((snap) => {
      const slot = snap.registry.slots.find((s) => s.slotId === slotId);
      if (!slot) throw new Error(`renameSlot: unknown slotId ${slotId}`);
      // CAS-protect name uniqueness (excluding self) so two parallel renames
      // can't both land the same name.
      if (snap.registry.slots.some((s) => s.slotId !== slotId && s.name === newName)) {
        throw new Error(`NAME_IN_USE:${newName}`);
      }
      slot.name = newName;
    });
    await this.refreshCache();
  }

  /**
   * Remove a slot. Two paths:
   *
   * - **Non-force / tombstone-drain** (default): when a slot has active
   *   leases, mark it `tombstoned` and let in-flight callers finish.
   *   The {@link reapExpiredLeases} sweeper eventually removes both the
   *   persisted slot entry AND its on-disk configDir (best-effort).
   *
   * - **Force**: remove immediately regardless of leases. The persisted
   *   slot is dropped in one `mutate`, then the oauth configDir is rm-rf'd
   *   best-effort. `force` is intentionally destructive — in-flight leases
   *   may observe ENOENT on transcripts if they race the rm. Reserved for
   *   operator intervention (`cct rm --force` / UI destructive action).
   */
  async removeSlot(
    slotId: string,
    opts: { force?: boolean } = {},
  ): Promise<{ removed: boolean; pendingDrain?: boolean }> {
    const force = opts.force === true;
    let removed = false;
    let pendingDrain = false;
    let removedConfigDir: string | null = null;
    await this.store.mutate((snap) => {
      const idx = snap.registry.slots.findIndex((s) => s.slotId === slotId);
      if (idx < 0) {
        removed = false;
        return;
      }
      const slot = snap.registry.slots[idx];
      const state = snap.state[slotId];
      const hasLeases = state ? state.activeLeases.length > 0 : false;
      if (hasLeases && !force) {
        // Tombstone + rotate active if needed
        snap.state[slotId] = { ...state, tombstoned: true };
        if (snap.registry.activeSlotId === slotId) {
          const now = Date.now();
          const replacement = snap.registry.slots.find(
            (s) => s.slotId !== slotId && isEligible(snap.state[s.slotId], now),
          );
          if (replacement) snap.registry.activeSlotId = replacement.slotId;
        }
        pendingDrain = true;
        removed = false;
        return;
      }
      // Full removal — remember the oauth configDir (if any) for best-effort
      // rm-rf after the mutate commits.
      if (slot.kind === 'oauth_credentials' && slot.configDir) {
        removedConfigDir = slot.configDir;
      }
      snap.registry.slots.splice(idx, 1);
      delete snap.state[slotId];
      if (snap.registry.activeSlotId === slotId) {
        const now = Date.now();
        const replacement = snap.registry.slots.find((s) => isEligible(snap.state[s.slotId], now));
        snap.registry.activeSlotId = replacement?.slotId;
      }
      removed = true;
    });
    await this.refreshCache();
    if (removedConfigDir) {
      await removeConfigDirBestEffort(removedConfigDir);
    }
    return pendingDrain ? { removed: false, pendingDrain: true } : { removed };
  }

  async markAuthState(slotId: string, state: AuthState): Promise<void> {
    await this.store.mutate((snap) => {
      const prev = snap.state[slotId] ?? { authState: 'healthy' as AuthState, activeLeases: [] };
      snap.state[slotId] = { ...prev, authState: state };
    });
    await this.refreshCache();
  }

  // ── Proactive refresh ─────────────────────────────────────

  async getValidAccessToken(slotId: string): Promise<string> {
    const snap = await this.store.load();
    const slot = snap.registry.slots.find((s) => s.slotId === slotId);
    if (!slot) throw new Error(`getValidAccessToken: unknown slotId ${slotId}`);
    if (slot.kind === 'setup_token') return slot.value;

    const nowMs = Date.now();
    const needsRefresh = slot.credentials.expiresAtMs - nowMs < REFRESH_BUFFER_MS;
    if (!needsRefresh) return slot.credentials.accessToken;

    return this.refreshAccessToken(slot);
  }

  async refreshCredentialsIfNeeded(slotId: string): Promise<void> {
    const snap = await this.store.load();
    const slot = snap.registry.slots.find((s) => s.slotId === slotId);
    if (!slot || slot.kind !== 'oauth_credentials') return;
    const nowMs = Date.now();
    if (slot.credentials.expiresAtMs - nowMs >= REFRESH_BUFFER_MS) return;
    await this.refreshAccessToken(slot);
  }

  /**
   * In-process dedupe: callers racing to refresh the same slot share a
   * single Promise. The actual HTTP call happens OUTSIDE any cct-store
   * lock; we acquire the lock only to persist the result.
   */
  private refreshAccessToken(slot: OAuthCredentialsSlot): Promise<string> {
    const existing = this.refreshInFlight.get(slot.slotId);
    if (existing) return existing;
    const promise = (async (): Promise<string> => {
      try {
        let next: OAuthCredentials;
        try {
          next = await refreshClaudeCredentials(slot.credentials);
        } catch (err) {
          if (err instanceof OAuthRefreshError) {
            if (err.status === 401) await this.markAuthState(slot.slotId, 'refresh_failed');
            else if (err.status === 403) await this.markAuthState(slot.slotId, 'revoked');
          }
          throw err;
        }
        // Persist — single-step under the store lock.
        await this.store.mutate((snap) => {
          const target = snap.registry.slots.find((s) => s.slotId === slot.slotId);
          if (!target || target.kind !== 'oauth_credentials') return;
          target.credentials = next;
          const st = snap.state[slot.slotId] ?? { authState: 'healthy' as AuthState, activeLeases: [] };
          st.authState = 'healthy';
          snap.state[slot.slotId] = st;
        });
        await this.refreshCache();
        logger.info(
          'refreshAccessToken: success',
          redactAnthropicSecrets({ slotId: slot.slotId, name: slot.name }) as Record<string, unknown>,
        );
        return next.accessToken;
      } finally {
        this.refreshInFlight.delete(slot.slotId);
      }
    })();
    this.refreshInFlight.set(slot.slotId, promise);
    return promise;
  }

  // ── Usage fetch ───────────────────────────────────────────

  async fetchAndStoreUsage(slotId: string): Promise<UsageSnapshot | null> {
    const snap = await this.store.load();
    const slot = snap.registry.slots.find((s) => s.slotId === slotId);
    if (!slot || slot.kind !== 'oauth_credentials') return null;
    const state = snap.state[slotId];
    const nowMs = Date.now();
    if (state?.nextUsageFetchAllowedAt) {
      const allowedMs = new Date(state.nextUsageFetchAllowedAt).getTime();
      if (Number.isFinite(allowedMs) && allowedMs > nowMs) return null;
    }

    // Ensure fresh access token (proactive refresh)
    let accessToken: string;
    try {
      accessToken = await this.getValidAccessToken(slotId);
    } catch (err) {
      logger.warn('fetchAndStoreUsage: refresh failed pre-fetch', err);
      return null;
    }

    const doFetch = async (token: string) => fetchUsage(token);

    let result: Awaited<ReturnType<typeof fetchUsage>> | null = null;
    try {
      result = await doFetch(accessToken);
    } catch (err) {
      if (err instanceof UsageFetchError) {
        if (err.status === 401) {
          // Attempt one refresh then retry.
          try {
            await this.refreshCredentialsIfNeeded(slotId);
            const fresh = await this.getValidAccessToken(slotId);
            result = await doFetch(fresh);
          } catch (retryErr) {
            await this.applyUsageFailureBackoff(slotId);
            logger.warn('fetchAndStoreUsage: 401→refresh→retry failed', retryErr);
            return null;
          }
        } else if (err.status === 403) {
          await this.markAuthState(slotId, 'revoked');
          return null;
        } else if (err.status === 429) {
          await this.applyUsageFailureBackoff(slotId);
          return null;
        } else {
          await this.applyUsageFailureBackoff(slotId);
          logger.warn(`fetchAndStoreUsage: non-OK ${err.status}`, err);
          return null;
        }
      } else {
        await this.applyUsageFailureBackoff(slotId);
        logger.warn('fetchAndStoreUsage: unexpected error', err);
        return null;
      }
    }

    if (!result) return null;
    const settled = result;

    await this.store.mutate((snap2) => {
      const st = snap2.state[slotId] ?? { authState: 'healthy' as AuthState, activeLeases: [] };
      st.usage = settled.snapshot;
      st.lastUsageFetchedAt = settled.snapshot.fetchedAt;
      st.nextUsageFetchAllowedAt = new Date(settled.nextFetchAllowedAtMs).toISOString();
      st.consecutiveUsageFailures = 0;
      snap2.state[slotId] = st;
    });
    return settled.snapshot;
  }

  private async applyUsageFailureBackoff(slotId: string): Promise<void> {
    await this.store.mutate((s) => {
      const st = s.state[slotId] ?? { authState: 'healthy' as AuthState, activeLeases: [] };
      const failureCount = (st.consecutiveUsageFailures ?? 0) + 1;
      // Ladder is 1-indexed from the caller's perspective — first failure → rung 0 (2m).
      const next = usageBackoffForFailureCount(failureCount - 1);
      st.consecutiveUsageFailures = failureCount;
      st.nextUsageFetchAllowedAt = new Date(Date.now() + next).toISOString();
      s.state[slotId] = st;
    });
  }
}

// ── Singleton factory ──────────────────────────────────────────

let singleton: TokenManager | null = null;

/**
 * Return a process-wide singleton TokenManager. First invocation
 * instantiates one backed by `defaultCctStorePath()`. Callers that need
 * a custom store should construct `new TokenManager(store)` directly
 * (convenient for tests).
 */
export function getTokenManager(): TokenManager {
  if (!singleton) {
    const storePath = defaultCctStorePath();
    singleton = new TokenManager(new CctStore(storePath));
  }
  return singleton;
}

/**
 * Reset the singleton (test-only).
 */
export function __resetTokenManagerSingleton(): void {
  if (singleton) singleton.stop();
  singleton = null;
}
