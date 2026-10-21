/**
 * Eagle-eye incident evidence collector — server-side, read-only.
 *
 * Fetches the two fixed eagle-eye endpoints (`GET /api/triage`,
 * `GET /api/snapshot`) and projects the records that belong to ONE incident in
 * ONE env into a bounded, sanitized evidence object. It is the data half of a
 * later SDK tool; nothing here is registered with the SDK yet.
 *
 * Design boundaries (each exists because of a specific failure it prevents):
 *
 * - **No model-controlled addressing.** The origin comes from operator config,
 *   the two paths are constants. No URL, path, query or header is ever derived
 *   from a request/model string, so a prompt cannot aim this at another host.
 * - **No credentials.** Requests go out bare (`accept: application/json`).
 *   There is no auth hook: adding one means deciding where the secret lives,
 *   which is a separate, reviewable change.
 * - **Bounded I/O.** `redirect: 'error'`, a real `AbortController` timeout
 *   capped at 10s, and a 2MB streaming byte cap — an eagle-eye that turns into
 *   a redirect to somewhere else, or into an endless body, must fail loudly.
 * - **Safelist projection.** Only the fields listed in the projection types
 *   below cross this boundary; the raw snapshot (every env, every host, every
 *   check URL) never does.
 * - **Observation times are the record's own.** `collected_at` is OUR clock and
 *   is labelled as such; freshness comes from the row that is being reported
 *   (`Host.probed_at`, `Check.checked_at`, `ExternalService.checked_at`) and
 *   from `TriageReport.generated_at` — never from the batch
 *   `snapshot.observed_at.*`, which is the newest observation across a whole
 *   source and would let a fresh sibling dress a stale row as current. Absent
 *   or stale says so rather than passing for current.
 * - **Absence is not recovery.** An incident id missing from triage yields
 *   `not_currently_reported` — this collector has no history and cannot tell
 *   "resolved" from "never seen" from "the detector changed its mind".
 *
 * Field names inside projected records mirror the eagle-eye JSON verbatim
 * (`best_effort`, `probe_ms`, `checked_at`, …) so drift against the Rust
 * structs is greppable; wrapper fields this module invents (`ref`, `state`,
 * `freshness`) are its own vocabulary.
 *
 * Upstream schema (read 2026-09-11):
 *   eagle-eye src/triage.rs        — TriageReport, TriageIssue, console keys
 *   eagle-eye src/collect/mod.rs   — Snapshot, Host
 *   eagle-eye src/collect/http.rs  — Check
 *   eagle-eye src/collect/external.rs — ExternalStatus, ExternalService
 */

const TRIAGE_PATH = '/api/triage';
const SNAPSHOT_PATH = '/api/snapshot';

/** Hard ceiling on one request; a Slack turn must not hang on eagle-eye. */
const MAX_TIMEOUT_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 10_000;

/** Hard ceiling on one response body. Triage+snapshot are ~100KB in practice. */
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Default freshness window for a source observation. */
const DEFAULT_MAX_OBSERVATION_AGE_SECONDS = 180;

/** Bound on any free-text string that survives sanitization. */
const MAX_TEXT_CHARS = 240;

/** Abort reasons — descriptive, never a bare `.abort()` (B-2). */
const TIMEOUT_ABORT_REASON = 'incident-evidence-timeout';
const CALLER_ABORT_REASON = 'incident-evidence-caller-abort';

// ------------------------------------------------------------------ types

export interface IncidentEvidenceConfig {
  /**
   * Operator-configured eagle-eye origin (scheme + host [+ port] only).
   * NEVER assembled from model output, tool arguments or message text.
   */
  baseUrl: string;
  /** Observation older than this is reported `stale` (default 180s). */
  maxObservationAgeSeconds?: number;
  /** Per-request timeout; clamped to 10s. */
  timeoutMs?: number;
}

export interface IncidentEvidenceRequest {
  /** `TriageIssue.id` — matched exactly, never by prefix or substring. */
  incident_id: string;
  /** Display env from the fixed session (e.g. `dev2`, `givenchy-prod`). */
  env: string;
  /** Optional caller cancellation (session teardown). */
  signal?: AbortSignal;
}

