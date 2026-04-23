import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { config } from './config';
import { Logger } from './logger';
import { getTokenManager, type TokenManager } from './token-manager';

const logger = new Logger('CredentialsManager');

/**
 * Check if credential manager is enabled via ENABLE_LOCAL_FILE_CREDENTIALS_JSON=1
 */
export function isCredentialManagerEnabled(): boolean {
  return config.credentials.enabled;
}

// Path to Claude credentials file
const CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const BACKUP_CREDENTIALS_PATH = path.join(os.homedir(), '.claude', 'credentials.json');

export interface ClaudeCredentials {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    [key: string]: any;
  };
  [key: string]: any;
}

/**
 * Read credentials from ~/.claude/.credentials.json
 */
export function readCredentials(): ClaudeCredentials | null {
  try {
    if (!fs.existsSync(CREDENTIALS_PATH)) {
      logger.warn('Credentials file not found', { path: CREDENTIALS_PATH });
      return null;
    }

    const content = fs.readFileSync(CREDENTIALS_PATH, 'utf-8');
    const credentials = JSON.parse(content) as ClaudeCredentials;
    logger.debug('Successfully read credentials file');
    return credentials;
  } catch (error) {
    logger.error('Failed to read credentials file', error);
    return null;
  }
}

/**
 * Check if claudeAiOauth exists in credentials
 */
export function hasClaudeAiOauth(): boolean {
  const credentials = readCredentials();
  if (!credentials) {
    return false;
  }

  const hasOauth = !!credentials.claudeAiOauth?.accessToken;
  logger.debug('Checked for claudeAiOauth', { hasOauth });
  return hasOauth;
}

/**
 * Copy credentials.json to .credentials.json
 * (cp ~/.claude/credentials.json ~/.claude/.credentials.json)
 */
export function copyBackupCredentials(): boolean {
  try {
    if (!fs.existsSync(BACKUP_CREDENTIALS_PATH)) {
      logger.warn('Backup credentials file not found', { path: BACKUP_CREDENTIALS_PATH });
      return false;
    }

    // Ensure the directory exists
    const credentialsDir = path.dirname(CREDENTIALS_PATH);
    if (!fs.existsSync(credentialsDir)) {
      fs.mkdirSync(credentialsDir, { recursive: true });
    }

    // Copy the file
    fs.copyFileSync(BACKUP_CREDENTIALS_PATH, CREDENTIALS_PATH);
    logger.debug('Successfully copied backup credentials', {
      from: BACKUP_CREDENTIALS_PATH,
      to: CREDENTIALS_PATH,
    });
    return true;
  } catch (error) {
    logger.error('Failed to copy backup credentials', error);
    return false;
  }
}

/**
 * Check if automatic credential restore is enabled
 */
export function isAutoRestoreEnabled(): boolean {
  return process.env.AUTOMATIC_RESTORE_CREDENTIAL === '1';
}

/**
 * Result of credential validation
 */
export interface CredentialValidationResult {
  valid: boolean;
  restored: boolean;
  error?: string;
}

/**
 * Signals that no healthy CCT slot is currently available.
 * Callers translate this into their own structured "no creds" error shape.
 */
export class NoHealthySlotError extends Error {
  constructor(message: string = 'No healthy CCT slot available — check /z cct') {
    super(message);
    this.name = 'NoHealthySlotError';
  }
}

/**
 * An auth lease on the currently-active slot.
 * Hold this for the full lifetime of a Claude CLI call, then release() in a
 * finally block. release() is idempotent.
 */
export interface SlotAuthLease {
  /**
   * Immutable AuthKey identity (replaces v1 `slotId`). Named keyId here so
   * the field matches the persisted schema and the TokenManager's public
   * `ActiveTokenInfo`.
   */
  readonly keyId: string;
  /**
   * Dispatch access token for this request (the value forwarded to the
   * Claude CLI via `CLAUDE_CODE_OAUTH_TOKEN`). For `cct / source:'setup'`
   * this is the long-lived `setupToken`, never the 1h OAuth attachment
   * access_token (see issue #673).
   *
   * Kept as `accessToken` for PR-A to avoid coupling to any not-yet-landed
   * consumer. PR-B atomically renames this to `secret` alongside its
   * `runClaudeQuery` wrapper.
   */
  readonly accessToken: string;
  /** Tagged union of the AuthKey's top-level `kind`. */
  readonly kind: 'api_key' | 'cct';
  /** Free the lease. Safe to call more than once. */
  release(): Promise<void>;
  /** Extend the lease TTL — use for long-running requests. */
  heartbeat(): Promise<void>;
}

