/**
 * Adapts the host's SlackApiHelper to the poll service's `PollSlackApi`.
 *
 * `threadHasBotMessage` backs the roster-notice duplicate check: after a notice
 * post with an unknown outcome, delivery asks whether THIS bot already posted
 * the part (exact marker) before reposting. A message counts only when it is
 * authored by the bot (`message.user === botUserId`, same predicate as the
 * helper's thread cleanup) and contains the marker as a whole token. Every
 * page within `oldest` is scanned; any page failure throws — a partial scan is
 * "not yet checked", never "absent".
 */

import type { PollSlackApi } from '@soma/slack/poll/poll-service';
import type { SlackApiHelper } from './slack-api-helper';

type HelperLike = Pick<
  SlackApiHelper,
  'postMessage' | 'updateMessage' | 'deleteMessage' | 'getBotUserId' | 'getClient'
>;

function containsExactMarker(text: string, marker: string): boolean {
  let from = 0;
  for (;;) {
    const at = text.indexOf(marker, from);
    if (at < 0) return false;
    const before = at === 0 ? '' : text[at - 1];
    const after = text[at + marker.length] ?? '';
    // Boundaries: the marker must not be glued to digits/slashes of a longer marker.
    if (!/[0-9/]/.test(after) && !/[0-9A-Za-z_]/.test(before === '_' ? '' : before)) return true;
    from = at + 1;
  }
}

export function createPollSlackApi(helper: HelperLike): PollSlackApi {
  return {
    postMessage: (channel, text, options) => helper.postMessage(channel, text, options),
    updateMessage: (channel, ts, text, blocks) => helper.updateMessage(channel, ts, text, blocks),
    deleteMessage: (channel, ts) => helper.deleteMessage(channel, ts),
    async threadHasBotMessage(channel, threadTs, oldestSec, marker) {
      const botUserId = await helper.getBotUserId();
      const client: any = helper.getClient();
      let cursor: string | undefined;
      do {
        const response = await client.conversations.replies({
          channel,
          ts: threadTs,
          oldest: oldestSec,
          limit: 200,
          ...(cursor ? { cursor } : {}),
        });
        for (const message of (response?.messages as any[]) ?? []) {
          if (message?.user !== botUserId) continue;
          if (typeof message?.text === 'string' && containsExactMarker(message.text, marker)) return true;
        }
        const next = response?.response_metadata?.next_cursor;
        cursor = typeof next === 'string' && next.length > 0 ? next : undefined;
      } while (cursor);
      return false;
    },
  };
}
