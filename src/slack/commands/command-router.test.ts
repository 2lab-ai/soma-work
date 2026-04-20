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

import { userSettingsStore } from '../../user-settings-store';
import { BypassHandler } from './bypass-handler';
import { CommandRouter } from './command-router';
import { EffortHandler } from './effort-handler';
import { EmailHandler } from './email-handler';
import { ModelHandler } from './model-handler';
import { PersonaHandler } from './persona-handler';
import { PromptHandler } from './prompt-handler';
import { RateHandler } from './rate-handler';
import { VerbosityHandler } from './verbosity-handler';

/**
 * Default command-router deps — handlers need these present on construction.
 * Individual tests override workingDirManager / slackApi as needed.
 */
function buildDeps(overrides: Record<string, any> = {}): any {
  return {
    workingDirManager: {
      parseSetCommand: vi.fn().mockReturnValue(null),
      isGetCommand: vi.fn().mockReturnValue(false),
      getWorkingDirectory: vi.fn().mockReturnValue('/tmp/default'),
      formatDirectoryMessage: vi.fn().mockReturnValue('📁 /tmp/default'),
    },
    mcpManager: { getPluginManager: vi.fn() },
    claudeHandler: {
      getSession: vi.fn().mockReturnValue(null),
    },
    sessionUiManager: {},
    requestCoordinator: {},
    slackApi: {
      postSystemMessage: vi.fn().mockResolvedValue(undefined),
      getClient: vi.fn().mockReturnValue({}),
    },
    reactionManager: {},
    contextWindowManager: {},
    ...overrides,
  };
}

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
    const deps = buildDeps();
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
    const personaCalls = canHandleSpy.mock.calls.filter((args: any[]) => /persona/.test(args[0] ?? ''));
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

/**
 * Issue #530: PR #509 introduced Phase 1 tombstone gates that blocked bare
 * canonical commands like `model opus-4.7`, `verbosity detail`, etc. in
 * thread/app_mention surfaces. These gates were removed so handlers match
 * bare `[cmd] [args]` input directly again (pre-#509 behavior restored).
 */
describe('CommandRouter — bare [cmd] [args] routing (restored #530)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  async function runBare(text: string): Promise<{ result: any; ctx: any; say: any }> {
    const say = vi.fn().mockResolvedValue(undefined);
    const deps = buildDeps();
    const router = new CommandRouter(deps);
    const ctx: any = {
      text,
      user: 'U1',
      channel: 'C1',
      threadTs: 'T1',
      say,
    };
    const result = await router.route(ctx);
    return { result, ctx, say };
  }

  it('bare "model opus-4.7" → ModelHandler.execute called', async () => {
    const executeSpy = vi.spyOn(ModelHandler.prototype, 'execute').mockResolvedValue({ handled: true });
    const { result } = await runBare('model opus-4.7');
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(result.handled).toBe(true);
  });

  it('bare "verbosity detail" → VerbosityHandler.execute called', async () => {
    const executeSpy = vi.spyOn(VerbosityHandler.prototype, 'execute').mockResolvedValue({ handled: true });
    const { result } = await runBare('verbosity detail');
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(result.handled).toBe(true);
  });

  it('bare "persona set elon" → PersonaHandler.execute called', async () => {
    const executeSpy = vi.spyOn(PersonaHandler.prototype, 'execute').mockResolvedValue({ handled: true });
    const { result } = await runBare('persona set elon');
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(result.handled).toBe(true);
  });

  it('bare "bypass on" → BypassHandler.execute called', async () => {
    const executeSpy = vi.spyOn(BypassHandler.prototype, 'execute').mockResolvedValue({ handled: true });
    const { result } = await runBare('bypass on');
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(result.handled).toBe(true);
  });

  it('bare "show email" → EmailHandler.execute called', async () => {
    const executeSpy = vi.spyOn(EmailHandler.prototype, 'execute').mockResolvedValue({ handled: true });
    const { result } = await runBare('show email');
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(result.handled).toBe(true);
  });

  it('bare "set email user@example.com" → EmailHandler.execute called', async () => {
    const executeSpy = vi.spyOn(EmailHandler.prototype, 'execute').mockResolvedValue({ handled: true });
    const { result } = await runBare('set email user@example.com');
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(result.handled).toBe(true);
  });

  it('bare "show prompt" → PromptHandler.execute called', async () => {
    const executeSpy = vi.spyOn(PromptHandler.prototype, 'execute').mockResolvedValue({ handled: true });
    const { result } = await runBare('show prompt');
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(result.handled).toBe(true);
  });

});

