/**
 * `normalizeZInvocation()` — common normalization across the 3 entry points.
 *
 * See: docs/current/spec/z-command-master-spec.md §5-2.
 *
 * Entry points produce a `ZInvocation`:
 *  - `source: 'slash'` — `/z` Slack slash command. `text` is already
 *    post-`/z` content.
 *  - `source: 'channel_mention'` — `app_mention` event. Bot mention is
 *    stripped by the caller before this function is invoked.
 *  - `source: 'dm'` — DM `message` event. `rawText` is the full DM body.
 *
 * Remainder:
 *  - `slash` → the text as given (Slack already removed `/z`).
 *  - text starting with `/z` → `/z` + optional leading space stripped.
 *  - anything else → the full text (callers only route `/z`-prefixed DM and
 *    app-mention text here; bare commands go to CommandRouter, #531).
 *  - empty remainder → treated as `/z help` request by the router.
 */

import { stripZPrefix } from './strip-z-prefix';
import type { ZInvocation, ZRespond, ZSource } from './types';

// BC re-export — `slack-handler.ts`, `event-router.ts`, `command-router.ts`,
// and `__tests__/normalize.test.ts` still import `stripZPrefix` from here.
// Authoritative location is `./strip-z-prefix`; do not delete this re-export
// without migrating all four call sites first (#745 follow-up candidate).
export { stripZPrefix } from './strip-z-prefix';

export interface NormalizeInput {
  source: ZSource;
  /** Raw input text. For `slash` this is the `text` field (already stripped of `/z`). */
  text: string;
  userId: string;
  channelId: string;
  threadTs?: string;
  teamId: string;
  respond: ZRespond;
}

/**
 * Normalize raw entry-point input into a `ZInvocation`.
 */
export function normalizeZInvocation(input: NormalizeInput): ZInvocation {
  const raw = (input.text ?? '').trim();

  // `/z` slash — text is already post-`/z`. DM / channel_mention: strip the prefix.
  const stripped = input.source === 'slash' ? raw : stripZPrefix(raw);
  return makeZInvocation(input, stripped ?? raw, raw);
}

function makeZInvocation(input: NormalizeInput, remainder: string, rawText: string): ZInvocation {
  return {
    source: input.source,
    remainder,
    rawText,
    userId: input.userId,
    channelId: input.channelId,
    threadTs: input.threadTs,
    teamId: input.teamId,
    respond: input.respond,
  };
}
