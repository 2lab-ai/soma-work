import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlotAuthLease } from '../../credentials-manager';
import { buildQueryEnv, setQueryEnvAdditional } from '../query-env-builder';

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
  LLMUX_PLACEHOLDER_API_KEY: 'llmux-local',
}));

import { resetAuthRuntimeForTests, setLlmuxSettings } from '../auth-runtime';

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
    vi.unstubAllEnvs();
    setQueryEnvAdditional({});
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

  it('removes competing provider selectors after both environment layers', () => {
    const keys = [
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_USE_FOUNDRY',
      'CLAUDE_CODE_USE_ANTHROPIC_AWS',
      'CLAUDE_CODE_USE_MANTLE',
    ];
    for (const key of keys) vi.stubEnv(key, '1');
    setQueryEnvAdditional(Object.fromEntries(keys.map((key) => [key, 'overlay'])));
    const { env } = buildQueryEnv(makeLease('llmux', 'unused'));
    for (const key of keys) {
      expect(Object.keys(env).includes(key)).toBe(false);
      expect(env[key]).toBeUndefined();
      expect(process.env[key]).toBe('1');
    }
  });

  it('filters only auth headers, case insensitively, preserving custom routing metadata', () => {
    setQueryEnvAdditional({
      ANTHROPIC_CUSTOM_HEADERS:
        'Authorization: Bearer foreign\n X-API-Key : other-tenant\r\nX-Trace: retained\nx-llmux-claude-launch-model: sol',
    });
    const { env } = buildQueryEnv(makeLease('llmux', 'unused'));
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe('X-Trace: retained\nx-llmux-claude-launch-model: sol');
  });

  it('omits an authentication-only custom header map without mutating the parent', () => {
    vi.stubEnv('ANTHROPIC_CUSTOM_HEADERS', 'Authorization: Bearer foreign\nX-Api-Key: other-tenant');
    const { env } = buildQueryEnv(makeLease('llmux', 'unused'));
    expect(Object.keys(env).includes('ANTHROPIC_CUSTOM_HEADERS')).toBe(false);
    expect(process.env.ANTHROPIC_CUSTOM_HEADERS).toContain('foreign');
  });

  it('ignores the lease accessToken (proxy owns upstream auth)', () => {
    // Even a "real-looking" OAuth token on the lease must not leak through.
    const { env } = buildQueryEnv(makeLease('llmux', 'sk-ant-oat01-SHOULD-NOT-APPEAR'));
    expect(env.ANTHROPIC_API_KEY).toBe('llmux-local');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(Object.values(env)).not.toContain('sk-ant-oat01-SHOULD-NOT-APPEAR');
  });

  it('uses the per-user llmux tenant lease when one was issued', () => {
    const tenant = { secret: 'lmk-abc', baseUrl: 'http://localhost:3456' };
    const { env } = buildQueryEnv(makeLease('llmux', 'llmux-local'), { llmuxTenant: tenant });
    expect(env.ANTHROPIC_API_KEY).toBe('lmk-abc');
    expect(env.ANTHROPIC_BASE_URL).toBe('http://localhost:3456');
  });

  it('falls back to the shared key (legacy tenant) when issuance produced nothing', () => {
    expect(buildQueryEnv(makeLease('llmux', 'x'), { llmuxTenant: null }).env.ANTHROPIC_API_KEY).toBe('llmux-local');
    expect(buildQueryEnv(makeLease('llmux', 'x'), {}).env.ANTHROPIC_API_KEY).toBe('llmux-local');
  });

  it('does NOT mutate process.env', () => {
    buildQueryEnv(makeLease('llmux', 'llmux-local'));
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('INHERITED-OAUTH-TOKEN');
    expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  // The production composition: `ensureTenantKey` resolves against daemon A
  // while an operator flips the live setting to daemon B. The env built from
  // that lease must describe A ENTIRELY — pairing A's key with B's URL would
  // 401 on B instead of degrading to the shared key.
  describe('daemon flip between issuance and env build', () => {
    let dir: string;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'query-env-llmux-'));
      resetAuthRuntimeForTests(path.join(dir, 'auth-runtime.json'));
    });

    afterEach(() => {
      resetAuthRuntimeForTests();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('keeps the tenant lease coherent: both URL and key come from daemon A', () => {
      const tenantFromA = { secret: 'lmk-issued-by-A', baseUrl: 'http://localhost:3456' };
      setLlmuxSettings({ baseUrl: 'http://10.0.0.5:3456', apiKey: 'shared-key-B' });

      const { env } = buildQueryEnv(makeLease('llmux', 'x'), { llmuxTenant: tenantFromA });
      expect(env.ANTHROPIC_BASE_URL).toBe('http://localhost:3456');
      expect(env.ANTHROPIC_API_KEY).toBe('lmk-issued-by-A');
    });

    it('a dispatch without a lease uses the NEW daemon and its shared key', () => {
      setLlmuxSettings({ baseUrl: 'http://10.0.0.5:3456', apiKey: 'shared-key-B' });

      const { env } = buildQueryEnv(makeLease('llmux', 'x'));
      expect(env.ANTHROPIC_BASE_URL).toBe('http://10.0.0.5:3456');
      expect(env.ANTHROPIC_API_KEY).toBe('shared-key-B');
    });
  });
});