export interface IncidentEvidenceDeps {
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

export type IncidentEvidenceStatus =
  /** Triage currently reports this id, attributed to the requested env. */
  | 'reported'
  /** Triage reports this id, but not for the requested env. */
  | 'env_mismatch'
  /** No issue with this id in the current triage report. NOT "recovered". */
  | 'not_currently_reported'
  /** Nothing could be read; see `errors`. */
  | 'evidence_unavailable';

export type EvidenceErrorKind =
  | 'http_status'
  | 'malformed_json'
  | 'oversize'
  | 'timeout'
  | 'redirect'
  | 'aborted'
  | 'network';

export interface EvidenceError {
  /** Which endpoint failed, in the same ref vocabulary as the records. */
  ref: string;
  kind: EvidenceErrorKind;
  status?: number;
  message: string;
}

/** A free-text field after redaction — or withheld when redaction is unsure. */
export interface SanitizedText {
  /** null when the string could not be sanitized safely, or was absent. */
  text: string | null;
  redacted: boolean;
  truncated: boolean;
  omitted?: 'unsafe_to_sanitize' | 'absent';
}

export interface ObservationFreshness {
  state: 'fresh' | 'stale' | 'absent';
  /** The SOURCE's observation time, never this collector's clock. */
  observed_at: string | null;
  age_seconds: number | null;
}

export interface EvidenceIssue {
  ref: string;
  id: string;
  cat: string;
  key: string | null;
  text: SanitizedText;
  detail: SanitizedText;
  envs: string[];
}

export interface EvidenceHost {
  ref: string;
  id: string;
  env: string;
  reachable: boolean;
  best_effort: boolean;
  error: SanitizedText;
  freshness: ObservationFreshness;
}

export interface EvidenceExternal {
  ref: string;
  id: string;
  /** `ExternalService.label` — the upstream row has no `name` field. */
  name: string;
  status: string;
  /** `"probe" | "statuspage" | "both"` — how eagle-eye learned that status. */
  source: string;
  detail: SanitizedText;
  probe_ms: number | null;
  checked_at: string | null;
  freshness: ObservationFreshness;
}

export interface EvidenceCheck {
  ref: string;
  name: string;
  ok: boolean;
  status: number | null;
  latency_ms: number | null;
  checked_at: string | null;
  error: SanitizedText;
  freshness: ObservationFreshness;
  // `Check.url` is deliberately NOT projected: estate check URLs carry query
  // credentials (see eagle-eye schema/ssot http_checks).
}

export interface IncidentEvidence {
  incident_id: string;
  env: string;
  status: IncidentEvidenceStatus;
  /**
   * What kind of evidence this is, always the same value: a re-read of
   * eagle-eye's own collector snapshot. It is NOT an independent re-probe of
   * the host/service, so it can never confirm a root cause — only what the
   * collector observed, and how old that observation is.
   */
  provenance: 'eagle_eye_collector_snapshot';
  /** Fixed framing for this status; carried in the payload so a consumer cannot re-frame it. */
  caveat: string;
  /** When THIS collection ran — an artifact of the fetch, not an observation. */
  collected_at: string;
  triage: {
    ref: string;
    /** `TriageReport.generated_at` as reported by the server. */
    generated_at: string | null;
    freshness: ObservationFreshness;
    issue: EvidenceIssue | null;
  } | null;
  snapshot: {
    ref: string;
    generated_at: string | null;
    host: EvidenceHost | null;
    external: EvidenceExternal | null;
    check: EvidenceCheck | null;
  } | null;
  errors: EvidenceError[];
}

/**
 * The one sentence each status is allowed to mean. Kept next to the status
 * union so a new status cannot ship without deciding what it does NOT prove.
 */
const STATUS_CAVEAT: Record<IncidentEvidenceStatus, string> = {
  reported:
    'Eagle-eye still reports this issue for this env. This is the collector snapshot re-read, not an independent probe: it confirms the report, not the root cause.',
  env_mismatch:
    'This incident id exists in triage but is attributed to other envs. No claim is made about the requested env.',
  not_currently_reported:
    'No current signal: this incident id is absent from the live triage report. This collector holds no history, so absence cannot prove recovery, a fix, or success.',
  evidence_unavailable:
    'No evidence could be read (see errors). Nothing is implied about the incident state either way.',
};

/** Operator/programming error: bad config or a malformed request identity. */
export class IncidentEvidenceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IncidentEvidenceConfigError';
  }
}

