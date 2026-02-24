/**
 * Command parsing utilities for Slack bot commands
 */

export type BypassAction = 'on' | 'off' | 'status';
export type PersonaAction = { action: 'list' | 'status' | 'set'; persona?: string };
export type ModelAction = { action: 'list' | 'status' | 'set'; model?: string };
export type NewCommandResult = { prompt?: string };
export type OnboardingCommandResult = { prompt?: string };
export type SessionsCommandResult = { isPublic: boolean };
export type LinkCommandResult = { linkType: 'issue' | 'pr' | 'doc'; url: string } | null;

export class CommandParser {
  /**
   * Check if text is an MCP info command
   */
  static isMcpInfoCommand(text: string): boolean {
    return /^\/?(?:mcp|servers?)(?:\s+(?:info|list|status))?(?:\?)?$/i.test(text.trim());
  }

  /**
   * Check if text is an MCP reload command
   */
  static isMcpReloadCommand(text: string): boolean {
    return /^\/?(?:mcp|servers?)\s+(?:reload|refresh)$/i.test(text.trim());
  }

  /**
   * Check if text is a bypass command
   */
  static isBypassCommand(text: string): boolean {
    return /^\/?bypass(?:\s+(?:on|off|true|false|enable|disable|status))?$/i.test(text.trim());
  }

  /**
   * Parse bypass command to determine action
   */
  static parseBypassCommand(text: string): BypassAction {
    const match = text.trim().match(/^\/?bypass(?:\s+(on|off|true|false|enable|disable|status))?$/i);
    if (!match?.[1]) {
      return 'status';
    }

    const action = match[1].toLowerCase();
    const enableActions = ['on', 'true', 'enable'];
    const disableActions = ['off', 'false', 'disable'];

    if (enableActions.includes(action)) return 'on';
    if (disableActions.includes(action)) return 'off';
    return 'status';
  }

  /**
   * Check if text is a persona command
   */
  static isPersonaCommand(text: string): boolean {
    return /^\/?persona(?:\s+(?:list|status|set\s+\S+))?$/i.test(text.trim());
  }

