import { query, type SDKMessage } from '@anthropic-ai/claude-code';
import { ConversationSession } from './types';
import { Logger } from './logger';
import { McpManager, McpServerConfig } from './mcp-manager';
import { userSettingsStore } from './user-settings-store';
import { ensureValidCredentials, getCredentialStatus } from './credentials-manager';
import { sendCredentialAlert } from './credential-alert';
import * as path from 'path';
import * as fs from 'fs';

// Session persistence file path
const DATA_DIR = path.join(process.cwd(), 'data');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

interface SerializedSession {
  key: string;
  ownerId: string;
  ownerName?: string;
  userId: string; // Legacy field
  channelId: string;
  threadTs?: string;
  sessionId?: string;
  isActive: boolean;
  lastActivity: string; // ISO date string
  workingDirectory?: string;
}

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

// Session expiry warning intervals in milliseconds (from session expiry time)
// Only send warning 10 minutes before expiry
const WARNING_INTERVALS = [
  10 * 60 * 1000,      // 10 minutes
];

// Default session timeout: 24 hours
const DEFAULT_SESSION_TIMEOUT = 24 * 60 * 60 * 1000;

export interface SessionExpiryCallbacks {
  onWarning: (session: ConversationSession, timeRemaining: number, warningMessageTs?: string) => Promise<string | undefined>;
  onExpiry: (session: ConversationSession) => Promise<void>;
}

export class ClaudeHandler {
  private sessions: Map<string, ConversationSession> = new Map();
  private logger = new Logger('ClaudeHandler');
  private mcpManager: McpManager;
  private expiryCallbacks?: SessionExpiryCallbacks;

  constructor(mcpManager: McpManager) {
    this.mcpManager = mcpManager;
  }

  setExpiryCallbacks(callbacks: SessionExpiryCallbacks) {
    this.expiryCallbacks = callbacks;
  }

  /**
   * Get session key - now based on channel and thread only (shared session)
   */
  getSessionKey(channelId: string, threadTs?: string): string {
    return `${channelId}-${threadTs || 'direct'}`;
  }

  /**
   * Legacy method for backward compatibility - ignores userId
   */
  getSessionKeyWithUser(userId: string, channelId: string, threadTs?: string): string {
    return this.getSessionKey(channelId, threadTs);
  }

  getSession(channelId: string, threadTs?: string): ConversationSession | undefined {
    return this.sessions.get(this.getSessionKey(channelId, threadTs));
  }

  /**
   * Legacy method for backward compatibility
   */
  getSessionWithUser(userId: string, channelId: string, threadTs?: string): ConversationSession | undefined {
    return this.getSession(channelId, threadTs);
  }

  createSession(ownerId: string, ownerName: string, channelId: string, threadTs?: string): ConversationSession {
    const session: ConversationSession = {
      ownerId,
      ownerName,
      userId: ownerId, // Legacy field
      channelId,
      threadTs,
      isActive: true,
      lastActivity: new Date(),
    };
    this.sessions.set(this.getSessionKey(channelId, threadTs), session);
    return session;
  }

  /**
   * Update the current initiator of a session
   */
  updateInitiator(channelId: string, threadTs: string | undefined, initiatorId: string, initiatorName: string): void {
    const session = this.getSession(channelId, threadTs);
    if (session) {
      session.currentInitiatorId = initiatorId;
      session.currentInitiatorName = initiatorName;
      session.lastActivity = new Date();
    }
  }

