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
  PerTaskDispatchPayload,
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

/**
 * Required `##` heading set per sentinel type (grammar rule 4).
 *
 * `Dependency Groups` and `Per-Task Dispatch Payloads` are required for
 * `plan-to-work` because the new session is a fresh controller and must not
 * read `PLAN.md` from the working folder (z/SKILL.md §Hard Rules forbids the
 * orchestrator from reading repo source). The handoff payload is the only
 * carrier for the planner's structured output.
 */
const REQUIRED_FIELDS: Record<HandoffKind, readonly string[]> = {
  'plan-to-work': [
    'Issue',
    'Parent Epic',
    'Task List',
    'Dependency Groups',
    'Per-Task Dispatch Payloads',
  ],
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
 * Strict opening-tag regex. Single space between `<z-handoff` and `type=`,
 * exactly double-quoted attribute, no trailing whitespace, no other attributes.
 * Matches `using-z` SKILL.md §Sentinel Grammar rule 1: "case-sensitive,
 * double-quoted attribute. 변형(대소문자·홑따옴표·공백 변형) 불매칭."
 */
const STRICT_OPEN_RE = /^<z-handoff type="([^"]+)">$/;

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
  const openMatch = STRICT_OPEN_RE.exec(lines[openIdx]);
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

  // Strict opening: <z-handoff type="..."> — single space, double quotes,
  // no extra attrs, no trailing whitespace. See STRICT_OPEN_RE for the contract.
  const strictOpen = STRICT_OPEN_RE.exec(openLine);
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

  const context = deriveContext(handoffKind, fields);

  if (handoffKind === 'plan-to-work') {
    const validation = validatePlanToWorkContext(context);
    if (!validation.ok) {
      return { ok: false, reason: 'invalid-plan-payload', detail: validation.detail };
    }
  }

  return { ok: true, context };
}

/**
 * Cross-validate a parsed plan-to-work `HandoffContext`. Required headings
 * are already present at this point — this checks structural / semantic
 * coherence between `dependencyGroups` and `perTaskDispatchPayloads`.
 *
 * Returns a discriminated result so the caller can attach a precise `detail`
 * to the `invalid-plan-payload` failure.
 */
