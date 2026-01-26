/**
 * Command parsing utilities for Slack bot commands
 */

export type BypassAction = 'on' | 'off' | 'status';
export type PersonaAction = { action: 'list' | 'status' | 'set'; persona?: string };
export type ModelAction = { action: 'list' | 'status' | 'set'; model?: string };
export type NewCommandResult = { prompt?: string };

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
   * Check if text is a /new command
   */
  static isNewCommand(text: string): boolean {
    return /^\/?new(?:\s+[\s\S]*)?$/i.test(text.trim());
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
   * Check if text is a sessions command
   */
  static isSessionsCommand(text: string): boolean {
    return /^\/?sessions?$/i.test(text.trim());
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
   * Generate help message
   */
  static getHelpMessage(): string {
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
      '• `terminate <session-key>` - Terminate a specific session',
      '• `new` or `/new` - Reset session context (start fresh conversation in same thread)',
      '• `new <prompt>` or `/new <prompt>` - Reset and start with new prompt',
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
