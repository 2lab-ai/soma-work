/**
 * ClaudeHandler - Manages Claude SDK queries
 * Refactored to use SessionRegistry, PromptBuilder, and McpConfigBuilder (Phase 5)
 */

import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import * as path from 'path';
import {
  ConversationSession,
  SessionLinks,
  SessionLink,
  SessionResourceSnapshot,
  SessionResourceUpdateRequest,
  SessionResourceUpdateResult,
  WorkflowType,
  ActivityState,
} from './types';
import { Logger } from './logger';
import { McpManager } from './mcp-manager';

// Local plugins directory (contains skills, etc.)
const LOCAL_PLUGINS_DIR = path.join(__dirname, 'local');
import { userSettingsStore } from './user-settings-store';
import { ensureValidCredentials, getCredentialStatus } from './credentials-manager';
import { sendCredentialAlert } from './credential-alert';
import { SessionRegistry, SessionExpiryCallbacks } from './session-registry';
import { PromptBuilder, getAvailablePersonas } from './prompt-builder';
import { McpConfigBuilder, SlackContext } from './mcp-config-builder';
import { ModelCommandContext } from './model-commands/types';

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

  // ===== Session Registry Delegation =====

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

  getSessionWithUser(
    userId: string,
    channelId: string,
    threadTs?: string
  ): ConversationSession | undefined {
    return this.sessionRegistry.getSessionWithUser(userId, channelId, threadTs);
  }

  getSessionByKey(sessionKey: string): ConversationSession | undefined {
    return this.sessionRegistry.getSessionByKey(sessionKey);
  }

  getAllSessions(): Map<string, ConversationSession> {
    return this.sessionRegistry.getAllSessions();
  }

  createSession(
    ownerId: string,
    ownerName: string,
    channelId: string,
    threadTs?: string,
    model?: string
  ): ConversationSession {
    return this.sessionRegistry.createSession(ownerId, ownerName, channelId, threadTs, model);
  }

  setSessionTitle(channelId: string, threadTs: string | undefined, title: string): void {
    this.sessionRegistry.setSessionTitle(channelId, threadTs, title);
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

  updateInitiator(
    channelId: string,
    threadTs: string | undefined,
    initiatorId: string,
    initiatorName: string
  ): void {
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

  getSessionResourceSnapshot(channelId: string, threadTs?: string): SessionResourceSnapshot {
    return this.sessionRegistry.getSessionResourceSnapshot(channelId, threadTs);
  }

  updateSessionResources(
    channelId: string,
    threadTs: string | undefined,
    request: SessionResourceUpdateRequest
  ): SessionResourceUpdateResult {
    return this.sessionRegistry.updateSessionResources(channelId, threadTs, request);
  }

  refreshSessionActivityByKey(sessionKey: string): boolean {
    return this.sessionRegistry.refreshSessionActivityByKey(sessionKey);
  }

  // ===== Session State Machine =====

  transitionToMain(
    channelId: string,
    threadTs: string | undefined,
    workflow: WorkflowType,
    title?: string
  ): void {
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
    abortController?: AbortController
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
          'Please log in to Claude manually or enable automatic credential restore.'
      );
    }

    if (credentialResult.restored) {
      this.logger.info('Credentials were restored from backup for dispatch');
    }

    // Build query options for one-shot dispatch
    const options: any = {
      outputFormat: 'stream-json',
      settingSources: [],
      plugins: [],
      systemPrompt: dispatchPrompt,
      tools: [], // No tool use for dispatch
      maxTurns: 1, // Single turn only
      // Note: persistSession is not a query option - SDK doesn't persist by default when no session ID is provided
    };

    if (model) {
      options.model = model;
    }

    if (abortController) {
      options.abortController = abortController;
    }

    const startTime = Date.now();
    this.logger.info('🚀 DISPATCH: Starting one-shot query', {
      model: options.model,
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
          subtype: (message as any).subtype,
        });

        // Handle system init message
        if (message.type === 'system' && (message as any).subtype === 'init') {
          this.logger.info(`✅ DISPATCH: SDK initialized (${elapsed}ms)`, {
            model: (message as any).model,
            sessionId: (message as any).session_id,
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
          });
        }
      }
    } catch (error) {
      const elapsed = Date.now() - startTime;
      this.logger.error(`❌ DISPATCH: Error after ${elapsed}ms`, {
        error: (error as Error).message,
        messagesReceived: messageCount,
      });
      throw error;
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
    slackContext?: SlackContext
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
          'Please log in to Claude manually or enable automatic credential restore.'
      );
    }

    if (credentialResult.restored) {
      this.logger.info('Credentials were restored from backup');
    }

    // Build query options
    const options: any = {
      outputFormat: 'stream-json',
      // Load settings from filesystem for backward compatibility (Agent SDK v0.1.0 breaking change)
      settingSources: ['project'],
      // Load local plugins (skills, etc.) from src/local directory
      plugins: [{ type: 'local', path: LOCAL_PLUGINS_DIR }],
    };

    // Get MCP configuration
    const modelCommandContext = this.buildModelCommandContext(session, slackContext);
    const mcpConfig = await this.mcpConfigBuilder.buildConfig(slackContext, modelCommandContext);
    options.permissionMode = mcpConfig.permissionMode;

    if (mcpConfig.mcpServers) {
      options.mcpServers = mcpConfig.mcpServers;
    }
    if (mcpConfig.allowedTools && mcpConfig.allowedTools.length > 0) {
      options.allowedTools = mcpConfig.allowedTools;
    }
    if (mcpConfig.permissionPromptToolName) {
      options.permissionPromptToolName = mcpConfig.permissionPromptToolName;
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

    // Build system prompt with persona and workflow
    const workflow = session?.workflow || 'default';
    let builtSystemPrompt = this.promptBuilder.buildSystemPrompt(slackContext?.user, workflow);

    // Inject channel description as additional context
    if (builtSystemPrompt && slackContext?.channelDescription) {
      builtSystemPrompt = `${builtSystemPrompt}\n\n<channel-description source="slack">\n${slackContext.channelDescription}\n</channel-description>`;
    }

    if (builtSystemPrompt) {
      options.systemPrompt = builtSystemPrompt;
      this.logger.info(`🚀 STARTING QUERY with workflow: [${workflow}]`, {
        workflow,
        sessionId: session?.sessionId,
        model: options.model,
        promptLength: builtSystemPrompt.length,
        hasChannelDescription: !!slackContext?.channelDescription,
      });
    } else {
      this.logger.warn(`🚀 STARTING QUERY with NO system prompt (workflow: [${workflow}])`);
    }

    // Set working directory
    if (workingDirectory) {
      options.cwd = workingDirectory;
    }

    // Resume existing session
    if (session?.sessionId) {
      options.resume = session.sessionId;
      this.logger.debug('Resuming session', { sessionId: session.sessionId });
    } else {
      this.logger.debug('Starting new Claude conversation');
    }

    // Set abort controller
    if (abortController) {
      options.abortController = abortController;
    }

    this.logger.debug('Claude query options', options);

    try {
      for await (const message of query({ prompt, options })) {
        // Update session ID on init
        if (message.type === 'system' && message.subtype === 'init') {
          if (session) {
            session.sessionId = message.session_id;
            this.logger.info('Session initialized', {
              sessionId: message.session_id,
              model: (message as any).model,
              tools: (message as any).tools?.length || 0,
            });
          }
        }
        yield message;
      }
    } catch (error) {
      this.logger.error('Error in Claude query', error);
      throw error;
    }
  }

  private buildModelCommandContext(
    session: ConversationSession | undefined,
    slackContext: SlackContext | undefined
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
      session: this.sessionRegistry.getSessionResourceSnapshot(
        slackContext.channel,
        slackContext.threadTs
      ),
    };
  }
}
