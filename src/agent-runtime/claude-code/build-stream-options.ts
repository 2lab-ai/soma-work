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
import type { ModelCommandContext } from 'somalib/model-commands/types';
import { isAdminUser } from '../../admin-utils';
import {
  buildRepoContextBlock,
  buildThinkingOption,
  type CompactHookBuilder,
  handleClaudeStderrChunk,
  resolveShowSummary,
} from '../../claude-handler';
import { CONFIG_FILE } from '../../env-paths';
import type { McpConfig, SlackContext } from '../../mcp-config-builder';
import { getPermissionGatedServers, loadMcpToolPermissions } from '../../mcp-tool-permission-config';
import { isNativeOneMModel, NATIVE_ONE_M_SDK_BLOCKING_LIMIT } from '../../metrics/model-registry';
import { isSafePathSegment, normalizeTmpPath } from '../../path-utils';
import type { SdkPluginPath } from '../../plugin/types';
import { DEV_DOMAIN_ALLOWLIST } from '../../sandbox/dev-domain-allowlist';
import type { SessionRegistry } from '../../session-registry';
import type { ConversationSession, WorkflowType } from '../../types';
import { DEFAULT_THINKING_ENABLED, userSettingsStore } from '../../user-settings-store';
import { evaluateToolPolicy, TOOL_POLICY_MATCHERS, type ToolPolicyContext } from '../policy/tool-policy';

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
    buildConfig(slackContext: SlackContext | undefined, ctx: ModelCommandContext | undefined): Promise<McpConfig>;
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
}

export interface BuildStreamOptionsInput {
  queryEnv: Record<string, string | undefined>;
  session?: ConversationSession;
  abortController?: AbortController;
  workingDirectory?: string;
  slackContext?: SlackContext;
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
  const { queryEnv, session, abortController, workingDirectory, slackContext } = input;
  const { logger } = deps;

  const options: Options = {
    // Load settings from filesystem for backward compatibility (Agent SDK v0.1.0 breaking change)
    settingSources: ['project'],
    // Load plugins from PluginManager or fallback to local directory
    plugins: deps.getEffectivePluginPaths(),
    env: queryEnv,
  };

