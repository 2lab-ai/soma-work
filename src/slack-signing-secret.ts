/**
 * Slack signing-secret contract — one place that says what the secret is for.
 *
 * A Slack *signing secret* exists for exactly one purpose: verifying the
 * `X-Slack-Signature` / `X-Slack-Request-Timestamp` headers on requests Slack
 * delivers to an **HTTP** endpoint. Socket Mode delivers events over an
 * outbound WebSocket authenticated by the app-level token (`xapp-…`), so no
 * request signature is ever computed or checked, and no signing secret is
 * required to run this bot.
 *
 * That asymmetry is encoded here:
 *   - Socket Mode construction omits the `signingSecret` key entirely when
 *     none is configured (`signingSecretOption`), rather than passing an
 *     explicit `undefined`. To Bolt itself the two are identical — `App.js`
 *     destructures its options as `{ signingSecret = undefined, … }`, and a
 *     destructuring default fires on the value whether or not the key exists.
 *     We omit it for the surfaces Bolt does not control: an options or config
 *     object that never carries a declared-but-empty secret survives
 *     `JSON.stringify`, diffing, and logging unambiguously, and a future
 *     receiver or config consumer cannot mistake "the operator set it to
 *     nothing" for "the operator set it".
 *   - A secret that *is* configured must still look like a real one
 *     ({@link SIGNING_SECRET_MIN_LENGTH}); a truncated paste is an operator
 *     error, not a reason to continue quietly.
 *   - An HTTP receiver must fail closed via {@link requireSigningSecret}
 *     rather than boot without signature verification.
 *
 * No function here ever puts a secret value into a message or a log — only its
 * length and the property name.
 */

/**
 * Minimum length for a *provided* signing secret. Slack issues 32 hex chars;
 * 20 is a deliberately loose floor that still catches truncated pastes and
 * placeholder strings without pinning us to Slack's current format.
 */
export const SIGNING_SECRET_MIN_LENGTH = 20;

/**
 * Receiver kinds that require a signing secret. Only HTTP delivery verifies
 * request signatures — Socket Mode is intentionally absent from this union so
 * a caller cannot ask for a Socket Mode secret requirement by mistake.
 */
export type SigningSecretReceiverKind = 'http';

/**
 * Normalize a raw signing secret. Blank and whitespace-only values mean "the
 * operator never configured one" (an empty `SLACK_SIGNING_SECRET=` line, a
 * cleared JSON field) and collapse to `undefined`; a real value is trimmed.
 */
export function normalizeSigningSecret(raw: string | undefined | null): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Build the `signingSecret` slice of Bolt `App` options for a Socket Mode
 * runtime. Returns an object with NO `signingSecret` own property when none is
 * configured, so `{ ...signingSecretOption(secret) }` adds the key only when
 * there is a value to add.
 *
 * Bolt treats an absent key and an explicit `undefined` the same way (see the
 * module header); keeping the key out is about the option object's own shape —
 * canonical when serialized, and unambiguous to anything that inspects it.
 */
export function signingSecretOption(secret: string | undefined | null): { signingSecret?: string } {
  const normalized = normalizeSigningSecret(secret);
  return normalized === undefined ? {} : { signingSecret: normalized };
}

/**
 * Fail-closed accessor for receivers that DO verify request signatures.
 * Throws when the secret is absent, blank, or implausibly short — never
 * returns a value that would leave signature verification disabled.
 *
 * Not called by the Socket Mode runtime (which needs no secret); it exists so
 * that any HTTP receiver added later cannot silently skip verification.
 *
 * @throws Error naming the receiver kind and the offending length — never the
 *         secret value itself.
 */
export function requireSigningSecret(
  value: string | undefined | null,
  receiverKind: SigningSecretReceiverKind = 'http',
): string {
  const normalized = normalizeSigningSecret(value);
  if (normalized === undefined) {
    throw new Error(
      `signingSecret is required for the ${receiverKind} receiver: ` +
        'Slack request signature verification cannot run without it.',
    );
  }
  if (normalized.length < SIGNING_SECRET_MIN_LENGTH) {
    throw new Error(
      `signingSecret is too short for the ${receiverKind} receiver ` +
        `(${normalized.length} chars; minimum ${SIGNING_SECRET_MIN_LENGTH}).`,
    );
  }
  return normalized;
}
