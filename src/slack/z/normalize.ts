/**
 * `normalizeZInvocation()` — common normalization across the 3 entry points.
 *
 * See: plan/MASTER-SPEC.md §5-2.
 *
 * Entry points produce a `ZInvocation`:
 *  - `source: 'slash'` — `/z` Slack slash command. `text` is already
 *    post-`/z` content.
 *  - `source: 'channel_mention'` — `app_mention` event. Bot mention is
 *    stripped by the caller before this function is invoked.
 *  - `source: 'dm'` — DM `message` event. `rawText` is the full DM body.
 *
 * Classification:
 *  - `remainder.startsWith('/z')` → strip `/z` + optional leading space →
 *    `isLegacyNaked=false`, `whitelistedNaked=false`.
 *  - empty remainder → treated as `/z help` request.
 *  - Whitelisted naked (session/new/renew/$…) → `whitelistedNaked=true`,
 *    `isLegacyNaked=false`, remainder is the full text.
 *  - Anything else multi-word-ish that matches a known legacy command →
 *    `isLegacyNaked=true`.
 *  - Everything else → `isLegacyNaked=false`, `whitelistedNaked=false`
 *    (unrelated prose; caller decides).
 */

import { stripZPrefix } from './strip-z-prefix';
import { isLegacyNaked } from './tombstone';
import type { ZInvocation, ZRespond, ZSource } from './types';
import { isWhitelistedNaked } from './whitelist';

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

  if (input.source === 'slash') {
    // `/z` slash — text is already post-`/z`. Always treated as a `/z` invocation.
    return makeZInvocation(input, raw, raw, { isLegacyNaked: false, whitelistedNaked: false });
  }

  // DM / channel_mention paths: detect prefix.
  const stripped = stripZPrefix(raw);
  if (stripped !== null) {
    return makeZInvocation(input, stripped, raw, { isLegacyNaked: false, whitelistedNaked: false });
  }

  // Not a `/z` invocation — classify naked.
  if (isWhitelistedNaked(raw)) {
    return makeZInvocation(input, raw, raw, { isLegacyNaked: false, whitelistedNaked: true });
  }

  if (isLegacyNaked(raw)) {
    return makeZInvocation(input, raw, raw, { isLegacyNaked: true, whitelistedNaked: false });
  }

  // Unrecognized naked input — let the caller decide (likely pass-through to Claude).
  return makeZInvocation(input, raw, raw, { isLegacyNaked: false, whitelistedNaked: false });
}

function makeZInvocation(
  input: NormalizeInput,
  remainder: string,
  rawText: string,
  flags: { isLegacyNaked: boolean; whitelistedNaked: boolean },
): ZInvocation {
  return {
    source: input.source,
    remainder,
    rawText,
    isLegacyNaked: flags.isLegacyNaked,
    whitelistedNaked: flags.whitelistedNaked,
    userId: input.userId,
    channelId: input.channelId,
    threadTs: input.threadTs,
    teamId: input.teamId,
    respond: input.respond,
  };
}
