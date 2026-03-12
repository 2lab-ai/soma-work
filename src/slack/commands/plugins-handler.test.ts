/**
 * PluginsHandler tests — TDD Red-Green-Refactor
 *
 * Covers:
 * - canHandle routing
 * - list: built-in local plugin always shown
 * - list: marketplace plugins when installed
 * - list: only built-in when no marketplace plugins
 * - list: missing PluginManager gracefully handled
 * - add: success path
 * - add: error on invalid format
 * - remove: success path
 * - remove: rejects built-in local plugin
 * - remove: error for non-existent plugin
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PluginsHandler } from './plugins-handler';
import type { CommandDependencies, CommandContext, SayFn } from './types';

function createMockPluginManager(overrides: Record<string, any> = {}) {
  return {
    getInstalledPlugins: vi.fn().mockReturnValue([]),
    getResolvedPlugins: vi.fn().mockReturnValue([]),
    addPlugin: vi.fn().mockReturnValue({ success: true }),
    removePlugin: vi.fn().mockReturnValue({ success: true }),
    refresh: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createDeps(pluginManager?: ReturnType<typeof createMockPluginManager>): CommandDependencies {
  return {
    mcpManager: {
      getPluginManager: vi.fn().mockReturnValue(pluginManager ?? null),
    },
  } as unknown as CommandDependencies;
}

function createContext(text: string): { ctx: CommandContext; say: ReturnType<typeof vi.fn> } {
  const say = vi.fn().mockResolvedValue({ ts: 'msg_ts' });
  return {
    ctx: {
      user: 'U123',
      channel: 'C123',
      threadTs: 'thread_ts',
      text,
      say: say as unknown as SayFn,
    },
    say,
  };
}

describe('PluginsHandler', () => {
  let handler: PluginsHandler;
  let mockPluginManager: ReturnType<typeof createMockPluginManager>;
  let deps: CommandDependencies;

  beforeEach(() => {
    mockPluginManager = createMockPluginManager();
    deps = createDeps(mockPluginManager);
    handler = new PluginsHandler(deps);
  });

  // =========================================================================
  // canHandle
  // =========================================================================

  describe('canHandle', () => {
    it('should handle "plugins" command', () => {
      expect(handler.canHandle('plugins')).toBe(true);
    });

    it('should handle "/plugins" command', () => {
      expect(handler.canHandle('/plugins')).toBe(true);
    });

    it('should handle "plugins add" subcommand', () => {
      expect(handler.canHandle('plugins add omc@soma-work')).toBe(true);
    });

    it('should handle "plugins remove" subcommand', () => {
      expect(handler.canHandle('plugins remove omc@soma-work')).toBe(true);
    });

    it('should handle with leading/trailing whitespace', () => {
      expect(handler.canHandle('  plugins  ')).toBe(true);
    });

    it('should not handle non-plugins text', () => {
      expect(handler.canHandle('help')).toBe(false);
      expect(handler.canHandle('mcp')).toBe(false);
      expect(handler.canHandle('marketplace')).toBe(false);
      expect(handler.canHandle('hello plugins')).toBe(false);
    });
  });

  // =========================================================================
  // list (default subcommand)
  // =========================================================================

  describe('list', () => {
    it('should always show built-in local plugin', async () => {
      const { ctx, say } = createContext('plugins');
      const result = await handler.execute(ctx);

      expect(result.handled).toBe(true);
      expect(say).toHaveBeenCalledTimes(1);

      const message = say.mock.calls[0][0].text;
      expect(message).toContain('local');
      expect(message).toContain('built-in');
    });

    it('should show marketplace plugins when installed', async () => {
      mockPluginManager.getInstalledPlugins.mockReturnValue(['omc@soma-work']);
      mockPluginManager.getResolvedPlugins.mockReturnValue([
        { name: 'omc@soma-work', localPath: '/path/to/omc', source: 'marketplace' },
      ]);

      const { ctx, say } = createContext('plugins');
      await handler.execute(ctx);

      const message = say.mock.calls[0][0].text;
      expect(message).toContain('omc@soma-work');
      expect(message).toContain('/path/to/omc');
    });

    it('should show hint when no marketplace plugins installed', async () => {
      mockPluginManager.getInstalledPlugins.mockReturnValue([]);
      mockPluginManager.getResolvedPlugins.mockReturnValue([]);

      const { ctx, say } = createContext('plugins');
      await handler.execute(ctx);

      const message = say.mock.calls[0][0].text;
      expect(message).toContain('No marketplace plugins installed');
      expect(message).toContain('plugins add');
    });

    it('should handle missing PluginManager gracefully', async () => {
      const noPmDeps = createDeps(undefined as any);
      (noPmDeps.mcpManager.getPluginManager as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
      const noPmHandler = new PluginsHandler(noPmDeps);

      const { ctx, say } = createContext('plugins');
      await noPmHandler.execute(ctx);

      expect(say).toHaveBeenCalledTimes(1);
      const message = say.mock.calls[0][0].text;
      expect(message).toContain('not available');
    });
  });

  // =========================================================================
  // add
  // =========================================================================

  describe('add', () => {
    it('should successfully add a plugin', async () => {
      const { ctx, say } = createContext('plugins add omc@soma-work');
      const result = await handler.execute(ctx);

      expect(result.handled).toBe(true);
      expect(mockPluginManager.addPlugin).toHaveBeenCalledWith('omc@soma-work');

      const message = say.mock.calls[0][0].text;
      expect(message).toContain('omc@soma-work');
      expect(message).toMatch(/added|installed/i);
    });

    it('should show error on failure', async () => {
      mockPluginManager.addPlugin.mockReturnValue({
        success: false,
        error: 'Plugin ref "bad" is invalid (expected "name@marketplace")',
      });

      const { ctx, say } = createContext('plugins add bad');
      await handler.execute(ctx);

      const message = say.mock.calls[0][0].text;
      expect(message).toContain('invalid');
    });

    it('should handle missing PluginManager for add', async () => {
      const noPmDeps = createDeps(undefined as any);
      (noPmDeps.mcpManager.getPluginManager as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
      const noPmHandler = new PluginsHandler(noPmDeps);

      const { ctx, say } = createContext('plugins add omc@soma-work');
      await noPmHandler.execute(ctx);

      const message = say.mock.calls[0][0].text;
      expect(message).toContain('not available');
    });
  });

  // =========================================================================
  // remove
  // =========================================================================

  describe('remove', () => {
    it('should successfully remove a plugin', async () => {
      const { ctx, say } = createContext('plugins remove omc@soma-work');
      const result = await handler.execute(ctx);

      expect(result.handled).toBe(true);
      expect(mockPluginManager.removePlugin).toHaveBeenCalledWith('omc@soma-work');

      const message = say.mock.calls[0][0].text;
      expect(message).toMatch(/removed|uninstalled/i);
    });

    it('should reject removal of built-in local plugin (exact "local")', async () => {
      const { ctx, say } = createContext('plugins remove local');
      await handler.execute(ctx);

      expect(mockPluginManager.removePlugin).not.toHaveBeenCalled();
      const message = say.mock.calls[0][0].text;
      expect(message).toContain('Built-in local plugin cannot be removed');
    });

    it('should reject removal of built-in local plugin (starts with "local@")', async () => {
      const { ctx, say } = createContext('plugins remove local@anything');
      await handler.execute(ctx);

      expect(mockPluginManager.removePlugin).not.toHaveBeenCalled();
      const message = say.mock.calls[0][0].text;
      expect(message).toContain('Built-in local plugin cannot be removed');
    });

    it('should show error for non-existent plugin', async () => {
      mockPluginManager.removePlugin.mockReturnValue({
        success: false,
        error: 'Plugin "nonexistent@mp" not found',
      });

      const { ctx, say } = createContext('plugins remove nonexistent@mp');
      await handler.execute(ctx);

      const message = say.mock.calls[0][0].text;
      expect(message).toContain('not found');
    });

    it('should handle missing PluginManager for remove', async () => {
      const noPmDeps = createDeps(undefined as any);
      (noPmDeps.mcpManager.getPluginManager as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
      const noPmHandler = new PluginsHandler(noPmDeps);

      const { ctx, say } = createContext('plugins remove omc@soma-work');
      await noPmHandler.execute(ctx);

      const message = say.mock.calls[0][0].text;
      expect(message).toContain('not available');
    });
  });
});
