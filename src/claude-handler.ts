import { query, type SDKMessage } from '@anthropic-ai/claude-code';
import { ConversationSession } from './types';
import { Logger } from './logger';
import { McpManager, McpServerConfig } from './mcp-manager';
import { userSettingsStore } from './user-settings-store';
import { ensureValidCredentials, getCredentialStatus } from './credentials-manager';
import { sendCredentialAlert } from './credential-alert';
import * as path from 'path';
import * as fs from 'fs';

// Load system prompt from file
const SYSTEM_PROMPT_PATH = path.join(__dirname, 'prompt', 'system.prompt');
const PERSONA_DIR = path.join(__dirname, 'persona');
let DEFAULT_SYSTEM_PROMPT: string | undefined;

try {
  if (fs.existsSync(SYSTEM_PROMPT_PATH)) {
    DEFAULT_SYSTEM_PROMPT = fs.readFileSync(SYSTEM_PROMPT_PATH, 'utf-8');
  }
} catch (error) {
  console.error('Failed to load system prompt:', error);
}

/**
 * Load persona content from file
 */
function loadPersona(personaName: string): string | undefined {
  const personaPath = path.join(PERSONA_DIR, `${personaName}.md`);
  try {
    if (fs.existsSync(personaPath)) {
      return fs.readFileSync(personaPath, 'utf-8');
    }
    // Fallback to default if specified persona not found
    if (personaName !== 'default') {
      const defaultPath = path.join(PERSONA_DIR, 'default.md');
      if (fs.existsSync(defaultPath)) {
        return fs.readFileSync(defaultPath, 'utf-8');
      }
    }
  } catch (error) {
    console.error(`Failed to load persona '${personaName}':`, error);
  }
  return undefined;
}

/**
 * Get list of available personas
 */
export function getAvailablePersonas(): string[] {
  try {
    if (fs.existsSync(PERSONA_DIR)) {
      return fs.readdirSync(PERSONA_DIR)
        .filter(file => file.endsWith('.md'))
        .map(file => file.replace('.md', ''));
    }
  } catch (error) {
    console.error('Failed to list personas:', error);
  }
  return ['default'];
}

export class ClaudeHandler {
  private sessions: Map<string, ConversationSession> = new Map();
  private logger = new Logger('ClaudeHandler');
  private mcpManager: McpManager;

  constructor(mcpManager: McpManager) {
    this.mcpManager = mcpManager;
  }

  getSessionKey(userId: string, channelId: string, threadTs?: string): string {
    return `${userId}-${channelId}-${threadTs || 'direct'}`;
  }

  getSession(userId: string, channelId: string, threadTs?: string): ConversationSession | undefined {
    return this.sessions.get(this.getSessionKey(userId, channelId, threadTs));
  }

  createSession(userId: string, channelId: string, threadTs?: string): ConversationSession {
    const session: ConversationSession = {
      userId,
      channelId,
      threadTs,
      isActive: true,
      lastActivity: new Date(),
    };
    this.sessions.set(this.getSessionKey(userId, channelId, threadTs), session);
    return session;
  }

