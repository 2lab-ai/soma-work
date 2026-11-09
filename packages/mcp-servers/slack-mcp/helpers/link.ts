/**
 * send_link helpers — the URL check and the Slack message for a link the session served or published.
 * The daemon checks the URL again before it records the artifact (normalizeArtifactUrl).
 */

const MAX_URL_LENGTH = 2000;

/**
 * The URL as it will be posted: http(s) only, no user:password part, at most 2000 characters.
 * Throws a message the model can act on.
 */
export function validateLinkUrl(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) throw new Error('url is required');
  if (text.length > MAX_URL_LENGTH) throw new Error(`url is too long (max ${MAX_URL_LENGTH} characters)`);
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    throw new Error(`not a valid URL: ${text.slice(0, 100)}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`only http(s) URLs can be sent as links (got ${u.protocol})`);
  }
  if (u.username || u.password) throw new Error('url must not carry credentials (user:password@)');
  if (u.href.length > MAX_URL_LENGTH) throw new Error(`url is too long (max ${MAX_URL_LENGTH} characters)`);
  return u.href;
}

/** `<`, `>` and `&` are Slack's mrkdwn control characters; `|` would end a link's URL or start its label early. */
function escapeLabel(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '¦');
}

/** The message: the comment (if any), then `🔗 <url|title>`. */
export function formatLinkMessage(args: { url: string; title?: string; comment?: string }): string {
  const url = args.url.replace(/\|/g, '%7C').replace(/>/g, '%3E').replace(/</g, '%3C');
  const title = args.title?.trim();
  const link = title ? `🔗 <${url}|${escapeLabel(title)}>` : `🔗 <${url}>`;
  const comment = args.comment?.trim();
  return comment ? `${comment}\n${link}` : link;
}
