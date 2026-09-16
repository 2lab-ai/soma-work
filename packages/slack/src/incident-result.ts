/**
 * Eagle incident *result* contract — decode a model-authored conclusion into a
 * host-owned result, and render that result onto one Slack line.
 *
 * Trust model, in one line each:
 * - The conclusion text is model output, therefore untrusted input.
 * - Correlation ids are taken from the accepted request, never from the model;
 *   an id the model *does* state must match, or the conclusion is rejected.
 * - Evidence may only reference records the host actually collected. The model's
 *   retelling of a fact is discarded and replaced by the host's recorded fact —
 *   this module makes no claim that a fact is true *now*, only that the host
 *   observed it at `observed_at` (a snapshot, not a proof).
 * - `succeeded` is earned: at least one host-verified evidence record plus a
 *   complete action proposal. A bare claim is downgraded to an explicit
 *   `inconclusive` result — never silently passed through as success.
 *
 * No Slack I/O and no logging: the caller posts, logs and applies policy.
 *
 * ## Caller obligations (this module cannot enforce these)
 *
 * 1. **Evidence currentness is the caller's contract.** Matching `id` +
 *    `observed_at` against `verifiedEvidence` proves *provenance* — that the host
 *    really recorded this observation — and nothing about whether the observation
 *    still holds. Pass only observations that are fresh and relevant to *this*
 *    attempt; handing in a long-lived registry lets a months-old fact back a
 *    `succeeded` result, and the decoder will not notice. Age out records before
 *    calling, not after.
 * 2. **Post the marker line as machine text.** Human strings are entity-escaped
 *    here (`&` `<` `>`), which stops mentions but not Slack's own autolinking of
 *    ids and bracketed text; publish the line with link unfurling off and without
 *    re-formatting it as mrkdwn.
 * 3. **Escape exactly once.** The wire strings are already entity-escaped, so the
 *    Rust side must decode entities when reading, and must not escape again — a
 *    second pass turns `&amp;` into `&amp;amp;` and corrupts the text.
 *
 * 4. **Validate what you emit.** `renderIncidentResult` is a pure serializer: it
 *    escapes and joins, it does not police. Anything published must first pass
 *    `validateIncidentResultWire` — `decodeIncidentConclusion` does this for you,
 *    but a result assembled or amended by hand (an appended caveat, a
 *    host-authored failure) must be revalidated before it goes out.
 *
 * Limits are fixed to the Rust contract: summary 500 codepoints raw, other
 * strings 1000 codepoints, every human field 1000 codepoints *after* escaping,
 * evidence 10, uncertainties 10, inbound message 16000 chars, and the rendered
 * line 16384 UTF-8 bytes — bytes, because that is what Rust measures and what a
 * Korean or emoji result blows through while its char count still looks small.
 */
import type { IncidentRequest } from './incident-contract';
import { escapeSlackMrkdwn } from './mrkdwn-escape';

export const INCIDENT_RESULT_MARKER = 'EAGLE_INCIDENT_RESULT:';

/** Model conclusion message. */
const MAX_MESSAGE_CHARS = 16000;
/** Rendered wire line, measured in UTF-8 bytes exactly as the Rust side measures it. */
const MAX_RESULT_LINE_BYTES = 16384;
const MAX_SUMMARY_CHARS = 500;
const MAX_STRING_CHARS = 1000;
/** Correlation ids — same limits the request contract enforces on the way in. */
const MAX_INCIDENT_ID_CHARS = 256;
const MAX_LIFECYCLE_ID_CHARS = 128;
const MAX_ATTEMPT_ID_CHARS = 128;
/** Human fields after entity escaping — `&` costs five codepoints, not one. */
const MAX_ESCAPED_FIELD_CHARS = 1000;
const MAX_EVIDENCE_ITEMS = 10;
const MAX_UNCERTAINTY_ITEMS = 10;

const ISO_INSTANT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;

export type IncidentResultStatus = 'running' | 'succeeded' | 'failed' | 'interrupted' | 'inconclusive';

/** Statuses the host itself may emit when no model conclusion is usable. */
export type IncidentTerminalStatus = 'failed' | 'interrupted' | 'inconclusive';

const STATUSES: ReadonlySet<string> = new Set<IncidentResultStatus>([
  'running',
  'succeeded',
  'failed',
  'interrupted',
  'inconclusive',
]);

