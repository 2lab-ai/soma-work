import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationSession } from '../../../types';
import { AutoCompactHandler } from '../autocompact-handler';
import { CompactHandler } from '../compact-handler';
import { CompactThresholdHandler } from '../compact-threshold-handler';
import type { CommandContext, CommandDependencies } from '../types';

/**
 * Task 3 — `/autocompact` handler. Session-scoped token override on top of the
 * model default, with the shared safe-limit rule as the only gate.
 */
describe('AutoCompactHandler', () => {
  let handler: AutoCompactHandler;
  let deps: CommandDependencies;
  let postSystemMessage: ReturnType<typeof vi.fn>;
  let getSession: ReturnType<typeof vi.fn>;
  let saveSessions: ReturnType<typeof vi.fn>;
  let session: ConversationSession;

  const makeSession = (model: string, autoCompactTokens?: number | null): ConversationSession =>
    ({
      ownerId: 'U1',
      userId: 'U1',
      channelId: 'C1',
      threadTs: '171.100',
      isActive: true,
      lastActivity: new Date(),
      model,
      ...(autoCompactTokens === undefined ? {} : { autoCompactTokens }),
    }) as unknown as ConversationSession;

  beforeEach(() => {
    postSystemMessage = vi.fn().mockResolvedValue(undefined);
    session = makeSession('claude-opus-5[1m]');
    getSession = vi.fn().mockImplementation(() => session);
    saveSessions = vi.fn();

    deps = {
      slackApi: { postSystemMessage },
      claudeHandler: { getSession, saveSessions },
      userSettingsStore: { getUserCompactThreshold: vi.fn().mockReturnValue(80) },
    } as unknown as CommandDependencies;

    handler = new AutoCompactHandler(deps);
  });

  const makeCtx = (text: string): CommandContext => ({
    user: 'U1',
    channel: 'C1',
    threadTs: '171.100',
    text,
    say: vi.fn().mockResolvedValue({ ts: 'ts1' }),
  });

  const lastMessage = (): string => postSystemMessage.mock.calls[postSystemMessage.mock.calls.length - 1]![1] as string;

  describe('canHandle', () => {
    it.each([
      '/autocompact',
      'autocompact',
      '/autocompact 800k',
      'autocompact reset',
      '/autocompact abc',
    ])('accepts "%s"', (cmd) => {
      expect(handler.canHandle(cmd)).toBe(true);
    });

    it.each([
      '/compact',
      'compact',
      '/compact --yes',
      '/compact-threshold',
      'compact-threshold 80',
      'hello',
    ])('rejects "%s"', (cmd) => {
      expect(handler.canHandle(cmd)).toBe(false);
    });
  });

  describe('non-overlap with the existing compact commands', () => {
    it('CompactHandler does not consume /autocompact', () => {
      const compact = new CompactHandler(deps as never);
      expect(compact.canHandle('/autocompact')).toBe(false);
      expect(compact.canHandle('autocompact 800k')).toBe(false);
    });

    it('CompactThresholdHandler does not consume /autocompact', () => {
      const thresholdHandler = new CompactThresholdHandler(deps);
      expect(thresholdHandler.canHandle('/autocompact')).toBe(false);
      expect(thresholdHandler.canHandle('autocompact reset')).toBe(false);
    });

    it('AutoCompactHandler does not consume the commands it sits next to', () => {
      expect(handler.canHandle('/compact')).toBe(false);
      expect(handler.canHandle('/compact-threshold 80')).toBe(false);
    });
  });

  describe('status (no argument)', () => {
    it('reports the model default and its source', async () => {
      const result = await handler.execute(makeCtx('/autocompact'));

      expect(result.handled).toBe(true);
      expect(saveSessions).not.toHaveBeenCalled();
      const msg = lastMessage();
      expect(msg).toMatch(/750,?000|750k/);
      expect(msg).toMatch(/model/i);
      expect(msg).toContain('claude-opus-5[1m]');
    });

    it('reports an active session override', async () => {
      session = makeSession('claude-opus-5[1m]', 400_000);
      const msg = (await handler.execute(makeCtx('autocompact')), lastMessage());
      expect(msg).toMatch(/400,?000|400k/);
      expect(msg).toMatch(/session/i);
    });
  });

  describe('set', () => {
    it('stores the parsed override on the session and saves immediately', async () => {
      const result = await handler.execute(makeCtx('/autocompact 800k'));

      expect(result.handled).toBe(true);
      expect(session.autoCompactTokens).toBe(800_000);
      expect(saveSessions).toHaveBeenCalledTimes(1);
      expect(lastMessage()).toMatch(/800,?000|800k/);
    });

    it('accepts the bare-thousands shorthand', async () => {
      await handler.execute(makeCtx('autocompact 600'));
      expect(session.autoCompactTokens).toBe(600_000);
    });

    it('rejects a malformed argument without touching the session', async () => {
      await handler.execute(makeCtx('/autocompact banana'));

      expect(session.autoCompactTokens).toBeUndefined();
      expect(saveSessions).not.toHaveBeenCalled();
      expect(lastMessage()).toMatch(/❌/);
    });

    it('rejects a threshold above the model safe limit and reports the maximum', async () => {
      session = makeSession('claude-opus-5');
      await handler.execute(makeCtx('/autocompact 190k'));

      expect(session.autoCompactTokens).toBeUndefined();
      expect(saveSessions).not.toHaveBeenCalled();
      const msg = lastMessage();
      expect(msg).toMatch(/❌/);
      expect(msg).toMatch(/168/);
    });
  });

  describe('reset', () => {
    it('clears the override, saves immediately and reports the model default', async () => {
      session = makeSession('claude-opus-5[1m]', 400_000);
      const result = await handler.execute(makeCtx('/autocompact reset'));

      expect(result.handled).toBe(true);
      expect(session.autoCompactTokens ?? null).toBeNull();
      expect(saveSessions).toHaveBeenCalledTimes(1);
      const msg = lastMessage();
      expect(msg).toMatch(/750,?000|750k/);
      expect(msg).toMatch(/model/i);
    });
  });

  describe('no active session', () => {
    it('declines with a hint and never saves', async () => {
      getSession.mockReturnValue(undefined);
      const result = await handler.execute(makeCtx('/autocompact 800k'));

      expect(result.handled).toBe(true);
      expect(saveSessions).not.toHaveBeenCalled();
      expect(lastMessage()).toMatch(/No active session/i);
    });
  });

  describe('unroutable session model', () => {
    it('refuses visibly on grok-4.6[1m] and points at grok-4.6', async () => {
      session = makeSession('grok-4.6[1m]');
      const result = await handler.execute(makeCtx('/autocompact 400k'));

      expect(result.handled).toBe(true);
      expect(session.autoCompactTokens).toBeUndefined();
      expect(saveSessions).not.toHaveBeenCalled();
      const msg = lastMessage();
      expect(msg).toMatch(/❌/);
      expect(msg.toLowerCase()).toContain('use `grok-4.6`');
    });
  });
});
