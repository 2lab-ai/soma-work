import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock modules before imports. The handler touches:
//   - web-server.getViewerBaseUrl (static base URL)
//   - oauth.issueSlackToken + oauth.getJwtSecret
//   - userSettingsStore.ensureUserExists
// Each is stubbed so the test stays unit-scoped (no Fastify, no fs).

vi.mock('../../conversation/web-server', () => ({
  getViewerBaseUrl: vi.fn(() => 'http://macmini:33000'),
}));

const mockIssueSlackToken = vi.fn();
const mockGetJwtSecret = vi.fn();
vi.mock('../../conversation/oauth', () => ({
  issueSlackToken: (...args: any[]) => mockIssueSlackToken(...args),
  getJwtSecret: () => mockGetJwtSecret(),
}));

const mockEnsureUserExists = vi.fn();
vi.mock('../../user-settings-store', () => ({
  userSettingsStore: {
    ensureUserExists: (...args: any[]) => mockEnsureUserExists(...args),
  },
}));

import { DashboardHandler } from './dashboard-handler';
import type { CommandContext } from './types';

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    user: 'U_USER1',
    channel: 'C1',
    threadTs: 'thread1',
    text: 'dashboard',
    say: vi.fn().mockResolvedValue({ ts: 'msg_ts' }),
    ...overrides,
  };
}

describe('DashboardHandler (#704)', () => {
  let handler: DashboardHandler;

  beforeEach(() => {
    handler = new DashboardHandler();
    mockIssueSlackToken.mockReset();
    mockGetJwtSecret.mockReset();
    mockEnsureUserExists.mockReset();
  });

  describe('canHandle', () => {
    it('matches bare `dashboard`', () => {
      expect(handler.canHandle('dashboard')).toBe(true);
    });
    it('matches `/dashboard` slash form', () => {
      expect(handler.canHandle('/dashboard')).toBe(true);
    });
    it('is case-insensitive', () => {
      expect(handler.canHandle('DASHBOARD')).toBe(true);
    });
    it('ignores surrounding whitespace', () => {
      expect(handler.canHandle('  dashboard  ')).toBe(true);
    });
    it('does NOT match `dashboard foo` (subcommands unsupported)', () => {
      expect(handler.canHandle('dashboard status')).toBe(false);
    });
    it('does NOT match partial words', () => {
      expect(handler.canHandle('dashboards')).toBe(false);
      expect(handler.canHandle('mydashboard')).toBe(false);
    });
  });

  describe('execute', () => {
    it('refuses when no signing key is configured', async () => {
      mockGetJwtSecret.mockReturnValue('');
      const ctx = makeCtx();

      const result = await handler.execute(ctx);

      expect(result.handled).toBe(true);
      expect(mockIssueSlackToken).not.toHaveBeenCalled();
      expect(ctx.say).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Dashboard authentication is not configured'),
          thread_ts: 'thread1',
        }),
      );
    });

    it('issues a token keyed on Slack user id and replies with SSO URL', async () => {
      mockGetJwtSecret.mockReturnValue('some-secret');
      mockEnsureUserExists.mockReturnValue({
        userId: 'U_USER1',
        slackName: 'Alice',
        email: 'alice@corp.com',
      });
      mockIssueSlackToken.mockReturnValue('signed.jwt.value');
      const ctx = makeCtx();

      const result = await handler.execute(ctx);

      expect(result.handled).toBe(true);
      expect(mockEnsureUserExists).toHaveBeenCalledWith('U_USER1');
      expect(mockIssueSlackToken).toHaveBeenCalledWith({
        slackUserId: 'U_USER1',
        email: 'alice@corp.com',
        name: 'Alice',
      });

      const sayArg = (ctx.say as any).mock.calls[0][0];
      expect(sayArg.thread_ts).toBe('thread1');
      expect(sayArg.text).toContain('http://macmini:33000/auth/sso?token=signed.jwt.value');
      // URL-encode reserved characters if the signer ever returns any
      expect(sayArg.text).toMatch(/auth\/sso\?token=[^\s]+/);
    });

    it('falls back to placeholder email/name when settings are sparse', async () => {
      mockGetJwtSecret.mockReturnValue('some-secret');
      mockEnsureUserExists.mockReturnValue({
        userId: 'U_USER1',
        // slackName missing
        // email missing
      });
      mockIssueSlackToken.mockReturnValue('signed.jwt');
      const ctx = makeCtx();

      await handler.execute(ctx);

      expect(mockIssueSlackToken).toHaveBeenCalledWith({
        slackUserId: 'U_USER1',
        email: 'U_USER1@slack.local',
        name: 'U_USER1',
      });
    });

    it('reports failure without leaking the exception', async () => {
      mockGetJwtSecret.mockReturnValue('some-secret');
      mockEnsureUserExists.mockReturnValue({ userId: 'U_USER1' });
      mockIssueSlackToken.mockImplementation(() => {
        throw new Error('signing exploded');
      });
      const ctx = makeCtx();

      const result = await handler.execute(ctx);

      expect(result.handled).toBe(true);
      const sayArg = (ctx.say as any).mock.calls[0][0];
      expect(sayArg.text).toContain('Failed to create a dashboard login link');
      expect(sayArg.text).not.toContain('signing exploded');
    });
  });
});
