/**
 * Eagle-eye incident receiver — the SDK `Options` one unattended attempt runs under.
 *
 * An ordinary Slack session is an interactive assistant: it loads project
 * settings, plugins, skills, the persona prompt, every MCP server, and can
 * escalate to a human through the Slack permission UI. An incident attempt is
 * the opposite animal — a machine asked a machine a question in a thread nobody
 * is watching, on a host that is already unhappy. So this builder does not
 * *narrow* the ordinary options; it constructs a separate, minimal object and
 * the ordinary assembly never runs (see `build-stream-options.ts`).
 *
 * What the attempt gets, and why that is the whole list:
 *
 * - **One tool.** `mcp__incident_evidence__collect`, from one in-process SDK MCP
 *   server, taking **no arguments**. Incident id, env and the eagle-eye origin
 *   are captured in the closure at build time, so nothing the model emits can
 *   re-aim the read at another incident, env or host. `tools: []` removes every
 *   built-in tool; `plugins: []` and `settingSources: []` remove skills, channel
 *   commands and project settings.
 * - **Deny by default, twice.** The catch-all `PreToolUse` hook and the
 *   `canUseTool` backstop both call the *existing* `evaluateToolPolicy` with an
 *   `incidentReadOnly` context — no second, more permissive policy is defined
 *   here. `ask` is impossible by construction: an unattended attempt cannot wait
 *   on a Slack approval that nobody will click, so anything not allow-listed is
 *   a deny.
 * - **Fresh, bounded, disposable.** No `resume`/`continue` (each attempt starts
 *   clean), `persistSession: false`, and a `maxTurns` budget. The wall-clock
 *   ceiling is published here (`INCIDENT_MAX_WALL_CLOCK_MS`) but armed by the
 *   stream owner, which is the only party that knows when the attempt ended.
 * - **Fail closed.** No evidence config, an unusable origin, or a request with no
 *   identity throws `IncidentOptionsError`. There is deliberately no fallback to
 *   an ordinary session: silently downgrading an incident attempt into a normal
 *   agent is exactly the failure this whole module exists to prevent.
 *
 * Out of scope (later units): submitting the result back to Slack — this adapter
 * has no write tool at all, and the tool performs no Slack call.
 */

import {
  type CanUseTool,
  createSdkMcpServer,
  type HookCallback,
  type HookJSONOutput,
  type Options,
  type PermissionResult,
  tool,
} from '@anthropic-ai/claude-agent-sdk';
import {
  evaluateToolPolicy,
  INCIDENT_TOOL_POLICY_MATCHERS,
  type ToolPolicyContext,
  type ToolPolicyResult,
} from '../agent-runtime/policy/tool-policy';
import {
  collectIncidentEvidence,
  type IncidentEvidence,
  type IncidentEvidenceConfig,
  type IncidentEvidenceRequest,
  resolveIncidentEvidenceOrigin,
} from './evidence';

/** MCP server key AND `createSdkMcpServer` name — together they form the tool id. */
export const INCIDENT_EVIDENCE_SERVER_NAME = 'incident_evidence';
export const INCIDENT_EVIDENCE_TOOL_NAME = 'collect';
/** The one tool an incident attempt may call. */
export const INCIDENT_EVIDENCE_TOOL = `mcp__${INCIDENT_EVIDENCE_SERVER_NAME}__${INCIDENT_EVIDENCE_TOOL_NAME}`;

/**
 * Turn budget. One collection plus its reading, plus room for a second look,
 * plus the final write-up — an attempt that needs more than that is not going to
 * find the answer with more turns, it is going to loop.
 */
export const INCIDENT_MAX_TURNS = 4;

/**
 * Wall-clock ceiling for one attempt. `maxTurns` bounds *conversation*, not
 * time: a turn stuck on a hung read would otherwise hold the CCT lease
 * indefinitely.
 *
 * The value lives here; **arming it does not**. A timer started by this builder
 * would have no owner to clear it on a normal finish, and would then abort a
 * controller the caller may have moved on to. The stream owner
 * (`ClaudeHandler.streamQuery`) arms it against the same `abortController` and
 * clears it in the `finally` that already releases the lease.
 */
export const INCIDENT_MAX_WALL_CLOCK_MS = 10 * 60 * 1000;

