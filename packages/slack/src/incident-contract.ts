/**
 * Eagle incident request contract — strict v1 parsing of the
 * `EAGLE_INCIDENT_REQUEST:` marker line.
 *
 * A message is an incident request only when a line of it starts with the
 * marker, the Slack *envelope* proves the sender is our own bot in a configured
 * incident channel, and the single JSON object on that line matches the v1
 * schema exactly. Everything else is either ordinary traffic (`non-incident`,
 * handled by the existing routes) or a `rejected` request carrying a reason and
 * nothing from the payload.
 *
 * Deliberately excluded from the schema: URLs, commands, permissions, options,
 * and any unknown key — accepting them would turn a Slack text field into a
 * remote-control surface for `event-router.ts:275` (every `app_mention` reaches
 * the ordinary message handler) and `session-initializer.ts:725` (a new root
 * thread is created unless the internal `routeContext.skipAutoBotThread` is set).
 *
 * Pure function, no I/O, no logging: the caller owns gating, dedup and policy.
 */

export const INCIDENT_REQUEST_MARKER = 'EAGLE_INCIDENT_REQUEST:';

/** Whole Slack message, marker line included. */
const MAX_MESSAGE_CHARS = 4096;
/** Opaque correlation ids — never interpreted here, only bounded. */
const MAX_ID_CHARS = 128;
/** The producer's issue identity can run longer than a correlation id, but is still bounded. */
const MAX_INCIDENT_ID_CHARS = 256;
const MAX_ENV_CHARS = 64;
const MAX_SUMMARY_CHARS = 500;

const SLACK_CHANNEL_ID_PATTERN = /^[CGD][A-Z0-9]{1,20}$/;
const SLACK_TS_PATTERN = /^\d{10}\.\d{6}$/;

export type IncidentRejectReason =
  // config
  | 'receiver_disabled'
  | 'invalid_trusted_source'
  // sender trust (envelope)
  | 'missing_sender_identity'
  | 'untrusted_team'
  | 'untrusted_app'
  | 'untrusted_bot'
  | 'untrusted_user'
  | 'untrusted_channel'
  | 'missing_event_ts'
  | 'not_in_thread'
  // marker / payload shape
  | 'message_too_large'
  | 'multiple_markers'
  | 'malformed_marker_line'
  | 'invalid_json'
  | 'payload_not_object'
  | 'unknown_field'
  | 'missing_field'
  | 'unsupported_version'
  | 'invalid_field_type'
  | 'invalid_field_value'
  | 'field_too_long'
  | 'invalid_field_format'
  // payload vs envelope
  | 'envelope_channel_mismatch'
  | 'envelope_parent_mismatch';

/**
 * Rejections caused by *who sent it* rather than *what it said*. The policy
 * layer uses this to stay quiet about strangers while alerting on a trusted bot
 * that emits garbage.
 */
const UNTRUSTED_SENDER_REASONS: ReadonlySet<IncidentRejectReason> = new Set<IncidentRejectReason>([
  'missing_sender_identity',
  'untrusted_team',
  'untrusted_app',
  'untrusted_bot',
  'untrusted_user',
  'untrusted_channel',
]);

export function isUntrustedSenderRejection(reason: IncidentRejectReason): boolean {
  return UNTRUSTED_SENDER_REASONS.has(reason);
}

const STRING_FIELDS = [
  'incident_id',
  'lifecycle_id',
  'attempt_id',
  'channel_id',
  'parent_ts',
  'env',
  'summary',
] as const;

export type IncidentRequestField = 'version' | (typeof STRING_FIELDS)[number];

const ALLOWED_KEYS: ReadonlySet<string> = new Set<string>(['version', ...STRING_FIELDS]);

const MAX_FIELD_CHARS: Record<(typeof STRING_FIELDS)[number], number> = {
  incident_id: MAX_INCIDENT_ID_CHARS,
  lifecycle_id: MAX_ID_CHARS,
  attempt_id: MAX_ID_CHARS,
  channel_id: MAX_ID_CHARS,
  parent_ts: MAX_ID_CHARS,
  env: MAX_ENV_CHARS,
  summary: MAX_SUMMARY_CHARS,
};

export interface IncidentRequest {
  readonly version: 1;
  readonly incident_id: string;
  readonly lifecycle_id: string;
  readonly attempt_id: string;
  readonly channel_id: string;
  readonly parent_ts: string;
  readonly env: string;
  readonly summary: string;
}

/**
 * Server-side trust anchor. Loaded from config by the caller — never from a
 * message body, and never with a wildcard channel.
 */
export interface TrustedIncidentSource {
  readonly teamId: string;
  readonly appId: string;
  readonly botUserId: string;
  readonly botId: string;
  readonly channelIds: readonly string[];
}

/**
 * The Slack event fields this contract authenticates against. All untrusted input.
 *
 * `team` is the workspace id the caller normalized off the *verified* Bolt body
 * (`body.team_id`), since a message event does not always carry `team` itself.
 * Normalizing it is the caller's job; this module only compares strings.
 */
export interface IncidentCandidateEvent {
  readonly text?: unknown;
  readonly team?: unknown;
  readonly user?: unknown;
  readonly app_id?: unknown;
  readonly bot_id?: unknown;
  readonly channel?: unknown;
  readonly thread_ts?: unknown;
  readonly ts?: unknown;
}

export type IncidentClassification =
  | { readonly kind: 'non-incident' }
  | { readonly kind: 'rejected'; readonly reason: IncidentRejectReason; readonly field?: IncidentRequestField }
  | { readonly kind: 'accepted'; readonly request: IncidentRequest };

const NON_INCIDENT: IncidentClassification = { kind: 'non-incident' };

