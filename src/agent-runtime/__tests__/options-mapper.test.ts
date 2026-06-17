/**
 * Mapper tests for `toSdkOptions` (Claude Code adapter, pass 1).
 *
 * These pin the AgentRunOptions → SDK Options translation so a future
 * pass that extends the port surface can't silently drop a Claude-Code-only
 * field that the helpers still rely on.
 */

import { describe, expect, it } from 'vitest';
import type { AgentRunOptions } from '../agent-runner';
import { toSdkOptions } from '../claude-code-runner';

describe('toSdkOptions', () => {
  it('copies the portable core (model/maxTurns/systemPrompt/tools)', () => {
    const out = toSdkOptions({
      model: 'claude-haiku-4-5',
      maxTurns: 1,
      systemPrompt: 'sys',
      tools: [],
    });
    expect(out.model).toBe('claude-haiku-4-5');
    expect(out.maxTurns).toBe(1);
    expect(out.systemPrompt).toBe('sys');
    expect(out.tools).toEqual([]);
  });

  it('routes Claude-Code extension fields into the SDK Options shape', () => {
    const env = { CLAUDE_CODE_OAUTH_TOKEN: 'lease-token' };
    const stderr = (_data: string) => {};
    const opts: AgentRunOptions = {
      model: 'claude-sonnet-4-5',
      extensions: {
        claudeCode: {
          env,
          settingSources: [],
          plugins: [],
          thinking: { type: 'disabled' },
          stderr,
        },
      },
    };
    const out = toSdkOptions(opts);
    expect(out.env).toBe(env);
    expect(out.settingSources).toEqual([]);
    expect(out.plugins).toEqual([]);
    expect(out.thinking).toEqual({ type: 'disabled' });
    expect(out.stderr).toBe(stderr);
  });

  it('defaults tools/settingSources/plugins to empty arrays when omitted', () => {
    const out = toSdkOptions({ model: 'm' });
    expect(out.tools).toEqual([]);
    expect(out.settingSources).toEqual([]);
    expect(out.plugins).toEqual([]);
  });

  it('keeps env/thinking/stderr undefined when no extension bag is provided', () => {
    const out = toSdkOptions({ model: 'm' });
    expect(out.env).toBeUndefined();
    expect(out.thinking).toBeUndefined();
    expect(out.stderr).toBeUndefined();
  });

  // ── unification (#model-call-unify): dispatchOneShot's Claude-Code knobs
  // move into the port's claudeCode bag so dispatch can route through
  // runOneShotText instead of its own query() loop. ──
  it('routes the dispatch knobs (effort/cwd/abortController/resume/forkSession) into SDK Options', () => {
    const abortController = new AbortController();
    const out = toSdkOptions({
      model: 'm',
      maxTurns: 1,
      extensions: {
        claudeCode: {
          effort: 'high',
          cwd: '/tmp/U1/work',
          abortController,
          resume: 'sess-1',
          forkSession: true,
        },
      },
    });
    expect(out.effort).toBe('high');
    expect(out.cwd).toBe('/tmp/U1/work');
    expect(out.abortController).toBe(abortController);
    expect(out.resume).toBe('sess-1');
    expect(out.forkSession).toBe(true);
  });

  it('leaves the dispatch knobs undefined when not supplied', () => {
    const out = toSdkOptions({ model: 'm' });
    expect(out.effort).toBeUndefined();
    expect(out.cwd).toBeUndefined();
    expect(out.abortController).toBeUndefined();
    expect(out.resume).toBeUndefined();
    expect(out.forkSession).toBeUndefined();
  });
});
