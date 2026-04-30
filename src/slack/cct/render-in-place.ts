/**
 * `renderInPlace` — surface-aware in-place CCT card update (#803).
 *
 * Why this helper exists:
 *   - Pre-#803, `activate_slot` / `next` / `detach` all called
 *     `respondWithCard(...)` which emits a fresh ephemeral card via
 *     `respond({replace_original: false})`. Result: the user clicks
 *     Activate, the original card stays stale, and a NEW ephemeral
 *     stack-up appears. Three problems:
 *       1. The active marker on the original card is wrong.
 *       2. The user has to scroll up to find the original card or
 *          re-trigger `/cct`.
 *       3. Channels accumulate stale ephemeral cards from each click.
 *   - The fix is the same surface-aware update path that
 *     `refresh_card` already uses: detect `container.type` and either
 *     `chat.update` (message) or `respond({replace_original: true})`
 *     (ephemeral). This helper extracts that decision out of every
 *     handler so each handler stays focused on its mutation.
 *
 * The helper is INTENTIONALLY transport-only — it accepts pre-built
 * `messageBlocks` / `ephemeralBlocks` factories so the caller controls
 * the render pipeline (e.g. `refresh_card` calls `renderCctCard` for
 * message surfaces to preserve the trailing `z_setting_cct_cancel`
 * actions row, while ephemerals use the lighter `buildCardFromManager`).
 *
 * On unknown surface (no container, view-tab, etc.) we LOG-AND-DROP
 * rather than stack a fresh ephemeral card on top — that is exactly the
 * bug we're fixing here. The caller can decide whether to surface a
 * banner separately.
 */

import type { WebClient } from '@slack/web-api';
import { Logger } from '../../logger';

/**
 * Bolt action body shape we depend on. Kept narrow to avoid pulling
 * the full Bolt typing surface into a transport helper that doesn't
 * own action dispatch.
 */
export interface RenderInPlaceBody {
  container?: {
    type?: 'message' | 'ephemeral' | string;
    channel_id?: string;
    message_ts?: string;
    is_ephemeral?: boolean;
  };
  channel?: { id?: string };
  message?: { ts?: string };
}

/**
 * `respond` callback shape. Bolt passes a function; we accept anything
 * with the right thenable contract.
 */
export type RespondFn = (msg: Record<string, unknown>) => Promise<unknown>;

export interface RenderInPlaceOpts {
  body: RenderInPlaceBody;
  client: WebClient;
  /** Bolt's `respond` callback. May be undefined when the action body has no response_url. */
  respond?: RespondFn;
  /** Plain-text fallback for non-block clients (Slack contract). */
  text: string;
  /**
   * Render the card blocks for a `chat.update` (message) surface. The
   * message-surface branch typically renders heavier (e.g. with the
   * trailing `z_setting_cct_cancel` row that the `/z cct` topic adds).
   */
  renderMessageBlocks: () => Promise<Record<string, unknown>[]> | Record<string, unknown>[];
  /**
   * Render the card blocks for an ephemeral `respond({replace_original})`
   * surface. Often lighter than the message-surface variant.
   */
  renderEphemeralBlocks: () => Promise<Record<string, unknown>[]> | Record<string, unknown>[];
  /**
   * Logger. Defaults to a module-scoped `CctRenderInPlace` logger when
   * absent so unit tests don't need to plumb one through.
   */
  logger?: Logger;
}

const defaultLogger = new Logger('CctRenderInPlace');

/** Extract `(channel, ts)` with the documented fallback chain. */
function extractMessageRef(body: RenderInPlaceBody): { channel?: string; ts?: string } {
  // `container.channel_id` / `container.message_ts` is Bolt's normalized
  // shape for block_action payloads. Older shapes (or some test fakes)
  // ship `channel.id` / `message.ts` at the top level. We accept either,
  // preferring container so future Bolt versions stay forward-compatible.
  const channel = body.container?.channel_id ?? body.channel?.id;
  const ts = body.container?.message_ts ?? body.message?.ts;
  return { channel, ts };
}

