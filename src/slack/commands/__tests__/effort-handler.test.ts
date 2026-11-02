import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock is hoisted above imports; use vi.hoisted so our mock fns travel with it.
const { mockSetUserDefaultEffort, mockGetUserDefaultEffort, mockResolveEffortInput, mockGetUserDefaultModel } =
  vi.hoisted(() => ({
    mockSetUserDefaultEffort: vi.fn(),
    mockGetUserDefaultEffort: vi.fn().mockReturnValue('high'),
    mockResolveEffortInput: vi.fn((v: string) =>
      ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(v) ? (v as 'low') : null,
    ),
    mockGetUserDefaultModel: vi.fn().mockReturnValue('claude-opus-5-5[1m]'),
  }));

// The levels each default model runs (the llmux catalog menu; SDK five without one).
vi.mock('../../../session/effort-menu', () => ({
  allowedEffortsFor: (model?: string) =>
    model?.startsWith('gpt-6')
      ? ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
      : model === 'grok-4.6'
        ? ['low', 'medium', 'high', 'xhigh']
        : ['low', 'medium', 'high', 'xhigh', 'max'],
}));

vi.mock('../../../user-settings-store', () => ({
  DEFAULT_EFFORT: 'high',
  EFFORT_LEVELS: ['low', 'medium', 'high', 'xhigh', 'max'] as const,
  userSettingsStore: {
    getUserDefaultEffort: mockGetUserDefaultEffort,
    setUserDefaultEffort: mockSetUserDefaultEffort,
    resolveEffortInput: mockResolveEffortInput,
    getUserDefaultModel: mockGetUserDefaultModel,
    getModelDisplayName: (m: string) => `Display(${m})`,
  },
}));

import { EffortHandler } from '../effort-handler';
import type { CommandContext, CommandDependencies } from '../types';

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

    it('a level the default model does not run is refused, nothing persisted; ultra only where the model lists it', async () => {
      mockGetUserDefaultModel.mockReturnValueOnce('grok-4.6');
      const refused = makeCtx('effort max');
      await handler.execute(refused);
      expect(mockSetUserDefaultEffort).not.toHaveBeenCalled();
      expect(session.effort).toBe('high');
      const text = (refused.say as ReturnType<typeof vi.fn>).mock.calls[0][0].text;
      expect(text).toContain('Effort Not Supported');
      expect(text).toContain('`low`, `medium`, `high`, `xhigh`');
      // Claude (the default here) stops at max.
      await handler.execute(makeCtx('effort ultra'));
      expect(mockSetUserDefaultEffort).not.toHaveBeenCalled();
      // Sol runs ultra.
      mockGetUserDefaultModel.mockReturnValueOnce('gpt-6.1-sol[1m]');
      await handler.execute(makeCtx('effort ultra'));
      expect(mockSetUserDefaultEffort).toHaveBeenCalledWith('U1', 'ultra');
    });

    it('a default the open session’s model does not run is saved for future sessions only', async () => {
      mockGetUserDefaultModel.mockReturnValueOnce('gpt-6.1-sol[1m]');
      session.model = 'claude-opus-5-5[1m]';
      const ctx = makeCtx('effort ultra');
      await handler.execute(ctx);
      expect(mockSetUserDefaultEffort).toHaveBeenCalledWith('U1', 'ultra');
      expect(session.effort).toBe('high');
      expect((ctx.say as ReturnType<typeof vi.fn>).mock.calls[0][0].text).toContain('Future sessions only');
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