/** One observation the host collected. `fact` is a snapshot taken at `observed_at`. */
export interface IncidentEvidenceRecord {
  readonly id: string;
  readonly observed_at: string;
  readonly fact: string;
}

export interface IncidentProposal {
  readonly id: string;
  readonly action: string;
  readonly risk: string;
  readonly rollback: string;
  readonly verification: string;
}

export interface IncidentResult {
  readonly version: 1;
  readonly incident_id: string;
  readonly lifecycle_id: string;
  readonly attempt_id: string;
  readonly status: IncidentResultStatus;
  readonly summary: string;
  readonly evidence: readonly IncidentEvidenceRecord[];
  readonly proposal: IncidentProposal | null;
  readonly uncertainties: readonly string[];
}

export type IncidentResultErrorReason =
  | 'message_too_large'
  | 'missing_marker'
  | 'multiple_markers'
  | 'malformed_marker_line'
  | 'invalid_json'
  | 'payload_not_object'
  | 'unknown_field'
  | 'missing_field'
  | 'unsupported_version'
  | 'unknown_status'
  | 'invalid_field_type'
  | 'invalid_field_value'
  | 'invalid_field_format'
  | 'field_too_long'
  | 'too_many_items'
  | 'identity_mismatch'
  | 'unknown_evidence_id'
  | 'stale_evidence_reference'
  | 'duplicate_evidence_id'
  | 'result_too_large';

/** Enumerated field names only — never a payload-supplied key. */
export type IncidentResultField =
  | 'version'
  | 'incident_id'
  | 'lifecycle_id'
  | 'attempt_id'
  | 'status'
  | 'summary'
  | 'evidence'
  | 'evidence.id'
  | 'evidence.observed_at'
  | 'evidence.fact'
  | 'proposal'
  | 'proposal.id'
  | 'proposal.action'
  | 'proposal.risk'
  | 'proposal.rollback'
  | 'proposal.verification'
  | 'uncertainties';

export interface IncidentResultError {
  readonly reason: IncidentResultErrorReason;
  readonly field?: IncidentResultField;
}

export type IncidentDowngradeReason = 'missing_verified_evidence' | 'missing_proposal';

export interface IncidentConclusionDowngrade {
  readonly from: 'succeeded';
  readonly reason: IncidentDowngradeReason;
}

export type IncidentConclusionDecode =
  | { readonly ok: true; readonly result: IncidentResult; readonly downgrade?: IncidentConclusionDowngrade }
  | { readonly ok: false; readonly error: IncidentResultError };

/** Why the host had to author the result itself. */
export type IncidentFailureCause = IncidentResultErrorReason | 'model_unavailable' | 'model_timeout' | 'host_aborted';

const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  'version',
  'incident_id',
  'lifecycle_id',
  'attempt_id',
  'status',
  'summary',
  'evidence',
  'proposal',
  'uncertainties',
]);

const EVIDENCE_KEYS: ReadonlySet<string> = new Set(['id', 'observed_at', 'fact']);

const PROPOSAL_PARTS = ['id', 'action', 'risk', 'rollback', 'verification'] as const;
const PROPOSAL_KEYS: ReadonlySet<string> = new Set(PROPOSAL_PARTS);

const DECLARED_IDS = [
  { key: 'incident_id', field: 'incident_id' as const },
  { key: 'lifecycle_id', field: 'lifecycle_id' as const },
  { key: 'attempt_id', field: 'attempt_id' as const },
];

function fail(reason: IncidentResultErrorReason, field?: IncidentResultField): IncidentConclusionDecode {
  return { ok: false, error: field === undefined ? { reason } : { reason, field } };
}

