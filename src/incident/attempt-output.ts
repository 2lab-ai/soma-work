/**
 * Eagle-eye incident attempt output — the host's guard between one unattended
 * model attempt and the Slack thread that opened it.
 *
 * Nobody watches this thread while the attempt runs, and its answer is consumed
 * by a machine: eagle-eye polls the thread for an `EAGLE_INCIDENT_RESULT:` line.
 * That makes *streaming the model* the single most dangerous thing this path
 * could do — a marker line written mid-turn would be read as a finished,
 * evidence-backed attempt before anything had validated it. So nothing the model
 * writes reaches the thread. Text is accumulated, validated once at the end
 * against the evidence the HOST recorded, and only the host's own rendering is
 * emitted.
 *
 * Three jobs, all pure (no I/O, no logging, no clock of their own):
 *
 * 1. **Registry** (`createIncidentEvidenceRegistry`) — turns the collector's
 *    output into the record set the result validator checks citations against.
 *    Admits only rows the collector marked `fresh`, carrying a real source
 *    `observed_at`, belonging to THIS attempt's incident and env.
 *    `triage.generated_at` is when the report was built, not an observation of
 *    anything, so a triage issue is never a record: an attempt whose issue
 *    matches no snapshot row has no evidence, and "no evidence" has to stay
 *    visible rather than be papered over by a report timestamp. Freshness is
 *    re-checked at validation time (`verifiedAt`) because the model's own
 *    runtime ages the evidence underneath it.
 *
 * 2. **Screening** (`screenIncidentMessage`) — decides what each SDK message may
 *    contribute. Assistant text and thinking are captured and never forwarded;
 *    partial stream events are dropped whole; usage, tool calls, tool results
 *    and session lifecycle messages pass through so the run stays observable.
 *    Unknown message types are dropped rather than forwarded: an SDK message
 *    type we have not read must not become a leak by default.
 *
 * 3. **Conclusion** (`buildIncidentAttemptOutput` / `buildIncidentTerminalMessages`)
 *    — validates the accumulated text through the result contract and renders
 *    the one line the thread gets. Every non-acceptance (abort, budget expiry,
 *    transport failure, missing or rejected marker) still yields a host-authored
 *    terminal result, so an attempt always ends with a marker eagle-eye can read
 *    and never with silence.
 *
 * The decoder, renderer and host-failure author live in
 * `packages/slack/src/incident-result.ts` and are imported, never re-implemented:
 * a second parser for the same wire format is how the two halves drift apart.
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  buildHostFailureResult,
  decodeIncidentConclusion,
  type IncidentConclusionDowngrade,
  type IncidentEvidenceRecord,
  type IncidentFailureCause,
  type IncidentResult,
  type IncidentResultError,
  type IncidentTerminalStatus,
  renderIncidentResult,
  validateIncidentResultWire,
} from '@soma/slack/incident-result';
import { escapeSlackMrkdwn } from '@soma/slack/mrkdwn-escape';
import type { EvidenceCheck, EvidenceExternal, EvidenceHost, IncidentEvidence, SanitizedText } from './evidence';
import type { IncidentRequestLike } from './sdk-options';

/**
 * Default observation window, mirroring `DEFAULT_MAX_OBSERVATION_AGE_SECONDS` in
 * `evidence.ts` (which owns the value the collector stamps `fresh` with). It is
 * re-declared rather than imported because the collector applies it at *fetch*
 * time and this module applies it again at *validation* time — two different
 * questions that happen to share a number today.
 */
export const INCIDENT_EVIDENCE_MAX_AGE_SECONDS = 180;

/** `MAX_STRING_CHARS` of the result contract — the bound a `fact` must fit. */
const MAX_FACT_CHARS = 1000;

/** `MAX_UNCERTAINTY_ITEMS` of the result contract. */
const MAX_UNCERTAINTY_ITEMS = 10;

/**
 * Defensive ceiling on the registry. One incident reaches at most three snapshot
 * rows, so this can only bind if the collector's shape changes; it exists so a
 * looping attempt cannot grow the registry without limit.
 */
const MAX_REGISTRY_RECORDS = 32;

/** Bound on the model-authored action echoed into the human-readable lines. */
const MAX_HUMAN_ACTION_CHARS = 300;

/**
 * The framing a result may never lose. The collector ships its own
 * status-specific caveat and that one is preferred; this is the fallback for an
 * attempt that never got a collection back (nothing was read, so there is no
 * source caveat to carry).
 */
export const INCIDENT_SOURCE_CAVEAT =
  'Evidence is eagle-eye collector-snapshot observations taken at the stated times, not an independent re-probe of the system now, and not a confirmed cause.';

