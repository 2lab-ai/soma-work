import * as fs from 'node:fs';
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
vi.mock('../../env-paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../env-paths')>();
  return {
    ...actual,
    PLUGINS_DIR: '/mock/plugins',
    DATA_DIR: '/mock/data',
  };
});
vi.mock('../../path-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../path-utils')>();
  return {
    ...actual,
    isSafePathSegment: (s: string) => !!s && !s.includes('/') && !s.includes('..'),
  };
});

import { userSettingsStore } from '../../user-settings-store';
import { BypassHandler } from './bypass-handler';
import { CommandRouter } from './command-router';
import { EffortHandler } from './effort-handler';
import { EmailHandler } from './email-handler';
import { HelpHandler } from './help-handler';
import { ModelHandler } from './model-handler';
import { NewHandler } from './new-handler';
import { PersonaHandler } from './persona-handler';
import { PromptHandler } from './prompt-handler';
import { RateHandler } from './rate-handler';
import { SkillForceHandler } from './skill-force-handler';
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
 * pattern). It runs session reset FIRST, then — and only then — if the
 * remainder contains a `$skill` force trigger, `SkillForceHandler` resolves
 * it so the reset + skill force invocation compose correctly.
 *
 * All OTHER command-shaped remainders (help / sessions / compact / ...) keep
 * their existing semantics: delivered to Claude as a plain prompt. That is
 * the narrow-scope contract and it is verified below.
 */
describe('CommandRouter — `new` + `$skill` composition (preprocessor)', () => {
  /** Stub filesystem so SkillForceHandler sees a well-known skill layout. */
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

  it('6. `new help` → preserves existing semantic (remainder delivered to Claude as prompt, HelpHandler NOT executed)', async () => {
    stubSkillFs({ localSkills: ['z'] });
    const helpExec = vi.spyOn(HelpHandler.prototype, 'execute');
    const skillExec = vi.spyOn(SkillForceHandler.prototype, 'execute');

    const { router, say } = makeRouter();
    const result = await router.route(makeCtx('new help', say));

    expect(helpExec).not.toHaveBeenCalled();
    expect(skillExec).not.toHaveBeenCalled();
    expect(result.handled).toBe(true);
    expect(result.continueWithPrompt).toBe('help');
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
