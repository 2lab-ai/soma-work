import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../admin-utils', () => ({
  isAdminUser: vi.fn(),
}));

vi.mock('../../user-settings-store', () => ({
  userSettingsStore: {
    getUserSandboxDisabled: vi.fn(),
    setUserSandboxDisabled: vi.fn(),
    getUserNetworkDisabled: vi.fn(),
    setUserNetworkDisabled: vi.fn(),
  },
}));

import { isAdminUser } from '../../admin-utils';
import { DEV_DOMAIN_ALLOWLIST } from '../../sandbox/dev-domain-allowlist';
import { userSettingsStore } from '../../user-settings-store';
import { SandboxHandler } from './sandbox-handler';
import type { CommandContext } from './types';

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    user: 'U_TEST',
    channel: 'C123',
    threadTs: 'thread123',
    text: '',
    say: vi.fn().mockResolvedValue({ ts: 'msg_ts' }),
    ...overrides,
  };
}

function sayCall(ctx: CommandContext): string {
  const sayMock = ctx.say as unknown as ReturnType<typeof vi.fn>;
  const calls = sayMock.mock.calls;
  const last = calls[calls.length - 1] as [{ text?: string }] | undefined;
  return last?.[0]?.text ?? '';
}

describe('SandboxHandler', () => {
  let handler: SandboxHandler;

  beforeEach(() => {
    handler = new SandboxHandler();
    vi.mocked(userSettingsStore.getUserSandboxDisabled).mockReturnValue(false);
    vi.mocked(userSettingsStore.getUserNetworkDisabled).mockReturnValue(false);
    vi.mocked(isAdminUser).mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('canHandle', () => {
    it.each([
      'sandbox',
      '/sandbox',
      'sandbox on',
      'sandbox off',
      'sandbox status',
      'sandbox network',
      'sandbox network on',
      'sandbox network off',
      'sandbox network status',
    ])('recognizes "%s"', (text) => {
      expect(handler.canHandle(text)).toBe(true);
    });

    it.each(['hello', 'sandbox foo', 'sandbox network foo', 'sandboxes'])('rejects "%s"', (text) => {
      expect(handler.canHandle(text)).toBe(false);
    });
  });

  describe('status (4 combinations)', () => {
    it('sandbox ON + network ON', async () => {
      const ctx = makeCtx({ text: 'sandbox' });
      await handler.execute(ctx);
      const text = sayCall(ctx);
      expect(text).toContain('Sandbox: `ON`');
      expect(text).toContain('Network allowlist: `ON`');
      expect(text).toContain(String(DEV_DOMAIN_ALLOWLIST.length));
    });

    it('sandbox ON + network OFF', async () => {
      vi.mocked(userSettingsStore.getUserNetworkDisabled).mockReturnValue(true);
      const ctx = makeCtx({ text: 'sandbox network' });
      await handler.execute(ctx);
      const text = sayCall(ctx);
      expect(text).toContain('Sandbox: `ON`');
      expect(text).toContain('Network allowlist: `OFF`');
      expect(text).toContain('not restricted');
    });

    it('sandbox OFF + network ON (stored but inactive)', async () => {
      vi.mocked(userSettingsStore.getUserSandboxDisabled).mockReturnValue(true);
      const ctx = makeCtx({ text: 'sandbox' });
      await handler.execute(ctx);
      const text = sayCall(ctx);
      expect(text).toContain('Sandbox: `OFF`');
      expect(text).toContain('Network allowlist: `ON`');
      expect(text).toContain('stored; inactive');
    });

    it('sandbox OFF + network OFF (stored but inactive)', async () => {
      vi.mocked(userSettingsStore.getUserSandboxDisabled).mockReturnValue(true);
      vi.mocked(userSettingsStore.getUserNetworkDisabled).mockReturnValue(true);
      const ctx = makeCtx({ text: 'sandbox network status' });
      await handler.execute(ctx);
      const text = sayCall(ctx);
      expect(text).toContain('Sandbox: `OFF`');
      expect(text).toContain('Network allowlist: `OFF`');
      expect(text).toContain('stored; inactive');
    });
  });

  describe('sandbox on/off — admin only', () => {
    it('non-admin cannot disable sandbox', async () => {
      vi.mocked(isAdminUser).mockReturnValue(false);
      const ctx = makeCtx({ text: 'sandbox off' });
      await handler.execute(ctx);
      expect(userSettingsStore.setUserSandboxDisabled).not.toHaveBeenCalled();
      expect(sayCall(ctx)).toContain('Permission Denied');
    });

    it('non-admin cannot enable sandbox', async () => {
      vi.mocked(isAdminUser).mockReturnValue(false);
      const ctx = makeCtx({ text: 'sandbox on' });
      await handler.execute(ctx);
      expect(userSettingsStore.setUserSandboxDisabled).not.toHaveBeenCalled();
      expect(sayCall(ctx)).toContain('Permission Denied');
    });

    it('admin can disable sandbox', async () => {
      vi.mocked(isAdminUser).mockReturnValue(true);
      const ctx = makeCtx({ text: 'sandbox off' });
      await handler.execute(ctx);
      expect(userSettingsStore.setUserSandboxDisabled).toHaveBeenCalledWith('U_TEST', true);
      expect(sayCall(ctx)).toContain('Sandbox Disabled');
      expect(sayCall(ctx)).toContain('next message');
    });

    it('admin can enable sandbox', async () => {
      vi.mocked(isAdminUser).mockReturnValue(true);
      const ctx = makeCtx({ text: 'sandbox on' });
      await handler.execute(ctx);
      expect(userSettingsStore.setUserSandboxDisabled).toHaveBeenCalledWith('U_TEST', false);
      expect(sayCall(ctx)).toContain('Sandbox Enabled');
    });
  });

  describe('sandbox network on/off — any user', () => {
    it('non-admin can disable network allowlist', async () => {
      vi.mocked(isAdminUser).mockReturnValue(false);
      const ctx = makeCtx({ text: 'sandbox network off' });
      await handler.execute(ctx);
      expect(userSettingsStore.setUserNetworkDisabled).toHaveBeenCalledWith('U_TEST', true);
      expect(sayCall(ctx)).toContain('Network Allowlist Disabled');
    });

    it('non-admin can enable network allowlist', async () => {
      vi.mocked(isAdminUser).mockReturnValue(false);
      const ctx = makeCtx({ text: 'sandbox network on' });
      await handler.execute(ctx);
      expect(userSettingsStore.setUserNetworkDisabled).toHaveBeenCalledWith('U_TEST', false);
      expect(sayCall(ctx)).toContain('Network Allowlist Enabled');
      expect(sayCall(ctx)).toContain(String(DEV_DOMAIN_ALLOWLIST.length));
    });

    it('network toggle while sandbox is OFF shows "stored but inactive" hint', async () => {
      vi.mocked(userSettingsStore.getUserSandboxDisabled).mockReturnValue(true);
      const ctx = makeCtx({ text: 'sandbox network on' });
      await handler.execute(ctx);
      expect(userSettingsStore.setUserNetworkDisabled).toHaveBeenCalledWith('U_TEST', false);
      expect(sayCall(ctx)).toContain('stored but inactive');
    });

    it('network toggle while sandbox is ON announces next-turn semantics', async () => {
      vi.mocked(userSettingsStore.getUserSandboxDisabled).mockReturnValue(false);
      const ctx = makeCtx({ text: 'sandbox network off' });
      await handler.execute(ctx);
      expect(sayCall(ctx)).toContain('next message');
    });
  });
});
