import * as fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../user-settings-store', () => ({
  userSettingsStore: {
    markMigrationHintShown: vi.fn().mockResolvedValue(false),
  },
}));

vi.mock('../../../metrics', () => ({
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

// Needed by the `new` + `$skill` composition tests: the preprocessor runs
// `SkillForceHandler.canHandle()` on the remainder, which probes the on-disk
// `local/skills/{skill}/SKILL.md` path. We stub `fs.existsSync` /
// `fs.readFileSync` so the tests don't depend on repo layout.
vi.mock('node:fs');

// env-paths / path-utils are only consulted for non-local ($stv:…, $user:…)
// references in the composition path. Keep them aligned with
// skill-force-handler.test.ts so recursion paths resolve predictably.
// NOTE: other modules loaded by command-router (e.g. llm-chat-config-store)
// read `CONFIG_FILE` / `ENV_FILE` / … at import time, so we MUST keep the
// real exports and only override what we need.
vi.mock('../../../env-paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../env-paths')>();
  return {
    ...actual,
    PLUGINS_DIR: '/mock/plugins',
    DATA_DIR: '/mock/data',
  };
});
vi.mock('../../../path-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../path-utils')>();
  return {
    ...actual,
    isSafePathSegment: (s: string) => !!s && !s.includes('/') && !s.includes('..'),
  };
});

import { userSettingsStore } from '../../../user-settings-store';
import { BypassHandler } from '../bypass-handler';
import { CommandRouter } from '../command-router';
import { EffortHandler } from '../effort-handler';
import { EmailHandler } from '../email-handler';
import { GoalHandler } from '../goal-handler';
import { HelpHandler } from '../help-handler';
import { ModelHandler } from '../model-handler';
import { NewHandler } from '../new-handler';
import { PersonaHandler } from '../persona-handler';
import { PromptHandler } from '../prompt-handler';
import { RateHandler } from '../rate-handler';
import { RenewHandler } from '../renew-handler';
import { SkillForceHandler } from '../skill-force-handler';
import { VerbosityHandler } from '../verbosity-handler';

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
      // NewHandler touches these during session reset; keep them as safe stubs
      // so any test that traverses the `new` preprocessor doesn't blow up.
      getSessionKey: vi.fn().mockImplementation((c: string, t: string) => `${c}:${t}`),
      resetSessionContext: vi.fn().mockReturnValue(false),
    },
    sessionUiManager: {},
    requestCoordinator: {
      isRequestActive: vi.fn().mockReturnValue(false),
    },
    slackApi: {
      postSystemMessage: vi.fn().mockResolvedValue(undefined),
      getClient: vi.fn().mockReturnValue({}),
      removeReaction: vi.fn().mockResolvedValue(undefined),
    },
    reactionManager: {
      getOriginalMessage: vi.fn().mockReturnValue(null),
      getCurrentReaction: vi.fn().mockReturnValue(null),
      cleanup: vi.fn(),
    },
    contextWindowManager: {
      cleanupWithReaction: vi.fn().mockResolvedValue(undefined),
    },
    userSettingsStore: {
      // GoalHandler.setGoal resolves the per-user max-continuation default (S4).
      getUserGoalMaxContinuations: vi.fn().mockReturnValue(undefined),
      setUserGoalMaxContinuations: vi.fn(),
      getUserAutoGoalEnabled: vi.fn().mockReturnValue(false),
      setUserAutoGoalEnabled: vi.fn(),
      toggleUserAutoGoalEnabled: vi.fn().mockReturnValue(true),
    },
    ...overrides,
  };
}

/**
 * Stub filesystem so SkillForceHandler sees a well-known skill layout.
 * Shared by the `new`/`goal` composition and `new` re-route describe blocks.
 */
