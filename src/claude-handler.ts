/**
 * ClaudeHandler - Manages Claude SDK queries
 * Refactored to use SessionRegistry, PromptBuilder, and McpConfigBuilder (Phase 5)
 */

import {
  type HookInput,
  type HookJSONOutput,
  type Options,
  query,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import * as fs from 'fs';
import * as path from 'path';
import { isAdminUser } from './admin-utils';
import { buildQueryEnv } from './auth/query-env-builder';
import {
  bypassBashPermissionDecision,
  isCrossUserAccess,
  isDangerousCommand,
  isSshCommand,
} from './dangerous-command-filter';
import { CONFIG_FILE } from './env-paths';
import { buildPrIssueHookEntries } from './hooks/pr-issue-guard';
import { Logger } from './logger';
import type { McpManager } from './mcp-manager';
import { mcpToolGrantStore } from './mcp-tool-grant-store';
import {
  getPermissionGatedServers,
  getRequiredLevel,
  levelSatisfies,
  loadMcpToolPermissions,
  resolveGatedTool,
} from './mcp-tool-permission-config';
import {
  hasOneMSuffix,
  isOneMContextUnavailableSignal,
  ONE_M_CONTEXT_UNAVAILABLE_CODE,
} from './metrics/model-registry';
import { isSafePathSegment, normalizeTmpPath } from './path-utils';
import type { SdkPluginPath } from './plugin/types';
import { DEV_DOMAIN_ALLOWLIST } from './sandbox/dev-domain-allowlist';
import {
  checkBashSensitivePaths,
  checkSensitiveGlob,
  checkSensitivePath,
  type SensitivePathResult,
} from './sensitive-path-filter';
import type {
  ActivityState,
  ConversationSession,
  SessionLink,
  SessionLinks,
  SessionResourceSnapshot,
  SessionResourceUpdateRequest,
  SessionResourceUpdateResult,
  WorkflowType,
} from './types';

// Fallback local plugins directory (used when no PluginManager is configured)
const LOCAL_PLUGINS_DIR = path.join(__dirname, 'local');

import type { ModelCommandContext } from 'somalib/model-commands/types';
import { sendCredentialAlert } from './credential-alert';
import {
  ensureActiveSlotAuth,
  getCredentialStatus,
  NoHealthySlotError,
  type SlotAuthLease,
} from './credentials-manager';
import { McpConfigBuilder, type SlackContext } from './mcp-config-builder';
import { getAvailablePersonas, PromptBuilder } from './prompt-builder';
import { type CrashRecoveredSession, SessionExpiryCallbacks, SessionRegistry } from './session-registry';
import { getTokenManager } from './token-manager';
import { DEFAULT_SHOW_THINKING, DEFAULT_THINKING_ENABLED, userSettingsStore } from './user-settings-store';

/** Heartbeat interval for long-running Claude CLI calls. */
const CLAUDE_LEASE_HEARTBEAT_MS = 5 * 60 * 1000;

// Re-export for backward compatibility
export { getAvailablePersonas, SessionExpiryCallbacks };

/**
 * Build the `thinking` option value for a query.
 *
 * Opus 4.7 API default is `display: 'omitted'` — we must explicitly opt in to
 * `'summarized'` to preserve Slack thinking-summary UX (stream-processor.ts:414
 * filters out empty thinking blocks).
 */
export function buildThinkingOption(
  thinkingEnabled: boolean,
  showSummary: boolean = false,
): NonNullable<Options['thinking']> {
  if (!thinkingEnabled) {
    return { type: 'disabled' };
  }
  return { type: 'adaptive', display: showSummary ? 'summarized' : 'omitted' };
}

/**
 * Resolve the effective `showSummary` value for a turn.
 *
 * Precedence matches the rest of the stack (see stream-executor.ts):
 *   session override → per-user default → DEFAULT_SHOW_THINKING.
 *
 * Extracted so that the session-level `%thinking_summary on|off` override is
 * honored when building the `thinking` option for the SDK.
 */
export function resolveShowSummary(
  sessionShowThinking: boolean | undefined,
  userShowThinking: boolean | undefined,
): boolean {
  return sessionShowThinking ?? userShowThinking ?? DEFAULT_SHOW_THINKING;
}

/**
 * Issue #661 — Convert SDK "1M context unavailable" error MESSAGES into a throw.
 *
 * The Claude Agent SDK (≥ 0.2.111) does NOT throw when the account lacks 1M
 * entitlement; it emits a regular `assistant` message with
 * `isApiErrorMessage: true` and a text block carrying one of three stable
 * signals (see `isOneMContextUnavailableSignal`). Downstream
 * `stream-executor.handleError` already knows how to auto-fallback in its
 * error path, so the simplest flow is: detect the message in the
 * `for-await` loop, convert it to a thrown Error with
 * `code = 'ONE_M_CONTEXT_UNAVAILABLE'` + `attemptedModel`, and let the
 * existing catch block re-throw it upward.
 *
 * Gate conditions (all must hold to throw):
 *   - `model` is defined AND has the `[1m]` suffix
 *   - message is an assistant message with `isApiErrorMessage: true`
 *   - extracted text matches `isOneMContextUnavailableSignal`
 *
 * Without the `[1m]` suffix gate, a bare-model API error containing the same
 * text (extremely rare, but possible if the user manually passes a 1m header)
 * would be misrouted into the fallback branch — see test case 2 below.
 *
 * Exported for direct unit testing (streamQuery's credential/MCP setup makes
 * end-to-end mocking impractical). streamQuery's hot path is:
 *   ```
 *   for await (const message of query(...)) {
 *     maybeThrowOneMUnavailable(message, options.model);
 *     // ... normal handling ...
 *     yield message;
 *   }
 *   ```
 */
export function maybeThrowOneMUnavailable(message: SDKMessage, model: string | undefined): void {
  if (!model || !hasOneMSuffix(model)) return;
  if (message.type !== 'assistant') return;
  // `isApiErrorMessage` is an optional runtime flag on the SDK assistant
  // message — not in the SDKMessage TS type. Cast once.
  const msg = message as unknown as { isApiErrorMessage?: boolean; message?: { content?: unknown[] } };
  if (msg.isApiErrorMessage !== true) return;

  const content = Array.isArray(msg.message?.content) ? msg.message!.content : [];
  const text = content
    .filter((c): c is { type: string; text?: unknown } => !!c && typeof c === 'object' && (c as any).type === 'text')
    .map((c) => String(c.text ?? ''))
    .join('\n');
  if (!isOneMContextUnavailableSignal(text)) return;

  const err = new Error(text || 'Claude 1M context unavailable for this account.');
  (err as any).code = ONE_M_CONTEXT_UNAVAILABLE_CODE;
  (err as any).attemptedModel = model;
  throw err;
}

/**
 * Compaction Tracking (#617): late-bound factory that returns the 3-hook
 * set for the current query. ClaudeHandler calls this when building the
 * Options.hooks payload — decoupled from concrete `EventRouter` /
 * `SlackApiHelper` types so this module keeps a minimal surface area.
 *
 * Registered by `SlackHandler` after both ClaudeHandler AND EventRouter
 * have been constructed (there is a cyclic dependency otherwise).
 */
export type CompactHookBuilder = (args: { session: ConversationSession; channel: string; threadTs: string }) => {
  PreCompact: (input: HookInput) => Promise<HookJSONOutput>;
  PostCompact: (input: HookInput) => Promise<HookJSONOutput>;
  SessionStart: (input: HookInput) => Promise<HookJSONOutput>;
};

export class ClaudeHandler {
  private logger = new Logger('ClaudeHandler');
  private mcpManager: McpManager;

  // Extracted components
  private sessionRegistry: SessionRegistry;
  private promptBuilder: PromptBuilder;
  private mcpConfigBuilder: McpConfigBuilder;

  // Compaction Tracking (#617): optional hook factory. Set by SlackHandler
  // during bootstrap. Undefined in unit tests / non-Slack callers — SDK
  // compaction then falls back to the stream-executor `compacting` signal
  // path with no thread-side post.
  private compactHookBuilder?: CompactHookBuilder;

  constructor(mcpManager: McpManager) {
    this.mcpManager = mcpManager;
    this.sessionRegistry = new SessionRegistry();
    this.promptBuilder = new PromptBuilder();
    this.mcpConfigBuilder = new McpConfigBuilder(mcpManager);
  }

  /**
   * Register the compact-hook factory. Called once during bootstrap.
   * See `CompactHookBuilder` JSDoc.
   */
  setCompactHookBuilder(builder: CompactHookBuilder): void {
    this.compactHookBuilder = builder;
  }

  /**
   * Resolve effective plugin paths dynamically from PluginManager.
   * Called each time a new session is created so that forceRefresh/rollback
   * changes are immediately reflected without service restart.
   */
  private getEffectivePluginPaths(): SdkPluginPath[] {
    const pm = this.mcpManager.getPluginManager();
    const paths = pm?.getPluginPaths() ?? [];
    if (paths.length === 0) {
      return [{ type: 'local' as const, path: LOCAL_PLUGINS_DIR }];
    }
    const hasLocal = paths.some((p) => p.path === LOCAL_PLUGINS_DIR);
    return hasLocal ? paths : [{ type: 'local' as const, path: LOCAL_PLUGINS_DIR }, ...paths];
  }

  /**
   * Set agent configurations for the MCP config builder.
   * Trace: docs/multi-agent/trace.md, Scenario 4
   */
  setAgentConfigs(configs: Record<string, any>): void {
    this.mcpConfigBuilder.setAgentConfigs(configs);
    this.logger.info('Agent configs set', { agents: Object.keys(configs) });
  }

  // ===== Session Registry Delegation =====

  /** Expose SessionRegistry for CronScheduler integration */
  getSessionRegistry(): SessionRegistry {
    return this.sessionRegistry;
  }

  setExpiryCallbacks(callbacks: SessionExpiryCallbacks): void {
    this.sessionRegistry.setExpiryCallbacks(callbacks);
  }

  getSessionKey(channelId: string, threadTs?: string): string {
    return this.sessionRegistry.getSessionKey(channelId, threadTs);
  }

  getSessionKeyWithUser(userId: string, channelId: string, threadTs?: string): string {
    return this.sessionRegistry.getSessionKeyWithUser(userId, channelId, threadTs);
  }

  getSession(channelId: string, threadTs?: string): ConversationSession | undefined {
    return this.sessionRegistry.getSession(channelId, threadTs);
  }

  getSessionWithUser(userId: string, channelId: string, threadTs?: string): ConversationSession | undefined {
    return this.sessionRegistry.getSessionWithUser(userId, channelId, threadTs);
  }

  getSessionByKey(sessionKey: string): ConversationSession | undefined {
    return this.sessionRegistry.getSessionByKey(sessionKey);
  }

  findSessionBySourceThread(channel: string, threadTs: string): ConversationSession | undefined {
    return this.sessionRegistry.findSessionBySourceThread(channel, threadTs);
  }

  getAllSessions(): Map<string, ConversationSession> {
    return this.sessionRegistry.getAllSessions();
  }

  createSession(
    ownerId: string,
    ownerName: string,
    channelId: string,
    threadTs?: string,
    model?: string,
  ): ConversationSession {
    return this.sessionRegistry.createSession(ownerId, ownerName, channelId, threadTs, model);
  }

  setSessionTitle(channelId: string, threadTs: string | undefined, title: string): void {
    this.sessionRegistry.setSessionTitle(channelId, threadTs, title);
  }

  updateSessionTitle(channelId: string, threadTs: string | undefined, title: string): void {
    this.sessionRegistry.updateSessionTitle(channelId, threadTs, title);
  }

  /**
   * Record merge code change stats for a PR in this session.
   */
  addMergeStats(
    channelId: string,
    threadTs: string | undefined,
    prNumber: number,
    linesAdded: number,
    linesDeleted: number,
  ): void {
    this.sessionRegistry.addMergeStats(channelId, threadTs, prNumber, linesAdded, linesDeleted);
  }

  /**
   * Mark a session as bot-initiated with its root message ts
   */
  setBotThread(channelId: string, threadTs: string | undefined, rootTs: string): void {
    const session = this.sessionRegistry.getSession(channelId, threadTs);
    if (session) {
      session.threadModel = 'bot-initiated';
      session.threadRootTs = rootTs;
    }
  }

  updateInitiator(channelId: string, threadTs: string | undefined, initiatorId: string, initiatorName: string): void {
    this.sessionRegistry.updateInitiator(channelId, threadTs, initiatorId, initiatorName);
  }

  canInterrupt(channelId: string, threadTs: string | undefined, userId: string): boolean {
    return this.sessionRegistry.canInterrupt(channelId, threadTs, userId);
  }

  terminateSession(sessionKey: string): boolean {
    return this.sessionRegistry.terminateSession(sessionKey);
  }

  clearSessionId(channelId: string, threadTs: string | undefined): void {
    this.sessionRegistry.clearSessionId(channelId, threadTs);
  }

  resetSessionContext(channelId: string, threadTs: string | undefined): boolean {
    return this.sessionRegistry.resetSessionContext(channelId, threadTs);
  }

  // ===== Session Links =====

  setSessionLink(channelId: string, threadTs: string | undefined, link: SessionLink): void {
    this.sessionRegistry.setSessionLink(channelId, threadTs, link);
  }

  setSessionLinks(channelId: string, threadTs: string | undefined, links: SessionLinks): void {
    this.sessionRegistry.setSessionLinks(channelId, threadTs, links);
  }

  getSessionLinks(channelId: string, threadTs?: string): SessionLinks | undefined {
    return this.sessionRegistry.getSessionLinks(channelId, threadTs);
  }

  addSourceWorkingDir(channelId: string, threadTs: string | undefined, dirPath: string): boolean {
    return this.sessionRegistry.addSourceWorkingDir(channelId, threadTs, dirPath);
  }

  getSessionResourceSnapshot(channelId: string, threadTs?: string): SessionResourceSnapshot {
    return this.sessionRegistry.getSessionResourceSnapshot(channelId, threadTs);
  }

  updateSessionResources(
    channelId: string,
    threadTs: string | undefined,
    request: SessionResourceUpdateRequest,
  ): SessionResourceUpdateResult {
    return this.sessionRegistry.updateSessionResources(channelId, threadTs, request);
  }

  refreshSessionActivityByKey(sessionKey: string): boolean {
    return this.sessionRegistry.refreshSessionActivityByKey(sessionKey);
  }

  // ===== Session State Machine =====

  transitionToMain(channelId: string, threadTs: string | undefined, workflow: WorkflowType, title?: string): void {
    this.sessionRegistry.transitionToMain(channelId, threadTs, workflow, title);
  }

  needsDispatch(channelId: string, threadTs?: string): boolean {
    return this.sessionRegistry.needsDispatch(channelId, threadTs);
  }

  isSleeping(channelId: string, threadTs?: string): boolean {
    return this.sessionRegistry.isSleeping(channelId, threadTs);
  }

  wakeFromSleep(channelId: string, threadTs?: string): boolean {
    return this.sessionRegistry.wakeFromSleep(channelId, threadTs);
  }

  transitionToSleep(channelId: string, threadTs?: string): boolean {
    return this.sessionRegistry.transitionToSleep(channelId, threadTs);
  }

  getSessionWorkflow(channelId: string, threadTs?: string): WorkflowType | undefined {
    return this.sessionRegistry.getSessionWorkflow(channelId, threadTs);
  }

  setActivityState(channelId: string, threadTs: string | undefined, state: ActivityState): void {
    this.sessionRegistry.setActivityState(channelId, threadTs, state);
  }

  setActivityStateByKey(sessionKey: string, state: ActivityState): void {
    this.sessionRegistry.setActivityStateByKey(sessionKey, state);
  }

  getActivityState(channelId: string, threadTs?: string): ActivityState | undefined {
    return this.sessionRegistry.getActivityState(channelId, threadTs);
  }

  async cleanupInactiveSessions(maxAge?: number): Promise<void> {
    return this.sessionRegistry.cleanupInactiveSessions(maxAge);
  }

  saveSessions(): void {
    this.sessionRegistry.saveSessions();
  }

  loadSessions(): number {
    return this.sessionRegistry.loadSessions();
  }

  getCrashRecoveredSessions(): CrashRecoveredSession[] {
    return this.sessionRegistry.getCrashRecoveredSessions();
  }

  clearCrashRecoveredSessions(): void {
    this.sessionRegistry.clearCrashRecoveredSessions();
  }

  // ===== Dispatch One-Shot Query =====

  /**
   * One-shot dispatch classification query.
   * Uses Agent SDK with no tools, no session persistence, and maxTurns=1.
   * Reuses the same credential validation as streamQuery.
   */
  async dispatchOneShot(
    userMessage: string,
    dispatchPrompt: string,
    model?: string,
    abortController?: AbortController,
    resumeSessionId?: string,
    cwd?: string,
  ): Promise<string> {
    // Acquire a lease on the active CCT slot. Held for the lifetime of the
    // Claude CLI dispatch call, released in the outer finally.
    let lease: SlotAuthLease | null = null;
    let heartbeatTimer: NodeJS.Timeout | null = null;
    try {
      try {
        lease = await ensureActiveSlotAuth(getTokenManager(), 'claude-handler:dispatchOneShot');
      } catch (credErr) {
        if (credErr instanceof NoHealthySlotError) {
          this.logger.error('Claude credentials invalid for dispatch', {
            error: credErr.message,
            status: getCredentialStatus(),
          });
          await sendCredentialAlert(credErr.message);
          throw new Error(
            `Claude credentials missing: ${credErr.message}\n` +
              'Please log in to Claude manually or enable automatic credential restore.',
          );
        }
        throw credErr;
      }

      heartbeatTimer = setInterval(() => {
        lease?.heartbeat().catch((err) => this.logger.debug('lease heartbeat failed', err));
      }, CLAUDE_LEASE_HEARTBEAT_MS);
      if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();

      // Build a per-call env map (containing the lease's fresh token) and
      // thread it through to `query()` via `options.env`. This never mutates
      // `process.env`, so concurrent dispatches on different slots are
      // isolated by construction.
      const { env } = buildQueryEnv(lease);
      return await this.dispatchOneShotInner(
        userMessage,
        dispatchPrompt,
        env,
        model,
        abortController,
        resumeSessionId,
        cwd,
      );
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (lease) await lease.release();
    }
  }

  private async dispatchOneShotInner(
    userMessage: string,
    dispatchPrompt: string,
    env: Record<string, string>,
    model?: string,
    abortController?: AbortController,
    resumeSessionId?: string,
    cwd?: string,
  ): Promise<string> {
    // Build query options for one-shot dispatch. `env` is the per-call map
    // from `buildQueryEnv(lease)` — it carries the lease's fresh access
    // token without ever touching `process.env`, so concurrent dispatches
    // cannot clobber each other's auth.
    const options: Options = {
      settingSources: [],
      plugins: [],
      systemPrompt: dispatchPrompt,
      env,
      tools: [], // No tool use for dispatch
      maxTurns: 1, // Single turn only
      stderr: (data: string) => {
        this.logger.warn('DISPATCH stderr', { data: data.trimEnd() });
      },
    };

    if (model) {
      options.model = model;
    }

    if (abortController) {
      options.abortController = abortController;
    }

    // Fork existing session to access conversation history for context-aware summaries.
    // resume + forkSession: copies history into a new session without mutating the original.
    // Without this, the fork has no knowledge of what happened in the session.
    if (resumeSessionId) {
      options.resume = resumeSessionId;
      options.forkSession = true;
    }

    if (cwd) {
      if (!fs.existsSync(cwd)) {
        this.logger.warn('Dispatch CWD does not exist, recreating', { cwd });
        try {
          fs.mkdirSync(cwd, { recursive: true });
        } catch (mkdirErr) {
          this.logger.error('Failed to recreate dispatch CWD', { cwd, error: mkdirErr });
        }
      }
      if (fs.existsSync(cwd)) {
        options.cwd = cwd;
      }
    }

    const startTime = Date.now();
    this.logger.info('\uD83D\uDE80 DISPATCH: Starting one-shot query', {
      model: options.model,
      resumeSession: !!resumeSessionId,
      messageLength: userMessage.length,
      messagePreview: userMessage.substring(0, 100),
    });

    let assistantText = '';
    let messageCount = 0;

    try {
      for await (const message of query({ prompt: userMessage, options })) {
        messageCount++;
        const elapsed = Date.now() - startTime;

        // Log all message types for debugging
        this.logger.debug(`\uD83D\uDCE8 DISPATCH: Message #${messageCount} (${elapsed}ms)`, {
          type: message.type,
          subtype: 'subtype' in message ? message.subtype : undefined,
        });

        // Handle system init message
        if (message.type === 'system' && message.subtype === 'init') {
          this.logger.info(`\u2705 DISPATCH: SDK initialized (${elapsed}ms)`, {
            model: message.model,
            sessionId: message.session_id,
          });
        }

        // Collect assistant text from the response
        if (message.type === 'assistant' && message.message?.content) {
          for (const block of message.message.content) {
            if (block.type === 'text') {
              assistantText += block.text;
              this.logger.debug(`\uD83D\uDCDD DISPATCH: Text received (${elapsed}ms)`, {
                textLength: block.text.length,
                textPreview: block.text.substring(0, 50),
              });
            }
          }
        }

        // Handle result message
        if (message.type === 'result') {
          this.logger.info(`\uD83C\uDFC1 DISPATCH: Query completed (${elapsed}ms)`, {
            totalMessages: messageCount,
            responseLength: assistantText.length,
            stopReason: message.subtype === 'success' ? message.stop_reason : undefined,
          });
        }
      }
    } catch (error) {
      const elapsed = Date.now() - startTime;

      // If we already collected assistant text, the response is likely complete
      // even though the process didn't exit cleanly (e.g., SIGTERM / exit code 143)
      if (assistantText.trim()) {
        this.logger.warn(`\u26A0\uFE0F DISPATCH: Process error after ${elapsed}ms but response available, using it`, {
          error: (error as Error).message,
          messagesReceived: messageCount,
          responseLength: assistantText.length,
          preview: assistantText.substring(0, 100),
        });
        // Fall through to return the collected text
      } else {
        this.logger.error(`\u274C DISPATCH: Error after ${elapsed}ms`, {
          error: (error as Error).message,
          messagesReceived: messageCount,
        });
        throw error;
      }
    }

    const totalTime = Date.now() - startTime;
    this.logger.info(`\uD83D\uDCCD DISPATCH: Response complete (${totalTime}ms)`, {
      responseLength: assistantText.length,
      preview: assistantText.substring(0, 200),
    });

    return assistantText;
  }

  // ===== Core Query Logic =====

  async *streamQuery(
    prompt: string,
    session?: ConversationSession,
    abortController?: AbortController,
    workingDirectory?: string,
    slackContext?: SlackContext,
  ): AsyncGenerator<SDKMessage, void, unknown> {
    // Acquire a lease on the active CCT slot. Held for the lifetime of the
    // Claude CLI streaming call, released in the outer finally below.
    let lease: SlotAuthLease | null = null;
    let heartbeatTimer: NodeJS.Timeout | null = null;
    try {
      try {
        lease = await ensureActiveSlotAuth(getTokenManager(), 'claude-handler:streamQuery');
      } catch (credErr) {
        if (credErr instanceof NoHealthySlotError) {
          this.logger.error('Claude credentials invalid', {
            error: credErr.message,
            status: getCredentialStatus(),
          });
          await sendCredentialAlert(credErr.message);
          throw new Error(
            `Claude credentials missing: ${credErr.message}\n` +
              'Please log in to Claude manually or enable automatic credential restore.',
          );
        }
        throw credErr;
      }

      heartbeatTimer = setInterval(() => {
        lease?.heartbeat().catch((err) => this.logger.debug('lease heartbeat failed', err));
      }, CLAUDE_LEASE_HEARTBEAT_MS);
      if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();

      // Build query options. The per-call env map (from `buildQueryEnv`)
      // carries the lease's fresh access token via `options.env`, so it
      // never crosses the shared `process.env.CLAUDE_CODE_OAUTH_TOKEN`
      // variable — concurrent streams holding leases on different slots
      // therefore cannot clobber each other's auth.
      const { env: queryEnv } = buildQueryEnv(lease);
      const options: Options = {
        // Load settings from filesystem for backward compatibility (Agent SDK v0.1.0 breaking change)
        settingSources: ['project'],
        // Load plugins from PluginManager or fallback to local directory
        plugins: this.getEffectivePluginPaths(),
        env: queryEnv,
      };

      // Get MCP configuration
      const modelCommandContext = this.buildModelCommandContext(session, slackContext);
      const mcpConfig = await this.mcpConfigBuilder.buildConfig(slackContext, modelCommandContext);
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
        const preToolUseHooks: Array<{ matcher: string; hooks: Array<(input: HookInput) => Promise<HookJSONOutput>> }> =
          [];

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
                  this.logger.warn('SSH command denied for non-admin user', {
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
                this.logger.warn('Sensitive path access denied', {
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
                this.logger.warn('Cross-user directory access denied', {
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
          const sessionRegistry = this.sessionRegistry;
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
                  this.logger.warn('Dangerous command in bypass mode \u2014 escalating to Slack permission UI', {
                    command: command.substring(0, 100),
                    user: slackContext.user,
                    matchedRuleIds,
                  });
                } else if (matchedRuleIds.length === 0) {
                  // Non-dangerous: normal bypass allow.
                } else {
                  // Matched rules but all were session-disabled \u2014 log for audit.
                  this.logger.info('Dangerous command auto-approved by session rule disable', {
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
        }

        // MCP tool permission enforcement: deny calls to permission-gated MCP tools
        // when the user lacks an active grant. Catches mid-session grant expiry that
        // allowedTools (computed once at query start) cannot detect.
        // Trace: docs/mcp-tool-permission/trace.md, S3/S5
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
                  const denied = this.checkMcpToolPermission(
                    toolName,
                    slackContext.user,
                    cachedPermConfig,
                    gatedServerNames,
                  );
                  if (denied) {
                    this.logger.warn('MCP tool permission denied by PreToolUse hook', {
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
        // Spec / trace: docs/pr-issue-precondition/{spec,trace}.md
        preToolUseHooks.push(
          ...buildPrIssueHookEntries({
            getHandoffContext: () =>
              this.sessionRegistry.getSession(slackContext.channel, slackContext.threadTs)?.handoffContext,
            logger: this.logger,
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
        if (this.compactHookBuilder && session && slackContext.threadTs) {
          const compactHooks = this.compactHookBuilder({
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
        this.logger.debug('Using session model', { model: session.model });
      } else if (slackContext?.user) {
        const userModel = userSettingsStore.getUserDefaultModel(slackContext.user);
        options.model = userModel;
        this.logger.debug('Using user default model', { model: userModel, user: slackContext.user });
      }

      // Set effort level only when explicitly configured
      if (session?.effort) {
        options.effort = session.effort;
        this.logger.debug('Using session effort', { effort: session.effort });
      }

      // Set thinking config (adaptive reasoning toggle).
      // See `buildThinkingOption` JSDoc for why we explicitly opt into 'summarized'.
      {
        const thinkingEnabled =
          session?.thinkingEnabled ??
          (slackContext?.user ? userSettingsStore.getUserThinkingEnabled(slackContext.user) : DEFAULT_THINKING_ENABLED);
        if (!thinkingEnabled) {
          options.thinking = buildThinkingOption(false);
          this.logger.debug('Thinking disabled for session');
        } else {
          const userShowThinking = slackContext?.user
            ? userSettingsStore.getUserShowThinking(slackContext.user)
            : undefined;
          const showSummary = resolveShowSummary(session?.showThinking, userShowThinking);
          options.thinking = buildThinkingOption(true, showSummary);
          this.logger.debug('Thinking adaptive', { display: showSummary ? 'summarized' : 'omitted' });
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
        const sandboxDisabled = slackContext?.user
          ? userSettingsStore.getUserSandboxDisabled(slackContext.user)
          : false;
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
          const networkDisabled = slackContext?.user
            ? userSettingsStore.getUserNetworkDisabled(slackContext.user)
            : false;
          if (!networkDisabled) {
            sandboxConfig.network = { allowedDomains: [...DEV_DOMAIN_ALLOWLIST] };
          }
          options.sandbox = sandboxConfig;
          this.logger.debug('Sandbox enabled', {
            user: slackContext?.user,
            network: networkDisabled ? 'off' : 'on',
            domains: networkDisabled ? 0 : DEV_DOMAIN_ALLOWLIST.length,
          });
        } else {
          this.logger.info('Sandbox disabled by admin setting', { user: slackContext?.user });
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
      const shouldRebuild =
        !session || !session.systemPrompt || session.compactionOccurred === true || !session.sessionId;

      let builtSystemPrompt: string | undefined;
      if (shouldRebuild) {
        builtSystemPrompt = this.promptBuilder.buildSystemPrompt(promptUserId, workflow, session);

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
        this.logger.info(`\uD83D\uDE80 STARTING QUERY with workflow: [${workflow}]`, {
          workflow,
          sessionId: session?.sessionId,
          model: options.model,
          promptLength: builtSystemPrompt.length,
          hasChannelDescription: !!slackContext?.channelDescription,
          repos: slackContext?.repos || [],
        });
      } else {
        this.logger.warn(`\uD83D\uDE80 STARTING QUERY with NO system prompt (workflow: [${workflow}])`);
      }

      // Set working directory \u2014 ensure it exists to prevent ENOENT on spawn
      if (workingDirectory) {
        if (!fs.existsSync(workingDirectory)) {
          this.logger.warn('Working directory does not exist, recreating', { workingDirectory });
          try {
            fs.mkdirSync(workingDirectory, { recursive: true });
          } catch (mkdirErr) {
            this.logger.error('Failed to recreate working directory', { workingDirectory, error: mkdirErr });
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
        this.logger.debug('Resuming session', { sessionId: session.sessionId });
      } else {
        this.logger.debug('Starting new Claude conversation');
      }

      // 1M context window is opt-in via the `[1m]` model-id suffix.
      // The Claude Agent SDK (≥ 0.2.111) detects the suffix, strips it before
      // the API call, and injects the `context-1m-2025-08-07` beta header
      // uniformly across API-key and OAuth auth — no runtime injection here.

      // Set abort controller
      if (abortController) {
        options.abortController = abortController;
      }

      // Capture Claude process stderr for debugging exit code 1 etc.
      // Also buffer stderr content so rate limit messages can be extracted on error
      let stderrBuffer = '';
      options.stderr = (data: string) => {
        stderrBuffer += data;
        this.logger.warn('Claude stderr', { data: data.trimEnd() });
      };

      this.logger.debug('Claude query options', options);

      try {
        for await (const message of query({ prompt, options })) {
          // Issue #661 — convert SDK's "1M context unavailable" assistant
          // message into a throw so the existing error path can auto-fallback.
          // No-op unless options.model ends with `[1m]` AND the message
          // carries one of the stable 1M-unavailable signals.
          maybeThrowOneMUnavailable(message, options.model);

          // Update session ID on init
          if (message.type === 'system' && message.subtype === 'init') {
            if (session) {
              session.sessionId = message.session_id;
              this.logger.info('Session initialized', {
                sessionId: message.session_id,
                model: message.model,
                tools: message.tools?.length || 0,
              });
            }
          }
          yield message;
        }
      } catch (error) {
        // Attach stderr content to error so downstream handlers can inspect it
        // (e.g., rate limit messages appear in stderr, not in error.message)
        if (stderrBuffer) {
          (error as any).stderrContent = stderrBuffer;
        }
        this.logger.error('Error in Claude query', error);
        throw error;
      }
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (lease) await lease.release();
    }
  }

  /**
   * Check if a MCP tool call should be denied based on permission config and active grants.
   * Returns a denial reason string, or null if the tool is allowed.
   * Used by PreToolUse hook for runtime enforcement (catches mid-session grant expiry).
   *
   * Uses known gated server names to resolve the `__` delimiter ambiguity:
   * matches `mcp__{knownServer}__` prefix instead of naive split.
   * SYNC: This logic is duplicated in mcp-tool-permission-integration.test.ts for direct testing.
   */
  private checkMcpToolPermission(
    toolName: string,
    userId: string,
    permConfig: ReturnType<typeof loadMcpToolPermissions>,
    gatedServerNames: string[],
  ): string | null {
    const resolved = resolveGatedTool(toolName, gatedServerNames);
    if (!resolved) return null;

    const { serverName, toolFunction } = resolved;
    const requiredLevel = getRequiredLevel(permConfig, serverName, toolFunction);

    // Tool not in permission config but on a gated server \u2192 deny-by-default (defense-in-depth)
    if (!requiredLevel) {
      return `Tool ${toolFunction} on gated server ${serverName} is not listed in permission config. Access denied by default.`;
    }

    // Check active grants (reload from disk for cross-process safety)
    mcpToolGrantStore.reload();
    const hasWriteGrant = mcpToolGrantStore.hasActiveGrant(userId, serverName, 'write');
    const hasReadGrant = mcpToolGrantStore.hasActiveGrant(userId, serverName, 'read');
    const userLevel = hasWriteGrant ? 'write' : hasReadGrant ? 'read' : null;

    if (!userLevel) {
      return `No active grant for ${serverName}. Required: ${requiredLevel}. Use mcp__mcp-tool-permission__request_permission to request access.`;
    }

    if (!levelSatisfies(userLevel, requiredLevel)) {
      return `Insufficient grant level for ${serverName}/${toolFunction}. Have: ${userLevel}, required: ${requiredLevel}.`;
    }

    return null;
  }

  private buildModelCommandContext(
    session: ConversationSession | undefined,
    slackContext: SlackContext | undefined,
  ): ModelCommandContext | undefined {
    if (!slackContext) {
      return undefined;
    }

    return {
      channel: slackContext.channel,
      threadTs: slackContext.threadTs,
      user: slackContext.user,
      workflow: session?.workflow,
      renewState: session?.renewState ?? null,
      session: this.sessionRegistry.getSessionResourceSnapshot(slackContext.channel, slackContext.threadTs),
      sessionTitle: session?.title,
    };
  }
}

/**
 * Build a structured repository context block for system prompt injection.
 * Exported for unit testing.
 */
export function buildRepoContextBlock(repos: string[], confluenceUrl?: string): string {
  const parts: string[] = [];
  if (repos.length > 0) {
    const repoLines = repos
      .map((r) => {
        // Guard against pre-prefixed URLs or malformed entries
        const url = r.startsWith('http') ? r : `https://github.com/${r}`;
        return `- ${url}`;
      })
      .join('\n');
    parts.push(`This channel is mapped to the following repository(ies):\n${repoLines}`);
  }
  if (confluenceUrl) {
    parts.push(`Project wiki: ${confluenceUrl}`);
  }
  return `<channel-repository>\n${parts.join('\n')}\n</channel-repository>`;
}