// ------------------------------------------------------------- base url

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * Accept only an operator origin we are willing to send a request to:
 * https anywhere, http on loopback only (dev/test), nothing else. Credentials,
 * query, fragment and a path beyond `/` are rejected outright — this value is
 * a trust anchor, and anything hiding in it would ride every request.
 *
 * Pure: it takes the string and returns the origin (or throws). Reading the
 * operator environment is the config layer's job (rules/config.md), so the
 * config loader can call this to fail at wiring time instead of at incident
 * time.
 *
 * No rejection message quotes the value. A misconfigured origin is exactly the
 * one most likely to contain a pasted credential, and config errors land in
 * logs and Slack — the reason for the rejection is the whole diagnostic.
 */
export function resolveIncidentEvidenceOrigin(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new IncidentEvidenceConfigError('baseUrl is not a parseable URL');
  }
  if (parsed.username || parsed.password) {
    throw new IncidentEvidenceConfigError('baseUrl must not carry credentials');
  }
  if (parsed.search) {
    throw new IncidentEvidenceConfigError('baseUrl must not carry a query string');
  }
  if (parsed.hash) {
    throw new IncidentEvidenceConfigError('baseUrl must not carry a fragment');
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new IncidentEvidenceConfigError('baseUrl must be an origin, with no path');
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol === 'https:') return parsed.origin;
  if (parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(host)) return parsed.origin;
  throw new IncidentEvidenceConfigError(
    `baseUrl scheme ${parsed.protocol} is not allowed (https, or http on loopback)`,
  );
}

// ---------------------------------------------------------- sanitization

/**
 * `token=…`, `password: …` and friends. The value stops at a query/attribute
 * delimiter — a greedy `\S+` would eat the rest of an already-redacted URL
 * (`?token=[redacted]&mode=[redacted]` → `?token=[redacted]`) and silently
 * drop evidence that was safe to keep.
 */
