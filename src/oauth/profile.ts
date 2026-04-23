/**
 * Claude OAuth profile endpoint wrapper.
 *
 * Pure HTTP function — fetches the account/organization metadata for an
 * attached CCT slot. The returned profile is persisted on the slot's
 * `oauthAttachment.profile` so the card can surface the operator's email
 * and human-readable subscription tier alongside each slot.
 *
 * 401 is raised as a distinct {@link OAuthProfileUnauthorizedError} so
 * callers can intercept it and run a single non-reentrant token refresh
 * before retrying the fetch (see `TokenManager.refreshOAuthProfile`).
 */

export const CLAUDE_OAUTH_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';

const DEFAULT_TIMEOUT_MS = 5_000;
/** Keep error bodies short so redacted tokens can't smuggle more than a fragment into logs. */
const ERROR_BODY_MAX = 200;

export interface OAuthProfile {
  email?: string;
  accountUuid?: string;
  displayName?: string;
  organizationName?: string;
  organizationType?: string;
  rateLimitTier?: string;
  fetchedAt: number;
}

/**
 * Raised specifically for HTTP 401 responses so callers can drive a
 * refresh-then-retry flow without pattern-matching on a generic status
 * code. Anything else falls through as a plain {@link Error}.
 */
export class OAuthProfileUnauthorizedError extends Error {
  constructor(message: string = 'OAuth profile endpoint returned 401') {
    super(message);
    this.name = 'OAuthProfileUnauthorizedError';
  }
}

interface AccountRaw {
  email_address?: unknown;
  email?: unknown;
  display_name?: unknown;
  uuid?: unknown;
}

interface OrganizationRaw {
  name?: unknown;
  organization_type?: unknown;
  rate_limit_tier?: unknown;
}

interface ProfileRaw {
  account?: AccountRaw | null;
  organization?: OrganizationRaw | null;
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * GET https://api.anthropic.com/api/oauth/profile with the OAuth beta header.
 *
 * On 2xx: parse into an {@link OAuthProfile} with `fetchedAt = Date.now()`.
 * On 401: throw {@link OAuthProfileUnauthorizedError}.
 * On other non-2xx: throw `Error` whose message includes the status + a
 *   redacted excerpt of the body (≤200 chars).
 * On timeout: the AbortController's signal fires and the underlying fetch
 *   rejects — we re-raise as a generic `Error` with a recognisable message.
 */
export async function fetchOAuthProfile(
  accessToken: string,
  opts?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<OAuthProfile> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  // If the caller passed a signal, forward its abort into our controller so
  // their cancellation propagates to the underlying fetch. We still own the
  // timeout-driven abort locally.
  if (opts?.signal) {
    if (opts.signal.aborted) {
      controller.abort();
    } else {
      opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
  }
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(CLAUDE_OAUTH_PROFILE_URL, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`OAuth profile fetch timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 401) {
    throw new OAuthProfileUnauthorizedError();
  }

  if (!response.ok) {
    let body = '';
    try {
      body = await response.text();
    } catch {
      // ignore
    }
    const excerpt = body.length > ERROR_BODY_MAX ? `${body.slice(0, ERROR_BODY_MAX)}…` : body;
    throw new Error(`OAuth profile fetch failed: status=${response.status} body=${excerpt}`);
  }

  let parsed: ProfileRaw;
  try {
    parsed = (await response.json()) as ProfileRaw;
  } catch (err) {
    throw new Error(`OAuth profile response was not valid JSON: ${(err as Error).message}`);
  }

  const account = parsed.account ?? {};
  const organization = parsed.organization ?? {};

  const profile: OAuthProfile = {
    fetchedAt: Date.now(),
  };
  const email = pickString(account.email_address) ?? pickString(account.email);
  if (email) profile.email = email;
  const accountUuid = pickString(account.uuid);
  if (accountUuid) profile.accountUuid = accountUuid;
  const displayName = pickString(account.display_name);
  if (displayName) profile.displayName = displayName;
  const organizationName = pickString(organization.name);
  if (organizationName) profile.organizationName = organizationName;
  const organizationType = pickString(organization.organization_type);
  if (organizationType) profile.organizationType = organizationType;
  const rateLimitTier = pickString(organization.rate_limit_tier);
  if (rateLimitTier) profile.rateLimitTier = rateLimitTier;

  return profile;
}
