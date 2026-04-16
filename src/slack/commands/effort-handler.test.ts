import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock is hoisted above imports; use vi.hoisted so our mock fns travel with it.
const { mockSetUserDefaultEffort, mockGetUserDefaultEffort, mockResolveEffortInput } = vi.hoisted(() => ({
  mockSetUserDefaultEffort: vi.fn(),
  mockGetUserDefaultEffort: vi.fn().mockReturnValue('high'),
  mockResolveEffortInput: vi.fn((v: string) =>
    ['low', 'medium', 'high', 'xhigh', 'max'].includes(v) ? (v as 'low' | 'medium' | 'high' | 'xhigh' | 'max') : null,
  ),
}));

vi.mock('../../user-settings-store', () => ({
  DEFAULT_EFFORT: 'high',
  EFFORT_LEVELS: ['low', 'medium', 'high', 'xhigh', 'max'] as const,
  userSettingsStore: {
    getUserDefaultEffort: mockGetUserDefaultEffort,
    setUserDefaultEffort: mockSetUserDefaultEffort,
    resolveEffortInput: mockResolveEffortInput,
  },
}));

import { EffortHandler } from './effort-handler';
import type { CommandContext, CommandDependencies } from './types';

describe('EffortHandler', () => {
  let handler: EffortHandler;
  let mockDeps: CommandDependencies;
  let session: Record<string, unknown>;

  beforeEach(() => {
    mockSetUserDefaultEffort.mockClear();
    mockGetUserDefaultEffort.mockClear();
    mockResolveEffortInput.mockClear();
    session = { effort: 'high' };
    mockDeps = {
      claudeHandler: {
        getSession: vi.fn().mockReturnValue(session),
      },
    } as unknown as CommandDependencies;
    handler = new EffortHandler(mockDeps);
  });

  const makeCtx = (text: string): CommandContext => ({
    user: 'U1',
    channel: 'C1',
    threadTs: '171.100',
    text,
    say: vi.fn().mockResolvedValue({ ts: 'ts1' }),
  });

  describe('canHandle', () => {
    it.each(['effort', 'effort low', 'effort high', '/effort', '/effort max'])('accepts bare "%s"', (cmd) => {
      expect(handler.canHandle(cmd)).toBe(true);
    });

    it.each([
      '%effort',
      '$effort',
      '%effort high',
      '$effort high',
      'hello',
    ])('rejects "%s" (not bare effort)', (cmd) => {
      expect(handler.canHandle(cmd)).toBe(false);
    });
  });

  describe('execute — status', () => {
    it('shows current default and all available levels', async () => {
      const ctx = makeCtx('effort');
      const result = await handler.execute(ctx);
      expect(result.handled).toBe(true);
      expect(mockGetUserDefaultEffort).toHaveBeenCalledWith('U1');
      const say = ctx.say as ReturnType<typeof vi.fn>;
      const msg = say.mock.calls[0][0];
      expect(msg.text).toContain('*high*');
      expect(msg.text).toContain('low');
      expect(msg.text).toContain('max');
      expect(msg.text).toContain('current');
    });
  });

  describe('execute — set', () => {
    it.each(['low', 'medium', 'high', 'xhigh', 'max'])('persists valid level "%s"', async (level) => {
      const ctx = makeCtx(`effort ${level}`);
      const result = await handler.execute(ctx);
      expect(result.handled).toBe(true);
      expect(mockResolveEffortInput).toHaveBeenCalledWith(level);
      expect(mockSetUserDefaultEffort).toHaveBeenCalledWith('U1', level);
      expect(session.effort).toBe(level);
      const say = ctx.say as ReturnType<typeof vi.fn>;
      expect(say.mock.calls[0][0].text).toContain('Effort Changed');
      expect(say.mock.calls[0][0].text).toContain(`*${level}*`);
    });

    it('rejects unknown level without persisting', async () => {
      const ctx = makeCtx('effort turbo');
      const result = await handler.execute(ctx);
      expect(result.handled).toBe(true);
      expect(mockResolveEffortInput).toHaveBeenCalledWith('turbo');
      expect(mockSetUserDefaultEffort).not.toHaveBeenCalled();
      expect(session.effort).toBe('high'); // unchanged
      const say = ctx.say as ReturnType<typeof vi.fn>;
      expect(say.mock.calls[0][0].text).toContain('Unknown Effort Level');
      expect(say.mock.calls[0][0].text).toContain('`turbo`');
    });

    it('persists even when no live session exists', async () => {
      (mockDeps.claudeHandler.getSession as ReturnType<typeof vi.fn>).mockReturnValueOnce(undefined);
      const ctx = makeCtx('effort max');
      const result = await handler.execute(ctx);
      expect(result.handled).toBe(true);
      expect(mockSetUserDefaultEffort).toHaveBeenCalledWith('U1', 'max');
      // session object was not mutated because getSession returned undefined
      expect(session.effort).toBe('high');
    });
  });
});