function stubSkillFs(options: { localSkills?: string[]; pluginSkills?: Record<string, string[]> } = {}): void {
  const localSkills = new Set(options.localSkills ?? ['z']);
  const pluginSkills = new Map<string, Set<string>>();
  for (const [plugin, skills] of Object.entries(options.pluginSkills ?? {})) {
    pluginSkills.set(plugin, new Set(skills));
  }
  vi.mocked(fs.existsSync).mockImplementation((p) => {
    const s = String(p);
    // Local skill layout: .../local/skills/{skill}/SKILL.md
    const localMatch = s.match(/local\/skills\/([\w-]+)\/SKILL\.md$/);
    if (localMatch) return localSkills.has(localMatch[1]);
    // Plugin skill layout: /mock/plugins/{plugin}/skills/{skill}/SKILL.md
    const pluginMatch = s.match(/\/mock\/plugins\/([\w-]+)\/skills\/([\w-]+)\/SKILL\.md$/);
    if (pluginMatch) return pluginSkills.get(pluginMatch[1])?.has(pluginMatch[2]) ?? false;
    return false;
  });
  vi.mocked(fs.readFileSync).mockImplementation((p) => {
    const s = String(p);
    const localMatch = s.match(/local\/skills\/([\w-]+)\/SKILL\.md$/);
    if (localMatch) return `# ${localMatch[1]} skill body\nDo the ${localMatch[1]} thing.`;
    const pluginMatch = s.match(/\/mock\/plugins\/([\w-]+)\/skills\/([\w-]+)\/SKILL\.md$/);
    if (pluginMatch) return `# ${pluginMatch[1]}:${pluginMatch[2]} skill body\nDo it.`;
    return '';
  });
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

  it('`/z goal set ...` reaches GoalHandler with translated text', async () => {
    const executeSpy = vi.spyOn(GoalHandler.prototype, 'execute').mockResolvedValue({ handled: true });

    const say = vi.fn().mockResolvedValue(undefined);
    const deps = buildDeps();
    const router = new CommandRouter(deps);
    const ctx: any = {
      text: '/z goal set ship the feature',
      user: 'U1',
      channel: 'C1',
      threadTs: 'T1',
      say,
    };

    const result = await router.route(ctx);

    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(ctx.text).toBe('goal set ship the feature');
    expect(result.handled).toBe(true);
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

/**
 * Bug fix: when a Slack message starts with `new` (session reset) AND contains
 * a `$skill` force trigger anywhere in the same message, `SkillForceHandler`
 * used to win the first-match-wins loop and `NewHandler` never ran — so the
 * session silently was NOT reset. Conversely, merely reordering the handlers
 * would not help: `continueWithPrompt` from `NewHandler` is delivered as plain
 * text to Claude (slack-handler.ts: effectiveText path), so `$z` in the
 * remainder would never get resolved into an `<invoked_skills>` block.
 *
 * Fix: `new`/`/new` is promoted to a preprocessor (mirroring the `/z` prefix
 * pattern). It runs session reset FIRST, then RE-ROUTES the remainder through
 * the full router as if the user had typed it directly after the reset.
 *
 * Contract widening (`new goal …` bug): the original narrow-scope contract
 * only composed `$skill` remainders and delivered every other command-shaped
 * remainder (goal / help / new / …) to Claude as a plain prompt — so
 * `new goal <objective>` reset the session but silently dropped the `goal`
 * command. The remainder is now recursively re-routed: `new goal X` sets the
 * goal, `new new X` resets twice, `new help` shows the help card. Plain-text
 * remainders still fall through to Claude unchanged.
 */
describe('CommandRouter — `new` + `$skill` composition (preprocessor)', () => {
  function makeRouter(depsOverrides: Record<string, any> = {}): {
    router: CommandRouter;
    deps: any;
    say: ReturnType<typeof vi.fn>;
  } {
    const say = vi.fn().mockResolvedValue(undefined);
    const deps = buildDeps(depsOverrides);
    const router = new CommandRouter(deps);
    return { router, deps, say };
  }

  function makeCtx(text: string, say: ReturnType<typeof vi.fn>): any {
    return {
      text,
      user: 'U1',
      channel: 'C1',
      threadTs: 'T1',
      say,
    };
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(userSettingsStore.markMigrationHintShown).mockClear();
  });

  it('1. `new $z foo` → NewHandler runs AND SkillForce injects <invoked_skills>', async () => {
    stubSkillFs({ localSkills: ['z'] });
    const newExec = vi.spyOn(NewHandler.prototype, 'execute');
    const skillExec = vi.spyOn(SkillForceHandler.prototype, 'execute');

    const { router, say } = makeRouter();
    const result = await router.route(makeCtx('new $z foo', say));

    expect(newExec).toHaveBeenCalledTimes(1);
    expect(skillExec).toHaveBeenCalledTimes(1);
    expect(result.handled).toBe(true);
    expect(result.continueWithPrompt).toBeDefined();
    // Remainder after `new` is "$z foo" — that's what SkillForce sees.
    expect(result.continueWithPrompt?.startsWith('$z foo')).toBe(true);
    expect(result.continueWithPrompt).toContain('<invoked_skills>');
    expect(result.continueWithPrompt).toContain('<local:z>');
    expect(result.continueWithPrompt).toContain('</local:z>');
  });

  it('2. `/new $z foo` (slash variant) → same composition', async () => {
    stubSkillFs({ localSkills: ['z'] });
    const newExec = vi.spyOn(NewHandler.prototype, 'execute');
    const skillExec = vi.spyOn(SkillForceHandler.prototype, 'execute');

    const { router, say } = makeRouter();
    const result = await router.route(makeCtx('/new $z foo', say));

    expect(newExec).toHaveBeenCalledTimes(1);
    expect(skillExec).toHaveBeenCalledTimes(1);
    expect(result.handled).toBe(true);
    expect(result.continueWithPrompt?.startsWith('$z foo')).toBe(true);
    expect(result.continueWithPrompt).toContain('<local:z>');
  });

  it('3. `/z new $z foo` via full route() (stripZPrefix + translateToLegacy path)', async () => {
    stubSkillFs({ localSkills: ['z'] });
    const newExec = vi.spyOn(NewHandler.prototype, 'execute');
    const skillExec = vi.spyOn(SkillForceHandler.prototype, 'execute');

    const { router, say } = makeRouter();
    const result = await router.route(makeCtx('/z new $z foo', say));

    // /z is stripped to "new $z foo", translateToLegacy passes through unchanged
    // for `new …`, preprocessor then fires for the translated form.
    expect(newExec).toHaveBeenCalledTimes(1);
    expect(skillExec).toHaveBeenCalledTimes(1);
    expect(result.handled).toBe(true);
    expect(result.continueWithPrompt?.startsWith('$z foo')).toBe(true);
    expect(result.continueWithPrompt).toContain('<local:z>');
  });

  it('4. `new $stv:new-task implement X` → plugin skill is injected', async () => {
    stubSkillFs({ localSkills: [], pluginSkills: { stv: ['new-task'] } });
    const skillExec = vi.spyOn(SkillForceHandler.prototype, 'execute');

    const { router, say } = makeRouter();
    const result = await router.route(makeCtx('new $stv:new-task implement X', say));

    expect(skillExec).toHaveBeenCalledTimes(1);
    expect(result.handled).toBe(true);
    expect(result.continueWithPrompt?.startsWith('$stv:new-task implement X')).toBe(true);
    expect(result.continueWithPrompt).toContain('<stv:new-task>');
    expect(result.continueWithPrompt).toContain('</stv:new-task>');
  });

  it('5. `new write a function` (no $skill) → plain remainder prompt, no SkillForce run', async () => {
    stubSkillFs({ localSkills: ['z'] });
    const newExec = vi.spyOn(NewHandler.prototype, 'execute');
    const skillExec = vi.spyOn(SkillForceHandler.prototype, 'execute');

    const { router, say } = makeRouter();
    const result = await router.route(makeCtx('new write a function', say));

    expect(newExec).toHaveBeenCalledTimes(1);
    expect(skillExec).not.toHaveBeenCalled();
    expect(result.handled).toBe(true);
    expect(result.continueWithPrompt).toBe('write a function');
  });

  it('6. `new help` → remainder re-routed as a command: HelpHandler IS executed (contract widened)', async () => {
    stubSkillFs({ localSkills: ['z'] });
    const helpExec = vi.spyOn(HelpHandler.prototype, 'execute');
    const skillExec = vi.spyOn(SkillForceHandler.prototype, 'execute');

    const { router, say } = makeRouter();
    const result = await router.route(makeCtx('new help', say));

    // The remainder is treated exactly as if the user had typed `help`
    // directly after the reset — the help card is posted, nothing is
    // forwarded to the model.
    expect(helpExec).toHaveBeenCalledTimes(1);
    expect(skillExec).not.toHaveBeenCalled();
    expect(result.handled).toBe(true);
    expect(result.continueWithPrompt).toBeUndefined();
  });

  it('7. bare `new` → handled:true, continueWithPrompt undefined, SkillForce NOT run', async () => {
    stubSkillFs({ localSkills: ['z'] });
    const skillExec = vi.spyOn(SkillForceHandler.prototype, 'execute');

    const { router, say } = makeRouter();
    const result = await router.route(makeCtx('new', say));

    expect(skillExec).not.toHaveBeenCalled();
    expect(result.handled).toBe(true);
    expect(result.continueWithPrompt).toBeUndefined();
  });

  it('8. `$z foo` (no `new`) → NewHandler NOT called, SkillForce matches via normal loop', async () => {
    stubSkillFs({ localSkills: ['z'] });
    const newExec = vi.spyOn(NewHandler.prototype, 'execute');
    const skillExec = vi.spyOn(SkillForceHandler.prototype, 'execute');

    const { router, say } = makeRouter();
    const result = await router.route(makeCtx('$z foo', say));

    expect(newExec).not.toHaveBeenCalled();
    expect(skillExec).toHaveBeenCalledTimes(1);
    expect(result.handled).toBe(true);
    expect(result.continueWithPrompt).toContain('<local:z>');
  });

  it('9. active request + `new $z foo` → race guard fires, SkillForce NOT invoked', async () => {
    stubSkillFs({ localSkills: ['z'] });
    const postSystemMessage = vi.fn().mockResolvedValue(undefined);
    const { router, say } = makeRouter({
      slackApi: {
        postSystemMessage,
        getClient: vi.fn().mockReturnValue({}),
        removeReaction: vi.fn().mockResolvedValue(undefined),
      },
      requestCoordinator: {
        isRequestActive: vi.fn().mockReturnValue(true),
      },
    });
    const skillExec = vi.spyOn(SkillForceHandler.prototype, 'execute');

    const result = await router.route(makeCtx('new $z foo', say));

    // Race guard surfaces the warning and short-circuits: no skill force invocation.
    expect(postSystemMessage).toHaveBeenCalled();
    const warningCall = postSystemMessage.mock.calls.find((c: any[]) => String(c[1] ?? '').includes('in progress'));
    expect(warningCall).toBeDefined();
    expect(skillExec).not.toHaveBeenCalled();
    expect(result.handled).toBe(true);
    expect(result.continueWithPrompt).toBeUndefined();
  });

  it('10. multi-line `new <URL>\\n$z proceed` → session reset + <invoked_skills> AND URL preserved in remainder', async () => {
    stubSkillFs({ localSkills: ['z'] });
    const newExec = vi.spyOn(NewHandler.prototype, 'execute');
    const skillExec = vi.spyOn(SkillForceHandler.prototype, 'execute');

    const { router, say } = makeRouter();
    const text = 'new https://github.com/foo/bar\n$z proceed';
    const result = await router.route(makeCtx(text, say));

    expect(newExec).toHaveBeenCalledTimes(1);
    expect(skillExec).toHaveBeenCalledTimes(1);
    expect(result.handled).toBe(true);
    expect(result.continueWithPrompt).toContain('https://github.com/foo/bar');
    expect(result.continueWithPrompt).toContain('$z proceed');
    expect(result.continueWithPrompt).toContain('<invoked_skills>');
    expect(result.continueWithPrompt).toContain('<local:z>');
  });
});

/**
 * `goal` + `$skill` composition (preprocessor).
 *
 * Bug: when a message starts with `goal set <objective>` AND contains a
 * `$skill` force trigger (e.g. `goal set ship X\n$z proceed`), the
 * first-match-wins handler loop lets `SkillForceHandler` match the bare
 * `$z` and return `handled:true`, so `GoalHandler` never runs and the
 * session goal is silently NOT set. Reordering the handler list alone
 * does not help: the user wants BOTH side effects (goal set AND skill
 * invoked), so we need the same preprocessor pattern that `new` uses for
 * `new $z foo`.
 *
 * The preprocessor must split at the first `$skill` token so:
 *   - `session.goal.objective` is the CLEAN prefix (no `$z proceed` text
 *     leaking into the persisted-and-re-injected goal block).
 *   - The `<invoked_skills>` block reaches Claude on the same turn.
 */
describe('CommandRouter — `goal` + `$skill` composition (preprocessor)', () => {
  function makeCtx(
    text: string,
    say: ReturnType<typeof vi.fn>,
    session: { goal?: any; systemPrompt?: string } | undefined = { systemPrompt: 'cached' },
  ): any {
    return {
      text,
      user: 'U1',
      channel: 'C1',
      threadTs: 'T1',
      say,
      _testSession: session,
    };
  }

  function makeRouterWithSession(): {
    router: CommandRouter;
    deps: any;
    say: ReturnType<typeof vi.fn>;
    session: { goal?: any; systemPrompt?: string };
  } {
    const say = vi.fn().mockResolvedValue(undefined);
    const session: { goal?: any; systemPrompt?: string } = { systemPrompt: 'cached' };
    const deps = buildDeps({
      claudeHandler: {
        getSession: vi.fn().mockReturnValue(session),
        getSessionKey: vi.fn().mockImplementation((c: string, t: string) => `${c}:${t}`),
        resetSessionContext: vi.fn().mockReturnValue(false),
        saveSessions: vi.fn(),
      },
    });
    const router = new CommandRouter(deps);
    return { router, deps, say, session };
  }

  function makeRouterWithoutSession(): {
    router: CommandRouter;
    deps: any;
    say: ReturnType<typeof vi.fn>;
  } {
    const say = vi.fn().mockResolvedValue(undefined);
    const deps = buildDeps({
      claudeHandler: {
        getSession: vi.fn().mockReturnValue(null),
        getSessionKey: vi.fn().mockImplementation((c: string, t: string) => `${c}:${t}`),
        resetSessionContext: vi.fn().mockReturnValue(false),
        saveSessions: vi.fn(),
      },
    });
    const router = new CommandRouter(deps);
    return { router, deps, say };
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('1. `goal set ship the feature $z proceed` → goal IS set with CLEAN objective AND <invoked_skills> injected', async () => {
    stubSkillFs({ localSkills: ['z'] });
    const skillExec = vi.spyOn(SkillForceHandler.prototype, 'execute');

    const { router, say, session } = makeRouterWithSession();
    const result = await router.route(makeCtx('goal set ship the feature $z proceed', say));

    // Goal was persisted — bug fix verified.
    expect(session.goal).toBeDefined();
    expect(session.goal.objective).toBe('ship the feature');
    expect(session.goal.status).toBe('active');
    expect(session.systemPrompt).toBeUndefined();

    // Skill was force-invoked on the suffix only.
    expect(skillExec).toHaveBeenCalledTimes(1);
    const skillCallText = skillExec.mock.calls[0][0].text;
    expect(skillCallText).toBe('$z proceed');

    // Final continuation carries the skill block (skillResult supersedes goalResult).
    expect(result.handled).toBe(true);
    expect(result.continueWithPrompt).toContain('<invoked_skills>');
    expect(result.continueWithPrompt).toContain('<local:z>');
    expect(result.continueWithPrompt).toContain('$z proceed');
    // CRITICAL: the durable goal objective must NOT leak `$z proceed` into
    // future system-prompt rebuilds.
    expect(session.goal.objective).not.toContain('$z');
    expect(session.goal.objective).not.toContain('proceed');
  });

  it('2. multi-line `goal set ship X\\n$z proceed` → same composition (newline split)', async () => {
    stubSkillFs({ localSkills: ['z'] });
    const { router, say, session } = makeRouterWithSession();

    const result = await router.route(makeCtx('goal set ship X\n$z proceed', say));

    expect(session.goal?.objective).toBe('ship X');
    expect(result.continueWithPrompt).toContain('<local:z>');
    expect(result.continueWithPrompt).toContain('$z proceed');
  });

  it('3. shorthand `goal ship X $z proceed` (no `set`) → goal set + skill invoked', async () => {
    // `parseGoalCommand` treats unrecognized rest as `{action:'set', objective:rest}`.
    // The preprocessor must hand only the clean prefix "goal ship X" to GoalHandler.
    stubSkillFs({ localSkills: ['z'] });
    const { router, say, session } = makeRouterWithSession();

    const result = await router.route(makeCtx('goal ship X $z proceed', say));

    expect(session.goal?.objective).toBe('ship X');
    expect(result.continueWithPrompt).toContain('<local:z>');
  });

  it('4. `goal set X $stv:new-task implement Y` → plugin-qualified skill is split on the qualified token', async () => {
    stubSkillFs({ localSkills: [], pluginSkills: { stv: ['new-task'] } });
    const skillExec = vi.spyOn(SkillForceHandler.prototype, 'execute');

    const { router, say, session } = makeRouterWithSession();
    const result = await router.route(makeCtx('goal set ship X $stv:new-task implement Y', say));

    expect(session.goal?.objective).toBe('ship X');
    expect(skillExec).toHaveBeenCalledTimes(1);
    expect(skillExec.mock.calls[0][0].text).toBe('$stv:new-task implement Y');
    expect(result.continueWithPrompt).toContain('<stv:new-task>');
  });

  it('5. `goal set buy 5 items for $20` → `$20` does NOT resolve as a skill, falls through to normal goal flow', async () => {
    stubSkillFs({ localSkills: ['z'] });
    const skillExec = vi.spyOn(SkillForceHandler.prototype, 'execute');

    const { router, say, session } = makeRouterWithSession();
    const result = await router.route(makeCtx('goal set buy 5 items for $20', say));

    // `$20` is not a skill → no split, no SkillForce invocation.
    expect(skillExec).not.toHaveBeenCalled();
    // Goal is set with the full literal objective.
    expect(session.goal?.objective).toBe('buy 5 items for $20');
    expect(result.handled).toBe(true);
    expect(result.continueWithPrompt).toContain('Continue working toward the active session goal');
  });

  it('6. `goal set ship X $unknown_skill_name proceed` → no resolvable skill, falls through', async () => {
    stubSkillFs({ localSkills: ['z'] }); // unknown_skill_name is NOT in localSkills
    const skillExec = vi.spyOn(SkillForceHandler.prototype, 'execute');

    const { router, say, session } = makeRouterWithSession();
    const result = await router.route(makeCtx('goal set ship X $unknown_skill_name proceed', say));

    expect(skillExec).not.toHaveBeenCalled();
    // Whole text is objective (no clean split because no skill matched).
    expect(session.goal?.objective).toBe('ship X $unknown_skill_name proceed');
    expect(result.handled).toBe(true);
  });

  it('7. bare `goal` (status check) → unchanged, no SkillForce invoked', async () => {
    stubSkillFs({ localSkills: ['z'] });
    const skillExec = vi.spyOn(SkillForceHandler.prototype, 'execute');

    const { router, say, session } = makeRouterWithSession();
    session.goal = {
      objective: 'finish migration',
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
      createdBy: 'U1',
      continuationCount: 0,
      maxContinuations: 10,
    };

    const result = await router.route(makeCtx('goal', say));

    expect(skillExec).not.toHaveBeenCalled();
    expect(result.handled).toBe(true);
    // Status check returns no continuation.
    expect(result.continueWithPrompt).toBeUndefined();
  });

  it('8. `goal pause $z proceed` → lifecycle verb runs first, NO skill invocation (verb has no continuation)', async () => {
    stubSkillFs({ localSkills: ['z'] });
    const skillExec = vi.spyOn(SkillForceHandler.prototype, 'execute');

    const { router, say, session } = makeRouterWithSession();
    session.goal = {
      objective: 'finish migration',
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
      createdBy: 'U1',
      continuationCount: 0,
      maxContinuations: 10,
    };

    // `goal pause` does not produce a continueWithPrompt — splitting on the
    // skill token would route only "goal pause" to GoalHandler (no `$z`),
    // which still produces no continuation, and the preprocessor must NOT
    // then run SkillForce. Verifies the early-return guard.
    const result = await router.route(makeCtx('goal pause $z proceed', say));

    // `goal pause` (with no `$z` in the cleaned goalText) flips status to paused.
    expect(session.goal?.status).toBe('paused');
    expect(skillExec).not.toHaveBeenCalled();
    expect(result.handled).toBe(true);
    expect(result.continueWithPrompt).toBeUndefined();
  });

  // #1082 T1: with NO active session a `goal <objective> $skill` message
  // splits exactly like the session-active path — the clean objective is
  // carried out-of-band as `setGoalObjective` (the new session is born with
  // the goal active) and the `$skill` suffix becomes the model-turn text.
  // The old behavior (drop the goal, hand the FULL text to the skill) leaked
  // `goal …` phrasing into the prompt and silently lost the goal.
  it('9. `goal foo $skill` with NO active session → split: setGoalObjective carries clean objective, skill gets suffix only', async () => {
    stubSkillFs({ localSkills: ['using-ssot'] });
    const skillExec = vi.spyOn(SkillForceHandler.prototype, 'execute');

    const { router, deps, say } = makeRouterWithoutSession();
    const result = await router.route(makeCtx('goal 기능을 끝까지 완수해줘 $using-ssot', say, undefined));

    expect(deps.slackApi.postSystemMessage).not.toHaveBeenCalledWith(
      'C1',
      expect.stringContaining('No active session'),
      expect.anything(),
    );

    // Skill is force-invoked on the SUFFIX only — the goal prefix must not
    // leak into the skill prompt.
    expect(skillExec).toHaveBeenCalledTimes(1);
    expect(skillExec.mock.calls[0][0].text).toBe('$using-ssot');

    expect(result.handled).toBe(true);
    expect(result.continueWithPrompt).toContain('<invoked_skills>');
    expect(result.continueWithPrompt).toContain('<local:using-ssot>');
    // Clean objective rides out-of-band for the new session to adopt.
    expect(result.setGoalObjective).toBe('기능을 끝까지 완수해줘');
    expect(result.continueWithPrompt).not.toContain('기능을 끝까지 완수해줘');
  });

  // Counterpart: when the prefix before `$skill` does NOT parse as a goal-set
  // (bare `goal` → lifecycle/status form), there is no objective to carry —
  // the preprocessor must fall through to the old behavior (skill gets the
  // full text, no setGoalObjective).
  it("9b. `goal $skill foo` with NO session (prefix isn't a set form) → no setGoalObjective, skill gets full text", async () => {
    stubSkillFs({ localSkills: ['using-ssot'] });
    const skillExec = vi.spyOn(SkillForceHandler.prototype, 'execute');

    const { router, say } = makeRouterWithoutSession();
    const result = await router.route(makeCtx('goal $using-ssot proceed', say, undefined));

    expect(skillExec).toHaveBeenCalledTimes(1);
    expect(skillExec.mock.calls[0][0].text).toBe('goal $using-ssot proceed');
    expect(result.handled).toBe(true);
    expect(result.setGoalObjective).toBeUndefined();
    expect(result.continueWithPrompt).toContain('<local:using-ssot>');
  });

  // Intent-recovery guard (docs/goal-command/spec.md §No-Session Fall-Through):
  // a first message like `goal foo bar baz` with no session carries a free-form
  // objective, and "goal" is everyday English — it is almost certainly a task,
  // not a lifecycle command. The session-scoped reading is impossible anyway
  // (there is no session to attach a goal to). GoalHandler must NOT swallow it
  // with "No active session"; it returns unhandled so the router falls through
  // and slack-handler starts a fresh conversation with the user's full text.
  it('10. pure `goal foo …` with NO session and NO skill suffix → falls through (handled:false), no "No active session"', async () => {
    stubSkillFs({ localSkills: ['using-ssot'] }); // skill exists but not referenced
    const goalExec = vi.spyOn(GoalHandler.prototype, 'execute');

    const { router, deps, say } = makeRouterWithoutSession();
    const result = await router.route(makeCtx('goal foo bar baz', say, undefined));

    // GoalHandler is consulted, but returns unhandled rather than rejecting.
    expect(goalExec).toHaveBeenCalledTimes(1);
    expect(deps.slackApi.postSystemMessage).not.toHaveBeenCalledWith(
      'C1',
      expect.stringContaining('No active session'),
      expect.anything(),
    );
    // Router returns unhandled → slack-handler proceeds to session init with the
    // user's full text as the first prompt instead of dropping it.
    expect(result.handled).toBe(false);
    expect(result.continueWithPrompt).toBeUndefined();
    // #1082 T1: the objective rides out-of-band so the new session is born
    // with the goal already active.
    expect(result.setGoalObjective).toBe('foo bar baz');
    // And NO ❓ "unrecognized command" message leaks out — `isPotentialCommand`
    // must classify multi-word "goal …" as plain text, not a failed command.
    expect(say).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('인식할 수 없습니다') }),
    );
  });

  // Counterpart to test 10: a BARE `goal` (no free-form objective) with no
  // session is a genuine lifecycle command with nothing to act on, so it keeps
  // the explicit "No active session" hint.
  it('11. bare `goal` with NO session → goal handler still emits "No active session"', async () => {
    stubSkillFs({ localSkills: ['using-ssot'] });
    const goalExec = vi.spyOn(GoalHandler.prototype, 'execute');

    const { router, deps, say } = makeRouterWithoutSession();
    const result = await router.route(makeCtx('goal', say, undefined));

    expect(goalExec).toHaveBeenCalledTimes(1);
    expect(deps.slackApi.postSystemMessage).toHaveBeenCalledWith(
      'C1',
      expect.stringContaining('No active session'),
      expect.anything(),
    );
    expect(result.handled).toBe(true);
    expect(result.continueWithPrompt).toBeUndefined();
  });

  // P1 (#1068): the SLASH form `/goal foo …` with no session must fall through
  // exactly like the plain-text form (test 10). Before the parser-level guard,
  // `isPotentialCommand('/goal foo …')` returned `isPotential:true` (slash-root
  // `goal` is a known keyword), so even though GoalHandler declined the router
  // emitted the ❓ unrecognized-command hint and the user's instruction was
  // dropped. The guard now classifies an argument-carrying greedy free-form
  // slash root as non-command.
  it('12. slash `/goal foo …` with NO session → falls through (handled:false), no ❓, no "No active session"', async () => {
    stubSkillFs({ localSkills: ['using-ssot'] });
    const goalExec = vi.spyOn(GoalHandler.prototype, 'execute');

    const { router, deps, say } = makeRouterWithoutSession();
    const result = await router.route(makeCtx('/goal foo bar baz', say, undefined));

    expect(goalExec).toHaveBeenCalledTimes(1);
    expect(deps.slackApi.postSystemMessage).not.toHaveBeenCalledWith(
      'C1',
      expect.stringContaining('No active session'),
      expect.anything(),
    );
    expect(result.handled).toBe(false);
    expect(result.continueWithPrompt).toBeUndefined();
    // #1082 T1: slash form carries the objective out-of-band too.
    expect(result.setGoalObjective).toBe('foo bar baz');
    expect(say).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('인식할 수 없습니다') }),
    );
  });

  // Counterpart to test 12: a BARE `/goal` (no argument) with no session is a
  // genuine lifecycle command — it MUST still emit the "No active session" hint.
  it('13. bare `/goal` with NO session → goal handler still emits "No active session"', async () => {
    stubSkillFs({ localSkills: ['using-ssot'] });
    const goalExec = vi.spyOn(GoalHandler.prototype, 'execute');

    const { router, deps, say } = makeRouterWithoutSession();
    const result = await router.route(makeCtx('/goal', say, undefined));

    expect(goalExec).toHaveBeenCalledTimes(1);
    expect(deps.slackApi.postSystemMessage).toHaveBeenCalledWith(
      'C1',
      expect.stringContaining('No active session'),
      expect.anything(),
    );
    expect(result.handled).toBe(true);
    expect(say).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('인식할 수 없습니다') }),
    );
  });

  // `renew` is the other greedy free-form, session-required root. Plain-text
  // `renew <instruction>` with no session falls through (handled:false) so the
  // message starts a fresh conversation — and no ❓ hint leaks.
  it('14. plain `renew foo …` with NO session → falls through (handled:false), no ❓, no "No active session"', async () => {
    stubSkillFs({ localSkills: ['using-ssot'] });
    const renewExec = vi.spyOn(RenewHandler.prototype, 'execute');

    const { router, deps, say } = makeRouterWithoutSession();
    const result = await router.route(makeCtx('renew foo bar baz', say, undefined));

    expect(renewExec).toHaveBeenCalledTimes(1);
    expect(deps.slackApi.postSystemMessage).not.toHaveBeenCalledWith(
      'C1',
      expect.stringContaining('No active session to renew'),
      expect.anything(),
    );
    expect(result.handled).toBe(false);
    expect(result.continueWithPrompt).toBeUndefined();
    expect(say).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('인식할 수 없습니다') }),
    );
  });

  // P1 (#1068): same fall-through for the SLASH form `/renew <text>` — without
  // the parser-level guard this leaked the ❓ hint (slash-root `renew` is a
  // known keyword) and dropped the instruction.
  it('15. slash `/renew foo …` with NO session → falls through (handled:false), no ❓, no "No active session"', async () => {
    stubSkillFs({ localSkills: ['using-ssot'] });
    const renewExec = vi.spyOn(RenewHandler.prototype, 'execute');

    const { router, deps, say } = makeRouterWithoutSession();
    const result = await router.route(makeCtx('/renew foo bar baz', say, undefined));

    expect(renewExec).toHaveBeenCalledTimes(1);
    expect(deps.slackApi.postSystemMessage).not.toHaveBeenCalledWith(
      'C1',
      expect.stringContaining('No active session to renew'),
      expect.anything(),
    );
    expect(result.handled).toBe(false);
    expect(result.continueWithPrompt).toBeUndefined();
    expect(say).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('인식할 수 없습니다') }),
    );
  });

  // Counterpart to tests 14/15: bare `renew` / `/renew` (no argument) keep the
  // explicit "No active session to renew" hint. Leading-whitespace variants
  // (` /renew`, ` renew`) must also be stripped before the slash anchor so they
  // don't fall through to the ❓ unrecognized-command safety net.
  it('16. bare `renew` / `/renew` (incl. leading whitespace) with NO session → renew handler still emits "No active session to renew"', async () => {
    stubSkillFs({ localSkills: ['using-ssot'] });

    for (const text of ['renew', '/renew', ' /renew', ' renew', '  /renew  ']) {
      const { router, deps, say } = makeRouterWithoutSession();
      const result = await router.route(makeCtx(text, say, undefined));

      expect(deps.slackApi.postSystemMessage).toHaveBeenCalledWith(
        'C1',
        expect.stringContaining('No active session to renew'),
        expect.anything(),
      );
      expect(result.handled).toBe(true);
      expect(say).not.toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('인식할 수 없습니다') }),
      );
    }
  });
});

