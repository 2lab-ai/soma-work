/**
 * Production classifier factory wiring (#auto-permission-mode).
 *
 * The classifier is backed by the injected dispatch adapter (production binds it
 * to `ClaudeHandler.dispatchOneShot`). These tests use a fake dispatch — no
 * model call, no network.
 */

import { describe, expect, it, vi } from 'vitest';
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
    // No model on the request + no env override → undefined, so dispatch/SDK
    // pick the default (the classifier no longer hardcodes a model).
    expect(opts.model).toBeUndefined();
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

  // ── #model-call-unify: default classifier model = the session's CURRENT
  // model (threaded via req.model), not a hardcoded cheap model. ──
  it('defaults to the session model carried on the request', async () => {
    const dispatch = vi.fn().mockResolvedValue('{"verdict":"allow","reason":"ok"}');
    await buildSafetyClassifier({ dispatch }).classify({ ...REQ, model: 'claude-opus-4-8[1m]' });
    expect(dispatch.mock.calls[0][2].model).toBe('claude-opus-4-8[1m]');
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