/**
 * Acquire an auth lease on the active CCT slot.
 *
 * - Picks the currently-active HEALTHY slot via `tokenManager.acquireLease()`.
 * - Resolves the dispatch token via `getValidAccessToken(keyId, 'dispatch')`;
 *   see that method for the per-kind resolution. Callers MUST pass the
 *   lease through `buildQueryEnv(lease)` — never mutate
 *   `process.env.CLAUDE_CODE_OAUTH_TOKEN` (concurrent dispatches on
 *   different slots would race on a process-global).
 * - If no healthy slot exists, throws `NoHealthySlotError`.
 *
 * The returned lease MUST be released in a `finally` block.
 */
export async function ensureActiveSlotAuth(
  tokenManager: TokenManager,
  ownerTag: string,
  ttlMs?: number,
): Promise<SlotAuthLease> {
  let lease;
  try {
    lease = await tokenManager.acquireLease(ownerTag, ttlMs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new NoHealthySlotError(`No healthy CCT slot available — check /z cct (${message})`);
  }

  // After acquireLease, the active slot is the one we got the lease on.
  const active = tokenManager.getActiveToken();
  if (!active) {
    // Fail-safe: release then throw.
    try {
      await tokenManager.releaseLease(lease.leaseId);
    } catch {
      /* ignore */
    }
    throw new NoHealthySlotError();
  }

  // Dispatch surface — Claude CLI subprocess env. See getValidAccessToken().
  let accessToken: string;
  try {
    accessToken = await tokenManager.getValidAccessToken(active.keyId, 'dispatch');
  } catch (err) {
    try {
      await tokenManager.releaseLease(lease.leaseId);
    } catch {
      /* ignore */
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new NoHealthySlotError(`Failed to obtain valid access token for slot ${active.name}: ${message}`);
  }

  let released = false;
  const slotAuthLease: SlotAuthLease = {
    keyId: active.keyId,
    accessToken,
    kind: active.kind,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      try {
        await tokenManager.releaseLease(lease.leaseId);
      } catch (err) {
        logger.warn('releaseLease failed', err);
      }
    },
    async heartbeat(): Promise<void> {
      if (released) return;
      await tokenManager.heartbeatLease(lease.leaseId);
    },
  };
  return slotAuthLease;
}

/**
 * @deprecated Use `ensureActiveSlotAuth(tokenManager, ownerTag)` instead.
 *
 * This wrapper acquires a lease, validates it, and immediately releases it —
 * which is fine for one-shot "is a slot available?" probes, but does NOT
 * guarantee the token remains valid for the subsequent Claude CLI call.
 *
 * New callers MUST use `ensureActiveSlotAuth` and hold the lease for the
 * lifetime of the Claude CLI call.
 */
export async function ensureValidCredentials(): Promise<CredentialValidationResult> {
  try {
    const lease = await ensureActiveSlotAuth(getTokenManager(), 'legacy:ensureValidCredentials');
    await lease.release();
    return { valid: true, restored: false };
  } catch (err) {
    if (err instanceof NoHealthySlotError) {
      return { valid: false, restored: false, error: err.message };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { valid: false, restored: false, error: message };
  }
}

/**
 * Get credential status for debugging/logging
 */
export function getCredentialStatus(): {
  enabled: boolean;
  credentialsFileExists: boolean;
  backupFileExists: boolean;
  hasClaudeAiOauth: boolean;
  autoRestoreEnabled: boolean;
} {
  const enabled = isCredentialManagerEnabled();

  // If disabled, return minimal status
  if (!enabled) {
    return {
      enabled: false,
      credentialsFileExists: false,
      backupFileExists: false,
      hasClaudeAiOauth: false,
      autoRestoreEnabled: false,
    };
  }

  return {
    enabled: true,
    credentialsFileExists: fs.existsSync(CREDENTIALS_PATH),
    backupFileExists: fs.existsSync(BACKUP_CREDENTIALS_PATH),
    hasClaudeAiOauth: hasClaudeAiOauth(),
    autoRestoreEnabled: isAutoRestoreEnabled(),
  };
}