const LABELLED_SECRET = /((?:authorization|bearer|token|secret|password|passwd|api[_-]?key)\s*[:=]\s*)[^\s&#"']+/gi;

/** Patterns whose match is itself the secret. */
const SECRET_PATTERNS: RegExp[] = [
  /xox[baprs]-[A-Za-z0-9-]{8,}/g,
  /gh[pousr]_[A-Za-z0-9]{16,}/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

const URL_IN_TEXT = /\bhttps?:\/\/[^\s'"<>)\]]+/gi;

/**
 * Rewrite one URL to its reachable identity: scheme + host + path. Userinfo is
 * dropped, every query value becomes `[redacted]` (keys are kept — a key name
 * is routing information, a value is the payload), fragment is dropped.
 */
function redactUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return '[redacted-url]';
  }
  const keys = [...parsed.searchParams.keys()];
  const query = keys.length ? `?${keys.map((k) => `${k}=[redacted]`).join('&')}` : '';
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}${query}`;
}

/**
 * Last-resort detector for an opaque credential that no pattern above named:
 * a long run of credential-alphabet characters mixing cases and digits. It is
 * a heuristic, so it does not redact in place — it condemns the whole string
 * (see `sanitizeText`), because a partial redaction of something we do not
 * understand is exactly how half a token ships.
 */
function looksLikeOpaqueSecret(token: string): boolean {
  if (token.length < 20) return false;
  if (!/^[A-Za-z0-9+_=-]+$/.test(token)) return false;
  return /[a-z]/.test(token) && /[A-Z]/.test(token) && /[0-9]/.test(token);
}

/**
 * Bound and redact one free-text field from eagle-eye. Order matters: URLs
 * first (their query values are the common secret carrier), then named secret
 * shapes, then the opaque-token veto, then truncation — the veto runs on the
 * FULL string so truncation can never rescue a string by cutting a token in
 * half.
 */
export function sanitizeText(raw: unknown): SanitizedText {
  if (typeof raw !== 'string') {
    return { text: null, redacted: false, truncated: false, omitted: 'absent' };
  }

  let redacted = false;
  let out = raw.replace(URL_IN_TEXT, (url) => {
    const rewritten = redactUrl(url);
    if (rewritten !== url) redacted = true;
    return rewritten;
  });
  out = out.replace(LABELLED_SECRET, (_m, label: string) => {
    redacted = true;
    return `${label}[redacted]`;
  });
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, () => {
      redacted = true;
      return '[redacted]';
    });
  }

  const residual = out.split(/[^A-Za-z0-9+_=-]+/).some(looksLikeOpaqueSecret);
  if (residual) {
    return { text: null, redacted: true, truncated: false, omitted: 'unsafe_to_sanitize' };
  }

  if (out.length > MAX_TEXT_CHARS) {
    return { text: `${out.slice(0, MAX_TEXT_CHARS)}…`, redacted, truncated: true };
  }
  return { text: out, redacted, truncated: false };
}

// ------------------------------------------------------------- json access

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// -------------------------------------------------------------- freshness

function freshness(observedAt: unknown, now: Date, maxAgeSeconds: number): ObservationFreshness {
  const raw = asString(observedAt);
  const parsed = raw ? Date.parse(raw) : Number.NaN;
  if (!raw || Number.isNaN(parsed)) {
    return { state: 'absent', observed_at: null, age_seconds: null };
  }
  const ageSeconds = Math.round((now.getTime() - parsed) / 1000);
  return { state: ageSeconds > maxAgeSeconds ? 'stale' : 'fresh', observed_at: raw, age_seconds: ageSeconds };
}

// ------------------------------------------------------------- transport

interface FetchOutcome {
  body?: JsonRecord;
  error?: EvidenceError;
}

/** Drain a body under the byte cap, cancelling the stream once it trips. */
async function readBounded(response: Response): Promise<string | null> {
  const declared = Number(response.headers?.get?.('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) return null;

  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    const text = await response.text();
    return Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES ? null : text;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

function classifyThrown(
  err: unknown,
  timedOut: boolean,
  callerAborted: boolean,
): { kind: EvidenceErrorKind; message: string } {
  if (timedOut) return { kind: 'timeout', message: 'request timed out' };
  if (callerAborted) return { kind: 'aborted', message: 'request aborted by caller' };
  const cause = asRecord(err)?.cause;
  const causeMessage = asString(asRecord(cause)?.message) ?? (typeof cause === 'string' ? cause : '');
  if (/redirect/i.test(causeMessage)) return { kind: 'redirect', message: 'server answered with a redirect' };
  const message = asString(asRecord(err)?.message) ?? 'request failed';
  return { kind: 'network', message: message.slice(0, 120) };
}

/**
 * One bare read-only GET of a fixed eagle-eye path. Every failure mode becomes
 * an `EvidenceError` — the caller composes partial evidence instead of losing
 * the half that did answer.
 */
async function getJson(
  origin: string,
  path: string,
  timeoutMs: number,
  deps: Required<Pick<IncidentEvidenceDeps, 'fetch'>>,
  callerSignal?: AbortSignal,
): Promise<FetchOutcome> {
  const ref = `eagle:${path}`;
  if (callerSignal?.aborted) {
    return { error: { ref, kind: 'aborted', message: 'request aborted by caller' } };
  }

  // Every abort carries an explicit reason (B-2, src/__tests__/no-untagged-abort
  // .test.ts): a bare `.abort()` lands as DOMException("aborted"), which the
  // turn-end surface collapses to "no reason" and swallows — the turn would
  // vanish with no card instead of surfacing a timed-out evidence fetch.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(TIMEOUT_ABORT_REASON);
  }, timeoutMs);
  // The caller's own reason wins when it has one, so a session teardown keeps
  // its identity all the way down to `fetch`.
  const onCallerAbort = () => controller.abort(callerSignal?.reason ?? CALLER_ABORT_REASON);
  callerSignal?.addEventListener('abort', onCallerAbort);

  try {
    const response = await deps.fetch(`${origin}${path}`, {
      method: 'GET',
      redirect: 'error',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        error: { ref, kind: 'http_status', status: response.status, message: `HTTP ${response.status} from ${path}` },
      };
    }

    const text = await readBounded(response);
    if (text === null) {
      return { error: { ref, kind: 'oversize', message: `response from ${path} exceeded the size cap` } };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { error: { ref, kind: 'malformed_json', message: `response from ${path} is not valid JSON` } };
    }
    const record = asRecord(parsed);
    if (!record) {
      return { error: { ref, kind: 'malformed_json', message: `response from ${path} is not a JSON object` } };
    }
    return { body: record };
  } catch (err) {
    const { kind, message } = classifyThrown(err, timedOut, callerSignal?.aborted === true);
    return { error: { ref, kind, message } };
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }
}

// ------------------------------------------------------------ projection

function projectIssue(issue: JsonRecord): EvidenceIssue {
  const id = asString(issue.id) ?? '';
  return {
    ref: `eagle:${TRIAGE_PATH}#issues[id=${id}]`,
    id,
    cat: asString(issue.cat) ?? '',
    key: asString(issue.key),
    text: sanitizeText(issue.text),
    detail: sanitizeText(issue.detail),
    envs: asArray(issue.envs).filter((e): e is string => typeof e === 'string'),
  };
}

