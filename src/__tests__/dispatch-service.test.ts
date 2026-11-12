import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  decodeSlackEntities,
  getDispatchService,
  parseDeployDirective,
  parseDispatchWorkSize,
} from '../dispatch-service';

describe('dispatch work size (epic switch on small work)', () => {
  it('parseDispatchWorkSize takes small / large only (any case, trimmed)', () => {
    expect(parseDispatchWorkSize('small')).toBe('small');
    expect(parseDispatchWorkSize(' Large ')).toBe('large');
    for (const raw of [undefined, null, '', 'medium', 1, {}, 'small-ish']) {
      expect(parseDispatchWorkSize(raw)).toBeUndefined();
    }
  });

  it('a dispatch answer carries its size; a missing or odd one is left out', () => {
    const svc = getDispatchService() as any;
    expect(svc.parseResponse('{"workflow":"default","title":"오타","size":"small"}', '오타 고쳐줘').size).toBe('small');
    expect(svc.parseResponse('{"workflow":"default","title":"전부","size":"large"}', '전부 다시').size).toBe('large');
    expect('size' in svc.parseResponse('{"workflow":"default","title":"x"}', 'x')).toBe(false);
    expect('size' in svc.parseResponse('{"workflow":"default","title":"x","size":"huge"}', 'x')).toBe(false);
  });

  it('the dispatch prompt asks for the size and defines small as one task or about 10 minutes', () => {
    const prompt = fs.readFileSync(path.join(__dirname, '..', 'prompt', 'dispatch.prompt'), 'utf-8');
    expect(prompt).toContain('## Work Size Estimate');
    expect(prompt).toContain('"size": "small | large"');
    expect(prompt).toMatch(/`small` — one task or less[^\n]*about 10 minutes/);
    expect(prompt).toContain('When unsure, choose `large`.');
  });
});

describe('decodeSlackEntities', () => {
  it('decodes &gt; to >', () => {
    expect(decodeSlackEntities('foo &gt; bar')).toBe('foo > bar');
  });

  it('decodes &lt; to <', () => {
    expect(decodeSlackEntities('foo &lt; bar')).toBe('foo < bar');
  });

  it('decodes &amp; to &', () => {
    expect(decodeSlackEntities('foo &amp; bar')).toBe('foo & bar');
  });

  it('decodes all entities in a single string', () => {
    expect(decodeSlackEntities('a &lt; b &amp;&amp; b &gt; c')).toBe('a < b && b > c');
  });

  it('handles double-encoded &amp;gt; correctly (single pass only)', () => {
    // &amp;gt; should become &gt; (not >)
    expect(decodeSlackEntities('&amp;gt;')).toBe('&gt;');
  });

  it('handles double-encoded &amp;lt; correctly (single pass only)', () => {
    expect(decodeSlackEntities('&amp;lt;')).toBe('&lt;');
  });

  it('handles double-encoded &amp;amp; correctly (single pass only)', () => {
    expect(decodeSlackEntities('&amp;amp;')).toBe('&amp;');
  });

  it('returns the same string when no entities present', () => {
    expect(decodeSlackEntities('hello world')).toBe('hello world');
  });

  it('handles empty string', () => {
    expect(decodeSlackEntities('')).toBe('');
  });

  it('handles multiple occurrences', () => {
    expect(decodeSlackEntities('&gt;&gt;&gt; blockquote')).toBe('>>> blockquote');
  });
});

// Review gate round 3 (astra-zhuge P1 #3, PR #906): the classifier query
// blocked by the safeguards must not fall back to `default` and run the work.
describe('DispatchService — classifier blocked by safeguards', () => {
  function svcWith(dispatchOneShot: () => Promise<string>) {
    const svc = getDispatchService() as any;
    const saved = { handler: svc.claudeHandler, configured: svc.isConfigured, prompt: svc.dispatchPrompt };
    svc.claudeHandler = { dispatchOneShot };
    svc.isConfigured = true;
    svc.dispatchPrompt = svc.dispatchPrompt || 'classify';
    return {
      svc,
      restore: () =>
        Object.assign(svc, {
          claudeHandler: saved.handler,
          isConfigured: saved.configured,
          dispatchPrompt: saved.prompt,
        }),
    };
  }

  it('reports the flag when the classifier answer is the block', async () => {
    const { svc, restore } = svcWith(
      async () =>
        "API Error: Opus 5.5 (1M context)'s safeguards flagged this message (https://www.anthropic.com/legal/aup).\n\nDetails: `[reasoning_extraction]`\n\nRequest ID: req_r3",
    );
    try {
      const result = await svc.dispatch('do the thing');
      expect(result.safeguardFlag?.requestId).toBe('req_r3');
    } finally {
      restore();
    }
  });

  it('reports the flag when the classifier call throws the block', async () => {
    const { svc, restore } = svcWith(async () => {
      throw new Error(
        "API Error: Opus 5.5 (1M context)'s safeguards flagged this message (https://www.anthropic.com/legal/aup).\n\nDetails: `[reasoning_extraction]`\n\nRequest ID: req_r3",
      );
    });
    try {
      const result = await svc.dispatch('do the thing');
      expect(result.safeguardFlag?.detail).toBe('reasoning_extraction');
    } finally {
      restore();
    }
  });
});