/**
 * Issue #530: cwd is a special case — Phase 2 (#507) renders a Block Kit card
 * via `renderCwdCard` + `slackApi.postSystemMessage`. Set-path commands
 * (`set directory <p>`, `cwd <p>`) post a plain "비활성화" notice.
 */
describe('CommandRouter — cwd bare routing (restored #530)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('bare "cwd" → CwdHandler.execute → renderCwdCard Block Kit card posted', async () => {
    const postSystemMessage = vi.fn().mockResolvedValue(undefined);
    const deps = buildDeps({
      workingDirManager: {
        parseSetCommand: vi.fn().mockReturnValue(null),
        isGetCommand: vi.fn().mockImplementation((t: string) => t.trim() === 'cwd'),
        getWorkingDirectory: vi.fn().mockReturnValue('/tmp/user1'),
        formatDirectoryMessage: vi.fn().mockReturnValue('📁 /tmp/user1'),
      },
      slackApi: {
        postSystemMessage,
        getClient: vi.fn().mockReturnValue({}),
      },
    });
    const router = new CommandRouter(deps);
    const ctx: any = {
      text: 'cwd',
      user: 'U1',
      channel: 'C1',
      threadTs: 'T1',
      say: vi.fn().mockResolvedValue(undefined),
    };

    const result = await router.route(ctx);

    expect(result.handled).toBe(true);
    expect(postSystemMessage).toHaveBeenCalledTimes(1);
    const [channelArg, , optsArg] = postSystemMessage.mock.calls[0];
    expect(channelArg).toBe('C1');
    expect(optsArg).toEqual(expect.objectContaining({ blocks: expect.any(Array) }));
  });

  it('bare "set directory /tmp" → CwdHandler.execute → "비활성화" postSystemMessage', async () => {
    const postSystemMessage = vi.fn().mockResolvedValue(undefined);
    const deps = buildDeps({
      workingDirManager: {
        parseSetCommand: vi.fn().mockImplementation((t: string) => (t.includes('/tmp') ? '/tmp' : null)),
        isGetCommand: vi.fn().mockReturnValue(false),
        getWorkingDirectory: vi.fn().mockReturnValue('/tmp/user1'),
        formatDirectoryMessage: vi.fn().mockReturnValue('📁 /tmp/user1'),
      },
      slackApi: {
        postSystemMessage,
        getClient: vi.fn().mockReturnValue({}),
      },
    });
    const router = new CommandRouter(deps);
    const ctx: any = {
      text: 'set directory /tmp',
      user: 'U1',
      channel: 'C1',
      threadTs: 'T1',
      say: vi.fn().mockResolvedValue(undefined),
    };

    const result = await router.route(ctx);

    expect(result.handled).toBe(true);
    expect(postSystemMessage).toHaveBeenCalledTimes(1);
    const [, textArg] = postSystemMessage.mock.calls[0];
    expect(textArg).toContain('비활성화되었습니다');
  });

  it('bare "cwd /tmp" → CwdHandler.execute → "비활성화" postSystemMessage', async () => {
    const postSystemMessage = vi.fn().mockResolvedValue(undefined);
    const deps = buildDeps({
      workingDirManager: {
        parseSetCommand: vi.fn().mockImplementation((t: string) => (t.includes('/tmp') ? '/tmp' : null)),
        isGetCommand: vi.fn().mockReturnValue(false),
        getWorkingDirectory: vi.fn().mockReturnValue('/tmp/user1'),
        formatDirectoryMessage: vi.fn().mockReturnValue('📁 /tmp/user1'),
      },
      slackApi: {
        postSystemMessage,
        getClient: vi.fn().mockReturnValue({}),
      },
    });
    const router = new CommandRouter(deps);
    const ctx: any = {
      text: 'cwd /tmp',
      user: 'U1',
      channel: 'C1',
      threadTs: 'T1',
      say: vi.fn().mockResolvedValue(undefined),
    };

    const result = await router.route(ctx);

    expect(result.handled).toBe(true);
    expect(postSystemMessage).toHaveBeenCalledTimes(1);
    const [, textArg] = postSystemMessage.mock.calls[0];
    expect(textArg).toContain('비활성화');
  });
});

