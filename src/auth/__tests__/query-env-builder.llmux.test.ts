import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlotAuthLease } from '../../credentials-manager';
import { buildQueryEnv } from '../query-env-builder';

// #llmux — exercise the `config.auth.mode === 'llmux'` branch of buildQueryEnv.
// The default suite (query-env-builder.test.ts) runs against the real config
// (ccp); here we mock config so the proxy branch is reachable without env
// gymnastics. query-env-builder only reads `config.auth`, so a partial mock
// suffices.
vi.mock('../../config', () => ({
  config: {
    auth: {
      mode: 'llmux',
      llmux: { baseUrl: 'http://localhost:3456', apiKey: 'llmux-local' },
    },
  },
}));

function makeLease(keyId: string, accessToken: string, kind: SlotAuthLease['kind'] = 'api_key'): SlotAuthLease {
  return {
    keyId,
    accessToken,
    kind,
    async release() {
      /* no-op */
    },
    async heartbeat() {
      /* no-op */
    },
  };
}

describe('buildQueryEnv — llmux mode (#llmux)', () => {
  let originalOauth: string | undefined;
  let originalBaseUrl: string | undefined;

  beforeEach(() => {
    originalOauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    // Pre-seed an inherited OAuth token to prove llmux mode SUPPRESSES it —
    // otherwise Claude Code would prefer the OAuth token over the API key and
    // silently bypass the proxy.
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'INHERITED-OAUTH-TOKEN';
    // The "does NOT mutate process.env" case reads ANTHROPIC_BASE_URL, which a
    // developer machine pointed at a local llmux legitimately exports. Clear it
    // for the duration so the assertion measures buildQueryEnv, not the host.
    originalBaseUrl = process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_BASE_URL;
  });

  afterEach(() => {
    if (originalOauth === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOauth;
    if (originalBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = originalBaseUrl;
  });

  it('points the SDK at the llmux proxy with a throwaway API key', () => {
    const { env } = buildQueryEnv(makeLease('llmux', 'llmux-local'));
    expect(env.ANTHROPIC_BASE_URL).toBe('http://localhost:3456');
    expect(env.ANTHROPIC_API_KEY).toBe('llmux-local');
  });

  it('deletes CLAUDE_CODE_OAUTH_TOKEN so the proxy is not bypassed', () => {
    const { env } = buildQueryEnv(makeLease('llmux', 'llmux-local'));
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it('ignores the lease accessToken (proxy owns upstream auth)', () => {
    // Even a "real-looking" OAuth token on the lease must not leak through.
    const { env } = buildQueryEnv(makeLease('llmux', 'sk-ant-oat01-SHOULD-NOT-APPEAR'));
    expect(env.ANTHROPIC_API_KEY).toBe('llmux-local');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(Object.values(env)).not.toContain('sk-ant-oat01-SHOULD-NOT-APPEAR');
  });

  it('uses the per-user llmux tenant key when one was issued', () => {
    const { env } = buildQueryEnv(makeLease('llmux', 'llmux-local'), { llmuxTenantKey: 'lmk-abc' });
    expect(env.ANTHROPIC_API_KEY).toBe('lmk-abc');
    expect(env.ANTHROPIC_BASE_URL).toBe('http://localhost:3456');
  });

  it('falls back to the shared key (legacy tenant) when issuance produced nothing', () => {
    expect(buildQueryEnv(makeLease('llmux', 'x'), { llmuxTenantKey: null }).env.ANTHROPIC_API_KEY).toBe('llmux-local');
    expect(buildQueryEnv(makeLease('llmux', 'x'), {}).env.ANTHROPIC_API_KEY).toBe('llmux-local');
  });

  it('does NOT mutate process.env', () => {
    buildQueryEnv(makeLease('llmux', 'llmux-local'));
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('INHERITED-OAUTH-TOKEN');
    expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();
  });
});
