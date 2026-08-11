import * as fs from 'node:fs';
import * as path from 'node:path';
import { DATA_DIR } from '../env-paths';
import { Logger } from '../logger';
import { getAuthMode, getLlmuxAdminKey, getLlmuxSettings } from './auth-runtime';

const logger = new Logger('LlmuxTenantKeys');

/**
 * Per-Slack-user llmux client keys (`lmk-…`) — multi-tenant metering.
 *
 * In llmux mode every dispatch used to authenticate with ONE shared
 * `getLlmuxSettings().apiKey`, so llmux attributed every user's tokens to a
 * single tenant. This store issues one llmux client key per Slack user (lazily,
 * on that user's first dispatch) and hands it to `buildQueryEnv` as
 * `ANTHROPIC_API_KEY`, so llmux meters each user separately.
 *
 * Degradation contract: issuance is best effort. Every failure path returns
 * `null` and the caller falls back to the shared key (the legacy tenant) — a
 * user must never lose their dispatch because llmux would not mint a key.
 * {@link ensureTenantKey} therefore NEVER throws.
 *
 * Persistence: `DATA_DIR/llmux-tenant-keys.json`, written atomically
 * (tmp + rename) and chmod 0600 — it holds plaintext secrets, which llmux shows
 * exactly once at issuance. Nothing else logs or persists them; logs carry only
 * key ids and prefixes.
 */
interface TenantKeyRecord {
  /** llmux key id — safe to log. */
  id: string;
  /** Plaintext `lmk-…` secret. NEVER log this. */
  secret: string;
  /** Non-secret display prefix llmux returns alongside the secret. */
  keyPrefix: string;
  /** llmux key name as the issuing daemon holds it (see {@link isUsersKeyName}). */
  name: string;
  /**
   * Normalized base URL of the llmux daemon that issued this key. A key only
   * means anything to its issuer, so a record is reused ONLY while the live
   * `baseUrl` still matches; re-pointing soma-work at another llmux re-issues
   * instead of presenting a secret the new daemon never saw — which would 401
   * the dispatch WITHOUT engaging the shared-key fallback, since a stored
   * secret makes `ensureTenantKey` return non-null.
   */
  baseUrl: string;
  email?: string;
  issuedAtMs: number;
  rotatedAtMs?: number;
}

interface TenantKeyStore {
  version: 1;
  tenants: Record<string, TenantKeyRecord>;
}

/** Response of `POST /llmux/keys/new` and `POST /llmux/keys/rotate` (`.key`). */
interface LlmuxIssuedKey {
  id?: unknown;
  name?: unknown;
  key_prefix?: unknown;
  /** Plaintext secret — shown ONCE, at issuance/rotation. */
  key?: unknown;
  revoked_at_ms?: unknown;
}

const REQUEST_TIMEOUT_MS = 5_000;
/** How long a failed issuance suppresses retries for that user. */
const NEGATIVE_CACHE_MS = 10 * 60 * 1000;

let _state: TenantKeyStore | null = null;
let _storePath: string | null = null;
/** userId → epoch ms of the last failed issuance (retry suppressed until +TTL). */
const _negativeCache = new Map<string, number>();
/** userId → in-flight issuance, so concurrent dispatches issue at most one key. */
const _inFlight = new Map<string, Promise<string | null>>();

function storePath(): string {
  if (_storePath === null) _storePath = path.join(DATA_DIR, 'llmux-tenant-keys.json');
  return _storePath;
}

function emptyStore(): TenantKeyStore {
  return { version: 1, tenants: {} };
}

/** Load persisted keys. Never throws — a corrupt file WARNs and starts empty. */
function load(): TenantKeyStore {
  const store = emptyStore();
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(), 'utf-8')) as Partial<TenantKeyStore>;
    if (parsed?.tenants && typeof parsed.tenants === 'object') {
      for (const [userId, record] of Object.entries(parsed.tenants)) {
        if (record && typeof record.id === 'string' && typeof record.secret === 'string' && record.secret !== '') {
          store.tenants[userId] = record;
        }
      }
    }
    logger.info(`Loaded llmux tenant keys: ${Object.keys(store.tenants).length} user(s)`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger.warn(`llmux-tenant-keys.json unreadable (${(err as Error).message}); starting empty`);
    }
  }
  return store;
}