/**
 * The attempt's entire instruction set — a fixed literal. **No field of the
 * request is interpolated into it**: `summary` is text written by another
 * program, and the system prompt is the one place in the session that outranks
 * every later message. Incident identity reaches the model through the user
 * message and the tool's own output, both of which the model already reads as
 * data rather than instruction.
 */
export const INCIDENT_SYSTEM_PROMPT = `You are an incident analyst answering one automated alert. Nobody is watching this thread while you work, and a human reads only your final message.

Your evidence is one tool, \`${INCIDENT_EVIDENCE_TOOL}\`, which takes no arguments. It re-reads the eagle-eye collector snapshot for the incident and environment this attempt was opened for. That is a collector snapshot, not an independent probe: it tells you what the collector observed and when, never what is true right now, and never why.

Rules you may not talk yourself out of:
- Do not state a root cause. A snapshot cannot establish one. Write the most likely explanation as a hypothesis, labelled as such, next to what would confirm or kill it.
- Read freshness before content. Every record carries the source's own observation time; a stale or absent observation is a fact about the evidence, not a fact about the system. Say which it is.
- Absent evidence proves nothing. An incident missing from the report is not recovery, not a fix, and not success — this collector holds no history.
- Quote what you rely on. Cite the record reference and its source timestamp from the tool output; never invent a reference, a value or a measurement that is not in it.
- You cannot act. You have no shell, no files, no network and no way to change anything. Do not claim to have checked, restarted, deployed or verified anything.

Write your final message for a human operator: what the evidence shows (with references and their observation times), the leading hypothesis marked as a hypothesis, a proposal of the next steps a human should take, and the uncertainties with what evidence would resolve each. If the evidence is unavailable or stale, say so first — that is a complete and useful answer.

End that message with exactly one machine-readable line, and nothing after it:

EAGLE_INCIDENT_RESULT: {"version":1,"status":"…","summary":"…","evidence":[{"id":"…","observed_at":"…"}],"proposal":{"id":"…","action":"…","risk":"…","rollback":"…","verification":"…"},"uncertainties":["…"]}

- One line, one JSON object, no code fence. Every key shown is required; \`proposal\` may be \`null\` when you have no action to propose. Add no other keys, and do not restate incident_id, lifecycle_id or attempt_id — the host owns the correlation ids.
- \`status\`: use \`succeeded\` only with at least one evidence reference AND a complete proposal. \`succeeded\` means an evidence-backed proposal is ready for a human — it never means the root cause is confirmed or the incident is fixed. Use \`inconclusive\` when the evidence cannot support a proposal, and \`failed\` when no evidence could be read.
- \`evidence[].id\` is the \`ref\` string of the record you used, copied character for character from the tool output. \`evidence[].observed_at\` is that same record's source observation timestamp, copied verbatim — never your own clock, never reformatted. A reference the host did not collect gets the whole conclusion rejected.
- \`uncertainties\` must include the source caveat: these are collector-snapshot observations taken at the stated times, not an independent probe of the system now. List what would resolve each remaining unknown.
- Bounds: summary at most 500 characters, other strings at most 1000, at most 10 evidence items and 10 uncertainties.`;

/**
 * Structural view of the v1 incident request (`EAGLE_INCIDENT_REQUEST:`),
 * declared locally so this adapter compiles before/independently of where the
 * session type ends up carrying it. The parser in
 * `packages/slack/src/incident-contract.ts` is the authority on the shape; this
 * is the subset the runtime adapter reads.
 */
export interface IncidentRequestLike {
  readonly version: 1;
  readonly incident_id: string;
  readonly lifecycle_id: string;
  readonly attempt_id: string;
  readonly channel_id: string;
  readonly parent_ts: string;
  readonly env: string;
  readonly summary: string;
}

/** An incident attempt that cannot be built safely. Never recoverable by falling back. */
export class IncidentOptionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IncidentOptionsError';
  }
}

/**
 * Field bounds, mirrored from the parser that admits a request
 * (`packages/slack/src/incident-contract.ts`). They are re-applied here because
 * the value reaching this module did not necessarily come from that parser:
 * `session-registry.ts:2075` restores `incidentRequest` verbatim for any
 * non-null object, so a truncated write, a hand-edited sessions file or an older
 * schema arrives unparsed.
 *
 * Drifting LOOSER than the contract is the only dangerous direction, and it
 * cannot happen: a value the contract would reject but this accepts still runs
 * under the isolated one-tool surface. A value this rejects fails the attempt
 * closed.
 */
