/**
 * Shared types for the `/z` unified command infrastructure.
 *
 * See: plan/MASTER-SPEC.md §5 for full architecture.
 */

/**
 * Branded type — only the stored bot message ts from DmZRespond can be used as
 * a `chat.update` target. Prevents accidental passing of user message ts.
 */
export type BotMessageTs = string & { readonly __brand: 'BotMessageTs' };

/** Helper to mint a BotMessageTs from a raw string — only use in respond.ts */
export function markBotMessageTs(ts: string): BotMessageTs {
  return ts as BotMessageTs;
}

/** Entry-point origin for a `/z` invocation. */
export type ZSource = 'dm' | 'channel_mention' | 'slash';

/** Anything Bolt's `respond()` / `chat.postMessage` etc accept as a block array. */
export type ZBlock = Record<string, unknown>;

/**
 * Stable response surface across the 3 entry points.
 *
 * Invariants:
 *  - `replace` for slash/channel uses `response_url + replace_original:true`.
 *  - `replace` for DM uses `client.chat.update({ts: botMessageTs})`.
 *    `botMessageTs` is a branded type — never a user message ts.
 *  - If a required URL/ts is missing, `replace`/`dismiss` MUST explicitly
 *    surface a "UI expired" hint rather than silently no-op.
 */
export interface ZRespond {
  readonly source: ZSource;
  send(opts: { text?: string; blocks?: ZBlock[]; ephemeral?: boolean }): Promise<{ ts?: string }>;
  replace(opts: { text?: string; blocks?: ZBlock[] }): Promise<void>;
  dismiss(): Promise<void>;
}

/** Normalized invocation of the `/z` entry points. */
export interface ZInvocation {
  source: ZSource;
  /** Text with the `/z` prefix stripped. Empty string means bare `/z`. */
  remainder: string;
  /** Original text (DM body, app_mention text post bot-mention strip, or `/z` command.text). */
  rawText: string;
  /** True if the message is a cut-off legacy naked command that should show tombstone. */
  isLegacyNaked: boolean;
  /** True if message is an allowed naked command (session/new/renew/$*). */
  whitelistedNaked: boolean;
  userId: string;
  channelId: string;
  threadTs?: string;
  teamId: string;
  respond: ZRespond;
  /** Bot message ts — only set for DM path. Required for `DmZRespond.replace`. */
  botMessageTs?: BotMessageTs;
}
