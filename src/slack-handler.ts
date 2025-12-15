import { App } from '@slack/bolt';
import { ClaudeHandler, getAvailablePersonas, SessionExpiryCallbacks } from './claude-handler';
import { SDKMessage } from '@anthropic-ai/claude-code';
import { Logger } from './logger';
import { WorkingDirectoryManager } from './working-directory-manager';
import { FileHandler, ProcessedFile } from './file-handler';
import { ConversationSession, UserChoice, UserChoices, UserChoiceQuestion, PendingChoiceForm } from './types';
import { TodoManager, Todo } from './todo-manager';
import { McpManager } from './mcp-manager';
import { sharedStore, PermissionResponse } from './shared-store';
import { userSettingsStore, AVAILABLE_MODELS, MODEL_ALIASES } from './user-settings-store';
import { config } from './config';
import { getCredentialStatus, copyBackupCredentials, hasClaudeAiOauth, isCredentialManagerEnabled } from './credentials-manager';
import { mcpCallTracker, McpCallTracker } from './mcp-call-tracker';
import { CommandParser, ToolFormatter, UserChoiceHandler, MessageFormatter } from './slack';

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
  // Track pending choice forms for multi-question selection
  private pendingChoiceForms: Map<string, {
    formId: string;
    sessionKey: string;
    channel: string;
    threadTs: string;
    messageTs: string;
    questions: UserChoiceQuestion[];
    selections: Record<string, { choiceId: string; label: string }>;
    createdAt: number;
  }> = new Map();

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
    if (text && CommandParser.isMcpInfoCommand(text)) {
      const mcpInfo = await this.mcpManager.formatMcpInfo();
      await say({
        text: mcpInfo,
        thread_ts: thread_ts || ts,
      });
      return;
    }

    // Check if this is an MCP reload command (only if there's text)
    if (text && CommandParser.isMcpReloadCommand(text)) {
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
    if (text && CommandParser.isBypassCommand(text)) {
      const bypassAction = CommandParser.parseBypassCommand(text);

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
    if (text && CommandParser.isPersonaCommand(text)) {
      const personaAction = CommandParser.parsePersonaCommand(text);

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

    // Check if this is a model command (only if there's text)
    if (text && CommandParser.isModelCommand(text)) {
      const modelAction = CommandParser.parseModelCommand(text);

      if (modelAction.action === 'status') {
        const currentModel = userSettingsStore.getUserDefaultModel(user);
        const displayName = userSettingsStore.getModelDisplayName(currentModel);
        const aliasesText = Object.entries(MODEL_ALIASES)
          .map(([alias, model]) => `\`${alias}\` → ${userSettingsStore.getModelDisplayName(model)}`)
          .join('\n');

        await say({
          text: `🤖 *Model Status*\n\nYour default model: *${displayName}*\n\`${currentModel}\`\n\n*Available aliases:*\n${aliasesText}\n\n_Use \`model set <name>\` to change your default model._`,
          thread_ts: thread_ts || ts,
        });
      } else if (modelAction.action === 'list') {
        const currentModel = userSettingsStore.getUserDefaultModel(user);
        const modelList = AVAILABLE_MODELS
          .map(m => {
            const displayName = userSettingsStore.getModelDisplayName(m);
            return m === currentModel ? `• *${displayName}* _(current)_\n  \`${m}\`` : `• ${displayName}\n  \`${m}\``;
          })
          .join('\n');

        await say({
          text: `🤖 *Available Models*\n\n${modelList}\n\n_Use \`model set <name>\` to change your default model._`,
          thread_ts: thread_ts || ts,
        });
      } else if (modelAction.action === 'set' && modelAction.model) {
        const resolvedModel = userSettingsStore.resolveModelInput(modelAction.model);
        if (resolvedModel) {
          userSettingsStore.setUserDefaultModel(user, resolvedModel);
          const displayName = userSettingsStore.getModelDisplayName(resolvedModel);
          await say({
            text: `✅ *Model Changed*\n\nYour default model is now: *${displayName}*\n\`${resolvedModel}\`\n\n_New sessions will use this model._`,
            thread_ts: thread_ts || ts,
          });
        } else {
          const aliasesText = Object.keys(MODEL_ALIASES).map(a => `\`${a}\``).join(', ');
          await say({
            text: `❌ *Unknown Model*\n\nModel \`${modelAction.model}\` not found.\n\n*Available aliases:* ${aliasesText}\n\n_Use \`model list\` to see all available models._`,
            thread_ts: thread_ts || ts,
          });
        }
      }
      return;
    }

    // Check if this is a restore credentials command (only if there's text)
    if (text && CommandParser.isRestoreCommand(text)) {
      await this.handleRestoreCommand(channel, thread_ts || ts, say);
      return;
    }

    // Check if this is a help command (only if there's text)
    if (text && CommandParser.isHelpCommand(text)) {
      await say({
        text: CommandParser.getHelpMessage(),
        thread_ts: thread_ts || ts,
      });
      return;
    }

    // Check if this is a sessions command
    if (text && CommandParser.isSessionsCommand(text)) {
      const { text: msgText, blocks } = await this.formatUserSessionsBlocks(user);
      await say({
        text: msgText,
        blocks,
        thread_ts: thread_ts || ts,
      });
      return;
    }

    // Check if this is a terminate command
    const terminateMatch = text ? CommandParser.parseTerminateCommand(text) : null;
    if (terminateMatch) {
      await this.handleTerminateCommand(terminateMatch, user, channel, thread_ts || ts, say);
      return;
    }

    // Check if this is an all_sessions command
    if (text && CommandParser.isAllSessionsCommand(text)) {
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

    // Get user's display name for speaker tag
    const userName = await this.getUserName(user);

    // Session key is now based on channel + thread only (shared session)
    const sessionKey = this.claudeHandler.getSessionKey(channel, thread_ts || ts);

    // Store the original message info for status reactions
    const originalMessageTs = thread_ts || ts;
    this.originalMessages.set(sessionKey, { channel, ts: originalMessageTs });

    // Get or create session
    const existingSession = this.claudeHandler.getSession(channel, thread_ts || ts);
    const isNewSession = !existingSession;

    const session = isNewSession
      ? this.claudeHandler.createSession(user, userName, channel, thread_ts || ts)
      : existingSession;

    if (isNewSession) {
      this.logger.debug('Creating new session', { sessionKey, owner: userName });
      // Generate session title from first message
      if (text) {
        const title = MessageFormatter.generateSessionTitle(text);
        this.claudeHandler.setSessionTitle(channel, thread_ts || ts, title);
      }
    } else {
      this.logger.debug('Using existing session', {
        sessionKey,
        sessionId: session.sessionId,
        owner: session.ownerName,
        currentInitiator: session.currentInitiatorName,
      });
    }

    // Check if this user can interrupt the current response
    const canInterrupt = this.claudeHandler.canInterrupt(channel, thread_ts || ts, user);

    // Cancel existing request only if user can interrupt (owner or current initiator)
    const existingController = this.activeControllers.get(sessionKey);
    if (existingController && canInterrupt) {
      this.logger.debug('Cancelling existing request for session', { sessionKey, interruptedBy: userName });
      existingController.abort();
    } else if (existingController && !canInterrupt) {
      // User cannot interrupt - their message will be queued for after current response
      this.logger.debug('User cannot interrupt, message will be processed after current response', {
        sessionKey,
        user: userName,
        owner: session.ownerName,
        currentInitiator: session.currentInitiatorName,
      });
      // Don't return - we'll still process this message, just won't abort the existing one
      // The existing controller will complete and this new request will start after
    }

    const abortController = new AbortController();
    this.activeControllers.set(sessionKey, abortController);

    // Update the current initiator
    this.claudeHandler.updateInitiator(channel, thread_ts || ts, user, userName);

    let currentMessages: string[] = [];
    let statusMessageTs: string | undefined;

    try {
      // Prepare the prompt with file attachments
      let rawPrompt = processedFiles.length > 0
        ? await this.fileHandler.formatFilePrompt(processedFiles, text || '')
        : text || '';

      // Wrap the prompt with speaker tag to identify who is speaking
      let finalPrompt = `<speaker>${userName}</speaker>\n${rawPrompt}`;

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
        speaker: userName,
        isOwner: session.ownerId === user,
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
            const toolContent = ToolFormatter.formatToolUse(message.message.content);
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

              // Check for user choice JSON (single or multi)
              const { choice, choices, textWithoutChoice } = UserChoiceHandler.extractUserChoice(content);

              if (choices) {
                // Multi-question form
                if (textWithoutChoice) {
                  const formatted = MessageFormatter.formatMessage(textWithoutChoice, false);
                  await say({
                    text: formatted,
                    thread_ts: thread_ts || ts,
                  });
                }

                // Generate unique form ID
                const formId = `form_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

                // Store pending form
                this.pendingChoiceForms.set(formId, {
                  formId,
                  sessionKey,
                  channel,
                  threadTs: thread_ts || ts,
                  messageTs: '', // Will be set after message is sent
                  questions: choices.questions,
                  selections: {},
                  createdAt: Date.now(),
                });

                // Send multi-choice form
                const blocks = UserChoiceHandler.buildMultiChoiceFormBlocks(choices, formId, sessionKey);
                const formResult = await say({
                  text: choices.title || '📋 선택이 필요합니다',
                  blocks,
                  thread_ts: thread_ts || ts,
                });

                // Update stored form with message timestamp
                const pendingForm = this.pendingChoiceForms.get(formId);
                if (pendingForm && formResult?.ts) {
                  pendingForm.messageTs = formResult.ts;
                }
              } else if (choice) {
                // Single question - existing behavior
                if (textWithoutChoice) {
                  const formatted = MessageFormatter.formatMessage(textWithoutChoice, false);
                  await say({
                    text: formatted,
                    thread_ts: thread_ts || ts,
                  });
                }

                const blocks = UserChoiceHandler.buildUserChoiceBlocks(choice, sessionKey);
                await say({
                  text: `🔹 ${choice.question}`,
                  blocks,
                  thread_ts: thread_ts || ts,
                });
              } else {
                // No choice JSON - send as regular message
                const formatted = MessageFormatter.formatMessage(content, false);
                await say({
                  text: formatted,
                  thread_ts: thread_ts || ts,
                });
              }
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

          // Debug: log raw content
          this.logger.info('📥 User message content for tool results', {
            hasContent: !!content,
            contentType: typeof content,
            isArray: Array.isArray(content),
            contentLength: Array.isArray(content) ? content.length : 0,
            rawContent: JSON.stringify(content)?.substring(0, 500),
          });

          if (content) {
            const toolResults = ToolFormatter.extractToolResults(content);

            this.logger.info('📤 Extracted tool results', {
              count: toolResults.length,
              toolNames: toolResults.map(r => r.toolName || this.toolUseIdToName.get(r.toolUseId)),
              toolUseIds: toolResults.map(r => r.toolUseId),
              hasResults: toolResults.map(r => !!r.result),
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

              // Log all tool results for debugging
              this.logger.info('Processing tool result', {
                toolName: toolResult.toolName,
                toolUseId: toolResult.toolUseId,
                hasResult: !!toolResult.result,
                resultType: typeof toolResult.result,
                isError: toolResult.isError,
                duration,
              });

              // Format and show tool result
              const formatted = ToolFormatter.formatToolResult(toolResult, duration, mcpCallTracker);
              if (formatted) {
                await say({
                  text: formatted,
                  thread_ts: thread_ts || ts,
                });
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
              // Check for user choice JSON in final result (single or multi)
              const { choice, choices, textWithoutChoice } = UserChoiceHandler.extractUserChoice(finalResult);

              if (choices) {
                // Multi-question form in final result
                if (textWithoutChoice) {
                  const formatted = MessageFormatter.formatMessage(textWithoutChoice, true);
                  await say({
                    text: formatted,
                    thread_ts: thread_ts || ts,
                  });
                }

                const formId = `form_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

                this.pendingChoiceForms.set(formId, {
                  formId,
                  sessionKey,
                  channel,
                  threadTs: thread_ts || ts,
                  messageTs: '',
                  questions: choices.questions,
                  selections: {},
                  createdAt: Date.now(),
                });

                const blocks = UserChoiceHandler.buildMultiChoiceFormBlocks(choices, formId, sessionKey);
                const formResult = await say({
                  text: choices.title || '📋 선택이 필요합니다',
                  blocks,
                  thread_ts: thread_ts || ts,
                });

                const pendingForm = this.pendingChoiceForms.get(formId);
                if (pendingForm && formResult?.ts) {
                  pendingForm.messageTs = formResult.ts;
                }
              } else if (choice) {
                if (textWithoutChoice) {
                  const formatted = MessageFormatter.formatMessage(textWithoutChoice, true);
                  await say({
                    text: formatted,
                    thread_ts: thread_ts || ts,
                  });
                }

                const blocks = UserChoiceHandler.buildUserChoiceBlocks(choice, sessionKey);
                await say({
                  text: `🔹 ${choice.question}`,
                  blocks,
                  thread_ts: thread_ts || ts,
                });
              } else {
                const formatted = MessageFormatter.formatMessage(finalResult, true);
                await say({
                  text: formatted,
                  thread_ts: thread_ts || ts,
                });
              }
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

  private async handleTerminateCommand(
    sessionKey: string,
    userId: string,
    channel: string,
    threadTs: string,
    say: any
  ): Promise<void> {
    // Try to find the session
    const session = this.claudeHandler.getSessionByKey(sessionKey);

    if (!session) {
      await say({
        text: `❌ 세션을 찾을 수 없습니다: \`${sessionKey}\`\n\n\`sessions\` 명령으로 활성 세션 목록을 확인하세요.`,
        thread_ts: threadTs,
      });
      return;
    }

    // Check if user owns this session
    if (session.ownerId !== userId) {
      await say({
        text: `❌ 이 세션을 종료할 권한이 없습니다. 세션 소유자만 종료할 수 있습니다.`,
        thread_ts: threadTs,
      });
      return;
    }

    // Terminate the session
    const success = this.claudeHandler.terminateSession(sessionKey);

    if (success) {
      const channelName = await this.getChannelName(session.channelId);
      await say({
        text: `✅ 세션이 종료되었습니다.\n\n*채널:* ${channelName}\n*세션 키:* \`${sessionKey}\``,
        thread_ts: threadTs,
      });

      // Also notify in the original thread if different
      if (session.threadTs && session.threadTs !== threadTs) {
        try {
          await this.app.client.chat.postMessage({
            channel: session.channelId,
            thread_ts: session.threadTs,
            text: `🔒 *세션이 종료되었습니다*\n\n<@${userId}>에 의해 세션이 종료되었습니다. 새로운 대화를 시작하려면 다시 메시지를 보내주세요.`,
          });
        } catch (error) {
          this.logger.warn('Failed to notify original thread about session termination', error);
        }
      }
    } else {
      await say({
        text: `❌ 세션 종료에 실패했습니다: \`${sessionKey}\``,
        thread_ts: threadTs,
      });
    }
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
   * Get permalink for a message
   */
  private async getPermalink(channel: string, messageTs: string): Promise<string | null> {
    try {
      const result = await this.app.client.chat.getPermalink({
        channel,
        message_ts: messageTs,
      });
      return result.permalink || null;
    } catch (error) {
      this.logger.warn('Failed to get permalink', { channel, messageTs, error });
      return null;
    }
  }

  /**
   * Format sessions for a specific user with Block Kit
   */
  private async formatUserSessionsBlocks(userId: string): Promise<{ text: string; blocks: any[] }> {
    const allSessions = this.claudeHandler.getAllSessions();
    const userSessions: Array<{ key: string; session: ConversationSession }> = [];

    // Find sessions where user is the owner
    for (const [key, session] of allSessions.entries()) {
      if (session.ownerId === userId && session.sessionId) {
        userSessions.push({ key, session });
      }
    }

    if (userSessions.length === 0) {
      return {
        text: '📭 활성 세션 없음',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '📭 *활성 세션 없음*\n\n현재 진행 중인 세션이 없습니다.',
            },
          },
        ],
      };
    }

    // Sort by last activity (most recent first)
    userSessions.sort((a, b) => b.session.lastActivity.getTime() - a.session.lastActivity.getTime());

    const blocks: any[] = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `📋 내 세션 목록 (${userSessions.length}개)`,
          emoji: true,
        },
      },
      { type: 'divider' },
    ];

    for (let i = 0; i < userSessions.length; i++) {
      const { key, session } = userSessions[i];
      const channelName = await this.getChannelName(session.channelId);
      const timeAgo = MessageFormatter.formatTimeAgo(session.lastActivity);
      const expiresIn = MessageFormatter.formatExpiresIn(session.lastActivity);
      const workDir = session.workingDirectory
        ? `\`${session.workingDirectory.split('/').pop()}\``
        : '_미설정_';
      const modelDisplay = session.model
        ? userSettingsStore.getModelDisplayName(session.model as any)
        : 'Sonnet 4';
      const initiator = session.currentInitiatorName
        ? ` | 🎯 ${session.currentInitiatorName}`
        : '';

      // Get permalink for the thread
      const permalink = session.threadTs
        ? await this.getPermalink(session.channelId, session.threadTs)
        : null;

      // Create session identifier for terminate button
      const sessionId = key; // key is already "channel:threadTs"

      // Build session info text
      let sessionText = `*${i + 1}.*`;
      if (session.title) {
        sessionText += ` ${session.title}`;
      }
      sessionText += ` _${channelName}_`;
      if (session.threadTs && permalink) {
        sessionText += ` <${permalink}|(열기)>`;
      } else if (session.threadTs) {
        sessionText += ` (thread)`;
      }
      sessionText += `\n🤖 ${modelDisplay} | 📁 ${workDir} | 🕐 ${timeAgo}${initiator} | ⏳ ${expiresIn}`;

      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: sessionText,
        },
        accessory: {
          type: 'button',
          text: {
            type: 'plain_text',
            text: '🗑️ 종료',
            emoji: true,
          },
          style: 'danger',
          value: sessionId,
          action_id: 'terminate_session',
          confirm: {
            title: {
              type: 'plain_text',
              text: '세션 종료',
            },
            text: {
              type: 'mrkdwn',
              text: `정말로 이 세션을 종료하시겠습니까?\n*${channelName}*`,
            },
            confirm: {
              type: 'plain_text',
              text: '종료',
            },
            deny: {
              type: 'plain_text',
              text: '취소',
            },
          },
        },
      });
    }

    // Add help text at the bottom
    blocks.push(
      { type: 'divider' },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: '💡 `terminate <session-key>` 명령으로도 세션을 종료할 수 있습니다.',
          },
        ],
      }
    );

    return {
      text: `📋 내 세션 목록 (${userSessions.length}개)`,
      blocks,
    };
  }

  /**
   * Format sessions for a specific user (text only, for backward compatibility)
   */
  private async formatUserSessions(userId: string): Promise<string> {
    const result = await this.formatUserSessionsBlocks(userId);
    return result.text;
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

    // Group by owner
    const sessionsByOwner = new Map<string, Array<{ key: string; session: ConversationSession }>>();
    for (const item of activeSessions) {
      const ownerId = item.session.ownerId;
      if (!sessionsByOwner.has(ownerId)) {
        sessionsByOwner.set(ownerId, []);
      }
      sessionsByOwner.get(ownerId)!.push(item);
    }

    for (const [ownerId, sessions] of sessionsByOwner.entries()) {
      const ownerName = sessions[0].session.ownerName || await this.getUserName(ownerId);
      lines.push(`👤 *${ownerName}* (${sessions.length}개 세션)`);

      for (const { session } of sessions) {
        const channelName = await this.getChannelName(session.channelId);
        const timeAgo = MessageFormatter.formatTimeAgo(session.lastActivity);
        const expiresIn = MessageFormatter.formatExpiresIn(session.lastActivity);
        const workDir = session.workingDirectory
          ? session.workingDirectory.split('/').pop() || session.workingDirectory
          : '-';
        const initiator = session.currentInitiatorName && session.currentInitiatorId !== session.ownerId
          ? ` | 🎯 ${session.currentInitiatorName}`
          : '';

        lines.push(`   • ${channelName}${session.threadTs ? ' (thread)' : ''} | 📁 \`${workDir}\` | 🕐 ${timeAgo}${initiator} | ⏳ ${expiresIn}`);
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

  /**
   * Extract UserChoice or UserChoices JSON from message text
   * Looks for ```json blocks containing user_choice or user_choices type
   */
  private extractUserChoice(text: string): {
    choice: UserChoice | null;
    choices: UserChoices | null;
    textWithoutChoice: string;
  } {
    // Pattern to match JSON code blocks
    const jsonBlockPattern = /```json\s*\n?([\s\S]*?)\n?```/g;
    let match;
    let choice: UserChoice | null = null;
    let choices: UserChoices | null = null;
    let textWithoutChoice = text;

    while ((match = jsonBlockPattern.exec(text)) !== null) {
      try {
        const parsed = JSON.parse(match[1].trim());

        // Check for multi-question format first
        if (parsed.type === 'user_choices' && Array.isArray(parsed.questions)) {
          choices = parsed as UserChoices;
          textWithoutChoice = text.replace(match[0], '').trim();
          break;
        }

        // Check for single question format
        if (parsed.type === 'user_choice' && Array.isArray(parsed.choices)) {
          choice = parsed as UserChoice;
          textWithoutChoice = text.replace(match[0], '').trim();
          break;
        }
      } catch {
        // Not valid JSON, continue
      }
    }

    return { choice, choices, textWithoutChoice };
  }

  /**
   * Build Slack blocks for single user choice buttons
   */
  private buildUserChoiceBlocks(choice: UserChoice, sessionKey: string): any[] {
    const blocks: any[] = [];

    // Add question as section
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `🔹 *${choice.question}*`,
      },
    });

    // Add context if provided
    if (choice.context) {
      blocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: choice.context,
          },
        ],
      });
    }

    // Build button elements (max 4 to leave room for custom input)
    const buttons: any[] = choice.choices.slice(0, 4).map((opt) => ({
      type: 'button',
      text: {
        type: 'plain_text',
        text: `${opt.id}. ${opt.label}`.substring(0, 75), // Slack limit
        emoji: true,
      },
      value: JSON.stringify({
        sessionKey,
        choiceId: opt.id,
        label: opt.label,
        question: choice.question,
      }),
      action_id: `user_choice_${opt.id}`,
    }));

    // Add custom input button
    buttons.push({
      type: 'button',
      text: {
        type: 'plain_text',
        text: '✏️ 직접 입력',
        emoji: true,
      },
      style: 'primary',
      value: JSON.stringify({
        sessionKey,
        question: choice.question,
        type: 'single',
      }),
      action_id: 'custom_input_single',
    });

    blocks.push({
      type: 'actions',
      elements: buttons,
    });

    // Add descriptions if any choices have them
    const descriptions = choice.choices
      .filter((opt) => opt.description)
      .map((opt) => `*${opt.id}.* ${opt.description}`)
      .join('\n');

    if (descriptions) {
      blocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: descriptions,
          },
        ],
      });
    }

    return blocks;
  }

  /**
   * Build Slack blocks for multi-question choice form
   */
  private buildMultiChoiceFormBlocks(
    choices: UserChoices,
    formId: string,
    sessionKey: string,
    selections: Record<string, { choiceId: string; label: string }> = {}
  ): any[] {
    const blocks: any[] = [];

    // Header with title
    blocks.push({
      type: 'header',
      text: {
        type: 'plain_text',
        text: choices.title || '📋 선택이 필요합니다',
        emoji: true,
      },
    });

    // Description if provided
    if (choices.description) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: choices.description,
        },
      });
    }

    blocks.push({ type: 'divider' });

    // Build each question
    choices.questions.forEach((q, idx) => {
      const isSelected = !!selections[q.id];
      const selectedChoice = selections[q.id];

      // Question header with selection status
      const questionText = isSelected
        ? `✅ *${idx + 1}. ${q.question}*\n_선택됨: ${selectedChoice.choiceId}. ${selectedChoice.label}_`
        : `🔹 *${idx + 1}. ${q.question}*`;

      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: questionText,
        },
      });

      // Context if provided
      if (q.context && !isSelected) {
        blocks.push({
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: q.context,
            },
          ],
        });
      }

      // Show buttons only if not yet selected
      if (!isSelected) {
        // Max 4 choices to leave room for custom input button
        const buttons: any[] = q.choices.slice(0, 4).map((opt) => ({
          type: 'button',
          text: {
            type: 'plain_text',
            text: `${opt.id}. ${opt.label}`.substring(0, 75),
            emoji: true,
          },
          value: JSON.stringify({
            formId,
            sessionKey,
            questionId: q.id,
            choiceId: opt.id,
            label: opt.label,
          }),
          action_id: `multi_choice_${formId}_${q.id}_${opt.id}`,
        }));

        // Add custom input button
        buttons.push({
          type: 'button',
          text: {
            type: 'plain_text',
            text: '✏️ 직접 입력',
            emoji: true,
          },
          style: 'primary',
          value: JSON.stringify({
            formId,
            sessionKey,
            questionId: q.id,
            question: q.question,
            type: 'multi',
          }),
          action_id: `custom_input_multi_${formId}_${q.id}`,
        });

        blocks.push({
          type: 'actions',
          elements: buttons,
        });

        // Descriptions
        const descriptions = q.choices
          .filter((opt) => opt.description)
          .map((opt) => `*${opt.id}.* ${opt.description}`)
          .join('\n');

        if (descriptions) {
          blocks.push({
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: descriptions,
              },
            ],
          });
        }
      }

      // Add spacing between questions
      if (idx < choices.questions.length - 1) {
        blocks.push({ type: 'divider' });
      }
    });

    // Progress indicator
    const totalQuestions = choices.questions.length;
    const answeredCount = Object.keys(selections).length;
    const progressText = `진행: ${answeredCount}/${totalQuestions}`;

    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: answeredCount === totalQuestions
            ? `✅ *모든 선택 완료!* 잠시 후 자동으로 진행됩니다...`
            : `⏳ ${progressText} - 모든 항목을 선택하면 자동으로 진행됩니다`,
        },
      ],
    });

    return blocks;
  }

  setupEventHandlers() {
    // Handle direct messages (DM only)
    this.app.message(async ({ message, say }) => {
      if (message.subtype === undefined && 'user' in message) {
        const messageEvent = message as any;
        // Only handle DM messages here - channel messages are handled by app_mention or message event
        if (!messageEvent.channel?.startsWith('D')) {
          return;
        }
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
      const messageEvent = event as any;

      // Log ALL incoming message events for debugging
      this.logger.info('📨 RAW message event received', {
        type: event.type,
        subtype: event.subtype,
        channel: messageEvent.channel,
        channelType: messageEvent.channel_type,
        user: messageEvent.user,
        bot_id: (event as any).bot_id,
        thread_ts: messageEvent.thread_ts,
        ts: messageEvent.ts,
        text: messageEvent.text?.substring(0, 50),
      });

      // Skip bot messages
      if ('bot_id' in event || !('user' in event)) {
        this.logger.debug('Skipping bot message or no user');
        return;
      }

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
        const text = messageEvent.text || '';

        // Skip if message contains bot mention (will be handled by app_mention event)
        const botId = await this.getBotUserId();
        if (botId && text.includes(`<@${botId}>`)) {
          this.logger.debug('Skipping thread message with bot mention (handled by app_mention)', {
            channel,
            threadTs,
          });
          return;
        }

        // Check if we have an existing session for this thread (shared session, no user in key)
        const session = this.claudeHandler.getSession(channel, threadTs);
        if (session?.sessionId) {
          this.logger.info('Handling thread message without mention (session exists)', {
            user,
            channel,
            threadTs,
            sessionId: session.sessionId,
            owner: session.ownerName,
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

    // Handle session termination button clicks
    this.app.action('terminate_session', async ({ ack, body, respond }) => {
      await ack();

      try {
        const sessionKey = (body as any).actions[0].value;
        const userId = (body as any).user?.id;

        this.logger.info('Session termination requested', { sessionKey, userId });

        // Get session to verify ownership
        const session = this.claudeHandler.getSessionByKey(sessionKey);

        if (!session) {
          await respond({
            response_type: 'ephemeral',
            text: `❌ 세션을 찾을 수 없습니다. 이미 종료되었을 수 있습니다.`,
            replace_original: false
          });
          return;
        }

        // Check ownership
        if (session.ownerId !== userId) {
          await respond({
            response_type: 'ephemeral',
            text: `❌ 이 세션을 종료할 권한이 없습니다. 세션 소유자만 종료할 수 있습니다.`,
            replace_original: false
          });
          return;
        }

        // Terminate the session
        const channelName = await this.getChannelName(session.channelId);
        const success = this.claudeHandler.terminateSession(sessionKey);

        if (success) {
          // Update the sessions list message with refreshed data
          const { text: newText, blocks: newBlocks } = await this.formatUserSessionsBlocks(userId);
          await respond({
            text: newText,
            blocks: newBlocks,
            replace_original: true
          });

          // Also send ephemeral confirmation
          await this.app.client.chat.postEphemeral({
            channel: (body as any).channel?.id,
            user: userId,
            text: `✅ 세션이 종료되었습니다: *${session.title || channelName}*`,
          });

          // Notify in the original thread
          if (session.threadTs) {
            try {
              await this.app.client.chat.postMessage({
                channel: session.channelId,
                thread_ts: session.threadTs,
                text: `🔒 *세션이 종료되었습니다*\n\n<@${userId}>에 의해 세션이 종료되었습니다. 새로운 대화를 시작하려면 다시 메시지를 보내주세요.`,
              });
            } catch (error) {
              this.logger.warn('Failed to notify original thread about session termination', error);
            }
          }
        } else {
          await respond({
            response_type: 'ephemeral',
            text: `❌ 세션 종료에 실패했습니다.`,
            replace_original: false
          });
        }
      } catch (error) {
        this.logger.error('Error processing session termination', error);

        await respond({
          response_type: 'ephemeral',
          text: '❌ 세션 종료 중 오류가 발생했습니다.',
          replace_original: false
        });
      }
    });

    // Handle user choice button clicks (pattern matches user_choice_1, user_choice_2, etc.)
    this.app.action(/^user_choice_/, async ({ ack, body }) => {
      await ack();

      try {
        const action = (body as any).actions[0];
        const valueData = JSON.parse(action.value);
        const { sessionKey, choiceId, label, question } = valueData;
        const userId = (body as any).user?.id;
        const channel = (body as any).channel?.id;
        const messageTs = (body as any).message?.ts;

        this.logger.info('User choice selected', {
          sessionKey,
          choiceId,
          label,
          userId,
        });

        // Get the thread_ts from the message or use the message ts
        const threadTs = (body as any).message?.thread_ts || messageTs;

        // Update the original message to show the selection
        if (messageTs && channel) {
          try {
            await this.app.client.chat.update({
              channel,
              ts: messageTs,
              text: `✅ *${question}*\n선택: *${choiceId}. ${label}*`,
              blocks: [
                {
                  type: 'section',
                  text: {
                    type: 'mrkdwn',
                    text: `✅ *${question}*\n선택: *${choiceId}. ${label}*`,
                  },
                },
              ],
            });
          } catch (error) {
            this.logger.warn('Failed to update choice message', error);
          }
        }

        // Get the session to find the correct thread
        const session = this.claudeHandler.getSessionByKey(sessionKey);
        if (session) {
          // Create a say function using the app client
          const say = async (args: any) => {
            const msgArgs = typeof args === 'string' ? { text: args } : args;
            return this.app.client.chat.postMessage({
              channel,
              ...msgArgs,
            });
          };

          // Handle the message as if the user sent it
          await this.handleMessage(
            {
              user: userId,
              channel,
              thread_ts: threadTs,
              ts: messageTs,
              text: choiceId,
            } as MessageEvent,
            say
          );
        } else {
          this.logger.warn('Session not found for user choice', { sessionKey });
          await this.app.client.chat.postEphemeral({
            channel,
            user: userId,
            text: '❌ 세션을 찾을 수 없습니다. 대화가 만료되었을 수 있습니다.',
          });
        }
      } catch (error) {
        this.logger.error('Error processing user choice', error);
      }
    });

    // Handle multi-choice form button clicks (pattern matches multi_choice_formId_questionId_choiceId)
    this.app.action(/^multi_choice_/, async ({ ack, body }) => {
      await ack();

      try {
        const action = (body as any).actions[0];
        const valueData = JSON.parse(action.value);
        const { formId, sessionKey, questionId, choiceId, label } = valueData;
        const userId = (body as any).user?.id;
        const channel = (body as any).channel?.id;
        const messageTs = (body as any).message?.ts;

        this.logger.info('Multi-choice selection', {
          formId,
          questionId,
          choiceId,
          label,
          userId,
        });

        // Get the pending form
        const pendingForm = this.pendingChoiceForms.get(formId);
        if (!pendingForm) {
          this.logger.warn('Pending form not found', { formId });
          await this.app.client.chat.postEphemeral({
            channel,
            user: userId,
            text: '❌ 폼을 찾을 수 없습니다. 시간이 만료되었을 수 있습니다.',
          });
          return;
        }

        // Store the selection
        pendingForm.selections[questionId] = { choiceId, label };

        // Check if all questions are answered
        const totalQuestions = pendingForm.questions.length;
        const answeredCount = Object.keys(pendingForm.selections).length;

        // Rebuild the form blocks with updated selections - need original choices data
        const choicesData: UserChoices = {
          type: 'user_choices',
          questions: pendingForm.questions,
        };

        const updatedBlocks = UserChoiceHandler.buildMultiChoiceFormBlocks(
          choicesData,
          formId,
          sessionKey,
          pendingForm.selections
        );

        // Update the message with new blocks
        try {
          await this.app.client.chat.update({
            channel,
            ts: messageTs,
            text: '📋 선택이 필요합니다',
            blocks: updatedBlocks,
          });
        } catch (error) {
          this.logger.warn('Failed to update multi-choice form', error);
        }

        // If all questions answered, send to Claude
        if (answeredCount === totalQuestions) {
          this.logger.info('All multi-choice selections complete', { formId, selections: pendingForm.selections });

          // Format the combined response
          const responses = pendingForm.questions.map((q) => {
            const sel = pendingForm.selections[q.id];
            return `${q.question}: ${sel.choiceId}. ${sel.label}`;
          });
          const combinedMessage = responses.join('\n');

          // Remove the pending form
          this.pendingChoiceForms.delete(formId);

          // Update form to show completion
          try {
            const completedBlocks = [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: `✅ *모든 선택 완료*\n\n${responses.map((r, i) => `${i + 1}. ${r}`).join('\n')}`,
                },
              },
            ];

            await this.app.client.chat.update({
              channel,
              ts: messageTs,
              text: '✅ 모든 선택 완료',
              blocks: completedBlocks,
            });
          } catch (error) {
            this.logger.warn('Failed to update completed form', error);
          }

          // Get session and send to Claude
          const session = this.claudeHandler.getSessionByKey(sessionKey);
          if (session) {
            const say = async (args: any) => {
              const msgArgs = typeof args === 'string' ? { text: args } : args;
              return this.app.client.chat.postMessage({
                channel,
                ...msgArgs,
              });
            };

            await this.handleMessage(
              {
                user: userId,
                channel,
                thread_ts: pendingForm.threadTs,
                ts: messageTs,
                text: combinedMessage,
              } as MessageEvent,
              say
            );
          } else {
            this.logger.warn('Session not found for multi-choice completion', { sessionKey });
            await this.app.client.chat.postEphemeral({
              channel,
              user: userId,
              text: '❌ 세션을 찾을 수 없습니다. 대화가 만료되었을 수 있습니다.',
            });
          }
        }
      } catch (error) {
        this.logger.error('Error processing multi-choice selection', error);
      }
    });

    // Handle custom input button for single choice
    this.app.action('custom_input_single', async ({ ack, body, client }) => {
      await ack();

      try {
        const action = (body as any).actions[0];
        const valueData = JSON.parse(action.value);
        const { sessionKey, question } = valueData;
        const triggerId = (body as any).trigger_id;
        const channel = (body as any).channel?.id;
        const messageTs = (body as any).message?.ts;
        const threadTs = (body as any).message?.thread_ts || messageTs;

        // Open modal for text input
        await client.views.open({
          trigger_id: triggerId,
          view: {
            type: 'modal',
            callback_id: 'custom_input_submit',
            private_metadata: JSON.stringify({
              sessionKey,
              question,
              channel,
              messageTs,
              threadTs,
              type: 'single',
            }),
            title: {
              type: 'plain_text',
              text: '직접 입력',
              emoji: true,
            },
            submit: {
              type: 'plain_text',
              text: '제출',
              emoji: true,
            },
            close: {
              type: 'plain_text',
              text: '취소',
              emoji: true,
            },
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: `*${question}*`,
                },
              },
              {
                type: 'input',
                block_id: 'custom_input_block',
                element: {
                  type: 'plain_text_input',
                  action_id: 'custom_input_text',
                  multiline: true,
                  placeholder: {
                    type: 'plain_text',
                    text: '원하는 내용을 자유롭게 입력하세요...',
                  },
                },
                label: {
                  type: 'plain_text',
                  text: '응답',
                  emoji: true,
                },
              },
            ],
          },
        });
      } catch (error) {
        this.logger.error('Error opening custom input modal', error);
      }
    });

    // Handle custom input button for multi-choice
    this.app.action(/^custom_input_multi_/, async ({ ack, body, client }) => {
      await ack();

      try {
        const action = (body as any).actions[0];
        const valueData = JSON.parse(action.value);
        const { formId, sessionKey, questionId, question } = valueData;
        const triggerId = (body as any).trigger_id;
        const channel = (body as any).channel?.id;
        const messageTs = (body as any).message?.ts;
        const threadTs = (body as any).message?.thread_ts || messageTs;

        // Open modal for text input
        await client.views.open({
          trigger_id: triggerId,
          view: {
            type: 'modal',
            callback_id: 'custom_input_submit',
            private_metadata: JSON.stringify({
              formId,
              sessionKey,
              questionId,
              question,
              channel,
              messageTs,
              threadTs,
              type: 'multi',
            }),
            title: {
              type: 'plain_text',
              text: '직접 입력',
              emoji: true,
            },
            submit: {
              type: 'plain_text',
              text: '제출',
              emoji: true,
            },
            close: {
              type: 'plain_text',
              text: '취소',
              emoji: true,
            },
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: `*${question}*`,
                },
              },
              {
                type: 'input',
                block_id: 'custom_input_block',
                element: {
                  type: 'plain_text_input',
                  action_id: 'custom_input_text',
                  multiline: true,
                  placeholder: {
                    type: 'plain_text',
                    text: '원하는 내용을 자유롭게 입력하세요...',
                  },
                },
                label: {
                  type: 'plain_text',
                  text: '응답',
                  emoji: true,
                },
              },
            ],
          },
        });
      } catch (error) {
        this.logger.error('Error opening custom input modal for multi-choice', error);
      }
    });

    // Handle modal submission for custom input
    this.app.view('custom_input_submit', async ({ ack, body, view }) => {
      await ack();

      try {
        const metadata = JSON.parse(view.private_metadata);
        const { sessionKey, question, channel, messageTs, threadTs, type, formId, questionId } = metadata;
        const userId = body.user.id;

        // Get the input value
        const inputValue = view.state.values.custom_input_block.custom_input_text.value || '';

        this.logger.info('Custom input submitted', {
          type,
          sessionKey,
          questionId,
          inputLength: inputValue.length,
          userId,
        });

        if (type === 'single') {
          // Handle single choice custom input
          // Update the original message
          if (messageTs && channel) {
            try {
              await this.app.client.chat.update({
                channel,
                ts: messageTs,
                text: `✅ *${question}*\n직접 입력: _${inputValue.substring(0, 100)}${inputValue.length > 100 ? '...' : ''}_`,
                blocks: [
                  {
                    type: 'section',
                    text: {
                      type: 'mrkdwn',
                      text: `✅ *${question}*\n직접 입력: _${inputValue.substring(0, 200)}${inputValue.length > 200 ? '...' : ''}_`,
                    },
                  },
                ],
              });
            } catch (error) {
              this.logger.warn('Failed to update choice message after custom input', error);
            }
          }

          // Send to Claude
          const session = this.claudeHandler.getSessionByKey(sessionKey);
          if (session) {
            const say = async (args: any) => {
              const msgArgs = typeof args === 'string' ? { text: args } : args;
              return this.app.client.chat.postMessage({
                channel,
                ...msgArgs,
              });
            };

            await this.handleMessage(
              {
                user: userId,
                channel,
                thread_ts: threadTs,
                ts: messageTs,
                text: inputValue,
              } as MessageEvent,
              say
            );
          }
        } else if (type === 'multi') {
          // Handle multi-choice custom input
          const pendingForm = this.pendingChoiceForms.get(formId);
          if (!pendingForm) {
            this.logger.warn('Pending form not found for custom input', { formId });
            return;
          }

          // Store the custom selection
          pendingForm.selections[questionId] = {
            choiceId: '직접입력',
            label: inputValue.substring(0, 50) + (inputValue.length > 50 ? '...' : ''),
          };

          // Check if all questions answered
          const totalQuestions = pendingForm.questions.length;
          const answeredCount = Object.keys(pendingForm.selections).length;

          // Rebuild and update the form
          const choicesData: UserChoices = {
            type: 'user_choices',
            questions: pendingForm.questions,
          };

          const updatedBlocks = UserChoiceHandler.buildMultiChoiceFormBlocks(
            choicesData,
            formId,
            sessionKey,
            pendingForm.selections
          );

          try {
            await this.app.client.chat.update({
              channel,
              ts: messageTs,
              text: '📋 선택이 필요합니다',
              blocks: updatedBlocks,
            });
          } catch (error) {
            this.logger.warn('Failed to update multi-choice form after custom input', error);
          }

          // If all answered, send to Claude
          if (answeredCount === totalQuestions) {
            const responses = pendingForm.questions.map((q) => {
              const sel = pendingForm.selections[q.id];
              if (sel.choiceId === '직접입력') {
                return `${q.question}: (직접입력) ${sel.label}`;
              }
              return `${q.question}: ${sel.choiceId}. ${sel.label}`;
            });
            const combinedMessage = responses.join('\n');

            this.pendingChoiceForms.delete(formId);

            // Update form to completion
            try {
              await this.app.client.chat.update({
                channel,
                ts: messageTs,
                text: '✅ 모든 선택 완료',
                blocks: [
                  {
                    type: 'section',
                    text: {
                      type: 'mrkdwn',
                      text: `✅ *모든 선택 완료*\n\n${responses.map((r, i) => `${i + 1}. ${r}`).join('\n')}`,
                    },
                  },
                ],
              });
            } catch (error) {
              this.logger.warn('Failed to update completed form', error);
            }

            // Send to Claude
            const session = this.claudeHandler.getSessionByKey(sessionKey);
            if (session) {
              const say = async (args: any) => {
                const msgArgs = typeof args === 'string' ? { text: args } : args;
                return this.app.client.chat.postMessage({
                  channel,
                  ...msgArgs,
                });
              };

              await this.handleMessage(
                {
                  user: userId,
                  channel,
                  thread_ts: threadTs,
                  ts: messageTs,
                  text: combinedMessage,
                } as MessageEvent,
                say
              );
            }
          }
        }
      } catch (error) {
        this.logger.error('Error processing custom input submission', error);
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
   * Handle session expiry warning - send or update warning message
   */
  private async handleSessionWarning(
    session: ConversationSession,
    timeRemaining: number,
    existingMessageTs?: string
  ): Promise<string | undefined> {
    const warningText = `⚠️ *세션 만료 예정*\n\n이 세션은 *${MessageFormatter.formatTimeRemaining(timeRemaining)}* 후에 만료됩니다.\n세션을 유지하려면 메시지를 보내주세요.`;
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