import { App } from '@slack/bolt';
import { ClaudeHandler, getAvailablePersonas, SessionExpiryCallbacks } from './claude-handler';
import { SDKMessage } from '@anthropic-ai/claude-code';
import { Logger } from './logger';
import { WorkingDirectoryManager } from './working-directory-manager';
import { FileHandler, ProcessedFile } from './file-handler';
import { ConversationSession } from './types';
import { TodoManager, Todo } from './todo-manager';
import { McpManager } from './mcp-manager';
import { sharedStore, PermissionResponse } from './shared-store';
import { userSettingsStore } from './user-settings-store';
import { config } from './config';
import { getCredentialStatus, copyBackupCredentials, hasClaudeAiOauth, isCredentialManagerEnabled } from './credentials-manager';
import { mcpCallTracker, McpCallTracker } from './mcp-call-tracker';

interface MessageEvent {
  user: string;
  channel: string;
  thread_ts?: string;
  ts: string;
  text?: string;
  files?: Array<{
    id: string;
    name: string;
    mimetype: string;
    filetype: string;
    url_private: string;
    url_private_download: string;
    size: number;
  }>;
}

export class SlackHandler {
  private app: App;
  private claudeHandler: ClaudeHandler;
  private activeControllers: Map<string, AbortController> = new Map();
  private logger = new Logger('SlackHandler');
  private workingDirManager: WorkingDirectoryManager;
  private fileHandler: FileHandler;
  private todoManager: TodoManager;
  private mcpManager: McpManager;
  private todoMessages: Map<string, string> = new Map(); // sessionKey -> messageTs
  private originalMessages: Map<string, { channel: string; ts: string }> = new Map(); // sessionKey -> original message info
  private currentReactions: Map<string, string> = new Map(); // sessionKey -> current emoji
  private botUserId: string | null = null;
  // Track tool_use_id -> tool_name mapping for MCP result display
  private toolUseIdToName: Map<string, string> = new Map();
  // Track MCP call IDs for duration tracking
  private toolUseIdToCallId: Map<string, string> = new Map();
  // Track active MCP status update intervals
  private mcpStatusIntervals: Map<string, NodeJS.Timeout> = new Map();
  // Track MCP status message timestamps and channel info
  private mcpStatusMessages: Map<string, { ts: string; channel: string; serverName: string; toolName: string }> = new Map();

  constructor(app: App, claudeHandler: ClaudeHandler, mcpManager: McpManager) {
    this.app = app;
    this.claudeHandler = claudeHandler;
    this.mcpManager = mcpManager;
    this.workingDirManager = new WorkingDirectoryManager();
    this.fileHandler = new FileHandler();
    this.todoManager = new TodoManager();
  }

  async handleMessage(event: MessageEvent, say: any) {
    const { user, channel, thread_ts, ts, text, files } = event;

    // Update user's Jira info from mapping (if available)
    userSettingsStore.updateUserJiraInfo(user);

    // Process any attached files
    let processedFiles: ProcessedFile[] = [];
    if (files && files.length > 0) {
      this.logger.info('Processing uploaded files', { count: files.length });
      processedFiles = await this.fileHandler.downloadAndProcessFiles(files);
      
      if (processedFiles.length > 0) {
        await say({
          text: `📎 Processing ${processedFiles.length} file(s): ${processedFiles.map(f => f.name).join(', ')}`,
          thread_ts: thread_ts || ts,
        });
      }
    }

    // If no text and no files, nothing to process
    if (!text && processedFiles.length === 0) return;

    this.logger.debug('Received message from Slack', {
      user,
      channel,
      thread_ts,
      ts,
      text: text ? text.substring(0, 100) + (text.length > 100 ? '...' : '') : '[no text]',
      fileCount: processedFiles.length,
    });

    // Check if this is a working directory command (only if there's text)
    const setDirPath = text ? this.workingDirManager.parseSetCommand(text) : null;
    if (setDirPath) {
      const isDM = channel.startsWith('D');
      // Always pass userId to save user's default directory
      const result = this.workingDirManager.setWorkingDirectory(
        channel,
        setDirPath,
        thread_ts,
        user
      );

      if (result.success) {
        const context = thread_ts ? 'this thread' : (isDM ? 'this conversation' : 'this channel');
        await say({
          text: `✅ Working directory set for ${context}: \`${result.resolvedPath}\`\n_This will be your default for future conversations._`,
          thread_ts: thread_ts || ts,
        });
      } else {
        await say({
          text: `❌ ${result.error}`,
          thread_ts: thread_ts || ts,
        });
      }
      return;
    }

    // Check if this is a get directory command (only if there's text)
    if (text && this.workingDirManager.isGetCommand(text)) {
      const isDM = channel.startsWith('D');
      // Always pass userId to check user's saved default
      const directory = this.workingDirManager.getWorkingDirectory(
        channel,
        thread_ts,
        user
      );
      const context = thread_ts ? 'this thread' : (isDM ? 'this conversation' : 'this channel');

      await say({
        text: this.workingDirManager.formatDirectoryMessage(directory, context),
        thread_ts: thread_ts || ts,
      });
      return;
    }

    // Check if this is an MCP info command (only if there's text)
    if (text && this.isMcpInfoCommand(text)) {
      const mcpInfo = await this.mcpManager.formatMcpInfo();
      await say({
        text: mcpInfo,
        thread_ts: thread_ts || ts,
      });
      return;
    }

    // Check if this is an MCP reload command (only if there's text)
    if (text && this.isMcpReloadCommand(text)) {
      const reloaded = this.mcpManager.reloadConfiguration();
      if (reloaded) {
        const mcpInfo = await this.mcpManager.formatMcpInfo();
        await say({
          text: `✅ MCP configuration reloaded successfully.\n\n${mcpInfo}`,
          thread_ts: thread_ts || ts,
        });
      } else {
        await say({
          text: `❌ Failed to reload MCP configuration. Check the mcp-servers.json file.`,
          thread_ts: thread_ts || ts,
        });
      }
      return;
    }

    // Check if this is a bypass permission command (only if there's text)
    if (text && this.isBypassCommand(text)) {
      const bypassAction = this.parseBypassCommand(text);

      if (bypassAction === 'status') {
        const currentBypass = userSettingsStore.getUserBypassPermission(user);
        await say({
          text: `🔐 *Permission Bypass Status*\n\nYour current setting: \`${currentBypass ? 'ON' : 'OFF'}\`\n\n${currentBypass ? '⚠️ Claude will execute tools without asking for permission.' : '✅ Claude will ask for permission before executing sensitive tools.'}`,
          thread_ts: thread_ts || ts,
        });
      } else if (bypassAction === 'on') {
        userSettingsStore.setUserBypassPermission(user, true);
        await say({
          text: `✅ *Permission Bypass Enabled*\n\nClaude will now execute tools without asking for permission.\n\n⚠️ _Use with caution - this allows Claude to perform actions automatically._`,
          thread_ts: thread_ts || ts,
        });
      } else if (bypassAction === 'off') {
        userSettingsStore.setUserBypassPermission(user, false);
        await say({
          text: `✅ *Permission Bypass Disabled*\n\nClaude will now ask for your permission before executing sensitive tools.`,
          thread_ts: thread_ts || ts,
        });
      }
      return;
    }

    // Check if this is a persona command (only if there's text)
    if (text && this.isPersonaCommand(text)) {
      const personaAction = this.parsePersonaCommand(text);

      if (personaAction.action === 'status') {
        const currentPersona = userSettingsStore.getUserPersona(user);
        const availablePersonas = getAvailablePersonas();
        await say({
          text: `🎭 *Persona Status*\n\nYour current persona: \`${currentPersona}\`\n\nAvailable personas: ${availablePersonas.map(p => `\`${p}\``).join(', ')}\n\n_Use \`persona set <name>\` to change your persona._`,
          thread_ts: thread_ts || ts,
        });
      } else if (personaAction.action === 'list') {
        const availablePersonas = getAvailablePersonas();
        const currentPersona = userSettingsStore.getUserPersona(user);
        const personaList = availablePersonas
          .map(p => p === currentPersona ? `• \`${p}\` _(current)_` : `• \`${p}\``)
          .join('\n');
        await say({
          text: `🎭 *Available Personas*\n\n${personaList}\n\n_Use \`persona set <name>\` to change your persona._`,
          thread_ts: thread_ts || ts,
        });
      } else if (personaAction.action === 'set' && personaAction.persona) {
        const availablePersonas = getAvailablePersonas();
        if (availablePersonas.includes(personaAction.persona)) {
          userSettingsStore.setUserPersona(user, personaAction.persona);
          await say({
            text: `✅ *Persona Changed*\n\nYour persona is now set to: \`${personaAction.persona}\``,
            thread_ts: thread_ts || ts,
          });
        } else {
          await say({
            text: `❌ *Unknown Persona*\n\nPersona \`${personaAction.persona}\` not found.\n\nAvailable personas: ${availablePersonas.map(p => `\`${p}\``).join(', ')}`,
            thread_ts: thread_ts || ts,
          });
        }
      }
      return;
    }

    // Check if this is a restore credentials command (only if there's text)
    if (text && this.isRestoreCommand(text)) {
      await this.handleRestoreCommand(channel, thread_ts || ts, say);
      return;
    }

    // Check if this is a help command (only if there's text)
    if (text && this.isHelpCommand(text)) {
      await say({
        text: this.getHelpMessage(),
        thread_ts: thread_ts || ts,
      });
      return;
    }

    // Check if this is a sessions command
    if (text && this.isSessionsCommand(text)) {
      await say({
        text: await this.formatUserSessions(user),
        thread_ts: thread_ts || ts,
      });
      return;
    }

    // Check if this is an all_sessions command
    if (text && this.isAllSessionsCommand(text)) {
      await say({
        text: await this.formatAllSessions(),
        thread_ts: thread_ts || ts,
      });
      return;
    }

    // Check if we have a working directory set
    const isDM = channel.startsWith('D');
    // Always pass userId to auto-apply user's saved default if available
    const workingDirectory = this.workingDirManager.getWorkingDirectory(
      channel,
      thread_ts,
      user
    );

    // Working directory is always required
    if (!workingDirectory) {
      let errorMessage = `⚠️ No working directory set. `;
      
      if (!isDM && !this.workingDirManager.hasChannelWorkingDirectory(channel)) {
        // No channel default set
        errorMessage += `Please set a default working directory for this channel first using:\n`;
        if (config.baseDirectory) {
          errorMessage += `\`cwd project-name\` or \`cwd /absolute/path\`\n\n`;
          errorMessage += `Base directory: \`${config.baseDirectory}\``;
        } else {
          errorMessage += `\`cwd /path/to/directory\``;
        }
      } else if (thread_ts) {
        // In thread but no thread-specific directory
        errorMessage += `You can set a thread-specific working directory using:\n`;
        if (config.baseDirectory) {
          errorMessage += `\`@claudebot cwd project-name\` or \`@claudebot cwd /absolute/path\``;
        } else {
          errorMessage += `\`@claudebot cwd /path/to/directory\``;
        }
      } else {
        errorMessage += `Please set one first using:\n\`cwd /path/to/directory\``;
      }
      
