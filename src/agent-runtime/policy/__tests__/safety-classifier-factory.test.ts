/**
 * Production classifier factory wiring (#auto-permission-mode).
 *
 * The classifier is backed by the injected dispatch adapter (production binds it
 * to `ClaudeHandler.dispatchOneShot`). These tests use a fake dispatch — no
 * model call, no network.
 */

import { describe, expect, it, vi } from 'vitest';
import { auxModelFor } from '../../aux-model';
import { LlmSafetyClassifier, type SafetyClassifyRequest, StaticSafetyClassifier } from '../safety-classifier';
import { buildSafetyClassifier } from '../safety-classifier-factory';

const REQ: SafetyClassifyRequest = {
  toolName: 'Bash',
  command: 'rm -rf /tmp/U1/x',
  toolInput: {},
  matchedRuleIds: ['rm-recursive'],
  user: 'U1',
};

describe('buildSafetyClassifier', () => {
  it('fails closed to the static (always-ask) classifier when no dispatch is wired', () => {
    expect(buildSafetyClassifier({})).toBeInstanceOf(StaticSafetyClassifier);
  });

  it('uses the static classifier when disabled via env even with a dispatch', () => {
    const dispatch = vi.fn();
    expect(buildSafetyClassifier({ env: { PERMISSION_AUTO_CLASSIFIER: 'off' }, dispatch })).toBeInstanceOf(
      StaticSafetyClassifier,
    );
    expect(buildSafetyClassifier({ env: { PERMISSION_AUTO_CLASSIFIER: 'OFF' }, dispatch })).toBeInstanceOf(
      StaticSafetyClassifier,
    );
  });

  it('returns the LLM classifier when a dispatch is wired', () => {
    expect(buildSafetyClassifier({ dispatch: vi.fn() })).toBeInstanceOf(LlmSafetyClassifier);
  });
});

describe('dispatch-backed classifier', () => {
  it('calls dispatch with the reviewer system prompt + the command, and parses allow', async () => {
    const dispatch = vi.fn().mockResolvedValue('{"verdict":"allow","reason":"scoped to user tmp"}');
    const classifier = buildSafetyClassifier({ dispatch });
    const v = await classifier.classify(REQ);
    expect(v.verdict).toBe('allow');
    expect(dispatch).toHaveBeenCalledOnce();
    const [userMessage, systemPrompt, opts] = dispatch.mock.calls[0];
    expect(userMessage).toContain('rm -rf /tmp/U1/x'); // command threaded into the prompt
    expect(systemPrompt).toMatch(/SAFETY REVIEWER/i);
    // No model on the request + no env override → the `haiku` aux tier of the
    // default model's provider, resolved through the alias table now.
    expect(opts.model).toBe(auxModelFor('haiku').model);
  });

  it('escalates (ask) when dispatch returns ask', async () => {
    const dispatch = vi.fn().mockResolvedValue('{"verdict":"ask","reason":"host-wide"}');
    expect((await buildSafetyClassifier({ dispatch }).classify(REQ)).verdict).toBe('ask');
  });

  it('fails closed to ask when dispatch throws', async () => {
    const dispatch = vi.fn().mockRejectedValue(new Error('lease unavailable'));
    expect((await buildSafetyClassifier({ dispatch }).classify(REQ)).verdict).toBe('ask');
  });

  it('honours the env model override', async () => {
    const dispatch = vi.fn().mockResolvedValue('{"verdict":"allow","reason":"ok"}');
    await buildSafetyClassifier({ env: { PERMISSION_AUTO_CLASSIFIER_MODEL: 'custom-model' }, dispatch }).classify(REQ);
    expect(dispatch.mock.calls[0][2].model).toBe('custom-model');
  });

  // ── Default classifier model = the cheap (`haiku`) aux tier of the session's
  // CURRENT model's provider (threaded via req.model): never the session model
  // itself (rules/permission.md) and never a Claude model in a GPT/Grok session. ──
  it('defaults to the haiku tier of the session model carried on the request', async () => {
    const dispatch = vi.fn().mockResolvedValue('{"verdict":"allow","reason":"ok"}');
    await buildSafetyClassifier({ dispatch }).classify({ ...REQ, model: 'claude-opus-4-8[1m]' });
    const claude = dispatch.mock.calls[0][2].model;
    expect(claude).toBe(auxModelFor('haiku', { mainModel: 'claude-opus-4-8[1m]' }).model);
    expect(claude).toMatch(/haiku/);
    await buildSafetyClassifier({ dispatch }).classify({ ...REQ, model: 'gpt-6-astra[1m]' });
    const codex = dispatch.mock.calls[1][2].model;
    expect(codex).toMatch(/luna/);
    expect(codex).not.toMatch(/astra|claude/);
  });

  // Trinity R1 (soma-work#1224): Grok has one model line, so its haiku tier is
  // the Grok pin at low effort — the effort must reach the dispatch, or the
  // classifier runs at the session's (xhigh) effort.
  it('carries the tier effort: Grok low, Claude/Codex medium, env model override none', async () => {
    const dispatch = vi.fn().mockResolvedValue('{"verdict":"allow","reason":"ok"}');
    await buildSafetyClassifier({ dispatch }).classify({ ...REQ, model: 'grok-4.7' });
    expect(dispatch.mock.calls[0][2]).toMatchObject({ model: expect.stringMatching(/^grok-/), effort: 'low' });
    await buildSafetyClassifier({ dispatch }).classify({ ...REQ, model: 'claude-opus-4-8[1m]' });
    expect(dispatch.mock.calls[1][2].effort).toBe('medium');
    await buildSafetyClassifier({ dispatch }).classify({ ...REQ, model: 'gpt-6-astra[1m]' });
    expect(dispatch.mock.calls[2][2].effort).toBe('medium');
    await buildSafetyClassifier({ env: { PERMISSION_AUTO_CLASSIFIER_MODEL: 'forced' }, dispatch }).classify({
      ...REQ,
      model: 'grok-4.7',
    });
    expect(dispatch.mock.calls[3][2].effort).toBeUndefined();
  });

  it('env override beats the session model when both are present', async () => {
    const dispatch = vi.fn().mockResolvedValue('{"verdict":"ask","reason":"x"}');
    await buildSafetyClassifier({ env: { PERMISSION_AUTO_CLASSIFIER_MODEL: 'forced' }, dispatch }).classify({
      ...REQ,
      model: 'claude-opus-4-8[1m]',
    });
    expect(dispatch.mock.calls[0][2].model).toBe('forced');
  });
});