// A deploy directive (`repo source -> target`) routes without the classifier:
// on a loaded host the classifier timed out, the session drifted to `default`
// and never got the deploy workflow (its prompt and its sandbox grant).
describe('DispatchService — deploy directive fast path', () => {
  function svcWith(opts: { configured?: boolean } = {}) {
    const svc = getDispatchService() as any;
    const saved = { handler: svc.claudeHandler, configured: svc.isConfigured, prompt: svc.dispatchPrompt };
    const dispatchOneShot = vi.fn(async () => '{"workflow":"default","title":"classified"}');
    if (opts.configured === false) {
      svc.claudeHandler = undefined;
      svc.isConfigured = false;
      svc.dispatchPrompt = undefined;
    } else {
      svc.claudeHandler = { dispatchOneShot };
      svc.isConfigured = true;
      svc.dispatchPrompt = svc.dispatchPrompt || 'classify';
    }
    return {
      svc,
      dispatchOneShot,
      restore: () =>
        Object.assign(svc, {
          claudeHandler: saved.handler,
          isConfigured: saved.configured,
          dispatchPrompt: saved.prompt,
        }),
    };
  }

  it('parseDeployDirective reads repos, source and target from the first line', () => {
    expect(parseDeployDirective('projalpha: develop -> deploy/stage')).toEqual({
      repos: ['projalpha'],
      source: 'develop',
      target: 'deploy/stage',
    });
    expect(
      parseDeployDirective('<@U123ABC> <@U456|someone>\n\n DEPLOY projalpha , projbeta main->prod $autoz'),
    ).toEqual({ repos: ['projalpha', 'projbeta'], source: 'main', target: 'prod' });
  });

  it('parseDeployDirective rejects anything that is not a directive', () => {
    for (const text of [
      '너 배포 안할거야?',
      'what does projalpha: develop -> deploy/stage do?',
      'projalpha develop->stage는 언제?',
      'projalpha develop stage',
      'deploy develop -> stage',
      ': develop -> stage',
      'hello there',
      '',
    ]) {
      expect(parseDeployDirective(text), text).toBeUndefined();
    }
  });

  const directives: Array<[string, string]> = [
    ['projalpha: develop -> deploy/stage', 'projalpha develop -> deploy/stage Deploy'],
    ['<@U123ABC> projalpha: develop -> deploy/stage', 'projalpha develop -> deploy/stage Deploy'],
    ['<@U123ABC|bot> projalpha: develop -&gt; deploy/stage', 'projalpha develop -> deploy/stage Deploy'],
    ['projalpha: develop -> deploy/stage $autoz', 'projalpha develop -> deploy/stage Deploy'],
    ['<@U123ABC> projalpha: develop -> deploy/stage 묻지 말고 머지 진행', 'projalpha develop -> deploy/stage Deploy'],
    ['deploy projalpha,projbeta main -> prod', 'projalpha,projbeta main -> prod Deploy'],
    ['projalpha develop -> deploy/stage', 'projalpha develop -> deploy/stage Deploy'],
  ];

  it.each(directives)('routes %j to deploy without the classifier', async (text, title) => {
    const { svc, dispatchOneShot, restore } = svcWith();
    try {
      const result = await svc.dispatch(text);
      expect(result.workflow).toBe('deploy');
      expect(result.title).toBe(title);
      expect(result.size).toBe('small');
      expect(result.complexity).toBeDefined();
      expect(dispatchOneShot).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('keeps the links of a directive message', async () => {
    const { svc, restore } = svcWith();
    try {
      const result = await svc.dispatch('projalpha develop -> deploy/stage https://github.com/org/repo/pull/7');
      expect(result.workflow).toBe('deploy');
      expect(result.links?.pr?.url).toBe('https://github.com/org/repo/pull/7');
    } finally {
      restore();
    }
  });

  it.each([
    '너 배포 안할거야?',
    'what does projalpha: develop -> deploy/stage do?',
    'projalpha develop->stage는 언제?',
    'please look at the login page',
  ])('leaves %j to the classifier', async (text) => {
    const { svc, dispatchOneShot, restore } = svcWith();
    try {
      const result = await svc.dispatch(text);
      expect(dispatchOneShot).toHaveBeenCalledTimes(1);
      expect(result.workflow).toBe('default');
      expect(result.title).toBe('classified');
    } finally {
      restore();
    }
  });

  it('routes a directive even when the classifier is not configured', async () => {
    const { svc, restore } = svcWith({ configured: false });
    try {
      const result = await svc.dispatch('<@U123ABC> projalpha: develop -> deploy/stage');
      expect(result.workflow).toBe('deploy');
      expect(result.title).toBe('projalpha develop -> deploy/stage Deploy');
      expect((await svc.dispatch('너 배포 안할거야?')).workflow).toBe('default');
    } finally {
      restore();
    }
  });
});

// The workflow classifier is a `haiku`-tier aux call (agent-runtime/aux-model.ts): the model follows the
// provider of the session's model (else the sender's default model) — Claude → the `haiku` alias, Codex → `luna`,
// Grok → `grok` at effort low — resolved through the alias table at call time. Other providers keep effort
// `medium` (with no effort, Claude Code sent Haiku a fixed 31,999-token thinking budget). DEFAULT_DISPATCH_MODEL
// (operator) still wins as-is.
describe('DispatchService — classifier model and effort', () => {
  async function freshService(envModel: string | undefined) {
    const saved = process.env.DEFAULT_DISPATCH_MODEL;
    if (envModel === undefined) delete process.env.DEFAULT_DISPATCH_MODEL;
    else process.env.DEFAULT_DISPATCH_MODEL = envModel;
    vi.resetModules();
    try {
      const mod = await import('../dispatch-service');
      const settings = await import('../user-settings-store');
      const svc = mod.getDispatchService() as any;
      const dispatchOneShot = vi.fn(async () => '{"workflow":"default","title":"classified"}');
      svc.claudeHandler = { dispatchOneShot };
      svc.isConfigured = true;
      svc.dispatchPrompt = svc.dispatchPrompt || 'classify';
      return { svc, dispatchOneShot, settings };
    } finally {
      if (saved === undefined) delete process.env.DEFAULT_DISPATCH_MODEL;
      else process.env.DEFAULT_DISPATCH_MODEL = saved;
    }
  }

  /** The [model, effort] of the single classifier call. */
  function modelAndEffort(dispatchOneShot: ReturnType<typeof vi.fn>): [unknown, unknown] {
    expect(dispatchOneShot).toHaveBeenCalledTimes(1);
    const args = dispatchOneShot.mock.calls[0] as unknown[];
    return [args[2], args[6]];
  }

  it("a Claude user's message classifies on the `haiku` alias at effort medium", async () => {
    const { svc, dispatchOneShot, settings } = await freshService(undefined);
    vi.spyOn(settings.userSettingsStore, 'getUserDefaultModel').mockReturnValue('claude-opus-5-5[1m]');
    await svc.dispatch('https://github.com/org/repo/pull/745', undefined, 'U_CLAUDE');
    expect(modelAndEffort(dispatchOneShot)).toEqual([settings.MODEL_ALIASES.haiku, 'medium']);
    expect(settings.MODEL_ALIASES.haiku).toBe('claude-haiku-5-5[1m]');
  });

  it("a Codex user's message classifies on the `luna` alias at effort medium", async () => {
    const { svc, dispatchOneShot, settings } = await freshService(undefined);
    vi.spyOn(settings.userSettingsStore, 'getUserDefaultModel').mockReturnValue('gpt-6.1-sol[1m]');
    await svc.dispatch('fix the login page', undefined, 'U_CODEX');
    expect(modelAndEffort(dispatchOneShot)).toEqual([settings.MODEL_ALIASES.luna, 'medium']);
  });

  it("a Grok user's message classifies on grok at effort low", async () => {
    const { svc, dispatchOneShot, settings } = await freshService(undefined);
    vi.spyOn(settings.userSettingsStore, 'getUserDefaultModel').mockReturnValue('grok-4.7');
    await svc.dispatch('fix the login page', undefined, 'U_GROK');
    const [model, effort] = modelAndEffort(dispatchOneShot);
    expect(model).toMatch(/^grok-/);
    expect(effort).toBe('low');
  });

  it("the session's model, when given, picks the provider over the sender's default", async () => {
    const { svc, dispatchOneShot, settings } = await freshService(undefined);
    vi.spyOn(settings.userSettingsStore, 'getUserDefaultModel').mockReturnValue('claude-opus-5-5[1m]');
    await svc.dispatch('fix the login page', undefined, 'U_CLAUDE', 'gpt-6.1-sol[1m]');
    expect(modelAndEffort(dispatchOneShot)).toEqual([settings.MODEL_ALIASES.luna, 'medium']);
  });

  it('no sender and no session → DEFAULT_MODEL picks the provider', async () => {
    const { svc, dispatchOneShot, settings } = await freshService(undefined);
    await svc.dispatch('fix the login page');
    const expected = /^gpt-/.test(settings.DEFAULT_MODEL) ? settings.MODEL_ALIASES.luna : settings.MODEL_ALIASES.haiku;
    expect(modelAndEffort(dispatchOneShot)).toEqual([expected, 'medium']);
  });

  it('getModel names the model that dispatch would use for the same sender / session', async () => {
    const { svc, settings } = await freshService(undefined);
    vi.spyOn(settings.userSettingsStore, 'getUserDefaultModel').mockReturnValue('gpt-6.1-sol[1m]');
    expect(svc.getModel('U_CODEX')).toBe(settings.MODEL_ALIASES.luna);
    expect(svc.getModel('U_CODEX', 'claude-opus-5-5[1m]')).toBe(settings.MODEL_ALIASES.haiku);
  });

  it('DEFAULT_DISPATCH_MODEL still picks the model as-is; the effort stays medium', async () => {
    const { svc, dispatchOneShot, settings } = await freshService('claude-sonnet-4-6');
    vi.spyOn(settings.userSettingsStore, 'getUserDefaultModel').mockReturnValue('grok-4.7');
    await svc.dispatch('please look at the login page', undefined, 'U_GROK');
    expect(modelAndEffort(dispatchOneShot)).toEqual(['claude-sonnet-4-6', 'medium']);
    expect(svc.getModel('U_GROK')).toBe('claude-sonnet-4-6');
  });
});

// llmux tenant keys: the workflow classification is made for the message's
// sender, so it carries their key (production: a haiku classification of a
// user's PR link reached llmux as the shared `local` tenant).
describe('DispatchService — llmux tenant user', () => {
  function svcWith(dispatchOneShot: (...args: unknown[]) => Promise<string>) {
    const svc = getDispatchService() as any;
    const saved = { handler: svc.claudeHandler, configured: svc.isConfigured, prompt: svc.dispatchPrompt };
    svc.claudeHandler = { dispatchOneShot };
    svc.isConfigured = true;
    svc.dispatchPrompt = svc.dispatchPrompt || 'classify';
    return {
      svc,
      restore: () =>
        Object.assign(svc, {
          claudeHandler: saved.handler,
          isConfigured: saved.configured,
          dispatchPrompt: saved.prompt,
        }),
    };
  }

  it('forwards the sender to dispatchOneShot as the tenant user, next to the classifier effort', async () => {
    const dispatchOneShot = vi.fn(async (..._args: unknown[]) => '{"workflow":"pr-review","title":"PR 리뷰"}');
    const { svc, restore } = svcWith(dispatchOneShot);
    try {
      const result = await svc.dispatch('PR 리뷰 부탁해 acme/repo#1', undefined, 'U_DAN');
      expect(result.workflow).toBe('pr-review');
      expect(dispatchOneShot).toHaveBeenCalledTimes(1);
      expect(dispatchOneShot.mock.calls[0][6]).toBe('medium');
      expect(dispatchOneShot.mock.calls[0][7]).toEqual({ tenantUserId: 'U_DAN' });
    } finally {
      restore();
    }
  });

  it('no sender → no tenant user (the shared key)', async () => {
    const dispatchOneShot = vi.fn(async (..._args: unknown[]) => '{"workflow":"default","title":"x"}');
    const { svc, restore } = svcWith(dispatchOneShot);
    try {
      await svc.dispatch('hello');
      expect(dispatchOneShot.mock.calls[0][7]).toEqual({ tenantUserId: undefined });
    } finally {
      restore();
    }
  });
});