      await say({
        text: errorMessage,
        thread_ts: thread_ts || ts,
      });
      return;
    }

    const sessionKey = this.claudeHandler.getSessionKey(user, channel, thread_ts || ts);
    
    // Store the original message info for status reactions
    const originalMessageTs = thread_ts || ts;
    this.originalMessages.set(sessionKey, { channel, ts: originalMessageTs });
    
    // Cancel any existing request for this conversation
    const existingController = this.activeControllers.get(sessionKey);
    if (existingController) {
      this.logger.debug('Cancelling existing request for session', { sessionKey });
      existingController.abort();
    }

    const abortController = new AbortController();
    this.activeControllers.set(sessionKey, abortController);

    let session = this.claudeHandler.getSession(user, channel, thread_ts || ts);
    if (!session) {
      this.logger.debug('Creating new session', { sessionKey });
      session = this.claudeHandler.createSession(user, channel, thread_ts || ts);
    } else {
      this.logger.debug('Using existing session', { sessionKey, sessionId: session.sessionId });
    }

    let currentMessages: string[] = [];
    let statusMessageTs: string | undefined;

    try {
      // Prepare the prompt with file attachments
      let finalPrompt = processedFiles.length > 0
        ? await this.fileHandler.formatFilePrompt(processedFiles, text || '')
        : text || '';

      // Inject user info (Jira name, Slack name) at the end of the prompt
      const userInfo = this.getUserInfoContext(user);
      if (userInfo) {
        finalPrompt = `${finalPrompt}\n\n${userInfo}`;
      }

      this.logger.info('Sending query to Claude Code SDK', { 
        prompt: finalPrompt.substring(0, 200) + (finalPrompt.length > 200 ? '...' : ''), 
        sessionId: session.sessionId,
        workingDirectory,
        fileCount: processedFiles.length,
      });

      // Send initial status message
      const statusResult = await say({
        text: '🤔 *Thinking...*',
        thread_ts: thread_ts || ts,
      });
      statusMessageTs = statusResult.ts;

      // Add thinking reaction to original message (but don't spam if already set)
      await this.updateMessageReaction(sessionKey, 'thinking_face');
      
      // Create Slack context for permission prompts
      const slackContext = {
        channel,
        threadTs: thread_ts || ts,  // Always provide a thread context
        user
      };
      
      for await (const message of this.claudeHandler.streamQuery(finalPrompt, session, abortController, workingDirectory, slackContext)) {
        if (abortController.signal.aborted) break;

        this.logger.debug('Received message from Claude SDK', {
          type: message.type,
          subtype: (message as any).subtype,
          message: message,
        });

        if (message.type === 'assistant') {
          // Check if this is a tool use message
          const hasToolUse = message.message.content?.some((part: any) => part.type === 'tool_use');
          
          if (hasToolUse) {
            // Update status to show working
            if (statusMessageTs) {
              await this.app.client.chat.update({
                channel,
                ts: statusMessageTs,
                text: '⚙️ *Working...*',
              });
            }

            // Update reaction to show working
            await this.updateMessageReaction(sessionKey, 'gear');

            // Check for TodoWrite tool and handle it specially
            const todoTool = message.message.content?.find((part: any) =>
              part.type === 'tool_use' && part.name === 'TodoWrite'
            );

            if (todoTool) {
              await this.handleTodoUpdate(todoTool.input, sessionKey, session?.sessionId, channel, thread_ts || ts, say);
            }

            // For other tool use messages, format them immediately as new messages
            const toolContent = this.formatToolUse(message.message.content);
            if (toolContent) { // Only send if there's content (TodoWrite returns empty string)
              await say({
                text: toolContent,
                thread_ts: thread_ts || ts,
              });
            }

            // Track all tool_use_id -> tool_name mappings and start MCP status AFTER tool use message
            for (const part of message.message.content || []) {
              if (part.type === 'tool_use' && part.id && part.name) {
                this.toolUseIdToName.set(part.id, part.name);

                // Start tracking MCP calls (after the tool use message is sent)
                if (part.name.startsWith('mcp__')) {
                  const nameParts = part.name.split('__');
                  const serverName = nameParts[1] || 'unknown';
                  const actualToolName = nameParts.slice(2).join('__') || part.name;
                  const callId = mcpCallTracker.startCall(serverName, actualToolName);
                  this.toolUseIdToCallId.set(part.id, callId);

                  // Start periodic status update for this MCP call
                  this.startMcpStatusUpdate(callId, serverName, actualToolName, channel, thread_ts || ts);
                }
              }
            }
          } else {
            // Handle regular text content
            const content = this.extractTextContent(message);
            if (content) {
              currentMessages.push(content);
              
              // Send each new piece of content as a separate message
              const formatted = this.formatMessage(content, false);
              await say({
                text: formatted,
                thread_ts: thread_ts || ts,
              });
            }
          }
        } else if (message.type === 'user') {
          // Handle synthetic user messages (tool_result)
          const userMessage = message as any;

          // Log to debug what we're receiving
          this.logger.debug('Received user message', {
            isSynthetic: userMessage.isSynthetic,
            hasContent: !!userMessage.message?.content,
            contentLength: userMessage.message?.content?.length,
            contentTypes: userMessage.message?.content?.map((c: any) => c.type),
          });

          // Handle tool results from synthetic messages or direct content
          const content = userMessage.message?.content || userMessage.content;
          if (content) {
            const toolResults = this.extractToolResults(content);

            this.logger.debug('Extracted tool results', {
              count: toolResults.length,
              toolNames: toolResults.map(r => r.toolName || this.toolUseIdToName.get(r.toolUseId)),
            });

            for (const toolResult of toolResults) {
              // Lookup tool name from our tracking map if not already set
              if (!toolResult.toolName && toolResult.toolUseId) {
                toolResult.toolName = this.toolUseIdToName.get(toolResult.toolUseId);
              }

              // End MCP call tracking and get duration
              let duration: number | null = null;
              if (toolResult.toolUseId) {
                const callId = this.toolUseIdToCallId.get(toolResult.toolUseId);
                if (callId) {
                  duration = mcpCallTracker.endCall(callId);
                  this.toolUseIdToCallId.delete(toolResult.toolUseId);

                  // Stop the status update interval and show completion
                  await this.stopMcpStatusUpdate(callId, duration);
                }
              }

              // Show MCP tool results in detail
              if (toolResult.toolName?.startsWith('mcp__')) {
                this.logger.info('Formatting MCP tool result', {
                  toolName: toolResult.toolName,
                  hasResult: !!toolResult.result,
                  resultType: typeof toolResult.result,
                  isError: toolResult.isError,
                  duration,
                });

                const formatted = this.formatMcpToolResult(toolResult, duration);
                if (formatted) {
                  await say({
                    text: formatted,
                    thread_ts: thread_ts || ts,
                  });
                }
              }
            }
          }
        } else if (message.type === 'result') {
          this.logger.info('Received result from Claude SDK', {
            subtype: message.subtype,
            hasResult: message.subtype === 'success' && !!(message as any).result,
            totalCost: (message as any).total_cost_usd,
            duration: (message as any).duration_ms,
          });

          if (message.subtype === 'success' && (message as any).result) {
            const finalResult = (message as any).result;
            if (finalResult && !currentMessages.includes(finalResult)) {
              const formatted = this.formatMessage(finalResult, true);
              await say({
                text: formatted,
                thread_ts: thread_ts || ts,
              });
            }
          }
        }
      }

      // Update status to completed
      if (statusMessageTs) {
        await this.app.client.chat.update({
          channel,
          ts: statusMessageTs,
          text: '✅ *Task completed*',
        });
      }

      // Update reaction to show completion
      await this.updateMessageReaction(sessionKey, 'white_check_mark');

      this.logger.info('Completed processing message', {
        sessionKey,
        messageCount: currentMessages.length,
      });

      // Clean up temporary files
      if (processedFiles.length > 0) {
        await this.fileHandler.cleanupTempFiles(processedFiles);
      }
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        this.logger.error('Error handling message', error);
        
        // Update status to error
        if (statusMessageTs) {
          await this.app.client.chat.update({
            channel,
            ts: statusMessageTs,
            text: '❌ *Error occurred*',
          });
        }

        // Update reaction to show error
        await this.updateMessageReaction(sessionKey, 'x');
        
        await say({
          text: `Error: ${error.message || 'Something went wrong'}`,
          thread_ts: thread_ts || ts,
        });
      } else {
        this.logger.debug('Request was aborted', { sessionKey });
        
        // Update status to cancelled
        if (statusMessageTs) {
          await this.app.client.chat.update({
            channel,
            ts: statusMessageTs,
            text: '⏹️ *Cancelled*',
          });
        }

        // Update reaction to show cancellation
        await this.updateMessageReaction(sessionKey, 'stop_sign');
      }

      // Clean up temporary files in case of error too
      if (processedFiles.length > 0) {
        await this.fileHandler.cleanupTempFiles(processedFiles);
      }
    } finally {
      this.activeControllers.delete(sessionKey);

      // Clean up todo tracking if session ended
      if (session?.sessionId) {
        // Don't immediately clean up - keep todos visible for a while
        setTimeout(() => {
          this.todoManager.cleanupSession(session.sessionId!);
          this.todoMessages.delete(sessionKey);
          this.originalMessages.delete(sessionKey);
          this.currentReactions.delete(sessionKey);
          // Clean up tool tracking
          this.toolUseIdToName.clear();
        }, 5 * 60 * 1000); // 5 minutes
      }
    }
  }

  private extractTextContent(message: SDKMessage): string | null {
    if (message.type === 'assistant' && message.message.content) {
      const textParts = message.message.content
        .filter((part: any) => part.type === 'text')
        .map((part: any) => part.text);
      return textParts.join('');
    }
    return null;
  }

  private formatToolUse(content: any[]): string {
    const parts: string[] = [];
    
    for (const part of content) {
      if (part.type === 'text') {
        parts.push(part.text);
      } else if (part.type === 'tool_use') {
        const toolName = part.name;
        const input = part.input;
        
        switch (toolName) {
          case 'Edit':
          case 'MultiEdit':
            parts.push(this.formatEditTool(toolName, input));
            break;
          case 'Write':
            parts.push(this.formatWriteTool(input));
            break;
          case 'Read':
            parts.push(this.formatReadTool(input));
            break;
          case 'Bash':
            parts.push(this.formatBashTool(input));
            break;
          case 'TodoWrite':
            // Handle TodoWrite separately - don't include in regular tool output
            return this.handleTodoWrite(input);
          case 'mcp__permission-prompt__permission_prompt':
            // Don't show permission prompt tool usage - it's handled internally
            return '';
          default:
            parts.push(this.formatGenericTool(toolName, input));
        }
      }
    }
    
    return parts.join('\n\n');
  }

  private formatEditTool(toolName: string, input: any): string {
    const filePath = input.file_path;
    const edits = toolName === 'MultiEdit' ? input.edits : [{ old_string: input.old_string, new_string: input.new_string }];
    
    let result = `📝 *Editing \`${filePath}\`*\n`;
    
    for (const edit of edits) {
      result += '\n```diff\n';
      result += `- ${this.truncateString(edit.old_string, 200)}\n`;
      result += `+ ${this.truncateString(edit.new_string, 200)}\n`;
      result += '```';
    }
    
    return result;
  }

  private formatWriteTool(input: any): string {
    const filePath = input.file_path;
    const preview = this.truncateString(input.content, 300);
    
    return `📄 *Creating \`${filePath}\`*\n\`\`\`\n${preview}\n\`\`\``;
  }

  private formatReadTool(input: any): string {
    return `👁️ *Reading \`${input.file_path}\`*`;
  }

  private formatBashTool(input: any): string {
    return `🖥️ *Running command:*\n\`\`\`bash\n${input.command}\n\`\`\``;
  }

  private formatGenericTool(toolName: string, input: any): string {
    // Check if this is an MCP tool
    if (toolName.startsWith('mcp__')) {
      return this.formatMcpTool(toolName, input);
    }
    return `🔧 *Using ${toolName}*`;
  }

  private formatMcpTool(toolName: string, input: any): string {
    // Parse MCP tool name: mcp__serverName__toolName
    const parts = toolName.split('__');
    const serverName = parts[1] || 'unknown';
    const actualToolName = parts.slice(2).join('__') || toolName;

    let result = `🔌 *MCP: ${serverName} → ${actualToolName}*\n`;

    // Format input parameters
    if (input && typeof input === 'object') {
      const inputStr = this.formatMcpInput(input);
      if (inputStr) {
        result += inputStr;
      }
    }

    return result;
  }

  private formatMcpInput(input: any): string {
    if (!input || typeof input !== 'object') {
      return '';
    }

    const lines: string[] = [];

    for (const [key, value] of Object.entries(input)) {
      if (value === undefined || value === null) continue;

      if (typeof value === 'string') {
        // Truncate long strings
        const displayValue = value.length > 500
          ? value.substring(0, 500) + '...'
          : value;

        // Check if it's multiline
        if (displayValue.includes('\n')) {
          lines.push(`*${key}:*\n\`\`\`\n${displayValue}\n\`\`\``);
        } else {
          lines.push(`*${key}:* \`${displayValue}\``);
        }
      } else if (typeof value === 'object') {
        try {
          const jsonStr = JSON.stringify(value, null, 2);
          const truncated = jsonStr.length > 300
            ? jsonStr.substring(0, 300) + '...'
            : jsonStr;
          lines.push(`*${key}:*\n\`\`\`json\n${truncated}\n\`\`\``);
        } catch {
          lines.push(`*${key}:* [complex object]`);
        }
      } else {
        lines.push(`*${key}:* \`${String(value)}\``);
      }
    }

    return lines.join('\n');
  }

  private extractToolResults(content: any[]): Array<{ toolName?: string; toolUseId: string; result: any; isError?: boolean }> {
    const results: Array<{ toolName?: string; toolUseId: string; result: any; isError?: boolean }> = [];

    if (!Array.isArray(content)) {
      return results;
    }

    for (const part of content) {
      if (part.type === 'tool_result') {
        results.push({
          toolUseId: part.tool_use_id,
          result: part.content,
          isError: part.is_error,
          // Tool name might be stored in metadata or we need to track it
          toolName: (part as any).tool_name,
        });
      }
    }

    return results;
  }

  private formatMcpToolResult(toolResult: { toolName?: string; toolUseId: string; result: any; isError?: boolean }, duration?: number | null): string | null {
    const { toolName, result, isError } = toolResult;

    // Parse MCP tool name if available
    let serverName = 'unknown';
    let actualToolName = 'unknown';

    if (toolName?.startsWith('mcp__')) {
      const parts = toolName.split('__');
      serverName = parts[1] || 'unknown';
      actualToolName = parts.slice(2).join('__') || toolName;
    }

    const statusIcon = isError ? '❌' : '✅';
    let formatted = `${statusIcon} *MCP Result: ${serverName} → ${actualToolName}*`;

    // Add duration info
    if (duration !== null && duration !== undefined) {
      formatted += ` (${McpCallTracker.formatDuration(duration)})`;

      // Add average prediction info
      const stats = mcpCallTracker.getToolStats(serverName, actualToolName);
      if (stats && stats.callCount > 1) {
        formatted += ` | 평균: ${McpCallTracker.formatDuration(stats.avgDuration)}`;
      }
    }
    formatted += '\n';

    // Format the result content
    if (result) {
      if (typeof result === 'string') {
        const truncated = result.length > 1000
          ? result.substring(0, 1000) + '...'
          : result;

        if (truncated.includes('\n')) {
          formatted += `\`\`\`\n${truncated}\n\`\`\``;
        } else {
          formatted += `\`${truncated}\``;
        }
      } else if (Array.isArray(result)) {
        // Handle array of content blocks (common MCP format)
        for (const item of result) {
          if (item.type === 'text' && item.text) {
            const truncated = item.text.length > 1000
              ? item.text.substring(0, 1000) + '...'
              : item.text;
            formatted += `\`\`\`\n${truncated}\n\`\`\``;
          } else if (item.type === 'image') {
            formatted += `_[Image data]_`;
          } else if (typeof item === 'object') {
            try {
              const jsonStr = JSON.stringify(item, null, 2);
              const truncated = jsonStr.length > 500
                ? jsonStr.substring(0, 500) + '...'
                : jsonStr;
              formatted += `\`\`\`json\n${truncated}\n\`\`\``;
            } catch {
              formatted += `_[Complex result]_`;
            }
          }
        }
      } else if (typeof result === 'object') {
        try {
          const jsonStr = JSON.stringify(result, null, 2);
          const truncated = jsonStr.length > 500
            ? jsonStr.substring(0, 500) + '...'
            : jsonStr;
          formatted += `\`\`\`json\n${truncated}\n\`\`\``;
        } catch {
          formatted += `_[Complex result]_`;
        }
      }
    } else {
      formatted += `_[No result content]_`;
    }

    return formatted;
  }

  private truncateString(str: string, maxLength: number): string {
    if (!str) return '';
    if (str.length <= maxLength) return str;
    return str.substring(0, maxLength) + '...';
  }

  private handleTodoWrite(input: any): string {
    // TodoWrite tool doesn't produce visible output - handled separately
    return '';
  }

  private async handleTodoUpdate(
    input: any, 
    sessionKey: string, 
    sessionId: string | undefined, 
    channel: string, 
    threadTs: string, 
    say: any
  ): Promise<void> {
    if (!sessionId || !input.todos) {
      return;
    }

    const newTodos: Todo[] = input.todos;
    const oldTodos = this.todoManager.getTodos(sessionId);
    
    // Check if there's a significant change
    if (this.todoManager.hasSignificantChange(oldTodos, newTodos)) {
      // Update the todo manager
      this.todoManager.updateTodos(sessionId, newTodos);
      
      // Format the todo list
      const todoList = this.todoManager.formatTodoList(newTodos);
      
      // Check if we already have a todo message for this session
      const existingTodoMessageTs = this.todoMessages.get(sessionKey);
      
      if (existingTodoMessageTs) {
        // Update existing todo message
        try {
          await this.app.client.chat.update({
            channel,
            ts: existingTodoMessageTs,
            text: todoList,
          });
          this.logger.debug('Updated existing todo message', { sessionKey, messageTs: existingTodoMessageTs });
        } catch (error) {
          this.logger.warn('Failed to update todo message, creating new one', error);
          // If update fails, create a new message
          await this.createNewTodoMessage(todoList, channel, threadTs, sessionKey, say);
        }
      } else {
        // Create new todo message
        await this.createNewTodoMessage(todoList, channel, threadTs, sessionKey, say);
      }

      // Send status change notification if there are meaningful changes
      const statusChange = this.todoManager.getStatusChange(oldTodos, newTodos);
      if (statusChange) {
        await say({
          text: `🔄 *Task Update:*\n${statusChange}`,
          thread_ts: threadTs,
        });
      }

      // Update reaction based on overall progress
      await this.updateTaskProgressReaction(sessionKey, newTodos);
    }
  }

  private async createNewTodoMessage(
    todoList: string, 
    channel: string, 
    threadTs: string, 
    sessionKey: string, 
    say: any
  ): Promise<void> {
    const result = await say({
      text: todoList,
      thread_ts: threadTs,
    });
    
    if (result?.ts) {
      this.todoMessages.set(sessionKey, result.ts);
      this.logger.debug('Created new todo message', { sessionKey, messageTs: result.ts });
    }
  }

  private async updateMessageReaction(sessionKey: string, emoji: string): Promise<void> {
    const originalMessage = this.originalMessages.get(sessionKey);
    if (!originalMessage) {
      return;
    }

    // Check if we're already showing this emoji
    const currentEmoji = this.currentReactions.get(sessionKey);
    if (currentEmoji === emoji) {
      this.logger.debug('Reaction already set, skipping', { sessionKey, emoji });
      return;
    }

    try {
      // Remove the current reaction if it exists
      if (currentEmoji) {
        try {
          await this.app.client.reactions.remove({
            channel: originalMessage.channel,
            timestamp: originalMessage.ts,
            name: currentEmoji,
          });
          this.logger.debug('Removed previous reaction', { sessionKey, emoji: currentEmoji });
        } catch (error) {
          this.logger.debug('Failed to remove previous reaction (might not exist)', { 
            sessionKey, 
            emoji: currentEmoji,
            error: (error as any).message 
          });
        }
      }

      // Add the new reaction
      await this.app.client.reactions.add({
        channel: originalMessage.channel,
        timestamp: originalMessage.ts,
        name: emoji,
      });

      // Track the current reaction
      this.currentReactions.set(sessionKey, emoji);

      this.logger.debug('Updated message reaction', { 
        sessionKey, 
        emoji, 
        previousEmoji: currentEmoji,
        channel: originalMessage.channel, 
        ts: originalMessage.ts 
      });
    } catch (error) {
      this.logger.warn('Failed to update message reaction', error);
    }
  }

  private async updateTaskProgressReaction(sessionKey: string, todos: Todo[]): Promise<void> {
    if (todos.length === 0) {
      return;
    }

    const completed = todos.filter(t => t.status === 'completed').length;
    const inProgress = todos.filter(t => t.status === 'in_progress').length;
    const total = todos.length;

    let emoji: string;
    if (completed === total) {
      emoji = 'white_check_mark'; // All tasks completed
    } else if (inProgress > 0) {
      emoji = 'arrows_counterclockwise'; // Tasks in progress
    } else {
      emoji = 'clipboard'; // Tasks pending
    }

    await this.updateMessageReaction(sessionKey, emoji);
  }

  private getUserInfoContext(userId: string): string | null {
    const jiraName = userSettingsStore.getUserJiraName(userId);
    const jiraAccountId = userSettingsStore.getUserJiraAccountId(userId);
    const settings = userSettingsStore.getUserSettings(userId);
    const slackName = settings?.slackName;

    if (!jiraName && !slackName) {
      return null;
    }

    const lines: string[] = ['<user-context>'];
    if (slackName) {
      lines.push(`  <slack-name>${slackName}</slack-name>`);
    }
    if (jiraName) {
      lines.push(`  <jira-name>${jiraName}</jira-name>`);
    }
    if (jiraAccountId) {
      lines.push(`  <jira-account-id>${jiraAccountId}</jira-account-id>`);
    }
    lines.push('</user-context>');

    return lines.join('\n');
  }

  private isMcpInfoCommand(text: string): boolean {
    return /^\/?(?:mcp|servers?)(?:\s+(?:info|list|status))?(?:\?)?$/i.test(text.trim());
  }

  private isMcpReloadCommand(text: string): boolean {
    return /^\/?(?:mcp|servers?)\s+(?:reload|refresh)$/i.test(text.trim());
  }

  private isBypassCommand(text: string): boolean {
    return /^\/?bypass(?:\s+(?:on|off|true|false|enable|disable|status))?$/i.test(text.trim());
  }

  private parseBypassCommand(text: string): 'on' | 'off' | 'status' {
    const match = text.trim().match(/^\/?bypass(?:\s+(on|off|true|false|enable|disable|status))?$/i);
    if (!match || !match[1]) {
      return 'status';
    }
    const action = match[1].toLowerCase();
    if (action === 'on' || action === 'true' || action === 'enable') {
      return 'on';
    }
    if (action === 'off' || action === 'false' || action === 'disable') {
      return 'off';
    }
    return 'status';
  }

  private isPersonaCommand(text: string): boolean {
    return /^\/?persona(?:\s+(?:list|status|set\s+\S+))?$/i.test(text.trim());
  }

  private parsePersonaCommand(text: string): { action: 'list' | 'status' | 'set'; persona?: string } {
    const trimmed = text.trim();

    if (/^\/?persona\s+list$/i.test(trimmed)) {
      return { action: 'list' };
    }

    const setMatch = trimmed.match(/^\/?persona\s+set\s+(\S+)$/i);
    if (setMatch) {
      return { action: 'set', persona: setMatch[1] };
    }

    return { action: 'status' };
  }

  private isRestoreCommand(text: string): boolean {
    return /^\/?(?:restore|credentials?)(?:\s+(?:restore|status))?$/i.test(text.trim());
  }

  private isHelpCommand(text: string): boolean {
    return /^\/?(?:help|commands?)(?:\?)?$/i.test(text.trim());
  }

  private getHelpMessage(): string {
    const commands = [
      '*📚 Available Commands*',
      '',
      '*Working Directory:*',
      '• `cwd <path>` or `/cwd <path>` - Set working directory',
      '• `cwd` or `/cwd` - Show current working directory',
      '',
      '*Sessions:*',
      '• `sessions` or `/sessions` - Show your active sessions',
      '• `all_sessions` or `/all_sessions` - Show all active sessions',
      '',
      '*MCP Servers:*',
      '• `mcp` or `/mcp` - Show MCP server status',
      '• `mcp reload` or `/mcp reload` - Reload MCP configuration',
      '',
      '*Permissions:*',
      '• `bypass` or `/bypass` - Show permission bypass status',
      '• `bypass on` or `/bypass on` - Enable permission bypass',
      '• `bypass off` or `/bypass off` - Disable permission bypass',
      '',
      '*Persona:*',
      '• `persona` or `/persona` - Show current persona',
      '• `persona list` or `/persona list` - List available personas',
      '• `persona set <name>` or `/persona set <name>` - Set persona',
      '',
      '*Credentials:*',
      '• `restore` or `/restore` - Restore Claude credentials from backup',
      '',
      '*Help:*',
      '• `help` or `/help` - Show this help message',
    ];
    return commands.join('\n');
  }

  private isSessionsCommand(text: string): boolean {
    return /^\/?sessions?$/i.test(text.trim());
  }

  private isAllSessionsCommand(text: string): boolean {
    return /^\/?all_sessions?$/i.test(text.trim());
  }

  /**
   * Format time elapsed since a date in human-readable Korean
   */
  private formatTimeAgo(date: Date): string {
    const now = Date.now();
    const diff = now - date.getTime();

    const minutes = Math.floor(diff / (60 * 1000));
    const hours = Math.floor(diff / (60 * 60 * 1000));
    const days = Math.floor(diff / (24 * 60 * 60 * 1000));

    if (days > 0) {
      return `${days}일 ${hours % 24}시간 전`;
    } else if (hours > 0) {
      return `${hours}시간 ${minutes % 60}분 전`;
    } else if (minutes > 0) {
      return `${minutes}분 전`;
    } else {
      return '방금 전';
    }
  }

  /**
   * Format session expiry time remaining
   */
  private formatExpiresIn(lastActivity: Date): string {
    const SESSION_TIMEOUT = 24 * 60 * 60 * 1000; // 24 hours
    const expiresAt = lastActivity.getTime() + SESSION_TIMEOUT;
    const remaining = expiresAt - Date.now();

    if (remaining <= 0) {
      return '만료됨';
    }

    const hours = Math.floor(remaining / (60 * 60 * 1000));
    const minutes = Math.floor((remaining % (60 * 60 * 1000)) / (60 * 1000));

    if (hours > 0) {
      return `${hours}시간 ${minutes}분 남음`;
    }
    return `${minutes}분 남음`;
  }

  /**
   * Get username from Slack user ID
   */
  private async getUserName(userId: string): Promise<string> {
    try {
      const result = await this.app.client.users.info({ user: userId });
      return result.user?.real_name || result.user?.name || userId;
    } catch {
      return userId;
    }
  }

  /**
   * Get channel name from channel ID
   */
  private async getChannelName(channelId: string): Promise<string> {
    try {
      // DM channels start with 'D'
      if (channelId.startsWith('D')) {
        return 'DM';
      }
      const result = await this.app.client.conversations.info({ channel: channelId });
      return `#${(result.channel as any)?.name || channelId}`;
    } catch {
      return channelId;
    }
  }

  /**
   * Format sessions for a specific user
   */
  private async formatUserSessions(userId: string): Promise<string> {
    const allSessions = this.claudeHandler.getAllSessions();
    const userSessions: Array<{ key: string; session: ConversationSession }> = [];

    for (const [key, session] of allSessions.entries()) {
      if (session.userId === userId && session.sessionId) {
        userSessions.push({ key, session });
      }
    }

    if (userSessions.length === 0) {
      return '📭 *활성 세션 없음*\n\n현재 진행 중인 세션이 없습니다.';
    }

    const lines: string[] = [
      `📋 *내 세션 목록* (${userSessions.length}개)`,
      '',
    ];

    // Sort by last activity (most recent first)
    userSessions.sort((a, b) => b.session.lastActivity.getTime() - a.session.lastActivity.getTime());

    for (let i = 0; i < userSessions.length; i++) {
      const { session } = userSessions[i];
      const channelName = await this.getChannelName(session.channelId);
      const timeAgo = this.formatTimeAgo(session.lastActivity);
      const expiresIn = this.formatExpiresIn(session.lastActivity);
      const workDir = session.workingDirectory ? `\`${session.workingDirectory}\`` : '_미설정_';

      lines.push(`*${i + 1}. ${channelName}*${session.threadTs ? ' (thread)' : ''}`);
      lines.push(`   📁 ${workDir}`);
      lines.push(`   🕐 마지막 활동: ${timeAgo}`);
      lines.push(`   ⏳ 만료: ${expiresIn}`);
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Format all sessions overview
   */
  private async formatAllSessions(): Promise<string> {
    const allSessions = this.claudeHandler.getAllSessions();
    const activeSessions: Array<{ key: string; session: ConversationSession }> = [];

    for (const [key, session] of allSessions.entries()) {
      if (session.sessionId) {
        activeSessions.push({ key, session });
      }
    }

    if (activeSessions.length === 0) {
      return '📭 *활성 세션 없음*\n\n현재 진행 중인 세션이 없습니다.';
    }

    const lines: string[] = [
      `🌐 *전체 세션 현황* (${activeSessions.length}개)`,
      '',
    ];

    // Sort by last activity (most recent first)
    activeSessions.sort((a, b) => b.session.lastActivity.getTime() - a.session.lastActivity.getTime());

    // Group by user
    const sessionsByUser = new Map<string, Array<{ key: string; session: ConversationSession }>>();
    for (const item of activeSessions) {
      const userId = item.session.userId;
      if (!sessionsByUser.has(userId)) {
        sessionsByUser.set(userId, []);
      }
      sessionsByUser.get(userId)!.push(item);
    }

    for (const [userId, sessions] of sessionsByUser.entries()) {
      const userName = await this.getUserName(userId);
      lines.push(`👤 *${userName}* (${sessions.length}개 세션)`);

      for (const { session } of sessions) {
        const channelName = await this.getChannelName(session.channelId);
        const timeAgo = this.formatTimeAgo(session.lastActivity);
        const expiresIn = this.formatExpiresIn(session.lastActivity);
        const workDir = session.workingDirectory
          ? session.workingDirectory.split('/').pop() || session.workingDirectory
          : '-';

        lines.push(`   • ${channelName}${session.threadTs ? ' (thread)' : ''} | 📁 \`${workDir}\` | 🕐 ${timeAgo} | ⏳ ${expiresIn}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  private async handleRestoreCommand(channel: string, threadTs: string, say: any): Promise<void> {
    // Check if credential manager is enabled
    if (!isCredentialManagerEnabled()) {
      await say({
        text: '⚠️ Credential manager is disabled.\n\nTo enable, set `ENABLE_LOCAL_FILE_CREDENTIALS_JSON=1` in your environment.',
        thread_ts: threadTs,
      });
      return;
    }

    // Get status before restore
    const beforeStatus = getCredentialStatus();

    // Format before status message
    const beforeLines: string[] = [
      '🔑 *Credential Restore*',
      '',
      '*현재 상태 (복사 전):*',
      `• 크레덴셜 파일 존재 (\`.credentials.json\`): ${beforeStatus.credentialsFileExists ? '✅' : '❌'}`,
      `• 백업 파일 존재 (\`credentials.json\`): ${beforeStatus.backupFileExists ? '✅' : '❌'}`,
      `• claudeAiOauth 존재: ${beforeStatus.hasClaudeAiOauth ? '✅' : '❌'}`,
      `• 자동 복원 활성화: ${beforeStatus.autoRestoreEnabled ? '✅' : '❌'}`,
    ];

    await say({
      text: beforeLines.join('\n'),
      thread_ts: threadTs,
    });

    // Attempt to copy backup credentials
    this.logger.info('Attempting credential restore via command');
    const copySuccess = copyBackupCredentials();

    // Get status after restore
    const afterHasOauth = hasClaudeAiOauth();
    const afterStatus = getCredentialStatus();

    // Format result message
    const resultLines: string[] = [];

    if (copySuccess) {
      resultLines.push('✅ *복사 완료*');
      resultLines.push('');
      resultLines.push('`~/.claude/credentials.json` → `~/.claude/.credentials.json`');
    } else {
      resultLines.push('❌ *복사 실패*');
      resultLines.push('');
      if (!beforeStatus.backupFileExists) {
        resultLines.push('백업 파일 (`credentials.json`)이 존재하지 않습니다.');
      } else {
        resultLines.push('파일 복사 중 오류가 발생했습니다.');
      }
    }

    resultLines.push('');
    resultLines.push('*복사 후 상태:*');
    resultLines.push(`• 크레덴셜 파일 존재: ${afterStatus.credentialsFileExists ? '✅' : '❌'}`);
    resultLines.push(`• claudeAiOauth 존재: ${afterHasOauth ? '✅' : '❌'}`);

    if (afterHasOauth) {
      resultLines.push('');
      resultLines.push('🎉 Claude 인증이 정상적으로 설정되었습니다!');
    } else if (copySuccess) {
      resultLines.push('');
      resultLines.push('⚠️ 파일은 복사되었지만 claudeAiOauth가 없습니다.');
      resultLines.push('`claude login` 명령어로 다시 로그인해주세요.');
    }

    await say({
      text: resultLines.join('\n'),
      thread_ts: threadTs,
    });

    this.logger.info('Credential restore command completed', {
      copySuccess,
      beforeHadOauth: beforeStatus.hasClaudeAiOauth,
      afterHasOauth,
    });
  }

  private async getBotUserId(): Promise<string> {
    if (!this.botUserId) {
      try {
        const response = await this.app.client.auth.test();
        this.botUserId = response.user_id as string;
      } catch (error) {
        this.logger.error('Failed to get bot user ID', error);
        this.botUserId = '';
      }
    }
    return this.botUserId;
  }

  private async handleChannelJoin(channelId: string, say: any): Promise<void> {
    try {
      // Get channel info
      const channelInfo = await this.app.client.conversations.info({
        channel: channelId,
      });

      const channelName = (channelInfo.channel as any)?.name || 'this channel';
      
      let welcomeMessage = `👋 Hi! I'm Claude Code, your AI coding assistant.\n\n`;
      welcomeMessage += `To get started, I need to know the default working directory for #${channelName}.\n\n`;
      
      if (config.baseDirectory) {
        welcomeMessage += `You can use:\n`;
        welcomeMessage += `• \`cwd project-name\` (relative to base directory: \`${config.baseDirectory}\`)\n`;
        welcomeMessage += `• \`cwd /absolute/path/to/project\` (absolute path)\n\n`;
      } else {
        welcomeMessage += `Please set it using:\n`;
        welcomeMessage += `• \`cwd /path/to/project\` or \`set directory /path/to/project\`\n\n`;
      }
      
      welcomeMessage += `This will be the default working directory for this channel. `;
      welcomeMessage += `You can always override it for specific threads by mentioning me with a different \`cwd\` command.\n\n`;
      welcomeMessage += `Once set, you can ask me to help with code reviews, file analysis, debugging, and more!`;

      await say({
        text: welcomeMessage,
      });

      this.logger.info('Sent welcome message to channel', { channelId, channelName });
    } catch (error) {
      this.logger.error('Failed to handle channel join', error);
    }
  }

  private formatMessage(text: string, isFinal: boolean): string {
    // Convert markdown code blocks to Slack format
    let formatted = text
      .replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang, code) => {
        return '```' + code + '```';
      })
      .replace(/`([^`]+)`/g, '`$1`')
      .replace(/\*\*([^*]+)\*\*/g, '*$1*')
      .replace(/__([^_]+)__/g, '_$1_');

    return formatted;
  }

  setupEventHandlers() {
    // Handle direct messages
    this.app.message(async ({ message, say }) => {
      if (message.subtype === undefined && 'user' in message) {
        this.logger.info('Handling direct message event');
        await this.handleMessage(message as MessageEvent, say);
      }
    });

    // Handle app mentions
    this.app.event('app_mention', async ({ event, say }) => {
      this.logger.info('Handling app mention event');
      const text = event.text.replace(/<@[^>]+>/g, '').trim();
      await this.handleMessage({
        ...event,
        text,
      } as MessageEvent, say);
    });

    // Handle thread messages without mention (if session exists)
    this.app.event('message', async ({ event, say }) => {
      // Skip bot messages
      if ('bot_id' in event || !('user' in event)) {
        return;
      }

      const messageEvent = event as any;

      // Handle file uploads
      if (event.subtype === 'file_share' && messageEvent.files) {
        this.logger.info('Handling file upload event');
        await this.handleMessage(messageEvent as MessageEvent, say);
        return;
      }

      // Handle thread messages without mention if session exists
      if (event.subtype === undefined && messageEvent.thread_ts) {
        const user = messageEvent.user;
        const channel = messageEvent.channel;
        const threadTs = messageEvent.thread_ts;

        // Check if we have an existing session for this thread
        const session = this.claudeHandler.getSession(user, channel, threadTs);
        if (session?.sessionId) {
          this.logger.info('Handling thread message (session exists)', {
            user,
            channel,
            threadTs,
            sessionId: session.sessionId,
          });
          await this.handleMessage(messageEvent as MessageEvent, say);
        }
      }
    });

    // Handle bot being added to channels
    this.app.event('member_joined_channel', async ({ event, say }) => {
      // Check if the bot was added to the channel
      if (event.user === await this.getBotUserId()) {
        this.logger.info('Bot added to channel', { channel: event.channel });
        await this.handleChannelJoin(event.channel, say);
      }
    });

    // Handle permission approval button clicks
    this.app.action('approve_tool', async ({ ack, body, respond }) => {
      await ack();
      
      try {
        const approvalId = (body as any).actions[0].value;
        const user = (body as any).user?.id;
        const triggerId = (body as any).trigger_id;
        
        this.logger.info('Tool approval granted', { 
          approvalId, 
          user,
          triggerId 
        });
        
        // Resolve the approval via shared store
        const response: PermissionResponse = {
          behavior: 'allow',
          message: 'Approved by user'
        };
        await sharedStore.storePermissionResponse(approvalId, response);
        
        // Provide immediate feedback
        await respond({
          response_type: 'ephemeral',
          text: '✅ Tool execution approved. Claude will now proceed with the operation.',
          replace_original: false
        });
        
        this.logger.debug('Approval processed successfully', { approvalId });
      } catch (error) {
        this.logger.error('Error processing tool approval', error);
        
        await respond({
          response_type: 'ephemeral',
          text: '❌ Error processing approval. The request may have already been handled.',
          replace_original: false
        });
      }
    });

    // Handle permission denial button clicks
    this.app.action('deny_tool', async ({ ack, body, respond }) => {
      await ack();
      
      try {
        const approvalId = (body as any).actions[0].value;
        const user = (body as any).user?.id;
        const triggerId = (body as any).trigger_id;
        
        this.logger.info('Tool approval denied', { 
          approvalId, 
          user,
          triggerId 
        });
        
        // Resolve the denial via shared store
        const response: PermissionResponse = {
          behavior: 'deny',
          message: 'Denied by user'
        };
        await sharedStore.storePermissionResponse(approvalId, response);
        
        // Provide immediate feedback
        await respond({
          response_type: 'ephemeral',
          text: '❌ Tool execution denied. Claude will not proceed with this operation.',
          replace_original: false
        });
        
        this.logger.debug('Denial processed successfully', { approvalId });
      } catch (error) {
        this.logger.error('Error processing tool denial', error);
        
        await respond({
          response_type: 'ephemeral',
          text: '❌ Error processing denial. The request may have already been handled.',
          replace_original: false
        });
      }
    });

    // Register session expiry callbacks
    this.claudeHandler.setExpiryCallbacks({
      onWarning: this.handleSessionWarning.bind(this),
      onExpiry: this.handleSessionExpiry.bind(this),
    });

    // Cleanup inactive sessions periodically
    setInterval(async () => {
      this.logger.debug('Running session cleanup');
      await this.claudeHandler.cleanupInactiveSessions();
    }, 5 * 60 * 1000); // Every 5 minutes
  }

  /**
   * Format time remaining in human-readable format
   */
  private formatTimeRemaining(ms: number): string {
    const hours = Math.floor(ms / (60 * 60 * 1000));
    const minutes = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));

    if (hours > 0) {
      return `${hours}시간 ${minutes}분`;
    }
    return `${minutes}분`;
  }

  /**
   * Handle session expiry warning - send or update warning message
   */
  private async handleSessionWarning(
    session: ConversationSession,
    timeRemaining: number,
    existingMessageTs?: string
  ): Promise<string | undefined> {
    const warningText = `⚠️ *세션 만료 예정*\n\n이 세션은 *${this.formatTimeRemaining(timeRemaining)}* 후에 만료됩니다.\n세션을 유지하려면 메시지를 보내주세요.`;
    const threadTs = session.threadTs;
    const channel = session.channelId;

    try {
      if (existingMessageTs) {
        // Update existing warning message
        await this.app.client.chat.update({
          channel,
          ts: existingMessageTs,
          text: warningText,
        });
        return existingMessageTs;
      } else {
        // Create new warning message
        const result = await this.app.client.chat.postMessage({
          channel,
          text: warningText,
          thread_ts: threadTs,
        });
        return result.ts;
      }
    } catch (error) {
      this.logger.error('Failed to send/update session warning message', error);
      return undefined;
    }
  }

  /**
   * Handle session expiry - send final message that session is closed
   */
  private async handleSessionExpiry(session: ConversationSession): Promise<void> {
    const expiryText = `🔒 *세션이 종료되었습니다*\n\n24시간 동안 활동이 없어 이 세션이 종료되었습니다.\n새로운 대화를 시작하려면 다시 메시지를 보내주세요.`;

    try {
      // Update the warning message to show session closed, or send new message
      if (session.warningMessageTs) {
        await this.app.client.chat.update({
          channel: session.channelId,
          ts: session.warningMessageTs,
          text: expiryText,
        });
      } else {
        await this.app.client.chat.postMessage({
          channel: session.channelId,
          text: expiryText,
          thread_ts: session.threadTs,
        });
      }

      this.logger.info('Session expired', {
        userId: session.userId,
        channelId: session.channelId,
        threadTs: session.threadTs,
      });
    } catch (error) {
      this.logger.error('Failed to send session expiry message', error);
    }
  }

  /**
   * Notify all active sessions about server shutdown
   * Called before the service shuts down
   */
  async notifyShutdown(): Promise<void> {
    const shutdownText = `🔄 *서버 재시작 중*\n\n서버가 재시작됩니다. 잠시 후 다시 대화를 이어갈 수 있습니다.\n세션이 저장되었으므로 서버 재시작 후에도 대화 내용이 유지됩니다.`;

    const sessions = this.claudeHandler.getAllSessions();
    const notifyPromises: Promise<void>[] = [];

    for (const [key, session] of sessions.entries()) {
      // Only notify sessions with active conversations (have sessionId)
      if (session.sessionId) {
        const promise = (async () => {
          try {
            await this.app.client.chat.postMessage({
              channel: session.channelId,
              text: shutdownText,
              thread_ts: session.threadTs,
            });
            this.logger.debug('Sent shutdown notification', {
              sessionKey: key,
              channel: session.channelId,
            });
          } catch (error) {
            this.logger.error('Failed to send shutdown notification', {
              sessionKey: key,
              error,
            });
          }
        })();
        notifyPromises.push(promise);
      }
    }

    // Wait for all notifications to complete (with timeout)
    if (notifyPromises.length > 0) {
      this.logger.info(`Sending shutdown notifications to ${notifyPromises.length} sessions`);
      await Promise.race([
        Promise.all(notifyPromises),
        new Promise(resolve => setTimeout(resolve, 5000)), // 5 second timeout
      ]);
    }
  }

  /**
   * Load saved sessions from file
   * Returns the number of sessions loaded
   */
  loadSavedSessions(): number {
    return this.claudeHandler.loadSessions();
  }

  /**
   * Save sessions to file before shutdown
   */
  saveSessions(): void {
    this.claudeHandler.saveSessions();
  }

  /**
   * Start periodic status update for an MCP call
   * - codex: shows status immediately and updates every 30s
   * - others: shows status after 10s delay, then updates every 30s
   */
  private async startMcpStatusUpdate(
    callId: string,
    serverName: string,
    toolName: string,
    channel: string,
    threadTs: string
  ): Promise<void> {
    const isCodex = serverName === 'codex';
    const initialDelay = isCodex ? 0 : 10000; // codex: immediate, others: 10s delay

    // Get predicted duration for status message
    const predicted = mcpCallTracker.getPredictedDuration(serverName, toolName);

    // Helper to create/update status message
    const createOrUpdateStatusMessage = async (isInitial: boolean) => {
      const elapsed = mcpCallTracker.getElapsedTime(callId);
      if (elapsed === null) {
        // Call already ended
        return;
      }

      let statusText = `⏳ *MCP 실행 중: ${serverName} → ${toolName}*\n`;
      statusText += `경과 시간: ${McpCallTracker.formatDuration(elapsed)}`;

      if (predicted) {
        const remaining = Math.max(0, predicted - elapsed);
        const progress = Math.min(100, (elapsed / predicted) * 100);
        statusText += `\n예상 시간: ${McpCallTracker.formatDuration(predicted)}`;
        if (remaining > 0) {
          statusText += ` | 남은 시간: ~${McpCallTracker.formatDuration(remaining)}`;
        }
        statusText += `\n진행률: ${progress.toFixed(0)}%`;

        // Add progress bar
        const progressBarLength = 20;
        const filledLength = Math.round((progress / 100) * progressBarLength);
        const emptyLength = progressBarLength - filledLength;
        const progressBar = '█'.repeat(filledLength) + '░'.repeat(emptyLength);
        statusText += ` \`${progressBar}\``;
      }

      const msgInfo = this.mcpStatusMessages.get(callId);

      if (isInitial || !msgInfo) {
        // Create new status message
        try {
          const result = await this.app.client.chat.postMessage({
            channel,
            thread_ts: threadTs,
            text: statusText,
          });

          if (result.ts) {
            this.mcpStatusMessages.set(callId, { ts: result.ts, channel, serverName, toolName });
          }
        } catch (error) {
          this.logger.warn('Failed to create MCP status message', error);
        }
      } else {
        // Update existing status message
        try {
          await this.app.client.chat.update({
            channel: msgInfo.channel,
            ts: msgInfo.ts,
            text: statusText,
          });
          this.logger.debug('Updated MCP status message', { callId, elapsed });
        } catch (error) {
          this.logger.warn('Failed to update MCP status message', error);
        }
      }
    };

    if (isCodex) {
      // Codex: create status message immediately
      await createOrUpdateStatusMessage(true);

      // Set up 30-second interval for updates
      const interval = setInterval(async () => {
        const elapsed = mcpCallTracker.getElapsedTime(callId);
        if (elapsed === null) {
          this.stopMcpStatusUpdate(callId);
          return;
        }
        await createOrUpdateStatusMessage(false);
      }, 30000);

      this.mcpStatusIntervals.set(callId, interval);
    } else {
      // Others: wait 10s before showing status, then update every 30s
      const initialTimeout = setTimeout(async () => {
        const elapsed = mcpCallTracker.getElapsedTime(callId);
        if (elapsed === null) {
          // Call already ended before 10s, no status message needed
          return;
        }

        // Create initial status message after 10s
        await createOrUpdateStatusMessage(true);

        // Set up 30-second interval for subsequent updates
        const interval = setInterval(async () => {
          const currentElapsed = mcpCallTracker.getElapsedTime(callId);
          if (currentElapsed === null) {
            this.stopMcpStatusUpdate(callId);
            return;
          }
          await createOrUpdateStatusMessage(false);
        }, 30000);

        this.mcpStatusIntervals.set(callId, interval);
      }, initialDelay);

      // Store the timeout so we can clear it if call ends early
      this.mcpStatusIntervals.set(callId, initialTimeout as unknown as NodeJS.Timeout);
    }
  }

  /**
   * Stop periodic status update for an MCP call and update the message to show completion
   */
  private async stopMcpStatusUpdate(callId: string, duration?: number | null): Promise<void> {
    this.logger.debug('Stopping MCP status update', { callId, duration });

    // Clear the interval/timeout first
    const timer = this.mcpStatusIntervals.get(callId);
    if (timer) {
      clearInterval(timer);
      clearTimeout(timer);
      this.mcpStatusIntervals.delete(callId);
      this.logger.debug('Cleared timer for MCP call', { callId });
    }

    // Update the status message to show completion (only if status message exists)
    const msgInfo = this.mcpStatusMessages.get(callId);
    if (msgInfo) {
      try {
        let completedText = `✅ *MCP 완료: ${msgInfo.serverName} → ${msgInfo.toolName}*`;
        if (duration !== null && duration !== undefined) {
          completedText += ` (${McpCallTracker.formatDuration(duration)})`;
        }

        await this.app.client.chat.update({
          channel: msgInfo.channel,
          ts: msgInfo.ts,
          text: completedText,
        });
        this.logger.debug('Updated MCP status message to completed', { callId, duration });
      } catch (error) {
        this.logger.warn('Failed to update MCP status message to completed', error);
      }
      this.mcpStatusMessages.delete(callId);
    }
    // If no msgInfo, the call completed before status message was shown (< 10s for non-codex)
    // In this case, only the MCP result will be shown, which is the expected behavior
  }
}