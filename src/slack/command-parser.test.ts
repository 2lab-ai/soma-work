import { describe, expect, it } from 'vitest';
import { CommandParser } from './command-parser';

describe('CommandParser', () => {
  describe('isMcpInfoCommand', () => {
    it('should match "mcp"', () => {
      expect(CommandParser.isMcpInfoCommand('mcp')).toBe(true);
    });

    it('should match "/mcp"', () => {
      expect(CommandParser.isMcpInfoCommand('/mcp')).toBe(true);
    });

    it('should match "mcp info"', () => {
      expect(CommandParser.isMcpInfoCommand('mcp info')).toBe(true);
    });

    it('should match "mcp list"', () => {
      expect(CommandParser.isMcpInfoCommand('mcp list')).toBe(true);
    });

    it('should match "mcp status"', () => {
      expect(CommandParser.isMcpInfoCommand('mcp status')).toBe(true);
    });

    it('should match "server"', () => {
      expect(CommandParser.isMcpInfoCommand('server')).toBe(true);
    });

    it('should match "servers"', () => {
      expect(CommandParser.isMcpInfoCommand('servers')).toBe(true);
    });

    it('should match "mcp?"', () => {
      expect(CommandParser.isMcpInfoCommand('mcp?')).toBe(true);
    });

    it('should not match "mcp reload"', () => {
      expect(CommandParser.isMcpInfoCommand('mcp reload')).toBe(false);
    });

    it('should not match unrelated text', () => {
      expect(CommandParser.isMcpInfoCommand('hello world')).toBe(false);
    });
  });

  describe('isMcpReloadCommand', () => {
    it('should match "mcp reload"', () => {
      expect(CommandParser.isMcpReloadCommand('mcp reload')).toBe(true);
    });

    it('should match "/mcp reload"', () => {
      expect(CommandParser.isMcpReloadCommand('/mcp reload')).toBe(true);
    });

    it('should match "mcp refresh"', () => {
      expect(CommandParser.isMcpReloadCommand('mcp refresh')).toBe(true);
    });

    it('should match "server reload"', () => {
      expect(CommandParser.isMcpReloadCommand('server reload')).toBe(true);
    });

    it('should not match just "mcp"', () => {
      expect(CommandParser.isMcpReloadCommand('mcp')).toBe(false);
    });
  });

  describe('isBypassCommand', () => {
    it('should match "bypass"', () => {
      expect(CommandParser.isBypassCommand('bypass')).toBe(true);
    });

    it('should match "/bypass"', () => {
      expect(CommandParser.isBypassCommand('/bypass')).toBe(true);
    });

    it('should match "bypass on"', () => {
      expect(CommandParser.isBypassCommand('bypass on')).toBe(true);
    });

    it('should match "bypass off"', () => {
      expect(CommandParser.isBypassCommand('bypass off')).toBe(true);
    });

    it('should match "bypass true"', () => {
      expect(CommandParser.isBypassCommand('bypass true')).toBe(true);
    });

    it('should match "bypass false"', () => {
      expect(CommandParser.isBypassCommand('bypass false')).toBe(true);
    });

    it('should match "bypass enable"', () => {
      expect(CommandParser.isBypassCommand('bypass enable')).toBe(true);
    });

    it('should match "bypass disable"', () => {
      expect(CommandParser.isBypassCommand('bypass disable')).toBe(true);
    });

    it('should match "bypass status"', () => {
      expect(CommandParser.isBypassCommand('bypass status')).toBe(true);
    });

    it('should not match unrelated text', () => {
      expect(CommandParser.isBypassCommand('hello bypass')).toBe(false);
    });
  });

  describe('parseBypassCommand', () => {
    it('should return "status" for "bypass"', () => {
      expect(CommandParser.parseBypassCommand('bypass')).toBe('status');
    });

    it('should return "on" for "bypass on"', () => {
      expect(CommandParser.parseBypassCommand('bypass on')).toBe('on');
    });

    it('should return "on" for "bypass true"', () => {
      expect(CommandParser.parseBypassCommand('bypass true')).toBe('on');
    });

    it('should return "on" for "bypass enable"', () => {
      expect(CommandParser.parseBypassCommand('bypass enable')).toBe('on');
    });

    it('should return "off" for "bypass off"', () => {
      expect(CommandParser.parseBypassCommand('bypass off')).toBe('off');
    });

    it('should return "off" for "bypass false"', () => {
      expect(CommandParser.parseBypassCommand('bypass false')).toBe('off');
    });

    it('should return "off" for "bypass disable"', () => {
      expect(CommandParser.parseBypassCommand('bypass disable')).toBe('off');
    });

    it('should return "status" for "bypass status"', () => {
      expect(CommandParser.parseBypassCommand('bypass status')).toBe('status');
    });

    it('should be case-insensitive', () => {
      expect(CommandParser.parseBypassCommand('bypass ON')).toBe('on');
      expect(CommandParser.parseBypassCommand('bypass OFF')).toBe('off');
    });
  });

  describe('isPersonaCommand', () => {
    it('should match "persona"', () => {
      expect(CommandParser.isPersonaCommand('persona')).toBe(true);
    });

    it('should match "/persona"', () => {
      expect(CommandParser.isPersonaCommand('/persona')).toBe(true);
    });

    it('should match "persona list"', () => {
      expect(CommandParser.isPersonaCommand('persona list')).toBe(true);
    });

    it('should match "persona status"', () => {
      expect(CommandParser.isPersonaCommand('persona status')).toBe(true);
    });

    it('should match "persona set default"', () => {
      expect(CommandParser.isPersonaCommand('persona set default')).toBe(true);
    });

    it('should not match unrelated text', () => {
      expect(CommandParser.isPersonaCommand('set persona default')).toBe(false);
    });
  });

  describe('parsePersonaCommand', () => {
    it('should return status for "persona"', () => {
      expect(CommandParser.parsePersonaCommand('persona')).toEqual({ action: 'status' });
    });

    it('should return list for "persona list"', () => {
      expect(CommandParser.parsePersonaCommand('persona list')).toEqual({ action: 'list' });
    });

    it('should return set with persona for "persona set default"', () => {
      expect(CommandParser.parsePersonaCommand('persona set default')).toEqual({ action: 'set', persona: 'default' });
    });

    it('should return set with persona for "persona set chaechae"', () => {
      expect(CommandParser.parsePersonaCommand('persona set chaechae')).toEqual({ action: 'set', persona: 'chaechae' });
    });
  });

  describe('isModelCommand', () => {
    it('should match "model"', () => {
      expect(CommandParser.isModelCommand('model')).toBe(true);
    });

    it('should match "/model"', () => {
      expect(CommandParser.isModelCommand('/model')).toBe(true);
    });

    it('should match "model list"', () => {
      expect(CommandParser.isModelCommand('model list')).toBe(true);
    });

    it('should match "model status"', () => {
      expect(CommandParser.isModelCommand('model status')).toBe(true);
    });

    it('should match "model opus-4.5"', () => {
      expect(CommandParser.isModelCommand('model opus-4.5')).toBe(true);
    });

    it('should match "model set sonnet"', () => {
      expect(CommandParser.isModelCommand('model set sonnet')).toBe(true);
    });
  });

  describe('parseModelCommand', () => {
    it('should return status for "model"', () => {
      expect(CommandParser.parseModelCommand('model')).toEqual({ action: 'status' });
    });

    it('should return list for "model list"', () => {
      expect(CommandParser.parseModelCommand('model list')).toEqual({ action: 'list' });
    });

    it('should return set with model for "model opus-4.5"', () => {
      expect(CommandParser.parseModelCommand('model opus-4.5')).toEqual({ action: 'set', model: 'opus-4.5' });
    });

    it('should return set with model for "model set sonnet"', () => {
      expect(CommandParser.parseModelCommand('model set sonnet')).toEqual({ action: 'set', model: 'sonnet' });
    });
  });

  describe('isRestoreCommand', () => {
    it('should match "restore"', () => {
      expect(CommandParser.isRestoreCommand('restore')).toBe(true);
    });

    it('should match "/restore"', () => {
      expect(CommandParser.isRestoreCommand('/restore')).toBe(true);
    });

    it('should match "credentials"', () => {
      expect(CommandParser.isRestoreCommand('credentials')).toBe(true);
    });

    it('should match "credential"', () => {
      expect(CommandParser.isRestoreCommand('credential')).toBe(true);
    });

    it('should match "credentials status"', () => {
      expect(CommandParser.isRestoreCommand('credentials status')).toBe(true);
    });
  });

  describe('isHelpCommand', () => {
    it('should match "help"', () => {
      expect(CommandParser.isHelpCommand('help')).toBe(true);
    });

    it('should match "/help"', () => {
      expect(CommandParser.isHelpCommand('/help')).toBe(true);
    });

    it('should match "help?"', () => {
      expect(CommandParser.isHelpCommand('help?')).toBe(true);
    });

    it('should match "commands"', () => {
      expect(CommandParser.isHelpCommand('commands')).toBe(true);
    });

    it('should match "command"', () => {
      expect(CommandParser.isHelpCommand('command')).toBe(true);
    });

    it('should not match unrelated text', () => {
      expect(CommandParser.isHelpCommand('please help me')).toBe(false);
    });
  });

  describe('isSessionsCommand', () => {
    it('should match "sessions"', () => {
      expect(CommandParser.isSessionsCommand('sessions')).toBe(true);
    });

    it('should match "session"', () => {
      expect(CommandParser.isSessionsCommand('session')).toBe(true);
    });

    it('should match "/sessions"', () => {
      expect(CommandParser.isSessionsCommand('/sessions')).toBe(true);
    });

    it('should not match "all_sessions"', () => {
      expect(CommandParser.isSessionsCommand('all_sessions')).toBe(false);
    });
  });

  describe('isAllSessionsCommand', () => {
    it('should match "all_sessions"', () => {
      expect(CommandParser.isAllSessionsCommand('all_sessions')).toBe(true);
    });

    it('should match "all_session"', () => {
      expect(CommandParser.isAllSessionsCommand('all_session')).toBe(true);
    });

    it('should match "/all_sessions"', () => {
      expect(CommandParser.isAllSessionsCommand('/all_sessions')).toBe(true);
    });

    it('should not match "sessions"', () => {
      expect(CommandParser.isAllSessionsCommand('sessions')).toBe(false);
    });
  });

  describe('parseTerminateCommand', () => {
    it('should parse "terminate session-key"', () => {
      expect(CommandParser.parseTerminateCommand('terminate session-key')).toBe('session-key');
    });

    it('should parse "kill session-123"', () => {
      expect(CommandParser.parseTerminateCommand('kill session-123')).toBe('session-123');
    });

    it('should parse "end session"', () => {
      expect(CommandParser.parseTerminateCommand('end session')).toBe('session');
    });

    it('should parse "/terminate foo:bar"', () => {
      expect(CommandParser.parseTerminateCommand('/terminate foo:bar')).toBe('foo:bar');
    });

    it('should parse "terminate_session C123:T456"', () => {
      expect(CommandParser.parseTerminateCommand('terminate_session C123:T456')).toBe('C123:T456');
    });

    it('should return null for just "terminate"', () => {
      expect(CommandParser.parseTerminateCommand('terminate')).toBe(null);
    });

    it('should return null for unrelated text', () => {
      expect(CommandParser.parseTerminateCommand('hello world')).toBe(null);
    });
  });

  describe('isNewCommand', () => {
    it('should match "new"', () => {
      expect(CommandParser.isNewCommand('new')).toBe(true);
    });

    it('should match "/new"', () => {
      expect(CommandParser.isNewCommand('/new')).toBe(true);
    });

    it('should match "new some prompt"', () => {
      expect(CommandParser.isNewCommand('new some prompt')).toBe(true);
    });

    it('should match "/new https://github.com/owner/repo/pull/123"', () => {
      expect(CommandParser.isNewCommand('/new https://github.com/owner/repo/pull/123')).toBe(true);
    });

    it('should match "new" with multiline prompt', () => {
      expect(CommandParser.isNewCommand('new line 1\nline 2')).toBe(true);
    });

    it('should not match "newline" (no space)', () => {
      expect(CommandParser.isNewCommand('newline')).toBe(false);
    });

    it('should not match "renew"', () => {
      expect(CommandParser.isNewCommand('renew')).toBe(false);
    });

    it('should not match unrelated text', () => {
      expect(CommandParser.isNewCommand('hello new world')).toBe(false);
    });
  });

  describe('parseNewCommand', () => {
    it('should return empty prompt for "new"', () => {
      expect(CommandParser.parseNewCommand('new')).toEqual({ prompt: undefined });
    });

    it('should return empty prompt for "/new"', () => {
      expect(CommandParser.parseNewCommand('/new')).toEqual({ prompt: undefined });
    });

    it('should return prompt for "new some prompt"', () => {
      expect(CommandParser.parseNewCommand('new some prompt')).toEqual({ prompt: 'some prompt' });
    });

    it('should return prompt for "/new https://github.com/owner/repo/pull/123"', () => {
      expect(CommandParser.parseNewCommand('/new https://github.com/owner/repo/pull/123')).toEqual({
        prompt: 'https://github.com/owner/repo/pull/123',
      });
    });

    it('should preserve multiline prompts', () => {
      const result = CommandParser.parseNewCommand('/new line 1\nline 2');
      expect(result.prompt).toBe('line 1\nline 2');
    });

    it('should trim whitespace from prompt', () => {
      expect(CommandParser.parseNewCommand('new   spaced prompt  ')).toEqual({ prompt: 'spaced prompt' });
    });

    it('should return empty for "new   " (whitespace only)', () => {
      expect(CommandParser.parseNewCommand('new   ')).toEqual({ prompt: undefined });
    });
  });

  describe('isOnboardingCommand', () => {
    it('should match "onboarding"', () => {
      expect(CommandParser.isOnboardingCommand('onboarding')).toBe(true);
    });

    it('should match "/onboarding"', () => {
      expect(CommandParser.isOnboardingCommand('/onboarding')).toBe(true);
    });

    it('should match "onboarding start now"', () => {
      expect(CommandParser.isOnboardingCommand('onboarding start now')).toBe(true);
    });

    it('should not match "onboard"', () => {
      expect(CommandParser.isOnboardingCommand('onboard')).toBe(false);
    });
  });

  describe('parseOnboardingCommand', () => {
    it('should return empty prompt for "onboarding"', () => {
      expect(CommandParser.parseOnboardingCommand('onboarding')).toEqual({ prompt: undefined });
    });

    it('should return prompt for "/onboarding 한국어로 안내해줘"', () => {
      expect(CommandParser.parseOnboardingCommand('/onboarding 한국어로 안내해줘')).toEqual({
        prompt: '한국어로 안내해줘',
      });
    });
  });

  describe('getHelpMessage', () => {
    it('should return help message containing command sections', () => {
      const help = CommandParser.getHelpMessage();
      expect(help).toContain('Working Directory');
      expect(help).toContain('Sessions');
      expect(help).toContain('MCP Servers');
      expect(help).toContain('Permissions');
      expect(help).toContain('Persona');
      expect(help).toContain('Model');
      expect(help).toContain('Credentials');
      expect(help).toContain('Help');
    });

    it('should include /new command in help', () => {
      const help = CommandParser.getHelpMessage();
      expect(help).toContain('new');
      expect(help).toContain('Reset session context');
    });

    it('should include onboarding command in help', () => {
      const help = CommandParser.getHelpMessage();
      expect(help).toContain('onboarding');
      expect(help).toContain('Run onboarding workflow anytime');
    });

    it('should include marketplace commands in help', () => {
      const help = CommandParser.getHelpMessage();
      expect(help).toContain('Marketplace');
      expect(help).toContain('marketplace');
      expect(help).toContain('marketplace add');
      expect(help).toContain('marketplace remove');
    });

    it('should include plugins commands in help', () => {
      const help = CommandParser.getHelpMessage();
      expect(help).toContain('Plugins');
      expect(help).toContain('plugins');
      expect(help).toContain('plugins add');
      expect(help).toContain('plugins remove');
    });

    it('should document the `%` prefix session settings and deprecate `$`', () => {
      const help = CommandParser.getHelpMessage();
      expect(help).toContain('Session Settings (`%` prefix)');
      expect(help).toContain('`%model <name>`');
      expect(help).toContain('`%effort <level>`');
      expect(help).toContain('`%verbosity <level>`');
      expect(help).toContain('`%thinking on|off`');
      // Deprecation note for `$`
      expect(help).toContain('`$` prefix is deprecated');
      // Clarify that `$` is for forced skill invocation
      expect(help).toContain('forced skill invocation');
    });
  });

  describe('isMarketplaceCommand', () => {
    it('should match "marketplace"', () => {
      expect(CommandParser.isMarketplaceCommand('marketplace')).toBe(true);
    });

    it('should match "/marketplace"', () => {
      expect(CommandParser.isMarketplaceCommand('/marketplace')).toBe(true);
    });

    it('should match "marketplace add 2lab-ai/soma-work"', () => {
      expect(CommandParser.isMarketplaceCommand('marketplace add 2lab-ai/soma-work')).toBe(true);
    });

    it('should match "marketplace add 2lab-ai/soma-work --name custom"', () => {
      expect(CommandParser.isMarketplaceCommand('marketplace add 2lab-ai/soma-work --name custom')).toBe(true);
    });

    it('should match "marketplace add 2lab-ai/soma-work --ref dev"', () => {
      expect(CommandParser.isMarketplaceCommand('marketplace add 2lab-ai/soma-work --ref dev')).toBe(true);
    });

    it('should match "marketplace remove soma-work"', () => {
      expect(CommandParser.isMarketplaceCommand('marketplace remove soma-work')).toBe(true);
    });

    it('should be case-insensitive', () => {
      expect(CommandParser.isMarketplaceCommand('Marketplace')).toBe(true);
      expect(CommandParser.isMarketplaceCommand('MARKETPLACE add foo/bar')).toBe(true);
    });

    it('should not match unrelated text', () => {
      expect(CommandParser.isMarketplaceCommand('hello marketplace')).toBe(false);
    });

    it('should not match "marketplaces"', () => {
      expect(CommandParser.isMarketplaceCommand('marketplaces')).toBe(false);
    });
  });

  describe('parseMarketplaceCommand', () => {
    it('should return list for "marketplace"', () => {
      expect(CommandParser.parseMarketplaceCommand('marketplace')).toEqual({ action: 'list' });
    });

    it('should return list for "/marketplace"', () => {
      expect(CommandParser.parseMarketplaceCommand('/marketplace')).toEqual({ action: 'list' });
    });

    it('should parse add with repo', () => {
      expect(CommandParser.parseMarketplaceCommand('marketplace add 2lab-ai/soma-work')).toEqual({
        action: 'add',
        repo: '2lab-ai/soma-work',
      });
    });

    it('should parse add with --name option', () => {
      expect(CommandParser.parseMarketplaceCommand('marketplace add 2lab-ai/soma-work --name custom')).toEqual({
        action: 'add',
        repo: '2lab-ai/soma-work',
        name: 'custom',
      });
    });

    it('should parse add with --ref option', () => {
      expect(CommandParser.parseMarketplaceCommand('marketplace add 2lab-ai/soma-work --ref dev')).toEqual({
        action: 'add',
        repo: '2lab-ai/soma-work',
        ref: 'dev',
      });
    });

    it('should parse add with both --name and --ref options', () => {
      expect(
        CommandParser.parseMarketplaceCommand('marketplace add 2lab-ai/soma-work --name custom --ref dev'),
      ).toEqual({
        action: 'add',
        repo: '2lab-ai/soma-work',
        name: 'custom',
        ref: 'dev',
      });
    });

    it('should parse add with --ref before --name', () => {
      expect(
        CommandParser.parseMarketplaceCommand('marketplace add 2lab-ai/soma-work --ref dev --name custom'),
      ).toEqual({
        action: 'add',
        repo: '2lab-ai/soma-work',
        name: 'custom',
        ref: 'dev',
      });
    });

    it('should parse remove with name', () => {
      expect(CommandParser.parseMarketplaceCommand('marketplace remove soma-work')).toEqual({
        action: 'remove',
        name: 'soma-work',
      });
    });

    it('should be case-insensitive for subcommands', () => {
      expect(CommandParser.parseMarketplaceCommand('marketplace ADD 2lab-ai/repo')).toEqual({
        action: 'add',
        repo: '2lab-ai/repo',
      });
      expect(CommandParser.parseMarketplaceCommand('marketplace REMOVE my-market')).toEqual({
        action: 'remove',
        name: 'my-market',
      });
    });
  });

  describe('isPluginsCommand', () => {
    it('should match "plugins"', () => {
      expect(CommandParser.isPluginsCommand('plugins')).toBe(true);
    });

    it('should match "/plugins"', () => {
      expect(CommandParser.isPluginsCommand('/plugins')).toBe(true);
    });

    it('should match "plugins add omc@soma-work"', () => {
      expect(CommandParser.isPluginsCommand('plugins add omc@soma-work')).toBe(true);
    });

    it('should match "plugins remove omc@soma-work"', () => {
      expect(CommandParser.isPluginsCommand('plugins remove omc@soma-work')).toBe(true);
    });

    it('should be case-insensitive', () => {
      expect(CommandParser.isPluginsCommand('Plugins')).toBe(true);
      expect(CommandParser.isPluginsCommand('PLUGINS add foo@bar')).toBe(true);
    });

    it('should not match unrelated text', () => {
      expect(CommandParser.isPluginsCommand('hello plugins')).toBe(false);
    });

    it('should not match "plugin" without s', () => {
      expect(CommandParser.isPluginsCommand('plugin')).toBe(false);
    });
  });

  describe('parsePluginsCommand', () => {
    it('should return list for "plugins"', () => {
      expect(CommandParser.parsePluginsCommand('plugins')).toEqual({ action: 'list' });
    });

    it('should return list for "/plugins"', () => {
      expect(CommandParser.parsePluginsCommand('/plugins')).toEqual({ action: 'list' });
    });

    it('should parse add with pluginRef', () => {
      expect(CommandParser.parsePluginsCommand('plugins add omc@soma-work')).toEqual({
        action: 'add',
        pluginRef: 'omc@soma-work',
      });
    });

    it('should parse remove with pluginRef', () => {
      expect(CommandParser.parsePluginsCommand('plugins remove omc@soma-work')).toEqual({
        action: 'remove',
        pluginRef: 'omc@soma-work',
      });
    });

    it('should be case-insensitive for subcommands', () => {
      expect(CommandParser.parsePluginsCommand('plugins ADD tool@market')).toEqual({
        action: 'add',
        pluginRef: 'tool@market',
      });
      expect(CommandParser.parsePluginsCommand('plugins REMOVE tool@market')).toEqual({
        action: 'remove',
        pluginRef: 'tool@market',
      });
    });
  });

  describe('isPotentialCommand recognizes marketplace and plugins', () => {
    it('should recognize "marketplace" as a potential command', () => {
      expect(CommandParser.isPotentialCommand('marketplace')).toEqual({ isPotential: true, keyword: 'marketplace' });
    });

    it('should recognize "plugins" as a potential command', () => {
      expect(CommandParser.isPotentialCommand('plugins')).toEqual({ isPotential: true, keyword: 'plugins' });
    });
  });

  describe('isPotentialCommand - false positive prevention', () => {
    // Should return isPotential: true
    it('should recognize "help" as a potential command', () => {
      expect(CommandParser.isPotentialCommand('help').isPotential).toBe(true);
    });

    it('should recognize "sessions" as a potential command', () => {
      expect(CommandParser.isPotentialCommand('sessions').isPotential).toBe(true);
    });

    it('should recognize "/help" as a potential command', () => {
      expect(CommandParser.isPotentialCommand('/help').isPotential).toBe(true);
    });

    it('should recognize "/sessions" as a potential command', () => {
      expect(CommandParser.isPotentialCommand('/sessions').isPotential).toBe(true);
    });

    it('should recognize "%model" as a potential command', () => {
      expect(CommandParser.isPotentialCommand('%model').isPotential).toBe(true);
    });

    it('should recognize "%model opus" as a potential command', () => {
      expect(CommandParser.isPotentialCommand('%model opus').isPotential).toBe(true);
    });

    it('should recognize "%verbosity" as a potential command', () => {
      expect(CommandParser.isPotentialCommand('%verbosity').isPotential).toBe(true);
    });

    it('should recognize "%effort high" as a potential command', () => {
      expect(CommandParser.isPotentialCommand('%effort high').isPotential).toBe(true);
    });

    it('should recognize "%thinking" as a potential command', () => {
      expect(CommandParser.isPotentialCommand('%thinking').isPotential).toBe(true);
    });

    it('should recognize "%thinking_summary on" as a potential command', () => {
      expect(CommandParser.isPotentialCommand('%thinking_summary on').isPotential).toBe(true);
    });

    it('should recognize "%" as a potential command (bare percent — session info)', () => {
      expect(CommandParser.isPotentialCommand('%').isPotential).toBe(true);
    });

    // Legacy `$` prefix still recognized during deprecation grace period.
    it('should recognize "$model" as a potential command (legacy)', () => {
      expect(CommandParser.isPotentialCommand('$model').isPotential).toBe(true);
    });

    it('should recognize "$model opus" as a potential command (legacy)', () => {
      expect(CommandParser.isPotentialCommand('$model opus').isPotential).toBe(true);
    });

    it('should recognize "$verbosity" as a potential command (legacy)', () => {
      expect(CommandParser.isPotentialCommand('$verbosity').isPotential).toBe(true);
    });

    it('should recognize "$effort high" as a potential command (legacy)', () => {
      expect(CommandParser.isPotentialCommand('$effort high').isPotential).toBe(true);
    });

    it('should recognize "$" as a potential command (bare dollar — session info, legacy)', () => {
      expect(CommandParser.isPotentialCommand('$').isPotential).toBe(true);
    });

    it('should recognize "show prompt" as a potential command', () => {
      expect(CommandParser.isPotentialCommand('show prompt').isPotential).toBe(true);
    });

    it('should recognize "show instructions" as a potential command', () => {
      expect(CommandParser.isPotentialCommand('show instructions').isPotential).toBe(true);
    });

    // Should return isPotential: false (the fixed false positives)
    it('should not recognize "help me with something" as a potential command', () => {
      expect(CommandParser.isPotentialCommand('help me with something').isPotential).toBe(false);
    });

    it('should not recognize "help 에 sessions 치면" as a potential command', () => {
      expect(CommandParser.isPotentialCommand('help 에 sessions 치면').isPotential).toBe(false);
    });

    it('should not recognize "new idea for the project" as a potential command', () => {
      expect(CommandParser.isPotentialCommand('new idea for the project').isPotential).toBe(false);
    });

    it('should not recognize "model accuracy is low" as a potential command', () => {
      expect(CommandParser.isPotentialCommand('model accuracy is low').isPotential).toBe(false);
    });

    it('should not recognize "sessions are important" as a potential command', () => {
      expect(CommandParser.isPotentialCommand('sessions are important').isPotential).toBe(false);
    });

    it('should not recognize "close the door" as a potential command', () => {
      expect(CommandParser.isPotentialCommand('close the door').isPotential).toBe(false);
    });

    it('should not recognize "context of this conversation" as a potential command', () => {
      expect(CommandParser.isPotentialCommand('context of this conversation').isPotential).toBe(false);
    });

    it('should not recognize "/tmp/project" as a potential command (file path)', () => {
      expect(CommandParser.isPotentialCommand('/tmp/project').isPotential).toBe(false);
    });

    it('should not recognize "/usr/bin/node" as a potential command (file path)', () => {
      expect(CommandParser.isPotentialCommand('/usr/bin/node').isPotential).toBe(false);
    });

    it('should not recognize "$PATH is wrong" as a potential command (env variable)', () => {
      expect(CommandParser.isPotentialCommand('$PATH is wrong').isPotential).toBe(false);
    });

    it('should not recognize "$HOME/documents" as a potential command (env variable)', () => {
      expect(CommandParser.isPotentialCommand('$HOME/documents').isPotential).toBe(false);
    });

    it('should not recognize "$local:z" as a potential command (skill reference)', () => {
      // `$plugin:skill` is routed to SkillForceHandler, not session commands.
      expect(CommandParser.isPotentialCommand('$local:z').isPotential).toBe(false);
    });

    it('should not recognize "$z" as a potential command (bare skill shorthand)', () => {
      expect(CommandParser.isPotentialCommand('$z').isPotential).toBe(false);
    });

    it('should not recognize "%rubbish" as a potential command (unknown % root)', () => {
      expect(CommandParser.isPotentialCommand('%rubbish').isPotential).toBe(false);
    });

    it('should not recognize "show prompt please" as a potential command (three words)', () => {
      expect(CommandParser.isPotentialCommand('show prompt please').isPotential).toBe(false);
    });

    it('should not recognize "" as a potential command (empty string)', () => {
      expect(CommandParser.isPotentialCommand('').isPotential).toBe(false);
    });

    it('should not recognize "   " as a potential command (whitespace only)', () => {
      expect(CommandParser.isPotentialCommand('   ').isPotential).toBe(false);
    });
  });

  describe('isSessionCommand', () => {
    // Primary `%` prefix
    it.each([
      '%',
      '%model',
      '%model opus',
      '%verbosity',
      '%verbosity compact',
      '%effort',
      '%effort high',
      '%thinking',
      '%thinking on',
      '%thinking_summary',
      '%thinking_summary off',
    ])('should match "%s"', (cmd) => {
      expect(CommandParser.isSessionCommand(cmd)).toBe(true);
    });

    // Legacy `$` prefix (grace period)
    it.each([
      '$',
      '$model',
      '$model opus',
      '$verbosity',
      '$verbosity compact',
      '$effort high',
      '$thinking on',
      '$thinking_summary off',
    ])('should match legacy "%s"', (cmd) => {
      expect(CommandParser.isSessionCommand(cmd)).toBe(true);
    });

    it('should not match "%foo" (unknown subcommand)', () => {
      expect(CommandParser.isSessionCommand('%foo')).toBe(false);
    });

    it('should not match "$foo" (unknown subcommand)', () => {
      expect(CommandParser.isSessionCommand('$foo')).toBe(false);
    });

    it('should not match "$local:z" (skill reference)', () => {
      expect(CommandParser.isSessionCommand('$local:z')).toBe(false);
    });

    it('should not match "$z" (bare skill reference)', () => {
      // `$z` looks like a session command root, but there's no session sub `z` — the regex
      // is anchored to known sub-commands only.
      expect(CommandParser.isSessionCommand('$z')).toBe(false);
    });

    it('should not match "plain text"', () => {
      expect(CommandParser.isSessionCommand('hello')).toBe(false);
    });
  });

  describe('isDeprecatedSessionCommand', () => {
    it('should flag legacy "$model" as deprecated', () => {
      expect(CommandParser.isDeprecatedSessionCommand('$model')).toBe(true);
    });

    it('should flag legacy "$" as deprecated', () => {
      expect(CommandParser.isDeprecatedSessionCommand('$')).toBe(true);
    });

    it('should flag legacy "$effort high" as deprecated', () => {
      expect(CommandParser.isDeprecatedSessionCommand('$effort high')).toBe(true);
    });

    it('should not flag "%model" (primary prefix)', () => {
      expect(CommandParser.isDeprecatedSessionCommand('%model')).toBe(false);
    });

    it('should not flag "%" (primary prefix)', () => {
      expect(CommandParser.isDeprecatedSessionCommand('%')).toBe(false);
    });

    it('should not flag "$local:z" (not a session command)', () => {
      expect(CommandParser.isDeprecatedSessionCommand('$local:z')).toBe(false);
    });

    it('should not flag "$z" (not a session command)', () => {
      expect(CommandParser.isDeprecatedSessionCommand('$z')).toBe(false);
    });

    it('should not flag plain text', () => {
      expect(CommandParser.isDeprecatedSessionCommand('hello world')).toBe(false);
    });
  });

  describe('parseSessionCommand', () => {
    it('parses "%" as info', () => {
      expect(CommandParser.parseSessionCommand('%')).toEqual({ type: 'info' });
    });

    it('parses legacy "$" as info', () => {
      expect(CommandParser.parseSessionCommand('$')).toEqual({ type: 'info' });
    });

    it('parses "%model" as model status', () => {
      expect(CommandParser.parseSessionCommand('%model')).toEqual({ type: 'model', action: 'status' });
    });

    it('parses "%model opus" as model set', () => {
      expect(CommandParser.parseSessionCommand('%model opus')).toEqual({
        type: 'model',
        action: 'set',
        model: 'opus',
      });
    });

    it('parses legacy "$model opus" as model set (grace period)', () => {
      expect(CommandParser.parseSessionCommand('$model opus')).toEqual({
        type: 'model',
        action: 'set',
        model: 'opus',
      });
    });

    it('parses "%verbosity compact" as verbosity set', () => {
      expect(CommandParser.parseSessionCommand('%verbosity compact')).toEqual({
        type: 'verbosity',
        action: 'set',
        level: 'compact',
      });
    });

    it('parses "%effort high" as effort set', () => {
      expect(CommandParser.parseSessionCommand('%effort high')).toEqual({
        type: 'effort',
        action: 'set',
        level: 'high',
      });
    });

    it('parses "%thinking on" as thinking set', () => {
      expect(CommandParser.parseSessionCommand('%thinking on')).toEqual({
        type: 'thinking',
        action: 'set',
        value: 'on',
      });
    });

    it('parses "%thinking_summary off" as thinking_summary set (before %thinking)', () => {
      // Ensures the longer `_summary` prefix is checked before bare `%thinking`.
      expect(CommandParser.parseSessionCommand('%thinking_summary off')).toEqual({
        type: 'thinking_summary',
        action: 'set',
        value: 'off',
      });
    });

    it('parses legacy "$thinking_summary on" as thinking_summary set', () => {
      expect(CommandParser.parseSessionCommand('$thinking_summary on')).toEqual({
        type: 'thinking_summary',
        action: 'set',
        value: 'on',
      });
    });
  });

  describe('isRenewCommand', () => {
    it('should match "renew"', () => {
      expect(CommandParser.isRenewCommand('renew')).toBe(true);
    });

    it('should match "/renew"', () => {
      expect(CommandParser.isRenewCommand('/renew')).toBe(true);
    });

    it('should match "renew some prompt"', () => {
      expect(CommandParser.isRenewCommand('renew some prompt')).toBe(true);
    });

    it('should match "/renew https://github.com/owner/repo/pull/123"', () => {
      expect(CommandParser.isRenewCommand('/renew https://github.com/owner/repo/pull/123')).toBe(true);
    });

    it('should match "renew" with multiline prompt', () => {
      expect(CommandParser.isRenewCommand('renew line 1\nline 2')).toBe(true);
    });

    it('should not match "renewed" (no space)', () => {
      expect(CommandParser.isRenewCommand('renewed')).toBe(false);
    });

    it('should not match unrelated text', () => {
      expect(CommandParser.isRenewCommand('hello renew world')).toBe(false);
    });
  });

  describe('isLlmChatCommand', () => {
    it('should match "show llm_chat"', () => {
      expect(CommandParser.isLlmChatCommand('show llm_chat')).toBe(true);
    });

    it('should match "/show llm_chat"', () => {
      expect(CommandParser.isLlmChatCommand('/show llm_chat')).toBe(true);
    });

    it('should match "set llm_chat codex model gpt-5"', () => {
      expect(CommandParser.isLlmChatCommand('set llm_chat codex model gpt-5')).toBe(true);
    });

    it('should match "reset llm_chat"', () => {
      expect(CommandParser.isLlmChatCommand('reset llm_chat')).toBe(true);
    });

    it('should be case-insensitive', () => {
      expect(CommandParser.isLlmChatCommand('SHOW LLM_CHAT')).toBe(true);
    });

    it('should not match "show something_else"', () => {
      expect(CommandParser.isLlmChatCommand('show something_else')).toBe(false);
    });

    it('should not match "set other_config"', () => {
      expect(CommandParser.isLlmChatCommand('set other_config')).toBe(false);
    });
  });

  describe('parseLlmChatCommand', () => {
    it('should parse "show llm_chat" as show action', () => {
      expect(CommandParser.parseLlmChatCommand('show llm_chat')).toEqual({ action: 'show' });
    });

    it('should parse "reset llm_chat" as reset action', () => {
      expect(CommandParser.parseLlmChatCommand('reset llm_chat')).toEqual({ action: 'reset' });
    });

    it('should parse "set llm_chat codex model gpt-5.4" correctly', () => {
      const result = CommandParser.parseLlmChatCommand('set llm_chat codex model gpt-5.4');
      expect(result).toEqual({
        action: 'set',
        provider: 'codex',
        key: 'model',
        value: 'gpt-5.4',
      });
    });

    it('should lowercase provider and key', () => {
      const result = CommandParser.parseLlmChatCommand('set llm_chat CODEX Model gpt-5.4');
      expect(result).toEqual({
        action: 'set',
        provider: 'codex',
        key: 'model',
        value: 'gpt-5.4',
      });
    });

    it('should return error for "set llm_chat" without args', () => {
      const result = CommandParser.parseLlmChatCommand('set llm_chat');
      expect(result.action).toBe('error');
    });

    it('should return error for "set llm_chat codex" (missing key/value)', () => {
      const result = CommandParser.parseLlmChatCommand('set llm_chat codex');
      expect(result.action).toBe('error');
    });

    it('should return error for malformed commands like "reset llm_chat now"', () => {
      const result = CommandParser.parseLlmChatCommand('reset llm_chat now');
      expect(result.action).toBe('error');
    });

    it('should return error for "show llm_chat extra"', () => {
      const result = CommandParser.parseLlmChatCommand('show llm_chat extra');
      expect(result.action).toBe('error');
    });
  });

  describe('isShowPromptCommand', () => {
    it('should match "show prompt"', () => {
      expect(CommandParser.isShowPromptCommand('show prompt')).toBe(true);
    });

    it('should match "/show prompt"', () => {
      expect(CommandParser.isShowPromptCommand('/show prompt')).toBe(true);
    });

    it('should match "show_prompt"', () => {
      expect(CommandParser.isShowPromptCommand('show_prompt')).toBe(true);
    });

    it('should match "/show_prompt"', () => {
      expect(CommandParser.isShowPromptCommand('/show_prompt')).toBe(true);
    });

    it('should be case-insensitive', () => {
      expect(CommandParser.isShowPromptCommand('Show Prompt')).toBe(true);
      expect(CommandParser.isShowPromptCommand('SHOW PROMPT')).toBe(true);
    });

    it('should not match "show"', () => {
      expect(CommandParser.isShowPromptCommand('show')).toBe(false);
    });

    it('should not match "show prompt extra"', () => {
      expect(CommandParser.isShowPromptCommand('show prompt extra')).toBe(false);
    });

    it('should not match "show llm_chat"', () => {
      expect(CommandParser.isShowPromptCommand('show llm_chat')).toBe(false);
    });
  });

  describe('isShowInstructionsCommand', () => {
    it('should match "show instructions"', () => {
      expect(CommandParser.isShowInstructionsCommand('show instructions')).toBe(true);
    });

    it('should match "/show instructions"', () => {
      expect(CommandParser.isShowInstructionsCommand('/show instructions')).toBe(true);
    });

    it('should match "show_instructions"', () => {
      expect(CommandParser.isShowInstructionsCommand('show_instructions')).toBe(true);
    });

    it('should match "/show_instructions"', () => {
      expect(CommandParser.isShowInstructionsCommand('/show_instructions')).toBe(true);
    });

    it('should be case-insensitive', () => {
      expect(CommandParser.isShowInstructionsCommand('Show Instructions')).toBe(true);
      expect(CommandParser.isShowInstructionsCommand('SHOW INSTRUCTIONS')).toBe(true);
    });

    it('should not match "show"', () => {
      expect(CommandParser.isShowInstructionsCommand('show')).toBe(false);
    });

    it('should not match "show instructions extra"', () => {
      expect(CommandParser.isShowInstructionsCommand('show instructions extra')).toBe(false);
    });
  });

  // ── Email command tests ──
  describe('isEmailCommand', () => {
    it('should match "set email x@y.com"', () => {
      expect(CommandParser.isEmailCommand('set email x@y.com')).toBe(true);
    });

    it('should match "show email"', () => {
      expect(CommandParser.isEmailCommand('show email')).toBe(true);
    });

    it('should match "/set email x@y.com"', () => {
      expect(CommandParser.isEmailCommand('/set email x@y.com')).toBe(true);
    });

    it('should match "/show email"', () => {
      expect(CommandParser.isEmailCommand('/show email')).toBe(true);
    });

    it('should not match "set something"', () => {
      expect(CommandParser.isEmailCommand('set something')).toBe(false);
    });

    it('should not match "email me"', () => {
      expect(CommandParser.isEmailCommand('email me')).toBe(false);
    });

    it('should not match "show prompt"', () => {
      expect(CommandParser.isEmailCommand('show prompt')).toBe(false);
    });
  });

  describe('parseEmailCommand', () => {
    it('should return status for "show email"', () => {
      expect(CommandParser.parseEmailCommand('show email')).toEqual({ action: 'status' });
    });

    it('should return status for "/show email"', () => {
      expect(CommandParser.parseEmailCommand('/show email')).toEqual({ action: 'status' });
    });

    it('should return set with email for "set email user@example.com"', () => {
      expect(CommandParser.parseEmailCommand('set email user@example.com')).toEqual({
        action: 'set',
        email: 'user@example.com',
      });
    });

    it('should return set with email for "/set email user@example.com"', () => {
      expect(CommandParser.parseEmailCommand('/set email user@example.com')).toEqual({
        action: 'set',
        email: 'user@example.com',
      });
    });

    it('should strip Slack mailto auto-link', () => {
      expect(CommandParser.parseEmailCommand('set email <mailto:x@y.com|x@y.com>')).toEqual({
        action: 'set',
        email: 'x@y.com',
      });
    });

    it('should strip Slack mailto with different display text', () => {
      expect(CommandParser.parseEmailCommand('set email <mailto:alice@corp.com|alice@corp.com>')).toEqual({
        action: 'set',
        email: 'alice@corp.com',
      });
    });

    it('should return status for "set email" with no argument', () => {
      expect(CommandParser.parseEmailCommand('set email')).toEqual({ action: 'status' });
    });
  });

  describe('isSandboxCommand', () => {
    it('matches bare "sandbox"', () => {
      expect(CommandParser.isSandboxCommand('sandbox')).toBe(true);
      expect(CommandParser.isSandboxCommand('/sandbox')).toBe(true);
    });

    it('matches "sandbox on|off|status" and synonyms', () => {
      for (const s of [
        'sandbox on',
        'sandbox off',
        'sandbox status',
        'sandbox true',
        'sandbox false',
        'sandbox enable',
        'sandbox disable',
      ]) {
        expect(CommandParser.isSandboxCommand(s)).toBe(true);
      }
    });

    it('matches bare "sandbox network"', () => {
      expect(CommandParser.isSandboxCommand('sandbox network')).toBe(true);
      expect(CommandParser.isSandboxCommand('/sandbox network')).toBe(true);
    });

    it('matches "sandbox network on|off|status" and synonyms', () => {
      for (const s of [
        'sandbox network on',
        'sandbox network off',
        'sandbox network status',
        'sandbox network true',
        'sandbox network false',
        'sandbox network enable',
        'sandbox network disable',
      ]) {
        expect(CommandParser.isSandboxCommand(s)).toBe(true);
      }
    });

    it('does not match garbage', () => {
      expect(CommandParser.isSandboxCommand('sandbox foo')).toBe(false);
      expect(CommandParser.isSandboxCommand('sandbox network foo')).toBe(false);
      expect(CommandParser.isSandboxCommand('sandbox network on off')).toBe(false);
      expect(CommandParser.isSandboxCommand('sandboxes')).toBe(false);
      expect(CommandParser.isSandboxCommand('help')).toBe(false);
    });
  });

  describe('parseSandboxCommand', () => {
    it('parses bare "sandbox" as target=sandbox, action=status', () => {
      expect(CommandParser.parseSandboxCommand('sandbox')).toEqual({ target: 'sandbox', action: 'status' });
    });

    it('parses "sandbox on/off/status" as target=sandbox', () => {
      expect(CommandParser.parseSandboxCommand('sandbox on')).toEqual({ target: 'sandbox', action: 'on' });
      expect(CommandParser.parseSandboxCommand('/sandbox off')).toEqual({ target: 'sandbox', action: 'off' });
      expect(CommandParser.parseSandboxCommand('sandbox status')).toEqual({ target: 'sandbox', action: 'status' });
    });

    it('parses synonym actions for sandbox target', () => {
      expect(CommandParser.parseSandboxCommand('sandbox true')).toEqual({ target: 'sandbox', action: 'on' });
      expect(CommandParser.parseSandboxCommand('sandbox enable')).toEqual({ target: 'sandbox', action: 'on' });
      expect(CommandParser.parseSandboxCommand('sandbox false')).toEqual({ target: 'sandbox', action: 'off' });
      expect(CommandParser.parseSandboxCommand('sandbox disable')).toEqual({ target: 'sandbox', action: 'off' });
    });

    it('parses "sandbox network" as target=network, action=status', () => {
      expect(CommandParser.parseSandboxCommand('sandbox network')).toEqual({ target: 'network', action: 'status' });
    });

    it('parses "sandbox network on/off/status" as target=network', () => {
      expect(CommandParser.parseSandboxCommand('sandbox network on')).toEqual({ target: 'network', action: 'on' });
      expect(CommandParser.parseSandboxCommand('/sandbox network off')).toEqual({ target: 'network', action: 'off' });
      expect(CommandParser.parseSandboxCommand('sandbox network status')).toEqual({
        target: 'network',
        action: 'status',
      });
    });

    it('parses synonym actions for network target', () => {
      expect(CommandParser.parseSandboxCommand('sandbox network true')).toEqual({ target: 'network', action: 'on' });
      expect(CommandParser.parseSandboxCommand('sandbox network enable')).toEqual({ target: 'network', action: 'on' });
      expect(CommandParser.parseSandboxCommand('sandbox network false')).toEqual({ target: 'network', action: 'off' });
      expect(CommandParser.parseSandboxCommand('sandbox network disable')).toEqual({
        target: 'network',
        action: 'off',
      });
    });

    it('is case-insensitive', () => {
      expect(CommandParser.parseSandboxCommand('Sandbox Network ON')).toEqual({ target: 'network', action: 'on' });
      expect(CommandParser.parseSandboxCommand('SANDBOX OFF')).toEqual({ target: 'sandbox', action: 'off' });
    });
  });

  describe('getHelpMessage — sandbox section', () => {
    it('documents both sandbox and sandbox network commands', () => {
      const help = CommandParser.getHelpMessage();
      expect(help).toContain('*Sandbox:*');
      expect(help).toContain('`sandbox on`');
      expect(help).toContain('`sandbox off`');
      expect(help).toContain('`sandbox network`');
      expect(help).toContain('`sandbox network on`');
      expect(help).toContain('`sandbox network off`');
    });
  });
});