const MAX_FIELD_CHARS: Readonly<Record<keyof Omit<IncidentRequestLike, 'version'>, number>> = {
  incident_id: 256,
  lifecycle_id: 128,
  attempt_id: 128,
  channel_id: 128,
  parent_ts: 128,
  env: 64,
  summary: 500,
};

/** `summary` is the one field the contract allows to be empty. */
const OPTIONAL_EMPTY_FIELDS: ReadonlySet<string> = new Set(['summary']);

const SLACK_CHANNEL_ID_PATTERN = /^[CGD][A-Z0-9]{1,20}$/;
const SLACK_TS_PATTERN = /^\d{10}\.\d{6}$/;

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Re-validate a request that may have come from disk rather than from the
 * contract parser. Throws `IncidentOptionsError` on anything short of the full
 * v1 shape.
 *
 * Why a throw rather than a boolean: a boolean makes "malformed" and "not an
 * incident" the same answer at the call site, and the caller's behaviour for the
 * latter is the ORDINARY option surface — project settings, plugins, skills,
 * every MCP server, Bash. Half-shaped incident metadata must never buy that.
 *
 * Messages name the FIELD and never the value: they reach logs, and the value is
 * precisely the part nobody has validated.
 */
export function assertIncidentRequest(value: unknown): IncidentRequestLike {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new IncidentOptionsError('incident request is not an object');
  }
  const raw = value as Record<string, unknown>;

  if (raw.version !== 1) {
    throw new IncidentOptionsError('incident request field version is not the supported version 1');
  }

  for (const [field, maxChars] of Object.entries(MAX_FIELD_CHARS)) {
    const candidate = raw[field];
    if (typeof candidate !== 'string') {
      throw new IncidentOptionsError(`incident request field ${field} is missing or not a string`);
    }
    if (candidate.length === 0 && !OPTIONAL_EMPTY_FIELDS.has(field)) {
      throw new IncidentOptionsError(`incident request field ${field} is empty`);
    }
    if (candidate.length > maxChars) {
      throw new IncidentOptionsError(`incident request field ${field} exceeds its bound`);
    }
    if (hasControlChars(candidate)) {
      throw new IncidentOptionsError(`incident request field ${field} carries control characters`);
    }
  }

  if (!SLACK_CHANNEL_ID_PATTERN.test(raw.channel_id as string)) {
    throw new IncidentOptionsError('incident request field channel_id is not a Slack channel id');
  }
  if (!SLACK_TS_PATTERN.test(raw.parent_ts as string)) {
    throw new IncidentOptionsError('incident request field parent_ts is not a Slack timestamp');
  }

  return raw as unknown as IncidentRequestLike;
}

interface IncidentLogger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

export interface IncidentSdkOptionsInput {
  /** The accepted v1 request this attempt answers. Its identity is captured, not re-derived. */
  request: IncidentRequestLike;
  /** Per-call auth/env map from `buildQueryEnv(lease)`. Passed by reference, as the ordinary path does. */
  queryEnv: Record<string, string | undefined>;
  /** Model id already resolved by the caller (session model → user default). No model policy lives here. */
  model?: string;
  /** The caller's abort controller; also the wall-clock budget's target. */
  abortController?: AbortController;
}

export interface IncidentSdkOptionsDeps {
  logger: IncidentLogger;
  /**
   * Operator config for the evidence collector. **Absent, or returning nothing,
   * is fatal** — the incident path throws rather than running an attempt that
   * cannot read evidence.
   */
  getIncidentEvidenceConfig?: () => IncidentEvidenceConfig | null | undefined;
  /**
   * Host-side record of what this attempt actually collected: the real
   * `IncidentEvidence` (the collector's own refs and source timestamps) plus the
   * request it belongs to. Nothing the model produces passes through here — the
   * later result validator (`decodeIncidentConclusion`) checks the final
   * message's citations against these records.
   *
   * Called **twice per tool call**: an `evidence_unavailable` invalidation write
   * before the collection, then the collected evidence on success. A registry
   * that keeps only the newest write therefore never presents a stale reading as
   * current after a failed retry. A throw from either call fails the tool call
   * closed — the model gets no blob the host has no record of.
   */
  onEvidence?: (request: IncidentRequestLike, evidence: IncidentEvidence) => void;
  /** Seam for tests; production uses the real collector. */
  collectEvidence?: (config: IncidentEvidenceConfig, request: IncidentEvidenceRequest) => Promise<IncidentEvidence>;
}