/** Atomic persist (tmp + rename), 0600. Failure logs but never blocks a dispatch. */
function persist(store: TenantKeyStore): void {
  try {
    const target = storePath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmp, target);
    // Best effort — a pre-existing file keeps its own mode across rename on
    // some filesystems, and a failure here must not lose the key we just got.
    try {
      fs.chmodSync(target, 0o600);
    } catch {
      /* mode is advisory here; the key is already durable */
    }
  } catch (err) {
    logger.error(`Failed to persist llmux tenant keys: ${(err as Error).message}`);
  }
}

function state(): TenantKeyStore {
  if (_state === null) _state = load();
  return _state;
}

/**
 * llmux key name for a user. MUST embed `userId`: the Slack id is the only
 * immutable part of a user's identity here, and it is what makes an existing
 * key re-identifiable as theirs (see {@link isUsersKeyName}).
 */
function keyName(userId: string, profile?: { name?: string }): string {
  const name = profile?.name?.trim();
  return name ? `${name} (${userId})` : userId;
}

/**
 * Whether an llmux key name denotes `userId` — the display-name-independent
 * counterpart of {@link keyName}.
 *
 * Reclaim MUST NOT depend on the display name: it is mutable (Slack profile
 * edits) and may have been unknown at first issuance, so an exact-name match
 * would miss the user's existing key and mint a SECOND one, splitting their
 * billing history across two llmux tenants. Matching the immutable
 * `…(userId)` marker (or the bare id) makes reclaim deterministic.
 */
function isUsersKeyName(name: string, userId: string): boolean {
  return name === userId || name.endsWith(`(${userId})`);
}

/** Live llmux base URL, trailing slashes stripped — the form stored on records. */
function currentBaseUrl(): string {
  return getLlmuxSettings().baseUrl.replace(/\/+$/, '');
}

