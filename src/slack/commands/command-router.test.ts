import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../user-settings-store', () => ({
  userSettingsStore: {
    markMigrationHintShown: vi.fn().mockResolvedValue(false),
  },
}));

vi.mock('../../metrics', () => ({
  getReportDeps: () => ({
    claudeMetricsStore: {
      getUserStats: vi.fn(),
      getDailyStats: vi.fn(),
      getMonthlyStats: vi.fn(),
    },
    userSettingsStore: {
      getUserModel: vi.fn(),
    },
    tokenFormatter: { format: (n: number) => String(n) },
  }),
}));

import { CommandRouter } from './command-router';
import { PersonaHandler } from './persona-handler';

/**
 * Regression guard (PR #509, codex P1): after stripping the `/z` prefix and
 * rewriting `ctx.text` via `translateToLegacy()`, the dispatch loop must
 * consult the rewritten text — not the locally destructured copy — so the
 * intended handler actually runs.
 *
 * Bug: `/z persona linus` arriving via DM/app_mention was falling through as
 * unhandled because `canHandle(text)` saw the original `/z persona linus`
 * string instead of the translated `persona linus`.
 */
describe('CommandRouter — /z → translated text is routed to handler', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('`/z persona set linus` reaches PersonaHandler with translated text', async () => {
    const canHandleSpy = vi.spyOn(PersonaHandler.prototype, 'canHandle');
    const executeSpy = vi.spyOn(PersonaHandler.prototype, 'execute').mockResolvedValue({ handled: true });

    const say = vi.fn().mockResolvedValue(undefined);
    const deps: any = {
      workingDirManager: {
        parseSetCommand: vi.fn().mockReturnValue(null),
        isGetCommand: vi.fn().mockReturnValue(false),
      },
      mcpManager: { getPluginManager: vi.fn() },
      claudeHandler: {},
      sessionUiManager: {},
      requestCoordinator: {},
      slackApi: {},
      reactionManager: {},
      contextWindowManager: {},
    };
    const router = new CommandRouter(deps);
    const ctx: any = {
      text: '/z persona set linus',
      user: 'U1',
      channel: 'C1',
      threadTs: 'T1', // thread context (not slash surface)
      say,
    };

    const result = await router.route(ctx);

    // PersonaHandler was considered with the translated text
    const personaCalls = canHandleSpy.mock.calls.filter((args) => /persona/.test(args[0] ?? ''));
    expect(personaCalls.length).toBeGreaterThan(0);
    for (const call of personaCalls) {
      expect(call[0]).not.toContain('/z');
      expect(call[0]).toBe('persona set linus');
    }
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(result.handled).toBe(true);

    // ctx.text is left in the rewritten form for downstream handlers
    expect(ctx.text).toBe('persona set linus');
  });
});