/**
 * Classify the surface so handlers can branch deterministically.
 *
 * Slack's container types we care about:
 *   - `'message'`     — persistent chat post; `chat.update` is the only
 *                       in-place mutation path.
 *   - `'ephemeral'`   — single-recipient post; `respond({replace_original})`
 *                       is the only in-place path. Some Bolt versions also
 *                       set `is_ephemeral: true` instead of typing it.
 *   - `'view'` / etc. — modal / app home; `chat.update` and `respond` are
 *                       both inappropriate. Caller should branch on
 *                       `'unknown'` and either show a banner or fall
 *                       through silently.
 */
export type RenderInPlaceSurface = 'message' | 'ephemeral' | 'unknown';

export function classifyRenderInPlaceSurface(body: RenderInPlaceBody): RenderInPlaceSurface {
  const containerType = body.container?.type;
  if (containerType === 'message') {
    const { channel, ts } = extractMessageRef(body);
    if (channel && ts) return 'message';
    return 'unknown';
  }
  if (containerType === 'ephemeral' || body.container?.is_ephemeral === true) {
    return 'ephemeral';
  }
  return 'unknown';
}

/**
 * Update the clicked card surface in-place.
 *
 * Returns `'message'` / `'ephemeral'` / `'unknown'` so the caller can
 * decide whether to surface a separate banner on the unknown branch.
 *
 * Failure modes:
 *   - `chat.update` throws (rate-limit, gone-channel, …) — logged, returns
 *     `'message'` so the caller knows the surface was message but the
 *     update did not land. Callers that want to surface the failure to
 *     the user must check the second return value.
 *   - `respond` is missing on an ephemeral surface — logged, returns
 *     `'ephemeral'` with `ok: false`.
 */
export interface RenderInPlaceResult {
  surface: RenderInPlaceSurface;
  /** True when the in-place update landed; false on transport failure. */
  ok: boolean;
}

export async function renderInPlace(opts: RenderInPlaceOpts): Promise<RenderInPlaceResult> {
  const { body, client, respond, text, renderMessageBlocks, renderEphemeralBlocks } = opts;
  const log = opts.logger ?? defaultLogger;
  const surface = classifyRenderInPlaceSurface(body);

  if (surface === 'message') {
    const { channel, ts } = extractMessageRef(body);
    // `surface === 'message'` already guarantees both are set, but the
    // narrowing is local to extract — assert here so the call site is
    // total without a non-null bang.
    if (!channel || !ts) {
      log.warn('renderInPlace: classified as message but channel/ts missing', { container: body.container });
      return { surface: 'unknown', ok: false };
    }
    try {
      const blocks = await renderMessageBlocks();
      // `WebClient.chat.update` returns a typed result we don't need.
      // Cast through unknown to avoid pulling Slack's argument typing
      // into the transport helper signature.
      await client.chat.update({
        channel,
        ts,
        text,
        blocks: blocks as unknown as never,
      });
      return { surface: 'message', ok: true };
    } catch (err) {
      log.warn('renderInPlace: chat.update failed', {
        err: (err as Error)?.message ?? String(err),
      });
      return { surface: 'message', ok: false };
    }
  }

  if (surface === 'ephemeral') {
    if (!respond) {
      // Ephemeral surface with no `respond` is a Bolt wiring bug — the
      // response_url is short-lived (30 minutes) and only delivered
      // through the ack callback. We log loud so someone notices.
      log.warn('renderInPlace: ephemeral surface but respond fn is missing', { container: body.container });
      return { surface: 'ephemeral', ok: false };
    }
    try {
      const blocks = await renderEphemeralBlocks();
      await respond({
        response_type: 'ephemeral',
        replace_original: true,
        text,
        blocks,
      });
      return { surface: 'ephemeral', ok: true };
    } catch (err) {
      log.warn('renderInPlace: respond failed', {
        err: (err as Error)?.message ?? String(err),
      });
      return { surface: 'ephemeral', ok: false };
    }
  }

  // Unknown surface — refuse to stack a fresh ephemeral on top of the
  // stale card. Caller may surface a banner separately if it has the
  // user/channel anchored.
  log.warn('renderInPlace: unknown surface; refusing to stack a fresh card', {
    container: body.container,
  });
  return { surface: 'unknown', ok: false };
}
