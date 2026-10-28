/**
 * Slack directory side of the dashboard Google login (see
 * `setOAuthDirectoryLookup` in oauth.ts): resolves an email to the Slack user
 * whose workspace account carries it, via `users.lookupByEmail` (bot scope
 * `users:read.email`). Kept out of oauth.ts so that module stays Slack-free.
 */

import { WebClient } from '@slack/web-api';
import { Logger } from '../logger';
import { DirectoryLookupMisconfigured, OAUTH_DIRECTORY_LOOKUP_TIMEOUT_MS, type OAuthDirectoryLookupFn } from './oauth';

const logger = new Logger('OAuth');

/** The part of a `users.lookupByEmail` user this module reads. */
interface DirectoryUser {
  id?: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  profile?: { display_name?: string };
}

type LookupByEmailFn = (args: { email: string }) => Promise<{ user?: DirectoryUser }>;

/**
 * The Slack error code only (`data.error` for platform errors, `code` for
 * request / rate-limit errors) — never the message or the response body.
 */
function slackErrorCode(error: unknown): string {
  const e = error as { data?: { error?: unknown }; code?: unknown } | null | undefined;
  if (typeof e?.data?.error === 'string' && e.data.error) return e.data.error;
  if (typeof e?.code === 'string' && e.code) return e.code;
  return 'unknown';
}

/**
 * Directory lookup over `lookupByEmail`. Deactivated, bot and id-less users
 * never match. `users_not_found` resolves null — no account, so the login
 * reports no_match. `missing_scope` (warned) rejects as
 * DirectoryLookupMisconfigured: only an admin can fix it. Any other failure
 * (rate limit, network) says nothing about the account: it rejects with the
 * Slack code only, and the login reports Slack as unavailable.
 */
export function slackDirectoryLookup(lookupByEmail: LookupByEmailFn): OAuthDirectoryLookupFn {
  return async (email) => {
    let user: DirectoryUser | undefined;
    try {
      user = (await lookupByEmail({ email })).user;
    } catch (error) {
      const code = slackErrorCode(error);
      if (code === 'users_not_found') return null;
      if (code === 'missing_scope') {
        logger.warn('OAuth login: Slack workspace email lookup needs the users:read.email bot scope');
        throw new DirectoryLookupMisconfigured(code);
      }
      throw new Error(code);
    }
    if (!user || user.deleted || user.is_bot || !user.id) return null;
    return { userId: user.id, name: user.profile?.display_name || user.real_name || user.name || user.id };
  };
}

/**
 * The production directory lookup, on its own Slack client.
 *
 * A WebClient pauses its whole request queue for Retry-After whenever any
 * method is rate limited. On the bot's shared client, busy threads rate-limit
 * `chat.update` often, so a login lookup queued behind that pause (10 s) missed
 * the login's 5 s budget and failed although Slack knew the account. This
 * client carries only lookups, gives up on its own 429 at once, does not retry
 * and times out with the login.
 */
export function createSlackDirectoryLookup(
  token: string,
  options: { slackApiUrl?: string } = {},
): OAuthDirectoryLookupFn {
  const client = new WebClient(token, {
    rejectRateLimitedCalls: true,
    retryConfig: { retries: 0 },
    timeout: OAUTH_DIRECTORY_LOOKUP_TIMEOUT_MS,
    ...(options.slackApiUrl ? { slackApiUrl: options.slackApiUrl } : {}),
  });
  return slackDirectoryLookup((args) => client.users.lookupByEmail(args));
}
