/**
 * MarketplaceHandler tests — TDD RED phase
 *
 * Covers: canHandle routing, list/add/remove subcommands,
 * missing PluginManager edge case, error handling.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketplaceHandler } from './marketplace-handler';
import type { CommandContext, CommandDependencies, SayFn } from './types';

function createMockPluginManager(overrides: Record<string, unknown> = {}) {
  return {
    getMarketplaces: vi.fn().mockReturnValue([]),
    addMarketplace: vi.fn().mockReturnValue({ success: true }),
    removeMarketplace: vi.fn().mockReturnValue({ success: true }),
    refresh: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createMockDeps(pluginManager?: ReturnType<typeof createMockPluginManager>): CommandDependencies {
  return {
    mcpManager: {
      getPluginManager: vi.fn().mockReturnValue(pluginManager ?? undefined),
    },
  } as unknown as CommandDependencies;
}

function createContext(text: string): { ctx: CommandContext; say: ReturnType<typeof vi.fn> } {
  const say = vi.fn().mockResolvedValue({ ts: 'msg_ts' });
  const ctx: CommandContext = {
    user: 'U123',
    channel: 'C123',
    threadTs: 'thread_ts',
    text,
    say: say as unknown as SayFn,
  };
  return { ctx, say };
}

describe('MarketplaceHandler', () => {
  describe('canHandle', () => {
    let handler: MarketplaceHandler;

    beforeEach(() => {
      handler = new MarketplaceHandler(createMockDeps());
    });

    it('should handle "marketplace" (list)', () => {
      expect(handler.canHandle('marketplace')).toBe(true);
    });

    it('should handle "/marketplace" (with slash)', () => {
      expect(handler.canHandle('/marketplace')).toBe(true);
    });

    it('should handle "marketplace add owner/repo"', () => {
      expect(handler.canHandle('marketplace add 2lab-ai/soma-work')).toBe(true);
    });

    it('should handle "marketplace add owner/repo --name custom --ref dev"', () => {
      expect(handler.canHandle('marketplace add 2lab-ai/soma-work --name custom --ref dev')).toBe(true);
    });

    it('should handle "marketplace remove name"', () => {
      expect(handler.canHandle('marketplace remove soma-work')).toBe(true);
    });

    it('should not handle non-marketplace text', () => {
      expect(handler.canHandle('hello world')).toBe(false);
      expect(handler.canHandle('mcp')).toBe(false);
      expect(handler.canHandle('plugins add foo')).toBe(false);
    });
  });

  describe('execute — missing PluginManager', () => {
    it('should show error when PluginManager is not initialized', async () => {
      const handler = new MarketplaceHandler(createMockDeps()); // no pluginManager
      const { ctx, say } = createContext('marketplace');

      const result = await handler.execute(ctx);

      expect(result.handled).toBe(true);
      expect(say).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Plugin system not initialized'),
          thread_ts: 'thread_ts',
        }),
      );
    });
  });

  describe('execute — list', () => {
    it('should show marketplaces when they exist', async () => {
      const pm = createMockPluginManager({
        getMarketplaces: vi.fn().mockReturnValue([
          { name: 'soma-work', repo: '2lab-ai/soma-work', ref: 'main' },
          { name: 'another', repo: 'org/repo', ref: 'dev' },
        ]),
      });
      const handler = new MarketplaceHandler(createMockDeps(pm));
      const { ctx, say } = createContext('marketplace');

      const result = await handler.execute(ctx);

      expect(result.handled).toBe(true);
      expect(say).toHaveBeenCalledTimes(1);
      const text = say.mock.calls[0][0].text as string;
      expect(text).toContain('Registered Marketplaces');
      expect(text).toContain('soma-work');
      expect(text).toContain('2lab-ai/soma-work');
      expect(text).toContain('main');
      expect(text).toContain('another');
      expect(text).toContain('org/repo');
      expect(text).toContain('dev');
    });

    it('should show empty message when no marketplaces', async () => {
      const pm = createMockPluginManager({
        getMarketplaces: vi.fn().mockReturnValue([]),
      });
      const handler = new MarketplaceHandler(createMockDeps(pm));
      const { ctx, say } = createContext('marketplace');

      const result = await handler.execute(ctx);

      expect(result.handled).toBe(true);
      const text = say.mock.calls[0][0].text as string;
      expect(text).toContain('No marketplaces configured');
    });
  });

  describe('execute — add', () => {
    it('should successfully add a marketplace', async () => {
      const pm = createMockPluginManager();
      const handler = new MarketplaceHandler(createMockDeps(pm));
      const { ctx, say } = createContext('marketplace add 2lab-ai/soma-work');

      const result = await handler.execute(ctx);

      expect(result.handled).toBe(true);
      expect(pm.addMarketplace).toHaveBeenCalledWith({
        name: 'soma-work',
        repo: '2lab-ai/soma-work',
        ref: 'main',
      });
      expect(pm.refresh).toHaveBeenCalled();
      const text = say.mock.calls[0][0].text as string;
      expect(text).toContain('soma-work');
      expect(text).toContain('added');
    });

    it('should use custom name and ref when provided', async () => {
      const pm = createMockPluginManager();
      const handler = new MarketplaceHandler(createMockDeps(pm));
      const { ctx, say } = createContext('marketplace add org/repo --name custom --ref dev');

      await handler.execute(ctx);

      expect(pm.addMarketplace).toHaveBeenCalledWith({
        name: 'custom',
        repo: 'org/repo',
        ref: 'dev',
      });
    });

    it('should show error on failure (e.g., duplicate)', async () => {
      const pm = createMockPluginManager({
        addMarketplace: vi.fn().mockReturnValue({
          success: false,
          error: 'Marketplace "soma-work" already exists',
        }),
      });
      const handler = new MarketplaceHandler(createMockDeps(pm));
      const { ctx, say } = createContext('marketplace add 2lab-ai/soma-work');

      const result = await handler.execute(ctx);

      expect(result.handled).toBe(true);
      expect(pm.refresh).not.toHaveBeenCalled();
      const text = say.mock.calls[0][0].text as string;
      expect(text).toContain('already exists');
    });
  });

  describe('execute — remove', () => {
    it('should successfully remove a marketplace', async () => {
      const pm = createMockPluginManager();
      const handler = new MarketplaceHandler(createMockDeps(pm));
      const { ctx, say } = createContext('marketplace remove soma-work');

      const result = await handler.execute(ctx);

      expect(result.handled).toBe(true);
      expect(pm.removeMarketplace).toHaveBeenCalledWith('soma-work');
      const text = say.mock.calls[0][0].text as string;
      expect(text).toContain('soma-work');
      expect(text).toContain('removed');
    });

    it('should show error on failure (e.g., not found)', async () => {
      const pm = createMockPluginManager({
        removeMarketplace: vi.fn().mockReturnValue({
          success: false,
          error: 'Marketplace "unknown" not found',
        }),
      });
      const handler = new MarketplaceHandler(createMockDeps(pm));
      const { ctx, say } = createContext('marketplace remove unknown');

      const result = await handler.execute(ctx);

      expect(result.handled).toBe(true);
      const text = say.mock.calls[0][0].text as string;
      expect(text).toContain('not found');
    });
  });
});
