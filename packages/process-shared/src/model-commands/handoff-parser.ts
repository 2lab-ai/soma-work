/**
 * Host-level parser for `<z-handoff>` session-handoff sentinels (issue #695).
 *
 * Contract: see `src/local/skills/using-z/SKILL.md` §Session Handoff Protocol.
 * Grammar rules enforced: rule 1 (exact opening form), 2 (top-level wrapper),
 * 3 (closing required), 4 (required fields per type), 5 (no duplicates).
 *
 * Used by:
 * - `somalib/model-commands/validator.ts` `parseContinueSessionParams` —
 *   lightweight `extractSentinelType` check for CONTINUE_SESSION payloads.
 * - `src/slack/pipeline/session-initializer.ts` `runDispatch` — full
 *   `parseHandoff` + mapping check before deterministic workflow entry.
 */

import { randomUUID } from 'node:crypto';
import type {
  HandoffContext,
  HandoffKind,
  HandoffParseFailure,
  HandoffTier,
  ParseResult,
  WorkflowType,
  ZHandoffWorkflow,
} from './session-types';

const VALID_TIERS: ReadonlySet<HandoffTier> = new Set([
  'tiny',
  'small',
  'medium',
  'large',
  'xlarge',
]);

const VALID_KINDS: ReadonlySet<HandoffKind> = new Set(['plan-to-work', 'work-complete']);

/** Required `##` heading set per sentinel type (grammar rule 4). */
const REQUIRED_FIELDS: Record<HandoffKind, readonly string[]> = {
  'plan-to-work': ['Issue', 'Parent Epic', 'Task List'],
  'work-complete': ['Completed Subissue', 'PR', 'Summary', 'Remaining Epic Checklist'],
};

/**
 * Type guard for `ZHandoffWorkflow`. Defined here (runtime module) so src/
 * callers can destructure it alongside `parseHandoff` and `extractSentinelType`.
 */
export function isZHandoffWorkflow(w: WorkflowType | undefined): w is ZHandoffWorkflow {
  return w === 'z-plan-to-work' || w === 'z-epic-update';
}

/**
 * Workflow → expected sentinel kind mapping.
 *
 * `forceWorkflow='z-plan-to-work'` MUST arrive with `<z-handoff type="plan-to-work">`;
 * `forceWorkflow='z-epic-update'` MUST arrive with `<z-handoff type="work-complete">`.
 * Mismatch is a `type-workflow-mismatch` failure.
 */
export function expectedHandoffKind(forceWorkflow: ZHandoffWorkflow): HandoffKind {
  return forceWorkflow === 'z-plan-to-work' ? 'plan-to-work' : 'work-complete';
}

/**
 * Locate the sentinel opening line at the top level of `lines`. Top-level =
 * the first non-empty line, optionally preceded by a `$z ...` command line
 * (per SKILL.md Handoff #1/#2 payload shape). Returns the line index or `-1`
 * when no top-level opening is present.
 *
 * Shared by `parseHandoff` and `extractSentinelType` so the "where does a
 * sentinel live" rule cannot drift between the validator and the runtime
 * parser.
 */
function findSentinelOpeningLine(lines: readonly string[]): number {
  let idx = 0;
  while (idx < lines.length && lines[idx].trim() === '') idx++;
  if (idx >= lines.length) return -1;
  if (/^\$z\b/.test(lines[idx])) {
    idx++;
    while (idx < lines.length && lines[idx].trim() === '') idx++;
  }
  if (idx >= lines.length) return -1;
  return idx;
}

/**
 * Lightweight existence + type-extraction check for the validator layer.
 *
 * Returns the captured type if the prompt has a well-formed top-level
 * `<z-handoff type="..."/>` opening with a known type; otherwise null. Does
 * NOT validate closing tag, required fields, or duplicates — those are
 * `parseHandoff`'s job.
 */
