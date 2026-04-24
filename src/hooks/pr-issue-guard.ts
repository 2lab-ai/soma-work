/**
 * PR-issue precondition guard (#696).
 *
 * Pure function called by the in-process SDK PreToolUse hook in
 * `src/claude-handler.ts`. Enforces the issue-link precondition documented in
 * `src/local/skills/using-z/SKILL.md` §Session Handoff Protocol on PR-creation
 * tool calls (`Bash gh pr create` and `mcp__github__create_pull_request`)
 * for sessions started via z handoff.
 *
 * Spec: docs/pr-issue-precondition/spec.md (v2.1)
 * Trace: docs/pr-issue-precondition/trace.md (v2.1)
 *
 * Activation: caller (the hook closure) only invokes this guard when
 * `session.handoffContext` is set — guard takes it as a REQUIRED arg.
 * Sessions without handoffContext (legacy / non-z) bypass enforcement
 * entirely (out of scope for #696).
 */

import type { HookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import type { HandoffContext } from '../types';

export interface PrIssueGuardInput {
  toolName: string;
  toolInput: Record<string, unknown> | undefined;
  /**
   * REQUIRED. Caller resolves `session.handoffContext` via
   * `sessionRegistry.getSession(channel, threadTs)?.handoffContext` and
   * skips the guard entirely if undefined. The guard itself never
   * silently passes due to missing context — that decision is the
   * caller's, with structured logging.
   */
  handoffContext: HandoffContext;
}

export type PrIssueGuardReason =
  | 'no-issue-no-escape'
  | 'missing-closes-issue'
  | 'wrong-issue-number'
  | 'missing-escape-marker'
  | 'malformed-source-issue-url'
  | 'unknown-tool-shape';

export interface PrIssueGuardResult {
  blocked: boolean;
  reason?: PrIssueGuardReason;
  message?: string;
}

const PR_CREATE_MCP_TOOL = 'mcp__github__create_pull_request';

/** True iff command contains the literal `gh pr create` invocation. */
function isPrCreateBashCommand(cmd: string): boolean {
  return /\bgh\s+pr\s+create\b/.test(cmd);
}

/**
 * Extract the substring of the bash command that follows the `--body` /
 * `-b` / `--body-file` flag *within the `gh pr create` segment*.
 *
 * Two-step:
 *   1. Anchor to `\bgh\s+pr\s+create\b` so a stray `--body` in an unrelated
 *      earlier command (e.g., `echo "--body Closes #696" && gh pr create
 *      --body "x"`) is not used as the body source.
 *   2. Locate the first `--body` flag in the tail and return everything
 *      after it.
 *
 * Returns the WHOLE remainder (we don't try to find the matching close
 * quote — that requires shell tokenization and is out of scope per
 * spec AD-6). Marker check uses regex which tolerates trailing tokens.
 *
 * Returns `null` when:
 *   - no `gh pr create` substring is present, OR
 *   - no `--body` / `-b` flag follows it.
 */
function extractBashBodyContent(cmd: string): string | null {
  const ghMatch = /\bgh\s+pr\s+create\b/.exec(cmd);
  if (!ghMatch) return null;
  const tail = cmd.slice(ghMatch.index + ghMatch[0].length);
  const flagMatch = /(?:--body(?:-file)?|-b)(?:\s|=)/.exec(tail);
  if (!flagMatch) return null;
  return tail.slice(flagMatch.index + flagMatch[0].length);
}

/** Extract the issue number from a GitHub issue URL. */
function extractIssueNumber(url: string): number | null {
  const match = /\/issues\/(\d+)(?:[/?#]|$)/.exec(url);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  return Number.isFinite(n) ? n : null;
}

/** Case-insensitive `Closes #N` (whitespace-tolerant). */
function makeClosesIssueRegex(issueNumber: number): RegExp {
  return new RegExp(`\\bcloses\\s+#${issueNumber}\\b`, 'i');
}

/** Any `Closes #<digits>` reference (used to distinguish missing vs wrong-number). */
const CLOSES_ANY_ISSUE = /\bcloses\s+#\d+\b/i;

/** Case-sensitive Case A escape marker. */
const CASE_A_ESCAPE_MARKER = /Case A escape/;

function formatBlockMessage(reason: PrIssueGuardReason, ctx: HandoffContext, toolName: string): string {
  const sourceIssueUrl = ctx.sourceIssueUrl ?? 'null';
  const escapeEligible = String(ctx.escapeEligible);
  const issueRequiredByUser = String(ctx.issueRequiredByUser);
  const chainId = ctx.chainId;

  const header = `🚫 PR creation blocked: handoff session lacks linked-issue evidence.`;
  const toolLine = `Tool: ${toolName}`;
  const reasonLine = `Reason: ${reason}`;
  const ctxBlock = [
    'handoffContext:',
    `  sourceIssueUrl: ${sourceIssueUrl}`,
    `  escapeEligible: ${escapeEligible}`,
    `  issueRequiredByUser: ${issueRequiredByUser}`,
    `  chainId: ${chainId}`,
  ].join('\n');

  // Reason-specific cause + fix hints
  const causeAndFix = (() => {
    switch (reason) {
      case 'no-issue-no-escape':
        return [
          `Cause: this session was started via z handoff but has neither a source issue URL`,
          `nor a validated Case A escape eligible flag. Per \`local:using-z\` §Session Handoff`,
          `Protocol, PRs must close a linked issue.`,
          ``,
          `Fix:`,
          `  1. If this work belongs to an issue, restart the workflow from \`$z <issue_url>\`.`,
          `  2. If this is genuinely tier=tiny|small with no policy requirement, the handoff`,
          `     producer must emit \`## Escape Eligible: true\` (3-condition validated) AND`,
          `     the PR body must include \`Case A escape (tier=tiny|small, no issue by policy)\`.`,
        ].join('\n');
      case 'missing-closes-issue': {
        const issueNum = ctx.sourceIssueUrl ? extractIssueNumber(ctx.sourceIssueUrl) : null;
        return [
          `Cause: handoff session has \`sourceIssueUrl=${sourceIssueUrl}\` but the PR body does`,
          `not contain \`Closes #${issueNum ?? '<n>'}\`.`,
          ``,
          `Fix: include \`Closes #${issueNum ?? '<n>'}\` in the PR body. Use inline content`,
          `(literal string or heredoc) — shell variable indirection (\`--body "$VAR"\`) is`,
          `not visible to the static check.`,
        ].join('\n');
      }
      case 'wrong-issue-number': {
        const issueNum = ctx.sourceIssueUrl ? extractIssueNumber(ctx.sourceIssueUrl) : null;
        return [
          `Cause: PR body references a \`Closes #N\` that does not match this handoff's`,
          `\`sourceIssueUrl=${sourceIssueUrl}\` (expected \`Closes #${issueNum ?? '<n>'}\`).`,
          ``,
          `Fix: change the body to reference \`Closes #${issueNum ?? '<n>'}\`. If you intended a`,
          `different issue, restart the workflow from that issue with \`$z <issue_url>\`.`,
        ].join('\n');
      }
      case 'missing-escape-marker':
        return [
          `Cause: handoff session has \`escapeEligible=true\` (Case A escape path) but the PR`,
          `body does not contain the required \`Case A escape\` marker.`,
          ``,
          `Fix: include \`Case A escape (tier=tiny|small, no issue by policy)\` in the PR body.`,
          `Use inline content (literal string or heredoc).`,
        ].join('\n');
      case 'malformed-source-issue-url':
        return [
          `Cause: handoff session has \`sourceIssueUrl=${sourceIssueUrl}\` but the URL does not`,
          `match the GitHub issue URL pattern \`/issues/<number>\`. This is a producer-side bug`,
          `in the handoff sentinel — the parser should have rejected it.`,
          ``,
          `Fix: report this to the handoff producer. The session cannot create a PR until the`,
          `handoff is re-emitted with a valid issue URL.`,
        ].join('\n');
      case 'unknown-tool-shape':
        return [
          `Cause: tool input did not have the expected shape (missing or non-string body field).`,
          `Cannot validate marker presence.`,
          ``,
          `Fix: ensure the tool call provides a string body field.`,
        ].join('\n');
    }
  })();

  return [header, '', toolLine, reasonLine, '', ctxBlock, '', causeAndFix].join('\n');
}

/**
 * Apply the PR-issue precondition to a single tool call.
 *
 * Tool detection:
 *   - `Bash` with command containing `gh pr create` → extract body from
 *     `--body` flag (after gh segment anchor)
 *   - `mcp__github__create_pull_request` → use structured `toolInput.body`
 *   - Any other tool / Bash command → `{ blocked: false }`
 *
 * Precedence (per spec AD-8):
 *   - `sourceIssueUrl !== null` wins → require `Closes #N`
 *   - else `escapeEligible === true` → require `Case A escape` marker
 *   - else → block (`no-issue-no-escape`)
 */
export function handlePrIssuePrecondition(input: PrIssueGuardInput): PrIssueGuardResult {
  const { toolName, toolInput, handoffContext: ctx } = input;

  // 1. Resolve body content per tool shape
  let bodyContent: string | null;

  if (toolName === 'Bash') {
    const cmd = typeof toolInput?.command === 'string' ? (toolInput.command as string) : null;
    if (cmd === null) {
      // Bash without a command field — fail-open (not a real PR-create attempt)
      return { blocked: false };
    }
    if (!isPrCreateBashCommand(cmd)) {
      return { blocked: false };
    }
    bodyContent = extractBashBodyContent(cmd);
    // `bodyContent === null` here means: gh pr create with no --body flag.
    // Treated as if body is empty — guard proceeds and will block on missing marker.
    if (bodyContent === null) bodyContent = '';
  } else if (toolName === PR_CREATE_MCP_TOOL) {
    const body = toolInput?.body;
    if (typeof body !== 'string') {
      return {
        blocked: true,
        reason: 'unknown-tool-shape',
        message: formatBlockMessage('unknown-tool-shape', ctx, toolName),
      };
    }
    bodyContent = body;
  } else {
    // Not a PR-creation tool
    return { blocked: false };
  }

  // 2. Apply precedence: sourceIssueUrl > escapeEligible > deny
  if (ctx.sourceIssueUrl !== null) {
    const issueNum = extractIssueNumber(ctx.sourceIssueUrl);
    if (issueNum === null) {
      return {
        blocked: true,
        reason: 'malformed-source-issue-url',
        message: formatBlockMessage('malformed-source-issue-url', ctx, toolName),
      };
    }
    const closesRegex = makeClosesIssueRegex(issueNum);
    if (closesRegex.test(bodyContent)) {
      return { blocked: false };
    }
    // Distinguish wrong-number vs missing-entirely for clearer messages
    if (CLOSES_ANY_ISSUE.test(bodyContent)) {
      return {
        blocked: true,
        reason: 'wrong-issue-number',
        message: formatBlockMessage('wrong-issue-number', ctx, toolName),
      };
    }
    return {
      blocked: true,
      reason: 'missing-closes-issue',
      message: formatBlockMessage('missing-closes-issue', ctx, toolName),
    };
  }

  // sourceIssueUrl === null
  if (ctx.escapeEligible === true) {
    if (CASE_A_ESCAPE_MARKER.test(bodyContent)) {
      return { blocked: false };
    }
    return {
      blocked: true,
      reason: 'missing-escape-marker',
      message: formatBlockMessage('missing-escape-marker', ctx, toolName),
    };
  }

  // Neither sourceIssueUrl nor escapeEligible → orphan PR forbidden
  return {
    blocked: true,
    reason: 'no-issue-no-escape',
    message: formatBlockMessage('no-issue-no-escape', ctx, toolName),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SDK Hook factory — wires the pure guard into the in-process PreToolUse hook
// system used by ClaudeHandler. Injecting the lookup + logger keeps the
// factory unit-testable without spinning up a full ClaudeHandler.
// ─────────────────────────────────────────────────────────────────────────────

export interface PrIssueHookLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
}

export interface PrIssueHookDeps {
  /**
   * Resolves the active session's handoffContext at hook invocation time.
   * Return `undefined` when:
   *   - no session exists for the current channel/threadTs (orphaned hook), OR
   *   - the session exists but has no handoffContext (legacy/non-z workflow).
   * The factory will skip enforcement and emit a structured `info` log.
   */
  getHandoffContext(): HandoffContext | undefined;
  logger: PrIssueHookLogger;
  /** Static log enrichment (channel, threadTs) added to every emitted log line. */
  logCtx: Record<string, unknown>;
}

export interface SdkHookEntry {
  matcher: string;
  hooks: Array<(input: HookInput) => Promise<HookJSONOutput>>;
}

const PR_CREATE_BASH_MATCHER = 'Bash';
const PR_CREATE_MCP_MATCHER = 'mcp__';

/**
 * Build the two PreToolUse hook entries (Bash + mcp__) for the PR-issue
 * precondition. Caller pushes these into `preToolUseHooks` at
 * `claude-handler.ts:~949`.
 *
 * The MCP matcher fires for ALL `mcp__*` tools — the hook itself filters to
 * `mcp__github__create_pull_request` to avoid interfering with other MCP calls.
 *
 * Hook return contract per SDK 0.2.111 `PreToolUseHookSpecificOutput`:
 *   - block: `{ hookSpecificOutput: { hookEventName, permissionDecision: 'deny',
 *             permissionDecisionReason } }` — `permissionDecisionReason` surfaces
 *             to the model.
 *   - pass:  `{ continue: true }` — defers to other hooks / SDK default.
 *
 * SDK multi-hook precedence is `deny > defer > ask > allow > undefined`, so this
 * `deny` wins over an earlier bypass-mode `allow` from the same matcher.
 */
export function buildPrIssueHookEntries(deps: PrIssueHookDeps): SdkHookEntry[] {
  const makeHook =
    (matcherKind: 'bash' | 'mcp') =>
    async (input: HookInput): Promise<HookJSONOutput> => {
      const ctx = deps.getHandoffContext();
      if (!ctx) {
        // Caller's getHandoffContext is responsible for distinguishing
        // no-session vs no-handoffContext in its own logs (it has access
        // to richer context). Factory just notes the skip.
        deps.logger.info('PR-issue guard skipped: no handoff context', deps.logCtx);
        return { continue: true };
      }

      const toolName = (input as { tool_name?: string }).tool_name || '';
      const toolInput = (input as { tool_input?: Record<string, unknown> }).tool_input;

      // The mcp__ matcher fires for ALL mcp__* tools — filter to the PR creation one.
      if (matcherKind === 'mcp' && toolName !== 'mcp__github__create_pull_request') {
        return { continue: true };
      }

      const result = handlePrIssuePrecondition({
        toolName,
        toolInput,
        handoffContext: ctx,
      });

      if (result.blocked) {
        deps.logger.warn('PR creation blocked by handoff precondition', {
          ...deps.logCtx,
          tool: toolName,
          reason: result.reason,
          chainId: ctx.chainId,
        });
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: result.message,
          },
        };
      }

      return { continue: true };
    };

  return [
    { matcher: PR_CREATE_BASH_MATCHER, hooks: [makeHook('bash')] },
    { matcher: PR_CREATE_MCP_MATCHER, hooks: [makeHook('mcp')] },
  ];
}