function projectHost(host: JsonRecord, fresh: ObservationFreshness): EvidenceHost {
  return {
    ref: `eagle:${SNAPSHOT_PATH}#hosts[id=${asString(host.id) ?? ''}]`,
    id: asString(host.id) ?? '',
    env: asString(host.env) ?? '',
    reachable: host.reachable === true,
    best_effort: host.best_effort === true,
    error: sanitizeText(host.error),
    freshness: fresh,
  };
}

function projectExternal(service: JsonRecord, fresh: ObservationFreshness): EvidenceExternal {
  return {
    ref: `eagle:${SNAPSHOT_PATH}#external_status.services[id=${asString(service.id) ?? ''}]`,
    id: asString(service.id) ?? '',
    name: asString(service.label) ?? '',
    status: asString(service.status) ?? '',
    source: asString(service.source) ?? '',
    detail: sanitizeText(service.detail),
    probe_ms: asNumber(service.probe_ms),
    checked_at: asString(service.checked_at),
    freshness: fresh,
  };
}

function projectCheck(check: JsonRecord, fresh: ObservationFreshness): EvidenceCheck {
  return {
    ref: `eagle:${SNAPSHOT_PATH}#http_checks[name=${asString(check.name) ?? ''}]`,
    name: asString(check.name) ?? '',
    ok: check.ok === true,
    status: asNumber(check.status),
    latency_ms: asNumber(check.latency_ms),
    checked_at: asString(check.checked_at),
    error: sanitizeText(check.error),
    freshness: fresh,
  };
}

/**
 * Which snapshot record this issue points at. Console keys are the eagle-eye
 * FE/server contract (`host:<id>`, `ext:<id>`; src/triage.rs), and a CHECK row
 * carries no key — its `text` IS the check name, matched exactly.
 *
 * Freshness is ALWAYS the row's own observation stamp — `Host.probed_at`,
 * `Check.checked_at`, `ExternalService.checked_at`. The batch
 * `snapshot.observed_at.*` is the newest observation across a whole source, so
 * a sibling collected this cycle would make a row that failed to probe look
 * current. A row with no stamp of its own is `absent`, never borrowed.
 */
function findSnapshotRecords(
  issue: JsonRecord,
  snapshot: JsonRecord,
  now: Date,
  maxAgeSeconds: number,
): { host: EvidenceHost | null; external: EvidenceExternal | null; check: EvidenceCheck | null } {
  const key = asString(issue.key);
  const result = {
    host: null as EvidenceHost | null,
    external: null as EvidenceExternal | null,
    check: null as EvidenceCheck | null,
  };

  if (key?.startsWith('host:')) {
    const hostId = key.slice('host:'.length);
    // Selected by the key the detector emitted, NOT re-filtered by env: host
    // ids and display envs are different vocabularies upstream
    // (eagle-eye src/triage.rs `env_of_host_parts`), so an env compare here
    // would silently drop givenchy hosts. `env` ships verbatim instead.
    const host = asArray(snapshot.hosts)
      .map(asRecord)
      .find((h): h is JsonRecord => h !== null && asString(h.id) === hostId);
    if (host) result.host = projectHost(host, freshness(host.probed_at, now, maxAgeSeconds));
    return result;
  }

  if (key?.startsWith('ext:')) {
    const serviceId = key.slice('ext:'.length);
    const service = asArray(asRecord(snapshot.external_status)?.services)
      .map(asRecord)
      .find((s): s is JsonRecord => s !== null && asString(s.id) === serviceId);
    if (service) {
      result.external = projectExternal(service, freshness(service.checked_at, now, maxAgeSeconds));
    }
    return result;
  }

  if (asString(issue.cat) === 'CHECK') {
    const name = asString(issue.text);
    const check = asArray(snapshot.http_checks)
      .map(asRecord)
      .find((c): c is JsonRecord => c !== null && name !== null && asString(c.name) === name);
    if (check) result.check = projectCheck(check, freshness(check.checked_at, now, maxAgeSeconds));
  }
  return result;
}

