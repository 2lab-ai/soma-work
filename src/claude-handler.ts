/**
 * ClaudeHandler - Manages Claude SDK queries
 * Refactored to use SessionRegistry, PromptBuilder, and McpConfigBuilder (Phase 5)
 */

import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ConversationSession } from './types';
import { Logger } from './logger';
import { McpManager } from './mcp-manager';
import { userSettingsStore } from './user-settings-store';
import { ensureValidCredentials, getCredentialStatus } from './credentials-manager';
import { sendCredentialAlert } from './credential-alert';
import { SessionRegistry, SessionExpiryCallbacks } from './session-registry';
import { PromptBuilder, getAvailablePersonas } from './prompt-builder';
import { McpConfigBuilder, SlackContext } from './mcp-config-builder';

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

  async cleanupInactiveSessions(maxAge?: number): Promise<void> {
    return this.sessionRegistry.cleanupInactiveSessions(maxAge);
  }

  saveSessions(): void {
    this.sessionRegistry.saveSessions();
  }

  loadSessions(): number {
    return this.sessionRegistry.loadSessions();
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
      settingSources: ['user', 'project', 'local'],
    };

    // Get MCP configuration
    const mcpConfig = await this.mcpConfigBuilder.buildConfig(slackContext);
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

    // Build system prompt with persona
    const builtSystemPrompt = this.promptBuilder.buildSystemPrompt(slackContext?.user);
    if (builtSystemPrompt) {
      options.systemPrompt = builtSystemPrompt;
      this.logger.debug('Applied custom system prompt with persona');
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
}
