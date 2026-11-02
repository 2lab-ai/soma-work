/**
 * Builder for the streaming `Options` shape consumed by
 * `ClaudeHandler.streamQuery` (P1 of epic #1023).
 *
 * `streamQuery` historically inlined ~530 lines of `Options` assembly between
 * lease acquisition and the `query({ prompt, options })` loop. This builder
 * extracts that assembly verbatim — same logic, same ordering, same hook
 * composition — so the handler keeps only its lifecycle concerns (lease
 * heartbeat, the streaming loop, error/stderr attach, lease release).
 *
 * This file lives in the Claude-Code adapter zone, so (unlike the SDK-agnostic
 * `agent-runtime` port) it is allowed to import the concrete
 * `@anthropic-ai/claude-agent-sdk` `Options` type directly.
 *
 * Out of scope (kept in `streamQuery`):
 *   • Lease acquisition / heartbeat / release (`ensureActiveSlotAuth`).
 *   • The `buildQueryEnv(lease)` call — its `env` is passed *in* as `queryEnv`.
 *   • The `query({ prompt, options })` loop, `maybeThrowOneMUnavailable`,
 *     the `session.sessionId = message.session_id` init capture and `yield`.
 *   • The catch block's `error.stderrContent` attach — the builder only
 *     accumulates stderr and exposes it via `getStderrBuffer()`.
 */

import type { HookInput, HookJSONOutput, Options } from '@anthropic-ai/claude-agent-sdk';
import * as fs from 'fs';
import * as path from 'path';
import { isSdkEffortLevel } from 'soma-lib';
import type { ModelCommandContext } from 'somalib/model-commands/types';
import type { PermissionAdvice } from 'somalib/permission/shared-store';
import { isAdminUser } from '../../admin-utils';
import {
  buildRepoContextBlock,
  buildThinkingOption,
  type CompactHookBuilder,
  handleClaudeStderrChunk,
  resolveShowSummary,
} from '../../claude-handler';
import { CONFIG_FILE } from '../../env-paths';
import { checkEnvSkillAccess, type EnvSkillRegistry, envSkillSandboxDenyRead } from '../../env-skill-registry';
import type { IncidentEvidence, IncidentEvidenceConfig } from '../../incident/evidence';
import { assertIncidentRequest, buildIncidentSdkOptions, type IncidentRequestLike } from '../../incident/sdk-options';
import type { McpConfig, SlackContext } from '../../mcp-config-builder';
import { getPermissionGatedServers, loadMcpToolPermissions } from '../../mcp-tool-permission-config';
import { resolveModelProfile } from '../../metrics/model-profile';
import { clampEffortToModel, modelCatalog } from '../../model-catalog';

import { isSafePathSegment, normalizeTmpPath } from '../../path-utils';
import type { SdkPluginPath } from '../../plugin/types';
import { extendSandboxWithGrant, loadDeploySandboxGrant } from '../../sandbox/deploy-sandbox-grant';
import { DEV_DOMAIN_ALLOWLIST } from '../../sandbox/dev-domain-allowlist';
import type { SessionRegistry } from '../../session-registry';
import type { ConversationSession, WorkflowType } from '../../types';
import { DEFAULT_THINKING_ENABLED, userSettingsStore } from '../../user-settings-store';
import { createTrackedClaudeProcessSpawner } from '../claude-child-process-registry';
import {
  type ExecutionContext,
  ExecutionContextMissingError,
  executionContextFromSlack,
  revalidateTaskDirectory,
} from '../execution-context';
import { createNativeWriteCheck } from '../policy/native-write-boundary';
import { permissionAdviceBoard } from '../policy/permission-advice';
import { checkPlanPendingCall } from '../policy/plan-pending-guard';
import type { SafetyClassifier } from '../policy/safety-classifier';
import {
  evaluateToolPolicy,
  INCIDENT_TOOL_POLICY_MATCHERS,
  TOOL_POLICY_MATCHERS,
  type ToolPolicyContext,
} from '../policy/tool-policy';

/** The llmux catalog group whose streams report each call's usage on `message_start`. */
const CLAUDE_GROUP = 'claude';
/** Claude ids, for an id the catalog does not list (cold start, non-llmux auth). */
const CLAUDE_MODEL_RE = /^claude-/i;

/**
 * Does this model's stream leave per-call usage to `message_delta`, so the
 * harness must request partial messages to see it? Every non-claude llmux
 * provider does (codex, grok — measured: `message_start.usage = {0, 0}`).
 *
 * The catalog group is the authority (the same predicate `host-pricing.ts`
 * prices by); the id prefix only decides for an id the catalog does not
 * list, so a claude session on an empty catalog is not flooded with frames.
 * A false positive costs only frames: the mapper reads a delta only when its
 * call's `message_start` was empty.
 */
function needsStreamedCallUsage(model: string): boolean {
  const id = model.trim();
  const group = modelCatalog.getGroupFor(id);
  if (group) return group !== CLAUDE_GROUP;
  return !CLAUDE_MODEL_RE.test(id);
}

/**
 * Structural logger surface used by the builder. The concrete `Logger`
 * (`src/logger.ts`) satisfies this; kept local to avoid a hard dependency.
 */
