import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock modules before imports
vi.mock('../../../admin-utils', () => ({
  isAdminUser: vi.fn(),
  resetAdminUsersCache: vi.fn(),
  getAdminUsers: vi.fn(() => new Set(['U_ADMIN'])),
}));

const mockScanChannels = vi.fn();
const mockGetAllChannels = vi.fn();
vi.mock('../../../channel-registry', () => ({
  scanChannels: (...args: unknown[]) => mockScanChannels(...args),
  getAllChannels: (...args: unknown[]) => mockGetAllChannels(...args),
}));

const mockInvalidateChannelCache = vi.fn();
vi.mock('../../../channel-description-cache', () => ({
  invalidateChannelCache: (...args: unknown[]) => mockInvalidateChannelCache(...args),
}));

vi.mock('../../../user-settings-store', () => ({
  userSettingsStore: {
    getUserSettings: vi.fn(),
    acceptUser: vi.fn(),
    removeUserSettings: vi.fn(),
    getAllUsers: vi.fn(),
    createPendingUser: vi.fn(),
  },
}));

vi.mock('../../../env-paths', () => ({
  ENV_FILE: '/mock/.env',
  DATA_DIR: '/mock/data',
}));

const mockAddSlot = vi.fn();
const mockListTokens = vi.fn();

vi.mock('../../../token-manager', () => ({
  getTokenManager: vi.fn(() => ({
    addSlot: mockAddSlot,
    listTokens: mockListTokens,
  })),
}));

vi.mock('fs');