/**
 * Strict UTC ISO-8601 instant — the shape the result contract accepts for
 * `evidence[].observed_at`. A record whose source timestamp is any other shape
 * is unusable: the model would copy it verbatim (as instructed) and the decoder
 * would reject the whole conclusion, so the record is dropped here instead.
 */
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

/**
 * Collapse C0/DEL control characters to a single space.
 *
 * Written as a code-point scan rather than a character-class regex on purpose:
 * a literal control byte in a source file is invisible to review, and writing
 * this as a regex range put three of them in this very line once already.
 * Nothing in this module may carry a control byte in its source.
 */
function stripControlChars(value: string): string {
  let out = '';
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    out += code < 0x20 || code === 0x7f ? ' ' : value[index];
  }
  return out;
}

// ------------------------------------------------------------------ registry

export interface IncidentEvidenceRegistry {
  /**
   * Record one collection. Wired to the evidence tool's `onEvidence` hook, so
   * it runs BEFORE the model sees the blob — a collection the host could not
   * record is a collection the model may not cite.
   */
  record(request: IncidentRequestLike, evidence: IncidentEvidence): void;
  /**
   * The records that are still fresh at `now`. The collector's `fresh` verdict
   * was formed when the request went out; an attempt can spend minutes thinking
   * after that, and a conclusion must not be backed by an observation that
   * aged out while it was being written.
   */
  verifiedAt(now: Date, maxAgeSeconds?: number): IncidentEvidenceRecord[];
  /** The source's own caveat from the last accepted collection. */
  sourceCaveat(): string;
  /** Counters for the completion log. Counts only — never payload text. */
  stats(): IncidentRegistryStats;
}

export interface IncidentRegistryStats {
  /** Collections offered to the registry. */
  readonly collections: number;
  /** Collections refused because they did not belong to this attempt. */
  readonly foreign: number;
  /** Distinct records currently held. */
  readonly records: number;
  /** Snapshot rows refused (stale, absent, or an unusable observation time). */
  readonly unusableRows: number;
  /** Collections that emptied a previously non-empty registry. */
  readonly invalidated: number;
}

/**
 * Build the attempt-local registry. It is scoped to one request on purpose:
 * handing a long-lived store to the decoder is exactly how a months-old fact
 * ends up backing a `succeeded` result (see the caller obligations on
 * `decodeIncidentConclusion`).
 */
export function createIncidentEvidenceRegistry(owner: IncidentRequestLike): IncidentEvidenceRegistry {
  /**
   * The CURRENT projection, keyed by `ref`.
   *
   * Each accepted collection REPLACES this map rather than merging into it. A
   * record is a citation of what the collector sees now, so a row the newest
   * read did not return is a row the host can no longer vouch for. Merging would
   * let a first, successful collection keep backing a `succeeded` conclusion
   * after a second collection came back empty or unavailable — precisely the
   * "absence proves recovery" inversion the collector refuses to make.
   */
  let records = new Map<string, IncidentEvidenceRecord>();
  let caveat = INCIDENT_SOURCE_CAVEAT;
  let collections = 0;
  let foreign = 0;
  let unusableRows = 0;
  let invalidated = 0;

  function project(evidence: IncidentEvidence): Map<string, IncidentEvidenceRecord> {
    const next = new Map<string, IncidentEvidenceRecord>();
    const snapshot = evidence.snapshot;
    if (!snapshot) return next;
    const rows = [
      snapshot.host ? projectHostRecord(snapshot.host) : undefined,
      snapshot.external ? projectExternalRecord(snapshot.external) : undefined,
      snapshot.check ? projectCheckRecord(snapshot.check) : undefined,
    ];
    for (const row of rows) {
      if (row === undefined) continue;
      if (row === null || next.size >= MAX_REGISTRY_RECORDS) {
        unusableRows += 1;
        continue;
      }
      next.set(row.id, row);
    }
    return next;
  }

  return {
    record(request, evidence) {
      collections += 1;
      // The attempt's WHOLE fixed context has to match, not just the incident:
      // `request` is the identity captured in the tool closure, `evidence` is
      // what the collector says it answered. A disagreement in any field means
      // this collection does not describe this attempt, and a record nobody can
      // place is worse than no record at all.
      const boundToAttempt =
        request.attempt_id === owner.attempt_id &&
        request.lifecycle_id === owner.lifecycle_id &&
        request.incident_id === owner.incident_id &&
        request.channel_id === owner.channel_id &&
        request.parent_ts === owner.parent_ts &&
        request.env === owner.env;
      const sameSubject = evidence.incident_id === owner.incident_id && evidence.env === owner.env;
      if (!boundToAttempt || !sameSubject) {
        foreign += 1;
        return;
      }

      if (typeof evidence.caveat === 'string' && evidence.caveat.length > 0) {
        caveat = evidence.caveat;
      }

      const next = project(evidence);
      if (next.size === 0 && records.size > 0) {
        invalidated += 1;
      }
      records = next;
    },

    verifiedAt(now, maxAgeSeconds = INCIDENT_EVIDENCE_MAX_AGE_SECONDS) {
      const at = now.getTime();
      return [...records.values()].filter((record) => {
        const observed = Date.parse(record.observed_at);
        if (!Number.isFinite(observed)) return false;
        const ageSeconds = (at - observed) / 1000;
        // A negative age is clock skew between us and eagle-eye, not a fresher
        // observation; it is tolerated only inside the same window.
        return ageSeconds <= maxAgeSeconds && ageSeconds >= -maxAgeSeconds;
      });
    },

    sourceCaveat: () => caveat,

    stats: () => ({ collections, foreign, records: records.size, unusableRows, invalidated }),
  };
}

