/**
 * Command parsing utilities for Slack bot commands
 */

export type CctAction = { action: 'status' } | { action: 'set'; target: string } | { action: 'next' };

export type BypassAction = 'on' | 'off' | 'status';
export type SandboxAction = 'on' | 'off' | 'status';
export type PersonaAction = { action: 'list' | 'status' | 'set'; persona?: string };
export type MemoryAction =
  | { action: 'show' }
  | { action: 'clear'; index?: number }
  | { action: 'save'; target: 'memory' | 'user'; content: string };
export type ModelAction = { action: 'list' | 'status' | 'set'; model?: string };
export type NewCommandResult = { prompt?: string };
export type OnboardingCommandResult = { prompt?: string };
export type SessionsCommandResult = { isPublic: boolean };
export type SessionThemeCommandResult = { theme: string | null } | null;
export type LinkCommandResult = { linkType: 'issue' | 'pr' | 'doc'; url: string } | null;
export type LlmChatAction =
  | { action: 'show' }
  | { action: 'set'; provider: string; key: string; value: string }
  | { action: 'reset' }
  | { action: 'error'; message: string };
export type SessionCommandAction =
  | { type: 'info' }
  | { type: 'model'; action: 'status' | 'set'; model?: string }
  | { type: 'verbosity'; action: 'status' | 'set'; level?: string }
  | { type: 'effort'; action: 'status' | 'set'; level?: string }
  | { type: 'thinking'; action: 'status' | 'set'; value?: string }
  | { type: 'thinking_summary'; action: 'status' | 'set'; value?: string };

export type MarketplaceAction =
  | { action: 'list' }
  | { action: 'add'; repo: string; name?: string; ref?: string }
  | { action: 'remove'; name: string };

export type PluginsAction =
  | { action: 'list' }
  | { action: 'add'; pluginRef: string }
  | { action: 'remove'; pluginRef: string }
  | { action: 'update' }
  | { action: 'rollback'; pluginRef: string }
  | { action: 'backups'; pluginRef: string };

export type EmailAction = { action: 'status' } | { action: 'set'; email: string };

export type RateAction = { action: 'status' } | { action: 'up' } | { action: 'down' };

export type AdminAction =
  | { action: 'accept'; targetUser: string }
  | { action: 'deny'; targetUser: string }
  | { action: 'users' }
  | { action: 'config'; sub: 'show' }
  | { action: 'config'; sub: 'set'; key: string; value: string };

export class CommandParser {
  /**
   * Check if text is an admin command (accept/deny/users/config)
   */
  static isAdminCommand(text: string): boolean {
    const trimmed = text.trim();
    return (
      /^\/?(?:accept|deny)\s+<@\w+(?:\|[^>]*)?>$/i.test(trimmed) ||
      /^\/?users$/i.test(trimmed) ||
      /^\/?config\s+\S+/i.test(trimmed)
    );
  }

  /**
   * Parse admin command
   */
  static parseAdminCommand(text: string): AdminAction | null {
    const trimmed = text.trim();

    // accept <@U123> or accept <@U123|name>
    const acceptMatch = trimmed.match(/^\/?accept\s+<@(\w+)(?:\|[^>]*)?>$/i);
    if (acceptMatch) {
      return { action: 'accept', targetUser: acceptMatch[1] };
    }

    // deny <@U123> or deny <@U123|name>
    const denyMatch = trimmed.match(/^\/?deny\s+<@(\w+)(?:\|[^>]*)?>$/i);
    if (denyMatch) {
      return { action: 'deny', targetUser: denyMatch[1] };
    }

    // users
    if (/^\/?users$/i.test(trimmed)) {
      return { action: 'users' };
    }

    // config show
    if (/^\/?config\s+show$/i.test(trimmed)) {
      return { action: 'config', sub: 'show' };
    }

    // config KEY=VALUE
    const configSetMatch = trimmed.match(/^\/?config\s+(\w+)=(.*)$/i);
    if (configSetMatch) {
      return { action: 'config', sub: 'set', key: configSetMatch[1], value: configSetMatch[2] };
    }

    return null;
  }