// ----------------------------------------------------------------- entry

/**
 * Collect bounded, sanitized evidence for one incident id in one env.
 *
 * Resolves (never throws) for every transport/data failure — those land in
 * `errors` with an explicit kind. It throws `IncidentEvidenceConfigError` only
 * for an unusable config or request identity, which is an operator bug, not an
 * observation.
 *
 * The snapshot is fetched ONLY after triage confirms the exact id and env:
 * an unmatched incident must not pull the estate-wide payload.
 */
export async function collectIncidentEvidence(
  config: IncidentEvidenceConfig,
  request: IncidentEvidenceRequest,
  deps: IncidentEvidenceDeps = {},
): Promise<IncidentEvidence> {
  const origin = resolveIncidentEvidenceOrigin(config.baseUrl);
  if (!request.incident_id) throw new IncidentEvidenceConfigError('incident_id is required');
  if (!request.env) throw new IncidentEvidenceConfigError('env is required');

  const doFetch = deps.fetch ?? globalThis.fetch;
  const now = (deps.now ?? (() => new Date()))();
  const maxAgeSeconds = config.maxObservationAgeSeconds ?? DEFAULT_MAX_OBSERVATION_AGE_SECONDS;
  const timeoutMs = Math.min(Math.max(1, config.timeoutMs ?? DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS);

  const evidence: IncidentEvidence = {
    incident_id: request.incident_id,
    env: request.env,
    status: 'evidence_unavailable',
    provenance: 'eagle_eye_collector_snapshot',
    caveat: STATUS_CAVEAT.evidence_unavailable,
    collected_at: now.toISOString(),
    triage: null,
    snapshot: null,
    errors: [],
  };
  /** Status and its caveat move together — neither is settable alone. */
  const withStatus = (status: IncidentEvidenceStatus): IncidentEvidence => {
    evidence.status = status;
    evidence.caveat = STATUS_CAVEAT[status];
    return evidence;
  };

  const triageResult = await getJson(origin, TRIAGE_PATH, timeoutMs, { fetch: doFetch }, request.signal);
  if (triageResult.error || !triageResult.body) {
    if (triageResult.error) evidence.errors.push(triageResult.error);
    return withStatus('evidence_unavailable');
  }

  const report = triageResult.body;
  const generatedAt = asString(report.generated_at);
  const issue = asArray(report.issues)
    .map(asRecord)
    .find((i): i is JsonRecord => i !== null && asString(i.id) === request.incident_id);

  evidence.triage = {
    ref: `eagle:${TRIAGE_PATH}`,
    generated_at: generatedAt,
    freshness: freshness(generatedAt, now, maxAgeSeconds),
    issue: issue ? projectIssue(issue) : null,
  };

  if (!issue) {
    // Absent from the current report. This collector holds no history: it can
    // claim neither recovery nor success, only that nothing is reported now.
    return withStatus('not_currently_reported');
  }

  const envs = asArray(issue.envs).filter((e): e is string => typeof e === 'string');
  if (!envs.includes(request.env)) {
    return withStatus('env_mismatch');
  }
  withStatus('reported');

  const snapshotResult = await getJson(origin, SNAPSHOT_PATH, timeoutMs, { fetch: doFetch }, request.signal);
  if (snapshotResult.error || !snapshotResult.body) {
    if (snapshotResult.error) evidence.errors.push(snapshotResult.error);
    return evidence;
  }

  const snapshot = snapshotResult.body;
  const records = findSnapshotRecords(issue, snapshot, now, maxAgeSeconds);
  evidence.snapshot = {
    ref: `eagle:${SNAPSHOT_PATH}`,
    generated_at: asString(snapshot.generated_at),
    ...records,
  };
  return evidence;
}