export function extractSentinelType(promptText: string): HandoffKind | null {
  const lines = promptText.split(/\r?\n/);
  const openIdx = findSentinelOpeningLine(lines);
  if (openIdx < 0) return null;
  const openMatch = /^<z-handoff\s+type="([^"]+)">\s*$/.exec(lines[openIdx]);
  if (!openMatch) return null;
  const captured = openMatch[1];
  return VALID_KINDS.has(captured as HandoffKind) ? (captured as HandoffKind) : null;
}

/** True iff the prompt carries a well-formed top-level handoff sentinel. */
export function hasHandoffSentinel(promptText: string): boolean {
  return extractSentinelType(promptText) !== null;
}

/**
 * Full parse of a `<z-handoff>` sentinel into a typed `HandoffContext`.
 *
 * Failure precedence (returned in this order when multiple conditions apply):
 *   no-sentinel → sentinel-not-top-level → malformed-opening → unknown-type →
 *   missing-closing → duplicate-sentinel → missing-required-field
 *
 * On success, fills host-managed fields (`chainId` UUID, `hopBudget` = 1).
 */
export function parseHandoff(promptText: string): ParseResult {
  // Distinguishes "no sentinel anywhere" from "has sentinel but malformed" —
  // consumers branch on `reason` to decide whether to fall through to phase0
  // vs emit a safe-stop.
  if (!/<z-handoff\b/.test(promptText)) {
    return { ok: false, reason: 'no-sentinel', detail: '' };
  }

  const lines = promptText.split(/\r?\n/);
  const openLineIdx = findSentinelOpeningLine(lines);
  if (openLineIdx < 0) {
    return { ok: false, reason: 'sentinel-not-top-level', detail: '' };
  }

  const openLine = lines[openLineIdx];
  if (!/^<z-handoff\b/.test(openLine)) {
    return {
      ok: false,
      reason: 'sentinel-not-top-level',
      detail: 'first content line is not <z-handoff>',
    };
  }

  // Strict opening: <z-handoff type="..."> with double quotes, no extra attrs.
  const strictOpen = /^<z-handoff\s+type="([^"]+)">\s*$/.exec(openLine);
  if (!strictOpen) {
    return { ok: false, reason: 'malformed-opening', detail: openLine.trim() };
  }

  const capturedType = strictOpen[1];
  if (!VALID_KINDS.has(capturedType as HandoffKind)) {
    return { ok: false, reason: 'unknown-type', detail: capturedType };
  }
  const handoffKind = capturedType as HandoffKind;

  // Scan every line after the opening tag until EOF. The FIRST `</z-handoff>`
  // closes the block; any `<z-handoff>` opening seen before that close is a
  // nested/duplicated opening that must hard-fail (SKILL.md §Sentinel Grammar
  // rule 5). After the first close, any further `<z-handoff>` is also a
  // duplicate. Splitting the two scans would let an inner opening inside the
  // body parse as ordinary content, so the rule is enforced in one pass.
  let closeIdx = -1;
  for (let j = openLineIdx + 1; j < lines.length; j++) {
    const line = lines[j];
    if (closeIdx < 0 && /^<z-handoff\b/.test(line)) {
      return { ok: false, reason: 'duplicate-sentinel', detail: '' };
    }
    if (closeIdx < 0 && /^<\/z-handoff>\s*$/.test(line)) {
      closeIdx = j;
      continue;
    }
    if (closeIdx >= 0 && /^<z-handoff\b/.test(line)) {
      return { ok: false, reason: 'duplicate-sentinel', detail: '' };
    }
  }
  if (closeIdx < 0) {
    return { ok: false, reason: 'missing-closing', detail: '' };
  }

  const body = lines.slice(openLineIdx + 1, closeIdx);
  const fields = parseFields(body);

  for (const required of REQUIRED_FIELDS[handoffKind]) {
    if (!(required in fields)) {
      return { ok: false, reason: 'missing-required-field', detail: required };
    }
  }

  return { ok: true, context: deriveContext(handoffKind, fields) };
}

/**
 * Error thrown by `SessionInitializer.runDispatch` when a forced handoff
 * entrypoint cannot be entered safely. Caught by `SlackHandler` which posts
 * a user-facing safe-stop message and marks the session terminated,
 * bypassing the recoverable-error retry path.
 */
