/**
 * send_link helpers — the URL check and the Slack message for a link the session served or published.
 * The daemon checks the URL again before it records the artifact (normalizeArtifactUrl).
 */

const MAX_URL_LENGTH = 2000;
/** Far under Slack's 40,000-character message limit: a long comment can never push the link out of the message. */
const MAX_COMMENT_LENGTH = 3000;

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

/** `<`, `>` and `&` are Slack's mrkdwn control characters: escaped, text cannot open or close a link. */
function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** A link label also must not hold `|`, which would end the URL or start the label early. */
function escapeLabel(text: string): string {
  return escapeText(text).replace(/\|/g, '¦');
}

/** The message: the comment (if any), then `🔗 <url|title>`. */
export function formatLinkMessage(args: { url: string; title?: string; comment?: string }): string {
  const url = args.url.replace(/\|/g, '%7C').replace(/>/g, '%3E').replace(/</g, '%3C');
  const title = args.title?.trim();
  const link = title ? `🔗 <${url}|${escapeLabel(title)}>` : `🔗 <${url}>`;
  const comment = args.comment?.trim();
  return comment ? `${escapeText(comment)}\n${link}` : link;
}

/** The Slack calls send_link makes (a WebClient satisfies it; tests pass a stub). */
export interface LinkClient {
  chat: {
    postMessage(args: { channel: string; thread_ts: string; text: string }): Promise<{ ts?: string }>;
    getPermalink(args: { channel: string; message_ts: string }): Promise<{ permalink?: string }>;
  };
}

/** What send_link returns — the fields the daemon's artifact capture reads. */
export interface LinkReply {
  sent: true;
  url: string;
  title?: string;
  ts: string;
  permalink: string;
  channel: string;
  thread_ts: string;
}

/**
 * Post the link into the thread. Throws — nothing is reported as sent — on a bad URL, an oversized comment, a
 * failed post, or a post Slack accepted without a message ts. A failed permalink lookup only leaves it empty.
 */
export async function postLink(
  client: LinkClient,
  target: { channel: string; threadTs: string },
  args: { url: unknown; title?: unknown; comment?: unknown },
): Promise<LinkReply> {
  const url = validateLinkUrl(args.url);
  const title = typeof args.title === 'string' ? args.title.trim().slice(0, 200) : '';
  const comment = typeof args.comment === 'string' ? args.comment : undefined;
  if (comment && comment.trim().length > MAX_COMMENT_LENGTH) {
    throw new Error(`comment is too long (max ${MAX_COMMENT_LENGTH} characters)`);
  }
  const posted = await client.chat.postMessage({
    channel: target.channel,
    thread_ts: target.threadTs,
    text: formatLinkMessage({ url, title, comment }),
  });
  if (!posted.ts) throw new Error('Slack accepted the link but returned no message ts');
  let permalink = '';
  try {
    permalink = (await client.chat.getPermalink({ channel: target.channel, message_ts: posted.ts })).permalink || '';
  } catch {
    // The link is posted; a missing permalink only drops the dashboard's "open in Slack".
  }
  return {
    sent: true,
    url,
    ...(title ? { title } : {}),
    ts: posted.ts,
    permalink,
    channel: target.channel,
    thread_ts: target.threadTs,
  };
}