/**
 * Issue #530: `effort` and `rate` have always been canonical bare-routable.
 * Locked in here so the tombstone-removal change does not regress them.
 */
describe('CommandRouter — effort/rate regression guard (already canonical)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  async function runBare(text: string): Promise<{ result: any }> {
    const say = vi.fn().mockResolvedValue(undefined);
    const deps = buildDeps();
    const router = new CommandRouter(deps);
    const ctx: any = {
      text,
      user: 'U1',
      channel: 'C1',
      threadTs: 'T1',
      say,
    };
    const result = await router.route(ctx);
    return { result };
  }

  it('bare "effort high" → EffortHandler.execute called', async () => {
    const executeSpy = vi.spyOn(EffortHandler.prototype, 'execute').mockResolvedValue({ handled: true });
    const { result } = await runBare('effort high');
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(result.handled).toBe(true);
  });

  it('bare "rate" → RateHandler.execute called', async () => {
    const executeSpy = vi.spyOn(RateHandler.prototype, 'execute').mockResolvedValue({ handled: true });
    const { result } = await runBare('rate');
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(result.handled).toBe(true);
  });
});

/**
 * Issue #530: retired / non-canonical bare forms must fall through as
 * `handled: false` — NO tombstone hint ("더 이상 사용되지 않습니다") is ever
 * emitted from the router, and `markMigrationHintShown` is not called.
 */
describe('CommandRouter — non-canonical bare input falls through (no tombstone #530)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(userSettingsStore.markMigrationHintShown).mockClear();
  });

  async function assertFallsThrough(text: string): Promise<void> {
    const say = vi.fn().mockResolvedValue(undefined);
    const deps = buildDeps();
    const router = new CommandRouter(deps);
    const ctx: any = {
      text,
      user: 'U1',
      channel: 'C1',
      threadTs: 'T1',
      say,
    };

    const result = await router.route(ctx);

    // 1. Handled must be false (no tombstone short-circuit).
    expect(result.handled).toBe(false);
    // 2. markMigrationHintShown must NOT be called — the gate was removed.
    expect(userSettingsStore.markMigrationHintShown).not.toHaveBeenCalled();
    // 3. `say` must NOT emit the tombstone hint text.
    for (const call of say.mock.calls) {
      const payload = call[0] as { text?: string };
      expect(payload?.text ?? '').not.toContain('더 이상 사용되지 않습니다');
    }
  }

  it('bare "commands" (retired) falls through', async () => {
    await assertFallsThrough('commands');
  });

  it('bare "prompt" (non-canonical) falls through', async () => {
    await assertFallsThrough('prompt');
  });

  it('bare "플러그인 업데이트" (Korean retired alias) falls through', async () => {
    await assertFallsThrough('플러그인 업데이트');
  });

  it('bare "nextcct" (retired) falls through', async () => {
    await assertFallsThrough('nextcct');
  });

  it('bare "servers" (retired) falls through', async () => {
    await assertFallsThrough('servers');
  });

  it('bare "credentials" (retired) falls through', async () => {
    await assertFallsThrough('credentials');
  });

  it('bare "persona clear" (not parser-supported) falls through', async () => {
    await assertFallsThrough('persona clear');
  });

  it('bare "verbosity set detail" (not parser-supported) falls through', async () => {
    await assertFallsThrough('verbosity set detail');
  });
});