/**
 * A row is usable only when the collector saw it *this* collection and stamped a
 * source observation time we can hand back to the decoder verbatim.
 */
function usableObservation(row: { freshness: { state: string; observed_at: string | null } }): string | null {
  if (row.freshness.state !== 'fresh') return null;
  const observedAt = row.freshness.observed_at;
  if (typeof observedAt !== 'string' || !ISO_INSTANT_PATTERN.test(observedAt)) return null;
  const parsed = Date.parse(observedAt);
  if (!Number.isFinite(parsed)) return null;
  // `Date.parse` rolls `2026-02-30T00:00:00Z` into March; the decoder
  // calendar-checks the same string, so a rolled date would be rejected there.
  return new Date(parsed).toISOString().slice(0, 19) === observedAt.slice(0, 19) ? observedAt : null;
}

function projectHostRecord(host: EvidenceHost): IncidentEvidenceRecord | null {
  const observedAt = usableObservation(host);
  if (observedAt === null) return null;
  return {
    id: host.ref,
    observed_at: observedAt,
    fact: composeFact([
      `host ${host.id}`,
      `env=${host.env}`,
      `reachable=${host.reachable}`,
      `best_effort=${host.best_effort}`,
      textPart('error', host.error),
    ]),
  };
}

function projectExternalRecord(external: EvidenceExternal): IncidentEvidenceRecord | null {
  const observedAt = usableObservation(external);
  if (observedAt === null) return null;
  return {
    id: external.ref,
    observed_at: observedAt,
    fact: composeFact([
      `external ${external.id}`,
      external.name ? `label=${external.name}` : '',
      `status=${external.status}`,
      `source=${external.source}`,
      external.probe_ms === null ? '' : `probe_ms=${external.probe_ms}`,
      external.checked_at === null ? '' : `checked_at=${external.checked_at}`,
      textPart('detail', external.detail),
    ]),
  };
}

function projectCheckRecord(check: EvidenceCheck): IncidentEvidenceRecord | null {
  const observedAt = usableObservation(check);
  if (observedAt === null) return null;
  return {
    id: check.ref,
    observed_at: observedAt,
    fact: composeFact([
      `check ${check.name}`,
      `ok=${check.ok}`,
      check.status === null ? '' : `status=${check.status}`,
      check.latency_ms === null ? '' : `latency_ms=${check.latency_ms}`,
      check.checked_at === null ? '' : `checked_at=${check.checked_at}`,
      textPart('error', check.error),
    ]),
  };
}

/**
 * Free text only ever enters a fact through the collector's sanitizer. When the
 * sanitizer refused the string (a credential shape it could not redact safely),
 * the refusal itself is the fact worth publishing — never a partial rendering of
 * something nobody understood.
 */
function textPart(label: string, value: SanitizedText): string {
  if (typeof value.text === 'string' && value.text.length > 0) {
    return value.truncated ? `${label}=${value.text} (truncated)` : `${label}=${value.text}`;
  }
  return value.omitted === 'unsafe_to_sanitize' ? `${label}=<withheld: unsafe to sanitize>` : '';
}

/**
 * Assemble one fact line. Control characters are stripped (the wire line must
 * stay one line) and the whole string is bounded to the contract's limit — the
 * fact is published verbatim by the renderer, so this is the only place its
 * shape is enforced.
 */
function composeFact(parts: string[]): string {
  const joined = stripControlChars(parts.filter((part) => part.length > 0).join(' '))
    .replace(/\s+/g, ' ')
    .trim();
  const fact = joined.length > MAX_FACT_CHARS ? `${joined.slice(0, MAX_FACT_CHARS - 1)}…` : joined;
  // A record with an empty fact would be un-renderable; the leading segment
  // always carries the record kind, so this is a floor, not a real branch.
  return fact.length > 0 ? fact : 'record observed with no reportable fields';
}

