import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock modules before imports
vi.mock('../../admin-utils', () => ({
  isAdminUser: vi.fn(),
  resetAdminUsersCache: vi.fn(),
}));

vi.mock('../../user-settings-store', () => ({
  userSettingsStore: {
    getUserSettings: vi.fn(),
    acceptUser: vi.fn(),
    removeUserSettings: vi.fn(),
    getAllUsers: vi.fn(),
    createPendingUser: vi.fn(),
  },
}));

vi.mock('../../env-paths', () => ({
  ENV_FILE: '/mock/.env',
}));

vi.mock('../../token-manager', () => ({
  tokenManager: {
    initialize: vi.fn(),
  },
}));

vi.mock('fs');

import { AdminHandler } from './admin-handler';
import { isAdminUser, resetAdminUsersCache } from '../../admin-utils';
import { userSettingsStore } from '../../user-settings-store';
import { tokenManager } from '../../token-manager';
import fs from 'fs';
import { CommandContext } from './types';

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    user: 'U_ADMIN',
    channel: 'C123',
    threadTs: 'thread123',
    text: '',
    say: vi.fn().mockResolvedValue({ ts: 'msg_ts' }),
    ...overrides,
  };
}

describe('AdminHandler', () => {
  let handler: AdminHandler;

  beforeEach(() => {
    handler = new AdminHandler();
    vi.mocked(isAdminUser).mockReturnValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── Scenario 1: Migration (tested in user-settings-store.test.ts) ──

  // ── Scenario 6: Accept Command ──
  describe('accept command', () => {
    it('accepts pending user', async () => {
      const ctx = makeCtx({ text: 'accept <@U_NEW>' });
      const result = await handler.execute(ctx);

      expect(result.handled).toBe(true);
      expect(userSettingsStore.acceptUser).toHaveBeenCalledWith('U_NEW', 'U_ADMIN');
      expect(ctx.say).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('U_NEW'),
        })
      );
    });

    it('rejects non-admin', async () => {
      vi.mocked(isAdminUser).mockReturnValue(false);
      const ctx = makeCtx({ text: 'accept <@U_NEW>' });
      const result = await handler.execute(ctx);

      expect(result.handled).toBe(true);
      expect(userSettingsStore.acceptUser).not.toHaveBeenCalled();
      expect(ctx.say).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Admin only'),
        })
      );
    });

    it('extracts user from Slack mention format', async () => {
      const ctx = makeCtx({ text: 'accept <@U12345|username>' });
      await handler.execute(ctx);

      expect(userSettingsStore.acceptUser).toHaveBeenCalledWith('U12345', 'U_ADMIN');
    });

    it('creates + accepts unknown user', async () => {
      const ctx = makeCtx({ text: 'accept <@U_UNKNOWN>' });
      await handler.execute(ctx);

      expect(userSettingsStore.acceptUser).toHaveBeenCalledWith('U_UNKNOWN', 'U_ADMIN');
    });
  });

  // ── Scenario 7: Deny Command ──
  describe('deny command', () => {
    it('removes user and confirms', async () => {
      const ctx = makeCtx({ text: 'deny <@U_NEW>' });
      const result = await handler.execute(ctx);

      expect(result.handled).toBe(true);
      expect(userSettingsStore.removeUserSettings).toHaveBeenCalledWith('U_NEW');
      expect(ctx.say).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('U_NEW'),
        })
      );
    });

    it('rejects non-admin', async () => {
      vi.mocked(isAdminUser).mockReturnValue(false);
      const ctx = makeCtx({ text: 'deny <@U_NEW>' });
      const result = await handler.execute(ctx);

      expect(result.handled).toBe(true);
      expect(userSettingsStore.removeUserSettings).not.toHaveBeenCalled();
    });
  });

  // ── Scenario 8: Users Command ──
  describe('users command', () => {
    it('shows accepted and pending users', async () => {
      vi.mocked(userSettingsStore.getAllUsers).mockReturnValue([
        { userId: 'U1', accepted: true, acceptedBy: 'U_ADMIN', acceptedAt: '2026-01-01', defaultDirectory: '', bypassPermission: false, persona: 'default', defaultModel: 'claude-opus-4-6' as any, lastUpdated: '' },
        { userId: 'U2', accepted: false, defaultDirectory: '', bypassPermission: false, persona: 'default', defaultModel: 'claude-opus-4-6' as any, lastUpdated: '' },
      ]);
      const ctx = makeCtx({ text: 'users' });
      const result = await handler.execute(ctx);

      expect(result.handled).toBe(true);
      expect(ctx.say).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringMatching(/U1.*U2|U2.*U1/s),
        })
      );
    });

    it('rejects non-admin', async () => {
      vi.mocked(isAdminUser).mockReturnValue(false);
      const ctx = makeCtx({ text: 'users' });
      await handler.execute(ctx);

      expect(userSettingsStore.getAllUsers).not.toHaveBeenCalled();
    });

    it('handles empty user list', async () => {
      vi.mocked(userSettingsStore.getAllUsers).mockReturnValue([]);
      const ctx = makeCtx({ text: 'users' });
      const result = await handler.execute(ctx);

      expect(result.handled).toBe(true);
      expect(ctx.say).toHaveBeenCalled();
    });
  });

  // ── Scenario 9: Config Show ──
  describe('config show', () => {
    it('displays all env vars', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue('DEBUG=true\nBASE_DIRECTORY=/tmp\n');
      const ctx = makeCtx({ text: 'config show' });
      const result = await handler.execute(ctx);

      expect(result.handled).toBe(true);
      expect(ctx.say).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('DEBUG=true'),
        })
      );
    });

    it('masks sensitive values', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue('SLACK_BOT_TOKEN=xoxb-1234567890-abcdefghijk\n');
      const ctx = makeCtx({ text: 'config show' });
      await handler.execute(ctx);

      const callArgs = vi.mocked(ctx.say).mock.calls[0][0];
      expect((callArgs as any).text).not.toContain('xoxb-1234567890-abcdefghijk');
      expect((callArgs as any).text).toMatch(/xoxb\.\.\.hijk/);
    });

    it('skips comments and empty lines', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue('# comment\n\nDEBUG=true\n');
      const ctx = makeCtx({ text: 'config show' });
      await handler.execute(ctx);

      const callArgs = vi.mocked(ctx.say).mock.calls[0][0];
      expect((callArgs as any).text).not.toContain('# comment');
      expect((callArgs as any).text).toContain('DEBUG=true');
    });

    it('rejects non-admin', async () => {
      vi.mocked(isAdminUser).mockReturnValue(false);
      const ctx = makeCtx({ text: 'config show' });
      await handler.execute(ctx);

      expect(fs.readFileSync).not.toHaveBeenCalled();
    });

    it('handles missing .env file', async () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });
      const ctx = makeCtx({ text: 'config show' });
      const result = await handler.execute(ctx);

      expect(result.handled).toBe(true);
      expect(ctx.say).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('.env'),
        })
      );
    });
  });

  // ── Scenario 10: Config Set ──
  describe('config set', () => {
    beforeEach(() => {
      vi.mocked(fs.readFileSync).mockReturnValue('DEBUG=false\nBASE_DIRECTORY=/tmp\n');
      vi.mocked(fs.writeFileSync).mockImplementation(() => {});
    });

    it('updates process.env', async () => {
      const ctx = makeCtx({ text: 'config DEBUG=true' });
      await handler.execute(ctx);

      expect(process.env.DEBUG).toBe('true');
    });

    afterEach(() => {
      delete process.env.DEBUG;
      delete process.env.NEW_VAR;
      delete process.env.ADMIN_USERS;
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN_LIST;
    });

    it('updates .env file - replaces existing key', async () => {
      const ctx = makeCtx({ text: 'config DEBUG=true' });
      await handler.execute(ctx);

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('DEBUG=true'),
        'utf8'
      );
      // Should not contain old value
      const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(written).not.toContain('DEBUG=false');
    });

    it('appends new key to .env', async () => {
      const ctx = makeCtx({ text: 'config NEW_VAR=hello' });
      await handler.execute(ctx);

      const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(written).toContain('NEW_VAR=hello');
      // Original content preserved
      expect(written).toContain('DEBUG=false');
    });

    it('resets ADMIN_USERS cache', async () => {
      const ctx = makeCtx({ text: 'config ADMIN_USERS=U1,U2' });
      await handler.execute(ctx);

      expect(resetAdminUsersCache).toHaveBeenCalled();
    });

    it('resets token manager for CCT token list', async () => {
      const ctx = makeCtx({ text: 'config CLAUDE_CODE_OAUTH_TOKEN_LIST=t1,t2' });
      await handler.execute(ctx);

      expect(tokenManager.initialize).toHaveBeenCalled();
    });

    it('rejects non-admin', async () => {
      vi.mocked(isAdminUser).mockReturnValue(false);
      const ctx = makeCtx({ text: 'config DEBUG=true' });
      await handler.execute(ctx);

      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('rejects invalid format', async () => {
      const ctx = makeCtx({ text: 'config invalid' });
      const result = await handler.execute(ctx);

      expect(result.handled).toBe(true);
      expect(fs.writeFileSync).not.toHaveBeenCalled();
      expect(ctx.say).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Usage'),
        })
      );
    });

    it('handles .env write failure gracefully', async () => {
      vi.mocked(fs.writeFileSync).mockImplementation(() => {
        throw new Error('Permission denied');
      });
      const ctx = makeCtx({ text: 'config DEBUG=true' });
      const result = await handler.execute(ctx);

      expect(result.handled).toBe(true);
      // process.env was still updated
      expect(process.env.DEBUG).toBe('true');
      // Warning message sent
      expect(ctx.say).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('process.env'),
        })
      );
    });
  });

  // ── canHandle ──
  describe('canHandle', () => {
    it.each([
      'accept <@U123>',
      'deny <@U123>',
      'users',
      'config show',
      'config DEBUG=true',
      '/accept <@U123>',
      '/deny <@U123>',
      '/users',
      '/config show',
    ])('recognizes "%s"', (text) => {
      expect(handler.canHandle(text)).toBe(true);
    });

    it.each([
      'hello',
      'accept',  // no target
      'config',  // no subcommand
      'cct',     // handled by CctHandler
    ])('rejects "%s"', (text) => {
      expect(handler.canHandle(text)).toBe(false);
    });
  });
});