  async *streamQuery(
    prompt: string,
    session?: ConversationSession,
    abortController?: AbortController,
    workingDirectory?: string,
    slackContext?: { channel: string; threadTs?: string; user: string }
  ): AsyncGenerator<SDKMessage, void, unknown> {
    // Validate credentials before making the query
    const credentialResult = await ensureValidCredentials();
    if (!credentialResult.valid) {
      this.logger.error('Claude credentials invalid', {
        error: credentialResult.error,
        status: getCredentialStatus(),
      });

      // Send alert to Slack channel
      await sendCredentialAlert(credentialResult.error);

      // Throw error to stop the query
      throw new Error(
        `Claude credentials missing: ${credentialResult.error}\n` +
          'Please log in to Claude manually or enable automatic credential restore.'
      );
    }

    if (credentialResult.restored) {
      this.logger.info('Credentials were restored from backup');
    }

    // Check if user has bypass permission enabled
    const userBypass = slackContext?.user
      ? userSettingsStore.getUserBypassPermission(slackContext.user)
      : false;

    const options: any = {
      outputFormat: 'stream-json',
      // Enable permission prompts when we have Slack context, unless user has bypass enabled
      permissionMode: (!slackContext || userBypass) ? 'bypassPermissions' : 'default',
    };

    // Build system prompt with persona
    let systemPrompt = DEFAULT_SYSTEM_PROMPT || '';

    // Load and append user's persona
    if (slackContext?.user) {
      const personaName = userSettingsStore.getUserPersona(slackContext.user);
      const personaContent = loadPersona(personaName);
      if (personaContent) {
        systemPrompt = systemPrompt
          ? `${systemPrompt}\n\n<persona>\n${personaContent}\n</persona>`
          : `<persona>\n${personaContent}\n</persona>`;
        this.logger.debug('Applied persona', { user: slackContext.user, persona: personaName });
      }
    }

    if (systemPrompt) {
      options.customSystemPrompt = systemPrompt;
      this.logger.debug('Applied custom system prompt with persona');
    }

    // Add permission prompt tool if we have Slack context and bypass is not enabled
    if (slackContext && !userBypass) {
      options.permissionPromptToolName = 'mcp__permission-prompt__permission_prompt';
      this.logger.debug('Configured permission prompts for Slack integration', {
        channel: slackContext.channel,
        user: slackContext.user,
        hasThread: !!slackContext.threadTs
      });
    } else if (slackContext && userBypass) {
      this.logger.debug('Bypassing permission prompts for user', {
        user: slackContext.user,
        bypassEnabled: true
      });
    }

    if (workingDirectory) {
      options.cwd = workingDirectory;
    }

    // Add MCP server configuration if available
    const mcpServers = await this.mcpManager.getServerConfiguration();

    // Add permission prompt server if we have Slack context and bypass is not enabled
    if (slackContext && !userBypass) {
      const permissionServer = {
        'permission-prompt': {
          command: 'npx',
          args: ['tsx', path.join(__dirname, 'permission-mcp-server.ts')],
          env: {
            SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
            SLACK_CONTEXT: JSON.stringify(slackContext)
          }
        }
      };

      if (mcpServers) {
        options.mcpServers = { ...mcpServers, ...permissionServer };
      } else {
        options.mcpServers = permissionServer;
      }
    } else if (mcpServers && Object.keys(mcpServers).length > 0) {
      options.mcpServers = mcpServers;
    }
    
    if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
      // Allow all MCP tools by default, plus permission prompt tool if not bypassed
      const defaultMcpTools = this.mcpManager.getDefaultAllowedTools();
      if (slackContext && !userBypass) {
        defaultMcpTools.push('mcp__permission-prompt__permission_prompt');
      }
      if (defaultMcpTools.length > 0) {
        options.allowedTools = defaultMcpTools;
      }

      this.logger.debug('Added MCP configuration to options', {
        serverCount: Object.keys(options.mcpServers).length,
        servers: Object.keys(options.mcpServers),
        allowedTools: defaultMcpTools,
        hasSlackContext: !!slackContext,
        userBypass,
        permissionMode: options.permissionMode,
      });
    }

    if (session?.sessionId) {
      options.resume = session.sessionId;
      this.logger.debug('Resuming session', { sessionId: session.sessionId });
    } else {
      this.logger.debug('Starting new Claude conversation');
    }

    this.logger.debug('Claude query options', options);

    if (abortController) {
      options.abortController = abortController;
    }

    try {
      for await (const message of query({
        prompt,
        options,
      })) {
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

  cleanupInactiveSessions(maxAge: number = 30 * 60 * 1000) {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, session] of this.sessions.entries()) {
      if (now - session.lastActivity.getTime() > maxAge) {
        this.sessions.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      this.logger.info(`Cleaned up ${cleaned} inactive sessions`);
    }
  }
}