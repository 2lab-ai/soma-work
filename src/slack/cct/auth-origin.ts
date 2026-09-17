/**
 * Auth-origin wrapper codec (T3 follow-up, #auth-capacity-overview).
 *
 * When the CCT card is EMBEDDED in the `auth` ccp wrapper, a mutation
 * click (Activate / Detach / Next / Remove / Attach / Add / Refresh-All)
 * must re-render the AUTH WRAPPER — header, admin toggle, pagination —
 * not the bare CCT card, and at the page the user was looking at. Slack
 * handlers are stateless, so the origin travels on the two metadata
 * surfaces Slack already round-trips (no global state):
 *
 *   1. Button values — the frozen `cm:<mode>|<payload>` codec
 *      (@soma/slack) is NOT extended; instead the PAYLOAD is wrapped:
 *
 *        `cm:admin|ao:<page>|<inner>`
 *
 *      `decodeCctActionValue` splits on the FIRST `|` only, so the
 *      wrapped payload survives untouched. `decodeAuthOriginPayload`
 *      then peels `ao:<page>|` off; anything that doesn't match the
 *      strict shape is a plain (direct-card) payload — keyIds would
 *      have to literally start with `ao:<digits>|` to collide.
 *
 *   2. Modal `private_metadata` — JSON `{cctAuthOrigin:{page,channel,ts},
 *      payload}` carrying the origin PLUS the wrapper card's surface so
 *      the view submission (which has no container) can `chat.update`
 *      the auth card in place. Non-JSON metadata (the existing bare
 *      keyId form) decodes unchanged with `origin: null`.
 *
 * Direct CCT cards never produce either form, so their flows are
 * byte-identical with or without this module.
 */

/** Where an embedded CCT control originated. */
export interface CctAuthOrigin {
  /** Auth wrapper page the control was rendered on (0-based). */
  page: number;
  /** Wrapper card surface — present only in modal metadata. */
  channel?: string;
  ts?: string;
}

const PAYLOAD_RE = /^ao:(\d+)\|(.+)$/s;
const METADATA_KEY = 'cctAuthOrigin';

/** Wrap an inner button payload with the auth-origin page marker. */
export function encodeAuthOriginPayload(page: number, inner: string): string {
  if (!Number.isInteger(page) || page < 0) {
    throw new Error(`encodeAuthOriginPayload: page must be a non-negative integer, got ${page}`);
  }
  if (typeof inner !== 'string' || inner.length === 0) {
    throw new Error('encodeAuthOriginPayload: inner payload must be a non-empty string');
  }
  return `ao:${page}|${inner}`;
}

/**
 * Peel an auth-origin marker off a decoded `cm:` payload. Non-matching
 * payloads (every direct-card value) pass through with `origin: null`.
 */
export function decodeAuthOriginPayload(payload: string): { origin: CctAuthOrigin | null; payload: string } {
  const m = PAYLOAD_RE.exec(payload);
  if (!m) return { origin: null, payload };
  return { origin: { page: Number(m[1]) }, payload: m[2] };
}

/** Encode modal private_metadata carrying the origin + inner payload (keyId or 'add'). */
export function encodeAuthOriginMetadata(origin: CctAuthOrigin, payload: string): string {
  const clean: CctAuthOrigin = { page: Math.max(0, Math.floor(origin.page)) };
  if (typeof origin.channel === 'string' && origin.channel.length > 0) clean.channel = origin.channel;
  if (typeof origin.ts === 'string' && origin.ts.length > 0) clean.ts = origin.ts;
  return JSON.stringify({ [METADATA_KEY]: clean, payload });
}

/**
 * Decode modal private_metadata. Bare strings (the existing direct-card
 * keyId form) and foreign JSON decode as `{origin: null, payload: raw}`.
 */
export function decodeAuthOriginMetadata(raw: string): { origin: CctAuthOrigin | null; payload: string } {
  if (typeof raw === 'string' && raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as { [METADATA_KEY]?: unknown; payload?: unknown };
      const o = parsed?.[METADATA_KEY] as { page?: unknown; channel?: unknown; ts?: unknown } | undefined;
      if (
        parsed &&
        typeof parsed === 'object' &&
        o &&
        typeof o === 'object' &&
        typeof o.page === 'number' &&
        Number.isFinite(o.page) &&
        typeof parsed.payload === 'string'
      ) {
        const origin: CctAuthOrigin = { page: Math.max(0, Math.floor(o.page)) };
        if (typeof o.channel === 'string' && o.channel.length > 0) origin.channel = o.channel;
        if (typeof o.ts === 'string' && o.ts.length > 0) origin.ts = o.ts;
        return { origin, payload: parsed.payload };
      }
    } catch {
      // fall through — treat as a bare payload string.
    }
  }
  return { origin: null, payload: raw };
}