// Review R1 (astra P2): a caller's abort reaches the one-shot dispatch.
describe('buildSafetyClassifier — abort', () => {
  it('passes an AbortController to dispatch that the request signal aborts', async () => {
    let ac: AbortController | undefined;
    const dispatch = vi.fn((_m: string, _s: string, opts: { abortController?: AbortController }) => {
      ac = opts.abortController;
      return new Promise<string>(() => {});
    });
    const c = buildSafetyClassifier({ env: {}, dispatch });
    const caller = new AbortController();
    const pending = c.classify({
      toolName: 'Bash',
      command: 'ls',
      toolInput: { command: 'ls' },
      matchedRuleIds: [],
      user: 'U1',
      signal: caller.signal,
    });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalled());
    caller.abort();
    expect(ac?.signal.aborted).toBe(true);
    void pending;
  });
});

// llmux tenant keys: the guardian call is made for the session's user, so the
// dispatch carries their id (production meters it under their llmux key).
describe('buildSafetyClassifier — llmux tenant user', () => {
  it("forwards the request's user to dispatch as the tenant user (with and without an abort signal)", async () => {
    const dispatch = vi.fn().mockResolvedValue('{"verdict":"ask","reason":"x"}');
    const c = buildSafetyClassifier({ env: {}, dispatch });

    await c.classify({ ...REQ, user: 'U_DAN' });
    await c.classify({ ...REQ, user: 'U_DAN', signal: new AbortController().signal });

    expect(dispatch.mock.calls[0][2].tenantUserId).toBe('U_DAN');
    expect(dispatch.mock.calls[1][2].tenantUserId).toBe('U_DAN');
    expect(dispatch.mock.calls[1][2].abortController).toBeInstanceOf(AbortController);
  });

  it('no user on the request → no tenant user (the shared key)', async () => {
    const dispatch = vi.fn().mockResolvedValue('{"verdict":"ask","reason":"x"}');
    await buildSafetyClassifier({ env: {}, dispatch }).classify({ ...REQ, user: '' });
    expect('tenantUserId' in dispatch.mock.calls[0][2]).toBe(false);
  });
});
