import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock modules before imports
vi.mock('../../../admin-utils', () => ({
  isAdminUser: vi.fn(),
}));

import { isAdminUser } from '../../../admin-utils';
import type { ConversationSession } from '../../../types';
import { InstructionsHandler } from '../instructions-handler';
import type { CommandContext, CommandDependencies } from '../types';

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    user: 'U_ADMIN',
    channel: 'C123',
    threadTs: 'thread123',
    text: 'show instructions',
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

describe('InstructionsHandler', () => {
  let handler: InstructionsHandler;
  let deps: CommandDependencies;

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('canHandle', () => {
    beforeEach(() => {
      deps = makeDeps();
      handler = new InstructionsHandler(deps);
    });

    it('matches "show instructions"', () => {
      expect(handler.canHandle('show instructions')).toBe(true);
    });

    it('matches "/show instructions"', () => {
      expect(handler.canHandle('/show instructions')).toBe(true);
    });

    it('does not match underscore form "show_instructions" (removed in #506)', () => {
      // /z refactor (#506): canonical form is `show instructions` (space-separated).
      expect(handler.canHandle('show_instructions')).toBe(false);
    });

    it('does not match random text', () => {
      expect(handler.canHandle('show me the money')).toBe(false);
    });
  });

  describe('execute', () => {
    it('rejects non-admin users', async () => {
      deps = makeDeps();
      handler = new InstructionsHandler(deps);
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
      handler = new InstructionsHandler(deps);
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

    it('returns message when no instructions captured', async () => {
      const session = {
        ownerId: 'U_ADMIN',
        channelId: 'C123',
        isActive: true,
        lastActivity: new Date(),
        userId: 'U_ADMIN',
        workflow: 'default',
      } as ConversationSession;

      deps = makeDeps(session);
      handler = new InstructionsHandler(deps);
      vi.mocked(isAdminUser).mockReturnValue(true);

      const ctx = makeCtx();
      const result = await handler.execute(ctx);

      expect(result.handled).toBe(true);
      expect(deps.slackApi.postSystemMessage).toHaveBeenCalledWith(
        'C123',
        expect.stringContaining('No instructions captured'),
        expect.objectContaining({ threadTs: 'thread123' }),
      );
    });

    it('displays initial instruction when present', async () => {
      const session = {
        ownerId: 'U_ADMIN',
        channelId: 'C123',
        isActive: true,
        lastActivity: new Date(),
        userId: 'U_ADMIN',
        workflow: 'default',
        initialInstruction: 'Please review my PR',
      } as ConversationSession;

      deps = makeDeps(session);
      handler = new InstructionsHandler(deps);
      vi.mocked(isAdminUser).mockReturnValue(true);

      const ctx = makeCtx();
      const result = await handler.execute(ctx);

      expect(result.handled).toBe(true);
      const callArg = (deps.slackApi.postSystemMessage as any).mock.calls[0][1];
      expect(callArg).toContain('User Instructions');
      expect(callArg).toContain('Initial Instruction');
      expect(callArg).toContain('Please review my PR');
      expect(callArg).toContain('default');
    });

    it('displays both initial and follow-up instructions', async () => {
      const session = {
        ownerId: 'U_ADMIN',
        channelId: 'C123',
        isActive: true,
        lastActivity: new Date(),
        userId: 'U_ADMIN',
        workflow: 'jira-create-pr',
        initialInstruction: 'Create a PR for JIRA-123',
        followUpInstructions: [
          { timestamp: 1700000000000, text: 'Also fix the lint errors', speaker: 'U_ADMIN' },
          { timestamp: 1700000060000, text: 'Add unit tests too', speaker: 'U_ADMIN' },
        ],
      } as ConversationSession;

      deps = makeDeps(session);
      handler = new InstructionsHandler(deps);
      vi.mocked(isAdminUser).mockReturnValue(true);

      const ctx = makeCtx();
      const result = await handler.execute(ctx);

      expect(result.handled).toBe(true);
      const callArg = (deps.slackApi.postSystemMessage as any).mock.calls[0][1];
      expect(callArg).toContain('User Instructions');
      expect(callArg).toContain('Initial Instruction');
      expect(callArg).toContain('Create a PR for JIRA-123');
      expect(callArg).toContain('Follow-up Instructions (2)');
      expect(callArg).toContain('Also fix the lint errors');
      expect(callArg).toContain('Add unit tests too');
      expect(callArg).toContain('jira-create-pr');
      // The handler now shows SSOT vs legacy counts separately — legacy
      // turn-log = initialInstruction (1) + followUpInstructions (2) = 3.
      expect(callArg).toContain('Legacy turn-log: 3');
      // No SSOT entries on this legacy fixture.
      expect(callArg).toContain('SSOT: 0');
    });
  });
});