// ----------------------------------------------------------------- screening

export interface IncidentScreenResult {
  /** Model prose this message contributed. Accumulated, never forwarded. */
  readonly text: string;
  /** The message safe to forward downstream, or `null` to drop it. */
  readonly forward: SDKMessage | null;
  /** The SDK `result` message: the caller authors everything after it. */
  readonly terminal: boolean;
}

/** System subtypes that carry lifecycle only. Everything else is dropped. */
const FORWARDED_SYSTEM_SUBTYPES: ReadonlySet<string> = new Set(['init', 'status', 'compact_boundary']);

const DROP: IncidentScreenResult = { text: '', forward: null, terminal: false };

/**
 * Screen one SDK message on the incident path.
 *
 * The rule is not "redact the dangerous parts" but "forward only what has been
 * read and found to carry no model claim". Runtime signal (usage, which tool ran,
 * what the host's own tool returned, session init) is preserved so the attempt
 * stays observable and billable; prose is captured for validation and dropped.
 */
export function screenIncidentMessage(message: SDKMessage): IncidentScreenResult {
  switch (message.type) {
    case 'assistant':
      return screenAssistant(message as Extract<SDKMessage, { type: 'assistant' }>);

    // Token-level deltas. There is nothing to validate yet and no way to hold
    // half a sentence back, so the whole partial channel is dropped.
    case 'stream_event':
      return DROP;

    // Tool results and the replayed prompt. Neither is a model claim, but both
    // are rebuilt rather than forwarded — see `screenUser`.
    case 'user':
      return screenUser(message as Extract<SDKMessage, { type: 'user' }>);

    case 'system':
      return FORWARDED_SYSTEM_SUBTYPES.has((message as { subtype?: string }).subtype ?? '')
        ? { text: '', forward: message, terminal: false }
        : DROP;

    case 'result':
      return { text: '', forward: null, terminal: true };

    default:
      // Fail closed. Several SDK message types carry model-authored `summary`
      // strings; a type this module has not read is not forwarded on the chance
      // that it is harmless.
      return DROP;
  }
}

/**
 * What a forwarded tool result says in the thread. Fixed strings: the real
 * evidence belongs in the validated conclusion, not in a raw tool dump.
 */
const EVIDENCE_TOOL_RESULT_OK = '증거 조회 완료 — 검증된 결론에 포함됩니다';
const EVIDENCE_TOOL_RESULT_ERROR = '증거 조회 실패 — 결론에 반영되지 않습니다';

/**
 * Screen a `user` message — in practice the evidence tool's result coming back
 * in, and the replayed prompt.
 *
 * The content is REPLACED, not forwarded. The mapper turns a forwarded
 * `tool_result` into `rawOutput` (`sdk-message-to-event.ts:172`) and the
 * processor hands that to `onToolResult` (`stream-processor.ts:1399`), so the
 * whole evidence blob — every ref, timestamp and sanitized error the collector
 * returned — would be rendered into the thread ahead of any validation. The
 * host publishes those facts once, inside the conclusion it has checked.
 *
 * This filters OUTPUT only. The model still receives the real tool result over
 * the SDK channel; nothing about the tool exchange changes.
 *
 * `tool_use_id` and `is_error` are preserved verbatim so the thread's tool
 * lifecycle (which call, and whether it failed) stays legible and correlatable.
 */
function screenUser(message: Extract<SDKMessage, { type: 'user' }>): IncidentScreenResult {
  const inner = message.message as unknown as { content?: unknown };
  const content = Array.isArray(inner?.content) ? (inner.content as Array<Record<string, unknown>>) : [];

  const kept: Array<Record<string, unknown>> = [];
  for (const block of content) {
    if (block.type !== 'tool_result') continue;
    const failed = block.is_error === true;
    kept.push({
      type: 'tool_result',
      tool_use_id: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
      // Absence is preserved: the mapper distinguishes `undefined` from `false`.
      ...(typeof block.is_error === 'boolean' ? { is_error: block.is_error } : {}),
      content: [{ type: 'text', text: failed ? EVIDENCE_TOOL_RESULT_ERROR : EVIDENCE_TOOL_RESULT_OK }],
    });
  }

  // No tool result in it — a replayed prompt or something unread. Dropped.
  if (kept.length === 0) return DROP;

  return {
    text: '',
    forward: {
      ...message,
      message: { ...(message.message as unknown as Record<string, unknown>), content: kept },
    } as unknown as SDKMessage,
    terminal: false,
  };
}