/** Unicode codepoints, the unit Rust's `chars().count()` uses — not UTF-16 units. */
function codepointLength(value: string): number {
  let count = 0;
  for (const _ of value) {
    count++;
  }
  return count;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Blank as the Rust side sees it (`ev.fact.trim().is_empty()`). `str::trim` and
 * `String.prototype.trim` agree on Unicode whitespace, NBSP included.
 */
function isBlank(value: string): boolean {
  return value.trim().length === 0;
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

/** Slack's mrkdwn control characters. Only fields rendered verbatim need this. */
function hasSlackControlChars(value: string): boolean {
  return value.includes('<') || value.includes('>') || value.includes('&');
}

/**
 * Strict UTC ISO-8601 instant, calendar-checked: `Date.parse` alone accepts
 * `2026-02-30T00:00:00Z` and silently rolls it into March.
 */
function isIsoInstant(value: string): boolean {
  const match = ISO_INSTANT_PATTERN.exec(value);
  if (match === null) {
    return false;
  }
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) {
    return false;
  }
  const utc = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day;
}

/** Bounded, control-free string check shared by every scalar in the payload. */
function checkString(
  value: unknown,
  field: IncidentResultField,
  maxChars: number,
): { ok: true; value: string } | { ok: false; error: IncidentConclusionDecode } {
  if (value === undefined) {
    return { ok: false, error: fail('missing_field', field) };
  }
  if (typeof value !== 'string') {
    return { ok: false, error: fail('invalid_field_type', field) };
  }
  if (hasControlChars(value)) {
    return { ok: false, error: fail('invalid_field_value', field) };
  }
  if (codepointLength(value) > maxChars) {
    return { ok: false, error: fail('field_too_long', field) };
  }
  if (value.length === 0) {
    return { ok: false, error: fail('invalid_field_value', field) };
  }
  return { ok: true, value };
}

/**
 * Decode a model conclusion against the request it answers and the evidence the
 * host collected for that attempt.
 *
 * `verifiedEvidence` is the host's own record set: a reference is accepted only
 * when both its id and its `observed_at` match one of these records, and the
 * published fact is always taken from the record, never from the model.
 */
export function decodeIncidentConclusion(
  text: string,
  request: IncidentRequest,
  verifiedEvidence: readonly IncidentEvidenceRecord[],
): IncidentConclusionDecode {
  if (typeof text !== 'string') {
    return fail('missing_marker');
  }
  if (text.length > MAX_MESSAGE_CHARS) {
    return fail('message_too_large');
  }
  const markerLines = text.split('\n').filter((line) => line.trim().startsWith(INCIDENT_RESULT_MARKER));
  if (markerLines.length === 0) {
    return fail('missing_marker');
  }
  if (markerLines.length > 1) {
    return fail('multiple_markers');
  }
  const payloadText = markerLines[0].trim().slice(INCIDENT_RESULT_MARKER.length).trim();
  if (payloadText.length === 0) {
    return fail('malformed_marker_line');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadText);
  } catch {
    return fail('invalid_json');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return fail('payload_not_object');
  }
  const raw = parsed as Record<string, unknown>;

  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      // Key name is model-controlled: it never leaves this function.
      return fail('unknown_field');
    }
  }

  if (raw.version === undefined) {
    return fail('missing_field', 'version');
  }
  if (raw.version !== 1) {
    return fail('unsupported_version', 'version');
  }

  // The model may restate the correlation ids, but may never choose them.
  for (const { key, field } of DECLARED_IDS) {
    const declared = raw[key];
    if (declared === undefined) {
      continue;
    }
    if (typeof declared !== 'string') {
      return fail('invalid_field_type', field);
    }
    if (declared !== request[key as 'incident_id' | 'lifecycle_id' | 'attempt_id']) {
      return fail('identity_mismatch', field);
    }
  }

  if (raw.status === undefined) {
    return fail('missing_field', 'status');
  }
  if (typeof raw.status !== 'string') {
    return fail('invalid_field_type', 'status');
  }
  if (!STATUSES.has(raw.status)) {
    return fail('unknown_status', 'status');
  }
  const status = raw.status as IncidentResultStatus;

  const summary = checkString(raw.summary, 'summary', MAX_SUMMARY_CHARS);
  if (!summary.ok) {
    return summary.error;
  }

  const evidence = resolveEvidence(raw.evidence, verifiedEvidence);
  if ('ok' in evidence) {
    return evidence;
  }

  const proposal = resolveProposal(raw.proposal);
  if ('ok' in proposal) {
    return proposal;
  }

  const uncertainties = resolveUncertainties(raw.uncertainties);
  if ('ok' in uncertainties) {
    return uncertainties;
  }

  // Success is earned by host-verified evidence plus a complete proposal.
  let downgrade: IncidentConclusionDowngrade | undefined;
  let finalStatus = status;
  if (status === 'succeeded') {
    if (evidence.records.length === 0) {
      downgrade = { from: 'succeeded', reason: 'missing_verified_evidence' };
      finalStatus = 'inconclusive';
    } else if (proposal.proposal === null) {
      downgrade = { from: 'succeeded', reason: 'missing_proposal' };
      finalStatus = 'inconclusive';
    }
  }

  const result: IncidentResult = {
    version: 1,
    incident_id: request.incident_id,
    lifecycle_id: request.lifecycle_id,
    attempt_id: request.attempt_id,
    status: finalStatus,
    summary: summary.value,
    evidence: evidence.records,
    proposal: proposal.proposal,
    uncertainties: uncertainties.values,
  };

  // Host-substituted facts have not been checked until now, and per-field bounds
  // do not bound the whole line: validate what we would actually emit.
  const wire = validateIncidentResultWire(result);
  if (!wire.ok) {
    return { ok: false, error: wire.error };
  }

  return downgrade === undefined ? { ok: true, result } : { ok: true, result, downgrade };
}

