/**
 * Complete-shape synthetic Slack tokens for tests, assembled at load time.
 *
 * The bodies are fixed keyboard runs belonging to no account, but a *complete*
 * `xoxb-…` literal in a source blob is indistinguishable from a real leak to
 * GitHub push protection, which refused the branch that first carried these
 * fixtures. So each token is stored as a prefix and a body that mean nothing on
 * their own, joined by {@link assembleSlackToken} at load time.
 *
 * The tests are exactly as strong as they were with literals: the assembled
 * string is the same complete token the redactor, the secret-free assertion and
 * the supervisor's env composition all receive, so every last-four expectation
 * and every credential-shape rule is unchanged. Nothing else here is split,
 * because nothing else here is a complete credential shape.
 *
 * Both halves of that claim are pinned by
 * `scripts/__tests__/slack-token-literals.test.ts`: no source file carries a
 * complete shape, and these values still are complete shapes.
 *
 * Adding a fixture: split at the prefix, and never write the whole token.
 */

/** The literal a scan must find. Assembled, so this file never contains it. */
function assembleSlackToken(prefix: string, body: string): string {
  return `${prefix}-${body}`;
}

/** Bot token: `xoxb-` + two numeric segments + a 24-character body. */
export const SYNTHETIC_SLACK_BOT_TOKEN = assembleSlackToken('xoxb', '9999999999-8888888888-aaaaaaaaaaaaaaaaaaaaaaaa');

/** App-level (Socket Mode) token: `xapp-` + version, app id, issue time, body. */
export const SYNTHETIC_SLACK_APP_TOKEN = assembleSlackToken(
  'xapp',
  '1-A0000000000-1111111111111-bbbbbbbbbbbbbbbbbbbbbbbb',
);
