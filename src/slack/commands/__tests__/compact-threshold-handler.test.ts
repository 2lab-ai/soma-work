import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CompactThresholdHandler } from '../compact-threshold-handler';
import type { CommandContext, CommandDependencies } from '../types';

/**
 * #617 — `/compact-threshold` command handler tests.
 * Covers AC1 (range/type validation + persistence) and AC7 (no-arg status query).
 */
describe('CompactThresholdHandler (#617 AC1, AC7)', () => {
  let handler: CompactThresholdHandler;
  let mockDeps: CommandDependencies;
  let postSystemMessage: ReturnType<typeof vi.fn>;
  let getUserCompactThreshold: ReturnType<typeof vi.fn>;
  let setUserCompactThreshold: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    postSystemMessage = vi.fn().mockResolvedValue(undefined);
    getUserCompactThreshold = vi.fn().mockReturnValue(80);
    setUserCompactThreshold = vi.fn();

    mockDeps = {
      slackApi: { postSystemMessage },
      userSettingsStore: {
        getUserCompactThreshold,
        setUserCompactThreshold,
      },
    } as unknown as CommandDependencies;

    handler = new CompactThresholdHandler(mockDeps);
  });

  const makeCtx = (text: string): CommandContext => ({
    user: 'U1',
    channel: 'C1',
    threadTs: '171.100',
    text,
    say: vi.fn().mockResolvedValue({ ts: 'ts1' }),
  });

  describe('canHandle (#617 AC7)', () => {
    it.each([
      '/compact-threshold',
      'compact-threshold',
      '/compact-threshold 80',
      'compact-threshold 50',
      '/compact-threshold abc',
    ])('AC7: accepts "%s"', (cmd) => {
      expect(handler.canHandle(cmd)).toBe(true);
    });

    it.each(['/compact', 'compact', '/compact 80', 'hello', '/compact-thresholds'])('rejects "%s"', (cmd) => {
      expect(handler.canHandle(cmd)).toBe(false);
    });
  });

  describe('execute — no argument (#617 AC7)', () => {
    it('AC7: posts "Current threshold: 80%" when no argument given', async () => {
      getUserCompactThreshold.mockReturnValue(80);
      const ctx = makeCtx('/compact-threshold');
      const result = await handler.execute(ctx);

      expect(result.handled).toBe(true);
      expect(getUserCompactThreshold).toHaveBeenCalledWith('U1');
      expect(postSystemMessage).toHaveBeenCalledWith('C1', 'Current threshold: 80%', { threadTs: '171.100' });
      expect(setUserCompactThreshold).not.toHaveBeenCalled();
    });

    it('AC7: reflects persisted value when set', async () => {
      getUserCompactThreshold.mockReturnValue(65);
      const ctx = makeCtx('compact-threshold');
      await handler.execute(ctx);

      expect(postSystemMessage).toHaveBeenCalledWith('C1', 'Current threshold: 65%', { threadTs: '171.100' });
    });
  });

  describe('execute — valid argument (#617 AC1)', () => {
    it('AC1: persists threshold 75 and posts "Updated to 75%"', async () => {
      const ctx = makeCtx('/compact-threshold 75');
      const result = await handler.execute(ctx);

      expect(result.handled).toBe(true);
      expect(setUserCompactThreshold).toHaveBeenCalledWith('U1', 75);
      expect(postSystemMessage).toHaveBeenCalledWith('C1', 'Updated to 75%', { threadTs: '171.100' });
    });

    it('AC1: accepts 50 (lower boundary)', async () => {
      const ctx = makeCtx('/compact-threshold 50');
      await handler.execute(ctx);
      expect(setUserCompactThreshold).toHaveBeenCalledWith('U1', 50);
      expect(postSystemMessage).toHaveBeenCalledWith('C1', 'Updated to 50%', { threadTs: '171.100' });
    });

    it('AC1: accepts 95 (upper boundary)', async () => {
      const ctx = makeCtx('/compact-threshold 95');
      await handler.execute(ctx);
      expect(setUserCompactThreshold).toHaveBeenCalledWith('U1', 95);
      expect(postSystemMessage).toHaveBeenCalledWith('C1', 'Updated to 95%', { threadTs: '171.100' });
    });
  });

  describe('execute — invalid argument (#617 AC1)', () => {
    it('AC1: rejects 30 (below range) with validator message + allowed-range hint', async () => {
      const ctx = makeCtx('/compact-threshold 30');
      const result = await handler.execute(ctx);

      expect(result.handled).toBe(true);
      // Handler pre-validates via validateCompactThreshold; setter never runs.
      expect(setUserCompactThreshold).not.toHaveBeenCalled();
      const msg = postSystemMessage.mock.calls[0][1];
      expect(msg).toMatch(/must be in \[50, 95\]/);
      expect(msg).toMatch(/allowed range: 50.95/);
    });

    it('AC1: rejects "abc" (type guard) without calling setter', async () => {
      const ctx = makeCtx('/compact-threshold abc');
      const result = await handler.execute(ctx);

      expect(result.handled).toBe(true);
      // "abc" fails the integer regex — NaN is handed to validator, which
      // rejects with "must be an integer". Setter must NOT be invoked.
      expect(setUserCompactThreshold).not.toHaveBeenCalled();
      const msg = postSystemMessage.mock.calls[0][1];
      expect(msg).toMatch(/integer/);
      expect(msg).toMatch(/allowed range: 50.95/);
    });

    it('AC1: rejects "3.5" (fractional) via integer regex without calling setter', async () => {
      const ctx = makeCtx('/compact-threshold 3.5');
      const result = await handler.execute(ctx);

      expect(result.handled).toBe(true);
      expect(setUserCompactThreshold).not.toHaveBeenCalled();
      const msg = postSystemMessage.mock.calls[0][1];
      expect(msg).toMatch(/integer/);
    });

    it('AC1: rejects 100 (above range)', async () => {
      const ctx = makeCtx('/compact-threshold 100');
      await handler.execute(ctx);

      // Handler pre-validates; setter never runs for out-of-range values.
      expect(setUserCompactThreshold).not.toHaveBeenCalled();
      const msg = postSystemMessage.mock.calls[0][1];
      expect(msg).toMatch(/must be in \[50, 95\]/);
    });
  });
});