export interface BuildStreamOptionsDeps {
  logger: {
    debug(message: string, data?: unknown): void;
    info(message: string, data?: unknown): void;
    warn(message: string, data?: unknown): void;
    error(message: string, data?: unknown): void;
  };
  getEffectivePluginPaths: () => SdkPluginPath[];
  buildModelCommandContext: (
    session: ConversationSession | undefined,
    slackContext: SlackContext | undefined,
  ) => ModelCommandContext | undefined;
  mcpConfigBuilder: {
    buildConfig(
      slackContext: SlackContext | undefined,
      ctx: ModelCommandContext | undefined,
      executionContext?: ExecutionContext,
    ): Promise<McpConfig>;
  };
  compactHookBuilder?: CompactHookBuilder;
  promptBuilder: {
    buildSystemPrompt(userId?: string, workflow?: WorkflowType, session?: ConversationSession): string | undefined;
  };
  sessionRegistry: SessionRegistry;
  checkMcpToolPermission: (
    toolName: string,
    user: string,
    cfg: ReturnType<typeof loadMcpToolPermissions>,
    gated: string[],
  ) => string | null | undefined;
  /**
   * The deploy-time environment plugins (`plugin.envPlugins`) and where their skills live — what
   * step 6b of the policy checks a `Skill` call against. Absent → no environment skills.
   */
  getEnvSkillRegistry?: () => EnvSkillRegistry;
  /**
   * Enforcer of a step-6b denial: ask the admins for the skill (DM prompt + a notice in the
   * thread). Fire-and-forget from the hook; the request store dedupes repeated calls per thread.
   */
  onEnvSkillDenied?: (denial: EnvSkillDenial) => Promise<void>;
  /**
   * Auto-mode safety classifier (guardian). Consulted only when the policy
   * returns the `classify` decision (a dangerous-rule hit in `auto` mode).
   * When absent, `classify` fails closed to `ask` — i.e. auto mode degrades to
   * the old "dangerous → ask the human" behaviour.
   */
  safetyClassifier?: SafetyClassifier;
  /**
   * #599 ⑤ — the dashboard approver of a Slack-less task's escalations. A
   * `classify` call the classifier did not allow waits here for the task
   * owner's answer on the dashboard (bound to the task, its turn and the
   * request). Absent → the escalation is denied (no approver). Any failure —
   * expiry, abort, a store error — is a deny: nothing runs unapproved.
   */
  taskApprover?: TaskApprover;
  /**
   * Operator config for the incident evidence collector (`rules/config.md` owns
   * the getter's name; this dep only needs the value). Consulted **only** on the
   * incident path. Absent there is fatal, not a fallback — see
   * `buildIncidentSdkOptions`.
   */
  getIncidentEvidenceConfig?: () => IncidentEvidenceConfig | null | undefined;
  /**
   * Host-side registry of what an incident attempt actually collected (the
   * collector's records, never a model-produced string), so the later result
   * validator can check the final message's citations against real observations
   * instead of trusting the model's prose. The request is passed alongside so
   * the registry can key by attempt without re-deriving it.
   */
  onIncidentEvidence?: (request: IncidentRequestLike, evidence: IncidentEvidence) => void;
}

/** #599 ⑤ — what a task's escalation asks the dashboard approver for. */
export interface TaskApprovalRequest {
  sessionKey: string;
  userId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  ruleIds: string[];
  /** SSOT 2026-11-02 — the guardian's advice, shown on the dashboard card (absent when it gave none). */
  advice?: PermissionAdvice;
  signal?: AbortSignal;
  /**
   * When the SDK cancels this hook (epoch ms, its timeout less a margin): the
   * approver's wait must end before it, or an approval given late is lost.
   */
  deadlineAt?: number;
}

export interface TaskApprover {
  request(req: TaskApprovalRequest): Promise<{ behavior: 'allow' | 'deny'; message?: string }>;
}

/**
 * A task turn's PreToolUse hook may wait for a dashboard approval (5 min):
 * the SDK's hook timeout (seconds) is set above that window.
 */
export const TASK_APPROVAL_HOOK_TIMEOUT_S = 330;
/** Kept between the approver's last poll and the SDK's cancellation of the hook. */
export const TASK_APPROVAL_HOOK_MARGIN_MS = 10_000;

/** A `Skill` call step 6b denied: who asked, for which environment skill, in which thread. */
export interface EnvSkillDenial {
  requesterId: string;
  /** `plugin:skill` */
  skillKey: string;
  channel: string;
  threadTs?: string;
}

/** The reason prefix step 6b of `evaluateToolPolicy` denies with (`env-skill: <plugin:skill>`). */
const ENV_SKILL_REASON_PREFIX = 'env-skill: ';

export interface BuildStreamOptionsInput {
  queryEnv: Record<string, string | undefined>;
  session?: ConversationSession;
  abortController?: AbortController;
  workingDirectory?: string;
  slackContext?: SlackContext;
  /**
   * The context the turn runs under (#597). A Slack turn derives one from
   * `slackContext`; a Slack-less task passes the one built from its saved
   * record (`executionContextForTask`). With neither, the options carry no
   * tools and no bypass.
   */
  executionContext?: ExecutionContext;
}

export interface BuildStreamOptionsResult {
  options: Options;
  /** Reads the accumulated SDK child stderr (consumed by streamQuery's catch block). */
  getStderrBuffer: () => string;
}

/**
 * Assemble the streaming `Options` object. Async because MCP config building
 * (`mcpConfigBuilder.buildConfig`) is async.
 *
 * The returned `options.stderr` callback accumulates every SDK child stderr
 * chunk into a buffer (exposed via `getStderrBuffer`) AND forwards to
 * `handleClaudeStderrChunk` for logging-policy — identical to the inline code.
 */
