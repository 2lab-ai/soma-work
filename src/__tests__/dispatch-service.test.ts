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

// The workflow classifier names Haiku 5.5 by its own id and asks for effort `medium`. Before, it sent
// `claude-haiku-4-5-20251001` with no effort: Claude Code put a 31,999-token thinking budget on the wire
// (max_tokens 32,000), told the model it was Haiku 4.5, and only llmux's float of the old id made 5.5 answer.
describe('DispatchService — classifier model and effort', () => {
  async function freshService(envModel: string | undefined) {
    const saved = process.env.DEFAULT_DISPATCH_MODEL;
    if (envModel === undefined) delete process.env.DEFAULT_DISPATCH_MODEL;
    else process.env.DEFAULT_DISPATCH_MODEL = envModel;
    vi.resetModules();
    try {
      const mod = await import('../dispatch-service');
      const svc = mod.getDispatchService() as any;
      const dispatchOneShot = vi.fn(async () => '{"workflow":"default","title":"classified"}');
      svc.claudeHandler = { dispatchOneShot };
      svc.isConfigured = true;
      svc.dispatchPrompt = svc.dispatchPrompt || 'classify';
      return { svc, dispatchOneShot };
    } finally {
      if (saved === undefined) delete process.env.DEFAULT_DISPATCH_MODEL;
      else process.env.DEFAULT_DISPATCH_MODEL = saved;
    }
  }

  it('classifies on claude-haiku-5-5 at effort medium', async () => {
    const { svc, dispatchOneShot } = await freshService(undefined);
    await svc.dispatch('https://github.com/org/repo/pull/745');
    expect(dispatchOneShot).toHaveBeenCalledTimes(1);
    const args = dispatchOneShot.mock.calls[0] as unknown[];
    expect(args[2]).toBe('claude-haiku-5-5');
    expect(args[6]).toBe('medium');
  });

  it('DEFAULT_DISPATCH_MODEL still picks the model; the effort stays medium', async () => {
    const { svc, dispatchOneShot } = await freshService('claude-sonnet-4-6');
    await svc.dispatch('please look at the login page');
    const args = dispatchOneShot.mock.calls[0] as unknown[];
    expect(args[2]).toBe('claude-sonnet-4-6');
    expect(args[6]).toBe('medium');
  });
});
