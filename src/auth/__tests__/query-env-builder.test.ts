import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlotAuthLease } from '../../credentials-manager';
import { buildQueryEnv, getQueryEnvAdditional, RESERVED_LEASE_KEYS, setQueryEnvAdditional } from '../query-env-builder';

function makeLease(keyId: string, accessToken: string, kind: SlotAuthLease['kind'] = 'cct'): SlotAuthLease {
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

describe('buildQueryEnv', () => {
  // Snapshot + restore process.env so cross-test pollution can't mask a real
  // mutation. If buildQueryEnv ever starts mutating process.env, these hooks
  // fail fast on the next test.
  let originalOauthToken: string | undefined;
  let originalFoo: string | undefined;

  beforeEach(() => {
    originalOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    originalFoo = process.env.__QENV_BUILDER_FIXTURE__;
    process.env.__QENV_BUILDER_FIXTURE__ = 'keep-me';
    // Intentionally set a "wrong" global token to prove the builder does NOT
    // depend on or propagate it.
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'GLOBAL-WRONG-TOKEN';
    // Reset module-level additional env between tests — the setter is a
    // shared singleton and any leftover state would cross-pollinate cases.
    setQueryEnvAdditional({});
  });

  afterEach(() => {
    if (originalOauthToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOauthToken;
    if (originalFoo === undefined) delete process.env.__QENV_BUILDER_FIXTURE__;
    else process.env.__QENV_BUILDER_FIXTURE__ = originalFoo;
    setQueryEnvAdditional({});
  });

  it('sets CLAUDE_CODE_OAUTH_TOKEN to the lease accessToken (cct slot without attachment)', () => {
    const lease = makeLease('slot-a', 'sk-ant-oat01-TOKEN-A', 'cct');
    const { env } = buildQueryEnv(lease);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-TOKEN-A');
  });

  it('sets CLAUDE_CODE_OAUTH_TOKEN to lease.accessToken verbatim (format-agnostic)', () => {
    const lease = makeLease('slot-b', 'sk-ant-oat01-TOKEN-B', 'cct');
    const { env } = buildQueryEnv(lease);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-TOKEN-B');
  });

  it('ignores an llmux tenant lease in ccp mode (the lease token still wins)', () => {
    // The option is llmux-only; a caller that always passes it (claude-handler)
    // must not perturb the OAuth-lease path.
    const lease = makeLease('slot-a', 'sk-ant-oat01-TOKEN-C', 'cct');
    const tenant = { secret: 'lmk-should-be-ignored', baseUrl: 'http://localhost:3456' };
    const { env } = buildQueryEnv(lease, { llmuxTenant: tenant });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-TOKEN-C');
    expect(env.ANTHROPIC_API_KEY).not.toBe('lmk-should-be-ignored');
  });

  it('does NOT mutate process.env', () => {
    const lease = makeLease('slot-a', 'sk-ant-oat01-FRESH', 'cct');
    buildQueryEnv(lease);
    // The global token we pre-seeded must survive untouched.
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('GLOBAL-WRONG-TOKEN');
  });

  it("keeps the OS session's variables (PATH among them) and drops a variable it does not know", () => {
    const lease = makeLease('slot-a', 'sk-ant-oat01-X', 'cct');
    const { env } = buildQueryEnv(lease);
    expect(Object.keys(env)).not.toContain('__QENV_BUILDER_FIXTURE__');
    if (process.env.PATH !== undefined) {
      expect(env.PATH).toBe(process.env.PATH);
    }
  });

  // The bot's own environment holds its .env: the agent's shell, hooks and MCP servers inherit `options.env` whole,
  // so none of the bot's secrets may be in it (the sandbox audit of 27 November 2026 read 17 of them from a shell).
  describe("the bot's secrets stay in the bot", () => {
    const SECRETS: Record<string, string> = {
      SLACK_BOT_TOKEN: 'xoxb-1-2-fixture',
      SLACK_APP_TOKEN: 'xapp-1-fixture',
      SLACK_SIGNING_SECRET: 'signing-fixture',
      GITHUB_APP_ID: '123',
      GITHUB_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----\nfixture\n-----END RSA PRIVATE KEY-----',
      GITHUB_INSTALLATION_ID: '456',
      DASHBOARD_JWT_SECRET: 'jwt-fixture',
      GOOGLE_CLIENT_SECRET: 'google-fixture',
      CONVERSATION_VIEWER_TOKEN: 'viewer-fixture',
      AI_TOKEN: 'sk-ant-oat01-fixture',
      CLAUDE_CODE_OAUTH_TOKEN_LIST: 'a,b',
      ZHUGELIANG_CLAUDE_CODE_OAUTH_TOKEN_LIST: 'c,d',
      ANTHROPIC_API_KEY: 'sk-ant-api03-fixture',
      ANTHROPIC_CUSTOM_HEADERS: 'Authorization: Bearer fixture',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      GH_TOKEN: 'gho_operator-fixture',
      HTTP_PROXY: 'http://user:proxy-password-fixture@proxy.local:3128',
      JIRA_API_TOKEN: 'jira-fixture',
      AWS_SECRET_ACCESS_KEY: 'aws-fixture-without-a-selector',
    };
    const KEPT: Record<string, string> = {
      HOME: '/Users/bot',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      TZ: 'Asia/Seoul',
      SOMA_CONFIG_DIR: '/opt/soma/dev',
      CLAUDE_CONFIG_DIR: '/opt/soma/dev/.claude',
      DATA_DIR: '/opt/soma/dev/data',
      CONVERSATION_VIEWER_PORT: '33000',
      DEBUG: 'true',
      NODE_EXTRA_CA_CERTS: '/etc/ca.pem',
      HTTPS_PROXY: 'http://proxy.local:3128',
      SOMA_DATA_DIR: '/opt/soma/dev/data',
      DISABLE_AUTO_COMPACT: '0',
      SOMA_HTML_SERVE_BIND: '127.0.0.1',
      CHORE_REPOS_MD: '/opt/soma/repos.md',
      PLAYWRIGHT_FROM: '/opt/playwright',
    };
    beforeEach(() => {
      for (const [key, value] of Object.entries({ ...SECRETS, ...KEPT })) vi.stubEnv(key, value);
    });
    afterEach(() => vi.unstubAllEnvs());

    it('none of them reaches the agent, by name or by value', () => {
      const { env } = buildQueryEnv(makeLease('slot-a', 'LEASE-TOKEN', 'cct'));
      for (const [key, value] of Object.entries(SECRETS)) {
        expect(Object.keys(env), key).not.toContain(key);
        expect(Object.values(env), key).not.toContain(value);
      }
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('LEASE-TOKEN');
    });

    it('the locale, the config locations, the hook port, the TLS and proxy setup do', () => {
      const { env } = buildQueryEnv(makeLease('slot-a', 'LEASE-TOKEN', 'cct'));
      for (const [key, value] of Object.entries(KEPT)) expect(env[key], key).toBe(value);
    });

    it("a host that selected Bedrock hands the CLI that provider's settings, and only then", () => {
      vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', '1');
      vi.stubEnv('AWS_REGION', 'us-east-1');
      const { env } = buildQueryEnv(makeLease('slot-a', 'LEASE-TOKEN', 'cct'));
      expect(env.CLAUDE_CODE_USE_BEDROCK).toBe('1');
      expect(env.AWS_REGION).toBe('us-east-1');
      expect(env.AWS_SECRET_ACCESS_KEY).toBe('aws-fixture-without-a-selector');
    });

    it('Bedrock keeps every AWS credential source: web identity, the container endpoint, profile files', () => {
      vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', 'true');
      const sources = {
        AWS_ROLE_ARN: 'arn:aws:iam::1:role/r',
        AWS_WEB_IDENTITY_TOKEN_FILE: '/var/run/secrets/token',
        AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/x',
        AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: '/var/run/ecs/token',
        AWS_CONFIG_FILE: '/etc/aws/config',
        AWS_SHARED_CREDENTIALS_FILE: '/etc/aws/credentials',
      };
      for (const [key, value] of Object.entries(sources)) vi.stubEnv(key, value);
      const { env } = buildQueryEnv(makeLease('slot-a', 'LEASE-TOKEN', 'cct'));
      for (const [key, value] of Object.entries(sources)) expect(env[key], key).toBe(value);
    });

    it("a provider selected in the operator's claude.env takes the host's credentials for it", () => {
      setQueryEnvAdditional({ CLAUDE_CODE_USE_BEDROCK: '1' });
      const { env } = buildQueryEnv(makeLease('slot-a', 'LEASE-TOKEN', 'cct'));
      expect(env.CLAUDE_CODE_USE_BEDROCK).toBe('1');
      expect(env.AWS_SECRET_ACCESS_KEY).toBe('aws-fixture-without-a-selector');
    });

    it.each([
      ['0', 'CLAUDE_CODE_USE_BEDROCK'],
      ['false', 'CLAUDE_CODE_USE_BEDROCK'],
      ['', 'CLAUDE_CODE_USE_BEDROCK'],
      ['0', 'CLAUDE_CODE_USE_VERTEX'],
      ['FALSE', 'CLAUDE_CODE_USE_VERTEX'],
    ])('a selector set to %j (%s) selects nothing: no provider credential is passed', (value, selector) => {
      vi.stubEnv(selector, value);
      vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', '/etc/gcp.json');
      const { env } = buildQueryEnv(makeLease('slot-a', 'LEASE-TOKEN', 'cct'));
      expect(Object.keys(env)).not.toContain('AWS_SECRET_ACCESS_KEY');
      expect(Object.keys(env)).not.toContain('GOOGLE_APPLICATION_CREDENTIALS');
    });

    it("Vertex passes Google's credential locators by name, never the bot's own Google client secret", () => {
      vi.stubEnv('CLAUDE_CODE_USE_VERTEX', '1');
      vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', '/etc/gcp.json');
      vi.stubEnv('ANTHROPIC_VERTEX_PROJECT_ID', 'proj');
      const { env } = buildQueryEnv(makeLease('slot-a', 'LEASE-TOKEN', 'cct'));
      expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBe('/etc/gcp.json');
      expect(env.ANTHROPIC_VERTEX_PROJECT_ID).toBe('proj');
      expect(Object.keys(env)).not.toContain('GOOGLE_CLIENT_SECRET');
    });

    it("the bot's own GitHub token reaches gh only while no bot-owned gh login serves it", async () => {
      const { clearAgentGhConfigDir, writeAgentGhHosts } = await import('../../github/agent-gh-config');
      const fs = await import('node:fs');
      const os = await import('node:os');
      const path = await import('node:path');
      vi.stubEnv('GITHUB_TOKEN', 'ghs_fixturetoken');
      try {
        clearAgentGhConfigDir();
        expect(buildQueryEnv(makeLease('slot-a', 'T', 'cct')).env.GITHUB_TOKEN).toBe('ghs_fixturetoken');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qenv-gh-'));
        await writeAgentGhHosts(dir, 'ghs_fixturetoken');
        const { env } = buildQueryEnv(makeLease('slot-a', 'T', 'cct'));
        expect(env.GITHUB_TOKEN).toBeUndefined();
        expect(env.GH_CONFIG_DIR).toBe(fs.realpathSync(dir) === dir ? dir : path.resolve(dir));
      } finally {
        clearAgentGhConfigDir();
      }
    });
  });

  it('returns independent env objects for separate leases (concurrent isolation)', () => {
    const leaseA = makeLease('slot-a', 'TOKEN-A', 'cct');
    const leaseB = makeLease('slot-b', 'TOKEN-B', 'cct');
    const { env: envA } = buildQueryEnv(leaseA);
    const { env: envB } = buildQueryEnv(leaseB);

    // Distinct object identity — no shared reference.
    expect(envA).not.toBe(envB);
    // And distinct token values, even though both derived from the same
    // process.env snapshot.
    expect(envA.CLAUDE_CODE_OAUTH_TOKEN).toBe('TOKEN-A');
    expect(envB.CLAUDE_CODE_OAUTH_TOKEN).toBe('TOKEN-B');

    // Mutating one result must not leak into the other.
    envA.CLAUDE_CODE_OAUTH_TOKEN = 'MUTATED-A';
    expect(envB.CLAUDE_CODE_OAUTH_TOKEN).toBe('TOKEN-B');
  });

  it('simulated concurrent dispatch: each query() call sees its own token', async () => {
    // Two leases dispatched "in parallel" — the env captured for each spawn
    // must carry ONLY its own token, regardless of ordering.
    const leaseA = makeLease('slot-a', 'PARALLEL-A', 'cct');
    const leaseB = makeLease('slot-b', 'PARALLEL-B', 'cct');

    const [{ env: envA }, { env: envB }] = await Promise.all([
      Promise.resolve(buildQueryEnv(leaseA)),
      Promise.resolve(buildQueryEnv(leaseB)),
    ]);

    expect(envA.CLAUDE_CODE_OAUTH_TOKEN).toBe('PARALLEL-A');
    expect(envB.CLAUDE_CODE_OAUTH_TOKEN).toBe('PARALLEL-B');
    // The global must still be unchanged by the parallel builds.
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('GLOBAL-WRONG-TOKEN');
  });

  it('returns a plain object whose values are all strings', () => {
    const lease = makeLease('slot-a', 'TOKEN', 'cct');
    const { env } = buildQueryEnv(lease);
    for (const v of Object.values(env)) {
      expect(typeof v).toBe('string');
    }
  });

  // ===== claude.env / setQueryEnvAdditional =====

  it('overlays setQueryEnvAdditional values on top of process.env', () => {
    setQueryEnvAdditional({ FOO: 'bar', __QENV_BUILDER_FIXTURE__: 'overridden', LANG: 'C' });
    const lease = makeLease('slot-a', 'TOKEN-A', 'cct');
    const { env } = buildQueryEnv(lease);
    expect(env.FOO).toBe('bar');
    // Operator intent wins: a name the bot does not pass on, and one it does.
    expect(env.__QENV_BUILDER_FIXTURE__).toBe('overridden');
    expect(env.LANG).toBe('C');
    // process.env itself remains untouched.
    expect(process.env.FOO).toBeUndefined();
    expect(process.env.__QENV_BUILDER_FIXTURE__).toBe('keep-me');
  });

  it('lease token override beats additional env even if it tries to set CLAUDE_CODE_OAUTH_TOKEN (defense in depth)', () => {
    // Bypass the load-time denylist by calling the setter directly with
    // a poisoned key. The build-time override must still win.
    setQueryEnvAdditional({ CLAUDE_CODE_OAUTH_TOKEN: 'EVIL' });
    const lease = makeLease('slot-a', 'GENUINE-LEASE-TOKEN', 'cct');
    const { env } = buildQueryEnv(lease);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('GENUINE-LEASE-TOKEN');
  });

  it('setQueryEnvAdditional defensively clones — caller mutation does not leak', () => {
    const input: Record<string, string> = { FOO: 'initial' };
    setQueryEnvAdditional(input);
    // Mutate the caller's object after registration.
    input.FOO = 'mutated';
    input.NEW = 'sneak-in';
    const lease = makeLease('slot-a', 'TOKEN', 'cct');
    const { env } = buildQueryEnv(lease);
    expect(env.FOO).toBe('initial');
    expect(env.NEW).toBeUndefined();
  });

  it('getQueryEnvAdditional returns a clone, not the live state', () => {
    setQueryEnvAdditional({ FOO: 'bar' });
    const snapshot = getQueryEnvAdditional();
    snapshot.FOO = 'mutated-snapshot';
    snapshot.NEW = 'sneak-in';
    // Subsequent build still sees the original state.
    const lease = makeLease('slot-a', 'TOKEN', 'cct');
    const { env } = buildQueryEnv(lease);
    expect(env.FOO).toBe('bar');
    expect(env.NEW).toBeUndefined();
  });

  // ===== HOOKS_PROXY_ENABLED opt-in =====
  // The zworkflow plugin defaults to the self-contained shell guard so external
  // installs work without a service. soma-work owns the Fastify hook service, so
  // it opts spawned agents INTO the HTTP proxy by setting HOOKS_PROXY_ENABLED.

  it('defaults HOOKS_PROXY_ENABLED to "true" when unset (soma-work opts into the hook service)', () => {
    const original = process.env.HOOKS_PROXY_ENABLED;
    delete process.env.HOOKS_PROXY_ENABLED;
    try {
      const lease = makeLease('slot-a', 'TOKEN', 'cct');
      const { env } = buildQueryEnv(lease);
      expect(env.HOOKS_PROXY_ENABLED).toBe('true');
    } finally {
      if (original === undefined) delete process.env.HOOKS_PROXY_ENABLED;
      else process.env.HOOKS_PROXY_ENABLED = original;
    }
  });

  it('respects an explicit HOOKS_PROXY_ENABLED from the environment (override wins)', () => {
    const original = process.env.HOOKS_PROXY_ENABLED;
    process.env.HOOKS_PROXY_ENABLED = 'false';
    try {
      const lease = makeLease('slot-a', 'TOKEN', 'cct');
      const { env } = buildQueryEnv(lease);
      expect(env.HOOKS_PROXY_ENABLED).toBe('false');
    } finally {
      if (original === undefined) delete process.env.HOOKS_PROXY_ENABLED;
      else process.env.HOOKS_PROXY_ENABLED = original;
    }
  });

  it('RESERVED_LEASE_KEYS is frozen and contains the auth/proxy/provider slots', () => {
    expect(Object.isFrozen(RESERVED_LEASE_KEYS)).toBe(true);
    // Spot-check the canonical entries — full list pinned by the parser
    // tests in config-loader.test.ts.
    expect(RESERVED_LEASE_KEYS).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(RESERVED_LEASE_KEYS).toContain('ANTHROPIC_API_KEY');
    expect(RESERVED_LEASE_KEYS).toContain('CLAUDE_CONFIG_DIR');
    expect(RESERVED_LEASE_KEYS).toContain('HTTPS_PROXY');
    expect(RESERVED_LEASE_KEYS).toContain('NODE_EXTRA_CA_CERTS');
  });
});