/**
 * `new <command …>` — recursive remainder re-route.
 *
 * Bug: `new goal <objective>` reset the session but the remainder
 * `goal <objective>` was delivered to Claude as a PLAIN PROMPT — the goal
 * command silently never ran (the old `new` preprocessor only composed
 * `$skill` remainders). Contract now: after `new` runs, the remainder is
 * re-routed through the full router as if the user had typed it directly,
 * so command semantics survive the `new` prefix. `new new …` chains reset
 * repeatedly; the chain depth is capped to bound Slack side effects.
 */
describe('CommandRouter — `new <command>` remainder re-route (recursive)', () => {
  function makeRouterWithSession(): {
    router: CommandRouter;
    deps: any;
    say: ReturnType<typeof vi.fn>;
    session: { goal?: any; systemPrompt?: string };
  } {
    const say = vi.fn().mockResolvedValue(undefined);
    const session: { goal?: any; systemPrompt?: string } = { systemPrompt: 'cached' };
    const deps = buildDeps({
      claudeHandler: {
        getSession: vi.fn().mockReturnValue(session),
        getSessionKey: vi.fn().mockImplementation((c: string, t: string) => `${c}:${t}`),
        resetSessionContext: vi.fn().mockReturnValue(true),
        saveSessions: vi.fn(),
      },
    });
    const router = new CommandRouter(deps);
    return { router, deps, say, session };
  }

  function makeCtx(text: string, say: ReturnType<typeof vi.fn>): any {
    return { text, user: 'U1', channel: 'C1', threadTs: 'T1', say };
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('1. `new goal ship X` → session reset AND goal IS set, goal continuation prompt returned', async () => {
    stubSkillFs({ localSkills: [] });
    const newExec = vi.spyOn(NewHandler.prototype, 'execute');
    const goalExec = vi.spyOn(GoalHandler.prototype, 'execute');

    const { router, say, deps, session } = makeRouterWithSession();
    const result = await router.route(makeCtx('new goal ship X', say));

    // Reset ran first…
    expect(newExec).toHaveBeenCalledTimes(1);
    expect(deps.claudeHandler.resetSessionContext).toHaveBeenCalledTimes(1);
    // …then the remainder was re-routed into GoalHandler.
    expect(goalExec).toHaveBeenCalledTimes(1);
    expect(session.goal).toBeDefined();
    expect(session.goal.objective).toBe('ship X');
    expect(session.goal.status).toBe('active');

    // The turn continues with the goal continuation prompt — exactly what a
    // directly-typed `goal ship X` produces.
    expect(result.handled).toBe(true);
    expect(result.continueWithPrompt).toContain('Continue working toward the active session goal');
  });

  it('2. `new goal ship X $z proceed` → reset + CLEAN goal objective + <invoked_skills> (triple composition)', async () => {
    stubSkillFs({ localSkills: ['z'] });
    const skillExec = vi.spyOn(SkillForceHandler.prototype, 'execute');

    const { router, say, session } = makeRouterWithSession();
    const result = await router.route(makeCtx('new goal ship X $z proceed', say));

    expect(session.goal?.objective).toBe('ship X');
    expect(skillExec).toHaveBeenCalledTimes(1);
    expect(skillExec.mock.calls[0][0].text).toBe('$z proceed');
    expect(result.handled).toBe(true);
    expect(result.continueWithPrompt).toContain('<invoked_skills>');
    expect(result.continueWithPrompt).toContain('<local:z>');
    // Durable goal objective must not leak the skill suffix.
    expect(session.goal?.objective).not.toContain('$z');
  });

  it('3. `new new write a test` → NewHandler runs TWICE, remainder delivered as plain prompt', async () => {
    stubSkillFs({ localSkills: [] });
    const newExec = vi.spyOn(NewHandler.prototype, 'execute');

    const { router, say } = makeRouterWithSession();
    const result = await router.route(makeCtx('new new write a test', say));

    expect(newExec).toHaveBeenCalledTimes(2);
    expect(result.handled).toBe(true);
    expect(result.continueWithPrompt).toBe('write a test');
  });

  it('4. `new new new` → three resets, no continuation (final bare `new`)', async () => {
    stubSkillFs({ localSkills: [] });
    const newExec = vi.spyOn(NewHandler.prototype, 'execute');

    const { router, say } = makeRouterWithSession();
    const result = await router.route(makeCtx('new new new', say));

    expect(newExec).toHaveBeenCalledTimes(3);
    expect(result.handled).toBe(true);
    expect(result.continueWithPrompt).toBeUndefined();
  });

  it('5. chain depth cap — `new` ×8 stops after MAX_NEW_CHAIN_DEPTH+1 executions, rest degrades to prompt', async () => {
    stubSkillFs({ localSkills: [] });
    const newExec = vi.spyOn(NewHandler.prototype, 'execute');

    const { router, say } = makeRouterWithSession();
    const result = await router.route(makeCtx('new new new new new new new new', say));

    // Depths 0..5 each execute one `new` (6 total), then recursion stops and
    // the remaining `new new` is delivered to the model as a plain prompt.
    expect(newExec).toHaveBeenCalledTimes(6);
    expect(result.handled).toBe(true);
    expect(result.continueWithPrompt).toBe('new new');
  });

  it('6. `new renew` style non-goal command remainder also re-routes (RenewHandler executed)', async () => {
    stubSkillFs({ localSkills: [] });
    const renewExec = vi.spyOn(RenewHandler.prototype, 'execute').mockResolvedValue({ handled: true });

    const { router, say } = makeRouterWithSession();
    const result = await router.route(makeCtx('new renew', say));

    expect(renewExec).toHaveBeenCalledTimes(1);
    expect(result.handled).toBe(true);
  });
});
