import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelInputResolution } from '../../../user-settings-store';

/**
 * Static stand-in for `resolveModelInputDetailed`. `opus` resolves; the fake
 * `grok-4.6[1m]` id takes the REJECTED branch (with the suggestion the real
 * resolver produces); anything else is an unknown typo.
 */
function resolveDetailedStub(raw: string): ModelInputResolution {
  const v = raw.toLowerCase().trim();
  if (v === 'opus') return { status: 'accepted', modelId: 'claude-opus-4-1-20250805' };
  if (/^grok-.*\[1m\]$/.test(v)) {
    return {
      status: 'rejected',
      rejectedReason: `\`${raw}\` is not a real model id — grok has no 1M variant. Use \`grok-4.6\`.`,
      suggestedModel: 'grok-4.6',
    };
  }
  return { status: 'unknown' };
}

// Stub user-settings-store so SessionCommandHandler's imports don't trigger real file I/O.
vi.mock('../../../user-settings-store', () => ({
  DEFAULT_SHOW_THINKING: false,
  DEFAULT_THINKING_ENABLED: false,
  MODEL_ALIASES: { opus: 'claude-opus-4-1-20250805', sonnet: 'claude-sonnet-4-20250514' },
  userSettingsStore: {
    getUserDefaultModel: vi.fn().mockReturnValue('claude-sonnet-4-20250514'),
    getModelDisplayName: vi.fn().mockReturnValue('Sonnet 4'),
    getUserDefaultEffort: vi.fn().mockReturnValue('high'),
    getUserDefaultLogVerbosity: vi.fn().mockReturnValue('detail'),
    getUserThinkingEnabled: vi.fn().mockReturnValue(false),
    getUserShowThinking: vi.fn().mockReturnValue(false),
    resolveModelInput: vi.fn((v: string) => (v === 'opus' ? 'claude-opus-4-1-20250805' : null)),
    resolveModelInputWithRefresh: vi.fn(async (v: string) => (v === 'opus' ? 'claude-opus-4-1-20250805' : null)),
    resolveModelInputDetailed: vi.fn((v: string) => resolveDetailedStub(v)),
    resolveModelInputDetailedWithRefresh: vi.fn(async (v: string) => resolveDetailedStub(v)),
    resolveVerbosityInput: vi.fn((v: string) => (['minimal', 'compact', 'detail', 'verbose'].includes(v) ? v : null)),
  },
}));

vi.mock('../../../utils/dir-size', () => ({
  formatBytes: vi.fn().mockReturnValue('0 B'),
  getDirSizeBytes: vi.fn().mockReturnValue(0),
}));

import { SessionCommandHandler } from '../session-command-handler';
import type { CommandContext, CommandDependencies } from '../types';

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
    session = { model: 'claude-sonnet-4-20250514', logVerbosity: 0b1111 };
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

    it('`%model <value>` immediately updates session.usage.contextWindow to the new model window', async () => {
      // Regression: after `%model sol` the session kept the OLD model's
      // contextWindow until the next turn's usage event, so `/context`
      // reported remaining space against the wrong denominator.
      session.usage = {
        currentInputTokens: 100,
        currentOutputTokens: 10,
        currentCacheReadTokens: 0,
        currentCacheCreateTokens: 0,
        contextWindow: 1_000_000, // stale window from previous [1m] model
        totalInputTokens: 100,
        totalOutputTokens: 10,
        totalCacheReadTokens: 0,
        totalCacheCreateTokens: 0,
        totalCostUsd: 0.01,
        lastUpdated: Date.now(),
      };

      const ctx = makeCtx('%model opus');
      await handler.execute(ctx);

      // Mocked resolveModelInput('opus') → 'claude-opus-4-1-20250805' (bare id,
      // no [1m] suffix) → resolveContextWindow = 200k fallback, not 1M.
      expect((session.usage as { contextWindow: number }).contextWindow).toBe(200_000);
    });

    it('emits deprecation notice for bare `$` → info', async () => {
      const ctx = makeCtx('$');
      await handler.execute(ctx);

      const firstCall = (ctx.say as any).mock.calls[0][0];
      expect(firstCall.text).toContain('더 이상 사용되지 않습니다');
      expect(firstCall.text).toContain('`%`');
    });
  });

  describe('session-only model set — fake grok [1m] rejection', () => {
    it('rejects `%model grok-4.6[1m]` visibly and suggests bare grok-4.6', async () => {
      const ctx = makeCtx('%model grok-4.6[1m]');
      await handler.execute(ctx);

      const texts = (ctx.say as any).mock.calls.map((c: any[]) => c[0].text as string);
      const joined = texts.join('\n');
      expect(joined).toContain('grok-4.6[1m]');
      expect(joined).toMatch(/use `grok-4\.6`/i);
      // Not the generic typo path — that dump reads as "you misspelled it".
      expect(joined).not.toContain('Unknown model');
      expect(joined).not.toContain('Session Model Changed');
    });

    it('does not mutate session.model on a rejected id', async () => {
      const ctx = makeCtx('%model grok-4.6[1m]');
      await handler.execute(ctx);
      expect(session.model).toBe('claude-sonnet-4-20250514');
    });

    it('still reports an ordinary typo as an unknown model', async () => {
      const ctx = makeCtx('%model opuss');
      await handler.execute(ctx);
      const joined = (ctx.say as any).mock.calls.map((c: any[]) => c[0].text as string).join('\n');
      expect(joined).toContain('Unknown model');
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