  // Get MCP configuration
  const modelCommandContext = deps.buildModelCommandContext(session, slackContext);
  const mcpConfig = await deps.mcpConfigBuilder.buildConfig(slackContext, modelCommandContext);
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
  }

  // PreToolUse hooks
  if (slackContext) {
    // PreToolUse: a single unified policy hook (epic #1023 P5). All tool guards
    // — abort, ssh-ban, sensitive-path, cross-user, MCP grant, PR-issue
    // precondition, bypass-mode allow/ask — collapse into `evaluateToolPolicy`,
    // whose deny>ask>allow precedence reproduces the prior multi-hook SDK merge
    // exactly (deny from any guard wins over the bypass allow; dangerous-Bash
    // escalates to ask). Live state (abort signal, handoff context) is resolved
    // per call so mid-session aborts and handoff changes are honored.
    const policyUser = slackContext.user;
    const policyIsAdmin = isAdminUser(slackContext.user);
    const cachedPermConfig = CONFIG_FILE ? loadMcpToolPermissions(CONFIG_FILE) : {};
    const gatedServerNames = getPermissionGatedServers(cachedPermConfig);
    const hookSessionKey = deps.sessionRegistry.getSessionKey(slackContext.channel, slackContext.threadTs);

    const policyHook = async (input: HookInput): Promise<HookJSONOutput> => {
      const toolName = (input as { tool_name?: string }).tool_name || '';
      const toolInput = (input as { tool_input?: Record<string, unknown> }).tool_input;
      const ctx: ToolPolicyContext = {
        user: policyUser,
        isAdmin: policyIsAdmin,
        userBypass: mcpConfig.userBypass,
        aborted: abortController?.signal.aborted ?? false,
        isDangerousRuleDisabled: (ruleId) => deps.sessionRegistry.isDangerousRuleDisabled(hookSessionKey, ruleId),
        handoffContext: deps.sessionRegistry.getSession(slackContext.channel, slackContext.threadTs)?.handoffContext,
        checkMcpToolPermission: (name) =>
          gatedServerNames.length > 0
            ? (deps.checkMcpToolPermission(name, policyUser, cachedPermConfig, gatedServerNames) ?? null)
            : null,
      };

      const result = evaluateToolPolicy(toolName, toolInput, ctx);
      switch (result.decision) {
        case 'deny':
          logger.warn('Tool policy denied call', { tool: toolName, user: policyUser, reason: result.reason });
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              ...(result.denyMessage ? { permissionDecisionReason: result.denyMessage } : {}),
            },
          };
        case 'ask':
          logger.warn('Tool policy escalating to Slack permission UI', {
            tool: toolName,
            user: policyUser,
            reason: result.reason,
          });
          return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' } };
        case 'allow':
          return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } };
        default:
          // 'pass' → no policy opinion; defer to the SDK's own permission logic.
          return { continue: true };
      }
    };

    options.hooks = {
      ...options.hooks,
      PreToolUse: TOOL_POLICY_MATCHERS.map((matcher) => ({ matcher, hooks: [policyHook] })),
    };

    // Compaction Tracking (#617): register PreCompact / PostCompact /
    // SessionStart hooks so we can post thread-visible start/end messages
    // and rebuild preservation context after SDK-driven compaction. When
    // the builder hasn't been wired (tests, non-Slack callers) this is a
    // no-op and compaction falls back to the stream-executor `compacting`
    // signal path.
    if (deps.compactHookBuilder && session && slackContext.threadTs) {
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
  } else if (slackContext?.user) {
    const userModel = userSettingsStore.getUserDefaultModel(slackContext.user);
    options.model = userModel;
    logger.debug('Using user default model', { model: userModel, user: slackContext.user });
  }

  // Native-1M SDK context-window workaround.
  //
  // The pinned Agent SDK (0.2.111, CLI bundled pre fable-5) does not know
  // native-1M model ids: its internal window resolver only honors the `[1m]`
  // suffix / 1M beta header / a sonnet-4-6 experiment, and falls back to 200k
  // for everything else — including `claude-fable-5`. Observed consequence:
  // SDK-side autocompact fired at 200k − 33k = 167k while the thread showed
  // "17% (167k/1.0M)", and the SDK would hard-block input at ~177k. The
  // harness itself resolves these models to 1M correctly (model-registry
  // NATIVE_ONE_M_RE), so only the SDK's internal math needs correcting:
  //
  //   • DISABLE_AUTO_COMPACT=1 — kill the SDK's 200k-calibrated autocompact.
  //     Compaction is still driven by the turn-end threshold checker (#617,
  //     % of the true 1M window → next turn becomes `/compact`); the
  //     `/compact` command itself stays enabled (only DISABLE_COMPACT would
  //     remove it). CLAUDE_CODE_AUTO_COMPACT_WINDOW is NOT usable here — the
  //     SDK caps it at its own (wrong) model window.
  //   • CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE — lift the SDK's input
  //     hard-block to the 1M equivalent of its own formula (977k), so long
  //     sessions don't get refused at ~177k.
  //
  // Operator-provided values (process env / config.json#claude.env) win — we
  // only fill keys that are unset. Remove this block once the pinned SDK CLI
  // resolves fable-5 to 1M natively.
  if (options.model && isNativeOneMModel(options.model)) {
    if (!options.env) options.env = {};
    const env = options.env;
    if (env.DISABLE_AUTO_COMPACT === undefined) {
      env.DISABLE_AUTO_COMPACT = '1';
    }
    if (env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE === undefined) {
      env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE = String(NATIVE_ONE_M_SDK_BLOCKING_LIMIT);
    }
    logger.info('Native-1M model: injected SDK context-window workaround env', {
      model: options.model,
      disableAutoCompact: env.DISABLE_AUTO_COMPACT,
      blockingLimitOverride: env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE,
    });
  }

  // Set effort level only when explicitly configured
  if (session?.effort) {
    options.effort = session.effort;
    logger.debug('Using session effort', { effort: session.effort });
  }

  // Set thinking config (adaptive reasoning toggle).
  // See `buildThinkingOption` JSDoc for why we explicitly opt into 'summarized'.
  {
    const thinkingEnabled =
      session?.thinkingEnabled ??
      (slackContext?.user ? userSettingsStore.getUserThinkingEnabled(slackContext.user) : DEFAULT_THINKING_ENABLED);
    if (!thinkingEnabled) {
      options.thinking = buildThinkingOption(false);
      logger.debug('Thinking disabled for session');
    } else {
      const userShowThinking = slackContext?.user
        ? userSettingsStore.getUserShowThinking(slackContext.user)
        : undefined;
      const showSummary = resolveShowSummary(session?.showThinking, userShowThinking);
      options.thinking = buildThinkingOption(true, showSummary);
      logger.debug('Thinking adaptive', { display: showSummary ? 'summarized' : 'omitted' });
    }
  }

  // Sandbox: enabled by default for all users. Only admin-toggled
  // `sandboxDisabled` skips it. When sandbox is active, a dev-domain
  // allowlist (`DEV_DOMAIN_ALLOWLIST`) is applied to the network unless the
  // user has set `networkDisabled=true`, in which case every outbound
  // domain is blocked by the SDK default.
  //
  // Applies from the NEXT user turn \u2014 SDK sandbox config is captured at
  // `query()` init and OS-enforced (Seatbelt on macOS, bubblewrap on
  // Linux), so in-flight queries keep the previous policy.
  {
    const sandboxDisabled = slackContext?.user ? userSettingsStore.getUserSandboxDisabled(slackContext.user) : false;
    if (!sandboxDisabled) {
      const sandboxConfig: NonNullable<Options['sandbox']> = {
        enabled: true,
        autoAllowBashIfSandboxed: true,
        failIfUnavailable: false,
        allowUnsandboxedCommands: false,
      };
      // Mount only the user's /tmp/{userId} directory for writes.
      if (slackContext?.user && isSafePathSegment(slackContext.user)) {
        const userDir = normalizeTmpPath(path.join('/tmp', slackContext.user));
        sandboxConfig.filesystem = { allowWrite: [userDir] };
      }
      const networkDisabled = slackContext?.user ? userSettingsStore.getUserNetworkDisabled(slackContext.user) : false;
      if (!networkDisabled) {
        sandboxConfig.network = { allowedDomains: [...DEV_DOMAIN_ALLOWLIST] };
      }
      options.sandbox = sandboxConfig;
      logger.debug('Sandbox enabled', {
        user: slackContext?.user,
        network: networkDisabled ? 'off' : 'on',
        domains: networkDisabled ? 0 : DEV_DOMAIN_ALLOWLIST.length,
      });
    } else {
      logger.info('Sandbox disabled by admin setting', { user: slackContext?.user });
    }
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
  const promptUserId = session?.ownerId || slackContext?.user;
  const shouldRebuild = !session || !session.systemPrompt || session.compactionOccurred === true || !session.sessionId;

  let builtSystemPrompt: string | undefined;
  if (shouldRebuild) {
    builtSystemPrompt = deps.promptBuilder.buildSystemPrompt(promptUserId, workflow, session);

    // Inject channel description as additional context
    if (builtSystemPrompt && slackContext?.channelDescription) {
      builtSystemPrompt = `${builtSystemPrompt}\n\n<channel-description source="slack">\n${slackContext.channelDescription}\n</channel-description>`;
    }

    // Inject structured repository context from channel registry.
    // This provides explicit repo identification so the model doesn't
    // have to guess from raw description.
    const hasRepos = slackContext?.repos && slackContext.repos.length > 0;
    const hasConfluence = !!slackContext?.confluenceUrl;
    if (builtSystemPrompt && (hasRepos || hasConfluence)) {
      builtSystemPrompt = `${builtSystemPrompt}\n\n${buildRepoContextBlock(slackContext!.repos || [], slackContext!.confluenceUrl)}`;
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
      hasChannelDescription: !!slackContext?.channelDescription,
      repos: slackContext?.repos || [],
    });
  } else {
    logger.warn(`\uD83D\uDE80 STARTING QUERY with NO system prompt (workflow: [${workflow}])`);
  }

  // Set working directory \u2014 ensure it exists to prevent ENOENT on spawn
  if (workingDirectory) {
    if (!fs.existsSync(workingDirectory)) {
      logger.warn('Working directory does not exist, recreating', { workingDirectory });
      try {
        fs.mkdirSync(workingDirectory, { recursive: true });
      } catch (mkdirErr) {
        logger.error('Failed to recreate working directory', { workingDirectory, error: mkdirErr });
      }
    }
    if (fs.existsSync(workingDirectory)) {
      options.cwd = workingDirectory;
    }

    // Expand SDK's allowed directory scope to user's root /tmp/{userId} directory.
    // Without this, sibling directories (e.g., /tmp/{userId}/soma-work_xxx/) trigger
    // permission prompts even in bypass mode, because SDK treats only cwd as allowed.
    if (slackContext?.user && isSafePathSegment(slackContext.user)) {
      const userRootDir = normalizeTmpPath(path.join('/tmp', slackContext.user));
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

  // Capture Claude process stderr for debugging exit code 1 etc. Buffer
  // every chunk in `stderrBuffer` so rate-limit messages can be extracted
  // on the error path — `handleClaudeStderrChunk` is logging-policy only
  // and does NOT participate in buffering.
  let stderrBuffer = '';
  options.stderr = (data: string) => {
    stderrBuffer += data;
    handleClaudeStderrChunk(logger, data);
  };

  return {
    options,
    getStderrBuffer: () => stderrBuffer,
  };
}
