import { getJwtSecret, issueSlackToken } from '../../conversation/oauth';
import { getViewerBaseUrl } from '../../conversation/web-server';
import { Logger } from '../../logger';
import { userSettingsStore } from '../../user-settings-store';
import { CommandParser } from '../command-parser';
import type { CommandContext, CommandHandler, CommandResult } from './types';

const logger = new Logger('DashboardHandler');

/**
 * Handles the `dashboard` Slack command (issue #704).
 *
 * Flow:
 *   1. User types `dashboard` in any thread where the bot is present.
 *   2. We verify that dashboard auth is actually configured (signing key
 *      available). If not, we refuse with an admin-facing message instead
 *      of emitting an unsigned/degenerate URL.
 *   3. We look up the requesting Slack user's display name and email from
 *      `UserSettingsStore` (auto-populated from `users.info`). The Slack
 *      event pipeline has already verified the user id upstream.
 *   4. We mint a JWT via `issueSlackToken` and reply with
 *      `${viewerBaseUrl}/auth/sso?token=<jwt>`.
 *
 * Why no admin gating:
 *   every Slack user who is accepted and reaches this handler is already
 *   allowed to see *their own* dashboard (the OAuth callback does the same).
 *   The URL is one-click, not a credential handout — it only logs in as the
 *   sender, never as someone else, because `sub` is bound to `ctx.user`.
 */
export class DashboardHandler implements CommandHandler {
  canHandle(text: string): boolean {
    return CommandParser.isDashboardCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { user, threadTs, say, postEphemeral } = ctx;

    // #716: prefer ephemeral so the SSO URL only goes to the requester.
    // Channels with multiple members do not see the link in their
    // history, notification preview, or unread count. Fall back to a
    // thread-public reply when the dispatcher did not inject
    // postEphemeral (e.g. legacy callers, tests).
    const reply = async (text: string) => {
      if (postEphemeral) {
        await postEphemeral({ text });
      } else {
        await say({ text, thread_ts: threadTs });
      }
    };

    // Refuse to mint a token when no signing key is configured. Without a
    // secret `issueSlackToken` would either sign with an ephemeral key that
    // dies on restart, or with an empty key that `verifyDashboardToken` can
    // never accept — both of which would silently break auth. Failing fast
    // with an actionable message is safer than handing out a broken URL.
    if (!getJwtSecret()) {
      await reply(
        '❌ Dashboard authentication is not configured on this server.\n' +
          'Ask an admin to set `DASHBOARD_JWT_SECRET` or `CONVERSATION_VIEWER_TOKEN` in `.env`.',
      );
      return { handled: true };
    }

    // Pull identity from UserSettingsStore. `ensureUserExists` returns
    // existing settings if present, otherwise creates a default record —
    // so new users who never finished onboarding still get a working link
    // (they'll already have been gated by the accept/deny flow upstream).
    const settings = userSettingsStore.ensureUserExists(user);
    const slackName = settings.slackName || user;
    // Email is only used for display in the dashboard header. A placeholder
    // keeps the JWT payload schema stable when Slack hasn't returned an
    // email yet (no `users:read.email` scope, bot DM before first mention,
    // etc.). Dashboard authorization keys on `sub` (Slack user id), never
    // email, so this is safe.
    const email = settings.email || `${user}@slack.local`;

    let token: string;
    try {
      token = issueSlackToken({ slackUserId: user, email, name: slackName });
    } catch (err) {
      logger.error('Failed to mint Slack SSO token', {
        error: err instanceof Error ? err.message : String(err),
        userId: user,
      });
      await reply('❌ Failed to create a dashboard login link. Check server logs.');
      return { handled: true };
    }

    const url = `${getViewerBaseUrl()}/auth/sso?token=${encodeURIComponent(token)}`;
    logger.info('Issued Slack SSO link', { userId: user });

    // Only emit the clickable `<url|label>` form — intentionally NOT the
    // raw URL again. The token is a bearer credential; printing it a
    // second time makes copy/paste from Slack logs / notification
    // previews trivial. The server-side jti store + 10-minute TTL
    // already bound the replay window, but defense in depth means not
    // echoing the credential at all. If a user needs to open the link
    // in a different browser, they can right-click → copy link on the
    // hyperlink. Issuing a fresh `dashboard` command is cheap.
    await reply(
      `🔐 *Dashboard login link* (single-use, expires in 10 minutes)\n` +
        `<${url}|Open your dashboard> — do not forward.`,
    );
    return { handled: true };
  }
}