/**
 * The only content block an incident attempt may put in front of a human.
 *
 * An allow-list, not a deny-list: the attempt has exactly one tool, so
 * `tool_use` is the complete set of blocks worth showing. Any other block —
 * `thinking`, a server-tool block, something a later SDK adds — is model-shaped
 * content that a future mapper could decide to render, and the whole point of
 * this path is that no such decision gets made downstream.
 */
const FORWARDED_CONTENT_BLOCKS: ReadonlySet<string> = new Set(['tool_use']);

function screenAssistant(message: Extract<SDKMessage, { type: 'assistant' }>): IncidentScreenResult {
  const inner = message.message as unknown as { content?: unknown };
  const content = Array.isArray(inner?.content) ? (inner.content as Array<Record<string, unknown>>) : [];

  let text = '';
  const kept: Array<Record<string, unknown>> = [];
  for (const block of content) {
    // Only `text` is the conclusion-in-progress; thinking is prose the attempt
    // is not judged on, so it is dropped without being captured.
    if (block.type === 'text' && typeof block.text === 'string') {
      text += block.text;
      continue;
    }
    if (typeof block.type === 'string' && FORWARDED_CONTENT_BLOCKS.has(block.type)) {
      kept.push(block);
    }
  }

  // The message is rebuilt rather than mutated: the SDK object is shared with
  // whatever else observes the stream.
  const forward = {
    ...message,
    message: { ...(message.message as unknown as Record<string, unknown>), content: kept },
  } as unknown as SDKMessage;

  return { text, forward, terminal: false };
}

// ---------------------------------------------------------------- conclusion

/**
 * How the attempt stopped. Everything except `model_final` is a host
 * observation; `model_final` is a claim that still has to pass validation.
 */
export type IncidentAttemptEnd =
  /** The attempt produced final text. It is untrusted until the decoder accepts it. */
  | { readonly kind: 'model_final'; readonly text: string }
  /** The SDK reported an error result (execution error, turn budget). */
  | { readonly kind: 'run_error' }
  /** The stream threw: transport, credentials, SDK. */
  | { readonly kind: 'stream_error' }
  /** The caller's abort fired (session teardown, operator stop). */
  | { readonly kind: 'aborted' }
  /** The attempt's wall-clock budget expired. */
  | { readonly kind: 'budget_expired' }
  /** The attempt wrote more prose than the host is willing to buffer. */
  | { readonly kind: 'oversize' }
  /** The stream ended without a result message and without text. */
  | { readonly kind: 'no_conclusion' };

/**
 * Ceiling on accumulated model prose — the result contract's own message bound.
 * Past it the decoder would refuse the text anyway (`message_too_large`), so the
 * host stops buffering rather than growing a string an unattended loop controls.
 */
export const MAX_MODEL_TEXT_CHARS = 16000;

/** Everything the host observed about how the stream behaved. */
export interface IncidentStreamOutcome {
  /** The attempt's wall-clock budget fired. */
  readonly budgetExpired: boolean;
  /** The attempt's abort signal is set (budget, caller, or session teardown). */
  readonly aborted: boolean;
  /** The stream threw. */
  readonly threw: boolean;
  /** The attempt wrote past `MAX_MODEL_TEXT_CHARS`; the buffer is truncated. */
  readonly oversize: boolean;
  /** The SDK `result` message, or `null` when the iterator ended without one. */
  readonly sdkResult: SDKMessage | null;
  /** Assistant prose accumulated across the run. */
  readonly modelText: string;
}

/**
 * Decide how the attempt ended, from what the HOST saw rather than from what the
 * text looks like.
 *
 * The ordering is the whole contract. Host observations (budget, abort, throw)
 * outrank the stream, because a budget abort surfaces downstream as an ordinary
 * stream end. And `model_final` requires a *successful SDK terminal*: an iterator
 * that stopped without one is a truncated stream, and a truncated stream can
 * carry a syntactically perfect marker line the model had not finished
 * qualifying. Reading that as the attempt's answer is the same mistake as
 * streaming the marker live, just later.
 */
export function resolveIncidentAttemptEnd(outcome: IncidentStreamOutcome): IncidentAttemptEnd {
  if (outcome.budgetExpired) return { kind: 'budget_expired' };
  if (outcome.aborted) return { kind: 'aborted' };
  if (outcome.threw) return { kind: 'stream_error' };
  // The buffer was truncated, so what is left is not the attempt's conclusion —
  // decoding it could accept a marker whose qualifying text was thrown away.
  if (outcome.oversize) return { kind: 'oversize' };
  if (outcome.sdkResult === null) return { kind: 'no_conclusion' };
  if (isFailedSdkResult(outcome.sdkResult)) return { kind: 'run_error' };
  if (outcome.modelText.trim().length > 0) return { kind: 'model_final', text: outcome.modelText };
  return { kind: 'no_conclusion' };
}