export class HandoffAbortError extends Error {
  readonly reason: HandoffParseFailure | 'host-policy';
  readonly detail: string;
  readonly forceWorkflow: ZHandoffWorkflow;

  constructor(
    reason: HandoffParseFailure | 'host-policy',
    detail: string,
    forceWorkflow: ZHandoffWorkflow,
  ) {
    super(`HandoffAbort(${forceWorkflow}): ${reason} — ${detail}`);
    this.name = 'HandoffAbortError';
    this.reason = reason;
    this.detail = detail;
    this.forceWorkflow = forceWorkflow;
  }
}

// ---------------------------------------------------------------
// Internals
// ---------------------------------------------------------------

/**
 * Group a body (array of lines between opening and closing tags) into a
 * `{ heading → value }` map. Multi-line values accepted — a value continues
 * until the next `## Heading` line or end of body. Leading/trailing blank
 * lines in values are trimmed.
 */
function parseFields(body: readonly string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  let currentHeading: string | null = null;
  let currentBuf: string[] = [];

  const flush = () => {
    if (currentHeading !== null) {
      // Trim leading/trailing blank lines but preserve interior structure.
      while (currentBuf.length > 0 && currentBuf[0].trim() === '') currentBuf.shift();
      while (currentBuf.length > 0 && currentBuf[currentBuf.length - 1].trim() === '') {
        currentBuf.pop();
      }
      fields[currentHeading] = currentBuf.join('\n');
    }
  };

  for (const line of body) {
    const headingMatch = /^## (.+?)\s*$/.exec(line);
    if (headingMatch) {
      flush();
      currentHeading = headingMatch[1];
      currentBuf = [];
    } else if (currentHeading !== null) {
      currentBuf.push(line);
    }
  }
  flush();
  return fields;
}

/**
 * Extract the first URL-like token from a value. Used for
 * `sourceIssueUrl` / `parentEpicUrl`. If the value starts with "none"
 * (optionally followed by parenthesized annotation), returns `null`.
 */
function extractUrlOrNull(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '' || /^none\b/i.test(trimmed)) return null;
  const urlMatch = /https?:\/\/\S+/.exec(trimmed);
  return urlMatch ? urlMatch[0] : trimmed.split(/\s+/)[0] || null;
}

/** Parse "true"/"false" (case-insensitive). Returns undefined on miss. */
function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const lowered = value.trim().toLowerCase();
  if (lowered === 'true') return true;
  if (lowered === 'false') return false;
  return undefined;
}

function deriveContext(
  kind: HandoffKind,
  fields: Record<string, string>,
): HandoffContext {
  // Kind-specific source URL resolution.
  let sourceIssueUrl: string | null;
  let parentEpicUrl: string | null;
  if (kind === 'plan-to-work') {
    sourceIssueUrl = extractUrlOrNull(fields['Issue'] ?? '');
    parentEpicUrl = extractUrlOrNull(fields['Parent Epic'] ?? '');
  } else {
    sourceIssueUrl = extractUrlOrNull(fields['Completed Subissue'] ?? '');
    parentEpicUrl = null;
  }

  // Typed metadata (producer-authoritative, optional with conservative defaults).
  const tierRaw = fields['Tier']?.trim();
  const tier: HandoffTier | null =
    tierRaw !== undefined && VALID_TIERS.has(tierRaw as HandoffTier)
      ? (tierRaw as HandoffTier)
      : null;

  const escapeEligibleParsed = parseBool(fields['Escape Eligible']);
  const escapeEligible = escapeEligibleParsed === true;

  const issueRequiredParsed = parseBool(fields['Issue Required By User']);
  // Default is true (conservative — require issue unless producer explicitly says otherwise).
  const issueRequiredByUser = issueRequiredParsed !== false;

  return {
    handoffKind: kind,
    sourceIssueUrl,
    parentEpicUrl,
    escapeEligible,
    tier,
    issueRequiredByUser,
    // UUID is a log-correlation id only; hopBudget seed is #697's starting point.
    chainId: randomUUID(),
    hopBudget: 1,
  };
}
