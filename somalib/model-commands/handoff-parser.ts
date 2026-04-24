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

import type {
  HandoffContext,
  HandoffKind,
  HandoffParseFailure,
  HandoffTier,
  ParseResult,
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
 * Workflow → expected sentinel kind mapping.
 *
 * `forceWorkflow='z-plan-to-work'` MUST arrive with `<z-handoff type="plan-to-work">`;
 * `forceWorkflow='z-epic-update'` MUST arrive with `<z-handoff type="work-complete">`.
 * Mismatch is a `type-workflow-mismatch` failure.
 */
export function expectedHandoffKind(
  forceWorkflow: 'z-plan-to-work' | 'z-epic-update',
): HandoffKind {
  return forceWorkflow === 'z-plan-to-work' ? 'plan-to-work' : 'work-complete';
}

/**
 * Lightweight existence + type-extraction check for the validator layer.
 *
 * Scans for a well-formed `<z-handoff type="...">` opening tag at the top
 * level of the prompt (optionally preceded by a `$z ...` command line, per
 * SKILL.md payload format). Returns the captured type if valid, otherwise
 * `null`. Does NOT validate closing tag, required fields, or duplicates —
 * those are `parseHandoff`'s job.
 */
export function extractSentinelType(promptText: string): HandoffKind | null {
  const lines = promptText.split(/\r?\n/);
  let idx = 0;

  // Skip leading blank lines.
  while (idx < lines.length && lines[idx].trim() === '') idx++;
  if (idx >= lines.length) return null;

  // Optionally skip a leading "$z ..." command line (per SKILL.md payload format).
  if (/^\$z\b/.test(lines[idx])) {
    idx++;
    while (idx < lines.length && lines[idx].trim() === '') idx++;
    if (idx >= lines.length) return null;
  }

  const openMatch = /^<z-handoff\s+type="([^"]+)">\s*$/.exec(lines[idx]);
  if (!openMatch) return null;

  const captured = openMatch[1];
  if (!VALID_KINDS.has(captured as HandoffKind)) return null;
  return captured as HandoffKind;
}

/**
 * Lightweight "does this prompt look like it has a handoff sentinel?" check.
 * True iff `extractSentinelType` returns a valid kind.
 */
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
  // 1. Bulk existence check — distinguishes "no sentinel" from "has sentinel but malformed".
  if (!/<z-handoff\b/.test(promptText)) {
    return { ok: false, reason: 'no-sentinel', detail: '' };
  }

  const lines = promptText.split(/\r?\n/);
  let idx = 0;

  // 2. Skip leading blank lines and optional "$z ..." command line.
  while (idx < lines.length && lines[idx].trim() === '') idx++;
  if (idx >= lines.length) {
    return { ok: false, reason: 'no-sentinel', detail: '' };
  }
  if (/^\$z\b/.test(lines[idx])) {
    idx++;
    while (idx < lines.length && lines[idx].trim() === '') idx++;
  }
  if (idx >= lines.length) {
    return { ok: false, reason: 'sentinel-not-top-level', detail: '' };
  }

  // 3. The first real content line must be the opening sentinel.
  const openLine = lines[idx];
  const looseOpen = /^<z-handoff\b/.test(openLine);
  if (!looseOpen) {
    return {
      ok: false,
      reason: 'sentinel-not-top-level',
      detail: 'first content line is not <z-handoff>',
    };
  }

  // Strict opening: <z-handoff type="..."> with double quotes, no extra attrs.
  const strictOpen = /^<z-handoff\s+type="([^"]+)">\s*$/.exec(openLine);
  if (!strictOpen) {
    return {
      ok: false,
      reason: 'malformed-opening',
      detail: openLine.trim(),
    };
  }

  const capturedType = strictOpen[1];
  if (!VALID_KINDS.has(capturedType as HandoffKind)) {
    return { ok: false, reason: 'unknown-type', detail: capturedType };
  }
  const handoffKind = capturedType as HandoffKind;

  // 4. Scan forward for the closing tag.
  const openLineIdx = idx;
  let closeIdx = -1;
  for (let j = openLineIdx + 1; j < lines.length; j++) {
    if (/^<\/z-handoff>\s*$/.test(lines[j])) {
      closeIdx = j;
      break;
    }
  }
  if (closeIdx < 0) {
    return { ok: false, reason: 'missing-closing', detail: '' };
  }

  // 5. Scan past the close for another opening tag (duplicate detection).
  for (let j = closeIdx + 1; j < lines.length; j++) {
    if (/^<z-handoff\b/.test(lines[j])) {
      return { ok: false, reason: 'duplicate-sentinel', detail: '' };
    }
  }

  // 6. Parse inner body into "## Heading" → value (multi-line) map.
  const body = lines.slice(openLineIdx + 1, closeIdx);
  const fields = parseFields(body);

  // 7. Validate required fields per type.
  for (const required of REQUIRED_FIELDS[handoffKind]) {
    if (!(required in fields)) {
      return { ok: false, reason: 'missing-required-field', detail: required };
    }
  }

  // 8. Derive HandoffContext per AD-3.
  const context = deriveContext(handoffKind, fields);
  return { ok: true, context };
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
  readonly forceWorkflow: 'z-plan-to-work' | 'z-epic-update';

  constructor(
    reason: HandoffParseFailure | 'host-policy',
    detail: string,
    forceWorkflow: 'z-plan-to-work' | 'z-epic-update',
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
    chainId: mintChainId(),
    hopBudget: 1,
  };
}

function mintChainId(): string {
  // `crypto.randomUUID()` is available on Node >= 19 and all modern browsers.
  // Fallback to a hex pseudo-UUID in the extremely unlikely case it's missing.
  try {
    // @ts-ignore — runtime environments may lack typings.
    const g: any = globalThis;
    if (g?.crypto?.randomUUID) return g.crypto.randomUUID();
  } catch {
    // fall through
  }
  // Fallback: timestamp + random hex. Not cryptographically strong, only
  // used as a log-correlation id when crypto.randomUUID is unavailable.
  const hex = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  return `handoff-${Date.now().toString(16)}-${hex}`;
}