function reject(reason: IncidentRejectReason, field?: IncidentRequestField): IncidentClassification {
  return field === undefined ? { kind: 'rejected', reason } : { kind: 'rejected', reason, field };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function isUsableTrustedSource(trusted: TrustedIncidentSource): boolean {
  const scalars = [trusted.teamId, trusted.appId, trusted.botUserId, trusted.botId];
  if (scalars.some((value) => typeof value !== 'string' || value.length === 0)) {
    return false;
  }
  if (!Array.isArray(trusted.channelIds) || trusted.channelIds.length === 0) {
    return false;
  }
  // No wildcard: one config typo must not open every channel.
  return trusted.channelIds.every(
    (id) => typeof id === 'string' && id.length > 0 && !id.includes('*') && SLACK_CHANNEL_ID_PATTERN.test(id),
  );
}

/**
 * Classify a Slack message event against the v1 incident contract.
 *
 * Ordering is part of the contract: marker detection first (so ordinary traffic
 * is never rejected), then sender trust (so strangers get a trust reason rather
 * than a parser reason), then shape, schema, and finally the payload-vs-envelope
 * binding.
 */
export function classifyIncidentRequest(
  event: IncidentCandidateEvent,
  trusted: TrustedIncidentSource | null | undefined,
): IncidentClassification {
  const text = typeof event.text === 'string' ? event.text : '';
  if (!text.includes(INCIDENT_REQUEST_MARKER)) {
    return NON_INCIDENT;
  }
  const markerLines = text.split('\n').filter((line) => line.trim().startsWith(INCIDENT_REQUEST_MARKER));
  if (markerLines.length === 0) {
    // The marker only appears inside a line — ordinary text, not a request.
    return NON_INCIDENT;
  }

  if (trusted === null || trusted === undefined) {
    return reject('receiver_disabled');
  }
  if (!isUsableTrustedSource(trusted)) {
    return reject('invalid_trusted_source');
  }

  const senderTrust = checkSenderTrust(event, trusted);
  if (senderTrust !== undefined) {
    return senderTrust;
  }

  if (text.length > MAX_MESSAGE_CHARS) {
    return reject('message_too_large');
  }
  if (markerLines.length > 1) {
    return reject('multiple_markers');
  }

  const payloadText = markerLines[0].trim().slice(INCIDENT_REQUEST_MARKER.length).trim();
  if (payloadText.length === 0) {
    return reject('malformed_marker_line');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadText);
  } catch {
    return reject('invalid_json');
  }

  const validated = validatePayload(parsed);
  if ('kind' in validated) {
    return validated;
  }

  // Payload may only describe the thread it was posted in.
  if (validated.channel_id !== event.channel) {
    return reject('envelope_channel_mismatch', 'channel_id');
  }
  if (validated.parent_ts !== event.thread_ts) {
    return reject('envelope_parent_mismatch', 'parent_ts');
  }

  return { kind: 'accepted', request: validated };
}

/** Envelope-only identity. The payload never establishes who sent the message. */
function checkSenderTrust(
  event: IncidentCandidateEvent,
  trusted: TrustedIncidentSource,
): IncidentClassification | undefined {
  const user = asString(event.user);
  if (user === undefined) {
    return reject('missing_sender_identity');
  }
  if (asString(event.bot_id) !== trusted.botId) {
    return reject('untrusted_bot');
  }
  if (asString(event.team) !== trusted.teamId) {
    return reject('untrusted_team');
  }
  if (asString(event.app_id) !== trusted.appId) {
    return reject('untrusted_app');
  }
  if (user !== trusted.botUserId) {
    return reject('untrusted_user');
  }
  const channel = asString(event.channel);
  if (channel === undefined || !trusted.channelIds.includes(channel)) {
    return reject('untrusted_channel');
  }

  const ts = asString(event.ts);
  if (ts === undefined) {
    return reject('missing_event_ts');
  }
  const threadTs = asString(event.thread_ts);
  if (threadTs === undefined || threadTs === ts) {
    // Requests live as replies under an existing incident parent, never at root.
    return reject('not_in_thread');
  }
  return undefined;
}

function validatePayload(parsed: unknown): IncidentRequest | IncidentClassification {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return reject('payload_not_object');
  }
  const raw = parsed as Record<string, unknown>;

  for (const key of Object.keys(raw)) {
    if (!ALLOWED_KEYS.has(key)) {
      // The key name is attacker-controlled — it never leaves this function.
      return reject('unknown_field');
    }
  }

  if (raw.version === undefined) {
    return reject('missing_field', 'version');
  }
  if (raw.version !== 1) {
    return reject('unsupported_version', 'version');
  }

  const values: Record<string, string> = {};
  for (const field of STRING_FIELDS) {
    const value = raw[field];
    if (value === undefined) {
      return reject('missing_field', field);
    }
    if (typeof value !== 'string') {
      return reject('invalid_field_type', field);
    }
    if (hasControlChars(value)) {
      return reject('invalid_field_value', field);
    }
    if (value.length > MAX_FIELD_CHARS[field]) {
      return reject('field_too_long', field);
    }
    if (value.length === 0 && field !== 'summary') {
      return reject('invalid_field_value', field);
    }
    values[field] = value;
  }

  if (!SLACK_CHANNEL_ID_PATTERN.test(values.channel_id)) {
    return reject('invalid_field_format', 'channel_id');
  }
  if (!SLACK_TS_PATTERN.test(values.parent_ts)) {
    return reject('invalid_field_format', 'parent_ts');
  }

  return {
    version: 1,
    incident_id: values.incident_id,
    lifecycle_id: values.lifecycle_id,
    attempt_id: values.attempt_id,
    channel_id: values.channel_id,
    parent_ts: values.parent_ts,
    env: values.env,
    summary: values.summary,
  };
}