export async function buildStreamOptions(
  input: BuildStreamOptionsInput,
  deps: BuildStreamOptionsDeps,
): Promise<BuildStreamOptionsResult> {
  const { queryEnv, session, abortController, slackContext } = input;
  const { logger } = deps;

  // A task turn has no Slack thread (#613 R2): its skill scope, approval path and
  // Slack-only servers must never come from one.
  if (input.executionContext?.origin === 'task' && slackContext) {
    throw new ExecutionContextMissingError('a task turn carries no Slack context');
  }
  // A context and a Slack event that name different users cannot both be right.
  if (input.executionContext && slackContext?.user && input.executionContext.userId !== slackContext.user) {
    throw new ExecutionContextMissingError('the execution context and the Slack event name different users');
  }
  // A task runs in the directory its context validated — never in a caller's
  // argument (#613 R1, .prd/17 D6/T8): a different one is refused, a missing
  // one is the task's.
  let workingDirectory = input.workingDirectory;
  if (input.executionContext?.origin === 'task') {
    const taskDirectory = input.executionContext.workingDirectory;
    if (!taskDirectory) throw new ExecutionContextMissingError('task context has no working directory');
    if (workingDirectory && normalizeTmpPath(path.resolve(workingDirectory)) !== taskDirectory) {
      throw new ExecutionContextMissingError('working directory differs from the task’s');
    }
    workingDirectory = taskDirectory;
  }

  // SDK 0.3 child-process env, set BEFORE the incident branch on purpose: both
  // flags remove behaviour rather than grant capability, and the incident path
  // shares this `queryEnv` by reference, so it needs them too.
  //   - The Slack adapter consumes TodoWrite snapshots, not SDK 0.3 task deltas.
  //   - First-turn tool/approval availability: an incident attempt is usually a
  //     single turn against an in-process MCP evidence tool, so a non-blocking
  //     connect would let that turn run with no evidence tool at all.
  queryEnv.CLAUDE_CODE_ENABLE_TASKS = 'false';
  queryEnv.MCP_CONNECTION_NONBLOCKING = '0';

  // Incident receiver sessions take a separate, minimal option surface and the
  // ordinary assembly below never runs — no MCP servers, no plugins, no
  // persona/skills/channel prompt, no sandboxed shell. Returning early (rather
  // than narrowing the ordinary options afterwards) is the point: a capability
  // added below can never leak into an incident attempt by omission.
  const incidentRequest = readIncidentRequest(session);
  if (incidentRequest) {
    const incidentModel =
      session?.model ?? (slackContext?.user ? userSettingsStore.getUserDefaultModel(slackContext.user) : undefined);
    const incidentOptions = buildIncidentSdkOptions(
      { request: incidentRequest, queryEnv, model: incidentModel, abortController },
      {
        logger,
        getIncidentEvidenceConfig: deps.getIncidentEvidenceConfig,
        onEvidence: deps.onIncidentEvidence,
      },
    );
    return attachStderrCapture(incidentOptions, logger);
  }

  const options: Options = {
    // Load settings from filesystem for backward compatibility (Agent SDK v0.1.0 breaking change)
    settingSources: ['project'],
    // Load plugins from PluginManager or fallback to local directory
    plugins: deps.getEffectivePluginPaths(),
    env: queryEnv,
  };

  // The context this turn runs under (#597, .prd/17 D2). A Slack turn derives
  // it from the Slack-signed event; a Slack-less task passes the one built from
  // its saved record. No context → no tools and no bypass: the old
  // `!slackContext → bypass` with no policy hook is gone (fail closed).
  const execCtx: ExecutionContext | undefined =
    input.executionContext ??
    (slackContext?.user
      ? executionContextFromSlack({
          user: slackContext.user,
          sessionKey: deps.sessionRegistry.getSessionKey(slackContext.channel, slackContext.threadTs),
          workingDirectory,
        })
      : undefined);
  const contextUser = execCtx?.userId;

  let mcpConfig: McpConfig | undefined;
  if (!execCtx) {
    logger.warn('No execution context — the turn runs with no tools and no bypass (#597)');
    options.tools = [];
    options.permissionMode = 'default';
  } else {
    // Get MCP configuration
    const modelCommandContext = deps.buildModelCommandContext(session, slackContext);
    mcpConfig = await deps.mcpConfigBuilder.buildConfig(slackContext, modelCommandContext, execCtx);
    options.permissionMode = mcpConfig.permissionMode;
    if (mcpConfig.allowDangerouslySkipPermissions) {
      options.allowDangerouslySkipPermissions = true;
    }

    if (mcpConfig.mcpServers) {
      options.mcpServers = mcpConfig.mcpServers;
    }
    if (mcpConfig.allowedTools && mcpConfig.allowedTools.length > 0) {
      options.allowedTools = mcpConfig.allowedTools;
    }
    if (mcpConfig.disallowedTools && mcpConfig.disallowedTools.length > 0) {
      options.disallowedTools = mcpConfig.disallowedTools;
    }
    if (mcpConfig.permissionPromptToolName) {
      options.permissionPromptToolName = mcpConfig.permissionPromptToolName;
      // SDK MCP calls default to a 60s stream-close timeout. Slack approvals
      // intentionally wait up to five minutes, so keep the SDK bridge open past
      // the handler timeout while preserving an operator override.
      if (slackContext && options.env && options.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT === undefined) {
        options.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = '310000';
      }
    }
  }

  // The roots sandboxed Bash may write: the working directory (the SDK sandbox's
  // default) and `/tmp/{userId}` (`allowWrite`, mounted below). The policy hook
  // confines the native file tools of a non-admin to the same roots
  // (`native-write-boundary.ts`); with the sandbox off neither is confined.
  const sandboxDisabled = contextUser ? userSettingsStore.getUserSandboxDisabled(contextUser) : false;
  // A task turn run by a user other than its owner (SSOT 2026-11-02): it works in the owner's task folder.
  const isOtherUsersTaskTurn =
    execCtx?.origin === 'task' &&
    (execCtx as { ownerId?: string }).ownerId !== undefined &&
    (execCtx as { ownerId?: string }).ownerId !== execCtx.userId;
  const sandboxUserDir =
    contextUser && isSafePathSegment(contextUser) ? normalizeTmpPath(path.join('/tmp', contextUser)) : undefined;
  const nativeWriteRoots: readonly string[] | undefined = sandboxDisabled
    ? undefined
    : [...(workingDirectory ? [workingDirectory] : []), ...(sandboxUserDir ? [sandboxUserDir] : [])];

  // PreToolUse hooks — for every turn that has a context, Slack or not (D3).
  if (execCtx && mcpConfig) {
    const somaPermissionMode = mcpConfig.somaPermissionMode;
    // PreToolUse: a single unified policy hook (epic #1023 P5). All tool guards
    // — abort, ssh-ban, sensitive-path, cross-user, MCP grant, PR-issue
    // precondition, mode allow/classify — collapse into `evaluateToolPolicy`,
    // whose deny > classify/allow > pass precedence reproduces the prior multi-hook
    // SDK merge (deny from any guard wins over the bypass allow; a dangerous Bash
    // in auto mode goes to the safety classifier). Live state (abort signal, handoff
    // context) is resolved per call so mid-session aborts and handoff changes are honored.
    const policyUser = execCtx.userId;
    // The owner's root only while the OS sandbox holds Bash's writes to the task folder and the sender's
    // root (trinity R2, fable P2): with the sandbox off the cross-user text check is the only Bash guard left.
    const crossUserRoot =
      execCtx.origin === 'task' && !sandboxDisabled
        ? (execCtx as { ownerId?: string }).ownerId || policyUser
        : policyUser;
    const policyIsAdmin = execCtx.isAdmin;
    const cachedPermConfig = CONFIG_FILE ? loadMcpToolPermissions(CONFIG_FILE) : {};
    const gatedServerNames = getPermissionGatedServers(cachedPermConfig);
    const hookSessionKey = execCtx.sessionKey;
    // Only a Slack-less task's escalation waits for the dashboard (#599 ⑤).
    const taskApprover = execCtx.origin === 'task' && !slackContext ? deps.taskApprover : undefined;
    // A Slack thread grant applies to its thread; a task's scope is its own key,
    // which no Slack thread grant can match (the user's standing grants still apply).
    const envSkillScope = slackContext
      ? { channel: slackContext.channel, threadTs: slackContext.threadTs }
      : { channel: execCtx.sessionKey };
    const envRegistry = deps.getEnvSkillRegistry?.();
    // Plan mode (SSOT 2026-11-02): a task whose plan is not started researches; step 6c refuses the work.
    const planPending = execCtx.origin === 'task' && (execCtx as { planPending?: true }).planPending === true;

    const policyHook = async (
      input: HookInput,
      _toolUseId?: string,
      hookOptions?: { signal?: AbortSignal },
    ): Promise<HookJSONOutput> => {
      // The SDK's clock for this hook starts now; the classifier may spend part of it.
      const hookDeadlineAt = Date.now() + TASK_APPROVAL_HOOK_TIMEOUT_S * 1000 - TASK_APPROVAL_HOOK_MARGIN_MS;
      const toolName = (input as { tool_name?: string }).tool_name || '';
      const toolInput = (input as { tool_input?: Record<string, unknown> }).tool_input;
      // The session's directory now (a worktree switch moves it): relative targets and
      // the repository of a new worktree are resolved from it, as the SDK does.
      const hookCwd = (input as { cwd?: string }).cwd || workingDirectory || process.cwd();
      const ctx: ToolPolicyContext = {
        // The /tmp root the cross-user guard holds the turn to: a task's owner's, the root the task lives in
        // (SSOT 2026-11-02 — another user who instructs it works in that folder). Writes stay held to the task
        // folder and the sender's own root (`nativeWriteRoots`, the sandbox); grants and approvals stay the sender's.
        user: crossUserRoot,
        isAdmin: policyIsAdmin,
        mode: somaPermissionMode,
        aborted: abortController?.signal.aborted ?? false,
        isDangerousRuleDisabled: (ruleId) => deps.sessionRegistry.isDangerousRuleDisabled(hookSessionKey, ruleId),
        handoffContext: slackContext
          ? deps.sessionRegistry.getSession(slackContext.channel, slackContext.threadTs)?.handoffContext
          : deps.sessionRegistry.getSessionByKey(execCtx.sessionKey)?.handoffContext,
        checkMcpToolPermission: (name) =>
          gatedServerNames.length > 0
            ? (deps.checkMcpToolPermission(name, policyUser, cachedPermConfig, gatedServerNames) ?? null)
            : null,
        ...(nativeWriteRoots ? { checkNativeWrite: createNativeWriteCheck(nativeWriteRoots, hookCwd) } : {}),
        checkEnvSkillPermission: (tool, toolInput) =>
          envRegistry
            ? checkEnvSkillAccess(tool, toolInput, policyUser, envSkillScope, envRegistry, workingDirectory)
            : null,
        ...(planPending ? { checkPlanPending: checkPlanPendingCall } : {}),
      };

      const result = evaluateToolPolicy(toolName, toolInput, ctx);
      switch (result.decision) {
        case 'deny': {
          logger.warn('Tool policy denied call', { tool: toolName, user: policyUser, reason: result.reason });
          const envSkillKey = result.reason.startsWith(ENV_SKILL_REASON_PREFIX)
            ? result.reason.slice(ENV_SKILL_REASON_PREFIX.length)
            : null;
          // Enforce step 6b: ask the admins — only for a denial that names one skill (`plugin:skill`);
          // a read of other plugin files or an unnamed `Skill` call has no skill to grant. Never
          // awaited — the denial must reach the model now.
          // A task has no thread to post the ask in: the denial stands, nobody is asked.
          if (envSkillKey?.includes(':') && deps.onEnvSkillDenied && slackContext) {
            void deps
              .onEnvSkillDenied({
                requesterId: policyUser,
                skillKey: envSkillKey,
                channel: slackContext.channel,
                threadTs: slackContext.threadTs,
              })
              .catch((err: unknown) =>
                logger.warn('Environment skill permission request failed', {
                  user: policyUser,
                  err: err instanceof Error ? err.message : String(err),
                }),
              );
          }
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              ...(result.denyMessage ? { permissionDecisionReason: result.denyMessage } : {}),
            },
          };
        }
        case 'classify': {
          // Auto mode: a dangerous-rule hit. Consult the guardian classifier;
          // fail closed to `ask` when no classifier is wired or it errors.
          const command = typeof toolInput?.command === 'string' ? toolInput.command : '';
          const verdict = deps.safetyClassifier
            ? await deps.safetyClassifier
                .classify({
                  toolName,
                  command,
                  toolInput: toolInput ?? {},
                  matchedRuleIds: result.matchedRuleIds ?? [],
                  cwd: workingDirectory,
                  user: policyUser,
                  // Default classifier model = the session's CURRENT model
                  // (#model-call-unify). Resolved on `options.model` earlier.
                  model: options.model,
                  // The SDK cancelling this hook (the turn stopped) stops the guardian call too.
                  ...(hookOptions?.signal ? { signal: hookOptions.signal } : {}),
                })
                .catch((err) => ({
                  verdict: 'ask' as const,
                  reason: `classifier threw (fail-closed): ${err instanceof Error ? err.message : String(err)}`,
                }))
            : { verdict: 'ask' as const, reason: 'no classifier wired (fail-closed)' };
          // The guardian's advice for the person, when the call reaches one (SSOT 2026-11-02 T2).
          const advice: PermissionAdvice | null = ('advice' in verdict && verdict.advice) || null;
          if (verdict.verdict === 'allow') {
            logger.info('Auto-mode classifier approved tool call', {
              tool: toolName,
              user: policyUser,
              rule: result.reason,
              reason: verdict.reason,
            });
            return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } };
          }
          if (taskApprover) {
            // #599 ⑤ — the same escalation a Slack turn would ask about waits for
            // the answer of the turn's user (the owner, or whoever instructed it — SSOT
            // 2026-11-02) on the dashboard. Fail closed on anything else.
            logger.warn('Escalation waiting for the dashboard approval (#599)', {
              tool: toolName,
              user: policyUser,
              rule: result.reason,
            });
            const answer = await taskApprover
              .request({
                sessionKey: hookSessionKey,
                userId: policyUser,
                toolName,
                toolInput: toolInput ?? {},
                ruleIds: [...(result.matchedRuleIds ?? [])],
                ...(advice ? { advice } : {}),
                deadlineAt: hookDeadlineAt,
                ...(hookOptions?.signal ? { signal: hookOptions.signal } : {}),
              })
              .catch((err: unknown) => ({
                behavior: 'deny' as const,
                message: `The approval could not be completed (${err instanceof Error ? err.message : String(err)}) — it was not run.`,
              }));
            if (answer.behavior === 'allow') {
              return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } };
            }
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason:
                  answer.message || 'The task owner did not approve this call — it was not run.',
              },
            };
          }
          if (!slackContext) {
            // The same escalation a Slack turn would ask the user about. A task has
            // no approver wired: deny, explicitly.
            logger.warn('Escalation denied: a Slack-less task has no approver (#599)', {
              tool: toolName,
              user: policyUser,
              rule: result.reason,
            });
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason:
                  'This call needs approval, and a task without a Slack thread has no approver yet — it was not run.',
              },
            };
          }
          logger.warn('Auto-mode classifier escalating to Slack permission UI', {
            tool: toolName,
            user: policyUser,
            rule: result.reason,
            reason: verdict.reason,
          });
          // SSOT 2026-11-02 T2 — the prompt the SDK raises for this `ask` shows the
          // guardian's advice; null tells it the guardian gave none (no second call).
          permissionAdviceBoard.put(hookSessionKey, toolName, toolInput ?? {}, advice);
          return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' } };
        }
        case 'allow':
          return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } };
        default:
          // 'pass' → no policy opinion; defer to the SDK's own permission logic.
          return { continue: true };
      }
    };

    options.hooks = {
      ...options.hooks,
      // A planning turn's hook sees every tool (the incident session's one catch-all entry): step 6c
      // allow-lists research, so a tool outside TOOL_POLICY_MATCHERS (Monitor, Workflow, …) is refused
      // instead of running unhooked under bypassPermissions.
      PreToolUse: (planPending ? INCIDENT_TOOL_POLICY_MATCHERS : TOOL_POLICY_MATCHERS).map((matcher) => ({
        ...(matcher === undefined ? {} : { matcher }),
        hooks: [policyHook],
        // A task's escalation may wait for the dashboard approval (#599 ⑤).
        ...(taskApprover ? { timeout: TASK_APPROVAL_HOOK_TIMEOUT_S } : {}),
      })),
    };

    // Compaction Tracking (#617): register PreCompact / PostCompact /
    // SessionStart hooks so we can post thread-visible start/end messages
    // and rebuild preservation context after SDK-driven compaction. When
    // the builder hasn't been wired (tests, non-Slack callers) this is a
    // no-op and compaction falls back to the stream-executor `compacting`
    // signal path.
    if (deps.compactHookBuilder && session && slackContext?.threadTs) {
      const compactHooks = deps.compactHookBuilder({
        session,
        channel: slackContext.channel,
        threadTs: slackContext.threadTs,
      });
      options.hooks = {
        ...options.hooks,
        PreCompact: [{ hooks: [compactHooks.PreCompact] }],
        PostCompact: [{ hooks: [compactHooks.PostCompact] }],
        SessionStart: [{ hooks: [compactHooks.SessionStart] }],
      };
    }
  }

  // Set model from session or user's default model
  if (session?.model) {
    options.model = session.model;
    logger.debug('Using session model', { model: session.model });
  } else if (contextUser) {
    const userModel = userSettingsStore.getUserDefaultModel(contextUser);
    options.model = userModel;
    logger.debug('Using user default model', { model: userModel, user: contextUser });
  }

  // Context-window env, driven by the canonical model profile
  // (`metrics/model-profile.ts` — the single resolver for window / blocking
  // limit / auto-compact trigger, so those three can no longer disagree. The
  // regex ladder that used to live here handed a `gpt-5.6-sol[1m]` session the
  // BARE model's 349k blocking limit while model-registry advertised 1M).
  //
  // Automatic compaction has ONE authority: the harness turn-end scheduler
  // (`session/compact-threshold-checker.ts#checkAndSchedulePendingCompact`),
  // which sizes every model from `resolveModelProfile` (ruling 2026-08-26).
  // The SDK's own automatic compaction is therefore switched off:
  //
  //   • DISABLE_AUTO_COMPACT=1 — read by the pinned SDK's `z0()` gate
  //     (cli.js: `if(S6(process.env.DISABLE_AUTO_COMPACT))return!1`), which
  //     guards the whole autocompact path. The `/compact` command itself stays
  //     enabled (only DISABLE_COMPACT would remove it), so the scheduler's
  //     next-turn `/compact` interception keeps working.
  //   • CLAUDE_CODE_AUTO_COMPACT_WINDOW is NEVER injected. It cannot be a
  //     second authority: `Jn()` clamps it with `Math.min(ff(model), value)`
  //     and `ff()` returns `WR1` = 200,000 for every id the pinned SDK does
  //     not know — so a declared 750k trigger on `claude-fable-5[1m]` would
  //     still fire at ~167k, the exact premature compaction this work exists
  //     to remove.
  //   • CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE — the SDK's own formula on the
  //     profile's TRUE window (window − 20k output reserve − 3k safety),
  //     injected for EVERY model. There is no "does the SDK know this id?"
  //     classifier: where it does (bare claude ids, the generic `[1m]`
  //     opt-in) the value equals what it would have computed itself, and
  //     where it does not (native-1M claude, the llmux codex family,
  //     non-claude catalog models) it replaces the ~177k hard block. One rule
  //     beats a tier nobody can keep in sync with the pinned CLI.
  //
  // Operator-provided values (process env / config.json#claude.env) win — we
  // only fill keys that are unset, so an operator can hand SDK-native
  // compaction back by setting `DISABLE_AUTO_COMPACT=0` themselves.
  if (options.model) {
    const profile = resolveModelProfile(options.model);
    if (!options.env) options.env = {};
    const env = options.env;
    const wrote: string[] = [];
    if (env.DISABLE_AUTO_COMPACT === undefined) {
      env.DISABLE_AUTO_COMPACT = '1';
      wrote.push('DISABLE_AUTO_COMPACT');
    }
    if (env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE === undefined) {
      env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE = String(profile.sdkBlockingLimit);
      wrote.push('CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE');
    }
    // Report the WRITE, not the visit: when the operator already set both keys
    // this block changed nothing, and an "Injected …" line every turn would be
    // a lie printed at one line per query.
    if (wrote.length > 0) {
      logger.info('Injected SDK context-window env from model profile', {
        model: options.model,
        contextWindow: profile.contextWindow,
        wrote,
        disableAutoCompact: env.DISABLE_AUTO_COMPACT,
        blockingLimitOverride: env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE,
      });
    }
  }

  // Per-call usage for non-claude models (sol[1m] context miscalculation,
  // 2026-10-27). llmux's codex / grok providers send `message_start.usage =
  // {0, 0}` and report each call's usage on `message_delta` only, and the
  // pinned SDK copies `message_start` usage onto every assistant frame — so
  // without partial messages the harness never sees a per-call reading and
  // falls back to the turn's billing aggregate (every call summed) as the
  // current context. The mapper reads the `message_delta` usage off these
  // frames (`sdk-message-to-event.ts#mapStreamEvent`). Claude streams carry
  // the reading on `message_start` already, so they skip the extra frames.
  if (options.model && needsStreamedCallUsage(options.model)) {
    options.includePartialMessages = true;
  }

  // Set effort level only when explicitly configured. The value is clamped
  // to the model's llmux-catalog effort menu (e.g. grok-4.5 has no
  // xhigh/max → clamp to high) — the SAVED session/user effort is never
  // mutated, only this per-query option.
  if (session?.effort) {
    const clamped = options.model ? clampEffortToModel(options.model, session.effort) : session.effort;
    // `ultra` (kept only on the codex tiers whose catalog menu lists it) is not
    // an SDK/CLI `--effort` value, and no backend takes it on the wire: the
    // codex backend's strongest level is `max` (it 400s 'ultra', probed
    // 2026-11-02 — llmux #228 maps it the same way) and Claude models 400 it
    // too. It runs as `max`. Not through CLAUDE_CODE_EXTRA_BODY: that body
    // rides every request of the CLI process — a Claude subagent or the CLI's
    // own small-model calls would carry `ultra` and be refused.
    options.effort = (isSdkEffortLevel(clamped) ? clamped : 'max') as typeof options.effort;
    if (clamped !== session.effort) {
      logger.debug('Clamped session effort to model catalog menu', {
        model: options.model,
        requested: session.effort,
        effort: clamped,
      });
    } else {
      logger.debug('Using session effort', { effort: session.effort });
    }
  }

  // Set thinking config (adaptive reasoning toggle).
  // See `buildThinkingOption` JSDoc for why we explicitly opt into 'summarized'.
  {
    const thinkingEnabled =
      session?.thinkingEnabled ??
      (contextUser ? userSettingsStore.getUserThinkingEnabled(contextUser) : DEFAULT_THINKING_ENABLED);
    if (!thinkingEnabled) {
      options.thinking = buildThinkingOption(false);
      logger.debug('Thinking disabled for session');
    } else {
      const userShowThinking = contextUser ? userSettingsStore.getUserShowThinking(contextUser) : undefined;
      const showSummary = resolveShowSummary(session?.showThinking, userShowThinking);
      options.thinking = buildThinkingOption(true, showSummary);
      logger.debug('Thinking adaptive', { display: showSummary ? 'summarized' : 'omitted' });
    }
  }
  // Sandbox: enabled by default for all users. Only admin-toggled
  // `sandboxDisabled` (resolved above, with the write roots) skips it. When
  // sandbox is active, a dev-domain allowlist (`DEV_DOMAIN_ALLOWLIST`) is
  // applied to the network unless the user has set `networkDisabled=true`, in
  // which case every outbound domain is blocked by the SDK default.
  //
  // Applies from the NEXT user turn \u2014 SDK sandbox config is captured at
  // `query()` init and OS-enforced (Seatbelt on macOS, bubblewrap on
  // Linux), so in-flight queries keep the previous policy.
  if (!sandboxDisabled) {
    const sandboxConfig: NonNullable<Options['sandbox']> = {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      // A task turn run by someone other than its owner never runs unsandboxed: its cross-user Bash check
      // holds to the owner's root, so the OS sandbox is what keeps its writes to the task folder (SSOT 2026-11-02).
      failIfUnavailable: isOtherUsersTaskTurn,
      allowUnsandboxedCommands: false,
    };
    // Mount only the user's /tmp/{userId} directory for writes.
    if (sandboxUserDir) {
      sandboxConfig.filesystem = { allowWrite: [sandboxUserDir] };
    }
    // Plan mode writes its plan file with the native Write tool, by default
    // to ~/.claude/plans — outside the write boundary of a non-admin. Keep
    // the plans inside the working directory (the SDK requires a path within
    // the project root).
    if (contextUser && !isAdminUser(contextUser)) {
      options.settings = { plansDirectory: '.claude/plans' };
    }
    const networkDisabled = contextUser ? userSettingsStore.getUserNetworkDisabled(contextUser) : false;
    if (!networkDisabled) {
      sandboxConfig.network = { allowedDomains: [...DEV_DOMAIN_ALLOWLIST] };
    }
    // Deploy-workflow grant (`config.json#deploySandbox`, written per runner
    // by the fleet deploy): post-deploy QA, run in the requester's deploy
    // session, needs a few host directories and the QA environment's
    // hostnames. BOTH the turn's sender and the session owner must be listed
    // (one person when they are the same): someone else replying in the
    // thread runs without it, and so does a listed sender's turn in a session
    // an unlisted user owns — the owner may steer messages into a running
    // turn (`SessionRegistry.canInterrupt`), which would otherwise run them
    // under the grant. Domains only extend an active allowlist;
    // `networkDisabled` keeps every domain blocked.
    if (session?.workflow === 'deploy' && session.ownerId && contextUser) {
      const owner = session.ownerId;
      const grant = loadDeploySandboxGrant(CONFIG_FILE, logger);
      if (grant?.users.includes(contextUser) && grant.users.includes(owner)) {
        const added = extendSandboxWithGrant(sandboxConfig, grant, { network: !networkDisabled });
        if (added.paths + added.domains > 0) {
          // Counts only: the values are host topology.
          logger.info('Deploy sandbox grant applied', added);
        }
      }
    }
    // Environment plugins: a non-admin's Bash must not read them by any spelling (relative paths,
    // wildcards, symbolic links — what step 6b's text check cannot see). OS-enforced read deny
    // of their directories, unless the all-environment-skills grant opens them.
    if (contextUser && !isAdminUser(contextUser)) {
      const envRegistry = deps.getEnvSkillRegistry?.();
      const denyRead = envRegistry ? envSkillSandboxDenyRead(envRegistry, contextUser) : [];
      if (denyRead.length > 0) {
        sandboxConfig.filesystem = {
          ...(sandboxConfig.filesystem ?? {}),
          denyRead: [...(sandboxConfig.filesystem?.denyRead ?? []), ...denyRead],
        };
      }
    }
    options.sandbox = sandboxConfig;
    logger.debug('Sandbox enabled', {
      user: contextUser,
      network: networkDisabled ? 'off' : 'on',
      domains: sandboxConfig.network?.allowedDomains?.length ?? 0,
    });
  } else {
    logger.info('Sandbox disabled by admin setting', { user: contextUser });
  }

  // Build system prompt with persona and workflow.
  // Rebuild gate (PLAN.md §2) — the prompt is expensive to rebuild (reads
  // files, formats memory, etc.) and every rebuild is a prompt-cache
  // miss. So we rebuild only at the three reset points
  //   (a) first turn           — `!session.sessionId`
  //   (b) post-compact         — `session.compactionOccurred === true`
  //   (c) no cached snapshot   — `!session.systemPrompt`
  // SSOT mutators (InstructionConfirmActionHandler.handleYes,
  // regenerateInstructionsSummaryIfStale) clear `session.systemPrompt`
  // on change so the next turn lands on branch (c) and rebuilds.
  const workflow = session?.workflow || 'default';
  const promptUserId = session?.ownerId || contextUser;
  const shouldRebuild = !session || !session.systemPrompt || session.compactionOccurred === true || !session.sessionId;

  // The channel's context: a Slack turn's from its Slack context; a task
  // turn's from the snapshot stored with the task (E2 ② — the same blocks,
  // byte for byte, and still no Slack context on a task turn).
  const channelContext = execCtx?.origin === 'task' ? session?.inputContext : slackContext;

  let builtSystemPrompt: string | undefined;
  if (shouldRebuild) {
    builtSystemPrompt = deps.promptBuilder.buildSystemPrompt(promptUserId, workflow, session);

    // Inject channel description as additional context
    if (builtSystemPrompt && channelContext?.channelDescription) {
      builtSystemPrompt = `${builtSystemPrompt}\n\n<channel-description source="slack">\n${channelContext.channelDescription}\n</channel-description>`;
    }

    // Inject structured repository context from channel registry.
    // This provides explicit repo identification so the model doesn't
    // have to guess from raw description.
    const hasRepos = channelContext?.repos && channelContext.repos.length > 0;
    const hasConfluence = !!channelContext?.confluenceUrl;
    if (builtSystemPrompt && (hasRepos || hasConfluence)) {
      builtSystemPrompt = `${builtSystemPrompt}\n\n${buildRepoContextBlock(channelContext!.repos || [], channelContext!.confluenceUrl)}`;
    }

    // Cache the freshly-built prompt on the session so subsequent turns
    // skip the rebuild until the next reset / SSOT change.
    if (session) {
      session.systemPrompt = builtSystemPrompt || undefined;
    }
  } else {
    // Reuse the cached snapshot. Skip channel / repo injection —
    // they were baked in at build time and don't change across turns
    // within the same logical session.
    builtSystemPrompt = session!.systemPrompt;
  }
  if (builtSystemPrompt) {
    options.systemPrompt = builtSystemPrompt;
    logger.info(`\uD83D\uDE80 STARTING QUERY with workflow: [${workflow}]`, {
      workflow,
      sessionId: session?.sessionId,
      model: options.model,
      promptLength: builtSystemPrompt.length,
      hasChannelDescription: !!channelContext?.channelDescription,
      repos: channelContext?.repos || [],
    });
  } else {
    logger.warn(`\uD83D\uDE80 STARTING QUERY with NO system prompt (workflow: [${workflow}])`);
  }

  // Set working directory \u2014 ensure it exists to prevent ENOENT on spawn
  if (workingDirectory) {
    if (execCtx?.origin === 'task') {
      // A task's directory exists before its turn (the run entry point makes it):
      // nothing is created here, so no recursive mkdir can follow a link out (#613 R3).
      if (!fs.existsSync(workingDirectory)) {
        throw new ExecutionContextMissingError('task working directory does not exist');
      }
    } else if (!fs.existsSync(workingDirectory)) {
      logger.warn('Working directory does not exist, recreating', { workingDirectory });
      try {
        fs.mkdirSync(workingDirectory, { recursive: true });
      } catch (mkdirErr) {
        logger.error('Failed to recreate working directory', { workingDirectory, error: mkdirErr });
      }
    }
    if (fs.existsSync(workingDirectory)) {
      // Right before the SDK child gets it: a task's directory must still be where its context put it.
      if (execCtx?.origin === 'task') revalidateTaskDirectory(execCtx);
      options.cwd = workingDirectory;
    } else if (execCtx?.origin === 'task') {
      // A task runs in its validated directory or not at all — never in the
      // server's directory, which an unset cwd would hand the SDK child (#613 R2).
      throw new ExecutionContextMissingError('task working directory cannot be created');
    }

    // Expand SDK's allowed directory scope to user's root /tmp/{userId} directory.
    // Without this, sibling directories (e.g., /tmp/{userId}/soma-work_xxx/) trigger
    // permission prompts even in bypass mode, because SDK treats only cwd as allowed.
    if (contextUser && isSafePathSegment(contextUser)) {
      const userRootDir = normalizeTmpPath(path.join('/tmp', contextUser));
      options.additionalDirectories = [...(options.additionalDirectories || []), userRootDir];
    }
  }

  // Resume existing session
  if (session?.sessionId) {
    options.resume = session.sessionId;
    logger.debug('Resuming session', { sessionId: session.sessionId });
  } else {
    logger.debug('Starting new Claude conversation');
  }

  // 1M context window is opt-in via the `[1m]` model-id suffix.
  // The Claude Agent SDK (≥ 0.2.111) detects the suffix, strips it before
  // the API call, and injects the `context-1m-2025-08-07` beta header
  // uniformly across API-key and OAuth auth — no runtime injection here.

  // Set abort controller
  if (abortController) {
    options.abortController = abortController;
  }

  return attachStderrCapture(options, logger);
}

