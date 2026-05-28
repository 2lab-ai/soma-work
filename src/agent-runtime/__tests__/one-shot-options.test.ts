/**
 * `buildOneShotOptions` behavior pinning (ADR 0002, pass 1.5).
 *
 * Pass 1.5 absorbs the 4-helper duplication that pass 1 left behind:
 * every one-shot helper repeated the same
 * `{ model, maxTurns: 1, tools: [], systemPrompt, extensions: { claudeCode:
 *   { env, settingSources: [], plugins: [], thinking: {type:'disabled'},
 *     stderr: (data) => logger.warn(`${label} stderr`, …) } } }`
 * block. The builder centralizes that shape so helpers state only their
 * own deltas (model, systemPrompt, env, logger label, opt-out of thinking).
 *
 * IMPORTANT: this builder does NOT own lease acquisition. Callers retain
 * the `ensureActiveSlotAuth` / `release` lifecycle — `generateSessionSummaryTitle`
 * intentionally reuses a single lease across Haiku → Sonnet fallback, and
 * each helper has a slightly different `NoHealthySlotError` failure contract
 * (some return null, one rethrows). Codex consult 7d938b68-fb6d-4786-a63c.
 */

import { describe, expect, it, vi } from 'vitest';
import { buildOneShotOptions } from '../one-shot-options';

describe('buildOneShotOptions', () => {
  it('produces the canonical one-shot AgentRunOptions shape', () => {
    const env = { CLAUDE_CODE_OAUTH_TOKEN: 'lease-token' };
    const logger = { warn: vi.fn() };
    const opts = buildOneShotOptions({
      model: 'claude-haiku-4-5',
      systemPrompt: 'sys',
      env,
      logger,
      stderrLabel: 'Test',
    });
    expect(opts.model).toBe('claude-haiku-4-5');
    expect(opts.maxTurns).toBe(1);
    expect(opts.tools).toEqual([]);
    expect(opts.systemPrompt).toBe('sys');
    expect(opts.extensions?.claudeCode?.env).toBe(env);
    expect(opts.extensions?.claudeCode?.settingSources).toEqual([]);
    expect(opts.extensions?.claudeCode?.plugins).toEqual([]);
  });

  it('disables thinking by default (#762 guard for tiny title/summary prompts)', () => {
    const opts = buildOneShotOptions({
      model: 'm',
      systemPrompt: 'sys',
      env: {},
      logger: { warn: vi.fn() },
      stderrLabel: 'Test',
    });
    expect(opts.extensions?.claudeCode?.thinking).toEqual({ type: 'disabled' });
  });

  it('omits the thinking field when disableThinking: false', () => {
    // `memory-improve.ts` is the only one-shot caller that does NOT pass
    // `thinking: { type: 'disabled' }` (and never has — pre-PR-#975 too).
    // The omission preserves whatever SDK default applies. We surface the
    // divergence by making the caller pass `disableThinking: false`
    // explicitly so a future reader sees the deliberate opt-out.
    const opts = buildOneShotOptions({
      model: 'm',
      systemPrompt: 'sys',
      env: {},
      logger: { warn: vi.fn() },
      stderrLabel: 'Test',
      disableThinking: false,
    });
    expect(opts.extensions?.claudeCode?.thinking).toBeUndefined();
  });

  it("wires stderr to logger.warn with '<label> stderr' message and trimmed data", () => {
    const logger = { warn: vi.fn() };
    const opts = buildOneShotOptions({
      model: 'm',
      systemPrompt: 'sys',
      env: {},
      logger,
      stderrLabel: 'MyHelper',
    });
    opts.extensions?.claudeCode?.stderr?.('hello\n');
    expect(logger.warn).toHaveBeenCalledWith('MyHelper stderr', { data: 'hello' });
  });

  it('forwards the env reference (no clone) so caller-mutations still leak — same as inline code', () => {
    // The pre-builder inline code passed `env` by reference. Preserving
    // that exactly avoids any GC behaviour change in the SDK child-process
    // env propagation path.
    const env: Record<string, string | undefined> = { K: 'V' };
    const opts = buildOneShotOptions({
      model: 'm',
      systemPrompt: 'sys',
      env,
      logger: { warn: vi.fn() },
      stderrLabel: 'X',
    });
    expect(opts.extensions?.claudeCode?.env).toBe(env);
  });
});
