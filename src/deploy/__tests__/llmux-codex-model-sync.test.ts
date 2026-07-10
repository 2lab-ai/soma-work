/**
 * Boot-time llmux codex pin sync (gpt-5.6 release). Contract:
 *   - reads the live pin via an empty POST to {baseUrl}/llmux/codex;
 *   - stale gpt-5.5-era pins are rewritten to `gpt-5.6-sol` (one write);
 *   - gpt-5.6-family pins are left alone (`already-current`);
 *   - anything else is an operator decision — left alone (`custom-pin-left`);
 *   - every network/HTTP failure is fail-soft (`failed`, never throws).
 */
import { describe, expect, it } from 'vitest';
import { GPT_5_6_UPSTREAM_SLUG, syncLlmuxCodexModel } from '../llmux-codex-model-sync';

/** Minimal fetch stub: scripted JSON responses + request capture. */
function makeFetch(responses: Array<{ ok?: boolean; status?: number; json: unknown }>) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const impl = (async (url: unknown, init?: { body?: unknown }) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const next = responses.shift() ?? { ok: true, json: {} };
    return {
      ok: next.ok ?? true,
      status: next.status ?? 200,
      json: async () => next.json,
    };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('syncLlmuxCodexModel', () => {
  it('exports the probed upstream slug (bare gpt-5.6 is rejected by the codex backend)', () => {
    expect(GPT_5_6_UPSTREAM_SLUG).toBe('gpt-5.6-sol');
  });

  it('rewrites a stale gpt-5.5 pin to gpt-5.6-sol', async () => {
    const { impl, calls } = makeFetch([
      { json: { ok: true, default_model: 'gpt-5.5' } },
      { json: { ok: true, default_model: 'gpt-5.6-sol' } },
    ]);
    const result = await syncLlmuxCodexModel({ baseUrl: 'http://localhost:3456', fetchImpl: impl });
    expect(result).toEqual({ status: 'updated', before: 'gpt-5.5', after: 'gpt-5.6-sol' });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe('http://localhost:3456/llmux/codex');
    expect(calls[0]?.body).toEqual({});
    expect(calls[1]?.body).toEqual({ default_model: 'gpt-5.6-sol' });
  });

  it('rewrites gpt-5.5 variant pins (gpt-5.5-codex) too', async () => {
    const { impl, calls } = makeFetch([
      { json: { ok: true, default_model: 'gpt-5.5-codex' } },
      { json: { ok: true, default_model: 'gpt-5.6-sol' } },
    ]);
    const result = await syncLlmuxCodexModel({ baseUrl: 'http://localhost:3456', fetchImpl: impl });
    expect(result.status).toBe('updated');
    expect(calls).toHaveLength(2);
  });

  it('is a no-op when the pin already serves the gpt-5.6 family', async () => {
    for (const pin of ['gpt-5.6-sol', 'gpt-5.6-terra', 'GPT-5.6-SOL']) {
      const { impl, calls } = makeFetch([{ json: { ok: true, default_model: pin } }]);
      const result = await syncLlmuxCodexModel({ baseUrl: 'http://localhost:3456', fetchImpl: impl });
      expect(result).toEqual({ status: 'already-current', before: pin });
      expect(calls).toHaveLength(1); // read only — no write
    }
  });

  it('leaves operator-custom pins alone', async () => {
    const { impl, calls } = makeFetch([{ json: { ok: true, default_model: 'gpt-5-codex' } }]);
    const result = await syncLlmuxCodexModel({ baseUrl: 'http://localhost:3456', fetchImpl: impl });
    expect(result).toEqual({ status: 'custom-pin-left', before: 'gpt-5-codex' });
    expect(calls).toHaveLength(1);
  });

  it('strips a trailing slash from baseUrl', async () => {
    const { impl, calls } = makeFetch([{ json: { ok: true, default_model: 'gpt-5.6-sol' } }]);
    await syncLlmuxCodexModel({ baseUrl: 'http://localhost:3456/', fetchImpl: impl });
    expect(calls[0]?.url).toBe('http://localhost:3456/llmux/codex');
  });

  it('fails soft on HTTP errors (never throws)', async () => {
    const { impl } = makeFetch([{ ok: false, status: 502, json: {} }]);
    const result = await syncLlmuxCodexModel({ baseUrl: 'http://localhost:3456', fetchImpl: impl });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('502');
  });

  it('fails soft when fetch rejects (proxy down)', async () => {
    const impl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const result = await syncLlmuxCodexModel({ baseUrl: 'http://localhost:3456', fetchImpl: impl });
    expect(result).toEqual({ status: 'failed', error: 'ECONNREFUSED' });
  });

  it('reports failed when the pin write does not stick', async () => {
    const { impl } = makeFetch([
      { json: { ok: true, default_model: 'gpt-5.5' } },
      { json: { ok: true, default_model: 'gpt-5.5' } }, // write ignored upstream
    ]);
    const result = await syncLlmuxCodexModel({ baseUrl: 'http://localhost:3456', fetchImpl: impl });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('did not stick');
  });
});