/**
 * Capture Claude process stderr for debugging exit code 1 etc. Buffer every
 * chunk in `stderrBuffer` so rate-limit messages can be extracted on the error
 * path — `handleClaudeStderrChunk` is logging-policy only (it applies the
 * redaction/verbosity rules) and does NOT participate in buffering.
 *
 * Shared by both paths: an incident attempt spawns the same child process, so it
 * needs the same tracked spawner (abort must kill its children) and the same
 * stderr policy. Nothing here touches evidence or the auth env — the buffer
 * carries the child's stderr only.
 */
function attachStderrCapture(options: Options, logger: BuildStreamOptionsDeps['logger']): BuildStreamOptionsResult {
  let stderrBuffer = '';
  options.stderr = (data: string) => {
    stderrBuffer += data;
    handleClaudeStderrChunk(logger, data);
  };
  options.spawnClaudeCodeProcess = createTrackedClaudeProcessSpawner(options.stderr);

  return {
    options,
    getStderrBuffer: () => stderrBuffer,
  };
}

/**
 * Read the incident request off the session, structurally (the ingress unit owns
 * `types.ts`).
 *
 * **Absent is the only answer that means "ordinary session".** Anything present
 * must be a complete v1 request or the build throws: `session-registry.ts:2202`
 * restores `incidentRequest` verbatim for any non-null object — "any present
 * value keeps the session restricted (fail closed)" — so a truncated write or a
 * hand-edited sessions file really can present `{}` here. Answering "not an
 * incident" for that value would assemble the ORDINARY options (project
 * settings, plugins, skills, every MCP server, Bash) for a thread the handler
 * still treats as incident-owned and nobody is watching.
 */
function readIncidentRequest(session: ConversationSession | undefined): IncidentRequestLike | undefined {
  const candidate = (session as { incidentRequest?: unknown } | undefined)?.incidentRequest;
  if (candidate === undefined) return undefined;
  return assertIncidentRequest(candidate);
}