function resolveEvidence(
  value: unknown,
  verifiedEvidence: readonly IncidentEvidenceRecord[],
): { records: IncidentEvidenceRecord[] } | IncidentConclusionDecode {
  if (value === undefined) {
    return fail('missing_field', 'evidence');
  }
  if (!Array.isArray(value)) {
    return fail('invalid_field_type', 'evidence');
  }
  if (value.length > MAX_EVIDENCE_ITEMS) {
    return fail('too_many_items', 'evidence');
  }

  const byId = new Map(verifiedEvidence.map((record) => [record.id, record]));
  const seen = new Set<string>();
  const records: IncidentEvidenceRecord[] = [];

  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return fail('invalid_field_type', 'evidence');
    }
    const item = entry as Record<string, unknown>;
    for (const key of Object.keys(item)) {
      if (!EVIDENCE_KEYS.has(key)) {
        return fail('unknown_field', 'evidence');
      }
    }
    const id = checkString(item.id, 'evidence.id', MAX_STRING_CHARS);
    if (!id.ok) {
      return id.error;
    }
    const observedAt = checkString(item.observed_at, 'evidence.observed_at', MAX_STRING_CHARS);
    if (!observedAt.ok) {
      return observedAt.error;
    }
    if (!isIsoInstant(observedAt.value)) {
      return fail('invalid_field_format', 'evidence.observed_at');
    }
    const record = byId.get(id.value);
    if (record === undefined) {
      return fail('unknown_evidence_id', 'evidence.id');
    }
    if (record.observed_at !== observedAt.value) {
      return fail('stale_evidence_reference', 'evidence.observed_at');
    }
    if (seen.has(record.id)) {
      return fail('duplicate_evidence_id', 'evidence.id');
    }
    seen.add(record.id);
    // `item.fact` is intentionally dropped: the host publishes its own snapshot.
    records.push({ id: record.id, observed_at: record.observed_at, fact: record.fact });
  }

  return { records };
}

function resolveProposal(value: unknown): { proposal: IncidentProposal | null } | IncidentConclusionDecode {
  if (value === undefined) {
    return fail('missing_field', 'proposal');
  }
  if (value === null) {
    return { proposal: null };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return fail('invalid_field_type', 'proposal');
  }
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!PROPOSAL_KEYS.has(key)) {
      return fail('unknown_field', 'proposal');
    }
  }

  const parts: Record<string, string> = {};
  for (const part of PROPOSAL_PARTS) {
    const field = `proposal.${part}` as IncidentResultField;
    const checked = checkString(raw[part], field, MAX_STRING_CHARS);
    if (!checked.ok) {
      return checked.error;
    }
    parts[part] = checked.value;
  }
  // proposal.id is a correlation key rendered verbatim, so it must not carry a mention.
  if (hasSlackControlChars(parts.id)) {
    return fail('invalid_field_value', 'proposal.id');
  }

  return {
    proposal: {
      id: parts.id,
      action: parts.action,
      risk: parts.risk,
      rollback: parts.rollback,
      verification: parts.verification,
    },
  };
}

