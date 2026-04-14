import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock modules before imports
vi.mock('../../admin-utils', () => ({
  isAdminUser: vi.fn(),
}));

import { isAdminUser } from '../../admin-utils';
import type { ConversationSession } from '../../types';
import { PromptHandler } from './prompt-handler';
import type { CommandContext, CommandDependencies } from './types';

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

function makeDeps(
  session?: ConversationSession | undefined,
  opts?: { filesUploadV2?: ReturnType<typeof vi.fn> },
): CommandDependencies {
  const filesUploadV2 = opts?.filesUploadV2 ?? vi.fn().mockResolvedValue({ files: [{ files: [{ id: 'F123' }] }] });
  return {
    claudeHandler: {
      getSession: vi.fn().mockReturnValue(session),
    },
    slackApi: {
      postSystemMessage: vi.fn().mockResolvedValue(undefined),
      getClient: vi.fn().mockReturnValue({ filesUploadV2 }),
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
      expect(deps.slackApi.postSystemMessage).toHaveBeenCalledWith(
        'C123',
        expect.stringContaining('Admin only'),
        expect.objectContaining({ threadTs: 'thread123' }),
      );
    });

    it('returns message when no session exists', async () => {
      deps = makeDeps(undefined);
      handler = new PromptHandler(deps);
      vi.mocked(isAdminUser).mockReturnValue(true);

      const ctx = makeCtx();
      const result = await handler.execute(ctx);

      expect(result.handled).toBe(true);
      expect(deps.slackApi.postSystemMessage).toHaveBeenCalledWith(
        'C123',
        expect.stringContaining('No active session'),
        expect.objectContaining({ threadTs: 'thread123' }),
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
      expect(deps.slackApi.postSystemMessage).toHaveBeenCalledWith(
        'C123',
        expect.stringContaining('No system prompt captured'),
        expect.objectContaining({ threadTs: 'thread123' }),
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
      const callArg = (deps.slackApi.postSystemMessage as any).mock.calls[0][1];
      expect(callArg).toContain('System Prompt Snapshot');
      expect(callArg).toContain('You are a helpful assistant');
      expect(callArg).toContain('default');
    });

    it('uploads long prompts as file instead of truncating', async () => {
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

      const filesUploadV2 = vi.fn().mockResolvedValue({ files: [{ files: [{ id: 'F123' }] }] });
      deps = makeDeps(session, { filesUploadV2 });
      handler = new PromptHandler(deps);
      vi.mocked(isAdminUser).mockReturnValue(true);

      const ctx = makeCtx();
      const result = await handler.execute(ctx);

      expect(result.handled).toBe(true);
      const callArg = (deps.slackApi.postSystemMessage as any).mock.calls[0][1];
      expect(callArg).toContain('5,000 chars');
      expect(callArg).toContain('Full prompt attached as file');
      expect(filesUploadV2).toHaveBeenCalledWith(
        expect.objectContaining({
          channel_id: 'C123',
          thread_ts: 'thread123',
          content: longPrompt,
          filename: 'system-prompt-jira-create-pr.txt',
        }),
      );
    });

    it('falls back to truncated display when file upload fails', async () => {
      const longPrompt = 'x'.repeat(5000);
      const session = {
        ownerId: 'U_ADMIN',
        channelId: 'C123',
        isActive: true,
        lastActivity: new Date(),
        userId: 'U_ADMIN',
        workflow: 'default',
        systemPrompt: longPrompt,
      } as ConversationSession;

      const filesUploadV2 = vi.fn().mockRejectedValue(new Error('upload failed'));
      deps = makeDeps(session, { filesUploadV2 });
      handler = new PromptHandler(deps);
      vi.mocked(isAdminUser).mockReturnValue(true);

      const ctx = makeCtx();
      const result = await handler.execute(ctx);

      expect(result.handled).toBe(true);
      // Second postSystemMessage call is the fallback with truncated content
      const fallbackArg = (deps.slackApi.postSystemMessage as any).mock.calls[1][1];
      expect(fallbackArg).toContain('truncated');
      expect(fallbackArg).toContain('File upload failed');
    });
  });
});