  /**
   * Parse persona command
   */
  static parsePersonaCommand(text: string): PersonaAction {
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

  /**
   * Check if text is a model command
   */
  static isModelCommand(text: string): boolean {
    return /^\/?model(?:\s+(?:list|status|set\s+\S+|\S+))?$/i.test(text.trim());
  }

  /**
   * Parse model command
   */
  static parseModelCommand(text: string): ModelAction {
    const trimmed = text.trim();

    if (/^\/?model\s+list$/i.test(trimmed)) {
      return { action: 'list' };
    }

    // Match "model set opus-4.5" or "model opus-4.5" (shorthand)
    const setMatch = trimmed.match(/^\/?model\s+(?:set\s+)?(\S+)$/i);
    if (setMatch && setMatch[1] !== 'list' && setMatch[1] !== 'status') {
      return { action: 'set', model: setMatch[1] };
    }

    return { action: 'status' };
  }

  /**
   * Check if text is a verbosity command
   */
  static isVerbosityCommand(text: string): boolean {
    return /^\/?verbosity(?:\s+\S+)?$/i.test(text.trim());
  }

  /**
   * Parse verbosity command
   */
  static parseVerbosityCommand(text: string): { action: 'status' | 'set'; level?: string } {
    const trimmed = text.trim();
    const match = trimmed.match(/^\/?verbosity\s+(\S+)$/i);
    if (match && match[1] !== 'status') {
      return { action: 'set', level: match[1] };
    }
    return { action: 'status' };
  }

  /**
   * Check if text is a restore credentials command
   */
  static isRestoreCommand(text: string): boolean {
    return /^\/?(?:restore|credentials?)(?:\s+(?:restore|status))?$/i.test(text.trim());
  }

  /**
   * Check if text is a help command
   */
  static isHelpCommand(text: string): boolean {
    return /^\/?(?:help|commands?)(?:\?)?$/i.test(text.trim());
  }

  /**
   * Check if text is a context command (shows token usage)
   */
  static isContextCommand(text: string): boolean {
    return /^\/?context$/i.test(text.trim());
  }

  /**
   * Check if text is a renew command (save → reset → load)
   * Supports: renew, /renew, renew <prompt>, /renew <prompt>
   */
  static isRenewCommand(text: string): boolean {
    return /^\/?renew(?:\s+[\s\S]*)?$/i.test(text.trim());
  }

  /**
   * Check if text is a /new command
   */
  static isNewCommand(text: string): boolean {
    return /^\/?new(?:\s+[\s\S]*)?$/i.test(text.trim());
  }

  /**
   * Check if text is an onboarding command
   */
  static isOnboardingCommand(text: string): boolean {
    return /^\/?onboarding(?:\s+[\s\S]*)?$/i.test(text.trim());
  }

  /**
   * Parse /new command to extract optional prompt
   */
  static parseNewCommand(text: string): NewCommandResult {
    const match = text.trim().match(/^\/?new(?:\s+(.+))?$/is);
    if (!match) {
      return {};
    }
    // match[1] is the optional prompt (everything after /new)
    const prompt = match[1]?.trim();
    return { prompt: prompt || undefined };
  }

  /**
   * Parse /onboarding command to extract optional prompt
   */
  static parseOnboardingCommand(text: string): OnboardingCommandResult {
    const match = text.trim().match(/^\/?onboarding(?:\s+(.+))?$/is);
    if (!match) {
      return {};
    }

    const prompt = match[1]?.trim();
    return { prompt: prompt || undefined };
  }

  /**
   * Check if text is a sessions command (with optional 'public' flag)
   */
  static isSessionsCommand(text: string): boolean {
    return /^\/?sessions?(?:\s+public)?$/i.test(text.trim());
  }

  /**
   * Parse sessions command to determine if public
   */
  static parseSessionsCommand(text: string): SessionsCommandResult {
    const isPublic = /^\/?sessions?\s+public$/i.test(text.trim());
    return { isPublic };
  }

  /**
   * Check if text is an all_sessions command
   */
  static isAllSessionsCommand(text: string): boolean {
    return /^\/?all_sessions?$/i.test(text.trim());
  }

  /**
   * Parse terminate command, returns session key or null
   */
  static parseTerminateCommand(text: string): string | null {
    const match = text.trim().match(/^\/?(?:terminate|kill|end)(?:_session)?\s+(.+)$/i);
    return match ? match[1].trim() : null;
  }

  /**
   * Check if text is a close command
   */
  static isCloseCommand(text: string): boolean {
    return /^\/?close$/i.test(text.trim());
  }

  /**
   * Check if text is a link command
   */
  static isLinkCommand(text: string): boolean {
    return /^\/?link\s+(?:issue|pr|doc)\s+\S+$/i.test(text.trim());
  }

  /**
   * Parse link command
   * Example: "link issue https://xxx.atlassian.net/browse/PTN-123"
   */
  static parseLinkCommand(text: string): LinkCommandResult {
    const match = text.trim().match(/^\/?link\s+(issue|pr|doc)\s+(\S+)$/i);
    if (!match) return null;
    return {
      linkType: match[1].toLowerCase() as 'issue' | 'pr' | 'doc',
      url: match[2],
    };
  }

  /**
   * Known command keywords (including future commands)
   */
  private static readonly COMMAND_KEYWORDS = new Set([
    // Working directory
    'cwd',
    // MCP
    'mcp', 'servers',
    // Permissions
    'bypass',
    // Persona & Model & Verbosity
    'persona', 'model', 'verbosity',
    // Sessions
    'sessions', 'terminate', 'kill', 'end', 'new', 'onboarding', 'context', 'renew', 'close', 'link',
    // Credentials
    'restore', 'credentials',
    // Help
    'help', 'commands',
    // Future: save/load (oh-my-claude skills)
    'save', 'load',
  ]);

  /**
   * Check if text looks like a command but may not be recognized
   * Used to provide feedback for unrecognized commands
   */
  static isPotentialCommand(text: string): { isPotential: boolean; keyword?: string } {
    const trimmed = text.trim().toLowerCase();
    const firstWord = trimmed.split(/\s+/)[0];

    // Starts with slash - likely a command attempt
    if (trimmed.startsWith('/')) {
      return { isPotential: true, keyword: firstWord.slice(1) };
    }

    // Check against known command keywords
    if (this.COMMAND_KEYWORDS.has(firstWord)) {
      return { isPotential: true, keyword: firstWord };
    }

    return { isPotential: false };
  }

  /**
   * Generate help message
   */
  static getHelpMessage(): string {
    const commands = [
      '*📚 Available Commands*',
      '',
      '*Working Directory:*',
      '• `cwd` or `/cwd` - Show current working directory',
      '  _각 사용자는 고정된 디렉토리(`BASE_DIR/{userId}/`)를 사용합니다._',
      '',
      '*Sessions:*',
      '• `sessions` or `/sessions` - Show your active sessions (ephemeral)',
      '• `sessions public` - Show your sessions to everyone in channel',
      '• `all_sessions` or `/all_sessions` - Show all active sessions',
      '• `terminate <session-key>` - Terminate a specific session',
      '• `close` or `/close` - Close current thread\'s session',
      '• `new` or `/new` - Reset session context (start fresh conversation in same thread)',
      '• `new <prompt>` or `/new <prompt>` - Reset and start with new prompt',
      '• `onboarding` or `/onboarding` - Run onboarding workflow anytime',
      '• `context` or `/context` - Show current session token usage and cost',
      '• `renew` or `/renew` - Save context, reset session, and reload (for long sessions)',
      '',
      '*Links:*',
      '• `link issue <url>` - Attach issue link to current session',
      '• `link pr <url>` - Attach PR link to current session',
      '• `link doc <url>` - Attach doc link to current session',
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
      '*Model:*',
      '• `model` or `/model` - Show current default model',
      '• `model list` or `/model list` - List available models',
      '• `verbosity` or `/verbosity` - Show current log verbosity',
      '• `verbosity <level>` - Set log verbosity (minimal/compact/detail/verbose)',
      '• `model <name>` or `/model <name>` - Set default model (e.g., `model opus-4.5`)',
      '',
      '*Credentials:*',
      '• `restore` or `/restore` - Restore Claude credentials from backup',
      '',
      '*Help:*',
      '• `help` or `/help` - Show this help message',
    ];
    return commands.join('\n');
  }
}
