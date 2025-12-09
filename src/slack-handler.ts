import { App } from '@slack/bolt';
import { ClaudeHandler, getAvailablePersonas } from './claude-handler';
import { SDKMessage } from '@anthropic-ai/claude-code';
import { Logger } from './logger';
import { WorkingDirectoryManager } from './working-directory-manager';
import { FileHandler, ProcessedFile } from './file-handler';
import { TodoManager, Todo } from './todo-manager';
import { McpManager } from './mcp-manager';
import { sharedStore, PermissionResponse } from './shared-store';
import { userSettingsStore } from './user-settings-store';
import { config } from './config';
import { getCredentialStatus, copyBackupCredentials, hasClaudeAiOauth, isCredentialManagerEnabled } from './credentials-manager';

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
    return `🔧 *Using ${toolName}*`;
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

    // Handle file uploads in threads
    this.app.event('message', async ({ event, say }) => {
      // Only handle file uploads that are not from bots and have files
      if (event.subtype === 'file_share' && 'user' in event && event.files) {
        this.logger.info('Handling file upload event');
        await this.handleMessage(event as MessageEvent, say);
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

    // Cleanup inactive sessions periodically
    setInterval(() => {
      this.logger.debug('Running session cleanup');
      this.claudeHandler.cleanupInactiveSessions();
    }, 5 * 60 * 1000); // Every 5 minutes
  }
}