export interface IncidentAttemptOutput {
  /** The host-owned result. Correlation ids always come from the request. */
  readonly result: IncidentResult;
  /** The single machine-readable line, rendered by the result contract. */
  readonly line: string;
  /** Human lines followed by `line` — the exact text the thread receives. */
  readonly text: string;
  /** Why a model conclusion was refused, when there was one to refuse. Log only. */
  readonly rejected?: IncidentResultError;
  /** A `succeeded` the decoder downgraded for lack of evidence or proposal. */
  readonly downgraded?: IncidentConclusionDowngrade;
}

/**
 * Turn "how the attempt ended" into the one thing the thread is allowed to see.
 *
 * A rejected conclusion is NOT an error result: the run itself may have been
 * fine, so it terminates as `inconclusive` carrying the decoder's reason as the
 * cause. `failed` is reserved for a run that actually broke, and `interrupted`
 * for one the host stopped.
 */
export function buildIncidentAttemptOutput(
  request: IncidentRequestLike,
  end: IncidentAttemptEnd,
  verifiedEvidence: readonly IncidentEvidenceRecord[],
  sourceCaveat: string = INCIDENT_SOURCE_CAVEAT,
): IncidentAttemptOutput {
  const caveat = sourceCaveat.length > 0 ? sourceCaveat : INCIDENT_SOURCE_CAVEAT;
  const hostOutput = (status: IncidentTerminalStatus, cause: IncidentFailureCause, rejected?: IncidentResultError) =>
    present(withSourceCaveat(buildHostFailureResult(request, status, cause), caveat, request), caveat, rejected);

  switch (end.kind) {
    case 'model_final': {
      const decoded = decodeIncidentConclusion(end.text, request, verifiedEvidence);
      if (!decoded.ok) {
        return hostOutput('inconclusive', decoded.error.reason, decoded.error);
      }
      const output = present(withSourceCaveat(decoded.result, caveat, request), caveat);
      return decoded.downgrade === undefined ? output : { ...output, downgraded: decoded.downgrade };
    }
    // A conclusion from a run that broke is not a conclusion: the host cannot
    // tell a complete answer from a truncated one, so it authors its own.
    case 'run_error':
      return hostOutput('failed', 'model_unavailable');
    case 'stream_error':
      return hostOutput('failed', 'model_unavailable');
    case 'aborted':
      return hostOutput('interrupted', 'host_aborted');
    case 'budget_expired':
      return hostOutput('interrupted', 'model_timeout');
    case 'oversize':
      return hostOutput('inconclusive', 'message_too_large');
    default:
      return hostOutput('inconclusive', 'missing_marker');
  }
}

/**
 * Guarantee the source caveat survives into the published result. The model is
 * instructed to include it, which means it can also omit it; the framing of the
 * evidence is the host's to state, not the model's to drop.
 *
 * Adding the caveat re-opens every outbound bound, so each candidate is put back
 * through `validateIncidentResultWire` — the shared gate, which measures the
 * line in UTF-8 bytes and human fields in ESCAPED codepoints. A conclusion the
 * decoder accepted can stop fitting the moment a multibyte caveat is prepended,
 * and a check of our own would only be a second, divergent opinion about the
 * Rust side's limits.
 */
function withSourceCaveat(result: IncidentResult, caveat: string, request: IncidentRequestLike): IncidentResult {
  if (result.uncertainties.includes(caveat)) {
    // Already framed — but still amended relative to what the decoder saw, if
    // the caveat arrived on a host-authored result. Re-validate anyway.
    return validateIncidentResultWire(result).ok ? result : tooLargeToFrame(request, caveat);
  }
  const withCaveat: IncidentResult = {
    ...result,
    uncertainties: [caveat, ...result.uncertainties].slice(0, MAX_UNCERTAINTY_ITEMS),
  };
  if (validateIncidentResultWire(withCaveat).ok) {
    return withCaveat;
  }
  const caveatOnly: IncidentResult = { ...result, uncertainties: [caveat] };
  if (validateIncidentResultWire(caveatOnly).ok) {
    return caveatOnly;
  }
  return tooLargeToFrame(request, caveat);
}

/**
 * The result cannot carry its own framing and still fit the wire. Publishing it
 * without the caveat would be publishing a claim we refuse to make, so the
 * conclusion is dropped instead and a host failure takes its place.
 *
 * The fallback validates itself, and degrades: the collector's caveat can be the
 * very thing that does not fit (it is upstream text, and the Korean host strings
 * on this path are three bytes a character), so it steps down to this module's
 * own short constant, and finally to a host result with no variable-length field
 * at all. Something must be emittable — an attempt that ends in silence is worse
 * than one that ends saying only that it could not say anything.
 */