import fs from 'fs';
import { isAdminUser, resetAdminUsersCache } from '../../../admin-utils';
import { getTokenManager } from '../../../token-manager';
import { userSettingsStore } from '../../../user-settings-store';
import { AdminHandler } from '../admin-handler';
import type { CommandContext } from '../types';

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
    mockAddSlot.mockReset();
    mockListTokens.mockReset();
    mockListTokens.mockReturnValue([]);
    mockAddSlot.mockResolvedValue({ slotId: 'SLOT1', name: 'cct1', kind: 'setup_token', createdAt: '' });
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
        }),
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
        }),
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
        }),
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
        {
          userId: 'U1',
          accepted: true,
          acceptedBy: 'U_ADMIN',
          acceptedAt: '2026-01-01',
          defaultDirectory: '',
          bypassPermission: false,
          persona: 'default',
          defaultModel: 'claude-opus-4-6' as any,
          lastUpdated: '',
        },
        {
          userId: 'U2',
          accepted: false,
          defaultDirectory: '',
          bypassPermission: false,
          persona: 'default',
          defaultModel: 'claude-opus-4-6' as any,
          lastUpdated: '',
        },
      ]);
      const ctx = makeCtx({ text: 'users' });
      const result = await handler.execute(ctx);

      expect(result.handled).toBe(true);
      expect(ctx.say).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringMatching(/U1.*U2|U2.*U1/s),
        }),
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
        }),
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
        }),
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

      expect(fs.writeFileSync).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('DEBUG=true'), 'utf8');
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

    it('routes CLAUDE_CODE_OAUTH_TOKEN_LIST through TokenManager.addSlot (no .env write)', async () => {
      const ctx = makeCtx({
        text: 'config CLAUDE_CODE_OAUTH_TOKEN_LIST=a:sk-ant-oat01-aaaaAAAA,b:sk-ant-oat01-bbbbBBBB',
      });
      await handler.execute(ctx);

      expect(getTokenManager).toHaveBeenCalled();
      expect(mockAddSlot).toHaveBeenCalledTimes(2);
      expect(mockAddSlot).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'a', kind: 'setup_token', value: 'sk-ant-oat01-aaaaAAAA' }),
      );
      expect(mockAddSlot).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'b', kind: 'setup_token', value: 'sk-ant-oat01-bbbbBBBB' }),
      );
      // .env must NOT be written for token list
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('skips already-existing slot names via listTokens pre-check', async () => {
      mockListTokens.mockReturnValue([{ slotId: 'EXISTING', name: 'a', kind: 'setup_token', status: 'healthy' }]);
      const ctx = makeCtx({ text: 'config CLAUDE_CODE_OAUTH_TOKEN_LIST=a:sk-ant-oat01-aaaa,b:sk-ant-oat01-bbbb' });
      await handler.execute(ctx);

      // only 'b' should be added
      expect(mockAddSlot).toHaveBeenCalledTimes(1);
      expect(mockAddSlot).toHaveBeenCalledWith(expect.objectContaining({ name: 'b' }));
    });

    it('redacts echoed token values (no sk-ant-… in reply)', async () => {
      const ctx = makeCtx({ text: 'config CLAUDE_CODE_OAUTH_TOKEN_LIST=a:sk-ant-oat01-SUPERSECRETTOKEN1234' });
      await handler.execute(ctx);

      const reply = (vi.mocked(ctx.say).mock.calls[0][0] as any).text as string;
      expect(reply).not.toContain('sk-ant-oat01-SUPERSECRETTOKEN1234');
      expect(reply).not.toMatch(/sk-ant-oat01-[A-Za-z0-9_-]+/);
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
        }),
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
        }),
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
      // admin namespace (#1076)
      'admin',
      '/admin',
      'admin setup',
      'admin users',
      'admin accept <@U123>',
      'admin deny <@U123>',
      'admin config show',
      'admin config DEBUG=true',
      'admin show prompt',
      'admin show instructions',
      'admin sandbox on',
      'admin plugins update',
      'admin cct next',
      'admin ui-test buttons',
    ])('recognizes "%s"', (text) => {
      expect(handler.canHandle(text)).toBe(true);
    });

    it.each([
      'hello',
      'accept', // no target
      'config', // no subcommand
      'cct', // handled by CctHandler
      'administrator', // not the admin command
      'admin 페이지 만들어줘', // prose starting with "admin" must reach the model
      'admin please do something', // unknown sub-root → not a command
    ])('rejects "%s"', (text) => {
      expect(handler.canHandle(text)).toBe(false);
    });
  });

  // ── admin menu (#1076) ──
  describe('admin menu', () => {
    it('shows admin command menu to admins', async () => {
      const ctx = makeCtx({ text: 'admin' });
      const result = await handler.execute(ctx);

      expect(result.handled).toBe(true);
      const reply = (vi.mocked(ctx.say).mock.calls[0][0] as any).text as string;
      expect(reply).toContain('Admin Commands');
      expect(reply).toContain('admin setup');
      expect(reply).toContain('admin accept @user');
      expect(reply).toContain('admin config show');
      expect(reply).toContain('admin show prompt');
      expect(reply).toContain('admin sandbox');
      expect(reply).toContain('admin plugins update');
      expect(reply).toContain('admin cct');
    });

    it('rejects non-admin', async () => {
      vi.mocked(isAdminUser).mockReturnValue(false);
      const ctx = makeCtx({ text: 'admin' });
      const result = await handler.execute(ctx);

      expect(result.handled).toBe(true);
      expect(ctx.say).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('Admin only') }));
    });
  });

  // ── admin setup (#1076) ──
  describe('admin setup', () => {
    const mockGetClient = vi.fn(() => ({ fake: 'client' }));
    const mockReloadConfiguration = vi.fn();

    function makeSetupHandler(): AdminHandler {
      return new AdminHandler({
        slackApi: { getClient: mockGetClient },
        mcpManager: { reloadConfiguration: mockReloadConfiguration },
      });
    }

    beforeEach(() => {
      mockScanChannels.mockReset().mockResolvedValue(4);
      mockGetAllChannels.mockReset().mockReturnValue([
        { id: 'C1', name: 'workspace-soma-work', repos: ['2lab-ai/soma-work'] },
        { id: 'C2', name: 'random', repos: [] },
      ]);
      mockInvalidateChannelCache.mockReset();
      mockGetClient.mockClear();
      mockReloadConfiguration.mockReset().mockReturnValue({ mcpServers: { jira: {}, github: {} } });
    });

    it('re-runs channel scan and reports repo mappings', async () => {
      const setupHandler = makeSetupHandler();
      const ctx = makeCtx({ text: 'admin setup' });
      const result = await setupHandler.execute(ctx);

      expect(result.handled).toBe(true);
      expect(mockScanChannels).toHaveBeenCalledWith({ fake: 'client' });
      const reply = (vi.mocked(ctx.say).mock.calls[0][0] as any).text as string;
      expect(reply).toContain('Channel scan: 4 channel(s), 1 with repo mappings');
      expect(reply).toContain('#workspace-soma-work → 2lab-ai/soma-work');
    });

    it('invalidates the description cache for every scanned channel', async () => {
      const setupHandler = makeSetupHandler();
      await setupHandler.execute(makeCtx({ text: 'admin setup' }));

      expect(mockInvalidateChannelCache).toHaveBeenCalledWith('C1');
      expect(mockInvalidateChannelCache).toHaveBeenCalledWith('C2');
    });

    it('reloads MCP configuration and refreshes admin cache', async () => {
      const setupHandler = makeSetupHandler();
      const ctx = makeCtx({ text: 'admin setup' });
      await setupHandler.execute(ctx);

      expect(mockReloadConfiguration).toHaveBeenCalled();
      expect(resetAdminUsersCache).toHaveBeenCalled();
      const reply = (vi.mocked(ctx.say).mock.calls[0][0] as any).text as string;
      expect(reply).toContain('MCP config reloaded: 2 server(s)');
      expect(reply).toContain('Admin user cache refreshed');
    });

    it('is idempotent — running twice produces the same success report', async () => {
      const setupHandler = makeSetupHandler();
      await setupHandler.execute(makeCtx({ text: 'admin setup' }));
      const ctx2 = makeCtx({ text: 'admin setup' });
      await setupHandler.execute(ctx2);

      expect(mockScanChannels).toHaveBeenCalledTimes(2);
      const reply = (vi.mocked(ctx2.say).mock.calls[0][0] as any).text as string;
      expect(reply).toContain('Channel scan: 4 channel(s)');
    });

    it('reports a failed step but still runs the remaining steps', async () => {
      mockScanChannels.mockRejectedValue(new Error('missing_scope'));
      const setupHandler = makeSetupHandler();
      const ctx = makeCtx({ text: 'admin setup' });
      const result = await setupHandler.execute(ctx);

      expect(result.handled).toBe(true);
      const reply = (vi.mocked(ctx.say).mock.calls[0][0] as any).text as string;
      expect(reply).toContain('❌ Channel scan failed: missing_scope');
      expect(reply).toContain('MCP config reloaded');
      expect(resetAdminUsersCache).toHaveBeenCalled();
    });

    it('reports unwired dependencies explicitly instead of failing silently', async () => {
      const bare = new AdminHandler();
      const ctx = makeCtx({ text: 'admin setup' });
      const result = await bare.execute(ctx);

      expect(result.handled).toBe(true);
      const reply = (vi.mocked(ctx.say).mock.calls[0][0] as any).text as string;
      expect(reply).toContain('Channel scan skipped: slackApi not wired');
      expect(reply).toContain('MCP config reload skipped: mcpManager not wired');
    });

    it('rejects non-admin', async () => {
      vi.mocked(isAdminUser).mockReturnValue(false);
      const setupHandler = makeSetupHandler();
      const ctx = makeCtx({ text: 'admin setup' });
      await setupHandler.execute(ctx);

      expect(mockScanChannels).not.toHaveBeenCalled();
      expect(ctx.say).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('Admin only') }));
    });
  });

  // ── admin-namespaced legacy actions (#1076) ──
  describe('admin-namespaced actions', () => {
    it('routes `admin users` to the users action', async () => {
      vi.mocked(userSettingsStore.getAllUsers).mockReturnValue([]);
      const ctx = makeCtx({ text: 'admin users' });
      const result = await handler.execute(ctx);

      expect(result.handled).toBe(true);
      expect(userSettingsStore.getAllUsers).toHaveBeenCalled();
    });

    it('routes `admin accept @user` to the accept action', async () => {
      const ctx = makeCtx({ text: 'admin accept <@U_NEW>' });
      await handler.execute(ctx);

      expect(userSettingsStore.acceptUser).toHaveBeenCalledWith('U_NEW', 'U_ADMIN');
    });

    it('routes `admin config KEY=VALUE` to config set', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue('');
      vi.mocked(fs.writeFileSync).mockImplementation(() => {});
      const ctx = makeCtx({ text: 'admin config DEBUG=true' });
      await handler.execute(ctx);

      expect(process.env.DEBUG).toBe('true');
      delete process.env.DEBUG;
    });
  });

  // ── admin delegation (#1076) ──
  describe('admin delegation', () => {
    it('delegates `admin sandbox on` to the owning handler with prefix stripped', async () => {
      const delegate = {
        canHandle: vi.fn((text: string) => text.startsWith('sandbox')),
        execute: vi.fn().mockResolvedValue({ handled: true }),
      };
      const delegatingHandler = new AdminHandler({}, [delegate]);
      const ctx = makeCtx({ text: 'admin sandbox on' });
      const result = await delegatingHandler.execute(ctx);

      expect(result.handled).toBe(true);
      expect(delegate.canHandle).toHaveBeenCalledWith('sandbox on', 'U_ADMIN');
      expect(delegate.execute).toHaveBeenCalledWith(expect.objectContaining({ text: 'sandbox on' }));
    });

    it('replies with a hint when no delegate matches', async () => {
      const delegate = {
        canHandle: vi.fn(() => false),
        execute: vi.fn(),
      };
      const delegatingHandler = new AdminHandler({}, [delegate]);
      const ctx = makeCtx({ text: 'admin show somethingelse' });
      const result = await delegatingHandler.execute(ctx);

      expect(result.handled).toBe(true);
      expect(delegate.execute).not.toHaveBeenCalled();
      expect(ctx.say).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('Unknown admin command') }),
      );
    });
  });
});
