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
import { bypassBashPermissionDecision, isCrossUserAccess, isSshCommand } from '../../dangerous-command-filter';
import { CONFIG_FILE } from '../../env-paths';
import { buildBypassPermissionHookEntry } from '../../hooks/bypass-permission-guard';
import { buildPrIssueHookEntries } from '../../hooks/pr-issue-guard';
import type { McpConfig, SlackContext } from '../../mcp-config-builder';
import { getPermissionGatedServers, loadMcpToolPermissions } from '../../mcp-tool-permission-config';
import { isSafePathSegment, normalizeTmpPath } from '../../path-utils';
import type { SdkPluginPath } from '../../plugin/types';
import { DEV_DOMAIN_ALLOWLIST } from '../../sandbox/dev-domain-allowlist';
import {
  checkBashSensitivePaths,
  checkSensitiveGlob,
  checkSensitivePath,
  type SensitivePathResult,
} from '../../sensitive-path-filter';
import type { SessionRegistry } from '../../session-registry';
import type { ConversationSession, WorkflowType } from '../../types';
import { DEFAULT_THINKING_ENABLED, userSettingsStore } from '../../user-settings-store';

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
    const preToolUseHooks: Array<{ matcher: string; hooks: Array<(input: HookInput) => Promise<HookJSONOutput>> }> = [];

    // Abort guard: deny all tool calls after session abort to prevent SDK fire-and-forget writes
    if (abortController) {
      preToolUseHooks.push({
        matcher: 'Bash',
        hooks: [
          async (): Promise<HookJSONOutput> => {
            if (abortController.signal.aborted) {
              return {
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse',
                  permissionDecision: 'deny',
                },
              };
            }
            return { continue: true };
          },
        ],
      });
    }

    // SSH command restriction: only admin users may execute SSH commands via Bash.
    // Non-admin users must use the server-tools MCP (which has its own permission gating).
    if (!isAdminUser(slackContext.user)) {
      preToolUseHooks.push({
        matcher: 'Bash',
        hooks: [
          async (input: HookInput): Promise<HookJSONOutput> => {
            const { tool_input } = input as { tool_input: unknown };
            const toolRecord = tool_input as Record<string, unknown> | undefined;
            const command = typeof toolRecord?.command === 'string' ? toolRecord.command : '';

            if (isSshCommand(command)) {
              logger.warn('SSH command denied for non-admin user', {
                command: command.substring(0, 100),
                user: slackContext.user,
              });
              return {
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse',
                  permissionDecision: 'deny',
                },
              };
            }

            return { continue: true };
          },
        ],
      });
    }

    // Sensitive path guard: block non-admin users from reading host secrets
    // via any Claude tool. Addresses sandbox read.denyOnly being empty.
    if (!isAdminUser(slackContext.user)) {
      const makeSensitiveHook =
        (
          check: (r: Record<string, unknown>) => SensitivePathResult,
          logCtx: (r: Record<string, unknown>) => Record<string, unknown>,
        ) =>
        async (input: HookInput): Promise<HookJSONOutput> => {
          const toolRecord = ((input as { tool_input: unknown }).tool_input as Record<string, unknown>) ?? {};
          const result = check(toolRecord);
          if (result.isSensitive) {
            logger.warn('Sensitive path access denied', {
              user: slackContext.user,
              reason: result.reason,
              ...logCtx(toolRecord),
            });
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
              },
            };
          }
          return { continue: true };
        };

      preToolUseHooks.push(
        {
          matcher: 'Bash',
          hooks: [
            makeSensitiveHook(
              (r) => checkBashSensitivePaths(String(r.command ?? '')),
              (r) => ({ command: String(r.command ?? '').substring(0, 100) }),
            ),
          ],
        },
        {
          matcher: 'Read',
          hooks: [
            makeSensitiveHook(
              (r) => checkSensitivePath(String(r.file_path ?? '')),
              (r) => ({ file: String(r.file_path ?? '') }),
            ),
          ],
        },
        {
          matcher: 'Glob',
          hooks: [
            makeSensitiveHook(
              (r) => checkSensitiveGlob(String(r.pattern ?? ''), typeof r.path === 'string' ? r.path : undefined),
              (r) => ({ pattern: String(r.pattern ?? ''), path: r.path }),
            ),
          ],
        },
        {
          matcher: 'Grep',
          hooks: [
            makeSensitiveHook(
              (r) => (typeof r.path === 'string' && r.path ? checkSensitivePath(r.path) : { isSensitive: false }),
              (r) => ({ path: r.path }),
            ),
          ],
        },
      );
    }

    // Cross-user directory isolation: deny Bash commands that access another user's
    // /tmp/{userId}/ directory. Always enforced regardless of bypass mode.
    preToolUseHooks.push({
      matcher: 'Bash',
      hooks: [
        async (input: HookInput): Promise<HookJSONOutput> => {
          const { tool_input } = input as { tool_input: unknown };
          const toolRecord = tool_input as Record<string, unknown> | undefined;
          const command = typeof toolRecord?.command === 'string' ? toolRecord.command : '';

          if (isCrossUserAccess(command, slackContext.user)) {
            logger.warn('Cross-user directory access denied', {
              command: command.substring(0, 100),
              user: slackContext.user,
            });
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
              },
            };
          }

          return { continue: true };
        },
      ],
    });

    // Bypass mode Bash gate: explicitly approve non-dangerous commands, escalate dangerous ones.
    // CRITICAL: Return 'allow' instead of { continue: true } for non-dangerous commands.
    // When permissionPromptToolName is set (always in Slack context), { continue: true }
    // defers to SDK's permission check which routes through the permission MCP tool,
    // causing Slack permission prompts even in bypass mode. Explicit 'allow' makes the
    // decision at hook level, preventing SDK from invoking permissionPromptToolName.
    // See bypassBashPermissionDecision() for the extracted, testable decision logic.
    //
    // Session-scoped rule disable: when the user has previously clicked
    // "Approve & disable rule for this session" on a Slack permission prompt,
    // the matched rule id is stored on `session.disabledDangerousRules` via
    // SessionRegistry.disableDangerousRule(). The closure below passes a
    // lookup into bypassBashPermissionDecision so commands that match only
    // disabled rules degrade to 'allow' without prompting again.
    if (mcpConfig.userBypass) {
      const sessionRegistry = deps.sessionRegistry;
      const hookSessionKey = sessionRegistry.getSessionKey(slackContext.channel, slackContext.threadTs);

      preToolUseHooks.push({
        matcher: 'Bash',
        hooks: [
          async (input: HookInput): Promise<HookJSONOutput> => {
            const { tool_input } = input as { tool_input: unknown };
            const toolRecord = tool_input as Record<string, unknown> | undefined;
            const command = typeof toolRecord?.command === 'string' ? toolRecord.command : '';

            const { decision, matchedRuleIds } = bypassBashPermissionDecision(command, (ruleId) =>
              sessionRegistry.isDangerousRuleDisabled(hookSessionKey, ruleId),
            );

            if (decision === 'ask') {
              logger.warn('Dangerous command in bypass mode \u2014 escalating to Slack permission UI', {
                command: command.substring(0, 100),
                user: slackContext.user,
                matchedRuleIds,
              });
            } else if (matchedRuleIds.length === 0) {
              // Non-dangerous: normal bypass allow.
            } else {
              // Matched rules but all were session-disabled \u2014 log for audit.
              logger.info('Dangerous command auto-approved by session rule disable', {
                command: command.substring(0, 100),
                user: slackContext.user,
                sessionKey: hookSessionKey,
              });
            }

            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: decision,
              },
            };
          },
        ],
      });

      // Native non-Bash tools (Write/Edit/Read/etc.) need an explicit
      // 'allow' hook so the SDK does not route them through
      // `permissionPromptToolName` and pop a Slack UI. The covered set is
      // audited in `bypass-permission-guard.ts`. The SDK's hook output
      // merger still honors deny from other matchers (sensitive-path,
      // cross-user, ssh-ban, abort-guard) per the documented Claude Code
      // hook behavior, so this only changes the default outcome from
      // "fall through to prompt" to "explicit allow".
      preToolUseHooks.push(buildBypassPermissionHookEntry());
    }

    // MCP tool permission enforcement: deny calls to permission-gated MCP tools
    // when the user lacks an active grant. Catches mid-session grant expiry that
    // allowedTools (computed once at query start) cannot detect.
    // Trace: docs/current/plans/mcp-tool-permission/trace.md, S3/S5
    if (!isAdminUser(slackContext.user)) {
      // Cache permission config once per query \u2014 it's static deployment config,
      // unlike grants which must be re-checked from disk each call.
      const cachedPermConfig = CONFIG_FILE ? loadMcpToolPermissions(CONFIG_FILE) : {};
      const gatedServerNames = getPermissionGatedServers(cachedPermConfig);

      if (gatedServerNames.length > 0) {
        preToolUseHooks.push({
          matcher: 'mcp__',
          hooks: [
            async (input: HookInput): Promise<HookJSONOutput> => {
              const toolName = (input as { tool_name?: string }).tool_name || '';
              const denied = deps.checkMcpToolPermission(
                toolName,
                slackContext.user,
                cachedPermConfig,
                gatedServerNames,
              );
              if (denied) {
                logger.warn('MCP tool permission denied by PreToolUse hook', {
                  tool: toolName,
                  user: slackContext.user,
                  reason: denied,
                });
                return {
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    permissionDecision: 'deny',
                  },
                };
              }
              return { continue: true };
            },
          ],
        });
      }
    }

    // ── PR-issue precondition (#696) ──
    // For z-handoff sessions (session.handoffContext set), require a linked
    // source issue (or validated Case A escape) before allowing PR creation
    // via Bash `gh pr create` or `mcp__github__create_pull_request`. Sessions
    // without handoffContext are unaffected.
    //
    // SDK multi-hook precedence is `deny > allow` (verified cli.js:8208-8240
    // in @anthropic-ai/claude-agent-sdk@0.2.111), so this deny wins over the
    // bypass-mode Bash hook's allow regardless of array order.
    //
    // Spec / trace: docs/archive/features/pr-issue-precondition/{spec,trace}.md
    preToolUseHooks.push(
      ...buildPrIssueHookEntries({
        getHandoffContext: () =>
          deps.sessionRegistry.getSession(slackContext.channel, slackContext.threadTs)?.handoffContext,
        logger,
        logCtx: { channel: slackContext.channel, threadTs: slackContext.threadTs },
      }),
    );

    if (preToolUseHooks.length > 0) {
      options.hooks = {
        ...options.hooks,
        PreToolUse: preToolUseHooks,
      };
    }

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