function validatePlanToWorkContext(
  ctx: HandoffContext,
): { ok: true } | { ok: false; detail: string } {
  if (ctx.dependencyGroups.length === 0) {
    return { ok: false, detail: 'empty-dependency-groups' };
  }
  if (ctx.perTaskDispatchPayloads.length === 0) {
    return { ok: false, detail: 'empty-per-task-payloads' };
  }
  const payloadIds = new Set(ctx.perTaskDispatchPayloads.map((p) => p.taskId));
  const groupIds = new Set<string>();
  for (const group of ctx.dependencyGroups) {
    for (const id of group) groupIds.add(id);
  }
  for (const id of groupIds) {
    if (!payloadIds.has(id)) {
      return { ok: false, detail: `group-task-without-payload:${id}` };
    }
  }
  for (const id of payloadIds) {
    if (!groupIds.has(id)) {
      return { ok: false, detail: `payload-task-without-group:${id}` };
    }
  }
  return { ok: true };
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
 * `{ heading → value }` map.
 *
 * **Fence-aware**: lines inside ```` ``` ```` fenced code blocks are NOT
 * scanned for `## Heading` markers. The planner-authored
 * `## Per-Task Dispatch Payloads` value embeds full self-contained subagent
 * prompts, which themselves contain `## ...` markdown headings (e.g.
 * `## Work environment`, `## Sub-issue`). Without fence-awareness those inner
 * headings would be misparsed as top-level handoff fields and clobber the
 * payload value. The required convention is: each `### task-id` body inside
 * the Per-Task Dispatch Payloads section is wrapped in a fenced block
 * (` ``` … ``` `) so the parser preserves it verbatim.
 *
 * Multi-line values accepted — a value continues until the next top-level
 * `## Heading` line or end of body. Leading/trailing blank lines in values
 * are trimmed.
 */
function parseFields(body: readonly string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  let currentHeading: string | null = null;
  let currentBuf: string[] = [];
  let fenceMarker: string | null = null;

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
    // Track fenced code blocks. We only need backtick fences (matches
    // `using-z` payload spec); tilde fences are not part of the contract.
    // Match opening fence `` ``` `` or `` ```lang `` (any number of backticks
    // ≥ 3). Closing fence must use the same backtick count.
    const fenceMatch = /^(`{3,})/.exec(line);
    if (fenceMatch) {
      const ticks = fenceMatch[1];
      if (fenceMarker === null) {
        fenceMarker = ticks;
      } else if (ticks === fenceMarker) {
        fenceMarker = null;
      }
      // Either way the fence line itself is captured into the current value.
      if (currentHeading !== null) currentBuf.push(line);
      continue;
    }

    if (fenceMarker === null) {
      const headingMatch = /^## (.+?)\s*$/.exec(line);
      if (headingMatch) {
        flush();
        currentHeading = headingMatch[1];
        currentBuf = [];
        continue;
      }
    }

    if (currentHeading !== null) {
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

  // Plan-to-work-only structured fields. work-complete leaves these empty.
  const dependencyGroups =
    kind === 'plan-to-work' ? parseDependencyGroups(fields['Dependency Groups'] ?? '') : [];
  const perTaskDispatchPayloads =
    kind === 'plan-to-work'
      ? parsePerTaskDispatchPayloads(fields['Per-Task Dispatch Payloads'] ?? '')
      : [];

  return {
    handoffKind: kind,
    sourceIssueUrl,
    parentEpicUrl,
    escapeEligible,
    tier,
    issueRequiredByUser,
    dependencyGroups,
    perTaskDispatchPayloads,
    // UUID is a log-correlation id only; hopBudget seed is #697's starting point.
    chainId: randomUUID(),
    hopBudget: 1,
  };
}

/**
 * Parse a `## Dependency Groups` block into ordered groups of taskIds.
 *
 * Expected line shape (one per group, in declared order):
 *
 *     Group 1: [task-id-A, task-id-B]
 *     Group 2: [task-id-C]
 *
 * Permissive: leading whitespace, optional `Group N:` prefix, comma- or
 * whitespace-separated taskIds inside the brackets. Empty / unparseable input
 * returns `[]` (the schema check upstream already enforced presence; here
 * we just extract structure).
 */
function parseDependencyGroups(value: string): ReadonlyArray<ReadonlyArray<string>> {
  const groups: string[][] = [];
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    const bracketMatch = /\[([^\]]*)\]/.exec(line);
    if (!bracketMatch) continue;
    const inside = bracketMatch[1];
    const ids = inside
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (ids.length > 0) groups.push(ids);
  }
  return groups;
}

/**
 * Parse a `## Per-Task Dispatch Payloads` block into per-taskId prompts.
 *
 * Required shape — each task starts with `### <taskId>` followed by a
 * fenced code block containing the self-contained subagent prompt:
 *
 *     ### task-id-A
 *     ```
 *     <self-contained subagent prompt — multi-line, may contain ##
 *      headings, code blocks of its own, etc>
 *     ```
 *     ### task-id-B
 *     ```
 *     <…>
 *     ```
 *
 * The fence is mandatory because the payload body legitimately contains
 * `##` and `###` markdown headings; without the fence those would collide
 * with the outer parser. Tasks lacking a fence are skipped (the structural
 * validator in `validatePlanToWorkContext` will then surface the resulting
 * group↔payload mismatch as `invalid-plan-payload`).
 *
 * Empty input or an input with no fenced bodies returns `[]`.
 */
function parsePerTaskDispatchPayloads(value: string): ReadonlyArray<PerTaskDispatchPayload> {
  const payloads: PerTaskDispatchPayload[] = [];
  const lines = value.split(/\r?\n/);
  let i = 0;

  while (i < lines.length) {
    const headingMatch = /^### (.+?)\s*:?\s*$/.exec(lines[i]);
    if (!headingMatch) {
      i++;
      continue;
    }
    const taskId = headingMatch[1].trim();
    i++;

    // Skip blank lines until the opening fence.
    while (i < lines.length && lines[i].trim() === '') i++;
    if (i >= lines.length) break;

    const openMatch = /^(`{3,})/.exec(lines[i]);
    if (!openMatch) {
      // No fence → skip this task entry. Cross-validation will catch the
      // resulting group↔payload mismatch as `invalid-plan-payload`.
      continue;
    }
    const ticks = openMatch[1];
    i++;

    const buf: string[] = [];
    while (i < lines.length) {
      const closeMatch = /^(`{3,})\s*$/.exec(lines[i]);
      if (closeMatch && closeMatch[1] === ticks) {
        i++;
        break;
      }
      buf.push(lines[i]);
      i++;
    }
    payloads.push({ taskId, prompt: buf.join('\n') });
  }

  return payloads;
}