function resolveUncertainties(value: unknown): { values: string[] } | IncidentConclusionDecode {
  if (value === undefined) {
    return fail('missing_field', 'uncertainties');
  }
  if (!Array.isArray(value)) {
    return fail('invalid_field_type', 'uncertainties');
  }
  if (value.length > MAX_UNCERTAINTY_ITEMS) {
    return fail('too_many_items', 'uncertainties');
  }
  const values: string[] = [];
  for (const entry of value) {
    const checked = checkString(entry, 'uncertainties', MAX_STRING_CHARS);
    if (!checked.ok) {
      return checked.error;
    }
    values.push(checked.value);
  }
  return { values };
}

export type IncidentWireValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: IncidentResultError };

/**
 * Final outbound gate: the structural bounds this side owns — field limits,
 * escaping cost, item counts, timestamp shape and total line size — checked
 * before we emit. It is not a mirror of the Rust validator: semantic checks that
 * live there (or in `decodeIncidentConclusion`, such as matching evidence against
 * the host's records) are not repeated here.
 *
 * Covers what no inbound check can: host-substituted evidence facts (never
 * screened until this point), the cost of entity escaping (a raw-999 string with
 * `&`s renders as 1799 codepoints), and the total line measured in **UTF-8
 * bytes** — 5700 Korean codepoints look small as chars and weigh 17 kB.
 *
 * Rejects; never truncates. `decodeIncidentConclusion` calls it, and any caller
 * that assembles or amends a result (an appended caveat, a host-authored
 * failure) must call it again before publishing.
 */
export function validateIncidentResultWire(result: IncidentResult): IncidentWireValidation {
  if (result.evidence.length > MAX_EVIDENCE_ITEMS) {
    return { ok: false, error: { reason: 'too_many_items', field: 'evidence' } };
  }
  if (result.uncertainties.length > MAX_UNCERTAINTY_ITEMS) {
    return { ok: false, error: { reason: 'too_many_items', field: 'uncertainties' } };
  }

  // Fields that must carry content, not spaces: Rust rejects a blank evidence
  // fact outright, and a blank proposal part would be an action nobody can act on
  // — decode's empty-string check alone lets '   ' through.
  const mustHaveContent: Array<[string, IncidentResultField]> = [];
  for (const record of result.evidence) {
    mustHaveContent.push([record.id, 'evidence.id'], [record.fact, 'evidence.fact']);
  }
  if (result.proposal !== null) {
    mustHaveContent.push(
      [result.proposal.id, 'proposal.id'],
      [result.proposal.action, 'proposal.action'],
      [result.proposal.risk, 'proposal.risk'],
      [result.proposal.rollback, 'proposal.rollback'],
      [result.proposal.verification, 'proposal.verification'],
    );
  }
  for (const [value, field] of mustHaveContent) {
    if (typeof value !== 'string' || isBlank(value)) {
      return { ok: false, error: { reason: 'invalid_field_value', field } };
    }
  }

  // Correlation keys ship verbatim. Each carries its own limit — the request
  // contract's, not a blanket one — because a hand-built result never passed
  // through the request contract that would have bounded them.
  const verbatim: Array<[string, IncidentResultField, number]> = [
    [result.incident_id, 'incident_id', MAX_INCIDENT_ID_CHARS],
    [result.lifecycle_id, 'lifecycle_id', MAX_LIFECYCLE_ID_CHARS],
    [result.attempt_id, 'attempt_id', MAX_ATTEMPT_ID_CHARS],
  ];
  for (const record of result.evidence) {
    verbatim.push(
      [record.id, 'evidence.id', MAX_STRING_CHARS],
      [record.observed_at, 'evidence.observed_at', MAX_STRING_CHARS],
    );
  }
  if (result.proposal !== null) {
    verbatim.push([result.proposal.id, 'proposal.id', MAX_STRING_CHARS]);
  }
  for (const [value, field, maxChars] of verbatim) {
    const checked = checkVerbatimField(value, field, maxChars);
    if (checked !== undefined) {
      return checked;
    }
  }

  // decode validates observed_at, but a hand-built or amended result never met it.
  for (const record of result.evidence) {
    if (!isIsoInstant(record.observed_at)) {
      return { ok: false, error: { reason: 'invalid_field_format', field: 'evidence.observed_at' } };
    }
  }

  // Human fields are escaped on the way out, so the escaped form is what counts.
  const human: Array<[string, IncidentResultField]> = [[result.summary, 'summary']];
  for (const record of result.evidence) {
    human.push([record.fact, 'evidence.fact']);
  }
  if (result.proposal !== null) {
    human.push(
      [result.proposal.action, 'proposal.action'],
      [result.proposal.risk, 'proposal.risk'],
      [result.proposal.rollback, 'proposal.rollback'],
      [result.proposal.verification, 'proposal.verification'],
    );
  }
  for (const item of result.uncertainties) {
    human.push([item, 'uncertainties']);
  }
  for (const [value, field] of human) {
    const checked = checkHumanField(value, field);
    if (checked !== undefined) {
      return checked;
    }
  }

  // The raw summary keeps its own, tighter bound on top of the escaped one.
  if (codepointLength(result.summary) > MAX_SUMMARY_CHARS) {
    return { ok: false, error: { reason: 'field_too_long', field: 'summary' } };
  }

  if (utf8ByteLength(renderIncidentResult(result)) > MAX_RESULT_LINE_BYTES) {
    return { ok: false, error: { reason: 'result_too_large' } };
  }

  return { ok: true };
}