function tooLargeToFrame(request: IncidentRequestLike, caveat: string): IncidentResult {
  const base = buildHostFailureResult(request, 'inconclusive', 'result_too_large');
  for (const uncertainties of [[caveat], [INCIDENT_SOURCE_CAVEAT]]) {
    const candidate: IncidentResult = { ...base, uncertainties };
    if (validateIncidentResultWire(candidate).ok) {
      return candidate;
    }
  }
  return base;
}

function present(result: IncidentResult, caveat: string, rejected?: IncidentResultError): IncidentAttemptOutput {
  const line = renderIncidentResult(result);
  const text = `${humanLines(result, caveat).join('\n')}\n${line}`;
  return rejected === undefined ? { result, line, text } : { result, line, text, rejected };
}

/**
 * The few lines a human scrolling the incident thread should be able to read
 * without decoding JSON.
 *
 * Every line carries a fixed label prefix, and that is load-bearing rather than
 * cosmetic: `summary` and `proposal.action` are model-authored, and an unlabelled
 * line beginning with the result marker would be a second marker in the message —
 * a forged conclusion smuggled through the host's own rendering. The labels make
 * the emitted marker line the only line that can start with the marker.
 *
 * Model strings are additionally entity-escaped so a summary cannot fire a
 * mention, and the proposal is echoed as its action only — the thread is not the
 * place for a procedure.
 */