  /**
   * Check if a user can interrupt the current response
   * Only owner or current initiator can interrupt
   */
  canInterrupt(channelId: string, threadTs: string | undefined, userId: string): boolean {
    const session = this.getSession(channelId, threadTs);
    if (!session) {
      return true; // No session, so anyone can start
    }
    // Owner can always interrupt
    if (session.ownerId === userId) {
      return true;
    }
    // Current initiator can interrupt
    if (session.currentInitiatorId === userId) {
      return true;
    }
    return false;
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

  async cleanupInactiveSessions(maxAge: number = DEFAULT_SESSION_TIMEOUT) {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, session] of this.sessions.entries()) {
      const sessionAge = now - session.lastActivity.getTime();
      const timeUntilExpiry = maxAge - sessionAge;

      // Check if session should be expired
      if (timeUntilExpiry <= 0) {
        // Send expiry message before cleaning up
        if (this.expiryCallbacks) {
          try {
            await this.expiryCallbacks.onExpiry(session);
          } catch (error) {
            this.logger.error('Failed to send session expiry message', error);
          }
        }
        this.sessions.delete(key);
        cleaned++;
        continue;
      }

      // Check if we should send a warning
      if (this.expiryCallbacks) {
        for (const warningInterval of WARNING_INTERVALS) {
          // If time until expiry is less than or equal to this warning interval
          // and we haven't sent this warning yet (or a more urgent one)
          if (timeUntilExpiry <= warningInterval) {
            const lastWarningSent = session.lastWarningSentAt || Infinity;

            // Only send if this is a new/more urgent warning
            if (warningInterval < lastWarningSent) {
              try {
                const newMessageTs = await this.expiryCallbacks.onWarning(
                  session,
                  timeUntilExpiry,
                  session.warningMessageTs
                );

                // Update session with warning info
                session.lastWarningSentAt = warningInterval;
                if (newMessageTs) {
                  session.warningMessageTs = newMessageTs;
                }

                this.logger.debug('Sent session expiry warning', {
                  sessionKey: key,
                  timeRemaining: timeUntilExpiry,
                  warningInterval,
                });
              } catch (error) {
                this.logger.error('Failed to send session warning', error);
              }
            }
            break; // Only send the most urgent applicable warning
          }
        }
      }
    }

    if (cleaned > 0) {
      this.logger.info(`Cleaned up ${cleaned} inactive sessions`);
    }
  }

  /**
   * Get all active sessions
   */
  getAllSessions(): Map<string, ConversationSession> {
    return this.sessions;
  }

  /**
   * Save all sessions to file for persistence across restarts
   */
  saveSessions(): void {
    try {
      // Ensure data directory exists
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }

      const sessionsArray: SerializedSession[] = [];
      for (const [key, session] of this.sessions.entries()) {
        // Only save sessions with sessionId (meaning they have conversation history)
        if (session.sessionId) {
          sessionsArray.push({
            key,
            ownerId: session.ownerId,
            ownerName: session.ownerName,
            userId: session.userId, // Legacy field
            channelId: session.channelId,
            threadTs: session.threadTs,
            sessionId: session.sessionId,
            isActive: session.isActive,
            lastActivity: session.lastActivity.toISOString(),
            workingDirectory: session.workingDirectory,
          });
        }
      }

      fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessionsArray, null, 2));
      this.logger.info(`Saved ${sessionsArray.length} sessions to file`);
    } catch (error) {
      this.logger.error('Failed to save sessions', error);
    }
  }

  /**
   * Load sessions from file after restart
   */
  loadSessions(): number {
    try {
      if (!fs.existsSync(SESSIONS_FILE)) {
        this.logger.debug('No sessions file found');
        return 0;
      }

      const data = fs.readFileSync(SESSIONS_FILE, 'utf-8');
      const sessionsArray: SerializedSession[] = JSON.parse(data);

      let loaded = 0;
      const now = Date.now();
      const maxAge = DEFAULT_SESSION_TIMEOUT;

      for (const serialized of sessionsArray) {
        const lastActivity = new Date(serialized.lastActivity);
        const sessionAge = now - lastActivity.getTime();

        // Only restore sessions that haven't expired
        if (sessionAge < maxAge) {
          const session: ConversationSession = {
            ownerId: serialized.ownerId || serialized.userId, // Fallback for legacy sessions
            ownerName: serialized.ownerName,
            userId: serialized.userId, // Legacy field
            channelId: serialized.channelId,
            threadTs: serialized.threadTs,
            sessionId: serialized.sessionId,
            isActive: serialized.isActive,
            lastActivity,
            workingDirectory: serialized.workingDirectory,
          };
          this.sessions.set(serialized.key, session);
          loaded++;
        }
      }

      this.logger.info(`Loaded ${loaded} sessions from file (${sessionsArray.length - loaded} expired)`);

      // Clean up the sessions file after loading
      // We'll save fresh on next shutdown
      return loaded;
    } catch (error) {
      this.logger.error('Failed to load sessions', error);
      return 0;
    }
  }
}