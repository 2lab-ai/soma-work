/**
 * TokenManager — keyId-keyed pool of AuthKey slots backed by the CctStore.
 *
 * Responsibilities:
 *   - Maintain the registry of AuthKey slots (`api_key` or `cct` with either
 *     `source: 'setup'` or `source: 'legacy-attachment'`).
 *   - Select the active slot; surface its fresh access token through
 *     `acquireLease()`. Callers forward the lease's token to the Claude
 *     Agent SDK per-call via `buildQueryEnv(lease)` → `options.env`.
 *     TokenManager NEVER writes to `process.env.CLAUDE_CODE_OAUTH_TOKEN`.
 *   - Rotate on rate-limit and manual requests, skipping tombstoned /
 *     revoked / cooling / refresh_failed slots.
 *   - Manage leases (replaces refcount): acquire / heartbeat / release,
 *     with a background reaper sweeping expired leases.
 *   - Refresh OAuth credentials proactively (7 h before expiry) with
 *     in-process `Map<keyId, Promise<string>>` dedupe and cross-process
 *     serialisation via `store.withLock`.
 *   - Fetch and persist usage snapshots with 429 backoff, 401-then-refresh
 *     retry, and 403 → authState=revoked transitions.
 *
 * Schema v2 notes (#575 PR-A):
 *   - Input DTOs still accept the legacy `kind: 'setup_token' | 'oauth_credentials'`
 *     strings so existing callers (Slack slash command, legacy seed paths)
 *     keep compiling. They are mapped internally to the v2 AuthKey shape
 *     before persist.
 *   - Public getters expose the v2 `keyId` / `kind: 'api_key' | 'cct'` surface.
 *     The returned slot objects are full AuthKey values — callers switch on
 *     `kind === 'cct'` + `source === 'setup' | 'legacy-attachment'`.
 *
 * Lock ordering (STRICT):
 *   The ONLY cross-process lock is `cct-store.lock`, obtained via
 *   `CctStore.withLock(fn)` or `CctStore.save(...)`. Refresh-token and
 *   usage-cache serialisation is achieved by the combination of in-process
 *   dedupe maps (`Map<keyId, Promise>`) and the single store lock — we
 *   deliberately avoid a second lockfile to keep the lock ordering trivial:
 *   caller → store lock → done. HTTP calls are made OUTSIDE the store lock;
 *   we re-acquire the lock only to persist results.
 */

import { promises as fsPromises } from 'node:fs';
import * as path from 'node:path';
import { ulid } from 'ulid';
import { type ApiKeySlot, type AuthKey, type CctSlot, type CctSlotWithSetup, isCctWithSetup, type OAuthAttachment } from './auth/auth-key';
import type { AuthState, CctStoreSnapshot, Lease, RateLimitSource, SlotState, UsageSnapshot } from './cct-store';
import { CctStore, defaultCctStorePath } from './cct-store';
import { config } from './config';
import { Logger, redactAnthropicSecrets } from './logger';
import { fetchOAuthProfile, type OAuthProfile, OAuthProfileUnauthorizedError } from './oauth/profile';
import type { OAuthCredentials } from './oauth/refresher';
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
  readonly keyId: string;
  readonly name: string;
  readonly kind: AuthKey['kind'];
  readonly status: string;
}

export interface ActiveTokenInfo {
  readonly keyId: string;
  readonly name: string;
  readonly kind: AuthKey['kind'];
}

/**
 * Legacy input DTO — a bare setupToken acquired from a Max seat. Mapped to
 * {@link CctSlotWithSetup} on persist.
 */
export interface AddSetupTokenInput {
  name: string;
  kind: 'setup_token';
  value: string;
}

/**
 * Legacy input DTO — an oauth_credentials blob without a matching setupToken.
 * Requires explicit ToS-risk acknowledgement and is mapped to
 * {@link CctSlot} with `source: 'legacy-attachment'` on persist.
 */
export interface AddOAuthCredentialsInput {
  name: string;
  kind: 'oauth_credentials';
  credentials: OAuthCredentials;
  acknowledgedConsumerTosRisk: true;
}

/**
 * Input DTO for a raw Anthropic `sk-ant-api03-…` commercial API key. Mapped
 * to {@link ApiKeySlot} on persist. Phase 1 scope (Z3): store-only — api_key
 * slots are runtime-fenced so callers can't select them as active until a
 * follow-up PR wires `ANTHROPIC_API_KEY` + isolated spawn.
 */
export interface AddApiKeyInput {
  name: string;
  kind: 'api_key';
  value: string;
}

export type AddSlotInput = AddSetupTokenInput | AddOAuthCredentialsInput | AddApiKeyInput;

/** Format guard for `sk-ant-api03-<base64url>` commercial API keys. */
export const API_KEY_REGEX = /^sk-ant-api03-[A-Za-z0-9_-]{8,}$/;

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

/**
 * Raised by `getValidAccessToken(keyId, 'oauth-api')` when the target slot
 * has no OAuth attachment — callers (`#doRefreshProfile`, `#doFetchAndStoreUsage`)
 * convert this to a `null` early-return via `#getOAuthApiAccessTokenOrNull`.
 * Never raised for `purpose: 'dispatch'`, which has a valid credential for
 * every slot kind.
 */