function humanLines(result: IncidentResult, caveat: string): string[] {
  const proposal =
    result.proposal === null ? 'none' : escapeSlackMrkdwn(truncate(result.proposal.action, MAX_HUMAN_ACTION_CHARS));
  return [
    `Eagle incident ${result.incident_id} · attempt ${result.attempt_id} — ${result.status}`,
    `summary: ${escapeSlackMrkdwn(result.summary)}`,
    `proposal: ${proposal}`,
    `evidence: ${result.evidence.length} host-verified record(s) · uncertainties: ${result.uncertainties.length}`,
    `note: ${escapeSlackMrkdwn(caveat)}`,
  ];
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

// ------------------------------------------------------------ SDK terminal

export interface IncidentTerminalMessages {
  readonly assistant: SDKMessage;
  readonly result: SDKMessage;
}

export interface IncidentTerminalContext {
  readonly sessionId: string;
  readonly model?: string;
  /**
   * The real SDK `result` message, when the stream produced one. Its usage,
   * cost and turn counters are kept so an incident attempt is still accounted
   * for; its `result` text — the model's raw final message — is replaced.
   */
  readonly sdkResult?: SDKMessage | null;
  /** Seam for tests; production uses `crypto.randomUUID`. */
  readonly uuid?: () => string;
}

/**
 * Author the two messages that end an incident attempt.
 *
 * Both carry the SAME text. The Slack processor dedupes a final result it has
 * already rendered as an assistant message (`currentMessages.includes`), so
 * matching them exactly is what keeps one attempt to one posted conclusion —
 * and it is why the result's text is the full message rather than the bare line.
 *
 * The synthesized result always reports `success` at the *SDK* level, even for a
 * failed or interrupted attempt. That is the transport's verdict, not the
 * incident's: the incident's real status lives in the marker line, and reporting
 * an SDK error here would hand the attempt to the ordinary recoverable-error
 * retry path, which would re-run an unattended incident nobody asked to repeat.
 */
export function buildIncidentTerminalMessages(
  output: IncidentAttemptOutput,
  context: IncidentTerminalContext,
): IncidentTerminalMessages {
  const uuid = context.uuid ?? (() => globalThis.crypto.randomUUID());
  const sessionId = context.sessionId;
  const prior = asResultMessage(context.sdkResult);

  const assistant = {
    type: 'assistant',
    uuid: uuid(),
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      id: `msg_incident_${output.result.attempt_id}`,
      type: 'message',
      role: 'assistant',
      model: context.model ?? 'incident-host',
      content: [{ type: 'text', text: output.text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      // Zeroed on purpose: the real token spend is on the result message below,
      // and a non-zero figure here would be double counted.
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  } as unknown as SDKMessage;

  const result = {
    type: 'result',
    subtype: 'success',
    uuid: uuid(),
    session_id: sessionId,
    is_error: false,
    result: output.text,
    stop_reason: 'end_turn',
    duration_ms: numberOr(prior?.duration_ms, 0),
    duration_api_ms: numberOr(prior?.duration_api_ms, 0),
    num_turns: numberOr(prior?.num_turns, 0),
    total_cost_usd: numberOr(prior?.total_cost_usd, 0),
    usage: prior?.usage ?? { input_tokens: 0, output_tokens: 0 },
    modelUsage: prior?.modelUsage ?? {},
    // Deliberately not carried over from `prior`: `errors` is SDK prose about a
    // run we are already reporting on, and `structured_output` /
    // `deferred_tool_use` / `permission_denials` are model-shaped payloads.
    permission_denials: [],
  } as unknown as SDKMessage;

  return { assistant, result };
}

interface PriorResultFields {
  duration_ms?: unknown;
  duration_api_ms?: unknown;
  num_turns?: unknown;
  total_cost_usd?: unknown;
  usage?: unknown;
  modelUsage?: Record<string, unknown>;
}

function asResultMessage(message: SDKMessage | null | undefined): PriorResultFields | null {
  return message && message.type === 'result' ? (message as unknown as PriorResultFields) : null;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

// ---------------------------------------------------------------- the loop

export interface IncidentStreamHooks {
  readonly request: IncidentRequestLike;
  /**
   * Host-verified records, resolved at TERMINAL time rather than up front:
   * freshness has to be judged against the clock when the conclusion is
   * validated, not when the tool ran.
   */
  readonly verifiedEvidence: () => readonly IncidentEvidenceRecord[];
  readonly sourceCaveat: () => string;
  /**
   * Host observations that outrank the stream. A budget abort reaches the loop
   * as an ordinary stream end, so the loop cannot infer either of these.
   */
  readonly observe: () => { readonly budgetExpired: boolean; readonly aborted: boolean };
  /** SDK identity for the synthesized terminal pair. */
  readonly identity: () => { readonly sessionId: string; readonly model?: string };
  /** The stream threw. The caller logs it — the error text never enters the thread. */
  readonly onStreamError?: (error: unknown) => void;
  /** The decided conclusion, before the terminal pair is yielded. Logging seam. */
  readonly onConclusion?: (output: IncidentAttemptOutput, end: IncidentAttemptEnd) => void;
  /**
   * The attempt has actually stopped — including when the consumer abandoned the
   * generator. This is where a completion marker belongs; anywhere earlier would
   * mark an attempt finished while it was still producing.
   */
  readonly onFinished?: () => void;
  readonly uuid?: () => string;
}

/**
 * Screen a whole incident attempt: consume the SDK stream, forward only what is
 * safe, and end with the host's own conclusion.
 *
 * Extracted from the handler so the property that matters — *no raw model text,
 * ever, on any exit path* — is testable against a fake SDK stream rather than
 * only in production. The handler keeps what needs a real process: the lease,
 * the abort controller, the wall-clock timer and the session marker.
 *
 * Nothing thrown by `source` escapes: a failure becomes a host-authored terminal
 * result. Rethrowing would reach the ordinary recoverable-error retry path and
 * silently re-run an unattended incident attempt nobody asked to repeat.
 */
export async function* screenIncidentStream(
  source: AsyncIterable<SDKMessage>,
  hooks: IncidentStreamHooks,
): AsyncGenerator<SDKMessage, void, unknown> {
  let modelText = '';
  let oversize = false;
  let threw = false;
  let sdkResult: SDKMessage | null = null;

  try {
    try {
      for await (const message of source) {
        const screened = screenIncidentMessage(message);
        if (screened.text) {
          if (modelText.length + screened.text.length > MAX_MODEL_TEXT_CHARS) {
            oversize = true;
          } else {
            modelText += screened.text;
          }
        }
        if (screened.terminal) {
          sdkResult = message;
          break;
        }
        if (screened.forward) yield screened.forward;
      }
    } catch (error) {
      threw = true;
      hooks.onStreamError?.(error);
    }

    const observed = hooks.observe();
    const end = resolveIncidentAttemptEnd({
      budgetExpired: observed.budgetExpired,
      aborted: observed.aborted,
      threw,
      oversize,
      sdkResult,
      modelText,
    });
    const output = buildIncidentAttemptOutput(hooks.request, end, hooks.verifiedEvidence(), hooks.sourceCaveat());
    hooks.onConclusion?.(output, end);

    const identity = hooks.identity();
    const messages = buildIncidentTerminalMessages(output, {
      sessionId: identity.sessionId,
      model: identity.model,
      sdkResult,
      uuid: hooks.uuid,
    });
    yield messages.assistant;
    yield messages.result;
  } finally {
    hooks.onFinished?.();
  }
}

/**
 * Whether an SDK `result` message reports a broken run. Used by the caller to
 * decide between validating the model's text and authoring a host failure.
 */
export function isFailedSdkResult(message: SDKMessage): boolean {
  if (message.type !== 'result') return false;
  const m = message as unknown as { is_error?: unknown; subtype?: unknown };
  return m.is_error === true || (typeof m.subtype === 'string' && m.subtype.startsWith('error_'));
}
