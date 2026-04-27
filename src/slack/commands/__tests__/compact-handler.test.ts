import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CompactHandler } from '../compact-handler';
import type { CommandContext, CommandDependencies } from '../types';

/**
 * #617 followup v2 — `/compact` yes/no confirmation flow.
 *
 *   1. `/compact`         → post Block Kit yes/no prompt, `{ handled: true }`.
 *   2. `/compact --yes`   → post "Triggering …", `{ handled: true,
 *                           continueWithPrompt: '/compact' }`.
 *
 * The confirmation indirection moves the SDK-triggering side effect behind
 * an explicit user click so accidental `/compact` messages don't drop the
 * session context.
 */
describe('CompactHandler (#617 followup v2 — yes/no confirmation)', () => {
  let handler: CompactHandler;
  let mockDeps: CommandDependencies;
  let postSystemMessage: ReturnType<typeof vi.fn>;
  let getSession: ReturnType<typeof vi.fn>;
  let getSessionKey: ReturnType<typeof vi.fn>;
  let isRequestActive: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    postSystemMessage = vi.fn().mockResolvedValue(undefined);
    getSession = vi.fn().mockReturnValue({ sessionId: 'sess-1' });
    getSessionKey = vi.fn().mockReturnValue('C1:171.100');
    isRequestActive = vi.fn().mockReturnValue(false);

    mockDeps = {
      slackApi: { postSystemMessage },
      claudeHandler: { getSession, getSessionKey },
      requestCoordinator: { isRequestActive },
    } as unknown as CommandDependencies;

    handler = new CompactHandler(mockDeps);
  });

  const makeCtx = (text: string): CommandContext => ({
    user: 'U1',
    channel: 'C1',
    threadTs: '171.100',
    text,
    say: vi.fn().mockResolvedValue({ ts: 'ts1' }),
  });

  describe('canHandle', () => {
    it.each([
      '/compact',
      'compact',
      '/compact --yes',
      'compact --yes',
      '/COMPACT',
      '  compact  ',
    ])('accepts "%s"', (cmd) => {
      expect(handler.canHandle(cmd)).toBe(true);
    });

    it.each(['/compact-threshold', 'compact-threshold 80', '/compact 80', 'compact extra'])('rejects "%s"', (cmd) => {
      expect(handler.canHandle(cmd)).toBe(false);
    });
  });

  describe('execute — no session', () => {
    it('returns handled with "No active session" warning when session missing', async () => {
      getSession.mockReturnValue(undefined);
      const result = await handler.execute(makeCtx('/compact'));
      expect(result).toEqual({ handled: true });
      expect(postSystemMessage).toHaveBeenCalledWith('C1', expect.stringContaining('No active session'), {
        threadTs: '171.100',
      });
    });

    it('returns handled when session has no sessionId', async () => {
      getSession.mockReturnValue({ sessionId: undefined });
      const result = await handler.execute(makeCtx('/compact'));
      expect(result).toEqual({ handled: true });
      expect(postSystemMessage).toHaveBeenCalled();
    });
  });

  describe('execute — request busy', () => {
    it('returns handled with "Cannot compact" warning when a request is active', async () => {
      isRequestActive.mockReturnValue(true);
      const result = await handler.execute(makeCtx('/compact'));
      expect(result).toEqual({ handled: true });
      expect(postSystemMessage).toHaveBeenCalledWith('C1', expect.stringContaining('Cannot compact'), {
        threadTs: '171.100',
      });
    });
  });

  describe('execute — /compact (no --yes)', () => {
    it('posts yes/no Block Kit prompt with compact_confirm + compact_cancel buttons', async () => {
      const ctx = makeCtx('/compact');
      const result = await handler.execute(ctx);
      expect(result).toEqual({ handled: true });
      // Must NOT delegate to SDK yet.
      expect(result.continueWithPrompt).toBeUndefined();
      // Must NOT post the "Triggering" announcement yet.
      expect(postSystemMessage).not.toHaveBeenCalled();
      // Must post via say() with Block Kit buttons.
      expect(ctx.say).toHaveBeenCalledTimes(1);
      const sayArg = (ctx.say as any).mock.calls[0][0];
      expect(sayArg.thread_ts).toBe('171.100');
      const actionsBlock = sayArg.blocks.find((b: any) => b.type === 'actions');
      expect(actionsBlock).toBeDefined();
      const actionIds = actionsBlock.elements.map((el: any) => el.action_id);
      expect(actionIds).toEqual(['compact_confirm', 'compact_cancel']);
      // Each button value carries the session key so the action handler can
      // re-resolve the session.
      for (const el of actionsBlock.elements) {
        expect(el.value).toBe('C1:171.100');
      }
    });

    it('bare "compact" (no slash) also posts the yes/no prompt', async () => {
      const ctx = makeCtx('compact');
      const result = await handler.execute(ctx);
      expect(result).toEqual({ handled: true });
      expect(ctx.say).toHaveBeenCalledTimes(1);
    });
  });

  describe('execute — /compact --yes', () => {
    it('posts "Triggering context compaction..." and returns continueWithPrompt=/compact', async () => {
      const ctx = makeCtx('/compact --yes');
      const result = await handler.execute(ctx);
      expect(result).toEqual({ handled: true, continueWithPrompt: '/compact' });
      expect(postSystemMessage).toHaveBeenCalledWith('C1', '🗜️ Triggering context compaction...', {
        threadTs: '171.100',
      });
      // Must NOT post the confirm prompt.
      expect(ctx.say).not.toHaveBeenCalled();
    });

    it('bare "compact --yes" also triggers SDK path', async () => {
      const ctx = makeCtx('compact --yes');
      const result = await handler.execute(ctx);
      expect(result.continueWithPrompt).toBe('/compact');
    });
  });
});
