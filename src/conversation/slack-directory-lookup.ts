/**
 * Slack directory side of the dashboard Google login (see
 * `setOAuthDirectoryLookup` in oauth.ts): resolves an email to the Slack user
 * whose workspace account carries it, via `users.lookupByEmail` (bot scope
 * `users:read.email`). Kept out of oauth.ts so that module stays Slack-free.
 */

import { Logger } from '../logger';
import type { OAuthDirectoryLookupFn } from './oauth';

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
 * Directory lookup over `lookupByEmail` (in production
 * `app.client.users.lookupByEmail`). Deactivated, bot and id-less users never
 * match; every failure resolves null so the login falls through to no_match.
 */
export function slackDirectoryLookup(lookupByEmail: LookupByEmailFn): OAuthDirectoryLookupFn {
  return async (email) => {
    let user: DirectoryUser | undefined;
    try {
      user = (await lookupByEmail({ email })).user;
    } catch (error) {
      const code = slackErrorCode(error);
      if (code === 'missing_scope') {
        logger.warn('OAuth login: Slack workspace email lookup needs the users:read.email bot scope');
      } else if (code !== 'users_not_found') {
        logger.warn('OAuth login: Slack workspace email lookup failed', { error: code });
      }
      return null;
    }
    if (!user || user.deleted || user.is_bot || !user.id) return null;
    return { userId: user.id, name: user.profile?.display_name || user.real_name || user.name || user.id };
  };
}