export class NoOAuthAttachmentError extends Error {
  constructor(keyId: string, kind: AuthKey['kind'], source?: CctSlot['source']) {
    super(`no OAuth attachment on slot ${keyId} (kind=${kind}, source=${source ?? 'n/a'})`);
    this.name = 'NoOAuthAttachmentError';
  }
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

/**
 * A slot whose dispatch credential (setupToken / api_key value) is independent
 * of its oauthAttachment's health. For such slots an `authState` of
 * `refresh_failed` / `revoked` only invalidates usage/profile reporting — it
 * does NOT prevent lease acquisition for dispatch. This is the #673 fix:
 * the attachment's 1h OAuth access_token must never gate a setup slot's lease.
 *
 * `legacy-attachment` intentionally does NOT qualify — it has no setupToken
 * fallback, so an unhealthy attachment disables dispatch too.
 */
function hasDispatchIndependentOfAttachment(slot: AuthKey | undefined): boolean {
  return slot !== undefined && isCctWithSetup(slot) && slot.setupToken.length > 0;
}

function isEligible(slot: AuthKey | undefined, state: SlotState | undefined, nowMs: number): boolean {
  // Operator-opt-out: `disableRotation` is an explicit keep-off-the-roster
  // flag that complements the health-based gates (tombstoned / revoked /
  // refresh_failed / cooldown). Applied first so an operator can park a slot
  // even when it's otherwise eligible (e.g. reserving a backup credential).
  if (slot?.disableRotation) return false;
  if (!state) return true;
  if (state.tombstoned) return false;
  // #673 — authState gates dispatch only when no setup-token fallback exists.
  if (
    !hasDispatchIndependentOfAttachment(slot) &&
    (state.authState === 'revoked' || state.authState === 'refresh_failed')
  ) {
    return false;
  }
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

/**
 * Dispatch-path sync resolver — mirrors `getValidAccessToken(..., 'dispatch')`
 * for use where an `await` is not possible (e.g. log formatting). The async
 * method is the canonical entry point and handles near-expiry refresh for
 * legacy-attachment; this helper skips the refresh but agrees on the three
 * kind/source branches. See `getValidAccessToken` for the full contract.
 *
 *   - `api_key`                            → slot.value
 *   - `cct` / `source:'setup'`             → slot.setupToken  (#673: never the attachment)
 *   - `cct` / `source:'legacy-attachment'` → oauthAttachment.accessToken
 */
function resolveActiveTokenValue(slot: AuthKey): string {
  if (slot.kind === 'api_key') return slot.value;
  if (isCctWithSetup(slot)) return slot.setupToken;
  return slot.oauthAttachment.accessToken;
}

/**
 * Is this slot a CCT slot that currently carries an OAuth attachment we
 * can refresh? Used to short-circuit the refresh flow for api_key slots
 * and setup-only slots that have not yet been attached.
 */
function hasOAuthAttachment(slot: AuthKey): slot is CctSlot & { oauthAttachment: OAuthAttachment } {
  return slot.kind === 'cct' && slot.oauthAttachment !== undefined;
}

/** Does this attachment need a proactive refresh given the near-expiry buffer? */
function needsAttachmentRefresh(attachment: OAuthAttachment, nowMs: number): boolean {
  return attachment.expiresAtMs - nowMs < REFRESH_BUFFER_MS;
}

// ── TokenManager class ─────────────────────────────────────────

export class TokenManager {
  private readonly store: CctStore;
  /**
   * In-process dedupe for concurrent `refreshAccessToken` calls.
   *
   * Codex P0 fix #3 (v4): the Map key is the COMPOSITE generation key
   * `${keyId}:${attachedAt ?? "legacy"}` so two concurrent generations of
   * the same slot can coexist in flight without evicting each other's
   * dedupe entry. Under the earlier `Map<keyId, {attachedAt, promise}>`
   * shape a newer generation would overwrite the older one's record;
   * subsequent callers on the older generation then saw a tag mismatch
   * and fired a SECOND network refresh even though the older promise was
   * still in flight. The composite key makes dedupe lossless across the
   * detach/reattach race window.
   */
  private readonly refreshInFlight: Map<string, Promise<string>> = new Map();
  /**
   * Per-keyId dedupe for `fetchAndStoreUsage`. Mirrors the `refreshInFlight`
   * pattern so multiple `fetchUsageForAllAttached` fan-outs racing on the
   * same slot hit the upstream usage endpoint once. Cleanup in `finally`.
   */
  private readonly usageFetchInFlight: Map<string, Promise<UsageSnapshot | null>> = new Map();
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

    // 2. load() runs legacy-cooldowns migration + v1→v2 AuthKey migration
    //    inside cct-store. Since the file on disk may be empty/missing,
    //    this is safe.
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
          const prev = s.state[slot.keyId] ?? { authState: 'healthy' as AuthState, activeLeases: [] };
          s.state[slot.keyId] = { ...prev, cooldownUntil: until };
        }
      });
    }

    // 5. Re-read; ensure activeKeyId reflects an actual slot.
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
   * append setup-token CCT slots. Only called when the registry is empty.
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
   * Ensure `activeKeyId` points at an eligible slot. If the current active
   * slot is ineligible, we pick the next healthy one.
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
        delete snap.registry.activeKeyId;
        return;
      }
      const now = Date.now();
      const currentId = snap.registry.activeKeyId;
      const currentSlot = currentId ? snap.registry.slots.find((s) => s.keyId === currentId) : undefined;
      // Z3 — api_key is not runtime-selectable in phase 1: treat a current
      // api_key activeKeyId as ineligible so we fall through and re-pick a
      // cct slot. Preferred pick also skips api_key, falling back to the
      // first cct slot if every cct is in cooldown / tombstoned. Only if
      // there is no cct slot at all do we unset activeKeyId entirely.
      const currentIneligible =
        !currentSlot || currentSlot.kind === 'api_key' || !isEligible(currentSlot, snap.state[currentSlot.keyId], now);
      if (currentIneligible) {
        const preferred =
          snap.registry.slots.find((s) => s.kind !== 'api_key' && isEligible(s, snap.state[s.keyId], now)) ??
          snap.registry.slots.find((s) => s.kind !== 'api_key');
        if (preferred) {
          snap.registry.activeKeyId = preferred.keyId;
        } else {
          delete snap.registry.activeKeyId;
        }
      }
    });
  }

  private getActiveSlotFromSnap(snap: CctStoreSnapshot): AuthKey | null {
    const id = snap.registry.activeKeyId;
    if (!id) return null;
    return snap.registry.slots.find((s) => s.keyId === id) ?? null;
  }

  // ── Public API ────────────────────────────────────────────

  listTokens(): TokenSummary[] {
    // Synchronous read: we trust the most recent snapshot we saw via
    // store.load(). For a fully authoritative read consumers can call
    // `store.load()` directly — but listTokens is used for display only.
    return this.loadCachedSync();
  }

  /**
   * Z3 runtime fence (PR-B phase1): return only slots that are currently
   * **runtime-selectable** — i.e. eligible for `cct set <name>` /
   * `cct usage <name>` / `rotateToNext` name-matching. `api_key` slots are
   * store-only in PR-B (add/list/remove via modal) and are deliberately
   * excluded so text-command callers can't bypass the fence by typing an
   * api_key slot name.
   *
   * When the follow-up issue wires `ANTHROPIC_API_KEY` spawn isolation,
   * this helper will start returning api_key slots too.
   */
  listRuntimeSelectableTokens(): TokenSummary[] {
    return this.listTokens().filter((t) => t.kind !== 'api_key');
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
      keyId: s.keyId,
      name: s.name,
      kind: s.kind,
      status: deriveStatus(snap.state[s.keyId], now),
    }));
    const active = this.getActiveSlotFromSnap(snap);
    this.cachedActive = active ? { keyId: active.keyId, name: active.name, kind: active.kind } : null;
  }

  getActiveToken(): ActiveTokenInfo | null {
    return this.cachedActive;
  }

  async applyToken(keyId: string): Promise<void> {
    await this.store.mutate((snap) => {
      const slot = snap.registry.slots.find((s) => s.keyId === keyId);
      if (!slot) throw new Error(`applyToken: unknown keyId ${keyId}`);
      // Z3 — api_key is not runtime-selectable in phase 1; callers must pick
      // a cct slot. The follow-up PR that wires ANTHROPIC_API_KEY + isolated
      // spawn will relax this fence.
      if (slot.kind === 'api_key') {
        throw new Error('applyToken: api_key is not runtime-selectable in phase 1');
      }
      snap.registry.activeKeyId = keyId;
    });
    const snap = await this.store.load();
    const slot = this.getActiveSlotFromSnap(snap);
    if (slot) {
      logger.info(
        `applyToken: active=${slot.name} (${maskToken(resolveActiveTokenValue(slot))})`,
        redactAnthropicSecrets({ keyId, name: slot.name }) as Record<string, unknown>,
      );
    }
    await this.refreshCache();
  }

  async rotateToNext(): Promise<{ keyId: string; name: string } | null> {
    const result = await this.store.mutate<{ keyId: string; name: string } | null>((snap) => {
      if (snap.registry.slots.length <= 1) return null;
      const now = Date.now();
      const currentIndex = snap.registry.slots.findIndex((s) => s.keyId === snap.registry.activeKeyId);
      const startIndex = currentIndex >= 0 ? currentIndex : 0;
      const len = snap.registry.slots.length;
      for (let i = 1; i < len; i++) {
        const idx = (startIndex + i) % len;
        const candidate = snap.registry.slots[idx];
        // Z3 — api_key is not runtime-selectable in phase 1; skip in rotation.
        if (candidate.kind === 'api_key') continue;
        if (isEligible(candidate, snap.state[candidate.keyId], now)) {
          snap.registry.activeKeyId = candidate.keyId;
          return { keyId: candidate.keyId, name: candidate.name };
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
  ): Promise<{ keyId: string; name: string } | null> {
    const effectiveOpts: RotateOnRateLimitOptions = opts ?? { source: 'manual' };
    const source = effectiveOpts.source;
    const cooldownMs = (effectiveOpts.cooldownMinutes ?? DEFAULT_COOLDOWN_MS / 60_000) * 60_000;
    const nowIso = new Date().toISOString();
    const nowMs = Date.now();
    const cooldownUntilIso = new Date(nowMs + cooldownMs).toISOString();

    const rotated = await this.store.mutate<{ keyId: string; name: string } | null>((snap) => {
      const currentId = snap.registry.activeKeyId;
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
        const currentIndex = snap.registry.slots.findIndex((s) => s.keyId === currentId);
        const startIndex = currentIndex >= 0 ? currentIndex : 0;
        const len = snap.registry.slots.length;
        for (let i = 1; i < len; i++) {
          const idx = (startIndex + i) % len;
          const candidate = snap.registry.slots[idx];
          // Z3 — api_key is not runtime-selectable in phase 1; skip in rotation.
          if (candidate.kind === 'api_key') continue;
          if (isEligible(candidate, snap.state[candidate.keyId], nowMs)) {
            snap.registry.activeKeyId = candidate.keyId;
            return { keyId: candidate.keyId, name: candidate.name };
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

  async recordRateLimitHint(keyId: string, source: RateLimitSource, cooldownUntil?: string): Promise<void> {
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    await this.store.mutate((snap) => {
      const state = snap.state[keyId] ?? { authState: 'healthy' as AuthState, activeLeases: [] };
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
      snap.state[keyId] = state;
    });
    await this.refreshCache();
  }

  async clearRateLimitFlag(keyId: string): Promise<void> {
    await this.store.mutate((snap) => {
      const state = snap.state[keyId];
      if (!state) return;
      delete state.rateLimitedAt;
      delete state.rateLimitSource;
      delete state.cooldownUntil;
    });
    await this.refreshCache();
  }

  // ── Leases ────────────────────────────────────────────────

  async acquireLease(ownerTag: string, ttlMs: number = DEFAULT_LEASE_TTL_MS): Promise<Lease> {
    const leaseId = ulid();
    const acquiredAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const lease: Lease = { leaseId, ownerTag, acquiredAt, expiresAt };

    const chosenKeyId = await this.store.mutate<string>((snap) => {
      if (snap.registry.slots.length === 0) {
        throw new Error('acquireLease: no slots available');
      }
      const now = Date.now();
      // Prefer the current active slot if eligible; otherwise rotate to next.
      // Z3 — api_key is not runtime-selectable in phase 1; treat an api_key
      // active slot as ineligible and fall through to pick a cct candidate.
      const activeId = snap.registry.activeKeyId;
      const activeSlot = activeId ? snap.registry.slots.find((s) => s.keyId === activeId) : undefined;
      let picked: string;
      if (activeSlot && activeSlot.kind !== 'api_key' && isEligible(activeSlot, snap.state[activeSlot.keyId], now)) {
        picked = activeSlot.keyId;
      } else {
        const candidate = snap.registry.slots.find(
          (s) => s.kind !== 'api_key' && isEligible(s, snap.state[s.keyId], now),
        );
        if (!candidate) {
          throw new Error('acquireLease: no healthy slot available');
        }
        picked = candidate.keyId;
        snap.registry.activeKeyId = candidate.keyId;
      }
      const state = snap.state[picked] ?? { authState: 'healthy' as AuthState, activeLeases: [] };
      state.activeLeases = [...state.activeLeases, lease];
      snap.state[picked] = state;
      return picked;
    });

    await this.refreshCache();
    logger.debug(`acquireLease ${leaseId} on ${chosenKeyId} (ownerTag=${ownerTag})`);
    return lease;
  }

  async heartbeatLease(leaseId: string): Promise<void> {
    const nowMs = Date.now();
    const found = await this.store.mutate((snap) => {
      for (const [keyId, state] of Object.entries(snap.state)) {
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
          snap.state[keyId] = state;
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
      for (const [keyId, state] of Object.entries(snap.state)) {
        const next = state.activeLeases.filter((l) => l.leaseId !== leaseId);
        if (next.length !== state.activeLeases.length) {
          snap.state[keyId] = { ...state, activeLeases: next };
          return;
        }
      }
    });
    await this.refreshCache();
  }

  async reapExpiredLeases(): Promise<void> {
    const nowMs = Date.now();
    await this.store.mutate((snap) => {
      for (const [keyId, state] of Object.entries(snap.state)) {
        const kept = state.activeLeases.filter((l) => new Date(l.expiresAt).getTime() > nowMs);
        if (kept.length !== state.activeLeases.length) {
          snap.state[keyId] = { ...state, activeLeases: kept };
        }
      }
      // After trimming, fully remove tombstoned-with-no-leases slots.
      const survivors: AuthKey[] = [];
      for (const slot of snap.registry.slots) {
        const state = snap.state[slot.keyId];
        if (state?.tombstoned && state.activeLeases.length === 0) {
          delete snap.state[slot.keyId];
          if (snap.registry.activeKeyId === slot.keyId) {
            delete snap.registry.activeKeyId;
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

  async addSlot(input: AddSlotInput): Promise<AuthKey> {
    const keyId = ulid();
    const createdAt = new Date().toISOString();
    let newSlot: AuthKey;
    if (input.kind === 'setup_token') {
      const slot: CctSlotWithSetup = {
        kind: 'cct',
        source: 'setup',
        keyId,
        name: input.name,
        setupToken: input.value,
        createdAt,
      };
      newSlot = slot;
    } else if (input.kind === 'api_key') {
      // Z3 — Add Slot modal radio 에 api_key 옵션. sk-ant-api03- 검증 + 저장만 가능.
      if (!API_KEY_REGEX.test(input.value)) {
        throw new Error('addSlot: api_key must match sk-ant-api03-<chars>');
      }
      const slot: ApiKeySlot = {
        kind: 'api_key',
        keyId,
        name: input.name,
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
      const attachment: OAuthAttachment = {
        accessToken: input.credentials.accessToken,
        refreshToken: input.credentials.refreshToken,
        expiresAtMs: input.credentials.expiresAtMs,
        scopes: [...input.credentials.scopes],
        acknowledgedConsumerTosRisk: true,
      };
      if (input.credentials.subscriptionType !== undefined)
        attachment.subscriptionType = input.credentials.subscriptionType;
      if (input.credentials.rateLimitTier !== undefined) attachment.rateLimitTier = input.credentials.rateLimitTier;
      newSlot = {
        kind: 'cct',
        source: 'legacy-attachment',
        keyId,
        name: input.name,
        oauthAttachment: attachment,
        createdAt,
      };
    }

    await this.store.mutate((snap) => {
      // CAS-protect name uniqueness: re-check inside the mutate callback so
      // two parallel `addSlot` calls for the same name can't both succeed —
      // the `CctStore.mutate` retry loop will re-run the loser's callback
      // against the winner's persisted snapshot, where the guard now trips.
      if (snap.registry.slots.some((s) => s.name === newSlot.name)) {
        throw new Error(`NAME_IN_USE:${newSlot.name}`);
      }
      snap.registry.slots.push(newSlot);
      snap.state[newSlot.keyId] = { authState: 'healthy', activeLeases: [] };
      // Z3 — api_key is not runtime-selectable in phase 1; never auto-elect.
      if (!snap.registry.activeKeyId && newSlot.kind !== 'api_key') {
        snap.registry.activeKeyId = newSlot.keyId;
      }
    });
    await this.refreshCache();
    logger.info(
      `addSlot: ${newSlot.name} kind=${newSlot.kind} keyId=${newSlot.keyId}`,
      redactAnthropicSecrets({ keyId: newSlot.keyId, name: newSlot.name }) as Record<string, unknown>,
    );
    // Card v2 (#668 follow-up): legacy-attachment slots carry an OAuth
    // attachment from creation; kick off an initial profile fetch so the
    // email / rate-limit-tier badge is populated before the first render.
    // Setup-token and api_key slots have no attachment surface yet; their
    // profile sync fires in `attachOAuth`.
    if (newSlot.kind === 'cct' && newSlot.source === 'legacy-attachment') {
      this.refreshOAuthProfile(newSlot.keyId).catch((err) => {
        logger.warn('addSlot: profile sync failed', { keyId: newSlot.keyId, err });
      });
    }
    return newSlot;
  }

  async renameSlot(keyId: string, newName: string): Promise<void> {
    await this.store.mutate((snap) => {
      const slot = snap.registry.slots.find((s) => s.keyId === keyId);
      if (!slot) throw new Error(`renameSlot: unknown keyId ${keyId}`);
      // CAS-protect name uniqueness (excluding self) so two parallel renames
      // can't both land the same name.
      if (snap.registry.slots.some((s) => s.keyId !== keyId && s.name === newName)) {
        throw new Error(`NAME_IN_USE:${newName}`);
      }
      slot.name = newName;
    });
    await this.refreshCache();
  }

  async removeSlot(
    keyId: string,
    opts: { force?: boolean } = {},
  ): Promise<{ removed: boolean; pendingDrain?: boolean }> {
    const force = opts.force === true;
    let removed = false;
    let pendingDrain = false;
    await this.store.mutate((snap) => {
      const idx = snap.registry.slots.findIndex((s) => s.keyId === keyId);
      if (idx < 0) {
        removed = false;
        return;
      }
      const state = snap.state[keyId];
      const hasLeases = state ? state.activeLeases.length > 0 : false;
      if (hasLeases && !force) {
        // Tombstone + rotate active if needed
        snap.state[keyId] = { ...state, tombstoned: true };
        if (snap.registry.activeKeyId === keyId) {
          const now = Date.now();
          const replacement = snap.registry.slots.find(
            (s) => s.keyId !== keyId && isEligible(s, snap.state[s.keyId], now),
          );
          if (replacement) snap.registry.activeKeyId = replacement.keyId;
        }
        pendingDrain = true;
        removed = false;
        return;
      }
      // Full removal
      snap.registry.slots.splice(idx, 1);
      delete snap.state[keyId];
      if (snap.registry.activeKeyId === keyId) {
        const now = Date.now();
        const replacement = snap.registry.slots.find((s) => isEligible(s, snap.state[s.keyId], now));
        snap.registry.activeKeyId = replacement?.keyId;
      }
      removed = true;
    });
    await this.refreshCache();
    return pendingDrain ? { removed: false, pendingDrain: true } : { removed };
  }

  async markAuthState(keyId: string, state: AuthState): Promise<void> {
    await this.store.mutate((snap) => {
      const prev = snap.state[keyId] ?? { authState: 'healthy' as AuthState, activeLeases: [] };
      snap.state[keyId] = { ...prev, authState: state };
    });
    await this.refreshCache();
  }

  // ── Attach / detach OAuth on setup-source CCT slots (Z2) ─

  /**
   * Narrowed helper: mutates a setup-source CCT slot that currently carries
   * an OAuthAttachment, removing the attachment field and clearing any
   * cached usage. Called only from inside a CAS `store.mutate` callback
   * where the slot has been narrowed to this shape.
   *
   * Centralising the erase-side mutation keeps the type narrowing in one
   * place — the public `detachOAuth(keyId)` surface is string-keyed, and
   * only here do we know the slot matches this union arm.
   */
  #detachOAuthOnSetupSlot(snap: CctStoreSnapshot, slot: CctSlotWithSetup & { oauthAttachment: OAuthAttachment }): void {
    // Delete the optional attachment field; source stays 'setup'.
    delete (slot as CctSlotWithSetup).oauthAttachment;
    const st = snap.state[slot.keyId];
    if (st) {
      delete st.usage;
      delete st.lastUsageFetchedAt;
      delete st.nextUsageFetchAllowedAt;
      delete st.consecutiveUsageFailures;
      // Codex P0 fix #3: clear attachment-scoped auth state. With no
      // attachment, 'refresh_failed'/'revoked' are not meaningful (a bare
      // setup-source slot uses setupToken verbatim). Leaving stale marks
      // would make the slot ineligible in `isEligible` even after a later
      // attach cycle that itself resets state.
      st.authState = 'healthy';
    }
  }

  /**
   * Attach an `oauthAttachment` to an existing setup-source CCT slot (Z2).
   *
   * Guards (every call, not cached):
   *   - Unknown keyId → throw.
   *   - `slot.kind !== 'cct'` → throw `attachOAuth: slot kind must be cct`.
   *     api_key slots have no attachment surface in phase 1.
   *   - `slot.source !== 'setup'` → throw
   *     `attachOAuth: only setup-source slots accept attachment`.
   *     legacy-attachment slots already carry a mandatory attachment; the
   *     replace path is "remove + re-add", not attach-on-top.
   *   - `!hasRequiredScopes(creds.scopes)` → re-validated every call even
   *     when the slot previously had a good attachment (blobs can shrink).
   *   - `ack !== true` → throw `attachOAuth: ack required`.
   *
   * On success: `source: 'setup'` stays unchanged; we only set
   * `oauthAttachment`. A usage fetch is *triggered* (fire-and-forget) so
   * the next card open has fresh numbers — we do NOT await it (the Z1
   * `fetchUsageForAllAttached` path will pick it up).
   */
  async attachOAuth(keyId: string, creds: OAuthCredentials, ack: true): Promise<void> {
    if (ack !== true) {
      throw new Error('attachOAuth: ack required (acknowledgedConsumerTosRisk)');
    }
    if (!hasRequiredScopes(creds.scopes)) {
      const missing = missingScopes(creds.scopes);
      throw new Error(`attachOAuth: missing required scope(s): ${missing.join(', ')}`);
    }
    await this.store.mutate((snap) => {
      const slot = snap.registry.slots.find((s) => s.keyId === keyId);
      if (!slot) throw new Error(`attachOAuth: unknown keyId ${keyId}`);
      if (slot.kind !== 'cct') {
        throw new Error('attachOAuth: slot kind must be cct');
      }
      if (slot.source !== 'setup') {
        throw new Error('attachOAuth: only setup-source slots accept attachment');
      }
      const attachment: OAuthAttachment = {
        accessToken: creds.accessToken,
        refreshToken: creds.refreshToken,
        expiresAtMs: creds.expiresAtMs,
        scopes: [...creds.scopes],
        acknowledgedConsumerTosRisk: true,
        // Codex P0 fix #3 (attachment-generation fingerprint): stamp the attach
        // moment so a later in-flight refresh/usage persist can reject writes
        // that crossed a detach → re-attach boundary. `refreshAccessToken`
        // copies this value through; `detachOAuth` erases the attachment, so
        // any later attach lands a different `attachedAt`.
        attachedAt: Date.now(),
      };
      if (creds.subscriptionType !== undefined) attachment.subscriptionType = creds.subscriptionType;
      if (creds.rateLimitTier !== undefined) attachment.rateLimitTier = creds.rateLimitTier;
      slot.oauthAttachment = attachment;
      // Reset attachment-scoped auth state (Codex P0 fix #3): a slot carrying
      // a stale `refresh_failed` / `revoked` mark from a prior attachment
      // must become eligible again once fresh creds are supplied. Without
      // this, `isEligible` rejects the slot and `acquireLease` skips it.
      const prev = snap.state[slot.keyId] ?? { authState: 'healthy' as AuthState, activeLeases: [] };
      snap.state[slot.keyId] = { ...prev, authState: 'healthy' };
    });
    await this.refreshCache();
    // Fire-and-forget usage fetch — the renderCctCard path will also pick
    // this up via fetchUsageForAllAttached on next open. Swallow errors so
    // attach response is not blocked.
    void this.fetchAndStoreUsage(keyId).catch(() => {});
    // Card v2 (#668 follow-up): pull the account/organization profile on
    // first attach so the email / rate-limit-tier badge appears without
    // waiting for the hourly scheduler tick.
    this.refreshOAuthProfile(keyId).catch((err) => {
      logger.warn('attachOAuth: profile sync failed', { keyId, err });
    });
  }

  /**
   * Remove the oauthAttachment from a setup-source CCT slot (Z2).
   *
   * Guards:
   *   - Unknown keyId → throw.
   *   - `slot.kind !== 'cct'` → throw `detachOAuth: api_key slots have no attachment`.
   *   - `slot.source !== 'setup'` → throw
   *     `detachOAuth: legacy-attachment slots cannot detach; use removeSlot`.
   *     That union arm has `oauthAttachment` as a REQUIRED field; dropping
   *     it would violate the type.
   *
   * On success: `slot.oauthAttachment` is deleted, and the state entry's
   * usage cache is cleared (avoids rendering stale percentages against a
   * now-attachmentless slot).
   */
  async detachOAuth(keyId: string): Promise<void> {
    await this.store.mutate((snap) => {
      const slot = snap.registry.slots.find((s) => s.keyId === keyId);
      if (!slot) throw new Error(`detachOAuth: unknown keyId ${keyId}`);
      if (slot.kind !== 'cct') {
        throw new Error('detachOAuth: api_key slots have no attachment');
      }
      if (slot.source !== 'setup') {
        throw new Error('detachOAuth: legacy-attachment slots cannot detach; use removeSlot');
      }
      if (slot.oauthAttachment === undefined) {
        // No-op for setup slots without an attachment — idempotent.
        return;
      }
      this.#detachOAuthOnSetupSlot(snap, slot as CctSlotWithSetup & { oauthAttachment: OAuthAttachment });
    });
    await this.refreshCache();
  }

  // ── Proactive refresh ─────────────────────────────────────

  /**
   * Return the access token for one of two upstream surfaces, keyed by
   * explicit `purpose` (required — the split is a type-system concern so
   * the #673 regression cannot recur):
   *
   *   - `'dispatch'` — forwarded to the Claude Agent SDK subprocess via
   *     `CLAUDE_CODE_OAUTH_TOKEN`.
   *       • `api_key`                            → `slot.value`
   *       • `cct / source:'setup'`               → `slot.setupToken` (1y)
   *         — the `oauthAttachment` is deliberately ignored so the 1h OAuth
   *         access_token is never injected into the long-lived subprocess.
   *       • `cct / source:'legacy-attachment'`   → near-expiry refresh +
   *         `oauthAttachment.accessToken` (no setupToken fallback exists).
   *
   *   - `'oauth-api'` — soma-work's own HTTP calls to
   *     `/api/oauth/usage` / `/api/oauth/profile`. Requires a live OAuth
   *     attachment: throws {@link NoOAuthAttachmentError} for `api_key`
   *     and for `cct` without `oauthAttachment`; otherwise near-expiry
   *     refresh + `oauthAttachment.accessToken`.
   */
  async getValidAccessToken(keyId: string, purpose: 'dispatch' | 'oauth-api'): Promise<string> {
    const snap = await this.store.load();
    const slot = snap.registry.slots.find((s) => s.keyId === keyId);
    if (!slot) throw new Error(`getValidAccessToken: unknown keyId ${keyId}`);

    if (purpose === 'dispatch') {
      if (slot.kind === 'api_key') return slot.value;
      if (isCctWithSetup(slot)) return slot.setupToken;
      return this.#resolveAttachmentAccessToken(slot);
    }

    if (!hasOAuthAttachment(slot)) {
      throw new NoOAuthAttachmentError(keyId, slot.kind, slot.kind === 'cct' ? slot.source : undefined);
    }
    return this.#resolveAttachmentAccessToken(slot);
  }

  /** Return the attachment's access token, refreshing if it's near expiry. */
  async #resolveAttachmentAccessToken(slot: CctSlot & { oauthAttachment: OAuthAttachment }): Promise<string> {
    if (!needsAttachmentRefresh(slot.oauthAttachment, Date.now())) {
      return slot.oauthAttachment.accessToken;
    }
    return this.refreshAccessToken(slot);
  }

  /**
   * Non-throwing wrapper around `getValidAccessToken(keyId, 'oauth-api')` for
   * usage/profile callers: `null` when the slot has no attachment (no throw),
   * value when fresh or refreshed. Other errors still propagate.
   */
  async #getOAuthApiAccessTokenOrNull(keyId: string): Promise<string | null> {
    try {
      return await this.getValidAccessToken(keyId, 'oauth-api');
    } catch (err) {
      if (err instanceof NoOAuthAttachmentError) return null;
      throw err;
    }
  }

  async refreshCredentialsIfNeeded(keyId: string): Promise<void> {
    const snap = await this.store.load();
    const slot = snap.registry.slots.find((s) => s.keyId === keyId);
    if (!slot || !hasOAuthAttachment(slot)) return;
    if (!needsAttachmentRefresh(slot.oauthAttachment, Date.now())) return;
    await this.refreshAccessToken(slot);
  }

  /**
   * #653 M2 — Force-refresh the OAuth access_token for a single slot
   * regardless of its current TTL. Used by the per-slot Refresh button
   * (so the "OAuth refreshes in X" hint resets immediately on click)
   * and by the hourly `OAuthRefreshScheduler`.
   *
   * No-op for slots without an OAuth attachment (api_key or bare setup
   * tokens). Reuses `refreshAccessToken`'s in-process dedupe + attachment-
   * generation fingerprint guard, so concurrent force-refreshes for the
   * same slot share a single HTTP round-trip and a detach/re-attach race
   * can't resurrect stale credentials.
   *
   * Throws `OAuthRefreshError` on 401/403. The authState has already
   * been marked `refresh_failed` / `revoked` before the throw, so callers
   * can surface the error (or swallow it if the cached authState alone
   * is enough signal).
   *
   * Card v2 (#668 follow-up): by default this also chains a fire-and-forget
   * `refreshOAuthProfile` so the email / rate-limit-tier badge tracks the
   * same cadence as the token refresh. Set `opts.syncProfile = false` to
   * skip (used by test paths that isolate the token-only leg).
   */
  async forceRefreshOAuth(keyId: string, opts?: { syncProfile?: boolean }): Promise<void> {
    await this.#refreshTokenOnly(keyId);
    if (opts?.syncProfile !== false) {
      // Fire-and-forget: a failed profile sync must not surface as a refresh
      // failure — the token leg already succeeded. The scheduler and Refresh
      // button both care about the token, not the profile.
      this.refreshOAuthProfile(keyId).catch((err) => {
        logger.warn('forceRefreshOAuth: profile sync failed', { keyId, err });
      });
    }
  }

  async #refreshTokenOnly(keyId: string): Promise<void> {
    const snap = await this.store.load();
    const slot = snap.registry.slots.find((s) => s.keyId === keyId);
    if (!slot || !hasOAuthAttachment(slot)) return;
    await this.refreshAccessToken(slot);
  }

  // ── OAuth profile fetch (card v2) ──────────────────────────
  //
  // Dedupe is keyed by `${keyId}:${attachedAt ?? 'legacy'}` so two generations
  // of the same slot (detach → re-attach mid-flight) cannot evict each other's
  // promise — the persist-side attachedAt guard in `#writeProfile` still
  // rejects a stale result, but the dedupe key prevents the newer caller from
  // silently sharing the older promise.
  private readonly profileInflight: Map<string, Promise<OAuthProfile | null>> = new Map();

  /**
   * Fetch the OAuth profile for a CCT slot and persist it on the slot's
   * attachment. Non-reentrant: a single 401 triggers one token refresh and
   * one retry; subsequent 401s from the retry flow surface to the caller.
   *
   * Returns:
   *   - the fetched profile on success,
   *   - `null` when the slot has no OAuth attachment, the knob is disabled,
   *     or a non-401 error occurred (logged at warn level).
   */
  async refreshOAuthProfile(keyId: string, opts?: { timeoutMs?: number }): Promise<OAuthProfile | null> {
    if (!config.oauthProfile.enabled) return null;
    const snap = await this.store.load();
    const slot = snap.registry.slots.find((s) => s.keyId === keyId);
    if (!slot || !hasOAuthAttachment(slot)) return null;
    const attachedAt = slot.oauthAttachment.attachedAt;
    const dedupeKey = `${keyId}:${attachedAt ?? 'legacy'}`;
    const existing = this.profileInflight.get(dedupeKey);
    if (existing) return existing;
    const p = this.#doRefreshProfile(keyId, attachedAt, opts).finally(() => {
      const current = this.profileInflight.get(dedupeKey);
      if (current === p) this.profileInflight.delete(dedupeKey);
    });
    this.profileInflight.set(dedupeKey, p);
    return p;
  }

  async #doRefreshProfile(
    keyId: string,
    attachedAt: number | undefined,
    opts?: { timeoutMs?: number },
  ): Promise<OAuthProfile | null> {
    const timeoutMs = opts?.timeoutMs ?? config.oauthProfile.timeoutMs;
    let token: string | null;
    try {
      token = await this.#getOAuthApiAccessTokenOrNull(keyId);
    } catch (err) {
      logger.warn('refreshOAuthProfile: pre-fetch token resolution failed', { keyId, err });
      return null;
    }
    // Attachment detached between the upstream `hasOAuthAttachment` guard and
    // now — nothing to refresh.
    if (token === null) return null;
    try {
      const profile = await fetchOAuthProfile(token, { timeoutMs });
      await this.#writeProfile(keyId, attachedAt, profile);
      return profile;
    } catch (err) {
      if (err instanceof OAuthProfileUnauthorizedError) {
        // Non-reentrant 401 retry: refresh token once (via `#refreshTokenOnly`
        // to avoid recursively chaining another `refreshOAuthProfile`), then
        // re-fetch. A second 401 propagates — that's a real auth failure.
        try {
          await this.#refreshTokenOnly(keyId);
          const freshToken = await this.#getOAuthApiAccessTokenOrNull(keyId);
          if (freshToken === null) return null;
          const profile = await fetchOAuthProfile(freshToken, { timeoutMs });
          await this.#writeProfile(keyId, attachedAt, profile);
          return profile;
        } catch (retryErr) {
          logger.warn('refreshOAuthProfile: 401 retry failed', { keyId, err: retryErr });
          return null;
        }
      }
      logger.warn('refreshOAuthProfile: fetch failed', { keyId, err });
      return null;
    }
  }

  async #writeProfile(keyId: string, attachedAt: number | undefined, profile: OAuthProfile): Promise<void> {
    await this.store.mutate((snap) => {
      const target = snap.registry.slots.find((s) => s.keyId === keyId);
      if (!target || target.kind !== 'cct' || target.oauthAttachment === undefined) return;
      // attachedAt guard (mirrors the refresh/usage persist guards): reject
      // the write when the attachment generation has changed since fetch
      // start. `undefined` is a distinct generation and compares strictly.
      if (target.oauthAttachment.attachedAt !== attachedAt) return;
      target.oauthAttachment.profile = profile;
    });
  }

  /**
   * #653 M2 — Fan-out force-refresh of every OAuth-attached CCT slot.
   * Returns a `Record<keyId, 'ok' | 'error'>` so the scheduler (and the
   * card-level "Refresh All OAuth Tokens" button) can report per-slot
   * outcomes.
   *
   * Parallel execution under a single shared deadline (default 30s). Token
   * refreshes run first; when `awaitProfile: true` the profile fetches that
   * normally run fire-and-forget are awaited on a second leg under the
   * REMAINING portion of the same deadline — a hanging profile fetch on one
   * slot cannot push the whole call past `timeoutMs`. The token results
   * are returned regardless (profile latency never blocks token outcomes).
   *
   * Contract mirrors `fetchUsageForAllAttached`: timeouts return whatever
   * has landed so far; per-slot errors are caught and surfaced in the
   * returned map (not thrown) so a single bad slot doesn't poison the
   * whole tick.
   *
   * The scheduler calls this WITHOUT `awaitProfile` so the fire-and-forget
   * profile leg stays hot for periodic ticks — the next tick sees fresh
   * data even when the profile fetch lands asynchronously.
   */
  async refreshAllAttachedOAuthTokens(opts?: {
    timeoutMs?: number;
    awaitProfile?: boolean;
  }): Promise<Record<string, 'ok' | 'error'>> {
    const totalDeadline = opts?.timeoutMs ?? 30_000;
    const startedAt = Date.now();
    const remaining = (): number => Math.max(0, totalDeadline - (Date.now() - startedAt));
    const snap = await this.store.load();
    const keyIds = snap.registry.slots
      .filter((s) => s.kind === 'cct' && s.oauthAttachment !== undefined)
      .map((s) => s.keyId);
    const results: Record<string, 'ok' | 'error'> = {};
    // When `awaitProfile: true`, suppress `forceRefreshOAuth`'s fire-and-forget
    // profile sync so the profile fetch runs on the awaited leg below (one
    // profile call per slot, not two).
    const tokenTasks = keyIds.map((keyId) =>
      this.forceRefreshOAuth(keyId, { syncProfile: opts?.awaitProfile !== true })
        .then(() => {
          results[keyId] = 'ok';
        })
        .catch((err) => {
          results[keyId] = 'error';
          logger.warn('refreshAllAttachedOAuthTokens: per-slot refresh failed', {
            keyId,
            err,
          });
        }),
    );
    const tokenDeadline = new Promise<void>((resolve) => {
      const t = setTimeout(resolve, remaining());
      if (typeof t.unref === 'function') t.unref();
    });
    await Promise.race([Promise.allSettled(tokenTasks), tokenDeadline]);
    if (opts?.awaitProfile) {
      const timeLeft = remaining();
      if (timeLeft > 0) {
        const profileAwaits = Object.entries(results)
          .filter(([, outcome]) => outcome === 'ok')
          .map(([keyId]) => this.refreshOAuthProfile(keyId, { timeoutMs: timeLeft }).catch(() => null));
        if (profileAwaits.length > 0) {
          const profileDeadline = new Promise<void>((resolve) => {
            const t = setTimeout(resolve, timeLeft);
            if (typeof t.unref === 'function') t.unref();
          });
          await Promise.race([Promise.allSettled(profileAwaits), profileDeadline]);
        }
      }
    }
    return results;
  }

  /**
   * In-process dedupe: callers racing to refresh the same slot share a
   * single Promise. The actual HTTP call happens OUTSIDE any cct-store
   * lock; we acquire the lock only to persist the result.
   */
  private refreshAccessToken(slot: CctSlot & { oauthAttachment: OAuthAttachment }): Promise<string> {
    // Codex P0 fix #3 — capture the attachment-generation fingerprint BEFORE
    // the in-flight lookup so dedupe is generation-aware. A detach +
    // re-attach while a refresh is in flight changes `attachedAt`; the new
    // generation must NOT inherit the stale refresh promise. `undefined` is
    // a distinct generation (v2 snapshots persisted before the field
    // existed), so the comparison is strict.
    const preAttachedAt: number | undefined = slot.oauthAttachment.attachedAt;
    // Composite dedupe key (Codex P0 fix #3, v4). The `attachedAt ?? 'legacy'`
    // lets v2 snapshots written before the field existed share one bucket
    // while still being strictly distinct from any numeric generation.
    const dedupeKey = `${slot.keyId}:${preAttachedAt ?? 'legacy'}`;
    const existing = this.refreshInFlight.get(dedupeKey);
    if (existing) return existing;
    // Definite-assignment assertion: the `finally` below runs on the
    // microtask queue AFTER the synchronous `promise = ...` assignment
    // completes, so by the time the ownership check executes the binding
    // is live. TS control-flow analysis can't prove that through the IIFE.
    let promise!: Promise<string>;
    promise = (async (): Promise<string> => {
      try {
        let next: OAuthCredentials;
        try {
          next = await refreshClaudeCredentials({
            accessToken: slot.oauthAttachment.accessToken,
            refreshToken: slot.oauthAttachment.refreshToken,
            expiresAtMs: slot.oauthAttachment.expiresAtMs,
            scopes: [...slot.oauthAttachment.scopes],
            ...(slot.oauthAttachment.rateLimitTier !== undefined
              ? { rateLimitTier: slot.oauthAttachment.rateLimitTier }
              : {}),
            ...(slot.oauthAttachment.subscriptionType !== undefined
              ? { subscriptionType: slot.oauthAttachment.subscriptionType }
              : {}),
          });
        } catch (err) {
          if (err instanceof OAuthRefreshError) {
            if (err.status === 401) await this.markAuthState(slot.keyId, 'refresh_failed');
            else if (err.status === 403) await this.markAuthState(slot.keyId, 'revoked');
          }
          throw err;
        }
        // Persist — single-step under the store lock.
        await this.store.mutate((snap) => {
          const target = snap.registry.slots.find((s) => s.keyId === slot.keyId);
          if (!target || target.kind !== 'cct') return;
          // Codex P0 fix #3 (attachment-generation guard).
          //
          // Two failure modes this must reject:
          //   (a) `detachOAuth` landed between refresh start and persist —
          //       `target.oauthAttachment` is now `undefined`. Writing would
          //       silently resurrect the attachment the operator just removed.
          //   (b) `detachOAuth` + a NEW `attachOAuth` both landed between
          //       refresh start and persist — `target.oauthAttachment` is
          //       defined, but it is a different attachment generation.
          //       Writing would clobber the newer generation with stale
          //       tokens from the old one (auth-state leakage).
          //
          // Both are caught by requiring the current attachment's fingerprint
          // to strictly equal the one we captured at refresh start.
          if (target.oauthAttachment === undefined) return;
          if (target.oauthAttachment.attachedAt !== preAttachedAt) return;
          // Carry the account/organization profile across the refresh so
          // the card's email / rate-limit-tier badge doesn't blank out every
          // hour when the scheduler force-refreshes. The attachment identity
          // is unchanged; only the tokens rotate.
          const preservedProfile = target.oauthAttachment.profile;
          const updated: OAuthAttachment = {
            accessToken: next.accessToken,
            refreshToken: next.refreshToken,
            expiresAtMs: next.expiresAtMs,
            scopes: [...next.scopes],
            acknowledgedConsumerTosRisk: true,
            // Preserve the fingerprint — refresh keeps the attachment
            // identity unchanged, only the tokens rotate.
            attachedAt: target.oauthAttachment.attachedAt ?? preAttachedAt,
          };
          if (next.subscriptionType !== undefined) updated.subscriptionType = next.subscriptionType;
          if (next.rateLimitTier !== undefined) updated.rateLimitTier = next.rateLimitTier;
          if (preservedProfile !== undefined) updated.profile = preservedProfile;
          target.oauthAttachment = updated;
          const st = snap.state[slot.keyId] ?? { authState: 'healthy' as AuthState, activeLeases: [] };
          st.authState = 'healthy';
          snap.state[slot.keyId] = st;
        });
        await this.refreshCache();
        logger.info(
          'refreshAccessToken: success',
          redactAnthropicSecrets({ keyId: slot.keyId, name: slot.name }) as Record<string, unknown>,
        );
        return next.accessToken;
      } finally {
        // With the composite dedupe key, each generation owns its own
        // bucket — a newer generation cannot evict this entry, so the
        // ownership check only has to verify the bucket still points
        // at this exact promise (defensive in case another refresh for
        // the SAME generation ever races in, which shouldn't happen).
        const current = this.refreshInFlight.get(dedupeKey);
        if (current === promise) {
          this.refreshInFlight.delete(dedupeKey);
        }
      }
    })();
    this.refreshInFlight.set(dedupeKey, promise);
    return promise;
  }

  // ── Usage fetch ───────────────────────────────────────────

  /**
   * Fetch + persist usage for a single CCT slot.
   *
   * `opts.force` (PR#1 M1-S4): bypasses the per-slot local throttle
   * (`nextUsageFetchAllowedAt`). Server-side 429/5xx still trigger the
   * standard backoff ladder — `force` only skips the LOCAL gate. The
   * Slack "Refresh" button + `/cct refresh` admin command set this.
   *
   * The per-keyId in-flight dedupe is ALWAYS on. If a force-fetch is
   * requested while a non-force fetch is already pending for the same
   * keyId, we reuse the pending Promise — another round-trip would
   * race against persistence and is not what the caller wants.
   */
  async fetchAndStoreUsage(keyId: string, opts: { force?: boolean } = {}): Promise<UsageSnapshot | null> {
    // Z1 — Per-keyId in-flight dedupe: if another `fetchUsageForAllAttached`
    // fan-out or a parallel caller is already fetching for this keyId,
    // reuse that Promise to avoid hammering the usage endpoint.
    const existing = this.usageFetchInFlight.get(keyId);
    if (existing) return existing;
    const promise = this.#doFetchAndStoreUsage(keyId, opts).finally(() => {
      this.usageFetchInFlight.delete(keyId);
    });
    this.usageFetchInFlight.set(keyId, promise);
    return promise;
  }

  async #doFetchAndStoreUsage(keyId: string, opts: { force?: boolean } = {}): Promise<UsageSnapshot | null> {
    const snap = await this.store.load();
    const slot = snap.registry.slots.find((s) => s.keyId === keyId);
    if (!slot || !hasOAuthAttachment(slot)) return null;
    // Codex P0 fix #3 — capture attachment-generation fingerprint BEFORE the
    // async fetch/refresh/retry pipeline starts. If detach + re-attach both
    // land before persist, the fingerprint differs and the write is dropped.
    // `undefined` is a valid (pre-Z2) generation and compares strictly.
    const preAttachedAt: number | undefined = slot.oauthAttachment.attachedAt;
    const state = snap.state[keyId];
    const nowMs = Date.now();
    // PR#1 M1-S4: `force` bypasses the local throttle but NOT any server-side
    // backoff — a 429 response still advances `nextUsageFetchAllowedAt` via
    // `applyUsageFailureBackoff` below.
    if (!opts.force && state?.nextUsageFetchAllowedAt) {
      const allowedMs = new Date(state.nextUsageFetchAllowedAt).getTime();
      if (Number.isFinite(allowedMs) && allowedMs > nowMs) return null;
    }

    // Attachment detached between the upstream `hasOAuthAttachment` guard and
    // now — nothing to fetch.
    let accessToken: string | null;
    try {
      accessToken = await this.#getOAuthApiAccessTokenOrNull(keyId);
    } catch (err) {
      logger.warn('fetchAndStoreUsage: refresh failed pre-fetch', err);
      return null;
    }
    if (accessToken === null) return null;

    const doFetch = async (token: string) => fetchUsage(token);

    let result: Awaited<ReturnType<typeof fetchUsage>> | null = null;
    try {
      result = await doFetch(accessToken);
    } catch (err) {
      if (err instanceof UsageFetchError) {
        if (err.status === 401) {
          // Attempt one refresh then retry.
          try {
            await this.refreshCredentialsIfNeeded(keyId);
            const fresh = await this.#getOAuthApiAccessTokenOrNull(keyId);
            if (fresh === null) return null;
            result = await doFetch(fresh);
          } catch (retryErr) {
            await this.applyUsageFailureBackoff(keyId);
            logger.warn('fetchAndStoreUsage: 401→refresh→retry failed', retryErr);
            return null;
          }
        } else if (err.status === 403) {
          await this.markAuthState(keyId, 'revoked');
          return null;
        } else if (err.status === 429) {
          await this.applyUsageFailureBackoff(keyId);
          return null;
        } else {
          await this.applyUsageFailureBackoff(keyId);
          logger.warn(`fetchAndStoreUsage: non-OK ${err.status}`, err);
          return null;
        }
      } else {
        await this.applyUsageFailureBackoff(keyId);
        logger.warn('fetchAndStoreUsage: unexpected error', err);
        return null;
      }
    }

    if (!result) return null;
    const settled = result;

    await this.store.mutate((snap2) => {
      // Codex P0 fix #3 (attachment-generation guard).
      //
      // Reject the persist when either:
      //   (a) `detachOAuth` cleared the attachment since fetch start, OR
      //   (b) `detachOAuth` + a fresh `attachOAuth` both landed before
      //       persist — the slot again has an attachment but it is a new
      //       generation, and the usage numbers we fetched belong to the
      //       OLD generation. Writing them onto the new generation's state
      //       would render stale percentages on the next card open.
      //
      // Both cases collapse to "the captured fingerprint must match the
      // current attachment's fingerprint, strictly".
      const slotNow = snap2.registry.slots.find((s) => s.keyId === keyId);
      if (!slotNow || slotNow.kind !== 'cct' || slotNow.oauthAttachment === undefined) return;
      if (slotNow.oauthAttachment.attachedAt !== preAttachedAt) return;
      const st = snap2.state[keyId] ?? { authState: 'healthy' as AuthState, activeLeases: [] };
      st.usage = settled.snapshot;
      st.lastUsageFetchedAt = settled.snapshot.fetchedAt;
      st.nextUsageFetchAllowedAt = new Date(settled.nextFetchAllowedAtMs).toISOString();
      st.consecutiveUsageFailures = 0;
      snap2.state[keyId] = st;
    });
    return settled.snapshot;
  }

  /**
   * Z1 — Fetch usage for every OAuth-attached CCT slot in parallel and
   * persist the results. Returns a keyed map of the fresh snapshots (or
   * `null` per-slot when fetch-backoff blocked or the upstream call
   * failed).
   *
   * Timeout semantics: the fan-out runs under a single overall deadline
   * (`opts.timeoutMs`, default 1500ms). On timeout the method returns
   * whatever results have landed so far — the card renderer will fall
   * back to cached percentages (or blank) for the laggards.
   *
   * Concurrency: per-keyId dedupe via `usageFetchInFlight` prevents the
   * same slot being hit by multiple fan-outs (e.g. a /cct open racing a
   * backend refresh). Slots without an oauthAttachment (bare setup
   * tokens, api_key slots, fresh slots) are skipped.
   */
  async fetchUsageForAllAttached(opts?: { timeoutMs?: number }): Promise<Record<string, UsageSnapshot | null>> {
    const snap = await this.store.load();
    const keyIds = snap.registry.slots
      .filter((s) => s.kind === 'cct' && s.oauthAttachment !== undefined)
      .map((s) => s.keyId);
    const results: Record<string, UsageSnapshot | null> = {};
    const promises = keyIds.map(async (keyId) => {
      try {
        // `force` is deliberately dropped — per-keyId in-flight dedupe
        // shares any overlapping tick, and bypassing every slot's
        // `nextUsageFetchAllowedAt` gate would defeat the local throttle
        // that protects Anthropic from refresh storms. The card-level
        // [Refresh] button (actions.ts `cct_refresh_card`) fans out with
        // `{ force: true }` per-slot for human-initiated refreshes.
        results[keyId] = await this.fetchAndStoreUsage(keyId, {});
      } catch {
        results[keyId] = null;
      }
    });
    const timeoutMs = opts?.timeoutMs ?? 1500;
    const timeout = new Promise<void>((resolve) => {
      const t = setTimeout(resolve, timeoutMs);
      // Allow Node to exit under tests.
      if (typeof t.unref === 'function') t.unref();
    });
    await Promise.race([Promise.allSettled(promises), timeout]);
    return results;
  }

  private async applyUsageFailureBackoff(keyId: string): Promise<void> {
    await this.store.mutate((s) => {
      const st = s.state[keyId] ?? { authState: 'healthy' as AuthState, activeLeases: [] };
      const failureCount = (st.consecutiveUsageFailures ?? 0) + 1;
      // Ladder is 1-indexed from the caller's perspective — first failure → rung 0 (2m).
      const next = usageBackoffForFailureCount(failureCount - 1);
      st.consecutiveUsageFailures = failureCount;
      st.nextUsageFetchAllowedAt = new Date(Date.now() + next).toISOString();
      s.state[keyId] = st;
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
