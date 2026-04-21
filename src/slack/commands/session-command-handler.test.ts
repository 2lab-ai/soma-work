import { beforeEach, describe, expect, it, vi } from 'vitest';

// Stub user-settings-store so SessionCommandHandler's imports don't trigger real file I/O.
vi.mock('../../user-settings-store', () => ({
  DEFAULT_SHOW_THINKING: false,
  DEFAULT_THINKING_ENABLED: false,
  MODEL_ALIASES: { opus: 'claude-opus-4-7', 'opus[1m]': 'claude-opus-4-7[1m]' },
  userSettingsStore: {
    getUserDefaultModel: vi.fn().mockReturnValue('claude-opus-4-7'),
    getModelDisplayName: vi.fn().mockReturnValue('Opus 4.7'),
    getUserDefaultEffort: vi.fn().mockReturnValue('high'),
    getUserDefaultLogVerbosity: vi.fn().mockReturnValue('detail'),
    getUserThinkingEnabled: vi.fn().mockReturnValue(false),
    getUserShowThinking: vi.fn().mockReturnValue(false),
    resolveModelInput: vi.fn((v: string) => (v === 'opus' ? 'claude-opus-4-7' : null)),
    resolveVerbosityInput: vi.fn((v: string) => (['minimal', 'compact', 'detail', 'verbose'].includes(v) ? v : null)),
  },
}));

vi.mock('../../utils/dir-size', () => ({
  formatBytes: vi.fn().mockReturnValue('0 B'),
  getDirSizeBytes: vi.fn().mockReturnValue(0),
}));

import { SessionCommandHandler } from './session-command-handler';
import type { CommandContext, CommandDependencies } from './types';

/**
 * Unit tests covering the `%` / `$` prefix migration behaviour:
 * - Deprecation notice fires for legacy `$` prefix
 * - `%` prefix parses and dispatches without any warning
 * - Skill-like `$local:z` / `$z` are NOT handled here (they flow to SkillForceHandler)
 */
describe('SessionCommandHandler', () => {
  let handler: SessionCommandHandler;
  let mockDeps: CommandDependencies;
  let session: Record<string, unknown>;

  beforeEach(() => {
    session = { model: 'claude-opus-4-7', logVerbosity: 0b1111 };
    mockDeps = {
      claudeHandler: {
        getSession: vi.fn().mockReturnValue(session),
      },
    } as unknown as CommandDependencies;
    handler = new SessionCommandHandler(mockDeps);
  });

  const makeCtx = (text: string): CommandContext => ({
    user: 'U1',
    channel: 'C1',
    threadTs: '171.100',
    text,
    say: vi.fn().mockResolvedValue({ ts: 'ts1' }),
  });

  describe('canHandle', () => {
    it('handles primary `%` prefix', () => {
      expect(handler.canHandle('%')).toBe(true);
      expect(handler.canHandle('%model')).toBe(true);
      expect(handler.canHandle('%effort high')).toBe(true);
    });

    it('handles legacy `$` prefix (grace period)', () => {
      expect(handler.canHandle('$')).toBe(true);
      expect(handler.canHandle('$model')).toBe(true);
      expect(handler.canHandle('$effort high')).toBe(true);
    });

    it('does NOT handle `$local:z` (skill reference)', () => {
      expect(handler.canHandle('$local:z')).toBe(false);
    });

    it('does NOT handle `$z` (bare skill shorthand)', () => {
      expect(handler.canHandle('$z')).toBe(false);
    });

    it('does NOT handle plain text', () => {
      expect(handler.canHandle('hello world')).toBe(false);
    });
  });

  describe('deprecation notice', () => {
    it('emits deprecation notice when user types legacy `$model opus`', async () => {
      const ctx = makeCtx('$model opus');
      await handler.execute(ctx);

      // First say call should be the deprecation warning pointing at the `%` form.
      expect(ctx.say).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('`%model opus`'),
          thread_ts: '171.100',
        }),
      );
      // The deprecation text must explain that `$` is reserved for forced skill invocation.
      const firstCall = (ctx.say as any).mock.calls[0][0];
      expect(firstCall.text).toContain('더 이상 사용되지 않습니다');
      expect(firstCall.text).toContain('강제 스킬 발동');
    });

    it('still executes the command after emitting deprecation notice', async () => {
      const ctx = makeCtx('$model opus');
      await handler.execute(ctx);

      // The command itself must still run — we should see a subsequent say() with the
      // "Session Model Changed" confirmation. (More than one say call in total.)
      expect((ctx.say as any).mock.calls.length).toBeGreaterThanOrEqual(2);
      const texts = (ctx.say as any).mock.calls.map((c: any[]) => c[0].text as string);
      expect(texts.some((t: string) => t.includes('Session Model Changed'))).toBe(true);
    });

    it('does NOT emit deprecation notice for primary `%model opus`', async () => {
      const ctx = makeCtx('%model opus');
      await handler.execute(ctx);

      const texts = (ctx.say as any).mock.calls.map((c: any[]) => c[0].text as string);
      expect(texts.some((t: string) => t.includes('더 이상 사용되지 않습니다'))).toBe(false);
      // Still dispatches the "set model" flow.
      expect(texts.some((t: string) => t.includes('Session Model Changed'))).toBe(true);
    });

    it('emits deprecation notice for bare `$` → info', async () => {
      const ctx = makeCtx('$');
      await handler.execute(ctx);

      const firstCall = (ctx.say as any).mock.calls[0][0];
      expect(firstCall.text).toContain('더 이상 사용되지 않습니다');
      expect(firstCall.text).toContain('`%`');
    });
  });

  describe('session not found', () => {
    it('emits deprecation notice AND "no active session" when `$` used without session', async () => {
      (mockDeps.claudeHandler.getSession as any).mockReturnValue(null);
      const ctx = makeCtx('$model opus');
      await handler.execute(ctx);

      const texts = (ctx.say as any).mock.calls.map((c: any[]) => c[0].text as string);
      // Deprecation first, then the "no active session" message.
      expect(texts[0]).toContain('더 이상 사용되지 않습니다');
      expect(texts[1]).toContain('No active session');
    });
  });
});