function checkVerbatimField(
  value: string,
  field: IncidentResultField,
  maxChars: number,
): IncidentWireValidation | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, error: { reason: 'invalid_field_value', field } };
  }
  if (hasControlChars(value)) {
    return { ok: false, error: { reason: 'invalid_field_value', field } };
  }
  if (codepointLength(value) > maxChars) {
    return { ok: false, error: { reason: 'field_too_long', field } };
  }
  return undefined;
}

function checkHumanField(value: string, field: IncidentResultField): IncidentWireValidation | undefined {
  if (typeof value !== 'string') {
    return { ok: false, error: { reason: 'invalid_field_type', field } };
  }
  if (hasControlChars(value)) {
    return { ok: false, error: { reason: 'invalid_field_value', field } };
  }
  if (codepointLength(escapeSlackMrkdwn(value)) > MAX_ESCAPED_FIELD_CHARS) {
    return { ok: false, error: { reason: 'field_too_long', field } };
  }
  return undefined;
}

/**
 * Render a result as one Slack line.
 *
 * Pure serializer: it escapes and joins, it does not police. Callers publish only
 * results that passed `validateIncidentResultWire` (see the module header).
 *
 * Human-readable strings are entity-escaped so a summary can never fire a
 * mention; correlation keys (ids, `observed_at`, `status`) are emitted verbatim
 * so the host and the Rust side can still match them — `decodeIncidentConclusion`
 * is what keeps mentions out of those fields.
 */
export function renderIncidentResult(result: IncidentResult): string {
  const wire = {
    version: 1,
    incident_id: result.incident_id,
    lifecycle_id: result.lifecycle_id,
    attempt_id: result.attempt_id,
    status: result.status,
    summary: escapeSlackMrkdwn(result.summary),
    evidence: result.evidence.map((record) => ({
      id: record.id,
      observed_at: record.observed_at,
      fact: escapeSlackMrkdwn(record.fact),
    })),
    proposal:
      result.proposal === null
        ? null
        : {
            id: result.proposal.id,
            action: escapeSlackMrkdwn(result.proposal.action),
            risk: escapeSlackMrkdwn(result.proposal.risk),
            rollback: escapeSlackMrkdwn(result.proposal.rollback),
            verification: escapeSlackMrkdwn(result.proposal.verification),
          },
    uncertainties: result.uncertainties.map((item) => escapeSlackMrkdwn(item)),
  };
  // JSON.stringify escapes newlines and other control chars, so the line stays one line.
  return `${INCIDENT_RESULT_MARKER} ${JSON.stringify(wire)}`;
}

/**
 * Host-authored result for when no model conclusion can be accepted. The cause
 * is named in the summary so a failure never reads like "nothing was wrong".
 */
export function buildHostFailureResult(
  request: IncidentRequest,
  status: IncidentTerminalStatus,
  cause: IncidentFailureCause,
): IncidentResult {
  return {
    version: 1,
    incident_id: request.incident_id,
    lifecycle_id: request.lifecycle_id,
    attempt_id: request.attempt_id,
    status,
    summary: `host produced no accepted conclusion for this attempt (cause: ${cause})`,
    evidence: [],
    proposal: null,
    uncertainties: [],
  };
}
