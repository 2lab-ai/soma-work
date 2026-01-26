import { describe, it, expect } from 'vitest';
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
  });
});