  /**
   * Check if text is a cct/set_cct command
   */
  static isCctCommand(text: string): boolean {
    return /^\/?(?:cct|set_cct|nextcct)(?:\s+\S+)?$/i.test(text.trim());
  }

  /**
   * Parse cct command: "cct" → status, "set_cct cctN" → set, "nextcct" → next
   */
  static parseCctCommand(text: string): CctAction {
    const trimmed = text.trim();
    if (/^\/?nextcct$/i.test(trimmed)) {
      return { action: 'next' };
    }
    const match = trimmed.match(/^\/?set_cct\s+(\S+)$/i);
    if (match) {
      return { action: 'set', target: match[1] };
    }
    return { action: 'status' };
  }

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
  // --- Notify command ---
  static isNotifyCommand(text: string): boolean {
    return /^\/?notify\s/i.test(text.trim()) || /^\/?notify$/i.test(text.trim());
  }

  static parseNotifyCommand(text: string): { action: string; value?: string } | null {
    const trimmed = text.trim().replace(/^\//, '');
    // Handle "notify telegram off" as a special case
    const telegramOffMatch = trimmed.match(/^notify\s+telegram\s+off$/i);
    if (telegramOffMatch) {
      return { action: 'telegram_off' };
    }
    const match = trimmed.match(/^notify\s+(on|off|status|telegram)\s*(.*)$/i);
    if (!match) return null;
    return { action: match[1].toLowerCase(), value: match[2] || undefined };
  }

  // --- Webhook command ---
  static isWebhookCommand(text: string): boolean {
    return /^\/?webhook\s/i.test(text.trim()) || /^\/?webhook$/i.test(text.trim());
  }

  static parseWebhookCommand(text: string): { action: string; value?: string } | null {
    const trimmed = text.trim().replace(/^\//, '');
    const match = trimmed.match(/^webhook\s+(register|remove|test)\s*(.*)$/i);
    if (!match) return null;
    return { action: match[1].toLowerCase(), value: match[2] || undefined };
  }

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

  static isSandboxCommand(text: string): boolean {
    return /^\/?sandbox(?:\s+(?:on|off|true|false|enable|disable|status))?$/i.test(text.trim());
  }

  static parseSandboxCommand(text: string): SandboxAction {
    const match = text.trim().match(/^\/?sandbox(?:\s+(on|off|true|false|enable|disable|status))?$/i);
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
   * Check if text is a memory command
   */
  static isMemoryCommand(text: string): boolean {
    const t = text.trim();
    return /^\/?memory(?:\s+(?:show|clear(?:\s+\d+)?|save\s+(?:user|memory)\s+.+))?$/i.test(t);
  }

  /**
   * Parse memory command
   */
  static parseMemoryCommand(text: string): MemoryAction {
    const trimmed = text.trim();

    // memory save user|memory <content>
    const saveMatch = trimmed.match(/^\/?memory\s+save\s+(user|memory)\s+(.+)$/is);
    if (saveMatch) {
      return { action: 'save', target: saveMatch[1].toLowerCase() as 'memory' | 'user', content: saveMatch[2].trim() };
    }

    if (/^\/?memory\s+clear\s+(\d+)$/i.test(trimmed)) {
      const match = trimmed.match(/^\/?memory\s+clear\s+(\d+)$/i);
      return { action: 'clear', index: parseInt(match![1], 10) };
    }

    if (/^\/?memory\s+clear$/i.test(trimmed)) {
      return { action: 'clear' };
    }

    return { action: 'show' };
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
   * Check if text is a "show prompt" command (admin only)
   * Matches: "show prompt", "/show prompt", "show_prompt", "/show_prompt"
   */
  static isShowPromptCommand(text: string): boolean {
    return /^\/?show[_ ]prompt$/i.test(text.trim());
  }

  /**
   * Check if text is a "show instructions" command (admin only)
   * Matches: "show instructions", "/show instructions", "show_instructions", "/show_instructions"
   */
  static isShowInstructionsCommand(text: string): boolean {
    return /^\/?show[_ ]instructions$/i.test(text.trim());
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
   * Check if text is a /compact command (force context compaction)
   */
  static isCompactCommand(text: string): boolean {
    return /^\/?compact$/i.test(text.trim());
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
    return (
      /^\/?sessions?(?:\s+(?:public|theme(?:\s*=\s*\S+)?))?$/i.test(text.trim()) ||
      /^\/?theme(?:\s+(?:set\s+)?\S+|\s*=\s*\S+)?$/i.test(text.trim())
    );
  }

  /**
   * Check if text is a sessions theme command.
   * Matches: "sessions theme", "sessions theme=A", "theme", "theme set B", "theme=C"
   */
  static isSessionThemeCommand(text: string): boolean {
    const t = text.trim();
    return /^\/?sessions?\s+theme(\s*=\s*\S+)?$/i.test(t) || /^\/?theme(?:\s+(?:set\s+)?\S+|\s*=\s*\S+)?$/i.test(t);
  }

  /**
   * Parse session theme command.
   * Returns { theme: string } for set, { theme: null } for query, null if not a theme command.
   */
  static parseSessionThemeCommand(text: string): SessionThemeCommandResult {
    const t = text.trim();
    // "sessions theme=X" or "sessions theme X"
    const sessMatch = t.match(/^\/?sessions?\s+theme\s*[=\s]\s*(\S+)$/i);
    if (sessMatch) return { theme: sessMatch[1] };
    // "theme set X" or "theme=X" or "theme X"
    const themeMatch = t.match(/^\/?theme\s+(?:set\s+)?(\S+)$/i) || t.match(/^\/?theme\s*=\s*(\S+)$/i);
    if (themeMatch) return { theme: themeMatch[1] };
    // "sessions theme" or "theme" alone → query
    if (/^\/?sessions?\s+theme$/i.test(t) || /^\/?theme$/i.test(t)) return { theme: null };
    return null;
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
   * Check if text is an email command (set email / show email)
   */
  static isEmailCommand(text: string): boolean {
    return /^\/?(?:set|show)\s+email\b/i.test(text.trim());
  }

  /**
   * Parse email command
   */
  static parseEmailCommand(text: string): EmailAction {
    const trimmed = text.trim();

    if (/^\/?show\s+email\s*$/i.test(trimmed)) {
      return { action: 'status' };
    }

    const setMatch = trimmed.match(/^\/?set\s+email\s+(\S+)\s*$/i);
    if (setMatch) {
      // Strip Slack's mailto auto-link: <mailto:x@y|x@y> → x@y
      let email = setMatch[1];
      const mailtoMatch = email.match(/^<mailto:[^|]+\|([^>]+)>$/);
      if (mailtoMatch) {
        email = mailtoMatch[1];
      }
      return { action: 'set', email };
    }

    // "set email" with no argument → show status
    return { action: 'status' };
  }

  /**
   * Check if text is a rate command (rate / rate + / rate -)
   */
  static isRateCommand(text: string): boolean {
    return /^\/? *rate(?:\s+[+-])?\s*$/i.test(text.trim());
  }

  /**
   * Parse rate command
   */
  static parseRateCommand(text: string): RateAction {
    const trimmed = text.trim();
    if (/^\/? *rate\s+\+\s*$/i.test(trimmed)) return { action: 'up' };
    if (/^\/? *rate\s+-\s*$/i.test(trimmed)) return { action: 'down' };
    return { action: 'status' };
  }

  /**
   * Check if text is any llm_chat command (set/show/reset)
   */
  static isLlmChatCommand(text: string): boolean {
    return /^\/?(?:set|show|reset)\s+llm_chat\b/i.test(text.trim());
  }

  /**
   * Parse llm_chat command
   */
  static parseLlmChatCommand(text: string): LlmChatAction {
    const trimmed = text.trim();

    if (/^\/?show\s+llm_chat\s*$/i.test(trimmed)) {
      return { action: 'show' };
    }

    if (/^\/?reset\s+llm_chat\s*$/i.test(trimmed)) {
      return { action: 'reset' };
    }

    // Parse: set llm_chat <provider> <key> <value>
    const setMatch = trimmed.match(/^\/?set\s+llm_chat\s+(\S+)\s+(\S+)\s+(.+)$/i);
    if (setMatch) {
      return {
        action: 'set',
        provider: setMatch[1].toLowerCase(),
        key: setMatch[2].toLowerCase(),
        value: setMatch[3].trim(),
      };
    }

    // If "set llm_chat" but missing args, return error with usage guidance
    if (/^\/?set\s+llm_chat/i.test(trimmed)) {
      return {
        action: 'error',
        message: 'Usage: `set llm_chat <provider> <key> <value>`\nExample: `set llm_chat codex model gpt-5.4`',
      };
    }

    // Fallback for any other unrecognized pattern
    return {
      action: 'error',
      message:
        'Unrecognized llm_chat command.\nUsage: `show llm_chat` | `set llm_chat <provider> <key> <value>` | `reset llm_chat`',
    };
  }

  /**
   * Check if text is a marketplace command
   */
  static isMarketplaceCommand(text: string): boolean {
    return /^\/?marketplace(?:\s+(?:add|remove)\s+\S+(?:\s+--\S+\s+\S+)*)?$/i.test(text.trim());
  }

  /**
   * Parse marketplace command
   */
  static parseMarketplaceCommand(text: string): MarketplaceAction {
    const trimmed = text.trim();

    // Match: marketplace add owner/repo [--name x] [--ref y]
    const addMatch = trimmed.match(/^\/?marketplace\s+add\s+(\S+)(.*)?$/i);
    if (addMatch) {
      const repo = addMatch[1];
      const rest = addMatch[2] || '';
      const nameMatch = rest.match(/--name\s+(\S+)/i);
      const refMatch = rest.match(/--ref\s+(\S+)/i);
      const result: MarketplaceAction = { action: 'add', repo };
      const name = nameMatch?.[1];
      const ref = refMatch?.[1];
      if (name && ref) {
        return { action: 'add', repo, name, ref };
      }
      if (name) {
        return { action: 'add', repo, name };
      }
      if (ref) {
        return { action: 'add', repo, ref };
      }
      return result;
    }

    // Match: marketplace remove <name>
    const removeMatch = trimmed.match(/^\/?marketplace\s+remove\s+(\S+)$/i);
    if (removeMatch) {
      return { action: 'remove', name: removeMatch[1] };
    }

    return { action: 'list' };
  }

  /**
   * Check if text is a plugins command
   */
  static isPluginsCommand(text: string): boolean {
    const t = text.trim();
    return (
      /^\/?plugins(?:\s+(?:add|remove|rollback|backups)\s+\S+|\s+update)?$/i.test(t) ||
      /^\/?\uD50C\uB7EC\uADF8\uC778\s*\uC5C5\uB370\uC774\uD2B8$/i.test(t)
    );
  }

  /**
   * Parse plugins command
   */
  static parsePluginsCommand(text: string): PluginsAction {
    const trimmed = text.trim();

    // Match: plugins update / \uD50C\uB7EC\uADF8\uC778 \uC5C5\uB370\uC774\uD2B8
    if (/^\/?plugins\s+update$/i.test(trimmed) || /^\/?\uD50C\uB7EC\uADF8\uC778\s*\uC5C5\uB370\uC774\uD2B8$/i.test(trimmed)) {
      return { action: 'update' };
    }

    // Match: plugins add <pluginRef>
    const addMatch = trimmed.match(/^\/?plugins\s+add\s+(\S+)$/i);
    if (addMatch) {
      return { action: 'add', pluginRef: addMatch[1] };
    }

    // Match: plugins remove <pluginRef>
    const removeMatch = trimmed.match(/^\/?plugins\s+remove\s+(\S+)$/i);
    if (removeMatch) {
      return { action: 'remove', pluginRef: removeMatch[1] };
    }

    // Match: plugins rollback <pluginRef>
    const rollbackMatch = trimmed.match(/^\/?plugins\s+rollback\s+(\S+)$/i);
    if (rollbackMatch) {
      return { action: 'rollback', pluginRef: rollbackMatch[1] };
    }

    // Match: plugins backups <pluginRef>
    const backupsMatch = trimmed.match(/^\/?plugins\s+backups\s+(\S+)$/i);
    if (backupsMatch) {
      return { action: 'backups', pluginRef: backupsMatch[1] };
    }

    return { action: 'list' };
  }

  /**
   * Check if text is a session command ($ prefix)
   * Matches: $, $model, $model opus, $verbosity, $verbosity compact
   */
  static isSessionCommand(text: string): boolean {
    return /^\$(?:model|verbosity|effort|thinking_summary|thinking)?(?:\s+\S+)?$/i.test(text.trim());
  }

  /**
   * Parse session command ($, $model [value], $verbosity [value])
   */
  static parseSessionCommand(text: string): SessionCommandAction {
    const trimmed = text.trim();

    const modelMatch = trimmed.match(/^\$model(?:\s+(\S+))?$/i);
    if (modelMatch) {
      return modelMatch[1]
        ? { type: 'model', action: 'set', model: modelMatch[1] }
        : { type: 'model', action: 'status' };
    }

    const verbosityMatch = trimmed.match(/^\$verbosity(?:\s+(\S+))?$/i);
    if (verbosityMatch) {
      return verbosityMatch[1]
        ? { type: 'verbosity', action: 'set', level: verbosityMatch[1] }
        : { type: 'verbosity', action: 'status' };
    }

    const effortMatch = trimmed.match(/^\$effort(?:\s+(\S+))?$/i);
    if (effortMatch) {
      return effortMatch[1]
        ? { type: 'effort', action: 'set', level: effortMatch[1] }
        : { type: 'effort', action: 'status' };
    }

    // $thinking_summary must be checked before $thinking (longer prefix first)
    const thinkingSummaryMatch = trimmed.match(/^\$thinking_summary(?:\s+(\S+))?$/i);
    if (thinkingSummaryMatch) {
      return thinkingSummaryMatch[1]
        ? { type: 'thinking_summary', action: 'set', value: thinkingSummaryMatch[1] }
        : { type: 'thinking_summary', action: 'status' };
    }

    const thinkingMatch = trimmed.match(/^\$thinking(?:\s+(\S+))?$/i);
    if (thinkingMatch) {
      return thinkingMatch[1]
        ? { type: 'thinking', action: 'set', value: thinkingMatch[1] }
        : { type: 'thinking', action: 'status' };
    }

    return { type: 'info' };
  }

  /**
   * Known command keywords (including future commands)
   */
  private static readonly COMMAND_KEYWORDS = new Set([
    // Admin commands
    'accept',
    'deny',
    'users',
    'config',
    // Token management
    'cct',
    'set_cct',
    'nextcct',
    // Working directory
    'cwd',
    // MCP
    'mcp',
    'servers',
    // Permissions
    'bypass',
    // Sandbox
    'sandbox',
    // Memory
    'memory',
    // Persona & Model & Verbosity
    'persona',
    'model',
    'verbosity',
    // Sessions
    'sessions',
    'terminate',
    'kill',
    'end',
    'new',
    'onboarding',
    'context',
    'renew',
    'compact',
    'close',
    'link',
    // Credentials
    'restore',
    'credentials',
    // Help
    'help',
    'commands',
    // Marketplace & Plugins
    'marketplace',
    'plugins',
    '\uD50C\uB7EC\uADF8\uC778',
    // Future: save/load (oh-my-claude skills)
    'save',
    'load',
    // Email
    'set_email',
    'show_email',
    // Admin: show prompt / show instructions (exact two-word forms)
    'show_prompt',
    'show_instructions',
    // Rating
    'rate',
    // Notification
    'notify',
    'webhook',
  ]);

  /**
   * Check if text looks like a command but may not be recognized
   * Used to provide feedback for unrecognized commands
   */
  static isPotentialCommand(text: string): { isPotential: boolean; keyword?: string } {
    const trimmed = text.trim();
    if (!trimmed) return { isPotential: false };

    const normalized = trimmed.toLowerCase().replace(/\s+/g, ' ');
    const words = normalized.split(' ');
    const firstWord = words[0];

    // $ prefix: only known session command roots ($, $model, $verbosity, $effort, $thinking, $thinking_summary)
    if (firstWord.startsWith('$')) {
      if (/^\$(?:model|verbosity|effort|thinking_summary|thinking)?(?:\s|$)/i.test(normalized)) {
        return { isPotential: true, keyword: firstWord };
      }
      return { isPotential: false };
    }

    // / prefix: only if the slash-root is a known keyword
    if (firstWord.startsWith('/')) {
      const slashRoot = firstWord.slice(1);
      if (CommandParser.COMMAND_KEYWORDS.has(slashRoot)) {
        return { isPotential: true, keyword: slashRoot };
      }
      if (words.length >= 2) {
        const twoWord = `${slashRoot}_${words[1]}`;
        if (CommandParser.COMMAND_KEYWORDS.has(twoWord)) {
          return { isPotential: true, keyword: twoWord };
        }
      }
      return { isPotential: false };
    }

    // Plain text: ONLY exact single-word match (e.g., "help" alone, not "help me with X")
    if (words.length === 1 && CommandParser.COMMAND_KEYWORDS.has(firstWord)) {
      return { isPotential: true, keyword: firstWord };
    }

    // Exact fixed multi-word commands (e.g., "show prompt", "show instructions")
    if (words.length === 2) {
      const twoWord = `${words[0]}_${words[1]}`;
      if (CommandParser.COMMAND_KEYWORDS.has(twoWord)) {
        return { isPotential: true, keyword: twoWord };
      }
    }

    return { isPotential: false };
  }

  /**
   * Generate help message
   */
  static getHelpMessage(): string {
    const commands = [
      '*\uD83D\uDCDA Available Commands*',
      '',
      '*Working Directory:*',
      '\u2022 `cwd` or `/cwd` - Show current working directory',
      '  _\uAC01 \uC0AC\uC6A9\uC790\uB294 \uACE0\uC815\uB41C \uB514\uB809\uD1A0\uB9AC(`BASE_DIR/{userId}/`)\uB97C \uC0AC\uC6A9\uD569\uB2C8\uB2E4._',
      '',
      '*Sessions:*',
      '\u2022 `sessions` or `/sessions` - Show your active sessions (ephemeral)',
      '\u2022 `sessions public` - Show your sessions to everyone in channel',
      '\u2022 `all_sessions` or `/all_sessions` - Show all active sessions',
      '\u2022 `terminate <session-key>` - Terminate a specific session',
      "\u2022 `close` or `/close` - Close current thread's session",
      '\u2022 `new` or `/new` - Reset session context (start fresh conversation in same thread)',
      '\u2022 `new <prompt>` or `/new <prompt>` - Reset and start with new prompt',
      '\u2022 `onboarding` or `/onboarding` - Run onboarding workflow anytime',
      '\u2022 `context` or `/context` - Show current session token usage and cost',
      '\u2022 `renew` or `/renew` - Save context, reset session, and reload (for long sessions)',
      '\u2022 `compact` or `/compact` - Force context compaction (for testing compression)',
      '',
      '*Links:*',
      '\u2022 `link issue <url>` - Attach issue link to current session',
      '\u2022 `link pr <url>` - Attach PR link to current session',
      '\u2022 `link doc <url>` - Attach doc link to current session',
      '',
      '*MCP Servers:*',
      '\u2022 `mcp` or `/mcp` - Show MCP server status',
      '\u2022 `mcp reload` or `/mcp reload` - Reload MCP configuration',
      '',
      '*Permissions:*',
      '\u2022 `bypass` or `/bypass` - Show permission bypass status',
      '\u2022 `bypass on` or `/bypass on` - Enable permission bypass',
      '\u2022 `bypass off` or `/bypass off` - Disable permission bypass',
      '',
      '*Sandbox:*',
      '\u2022 `sandbox` or `/sandbox` - Show sandbox status',
      '\u2022 `sandbox on` or `/sandbox on` - Enable sandbox (admin only)',
      '\u2022 `sandbox off` or `/sandbox off` - Disable sandbox (admin only)',
      '',
      '*Email:*',
      '\u2022 `show email` - Show your configured email',
      '\u2022 `set email <email>` - Set your email (used for Co-Authored-By in commits)',
      '',
      '*Rating:*',
      '\u2022 `rate` - Show current model rating',
      '\u2022 `rate +` - Increase rating by 1 (max 10)',
      '\u2022 `rate -` - Decrease rating by 1 (min 0)',
      '',
      '*Persona:*',
      '\u2022 `persona` or `/persona` - Show current persona',
      '\u2022 `persona list` or `/persona list` - List available personas',
      '\u2022 `persona set <name>` or `/persona set <name>` - Set persona',
      '',
      '*Model & Verbosity:*',
      '\u2022 `model` - Show/set default model (persists across sessions)',
      '\u2022 `model <name>` - Set default model (e.g., `model opus`)',
      '\u2022 `model list` - List available models',
      '\u2022 `verbosity` - Show current log verbosity',
      '\u2022 `verbosity <level>` - Set log verbosity (minimal/compact/detail/verbose)',
      '',
      '*LLM Chat Config:*',
      '\u2022 `show llm_chat` - Show current llm_chat model configuration',
      '\u2022 `set llm_chat <provider> model <value>` - Change model (e.g., `set llm_chat codex model gpt-5.4`)',
      '\u2022 `set llm_chat <provider> model_reasoning_effort <value>` - Change reasoning effort',
      '\u2022 `reset llm_chat` - Reset llm_chat config to defaults',
      '',
      '*Session Settings ($ prefix):*',
      '\u2022 `$` - Show current session info (model, effort, verbosity, context, etc.)',
      '\u2022 `$model` - Show session model',
      '\u2022 `$model <name>` - Change model for this session only',
      '\u2022 `$effort` - Show session effort level',
      '\u2022 `$effort <level>` - Change effort for this session only (low/medium/high/max)',
      '\u2022 `$verbosity` - Show session verbosity',
      '\u2022 `$verbosity <level>` - Change verbosity for this session only',
      '\u2022 `$thinking` - Show extended thinking (adaptive reasoning) status',
      '\u2022 `$thinking on|off` - Toggle extended thinking for this session',
      '\u2022 `$thinking_summary` - Show thinking summary display status',
      '\u2022 `$thinking_summary on|off` - Toggle thinking output display for this session',
      '',
      '*Marketplace:*',
      '\u2022 `marketplace` or `/marketplace` - Show registered marketplaces',
      '\u2022 `marketplace add owner/repo` - Add a marketplace from GitHub repo',
      '\u2022 `marketplace add owner/repo --name custom` - Add with custom name',
      '\u2022 `marketplace add owner/repo --ref branch` - Add with specific git ref',
      '\u2022 `marketplace remove name` - Remove a marketplace by name',
      '',
      '*Plugins:*',
      '\u2022 `plugins` or `/plugins` - Show installed plugins',
      '\u2022 `plugins add pluginName@marketplaceName` - Install a plugin',
      '\u2022 `plugins remove pluginName@marketplaceName` - Remove a plugin',
      '\u2022 `plugins update` or `\uD50C\uB7EC\uADF8\uC778 \uC5C5\uB370\uC774\uD2B8` - Force re-download all plugins (Admin only)',
      '',
      '*Prompt & Instructions (Admin):*',
      '\u2022 `show prompt` - Show the system prompt used in this session',
      '\u2022 `show instructions` - Show user instructions stored in this session',
      '',
      '*Token Management (Admin):*',
      '\u2022 `cct` - Show OAuth token pool status',
      '\u2022 `set_cct <name>` - Switch active token (e.g., `set_cct cct2`)',
      '\u2022 `nextcct` - Rotate to next available token',
      '',
      '*Credentials:*',
      '\u2022 `restore` or `/restore` - Restore Claude credentials from backup',
      '',
      '*Help:*',
      '\u2022 `help` or `/help` - Show this help message',
    ];
    return commands.join('\n');
  }
}
