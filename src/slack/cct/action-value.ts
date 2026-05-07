/**
 * CCT button-value codec — encodes / decodes the `cm:<mode>|<payload>` form
 * stamped onto every CCT card button (#803).
 *
 * Why a codec at all?
 *   - The card is shared across viewers (channel message). The card's
 *     RENDER mode (`'admin'` vs `'readonly'`) is decided by the viewer who
 *     opened it; once posted, the mode is frozen on the message and must
 *     be PRESERVED across re-renders triggered by other viewers (e.g.
 *     non-admin clicking Refresh on an admin card must not flip it to
 *     readonly mode and lose the action buttons).
 *   - Slack passes the original button value through every action
 *     dispatch — that is the only safely-channel-attached metadata
 *     surface available to a stateless handler. Encoding mode + payload
 *     here lets handlers reconstruct the card frozen against whichever
 *     viewer first posted it.
 *
 * Wire format:
 *   `cm:admin|<payload>`     — card was posted in admin mode
 *   `cm:readonly|<payload>`  — card was posted in readonly mode
 *   `<payload>`              — legacy form (no `cm:` prefix). Decoder
 *     treats this as `kind: 'legacy'` and the handler must force
 *     `force=false` and fall back to the actor's mode for render.
 *
 * Invalid matrix (decoder rejects all of these — NO legacy fallback):
 *   - `null` / `undefined` / non-string
 *   - empty string `''`
 *   - whitespace-only
 *   - `'cm:'` (no mode, no `|`)
 *   - `'cm:admin'` (no `|`)
 *   - `'cm:admin|'` (empty payload)
 *   - `'cm:|abc'` (empty mode)
 *   - `'cm:bad|abc'` (unknown mode)
 *
 * Slack imposes a 2000-char button-value cap — encoded results are
 * length-checked at encode time so we fail fast in the builder, not at
 * dispatch.
 */

/** The two render modes a card can be frozen into. */
export type CctCardMode = 'admin' | 'readonly';

const PREFIX = 'cm:';
const SEP = '|';
/**
 * Slack hard cap on button `value`. Encoder rejects above this so a
 * builder bug surfaces immediately rather than at runtime when Slack
 * silently drops the dispatch.
 */
const SLACK_BUTTON_VALUE_MAX = 2000;

const VALID_MODES: ReadonlySet<string> = new Set<CctCardMode>(['admin', 'readonly']);

/**
 * Decoder result. `tagged` carries a parsed `cm:`-prefixed value;
 * `legacy` carries a non-empty string with NO prefix (handlers must
 * force `force=false` when acting on a legacy value); `invalid` carries
 * the raw input for logging — handlers MUST ack and refuse the action.
 */
export type DecodedCctActionValue =
  | { kind: 'tagged'; mode: CctCardMode; payload: string }
  | { kind: 'legacy'; payload: string }
  | { kind: 'invalid'; raw: unknown };

/**
 * Encode `mode` + `payload` into a button-value string.
 *
 * Throws on:
 *   - unknown mode
 *   - empty / whitespace-only payload
 *   - encoded result exceeds Slack's 2000-char button-value cap
 *
 * The throw is intentional — a builder that produces a too-long value
 * is a code bug, not a runtime input. Surfacing it here keeps the
 * action-dispatch path total.
 */
export function encodeCctActionValue(opts: { mode: CctCardMode; payload: string }): string {
  const { mode, payload } = opts;
  if (!VALID_MODES.has(mode)) {
    throw new Error(`encodeCctActionValue: unknown mode ${JSON.stringify(mode)}`);
  }
  if (typeof payload !== 'string' || payload.length === 0 || payload.trim().length === 0) {
    throw new Error('encodeCctActionValue: payload must be a non-empty, non-whitespace string');
  }
  const encoded = `${PREFIX}${mode}${SEP}${payload}`;
  if (encoded.length > SLACK_BUTTON_VALUE_MAX) {
    throw new Error(
      `encodeCctActionValue: encoded value ${encoded.length} chars exceeds Slack cap ${SLACK_BUTTON_VALUE_MAX}`,
    );
  }
  return encoded;
}

/**
 * Decode a raw button-value string into a typed result.
 *
 * Decoder is INTENTIONALLY conservative: a malformed `cm:`-prefixed
 * value is `invalid`, NOT `legacy`. Falling through to legacy on a
 * partial prefix would let a `cm:admin` (missing `|`) sneak past with
 * the actor's render mode and `force=false` — but the operator who
 * stamped that value had a typo, not a legacy card. Forcing them to
 * see "card needs re-render" is the safer failure mode.
 *
 * Tagged form parsing rule: split on the FIRST `|` only. So
 * `cm:admin|abc|def` → `{ mode: 'admin', payload: 'abc|def' }`. This
 * keeps the codec compositional (a payload may itself contain `|` — for
 * example a URL-encoded blob) without forcing the caller to escape.
 */
export function decodeCctActionValue(raw: unknown): DecodedCctActionValue {
  if (typeof raw !== 'string') return { kind: 'invalid', raw };
  if (raw.length === 0 || raw.trim().length === 0) return { kind: 'invalid', raw };
  if (!raw.startsWith(PREFIX)) {
    // Legacy: any non-empty, non-whitespace string with no `cm:` prefix.
    return { kind: 'legacy', payload: raw };
  }
  const tail = raw.slice(PREFIX.length);
  const sepIdx = tail.indexOf(SEP);
  if (sepIdx === -1) {
    // `cm:` or `cm:admin` — prefix without the `|` separator.
    return { kind: 'invalid', raw };
  }
  const mode = tail.slice(0, sepIdx);
  const payload = tail.slice(sepIdx + 1);
  if (mode.length === 0) return { kind: 'invalid', raw };
  if (payload.length === 0) return { kind: 'invalid', raw };
  if (!VALID_MODES.has(mode)) return { kind: 'invalid', raw };
  return { kind: 'tagged', mode: mode as CctCardMode, payload };
}

/**
 * Convenience: pull the inner payload from a button value, regardless of
 * `tagged` vs `legacy` form. Returns null on `invalid` — caller should
 * ack and surface a banner.
 *
 * Used by handlers that only need the keyId (or other inner ID) and not
 * the cardMode discriminant.
 */
export function readCctActionPayload(raw: unknown): string | null {
  const decoded = decodeCctActionValue(raw);
  if (decoded.kind === 'invalid') return null;
  return decoded.payload;
}
