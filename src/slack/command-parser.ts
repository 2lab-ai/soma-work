/**
 * Command parsing utilities for Slack bot commands
 */

import { EFFORT_LEVELS } from '../user-settings-store';

export type CctAction =
  | { action: 'status' }
  | { action: 'set'; target: string }
  | { action: 'next' }
  | { action: 'usage'; target?: string }
  | { action: 'add-forbidden' }
  | { action: 'rm-forbidden' };

export type BypassAction = 'on' | 'off' | 'status';
export type SandboxAction = 'on' | 'off' | 'status';
export type SandboxTarget = 'sandbox' | 'network';
export type SandboxCommand = { target: SandboxTarget; action: SandboxAction };
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
   * Check if text is a cct command.
   *
   * `/z` refactor (#506): only the canonical `cct` / `cct set <n>` / `cct next`
   * forms are accepted. Legacy `set_cct <n>` / `nextcct` underscore aliases
   * are no longer recognised — ZRouter.translateToLegacy bridges the `/z` form
   * before we reach here.
   *
   * Wave 5 (#569): the text grammar is now READ-ONLY for write operations.
   * `cct usage [<name>]` is accepted; `cct add …` and `cct rm …` are matched
   * so the handler can emit a "use the card" error — token mutation via text
   * is disabled in favour of the `/z cct` Block Kit modal buttons.
   */
  static isCctCommand(text: string): boolean {
    return /^\/?cct(?:\s+(?:next|set\s+\S+|usage(?:\s+\S+)?|add(?:\s+.*)?|rm(?:\s+.*)?|remove(?:\s+.*)?))?$/i.test(
      text.trim(),
    );
  }

  /**
   * Parse cct command.
   *
   * Accepted forms:
   *   - `cct`                          → { action: 'status' }
   *   - `cct set <name>`               → { action: 'set', target }
   *   - `cct next`                     → { action: 'next' }
   *   - `cct usage`                    → { action: 'usage' }
   *   - `cct usage <name>`             → { action: 'usage', target }
   *   - `cct add …`                    → { action: 'add-forbidden' } (handler emits error)
   *   - `cct rm …` / `cct remove …`    → { action: 'rm-forbidden' } (handler emits error)
   */
  static parseCctCommand(text: string): CctAction {
    const trimmed = text.trim();
    if (/^\/?cct\s+next$/i.test(trimmed)) {
      return { action: 'next' };
    }
    const setMatch = trimmed.match(/^\/?cct\s+set\s+(\S+)$/i);
    if (setMatch) {
      return { action: 'set', target: setMatch[1] };
    }
    // usage with optional name
    const usageMatch = trimmed.match(/^\/?cct\s+usage(?:\s+(\S+))?$/i);
    if (usageMatch) {
      const target = usageMatch[1];
      return target ? { action: 'usage', target } : { action: 'usage' };
    }
    // add / rm / remove — forbidden via text; handler returns error referencing the card.
    if (/^\/?cct\s+add\b/i.test(trimmed)) {
      return { action: 'add-forbidden' };
    }
    if (/^\/?cct\s+(?:rm|remove)\b/i.test(trimmed)) {
      return { action: 'rm-forbidden' };
    }
    return { action: 'status' };
  }

  /**
   * Check if text is an MCP info command.
   *
   * `/z` refactor (#506): legacy `servers` / `server` / `?` suffix aliases
   * are removed — only the canonical `mcp` / `mcp list` / `mcp info` /
   * `mcp status` forms are accepted.
   */
  static isMcpInfoCommand(text: string): boolean {
    return /^\/?mcp(?:\s+(?:info|list|status))?$/i.test(text.trim());
  }

  /**
   * Check if text is an MCP reload command.
   */
  static isMcpReloadCommand(text: string): boolean {
    return /^\/?mcp\s+(?:reload|refresh)$/i.test(text.trim());
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

  /**
   * Matches:
   *   sandbox
   *   sandbox on|off|true|false|enable|disable|status
   *   sandbox network
   *   sandbox network on|off|true|false|enable|disable|status
   */
  static isSandboxCommand(text: string): boolean {
    return /^\/?sandbox(?:\s+network)?(?:\s+(?:on|off|true|false|enable|disable|status))?$/i.test(text.trim());
  }

  /**
   * Parse sandbox command. Returns `{ target, action }` where target is
   * either `sandbox` (the OS-level sandbox itself) or `network` (the
   * per-user network allowlist toggle inside the sandbox). Missing action
   * resolves to `status`.
   */
  static parseSandboxCommand(text: string): SandboxCommand {
    const match = text.trim().match(/^\/?sandbox(?:\s+(network))?(?:\s+(on|off|true|false|enable|disable|status))?$/i);
    const target: SandboxTarget = match?.[1] ? 'network' : 'sandbox';
    if (!match?.[2]) {
      return { target, action: 'status' };
    }

    const action = match[2].toLowerCase();
    const enableActions = ['on', 'true', 'enable'];
    const disableActions = ['off', 'false', 'disable'];

    if (enableActions.includes(action)) return { target, action: 'on' };
    if (disableActions.includes(action)) return { target, action: 'off' };
    return { target, action: 'status' };
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
   * Check if text is an effort command (user-global setter).
   *
   * `effort` / `effort <level>` sets the user's default effort level and
   * persists it via `userSettingsStore.setUserDefaultEffort()`. Affects all
   * future sessions plus the current session live.
   *
   * Session-only changes use the `%effort` / `$effort` prefix forms handled
   * by `SessionCommandHandler`. Invariant: bare command = user-global,
   * prefixed command = session-scoped.
   */
  static isEffortCommand(text: string): boolean {
    return /^\/?effort(?:\s+\S+)?$/i.test(text.trim());
  }

  /**
   * Parse effort command: `effort`, `effort status`, `effort <level>`.
   */
  static parseEffortCommand(text: string): { action: 'status' | 'set'; level?: string } {
    const trimmed = text.trim();
    const match = trimmed.match(/^\/?effort\s+(\S+)$/i);
    if (match && match[1] !== 'status') {
      return { action: 'set', level: match[1] };
    }
    return { action: 'status' };
  }

  /**
   * Check if text is a restore credentials command.
   *
   * `/z` refactor (#506): legacy `credentials` / `credentials status` aliases
   * are removed — only `restore` / `restore status` / `restore restore` forms
   * are accepted (tombstone redirects legacy callers).
   */
  static isRestoreCommand(text: string): boolean {
    return /^\/?restore(?:\s+(?:restore|status))?$/i.test(text.trim());
  }

  /**
   * Check if text is a "show prompt" command (admin only).
   *
   * `/z` refactor (#506): underscore alias `show_prompt` is removed —
   * only the space form `show prompt` is accepted.
   */
  static isShowPromptCommand(text: string): boolean {
    return /^\/?show\s+prompt$/i.test(text.trim());
  }

  /**
   * Check if text is a "show instructions" command (admin only).
   *
   * `/z` refactor (#506): underscore alias `show_instructions` is removed —
   * only the space form `show instructions` is accepted.
   */
  static isShowInstructionsCommand(text: string): boolean {
    return /^\/?show\s+instructions$/i.test(text.trim());
  }

  /**
   * Check if text is a help command.
   *
   * `/z` refactor (#506): legacy `commands` / `command` / `?` suffix aliases
   * are removed — only `help` is accepted (tombstone redirects `commands`).
   */
  static isHelpCommand(text: string): boolean {
    return /^\/?help$/i.test(text.trim());
  }

  /**
   * Check if text is a context command (shows token usage)
   */
  static isContextCommand(text: string): boolean {
    return /^\/?context$/i.test(text.trim());
  }

  /**
   * Check if text is a usage command
   */
  static isUsageCommand(text: string): boolean {
    return /^\/?usage(?:\s+.*)?$/i.test(text.trim());
  }

  /**
   * Parse usage command: usage [week|month] [@user]
   */
  static parseUsageCommand(text: string): { period: 'today' | 'week' | 'month'; userId?: string } {
    const trimmed = text.trim().replace(/^\//, '');
    let period: 'today' | 'week' | 'month' = 'today';
    let userId: string | undefined;

    const parts = trimmed
      .replace(/^usage\s*/i, '')
      .trim()
      .split(/\s+/);
    for (const part of parts) {
      if (/^week$/i.test(part)) period = 'week';
      else if (/^month$/i.test(part)) period = 'month';
      else if (/^today$/i.test(part)) period = 'today';
      else {
        // Match Slack user mention: <@U123ABC> or <@U123ABC|name>
        const userMatch = part.match(/^<@(\w+)(?:\|[^>]*)?>$/);
        if (userMatch) userId = userMatch[1];
      }
    }

    return { period, userId };
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
   * Parse terminate command, returns session key or null.
   *
   * `/z` refactor (#506): legacy `kill` / `end` / `_session` suffix aliases
   * are removed — only `terminate <key>` / `sessions terminate <key>` forms
   * are accepted (the `sessions terminate` whitelist entry is handled by the
   * naked-whitelist in z/whitelist.ts).
   */
  static parseTerminateCommand(text: string): string | null {
    const match = text.trim().match(/^\/?terminate\s+(.+)$/i);
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
   * Check if text is a plugins command.
   *
   * `/z` refactor (#506): Korean alias `플러그인 업데이트` is removed — only
   * the English `plugins <verb>` / `plugin <verb>` forms are accepted (the
   * tombstone hint redirects `플러그인` callers to `/z plugin update`).
   */
  static isPluginsCommand(text: string): boolean {
    return /^\/?plugins?(?:\s+(?:add|remove|rollback|backups)\s+\S+|\s+update)?$/i.test(text.trim());
  }

  /**
   * Parse plugins command.
   */
  static parsePluginsCommand(text: string): PluginsAction {
    const trimmed = text.trim();

    // Match: plugins update
    if (/^\/?plugins?\s+update$/i.test(trimmed)) {
      return { action: 'update' };
    }

    // Match: plugins add <pluginRef>
    const addMatch = trimmed.match(/^\/?plugins?\s+add\s+(\S+)$/i);
    if (addMatch) {
      return { action: 'add', pluginRef: addMatch[1] };
    }

    // Match: plugins remove <pluginRef>
    const removeMatch = trimmed.match(/^\/?plugins?\s+remove\s+(\S+)$/i);
    if (removeMatch) {
      return { action: 'remove', pluginRef: removeMatch[1] };
    }

    // Match: plugins rollback <pluginRef>
    const rollbackMatch = trimmed.match(/^\/?plugins?\s+rollback\s+(\S+)$/i);
    if (rollbackMatch) {
      return { action: 'rollback', pluginRef: rollbackMatch[1] };
    }

    // Match: plugins backups <pluginRef>
    const backupsMatch = trimmed.match(/^\/?plugins?\s+backups\s+(\S+)$/i);
    if (backupsMatch) {
      return { action: 'backups', pluginRef: backupsMatch[1] };
    }

    return { action: 'list' };
  }

  /**
   * Check if text is a session command (% prefix; $ prefix accepted during deprecation grace period).
   *
   * Primary prefix: `%` (e.g., `%`, `%model`, `%model opus`, `%verbosity compact`)
   * Legacy prefix: `$` — still accepted so existing users are not broken, but
   *   `SessionCommandHandler` emits a deprecation notice and asks users to switch to `%`.
   *
   * `$` is now reserved for forced skill invocation (`$plugin:skill`, `$skill`).
   * Session subcommands (model/verbosity/effort/thinking/thinking_summary) never collide with
   * local skill names, but we keep both prefixes recognized so the router can route `$model`
   * to the session handler (NOT the skill handler) during the grace period.
   */
  static isSessionCommand(text: string): boolean {
    return /^[%$](?:model|verbosity|effort|thinking_summary|thinking)?(?:\s+\S+)?$/i.test(text.trim());
  }

  /**
   * Detect whether a session command was issued with the deprecated `$` prefix.
   * Returns true only for text that is a session command AND starts with `$`.
   */
  static isDeprecatedSessionCommand(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed.startsWith('$')) return false;
    return CommandParser.isSessionCommand(trimmed);
  }

  /**
   * Parse a session command. Accepts both `%` (preferred) and `$` (deprecated) prefixes.
   * Examples: `%`, `%model`, `%model opus`, `%effort high`, `%thinking on`, `%thinking_summary off`.
   */
  static parseSessionCommand(text: string): SessionCommandAction {
    const trimmed = text.trim();

    const modelMatch = trimmed.match(/^[%$]model(?:\s+(\S+))?$/i);
    if (modelMatch) {
      return modelMatch[1]
        ? { type: 'model', action: 'set', model: modelMatch[1] }
        : { type: 'model', action: 'status' };
    }

    const verbosityMatch = trimmed.match(/^[%$]verbosity(?:\s+(\S+))?$/i);
    if (verbosityMatch) {
      return verbosityMatch[1]
        ? { type: 'verbosity', action: 'set', level: verbosityMatch[1] }
        : { type: 'verbosity', action: 'status' };
    }

    const effortMatch = trimmed.match(/^[%$]effort(?:\s+(\S+))?$/i);
    if (effortMatch) {
      return effortMatch[1]
        ? { type: 'effort', action: 'set', level: effortMatch[1] }
        : { type: 'effort', action: 'status' };
    }

    // %thinking_summary must be checked before %thinking (longer prefix first)
    const thinkingSummaryMatch = trimmed.match(/^[%$]thinking_summary(?:\s+(\S+))?$/i);
    if (thinkingSummaryMatch) {
      return thinkingSummaryMatch[1]
        ? { type: 'thinking_summary', action: 'set', value: thinkingSummaryMatch[1] }
        : { type: 'thinking_summary', action: 'status' };
    }

    const thinkingMatch = trimmed.match(/^[%$]thinking(?:\s+(\S+))?$/i);
    if (thinkingMatch) {
      return thinkingMatch[1]
        ? { type: 'thinking', action: 'set', value: thinkingMatch[1] }
        : { type: 'thinking', action: 'status' };
    }

    return { type: 'info' };
  }

  /**
   * Known command keywords (for `isPotentialCommand` hint detection).
   *
   * `/z` refactor (#506) — removed aliases (all now tombstone-redirected):
   *  - `set_cct`, `nextcct` — underscore form
   *  - `servers` — use `mcp [list|reload]`
   *  - `credentials` — use `restore`
   *  - `commands`, `command`, `?` — use `help`
   *  - `kill`, `end` — use `terminate`
   *  - `플러그인` — use `plugins` / `plugin`
   */
  private static readonly COMMAND_KEYWORDS = new Set([
    // Admin commands
    'accept',
    'deny',
    'users',
    'config',
    // Token management
    'cct',
    // Working directory
    'cwd',
    // MCP
    'mcp',
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
    'effort',
    // Sessions
    'sessions',
    'terminate',
    'new',
    'onboarding',
    'context',
    'renew',
    'compact',
    'close',
    'link',
    // Credentials
    'restore',
    // Help
    'help',
    // Token usage
    'usage',
    // Marketplace & Plugins
    'marketplace',
    'plugins',
    'plugin',
    // Future: save/load (oh-my-claude skills)
    'save',
    'load',
    // Email — multi-word keys (detected via two-word `show_email` / `set_email` join)
    'set_email',
    'show_email',
    // Admin: show prompt / show instructions (detected via two-word join)
    'show_prompt',
    'show_instructions',
    // Rating
    'rate',
    // Notification
    'notify',
    'webhook',
    // Report
    'report',
    // Skills
    'skills',
    'skill',
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

    // % prefix (primary) or $ prefix (legacy, deprecated): only known session command roots
    // (%/$, %model, %verbosity, %effort, %thinking, %thinking_summary).
    // Note: $plugin:skill / bare $skill are handled by SkillForceHandler (routed earlier).
    if (firstWord.startsWith('%') || firstWord.startsWith('$')) {
      if (/^[%$](?:model|verbosity|effort|thinking_summary|thinking)?(?:\s|$)/i.test(normalized)) {
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
      "• `close` or `/close` - Close current thread's session",
      '• `new` or `/new` - Reset session context (start fresh conversation in same thread)',
      '• `new <prompt>` or `/new <prompt>` - Reset and start with new prompt',
      '• `onboarding` or `/onboarding` - Run onboarding workflow anytime',
      '• `context` or `/context` - Show current session token usage and cost',
      '• `renew` or `/renew` - Save context, reset session, and reload (for long sessions)',
      '• `compact` or `/compact` - Force context compaction (for testing compression)',
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
      '*Sandbox:*',
      '• `sandbox` or `/sandbox` - Show sandbox status',
      '• `sandbox on` or `/sandbox on` - Enable sandbox (admin only)',
      '• `sandbox off` or `/sandbox off` - Disable sandbox (admin only)',
      '• `sandbox network` - Show sandbox network allowlist status',
      '• `sandbox network on` - Enable network allowlist (default; takes effect next turn)',
      '• `sandbox network off` - Disable network allowlist — full outbound access (takes effect next turn)',
      '',
      '*Email:*',
      '• `show email` - Show your configured email',
      '• `set email <email>` - Set your email (used for Co-Authored-By in commits)',
      '',
      '*Rating:*',
      '• `rate` - Show current model rating',
      '• `rate +` - Increase rating by 1 (max 10)',
      '• `rate -` - Decrease rating by 1 (min 0)',
      '',
      '*Persona:*',
      '• `persona` or `/persona` - Show current persona',
      '• `persona list` or `/persona list` - List available personas',
      '• `persona set <name>` or `/persona set <name>` - Set persona',
      '',
      '*Model & Verbosity:*',
      '• `model` - Show/set default model (persists across sessions)',
      '• `model <name>` - Set default model (e.g., `model opus`)',
      '• `model list` - List available models',
      '• `verbosity` - Show current log verbosity',
      '• `verbosity <level>` - Set log verbosity (minimal/compact/detail/verbose)',
      '• `effort` - Show current default effort level',
      `• \`effort <level>\` - Set default effort (${EFFORT_LEVELS.join('/')}). Persists for all future sessions.`,
      '',
      '*LLM Chat Config:*',
      '• `show llm_chat` - Show current llm_chat model configuration',
      '• `set llm_chat <provider> model <value>` - Change model (e.g., `set llm_chat codex model gpt-5.4`)',
      '• `set llm_chat <provider> model_reasoning_effort <value>` - Change reasoning effort',
      '• `reset llm_chat` - Reset llm_chat config to defaults',
      '',
      '*Session Settings (`%` prefix):*',
      '_Note: `$` prefix is deprecated for session commands — use `%` instead._',
      '_`$` is now reserved for forced skill invocation (`$z`, `$stv:new-task`, etc.)._',
      '• `%` - Show current session info (model, effort, verbosity, context, etc.)',
      '• `%model` - Show session model',
      '• `%model <name>` - Change model for this session only',
      '• `%effort` - Show session effort level',
      `• \`%effort <level>\` - Change effort for this session only (${EFFORT_LEVELS.join('/')})`,
      '• `%verbosity` - Show session verbosity',
      '• `%verbosity <level>` - Change verbosity for this session only',
      '• `%thinking` - Show extended thinking (adaptive reasoning) status',
      '• `%thinking on|off` - Toggle extended thinking for this session',
      '• `%thinking_summary` - Show thinking summary display status',
      '• `%thinking_summary on|off` - Toggle thinking output display for this session',
      '',
      '*Marketplace:*',
      '• `marketplace` or `/marketplace` - Show registered marketplaces',
      '• `marketplace add owner/repo` - Add a marketplace from GitHub repo',
      '• `marketplace add owner/repo --name custom` - Add with custom name',
      '• `marketplace add owner/repo --ref branch` - Add with specific git ref',
      '• `marketplace remove name` - Remove a marketplace by name',
      '',
      '*Plugins:*',
      '• `plugins` or `/plugins` - Show installed plugins',
      '• `plugins add pluginName@marketplaceName` - Install a plugin',
      '• `plugins remove pluginName@marketplaceName` - Remove a plugin',
      '• `plugins update` - Force re-download all plugins (Admin only)',
      '',
      '*Prompt & Instructions (Admin):*',
      '• `show prompt` - Show the system prompt used in this session',
      '• `show instructions` - Show user instructions stored in this session',
      '',
      '*Token Management (Admin):*',
      '• `cct` - Show OAuth token pool status (Block Kit card)',
      '• `cct set <name>` - Switch active token (e.g., `cct set cct2`)',
      '• `cct next` - Rotate to next available token',
      '• `cct usage [<name>]` - Show usage snapshot (5h/7d) for a slot; defaults to active',
      '• _Note: token add/remove via text is disabled — use the *Add* / *Remove* buttons on the `/z cct` card._',
      '',
      '*Credentials:*',
      '• `restore` or `/restore` - Restore Claude credentials from backup',
      '',
      '*Token Usage:*',
      "• `usage` or `/usage` - Show today's token usage and rankings",
      "• `usage week` - Show this week's token usage",
      "• `usage month` - Show this month's token usage",
      "• `usage @user` - Show specific user's token usage",
      '• `usage card` or `/usage card` - Post your personal 30-day usage card (PNG) to the channel',
      '',
      '*Help:*',
      '• `help` or `/help` - Show this help message',
    ];
    return commands.join('\n');
  }
}