async function llmuxPost<T>(pathName: string, body: unknown): Promise<{ status: number; body: T | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`llmux POST ${pathName} timed out`)), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${currentBaseUrl()}${pathName}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': getLlmuxAdminKey(),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed: T | null = null;
    try {
      parsed = JSON.parse(text) as T;
    } catch {
      /* non-JSON body — status alone drives the decision */
    }
    return { status: res.status, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

async function llmuxGetKeys(): Promise<{ status: number; body: { keys?: LlmuxIssuedKey[] } | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('llmux GET /llmux/keys timed out')), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${currentBaseUrl()}/llmux/keys`, {
      method: 'GET',
      headers: { 'content-type': 'application/json', 'x-api-key': getLlmuxAdminKey() },
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed: { keys?: LlmuxIssuedKey[] } | null = null;
    try {
      parsed = JSON.parse(text) as { keys?: LlmuxIssuedKey[] };
    } catch {
      /* non-JSON body — treated as a miss */
    }
    return { status: res.status, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function remember(userId: string, record: TenantKeyRecord): string {
  const store = state();
  store.tenants[userId] = record;
  persist(store);
  logger.info('issued llmux tenant key', {
    userId,
    keyId: record.id,
    keyPrefix: record.keyPrefix,
    rotated: record.rotatedAtMs !== undefined,
  });
  return record.secret;
}

function fail(userId: string, reason: string): null {
  _negativeCache.set(userId, Date.now());
  logger.warn('llmux tenant key issuance failed; falling back to the shared key', { userId, reason });
  return null;
}

/** Outcome of looking this user up in llmux's key list. */
type ExistingKeyLookup = { ok: true; key: { id: string; name: string } | null } | { ok: false; reason: string };

/** The user's live (non-revoked) key on the current daemon, per {@link isUsersKeyName}. */
async function findExistingKey(userId: string): Promise<ExistingKeyLookup> {
  const listed = await llmuxGetKeys();
  if (listed.status !== 200 || !Array.isArray(listed.body?.keys)) {
    return { ok: false, reason: `GET /llmux/keys → ${listed.status}` };
  }
  const match = listed.body.keys.find(
    (entry) =>
      entry &&
      typeof entry.name === 'string' &&
      isUsersKeyName(entry.name, userId) &&
      (entry.revoked_at_ms === null || entry.revoked_at_ms === undefined),
  );
  const id = nonEmptyString(match?.id);
  const name = typeof match?.name === 'string' ? match.name : '';
  return { ok: true, key: id ? { id, name } : null };
}

/**
 * Take ownership of a key llmux already holds for this user (our store lost the
 * secret, or this soma-work never had it). llmux shows a secret exactly once, so
 * the only way back to a usable secret is a ROTATE. The key keeps its existing
 * name — llmux has no rename, and the name is display-only.
 */
async function rotateExisting(
  userId: string,
  key: { id: string; name: string },
  email: string | undefined,
  baseUrl: string,
): Promise<string | null> {
  const rotated = await llmuxPost<{ key?: LlmuxIssuedKey }>('/llmux/keys/rotate', { id: key.id });
  const secret = nonEmptyString(rotated.body?.key?.key);
  if (rotated.status !== 200 || !secret) {
    return fail(userId, `POST /llmux/keys/rotate → ${rotated.status}`);
  }
  return remember(userId, {
    id: key.id,
    secret,
    keyPrefix: nonEmptyString(rotated.body?.key?.key_prefix) ?? '',
    name: key.name,
    baseUrl,
    ...(email ? { email } : {}),
    issuedAtMs: Date.now(),
    rotatedAtMs: Date.now(),
  });
}

async function issue(userId: string, profile?: { name?: string; email?: string }): Promise<string | null> {
  const name = keyName(userId, profile);
  const email = profile?.email?.trim() || undefined;
  const baseUrl = currentBaseUrl();
  try {
    // Reclaim BEFORE creating. A user whose display name changed since their
    // first issuance would otherwise create a second key under the new name
    // (no 409, because the names differ) and split their billing history.
    // Costs one GET per issuance — i.e. per user per store lifetime.
    const existing = await findExistingKey(userId);
    if (existing.ok && existing.key) return await rotateExisting(userId, existing.key, email, baseUrl);

    const created = await llmuxPost<LlmuxIssuedKey>('/llmux/keys/new', {
      name,
      ...(email ? { email } : {}),
      kind: 'default',
    });
    if (created.status === 409) {
      // Race fallback: someone issued this user's key between our list and our
      // create (or the list call itself failed above). Re-list and reclaim.
      const raced = await findExistingKey(userId);
      if (!raced.ok) return fail(userId, raced.reason);
      if (!raced.key) return fail(userId, 'existing non-revoked key not found in GET /llmux/keys');
      return await rotateExisting(userId, raced.key, email, baseUrl);
    }

    const secret = nonEmptyString(created.body?.key);
    const id = nonEmptyString(created.body?.id);
    if (created.status !== 200 || !secret || !id) {
      return fail(userId, `POST /llmux/keys/new → ${created.status}`);
    }
    return remember(userId, {
      id,
      secret,
      keyPrefix: nonEmptyString(created.body?.key_prefix) ?? '',
      name,
      baseUrl,
      ...(email ? { email } : {}),
      issuedAtMs: Date.now(),
    });
  } catch (err) {
    // Network error / timeout / abort — never propagate; the dispatch continues
    // on the shared key.
    return fail(userId, (err as Error).message);
  }
}

/**
 * The llmux client key to authenticate `userId`'s dispatches with, or `null`
 * when the caller must fall back to the shared key.
 *
 * `null` (never a throw) for: non-llmux auth mode, a recent issuance failure
 * (negative-cached for 10 min so one broken llmux does not add a request per
 * dispatch), or any llmux/network error.
 */
export async function ensureTenantKey(
  userId: string,
  profile?: { name?: string; email?: string },
): Promise<string | null> {
  if (getAuthMode() !== 'llmux') return null;
  if (!userId.trim()) return null;

  // Store hit only counts for the daemon that issued it. A record written
  // before this field existed has no `baseUrl` and is likewise a miss —
  // issuance overwrites it.
  const existing = state().tenants[userId];
  if (existing?.secret && existing.baseUrl === currentBaseUrl()) return existing.secret;

  const failedAt = _negativeCache.get(userId);
  if (failedAt !== undefined && Date.now() - failedAt < NEGATIVE_CACHE_MS) return null;

  const pending = _inFlight.get(userId);
  if (pending) return pending;

  const attempt = issue(userId, profile).finally(() => _inFlight.delete(userId));
  _inFlight.set(userId, attempt);
  return attempt;
}

/** Test-only: reset module state (and optionally point the store elsewhere). */
export function resetLlmuxTenantKeysForTests(overridePath?: string): void {
  _state = null;
  _storePath = overridePath ?? null;
  _negativeCache.clear();
  _inFlight.clear();
}
