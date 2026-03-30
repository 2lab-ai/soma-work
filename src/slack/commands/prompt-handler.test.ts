import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock modules before imports
vi.mock('../../admin-utils', () => ({
  isAdminUser: vi.fn(),
}));

import { PromptHandler } from './prompt-handler';
import { isAdminUser } from '../../admin-utils';
import { CommandContext, CommandDependencies } from './types';
import { ConversationSession } from '../../types';

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    user: 'U_ADMIN',
    channel: 'C123',
    threadTs: 'thread123',
    text: 'show prompt',
    say: vi.fn().mockResolvedValue({ ts: 'msg_ts' }),
    ...overrides,
  };
}

function makeDeps(session?: ConversationSession | undefined): CommandDependencies {
  return {
    claudeHandler: {
      getSession: vi.fn().mockReturnValue(session),
    },
    slackApi: {
      postSystemMessage: vi.fn().mockResolvedValue(undefined),
    },
  } as any;
}

describe('PromptHandler', () => {
  let handler: PromptHandler;
  let deps: CommandDependencies;

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('canHandle', () => {
    beforeEach(() => {
      deps = makeDeps();
      handler = new PromptHandler(deps);
    });

    it('matches "show prompt"', () => {
      expect(handler.canHandle('show prompt')).toBe(true);
    });

    it('matches "/show prompt"', () => {
      expect(handler.canHandle('/show prompt')).toBe(true);
    });

    it('matches "show_prompt"', () => {
      expect(handler.canHandle('show_prompt')).toBe(true);
    });

    it('matches case-insensitive "Show Prompt"', () => {
      expect(handler.canHandle('Show Prompt')).toBe(true);
    });

    it('does not match random text', () => {
      expect(handler.canHandle('show me the money')).toBe(false);
    });

    it('does not match "show"', () => {
      expect(handler.canHandle('show')).toBe(false);
    });
  });

  describe('execute', () => {
    it('rejects non-admin users', async () => {
      deps = makeDeps();
      handler = new PromptHandler(deps);
      vi.mocked(isAdminUser).mockReturnValue(false);

      const ctx = makeCtx({ user: 'U_NORMAL' });
      const result = await handler.execute(ctx);

      expect(result.handled).toBe(true);
      expect(ctx.say).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('Admin only') })
      );
    });

    it('returns message when no session exists', async () => {
      deps = makeDeps(undefined);
      handler = new PromptHandler(deps);
      vi.mocked(isAdminUser).mockReturnValue(true);

      const ctx = makeCtx();
      const result = await handler.execute(ctx);

      expect(result.handled).toBe(true);
      expect(ctx.say).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('No active session') })
      );
    });

    it('returns message when systemPrompt is not yet captured', async () => {
      const session = {
        ownerId: 'U_ADMIN',
        channelId: 'C123',
        isActive: true,
        lastActivity: new Date(),
        userId: 'U_ADMIN',
        workflow: 'default',
      } as ConversationSession;

      deps = makeDeps(session);
      handler = new PromptHandler(deps);
      vi.mocked(isAdminUser).mockReturnValue(true);

      const ctx = makeCtx();
      const result = await handler.execute(ctx);

      expect(result.handled).toBe(true);
      expect(ctx.say).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('No system prompt captured') })
      );
    });

    it('displays the system prompt for admin users', async () => {
      const session = {
        ownerId: 'U_ADMIN',
        channelId: 'C123',
        isActive: true,
        lastActivity: new Date(),
        userId: 'U_ADMIN',
        workflow: 'default',
        systemPrompt: 'You are a helpful assistant.\nBe concise.',
      } as ConversationSession;

      deps = makeDeps(session);
      handler = new PromptHandler(deps);
      vi.mocked(isAdminUser).mockReturnValue(true);

      const ctx = makeCtx();
      const result = await handler.execute(ctx);

      expect(result.handled).toBe(true);
      const callArg = (ctx.say as any).mock.calls[0][0];
      expect(callArg.text).toContain('System Prompt Snapshot');
      expect(callArg.text).toContain('You are a helpful assistant');
      expect(callArg.text).toContain('default');
    });

    it('truncates very long prompts', async () => {
      const longPrompt = 'x'.repeat(5000);
      const session = {
        ownerId: 'U_ADMIN',
        channelId: 'C123',
        isActive: true,
        lastActivity: new Date(),
        userId: 'U_ADMIN',
        workflow: 'jira-create-pr',
        systemPrompt: longPrompt,
      } as ConversationSession;

      deps = makeDeps(session);
      handler = new PromptHandler(deps);
      vi.mocked(isAdminUser).mockReturnValue(true);

      const ctx = makeCtx();
      const result = await handler.execute(ctx);

      expect(result.handled).toBe(true);
      const callArg = (ctx.say as any).mock.calls[0][0];
      expect(callArg.text).toContain('truncated');
      expect(callArg.text).toContain('5,000 chars');
    });
  });
});