/**
 * Build the isolated `Options` for one incident attempt.
 *
 * Throws `IncidentOptionsError` when the attempt cannot be built safely. Every
 * throw here happens at wiring time, before any model call — an incident-time
 * failure would have already burned a turn and a lease.
 */
export function buildIncidentSdkOptions(input: IncidentSdkOptionsInput, deps: IncidentSdkOptionsDeps): Options {
  const { request, queryEnv, model, abortController } = input;
  const { logger } = deps;

  // Re-validated here too, not only at the session seam: a direct caller (a
  // future ACP/one-shot entry) must not be able to reach the tool closure with a
  // request nobody checked.
  assertIncidentRequest(request);

  const config = deps.getIncidentEvidenceConfig?.();
  if (!config) {
    throw new IncidentOptionsError('no incident evidence config is wired — refusing to run an incident attempt');
  }
  // Validate the origin now, not on the first tool call: an unusable operator
  // config is a wiring bug, and finding it mid-incident costs a whole attempt.
  try {
    resolveIncidentEvidenceOrigin(config.baseUrl);
  } catch (err) {
    throw new IncidentOptionsError(
      `incident evidence config is unusable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const collect = deps.collectEvidence ?? ((cfg, req) => collectIncidentEvidence(cfg, req));

  /**
   * The "a collection is in flight, nothing is on record" value, written to the
   * registry before every collection. Deliberately the same `IncidentEvidence`
   * shape the collector returns — a separate "invalidation" type would give the
   * registry a second thing to understand and a second way to be wrong.
   */
  const pendingEvidence = (): IncidentEvidence => ({
    incident_id: request.incident_id,
    env: request.env,
    status: 'evidence_unavailable',
    provenance: 'eagle_eye_collector_snapshot',
    caveat:
      'No evidence is on record for this attempt: a collection is in flight. Nothing is implied about the incident state either way; a completed collection replaces this record.',
    collected_at: new Date().toISOString(),
    triage: null,
    snapshot: null,
    errors: [],
  });

  const evidenceTool = tool(
    INCIDENT_EVIDENCE_TOOL_NAME,
    "Re-read the eagle-eye collector snapshot for this incident. Takes no arguments: the incident and environment are fixed for this attempt. Returns the collector's observations with their source timestamps — not an independent probe, and not a cause.",
    {},
    async (_args, extra) => {
      const signal =
        typeof extra === 'object' && extra !== null && 'signal' in extra && extra.signal instanceof AbortSignal
          ? extra.signal
          : undefined;
      const evidenceRequest: IncidentEvidenceRequest = {
        incident_id: request.incident_id,
        env: request.env,
        ...(signal ? { signal } : {}),
      };
      try {
        // Invalidate first. The registry is last-write-wins, so a retry that
        // fails would otherwise leave the PREVIOUS collection standing as the
        // newest record, and a conclusion written after that failure would cite
        // a reading the host never re-confirmed. The write is an ordinary
        // `IncidentEvidence` in its `evidence_unavailable` state — no triage, no
        // snapshot, and a caveat that claims nothing about the incident.
        deps.onEvidence?.(request, pendingEvidence());
        const evidence = await collect(config, evidenceRequest);
        // Record BEFORE returning. Evidence the host could not record cannot be
        // checked against the final message's citations, and a citation nobody
        // can check is worse than a missing collection.
        deps.onEvidence?.(request, evidence);
        return { content: [{ type: 'text' as const, text: JSON.stringify(evidence) }] };
      } catch (err) {
        // The message can carry hosts, ports and paths from the estate; it goes
        // to the log, never into the model's context.
        logger.error('Incident evidence collection failed', {
          incident_id: request.incident_id,
          attempt_id: request.attempt_id,
          env: request.env,
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Evidence collection failed. No evidence was read; nothing is implied about the incident state.',
            },
          ],
          isError: true,
        };
      }
    },
  );

  const policyContext = (): ToolPolicyContext => ({
    user: `incident:${request.lifecycle_id}`,
    // Not a human, and never an admin: the incident tier is admin-independent,
    // but a `true` here would still be a lie in every audit log line.
    isAdmin: false,
    // `legacy` would normally mean "defer to the SDK prompt"; under
    // `incidentReadOnly` the incident tier decides alone and never returns
    // `pass`, so this is the mode that adds the least of its own opinion.
    mode: 'legacy',
    aborted: abortController?.signal.aborted ?? false,
    isDangerousRuleDisabled: () => false,
    handoffContext: undefined,
    checkMcpToolPermission: () => null,
    incidentReadOnly: { allowedMcpTools: [INCIDENT_EVIDENCE_TOOL] },
  });

  const decide = (toolName: string, toolInput: Record<string, unknown> | undefined) => {
    // `evaluateToolPolicy`'s abort guard is Bash-only (tool-policy.ts: "Abort
    // guard (Bash only)"), and an incident attempt has no Bash — so without this
    // check the single evidence tool would keep firing after the attempt was
    // aborted or its wall-clock budget expired. Strictly narrower than the
    // shared policy, never wider.
    const result: ToolPolicyResult = abortController?.signal.aborted
      ? { decision: 'deny', reason: 'incident-abort-guard: attempt aborted' }
      : evaluateToolPolicy(toolName, toolInput, policyContext());
    if (result.decision !== 'allow') {
      logger.warn('Incident policy denied tool call', {
        incident_id: request.incident_id,
        attempt_id: request.attempt_id,
        tool: toolName,
        decision: result.decision,
        reason: result.reason,
      });
    }
    return result;
  };

  // Anything that is not an explicit `allow` becomes a deny — `ask` would hang
  // an unattended attempt, `pass` would hand it back to the SDK's own logic.
  const policyHook: HookCallback = async (hookInput): Promise<HookJSONOutput> => {
    const toolName = (hookInput as { tool_name?: string }).tool_name || '';
    const toolInput = (hookInput as { tool_input?: Record<string, unknown> }).tool_input;
    const result = decide(toolName, toolInput);
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: result.decision === 'allow' ? 'allow' : 'deny',
        ...(result.decision === 'allow' ? {} : { permissionDecisionReason: result.reason }),
      },
    };
  };

  const canUseTool: CanUseTool = async (toolName, toolInput): Promise<PermissionResult> => {
    const result = decide(toolName, toolInput);
    return result.decision === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: result.reason };
  };

  const options: Options = {
    env: queryEnv,
    systemPrompt: INCIDENT_SYSTEM_PROMPT,
    // No built-in tools, no project/local settings, no plugins: no skills, no
    // channel commands, no CLAUDE.md — nothing but the evidence tool below.
    tools: [],
    settingSources: [],
    plugins: [],
    strictMcpConfig: true,
    mcpServers: {
      [INCIDENT_EVIDENCE_SERVER_NAME]: createSdkMcpServer({
        name: INCIDENT_EVIDENCE_SERVER_NAME,
        tools: [evidenceTool],
      }),
    },
    allowedTools: [INCIDENT_EVIDENCE_TOOL],
    permissionMode: 'default',
    persistSession: false,
    maxTurns: INCIDENT_MAX_TURNS,
    hooks: {
      PreToolUse: INCIDENT_TOOL_POLICY_MATCHERS.map((matcher) =>
        matcher === undefined ? { hooks: [policyHook] } : { matcher, hooks: [policyHook] },
      ),
    },
    canUseTool,
  };

  if (model) {
    options.model = model;
  }

  // The wall-clock deadline is NOT armed here. This builder is pure: a timer it
  // started would outlive a normal finish with no owner to clear it (`unref` is
  // not cleanup — the callback still fires and could abort a controller the
  // caller went on to reuse). `INCIDENT_MAX_WALL_CLOCK_MS` is the value; the
  // stream owner (`ClaudeHandler.streamQuery`) arms and clears it in its own
  // try/finally, where the attempt's lifetime actually ends.
  if (abortController) {
    options.abortController = abortController;
  }

  logger.info('Built isolated incident attempt options', {
    incident_id: request.incident_id,
    attempt_id: request.attempt_id,
    env: request.env,
    model: options.model,
    maxTurns: INCIDENT_MAX_TURNS,
    tool: INCIDENT_EVIDENCE_TOOL,
  });

  return options;
}
