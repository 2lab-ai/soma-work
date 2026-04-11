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
import { isCrossUserAccess, isDangerousCommand, isSshCommand } from './dangerous-command-filter';
import { CONFIG_FILE } from './env-paths';
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
import { isSafePathSegment, normalizeTmpPath } from './path-utils';
import type { SdkPluginPath } from './plugin/types';
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

import { sendCredentialAlert } from './credential-alert';
import { ensureValidCredentials, getCredentialStatus } from './credentials-manager';
import { McpConfigBuilder, type SlackContext } from './mcp-config-builder';
import type { ModelCommandContext } from './model-commands/types';
import { getAvailablePersonas, PromptBuilder } from './prompt-builder';
import { type CrashRecoveredSession, SessionExpiryCallbacks, SessionRegistry } from './session-registry';
import { userSettingsStore } from './user-settings-store';

// Re-export for backward compatibility
export { getAvailablePersonas, SessionExpiryCallbacks };

export class ClaudeHandler {
  private logger = new Logger('ClaudeHandler');
  private mcpManager: McpManager;

  // Extracted components
  private sessionRegistry: SessionRegistry;
  private promptBuilder: PromptBuilder;
  private mcpConfigBuilder: McpConfigBuilder;

  constructor(mcpManager: McpManager) {
    this.mcpManager = mcpManager;
    this.sessionRegistry = new SessionRegistry();
    this.promptBuilder = new PromptBuilder();
    this.mcpConfigBuilder = new McpConfigBuilder(mcpManager);
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
    // Validate credentials before making the query
    const credentialResult = await ensureValidCredentials();
    if (!credentialResult.valid) {
      this.logger.error('Claude credentials invalid for dispatch', {
        error: credentialResult.error,
        status: getCredentialStatus(),
      });

      await sendCredentialAlert(credentialResult.error);

      throw new Error(
        `Claude credentials missing: ${credentialResult.error}\n` +
          'Please log in to Claude manually or enable automatic credential restore.',
      );
    }

    if (credentialResult.restored) {
      this.logger.info('Credentials were restored from backup for dispatch');
    }

    // Build query options for one-shot dispatch
    const options: Options = {
      settingSources: [],
      plugins: [],
      systemPrompt: dispatchPrompt,
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
    this.logger.info('🚀 DISPATCH: Starting one-shot query', {
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
        this.logger.debug(`📨 DISPATCH: Message #${messageCount} (${elapsed}ms)`, {
          type: message.type,
          subtype: 'subtype' in message ? message.subtype : undefined,
        });

        // Handle system init message
        if (message.type === 'system' && message.subtype === 'init') {
          this.logger.info(`✅ DISPATCH: SDK initialized (${elapsed}ms)`, {
            model: message.model,
            sessionId: message.session_id,
          });
        }

        // Collect assistant text from the response
        if (message.type === 'assistant' && message.message?.content) {
          for (const block of message.message.content) {
            if (block.type === 'text') {
              assistantText += block.text;
              this.logger.debug(`📝 DISPATCH: Text received (${elapsed}ms)`, {
                textLength: block.text.length,
                textPreview: block.text.substring(0, 50),
              });
            }
          }
        }

        // Handle result message
        if (message.type === 'result') {
          this.logger.info(`🏁 DISPATCH: Query completed (${elapsed}ms)`, {
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
        this.logger.warn(`⚠️ DISPATCH: Process error after ${elapsed}ms but response available, using it`, {
          error: (error as Error).message,
          messagesReceived: messageCount,
          responseLength: assistantText.length,
          preview: assistantText.substring(0, 100),
        });
        // Fall through to return the collected text
      } else {
        this.logger.error(`❌ DISPATCH: Error after ${elapsed}ms`, {
          error: (error as Error).message,
          messagesReceived: messageCount,
        });
        throw error;
      }
    }

    const totalTime = Date.now() - startTime;
    this.logger.info(`📍 DISPATCH: Response complete (${totalTime}ms)`, {
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
    // Validate credentials before making the query
    const credentialResult = await ensureValidCredentials();
    if (!credentialResult.valid) {
      this.logger.error('Claude credentials invalid', {
        error: credentialResult.error,
        status: getCredentialStatus(),
      });

      await sendCredentialAlert(credentialResult.error);

      throw new Error(
        `Claude credentials missing: ${credentialResult.error}\n` +
          'Please log in to Claude manually or enable automatic credential restore.',
      );
    }

    if (credentialResult.restored) {
      this.logger.info('Credentials were restored from backup');
    }

    // Build query options
    const options: Options = {
      // Load settings from filesystem for backward compatibility (Agent SDK v0.1.0 breaking change)
      settingSources: ['project'],
      // Load plugins from PluginManager or fallback to local directory
      plugins: this.getEffectivePluginPaths(),
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
      if (mcpConfig.userBypass) {
        preToolUseHooks.push({
          matcher: 'Bash',
          hooks: [
            async (input: HookInput): Promise<HookJSONOutput> => {
              const { tool_input } = input as { tool_input: unknown };
              const toolRecord = tool_input as Record<string, unknown> | undefined;
              const command = typeof toolRecord?.command === 'string' ? toolRecord.command : '';

              if (isDangerousCommand(command)) {
                this.logger.warn('Dangerous command in bypass mode — escalating to Slack permission UI', {
                  command: command.substring(0, 100),
                  user: slackContext.user,
                });
                return {
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    permissionDecision: 'ask',
                  },
                };
              }

              // Non-dangerous: explicitly allow at hook level to bypass permissionPromptToolName routing
              return {
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse',
                  permissionDecision: 'allow',
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
        // Cache permission config once per query — it's static deployment config,
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

      if (preToolUseHooks.length > 0) {
        options.hooks = {
          ...options.hooks,
          PreToolUse: preToolUseHooks,
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

    // Set effort level only when explicitly configured (max is Opus 4.6 only)
    if (session?.effort) {
      options.effort = session.effort;
      this.logger.debug('Using session effort', { effort: session.effort });
    }

    // Set thinking config (adaptive reasoning toggle)
    {
      const thinkingEnabled =
        session?.thinkingEnabled ??
        (slackContext?.user ? userSettingsStore.getUserThinkingEnabled(slackContext.user) : true);
      if (!thinkingEnabled) {
        options.thinking = { type: 'disabled' };
        this.logger.debug('Thinking disabled for session');
      }
      // When enabled, don't set thinking — SDK defaults to adaptive for Opus 4.6+
    }

    // Build system prompt with persona and workflow
    // Use session owner for user variable resolution (Co-Authored-By attribution)
    // Falls back to current user if no session exists yet
    const workflow = session?.workflow || 'default';
    const promptUserId = session?.ownerId || slackContext?.user;
    let builtSystemPrompt = this.promptBuilder.buildSystemPrompt(promptUserId, workflow);

    // Inject channel description as additional context
    if (builtSystemPrompt && slackContext?.channelDescription) {
      builtSystemPrompt = `${builtSystemPrompt}\n\n<channel-description source="slack">\n${slackContext.channelDescription}\n</channel-description>`;
    }

    // Inject structured repository context from channel registry
    // This provides explicit repo identification so the model doesn't have to guess from raw description
    const hasRepos = slackContext?.repos && slackContext.repos.length > 0;
    const hasConfluence = !!slackContext?.confluenceUrl;
    if (builtSystemPrompt && (hasRepos || hasConfluence)) {
      builtSystemPrompt = `${builtSystemPrompt}\n\n${buildRepoContextBlock(slackContext!.repos || [], slackContext!.confluenceUrl)}`;
    }

    // Snapshot the fully-built system prompt into the session for admin debugging ("show prompt").
    // Always overwrite to avoid showing a stale prompt from a previous turn.
    if (session) {
      session.systemPrompt = builtSystemPrompt || undefined;
    }
    if (builtSystemPrompt) {
      options.systemPrompt = builtSystemPrompt;
      this.logger.info(`🚀 STARTING QUERY with workflow: [${workflow}]`, {
        workflow,
        sessionId: session?.sessionId,
        model: options.model,
        promptLength: builtSystemPrompt.length,
        hasChannelDescription: !!slackContext?.channelDescription,
        repos: slackContext?.repos || [],
      });
    } else {
      this.logger.warn(`🚀 STARTING QUERY with NO system prompt (workflow: [${workflow}])`);
    }

    // Set working directory — ensure it exists to prevent ENOENT on spawn
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

    // Enable 1M context window beta (applies to supported models).
    // Only set for API key users — subscription users get a noisy warning from the SDK.
    if (process.env.ANTHROPIC_API_KEY) {
      options.betas = ['context-1m-2025-08-07'];
    }

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

    // Tool not in permission config but on a gated server → deny-by-default (defense-in-depth)
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
